"""Break-glass (v3.10) — mở cửa sổ ngoại lệ CÓ HẠN trong đóng băng 21/12–10/02.

Chạy (đúng 1 thao tác mỗi lần):
  python scripts/break_glass.py --open --reason "<lý do>" --by "<người>" [--hours 1..4]
  python scripts/break_glass.py --status
  python scripts/break_glass.py --close --reason "<lý do>" --by "<người>"

Khi nào dùng: sự cố cần thay đổi KHÔNG thuộc hotfix/tắt agent/khôi phục
trong mùa đóng băng (vd phải đổi cấu hình gấp). Trong cửa sổ còn hạn,
`pipelines.freeze.check()` cho mọi loại thay đổi qua — vì vậy: bắt buộc
lý do (≥10 ký tự, che SĐT/email trước khi ghi) + người chịu trách nhiệm,
tối đa `break_glass_max_hours` (4 giờ) theo `data/freeze_calendar.json`,
tự hết hạn, đóng sớm bằng `--close`.

Log: env `BREAK_GLASS_LOG` (đường dẫn file, BẮT BUỘC, NGOÀI repo; có thể
đặt trong `.env`). Append-only: chỉ mở `ab`, 1 dòng JSON/record, không bao
giờ sửa/xóa dòng cũ. Danh sách người giữ quyền (`break_glass_holders`)
rỗng = công ty chưa cấp (external-dep) → vẫn mở nhưng cảnh báo +
`holder_verified=false`; có danh sách mà `--by` không thuộc → từ chối.

Exit: 0 OK; 1 lịch đóng băng lỗi (không mở được — sửa lịch trước);
2 usage (thiếu/sai tham số, log trong repo, người không có quyền).
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
import db_backup as bk

from pipelines import freeze
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

MIN_REASON = 10
MAX_BY = 80
DEFAULT_HOURS = 2


class Usage(Exception):
    pass


def _fmt(d: datetime) -> str:
    return f"{d.astimezone(freeze.VN_TZ):%H:%M %d/%m/%Y}"


def log_path() -> Path:
    raw = (os.environ.get("BREAK_GLASS_LOG") or "").strip()
    if not raw:
        raise Usage("thiếu BREAK_GLASS_LOG (đường dẫn file log NGOÀI repo)")
    p = Path(raw).expanduser()
    if bk.inside_repo(p):
        raise Usage("BREAK_GLASS_LOG nằm trong repo — phải đặt NGOÀI repo")
    return p.resolve()


def _who_why(args) -> tuple[str, str]:
    by = (args.by or "").strip()
    if not by or len(by) > MAX_BY or not by.isprintable():
        raise Usage(f"--by bắt buộc, 1..{MAX_BY} ký tự in được")
    reason = (args.reason or "").strip()
    if len(reason) < MIN_REASON:
        raise Usage(f"--reason bắt buộc, ≥ {MIN_REASON} ký tự")
    return by, _mask_pii(reason)


def append_record(path: Path, rec: dict) -> None:
    """Append-only: nếu dòng cuối bị ghi dở (thiếu `\\n`) thì xuống dòng
    trước — record mới không dính vào dòng hỏng."""
    lead = b""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            if f.tell():
                f.seek(-1, os.SEEK_END)
                lead = b"" if f.read(1) == b"\n" else b"\n"
    except FileNotFoundError:
        pass
    line = json.dumps(rec, ensure_ascii=False).encode("utf-8") + b"\n"
    with open(path, "ab") as f:
        f.write(lead + line)


def _records(path: Path) -> list[dict]:
    bad: list[int] = []
    recs = freeze.load_break_glass(path, bad)
    if bad:
        print(f"[warn] bỏ qua {len(bad)} dòng log hỏng: dòng "
              + ", ".join(map(str, bad[:10])))
    return recs


def do_open(args, path: Path, cal: dict, now: datetime) -> int:
    by, reason = _who_why(args)
    max_h = cal["break_glass_max_hours"]
    hours = DEFAULT_HOURS if args.hours is None else args.hours
    if not 1 <= hours <= max_h:
        raise Usage(f"--hours phải trong 1..{max_h:g}")
    holders = {h.strip().casefold() for h in cal["break_glass_holders"]}
    if holders and by.casefold() not in holders:
        raise Usage(f"'{by}' không thuộc danh sách người giữ quyền "
                    "break-glass")
    verified = bool(holders)
    if not verified:
        print("[CẢNH BÁO] danh sách người giữ quyền break-glass chưa được "
              "công ty cấp (external-dep) — ghi holder_verified=false")
    if not freeze.is_frozen(now, cal):
        print("[warn] hiện KHÔNG trong khung đóng băng — break-glass không "
              "cần thiết (vẫn mở theo yêu cầu)")
    expires = now + timedelta(hours=hours)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_record(path, {
        "action": "open", "ts": now.isoformat(), "opened_at": now.isoformat(),
        "expires_at": expires.isoformat(), "hours": hours, "by": by,
        "reason": reason, "holder_verified": verified})
    print(f"[CẢNH BÁO] BREAK-GLASS mở tới {_fmt(expires)} bởi {by} — mọi "
          "thay đổi trong đóng băng được cho qua tới khi hết hạn")
    return 0


def do_close(args, path: Path, cal: dict, now: datetime) -> int:
    by, reason = _who_why(args)
    active = freeze.active_windows(_records(path), now,
                                   cal["break_glass_max_hours"])
    if not active:
        print("[info] không có cửa sổ break-glass nào còn hạn — không ghi")
        return 0
    append_record(path, {"action": "close", "ts": now.isoformat(), "by": by,
                         "reason": reason, "closed": len(active)})
    print(f"[ok] đã đóng sớm {len(active)} cửa sổ break-glass ({by})")
    return 0


def _printable(v) -> str:
    """Reason đọc từ log (có thể bị sửa tay) → thay ký tự điều khiển/ANSI
    trước khi in ra terminal."""
    return "".join(c if c.isprintable() else "?" for c in str(v))


def do_status(path: Path, cal: dict, now: datetime) -> int:
    active = freeze.active_windows(_records(path), now,
                                   cal["break_glass_max_hours"])
    state = "ĐANG đóng băng" if freeze.is_frozen(now, cal) else \
        "ngoài khung đóng băng"
    print(f"[status] {_fmt(now)} — {state}; {len(active)} cửa sổ "
          "break-glass còn hạn")
    for w in active:
        tag = "" if w["holder_verified"] else " (người CHƯA xác minh)"
        print(f"  - mở {_fmt(w['opened_at'])} → hết hạn {_fmt(w['expires_at'])}"
              f" bởi {w['by']}{tag}: {_printable(w['reason'])}")
    return 0


@bk.private_umask  # log có tên người + lý do: chỉ chủ sở hữu đọc (Linux)
def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    op = ap.add_mutually_exclusive_group(required=True)
    op.add_argument("--open", action="store_true")
    op.add_argument("--status", action="store_true")
    op.add_argument("--close", action="store_true")
    ap.add_argument("--reason")
    ap.add_argument("--by")
    ap.add_argument("--hours", type=int)
    try:
        args = ap.parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    now = now if now is not None else bk.vn_now()
    if now.tzinfo is None:
        raise ValueError("now phải có múi giờ")
    now = now.astimezone(freeze.VN_TZ)
    load_dotenv(ROOT / ".env")
    try:
        path = log_path()
        if not args.open and args.hours is not None:
            raise Usage("--hours chỉ dùng với --open")
        try:
            cal = freeze.load_calendar()
        except freeze.FreezeConfigError as e:
            print(f"[err] lịch đóng băng lỗi: {e} — sửa "
                  "data/freeze_calendar.json trước")
            return 1
        if args.open:
            return do_open(args, path, cal, now)
        if args.close:
            return do_close(args, path, cal, now)
        return do_status(path, cal, now)
    except Usage as e:
        print(f"[usage] {e}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
