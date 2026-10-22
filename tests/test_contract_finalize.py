"""Đợt hoàn thiện 22/10/2026 — danh mục theo DOCX (89 AI / 9 khối, P1 80 /
P2 9) + các đầu ra tách riêng có căn cứ PL01. DB thật = schema tạm + roles
(ROLLBACK cuối, như các test hợp đồng khác)."""

import json
from datetime import datetime, timedelta

import pytest

from agents import ceo_audit, mkt_ads, mkt_ugc, sx_tracuu
from agents import vt_thoitiet as vt
from ingest import intel_import as ii
from ingest import product_dossiers as pdo
from pipelines import llm_gateway as gw
from pipelines import rollout
from tests.test_ceo_audit import TxConn, ceo_db
from tests.test_llm_gateway import FakeClient, FakeConn

NOW = datetime.fromisoformat("2026-10-14T18:00:00+07:00")
DOCX = {"ceo": 9, "sales": 12, "marketing": 14, "intel": 11, "finance": 9,
        "production": 6, "farming": 9, "legal_hr": 10, "data_platform": 9}


@pytest.fixture
def db():
    yield from ceo_db()


def _feats():
    return rollout.load_features()


def _f(fid):
    return next(f for f in _feats() if f["id"] == fid)


# ------------------------------------------------------------ danh mục


def test_catalog_matches_docx_per_block_and_phase():
    ai = [f for f in _feats() if f["pham_vi"] == "tinh_nang_ai"]
    assert {b: sum(f["phong_ban"] == b for f in ai) for b in DOCX} == DOCX
    assert sum(f["giai_doan"] == "P1" for f in ai) == 80
    assert sorted(f["id"] for f in ai if f["giai_doan"] == "P2") == [
        "ceo-05", "farming-05.2", "farming-05.3", "farming-05.4",
        "legal_hr-07", "marketing-07.1", "marketing-07.2", "production-05.1",
        "production-05.2"]
    # nền tảng / blockchain / nghĩa vụ ngoài code KHÔNG bù số AI
    out = [f for f in _feats() if f["pham_vi"] != "tinh_nang_ai"]
    assert {f["pham_vi"] for f in out} == {"nen_tang_tmdt",
                                           "truy_xuat_blockchain",
                                           "nghia_vu_hd"}


def test_superseded_registry_two_way_and_not_in_features():
    doc = json.loads(rollout.FEATURES_FILE.read_text(encoding="utf-8"))
    ids = {f["id"] for f in doc["features"]}
    gone = {g["id"]: g for g in doc["da_thay_the"]}
    assert len(gone) == 14 and not set(gone) & ids
    for f in doc["features"]:
        for o in f.get("thay_the", []):
            assert f["id"] in gone[o]["thay_bang"]
    assert not any(f["acceptance_status"] != "chua_nghiem_thu"
                   for f in doc["features"])


@pytest.mark.parametrize("mutate,msg", [
    (lambda d: d["da_thay_the"].pop(0), "thay_the"),
    (lambda d: d["da_thay_the"][0]["thay_bang"].append("ceo-01"),
     "thiếu id cũ"),
    (lambda d: d["da_thay_the"].append({"id": "ceo-01", "thay_bang":
                                        ["ceo-01"], "ly_do": "x"}),
     "còn trong features"),
    (lambda d: d["da_thay_the"][0].update(ly_do=" "), "ly_do")])
def test_superseded_registry_fail_closed(tmp_path, mutate, msg):
    doc = json.loads(rollout.FEATURES_FILE.read_text(encoding="utf-8"))
    mutate(doc)
    p = tmp_path / "c.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match=msg):
        rollout.load_features(p)


@pytest.mark.parametrize("old_stage,want", [("tat", "tat"),
                                            ("van_hanh", "chay_thu"),
                                            (None, "chay_thu")])
