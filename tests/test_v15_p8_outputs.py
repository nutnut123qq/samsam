"""v15.2 (lane p8) — đếm đầu ra + duyệt từng đầu ra (HĐ 6.7; PL02 mục 1).

Hở tái hiện trên `a05c60f` (mỗi nhóm FAIL trên code cũ — xem
`evidence/v15_p8_old_code.log`):
  P8.1  nguồn `file` (`conversations.jsonl` sales-01, `backup_runs.jsonl`
        data_platform-07.2) không có bộ đếm → `outputs=None`; loader nhận
        tên file bất kỳ.
  P8.2  `mkt_ads` ghi mục `finance/budget_change` với created_by = tên người
        lập → không thuộc tính năng nào → bị chặn ở biên dùng, không đếm.
  P8.3  `intel_alert.scan` sinh cảnh báo đỏ cả khi tính năng đang TẮT.
  P8.4  caller `write_report` không truyền `sample=` (bản tin khối có mục
        hàng duyệt MẪU vẫn đếm là đầu ra thật).
  P8.5  báo cáo file khi chạy thử không có nhãn "chạy thử — không gửi".
  P8.6  `lead_followup` vượt trần dừng vòng → phần "chờ lần sau" không đếm.
  P8.7  báo cáo/bảng/file không có bước người duyệt → không có cách gắn
        NGƯỜI + phiên bản nội dung; sinh ra = không bao giờ "đã duyệt".
DB thật: schema tạm + ROLLBACK (`tests.test_da_schema.da_db`); E2E login
người thật dùng lại fixture `live` của p10 (schema tạm đã commit, dọn cuối).
Người/khối là dữ liệu GIẢ của test."""

import ast
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest
from psycopg import conninfo
from psycopg.errors import InsufficientPrivilege, RaiseException
from psycopg.types.json import Jsonb

from agents import garden_director
from agents import mkt_ads as ma
from agents import sales_director as sd
from agents.report import write_report
from pipelines import approval_queue as aq
from pipelines import auth, director
from pipelines import intel_alert as ia
from pipelines import rollout as ro
from pipelines.period import VN_TZ
from tests.test_da_schema import TxConn, da_db
from tests.test_rollout import _doc, _f, _write
from tests.test_v14_p4_sales import CFG as SALES_CFG
from tests.test_v14_p4_sales import _lead, _t
from tests.test_v15_p10_human_authz import (  # noqa: F401 — fixture live
    P_FARM,
    P_SALES,
    _cli,
    _conn,
    _denied,
    _q,
    live,
)

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime.now(VN_TZ)
SHIFT = ro.load_shift()
BY = "Người Duyệt Giả Lập"
S1 = datetime(2026, 10, 1, tzinfo=VN_TZ)       # cửa sổ cố định (T5)
N1 = datetime(2026, 10, 10, tzinfo=VN_TZ)


def _ff(fid, srcs):
    return _f(fid, agent_ids=[], output_sources=srcs)


CAT = [
    _ff("sales-01", [{"file": "conversations.jsonl"}]),
    _ff("data_platform-07.2", [{"file": "backup_runs.jsonl"}]),
    _ff("ceo-03", [{"report": "ceo-risk-"}]),
    _ff("ceo-04.2", [{"table": "audit_runs", "kind": "inside_out"}]),
    _ff("finance-03.1", [{"report": "director-finance-"}]),
    _ff("intel-02", [{"table": "red_alerts", "source_agent": "intel_red_alert",
                      "rules_any": ["brand_negative", "regulation",
                                    "competitor_penalty"]}]),
    _ff("legal_hr-07", [{"table": "red_alerts",
                         "source_agent": "intel_red_alert",
                         "rules_any": ["legal_doc"]}]),
]


def _n():
    """Đồng hồ lúc gọi (NOW lúc import có thể TRƯỚC tx test — now() DB)."""
    return datetime.now(VN_TZ)


def _cat(fid):
    return next(f for f in CAT if f["id"] == fid)


def _cfg(tmp_path):
    cfg = tmp_path / "rollout_config.json"
    cfg.write_bytes(json.dumps({"enforce": True, "workdays": [0, 1, 2, 3, 4],
                                "holidays": []}).encode("utf-8"))
    return cfg


@pytest.fixture
def enforce(monkeypatch, tmp_path):
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "FEATURES_FILE", _write(tmp_path, _doc(CAT)))
    monkeypatch.setattr(ro, "CONFIG_FILE", _cfg(tmp_path))


@pytest.fixture
def cdb(enforce, monkeypatch):
    for conn in da_db():
        t = TxConn(conn)
        monkeypatch.setattr(ro, "connect", lambda t=t: t)
        yield t


def _stage(conn, fid, stage, since=None):
    ro.seed(conn, [_cat(fid)], BY, now=since or NOW - timedelta(days=1))
    conn.execute("update feature_rollout set stage = %s where feature_id"
                 " = %s", (stage, fid))


# ============================================================ P8.1 file


def _conv(ts, mid, ch="zalo", **kw):
    r = {"ts": ts, "msg_id": mid, "user_hash": "uh-p8",
         "question": "giá sâm", "answer": "x",
         "answered": True, "sent": True, "guardrail_ok": True, "channel": ch,
         # v15 fix P8.1: dòng THẬT mang provenance "live" (transport kênh
         # thật đặt lúc ghi) — thiếu provenance không còn là đầu ra.
         "provenance": "live"}
    r.update(kw)
    return json.dumps(r, ensure_ascii=False).encode("utf-8")


