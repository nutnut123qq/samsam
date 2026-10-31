"""v8.2 KD-A3 — form B2B nhận yêu cầu báo giá (endpoint mặc định TẮT) +
schema `b2b_requests` / consent mục đích `b2b`.

parse_form THUẦN; RateLimiter đồng hồ tiêm (không wall-clock); server
thread port 0 — request bị từ chối sớm dùng raw socket (precedent
`test_chunked_post_rejected_411`); DB thật: schema tạm + ROLLBACK, khóa
Fernet sinh trong test. Người/SĐT/email là GIẢ LẬP.
"""

import http.client
import re
import socket
import struct
import threading
from datetime import date
from pathlib import Path
from urllib.parse import urlencode

import psycopg
import pytest
from cryptography.fernet import Fernet

from agents import da_b2b
from connectors import b2b_form as bf
from ingest import crm
from pipelines import kb_filter
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
DAY = date(2026, 10, 12)
H1 = "mat-ong-sam-120ml-1hu"
ALLOWED = {H1: "Mật ong sâm 120ml (1 hũ)", "mat-ong-sam-300ml": "Mật ong"}
PHONE = "0901234567"
CNAME = "Nguoi Lien He Mau"
EMAIL = "lienhe.mau@example.com"
BASE = {"org_name": "Công ty MẪU B2B", "org_type": "doanh_nghiep",
        "region": "Đà Nẵng", "contact_name": CNAME, "phone": PHONE,
        "email": EMAIL, "sku1": H1, "qty1": "20", "need_by": "2026-12-20",
        "consent": "b2b", "policy_version": bf.POLICY_VERSION,
        "website": ""}


def _body(**kw) -> bytes:
    d = {**BASE, **kw}
    return urlencode({k: v for k, v in d.items() if v is not None}).encode()


# ------------------------------------------------------------ parse_form
def test_parse_ok():
    f, code = bf.parse_form(_body(), ALLOWED, DAY)
    assert code == "ok"
    assert f["org_name"] == "Công ty MẪU B2B" and f["region"] == "Đà Nẵng"
    assert f["contact"] == {"name": CNAME, "phone": PHONE, "email": EMAIL}
    assert f["items"] == [{"key": H1, "qty": 20}]
    assert f["need_by"] == date(2026, 12, 20)
    f, code = bf.parse_form(_body(email="", need_by="", sku2="mat-ong-sam-"
                                  "300ml", qty2="5"), ALLOWED, DAY)
    assert code == "ok" and f["contact"]["email"] is None \
        and f["need_by"] is None and len(f["items"]) == 2


_BAD = {
    "thieu-dong-y": (_body(consent=None), "thieu_dong_y"),
    "policy-khac": (_body(policy_version="v9"), "thieu_dong_y"),
    "honeypot": (_body(website="http://spam.example"), "spam"),
    "key-ruou": (_body(sku1="ruou-sam-chai-thuy-tinh-500ml"),
                 "ma_khong_hop_le"),
    "key-la": (_body(sku1="khong-co"), "ma_khong_hop_le"),
    "qty-0": (_body(qty1="0"), "so_luong"),
    "qty-1e3": (_body(qty1="1e3"), "so_luong"),
    "qty-100001": (_body(qty1="100001"), "so_luong"),
    "qty-am": (_body(qty1="-5"), "so_luong"),
    "11-dong": (_body(sku11=H1, qty11="1"), "so_dong"),
    "0-dong": (_body(sku1="", qty1=""), "so_dong"),
    "dong-trung": (_body(sku2=H1, qty2="3"), "dong_trung"),
    "field-lap": (_body() + b"&org_name=X", "truong_lap"),
    "field-la": (_body(admin="1"), "truong_la"),
    "tinh-la": (_body(region="Xứ Thần Tiên"), "tinh"),
    "tinh-mo-ho": (_body(region="Đà Nẵng và Hà Nội"), "tinh"),
    "sdt-sai": (_body(phone="0905-12x-98765"), "sdt"),
    "sdt-00": (_body(phone="00905123456"), "sdt"),
    "email-sai": (_body(email="khong-phai-email"), "email"),
    "ten-to-chuc-co-sdt": (_body(org_name="Công ty 0905123456"),
                           "ten_to_chuc"),
    "ten-to-chuc-1-ky-tu": (_body(org_name="Q"), "ten_to_chuc"),
    "ten-to-chuc-201": (_body(org_name="A" * 201), "ten_to_chuc"),
    "loai-la": (_body(org_type="ca_nhan"), "loai_to_chuc"),
    "ten-lien-he-email": (_body(contact_name="a@b.example.com"),
                          "ten_lien_he"),
    "need-by-qua-khu": (_body(need_by="2026-10-11"), "ngay_can"),
    "need-by-xa": (_body(need_by="2027-10-13"), "ngay_can"),
    "need-by-sai": (_body(need_by="20/12/2026"), "ngay_can"),
    "khong-utf8": (b"org_name=%FF&" + _body(), "khong_utf8"),
    "byte-thuong-khong-utf8": (b"\xff\xfe=1", "khong_utf8"),
    "qua-nhieu-field": (b"&".join(b"x%d=1" % i for i in range(60)),
                        "qua_nhieu_truong"),
}


