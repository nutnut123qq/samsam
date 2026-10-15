"""v14.3 (lane p3) — rollout phủ đủ biên (HĐ 6.7; PL02 mục 1a–c; F03/F04
còn hở sau v13). Mỗi test dưới FAIL trên code cũ (f9aed60) trừ khi ghi khác:

  - Bộ đếm đầu ra nguồn `report` (sổ `report_outputs`) + nguồn bảng riêng
    (DISTINCT khóa tự nhiên, loại mẫu theo cột provenance) — code cũ trả
    `outputs=None` ("không đếm được") cho mọi nguồn ngoài approval_queue/
    content_drafts → tính năng chỉ có report/bảng riêng không bao giờ nâng.
  - Cờ mẫu `approval_queue.is_sample` (thay quy ước tên): gói HĐTV dựng trên
    số MẪU có tiêu đề KHÔNG chứa 'MẪU' → code cũ đếm như đầu ra thật.
  - created_by cho object_type dùng chung: `market_alert_s1` của kd_listing
    (sales-03) bị code cũ đếm vào sales-06.1 (đếm chéo).
  - `channels --suggest` ghi đầu ra `san_suggestions` (không PII) + chỉ
    `--mark-sent` khi giai đoạn cho dùng.
  - `qr_trace site` khi tính năng chưa cho dùng: trang đã công khai từ
    trước bị THAY bằng trang tạm ngưng (code cũ để nguyên lời văn lô).
  - Agent tự ghi bảng riêng chặn khi TẮT: allocation_proposals, recon_results,
    audit_runs, sim_runs, affiliate_attributions, revenue_quarters,
    channel_snapshots (--collect); gói HĐTV.
DB thật: schema tạm + ROLLBACK (`tests.test_da_schema.da_db`).
"""

import hashlib
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from agents import bks_audit, garden, hdtv_report, kd_affiliate, rev_share
from agents.report import write_report
from connectors import channels
from ingest import settlement_csv
from pipelines import approval_queue as aq
from pipelines import cockpit, production
from pipelines import qr_trace as q
from pipelines import rollout as ro
from pipelines.period import VN_TZ
from tests.test_da_schema import TxConn, da_db
from tests.test_qr_trace import (  # noqa: F401 — fixture db/proxy/run
    H1,
    LOT,
    _code,
    _harvest,
    _media,
    _mk_lot,
    _plot,
    _sign,
    db,
    proxy,
    run,
)
from tests.test_rollout import _doc, _f, _write

ROOT = Path(__file__).resolve().parent.parent
BY = "Quản lý AI"
NOW = datetime.now(VN_TZ)
SHIFT = ro.load_shift()
T0 = NOW - timedelta(days=30)


def _ff(fid, srcs):
    return _f(fid, agent_ids=[], output_sources=srcs)


CAT = [
    _ff("ceo-03", [{"report": "ceo-risk-"}]),
    _ff("ceo-04.2", [{"table": "audit_runs", "kind": "inside_out"}]),
    _ff("ceo-04.1", [{"table": "audit_runs", "kind": "recon"}]),
    _ff("ceo-05", [{"table": "approval_queue", "block": "ceo",
                    "object_type": "hdtv_pack"}]),
    _ff("sales-02", [{"table": "san_suggestions"}]),
    _ff("production-01", [{"table": "allocation_proposals"}]),
    _ff("production-04.1", [{"table": "production_lots"}]),
    _ff("farming-01", [{"table": "plot_logs", "source": "zalo:garden"}]),
    _ff("intel-02", [{"table": "red_alerts", "source_agent": "intel_red_alert",
                      "rules_any": ["brand_negative"]}]),
    _ff("intel-05", [{"table": "sim_runs"}]),
    _ff("finance-01", [{"table": "recon_results"}]),
    _ff("finance-03.2", [{"table": "affiliate_attributions"}]),
    _ff("finance-06", [{"table": "revenue_quarters"}]),
    _ff("marketing-06.2", [{"table": "channel_snapshots"}]),
]


def _cat(fid):
    return next(f for f in CAT if f["id"] == fid)


