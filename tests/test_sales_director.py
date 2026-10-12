"""v5.0 W50.2–W50.7 — agent GĐ Kinh doanh TMĐT (`agents/sales_director.py`).

Phần thuần (cấu hình, SLA giờ làm việc, vùng, bản tin) chạy không DB. Phần
DB: 1 transaction trên `DATABASE_URL`, schema tạm + docs/schema.sql ×2 +
docs/roles.sql ×2 → ROLLBACK cuối test (precedent
`tests/test_director_framework.py`); thử quyền bằng `set local role
agent_writer`; đặt `created_at`/`due_at`/`decided_at` bằng superuser
`session_replication_role = replica`. `now` luôn là tham số (không đọc đồng
hồ). Skip khi không DB — gate yêu cầu 0 skipped. Người/tên trong test là
giả lập, không phải người duyệt thật.
"""

import json
import os
import re
import subprocess
import sys
import time
import typing
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import InsufficientPrivilege, RaiseException
from psycopg.types.json import Jsonb

from agents import sales_director as sd
from pipelines import approval_queue as aq
from pipelines import director, guardrail
from pipelines.director import DirectorConfigError

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
VN = timezone(timedelta(hours=7))
UTC = timezone.utc
AW, AH = "agent_writer", "app_human"
NAME, PHONE, EMAIL = "Nguyễn Văn An", "0912345678", "an@example.com"
UHASH = "uh_5f2c9a7e1b"
PII = (NAME, PHONE, EMAIL, UHASH)


def _t(d, hh, mm=0):
    """Giờ VN tháng 10/2026 (12 = thứ Hai)."""
    return datetime(2026, 10, d, hh, mm, tzinfo=VN)


# ---------------------------------------------------------------- W50.2 cấu hình

def test_ship_config_valid_and_no_real_people():
    cfg = sd.load_sales_config()
    raw = json.loads((director.DIRECTORS_DIR / "sales.json").read_bytes())
    assert raw["approvers"] == [] and raw["digest_recipients"] == []
    assert raw["approver_roles"] == ["gd_ban_hang"]
    assert "CHƯA ĐƯỢC TGĐ/GĐ KD DUYỆT" in raw["_doc"]
    assert "GIẢ ĐỊNH" in raw["_doc"]
    hc = cfg["handoff_classes"]
    assert hc["A"]["business_hours"] == 2 and hc["B"]["business_hours"] == 4
    assert hc["A"]["red_alert"] is True and hc["B"]["escalate_to_role"] == \
        "tgd"
    types = cfg["object_types"]
    for t in ("cskh_handoff", "cskh_reply", "market_alert_s1",
              "market_alert_s2", "price_review", "price_change",
              "listing_change", "b2b_quote", "affiliate_program",
              "message_template", "listing_sync", "promo_change"):
        assert types[t]["handoff"] in ("A", "B") and types[t]["label"]
    assert types["market_alert_s1"]["risk"] == "high"
    assert {t for t, s in types.items() if s["handoff"] == "A"} == {
        "cskh_handoff", "cskh_reply", "market_alert_s1"}
    assert all(s["risk"] != "low" for s in types.values())


def test_worst_clock_hours():
    shift = sd.load_sales_config()["business_hours"]
    assert sd.worst_clock_hours(shift, 2) == 64.0     # T6 18:00 → T2 10:00
    assert sd.worst_clock_hours(shift, 4) == 66.0


def _mutate(cfg, path, value):
    *head, last = path
    node = cfg
    for k in head:
        node = node[k]
    if value is KeyError:
        del node[last]
    else:
        node[last] = value


@pytest.mark.parametrize("path, value", [
    (("object_types", "market_alert_s1", "risk"), "low"),
    (("object_types", "market_alert_s1", "risk"), "medium"),
    (("object_types", "b2b_quote", "handoff"), "C"),
    (("object_types", "b2b_quote", "label"), KeyError),
    (("object_types", "b2b_quote", "label"), "  "),
    (("handoff_classes", "A", "business_hours"), 3),
    (("handoff_classes", "B", "business_hours"), 2),
    (("handoff_classes", "A", "assignee_role"), "giam_doc"),
    (("handoff_classes", "B", "escalate_to_role"), "giam_doc"),
    (("handoff_classes", "A", "red_alert"), False),
    (("handoff_classes", "C"), {"business_hours": 8}),
    (("object_types", "cskh_handoff", "sla_hours"), 24),
    (("object_types", "price_review", "sla_hours"), 65),
    (("business_hours", "end"), "08:00"),
    (("business_hours", "workdays"), []),
    (("regions", "Hà Nội – miền Bắc"), []),
    (("sources", "convlog_lookback_hours"), 0),
    (("sources", "max_cskh_per_run"), 0),
    (("sources", "max_cskh_per_run"), KeyError),
    (("object_types", "price_review"), KeyError),
])
def test_config_mutations_rejected(tmp_path, path, value):
    cfg = json.loads((director.DIRECTORS_DIR / "sales.json").read_bytes())
    _mutate(cfg, path, value)
    (tmp_path / "sales.json").write_bytes(
        json.dumps(cfg, ensure_ascii=False).encode("utf-8"))
    with pytest.raises(DirectorConfigError):
        sd.load_sales_config(tmp_path)


# ---------------------------------------------------------------- SLA thuần

CFG = sd.load_sales_config()


def test_route_and_alert_type():
    r = sd.route(CFG, sd.alert_type("S1"))
    assert (r["handoff"], r["risk"], r["assignee_role"], r["red_alert"],
            r["auto_eligible"]) == ("A", "high", "mxh", True, False)
    r = sd.route(CFG, sd.alert_type("S2"))
    assert (r["handoff"], r["assignee_role"], r["escalate_to_role"]) == (
        "B", "gd_ban_hang", "tgd")
    with pytest.raises(ValueError):
        sd.alert_type("S3")
    with pytest.raises(ValueError):
        sd.route(CFG, "ad_campaign")


@pytest.mark.parametrize("created, now, state", [
    (_t(12, 8), _t(12, 8, 30), "on_time"),
    (_t(12, 8), _t(12, 9, 30), "due_soon"),
    (_t(12, 8), _t(12, 9, 59), "due_soon"),
    (_t(12, 8), _t(12, 10), "overdue"),
    (_t(16, 17, 59), _t(17, 12), "on_time"),       # T7 không tính
    (_t(16, 17, 59), _t(18, 12), "on_time"),       # CN không tính
    (_t(16, 17, 59), _t(19, 9, 58), "due_soon"),
    (_t(16, 17, 59), _t(19, 9, 59), "overdue"),
])
def test_sla_state_class_a(created, now, state):
    st = sd.sla_state({"object_type": "market_alert_s1",
                       "created_at": created}, CFG, now)
    assert st["state"] == state and st["handoff_class"] == "A"


