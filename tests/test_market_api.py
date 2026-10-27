"""v10.3 W103.1/W103.2 — `ingest.market_api` (connector API sàn CHỈ ĐỌC).

Mạng: server giả `http.server` bind 127.0.0.1:0 trong thread, ĐẾM request —
không gọi sàn thật, không assert wall-clock. DB: fixture `db` của
`tests/test_market_csv.py` (schema tạm + golden, ROLLBACK cuối test). Dữ
liệu response là TỔNG HỢP, chuỗi PII giả rõ ràng ("NGUOI MUA GIA",
"0900000000", "DIA CHI GIA 1").
"""

import ast
import hashlib
import hmac
import json
import re
import threading
import urllib.parse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from ingest import market_api as ma
from ingest import market_csv as mc
from tests import test_market_csv as tmc

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ingest" / "market_api.py"
_TxConn = tmc._TxConn
db = tmc.db   # fixture DB thật dùng chung (schema tạm + golden, rollback)

CREDS = {
    "SHOPEE_PARTNER_ID": "1000001", "SHOPEE_PARTNER_KEY": "SPKEY_SECRET_XYZ",
    "SHOPEE_SHOP_ID": "2000002", "SHOPEE_ACCESS_TOKEN": "SPTOKEN_SECRET_ABC",
    "TIKTOK_APP_KEY": "ttappkey01", "TIKTOK_APP_SECRET": "TTSECRET_SECRET_QQ",
    "TIKTOK_SHOP_CIPHER": "ROW_cipher01",
    "TIKTOK_ACCESS_TOKEN": "TTTOKEN_SECRET_WW"}
PII = ("NGUOI MUA GIA", "0900000000", "DIA CHI GIA 1", "nguoimuagia",
       "buyer@gia.example")
PII_RE = "NGUOI MUA GIA|0900000000|DIA CHI GIA|nguoimuagia|FAKEORDER"


# ---------------------------------------------------------------- server giả

