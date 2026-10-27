"""v4.3 PC-A4 (WP05) — rà bài ĐANG ĐĂNG trên kênh SỞ HỮU + ticket gỡ/sửa 24h
+ báo cáo Pháp chế tuần.

Luồng: Quản lý MXH xuất tay danh sách bài (CSV: link, kênh, text, ngày...)
→ `read_export` kiểm TOÀN file trước khi connect → `scan_row` chạy
`guardrail.check_publish` theo kênh → `ingest` lưu snapshot vào
`channel_posts`, đối chiếu bản đã duyệt (`pipelines.store.verify_publish`),
mở 1 mục hàng duyệt (`director.submit`) cho mỗi "đợt vi phạm" của URL với
hạn 24 giờ ĐỒNG HỒ THẬT (gồm T7/CN/Tết — plan §9), S1 → `red_alerts`.

Ranh giới (Agent CHỈ phát hiện + đề xuất):
  - KHÔNG gỡ/sửa/ẩn bài trên kênh, KHÔNG gọi API kênh ngoài một đường ĐỌC
    bài Fanpage của `--scan-auto` (r16, `connectors.fanpage`).
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
  python -m agents.ra_kenh --partner-file <csv> --by "<tên người>" [--dry-run]
    (v14.5 marketing-04.2 — bài KOC/đại lý; xem khối "v14.5 đối tác")
`--now` CHỈ cho `--report`/`--dry-run` (thao tác ghi dùng giờ thật — chống
lùi `closed_at` làm giả "đúng hạn"); thiếu múi giờ → hiểu là giờ VN
(+07:00). Exit 0 ok (có vi phạm vẫn 0 — rà là báo, không chặn) · 1 file
không hợp lệ / mark-removed không có đợt mở · 2 usage / cấu hình hỏng / DB
không truy cập được.
"""

import argparse
import csv
import hashlib
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
from pipelines import auth, director, guardrail, red_alert, store
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


HIDDEN = "(ẩn: trượt guardrail)"


def page_safe(s: str, alt: str = HIDDEN) -> str:
    """Chuỗi từ DB/cấu hình chép vào trang TGĐ/bản tin (đi qua guardrail
    toàn trang ở `ceo_report.finalize`): guardrail gập dấu nên chữ TRẦN như
    slug URL `...-chua-...`/`thuoc`, mã `CHUA-...` bị coi là từ cấm → cả
    trang trượt. Chuỗi tự nó trượt guardrail → thay `alt`."""
    return s if guardrail.check(s).get("ok") is True else alt


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
    if row.get("require_draft", True) and row.get("draft_id") is None and (
            posted is None
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


# r16 cold-check FIX1: nguồn tự thu (web/Fanpage) không biết nhãn AI, tài trợ,
# SKU, bản duyệt, loại, ngày do NGƯỜI khai ở CSV `--file` → kế thừa từ snapshot
# NGƯỜI nạp gần nhất cùng URL; nếu không, so `_SAME_COLS` lệch → snapshot mới
# giả (đóng `da_sua`, reset hạn 24h, nhân ticket) khi hai đường chạy xen kẽ.
# Cold-check vòng 2: `draft_id` chỉ kiểm lại trên chữ tự thu khi chữ đó CÙNG
# biểu diễn với chữ người khai — cùng sha, hoặc nguồn trả đúng chữ bài
# (`text_is_post`: Fanpage `message`). Web tự thu = tiêu đề + thân (khác
# biểu diễn, `verify_publish` so byte) → không kiểm lại, MANG phán quyết duyệt
# (`lech_ban_duyet`/`thieu_ban_duyet`) của snapshot người.
_HUMAN_COLS = ("content_type", "posted_on", "is_ai", "is_sponsored", "sku",
               "draft_id")
_APPROVAL_CODES = (THIEU, LECH)


def _inherit_human(conn, row: dict) -> dict:
    h = conn.execute(
        f"select {', '.join(_HUMAN_COLS)}, text_sha256, codes from"
        " channel_posts where url = %s"
        r" and imported_by !~* '^\s*(agent|system)\s*:' order by id desc"
        " limit 1", (row["url"],)).fetchone()
    if not h:
        return row
    meta = dict(zip(_HUMAN_COLS, h[:-2]))
    if row["sha"] == h[-2] or row.get("text_is_post"):
        return {**row, **meta}
    return {**row, **meta, "draft_id": None, "require_draft": False,
            "approval_codes": [c for c in _APPROVAL_CODES if c in h[-1]]}


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
                # Tiêu đề thành tiêu đề/thân email (v13.7) — DF-45: thư không
                # chứa URL; URL tra trong channel_posts theo post_id.
                conn, AGENT, f"S1 {p['channel']}: bài #{p['id']}",
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
           now: datetime, auto: bool = False) -> dict:
    """Nạp snapshot + mở/kế thừa/đóng đợt vi phạm → thống kê. Mỗi bài:
    snapshot trong 1 transaction + commit, rồi gắn mục hàng duyệt/cảnh báo
    (2 module đó tự commit). `auto` (C12): nguồn tự thu — người nạp là
    `AUTO_BY` (agent), không giả tên người."""
    if auto:
        err = None if by == AUTO_BY else "auto chỉ với AUTO_BY"
    else:
        err = by_error(by)
    if err:
        raise ValueError(err)
    now = _aware(now)
    dcfg = {b: director.load_config(b) for b in ("legal_hr", "data_platform")}
    if auto:
        rows = [_inherit_human(conn, r) for r in rows]
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
        for code in r.get("approval_codes", ()) if s["kind"] == "content" \
                else ():
            if code not in codes:
                codes.append(code)
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