def test_seed_new_id_fresh_date_inherits_only_off(db, old_stage, want):
    old_since = NOW - timedelta(days=40)
    if old_stage:
        db.execute("insert into feature_rollout (feature_id, stage,"
                   " stage_since, updated_by, updated_at) values"
                   " ('marketing-03', %s, %s, 'Người Cũ', %s)",
                   (old_stage, old_since, old_since))
    f = _f("marketing-03.1")
    st = rollout.seed(TxConn(db), [f], "Owner Thử", now=NOW)
    assert st["inserted"] == 1
    stage, since = db.execute("select stage, stage_since from feature_rollout"
                              " where feature_id = 'marketing-03.1'"
                              ).fetchone()
    assert stage == want and since == NOW         # mốc MỚI, không kế thừa
    if old_stage:                                 # dòng id cũ giữ nguyên
        assert db.execute("select stage, stage_since from feature_rollout"
                          " where feature_id = 'marketing-03'").fetchone() \
            == (old_stage, old_since)
    ev = db.execute("select evidence from feature_rollout_events where"
                    " feature_id = 'marketing-03.1'").fetchone()[0]
    assert ev["thay_the"] == {"marketing-03": old_stage}


def test_red_alert_counted_once_by_first_rule(db):
    ins = ("insert into red_alerts (source_agent, title, detail, ts) values"
           " ('intel_red_alert', 't', %s, %s)")
    for i, rules in enumerate((["counterfeit", "brand_negative"],
                               ["brand_negative", "counterfeit"],
                               ["regulation"], ["legal_doc", "regulation"])):
        db.execute(ins, (json.dumps({"intel_item_id": i, "rules": rules}),
                         NOW))          # ts do DB đặt = now() thật
    shift = rollout.load_shift()
    now = datetime.now(NOW.tzinfo)
    n = {fid: rollout.output_facts(TxConn(db), _f(fid), now - timedelta(
        days=1), now + timedelta(hours=1), shift)["outputs"] for fid in (
        "intel-02.1", "intel-02.2", "intel-02.3", "legal_hr-07")}
    # trước: `?|` đếm cảnh báo #0 ở cả 02.1 lẫn 02.3, #3 ở 02.2 lẫn legal_hr-07
    assert n == {"intel-02.1": 1, "intel-02.2": 1, "intel-02.3": 1,
                 "legal_hr-07": 1}


# ------------------------------------------------- đầu ra tách riêng


def _seed_logs(db):
    db.execute("insert into plots (id, source) values ('KV-P1', 'test-p')")
    db.execute("insert into plot_logs (plot_id, ts, activity, detail, author,"
               " source) values ('KV-P1', %s, 'tưới', 'phát hiện sâu bệnh ở"
               " góc khoảnh', 'Người Ghi', 'test-p')",
               (NOW - timedelta(days=1),))


def test_pests_not_blocked_by_weather_source(db, monkeypatch, capsys):
    _seed_logs(db)
    monkeypatch.setattr(vt, "connect", lambda: TxConn(db))
    assert vt.load_config()["fetch"]["enabled"] is not True
    # thời tiết: nguồn dự báo chưa chọn → vẫn BLOCKED (exit 2)
    assert vt.main(["--digest", "--fetch", "--submit", "--date",
                    "2026-10-14"]) == 2
    # sâu bệnh: chỉ từ nhật ký nội bộ → mục farming/pest_alert
    assert vt.main(["--pests", "--submit", "--date", "2026-10-14"]) == 0
    q = db.execute("select block, object_type, object_id, payload from"
                   " approval_queue").fetchall()
    assert [r[:3] for r in q] == [("farming", "pest_alert",
                                   "vt-pest:2026-10-14")]
    assert "Người Ghi" not in q[0][3] and "KV-P1" in q[0][3]
    capsys.readouterr()
    assert vt.main(["--pests", "--submit", "--date", "2026-10-14"]) == 0
    assert "[skipped]" in capsys.readouterr().out
    assert db.execute("select count(*) from approval_queue").fetchone()[0] == 1


def test_pests_db_down_is_not_success(monkeypatch, capsys):
    monkeypatch.setattr(vt, "connect", lambda: None)
    assert vt.main(["--pests", "--submit"]) == 2
    assert "không đọc được nhật ký" in capsys.readouterr().out


def test_pests_usage_requires_mode():
    with pytest.raises(SystemExit) as e:
        vt.main(["--from-csv", "x.csv"])
    assert e.value.code == 2


