"""Cổng DB cho test (đợt hợp đồng P0) — test KHÔNG BAO GIỜ kết nối DB
production (`samsam`), kể cả qua dotenv fallback.

Sự cố gốc (20/10/2026): shell không đặt `DATABASE_URL` → conftest/import
gọi `load_dotenv(.env)` → fixture lấy DSN `.env` trỏ `samsam`.

Cơ chế (chỉ trong phiên pytest — `install()` gọi ở dòng đầu
`tests/conftest.py`, TRƯỚC mọi import dự án; app production không đổi):
  1. Driver: bọc `psycopg.Connection.connect` (= `psycopg.connect`) và
     `psycopg2.connect`. Phân giải dbname THẬT bằng libpq
     (`psycopg.conninfo.conninfo_to_dict(conninfo, **kwargs)` — URI, keyword,
     `?dbname=` trong query, kwargs ghi đè) → thiếu thì `PGDATABASE`. KHÔNG
     suy DB từ user (`user`/`PGUSER`/user OS — mặc định libpq): không xác
     định được DB đích tường minh → TỪ CHỐI (vá 21/10, controller:
     `connect("")` từng tới driver). `service=`/`PGSERVICE` hoặc DSN hỏng →
     TỪ CHỐI. dbname ∈ cấm
     (`samsam` + dbname mọi `*DATABASE_URL` trong `.env`, so không phân biệt
     hoa thường) → TỪ CHỐI. Từ chối = `TestDbRefused` TRƯỚC khi gọi driver
     thật (không phải `psycopg.Error` — không bị nhánh "DB down" nuốt).
  2. dotenv: `load_dotenv` bỏ qua biến DSN/`PG*` (biến khác nạp như cũ).
  3. Biến DSN chưa đặt tường minh → đặt "" (dotenv không ghi đè biến đã
     có) — tiến trình con không rơi về `.env`. Biến đặt tường minh mà trỏ DB
     cấm → phiên dừng ngay.
  4. `subprocess.Popen`: kiểm MÔI TRƯỜNG HIỆU LỰC tại MỖI lần spawn — `env=`
     truyền tay, hoặc không truyền/`env=None` thì bản sao `os.environ` lúc
     spawn (vá 21/10: trước đây env kế thừa không được kiểm → test đổi
     `os.environ` sau install() vẫn spawn con trỏ samsam). Biến DSN thiếu →
     điền ""; giá trị DSN/`PGDATABASE` trỏ DB cấm hoặc `PGSERVICE` → từ chối
     TRƯỚC khi tạo tiến trình; argv (URI, `dbname=`, `-d`) cũng kiểm. Con
     nhận bản sao đã kiểm (không sửa `os.environ`/dict của caller).
  5. `preflight()`: DATABASE_URL không đặt = lượt unit (test cần DB tự
     skip); đã đặt = lượt integration/full → DB PHẢI sẵn sàng — lỗi kết
     nối/truy vấn/quyền hay thiếu bảng/role/golden đều là thông điệp chặn
     (exit 4); chỉ SELECT trên phiên read-only (vá 21/10: trước đây nuốt
     `psycopg.Error` → None, kể cả UndefinedTable).
Không có cờ bypass. Thông điệp không in DSN/mật khẩu — chỉ dbname.
"""

import getpass
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
PROD_DB = "samsam"
DSN_VARS = ("DATABASE_URL", "WEBHOOK_DATABASE_URL", "JOB_DATABASE_URL",
            "LOADER_DATABASE_URL", "BACKUP_DATABASE_URL",
            "DRILL_DATABASE_URL", "UI_DATABASE_URL")
_PG_VARS = ("PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGHOST", "PGPORT",
            "PGUSER", "PGPASSWORD", "PGPASSFILE")
# Tham số của psycopg.connect KHÔNG phải conninfo libpq.
_NOT_CONNINFO = ("autocommit", "prepare_threshold", "context", "row_factory",
                 "cursor_factory", "connection_factory")
_URI_RE = re.compile(r"postgres(?:ql)?://[^\s'\"]+", re.IGNORECASE)
_KW_RE = re.compile(r"(?<![\w-])dbname\s*=")


class TestDbRefused(RuntimeError):
    """Kết nối DB bị cổng test từ chối (không phải lỗi DB)."""

    __test__ = False  # pytest không collect


def _file_env() -> dict:
    try:
        from dotenv import dotenv_values
        return {k: v for k, v in dotenv_values(ENV_FILE).items() if v}
    except Exception:  # noqa: BLE001 — .env thiếu/hỏng = không có gì để cấm thêm
        return {}


