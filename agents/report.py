"""WS3 — agent báo cáo định kỳ ra FILE markdown (KHÔNG tự gửi).

Contract:
  - Chỉ cần `DATABASE_URL` trong .env (không gọi OpenRouter, không
    LLM) — report render deterministic từ số liệu DB + convlog, nên
    output KHÔNG cần qua `guardrail.check()` (invariant chỉ áp cho
    text AI sinh; LLM commentary = someday).
  - Nguồn số liệu: DB lõi v1.8 (`orders`, `leads`, `plot_logs`,
    `plots`, `products`) + convlog `data/conversations.jsonl`(+`.1`)
    — file-based nên phần kênh chat luôn có kể cả khi DB chết.
  - v6.5 MKT-09 — mục 5 "Marketing" (thay placeholder "Social metrics"):
    `pipelines.mkt_metrics.collect` (SAU `collect_db`, cùng conn) — tỷ lệ
    nháp bị trả lại theo kênh × loại (`content_drafts`, quyết định trong
    kỳ), thời gian duyệt trung vị/p90/max (nháp + hàng chờ
    `approval_queue` khối marketing), nháp theo agent, vi phạm guardrail
    theo CODE (không trích text), hiệu quả kênh tuần ISO đã đóng từ
    `channel_snapshots` (manual_export; nguồn `sample:` → `(MẪU)`). Mọi
    số do code tính — 0 LLM. Lỗi DB mục 5 → chỉ mục 5 "[chưa nạp]".
  - Output: `data/reports/report-<since>_<end>.md` — atomic tmp +
    `os.replace`, ghi BYTES utf-8 (tránh `\\n`→`\\r\\n` Windows);
    gitignored (runtime artifact). Chạy lại cùng kỳ → cùng tên file,
    ghi đè idempotent.
  - Human-gate C2.4: báo cáo là BẢN NHÁP cho người duyệt rồi gửi lãnh
    đạo — hệ thống KHÔNG gửi Zalo/email. Footer report ghi rõ.
  - DB down / thiếu bảng (`psycopg.Error`) → báo cáo DEGRADED: phần
    DB in "[chưa nạp — <err>]", phần convlog vẫn đầy đủ, vẫn ghi file
    + exit 0 (precedent `scripts/data_audit.py` "chưa nạp, exit 0" —
    agent định kỳ không được chết câm vì thiếu nguồn).
  - Bảng toàn `source like 'sample:%'` → section gắn nhãn *(mẫu)*
    ngay trong báo cáo — DỮ LIỆU MẪU chờ bàn giao (SOW §5.2), demo
    không được để người xem tưởng số vận hành thật.
  - Tái dùng `ingest.lead_store`: `connect` (connect_timeout=3),
    `iter_convlog` (BYTES + split `\\n`, corrupt/`_doc`/io-error
    skip+đếm), `channel_of`, `_parse_ts`. `answered` đếm STRICT
    `is True` — khác `convlog_stats` truthiness (NIT cold-check
    v1.9; fix-forward ở code mới, không vá lead_store ở version này).
  - Lập lịch: Task Scheduler / cron chạy `python -m agents.report`
    hàng tuần — idempotent theo kỳ nên chạy dư không hại.

Chạy: `python -m agents.report [--days 7] [--until YYYY-MM-DD]
[--out-dir data/reports]` → in path + topline.
"""

import argparse
import os
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest.lead_store import (
    CONSENT_REPLY_ROUTES,
    CONV_FILES,
    _parse_ts,
    channel_of,
    connect,
    iter_convlog,
)
from pipelines import mkt_metrics
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, rolling_bounds

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REPORTS_DIR = DATA_DIR / "reports"
DEFAULT_DAYS = 7
RECENT_LEADS = 5

# Keyword nhật ký vườn đáng chú ý → đưa vào mục "Cần chú ý" của báo
# cáo (heuristic rẻ ở pilot; anomaly sâu hơn thuộc agent nhật ký).
FLAG_KEYS = ("sâu bệnh", "rệp", "bệnh", "chết", "héo", "vàng lá",
             "nấm", "dịch")


