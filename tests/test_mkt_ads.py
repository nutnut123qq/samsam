"""v6.4 W64.1–W64.3 + W64.6 (AST) — MKT-05 phiếu thử nghiệm ads
(`agents.mkt_ads`): bảng `ad_test_plans`, chặn cứng offline_only/
listing_only/CAM/XNQC/creative/trần, nạp kết quả xuất tay → đề xuất dừng/
tiếp, "0 đường chi tiền".

Phần thuần không cần DB. Phần DB: schema tạm + golden thật + ROLLBACK
(`tests.test_fp_pnl.fpa_conn`), chỉnh `sku_master` trong schema tạm cho ca
online_ok (golden thật hiện KHÔNG có SKU nào online_ok). Giá vốn/đơn sàn là
MẪU của test FP&A. Ngày "hôm nay" tiêm qua `today` (không wall-clock).
"""

import ast
import json
import re
from datetime import date
from pathlib import Path

import pytest
from psycopg.errors import CheckViolation, RaiseException, UniqueViolation

from agents import fp_ads
from agents import mkt_ads as ma
from pipelines import approval_queue as aq
from pipelines import director, guardrail, store
from tests.test_fp_pnl import OCT, _TxConn, add_costs, fpa_conn, load_fixtures

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "mkt"
TODAY = date(2026, 10, 12)
HONEY = "mat-ong-sam-300ml"
ALCOHOL = ("ruou-sam-chai-thuy-tinh-500ml", "ruou-sam-binh-su-do-500ml")
AD_TEXT = ("Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao "
           "Nội dung có sử dụng AI")
BAN = re.compile(r"rượu|ruou|alcohol", re.IGNORECASE)


def _plan(**kw) -> dict:
    p = {"sku_key": HONEY, "channel": "shopee",
         "hypothesis": "Video 15 giây mở hộp quà có CTR cao hơn ảnh tĩnh",
         "creative_draft_ids": [11], "budget_vnd": 300_000,
         "start_date": "2026-11-02", "end_date": "2026-11-22",
         "success_metric": {"metric": "ctr", "op": ">=", "target": 0.02},
         "stop_rules": [{"metric": "cpc", "op": ">=", "value": 5000}]}
    p.update(kw)
    return p


GOLD = {HONEY: {"category": "food"}, "savina-12v": {"category": "tpbvsk"},
        "savigout-30v": {"category": "tpbvsk"},
        "mat-ong-sam-120ml-1hu": {"category": "food"},
        ALCOHOL[0]: {"category": "alcohol"},
        ALCOHOL[1]: {"category": "alcohol"}}
RD = {(HONEY, "shopee"): "TP_THUONG", ("savina-12v", "shopee"): "QC_DAY_DU",
      ("savina-12v", "tiktok"): "CAM", ("savigout-30v", "shopee"): "MO_TA",
      ("mat-ong-sam-120ml-1hu", "shopee"): "CAM",
      (ALCOHOL[0], "shopee"): "CAM", (ALCOHOL[1], "shopee"): "CAM"}
CRE = {11: {"status": "approved", "sku": HONEY, "content_type": "ads",
            "text": AD_TEXT, "is_ai": True, "verified": True}}
CAP = {"code": "DE_XUAT", "budget_vnd": 300_000}


def _v(plan=None, **kw):
    args = {"golden": GOLD, "readiness": RD, "creatives": CRE, "cap": CAP,
            "today": TODAY, "dossier_ok": False}
    args.update(kw)
    return ma.validate_plan(plan if plan is not None else _plan(), **args)[0]


# ---------- thuần: chặn cứng ----------

def test_reject_codes_fixed_order():
    assert ma.REJECT_CODES == (
        "ADS_INPUT", "ADS_OFFLINE_ONLY", "ADS_LISTING_ONLY", "ADS_CAM",
        "ADS_XNQC_DOSSIER", "ADS_CREATIVE_UNAPPROVED", "ADS_NO_CAP",
        "ADS_OVER_CAP")


def test_pass_and_budget_boundary():
    assert _v() is None
    assert _v(_plan(budget_vnd=300_000)) is None           # = trần
    assert _v(_plan(budget_vnd=300_001)) == "ADS_OVER_CAP"  # trần + 1
    # trần là trần THÁNG: cộng dồn phiếu khác đang giữ trần
    assert _v(_plan(budget_vnd=150_000), allocated=150_000) is None
    assert _v(_plan(budget_vnd=150_000), allocated=150_001) == "ADS_OVER_CAP"
    assert _v(_plan(budget_vnd=1), allocated=300_000) == "ADS_OVER_CAP"
    assert _v(_plan(start_date="2026-10-12",
                    end_date="2026-11-11")) is None          # hôm nay, 30 ngày


