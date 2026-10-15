"""v9.5 CK-A1 luồng MẬT — tra cứu tài liệu kỹ thuật cơ khí HOÀN TOÀN local.

Tài liệu kỹ thuật mật (bản vẽ tủ điện, sơ đồ đấu nối, manual nội bộ) nằm
trong `CK_MAT_DIR` (env, mặc định `data/co_khi_mat/` — gitignored). Mọi
file trong thư mục này mặc định `confidential=true`: KHÔNG embed, KHÔNG
LLM, KHÔNG mạng. Gateway cũng từ chối agent_id `ck_mat`
(`pipelines.llm_gateway.LOCAL_ONLY_AGENTS`).

Contract:
  - Module KHÔNG import (trực tiếp/bắc cầu) `pipelines.llm_gateway`,
    `ingest.embed_store`, `api.rag`, `openai`, `httpx`, `requests`,
    `urllib3`, `urllib.request`, `google.cloud` (test subprocess khóa).
  - Đuôi nhận: `.pdf` (text từng trang qua `ingest.doc_intake.
    pdf_page_texts`; trang < `SCAN_MIN_CHARS` → OCR ảnh nhúng), `.md`/
    `.txt` (trang tách bằng dòng `--- trang N ---`; không có → cả file
    trang 1), `.jpg/.jpeg/.png` (OCR, trang 1). 0 byte / đuôi lạ / symlink
    / > `MAX_BYTES` / PDF hỏng-mã hoá → skipped (đếm).
  - OCR: `rapidocr_onnxruntime` (model đóng gói trong wheel, không tải
    mạng) import LƯỜI; thiếu engine → trang `cho_ocr` (không index, đếm).
    KHÔNG BAO GIỜ fallback provider mạng.
  - Index trong bộ nhớ dựng mỗi lần chạy (không persist/DB/embed): chunk
    ≤ 800 ký tự theo trang, tokenize NFC casefold bỏ dấu + `\\w+`, BM25
    thuần Python (k1=1.5, b=0.75).
  - `ask(question, root=None, k=3)` → {"answer", "sources": [{"file",
    "page"}], "high_risk"}. NO_DATA (chuỗi giống `api.rag.NO_DATA`) khi:
    thư mục thiếu / rỗng / chỉ file bỏ qua hoặc `cho_ocr`; câu rỗng/chỉ
    dấu câu/chỉ stopword; trang tốt nhất phủ < 60% term nội dung; câu có
    mã máy `SS-EQ-<số>` mà không FILE nào chứa đúng mã (ở bất kỳ trang nào
    hoặc trong tên file — manual thật thường chỉ in mã ở bìa/trang 1).
    Mã máy là BỘ LỌC theo file, không tính vào điểm BM25/độ phủ. Mã từng
    trang tính MỘT lần lúc dựng index (không quét lại trang mỗi chunk —
    A04 DoS: trang đơn 1.4 MB từng mất ~187 s/câu). Trả lời = trích
    đoạn NGUYÊN VĂN (qua `_mask_pii`) + file + trang — không tổng hợp.
  - Chủ đề rủi ro cao (đấu nối, tủ điện, 3 pha, áp lực, nồi hơi, LOTO, cao
    áp...) ở câu HOẶC trang tốt nhất → CHỈ tham chiếu "Xem <file> trang <n>
    — kiểm tra với Kỹ sư trưởng", không trích đoạn, không liệt kê bước.
  - Text hiển thị là trích nguyên văn/template tất định (không AI sinh) →
    không qua guardrail.check().

Chạy: `python -m agents.ck_mat --ask "<câu>" [--dir PATH]` ·
`python -m agents.ck_mat --stats [--dir PATH]` (chỉ số đếm, không nội dung).
"""

import argparse
import math
import os
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

from dotenv import load_dotenv

