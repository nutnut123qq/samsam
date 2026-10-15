"""v13.6 (lane c06, F05 phần nội dung + công nợ) — PL01 Marketing "Soạn 3
bài mỗi ngày theo lịch mùa vụ, qua kiểm duyệt trước khi trình" và PL01 Tài
chính "nháp thư nhắc nợ".

Regression F05 (findings.json): trên code cũ KHÔNG có điều phối soạn 3
bài/ngày (`content --daily` không tồn tại, mkt_director chỉ brief) và
acc_ar ghi rõ "KHÔNG thư nhắc nợ" (`--reminders` không tồn tại).

Thuần: ứng viên chủ đề theo lịch (`mkt_calendar.daily_candidates`), nháp
thư nhắc nợ (`acc_ar.reminder_drafts`). DB thật (DATABASE_URL — DB lane):
schema tạm + ROLLBACK, gateway LLM giả (không gọi mạng)."""

import copy
import json
import os
import types
import uuid
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import psycopg
import pytest

from agents import acc_ar as ar
from ingest import golden_store as gs
from pipelines import content, llm_gateway, rollout, store
from pipelines import mkt_calendar as mc

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json").read_text(
    encoding="utf-8"))
HONEY = "mat-ong-sam-300ml"
SAFE = ("Sâm Sâm Quảng Nam — đặc sản quê hương, món quà tặng ý nghĩa."
        "\n\nNội dung có sử dụng AI")
BAD = "Sản phẩm chữa khỏi bệnh tiểu đường.\n\nNội dung có sử dụng AI"
THU = date(2026, 10, 15)          # thứ Năm — ngày làm việc
WED = date(2026, 10, 14)          # mốc NHÁP chiến dịch 20/10 (đăng 17/10)


def _golden(ready=True) -> dict:
    """Golden thật; `ready` → mật ong 300ml tự công bố + kênh facebook/zalo
    (TP_THUONG) — dữ liệu hợp lệ để đủ 3 bài."""
    doc = copy.deepcopy(GOLDEN)
    if ready:
        s = next(x for x in doc["skus"] if x["sku_key"] == HONEY)
        s["self_declaration_ok"] = True
        s["allowed_channels"] = ["shopee", "facebook", "zalo"]
    return doc


def _inputs(ready=True):
    cal, _golden_file, sla = mc.load_inputs()
    return cal, _golden(ready), sla


def _fake_llm(monkeypatch, *texts):
    calls = []

    def _create(model=None, messages=None, **kw):
        calls.append(list(messages or []))
        t = texts[min(len(calls), len(texts)) - 1]
        return types.SimpleNamespace(choices=[types.SimpleNamespace(
            message=types.SimpleNamespace(content=t))])

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm_gateway, "_client", lambda: types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create))))
    return calls


# ============================ 3 bài/ngày — thuần ===========================

def test_calendar_file_has_daily_posts_per_day_3():
    cal = mc.load_calendar()
    assert cal["daily_posts"]["per_day"] == 3       # số HĐ PL01


def test_candidates_campaign_on_draft_milestone_first():
    cal, golden, sla = _inputs(ready=False)
    dc = mc.daily_candidates(cal, golden, WED, sla)
    camp = [c for c in dc["candidates"] if c["kind"] == "campaign"]
    assert [(c["ref"], c["channel"]) for c in camp] == [
        ("c-2010-2026", "facebook"), ("c-2010-2026", "zalo")]
    assert dc["candidates"][:2] == camp
    assert all(c["publish_day"] == date(2026, 10, 17) for c in camp)
    # Ngày khác mốc nháp → không có ô chiến dịch.
    dc2 = mc.daily_candidates(cal, golden, THU, sla)
    assert all(c["kind"] == "evergreen" for c in dc2["candidates"])


