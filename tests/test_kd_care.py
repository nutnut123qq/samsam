"""v10.1 W101.3 — KD-A7 `agents.kd_care`: nháp chăm sóc lại / xin đánh giá
CHỈ khi có đồng ý đúng mục đích → hàng duyệt khối sales, KHÔNG gửi.

DB thật: schema tạm (docs/schema.sql ×2 + roles.sql ×2) → ROLLBACK cuối
test; code gọi commit → `_TxConn`. Khách/đồng ý là fixture GIẢ (ciphertext/
HMAC giả đúng định dạng, không PII thật); người duyệt là tên GIẢ LẬP.
Thời gian `now` tiêm vào — không wall-clock.
"""

import hashlib
import io
import json
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import kd_care as kc
from ingest import golden_store as gs
from pipelines import approval_queue as aq
from pipelines import director
from pipelines.period import VN_TZ
from pipelines.pii import _PII_RE

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
H1, H2, SAPH = "mat-ong-sam-120ml-1hu", "mat-ong-sam-120ml-2hu", "saphraton-20v"
SAPENTOL, RUOU = "sapentol-30v", "ruou-sam-chai-thuy-tinh-500ml"
NOW = datetime(2026, 10, 14, 10, 0, tzinfo=VN_TZ)
DECIDER = "nguoi_duyet_gia_lap"
RULES = kc.load_rules()


@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w101c_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _promotable(db):
    """Mật ong (tự công bố OK) + Saphraton (XNQC approved) mở kênh zalo, giá
    zalo ĐÃ duyệt (người duyệt GIẢ LẬP); Sapentol có giá nhưng chưa XNQC;
    rượu có giá nhưng readiness CAM."""
    db.execute("update sku_master set self_declaration_ok = true where"
               " category = 'food'")
    # cả họ Saphraton (guardrail nhận diện theo tên họ → mọi SKU cùng họ
    # phải QC_DAY_DU trên kênh)
    db.execute("update sku_master set xnqc_status = 'approved' where"
               " sku_key like 'saphraton-%'")
    db.execute("update sku_master set allowed_channels = array['shopee',"
               " 'zalo'] where sku_key = any(%s) or sku_key like"
               " 'saphraton-%%' or category = 'food'",
               ([SAPENTOL, RUOU],))
    for k, p in ((H1, 250000), (H2, 480000), (SAPH, 320000),
                 (SAPENTOL, 300000), (RUOU, 700000)):
        pid = db.execute(
            "insert into price_list (sku_key, channel, kind, price_vnd,"
            " valid_from) values (%s, 'zalo', 'list', %s, '2026-01-01')"
            " returning id", (k, p)).fetchone()[0]
        db.execute("update price_list set approved_by = 'GD gia lap',"
                   " approved_at = now() where id = %s", (pid,))
    got = {k for (k,) in db.execute(
        "select sku_key from v_promotable where channel = 'zalo'")}
    assert got == {H1, H2, SAPH}


ENC = {}


def _contact(db, n: int) -> int:
    hm = hashlib.sha256(f"gia-lap-{n}".encode()).hexdigest()
    enc = "gAAAAA" + hashlib.sha256(f"enc-{n}".encode()).hexdigest()
    cid = db.execute(
        "insert into contacts (phone_hmac, phone_enc, name_enc, province,"
        " source, created_by) values (%s, %s, %s, 'Đà Nẵng', 'manual',"
        " 'Nguoi ghi gia lap') returning id", (hm, enc, enc + "N")
    ).fetchone()[0]
    ENC[cid] = (hm, enc)
    return cid


def _consent(db, cid, purpose, granted=True):
    db.execute(
        "insert into consents (contact_id, purpose, granted, source,"
        " evidence_ref, policy_version, recorded_by) values (%s, %s, %s,"
        " 'form_giay', 'BB-MAU-01', 'v0-mau', 'Nguoi ghi gia lap')",
        (cid, purpose, granted))


def _purchase(db, cid, sku, channel="web", bought=date(2026, 9, 1),
              got=date(2026, 9, 3)):
    return db.execute(
        "insert into care_purchases (contact_id, channel, sku_key,"
        " purchased_on, delivered_on, recorded_by) values (%s, %s, %s, %s,"
        " %s, 'Nguoi ghi gia lap') returning id",
        (cid, channel, sku, bought, got)).fetchone()[0]


