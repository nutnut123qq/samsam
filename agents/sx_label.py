"""v12.3 SX — Đối soát nhãn (PL01 mục Sản xuất "Đọc ảnh nhãn thật, so với
hồ sơ và listing, báo chỗ sai"), khối `production`, loại việc `label_check`.

Luật TẤT ĐỊNH, KHÔNG LLM, KHÔNG gọi sàn, KHÔNG sửa golden/listing/lô:
chữ trên nhãn (file .txt chép/OCR sẵn, hoặc ảnh → OCR qua provider đã cắm
của `ingest.doc_intake`) → trích tên SP, số ĐKSP/số tự công bố, quy cách
(số + viên|ml), NSX/HSD, mã lô, cụm bắt buộc (câu khuyến cáo TPBVSK, cảnh
báo nhóm hạn chế — `data/label_rules.json` GIẢ ĐỊNH chờ Chuyên viên pháp chế)
→ so với golden (`sku_master`), hồ sơ lô (`production_lots`, lô đọc được
trên nhãn) và listing mới nhất mỗi kênh (`market_rows` snapshot `listing`)
→ danh sách lệch. Agent CHỈ ĐỀ XUẤT: `--submit` đẩy 1 mục `label_check`
qua `pipelines.director.submit` (SLA/risk theo `data/directors/
production.json`); GĐ sản xuất duyệt, người sửa nhãn/hồ sơ/listing.

An toàn dữ liệu:
  - Không lưu/in nguyên văn nhãn — chỉ field trích bằng regex (số, ngày,
    mã) + sha256 nội dung nhãn. Payload dựng từ TEMPLATE; nhãn mô tả cụm
    bắt buộc lấy `label` an toàn trong config (không chép cụm có từ cấm).
  - SKU nhóm hạn chế (category alcohol / tên dính bộ lọc `kb_filter`)
    KHÔNG in sku_key/tên vào hàng duyệt — dùng mã tra cứu `H-<sha8>`
    (CLI in ánh xạ cho người chạy). Payload trượt guardrail vì lý do khác
    → thay bằng bản rút gọn chỉ số đếm + mã (fail-closed, không đẩy chữ bẩn).
  - Ảnh: provider `none`/chưa cấu hình/nước ngoài → exit 2 kèm hướng dẫn
    (không gửi ảnh ra ngoài; luật provider giữ nguyên của doc_intake).
  - Idempotent theo ĐỢT: object_id `sxlabel:<sku|mã tra cứu>:<sha12 nhãn>:
    <sha8 phát hiện>` — đã có ở BẤT KỲ status → không đẩy lại; golden/
    listing/lô đổi làm phát hiện đổi = đợt mới.

Hàm thuần: load_rules(path) · extract(text) · compare(fields, sku, rules,
listings, lots, today) · payload_of(sku, findings, text_sha, restricted).

Chạy:
  python -m agents.sx_label --sku <sku_key> --text <file nhãn .txt>
  python -m agents.sx_label --sku <sku_key> --image <ảnh|pdf> [--submit]
Exit: 0 ok (kể cả có lệch) · 1 file/cấu hình/SKU lỗi · 2 sai usage, OCR
chưa cấu hình, DB down/lỗi DB.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import datetime
from pathlib import Path

import psycopg

from agents.kd_listing import listing_snapshots, ref_code
from ingest import doc_intake
from ingest.golden_store import spec_of
from ingest.lead_store import connect
from ingest.market_csv import _clean
from pipelines import director
from pipelines.director import DirectorConfigError
from pipelines.guardrail import check as guardrail_check
from pipelines.kb_filter import is_alcohol
from pipelines.period import VN_TZ, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RULES_FILE = ROOT / "data" / "label_rules.json"
BLOCK = "production"
OBJECT_TYPE = "label_check"
AGENT = "agent:sx_label"
CATEGORIES = ("tpbvsk", "food", "alcohol")
REG_KINDS = ("dksp", "tu_cong_bo")
MAX_TEXT_BYTES = 1024 * 1024
NO_AUTO = ("Agent CHỈ ĐỀ XUẤT — không tự sửa nhãn, hồ sơ, golden hay "
           "listing; người sửa sau khi GĐ sản xuất duyệt.")
OCR_HELP = ("chưa cấu hình OCR: đặt OCR_PROVIDER=<provider trong nước đã cắm "
            "vào ingest.doc_intake.PROVIDERS> (external-dep, cần hợp đồng + "
            "DPA), hoặc chép chữ trên nhãn ra file .txt rồi dùng --text")

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:[_-][a-z0-9]+)*$")
_LOT_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,31}$")
_DATE = r"(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})(?!\d)"
_NSX_KW = r"\b(?:nsx|ngay\s+san\s+xuat|ngay\s+sx|mfg|mfd)\b"
_HSD_KW = r"\b(?:hsd|han\s+su\s+dung|han\s+dung|exp)\b"
_NSX_RE = re.compile(_NSX_KW + r"[^\d\n]{0,20}?" + _DATE)
_HSD_RE = re.compile(_HSD_KW + r"[^\d\n]{0,20}?" + _DATE)
_HSD_SPAN_RE = re.compile(_HSD_KW + r"[^\d\n]{0,20}?(\d{1,3})\s*(thang|nam)\b")
_DKSP_RE = re.compile(r"(?<!\d)(\d{1,6})\s*/\s*(\d{4})\s*/\s*dksp(?![a-z])")
_TCB_RE = re.compile(r"\bcong\s+bo\b[^\d\n]{0,15}?(\d[a-z0-9/.-]{1,40})")
_QTY_RE = re.compile(r"(?<![\d.,])(\d{1,6})\s*(vien|v|ml)(?![a-z])")
_LOT_KW_RE = re.compile(
    r"\b(?:so\s+lo|lo\s+sx|lo\s+san\s+xuat|lot(?:\s+no)?|batch(?:\s+no)?)"
    r"\b\s*[:.#]?\s*([a-z0-9][a-z0-9-]{2,31})")


class LabelError(ValueError):
    """Cấu hình/file nhãn không dùng được — fail-closed."""


# ---------------------------------------------------------------- chuẩn hóa

def low(s: str) -> str:
    """Bỏ dấu + chữ thường, GIỮ dấu câu (cho regex số/ngày/mã)."""
    s = unicodedata.normalize("NFC", s or "")
    s = s.replace("đ", "d").replace("Đ", "d").replace("Ð", "d")
    s = "".join(c for c in unicodedata.normalize("NFKD", s)
                if not unicodedata.combining(c))
    return s.lower()


def flat(s: str) -> str:
    """`low` + mọi ký tự không phải a-z0-9 thành 1 khoảng trắng, có viền
    khoảng trắng 2 đầu → so cụm theo ranh giới từ bằng `in`."""
    return " " + " ".join(re.sub(r"[^a-z0-9]+", " ", low(s)).split()) + " "


def _has(phrase: str, text_flat: str) -> bool:
    p = flat(phrase)
    return p.strip() != "" and p in text_flat


def _date(d: str, m: str, y: str) -> dt.date | None:
    year = int(y) + (2000 if len(y) == 2 else 0)
    try:
        return dt.date(year, int(m), int(d))
    except ValueError:      # 31/02, tháng 13...
        return None


def _qty(n: str, unit: str) -> str:
    return f"{int(n)} {'ml' if unit == 'ml' else 'viên'}"


def _dksp(n: str, y: str) -> str:
    return f"{int(n)}/{y}/ĐKSP"


def restricted(sku: dict) -> bool:
    return (sku.get("category") == "alcohol"
            or is_alcohol(f"{sku.get('sku_key', '')} {sku.get('name', '')}"))


def sku_ref(sku: dict) -> str:
    """sku_key, hoặc mã tra cứu `H-<sha8>` cho SKU nhóm hạn chế."""
    key = sku["sku_key"]
    if restricted(sku):
        return "H-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:8]
    return key


# ---------------------------------------------------------------- cấu hình

def validate_rules(doc) -> dict:
    if not isinstance(doc, dict) or not (set(doc) - {"_doc"}):
        raise LabelError("label_rules: không có dữ liệu")
    status = doc.get("status")
    if not isinstance(status, str) or not status.strip():
        raise LabelError("label_rules: thiếu 'status'")
    req, mk, reg = (doc.get("required"), doc.get("markers"),
                    doc.get("registration"))
    if not isinstance(req, dict) or set(req) != set(CATEGORIES):
        raise LabelError(f"label_rules.required: phải có đủ {CATEGORIES}")
    if not isinstance(reg, dict) or set(reg) != set(CATEGORIES) or any(
            v is not None and v not in REG_KINDS for v in reg.values()):
        raise LabelError("label_rules.registration: mỗi category là "
                         f"{REG_KINDS} hoặc null")
    if not isinstance(mk, dict) or not set(mk) <= set(CATEGORIES) or any(
            not isinstance(v, list) or not all(
                isinstance(x, str) and flat(x).strip() for x in v)
            for v in mk.values()):
        raise LabelError("label_rules.markers: {category: [cụm không rỗng]}")
    ignore = doc.get("name_ignore", [])
    if not isinstance(ignore, list) or not all(isinstance(x, str)
                                               for x in ignore):
        raise LabelError("label_rules.name_ignore: phải là list chuỗi")
    for cat, items in req.items():
        if not isinstance(items, list):
            raise LabelError(f"label_rules.required.{cat}: phải là list")
        ids = set()
        for i, it in enumerate(items):
            where = f"label_rules.required.{cat}[{i}]"
            if not isinstance(it, dict):
                raise LabelError(f"{where}: phải là object")
            rid, ph, lb = it.get("id"), it.get("phrase"), it.get("label")
            if not isinstance(rid, str) or not _SLUG_RE.match(rid) \
                    or rid in ids:
                raise LabelError(f"{where}.id: slug, không trùng")
            ids.add(rid)
            if not isinstance(ph, str) or not flat(ph).strip():
                raise LabelError(f"{where}.phrase: rỗng")
            if not isinstance(lb, str) or not lb.strip() or len(lb) > 120:
                raise LabelError(f"{where}.label: rỗng hoặc > 120 ký tự")
            # label đi vào hàng duyệt → phải sạch guardrail ngay từ config.
            if not guardrail_check(lb).get("ok"):
                raise LabelError(f"{where}.label: trượt guardrail — viết "
                                 "mô tả trung tính")
    return {"status": status.strip(), "required": req, "markers": mk,
            "registration": reg,
            "name_ignore": {flat(x).strip() for x in ignore}}


def load_rules(path=None) -> dict:
    p = Path(path or RULES_FILE)
    try:
        text = p.read_bytes().decode("utf-8-sig")
        doc = json.loads(text)
    except FileNotFoundError as e:
        raise LabelError(f"thiếu file {p.name}") from e
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise LabelError(f"không đọc được {p.name} ({type(e).__name__})") \
            from e
    return validate_rules(doc)


# ---------------------------------------------------------------- trích (THUẦN)

def extract(text: str) -> dict:
    """Chữ trên nhãn → field trích tất định. Không giữ nguyên văn nhãn."""
    lo = low(text)
    nsx = sorted({d for m in _NSX_RE.finditer(lo)
                  if (d := _date(m.group(1), m.group(2), m.group(3)))})
    hsd = sorted({d for m in _HSD_RE.finditer(lo)
                  if (d := _date(m.group(1), m.group(2), m.group(3)))})
    span = sorted({int(m.group(1)) * (12 if m.group(2) == "nam" else 1)
                   for m in _HSD_SPAN_RE.finditer(lo)})
    lots = sorted({c for m in _LOT_KW_RE.finditer(lo)
                   if _LOT_RE.match(c := m.group(1).upper())
                   and any(ch.isdigit() for ch in c)})
    return {"flat": flat(text),
            "dksp": sorted({_dksp(m.group(1), m.group(2))
                            for m in _DKSP_RE.finditer(lo)}),
            "tu_cong_bo": sorted({m.group(1).upper()
                                  for m in _TCB_RE.finditer(lo)}),
            "qty": sorted({_qty(m.group(1), m.group(2))
                           for m in _QTY_RE.finditer(lo)}),
            "nsx": nsx, "hsd": hsd, "hsd_months": span, "lots": lots}


def name_tokens(name: str, ignore: set) -> list[str]:
    """Từ chữ (≥2 ký tự, không số) của tên golden phải có trên nhãn."""
    out = []
    for t in flat(name).split():
        if len(t) >= 2 and not t.isdigit() and not any(c.isdigit()
                                                       for c in t) \
                and t not in ignore and t not in out:
            out.append(t)
    return out


# ---------------------------------------------------------------- so (THUẦN)

def _fmt(d: dt.date) -> str:
    return d.strftime("%d/%m/%Y")


def _list(xs) -> str:
    return ", ".join(xs) if xs else "(không đọc được)"


def compare(fields: dict, sku: dict, rules: dict, listings: list[dict],
            lots: dict, today: dt.date) -> list[dict]:
    """→ [{kind, msg}] — msg là TEMPLATE an toàn (số/ngày/mã + mô tả trong
    config), không chép chữ tự do của nhãn/listing. `lots` = {mã lô: {sku_key,
    mfg_date, exp_date, intake_status}} cho mã lô đọc được trên nhãn."""
    out = []
    cat, tf = sku.get("category"), fields["flat"]
    hidden = restricted(sku)

    def add(kind, msg):
        out.append({"kind": kind, "msg": msg})

    # 1. tên
    miss = [t for t in name_tokens(sku.get("name") or "",
                                   rules["name_ignore"])
            if f" {t} " not in tf]
    if miss:
        add("ten_thieu_tu", (f"tên trên nhãn thiếu {len(miss)} từ của tên "
                             "golden" if hidden else
                             f"tên trên nhãn thiếu từ của tên golden: "
                             f"{', '.join(miss)}"))
    # 2. nhóm sản phẩm (marker của category khác)
    def group(c):   # tên nhóm rượu không vào hàng duyệt (guardrail chặn)
        return "nhóm hạn chế" if c == "alcohol" else f"nhóm {c}"

    for mcat, phrases in sorted(rules["markers"].items()):
        if mcat != cat and any(_has(p, tf) for p in phrases):
            add("nhom_lech", f"nhãn có dấu hiệu {group(mcat)} nhưng golden "
                f"thuộc {group(cat)}")
    # 3. cụm bắt buộc
    for it in rules["required"].get(cat, []):
        if not _has(it["phrase"], tf):
            add("bat_buoc_thieu", f"nhãn thiếu: {it['label']}")
    # 4. số đăng ký
    reg = rules["registration"].get(cat)
    if reg == "dksp":
        golden = None
        g = _DKSP_RE.search(low(sku.get("receipt_no") or ""))
        if g:
            golden = _dksp(g.group(1), g.group(2))
        if golden is None:
            add("dang_ky_golden_thieu", "golden chưa có số ĐKSP hợp lệ — "
                f"chưa đối chiếu được (nhãn ghi: {_list(fields['dksp'])})")
        elif not fields["dksp"]:
            add("dang_ky_thieu", f"nhãn không có số ĐKSP (golden {golden})")
        elif fields["dksp"] != [golden]:
            add("dang_ky_lech", f"số ĐKSP: nhãn ghi {_list(fields['dksp'])}"
                f"; golden {golden}")
    elif reg == "tu_cong_bo" and not fields["tu_cong_bo"]:
        add("dang_ky_thieu", "nhãn không có số tự công bố")
    # 5. quy cách (golden pack_spec: số đầu tiên + viên|ml là TỔNG)
    gspec = spec_of(sku.get("pack_spec"))
    if gspec and gspec not in fields["qty"]:
        add("quy_cach_lech", f"quy cách: nhãn ghi {_list(fields['qty'])}; "
            f"golden {gspec}")
    # 6. NSX/HSD
    nsx, hsd = fields["nsx"], fields["hsd"]
    if not hsd and not fields["hsd_months"]:
        add("hsd_thieu", "nhãn không đọc được HSD (ngày hoặc số tháng)")
    if len(nsx) > 1 or len(hsd) > 1:
        add("ngay_nhieu", "nhãn có nhiều NSX/HSD khác nhau: NSX "
            f"{_list([_fmt(d) for d in nsx])}; HSD "
            f"{_list([_fmt(d) for d in hsd])}")
    if nsx and hsd and min(hsd) <= max(nsx):
        add("hsd_truoc_nsx", f"HSD {_fmt(min(hsd))} không sau NSX "
            f"{_fmt(max(nsx))}")
    if hsd and min(hsd) < today:
        add("het_han", f"HSD trên nhãn {_fmt(min(hsd))} đã qua "
            f"(hôm nay {_fmt(today)})")
    # 7. hồ sơ lô
    for code in fields["lots"]:
        lot = lots.get(code)
        if lot is None:
            add("lo_khong_ho_so", f"mã lô {code} trên nhãn chưa có hồ sơ lô")
            continue
        if lot["sku_key"] != sku["sku_key"]:
            add("lo_khac_sku", f"mã lô {code} thuộc SKU khác trong hồ sơ lô")
            continue
        if lot.get("intake_status") != "passed":
            add("lo_chua_kiem", f"mã lô {code}: hồ sơ lô chưa kiểm nhập "
                f"đạt ({lot.get('intake_status')})")
        if nsx and lot["mfg_date"] not in nsx:
            add("lo_nsx_lech", f"mã lô {code}: NSX nhãn "
                f"{_list([_fmt(d) for d in nsx])}; hồ sơ lô "
                f"{_fmt(lot['mfg_date'])}")
        if hsd and lot["exp_date"] not in hsd:
            add("lo_hsd_lech", f"mã lô {code}: HSD nhãn "
                f"{_list([_fmt(d) for d in hsd])}; hồ sơ lô "
                f"{_fmt(lot['exp_date'])}")
    # 8. listing mới nhất mỗi kênh
    for r in listings:
        lspec = spec_of(r.get("title"))
        if lspec and fields["qty"] and lspec not in fields["qty"]:
            add("listing_quy_cach_lech", f"listing {r['channel']} mã "
                f"{ref_code(r.get('item_id'))} ghi {lspec}; nhãn ghi "
                f"{_list(fields['qty'])}")
    return out


def _sha(obj) -> str:
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def payload_of(sku: dict, findings: list[dict], text_sha: str
               ) -> tuple[str, str, str]:
    """→ (object_id, title, payload) dựng từ TEMPLATE. Payload trượt
    guardrail → bản rút gọn (số đếm + mã), không đẩy chữ bẩn."""
    ref = sku_ref(sku)
    oid = f"sxlabel:{ref}:{text_sha[:12]}:{_sha(findings)[:8]}"
    title = f"Đối soát nhãn — SKU {ref}: {len(findings)} điểm lệch"
    head = (f"Đối soát nhãn (SX, NHÁP) — SKU {ref}; nguồn nhãn sha256 "
            f"{text_sha[:12]}.")
    lines = [head, *[f"- {f['msg']}" for f in findings], NO_AUTO]
    payload = "\n".join(lines)
    if not guardrail_check(payload).get("ok"):
        payload = (f"Đối soát nhãn (SX, NHÁP) — SKU {ref}; nguồn nhãn sha256 "
                   f"{text_sha[:12]}; {len(findings)} điểm lệch (chi tiết bị "
                   "ẩn vì không qua guardrail — người duyệt chạy lại "
                   "python -m agents.sx_label với cùng file nhãn).\n" + NO_AUTO)
    return oid, title, payload


# ---------------------------------------------------------------- đọc nhãn

def read_text_file(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_TEXT_BYTES:
            raise LabelError(f"{path.name} quá lớn (> 1 MB)")
        text = path.read_bytes().decode("utf-8-sig")
    except FileNotFoundError as e:
        raise LabelError(f"không thấy file {path.name}") from e
    except (OSError, UnicodeDecodeError) as e:
        raise LabelError(f"không đọc được {path.name} ({type(e).__name__})") \
            from e
    if not text.strip():
        raise LabelError(f"{path.name} rỗng")
    return unicodedata.normalize("NFC", text)


class OcrUnavailable(Exception):
    """OCR chưa cấu hình / provider bị từ chối → exit 2 kèm hướng dẫn."""


def read_image(path: Path, provider: str) -> str:
    ext = path.suffix.lower()
    if ext not in (*doc_intake.IMAGE_EXTS, doc_intake.PDF_EXT):
        raise LabelError(f"đuôi {ext or '(không có)'} không nhận — dùng "
                         f"{', '.join((*doc_intake.IMAGE_EXTS, '.pdf'))}")
    if provider not in doc_intake.PROVIDERS:
        raise OcrUnavailable(f"OCR_PROVIDER={provider} chưa hỗ trợ — "
                             + OCR_HELP)
    if not doc_intake.PROVIDERS[provider][1]:
        raise OcrUnavailable("provider OCR nước ngoài bị từ chối (luật "
                             "doc_intake) — " + OCR_HELP)
    if not path.is_file():
        raise LabelError(f"không thấy file {path.name}")
    if ext != doc_intake.PDF_EXT and provider == "none":
        raise OcrUnavailable(OCR_HELP)
    try:
        text, _pages, src = doc_intake.extract_text(path, provider)
    except doc_intake.DocError as e:
        raise LabelError(str(e)) from e
    if src == "none":
        if provider == "none":
            raise OcrUnavailable("PDF không có lớp chữ — " + OCR_HELP)
        raise LabelError("OCR không ra chữ — chụp lại ảnh rõ hơn")
    return text


# ---------------------------------------------------------------- DB (SELECT)

def golden_sku(conn, key: str) -> dict | None:
    row = conn.execute("select sku_key, name, category, pack_spec, receipt_no"
                       " from sku_master where sku_key = %s", (key,)
                       ).fetchone()
    return dict(zip(("sku_key", "name", "category", "pack_spec",
                     "receipt_no"), row)) if row else None


def latest_listings(conn, key: str) -> list[dict]:
    snaps = listing_snapshots(conn)
    if not snaps:
        return []
    return [{"channel": ch, "item_id": iid, "title": title}
            for ch, iid, title in conn.execute(
                "select channel, item_id, title from market_rows"
                " where snapshot_id = any(%s) and sku_key = %s"
                " order by channel, row_no",
                (list(snaps.values()), key)).fetchall()]


def lot_records(conn, codes: list[str]) -> dict:
    if not codes:
        return {}
    return {c: {"sku_key": s, "mfg_date": m, "exp_date": e,
                "intake_status": st}
            for c, s, m, e, st in conn.execute(
                "select lot_code, sku_key, mfg_date, exp_date, intake_status"
                " from production_lots where lot_code = any(%s)",
                (codes,)).fetchall()}


def already_queued(conn, oid: str) -> bool:
    return conn.execute("select exists (select 1 from approval_queue where"
                        " object_type = %s and object_id = %s)",
                        (OBJECT_TYPE, oid)).fetchone()[0]


# ---------------------------------------------------------------- CLI

def _run(args, text: str, rules: dict, cfg: dict) -> int:
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        sku = golden_sku(conn, args.sku)
        if sku is None:
            print(f"[error] SKU {_clean(args.sku)} không có trong golden "
                  "(sku_master) — chạy python -m ingest.golden_store",
                  file=sys.stderr)
            return 1
        fields = extract(text)
        today = vn_date(datetime.now(VN_TZ))
        findings = compare(fields, sku, rules,
                           latest_listings(conn, sku["sku_key"]),
                           lot_records(conn, fields["lots"]), today)
        text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        ref = sku_ref(sku)
        print(f"[label] luật nhãn: {rules['status']}")
        if ref != sku["sku_key"]:
            print(f"[label] SKU {sku['sku_key']} → mã tra cứu {ref} "
                  "(nhóm hạn chế — hàng duyệt chỉ ghi mã này)")
        print(f"[label] nhãn sha256 {text_sha[:12]} · trích: ĐKSP "
              f"{_list(fields['dksp'])} · quy cách {_list(fields['qty'])} · "
              f"NSX {_list([_fmt(d) for d in fields['nsx']])} · HSD "
              f"{_list([_fmt(d) for d in fields['hsd']])} · lô "
              f"{_list(fields['lots'])}")
        for f in findings:
            print(f"  - [{f['kind']}] {f['msg']}")
        if not findings:
            print("[ok] không thấy lệch so với golden/hồ sơ lô/listing — "
                  "không đẩy hàng duyệt")
            return 0
        oid, title, payload = payload_of(sku, findings, text_sha)
        if not args.submit:
            print(f"[dry] {len(findings)} điểm lệch — thêm --submit để đẩy "
                  f"mục {OBJECT_TYPE} khối {BLOCK} (không ghi DB)")
            return 0
        if already_queued(conn, oid):
            print(f"[skip] đợt này đã có trong hàng duyệt ({oid})")
            conn.commit()
            return 0
        qid = director.submit(conn, BLOCK, OBJECT_TYPE, oid, title, payload,
                              AGENT, cfg=cfg)
        conn.commit()
        print(f"[submit] hàng duyệt #{qid} ({OBJECT_TYPE}, khối {BLOCK}) — "
              "chờ GĐ sản xuất duyệt")
        return 0
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[error] lỗi DB: {_clean(_db_msg(e), 300)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.sx_label",
        description="Đối soát nhãn: chữ trên nhãn ↔ golden, hồ sơ lô, listing"
                    " → NHÁP hàng duyệt label_check (không LLM, không sửa gì)")
    ap.add_argument("--sku", required=True, help="sku_key trong golden")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", type=Path, metavar="FILE",
                     help="file chữ trên nhãn (.txt, UTF-8)")
    src.add_argument("--image", type=Path, metavar="FILE",
                     help="ảnh/PDF nhãn → OCR qua provider của doc_intake")
    ap.add_argument("--submit", action="store_true",
                    help="đẩy mục label_check vào hàng duyệt khối production")
    args = ap.parse_args(argv)
    if not _SLUG_RE.match(args.sku) or len(args.sku) > 64:
        ap.error("--sku phải là slug a-z0-9-_")
    try:
        rules = load_rules()
        cfg = director.load_config(BLOCK)
        if OBJECT_TYPE not in cfg["object_types"]:
            raise DirectorConfigError(f"{BLOCK}.json thiếu loại việc "
                                      f"{OBJECT_TYPE}")
        if args.text is not None:
            text = read_text_file(args.text)
        else:
            text = read_image(args.image,
                              os.environ.get("OCR_PROVIDER", "").strip()
                              or "none")
    except OcrUnavailable as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    except (LabelError, DirectorConfigError) as e:
        print(f"[error] {e} — không connect", file=sys.stderr)
        return 1
    return _run(args, text, rules, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