def period_bounds(days: int, until: date | datetime | None = None):
    """→ (since, until_excl) aware giờ VN (v4.0 — trước đó cắt 00:00 UTC,
    lệch 7 giờ). Ủy quyền `pipelines.period.rolling_bounds`: None → now;
    date → hết ngày đó giờ VN (00:00 VN hôm sau, exclusive); datetime
    aware dùng trực tiếp; naive → ValueError. since = until-days."""
    return rolling_bounds(days, until)


def _vn_day_s(dt: datetime) -> str:
    """Ngày VN của mốc aware (tên file/dòng in kỳ)."""
    return dt.astimezone(VN_TZ).strftime("%Y-%m-%d")


def _sample(sources: dict) -> bool:
    """True khi bảng có rows và MỌI nguồn đều 'sample:*' — section
    gắn nhãn *(mẫu)* để không ai tưởng số vận hành thật."""
    return bool(sources) and all(
        str(s).startswith("sample:") for s in sources)


_NOT_CANCELLED = " and status is distinct from 'cancelled'"


def collect_db(conn, since: datetime, until: datetime) -> dict:
    """Query toàn bộ số liệu DB cho báo cáo (1 lượt). `psycopg.Error`
    (kết nối chết giữa chừng, thiếu bảng) → {"db_ok": False} — caller
    render "[chưa nạp]" thay vì crash agent định kỳ."""
    p = (since, until)
    prev = (since - (until - since), since)  # kỳ trước cùng độ dài
    try:
        # v10.1: đơn `cancelled` (kd_orders ghi từ file sàn, total_vnd vẫn
        # = Σ giá×SL) KHÔNG tính vào Đơn hàng/Doanh thu/kênh/top — chỉ hiện
        # ở dòng Trạng thái.
        cur_cnt, cur_rev = conn.execute(
            "select count(*), coalesce(sum(total_vnd),0) from orders "
            "where ts >= %s and ts < %s" + _NOT_CANCELLED, p).fetchone()
        prev_cnt, prev_rev = conn.execute(
            "select count(*), coalesce(sum(total_vnd),0) from orders "
            "where ts >= %s and ts < %s" + _NOT_CANCELLED, prev).fetchone()
        order_channel = conn.execute(
            "select channel, count(*), coalesce(sum(total_vnd),0) "
            "from orders where ts >= %s and ts < %s" + _NOT_CANCELLED
            + " group by channel order by 2 desc", p).fetchall()
        order_status = dict(conn.execute(
            "select status, count(*) from orders "
            "where ts >= %s and ts < %s group by status",
            p).fetchall())
        top_products = conn.execute(
            "select coalesce(p.name, 'Ngoài catalog'), "
            "coalesce(sum(o.qty),0), coalesce(sum(o.total_vnd),0) "
            "from orders o left join products p "
            "on p.id = o.product_id "
            "where o.ts >= %s and o.ts < %s"
            " and o.status is distinct from 'cancelled' "
            "group by 1 order by 3 desc limit 5", p).fetchall()
        order_sources = dict(conn.execute(
            "select source, count(*) from orders "
            "group by source").fetchall())

        lead_new = conn.execute(
            "select count(*) from leads where ts >= %s and ts < %s",
            p).fetchone()[0]
        lead_prev = conn.execute(
            "select count(*) from leads where ts >= %s and ts < %s",
            prev).fetchone()[0]
        lead_total = conn.execute(
            "select count(*) from leads").fetchone()[0]
        lead_pending = conn.execute(
            "select count(*) from leads where status = 'new'"
        ).fetchone()[0]
        lead_intent = dict(conn.execute(
            "select intent, count(*) from leads "
            "where ts >= %s and ts < %s group by intent",
            p).fetchall())
        lead_channel = dict(conn.execute(
            "select channel, count(*) from leads "
            "where ts >= %s and ts < %s group by channel",
            p).fetchall())
        lead_recent = conn.execute(
            "select ts, channel, intent, question from leads "
            "where ts >= %s and ts < %s "
            "order by ts desc limit %s",
            (since, until, RECENT_LEADS)).fetchall()
        lead_sources = dict(conn.execute(
            "select source, count(*) from leads "
            "group by source").fetchall())

        log_cnt = conn.execute(
            "select count(*) from plot_logs "
            "where ts >= %s and ts < %s", p).fetchone()[0]
        by_plot = dict(conn.execute(
            "select plot_id, count(*) from plot_logs "
            "where ts >= %s and ts < %s "
            "group by plot_id order by 2 desc", p).fetchall())
        by_activity = dict(conn.execute(
            "select activity, count(*) from plot_logs "
            "where ts >= %s and ts < %s "
            "group by activity order by 2 desc", p).fetchall())
        log_rows = conn.execute(
            "select ts, plot_id, activity, detail from plot_logs "
            "where ts >= %s and ts < %s order by ts", p).fetchall()
        plot_cnt, tree_cnt = conn.execute(
            "select count(*), coalesce(sum(tree_count),0) from plots "
            "where status = 'active'").fetchone()
        log_sources = dict(conn.execute(
            "select source, count(*) from plot_logs "
            "group by source").fetchall())
        plot_sources = dict(conn.execute(
            "select source, count(*) from plots "
            "group by source").fetchall())
    except psycopg.Error as e:
        return {"db_ok": False, "db_error": str(e).strip()[:300]}

    # Flag chỉ quét detail — activity vocab 'kiểm tra sâu bệnh' tự
    # chứa 'sâu bệnh' nên routine pest-check flag mọi nhật ký
    # (audit-bù v2.1 MAJOR; parity agents.garden.flags_for).
    flags = [(ts, plot, act, detail) for ts, plot, act, detail
             in log_rows
             if any(k in str(detail or "").lower()
                    for k in FLAG_KEYS)]
    return {
        "db_ok": True,
        "sales": {"count": cur_cnt, "revenue": cur_rev,
                  "prev_count": prev_cnt, "prev_revenue": prev_rev,
                  "by_channel": order_channel,
                  "by_status": order_status, "top": top_products,
                  "sources": order_sources,
                  "sample": _sample(order_sources)},
        "leads": {"new": lead_new, "prev_new": lead_prev,
                  "total": lead_total, "pending": lead_pending,
                  "by_intent": lead_intent,
                  "by_channel": lead_channel,
                  "recent": lead_recent, "sources": lead_sources,
                  "sample": _sample(lead_sources)},
        "farm": {"count": log_cnt, "by_plot": by_plot,
                 "by_activity": by_activity, "flags": flags,
                 "plots": plot_cnt, "trees": tree_cnt,
                 "log_sources": log_sources,
                 "plot_sources": plot_sources,
                 "sample": _sample({**log_sources, **plot_sources})},
    }


