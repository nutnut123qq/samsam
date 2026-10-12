"""v8.1 W81.3 (WP10) — Agent Sổ rủi ro pháp lý mở (cockpit TGĐ).

Contract:
  - CHỈ ĐỌC tracker của Pháp chế (không bảng mới, không nhập tay song song —
    tính lại mỗi lần chạy): hồ sơ `xnqc_dossiers` (v4.3) + SKU TPBVSK golden,
    bài kênh vi phạm đang mở `channel_posts` (v4.3), cảnh báo đỏ gốc chưa
    xác nhận `red_alerts`/`red_alert_acks`, DPIA (`data/sim_config.json`
    `dpia_signed` + tổng `gaps` của `data/data_flow_map.json`), tuyến cảnh
    báo đỏ (`pipelines.red_alert.load_routing` — chỉ đếm người nhận).
    `collect` CHỈ SELECT (chạy được trong transaction read only); CLI đặt
    kết nối `read_only`.
  - `collect(conn, as_of)` là AS-OF: bài vi phạm mở tại `as_of` = dòng mới
    nhất theo URL trong các dòng `scanned_at <= as_of` còn mức và chưa đóng
    trước `as_of`; cảnh báo gốc `ts <= as_of` chưa có ack `<= as_of` (bản leo
    thang `detail ? 'escalation_of'` KHÔNG tính). GIỚI HẠN: hồ sơ XNQC chưa
    có lịch sử trạng thái → as-of chỉ lọc theo ngày tạo, trạng thái là hiện
    tại.
  - `rank(facts, now, cfg)` THUẦN, TẤT ĐỊNH: mức `do|vang|xanh` theo luật
    trong `data/ceo_risk.json` (BẢN DEV SOẠN chờ Pháp chế duyệt) + hạn đợt 2/
    ngưỡng giấy sắp hết hạn của `data/phap_che.json` (đọc qua
    `agents.ra_kenh.load_config`, không chép số); xếp (mức, ngày còn lại —
    không hạn xếp cuối, mã). `trend` so với 7 ngày trước. Mã SKU TPBVSK chưa
    nộp là `XNQC-CHO-NOP:<sku>` ("chờ nộp") — KHÔNG dùng chữ không dấu
    "CHUA": guardrail gập dấu coi "CHUA" là từ cấm "chữa" → trang TGĐ trượt.
  - Owner là VAI TRÒ (không tên người); không chép text bài. Agent KHÔNG tư
    vấn pháp lý, KHÔNG đổi mức thay Pháp chế. Không mạng, không LLM.

Chạy: python -m agents.ceo_risk --report [--now ISO] [--out-dir DIR]
Exit: 0 ok · 2 tham số sai / cấu hình hỏng / DB down / lỗi DB.
"""

import argparse
import json
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg

from agents import xnqc
from agents.ra_kenh import _iso_date, page_safe, parse_now, safe
from agents.ra_kenh import load_config as phap_che_config
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.red_alert import load_routing
from pipelines.store import _db_msg
from scripts import dpia_draft

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "ceo_risk.json"
SIM_CONFIG = ROOT / "data" / "sim_config.json"
LEVELS = {"do": 0, "vang": 1, "xanh": 2}
LEVEL_VI = {"do": "ĐỎ", "vang": "VÀNG", "xanh": "XANH"}
SHOW = 8
WEEK = timedelta(days=7)
OWNER = "phap_che"
_POSTS_SQL = (
    "select url, channel, severity, due_at from (select distinct on (url)"
    " url, channel, severity, due_at, closed_at from channel_posts where"
    " scanned_at <= %s order by url, id desc) p where severity is not null"
    " and (closed_at is null or closed_at > %s) order by url")
_ALERTS_SQL = (
    "select r.id from red_alerts r where not (r.detail ? 'escalation_of')"
    " and r.ts <= %s and not exists (select 1 from red_alert_acks a where"
    " a.alert_id = r.id and a.acked_at <= %s) order by r.id")
_DOSSIER_COLS = ("id", "sku_key", "status", "ngay_nop", "ngay_cap",
                 "ngay_het_han")


# ------------------------------------------------------------------ cấu hình
class ConfigError(ValueError):
    """data/ceo_risk.json thiếu/hỏng — fail-closed."""


