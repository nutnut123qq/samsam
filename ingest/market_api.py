"""v10.3 connector API sàn CHỈ ĐỌC (WP16 nền P2) — kéo listing/đơn từ
Shopee Open Platform v2 / TikTok Shop API (202309) vào CÙNG staging của v3.3
(`market_snapshots`/`market_rows`/`market_alerts`) để toàn bộ đối chiếu +
cảnh báo của `ingest.market_csv` chạy lại nguyên vẹn.

CHỈ ĐỌC — bằng cấu trúc, không bằng quy ước:
  - `ALLOWED` = allowlist CỨNG (channel, method, path) các endpoint đọc,
    hard-code ở đây (KHÔNG đọc từ config/env). TikTok `.../search` là POST
    nhưng chỉ đọc → allowlist theo cặp method+path, không theo "GET".
  - MỌI request đi qua 1 hàm `_request()`: kiểm `(channel, method, path)`
    ∈ `ALLOWED` ĐẦU TIÊN → ngoài allowlist = `ScopeError`, chưa dựng URL,
    chưa mở socket. Module không có đường đổi giá/listing/tồn/đơn.
  - App trên Partner Center chỉ xin quyền ĐỌC (external-dep: app key +
    access token + sandbox).

Chữ ký (`sign_shopee`, `sign_tiktok` — hàm thuần, timestamp truyền vào):
theo TÀI LIỆU CÔNG KHAI của sàn, CHƯA xác minh với sandbox thật; tên
endpoint/field/phân trang cũng là GIẢ ĐỊNH theo tài liệu công khai.
  shopee  sign = HMAC-SHA256(partner_key, partner_id + path + timestamp +
          access_token + shop_id) hex, cùng partner_id/timestamp/
          access_token/shop_id trong query.
  tiktok  sign = HMAC-SHA256(app_secret, app_secret + path + concat(k+v
          query đã sort, bỏ sign/access_token) + body + app_secret) hex;
          token ở header `x-tts-access-token`; query app_key/timestamp/
          shop_cipher/sign.

HTTP: `urllib.request` (stdlib), timeout 15s, KHÔNG theo redirect (3xx =
lỗi — chống lộ token sang host khác), đọc tối đa MAX_RESP_BYTES, base URL
chỉ `https://` hoặc `http://127.0.0.1|localhost` (server giả). HTTP ≠ 200 /
JSON hỏng / `error` (shopee) hoặc `code ≠ 0` (tiktok) → `ApiError` chỉ mang
HTTP status + mã lỗi — KHÔNG body, KHÔNG URL (URL shopee chứa token).
Phân trang có trần MAX_PAGES (vượt → lỗi, không nạp nửa vời).

PII người mua: response đơn có thể chứa tên/SĐT/địa chỉ người nhận — chỉ
nằm trong RAM của lời gọi và bị bỏ NGAY: row dựng bằng cách trích TƯỜNG
MINH từng field allowlist (CÙNG field của `market_csv._parse`), không copy
dict response; mã đơn → `order_id_hash` = sha256("kênh:mã đơn")[:16] (CÙNG
công thức market_csv); đơn shopee chỉ xin `response_optional_fields=
item_list` (không xin field người nhận).

TRẠNG THÁI XÁC MINH (v13.8 C09, PL01 mục 3b/7 "Kết nối API sàn 02–03/2027"):
**BLOCKED — CHƯA VERIFIED.** Chưa có app key/access token/sandbox chính thức
của Shopee Open Platform/TikTok Shop (Bên B cấp app chỉ đọc) → chữ ký,
endpoint, field, phân trang, rate limit mới chỉ kiểm bằng server giả theo tài
liệu công khai. Không ghi "đã kết nối API sàn" vào hồ sơ nghiệm thu khi chưa
chạy được với sandbox thật.
r14: refresh token Shopee/TikTok viết theo TÀI LIỆU CHÍNH THỨC (`--refresh`;
tự refresh khi token trong kho `MARKET_TOKEN_FILE` còn < 1 giờ) — kiểm bằng
server giả (CONTRACT_TESTED), CHƯA chạy sandbox.
r15: quyết toán qua API (`--kind settlement --from --to [--dry-run]` →
`ingest.settlement_api`) theo tài liệu CHÍNH THỨC — Shopee escrow list/detail,
TikTok statements 202309 + statement_transactions 202501 (GET, tham số path
`{statement_id}` chỉ nhận số, thế vào SAU allowlist). Ghi sổ CHỈ khi bảng ánh xạ
Kế toán đã chốt và nguồn là API thật — hiện bảng để trống → BLOCKED; luồng đang
dùng vẫn là `ingest.settlement_csv`. CONTRACT_TESTED server giả, CHƯA sandbox.

CLI: `python -m ingest.market_api --channel shopee|tiktok --kind
listing|order [--days N]` — thiếu key env → `[external-dep]` exit 2 (0
request, không connect DB); lỗi API/dữ liệu → exit 1 (không connect, 0
dòng); dữ liệu không đổi (sha256 JSON chuẩn) → `[skip]`; ghi = 1
transaction `market_csv.load` + `market_csv.reconcile` → `conn.commit()`.
"""

import argparse
import hashlib
import hmac
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest import market_csv as mc
from pipelines.job_runs import job_run

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "market_api.json"
VN_TZ = timezone(timedelta(hours=7))

CHANNELS = ("shopee", "tiktok")
KINDS = ("listing", "order")

