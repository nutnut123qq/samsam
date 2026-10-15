"""v13.3 (lane c03) — cưỡng chế giai đoạn triển khai ở biên thực thi (F03) +
đếm đầu ra thật theo `output_sources` (F04). HĐ 6.7; PL02 mục 1a–c.

Probe tái hiện (findings/probes v13):
  - `rollout_no_reviews`: evaluate('co_nguoi_duyet', 10, 0, 0) từng trả
    ('van_hanh', []) — 10 ngày, 0 đầu ra/duyệt vẫn vận hành.
  - `arbitrary_actor_logs_counted_as_outputs`: 50 log action bất kỳ của
    actor tính năng từng được đếm 50 đầu ra.
  - Zalo/Messenger không đọc `feature_rollout`; tắt/lùi chạy thử không
    chặn gửi khách.
Test cưỡng chế TẮT fixture autouse `_rollout_van_hanh` (conftest) bằng
`rollout._FORCE_MODE = None`. DB thật: schema tạm + ROLLBACK
(`tests.test_da_schema.da_db`).
"""

import json
from collections import OrderedDict
from datetime import datetime, timedelta

import pytest

from agents import kd_quote
from agents.report import write_report
from connectors import channels, zalo
from pipelines import approval_queue as aq
from pipelines import rollout as ro
from pipelines import store
from pipelines.period import VN_TZ
from tests.test_da_schema import TxConn, da_db
from tests.test_rollout import SRC, _doc, _f, _out, _write

BY = "Quản lý AI MẪU"
HUMAN = "GĐ bán hàng"
NOW = datetime.now(VN_TZ)
SHIFT = ro.load_shift()
CAT = [
    _f("ceo-01", output_sources=[SRC]),
    _f("ceo-03", agent_ids=[], output_sources=[{"report": "ceo-risk-"}]),
    _f("sales-01", agent_ids=["agent:kd_a1"], output_sources=[
        {"table": "approval_queue", "block": "sales",
         "object_type": "cskh_reply", "created_by": "agent:kd_a1"}]),
    _f("sales-05", agent_ids=["agent:kd_quote"], output_sources=[
        {"table": "approval_queue", "block": "sales",
         "object_type": "b2b_quote"},
        {"table": "approval_queue", "block": "sales",
         "object_type": "org_prospect_batch"}]),
    _f("marketing-01", agent_ids=["agent:mkt02"], output_sources=[
        {"table": "content_drafts", "created_by": "agent:mkt02",
         "content_type": "post"}]),
]
PAYLOAD = "Báo cáo tuần: doanh thu kênh sàn tăng so với tuần trước."
TEXT_OK = "Quà biếu gia đình dịp Tết.\nNội dung có sử dụng AI"


@pytest.fixture
def enforce(monkeypatch, tmp_path):
    """Cưỡng chế THẬT: bỏ ép van_hanh + danh mục test + config enforce."""
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "FEATURES_FILE", _write(tmp_path, _doc(CAT)))
    cfg = tmp_path / "rollout_config.json"
    cfg.write_bytes(json.dumps({"enforce": True, "workdays": [0, 1, 2, 3, 4],
                                "holidays": []}).encode("utf-8"))
    monkeypatch.setattr(ro, "CONFIG_FILE", cfg)
    return cfg


@pytest.fixture
def db(enforce):
    for conn in da_db():
        yield TxConn(conn)


def _stage(conn, fid, stage):
    """Đặt giai đoạn trực tiếp (owner trong schema tạm) — test biên, không
    test cổng nâng (đã có ở test_rollout)."""
    ro.seed(conn, [f for f in CAT if f["id"] == fid], BY,
            now=NOW - timedelta(days=1))
    conn.execute("update feature_rollout set stage = %s where feature_id"
                 " = %s", (stage, fid))


# ------------------------------------------------------------ probe thuần


def test_probe_review_stage_no_outputs_not_van_hanh():
    """F03 probe `rollout_no_reviews`: 10 ngày + 0 đầu ra + 0 duyệt."""
    t, why = ro.evaluate("co_nguoi_duyet", 10, 0, 0)
    assert t == "van_hanh" and why, "10 ngày không đầu ra không được vận hành"
    # 10 ngày + đầu ra nhưng KHÔNG ai là người duyệt → vẫn chưa.
    assert ro.evaluate("co_nguoi_duyet", 10, 20, 0, 5, 0, 0)[1]
    assert ro.evaluate("co_nguoi_duyet", 10, 20, 0, 5, 3, 2)[1]
    assert ro.evaluate("co_nguoi_duyet", 10, 20, 0, 5, 3, 0)[1] == []