@pytest.fixture
def enforce(monkeypatch, tmp_path):
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "FEATURES_FILE", _write(tmp_path, _doc(CAT)))
    cfg = tmp_path / "rollout_config.json"
    cfg.write_bytes(json.dumps({"enforce": True, "workdays": [0, 1, 2, 3, 4],
                                "holidays": []}).encode("utf-8"))
    monkeypatch.setattr(ro, "CONFIG_FILE", cfg)
    return cfg


@pytest.fixture
def cdb(enforce, monkeypatch):
    for conn in da_db():
        t = TxConn(conn)
        monkeypatch.setattr(ro, "connect", lambda t=t: t)
        yield t


def _stage(conn, fid, stage):
    ro.seed(conn, [_cat(fid)], BY, now=NOW - timedelta(days=1))
    conn.execute("update feature_rollout set stage = %s where feature_id"
                 " = %s", (stage, fid))


def _facts(conn, fid):
    return ro.output_facts(conn, _cat(fid), T0, datetime.now(VN_TZ), SHIFT)


def _n(conn, table, where="true", params=()):
    return conn.execute(f"select count(*) from {table} where {where}",
                        params).fetchone()[0]


# ------------------------------------------------------------ bộ đếm report


def test_report_outputs_counted_distinct_without_sample(cdb, tmp_path):
    """F04: báo cáo file của tính năng đếm DISTINCT tên trong cửa sổ, bỏ mẫu
    (cờ caller HOẶC nhãn MẪU trong bản); tiền tố tính năng khác không đếm."""
    write_report("Rủi ro tuần 1", tmp_path, "ceo-risk-2026-10-05.md")
    write_report("Rủi ro tuần 1 (sửa)", tmp_path, "ceo-risk-2026-10-05.md")
    write_report("Rủi ro tuần 2", tmp_path, "ceo-risk-2026-10-12.md")
    write_report("Số mẫu", tmp_path, "ceo-risk-2026-10-13.md", sample=True)
    write_report("Rủi ro (MẪU) — dữ liệu mẫu", tmp_path,
                 "ceo-risk-2026-10-14.md")
    write_report("khác", tmp_path, "report-2026.md")
    assert _n(cdb, "report_outputs") == 5
    o = _facts(cdb, "ceo-03")
    assert o["outputs"] == 2 and o["uncounted"] == [] and o["human"] == 0
    rows = cdb.execute("select name, sha256, is_sample from report_outputs"
                       " order by id").fetchall()
    assert rows[0][1] == hashlib.sha256("Rủi ro tuần 1".encode()).hexdigest()
    assert [r[2] for r in rows] == [False, False, False, True, True]
    with pytest.raises(psycopg.Error), cdb.transaction():
        cdb.execute("delete from report_outputs")           # append-only


def test_report_record_db_down_report_still_written(enforce, monkeypatch,
                                                    tmp_path, capsys):
    monkeypatch.setattr(ro, "connect", lambda: None)
    p = write_report("x", tmp_path, "ceo-risk-2026-10-05.md")
    assert p.exists()
    assert "không ghi sổ đầu ra" in capsys.readouterr().err


# ------------------------------------------------------------ bảng riêng