def test_ad_result_is_own_output_and_legacy_skip(monkeypatch):
    calls, legacy = [], {"on": False}
    monkeypatch.setattr(mkt_ads, "get_plan", lambda c, p: {"id": p})
    monkeypatch.setattr(mkt_ads, "plan_status", lambda c, p: "da_duyet")
    monkeypatch.setattr(mkt_ads, "read_results",
                        lambda path, prow: ([{"x": 1}], [], "f" * 64))
    monkeypatch.setattr(mkt_ads, "evaluate",
                        lambda prow, rows: {"de_xuat": "tiep"})
    monkeypatch.setattr(mkt_ads, "render_result", lambda *a: "payload")
    monkeypatch.setattr(mkt_ads, "_item_exists",
                        lambda c, ot, oid: legacy["on"] and ot == "ad_campaign")
    monkeypatch.setattr(mkt_ads.director, "submit",
                        lambda conn, block, ot, oid, *a, **k:
                        calls.append((block, ot, oid)) or 7)

    class C:
        def commit(self):
            pass
    r = mkt_ads.submit_results(C(), 3, "kq.csv", by="Người Nhập",
                               dcfg={"marketing": {}})
    assert r["qid"] == 7 and calls == [("marketing", "ad_result",
                                        "adres-3-ffffffffffff")]
    assert rollout.feature_for(table="approval_queue", block="marketing",
                               object_type="ad_result",
                               created_by="Người Nhập") == "marketing-03.2"
    legacy["on"] = True              # kết quả cũ đã nộp dạng ad_campaign
    calls.clear()
    assert mkt_ads.submit_results(C(), 3, "kq.csv", by="Người Nhập",
                                  dcfg={"marketing": {}})["skipped"] is True
    assert calls == []


def _audit_data():
    return {"items": [], "snapshots": {}, "removed": [], "before": [],
            "price_alerts_open": 0,
            "checks": [{"channel": "shopee", "observed": "2026-10-14",
                        "row_id": 1, "item_id": "9000000001",
                        "price_why": "lệch giá list đã duyệt",
                        "desc_why": "file không có cột mô tả",
                        "price": ceo_audit.LECH, "desc": ceo_audit.NOCMP}]}


def test_ceo_audit_writes_separate_price_report(monkeypatch, tmp_path):
    class C:
        read_only = False

        def rollback(self):
            pass

        def close(self):
            pass
    monkeypatch.setattr(ceo_audit, "connect", lambda: C())
    monkeypatch.setattr(ceo_audit, "collect", lambda conn, cfg: _audit_data())
    monkeypatch.setattr(ceo_audit, "phap_che_config", dict)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")
    assert ceo_audit.main(["--report", "--now", "2026-10-14T08:00:00",
                           "--out-dir", str(tmp_path)]) == 0
    main = (tmp_path / "ceo-audit-2026-10-14.md").read_text(encoding="utf-8")
    price = (tmp_path / "ceo-gia-2026-10-14.md").read_text(encoding="utf-8")
    assert "xem ceo-gia-2026-10-14.md" in main and "### Giá" not in main
    assert "### Giá & mô tả listing" in price and "lech_ban_duyet 1" in price
    assert rollout.feature_for_report("ceo-gia-2026-10-14.md") == "ceo-04.4"
    assert rollout.feature_for_report("ceo-audit-2026-10-14.md") == "ceo-04.3"
    # trang TGĐ/bản tin (section) vẫn gộp như trước
    assert any("### Giá" in x for x in ceo_audit.render_section(_audit_data()))


def test_sx_tracuu_summary_vs_lookup_report_names():
    n = datetime.fromisoformat("2026-10-14T08:00:00+07:00")
    assert sx_tracuu.report_name("bảo quản?", n).startswith("sx-tracuu-")
    assert sx_tracuu.report_name("bảo quản?", n, "llm").startswith(
        "sx-tomtat-")
    assert sx_tracuu.report_name("bảo quản?", n, "no_data").startswith(
        "sx-tracuu-")
    assert rollout.feature_for_report("sx-tomtat-x.md") == "production-05.2"
    assert rollout.feature_for_report("sx-tracuu-x.md") == "production-05.1"