# --- endpoint ĐỌC (giả định theo tài liệu công khai) ---
SP_ITEM_LIST = "/api/v2/product/get_item_list"
SP_ITEM_INFO = "/api/v2/product/get_item_base_info"
SP_MODEL_LIST = "/api/v2/product/get_model_list"
SP_ORDER_LIST = "/api/v2/order/get_order_list"
SP_ORDER_DETAIL = "/api/v2/order/get_order_detail"
TT_PRODUCT_SEARCH = "/product/202309/products/search"
TT_ORDER_SEARCH = "/order/202309/orders/search"
# r15: quyết toán CHỈ ĐỌC theo tài liệu CHÍNH THỨC (đọc 25/10/2026 —
# evidence/itacc_r15_remaining/NGUON_TAI_LIEU.md) — dùng bởi ingest.settlement_api.
SP_ESCROW_LIST = "/api/v2/payment/get_escrow_list"
SP_ESCROW_DETAIL = "/api/v2/payment/get_escrow_detail"
TT_STATEMENTS = "/finance/202309/statements"
TT_STATEMENT_TX = "/finance/202501/statements/{statement_id}/statement_transactions"
_PATH_PARAM_RE = re.compile(r"[0-9]{1,30}")

ALLOWED = frozenset({
    ("shopee", "GET", SP_ITEM_LIST),
    ("shopee", "GET", SP_ITEM_INFO),
    ("shopee", "GET", SP_MODEL_LIST),
    ("shopee", "GET", SP_ORDER_LIST),
    ("shopee", "GET", SP_ORDER_DETAIL),
    ("shopee", "GET", SP_ESCROW_LIST),
    ("shopee", "GET", SP_ESCROW_DETAIL),
    ("tiktok", "POST", TT_PRODUCT_SEARCH),
    ("tiktok", "POST", TT_ORDER_SEARCH),
    ("tiktok", "GET", TT_STATEMENTS),
    ("tiktok", "GET", TT_STATEMENT_TX),
})

# r14 C3a: refresh token theo tài liệu CHÍNH THỨC (đọc 25/10/2026 —
# evidence/itacc_r14_code_gaps/NGUON_TAI_LIEU.md). Shopee RefreshAccessToken:
# POST {SHOPEE_API_BASE}/api/v2/auth/access_token/get, sign Public API
# (partner_id + path + timestamp), body {refresh_token, partner_id, shop_id}
# → access_token (4 giờ) + refresh_token MỚI dùng 1 lần + expire_in (giây).
# TikTok: GET {TIKTOK_AUTH_BASE}/api/v2/token/refresh?app_key&app_secret&
# refresh_token&grant_type=refresh_token → data.access_token(+_expire_in Unix
# ts) + data.refresh_token. CHỈ phục vụ xác thực cho các endpoint đọc ở ALLOWED.
SP_AUTH_REFRESH = "/api/v2/auth/access_token/get"
TT_AUTH_REFRESH = "/api/v2/token/refresh"
DEFAULT_AUTH_BASE = {"tiktok": "https://auth.tiktok-shops.com"}
AUTH_ALLOWED = frozenset({("shopee", "POST", SP_AUTH_REFRESH),
                          ("tiktok", "GET", TT_AUTH_REFRESH)})
TOKEN_FILE_VAR = "MARKET_TOKEN_FILE"     # kho token JSON NGOÀI repo
REFRESH_MARGIN_S = 3600                  # còn < 1 giờ → refresh trước khi kéo
_TOKEN_RE = re.compile(r"[\x21-\x7e]{8,512}")

KEYS = {"shopee": ("SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY",
                   "SHOPEE_SHOP_ID", "SHOPEE_ACCESS_TOKEN"),
        "tiktok": ("TIKTOK_APP_KEY", "TIKTOK_APP_SECRET",
                   "TIKTOK_SHOP_CIPHER", "TIKTOK_ACCESS_TOKEN")}
DEFAULT_BASE = {"shopee": "https://partner.shopeemobile.com",
                "tiktok": "https://open-api.tiktokglobalshop.com"}
LOCAL_HOSTS = ("127.0.0.1", "localhost")

TIMEOUT_S = 15
# r13: HTTP 429/5xx → thử lại tối đa RETRY_MAX lần, chờ Retry-After (giây, trần
# RETRY_WAIT_MAX) hoặc lũy thừa 1,2,4…; GET/POST ở đây đều CHỈ ĐỌC nên lặp an toàn.
RETRY_STATUS = (429, 500, 502, 503, 504)
RETRY_MAX = 3
RETRY_WAIT_MAX = 30.0
FEATURE = "data_platform-06"
MAX_RESP_BYTES = 10 * 1024 * 1024
MAX_PAGES = 50
PAGE_SIZE = 100
BATCH = 50                     # trần id/lần của get_*_base_info/detail
DAYS_DEFAULT, DAYS_MAX = 7, 15  # get_order_list: cửa sổ ≤ 15 ngày
SP_ITEM_STATUSES = ["NORMAL", "UNLIST", "BANNED", "REVIEWING"]
_NUM_RE = re.compile(r"[0-9]{1,20}(?:\.0{1,6})?")


class ScopeError(Exception):
    """Endpoint ngoài allowlist chỉ đọc — từ chối TRƯỚC khi request."""


class ApiError(Exception):
    """Lỗi gọi API — message chỉ HTTP status/mã lỗi, không body/URL."""


class DataError(Exception):
    """Response sai dạng/giá trị — message chỉ nêu field, không giá trị."""


class ConfigError(Exception):
    """Thiếu key / base URL sai — message chỉ nêu TÊN biến."""


# ---------------------------------------------------------------- ký


