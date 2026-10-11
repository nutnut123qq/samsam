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
    "gd_ban_hang": ("Chat Sâm Sâm", "Chưa trả lời", "Leads", "Báo cáo"),
    "gd_marketing": ("Chat Sâm Sâm", "Content Studio", "Leads", "Báo cáo",
                     "Duyệt & Lịch"),
    "mxh": ("Chat Sâm Sâm", "Content Studio", "Chưa trả lời", "Leads",
            "Duyệt & Lịch"),
    "ha_tang": ("Chat Sâm Sâm", "Chưa trả lời", "Báo cáo", "Nhật ký vườn"),
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