def collect_chat(data_dir: Path, since: datetime, until: datetime
                 ) -> dict:
    """Số liệu convlog theo kỳ + toàn thời gian — file-based, luôn
    đọc được kể cả khi DB chết (dùng lại `iter_convlog` của
    lead_store: BYTES + split `\\n`, corrupt/`_doc`/io-error đếm
    riêng). `answered` strict `is True`; ts hỏng/không phải str →
    `bad_ts` (không rơi vào kỳ). Record trả lời đồng ý
    (`CONSENT_REPLY_ROUTES`) bị bỏ qua — không phình chatbot.questions/
    unanswered trong snapshot insert-only của cockpit."""
    stats = {"total": 0, "answered": 0, "in_period": 0,
             "answered_period": 0,
             "by_channel": {"zalo": 0, "messenger": 0, "streamlit": 0},
             "by_channel_period": {"zalo": 0, "messenger": 0,
                                   "streamlit": 0},
             "bad_ts": 0, "skipped": 0}
    tmp = {"corrupt": 0, "doc": 0, "io_error": 0}
    for name in CONV_FILES:
        path = data_dir / name
        if not path.exists():
            continue
        for rec in iter_convlog(path, tmp):
            if rec.get("route") in CONSENT_REPLY_ROUTES:
                continue  # "Đồng ý"/"Không đồng ý" không phải câu hỏi
            stats["total"] += 1
            ch = channel_of(rec)
            stats["by_channel"][ch] += 1
            if rec.get("answered") is True:
                stats["answered"] += 1
            raw_ts = rec.get("ts")
            ts = (_parse_ts(raw_ts)
                  if isinstance(raw_ts, str) else None)
            if ts is None:
                stats["bad_ts"] += 1
                continue
            if since <= ts < until:
                stats["in_period"] += 1
                stats["by_channel_period"][ch] += 1
                if rec.get("answered") is True:
                    stats["answered_period"] += 1
    stats["skipped"] = (tmp["corrupt"] + tmp["doc"]
                        + tmp["io_error"])
    return stats


