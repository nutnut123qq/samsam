"""Diễn tập khôi phục (v3.6, luồng F17.4 bước 4) — vào DB TẠM, không bao giờ đè.

Chạy: `python scripts/db_restore_drill.py [--backup <manifest>]
[--target-db <tên>]`. Đọc (env tiến trình hoặc `.env` root repo, nạp
trước mọi kiểm tra) `BACKUP_DIR` (ngoài repo), `DATABASE_URL`,
`DRILL_DATABASE_URL` (tùy chọn — server diễn tập riêng, cloud: VM diễn tập;
không có thì dùng server của `DATABASE_URL`), `BACKUP_PASSPHRASE_FILE`
(khi bản backup đã mã hóa), `PG_BIN` (như db_backup).

Thứ tự:
1. Guard TRƯỚC mọi thao tác: tên đích (mặc định `samsam_drill_<YYYYmmdd_
   HHMMSS>_<4 hex>`) phải khớp `^samsam_drill_[0-9a-z_]+$`, KHÁC dbname
   của `DATABASE_URL`/`DRILL_DATABASE_URL` (so tên, không theo host) và
   CHƯA tồn tại trong `pg_database` → vi phạm: `[refuse]` exit 2.
2. Chọn manifest hợp lệ mới nhất theo `created_at` (hoặc `--backup`); bản
   mới nhất mất file / sha256 lệch → FAIL, KHÔNG lùi sang bản cũ hơn.
3. Giải mã ra file tạm (nếu `encrypted`) — sai khóa → exit 1, chưa tạo DB.
4. `create database` → `pg_restore --no-owner --no-privileges
   --exit-on-error` (PG* env, không argv mật khẩu) → đếm `count(*)` từng
   bảng so `row_counts` (bảng thiếu/thừa cũng là lệch).
5. RTO = giây từ bước kiểm sha256 tới xong đếm.
6. `finally`: `drop database ... with (force)` + kiểm lại `pg_database`,
   xóa file giải mã tạm. Drop lỗi → `[ALERT]`.

Nhật ký: `drill_runs.jsonl` trong `BACKUP_DIR` (không DSN).
Exit: 0 khớp hết + đã drop; 1 lệch/lỗi/drop thất bại; 2 guard từ chối/usage.

Khôi phục ĐÈ production KHÔNG có trong script này: tầng 2, người làm tay,
báo TGĐ, đối chiếu phiếu xóa dữ liệu (xem docs/handover/sop.md mục 6).
"""

import argparse
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_backup as bk

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DRILL_RE = re.compile(r"^samsam_drill_[0-9a-z_]+$")
RESTORE_TIMEOUT_S = 3600


class Refuse(Exception):
    pass


def default_target() -> str:
    return f"samsam_drill_{bk.vn_now():%Y%m%d_%H%M%S}_{secrets.token_hex(2)}"


def _dbname(dsn: str) -> str | None:
    return conninfo_to_dict(dsn).get("dbname")


def guard_name(target: str, dsns: list[str]) -> None:
    """Guard tên (không cần DB): mẫu drill + khác mọi DB đang dùng."""
    if not DRILL_RE.match(target):
        raise Refuse(f"tên đích '{target}' không khớp ^samsam_drill_[0-9a-z_]+$")
    for d in dsns:
        if target == _dbname(d):
            raise Refuse(f"tên đích '{target}' trùng DB đang dùng")


def _admin(dsn: str):
    return psycopg.connect(dsn, autocommit=True,
                           connect_timeout=bk.CONNECT_TIMEOUT)


def db_exists(admin_dsn: str, name: str) -> bool:
    with _admin(admin_dsn) as c:
        return c.execute("select 1 from pg_database where datname = %s",
                         (name,)).fetchone() is not None


def pick_manifest(bdir: Path, explicit: str | None):
    """(manifest_path, manifest) — bản chỉ định hoặc mới nhất hợp lệ."""
    if explicit:
        p = Path(explicit)
        m = bk.load_manifest(p)
        if m is None:
            raise RuntimeError(f"manifest không hợp lệ: {p.name}")
        return p, m
    names = {p.name for p in bdir.glob("*" + bk.MANIFEST_SUFFIX)}
    found = bk.valid_manifests(bdir)
    for bad in sorted(names - {p.name for _, p, _ in found}):
        print(f"[warn] bỏ qua manifest hỏng: {bad}")
    if not found:
        raise RuntimeError("không có manifest hợp lệ trong BACKUP_DIR")
    _, p, m = found[0]
    return p, m


def _decrypt(src: Path, passfile: str | None, bdir: Path) -> Path:
    if not passfile or not Path(passfile).is_file():
        raise RuntimeError("bản backup đã mã hóa — cần BACKUP_PASSPHRASE_FILE")
    try:
        bk.check_passfile(Path(passfile))
    except bk.UsageError as e:
        raise RuntimeError(str(e)) from e
    openssl = bk.find_openssl()
    if not openssl:
        raise RuntimeError("không tìm thấy openssl để giải mã")
    fd, tmp = tempfile.mkstemp(prefix="drill_", suffix=".partial", dir=bdir)
    os.close(fd)
    tmp = Path(tmp)
    r = subprocess.run(
        [openssl, *bk.OPENSSL_ENC, "-d", "-pass", f"file:{passfile}",
         "-in", str(src), "-out", str(tmp)],
        capture_output=True, timeout=RESTORE_TIMEOUT_S, check=False)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("giải mã lỗi (sai passphrase?)")
    return tmp


def count_tables(dsn: str) -> dict:
    with psycopg.connect(dsn, connect_timeout=bk.CONNECT_TIMEOUT) as c:
        return bk._snapshot_counts(c)


