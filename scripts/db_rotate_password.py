"""Đợt an toàn S01 — kiểm + đổi mật khẩu role Postgres từng lộ, KHÔNG để secret
vào argv/log/stdout.

Quản trị viên chạy trên ĐÚNG môi trường mình được giao (dev / staging / server
Bên B — mỗi môi trường đóng riêng; agent không chạy trên môi trường thật).

  # 1) Hiện trạng (chỉ đọc): biến DSN nào dùng role, mật khẩu có trùng giá trị
  #    lộ không (boolean), đường TCP có thực sự kiểm mật khẩu không.
  python scripts/db_rotate_password.py --check --role R \
      [--env-file F ...] [--leaked-git REV:PATH ...] [--old-password-file F]

  # 2) Đổi: mật khẩu mới SINH ngẫu nhiên vào tệp (tạo mới, quyền chủ sở hữu)
  #    hoặc đọc tệp có sẵn; gửi lên server DẠNG VERIFIER SCRAM-SHA-256 tính
  #    phía client → log câu lệnh của server không chứa mật khẩu rõ.
  python scripts/db_rotate_password.py --rotate --role R \
      --admin-env ADMIN_DATABASE_URL --new-password-file F

  # 3) Kiểm đóng: mật khẩu MỚI vào được + mật khẩu SAI ngẫu nhiên bị từ chối
  #    (chứng minh đường xác thực bằng mật khẩu, không trust/peer) + mật khẩu
  #    CŨ bị từ chối (28P01) — cùng host/cổng/DB TCP.
  python scripts/db_rotate_password.py --verify --role R --dsn-env VAR \
      --new-password-file F [--leaked-git REV:PATH | --old-password-file F]

  # 4) Sau khi quản trị cập nhật nơi dùng: mỗi biến DSN của role kết nối được.
  python scripts/db_rotate_password.py --verify-consumers --role R \
      [--env-file F ...]

Không có chế độ "khôi phục mật khẩu cũ": cập nhật lệch → sửa nơi dùng bằng mật
khẩu MỚI hoặc chạy --rotate lần nữa với mật khẩu mới khác. Công cụ không đổi
pg_hba, không cấp/thu quyền; `--rotate` so thuộc tính role trước/sau.
Exit: 0 đạt · 1 không đạt (kèm lý do) · 2 dùng sai/thiếu đầu vào ·
3 KHÔNG KẾT LUẬN được (vd đường kết nối không kiểm mật khẩu).
"""

import argparse
import base64
import hashlib
import hmac
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import dotenv_values
from psycopg import conninfo, sql

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ROLE_RE = re.compile(r"[a-z_][a-z0-9_$]{0,62}")
DSN_RE = re.compile(r"postgres(?:ql)?://([^:/@\s]+):([^@\s]+)@")
KW_RE = re.compile(r"\buser=(\S+)[^\n]*?\bpassword=(\S+)|\bpassword=(\S+)"
                   r"[^\n]*?\buser=(\S+)")
SCRAM_ITER = 4096
WRONG = "28P01"          # invalid_password