def test_mode_fail_closed_without_db(enforce, tmp_path):
    assert ro.mode(None, "ceo-01") == "chay_thu"
    assert ro.mode(None, None) == "chay_thu"
    off = tmp_path / "off.json"
    off.write_bytes(b'{"enforce": false, "workdays": [0]}')
    assert ro.enforce_enabled(off) is False
    for bad in (b"{", b'{"enforce": 0}', b'{"enforce": "false"}', b"[]"):
        off.write_bytes(bad)
        assert ro.enforce_enabled(off) is True, bad
    assert ro.enforce_enabled(tmp_path / "missing.json") is True
    real = json.loads(ro.ROOT.joinpath("data", "rollout_config.json")
                      .read_bytes().decode("utf-8"))
    assert real["enforce"] is True


def test_enforce_false_restores_old_behaviour(enforce):
    enforce.write_bytes(b'{"enforce": false, "workdays": [0,1,2,3,4]}')
    assert ro.mode(None, "ceo-01") == "van_hanh"
    assert ro.use_reason(None, None, "x", False) is None


def test_feature_for_mapping(enforce):
    ff = ro.feature_for
    assert ff(table="approval_queue", block="ceo",
              object_type="weekly_report", created_by="agent:x") == "ceo-01"
    assert ff(table="approval_queue", block="sales", object_type="cskh_reply",
              created_by="agent:kd_a1") == "sales-01"
    # created_by là ràng buộc của nguồn sales-01 → actor khác không thuộc.
    assert ff(table="approval_queue", block="sales", object_type="cskh_reply",
              created_by="agent:khac") is None
    assert ff(table="approval_queue", block="ceo", object_type="lạ",
              created_by="x") is None
    # Khối cũ 'projects' (trước v12.0) → khớp theo loại nếu duy nhất.
    assert ff(table="approval_queue", block="projects",
              object_type="org_prospect_batch", created_by="x") == "sales-05"
    assert ff(table="content_drafts", created_by="agent:mkt02",
              content_type="post") == "marketing-01"
    assert ro.feature_for_report("ceo-risk-2026-10.md") == "ceo-03"
    assert ro.feature_for_report("report-2026.md") is None


def test_catalog_rejects_overlapping_sources(tmp_path):
    """Không đếm chéo: nguồn không created_by (mọi actor) giao với nguồn
    có created_by cùng khối/loại của mục khác."""
    a = _f("sales-01", agent_ids=[], output_sources=[
        {"table": "approval_queue", "block": "sales",
         "object_type": "cskh_reply"}])
    b = _f("sales-02", agent_ids=[], output_sources=[
        {"table": "approval_queue", "block": "sales",
         "object_type": "cskh_reply", "created_by": "agent:kd_a1"}])
    with pytest.raises(ValueError, match="giao phạm vi"):
        ro.load_features(_write(tmp_path, _doc([a, b])))
    r1 = _f("intel-02", agent_ids=[], output_sources=[
        {"table": "red_alerts", "source_agent": "s", "rules_any": ["x"]}])
    r2 = _f("legal_hr-07", agent_ids=[], output_sources=[
        {"table": "red_alerts", "source_agent": "s", "rules_any": ["y"]}])
    assert len(ro.load_features(_write(tmp_path, _doc([r1, r2])))) == 2
    r2["output_sources"][0]["rules_any"] = ["y", "x"]
    with pytest.raises(ValueError, match="giao phạm vi"):
        ro.load_features(_write(tmp_path, _doc([r1, r2])))
    assert len(ro.load_features()) > 0     # danh mục thật không giao nhau


def test_holiday_warning(tmp_path):
    p = tmp_path / "c.json"
    p.write_bytes(b'{"workdays": [0], "holidays": []}')
    assert "chưa chốt" in ro.holiday_warning(p)
    p.write_bytes(b'{"workdays": [0], "holidays": ["2027-02-16"]}')
    assert ro.holiday_warning(p) is None


