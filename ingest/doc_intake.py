"""v3.8 WP04b / F15.1 — số hóa tài liệu công ty vào hệ thống CÓ KIỂM SOÁT.

Luồng (flows_infra.md F15.1): thư mục intake → sha256 → bản gốc bất
biến `originals/<sha256>` → trích text (pypdf; scan/ảnh → provider OCR
cắm được) → quét PII → trích field pháp lý bằng regex TẤT ĐỊNH → bảng
`documents` + `document_fields` (chưa xác minh) → Pháp chế chạy CLI
`--verify <sha256> --by "<tên>"`.

Contract:
  - `doc_type` = thư mục con `intake/<loai>/` (`giay_tiep_nhan`, `nhan`,
    `hop_dong_dai_ly`, `ho_so_vung_trong`); file ở gốc/thư mục lạ → `khac`.
    Đuôi nhận `.pdf/.jpg/.jpeg/.png` (ảnh luôn đi nhánh OCR, pages=1);
    file 0 byte / đuôi lạ / symlink → skipped (đếm). Intake KHÔNG xoá,
    KHÔNG di chuyển file trong thư mục intake.
  - Bản gốc: ghi file tạm cùng thư mục rồi `os.link` → đích KHÔNG bao
    giờ bị ghi đè (đã có → giữ nguyên; có mà lệch hash → cảnh báo, bỏ
    qua tài liệu, đếm error).
  - Idempotent theo sha256: đã có trong `documents` → `dup`, KHÔNG trích
    lại, KHÔNG đụng field (kể cả field đã verified); insert
    `on conflict do nothing` chặn race.
  - Scan vs text quyết THEO TRANG: 1 trang < `SCAN_MIN_CHARS` ký tự
    (trang scan kèm watermark/footer, bìa đánh máy + trang scan) → cả
    tài liệu đi nhánh OCR (provider `none` → `cho_ocr`, pii NULL).
  - `status`: `cho_ocr` (chưa có text — scan/ảnh, provider `none`) |
    `pending_review` (có text, chờ người) | `verified` | `rejected` (chỉ
    CLI người thật đổi). `pii_flag` NULL = chưa quét được (chưa có text).
  - **PII / LLM:** `pii_flag` = có SĐT/email theo `pipelines.pii._mask_pii`
    KHÔNG allowlist (allowlist liên hệ công ty chưa được Pháp chế duyệt
    → mọi SĐT/email là PII; CCCD 12 số đầu 0 cũng trúng alt SĐT). Tài
    liệu `pii_flag` true HOẶC NULL KHÔNG được gửi LLM. Module này không
    có lời gọi LLM/mạng nào — field trích bằng regex.
  - **OCR:** registry `PROVIDERS` name → (callable(path)->str, domestic).
    Chỉ có `none` (trả "" → `cho_ocr`). Provider nước ngoài
    (`domestic=False`) bị TỪ CHỐI cho mọi tài liệu (trước OCR chưa biết
    PII → coi như có PII; bật = phiếu tầng 2 + TIA). FPT.AI Reader /
    Google Vision = external-dep, chưa cắm.
    v13.4: CLI intake KHÔNG báo thành công câm khi thiếu OCR — có tài
    liệu scan/ảnh vào `cho_ocr` mà `OCR_PROVIDER` chưa cấu hình (`none`)
    → in `[blocked]` kèm hướng dẫn + exit 2 (tài liệu có lớp chữ vẫn
    nạp; lỗi file vẫn exit 1). Provider nước ngoài trong registry → từ
    chối ngay (exit 2 / ValueError), không âm thầm trả "".
    BLOCKED: vendor OCR trong nước + hợp đồng/DPA + key (Bên B/Pháp chế).
    r13: thêm `paddle_local` = OCR TẠI CHỖ (PaddleOCR, model latin cục bộ,
    không mạng, không tự tải model) — PDF scan render từng trang (PyMuPDF),
    ≤ OCR_MAX_PAGES trang, quá OCR_TIMEOUT_S → lỗi; engine ghi
    `documents.ocr_engine`. Là lựa chọn kỹ thuật THỬ (chữ Việt mất một phần
    dấu thanh) — Bên B/Pháp chế vẫn quyết engine/vendor dùng thật; kết quả
    luôn `pending_review` chờ người `--verify`.
  - Không lưu full text vào DB, không in filename/nội dung ra stdout —
    chỉ `sha256[:12]`, `doc_type`, `status`, số đếm.
  - Đợt hợp đồng (G3): `--reprocess-pending` — khi đã cắm provider TRONG
    NƯỚC (`OCR_PROVIDER` ≠ none), OCR lại tài liệu `cho_ocr` từ BẢN GỐC
    (kiểm lại sha256 trước khi đọc; lệch → error, không đụng) → có chữ thì
    `cho_ocr → pending_review` (UPDATE có điều kiện status, chạy lại/song
    song không nhân đôi) + quét PII + field nháp; vẫn chờ Pháp chế
    `--verify`, KHÔNG bao giờ tự `verified`. Provider none → `[blocked]`
    exit 2, 0 truy vấn ghi. Chạy cùng login với intake.

Chạy: `python -m ingest.doc_intake` (intake, cấu hình `DOC_INTAKE_DIR`,
`DOC_ORIGINALS_DIR`, `OCR_PROVIDER`) · `--pending` · `--verify <sha256>
--by "<tên>"` · `--reject <sha256> --by "<tên>"` · `--reprocess-pending`.
"""

