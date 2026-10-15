"""v3.4 W34.4 — `pipelines.auth` logic thuần (không streamlit): ma trận
6 vai trò × 7 tab, AUTH_MODE fail-closed, header proxy, scrypt hash,
users file hỏng, lockout theo `now` inject (không sleep). Mật khẩu test
sinh lúc chạy — không có hash/mật khẩu thật trong source."""

import json
import secrets
import subprocess
import sys
from pathlib import Path

import pytest

from pipelines import auth

ROOT = Path(__file__).resolve().parent.parent

# Ma trận đề xuất trong checklist v3.4 (TGĐ chốt = external-dep) — ghi
# TƯỜNG MINH để đối chiếu với ROLE_TABS (không suy từ chính nó).
EXPECTED = {
    "tgd": set(auth.TABS),
    "phap_che": {"Chat Sâm Sâm", "Content Studio", "Chưa trả lời",
                 "Báo cáo", "Duyệt & Lịch"},
    # v13.5: người duyệt khối sales/data_platform cần tab duyệt.
    "gd_ban_hang": {"Chat Sâm Sâm", "Chưa trả lời", "Leads", "Báo cáo",
                    "Duyệt & Lịch"},
    "gd_marketing": {"Chat Sâm Sâm", "Content Studio", "Leads", "Báo cáo",
                     "Duyệt & Lịch"},
    "mxh": {"Chat Sâm Sâm", "Content Studio", "Chưa trả lời", "Leads",
            "Duyệt & Lịch"},
    "ha_tang": {"Chat Sâm Sâm", "Chưa trả lời", "Báo cáo", "Nhật ký vườn",
                "Duyệt & Lịch"},
}


@pytest.fixture(autouse=True)
def _clean_lockout(tmp_path, monkeypatch):
    # `.env` của repo không được rò vào test — mặc định trỏ file không có.
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    auth.reset_lockout()
    yield
    auth.reset_lockout()


@pytest.fixture(scope="module")
def pw_users():
    pw = secrets.token_urlsafe(12)
    return pw, {"lan": {"role": "gd_marketing",
                        "password_hash": auth.hash_password(pw)}}


# ---------- vai trò × tab ----------

def test_role_tab_matrix_6x7():
    assert auth.ROLES == ("tgd", "phap_che", "gd_ban_hang", "gd_marketing",
                          "mxh", "ha_tang")
    assert len(auth.TABS) == 7 and set(auth.ROLE_TABS) == set(auth.ROLES)
    n = 0
    for role in auth.ROLES:
        for tab in auth.TABS:
            assert (tab in auth.tabs_for(role)) == (tab in EXPECTED[role]), \
                (role, tab)
            n += 1
    assert n == 42
    # Thứ tự tab giữ đúng thứ tự TABS (UI ổn định).
    for role in auth.ROLES:
        got = auth.tabs_for(role)
        assert list(got) == [t for t in auth.TABS if t in got]


def test_approve_schedule_sets_and_unknown_role():
    assert auth.CAN_APPROVE == {"tgd", "phap_che", "gd_marketing"}
    assert auth.CAN_SCHEDULE == {"tgd", "gd_marketing", "mxh"}
    for r in auth.ROLES:
        assert auth.can_approve(r) == (r in {"tgd", "phap_che",
                                             "gd_marketing"})
        assert auth.can_schedule(r) == (r in {"tgd", "gd_marketing", "mxh"})
    for bad in ("admin", "", None, "TGD", 1):
        assert auth.tabs_for(bad) == ()
        assert not auth.can_approve(bad) and not auth.can_schedule(bad)


# ---------- AUTH_MODE ----------