class _Server:
    """HTTP server giả: route(method, path, query, body) → (status, obj|bytes,
    headers). Ghi mọi request (method, path, query, headers, body)."""

    def __init__(self, route):
        self.route = route
        self.requests = []
        srv = self

        class H(BaseHTTPRequestHandler):
            def _any(self):
                u = urllib.parse.urlsplit(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode("utf-8") if n else ""
                q = urllib.parse.parse_qs(u.query, keep_blank_values=True)
                srv.requests.append({"method": self.command, "path": u.path,
                                     "query": q, "raw_url": self.path,
                                     "headers": {k.lower(): v for k, v in self.headers.items()},
                                     "body": body})
                status, payload, hdrs = srv.route(self.command, u.path, q,
                                                  body)
                data = (payload if isinstance(payload, bytes)
                        else json.dumps(payload).encode())
                self.send_response(status)
                for k, v in (hdrs or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_DELETE = do_PUT = _any

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def servers():
    made = []

    def make(route=None):
        s = _Server(route or (lambda *a: (200, {"error": "", "code": 0,
                                               "response": {}, "data": {}},
                                          None)))
        made.append(s)
        return s
    yield make
    for s in made:
        s.close()


def _sp_ok(resp):
    return 200, {"error": "", "message": "", "response": resp}, None


def _tt_ok(data):
    return 200, {"code": 0, "message": "Success", "data": data}, None


# ---------------------------------------------------------------- (1) scope

@pytest.mark.parametrize("ch,method,path", [
    ("shopee", "POST", "/api/v2/product/update_price"),
    ("shopee", "GET", "/api/v2/product/update_item"),
    ("tiktok", "POST", "/product/202309/products/123/prices/update"),
    ("shopee", "DELETE", "/api/v2/product/get_item_list"),
    ("shopee", "POST", "/api/v2/product/get_item_list"),
    ("tiktok", "GET", "/order/202309/orders/search"),
    ("lazada", "GET", "/api/v2/product/get_item_list"),
])
def test_scope_denied_before_any_request(servers, ch, method, path):
    s = servers()
    with pytest.raises(ma.ScopeError) as e:
        ma._request(ch, method, path, {"price": 1}, {"x": 1}, creds=CREDS,
                    base=s.url)
    assert "allowlist" in str(e.value)
    assert s.requests == []


def test_scope_checked_before_creds_and_base(monkeypatch):
    # ngoài allowlist → ScopeError kể cả khi thiếu key/base sai (kiểm ĐẦU)
    for k in CREDS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SHOPEE_API_BASE", "http://evil.example")
    with pytest.raises(ma.ScopeError):
        ma._request("shopee", "POST", "/api/v2/product/update_price", {})


_WRITE_RE = re.compile(r"(?i)update|add|delete|create|cancel|ship|set_|edit|"
                       r"reply|unlist|boost|split|handle|upload")


def test_ast_every_endpoint_literal_in_allowlist():
    tree = ast.parse(SRC.read_text(encoding="utf-8"))
    paths = {p for _c, _m, p in ma.ALLOWED}
    auth = {p for _c, _m, p in ma.AUTH_ALLOWED}   # r14: 2 endpoint refresh token
    assert len(ma.AUTH_ALLOWED) == 2 and all("token" in p for p in auth)
    paths |= auth
    lits = [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and n.value.startswith(("/api/v2/", "/product/", "/order/",
                                    "/finance/"))]
    assert len(lits) >= 11
    assert set(lits) <= paths, set(lits) - paths
    assert not [p for p in paths - auth if _WRITE_RE.search(p)]
    # r15: +2 Shopee escrow (GET) + 2 TikTok finance (GET) — quyết toán chỉ đọc
    assert len(ma.ALLOWED) == 11
    assert {m for _c, m, _p in ma.ALLOWED} == {"GET", "POST"}
    assert all(m == "GET" for c, m, _p in ma.ALLOWED if c == "shopee")
    assert all((m == "POST" and p.endswith("/search"))
               or (m == "GET" and p.startswith("/finance/"))
               for c, m, p in ma.ALLOWED if c == "tiktok")


def test_no_third_party_http_client():
    src = SRC.read_text(encoding="utf-8")
    assert not re.search(r"(?m)^(import|from) +(httpx|requests)", src)


# ---------------------------------------------------------------- (3) ký

def test_sign_vectors_independent():
    exp = hmac.new(b"key123", b"1000001/api/v2/shop/get_shop_info1700000000"
                   b"tok2000002", hashlib.sha256).hexdigest()
    assert ma.sign_shopee("key123", "1000001", "/api/v2/shop/get_shop_info",
                          1700000000, "tok", "2000002") == exp
    q = {"timestamp": "1700000000", "app_key": "ak", "shop_cipher": "c1",
         "sign": "IGNORED", "access_token": "IGNORED", "page_size": "10"}
    base = ("sec" + "/order/202309/orders/search" + "app_keyak"
            + "page_size10" + "shop_cipherc1" + "timestamp1700000000"
            + '{"a":1}' + "sec")
    exp = hmac.new(b"sec", base.encode(), hashlib.sha256).hexdigest()
    assert ma.sign_tiktok("sec", "/order/202309/orders/search", q,
                          '{"a":1}') == exp


def _secrets_absent(req):
    blob = req["raw_url"] + json.dumps(req["headers"]) + req["body"]
    return ("SPKEY_SECRET_XYZ" not in blob and "TTSECRET_SECRET_QQ"
            not in blob)


def test_server_receives_valid_signature_without_secret(servers):
    s = servers(lambda m, p, q, b: _sp_ok({"item": [],
                                           "has_next_page": False}))
    ma._request("shopee", "GET", ma.SP_ITEM_LIST, {"offset": 0},
                creds=CREDS, base=s.url, timestamp=1700000000)
    (r,) = s.requests
    q = {k: v[0] for k, v in r["query"].items()}
    assert q["sign"] == ma.sign_shopee(
        CREDS["SHOPEE_PARTNER_KEY"], q["partner_id"], r["path"],
        int(q["timestamp"]), q["access_token"], q["shop_id"])
    assert q["timestamp"] == "1700000000" and _secrets_absent(r)

    t = servers(lambda m, p, q, b: _tt_ok({"products": []}))
    ma._request("tiktok", "POST", ma.TT_PRODUCT_SEARCH, {"page_size": 5},
                {"status": "ALL"}, creds=CREDS, base=t.url)
    (r,) = t.requests
    q = {k: v[0] for k, v in r["query"].items()}
    assert q["sign"] == ma.sign_tiktok(CREDS["TIKTOK_APP_SECRET"], r["path"],
                                       q, r["body"])
    assert r["headers"].get("x-tts-access-token") == "TTTOKEN_SECRET_WW"
    assert "TTTOKEN_SECRET_WW" not in r["raw_url"]
    assert r["method"] == "POST" and _secrets_absent(r)


# ---------------------------------------------------------------- (4) HTTP

def test_redirect_not_followed(servers):
    target = servers()
    src = servers(lambda m, p, q, b: (302, b"", {"Location": target.url
                                                 + "/steal"}))
    with pytest.raises(ma.ApiError) as e:
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=CREDS,
                    base=src.url)
    assert "HTTP 302" in str(e.value)
    assert len(src.requests) == 1 and target.requests == []
    assert "SPTOKEN" not in str(e.value)


@pytest.mark.parametrize("status,payload", [
    (200, b'{"error": "", "response": {"pad": "' + b"B" * 400 + b'"}}'),
    (200, b'{"error": "", "response": BODYMARK'),
    (200, b'{"error": "error_auth", "message": "BODYMARK leak"}'),
    (500, b'{"error": "BODYMARK"}'),
    (200, b'["BODYMARK"]'),
])
def test_api_errors_never_echo_body(servers, monkeypatch, status, payload):
    monkeypatch.setattr(ma, "MAX_RESP_BYTES", 200)
    s = servers(lambda m, p, q, b: (status, payload, None))
    with pytest.raises(ma.ApiError) as e:
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=CREDS,
                    base=s.url)
    msg = str(e.value)
    assert "BODYMARK" not in msg and "BBBB" not in msg
    assert "SPTOKEN" not in msg and "access_token" not in msg


