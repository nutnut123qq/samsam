"""v9.0 ACC-AR (WP12) — công nợ đại lý: nạp tay sổ công nợ → tuổi nợ
0-30/31-60/61-90/>90 + quá hạn, hoa hồng theo cấu hình MẪU, cảnh báo nợ quá
hạn vào bản tin GĐ tài chính. Tất định Python, KHÔNG LLM/mạng, KHÔNG gửi,
KHÔNG lệnh chi. v13.6: NHÁP thư nhắc nợ (`--reminders`) vào hàng duyệt —
agent không gửi.

Ownership: ghi `dealer_ar` (insert-only, idempotent theo sha256 file) và
mục `ar_reminder` hàng duyệt (v13.6, qua `director.submit`); chỉ ĐỌC
`sku_master.category`, `dealers.code/status`. Bản tin qua `pipelines.director.run(
..., extra=...)` → `data/reports/director-finance-<ngày>.md` (gitignored).

File nạp (`--load F`, .csv/.xlsx, header CỐ ĐỊNH đúng thứ tự tùy ý):
  dealer_code, dealer_type, kind, doc_ref, doc_date, due_date, amount_vnd,
  sku_key, channel
  - dealer_code `^[A-Z0-9_-]{2,32}$` (KHÔNG tên/SĐT đại lý — khóa nối bảng
    `dealers` CRM v5.2 khi gộp); dealer_type doanh_nghiep|ho_kinh_doanh|
    ca_nhan; kind so_du_dau|phat_sinh (>0) · thanh_toan (<0) · dieu_chinh
    (≠0); ngày YYYY-MM-DD hoặc DD/MM/YYYY, due_date ≥ doc_date; channel
    trống|offline|online. Kiểm TOÀN file TRƯỚC connect — lỗi → exit 1, 0
    dòng; lỗi chỉ nêu số dòng + tên field.

Tính (hàm thuần, `as_of`/kỳ là tham số — chỉ CLI đọc đồng hồ):
  - `age_bucket`: (as_of − doc_date).days ≤30 `0-30`, ≤60 `31-60`, ≤90
    `61-90`, còn lại `>90`; doc_date > as_of → bỏ khỏi kỳ.
  - `aging`: khoản ghi có (thanh_toan + dieu_chinh âm) trừ FIFO vào khoản
    nợ cũ nhất theo doc_date; phần còn lại xếp nhóm tuổi; quá hạn khi
    as_of > coalesce(due_date, doc_date + term_days); dư có ghi riêng.
  - `commission`: cơ sở = phat_sinh + dieu_chinh trong [start, end) theo
    (đại lý, nhóm hàng golden, kênh), sàn 0; khớp `zero_rules` (rượu +
    online) → 0 + cờ `ruou_online`; sku trống/không có golden → 0 + cờ
    `thieu_sku` (fail-closed); rượu kênh trống → 0 + `thieu_kenh`;
    dealer_type ∈ tncn_types → cờ `tncn`. BẢN NHÁP — không phải lệnh chi.

Chạy:
  python -m agents.acc_ar --load F
  python -m agents.acc_ar --aging [--as-of YYYY-MM-DD]
  python -m agents.acc_ar --commission --from YYYY-MM-DD --to YYYY-MM-DD   (--to tính cả ngày)
  python -m agents.acc_ar --bulletin [--as-of YYYY-MM-DD]
  python -m agents.acc_ar --reminders [--as-of YYYY-MM-DD] [--dry-run]
    v13.6 (PL01 Tài chính "nháp thư nhắc nợ"): mỗi đại lý có khoản QUÁ HẠN
    VÀ có trong sổ `dealers` (quan hệ đại lý CRM v5.2; mã ngoài sổ → bỏ
    qua, không soạn) → 1 mục `ar_reminder` khối finance (`director.submit`,
    created_by agent:acc_ar): bảng chứng từ còn nợ FIFO + hạn + số ngày quá
    hạn + nguồn file/sha256; tên/người nhận/người ký/hạn mới là placeholder
    `{{…}}` (không PII, không LLM). Idempotent theo object_id
    `ar:<mã>:<sha12 khoản quá hạn>` (pending/approved/rejected → bỏ qua;
    đổi trạng thái nợ → đợt mới). Tính năng tắt (rollout) → exit 2.
Exit: 0 ok/skip · 1 file/cấu hình/DB lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR
from ingest.lead_store import connect
from ingest.market_csv import MAX_PRINT_ERRS, _clean, _TableError
from ingest.settlement_csv import (
    _to_date,
    _to_signed,
    map_header,
    read_table,
    round_half_up,
)
from pipelines import director, rollout
from pipelines.period import VN_TZ, vn_date
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "dealer_commission.json"
HEADER = ("dealer_code", "dealer_type", "kind", "doc_ref", "doc_date",
          "due_date", "amount_vnd", "sku_key", "channel")
REQUIRED = ("dealer_code", "dealer_type", "kind", "doc_date", "amount_vnd")
DEALER_TYPES = ("doanh_nghiep", "ho_kinh_doanh", "ca_nhan")
AR_KINDS = ("so_du_dau", "phat_sinh", "thanh_toan", "dieu_chinh")
AR_CHANNELS = ("offline", "online")
CATEGORIES = ("tpbvsk", "food", "alcohol")
BUCKETS = ("0-30", "31-60", "61-90", ">90")
# fullmatch: `$` của re nhận cả trước xuống dòng cuối chuỗi.
_CODE_RE = re.compile(r"[A-Z0-9_-]{2,32}")
_SKU_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
MAX_REF = 64
AGENT = "agent:acc_ar"
FIN_BLOCK = "finance"
REMINDER_TYPE = "ar_reminder"


# ---------- cấu hình ----------

def load_config(path: Path = CONFIG_FILE) -> tuple[dict | None, str | None]:
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, f"không đọc được {path.name}: {type(e).__name__}"
    if not isinstance(raw, dict):
        return None, f"{path.name}: phải là object"
    t = raw.get("term_days")
    if isinstance(t, bool) or not isinstance(t, int) or not 1 <= t <= 365:
        return None, f"{path.name}.term_days: phải int 1..365"
    rates = raw.get("rates_pct")
    if not isinstance(rates, dict) or set(rates) != set(CATEGORIES):
        return None, f"{path.name}.rates_pct: phải đủ {CATEGORIES}"
    out_rates = {}
    for k, v in rates.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None, f"{path.name}.rates_pct.{k}: phải là số"
        d = Decimal(str(v))
        if not Decimal(0) <= d <= Decimal("0.5"):
            return None, f"{path.name}.rates_pct.{k}: ngoài 0..0.5"
        out_rates[k] = d
    zr = raw.get("zero_rules")
    if not isinstance(zr, list) or not all(
            isinstance(r, dict) and r.get("category") in CATEGORIES
            and r.get("channel") in AR_CHANNELS for r in zr):
        return None, f"{path.name}.zero_rules: [{{category, channel}}]"
    tn = raw.get("tncn_types")
    if not isinstance(tn, list) or not set(tn) <= set(DEALER_TYPES):
        return None, f"{path.name}.tncn_types: ⊂ {DEALER_TYPES}"
    return {"term_days": t, "rates_pct": out_rates, "zero_rules": zr,
            "tncn_types": list(tn)}, None


# ---------- đọc file (thuần) ----------

def read_ar(path: Path) -> tuple[list[dict], list[str], str | None]:
    """→ (entries, lỗi, sha256 file). Lỗi ≠ [] → entries = []."""
    table, sha, err = read_table(path)
    if err:
        return [], [err], sha
    errs: list[str] = []
    rows: list[dict] = []
    try:
        first = next(table, None)
        if first is None:
            return [], ["file rỗng"], sha
        col_of, errs = map_header(
            first[1], {f: f for f in REQUIRED},
            {f: f for f in HEADER if f not in REQUIRED}, [], "công nợ đại lý")
        if errs:
            return [], errs, sha
        width = len(first[1])
        n_body = 0
        for row_no, cells in table:
            n_body += 1
            if any(c is not None for c in cells[width:]):
                errs.append(f"dòng {row_no}: thừa ô ngoài header")
                continue
            rec = {f: (cells[j] if j < len(cells) else None)
                   for f, j in col_of.items()}
            e = _row(rec, row_no)
            if isinstance(e, list):
                errs += e
            else:
                rows.append(e)
        if not n_body:
            return [], ["file chỉ có header, không có dòng dữ liệu"], sha
    except _TableError as e:
        return [], [str(e)], sha
    return ([] if errs else rows), errs, sha


def _row(rec: dict, row_no: int) -> dict | list[str]:
    errs = []

    def bad(f, why):
        errs.append(f"dòng {row_no}: field '{f}' {why}")

    for f in REQUIRED:
        if rec.get(f) is None:
            bad(f, "trống")
    if errs:
        return errs
    code = rec["dealer_code"]
    if not _CODE_RE.fullmatch(code):
        bad("dealer_code", "phải ^[A-Z0-9_-]{2,32}$ (mã, không tên)")
    if rec["dealer_type"] not in DEALER_TYPES:
        bad("dealer_type", f"phải thuộc {DEALER_TYPES}")
    kind = rec["kind"]
    if kind not in AR_KINDS:
        bad("kind", f"phải thuộc {AR_KINDS}")
    doc_date = _to_date(rec["doc_date"])
    if doc_date is None:
        bad("doc_date", "không phải ngày hợp lệ")
    due = _to_date(rec.get("due_date"))
    if rec.get("due_date") is not None and due is None:
        bad("due_date", "không phải ngày hợp lệ")
    if due and doc_date and due < doc_date:
        bad("due_date", "trước doc_date")
    amt = _to_signed(rec["amount_vnd"])
    if amt is None:
        bad("amount_vnd", "không phải số nguyên VND hợp lệ")
    elif kind in ("so_du_dau", "phat_sinh") and amt <= 0:
        bad("amount_vnd", f"phải > 0 với kind {kind}")
    elif kind == "thanh_toan" and amt >= 0:
        bad("amount_vnd", "phải < 0 với kind thanh_toan")
    elif kind == "dieu_chinh" and amt == 0:
        bad("amount_vnd", "phải ≠ 0 với kind dieu_chinh")
    sku = rec.get("sku_key")
    if sku is not None and not _SKU_RE.fullmatch(sku):
        bad("sku_key", "không phải mã SKU golden hợp lệ")
    ch = rec.get("channel")
    if ch is not None and ch not in AR_CHANNELS:
        bad("channel", f"phải trống hoặc {AR_CHANNELS}")
    ref = rec.get("doc_ref")
    if ref is not None and len(ref) > MAX_REF:
        bad("doc_ref", f"dài quá {MAX_REF}")
    if errs:
        return errs
    return {"row_no": row_no, "dealer_code": code,
            "dealer_type": rec["dealer_type"], "kind": kind, "doc_ref": ref,
            "doc_date": doc_date, "due_date": due, "amount_vnd": amt,
            "sku_key": sku, "channel": ch}


# ---------- tuổi nợ + hoa hồng (thuần) ----------

def age_bucket(doc_date: date, as_of: date) -> str | None:
    days = (as_of - doc_date).days
    if days < 0:
        return None
    if days <= 30:
        return "0-30"
    if days <= 60:
        return "31-60"
    if days <= 90:
        return "61-90"
    return ">90"


def open_items(entries: list[dict], as_of: date,
               term_days: int) -> dict[str, dict]:
    """FIFO dùng chung cho `aging` và thư nhắc nợ → {dealer_code: {"type",
    "items": [{entry, con_lai, han, qua_han}], "du_co"}}. Khoản nợ =
    so_du_dau/phat_sinh/dieu_chinh dương; ghi có = thanh_toan + dieu_chinh
    âm, trừ FIFO theo (doc_date, row_no); doc_date > as_of bỏ khỏi kỳ."""
    by: dict = {}
    for e in entries:
        if e["doc_date"] > as_of:
            continue
        d = by.setdefault(e["dealer_code"], {"type": e["dealer_type"],
                                             "debits": [], "credit": 0})
        if e["amount_vnd"] > 0:
            d["debits"].append(e)
        else:
            d["credit"] += -e["amount_vnd"]
    out = {}
    for code in sorted(by):
        d = by[code]
        credit = d["credit"]
        items = []
        for e in sorted(d["debits"], key=lambda x: (x["doc_date"],
                                                    x.get("row_no", 0))):
            left = e["amount_vnd"]
            used = min(left, credit)
            left -= used
            credit -= used
            if not left:
                continue
            due = e["due_date"] or e["doc_date"] + timedelta(days=term_days)
            items.append({"entry": e, "con_lai": left, "han": due,
                          "qua_han": as_of > due})
        out[code] = {"type": d["type"], "items": items, "du_co": credit}
    return out


def aging(entries: list[dict], as_of: date, term_days: int) -> list[dict]:
    """→ [{dealer_code, dealer_type, buckets, qua_han, du_co, con_no}]
    sắp theo dealer_code (FIFO ở `open_items`)."""
    out = []
    for code, d in open_items(entries, as_of, term_days).items():
        buckets = dict.fromkeys(BUCKETS, 0)
        od_buckets = dict.fromkeys(BUCKETS, 0)
        overdue = 0
        for it in d["items"]:
            b = age_bucket(it["entry"]["doc_date"], as_of)
            buckets[b] += it["con_lai"]
            if it["qua_han"]:
                overdue += it["con_lai"]
                od_buckets[b] += it["con_lai"]
        out.append({"dealer_code": code, "dealer_type": d["type"],
                    "buckets": buckets, "qua_han_buckets": od_buckets,
                    "qua_han": overdue,
                    "du_co": d["du_co"], "con_no": sum(buckets.values())})
    return out


def commission(entries: list[dict], skus: dict, cfg: dict, start: date,
               end: date) -> list[dict]:
    """skus = {sku_key: category}. → [{dealer_code, category, channel,
    co_so, ty_le, hoa_hong, flags}] — BẢN NHÁP, không phải lệnh chi."""
    groups: dict = {}
    for e in entries:
        if e["kind"] not in ("phat_sinh", "dieu_chinh"):
            continue
        if not start <= e["doc_date"] < end:
            continue
        cat = skus.get(e["sku_key"]) if e["sku_key"] else None
        key = (e["dealer_code"], cat, e["channel"])
        g = groups.setdefault(key, {"type": e["dealer_type"], "base": 0})
        g["base"] += e["amount_vnd"]
    out = []
    for (code, cat, ch), g in sorted(groups.items(),
                                     key=lambda kv: tuple(map(str, kv[0]))):
        base = max(0, g["base"])
        flags = []
        rate = Decimal(0)
        if cat is None:
            flags.append("thieu_sku")
        elif any(r["category"] == cat and r["channel"] == ch
                 for r in cfg["zero_rules"]):
            flags.append("ruou_online" if cat == "alcohol" else "zero_rule")
        elif ch is None and any(r["category"] == cat
                                for r in cfg["zero_rules"]):
            flags.append("thieu_kenh")
        else:
            rate = cfg["rates_pct"][cat]
        if g["type"] in cfg["tncn_types"]:
            flags.append("tncn")
        out.append({"dealer_code": code, "category": cat, "channel": ch,
                    "co_so": base, "ty_le": rate,
                    "hoa_hong": round_half_up(Decimal(base) * rate),
                    "flags": flags})
    return out


def _vnd(n: int) -> str:
    return f"{int(n):,}".replace(",", ".") + "đ"


def overdue_section(rows: list[dict], as_of: date) -> list[str]:
    """Dòng markdown cho bản tin GĐ tài chính (chỉ mã đại lý + số tiền)."""
    od = [r for r in rows if r["qua_han"] > 0]
    L = [f"## Công nợ đại lý quá hạn (tính tới {as_of:%d/%m/%Y})", ""]
    if not od:
        return L + ["- (không có)"]
    # r12 F031-6: cột tuổi = tuổi (ngày chứng từ) của RIÊNG phần quá hạn, đủ
    # 4 nhóm kể cả 0-30 (kỳ hạn < 30 ngày) → mỗi dòng cộng khớp cột Quá hạn.
    L += ["| Đại lý | Quá hạn | " + " | ".join(BUCKETS) + " |",
          "|---|---|" + "---|" * len(BUCKETS)]
    for r in sorted(od, key=lambda x: -x["qua_han"]):
        b = r["qua_han_buckets"]
        L.append(f"| `{r['dealer_code']}` | {_vnd(r['qua_han'])} | "
                 + " | ".join(_vnd(b[k]) for k in BUCKETS) + " |")
    L += ["", (f"Tổng quá hạn: {_vnd(sum(r['qua_han'] for r in od))} — "
               "nguồn: sổ công nợ nạp tay (`dealer_ar`); thư nhắc nợ do kế "
               "toán gửi tay, agent không gửi.")]
    return L


# ---------- v13.6 nháp thư nhắc nợ (thuần) ----------

_R_HEAD = ("NHÁP THƯ NHẮC NỢ — chờ GĐ tài chính duyệt; kế toán điền "
           "placeholder và gửi tay. Agent KHÔNG gửi.")
_R_INTRO = ("Theo sổ công nợ của Công ty TNHH Sâm Sâm tính tới ngày {as_of}, "
            "quý đại lý còn các khoản đã quá hạn thanh toán sau:")
_R_TABLE = ("| Chứng từ | Ngày chứng từ | Hạn thanh toán | Số còn nợ |"
            " Quá hạn |")
_R_ASK = ("Kính đề nghị quý đại lý thanh toán hoặc phản hồi đối chiếu trước "
          "ngày {{HAN_THANH_TOAN}}. Nếu đã thanh toán, xin bỏ qua thư này và "
          "gửi chứng từ để đối chiếu.")
_R_SIGN = "{{NGUOI_KY}} — Phòng kế toán Công ty TNHH Sâm Sâm"
_R_BASIS = ("Căn cứ (nội bộ, không gửi kèm): sổ công nợ `dealer_ar` nạp tay —"
            " file {files}; ghi có trừ FIFO theo ngày chứng từ; hạn = "
            "due_date hoặc ngày chứng từ + {term} ngày "
            "(data/dealer_commission.json); trạng thái đại lý trong sổ: "
            "{status}. Nháp này thay nháp nhắc nợ cũ của cùng đại lý nếu còn"
            " chờ duyệt.")

def _txt(s, n: int = 64) -> str:
    """Chuỗi từ file nạp tay (doc_ref/file_name) → 1 dòng, che PII, ≤ n."""
    return _oneline(_mask_pii(_clean(str(s), n)), n) if s else "(không số)"


def reminder_drafts(entries: list[dict], as_of: date, term_days: int,
                    dealers: dict[str, str],
                    sources: dict[str, list[tuple]]) -> dict:
    """Nháp thư nhắc nợ cho đại lý có khoản QUÁ HẠN tại `as_of` →
    {"drafts": [{dealer_code, object_id, title, body, qua_han}],
    "skipped": [{dealer_code, reason}]}.

    - Chỉ đại lý có trong sổ `dealers` (quan hệ đại lý — luật CRM v5.2);
      mã không có trong sổ → skipped, KHÔNG soạn (không có căn cứ liên hệ).
    - Không PII: tên/người nhận/người ký/hạn mới là placeholder `{{…}}` kế
      toán điền khi gửi tay; chỉ mã đại lý + số tiền + chứng từ.
    - Căn cứ: từng chứng từ còn nợ (FIFO), hạn = due_date hoặc doc_date +
      term_days, file nguồn (tên + sha256 8 ký tự).
    - object_id = `ar:<mã>:<sha12 các khoản quá hạn>` — cùng trạng thái nợ
      → cùng id (idempotent); thêm khoản/trả bớt → đợt mới."""
    drafts, skipped = [], []
    for code, d in open_items(entries, as_of, term_days).items():
        od = [it for it in d["items"] if it["qua_han"]]
        if not od:
            continue
        if code not in dealers:
            skipped.append({"dealer_code": code, "reason": (
                "không có trong sổ đại lý `dealers` — không có căn cứ quan "
                "hệ để liên hệ, không soạn thư")})
            continue
        total = sum(it["con_lai"] for it in od)
        con_no = sum(it["con_lai"] for it in d["items"])
        key = json.dumps([[it["entry"].get("doc_ref"),
                           it["entry"]["doc_date"].isoformat(),
                           it["han"].isoformat(), it["con_lai"]]
                          for it in od], ensure_ascii=False)
        oid = f"ar:{code}:{hashlib.sha256(key.encode()).hexdigest()[:12]}"
        files = ", ".join(f"{_txt(n, 80)} (sha256 {s[:8]})"
                          for n, s in sorted(set(sources.get(code, ()))))
        L = [_R_HEAD, "",
             f"Kính gửi: {{{{TEN_DAI_LY}}}} (mã đại lý {code})",
             "Người nhận: {{NGUOI_LIEN_HE}}", "",
             _R_INTRO.format(as_of=f"{as_of:%d/%m/%Y}"), "",
             _R_TABLE, "|---|---|---|---|---|"]
        for it in od:
            e = it["entry"]
            L.append(f"| {_txt(e.get('doc_ref'))} | {e['doc_date']:%d/%m/%Y}"
                     f" | {it['han']:%d/%m/%Y} | {_vnd(it['con_lai'])} | "
                     f"{(as_of - it['han']).days} ngày |")
        L += ["", (f"Tổng quá hạn: {_vnd(total)} (tổng còn nợ: "
                   f"{_vnd(con_no)})."), "", _R_ASK, "", "Trân trọng,",
              _R_SIGN, "", "---",
              _R_BASIS.format(files=files or "(không rõ)", term=term_days,
                              status=dealers[code])]
        drafts.append({"dealer_code": code, "object_id": oid,
                       "qua_han": total, "body": "\n".join(L),
                       "title": (f"Nháp thư nhắc nợ {code} — quá hạn "
                                 f"{_vnd(total)} (tính tới "
                                 f"{as_of:%d/%m/%Y})")})
    return {"drafts": drafts, "skipped": skipped}


# ---------- DB ----------

_COLS = ("row_no", "dealer_code", "dealer_type", "kind", "doc_ref",
         "doc_date", "due_date", "amount_vnd", "sku_key", "channel")


def load(conn, entries: list[dict], file_name: str, sha: str) -> int:
    with conn.cursor() as cur:
        cur.executemany(
            "insert into dealer_ar (file_sha256, file_name, " +
            ", ".join(_COLS) + ") values (%s, %s, " +
            ", ".join(["%s"] * len(_COLS)) + ")",
            [(sha, file_name, *(e[c] for c in _COLS)) for e in entries])
    return len(entries)


def fetch_entries(conn) -> list[dict]:
    return [dict(zip(_COLS, r)) for r in conn.execute(
        "select " + ", ".join(_COLS) + " from dealer_ar order by id")]


def fetch_skus(conn) -> dict:
    return dict(conn.execute("select sku_key, category from sku_master"))


def fetch_dealers(conn) -> dict[str, str]:
    """Sổ đại lý CRM v5.2 → {code: status} (chỉ mã + trạng thái, không
    đọc tên/contact)."""
    return dict(conn.execute("select code, status from dealers"))


def fetch_sources(conn) -> dict[str, list[tuple]]:
    out: dict[str, list[tuple]] = {}
    for code, name, sha in conn.execute(
            "select distinct dealer_code, file_name, file_sha256 from"
            " dealer_ar"):
        out.setdefault(code, []).append((name, sha))
    return out


_REMINDER_EXISTING_SQL = (
    "select 1 from approval_queue where object_type = %s and object_id = %s"
    " and status in ('pending', 'approved', 'rejected') limit 1")


def enqueue_reminders(conn, as_of: date, term_days: int,
                      dcfg: dict | None = None, dry_run: bool = False) -> dict:
    """Nháp thư nhắc nợ → hàng duyệt khối finance (`ar_reminder`, pending —
    GĐ tài chính duyệt, kế toán gửi tay). Đã có cùng object_id ở pending/
    approved/rejected → skipped (expired thì soạn lại). Tính năng `tat` →
    RolloutBlocked trước khi ghi. → {"enqueued", "skipped", "drafts"}."""
    res = reminder_drafts(fetch_entries(conn), as_of, term_days,
                          fetch_dealers(conn), fetch_sources(conn))
    conn.commit()
    out = {"enqueued": [], "skipped": list(res["skipped"]),
           "drafts": res["drafts"]}
    if dry_run:
        return out
    cfg = dcfg if dcfg is not None else director.load_config(FIN_BLOCK)
    for d in res["drafts"]:
        if conn.execute(_REMINDER_EXISTING_SQL,
                        (REMINDER_TYPE, d["object_id"])).fetchone():
            conn.commit()
            out["skipped"].append({"dealer_code": d["dealer_code"],
                                   "reason": "đã có nháp cùng trạng thái nợ"
                                             " trong hàng duyệt"})
            continue
        try:
            qid = director.submit(conn, FIN_BLOCK, REMINDER_TYPE,
                                  d["object_id"], d["title"], d["body"],
                                  created_by=AGENT, cfg=cfg)
        except psycopg.errors.UniqueViolation:
            conn.rollback()
            out["skipped"].append({"dealer_code": d["dealer_code"],
                                   "reason": "đã có (đua)"})
            continue
        out["enqueued"].append({"dealer_code": d["dealer_code"],
                                "queue_id": qid, "qua_han": d["qua_han"]})
    return out


def bulletin(conn, as_of: date, now: datetime, out_dir: Path = REPORTS_DIR,
             cfg: dict | None = None, dcfg: dict | None = None):
    """Nợ quá hạn → mục bổ sung bản tin GĐ tài chính → (path, rows)."""
    cfg = cfg or _cfg_or_raise()
    rows = aging(fetch_entries(conn), as_of, cfg["term_days"])
    path, _text = director.run(conn, "finance", now, cfg=dcfg,
                               out_dir=out_dir,
                               extra=overdue_section(rows, as_of))
    return path, rows


def _cfg_or_raise() -> dict:
    cfg, why = load_config()
    if cfg is None:
        raise ValueError(why)
    return cfg


# ---------- CLI ----------

def _date_arg(ap, s: str | None, flag: str) -> date | None:
    if s is None:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        ap.error(f"{flag} phải dạng YYYY-MM-DD")


def _print_reminders(res: dict, as_of: date, dry_run: bool) -> int:
    if dry_run:
        for d in res["drafts"]:
            print(f"--- [dry-run] {REMINDER_TYPE} {d['object_id']} ---")
            print(d["body"])
    for x in res["enqueued"]:
        print(f"[reminder] {x['dealer_code']} quá hạn {_vnd(x['qua_han'])} →"
              f" hàng duyệt #{x['queue_id']} (pending — GĐ tài chính duyệt;"
              " kế toán gửi tay)")
    for x in res["skipped"]:
        print(f"[skip] {x['dealer_code']}: {x['reason']}")
    n = len(res["drafts"]) if dry_run else len(res["enqueued"])
    print(f"[reminders] tính tới {as_of}: {n} nháp"
          + (" (dry-run, không ghi)" if dry_run else " mới")
          + f", {len(res['skipped'])} bỏ qua — agent KHÔNG gửi thư")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.acc_ar",
        description="ACC-AR: công nợ đại lý, tuổi nợ, hoa hồng (BẢN NHÁP), "
                    "cảnh báo quá hạn vào bản tin GĐ tài chính")
    ap.add_argument("--load", type=Path, metavar="FILE")
    ap.add_argument("--aging", action="store_true")
    ap.add_argument("--commission", action="store_true")
    ap.add_argument("--bulletin", action="store_true")
    ap.add_argument("--reminders", action="store_true",
                    help="v13.6: nháp thư nhắc nợ quá hạn → hàng duyệt "
                         "finance (không gửi)")
    ap.add_argument("--dry-run", action="store_true",
                    help="--reminders: chỉ in nháp, không ghi hàng duyệt")
    ap.add_argument("--as-of", help="ngày chốt YYYY-MM-DD (mặc định hôm nay "
                                    "VN)")
    ap.add_argument("--from", dest="date_from")
    ap.add_argument("--to", dest="date_to", help="tính cả ngày này")
    args = ap.parse_args(argv)

    n_ops = sum([args.load is not None, args.aging, args.commission,
                 args.bulletin, args.reminders])
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--load | --aging | --commission | "
                 "--bulletin | --reminders)")
    if n_ops == 0:
        ap.error("cần --load | --aging | --commission | --bulletin | "
                 "--reminders")
    if args.dry_run and not args.reminders:
        ap.error("--dry-run chỉ dùng với --reminders")
    as_of = _date_arg(ap, args.as_of, "--as-of")
    d_from = _date_arg(ap, args.date_from, "--from")
    d_to = _date_arg(ap, args.date_to, "--to")
    if args.as_of and not (args.aging or args.bulletin or args.reminders):
        ap.error("--as-of chỉ dùng với --aging/--bulletin/--reminders")
    if args.commission:
        if d_from is None or d_to is None:
            ap.error("--commission cần --from và --to")
        if d_from > d_to:
            ap.error("--from sau --to")
    elif d_from or d_to:
        ap.error("--from/--to chỉ dùng với --commission")
    now = datetime.now(VN_TZ)
    as_of = as_of or vn_date(now)

    cfg, why = load_config()
    if cfg is None:
        print(f"[err] {why} — không connect.", flush=True)
        return 1
    entries = sha = None
    if args.load is not None:
        entries, errs, sha = read_ar(args.load)
        if errs:
            for e in errs[:MAX_PRINT_ERRS]:
                print(f"[err] {e}", flush=True)
            print(f"[err] {len(errs)} lỗi — không connect, không nạp gì.",
                  flush=True)
            return 1

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.load is not None:
            if conn.execute("select 1 from dealer_ar where file_sha256 = %s"
                            " limit 1", (sha,)).fetchone():
                print("[skip] file công nợ đã nạp — không ghi gì.")
                return 0
            n = load(conn, entries, args.load.name, sha)
            conn.commit()
            print(f"[load] {n} dòng công nợ từ {_clean(args.load.name, 80)}")
            return 0
        if args.bulletin:
            path, rows = bulletin(conn, as_of, now, cfg=cfg)
            n_od = sum(1 for r in rows if r["qua_han"] > 0)
            print(f"[bulletin] {n_od} đại lý quá hạn → {path.name} (BẢN "
                  "NHÁP, không tự gửi)")
            return 0
        if args.reminders:
            return _print_reminders(enqueue_reminders(
                conn, as_of, cfg["term_days"], dry_run=args.dry_run),
                as_of, args.dry_run)
        if args.aging:
            rows = aging(fetch_entries(conn), as_of, cfg["term_days"])
            print(f"[aging] tuổi nợ tính tới {as_of} — {len(rows)} đại lý:")
            for r in rows:
                b = r["buckets"]
                print(f"  {r['dealer_code']}: còn nợ {_vnd(r['con_no'])} ("
                      + ", ".join(f"{k} {_vnd(b[k])}" for k in BUCKETS)
                      + f"); quá hạn {_vnd(r['qua_han'])}"
                      + (f"; dư có {_vnd(r['du_co'])}" if r["du_co"] else ""))
            return 0
        lines = commission(fetch_entries(conn), fetch_skus(conn), cfg,
                           d_from, d_to + timedelta(days=1))
        conn.commit()
        print(f"[commission] BẢN NHÁP — không phải lệnh chi; kỳ {d_from} → "
              f"{d_to} (tính cả ngày cuối), chính sách MẪU chưa ký:")
        for x in lines:
            print(f"  {x['dealer_code']} {x['category'] or '?'}/"
                  f"{x['channel'] or '?'}: cơ sở {_vnd(x['co_so'])} × "
                  f"{x['ty_le']} = {_vnd(x['hoa_hong'])}"
                  + (f" [{', '.join(x['flags'])}]" if x["flags"] else ""))
        print(f"  tổng hoa hồng nháp: "
              f"{_vnd(sum(x['hoa_hong'] for x in lines))}")
        return 0
    except rollout.RolloutBlocked as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[blocked] {e}", file=sys.stderr)
        return 2
    except (psycopg.Error, director.DirectorConfigError, OSError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else type(e).__name__
        print(f"[error] {type(e).__name__}: {msg}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