def scram_verifier(password: str, salt: bytes | None = None,
                   iterations: int = SCRAM_ITER) -> str:
    """Verifier SCRAM-SHA-256 dạng Postgres (RFC 5802/7677). Chỉ nhận mật khẩu
    ASCII in được (SASLprep = đồng nhất) — mật khẩu do công cụ sinh luôn đạt."""
    if not password or not all(33 <= ord(c) < 127 for c in password):
        raise ValueError("mật khẩu phải ASCII in được, không khoảng trắng")
    salt = salt or os.urandom(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client = hmac.new(salted, b"Client Key", "sha256").digest()
    server = hmac.new(salted, b"Server Key", "sha256").digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return (f"SCRAM-SHA-256${iterations}:{b64(salt)}$"
            f"{b64(hashlib.sha256(client).digest())}:{b64(server)}")


def _dsn_user_pw(dsn: str):
    try:
        d = conninfo.conninfo_to_dict(dsn)
    except psycopg.ProgrammingError:
        return None, None
    return d.get("user"), d.get("password")


def leaked_passwords(role: str, sources: list[str],
                     old_files: list[Path]) -> set[str]:
    """Mật khẩu cũ/lộ của role từ blob Git (`REV:PATH`) hoặc tệp — chỉ trong
    bộ nhớ, không in."""
    found: set[str] = set()
    for src in sources:
        p = subprocess.run(["git", "show", src], cwd=ROOT, capture_output=True,
                           check=False)
        if p.returncode != 0:
            raise SystemExit(f"[lỗi] không đọc được blob Git {src}")
        text = p.stdout.decode("utf-8", "replace")
        for user, pw in DSN_RE.findall(text):
            if user == role:
                found.add(pw)
        for m in KW_RE.finditer(text):
            user, pw = (m.group(1), m.group(2)) if m.group(1) else (
                m.group(4), m.group(3))
            if user == role:
                found.add(pw)
    for f in old_files:
        v = f.read_text(encoding="utf-8").strip()
        if v:
            found.add(v)
    return found


def _env_sources(env_files: list[Path]) -> list[tuple[str, str, str]]:
    """[(nguồn, tên biến, DSN)] — os.environ + .env repo + tệp env chỉ định."""
    out = [("os.environ", k, v) for k, v in os.environ.items()
           if k.endswith("DATABASE_URL") and v]
    for f in [ROOT / ".env", *env_files]:
        if f.is_file():
            out += [(str(f), k, v) for k, v in dotenv_values(f).items()
                    if k.endswith("DATABASE_URL") and v]
    return out


def consumers(role: str, env_files: list[Path]):
    return [(src, k, v) for src, k, v in _env_sources(env_files)
            if _dsn_user_pw(v)[0] == role]


def _connect(dsn: str, user: str, password: str):
    d = conninfo.conninfo_to_dict(dsn)
    d.update(user=user, password=password)
    d.pop("connect_timeout", None)
    return psycopg.connect(conninfo.make_conninfo(**d), connect_timeout=5)


def try_login(dsn: str, user: str, password: str) -> str:
    """'ok' | sqlstate | tên lỗi — không in DSN/mật khẩu."""
    try:
        with _connect(dsn, user, password) as c:
            c.execute("select 1")
        return "ok"
    except psycopg.Error as e:
        code = getattr(e, "sqlstate", None)
        if code:
            return code
        msg = str(e)        # lỗi lúc connect: psycopg không gắn sqlstate
        if "password authentication failed" in msg:
            return WRONG
        if "no pg_hba.conf entry" in msg:
            return "28000"
        return type(e).__name__


def _tcp(dsn: str) -> bool:
    host = conninfo.conninfo_to_dict(dsn).get("host") or ""
    return bool(host) and not host.startswith("/")


def _where(dsn: str) -> str:
    d = conninfo.conninfo_to_dict(dsn)
    return f"{d.get('host')}:{d.get('port') or 5432}/{d.get('dbname')}"


def _read_new(path: Path, create: bool) -> str:
    if path.exists():
        pw = path.read_text(encoding="utf-8").strip()
    elif create:
        pw = secrets.token_urlsafe(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(pw + "\n")
        print(f"[ok] sinh mật khẩu mới vào {path} (tạo mới, chỉ chủ sở hữu"
              " đọc) — chuyển vào trình quản lý mật khẩu của Bên B rồi xóa tệp")
    else:
        raise SystemExit(f"[lỗi] thiếu tệp mật khẩu mới {path}")
    if not pw:
        raise SystemExit("[lỗi] tệp mật khẩu mới rỗng")
    return pw


def _role_attrs(conn, role: str):
    return conn.execute(
        "select rolsuper, rolcreaterole, rolcreatedb, rolreplication,"
        " rolbypassrls, rolcanlogin, (select array_agg(b.rolname order by"
        " b.rolname) from pg_auth_members m join pg_roles b on b.oid ="
        " m.roleid where m.member = r.oid) from pg_roles r where rolname = %s",
        (role,)).fetchone()


def cmd_check(a) -> int:
    old = leaked_passwords(a.role, a.leaked_git, a.old_password_file)
    print(f"# kiểm {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
          f" · role {a.role} · nguồn giá trị lộ: {len(a.leaked_git)} blob Git"
          f" + {len(a.old_password_file)} tệp → {len(old)} giá trị (không in)")
    cons = consumers(a.role, a.env_file)
    if not cons:
        print("[!] không thấy biến *DATABASE_URL nào dùng role này trong các"
              " nguồn đã quét")
    rc = 0
    for src, k, dsn in cons:
        _u, pw = _dsn_user_pw(dsn)
        same = pw in old if old else None
        line = (f"  {src} :: {k} → {_where(dsn)} · TCP={_tcp(dsn)} · "
                f"trùng giá trị lộ={same}")
        if _tcp(dsn) and pw:
            probe = dsn
            if a.probe_db:            # thử đường xác thực trên DB khác (vd
                d = conninfo.conninfo_to_dict(dsn)    # không chạm DB vận hành)
                d["dbname"] = a.probe_db
                probe = conninfo.make_conninfo(**d)
            wrong = try_login(probe, a.role, "sai-" + secrets.token_urlsafe(12))
            line += (" · đường xác thực kiểm mật khẩu="
                     f"{wrong == WRONG} ({wrong})")
        print(line)
        if same:
            rc = 1
    print("[KẾT LUẬN] " + ("CÒN dùng giá trị đã lộ — chưa rotation" if rc else
                           "không biến nào trong phạm vi quét trùng giá trị lộ"
                           if old else "không có nguồn giá trị lộ để so"))
    return rc if old else 3


def cmd_rotate(a) -> int:
    admin = os.environ.get(a.admin_env) or dotenv_values(ROOT / ".env").get(
        a.admin_env)
    if not admin:
        print(f"[lỗi] biến {a.admin_env} rỗng", file=sys.stderr)
        return 2
    new = _read_new(a.new_password_file, create=True)
    with psycopg.connect(admin, connect_timeout=5, autocommit=True) as c:
        before = _role_attrs(c, a.role)
        if before is None:
            print(f"[lỗi] không có role {a.role}", file=sys.stderr)
            return 1
        c.execute(sql.SQL("alter role {} password {}").format(
            sql.Identifier(a.role), sql.Literal(scram_verifier(new))))
        after = _role_attrs(c, a.role)
    print(f"[ok] {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
          f" đổi mật khẩu role {a.role} (gửi verifier SCRAM, không gửi mật"
          " khẩu rõ)")
    if before != after:
        print("[LỖI] thuộc tính/role thành viên đổi ngoài ý muốn",
              file=sys.stderr)
        return 1
    print("[ok] thuộc tính role + thành viên giữ nguyên (không tăng quyền)")
    print("[tiếp] cập nhật mọi nơi dùng role (biến DSN, EnvironmentFile "
          "systemd, máy khác) rồi chạy --verify và --verify-consumers")
    return 0


def cmd_verify(a) -> int:
    dsn = os.environ.get(a.dsn_env) or dotenv_values(ROOT / ".env").get(
        a.dsn_env)
    if not dsn or not _tcp(dsn):
        print(f"[lỗi] {a.dsn_env} rỗng hoặc không phải TCP (socket local có thể"
              " trust/peer — không chứng minh thu hồi)", file=sys.stderr)
        return 2
    new = _read_new(a.new_password_file, create=False)
    old = leaked_passwords(a.role, a.leaked_git, a.old_password_file)
    if not old:
        print("[lỗi] cần --leaked-git hoặc --old-password-file",
              file=sys.stderr)
        return 2
    r_new = try_login(dsn, a.role, new)
    r_wrong = try_login(dsn, a.role, "sai-" + secrets.token_urlsafe(12))
    r_old = sorted({try_login(dsn, a.role, o) for o in old})
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"# verify {ts} · role {a.role} · {_where(dsn)} (TCP)")
    print(f"  mật khẩu MỚI: {r_new}")
    print(f"  mật khẩu SAI ngẫu nhiên: {r_wrong} (28P01 = đường kiểm mật khẩu)")
    print(f"  mật khẩu CŨ/lộ ({len(old)} giá trị): {r_old}")
    if r_wrong != WRONG:
        print("[KHÔNG KẾT LUẬN] đường kết nối không kiểm mật khẩu (trust/"
              "peer/hba khác) — kiểm từ máy/đường có scram/md5")
        return 3
    if r_new == "ok" and r_old == [WRONG]:
        print("[ĐẠT] mới dùng được, cũ bị từ chối trên đường kiểm mật khẩu")
        return 0
    print("[KHÔNG ĐẠT]")
    return 1


def cmd_consumers(a) -> int:
    cons = consumers(a.role, a.env_file)
    if not cons:
        print("[!] không thấy biến DSN nào dùng role này")
        return 3
    bad = 0
    for src, k, dsn in cons:
        _u, pw = _dsn_user_pw(dsn)
        r = try_login(dsn, a.role, pw or "")
        bad += r != "ok"
        print(f"  {src} :: {k} → {_where(dsn)} · kết nối: {r}")
    return 1 if bad else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/db_rotate_password.py")
    g = ap.add_mutually_exclusive_group(required=True)
    for f in ("--check", "--rotate", "--verify", "--verify-consumers"):
        g.add_argument(f, action="store_true")
    ap.add_argument("--role", required=True)
    ap.add_argument("--env-file", type=Path, action="append", default=[])
    ap.add_argument("--leaked-git", action="append", default=[],
                    metavar="REV:PATH")
    ap.add_argument("--old-password-file", type=Path, action="append",
                    default=[])
    ap.add_argument("--new-password-file", type=Path)
    ap.add_argument("--admin-env", default="ADMIN_DATABASE_URL")
    ap.add_argument("--dsn-env", default="DATABASE_URL")
    ap.add_argument("--probe-db", help="--check: DB dùng để thử đường xác "
                    "thực (mặc định DB của DSN)")
    a = ap.parse_args(argv)
    if not ROLE_RE.fullmatch(a.role):
        ap.error("--role không hợp lệ")
    if (a.rotate or a.verify) and not a.new_password_file:
        ap.error("--rotate/--verify cần --new-password-file")
    if a.check:
        return cmd_check(a)
    if a.rotate:
        return cmd_rotate(a)
    if a.verify:
        return cmd_verify(a)
    return cmd_consumers(a)


if __name__ == "__main__":
    sys.exit(main())
