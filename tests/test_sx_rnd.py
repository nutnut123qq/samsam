"""v11.0 W110.1 — SX-A6 concept brief R&D (`agents.sx_rnd`).

Thuần: 5 mục + tín hiệu có URL/ngày + cổng 0 công dụng; LLM monkeypatch
(không gọi mạng). DB THẬT trong schema tạm (schema.sql + roles.sql) →
ROLLBACK cuối test (`tests.test_da_schema.da_db`).
"""

import copy
import datetime as dt
import json
import re
import unicodedata
from pathlib import Path
from types import SimpleNamespace

import pytest

from agents import sx_rnd as rnd
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import approval_queue as aq
from pipelines import guardrail, llm_gateway
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "sx_rnd.py").read_text(encoding="utf-8")
GOLDEN, _ = read_golden(GOLDEN_FILE)
CONCEPTS = rnd.load_concepts(golden=GOLDEN)
RAW = json.loads((ROOT / "data" / "rd_concepts.json").read_bytes())
NOW = dt.datetime(2026, 10, 14, 12, tzinfo=rnd.TZ_VN)
URL = "https://mau.example.vn/tra-sam-khong-duong-gioi-tre"
SIG = [{"url": URL, "date": "2026-10-01", "topics": ["gioi_tre"]}]
TEA = next(c for c in CONCEPTS if c["id"] == "stick-tra-sam-khong-duong")
SECTIONS = ("## Hương vị", "## Nguồn gốc", "## Nghi thức dùng",
            "## Quy cách", "## Giá dự kiến (khoảng)", "## Tín hiệu (nguồn)")


@pytest.fixture
def db():
    yield from da_db()


def _resp(content, model="openai/gpt-4o-mini"):
    return SimpleNamespace(model=model, choices=[SimpleNamespace(
        message=SimpleNamespace(content=content))])


# ---------------------------------------------------------------- thuần


def test_brief_five_sections_url_date_and_claim_free():
    r = rnd.make_brief(TEA, SIG, now=NOW)
    t = r["text"]
    assert r["problems"] == [] and not r["llm_used"]
    for s in SECTIONS:
        assert t.count(s) == 1
    assert f"- 2026-10-01 · {URL}" in t
    assert "120.000–180.000 đ" in t
    assert rnd.INTERNAL_LABEL in t
    assert "seed=0" in t and "ngày=2026-10-14" in t
    assert rnd.claim_free(t) == []


@pytest.mark.parametrize("cid", [c["id"] for c in CONCEPTS])
def test_every_real_concept_passes_gate(cid):
    c = next(x for x in CONCEPTS if x["id"] == cid)
    r = rnd.make_brief(c, SIG, now=NOW)
    assert r["problems"] == [] and rnd.claim_free(r["text"]) == []


def test_real_file_has_three_concepts():
    ids = {c["id"] for c in CONCEPTS}
    assert len(CONCEPTS) >= 3
    assert {"stick-tra-sam-khong-duong", "mat-ong-sam-goi-nho",
            "mini-gift-set-duoi-300k"} <= ids
    assert "GIẢ ĐỊNH" in RAW["_doc"]


@pytest.mark.parametrize("phrase", ["giúp ngủ ngon", "tăng cường sức khỏe",
                                    "hỗ trợ tiêu hóa", "chữa"])
def test_claim_phrases_blocked(phrase):
    t = rnd.make_brief(TEA, SIG, now=NOW)["text"]
    assert rnd.claim_free(t + f"\nTrà sâm {phrase} cho người dùng.\n")


@pytest.mark.parametrize("verb", guardrail.CLAIM_VERBS)
def test_each_claim_verb_blocked(verb):
    t = rnd.make_brief(TEA, SIG, now=NOW)["text"]
    errs = rnd.claim_free(t + f"\nSản phẩm {verb} người dùng.\n")
    assert f"claim_verb:{verb}" in errs


@pytest.mark.parametrize("field", ["flavor", "ritual", "origin"])
def test_claim_in_concept_text_no_file_no_submit(field, db, monkeypatch,
                                                 tmp_path):
    bad = copy.deepcopy(RAW)
    bad["concepts"][0][field] += ", giúp ngủ ngon"
    p = tmp_path / "c.json"
    p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(rnd, "CONCEPTS_FILE", p)
    _use(db, monkeypatch, tmp_path)
    _intel(db, URL, ["gioi_tre"])
    assert rnd.main(["--brief", bad["concepts"][0]["id"], "--submit"],
                    now=NOW) == 1
    assert not (tmp_path / "reports").exists() or not list(
        (tmp_path / "reports").iterdir())
    assert _queue(db) == []