def test_deeply_nested_json_is_api_error(servers):
    s = servers(lambda m, p, q, b: (200, b"[" * 100000 + b"]" * 100000,
                                    None))
    with pytest.raises(ma.ApiError) as e:
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=CREDS,
                    base=s.url)
    assert "JSON" in str(e.value)


def test_tiktok_code_nonzero_is_error(servers):
    s = servers(lambda m, p, q, b: (200, {"code": 105001, "message":
                                          "BODYMARK"}, None))
    with pytest.raises(ma.ApiError) as e:
        ma._request("tiktok", "POST", ma.TT_ORDER_SEARCH, {}, {},
                    creds=CREDS, base=s.url)
    assert "105001" in str(e.value) and "BODYMARK" not in str(e.value)


@pytest.mark.parametrize("base", [
    "http://evil.example", "ftp://127.0.0.1", "http://127.0.0.1.evil.example",
    "https://user:pw@partner.shopeemobile.com", "https://h/api", "https://",
    "http://localhost:99999", "https://h?x=1"])
def test_bad_base_url_config_error_zero_requests(monkeypatch, base):
    monkeypatch.setenv("SHOPEE_API_BASE", base)
    with pytest.raises(ma.ConfigError):
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=CREDS)


def test_base_url_defaults_and_local(monkeypatch):
    monkeypatch.delenv("SHOPEE_API_BASE", raising=False)
    assert ma.api_base("shopee") == "https://partner.shopeemobile.com"
    monkeypatch.setenv("TIKTOK_API_BASE", "http://localhost:8123/")
    assert ma.api_base("tiktok") == "http://localhost:8123"


# ---------------------------------------------------------------- (5)(6) chuẩn hóa

def _sp_order_route(orders):
    """orders: [(order_sn, status, [items])] — response có PII người mua."""
    def route(method, path, q, body):
        if path == ma.SP_ORDER_LIST:
            return _sp_ok({"order_list": [{"order_sn": o[0]} for o in orders],
                           "more": False, "next_cursor": ""})
        if path == ma.SP_ORDER_DETAIL:
            want = q["order_sn_list"][0].split(",")
            assert q["response_optional_fields"] == ["item_list"]
            return _sp_ok({"order_list": [{
                "order_sn": sn, "order_status": st, "item_list": items,
                "buyer_username": "nguoimuagia", "buyer_user_id": 99887766,
                "recipient_address": {"name": "NGUOI MUA GIA",
                                      "phone": "0900000000",
                                      "full_address": "DIA CHI GIA 1"},
                "message_to_seller": "goi 0900000000"}
                for sn, st, items in orders if sn in want]})
        raise AssertionError(path)
    return route


