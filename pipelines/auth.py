"""v3.4 — đăng nhập + phân quyền Streamlit (logic THUẦN, không import
streamlit — test bằng hàm, UI chỉ gọi lại).

Contract:
  - `AUTH_MODE` (env) quyết định cách xác định danh tính — fail-closed:
      proxy   identity = header `Cf-Access-Authenticated-User-Email` do
              reverse proxy (Cloudflare Access) đặt; email phải có trong
              users file. CHỈ an toàn khi Streamlit bind 127.0.0.1 sau
              proxy — lộ cổng thì header giả mạo được (docs/deploy.md).
      local   đăng nhập user/mật khẩu, hash scrypt (hashlib) trong
              `AUTH_USERS_FILE` (mặc định `data/users.json`, NGOÀI git —
              mẫu `data/users.example.json`); khóa tạm khi sai liên tiếp.
      dev     không đăng nhập, identity `dev`, role `tgd` — CHỈ máy dev;
              `DEPLOY` truthy (1/true/yes) → bị ép `blocked`.
      blocked AUTH_MODE trống/lạ → chặn mọi truy cập.
  - 6 vai trò × 7 tab (`ROLE_TABS`) + `CAN_APPROVE` / `CAN_SCHEDULE` là
    ĐỀ XUẤT — TGĐ chốt ma trận + danh sách người duyệt (external-dep).
    Role lạ → không tab, không quyền.
  - Cấu hình (`AUTH_MODE`, `DEPLOY`, `AUTH_USERS_FILE`) đọc từ env
    process + `.env` của repo (env process ưu tiên, giống load_dotenv
    không override) — KHÔNG mutate os.environ. App chặn đăng nhập trước
    mọi module có load_dotenv, nên auth phải tự đọc `.env` (nếu không,
    SOP "đặt AUTH_MODE trong .env" bị chặn vĩnh viễn và DEPLOY=1 trong
    .env không ép dev → blocked).
  - Lockout: sai `MAX_FAILS` lần LIÊN TIẾP → khóa `LOCK_SECONDS` theo
    username (kể cả username không tồn tại — không lộ user nào có thật;
    thông báo chung). Đang khóa thì mật khẩu đúng cũng từ chối. Lần thử
    được GIỮ CHỖ trong lock TRƯỚC khi chạy scrypt (sai + đang chạy ≥
    MAX_FAILS → từ chối không verify) — N phiên Streamlit gửi đồng thời
    không vượt được MAX_FAILS lần đoán/cửa sổ. State
    trong RAM module (mất khi restart; không chia sẻ đa process); kẻ
    xấu biết username có thể khóa người đó 5 phút (DoS chấp nhận ở
    pilot — someday lockout bền + theo IP).
  - Tạo hash: `python -m pipelines.auth --hash` (đọc mật khẩu bằng
    getpass, KHÔNG qua argv/history) → dán vào users file.
  - v13.5 (F08) `authorize(by, block, action)` — cổng ủy quyền DUY NHẤT
    cho quyết định người (hàng duyệt chung, draft nội dung, xếp lịch; UI +
    CLI). Agent/system không bao giờ duyệt; người tạo không tự duyệt. Chế độ
    thực (`approval_enforced`: AUTH_MODE local|proxy, APPROVAL_ENFORCE hoặc
    DEPLOY) → người phải thuộc `approvers` của ĐÚNG khối (rỗng = chặn: Bên
    B chưa ủy quyền), tài khoản users file có vai trò thuộc `approver_roles`,
    CLI chạy bằng login Postgres khớp `db_login`. Dev → in DEV_WARNING.
    `approvers`/`db_login` là người thật do Bên B cấp — dev KHÔNG tự điền.

Users file (JSON object):
  {"_doc": "...", "<username|email>": {"role": "<ROLES>",
                                       "password_hash": "scrypt$..."}}
  Key bắt đầu "_" bị bỏ qua; username so khớp strip+lower. Proxy mode
  chỉ cần `role` (không dùng password_hash).
"""

import argparse
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
import unicodedata
from pathlib import Path

from dotenv import dotenv_values

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_USERS_FILE = ROOT / "data" / "users.json"
ENV_FILE = ROOT / ".env"