import argparse
import hashlib
import logging
import os
import re
import sys
import tempfile
import unicodedata
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from pypdf import PdfReader

from ingest import lead_store
from pipelines.pii import _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

# pypdf warning PDF lỗi định dạng chỉ là nhiễu — lỗi thật đã raise.
logging.getLogger("pypdf").setLevel(logging.ERROR)

ROOT = Path(__file__).resolve().parent.parent
DOC_TYPES = ("giay_tiep_nhan", "nhan", "hop_dong_dai_ly", "ho_so_vung_trong")
PDF_EXT = ".pdf"
IMAGE_EXTS = (".jpg", ".jpeg", ".png")
# Ngưỡng ký tự không-trắng MỖI TRANG. Chỉ cần 1 trang dưới ngưỡng → cả
# tài liệu coi là bản scan, đi nhánh OCR (fail-closed: pii_flag NULL).
# Trang scan hay mang lớp text nhỏ — watermark "Scanned with CamScanner"
# (21), footer "Trang 1/10" — nên ngưỡng tổng/ngưỡng thấp xếp nhầm vào
# pdf_text → quét PII trên watermark → pii_flag=False sai. Trang đánh
# máy thật (giấy tiếp nhận) có hàng trăm ký tự; trang chữ ký ngắn/trang
# trắng bị đẩy sang cho_ocr là lệch về phía an toàn.
SCAN_MIN_CHARS = 50
SHA_RE = re.compile(r"[0-9a-f]{64}")
CHUNK = 1 << 20


def _ocr_none(path: Path) -> str:
    """Provider mặc định: không OCR, không mạng → tài liệu ở `cho_ocr`."""
    return ""


# r13: OCR CHẠY TẠI CHỖ (PaddleOCR 2.x, model nhận dạng latin — chữ Việt mất
# một phần dấu thanh) — ảnh/PDF KHÔNG rời máy chủ nên `domestic=True` đúng
# nghĩa (xử lý trên server Sâm Sâm). Lựa chọn kỹ thuật THỬ, không phải quyết
# định chọn vendor. Model chỉ đọc từ thư mục cục bộ đã có (KHÔNG tự tải):
# OCR_PADDLE_MODEL_DIR (mặc định ~/.paddleocr/whl) phải chứa det/en/
# en_PP-OCRv3_det_infer + rec/latin/latin_PP-OCRv3_rec_infer.
OCR_MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "30"))
OCR_TIMEOUT_S = float(os.environ.get("OCR_TIMEOUT_S", "300"))
OCR_PDF_DPI = 200
_PADDLE_SUBDIRS = {"det": ("det", "en", "en_PP-OCRv3_det_infer"),
                   "rec": ("rec", "latin", "latin_PP-OCRv3_rec_infer"),
                   # PaddleOCR 2.x luôn tải model cls nếu thiếu thư mục, kể cả
                   # use_angle_cls=False → phải có sẵn + truyền tường minh.
                   "cls": ("cls", "ch_ppocr_mobile_v2.0_cls_infer")}
