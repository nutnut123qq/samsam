"""v7.2 nạp file intel NHẬP TAY (WP09 — Competitor Tracker, Trend, Social
Listening P1) — `python -m ingest.intel_import`.

Tầng P1-Shadow: KHÔNG request mạng nào (không cào sàn/MXH, không gọi API
Trends không chính thức), không trả lời comment/inbox (đó là A1), không
đăng, không gửi ai, không gọi LLM. Mọi dữ liệu vào bằng FILE do người
(Quản lý MXH) xuất/ghi tay.

Contract CLI (đúng 1 op, khác → exit 2):
  --competitor F                   CSV/XLSX giá đối thủ ghi tay
  --trend F [--seed KW]            Google Trends xuất tay (multiTimeline /
                                   relatedQueries — relatedQueries cần --seed)
  --social F --channel C           export comment/inbox kênh SỞ HỮU
                                   (C = fanpage | zalo_oa | tiktok)
  Thứ tự: argparse → bộ lọc rượu + config (`data/trend_keywords.json` /
  `data/social_rules.json`; lỗi → exit 1) → đọc + kiểm TOÀN file (lỗi →
  `[err]` ≤30 dòng + tổng, exit 1, KHÔNG connect, 0 dòng) → muối
  `INTEL_HASH_SALT` (social, ≥16 ký tự; thiếu → exit 1) → connect
  (connect_timeout=10) → `file_sha256` đã nạp → `[skip]` exit 0 → 1
  transaction ghi `intel_imports` + dòng → `conn.commit()` tường minh.
  Lỗi chỉ nêu số dòng + tên cột, KHÔNG in giá trị ô.

Schema 3 loại file (template GIẢ ĐỊNH — tên cột thật chưa xác minh):
  competitor  bắt buộc doi_thu, kenh (shopee|tiktok|lazada|tiki|web|khac),
              ten_san_pham, gia_vnd, ngay_ghi (YYYY-MM-DD), nguon (URL
              http(s) hoặc "ảnh chụp <tên file>" — kênh sàn bắt buộc 1 trong
              2); tùy chọn sku_tuong_duong (phải có trong `sku_master`),
              gia_km_vnd (< gia_vnd), khuyen_mai, rating (0–5, 1 số lẻ),
              so_danh_gia, ghi_chu (đọc rồi bỏ). URL sàn chỉ LƯU làm dẫn
              chứng — module không có hàm gửi request.
  trend       multiTimeline: dòng "Category: ..." + header `Week,<kw>:
              (<vùng>),...` (chỉ chuỗi TUẦN, ≤5 từ khóa, mọi từ khóa có
              trong config, PHẢI có từ khóa neo, 1 vùng/file; "<1" → 0).
              relatedQueries: section TOP / RISING, dòng `query,value`; query
              nhắc rượu → cờ `ruou`.
  social      bắt buộc thoi_gian (ISO, không múi giờ = giờ VN), noi_dung;
              tùy chọn loai (comment|inbox|review), ma_tin; cột định danh
              id_nguoi_dung (chỉ dùng trong hash dedup), ten_nguoi_dung, sdt,
              email, link_profile, avatar bị BỎ ngay khi đọc; cột lạ → lỗi
              (cột lạ có thể là PII). noi_dung che SĐT/email NGAY khi đọc;
              nhãn theo LUẬT (khen/che/hoi_gia/khieu_nai từ config +
              hoi_suc_khoe nhạy cảm + hoi_ruou); excerpt chỉ lưu khi
              `dpia_signed` true và tin không nhạy cảm.

Quyền sở hữu: ghi DUY NHẤT 5 bảng v7.2 (`intel_imports`,
`competitor_observations`, `trends_weekly`, `trends_related`,
`social_mentions`); CHỈ ĐỌC golden (`sku_master`, `price_list`) — không đổi
giá, không gợi ý "giá nên đặt"; không có đường sang bảng hàng duyệt nội
dung (cách ly như collector v7.0).
"""

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest.golden_store import CHANNELS as GOLDEN_CHANNELS
from ingest.market_csv import (
    MAX_FILE_BYTES,
    MAX_PRINT_ERRS,
    _clean,
    _nfc,
    _safe,
    _table,
    _TableError,
    _to_int,
)
from pipelines import kb_filter
from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import _kw_re, _strip_accents, is_health_question
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
KEYWORDS_FILE = ROOT / "data" / "trend_keywords.json"
RULES_FILE = ROOT / "data" / "social_rules.json"
VN_TZ = timezone(timedelta(hours=7))  # VN không DST

PRE_MAX = 1200          # cắt text ngoài TRƯỚC _mask_pii (chống DoS regex v1.4)
MAX_PRICE = 10**15
MAX_KW_PER_FILE = 5     # giới hạn so sánh của Google Trends
SALT_MIN = 16
MAX_HEADER = 200     # ký tự / ô header Google Trends

