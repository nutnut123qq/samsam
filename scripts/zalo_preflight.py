"""V1.3 — Preflight Zalo OA: chạy trên máy deploy TRƯỚC khi mở public.

In 1 dòng PASS/FAIL/SKIP + lý do ngắn cho từng mục; exit 0 iff không có
FAIL nào (SKIP không fail — dev mode và "sẽ refresh khi chạy" là hợp lệ).

Checks (theo thứ tự):
- env: mirror _startup_error của connectors.zalo — DEPLOY bật -> bắt
  buộc ZALO_OA_SECRET + DATABASE_URL + OPENROUTER_API_KEY + đường send
  (ZALO_ACCESS_TOKEN ∨ bộ refresh ZALO_REFRESH_TOKEN+ZALO_APP_ID+
  ZALO_APP_SECRET). DEPLOY tắt -> chỉ SKIP/warn.
- db: psycopg connect DATABASE_URL -> SELECT count(*) FROM chunks.
- openrouter: chỉ check key non-empty — KHÔNG gọi API (tốn credit).
- token: access_token từ data/zalo_tokens.json (fallback env seed) ->
  GET openapi.zalo.me/v2.0/oa/getoa; hết hạn + có refresh_token -> SKIP
  "sẽ refresh khi chạy"; flag --refresh -> gọi
  connectors.zalo.refresh_access_token() thật rồi check getoa lại.
- signature: tự ký event giả bằng ZALO_OA_SECRET ->
  connectors.zalo.verify_signature(raw, mac) phải True (round-trip
  chứng minh flow; secret thật chỉ verify được khi có event live).

Chạy: `python scripts/zalo_preflight.py [--refresh]`
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # lazy-import connectors/* khi chạy trực tiếp
load_dotenv(ROOT / ".env")

TOKEN_FILE = ROOT / "data" / "zalo_tokens.json"
GETOA_URL = "https://openapi.zalo.me/v2.0/oa/getoa"

_DEPLOY_ON = ("1", "true", "yes")
# Mirror _startup_error (connectors/zalo.py): bắt buộc base + đường
# send = access_token ∨ bộ refresh (3 biến) — token đọc store trước env
# như runtime. Bộ refresh thiếu mà có access token vẫn serve được —
# chỉ warn (hết ~25h không tự refresh).
_REQUIRED_BASE = ("ZALO_OA_SECRET", "DATABASE_URL", "OPENROUTER_API_KEY")
_REFRESH_CREDS = ("ZALO_REFRESH_TOKEN", "ZALO_APP_ID", "ZALO_APP_SECRET")


def _r(name: str, status: str, detail: str = "") -> dict:
    return {"name": name, "status": status, "detail": detail}


def _deploy(env: dict) -> bool:
    return env.get("DEPLOY", "").strip().lower() in _DEPLOY_ON


def check_env(env: dict) -> dict:
    missing = [k for k in _REQUIRED_BASE if not env.get(k)]
    # Mirror _startup_error: token hiện hành đọc store TRƯỚC env (store
    # là source-of-truth sau refresh) — máy deploy có store hợp lệ thì
    # env seed cũ/thiếu không còn là FAIL (reviewer minor).
    store = _read_token_store()
    has_access = bool(store.get("access_token")
                      or env.get("ZALO_ACCESS_TOKEN"))
    rtok = store.get("refresh_token") or env.get("ZALO_REFRESH_TOKEN")
    has_refresh = bool(rtok and env.get("ZALO_APP_ID")
                       and env.get("ZALO_APP_SECRET"))
    if not (has_access or has_refresh):
        missing.append("ZALO_ACCESS_TOKEN|(ZALO_REFRESH_TOKEN+"
                       "ZALO_APP_ID+ZALO_APP_SECRET)")
    if _deploy(env):
        if missing:
            return _r("env", "FAIL",
                      "DEPLOY bật nhưng thiếu: " + ", ".join(missing))
        if not has_refresh:
            return _r("env", "PASS",
                      "đủ env — nhưng không có bộ refresh: access token "
                      "hết hạn ~25h sẽ không tự refresh")
        return _r("env", "PASS", "đủ env cho DEPLOY")
    if missing:
        return _r("env", "SKIP", "dev mode — thiếu: " + ", ".join(missing))
    return _r("env", "PASS", "dev mode, đủ env")


def check_db(env: dict) -> dict:
    dsn = env.get("DATABASE_URL", "")
    if not dsn:
        return _r("db", "SKIP", "DATABASE_URL chưa set")
    try:
        import psycopg
    except ImportError:
        return _r("db", "FAIL",
                  "thiếu psycopg (pip install -r requirements.txt)")
    try:
        with psycopg.connect(dsn, connect_timeout=5) as conn:
            n = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
        return _r("db", "PASS", f"chunks={n}")
    except Exception as e:  # noqa: BLE001 — preflight không được
        # crash: mọi lỗi connect/query đều report FAIL, không propagate
        return _r("db", "FAIL", f"{type(e).__name__}: {e}")


def check_openrouter(env: dict) -> dict:
    if env.get("OPENROUTER_API_KEY"):
        return _r("openrouter", "PASS",
                  "OPENROUTER_API_KEY set (không gọi API)")
    status = "FAIL" if _deploy(env) else "SKIP"
    return _r("openrouter", status, "OPENROUTER_API_KEY MISSING")


def _read_token_store() -> dict:
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _getoa(access_token: str) -> dict:
    r = httpx.get(GETOA_URL, headers={"access_token": access_token},
                  timeout=15)
    return r.json()


def _expiry_note(expires_at) -> str:
    if not expires_at:
        return ""  # 0/None = "không biết" (oauth thiếu expires_in)
    try:
        left = float(expires_at) - time.time()
    except (TypeError, ValueError):
        return ""
    if left <= 0:
        return f"expires_at đã qua {-left / 3600:.1f}h"
    return f"expires_at còn {left / 3600:.1f}h"


def _refresh_or_skip(refresh: bool, why: str) -> dict:
    """Token hết hạn/thiếu nhưng có refresh_token: không có --refresh thì
    SKIP; có thì gọi refresh_access_token() thật rồi getoa lại. Lazy
    import — lane A (V1.1) chưa merge thì SKIP, không crash."""
    if not refresh:
        return _r("token", "SKIP",
                  f"{why} — có refresh_token, sẽ refresh khi chạy "
                  f"(hoặc chạy --refresh để thử ngay)")
    try:
        from connectors import zalo
        do_refresh = zalo.refresh_access_token
    except (ImportError, AttributeError):
        return _r("token", "SKIP",
                  "không gọi được refresh_access_token — connectors."
                  "zalo chưa sẵn sàng")
    try:
        ok = do_refresh()
    except Exception as e:  # noqa: BLE001 — refresh crash vẫn report FAIL
        return _r("token", "FAIL",
                  f"refresh_access_token crash {type(e).__name__}")
    if not ok:
        return _r("token", "FAIL", "refresh_access_token trả False")
    access = _read_token_store().get("access_token")
    if not access:
        return _r("token", "FAIL",
                  "refresh xong nhưng token store thiếu access_token")
    try:
        data = _getoa(access)
    except Exception as e:  # noqa: BLE001 — mọi lỗi HTTP/JSON đều FAIL
        return _r("token", "FAIL",
                  f"getoa sau refresh lỗi {type(e).__name__}")
    if isinstance(data, dict) and data.get("error") == 0:
        return _r("token", "PASS", "refresh + getoa ok")
    err = data.get("error") if isinstance(data, dict) else "non-json"
    return _r("token", "FAIL",
              f"token sau refresh vẫn lỗi (error={err})")


def check_token(env: dict, refresh: bool = False) -> dict:
    store = _read_token_store()
    access = store.get("access_token") or env.get("ZALO_ACCESS_TOKEN", "")
    rtok = store.get("refresh_token") or env.get("ZALO_REFRESH_TOKEN", "")
    if refresh and rtok:
        # --refresh ép rotation THẬT kể cả khi access còn sống — mục
        # đích của flag là test rotate trước go-live (reviewer M1:
        # bản cũ chỉ refresh khi token đã chết -> flag vô nghĩa đúng
        # lúc cần test nhất).
        return _refresh_or_skip(refresh, "--refresh ép rotation")
    if not access:
        if not rtok:
            return _r("token", "FAIL",
                      "không có access_token lẫn refresh_token (file/env)")
        return _refresh_or_skip(refresh, "chỉ có refresh_token")
    try:
        data = _getoa(access)
    except Exception as e:  # noqa: BLE001 — mọi lỗi HTTP/JSON đều FAIL
        return _r("token", "FAIL", f"getoa lỗi {type(e).__name__}")
    if isinstance(data, dict) and data.get("error") == 0:
        note = _expiry_note(store.get("expires_at"))
        return _r("token", "PASS",
                  "getoa ok" + (f", {note}" if note else ""))
    err = data.get("error") if isinstance(data, dict) else "non-json"
    if rtok:
        return _refresh_or_skip(refresh, f"getoa error={err}")
    return _r("token", "FAIL",
              f"access token hỏng (getoa error={err}), "
              f"không có refresh_token")


def check_signature(env: dict) -> dict:
    oa_secret = env.get("ZALO_OA_SECRET", "")
    if not oa_secret:
        return _r("signature", "SKIP",
                  "ZALO_OA_SECRET chưa set — secret thật chỉ verify "
                  "được khi có event live")
    try:
        from connectors import zalo
    except ImportError:
        return _r("signature", "SKIP", "chưa import được connectors.zalo")
    # V1.2: secret webhook là zalo.OA_SECRET — set tạm rồi restore để
    # verify_signature dùng secret từ env của preflight, không đụng
    # state của process khác.
    attr = "OA_SECRET"
    ev = {"app_id": env.get("ZALO_APP_ID") or "preflight",
          "sender": {"id": "preflight"}, "recipient": {"id": "oa"},
          "event_name": "user_send_text",
          "message": {"msg_id": "preflight", "text": "ping"},
          "timestamp": str(int(time.time() * 1000))}
    raw = json.dumps(ev, ensure_ascii=False).encode()
    # mac = sha256(app_id + raw_body + timestamp + OA_SECRET) — đúng spec.
    mac = "mac=" + hashlib.sha256(
        (ev["app_id"] + raw.decode() + ev["timestamp"] + oa_secret)
        .encode()).hexdigest()
    old = getattr(zalo, attr, "")
    setattr(zalo, attr, oa_secret)
    try:
        ok = zalo.verify_signature(raw, mac)
    finally:
        setattr(zalo, attr, old)
    if ok:
        return _r("signature", "PASS",
                  "round-trip mac tự ký ok — secret thật chỉ verify "
                  "được khi có event live")
    return _r("signature", "FAIL",
              "verify_signature từ chối mac tự ký đúng — check impl")


def run_checks(env: dict, refresh: bool = False) -> list[dict]:
    """Chạy 5 check theo thứ tự spec — IO tách trong từng check để test
    mock env/httpx được mà không cần Zalo/DB thật."""
    return [
        check_env(env),
        check_db(env),
        check_openrouter(env),
        check_token(env, refresh=refresh),
        check_signature(env),
    ]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Preflight Zalo OA trước khi mở webhook public")
    ap.add_argument("--refresh", action="store_true",
                    help="token hết hạn/thiếu: gọi refresh_access_token() "
                         "thật rồi check lại (mặc định chỉ SKIP)")
    args = ap.parse_args(argv)
    results = run_checks(dict(os.environ), refresh=args.refresh)
    print("[preflight] Zalo OA go-live check\n")
    for r in results:
        print(f"{r['status']:<5} {r['name']:<11} {r['detail']}")
    fails = sum(1 for r in results if r["status"] == "FAIL")
    skips = sum(1 for r in results if r["status"] == "SKIP")
    verdict = ("OK để mở public" if fails == 0
               else "CHƯA OK — vá các mục FAIL trước")
    print(f"\n[done] {fails} FAIL, {skips} SKIP — {verdict}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