# PaddleOCR 2.x (`maybe_download`) tự tải bộ model khi thiếu pdiparams HOẶC
# pdmodel → cổng phải đòi đủ cả hai (rỗng 0 byte = thiếu: engine nạp sẽ chết).
_PADDLE_FILES = ("inference.pdmodel", "inference.pdiparams")
_paddle = None   # engine nạp 1 lần / tiến trình (nạp model ~10 s)


def _paddle_engine():
    global _paddle
    if _paddle is None:
        root = Path(os.environ.get("OCR_PADDLE_MODEL_DIR", "").strip()
                    or Path.home() / ".paddleocr" / "whl")
        dirs = {k: root.joinpath(*v) for k, v in _PADDLE_SUBDIRS.items()}
        missing = [k for k, d in dirs.items()
                   if not all((d / f).is_file() and (d / f).stat().st_size
                              for f in _PADDLE_FILES)]
        if missing:  # thiếu model → từ chối, KHÔNG để PaddleOCR tự tải mạng
            raise DocError("thiếu model OCR cục bộ ("
                           + ", ".join(missing) + ") ở OCR_PADDLE_MODEL_DIR")
        try:
            from paddleocr import PaddleOCR
        except ImportError:
            raise DocError("chưa cài paddleocr — provider paddle_local"
                           " không dùng được") from None
        logging.getLogger("ppocr").setLevel(logging.ERROR)
        _paddle = PaddleOCR(lang="vi", use_angle_cls=False, show_log=False,
                            det_model_dir=str(dirs["det"]),
                            rec_model_dir=str(dirs["rec"]),
                            cls_model_dir=str(dirs["cls"]))
    return _paddle


def _page_images(path: Path) -> list:
    """Ảnh RGB (numpy) từng trang: PDF → render PyMuPDF ở OCR_PDF_DPI;
    JPG/PNG → Pillow (kiểm định dạng theo nội dung). Quá OCR_MAX_PAGES /
    hỏng → DocError."""
    import numpy as np
    from PIL import Image, UnidentifiedImageError
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(b"%PDF"):
        import fitz
        try:
            doc = fitz.open(path)
        except Exception as e:  # noqa: BLE001 — PDF hỏng
            raise DocError(f"PDF hỏng: {type(e).__name__}") from None
        with doc:
            if doc.needs_pass:
                raise DocError("PDF mã hoá")
            if doc.page_count > OCR_MAX_PAGES:
                raise DocError(f"PDF {doc.page_count} trang > OCR_MAX_PAGES"
                               f"={OCR_MAX_PAGES}")
            out = []
            for page in doc:
                pix = page.get_pixmap(dpi=OCR_PDF_DPI, alpha=False)
                out.append(np.frombuffer(pix.samples, dtype=np.uint8)
                           .reshape(pix.height, pix.width, pix.n)[:, :, :3])
            return out
    try:
        with Image.open(path) as im:
            if im.format not in ("JPEG", "PNG"):
                raise DocError(f"ảnh định dạng {im.format} không nhận")
            return [np.asarray(im.convert("RGB"))]
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError,
            SyntaxError) as e:
        raise DocError(f"ảnh hỏng/không đọc được: {type(e).__name__}") from None


def _ocr_paddle_local(path: Path) -> str:
    """OCR tại chỗ từng trang → text (dòng theo thứ tự engine trả). Quá
    OCR_TIMEOUT_S → DocError (luồng OCR bị bỏ, không ghi kết quả muộn)."""
    import threading
    pages = _page_images(path)
    engine = _paddle_engine()
    box: dict = {}

    def work():
        try:
            lines = []
            for img in pages:
                for res in engine.ocr(img, cls=False) or []:
                    lines += [ln[1][0] for ln in res or [] if ln and ln[1]]
            box["text"] = "\n".join(lines)
        except Exception as e:  # noqa: BLE001 — chuyển về luồng gọi
            box["err"] = e
    th = threading.Thread(target=work, name="ocr-paddle", daemon=True)
    th.start()
    th.join(OCR_TIMEOUT_S)
    if th.is_alive():
        raise DocError(f"OCR quá {OCR_TIMEOUT_S:g} giây — bỏ")
    if "err" in box:
        raise DocError(f"OCR lỗi ({type(box['err']).__name__})")
    return box.get("text", "")


# name -> (callable(path) -> text, domestic). Vendor có phí (FPT.AI Reader…)
# là external-dep: hợp đồng + DPA trước khi cắm.
PROVIDERS = {"none": (_ocr_none, True),
             "paddle_local": (_ocr_paddle_local, True)}