C_REQUIRED = ("doi_thu", "kenh", "ten_san_pham", "gia_vnd", "ngay_ghi", "nguon")
C_OPTIONAL = ("sku_tuong_duong", "gia_km_vnd", "khuyen_mai", "rating",
              "so_danh_gia", "ghi_chu")
C_CHANNELS = ("shopee", "tiktok", "lazada", "tiki", "web", "khac")
MARKETPLACES = ("shopee", "tiktok", "lazada", "tiki")

S_REQUIRED = ("thoi_gian", "noi_dung")
S_OPTIONAL = ("loai", "ma_tin", "id_nguoi_dung")
S_IDENTITY_DROP = ("ten_nguoi_dung", "sdt", "email", "link_profile", "avatar")
S_CHANNELS = ("fanpage", "zalo_oa", "tiktok")
S_KINDS = ("comment", "inbox", "review")
S_RULE_LABELS = ("khen", "che", "hoi_gia", "khieu_nai")

TREND_GROUPS = ("qua_tang", "sam", "gioi_tre")

_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_TS_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}"
                    r"(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:[0-9]{2})?")
# ô xlsx float 4.5 → "4.500000" (market_csv._cell) — nhận tới 6 số lẻ,
# rồi kiểm bằng Decimal: lượng hóa 0.1 không đổi giá trị.
_RATING_RE = re.compile(r"[0-5](?:[.,][0-9]{1,6})?")
_URL_RE = re.compile(r"https?://[^\s/]+\S*", re.IGNORECASE)
_TL_COL_RE = re.compile(r"(.+?): \((.+)\)")
_TL_VAL_RE = re.compile(r"[0-9]{1,3}")
_REL_VAL_RE = re.compile(r"[0-9]{1,3}|\+[0-9][0-9.,]{0,12}%|Breakout|Đột phá")
_WS_RE = re.compile(r"\s+")

# Social: câu hỏi CÔNG DỤNG sức khỏe — bộ lọc chung `is_health_question`
# chỉ bắt bệnh/thuốc/triệu chứng, sót "tác dụng gì / có bổ không / tốt cho
# ...". Lệch về phía nhạy cảm là an toàn (không lưu excerpt). Không dấu chỉ
# áp khi cả câu không dấu (cùng quy tắc gateway).
_SOC_HEALTH_RE = _kw_re([
    "công dụng", "tác dụng", "sức khỏe", "sức khoẻ", "bồi bổ", "bổ không",
    "bổ gì", "tốt cho"])
_SOC_HEALTH_ASCII_RE = _kw_re([
    "cong dung", "tac dung", "suc khoe", "boi bo", "bo khong", "tot cho"])
# 'giá' trong cụm KHÔNG hỏi giá ("đánh giá 5 sao", "giá trị", "định giá",
# "đáng giá") → xóa cụm trước khi xét nhãn hoi_gia (lớp lỗi intent_of v2.4).
_NOT_PRICE_RE = _kw_re([
    "đánh giá", "định giá", "giá trị", "đáng giá", "quý giá", "vô giá",
    "danh gia", "dinh gia", "gia tri", "dang gia"])


# ---------------------------------------------------------------- thuần


def _text(s, n: int) -> str:
    """Text từ file ngoài: cắt PRE_MAX (bỏ token dở ở mép — SĐT/email cắt
    đôi không lọt) → `_mask_pii` → bỏ ký tự điều khiển/vô hình → gom
    trắng → cắt n."""
    s = str(s or "")
    if len(s) > PRE_MAX:
        s = (s[:PRE_MAX].rsplit(None, 1) or [""])[0].rstrip("0123456789 .+-()@")
    s = _mask_pii(s)
    s = "".join(c if c.isprintable() else " " for c in s)
    return _WS_RE.sub(" ", s).strip()[:n]


def _kw(s: str) -> str:
    """Chuẩn hóa từ khóa để so: NFC + casefold + gom trắng."""
    return _WS_RE.sub(" ", unicodedata.normalize("NFC", s).casefold()).strip()


def _iso_date(s: str | None) -> date | None:
    if not s or not _DATE_RE.fullmatch(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _iso_ts(s: str | None) -> datetime | None:
    if not s or not _TS_RE.fullmatch(s):
        return None
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=VN_TZ)


def today_vn() -> date:
    return datetime.now(VN_TZ).date()


def _read_bytes(path: Path) -> tuple[bytes | None, str | None, list[str]]:
    """→ (data, sha256, errors). Đuôi .csv/.xlsx, ≤ MAX_FILE_BYTES, khác rỗng."""
    suffix = path.suffix.lower()
    if suffix not in (".csv", ".xlsx"):
        return None, None, [(f"đuôi '{_clean(suffix, 20)}' không hỗ trợ — "
                             "chỉ .csv / .xlsx")]
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None, None, [f"file > {MAX_FILE_BYTES // 2**20}MB — tách file"]
        data = path.read_bytes()
    except OSError as e:
        return None, None, [f"không đọc được file: {type(e).__name__}"]
    sha = hashlib.sha256(data).hexdigest()
    if not data or data.isspace():
        return None, sha, ["file rỗng"]
    return data, sha, []