def _fmt_vnd(v) -> str:
    """8820000 → '8.820.000 ₫' (kiểu VN); None → '—'."""
    if v is None:
        return "—"
    return f"{int(v):,}".replace(",", ".") + " ₫"


def _db_err(db: dict) -> str:
    err = db.get("db_error") or "không rõ lỗi"
    if "does not exist" in err or "UndefinedTable" in err:
        return err + " — thiếu bảng, chạy `apply_schema` + loader"
    return err


def _mark(flag: bool) -> str:
    return " *(mẫu)*" if flag else ""


def _src_line(table: str, sources: dict) -> str:
    if not sources:
        return f"- `{table}`: 0 row"
    body = ", ".join(f"{k}={v}" for k, v in sorted(sources.items()))
    return (f"- `{table}`: {sum(sources.values())} row — {body}"
            + _mark(_sample(sources)))


def collect_marketing(conn, since: datetime, until: datetime) -> dict:
    """Số mục 5 (`mkt_metrics.collect`). conn None / `psycopg.Error` →
    {"ok": False, "error"} — chỉ mục 5 degraded, mục khác giữ số."""
    if conn is None:
        return {"ok": False, "error": "không kết nối được Postgres"}
    try:
        return mkt_metrics.collect(conn, since, until)
    except psycopg.Error as e:
        return {"ok": False, "error": str(e).strip()[:300]}


_NO_DATA = "[chưa có dữ liệu]"


def _pct(v) -> str:
    return "—" if v is None else f"{v}%"


def _rate_rows(by: dict, total: dict, head: str) -> list[str]:
    """Bảng trả lại/đã quyết + % + còn chờ cuối kỳ (mẫu số 0 → "—")."""
    L = [f"| {head} | Trả lại / Đã quyết | Tỷ lệ trả lại | Còn chờ cuối kỳ |",
         "|---|---|---|---|"]
    for key in sorted(by, key=str):
        b = by[key]
        name = " · ".join(key) if isinstance(key, tuple) else key
        L.append(f"| {name} | {b['rejected']}/{b['decided']} | "
                 f"{_pct(b['rate'])} | {b['pending_end']} |")
    L.append(f"| **Tổng** | {total['rejected']}/{total['decided']} | "
             f"{_pct(total['rate'])} | {total['pending_end']} |")
    return L


def _hours_line(label: str, h: dict) -> str:
    if not h["n"]:
        line = f"- {label}: {_NO_DATA}"
    else:
        line = (f"- {label}: trung vị {h['median_h']} giờ · p90 "
                f"{h['p90_h']} giờ · lâu nhất {h['max_h']} giờ "
                f"(n={h['n']})")
    if h.get("bad_ts"):
        line += f" — loại {h['bad_ts']} mục mốc thời gian hỏng"
    return line


def _counts(d: dict) -> str:
    items = sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))
    return " · ".join(f"`{str(k).replace('`', chr(39))}` {v}"
                      for k, v in items)


def _cell_num(v) -> str:
    return _NO_DATA if v is None else str(v)