def test_table_sources_counted_distinct_with_provenance(cdb):
    """F04: nguồn bảng riêng đếm DISTINCT khóa tự nhiên, loại mẫu theo cột
    provenance, lọc theo khóa danh mục (kind/source/rules) — không chéo."""
    ins = ("insert into audit_runs (kind, period_label, findings,"
           " report_sha256, run_by, is_sample) values (%s, %s, 0, %s,"
           " 'agent:x', %s)")
    for kind, lab, sha, smp in (("inside_out", "2026-09", "a" * 64, False),
                                ("inside_out", "2026-09", "a" * 64, False),
                                ("inside_out", "2026-08", "b" * 64, False),
                                ("inside_out", "2026-07", "c" * 64, True),
                                ("recon", "2026-09", "d" * 64, False)):
        cdb.execute(ins, (kind, lab, sha, smp))
    assert _facts(cdb, "ceo-04.2")["outputs"] == 2
    assert _facts(cdb, "ceo-04.1")["outputs"] == 1
    # phân bổ: chạy lại cùng mốc (run khác) = 1; mẫu không tính; duyệt người
    ins = ("insert into allocation_proposals (run_id, cutoff_id, cutoff_date,"
           " start_week, sku_key, channel, demand_low, demand_base,"
           " demand_high, proposed_qty, is_sample, status, decided_by,"
           " decided_at) values (%s, %s, '2026-11-01', '2026-10-19', %s,"
           " 'shopee', 1, 2, 3, 2, %s, %s, %s, %s)")
    for rid, sku, smp, st, by in (("r1", "a", False, "pending", None),
                                  ("r2", "a", False, "approved", "GĐ SX"),
                                  ("r1", "b", False, "approved",
                                   "agent:x"),
                                  ("r1", "c", True, "pending", None)):
        cdb.execute(ins, (rid, "tet", sku, smp, st, by,
                          None if by is None else NOW))
    o = _facts(cdb, "production-01")
    assert (o["outputs"], o["human"], o["unapproved"]) == (2, 1, 1)
    # nhật ký: chỉ nguồn Zalo, bỏ mẫu và nhập tay
    _plot(cdb)
    for src in ("zalo:garden", "manual:garden", "sample:x"):
        garden.add_log(cdb, "KV-T01", NOW - timedelta(hours=1), "tưới",
                       src, author="zalo:VT01", source=src)
    assert _facts(cdb, "farming-01")["outputs"] == 1
    # lô: mẫu không tính; kiểm nhập passed bởi người = duyệt từng mục
    _mk_lot(cdb, code="L-THAT")
    _mk_lot(cdb, code="L-MAU", source="sample")
    o = _facts(cdb, "production-04.1")
    assert (o["outputs"], o["human"]) == (1, 1)
    # cảnh báo đỏ: đúng agent + luật; leo thang không phải đầu ra mới
    ra = ("insert into red_alerts (source_agent, title, detail) values"
          " (%s, 't', %s::jsonb)")
    cdb.execute(ra, ("intel_red_alert", json.dumps(
        {"intel_item_id": 1, "rules": ["brand_negative"]})))
    cdb.execute(ra, ("intel_red_alert", json.dumps(
        {"intel_item_id": 2, "rules": ["legal_doc"]})))
    cdb.execute(ra, ("intel_red_alert", json.dumps({"escalation_of": 1})))
    cdb.execute(ra, ("khac", json.dumps(
        {"intel_item_id": 3, "rules": ["brand_negative"]})))
    assert _facts(cdb, "intel-02")["outputs"] == 1


def test_catalog_filter_key_must_be_supported(tmp_path):
    """Khóa lọc không có bộ lọc ở bảng → loader từ chối (bỏ qua câm = đếm cả
    dòng của tính năng khác). Code cũ nhận im lặng."""
    bad = [_ff("finance-01", [{"table": "recon_results",
                               "created_by": "agent:x"}])]
    with pytest.raises(ValueError, match="không lọc được"):
        ro.load_features(_write(tmp_path, _doc(bad)))


def test_real_catalog_every_table_report_source_counts(cdb, monkeypatch):
    """Mọi nguồn bảng/report của danh mục THẬT có bộ đếm và SQL chạy được
    trên schema thật (chỉ nguồn `file` còn chưa đếm)."""
    monkeypatch.setattr(ro, "FEATURES_FILE", ROOT / "data" /
                        "contract_features.json")
    feats = ro.load_features()
    seen = 0
    for f in feats:
        o = ro.output_facts(cdb, f, T0, NOW, SHIFT)
        for u in o["uncounted"]:
            assert u.startswith("file="), (f["id"], u)
        seen += len(f["output_sources"])
    assert seen > 80


def test_approval_queue_sample_flag_not_counted(cdb):
    """Cờ provenance thay quy ước tên: mục dựng trên số MẪU có tiêu đề/mã
    bình thường vẫn không là đầu ra."""
    _stage(cdb, "ceo-05", "chay_thu")
    for oid, smp in (("2026-09", True), ("2026-08", False)):
        aq.enqueue(cdb, object_type="hdtv_pack", object_id=oid, block="ceo",
                   title=f"Gói báo cáo HĐTV tháng {oid}",
                   payload="Gói báo cáo HĐTV tháng — số có nguồn.",
                   risk="medium", created_by="agent:hdtv_report",
                   sla_hours=24, sample=smp)
    assert _n(cdb, "approval_queue", "is_sample") == 1
    assert _facts(cdb, "ceo-05")["outputs"] == 1