def run_drill(args, bdir: Path, dsn: str,
              drill_server: str | None = None) -> tuple[int, dict]:
    # v3.10: dr_drill truyền server container tạm; None → như cũ.
    drill_server = (drill_server or os.environ.get("DRILL_DATABASE_URL")
                    or dsn)
    target = args.target_db or default_target()
    rec = {"ts": bk.vn_now().isoformat(), "backup_file": None,
           "drill_db": target, "status": "fail", "rto_seconds": None,
           "tables_checked": 0, "mismatches": {}, "dropped": None}
    # (1) Guard trước mọi thao tác.
    try:
        guard_name(target, [dsn, drill_server])
        if db_exists(drill_server, target):
            raise Refuse(f"DB '{target}' đã tồn tại — không ghi đè")
    except Refuse as e:
        rec["status"] = "refused"
        print(f"[refuse] {e}")
        return 2, rec
    except psycopg.Error as e:
        rec["error"] = bk.scrub(e, drill_server)
        print(f"[err] không kết nối được server diễn tập: {rec['error']}")
        return 1, rec

    created = False
    tmp_plain = None
    code = 1
    drill_dsn = make_conninfo(drill_server, dbname=target)
    try:
        mpath, m = pick_manifest(bdir, args.backup)
        src = mpath.parent / m["file"]
        rec["backup_file"] = m["file"]
        t0 = time.monotonic()
        # (2) sha256 — bản mới nhất hỏng thì FAIL, không lùi bản cũ.
        if not src.is_file():
            raise RuntimeError(f"thiếu file dump {m['file']}")
        if bk.sha256_file(src) != m["sha256"]:
            raise RuntimeError(f"sha256 lệch manifest: {m['file']}")
        # (3) Giải mã (nếu có) — trước khi tạo DB.
        plain = src
        if m["encrypted"]:
            tmp_plain = plain = _decrypt(
                src, os.environ.get("BACKUP_PASSPHRASE_FILE"), bdir)
        with open(plain, "rb") as fh:
            if fh.read(len(bk.MAGIC)) != bk.MAGIC:
                raise RuntimeError("file sau giải mã không phải pg_dump -Fc")
        # (4) Tạo DB tạm + restore.
        with _admin(drill_server) as c:
            server_major = c.info.server_version // 10000
            c.execute(sql.SQL("create database {}")
                      .format(sql.Identifier(target)))
        created = True
        env = bk.pg_env(drill_server, target)
        tool, _ = bk.resolve_tool("pg_restore", server_major, env)
        with open(plain, "rb") as fh:
            r = subprocess.run(
                bk.tool_argv(tool, "pg_restore",
                             ["--no-owner", "--no-privileges",
                              "--exit-on-error", "--no-password",
                              "-d", target], env),
                env=env, stdin=fh, capture_output=True,
                timeout=RESTORE_TIMEOUT_S, check=False)
        if r.returncode != 0:
            raise RuntimeError(f"pg_restore exit {r.returncode}: "
                               + r.stderr.decode("utf-8", "replace"))
        # (5) So số dòng.
        actual = count_tables(drill_dsn)
        expected = m["row_counts"]
        mism = {t: [expected.get(t), actual.get(t)]
                for t in sorted(set(expected) | set(actual))
                if expected.get(t) != actual.get(t)}
        rec["rto_seconds"] = round(time.monotonic() - t0, 2)
        rec["tables_checked"] = len(expected)
        rec["mismatches"] = mism
        for t in sorted(set(expected) | set(actual)):
            mark = "LỆCH" if t in mism else "khớp"
            print(f"  {t:<22} manifest={expected.get(t)!s:>7} "
                  f"thực tế={actual.get(t)!s:>7}  {mark}")
        ok_n = sum(t not in mism for t in expected)
        print(f"[drill] {m['file']} → {target}: {ok_n}/{len(expected)} bảng"
              f" khớp, RTO {rec['rto_seconds']}s")
        rec["status"] = "mismatch" if mism else "ok"
        code = 1 if mism else 0
    except (psycopg.Error, RuntimeError, OSError,
            subprocess.TimeoutExpired) as e:
        rec["error"] = bk.scrub(e, drill_server)
        print(f"[err] diễn tập lỗi: {rec['error']}")
        code = 1
    finally:
        if tmp_plain is not None:
            tmp_plain.unlink(missing_ok=True)
        if created:
            rec["dropped"] = _drop(drill_server, target)
            if not rec["dropped"]:
                rec["status"] = "drop_failed"
                print(f"[ALERT] còn bản sao dữ liệu ở DB tạm {target} — "
                      "drop tay ngay")
                code = 1
    return code, rec


def _drop(admin_dsn: str, target: str) -> bool:
    try:
        with _admin(admin_dsn) as c:
            c.execute(sql.SQL("drop database if exists {} with (force)")
                      .format(sql.Identifier(target)))
        return not db_exists(admin_dsn, target)
    except psycopg.Error:
        return False


@bk.private_umask
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--backup", help="đường dẫn manifest (mặc định: mới nhất)")
    ap.add_argument("--target-db", help="tên DB tạm (samsam_drill_...)")
    args = ap.parse_args(argv)
    # .env nạp TRƯỚC khi đọc BACKUP_DIR (cùng lý do db_backup.main).
    load_dotenv(bk.ROOT / ".env")
    try:
        bdir = bk.dir_outside_repo(os.environ.get("BACKUP_DIR"), "BACKUP_DIR")
    except bk.UsageError as e:
        print(f"[usage] {e}")
        return 2
    if not bdir.is_dir():
        print("[usage] BACKUP_DIR không tồn tại")
        return 2
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    code, rec = run_drill(args, bdir, dsn)
    bk.append_jsonl(bdir / "drill_runs.jsonl", rec)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