def _call(s, ch):
    return lambda m, p, params, body=None: ma._request(
        ch, m, p, params, body, creds=CREDS, base=s.url)


def _smap():
    return ma.load_status_map()


def test_order_rows_drop_pii_and_hash_like_market_csv(servers, tmp_path):
    item = {"item_id": 24325987926, "item_name": "Savigout 30 viên",
            "item_sku": "", "model_sku": "", "model_quantity_purchased": 2,
            "model_discounted_price": 439000.0}
    s = servers(_sp_order_route([("FAKEORDER123", "CANCELLED", [item]),
                                 ("FAKEORDER456", "COMPLETED", [item, item])]))
    rows = ma.fetch("shopee", "order", _call(s, "shopee"), _smap(), 7,
                    now=1700000000)
    blob = json.dumps(rows, ensure_ascii=False)
    assert len(rows) == 3 and [r["row_no"] for r in rows] == [1, 2, 3]
    for needle in (*PII, "FAKEORDER", "99887766"):
        assert needle not in blob
    assert rows[0]["status"] == "Đã hủy" and rows[1]["status"] == "Hoàn thành"
    assert rows[0]["price"] == 439000 and rows[0]["qty"] == 2
    # hash = đúng hash market_csv cho cùng mã đơn
    p = tmp_path / "o.csv"
    p.write_bytes(("Mã đơn hàng,Trạng thái đơn hàng,Tên sản phẩm,Số lượng,"
                   "Giá ưu đãi,Mã sản phẩm\nFAKEORDER123,Đã hủy,X,1,100000,1\n"
                   ).encode())
    csv_rows, errs, _ = mc.read_export(p, "shopee", "order",
                                       mc.load_mapping()[0])
    assert errs == []
    assert re.fullmatch(r"[0-9a-f]{16}", rows[0]["order_id_hash"])
    assert rows[0]["order_id_hash"] == csv_rows[0]["order_id_hash"]
    assert set(rows[0]) == {"row_no", *mc.FIELDS} - {"order_id"} | {
        "order_id_hash"}
    lst = s.requests[0]
    assert lst["query"]["time_from"] == [str(1700000000 - 7 * 86400)]


def test_tiktok_order_drops_pii(servers):
    def route(m, p, q, b):
        assert p == ma.TT_ORDER_SEARCH and json.loads(b)["create_time_lt"]
        return _tt_ok({"orders": [{
            "id": "FAKEORDER789", "status": "CANCELLED",
            "buyer_email": "buyer@gia.example",
            "recipient_address": {"name": "NGUOI MUA GIA",
                                  "phone_number": "0900000000",
                                  "full_address": "DIA CHI GIA 1"},
            "line_items": [{"product_id": "17300001", "product_name": "Savina",
                            "seller_sku": "savina-12v",
                            "original_price": "159000"}]}],
            "next_page_token": ""})
    s = servers(route)
    rows = ma.fetch("tiktok", "order", _call(s, "tiktok"), _smap(), 3)
    blob = json.dumps(rows, ensure_ascii=False)
    assert len(rows) == 1 and rows[0]["status"] == "Cancelled"
    assert rows[0]["price"] == 159000 and rows[0]["qty"] == 1
    for needle in (*PII, "FAKEORDER"):
        assert needle not in blob


def _sp_listing_route(items, models=None):
    models = models or {}

    def route(method, path, q, body):
        if path == ma.SP_ITEM_LIST:
            assert q["item_status"] == ma.SP_ITEM_STATUSES
            return _sp_ok({"item": [{"item_id": it["item_id"],
                                     "item_status": it["item_status"]}
                                    for it in items],
                           "has_next_page": False, "total_count": len(items)})
        if path == ma.SP_ITEM_INFO:
            want = q["item_id_list"][0].split(",")
            return _sp_ok({"item_list": [it for it in items
                                         if str(it["item_id"]) in want]})
        if path == ma.SP_MODEL_LIST:
            return _sp_ok({"model": models[q["item_id"][0]]})
        raise AssertionError(path)
    return route