def _fixture50(db) -> dict:
    """50 lần mua mẫu: 20 shopee + 10 tiktok bị DB CHECK từ chối; 20 web
    (khách 1..12 có marketing — khách 1 mua 3 lần; 13..15 chỉ cskh; 16 chỉ
    b2b; 17..18 không đồng ý)."""
    _promotable(db)
    ids = {n: _contact(db, n) for n in range(1, 19)}
    for n in range(1, 31):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            _purchase(db, ids[(n % 18) + 1], H1,
                      channel="shopee" if n <= 20 else "tiktok")
    for n in range(1, 13):
        _consent(db, ids[n], "marketing")
    for n in (13, 14, 15):
        _consent(db, ids[n], "cskh")
    _consent(db, ids[16], "b2b")
    pids = {}
    for n in range(1, 19):
        pids[n] = [_purchase(db, ids[n], H1)]
    pids[1] += [_purchase(db, ids[1], H2, bought=date(2026, 9, 2)),
                _purchase(db, ids[1], SAPH, bought=date(2026, 9, 3))]
    assert db.execute("select count(*) from care_purchases").fetchone()[0] \
        == 20
    return {"ids": ids, "pids": pids}


def _queue(db):
    return db.execute("select id, object_type, object_id, status, payload,"
                      " title, risk, block from approval_queue order by id"
                      ).fetchall()


# ---------------------------------------------------------------- thuần

def test_rules_assumed_and_window():
    raw = (ROOT / "data" / "care_rules.json").read_text(encoding="utf-8")
    assert "GIẢ ĐỊNH" in raw and "GĐ KD/Pháp chế" in raw
    assert RULES["max_marketing_per_month"] == 2
    w = RULES["window"]
    at = kc.gui_luc(datetime(2026, 10, 14, 22, 30, tzinfo=VN_TZ), w)
    assert at == datetime(2026, 10, 15, 8, 0, tzinfo=VN_TZ)
    at = kc.gui_luc(datetime(2026, 10, 14, 7, 59, tzinfo=VN_TZ), w)
    assert at == datetime(2026, 10, 14, 8, 0, tzinfo=VN_TZ)
    at = kc.gui_luc(datetime(2026, 10, 14, 13, 0, tzinfo=VN_TZ), w)
    assert at == datetime(2026, 10, 14, 13, 0, tzinfo=VN_TZ)
    # 20:00 đúng = ngoài khung [08:00, 20:00)
    assert not kc.in_window(datetime(2026, 10, 14, 20, 0, tzinfo=VN_TZ), w)
    # now UTC vẫn quy về giờ VN (15:30 UTC = 22:30 VN)
    at = kc.gui_luc(datetime(2026, 10, 14, 15, 30, tzinfo=timezone.utc), w)
    assert at == datetime(2026, 10, 15, 8, 0, tzinfo=VN_TZ)
    with pytest.raises(ValueError):
        kc.gui_luc(datetime(2026, 10, 14, 10, 0), w)  # noqa: DTZ001


@pytest.mark.parametrize("mut,needle", [
    ({"window": ["20:00", "08:00"]}, "window"),
    ({"window": ["8h", "20:00"]}, "HH:MM"),
    ({"max_marketing_per_month": "2"}, "max_marketing_per_month"),
    ({"channel": "shopee"}, "channel"),
    ({"rebuy_window_days": -1}, "rebuy_window_days"),
    ({"review_window_days": "60"}, "review_window_days"),
    ({"templates": {"rebuy": "không chỗ tên", "review": "{ten_sp}"}},
     "templates.rebuy"),
])
def test_bad_rules_rejected(tmp_path, mut, needle):
    raw = json.loads((ROOT / "data" / "care_rules.json").read_text(
        encoding="utf-8"))
    raw.update(mut)
    p = tmp_path / "r.json"
    p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(kc.CareRulesError, match=needle):
        kc.load_rules(p)


def _p(pid, cid, sku=H1, cat="food", name="Mật ong sâm 120ml (1 hũ)",
       ch="web", bought=date(2026, 9, 1), got=date(2026, 9, 3)):
    return {"id": pid, "contact_id": cid, "channel": ch, "sku_key": sku,
            "name": name, "category": cat, "purchased_on": bought,
            "delivered_on": got}