def test_auth_mode_fail_closed():
    for v in (None, "", "  ", "xyz", "proxy1"):
        env = {} if v is None else {"AUTH_MODE": v}
        assert auth.auth_mode(env) == "blocked", v
    assert auth.auth_mode({"AUTH_MODE": " PROXY "}) == "proxy"
    assert auth.auth_mode({"AUTH_MODE": "Local"}) == "local"
    assert auth.auth_mode({"AUTH_MODE": "dev"}) == "dev"
    for d in ("1", "true", "YES", " yes "):
        assert auth.auth_mode({"AUTH_MODE": "dev", "DEPLOY": d}) == "blocked"
    assert auth.auth_mode({"AUTH_MODE": "dev", "DEPLOY": "0"}) == "dev"
    # DEPLOY không ảnh hưởng proxy/local.
    assert auth.auth_mode({"AUTH_MODE": "proxy", "DEPLOY": "1"}) == "proxy"


def test_auth_mode_reads_os_environ(monkeypatch):
    monkeypatch.delenv("AUTH_MODE", raising=False)
    assert auth.auth_mode() == "blocked"
    monkeypatch.setenv("AUTH_MODE", "local")
    assert auth.auth_mode() == "local"


def test_auth_mode_reads_dotenv(tmp_path, monkeypatch):
    """App chặn đăng nhập TRƯỚC mọi module có load_dotenv → auth tự đọc
    `.env` (SOP: AUTH_MODE/DEPLOY đặt trong .env). env process ưu tiên;
    không mutate os.environ."""
    import os
    for k in ("AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE"):
        monkeypatch.delenv(k, raising=False)
    envf = tmp_path / ".env"
    monkeypatch.setattr(auth, "ENV_FILE", envf)
    assert auth.auth_mode() == "blocked"                  # .env thiếu
    envf.write_text("AUTH_MODE=local\n", encoding="utf-8")
    assert auth.auth_mode() == "local"
    envf.write_text("AUTH_MODE=dev\nDEPLOY=1\n", encoding="utf-8")
    assert auth.auth_mode() == "blocked"                  # dev + DEPLOY .env
    # AUTH_MODE ở env process, DEPLOY chỉ trong .env → vẫn bị ép blocked.
    envf.write_text("DEPLOY=1\n", encoding="utf-8")
    monkeypatch.setenv("AUTH_MODE", "dev")
    assert auth.auth_mode() == "blocked"
    # env process ưu tiên hơn .env.
    envf.write_text("AUTH_MODE=local\n", encoding="utf-8")
    monkeypatch.setenv("AUTH_MODE", "proxy")
    assert auth.auth_mode() == "proxy"
    monkeypatch.delenv("AUTH_MODE")
    # AUTH_USERS_FILE trong .env → load_users đọc đúng file.
    uf = tmp_path / "u.json"
    uf.write_text(json.dumps({"a": {"role": "mxh"}}), encoding="utf-8")
    envf.write_text(f"AUTH_MODE=local\nAUTH_USERS_FILE={uf.as_posix()}\n",
                    encoding="utf-8")
    assert auth.load_users() == {"a": {"role": "mxh", "password_hash": ""}}
    for k in ("AUTH_MODE", "DEPLOY", "AUTH_USERS_FILE"):
        assert k not in os.environ, k                     # không mutate
    envf.write_bytes(b"\xff\xfeAUTH_MODE=dev")             # .env hỏng
    assert auth.auth_mode() == "blocked"


# ---------- proxy header ----------

def test_identity_from_headers_case_insensitive():
    users = {"lan@samsam.vn": {"role": "phap_che", "password_hash": ""}}
    for hk in ("Cf-Access-Authenticated-User-Email",
               "cf-access-authenticated-user-email",
               "CF-ACCESS-AUTHENTICATED-USER-EMAIL"):
        assert auth.identity_from_headers({hk: " Lan@SamSam.vn "}, users) \
            == ("lan@samsam.vn", "phap_che"), hk


