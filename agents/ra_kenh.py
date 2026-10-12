"""v4.3 PC-A4 (WP05) — rà bài ĐANG ĐĂNG trên kênh SỞ HỮU + ticket gỡ/sửa 24h
+ báo cáo Pháp chế tuần.

Luồng: Quản lý MXH xuất tay danh sách bài (CSV: link, kênh, text, ngày...)
→ `read_export` kiểm TOÀN file trước khi connect → `scan_row` chạy
`guardrail.check_publish` theo kênh → `ingest` lưu snapshot vào
`channel_posts`, đối chiếu bản đã duyệt (`pipelines.store.verify_publish`),
mở 1 mục hàng duyệt (`director.submit`) cho mỗi "đợt vi phạm" của URL với
hạn 24 giờ ĐỒNG HỒ THẬT (gồm T7/CN/Tết — plan §9), S1 → `red_alerts`.

Ranh giới (Agent CHỈ phát hiện + đề xuất):
  - KHÔNG gỡ/sửa/ẩn bài trên kênh, KHÔNG gọi API kênh (chỉ file xuất tay).
  - KHÔNG sửa golden, KHÔNG ghi thẳng bảng duyệt — mọi ghi hàng duyệt/cảnh
    báo đi qua `director.submit` / `red_alert.raise_alert`.
  - Mục hàng duyệt do NGƯỜI quyết; approve = Pháp chế xác nhận lệnh gỡ/sửa,
    KHÔNG đóng vi phạm. Vi phạm chỉ đóng khi bản xuất lại SẠCH (`da_sua`)
    hoặc NGƯỜI ghi nhận đã gỡ (`--mark-removed`, `da_go`).
  - Payload ticket KHÔNG chép đoạn vi phạm (Pháp chế phải approve được qua
    guardrail); đoạn trích in ra luôn qua `_mask_pii`, ≤160 ký tự.

Đợt vi phạm theo URL: snapshot vi phạm khi URL chưa có dòng mở → hạn =
now + 24h + 1 mục hàng duyệt; snapshot vi phạm CÙNG LOẠI (nội dung↔nội
dung, hạ tầng↔hạ tầng) khi đã có đợt mở → kế thừa hạn/mục/cảnh báo (đồng hồ
KHÔNG reset khi sửa dở), dòng cũ `thay_ban_moi`; đổi loại → đóng đợt cũ
(`da_sua` khi vấn đề loại cũ đã hết, `thay_ban_moi` khi trang mặc định vẫn
còn nhưng nay kèm vi phạm nội dung) + mở đợt mới đúng khối; snapshot sạch →
đóng `da_sua` (+1 dòng `agent_action_log` `channel_post_fixed`). URL vắng
trong file mới → giữ nguyên (vắng ≠ đã gỡ). Nạp lại → bỏ qua (idempotent)
CHỈ khi sha text + cột bài (kênh, loại, is_ai, is_sponsored, sku,
draft_id, ngày) + kết quả rà (codes, mức — sau đối chiếu bản duyệt) trùng
snapshot mới nhất; luật guardrail/golden/bản duyệt đổi → rà lại ra snapshot
mới. Dòng mới nhất đã được NGƯỜI ghi nhận gỡ mà bài vẫn còn trong bản xuất
→ mở đợt mới.

Chạy:
  python -m agents.ra_kenh --file <csv> --by "<tên người>" [--dry-run [--now ISO]]
  python -m agents.ra_kenh --mark-removed <url> --by "<tên người>"
  python -m agents.ra_kenh --report [--now ISO] [--days 7]
`--now` CHỈ cho `--report`/`--dry-run` (thao tác ghi dùng giờ thật — chống
lùi `closed_at` làm giả "đúng hạn"); thiếu múi giờ → hiểu là giờ VN
(+07:00). Exit 0 ok (có vi phạm vẫn 0 — rà là báo, không chặn) · 1 file
không hợp lệ / mark-removed không có đợt mở · 2 usage / cấu hình hỏng / DB
không truy cập được.
"""

import argparse
import csv
import io
import json
import re
import sys
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from psycopg.types.json import Jsonb

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director, guardrail, red_alert, store
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "phap_che.json"
AGENT = "agent:phap_che_a4"
SLA = timedelta(hours=24)
MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 2000
MAX_TEXT = 20_000
EXCERPT = 160
MAX_BY = 100
MAX_URL = 2048          # BYTE UTF-8, không phải ký tự: btree channel_posts_url_idx
                        # giới hạn 2704 byte/dòng — chữ có dấu/CJK 3 byte/ký tự
BIGINT_MAX = 2**63 - 1
REQUIRED = ("url", "kenh", "is_ai", "text")
OPTIONAL = ("loai_noi_dung", "ngay_dang", "draft_id", "sku", "is_sponsored")
HOSTING = "trang_mac_dinh_hosting"
LECH, THIEU = "lech_ban_duyet", "thieu_ban_duyet"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_BY_AGENT_RE = re.compile(r"^\s*(agent|system)\s*:", re.IGNORECASE)