def _records(table, required, optional=(), drop=()):
    """Header + dòng → (list[(row_no, {cột: ô})], errors). Cột `drop` đọc
    rồi bỏ NGAY (không vào record); cột lạ / trùng / thiếu bắt buộc → lỗi."""
    first = next(table, None)
    if first is None:
        return [], ["file rỗng"]
    _hdr_no, header = first
    header = [None if h is None else _nfc(h).casefold() for h in header]
    known = set(required) | set(optional)
    col_of, errs, seen = {}, [], set()
    for j, h in enumerate(header):
        if h is None:
            errs.append(f"header cột {j + 1} trống")
        elif h in seen:
            errs.append(f"header trùng: '{_safe(h)}'")
        else:
            seen.add(h)
            if h in known:
                col_of[h] = j
            elif h not in drop:
                errs.append(f"cột lạ '{_safe(h)}' (ngoài template)")
    missing = [c for c in required if c not in col_of]
    if missing:
        errs.append("thiếu cột bắt buộc: " + ", ".join(missing))
    if errs:
        return [], errs
    width, recs = len(header), []
    for row_no, cells in table:
        if any(c is not None for c in cells[width:]):
            errs.append(f"dòng {row_no}: thừa ô ngoài header")
            continue
        recs.append((row_no, {c: (cells[j] if j < len(cells) else None)
                              for c, j in col_of.items()}))
    if not recs and not errs:
        return [], ["file chỉ có header, không có dòng dữ liệu"]
    return recs, errs


def _parse_table(path: Path, required, optional=(), drop=()):
    """→ (records, errors, sha) — gói đọc file + `_records`."""
    path = Path(path)
    data, sha, errs = _read_bytes(path)
    if errs:
        return [], errs, sha
    try:
        recs, errs = _records(_table(data, path.suffix.lower()), required,
                              optional, drop)
    except _TableError as e:
        return [], [str(e)], sha
    return recs, errs, sha


# ---------- Competitor ----------


def read_competitor(path, today: date | None = None
                    ) -> tuple[list[dict], list[str], str | None]:
    """Hàm thuần (không DB): CSV đối thủ ghi tay → (rows, errors, sha).
    errors ≠ [] → rows = []. Lỗi chỉ nêu số dòng + tên cột."""
    recs, errs, sha = _parse_table(path, C_REQUIRED, C_OPTIONAL)
    if errs:
        return [], errs, sha
    limit = (today or today_vn()) + timedelta(days=1)
    rows = []
    for n, r in recs:
        bad = []
        comp = _text(r["doi_thu"], 200)
        name = _text(r["ten_san_pham"], 300)
        if not comp:
            bad.append("doi_thu")
        if not name:
            bad.append("ten_san_pham")
        kenh = _kw(r["kenh"] or "")
        if kenh not in C_CHANNELS:
            bad.append("kenh")
        price = _to_int(r["gia_vnd"], MAX_PRICE)
        if not price:
            bad.append("gia_vnd")
        promo = None
        if r.get("gia_km_vnd") is not None:
            promo = _to_int(r["gia_km_vnd"], MAX_PRICE)
            if not promo or (price and promo >= price):
                bad.append("gia_km_vnd")
        rating = None
        if r.get("rating") is not None:
            if _RATING_RE.fullmatch(r["rating"]):
                rating = Decimal(r["rating"].replace(",", "."))
                q = rating.quantize(Decimal("0.1"))
                rating = q if q == rating else None   # 4.55 → lỗi
            if rating is None or rating > 5:
                bad.append("rating")
        reviews = None
        if r.get("so_danh_gia") is not None:
            reviews = _to_int(r["so_danh_gia"], 2 * 10**9)
            if reviews is None:
                bad.append("so_danh_gia")
        nd = r["ngay_ghi"]
        if nd and nd.endswith(" 00:00:00"):   # ô ngày xlsx → datetime nửa đêm
            nd = nd[:-9]
        day = _iso_date(nd)
        if day is None or day > limit:
            bad.append("ngay_ghi")
        raw_src = r["nguon"] or ""
        src = _text(raw_src, 500)
        # kênh sàn: nguồn phải là link hoặc "ảnh chụp <tên file>"
        on_market = kenh in MARKETPLACES and not (
            _URL_RE.fullmatch(src) or _kw(src).startswith("ảnh chụp"))
        if not src or len(raw_src) > 500 or on_market:
            bad.append("nguon")
        if bad:
            errs += [f"dòng {n}: cột '{c}' không hợp lệ" for c in bad]
            continue
        rows.append({
            "row_no": n, "competitor": comp, "channel": kenh,
            "product_name": name,
            "sku_key": (_clean(r["sku_tuong_duong"], 100)
                        if r.get("sku_tuong_duong") else None),
            "price_vnd": price, "promo_price_vnd": promo,
            "promo_text": (_text(r["khuyen_mai"], 200) or None
                           if r.get("khuyen_mai") else None),
            "rating": rating, "review_count": reviews, "observed_on": day,
            "source_ref": src})
    if errs:
        return [], errs, sha
    return rows, [], sha