def test_social_label_counterfeit_and_ugc_class():
    rules, errs = ii.load_social_rules()
    assert not errs
    labs = ii.classify_social("Shop ơi đây có phải hàng giả không?", rules)
    assert "nghi_hang_gia" in labs
    assert "nghi_hang_gia" not in ii.classify_social("Giá bao nhiêu ạ?",
                                                     rules)
    # mention không có text (DPIA chưa ký) — nhãn đủ để xếp lớp
    assert mkt_ugc.classify(None, None, {}, labels=["nghi_hang_gia"]) == \
        "nghi_hang_gia"


def test_social_import_gated_by_feature(monkeypatch):
    assert rollout.feature_for(table="social_mentions") == "marketing-05.1"
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        rollout.check_generate(None, "marketing-05.1", "phân loại")


def test_feature_constants_point_to_new_ids():
    from agents import bks_audit, ceo_promo, combo_price
    from scripts import persona_sim
    ids = {f["id"] for f in _feats()}
    for v in (ceo_promo.FEATURE_PROMO, combo_price.FEATURE,
              persona_sim.FEATURE, mkt_ads.FEATURE,
              *bks_audit.KIND_FEATURE.values()):
        assert v in ids, v
    gate = json.loads((rollout.FEATURES_FILE.parent / "loader_gate.json")
                      .read_text(encoding="utf-8"))
    for ld in gate["loaders"].values():
        assert set(ld["features"]) <= ids


def test_old_ids_absent_from_code():
    import pathlib
    root = rollout.FEATURES_FILE.parent.parent
    gone = [g["id"] for g in json.loads(rollout.FEATURES_FILE.read_text(
        encoding="utf-8"))["da_thay_the"]]
    for d in ("agents", "pipelines", "scripts", "ingest", "connectors"):
        for p in pathlib.Path(root, d).rglob("*.py"):
            src = p.read_text(encoding="utf-8")
            for o in gone:
                assert f'"{o}"' not in src, (p.name, o)



# ------------------------------------- Cổng AI: trần/nút tắt theo tính năng

MSG = [{"role": "user", "content": "hi"}]


@pytest.fixture
def gwf(monkeypatch, tmp_path):
    """Gateway với config tạm + client giả (như tests/test_llm_gateway)."""
    cfg = {"provider_only": ["azure"],
           "prices_usd_per_1m": {"m": {"in": 1.0, "out": 2.0}},
           "monthly_cap_usd": {"default": 10.0}, "kill": []}
    p = tmp_path / "llm_gateway.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", p)
    monkeypatch.delenv("LLM_KILL_FEATURES", raising=False)
    c = FakeClient()
    monkeypatch.setattr(gw, "_client", lambda: c)
    c.cfg_path = p
    return c


def _spend(monkeypatch, by_agent=None, by_feature=None):
    def f(key, sql=gw._SPEND_SQL):
        src = by_feature if "feature_id" in sql else by_agent
        return (src or {}).get(key, 0.0)
    monkeypatch.setattr(gw, "_month_spend", f)


def _cfg(f, **over):
    import json as _j
    p = f.cfg_path
    d = _j.loads(p.read_text(encoding="utf-8"))
    d.update(over)
    p.write_text(_j.dumps(d), encoding="utf-8")


def test_feature_cap_blocks_only_that_feature(gwf, monkeypatch):
    # trước vá: cùng agent 'intel' (bản tin + báo cáo tuần) — không tách được
    _cfg(gwf, feature_caps_usd={"default": 5.0, "intel-01.1": 1.0})
    _spend(monkeypatch, by_feature={"intel-01.1": 1.0})
    with pytest.raises(gw.GatewayBlocked, match="intel-01.1"):
        gw.chat("intel", MSG, feature="intel-01.1")
    assert gwf.calls == []
    gw.chat("intel", MSG, model="m", feature="intel-03")   # cùng agent, mục khác
    assert len(gwf.calls) == 1