def test_identity_from_headers_rejects():
    users = {"lan@samsam.vn": {"role": "phap_che", "password_hash": ""}}
    h = "Cf-Access-Authenticated-User-Email"
    assert auth.identity_from_headers({h: "x@evil.com"}, users) is None
    assert auth.identity_from_headers({h: ""}, users) is None
    assert auth.identity_from_headers({h: "   "}, users) is None
    assert auth.identity_from_headers({"X-Email": "lan@samsam.vn"},
                                      users) is None
    assert auth.identity_from_headers({}, users) is None
    assert auth.identity_from_headers(None, users) is None
    assert auth.identity_from_headers({h: "lan@samsam.vn"}, {}) is None


# ---------- hash ----------

def test_hash_roundtrip_and_salt(pw_users):
    pw, users = pw_users
    h = users["lan"]["password_hash"]
    assert h.startswith("scrypt$16384$8$1$")
    assert auth.verify_password(pw, h)
    assert not auth.verify_password(pw + "x", h)
    assert not auth.verify_password("", h)
    h2 = auth.hash_password(pw)
    assert h2 != h and auth.verify_password(pw, h2)   # salt ngẫu nhiên


def test_verify_password_broken_strings():
    pw = secrets.token_urlsafe(8)
    good = auth.hash_password(pw)
    parts = good.split("$")
    for bad in ("scrypt$REPLACE_ME", "", None, 123, "plain",
                "bcrypt$" + "$".join(parts[1:]),
                "$".join(parts[:5]),                          # thiếu dk
                "$".join(parts[:4] + ["zz", parts[5]]),       # salt không hex
                "$".join(["scrypt", "3"] + parts[2:]),        # n không 2^k
                "$".join(["scrypt", str(2 ** 22)] + parts[2:]),  # n quá lớn
                "$".join(parts[:2] + ["999"] + parts[3:])):   # r quá lớn
        assert auth.verify_password(pw, bad) is False, bad
    assert auth.verify_password(None, good) is False


# ---------- users file ----------

def test_load_users_broken_variants(tmp_path):
    cases = {
        "missing": None,
        "empty": b"",
        "brace": b"{}",
        "doc_only": json.dumps({"_doc": "x"}).encode(),
        "broken": b"{not json",
        "list": b"[1, 2]",
        "bad_utf8": b"\xff\xfe{",
    }
    for name, data in cases.items():
        p = tmp_path / f"{name}.json"
        if data is not None:
            p.write_bytes(data)
        assert auth.load_users(p) == {}, name
    # Role lạ / entry không phải object bị bỏ, entry hợp lệ giữ.
    p = tmp_path / "mixed.json"
    p.write_text(json.dumps({
        "_doc": "x", " Lan ": {"role": "mxh", "password_hash": "h"},
        "evil": {"role": "admin"}, "str": "tgd", "  ": {"role": "tgd"},
        "nohash": {"role": "tgd"}}), encoding="utf-8")
    assert auth.load_users(p) == {
        "lan": {"role": "mxh", "password_hash": "h"},
        "nohash": {"role": "tgd", "password_hash": ""}}


def test_load_users_env_path(tmp_path, monkeypatch):
    p = tmp_path / "u.json"
    p.write_text(json.dumps({"a": {"role": "tgd"}}), encoding="utf-8")
    monkeypatch.setenv("AUTH_USERS_FILE", str(p))
    assert auth.load_users() == {"a": {"role": "tgd", "password_hash": ""}}


def test_users_example_and_gitignore():
    ex = json.loads((ROOT / "data" / "users.example.json").read_text(
        encoding="utf-8"))
    entries = {k: v for k, v in ex.items() if not k.startswith("_")}
    assert entries and {v["role"] for v in entries.values()} == \
        set(auth.ROLES)
    for v in entries.values():
        assert auth._parse_hash(v["password_hash"]) is None   # không hợp lệ
    gi = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "data/users.json" in [x.strip() for x in gi]


# ---------- lockout ----------