# ------------------------------------------------- C12 nguồn tự thu
# Đợt hợp đồng C12 (legal_hr-04, PL01 Pháp chế "quét web, Fanpage, listing;
# mở yêu cầu gỡ bài vi phạm trong 24 giờ"):
#   - web: tệp crawl `data/{articles,news,products}.jsonl` do `crawler.collect`
#     thu từ trang CÔNG KHAI của Bên B (robots + ≥1s/host). Tệp cũ hơn
#     `WEB_MAX_AGE_DAYS` (GIẢ ĐỊNH 7) → KHÔNG quét nguồn đó (dữ liệu cũ không
#     được "đóng" vi phạm), ghi chú rõ;
#   - listing: snapshot `listing` MỚI NHẤT mỗi sàn đã nạp (`market_rows`):
#     tiêu đề + mô tả nếu file có; KHÔNG cộng `thieu_ban_duyet` (đối chiếu
#     bản duyệt listing là việc của ceo_audit — tránh mở trùng);
#   - Fanpage (r16): bài do CHÍNH Page đăng qua Graph API chỉ đọc
#     (`connectors.fanpage`, tài liệu chính thức v26.0) — chưa cấu hình
#     `FANPAGE_PAGE_ID`/`FANPAGE_READ_TOKEN` → ghi chú, vẫn `--file` CSV; lỗi
#     nguồn → ghi chú + exit 1 (web/listing vẫn nạp); tính năng TẮT → 0
#     request, exit 2. Không rõ ngày đăng → `posted_on` None (coi như bài mới).
AUTO_BY = AGENT
FEATURE = "legal_hr-04"
WEB_FILES = ("articles", "news", "products")
WEB_MAX_AGE_DAYS = 7


def web_rows(now: datetime, data_dir=None) -> tuple[list[dict], list[str]]:
    d = Path(data_dir) if data_dir is not None else ROOT / "data"
    rows, notes = [], []
    for name in WEB_FILES:
        f = d / f"{name}.jsonl"
        if not f.is_file():
            notes.append(f"web/{name}: chưa có tệp crawl — chưa quét")
            continue
        age = now - datetime.fromtimestamp(f.stat().st_mtime, VN_TZ)
        if age > timedelta(days=WEB_MAX_AGE_DAYS):
            notes.append(f"web/{name}: dữ liệu crawl cũ {age.days} ngày "
                         f"(> {WEB_MAX_AGE_DAYS}) — KHÔNG quét, chạy "
                         "crawler.collect")
            continue
        for n, ln in enumerate(f.read_bytes().split(b"\n"), 1):
            if not ln.strip():
                continue
            try:
                o = json.loads(ln.decode("utf-8", errors="replace"))
            except ValueError:
                notes.append(f"web/{name}: dòng {n} hỏng — bỏ")
                continue
            if not isinstance(o, dict):
                continue
            url = str(o.get("url") or "")
            text = " ".join(str(o.get(k) or "") for k in
                            ("title", "name", "body", "description")).strip()
            if (not url.startswith(("http://", "https://")) or not text
                    or len(url.encode()) > MAX_URL):
                continue
            pub = str(o.get("published_at") or "")[:10]
            text = text[:MAX_TEXT]
            rows.append({"line": n, "url": url, "channel": "web",
                         "content_type": "post",
                         "posted_on": (date.fromisoformat(pub)
                                       if _DATE_RE.fullmatch(pub) else None),
                         "is_ai": False, "is_sponsored": False, "sku": None,
                         "draft_id": None, "text": text,
                         "sha": store.content_sha256(text)})
    return rows, notes


def _fb_date(v) -> date | None:
    try:
        if isinstance(v, int) and not isinstance(v, bool):
            dt = datetime.fromtimestamp(v, VN_TZ)
        elif isinstance(v, str):
            dt = datetime.strptime(v, "%Y-%m-%dT%H:%M:%S%z")
        else:
            return None
    except (ValueError, OverflowError, OSError):
        return None
    return dt.astimezone(VN_TZ).date()