@pytest.mark.parametrize("name", sorted(_BAD))
def test_parse_rejects(name):
    body, code = _BAD[name]
    f, got = bf.parse_form(body, ALLOWED, DAY)
    assert (f, got) == (None, code), name


def test_org_types_match_da_b2b_and_form_html():
    assert set(bf.ORG_TYPES) == set(da_b2b.ORG_TYPES)
    html = bf.FORM_FILE.read_text(encoding="utf-8")
    assert set(re.findall(r'<option value="([a-z_]+)">', html)) == set(
        da_b2b.ORG_TYPES)
    assert html.count("<!--OPTIONS-->") == 10
    assert f'value="{bf.POLICY_VERSION}"' in html
    assert "<script" not in html.lower()
    assert not re.search(r"(?i)(src|href)=\"(https?:|//)", html)
    assert 'name="website"' in html and "hidden" in html


def test_request_key_stable_and_normalized():
    f, _ = bf.parse_form(_body(), ALLOWED, DAY)
    k = bf.request_key(f, DAY)
    assert re.fullmatch(r"b2r:[0-9a-f]{64}", k)
    g, _ = bf.parse_form(_body(org_name="CÔNG TY  mẫu-b2b"), ALLOWED, DAY)
    assert bf.request_key(g, DAY) == k
    assert bf.request_key(f, date(2026, 10, 13)) != k


# ------------------------------------------------------------ rate limit
def test_rate_limiter_fake_clock():
    t = [0.0]
    rl = bf.RateLimiter(per_ip=5, global_limit=7, window_s=3600,
                        clock=lambda: t[0])
    assert all(rl.allow("1.2.3.4") for _ in range(5))
    assert rl.allow("1.2.3.4") is False            # lượt 6 cùng IP
    assert rl.allow("5.6.7.8") is True             # IP khác
    assert rl.allow("9.9.9.9") is True             # 7 = trần global
    assert rl.allow("8.8.8.8") is False            # vượt trần global
    t[0] = 3600.5                                   # hết cửa sổ
    assert rl.allow("1.2.3.4") is True and rl.allow("8.8.8.8") is True
    assert all(len(k) == 16 for k in rl._ip)       # khóa băm, không IP
    assert "1.2.3.4" not in rl._ip


def test_iphash_salted_not_plain_sha256():
    import hashlib
    h = bf.iphash("1.2.3.4")
    assert h == bf.iphash("1.2.3.4") and h != bf.iphash("1.2.3.5")
    assert h != hashlib.sha256(b"1.2.3.4").hexdigest()[:16]
    assert len(bf._IP_SALT) == 16


