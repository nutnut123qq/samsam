"""v8.2 KD-A3 (WP11) — form B2B nhận yêu cầu báo giá quà Tết (stdlib
`http.server`, TÁCH khỏi webhook Zalo/Messenger). Mặc định TẮT.

Contract:
  - `python -m connectors.b2b_form`: `B2B_FORM_ENABLED` (env tiến trình, KHÔNG
    đọc từ .env) ∉ 1/true/yes → exit 2 TRƯỚC khi bind (chỉ bật sau khi DPIA
    luồng form được ký). Khóa vault (`CONTACT_VAULT_KEY`) lỗi → exit 2 trước
    bind. Bind `B2B_FORM_HOST` (mặc định 127.0.0.1) : `B2B_FORM_PORT` (mặc
    định 8791 — 8788 zalo, 8789 messenger). Domain/TLS/reverse proxy =
    external-dep.
  - `GET /b2b` → `data/b2b_form.html` (HTML tĩnh, không script) với danh
    sách sản phẩm = `kd_catalog.eligible` (cùng tập catalog: không rượu,
    không TPBVSK chưa XNQC), mọi giá trị qua `html.escape`.
  - `POST /b2b`: chunked / thiếu Content-Length → 411; > 8 KB → 413 KHÔNG
    đọc body; Content-Type ≠ urlencoded → 415; rate-limit (in-memory, khóa
    sha256(ip)) → 429 — đều TRƯỚC khi đọc body/DB; lỗi đầu vào → 400 trang
    chung (KHÔNG echo input); honeypot → 200 trang chung, 0 ghi; DB/vault lỗi
    → 503; OK → 200 trang chung (KHÔNG hiện mã YC — mã chỉ ở log/CLI GĐ).
  - PII người liên hệ (tên/SĐT/email) CHỈ vào `contacts` mã hóa Fernet
    (`ingest.crm.add_contact`) + `consents` mục đích `b2b` (nguồn `web`,
    `policy_version` NHÁP chờ Pháp chế); `b2b_requests` chỉ giữ `contact_id`
    + `consent_id` (insert-only). Gửi lại y hệt cùng ngày → trả id cũ, 0 ghi.
  - SĐT trùng contact đã RÚT đồng ý b2b → trang chung (body y hệt OK, không
    oracle dò vault), 0 ghi (form không xác minh SĐT — OTP/double opt-in =
    external-dep, ghi trong DPIA).
  - Log stdout chỉ `[b2b_form] <status> ip=<hash8> yc=<id>` — không PII;
    client RST / ngoại lệ bất ngờ → stderr chỉ hash IP + tên lớp lỗi;
    hash IP = HMAC muối ngẫu nhiên theo tiến trình (không dò ngược IP).
  - Module chỉ NHẬN (http.server), không gửi gì ra ngoài, không LLM.

Chạy: B2B_FORM_ENABLED=1 python -m connectors.b2b_form → :8791/b2b
"""

import argparse
import contextlib
import hashlib
import hmac
import html
import json
import os
import re
import sys
import threading
import time
from collections import deque
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import psycopg
from dotenv import load_dotenv

from agents import kd_catalog
from agents.da_b2b import ORG_TYPES, norm
from ingest import crm
from ingest.golden_store import GOLDEN_FILE, read_golden
from ingest.lead_store import connect
from pipelines.period import VN_TZ
from pipelines.pii import _PII_RE

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
FORM_FILE = ROOT / "data" / "b2b_form.html"
PATH = "/b2b"
DEFAULT_PORT = 8791
MAX_FORM_BYTES = 8192
MAX_FIELDS = 40
MAX_LINES = 10
MAX_QTY = 100_000
POLICY_VERSION = "b2b-v0-nhap"
BY = "web:b2b_form"
SOURCE = "b2b_form"
FORM_CT = "application/x-www-form-urlencoded"
BASE_FIELDS = {"org_name", "org_type", "region", "contact_name", "phone",
               "email", "need_by", "consent", "policy_version", "website"}
_LINE_FIELD = re.compile(r"(sku|qty)([1-9][0-9]{0,2})")
_EMAIL_RE = re.compile(r"[^@\s]{1,64}@[A-Za-z0-9-]{1,63}"
                       r"(?:\.[A-Za-z0-9-]{1,63})+")