# ------------------------------------------------------------------ chung
def by_error(by) -> str | None:
    """Luật `--by` = tên NGƯỜI: rỗng / ký tự điều khiển / 'agent:'/'system:'
    (không phân biệt hoa thường, bỏ khoảng trắng đầu) → lý do từ chối."""
    if not isinstance(by, str) or not by.strip():
        return "thiếu tên người (--by)"
    if any(unicodedata.category(c) in ("Cc", "Cf") for c in by):
        return "--by chứa ký tự điều khiển"
    if _BY_AGENT_RE.match(by):
        return "--by phải là tên NGƯỜI — không nhận 'agent:'/'system:'"
    if len(by.strip()) > MAX_BY:
        return f"--by dài quá {MAX_BY} ký tự"
    return None


def safe(s) -> str:
    """In tên/chuỗi từ DB: thay ký tự điều khiển (chống giả dòng log)."""
    return "".join("?" if unicodedata.category(c) in ("Cc", "Cf") else c
                   for c in str(s if s is not None else ""))


def _iso_date(v, what: str) -> date:
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if not isinstance(v, str) or not _DATE_RE.fullmatch(v.strip()):
        raise ValueError(f"{what}: cần ngày YYYY-MM-DD")
    return date.fromisoformat(v.strip())


def _now() -> datetime:
    """Giờ thật (test monkeypatch hàm này — không wall-clock)."""
    return datetime.now(VN_TZ)


def parse_now(s: str) -> datetime:
    """ISO → datetime aware; thiếu múi giờ → giờ VN. Sai → ValueError."""
    dt = datetime.fromisoformat(str(s).strip())
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=VN_TZ)


def _aware(now) -> datetime:
    if not isinstance(now, datetime) or now.utcoffset() is None:
        raise ValueError("now phải là datetime có múi giờ")
    return now


def vn(dt) -> str:
    return dt.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M") if dt else "—"


class ConfigError(ValueError):
    """data/phap_che.json thiếu/hỏng — fail-closed."""


def load_config(path=CONFIG) -> dict:
    """data/phap_che.json → dict phẳng đã kiểm. Thiếu/hỏng/`{}`/chỉ `_doc`/
    ngày sai/số âm/list rỗng → ValueError (fail-closed)."""
    p = Path(path)
    try:
        doc = json.loads(p.read_bytes().decode("utf-8-sig"))
    except FileNotFoundError:
        raise ValueError(f"không có file {p.name}") from None
    except (OSError, ValueError) as e:
        raise ValueError(f"{p.name} hỏng: {type(e).__name__}") from None
    if not isinstance(doc, dict):
        raise ConfigError(f"{p.name}: không phải object JSON")
    x, r = doc.get("xnqc"), doc.get("ra_kenh")
    if not isinstance(x, dict) or not isinstance(r, dict):
        raise ConfigError(f"{p.name}: thiếu khối 'xnqc'/'ra_kenh'")
    cfg = {"dot2_han_nop": _iso_date(x.get("dot2_han_nop"), "dot2_han_nop"),
           "quy_trinh_duyet_tu": _iso_date(r.get("quy_trinh_duyet_tu"),
                                           "quy_trinh_duyet_tu")}
    for k in ("nhac_truoc_ngay", "het_han_canh_bao_ngay"):
        v = x.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError(f"{k}: cần số nguyên ≥ 0")
        cfg[k] = v
    for k in ("owned_web_hosts", "hosting_default_markers"):
        v = r.get(k)
        if (not isinstance(v, list) or not v
                or not all(isinstance(s, str) and s.strip() for s in v)):
            raise ValueError(f"{k}: cần list chuỗi không rỗng")
        cfg[k] = [unicodedata.normalize("NFC", s.strip()).casefold()
                  for s in v]
    cfg["owned_web_hosts"] = [h.removeprefix("www.")
                              for h in cfg["owned_web_hosts"]]
    return cfg


def _rules() -> dict:
    """Luật guardrail (kênh/alias/loại nội dung/golden) — CHỈ đọc."""
    rules, err = guardrail._load_rules(guardrail.DATA_DIR)
    if err:
        raise ValueError(err)
    return rules


# ------------------------------------------------------------------ đọc file
class ExportError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__(f"{len(errors)} lỗi")
        self.errors = errors


def _flag01(v: str, empty: bool) -> bool | None:
    v = v.strip()
    if v == "":
        return empty
    return {"0": False, "1": True}.get(v)