def load_config(path=None, phap_che=None) -> dict:
    """data/ceo_risk.json (+ hạn đợt 2/ngưỡng giấy từ data/phap_che.json) →
    dict đã kiểm. Thiếu/hỏng/`{}`/chỉ `_doc`/ngày sai/list rỗng →
    ValueError (fail-closed)."""
    p = Path(path) if path is not None else CONFIG
    try:
        doc = json.loads(p.read_bytes().decode("utf-8-sig"))
    except FileNotFoundError:
        raise ValueError(f"không có file {p.name}") from None
    except (OSError, ValueError) as e:
        raise ValueError(f"{p.name} hỏng: {type(e).__name__}") from None
    if not isinstance(doc, dict):
        raise ConfigError(f"{p.name}: không phải object JSON")
    cfg = {"xnqc_phi_moc": _iso_date(doc.get("xnqc_phi_moc"),
                                     "xnqc_phi_moc")}
    for k in ("xnqc_phi_text", "xnqc_phi_nguon_url"):
        v = doc.get(k)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"{k}: cần chuỗi không rỗng")
        cfg[k] = v.strip()
    if not cfg["xnqc_phi_nguon_url"].startswith(("https://", "http://")):
        raise ValueError("xnqc_phi_nguon_url: cần URL http(s)")
    marks = doc.get("nhac_moc_ngay")
    if (not isinstance(marks, list) or not marks
            or not all(isinstance(m, int) and not isinstance(m, bool)
                       and m > 0 for m in marks)):
        raise ValueError("nhac_moc_ngay: cần list số nguyên > 0 không rỗng")
    cfg["nhac_moc_ngay"] = sorted(set(marks), reverse=True)
    v = doc.get("do_khi_con_ngay")
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise ValueError("do_khi_con_ngay: cần số nguyên ≥ 0")
    cfg["do_khi_con_ngay"] = v
    pc = phap_che_config() if phap_che is None else phap_che_config(phap_che)
    cfg["dot2_han_nop"] = pc["dot2_han_nop"]
    cfg["het_han_canh_bao_ngay"] = pc["het_han_canh_bao_ngay"]
    return cfg


def _dpia_facts() -> tuple[bool, int]:
    try:
        sim = json.loads(SIM_CONFIG.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"{SIM_CONFIG.name} hỏng: {type(e).__name__}") \
            from None
    signed = isinstance(sim, dict) and sim.get("dpia_signed") is True
    gaps = sum(len(f["gaps"]) for f in dpia_draft.load_map()["flows"])
    return signed, gaps


# ------------------------------------------------------------------ đọc
def collect(conn, as_of: datetime, *, routing=None) -> dict:
    """CHỈ SELECT (+ đọc file cấu hình) → facts as-of cho `rank`."""
    if not isinstance(as_of, datetime) or as_of.utcoffset() is None:
        raise ValueError("as_of phải là datetime có múi giờ")
    dossiers = [dict(zip(_DOSSIER_COLS, r)) for r in conn.execute(
        f"select {', '.join(_DOSSIER_COLS)} from xnqc_dossiers where"
        " created_at <= %s order by sku_key, id", (as_of,)).fetchall()]
    posts = [dict(zip(("url", "channel", "severity", "due_at"), r))
             for r in conn.execute(_POSTS_SQL, (as_of, as_of)).fetchall()]
    alerts = [r[0] for r in conn.execute(_ALERTS_SQL,
                                         (as_of, as_of)).fetchall()]
    signed, gaps = _dpia_facts()
    return {"as_of": as_of, "dossiers": dossiers,
            "tpbvsk": xnqc.tpbvsk_skus(), "posts": posts, "alerts": alerts,
            "dpia_signed": signed, "gaps": gaps,
            "recipients": len(load_routing(routing)["recipients"])}


# ------------------------------------------------------------------ thuần
def _d(x) -> str:
    return x.strftime("%d/%m/%Y") if isinstance(x, date) else "—"


def _risk(code, level, title, *, due=None, days_left=None, marker=None,
          source=None, owner=OWNER) -> dict:
    return {"code": code, "level": level, "title": title, "owner_role": owner,
            "due": due, "days_left": days_left, "marker": marker,
            "source": source}


def fee_marker(days: int, marks) -> str | None:
    """Ngày tới mốc phí → 'T-30'/'T-14'/'T-7' (mốc nhỏ nhất ≥ days), quá →
    'QUÁ MỐC PHÍ', xa hơn mọi mốc → None."""
    if days < 0:
        return "QUÁ MỐC PHÍ"
    hit = [m for m in marks if days <= m]
    return f"T-{min(hit)}" if hit else None


