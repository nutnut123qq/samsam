"""WP13 (VT) — Kho tư liệu vườn: nhận ảnh → gỡ TOÀN BỘ EXIF/GPS → lưu NGOÀI
repo theo sha256 → metadata vào bảng `garden_media`.

Contract:
  - Ảnh điện thoại mang GPS = tọa độ khoảnh → KHÔNG giữ bất kỳ metadata
    nào: dựng ảnh MỚI từ pixel (`Image.frombytes`) rồi save JPEG (q=90)
    hoặc PNG (khi có alpha) KHÔNG truyền exif/icc/xmp/pnginfo. Hướng ảnh
    áp vào pixel trước (`ImageOps.exif_transpose`) để bỏ thẻ Orientation
    mà ảnh không bị xoay sai.
  - Chỉ nhận JPEG (kể cả MPO nhiều khung — chỉ giữ khung 0)/PNG/WEBP
    ≤ 25 MB; ảnh không mở được / decompression bomb
    (`DecompressionBombError` lẫn `Warning`) → từ chối, 0 file ghi.
  - Kho: `<store>/<sha[:2]>/<sha>.<ext>` (sha256 bản ĐÃ gỡ), ghi tmp +
    `os.replace`, đã có → không ghi lại. Kho phải NGOÀI repo (`--store`
    hoặc env `GARDEN_MEDIA_DIR`; thiếu/nằm trong repo → exit 2).
  - DB trước: connect fail → exit 2, KHÔNG ghi file; khoảnh không tồn tại
    → `[err]` exit 1 (kiểm trước khi ghi file; FK là chốt cuối).
  - stdout chỉ: sha[:12], số thẻ EXIF đã gỡ, "có GPS: có/không" — KHÔNG in
    tọa độ, đường dẫn/tên file nguồn.
  - Pillow import LƯỜI trong hàm xử lý ảnh; thiếu → `[err]` exit 1
    (external-dep: `pip install -r requirements.txt`).
  - Video/HEIC chưa hỗ trợ (cần exiftool/ffmpeg — someday).

Chạy:
  python scripts/garden_media.py --file anh.jpg --plot KV-A01 \
      --date 2026-10-12 --by "Tên người chụp" [--store D:/kho-anh-vuon]
"""

import argparse
import hashlib
import io
import os
import sys
import warnings
from contextlib import suppress
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest.lead_store import connect

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 25 * 1024 * 1024
# MPO = JPEG nhiều khung (iPhone "Most Compatible" kèm gain-map HDR, một số
# máy Samsung) — Pillow báo format 'MPO' cho file .jpg. Chỉ dựng lại khung 0
# từ pixel → khung phụ + EXIF/GPS của chúng tự rơi.
FORMATS = ("JPEG", "MPO", "PNG", "WEBP")
TAG_EXIF_IFD = 0x8769
TAG_GPS_IFD = 0x8825
SOURCE = "cli:garden_media"


def _pil():
    try:
        from PIL import Image, ImageOps
    except ImportError as e:
        raise RuntimeError("thiếu Pillow — external-dep: pip install -r "
                           "requirements.txt") from e
    return Image, ImageOps


def _exif_stats(img) -> tuple[int, bool]:
    """(số thẻ EXIF gốc gồm IFD Exif + GPS, có GPS?) — chỉ ĐẾM, không
    giữ/trả giá trị thẻ."""
    exif = img.getexif()
    n = len(exif)
    gps = exif.get_ifd(TAG_GPS_IFD) if TAG_GPS_IFD in exif else {}
    sub = exif.get_ifd(TAG_EXIF_IFD) if TAG_EXIF_IFD in exif else {}
    return n + len(gps) + len(sub), bool(gps)


def strip_image(src: bytes) -> tuple[bytes, str, dict]:
    """bytes ảnh gốc → (bytes sạch, 'jpg'|'png', info{exif_removed,
    had_gps, width, height}). Từ chối (ValueError): rỗng/> 25 MB, không
    mở được, bomb, định dạng ngoài JPEG/MPO/PNG/WEBP."""
    if not src:
        raise ValueError("file rỗng")
    if len(src) > MAX_BYTES:
        raise ValueError(f"file > {MAX_BYTES // (1024 * 1024)} MB")
    Image, ImageOps = _pil()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(src)) as im:
                if im.format not in FORMATS:
                    raise ValueError(f"định dạng {im.format} không hỗ trợ "
                                     f"(chỉ JPEG/MPO/PNG/WEBP)")
                im.load()
                n_tags, had_gps = _exif_stats(im)
                upright = ImageOps.exif_transpose(im)
                alpha = (upright.mode in ("RGBA", "LA", "PA")
                         or (upright.mode == "P"
                             and "transparency" in upright.info))
                mode = "RGBA" if alpha else "RGB"
                px = upright.convert(mode)
                clean = Image.frombytes(mode, px.size, px.tobytes())
    except ValueError:
        raise
    except (Image.DecompressionBombError,
            Image.DecompressionBombWarning) as e:
        raise ValueError("ảnh quá nhiều pixel (decompression bomb)") from e
    except Exception as e:  # mọi lỗi decode khác = từ chối
        raise ValueError(f"không mở được ảnh ({type(e).__name__})") from e
    out = io.BytesIO()
    if alpha:
        clean.save(out, "PNG")
        ext = "png"
    else:
        clean.save(out, "JPEG", quality=90)
        ext = "jpg"
    return out.getvalue(), ext, {"exif_removed": n_tags, "had_gps": had_gps,
                                 "width": clean.width,
                                 "height": clean.height}


