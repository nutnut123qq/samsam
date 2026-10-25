"""Sao lưu Postgres (v3.6, luồng F17.4 bước 2) — 1 lệnh, chạy lại an toàn.

Chạy: `python scripts/db_backup.py`. Đọc `DATABASE_URL` và các biến dưới
từ env tiến trình hoặc `.env` ở root repo (nạp TRƯỚC khi kiểm cấu hình;
env tiến trình thắng `.env`):

- `BACKUP_DIR` (BẮT BUỘC, NGOÀI repo) — nơi chứa file backup + nhật ký
  `backup_runs.jsonl`. Trong repo → từ chối (exit 2, không tạo thư mục).
- `BACKUP_KEEP` (mặc định 7, số nguyên ≥1) — giữ N bản mới nhất theo
  `created_at` trong manifest; chỉ dọn SAU khi bản mới thành công, không
  đụng file lạ / manifest hỏng / `.partial` / `*.jsonl`. Xóa bản cũ lỗi
  (file bị khóa, quyền) → `[warn]` + `retention_error` trong nhật ký,
  KHÔNG chặn offsite/nhật ký, exit giữ nguyên.
- `BACKUP_PASSPHRASE_FILE` (tùy chọn, NGOÀI repo) — có thì mã hóa
  `openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass file:<path>`
  (passphrase không vào argv), bản rõ bị xóa. openssl chỉ dùng DÒNG ĐẦU
  của file → dòng đầu trống/ngắn hơn 16 ký tự = usage exit 2 (không để
  mã hóa bằng passphrase rỗng mà manifest vẫn ghi `encrypted`); không tìm
  thấy openssl →
  exit 1, KHÔNG ghi bản rõ (fail-closed). Không có → `[warn]` bản chưa
  mã hóa (khóa công ty giữ = external-dep; F17.4 chọn `age`, máy chưa có).
- `BACKUP_OFFSITE` (tùy chọn): rỗng → `[warn]`; `dir:<path>` (ngoài repo)
  → chép dump + manifest, kiểm lại sha256, retention như local;
  `s3://<bucket>/<prefix>` → KHÔNG gọi mạng, báo external-dep, exit 3.
- r13: `BACKUP_REQUIRE_ENCRYPTION=1` → thiếu `BACKUP_PASSPHRASE_FILE` = exit 2
  (không bao giờ ghi bản rõ); `BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE=1` →
  offsite cùng thiết bị (`st_dev`) với BACKUP_DIR = exit 2 (không bật: chỉ
  `[warn]`). Khác thiết bị KHÔNG chứng minh khác máy — Bên B xác nhận.
- `PG_BIN` (tùy chọn) — thư mục chứa `pg_dump`/`pg_restore`.

Chọn công cụ Postgres (ghi vào manifest `tool`), theo thứ tự:
(1) `PG_BIN`; (2) `pg_dump` trên PATH; (3) `C:/Program Files/PostgreSQL/
<major>/bin` với major = major của server; (4) docker image
`postgres:<major>-alpine` nếu đã có sẵn (KHÔNG tự `docker pull`; host
localhost → `host.docker.internal`). Không có → exit 1. Major công cụ phải
≥ major server. Mật khẩu/DSN KHÔNG vào argv — truyền qua env `PG*`; mọi
subprocess có timeout + `PGCONNECT_TIMEOUT`.

Nhất quán: mở tx `repeatable read, read only` → `pg_export_snapshot()` →
đếm `count(*)` mọi bảng public trong CÙNG snapshot → `pg_dump -Fc
--snapshot=<id>` khi tx còn mở. Số dòng trong manifest vì vậy khớp đúng
nội dung file dù có ghi đồng thời.

Output: `<db>_<YYYYmmdd_HHMMSS>_vn.dump[.enc]` (giờ VN +07:00) +
`<file>.manifest.json` (format, created_at, db_name, server_version,
pg_dump_version, tool, file, size_bytes, sha256, encrypted, cipher,
row_counts) — không host/user/mật khẩu.

Bằng chứng đầu ra trong DB (v15 fix P8.7c, PL02 mục 1b): backup thành
công (local + offsite nếu có) → ghi NGAY bản ghi `backup_runs` (JSON sort
key — đúng chuỗi dòng nhật ký) vào sổ append-only `file_output_evidence` qua
function `file_output_evidence_backup` bằng CHÍNH login của tiến trình
(`svc_backup` qua BACKUP_DATABASE_URL — job `backup`; owner ở dev). DB tự
tính khóa `bk:<sha256 bản dump>` + sha phiên bản; người duyệt từng đầu ra
(`rollout --outputs/--review-output data_platform-07.2`) và cổng PL02 đếm
từ sổ này — không đọc file nhật ký. Ghi không được → `[warn]`, exit 4.

Exit: 0 OK; 1 lỗi (thiếu DSN, connect lỗi, không có công cụ, pg_dump lỗi,
tên đích tồn tại — xóa `.partial`, không để manifest); 2 usage (kiểm TRƯỚC
khi connect); 3 local OK nhưng offsite chưa xong (giám sát phân biệt với
lỗi dump); 4 backup OK nhưng CHƯA ghi được bằng chứng DB (login không phải
dịch vụ backup / schema cũ chưa `apply_schema --roles`) — bản backup giữ
nguyên, lần này không thành đầu ra đếm được.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
VN_TZ = timezone(timedelta(hours=7))  # VN không có DST
CONNECT_TIMEOUT = 10
DUMP_TIMEOUT_S = 3600
CIPHER = "openssl-aes-256-cbc-pbkdf2"
OPENSSL_ENC = ["enc", "-aes-256-cbc", "-salt", "-pbkdf2", "-iter", "200000"]
MAGIC = b"PGDMP"
PG_WIN_BASE = "C:/Program Files/PostgreSQL"  # bộ cài Windows chuẩn
NAME_RE = re.compile(r"^[A-Za-z0-9_-]+_\d{8}_\d{6}_vn\.dump(\.enc)?$")
MANIFEST_SUFFIX = ".manifest.json"
MIN_PASSPHRASE = 16
MANIFEST_KEYS = ("format", "created_at", "db_name", "server_version",
                 "pg_dump_version", "tool", "file", "size_bytes", "sha256",
                 "encrypted", "cipher", "row_counts")
_PG_ENV = {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER",
           "password": "PGPASSWORD", "dbname": "PGDATABASE",
           "sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT"}
_LOCAL_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


class UsageError(Exception):
    pass


# ---------- tiện ích chung (db_restore_drill dùng lại) ----------

def vn_now() -> datetime:
    return datetime.now(VN_TZ).replace(microsecond=0)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def inside_repo(path: Path) -> bool:
    p = path.resolve()
    return p == ROOT or ROOT in p.parents


def dir_outside_repo(value: str | None, var: str) -> Path:
    """Path ngoài repo cho biến env `var`; vi phạm → UsageError."""
    if not value:
        raise UsageError(f"thiếu {var}")
    p = Path(value).expanduser()
    if inside_repo(p):
        raise UsageError(f"{var} nằm trong repo — phải đặt NGOÀI repo")
    return p.resolve()


def append_jsonl(path: Path, rec: dict) -> None:
    """Append BYTES + `\\n` tường minh (gotcha convlog: không text-mode)."""
    line = json.dumps(rec, ensure_ascii=False).encode("utf-8") + b"\n"
    with open(path, "ab") as f:
        f.write(line)


def write_json_atomic(path: Path, obj: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(json.dumps(obj, ensure_ascii=False, indent=2)
                    .encode("utf-8") + b"\n")
    os.replace(tmp, path)


def scrub(msg: str, dsn: str | None) -> str:
    """Rút gọn thông báo lỗi + che host/user/mật khẩu/DSN (không vào log)."""
    msg = str(msg)
    if dsn:
        msg = msg.replace(dsn, "<dsn>")
        try:
            parts = conninfo_to_dict(dsn)
        except psycopg.Error:
            parts = {}
        for k in ("password", "user", "host"):
            v = parts.get(k)
            if v and len(str(v)) >= 3:
                msg = msg.replace(str(v), f"<{k}>")
    msg = re.sub(r"postgres(?:ql)?://\S+", "<dsn>", msg)
    return " ".join(msg.split())[:300]


def pg_env(dsn: str, dbname: str | None = None) -> dict:
    """Env cho subprocess công cụ PG: DSN tách thành biến PG* (không argv).

    Xóa PG* thừa kế để DSN là nguồn duy nhất."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")
           or k == "PG_BIN"}
    for k, v in conninfo_to_dict(dsn).items():
        if k in _PG_ENV and v not in (None, ""):
            env[_PG_ENV[k]] = str(v)
    if dbname:
        env["PGDATABASE"] = dbname
    env["PGCONNECT_TIMEOUT"] = str(CONNECT_TIMEOUT)
    return env