# ---------- Trend ----------


def load_trend_config(path=None) -> tuple[dict | None, list[str]]:
    """Đọc `trend_keywords.json` fail-closed → (cfg chuẩn hóa, errors)."""
    path = Path(path or KEYWORDS_FILE)
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, [f"{path.name}: không đọc được ({type(e).__name__})"]
    if not isinstance(raw, dict):
        return None, [f"{path.name}: gốc phải là object"]
    errs, kws = [], {}
    src = raw.get("keywords")
    if not isinstance(src, dict) or not src:
        errs.append("keywords: rỗng hoặc sai kiểu")
        src = {}
    for k, g in src.items():
        nk = _kw(k) if isinstance(k, str) else ""
        if not nk:
            errs.append("keywords: từ khóa rỗng")
        elif g not in TREND_GROUPS:
            errs.append(f"keywords.{_clean(nk, 40)}: nhóm lạ "
                        f"(chỉ {'|'.join(TREND_GROUPS)})")
        elif nk in kws:
            errs.append(f"keywords.{_clean(nk, 40)}: trùng")
        else:
            if g == "gioi_tre" and is_alcohol(nk):
                errs.append(f"keywords.{_clean(nk, 40)}: từ khóa rượu không "
                            "được thuộc nhóm gioi_tre")
            kws[nk] = g
    anchor = raw.get("anchor")
    anchor = _kw(anchor) if isinstance(anchor, str) else ""
    if not anchor or anchor not in kws:
        errs.append("anchor: thiếu hoặc không nằm trong keywords")
    spike = raw.get("spike")
    sp = {}
    if not isinstance(spike, dict):
        errs.append("spike: thiếu")
    else:
        for key, typ in (("window_weeks", int), ("ratio", (int, float)),
                         ("min_delta", (int, float))):
            v = spike.get(key)
            if isinstance(v, bool) or not isinstance(v, typ) or v <= 0:
                errs.append(f"spike.{key}: phải là số > 0")
            else:
                sp[key] = v
    if errs:
        return None, errs
    return {"anchor": anchor, "keywords": kws, "spike": sp}, []


def find_spikes(series, window: int, ratio: float, min_delta: float
                ) -> list[tuple]:
    """Hàm thuần: series = [(week, value)] sắp theo tuần của CÙNG (query_id,
    keyword, geo). Tuần có ≥ window tuần trước → m = trung vị window tuần
    liền trước; spike khi value ≥ ratio·m VÀ value − m ≥ min_delta (m = 0 →
    chỉ cần value ≥ min_delta). → [(week, value, m)]."""
    out = []
    for i in range(window, len(series)):
        m = statistics.median(v for _w, v in series[i - window:i])
        w, v = series[i]
        if (v >= min_delta) if m == 0 else (v >= ratio * m and v - m >= min_delta):
            out.append((w, v, m))
    return out


def read_trend(path, cfg: dict) -> tuple[str | None, list[dict], list[str],
                                         str | None]:
    """Hàm thuần: file Google Trends xuất tay → (kind, rows, errors, sha).
    kind = 'trend_timeline' | 'trend_related' | None (không nhận dạng)."""
    path = Path(path)
    data, sha, errs = _read_bytes(path)
    if errs:
        return None, [], errs, sha
    try:
        table = _table(data, path.suffix.lower())
        first = None
        for row_no, cells in table:
            if (len(cells) == 1 and cells[0]
                    and _kw(cells[0]).startswith(("category:", "danh mục:"))):
                continue
            first = (row_no, cells)
            break
        if first is None:
            return None, [], ["file rỗng"], sha
        c0 = _kw(first[1][0] or "")
        if c0 in ("week", "tuần"):
            return ("trend_timeline", *_timeline(first, table, cfg), sha)
        if c0 in ("day", "ngày", "month", "tháng"):
            return None, [], [(f"dòng {first[0]}: chỉ nhận chuỗi tuần (Week)"
                               " — xuất lại với khoảng thời gian 1–5 năm")], sha
        if c0 in ("top", "rising") and len(first[1]) == 1:
            return ("trend_related", *_related(first, table), sha)
    except _TableError as e:
        return None, [], [str(e)], sha
    return None, [], [("không nhận dạng được file Google Trends "
                       "(multiTimeline / relatedQueries)")], sha