@pytest.mark.parametrize("mut", [
    {"sku_key": None}, {"channel": "lazada"}, {"hypothesis": "ngắn"},
    {"creative_draft_ids": []}, {"creative_draft_ids": [1, 2, 3, 4]},
    {"creative_draft_ids": [1, 1]}, {"creative_draft_ids": ["1"]},
    {"budget_vnd": 0}, {"budget_vnd": "300000"}, {"budget_vnd": True},
    {"start_date": "2026-10-11"},                          # trước hôm nay VN
    {"start_date": "2026-11-02", "end_date": "2026-12-03"},  # 31 ngày
    {"end_date": "2026-11-01"}, {"start_date": "02/11/2026"},
    {"start_date": "2026-02-30"},
    {"success_metric": {"metric": "roas", "op": ">=", "target": 2}},
    {"success_metric": {"metric": "ctr", "op": ">", "target": 0.02}},
    {"success_metric": {"metric": "ctr", "op": ">=", "target": 0}},
    {"success_metric": {"metric": "ctr", "op": ">=", "target": True}},
    {"stop_rules": []}, {"stop_rules": [{"metric": "la", "op": ">=",
                                         "value": 1}]},
    {"stop_rules": [{"metric": "cpc", "op": ">=", "value": -1}]},
    {"ngan_sach_tang": 1}])
def test_input_rejected(mut):
    assert _v(_plan(**mut)) == "ADS_INPUT", mut


def test_missing_field_and_non_object():
    p = _plan()
    del p["stop_rules"]
    assert _v(p) == "ADS_INPUT"
    assert _v([]) == "ADS_INPUT"
    assert _v(_plan(_doc="ghi chú MẪU")) is None   # _doc được bỏ qua


@pytest.mark.parametrize("sku", ALCOHOL)
def test_offline_only_alcohol_even_if_readiness_says_ok(sku):
    rd = {**RD, (sku, "shopee"): "TP_THUONG"}      # golden ghi nhầm kênh
    cre = {11: {**CRE[11], "sku": sku}}
    assert _v(_plan(sku_key=sku), readiness=rd, creatives=cre) == \
        "ADS_OFFLINE_ONLY"
    code, why = ma.validate_plan(_plan(sku_key=sku), golden=GOLD,
                                 readiness=RD, creatives=CRE, cap=CAP,
                                 today=TODAY)
    assert code == "ADS_OFFLINE_ONLY" and sku not in why


def test_listing_only_cam_and_dossier():
    assert _v(_plan(sku_key="savigout-30v")) == "ADS_LISTING_ONLY"
    assert _v(_plan(sku_key="mat-ong-sam-120ml-1hu")) == "ADS_CAM"
    assert _v(_plan(sku_key="savina-12v", channel="tiktok")) == "ADS_CAM"
    assert _v(_plan(sku_key="khong-co-sku")) == "ADS_CAM"
    # readiness có mà golden không có SKU → vẫn CAM (fail-closed)
    assert _v(_plan(sku_key="la-x"), readiness={**RD, ("la-x", "shopee"):
                                                "TP_THUONG"}) == "ADS_CAM"
    # TPBVSK QC_DAY_DU nhưng không có hồ sơ da_cap còn hạn
    assert _v(_plan(sku_key="savina-12v")) == "ADS_XNQC_DOSSIER"
    # có hồ sơ → qua, tới creative (draft là SKU khác)
    assert _v(_plan(sku_key="savina-12v"), dossier_ok=True) == \
        "ADS_CREATIVE_UNAPPROVED"


def test_creative_unapproved_variants():
    base = CRE[11]
    for c in (None, {**base, "status": "pending"},
              {**base, "status": "rejected"}, {**base, "sku": "savina-12v"},
              {**base, "content_type": "post"},
              {**base, "verified": False},
              {**base, "text": "Mật ong sâm 300ml — quà biếu Tết"}):  # thiếu nhãn
        cre = {} if c is None else {11: c}
        assert _v(creatives=cre) == "ADS_CREATIVE_UNAPPROVED", c
    # 1 trong 2 biến thể hỏng → cả phiếu bị chặn
    cre = {11: base, 12: {**base, "status": "pending"}}
    assert _v(_plan(creative_draft_ids=[11, 12]), creatives=cre) == \
        "ADS_CREATIVE_UNAPPROVED"
    # ảnh (image) đã duyệt được dùng làm creative
    assert _v(creatives={11: {**base, "content_type": "image"}}) is None


def test_no_cap_and_priority():
    for cap in (None, {"code": "CHO_DU_LIEU", "budget_vnd": 0},
                {"code": "NGOAI_KENH_ADS", "budget_vnd": 0},
                {"code": "DUOI_NGUONG", "budget_vnd": 0}):
        assert _v(cap=cap) == "ADS_NO_CAP", cap
    # ưu tiên: input > rượu > ... ; rượu + creative hỏng → rượu
    assert _v(_plan(sku_key=ALCOHOL[0], budget_vnd=0)) == "ADS_INPUT"
    assert _v(_plan(sku_key=ALCOHOL[0]), creatives={}, cap=None) == \
        "ADS_OFFLINE_ONLY"
    assert _v(_plan(sku_key="savigout-30v"), creatives={}) == \
        "ADS_LISTING_ONLY"