def test_candidates_sku_pillar_without_valid_sku_is_refused_not_swapped():
    """Golden hiện tại: 0 SKU đủ readiness bài đăng → trụ gắn SKU mang lý
    do từ chối, KHÔNG lấy SKU khác (rượu/TPBVSK chưa XNQC) cho đủ số."""
    cal, golden, sla = _inputs(ready=False)
    ev = [c for c in mc.daily_candidates(cal, golden, THU, sla)["candidates"]
          if c["kind"] == "evergreen"]
    assert {c["ref"] for c in ev} == {"thuong-hieu", "san-pham",
                                      "vung-trong", "qua-tang"}
    for c in ev:
        if c["ref"] in ("san-pham", "qua-tang"):
            assert c["sku"] is None and "thiếu SKU" in c["reason"]
        else:
            assert c["sku"] is None and c["reason"] is None


def test_candidates_never_alcohol_and_rotate_deterministic():
    cal, golden, sla = _inputs(ready=True)
    for k in range(10):
        dc = mc.daily_candidates(cal, golden, THU + timedelta(days=k), sla)
        for c in dc["candidates"]:
            assert c["sku"] is None or not c["sku"].startswith("ruou")
    a = mc.daily_candidates(cal, golden, THU, sla)
    assert a == mc.daily_candidates(cal, golden, THU, sla)
    b = mc.daily_candidates(cal, golden, THU + timedelta(days=1), sla)
    assert [c["ref"] for c in a["candidates"]] != \
        [c["ref"] for c in b["candidates"]]   # xoay vòng theo ngày
    assert any(c["sku"] == HONEY for c in a["candidates"])


@pytest.mark.parametrize("bad", [
    [], {"per_day": 0, "evergreen": [{"id": "a", "channel": "facebook",
                                      "skus": [], "pillar": "x"}]},
    {"per_day": 10, "evergreen": [{"id": "a", "channel": "facebook",
                                   "skus": [], "pillar": "x"}]},
    {"per_day": 3, "evergreen": []},
    {"per_day": 3, "evergreen": [{"id": "a", "channel": "shopee",
                                  "skus": [], "pillar": "x"}]},
    {"per_day": 3, "evergreen": [{"id": "a", "channel": "zalo",
                                  "skus": "all", "pillar": "x"}]},
    {"per_day": 3, "evergreen": [{"id": "a", "channel": "zalo", "skus": [],
                                  "pillar": " "}]},
    {"per_day": 3, "evergreen": [
        {"id": "a", "channel": "zalo", "skus": [], "pillar": "x"},
        {"id": "a", "channel": "zalo", "skus": [], "pillar": "y"}]},
])
def test_daily_posts_config_fail_closed(bad):
    cal = mc.load_calendar()
    cal["daily_posts"] = bad
    with pytest.raises(mc.CalendarError):
        mc.validate(cal)


def test_missing_daily_posts_raises_not_silent():
    cal, golden, sla = _inputs()
    cal = dict(cal)
    del cal["daily_posts"]
    mc.validate(cal)                     # lịch khác vẫn chạy được
    with pytest.raises(mc.CalendarError, match="daily_posts"):
        mc.daily_candidates(cal, golden, THU, sla)


def test_unknown_sku_in_daily_posts_raises():
    cal, golden, sla = _inputs()
    cal = copy.deepcopy(cal)
    cal["daily_posts"]["evergreen"][0]["skus"] = ["khong-co"]
    with pytest.raises(mc.CalendarError, match="khong-co"):
        mc.daily_candidates(cal, golden, THU, sla)


def test_daily_key_fixed_width():
    assert content.daily_key(THU, 1) == "[daily 2026-10-15 #1]"
    assert len(content.daily_key(THU, 9)) == content.DAILY_KEY_LEN
    with pytest.raises(ValueError):
        content.daily_key(THU, 10)


def test_feature_mapping_marketing_01_and_finance_03_3():
    assert rollout.feature_for(table="content_drafts",
                               created_by=content.DEFAULT_BY,
                               content_type="post") == "marketing-01"
    assert rollout.feature_for(table="approval_queue", block="finance",
                               object_type="ar_reminder",
                               created_by=ar.AGENT) == "finance-03.3"


# ============================ CLI content --daily ==========================