from ingest.doc_intake import SCAN_MIN_CHARS, DocError, _nonspace_len, pdf_page_texts
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
# Chép đúng chuỗi api.rag.NO_DATA (test drift-guard) — không import rag.
NO_DATA = "Chưa đủ dữ liệu để trả lời."
AGENT = "ck_mat"
MAX_BYTES = 20 * 1024 * 1024
MAX_QUESTION = 500
CHUNK_CHARS = 800
MIN_COVERAGE = 0.6
K1, B = 1.5, 0.75
TEXT_EXTS = {".md", ".txt"}
PDF_EXT = ".pdf"
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
OCR_MISSING_MSG = "[ck-mat] chưa có engine OCR local — trang scan chờ (external-dep)"
PAGE_MARK_RE = re.compile(r"^[ \t]*-{3}[ \t]*trang[ \t]+(\d{1,5})[ \t]*-{3}[ \t]*\r?$",
                          re.IGNORECASE | re.MULTILINE)
# Mã máy trên text đã _fold (casefold, bỏ dấu).
EQ_RE = re.compile(r"(?<![\w-])ss-eq-(\d{1,6})(?!\d)")
# Tên file hay nối mã bằng '-'/'_' (may-co-mang-ss-eq-03.md).
_NAME_EQ_RE = re.compile(r"(?<![a-z0-9])ss-eq-(\d{1,6})(?!\d)")
# Từ chức năng (đã bỏ dấu). Bỏ dấu làm trùng từ chuyên môn nên KHÔNG đưa
# vào: may (máy), bao (bảo trì), co (co màng), do (nhiệt độ), tu (tủ),
# dau (dầu), ve (vệ sinh), can (cân), hoi (hơi), ban (bản vẽ), chua (chứa).
STOPWORDS = frozenset({
    "la", "cua", "va", "cho", "cac", "nhung", "mot", "duoc", "trong", "khi",
    "thi", "nao", "gi", "nhieu", "the", "nay", "o", "voi", "de", "ra", "vao",
    "bi", "hay", "hoac", "khong", "phai", "nhu", "den", "theo", "sau",
    "truoc", "lan", "moi", "ai", "sao", "vi", "neu", "ma", "cung", "da", "se",
    "dang", "xin", "biet", "minh", "toi", "em", "anh", "chi", "a", "nhe",
    "vay", "oi", "lau"})
HIGH_RISK_TERMS = ("dau noi", "dau day", "tu dien", "3 pha", "ba pha",
                   "ap luc", "noi hoi", "loto", "cao ap")
_HIGH_RISK_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(r"\s+".join(map(re.escape, t.split()))
                             for t in HIGH_RISK_TERMS) + r")(?!\w)")
_ENGINE = None


def mat_dir() -> Path:
    """Thư mục tài liệu MẬT (`CK_MAT_DIR` env/.env; tương đối → theo ROOT)."""
    load_dotenv(ROOT / ".env")  # không override env đang có
    raw = os.environ.get("CK_MAT_DIR") or str(ROOT / "data" / "co_khi_mat")
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


def _fold(s: str) -> str:
    """NFC casefold + bỏ dấu (đ→d). Chép riêng — không import gateway."""
    s = unicodedata.normalize("NFD", unicodedata.normalize("NFC", s).casefold())
    s = s.replace("đ", "d")
    return "".join(c for c in s if not unicodedata.combining(c))


def _tokens(s: str) -> list[str]:
    return re.findall(r"\w+", _fold(s))


def _ocr_local(image_bytes: bytes) -> str | None:
    """OCR local bằng rapidocr (không mạng). None = máy chưa có engine."""
    global _ENGINE
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        return None
    try:
        if _ENGINE is None:
            _ENGINE = RapidOCR()
        res, _ = _ENGINE(image_bytes)
    except Exception:  # noqa: BLE001 — ảnh hỏng → coi như không đọc được
        return ""
    return unicodedata.normalize("NFC", "\n".join(r[1] for r in res or []))


def _text_pages(raw: str) -> list[tuple[int, str]]:
    marks = list(PAGE_MARK_RE.finditer(raw))
    if not marks:
        return [(1, raw)]
    pages = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(raw)
        body = raw[m.end():end]
        if i == 0:  # phần đầu trước dấu trang đầu (tiêu đề) gộp vào trang đầu
            body = raw[:m.start()] + body
        pages.append((int(m.group(1)), body))
    # dấu "trang N" lặp → gộp 1 trang, giữ thứ tự. Gom list rồi join 1 lần:
    # nối chuỗi lặp (`merged[n] + body`) quadratic — 2.88 MB dấu lặp ~13 s.
    merged: dict[int, list[str]] = {}
    for n, body in pages:
        merged.setdefault(n, []).append(body)
    return [(n, "\n\n".join(bodies)) for n, bodies in merged.items()]