def test_plan_sha_stable():
    n1, _ = ma.normalize_plan(_plan(), TODAY)
    n2, _ = ma.normalize_plan(json.loads(json.dumps(_plan(_doc="x"))), TODAY)
    assert ma.plan_sha(n1) == ma.plan_sha(n2)
    n3, _ = ma.normalize_plan(_plan(budget_vnd=299_999), TODAY)
    assert ma.plan_sha(n3) != ma.plan_sha(n1)


# ---------- thuần: kết quả ----------

PLAN_ROW = {"id": 7, "creative_draft_ids": [101, 102], "budget_vnd": 1_000_000,
            "start_date": date(2026, 11, 2), "end_date": date(2026, 11, 22),
            "success_metric": {"metric": "ctr", "op": ">=", "target": "0.02"},
            "stop_rules": [{"metric": "cpc", "op": ">=", "value": "5000"}],
            "sku_key": HONEY, "channel": "shopee"}


def _r(v=101, hien=10_000, click=100, chi=100_000, don=1, d=date(2026, 11, 3)):
    return {"row_no": 2, "ngay": d, "bien_the": v, "hien_thi": hien,
            "click": click, "chi_phi_vnd": chi, "don_hang": don}


def test_evaluate_decisions():
    ev = ma.evaluate(PLAN_ROW, [_r(click=10, chi=60_000)])     # cpc 6000
    assert ev["de_xuat"] == "dung" and len(ev["stop_hits"]) == 1
    ev = ma.evaluate(PLAN_ROW, [_r(click=300, chi=300_000)])   # ctr 3%
    assert ev["de_xuat"] == "dat_muc_tieu" and ev["stop_hits"] == []
    ev = ma.evaluate(PLAN_ROW, [_r(click=100, chi=100_000)])   # ctr 1%
    assert ev["de_xuat"] == "tiep"
    ev = ma.evaluate(PLAN_ROW, [_r(hien=0, click=0, chi=0, don=0)])
    assert ev["de_xuat"] == "chua_du_lieu"
    assert ev["tong"]["ctr"] is None and ev["tong"]["cpc"] is None
    assert ev["tong"]["cpa"] is None and ev["bien_the"][102]["ctr"] is None
    ev = ma.evaluate(PLAN_ROW, [_r(click=300, chi=1_000_000)])  # = ngân sách
    assert ev["de_xuat"] == "dung" and ev["co"] == [ma.FLAG_SPENT]
    ev = ma.evaluate(PLAN_ROW, [_r(click=300, chi=600_000),
                                _r(v=102, click=300, chi=500_000)])
    assert ev["de_xuat"] == "dung" and ev["co"] == [ma.FLAG_OVER]
    assert ev["bien_the"][102]["chi_phi_vnd"] == 500_000
    assert set(ma.DECISIONS) == {"dung", "dat_muc_tieu", "tiep",
                                 "chua_du_lieu"}
    text = ma.render_result({**PLAN_ROW}, ev, "a" * 64, 2)
    assert "tăng ngân sách" not in text.lower() and ma.FLAG_OVER in text
    assert guardrail.check(text)["ok"] is True


