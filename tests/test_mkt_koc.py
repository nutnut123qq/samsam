"""v6.4 W64.4 — MKT-06 kit KOC/affiliate (`agents.mkt_koc`): kit từ nội dung
đã duyệt qua `check_publish(content_type="koc")`, hợp đồng phải đạt
`contract_check` v4.4, phát hành chỉ bản đã duyệt + hợp đồng không đổi.

KOC trong `data/koc_sample.json` là MẪU (không PII). Phần DB: schema tạm +
rollback (`tests.test_fp_pnl.fpa_conn`); hợp đồng chép sang thư mục tạm
(monkeypatch `ROOT`) để thử "sửa hợp đồng sau khi lập kit".
"""

import json
import shutil
from pathlib import Path

import pytest

from agents import mkt_koc as mk
from pipelines import approval_queue as aq
from pipelines import guardrail, store
from pipelines.pii import _mask_pii
from tests.test_fp_pnl import _TxConn, fpa_conn

ROOT = Path(__file__).resolve().parent.parent
HONEY = "mat-ong-sam-300ml"
ALCOHOL = ("ruou-sam-chai-thuy-tinh-500ml", "ruou-sam-binh-su-do-500ml")
CONTRACT = ROOT / "docs" / "legal" / "mau-hop-dong-koc-NHAP.md"
THIEU = ROOT / "tests" / "fixtures" / "mkt" / "hop-dong-koc-thieu-MAU.md"
HONEY_TEXT = ("Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao "
              "Nội dung có sử dụng AI")
SAPH = ("saphraton-20v", "saphraton-combo-2x20v", "saphraton-40v",
        "saphraton-80v")
SAPH_TEXT = ("Saphraton hỗ trợ giảm mệt mỏi. Thực phẩm này không phải là thuốc "
             "và không có tác dụng thay thế thuốc chữa bệnh. #quangcao")
GOLD = {HONEY: {"category": "food"}, "savigout-30v": {"category": "tpbvsk"},
        **{k: {"category": "tpbvsk"} for k in SAPH},
        **{k: {"category": "alcohol"} for k in ALCOHOL}}
RD = {(HONEY, "tiktok"): "TP_THUONG",
      **{(k, "tiktok"): "QC_DAY_DU" for k in SAPH},
      ("savigout-30v", "tiktok"): "MO_TA",
      **{(k, "tiktok"): "CAM" for k in ALCOHOL}}


def _koc(code="KOC-MAU-01"):
    return {k["code"]: k for k in mk.load_kocs()}[code]


def _d(i=5, text=HONEY_TEXT, sku=HONEY, **kw):
    return {"id": i, "status": "approved", "sku": sku, "content_type": "ads",
            "text": text, "is_ai": True, "verified": True,
            "guardrail": {"ok": True, "matched_claims": []}, **kw}


def _kit(drafts=None, sku=HONEY, koc=None, contract=None, rd=RD, **kw):
    text = CONTRACT.read_text(encoding="utf-8") if contract is None \
        else contract
    return mk.build_kit(koc or _koc(), sku, "tiktok",
                        [_d()] if drafts is None else drafts, GOLD,
                        readiness=rd, contract_text=text, **kw)


# ---------- danh sách KOC MẪU ----------

def test_koc_sample_no_pii():
    raw = (ROOT / "data" / "koc_sample.json").read_text(encoding="utf-8")
    assert _mask_pii(raw) == raw
    doc = json.loads(raw)
    assert "MẪU" in doc["_doc"] and "không phải KOC thật" in doc["_doc"]
    for k in doc["kocs"]:
        assert not set(k) & {"phone", "email", "name", "handle", "sdt"}
        assert k["contract_status"] == "NHAP_MAU"
    kocs = mk.load_kocs()
    assert [k["code"] for k in kocs] == ["KOC-MAU-01", "KOC-MAU-02",
                                         "KOC-MAU-03"]
    assert any(k["contract_file"] == "tests/fixtures/mkt/hop-dong-koc-thieu-"
               "MAU.md" for k in kocs)


@pytest.mark.parametrize("doc", [
    None, "{", {}, {"_doc": "x"}, {"_doc": "x", "kocs": []},
    {"_doc": "x", "kocs": [], "la": 1},
    {"_doc": "x", "kocs": [{"code": "KOC-01"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-1", "platform": "tiktok",
                            "niche": "a", "contract_file": "a.md",
                            "contract_status": "NHAP_MAU"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "youtube",
                            "niche": "a", "contract_file": "a.md",
                            "contract_status": "NHAP_MAU"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "tiktok",
                            "niche": "a", "contract_file": "../a.md",
                            "contract_status": "NHAP_MAU"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "tiktok",
                            "niche": "a", "contract_file": "C:/a.md",
                            "contract_status": "NHAP_MAU"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "tiktok",
                            "niche": "a", "contract_file": "a.md",
                            "contract_status": "DA_KY"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "tiktok",
                            "niche": "a", "contract_file": "a.md",
                            "contract_status": "NHAP_MAU", "phone": "1"}]},
    {"_doc": "x", "kocs": [{"code": "KOC-MAU-01", "platform": "tiktok",
                            "niche": "a", "contract_file": "a.md",
                            "contract_status": "NHAP_MAU"}] * 2}])