def read_export(path, cfg: dict) -> list[dict]:
    """Đọc + kiểm TOÀN file xuất tay TRƯỚC khi connect. Lỗi → ExportError
    (danh sách 'dòng N cột X: lý do' — KHÔNG kèm giá trị ô)."""
    p = Path(path)
    if p.suffix.lower() != ".csv":
        raise ExportError(["chỉ nhận file .csv"])
    if not p.is_file():
        raise ExportError(["không có file"])
    if p.stat().st_size > MAX_BYTES:
        raise ExportError([f"file lớn hơn {MAX_BYTES // 1024 // 1024} MB"])
    try:
        raw = p.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ExportError(["file không phải UTF-8"]) from None
    rules = _rules()
    try:
        recs = list(csv.reader(io.StringIO(raw, newline="")))
    except csv.Error as e:
        raise ExportError([f"CSV hỏng ({type(e).__name__})"]) from None
    if not recs:
        raise ExportError(["file rỗng"])
    head = [h.strip().lower() for h in recs[0]]
    errs = []
    if any(not h for h in head):
        errs.append("dòng 1: có cột header rỗng")

    def names(hs):   # tên cột in ra: mask + cắt, tối đa 10 tên (header rộng)
        more = f" (+{len(hs) - 10})" if len(hs) > 10 else ""
        return f"{[_mask_pii(h)[:40] for h in hs[:10]]}{more}"

    # Counter, không `head.count` — header 650k cột (5 MB) là O(n²) treo.
    dup = sorted(h for h, k in Counter(head).items() if h and k > 1)
    if dup:
        errs.append(f"dòng 1: header trùng {names(dup)}")
    stray = [h for h in head if h and h not in REQUIRED + OPTIONAL]
    if stray:
        errs.append(f"dòng 1: cột lạ {names(stray)} —"
                    " chỉ nhận bài của công ty, không bình luận/người tương tác")
    miss = [c for c in REQUIRED if c not in head]
    if miss:
        errs.append(f"dòng 1: thiếu cột bắt buộc {miss}")
    if errs:
        raise ExportError(errs)
    body = [(i, r) for i, r in enumerate(recs[1:], start=2)
            if any(c.strip() for c in r)]
    if not body:
        raise ExportError(["file không có dòng bài nào"])
    if len(body) > MAX_ROWS:
        raise ExportError([f"quá {MAX_ROWS} dòng"])
    out, seen = [], {}
    for n, r in body:
        if len(r) != len(head):
            errs.append(f"dòng {n}: số ô {len(r)} ≠ số cột {len(head)}")
            continue
        c = dict(zip(head, r))

        def bad(col, why, n=n):
            errs.append(f"dòng {n} cột {col}: {why}")

        for col, v in c.items():   # NUL → psycopg DataError giữa lúc nạp
            if "\x00" in v:
                bad(col, "chứa ký tự NUL")
        url = c["url"].strip()
        too_long = len(url.encode("utf-8")) > MAX_URL   # đếm BYTE (btree)
        try:   # 'http://[abc/' → ValueError (IPv6 hỏng) = lỗi ô, không phải cấu hình
            parts = urlsplit(url) if url and not too_long else None
            host = (parts.hostname or "") if parts else ""
        except ValueError:
            parts, host = None, ""
        if too_long:
            bad("url", f"dài quá {MAX_URL} byte UTF-8")
        elif (not parts or parts.scheme not in ("http", "https") or not host
                or any(ch.isspace() or unicodedata.category(ch)[0] == "C"
                       for ch in url)):
            bad("url", "cần URL http(s) có host, không khoảng trắng/ký tự"
                " điều khiển")
        elif url in seen:
            bad("url", f"trùng URL với dòng {seen[url]} (mơ hồ)")
        seen.setdefault(url, n)
        ch = c["kenh"].strip().lower()
        ch = rules["channel_alias"].get(ch, ch)
        if ch not in rules["channels"]:
            bad("kenh", f"kênh không hợp lệ — nhận {rules['channels']}")
        elif ch == "web" and host and \
                host.lower().removeprefix("www.") not in cfg["owned_web_hosts"]:
            bad("url", "host web không thuộc danh sách website sở hữu")
        ct = (c.get("loai_noi_dung") or "").strip() or "post"
        if ct not in rules["content_types"]:
            bad("loai_noi_dung", "loại nội dung không hợp lệ")
        elif not rules["content_types"][ct].get("public", True):
            # internal_note bỏ luật rượu — bài trên kênh luôn công khai
            bad("loai_noi_dung", "loại nội bộ — bài đang đăng luôn công khai")
        is_ai = _flag01(c["is_ai"], True)
        if is_ai is None:
            bad("is_ai", "chỉ nhận 0/1 (trống = 1)")
        spon = _flag01(c.get("is_sponsored") or "", False)
        if spon is None:
            bad("is_sponsored", "chỉ nhận 0/1 (trống = 0)")
        posted = None
        d = (c.get("ngay_dang") or "").strip()
        if d:
            try:
                posted = _iso_date(d, "ngay_dang")
            except ValueError:
                bad("ngay_dang", "cần ngày YYYY-MM-DD hợp lệ")
        did = None
        d = (c.get("draft_id") or "").strip()
        if d:
            # len trước int(): >4300 chữ số → ValueError; > bigint → lỗi DB
            if (d.isascii() and d.isdigit() and len(d) <= 19
                    and 0 < int(d) <= BIGINT_MAX):
                did = int(d)
            else:
                bad("draft_id", "cần số nguyên 1..2^63-1")
        sku = (c.get("sku") or "").strip() or None
        if sku is not None and sku not in rules["golden"]:
            bad("sku", "SKU không có trong golden")
        text = c["text"].replace("\r\n", "\n")
        if not text.strip():
            bad("text", "rỗng")
        elif len(text) > MAX_TEXT:
            bad("text", f"dài quá {MAX_TEXT} ký tự")
        out.append({"line": n, "url": url, "channel": ch, "content_type": ct,
                    "posted_on": posted, "draft_id": did, "sku": sku,
                    "is_ai": is_ai, "is_sponsored": spon, "text": text,
                    "sha": store.content_sha256(text)})
    if errs:
        raise ExportError(errs)
    return out