# Chữ số hex → chữ g..p: mã biên bản không bao giờ khớp mẫu SĐT của
# `_PII_RE` (record_consent từ chối evidence_ref "giống SĐT").
_EV_TR = str.maketrans("0123456789", "ghijklmnop")
# Muối ngẫu nhiên MỖI tiến trình cho hash IP (rate-limit + log): IPv4 chỉ
# 2^32 giá trị — sha256(ip) trần dò ngược được; HMAC muối không ghi đĩa →
# hash chỉ so được trong 1 lần chạy, không truy ngược IP.
_IP_SALT = os.urandom(16)

PAGE_OK = ("<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
           "<title>Đã nhận yêu cầu</title></head><body><h1>Đã nhận yêu cầu"
           "</h1><p>GĐ bán hàng sẽ liên hệ. Hệ thống không tự gửi báo "
           "giá.</p></body></html>")
PAGE_ERR = ("<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\">"
            "<title>Chưa gửi được</title></head><body><h1>Chưa gửi được yêu "
            "cầu</h1><p>{msg}</p><p><a href=\"/b2b\">Quay lại form</a></p>"
            "</body></html>")
MSG = {400: "Thông tin chưa hợp lệ — kiểm tra lại các ô bắt buộc, số điện "
            "thoại, tỉnh/thành, sản phẩm và ô đồng ý.",
       404: "Không có trang này.",
       411: "Thiếu độ dài nội dung.",
       413: "Nội dung quá lớn.",
       415: "Định dạng gửi không hỗ trợ.",
       429: "Gửi quá nhiều lần — thử lại sau.",
       503: "Hệ thống đang bận — thử lại sau."}


def _vn_today() -> date:
    return datetime.now(VN_TZ).date()


def iphash(ip: str) -> str:
    return hmac.new(_IP_SALT, str(ip).encode("utf-8"),
                    hashlib.sha256).hexdigest()[:16]


# ----------------------------------------------------------------- thuần
def options(golden, combos) -> list[tuple[str, str]]:
    """Cùng tập catalog (`kd_catalog.eligible`) → [(key, tên)]."""
    items, _ = kd_catalog.eligible(golden, combos)
    return [(it["key"], it["name"]) for it in items]


def render_page(opts, template: str | None = None) -> str:
    tpl = template if template is not None else \
        FORM_FILE.read_bytes().decode("utf-8")
    o = "".join(f'<option value="{html.escape(k, quote=True)}">'
                f"{html.escape(n, quote=True)}</option>" for k, n in opts)
    return tpl.replace("<!--OPTIONS-->", o)