# ------------------------------------------------------------ đếm đầu ra


def test_probe_arbitrary_actor_logs_not_outputs(db):
    """F04 probe: 50 log action bất kỳ của actor tính năng ≠ 50 đầu ra."""
    t0 = NOW - timedelta(days=30)
    ro.seed(db, CAT, BY, now=t0)
    for i in range(50):
        db.execute("insert into agent_action_log (actor, action, object_type,"
                   " object_id) values ('agent:t_b1', 'audit_not_an_output',"
                   " 't', %s)", (str(i),))
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, CAT, "ceo-01", BY, SHIFT)
    assert ro.output_facts(db, CAT[0], t0, NOW, SHIFT)["outputs"] == 0


def test_outputs_distinct_no_retry_sample_cross_or_guardrail_fail(db):
    t0 = NOW - timedelta(days=30)
    _out(db, 10, t0, oid="r", status="rejected", lane="per_item",
         decided_by=HUMAN)
    _out(db, 10, t0, oid="r")                     # xếp lại cùng object_id
    _out(db, 7, t0, oid="sample")                 # mục mẫu
    _out(db, 7, t0, oid="t", title="Báo cáo tuần (MẪU)")
    _out(db, 7, t0, oid="g", ok=False)            # guardrail không đạt
    _out(db, 7, t0, oid="k", otype="weekly_board")  # loại của tính năng khác
    _out(db, 7, t0, oid="b", block="sales")       # khối khác
    o = ro.output_facts(db, CAT[0], t0, NOW, SHIFT)
    assert o["outputs"] == 10 and o["out_days"] == 5
    # Lần đầu bị từ chối, lần xếp lại đang chờ → chưa ai duyệt.
    assert (o["human"], o["unapproved"], o["uncounted"]) == (0, 0, [])
    # Cửa sổ giai đoạn: mốc sau mọi đầu ra → 0.
    assert ro.output_facts(db, CAT[0], NOW - timedelta(minutes=1), NOW,
                           SHIFT)["outputs"] == 0


def test_outputs_unapproved_by_human_flagged(db):
    t0 = NOW - timedelta(days=30)
    _out(db, 2, t0, oid="a", status="approved", lane="auto_policy",
         decided_by="system:auto_policy")
    _out(db, 1, t0, oid="g", status="approved", lane="per_item",
         decided_by="agent:kd_quote")
    _out(db, 3, t0, oid="h", status="approved", lane="per_item",
         decided_by=HUMAN)
    o = ro.output_facts(db, CAT[0], t0, NOW, SHIFT)
    assert (o["outputs"], o["human"], o["unapproved"]) == (6, 3, 3)


def test_outputs_content_drafts_distinct_text(db):
    t0 = NOW - timedelta(days=30)
    ins = ("insert into content_drafts (created_at, brief, channel, text,"
           " guardrail, source, created_by, content_type, status, reviewer)"
           " values (%s, %s, 'facebook', %s, %s::jsonb, %s, %s, %s, %s, %s)")
    ok, bad = json.dumps({"ok": True}), json.dumps({"ok": False})
    rows = [
        (t0 + timedelta(days=1), "b", "bài 1", ok, "cli", "agent:mkt02",
         "post", "approved", HUMAN),
        (t0 + timedelta(days=2), "b", "bài 1", ok, "cli", "agent:mkt02",
         "post", "pending", None),                # sinh lại cùng nội dung
        (t0 + timedelta(days=3), "b", "bài 2", ok, "cli", "agent:mkt02",
         "post", "approved", "agent:mkt02"),
        (t0 + timedelta(days=3), "b", "bài 3", ok, "sample:x", "agent:mkt02",
         "post", "pending", None),
        (t0 + timedelta(days=3), "b (MẪU)", "bài 4", ok, "cli",
         "agent:mkt02", "post", "pending", None),
        (t0 + timedelta(days=3), "b", "bài 5", bad, "cli", "agent:mkt02",
         "post", "pending", None),
        (t0 + timedelta(days=3), "b", "bài 6", ok, "cli", "agent:mkt02",
         "listing", "pending", None),
        (t0 + timedelta(days=3), "b", "bài 7", ok, "cli", "agent:khac",
         "post", "pending", None),
    ]
    for r in rows:
        db.execute(ins, r)
    o = ro.output_facts(db, CAT[4], t0, NOW, SHIFT)
    assert (o["outputs"], o["human"], o["unapproved"]) == (2, 1, 1)