# ------------------------------------------------------------------ rà 1 bài
def _excerpt(text: str, v: dict | None) -> str:
    """Đoạn trích ≤160 ký tự quanh vi phạm. Che PII TOÀN văn rồi mới cắt —
    cắt trước thì SĐT vắt mép cửa sổ còn nửa số, regex không bắt → lộ."""
    masked = _mask_pii(text)
    s = v.get("start") if v else None
    i, snip = -1, ""
    if isinstance(s, int) and 0 <= s < len(text):
        e = v.get("end") if isinstance(v.get("end"), int) else s + 1
        snip = text[s:max(e, s + 1)]
        # vị trí trong bản đã che ≈ độ dài bản che của phần trước (±40)
        i = masked.find(snip, max(0, len(_mask_pii(text[:s])) - 40))
        if i < 0:
            i = masked.find(snip)
    piece = (masked[max(0, i - 60):i + len(snip) + 60] if i >= 0
             else masked[:EXCERPT * 2])
    return safe(" ".join(piece.split()))[:EXCERPT]


def scan_row(row: dict, cfg: dict) -> dict:
    """1 bài → {codes, severity S1|S2|None, kind content|hosting, guardrail,
    excerpt}. THUẦN (không DB) — lệch bản duyệt cần DB, thêm ở `ingest`.
    LUÔN chạy `check_publish`; dấu hiệu trang mặc định hosting chỉ xét kênh
    `web` và chỉ thành mục hạ tầng khi KHÔNG có vi phạm nội dung — có vi
    phạm thì đi nhánh nội dung (S1/S2, Pháp chế) + nối code hosting."""
    text = row["text"]
    g = guardrail.check_publish(
        text, channel=row["channel"], content_type=row["content_type"],
        sku=row.get("sku"), is_ai=row["is_ai"],
        is_sponsored=row["is_sponsored"])
    viols = g.get("violations", [])
    folded = unicodedata.normalize("NFC", text).casefold()
    marker = row["channel"] == "web" and any(
        m in folded for m in cfg["hosting_default_markers"])
    if marker and not viols:
        return {"codes": [HOSTING], "severity": "S2", "kind": "hosting",
                "guardrail": dict(g, hosting_marker=True),
                "excerpt": _excerpt(text, None)}
    codes = list(dict.fromkeys(v["code"] for v in viols))
    posted = row.get("posted_on")
    if row.get("draft_id") is None and (posted is None
                                        or posted >= cfg["quy_trinh_duyet_tu"]):
        codes.append(THIEU)    # không rõ ngày = coi như bài mới (fail-closed)
    if marker:
        codes.append(HOSTING)
    crit = [v for v in viols if v.get("severity") == "critical"]
    sev = "S1" if crit else ("S2" if codes else None)
    return {"codes": codes, "severity": sev, "kind": "content",
            "guardrail": dict(g, hosting_marker=True) if marker else g,
            "excerpt": _excerpt(text, (crit or viols or [None])[0])}


# ------------------------------------------------------------------ DB
_SAME_COLS = ("text_sha256", "channel", "content_type", "is_ai",
              "is_sponsored", "sku", "draft_id", "posted_on", "codes",
              "severity")
_POST_COLS = ("id", "url", "channel", "content_type", "codes", "severity",
              "first_detected_at", "due_at", "queue_id", "alert_id",
              "text_sha256")


def _post(conn, post_id) -> dict | None:
    r = conn.execute(f"select {', '.join(_POST_COLS)} from channel_posts"
                     " where id = %s and closed_at is null"
                     " and severity is not null", (post_id,)).fetchone()
    return dict(zip(_POST_COLS, r)) if r else None


def _payload(p: dict) -> str:
    return "\n".join([
        (f"Lệnh rà kênh PC-A4 — bài #{p['id']} trên kênh {p['channel']}"
         f" (loại {p['content_type']})"),
        f"Mã nội dung (sha256 12 ký tự đầu): {p['text_sha256'][:12]}",
        f"Mức: {p['severity']} — mã vi phạm: {', '.join(p['codes'])}",
        (f"Phát hiện: {vn(p['first_detected_at'])} — hạn xử lý:"
         f" {vn(p['due_at'])} giờ VN (24 giờ đồng hồ thật, gồm T7/CN/lễ Tết)"),
        ("Thao tác GỠ/ẨN/SỬA do người được ủy quyền thực hiện trên kênh —"
         " agent không gỡ/sửa."),
        ("Duyệt mục này = Pháp chế xác nhận lệnh gỡ/sửa; vi phạm chỉ đóng khi"
         " bản xuất lại đã sạch hoặc người ghi nhận đã gỡ (python -m"
         " agents.ra_kenh --mark-removed <url> --by <tên>).")])