def rank(facts: dict, now: datetime, cfg: dict) -> list[dict]:
    """facts → danh sách rủi ro xếp hạng (THUẦN, tất định — thứ tự đầu vào
    không ảnh hưởng)."""
    today = now.astimezone(VN_TZ).date()
    out = []
    by_sku: dict[str, list[dict]] = {}
    for d in facts.get("dossiers") or ():
        by_sku.setdefault(d["sku_key"], []).append(d)
    fee, dot2 = cfg["xnqc_phi_moc"], cfg["dot2_han_nop"]
    for sku in sorted(set(facts.get("tpbvsk") or ())):
        mine = by_sku.get(sku, [])
        if any(xnqc._valid_cap(d, today) or d["status"] in ("da_nop",
                                                             "bo_sung")
               for d in mine):
            continue
        to_fee, to_dot2 = (fee - today).days, (dot2 - today).days
        left = min(to_fee, to_dot2)
        marker = fee_marker(to_fee, cfg["nhac_moc_ngay"])
        out.append(_risk(
            f"XNQC-CHO-NOP:{sku}",
            "do" if left <= cfg["do_khi_con_ngay"] else "vang",
            (f"SKU TPBVSK {sku} chưa nộp hồ sơ XNQC — hạn đợt 2 {_d(dot2)},"
             f" mốc phí {_d(fee)}: {cfg['xnqc_phi_text']}"),
            due=min(fee, dot2), days_left=left, marker=marker,
            source=cfg["xnqc_phi_nguon_url"]))
    for sku in sorted(by_sku):
        mine = by_sku[sku]
        if (any(d["status"] in ("da_nop", "bo_sung") for d in mine)
                and not any(xnqc._valid_cap(d, today) for d in mine)):
            out.append(_risk(f"XNQC-CHO-CAP:{sku}", "xanh",
                             f"SKU {sku} đã nộp hồ sơ XNQC, chờ cấp giấy"))
    for d in sorted(facts.get("dossiers") or (), key=lambda d: d["id"]):
        het = d.get("ngay_het_han")
        if d["status"] != "da_cap" or het is None:
            continue
        left = (het - today).days
        if left < 0:
            level, what = "do", f"đã hết hạn {_d(het)}"
        elif left <= cfg["het_han_canh_bao_ngay"]:
            level, what = "vang", f"sắp hết hạn {_d(het)} (còn {left} ngày)"
        else:
            continue
        out.append(_risk(f"XNQC-HET-HAN:{d['id']}", level,
                         f"Giấy XNQC hồ sơ #{d['id']} ({d['sku_key']}) {what}",
                         due=het, days_left=left))
    chans: dict[str, list[dict]] = {}
    for p in facts.get("posts") or ():
        chans.setdefault(p["channel"], []).append(p)
    for ch in sorted(chans):
        ps = chans[ch]
        s1 = sum(1 for p in ps if p["severity"] == "S1")
        over = sum(1 for p in ps if p["due_at"] is not None
                   and p["due_at"] < now)
        dues = [p["due_at"] for p in ps if p["due_at"] is not None]
        due = min(dues).astimezone(VN_TZ).date() if dues else None
        out.append(_risk(
            f"KENH:{ch}", "do" if s1 or over else "vang",
            (f"Bài vi phạm đang mở kênh {ch}: S1 {s1}, S2 {len(ps) - s1},"
             f" quá 24h {over}"),
            due=due, days_left=(due - today).days if due else None))
    n_alerts = len(facts.get("alerts") or ())
    if n_alerts:
        out.append(_risk("CANH-BAO-DO", "do",
                         f"{n_alerts} cảnh báo đỏ gốc chưa có người xác nhận",
                         owner="phap_che/bks"))
    if not facts.get("dpia_signed"):
        out.append(_risk("DPIA", "do",
                         (f"DPIA/TIA chưa ký — {facts.get('gaps', 0)} rủi ro "
                          "tồn dư trong bản đồ luồng dữ liệu")))
    elif facts.get("gaps"):
        out.append(_risk("DPIA", "vang",
                         (f"DPIA đã ký, còn {facts['gaps']} rủi ro tồn dư "
                          "trong bản đồ luồng dữ liệu")))
    if not facts.get("recipients"):
        out.append(_risk("TUYEN-CANH-BAO", "do",
                         ("Chưa có người nhận cảnh báo đỏ độc lập "
                          "(data/red_alert_routing.json)")))
    return sorted(out, key=lambda r: (LEVELS[r["level"]],
                                      r["days_left"] is None,
                                      r["days_left"] or 0, r["code"]))


def trend(cur: list[dict], prev: list[dict]) -> dict:
    """So 2 lần `rank` → {"codes": {code: 'mới'|'↑'|'↓'|'='}, "gone": số mã
    tuần trước có mà nay hết}. THUẦN."""
    before = {r["code"]: LEVELS[r["level"]] for r in prev}
    codes = {}
    for r in cur:
        b = before.get(r["code"])
        lv = LEVELS[r["level"]]
        codes[r["code"]] = ("mới" if b is None else "↑" if lv < b
                            else "↓" if lv > b else "=")
    now_codes = {r["code"] for r in cur}
    return {"codes": codes, "gone": sum(1 for c in before
                                        if c not in now_codes)}


def _cell(s) -> str:
    return safe(_mask_pii(str(s))).replace("|", "/").replace("\n", " ")