def parse_form(body: bytes, allowed, today: date):
    """THUẦN → (form | None, mã). Mã: ok | khong_utf8 | qua_nhieu_truong |
    truong_lap | truong_la | spam | thieu_dong_y | ten_to_chuc |
    loai_to_chuc | tinh | ten_lien_he | sdt | email | so_dong |
    ma_khong_hop_le (gồm key rượu — mã chung) | so_luong | dong_trung |
    ngay_can. Thông báo không chứa giá trị đầu vào."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return None, "khong_utf8"
    try:
        q = parse_qs(text, keep_blank_values=True, max_num_fields=MAX_FIELDS,
                     separator="&", errors="strict")
    except UnicodeDecodeError:          # %FF... không phải UTF-8
        return None, "khong_utf8"
    except ValueError:
        return None, "qua_nhieu_truong"
    if any(len(v) != 1 for v in q.values()):
        return None, "truong_lap"
    f = {k: v[0] for k, v in q.items()}
    idx = set()
    for k in f:
        m = _LINE_FIELD.fullmatch(k)
        if m:
            idx.add(int(m.group(2)))
        elif k not in BASE_FIELDS:
            return None, "truong_la"
    if f.get("website", "").strip():
        return None, "spam"
    if f.get("consent") != "b2b" or f.get("policy_version") != POLICY_VERSION:
        return None, "thieu_dong_y"
    org = " ".join(f.get("org_name", "").split())
    if not 2 <= len(org) <= 200 or not org.isprintable() \
            or _PII_RE.search(org):
        return None, "ten_to_chuc"
    if f.get("org_type") not in ORG_TYPES:
        return None, "loai_to_chuc"
    reg = f.get("region", "")
    prov = crm.province_of(reg) if len(reg) <= 100 else None
    if prov is None:
        return None, "tinh"
    cname = " ".join(f.get("contact_name", "").split())
    if not 1 <= len(cname) <= 200 or not cname.isprintable() \
            or _PII_RE.search(cname):
        return None, "ten_lien_he"
    try:
        phone = crm.normalize_phone(f.get("phone", ""))
    except ValueError:
        return None, "sdt"
    email = f.get("email", "").strip()
    if email and (len(email) > 254 or not _EMAIL_RE.fullmatch(email)):
        return None, "email"
    if any(i > MAX_LINES for i in idx):
        return None, "so_dong"
    items, seen = [], set()
    for i in range(1, MAX_LINES + 1):
        sku = f.get(f"sku{i}", "").strip()
        qv = f.get(f"qty{i}", "").strip()
        if not sku and not qv:
            continue
        if sku not in allowed:
            return None, "ma_khong_hop_le"
        if not re.fullmatch(r"[0-9]{1,6}", qv) or not \
                1 <= int(qv) <= MAX_QTY:
            return None, "so_luong"
        if sku in seen:
            return None, "dong_trung"
        seen.add(sku)
        items.append({"key": sku, "qty": int(qv)})
    if not items:
        return None, "so_dong"
    need_by = None
    nb = f.get("need_by", "").strip()
    if nb:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", nb):
            return None, "ngay_can"
        try:
            need_by = date.fromisoformat(nb)
        except ValueError:
            return None, "ngay_can"
        if not today <= need_by <= today + timedelta(days=365):
            return None, "ngay_can"
    return {"org_name": org, "org_type": f["org_type"], "region": prov,
            "contact": {"name": cname, "phone": phone,
                        "email": email or None},
            "items": items, "need_by": need_by}, "ok"


def request_key(form: dict, day: date) -> str:
    """b2r:sha256(tên tổ chức chuẩn hóa | tỉnh | items canonical | ngày VN)
    — chống gửi trùng (bấm 2 lần / gửi lại cùng ngày)."""
    items = sorted((it["key"], it["qty"]) for it in form["items"])
    raw = (f"{norm(form['org_name'])}|{norm(form['region'])}|"
           f"{json.dumps(items, separators=(',', ':'))}|{day.isoformat()}")
    return "b2r:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


class RateLimiter:
    """Cửa sổ trượt in-memory (không ghi đĩa): ≤ per_ip lượt/IP + ≤
    global_limit lượt toàn server trong window_s. Khóa = sha256(ip)[:16];
    chỉ lượt ĐƯỢC NHẬN mới ghi → số khóa ≤ global_limit (bộ nhớ chặn trên)."""

    def __init__(self, per_ip: int = 5, global_limit: int = 60,
                 window_s: float = 3600, clock=time.monotonic):
        self.per_ip, self.global_limit = per_ip, global_limit
        self.window_s, self.clock = window_s, clock
        self._ip: dict[str, deque] = {}
        self._all: deque = deque()
        self._lock = threading.Lock()

    def allow(self, ip: str) -> bool:
        now = self.clock()
        cut = now - self.window_s
        k = iphash(ip)
        with self._lock:
            while self._all and self._all[0] <= cut:
                self._all.popleft()
            for key in list(self._ip):
                dq = self._ip[key]
                while dq and dq[0] <= cut:
                    dq.popleft()
                if not dq:
                    del self._ip[key]
            if len(self._all) >= self.global_limit:
                return False
            dq = self._ip.get(k)
            if dq is not None and len(dq) >= self.per_ip:
                return False
            self._ip.setdefault(k, deque()).append(now)
            self._all.append(now)
            return True


class _Dup(Exception):
    """request_key vừa được ghi song song."""


class _Withdrawn(Exception):
    """SĐT thuộc contact đã RÚT đồng ý b2b — form không xác minh SĐT nên
    không được tự lật lại thành granted."""


def _b2b_withdrawn(conn, contact_id) -> bool:
    row = conn.execute(
        "select granted from v_consent_current where contact_id = %s and"
        " purpose = 'b2b' and coalesce(recipient_dealer, '') = ''",
        (contact_id,)).fetchone()
    return row is not None and row[0] is False


def _existing(conn, key: str):
    row = conn.execute("select id from b2b_requests where request_key = %s",
                       (key,)).fetchone()
    return row[0] if row else None


def intake(conn, form: dict, keys, *, today: date | None = None
           ) -> tuple[int | None, bool]:
    """→ (request_id, mới?). Đã có request_key → id cũ, 0 ghi. Ngược lại
    1 transaction: contact (vault) → consent b2b → b2b_requests → commit.

    Form KHÔNG xác minh SĐT (OTP/double opt-in = external-dep): SĐT trùng
    contact đã RÚT đồng ý b2b → (None, False), rollback, 0 ghi — người lạ
    gõ SĐT người khác không lật được `can_contact(b2b)` về True. Muốn liên
    hệ lại phải qua kênh xác minh của GĐ bán hàng (ghi trong DPIA)."""
    today = today or _vn_today()
    key = request_key(form, today)
    rid = _existing(conn, key)
    if rid is not None:
        conn.commit()
        return rid, False
    c = form["contact"]
    try:
        with conn.transaction():
            cid, new = crm.add_contact(
                conn, {"phone": c["phone"], "name": c["name"],
                       "email": c.get("email"), "province": form["region"],
                       "source": SOURCE}, keys, BY)
            if not new and _b2b_withdrawn(conn, cid):
                raise _Withdrawn
            consent_id = crm.record_consent(
                conn, cid, "b2b", True, "web", BY,
                evidence_ref="B2BF-" + key[4:20].translate(_EV_TR),
                policy_version=POLICY_VERSION)
            row = conn.execute(
                "insert into b2b_requests (request_key, org_name, org_type,"
                " region, items, need_by, contact_id, consent_id, source)"
                " values (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)"
                " on conflict (request_key) do nothing returning id",
                (key, form["org_name"], form["org_type"], form["region"],
                 json.dumps(form["items"], ensure_ascii=False),
                 form["need_by"], cid, consent_id, SOURCE)).fetchone()
            if row is None:
                raise _Dup
    except _Dup:
        rid = _existing(conn, key)
        conn.commit()
        return rid, False
    except _Withdrawn:
        conn.commit()
        return None, False
    conn.commit()
    return row[0], True


# ---------------------------------------------------------------- server
class FormServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, *, page: str, allowed, keys, connect_fn,
                 limiter: RateLimiter, today_fn=_vn_today, intake_fn=None):
        super().__init__(addr, Handler)
        self.page = page.encode("utf-8")
        self.allowed = frozenset(allowed)
        self.keys = keys
        self.connect_fn = connect_fn
        self.limiter = limiter
        self.today_fn = today_fn
        self.intake_fn = intake_fn or intake

    def handle_error(self, request, client_address) -> None:
        """Thay bản mặc định (in IP thô + traceback ra stderr): client RST
        giữa body / lỗi bất ngờ trong intake → chỉ hash IP + tên lớp lỗi."""
        exc = sys.exc_info()[1]
        print(f"[b2b_form] lỗi kết nối ip={iphash(client_address[0])[:8]} "
              f"{type(exc).__name__}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    timeout = 10                 # chặn client treo giữa chừng (slowloris)
    server_version = "b2b-form"
    sys_version = ""

    def _send(self, code: int, body: str, close: bool = False) -> None:
        b = body.encode("utf-8")
        if close:
            self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; style-src 'unsafe-inline'; "
                         "form-action 'self'; frame-ancestors 'none'")
        if close:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b)
        self.wfile.flush()

    def _log(self, code: int, yc=None) -> None:
        print(f"[b2b_form] {code} ip={iphash(self.client_address[0])[:8]} "
              f"yc={yc if yc is not None else '-'}", flush=True)

    def _err(self, code: int, close: bool = False) -> None:
        self._log(code)
        self._send(code, PAGE_ERR.format(msg=MSG[code]), close)

    def do_GET(self) -> None:
        te = (self.headers.get("Transfer-Encoding") or "").lower()
        if te or (self.headers.get("Content-Length") or "0") != "0":
            self.close_connection = True    # không đọc body GET
        if urlsplit(self.path).path != PATH:
            return self._err(404)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.server.page)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; style-src 'unsafe-inline'; "
                         "form-action 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(self.server.page)

    def do_POST(self) -> None:
        srv = self.server
        if urlsplit(self.path).path != PATH:
            return self._err(404, close=True)
        if self.headers.get("Transfer-Encoding"):
            return self._err(411, close=True)
        cl = self.headers.get("Content-Length")
        if cl is None:
            return self._err(411, close=True)
        if not re.fullmatch(r"[0-9]{1,9}", cl.strip()):
            return self._err(400, close=True)
        length = int(cl)
        if length > MAX_FORM_BYTES:
            return self._err(413, close=True)
        if self.headers.get_content_type() != FORM_CT:
            return self._err(415, close=True)
        if not srv.limiter.allow(self.client_address[0]):
            return self._err(429, close=True)
        body = self.rfile.read(length)
        if len(body) != length:
            return self._err(400, close=True)
        form, code = parse_form(body, srv.allowed, srv.today_fn())
        if code == "spam":
            self._log(200)
            return self._send(200, PAGE_OK)
        if form is None:
            return self._err(400)
        conn = srv.connect_fn()
        if conn is None:
            return self._err(503)
        try:
            rid, _ = srv.intake_fn(conn, form, srv.keys,
                                   today=srv.today_fn())
        except ValueError:
            return self._err(400)
        except (psycopg.Error, crm.VaultKeyError):
            return self._err(503)
        finally:
            with contextlib.suppress(Exception):   # đóng conn không làm sập
                conn.close()
        self._log(200, rid)
        # Trang công khai KHÔNG hiện mã YC: nhận mới / gửi lại / SĐT đã rút
        # đồng ý (rid None) / spam đều cùng 1 body — không thành oracle dò
        # "SĐT X là contact đã rút b2b", không lộ id tuần tự (lưu lượng YC).
        # Mã YC chỉ ở log nội bộ + CLI GĐ (`kd_quote --requests`).
        self._send(200, PAGE_OK)

    def log_message(self, fmt: str, *args) -> None:
        pass  # không in path/IP thô — _log chỉ in hash


def make_server(host: str, port: int, *, page: str, allowed, keys,
                connect_fn=connect, limiter: RateLimiter | None = None,
                today_fn=_vn_today, intake_fn=None) -> FormServer:
    return FormServer((host, port), page=page, allowed=allowed, keys=keys,
                      connect_fn=connect_fn,
                      limiter=limiter or RateLimiter(), today_fn=today_fn,
                      intake_fn=intake_fn)


def _enabled() -> bool:
    return (os.environ.get("B2B_FORM_ENABLED") or "").strip().lower() in (
        "1", "true", "yes")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m connectors.b2b_form",
        description="Form B2B yêu cầu báo giá quà Tết — mặc định TẮT "
                    "(B2B_FORM_ENABLED=1)")
    ap.parse_args(argv)
    if not _enabled():
        print("[fatal] form B2B mặc định TẮT — đặt B2B_FORM_ENABLED=1 trong "
              "env tiến trình (chỉ sau khi DPIA luồng form được ký)",
              file=sys.stderr)
        return 2
    load_dotenv(ROOT / ".env")
    try:
        keys = crm.load_vault_key()
    except crm.VaultKeyError as e:
        print(f"[fatal] {e}", file=sys.stderr)
        return 2
    host = (os.environ.get("B2B_FORM_HOST") or "127.0.0.1").strip()
    raw_port = (os.environ.get("B2B_FORM_PORT") or str(DEFAULT_PORT)).strip()
    if not re.fullmatch(r"[0-9]{1,5}", raw_port) or not \
            1 <= int(raw_port) <= 65535:
        print("[fatal] B2B_FORM_PORT phải 1..65535", file=sys.stderr)
        return 2
    golden, why = read_golden(GOLDEN_FILE)
    if golden is None:
        print(f"[fatal] {why}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[fatal] không kết nối được Postgres (DATABASE_URL thiếu hoặc "
              "host chết)", file=sys.stderr)
        return 2
    try:
        from pipelines.production import db_combos
        combos = db_combos(conn)
    except psycopg.Error:
        print("[fatal] không đọc được bom_combos", file=sys.stderr)
        return 2
    finally:
        with contextlib.suppress(Exception):
            conn.close()
    opts = options(golden, combos)
    srv = make_server(host, int(raw_port), page=render_page(opts),
                      allowed=[k for k, _ in opts], keys=keys)
    print(f"[b2b_form] nghe {host}:{raw_port}{PATH} · {len(opts)} sản phẩm ·"
          f" tối đa {MAX_FORM_BYTES} byte · rate-limit 5/IP/giờ, 60/giờ",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