def _link(conn, post_id, dcfg: dict, stats: dict) -> None:
    """Đợt mở chưa có mục hàng duyệt / cảnh báo đỏ (S1) → tạo + gắn id.
    Chạy lại sau sự cố giữa chừng: tìm mục đã tạo theo object_id trước."""
    p = _post(conn, post_id)
    if p is None:
        return
    hosting = p["codes"] == [HOSTING]
    block, otype = (("data_platform", "hosting_fix") if hosting
                    else ("legal_hr", "channel_takedown"))
    if p["queue_id"] is None:
        oid = f"channel_post:{p['id']}"
        r = conn.execute("select id from approval_queue where object_type = %s"
                         " and object_id = %s order by id limit 1",
                         (otype, oid)).fetchone()
        if r:
            qid = r[0]
        else:
            what = ("Sửa trang mặc định hosting" if hosting
                    else f"Gỡ/sửa bài {p['severity']} {p['channel']}")
            qid = director.submit(conn, block, otype, oid,
                                  f"{what}: {_mask_pii(p['url'])}"[:300],
                                  _payload(p), AGENT, cfg=dcfg[block])
            stats["tickets"] += 1
        with conn.transaction():
            conn.execute("update channel_posts set queue_id = %s"
                         " where id = %s", (qid, p["id"]))
        conn.commit()
    if p["severity"] == "S1" and p["alert_id"] is None:
        r = conn.execute("select id from red_alerts where source_agent = %s"
                         " and detail->>'post_id' = %s order by id limit 1",
                         (AGENT, str(p["id"]))).fetchone()
        if r is None:
            red_alert.raise_alert(
                conn, AGENT, f"S1 {p['channel']}: {p['url']}",
                {"post_id": p["id"], "codes": p["codes"],
                 "due_at": p["due_at"].isoformat()})
            stats["alerts"] += 1
            r = conn.execute("select id from red_alerts where source_agent"
                             " = %s and detail->>'post_id' = %s order by id"
                             " limit 1", (AGENT, str(p["id"]))).fetchone()
        with conn.transaction():
            conn.execute("update channel_posts set alert_id = %s"
                         " where id = %s", (r[0], p["id"]))
        conn.commit()


def ingest(conn, rows: list[dict], cfg: dict, *, by: str,
           now: datetime) -> dict:
    """Nạp snapshot + mở/kế thừa/đóng đợt vi phạm → thống kê. Mỗi bài:
    snapshot trong 1 transaction + commit, rồi gắn mục hàng duyệt/cảnh báo
    (2 module đó tự commit)."""
    err = by_error(by)
    if err:
        raise ValueError(err)
    now = _aware(now)
    dcfg = {b: director.load_config(b) for b in ("legal_hr", "data_platform")}
    scans = [scan_row(r, cfg) for r in rows]
    if any("config" in s["codes"] for s in scans):
        raise ValueError("guardrail cấu hình hỏng — không nạp (fail-closed)")
    st = {"rows": len(rows), "new": 0, "skip": 0, "S1": 0, "S2": 0,
          "closed": 0, "tickets": 0, "alerts": 0, "items": []}
    for r, s in zip(rows, scans):
        codes, sev = list(s["codes"]), s["severity"]
        if (r["draft_id"] is not None and s["kind"] == "content"
                and not store.verify_publish(conn, r["draft_id"], r["text"])):
            codes.append(LECH)
            sev = sev or "S2"
        last = conn.execute(
            f"select id, close_reason, {', '.join(_SAME_COLS)} from"
            " channel_posts where url = %s order by id desc limit 1",
            (r["url"],)).fetchone()
        # Bỏ qua CHỈ khi cùng text + cùng cột bài + cùng kết quả rà: luật
        # guardrail/golden/bản duyệt đổi thì cùng text vẫn phải rà lại.
        if last and last[1] != "da_go" and tuple(last[2:]) == (
                r["sha"], r["channel"], r["content_type"], r["is_ai"],
                r["is_sponsored"], r["sku"], r["draft_id"], r["posted_on"],
                codes, sev):
            st["skip"] += 1
            _link(conn, last[0], dcfg, st)
            continue
        hosting = codes == [HOSTING]
        reason = None
        with conn.transaction():
            open_ = conn.execute(
                "select id, first_detected_at, due_at, queue_id, alert_id,"
                " codes from channel_posts where url = %s and closed_at is"
                " null and severity is not null order by id", (r["url"],)
            ).fetchall()
            was_hosting = bool(open_) and open_[-1][5] == [HOSTING]
            if sev and open_ and was_hosting == hosting:
                fdt, due, qid, aid = open_[-1][1:5]   # cùng loại → kế thừa
                reason = "thay_ban_moi"
            elif sev:
                fdt, due, qid, aid = now, now + SLA, None, None
            else:
                fdt = due = qid = aid = None
            if open_ and reason is None:
                # sạch, hoặc đổi loại: vấn đề loại cũ đã hết → da_sua; trang
                # mặc định vẫn còn nhưng nay kèm vi phạm nội dung → gộp vào
                # đợt nội dung mới (code hosting vẫn trong codes).
                reason = ("thay_ban_moi" if was_hosting and HOSTING in codes
                          else "da_sua")
            pid = conn.execute(
                "insert into channel_posts (url, channel, content_type,"
                " posted_on, is_ai, is_sponsored, sku, draft_id, text,"
                " text_sha256, guardrail, codes, severity, first_detected_at,"
                " due_at, queue_id, alert_id, imported_by, scanned_at)"
                " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
                " %s, %s, %s, %s, %s, %s) returning id",
                (r["url"], r["channel"], r["content_type"], r["posted_on"],
                 r["is_ai"], r["is_sponsored"], r["sku"], r["draft_id"],
                 r["text"], r["sha"], Jsonb(s["guardrail"]),
                 codes, sev, fdt, due, qid, aid, by.strip(), now)
            ).fetchone()[0]
            if open_:
                ids = [o[0] for o in open_]
                conn.execute(
                    "update channel_posts set closed_at = %s, close_reason"
                    " = %s, closed_by = %s where id = any(%s)",
                    (now, reason, by.strip(), ids))
                if reason == "da_sua":   # đối xứng mark_removed: ts do DB ép
                    conn.execute(
                        "insert into agent_action_log (actor, action,"
                        " object_type, object_id, detail) values (%s, %s, %s,"
                        " %s, %s)", (by.strip(), "channel_post_fixed",
                                     "channel_post", str(ids[0]),
                                     Jsonb({"ids": ids, "snapshot": pid})))
        conn.commit()
        st["new"] += 1
        if reason == "da_sua":
            st["closed"] += 1
        if sev:
            st[sev] += 1
            _link(conn, pid, dcfg, st)
        st["items"].append({"id": pid, "url": r["url"], "channel":
                            r["channel"], "severity": sev, "codes": codes,
                            "due_at": due, "excerpt": s["excerpt"],
                            "closed": reason == "da_sua"})
    return st