# Nguồn DUY NHẤT tên tab — app/streamlit_app.py import, test_handover_docs
# parse (AST) để đối chiếu docs.
TABS = ("Chat Sâm Sâm", "Content Studio", "Chưa trả lời", "Leads",
        "Báo cáo", "Nhật ký vườn", "Duyệt & Lịch")
ROLES = ("tgd", "phap_che", "gd_ban_hang", "gd_marketing", "mxh",
         "ha_tang")
ROLE_TABS = {
    "tgd": TABS,
    "phap_che": ("Chat Sâm Sâm", "Content Studio", "Chưa trả lời",
                 "Báo cáo", "Duyệt & Lịch"),
    # v13.5: GĐ bán hàng / Quản lý AI là người duyệt khối sales /
    # data_platform (PL01) → cần tab duyệt cho hàng duyệt chung.
    "gd_ban_hang": ("Chat Sâm Sâm", "Chưa trả lời", "Leads", "Báo cáo",
                    "Duyệt & Lịch"),
    "gd_marketing": ("Chat Sâm Sâm", "Content Studio", "Leads", "Báo cáo",
                     "Duyệt & Lịch"),
    "mxh": ("Chat Sâm Sâm", "Content Studio", "Chưa trả lời", "Leads",
            "Duyệt & Lịch"),
    "ha_tang": ("Chat Sâm Sâm", "Chưa trả lời", "Báo cáo", "Nhật ký vườn",
                "Duyệt & Lịch"),
}
CAN_APPROVE = frozenset({"tgd", "phap_che", "gd_marketing"})
CAN_SCHEDULE = frozenset({"tgd", "gd_marketing", "mxh"})

MODES = ("proxy", "local", "dev")
PROXY_HEADER = "Cf-Access-Authenticated-User-Email"
MAX_FAILS = 5
LOCK_SECONDS = 300
LOGIN_FAIL_MSG = "sai tên đăng nhập hoặc mật khẩu"
MAX_INPUT = 256          # cắt username/mật khẩu quá dài (chống DoS scrypt)
MAX_TRACKED = 10_000     # trần số username theo dõi lockout (chống phình RAM)
MIN_PASSWORD = 10        # độ dài tối thiểu khi TẠO hash

# scrypt: n=2^14, r=8, p=1 → ~16 MiB/lần, ~50 ms.
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN = 2 ** 14, 8, 1, 32
_SCRYPT_MAXMEM = 64 * 1024 * 1024


def tabs_for(role) -> tuple:
    """Tab được xem theo vai trò; role lạ/None → ()."""
    return ROLE_TABS.get(role, ()) if isinstance(role, str) else ()


def can_approve(role) -> bool:
    return role in CAN_APPROVE


def can_schedule(role) -> bool:
    return role in CAN_SCHEDULE


def _truthy(v) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes")


def _env() -> dict:
    """`.env` (ENV_FILE) đè bởi os.environ — không mutate os.environ.
    File thiếu/hỏng → chỉ os.environ."""
    try:
        file_vals = {k: v for k, v in dotenv_values(ENV_FILE).items()
                     if v is not None}
    except (OSError, UnicodeDecodeError, ValueError):
        file_vals = {}
    return {**file_vals, **os.environ}


def auth_mode(env=None) -> str:
    """→ 'proxy' | 'local' | 'dev' | 'blocked' (fail-closed)."""
    env = _env() if env is None else env
    mode = (env.get("AUTH_MODE") or "").strip().lower()
    if mode not in MODES:
        return "blocked"
    if mode == "dev" and _truthy(env.get("DEPLOY")):
        return "blocked"
    return mode


# ---------- users file ----------

def load_users(path=None) -> dict:
    """→ {username_lower: {"role", "password_hash"}}. File thiếu / rỗng /
    `{}` / chỉ `_doc` / JSON hỏng / không phải object → {} (không ai vào
    được = fail-closed). Entry role lạ / không phải object bị bỏ. Không
    raise."""
    if path is None:
        path = _env().get("AUTH_USERS_FILE") or DEFAULT_USERS_FILE
    try:
        data = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    users = {}
    for name, entry in data.items():
        if not isinstance(name, str) or name.startswith("_"):
            continue
        key = name.strip().lower()
        if not key or not isinstance(entry, dict):
            continue
        role = entry.get("role")
        if role not in ROLES:
            continue
        ph = entry.get("password_hash")
        users[key] = {"role": role,
                      "password_hash": ph if isinstance(ph, str) else ""}
        # v13.5: login Postgres RIÊNG của người (CLI duyệt ở chế độ thực —
        # `--by` phải khớp login DB đang dùng). Chỉ thêm key khi có.
        dbl = entry.get("db_login")
        if isinstance(dbl, str) and dbl.strip():
            users[key]["db_login"] = dbl.strip().lower()
    return users