def test_shared_object_type_mapped_by_created_by():
    """`market_alert_s1` do 2 agent đẩy: kd_listing → sales-03, kd_price /
    sales_director → sales-06.1 (code cũ: mọi S1 về sales-06.1)."""
    ff = ro.feature_for
    s1 = {"table": "approval_queue", "block": "sales",
          "object_type": "market_alert_s1"}
    assert ff(**s1, created_by="agent:kd_listing") == "sales-03"
    assert ff(**s1, created_by="agent:kd_price") == "sales-06.1"
    assert ff(**s1, created_by="agent:sales_director") == "sales-06.1"
    assert ff(table="approval_queue", block="sales",
              object_type="promo_change",
              created_by="agent:kd_price") == "finance-04.2"
    assert ff(table="approval_queue", block="sales",
              object_type="cskh_handoff",
              created_by="agent:sales_director") == "sales-01"
    assert ff(table="approval_queue", block="legal_hr",
              object_type="golden_xnqc_sync",
              created_by="agent:phap_che_a1") == "legal_hr-03.2"
    assert ff(table="san_suggestions") == "sales-02"


# ------------------------------------------------------------ chat sàn


@pytest.fixture
def san(cdb, monkeypatch):
    monkeypatch.setattr(channels, "_connect", lambda: cdb)
    monkeypatch.setattr(channels, "respond", lambda ch, uid, text: {
        "answer": "Dạ hộp quà sâm 6 năm có sẵn ạ, shop gửi ngay.",
        "handoff": None, "blocked": []})
    return cdb


def test_san_suggest_records_output_and_mark_sent_by_stage(san, capsys):
    msg = "giá hộp 6 năm bao nhiêu, gọi 0912345678 nhé"
    _stage(san, "sales-02", "chay_thu")
    assert channels._suggest("shopee", msg, "Lan MXH") == 0
    out = capsys.readouterr().out
    assert "chưa được dùng" in out and "--mark-sent" not in out
    sid, ref, _ans, stage, by = san.execute(
        "select id, msg_ref, answer, stage, created_by from san_suggestions"
    ).fetchone()
    assert stage == "chay_thu" and by == "Lan MXH"
    assert ref == channels.suggestion_ref(msg) and len(ref) == 32
    row = json.dumps(san.execute("select to_jsonb(s) from san_suggestions s"
                                 ).fetchone()[0], ensure_ascii=False)
    assert "0912345678" not in row and "hộp 6 năm bao" not in row
    # chạy thử: không đánh dấu đã gửi được — kể cả sau khi lên vận hành
    assert channels._mark_sent(sid, "Lan MXH") == 1
    san.execute("update feature_rollout set stage = 'van_hanh'")
    assert channels._mark_sent(sid, "Lan MXH") == 1
    assert "CHẠY THỬ" in capsys.readouterr().err
    # vận hành: soạn mới → đánh dấu được (1 lần), agent không đánh dấu
    assert channels._suggest("tiktok", "còn hàng không", "Lan MXH") == 0
    assert "--mark-sent" in capsys.readouterr().out
    sid2 = san.execute("select max(id) from san_suggestions").fetchone()[0]
    assert channels._mark_sent(sid2, "agent:kd_a1") == 1
    assert channels._mark_sent(sid2, "Lan MXH") == 0
    assert channels._mark_sent(sid2, "Lan MXH") == 0          # [skip]
    assert _n(san, "san_suggestion_uses") == 1
    # cùng câu hỏi gợi ý lại = 1 đầu ra; người dán = duyệt từng mục
    assert channels._suggest("tiktok", "còn  hàng KHÔNG", "Lan MXH") == 0
    o = _facts(san, "sales-02")
    assert (o["outputs"], o["human"]) == (2, 1)
    # tắt: không gọi AI, không ghi, không đánh dấu
    san.execute("update feature_rollout set stage = 'tat'")
    n = _n(san, "san_suggestions")
    assert channels._suggest("shopee", "x", "Lan MXH") == 2
    assert _n(san, "san_suggestions") == n
    assert channels._mark_sent(sid2, "Lan MXH") == 1          # tắt: chặn
    with pytest.raises(psycopg.Error), san.transaction():
        san.execute("update san_suggestions set answer = 'x'")