def mark_removed(conn, url: str, by: str, now: datetime) -> tuple[bool, str]:
    """NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt mở của URL (`da_go`) + 1 dòng
    `agent_action_log` (`channel_post_removed`, hash chain) cùng transaction."""
    err = by_error(by)
    if err:
        return False, err
    now = _aware(now)
    with conn.transaction():
        ids = conn.execute(
            "update channel_posts set closed_at = %s, close_reason = 'da_go',"
            " closed_by = %s where url = %s and closed_at is null and"
            " severity is not null returning id",
            (now, by.strip(), (url or "").strip())).fetchall()
        if ids:
            conn.execute(
                "insert into agent_action_log (actor, action, object_type,"
                " object_id, detail) values (%s, %s, %s, %s, %s)",
                (by.strip(), "channel_post_removed", "channel_post",
                 str(ids[0][0]), Jsonb({"ids": [i[0] for i in ids]})))
    conn.commit()
    if not ids:
        return False, "URL không có đợt vi phạm đang mở"
    return True, f"đã ghi nhận gỡ — đóng {len(ids)} dòng (da_go)"


# ------------------------------------------------------------------ báo cáo
def collect_report(conn, now: datetime, days: int) -> dict:
    """CHỈ SELECT. → dict cho `render_report`."""
    from agents import xnqc  # import muộn: xnqc import module này

    now = _aware(now)
    since = now - timedelta(days=days)
    cfg = load_config()
    dossiers = xnqc.list_dossiers(conn)
    tpbvsk = xnqc.tpbvsk_skus()
    sync_pending = conn.execute(
        "select count(*) from approval_queue where object_type ="
        " 'golden_xnqc_sync' and status = 'pending'").fetchone()[0]
    cols = ("id", "url", "channel", "codes", "severity", "first_detected_at",
            "due_at", "queue_id", "queue_status", "guardrail")
    open_ = [dict(zip(cols, r)) for r in conn.execute(
        "select distinct on (p.url) p.id, p.url, p.channel, p.codes,"
        " p.severity, p.first_detected_at, p.due_at, p.queue_id, q.status,"
        " p.guardrail from channel_posts p left join approval_queue q on"
        " q.id = p.queue_id where p.closed_at is null and p.severity is not"
        " null order by p.url, p.id desc").fetchall()]
    closed = conn.execute(
        "select id, url, close_reason, closed_at, due_at from channel_posts"
        " where close_reason in ('da_sua', 'da_go') and closed_at > %s and"
        " closed_at <= %s order by closed_at, id", (since, now)).fetchall()
    detected = conn.execute(
        "select distinct on (url) url, codes, first_detected_at from"
        " channel_posts where codes && %s and first_detected_at > %s and"
        " first_detected_at <= %s order by url, id desc",
        ([LECH, THIEU], since, now)).fetchall()
    return {"now": now, "days": days, "dossiers": dossiers,
            "reminders": xnqc.reminders(dossiers, tpbvsk, cfg,
                                        now.astimezone(VN_TZ).date()),
            "sync_pending": sync_pending,
            "sync_notes": xnqc.sync_notes(conn, now.astimezone(VN_TZ).date()),
            "open": sorted(open_, key=lambda d: (d["severity"], d["due_at"],
                                                 d["url"])),
            "closed": [dict(zip(("id", "url", "reason", "closed_at",
                                 "due_at"), c)) for c in closed],
            "detected": [{"url": u, "codes": c, "first_detected_at": f}
                         for u, c, f in detected]}