def test_cli_daily_usage_errors_exit_2():
    for argv in (["--daily", "--sku", "a"], ["--daily", "--channel", "web"],
                 ["--daily", "--by", "x"], ["--daily", "--no-llm"],
                 ["--listing", "--sku", "a", "--channel", "shopee",
                  "--date", "2026-10-15"],
                 ["--daily", "--date", "15/10/2026"],
                 ["--daily", "--listing"]):
        with pytest.raises(SystemExit) as e:
            content.main(argv)
        assert e.value.code == 2, argv


def test_cli_daily_db_down_exit_2_before_llm(monkeypatch, capsys):
    calls = _fake_llm(monkeypatch, SAFE)

    @contextmanager
    def dead():
        yield None, "không kết nối được Postgres"

    monkeypatch.setattr(store, "_conn_or_none", dead)
    assert content.main(["--daily", "--date", "2026-10-15"]) == 2
    assert calls == [] and "không ghi được" in capsys.readouterr().err


def test_cli_daily_missing_exit_1_and_lines(monkeypatch, capsys):
    @contextmanager
    def fake_conn():
        yield object(), None

    monkeypatch.setattr(store, "_conn_or_none", fake_conn)
    res = {"day": THU, "per_day": 3, "live": 2, "missing": 1,
           "items": [{"slot": 1, "status": "created", "id": 7,
                      "kind": "evergreen", "ref": "thuong-hieu",
                      "channel": "facebook", "sku": None},
                     {"slot": 2, "status": "skipped", "id": 5}],
           "refused": [{"kind": "evergreen", "ref": "san-pham",
                        "channel": "facebook", "sku": None,
                        "code": "readiness", "reason": "thiếu SKU"}],
           "overflow": [], "reasons": ["chỉ 2/3 chủ đề hợp lệ"]}
    monkeypatch.setattr(content, "daily_batch", lambda *a, **k: res)
    assert content.main(["--daily", "--date", "2026-10-15"]) == 1
    out = capsys.readouterr().out
    assert "#1 evergreen:thuong-hieu × facebook: created #7" in out
    assert "#2 skipped (đã có nháp #5)" in out
    assert "[bị từ chối] evergreen:san-pham × facebook" in out
    assert "[THIẾU] 1/3" in out and "[done] 2/3" in out
    res.update(live=3, missing=0, reasons=[])
    assert content.main(["--daily", "--date", "2026-10-15"]) == 0


def test_cli_daily_rollout_off_exit_2_zero_llm(monkeypatch, capsys):
    calls = _fake_llm(monkeypatch, SAFE)

    @contextmanager
    def fake_conn():
        yield object(), None

    monkeypatch.setattr(store, "_conn_or_none", fake_conn)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    assert content.main(["--daily", "--date", "2026-10-15"]) == 2
    assert calls == [] and "[blocked]" in capsys.readouterr().err


# ============================ thư nhắc nợ — thuần ==========================

AS_OF = date(2026, 10, 12)
SRC = {"DL-01": [("cong_no_T9.csv", "a" * 64)]}


def _e(code="DL-01", kind="phat_sinh", amount=1_000_000, days_ago=40,
       due=None, ref="HD-001", row_no=2):
    return {"row_no": row_no, "dealer_code": code,
            "dealer_type": "ca_nhan", "kind": kind, "doc_ref": ref,
            "doc_date": AS_OF - timedelta(days=days_ago), "due_date": due,
            "amount_vnd": amount, "sku_key": None, "channel": None}