def test_sla_state_class_b_and_naive():
    st = sd.sla_state({"object_type": "price_review",
                       "created_at": _t(12, 16)}, CFG, _t(13, 9, 59))
    assert st["business_due_at"] == _t(13, 10) and st["state"] == "due_soon"
    assert st["escalate_to_role"] == "tgd" and st["red_alert"] is False
    with pytest.raises(ValueError):
        sd.sla_state({"object_type": "price_review",
                      "created_at": _t(12, 16)}, CFG,
                     datetime(2026, 10, 13, 9))  # noqa: DTZ001 — cố ý naive


def test_region_counts_word_boundary():
    qs = ["Giao hàng ra Huế được không", "Thuế VAT bao nhiêu",
          "ĐÀ NẴNG có đại lý không", "Đà Nẵng mua ở đâu",
          None, "giá sỉ ở Sài Gòn"]
    got = dict(sd.region_counts(CFG, qs))
    assert got["Miền Trung – Tây Nguyên khác"] == 1     # Huế, không Thuế
    assert got["Quảng Nam – Đà Nẵng"] == 2              # hoa + NFD
    assert got["TP.HCM – miền Nam"] == 1
    assert got["chưa rõ vùng"] == 2


def test_period_of_vn_boundaries():
    s, e = sd.period_of("day", datetime(2026, 10, 13, 6, 59, tzinfo=VN))
    assert (s, e) == (_t(12, 0), _t(13, 0))
    s, e = sd.period_of("day", datetime(2026, 10, 12, 17, 1, tzinfo=UTC))
    assert s == _t(12, 0)                  # 13/10 00:01 VN → hôm qua 12/10
    s, e = sd.period_of("week", _t(12, 9))
    assert (s, e) == (_t(5, 0), _t(12, 0))
    with pytest.raises(ValueError):
        sd.period_of("month", _t(12, 9))


def test_agent_never_calls_decision_functions():
    src = (ROOT / "agents" / "sales_director.py").read_text(encoding="utf-8")
    assert not re.search(r"decide\(|auto_approve|override\(|decide_item",
                         src)


# ---------------------------------------------------------------- bản tin thuần

def _data(**over):
    d = {"period": "day", "start": _t(12, 0), "end": _t(13, 0),
         "queue": [
             {"id": 7, "object_type": "market_alert_s1", "handoff_class": "A",
              "business_due_at": _t(12, 10), "state": "overdue",
              "escalated_at": _t(12, 10, 5),
              "title": f"{NAME} {PHONE}", "user_hash": UHASH},
             {"id": 9, "object_type": "price_review", "handoff_class": "B",
              "business_due_at": _t(12, 12), "state": "overdue",
              "escalated_at": None, "payload": EMAIL},
             {"id": 8, "object_type": "cskh_handoff", "handoff_class": "A",
              "business_due_at": _t(13, 11), "state": "on_time",
              "escalated_at": None, "created_by": NAME}],
         "decided": {"approved": 2, "expired": 1},
         "alerts": [("S1", "alcohol_listed", "shopee", 1),
                    ("S2", "price_mismatch", "lazada", 3)],
         "n_leads": 4, "regions": [("Quảng Nam – Đà Nẵng", 1),
                                   ("chưa rõ vùng", 3)],
         "stale_leads": [31, 30], "golden_pending": 2, "unanswered": 1,
         "questions": [f"{NAME} hỏi {PHONE} {EMAIL}"]}
    d.update(over)
    return d


def test_render_bulletin_pure_no_pii_markers():
    now = datetime(2026, 10, 13, 6, 59, tzinfo=VN)
    t1 = sd.render_bulletin(CFG, _data(), now, "day")
    assert t1 == sd.render_bulletin(CFG, _data(), now, "day")
    for s in PII:
        assert s not in t1, s
    assert "BẢN NHÁP" in t1 and "external-dep" in t1 and "GIẢ ĐỊNH" in t1
    assert "ngày 12/10/2026" in t1
    body = t1.split("### Leo thang TGĐ")[1].split("## 2.")[0]
    assert "#9" in body and "#7" not in body
    assert "đã leo thang lúc 12/10/2026 10:05" in t1
    assert "chưa leo thang" in t1
    assert "Tổng: S1 1 · S2 3" in t1 and "#30, #31" in t1
    assert "| Đã duyệt | 2 |" in t1 and "expired" in t1
    # Quá hạn trước, đúng hạn sau.
    assert t1.index("#7 ·") < t1.index("#8 ·")
    assert "alcohol" not in t1                        # mã thô không in