def render_marketing(m) -> list[str]:
    """Mục 5 — mọi số lấy từ dict `m` (code tính, không LLM)."""
    L = ["## 5. Marketing", ""]
    if not isinstance(m, dict) or not m.get("ok"):
        err = m.get("error") if isinstance(m, dict) else None
        return L + [f"*[chưa nạp — {err or 'chưa thu số marketing'}]*", ""]
    L += [("**Tỷ lệ nháp bị trả lại** (nháp nội dung có quyết định trong "
           "kỳ; nháp còn chờ không vào mẫu số):"), ""]
    L += _rate_rows(m["drafts"], m["drafts_total"], "Kênh · Loại") + [""]
    L += ["**Hàng chờ khối marketing** (theo loại việc):", ""]
    L += _rate_rows(m["queue"], m["queue_total"], "Loại việc") + [""]
    L += [("- Hết hạn không ai duyệt (không tính trả lại): "
           f"{m['queue_expired']}"), ""]
    L += ["**Thời gian duyệt** (giờ, tạo → quyết định):",
          _hours_line("Nháp nội dung", m["drafts_hours"]),
          _hours_line("Hàng chờ khối marketing", m["queue_hours"]), ""]
    L.append("- Nháp tạo trong kỳ theo agent/người: "
             + (_counts(m["by_agent"]) or "không có"))
    L.append("- Vi phạm guardrail theo code (nháp tạo trong kỳ): "
             + (_counts(m["guardrail_codes"]) or "không có"))
    ch = m["channels"]
    L += ["", (f"**Hiệu quả kênh — tuần {ch['week']}** (số xuất tay "
               "`manual_export`):"), ""]
    if not ch["rows"]:
        L.append(f"- {_NO_DATA} — chưa nạp số kênh tuần này "
                 "(`python -m pipelines.cockpit --import FILE --by ...`)")
    else:
        L += [("| Kênh | Tiếp cận | Tương tác | Đơn hoàn thành | "
               "Tỷ lệ tương tác |"), "|---|---|---|---|---|"]
        for r in ch["rows"]:
            name = r["channel"] + (" (MẪU)" if r["sample"] else "")
            er = _NO_DATA if r["eng_rate"] is None else f"{r['eng_rate']}%"
            L.append(f"| {name} | {_cell_num(r['reach'])} | "
                     f"{_cell_num(r['engagement'])} | "
                     f"{_cell_num(r['orders'])} | {er} |")
    L += [("- Search Console/GA4, số kênh thật — chờ bàn giao "
           "(external-dep)."), ""]
    return L