def test_reminder_draft_has_basis_and_placeholders_no_pii():
    ents = [_e(amount=1_000_000, days_ago=60, ref="HD-001", row_no=2),
            _e(amount=2_000_000, days_ago=40, ref="HD-002", row_no=3),
            _e(amount=500_000, days_ago=5, ref="HD-003", row_no=4),
            _e(kind="thanh_toan", amount=-1_200_000, days_ago=3,
               ref="PT-9", row_no=5)]
    res = ar.reminder_drafts(ents, AS_OF, 30, {"DL-01": "active"}, SRC)
    assert res["skipped"] == []
    [d] = res["drafts"]
    body = d["body"]
    # FIFO: 1.2tr trả hết HD-001 (1tr) + 200k HD-002 → còn 1.8tr quá hạn.
    assert d["qua_han"] == 1_800_000
    assert "HD-001" not in body and "HD-002" in body and "1.800.000đ" in body
    assert "HD-003" not in body              # chưa quá hạn → không nhắc
    assert "tổng còn nợ: 2.300.000đ" in body
    assert "02/09/2026" in body and "02/10/2026" in body   # ngày CT + hạn
    assert "10 ngày" in body                 # số ngày quá hạn
    assert "cong_no_T9.csv (sha256 aaaaaaaa)" in body      # nguồn
    for ph in ("{{TEN_DAI_LY}}", "{{NGUOI_LIEN_HE}}", "{{HAN_THANH_TOAN}}",
               "{{NGUOI_KY}}"):
        assert ph in body
    assert "KHÔNG gửi" in body and d["dealer_code"] in d["title"]
    assert d["object_id"].startswith("ar:DL-01:")


def test_reminder_only_dealers_in_registry():
    ents = [_e(code="DL-01"), _e(code="DL-02", row_no=3)]
    res = ar.reminder_drafts(ents, AS_OF, 30, {"DL-01": "ended"}, SRC)
    assert [d["dealer_code"] for d in res["drafts"]] == ["DL-01"]
    assert res["skipped"][0]["dealer_code"] == "DL-02"
    assert "dealers" in res["skipped"][0]["reason"]
    # Không có khoản quá hạn → không soạn, không bỏ qua câm thành thư.
    res2 = ar.reminder_drafts([_e(days_ago=3)], AS_OF, 30,
                              {"DL-01": "active"}, SRC)
    assert res2 == {"drafts": [], "skipped": []}


def test_reminder_object_id_per_debt_state():
    ents = [_e(days_ago=40)]
    d1 = ar.reminder_drafts(ents, AS_OF, 30, {"DL-01": "active"},
                            SRC)["drafts"][0]
    d2 = ar.reminder_drafts(ents, AS_OF + timedelta(days=3), 30,
                            {"DL-01": "active"}, SRC)["drafts"][0]
    assert d1["object_id"] == d2["object_id"]      # cùng trạng thái nợ
    paid = ents + [_e(kind="thanh_toan", amount=-300_000, days_ago=1,
                      row_no=9)]
    d3 = ar.reminder_drafts(paid, AS_OF, 30, {"DL-01": "active"},
                            SRC)["drafts"][0]
    assert d3["object_id"] != d1["object_id"] and d3["qua_han"] == 700_000


def test_reminder_masks_pii_in_file_fields():
    ents = [_e(ref="0905123456")]
    src = {"DL-01": [("Nguyen 0905123456.csv", "b" * 64)]}
    body = ar.reminder_drafts(ents, AS_OF, 30, {"DL-01": "active"},
                              src)["drafts"][0]["body"]
    assert "0905123456" not in body


def test_aging_unchanged_by_refactor():
    ents = [_e(amount=1_000_000, days_ago=60, row_no=2),
            _e(amount=2_000_000, days_ago=40, row_no=3),
            _e(kind="thanh_toan", amount=-1_200_000, days_ago=3, row_no=4)]
    [r] = ar.aging(ents, AS_OF, 30)
    assert r["buckets"] == {"0-30": 0, "31-60": 1_800_000, "61-90": 0,
                            ">90": 0}
    assert r["qua_han"] == 1_800_000 and r["con_no"] == 1_800_000
    assert r["du_co"] == 0


def test_cli_reminders_usage_errors():
    for argv in (["--reminders", "--aging"], ["--aging", "--dry-run"],
                 ["--reminders", "--from", "2026-01-01"]):
        with pytest.raises(SystemExit) as e:
            ar.main(argv)
        assert e.value.code == 2, argv


# ============================ DB thật (schema tạm, ROLLBACK) ===============

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
        schema = f"t_v136_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/rollback/close no-op — dữ liệu ở lại trong tx fixture."""

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