def test_p8_1_conversations_counted_distinct_provenance(cdb, tmp_path,
                                                        monkeypatch):
    """convlog: chỉ câu bot ĐÃ GỬI khách thật zalo/messenger trong cửa sổ,
    DISTINCT kênh+msg_id (cả `.1` xoay vòng); dòng hỏng không thành đầu ra;
    gửi không người duyệt = dùng thiếu người."""
    monkeypatch.setattr(ro, "DATA_DIR", tmp_path, raising=False)
    (tmp_path / "conversations.jsonl.1").write_bytes(b"\n".join([
        _conv("2026-10-05T02:00:00Z", "m1"),             # trùng khóa m1
        _conv("2026-10-05T03:00:00Z", "m4", ch="streamlit"),
    ]) + b"\n")
    (tmp_path / "conversations.jsonl").write_bytes(b"\n".join([
        _conv("2026-10-05T03:00:00Z", "m1"),             # T2
        _conv("2026-10-06T03:00:00Z", "m2", ch="messenger"),   # T3
        _conv("2026-10-04T03:00:00Z", "m3"),             # CN: đầu ra, 0 ngày LV
        _conv("2026-10-05T04:00:00Z", "m5", answered=False),
        _conv("2026-10-05T04:00:00Z", "m6", sent=False),
        _conv("2026-10-05T04:00:00Z", "m7", guardrail_ok=None),
        _conv("2026-10-05T04:00:00Z", ""),
        _conv("2026-09-20T04:00:00Z", "m8"),             # ngoài cửa sổ
        b"{khong phai json",
        _conv("2026-10-05 03:00", "m9"),                 # ts không múi giờ
        b"[1, 2]",
        b'{"_doc": "x"}',
        b"\xff\xfe",
    ]) + b"\n")
    o = ro.output_facts(cdb, _cat("sales-01"), S1, N1, SHIFT)
    assert o["outputs"] == 3 and o["out_days"] == 2
    assert o["unapproved"] == 3 and o["human"] == 0 and o["unreviewed"] == 0
    assert len(o["uncounted"]) == 1 and "4 dòng hỏng" in o["uncounted"][0]


def test_p8_1_missing_or_empty_file_not_silently_pass(cdb, tmp_path,
                                                     monkeypatch):
    monkeypatch.setattr(ro, "DATA_DIR", tmp_path, raising=False)
    f = _cat("sales-01")
    o = ro.output_facts(cdb, f, S1, N1, SHIFT)            # file thiếu
    assert o["outputs"] is None and "không có file" in o["uncounted"][0]
    assert ro._NO_COUNT in ro.evaluate("chay_thu", 9, o["outputs"], 0)[1]
    # chỉ còn `.1` (file chính thiếu) → vẫn không đếm được
    (tmp_path / "conversations.jsonl.1").write_bytes(
        _conv("2026-10-05T03:00:00Z", "m1") + b"\n")
    assert ro.output_facts(cdb, f, S1, N1, SHIFT)["outputs"] is None
    (tmp_path / "conversations.jsonl").write_bytes(b"")  # rỗng = 0 thật
    o = ro.output_facts(cdb, f, S1, N1, SHIFT)
    assert o["outputs"] == 1 and o["uncounted"] == []
    (tmp_path / "conversations.jsonl.1").unlink()
    o = ro.output_facts(cdb, f, S1, N1, SHIFT)
    assert o["outputs"] == 0
    tgt, why = ro.evaluate("chay_thu", 9, o["outputs"], 0, o["out_days"])
    assert tgt == "co_nguoi_duyet" and "mới 0/50 đầu ra" in why


def _bk(ts, sha, file="samsam_20261005_020000_vn.dump", status="ok"):
    return json.dumps({"ts": ts, "status": status, "file": file,
                       "size_bytes": 10, "sha256": sha, "offsite": None,
                       "error": None}).encode("utf-8")


def test_p8_1_backup_runs_counted(cdb, tmp_path, monkeypatch):
    f = _cat("data_platform-07.2")
    monkeypatch.delenv("BACKUP_DIR", raising=False)
    o = ro.output_facts(cdb, f, S1, N1, SHIFT)
    assert o["outputs"] is None and "BACKUP_DIR" in o["uncounted"][0]
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path))
    assert ro.output_facts(cdb, f, S1, N1, SHIFT)["outputs"] is None
    (tmp_path / "backup_runs.jsonl").write_bytes(b"\n".join([
        _bk("2026-10-05T09:00:00+07:00", "a" * 64),
        _bk("2026-10-06T09:00:00+07:00", "a" * 64),        # cùng bản dump
        _bk("2026-10-06T09:00:00+07:00", "c" * 64,
            file="samsam_20261006_020000_vn.dump.enc"),
        _bk("2026-10-06T09:00:00+07:00", "b" * 64,
            file="samsam_20261006_020000_vn.dump.partial"),
        _bk("2026-10-06T09:00:00+07:00", "d" * 64, status="fail"),
        _bk("2026-10-06T09:00:00+07:00", "zz"),
        _bk("2026-10-07T09:00:00", "e" * 64),              # ts không múi giờ
    ]) + b"\n")
    o = ro.output_facts(cdb, f, S1, N1, SHIFT)
    assert o["outputs"] == 2 and o["out_days"] == 2 and o["unapproved"] == 0
    # backup tự động: không có bước người riêng → cần sổ duyệt từng đầu ra
    assert o["unreviewed"] == 2 and o["human"] == 0
    assert "1 dòng hỏng" in o["uncounted"][0]


@pytest.mark.parametrize("src", [{"file": "x.jsonl"},
                                 {"file": "conversations.jsonl",
                                  "kind": "x"}])
def test_p8_1_loader_rejects_unknown_file_source(tmp_path, src):
    doc = _doc([_ff("sales-01", [src])])
    with pytest.raises(ValueError, match="nguồn file"):
        ro.load_features(_write(tmp_path, doc))


def test_p8_1_real_catalog_file_sources_have_counters():
    feats = ro.load_features()
    files = {s["file"]: f["id"] for f in feats for s in f["output_sources"]
             if "file" in s}
    # v15 fix P8.7c: backup (data_platform-07.2) đếm bằng chứng DB do dịch
    # vụ backup ghi (`file_output_evidence`), không còn nguồn file.
    # docx P0 FLIP có lý do: sales-01 (convlog) cũng đếm bằng chứng DB do
    # webhook ghi — DB không đọc được file nên trước đây tin số caller khai;
    # danh mục không còn nguồn file nào.
    assert files == {}
    s01 = next(f for f in feats if f["id"] == "sales-01")
    assert {"table": "file_output_evidence", "source": "conversations"}         in s01["output_sources"]
    bk = next(f for f in feats if f["id"] == "data_platform-07.2")
    assert bk["output_sources"] == [{"table": "file_output_evidence",
                                     "source": "backup_runs"}]


# ============================================================ P8.2 mkt_ads


@pytest.fixture
def adb(monkeypatch, tmp_path):
    from tests.test_fp_pnl import fpa_conn
    monkeypatch.delenv("GUARDRAIL_LLM_MODEL", raising=False)
    yield from fpa_conn()