def store(clean: bytes, ext: str, store_dir) -> tuple[str, Path]:
    """Lưu content-addressed `<store>/<sha[:2]>/<sha>.<ext>` → (sha, path).
    Đã có → không ghi lại (idempotent)."""
    sha = hashlib.sha256(clean).hexdigest()
    d = Path(store_dir) / sha[:2]
    path = d / f"{sha}.{ext}"
    if not path.exists():
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f".{sha}.{os.getpid()}.tmp"
        tmp.write_bytes(clean)
        os.replace(tmp, path)
    return sha, path


def record(conn, sha: str, ext: str, nbytes: int, info: dict, plot_id: str,
           taken_on: date, author: str) -> bool:
    """INSERT garden_media (`on conflict (sha256) do nothing`) + commit
    tường minh → True nếu dòng mới."""
    with conn.transaction():
        row = conn.execute(
            "insert into garden_media (sha256, ext, bytes, width, height,"
            " plot_id, taken_on, author, exif_removed, had_gps, source)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " on conflict (sha256) do nothing returning id",
            (sha, ext, nbytes, info["width"], info["height"], plot_id,
             taken_on, author, info["exif_removed"], info["had_gps"],
             SOURCE)).fetchone()
    conn.commit()
    return row is not None


def in_repo(path) -> bool:
    """Thư mục kho nằm TRONG repo (sau resolve symlink/..)? So sánh
    WindowsPath không phân biệt hoa thường."""
    p, root = Path(path).resolve(), ROOT.resolve()
    return p == root or p.is_relative_to(root)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python scripts/garden_media.py",
        description="Nạp ảnh vườn vào kho tư liệu — gỡ toàn bộ EXIF/GPS, "
                    "lưu ngoài repo theo sha256, metadata vào garden_media")
    ap.add_argument("--file", required=True, help="ảnh JPEG/PNG/WEBP (JPEG nhiều khung MPO: chỉ giữ khung 0)")
    ap.add_argument("--plot", required=True, help="mã khoảnh, vd KV-A01")
    ap.add_argument("--date", required=True, help="ngày chụp YYYY-MM-DD")
    ap.add_argument("--by", required=True, help="người chụp/nộp ảnh")
    ap.add_argument("--store", default=None,
                    help="thư mục kho NGOÀI repo (mặc định env "
                         "GARDEN_MEDIA_DIR)")
    args = ap.parse_args(argv)
    by, plot = args.by.strip(), args.plot.strip()
    if not by:
        ap.error("--by không được rỗng")
    if not plot:
        ap.error("--plot không được rỗng")
    try:
        taken_on = date.fromisoformat(args.date.strip())
    except ValueError:
        ap.error("--date sai định dạng YYYY-MM-DD")

    load_dotenv(ROOT / ".env")
    store_dir = args.store or os.environ.get("GARDEN_MEDIA_DIR")
    if not store_dir:
        print("[err] thiếu --store hoặc env GARDEN_MEDIA_DIR (thư mục kho "
              "NGOÀI repo)", file=sys.stderr)
        return 2
    if in_repo(store_dir):
        print("[err] thư mục kho nằm TRONG repo — ảnh vườn không được vào "
              "git; chọn thư mục ngoài repo", file=sys.stderr)
        return 2

    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc "
              "host chết) — không ghi file", file=sys.stderr)
        return 2
    try:
        if conn.execute("select 1 from plots where id = %s",
                        (plot,)).fetchone() is None:
            print(f"[err] khoảnh '{plot}' không tồn tại trong bảng plots",
                  file=sys.stderr)
            return 1
        src = Path(args.file)
        try:
            if src.stat().st_size > MAX_BYTES:
                raise ValueError(f"file > {MAX_BYTES // (1024 * 1024)} MB")
            clean, ext, info = strip_image(src.read_bytes())
        except OSError as e:
            print(f"[err] không đọc được file ảnh ({type(e).__name__})",
                  file=sys.stderr)
            return 1
        except (ValueError, RuntimeError) as e:
            print(f"[err] từ chối ảnh: {e}", file=sys.stderr)
            return 1
        sha, _path = store(clean, ext, store_dir)
        try:
            new = record(conn, sha, ext, len(clean), info, plot, taken_on,
                         by)
        except psycopg.errors.ForeignKeyViolation:
            print(f"[err] khoảnh '{plot}' không tồn tại trong bảng plots",
                  file=sys.stderr)
            return 1
        except psycopg.Error as e:
            print(f"[err] lỗi DB {type(e).__name__} — đã chạy `python "
                  f"scripts/apply_schema.py`?", file=sys.stderr)
            return 1
        print(f"[done] {sha[:12]} — gỡ {info['exif_removed']} thẻ EXIF, "
              f"có GPS: {'có' if info['had_gps'] else 'không'}"
              + ("" if new else " (ảnh đã có trong kho)"))
        return 0
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