def _exe(name: str) -> str:
    return name + (".exe" if os.name == "nt" else "")


def _docker_has_image(image: str) -> bool:
    docker = shutil.which("docker")
    if not docker:
        return False
    try:
        r = subprocess.run([docker, "image", "inspect", image],
                           capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def find_tool(name: str, major: int) -> tuple[str, str] | None:
    """('native', path) | ('docker', image) | None — thứ tự xem docstring."""
    pg_bin = os.environ.get("PG_BIN")
    if pg_bin:
        p = Path(pg_bin) / _exe(name)
        if p.exists():
            return ("native", p.as_posix())
        print(f"[warn] PG_BIN không có {_exe(name)} — thử cách khác")
    w = shutil.which(name)
    if w:
        return ("native", Path(w).as_posix())
    p = Path(PG_WIN_BASE) / str(major) / "bin" / _exe(name)
    if p.exists():
        return ("native", p.as_posix())
    image = f"postgres:{major}-alpine"
    if _docker_has_image(image):
        return ("docker", image)
    return None


def tool_label(tool: tuple[str, str]) -> str:
    return f"{tool[0]}:{tool[1]}"


def tool_argv(tool: tuple[str, str], name: str, args: list[str],
              env: dict) -> list[str]:
    """argv chạy công cụ; dữ liệu đi qua stdin/stdout (cả native lẫn docker).

    Docker: biến PG* chuyển vào container bằng `-e NAME` (không kèm giá trị
    → mật khẩu không nằm trong argv); host local → host.docker.internal."""
    kind, where = tool
    if kind == "native":
        return [where, *args]
    argv = ["docker", "run", "--rm", "-i"]
    for var in sorted(set(_PG_ENV.values()) | {"PGCONNECT_TIMEOUT"}):
        if var not in env:
            continue
        if var == "PGHOST" and env[var] in _LOCAL_HOSTS:
            argv += ["-e", "PGHOST=host.docker.internal"]
        else:
            argv += ["-e", var]
    return argv + [where, name, *args]


def tool_major(tool: tuple[str, str], name: str, env: dict) -> tuple[int, str]:
    r = subprocess.run(tool_argv(tool, name, ["--version"], env), env=env,
                       capture_output=True, timeout=120, check=False)
    out = r.stdout.decode("utf-8", "replace").strip()
    m = re.search(r"(\d+)(?:\.\d+)?", out)
    if r.returncode != 0 or not m:
        raise RuntimeError(f"{name} --version lỗi")
    return int(m.group(1)), out


def resolve_tool(name: str, server_major: int, env: dict):
    """(tool, version_text) đã kiểm major ≥ server; lỗi → RuntimeError."""
    tool = find_tool(name, server_major)
    if tool is None:
        raise RuntimeError(
            f"không tìm thấy {name} (PG_BIN / PATH / C:/Program Files/"
            f"PostgreSQL/{server_major}/bin / docker postgres:"
            f"{server_major}-alpine)")
    major, text = tool_major(tool, name, env)
    if major < server_major:
        raise RuntimeError(f"{name} major {major} < server {server_major}")
    return tool, text


def find_openssl() -> str | None:
    w = shutil.which("openssl")
    if w:
        return w
    for p in ("C:/Program Files/Git/usr/bin/openssl.exe",
              "C:/Program Files/Git/mingw64/bin/openssl.exe"):
        if Path(p).exists():
            return p
    return None


def load_manifest(path: Path) -> dict | None:
    """Manifest hợp lệ (đủ key, format=1, `file` khớp tên manifest — chặn
    manifest trỏ file ngoài thư mục) hoặc None."""
    if not path.name.endswith(MANIFEST_SUFFIX):
        return None
    fname = path.name[:-len(MANIFEST_SUFFIX)]
    if not NAME_RE.match(fname):
        return None
    try:
        m = json.loads(path.read_bytes().decode("utf-8"))
        if (not isinstance(m, dict) or m.get("format") != 1
                or m.get("file") != fname
                or not all(k in m for k in MANIFEST_KEYS)
                or not isinstance(m["row_counts"], dict)):
            return None
        m["_created"] = datetime.fromisoformat(m["created_at"])
        if m["_created"].tzinfo is None:
            return None
    except (ValueError, TypeError, UnicodeDecodeError, OSError):
        return None
    return m


def valid_manifests(d: Path, db_name: str | None = None) -> list[tuple]:
    """[(created, manifest_path, manifest)] mới nhất trước."""
    out = []
    for p in d.glob("*" + MANIFEST_SUFFIX):
        m = load_manifest(p)
        if m and (db_name is None or m["db_name"] == db_name):
            out.append((m["_created"], p, m))
    out.sort(key=lambda t: t[0], reverse=True)
    return out


def apply_retention(d: Path, keep: int,
                    db_name: str) -> tuple[list[str], list[str]]:
    """Giữ `keep` bản mới nhất theo created_at; xóa cặp dump+manifest cũ.

    Trả (đã xóa, lỗi): 1 file bị khóa/thiếu quyền không chặn bản khác,
    không làm hỏng lần backup vừa xong (caller chỉ cảnh báo)."""
    removed, errors = [], []
    for _, mpath, m in valid_manifests(d, db_name)[keep:]:
        try:
            (d / m["file"]).unlink(missing_ok=True)
            mpath.unlink(missing_ok=True)
        except OSError as e:
            errors.append(f"{m['file']}: {e.strerror or e}")
            continue
        removed.append(m["file"])
    return removed, errors


def check_passfile(path: Path) -> None:
    """openssl `-pass file:` chỉ lấy DÒNG ĐẦU (cắt ở `\\n`) — dòng đầu
    trống/ngắn → mã hóa bằng khóa rỗng/yếu mà vẫn ghi `encrypted`.
    openssl còn đọc passphrase như chuỗi C (dừng ở byte NUL): file UTF-16
    (PowerShell 5.1 `>`/Out-File, Notepad 'Unicode') dài >16 byte nhưng
    khóa thật chỉ ~3 byte (BOM + 1 ký tự) → fail-open. Từ chối NUL/BOM
    UTF-16 thay vì đếm byte. Vi phạm → UsageError."""
    first = path.read_bytes().split(b"\n", 1)[0].rstrip(b"\r")
    if b"\x00" in first or first.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise UsageError("dòng đầu BACKUP_PASSPHRASE_FILE chứa NUL/BOM "
                         "UTF-16 — file passphrase phải là UTF-8/ASCII "
                         "(openssl cắt khóa ở byte NUL)")
    if not first.strip() or len(first) < MIN_PASSPHRASE:
        raise UsageError(f"dòng đầu BACKUP_PASSPHRASE_FILE trống hoặc ngắn "
                         f"hơn {MIN_PASSPHRASE} ký tự (openssl chỉ dùng dòng"
                         f" đầu)")


# ---------- backup ----------

def read_config(env=os.environ) -> dict:
    """Kiểm usage TRƯỚC khi connect; vi phạm → UsageError (exit 2)."""
    bdir = dir_outside_repo(env.get("BACKUP_DIR"), "BACKUP_DIR")
    raw_keep = env.get("BACKUP_KEEP", "7").strip() or "7"
    if not re.fullmatch(r"\d+", raw_keep) or int(raw_keep) < 1:
        raise UsageError("BACKUP_KEEP phải là số nguyên ≥ 1")
    passfile = None
    if env.get("BACKUP_PASSPHRASE_FILE"):
        passfile = dir_outside_repo(env["BACKUP_PASSPHRASE_FILE"],
                                    "BACKUP_PASSPHRASE_FILE")
        if not passfile.is_file():
            raise UsageError("BACKUP_PASSPHRASE_FILE không tồn tại")
        check_passfile(passfile)
    if passfile is None and _flag(env, "BACKUP_REQUIRE_ENCRYPTION"):
        # r13 (data_platform-90): server Bên B bật cờ này → KHÔNG bao giờ ghi
        # bản rõ (thiếu khóa = usage exit 2 trước khi connect).
        raise UsageError("BACKUP_REQUIRE_ENCRYPTION=1 nhưng chưa có "
                         "BACKUP_PASSPHRASE_FILE — không ghi bản chưa mã hóa")
    off = (env.get("BACKUP_OFFSITE") or "").strip()
    offsite = None
    if off.startswith("dir:"):
        offsite = ("dir", dir_outside_repo(off[4:], "BACKUP_OFFSITE dir:"))
        if same_device(bdir, offsite[1]):
            # r13: cùng thiết bị lưu trữ với BACKUP_DIR = chưa phải offsite.
            if _flag(env, "BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE"):
                raise UsageError("BACKUP_OFFSITE cùng thiết bị lưu trữ với "
                                 "BACKUP_DIR — không phải bản sao ngoài máy")
            print("[warn] BACKUP_OFFSITE cùng thiết bị lưu trữ với BACKUP_DIR "
                  "(st_dev) — chưa phải offsite thật")
    elif off.startswith("s3://"):
        offsite = ("s3", off)
    elif off:
        raise UsageError("BACKUP_OFFSITE phải là dir:<path> hoặc s3://...")
    return {"dir": bdir, "keep": int(raw_keep), "passfile": passfile,
            "offsite": offsite}


def _flag(env, name: str) -> bool:
    return (env.get(name) or "").strip() == "1"


def same_device(a: Path, b: Path) -> bool:
    """Hai đường (thư mục gần nhất đang tồn tại) cùng `st_dev`? Khác thiết
    bị KHÔNG chứng minh khác máy (ổ mạng vẫn có thể cùng host) — chỉ là điều
    kiện cần; máy offsite thật do Bên B xác nhận."""
    def dev(p: Path) -> int:
        p = Path(p).resolve()
        while not p.exists() and p.parent != p:
            p = p.parent
        return p.stat().st_dev
    return dev(a) == dev(b)


def _snapshot_counts(conn) -> dict:
    tables = [r[0] for r in conn.execute(
        "select table_name from information_schema.tables"
        " where table_schema = 'public' and table_type = 'BASE TABLE'"
        " order by 1")]
    return {t: conn.execute(sql.SQL("select count(*) from {}")
                            .format(sql.Identifier(t))).fetchone()[0]
            for t in tables}


def _offsite_copy(cfg: dict, files: list[Path], sha: str,
                  db: str) -> tuple[str, list[str]]:
    """Chép sang thư mục offsite; trả (mô tả, lỗi retention); lỗi copy/
    sha lệch → RuntimeError/OSError. Kiểm sha256 bản dump TRƯỚC khi đổi
    tên → offsite không bao giờ có cặp dump hỏng + manifest; `.partial`
    dở bị xóa."""
    kind, target = cfg["offsite"]
    if kind == "s3":
        raise RuntimeError(
            "[external-dep] offsite S3-compatible (Bizfly/Backblaze) chưa "
            "bật — cần key + công cụ rclone/aws-cli")
    target.mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(files):
        tmp = target / (src.name + ".partial")
        try:
            shutil.copyfile(src, tmp)
            if i == 0 and sha256_file(tmp) != sha:
                raise RuntimeError("sha256 bản offsite lệch manifest")
            os.replace(tmp, target / src.name)
        finally:
            tmp.unlink(missing_ok=True)
    _, errors = apply_retention(target, cfg["keep"], db)
    return "dir", errors


def record_evidence(dsn: str, rec: dict) -> str | None:
    """v15 fix P8.7c: ghi bằng chứng lần backup `ok` vào DB (function
    `file_output_evidence_backup`, kết nối ghi riêng — kết nối dump là read
    only) → None | lý do lỗi (đã che DSN). Chuỗi gửi = JSON sort key của
    đúng bản ghi nhật ký (sha = `rollout._rec_sha` dòng backup_runs)."""
    text = json.dumps(rec, sort_keys=True, ensure_ascii=False)
    try:
        with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT,
                             autocommit=True) as c:
            c.execute("select file_output_evidence_backup(%s, false)",
                      (text,))
    except psycopg.Error as e:
        prim = getattr(getattr(e, "diag", None), "message_primary", None)
        return scrub(prim or type(e).__name__, dsn)
    return None


