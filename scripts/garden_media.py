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
  - v13.4 VIDEO vườn (PL01 "ảnh, video thật từ vườn đã xóa vị trí GPS"):
    đuôi `.mp4/.m4v/.mov` → nhánh VIDEO riêng (KHÔNG qua Pillow). Kiểm
    file thường (không thư mục/symlink), kích thước ≤ `MAX_VIDEO_BYTES`
    (GIẢ ĐỊNH 200 MB — giới hạn kỹ thuật, chưa ai chốt), magic bytes
    ISO-BMFF (`ftyp` + brand MP4/QuickTime, cấu trúc hộp hợp lệ) và đuôi
    khớp nội dung. Gỡ metadata bằng remux ffmpeg `-map 0:V -map 0:a? -dn
    -sn -map_metadata -1 -map_chapters -1 -c copy` (chỉ giữ hình + tiếng:
    track dữ liệu vị trí/ảnh bìa/phụ đề bị bỏ; không mã hóa lại). Sau
    remux quét lại các hộp NGOÀI `mdat` — còn dấu vị trí (`©xyz`/`loci`/
    `ISO6709`/`location`) → từ chối. ffmpeg: env `FFMPEG_BIN` →
    `imageio-ffmpeg` (đã có trong requirements) → PATH; không có → TỪ
    CHỐI video (fail-closed, không lưu bản chưa gỡ). Bản gốc (còn GPS)
    chỉ nằm trong thư mục tạm `<kho>/.tmp/`, xóa ngay sau remux. Kho/bảng
    như ảnh: ext `mp4`/`mov`, width/height NULL.
  - HEIC chưa hỗ trợ.

Chạy:
  python scripts/garden_media.py --file anh.jpg --plot KV-A01 \
      --date 2026-10-12 --by "Tên người chụp" [--store D:/kho-anh-vuon]
  python scripts/garden_media.py --file clip.mov --plot KV-A01 ...
