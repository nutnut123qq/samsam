"""MKT-00 Agent GĐ Marketing (v6.0, WP08) — điều phối + cân tải duyệt.

TẤT ĐỊNH, KHÔNG LLM. Đọc lịch ĐỀ XUẤT của MKT-01 (`pipelines.mkt_calendar`)
rồi:
  - `--briefs`: đẩy "brief chiến dịch" (`campaign_brief`, SLA/risk từ
    `data/directors/marketing.json`) vào `approval_queue` qua
    `director.submit` — idempotent (đã có pending/approved/rejected cùng
    `object_id` → bỏ qua). KHÔNG tự duyệt: GĐ Marketing duyệt bằng
    `python -m pipelines.approval_queue --approve ID --by ...`.
  - `--load`: dự báo tải duyệt/ngày (Pháp chế: 1 mục/ô tại ngày mốc
    `approve`; GĐ Marketing: 1 brief/chiến dịch tại ngày mốc `draft`) so
    với quota (`scripts/review_load.py`) → cảnh báo VƯỢT QUOTA + ĐỀ XUẤT
    dời. KHÔNG tự dời lịch.
  - `--bulletin`: bản tin tuần GĐ Marketing → `data/reports/mkt-week-<thứ
    Hai VN>.md` (BẢN NHÁP, không tự gửi). DB down → vẫn sinh, mục trễ hạn
    ghi "nguồn DB thiếu".
Không agent nào đăng bài, hẹn lịch đăng, sinh nháp hay chi tiền.

CLI: python -m agents.mkt_director --briefs [--today YYYY-MM-DD]
       [--horizon-days N] [--dry-run]
     python -m agents.mkt_director --load [--today] [--days 28] [--quota P]
     python -m agents.mkt_director --bulletin [--today] [--out-dir DIR]
Exit: 0 OK · 1 lịch/golden/cấu hình hỏng · 2 usage / quota hỏng / DB down
(--briefs).
"""

import argparse
import sys
from contextlib import suppress
from datetime import date, datetime, time, timedelta
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director
from pipelines import mkt_calendar as mc
from pipelines.period import VN_TZ, vn_date
from pipelines.pii import _mask_pii
from pipelines.scenario import week_start
from pipelines.store import _db_msg, _oneline
from scripts.review_load import DEFAULT_QUOTA, cap_for, load_quota

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

BLOCK = "marketing"
OBJECT_TYPE = "campaign_brief"
AGENT = "agent:MKT-00"
SOURCES = "data/marketing_calendar.json + data/golden_skus.json"
NO_AUTO = "Chỉ đề xuất — lịch không bị dời tự động"
FOOTER = ("Agent không duyệt, không đăng, không chi tiền — quyết định thuộc"
          " GĐ Marketing")
DB_MISSING = "nguồn DB thiếu"
_WD = ("T2", "T3", "T4", "T5", "T6", "T7", "CN")
_EXISTING_SQL = (
    "select 1 from approval_queue where object_type = %s and object_id = %s"
    " and status in ('pending', 'approved', 'rejected') limit 1")
# Chỉ cột metadata (agent_writer không được đọc payload — least privilege):
# mục pending của khối + brief chiến dịch đã quyết (để biết đã có brief).
_QUEUE_COLS = ("id", "object_type", "object_id", "title", "status", "due_at",
               "is_sample")
_QUEUE_SQL = (
    "select id, object_type, object_id, title, status, due_at, is_sample"
    " from approval_queue where block = %s and (status = 'pending' or"
    " (object_type = %s and status in ('approved', 'rejected')))"
    " order by due_at, id")


def _vn(ts: datetime) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M")


# ---------- W60.4 brief ----------