def test_select_items_pure_traps():
    # p3 = SKU KHÁC (cùng SKU với p1 thì p1 là lần mua cũ → không nhắc)
    data = {"purchases": [_p(1, 1), _p(2, 1, H2), _p(3, 1, "x-sku"),
                          _p(4, 2, ch="shopee"),
                          _p(5, 3, RUOU, "alcohol", "Rượu sâm chai"),
                          _p(6, 4, SAPENTOL, "tpbvsk", "Sapentol 30 viên"),
                          _p(7, 5, bought=date(2026, 10, 1),
                             got=date(2026, 10, 10))],
            "consent": {(1, "marketing"): True, (2, "marketing"): True,
                        (3, "marketing"): True, (4, "marketing"): True,
                        (5, "marketing"): True, (5, "cskh"): True},
            "promotable": {H1, H2, "x-sku"}, "month_counts": {},
            "seen_rebuy": set(), "seen_review": set()}
    res = kc.select_items(data, NOW, RULES)
    rebuy = [i["purchase_id"] for i in res["items"] if i["kind"] == "rebuy"]
    assert rebuy == [1, 2]
    why = {(s["purchase_id"], s["kind"]): s["ly_do"] for s in res["skipped"]}
    assert why[(3, "rebuy")] == "tran_thang"
    assert why[(4, "rebuy")] == "kenh_san"
    assert why[(5, "rebuy")] == "ruou"
    assert why[(6, "rebuy")] == "khong_promotable"
    # mua 13 ngày trước → chưa tới hạn nhắc; giao 4 ngày trước → chưa xin
    # đánh giá (review_after_days 7)
    assert not [i for i in res["items"] if i["purchase_id"] == 7]
    assert (7, "rebuy") not in why
    # 22:30 → gửi 08:00 hôm sau, ghi trong payload
    late = kc.select_items(data, datetime(2026, 10, 14, 22, 30,
                                          tzinfo=VN_TZ), RULES)
    assert all("gui_luc: 2026-10-15 08:00" in i["payload"]
               for i in late["items"])
    # đã có 2 mục tháng này → khách 1 bị chặn trần ngay mục đầu
    data2 = {**data, "month_counts": {1: 2}}
    res2 = kc.select_items(data2, NOW, RULES)
    assert not [i for i in res2["items"] if i["contact_id"] == 1]


def _empty(purchases, consent):
    return {"purchases": purchases, "consent": consent,
            "promotable": {H1, H2}, "month_counts": {}, "seen_rebuy": set(),
            "seen_review": set()}


def test_rebuy_only_latest_purchase_per_sku():
    """Nghiệm thu v10.1 MINOR: khách 7 mua H1 2024-01-01, 2026-06-01,
    2026-10-10 → đã mua lại 4 ngày trước → 0 tin nhắc (bản cũ: 2 tin trùng
    nội dung ăn hết trần tháng)."""
    c = {(7, "marketing"): True, (7, "cskh"): True}
    data = _empty([_p(1, 7, bought=date(2024, 1, 1), got=date(2024, 1, 3)),
                   _p(2, 7, bought=date(2026, 6, 1), got=date(2026, 6, 3)),
                   _p(3, 7, bought=date(2026, 10, 10), got=None)], c)
    res = kc.select_items(data, NOW, RULES)
    assert not [i for i in res["items"] if i["kind"] == "rebuy"]
    # 2 lần mua cùng SKU đều trong hạn → chỉ nhắc lần MỚI NHẤT
    data2 = _empty([_p(4, 7, bought=date(2026, 8, 1), got=None),
                    _p(5, 7, bought=date(2026, 9, 1), got=None),
                    _p(6, 7, H2, bought=date(2026, 8, 1), got=None)], c)
    got = [i["purchase_id"] for i in kc.select_items(data2, NOW, RULES)[
        "items"] if i["kind"] == "rebuy"]
    assert got == [6, 5]
    # cùng ngày mua → id lớn hơn là mới nhất
    data3 = _empty([_p(9, 7, bought=date(2026, 9, 1), got=None),
                    _p(8, 7, bought=date(2026, 9, 1), got=None)], c)
    assert [i["purchase_id"] for i in kc.select_items(data3, NOW, RULES)[
        "items"]] == [9]