def _dsn_keys(env) -> set:
    return {k for k in env if k.endswith("DATABASE_URL")} | set(DSN_VARS)


def denied_names(file_env=None) -> frozenset:
    names = {PROD_DB}
    fe = _file_env() if file_env is None else file_env
    from psycopg import conninfo
    for k, v in fe.items():
        if k.endswith("DATABASE_URL"):
            try:
                d = conninfo.conninfo_to_dict(v)
            except Exception:  # noqa: BLE001, S112 — DSN hỏng: không có tên cấm
                continue
            # Cấm RỘNG: DSN .env thiếu dbname → libpq dùng tên user.
            n = d.get("dbname") or d.get("user") or getpass.getuser()
            if n and not d.get("service"):
                names.add(n)
    return frozenset(n.lower() for n in names)


def resolve_dbname(conninfo_str, kwargs, env=None):
    """dbname TƯỜNG MINH libpq sẽ dùng (conninfo/kwargs → `PGDATABASE`);
    None = service. DSN hỏng / không có DB đích tường minh → TestDbRefused
    (không suy từ user — `PGUSER` hay user OS không phải căn cứ DB test)."""
    from psycopg import conninfo
    env = os.environ if env is None else env
    kw = {k: v for k, v in (kwargs or {}).items()
          if k not in _NOT_CONNINFO and v is not None}
    try:
        d = conninfo.conninfo_to_dict(conninfo_str or "", **kw)
    except Exception as e:  # noqa: BLE001
        raise TestDbRefused(f"DSN không phân tích được ({type(e).__name__})"
                            ) from None
    if d.get("service") or env.get("PGSERVICE"):
        return None
    name = d.get("dbname") or env.get("PGDATABASE")
    if not name:
        raise TestDbRefused("không xác định được DB đích tường minh (thiếu "
                            "dbname/PGDATABASE) — test bị chặn, đặt DSN DB "
                            "test riêng có tên DB")
    return name


def check(conninfo_str, kwargs=None, env=None, denied=None) -> str:
    name = resolve_dbname(conninfo_str, kwargs, env)
    if name is None:
        raise TestDbRefused("DSN dùng service/PGSERVICE — không xác định được"
                            " DB, test bị chặn")
    if name.lower() in (DENIED if denied is None else denied):
        raise TestDbRefused(f"test không được kết nối DB '{name}' (production)"
                            " — đặt DATABASE_URL tới DB test riêng")
    return name


DENIED = frozenset({PROD_DB})
_installed = False


def _driver(cls, conninfo_str, **kwargs):  # thay bằng driver thật ở install()
    raise RuntimeError("db_guard chưa install")


def _guarded_connect(cls, conninfo="", **kwargs):
    check(conninfo, kwargs)
    return _driver(cls, conninfo, **kwargs)


_FILE_DSN_KEYS: frozenset = frozenset()


def _sanitize_env(env) -> dict:
    """Bản sao đã kiểm của môi trường tiến trình con (không sửa `env`)."""
    env = dict(env)
    for k in _dsn_keys(env) | _FILE_DSN_KEYS:
        v = env.get(k)
        if v is None:
            env[k] = ""          # chặn dotenv của tiến trình con
        elif v:
            check(v, env=env)
    if env.get("PGDATABASE"):
        check("", env=env)
    if env.get("PGSERVICE"):
        raise TestDbRefused("PGSERVICE trong env tiến trình con — bị chặn")
    return env


def _check_args(args) -> None:
    """URI postgres trong mọi arg; `--dbname=X`, `-d X`/`--dbname X`;
    arg là conninfo keyword (`host=.. dbname=..`)."""
    seq = ([args] if isinstance(args, (str, bytes, os.PathLike))
           else list(args or ()))
    seq = [os.fsdecode(a) if isinstance(a, (bytes, os.PathLike)) else str(a)
           for a in seq]
    for i, s in enumerate(seq):
        for uri in _URI_RE.findall(s):
            check(uri)
        if "://" in s:
            continue
        if s.startswith("--dbname="):
            check(s.split("=", 1)[1] if "=" in s.split("=", 1)[1]
                  else "dbname=" + s.split("=", 1)[1])
        elif i and seq[i - 1] in ("-d", "--dbname"):
            check(s if "=" in s else "dbname=" + s)
        elif _KW_RE.search(s) and not s.startswith("-"):
            check(s)


class _GuardedPopen(subprocess.Popen):
    def __init__(self, args, *a, **kw):
        # Môi trường HIỆU LỰC lúc spawn: env truyền tay, hoặc kế thừa
        # (`os.environ` hiện tại) khi không truyền/None — kiểm cả hai.
        env = kw.get("env")
        kw["env"] = _sanitize_env(os.environ if env is None else env)
        _check_args(args)
        super().__init__(args, *a, **kw)