def _hours(td: timedelta) -> str:
    return f"{abs(td.total_seconds()) / 3600:.1f} giờ"


def _open_line(d: dict, now: datetime) -> str:
    left = d["due_at"] - now
    when = (f"QUÁ {_hours(left)}" if now > d["due_at"]
            else f"còn {_hours(left)}")
    q = (f"mục #{d['queue_id']} {d['queue_status'] or '?'}"
         if d["queue_id"] else "chưa có mục hàng duyệt")
    return (f"- [{d['severity']}] {_mask_pii(safe(d['url']))} ({d['channel']})"
            f" — {', '.join(d['codes'])} — phát hiện"
            f" {vn(d['first_detected_at'])}, hạn {vn(d['due_at'])} ({when})"
            f" — {q}")


def render_report(stats: dict, now: datetime) -> str:
    """THUẦN. Không chép đoạn vi phạm — chỉ url/mã/hạn."""
    from agents import xnqc

    now = _aware(now)
    open_ = stats["open"]
    over = [d for d in open_ if now > d["due_at"]]
    s1 = [d for d in open_ if d["severity"] == "S1"]
    L = [f"# Báo cáo Pháp chế tuần — {vn(now)} (giờ VN, {stats['days']} ngày)",
         "",
         ("> Agent chỉ phát hiện + đề xuất — gỡ/sửa do người; kết quả quét"
          " CHƯA được Pháp chế xác nhận."), ""]
    if over or s1:
        L += [(f"**CẢNH BÁO**: {len(over)} vi phạm QUÁ 24H, {len(s1)} S1"
               " đang mở."), ""]
    L += ["## 1. Hồ sơ XNQC theo trạng thái", ""]
    counts = {s: 0 for s in xnqc.STATUSES}
    for d in stats["dossiers"]:
        counts[d["status"]] = counts.get(d["status"], 0) + 1
    L.append(" · ".join(f"{s}: {n}" for s, n in counts.items()))
    for d in stats["dossiers"]:
        L.append(f"- #{d['id']} {d['sku_key']} {d['loai_ho_so']}"
                 f" [{d['status']}] số giấy {safe(d['so_giay'] or '—')},"
                 f" nộp {d['ngay_nop'] or '—'}, cấp {d['ngay_cap'] or '—'},"
                 f" hết hạn {d['ngay_het_han'] or '—'}")
    L += ["", "Nhắc mốc:"] + [f"- {m}" for m in stats["reminders"] or
                              ["(không có)"]]
    L += [("Đề xuất đồng bộ golden (golden_xnqc_sync) đang chờ duyệt:"
           f" {stats['sync_pending']}")]
    L += [f"- {m}" for m in stats.get("sync_notes", [])]
    L += ["",
          (f"## 2. Vi phạm đang mở theo URL — S1 {len(s1)}, S2"
           f" {len(open_) - len(s1)}"), ""]
    L += [_open_line(d, now) for d in open_] or ["(không có)"]
    L += ["", f"### QUÁ 24H — {len(over)}"]
    L += [_open_line(d, now) for d in over] or ["(không có)"]
    closed = stats["closed"]
    ontime = sum(1 for c in closed if c["closed_at"] <= c["due_at"])
    by_reason: dict = {}
    for c in closed:
        by_reason[c["reason"]] = by_reason.get(c["reason"], 0) + 1
    L += ["", (f"## 3. Đã đóng trong {stats['days']} ngày — {len(closed)}"
               f" (đúng hạn {ontime}, trễ {len(closed) - ontime})"),
          " · ".join(f"{k}: {v}" for k, v in sorted(by_reason.items()))
          or "(không có)", "",
          "## 4. Lệch / thiếu bản duyệt", ""]
    for code in (LECH, THIEU):
        o = [d for d in open_ if code in d["codes"]]
        n = [d for d in stats["detected"] if code in d["codes"]]
        L.append(f"- {code}: đang mở {len(o)}, phát hiện trong kỳ {len(n)}")
        L += [f"  - {_mask_pii(safe(d['url']))}" for d in o]
    host = [d for d in open_ if HOSTING in d["codes"]]
    L += ["", f"## 5. Mục hạ tầng (trang mặc định hosting) — {len(host)}"]
    L += [_open_line(d, now) for d in host] or ["(không có)"]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ CLI