def identity_from_headers(headers, users: dict):
    """Proxy mode: header email (tên header không phân biệt hoa thường)
    → (email_lower, role) | None khi thiếu/rỗng/không có trong users."""
    if not headers:
        return None
    want = PROXY_HEADER.lower()
    email = None
    try:
        for k, v in headers.items():
            if isinstance(k, str) and k.lower() == want:
                email = v
                break
    except AttributeError:
        return None
    if not isinstance(email, str):
        return None
    email = email.strip().lower()
    if not email or email not in users:
        return None
    return email, users[email]["role"]


# ---------- password hash ----------

def hash_password(pw: str) -> str:
    """→ 'scrypt$n$r$p$salt_hex$dk_hex' (salt 16 byte ngẫu nhiên)."""
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=SCRYPT_N,
                        r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN,
                        maxmem=_SCRYPT_MAXMEM)
    return (f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}$"
            f"{salt.hex()}${dk.hex()}")


def _parse_hash(stored):
    """'scrypt$n$r$p$salt$dk' → (n, r, p, salt, dk) | None (hỏng / tham
    số ngoài khoảng an toàn — chặn hash cấu hình làm cạn RAM/CPU)."""
    try:
        algo, n, r, p, salt_hex, dk_hex = stored.split("$")
        n, r, p = int(n), int(r), int(p)
        salt, want = bytes.fromhex(salt_hex), bytes.fromhex(dk_hex)
    except (AttributeError, TypeError, ValueError):
        return None
    if algo != "scrypt" or not (2 <= n <= 2 ** 20 and n & (n - 1) == 0
                                and 1 <= r <= 32 and 1 <= p <= 16):
        return None
    if len(salt) < 8 or not 16 <= len(want) <= 64:
        return None
    return n, r, p, salt, want


def verify_password(pw, stored) -> bool:
    """So mật khẩu với hash (compare_digest). Chuỗi hỏng/tham số lạ →
    False, không raise."""
    parsed = _parse_hash(stored)
    if parsed is None or not isinstance(pw, str):
        return False
    n, r, p, salt, want = parsed
    try:
        got = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                             dklen=len(want), maxmem=_SCRYPT_MAXMEM)
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(got, want)


_DUMMY_HASH = None


def _dummy_hash() -> str:
    """Hash giả để user không tồn tại vẫn tốn 1 lần scrypt (đều timing)."""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_hex(16))
    return _DUMMY_HASH


# ---------- lockout ----------

_LOCK = threading.Lock()
# username → [sai liên tiếp, khóa tới, lần sai cuối, đang verify (in-flight)]
_FAILS: dict[str, list] = {}
_LOCKED_MSG = "tạm khóa đăng nhập do sai nhiều lần — thử lại sau {} giây"


def _prune(now: float) -> None:
    """Giữ RAM có trần: bỏ entry hết khóa + sai cuối quá LOCK_SECONDS +
    không còn lần thử đang chạy."""
    if len(_FAILS) <= MAX_TRACKED:
        return
    for k in [k for k, (_, until, last, inflight) in _FAILS.items()
              if until <= now and now - last > LOCK_SECONDS
              and inflight == 0]:
        del _FAILS[k]


def reset_lockout() -> None:
    """Xóa state khóa (test / restart)."""
    with _LOCK:
        _FAILS.clear()