def render(rep: dict) -> str:
    """rep → markdown tiếng Việt. Degraded (db_ok=False) → phần DB
    in '[chưa nạp — <err>]', phần convlog vẫn đầy đủ."""
    p = rep["period"]
    since_s = _vn_day_s(p["since"])
    end_s = _vn_day_s(p["until"] - timedelta(seconds=1))
    gen_s = rep["generated_at"].strftime("%Y-%m-%dT%H:%M:%SZ")
    db = rep["db"]
    chat = rep["chat"]
    L = ["# Báo cáo định kỳ — Sâm Sâm AI", "",
         (f"**Kỳ:** {since_s} → {end_s} ({p['days']} ngày, giờ VN) · "
          f"**Sinh lúc:** {gen_s} · **Nguồn:** `agents/report.py`"),
         "",
         ("> **BẢN NHÁP — người duyệt trước khi gửi lãnh đạo.** "
          "Hệ thống KHÔNG tự gửi Zalo/email (human-gate C2.4). Mục "
          "*(mẫu)* = dữ liệu mẫu chờ công ty bàn giao (SOW §5.2), "
          "không phải số vận hành thật."), ""]

    # --- 1. Bán hàng
    sales = db.get("sales") if db.get("db_ok") else None
    L.append("## 1. Bán hàng" + _mark(bool(sales and sales["sample"])))
    L.append("")
    if sales is None:
        L += [f"*[chưa nạp — {_db_err(db)}]*", ""]
    else:
        L += ["| Chỉ số | Kỳ này | Kỳ trước |", "|---|---|---|",
              (f"| Đơn hàng | {sales['count']} | "
               f"{sales['prev_count']} |"),
              (f"| Doanh thu | {_fmt_vnd(sales['revenue'])} | "
               f"{_fmt_vnd(sales['prev_revenue'])} |"), ""]
        if sales["by_channel"]:
            L.append("- Theo kênh: " + " · ".join(
                f"{ch} {n} đơn / {_fmt_vnd(rev)}"
                for ch, n, rev in sales["by_channel"]))
        if sales["by_status"]:
            L.append("- Trạng thái: " + ", ".join(
                f"{k}={v}" for k, v in
                sorted(sales["by_status"].items())))
        if sales["top"]:
            L.append("- Top doanh thu: " + "; ".join(
                f"{name} ({qty} sp / {_fmt_vnd(rev)})"
                for name, qty, rev in sales["top"]))
        if sales["by_status"].get("cancelled"):
            L.append("- Đơn `cancelled` không tính vào Đơn hàng/Doanh thu.")
        if any(str(s).startswith("market:") for s in sales["sources"]):
            L.append("- Đơn sàn (nạp từ file Seller Center): ngày đơn = "
                     "ngày nạp file (giả định — file sàn chưa map ngày đặt).")
        if sales["count"] == 0:
            L.append("- Không có đơn nào trong kỳ.")
        L.append("")

    # --- 2. Leads
    leads = db.get("leads") if db.get("db_ok") else None
    L.append("## 2. Leads (kênh chat)"
             + _mark(bool(leads and leads["sample"])))
    L.append("")
    if leads is None:
        L += [f"*[chưa nạp — {_db_err(db)}]*", ""]
    else:
        L += [(f"- Mới trong kỳ: **{leads['new']}** "
               f"(kỳ trước: {leads['prev_new']}) · Tổng: "
               f"{leads['total']} · **Chờ xử lý (new): "
               f"{leads['pending']}**")]
        if leads["by_intent"]:
            L.append("- Intent: " + ", ".join(
                f"{k}={v}" for k, v in
                sorted(leads["by_intent"].items())))
        if leads["by_channel"]:
            L.append("- Kênh: " + ", ".join(
                f"{k}={v}" for k, v in
                sorted(leads["by_channel"].items())))
        if leads["recent"]:
            L.append("- Câu hỏi mới nhất trong kỳ:")
            for ts, ch, intent, q in leads["recent"]:
                day = (ts.strftime("%Y-%m-%d")
                       if hasattr(ts, "strftime") else str(ts)[:10])
                L.append(f"  - `{day}` [{ch}/{intent}] "
                         f"{(q or '')[:120]}")
        L.append("")

    # --- 3. Kênh chat (convlog — luôn có)
    rate_p = (f"{round(100 * chat['answered_period']
                       / chat['in_period'])}%"
              if chat["in_period"] else "—")
    rate_t = (f"{round(100 * chat['answered'] / chat['total'])}%"
              if chat["total"] else "—")
    L += ["## 3. Kênh chat (convlog)", "",
          (f"- Tin nhắn trong kỳ: **{chat['in_period']}** — tỉ lệ "
           f"trả lời được: {rate_p} "
           f"({chat['answered_period']}/{chat['in_period']})"),
          (f"- Toàn thời gian: {chat['total']} tin, trả lời {rate_t} "
           f"— Zalo/Messenger/Streamlit trong kỳ: "
           f"{chat['by_channel_period']['zalo']}/"
           f"{chat['by_channel_period']['messenger']}/"
           f"{chat['by_channel_period']['streamlit']}")]
    if chat["skipped"] or chat["bad_ts"]:
        L.append(f"- Bỏ qua {chat['skipped']} dòng "
                 f"corrupt/_doc/io-error; {chat['bad_ts']} dòng ts "
                 f"hỏng (không tính vào kỳ)")
    L.append("")

    # --- 4. Vùng trồng
    farm = db.get("farm") if db.get("db_ok") else None
    L.append("## 4. Vùng trồng" + _mark(bool(farm and farm["sample"])))
    L.append("")
    if farm is None:
        L += [f"*[chưa nạp — {_db_err(db)}]*", ""]
    else:
        trees = f"{int(farm['trees']):,}".replace(",", ".")
        L += [(f"- Đang quản: {farm['plots']} khoảnh "
               f"(≈{trees} cây)"),
              f"- Nhật ký trong kỳ: **{farm['count']}** hoạt động"]
        if farm["by_plot"]:
            L.append("  - Theo khoảnh: " + ", ".join(
                f"{k}={v}" for k, v in farm["by_plot"].items()))
        if farm["by_activity"]:
            L.append("  - Theo hoạt động: " + ", ".join(
                f"{k}={v}" for k, v in farm["by_activity"].items()))
        for ts, plot, act, detail in farm["flags"]:
            day = (ts.strftime("%Y-%m-%d")
                   if hasattr(ts, "strftime") else str(ts)[:10])
            L.append(f"- ⚠️ Cần chú ý: `{day}` {plot} — {act}"
                     + (f": {detail[:120]}" if detail else ""))
        if farm["count"] == 0:
            L.append("- Không có nhật ký nào trong kỳ.")
        L.append("")

    # --- 5. Marketing (v6.5 MKT-09 — số do code tính)
    L += render_marketing(rep.get("marketing"))

    # --- 6. Nguồn dữ liệu & chất lượng
    L += ["## 6. Nguồn dữ liệu", ""]
    if db.get("db_ok"):
        L.append(_src_line("orders", db["sales"]["sources"]))
        L.append(_src_line("leads", db["leads"]["sources"]))
        L.append(_src_line("plot_logs", db["farm"]["log_sources"]))
        L.append(_src_line("plots", db["farm"]["plot_sources"]))
    else:
        L.append(f"- **DB:** không khả dụng — {_db_err(db)}")
    L.append(f"- `conversations.jsonl`: {chat['total']} record "
             f"(+{chat['skipped']} bỏ qua)")
    L.append("- Mục Marketing: `content_drafts` (quyết định theo "
             "`reviewed_at`), `approval_queue` khối marketing (theo "
             "`decided_at`), `channel_snapshots` (manual_export, tuần đã "
             "đóng)")
    L += ["", "---",
          ("*Sinh tự động bởi agent báo cáo định kỳ (`python -m "
           "agents.report`). Kiểm chứng số liệu trước khi trích dẫn "
           "ra ngoài.*"), ""]
    return "\n".join(L)


