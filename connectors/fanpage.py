"""r16 legal_hr-04 (PL01 Pháp chế "Quét web, Fanpage, listing; mở yêu cầu gỡ
bài vi phạm trong 24 giờ") — đọc bài ĐÃ ĐĂNG của Fanpage công ty qua Meta
Graph API, CHỈ ĐỌC. Người dùng duy nhất: `agents.ra_kenh --scan-auto`.

Đặc tả theo TÀI LIỆU CHÍNH THỨC (developers.facebook.com, đọc 27/10/2026,
Graph API v26.0) — CHƯA chạy với Page/token thật (CONTRACT_TESTED server giả):
  - `GET https://graph.facebook.com/v26.0/{page-id}/published_posts` — PagePost
    do CHÍNH Page đăng (không bài khách như `/feed`, không bình luận/inbox).
    Tham số `fields=id,message,created_time,permalink_url`, `limit` ≤ 100.
  - Token: Page access token, `access_token` ở query (cách tài liệu Graph API
    overview hướng dẫn); quyền app `pages_read_engagement` (+
    `pages_read_user_content` theo trang `/feed`), người cấp token có task
    CREATE_CONTENT | MANAGE | MODERATE trên Page.
  - Phân trang cursor: dừng khi KHÔNG còn `paging.next` — trang rỗng/ít hơn
    `limit` KHÔNG phải hết (lọc quyền riêng tư); không lưu cursor. Trang sau
    dựng lại từ `paging.cursors.after` trên CÙNG host/path (không theo URL
    `next` do server trả — chống lộ token sang host khác).
  - Lỗi: JSON `error.code` (+ `error_subcode`): 190/102 (subcode 463/467)
    token hết hạn/thu hồi/không hợp lệ; 10, 200–299 thiếu quyền; 1, 2, 4, 17,
    341, 368 tạm thời → chờ rồi thử lại.
Chưa làm: `appsecret_proof` (chỉ cần khi app Meta bật "Require App Secret").

CHỈ ĐỌC bằng cấu trúc: 1 hàm `_get` dựng URL từ `PATH` cứng — module không có
đường POST/DELETE. HTTP: urllib, timeout, KHÔNG theo redirect, trần byte; lỗi
chỉ mang HTTP status + mã lỗi số — KHÔNG URL (chứa token), KHÔNG body/message.
Base URL đổi được qua `FANPAGE_API_BASE` CHỈ cho server giả (`https://` hoặc
`http://127.0.0.1|localhost`, cùng luật `ingest.market_api.api_base`).

Env: `FANPAGE_PAGE_ID` (chữ số), `FANPAGE_READ_TOKEN` (token RIÊNG quyền đọc —
không dùng chung `MESSENGER_PAGE_TOKEN`), `FANPAGE_API_BASE` (trống = Graph).
"""

import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from ingest.market_api import ConfigError, api_base

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

VERSION = "v26.0"
DEFAULT_BASE = "https://graph.facebook.com"
PATH = "/{page_id}/published_posts"
FIELDS = "id,message,created_time,permalink_url"
LIMIT = 100                    # trần tài liệu
MAX_PAGES = 50                 # 5000 bài (~600 bài/năm theo tài liệu)
MAX_RESP_BYTES = 5 * 1024 * 1024
TIMEOUT_S = 15
RETRY_MAX = 3
RETRY_WAIT_MAX = 30.0
RETRY_HTTP = (429, 500, 502, 503, 504)
TEMP_CODES = {1, 2, 4, 17, 341, 368}
TOKEN_CODES = {190, 102}
ENV_PAGE, ENV_TOKEN, ENV_BASE = ("FANPAGE_PAGE_ID", "FANPAGE_READ_TOKEN",
                                 "FANPAGE_API_BASE")
_PAGE_RE = re.compile(r"[0-9]{1,30}")
_TOKEN_RE = re.compile(r"[\x21-\x7e]{8,1024}")
_CURSOR_RE = re.compile(r"[A-Za-z0-9_=-]{1,1024}")
_POST_HOSTS = ("facebook.com",)