def _pdf_pages(path: Path, stats: dict) -> list[tuple[int, str]]:
    texts = pdf_page_texts(path)  # DocError → caller đếm skipped
    out, reader = [], None
    for i, t in enumerate(texts, 1):
        if _nonspace_len(t) >= SCAN_MIN_CHARS:
            out.append((i, t))
            continue
        parts = []
        try:
            if reader is None:
                from pypdf import PdfReader
                reader = PdfReader(str(path))
            images = [im.data for im in reader.pages[i - 1].images]
        except Exception:  # noqa: BLE001 — ảnh nhúng/PDF lỗi định dạng → cho_ocr
            images = []
        for data in images:
            r = _ocr_local(data)
            if r is None:
                stats["ocr_missing"] = True
                break
            parts.append(r)
        ocr = "\n".join(parts)
        if _nonspace_len(ocr) == 0:
            stats["cho_ocr"] += 1
            continue
        out.append((i, t + "\n" + ocr))
    return out


def _chunks(text: str) -> list[str]:
    # Cắt đoạn dài theo CHỈ SỐ — `p = p[N:]` lặp là quadratic (đo: file 20 MB
    # một dòng mất ~97 s).
    pieces = [p[i:i + CHUNK_CHARS]
              for p in (x.strip() for x in re.split(r"\n\s*\n", text)) if p
              for i in range(0, len(p), CHUNK_CHARS)]
    out, cur = [], ""
    for p in pieces:
        if cur and len(cur) + 2 + len(p) > CHUNK_CHARS:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        out.append(cur)
    return out


def build_index(root: Path | None = None) -> dict:
    """Dựng index BM25 trong bộ nhớ từ thư mục tài liệu (không persist)."""
    root = Path(root) if root is not None else mat_dir()
    stats = {"files": 0, "pages": 0, "indexed": 0, "cho_ocr": 0,
             "skipped": 0, "ocr_missing": False}
    idx = {"root": root, "exists": root.is_dir(), "stats": stats,
           "chunks": [], "page_terms": {}, "page_text": {}, "file_codes": {}}
    if not idx["exists"]:
        return idx
    files = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        files += [Path(dirpath) / f for f in sorted(filenames)]
    for p in files:
        stats["files"] += 1
        ext = p.suffix.lower()
        try:
            size = p.lstat().st_size
        except OSError:
            stats["skipped"] += 1
            continue
        if (p.is_symlink() or size == 0 or size > MAX_BYTES
                or ext not in TEXT_EXTS | IMAGE_EXTS | {PDF_EXT}):
            stats["skipped"] += 1
            continue
        try:
            if ext in TEXT_EXTS:
                raw = p.read_bytes().decode("utf-8", errors="replace")
                pages = _text_pages(unicodedata.normalize(
                    "NFC", raw.replace("\ufeff", "")))
            elif ext == PDF_EXT:
                pages = _pdf_pages(p, stats)
            else:
                r = _ocr_local(p.read_bytes())
                if r is None:
                    stats["ocr_missing"] = True
                if not r or _nonspace_len(r) == 0:
                    stats["cho_ocr"] += 1
                    continue
                pages = [(1, r)]
        except (DocError, OSError):
            stats["skipped"] += 1
            continue
        stats["pages"] += len(pages)  # trang cho_ocr cộng ở cuối
        rel = p.relative_to(root).as_posix()
        fcodes = idx["file_codes"].setdefault(
            rel, set(_NAME_EQ_RE.findall(_fold(rel))))
        for page, text in pages:
            if _nonspace_len(text) == 0:
                continue
            key = (rel, page)
            folded = _fold(text)
            idx["page_terms"][key] = set(re.findall(r"\w+", folded))
            idx["page_text"][key] = folded
            fcodes |= set(EQ_RE.findall(folded))
            stats["indexed"] += 1
            for c in _chunks(text):
                toks = _tokens(c)
                if toks:
                    idx["chunks"].append({"file": rel, "page": page, "text": c,
                                          "tf": Counter(toks), "len": len(toks)})
    stats["pages"] += stats["cho_ocr"]
    if stats["ocr_missing"]:
        print(OCR_MISSING_MSG, flush=True)
    n = len(idx["chunks"])
    df = Counter(t for c in idx["chunks"] for t in c["tf"])
    idx["idf"] = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}
    idx["avgdl"] = (sum(c["len"] for c in idx["chunks"]) / n) if n else 0.0
    return idx