def brief_text(campaign: dict, status: str = "") -> str:
    """Brief tất định (không LLM). SKU rượu KHÔNG nêu tên ở đây (brief đi
    qua guardrail khi vào hàng — chỉ đếm); danh sách đủ nằm ở bản tin GĐ."""
    c = campaign
    m = c["milestones"]
    L = [f"Brief chiến dịch {c['id']} — sự kiện {c['event']}",
         f"Trụ nội dung: {c['pillar']}",
         f"Ngày đăng: {c['publish_day']:%d/%m/%Y}", "",
         "Mốc (giờ VN):"]
    L += [f"- {mc.MILESTONE_VN[k]}: {_vn(m[k])}" for k in mc.MILESTONES]
    L += ["", "Ô kênh × định dạng:"]
    for cell in c["cells"]:
        sku = ", ".join(cell["skus"]) if cell["skus"] else cell["note"]
        L.append(f"- {cell['channel']} / {cell['format']}: {sku}")
    if not c["cells"]:
        L.append("- (không còn ô nào đủ điều kiện)")
    shown = [b for b in c["blocked"] if b["reason"] != mc.REASON_ALCOHOL]
    n_off = len({b["sku_key"] for b in c["blocked"]
                 if b["reason"] == mc.REASON_ALCOHOL})
    L += ["", "SKU bị chặn kênh:"]
    seen = {}
    for b in shown:
        seen.setdefault((b["sku_key"], b["channel"], b["reason"]),
                        []).append(b["format"])
    L += [f"- {k} / {ch} ({', '.join(fm)}): {why}"
          for (k, ch, why), fm in seen.items()]
    if n_off:
        L.append(f"- {n_off} SKU chỉ bán offline (luật kênh) — không đưa vào"
                 " kênh online; chi tiết trong bản tin GĐ Marketing")
    if not shown and not n_off:
        L.append("- (không có)")
    L += ["", f"Nguồn: {SOURCES}"
          + (f" ({status})" if status else ""),
          "Lịch ĐỀ XUẤT — GĐ Marketing duyệt brief trước khi soạn nháp."]
    return "\n".join(L)