def _timeline(first, table, cfg):
    hdr_no, hdr = first
    errs, kws, geos = [], [], set()
    if not 1 <= len(hdr) - 1 <= MAX_KW_PER_FILE:
        errs.append(f"dòng {hdr_no}: cần 1–{MAX_KW_PER_FILE} cột từ khóa")
    for j, h in enumerate(hdr[1:], 2):
        h = _nfc(h or "")
        # trần độ dài TRƯỚC regex: `(.+?): \((.+)\)` trên ô khổng lồ lặp
        # ": (" là O(n²) (gotcha DoS v1.4)
        m = _TL_COL_RE.fullmatch(h) if len(h) <= MAX_HEADER else None
        if not m:
            errs.append(f"header cột {j}: không đúng dạng '<từ khóa>: (<vùng>)'")
            continue
        k = _kw(m.group(1))
        if k not in cfg["keywords"]:
            errs.append(f"header cột {j}: từ khóa '{_safe(k, 40)}' không có "
                        "trong trend_keywords.json")
        elif k in kws:
            errs.append(f"header cột {j}: từ khóa trùng")
        kws.append(k)
        geos.add(_clean(_nfc(m.group(2)), 60))
    if len(geos) > 1:
        errs.append("file có nhiều vùng — mỗi file 1 vùng")
    if cfg["anchor"] not in kws:
        errs.append(f"thiếu neo '{cfg['anchor']}' — luôn xuất kèm từ khóa neo")
    if errs:
        return [], errs
    geo = geos.pop()
    rows, weeks = [], set()
    for row_no, cells in table:
        if len(cells) > len(hdr):
            errs.append(f"dòng {row_no}: thừa ô ngoài header")
            continue
        w = _iso_date(cells[0])
        if w is None:
            errs.append(f"dòng {row_no}: cột 'Week' không phải ngày YYYY-MM-DD")
            continue
        if w in weeks:
            errs.append(f"dòng {row_no}: tuần trùng")
            continue
        weeks.add(w)
        for j, k in enumerate(kws, 1):
            v = cells[j] if j < len(cells) else None
            val = 0 if v == "<1" else (int(v) if v and _TL_VAL_RE.fullmatch(v)
                                       else None)
            if val is None or val > 100:
                errs.append(f"dòng {row_no}: cột {j + 1} ({k}) không phải số "
                            "0–100")
                continue
            rows.append({"keyword": k, "geo": geo, "week": w, "value": val})
    if not weeks and not errs:
        errs.append("file chỉ có header, không có dòng dữ liệu")
    return ([], errs) if errs else (rows, [])


def _related(first, table):
    section = _kw(first[1][0])
    rows, errs = [], []
    for row_no, cells in table:
        if len(cells) == 1 and _kw(cells[0] or "") in ("top", "rising"):
            section = _kw(cells[0])
            continue
        if len(cells) != 2 or cells[0] is None or cells[1] is None:
            errs.append(f"dòng {row_no}: cần đúng 2 cột query,value")
            continue
        q = _text(cells[0], 200)
        if not q:
            errs.append(f"dòng {row_no}: cột query rỗng")
            continue
        if not _REL_VAL_RE.fullmatch(cells[1]):
            errs.append(f"dòng {row_no}: cột value không hợp lệ")
            continue
        rows.append({"section": section, "query": q, "value": cells[1],
                     "flags": ["ruou"] if is_alcohol(q) else []})
    if not rows and not errs:
        errs.append("file chỉ có tiêu đề section, không có dòng dữ liệu")
    return ([], errs) if errs else (rows, [])


# ---------- Social ----------


def load_social_rules(path=None) -> tuple[dict | None, list[str]]:
    """Đọc `social_rules.json` fail-closed → ({dpia_signed, labels: {nhãn:
    regex}}, errors)."""
    path = Path(path or RULES_FILE)
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, [f"{path.name}: không đọc được ({type(e).__name__})"]
    if not isinstance(raw, dict):
        return None, [f"{path.name}: gốc phải là object"]
    errs = []
    if not isinstance(raw.get("dpia_signed"), bool):
        errs.append("dpia_signed: phải là true/false")
    labels = raw.get("labels")
    pats = {}
    if not isinstance(labels, dict) or not labels:
        errs.append("labels: rỗng hoặc sai kiểu")
        labels = {}
    for lab, words in labels.items():
        if lab not in S_RULE_LABELS:
            errs.append(f"labels.{_clean(lab, 30)}: nhãn lạ "
                        f"(chỉ {'|'.join(S_RULE_LABELS)})")
            continue
        if (not isinstance(words, list) or not words
                or not all(isinstance(w, str) and w.strip() for w in words)):
            errs.append(f"labels.{lab}: 0 từ khóa hoặc từ khóa rỗng")
            continue
        ws = sorted({_kw(w) for w in words}, key=len, reverse=True)
        pats[lab] = re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, ws))
                               + r")(?!\w)")
    if errs:
        return None, errs
    return {"dpia_signed": raw["dpia_signed"], "labels": pats}, []