def test_read_results_fixture_and_errors(tmp_path):
    rows, errs, sha = ma.read_results(FIX / "ads_ket_qua_MAU.csv", PLAN_ROW)
    assert errs == [] and len(rows) == 3 and len(sha) == 64
    ev = ma.evaluate(PLAN_ROW, rows)
    assert ev["tong"]["chi_phi_vnd"] == 1_500_000 and ev["co"] == [
        ma.FLAG_OVER]
    secret = "0909123456"
    bad = tmp_path / "bad.csv"
    bad.write_bytes(("ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang,"
                     "ten_khach\n2026-11-03,101,1,1,1,1," + secret + "\n")
                    .encode("utf-8"))
    rows, errs, _ = ma.read_results(bad, PLAN_ROW)
    assert rows == [] and any("cột 'ten_khach'" in e and "cột lạ" in e
                              for e in errs)
    secret2 = "0909 123 456"
    lines = ["ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang",
             f"2026-11-03,999,{secret2},1,1,1",         # biến thể lạ + số lạ
             "2026-12-30,101,10,1,1,1",                 # ngoài thời gian
             "2026-11-03,101,10,11,1,1",                # click > hien_thi
             "2026-11-03,101,10,1,-5,1",                # âm
             "2026-11-03,101,10,1,12.5,1"]              # không nguyên
    bad.write_bytes("\r\n".join(lines).encode("utf-8"))
    rows, errs, _ = ma.read_results(bad, PLAN_ROW)
    joined = "\n".join(errs)
    assert rows == []
    for needle in ("dòng 2 cột bien_the", "dòng 2 cột hien_thi",
                   "dòng 3 cột ngay", "dòng 4 cột click",
                   "dòng 5 cột chi_phi_vnd", "dòng 6 cột chi_phi_vnd"):
        assert needle in joined, needle
    assert secret2 not in joined and "12.5" not in joined
    bad.write_bytes(b"ngay,bien_the\n")
    assert ma.read_results(bad, PLAN_ROW)[1]
    bad.write_bytes(b"")
    assert ma.read_results(bad, PLAN_ROW)[1] == ["file rỗng"]
    bad.write_bytes(b"\xff\xfe\x00")
    assert ma.read_results(bad, PLAN_ROW)[1] == ["file không phải UTF-8"]
    ok = tmp_path / "ok.csv"
    ok.write_bytes(b"ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang\n"
                   b"2026-11-03,101,1.234.567,1,1,1\n")
    rows, errs, _ = ma.read_results(ok, PLAN_ROW)
    assert errs == [] and rows[0]["hien_thi"] == 1_234_567
    # ô > csv field_limit (131072) → lỗi file, không traceback (OWASP v6.4)
    bad.write_bytes(b"ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang\n"
                    b"2026-11-03,\"" + b"9" * 200_000 + b"\",1,1,1,1\n")
    assert ma.read_results(bad, PLAN_ROW)[1] == [
        "file CSV hỏng (ô quá lớn hoặc sai định dạng)"]


# ---------- CLI không DB ----------