# ------------------------------------------------------------ mode() + DB


def test_mode_reads_ledger_and_fails_closed(db):
    assert ro.mode(db, "ceo-01") == "chay_thu"          # chưa vào sổ
    ro.seed(db, CAT, BY, now=NOW - timedelta(days=3))
    assert ro.mode(db, "ceo-01") == "chay_thu"
    db.execute("update feature_rollout set stage = 'van_hanh'")
    assert ro.mode(db, "ceo-01") == "van_hanh"
    ro.record_severe(db, "ceo-01", "lo_pii", BY)        # lỗi → chặn NGAY
    assert ro.mode(db, "ceo-01") == "chay_thu"
    ro.disable(db, "sales-05", BY)
    assert ro.mode(db, "sales-05") == "tat"
    db.execute("alter table feature_rollout rename to feature_rollout_x")
    try:
        assert ro.mode(db, "sales-05") == "chay_thu"    # bảng thiếu
        assert db.execute("select 1").fetchone() == (1,)  # tx còn dùng được
    finally:
        db.execute("alter table feature_rollout_x rename to feature_rollout")


def test_agent_role_reads_stage_so_off_blocks_generation(db):
    """Agent chạy bằng role agent_writer phải thấy 'tat' — nếu không đọc
    được bảng, mode() về chạy thử và tính năng tắt vẫn sinh được."""
    _stage(db, "ceo-01", "tat")
    db.execute("set local role agent_writer")
    try:
        assert ro.mode(db, "ceo-01") == "tat"
        with pytest.raises(ro.RolloutBlocked):
            ro.check_generate(db, "ceo-01", "x")
    finally:
        db.execute("reset role")


# ------------------------------------------------------------ biên hàng duyệt


def _enq(conn, otype="weekly_report", block="ceo", by="agent:t_b1",
         oid="w-1", payload=PAYLOAD):
    return aq.enqueue(conn, object_type=otype, object_id=oid, block=block,
                      title="t", payload=payload, risk="low",
                      created_by=by, sla_hours=72)


def test_enqueue_blocked_only_when_off(db):
    _stage(db, "ceo-01", "chay_thu")
    assert _enq(db) > 0                       # chạy thử: ghi nội bộ được
    db.execute("update feature_rollout set stage = 'tat'")
    with pytest.raises(ro.RolloutBlocked, match="TẮT|tắt"):
        _enq(db, oid="w-2")
    assert db.execute("select count(*) from approval_queue where object_id"
                      " = 'w-2'").fetchone()[0] == 0


def test_pending_item_of_disabled_feature_cannot_be_approved(db):
    _stage(db, "ceo-01", "chay_thu")
    qid = _enq(db)
    ro.disable(db, "ceo-01", BY)
    ok, why = aq.decide(db, qid, HUMAN, "approved")
    assert not ok and "tắt" in why
    ok, _ = aq.decide(db, qid, HUMAN, "rejected")   # dọn hàng vẫn được
    assert ok


def test_verify_use_gate_by_stage(db, capsys):
    _stage(db, "ceo-01", "chay_thu")
    qid = _enq(db)
    assert aq.decide(db, qid, HUMAN, "approved") == (True, None)
    assert aq.verify(db, qid, PAYLOAD) is False      # chạy thử: không dùng
    assert "chạy thử" in capsys.readouterr().err
    for st, want in (("co_nguoi_duyet", True), ("van_hanh", True),
                     ("tat", False)):
        db.execute("update feature_rollout set stage = %s", (st,))
        assert aq.verify(db, qid, PAYLOAD) is want, st
    db.execute("update feature_rollout set stage = 'van_hanh'")
    assert aq.verify(db, qid, PAYLOAD + "x") is False   # vẫn kiểm sha