# ------------------------------------------------------------ server
class _Srv:
    def __init__(self, **kw):
        page = bf.render_page(list(ALLOWED.items()))
        kw.setdefault("keys", None)
        kw.setdefault("connect_fn", lambda: None)
        kw.setdefault("today_fn", lambda: DAY)
        self.srv = bf.make_server("127.0.0.1", 0, page=page,
                                  allowed=list(ALLOWED), **kw)
        self.port = self.srv.server_address[1]
        self.th = threading.Thread(target=self.srv.serve_forever,
                                   daemon=True)
        self.th.start()

    def req(self, method, path="/b2b", body=None, ctype=bf.FORM_CT):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            hdr = {"Content-Type": ctype} if body is not None else {}
            c.request(method, path, body=body, headers=hdr)
            r = c.getresponse()
            return r.status, r.read().decode("utf-8")
        finally:
            c.close()

    def raw(self, data: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", self.port),
                                      timeout=10) as s:
            s.sendall(data)
            resp = b""
            while b"\r\n\r\n" not in resp:
                chunk = s.recv(4096)
                if not chunk:
                    break
                resp += chunk
        return resp

    def early(self, path="/b2b", ctype=bf.FORM_CT) -> int:
        """POST bị từ chối TRƯỚC khi đọc body: CHỈ gửi header — body gửi kèm
        nằm chưa đọc lúc server đóng → RST, client mất phản hồi (10053)."""
        resp = self.raw(f"POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: "
                        f"{ctype}\r\nContent-Length: {len(_body())}\r\n\r\n"
                        .encode())
        return int(resp.split(b" ", 2)[1])

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.th.join(timeout=10)


@pytest.fixture
def stub():
    calls = []

    def intake(conn, form, keys, today=None):
        calls.append(form)
        return 41, True

    s = _Srv(intake_fn=intake, connect_fn=lambda: TxConnStub())
    s.calls = calls
    yield s
    s.close()


class TxConnStub:
    def close(self):
        pass


def test_get_page_no_alcohol(stub):
    st, body = stub.req("GET")
    assert st == 200 and 'value="mat-ong-sam-120ml-1hu"' in body
    assert not kb_filter.is_alcohol(body) and "rượu" not in body.lower()
    assert "<!--OPTIONS-->" not in body
    assert stub.req("GET", "/khac")[0] == 404


def test_real_options_same_as_catalog():
    import json

    from agents import kd_catalog
    from ingest.golden_store import GOLDEN_FILE, read_golden
    golden, _ = read_golden(GOLDEN_FILE)
    combos = json.loads((ROOT / "data" / "sample_bom.json").read_bytes()
                        )["combos"]
    opts = bf.options(golden, combos)
    items, _ = kd_catalog.eligible(golden, combos)
    assert [k for k, _ in opts] == [i["key"] for i in items]
    assert [k for k, _ in opts] == ["mat-ong-sam-120ml-1hu",
                                    "mat-ong-sam-120ml-2hu",
                                    "mat-ong-sam-300ml"]
    page = bf.render_page(opts + [("x\"><b", "<script>alert(1)</script>")])
    assert "<script>alert" not in page and "&lt;script&gt;" in page
    assert not kb_filter.is_alcohol(bf.render_page(opts))


def test_post_too_large_413_no_body_read(stub):
    big = b"a=" + b"x" * 9000
    resp = stub.raw(b"POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: "
                    b"application/x-www-form-urlencoded\r\nContent-Length: "
                    + str(len(big)).encode() + b"\r\n\r\n")
    assert b" 413 " in resp.split(b"\r\n")[0]
    assert stub.calls == []


def test_post_chunked_411(stub):
    resp = stub.raw(b"POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: "
                    b"application/x-www-form-urlencoded\r\n"
                    b"Transfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n")
    assert b" 411 " in resp.split(b"\r\n")[0] and stub.calls == []


def test_post_missing_length_411(stub):
    resp = stub.raw(b"POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: "
                    b"application/x-www-form-urlencoded\r\n\r\n")
    assert b" 411 " in resp.split(b"\r\n")[0] and stub.calls == []


def test_post_wrong_type_415_and_429(stub):
    assert stub.early(ctype="text/plain") == 415 and stub.calls == []
    for i in range(5):
        st, body = stub.req("POST", body=_body())
        assert st == 200 and body == bf.PAGE_OK and "YC-" not in body, i
    assert stub.early() == 429 and len(stub.calls) == 5


def test_post_bad_input_400_no_echo(stub):
    st, body = stub.req("POST", body=_body(org_name="Công ty <b>BIMAT</b>",
                                           phone="12"))
    assert st == 400 and "BIMAT" not in body and stub.calls == []
    assert stub.early("/khac") == 404


def test_post_honeypot_200_no_intake(stub):
    st, body = stub.req("POST", body=_body(website="x"))
    assert st == 200 and body == bf.PAGE_OK and stub.calls == []


def test_post_db_down_503():
    s = _Srv(connect_fn=lambda: None,
             intake_fn=lambda *a, **k: pytest.fail("intake"))
    try:
        assert s.req("POST", body=_body())[0] == 503
    finally:
        s.close()