def check_login(username, password, users: dict, now: float | None = None):
    """→ (username_lower, role, None) khi đúng | (None, None, msg).

    Sai `MAX_FAILS` lần liên tiếp → khóa `LOCK_SECONDS` (theo `now`
    inject, không sleep). Đang khóa: mật khẩu đúng cũng từ chối. Đúng →
    reset đếm. Thông báo sai chung cho mọi lý do (không lộ user).

    Đồng thời (mỗi phiên Streamlit 1 thread): lần thử GIỮ CHỖ (in-flight
    +1) ngay trong critical section kiểm khóa, trước scrypt; sai + in-flight
    ≥ MAX_FAILS → từ chối luôn, không verify. Sau scrypt kiểm lại khóa
    trước khi nhận `ok` — lần đúng không xóa được khóa do lần khác đặt."""
    now = time.time() if now is None else now
    # Quá dài → coi như sai (KHÔNG cắt: cắt làm prefix khớp user thật).
    key = (username.strip().lower() if isinstance(username, str)
           and len(username) <= MAX_INPUT else "")
    pw = (password if isinstance(password, str)
          and len(password) <= MAX_INPUT else None)
    if key:
        with _LOCK:
            st = _FAILS.setdefault(key, [0, 0.0, now, 0])
            if st[1] > now:
                return None, None, _LOCKED_MSG.format(int(st[1] - now) + 1)
            if st[0] + st[3] >= MAX_FAILS:
                # Đã đủ MAX_FAILS lần thử (sai + đang chạy) — không verify.
                return None, None, ("tạm khóa đăng nhập do thử quá nhiều "
                                    "lần — thử lại sau")
            st[3] += 1   # giữ chỗ; _prune bỏ qua entry in-flight > 0
    entry = users.get(key) if key else None
    ph = entry["password_hash"] if entry else ""
    try:
        if entry and pw is not None and _parse_hash(ph) is not None:
            ok = verify_password(pw, ph)
        else:
            verify_password(pw or "", _dummy_hash())   # đều timing, bỏ kết quả
            ok = False
    except BaseException:
        if key:
            with _LOCK:
                _FAILS.setdefault(key, [0, 0.0, now, 1])[3] -= 1
        raise
    if not key:
        return None, None, LOGIN_FAIL_MSG
    locked = False
    with _LOCK:
        st = _FAILS.setdefault(key, [0, 0.0, now, 1])  # reset giữa chừng
        st[3] -= 1   # nhả chỗ CÙNG critical section xử lý kết quả
        if ok:
            if st[1] > now:   # khóa đặt trong lúc verify → không nhận
                return None, None, _LOCKED_MSG.format(int(st[1] - now) + 1)
            if st[3] == 0:
                del _FAILS[key]
            else:
                st[0] = 0
            return key, entry["role"], None
        st[0] += 1
        st[2] = now
        locked = st[0] >= MAX_FAILS
        if locked:
            st[0], st[1] = 0, now + LOCK_SECONDS
        _prune(now)
    if locked:
        # Log sự kiện khóa (A09) — chỉ hash username, không raw (invariant
        # không log identifier thật; cùng dạng _uhash của connectors.zalo).
        uh = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        print(f"[auth] tạm khóa đăng nhập user_hash={uh} "
              f"{LOCK_SECONDS}s sau {MAX_FAILS} lần sai", file=sys.stderr,
              flush=True)
    return None, None, LOGIN_FAIL_MSG


# ---------- v13.5 ủy quyền người duyệt (F08) ----------
# HĐ 5.4/7.2 + PL01: "người được Bên B ủy quyền duyệt trước khi thực hiện",
# mỗi phòng ban 1 người duyệt. `authorize()` là cổng DUY NHẤT cho mọi quyết
# định người (approval_queue.decide/override, store.set_status/schedule, UI).

ACTIONS = ("approve", "reject", "override_qa", "schedule",
           # v14.2 (p2): quyết định người ở CLI ngoài hàng duyệt chung —
           # mỗi CLI gọi `cli_gate` với khối + hành động của đúng việc đó.
           "intake", "approve_price", "sign", "issue", "revoke",
           "set_status", "promote", "severe", "disable", "ack", "verify",
           "consent", "assign", "handoff", "load_dealers", "purge_sample",
           "adopt_plot")
NON_HUMAN = ("agent:", "system:", "auto_policy:")
DIRECTORS_DIR = ROOT / "data" / "directors"
_APPROVAL_FORCE: bool | None = None   # test ép chế độ (tests/conftest.py)
DEV_WARNING = ("CHẾ ĐỘ DEV — người duyệt CHƯA được đối chiếu danh sách ủy "
               "quyền (đặt AUTH_MODE=local|proxy hoặc APPROVAL_ENFORCE=1 "
               "khi dùng thật)")


def is_human(name) -> bool:
    """Tên người thật: không rỗng, không tiền tố agent:/system:/auto_policy:."""
    s = name.strip().casefold() if isinstance(name, str) else ""
    return bool(s) and not s.startswith(NON_HUMAN)