# Ghi vào documents.ocr_engine (truy vết engine/model tạo text OCR).
OCR_ENGINES = {"paddle_local": "paddleocr-2.x/latin_PP-OCRv3"}
OCR_BLOCKED = ("OCR_PROVIDER chưa cấu hình — BLOCKED: vendor OCR trong nước "
               "+ hợp đồng/DPA + key (Bên B/Pháp chế chọn), cắm vào "
               "ingest.doc_intake.PROVIDERS; tạm thời người đọc bản gốc rồi "
               "nhập tay")


class DocError(Exception):
    """Lỗi 1 tài liệu (PDF hỏng/mã hoá, bản gốc lệch hash) — lô chạy tiếp."""


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def store_original(path: Path, sha: str, originals_dir: Path) -> bool:
    """Lưu bản gốc bất biến `originals_dir/<sha>`. True = vừa ghi, False =
    đã có đúng hash. Đích có sẵn mà lệch hash → DocError, KHÔNG ghi đè.
    Ghi qua file tạm cùng thư mục + `os.link` (fail nếu đích tồn tại) —
    không bao giờ `os.replace`. Hash tính lại trong lúc copy: file nguồn
    đổi giữa chừng → DocError, không lưu bản lệch tên."""
    if not SHA_RE.fullmatch(sha):
        raise ValueError("sha256 không hợp lệ")
    originals_dir.mkdir(parents=True, exist_ok=True)
    dest = originals_dir / sha
    if dest.exists():
        if sha256_file(dest) != sha:
            raise DocError("bản gốc lệch hash — không ghi đè")
        return False
    fd, tmp = tempfile.mkstemp(dir=originals_dir, prefix=".tmp-")
    try:
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out, open(path, "rb") as src:
            while block := src.read(CHUNK):
                h.update(block)
                out.write(block)
            out.flush()
            os.fsync(out.fileno())
        if h.hexdigest() != sha:
            raise DocError("file nguồn đổi trong lúc intake")
        try:
            os.link(tmp, dest)
        except FileExistsError:
            # Race với process khác: đích vừa xuất hiện → kiểm hash.
            if sha256_file(dest) != sha:
                raise DocError("bản gốc lệch hash — không ghi đè") from None
            return False
        return True
    finally:
        os.unlink(tmp)


def _nonspace_len(text: str) -> int:
    return sum(1 for c in text if not c.isspace())


def _ocr(path: Path, provider: str) -> str:
    fn, domestic = PROVIDERS[provider]
    if not domestic:
        # PII chưa biết trước khi OCR → coi như có PII → cấm nước ngoài.
        return ""
    return unicodedata.normalize("NFC", fn(path) or "")


def pdf_page_texts(path: Path) -> list[str]:
    """Text NFC từng trang PDF (pypdf, không mạng). PDF mã hoá/hỏng →
    DocError. Tách ra từ `extract_text` (v9.5) để đọc PDF local mà không
    đi qua provider OCR/DB."""
    try:
        with open(path, "rb") as f:
            reader = PdfReader(f)
            if reader.is_encrypted:
                raise DocError("PDF mã hoá")
            return [unicodedata.normalize("NFC", p.extract_text() or "")
                    for p in reader.pages]
    except DocError:
        raise
    except Exception as e:  # noqa: BLE001 — pypdf raise đủ loại trên PDF hỏng
        raise DocError(f"PDF hỏng: {type(e).__name__}") from None


def extract_text(path: Path, provider: str = "none",
                 ext: str | None = None) -> tuple[str, int, str]:
    """→ (text NFC, pages, text_source pdf_text|ocr|none). PDF mã hoá /
    hỏng → DocError. Không mạng trừ khi provider (domestic) tự gọi.
    `ext` cho file không đuôi (bản gốc `originals/<sha256>`)."""
    ext = (ext or path.suffix).lower()
    if ext == PDF_EXT:
        texts = pdf_page_texts(path)
        pages = len(texts)
        # Quyết định scan THEO TRANG (xem SCAN_MIN_CHARS): mọi trang đủ
        # text mới là pdf_text; còn lại cả tài liệu chờ OCR.
        if texts and all(_nonspace_len(t) >= SCAN_MIN_CHARS for t in texts):
            return "\n".join(texts), pages, "pdf_text"
    else:
        pages = 1
    text = _ocr(path, provider)
    if _nonspace_len(text) == 0:
        return "", pages, "none"
    return text, pages, "ocr"