def test_lockout_after_max_fails(pw_users, capsys):
    pw, users = pw_users
    t0 = 1_000_000.0
    for i in range(auth.MAX_FAILS):
        u, r, msg = auth.check_login("lan", "sai" + str(i), users, now=t0)
        assert (u, r) == (None, None) and msg == auth.LOGIN_FAIL_MSG
    # Sự kiện khóa được log (A09) — chỉ hash, không username thật.
    err = capsys.readouterr().err
    assert "[auth] tạm khóa" in err and "user_hash=" in err
    assert "lan" not in err
    # Lần 6: mật khẩu ĐÚNG vẫn bị từ chối khi đang khóa.
    u, r, msg = auth.check_login("lan", pw, users, now=t0 + 1)
    assert u is None and "tạm khóa" in msg
    u, r, msg = auth.check_login(" LAN ", pw, users,
                                 now=t0 + auth.LOCK_SECONDS - 1)
    assert u is None and "tạm khóa" in msg
    # Hết khóa → đúng là vào.
    assert auth.check_login("lan", pw, users,
                            now=t0 + auth.LOCK_SECONDS) == \
        ("lan", "gd_marketing", None)


def test_lockout_unknown_user_and_reset_on_success(pw_users):
    pw, users = pw_users
    t0 = 2_000_000.0
    for _ in range(auth.MAX_FAILS):
        assert auth.check_login("ghost", "x", users, now=t0)[2] == \
            auth.LOGIN_FAIL_MSG                      # thông báo chung
    assert "tạm khóa" in auth.check_login("ghost", "x", users,
                                          now=t0 + 1)[2]
    # Đúng → reset đếm: 4 sai + 1 đúng + 4 sai vẫn chưa khóa.
    for _ in range(auth.MAX_FAILS - 1):
        auth.check_login("lan", "sai", users, now=t0)
    assert auth.check_login("lan", pw, users, now=t0)[0] == "lan"
    for _ in range(auth.MAX_FAILS - 1):
        auth.check_login("lan", "sai", users, now=t0)
    assert auth.check_login("lan", pw, users, now=t0)[0] == "lan"


def test_check_login_bad_inputs(pw_users):
    pw, users = pw_users
    t0 = 3_000_000.0
    for u, p in ((None, pw), ("", pw), ("lan", None), ("lan", ""),
                 ("lan", pw + "x" * auth.MAX_INPUT),
                 ("x" * (auth.MAX_INPUT + 1), pw)):
        assert auth.check_login(u, p, users, now=t0) == \
            (None, None, auth.LOGIN_FAIL_MSG)
    # User có trong file nhưng hash hỏng/thiếu → không vào được.
    bad = {"lan": {"role": "tgd", "password_hash": "scrypt$REPLACE_ME"},
           "nohash": {"role": "tgd", "password_hash": ""}}
    assert auth.check_login("lan", pw, bad, now=t0 + 1000)[0] is None
    assert auth.check_login("nohash", "", bad, now=t0 + 1000)[0] is None


def test_lockout_state_bounded(monkeypatch):
    monkeypatch.setattr(auth, "MAX_TRACKED", 5)
    monkeypatch.setattr(auth, "_dummy_hash", lambda: "scrypt$x")
    t0 = 4_000_000.0
    for i in range(20):
        auth.check_login(f"u{i}", "x", {}, now=t0 + i * 1000)
    assert len(auth._FAILS) <= 6


def _burst(n, fn):
    """n thread cùng xuất phát (Barrier) gọi fn(i) → list kết quả."""
    import threading
    bar = threading.Barrier(n)
    out = [None] * n

    def run(i):
        bar.wait(timeout=30)
        out[i] = fn(i)

    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    return ts, out