def classify_social(text: str, rules: dict) -> list[str]:
    """Nhãn theo LUẬT trên text ĐÃ che PII. 0 nhãn → ['khac']."""
    t = _kw(text)
    no_price = _NOT_PRICE_RE.sub(" ", t)
    labels = [lab for lab in S_RULE_LABELS
              if lab in rules["labels"] and rules["labels"][lab].search(
                  no_price if lab == "hoi_gia" else t)]
    if (is_health_question(text) or _SOC_HEALTH_RE.search(t)
            or (_strip_accents(t) == t and _SOC_HEALTH_ASCII_RE.search(t))):
        labels.append("hoi_suc_khoe")
    if is_alcohol(text):
        labels.append("hoi_ruou")
    return labels or ["khac"]


def msg_hash(salt: str, channel: str, key: str) -> str:
    """sha256 CÓ MUỐI — dedup giữa các file xuất chồng ngày mà không giữ
    ID/nội dung gốc."""
    return hashlib.sha256(f"{salt}|{channel}|{key}".encode()).hexdigest()


def read_social(path, channel: str, rules: dict, now: datetime | None = None
                ) -> tuple[list[dict], list[str], str | None]:
    """Hàm thuần: export comment/inbox kênh sở hữu → (rows, errors, sha).
    Cột định danh bỏ NGAY khi đọc; noi_dung che SĐT/email trước mọi bước
    sau. row['key'] = vật liệu hash dedup (chỉ trong RAM, không ghi DB)."""
    recs, errs, sha = _parse_table(path, S_REQUIRED, S_OPTIONAL,
                                   S_IDENTITY_DROP)
    if errs:
        return [], errs, sha
    limit = (now or datetime.now(VN_TZ)) + timedelta(days=1)
    rows = []
    for n, r in recs:
        bad = []
        ts = _iso_ts(r["thoi_gian"])
        if ts is None or ts > limit:
            bad.append("thoi_gian")
        kind = _kw(r.get("loai") or "comment")
        if kind not in S_KINDS:
            bad.append("loai")
        text = _text(r["noi_dung"], PRE_MAX)   # che NGAY khi đọc
        if not text:
            bad.append("noi_dung")
        if bad:
            errs += [f"dòng {n}: cột '{c}' không hợp lệ" for c in bad]
            continue
        labels = classify_social(text, rules)
        sensitive = "hoi_suc_khoe" in labels
        key = (f"id:{r['ma_tin']}" if r.get("ma_tin") else
               f"u:{r.get('id_nguoi_dung') or ''}|{r['thoi_gian']}|{text}")
        rows.append({
            "row_no": n, "kind": kind, "posted_at": ts, "key": key,
            "labels": labels, "sensitive": sensitive,
            "excerpt": (text[:200] if rules["dpia_signed"] is True
                        and not sensitive else None)})
    if errs:
        return [], errs, sha
    return rows, [], sha


# ---------------------------------------------------------------- DB


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def _new_import(conn, kind, channel, file_name, sha, n) -> int:
    return conn.execute(
        "insert into intel_imports (kind, channel, file_name, file_sha256,"
        " row_count) values (%s, %s, %s, %s, %s) returning id",
        (kind, channel, file_name, sha, n)).fetchone()[0]


def load_competitor(conn, rows, file_name, sha) -> tuple[int | None, list[str]]:
    """Kiểm SKU tương đương có trong golden TRƯỚC khi ghi (thiếu → errors,
    không ghi gì) rồi insert (không commit)."""
    keys = sorted({r["sku_key"] for r in rows if r["sku_key"]})
    have = ({k for (k,) in conn.execute(
        "select sku_key from sku_master where sku_key = any(%s)", (keys,))}
        if keys else set())
    errs = [f"dòng {r['row_no']}: sku_tuong_duong không có trong golden"
            for r in rows if r["sku_key"] and r["sku_key"] not in have]
    if errs:
        return None, errs
    iid = _new_import(conn, "competitor", None, file_name, sha, len(rows))
    for r in rows:
        conn.execute(
            "insert into competitor_observations (import_id, row_no,"
            " competitor, channel, product_name, sku_key, price_vnd,"
            " promo_price_vnd, promo_text, rating, review_count, observed_on,"
            " source_ref) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
            " %s, %s)",
            (iid, r["row_no"], r["competitor"], r["channel"],
             r["product_name"], r["sku_key"], r["price_vnd"],
             r["promo_price_vnd"], r["promo_text"], r["rating"],
             r["review_count"], r["observed_on"], r["source_ref"]))
    return iid, []


def load_trend_timeline(conn, rows, cfg, file_name, sha) -> int:
    iid = _new_import(conn, "trend_timeline", None, file_name, sha,
                      len({r["week"] for r in rows}))
    for r in rows:
        conn.execute(
            "insert into trends_weekly (import_id, query_id, keyword, anchor,"
            " geo, week, value) values (%s, %s, %s, %s, %s, %s, %s)",
            (iid, sha[:16], r["keyword"], cfg["anchor"], r["geo"], r["week"],
             r["value"]))
    return iid