def report_name(since: datetime, until: datetime) -> str:
    """`report-<since>_<end>.md` — deterministic theo kỳ: chạy lại
    cùng kỳ → cùng tên → ghi đè (idempotent)."""
    end = _vn_day_s(until - timedelta(seconds=1))
    return f"report-{_vn_day_s(since)}_{end}.md"


def write_report(text: str, out_dir: Path, name: str,
                 sample: bool | None = None) -> Path:
    """Atomic tmp + `os.replace` (precedent `_purge_convlog`); ghi
    BYTES utf-8 — `write_text` trên Windows đổi `\\n`→`\\r\\n`.
    v13.3: tên file thuộc tiền tố báo cáo của tính năng đang TẮT
    (`pipelines.rollout.gate_report`, HĐ 6.7) → RolloutBlocked, không ghi.
    v14.3: ghi xong → `rollout.record_report` (sổ `report_outputs` để đếm
    đầu ra của tính năng; `sample=True` = dựng trên dữ liệu MẪU, không
    đếm). v15.2 (P8.5): tính năng đang chạy thử / chờ người duyệt → nội dung
    file (.md) mang nhãn "CHẠY THỬ — KHÔNG GỬI" / "CHỜ NGƯỜI DUYỆT — CHƯA
    GỬI" ở đầu; sha trong sổ = bản có nhãn (đúng bản trên đĩa). P8.4: mọi
    caller truyền `sample=` tường minh theo provenance (test AST)."""
    from pipelines import rollout  # lười: rollout import module này
    md = rollout.gate_report(name)
    text = rollout.label_report(name, text, md)
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / name
    tmp = out_dir / (name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, final)
    rollout.record_report(name, text, sample)
    return final


def queue_sample(conn, qid) -> bool:
    """v15.2 (P8.4): provenance của báo cáo xuất từ 1 mục hàng duyệt = cờ
    `approval_queue.is_sample` của mục đó; không đọc được / không có mục →
    True (fail-closed: không đếm là đầu ra thật)."""
    try:
        row = conn.execute("select is_sample from approval_queue where"
                           " id = %s", (qid,)).fetchone()
    except Exception:  # noqa: BLE001 — chỉ quyết cờ đếm, không chặn xuất
        return True
    return True if row is None else bool(row[0])


def rep_sample(rep: dict) -> bool:
    """Báo cáo định kỳ có mục dựng trên nguồn `sample:` (bán hàng / lead /
    vùng trồng) hoặc DB không khả dụng (báo cáo degraded) → True."""
    db = rep.get("db") or {}
    if not db.get("db_ok"):
        return True
    return any(bool((db.get(k) or {}).get("sample"))
               for k in ("sales", "leads", "farm"))