@pytest.mark.parametrize("argv", [
    ["--plan", "x.json", "--status", "1"], [], ["--plan", "x.json"],
    ["--results", "x.csv", "--by", "a"], ["--status", "1", "--month", "13"],
    ["--plan", "x.json", "--by", "  "]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(ma, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        ma.main(argv, today=TODAY)
    assert e.value.code == 2 and calls == []


def test_cli_input_rejected_before_connect(monkeypatch, tmp_path, capsys):
    calls = []
    monkeypatch.setattr(ma, "connect", lambda: calls.append(1))
    p = tmp_path / "p.json"
    p.write_text(json.dumps(_plan(budget_vnd=-1)), encoding="utf-8")
    assert ma.main(["--plan", str(p), "--by", "a"], today=TODAY) == 1
    assert "ADS_INPUT" in capsys.readouterr().out and calls == []
    p.write_text("{", encoding="utf-8")
    assert ma.main(["--plan", str(p), "--by", "a"], today=TODAY) == 1
    assert calls == []


# ---------- "0 đường chi tiền" (W64.6) ----------

MODULES = ("agents/mkt_ads.py", "agents/mkt_koc.py", "agents/mkt_ugc.py")
STDLIB_OK = {"argparse", "csv", "hashlib", "io", "json", "os", "re", "sys",
             "unicodedata", "contextlib", "datetime", "decimal", "pathlib"}
PROJECT = {"agents", "ingest", "pipelines", "scripts"}


def test_no_ads_api_no_spend():
    from scripts.dpia_draft import egress_modules
    assert not set(MODULES) & egress_modules()
    for m in MODULES:
        src = (ROOT / m).read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom):
                roots = {(node.module or "").split(".")[0]}
                if node.module == "pipelines.llm_gateway":
                    assert {a.name for a in node.names} <= {
                        "is_health_question", "_strip_accents"}, m
                if node.module == "pipelines":
                    assert "llm_gateway" not in {a.name for a in node.names}
            else:
                continue
            assert roots <= STDLIB_OK | {"psycopg"} | PROJECT, (m, roots)
        assert not re.search(
            r"graph\.facebook\.com|business-api\.tiktok\.com|ads\.google|"
            r"facebook_business|tiktok_business|googleads|httpx|requests|"
            r"urllib|smtplib|openai|socket", src), m


# ---------- DB thật (schema tạm + rollback) ----------

@pytest.fixture
def db(monkeypatch):
    monkeypatch.delenv("GUARDRAIL_LLM_MODEL", raising=False)
    yield from fpa_conn()


def _counts(db):
    return tuple(db.execute(f"select count(*) from {t}").fetchone()[0]
                 for t in ("ad_test_plans", "approval_queue"))


_BASE = {"plan_sha256": "a" * 64, "sku_key": HONEY, "channel": "shopee",
         "hypothesis": "giả thuyết MẪU đủ dài", "creative_draft_ids": [1],
         "budget_vnd": 100, "cap_vnd": 100, "cap_ref_month": OCT,
         "start_date": date(2026, 11, 2), "end_date": date(2026, 11, 22),
         "success_metric": json.dumps({"metric": "ctr"}),
         "stop_rules": json.dumps([{"metric": "cpc"}]),
         "readiness": "TP_THUONG", "created_by": "lap A"}


def _ins(db, **kw):
    row = {**_BASE, **kw}
    cols = ", ".join(row)
    ph = ", ".join("%s" for _ in row)
    return db.execute(f"insert into ad_test_plans ({cols}) values ({ph})"
                      " returning id", list(row.values())).fetchone()[0]


def test_db_schema_constraints(db):
    for kw, exc in (({"readiness": "MO_TA"}, CheckViolation),
                    ({"readiness": "CAM"}, CheckViolation),
                    ({"budget_vnd": 101}, CheckViolation),
                    ({"creative_draft_ids": [1, 2, 3, 4]}, CheckViolation),
                    ({"stop_rules": "[]"}, CheckViolation),
                    ({"end_date": date(2026, 12, 3)}, CheckViolation),
                    ({"created_by": "  "}, CheckViolation),
                    ({"plan_sha256": "xyz"}, CheckViolation),
                    ({"channel": "lazada"}, CheckViolation)):
        with pytest.raises(exc), db.transaction():
            _ins(db, **kw)
    pid = _ins(db)
    for sql in ("update ad_test_plans set budget_vnd = 1 where id = %s",
                "delete from ad_test_plans where id = %s"):
        with pytest.raises(RaiseException) as e, db.transaction():
            db.execute(sql, (pid,))
        assert "append-only" in str(e.value)
    with pytest.raises(UniqueViolation), db.transaction():
        _ins(db)


def test_director_marketing_types():
    cfg = director.load_config("marketing")
    t = cfg["object_types"]
    assert set(t) == {"ad_campaign", "listing_copy", "koc_brief",
                      "campaign_brief", "ugc_reply", "ugc_reuse",
                      "seo_web_fix"}  # + v6.5 MKT-10
    assert t["ugc_reply"] == {"sla_hours": 24, "risk": "medium"}
    assert t["ugc_reuse"] == {"sla_hours": 72, "risk": "high"}
    assert t["ad_campaign"]["risk"] == "high" and cfg["approvers"] == []
    fin = director.load_config("finance")
    assert fin["object_types"]["budget_change"]["risk"] == "high"


class _Env:
    def __init__(self, db, monkeypatch):
        load_fixtures(db, monkeypatch)
        add_costs(db, monkeypatch)
        db.execute("update sku_master set self_declaration_ok = true where"
                   " sku_key = %s", (HONEY,))
        self.db, self.tx = db, _TxConn(db)
        self.cfg, self.dcfg, why = ma.load_cfgs()
        assert why is None

    def draft(self, text=AD_TEXT, sku=HONEY, ct="ads", decide="approve"):
        g = guardrail.check_publish(text, channel="shopee", content_type=ct,
                                    sku=sku, is_ai=True)
        did = store.save_draft(self.tx, "brief MẪU", "shopee", text, g,
                               created_by="mkt lap", content_type=ct,
                               sku=sku, is_ai=True)
        if decide == "approve":
            self.db.execute("select approve_draft(%s, 'duyet mkt', null)",
                            (did,))
        elif decide == "reject":
            self.db.execute("select reject_draft(%s, 'duyet mkt', 'MẪU')",
                            (did,))
        return did

    def submit(self, plan, **kw):
        return ma.submit_plan(self.tx, plan, by="mkt lap", month=OCT,
                              cfg=self.cfg, dcfg=self.dcfg, today=TODAY, **kw)


def test_db_rejections_write_nothing(db, monkeypatch):
    env = _Env(db, monkeypatch)
    d_ok = env.draft()
    d_pending = env.draft(decide=None)
    d_rej = env.draft(decide="reject")
    d_other = env.draft(text="Mật ong sâm 120ml — quà nhỏ xinh. #quangcao "
                        "Nội dung có sử dụng AI", sku="mat-ong-sam-120ml-1hu")
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)
    assert cap["code"] == "DE_XUAT" and cap["budget_vnd"] > 0
    before = _counts(db)

    def code(**kw):
        res = env.submit(_plan(**{"creative_draft_ids": [d_ok], **kw}))
        assert _counts(db) == before, kw
        return res["code"]

    for k in ALCOHOL:
        assert code(sku_key=k) == "ADS_OFFLINE_ONLY"
    db.execute("update sku_master set allowed_channels = '{shopee,tiktok}',"
               " xnqc_status = 'approved', self_declaration_ok = true where"
               " category = 'alcohol'")
    assert code(sku_key=ALCOHOL[0]) == "ADS_OFFLINE_ONLY"
    assert code(sku_key="savigout-30v") == "ADS_LISTING_ONLY"   # xnqc none
    db.execute("update sku_master set xnqc_status = 'pending' where sku_key"
               " = 'savina-12v'")
    assert code(sku_key="savina-12v") == "ADS_LISTING_ONLY"     # pending
    assert code(sku_key="mat-ong-sam-120ml-1hu") == "ADS_CAM"    # null
    assert code(sku_key="khong-co-sku") == "ADS_CAM"
    db.execute("update sku_master set xnqc_status = 'approved' where sku_key"
               " = 'savina-12v'")
    assert code(sku_key="savina-12v", channel="tiktok") == "ADS_CAM"
    assert code(sku_key="savina-12v") == "ADS_XNQC_DOSSIER"
    db.execute("insert into documents (sha256, filename, doc_type,"
               " text_source) values (%s, 'xnqc-MAU.pdf', 'khac', 'none')",
               ("d" * 64,))
    dossier = ("insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so,"
               " status, so_giay, ngay_nop, ngay_cap, ngay_het_han,"
               " document_sha256, updated_by) values ('savina-12v', 'maket',"
               " 'MẪU', 'da_cap', 'XNQC-MAU', %s, %s, %s, %s, 'Phap che A')")
    db.execute(dossier, (date(2025, 1, 1), date(2025, 1, 2),
                         date(2026, 10, 11), "d" * 64))   # hết hạn hôm qua
    assert code(sku_key="savina-12v") == "ADS_XNQC_DOSSIER"
    db.execute(dossier, (date(2025, 1, 1), date(2025, 1, 2),
                         date(2026, 10, 12), "d" * 64))   # còn hạn hôm nay
    assert code(sku_key="savina-12v") == "ADS_CREATIVE_UNAPPROVED"
    for d in (d_pending, d_rej, d_other, 99_999_999):
        assert code(creative_draft_ids=[d]) == "ADS_CREATIVE_UNAPPROVED", d
    assert code(budget_vnd=cap["budget_vnd"] + 1) == "ADS_OVER_CAP"
    db.execute("update sku_master set self_declaration_ok = true where"
               " sku_key = 'mat-ong-sam-120ml-2hu'")     # không giá vốn
    d2 = env.draft(text="Mật ong sâm 120ml hai hũ — quà biếu. #quangcao Nội"
                   " dung có sử dụng AI", sku="mat-ong-sam-120ml-2hu")
    before = _counts(db)
    assert code(sku_key="mat-ong-sam-120ml-2hu", creative_draft_ids=[d2]) \
        == "ADS_NO_CAP"
    assert code(channel="facebook") in ("ADS_CAM", "ADS_NO_CAP")


def test_db_plan_flow(db, monkeypatch, tmp_path, capsys):
    env = _Env(db, monkeypatch)
    d1, d2 = env.draft(), env.draft(text="Mật ong sâm 300ml — vị ngọt dịu "
                                    "cho bữa sáng. #quangcao Nội dung có sử "
                                    "dụng AI")
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)["budget_vnd"]
    plan = json.loads((FIX / "ads_plan_mat_ong_MAU.json")
                      .read_text(encoding="utf-8"))
    plan.update(creative_draft_ids=[d1, d2], budget_vnd=cap)
    pf = tmp_path / "plan.json"
    pf.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(ma, "connect", lambda: _TxConn(db))
    base = ["--plan", str(pf), "--by", "mkt lap", "--month", "2026-10"]
    assert ma.main(base + ["--dry-run"], today=TODAY) == 0
    assert _counts(db) == (0, 0) and "[dry-run]" in capsys.readouterr().out
    assert ma.main(base, today=TODAY) == 0
    out = capsys.readouterr().out
    (pid, pc, pb) = db.execute("select id, cap_vnd, budget_vnd from"
                               " ad_test_plans").fetchone()
    assert pc == pb == cap and f"phiếu #{pid}" in out
    items = db.execute(
        "select id, block, object_type, object_id, risk, status, created_by,"
        " guardrail->>'ok', payload from approval_queue order by id"
    ).fetchall()
    assert [(b, t, o, r, s, c, g) for _, b, t, o, r, s, c, g, _ in items] == [
        ("marketing", "ad_campaign", f"adtest-{pid}", "high", "pending",
         "mkt lap", "true"),
        ("finance", "budget_change", f"adtest-{pid}", "high", "pending",
         "mkt lap", "true")]
    payload = items[0][8]
    assert "agent không chi tiền" in payload and "không gọi API" in payload
    assert not BAN.search(payload)
    assert not fp_ads.pending_for_month(db, OCT)      # prefix không đụng ads-
    # chạy lại cùng file → không thêm dòng/mục
    assert ma.main(base, today=TODAY) == 0
    assert _counts(db) == (1, 2) and "đã có" in capsys.readouterr().out
    # risk high → auto_policy không áp; người lập tự duyệt → bị chặn
    tx = _TxConn(db)
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('ads_auto_test',"
               " 'ad_campaign', 'low', true, 'Chu Khoi Gia Lap (test)', now())")
    ok, msg = aq.auto_approve(tx, items[0][0])
    assert ok is False and "rủi ro high" in msg
    ok, msg = aq.decide(tx, items[0][0], " MKT LAP ", "approved")
    assert ok is False and "trùng người tạo" in msg
    assert ma.plan_status(db, pid) == "cho_duyet"
    # nạp kết quả khi chưa duyệt đủ → từ chối, 0 ghi
    lines = (FIX / "ads_ket_qua_MAU.csv").read_text(encoding="utf-8")
    rf = tmp_path / "kq.csv"
    rf.write_text(lines.replace(",101,", f",{d1},").replace(",102,",
                                                            f",{d2},"),
                  encoding="utf-8")
    rargs = ["--results", str(rf), "--plan-id", str(pid), "--by", "mkt lap"]
    assert ma.main(rargs, today=TODAY) == 1
    assert ma.NOT_APPROVED in capsys.readouterr().out
    assert _counts(db) == (1, 2)
    assert aq.decide(tx, items[0][0], "GD Marketing", "approved") == (True,
                                                                     None)
    assert ma.plan_status(db, pid) == "cho_duyet"      # mới 1/2
    assert ma.main(rargs, today=TODAY) == 1 and _counts(db) == (1, 2)
    assert aq.decide(tx, items[1][0], "TGD", "approved") == (True, None)
    assert ma.plan_status(db, pid) == "da_duyet"
    assert ma.main(["--status", str(pid)], today=TODAY) == 0
    assert "da_duyet" in capsys.readouterr().out
    # đã duyệt đủ → 1 mục đề xuất dừng/tiếp; nạp lại cùng file → skip
    assert ma.main(rargs, today=TODAY) == 0
    out = capsys.readouterr().out
    assert "đề xuất dung" in out and ma.FLAG_OVER in out
    res = db.execute("select object_type, object_id, risk, status, payload"
                     " from approval_queue where object_id like 'adres-%'"
                     ).fetchall()
    assert len(res) == 1 and res[0][:4] == (
        "ad_campaign", res[0][1], "high", "pending")
    assert res[0][1].startswith(f"adres-{pid}-")
    assert "tăng ngân sách" not in res[0][4].lower()
    assert ma.main(rargs, today=TODAY) == 0
    assert "[skip]" in capsys.readouterr().out and _counts(db) == (1, 3)
    # plan_status: thiếu mục / bị từ chối
    pid2 = _ins(db, plan_sha256="b" * 64)
    assert ma.plan_status(db, pid2) == "thieu_muc"
    # mục adtest-<id> do nguồn khác đẩy vào với nội dung KHÁC phiếu → dù
    # duyệt đủ 2 vẫn không "đã duyệt" (verify_publish lệch sha)
    for block, otype in ma.ITEMS:
        q = director.submit(tx, block, otype, f"adtest-{pid2}", "giả",
                            "Phiếu giả MẪU — nội dung khác dòng phiếu",
                            created_by="nguon khac", cfg=env.dcfg[block])
        assert aq.decide(tx, q, f"GD {block}", "approved") == (True, None)
    assert ma.plan_status(db, pid2) == "lech_ban_duyet"
    # CÙNG 1 người duyệt cả 2 mục (khác hoa/space) → không "đã duyệt"
    pid3 = _ins(db, plan_sha256="c" * 64)
    for (block, otype), who in zip(ma.ITEMS, ("GD Kep", " gd kep ")):
        q = director.submit(tx, block, otype, f"adtest-{pid3}", "giả",
                            "Phiếu giả MẪU", created_by="nguon khac",
                            cfg=env.dcfg[block])
        assert aq.decide(tx, q, who, "approved") == (True, None)
    assert ma.plan_status(db, pid3) == "cung_nguoi_duyet"
    # phiếu #1 đã giữ trọn trần tháng → phiếu 2 (đổi giả thuyết = sha mới)
    # cùng SKU × kênh × tháng bị chặn
    before = _counts(db)
    plan2 = {**plan, "hypothesis": plan["hypothesis"] + " (vòng 2)",
             "budget_vnd": 1}
    assert env.submit(plan2)["code"] == "ADS_OVER_CAP"
    assert _counts(db) == before