def test_verify_review_stage_needs_human_per_item(db):
    _stage(db, "ceo-01", "co_nguoi_duyet")
    _out(db, 1, NOW - timedelta(days=10), days=1, oid="auto",
         status="approved", lane="auto_policy",
         decided_by="system:auto_policy")
    qid = db.execute("select id from approval_queue where object_id like"
                     " 'auto-%'").fetchone()[0]
    meta = aq._meta(db, qid)
    assert "NGƯỜI" in aq.use_reason(db, meta)
    db.execute("update feature_rollout set stage = 'van_hanh'")
    assert aq.use_reason(db, meta) is None


def test_unmapped_item_use_fail_closed(db):
    qid = _enq(db, otype="weekly_board", oid="x-1")   # không thuộc CAT
    assert aq.decide(db, qid, HUMAN, "approved") == (True, None)
    assert aq.verify(db, qid, PAYLOAD) is False


def test_kd_quote_verify_send_boundary(db, tmp_path):
    """Biên GỬI thật (--verify-send): bản đã duyệt + file khớp sha vẫn bị
    từ chối khi tính năng chạy thử; vận hành thì qua."""
    _stage(db, "sales-05", "chay_thu")
    qid = _enq(db, otype="b2b_quote", block="sales", by="agent:kd_quote",
               oid="q-1", payload="Báo giá quà Tết: 10 hộp trà sâm.")
    assert aq.decide(db, qid, HUMAN, "approved") == (True, None)
    f = tmp_path / "bg.md"
    f.write_bytes("Báo giá quà Tết: 10 hộp trà sâm.".encode())
    assert kd_quote.verify_send(db, qid, f) is False
    ok, _ = kd_quote.export(db, qid, tmp_path / "out.md")
    assert not ok and not (tmp_path / "out.md").exists()
    db.execute("update feature_rollout set stage = 'van_hanh'")
    assert kd_quote.verify_send(db, qid, f) is True


# ------------------------------------------------------------ biên nháp nội dung


def test_content_draft_generate_decide_schedule(db):
    _stage(db, "marketing-01", "tat")
    with pytest.raises(ro.RolloutBlocked):
        store.save_draft(db, "b", "facebook", TEXT_OK, {"ok": True},
                         created_by="agent:mkt02")
    db.execute("update feature_rollout set stage = 'chay_thu'")
    did = store.save_draft(db, "b", "facebook", TEXT_OK, {"ok": True},
                           created_by="agent:mkt02")
    assert store.set_status(db, did, "approved", HUMAN) == (True, None)
    today = store._vn_today()
    ok, why = store.schedule(db, did, today, by=HUMAN, today=today)
    assert not ok and "chạy thử" in why
    db.execute("update feature_rollout set stage = 'co_nguoi_duyet'")
    assert store.schedule(db, did, today, by=HUMAN, today=today) == (
        True, None)
    did2 = store.save_draft(db, "b", "facebook", TEXT_OK + ".", {"ok": True},
                            created_by="agent:mkt02")
    db.execute("update feature_rollout set stage = 'tat'")
    ok, why = store.set_status(db, did2, "approved", HUMAN)
    assert not ok and "tắt" in why


# ------------------------------------------------------------ biên báo cáo


def test_report_generation_blocked_when_off(db, monkeypatch, tmp_path):
    monkeypatch.setattr(ro, "connect", lambda: db)
    _stage(db, "ceo-03", "tat")
    with pytest.raises(ro.RolloutBlocked):
        write_report("x", tmp_path, "ceo-risk-2026-10.md")
    assert not (tmp_path / "ceo-risk-2026-10.md").exists()
    db.execute("update feature_rollout set stage = 'chay_thu'")
    assert write_report("x", tmp_path, "ceo-risk-2026-10.md").exists()
    monkeypatch.setattr(ro, "connect", lambda: pytest.fail("không mở DB"))
    assert write_report("x", tmp_path, "report-khac.md").exists()


# ------------------------------------------------------------ biên chatbot


@pytest.fixture
def chat(monkeypatch, tmp_path):
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "_histories", OrderedDict())
    got = {"sent": [], "sugg": [], "handoff": [], "calls": 0}

    def _answer(q, history=None):
        got["calls"] += 1
        return {"answer": "Sâm Ngọc Linh hộp 10 củ giá 1.500.000 đ.",
                "sources": ["https://samsamngoclinh.com/san-pham"]}
    monkeypatch.setattr("api.rag.answer", _answer)
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: got["sent"].append(t) or True)
    monkeypatch.setattr(channels, "record_suggestion",
                        lambda inb, t, m="", conn=None, raw=None:
                        got["sugg"].append(t) or 7)
    monkeypatch.setattr(channels, "record_handoff",
                        lambda inb, r, m="", conn=None:
                        got["handoff"].append(r))
    return got