def test_san_mark_sent_refused_when_off_or_guardrail_fail(san, monkeypatch):
    _stage(san, "sales-02", "van_hanh")
    monkeypatch.setattr(channels, "respond", lambda ch, uid, text: {
        "answer": "Dạ sản phẩm chữa khỏi bệnh ạ", "handoff": None,
        "blocked": []})
    assert channels._suggest("shopee", "có tốt không", "Lan MXH") == 0
    bad = san.execute("select id, guardrail_ok from san_suggestions"
                      ).fetchone()
    assert bad[1] is False
    assert channels._mark_sent(bad[0], "Lan MXH") == 1
    assert _facts(san, "sales-02")["outputs"] == 0
    assert channels._mark_sent(999999, "Lan MXH") == 1


def test_san_cli_requires_by_for_mark_sent():
    with pytest.raises(SystemExit):
        channels.main(["--mark-sent", "1"])
    with pytest.raises(SystemExit):
        channels.main(["--mark-sent", "1", "--suggest", "shopee", "--by", "A"])


# ------------------------------------------------------------ QR site


@pytest.fixture
def stage(monkeypatch):
    box = {"md": "van_hanh", "asked": []}
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "mode", lambda conn, fid: box["asked"].append(
        fid) or box["md"])
    return box


def test_qr_site_paused_replaces_published_page(db, proxy, run, stage,  # noqa: F811
                                                tmp_path, monkeypatch):
    """Tắt/lùi chạy thử phải dừng cả trang ĐÃ công khai (code cũ giữ nguyên
    lời văn lô + ảnh)."""
    store = tmp_path / "kho"
    _plot(db)
    sha = _media(proxy, store)
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    assert run("link", "--lot", LOT, "--log", str(lid), "--media", sha,
               "--by", "A") == 0
    _sign(run)
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    code = _code(db)
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    out = tmp_path / "site"
    assert run("site", "--out", str(out)) == 0
    page = out / code / "index.html"
    assert f"Lô: {LOT}" in page.read_text(encoding="utf-8")
    assert (out / "media" / f"{sha}.jpg").exists()
    for md in ("tat", "chay_thu"):
        stage["md"] = md
        assert run("site", "--out", str(out)) == 1
        body = page.read_text(encoding="utf-8")
        assert q.PAUSED in body and LOT not in body and "media" not in body
        assert not (out / "media" / f"{sha}.jpg").exists()
    stage["md"] = "van_hanh"
    assert run("site", "--out", str(out)) == 0
    assert f"Lô: {LOT}" in page.read_text(encoding="utf-8")


# ------------------------------------------------------------ agent tự ghi


ROW = {"sku_key": "a", "channel": "shopee", "stock_total": 5,
       "demand_low": 1, "demand_base": 2, "demand_high": 3,
       "proposed_qty": 2, "note": None, "sample": True}
CUT = {"id": "tet", "date": date(2026, 11, 1)}


def test_allocation_off_not_written_sample_flagged(cdb):
    _stage(cdb, "production-01", "tat")
    with pytest.raises(ro.RolloutBlocked):
        production.save_proposals(cdb, "r1", CUT, date(2026, 10, 19), [ROW])
    assert _n(cdb, "allocation_proposals") == 0
    cdb.execute("update feature_rollout set stage = 'chay_thu'")
    assert production.save_proposals(cdb, "r1", CUT, date(2026, 10, 19),
                                     [ROW, dict(ROW, sku_key="b",
                                                sample=False)]) == 2
    assert _n(cdb, "allocation_proposals", "is_sample") == 1
    assert _facts(cdb, "production-01")["outputs"] == 1


