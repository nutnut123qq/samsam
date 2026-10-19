"""v8.1 W81.4 (WP10) — Agent Kiểm soát nội bộ – Audit outside-in P1.

Câu hỏi: thứ ĐANG CHẠY ngoài kênh có đúng bản đã duyệt không?
  (a) Bài đang đăng = dòng `channel_posts` mới nhất theo URL (file xuất tay
      v4.3). `close_reason = 'da_go'` → đã gỡ (đếm riêng, ngoài mẫu số);
      không `draft_id` và ngày đăng trước `quy_trinh_duyet_tu`
      (`data/phap_che.json`) → `truoc_quy_trinh` (ngoài mẫu số; ngày trống =
      bài mới, fail-closed như `ra_kenh.scan_row`). Còn lại TÍNH LẠI tại lúc
      audit (KHÔNG tin `codes` đã lưu — bản duyệt có thể bị thu hồi sau đó):
      `store.verify_publish` True → `khop`; quyết định mới nhất của draft là
      approved nhưng sha256 lệch → `lech_ban_duyet`; không draft / quyết định
      mới nhất không phải approved / draft không tồn tại → `thieu_ban_duyet`.
  (b) Listing sàn = snapshot `listing` mới nhất mỗi kênh (`market_snapshots`
      theo `imported_at desc, id desc`) → mọi `market_rows`: không map SKU →
      `khong_xac_dinh_sku` (VÀO mẫu số — fail-closed); bản duyệt = nháp
      `content_drafts` loại `listing` cùng SKU + kênh mà `verify_publish`
      True; không có → `thieu_ban_duyet`; có → tiêu đề listing so DÒNG ĐẦU
      bản duyệt (NFC + casefold + gộp khoảng trắng) khớp bất kỳ bản →
      `khop`, không → `lech_ban_duyet`.
  GIỚI HẠN P1: file xuất sàn chỉ có tiêu đề/giá — MÔ TẢ listing chưa so
  được; giá đã có cảnh báo `market_alerts price_mismatch` (v3.3, không làm
  lại — chỉ đếm cảnh báo giá đang mở). Audit inside-out, khung giá–voucher,
  neo hash object-lock = P2.
  - `compliance(items)` THUẦN → tỷ lệ tuân thủ quy trình duyệt THEO KÊNH
    (khớp/mẫu số; mẫu số 0 → "—", KHÔNG 0%); kênh sàn chưa có file xuất →
    "chưa có dữ liệu quan sát (chỉ file xuất tay)".
  - CHỈ ĐỌC: không ghi bảng nào, không mở ticket/cảnh báo (việc của
    `agents.ra_kenh`), không sửa/gỡ bài, không đổi listing/giá. Section/
    report KHÔNG chép text bài, KHÔNG chép tiêu đề listing — chỉ kênh/mã/id;
    URL/item_id đã che PII CHỈ trong file report (section trang TGĐ/bản tin
    chỉ `#id` nội bộ — slug URL trần trượt guardrail gập dấu). Không mạng,
    không LLM.

Chạy: python -m agents.ceo_audit --report [--now ISO] [--out-dir DIR]
Exit: 0 ok (có phát hiện vẫn 0 — audit là báo, không chặn) · 2 tham số sai /
cấu hình hỏng / DB down / lỗi DB.
"""

import argparse
import sys
import unicodedata
from contextlib import suppress
from datetime import datetime
from pathlib import Path

import psycopg

from agents.ra_kenh import load_config as phap_che_config
from agents.ra_kenh import parse_now, safe
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import CHANNELS as MARKET_CHANNELS
from pipelines import store
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

KHOP, LECH, THIEU = "khop", "lech_ban_duyet", "thieu_ban_duyet"
NO_SKU = "khong_xac_dinh_sku"
FINDINGS = (LECH, THIEU, NO_SKU)
NO_DATA = "chưa có dữ liệu quan sát (chỉ file xuất tay)"
SHOW = 5
_POSTS_SQL = (
    "select distinct on (url) id, url, channel, posted_on, draft_id, text,"
    " close_reason from channel_posts order by url, id desc")