def _drafts(db, day=THU):
    return db.execute(
        "select left(brief, 21), channel, sku, status, created_by,"
        " guardrail->>'ok' from content_drafts where brief like %s"
        " order by id", (f"[daily {day.isoformat()} #%",)).fetchall()


def test_db_daily_three_drafts_then_retry_restart_no_dup(db, monkeypatch):
    gs.load(db, _golden(ready=True))
    tx = _TxConn(db)
    calls = _fake_llm(monkeypatch, SAFE)
    r1 = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
    assert r1["live"] == 3 and r1["missing"] == 0
    assert [it["status"] for it in r1["items"]] == ["created"] * 3
    rows = _drafts(db)
    assert [r[0] for r in rows] == [f"[daily 2026-10-15 #{i}]"
                                    for i in (1, 2, 3)]
    assert all(r[3] == "pending" and r[4] == "agent:mkt02" and r[5] == "true"
               for r in rows)
    assert any(r[2] == HONEY for r in rows)        # bài sản phẩm hợp lệ
    n_llm = len(calls)
    # Retry cùng ngày (cron chạy lại) + "restart" (tiến trình mới): 0 LLM,
    # 0 nháp mới.
    for _ in range(2):
        r = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
        assert [it["status"] for it in r["items"]] == ["skipped"] * 3
        assert r["live"] == 3 and r["missing"] == 0
    assert len(calls) == n_llm and len(_drafts(db)) == 3
    # Ngày làm việc kế tiếp: 3 nháp mới, không đụng ngày trước.
    r = content.daily_batch(tx, THU + timedelta(days=1),
                            inputs=_inputs(ready=True))
    assert r["live"] == 3 and len(_drafts(db)) == 3
    assert len(_drafts(db, THU + timedelta(days=1))) == 3


def test_db_daily_missing_inputs_reported_not_filled(db, monkeypatch):
    """Golden thật (0 SKU đủ readiness bài đăng): chỉ 2 trụ không gắn SKU
    hợp lệ → 2 nháp + THIẾU 1, không sinh bài SKU vi phạm cho đủ số."""
    gs.load(db, _golden(ready=False))
    tx = _TxConn(db)
    calls = _fake_llm(monkeypatch, SAFE)
    r = content.daily_batch(tx, THU, inputs=_inputs(ready=False))
    assert r["live"] == 2 and r["missing"] == 1
    assert r["reasons"] and "2/3" in r["reasons"][0]
    assert {c["ref"] for c in r["refused"]} == {"san-pham", "qua-tang"}
    assert all(row[2] is None for row in _drafts(db))   # không SKU nào
    assert len(calls) == 2


def test_db_daily_guardrail_fail_not_saved_then_redrafted(db, monkeypatch):
    gs.load(db, _golden(ready=True))
    tx = _TxConn(db)
    _fake_llm(monkeypatch, BAD)
    r = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
    assert [it["status"] for it in r["items"]] == ["failed"] * 3
    assert r["missing"] == 3 and _drafts(db) == []
    _fake_llm(monkeypatch, SAFE)
    r = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
    assert r["live"] == 3 and len(_drafts(db)) == 3


def test_db_daily_unique_index_blocks_parallel_dup_rejected_redo(db,
                                                                monkeypatch):
    """Hai tiến trình song song: chốt cuối là index unique; slot bị người
    từ chối thì soạn lại được (không tính là nháp sống)."""
    gs.load(db, _golden(ready=True))
    tx = _TxConn(db)
    key = content.daily_key(THU, 1)
    kw = {"created_by": "agent:mkt02", "content_type": "post"}
    did = store.save_draft(tx, f"{key} a", "facebook", SAFE, {"ok": True},
                           "cli", **kw)
    with pytest.raises(psycopg.errors.UniqueViolation):
        store.save_draft(tx, f"{key} b", "zalo", SAFE, {"ok": True},
                         "cli", **kw)
    # Đua: lần kiểm trước LLM chưa thấy slot (giả lập) → INSERT đụng index
    # → skipped, không nhân bản.
    real = content._DAILY_EXISTING_SQL
    monkeypatch.setattr(content, "_DAILY_EXISTING_SQL",
                        real.replace("brief like %s", "brief like %s and"
                                     " false"))
    calls = _fake_llm(monkeypatch, SAFE)
    r = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
    monkeypatch.setattr(content, "_DAILY_EXISTING_SQL", real)
    assert r["items"][0]["status"] == "skipped"
    assert len(_drafts(db)) == 3 and len(calls) == 3
    db.execute("update content_drafts set status = 'rejected' where id = %s",
               (did,))
    r = content.daily_batch(tx, THU, inputs=_inputs(ready=True))
    assert [it["status"] for it in r["items"]] == ["created", "skipped",
                                                   "skipped"]
    assert len(_drafts(db)) == 4 and r["live"] == 3