def test_p8_2_budget_change_own_agent_counted_and_usable(adb, monkeypatch,
                                                        tmp_path):
    from tests.test_mkt_ads import FIX, OCT, _Env
    env = _Env(adb, monkeypatch)
    d1 = env.draft()
    plan = json.loads((FIX / "ads_plan_mat_ong_MAU.json")
                      .read_text(encoding="utf-8"))
    plan.update(creative_draft_ids=[d1],
                budget_vnd=ma.cap_for(adb, plan["sku_key"], "shopee", OCT,
                                      env.cfg)["budget_vnd"])
    res = env.submit(plan)
    assert res["code"] is None, res
    rows = adb.execute("select id, block, object_type, created_by from"
                       " approval_queue order by id").fetchall()
    who = {t: c for _, _, t, c in rows}
    # code cũ: 'mkt lap' (tên người lập) → không thuộc tính năng nào
    assert who["budget_change"].startswith("agent:"), who
    assert who == {"ad_campaign": "mkt lap",
                   "budget_change": ma.BUDGET_AGENT}
    assert ma.BUDGET_AGENT.startswith("agent:")
    # đúng tính năng marketing-03.1 (danh mục thật; đợt hoàn thiện tách
    # 03.1 đề xuất / 03.2 kết quả) — cả 2 mục
    assert {aq._feature_of((b, t, c)) for _, b, t, c in rows} == {
        "marketing-03.1"}
    m3 = next(f for f in ro.load_features() if f["id"] == "marketing-03.1")
    assert ma.BUDGET_AGENT in m3["agent_ids"]
    o = ro.output_facts(adb, m3, NOW - timedelta(days=1),
                        NOW + timedelta(days=1), SHIFT)
    assert o["outputs"] == 2
    # biên dùng: marketing-03 vận hành → mục ngân sách người duyệt dùng được
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "CONFIG_FILE", _cfg(tmp_path))
    adb.execute("insert into feature_rollout (feature_id, stage, stage_since,"
                " updated_by, updated_at) values ('marketing-03.1', 'van_hanh',"
                " now(), %s, now())", (BY,))
    meta = ("finance", "budget_change", ma.BUDGET_AGENT, "approved",
            "per_item", "GD Tai Chinh")
    assert aq.use_reason(adb, meta) is None
    # người lập tự duyệt mục ngân sách (DB không biết vì created_by = agent)
    # → phiếu KHÔNG "đã duyệt"
    pid = res["plan_id"]
    qid = {t: i for i, _, t, _ in rows}
    assert aq.decide(env.tx, qid["ad_campaign"], "GD Marketing",
                     "approved") == (True, None)
    assert aq.decide(env.tx, qid["budget_change"], " MKT LAP ",
                     "approved") == (True, None)
    assert ma.plan_status(adb, pid) == "cung_nguoi_duyet"


# ============================================================ P8.3 intel


def _item(db, title, topics=("sam",), source="fx-p8"):
    import uuid
    return db.execute(
        "insert into intel_items (url, domain, source, tier, title, snippet,"
        " content_sha256, topics, flags) values (%s, 'bao.example.vn', %s,"
        " 'A', %s, '', %s, %s, '{}') returning id",
        (f"https://bao.example.vn/{uuid.uuid4().hex}", source, title,
         uuid.uuid4().hex, list(topics))).fetchone()[0]


def test_p8_3_intel_alert_disabled_feature_generates_nothing(cdb):
    _stage(cdb, "intel-02", "tat")
    _stage(cdb, "legal_hr-07", "chay_thu")
    _item(cdb, "Thu hồi lô sâm Sâm Sâm nghi giả mạo")          # brand_negative
    leg = _item(cdb, "Thông tư hướng dẫn ghi nhãn thực phẩm chức năng",
                topics=("phap_ly", "tpbvsk"), source="cuc-attp-van-ban")
    now = cdb.execute("select now()").fetchone()[0]
    s = ia.scan(cdb, now)
    assert s["alerts"] == 1           # code cũ: 2 (tin của tính năng TẮT)
    assert s["off"] == 1
    rows = cdb.execute("select detail from red_alerts where source_agent ="
                       " 'intel_red_alert'").fetchall()
    assert len(rows) == 1 and rows[0][0]["intel_item_id"] == leg
    assert rows[0][0]["rules"] == ["legal_doc"]     # luật tính năng tắt bỏ
    # bật lại → lần quét sau báo tin còn trong cửa sổ
    cdb.execute("update feature_rollout set stage = 'chay_thu' where"
                " feature_id = 'intel-02'")
    s = ia.scan(cdb, now)
    assert s["off"] == 0 and s["alerts"] == 1


# ============================================================ P8.4 sample=


def _calls_without_sample() -> list[str]:
    bad = []
    for d in ("agents", "pipelines", "scripts", "ingest", "connectors", "app",
              "crawler", "api"):
        for p in (ROOT / d).rglob("*.py"):
            tree = ast.parse(p.read_bytes().decode("utf-8"))
            for n in ast.walk(tree):
                if not isinstance(n, ast.Call):
                    continue
                fn = n.func
                name = (fn.id if isinstance(fn, ast.Name) else fn.attr
                        if isinstance(fn, ast.Attribute) else None)
                if name == "write_report" and not any(
                        k.arg == "sample" for k in n.keywords):
                    bad.append(f"{p.relative_to(ROOT)}:{n.lineno}")
    return bad


def test_p8_4_every_write_report_caller_passes_sample():
    assert _calls_without_sample() == []


def test_p8_4_director_bulletin_with_sample_items_not_counted(cdb, tmp_path):
    aq.enqueue(cdb, object_type="invoice_batch", object_id="lo-mau-p8",
               block="finance", title="Lô hóa đơn thử", payload="Nội dung",
               risk="high", created_by="agent:acc_invoice", sla_hours=24,
               sample=True)
    path, _ = director.run(cdb, "finance", NOW, out_dir=tmp_path)
    assert path.name.startswith("director-finance-")
    assert cdb.execute("select feature_id, is_sample from report_outputs"
                       ).fetchall() == [("finance-03.1", True)]
    assert ro.output_facts(cdb, _cat("finance-03.1"), NOW - timedelta(
        days=1), NOW + timedelta(days=1), SHIFT)["outputs"] == 0