def fanpage_rows(conn) -> tuple[list[dict], list[str], int | None]:
    """r16: bài Fanpage → (rows, ghi chú, rc). rc None = đọc được hoặc chưa
    cấu hình; 1 = lỗi nguồn; 2 = cấu hình hỏng / tính năng TẮT (0 request)."""
    from connectors import fanpage
    from ingest.market_api import ConfigError
    from pipelines import rollout
    try:
        cfg = fanpage.config()
    except ConfigError as e:
        return [], [f"fanpage: {e} — chưa quét"], 2
    if cfg is None:
        return [], [(f"fanpage: chưa cấu hình {fanpage.ENV_PAGE}/"
                     f"{fanpage.ENV_TOKEN} — chưa quét (dùng --file CSV)")
                    ], None
    if why := rollout.blocked(conn, "đọc bài Fanpage qua Graph API", FEATURE):
        return [], [f"fanpage: {why}"], rollout.EXIT_BLOCKED
    try:
        posts = fanpage.fetch_posts(cfg)
    except fanpage.FanpageError as e:
        return [], [f"{e} — chưa quét"], 1
    rows, notes, seen, bad = [], [], set(), 0
    for p in posts:
        url = fanpage.post_url(p.get("permalink_url"))
        text = p.get("message")
        # Cùng biểu diễn với CSV `read_export` (bản duyệt so byte): chỉ đổi
        # \r\n → \n, KHÔNG strip/cắt; strip chỉ để kiểm rỗng; > MAX_TEXT →
        # bỏ (CSV cũng từ chối dòng đó).
        text = text.replace("\r\n", "\n") if isinstance(text, str) else None
        if (url is None or len(url.encode()) > MAX_URL or text is None
                or not text.strip() or len(text) > MAX_TEXT):
            bad += 1
            continue
        if url in seen:
            continue
        seen.add(url)
        rows.append({"line": None, "url": url, "channel": "facebook",
                     "content_type": "post",
                     "posted_on": _fb_date(p.get("created_time")),
                     "is_ai": False, "is_sponsored": False, "sku": None,
                     "draft_id": None, "text": text, "text_is_post": True,
                     "sha": store.content_sha256(text)})
    if bad:
        notes.append(f"fanpage: bỏ {bad} bài không có chữ, dài quá {MAX_TEXT}"
                     " ký tự hoặc permalink không hợp lệ")
    return rows, notes, None


def listing_rows(conn) -> list[dict]:
    rows = []
    for ch, iid, ssku, title, desc in conn.execute(
            "select r.channel, r.item_id, r.seller_sku, r.title,"
            " r.raw ->> 'description' from market_rows r join (select"
            " distinct on (channel) id from market_snapshots where"
            " export_kind = 'listing' order by channel, imported_at desc,"
            " id desc) s on s.id = r.snapshot_id order by r.channel,"
            " r.row_no").fetchall():
        key = iid or ssku
        text = "\n".join(x for x in (title, desc) if x)[:MAX_TEXT]
        if not key or not text:
            continue
        rows.append({"line": None, "url": f"{ch}:listing:{key}",
                     "channel": ch, "content_type": "listing",
                     "posted_on": None, "is_ai": False,
                     "is_sponsored": False, "sku": None, "draft_id": None,
                     "require_draft": False, "text": text,
                     "sha": store.content_sha256(text)})
    return rows


def mark_removed(conn, url: str, by: str, now: datetime) -> tuple[bool, str]:
    """NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt mở của URL (`da_go`) + 1 dòng
    `agent_action_log` (`channel_post_removed`, hash chain) cùng transaction.

    v15 fix P10.2: ghi qua function `channel_post_mark_removed_human`
    (SECURITY DEFINER — login người `app_human` không có UPDATE
    `channel_posts`; DB kiểm danh tính theo login + khối legal_hr; giờ đóng =
    đồng hồ DB khi login không phải owner). DB từ chối danh tính →
    `auth.HumanDenied`."""
    err = by_error(by)
    if err:
        return False, err
    now = _aware(now)
    try:
        with conn.transaction():
            n = auth.call_human(
                conn, "select channel_post_mark_removed_human(%s, %s, %s)",
                ((url or "").strip(), now, by.strip()), by=by,
                block="legal_hr", action="close_violation",
                object_type="channel_post",
                object_id=hashlib.sha256((url or "").strip().encode())
                .hexdigest()[:12]).fetchone()[0]
    except BaseException:
        conn.rollback()
        raise
    conn.commit()
    if not n:
        return False, "URL không có đợt vi phạm đang mở"
    return True, f"đã ghi nhận gỡ — đóng {n} dòng (da_go)"


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