def has_pii(text: str) -> bool:
    """SĐT/email (không allowlist). Đếm token '***' thay vì so sánh
    chuỗi: `_mask_pii` còn unwrap ngoặc toàn-digit "(1500)" → " 1500 "
    (text đổi dù không có PII → so `!=` báo oan)."""
    return _mask_pii(text).count("***") > text.count("***")


# --- trích field giấy tiếp nhận (regex tất định, KHÔNG LLM) ---------------
# Đ có thể ra U+0110 (Đ) hoặc U+00D0 (Ð, font map lệch) tùy PDF.
_SO_GIAY_RE = re.compile(r"(?<!\d)\d{1,6}/\d{4}/[ĐÐD]KSP(?![A-Za-z])",
                         re.IGNORECASE)
_NGAY_CHU_RE = re.compile(
    r"ng[àa]y\s+(\d{1,2})\s+th[áa]ng\s+(\d{1,2})\s+n[ăa]m\s+(\d{4})(?!\d)",
    re.IGNORECASE)
_NGAY_SO_RE = re.compile(r"(?<!\d)(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?!\d)")
_TEN_SP_RE = re.compile(r"t[êe]n\s+s[ảa]n\s+ph[ẩa]m\s*:[ \t]*([^\n]*)",
                        re.IGNORECASE)
TEN_SP_MAX = 200


def _iso(d: str, m: str, y: str) -> str | None:
    try:
        return date(int(y), int(m), int(d)).isoformat()
    except ValueError:  # 31/02, tháng 13...
        return None


def _pick(cands: list[str]) -> tuple[str, float] | None:
    """Ứng viên đầu; confidence 1.0 nếu đúng 1 giá trị khác nhau, 0.5 nếu >1."""
    if not cands:
        return None
    return cands[0], (1.0 if len(set(cands)) == 1 else 0.5)


def extract_fields(text: str) -> dict[str, tuple[str, float]]:
    """→ {field: (value, confidence)} cho giấy tiếp nhận. Không khớp →
    không có key. Ngày dạng chữ "ngày d tháng m năm yyyy" ưu tiên, chỉ
    fallback dd/mm/yyyy khi không có dạng chữ hợp lệ."""
    text = unicodedata.normalize("NFC", text)
    out = {}
    so = _pick([m.group(0) for m in _SO_GIAY_RE.finditer(text)])
    if so:
        out["so_giay"] = so
    ngay = [v for m in _NGAY_CHU_RE.finditer(text)
            if (v := _iso(m.group(1), m.group(2), m.group(3)))]
    if not ngay:
        ngay = [v for m in _NGAY_SO_RE.finditer(text)
                if (v := _iso(m.group(1), m.group(3), m.group(4)))]
    if p := _pick(ngay):
        out["ngay_cap"] = p
    # Bỏ ký tự điều khiển (ESC/CR...) — value in ra terminal ở --pending.
    ten = [s[:TEN_SP_MAX] for m in _TEN_SP_RE.finditer(text)
           if (s := "".join(c for c in m.group(1) if c.isprintable())
               .strip())]
    if p := _pick(ten):
        out["ten_san_pham"] = p
    return out


# --- intake -----------------------------------------------------------------
def doc_type_of(path: Path, intake_dir: Path) -> str:
    parts = path.relative_to(intake_dir).parts
    return parts[0] if len(parts) >= 2 and parts[0] in DOC_TYPES else "khac"