def sign_shopee(partner_key: str, partner_id: str, path: str, timestamp: int,
                access_token: str, shop_id: str) -> str:
    base = f"{partner_id}{path}{timestamp}{access_token}{shop_id}"
    return hmac.new(partner_key.encode(), base.encode(),
                    hashlib.sha256).hexdigest()


def sign_tiktok(app_secret: str, path: str, query: dict, body: str) -> str:
    parts = "".join(f"{k}{query[k]}" for k in sorted(query)
                    if k not in ("sign", "access_token"))
    base = f"{app_secret}{path}{parts}{body}{app_secret}"
    return hmac.new(app_secret.encode(), base.encode(),
                    hashlib.sha256).hexdigest()


# ---------------------------------------------------------------- cấu hình


def read_creds(channel: str, token: str | None = None, *,
               refresh_only: bool = False) -> dict:
    """Key từ env — thiếu/rỗng → ConfigError nêu TÊN biến (không giá trị).
    `token` = access token từ kho (r14) thay biến env; `refresh_only` = chỉ
    cần key app (chưa có access token)."""
    keys = KEYS[channel][:3] if refresh_only else KEYS[channel]
    creds = {k: (os.environ.get(k) or "").strip() for k in keys}
    if token:
        creds[KEYS[channel][3]] = token
    missing = [k for k, v in creds.items() if not v]
    if missing:
        raise ConfigError("thiếu " + ", ".join(missing))
    return creds


def api_base(channel: str, var: str | None = None,
             default: str | None = None) -> str:
    var = var or f"{channel.upper()}_API_BASE"
    raw = (os.environ.get(var) or "").strip() or default or DEFAULT_BASE[channel]
    try:
        u = urllib.parse.urlsplit(raw)
        host = u.hostname
        u.port   # noqa: B018 — port sai → ValueError
    except ValueError:
        raise ConfigError(f"{var} không hợp lệ") from None
    ok = host and ((u.scheme == "https") or
                   (u.scheme == "http" and host in LOCAL_HOSTS))
    if (not ok or u.username or u.password or u.query or u.fragment
            or u.path not in ("", "/")):
        raise ConfigError(f"{var} không hợp lệ — chỉ https://<host> hoặc "
                          "http://127.0.0.1|localhost (server giả)")
    return f"{u.scheme}://{u.netloc}"


def load_status_map(path: Path = CONFIG_FILE) -> dict:
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
        sm = raw["status_map"]
        for ch in CHANNELS:
            for kind in KINDS:
                if not all(isinstance(k, str) and isinstance(v, str)
                           for k, v in sm[ch][kind].items()):
                    raise ValueError
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        raise ConfigError(f"{path.name}: không đọc được ({type(e).__name__})"
                          ) from None
    return sm