def test_load_kocs_fail_closed(tmp_path, doc):
    p = tmp_path / "k.json"
    if doc is not None:
        p.write_text(doc if isinstance(doc, str) else json.dumps(doc),
                     encoding="utf-8")
    with pytest.raises(mk.KocConfigError):
        mk.load_kocs(p)


def test_load_contract_guards():
    text, sha, err = mk.load_contract("docs/legal/mau-hop-dong-koc-NHAP.md")
    assert err is None and len(sha) == 64 and text
    for rel in ("../ngoai.md", "khong/co/file.md", "data/koc_sample.json"):
        text, sha, err = mk.load_contract(rel)
        assert text is None and err, rel


# ---------- build_kit thuần ----------

def test_kit_food_pass_has_labels_placeholder():
    res = _kit()
    assert res["code"] is None, res
    kit = res["kit"]
    assert HONEY_TEXT in kit                      # brief nguyên văn
    assert "#quangcao" in kit and "Nội dung có sử dụng AI" in kit
    assert "{{LINK_AFFILIATE}}" in kit and "chưa phải link thật" in kit
    assert f"AFF-KOC-MAU-01-{HONEY}-PLACEHOLDER" in kit
    assert res["contract_sha"] in kit
    canonical = guardrail._load_rules(guardrail.DATA_DIR)[0]["canonical"]
    assert canonical not in kit                   # thực phẩm thường
    g = guardrail.check_publish(kit, channel="tiktok", content_type="koc",
                                sku=HONEY, is_ai=True, is_sponsored=True,
                                readiness=RD)
    assert g["ok"] is True and guardrail.check(kit)["ok"] is True
    assert res["sha12"] == _kit()["sha12"]        # tất định


def test_kit_tpbvsk_has_disclaimer_and_claims():
    d = _d(text=SAPH_TEXT, sku="saphraton-20v", is_ai=False,
           guardrail={"ok": True, "matched_claims": [
               {"sku": "saphraton-20v", "claim": "hỗ trợ giảm mệt mỏi"}]})
    res = _kit([d], sku="saphraton-20v")
    assert res["code"] is None, res
    kit = res["kit"]
    canonical = guardrail._load_rules(guardrail.DATA_DIR)[0]["canonical"]
    assert canonical in kit and "- hỗ trợ giảm mệt mỏi" in kit
    assert "Nội dung có sử dụng AI" not in kit    # draft không AI


@pytest.mark.parametrize("sku", ALCOHOL)
def test_kit_offline_only(sku):
    rd = {**RD, (sku, "tiktok"): "TP_THUONG"}
    res = _kit([_d(sku=sku)], sku=sku, rd=rd)
    assert res["code"] == "KIT_OFFLINE_ONLY" and sku not in res["reason"]


def test_kit_listing_cam_creative_contract_guardrail():
    assert _kit([_d(sku="savigout-30v")], sku="savigout-30v")["code"] == \
        "KIT_LISTING_ONLY"
    # readiness None → soi golden file: savigout shopee MO_TA
    assert mk.build_kit(_koc(), "savigout-30v", "shopee",
                        [_d(sku="savigout-30v")], GOLD, readiness=None,
                        contract_text="x")["code"] == "KIT_LISTING_ONLY"
    # golden file: mật ong chưa tự công bố → CAM
    assert mk.build_kit(_koc(), HONEY, "tiktok", [_d()], GOLD,
                        readiness=None, contract_text="x")["code"] == "KIT_CAM"
    assert _kit(sku="khong-co", drafts=[_d(sku="khong-co")])["code"] == \
        "KIT_CAM"
    for d in ([], [_d(status="pending")], [_d(status="rejected")],
              [_d(sku="savigout-30v")], [_d(verified=False)],
              [_d(content_type="listing")], [_d(), _d(6, status="pending")],
              [{"id": 7, "status": "khong_ton_tai"}]):
        assert _kit(d)["code"] == "KIT_CREATIVE_UNAPPROVED", d
    res = _kit(contract=THIEU.read_text(encoding="utf-8"))
    assert res["code"] == "KIT_CONTRACT"
    assert all(c in res["reason"] for c in ("go_24h", "cam_ruou",
                                            "nghia_vu_nguoi_chuyen_tai"))
    res = mk.build_kit(_koc(), HONEY, "tiktok", [_d()], GOLD, readiness=RD,
                       contract_text=None, contract_err="file thiếu")
    assert res["code"] == "KIT_CONTRACT" and "file thiếu" in res["reason"]
    res = _kit([_d(text="Mật ong sâm chữa mất ngủ. #quangcao Nội dung có sử "
                   "dụng AI")])
    assert res["code"] == "KIT_GUARDRAIL"


# ---------- CLI không DB ----------