def _with_evidence(code: int, rec: dict, dsn: str) -> tuple[int, dict]:
    why = record_evidence(dsn, rec)
    if why is None:
        print("[evidence] đã ghi bằng chứng đầu ra vào DB "
              "(file_output_evidence)")
        return code, rec
    print(f"[warn] backup xong nhưng CHƯA ghi được bằng chứng DB: {why}")
    return 4, rec


def run_backup(cfg: dict, dsn: str) -> tuple[int, dict]:
    """Thực hiện backup; trả (exit_code, bản ghi backup_runs)."""
    bdir = cfg["dir"]
    rec = {"ts": vn_now().isoformat(), "status": "fail", "file": None,
           "size_bytes": None, "sha256": None, "offsite": None,
           "error": None, "retention_error": None}
    partials: list[Path] = []
    try:
        with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT) as conn:
            conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
            conn.read_only = True
            server_major = conn.info.server_version // 10000
            server_version = conn.execute("show server_version").fetchone()[0]
            db = conn.info.dbname
            env = pg_env(dsn, db)
            tool, dump_ver = resolve_tool("pg_dump", server_major, env)
            if cfg["passfile"] and not find_openssl():
                raise RuntimeError("có BACKUP_PASSPHRASE_FILE nhưng không tìm"
                                   " thấy openssl — từ chối ghi bản rõ")
            snap = conn.execute("select pg_export_snapshot()").fetchone()[0]
            counts = _snapshot_counts(conn)
            created = vn_now()
            safe_db = re.sub(r"[^A-Za-z0-9_-]", "_", db)
            base = f"{safe_db}_{created:%Y%m%d_%H%M%S}_vn.dump"
            final = base + (".enc" if cfg["passfile"] else "")
            for n in (base, base + ".enc", final + MANIFEST_SUFFIX):
                if (bdir / n).exists():
                    raise RuntimeError(f"file đích đã tồn tại: {n}")
            rec["file"] = final
            plain = bdir / (base + ".partial")
            partials.append(plain)
            with open(plain, "wb") as fh:
                r = subprocess.run(
                    tool_argv(tool, "pg_dump",
                              ["-Fc", f"--snapshot={snap}", "--no-password"],
                              env),
                    env=env, stdout=fh, stderr=subprocess.PIPE,
                    timeout=DUMP_TIMEOUT_S, check=False)
            if r.returncode != 0:
                raise RuntimeError(f"pg_dump exit {r.returncode}: "
                                   + r.stderr.decode("utf-8", "replace"))
            conn.rollback()
        with open(plain, "rb") as fh:
            if fh.read(len(MAGIC)) != MAGIC:
                raise RuntimeError("file dump không có magic PGDMP")
        out = plain
        if cfg["passfile"]:
            enc = bdir / (final + ".partial")
            partials.append(enc)
            r = subprocess.run(
                [find_openssl(), *OPENSSL_ENC, "-pass",
                 f"file:{cfg['passfile']}", "-in", str(plain),
                 "-out", str(enc)],
                capture_output=True, timeout=DUMP_TIMEOUT_S, check=False)
            if r.returncode != 0:
                raise RuntimeError("openssl enc lỗi: " + r.stderr.decode(
                    "utf-8", "replace"))
            plain.unlink()
            out = enc
        dest = bdir / final
        if dest.exists():
            raise RuntimeError(f"file đích đã tồn tại: {final}")
        os.replace(out, dest)
        partials.remove(out)
        partials.append(dest)  # lỗi trước khi có manifest → không để mồ côi
        sha = sha256_file(dest)
        manifest = {
            "format": 1, "created_at": created.isoformat(), "db_name": db,
            "server_version": server_version, "pg_dump_version": dump_ver,
            "tool": tool_label(tool), "file": final,
            "size_bytes": dest.stat().st_size, "sha256": sha,
            "encrypted": bool(cfg["passfile"]),
            "cipher": CIPHER if cfg["passfile"] else None,
            "row_counts": counts}
        mpath = bdir / (final + MANIFEST_SUFFIX)
        write_json_atomic(mpath, manifest)
        partials.remove(dest)
    except (psycopg.Error, RuntimeError, OSError,
            subprocess.TimeoutExpired) as e:
        rec["error"] = scrub(e, dsn)
        print(f"[err] backup lỗi: {rec['error']}")
        return 1, rec
    finally:
        for p in partials:  # bản rõ/dở không bao giờ nằm lại
            p.unlink(missing_ok=True)

    rec.update(status="ok", size_bytes=manifest["size_bytes"], sha256=sha)
    print(f"[done] {final} — {manifest['size_bytes']} bytes, sha256 "
          f"{sha[:16]}…, tool {manifest['tool']}, {len(counts)} bảng")
    if not cfg["passfile"]:
        print("[warn] backup CHƯA mã hóa (external-dep: khóa công ty)")
    ret_errors: list[str] = []

    def note_retention(where: str, errors: list[str]) -> None:
        # Dọn bản cũ lỗi KHÔNG làm hỏng bản vừa xong: cảnh báo + ghi nhật
        # ký, vẫn chạy offsite + ghi backup_runs.
        for err in errors:
            ret_errors.append(scrub(f"{where} {err}", dsn))
            print(f"[warn] retention lỗi: {ret_errors[-1]}")
        rec["retention_error"] = "; ".join(ret_errors)[:300] or None

    removed, errors = apply_retention(bdir, cfg["keep"], db)
    note_retention("local", errors)
    if removed:
        print(f"[retention] giữ {cfg['keep']} bản, xóa: {', '.join(removed)}")
    if cfg["offsite"] is None:
        print("[warn] chưa cấu hình offsite (BACKUP_OFFSITE)")
        return _with_evidence(0, rec, dsn)
    try:
        rec["offsite"], errors = _offsite_copy(cfg, [dest, mpath], sha, db)
    except (RuntimeError, OSError) as e:
        rec.update(status="offsite_fail", error=scrub(e, dsn))
        print(f"[warn] offsite chưa xong, bản local giữ nguyên: "
              f"{rec['error']}")
        return 3, rec
    note_retention("offsite", errors)
    print("[offsite] đã chép + kiểm sha256")
    return _with_evidence(0, rec, dsn)