def _print_plan(rows, scans) -> None:
    for r, s in zip(rows, scans):
        if not s["severity"]:
            print(f"[sạch] dòng {r['line']} {_mask_pii(safe(r['url']))}")
            continue
        kind = ("hosting_fix (data_platform)" if s["kind"] == "hosting"
                else "channel_takedown (legal_hr)")
        alert = " + red_alert" if s["severity"] == "S1" else ""
        print(f"[{s['severity']}] dòng {r['line']} {_mask_pii(safe(r['url']))} —"
              f" {', '.join(s['codes'])} → ticket {kind}{alert}")
        print(f"    trích: {s['excerpt']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ra_kenh",
        description="PC-A4 rà bài đang đăng trên kênh sở hữu (file xuất tay)"
                    " → ticket gỡ/sửa 24h. Agent KHÔNG gỡ/sửa bài.")
    ap.add_argument("--file", help="CSV xuất tay (url,kenh,is_ai,text[,"
                    "loai_noi_dung,ngay_dang,draft_id,sku,is_sponsored])")
    ap.add_argument("--mark-removed", metavar="URL",
                    help="NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt (da_go)")
    ap.add_argument("--report", action="store_true",
                    help="báo cáo Pháp chế tuần → data/reports/")
    ap.add_argument("--by", help="tên NGƯỜI thực hiện (không agent:/system:)")
    ap.add_argument("--now", help="thời điểm ISO CHỈ cho --report/--dry-run"
                    " (thao tác ghi dùng giờ thật); thiếu múi giờ = giờ VN"
                    " (+07:00); mặc định bây giờ")
    ap.add_argument("--days", type=int, default=7, help="kỳ báo cáo 1..366")
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ đọc file + rà, KHÔNG connect DB")
    a = ap.parse_args(argv)
    n_ops = sum([a.file is not None, a.mark_removed is not None, a.report])
    if n_ops != 1:
        ap.error("chọn đúng 1 thao tác: --file | --mark-removed | --report")
    if a.dry_run and a.file is None:
        ap.error("--dry-run chỉ đi với --file")
    if a.now is not None and not (a.report or a.dry_run):
        # lùi giờ ghi → closed_at trước hạn = "đúng hạn" giả trong báo cáo
        ap.error("--now chỉ đi với --report/--dry-run — thao tác ghi dùng"
                 " giờ thật")
    try:
        now = parse_now(a.now) if a.now else _now()
    except ValueError:
        ap.error("--now sai định dạng ISO")
    if not 1 <= a.days <= 366:
        ap.error("--days phải 1..366")
    if not a.report:
        err = by_error(a.by)
        if err:
            ap.error(err)
    try:
        cfg = load_config()
    except ValueError as e:
        print(f"[err] cấu hình phap_che.json: {e}")
        return 2
    rows = scans = None
    if a.file is not None:
        try:
            rows = read_export(a.file, cfg)
        except ExportError as e:
            print(f"[err] file xuất tay không hợp lệ — 0 dòng nạp ({e}):")
            for m in e.errors[:20]:
                print(f"  - {m}")
            return 1
        except ValueError as e:
            print(f"[err] cấu hình guardrail: {e}")
            return 2
        scans = [scan_row(r, cfg) for r in rows]
        if any("config" in s["codes"] for s in scans):
            print("[err] guardrail cấu hình hỏng — không rà (fail-closed)")
            return 2
        if a.dry_run:
            print(f"[dry-run] {len(rows)} bài — KHÔNG connect DB; chưa kiểm"
                  " lệch bản duyệt — cần DB")
            _print_plan(rows, scans)
            return 0
    conn = connect()
    if conn is None:
        print("[err] DB không truy cập được")
        return 2
    try:
        if a.mark_removed is not None:
            ok, msg = mark_removed(conn, a.mark_removed, a.by, now)
            print(("[ok] " if ok else "[err] ") + msg)
            return 0 if ok else 1
        if a.report:
            stats = collect_report(conn, now, a.days)
            text = render_report(stats, now)
            name = f"phap-che-tuan-{now.astimezone(VN_TZ):%Y-%m-%d}.md"
            path = write_report(text, REPORTS_DIR, name)
            print(text)
            print(f"[ok] đã ghi data/reports/{path.name}")
            return 0
        st = ingest(conn, rows, cfg, by=a.by, now=now)
    except (psycopg.Error, ValueError) as e:
        conn.rollback()
        print(f"[err] {type(e).__name__}: {safe(_mask_pii(str(e)))[:200]}")
        return 2
    finally:
        conn.close()
    print(f"[ok] {st['rows']} dòng — mới {st['new']}, bỏ qua {st['skip']}"
          f" (trùng bản mới nhất) — S1 {st['S1']}, S2 {st['S2']}, đã sạch"
          f" {st['closed']} — ticket mới {st['tickets']}, red_alert mới"
          f" {st['alerts']}")
    for it in st["items"]:
        if it["severity"]:
            print(f"[{it['severity']}] #{it['id']} {it['channel']}"
                  f" {_mask_pii(safe(it['url']))} — {', '.join(it['codes'])} — hạn"
                  f" {vn(it['due_at'])}")
            print(f"    trích: {it['excerpt']}")
        elif it["closed"]:
            print(f"[sạch] #{it['id']} {_mask_pii(safe(it['url']))} — đóng da_sua")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