def test_p8_4_garden_bulletin_sample_flag(cdb):
    plot = cdb.execute("insert into plots (id, source) values"
                       " ('P8-K1', 'sample:p8') returning id").fetchone()[0]
    day = NOW.date() - timedelta(days=1)
    assert garden_director.bulletin_sample(cdb, day, 7) is False
    cdb.execute("insert into plot_logs (plot_id, ts, activity, detail, author,"
                " source) values (%s, %s, 'tưới', 'x', 'NV', 'sample:p8')",
                (plot, datetime.combine(day, datetime.min.time(), VN_TZ)))
    assert garden_director.bulletin_sample(cdb, day, 7) is True


# ============================================================ P8.5 nhãn


@pytest.mark.parametrize("stage,label", [
    ("chay_thu", "CHẠY THỬ — KHÔNG GỬI"),
    ("co_nguoi_duyet", "CHỜ NGƯỜI DUYỆT — CHƯA GỬI"),
    ("van_hanh", None)])
def test_p8_5_report_label_by_stage(cdb, tmp_path, stage, label):
    _stage(cdb, "ceo-03", stage)
    p = write_report("# Sổ rủi ro\n", tmp_path, "ceo-risk-2026-10-05.md",
                     sample=False)
    body = p.read_bytes().decode("utf-8")
    if label is None:
        assert body == "# Sổ rủi ro\n"
    else:
        assert body.startswith("> **" + label) and "ceo-03" in body
        assert body.endswith("# Sổ rủi ro\n")
    # sha sổ đầu ra = đúng bản trên đĩa (có nhãn)
    assert cdb.execute("select sha256 from report_outputs").fetchone()[0] \
        == hashlib.sha256(p.read_bytes()).hexdigest()


def test_p8_5_label_fail_closed_and_scope(enforce, tmp_path, monkeypatch):
    monkeypatch.setattr(ro, "connect", lambda: None)        # DB down
    p = write_report("x", tmp_path, "ceo-risk-2026-10-06.md", sample=False)
    assert p.read_bytes().decode("utf-8").startswith(
        "> **CHẠY THỬ — KHÔNG GỬI")
    # không thuộc danh mục / không phải .md → giữ nguyên byte
    assert write_report("x", tmp_path, "khac-1.md", sample=False
                        ).read_bytes() == b"x"
    assert write_report("a,b\n", tmp_path, "ceo-risk-1.csv", sample=False
                        ).read_bytes() == b"a,b\n"


# ============================================================ P8.6 lead


def test_p8_6_lead_followup_deferred_counted(cdb):
    for _ in range(5):
        _lead(cdb, _t(12, 8))
    cfg = dict(SALES_CFG, lead_owner=dict(SALES_CFG["lead_owner"],
                                          max_per_run=2))
    st = {}
    assert len(sd.lead_items(cdb, _t(13, 9), cfg, stats=st)) == 2
    assert st == {"deferred": 3}
    nodir = Path("/nonexist-p8")
    assert sd.plan(cdb, _t(13, 9), cfg, nodir)["lead_deferred"] == 3
    got = []
    for _ in range(3):
        r = sd.run(cdb, _t(13, 9), cfg, data_dir=nodir)
        got.append((r["enqueued"], r["lead_deferred"]))
    assert got == [(2, 3), (2, 1), (1, 0)]      # không mất mục nào
    assert cdb.execute("select count(*) from approval_queue where"
                       " object_type = 'lead_followup'").fetchone()[0] == 5
    data = {"start": _t(13, 0), "end": _t(14, 0), "queue": [], "decided": {},
            "alerts": [], "n_leads": 0, "regions": [], "stale_leads": [],
            "golden_pending": 0, "unanswered": 0, "cskh_deferred": 0,
            "lead_deferred": 4, "catalog": None}
    text = sd.render_bulletin(cfg, data, _t(13, 9))
    assert "Nhắc lead (`lead_followup`) đến hạn vượt trần 2 mục/lần chạy" \
        " (chờ lần sau): 4" in text


# ============================================================ P8.7 duyệt


def test_p8_7_evaluate_reason_list_is_the_gate():
    tgt, why = ro.evaluate("co_nguoi_duyet", 12, 5, 0, 5, 1, 0, 2)
    assert tgt == "van_hanh" and len(why) == 1 and "2 đầu ra" in why[0]
    assert ro.evaluate("co_nguoi_duyet", 12, 5, 0, 5, 1, 0, 0) == (
        "van_hanh", [])
    # cổng PL02 giữ nguyên: 10 ngày, ≥1 người duyệt, 0 lỗi nghiêm trọng
    assert ro.evaluate("co_nguoi_duyet", 9, 5, 0, 5, 1, 0, 0)[1]
    assert ro.evaluate("co_nguoi_duyet", 12, 5, 1, 5, 1, 0, 0)[1]
    assert ro.evaluate("co_nguoi_duyet", 12, 5, 0, 5, 0, 0, 0)[1]
    assert (ro.TRIAL_DAYS, ro.TRIAL_OUTPUTS, ro.REVIEW_DAYS) == (5, 50, 10)