def _process(path: Path, intake_dir: Path, originals_dir: Path, conn,
             provider: str) -> tuple[str, str, str]:
    """1 file → (new|dup, sha, info in được). Raise DocError/OSError/
    psycopg.Error cho caller đếm error."""
    sha = sha256_file(path)
    store_original(path, sha, originals_dir)
    if conn.execute("select status from documents where sha256 = %s",
                    (sha,)).fetchone():
        return "dup", sha, "trùng — bỏ qua"
    dtype = doc_type_of(path, intake_dir)
    # Trích từ BẢN GỐC đã kiểm hash (không đọc lại file intake — file
    # nguồn đổi sau khi hash thì field vẫn khớp đúng sha256 đã lưu).
    text, pages, source = extract_text(originals_dir / sha, provider,
                                       path.suffix)
    if source == "none":
        status, pii, fields = "cho_ocr", None, {}
    else:
        status, pii = "pending_review", has_pii(text)
        fields = extract_fields(text) if dtype == "giay_tiep_nhan" else {}
    cur = conn.execute(
        "insert into documents (sha256, filename, doc_type, pages,"
        " text_source, pii_flag, status) values (%s, %s, %s, %s, %s, %s, %s)"
        " on conflict (sha256) do nothing",
        (sha, path.name, dtype, pages, source, pii, status))
    if cur.rowcount != 1:  # process khác vừa insert cùng sha
        conn.rollback()
        return "dup", sha, "trùng — bỏ qua"
    if source == "ocr" and OCR_ENGINES.get(provider):   # cùng giao dịch
        conn.execute("update documents set ocr_engine = %s where sha256 = %s",
                     (OCR_ENGINES[provider], sha))
    for field, (value, conf) in fields.items():
        conn.execute(
            "insert into document_fields (sha256, field, value, confidence,"
            " verified) values (%s, %s, %s, %s, false)"
            " on conflict (sha256, field) do nothing",
            (sha, field, value, conf))
    conn.commit()
    return (("cho_ocr" if status == "cho_ocr" else "new"), sha,
            f"{dtype} {status} fields={len(fields)}")


def intake(intake_dir: Path, originals_dir: Path, conn,
           ocr_provider: str = "none") -> dict:
    """Quét đệ quy `intake_dir` → dict đếm {new, dup, cho_ocr, skipped,
    error}. Thư mục không tồn tại/rỗng → toàn 0. Lỗi 1 file không dừng lô."""
    if ocr_provider not in PROVIDERS:
        raise ValueError(f"OCR provider không hỗ trợ: {ocr_provider}")
    if not PROVIDERS[ocr_provider][1]:
        raise ValueError(f"OCR provider nước ngoài bị từ chối: {ocr_provider}")
    intake_dir, originals_dir = Path(intake_dir), Path(originals_dir)
    counts = dict.fromkeys(("new", "dup", "cho_ocr", "skipped", "error"), 0)
    if not intake_dir.is_dir():
        print("[warn] thư mục intake không tồn tại — 0 file")
        return counts
    root = intake_dir.resolve()
    files = sorted(p for p in intake_dir.rglob("*")
                   if p.is_file() or p.is_symlink())
    for i, path in enumerate(files, 1):
        ext = path.suffix.lower()
        try:
            # Symlink/junction trỏ ra ngoài intake → không đọc (không
            # kéo file tuỳ ý vào kho bản gốc).
            if (path.is_symlink() or ext not in (PDF_EXT, *IMAGE_EXTS)
                    or not path.resolve().is_relative_to(root)):
                counts["skipped"] += 1
                print(f"[skip] #{i} đuôi/loại không nhận")
                continue
            if path.stat().st_size == 0:
                counts["skipped"] += 1
                print(f"[skip] #{i} file rỗng")
                continue
            kind, sha, info = _process(path, intake_dir, originals_dir,
                                       conn, ocr_provider)
        except (DocError, OSError, psycopg.Error) as e:
            if isinstance(e, psycopg.Error):
                try:
                    conn.rollback()
                except psycopg.Error:
                    pass
            counts["error"] += 1
            reason = str(e) if isinstance(e, DocError) else type(e).__name__
            print(f"[err] #{i} {reason}")
            continue
        # cho_ocr là bản ghi MỚI ở trạng thái chờ OCR: đếm cả new.
        counts["dup" if kind == "dup" else "new"] += 1
        if kind == "cho_ocr":
            counts["cho_ocr"] += 1
        print(f"[{'dup' if kind == 'dup' else 'new'}] {sha[:12]} {info}")
    return counts