@pytest.mark.parametrize("argv", [
    [], ["--list", "--kit"], ["--kit", "--koc", "KOC-MAU-01"],
    ["--kit", "--koc", "KOC-MAU-99", "--sku", HONEY, "--draft-ids", "1",
     "--by", "a"],
    ["--kit", "--koc", "KOC-MAU-01", "--sku", HONEY, "--draft-ids", "1,x",
     "--by", "a"],
    ["--kit", "--koc", "KOC-MAU-01", "--sku", HONEY, "--draft-ids", "1",
     "--channel", "facebook", "--by", "a"],
    ["--release", "1"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(mk, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        mk.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_list_no_db(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(mk, "connect", lambda: calls.append(1))
    assert mk.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert "KOC-MAU-03" in out and "THIẾU go_24h" in out and calls == []


# ---------- DB thật ----------

@pytest.fixture
def db(monkeypatch):
    monkeypatch.delenv("GUARDRAIL_LLM_MODEL", raising=False)
    yield from fpa_conn()


def _draft(db, text=HONEY_TEXT, approve=True):
    g = guardrail.check_publish(text, channel="tiktok", content_type="ads",
                                sku=HONEY, is_ai=True)
    did = store.save_draft(_TxConn(db), "brief MẪU", "tiktok", text, g,
                           created_by="mkt lap", content_type="ads",
                           sku=HONEY, is_ai=True)
    if approve:
        db.execute("select approve_draft(%s, 'duyet mkt', null)", (did,))
    return did


def _q(db):
    return db.execute("select id, object_type, object_id, risk, status,"
                      " payload from approval_queue order by id").fetchall()


def test_db_kit_submit_release(db, monkeypatch, tmp_path, capsys):
    root = tmp_path / "repo"
    (root / "docs" / "legal").mkdir(parents=True)
    (root / "tests" / "fixtures" / "mkt").mkdir(parents=True)
    shutil.copy(CONTRACT, root / "docs" / "legal" / CONTRACT.name)
    shutil.copy(THIEU, root / "tests" / "fixtures" / "mkt" / THIEU.name)
    monkeypatch.setattr(mk, "ROOT", root)
    monkeypatch.setattr(mk, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(mk, "connect", lambda: _TxConn(db))
    db.execute("update sku_master set self_declaration_ok = true,"
               " allowed_channels = '{shopee,tiktok}' where sku_key = %s",
               (HONEY,))
    d_ok, d_pend = _draft(db), _draft(db, approve=False)
    kit = ["--kit", "--koc", "KOC-MAU-01", "--sku", HONEY, "--by", "mkt lap"]
    assert mk.main(kit + ["--draft-ids", str(d_pend)]) == 1
    assert "KIT_CREATIVE_UNAPPROVED" in capsys.readouterr().out
    assert mk.main(["--kit", "--koc", "KOC-MAU-03", "--sku", HONEY, "--by",
                    "mkt lap", "--draft-ids", str(d_ok)]) == 1
    out = capsys.readouterr().out
    assert "KIT_CONTRACT" in out and "go_24h" in out and _q(db) == []
    assert mk.main(kit + ["--draft-ids", str(d_ok), "--dry-run"]) == 0
    assert _q(db) == []
    assert mk.main(kit + ["--draft-ids", str(d_ok)]) == 0
    capsys.readouterr()
    [(qid, ot, oid, risk, st, payload)] = _q(db)
    assert (ot, risk, st) == ("koc_brief", "medium", "pending")
    assert oid.startswith("koc-KOC-MAU-01-")
    assert "#quangcao" in payload and "AFF-KOC-MAU-01-" in payload
    assert "contract_sha256" in payload
    assert mk.main(kit + ["--draft-ids", str(d_ok)]) == 0   # chạy lại
    assert "[skip]" in capsys.readouterr().out and len(_q(db)) == 1
    tx = _TxConn(db)
    rel = ["--release", str(qid), "--by", "nguoi phat hanh"]
    assert mk.main(rel) == 1                                # chưa duyệt
    assert "KIT_NOT_APPROVED" in capsys.readouterr().out
    assert aq.decide(tx, qid, "mkt lap", "approved")[0] is False   # tự duyệt
    assert aq.decide(tx, qid, "GD Marketing", "approved") == (True, None)
    # sửa hợp đồng sau khi lập kit → chặn
    cp = root / "docs" / "legal" / CONTRACT.name
    orig = cp.read_bytes()
    cp.write_bytes(orig + "\n\nPhụ lục 3. Bổ sung MẪU.\n".encode())
    assert mk.main(rel) == 1
    assert "KIT_CONTRACT_CHANGED" in capsys.readouterr().out
    assert not (tmp_path / "reports").exists()
    cp.write_bytes(orig)
    assert mk.main(rel) == 0
    out = capsys.readouterr().out
    f = tmp_path / "reports" / f"koc-kit-KOC-MAU-01-{qid}.md"
    assert f.read_bytes().decode("utf-8") == payload and "gửi TAY" in out
    # mục không phải kit → KIT_NOT_APPROVED
    assert mk.release(tx, 99_999_999)["code"] == "KIT_NOT_APPROVED"
