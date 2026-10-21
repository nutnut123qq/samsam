"""Đợt hợp đồng C07 — cấp tư liệu vườn cho Marketing (farming-04).

  python scripts/garden_media_mkt.py --release SHA --by "<GĐ vùng trồng>" [--note]
  python scripts/garden_media_mkt.py --revoke SHA --by "<GĐ vùng trồng>" [--note]
  python scripts/garden_media_mkt.py --list
  python scripts/garden_media_mkt.py --get SHA --out DIR

  - Cấp/thu hồi = QUYẾT ĐỊNH của người khối farming (`auth.cli_gate` +
    function `garden_media_release_human` ghi sổ append-only
    `garden_media_releases` — nguồn đầu ra farming-04 của rollout).
  - Marketing chỉ thấy view `v_garden_media_marketing` (không khoảnh, không
    tác giả, không tư liệu mẫu). `--get` chỉ tư liệu ĐANG được cấp: tệp
    trong kho `GARDEN_MEDIA_DIR` (`<sha[:2]>/<sha>.<ext>`) phải tồn tại, sha256
    khớp, ảnh không còn thẻ EXIF/GPS, video không còn hộp vị trí → chép
    `<out>/<sha>.<ext>` (ghi tạm + đổi tên). Thư mục ra trong repo → từ chối.
  - Không in tên tệp gốc/khoảnh/tác giả — chỉ sha[:12].
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ingest.lead_store import connect
from scripts import garden_media as gm

VIDEO = ("mp4", "mov")


class MediaError(ValueError):
    """Không cấp tệp — lý do rõ, không chép gì."""


def released(conn, sha: str):
    return conn.execute("select ext from v_garden_media_marketing where"
                        " sha256 = %s", (sha,)).fetchone()


def check_clean(data: bytes, ext: str) -> None:
    if ext in VIDEO:
        if gm.video_has_gps(data):
            raise MediaError("video còn dấu vị trí — không cấp")
        return
    import io
    Image, _ = gm._pil()
    with Image.open(io.BytesIO(data)) as img:
        n, gps = gm._exif_stats(img)
    if n or gps:
        raise MediaError("ảnh còn thẻ EXIF/GPS — không cấp")


def get(conn, sha: str, out_dir, store_dir) -> Path:
    row = released(conn, sha)
    if row is None:
        raise MediaError(f"{sha[:12]} chưa được cấp cho Marketing (hoặc đã "
                         "thu hồi / tư liệu mẫu)")
    if gm.in_repo(out_dir):
        raise MediaError("thư mục ra nằm trong repo (public) — từ chối")
    ext = row[0]
    src = Path(store_dir) / sha[:2] / f"{sha}.{ext}"
    if not src.is_file():
        raise MediaError(f"{sha[:12]} thiếu tệp trong kho")
    data = src.read_bytes()
    if hashlib.sha256(data).hexdigest() != sha:
        raise MediaError(f"{sha[:12]} tệp trong kho lệch sha256 — không cấp")
    check_clean(data, ext)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    dst = out / f"{sha}.{ext}"
    tmp = out / f".{sha}.{os.getpid()}.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, dst)
    return dst


def decide(conn, sha: str, action: str, by: str, note=None) -> bool:
    from pipelines import auth  # lười: auth → director → ...
    if why := auth.cli_gate(conn, by, "farming", f"media_{action}",
                            "garden_media", sha[:12]):
        conn.rollback()
        raise MediaError(why)
    ok = auth.call_human(
        conn, "select garden_media_release_human(%s, %s, %s, %s)",
        (sha, action, by, note), by=by, block="farming",
        action=f"media_{action}", object_type="garden_media",
        object_id=sha[:12]).fetchone()[0]
    conn.commit()
    return ok


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/garden_media_mkt.py")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--release", metavar="SHA")
    g.add_argument("--revoke", metavar="SHA")
    g.add_argument("--list", action="store_true")
    g.add_argument("--get", metavar="SHA")
    ap.add_argument("--by")
    ap.add_argument("--note")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--store", default=None)
    a = ap.parse_args(argv)
    if (a.release or a.revoke) and not (a.by or "").strip():
        ap.error('--release/--revoke cần --by "<tên người quyết>"')
    if a.get and a.out is None:
        ap.error("--get cần --out DIR")
    store_dir = a.store or os.environ.get("GARDEN_MEDIA_DIR")
    if a.get and not store_dir:
        ap.error("thiếu --store hoặc env GARDEN_MEDIA_DIR")
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres", file=sys.stderr)
        return 2
    try:
        if a.list:
            rows = conn.execute(
                "select sha256, ext, bytes, taken_on, released_at from"
                " v_garden_media_marketing order by released_at desc,"
                " sha256").fetchall()
            for sha, ext, n, day, at in rows:
                print(f"{sha} {ext} {n}B chụp {day} cấp {at:%Y-%m-%d}")
            print(f"[done] {len(rows)} tư liệu đang được cấp")
            return 0
        try:
            if a.get:
                dst = get(conn, a.get.strip().lower(), a.out, store_dir)
                print(f"[done] {a.get[:12]} → {dst.name}")
                return 0
            sha = (a.release or a.revoke).strip().lower()
            ok = decide(conn, sha, "cap" if a.release else "thu_hoi",
                        a.by.strip(), a.note)
        except MediaError as e:
            print(f"[từ chối] {e}", file=sys.stderr)
            return 1
        except ValueError as e:     # function từ chối nghiệp vụ / HumanDenied
            print(f"[từ chối] {e}", file=sys.stderr)
            return 1
        print(f"[done] {sha[:12]} " + ("đã cập nhật" if ok else
                                       "đã ở trạng thái này — không ghi lặp"))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