def reprocess_pending(conn, originals_dir: Path, provider: str) -> dict:
    """OCR lại tài liệu `cho_ocr` (đợt hợp đồng G3) → {done, still, error}.
    Provider none/nước ngoài/lạ → ValueError TRƯỚC mọi truy vấn."""
    if provider not in PROVIDERS or provider == "none":
        raise ValueError(OCR_BLOCKED)
    if not PROVIDERS[provider][1]:
        raise ValueError(f"OCR provider nước ngoài bị từ chối: {provider}")
    counts = dict.fromkeys(("done", "still", "error"), 0)
    rows = conn.execute("select sha256, filename, doc_type from documents"
                        " where status = 'cho_ocr' order by created_at,"
                        " sha256").fetchall()
    conn.commit()
    for sha, filename, dtype in rows:
        orig = Path(originals_dir) / sha
        try:
            if not orig.is_file() or sha256_file(orig) != sha:
                raise DocError("bản gốc thiếu/lệch hash — không OCR")
            text, pages, source = extract_text(orig, provider,
                                               Path(filename).suffix)
            if source == "none":
                counts["still"] += 1
                print(f"[still] {sha[:12]} OCR không ra chữ — giữ cho_ocr")
                continue
            fields = extract_fields(text) if dtype == "giay_tiep_nhan" else {}
            cur = conn.execute(
                "update documents set text_source = %s, pii_flag = %s,"
                " pages = %s, ocr_engine = %s, status = 'pending_review'"
                " where sha256 = %s and status = 'cho_ocr'",
                (source, has_pii(text), pages, OCR_ENGINES.get(provider),
                 sha))
            if cur.rowcount != 1:      # process khác vừa xử lý
                conn.rollback()
                continue
            for field, (value, conf) in fields.items():
                conn.execute(
                    "insert into document_fields (sha256, field, value,"
                    " confidence, verified) values (%s, %s, %s, %s, false)"
                    " on conflict (sha256, field) do nothing",
                    (sha, field, value, conf))
            conn.commit()
        except (DocError, OSError, psycopg.Error) as e:
            if isinstance(e, psycopg.Error):
                try:
                    conn.rollback()
                except psycopg.Error:
                    pass
            counts["error"] += 1
            reason = str(e) if isinstance(e, DocError) else type(e).__name__
            print(f"[err] {sha[:12]} {reason}")
            continue
        counts["done"] += 1
        print(f"[ocr] {sha[:12]} {dtype} → pending_review fields={len(fields)}")
    return counts


# --- CLI xác nhận (Pháp chế) ----------------------------------------------
def list_pending(conn) -> list[tuple]:
    return conn.execute(
        "select d.sha256, d.doc_type, d.status, d.pii_flag,"
        " coalesce(string_agg(f.field || '=' || f.value, '; '"
        " order by f.field) filter (where not f.verified), '')"
        " from documents d left join document_fields f using (sha256)"
        " where d.status in ('pending_review', 'cho_ocr')"
        " group by d.sha256 order by d.created_at").fetchall()


def set_review(conn, sha: str, status: str, by: str) -> bool:
    """pending_review → verified|rejected (1 transaction). verified kéo
    `document_fields.verified=true`; rejected giữ field false. Không ở
    pending_review → False, không update.
    v15.4 (P10.1): qua function SECURITY DEFINER `doc_review_human` —
    danh tính theo login Postgres (khối legal_hr), + log `doc_<status>`;
    DB từ chối danh tính → `auth.HumanDenied`."""
    from pipelines import auth  # lười: auth → director → ...
    try:
        ok = auth.call_human(
            conn, "select doc_review_human(%s, %s, %s)", (sha, status, by),
            by=by, block="legal_hr",
            action="verify" if status == "verified" else "reject",
            object_type="document", object_id=sha[:12]).fetchone()[0]
    except BaseException:
        conn.rollback()
        raise
    if not ok:
        conn.rollback()
        return False
    conn.commit()
    return True