def _item(iid, name, price, status="NORMAL", sku="", stock=5, has_model=False):
    return {"item_id": iid, "item_name": name, "item_sku": sku,
            "item_status": status, "has_model": has_model,
            "price_info": [{"current_price": price, "original_price": price}],
            "stock_info_v2": {"summary_info": {"total_available_stock":
                                               stock}}}


@pytest.mark.parametrize("price,ok", [(236000.0, 236000), (236000, 236000),
                                      ("236000", 236000), ("236000.00", 236000),
                                      (236000.5, None), ("236000.5", None),
                                      (-1, None), ("236.000", 236),
                                      ("1.234.567", None), ("1,5", None),
                                      (True, None), (None, None),
                                      (10**16, None)])
def test_price_conversion(servers, price, ok):
    s = servers(_sp_listing_route([_item(1, "A", price)]))
    if ok is None:
        with pytest.raises(ma.DataError) as e:
            ma.fetch("shopee", "listing", _call(s, "shopee"), _smap())
        assert "price" in str(e.value) and str(price) not in str(e.value)
    else:
        (r,) = ma.fetch("shopee", "listing", _call(s, "shopee"), _smap())
        assert r["price"] == ok


def test_listing_models_one_row_each(servers):
    models = {"555": [
        {"model_sku": "saphraton-20v", "price_info": [{"original_price": 299000}],
         "stock_info_v2": {"summary_info": {"total_available_stock": 3}}},
        {"model_sku": "saphraton-40v", "price_info": [{"original_price": 560000}],
         "stock_info_v2": {"summary_info": {"total_available_stock": 1}}}]}
    s = servers(_sp_listing_route([_item(555, "Saphraton", 1, has_model=True),
                                   _item(777, "Lẻ", 100000, status="UNLIST")],
                                  models))
    rows = ma.fetch("shopee", "listing", _call(s, "shopee"), _smap())
    assert [(r["item_id"], r["seller_sku"], r["price"], r["stock"])
            for r in rows] == [("555", "saphraton-20v", 299000, 3),
                               ("555", "saphraton-40v", 560000, 1),
                               ("777", None, 100000, 5)]
    assert rows[2]["status"] == "Đã ẩn"
    assert [r["row_no"] for r in rows] == [1, 2, 3]


def test_tiktok_listing_skus(servers):
    s = servers(lambda m, p, q, b: _tt_ok({"products": [{
        "id": "1730", "title": "Savina", "status": "SELLER_DEACTIVATED",
        "skus": [{"seller_sku": "savina-12v",
                  "price": {"tax_exclusive_price": "159000"},
                  "inventory": [{"quantity": 3}, {"quantity": 4}]}]}],
        "next_page_token": ""}))
    (r,) = ma.fetch("tiktok", "listing", _call(s, "tiktok"), _smap())
    assert (r["item_id"], r["price"], r["stock"], r["status"]) == (
        "1730", 159000, 7, "Deactivated")
    inactive = mc.load_mapping()[0]["tiktok"]["listing"]["inactive_status"]
    assert r["status"] in inactive


def test_max_pages_exceeded_is_error(servers, monkeypatch):
    monkeypatch.setattr(ma, "MAX_PAGES", 3)
    s = servers(lambda m, p, q, b: _sp_ok({"item": [{"item_id": 1}],
                                           "has_next_page": True,
                                           "next_offset": 1}))
    with pytest.raises(ma.ApiError) as e:
        ma.fetch("shopee", "listing", _call(s, "shopee"), _smap())
    assert "MAX_PAGES" in str(e.value) and len(s.requests) == 3