"""

import argparse
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
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
# v13.4 video — đuôi → container ra (m4v = MP4). Brand `ftyp` nhận được:
# MP4 (Android/ứng dụng) và QuickTime (iPhone `.mov`).
VIDEO_EXTS = {".mp4": "mp4", ".m4v": "mp4", ".mov": "mov"}
MP4_BRANDS = (b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42",
              b"avc1", b"M4V ", b"M4VH", b"M4VP")
MOV_BRANDS = (b"qt  ",)
MAX_VIDEO_BYTES = 200 * 1024 * 1024  # GIẢ ĐỊNH kỹ thuật — chưa ai chốt
FFMPEG_TIMEOUT_S = 300
# Dấu vị trí trong hộp metadata MP4/MOV (iPhone `©xyz` + khóa mdta
# `com.apple.quicktime.location.ISO6709`, 3GPP `loci`). Chỉ quét hộp NGOÀI
# `mdat` (dữ liệu nén có thể trùng ngẫu nhiên 4 byte).
GPS_MARKERS = (b"\xa9xyz", b"loci", b"ISO6709", b"location")


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


def _boxes(data: bytes) -> list[tuple[bytes, int, int]]:
    """Hộp cấp 1 ISO-BMFF → [(type, start, end)]. Kích thước sai/vượt file
    → ValueError (không đoán)."""
    out, i, n = [], 0, len(data)
    while i < n:
        if n - i < 8:
            raise ValueError("cấu trúc video hỏng (hộp cụt)")
        size, hdr = int.from_bytes(data[i:i + 4], "big"), 8
        if size == 1:
            if n - i < 16:
                raise ValueError("cấu trúc video hỏng (hộp cụt)")
            size, hdr = int.from_bytes(data[i + 8:i + 16], "big"), 16
        elif size == 0:
            size = n - i
        if size < hdr or i + size > n:
            raise ValueError("cấu trúc video hỏng (kích thước hộp)")
        out.append((data[i + 4:i + 8], i, i + size))
        i += size
    return out


def video_container(data: bytes) -> str:
    """'mp4' | 'mov' theo magic bytes (`ftyp` đầu file + brand) + cấu trúc
    hộp hợp lệ. Khác → ValueError."""
    if len(data) < 12 or data[4:8] != b"ftyp":
        raise ValueError("không phải video MP4/MOV (magic bytes)")
    brand = data[8:12]
    if brand in MP4_BRANDS:
        kind = "mp4"
    elif brand in MOV_BRANDS:
        kind = "mov"
    else:
        raise ValueError("brand video không hỗ trợ (chỉ MP4/MOV)")
    _boxes(data)
    return kind


def video_has_gps(data: bytes) -> bool:
    """Có dấu vị trí trong các hộp NGOÀI `mdat` (moov/udta/meta...)?"""
    return any(m in data[a:b] for typ, a, b in _boxes(data)
               if typ not in (b"mdat", b"free", b"skip")
               for m in GPS_MARKERS)


def _find_ffmpeg() -> str | None:
    """env FFMPEG_BIN → imageio-ffmpeg → PATH → None. Cùng thứ tự
    `pipelines.video_studio.find_ffmpeg` nhưng KHÔNG import module đó (kéo
    theo LLM gateway/openai vào luồng dữ liệu vườn)."""
    p = (os.environ.get("FFMPEG_BIN") or "").strip()
    if p and Path(p).is_file():
        return p
    with suppress(Exception):
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).is_file():
            return exe
    return shutil.which("ffmpeg")


def strip_video(src: bytes, *, tmp_dir=None) -> tuple[bytes, str, dict]:
    """bytes video gốc → (bytes đã gỡ metadata, 'mp4'|'mov', info{
    exif_removed=0, had_gps, width=None, height=None}). Từ chối
    (ValueError): rỗng/quá cỡ/magic sai/remux lỗi/còn dấu vị trí. Thiếu
    ffmpeg → RuntimeError (fail-closed: không lưu bản chưa gỡ)."""
    if not src:
        raise ValueError("file rỗng")
    if len(src) > MAX_VIDEO_BYTES:
        raise ValueError(f"video > {MAX_VIDEO_BYTES // (1024 * 1024)} MB")
    kind = video_container(src)
    had_gps = video_has_gps(src)
    ff = _find_ffmpeg()
    if not ff:
        raise RuntimeError("thiếu ffmpeg — TỪ CHỐI video vì không gỡ được "
                           "metadata/GPS (external-dep: pip install -r "
                           "requirements.txt [imageio-ffmpeg] hoặc env "
                           "FFMPEG_BIN)")
    if tmp_dir is not None:
        Path(tmp_dir).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=tmp_dir, prefix=".gm-") as td:
        inp, outp = Path(td) / f"in.{kind}", Path(td) / f"out.{kind}"
        inp.write_bytes(src)
        try:
            r = subprocess.run(
                [ff, "-nostdin", "-v", "error", "-y", "-i", str(inp),
                 "-map", "0:V", "-map", "0:a?", "-dn", "-sn",
                 "-map_metadata", "-1", "-map_metadata:s", "-1",
                 "-map_chapters", "-1", "-fflags", "+bitexact",
                 "-flags:v", "+bitexact", "-flags:a", "+bitexact",
                 "-c", "copy", "-f", kind, str(outp)],
                shell=False, capture_output=True, stdin=subprocess.DEVNULL,
                timeout=FFMPEG_TIMEOUT_S, check=False)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ValueError(f"ffmpeg không chạy được ({type(e).__name__})"
                             ) from e
        if r.returncode != 0 or not outp.is_file():
            raise ValueError(f"không gỡ được metadata video (ffmpeg rc="
                             f"{r.returncode}) — file hỏng hoặc không có "
                             f"luồng hình")
        clean = outp.read_bytes()
    if not clean or video_container(clean) != kind or video_has_gps(clean):
        raise ValueError("video sau khi gỡ vẫn còn dấu vị trí / sai cấu "
                         "trúc — từ chối")
    return clean, kind, {"exif_removed": 0, "had_gps": had_gps,
                         "width": None, "height": None}


def strip_media(src: bytes, ext_hint: str, *, tmp_dir=None
                ) -> tuple[bytes, str, dict]:
    """Định tuyến theo đuôi khai báo: video → `strip_video` (đuôi phải khớp
    container thật), còn lại → `strip_image`. Video KHÔNG bao giờ vào
    nhánh Pillow; ảnh đổi đuôi .mp4 bị magic bytes chặn."""
    want = VIDEO_EXTS.get(ext_hint.lower())
    if want is None:
        return strip_image(src)
    clean, ext, info = strip_video(src, tmp_dir=tmp_dir)
    if ext != want:
        raise ValueError("đuôi file không khớp nội dung video")
    return clean, ext, info


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
           taken_on: date, author: str, source: str = SOURCE) -> bool:
    """INSERT garden_media (`on conflict (sha256) do nothing`) + commit
    tường minh → True nếu dòng mới. `source` (v12.4): `zalo:garden` khi ảnh
    tới từ Zalo nhân viên vườn."""
    with conn.transaction():
        row = conn.execute(
            "insert into garden_media (sha256, ext, bytes, width, height,"
            " plot_id, taken_on, author, exif_removed, had_gps, source)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " on conflict (sha256) do nothing returning id",
            (sha, ext, nbytes, info["width"], info["height"], plot_id,
             taken_on, author, info["exif_removed"], info["had_gps"],
             source)).fetchone()
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
    ap.add_argument("--file", required=True,
                    help="ảnh JPEG/PNG/WEBP (MPO: chỉ giữ khung 0) "
                         "hoặc video .mp4/.m4v/.mov")
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
        # v13 vá review (F03): kho tư liệu vườn = farming-04; `tat` (sổ
        # triển khai, HĐ 6.7) → không ghi file/dòng nào.
        from pipelines import rollout
        try:
            rollout.check_generate(conn, "farming-04", "nạp kho ảnh vườn")
        except rollout.RolloutBlocked as e:
            print(f"[blocked] {e}", file=sys.stderr)
            return 2
        if conn.execute("select 1 from plots where id = %s",
                        (plot,)).fetchone() is None:
            print(f"[err] khoảnh '{plot}' không tồn tại trong bảng plots",
                  file=sys.stderr)
            return 1
        src = Path(args.file)
        video = src.suffix.lower() in VIDEO_EXTS
        try:
            if src.is_symlink() or not src.is_file():
                raise ValueError("--file phải là file thường (không thư "
                                 "mục/symlink)")
            limit = MAX_VIDEO_BYTES if video else MAX_BYTES
            if src.stat().st_size > limit:
                raise ValueError(f"file > {limit // (1024 * 1024)} MB")
            clean, ext, info = strip_media(src.read_bytes(), src.suffix,
                                           tmp_dir=Path(store_dir) / ".tmp")
        except OSError as e:
            print(f"[err] không đọc được file ảnh ({type(e).__name__})",
                  file=sys.stderr)
            return 1
        except (ValueError, RuntimeError) as e:
            print(f"[err] từ chối {'video' if video else 'ảnh'}: {e}",
                  file=sys.stderr)
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
        what = (f"video {ext} đã gỡ metadata" if video
                else f"gỡ {info['exif_removed']} thẻ EXIF")
        print(f"[done] {sha[:12]} — {what}, có GPS: "
              f"{'có' if info['had_gps'] else 'không'}"
              + ("" if new else " (tệp đã có trong kho)"))
        return 0
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