# ------------------------------------------------------------------ v14.5 đối tác
# marketing-04.2 (PL01 Marketing — KOC và đại lý affiliate: "kiểm tra bài
# đăng của đối tác"). Nguồn = file xuất tay bài KOC/đại lý ĐÃ đăng (người
# MXH/marketing gom). Tách hẳn khỏi luồng kênh SỞ HỮU ở trên (bảng riêng
# `partner_post_scans`, loại việc riêng `marketing/partner_post_review`):
#   - Kiểm TOÀN file trước khi connect; chỉ nhận MÃ đối tác (không tên/
#     handle/SĐT — cột lạ bị từ chối); mã phải có trong sổ KOC
#     (`data/koc_sample.json`) hoặc sổ đại lý (`dealers`) — lạ → theo
#     chính sách `data/partner_policy.json` (v15 P12.5, GĐ Marketing chọn):
#     "tu_choi_file" = cả file lỗi, 0 dòng (MẶC ĐỊNH an toàn khi CHƯA CHỌN /
#     cấu hình lỗi — in rõ); "ghi_vi_pham" = bài của mã lạ vẫn rà guardrail
#     và ghi thành vi phạm `doi_tac_chua_dang_ky` (≥ S2, không kit, không
#     cờ mẫu) cùng các bài hợp lệ khác trong file.
#   - Rà theo kênh: `guardrail.check_publish(content_type="koc",
#     is_sponsored=True, is_ai=False)` (bài do đối tác viết, là quảng cáo).
#   - Đối chiếu bộ tài liệu chuẩn ĐÃ duyệt của đúng đối tác: kit KOC
#     (`marketing/koc_brief` approved, payload khớp hash duyệt —
#     `verify_publish` của DB, không qua cổng DÙNG rollout vì đây là SO, không
#     phát hành) hoặc kit affiliate đại lý (mã `active` + mục
#     `sales/affiliate_program` approved). Không có → `thieu_bo_tai_lieu`;
#     SKU ngoài kit → `sku_ngoai_bo_tai_lieu`; câu công dụng khớp claim
#     nhưng không nằm trong "Điểm được nói" của kit → `ngoai_bo_tai_lieu`
#     (kit đại lý không liệt kê claim → chỉ xét SKU).
#   - Đợt theo (mã đối tác, URL): rà khác lần trước (text/mã vi phạm) → 1
#     dòng sổ; vi phạm → 1 mục hàng duyệt (đợt mới, kể cả bài quay lại bản
#     cũ sau một lần sạch); trùng lần trước → bỏ qua (idempotent).
#   - Không lưu text/URL đầy đủ (URL có thể chứa handle cá nhân) — sha256 +
#     tên miền NỀN TẢNG (bỏ subdomain, `_site`); payload không chép đoạn vi
#     phạm. Agent KHÔNG liên hệ đối tác,
#     không gỡ/sửa bài; GĐ marketing yêu cầu đối tác theo hợp đồng.
PARTNER_AGENT = "agent:mkt_doi_tac"
PARTNER_FEATURE = "marketing-04.2"
OT_PARTNER = "partner_post_review"
PARTNER_REQUIRED = ("ma_doi_tac", "url", "kenh", "text", "ngay_dang")
PARTNER_OPTIONAL = ("sku",)
THIEU_KIT = "thieu_bo_tai_lieu"
NGOAI_KIT = "ngoai_bo_tai_lieu"
SKU_NGOAI_KIT = "sku_ngoai_bo_tai_lieu"
_PARTNER_RE = re.compile(r"[A-Z0-9][A-Z0-9_-]{1,39}")
_KOC_SAMPLE_RE = re.compile(r"KOC-MAU-\d{2}")
PARTNER_POLICY_FILE = ROOT / "data" / "partner_policy.json"
UNKNOWN_POLICIES = ("tu_choi_file", "ghi_vi_pham")
UNKNOWN_PARTNER = "doi_tac_chua_dang_ky"
_KIT_HEAD_RE = re.compile(r"# Kit KOC (KOC-MAU-\d{2}) — `([^`\n]+)` × ")
_AFF_SKU_RE = re.compile(r"^### Bài #\d+ — `([^`\n]+)`$", re.MULTILINE)


_SLD = frozenset(("com", "net", "org", "edu", "gov", "co", "ac"))


def _sha(s: str) -> str:
    return store.content_sha256(s)


def _site(host: str) -> str:
    """Tên miền NỀN TẢNG (bỏ subdomain): `chilan.blogspot.com` →
    `blogspot.com`, `www.tiktok.com` → `tiktok.com`, `abc.com.vn` →
    `abc.com.vn` — subdomain/đường dẫn có thể là handle cá nhân KOC."""
    parts = host.lower().rstrip(".").split(".")
    n = 3 if (len(parts) >= 3 and len(parts[-1]) == 2
              and parts[-2] in _SLD) else 2
    return ".".join(parts[-n:])