# ---------------------------------------------------------------- HTTP


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """3xx → không theo (redirect_request None → HTTPError)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _sleep(s: float) -> None:      # test thay để không chờ thật
    time.sleep(s)


def _request(channel: str, method: str, path: str, params: dict | None,
             body: dict | None = None, *, creds: dict | None = None,
             base: str | None = None, timestamp: int | None = None,
             path_params: dict | None = None) -> dict:
    """Cửa DUY NHẤT ra sàn. Allowlist kiểm ĐẦU TIÊN (theo MẪU path); r15: tham
    số path (`{statement_id}`) chỉ nhận số, thế vào SAU khi qua allowlist."""
    if (channel, method, path) not in ALLOWED:
        raise ScopeError(f"{mc._clean(channel, 20)} {mc._clean(method, 10)} "
                         f"{mc._clean(path, 100)}: ngoài allowlist chỉ đọc "
                         "— từ chối, không gửi request")
    for k, v in (path_params or {}).items():
        if not isinstance(v, str) or not _PATH_PARAM_RE.fullmatch(v):
            raise DataError(f"{channel} {path}: tham số path '{k}' sai dạng")
        path = path.replace("{" + k + "}", v)
    if "{" in path:
        raise ScopeError(f"{mc._clean(path, 100)}: thiếu tham số path")
    creds = read_creds(channel) if creds is None else creds
    base = api_base(channel) if base is None else base
    ts = int(time.time()) if timestamp is None else int(timestamp)
    query = dict(params or {})
    headers = {"Accept": "application/json"}
    data = None
    if channel == "shopee":
        query.update(partner_id=creds["SHOPEE_PARTNER_ID"], timestamp=ts,
                     access_token=creds["SHOPEE_ACCESS_TOKEN"],
                     shop_id=creds["SHOPEE_SHOP_ID"])
        query["sign"] = sign_shopee(
            creds["SHOPEE_PARTNER_KEY"], creds["SHOPEE_PARTNER_ID"], path, ts,
            creds["SHOPEE_ACCESS_TOKEN"], creds["SHOPEE_SHOP_ID"])
    else:
        # r15: GET không có body — chữ ký TikTok nối body RỖNG (finance GET).
        body_s = "" if method == "GET" else json.dumps(
            body or {}, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
        query = {k: str(v) for k, v in query.items()}
        query.update(app_key=creds["TIKTOK_APP_KEY"], timestamp=str(ts),
                     shop_cipher=creds["TIKTOK_SHOP_CIPHER"])
        query["sign"] = sign_tiktok(creds["TIKTOK_APP_SECRET"], path, query,
                                    body_s)
        headers["x-tts-access-token"] = creds["TIKTOK_ACCESS_TOKEN"]
        headers["Content-Type"] = "application/json"
        data = body_s.encode("utf-8") if method != "GET" else None
    url = f"{base}{path}?{urllib.parse.urlencode(query, doseq=True)}"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method=method)
    where = f"{channel} {path}"
    doc = _send(req, where)
    if channel == "shopee":
        if doc.get("error"):
            raise ApiError(f"{where}: mã lỗi {_err_code(doc['error'], creds)}")
    elif doc.get("code") != 0:
        raise ApiError(f"{where}: mã lỗi {_err_code(doc.get('code'), creds)}")
    return doc


# r14-fix2 F1: trường lỗi do SÀN trả có thể phản chiếu token/khóa → chỉ in mã đã
# kiểm kiểu/dạng (Shopee chữ thường nối `_`, TikTok số nguyên), mọi giá trị khác
# ẩn. r15: nhóm Payment dùng mã không tiền tố `error_` (`income_not_found`,
# `order_not_found`) → nhận cụm chữ cái thường nối `_` (không chữ số — token hex
# không lọt), vẫn ẩn mọi giá trị chứa credential đã biết.
_ERR_CODE_RE = re.compile(r"[a-z]{2,24}(?:_[a-z]{1,24}){1,6}")


def _err_code(v, creds: dict, *extra: str) -> str:
    s = None
    if isinstance(v, int) and not isinstance(v, bool) and abs(v) < 10 ** 9:
        s = str(v)
    elif isinstance(v, str) and _ERR_CODE_RE.fullmatch(v):
        s = v
    secrets = [x for x in (*creds.values(), *extra) if isinstance(x, str) and len(x) >= 8]
    if s is None or any(x in s for x in secrets):
        return "(không đúng dạng mã lỗi — đã ẩn)"
    return s


def _send(req, where: str, retries: int = RETRY_MAX) -> dict:
    """Gửi 1 request (không redirect, timeout, trần byte) → JSON object. Lỗi
    chỉ nêu HTTP status/loại lỗi — KHÔNG body, KHÔNG URL (URL chứa token)."""
    for attempt in range(retries + 1):
        try:
            with _OPENER.open(req, timeout=TIMEOUT_S) as resp:
                status = resp.status
                raw = resp.read(MAX_RESP_BYTES + 1)
            break
        except urllib.error.HTTPError as e:
            ra = e.headers.get("Retry-After", "") if e.headers else ""
            e.close()
            if e.code not in RETRY_STATUS or attempt == retries:
                raise ApiError(f"{where}: HTTP {e.code}"
                               + (f" sau {attempt + 1} lần" if attempt else "")
                               ) from None
            wait = float(ra) if ra.strip().isdigit() else float(2 ** attempt)
            print(f"[retry] {where}: HTTP {e.code} — chờ "
                  f"{min(wait, RETRY_WAIT_MAX):g}s ({attempt + 1}/{RETRY_MAX})",
                  flush=True)
            _sleep(min(wait, RETRY_WAIT_MAX))
        # r17: http.client.HTTPException (BadStatusLine, LineTooLong, quá 100
        # header) không phải OSError — như connectors/fanpage (r16 FIX2).
        except (urllib.error.URLError, OSError, ValueError,
                http.client.HTTPException) as e:
            raise ApiError(f"{where}: lỗi mạng ({type(e).__name__})") from None
    if status != 200:
        raise ApiError(f"{where}: HTTP {status}")
    if len(raw) > MAX_RESP_BYTES:
        raise ApiError(f"{where}: response > {MAX_RESP_BYTES // 2**20}MB")
    try:
        doc = json.loads(raw)
    except (ValueError, RecursionError):   # lồng sâu → RecursionError
        raise ApiError(f"{where}: JSON hỏng") from None
    if not isinstance(doc, dict):
        raise ApiError(f"{where}: JSON không phải object")
    return doc


# ---------------------------------------------------------------- token (r14)


def token_file() -> Path | None:
    """Đường kho token (`MARKET_TOKEN_FILE`) — trống = không dùng kho; nằm
    trong repo → ConfigError (token không bao giờ vào git)."""
    raw = (os.environ.get(TOKEN_FILE_VAR) or "").strip()
    if not raw:
        return None
    p = Path(raw).resolve()
    if p == ROOT or ROOT in p.parents:
        raise ConfigError(f"{TOKEN_FILE_VAR} nằm trong repo — đặt NGOÀI repo")
    return p


def load_tokens(path: Path) -> dict:
    try:
        doc = json.loads(path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise ConfigError(f"{TOKEN_FILE_VAR}: không đọc được "
                          f"({type(e).__name__})") from None
    if not isinstance(doc, dict):
        raise ConfigError(f"{TOKEN_FILE_VAR}: không phải object")
    return doc


def save_tokens(path: Path, doc: dict) -> None:
    """Ghi nguyên tử (tệp tạm cùng thư mục + os.replace)."""
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        tmp.write_bytes(json.dumps(doc, sort_keys=True).encode("utf-8"))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _tok(v, field: str, where: str) -> str:
    if not isinstance(v, str) or not _TOKEN_RE.fullmatch(v):
        raise DataError(f"{where}: thiếu/sai {field}")
    return v


def refresh_token(channel: str, creds: dict, refresh: str, base: str, *,
                  timestamp: int | None = None) -> dict:
    """1 lần gọi refresh (KHÔNG thử lại — refresh_token Shopee dùng 1 lần) →
    {access_token, refresh_token, expire_at}. Lỗi → ApiError/DataError."""
    method, path = (("POST", SP_AUTH_REFRESH) if channel == "shopee"
                    else ("GET", TT_AUTH_REFRESH))
    if (channel, method, path) not in AUTH_ALLOWED:
        raise ScopeError(f"{mc._clean(channel, 20)}: refresh ngoài allowlist")
    ts = int(time.time()) if timestamp is None else int(timestamp)
    where = f"{channel} refresh token"
    if channel == "shopee":
        pid = creds["SHOPEE_PARTNER_ID"]
        try:
            body = {"refresh_token": refresh, "partner_id": int(pid),
                    "shop_id": int(creds["SHOPEE_SHOP_ID"])}
        except ValueError:
            raise ConfigError("SHOPEE_PARTNER_ID/SHOPEE_SHOP_ID phải là số"
                              ) from None
        sign = hmac.new(creds["SHOPEE_PARTNER_KEY"].encode(),
                        f"{pid}{SP_AUTH_REFRESH}{ts}".encode(),
                        hashlib.sha256).hexdigest()
        url = (f"{base}{SP_AUTH_REFRESH}?" + urllib.parse.urlencode(
            {"partner_id": pid, "timestamp": ts, "sign": sign}))
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json",
                     "Accept": "application/json"})
        doc = _send(req, where, retries=0)
        if doc.get("error"):
            raise ApiError(f"{where}: mã lỗi "
                           f"{_err_code(doc['error'], creds, refresh)}")
        exp = doc.get("expire_in")
        if not isinstance(exp, int) or isinstance(exp, bool) or exp <= 0:
            raise DataError(f"{where}: thiếu/sai expire_in")
        return {"access_token": _tok(doc.get("access_token"), "access_token",
                                     where),
                "refresh_token": _tok(doc.get("refresh_token"),
                                      "refresh_token", where),
                "expire_at": ts + exp}
    url = (f"{base}{TT_AUTH_REFRESH}?" + urllib.parse.urlencode({
        "app_key": creds["TIKTOK_APP_KEY"],
        "app_secret": creds["TIKTOK_APP_SECRET"],
        "refresh_token": refresh, "grant_type": "refresh_token"}))
    req = urllib.request.Request(url, method="GET",
                                 headers={"Accept": "application/json"})
    doc = _send(req, where, retries=0)
    if doc.get("code") != 0:
        raise ApiError(f"{where}: mã lỗi "
                       f"{_err_code(doc.get('code'), creds, refresh)}")
    data = doc.get("data")
    if not isinstance(data, dict):
        raise DataError(f"{where}: thiếu data")
    exp = data.get("access_token_expire_in")
    if not isinstance(exp, int) or isinstance(exp, bool) or exp <= ts:
        raise DataError(f"{where}: thiếu/sai access_token_expire_in")
    return {"access_token": _tok(data.get("access_token"), "access_token",
                                 where),
            "refresh_token": _tok(data.get("refresh_token"), "refresh_token",
                                  where),
            "expire_at": exp}


def _do_refresh(channel: str, creds: dict, path: Path,
                force: bool) -> str | None:
    """Refresh dưới khóa tệp kho → access token mới | None (lỗi đã in). Đọc lại
    kho TRONG khóa: tiến trình khác vừa refresh xong → dùng luôn, không gọi."""
    from pipelines.job_runs import _file_lock
    with _file_lock(path.with_name(path.name + ".lock")) as got:
        if not got:
            print(f"[err] {channel}: tiến trình khác đang refresh token — bỏ "
                  "lượt, không gửi request.", flush=True)
            return None
        try:
            store = load_tokens(path)
        except ConfigError as e:
            print(f"[err] {e}", flush=True)
            return None
        entry = store.get(channel)
        entry = entry if isinstance(entry, dict) else {}
        exp = entry.get("expire_at")
        if (not force and entry.get("access_token") and isinstance(exp, int)
                and exp > time.time() + REFRESH_MARGIN_S):
            return entry["access_token"]
        old = entry.get("refresh_token") or (
            os.environ.get(f"{channel.upper()}_REFRESH_TOKEN") or "").strip()
        if not old:
            print(f"[external-dep] {channel}: chưa có refresh_token (kho "
                  f"{TOKEN_FILE_VAR} hoặc {channel.upper()}_REFRESH_TOKEN — chủ"
                  " shop ủy quyền app); 0 request.", flush=True)
            return None
        try:
            base = (api_base("shopee") if channel == "shopee" else
                    api_base(channel, "TIKTOK_AUTH_BASE",
                             DEFAULT_AUTH_BASE["tiktok"]))
            new = refresh_token(channel, creds, old, base)
        except (ApiError, DataError, ConfigError) as e:
            print(f"[err] {e} — kho token KHÔNG đổi.", flush=True)
            return None
        store[channel] = new
        try:
            save_tokens(path, store)
        except OSError as e:
            print(f"[err] {channel}: refresh xong nhưng KHÔNG lưu được kho "
                  f"token ({type(e).__name__}) — refresh_token mới đã mất, cần "
                  "chủ shop ủy quyền lại.", flush=True)
            return None
    print(f"[ok] {channel}: đã refresh token — hết hạn "
          f"{datetime.fromtimestamp(new['expire_at'], VN_TZ):%Y-%m-%d %H:%M}"
          " (giờ VN).", flush=True)
    return new["access_token"]


# ---------------------------------------------------------------- chuẩn hóa


def _obj(d, key: str, where: str) -> dict:
    v = d.get(key) if isinstance(d, dict) else None
    if not isinstance(v, dict):
        raise DataError(f"{where}: thiếu object '{key}'")
    return v


def _list(d, key: str, where: str) -> list:
    v = d.get(key) if isinstance(d, dict) else None
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
        raise DataError(f"{where}: '{key}' không phải list object")
    return v


def _id(v, field: str, where: str) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, str)):
        raise DataError(f"{where}: field '{field}' thiếu/sai kiểu")
    s = str(v).strip()
    if not s or len(s) > 64 or not s.isprintable():
        raise DataError(f"{where}: field '{field}' không hợp lệ")
    return s


def _str(v, field: str, where: str, n: int = 300) -> str | None:
    if v is None or v == "":
        return None
    if not isinstance(v, str):
        raise DataError(f"{where}: field '{field}' sai kiểu")
    return v.strip()[:n] or None


def _num(v, field: str, where: str) -> int:
    """Số nguyên ≥ 0 trong trần `market_csv.NUM_MAX`. Float/chuỗi có phần
    lẻ khác 0 (236000.5) → lỗi — không làm tròn giá."""
    if isinstance(v, bool) or v is None:
        raise DataError(f"{where}: field '{field}' thiếu/sai kiểu")
    if isinstance(v, float):
        if not v.is_integer():
            raise DataError(f"{where}: field '{field}' không phải số nguyên")
        v = int(v)
    s = str(v).strip()
    n = (mc._to_int(s.split(".")[0], mc.NUM_MAX[field])
         if _NUM_RE.fullmatch(s) else None)
    if n is None:
        raise DataError(f"{where}: field '{field}' không phải số nguyên ≥ 0 "
                        "hợp lệ")
    return n


def _order_hash(channel: str, order_id: str) -> str:
    # CÙNG công thức market_csv._parse
    return hashlib.sha256(f"{channel}:{order_id}".encode()).hexdigest()[:16]


def _row(**kw) -> dict:
    out = {f: None for f in mc.FIELDS if f != "order_id"}
    out.update(kw)
    return out


def _status(smap: dict, channel: str, kind: str, s) -> str | None:
    s = _str(s, "status", f"{channel} {kind}", 60)
    return smap[channel][kind].get(s, s) if s else None


def _number_rows(rows: list[dict]) -> list[dict]:
    for i, r in enumerate(rows, 1):
        r["row_no"] = i
    return rows


def _pages(fetch, next_of):
    """Duyệt trang: fetch(cursor) → doc; next_of(doc) → cursor | None.
    Vượt MAX_PAGES → ApiError (không nạp nửa vời)."""
    cursor, n = None, 0
    while True:
        n += 1
        if n > MAX_PAGES:
            raise ApiError(f"vượt MAX_PAGES={MAX_PAGES} — dừng, không nạp")
        doc = fetch(cursor)
        yield doc
        cursor = next_of(doc)
        if cursor in (None, ""):
            return


def fetch_shopee_listing(call, smap: dict) -> list[dict]:
    w = "shopee listing"
    ids: list[str] = []

    def page(off):
        return _obj(call("GET", SP_ITEM_LIST, {
            "offset": off or 0, "page_size": PAGE_SIZE,
            "item_status": SP_ITEM_STATUSES}), "response", w)

    for r in _pages(page, lambda r: r.get("next_offset")
                    if r.get("has_next_page") else None):
        ids += [_id(it.get("item_id"), "item_id", w)
                for it in _list(r, "item", w)]
    rows = []
    for i in range(0, len(ids), BATCH):
        info = _obj(call("GET", SP_ITEM_INFO, {
            "item_id_list": ",".join(ids[i:i + BATCH])}), "response", w)
        for it in _list(info, "item_list", w):
            iid = _id(it.get("item_id"), "item_id", w)
            title = _str(it.get("item_name"), "item_name", w)
            status = _status(smap, "shopee", "listing", it.get("item_status"))
            if it.get("has_model"):
                m = _obj(call("GET", SP_MODEL_LIST, {"item_id": iid}),
                         "response", w)
                for md in _list(m, "model", w):
                    rows.append(_row(
                        item_id=iid, title=title, status=status,
                        seller_sku=_str(md.get("model_sku"), "model_sku", w),
                        price=_shopee_price(md, w),
                        stock=_shopee_stock(md, w)))
            else:
                rows.append(_row(
                    item_id=iid, title=title, status=status,
                    seller_sku=_str(it.get("item_sku"), "item_sku", w),
                    price=_shopee_price(it, w), stock=_shopee_stock(it, w)))
    return _number_rows(rows)


def _shopee_price(d: dict, w: str) -> int:
    pi = _list(d, "price_info", w)
    if not pi:
        raise DataError(f"{w}: thiếu 'price_info'")
    return _num(pi[0].get("original_price"), "price", w)


def _shopee_stock(d: dict, w: str) -> int | None:
    s = d.get("stock_info_v2")
    s = s.get("summary_info") if isinstance(s, dict) else None
    v = s.get("total_available_stock") if isinstance(s, dict) else None
    return None if v is None else _num(v, "stock", w)


def fetch_shopee_order(call, smap: dict, days: int, now: float) -> list[dict]:
    w = "shopee order"
    t1 = int(now)
    t0 = t1 - days * 86400
    sns: list[str] = []

    def page(cur):
        p = {"time_range_field": "create_time", "time_from": t0,
             "time_to": t1, "page_size": PAGE_SIZE}
        if cur:
            p["cursor"] = cur
        return _obj(call("GET", SP_ORDER_LIST, p), "response", w)

    for r in _pages(page, lambda r: r.get("next_cursor")
                    if r.get("more") else None):
        sns += [_id(o.get("order_sn"), "order_sn", w)
                for o in _list(r, "order_list", w)]
    rows = []
    for i in range(0, len(sns), BATCH):
        det = _obj(call("GET", SP_ORDER_DETAIL, {
            "order_sn_list": ",".join(sns[i:i + BATCH]),
            "response_optional_fields": "item_list"}), "response", w)
        for o in _list(det, "order_list", w):
            # chỉ trích field allowlist — buyer/recipient bỏ cùng dict `o`
            h = _order_hash("shopee", _id(o.get("order_sn"), "order_sn", w))
            status = _status(smap, "shopee", "order", o.get("order_status"))
            for it in _list(o, "item_list", w):
                rows.append(_row(
                    item_id=_id(it.get("item_id"), "item_id", w),
                    seller_sku=(_str(it.get("model_sku"), "model_sku", w)
                                or _str(it.get("item_sku"), "item_sku", w)),
                    title=_str(it.get("item_name"), "item_name", w),
                    qty=_num(it.get("model_quantity_purchased"), "qty", w),
                    price=_num(it.get("model_discounted_price"), "price", w),
                    status=status, order_id_hash=h))
    return _number_rows(rows)


def _tt_pages(call, path: str, body: dict, key: str, w: str):
    def page(tok):
        p = {"page_size": PAGE_SIZE}
        if tok:
            p["page_token"] = tok
        return _obj(call("POST", path, p, body), "data", w)

    for d in _pages(page, lambda d: d.get("next_page_token")):
        yield from _list(d, key, w)


def fetch_tiktok_listing(call, smap: dict) -> list[dict]:
    w = "tiktok listing"
    rows = []
    for p in _tt_pages(call, TT_PRODUCT_SEARCH, {}, "products", w):
        pid = _id(p.get("id"), "id", w)
        title = _str(p.get("title"), "title", w)
        status = _status(smap, "tiktok", "listing", p.get("status"))
        for sku in _list(p, "skus", w):
            price = sku.get("price")
            price = price if isinstance(price, dict) else {}
            inv = _list(sku, "inventory", w)
            rows.append(_row(
                item_id=pid, title=title, status=status,
                seller_sku=_str(sku.get("seller_sku"), "seller_sku", w),
                price=_num(price.get("tax_exclusive_price"), "price", w),
                stock=(sum(_num(x.get("quantity"), "stock", w) for x in inv)
                       if inv else None)))
    return _number_rows(rows)


def fetch_tiktok_order(call, smap: dict, days: int, now: float) -> list[dict]:
    w = "tiktok order"
    t1 = int(now)
    body = {"create_time_ge": t1 - days * 86400, "create_time_lt": t1}
    rows = []
    for o in _tt_pages(call, TT_ORDER_SEARCH, body, "orders", w):
        h = _order_hash("tiktok", _id(o.get("id"), "id", w))
        status = _status(smap, "tiktok", "order", o.get("status"))
        for li in _list(o, "line_items", w):
            rows.append(_row(
                item_id=_id(li.get("product_id"), "product_id", w),
                seller_sku=_str(li.get("seller_sku"), "seller_sku", w),
                title=_str(li.get("product_name"), "product_name", w),
                qty=1,   # 202309: 1 line_item = 1 đơn vị (giả định)
                price=_num(li.get("original_price"), "price", w),
                status=status, order_id_hash=h))
    return _number_rows(rows)


def fetch(channel: str, kind: str, call, smap: dict, days: int = DAYS_DEFAULT,
          now: float | None = None) -> list[dict]:
    now = time.time() if now is None else now
    if channel == "shopee":
        return (fetch_shopee_listing(call, smap) if kind == "listing"
                else fetch_shopee_order(call, smap, days, now))
    return (fetch_tiktok_listing(call, smap) if kind == "listing"
            else fetch_tiktok_order(call, smap, days, now))


def rows_sha256(channel: str, kind: str, rows: list[dict]) -> str:
    """sha256 JSON chuẩn — cùng dữ liệu = cùng hash → `[skip]`."""
    blob = json.dumps({"channel": channel, "kind": kind, "rows": rows},
                      sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- CLI


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def _ingest(args, creds: dict, base: str, smap: dict, mapping: dict) -> int:
    def call(method, path, params, body=None):
        return _request(args.channel, method, path, params, body,
                        creds=creds, base=base)

    try:
        rows = fetch(args.channel, args.kind, call, smap, args.days)
    except (ApiError, DataError, ScopeError) as e:
        print(f"[err] {e} — không connect, không nạp gì.", flush=True)
        return 1
    if not rows:
        print(f"[warn] API {args.channel}/{args.kind} trả 0 dòng — không nạp "
              "gì.", flush=True)
        return 0
    sha = rows_sha256(args.channel, args.kind, rows)
    fname = f"api:{args.channel}:{args.kind}:{datetime.now(VN_TZ):%Y%m%dT%H%M}"
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env", flush=True)
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.Error as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}",
              flush=True)
        return 1
    try:
        old = conn.execute(
            "select id, channel, export_kind from market_snapshots"
            " where file_sha256 = %s", (sha,)).fetchone()
        if old:
            print(f"[skip] dữ liệu không đổi: snapshot #{old[0]} "
                  f"{old[1]}/{old[2]} — không ghi gì.", flush=True)
            return 0
        sid, mapped = mc.load(conn, rows, args.channel, args.kind, fname, sha)
        inactive = mapping[args.channel][args.kind].get("inactive_status", [])
        alerts = mc.reconcile(conn, sid, inactive)
        conn.commit()
    except psycopg.errors.UniqueViolation as e:
        conn.rollback()
        if "file_sha256" in (e.diag.constraint_name or ""):
            print("[skip] dữ liệu vừa được nạp song song — không ghi gì.",
                  flush=True)
            return 0
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    except psycopg.errors.UndefinedTable:
        conn.rollback()
        print("[err] thiếu bảng market_* / golden — chạy `python "
              "scripts/apply_schema.py` trước.", flush=True)
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()
    print(f"[load] snapshot #{sid} {args.channel}/{args.kind} {fname}: "
          f"{len(rows)} dòng, map golden {mapped}", flush=True)
    kept = alerts.pop("kept_absent", 0)
    print("[alerts] " + (", ".join(f"{k}={v}" for k, v in
                                   sorted(alerts.items()))
                         or "order — không đối chiếu ở P1"), flush=True)
    if kept:
        print(f"[warn] {kept} cảnh báo {args.channel}/{args.kind} không thấy "
              "item trong dữ liệu API — GIỮ MỞ (vắng ≠ đã sửa)", flush=True)
    print("[done]", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.market_api",
        description="Kéo listing/đơn qua API sàn CHỈ ĐỌC vào staging v3.3.")
    ap.add_argument("--channel", choices=CHANNELS, required=True)
    ap.add_argument("--kind", choices=(*KINDS, "settlement", "ads"))
    ap.add_argument("--refresh", action="store_true",
                    help=f"refresh access token (kho {TOKEN_FILE_VAR}) rồi thoát")
    ap.add_argument("--days", type=int,
                    help=f"order: số ngày gần nhất 1..{DAYS_MAX} "
                         f"(mặc định {DAYS_DEFAULT})")
    ap.add_argument("--from", dest="date_from", metavar="YYYY-MM-DD",
                    help="settlement: ngày đầu (giờ VN)")
    ap.add_argument("--to", dest="date_to", metavar="YYYY-MM-DD",
                    help="settlement: ngày cuối, gồm cả ngày này (≤31 ngày)")
    ap.add_argument("--dry-run", action="store_true",
                    help="settlement: kéo + báo trạng thái ánh xạ, KHÔNG ghi sổ")
    args = ap.parse_args(argv)
    if bool(args.kind) == args.refresh:
        ap.error("chọn đúng 1: --kind hoặc --refresh")
    if args.kind == "ads":
        ap.error("ads chỉ qua file — `ingest.market_csv` (API quảng cáo = "
                 "external-dep)")
    if args.days is not None and args.kind != "order":  # --refresh: kind None
        ap.error("--days chỉ dùng với --kind order")
    if args.kind == "settlement":
        from ingest import settlement_api as sa
        if not (args.date_from and args.date_to):
            ap.error("--kind settlement cần --from và --to")
        args.window = sa.parse_window(args.date_from, args.date_to)
        if isinstance(args.window, str):
            ap.error(args.window)
    elif args.date_from or args.date_to or args.dry_run:
        ap.error("--from/--to/--dry-run chỉ dùng với --kind settlement")
    if args.days is None:
        args.days = DAYS_DEFAULT
    if not 1 <= args.days <= DAYS_MAX:
        ap.error(f"--days phải trong 1..{DAYS_MAX}")

    load_dotenv(ROOT / ".env")
    try:
        tfile = token_file()
        entry = (load_tokens(tfile).get(args.channel) if tfile else None)
        entry = entry if isinstance(entry, dict) else {}
        if args.refresh and tfile is None:
            raise ConfigError(f"--refresh cần {TOKEN_FILE_VAR} (refresh_token "
                              "xoay vòng phải được lưu)")
    except ConfigError as e:
        print(f"[err] {e} — 0 request.", flush=True)
        return 2
    try:
        creds = read_creds(args.channel, entry.get("access_token"),
                           refresh_only=bool(tfile))
    except ConfigError as e:
        print(f"[external-dep] {e} — chưa có app key/token sàn (Partner "
              "Center, quyền chỉ đọc); 0 request, không connect DB.",
              flush=True)
        return 2
    try:
        base = api_base(args.channel)
    except ConfigError as e:
        print(f"[err] {e}", flush=True)
        return 2
    if args.kind == "settlement":
        # r15: bảng ánh xạ chưa chốt / nguồn không phải API thật → chặn TRƯỚC
        # mọi request (kể cả refresh); --dry-run vẫn kéo để báo thiếu gì.
        cfg, fees, kind, rc = sa.precheck(args.channel, base, args.dry_run)
        if rc is not None:
            return rc
    # r13: tính năng TẮT (sổ triển khai, HĐ 6.7) → 0 request ra sàn, không nạp.
    from pipelines import rollout
    if why := rollout.blocked(None, "kéo dữ liệu API sàn chỉ đọc", FEATURE):
        return rollout.say_blocked(why)
    exp = entry.get("expire_at")
    if tfile and (args.refresh or not entry.get("access_token")
                  or not isinstance(exp, int)
                  or exp <= time.time() + REFRESH_MARGIN_S):
        tok = _do_refresh(args.channel, creds, tfile, args.refresh)
        if tok is None:
            return 1
        creds[KEYS[args.channel][3]] = tok
    if args.refresh:
        return 0
    if args.kind == "settlement":
        if args.dry_run:            # không đụng DB, kể cả sổ job_runs
            return sa.run(args, creds, base, cfg, fees, kind)
        with job_run("ingest.settlement_api") as run:
            rc = sa.run(args, creds, base, cfg, fees, kind)
            run["ok"] = rc == 0
        return rc
    try:
        smap = load_status_map()
    except ConfigError as e:
        print(f"[err] {e}", flush=True)
        return 1
    mapping, why = mc.load_mapping()
    if mapping is None:
        print(f"[err] {why}", flush=True)
        return 1
    with job_run("ingest.market_api") as run:
        rc = _ingest(args, creds, base, smap, mapping)
        run["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