_DECISION_SQL = (
    "select decision from approvals where object_type = %s and object_id ="
    " %s order by id desc limit 1")
_SNAP_SQL = (
    "select distinct on (channel) id, channel, file_name from"
    " market_snapshots where export_kind = 'listing' order by channel,"
    " imported_at desc, id desc")
_ROWS_SQL = (
    "select r.id, r.snapshot_id, r.row_no, r.channel, r.item_id,"
    " r.seller_sku, r.sku_key, r.title from market_rows r where"
    " r.snapshot_id = any(%s) order by r.channel, r.row_no, r.id")
_LISTING_SQL = (
    "select id, text from content_drafts where content_type = 'listing' and"
    " sku = %s and channel = %s order by id")


def norm_title(s) -> str:
    """NFC + casefold + gộp khoảng trắng — so tiêu đề listing."""
    return " ".join(unicodedata.normalize("NFC", str(s or "")).casefold()
                    .split())


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line
    return ""


# ------------------------------------------------------------------ đọc
def _post_code(conn, p: dict) -> str:
    did = p["draft_id"]
    if did is None:
        return THIEU
    if store.verify_publish(conn, did, p["text"]):
        return KHOP
    row = conn.execute(_DECISION_SQL, (store.OBJECT_TYPE, str(did))
                       ).fetchone()
    return LECH if row and row[0] == "approved" else THIEU


def collect(conn, cfg: dict | None = None) -> dict:
    """CHỈ SELECT → {"items": [...], "removed": [...], "before": [...],
    "snapshots": {kênh: file}, "price_alerts_open": n}. Mỗi item:
    {kind post|listing, channel, code, ref (URL / item_id·seller_sku)}."""
    cfg = cfg if cfg is not None else phap_che_config()
    start = cfg["quy_trinh_duyet_tu"]
    items, removed, before = [], [], []
    cols = ("id", "url", "channel", "posted_on", "draft_id", "text",
            "close_reason")
    for r in conn.execute(_POSTS_SQL).fetchall():
        p = dict(zip(cols, r))
        ref = {"kind": "post", "channel": p["channel"], "ref": p["url"],
               "post_id": p["id"]}
        if p["close_reason"] == "da_go":
            removed.append(ref)
        elif (p["draft_id"] is None and p["posted_on"] is not None
              and p["posted_on"] < start):
            before.append(ref)
        else:
            items.append(dict(ref, code=_post_code(conn, p)))
    snaps = conn.execute(_SNAP_SQL).fetchall()
    approved: dict[tuple, set | None] = {}
    if snaps:
        rcols = ("id", "snapshot_id", "row_no", "channel", "item_id",
                 "seller_sku", "sku_key", "title")
        for r in conn.execute(_ROWS_SQL, ([s[0] for s in snaps],)).fetchall():
            m = dict(zip(rcols, r))
            ref = " · ".join(x for x in (m["item_id"], m["seller_sku"]) if x)
            it = {"kind": "listing", "channel": m["channel"],
                  "ref": ref or f"dòng {m['row_no']}", "sku": m["sku_key"],
                  "row_id": m["id"]}
            if m["sku_key"] is None:
                items.append(dict(it, code=NO_SKU))
                continue
            key = (m["sku_key"], m["channel"])
            if key not in approved:
                titles = {norm_title(_first_line(t)) for did, t in
                          conn.execute(_LISTING_SQL, key).fetchall()
                          if store.verify_publish(conn, did, t)}
                approved[key] = titles or None
            titles = approved[key]
            code = (THIEU if titles is None
                    else KHOP if norm_title(m["title"]) in titles else LECH)
            items.append(dict(it, code=code))
    price = conn.execute(
        "select count(*) from market_alerts where kind = 'price_mismatch'"
        " and status = 'open'").fetchone()[0]
    return {"items": items, "removed": removed, "before": before,
            "snapshots": {s[1]: s[2] for s in snaps},
            "price_alerts_open": price}