def private_umask(fn):
    """Chạy `fn` với umask 077: dump/manifest/nhật ký (có PII khách) chỉ
    chủ sở hữu đọc được trên VM Linux; khôi phục umask cũ sau đó."""
    def wrapper(*a, **k):
        old = os.umask(0o077)
        try:
            return fn(*a, **k)
        finally:
            os.umask(old)
    return wrapper


@private_umask
def main() -> int:
    # .env nạp TRƯỚC read_config: BACKUP_* trong .env (deploy/cloud/README
    # mục 2) phải có hiệu lực — nạp sau thì passphrase/offsite bị bỏ câm
    # (bản rõ, exit 0). load_dotenv không connect → vẫn kiểm usage trước
    # connect.
    load_dotenv(ROOT / ".env")
    try:
        cfg = read_config()
    except UsageError as e:
        print(f"[usage] {e}")
        return 2
    dsn = os.environ.get("DATABASE_URL")
    cfg["dir"].mkdir(parents=True, exist_ok=True)
    if not dsn:
        code, rec = 1, {"ts": vn_now().isoformat(), "status": "fail",
                        "file": None, "size_bytes": None, "sha256": None,
                        "offsite": None, "error": "thiếu DATABASE_URL",
                        "retention_error": None}
        print("[err] thiếu DATABASE_URL trong .env")
    else:
        code, rec = run_backup(cfg, dsn)
    append_jsonl(cfg["dir"] / "backup_runs.jsonl", rec)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