def test_post_vault_error_503():
    def boom(conn, form, keys, today=None):
        raise psycopg.OperationalError("down")

    s = _Srv(connect_fn=lambda: TxConnStub(), intake_fn=boom)
    try:
        assert s.req("POST", body=_body())[0] == 503
    finally:
        s.close()


# ------------------------------------------------------------ main
def test_main_disabled_exit2_no_bind(monkeypatch, capsys):
    monkeypatch.delenv("B2B_FORM_ENABLED", raising=False)
    monkeypatch.setattr(bf, "make_server", lambda *a, **k: pytest.fail("bind"))
    monkeypatch.setattr(bf.ThreadingHTTPServer, "__init__",
                        lambda *a, **k: pytest.fail("bind"))
    assert bf.main([]) == 2
    assert "mặc định TẮT" in capsys.readouterr().err
    monkeypatch.setenv("B2B_FORM_ENABLED", "0")
    assert bf.main([]) == 2


def test_main_no_vault_key_exit2(monkeypatch, capsys):
    monkeypatch.setenv("B2B_FORM_ENABLED", "1")
    monkeypatch.setattr(bf, "load_dotenv", lambda *a, **k: None)
    monkeypatch.delenv("CONTACT_VAULT_KEY", raising=False)
    monkeypatch.setattr(bf, "make_server", lambda *a, **k: pytest.fail("bind"))
    monkeypatch.setattr(bf, "connect", lambda: pytest.fail("connect"))
    assert bf.main([]) == 2
    assert "CONTACT_VAULT_KEY" in capsys.readouterr().err