def test_llm_claim_output_falls_back_to_template(monkeypatch):
    calls = []

    def fake(agent_id, msgs, **kw):
        calls.append((agent_id, kw))
        return _resp("Hương vị: trà sâm giúp tỉnh táo\n"
                     "Nghi thức dùng: pha nước ấm")
    monkeypatch.setattr(rnd.llm_gateway, "chat", fake)
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    assert calls and calls[0][0] == "sx_rnd" and calls[0][1]["seed"] == 0
    assert not r["llm_used"] and r["llm_reason"].startswith("khong_qua_cong")
    assert r["problems"] == []
    assert "tỉnh táo" not in r["text"] and TEA["flavor"] in r["text"]
    assert "về template" in r["text"] and rnd.claim_free(r["text"]) == []
    assert rnd.AI_LABEL not in r["text"]


HEALTH_PHRASES = ["Tăng sức đề kháng.", "An thần, dễ ngủ.",
                  "Uống buổi tối để ngủ sâu hơn.", "đẩy lùi lão hóa",
                  "Hồi phục sinh lực nhanh.", "Làm đẹp da."]


NFD_PHRASES = [unicodedata.normalize("NFD", p) for p in HEALTH_PHRASES]


@pytest.mark.parametrize("phrase", HEALTH_PHRASES + NFD_PHRASES)
def test_health_phrases_caught_by_health_terms(phrase):
    """Các cụm này QUA `claim_free` (lỗ hổng list từ cấm dùng chung —
    someday) — đường LLM dựa vào `health_terms`."""
    assert rnd.health_terms(phrase) != []


@pytest.mark.parametrize("field", ["flavor", "ritual"])
@pytest.mark.parametrize("phrase", HEALTH_PHRASES + NFD_PHRASES)
def test_llm_health_effect_output_falls_back(monkeypatch, phrase, field):
    """Finding v11.0 MINOR: LLM viết công dụng không chứa từ cấm/động từ
    claim -> trước vá được nhận vào brief. Re-audit MINOR: bản NFD (tiếng
    Việt tổ hợp) từng lọt `health_terms` (thiếu NFC cả chuỗi)."""
    flav = phrase if field == "flavor" else "hậu ngọt nhẹ, thơm thảo mộc"
    rit = phrase if field == "ritual" else "pha với nước ấm"
    monkeypatch.setattr(rnd.llm_gateway, "chat", lambda *a, **k: _resp(
        f"Hương vị: {flav}\nNghi thức dùng: {rit}"))
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    assert not r["llm_used"] and r["problems"] == []
    assert "health" in r["llm_reason"]
    assert phrase not in r["text"] and TEA["flavor"] in r["text"]
    assert unicodedata.normalize("NFC", phrase) not in r["text"]
    assert rnd.AI_LABEL not in r["text"]


def test_llm_nfd_output_stored_nfc(monkeypatch):
    """Bản LLM hợp lệ dạng NFD -> brief lưu NFC."""
    flav = unicodedata.normalize("NFD", "hậu ngọt nhẹ, thơm thảo mộc")
    monkeypatch.setattr(rnd.llm_gateway, "chat", lambda *a, **k: _resp(
        f"Hương vị: {flav}\nNghi thức dùng: pha với nước ấm"))
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    assert r["llm_used"], r["llm_reason"]
    assert "hậu ngọt nhẹ, thơm thảo mộc" in r["text"]
    assert unicodedata.is_normalized("NFC", r["text"])


def test_health_terms_allowed_when_already_in_concept():
    assert rnd.health_terms("dễ ngủ", allowed="trước giờ ngủ") == []
    assert rnd.health_terms("dễ ngủ") == ["ngủ"]
    assert rnd.health_terms(unicodedata.normalize("NFD", "dễ ngủ"),
                            allowed=unicodedata.normalize(
                                "NFD", "trước giờ ngủ")) == []
    assert rnd.health_terms("hậu ngọt nhẹ, gần vùng trồng") == []
    for c in CONCEPTS:                         # concept thật không dính
        assert rnd.health_terms(f"{c['flavor']} {c['ritual']}") == []


def test_backdate_generated_separate_from_signal_date():
    """Finding v11.0 MINOR: --date chỉ là mốc tín hiệu; ngày lập/Sinh bởi =
    ngày THẬT lập."""
    old = dt.datetime(2026, 1, 1, 23, 59, tzinfo=rnd.TZ_VN)
    sig = [{**SIG[0], "date": "2025-12-20"}]
    t = rnd.make_brief(TEA, sig, now=old,
                       generated=dt.date(2026, 10, 14))["text"]
    assert "ngày lập: 2026-10-14 · tín hiệu tới: 2026-01-01" in t
    assert "seed=0 (không lấy mẫu) · ngày=2026-10-14" in t
    assert "ngày=2026-01-01" not in t