def test_db_daily_rollout_off_blocks_before_llm(db, monkeypatch):
    gs.load(db, _golden(ready=True))
    calls = _fake_llm(monkeypatch, SAFE)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        content.daily_batch(_TxConn(db), THU, inputs=_inputs(ready=True))
    assert calls == [] and _drafts(db) == []


def test_db_daily_payload_has_no_slot_key(db, monkeypatch):
    gs.load(db, _golden(ready=True))
    calls = _fake_llm(monkeypatch, SAFE)
    content.daily_batch(_TxConn(db), THU, inputs=_inputs(ready=True))
    sent = json.dumps(calls, ensure_ascii=False)
    assert "[daily" not in sent and "BRIEF: Bài thường ngày" in sent


def _seed_ar(db):
    db.execute("insert into dealers (code, name, region, source) values"
               " ('DL-01', 'Đại lý Tên Giả A', 'mien-trung', 'manual'),"
               " ('DL-03', 'Đại lý Tên Giả C', 'mien-trung', 'manual')")
    ents = [_e(code="DL-01", amount=1_000_000, days_ago=60, row_no=2),
            _e(code="DL-01", amount=2_000_000, days_ago=40, ref="HD-002",
               row_no=3),
            _e(code="DL-02", amount=900_000, days_ago=70, ref="HD-7",
               row_no=4),
            _e(code="DL-03", amount=400_000, days_ago=5, ref="HD-8",
               row_no=5)]
    ar.load(db, ents, "cong_no_T9.csv", "c" * 64)


def _queue(db):
    return db.execute(
        "select block, object_type, object_id, status, created_by,"
        " guardrail->>'ok', payload from approval_queue"
        " where object_type = 'ar_reminder' order by id").fetchall()


def test_db_reminders_enqueue_finance_idempotent(db):
    _seed_ar(db)
    tx = _TxConn(db)
    # Dry-run: in nháp, không ghi hàng duyệt.
    res0 = ar.enqueue_reminders(tx, AS_OF, 30, dry_run=True)
    assert len(res0["drafts"]) == 1 and _queue(db) == []
    res = ar.enqueue_reminders(tx, AS_OF, 30)
    assert [x["dealer_code"] for x in res["enqueued"]] == ["DL-01"]
    assert {x["dealer_code"] for x in res["skipped"]} == {"DL-02"}
    [row] = _queue(db)
    assert row[:6] == ("finance", "ar_reminder", res["drafts"][0]["object_id"],
                       "pending", "agent:acc_ar", "true")
    assert "Tên Giả" not in row[6] and "{{TEN_DAI_LY}}" in row[6]
    assert "3.000.000đ" in row[6] and "cccccccc" in row[6]
    # Chạy lại (cron/restart) → không nhân bản.
    res2 = ar.enqueue_reminders(tx, AS_OF + timedelta(days=1), 30)
    assert res2["enqueued"] == [] and len(_queue(db)) == 1
    assert "đã có" in res2["skipped"][-1]["reason"]


def test_db_reminders_rollout_off_blocked(db, monkeypatch):
    _seed_ar(db)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        ar.enqueue_reminders(_TxConn(db), AS_OF, 30)
    assert _queue(db) == []