def test_lockout_concurrent_burst_capped(pw_users, monkeypatch):
    """K phiên đồng thời không được quá MAX_FAILS lần verify (TOCTOU
    kiểm-khóa / ghi-sai tách nhau bởi scrypt). Event-based: verify chặn
    tới khi mọi lần thử bị từ chối đã về — code cũ cho cả K vào verify
    nên điều kiện chờ timeout → đỏ."""
    import threading
    pw, users = pw_users
    t0 = 5_000_000.0
    k = 20
    calls, release, cv = [], threading.Event(), threading.Condition()
    done = []
    real = auth.verify_password

    def slow_verify(p, h):
        with cv:
            calls.append(p)
            cv.notify_all()
        release.wait(timeout=30)
        return real(p, h)

    monkeypatch.setattr(auth, "verify_password", slow_verify)

    def attempt(i):
        r = auth.check_login("lan", f"sai{i}", users, now=t0)
        with cv:
            done.append(r)
            cv.notify_all()
        return r

    ts, out = _burst(k, attempt)
    with cv:
        ok = cv.wait_for(lambda: len(done) >= k - auth.MAX_FAILS
                         and len(calls) >= auth.MAX_FAILS, timeout=15)
        n_calls_blocked = len(calls)
    release.set()
    for t in ts:
        t.join(timeout=30)
    assert ok, (len(done), len(calls))
    assert n_calls_blocked == auth.MAX_FAILS
    assert len(calls) == auth.MAX_FAILS                  # không thêm sau
    refused = [r for r in out if "tạm khóa" in (r[2] or "")]
    assert len(refused) == k - auth.MAX_FAILS
    assert all(r[0] is None for r in out)
    # Đã đủ MAX_FAILS lần sai → khóa: mật khẩu ĐÚNG bị từ chối, không verify.
    u, _, msg = auth.check_login("lan", pw, users, now=t0 + 1)
    assert u is None and "tạm khóa" in msg
    assert len(calls) == auth.MAX_FAILS


def test_lockout_burst_with_correct_password(pw_users, monkeypatch):
    """Probe nghiệm thu: 39 sai + 1 đúng cùng đợt. Tổng verify ≤
    MAX_FAILS; đúng chỉ vào được khi chính nó nằm trong MAX_FAILS lượt
    được verify (trong ngân sách), không phải 'sau 39 lần sai'."""
    import threading
    pw, users = pw_users
    t0 = 6_000_000.0
    calls, lk = [], threading.Lock()
    real = auth.verify_password

    def counting(p, h):
        with lk:
            calls.append(p)
        return real(p, h)

    monkeypatch.setattr(auth, "verify_password", counting)
    k = 40
    ts, out = _burst(k, lambda i: auth.check_login(
        "lan", pw if i == k - 1 else f"sai{i}", users, now=t0))
    for t in ts:
        t.join(timeout=60)
    assert len(calls) <= auth.MAX_FAILS, len(calls)
    wins = [r for r in out if r[0] is not None]
    assert len(wins) <= 1
    if wins:
        assert pw in calls


def test_lockout_set_during_verify_blocks_correct(pw_users, monkeypatch):
    """Khóa được đặt (bởi lần thử khác) trong lúc scrypt của lần đúng đang
    chạy → kết quả đúng KHÔNG được nhận, khóa không bị xóa."""
    pw, users = pw_users
    t0 = 7_000_000.0
    real = auth.verify_password

    def lock_meanwhile(p, h):
        with auth._LOCK:
            auth._FAILS["lan"][1] = t0 + auth.LOCK_SECONDS
        return real(p, h)

    monkeypatch.setattr(auth, "verify_password", lock_meanwhile)
    u, _, msg = auth.check_login("lan", pw, users, now=t0)
    assert u is None and "tạm khóa" in msg
    assert auth._FAILS["lan"][1] == t0 + auth.LOCK_SECONDS
    assert auth._FAILS["lan"][3] == 0                      # nhả chỗ


def test_lockout_inflight_released_on_exception(pw_users, monkeypatch):
    pw, users = pw_users

    def boom(p, h):
        raise RuntimeError("x")

    monkeypatch.setattr(auth, "verify_password", boom)
    for _ in range(auth.MAX_FAILS + 2):
        with pytest.raises(RuntimeError):
            auth.check_login("lan", pw, users, now=8_000_000.0)
    assert auth._FAILS["lan"][3] == 0