def list_reports(out_dir: Path = REPORTS_DIR) -> list[Path]:
    """Báo cáo đã sinh, mới nhất trước (tên file chứa kỳ → sort
    tên desc)."""
    if not out_dir.exists():
        return []
    return sorted(out_dir.glob("report-*.md"), key=lambda p: p.name,
                  reverse=True)


def generate(days: int = DEFAULT_DAYS, until=None,
             out_dir: Path = REPORTS_DIR,
             data_dir: Path = DATA_DIR, conn=None):
    """connect → collect → render → ghi file → (path, rep).
    `conn` truyền sẵn cho test/UI; None → tự `connect()` (DSN từ
    .env, timeout 3s; None khi DB down → báo cáo degraded)."""
    since, until_excl = period_bounds(days, until)
    rep = {"period": {"days": days, "since": since,
                      "until": until_excl},
           "generated_at": datetime.now(timezone.utc)}
    own = False
    if conn is None:
        conn = connect()
        own = True
    try:
        rep["db"] = (collect_db(conn, since, until_excl)
                     if conn is not None else
                     {"db_ok": False,
                      "db_error": "không kết nối được Postgres "
                      "(DATABASE_URL thiếu hoặc host chết)"})
        rep["marketing"] = collect_marketing(conn, since, until_excl)
    finally:
        if own and conn is not None:
            # Đóng conn không được giết agent sau khi số liệu đã có.
            with suppress(Exception):
                conn.close()
    rep["chat"] = collect_chat(data_dir, since, until_excl)
    path = write_report(render(rep), out_dir,
                        report_name(since, until_excl),
                        sample=rep_sample(rep))
    return path, rep


def _tra_lai(rep: dict) -> str:
    """Topline CLI: tra-lai=<rejected>/<decided> nháp nội dung trong kỳ."""
    m = rep.get("marketing") or {}
    if not m.get("ok"):
        return "tra-lai=[chưa nạp]"
    t = m["drafts_total"]
    return f"tra-lai={t['rejected']}/{t['decided']}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.report",
        description="Agent báo cáo định kỳ → file markdown "
                    "(BẢN NHÁP — không tự gửi)")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"số ngày trong kỳ (mặc định {DEFAULT_DAYS})")
    ap.add_argument("--until", default=None,
                    help="YYYY-MM-DD — ngày cuối kỳ (mặc định hôm "
                         "nay giờ VN)")
    ap.add_argument("--out-dir", default=str(REPORTS_DIR),
                    help="thư mục ghi báo cáo")
    args = ap.parse_args(argv)
    if not 1 <= args.days <= 3660:
        ap.error("--days phải trong 1..3660 (quá lớn OverflowError "
                 "trong period_bounds)")
    until = None
    if args.until:
        try:
            until = date.fromisoformat(args.until)
        except ValueError:
            ap.error("--until sai định dạng YYYY-MM-DD")

    load_dotenv(ROOT / ".env")
    path, rep = generate(days=args.days, until=until,
                         out_dir=Path(args.out_dir))
    p = rep["period"]
    end_s = _vn_day_s(p["until"] - timedelta(seconds=1))
    print(f"[report] kỳ {_vn_day_s(p['since'])} → {end_s} "
          f"({p['days']} ngày)", flush=True)
    db = rep["db"]
    if not db.get("db_ok"):
        print(f"[warn] DB không khả dụng — báo cáo degraded: "
              f"{_db_err(db)}", flush=True)
        print(f"[done] {path} — convlog trong kỳ "
              f"{rep['chat']['in_period']} {_tra_lai(rep)}", flush=True)
        return 0
    s, leads, farm = db["sales"], db["leads"], db["farm"]
    print(f"[done] {path} — đơn={s['count']} "
          f"doanh-thu={_fmt_vnd(s['revenue'])} "
          f"leads-mới={leads['new']} "
          f"nhật-ký={farm['count']} "
          f"convlog-kỳ={rep['chat']['in_period']} {_tra_lai(rep)}",
          flush=True)
    return 0


if __name__ == "__main__":
    # v3.7: ghi lần chạy vào job_runs (bản tin sức khỏe F17.2) —
    # main() giữ nguyên chữ ký/output/exit code.
    with job_run("agents.report") as run:
        rc = main()
        run["ok"] = rc == 0
    raise SystemExit(rc)