def _same(a, b) -> bool:
    return (a or "").strip().casefold() == (b or "").strip().casefold()


def approval_enforced(env=None) -> bool:
    """Chế độ thực: AUTH_MODE local|proxy, hoặc APPROVAL_ENFORCE / DEPLOY
    truthy. Còn lại (dev, CLI máy dev) = cảnh báo, không đối chiếu."""
    if _APPROVAL_FORCE is not None:
        return _APPROVAL_FORCE
    env = _env() if env is None else env
    return (auth_mode(env) in ("local", "proxy")
            or _truthy(env.get("APPROVAL_ENFORCE"))
            or _truthy(env.get("DEPLOY")))


def block_config(block: str) -> dict:
    """Cấu hình khối `data/directors/<block>.json` (đã validate) — raise
    `director.DirectorConfigError` khi thiếu/hỏng/khối lạ."""
    from pipelines import director  # lười: director import auth
    if block not in director.BLOCKS:
        raise director.DirectorConfigError(f"khối '{block}' không tồn tại")
    return director.load_config(block, DIRECTORS_DIR)


def _norm_name(s) -> str:
    """NFC + gộp khoảng trắng + casefold (khớp `qr_trace.norm_name`)."""
    return " ".join(unicodedata.normalize("NFC", s).split()).casefold() \
        if isinstance(s, str) else ""


def authorize(by, block, action, *, created_by=None, role=None,
              db_login=None, via="cli", users=None, env=None, allow=None,
              allow_src=None) -> tuple[bool, str | None]:
    """→ (True, None) được phép | (False, lý do).

    Mọi chế độ: người rỗng / `agent:*`|`system:*`|`auto_policy:*` → chặn;
    duyệt/override mục chính mình tạo → chặn. Chế độ dev chỉ tới đó (UI giữ
    cổng `can_approve` cũ; caller in DEV_WARNING).
    Chế độ thực (`approval_enforced`) thêm: `role` (UI, từ phiên đăng nhập)
    thuộc `approver_roles` của khối (xếp lịch: CAN_SCHEDULE); khối phải có `approvers` (rỗng =
    chặn — Bên B chưa ủy quyền), người phải nằm trong `approvers` của ĐÚNG
    khối (chéo khối bị chặn), có tài khoản trong users file với vai trò
    thuộc `approver_roles`; đường CLI (`via='cli'`) phải có `db_login` khớp
    login Postgres đang dùng (`--by` free-text không còn là danh tính).

    v14.2 `allow` (danh sách người riêng của việc đó, vd người ký QR theo vai
    `data/qr_signers.json`, người nhận cảnh báo đỏ độc lập): chế độ thực đối
    chiếu `allow` THAY `approvers`/`approver_roles` của khối (rỗng = chặn),
    vẫn bắt buộc tài khoản users file + `db_login` khớp (CLI)."""
    if action not in ACTIONS:
        return False, f"hành động '{action}' không hợp lệ — {ACTIONS}"
    who = by.strip() if isinstance(by, str) else ""
    if not who:
        return False, "thiếu người quyết định (--by / đăng nhập)"
    if not is_human(who):
        return False, (f"'{who}' không phải người — agent/hệ thống KHÔNG "
                       f"được {action}")
    if action in ("approve", "override_qa") and _same(who, created_by):
        return False, "người quyết trùng người tạo — cần người khác duyệt"
    if not approval_enforced(env):
        return True, None     # dev: caller in DEV_WARNING
    if allow is not None:
        src = allow_src or "danh sách riêng"
        names = {_norm_name(a) for a in allow if _norm_name(a)}
        if not names:
            return False, (f"chưa có người được {action} ({src} rỗng) — "
                           f"Bên B cấp danh sách, không tự điền")
        if _norm_name(who) not in names:
            return False, f"'{who}' không thuộc người được {action} ({src})"
        users = load_users() if users is None else users
        entry = users.get(who.casefold())
        if entry is None:
            return False, (f"'{who}' chưa có tài khoản đăng nhập/vai trò "
                           f"(users file)")
        return _login_match(entry, db_login, via)
    if action == "schedule":
        roles = CAN_SCHEDULE
    else:
        try:
            cfg = block_config(block)
        except Exception as e:  # noqa: BLE001 — cấu hình hỏng = chặn
            return False, f"không đọc được cấu hình khối '{block}': {e}"
        roles = frozenset(cfg["approver_roles"])
        approvers = {a.strip().casefold() for a in cfg["approvers"]
                     if a.strip()}
        if not approvers:
            return False, (f"khối {block} CHƯA có người được Bên B ủy quyền "
                           f"(approvers rỗng trong data/directors/{block}"
                           f".json) — cần văn bản ủy quyền của Bên B, "
                           f"không tự điền")
    if role is not None and role not in roles:
        return False, (f"vai trò '{role}' không được {action} ở khối "
                       f"{block} ({', '.join(sorted(roles))})")
    if action != "schedule" and who.casefold() not in approvers:
        return False, (f"'{who}' không thuộc người được ủy quyền duyệt "
                       f"khối {block}")
    users = load_users() if users is None else users
    entry = users.get(who.casefold())
    if entry is None:
        return False, (f"'{who}' chưa có tài khoản đăng nhập/vai trò "
                       f"(users file)")
    if entry["role"] not in roles:
        return False, (f"vai trò tài khoản '{entry['role']}' không được "
                       f"{action} ở khối {block}")
    return _login_match(entry, db_login, via)