def test_allocation_approve_blocked_when_off(cdb, monkeypatch, capsys):
    _stage(cdb, "production-01", "chay_thu")
    production.save_proposals(cdb, "abcdef123456", CUT, date(2026, 10, 19),
                              [dict(ROW, sample=False)])
    cdb.execute("update feature_rollout set stage = 'tat'")
    monkeypatch.setattr(production, "_open", lambda: cdb)
    assert production.main(["approve", "--run", "abcdef123456", "--by", "GĐ SX"]) == 1
    cap = capsys.readouterr()
    assert "không duyệt mục của tính năng tắt" in cap.out + cap.err
    assert _n(cdb, "allocation_proposals", "status = 'approved'") == 0
    assert production.main(["reject", "--run", "abcdef123456", "--by", "GĐ SX"]) == 0


def test_recon_off_not_written(cdb):
    _stage(cdb, "finance-01", "tat")
    with pytest.raises(ro.RolloutBlocked):
        settlement_csv.reconcile(cdb, {})
    assert _n(cdb, "recon_results") == 0


def test_audit_run_off_not_written_and_sample_flag(cdb):
    _stage(cdb, "ceo-04.2", "tat")
    with pytest.raises(ro.RolloutBlocked):
        bks_audit.record_run(cdb, "inside_out", "2026-09", {}, 0, "x",
                             "agent:bks_audit")
    assert _n(cdb, "audit_runs") == 0
    _stage(cdb, "ceo-04.1", "chay_thu")
    bks_audit.record_run(cdb, "recon", "2026-09", {}, 0, "x",
                         "agent:bks_recon", sample=True)
    assert _n(cdb, "audit_runs", "is_sample") == 1
    assert _facts(cdb, "ceo-04.1")["outputs"] == 0


def test_hdtv_off_no_pack(cdb, monkeypatch, tmp_path, capsys):
    _stage(cdb, "ceo-05", "tat")
    monkeypatch.setattr(hdtv_report, "connect", lambda: cdb)
    rc = hdtv_report.main(["--month", "2026-09", "--out-dir",
                           str(tmp_path / "out"),
                           "--record", "--submit"],
                          now=datetime(2026, 10, 16, 9, tzinfo=VN_TZ))
    assert rc == 2 and "[blocked]" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()
    assert _n(cdb, "audit_runs") == 0 and _n(cdb, "approval_queue") == 0


def test_sim_affiliate_revenue_off_not_written(cdb):
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    import persona_sim
    _stage(cdb, "intel-05", "tat")
    with pytest.raises(ro.RolloutBlocked):
        persona_sim.write_rows(cdb, [])
    _stage(cdb, "finance-03.2", "tat")
    with pytest.raises(ro.RolloutBlocked):
        kd_affiliate.attribute(cdb, cancel={})
    _stage(cdb, "finance-06", "tat")
    with pytest.raises(ro.RolloutBlocked):
        rev_share.record(cdb, "2026-Q3", date(2026, 7, 1), date(2026, 10, 1),
                         {}, None, None, "x", {})
    assert _n(cdb, "revenue_quarters") == 0


def test_cockpit_collect_off_not_written(cdb, monkeypatch, capsys):
    _stage(cdb, "marketing-06.2", "tat")
    monkeypatch.setattr(cockpit, "connect", lambda: cdb)
    rc = cockpit.main(["--collect", "--period", "week"],
                      now=datetime(2026, 10, 16, 9, tzinfo=VN_TZ))
    assert rc == 2 and "[blocked]" in capsys.readouterr().err
    assert _n(cdb, "channel_snapshots") == 0


def test_manual_garden_log_not_gated(cdb):
    """Nhật ký NGƯỜI nhập tay không phải đầu ra AI → tắt farming-01 không
    chặn (chỉ đường Zalo có cổng); bộ đếm không tính dòng nhập tay."""
    _stage(cdb, "farming-01", "tat")
    _plot(cdb)
    lid, _w = garden.add_log(cdb, "KV-T01", NOW - timedelta(hours=1), "tưới",
                             "30 phút", author="Nguyễn Văn Vườn")
    assert lid is not None
    assert _facts(cdb, "farming-01")["outputs"] == 0