def test_feature_kill_switch_config_and_env(gwf, monkeypatch):
    _spend(monkeypatch)
    _cfg(gwf, kill_features=["sales-01"])
    with pytest.raises(gw.GatewayBlocked, match="nút tắt"):
        gw.chat("chatbot", MSG, feature="sales-01")
    _cfg(gwf, kill_features=[])
    monkeypatch.setenv("LLM_KILL_FEATURES", "marketing-01.1")
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("content", MSG, feature="marketing-01.1")
    gw.chat("content", MSG, model="m", feature="sales-03")
    assert len(gwf.calls) == 1


@pytest.mark.parametrize("bad", ["", "sales", "SALES-01", "sales-1", 3,
                                 "sales-01; drop"])
def test_feature_id_invalid(gwf, monkeypatch, bad):
    _spend(monkeypatch)
    with pytest.raises(gw.GatewayError):
        gw.chat("content", MSG, feature=bad)
    assert gwf.calls == []


def test_feature_cap_zero_and_spend_unreadable_fail_closed(gwf, monkeypatch):
    _cfg(gwf, feature_caps_usd={"default": 5.0, "ceo-01": 0})
    _spend(monkeypatch)
    with pytest.raises(gw.GatewayBlocked, match="trần 0"):
        gw.chat("cockpit", MSG, feature="ceo-01")

    def none_for_feature(key, sql=gw._SPEND_SQL):
        return None if "feature_id" in sql else 0.0
    monkeypatch.setattr(gw, "_month_spend", none_for_feature)
    with pytest.raises(gw.GatewayBlocked, match="fail-closed"):
        gw.chat("cockpit", MSG, feature="intel-03")
    assert gwf.calls == []


def test_usage_row_records_feature(gwf, monkeypatch):
    rows = []
    monkeypatch.setattr(gw, "_connect", lambda: FakeConn(spend=0.0, rows=rows))
    gw.chat("content", MSG, model="m", feature="sales-03")
    assert rows and rows[-1][-1] == "sales-03"


def test_every_gateway_call_in_repo_passes_feature():
    """AST: mọi lời gọi chat/embed của gateway (mọi tên import) có feature=."""
    import ast
    import pathlib
    root = rollout.FEATURES_FILE.parent.parent
    ids = {f["id"] for f in _feats()}
    missing = []
    for d in ("agents", "pipelines", "scripts", "ingest", "connectors",
              "api", "app", "crawler"):
        for p in pathlib.Path(root, d).rglob("*.py"):
            if p.name == "llm_gateway.py":
                continue
            tree = ast.parse(p.read_text(encoding="utf-8"))
            names = {a.asname or a.name for n in ast.walk(tree)
                     if isinstance(n, ast.ImportFrom)
                     and n.module == "pipelines.llm_gateway"
                     for a in n.names if a.name in ("chat", "embed")}
            for n in ast.walk(tree):
                if not isinstance(n, ast.Call):
                    continue
                f = n.func
                gwcall = (isinstance(f, ast.Attribute) and f.attr in (
                    "chat", "embed") and isinstance(f.value, ast.Name)
                    and f.value.id == "llm_gateway") or (
                    isinstance(f, ast.Name) and f.id in names)
                # api/rag gọi qua _timed(chat|embed, ...)
                timed = (isinstance(f, ast.Name) and f.id == "_timed"
                         and n.args and isinstance(n.args[0], ast.Name)
                         and n.args[0].id in names)
                if not (gwcall or timed):
                    continue
                kw = {k.arg: k.value for k in n.keywords}
                if "feature" not in kw:
                    missing.append(f"{p.name}:{n.lineno}")
                elif isinstance(kw["feature"], ast.Constant):
                    assert kw["feature"].value in ids, (p.name, n.lineno)
    assert missing == []


# ---------------- chatbot: câu hỏi sức khỏe chuyển người TRƯỚC dịch vụ AI


@pytest.mark.parametrize("q", [
    "Dạo này tôi hay mệt mỏi, uống sâm có được không?",
    "Tôi bị dị ứng phấn hoa thì dùng mật ong sâm có sao không?",
    "Đang uống paracetamol thì dùng sâm được không?",
    "Mẹ tôi uống aspirin hằng ngày, có dùng kèm sâm được không",
    "Đang dùng metformin thì uống sâm có ảnh hưởng gì không?",
    "Đang dùng kháng sinh có uống sâm được không",
    "met moi uong sam duoc khong", "di ung voi sam khong shop"])