def _login_match(entry: dict, db_login, via) -> tuple[bool, str | None]:
    """CLI chế độ thực: `--by` phải khớp login Postgres đang dùng."""
    if via != "ui":
        want = entry.get("db_login")
        got = (db_login or "").strip().lower()
        if not want or want != got:
            return False, ("--by không khớp login Postgres đang dùng — CLI "
                           "chế độ thực phải chạy bằng login DB riêng của "
                           "người duyệt (users file 'db_login')")
    return True, None


def decidable_blocks(ident, role) -> list[str]:
    """Khối mà người đăng nhập (UI) được quyết hàng duyệt chung: vai trò
    thuộc `approver_roles`; chế độ thực thêm có tên trong `approvers`.
    Khối cấu hình hỏng → bỏ qua (fail-closed)."""
    from pipelines import director
    out = []
    for b in director.BLOCKS:
        try:
            cfg = block_config(b)
        except Exception:  # noqa: BLE001, S112 — hỏng = bỏ khối
            continue
        if role not in cfg["approver_roles"]:
            continue
        if approval_enforced() and (ident or "").strip().casefold() not in {
                a.strip().casefold() for a in cfg["approvers"]}:
            continue
        out.append(b)
    return out


_DENY_SQL = ("insert into agent_action_log (actor, action, object_type,"
             " object_id, detail) values (%s, 'authz_denied', %s, %s, %s)")


def _idle(conn) -> bool:
    """Kết nối psycopg KHÔNG có giao dịch mở (không có việc dở của caller)."""
    try:
        from psycopg import pq
        return conn.info.transaction_status == pq.TransactionStatus.IDLE
    except Exception:  # noqa: BLE001 — conn giả/không phải psycopg
        return False


def _side_conn(conn):
    """Kết nối PHỤ cùng tham số + login với `conn` (autocommit)."""
    import psycopg
    params = dict(conn.info.get_parameters())
    if conn.info.password:
        params["password"] = conn.info.password
    timeout = params.pop("connect_timeout", None) or "5"
    return psycopg.connect(**params, connect_timeout=timeout, autocommit=True)


def deny_log(conn, by, block, action, object_type, object_id,
             reason, *, env=None) -> None:
    """Ghi lần BỊ TỪ CHỐI vào `agent_action_log` (hash chain, lưu toàn kỳ)
    — best-effort, lỗi thì bỏ (không che lý do từ chối). Chỉ chế độ thực
    (máy dev không rác log).

    v14.2: KHÔNG commit giao dịch của caller (trước đây `conn.commit()` chốt
    luôn việc dở của caller). Kết nối rảnh → transaction riêng (chỉ dòng
    log); đang có giao dịch mở → kết nối PHỤ cùng login (autocommit, bền kể
    cả caller rollback); kết nối phụ lỗi → savepoint trong giao dịch caller
    (đi theo số phận giao dịch đó)."""
    if not approval_enforced(env):
        return
    try:
        from psycopg.types.json import Jsonb
        args = ((by or "").strip()[:100] or "(trống)", object_type,
                str(object_id),
                Jsonb({"block": block, "action": action,
                       "reason": (reason or "")[:300]}))
    except Exception:  # noqa: BLE001 — best-effort
        return
    if _idle(conn):
        try:
            with conn.transaction():
                conn.execute(_DENY_SQL, args)
        except Exception:  # noqa: BLE001, S110 — best-effort
            pass
        return
    try:
        with _side_conn(conn) as side:
            # Caller đã ghi log trong tx đang mở → giữ khóa chuỗi (advisory
            # xact lock) → kết nối phụ chờ caller, caller chờ hàm này = treo.
            # Hết hạn chờ → rơi về savepoint trong tx caller.
            side.execute("set lock_timeout = '3s'")
            side.execute(_DENY_SQL, args)
        return
    except Exception:  # noqa: BLE001, S110 — rơi về savepoint
        pass
    try:
        with conn.transaction():
            conn.execute(_DENY_SQL, args)
    except Exception:  # noqa: BLE001, S110 — best-effort
        pass