def test_old_backlog_not_reminded():
    """Lần mua/giao quá cũ (ngoài cửa sổ rules) → 0 nhắc, 0 xin đánh giá;
    biên đúng mốc trong cửa sổ vẫn nhắc."""
    c = {(1, "marketing"): True, (1, "cskh"): True}
    today = NOW.date()
    a, w = RULES["rebuy_after_days"], RULES["rebuy_window_days"]
    ra, rw = RULES["review_after_days"], RULES["review_window_days"]
    old = _empty([_p(1, 1, bought=date(2024, 1, 1), got=date(2024, 1, 3))], c)
    assert kc.select_items(old, NOW, RULES)["items"] == []
    edge_in = today - timedelta(days=a + w)
    edge_out = edge_in - timedelta(days=1)
    rv_in = today - timedelta(days=ra + rw)
    rv_out = rv_in - timedelta(days=1)
    res = kc.select_items(_empty([_p(1, 1, bought=edge_in, got=rv_in),
                                  _p(2, 1, H2, bought=edge_out, got=rv_out)],
                                 c), NOW, RULES)
    assert sorted((i["kind"], i["purchase_id"]) for i in res["items"]) == \
        [("rebuy", 1), ("review", 1)]


def test_cap_month_is_send_month():
    """22:30 ngày 31/10 → gửi 08:00 01/11 → object_id khóa tháng 2026-11
    (tháng GỬI), để lần chạy 01/11 đếm đúng trần."""
    c = {(1, "marketing"): True}
    late = datetime(2026, 10, 31, 22, 30, tzinfo=VN_TZ)
    res = kc.select_items(_empty([_p(1, 1, bought=date(2026, 9, 15),
                                     got=None)], c), late, RULES)
    assert [i["object_id"] for i in res["items"]] == ["1:2026-11:p1"]
    assert "gui_luc: 2026-11-01 08:00" in res["items"][0]["payload"]


def test_module_grep_no_llm_no_send():
    src = (ROOT / "agents" / "kd_care.py").read_text(encoding="utf-8")
    assert not re.search(r"llm_gateway|openai|requests|httpx|urllib|smtplib"
                         r"|unseal|load_vault_key", src)


def test_sales_config_has_care_types():
    cfg = director.load_config("sales")
    t = cfg["object_types"]
    assert (t["care_rebuy"]["risk"], t["care_rebuy"]["handoff"]) == \
        ("high", "B")
    assert (t["care_review"]["risk"], t["care_review"]["handoff"]) == \
        ("medium", "A")