# ---------------------------------------------------------------- DB fixture

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
        schema = f"t_w50_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)       # idempotent ×2
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close CHỈ ghi nhận; rollback → về savepoint `sp` nếu có (giả
    lập rollback tx thật mà không rời tx fixture)."""

    def __init__(self, conn, sp=None):
        self.conn, self.sp = conn, sp
        self.committed = self.rolled_back = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1
        if self.sp:
            self.conn.execute(f"rollback to savepoint {self.sp}")

    def close(self):
        pass


@contextmanager
def _role(conn, role):
    conn.execute(f"set local role {role}")
    try:
        yield
    finally:
        conn.execute("reset role")


def _one(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]


def _replica(conn, sql, params=None):
    conn.execute("set local session_replication_role = replica")
    conn.execute(sql, params)
    conn.execute("set local session_replication_role = origin")


def _alert(conn, kind, sev, status="open", sku="sam-hop-qua", item="it-1"):
    return _one(conn, "insert into market_alerts (kind, severity, channel,"
                " export_kind, item_id, seller_sku, sku_key, detail, status)"
                " values (%s, %s, 'shopee', 'product_list', %s, %s, %s, %s,"
                " %s) returning id",
                (kind, sev, item, f"seller-{item}", sku,
                 Jsonb({"title": f"{NAME} {PHONE}"}), status))


def _gd(conn, kind, sku, status="pending"):
    return _one(conn, "insert into golden_discrepancies (kind, sku_key,"
                " detail, status, source) values (%s, %s, %s, %s,"
                " 'golden_store') returning id",
                (kind, sku, Jsonb({"web": 1}), status))


def _lead(conn, key, ts, question, status="new"):
    return _one(conn, "insert into leads (dedup_key, ts, channel, user_hash,"
                " question, intent, status, source) values (%s, %s, 'zalo',"
                " %s, %s, 'price', %s, 'conversations.jsonl') returning id",
                (key, ts, UHASH, question, status))


def _convlog(tmp_path, recs):
    lines = [json.dumps(r, ensure_ascii=False).encode("utf-8") for r in recs]
    lines.insert(2, b"{corrupt json")
    (tmp_path / "conversations.jsonl").write_bytes(b"\n".join(lines) + b"\n")
    return tmp_path


def _conv(ts, answered, q, msg_id):
    return {"ts": ts, "msg_id": msg_id, "user_hash": UHASH, "question": q,
            "answer": "", "answered": answered}


def _item(conn, ot, oid, created, due=None, title="mục test",
          payload="Việc kiểm thử hàng duyệt khối kinh doanh"):
    """Đẩy mục qua director.submit (agent_writer) rồi đặt created_at/due_at
    (replica). due None → now() + 100h (giữ pending trước expire_overdue)."""
    with _role(conn, AW):
        qid = director.submit(_TxConn(conn), "sales", ot, oid, title, payload,
                              sd.AGENT, cfg=CFG)
    if due is None:
        _replica(conn, "update approval_queue set created_at = %s, due_at ="
                 " now() + interval '100 hours' where id = %s", (created, qid))
    else:
        _replica(conn, "update approval_queue set created_at = %s, due_at ="
                 " %s where id = %s", (created, due, qid))
    return qid


def _count(conn, table, where="true", params=None):
    return _one(conn, f"select count(*) from {table} where {where}", params)


def _verify(conn):
    return conn.execute("select id, problem from verify_action_log()"
                        ).fetchall()


# ---------------------------------------------------------------- W50.3 schema

def test_sla_escalations_schema_and_grants(db):
    qid = _item(db, "price_review", "gd:1", _t(12, 8))
    ins = ("insert into sla_escalations (queue_id, block, handoff_class,"
           " assignee_role, escalate_to_role, business_due_at, red_alert,"
           " created_by) values (%s, 'sales', 'B', 'gd_ban_hang', 'tgd', %s,"
           " false, 'agent:sales_director') on conflict (queue_id) do"
           " nothing returning id")
    with _role(db, AW):
        assert db.execute(ins, (qid, _t(12, 12))).fetchone() is not None
        assert db.execute(ins, (qid, _t(12, 12))).fetchone() is None
    assert _count(db, "sla_escalations") == 1
    for sql in ("update sla_escalations set red_alert = true",
                "delete from sla_escalations", "truncate sla_escalations"):
        with pytest.raises(RaiseException), db.transaction():
            db.execute(sql)
    for sql in ("select detail from market_alerts",
                "select sku_key from market_alerts",
                "select user_hash from leads",
                "select detail from golden_discrepancies",
                "select payload from approval_queue",
                "select title from red_alerts",
                "select red_alert from sla_escalations",
                "update sla_escalations set red_alert = true"):
        with pytest.raises(InsufficientPrivilege), db.transaction():
            db.execute(f"set local role {AW}")
            db.execute(sql)
    with db.transaction():
        db.execute(f"set local role {AH}")
        assert db.execute("select red_alert from sla_escalations"
                          ).fetchall() == [(False,)]
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute(ins.replace("'B'", "'C'"), (qid, _t(12, 12)))


# ---------------------------------------------------------------- W50.4 nguồn

def _sources_fixture(db, tmp_path):
    ids = {"s1": _alert(db, "alcohol_listed", "S1", sku="ruou-sam-45",
                        item="r1"),
           "s2": _alert(db, "price_mismatch", "S2", item="p1"),
           "closed": _alert(db, "item_unmapped", "S2", status="closed",
                            item="c1"),
           "gd": _gd(db, "price_mismatch", "sam-tuoi-1"),
           "spec": _gd(db, "spec_mismatch", "sam-tuoi-2"),
           "resolved": _gd(db, "price_mismatch", "sam-tuoi-3", "resolved")}
    data = _convlog(tmp_path, [
        _conv("2026-10-13T01:00:00Z", False,
              f"Tôi là {NAME}, gọi {PHONE} hoặc {EMAIL} nhé", "m-in"),
        _conv("2026-10-09T00:00:00Z", False, "câu cũ ngoài cửa sổ", "m-old"),
        _conv("2026-10-13T02:00:00Z", True, "câu đã trả lời", "m-ok"),
    ])
    return ids, data


def _src_status(db):
    return (db.execute("select id, status from market_alerts order by id"
                       ).fetchall(),
            db.execute("select id, status from golden_discrepancies order"
                       " by id").fetchall(),
            db.execute("select id, status from leads order by id").fetchall())


def test_collect_enqueue_sources_idempotent(db, tmp_path):
    ids, data = _sources_fixture(db, tmp_path)
    now = _t(13, 12)
    before = _src_status(db)
    tx = _TxConn(db)
    with _role(db, AW):
        items = sd.collect(tx, now, CFG, data)
        assert sorted(i["object_type"] for i in items) == [
            "cskh_handoff", "market_alert_s1", "market_alert_s2",
            "price_review"]
        assert sd.enqueue_new(tx, items, CFG) == 4
        assert sd.collect(tx, now, CFG, data) == []          # chạy lại → 0
        assert sd.enqueue_new(tx, sd.collect(tx, now, CFG, data), CFG) == 0
    rows = db.execute("select id, object_type, object_id, risk, title,"
                      " payload, due_at - created_at, status from"
                      " approval_queue order by id").fetchall()
    assert len(rows) == 4
    for qid, ot, oid, risk, title, payload, gap, status in rows:
        spec = CFG["object_types"][ot]
        assert risk == spec["risk"] and gap == timedelta(
            hours=spec["sla_hours"]) and status == "pending"
        assert guardrail.check(payload)["ok"] is True, (ot, payload)
        for s in (*PII, "ruou", "rượu", "alcohol", "sam-", "seller-", "r1",
                  "Tôi là"):
            assert s not in payload and s not in title, (ot, s)
    got = {r[1]: (r[2], r[3]) for r in rows}
    assert re.fullmatch(rf"ma:{ids['s1']}:\d{{8}}T\d{{12}}Z",
                        got["market_alert_s1"][0])
    assert got["market_alert_s1"][1] == "high"
    assert got["market_alert_s2"][0].startswith(f"ma:{ids['s2']}:")
    assert got["market_alert_s2"][1] == "medium"
    assert got["price_review"] == (f"gd:{ids['gd']}", "high")
    assert got["cskh_handoff"] == (sd.cskh_object_id(
        {"user_hash": UHASH}, datetime(2026, 10, 13, 1, tzinfo=UTC)),
        "medium")
    assert got["cskh_handoff"][0].startswith("cskh:")
    # Mục đã từ chối không bị đẩy lại.
    s2 = next(r[0] for r in rows if r[1] == "market_alert_s2")
    with _role(db, AH):
        assert aq.decide(_TxConn(db), s2, "Hoa (test)", "rejected") == (
            True, None)
    with _role(db, AW):
        assert sd.collect(tx, now, CFG, data) == []
    assert _src_status(db) == before                    # nguồn không đổi
    assert _verify(db) == []


@pytest.mark.parametrize("outcome", ["rejected", "expired"])
def test_market_alert_reopen_is_new_episode(db, tmp_path, outcome):
    """market_csv reopen CÙNG dòng (status open + opened_at mới) → đợt tái
    phát phải thành mục S1 mới (SLA A 2h mới), cùng đợt thì không đẩy lại."""
    aid = _alert(db, "alcohol_listed", "S1", item="rr")
    tx = _TxConn(db)
    with _role(db, AW):
        first = sd.collect(tx, _t(13, 9), CFG, tmp_path)
        assert [i["object_type"] for i in first] == ["market_alert_s1"]
        sd.enqueue_new(tx, first, CFG)
    qid = _one(db, "select id from approval_queue where object_id = %s",
               (first[0]["object_id"],))
    if outcome == "rejected":
        with _role(db, AH):
            assert aq.decide(_TxConn(db), qid, "Hoa (test)", "rejected")[0]
    else:
        _replica(db, "update approval_queue set due_at = %s where id = %s",
                 (_t(1, 9), qid))
        with _role(db, AW):
            assert aq.expire_overdue(_TxConn(db)) == 1
    with _role(db, AW):
        assert sd.collect(tx, _t(13, 10), CFG, tmp_path) == []  # cùng đợt
    # Đóng rồi mở lại như ingest/market_csv.py (cùng id, opened_at mới; tx
    # test có now() hằng nên đặt opened_at tường minh).
    db.execute("update market_alerts set status = 'closed', closed_at = now()"
               " where id = %s", (aid,))
    with _role(db, AW):
        assert sd.collect(tx, _t(14, 9), CFG, tmp_path) == []   # đang đóng
    db.execute("update market_alerts set status = 'open', closed_at = null,"
               " opened_at = opened_at + interval '1 day' where id = %s",
               (aid,))
    with _role(db, AW):
        again = sd.collect(tx, _t(14, 10), CFG, tmp_path)
        assert [i["object_type"] for i in again] == ["market_alert_s1"]
        assert again[0]["object_id"] != first[0]["object_id"]
        assert again[0]["object_id"].startswith(f"ma:{aid}:")
        assert sd.enqueue_new(tx, again, CFG) == 1
        assert sd.collect(tx, _t(14, 10), CFG, tmp_path) == []
    risk, status = db.execute(
        "select risk, status from approval_queue where object_id = %s",
        (again[0]["object_id"],)).fetchone()
    assert (risk, status) == ("high", "pending")


def _conv_u(ts, uh, msg_id, q="[non-text:sticker]"):
    return {"ts": ts, "msg_id": msg_id, "user_hash": uh, "question": q,
            "answer": "", "answered": False}


def test_cskh_flood_grouped_per_user_day_and_capped(db, tmp_path):
    cap = CFG["sources"]["max_cskh_per_run"]
    # 1 khách gửi 60 sticker trong 1 ngày VN + 2 câu ngày VN hôm sau.
    recs = [_conv_u(f"2026-10-12T{h:02d}:{m:02d}:00Z", "uh_spam",
                    f"s-{h}-{m}") for h in range(1, 4) for m in range(20)]
    recs += [_conv_u("2026-10-12T17:30:00Z", "uh_spam", "s-next-1"),
             _conv_u("2026-10-12T18:00:00Z", "uh_spam", "s-next-2")]
    # cap + 5 khách khác nhau, mỗi khách 1 câu.
    recs += [_conv_u("2026-10-12T05:00:00Z", f"uh_{i}", f"u-{i}",
                     f"hỏi giá {i}") for i in range(cap + 5)]
    data = _convlog(tmp_path, recs)
    now = _t(13, 12)
    tx = _TxConn(db)
    with _role(db, AW):
        groups = sd._unanswered(now, CFG, data)
        spam = [g for g in groups if g["object_id"] in {
            sd.cskh_object_id({"user_hash": "uh_spam"}, datetime(
                2026, 10, 12, 1, tzinfo=UTC)),
            sd.cskh_object_id({"user_hash": "uh_spam"}, datetime(
                2026, 10, 12, 18, tzinfo=UTC))}]
        assert sorted(g["n"] for g in spam) == [2, 60]   # 62 tin → 2 nhóm
        assert len(groups) == cap + 5 + 2
        items, deferred = sd._collect(tx, now, CFG, data)
        assert len(items) == cap and deferred == 7
        assert sd.enqueue_new(tx, items, CFG) == cap
        items2, deferred2 = sd._collect(tx, now, CFG, data)  # phần vượt
        assert len(items2) == 7 and deferred2 == 0
        p = sd.plan(tx, now, CFG, data)
        assert p["cskh_deferred"] == 0 and p["enqueue"] == {"cskh_handoff": 7}
    assert _count(db, "approval_queue", "object_type = 'cskh_handoff'") == cap


def test_sweep_red_alert_aggregated_for_cskh_per_item_for_s1(db):
    cskh = [_item(db, "cskh_handoff", f"cskh:{i:04d}", _t(12, 8))
            for i in range(50)]
    s1 = [_item(db, "market_alert_s1", f"ma:{i}:x", _t(12, 8))
          for i in (1, 2)]
    with _role(db, AW):
        p = sd.plan(_TxConn(db), _t(12, 10), CFG, Path("/nonexistent"))
        assert (p["escalate"], p["red_alerts"]) == (52, 3)
        r = sd.sweep(_TxConn(db), _t(12, 10), CFG)
        assert (r["escalated"], r["red_alerts"], r["errors"]) == (52, 3, 0)
        r = sd.sweep(_TxConn(db), _t(12, 10), CFG)               # idempotent
        assert (r["escalated"], r["red_alerts"]) == (0, 0)
    assert _count(db, "sla_escalations") == 52
    rows = db.execute("select title, detail from red_alerts order by id"
                      ).fetchall()
    assert len(rows) == 3
    agg = [d for t, d in rows if "queue_ids" in d]
    assert len(agg) == 1 and agg[0]["n"] == 50
    assert agg[0]["queue_ids"] == cskh and agg[0]["object_type"] == \
        "cskh_handoff"
    assert sorted(d["queue_id"] for t, d in rows if "queue_id" in d) == s1
    assert _verify(db) == []


def test_stale_leads_business_hours(db):
    now = _t(13, 12)                                   # T3 12:00
    old = _lead(db, "k9", _t(12, 13), "giá hộp quà")    # 9 giờ làm việc
    young = _lead(db, "k7", _t(12, 15), "giá lẻ")       # 7 giờ làm việc
    _lead(db, "kd", _t(1, 9), "đã liên hệ", status="contacted")
    # ts cực cũ (nhập tay) — so với hạn quét tiến, không đếm theo tuổi lead.
    ancient = _lead(db, "ka", datetime(1, 1, 2, tzinfo=UTC), "giá")
    with _role(db, AW):
        got = sd.stale_leads(_TxConn(db), now, CFG)
    assert old in got and ancient in got and young not in got
    assert len(got) == 2


# ---------------------------------------------------------------- W50.5 SLA

def test_sweep_class_a_escalates_red_alert_idempotent(db):
    qid = _item(db, "market_alert_s1", "ma:900", _t(12, 8))
    tx = _TxConn(db)
    with _role(db, AW):
        r = sd.sweep(tx, _t(12, 9, 59), CFG)
        assert r["escalated"] == 0 and _count(db, "sla_escalations") == 0
        r = sd.sweep(tx, _t(12, 10), CFG)
        assert (r["escalated"], r["red_alerts"], r["errors"]) == (1, 1, 0)
        r = sd.sweep(tx, _t(12, 10), CFG)                    # idempotent
        assert (r["escalated"], r["red_alerts"]) == (0, 0)
    esc = db.execute("select queue_id, handoff_class, assignee_role,"
                     " escalate_to_role, business_due_at, red_alert,"
                     " created_by from sla_escalations").fetchall()
    assert esc == [(qid, "A", "mxh", "gd_ban_hang", _t(12, 10), True,
                    sd.AGENT)]
    alerts = db.execute("select source_agent, title, detail, recipients,"
                        " route_error from red_alerts").fetchall()
    assert len(alerts) == 1 and alerts[0][0] == "agents.sales_director"
    assert f"#{qid}" in alerts[0][1] and alerts[0][2]["queue_id"] == qid
    assert alerts[0][3] == [] and "thiếu người nhận" in alerts[0][4]
    assert _count(db, "agent_action_log", "action = 'red_alert_raise'") == 1
    assert db.execute("select status from approval_queue where id = %s",
                      (qid,)).fetchone()[0] == "pending"
    assert _verify(db) == []


def test_sweep_weekend_not_counted(db):
    # due_at = created + 72h (sla_hours thật) — `now` tham số vượt quá
    # due mặc định now()+100h của fixture sẽ thành lý do 'expired'.
    qid = _item(db, "cskh_handoff", "convlog:wk", _t(16, 17, 59),
                due=_t(19, 17, 59))
    with _role(db, AW):
        for now in (_t(17, 12), _t(18, 12), _t(19, 9, 58)):
            assert sd.sweep(_TxConn(db), now, CFG)["escalated"] == 0, now
        assert sd.sweep(_TxConn(db), _t(19, 9, 59), CFG)["escalated"] == 1
    assert _one(db, "select queue_id from sla_escalations") == qid


def test_sweep_class_b_escalates_tgd_no_red_alert(db):
    qid = _item(db, "price_review", "gd:77", _t(12, 8))
    with _role(db, AW):
        assert sd.sweep(_TxConn(db), _t(12, 11, 59), CFG)["escalated"] == 0
        r = sd.sweep(_TxConn(db), _t(12, 12), CFG)
    assert (r["escalated"], r["red_alerts"]) == (1, 0)
    assert db.execute("select queue_id, handoff_class, escalate_to_role,"
                      " red_alert from sla_escalations").fetchall() == [
        (qid, "B", "tgd", False)]
    assert _count(db, "red_alerts") == 0


def test_sweep_raise_alert_failure_rolls_back_then_retries(db, monkeypatch):
    _item(db, "market_alert_s1", "ma:901", _t(12, 8))
    real = sd.red_alert.raise_alert

    def boom(*a, **k):
        raise RuntimeError("kênh lỗi giả lập")

    monkeypatch.setattr(sd.red_alert, "raise_alert", boom)
    db.execute("savepoint sweep_sp")
    tx = _TxConn(db, sp="sweep_sp")
    with _role(db, AW):
        r = sd.sweep(tx, _t(12, 10), CFG)
    assert r["errors"] == 1 and r["escalated"] == 0 and tx.rolled_back == 1
    assert _count(db, "sla_escalations") == 0 and _count(db, "red_alerts") == 0
    monkeypatch.setattr(sd.red_alert, "raise_alert", real)
    with _role(db, AW):
        r = sd.sweep(_TxConn(db), _t(12, 10), CFG)
    assert (r["escalated"], r["red_alerts"], r["errors"]) == (1, 1, 0)
    assert _count(db, "sla_escalations") == 1 and _count(db, "red_alerts") == 1


def test_sweep_expires_absolute_never_approves(db):
    qid = _item(db, "b2b_quote", "Q-old", _t(5, 9), due=_t(9, 9))
    n_appr = _count(db, "approvals")
    with _role(db, AW):
        r = sd.sweep(_TxConn(db), _t(12, 10), CFG)
    assert r["expired"] == 1
    assert db.execute("select status, decided_by from approval_queue where"
                      " id = %s", (qid,)).fetchone() == ("expired",
                                                         sd.SWEEP_BY)
    assert _count(db, "decisions", "kind = 'expired' and queue_id = %s",
                  (qid,)) == 1
    assert _count(db, "agent_action_log", "action = 'queue_expire'") == 1
    with _role(db, AH):
        ok, msg = aq.decide(_TxConn(db), qid, "Hoa (test)", "approved")
    assert ok is False and msg
    assert _one(db, "select status from approval_queue where id = %s",
                (qid,)) == "expired"
    assert _count(db, "approvals") == n_appr
    assert _verify(db) == []


def test_sweep_escalates_items_past_due_before_business_due(db):
    """Hạn tuyệt đối tới TRƯỚC hạn giờ làm việc (lễ/Tết) hoặc mục bị expire
    bởi đường khác (director.run, cron chết) → vẫn leo thang + cảnh báo đỏ
    đúng 1 lần, và vẫn expired (không bao giờ approved)."""
    # S1 tạo T6 09/10 17:00 → hạn giờ làm việc T2 12/10 09:00; due_at tuyệt
    # đối T7 10/10 17:00 (như cấu hình có lễ). now = CN 11/10 12:00.
    holiday = _item(db, "market_alert_s1", "ma:950:x", _t(9, 17),
                    due=_t(10, 17))
    # Đã bị expire bởi đường khác TRƯỚC khi agent quét (chưa leo thang).
    other = _item(db, "cskh_handoff", "cskh:other", _t(9, 8), due=_t(10, 9))
    with _role(db, AW):
        assert aq.expire_overdue(_TxConn(db), "system:sla") == 2
    # Lớp B quá cả SLA lẫn due_at + 1 mục expired ngoài cửa sổ 7 ngày.
    b = _item(db, "price_review", "gd:951", _t(5, 8), due=_t(8, 9))
    _item(db, "price_review", "gd:952", _t(1, 8), due=_t(2, 9))
    now = _t(11, 12)
    with _role(db, AW):
        assert sd.sla_state({"object_type": "market_alert_s1",
                             "created_at": _t(9, 17)}, CFG, now)[
            "state"] != "overdue"
        p = sd.plan(_TxConn(db), now, CFG, Path("/nonexistent"))
        assert (p["escalate"], p["red_alerts"]) == (3, 2)
        r = sd.sweep(_TxConn(db), now, CFG)
        assert (r["expired"], r["escalated"], r["red_alerts"], r["errors"]) \
            == (2, 3, 2, 0)
        r = sd.sweep(_TxConn(db), now, CFG)                      # idempotent
        assert (r["escalated"], r["red_alerts"]) == (0, 0)
    esc = dict(db.execute("select queue_id, red_alert from sla_escalations"
                          ).fetchall())
    assert esc == {holiday: True, other: True, b: False}
    rows = db.execute("select title, detail from red_alerts order by id"
                      ).fetchall()
    assert [d["queue_id"] for _, d in rows] == [holiday, other]
    assert all(d["reason"] == "expired" and "Hết hạn tuyệt đối" in t
               for t, d in rows)
    for qid in (holiday, other, b):
        assert _one(db, "select status from approval_queue where id = %s",
                    (qid,)) == "expired"
    assert _count(db, "approvals") == 0
    assert _verify(db) == []


def test_s1_never_auto_approved_even_with_signed_policy(db, tmp_path):
    qid = _item(db, "market_alert_s1", "ma:902", _t(12, 8))
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('s1_test',"
               " 'market_alert_s1', 'low', true, 'Nguoi Ky Gia Lap (test)',"
               " now())")
    with _role(db, AW):
        ok, msg = aq.auto_approve(_TxConn(db), qid)
        assert ok is False and "rủi ro high" in msg
        director.run(_TxConn(db), "sales", now=_t(12, 9), cfg=CFG,
                     out_dir=tmp_path)
    assert _one(db, "select status from approval_queue where id = %s",
                (qid,)) == "pending"
    assert _count(db, "approvals") == 0


# ---------------------------------------------------------------- W50.6 bản tin

def test_gather_matches_sql_and_bulletin_no_pii(db, tmp_path):
    now = datetime(2026, 10, 13, 6, 59, tzinfo=VN)          # kỳ day = 12/10
    _alert(db, "alcohol_listed", "S1", item="a1")
    _alert(db, "price_mismatch", "S2", item="a2")
    _alert(db, "price_mismatch", "S2", item="a3")
    _alert(db, "item_unmapped", "S2", status="closed", item="a4")
    _gd(db, "price_mismatch", "g1")
    _gd(db, "missing_price", "g2")
    _gd(db, "spec_mismatch", "g3")
    _lead(db, "l1", datetime(2026, 10, 11, 17, 30, tzinfo=UTC),
          f"{NAME} ở Huế hỏi giá, gọi {PHONE}")             # 12/10 00:30 VN
    _lead(db, "l2", datetime(2026, 10, 11, 16, 59, tzinfo=UTC),
          f"Đà Nẵng {EMAIL}")                               # 11/10 23:59 VN
    _lead(db, "l3", _t(12, 15), "tiền Thuế thế nào")
    over = _item(db, "market_alert_s1", "ma:1", _t(12, 8),
                 title=f"S1 {NAME} {PHONE}")
    _item(db, "price_review", "gd:1", _t(12, 17))
    _item(db, "cskh_handoff", "convlog:x", _t(12, 9),
          title=f"hỏi {EMAIL}")
    done = _item(db, "b2b_quote", "Q-9", _t(10, 9))
    with _role(db, AH):
        assert aq.decide(_TxConn(db), done, NAME, "rejected")[0] is True
    _replica(db, "update approval_queue set decided_at = %s where id = %s",
             (_t(12, 11), done))
    with _role(db, AW):
        sd.sweep(_TxConn(db), now, CFG)
        data = sd.gather(_TxConn(db), now, CFG, "day", tmp_path)
    n_pend = _count(db, "approval_queue", "status = 'pending' and block ="
                    " 'sales'")
    assert len(data["queue"]) == n_pend == 3
    assert data["decided"] == {"rejected": 1}
    assert sum(n for s, *_, n in data["alerts"] if s == "S1") == _count(
        db, "market_alerts", "status = 'open' and severity = 'S1'") == 1
    assert sum(n for s, *_, n in data["alerts"] if s == "S2") == _count(
        db, "market_alerts", "status = 'open' and severity = 'S2'") == 2
    assert data["golden_pending"] == _count(
        db, "golden_discrepancies", "status = 'pending' and kind in"
        " ('price_mismatch', 'missing_price')") == 2
    assert data["n_leads"] == 2                       # l1 + l3, không l2
    reg = dict(data["regions"])
    assert reg["Miền Trung – Tây Nguyên khác"] == 1 and reg[
        "chưa rõ vùng"] == 1 and reg["Quảng Nam – Đà Nẵng"] == 0
    st = {q["id"]: q for q in data["queue"]}
    assert st[over]["state"] == "overdue" and st[over]["escalated_at"]
    text = sd.render_bulletin(CFG, data, now, "day")
    assert text == sd.render_bulletin(CFG, data, now, "day")
    for s in (*PII, "Thuế", "Huế hỏi"):
        assert s not in text, s
    assert "BẢN NHÁP" in text and "external-dep" in text
    assert f"#{over} · Xử lý cảnh báo sàn S1 · lớp A" in text
    assert "Tổng: S1 1 · S2 2" in text


# ---------------------------------------------------------------- W50.7 dry-run + CLI

TABLES = ("approval_queue", "sla_escalations", "red_alerts",
          "agent_action_log", "decisions", "job_runs")


def test_dry_run_writes_nothing(db, tmp_path):
    _alert(db, "alcohol_listed", "S1", item="d1")
    _item(db, "cskh_handoff", "convlog:d", _t(12, 8), due=_t(15, 8))
    _item(db, "b2b_quote", "Q-d", _t(8, 9), due=_t(12, 9))
    data = _convlog(tmp_path, [_conv("2026-10-12T04:00:00Z", False,
                                     f"gọi {PHONE}", "m-d")])
    before = {t: _count(db, t) for t in TABLES}
    with _role(db, AW):
        p = sd.run(_TxConn(db), _t(12, 12), CFG, data, dry_run=True)
    assert {t: _count(db, t) for t in TABLES} == before
    assert p["dry_run"] is True
    assert p["enqueue"] == {"cskh_handoff": 1, "market_alert_s1": 1}
    # Leo thang: cskh quá SLA (A, đỏ) + b2b quá due_at (B, sắp expired —
    # leo thang TRƯỚC khi mất dấu).
    assert p["expire"] == 1 and p["escalate"] == 2 and p["red_alerts"] == 1


class _FakeRun:
    calls: typing.ClassVar[list] = []

    last: typing.ClassVar[dict | None] = None

    def __init__(self, name):
        _FakeRun.calls.append(name)
        self.d = {"ok": True}           # như job_runs.job_run: mặc định ok

    def __enter__(self):
        _FakeRun.last = self.d
        return self.d

    def __exit__(self, *a):
        return False


@pytest.fixture
def cli(monkeypatch):
    _FakeRun.calls = []
    calls = {"connect": 0}

    def no_db():
        calls["connect"] += 1

    monkeypatch.setattr(sd, "job_run", _FakeRun)
    monkeypatch.setattr(sd, "connect", no_db)
    return calls


def test_cli_job_run_only_when_not_dry(cli, monkeypatch):
    _FakeRun.last = None
    assert sd.main(["--run"]) == 2 and _FakeRun.calls == [sd.JOB]
    assert _FakeRun.last["ok"] is False          # DB down → job_runs ok=False
    _FakeRun.calls, _FakeRun.last = [], None
    assert sd.main(["--run", "--dry-run"]) == 2 and _FakeRun.calls == []
    assert _FakeRun.last is None
    assert sd.main(["--bulletin"]) == 2 and _FakeRun.calls == [sd.JOB]
    assert _FakeRun.last["ok"] is False
    _FakeRun.last = None
    monkeypatch.setattr(sd, "_main", lambda args, now: 0)
    assert sd.main(["--run"]) == 0 and _FakeRun.last["ok"] is True
    _FakeRun.last["ok"] = None
    monkeypatch.setattr(sd, "_main", lambda args, now: 1)
    assert sd.main(["--run"]) == 1 and _FakeRun.last["ok"] is False


@pytest.mark.parametrize("argv", [
    [], ["--dry-run"], ["--bulletin", "--dry-run"],
    ["--run", "--now", "2026-10-12T09:00+07:00"],
    ["--run", "--dry-run", "--now", "2026-10-12T09:00"],
    ["--run", "--dry-run", "--now", "hôm nay"],
    ["--bulletin", "--period", "month"],
])
def test_cli_usage_exit2_before_connect(cli, argv):
    with pytest.raises(SystemExit) as e:
        sd.main(argv)
    assert e.value.code == 2 and cli["connect"] == 0 and _FakeRun.calls == []


def test_cli_bad_config_exit1_before_connect(cli, tmp_path, monkeypatch):
    (tmp_path / "sales.json").write_bytes(b"{broken")
    monkeypatch.setattr(director, "DIRECTORS_DIR", tmp_path)
    assert sd.main(["--run", "--dry-run"]) == 1 and cli["connect"] == 0


def test_cli_dry_run_bulletin_no_pii_output(db, tmp_path, monkeypatch,
                                            capsys):
    _alert(db, "alcohol_listed", "S1", item="c1")
    _lead(db, "lc", _t(12, 10), f"{NAME} {PHONE} {EMAIL}")
    _item(db, "cskh_handoff", "convlog:c", _t(12, 8), title=f"{NAME} {PHONE}")
    data = _convlog(tmp_path, [_conv("2026-10-12T04:00:00Z", False,
                                     f"{NAME} {PHONE} {EMAIL}", "m-c")])
    monkeypatch.setattr(sd, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(sd, "DATA_DIR", data)
    monkeypatch.setattr(sd, "job_run", _FakeRun)
    _FakeRun.calls = []
    before = {t: _count(db, t) for t in TABLES}
    db.execute(f"set local role {AW}")
    rc = sd.main(["--run", "--dry-run", "--bulletin", "--now",
                  "2026-10-13T12:00+07:00"])
    db.execute("reset role")
    out = capsys.readouterr()
    assert rc == 0 and _FakeRun.calls == [], out.err
    assert "[dry-run]" in out.out and "BẢN NHÁP" in out.out
    for s in PII:
        assert s not in out.out and s not in out.err, s
    assert {t: _count(db, t) for t in TABLES} == before
    assert list(tmp_path.glob("sales-director-*")) == []


def test_cli_db_down_exit2():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    t0 = time.monotonic()
    r = subprocess.run([sys.executable, "-m", "agents.sales_director",
                        "--run", "--dry-run"], cwd=ROOT, env=env,
                       capture_output=True, timeout=120, encoding="utf-8",
                       errors="replace", check=False)
    assert r.returncode == 2 and "[error]" in r.stderr, r.stderr
    assert time.monotonic() - t0 < 60     # connect_timeout 3s + khởi động


def test_cli_help_exit0():
    with pytest.raises(SystemExit) as e:
        sd.main(["--help"])
    assert e.value.code == 0


def test_cskh_new_episode_after_decided_same_day(db, tmp_path):
    """Nhóm khách/ngày: pending nuốt tin dồn; đã quyết mà khách hỏi tiếp
    (SAU decided_at) → đợt MỚI có SLA (nghiệm thu v5.0 vòng 3 MINOR)."""
    base = sd.cskh_object_id({"user_hash": UHASH},
                             datetime(2026, 10, 12, 2, tzinfo=UTC))
    recs = [_conv_u("2026-10-12T02:00:00Z", UHASH, "q-0900", "hỏi giá")]
    tx = _TxConn(db)

    def run(now):
        with _role(db, AW):
            items, deferred = sd._collect(tx, now, CFG, _convlog(tmp_path,
                                                                 recs))
            assert deferred == 0
            return items

    def decide(qid, dec, at):
        with _role(db, AH):
            assert aq.decide(_TxConn(db), qid, "Hoa (test)", dec) == (
                True, None)
        _replica(db, "update approval_queue set decided_at = %s where id ="
                 " %s", (at, qid))

    items = run(_t(12, 9, 30))
    assert [i["object_id"] for i in items] == [base]
    with _role(db, AW):
        assert sd.enqueue_new(tx, items, CFG) == 1
    qid1 = db.execute("select id from approval_queue where object_id = %s",
                      (base,)).fetchone()[0]
    # 60 sticker khi mục còn pending → dồn vào mục đó, 0 mục mới.
    recs += [_conv_u(f"2026-10-12T02:{m:02d}:{s:02d}Z", UHASH, f"st-{m}-{s}")
             for m in range(5, 35) for s in (0, 30)]
    assert run(_t(12, 9, 50)) == []
    decide(qid1, "approved", _t(12, 10))
    assert run(_t(12, 15)) == []          # mọi tin ≤ decided_at → đã xử lý
    # 14:00 VN cùng ngày khách hỏi câu mới → đợt mới, SLA mới.
    recs.append(_conv_u("2026-10-12T07:00:00Z", UHASH, "q-1400", "hỏi ship"))
    items = run(_t(12, 15))
    assert [i["object_id"] for i in items] == [f"{base}:20261012T070000Z"]
    assert "1 câu chatbot" in items[0]["payload"]
    assert "12/10/2026 14:00" in items[0]["payload"]
    with _role(db, AW):
        assert sd.enqueue_new(tx, items, CFG) == 1
    assert run(_t(12, 15)) == []                          # idempotent
    qid2 = db.execute("select id from approval_queue where object_id = %s",
                      (items[0]["object_id"],)).fetchone()[0]
    # Đợt 2 bị từ chối 15:30; câu 16:00 → đợt 3 (lấy decided_at MUỘN NHẤT).
    decide(qid2, "rejected", _t(12, 15, 30))
    recs.append(_conv_u("2026-10-12T09:00:00Z", UHASH, "q-1600", "hỏi lại"))
    assert [i["object_id"] for i in run(_t(12, 16, 30))] == [
        f"{base}:20261012T090000Z"]
    # Tin cũ trước decided_at không mở lại đợt; khách khác không bị ảnh hưởng.
    assert _count(db, "approval_queue", "object_type = 'cskh_handoff'") == 2


# ---------------------------------------------------------------- v5.3 mục 6 Catalog & giá

def _catalog():
    return {"pending": {("a4", "listing_sync"): [12, 11],
                        ("a5", "promo_change"): [15],
                        ("a5", "market_alert_s1"): [14]},
            "jobs": {"agents.kd_listing": (_t(12, 8, 30), True),
                     "agents.kd_price": (_t(12, 9), False)}}


def _sec6(text):
    return text.split("## 6. Catalog & giá (A4/A5)")[1].split(
        "## Người duyệt")[0]


def test_render_bulletin_catalog_section_v53():
    now = datetime(2026, 10, 13, 6, 59, tzinfo=VN)
    q = [*_data()["queue"],
         {"id": 15, "object_type": "promo_change", "handoff_class": "B",
          "business_due_at": _t(13, 12), "state": "on_time",
          "escalated_at": None}]
    t = sd.render_bulletin(CFG, _data(queue=q, catalog=_catalog()), now)
    assert t == sd.render_bulletin(CFG, _data(queue=q, catalog=_catalog()),
                                   now)
    sec = _sec6(t)
    assert "| A4 Catalog/listing đa sàn | 12/10/2026 08:30 | ok |" in sec
    assert "| A5 Giá & khuyến mãi | 12/10/2026 09:00 | lỗi |" in sec
    assert ("| A4 Catalog/listing đa sàn | Lệch listing sàn so với bản duyệt"
            " | 2 — #11, #12 |") in sec
    assert ("| A5 Giá & khuyến mãi | Khuyến mãi dự kiến cần xem lại | 1 —"
            " #15 |") in sec
    assert "| A5 Giá & khuyến mãi | Xử lý cảnh báo sàn S1 | 1 — #14 |" in sec
    # Mục 5 "Giá chờ duyệt" đếm thêm promo_change.
    assert "Mục giá đang chờ trong hàng duyệt: 2 — #9, #15" in t
    assert t.index("## 5. Giá chờ duyệt") < t.index("## 6. Catalog") < \
        t.index("## Người duyệt")


def test_render_bulletin_catalog_missing_or_no_privilege():
    now = datetime(2026, 10, 13, 6, 59, tzinfo=VN)
    old = sd.render_bulletin(CFG, _data(), now)      # caller cũ: không khóa
    assert "(chưa có số liệu)" in _sec6(old)
    t = sd.render_bulletin(CFG, _data(catalog={"pending": {}, "jobs": None}),
                           now)
    assert "không đọc được (role thiếu quyền job_runs)" in _sec6(t)
    assert "| — | — | 0 |" in _sec6(t)
    t = sd.render_bulletin(CFG, _data(catalog={"pending": {}, "jobs": {}}),
                           now)
    assert "| A4 Catalog/listing đa sàn | chưa chạy | — |" in _sec6(t)


def test_gather_catalog_counts_a4_a5_db(db, tmp_path):
    now = datetime(2026, 10, 13, 6, 59, tzinfo=VN)
    a4 = _item(db, "listing_sync", "a4:title_drift:shopee:1001:0123456789ab",
               _t(12, 9))
    a5 = _item(db, "market_alert_s1", "a5:promo_banned:shopee:KM1:0123456789ab",
               _t(12, 9))
    _item(db, "price_change", "gd:other", _t(12, 9))       # không phải A4/A5
    db.execute("insert into job_runs (job, started_at, finished_at, ok)"
               " values ('agents.kd_listing', %s, %s, true),"
               " ('agents.kd_listing', %s, %s, false)",
               (_t(11, 8), _t(11, 8, 1), _t(12, 8), _t(12, 8, 2)))
    data = sd.gather(_TxConn(db), now, CFG, "day", tmp_path)
    cat = data["catalog"]
    assert cat["pending"] == {("a4", "listing_sync"): [a4],
                              ("a5", "market_alert_s1"): [a5]}
    assert cat["jobs"] == {"agents.kd_listing": (_t(12, 8, 2), False)}
    text = sd.render_bulletin(CFG, data, now)
    sec = _sec6(text)
    assert "| A4 Catalog/listing đa sàn | 12/10/2026 08:02 | lỗi |" in sec
    assert "| A5 Giá & khuyến mãi | chưa chạy | — |" in sec
    assert f"#{a4}" in sec and f"#{a5}" in sec
    for s in ("ruou", "rượu", "Rượu", "KM1", "1001", "title_drift"):
        assert s not in sec, s
    # Role least-privilege (agent_writer) không đọc job_runs → không crash,
    # tx chia sẻ vẫn dùng tiếp được.
    with _role(db, AW):
        d2 = sd.gather(_TxConn(db), now, CFG, "day", tmp_path)
        assert d2["catalog"]["jobs"] is None
        assert d2["catalog"]["pending"] == cat["pending"]
        assert _one(db, "select count(*) from approval_queue") >= 3