def session_login(conn) -> str | None:
    """Login Postgres của kết nối (`session_user`) — None khi lỗi."""
    try:
        r = conn.execute("select session_user").fetchone()
    except Exception:  # noqa: BLE001
        return None
    return str(r[0]) if r else None


# ---------- v14.2 cổng CLI + login dịch vụ (F08) ----------
# Superuser / thành viên role SỞ HỮU bảng (mọi schema không phải hệ thống
# của DB — không chỉ search_path: login thiếu USAGE schema thì
# current_schema() rỗng) = vượt mọi trigger chặn/grant (sửa log, duyệt
# thẳng) → chế độ thực từ chối.
_PRIV_LOGIN_SQL = (
    "select r.rolsuper, exists (select 1 from pg_class c join pg_namespace n"
    " on n.oid = c.relnamespace where n.nspname <> 'information_schema' and"
    " n.nspname not like 'pg\\_%' and c.relkind in ('r', 'p', 'v', 'm')"
    " and pg_has_role(session_user, c.relowner, 'MEMBER'))"
    " from pg_roles r where r.rolname = session_user")


def privileged_login(conn) -> str | None:
    """Login của `conn` là superuser / owner bảng → lý do; không kiểm được
    → lý do (fail-closed); login thường → None."""
    try:
        with conn.transaction():
            row = conn.execute(_PRIV_LOGIN_SQL).fetchone()
    except Exception as e:  # noqa: BLE001
        return f"không kiểm được quyền login Postgres ({type(e).__name__})"
    if row is None:
        return "không kiểm được quyền login Postgres"
    if row[0]:
        return ("login Postgres là SUPERUSER — chế độ thực phải dùng login "
                "riêng không phải superuser/owner (docs/roles.sql)")
    if row[1]:
        return ("login Postgres là CHỦ SỞ HỮU (owner) bảng — chế độ thực "
                "phải dùng login riêng không sở hữu bảng (docs/roles.sql)")
    return None


def cli_gate(conn, by, block, action, object_type, object_id, *,
             created_by=None, allow=None, allow_src=None,
             env=None) -> str | None:
    """Cổng cho MỌI quyết định người ở CLI (ngoài hàng duyệt chung) → lý do
    chặn | None. Chế độ thực: `authorize` (khối/hành động hoặc `allow`,
    `--by` khớp `db_login` của login đang dùng); bị chặn → `authz_denied`
    vào log. Dev: chỉ chặn agent/system/tự duyệt + in DEV_WARNING ra stderr.
    KHÔNG từ chối login owner ở đây: các CLI này còn ghi bảng trực tiếp
    (giá, hồ sơ XNQC, sổ triển khai, CRM...) mà `app_human` chưa có quyền —
    cấp quyền ghi theo khối cho login người là quyết định hạ tầng (runbook
    mục 9). Hàng duyệt chung/draft (chỉ qua function SECURITY DEFINER) thì
    có từ chối owner (`approval_queue`/`store`)."""
    enforced = approval_enforced(env)
    ok, why = authorize(by, block, action, created_by=created_by,
                        db_login=session_login(conn) if enforced else None,
                        env=env, allow=allow, allow_src=allow_src)
    if ok:
        if not enforced:
            print(f"[warn] {DEV_WARNING}", file=sys.stderr, flush=True)
        return None
    deny_log(conn, by, block, action, object_type, object_id, why, env=env)
    return why


