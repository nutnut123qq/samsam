"""r13 đợt B: biên nhận OpenTimestamps (phân tích cây + `--upgrade` → `da_nang_cap`, farming-06) và thử lại có giới hạn của
API sàn (data_platform-06). Phản hồi calendar/sàn là GIẢ nhưng đúng định dạng — không phải bằng chứng blockchain thật."""
import hashlib
import io
import urllib.error

import pytest

from ingest import market_api as ma
from pipelines import anchor as an
from tests.test_v13_c09_anchor_legal import (  # noqa: F401 — fixture DB thử
    OTS_CFG,
    _fake_post,
    _issued,
    _now,
    db,
    proxy,
    run,
)


def _vb(b: bytes) -> bytes:
    return an._put_varuint(len(b)) + b


def pending(uri):
    return b"\x00" + an.ATT_PENDING + _vb(_vb(uri.encode()))


def bitcoin(height):
    return b"\x00" + an.ATT_BITCOIN + _vb(an._put_varuint(height))


CAL = "https://cal-b.test"
NONCE = b"\x22" * 16
RESP = b"\xf0" + _vb(NONCE) + b"\x08" + pending(CAL)       # append nonce → sha256 → pending


def commitment(digest):
    return hashlib.sha256(digest + NONCE).digest()


def test_varuint_roundtrip_and_limits():
    for v in (0, 1, 127, 128, 300, 850000, 2 ** 40):
        assert an._varuint(an._put_varuint(v), 0) == (v, len(an._put_varuint(v)))
    with pytest.raises(an.OtsError):
        an._varuint(b"\x80\x80", 0)


def test_parse_receipt_commitment_and_roundtrip():
    dg = hashlib.sha256(b"ban-ke").digest()
    rec = an.ots_file(dg, RESP)
    tree = an.parse_receipt(rec, dg.hex())
    atts = an.attestations(tree)
    assert atts == [("pending", commitment(dg), _vb(CAL.encode()))]
    assert an.ots_file(dg, an.write_tree(tree)) == rec


@pytest.mark.parametrize("bad,msg", [
    (b"\xf0\x10" + b"\x00" * 8, "cụt"),             # varbytes dài hơn dữ liệu
    (b"\x67" + b"\x00" * 4, "không hỗ trợ"),          # phép lạ (keccak) không nhận
    (RESP + b"\x00", "byte thừa"),
    (b"\x08\x08" + b"\xff" * 2, "cụt|không hỗ trợ")])
def test_parse_receipt_rejects_malformed(bad, msg):
    dg = hashlib.sha256(b"x").digest()
    with pytest.raises(an.OtsError, match=msg):
        an.parse_receipt(an.ots_file(dg, bad), dg.hex())


def test_parse_receipt_wrong_digest_and_no_attestation():
    dg, other = hashlib.sha256(b"a").digest(), hashlib.sha256(b"b").digest()
    with pytest.raises(an.OtsError, match="digest"):
        an.parse_receipt(an.ots_file(dg, RESP), other.hex())
    with pytest.raises(an.OtsError):
        an.parse_receipt(an.ots_file(dg, b"\x08"), dg.hex())      # nút con rỗng


def test_graft_replaces_pending_with_bitcoin():
    dg = hashlib.sha256(b"m").digest()
    tree = an.parse_receipt(an.ots_file(dg, RESP), dg.hex())
    c = commitment(dg)
    sub, _ = an.parse_tree(b"\xf1" + _vb(b"\x33" * 4) + b"\x08" + bitcoin(850000), 0, c, [64])
    assert an._graft(tree, c, sub)
    kinds = [k for k, _c, _p in an.attestations(tree)]
    assert kinds == ["bitcoin"]
    new = an.ots_file(dg, an.write_tree(tree))
    assert an.parse_receipt(new, dg.hex())


# ---------------------------------------------------------------- DB (upgrade)

def test_upgrade_pending_then_bitcoin_append_only(db, proxy, run):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    sha = db.execute("select manifest_sha256 from anchor_batches where id = %s", (bid,)).fetchone()[0]
    assert an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("chưa gửi"))["status"] == "chua_gui"
    an.submit(proxy, bid, OTS_CFG, post=_fake_post([], resp=RESP))
    c = commitment(bytes.fromhex(sha))
    gets = []

    def get_pending(url, timeout):
        gets.append(url)
        # trả None = 404, calendar chưa có attestation
    r = an.upgrade(proxy, bid, OTS_CFG, get=get_pending)
    assert r["status"] == "cho" and gets == [f"{CAL}/timestamp/{c.hex()}"]
    assert "chờ xác nhận" in an.receipt_state(proxy, bid)

    def get_done(url, timeout):
        return b"\x08" + bitcoin(850001)
    r = an.upgrade(proxy, bid, OTS_CFG, get=get_done)
    assert r["status"] == "da_nang_cap" and r["heights"] == [850001] and r["new"]
    st = an.receipt_state(proxy, bid)
    assert "attestation Bitcoin" in st and "CHƯA xác minh bên thứ ba" in st
    rows = db.execute("select status from anchor_receipts where batch_id = %s order by id", (bid,)).fetchall()
    assert [x[0] for x in rows] == ["da_gui", "da_nang_cap"]          # append-only, bản cũ giữ
    assert an.verify(proxy, bid)[1] == []
    assert an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("đã nâng cấp"))["new"] is False


def test_upgrade_ignores_calendar_outside_config(db, proxy, run):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    evil = b"\xf0" + _vb(NONCE) + b"\x08" + pending("https://evil.example")
    an.submit(proxy, bid, OTS_CFG, post=_fake_post([], resp=evil))
    r = an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("không được hỏi calendar lạ"))
    assert r["status"] == "cho" and r["errors"]


def test_submit_rejects_malformed_calendar_response(db, proxy, run):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    r = an.submit(proxy, bid, OTS_CFG, post=_fake_post([], resp=b"\xf0junk"))
    assert r["status"] == "loi"


# ---------------------------------------------------------------- API sàn: thử lại

class _HTTPErr(urllib.error.HTTPError):
    def __init__(self, code, ra=None):
        super().__init__("http://127.0.0.1/x", code, "x", {"Retry-After": ra} if ra else {}, io.BytesIO(b""))


def test_market_retry_429_then_ok_and_cap(monkeypatch):
    seq, waits = [], []

    class Resp:
        status = 200

        def read(self, n):
            return b'{"error": "", "response": {}}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def opener(req, timeout):
        step = seq.pop(0)
        if step != 200:
            raise _HTTPErr(*step)
        return Resp()
    monkeypatch.setattr(ma._OPENER, "open", opener)
    monkeypatch.setattr(ma, "_sleep", waits.append)
    creds = {k: "gia-1" for k in ma.KEYS["shopee"]}
    seq[:] = [(429, "120"), 200]
    ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=creds, base="http://127.0.0.1:9")
    assert waits == [ma.RETRY_WAIT_MAX]                       # Retry-After 120 bị chặn trần
    waits.clear()
    seq[:] = [(503,)] * (ma.RETRY_MAX + 1)
    with pytest.raises(ma.ApiError, match="503"):
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=creds, base="http://127.0.0.1:9")
    assert waits == [1.0, 2.0, 4.0]
    seq[:] = [(403,)]
    with pytest.raises(ma.ApiError, match="403"):
        ma._request("shopee", "GET", ma.SP_ITEM_LIST, {}, creds=creds, base="http://127.0.0.1:9")