def read_partner_export(path) -> list[dict]:
    """Đọc + kiểm TOÀN file bài đối tác TRƯỚC khi connect. Lỗi → ExportError
    (chỉ 'dòng N cột X: lý do' — KHÔNG kèm giá trị ô)."""
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
    if sorted(h for h, k in Counter(head).items() if h and k > 1):
        errs.append("dòng 1: header trùng")
    stray = [h for h in head if h and h not in PARTNER_REQUIRED
             + PARTNER_OPTIONAL]
    if stray:
        errs.append(f"dòng 1: {len(stray)} cột lạ — chỉ nhận"
                    f" {list(PARTNER_REQUIRED + PARTNER_OPTIONAL)} (MÃ đối"
                    " tác, không tên/handle/liên hệ cá nhân)")
    miss = [c for c in PARTNER_REQUIRED if c not in head]
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

        for col, v in c.items():
            if "\x00" in v:
                bad(col, "chứa ký tự NUL")
        code = c["ma_doi_tac"].strip()
        if not _PARTNER_RE.fullmatch(code):
            bad("ma_doi_tac", "cần MÃ đối tác (A-Z 0-9 _ -, 2..40 ký tự) —"
                " không tên/handle")
        url = c["url"].strip()
        too_long = len(url.encode("utf-8")) > MAX_URL
        try:
            parts = urlsplit(url) if url and not too_long else None
            host = (parts.hostname or "") if parts else ""
        except ValueError:
            parts, host = None, ""
        if too_long:
            bad("url", f"dài quá {MAX_URL} byte UTF-8")
        elif (not parts or parts.scheme not in ("http", "https") or not host
                or len(host) > 253
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
        posted = None
        try:
            posted = _iso_date(c["ngay_dang"], "ngay_dang")
        except ValueError:
            bad("ngay_dang", "cần ngày YYYY-MM-DD hợp lệ")
        sku = (c.get("sku") or "").strip() or None
        if sku is not None and sku not in rules["golden"]:
            bad("sku", "SKU không có trong golden")
        text = c["text"].replace("\r\n", "\n")
        if not text.strip():
            bad("text", "rỗng")
        elif len(text) > MAX_TEXT:
            bad("text", f"dài quá {MAX_TEXT} ký tự")
        out.append({"line": n, "partner": code, "url": url,
                    "url_sha": _sha(url), "host": _site(host),
                    "channel": ch, "posted_on": posted, "sku": sku,
                    "text": text, "sha": _sha(text)})
    if errs:
        raise ExportError(errs)
    return out


def _kit_claims(payload: str) -> set:
    """Các dòng '- …' của mục "## Điểm được nói" trong kit KOC đã duyệt."""
    out, inside = set(), False
    for line in (payload or "").splitlines():
        if line.startswith("## "):
            inside = line.strip() == "## Điểm được nói"
        elif inside and line.startswith("- "):
            out.add(line[2:].strip())
    return out


def _verified(conn, otype: str, oid: str, payload: str) -> bool:
    """Payload = đúng bản đã duyệt (hash `approvals`) — SO, không phát hành
    nên không đi qua cổng DÙNG của rollout (`approval_queue.verify`)."""
    r = conn.execute("select verify_publish(%s, %s, %s)",
                     (otype, oid, payload)).fetchone()
    return bool(r and r[0] is True)


def partner_kits(conn) -> dict:
    """CHỈ SELECT → {mã đối tác: {skus, claims (None = kit không liệt kê
    claim), refs}} từ bộ tài liệu chuẩn ĐÃ duyệt."""
    kits: dict = {}
    for qid, oid, payload in conn.execute(
            "select id, object_id, payload from approval_queue where block ="
            " 'marketing' and object_type = 'koc_brief' and status ="
            " 'approved' order by id").fetchall():
        m = _KIT_HEAD_RE.match(payload or "")
        if m is None or not _verified(conn, "koc_brief", oid, payload):
            continue
        k = kits.setdefault(m.group(1), {"skus": set(), "claims": set(),
                                         "refs": []})
        k["skus"].add(m.group(2))
        if k["claims"] is not None:
            k["claims"] |= _kit_claims(payload)
        k["refs"].append(f"koc_brief#{qid}")
    for dealer, qid, oid, payload in conn.execute(
            "select c.dealer_code, q.id, q.object_id, q.payload from"
            " affiliate_codes c join approval_queue q on q.id = c.queue_id"
            " where c.status = 'active' and q.object_type ="
            " 'affiliate_program' and q.status = 'approved' order by c.id"
            ).fetchall():
        if not _verified(conn, "affiliate_program", oid, payload):
            continue
        k = kits.setdefault(dealer, {"skus": set(), "claims": None,
                                     "refs": []})
        k["claims"] = None          # kit đại lý không liệt kê claim
        k["skus"] |= set(_AFF_SKU_RE.findall(payload))
        k["refs"].append(f"affiliate_program#{qid}")
    return kits


def partner_verdict(g: dict, kit: dict | None, sku: str | None) -> dict:
    """THUẦN: kết quả guardrail + kit đã duyệt (None = chưa có) → {codes,
    severity}. S1 = có vi phạm critical; còn mã khác → S2."""
    viols = [v for v in g.get("violations", []) if isinstance(v, dict)]
    codes = list(dict.fromkeys(v.get("code") for v in viols))
    if kit is None:
        codes.append(THIEU_KIT)
    else:
        if sku is not None and kit["skus"] and sku not in kit["skus"]:
            codes.append(SKU_NGOAI_KIT)
        if kit["claims"] is not None:
            said = {m.get("claim") for m in g.get("matched_claims") or []
                    if isinstance(m, dict) and m.get("claim")}
            if said - kit["claims"]:
                codes.append(NGOAI_KIT)
    crit = any(v.get("severity") == "critical" for v in viols)
    return {"codes": codes, "severity": "S1" if crit else
            ("S2" if codes else None)}


def partner_scan(row: dict, kit: dict | None) -> dict:
    g = guardrail.check_publish(
        row["text"], channel=row["channel"], content_type="koc",
        sku=row["sku"], is_ai=False, is_sponsored=True)
    return partner_verdict(g, kit, row["sku"])


class UnknownPartner(ValueError):
    """Mã đối tác lạ + chính sách tu_choi_file — 0 dòng nạp."""

    def __init__(self, msg: str, warn: str | None):
        super().__init__(msg)
        self.warn = warn


def unknown_partner_policy(path=None) -> tuple[str, str | None]:
    """→ (chính sách áp dụng, cảnh báo | None). CHƯA CHỌN / file thiếu-hỏng /
    giá trị lạ / thiếu người chọn → "tu_choi_file" (hành vi an toàn v14.5)
    kèm cảnh báo rõ — không tự chọn thay GĐ Marketing."""
    p = Path(path or PARTNER_POLICY_FILE)
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return UNKNOWN_POLICIES[0], (f"không có {p.name} — dùng mặc định an "
                                     "toàn tu_choi_file")
    except (OSError, ValueError) as e:
        return UNKNOWN_POLICIES[0], (f"{p.name} hỏng ({type(e).__name__}) —"
                                     " dùng mặc định an toàn tu_choi_file")
    e = doc.get("ma_doi_tac_la") if isinstance(doc, dict) else None
    pol = e.get("chinh_sach") if isinstance(e, dict) else None
    if pol is None:
        return UNKNOWN_POLICIES[0], ("chính sách mã đối tác lạ CHƯA CHỌN (GĐ"
                                     f" Marketing — {p.name}) — đang dùng "
                                     "mặc định an toàn tu_choi_file")
    by = " ".join(str(e.get("chon_boi") or "").split())
    ref = " ".join(str(e.get("can_cu") or "").split())
    if (pol not in UNKNOWN_POLICIES or by_error(by) is not None
            or not ref or len(ref) > 200):
        return UNKNOWN_POLICIES[0], (f"{p.name}: chinh_sach lạ hoặc thiếu "
                                     "chon_boi (người)/can_cu — dùng mặc định"
                                     " an toàn tu_choi_file")
    return pol, None


def partner_registry(conn) -> dict:
    """{mã: is_sample} — KOC (sổ MẪU) + đại lý (`dealers`, nguồn
    dealer_regions.json = MẪU). Sổ KOC hỏng → ValueError (fail-closed)."""
    from agents.mkt_koc import KocConfigError, load_kocs
    try:
        reg = {k["code"]: True for k in load_kocs()}
    except KocConfigError as e:
        raise ValueError(f"sổ KOC: {e}") from None
    for code, src in conn.execute("select code, source from dealers"):
        reg.setdefault(code, src == "dealer_regions.json")
    return reg


def _partner_payload(r: dict, v: dict, kit: dict | None) -> str:
    kit_s = (", ".join(kit["refs"]) if kit else
             "CHƯA có bộ tài liệu chuẩn đã duyệt cho đối tác này")
    return "\n".join([
        (f"Rà bài đối tác (marketing-04.2) — đối tác {r['partner']}, kênh"
         f" {r['channel']}, tên miền {r['host']}, ngày đăng"
         f" {r['posted_on']:%d/%m/%Y}"),
        (f"Mã URL (sha256 12 ký tự đầu): {r['url_sha'][:12]} · mã nội dung:"
         f" {r['sha'][:12]} (sổ partner_post_scans)"),
        f"Mức: {v['severity']} — mã: {', '.join(v['codes'])}",
        f"Bộ tài liệu chuẩn đối chiếu: {kit_s}",
        ("Việc cần làm: GĐ marketing yêu cầu đối tác sửa/gỡ bài theo hợp"
         " đồng KOC/đại lý (URL đầy đủ tra trong file xuất tay theo mã URL)."
         " Agent KHÔNG liên hệ đối tác, KHÔNG gỡ/sửa bài; payload không chép"
         " đoạn vi phạm.")])


def ingest_partner(conn, rows: list[dict], *, by: str, now: datetime,
                   dcfg: dict | None = None, policy_path=None) -> dict:
    """Nạp lần rà bài đối tác → thống kê. Mã đối tác lạ → theo
    `unknown_partner_policy`: tu_choi_file (mặc định/chưa chọn) ValueError
    (0 dòng) | ghi_vi_pham (ghi vi phạm `doi_tac_chua_dang_ky`). Tính năng
    tắt → RolloutBlocked (0 dòng)."""
    from pipelines import rollout
    err = by_error(by)
    if err:
        raise ValueError(err)
    # Vá review v15 (P10.1): danh tính login ↔ `--by` kiểm ở DB TRƯỚC mọi ghi
    # — `director.submit` tự commit mục hàng duyệt, kiểm muộn (lúc ghi sổ)
    # thì `--by` giả vẫn để lại mục `partner_post_review`.
    auth.call_human(conn, "select human_actor(%s, null)", (by.strip(),),
                    by=by, block=None, action="partner_scan",
                    object_type="partner_post_scan", object_id="*")
    now = _aware(now)
    rollout.check_generate(conn, PARTNER_FEATURE, "rà bài đối tác")
    dcfg = dcfg or director.load_config("marketing")
    reg = partner_registry(conn)
    unknown = sorted({r["partner"] for r in rows} - set(reg))
    policy, warn = unknown_partner_policy(policy_path)
    if unknown and policy == "tu_choi_file":
        conn.rollback()
        raise UnknownPartner(f"{len(unknown)} mã đối tác không có trong sổ"
                             " KOC/đại lý — không nạp (chính sách "
                             "tu_choi_file)", warn)
    kits = partner_kits(conn)
    verdicts = []
    for r in rows:
        v = partner_scan(r, kits.get(r["partner"]))
        if r["partner"] not in reg:     # ghi_vi_pham: mã chưa đăng ký
            v = {"codes": [*v["codes"], UNKNOWN_PARTNER],
                 "severity": v["severity"] or "S2"}
        verdicts.append(v)
    if any("config" in v["codes"] for v in verdicts):
        raise ValueError("guardrail cấu hình hỏng — không nạp (fail-closed)")
    conn.commit()     # đóng tx đọc
    st = {"rows": len(rows), "new": 0, "skip": 0, "S1": 0, "S2": 0,
          "clean": 0, "tickets": 0, "items": [], "policy": policy,
          "policy_warn": warn, "unknown": unknown}
    for r, v in zip(rows, verdicts):
        last = conn.execute(
            "select id, text_sha256, codes from partner_post_scans where"
            " partner_code = %s and url_sha256 = %s order by id desc limit 1",
            (r["partner"], r["url_sha"])).fetchone()
        if last and last[1] == r["sha"] and list(last[2]) == v["codes"]:
            st["skip"] += 1
            continue
        kit = kits.get(r["partner"])
        sample = reg.get(r["partner"], False)
        qid = None
        if v["severity"]:
            # oid xác định theo trạng thái TRƯỚC khi ghi → chạy lại sau sự
            # cố giữa submit và insert tìm lại đúng mục, không nhân bản.
            oid = (f"partner_post:{r['partner']}:{r['url_sha'][:16]}:"
                   f"{last[0] if last else 0}")
            row = conn.execute("select id from approval_queue where"
                               " object_type = %s and object_id = %s",
                               (OT_PARTNER, oid)).fetchone()
            conn.commit()
            if row:
                qid = row[0]
            else:
                qid = director.submit(
                    conn, "marketing", OT_PARTNER, oid,
                    (f"Bài đối tác {r['partner']} {v['severity']} trên"
                     f" {r['channel']} ({r['host']})")[:300],
                    _partner_payload(r, v, kit), PARTNER_AGENT,
                    cfg=dcfg, sample=sample)
                st["tickets"] += 1
        # v15.4 (P10.1): ghi sổ qua function SECURITY DEFINER (danh tính
        # theo login Postgres — nhập liệu, không khối; login người không có
        # INSERT trực tiếp `partner_post_scans`).
        with conn.transaction():
            sid = auth.call_human(
                conn, "select record_partner_scan_human(%s, %s, %s, %s, %s,"
                " %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (r["partner"], r["url_sha"], r["host"], r["channel"],
                 r["posted_on"], r["sku"], r["sha"], v["codes"],
                 v["severity"], ", ".join(kit["refs"])[:200] if kit else None,
                 qid, sample, now, by.strip()),
                by=by, block=None, action="partner_scan",
                object_type="partner_post_scan",
                object_id=r["partner"]).fetchone()[0]
        conn.commit()
        st["new"] += 1
        if v["severity"]:
            st[v["severity"]] += 1
        else:
            st["clean"] += 1
        st["items"].append({"id": sid, "line": r["line"],
                            "partner": r["partner"], "host": r["host"],
                            "url_sha": r["url_sha"], "channel": r["channel"],
                            "severity": v["severity"], "codes": v["codes"],
                            "queue_id": qid})
    return st