def test_status_map_doc_and_vocab():
    raw = json.loads((ROOT / "data" / "market_api.json").read_text(
        encoding="utf-8"))
    assert "GIẢ ĐỊNH" in raw["_doc"] and "/api/" not in json.dumps(raw)
    m = mc.load_mapping()[0]
    sm = raw["status_map"]
    assert sm["shopee"]["listing"]["UNLIST"] in m["shopee"]["listing"][
        "inactive_status"]
    assert sm["shopee"]["order"]["CANCELLED"] in m["shopee"]["order"][
        "cancel_status"]
    assert sm["tiktok"]["listing"]["SELLER_DEACTIVATED"] in m["tiktok"][
        "listing"]["inactive_status"]
    assert sm["tiktok"]["order"]["CANCELLED"] in m["tiktok"]["order"][
        "cancel_status"]
    # status đang bán KHÔNG được map vào inactive (lệch = mất cảnh báo S1)
    assert sm["shopee"]["listing"]["NORMAL"] not in m["shopee"]["listing"][
        "inactive_status"]
    assert sm["tiktok"]["listing"]["ACTIVATE"] not in m["tiktok"]["listing"][
        "inactive_status"]


# ---------------------------------------------------------------- CLI không DB

@contextmanager
def _fake_job(name):
    yield {"ok": True, "detail": None}