# ------------------------------------------------------------------ thuần
def rate(khop: int, n: int) -> str:
    """Tỷ lệ khớp/mẫu số dạng phần trăm; mẫu số 0 → '—' (KHÔNG 0%)."""
    if n == 0:
        return "—"
    pct = round(khop * 100 / n, 1)
    return f"{pct:g}%".replace(".", ",")


def compliance(items: list[dict], channels=(), market=MARKET_CHANNELS,
               snapshots=None) -> list[dict]:
    """Theo kênh → [{channel, n, khop, rate, codes {mã: số}, note}] (THUẦN).
    `channels` thêm kênh luôn hiện; kênh sàn (`market`) chưa có snapshot
    listing → note NO_DATA."""
    snapshots = snapshots or {}
    chans = sorted({i["channel"] for i in items} | set(channels)
                   | set(market))
    out = []
    for ch in chans:
        mine = [i for i in items if i["channel"] == ch]
        n, k = len(mine), sum(1 for i in mine if i["code"] == KHOP)
        codes = {c: sum(1 for i in mine if i["code"] == c) for c in FINDINGS}
        note = None
        if ch in market and ch not in snapshots:
            note = NO_DATA if not mine else f"listing: {NO_DATA}"
        out.append({"channel": ch, "n": n, "khop": k, "rate": rate(k, n),
                    "codes": codes, "note": note})
    return out


def findings(items: list[dict]) -> list[dict]:
    """Mục KHÔNG khớp (theo kênh, mã, ref) — tất định."""
    return sorted((i for i in items if i["code"] != KHOP),
                  key=lambda i: (i["channel"], i["code"], i["kind"],
                                 str(i["ref"])))


def _ref(i: dict) -> str:
    """URL/mã từ file xuất tay → mã inline (`...`): che PII, bỏ ký tự điều
    khiển, không để URL tạo link/markdown trong file report (OWASP A03)."""
    return "`" + _mask_pii(safe(i["ref"])).replace("`", "'").replace(
        "|", "/") + "`"


def _id_ref(i: dict) -> str:
    """Mã NỘI BỘ cho trang TGĐ/bản tin: guardrail gập dấu nên slug URL
    (`...-chua-...`, `thuoc`) / seller_sku trần bị coi là từ cấm → trang
    trượt finalize, chặn --submit. Chỉ #id DB — URL đầy đủ ở file report."""
    if i["kind"] == "post":
        return f"#{i['post_id']}"
    return f"market_rows #{i['row_id']}"