def _partner_main(a) -> int:
    from pipelines.rollout import RolloutBlocked
    try:
        rows = read_partner_export(a.partner_file)
    except ExportError as e:
        print(f"[err] file bài đối tác không hợp lệ — 0 dòng nạp ({e}):")
        for m in e.errors[:20]:
            print(f"  - {m}")
        return 1
    except ValueError as e:
        print(f"[err] cấu hình guardrail: {e}")
        return 2
    if a.dry_run:
        print(f"[dry-run] {len(rows)} bài đối tác — KHÔNG connect DB; chưa"
              " đối chiếu sổ đối tác/bộ tài liệu đã duyệt — cần DB")
        for r in rows:
            v = partner_scan(r, None)
            codes = [c for c in v["codes"] if c != THIEU_KIT]
            print(f"[{'vi phạm' if codes else 'guardrail sạch'}] dòng"
                  f" {r['line']} {r['partner']} {r['channel']} {r['host']}"
                  f" — {', '.join(codes) or '—'}")
        return 0
    conn = connect()
    if conn is None:
        print("[err] DB không truy cập được")
        return 2
    try:
        st = ingest_partner(conn, rows, by=a.by, now=_now())
    except RolloutBlocked as e:
        conn.rollback()
        print(f"[rollout] {e}")
        return 2
    except ValueError as e:
        conn.rollback()
        print(f"[err] {safe(_mask_pii(str(e)))[:200]}")
        if getattr(e, "warn", None):
            print(f"[warn] {e.warn}")
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] {type(e).__name__}: {safe(_mask_pii(str(e)))[:200]}")
        return 2
    finally:
        conn.close()
    if st["policy_warn"]:
        print(f"[warn] {st['policy_warn']}")
    if st["unknown"]:
        print(f"[warn] {len(st['unknown'])} mã đối tác chưa đăng ký — ghi vi"
              f" phạm {UNKNOWN_PARTNER} (chính sách ghi_vi_pham)")
    print(f"[ok] {st['rows']} bài đối tác — mới {st['new']}, bỏ qua"
          f" {st['skip']} (trùng lần rà trước) — S1 {st['S1']}, S2 {st['S2']},"
          f" sạch {st['clean']} — mục hàng duyệt mới {st['tickets']}")
    for it in st["items"]:
        if it["severity"]:
            print(f"[{it['severity']}] dòng {it['line']} {it['partner']}"
                  f" {it['channel']} {it['host']} url#{it['url_sha'][:12]} —"
                  f" {', '.join(it['codes'])} — mục #{it['queue_id']}")
    return 0


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