# Dịch vụ chạy KHÔNG phải người: mỗi dịch vụ 1 login riêng `in role <role>`
# (hạ tầng Bên B tạo NGOÀI git — docs/roles.sql khối v14.2). Chế độ thực:
# biến `<DỊCH VỤ>_DATABASE_URL` bắt buộc (không rơi về DATABASE_URL), login
# không superuser/owner và thuộc đúng role dịch vụ. Dev: thiếu biến → rơi về
# DATABASE_URL. Bên A (`ben_a_reader`) đăng nhập trực tiếp bằng công cụ của
# họ — không có tiến trình trong repo.
SERVICES = {
    "webhook": ("WEBHOOK_DATABASE_URL", "svc_webhook"),   # Zalo/Messenger
    "job": ("JOB_DATABASE_URL", "svc_job"),               # agent chạy lịch
    "loader": ("LOADER_DATABASE_URL", "svc_loader"),      # nạp file
    "backup": ("BACKUP_DATABASE_URL", "svc_backup"),      # pg_dump chỉ đọc
}


def service_dsn(service: str, env=None) -> tuple[str | None, str | None]:
    """→ (dsn, None) | (None, lý do)."""
    var, _ = SERVICES[service]
    env = _env() if env is None else env
    dsn = (env.get(var) or "").strip()
    if dsn:
        return dsn, None
    if approval_enforced(env):
        return None, (f"chế độ thực: thiếu {var} — dịch vụ '{service}' phải "
                      f"chạy bằng login riêng, không rơi về DATABASE_URL")
    dsn = (env.get("DATABASE_URL") or "").strip()
    return (dsn, None) if dsn else (None, f"thiếu {var} / DATABASE_URL")


def service_login_problem(conn, service: str, env=None) -> str | None:
    """Chế độ thực: login superuser/owner hoặc không thuộc role dịch vụ →
    lý do. Dev → None."""
    if not approval_enforced(env):
        return None
    why = privileged_login(conn)
    if why:
        return why
    _, role = SERVICES[service]
    try:
        with conn.transaction():
            ok = conn.execute(
                "select exists (select 1 from pg_roles where rolname = %s)"
                " and pg_has_role(session_user, %s, 'MEMBER')",
                (role, role)).fetchone()[0]
    except Exception as e:  # noqa: BLE001
        return f"không kiểm được role dịch vụ ({type(e).__name__})"
    return None if ok else (f"login không thuộc role '{role}' của dịch vụ "
                            f"'{service}' (docs/roles.sql)")


def bind_service(service: str, env=None) -> str | None:
    """Đầu tiến trình dịch vụ (webhook, job lịch, loader, backup): có
    `<DỊCH VỤ>_DATABASE_URL` → đặt `DATABASE_URL` của tiến trình (mọi module
    + tiến trình con đọc biến này) + kiểm login ở chế độ thực → lý do từ chối
    | None. Dev thiếu biến dịch vụ → không đổi gì (giữ DATABASE_URL đang có —
    KHÔNG tự nạp DSN từ `.env` vào môi trường)."""
    var, _ = SERVICES[service]
    env = _env() if env is None else env
    dsn = (env.get(var) or "").strip()
    if not dsn:
        if approval_enforced(env):
            return service_dsn(service, env)[1]
        return None
    os.environ["DATABASE_URL"] = dsn
    if not approval_enforced(env):
        return None
    import psycopg
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            return service_login_problem(c, service, env)
    except psycopg.Error as e:
        return f"không kết nối được DB dịch vụ '{service}' ({type(e).__name__})"


# ---------- CLI ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.auth",
        description="Tạo hash mật khẩu scrypt cho data/users.json "
                    "(AUTH_MODE=local)")
    ap.add_argument("--hash", action="store_true",
                    help="nhập mật khẩu (ẩn, 2 lần) → in chuỗi hash")
    args = ap.parse_args(argv)
    if not args.hash:
        ap.error("cần --hash")
    pw = getpass.getpass("Mật khẩu: ")
    if pw != getpass.getpass("Nhập lại: "):
        print("[err] 2 lần nhập không khớp", file=sys.stderr)
        return 1
    if len(pw) < MIN_PASSWORD:
        print(f"[err] mật khẩu tối thiểu {MIN_PASSWORD} ký tự",
              file=sys.stderr)
        return 1
    if len(pw) > MAX_INPUT:
        print(f"[err] mật khẩu tối đa {MAX_INPUT} ký tự", file=sys.stderr)
        return 1
    print(hash_password(pw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