def test_main_bad_port_exit2(monkeypatch):
    monkeypatch.setenv("B2B_FORM_ENABLED", "yes")
    monkeypatch.setattr(bf, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("CONTACT_VAULT_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("B2B_FORM_PORT", "99999")
    monkeypatch.setattr(bf, "make_server", lambda *a, **k: pytest.fail("bind"))
    assert bf.main([]) == 2


# ------------------------------------------------------------ DB thật
@pytest.fixture
def db():
    yield from da_db()


@pytest.fixture
def keys():
    return crm.load_vault_key({"CONTACT_VAULT_KEY":
                               Fernet.generate_key().decode()})


def _raises(db, sql, params=()):
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute(sql, params)


def _contact(db, keys):
    cid, _ = crm.add_contact(db, {"phone": PHONE, "name": CNAME,
                                  "source": "test"}, keys, "test")
    con = crm.record_consent(db, cid, "b2b", True, "web", "test",
                             evidence_ref="B2BF-test", policy_version="v0")
    return cid, con


_INS = ("insert into b2b_requests (request_key, org_name, org_type, region,"
        " items, contact_id, consent_id, source) values (%s, %s, %s, %s,"
        " %s::jsonb, %s, %s, 'test') returning id")


def test_schema_b2b_requests_and_consent_purpose(db, keys):
    cid, con = _contact(db, keys)
    ok = ("b2r:" + "a" * 64, "Công ty MẪU", "doanh_nghiep", "Đà Nẵng",
          '[{"key": "x", "qty": 1}]', cid, con)
    rid = db.execute(_INS, ok).fetchone()[0]
    for bad in (("b2r:xyz",) + ok[1:],
                ("b2r:" + "b" * 64, "Công ty", "ca_nhan") + ok[3:],
                ("b2r:" + "c" * 64,) + ok[1:4] + ("{}",) + ok[5:],
                ("b2r:" + "d" * 64,) + ok[1:4] + ("[" + ",".join(
                    ['{"key": "x", "qty": 1}'] * 11) + "]",) + ok[5:],
                ("b2r:" + "e" * 64,) + ok[1:4] + ("[]",) + ok[5:],
                ("b2r:" + "f" * 64, " Q ") + ok[2:],
                ("b2r:" + "1" * 64,) + ok[1:5] + (999999999, con),
                ok):                                   # trùng request_key
        _raises(db, _INS, bad)
    _raises(db, "update b2b_requests set org_name = 'X' where id = %s",
            (rid,))
    _raises(db, "delete from b2b_requests where id = %s", (rid,))
    _raises(db, "truncate b2b_requests")
    _raises(db, "insert into consents (contact_id, purpose, granted, source,"
            " recorded_by) values (%s, 'xyz', false, 'web', 't')", (cid,))
    db.execute("insert into consents (contact_id, purpose, granted, source,"
               " recorded_by) values (%s, 'b2b', false, 'web', 't')", (cid,))
    (defn,) = db.execute(
        "select pg_get_constraintdef(c.oid) from pg_constraint c join"
        " pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid ="
        " t.relnamespace where c.conname = 'consents_purpose_check' and"
        " n.nspname = current_schema()").fetchone()
    assert "'b2b'" in defn and "'dai_ly'" in defn
    cols = {r[0] for r in db.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = 'b2b_requests'")}
    assert cols and not [c for c in cols if re.search(
        r"phone|email|name_|contact_name|address", c)]
    assert "b2b" in crm.PURPOSES


def test_intake_db_vault_consent_no_pii(db, keys, capsys):
    tx = TxConn(db)
    s = _Srv(keys=keys, connect_fn=lambda: tx)
    try:
        st, body = s.req("POST", body=_body())
        assert st == 200 and body == bf.PAGE_OK and "YC-" not in body
        n = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
             for t in ("contacts", "consents", "b2b_requests")}
        assert n == {"contacts": 1, "consents": 1, "b2b_requests": 1}
        # gửi lại y hệt → 0 dòng mới, cùng mã
        st2, body2 = s.req("POST", body=_body())
        assert st2 == 200 and body2 == body
        n2 = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("contacts", "consents", "b2b_requests")}
        assert n2 == n
        # honeypot → 0 dòng
        assert s.req("POST", body=_body(website="x", org_name="Khác"))[0] \
            == 200
        assert db.execute("select count(*) from b2b_requests"
                          ).fetchone()[0] == 1
    finally:
        s.close()
    phone_enc, name_enc, email_enc, src = db.execute(
        "select phone_enc, name_enc, email_enc, source from contacts"
        ).fetchone()
    assert phone_enc.startswith("gAAAAA") and src == "b2b_form"
    f, _ = keys
    assert crm.unseal(f, phone_enc) == PHONE and crm.unseal(f, email_enc) \
        == EMAIL and crm.unseal(f, name_enc) == CNAME
    purpose, granted, source, pv, ev = db.execute(
        "select purpose, granted, source, policy_version, evidence_ref from"
        " consents").fetchone()
    assert (purpose, granted, source, pv) == ("b2b", True, "web",
                                              bf.POLICY_VERSION)
    assert ev.startswith("B2BF-") and not re.search(r"\d{3}", ev[5:])
    dump = []
    for t in ("contacts", "consents", "b2b_requests", "agent_action_log"):
        dump += [str(r) for r in db.execute(f"select * from {t}")]
    blob = "\n".join(dump)
    for raw in (PHONE, CNAME, EMAIL, "lienhe.mau"):
        assert raw not in blob, raw
    out = capsys.readouterr()
    for raw in (PHONE, CNAME, EMAIL, "127.0.0.1"):
        assert raw not in out.out + out.err, raw
    # gửi lại y hệt → cùng mã YC (mã chỉ ở log nội bộ, không ở trang)
    ycs = re.findall(r"\[b2b_form\] 200 ip=[0-9a-f]{8} yc=(\d+)", out.out)
    assert len(ycs) == 2 and ycs[0] == ycs[1], ycs
    rq = db.execute("select org_name, region, items, need_by, contact_id"
                    " is not null from b2b_requests").fetchone()
    assert rq == ("Công ty MẪU B2B", "Đà Nẵng", [{"key": H1, "qty": 20}],
                  date(2026, 12, 20), True)


def test_intake_rolls_back_on_insert_error(db, keys, monkeypatch):
    f, _ = bf.parse_form(_body(), ALLOWED, DAY)
    f["org_type"] = "ca_nhan"      # vượt parse_form → CHECK DB chặn
    with pytest.raises(psycopg.Error):
        bf.intake(TxConn(db), f, keys, today=DAY)
    assert db.execute("select count(*) from contacts").fetchone()[0] == 0
    assert db.execute("select count(*) from consents").fetchone()[0] == 0


# ---------------------------------------- v8.2 cold-check: lỗi giữa kết nối
def _err_srv(**kw):
    """_Srv có handle_error báo event — chờ theo sự kiện, không sleep."""
    s = _Srv(**kw)
    done = threading.Event()
    orig = s.srv.handle_error

    def wrapped(request, client_address):
        try:
            orig(request, client_address)
        finally:
            done.set()

    s.srv.handle_error = wrapped
    return s, done


def _assert_no_raw_ip(err: str, exc_name: str):
    assert re.search(r"\[b2b_form\] lỗi kết nối ip=[0-9a-f]{8} "
                     + exc_name, err), err
    assert "127.0.0.1" not in err and "Traceback" not in err \
        and "Exception occurred" not in err, err


def test_unexpected_intake_error_no_raw_ip(capsys):
    def boom(conn, form, keys, today=None):
        raise RuntimeError("bất ngờ")

    s, done = _err_srv(connect_fn=lambda: TxConnStub(), intake_fn=boom)
    try:
        with pytest.raises((http.client.HTTPException, OSError)):
            s.req("POST", body=_body())
        assert done.wait(10)
    finally:
        s.close()
    _assert_no_raw_ip(capsys.readouterr().err, "RuntimeError")


def test_client_rst_mid_body_no_raw_ip(capsys):
    s, done = _err_srv(connect_fn=lambda: TxConnStub(),
                       intake_fn=lambda *a, **k: pytest.fail("intake"))
    try:
        sk = socket.create_connection(("127.0.0.1", s.port), timeout=10)
        sk.sendall(b"POST /b2b HTTP/1.1\r\nHost: x\r\nContent-Type: "
                   b"application/x-www-form-urlencoded\r\nContent-Length: "
                   b"500\r\n\r\norg_name=abc")
        sk.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER,
                      struct.pack("ii", 1, 0))
        sk.close()                                 # linger 0 → RST
        assert done.wait(10)
    finally:
        s.close()
    _assert_no_raw_ip(capsys.readouterr().err, r"Connection\w*Error")