def _scan_auto_main(dry_run: bool) -> int:
    try:
        cfg = load_config()
    except ValueError as e:
        print(f"[err] cấu hình phap_che.json: {e}")
        return 2
    now = _now()
    rows, notes = web_rows(now)
    conn = None if dry_run else connect()
    if not dry_run and conn is None:
        print("[err] DB không truy cập được")
        return 2
    try:
        # Fanpage TRƯỚC câu SELECT đầu: cổng rollout tự commit → conn không
        # giữ transaction mở trong lúc chờ mạng.
        fb, fb_notes, fb_rc = fanpage_rows(conn)
        notes += fb_notes
        if conn is not None:
            rows += listing_rows(conn)
        rows += fb
        for n in notes:
            print(f"[note] {n}")
        if dry_run:
            scans = [scan_row(r, cfg) for r in rows]
            print(f"[dry-run] {len(rows)} bài web/Fanpage (listing cần DB) —"
                  " KHÔNG ghi")
            print("[note] dry-run không DB: không kế thừa snapshot người, không"
                  " kiểm bản duyệt — mức S2 thieu_ban_duyet dưới đây có thể"
                  " khác lượt thật")
            _print_plan(rows, scans)
            return fb_rc or 0
        st = ingest(conn, rows, cfg, by=AUTO_BY, now=now, auto=True)
    except (psycopg.Error, ValueError) as e:
        if conn is not None:
            conn.rollback()
        print(f"[err] {type(e).__name__}: {safe(_mask_pii(str(e)))[:200]}")
        return 2
    finally:
        if conn is not None:
            conn.close()
    print(f"[scan-auto] {st['rows']} mục: mới {st['new']}, trùng {st['skip']},"
          f" S1 {st['S1']}, S2 {st['S2']}, đóng {st['closed']}, ticket "
          f"{st['tickets']} — Fanpage: {len(fb)} bài")
    return max(fb_rc or 0, 1 if any("cũ" in n for n in notes) else 0)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ra_kenh",
        description="PC-A4 rà bài đang đăng trên kênh sở hữu (file xuất tay)"
                    " → ticket gỡ/sửa 24h. Agent KHÔNG gỡ/sửa bài.")
    ap.add_argument("--file", help="CSV xuất tay (url,kenh,is_ai,text[,"
                    "loai_noi_dung,ngay_dang,draft_id,sku,is_sponsored])")
    ap.add_argument("--partner-file", metavar="CSV",
                    help="v14.5 bài KOC/đại lý ĐÃ đăng (ma_doi_tac,url,kenh,"
                    "text,ngay_dang[,sku]) → guardrail + bộ tài liệu chuẩn đã"
                    " duyệt → hàng duyệt GĐ marketing")
    ap.add_argument("--mark-removed", metavar="URL",
                    help="NGƯỜI ghi nhận đã gỡ/ẩn bài → đóng đợt (da_go)")
    ap.add_argument("--report", action="store_true",
                    help="báo cáo Pháp chế tuần → data/reports/")
    ap.add_argument("--scan-auto", action="store_true",
                    help="C12: quét nguồn TỰ THU (web từ crawl công khai, "
                         "listing từ snapshot sàn) → ticket 24h (job)")
    ap.add_argument("--by", help="tên NGƯỜI thực hiện (không agent:/system:)")
    ap.add_argument("--now", help="thời điểm ISO CHỈ cho --report/--dry-run"
                    " (thao tác ghi dùng giờ thật); thiếu múi giờ = giờ VN"
                    " (+07:00); mặc định bây giờ")
    ap.add_argument("--days", type=int, default=7, help="kỳ báo cáo 1..366")
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ đọc file + rà, KHÔNG connect DB")
    a = ap.parse_args(argv)
    n_ops = sum([a.file is not None, a.mark_removed is not None, a.report,
                 a.partner_file is not None, a.scan_auto])
    if n_ops != 1:
        ap.error("chọn đúng 1 thao tác: --file | --partner-file |"
                 " --mark-removed | --report | --scan-auto")
    if a.scan_auto:
        if a.by is not None or a.now is not None:
            ap.error("--scan-auto không nhận --by/--now (người nạp = agent,"
                     " giờ thật)")
        return _scan_auto_main(a.dry_run)
    if a.dry_run and a.file is None and a.partner_file is None:
        ap.error("--dry-run chỉ đi với --file/--partner-file")
    if a.partner_file is not None and a.now is not None:
        ap.error("--now không đi với --partner-file (ghi dùng giờ thật)")
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
    if a.partner_file is not None:
        return _partner_main(a)
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
            # v15.4 (P10.2): ghi nhận đã gỡ = đóng đợt vi phạm (dừng theo dõi
            # SLA gỡ bài) = QUYẾT ĐỊNH của Pháp chế được Bên B ủy quyền (khối
            # legal_hr, auth.cli_gate). object_id = sha256 URL (không lưu URL).
            why = auth.cli_gate(
                conn, a.by, "legal_hr", "close_violation", "channel_post",
                hashlib.sha256(a.mark_removed.strip().encode()).hexdigest()[:12])
            if why:
                conn.rollback()
                print(f"[err] {why} — không ghi")
                return 1
            try:
                ok, msg = mark_removed(conn, a.mark_removed, a.by, now)
            except auth.HumanDenied as e:
                print(f"[err] {e} — không ghi")
                return 1
            print(("[ok] " if ok else "[err] ") + msg)
            return 0 if ok else 1
        if a.report:
            stats = collect_report(conn, now, a.days)
            text = render_report(stats, now)
            name = f"phap-che-tuan-{now.astimezone(VN_TZ):%Y-%m-%d}.md"
            # P8.4: tổng hợp vi phạm kênh từ bài đã đăng (không đường mẫu
            # trong báo cáo tuần — bài đối tác MẪU không vào thống kê này).
            path = write_report(text, REPORTS_DIR, name, sample=False)
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