def enqueue_briefs(conn, plan: dict, now: datetime, horizon_days: int = 14,
                   cfg: dict | None = None) -> dict:
    """Đẩy brief chiến dịch sắp tới (publish > now, brief ≤ now+horizon)
    vào hàng duyệt — KHÔNG duyệt. → {"enqueued": [...], "skipped": [...]}."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now phải có múi giờ")
    cfg = cfg if cfg is not None else director.load_config(BLOCK)
    limit = now + timedelta(days=horizon_days)
    out = {"enqueued": [], "skipped": []}
    for c in plan["campaigns"]:
        m = c["milestones"]
        if not (m["publish"] > now and m["brief"] <= limit):
            continue
        if conn.execute(_EXISTING_SQL, (OBJECT_TYPE, c["id"])).fetchone():
            out["skipped"].append({"id": c["id"], "reason": "đã có trong hàng"})
            continue
        title = f"Brief chiến dịch {c['id']} — đăng {c['publish_day']:%d/%m/%Y}"
        try:
            qid = director.submit(conn, BLOCK, OBJECT_TYPE, c["id"], title,
                                  brief_text(c, plan.get("status", "")),
                                  created_by=AGENT, cfg=cfg)
        except psycopg.errors.UniqueViolation:
            # Đua với tiến trình khác — index pending_uq là chốt cuối.
            out["skipped"].append({"id": c["id"], "reason": "đã có (đua)"})
            continue
        out["enqueued"].append({"id": c["id"], "queue_id": qid})
    return out


# ---------- W60.5 cân tải ----------

def _count(plan: dict) -> tuple[dict, dict, dict]:
    """→ (phap_che{day: n}, gd{day: n}, who{(role, day): [(campaign, n)]})."""
    pc, gd, who = {}, {}, {}
    for c in plan["campaigns"]:
        n = len(c["cells"])
        if n:
            d = vn_date(c["milestones"]["approve"])
            pc[d] = pc.get(d, 0) + n
            who.setdefault(("phap_che", d), []).append((c["id"], n))
        d = vn_date(c["milestones"]["draft"])
        gd[d] = gd.get(d, 0) + 1
        who.setdefault(("gd_marketing", d), []).append((c["id"], 1))
    return pc, gd, who


def forecast_load(plan: dict, quota: dict, gd_cap: int, start: date,
                  days: int) -> dict:
    """THUẦN: tải duyệt dự báo/ngày vs trần → cảnh báo + ĐỀ XUẤT dời (không
    sửa `plan`, không ghi DB/file)."""
    pc, gd, who = _count(plan)
    nw = {d if isinstance(d, date) else date.fromisoformat(d)
          for d in plan.get("non_working_days", [])}

    def cap(role, d):
        return cap_for(d, quota) if role == "phap_che" else gd_cap

    load = {"phap_che": pc, "gd_marketing": gd}
    moved = {"phap_che": {}, "gd_marketing": {}}
    rows, warns, sugg = [], [], []
    for i in range(days):
        d = start + timedelta(days=i)
        rows.append({"day": d, "phap_che": pc.get(d, 0),
                     "gd_marketing": gd.get(d, 0),
                     "cap_phap_che": cap_for(d, quota), "cap_gd": gd_cap})
        for role in ("phap_che", "gd_marketing"):
            n, c_ = load[role].get(d, 0), cap(role, d)
            if n == 0:
                continue
            if c_ is None:
                warns.append(f"KHÔNG CÓ QUOTA {role} {d.isoformat()}: {n} mục"
                             " — không phase quota nào phủ ngày này")
                continue
            if n <= c_:
                continue
            warns.append(f"VƯỢT QUOTA {role} {d.isoformat()}: {n} mục > trần"
                         f" {c_}")
            excess = n - c_
            for cid, k in sorted(who[(role, d)], key=lambda x: (-x[1], x[0])):
                if excess <= 0:
                    break
                target = None
                for back in range(1, 8):
                    t = d - timedelta(days=back)
                    if t < start or t.weekday() >= 5 or t in nw:
                        continue
                    tc = cap(role, t)
                    used = load[role].get(t, 0) + moved[role].get(t, 0)
                    if tc is not None and used + k <= tc:
                        target = t
                        break
                label = "mốc duyệt" if role == "phap_che" else \
                    "mốc duyệt brief"
                if target is None:
                    sugg.append(f"ĐỀ XUẤT giảm số ô của {cid} ({role}"
                                f" {d.isoformat()}) — không còn ngày trống"
                                " trong 7 ngày trước — GĐ Marketing quyết")
                else:
                    moved[role][target] = moved[role].get(target, 0) + k
                    sugg.append(f"ĐỀ XUẤT dời {label} {cid} sang"
                                f" {target.isoformat()} ({role}) — GĐ"
                                " Marketing quyết")
                excess -= k
    return {"days": rows, "warnings": warns, "suggestions": sugg}


def render_load(fc: dict) -> str:
    L = ["| ngày | Pháp chế | trần | GĐ Marketing | trần |",
         "|---|---|---|---|---|"]
    for r in fc["days"]:
        cp = "—" if r["cap_phap_che"] is None else r["cap_phap_che"]
        L.append(f"| {_WD[r['day'].weekday()]} {r['day']:%d/%m} |"
                 f" {r['phap_che']} | {cp} |"
                 f" {r['gd_marketing']} | {r['cap_gd']} |")
    L += ["", "Cảnh báo:"]
    L += [f"- {w}" for w in fc["warnings"]] or ["- (không có)"]
    L += ["", "Đề xuất:"]
    L += [f"- {s}" for s in fc["suggestions"]] or ["- (không có)"]
    L += ["", f"*{NO_AUTO}.*"]
    return "\n".join(L)


# ---------- W60.6 bản tin ----------

def bulletin(plan: dict, load: dict, queue_items: list[dict] | None,
             now: datetime) -> str:
    """THUẦN. `queue_items` = mục hàng duyệt khối marketing (pending + brief
    đã quyết); None = DB không đọc được."""
    today = vn_date(now)
    wk = week_start(today)
    horizon = today + timedelta(days=28)
    L = [f"# Bản tin tuần GĐ Marketing — tuần {wk:%d/%m/%Y}", "",
         f"Agent: MKT-00 · giờ VN · lịch: {plan['status']} (ĐỀ XUẤT)", "",
         "## 1. Chiến dịch 28 ngày tới", ""]
    upcoming = [c for c in plan["campaigns"]
                if today <= c["publish_day"] < horizon]
    if upcoming:
        L += ["| chiến dịch | sự kiện | ô | brief | nháp | duyệt | đăng |",
              "|---|---|---|---|---|---|---|"]
        for c in upcoming:
            m = c["milestones"]
            cells = ", ".join(f"{x['channel']}/{x['format']}"
                              for x in c["cells"]) or "—"
            L.append(f"| {c['id']} | {c['event']} | {cells} | "
                     + " | ".join(mc._fmt(m[k]) for k in mc.MILESTONES)
                     + " |")
    else:
        L.append("- (không có)")
    rem = [r for r in plan["reminders"]
           if wk <= r["day"] < wk + timedelta(days=7)]
    L += ["", "Nhắc mốc trong tuần:"]
    L += [f"- còn {r['days_before']} ngày tới `{r['event']}`"
          f" ({r['day']:%d/%m})" for r in rem] or ["- (không có)"]

    L += ["", "## 2. Việc trễ hạn", ""]
    if queue_items is None:
        L.append(f"- {DB_MISSING} — không đọc được hàng duyệt (chạy lại khi"
                 " DB lên)")
    else:
        late = [d for d in queue_items if d.get("status") == "pending"
                and d.get("due_at") and d["due_at"] < now]
        L += [f"- #{d['id']} `{d['object_type']}`"
              f" {_oneline(_mask_pii(d.get('title') or ''), 80)} — hạn"
              f" {_vn(d['due_at'])}" for d in late]
        has = {d.get("object_id") for d in queue_items
               if d.get("object_type") == OBJECT_TYPE}
        miss = [c for c in plan["campaigns"]
                if c["milestones"]["brief"] < now < c["milestones"]["publish"]
                and c["id"] not in has]
        L += [f"- chiến dịch {c['id']}: đã qua mốc brief"
              f" {mc._fmt(c['milestones']['brief'])} mà chưa có brief trong"
              " hàng duyệt" for c in miss]
        if not late and not miss:
            L.append("- (không có)")

    L += ["", "## 3. Tải duyệt dự báo vs quota (14 ngày)", "",
          render_load(load)]

    L += ["", "## 4. SKU bị chặn kênh", ""]
    agg: dict[tuple, set] = {}
    for c in plan["campaigns"]:
        for b in c["blocked"]:
            agg.setdefault((b["sku_key"], b["channel"], b["readiness"],
                            b["reason"]), set()).add(b["format"])
    if agg:
        L += ["| SKU | kênh | readiness | lý do | định dạng |",
              "|---|---|---|---|---|"]
        L += [f"| {k} | {ch} | {r} | {why} | {', '.join(sorted(fm))} |"
              for (k, ch, r, why), fm in sorted(agg.items())]
    else:
        L.append("- (không có)")
    L += ["", "---", f"*{FOOTER}. BẢN NHÁP — hệ thống không tự gửi.*", ""]
    return "\n".join(L)


def _queue_items(conn) -> list[dict]:
    items = [dict(zip(_QUEUE_COLS, r)) for r in conn.execute(
        _QUEUE_SQL, (BLOCK, OBJECT_TYPE)).fetchall()]
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    return items


# ---------- CLI ----------

def _int_range(lo: int, hi: int):
    def f(s: str) -> int:
        try:
            n = int(s)
        except ValueError:
            raise argparse.ArgumentTypeError(f"phải là số: {s!r}") from None
        if not lo <= n <= hi:
            raise argparse.ArgumentTypeError(f"phải trong {lo}..{hi}")
        return n
    return f


def _plan(start: date, weeks: int):
    cal, golden, sla = mc.load_inputs()
    return cal, mc.build(cal, golden, start, weeks, sla)


def _err(msg: str, code: int) -> int:
    print(f"[err] {msg}", file=sys.stderr)
    return code


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.mkt_director",
        description="MKT-00 GĐ Marketing — brief vào hàng duyệt, cân tải,"
                    " bản tin tuần (không duyệt, không đăng, không chi tiền)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--briefs", action="store_true")
    g.add_argument("--load", action="store_true")
    g.add_argument("--bulletin", action="store_true")
    ap.add_argument("--today", type=mc._date_arg)
    ap.add_argument("--horizon-days", type=_int_range(1, 60), default=14)
    ap.add_argument("--days", type=_int_range(1, 90), default=28)
    ap.add_argument("--quota", type=Path, default=DEFAULT_QUOTA)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    now = (datetime.combine(args.today, time(0), VN_TZ) if args.today
           else datetime.now(VN_TZ))
    today = vn_date(now)

    quota = None
    if args.load or args.bulletin:
        try:
            quota = load_quota(args.quota)   # quota hỏng → 2 trước khi đọc lịch
        except ValueError as e:
            return _err(f"quota: {e}", 2)

    if args.briefs:
        weeks = min(mc.MAX_WEEKS, (args.horizon_days + 60) // 7 + 1)
    elif args.load:
        weeks = min(mc.MAX_WEEKS, (args.days + 14) // 7 + 1)
    else:
        weeks = 6
    try:
        cal, plan = _plan(week_start(today) if args.bulletin else today,
                          weeks)
    except mc.CalendarError as e:
        return _err(str(e), 1)
    gd_cap = cal["review_caps"]["gd_marketing_daily"]

    if args.load:
        fc = forecast_load(plan, quota, gd_cap, today, args.days)
        print(f"# Tải duyệt dự báo {today:%d/%m/%Y} + {args.days} ngày"
              f" (lịch: {plan['status']}; quota: {quota['status']})\n")
        print(render_load(fc))
        return 0

    if args.briefs:
        if args.dry_run:
            limit = now + timedelta(days=args.horizon_days)
            sel = [c for c in plan["campaigns"]
                   if c["milestones"]["publish"] > now
                   and c["milestones"]["brief"] <= limit]
            for c in sel:
                print(f"--- [dry-run] sẽ đẩy {OBJECT_TYPE} {c['id']} ---")
                print(brief_text(c, plan["status"]))
            print(f"[dry-run] {len(sel)} brief — không connect DB")
            return 0
        conn = connect()
        if conn is None:
            return _err("DB không kết nối được", 2)
        try:
            res = enqueue_briefs(conn, plan, now, args.horizon_days)
        except psycopg.Error as e:
            return _err(f"DB lỗi: {_db_msg(e)}", 2)
        finally:
            with suppress(Exception):
                conn.close()
        for x in res["enqueued"]:
            print(f"[ok] {x['id']} → hàng duyệt #{x['queue_id']} (pending —"
                  " GĐ Marketing duyệt)")
        for x in res["skipped"]:
            print(f"[skip] {x['id']}: {x['reason']}")
        print(f"{len(res['enqueued'])} đẩy mới, {len(res['skipped'])} bỏ qua")
        return 0

    # --bulletin
    fc = forecast_load(plan, quota, gd_cap, today, 14)
    items = None
    conn = connect()
    if conn is not None:
        try:
            items = _queue_items(conn)
        except psycopg.Error as e:
            print(f"[warn] DB lỗi: {_db_msg(e)} — {DB_MISSING}",
                  file=sys.stderr)
            items = None
        finally:
            with suppress(Exception):
                conn.close()
    text = bulletin(plan, fc, items, now)
    # P8.4: hàng duyệt khối marketing + lịch — mục MẪU trong hàng → True.
    path = write_report(text, args.out_dir,
                        f"mkt-week-{week_start(today).isoformat()}.md",
                        sample=any(bool(i.get("is_sample"))
                                   for i in items or ()))
    print(f"[ok] bản tin: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
