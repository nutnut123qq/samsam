"""v14.4 (p4) — đọc + kiểm cấu hình `data/sales_watch.json` (GIẢ ĐỊNH, chờ
GĐ bán hàng chốt) dùng chung cho 4 tính năng Kinh doanh TMĐT:
sales-04.1 (`ingest.crm --owner` + `agents.sales_director` mục
`lead_followup`), sales-05 (`agents.kd_quote --followups`), sales-06.1
(`ingest.dealer_price` + `agents.kd_price --dealer-watch`), sales-06.2
(`agents.kd_orders --watch`).

THUẦN (không DB/mạng). Fail-closed: file thiếu/hỏng/sai kiểu → `ValueError`
nêu khóa lỗi (caller exit 1 TRƯỚC khi connect), không bao giờ "cấu hình
rỗng = cho qua". Ngoài khóa đã biết → lỗi (gõ nhầm tên khóa không âm thầm
rơi về mặc định).
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_FILE = ROOT / "data" / "sales_watch.json"
STAFF_RE = re.compile(r"[A-Z0-9_-]{2,20}")
CHANNEL_RE = re.compile(r"[a-z0-9_]{2,20}")
SECTIONS = {
    "lead_owner": {"assign_within_business_hours": (1, 72),
                   "handle_within_business_hours": (1, 72),
                   "lookback_days": (1, 365), "max_per_run": (1, 1000),
                   "staff_codes": None},
    "quote_followup": {"after_business_hours": (1, 720),
                       "max_reminders": (1, 10)},
    "dealer_price": {"channels": None, "lookback_days": (1, 365),
                     "max_rows": (1, 50000)},
    "order_watch": {"min_orders": (1, 100000), "baseline_weeks": (1, 26),
                    "check_weeks": (1, 12), "cancel_rate_max_pct": (1, 100),
                    "return_rate_max_pct": (1, 100), "spike_ratio": (1, 20),
                    "return_status": None},
}
TOP = {"_doc", "status", "confirmed_by", *SECTIONS}


def _int_in(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _str_list(v) -> bool:
    return isinstance(v, list) and all(
        isinstance(x, str) and x.strip() and x == x.strip() for x in v) \
        and len(set(v)) == len(v)


def validate(doc) -> dict:
    """→ doc | ValueError (thông điệp nêu khóa, không nêu giá trị)."""
    if not isinstance(doc, dict):
        raise ValueError("sales_watch.json phải là object JSON")  # noqa: TRY004
    stray = sorted(set(doc) - TOP)
    if stray:
        raise ValueError(f"sales_watch.json: khóa lạ {stray}")
    if not isinstance(doc.get("status"), str) or not doc["status"].strip():
        raise ValueError("sales_watch.json: thiếu 'status'")
    cb = doc.get("confirmed_by", "")
    if not (cb is None or (isinstance(cb, str) and cb.strip())):
        raise ValueError("sales_watch.json: 'confirmed_by' phải null hoặc "
                         "tên người chốt")
    for sec, keys in SECTIONS.items():
        s = doc.get(sec)
        if not isinstance(s, dict) or set(s) != set(keys):
            raise ValueError(f"sales_watch.json: '{sec}' phải có đúng các "
                             f"khóa {sorted(keys)}")
        for k, rng in keys.items():
            if rng is not None and not _int_in(s[k], *rng):
                raise ValueError(f"sales_watch.json: {sec}.{k} phải số "
                                 f"nguyên {rng[0]}..{rng[1]}")
    codes = doc["lead_owner"]["staff_codes"]
    if not _str_list(codes) or not all(STAFF_RE.fullmatch(c) for c in codes):
        raise ValueError("sales_watch.json: lead_owner.staff_codes phải list "
                         "mã [A-Z0-9_-]{2,20} không trùng (KHÔNG ghi tên)")
    ch = doc["dealer_price"]["channels"]
    if not _str_list(ch) or not ch or not all(CHANNEL_RE.fullmatch(c)
                                              for c in ch):
        raise ValueError("sales_watch.json: dealer_price.channels phải list "
                         "mã kênh [a-z0-9_]{2,20} không trùng, không rỗng")
    rs = doc["order_watch"]["return_status"]
    if not isinstance(rs, dict) or not rs or not all(
            CHANNEL_RE.fullmatch(k) and _str_list(v) and v
            for k, v in rs.items()):
        raise ValueError("sales_watch.json: order_watch.return_status phải "
                         "{kênh: [trạng thái hoàn/trả]} không rỗng")
    return doc


def load(path: Path | None = None) -> dict:
    p = Path(path) if path is not None else WATCH_FILE
    try:
        doc = json.loads(p.read_bytes().decode("utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise ValueError(f"không đọc được {p.name} ({type(e).__name__})") \
            from None
    return validate(doc)


def section(name: str, path: Path | None = None) -> dict:
    return load(path)[name]