class FanpageError(Exception):
    """Lỗi đọc Fanpage — thông điệp KHÔNG chứa URL/token/body."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _sleep(s: float) -> None:      # test thay để không chờ thật
    time.sleep(s)


def config() -> dict | None:
    """Env → {page_id, token, base} | None khi CHƯA cấu hình (cả 2 biến
    trống). Cấu hình dở/sai dạng → ConfigError nêu TÊN biến (không giá trị)."""
    page = (os.environ.get(ENV_PAGE) or "").strip()
    token = (os.environ.get(ENV_TOKEN) or "").strip()
    if not page and not token:
        return None
    if not _PAGE_RE.fullmatch(page):
        raise ConfigError(f"{ENV_PAGE} thiếu/sai dạng (chỉ chữ số)")
    if not _TOKEN_RE.fullmatch(token):
        raise ConfigError(f"{ENV_TOKEN} thiếu/sai dạng")
    return {"page_id": page, "token": token,
            "base": api_base("fanpage", ENV_BASE, DEFAULT_BASE)}


def _code(v) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and \
        0 <= v < 10 ** 7 else None


def _graph_error(raw: bytes) -> tuple[int | None, int | None]:
    try:
        e = json.loads(raw).get("error")
    except (ValueError, RecursionError, AttributeError):
        return None, None
    if not isinstance(e, dict):
        return None, None
    return _code(e.get("code")), _code(e.get("error_subcode"))


def _explain(status: int, code: int | None, sub: int | None) -> str:
    s = f"HTTP {status}" + (f" mã {code}" if code is not None else "") + (
        f"/{sub}" if sub is not None else "")
    if code in TOKEN_CODES or sub in (463, 467):
        return s + " — token hết hạn/thu hồi/không hợp lệ: Bên B cấp lại"
    if code == 10 or (code is not None and 200 <= code <= 299):
        return s + " — thiếu quyền đọc bài Page (pages_read_engagement)"
    return s


def _get(cfg: dict, after: str | None) -> dict:
    """1 trang `published_posts` → JSON object (thử lại lỗi tạm thời)."""
    q = {"fields": FIELDS, "limit": LIMIT, "access_token": cfg["token"]}
    if after is not None:
        q["after"] = after
    url = (f"{cfg['base']}/{VERSION}{PATH.format(page_id=cfg['page_id'])}?"
           f"{urllib.parse.urlencode(q)}")
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in range(RETRY_MAX + 1):
        try:
            with _OPENER.open(req, timeout=TIMEOUT_S) as resp:
                status, raw = resp.status, resp.read(MAX_RESP_BYTES + 1)
            break
        except urllib.error.HTTPError as e:
            try:
                body = e.read(64 * 1024) if 400 <= e.code < 600 else b""
            except (OSError, http.client.HTTPException):
                body = b""
            e.close()
            code, sub = _graph_error(body)
            temp = e.code in RETRY_HTTP or code in TEMP_CODES
            if not temp or attempt == RETRY_MAX:
                raise FanpageError("fanpage: " + _explain(e.code, code, sub)
                                   + (f" sau {attempt + 1} lần" if attempt
                                      else "")) from None
            wait = min(float(2 ** attempt), RETRY_WAIT_MAX)
            print(f"[retry] fanpage: HTTP {e.code}"
                  + (f" mã {code}" if code is not None else "")
                  + f" — chờ {wait:g}s ({attempt + 1}/{RETRY_MAX})", flush=True)
            _sleep(wait)
        # http.client.HTTPException (BadStatusLine, LineTooLong, quá 100
        # header, IncompleteRead) không phải OSError — urllib để lọt nguyên.
        except (urllib.error.URLError, OSError, ValueError,
                http.client.HTTPException) as e:
            raise FanpageError(f"fanpage: lỗi mạng ({type(e).__name__})"
                               ) from None
    if status != 200:
        raise FanpageError(f"fanpage: HTTP {status}")
    if len(raw) > MAX_RESP_BYTES:
        raise FanpageError("fanpage: response quá trần byte")
    try:
        doc = json.loads(raw)
    except (ValueError, RecursionError):
        raise FanpageError("fanpage: JSON hỏng") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
        raise FanpageError("fanpage: response thiếu mảng data")
    return doc


def fetch_posts(cfg: dict) -> list[dict]:
    """MỌI bài đã đăng của Page (theo phân trang) → list dict thô (chỉ các
    field xin). Lỗi bất kỳ trang → FanpageError (không trả nửa vời)."""
    out, after = [], None
    for _ in range(MAX_PAGES):
        doc = _get(cfg, after)
        out += [p for p in doc["data"] if isinstance(p, dict)]
        paging = doc.get("paging") if isinstance(doc.get("paging"), dict) \
            else {}
        if not paging.get("next"):
            return out
        cur = paging.get("cursors")
        after = cur.get("after") if isinstance(cur, dict) else None
        if not isinstance(after, str) or not _CURSOR_RE.fullmatch(after):
            raise FanpageError("fanpage: có trang sau nhưng thiếu/sai cursor")
    raise FanpageError(f"fanpage: vượt {MAX_PAGES} trang — không nạp nửa vời")


def post_url(v) -> str | None:
    """`permalink_url` hợp lệ (https, host facebook.com hoặc tên miền con)."""
    if not isinstance(v, str):
        return None
    try:
        u = urllib.parse.urlsplit(v)
        host = (u.hostname or "").lower()
    except ValueError:
        return None
    if u.scheme != "https" or u.username or u.password or not any(
            host == h or host.endswith("." + h) for h in _POST_HOSTS):
        return None
    return v