def render_section(data: dict, limit: int | None = SHOW,
                   report_name: str = "ceo-audit-<ngày>.md",
                   full_ref: bool = False) -> list[str]:
    """→ dòng markdown "## Audit outside-in (P1)". CHỈ số + kênh/mã/id —
    không text bài, không tiêu đề listing. `full_ref` (CHỈ file
    ceo-audit-<ngày>.md, không qua finalize) → URL/item_id đã che PII;
    mặc định (trang TGĐ, bản tin) → #id nội bộ."""
    ref = _ref if full_ref else _id_ref
    comp = compliance(data["items"], snapshots=data.get("snapshots"))
    fs = findings(data["items"])
    n = sum(c["n"] for c in comp)
    k = sum(c["khop"] for c in comp)
    L = ["## Audit outside-in (P1)", "",
         (f"Bài/listing đang chạy so với bản đã duyệt: khớp {k}/{n} "
          f"({rate(k, n)}) · đã gỡ (ngoài mẫu số): {len(data['removed'])} · "
          f"đăng trước quy trình duyệt (ngoài mẫu số): {len(data['before'])}"
          f" · cảnh báo giá sàn đang mở (price_mismatch): "
          f"{data['price_alerts_open']}"), "",
         ("| Kênh | Mẫu số | Khớp | Tỷ lệ tuân thủ | lech_ban_duyet | "
          "thieu_ban_duyet | khong_xac_dinh_sku | Ghi chú |"),
         "|---|---|---|---|---|---|---|---|"]
    for c in comp:
        L.append(f"| {c['channel']} | {c['n']} | {c['khop']} | {c['rate']} |"
                 f" {c['codes'][LECH]} | {c['codes'][THIEU]} |"
                 f" {c['codes'][NO_SKU]} | {c['note'] or ''} |")
    by_code = {c: sum(1 for f in fs if f["code"] == c) for c in FINDINGS}
    L += ["", "Phát hiện theo mã: " + " · ".join(
        f"{c} {by_code[c]}" for c in FINDINGS), ""]
    shown = fs if limit is None else fs[:limit]
    L += [f"- [{f['channel']}] {f['code']} — {f['kind']} {ref(f)}"
          for f in shown] or ["- (không có phát hiện)"]
    if len(fs) > len(shown):
        L.append(f"- …và {len(fs) - len(shown)} (xem {report_name})")
    L += ["", ("*Tính lại tại lúc audit từ bài đang đăng (file xuất tay) + "
               "listing sàn (file Seller Center) so với bản duyệt (sha256 "
               "`approvals` / dòng đầu listing đã duyệt). GIỚI HẠN P1: chỉ so"
               " tiêu đề listing — mô tả chưa có trong file xuất sàn; giá đối"
               " chiếu ở cảnh báo price_mismatch. Agent chỉ báo — không "
               "sửa/gỡ bài, không đổi listing.*")]
    return L


def section(conn, now=None) -> list[str]:
    day = (now or datetime.now(VN_TZ)).astimezone(VN_TZ)
    return render_section(collect(conn),
                          report_name=f"ceo-audit-{day:%Y-%m-%d}.md")


# ------------------------------------------------------------------ CLI
def _now() -> datetime:
    return datetime.now(VN_TZ)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ceo_audit",
        description="Audit outside-in P1: bài/listing đang chạy so với bản "
                    "đã duyệt (CHỈ ĐỌC)")
    ap.add_argument("--report", action="store_true",
                    help="ghi data/reports/ceo-audit-<ngày>.md")
    ap.add_argument("--now", help="ISO (ngày trên tên file); thiếu múi giờ ="
                    " giờ VN (+07:00)")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    a = ap.parse_args(argv)
    if not a.report:
        ap.error("cần --report")
    try:
        now = parse_now(a.now) if a.now else _now()
    except ValueError:
        ap.error("--now sai định dạng ISO")
    try:
        cfg = phap_che_config()
    except ValueError as e:
        print(f"[error] cấu hình phap_che.json: {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        conn.read_only = True     # chỉ đọc — DB từ chối mọi lệnh ghi
        data = collect(conn, cfg)
        conn.rollback()
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {safe(_mask_pii(store._db_msg(e)))[:300]}",
              file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    vn = now.astimezone(VN_TZ)
    name = f"ceo-audit-{vn:%Y-%m-%d}.md"
    text = "\n".join([
        f"# Audit outside-in P1 — {vn:%d/%m/%Y %H:%M} (giờ VN)", "",
        *render_section(data, limit=None, report_name=name,
                        full_ref=True), "",
        "## File listing đã đối chiếu", ""]
        + [f"- {ch}: {safe(_mask_pii(f))}" for ch, f in sorted(data["snapshots"].items())]
        + (["- (chưa có file listing sàn)"] if not data["snapshots"] else [])
        + ["", "---", "*BẢN NHÁP — agent chỉ đọc, không tự gửi.*", ""])
    # P8.4: listing sàn + bài đã đăng (file xuất tay) + nháp đã duyệt — các
    # bảng nguồn không có đường ghi mẫu.
    path = write_report(text, a.out_dir, name, sample=False)
    fs = findings(data["items"])
    print(f"[done] {path} — {len(data['items'])} mục trong mẫu số,"
          f" {len(fs)} phát hiện")
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.ceo_audit") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