def test_health_question_now_caught(q):
    # trước đợt hoàn thiện: cả 8 câu → False (tới OpenRouter)
    assert gw.is_health_question(q)


@pytest.mark.parametrize("q", [
    "Giá hộp sâm 12 củ bao nhiêu?", "Shop có giao hàng ra Hà Nội không?",
    "Mật ong sâm có hộp quà tặng Tết không?",
    "Sản phẩm này hạn sử dụng bao lâu?", "Mua 2 hộp có được giảm giá không?",
    "Sâm Ngọc Linh trồng ở đâu?", "Cách bảo quản sâm tươi trong tủ lạnh?"])
def test_sales_question_not_flagged(q):
    assert not gw.is_health_question(q)


def test_rag_health_question_zero_ai_call(monkeypatch):
    from api import rag
    calls = []
    monkeypatch.setattr(rag, "chat", lambda *a, **k: calls.append("chat"))
    monkeypatch.setattr(rag, "embed", lambda *a, **k: calls.append("embed"))
    r = rag.answer("Tôi bị dị ứng, uống sâm được không?")
    assert calls == [] and r.get("handoff")


# ---------------- hồ sơ gốc sản phẩm (production-02): kiểm, không bịa


GOLD = [{"sku_key": "sku-a", "receipt_no": "11/2024/ĐKSP"},
        {"sku_key": "sku-b", "receipt_no": None}]


def _dossier(**over):
    d = {"ma_ho_so": "HS-01", "ten": "SP A", "thanh_phan": ["sâm", "mật ong"],
         "quy_cach": "hộp 10 gói", "so_cong_bo": "11/2024/ĐKSP",
         "loai": "tpbvsk", "sku_keys": ["sku-a"], "xac_nhan_boi": "GĐ Sản Xuất",
         "can_cu": "Biên bản giao hồ sơ số ..."}
    d.update(over)
    return d


def _doc(items, rows=None, need=2):
    return {"so_ho_so_hop_dong": need, "danh_muc_ho_so_goc": items,
            "sku": rows if rows is not None else [
                {"sku_key": "sku-a", "ho_so_goc": "HS-01"},
                {"sku_key": "sku-b", "ho_so_goc": "HS-02"}]}


def test_dossier_real_registry_blocked_not_invented():
    doc = json.loads(pdo.DOSSIER_FILE.read_text(encoding="utf-8"))
    assert doc["danh_muc_ho_so_goc"] == []          # repo không bịa hồ sơ
    assert pdo.main(["--check"]) == 2               # chờ Bên B


def test_dossier_complete_ok():
    items = [_dossier(), _dossier(ma_ho_so="HS-02", ten="SP B",
                                  so_cong_bo="TCB 02", loai="food",
                                  sku_keys=["sku-b"])]
    r = pdo.check(_doc(items), GOLD)
    assert r["errors"] == [] and r["missing"] == [] and r["mapped"] == 2


@pytest.mark.parametrize("over,msg", [
    ({"thanh_phan": ""}, "thanh_phan"), ({"thanh_phan": []}, "thanh_phan"),
    ({"quy_cach": " "}, "quy_cach"), ({"loai": "x"}, "loai"),
    ({"xac_nhan_boi": "agent:sx"}, "NGƯỜI"),
    ({"so_cong_bo": "99/2020/ĐKSP"}, "lệch golden"),
    ({"sku_keys": ["sku-z"]}, "không có trong golden")])
def test_dossier_errors(over, msg):
    r = pdo.check(_doc([_dossier(**over)], need=1,
                       rows=[{"sku_key": "sku-a", "ho_so_goc": "HS-01"},
                             {"sku_key": "sku-b", "ho_so_goc": None}]), GOLD)
    assert any(msg in e for e in r["errors"]), r["errors"]


def test_dossier_incomplete_is_blocked_not_error():
    r = pdo.check(_doc([_dossier()], rows=[
        {"sku_key": "sku-a", "ho_so_goc": "HS-01"},
        {"sku_key": "sku-b", "ho_so_goc": None}]), GOLD)
    assert r["errors"] == [] and len(r["missing"]) == 2