def test_p8_7_report_needs_human_review_per_version(cdb, tmp_path):
    since = NOW - timedelta(days=30)
    _stage(cdb, "ceo-03", "co_nguoi_duyet", since=since)
    cdb.execute("update feature_rollout set stage_since = %s", (since,))
    name = "ceo-risk-2026-10-05.md"
    p = write_report("# Rủi ro A\n", tmp_path, name, sample=False)
    fx = ro._facts(cdb, _cat("ceo-03"), "co_nguoi_duyet", since, _n(), SHIFT)
    assert fx["outputs"] == 1 and fx["human"] == 0 and fx["unreviewed"] == 1
    assert fx["target"] == "van_hanh" and fx["why"]      # sinh ≠ đã duyệt
    with pytest.raises(ro.RolloutError, match="chưa có NGƯỜI duyệt"):
        ro.promote(cdb, CAT, "ceo-03", BY, SHIFT)
    out = ro.pending_outputs(cdb, CAT, "ceo-03")
    sha = hashlib.sha256(p.read_bytes()).hexdigest()
    assert out == [{"key": f"rp:{name}", "ts": out[0]["ts"], "sha": sha,
                    "review": None}]
    with pytest.raises(ro.RolloutError, match="sha không khớp"):
        ro.review_output(cdb, CAT, "ceo-03", f"rp:{name}", "0" * 64,
                         "approved", BY)
    with pytest.raises(ro.RolloutError, match="không phải đầu ra"):
        ro.review_output(cdb, CAT, "ceo-03", "rp:ceo-risk-khac.md", sha,
                         "approved", BY)
    for bad in ("agent:x", "system:cron", ""):
        with pytest.raises(ValueError):
            ro.review_output(cdb, CAT, "ceo-03", f"rp:{name}", sha,
                             "approved", bad)
    assert cdb.execute("select count(*) from output_reviews").fetchone()[0] \
        == 0
    ro.review_output(cdb, CAT, "ceo-03", f"rp:{name}", sha, "approved", BY,
                     note="đã đọc, gọi 0905123456")
    fx = ro._facts(cdb, _cat("ceo-03"), "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["human"], fx["unreviewed"], fx["why"]) == (1, 0, [])
    # ghi lại nội dung khác → phiên bản mới chưa duyệt → chặn lại
    p = write_report("# Rủi ro A (sửa số)\n", tmp_path, name, sample=False)
    fx = ro._facts(cdb, _cat("ceo-03"), "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["human"], fx["unreviewed"]) == (0, 1) and fx["why"]
    sha2 = hashlib.sha256(p.read_bytes()).hexdigest()
    # DB tự kiểm phiên bản mới nhất (gọi thẳng function bằng sha cũ)
    with pytest.raises(RaiseException, match="MỚI NHẤT"), cdb.transaction():
        cdb.execute("select output_review_human('ceo-03', %s, %s,"
                    " 'approved', %s, null)", (f"rp:{name}", sha, BY))
    with pytest.raises(InsufficientPrivilege), cdb.transaction():
        cdb.execute("select output_review_human('ceo-03', %s, %s,"
                    " 'approved', 'agent:ceo', null)", (f"rp:{name}", sha2))
    ro.review_output(cdb, CAT, "ceo-03", f"rp:{name}", sha2, "approved", BY)
    r = ro.promote(cdb, CAT, "ceo-03", BY, SHIFT)
    assert r["to"] == "van_hanh" and r["facts"]["why"] == []
    ev = cdb.execute("select evidence from feature_rollout_events where"
                     " kind = 'promote'").fetchone()[0]
    assert ev["unreviewed"] == 0 and ev["human"] == 1
    # sổ duyệt append-only + vết hành động, ghi chú đã che SĐT
    rows = cdb.execute("select output_key, content_sha256, decision,"
                       " reviewed_by, note from output_reviews order by id"
                       ).fetchall()
    assert [(k, h, d, b) for k, h, d, b, _ in rows] == [
        (f"rp:{name}", sha, "approved", BY),
        (f"rp:{name}", sha2, "approved", BY)]
    assert "0905123456" not in rows[0][4]
    assert cdb.execute("select count(*) from agent_action_log where action ="
                       " 'output_review'").fetchone()[0] == 2
    for sql in ("update output_reviews set decision = 'rejected'",
                "delete from output_reviews"):
        with pytest.raises(psycopg.Error), cdb.transaction():
            cdb.execute(sql)


def test_p8_7_table_output_rejected_is_not_approved(cdb):
    since = NOW - timedelta(days=30)
    _stage(cdb, "ceo-04.2", "co_nguoi_duyet", since=since)
    cdb.execute("update feature_rollout set stage_since = %s", (since,))
    cdb.execute("insert into audit_runs (kind, period_label, findings,"
                " report_sha256, run_by) values ('inside_out', '2026-09', 0,"
                " %s, 'agent:bks')", ("f" * 64,))
    f = _cat("ceo-04.2")
    fx = ro._facts(cdb, f, "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["outputs"], fx["human"], fx["unreviewed"]) == (1, 0, 1)
    (o,) = ro.pending_outputs(cdb, CAT, "ceo-04.2")
    assert o["key"] == f"ar:inside_out/2026-09/{'f' * 64}"
    assert len(o["sha"]) == 64
    ro.review_output(cdb, CAT, "ceo-04.2", o["key"], o["sha"], "rejected",
                     BY)
    fx = ro._facts(cdb, f, "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["human"], fx["unreviewed"]) == (0, 0)
    assert any("NGƯỜI duyệt từng mục" in w for w in fx["why"])
    ro.review_output(cdb, CAT, "ceo-04.2", o["key"], o["sha"], "approved",
                     BY)
    fx = ro._facts(cdb, f, "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["human"], fx["why"]) == (1, [])


def test_p8_7_reviews_unreadable_fail_closed(cdb, tmp_path):
    """Sổ duyệt không đọc được (bảng thiếu / login không quyền) → coi như
    CHƯA ai duyệt — không vô tình đạt."""
    since = NOW - timedelta(days=30)
    _stage(cdb, "ceo-03", "co_nguoi_duyet", since=since)
    cdb.execute("update feature_rollout set stage_since = %s", (since,))
    p = write_report("# R\n", tmp_path, "ceo-risk-2026-10-07.md",
                     sample=False)
    sha = hashlib.sha256(p.read_bytes()).hexdigest()
    ro.review_output(cdb, CAT, "ceo-03", "rp:ceo-risk-2026-10-07.md", sha,
                     "approved", BY)
    cdb.execute("alter table output_reviews rename to output_reviews_x")
    fx = ro._facts(cdb, _cat("ceo-03"), "co_nguoi_duyet", since, _n(), SHIFT)
    assert (fx["human"], fx["unreviewed"]) == (0, 1) and fx["why"]


def test_p8_7_real_mode_without_approvers_blocks(cdb, tmp_path, monkeypatch,
                                                 capsys):
    """Chế độ thực + khối chưa có người duyệt (approvers rỗng — Bên B chưa ủy
    quyền) → không duyệt được đầu ra, không nâng vận hành."""
    since = NOW - timedelta(days=30)
    _stage(cdb, "ceo-03", "co_nguoi_duyet", since=since)
    p = write_report("# R\n", tmp_path, "ceo-risk-2026-10-08.md",
                     sample=False)
    sha = hashlib.sha256(p.read_bytes()).hexdigest()
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    denied = []
    monkeypatch.setattr(auth, "deny_log", lambda conn, by, block, action, ot,
                        oid, why, **k: denied.append((block, action, ot)))
    assert auth.block_config("ceo")["approvers"] == []
    rc = ro.main(["--review-output", "ceo-03", "--key",
                  "rp:ceo-risk-2026-10-08.md", "--sha", sha, "--decision",
                  "approved", "--by", BY])
    assert rc == 1 and denied == [("ceo", "approve", "output_review")]
    assert ro.main(["--promote", "ceo-03", "--by", BY]) == 1
    assert cdb.execute("select count(*) from output_reviews").fetchone()[0] \
        == 0
    assert cdb.execute("select stage from feature_rollout where feature_id ="
                       " 'ceo-03'").fetchone()[0] == "co_nguoi_duyet"
    assert "ủy quyền" in capsys.readouterr().err


# ---------------------------------------------- P8.7 E2E login người thật



def test_p8_7_e2e_human_login_review(live):  # noqa: F811
    name = "ceo-risk-2026-10-09.md"
    sha = hashlib.sha256(b"# R p8\n").hexdigest()
    _owner_seed(live, [_cat("ceo-03")], datetime.now(VN_TZ)
                - timedelta(days=30))       # đường owner: kèm `count_spec`
    _q(live, "update feature_rollout set stage = 'co_nguoi_duyet' where"
       " feature_id = 'ceo-03'")
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-03', %s, %s)", (name, sha))
    rc, out = _cli(live, "farm", "pipelines.rollout", "--outputs", "ceo-03")
    assert rc == 0 and f"rp:{name}" in out and sha in out \
        and "CHƯA DUYỆT" in out, out
    # DB tự chặn nâng vận hành khi báo cáo CHƯA có người duyệt (gọi thẳng).
    # docx P0 FLIP có lý do: trước đây kiểm SAU khi đã duyệt và dựa việc
    # bằng chứng caller THIẾU khóa `unreviewed`; nay DB bỏ qua số caller
    # khai, chỉ tin số đếm lại → kiểm lúc còn 1 báo cáo chưa duyệt, kể cả
    # khi caller khai `unreviewed: 0`.
    ev = {"human": 1, "unapproved": 0, "unreviewed": 0}
    with _conn(live, "farm") as c, pytest.raises(psycopg.Error) as ei:
        c.execute("select rollout_transition_human('ceo-03', 'promote',"
                  " 'co_nguoi_duyet', 'van_hanh', %s, null, null, %s, now())",
                  (P_FARM, json.dumps(ev)))
    assert "1 chưa duyệt" in str(ei.value), str(ei.value)
    # sai khối (người khối sales) / --by giả → cổng chặn + authz_denied
    before = _denied(live, "output_review")
    rc, out = _cli(live, "sales", "pipelines.rollout", "--review-output",
                   "ceo-03", "--key", f"rp:{name}", "--sha", sha,
                   "--decision", "approved", "--by", P_SALES)
    assert rc == 1, out
    rc, out = _cli(live, "farm", "pipelines.rollout", "--review-output",
                   "ceo-03", "--key", f"rp:{name}", "--sha", sha,
                   "--decision", "approved", "--by", P_SALES)
    assert rc == 1, out
    assert _denied(live, "output_review") == before + 2
    # đúng người / đúng khối → 1 dòng sổ, danh tính theo login
    rc, out = _cli(live, "farm", "pipelines.rollout", "--review-output",
                   "ceo-03", "--key", f"rp:{name}", "--sha", sha,
                   "--decision", "approved", "--by", P_FARM)
    assert rc == 0, out
    assert _q(live, "select reviewed_by, db_role, content_sha256 from"
              " output_reviews") == [(P_FARM, live["name"]["farm"], sha)]
    # gọi thẳng: login khối khác bị DB chặn; không INSERT trực tiếp được
    with _conn(live, "sales") as c, pytest.raises(InsufficientPrivilege):
        c.execute("select output_review_human('ceo-03', %s, %s, 'approved',"
                  " %s, null)", (f"rp:{name}", sha, P_SALES))
    with _conn(live, "farm") as c, pytest.raises(InsufficientPrivilege):
        c.execute("insert into output_reviews (feature_id, output_key,"
                  " content_sha256, decision, reviewed_by) values ('ceo-03',"
                  " %s, %s, 'approved', %s)", (f"rp:{name}", sha, P_FARM))
    with _conn(live, "loader") as c, pytest.raises(InsufficientPrivilege):
        c.execute("select output_review_human('ceo-03', %s, %s, 'approved',"
                  " %s, null)", (f"rp:{name}", sha, P_FARM))
    rc, out = _cli(live, "farm", "pipelines.rollout", "--promote", "ceo-03",
                   "--by", P_FARM)
    assert rc == 0 and "vận hành" in out, out
    assert _q(live, "select stage from feature_rollout where feature_id ="
              " 'ceo-03'") == [("van_hanh",)]


# ------------------------------- review v15: DB tự đếm lại, không tin evidence

def _owner_seed(live, feats, since):  # noqa: F811
    """Vào sổ bằng đường OWNER thật (`ro.seed`) — ghi kèm nguồn đầu ra."""
    dsn = conninfo.make_conninfo(os.environ["DATABASE_URL"],
                                 options=f"-c search_path={live['schema']}")
    with psycopg.connect(dsn, connect_timeout=5) as c:
        ro.seed(c, feats, "test-p8", now=since)


def _call_transition(live, fid, frm, to, ev):  # noqa: F811
    with _conn(live, "farm") as c, pytest.raises(psycopg.Error) as ei:
        c.execute("select rollout_transition_human(%s, 'promote', %s, %s, %s,"
                  " null, null, %s, now())",
                  (fid, frm, to, P_FARM, json.dumps(ev)))
    return str(ei.value)


def test_p8_7_db_recounts_outputs_not_evidence(live):  # noqa: F811
    """Review v15 (MINOR): `rollout_transition_human` TỰ đếm lại đầu ra bằng
    bộ đếm `count_spec` owner ghi (chính câu SQL Python) — gọi thẳng bằng
    login người với bằng chứng tự khai KHÔNG vượt cổng PL02 (mọi loại nguồn
    DB: hàng duyệt, báo cáo + sổ duyệt, bảng riêng; không nguồn = chặn)."""
    feats = {f["id"]: f for f in ro.load_features()}
    since = datetime.now(VN_TZ) - timedelta(days=20)
    nosrc = {"id": "farming-98", "code_status": "co_code",
             "output_sources": []}
    _owner_seed(live, [feats["ceo-02.1"], feats["farming-02.2"],
                       feats["ceo-02.2"], nosrc], since)
    assert _q(live, "select feature_id, jsonb_array_length(count_spec->"
              "'sql'), count_spec->'workdays' from feature_rollout where"
              " feature_id in ('ceo-02.1', 'ceo-02.2', 'farming-02.2',"
              " 'farming-98') order by 1") == [("ceo-02.1", 2, [0, 1, 2, 3, 4]),
                           ("ceo-02.2", 1, [0, 1, 2, 3, 4]),
                           # đợt hoàn thiện: farming-02 tách — 02.2 = bản
                           # tin tuần + plot_log_gap (02.1 = garden_reminders)
                           ("farming-02.2", 2, [0, 1, 2, 3, 4]),
                           ("farming-98", 0, [0, 1, 2, 3, 4])]
    fake = {"outputs": 999, "out_days": 9}
    # (1) chạy thử → có người duyệt: 0 đầu ra thật, bằng chứng khai 999/9 —
    # hàng duyệt (ceo-02.1), bảng riêng (ceo-02.2), không nguồn (farming-98)
    for fid in ("ceo-02.1", "ceo-02.2", "farming-98"):
        msg = _call_transition(live, fid, "chay_thu", "co_nguoi_duyet", fake)
        assert "DB đếm lại" in msg, (fid, msg)
    # (2) có người duyệt → vận hành: 1 báo cáo CHƯA duyệt, khai unreviewed=0
    _q(live, "update feature_rollout set stage = 'co_nguoi_duyet' where"
       " feature_id = 'farming-02.2'")
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('farming-02.2', 'garden-week-2026-W41.md', %s)", ("e" * 64,))
    msg = _call_transition(live, "farming-02.2", "co_nguoi_duyet", "van_hanh",
                           {"human": 1, "unapproved": 0, "unreviewed": 0})
    assert "DB đếm lại" in msg and "1 chưa duyệt" in msg, msg
    assert _q(live, "select feature_id, stage from feature_rollout where"
              " feature_id in ('ceo-02.1', 'ceo-02.2', 'farming-02.2',"
              " 'farming-98') order by 1") == [
        ("ceo-02.1", "chay_thu"), ("ceo-02.2", "chay_thu"),
        ("farming-02.2", "co_nguoi_duyet"), ("farming-98", "chay_thu")]
    # (3) bộ đếm chưa vào sổ DB (dòng cũ trước vá) → fail-closed
    _q(live, "insert into feature_rollout (feature_id, stage, stage_since,"
       " updated_by) values ('ceo-05', 'chay_thu', now() - interval"
       " '20 days', 'test-p8')")
    msg = _call_transition(live, "ceo-05", "chay_thu", "co_nguoi_duyet", fake)
    assert "chưa đồng bộ" in msg, msg
    # (4) đường thật: 50 đầu ra thật rải 5 ngày làm việc → CLI nâng được,
    # sự kiện ghi kết quả DB đếm lại (khớp số Python)
    days, d = [], since.date() + timedelta(days=1)
    while len(days) < 5:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        a.execute("set local session_replication_role = replica")
        for i in range(50):
            ts = datetime.combine(days[i % 5], datetime.min.time(),
                                  VN_TZ) + timedelta(hours=10)
            a.execute(
                "insert into approval_queue (object_type, object_id, block,"
                " title, payload, content_sha256, risk, guardrail,"
                " created_by, created_at, due_at) values ('weekly_board', %s,"
                " 'ceo', 'Bảng tuần', 'x', %s, 'low', '{\"ok\": true}',"
                " 'agent:da_pmo', %s, %s)",
                (f"wb-p8-{i}", "0" * 64, ts, ts + timedelta(days=2)))
    rc, out = _cli(live, "farm", "pipelines.rollout", "--promote", "ceo-02.1",
                   "--by", P_FARM)
    assert rc == 0, out
    ev = _q(live, "select evidence from feature_rollout_events where"
            " feature_id = 'ceo-02.1' and kind = 'promote'")[0][0]
    rc_ = ev.pop("db_recount")
    assert rc_.pop("days") == ev["days"] >= 5, (rc_, ev)
    # docx P0: bộ đếm lại DB có thêm số lỗi nghiêm trọng của giai đoạn.
    assert rc_ == {"outputs": 50, "out_days": 5, "human": 0,
                   "unapproved": 0, "unreviewed": 0, "file_sources": 0,
                   "severe": 0}, ev
    assert (ev["outputs"], ev["out_days"]) == (50, 5), ev


def test_p8_7_db_recount_parity_with_python(cdb):
    """Review v15: DB (`rollout_db_facts` + `rollout_business_days` trên
    `count_spec`) đếm KHỚP Python (`output_facts` + `business_days`) trên
    cùng dữ liệu — hàng duyệt (người / agent / auto_policy / mẫu / guardrail
    hỏng / ngoài cửa sổ), nháp nội dung, báo cáo đã/chưa/bị từ chối duyệt
    theo phiên bản, bảng riêng có lọc (red_alerts rules_any, audit_runs kind)
    và bảng có người ghi (decision_log); đầu ra ngày nghỉ không thành ngày
    làm việc; lịch nghỉ lễ trong bộ đếm."""
    srcs = [{"table": "approval_queue", "block": "ceo",
             "object_type": "weekly_report"},
            {"table": "content_drafts", "created_by": "agent:p8par",
             "content_type": "post"},
            {"report": "ceo-par-"},
            {"table": "red_alerts", "source_agent": "intel_red_alert",
             "rules_any": ["legal_doc", "regulation"]},
            {"table": "audit_runs", "kind": "inside_out"},
            {"table": "decision_log"},
            {"table": "bang_chua_co_bo_dem"}]
    f = _ff("ceo-01", srcs)
    a = S1                                              # T5 01/10/2026
    shift = ro.period.parse_shift({"start": "00:00", "end": "23:59",
                                   "workdays": [0, 1, 2, 3, 4],
                                   "holidays": ["2026-10-06"]})
    cdb.execute("set local session_replication_role = replica")
    rows = [  # (object_id, ngày lệch, guardrail ok, sample, status, lane, by)
        ("wr-1", 1, True, False, "approved", "per_item", "Người A"),
        ("wr-2", 2, True, False, "approved", "auto_policy", "agent:x"),
        ("wr-3", 2, True, False, "approved", "per_item", "system:cron"),
        ("wr-4", 3, True, False, "pending", None, None),     # CN
        ("wr-5", 3, False, False, "pending", None, None),
        ("wr-6", 4, True, True, "pending", None, None),
        ("wr-mau-7", 4, True, False, "pending", None, None),
        ("wr-8", 40, True, False, "pending", None, None),
    ]
    for oid, dd, ok, smp, st, lane, by in rows:
        ts = a + timedelta(days=dd, hours=3)
        cdb.execute(
            "insert into approval_queue (object_type, object_id, block, title,"
            " payload, content_sha256, risk, guardrail, created_by,"
            " created_at, due_at, status, lane, decided_by, is_sample)"
            " values ('weekly_report', %s, 'ceo', 'Báo cáo tuần', 'x', %s,"
            " 'low', %s, 'agent:ceo_report', %s, %s, %s, %s, %s, %s)",
            (oid, "0" * 64, json.dumps({"ok": ok}), ts, ts, st, lane, by,
             smp))
    for i, (st, rv, src) in enumerate((("approved", "Người B", "cli"),
                                       ("approved", "agent:y", "cli"),
                                       ("pending", None, "sample:x"),
                                       ("pending", None, "cli"))):
        cdb.execute(
            "insert into content_drafts (created_at, brief, channel, text,"
            " guardrail, status, reviewer, source, created_by, content_type)"
            " values (%s, 'brief', 'facebook', %s, '{\"ok\": true}', %s, %s,"
            " %s, 'agent:p8par', 'post')",
            (a + timedelta(days=1 + i), f"nháp {i}", st, rv, src))
    for name, sha, dd in (("ceo-par-1.md", "a" * 64, 1),
                          ("ceo-par-1.md", "b" * 64, 2),
                          ("ceo-par-2.md", "c" * 64, 5),     # lễ 06/10
                          ("ceo-par-3.md", "d" * 64, 6)):
        cdb.execute("insert into report_outputs (feature_id, name, sha256,"
                    " created_at) values ('ceo-01', %s, %s, %s)",
                    (name, sha, a + timedelta(days=dd)))
    for i, (agent, rules, dd) in enumerate((
            ("intel_red_alert", ["legal_doc"], 7),
            ("intel_red_alert", ["brand_negative"], 7),     # luật khác
            ("khac", ["legal_doc"], 7),                     # agent khác
            ("intel_red_alert", ["regulation", "x"], 8))):
        cdb.execute("insert into red_alerts (ts, source_agent, title,"
                    " detail) values (%s, %s, 'Cảnh báo', %s)",
                    (a + timedelta(days=dd), agent,
                     json.dumps({"rules": rules, "intel_item_id": f"it{i}"})))
    cdb.execute("insert into red_alert_acks (alert_id, acked_by) select id,"
                " 'Người C' from red_alerts where detail->>'intel_item_id'"
                " = 'it3'")
    for kind, period_label, dd in (("inside_out", "2026-09", 11),
                                   ("recon", "2026-09", 11)):
        cdb.execute("insert into audit_runs (kind, period_label, findings,"
                    " report_sha256, run_by, created_at) values (%s, %s, 0,"
                    " %s, 'agent:bks', %s)",
                    (kind, period_label, "f" * 64, a + timedelta(days=dd)))
    cdb.execute("insert into decision_log (entry_kind, decided_on, topic,"
                " decision, decided_by, basis_kind, note, recorded_by,"
                " recorded_at) values ('quyet_dinh', '2026-10-12', 'Chủ đề',"
                " 'Quyết định', 'TGĐ', 'van_ban', 'Văn bản giả p8', 'Người D',"
                " %s)", (a + timedelta(days=12),))
    cdb.execute("insert into feature_rollout (feature_id, stage, updated_by)"
                " values ('ceo-01', 'co_nguoi_duyet', 'test-p8')")
    ar = ro.output_rows(cdb, f, a, a + timedelta(days=20))[0]
    ar_key = next(k for k in ar if k.startswith("ar:"))
    for key, sha, dec, by in (
            ("rp:ceo-par-1.md", "a" * 64, "approved", BY),   # bản cũ
            ("rp:ceo-par-1.md", "b" * 64, "approved", BY),
            ("rp:ceo-par-2.md", "c" * 64, "rejected", BY),
            (ar_key, ar[ar_key]["sha"], "approved", BY)):
        cdb.execute("insert into output_reviews (feature_id, output_key,"
                    " content_sha256, decision, reviewed_by) values"
                    " ('ceo-01', %s, %s, %s, %s)", (key, sha, dec, by))
    spec = Jsonb(ro.count_spec(f, shift))
    for b in (a + timedelta(days=20), a + timedelta(days=6, hours=1),
              a + timedelta(days=2)):
        py = ro.output_facts(cdb, f, a, b, shift)
        db = cdb.execute(
            "select count(*), count(distinct p10_vn_date(ts)) filter (where"
            " rollout_workday(p10_vn_date(ts), %s)), count(*) filter (where"
            " human), count(*) filter (where unapp), count(*) filter (where"
            " unrev), rollout_business_days(%s, %s, %s) from"
            " rollout_db_facts('ceo-01', %s, %s, %s)",
            (spec, a, b, spec, spec, a, b)).fetchone()
        assert py["uncounted"] == ["table=bang_chua_co_bo_dem"], py
        assert (py["outputs"], py["out_days"], py["human"], py["unapproved"],
                py["unreviewed"], ro.business_days(a, b, shift)) == db, (
            b, py, db)
        keys = {r[0] for r in cdb.execute(
            "select k from rollout_db_facts('ceo-01', %s, %s, %s)",
            (spec, a, b))}
        assert set(ro.output_rows(cdb, f, a, b)[0]) == keys
    # bộ dữ liệu phủ đủ nhánh (không khớp giả vì rỗng): 20 ngày
    assert (py["outputs"], py["out_days"], py["human"], py["unapproved"],
            py["unreviewed"]) != (0, 0, 0, 0, 0)
    full = ro.output_facts(cdb, f, a, a + timedelta(days=20), shift)
    assert (full["outputs"], full["out_days"], full["human"],
            full["unapproved"], full["unreviewed"]) == (14, 7, 6, 3, 1), full


def test_p8_utc_helper_aware():
    assert ro._aware("2026-10-05T03:00:00Z") == datetime(
        2026, 10, 5, 3, tzinfo=timezone.utc)
    assert ro._aware("2026-10-05 03:00") is None and ro._aware(5) is None