def test_cli_usage_exit_2_before_connect(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(kc, "connect", lambda: calls.append(1))
    for argv in (["--plan", "--run"], [], ["--record"],
                 ["--record", "--by", "agent:kd_a7"], ["--plan", "--by", "X"],
                 ["--plan", "--dry-run"]):
        with pytest.raises(SystemExit) as e:
            kc.main(argv, now=NOW)
        assert e.value.code == 2, argv
    assert calls == []
    capsys.readouterr()


# ---------------------------------------------------------------- DB

def test_db_schema_care_purchases_blocks_san_and_agent(db):
    cid = _contact(db, 99)
    for ch in ("shopee", "tiktok", "lazada"):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            _purchase(db, cid, H1, channel=ch)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("insert into care_purchases (contact_id, channel, sku_key,"
                   " purchased_on, recorded_by) values (%s, 'web', %s,"
                   " '2026-09-01', 'agent:kd_a7')", (cid, H1))
    cols = {r[0] for r in db.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = 'care_purchases'")}
    assert cols and not [c for c in cols if re.search(
        r"name|phone|sdt|address|dia_chi|email|_enc|hmac", c)]


def test_db_plan_run_cap_withdraw_verify(db, capsys):
    fx = _fixture50(db)
    ids, pids = fx["ids"], fx["pids"]
    tx = _TxConn(db)
    # (a) rebuy đúng 12 khách, 0 khách sàn; cskh-only → chỉ review; b2b
    # không phải marketing
    res = kc.run(tx, NOW)
    q = _queue(db)
    rebuy = [r for r in q if r[1] == "care_rebuy"]
    review = [r for r in q if r[1] == "care_review"]
    rebuy_c = {int(r[2].split(":")[0]) for r in rebuy}
    assert rebuy_c == {ids[n] for n in range(1, 13)} and len(rebuy) == 13
    assert {r[2] for r in review} == {f"review:{pids[n][0]}"
                                      for n in (13, 14, 15)}
    assert res["new"] == len(q) == 16
    assert all((r[3], r[7]) == ("pending", "sales") for r in q)
    assert {r[6] for r in rebuy} == {"high"} and \
        {r[6] for r in review} == {"medium"}
    why = {(s["contact_id"], s["kind"]): s["ly_do"] for s in res["skipped"]}
    assert why[(ids[16], "rebuy")] == "consent"           # b2b ≠ marketing
    assert why[(ids[13], "rebuy")] == "consent"
    # (b) tin thứ 3 cùng tháng → tran_thang
    assert [s["purchase_id"] for s in res["skipped"]
            if s["ly_do"] == "tran_thang"] == [pids[1][2]]
    # (f) payload không PII / ciphertext / HMAC; có contact_id + gui_luc
    for _qid, ot, _oid, _st, payload, title, _r, _b in q:
        assert not _PII_RE.search(payload) and not _PII_RE.search(title)
        for hm, enc in ENC.values():
            assert hm not in payload and enc not in payload
        assert re.search(r"^contact_id: \d+$", payload, re.MULTILINE)
        assert "gui_luc: 2026-10-14 10:00" in payload
        if ot == "care_rebuy":
            assert "Quảng cáo" in payload and "muc_dich: marketing" in payload
    # (g) chạy lại cùng now → 0 mục mới
    assert kc.run(tx, NOW)["new"] == 0 and len(_queue(db)) == 16
    # (b) mục rejected không tính trần → lần mua thứ 3 của khách 1 được đẩy
    first1 = next(r for r in rebuy if int(r[2].split(":")[0]) == ids[1])
    ok, msg = aq.decide(tx, first1[0], DECIDER, "rejected")
    assert ok, msg
    res3 = kc.run(tx, NOW)
    assert res3["new"] == 1
    assert _queue(db)[-1][2] == f"{ids[1]}:2026-10:p{pids[1][2]}"
    # SKU TPBVSK (XNQC approved) → CODE nối câu khuyến cáo
    assert "không phải là thuốc" in _queue(db)[-1][4]
    # (e) verify_send: mục approved của khách 2 → ok; rút đồng ý → consent
    it2 = next(r for r in rebuy if int(r[2].split(":")[0]) == ids[2])
    assert kc.verify_send(tx, it2[0], it2[4], NOW) == (False, "chua_duyet")
    ok, msg = aq.decide(tx, it2[0], DECIDER, "approved")
    assert ok, msg
    assert kc.verify_send(tx, it2[0], it2[4], NOW) == (True, "ok")
    assert kc.verify_send(tx, it2[0], it2[4] + " ", NOW) == (False, "sha")
    assert kc.verify_send(
        tx, it2[0], it2[4], datetime(2026, 10, 14, 21, 0, tzinfo=VN_TZ)) \
        == (False, "khung_gio")
    _consent(db, ids[2], "marketing", granted=False)
    assert kc.verify_send(tx, it2[0], it2[4], NOW) == (False, "consent")
    assert kc.verify_send(tx, 10**9, "x", NOW) == (False, "khong_tim_thay")
    # rút đồng ý trước lần --run kế → 0 mục mới cho khách đó
    _purchase(db, ids[3], H2, bought=date(2026, 9, 5), got=None)
    _consent(db, ids[3], "marketing", granted=False)
    res4 = kc.run(tx, NOW)
    assert res4["new"] == 0
    assert any(s["contact_id"] == ids[3] and s["ly_do"] == "consent"
               for s in res4["skipped"])
    # (d) rượu + TPBVSK chưa XNQC → 0 tin nhắc
    c19, c20 = _contact(db, 19), _contact(db, 20)
    for c in (c19, c20):
        _consent(db, c, "marketing")
    _purchase(db, c19, RUOU)
    _purchase(db, c20, SAPENTOL)
    res5 = kc.run(tx, NOW)
    assert res5["new"] == 0
    why5 = {s["contact_id"]: s["ly_do"] for s in res5["skipped"]
            if s["kind"] == "rebuy"}
    assert (why5[c19], why5[c20]) == ("ruou", "khong_promotable")
    out = capsys.readouterr().out
    for hm, enc in ENC.values():
        assert hm not in out and enc not in out


def test_db_cli_record_plan_run_dry(db, monkeypatch, capsys):
    _promotable(db)
    cid = _contact(db, 1)
    _consent(db, cid, "marketing")
    tx = _TxConn(db)
    monkeypatch.setattr(kc, "connect", lambda: tx)
    rec = {"contact_id": cid, "channel": "web", "sku_key": H1,
           "purchased_on": "2026-09-01", "order_ref": "WEB-0001"}

    def stdin(obj):
        raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(raw)))

    stdin(rec)
    assert kc.main(["--record", "--by", "Nguoi ghi gia lap"], now=NOW) == 0
    row = db.execute("select channel, order_ref, recorded_by from"
                     " care_purchases").fetchone()
    assert row == ("web", "WEB-0001", "Nguoi ghi gia lap")
    log = db.execute("select actor, action, detail from agent_action_log"
                     " where action = 'care_purchase_record'").fetchone()
    assert log[0] == "Nguoi ghi gia lap" and log[2]["contact_id"] == cid
    for bad in ({**rec, "channel": "shopee"}, {**rec, "phone": "0901234567"},
                {**rec, "0907654321": 1},
                {**rec, "order_ref": "0901234567"}, [1], b"{x"):
        stdin(bad)
        assert kc.main(["--record", "--by", "Nguoi ghi gia lap"],
                       now=NOW) == 1
    assert db.execute("select count(*) from care_purchases").fetchone()[0] \
        == 1
    assert kc.main(["--plan"], now=NOW) == 0
    assert kc.main(["--run", "--dry-run"], now=NOW) == 0
    assert db.execute("select count(*) from approval_queue").fetchone()[0] \
        == 0
    jobs = []
    monkeypatch.setattr("pipelines.job_runs._record",
                        lambda job, s, e, ok, d: jobs.append((job, ok)))
    assert kc.main(["--run"], now=NOW) == 0
    assert db.execute("select count(*) from approval_queue").fetchone()[0] \
        == 1
    assert jobs == [("agents.kd_care", True)]
    cap = capsys.readouterr()
    out = cap.out + cap.err
    # lỗi input không echo giá trị/tên trường (key có thể là SĐT)
    assert "0901234567" not in out and "0907654321" not in out
    assert "KHÔNG gửi" in out