# ---------- module / CLI ----------

def test_auth_does_not_import_streamlit():
    r = subprocess.run(
        [sys.executable, "-c", ("import pipelines.auth, sys; "
                                "assert 'streamlit' not in sys.modules")],
        cwd=ROOT, capture_output=True, timeout=60, check=False)
    assert r.returncode == 0, r.stderr


def test_cli_hash_uses_getpass(monkeypatch, capsys):
    pw = secrets.token_urlsafe(12)
    monkeypatch.setattr(auth.getpass, "getpass", lambda prompt="": pw)
    assert auth.main(["--hash"]) == 0
    out = capsys.readouterr().out.strip()
    assert auth.verify_password(pw, out) and pw not in out
    seq = iter([pw, pw + "x"])
    monkeypatch.setattr(auth.getpass, "getpass", lambda prompt="": next(seq))
    assert auth.main(["--hash"]) == 1                      # không khớp
    monkeypatch.setattr(auth.getpass, "getpass", lambda prompt="": "short")
    assert auth.main(["--hash"]) == 1                      # quá ngắn
    with pytest.raises(SystemExit) as e:
        auth.main([])
    assert e.value.code == 2


# ---------- app/streamlit_app.py tĩnh (AST, không import streamlit) ----------

APP = ROOT / "app" / "streamlit_app.py"


def _alias_shadowing(src: str) -> dict:
    """Script Streamlit chạy ở module scope: gán lại tên alias import (vd
    `_auth = st.text_input(...)` đè `from pipelines import auth as _auth`)
    làm tab chạy SAU gọi `.can_approve` trên str → AttributeError. →
    {tên: (dòng import, dòng gán)} cho mọi tên vừa là import vừa bị gán
    ở module scope (bỏ qua thân def/class/lambda/comprehension)."""
    import ast
    imports, binds = {}, {}

    def walk(node):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef,
                               ast.ClassDef, ast.Lambda, ast.ListComp,
                               ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                continue
            if isinstance(ch, (ast.Import, ast.ImportFrom)):
                for a in ch.names:
                    n = (a.asname or a.name).split(".")[0]
                    imports.setdefault(n, ch.lineno)
            elif isinstance(ch, ast.Name) and isinstance(ch.ctx, ast.Store):
                binds.setdefault(ch.id, ch.lineno)
            walk(ch)

    walk(ast.parse(src))
    return {k: (imports[k], binds[k]) for k in set(imports) & set(binds)}


def test_app_no_import_alias_shadowing():
    src = APP.read_text(encoding="utf-8")
    assert _alias_shadowing(src) == {}
    # Tự kiểm: mutation đúng dạng bug v3.4 phải bị bắt (cả for-target).
    for mut in ("_auth = ''", "for _g in []:\n    pass",
                "_store += 1", "with open('x') as _pg:\n    pass"):
        assert _alias_shadowing(src + "\n" + mut + "\n"), mut


def test_app_review_shows_raw_draft_text():
    """WYSIWYS: approve ký sha256 của `text` thô → tab Duyệt & Lịch hiển
    thị bản thô (st.text/st.code), KHÔNG markdown/write (giấu URL link,
    tải ảnh tracker)."""
    import ast
    tree = ast.parse(APP.read_text(encoding="utf-8"))
    block = next(n for n in tree.body if isinstance(n, ast.If)
                 and "Duyệt & Lịch" in ast.unparse(n.test))
    shown = []
    for n in ast.walk(block):
        if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and isinstance(n.func.value, ast.Name)
                and n.func.value.id == "st"):
            args = " ".join(ast.unparse(a) for a in n.args)
            if "['text']" in args:
                shown.append(n.func.attr)
    assert shown and set(shown) <= {"text", "code"}, shown