def load_trend_related(conn, rows, seed, file_name, sha) -> int:
    iid = _new_import(conn, "trend_related", None, file_name, sha, len(rows))
    for r in rows:
        conn.execute(
            "insert into trends_related (import_id, seed, section, query,"
            " value, flags) values (%s, %s, %s, %s, %s, %s)",
            (iid, seed, r["section"], r["query"], r["value"], r["flags"]))
    return iid


def load_social(conn, rows, channel, salt, file_name, sha
                ) -> tuple[int, int, int]:
    """→ (import_id, new, dup). Dedup theo msg_hash (on conflict do nothing)."""
    iid = _new_import(conn, "social", channel, file_name, sha, len(rows))
    new = 0
    for r in rows:
        got = conn.execute(
            "insert into social_mentions (import_id, channel, kind, posted_at,"
            " msg_hash, labels, sensitive, excerpt) values (%s, %s, %s, %s,"
            " %s, %s, %s, %s) on conflict (msg_hash) do nothing returning id",
            (iid, channel, r["kind"], r["posted_at"],
             msg_hash(salt, channel, r["key"]), r["labels"], r["sensitive"],
             r["excerpt"])).fetchone()
        new += got is not None
    return iid, new, len(rows) - new


def competitor_gaps(conn, week_start: date) -> list[dict]:
    """Lệch giá/KM đối thủ so giá `list` golden (CHỈ ĐỌC) trong tuần [thứ
    Hai, Chủ nhật] chứa week_start. Golden = dòng hiệu lực tại ngày quan sát,
    ưu tiên cùng kênh (nếu kênh có trong golden) rồi `web`. Mỗi con số kèm
    nguồn (obs#/source_ref, price_list#/duyệt hay chưa). Không có "giá nên
    đặt"."""
    mon = week_start - timedelta(days=week_start.weekday())
    sun = mon + timedelta(days=6)
    out = []
    for (oid, comp, ch, name, sku, price, promo, src, day, gid, gprice, gby,
         gch) in conn.execute(
            "select o.id, o.competitor, o.channel, o.product_name, o.sku_key,"
            " o.price_vnd, o.promo_price_vnd, o.source_ref, o.observed_on,"
            " g.id, g.price_vnd, g.approved_by, g.channel"
            " from competitor_observations o left join lateral ("
            "  select p.id, p.price_vnd, p.approved_by, p.channel"
            "  from price_list p where p.sku_key = o.sku_key"
            "  and p.kind = 'list' and p.program_id is null"
            "  and p.valid_from <= o.observed_on"
            "  and (p.valid_to is null or p.valid_to > o.observed_on)"
            "  and p.channel in (case when o.channel = any(%s) then o.channel"
            "   else 'web' end, 'web')"
            "  order by (p.channel = o.channel) desc, p.valid_from desc,"
            "   p.id desc limit 1) g on true"
            " where o.sku_key is not null"
            " and o.observed_on between %s and %s"
            " order by o.observed_on, o.competitor, o.channel,"
            " o.product_name, o.id",
            (list(GOLDEN_CHANNELS), mon, sun)):
        eff = promo or price
        out.append({
            "week": mon, "competitor": comp, "channel": ch,
            "product_name": name, "sku_key": sku, "observed_on": day,
            "price_vnd": price, "promo_price_vnd": promo,
            "obs_ref": f"obs#{oid}", "source_ref": src,
            "golden_vnd": gprice,
            "golden_ref": f"price_list#{gid}" if gid is not None else None,
            "golden_channel": gch,
            "golden_approved": (gby is not None) if gid is not None else None,
            "gap_pct": round(eff / gprice - 1, 3) if gprice else None,
            "note": None if gid is not None else "chưa có giá golden"})
    return out


# ---------------------------------------------------------------- CLI


def _print_errs(errs: list[str]) -> None:
    for e in errs[:MAX_PRINT_ERRS]:
        print(f"[err] {e}", flush=True)
    if len(errs) > MAX_PRINT_ERRS:
        print(f"[err] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác", flush=True)
    print(f"[err] {len(errs)} lỗi — không connect, không nạp gì.", flush=True)