def install() -> None:
    """Gọi 1 lần ở đầu tests/conftest.py. Biến DSN tường minh trỏ DB cấm →
    TestDbRefused (phiên dừng)."""
    global _installed, _driver, DENIED, _FILE_DSN_KEYS
    if _installed:
        return
    DENIED = denied_names()
    _FILE_DSN_KEYS = frozenset(k for k in _file_env()
                               if k.endswith("DATABASE_URL"))
    import dotenv
    import dotenv.main
    import psycopg

    for k in _dsn_keys(os.environ) | _FILE_DSN_KEYS:
        if k in os.environ:
            if os.environ[k]:
                check(os.environ[k])
        else:
            os.environ[k] = ""
    if os.environ.get("PGSERVICE"):
        raise TestDbRefused("PGSERVICE đang đặt — test bị chặn")
    if os.environ.get("PGDATABASE"):
        check("")

    def load_dotenv(dotenv_path=None, stream=None, verbose=False,
                    override=False, interpolate=True, encoding="utf-8"):
        if dotenv_path is None and stream is None:
            dotenv_path = dotenv.main.find_dotenv(usecwd=True) or None
        vals = dotenv.main.dotenv_values(dotenv_path=dotenv_path,
                                         stream=stream, verbose=verbose,
                                         interpolate=interpolate,
                                         encoding=encoding)
        for k, v in vals.items():
            if v is None or k.endswith("DATABASE_URL") or k in _PG_VARS:
                continue        # DSN/PG* không bao giờ nạp từ file trong test
            if override or k not in os.environ:
                os.environ[k] = v
        return bool(vals)
    dotenv.load_dotenv = dotenv.main.load_dotenv = load_dotenv

    _driver = psycopg.Connection.connect.__func__
    psycopg.Connection.connect = classmethod(_guarded_connect)
    psycopg.connect = psycopg.Connection.connect
    try:
        import psycopg2
        orig2 = psycopg2.connect

        def connect2(dsn=None, connection_factory=None, cursor_factory=None,
                     **kw):
            ck = dict(kw)
            if "database" in ck:     # psycopg2: `database=` = dbname
                ck.setdefault("dbname", ck.pop("database"))
            check(dsn or "", ck)
            return orig2(dsn, connection_factory, cursor_factory, **kw)
        psycopg2.connect = connect2
    except ImportError:
        pass
    subprocess.Popen = _GuardedPopen
    _installed = True


_FIX = ("chạy `python scripts/apply_schema.py --roles` ×2 + `python -m "
        "ingest.core_store` + `python -m ingest.golden_store` với DATABASE_URL"
        " này rồi chạy lại")
_OBJECTS = ("public.chunks", "public.agent_action_log", "public.sku_master")


def preflight() -> str | None:
    """Lượt unit: DATABASE_URL KHÔNG đặt → None (test cần DB tự skip).
    Lượt integration/full: DATABASE_URL đặt → DB PHẢI sẵn sàng; mọi lỗi kết
    nối/truy vấn/quyền, thiếu bảng/role/golden → thông điệp (conftest dừng
    phiên exit 4). Kiểm tồn tại đối tượng TRƯỚC khi đọc; chỉ SELECT trên
    phiên read-only — không DDL/seed/sửa quyền. Thông điệp chỉ có tên DB +
    loại lỗi (không DSN/mật khẩu)."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    try:
        name = check(dsn)
    except TestDbRefused as e:
        return str(e)
    import psycopg
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            c.read_only = True
            have = c.execute(
                "select " + ", ".join(
                    f"to_regclass('{t}') is not null" for t in _OBJECTS)
                + ", exists (select 1 from pg_roles where rolname ="
                " 'agent_writer')").fetchone()
            missing = [t for t, ok in zip((*_OBJECTS, "role agent_writer"),
                                          have, strict=True) if not ok]
            if missing:
                return (f"DB test '{name}' chưa dựng (thiếu "
                        f"{', '.join(missing)}): {_FIX}")
            if not c.execute("select exists (select 1 from public.sku_master)"
                             ).fetchone()[0]:
                return (f"DB test '{name}' chưa nạp golden (sku_master rỗng):"
                        f" {_FIX}")
    except Exception as e:  # noqa: BLE001 — lượt cần DB: lỗi nào cũng chặn
        code = getattr(e, "sqlstate", None)
        return (f"DB test '{name}' không sẵn sàng ({type(e).__name__}"
                f"{' ' + code if code else ''}) — kiểm DATABASE_URL/quyền/"
                f"schema; {_FIX}")
    return None