def _dir_env(name: str, default: Path) -> Path:
    return Path(os.environ.get(name, "").strip() or default)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ingest.doc_intake",
                                 description="Số hóa tài liệu (F15.1)")
    ap.add_argument("--pending", action="store_true",
                    help="liệt kê tài liệu chờ xác nhận / chờ OCR")
    ap.add_argument("--verify", metavar="SHA256")
    ap.add_argument("--reject", metavar="SHA256")
    ap.add_argument("--by", help="tên người Pháp chế xác nhận")
    ap.add_argument("--reprocess-pending", action="store_true",
                    help="OCR lại tài liệu cho_ocr khi đã có provider trong "
                         "nước (kết quả vẫn chờ Pháp chế --verify)")
    args = ap.parse_args(argv)
    n_ops = (args.pending + (args.verify is not None)
             + (args.reject is not None) + args.reprocess_pending)
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--pending | --verify | --reject |"
                 " --reprocess-pending)")
    sha = args.verify if args.verify is not None else args.reject
    by = (args.by or "").strip()
    if sha is not None:
        sha = sha.strip().lower()
        if not SHA_RE.fullmatch(sha):
            ap.error("sha256 phải đúng 64 ký tự hex")
        if not by:
            ap.error("--by <tên người xác nhận> là bắt buộc")
        if len(by) > 100 or not by.isprintable():
            ap.error("--by không hợp lệ (≤100 ký tự in được)")
    elif args.by is not None:
        ap.error("--by chỉ dùng với --verify/--reject")

    load_dotenv(ROOT / ".env")
    provider = os.environ.get("OCR_PROVIDER", "").strip() or "none"
    if n_ops == 0 and provider not in PROVIDERS:
        ap.error(f"OCR_PROVIDER={provider} chưa hỗ trợ (có: "
                 + ", ".join(PROVIDERS) + ") — provider có phí là external-dep")
    if n_ops == 0 and not PROVIDERS[provider][1]:
        ap.error(f"OCR_PROVIDER={provider} là dịch vụ nước ngoài — bị từ chối "
                 "(tài liệu chưa OCR coi như có PII)")

    if args.reprocess_pending and (provider == "none"
                                   or provider not in PROVIDERS
                                   or not PROVIDERS[provider][1]):
        print(f"[blocked] {OCR_BLOCKED}")
        return 2
    conn = lead_store.connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL)")
        return 1
    try:
        if args.reprocess_pending:
            counts = reprocess_pending(
                conn, _dir_env("DOC_ORIGINALS_DIR",
                               ROOT / "data" / "originals"), provider)
            print("[done] " + " ".join(f"{k}={v}" for k, v in counts.items()))
            return 1 if counts["error"] else 0
        if args.pending:
            rows = list_pending(conn)
            for s, dtype, status, pii, fields in rows:
                pii_s = {True: "pii", False: "no-pii", None: "pii?"}[pii]
                print(f"{s} {dtype} {status} {pii_s} {_mask_pii(fields)}")
            print(f"[done] {len(rows)} tài liệu chờ")
            return 0
        if sha is not None:
            status = "verified" if args.verify is not None else "rejected"
            # v14.2: Pháp chế được Bên B ủy quyền (auth.cli_gate, legal_hr)
            # — bản đối chiếu này là căn cứ `da_cap` của XNQC.
            from pipelines import auth  # lười: auth → director → ...
            why = auth.cli_gate(conn, by, "legal_hr",
                                "verify" if args.verify is not None
                                else "reject", "document", sha[:12])
            if why:
                conn.rollback()
                print(f"[err] {why} — không đổi gì")
                return 1
            try:
                done = set_review(conn, sha, status, by)
            except auth.HumanDenied as e:
                print(f"[err] DB từ chối: {e} — không đổi gì")
                return 1
            if not done:
                print(f"[err] {sha[:12]} không tồn tại hoặc không ở"
                      " pending_review — không đổi gì")
                return 1
            print(f"[ok] {sha[:12]} → {status} bởi {by}")
            return 0
        # v15 P12.1: chính sách cổng tắt loader (data/loader_gate.json) —
        # chưa cấu hình + tính năng tắt → không nhận tài liệu mới.
        from pipelines import loader_gate
        if why := loader_gate.check("doc_intake", conn):
            print(f"[rollout] {why}", flush=True)
            return 2
        counts = intake(_dir_env("DOC_INTAKE_DIR", ROOT / "data" / "intake"),
                        _dir_env("DOC_ORIGINALS_DIR",
                                 ROOT / "data" / "originals"),
                        conn, provider)
        print("[done] " + " ".join(f"{k}={v}" for k, v in counts.items()))
        if counts["error"]:
            return 1
        if counts["cho_ocr"] and provider == "none":
            # Không báo thành công câm: tài liệu scan/ảnh CHƯA có chữ.
            print(f"[blocked] {counts['cho_ocr']} tài liệu scan/ảnh ở "
                  f"cho_ocr — {OCR_BLOCKED}")
            return 2
        if counts["cho_ocr"]:
            # r13: có provider mà OCR không ra chữ (ảnh trắng/mờ) — vẫn không
            # báo thành công câm.
            print(f"[cho_ocr] {counts['cho_ocr']} tài liệu OCR ({provider}) "
                  "không ra chữ — giữ cho_ocr; người đọc bản gốc hoặc quét lại")
            return 2
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