def risk_row(r: dict, sym: str = "—") -> str:
    title = r["title"] + (f" — {r['marker']}" if r["marker"] else "")
    if r["source"]:
        title += f" (nguồn: {r['source']})"
    # Mỗi ô qua page_safe: sku_key/kênh/URL nguồn có thể chứa chữ trần
    # gập-dấu thành từ cấm → cả trang TGĐ trượt guardrail.
    return "| " + " | ".join(page_safe(_cell(x)) for x in (
        LEVEL_VI[r["level"]], r["code"], title, r["owner_role"],
        _d(r["due"]), sym)) + " |"


def render_section(ranked: list[dict], tr: dict, now: datetime,
                   limit: int | None = SHOW) -> list[str]:
    """→ dòng markdown "## Rủi ro pháp lý mở". Mọi số do code đếm."""
    cnt = {k: sum(1 for r in ranked if r["level"] == k) for k in LEVELS}
    since = (now - WEEK).astimezone(VN_TZ)
    L = ["## Rủi ro pháp lý mở", "",
         (f"Đỏ {cnt['do']} · Vàng {cnt['vang']} · Xanh {cnt['xanh']} · đã "
          f"hết trong tuần: {tr.get('gone', 0)} (so với {since:%d/%m/%Y})"),
         ""]
    if not ranked:
        L.append("- (không có rủi ro mở)")
    else:
        L += ["| Mức | Mã | Rủi ro | Owner (vai trò) | Hạn | Xu hướng |",
              "|---|---|---|---|---|---|"]
        shown = ranked if limit is None else ranked[:limit]
        L += [risk_row(r, tr.get("codes", {}).get(r["code"], "—"))
              for r in shown]
        if len(ranked) > len(shown):
            L.append(f"\n…và {len(ranked) - len(shown)} rủi ro khác (xem "
                     "`python -m agents.ceo_risk --report`)")
    L += ["", ("*Tính lại mỗi lần từ tracker Pháp chế (hồ sơ XNQC, bài kênh "
               "vi phạm, cảnh báo đỏ, DPIA, tuyến cảnh báo) — không nhập tay "
               "song song. Hồ sơ XNQC chưa có lịch sử trạng thái: xu hướng hồ"
               " sơ theo trạng thái hiện tại. Mức theo luật data/ceo_risk.json"
               " (BẢN DEV SOẠN, chờ Pháp chế duyệt) — agent không tư vấn pháp"
               " lý.*")]
    return L


def compute(conn, now: datetime, cfg: dict | None = None) -> tuple:
    cfg = cfg if cfg is not None else load_config()
    cur = rank(collect(conn, now), now, cfg)
    prev = rank(collect(conn, now - WEEK), now - WEEK, cfg)
    return cur, trend(cur, prev)


def section(conn, now: datetime) -> list[str]:
    cur, tr = compute(conn, now)
    return render_section(cur, tr, now)


# ------------------------------------------------------------------ CLI
def _now() -> datetime:
    return datetime.now(VN_TZ)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ceo_risk",
        description="Sổ rủi ro pháp lý mở (CHỈ ĐỌC tracker Pháp chế)")
    ap.add_argument("--report", action="store_true",
                    help="ghi data/reports/ceo-risk-<ngày>.md")
    ap.add_argument("--now", help="ISO; thiếu múi giờ = giờ VN (+07:00)")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    a = ap.parse_args(argv)
    if not a.report:
        ap.error("cần --report")
    try:
        now = parse_now(a.now) if a.now else _now()
    except ValueError:
        ap.error("--now sai định dạng ISO")
    try:
        cfg = load_config()
    except ValueError as e:
        print(f"[error] cấu hình: {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        conn.read_only = True     # chỉ đọc — DB từ chối mọi lệnh ghi
        cur, tr = compute(conn, now, cfg)
        conn.rollback()
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_cell(_db_msg(e))[:300]}", file=sys.stderr)
        return 2
    except ValueError as e:
        print(f"[error] cấu hình/dữ liệu: {_cell(e)[:300]}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    vn = now.astimezone(VN_TZ)
    text = "\n".join([f"# Sổ rủi ro pháp lý mở — {vn:%d/%m/%Y %H:%M} (giờ VN)",
                      "", *render_section(cur, tr, now, limit=None), "",
                      "---", "*BẢN NHÁP — agent chỉ đọc, không tự gửi.*", ""])
    path = write_report(text, a.out_dir, f"ceo-risk-{vn:%Y-%m-%d}.md")
    cnt = {k: sum(1 for r in cur if r["level"] == k) for k in LEVELS}
    print(f"[done] {path} — đỏ {cnt['do']}, vàng {cnt['vang']}, xanh"
          f" {cnt['xanh']}")
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.ceo_risk") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