def _cli_env(monkeypatch, base_url=None):
    connects = []

    def boom(dsn):
        connects.append(dsn)
        raise AssertionError("connect không được gọi")
    for k, v in CREDS.items():
        monkeypatch.setenv(k, v)
    if base_url:
        monkeypatch.setenv("SHOPEE_API_BASE", base_url)
        monkeypatch.setenv("TIKTOK_API_BASE", base_url)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(ma, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(ma, "_connect", boom)
    monkeypatch.setattr(ma, "job_run", _fake_job)
    return connects


@pytest.mark.parametrize("var", [k for ks in ma.KEYS.values() for k in ks])
def test_missing_key_exit2_zero_request_no_connect(servers, monkeypatch,
                                                   capsys, var):
    s = servers()
    connects = _cli_env(monkeypatch, s.url)
    monkeypatch.setenv(var, "   " if var.endswith("_ID") else "")
    ch = var.split("_")[0].lower()
    assert ma.main(["--channel", ch, "--kind", "listing"]) == 2
    assert s.requests == [] and connects == []
    out = capsys.readouterr().out
    assert "[external-dep]" in out and var in out
    for v in CREDS.values():
        assert v not in out


@pytest.mark.parametrize("argv", [
    ["--channel", "shopee", "--kind", "ads"],
    ["--channel", "shopee", "--kind", "order", "--days", "0"],
    ["--channel", "shopee", "--kind", "order", "--days", "16"],
    ["--channel", "shopee", "--kind", "listing", "--days", "3"],
    ["--channel", "lazada", "--kind", "listing"],
    ["--channel", "shopee"],
    [],
])
def test_usage_exit2_before_request(servers, monkeypatch, capsys, argv):
    s = servers()
    connects = _cli_env(monkeypatch, s.url)
    with pytest.raises(SystemExit) as e:
        ma.main(argv)
    assert e.value.code == 2 and s.requests == [] and connects == []
    if "ads" in argv:
        assert "ads chỉ qua file" in capsys.readouterr().err


def test_cli_bad_base_exit2(monkeypatch, capsys):
    connects = _cli_env(monkeypatch, "http://evil.example")
    assert ma.main(["--channel", "shopee", "--kind", "listing"]) == 2
    assert connects == [] and "SHOPEE_API_BASE" in capsys.readouterr().out


def test_cli_api_error_exit1_no_connect(servers, monkeypatch, capsys):
    s = servers(lambda m, p, q, b: (200, {"error": "error_auth",
                                          "message": "BODYMARK"}, None))
    connects = _cli_env(monkeypatch, s.url)
    assert ma.main(["--channel", "shopee", "--kind", "listing"]) == 1
    out = capsys.readouterr().out
    assert connects == [] and "error_auth" in out and "BODYMARK" not in out
    assert "SPTOKEN_SECRET_ABC" not in out


# ---------------------------------------------------------------- DB thật

LISTING_ITEMS = [
    _item(27357883504, "Savina tuýp 12 viên ngậm (FIXTURE)", 159000),
    _item(24325987926, "Savigout 30 viên (FIXTURE)", 482900),
    _item(27325048614, "Rượu sâm chai thủy tinh 500ml (FIXTURE)", 745000),
    _item(99900000001, "Sản phẩm lạ không có trong golden (FIXTURE)", 100000),
]


def _db_cli(db, monkeypatch, s, argv):
    proxy = _TxConn(db)
    _cli_env(monkeypatch, s.url)
    monkeypatch.setattr(ma, "_connect", lambda _dsn: proxy)
    return ma.main(argv), proxy.committed


def _open_keys(db):
    return {(k, i or "", s or "") for k, i, s in db.execute(
        "select kind, item_id, seller_sku from market_alerts"
        " where status = 'open'")}


def test_db_listing_alerts_skip_and_close(db, monkeypatch, servers, capsys):
    items = [dict(it) for it in LISTING_ITEMS]
    s = servers(_sp_listing_route(items))
    argv = ["--channel", "shopee", "--kind", "listing"]
    assert _db_cli(db, monkeypatch, s, argv) == (0, 1)
    snaps = db.execute("select id, file_name, row_count from"
                       " market_snapshots").fetchall()
    assert len(snaps) == 1 and snaps[0][1].startswith("api:shopee:listing:")
    assert snaps[0][2] == 4 and db.execute(
        "select count(*) from market_rows where snapshot_id = %s",
        (snaps[0][0],)).fetchone()[0] == 4
    got = _open_keys(db)
    assert {k for k, _i, _s in got} == {"alcohol_listed", "price_mismatch",
                                        "item_unmapped"}
    # CÙNG kết quả find_alerts thuần trên rows API
    rows = ma.fetch("shopee", "listing", _call(s, "shopee"), _smap())
    skus, prices = mc._golden(db, "shopee")
    inactive = mc.load_mapping()[0]["shopee"]["listing"]["inactive_status"]
    assert got == set(mc.find_alerts(rows, "shopee", "listing", skus, prices,
                                     inactive))
    out = capsys.readouterr().out
    assert "[load]" in out and "[alerts]" in out

    counts = [db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("market_snapshots", "market_rows", "market_alerts")]
    assert _db_cli(db, monkeypatch, s, argv) == (0, 0)
    assert "[skip] dữ liệu không đổi" in capsys.readouterr().out
    assert [db.execute(f"select count(*) from {t}").fetchone()[0]
            for t in ("market_snapshots", "market_rows",
                      "market_alerts")] == counts

    items[2]["item_status"] = "UNLIST"
    assert _db_cli(db, monkeypatch, s, argv) == (0, 1)
    st = dict(db.execute("select kind, status from market_alerts"
                         " where kind = 'alcohol_listed'"))
    assert st == {"alcohol_listed": "closed"}
    assert {k for k, _i, _s in _open_keys(db)} == {"price_mismatch",
                                                   "item_unmapped"}


def test_db_order_no_pii_and_report_cancel(db, monkeypatch, servers, capsys):
    item = {"item_id": 24325987926, "item_name": "Savigout 30 viên",
            "item_sku": "savigout-30v", "model_sku": "",
            "model_quantity_purchased": 1, "model_discounted_price": 439000}
    s = servers(_sp_order_route([("FAKEORDER1", "CANCELLED", [item]),
                                 ("FAKEORDER2", "COMPLETED", [item])]))
    argv = ["--channel", "shopee", "--kind", "order", "--days", "3"]
    assert _db_cli(db, monkeypatch, s, argv) == (0, 1)
    assert db.execute("select count(*), count(order_id_hash) from"
                      " market_rows").fetchone() == (2, 2)
    assert db.execute("select count(*) from market_rows r where r::text ~* %s"
                      " or raw::text ~* %s", (PII_RE, PII_RE)).fetchone()[0] == 0
    assert db.execute("select count(*) from market_snapshots s where"
                      " s::text ~* %s", (PII_RE,)).fetchone()[0] == 0
    assert db.execute("select count(*) from market_alerts").fetchone()[0] == 0
    out = capsys.readouterr().out
    assert not re.search(PII_RE, out)
    # báo cáo v3.3 tách đơn hủy (status map CANCELLED → 'Đã hủy')
    proxy = _TxConn(db)
    monkeypatch.setattr(mc, "_connect", lambda _dsn: proxy)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    assert mc.main(["--report"]) == 0
    rep = capsys.readouterr().out
    assert "shopee đơn: hủy=1 đơn" in rep and "Đã hủy=1" in rep
    assert not re.search(PII_RE, rep)
