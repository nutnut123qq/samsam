"""Đợt hợp đồng C03 — phiếu kiểm nghiệm lô (production-04.1, PL01 Sản xuất
"hồ sơ lô: mã lô, hạn dùng, phiếu kiểm nghiệm").

  - Tệp phiếu: PDF/JPG/PNG theo MAGIC BYTES (không theo đuôi), ≤ MAX_BYTES
    (GIẢ ĐỊNH 20 MB), lưu bất biến `LOT_CERT_DIR/<sha256>` (thư mục NGOÀI
    repo — trong repo thì từ chối) qua `doc_intake.store_original` (không
    ghi đè, hash tính lại khi chép). Không in tên tệp/nội dung.
  - Ghi sổ CHỈ qua `lot_cert_record_human` (DB: người khối production, lô
    phải tồn tại, cùng tệp không ghi 2 lần, phiên bản tăng — bản cũ giữ).
  - `verify`: mỗi lô (đã kiểm nhập hoặc đang chờ) → `thieu_phieu` | `ok` |
    `thieu_tep` | `lech_hash` theo phiên bản MỚI NHẤT; lô cũ không phiếu
    hiện THIẾU (không tự tạo chứng từ).
"""

import os
from pathlib import Path

from ingest import doc_intake

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 20 * 1024 * 1024
MAGIC = ((b"%PDF-", "pdf"), (bytes.fromhex("ffd8ff"), "jpg"),
         (bytes.fromhex("89504e470d0a1a0a"), "png"))


class CertError(ValueError):
    """Tệp/kho/tham số phiếu không hợp lệ — không ghi gì."""


def cert_dir(env=None) -> Path:
    env = os.environ if env is None else env
    raw = (env.get("LOT_CERT_DIR") or "").strip()
    if not raw:
        raise CertError("chưa cấu hình LOT_CERT_DIR (kho phiếu NGOÀI repo)")
    d = Path(raw).resolve()
    if d.is_relative_to(ROOT.resolve()):
        raise CertError("LOT_CERT_DIR nằm trong repo — từ chối (repo public)")
    return d


def sniff(path: Path) -> str:
    """Đuôi chuẩn theo magic bytes; rỗng/quá lớn/loại lạ → CertError."""
    p = Path(path)
    if p.is_symlink() or not p.is_file():
        raise CertError("không phải tệp thường")
    n = p.stat().st_size
    if n == 0 or n > MAX_BYTES:
        raise CertError(f"tệp rỗng hoặc vượt {MAX_BYTES // 1024 // 1024} MB")
    with p.open("rb") as f:
        head = f.read(8)
    for magic, ext in MAGIC:
        if head.startswith(magic):
            return ext
    raise CertError("tệp không phải PDF/JPG/PNG (magic bytes)")


def record(conn, lot: str, path, cert_no: str, by: str, *, lab=None,
           issued=None, note=None, store=None) -> int:
    """Lưu tệp vào kho + ghi sổ qua function người → phiên bản. Lỗi tệp/kho
    → CertError TRƯỚC mọi ghi DB. DB từ chối → auth.HumanDenied/ValueError
    (tệp đã lưu theo hash — vô hại, không có dòng sổ trỏ tới)."""
    from pipelines import auth  # lười: auth → director → ...
    if not (cert_no or "").strip() or len(cert_no.strip()) > 64:
        raise CertError("--cert-no rỗng hoặc > 64 ký tự")
    ext = sniff(path)
    d = cert_dir() if store is None else Path(store)
    sha = doc_intake.sha256_file(Path(path))
    try:
        doc_intake.store_original(Path(path), sha, d)
    except doc_intake.DocError as e:
        raise CertError(str(e)) from None
    cur = auth.call_human(
        conn, "select lot_cert_record_human(%s, %s, %s, %s, %s, %s, %s, %s)",
        (lot, cert_no.strip(), lab, issued, sha, ext, note, by), by=by,
        block="production", action="lot_cert_record",
        object_type="production_lot", object_id=lot)
    return cur.fetchone()[0]


def latest(conn, lot=None) -> list[tuple]:
    """(lot, intake_status, version|None, cert_no|None, sha|None, ext|None)
    cho mọi lô đang chờ/đã đạt (hoặc 1 lô)."""
    return conn.execute(
        "select l.lot_code, l.intake_status, c.version, c.cert_no,"
        " c.file_sha256, c.file_ext from production_lots l left join lateral"
        " (select version, cert_no, file_sha256, file_ext from"
        " lot_test_certificates t where t.lot_code = l.lot_code order by"
        " version desc limit 1) c on true where l.intake_status in"
        " ('pending', 'passed') and (%s::text is null or l.lot_code = %s)"
        " order by l.lot_code", (lot, lot)).fetchall()


def verify(conn, store=None, lot=None) -> list[dict]:
    d = cert_dir() if store is None else Path(store)
    out = []
    for code, st, ver, no, sha, _ext in latest(conn, lot):
        if ver is None:
            state = "thieu_phieu"
        else:
            f = d / sha
            state = ("thieu_tep" if not f.is_file() else
                     "ok" if doc_intake.sha256_file(f) == sha else "lech_hash")
        out.append({"lot": code, "intake": st, "version": ver,
                    "cert_no": no, "state": state})
    return out