def _bm25(idx: dict, chunk: dict, terms: list[str]) -> float:
    s, dl = 0.0, chunk["len"]
    for t in terms:
        tf = chunk["tf"].get(t, 0)
        if tf:
            s += idx["idf"][t] * tf * (K1 + 1) / (
                tf + K1 * (1 - B + B * dl / idx["avgdl"]))
    return s


def _no_data() -> dict:
    return {"answer": NO_DATA, "sources": [], "high_risk": False}


def ask(question: str, root: Path | None = None, k: int = 3,
        index: dict | None = None) -> dict:
    """Tra cứu local. `index` (tùy chọn) tái dùng index đã dựng cho nhiều câu."""
    idx = index if index is not None else build_index(root)
    if not isinstance(question, str) or not idx["chunks"]:
        return _no_data()
    q = question[:MAX_QUESTION]
    terms = sorted({t for t in _tokens(q) if t not in STOPWORDS})
    if not terms:
        return _no_data()
    codes = set(EQ_RE.findall(_fold(q)))
    files = None
    if codes:  # lọc theo FILE (mã thường chỉ in ở bìa/trang 1)
        files = {f for f, fc in idx["file_codes"].items() if codes <= fc}
        if not files:
            return _no_data()
        code_toks = {"ss", "eq"} | codes
        terms = [t for t in terms if t not in code_toks] or terms
    scored = []
    for c in idx["chunks"]:
        if files is not None and c["file"] not in files:
            continue
        s = _bm25(idx, c, terms)
        if s > 0:
            scored.append((-s, c["file"], c["page"], c))
    if not scored:
        return _no_data()
    scored.sort(key=lambda x: x[:3])
    sources, best = [], None
    for _, f, page, c in scored:
        key = (f, page)
        cover = len(idx["page_terms"][key] & set(terms)) / len(terms)
        if best is None:
            if cover < MIN_COVERAGE:
                return _no_data()  # trang tốt nhất phủ < 60% câu hỏi
            best = c
        if cover < MIN_COVERAGE:
            continue
        src = {"file": f, "page": page}
        if src not in sources:
            sources.append(src)
        if len(sources) >= max(1, k):
            break
    key = (best["file"], best["page"])
    high = bool(_HIGH_RISK_RE.search(_fold(q))
                or _HIGH_RISK_RE.search(idx["page_text"][key]))
    if high:
        return {"answer": f"Xem {best['file']} trang {best['page']} — "
                          "kiểm tra với Kỹ sư trưởng",
                "sources": [{"file": best["file"], "page": best["page"]}],
                "high_risk": True}
    excerpt = _mask_pii(best["text"].strip())
    return {"answer": f"{excerpt}\n\n(Nguồn: {best['file']} trang {best['page']})",
            "sources": sources, "high_risk": False}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.ck_mat",
                                 description="CK-A1 tra cứu tài liệu MẬT local")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--ask", metavar="CAU_HOI")
    g.add_argument("--stats", action="store_true")
    ap.add_argument("--dir", help="thư mục tài liệu (mặc định CK_MAT_DIR)")
    a = ap.parse_args(argv)
    root = Path(a.dir) if a.dir else None
    idx = build_index(root)
    if a.stats:
        s = idx["stats"]
        print(f"[ck-mat] thư mục {'có' if idx['exists'] else 'KHÔNG có'} — "
              f"file={s['files']} trang={s['pages']} indexed={s['indexed']} "
              f"cho_ocr={s['cho_ocr']} skipped={s['skipped']}", flush=True)
        return 0
    r = ask(a.ask, index=idx)
    print(r["answer"], flush=True)
    if r["high_risk"]:
        print("[ck-mat] chủ đề RỦI RO CAO — không trích đoạn", flush=True)
    for s in r["sources"]:
        print(f"[nguồn] {s['file']} trang {s['page']}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