def test_db_cap_cumulative_split_rejected(db, monkeypatch):
    """Chẻ 1 trần tháng thành nhiều phiếu (đổi giả thuyết → sha mới) không
    lách được: tổng phiếu chưa từ chối/hết hạn ≤ trần; phiếu bị từ chối trả
    trần lại; payload hiện số đã phân bổ cho người duyệt."""
    env = _Env(db, monkeypatch)
    d = env.draft()
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)["budget_vnd"]
    assert cap >= 4

    def p(tag, budget, **kw):
        return _plan(creative_draft_ids=[d], budget_vnd=budget,
                     hypothesis=f"Video mở hộp quà CTR cao hơn ảnh — {tag}",
                     **kw)

    a = env.submit(p("A", cap // 2 + 1))
    assert a["code"] is None and len(a["new_items"]) == 2
    before = _counts(db)
    b = env.submit(p("B", cap // 2))
    assert b["code"] == "ADS_OVER_CAP" and "đã phân bổ" in b["reason"]
    assert _counts(db) == before
    # khung chạy khác nhưng cùng tháng lịch 11 vẫn cộng dồn
    assert env.submit(p("B2", cap // 2, start_date="2026-11-23",
                        end_date="2026-11-30"))["code"] == "ADS_OVER_CAP"
    assert _counts(db) == before
    # vừa khít trần → đạt; payload ghi số đã phân bổ lúc lập
    c = env.submit(p("C", cap - (cap // 2 + 1)))
    assert c["code"] is None
    (alloc,) = db.execute("select allocated_vnd from ad_test_plans where"
                          " id = %s", (c["plan_id"],)).fetchone()
    assert alloc == cap // 2 + 1
    pay = db.execute("select payload from approval_queue where id = %s",
                     (c["new_items"][0],)).fetchone()[0]
    assert f"đã giữ {fp_ads.vnd(alloc)}" in pay
    before = _counts(db)
    assert env.submit(p("D", 1))["code"] == "ADS_OVER_CAP"
    assert _counts(db) == before
    # cùng P&L tham chiếu (OCT) = cùng 1 trần tháng, dù khung chạy tháng 12
    assert env.submit(p("E", 1, start_date="2026-12-01",
                        end_date="2026-12-20"))["code"] == "ADS_OVER_CAP"
    # phiếu A bị từ chối → trả trần, phiếu D đạt
    assert aq.decide(env.tx, a["new_items"][1], "TGD", "rejected")[0]
    assert ma.plan_status(db, a["plan_id"]) == "tu_choi"
    assert env.submit(p("D", 1))["code"] is None
    # phiếu cũ chạy lại (cùng sha) không tự đếm chính nó
    assert env.submit(p("C", cap - (cap // 2 + 1)))["created"] is False
    # đổi tháng P&L tham chiếu (--month) không mở thêm trần cho tháng lịch
    # đã giữ: P&L tháng 9 có trần riêng (giả lập) vẫn cộng dồn phiếu tháng 11
    monkeypatch.setattr(ma, "cap_for", lambda *a, **k: {
        "code": "DE_XUAT", "budget_vnd": cap})
    before = _counts(db)
    sep = {"by": "mkt lap", "month": date(2026, 9, 1), "cfg": env.cfg,
           "dcfg": env.dcfg, "today": TODAY}
    # A đã trả trần; C + D đang giữ cap - cap // 2 → thêm cap // 2 + 1 vượt
    res = ma.submit_plan(env.tx, p("F", cap // 2 + 1), **sep)
    assert res["code"] == "ADS_OVER_CAP" and _counts(db) == before
    # P&L khác + tháng lịch khác (12) → không bị phiếu tháng 11 giữ chỗ
    assert ma.submit_plan(env.tx, p("G", cap, start_date="2026-12-01",
                                    end_date="2026-12-20"),
                          **sep)["code"] is None


def test_db_cap_recheck_under_lock(db, monkeypatch):
    """Phiếu khác ghi giữa lúc đọc ngữ cảnh và lúc ghi → đếm lại sau khóa
    advisory chặn, 0 ghi."""
    env = _Env(db, monkeypatch)
    d = env.draft()
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)["budget_vnd"]
    real = ma.load_context

    def racy(conn, norm, month, cfg, today):
        ctx = real(conn, norm, month, cfg, today)
        _ins(db, budget_vnd=cap, cap_vnd=cap)    # "song song" giữ trọn trần
        return ctx

    monkeypatch.setattr(ma, "load_context", racy)
    before = _counts(db)
    res = env.submit(_plan(creative_draft_ids=[d], budget_vnd=1))
    assert res["code"] == "ADS_OVER_CAP" and "song song" in res["reason"]
    assert _counts(db) == (before[0] + 1, before[1])   # chỉ dòng "song song"


def test_db_hypothesis_violating_guardrail_rejected(db, monkeypatch):
    env = _Env(db, monkeypatch)
    d = env.draft()
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)["budget_vnd"]
    before = _counts(db)
    res = env.submit(_plan(creative_draft_ids=[d], budget_vnd=cap,
                           hypothesis="Video nói sản phẩm chữa mất ngủ"))
    assert res["code"] == "ADS_INPUT" and "guardrail" in res["reason"]
    assert _counts(db) == before