def _log_rows(path):
    return [json.loads(x) for x in path.read_bytes().split(b"\n") if x]


@pytest.mark.parametrize("md", ["chay_thu", "co_nguoi_duyet"])
def test_chatbot_not_operating_holds_bot_answer(monkeypatch, chat, md):
    monkeypatch.setattr(channels, "chatbot_mode", lambda: md)
    r = zalo.handle_text("u1", "giá hộp 10 củ?", "m1")
    assert chat["sent"] == [zalo.HOLD_TEXT] and r["rollout"] == md
    assert "1.500.000" not in chat["sent"][0]
    assert chat["calls"] == 1 and chat["sugg"] == [
        ("Sâm Ngọc Linh hộp 10 củ giá 1.500.000 đ.\nNguồn: "
         "https://samsamngoclinh.com/san-pham")]
    assert chat["handoff"] == ["rollout"]
    e = _log_rows(zalo.CONV_LOG)[-1]
    assert (e["rollout"], e["answered"], e["suggestion_id"]) == (md, False, 7)
    assert not zalo._histories.get("u1")      # bot chưa trả lời khách
    # Messenger dùng chung pipeline.
    zalo.handle_text("p1", "giá?", "m2", channel="messenger")
    assert chat["sent"][-1] == zalo.HOLD_TEXT


def test_chatbot_off_no_ai_call(monkeypatch, chat):
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "tat")
    zalo.handle_text("u1", "giá?", "m1")
    assert chat["calls"] == 0 and chat["sugg"] == []
    assert chat["sent"] == [zalo.HOLD_TEXT] and chat["handoff"] == ["rollout"]


def test_chatbot_operating_sends_answer(monkeypatch, chat):
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "van_hanh")
    zalo.handle_text("u1", "giá?", "m1")
    assert chat["sent"][0].startswith("Sâm Ngọc Linh hộp 10 củ")
    assert chat["sugg"] == []


def test_chatbot_hold_keeps_health_template(monkeypatch, chat):
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "chay_thu")
    monkeypatch.setattr("api.rag.answer", lambda q, history=None: {
        "answer": "x", "sources": [], "handoff": "health"})
    zalo.handle_text("u1", "câu lớp 2", "m1")
    assert chat["sent"] == [channels.template("health")]
    assert chat["sugg"] == [] and chat["handoff"] == ["health"]


def test_chatbot_mode_db_down_fail_closed(enforce, monkeypatch):
    monkeypatch.setattr(channels, "_connect", lambda: None)
    assert channels.chatbot_mode() == "chay_thu"


def test_suggestion_saved_internally_not_usable(db, monkeypatch):
    """Gợi ý cskh_reply ghi thật vào hàng duyệt khối sales (đã che PII),
    nhưng chatbot chạy thử → dùng (verify) bị chặn."""
    monkeypatch.setenv("CHANNEL_HASH_SALT", "muoi-test-0123456789")
    _stage(db, "sales-01", "chay_thu")
    inb = channels.normalize("zalo", "u1", "giá?")
    sid = channels.record_suggestion(
        inb, "Gọi 0905123456 để đặt.\nNguồn: https://x/sam-chua-benh",
        "m1", conn=db, raw="Gọi 0905123456 để đặt.")
    row = db.execute("select block, object_type, created_by, payload,"
                     " coalesce(guardrail->>'ok', '') from approval_queue"
                     " where id = %s", (sid,)).fetchone()
    assert row[:3] == ("sales", "cskh_reply", "agent:kd_a1")
    assert "0905123456" not in row[3] and "Nguồn" not in row[3]
    assert row[4] == "true"
    assert aq.decide(db, sid, HUMAN, "approved") == (True, None)
    assert aq.verify(db, sid, row[3]) is False
    db.execute("update feature_rollout set stage = 'co_nguoi_duyet'")
    assert aq.verify(db, sid, row[3]) is True