def test_cli_backdate_generated_injected(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(rnd, "load_signals", lambda *a, **k: SIG)
    monkeypatch.setattr(rnd, "connect", lambda: _NoDb())
    monkeypatch.setattr(rnd, "REPORTS_DIR", tmp_path)
    assert rnd.main(["--brief", TEA["id"], "--date", "2026-01-01"],
                    generated=dt.date(2026, 10, 14)) == 0
    out = capsys.readouterr().out
    assert "ngày lập: 2026-10-14 · tín hiệu tới: 2026-01-01" in out
    assert (tmp_path / f"rd-brief-{TEA['id']}-2026-01-01.md").exists()


class _NoDb:
    def commit(self):
        pass

    def close(self):
        pass


@pytest.mark.parametrize("out", [None, "", "chỉ một dòng không nhãn"])
def test_llm_empty_or_malformed_falls_back(monkeypatch, out):
    monkeypatch.setattr(rnd.llm_gateway, "chat", lambda *a, **k: _resp(out))
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    assert not r["llm_used"] and r["llm_reason"] and r["problems"] == []


def test_llm_gateway_error_falls_back(monkeypatch):
    def boom(*a, **k):
        raise llm_gateway.GatewayBlocked("cap")
    monkeypatch.setattr(rnd.llm_gateway, "chat", boom)
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    assert r["llm_reason"] == "gateway:GatewayBlocked" and r["problems"] == []


def test_llm_ok_records_model_prompt_sha_seed_date(monkeypatch):
    monkeypatch.setattr(rnd.llm_gateway, "chat", lambda *a, **k: _resp(
        "Hương vị: hậu ngọt nhẹ, thơm mùi thảo mộc\n"
        "Nghi thức dùng: pha với nước ấm vào buổi sáng"))
    r = rnd.make_brief(TEA, SIG, now=NOW, llm=True)
    t = r["text"]
    assert r["llm_used"] and r["problems"] == []
    m = re.search(r"Sinh bởi: model=openai/gpt-4o-mini · prompt_sha256="
                  r"([0-9a-f]{12}) · seed=0 · ngày=2026-10-14", t)
    assert m
    assert rnd.AI_LABEL in t and "hậu ngọt nhẹ, thơm mùi thảo mộc" in t
    assert rnd.claim_free(t, is_ai=True) == []


def test_alcohol_base_sku_rejected():
    bad = copy.deepcopy(RAW)
    bad["concepts"][0]["base_skus"] = ["ruou-sam-chai-thuy-tinh-500ml"]
    with pytest.raises(rnd.RndConfigError, match="rượu"):
        rnd.validate_concepts(bad, GOLDEN)


@pytest.mark.parametrize("mut", [
    lambda c: c.pop("flavor"),
    lambda c: c.update(extra=1),
    lambda c: c.update(id="Sai ID"),
    lambda c: c.update(price_vnd={"low": 300, "high": 200}),
    lambda c: c.update(price_vnd={"low": 0, "high": 200}),
    lambda c: c.update(price_vnd={"low": 1.5, "high": 200}),
    lambda c: c.update(base_skus=["khong-co-sku"]),
    lambda c: c.update(base_skus=[]),
    lambda c: c.update(signal_topics=["la"]),
    lambda c: c.update(name="Trà sâm pha rượu nếp"),
])
def test_config_fail_closed(mut):
    bad = copy.deepcopy(RAW)
    mut(bad["concepts"][0])
    with pytest.raises(rnd.RndConfigError):
        rnd.validate_concepts(bad, GOLDEN)


def test_config_duplicate_id_and_empty(tmp_path):
    bad = copy.deepcopy(RAW)
    bad["concepts"][1]["id"] = bad["concepts"][0]["id"]
    with pytest.raises(rnd.RndConfigError, match="trùng"):
        rnd.validate_concepts(bad, GOLDEN)
    for content in ("", "{}", '{"_doc": "x"}', "{hỏng"):
        p = tmp_path / "c.json"
        p.write_text(content, encoding="utf-8")
        with pytest.raises(rnd.RndConfigError):
            rnd.load_concepts(p, GOLDEN)
    with pytest.raises(rnd.RndConfigError):
        rnd.load_concepts(tmp_path / "missing.json", GOLDEN)


def test_no_signal_is_problem_no_brief():
    r = rnd.make_brief(TEA, [], now=NOW)
    assert r["problems"] == [rnd.NO_SIGNAL] and r["text"] == ""
    bad = [{"url": "javascript:alert(1)", "date": "2026-10-01", "topics": []},
           {"url": "https://x.vn/a b", "date": "2026-10-01", "topics": []}]
    assert rnd.make_brief(TEA, bad, now=NOW)["problems"] == [rnd.NO_SIGNAL]


def test_signal_url_with_banned_word_dropped():
    sig = SIG + [{"url": "https://x.vn/thuoc-chua-benh", "date": "2026-10-02",
                  "topics": ["sam"]}]
    r = rnd.make_brief(TEA, sig, now=NOW)
    assert r["problems"] == [] and "thuoc-chua-benh" not in r["text"]
    assert "đã loại 1 tín hiệu" in r["text"]


def test_module_no_http_no_draft_path():
    assert not re.search(r"import httpx|import requests|\.post\(|smtp|"
                         r"content_drafts|save_draft", SRC)


# ---------------------------------------------------------------- DB


def _use(db, monkeypatch, tmp_path):
    monkeypatch.setattr(rnd, "connect", lambda: TxConn(db))
    monkeypatch.setattr(rnd, "REPORTS_DIR", tmp_path / "reports")


def _queue(db):
    return db.execute("select block, object_type, status, created_by, risk,"
                      " payload from approval_queue order by id").fetchall()


def _intel(db, url, topics, flags=(), days_ago=5, title="Tin MẪU"):
    db.execute(
        "insert into intel_items (url, domain, source, tier, title,"
        " content_sha256, topics, flags, published_at) values (%s,"
        " 'mau.example.vn', 'fx', 'A', %s, encode(sha256(convert_to(%s,"
        " 'UTF8')), 'hex'), %s, %s, %s)",
        (url, title, url, list(topics), list(flags),
         NOW - dt.timedelta(days=days_ago)))


def test_db_submit_pending_excludes_alcohol_signal_then_skipped(
        db, monkeypatch, tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    bad_url = "https://mau.example.vn/san-pham-moi-mua-tet"
    _intel(db, URL, ["gioi_tre"])
    _intel(db, bad_url, ["gioi_tre"], flags=["ruou"])
    _intel(db, "https://mau.example.vn/cu", ["gioi_tre"], days_ago=200)
    assert rnd.main(["--brief", TEA["id"], "--submit"], now=NOW) == 0
    q = _queue(db)
    assert len(q) == 1
    assert q[0][:5] == ("production", "rd_concept_brief", "pending",
                        "agent:SX-A6", "high")
    assert URL in q[0][5] and bad_url not in q[0][5]
    assert "mau.example.vn/cu" not in q[0][5]          # ngoài 90 ngày
    assert (tmp_path / "reports" /
            f"rd-brief-{TEA['id']}-2026-10-14.md").exists()
    assert rnd.main(["--brief", TEA["id"], "--submit"], now=NOW) == 0
    assert "skipped" in capsys.readouterr().out
    assert len(_queue(db)) == 1
    gok, qid = db.execute("select (guardrail->>'ok')::boolean, id from approval_queue"
                          ).fetchone()
    assert gok is True
    ok, msg = aq.decide(TxConn(db), qid, "nguoi_duyet_gia_lap", "approved")
    assert ok, msg


def test_db_no_signal_exit1_no_queue(db, monkeypatch, tmp_path):
    _use(db, monkeypatch, tmp_path)
    _intel(db, "https://mau.example.vn/r", ["gioi_tre"],
           title="Rượu sâm mới")      # nhắc rượu → loại
    assert rnd.main(["--brief", TEA["id"], "--submit"], now=NOW) == 1
    assert _queue(db) == []


@pytest.mark.parametrize("argv", [
    ["--list", "--brief", "x"], [], ["--list", "--submit"],
    ["--list", "--llm"], ["--brief", "x", "--date", "14/10/2026"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(rnd, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        rnd.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_list_no_db(monkeypatch, capsys):
    monkeypatch.setattr(rnd, "connect", lambda: pytest.fail("không cần DB"))
    assert rnd.main(["--list"]) == 0
    assert "stick-tra-sam-khong-duong" in capsys.readouterr().out


def test_cli_unknown_concept_and_bad_config_exit1_before_connect(
        monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(rnd, "connect", lambda: calls.append(1))
    assert rnd.main(["--brief", "khong-co"]) == 1
    p = tmp_path / "c.json"
    bad = copy.deepcopy(RAW)
    bad["concepts"][0]["base_skus"] = ["ruou-sam-binh-su-do-500ml"]
    p.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(rnd, "CONCEPTS_FILE", p)
    assert rnd.main(["--brief", TEA["id"]]) == 1
    assert calls == []


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(rnd, "connect", lambda: None)
    assert rnd.main(["--brief", TEA["id"]], now=NOW) == 2