_TARGET = {"competitor": "competitor_observations",
           "trend_timeline": "trends_weekly",
           "trend_related": "trends_related", "social": "social_mentions"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.intel_import",
        description="Nạp file intel nhập tay (đối thủ / Google Trends / "
                    "comment kênh sở hữu) — không request mạng.")
    ap.add_argument("--competitor", type=Path, metavar="F")
    ap.add_argument("--trend", type=Path, metavar="F")
    ap.add_argument("--social", type=Path, metavar="F")
    ap.add_argument("--seed", help="từ khóa gốc của file relatedQueries")
    ap.add_argument("--channel", choices=S_CHANNELS, help="kênh của --social")
    args = ap.parse_args(argv)
    ops = [o for o in ("competitor", "trend", "social")
           if getattr(args, o) is not None]
    if len(ops) != 1:
        ap.error("cần đúng 1 thao tác: --competitor | --trend | --social")
    if args.seed is not None and args.trend is None:
        ap.error("--seed chỉ dùng với --trend")
    if args.channel is not None and args.social is None:
        ap.error("--channel chỉ dùng với --social")
    if args.social is not None and args.channel is None:
        ap.error("--social cần --channel fanpage|zalo_oa|tiktok")
    try:
        kb_filter.is_alcohol("rượu")   # bộ lọc rượu hỏng → fail-closed
    except kb_filter.KbFilterError as e:
        print(f"[err] bộ lọc rượu hỏng: {e}", flush=True)
        return 1

    path = getattr(args, ops[0])
    salt = cfg = None
    if args.competitor is not None:
        kind = "competitor"
        rows, errs, sha = read_competitor(path)
    elif args.trend is not None:
        cfg, errs = load_trend_config(KEYWORDS_FILE)
        if errs:
            for e in errs:
                print(f"[err] {e}", flush=True)
            return 1
        kind, rows, errs, sha = read_trend(path, cfg)
        if not errs and kind == "trend_related":
            if args.seed is None:
                ap.error("file relatedQueries cần --seed <từ khóa gốc>")
            if _kw(args.seed) not in cfg["keywords"]:
                ap.error("--seed không có trong trend_keywords.json")
        elif not errs and args.seed is not None:
            ap.error("--seed chỉ dùng với file relatedQueries")
    else:
        kind = "social"
        cfg, errs = load_social_rules(RULES_FILE)
        if errs:
            for e in errs:
                print(f"[err] {e}", flush=True)
            return 1
        rows, errs, sha = read_social(path, args.channel, cfg)
    if errs:
        _print_errs(errs)
        return 1
    load_dotenv(ROOT / ".env")   # muối + DSN nằm trong .env (không connect)
    # v14.2: login dịch vụ nạp file (LOADER_DATABASE_URL, role svc_loader)
    # — chế độ thực từ chối login superuser/owner/thiếu biến.
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.bind_service("loader"):
        print(f"[err] {why}", flush=True)
        return 2
    if kind == "social":
        salt = os.environ.get("INTEL_HASH_SALT", "")
        if len(salt) < SALT_MIN:
            print(f"[err] thiếu INTEL_HASH_SALT (≥{SALT_MIN} ký tự) trong "
                  ".env — không nạp social.", flush=True)
            return 1

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env", flush=True)
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.Error as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}",
              flush=True)
        return 1
    fname = _safe(path.name, 200)   # che SĐT/email nếu tên file có
    extra = ""
    try:
        if None in conn.execute(
                "select to_regclass('intel_imports'), to_regclass(%s)",
                (_TARGET[kind],)).fetchone():
            print("[err] thiếu bảng v7.2 — chạy `python scripts/apply_schema.py`"
                  " trước.", flush=True)
            return 1
        old = conn.execute("select id, kind from intel_imports where"
                           " file_sha256 = %s", (sha,)).fetchone()
        if old:
            print(f"[skip] file đã nạp: import #{old[0]} ({old[1]}) — không "
                  "ghi gì.", flush=True)
            return 0
        if kind == "competitor":
            iid, errs = load_competitor(conn, rows, fname, sha)
            if errs:
                conn.rollback()
                for e in errs[:MAX_PRINT_ERRS]:
                    print(f"[err] {e}", flush=True)
                print(f"[err] {len(errs)} lỗi — đã rollback, không nạp gì.",
                      flush=True)
                return 1
        elif kind == "trend_timeline":
            iid = load_trend_timeline(conn, rows, cfg, fname, sha)
        elif kind == "trend_related":
            iid = load_trend_related(conn, rows, _kw(args.seed), fname, sha)
        else:
            iid, new, dup = load_social(conn, rows, args.channel, salt, fname,
                                        sha)
            extra = f" new={new} dup={dup}"
        conn.commit()
    except psycopg.errors.UniqueViolation as e:
        conn.rollback()
        if "file_sha256" in (e.diag.constraint_name or ""):
            print("[skip] file vừa được nạp song song — không ghi gì.",
                  flush=True)
            return 0
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        print("[err] thiếu bảng — chạy `python scripts/apply_schema.py` trước.",
              flush=True)
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()
    n = len(rows) if kind != "trend_timeline" else len({r["week"] for r in rows})
    print(f"[load] {kind} #{iid} {fname}: {n} dòng{extra}", flush=True)
    if kind == "trend_timeline":
        sp = cfg["spike"]
        for k in sorted({r["keyword"] for r in rows}):
            series = sorted((r["week"], r["value"]) for r in rows
                            if r["keyword"] == k)
            for w, v, m in find_spikes(series, sp["window_weeks"], sp["ratio"],
                                       sp["min_delta"]):
                print(f"[spike] {k} tuần {w}: {v} (trung vị {m})", flush=True)
    print("[done]", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