def test_intake_withdrawn_b2b_not_regranted(db, keys, capsys):
    """Form không xác minh SĐT: contact đã RÚT b2b + người lạ gửi form cùng
    SĐT → can_contact(b2b) vẫn False, 0 ghi, trang chung. Nghiệm thu MINOR
    (oracle dò vault): body PHẢI y hệt POST hợp lệ thường — khác nhau là
    người lạ phân biệt được "SĐT X đã rút đồng ý b2b"."""
    cid, _ = _contact(db, keys)
    crm.record_consent(db, cid, "b2b", False, "web", "test")
    assert crm.can_contact(db, cid, "b2b") is False
    before = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("contacts", "consents", "b2b_requests")}
    tx = TxConn(db)
    s = _Srv(keys=keys, connect_fn=lambda: tx)
    try:
        st, body = s.req("POST", body=_body())
    finally:
        s.close()
    assert st == 200 and "YC-" not in body
    assert crm.can_contact(db, cid, "b2b") is False
    after = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
             for t in ("contacts", "consents", "b2b_requests")}
    assert after == before
    out = capsys.readouterr()
    assert re.search(r"\[b2b_form\] 200 ip=[0-9a-f]{8} yc=-", out.out)
    for raw in (PHONE, CNAME, EMAIL, "127.0.0.1"):
        assert raw not in out.out + out.err, raw
    # POST hợp lệ thường (SĐT khác, contact mới) → cùng body byte-for-byte
    s2 = _Srv(keys=keys, connect_fn=lambda: TxConn(db))
    try:
        st_ok, body_ok = s2.req("POST", body=_body(phone="0912000111",
                                                   org_name="Cty Khac"))
    finally:
        s2.close()
    assert st_ok == 200 and body_ok == body == bf.PAGE_OK
    assert db.execute("select count(*) from b2b_requests").fetchone()[0] \
        == before["b2b_requests"] + 1     # thật sự đã nhận (không phải spam)


def test_intake_existing_contact_granted_still_ok(db, keys):
    """Contact đã có + b2b granted → yêu cầu vẫn nhận (không chặn nhầm)."""
    cid, _ = _contact(db, keys)
    f, _ = bf.parse_form(_body(), ALLOWED, DAY)
    rid, new = bf.intake(TxConn(db), f, keys, today=DAY)
    assert new is True and rid is not None
    assert crm.can_contact(db, cid, "b2b") is True
    assert db.execute("select contact_id from b2b_requests where id = %s",
                      (rid,)).fetchone()[0] == cid
