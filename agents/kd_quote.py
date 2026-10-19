"""v8.2 KD-A3 (WP11) — báo giá B2B quà Tết: ma trận GIẢ ĐỊNH → định giá +
phân loại TẤT ĐỊNH → báo giá markdown/HTML in được → hàng duyệt đúng lane →
bản gửi phải khớp hash bản duyệt. Agent KHÔNG gửi email/tin nhắn.

Contract:
  - `data/b2b_pricing.json` = ma trận GIẢ ĐỊNH (bậc số lượng × chiết khấu ×
    SKU/combo, ngưỡng biên). `validate_matrix` THUẦN; key rượu → lỗi.
  - `classify(items, matrix, golden, combos, cogs_versions, day)` THUẦN (không
    DB/mạng): giá gốc từ golden (`prices[base.channel][base.kind]`, combo =
    Σ thành phần × qty — BOM v9.2), CK theo bậc, đơn giá làm tròn XUỐNG bội
    `rounding_vnd` (int, không float), giá vốn = `fp_pnl.cogs_at` (CHỈ dòng
    `cogs_versions` ĐÃ duyệt v9.1), biên `Decimal` 1 chữ số. `reasons`
    (→ per_item GĐ bán hàng) / `problems` (CHẶN: rượu, mã lạ, số lượng sai,
    ma trận lỗi). `within_matrix` = cả 2 rỗng — vẫn là NHÁP chờ lane
    auto_policy (chỉ chạy khi chủ khối ký `auto_policies` + suite `kd_a3`
    pass; ship rỗng → pending người duyệt).
  - Text báo giá do TEMPLATE + số do code tính — KHÔNG LLM (module không
    import gateway LLM — grep gate rỗng là bằng chứng) → cổng
    `guardrail.check_publish(..., is_ai=False)` (không nhãn AI vì không có
    nội dung AI). Báo giá không chứa tên/SĐT/email người liên hệ (PII chỉ ở
    `contacts` mã hóa), không claim sức khỏe, không "Ngọc Linh".
  - Trong ma trận → `sales/b2b_quote_matrix` (risk low); ngoài → `sales/
    b2b_quote` (risk high); biên dưới ngưỡng / thiếu giá vốn duyệt → thêm
    `finance/b2b_margin_review` — các mục trong CÙNG 1 transaction.
  - `--export` chỉ từ mục ĐÃ duyệt; `--verify-send` so `.md` (nguyên văn) /
    `.html` (`render_html` tất định) với sha256 bản duyệt. GĐ bán hàng TỰ gửi.
  - v14.4 (sales-05, PL01 "nhắc chốt đơn"): `--verify-send` KHỚP → 1 dòng
    `b2b_quote_events` `da_gui` (append-only); NGƯỜI ghi kết quả
    `--outcome QID chot|khong_chot|huy --by`. `--followups` (job, CHỈ đọc
    nguồn): báo giá ĐÃ duyệt chưa có kết quả sau `after_business_hours` giờ
    làm việc tính từ lần gửi gần nhất (chưa gửi → từ lúc duyệt) → NHÁP nhắc
    `b2b_followup` khối sales (mẫu lời nhắc, không tên/SĐT/email người liên
    hệ). Theo ĐỢT: khóa `fu:<qid>:<mốc UTC>:<k>` — đang có nhắc pending →
    không thêm; nhắc đã quyết → lần k+1 sau thêm N giờ, tối đa
    `max_reminders`; gửi lại (mốc mới) → đợt mới. Ngưỡng
    `data/sales_watch.json` GIẢ ĐỊNH. Hệ thống KHÔNG tự liên hệ khách.

Chạy:
  python -m agents.kd_quote --check-matrix [FILE]
  python -m agents.kd_quote --requests
  python -m agents.kd_quote --quote REQ_ID [--discount PCT] [--date D]
                            [--out-dir DIR] [--submit | --dry-run]
  python -m agents.kd_quote --export QID --out FILE(.md|.html)
  python -m agents.kd_quote --verify-send QID FILE [--by TÊN]
  python -m agents.kd_quote --outcome QID chot|khong_chot|huy --by TÊN
  python -m agents.kd_quote --followups [--dry-run]
Exit: 0 ok · 1 bị chặn (problems / cổng / không thấy / lệch hash / chưa
duyệt / ma trận lỗi) · 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import hashlib
import html
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import psycopg

from agents.fp_pnl import cogs_at, fetch_versions
from agents.report import REPORTS_DIR, queue_sample, write_report
from ingest.golden_store import CHANNELS, GOLDEN_FILE, KINDS, read_golden
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import auth, director, guardrail, kb_filter, period
from pipelines.period import VN_TZ
from pipelines.pii import _PII_RE, _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MATRIX_FILE = ROOT / "data" / "b2b_pricing.json"
RULES_FILE = ROOT / "data" / "guardrail_rules.json"
BLOCK = "sales"
OT_MATRIX = "b2b_quote_matrix"
OT_QUOTE = "b2b_quote"
OT_MARGIN = "b2b_margin_review"
QUOTE_TYPES = frozenset({OT_MATRIX, OT_QUOTE})
AGENT = "agent:kd_quote"
QA_SUITE = "kd_a3"
MAX_QTY = 100_000
MAX_LINES = 10
MAX_DISCOUNT = 50
MAX_SEND_BYTES = 2 * 1024 * 1024
REASONS = ("ma_tran_chua_xac_nhan", "ngoai_ma_tran", "ngoai_bac_so_luong",
           "chiet_khau_vuot", "duoi_gia_san", "thieu_gia_niem_yet",
           "thieu_gia_von_duyet", "thieu_chi_phi_bao_bi", "bien_duoi_nguong",
           "tpbvsk_chua_xnqc")
PROBLEMS = ("ruou_khong_bao_gia", "ma_khong_ton_tai",
            "so_luong_khong_hop_le", "ma_tran_loi")
FINANCE_REASONS = ("bien_duoi_nguong", "thieu_gia_von_duyet")
ORG_LABELS = {"doanh_nghiep": "Doanh nghiệp", "khach_san": "Khách sạn",
              "su_kien_hoi_nghi": "Sự kiện – hội nghị",
              "hiep_hoi": "Hiệp hội", "co_quan": "Cơ quan", "khac": "Khác"}
FOOTER = ("Báo giá chỉ có hiệu lực khi GĐ bán hàng ký — hệ thống không tự "
          "gửi.")
TERMS = ("Giá GIẢ ĐỊNH đã gồm VAT, chưa gồm vận chuyển — tài chính chốt "
         "trước khi ký.")
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_IMG_RE = re.compile(r"!\[([^\]]{0,80})\]\((packshots/[a-z0-9]+(?:-[a-z0-9]+)*"
                     r"\.png)\)")
_CELL_SPLIT = re.compile(r"(?<!\\)\|")


# ------------------------------------------------------------ tiện ích thuần
def _is_int(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def vnd(n) -> str:
    return "—" if n is None else f"{n:,}".replace(",", ".") + "đ"


def canonical(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), default=str).encode("utf-8")


def _md(s) -> str:
    """Ô markdown 1 dòng: gom khoảng trắng, escape `|`."""
    return " ".join(str(s or "").split()).replace("|", "\\|") or "—"


def gidx(golden) -> dict:
    """golden doc `{"skus": [...]}` → {sku_key: sku}."""
    skus = golden.get("skus") if isinstance(golden, dict) else None
    return {s["sku_key"]: s for s in skus or ()
            if isinstance(s, dict) and isinstance(s.get("sku_key"), str)}


def cidx(combos) -> dict:
    return {c["combo_key"]: c for c in combos or ()
            if isinstance(c, dict) and isinstance(c.get("combo_key"), str)}


def is_alcohol_key(key, g: dict, c: dict, _depth: int = 0) -> bool:
    """SKU `alcohol` / tên nhắc rượu / combo có thành phần rượu / chính key
    nhắc rượu ("ruou-...")."""
    if not isinstance(key, str):
        return False
    if kb_filter.is_alcohol(key.replace("-", " ")):
        return True
    s = g.get(key)
    if s is not None:
        return s.get("category") == "alcohol" or kb_filter.is_alcohol(
            s.get("name") or "")
    cb = c.get(key)
    if cb is not None and _depth < 2:
        return kb_filter.is_alcohol(cb.get("name") or "") or any(
            is_alcohol_key(it.get("sku_key"), g, c, _depth + 1)
            for it in cb.get("items") or () if isinstance(it, dict))
    return False


def _tp_unapproved(s: dict | None) -> bool:
    return bool(s) and s.get("category") == "tpbvsk" \
        and s.get("xnqc_status") != "approved"


def _iso_day(v) -> bool:
    try:
        date.fromisoformat(v)
        return True
    except (TypeError, ValueError):
        return False


# -------------------------------------------------------------- ma trận
def read_matrix(path: Path = MATRIX_FILE) -> tuple[dict | None, str | None]:
    """→ (doc, None) | (None, lý do). Không raise."""
    p = Path(path)
    try:
        if p.stat().st_size > 1_000_000:
            return None, f"{p.name} quá lớn"
        doc = json.loads(p.read_bytes().decode("utf-8-sig"))
    except FileNotFoundError:
        return None, f"thiếu file {p.name}"
    except (OSError, UnicodeDecodeError, ValueError) as e:
        return None, f"{p.name} hỏng ({type(e).__name__})"
    if not isinstance(doc, dict):
        return None, f"{p.name}: root phải là object"
    return doc, None


def _confirmed(v) -> bool:
    return isinstance(v, dict) and isinstance(v.get("by"), str) \
        and bool(v["by"].strip()) and _iso_day(v.get("at"))


def matrix_sha(matrix: dict) -> str:
    return hashlib.sha256(canonical(matrix)).hexdigest()


def validate_matrix(doc, golden=None, combos=None) -> list[str]:
    """→ list lỗi (rỗng = hợp lệ). THUẦN trừ đọc golden file khi
    `golden` None. Key rượu → lỗi (rượu không bao giờ vào báo giá)."""
    if not isinstance(doc, dict):
        return ["ma trận không phải object JSON"]
    errs = []
    if not isinstance(doc.get("status"), str) or not doc["status"].strip():
        errs.append("thiếu 'status' (GIẢ ĐỊNH/đã chốt)")
    if not _is_int(doc.get("version"), 1, 10**6):
        errs.append("'version' phải số nguyên ≥ 1")
    for k in ("finance_confirmed", "sales_confirmed"):
        if k not in doc:
            errs.append(f"thiếu '{k}' (null = chưa xác nhận)")
        elif doc[k] is not None and not _confirmed(doc[k]):
            errs.append(f"'{k}' phải null hoặc {{by: tên người, at: "
                        "YYYY-MM-DD}")
    base = doc.get("base")
    if not (isinstance(base, dict) and base.get("channel") in CHANNELS
            and base.get("kind") in KINDS):
        errs.append(f"'base' phải {{channel ∈ {CHANNELS}, kind ∈ {KINDS}}}")
    if not _is_int(doc.get("min_margin_pct"), 0, 90):
        errs.append("'min_margin_pct' phải số nguyên 0..90")
    if not _is_int(doc.get("rounding_vnd"), 1, 1_000_000):
        errs.append("'rounding_vnd' phải số nguyên 1..1.000.000")
    if not _is_int(doc.get("quote_valid_days"), 1, 90):
        errs.append("'quote_valid_days' phải số nguyên 1..90")
    tiers = doc.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        errs.append("'tiers' phải list khác rỗng")
    else:
        prev = None
        for i, t in enumerate(tiers):
            if not (isinstance(t, dict)
                    and _is_int(t.get("min_qty"), 1, MAX_QTY)
                    and _is_int(t.get("max_qty"), 1, MAX_QTY)
                    and t["max_qty"] >= t["min_qty"]):
                errs.append(f"tiers[{i}]: min_qty/max_qty nguyên 1.."
                            f"{MAX_QTY}, max ≥ min")
                prev = None
                continue
            if not _is_int(t.get("discount_pct"), 0, MAX_DISCOUNT):
                errs.append(f"tiers[{i}]: discount_pct nguyên 0.."
                            f"{MAX_DISCOUNT}")
            if prev is not None and t["min_qty"] != prev["max_qty"] + 1:
                errs.append(f"tiers[{i}]: phải liền ngay sau bậc trước "
                            "(không chồng, không hở)")
            prev = t
    items = doc.get("items")
    if not isinstance(items, dict) or not items:
        errs.append("'items' phải object khác rỗng")
        return errs
    if golden is None:
        golden, _ = read_golden(GOLDEN_FILE)
    g, c = gidx(golden or {}), cidx(combos)
    for k, v in items.items():
        if not _SLUG_RE.fullmatch(k):
            errs.append(f"items: key '{_oneline(k, 40)}' không phải slug")
            continue
        if is_alcohol_key(k, g, c):
            errs.append(f"items[{k}]: rượu không được vào ma trận báo giá")
        if not (isinstance(v, dict)
                and _is_int(v.get("max_discount_pct"), 0, MAX_DISCOUNT)):
            errs.append(f"items[{k}]: max_discount_pct nguyên 0.."
                        f"{MAX_DISCOUNT}")
            continue
        pk = v.get("packaging_cost_vnd")
        if pk is not None and not _is_int(pk, 0, 10**9):
            errs.append(f"items[{k}]: packaging_cost_vnd null hoặc nguyên "
                        "≥ 0")
        if set(v) - {"max_discount_pct", "packaging_cost_vnd"}:
            errs.append(f"items[{k}]: key lạ")
    return errs


def _tier(matrix: dict, qty: int) -> dict | None:
    for t in matrix.get("tiers") or ():
        if t["min_qty"] <= qty <= t["max_qty"]:
            return t
    return None


# ---------------------------------------------------------------- định giá
def _parts(key: str, g: dict, c: dict) -> list[tuple[str, int]] | None:
    """SKU → [(key, 1)]; combo → [(sku, qty)]; không thấy → None."""
    if key in g:
        return [(key, 1)]
    cb = c.get(key)
    if cb is None:
        return None
    out = []
    for it in cb.get("items") or ():
        if not (isinstance(it, dict) and _is_int(it.get("qty"), 1, 10**6)):
            return None
        out.append((it.get("sku_key"), it["qty"]))
    return out or None


def _sum_price(parts, g: dict, channel: str, kind: str) -> int | None:
    total = 0
    for sku, q in parts:
        p = ((g.get(sku) or {}).get("prices") or {}).get(channel) or {}
        v = p.get(kind)
        if not _is_int(v, 1, 10**12):
            return None
        total += v * q
    return total


def price_lines(items, matrix, golden, combos, *, discount=None):
    """→ (lines, problems). Mỗi dòng: key, kind, name, spec, qty, list_unit,
    floor_unit, discount_pct, unit, amount, tier, in_matrix, parts, tp
    (có TPBVSK chưa XNQC), reasons (mã cấp dòng trừ giá vốn/biên)."""
    g, c = gidx(golden), cidx(combos)
    problems: list[str] = []
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_LINES:
        return [], ["so_luong_khong_hop_le"]
    base = matrix.get("base") or {}
    ch, kind = base.get("channel"), base.get("kind")
    r = matrix.get("rounding_vnd") or 1
    mitems = matrix.get("items") or {}
    lines = []
    for it in items:
        key = it.get("key") if isinstance(it, dict) else None
        qty = it.get("qty") if isinstance(it, dict) else None
        if not _is_int(qty, 1, MAX_QTY):
            problems.append("so_luong_khong_hop_le")
            continue
        if is_alcohol_key(key, g, c):
            problems.append("ruou_khong_bao_gia")
            continue
        parts = _parts(key, g, c) if isinstance(key, str) else None
        if parts is None:
            problems.append("ma_khong_ton_tai")
            continue
        if any(sku not in g for sku, _ in parts):
            problems.append("ma_khong_ton_tai")
            continue
        reasons = []
        spec_m = mitems.get(key)
        if spec_m is None:
            reasons.append("ngoai_ma_tran")
        t = _tier(matrix, qty)
        if t is None:
            reasons.append("ngoai_bac_so_luong")
        tier_ck = t["discount_pct"] if t else 0
        ck = tier_ck if discount is None else discount
        if ck > tier_ck or (spec_m is not None
                            and ck > spec_m.get("max_discount_pct", 0)):
            reasons.append("chiet_khau_vuot")
        lst = _sum_price(parts, g, ch, kind)
        flr = _sum_price(parts, g, ch, "floor")
        unit = amount = None
        if lst is None or flr is None:
            reasons.append("thieu_gia_niem_yet")
        else:
            unit = lst * (100 - ck) // (100 * r) * r
            amount = unit * qty
            if unit < flr:
                reasons.append("duoi_gia_san")
        tp = any(_tp_unapproved(g.get(sku)) for sku, _ in parts)
        if tp:
            reasons.append("tpbvsk_chua_xnqc")
        if key in g:
            name, spec = g[key].get("name") or key, g[key].get("pack_spec")
        else:
            name = c[key].get("name") or key
            spec = " + ".join(f"{g[s].get('name') or s} ×{q}"
                              for s, q in parts)
        lines.append({"key": key, "kind": "sku" if key in g else "combo",
                      "name": name, "spec": spec or "—", "qty": qty,
                      "list_unit": lst, "floor_unit": flr,
                      "discount_pct": ck, "unit": unit, "amount": amount,
                      "tier": t, "in_matrix": spec_m is not None,
                      "parts": parts, "tp": tp, "reasons": reasons})
    return lines, problems


def classify(items, matrix, golden, combos, cogs_versions, day: date, *,
             discount=None) -> dict:
    """Định giá + phân loại TẤT ĐỊNH (không DB/mạng/LLM)."""
    mx_errs = validate_matrix(matrix, golden, combos)
    out = {"lines": [], "total": None, "cogs_total": None,
           "margin_pct": None, "within_matrix": False, "reasons": [],
           "problems": [], "matrix_version": None, "matrix_sha": None}
    if mx_errs:
        out["problems"] = ["ma_tran_loi"]
        out["matrix_errors"] = mx_errs
        return out
    out["matrix_version"] = matrix["version"]
    out["matrix_sha"] = matrix_sha(matrix)
    if discount is not None and not _is_int(discount, 0, 100):
        raise ValueError("discount phải số nguyên 0..100")
    lines, problems = price_lines(items, matrix, golden, combos,
                                  discount=discount)
    reasons = set()
    if not (_confirmed(matrix.get("finance_confirmed"))
            and _confirmed(matrix.get("sales_confirmed"))):
        reasons.add("ma_tran_chua_xac_nhan")
    mitems = matrix["items"]
    cogs_ok = True
    for ln in lines:
        reasons.update(ln["reasons"])
        cost = 0
        for sku, q in ln["parts"]:
            v = cogs_at(cogs_versions, sku, day)
            if v is None:
                cost = None
                reasons.add("thieu_gia_von_duyet")
                break
            cost += v * q
        if ln["kind"] == "combo":
            pk = (mitems.get(ln["key"]) or {}).get("packaging_cost_vnd")
            if pk is None:
                reasons.add("thieu_chi_phi_bao_bi")
                cost = None
            elif cost is not None:
                cost += pk
        ln["cogs_unit"] = cost
        ln["cogs"] = None if cost is None else cost * ln["qty"]
        if ln["cogs"] is None:
            cogs_ok = False
    total = None
    if lines and all(ln["amount"] is not None for ln in lines):
        total = sum(ln["amount"] for ln in lines)
    cogs_total = sum(ln["cogs"] for ln in lines) if lines and cogs_ok \
        else None
    margin = None
    if total and cogs_total is not None:
        margin = (Decimal(total - cogs_total) * 100 / Decimal(total)
                  ).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        # So biên CHƯA làm tròn (số nguyên, exact): 29.96% không được
        # làm tròn lên 30.0 rồi lọt ngưỡng 30 — quantize chỉ để hiển thị.
        if (total - cogs_total) * 100 < matrix["min_margin_pct"] * total:
            reasons.add("bien_duoi_nguong")
    out.update(lines=lines, total=total, cogs_total=cogs_total,
               margin_pct=margin,
               reasons=[r for r in REASONS if r in reasons],
               problems=[p for p in PROBLEMS if p in set(problems)])
    out["within_matrix"] = not out["reasons"] and not out["problems"]
    return out


# ------------------------------------------------------------- báo giá
def disclaimer() -> str:
    doc = json.loads(RULES_FILE.read_bytes().decode("utf-8"))
    return str(doc["disclaimer"]["canonical"])


def _quote_no(request_id, result: dict, day: date) -> str:
    key = {"lines": [[ln["key"], ln["qty"], ln["discount_pct"], ln["unit"],
                      ln["amount"]] for ln in result["lines"]],
           "matrix_version": result["matrix_version"],
           "matrix_sha": result["matrix_sha"], "day": day.isoformat()}
    sha = hashlib.sha256(canonical(key)).hexdigest()[:8]
    return f"BG-{day:%Y%m%d}-{int(request_id)}-{sha}"


def build_quote(request: dict, result: dict, golden, day: date,
                matrix: dict | None = None) -> dict:
    """→ {quote_no, payload (BẢN GỬI — chuỗi được hash), internal (KHÔNG
    gửi khách), problems}. Không tên/SĐT/email người liên hệ."""
    if result["problems"]:
        return {"quote_no": None, "payload": "", "internal": "",
                "problems": list(result["problems"])}
    valid_days = (matrix or {}).get("quote_valid_days") or 14
    qno = _quote_no(request["id"], result, day)
    org_t = ORG_LABELS.get(request.get("org_type"), "Khác")
    L = [f"# Báo giá quà Tết — {qno}", "",
         f"- Ngày báo giá: {day:%d/%m/%Y}",
         f"- Hiệu lực đến: {day + timedelta(days=valid_days):%d/%m/%Y}",
         (f"- Kính gửi: {_md(request.get('org_name'))} ({org_t}) — "
          f"{_md(request.get('region'))}")]
    nb = request.get("need_by")
    if isinstance(nb, date):
        L.append(f"- Ngày cần hàng: {nb:%d/%m/%Y}")
    L += ["", ("| # | Sản phẩm | Quy cách | SL | Giá niêm yết | CK % | "
               "Đơn giá | Thành tiền |"), "|---|---|---|---|---|---|---|---|"]
    for i, ln in enumerate(result["lines"], 1):
        L.append(f"| {i} | {_md(ln['name'])} | {_md(ln['spec'])} | "
                 f"{ln['qty']} | {vnd(ln['list_unit'])} | "
                 f"{ln['discount_pct']} | {vnd(ln['unit'])} | "
                 f"{vnd(ln['amount'])} |")
    L += ["", f"**Tổng cộng: {vnd(result['total'])}**", "", "Điều khoản:",
          "", f"- {TERMS}",
          f"- Báo giá có hiệu lực {valid_days} ngày kể từ ngày báo giá.",
          "- Số lượng và ngày giao theo xác nhận của GĐ bán hàng."]
    g = gidx(golden)
    if any(g.get(s, {}).get("category") == "tpbvsk"
           for ln in result["lines"] for s, _ in ln["parts"]):
        L += ["", disclaimer() + "."]
    L += ["", FOOTER, ""]
    payload = "\n".join(L)
    m = result["margin_pct"]
    lane = "trong ma trận" if result["within_matrix"] else "per_item"
    margin = "chưa tính được" if m is None else f"{m}%"
    inner = [f"# Nội bộ — báo giá {qno} (KHÔNG gửi khách)", "",
             f"- Yêu cầu: YC-{int(request['id'])}",
             f"- Phân loại: {lane}",
             f"- Lý do: {', '.join(result['reasons']) or '(không)'}",
             (f"- Tổng: {vnd(result['total'])} · Giá vốn đã duyệt: "
              f"{vnd(result['cogs_total'])} · Biên: {margin} (ngưỡng "
              f"{(matrix or {}).get('min_margin_pct', '?')}%)"),
             (f"- Ma trận v{result['matrix_version']} sha "
              f"{(result['matrix_sha'] or '')[:16]}"), "",
             "| # | Mã | SL | Đơn giá | Thành tiền | Giá vốn dòng | Lý do dòng |",
             "|---|---|---|---|---|---|---|"]
    for i, ln in enumerate(result["lines"], 1):
        inner.append(f"| {i} | {ln['key']} | {ln['qty']} | "
                     f"{vnd(ln['unit'])} | {vnd(ln['amount'])} | "
                     f"{vnd(ln.get('cogs'))} | "
                     f"{', '.join(ln['reasons']) or '—'} |")
    inner += ["", ("Bản nội bộ cho tài chính/GĐ bán hàng — không đính kèm "
                   "báo giá gửi khách."), ""]
    return {"quote_no": qno, "payload": payload,
            "internal": "\n".join(inner), "problems": []}


def alcohol_names(golden) -> list[str]:
    """Tên + key SKU rượu (để quét chuỗi đối ngoại)."""
    out = []
    for k, s in gidx(golden).items():
        if s.get("category") == "alcohol" or kb_filter.is_alcohol(
                s.get("name") or ""):
            out += [k, s.get("name") or k]
    return out


def readiness_map(golden, channel: str = "web") -> dict:
    """(sku, kênh) → mức readiness tính từ golden ĐANG dùng (cổng XNQC khớp
    dữ liệu báo giá/catalog, không lệch golden file của guardrail)."""
    return {(k, channel): guardrail._readiness_of(s, channel)
            for k, s in gidx(golden).items()}


def gate_text(payload: str, excluded_names, *, content_type: str,
              readiness: dict | None = None, ids=()) -> list[str]:
    """Cổng chung tài liệu đối ngoại (báo giá/catalog) → mã lỗi. `ids` =
    mã do CHÍNH hệ thống sinh (số báo giá, sha ảnh) — bỏ ra trước khi quét
    PII (chuỗi hex/số của mã có thể giống mẫu SĐT)."""
    errs = []
    g = guardrail.check_publish(payload, channel="web",
                                content_type=content_type, is_ai=False,
                                readiness=readiness)
    if g.get("ok") is not True:
        codes = sorted({str(v.get("code")) for v in g.get("violations")
                        or ()}) or ["?"]
        errs += [f"guardrail:{c}" for c in codes]
    low = payload.casefold()
    if kb_filter.is_alcohol(payload) or any(
            n and n.casefold() in low for n in excluded_names):
        errs.append("ruou")
    scan = payload
    for x in ids:
        if x:
            scan = scan.replace(x, " ")
    if _PII_RE.search(scan):
        errs.append("pii")
    return errs


def gate_quote(payload: str, excluded_names, readiness=None,
               ids=()) -> list[str]:
    return gate_text(payload, excluded_names, content_type="post",
                     readiness=readiness, ids=ids)


# --------------------------------------------------------------- HTML in
def _inline(s: str) -> str:
    e = html.escape(s, quote=True)
    e = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", e)
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", e)


def _cells(row: str) -> list[str]:
    parts = _CELL_SPLIT.split(row.strip())
    return [p.strip().replace("\\|", "|") for p in parts[1:-1]]


def title_of(payload: str) -> str:
    for ln in payload.split("\n"):
        if ln.startswith("# "):
            return ln[2:].strip()
    return "Tài liệu"


_CSS = ("@page { size: A4; margin: 15mm; }\n"
        "body { font-family: 'Times New Roman', serif; font-size: 12pt;"
        " color: #000; background: #fff; max-width: 180mm; margin: 0 auto; }\n"
        "h1 { font-size: 16pt; } h2 { font-size: 14pt; } h3 { font-size:"
        " 12pt; }\n"
        "table { border-collapse: collapse; width: 100%; margin: 6pt 0; }\n"
        "th, td { border: 1px solid #444; padding: 3pt 5pt; text-align: left;"
        " vertical-align: top; }\n"
        "img { max-width: 60mm; }\n"
        "@media print { body { max-width: none; } }")


def render_html(payload: str, title: str | None = None) -> str:
    """Markdown TỐI THIỂU (đúng tập cú pháp payload tự sinh: #/##/###, `- `,
    bảng `|`, ảnh `![](packshots/x.png)`, đoạn) → HTML A4 in được. TẤT
    ĐỊNH; mọi giá trị qua `html.escape`; không `<script>`/tài nguyên ngoài
    (ảnh chỉ đường tương đối `packshots/<slug>.png`)."""
    t = title if title is not None else title_of(payload)
    out = ["<!doctype html>", '<html lang="vi">', "<head>",
           '<meta charset="utf-8">',
           f"<title>{html.escape(t, quote=True)}</title>",
           f"<style>\n{_CSS}\n</style>", "</head>", "<body>"]
    lines = payload.split("\n")
    i, n, para = 0, len(lines), []

    def flush():
        if para:
            out.append("<p>" + "<br>".join(_inline(x) for x in para)
                       + "</p>")
            para.clear()

    while i < n:
        s = lines[i].strip()
        m = re.fullmatch(r"(#{1,3}) (.+)", s)
        img = _IMG_RE.fullmatch(s)
        if not s:
            flush()
            i += 1
        elif m:
            flush()
            lv = len(m.group(1))
            out.append(f"<h{lv}>{_inline(m.group(2))}</h{lv}>")
            i += 1
        elif img:
            flush()
            out.append(f'<p><img src="{html.escape(img.group(2))}" alt="'
                       f'{html.escape(img.group(1), quote=True)}"></p>')
            i += 1
        elif s.startswith("|"):
            flush()
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                r = lines[i].strip()
                if not re.fullmatch(r"\|[\s:|-]+\|", r):
                    rows.append(_cells(r))
                i += 1
            out.append("<table>")
            for j, cells in enumerate(rows):
                tag = "th" if j == 0 else "td"
                out.append("<tr>" + "".join(f"<{tag}>{_inline(c)}</{tag}>"
                                            for c in cells) + "</tr>")
            out.append("</table>")
        elif s.startswith("- "):
            flush()
            out.append("<ul>")
            while i < n and lines[i].strip().startswith("- "):
                out.append(f"<li>{_inline(lines[i].strip()[2:])}</li>")
                i += 1
            out.append("</ul>")
        else:
            para.append(s)
            i += 1
    flush()
    out += ["</body>", "</html>", ""]
    return "\n".join(out)


# ------------------------------------------------------------------- DB
_REQ_COLS = ("id", "org_name", "org_type", "region", "items", "need_by",
             "created_at")


class _HoldCommit:
    """Chuyển tiếp conn nhưng hoãn commit — nhiều mục hàng duyệt trong CÙNG
    1 transaction (precedent agents.da_b2b)."""

    def __init__(self, conn):
        self._c = conn

    def execute(self, *a, **kw):
        return self._c.execute(*a, **kw)

    def transaction(self):
        return self._c.transaction()

    def commit(self):
        pass


def fetch_request(conn, rid: int) -> dict | None:
    row = conn.execute(f"select {', '.join(_REQ_COLS)} from b2b_requests"
                       " where id = %s", (rid,)).fetchone()
    return dict(zip(_REQ_COLS, row)) if row else None


def finance_needed(result: dict) -> bool:
    return any(r in result["reasons"] for r in FINANCE_REASONS)


def existing(conn, quote_no: str) -> int | None:
    """Mục pending/approved của báo giá (cùng số) → id; không → None."""
    row = conn.execute(
        "select id from approval_queue where object_id = %s and block ="
        " %s and object_type = any(%s) and status in ('pending',"
        " 'approved') order by id limit 1",
        (quote_no, BLOCK, sorted(QUOTE_TYPES))).fetchone()
    return row[0] if row else None


def submit(conn, request: dict, built: dict, result: dict) -> list[int]:
    """problems rỗng → 1–2 mục hàng duyệt trong 1 transaction → [qid...].
    Mục cùng số báo giá đang pending/đã duyệt → [] (skip)."""
    if built["problems"] or result["problems"] or not built["quote_no"]:
        raise ValueError("báo giá có problems — không vào hàng duyệt")
    qno = built["quote_no"]
    if existing(conn, qno) is not None:
        conn.commit()
        return []
    ot = OT_MATRIX if result["within_matrix"] else OT_QUOTE
    n = len(result["lines"])
    title = f"Báo giá B2B {qno} (YC-{int(request['id'])}, {n} dòng)"
    ids = []
    with conn.transaction():
        hc = _HoldCommit(conn)
        ids.append(director.submit(hc, BLOCK, ot, qno, title,
                                   built["payload"], created_by=AGENT,
                                   qa_suite=QA_SUITE))
        if finance_needed(result):
            ids.append(director.submit(
                hc, "finance", OT_MARGIN, qno,
                f"Rà biên báo giá B2B {qno}", built["internal"],
                created_by=AGENT))
    conn.commit()
    return ids


def _queue_row(conn, qid: int):
    return conn.execute("select block, object_type, status, payload from"
                        " approval_queue where id = %s", (qid,)).fetchone()


def _approved_payload(conn, qid: int, object_types) -> str | None:
    row = _queue_row(conn, qid)
    if (row is None or row[0] != BLOCK or row[1] not in object_types
            or row[2] != "approved"):
        return None
    return row[3]


def export(conn, qid: int, out: Path,
           object_types=QUOTE_TYPES) -> tuple[bool, str]:
    """Xuất bản ĐÃ duyệt: `.md` = payload nguyên văn, `.html` =
    `render_html(payload)`. Chưa duyệt / sai loại / lệch hash → False."""
    out = Path(out)
    if out.suffix.lower() not in (".md", ".html"):
        return False, "--out phải là .md hoặc .html"
    payload = _approved_payload(conn, qid, object_types)
    if payload is None:
        conn.commit()
        return False, (f"mục #{qid} không phải tài liệu {sorted(object_types)}"
                       " ĐÃ duyệt — KHÔNG xuất")
    if not aq.verify(conn, qid, payload):
        conn.commit()
        return False, f"mục #{qid}: LỆCH bản duyệt (sha256) — KHÔNG xuất"
    conn.commit()
    body = payload if out.suffix.lower() == ".md" else render_html(payload)
    path = write_report(body, out.parent, out.name,
                        sample=queue_sample(conn, qid))
    return True, str(path)


def verify_send(conn, qid: int, path: Path,
                object_types=QUOTE_TYPES) -> bool:
    """File sắp gửi có đúng bản đã duyệt? (khớp sha256 bản duyệt).
    > 2 MB / không UTF-8 / sai khối-loại / chưa duyệt / lệch → False."""
    p = Path(path)
    try:
        with p.open("rb") as fh:
            data = fh.read(MAX_SEND_BYTES + 1)
        if len(data) > MAX_SEND_BYTES:
            return False
        text = data.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    payload = _approved_payload(conn, qid, object_types)
    if payload is None:
        conn.commit()
        return False
    if p.suffix.lower() == ".html":
        ok = (data == render_html(payload).encode("utf-8")
              and aq.verify(conn, qid, payload))
    else:
        ok = aq.verify(conn, qid, text)
    conn.commit()
    return ok


# ------------------------------------------------------- v14.4 nhắc chốt đơn
OT_FOLLOWUP = "b2b_followup"
FEATURE_FOLLOWUP = "sales-05"
OUTCOMES = ("chot", "khong_chot", "huy")
OUTCOME_LABELS = {"chot": "đã chốt", "khong_chot": "không chốt",
                  "huy": "hủy yêu cầu"}
_QNO_RE = re.compile(r"BG-[0-9]{8}-[0-9]{1,18}-[0-9a-f]{8}")


def record_event(conn, qid: int, kind: str, by=None, text=None) -> int:
    """1 dòng `b2b_quote_events` cho báo giá ĐÃ duyệt (sales, b2b_quote*)
    → id. Kết quả (`chot|khong_chot|huy`) cần `by` người thật và chỉ ghi 1
    lần; `da_gui` ghi mỗi lần gửi (mốc nhắc mới). Sai → ValueError.

    v15 fix P10.2: ghi qua function `b2b_quote_event_human` (SECURITY
    DEFINER — login người `app_human` không còn INSERT thẳng bảng): DB kiểm
    danh tính theo login (`by` có tên), báo giá sales ĐÃ duyệt, 1 kết
    quả/báo giá, mốc `da_gui` khớp sha bản duyệt mới nhất (`text` — mặc định
    bản đã duyệt mà file gửi vừa khớp). DB từ chối danh tính →
    `auth.HumanDenied` (ValueError)."""
    if kind not in ("da_gui", *OUTCOMES):
        raise ValueError(f"kết quả phải là {'|'.join(OUTCOMES)}")
    who = by.strip() if isinstance(by, str) and by.strip() else None
    if who is not None and (len(who) > 100 or not who.isprintable()):
        raise ValueError("--by phải là tên người 1..100 ký tự in được")
    if kind in OUTCOMES and (who is None or who.casefold().startswith(
            ("agent:", "system:"))):
        raise ValueError("ghi kết quả báo giá cần --by tên NGƯỜI")
    row = _queue_row(conn, qid)
    if (row is None or row[0] != BLOCK or row[1] not in QUOTE_TYPES
            or row[2] != "approved"):
        raise ValueError(f"mục #{qid} không phải báo giá B2B ĐÃ duyệt")
    if kind in OUTCOMES:
        done = conn.execute(
            "select kind from b2b_quote_events where queue_id = %s and"
            " kind = any(%s) order by id limit 1",
            (qid, list(OUTCOMES))).fetchone()
        if done is not None:
            raise ValueError(f"mục #{qid} đã ghi kết quả "
                             f"'{OUTCOME_LABELS[done[0]]}' — không ghi đè")
    if kind == "da_gui" and text is None:
        text = row[3]
    try:
        with conn.transaction():
            eid = auth.call_human(
                conn, "select b2b_quote_event_human(%s, %s, %s, %s)",
                (qid, kind, text if kind == "da_gui" else None, who), by=who,
                block=None, action="outcome" if kind in OUTCOMES
                else "verify_send", object_type="b2b_quote",
                object_id=qid).fetchone()[0]
    except psycopg.errors.UniqueViolation:
        # 2 người ghi song song: index unique một-kết-quả/báo-giá chặn.
        raise ValueError(f"mục #{qid} đã ghi kết quả — không ghi đè")             from None
    return eid


def _utc(ts) -> str:
    return f"{ts.astimezone(timezone.utc):%Y%m%dT%H%M%S%fZ}"


def _fmt(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M")


def _safe_no(qno) -> str:
    return qno if isinstance(qno, str) and _QNO_RE.fullmatch(qno) \
        else "(số lạ)"


def followup_items(conn, now: datetime, fu: dict, shift) -> list[dict]:
    """CHỈ ĐỌC → mục nhắc chốt đơn cần đẩy (xem docstring module)."""
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise ValueError("now phải là datetime có múi giờ (aware)")
    quotes = conn.execute(
        "select id, object_id, decided_at from approval_queue where block ="
        " %s and object_type = any(%s) and status = 'approved' order by id",
        (BLOCK, sorted(QUOTE_TYPES))).fetchall()
    if not quotes:
        return []
    ev: dict = {}
    for qid, kind, ts in conn.execute(
            "select queue_id, kind, created_at from b2b_quote_events where"
            " queue_id = any(%s) order by id",
            ([q[0] for q in quotes],)).fetchall():
        ev.setdefault(qid, []).append((kind, ts))
    rem: dict = {}
    for oid, st, dec in conn.execute(
            "select object_id, status, decided_at from approval_queue where"
            " object_type = %s and object_id like 'fu:%%'",
            (OT_FOLLOWUP,)).fetchall():
        rem.setdefault(oid.rsplit(":", 1)[0], []).append((st, dec))
    out = []
    for qid, qno, decided in quotes:
        evs = ev.get(qid, [])
        if any(k in OUTCOMES for k, _ in evs) or decided is None:
            continue
        sent = [ts for k, ts in evs if k == "da_gui"]
        base = max([decided, *sent])
        key = f"fu:{qid}:{_utc(base)}"
        prev = rem.get(key, [])
        if any(st == "pending" for st, _ in prev) or \
                len(prev) >= fu["max_reminders"]:
            continue
        start = max([base, *(d for _, d in prev if d is not None)])
        due = period.business_deadline(start, fu["after_business_hours"],
                                       shift)
        if now < due:
            continue
        k = len(prev) + 1
        mode = (f"đã gửi lúc {_fmt(sent[-1])}" if sent else
                f"đã duyệt lúc {_fmt(decided)}, CHƯA xác nhận gửi"
                " (--verify-send)")
        no = _safe_no(qno)
        out.append({
            "object_type": OT_FOLLOWUP, "object_id": f"{key}:{k}",
            "title": f"Nhắc chốt báo giá {no} (lần {k})",
            "payload": (
                f"Nhắc chốt đơn B2B lần {k}/{fu['max_reminders']} — báo giá"
                f" {no} (mục #{qid}) {mode}; chưa ghi kết quả sau"
                f" {fu['after_business_hours']} giờ làm việc (GIẢ ĐỊNH). Việc"
                " cần làm: GĐ bán hàng TỰ liên hệ tổ chức qua kênh đã gửi báo"
                " giá, rồi ghi kết quả `python -m agents.kd_quote --outcome"
                f" {qid} chot|khong_chot|huy --by <tên>`. Mẫu lời nhắc (người"
                " gửi tự điền tên người nhận): 'Kính gửi Quý tổ chức, Sâm Sâm"
                f" xin phép theo dõi báo giá số {no}. Nếu Quý tổ chức cần"
                " điều chỉnh số lượng hoặc thông tin giao hàng, xin vui lòng"
                " phản hồi để chúng tôi cập nhật báo giá.' Hệ thống không tự"
                " liên hệ khách.")})
    return out


def run_followups(conn, now: datetime, dry_run: bool = False) -> dict:
    """Đẩy nhắc chốt đơn (tính năng tắt → RolloutBlocked trước khi đọc)."""
    from agents import sales_watch
    from pipelines import rollout

    fu = sales_watch.section("quote_followup")
    cfg = director.load_config(BLOCK)
    if OT_FOLLOWUP not in cfg["object_types"]:
        raise ValueError(f"sales.json thiếu loại việc {OT_FOLLOWUP}")
    rollout.check_generate(conn, FEATURE_FOLLOWUP, "nhắc chốt đơn B2B")
    items = followup_items(conn, now, fu, cfg["business_hours"])
    n = 0
    if not dry_run:
        for it in items:
            try:
                director.submit(conn, BLOCK, it["object_type"],
                                it["object_id"], it["title"], it["payload"],
                                AGENT, cfg=cfg)
            except psycopg.errors.UniqueViolation:
                with suppress(Exception):
                    conn.rollback()
                continue
            n += 1
    conn.commit()
    return {"found": len(items), "enqueued": n}


# ------------------------------------------------------------------ CLI
def _today_vn() -> date:
    return datetime.now(VN_TZ).date()


def _date_arg(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") \
            from None


def _pct_arg(s: str) -> int:
    if not re.fullmatch(r"[0-9]{1,2}", s or "") or int(s) > MAX_DISCOUNT:
        raise argparse.ArgumentTypeError(f"CK phải số nguyên 0..{MAX_DISCOUNT}")
    return int(s)


def _print_result(res: dict) -> None:
    for ln in res["lines"]:
        print(f"  {ln['key']} ×{ln['qty']} · CK {ln['discount_pct']}% · đơn "
              f"giá {vnd(ln['unit'])} · thành tiền {vnd(ln['amount'])}")
    m = res["margin_pct"]
    print(f"  tổng {vnd(res['total'])} · giá vốn duyệt "
          f"{vnd(res['cogs_total'])} · biên "
          f"{'chưa tính được' if m is None else f'{m}%'}")
    print(f"  phân loại: {'TRONG ma trận' if res['within_matrix'] else 'per_item'}"
          f" · reasons: {', '.join(res['reasons']) or '(không)'}"
          f" · problems: {', '.join(res['problems']) or '(không)'}")


def _cmd_check_matrix(path: Path) -> int:
    doc, why = read_matrix(path)
    if doc is None:
        print(f"[error] {why}", file=sys.stderr)
        return 1
    errs = validate_matrix(doc)
    for e in errs:
        print(f"[err] {e}", file=sys.stderr)
    if errs:
        print(f"[error] ma trận lỗi ({len(errs)})", file=sys.stderr)
        return 1
    fc = "đã" if _confirmed(doc.get("finance_confirmed")) else "CHƯA"
    sc = "đã" if _confirmed(doc.get("sales_confirmed")) else "CHƯA"
    print(f"[ok] ma trận v{doc['version']} hợp lệ · {len(doc['items'])} mã ·"
          f" {len(doc['tiers'])} bậc · tài chính {fc} xác nhận · GĐ bán hàng"
          f" {sc} xác nhận ({doc['status']})")
    return 0


def _cmd_quote(conn, a) -> int:
    from pipelines.production import db_combos  # lười: module lớn

    req = fetch_request(conn, a.quote)
    if req is None:
        conn.commit()
        print(f"[warn] không thấy yêu cầu YC-{a.quote}", file=sys.stderr)
        return 1
    golden, why = read_golden(GOLDEN_FILE)
    matrix, why2 = read_matrix(MATRIX_FILE)
    if golden is None or matrix is None:
        conn.commit()
        print(f"[error] {why or why2}", file=sys.stderr)
        return 1
    combos = db_combos(conn)
    versions = fetch_versions(conn)
    conn.commit()
    day = a.date or _today_vn()
    res = classify(req["items"], matrix, golden, combos, versions, day,
                   discount=a.discount)
    print(f"[quote] YC-{req['id']} ({len(res['lines'])} dòng hợp lệ):")
    _print_result(res)
    if res["problems"]:
        print(f"[error] bị chặn: {', '.join(res['problems'])} — KHÔNG sinh "
              "báo giá, KHÔNG vào hàng duyệt (rượu: GĐ xử lý ngoài hệ thống "
              "khi Pháp chế xác nhận)", file=sys.stderr)
        return 1
    built = build_quote(req, res, golden, day, matrix)
    errs = gate_quote(built["payload"], alcohol_names(golden),
                      readiness_map(golden), ids=[built["quote_no"]])
    if errs:
        print(f"[error] cổng tài liệu đối ngoại chặn: {', '.join(errs)} — "
              "GĐ bán hàng soạn tay (vd tên tổ chức chứa từ cấm)",
              file=sys.stderr)
        return 1
    if a.dry_run:
        print(f"[dry-run] {built['quote_no']} — không ghi file, không vào "
              "hàng duyệt")
        return 0
    qno = built["quote_no"]
    for name, body in ((f"bao-gia-{qno}.md", built["payload"]),
                       (f"bao-gia-{qno}.html", render_html(built["payload"])),
                       (f"bao-gia-{qno}-noi-bo.md", built["internal"])):
        # P8.4: nháp dựng từ yêu cầu B2B thật (b2b_requests không cột mẫu).
        print(f"[file] {write_report(body, a.out_dir, name, sample=False)}")
    if not a.submit:
        print(f"[done] {qno} — NHÁP; thêm --submit để vào hàng duyệt")
        return 0
    try:
        ids = submit(conn, req, built, res)
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        ids = []
    if not ids:
        print(f"[skip] {qno} đã có mục pending/đã duyệt — không ghi thêm")
        return 0
    lane = (f"{OT_MATRIX} (risk low — chỉ tự đạt khi auto_policy đã ký)"
            if res["within_matrix"] else f"{OT_QUOTE} (risk high — GĐ bán "
            "hàng duyệt)")
    print(f"[done] {qno} → mục #{ids[0]} {lane}"
          + (f"; tài chính rà biên mục #{ids[1]}" if len(ids) > 1 else "")
          + f". {FOOTER}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_quote",
        description="KD-A3 báo giá B2B quà Tết — NHÁP; agent không tự "
                    "duyệt, không tự gửi")
    ap.add_argument("--check-matrix", nargs="?", const=MATRIX_FILE,
                    type=Path, metavar="FILE")
    ap.add_argument("--requests", action="store_true")
    ap.add_argument("--quote", type=int, metavar="REQ_ID")
    ap.add_argument("--export", type=int, metavar="QID")
    ap.add_argument("--verify-send", nargs=2, metavar=("QID", "FILE"))
    ap.add_argument("--outcome", nargs=2, metavar=("QID", "KQ"),
                    help="ghi kết quả báo giá đã duyệt: "
                         + "|".join(OUTCOMES) + " (cần --by)")
    ap.add_argument("--followups", action="store_true",
                    help="đẩy NHÁP nhắc chốt đơn B2B vào hàng duyệt (v14.4)")
    ap.add_argument("--by", help="tên NGƯỜI (bắt buộc với --outcome; tùy "
                                 "chọn với --verify-send)")
    ap.add_argument("--discount", type=_pct_arg, metavar="PCT")
    ap.add_argument("--date", type=_date_arg)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    n_ops = ((a.check_matrix is not None) + a.requests
             + (a.quote is not None) + (a.export is not None)
             + (a.verify_send is not None) + (a.outcome is not None)
             + a.followups)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --check-matrix | --requests | --quote"
                 " | --export | --verify-send | --outcome | --followups")
    if a.quote is None and (a.discount is not None or a.date or a.submit):
        ap.error("--discount/--date/--submit chỉ dùng với --quote")
    if a.dry_run and a.quote is None and not a.followups:
        ap.error("--dry-run chỉ dùng với --quote hoặc --followups")
    if a.by is not None and a.outcome is None and a.verify_send is None:
        ap.error("--by chỉ dùng với --outcome / --verify-send")
    oqid = None
    if a.outcome is not None:
        if not re.fullmatch(r"[0-9]{1,18}", a.outcome[0]) \
                or a.outcome[1] not in OUTCOMES:
            ap.error(f"--outcome QID KQ — QID số, KQ {'|'.join(OUTCOMES)}")
        if not (a.by or "").strip():
            ap.error("--outcome cần --by <tên người>")
        oqid = int(a.outcome[0])
    if a.followups and (why := auth.bind_service("job")):
        print(f"[err] {why}", flush=True)
        return 2
    if a.submit and a.dry_run:
        ap.error("--submit và --dry-run loại trừ nhau")
    if (a.export is not None) != (a.out is not None):
        ap.error("--export cần --out FILE (.md|.html) và ngược lại")
    vqid = None
    if a.verify_send is not None:
        try:
            vqid = int(a.verify_send[0])
        except ValueError:
            ap.error("--verify-send QID phải là số")
    if a.check_matrix is not None:
        return _cmd_check_matrix(a.check_matrix)
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.requests:
            rows = conn.execute(
                "select id, org_name, org_type, region,"
                " jsonb_array_length(items), created_at from b2b_requests"
                " order by id").fetchall()
            conn.commit()
            for r in rows:
                print(f"  YC-{r[0]} · {_oneline(_mask_pii(r[1]), 60)} · "
                      f"{r[2]} · {r[3]} · {r[4]} dòng · "
                      f"{r[5].astimezone(VN_TZ):%d/%m/%Y}")
            print(f"[done] {len(rows)} yêu cầu báo giá")
            return 0
        if a.quote is not None:
            return _cmd_quote(conn, a)
        if a.export is not None:
            ok, msg = export(conn, a.export, a.out)
            if not ok:
                print(f"[warn] {msg}", file=sys.stderr)
                return 1
            print(f"[done] xuất bản ĐÃ DUYỆT mục #{a.export} → {msg} (GĐ bán"
                  " hàng tự gửi; chạy --verify-send trước khi gửi)")
            return 0
        if a.outcome is not None:
            # v15.4 (P10.2): ghi kết quả khách báo = NHẬP LIỆU (không đổi
            # giá/đơn) — kiểm danh tính người ghi (auth.cli_identity).
            why = auth.cli_identity(conn, a.by, "b2b_quote", oqid,
                                    action="outcome")
            if why:
                conn.rollback()
                print(f"[từ chối] {why} — không ghi", file=sys.stderr)
                return 1
            try:
                record_event(conn, oqid, a.outcome[1], a.by)
            except auth.HumanDenied as e:
                conn.rollback()
                print(f"[từ chối] {e} — không ghi", file=sys.stderr)
                return 1
            except ValueError as e:
                conn.rollback()
                print(f"[warn] {e} — không ghi", file=sys.stderr)
                return 1
            conn.commit()
            print(f"[ok] mục #{oqid}: ghi kết quả "
                  f"'{OUTCOME_LABELS[a.outcome[1]]}' — dừng nhắc chốt đơn")
            return 0
        if a.followups:
            from pipelines.rollout import RolloutBlocked
            try:
                res = run_followups(conn, datetime.now(VN_TZ), a.dry_run)
            except RolloutBlocked as e:
                print(f"[rollout] {e}", file=sys.stderr)
                return 2
            except (ValueError, director.DirectorConfigError) as e:
                print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
                return 1
            print(f"[{'dry-run' if a.dry_run else 'followups'}] báo giá cần"
                  f" nhắc {res['found']} · đẩy {res['enqueued']} mục nhắc"
                  + (" — KHÔNG ghi DB" if a.dry_run else "")
                  + " (hệ thống không tự liên hệ khách)")
            return 0
        if a.by is not None:
            # v15.4 (P10.2): `--by` ghi mốc đã gửi = NHẬP LIỆU — kiểm danh tính.
            why = auth.cli_identity(conn, a.by, "b2b_quote", vqid,
                                    action="verify_send")
            if why:
                conn.rollback()
                print(f"[từ chối] {why} — không ghi", file=sys.stderr)
                return 1
        if verify_send(conn, vqid, Path(a.verify_send[1])):
            try:
                record_event(conn, vqid, "da_gui", a.by)
                conn.commit()
            except auth.HumanDenied as e:
                # v15 fix P10.2: DB từ chối danh tính người ghi mốc gửi.
                with suppress(Exception):
                    conn.rollback()
                print(f"[từ chối] {e} — KHỚP bản duyệt nhưng không ghi mốc"
                      " gửi", file=sys.stderr)
                return 1
            except (ValueError, psycopg.Error) as e:
                with suppress(Exception):
                    conn.rollback()
                print(f"[warn] KHỚP nhưng không ghi được mốc gửi "
                      f"({type(e).__name__}) — nhắc chốt đơn tính từ lúc "
                      "duyệt", file=sys.stderr)
            print(f"[ok] mục #{vqid}: KHỚP bản đã duyệt — GĐ bán hàng tự gửi")
            return 0
        print(f"[warn] mục #{vqid}: LỆCH — KHÔNG gửi (chưa duyệt / sai loại "
              "/ file khác bản duyệt)", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