def test_db_cap_send_month_boundary(db):
    """Nghiệm thu v10.1 MINOR: chạy 31/10 22:30 (gửi 01/11 08:00) rồi chạy
    01/11 10:00 → tổng tin rebuy khóa tháng 11 vẫn ≤ trần 2 (bản cũ khóa
    theo tháng tạo → 2026-10 + 2026-11 = 3+ tin cùng tháng gửi)."""
    _promotable(db)
    tx = _TxConn(db)
    cid = _contact(db, 1)
    _consent(db, cid, "marketing")
    _purchase(db, cid, H1, bought=date(2026, 9, 15), got=None)
    _purchase(db, cid, H2, bought=date(2026, 9, 16), got=None)
    late = datetime(2026, 10, 31, 22, 30, tzinfo=VN_TZ)
    assert kc.run(tx, late)["new"] == 2
    _purchase(db, cid, SAPH, bought=date(2026, 9, 20), got=None)
    nov1 = datetime(2026, 11, 1, 10, 0, tzinfo=VN_TZ)
    res = kc.run(tx, nov1)
    assert res["new"] == 0
    assert [s["ly_do"] for s in res["skipped"]] == ["tran_thang"]
    q = [r for r in _queue(db) if r[1] == "care_rebuy"]
    assert sorted(r[2].split(":")[1] for r in q) == ["2026-11", "2026-11"]
    # verify_send: gửi trong tháng khóa → ok; trễ sang tháng 12 → chặn
    ok, msg = aq.decide(tx, q[0][0], DECIDER, "approved")
    assert ok, msg
    assert kc.verify_send(tx, q[0][0], q[0][4], nov1) == (True, "ok")
    assert kc.verify_send(
        tx, q[0][0], q[0][4], datetime(2026, 12, 1, 10, 0, tzinfo=VN_TZ)) \
        == (False, "thang_khac")
