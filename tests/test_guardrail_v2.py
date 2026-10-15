"""v4.1-guardrail-v2 (WP05/PC-A3) — `check()` chuẩn hóa NFC/casefold/ký tự
chèn/rượu + field mới; `check_publish()` luật đăng bài; file luật
`data/guardrail_rules.json`; readiness soi gương view `sku_readiness`.

Test cũ `tests/test_guardrail.py` KHÔNG sửa (bằng chứng caller cũ xanh).
Ký tự vô hình viết escape (AGENTS.md gotcha). Không wall-clock.
"""

import copy
import inspect
import json
import os
import re
import shutil
import unicodedata
import uuid
from pathlib import Path

import psycopg
import pytest

import pipelines.guardrail as g
from pipelines import kb_filter

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CANON = ("Thực phẩm này không phải là thuốc và không có tác dụng thay thế "
         "thuốc chữa bệnh")
AI = " Nội dung có sử dụng AI."
SHAPE = {"type", "detail", "span", "code", "severity", "start", "end"}
CHANNELS = ("shopee", "tiktok", "web", "facebook", "zalo", "chatbot")


def _codes(r, key="violations"):
    return [v["code"] for v in r[key]]


def _rules() -> dict:
    return json.loads((DATA / "guardrail_rules.json").read_text(
        encoding="utf-8"))


def _golden() -> dict:
    return json.loads((DATA / "golden_skus.json").read_text(encoding="utf-8"))


@pytest.fixture
def tmp_data(tmp_path, monkeypatch):
    """Bản copy data guardrail trong tmp — trả hàm ghi đè rules."""
    for f in ("banned_words.txt", "claims_whitelist.json", "golden_skus.json",
              "guardrail_rules.json"):
        shutil.copy(DATA / f, tmp_path)
    monkeypatch.setattr(g, "DATA_DIR", tmp_path)
    g._load_config.cache_clear()
    g._load_rules.cache_clear()

    def write_rules(mut):
        doc = _rules()
        mut(doc)
        (tmp_path / "guardrail_rules.json").write_text(
            json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        g._load_rules.cache_clear()
    yield tmp_path, write_rules
    g._load_config.cache_clear()
    g._load_rules.cache_clear()


# ---------- W41.1 check(): signature, chuẩn hóa, ký tự chèn, rượu ----------

def test_check_signature_unchanged():
    params = inspect.signature(g.check).parameters
    assert list(params) == ["text"]
    sig = inspect.signature(g.check_publish)
    assert list(sig.parameters) == ["text", "channel", "content_type", "sku",
                                    "is_ai", "is_sponsored", "readiness"]
    assert sig.parameters["is_ai"].default is True
    assert sig.parameters["content_type"].default == "post"


def test_nfd_banned_word_blocked_and_nfd_disclaimer_pass():
    r = g.check(unicodedata.normalize("NFD", "Sản phẩm chữa khỏi tiểu đường"))
    assert r["ok"] is False and "tu_cam" in _codes(r)
    r = g.check(unicodedata.normalize("NFD", CANON + "."))
    assert r["ok"] is True, r["violations"]


@pytest.mark.parametrize("text", [
    "SẢN PHẨM ĐIỀU TRỊ", "ThUốC", "th.uốc", "c-h-ữ-a", "đi\u200bều trị",
    "thu\u00adốc", "th_u*ốc", "chu\u200da khoi benh"])
def test_case_and_filler_evasion_blocked(text):
    r = g.check(text)
    assert r["ok"] is False and "tu_cam" in _codes(r), r


@pytest.mark.parametrize("text", [
    "samsamngoclinh.com", "Tp.HCM", "thuộc", "No.5", "th.uộc",
    "Sản phẩm thuộc dòng thực phẩm bảo vệ sức khỏe"])
def test_filler_pass_no_false_positive(text):
    assert "tu_cam" not in _codes(g.check(text))


def test_filler_hit_inside_disclaimer_span_still_exempt_only_by_span():
    """Hit chèn ký tự ngoài câu khuyến cáo vẫn bị bắt dù có câu chuẩn."""
    r = g.check(CANON + ". Nhưng nó tốt hơn th.uốc.")
    spans = [v["span"] for v in r["violations"] if v["code"] == "tu_cam"]
    assert spans == ["th.uốc"]


def test_fold_preserves_length_and_spans_index_nfc_text():
    s = "İßﬁ Sản Phẩm ĐIỀU TRỊ"
    assert len(g._fold(s)) == len(s)
    texts = [s, unicodedata.normalize("NFD", "Saphraton chữa ung thư"),
             "İİİ thuốc ß chữa", "Savina giúp làm đẹp da. th.uốc",
             "Quà biếu: RƯỢU sâm"]
    for t in texts:
        nfc = unicodedata.normalize("NFC", t)
        r = g.check(t)
        assert r["violations"]
        for v in r["violations"]:
            if v["start"] is not None:
                assert nfc[v["start"]:v["end"]] == v["span"], v


def _alcohol_terms() -> list[str]:
    raw = (DATA / "ruou_keywords.txt").read_text(encoding="utf-8")
    kws = [ln.strip() for ln in raw.split("\n")
           if ln.strip() and not ln.strip().startswith("#")]
    names = [s["name"] for s in _golden()["skus"]
             if s.get("category") == "alcohol"]
    assert kws and names
    return kws + names


@pytest.mark.parametrize("kw", _alcohol_terms())
def test_alcohol_keywords_and_golden_names_blocked(kw):
    r = g.check(f"Quà Tết: {kw} thượng hạng")
    assert r["ok"] is False and "ruou_cam_quang_cao" in _codes(r)
    v = next(v for v in r["violations"] if v["code"] == "ruou_cam_quang_cao")
    assert v["severity"] == "critical"
    # Contract W41.1: span/start/end = match đầu của kb_filter, nằm trong {kw}
    nfc = unicodedata.normalize("NFC", f"Quà Tết: {kw} thượng hạng")
    pre = len("Quà Tết: ")
    assert v["start"] is not None, v
    assert nfc[v["start"]:v["end"]] == v["span"]
    assert pre <= v["start"] < v["end"] <= pre + len(kw), v


def test_alcohol_span_exact():
    v = g.check("Quà Tết: rượu sâm")["violations"][0]
    assert (v["code"], v["span"], v["start"], v["end"]) == (
        "ruou_cam_quang_cao", "rượu", 9, 13)


@pytest.mark.parametrize("word", [
    "r\u200bượu", "r.ượu", "rư-ợu", "RƯ\u00adỢU", "r_u_o_u"])
def test_alcohol_filler_evasion_blocked(word):
    """Pass ký tự chèn áp cho cả luật rượu (cùng lớp với từ cấm); span map
    về text gốc."""
    for r in (g.check(f"Quà Tết: {word} sâm"),
              g.check_publish(f"Quà Tết: {word} sâm." + AI,
                              channel="facebook")):
        assert r["ok"] is False
        v = next(v for v in r["violations"]
                 if v["code"] == "ruou_cam_quang_cao")
        assert v["severity"] == "critical"
        assert (v["span"], v["start"]) == (word, len("Quà Tết: ")), v


@pytest.mark.parametrize("text", ["No.5 sâm tươi", "Tp.HCM giao nhanh",
                                  "Mật ong sâm 300ml", "Samsam.vn"])
def test_alcohol_filler_pass_no_false_positive(text):
    assert "ruou_cam_quang_cao" not in _codes(g.check(text))


def test_output_shape_all_fields():
    for r in (g.check("Saphraton chữa ung thư, rượu sâm"),
              g.check_publish("Savigout giúp làm đẹp", channel="tiktok",
                              content_type="koc"),
              g.check(""), g.check_publish("x", channel="nope")):
        assert {"ok", "violations", "matched_claims", "warnings", "skus",
                "required_labels"} <= set(r)
        for v in r["violations"] + r["warnings"]:
            assert SHAPE <= set(v), v
            assert v["severity"] in g.SEVERITIES
    r = g.check("Saphraton chữa ung thư")
    assert {v["type"] for v in r["violations"]} == {"banned_word"}
    assert r["required_labels"] == []


def test_old_types_keep_names_new_types_equal_code():
    r = g.check("Savina giúp tăng cường trí nhớ. Rượu sâm thuốc quý.")
    by = {v["code"]: v["type"] for v in r["violations"]}
    assert by["tu_cam"] == "banned_word"
    assert by["claim_ngoai_cong_bo"] == "unverified_claim"
    assert by["ruou_cam_quang_cao"] == "ruou_cam_quang_cao"


def test_kb_filter_error_is_config_not_raise(monkeypatch):
    def boom(text):
        raise kb_filter.KbFilterError("rỗng")
    monkeypatch.setattr(kb_filter, "is_alcohol", boom)
    for r in (g.check("Saphraton hỗ trợ bồi bổ sức khỏe"),
              g.check_publish("Bài viết" + AI, channel="web")):
        assert r["ok"] is False and "config" in _codes(r)


def test_internal_error_never_raises(monkeypatch):
    monkeypatch.setattr(g, "_find_terms", lambda *a, **k: 1 / 0)
    r = g.check("bất kỳ")
    assert r["ok"] is False and _codes(r) == ["config"]


# ---------- W41.2 file luật + nhận diện SKU + readiness ----------

def test_rules_file_drift_guard():
    doc, gold = _rules(), _golden()
    assert "chờ pháp chế duyệt" in doc["_doc"].casefold()
    golden = {s["sku_key"]: s for s in gold["skus"]}
    claims = json.loads((DATA / "claims_whitelist.json").read_text(
        encoding="utf-8"))
    owner = {}
    for fam, d in doc["families"].items():
        for k in d["golden_skus"]:
            assert k in golden, (fam, k)
            assert k not in owner, f"{k} thuộc 2 family"
            owner[k] = fam
        for k in d["claims_keys"]:
            assert k in claims, (fam, k)
    for k, s in golden.items():
        if s["category"] in ("tpbvsk", "food"):
            assert k in owner, f"golden {k} không thuộc family nào"
    src = (ROOT / "pipelines" / "guardrail.py").read_text(encoding="utf-8")
    codes = set(re.findall(r'flag\(\s*"([a-z_]+)"', src))
    codes |= set(re.findall(r'_vdict\(\s*"([a-z_]+)"', src))
    assert {"tu_cam", "ruou_cam_quang_cao", "sku_chua_xnqc"} <= codes
    assert codes <= set(doc["rules"]), codes - set(doc["rules"])
    for code, r in doc["rules"].items():
        assert r["severity"] in g.SEVERITIES and r["mode"] in ("block",
                                                               "warn"), code
        assert "chờ pháp chế" in r["trang_thai"].casefold()
    assert doc["disclaimer"]["canonical"] == CANON
    assert doc["labels"]["ai"] == ["Nội dung có sử dụng AI"]
    assert set(doc["channels"]) == set(CHANNELS)
    assert doc["ngoc_linh"]["confirmed_skus"] == []  # external-dep


@pytest.mark.parametrize("text,skus", [
    ("Savina 12 viên", ["savina-12v"]),
    ("Saphraton", ["saphraton-20v", "saphraton-combo-2x20v", "saphraton-40v",
                   "saphraton-80v"]),
    ("Da An Sam", ["da-an-sam-30v"]),
    ("Mật ong sâm 300ml", ["mat-ong-sam-120ml-1hu", "mat-ong-sam-120ml-2hu",
                           "mat-ong-sam-300ml"]),
    ("Savitim", []),
    ("Trà xanh", []),
])
def test_sku_detection(text, skus):
    assert g.check(text)["skus"] == skus


def test_readiness_python_rules():
    assert g.readiness("savina-12v", "shopee") == "MO_TA"
    assert g.readiness("savina-12v", "tiktok") == "CAM"
    assert g.readiness("ruou-sam-binh-su-do-500ml", "shopee") == "CAM"
    assert g.readiness("mat-ong-sam-300ml", "shopee") == "CAM"
    assert g.readiness("khong-co", "shopee") == "CAM"
    s = {"category": "tpbvsk", "allowed_channels": ["web"],
         "xnqc_status": "approved"}
    assert g._readiness_of(s, "web") == "QC_DAY_DU"
    assert g._readiness_of({**s, "allowed_channels": "web"}, "web") == "CAM"
    assert g._readiness_of({"category": "food", "self_declaration_ok": True,
                            "allowed_channels": ["web", None]}, "web") \
        == "TP_THUONG"


SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


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
        schema = f"t_guard_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


def test_readiness_parity_with_db_view(db):
    from ingest import golden_store as gs

    def view():
        return {(k, c): r for k, c, r in db.execute(
            "select sku_key, channel, readiness from sku_readiness")}

    doc = _golden()
    gs.load(db, doc)
    got = view()
    assert len(got) == 13 * 6
    for (k, c), r in got.items():
        assert g.readiness(k, c) == r, (k, c)
    doc2 = copy.deepcopy(doc)
    sav = next(s for s in doc2["skus"] if s["sku_key"] == "savina-12v")
    sav["xnqc_status"] = "approved"
    gs.load(db, doc2)
    got = view()
    by = {s["sku_key"]: s for s in doc2["skus"]}
    for (k, c), r in got.items():
        assert g._readiness_of(by[k], c) == r, (k, c)
    assert got[("savina-12v", "shopee")] == "QC_DAY_DU"
    assert g._readiness_of(sav, "shopee") == "QC_DAY_DU"


@pytest.mark.parametrize("missing", ["guardrail_rules.json",
                                     "golden_skus.json"])
def test_missing_rules_or_golden_is_config(tmp_data, missing):
    path, _ = tmp_data
    (path / missing).unlink()
    g._load_rules.cache_clear()
    for r in (g.check("Saphraton hỗ trợ bồi bổ sức khỏe"),
              g.check_publish("x" + AI, channel="web")):
        assert r["ok"] is False and _codes(r) == ["config"]


def _golden_empty(path):
    (path / "golden_skus.json").write_text('{"skus": []}', encoding="utf-8")


def _golden_truncated(path):
    """Golden còn hợp lệ JSON nhưng thiếu SKU mà families tham chiếu."""
    doc = _golden()
    doc["skus"] = [s for s in doc["skus"] if s["sku_key"] != "savigout-30v"]
    (path / "golden_skus.json").write_text(
        json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def _banned_comments_only(path):
    (path / "banned_words.txt").write_text("# chỉ comment\n\n# hết\n",
                                           encoding="utf-8")


def _write_rules(path, mut):
    doc = _rules()
    mut(doc)
    (path / "guardrail_rules.json").write_text(
        json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def _families_empty(path):
    _write_rules(path, lambda d: d.__setitem__("families", {}))


def _family_savigout_removed(path):
    _write_rules(path, lambda d: d["families"].pop("savigout"))


def _family_savigout_no_skus(path):
    _write_rules(path, lambda d: d["families"]["savigout"].__setitem__(
        "golden_skus", []))


def _family_savigout_no_aliases(path):
    _write_rules(path, lambda d: d["families"]["savigout"].__setitem__(
        "aliases", []))


def _family_savigout_blank_aliases(path):
    _write_rules(path, lambda d: d["families"]["savigout"].__setitem__(
        "aliases", ["  ", ""]))


def _nl_terms_blank(path):
    _write_rules(path, lambda d: d["ngoc_linh"].__setitem__("terms", ["  "]))


def _sku_in_two_families(path):
    _write_rules(path, lambda d: d["families"]["savina"]["golden_skus"]
                 .append("savigout-30v"))


@pytest.mark.parametrize("breaker", [_golden_empty, _golden_truncated,
                                     _banned_comments_only, _families_empty,
                                     _family_savigout_removed,
                                     _family_savigout_no_skus,
                                     _family_savigout_no_aliases,
                                     _family_savigout_blank_aliases,
                                     _nl_terms_blank,
                                     _sku_in_two_families])
def test_zero_record_config_fail_closed(tmp_data, breaker):
    """0-record/cắt cụt khác missing nhưng cùng hậu quả 'không chặn gì'
    (AGENTS.md gotcha) -> config, cả check() lẫn check_publish()."""
    path, _ = tmp_data
    breaker(path)
    g._load_config.cache_clear()
    g._load_rules.cache_clear()
    for r in (g.check("Sản phẩm chữa khỏi ung thư, thay thuốc"),
              g.check_publish("Savigout chính hãng, link mua ở bio "
                              "#quangcao." + AI, channel="tiktok",
                              content_type="koc")):
        assert r["ok"] is False and _codes(r) == ["config"], r
        assert r["violations"][0]["severity"] == "critical"


def test_broken_rules_json_is_config(tmp_data):
    path, _ = tmp_data
    (path / "guardrail_rules.json").write_text("{không phải json",
                                               encoding="utf-8")
    g._load_rules.cache_clear()
    assert _codes(g.check("abc")) == ["config"]


def test_code_missing_in_rules_fail_closed(tmp_data):
    _, write = tmp_data
    write(lambda d: d["rules"].pop("sku_chua_mo_kenh"))
    r = g.check_publish("Savina 12 viên" + AI, channel="tiktok")
    v = next(v for v in r["violations"] if v["code"] == "sku_chua_mo_kenh")
    assert v["severity"] == "critical" and r["ok"] is False


# ---------- W41.3 check_publish ----------

def test_a3_1_savigout_koc_without_xnqc():
    r = g.check_publish("Savigout chính hãng, link mua ở bio",
                        channel="tiktok", content_type="koc")
    assert r["ok"] is False and "sku_chua_xnqc" in _codes(r)
    assert r["required_labels"] == ["Nội dung có sử dụng AI", "Quảng cáo"]


def test_a3_2_alcohol_by_text_internal_note_and_sku_meta():
    t = "Rượu sâm bình sứ đỏ – món quà Tết trang nhã"
    r = g.check_publish(t, channel="facebook", content_type="post_sale")
    assert "ruou_cam_quang_cao" in _codes(r)
    r = g.check_publish(t, channel="facebook", content_type="internal_note")
    assert "ruou_cam_quang_cao" not in _codes(r) and r["ok"] is True
    r = g.check_publish("Bình sứ đỏ 500ml quà Tết" + AI, channel="facebook",
                        sku="ruou-sam-binh-su-do-500ml")
    assert r["ok"] is False and _codes(r) == ["ruou_cam_quang_cao"]


def test_disclaimer_full_post_no_missing_no_banned():
    r = g.check_publish(f"Savina 12 viên hỗ trợ giảm ho. {CANON}.{AI}",
                        channel="shopee")
    assert "thieu_khuyen_cao" not in _codes(r)
    assert "tu_cam" not in _codes(r)
    r = g.check_publish(f"Quà biếu gia đình. {CANON}.{AI}", channel="web")
    assert r["ok"] is True, r["violations"]


def test_disclaimer_exempts_only_its_span():
    t = f"{CANON}. Savina chữa ho.{AI}"
    r = g.check_publish(t, channel="shopee")
    hits = [v for v in r["violations"] if v["code"] == "tu_cam"]
    assert [v["span"] for v in hits] == ["chữa"]
    assert hits[0]["start"] > len(CANON)
    assert "thieu_khuyen_cao" not in _codes(r)
    r = g.check_publish(f"{CANON}, nhưng tốt hơn thuốc.{AI}", channel="web")
    assert [v["span"] for v in r["violations"] if v["code"] == "tu_cam"] \
        == ["thuốc"]


def test_disclaimer_negated_or_variant_missing():
    r = g.check_publish(f"Ai bảo {CANON[0].lower()}{CANON[1:]}.{AI}",
                        channel="shopee", sku="savina-12v")
    assert "thieu_khuyen_cao" in _codes(r)
    r = g.check_publish(f"{CANON}?{AI}", channel="shopee", sku="savina-12v")
    assert "thieu_khuyen_cao" in _codes(r)
    variant = ("Sản phẩm không phải là thuốc và không có tác dụng thay thế "
               "thuốc chữa bệnh.")
    r = g.check_publish(f"Savina hỗ trợ giảm ho. {variant}{AI}",
                        channel="shopee")
    assert "thieu_khuyen_cao" in _codes(r) and "tu_cam" not in _codes(r)
    nodau = ("Thuc pham nay khong phai la thuoc va khong co tac dung thay the"
             " thuoc chua benh.")
    r = g.check_publish(f"Savina 12 viên. {nodau}{AI}", channel="shopee")
    assert "thieu_khuyen_cao" in _codes(r) and "tu_cam" not in _codes(r)


@pytest.mark.parametrize("text", [
    f"{CANON}.", f"Quà Tết.\n{CANON.upper()}.",
    unicodedata.normalize("NFD", f"{CANON}."),
    CANON.replace(" không có", "\nkhông có") + "."])
def test_disclaimer_forms_satisfy_requirement(text):
    r = g.check_publish(text + AI, channel="shopee", sku="savina-12v",
                        content_type="internal_note")
    assert r["ok"] is True
    r = g.check_publish(text + AI, channel="shopee", sku="savina-12v")
    assert "thieu_khuyen_cao" not in _codes(r) and "tu_cam" not in _codes(r)


def test_labels_ai_and_ad():
    r = g.check_publish("Ưu đãi cuối tuần tại cửa hàng.", channel="web")
    assert _codes(r) == ["thieu_nhan_ai"]
    assert g.check_publish("Ưu đãi cuối tuần." + AI, channel="web")["ok"]
    r = g.check_publish("Ưu đãi cuối tuần.", channel="web", is_ai=False)
    assert r["ok"] is True and r["required_labels"] == []
    r = g.check_publish("Ưu đãi cuối tuần." + AI, channel="facebook",
                        content_type="ads")
    assert _codes(r) == ["thieu_nhan_quang_cao"]
    r = g.check_publish("Ưu đãi cuối tuần #quangcao." + AI,
                        channel="facebook", content_type="ads")
    assert r["ok"] is True, r["violations"]
    r = g.check_publish("Ưu đãi." + AI, channel="web", is_sponsored=True)
    assert _codes(r) == ["thieu_nhan_quang_cao"]


def test_claims_bound_to_context_sku():
    r = g.check_publish("Sapentol giúp giảm acid uric" + AI,
                        channel="shopee")
    assert "claim_ngoai_cong_bo" in _codes(r)
    r = g.check_publish("Mật ong sâm hỗ trợ bồi bổ sức khỏe" + AI,
                        channel="shopee")
    assert "claim_suc_khoe_tp_thuong" in _codes(r)
    r = g.check_publish("Sản phẩm giúp giảm mệt mỏi" + AI, channel="shopee")
    assert "claim_khong_ro_sku" in _codes(r)
    # Claim đúng của Savigout khi ngữ cảnh là Savigout -> không ngoài công bố
    r = g.check_publish("Hỗ trợ giảm acid uric trong máu." + AI,
                        channel="shopee", sku="savigout-30v")
    assert "claim_ngoai_cong_bo" not in _codes(r)
    assert "sku_chua_xnqc" in _codes(r)  # vẫn chưa XNQC
    r = g.check_publish("Mật ong sâm 300ml, quà biếu." + AI,
                        channel="shopee")
    assert r["ok"] is True, r["violations"]
    # Nguyên văn claim Savigout (kể cả động từ) gắn cho Sapentol: pool chỉ
    # gồm claim family Sapentol -> ngoài công bố, không khớp 'savigout'.
    r = g.check_publish("Sapentol hỗ trợ giảm acid uric trong máu." + AI,
                        channel="shopee")
    assert "claim_ngoai_cong_bo" in _codes(r)
    assert not [m for m in r["matched_claims"] if m["sku"] == "savigout"]
    # Không có SKU nào -> pool rỗng: claim Savina nguyên văn vẫn ngoài công bố
    r = g.check_publish("Bài viết: hỗ trợ giảm ho." + AI, channel="web")
    assert r["matched_claims"] == []
    assert "claim_ngoai_cong_bo" in _codes(r)
    # Đối chứng chế độ chat (pool toàn bộ khi không nhắc SKU) vẫn khớp
    assert g.check("Bài viết: hỗ trợ giảm ho.")["matched_claims"]


def test_ngoc_linh_rules(tmp_data):
    r = g.check_publish("Sâm Ngọc Linh chính gốc vùng lõi" + AI,
                        channel="shopee", sku="saphraton-20v")
    assert "ngoc_linh_chua_xac_nhan" in _codes(r)
    r = g.check_publish("Xem thêm tại samsamngoclinh.com" + AI,
                        channel="shopee")
    assert r["ok"] is True
    r = g.check_publish("Sam ngoc linh." + AI, channel="web")
    assert "ngoc_linh_chua_xac_nhan" in _codes(r)
    assert "ngoc_linh_chua_xac_nhan" not in _codes(g.check("sâm Ngọc Linh"))
    _, write = tmp_data
    write(lambda d: d["ngoc_linh"].update(identity=["Công ty Mẫu Ngọc Linh"]))
    r = g.check_publish("Công ty Mẫu Ngọc Linh kính chào." + AI,
                        channel="web")
    assert r["ok"] is True, r["violations"]
    r = g.check_publish("Công ty Mẫu Ngọc Linh. Sâm Ngọc Linh." + AI,
                        channel="web")
    spans = [v["start"] for v in r["violations"]
             if v["code"] == "ngoc_linh_chua_xac_nhan"]
    assert len(spans) == 1 and spans[0] > 20
    write(lambda d: d["ngoc_linh"].update(confirmed_skus=["savina-12v"]))
    r = g.check_publish("Savina 12 viên từ vùng Ngọc Linh." + AI,
                        channel="shopee")
    assert "ngoc_linh_chua_xac_nhan" not in _codes(r)
    r = g.check_publish("Saphraton từ vùng Ngọc Linh." + AI,
                        channel="shopee")
    assert "ngoc_linh_chua_xac_nhan" in _codes(r)


def test_channel_not_open_is_warning_only():
    r = g.check_publish("Mật ong sâm 300ml, quà biếu." + AI, channel="tiktok")
    assert r["ok"] is True
    assert _codes(r, "warnings") == ["sku_chua_mo_kenh"] * 3
    assert r["warnings"][0]["severity"] == "minor"
    r = g.check_publish("Mật ong sâm 300ml." + AI, channel="shopee")
    assert r["warnings"] == []


@pytest.mark.parametrize("kw", [
    {"channel": "myspace"}, {"channel": None},
    {"channel": "web", "content_type": "tweet"},
    {"channel": "web", "sku": "khong-ton-tai"},
    {"channel": "web", "sku": ["savina-12v"]}])
def test_publish_bad_context_is_config(kw):
    r = g.check_publish("Bài viết" + AI, **kw)
    assert r["ok"] is False and _codes(r) == ["config"]


def test_channel_alias_blog_is_web():
    r = g.check_publish(f"Savina 12 viên. {CANON}.{AI}", channel="blog")
    assert r["ok"] is True
    assert _codes(r, "warnings") == ["sku_chua_mo_kenh"]
    assert "web" in r["warnings"][0]["detail"]


def test_tpbvsk_ad_without_claim_blocked_but_post_without_claim_ok():
    r = g.check_publish("Savina 12 viên #quangcao." + AI, channel="shopee",
                        content_type="ads")
    assert "sku_chua_xnqc" in _codes(r) and "thieu_khuyen_cao" in _codes(r)
    r = g.check_publish(f"Savina 12 viên. {CANON}.{AI}", channel="shopee")
    assert r["ok"] is True, r["violations"]


# ---------- W41.4 bộ ca có nhãn ----------

def test_eval_cases_labeled_counts():
    """v4.5i: bộ ca nằm ở suite data/eval/suites/guardrail.json (format
    v4.5) thay jsonl v4.1 — cùng 132 ca, cùng assert."""
    doc = json.loads((DATA / "eval" / "suites" / "guardrail.json")
                     .read_text(encoding="utf-8"))
    cases = doc["cases"]
    assert "chờ pháp chế duyệt nhãn" in doc["_doc"].casefold()
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids))
    crit = [c for c in cases if c["kind"] == "trap_critical"]
    assert len(crit) >= 40
    assert all(c["expect"] == "block" for c in crit)
    for code in ("ruou_cam_quang_cao", "sku_chua_xnqc", "thieu_khuyen_cao",
                 "tu_cam"):
        assert sum(c["code"] == code for c in crit) >= 8, code
    new = [c for c in cases if "label_status" in c]
    assert all(c["label_status"] == "chờ Pháp chế duyệt nhãn" for c in new)
    assert all(c.get("code") for c in new if c["expect"] == "block")
    disc = [c for c in new if c["kind"] == "trap_disclaimer"]
    assert len(disc) >= 8 and all(c["expect"] == "pass" for c in disc)
    assert len([c for c in new if c["kind"] in ("trap_disclaimer", "edge",
                                                "pass")]) >= 40
    for c in new:
        if "ctx" in c:
            assert set(c["ctx"]) <= {"channel", "content_type", "sku",
                                     "is_ai", "is_sponsored"}


# ---------- v4.2 W42.1: readiness truyền vào + with_violation + code LLM ----------

SAVINA_OK = f"Savina 12 viên hỗ trợ giảm ho. {CANON}.{AI}"


def test_publish_readiness_param_default_none():
    sig = inspect.signature(g.check_publish)
    assert sig.parameters["readiness"].default is None
    assert sig.parameters["readiness"].kind is inspect.Parameter.KEYWORD_ONLY


def test_publish_readiness_map_from_db_route():
    # Không map -> soi gương golden file (savina chưa XNQC) -> chặn.
    r = g.check_publish(SAVINA_OK, channel="facebook")
    assert "sku_chua_xnqc" in _codes(r)
    # Map view DB nói QC_DAY_DU -> luật XNQC qua (đường DB có tác dụng).
    r = g.check_publish(SAVINA_OK, channel="facebook",
                        readiness={("savina-12v", "facebook"): "QC_DAY_DU"})
    assert "sku_chua_xnqc" not in _codes(r)
    assert r["ok"] is True, r["violations"]
    assert _codes(r, "warnings") == ["sku_chua_mo_kenh"]  # luật 7 vẫn file
    # Map rỗng / thiếu key -> CAM (fail-closed).
    for m in ({}, {("savina-12v", "shopee"): "QC_DAY_DU"}):
        r = g.check_publish(SAVINA_OK, channel="facebook", readiness=m)
        assert "sku_chua_xnqc" in _codes(r), m
        assert "CAM" in next(v["detail"] for v in r["violations"]
                             if v["code"] == "sku_chua_xnqc")


def test_publish_readiness_alias_before_lookup():
    m = {("savina-12v", "web"): "QC_DAY_DU"}
    r = g.check_publish(SAVINA_OK, channel="blog", readiness=m)
    assert "sku_chua_xnqc" not in _codes(r) and r["ok"] is True
    r = g.check_publish(SAVINA_OK, channel="blog",
                        readiness={("savina-12v", "blog"): "QC_DAY_DU"})
    assert "sku_chua_xnqc" in _codes(r)


@pytest.mark.parametrize("bad", ["x", ["savina-12v"], 1,
                                 {("savina-12v", "web"): "BOGUS"},
                                 {("savina-12v", "web"): None}])
def test_publish_readiness_bad_is_config(bad):
    r = g.check_publish(SAVINA_OK, channel="web", readiness=bad)
    assert r["ok"] is False and _codes(r) == ["config"]


def test_with_violation_only_adds_block():
    ok = g.check_publish("Quà biếu gia đình." + AI, channel="web")
    assert ok["ok"] is True
    snap = copy.deepcopy(ok)
    out = g.with_violation(ok, "llm_ngam_y_suc_khoe", "ẩn ý", "Quà", 0, 3)
    assert ok == snap                                  # không mutate
    assert out is not ok and out["ok"] is False
    v = out["violations"][-1]
    assert set(v) == SHAPE and v["code"] == "llm_ngam_y_suc_khoe"
    assert (v["severity"], v["span"], v["start"], v["end"]) == \
        ("major", "Quà", 0, 3)
    # Trên kết quả đã chặn: vẫn False, violations cũ ⊆ mới.
    bad = g.check_publish("Savina chữa ho." + AI, channel="web")
    out2 = g.with_violation(bad, "llm_check_unavailable", "lỗi")
    assert out2["ok"] is False
    assert bad["violations"] == out2["violations"][:len(bad["violations"])]
    # Code thiếu luật -> critical block (fail-closed như flag()).
    out3 = g.with_violation(ok, "khong_co_luat", "x")
    assert out3["ok"] is False
    assert out3["violations"][-1]["severity"] == "critical"
    # Input rác -> dict ok False, không raise.
    for junk in (None, "x", {"ok": "true"}, {"ok": 1, "violations": "x"}):
        r = g.with_violation(junk, "llm_check_unavailable", "x")
        assert r["ok"] is False and r["violations"][-1]["code"] == \
            "llm_check_unavailable"


def test_with_violation_warn_mode_keeps_ok(tmp_data):
    _, write = tmp_data
    write(lambda d: d["rules"]["llm_check_unavailable"].update(mode="warn"))
    ok = g.check_publish("Quà biếu gia đình." + AI, channel="web")
    out = g.with_violation(ok, "llm_check_unavailable", "timeout")
    assert out["ok"] is True and out["violations"] == []
    assert _codes(out, "warnings") == ["llm_check_unavailable"]
    # warn KHÔNG nâng ok của kết quả đã chặn.
    bad = {"ok": False, "violations": [{"code": "tu_cam"}], "warnings": []}
    assert g.with_violation(bad, "llm_check_unavailable", "x")["ok"] is False


def test_llm_codes_drift_guard():
    """Code mà lớp LLM (pipelines/guardrail_llm.py) dùng phải có trong
    rules — mở rộng drift-guard v4.1 sang module mới."""
    doc = _rules()
    src = (ROOT / "pipelines" / "guardrail_llm.py").read_text(
        encoding="utf-8")
    codes = set(re.findall(r'^CODE_\w+\s*=\s*"([a-z_]+)"', src,
                           re.MULTILINE))
    codes |= set(re.findall(r'with_violation\([^,]+,\s*"([a-z_]+)"', src))
    assert {"llm_ngam_y_suc_khoe", "llm_check_unavailable"} <= codes
    assert codes <= set(doc["rules"]), codes - set(doc["rules"])
    for c in codes:
        assert doc["rules"][c]["mode"] == "block", c   # bản dev fail-closed
        assert "chờ pháp chế" in doc["rules"][c]["trang_thai"].casefold()


# ---------- v4.2 W42.7: vá ca lọt red-team (homoglyph, emoji, khoảng trắng) ----------

@pytest.mark.parametrize("text", [
    "thuố\u0441 quý",                       # Cyrillic \u0441
    "\u0441hữa mất ngủ",                    # Cyrillic \u0441 đầu từ
    "\u0442huốc tự nhiên",                  # Cyrillic \u0442
    "\uff54\uff48\uff55ố\uff43 bổ",         # fullwidth
    "th\U0001f48auốc quý",                  # emoji chèn giữa chữ
    "Đ\u2764\ufe0fiều trị mệt mỏi",         # emoji + variation selector
    "thu\u2009ốc bổ",                       # thin space giữa chữ
    "t h u ố c bổ",                         # chữ đơn cách đơn
    "c h ữ a mất ngủ",
    "khỏi bịnh lun",                        # teencode (banned_words v4.2)
    "thay thuốk luôn", "đìu trị mệt mỏi",
])
def test_redteam_patched_evasions_blocked(text):
    for r in (g.check(text), g.check_publish(text + AI, channel="web")):
        assert "tu_cam" in _codes(r), text
        v = next(v for v in r["violations"] if v["code"] == "tu_cam")
        nfc = unicodedata.normalize("NFC", text)
        assert nfc[v["start"]:v["end"]] == v["span"]


@pytest.mark.parametrize("text", [
    "Quà Tết: ru\u043eu sâm 40 độ",           # homoglyph trong 'ruou'
    "R\u03c5\u043eu sâm",                    # Greek upsilon + Cyrillic o
    "Rựu sâm nhà làm",                       # teencode (ruou_keywords v4.2)
    "r ư ợ u sâm",                           # chữ đơn cách đơn
])
def test_redteam_patched_alcohol_blocked(text):
    r = g.check_publish(text + AI, channel="facebook")
    assert "ruou_cam_quang_cao" in _codes(r), text


@pytest.mark.parametrize("text", [
    "Sản phẩm thuộc dòng quà biếu.",          # thuộc ≠ thuốc
    "Xem thêm tại samsamngoclinh.com",
    "Sâm \U0001f33f Sâm — quà biếu",         # emoji có khoảng trắng 2 bên
    "Vitamin A B C cho bé",                   # chữ đơn cách đơn không ra từ cấm
    "\u041c\u043e\u0441\u043a\u0432\u0430 \u0438 \u0410\u0444\u0438\u043d\u044b",                         # Cyrillic/Greek thật
    "Tp. HCM, No.5, \uff11\uff12\uff13",      # fullwidth số
    "Quà Tết\u2009sang trọng\u00a0cho cả nhà",
])
def test_redteam_patches_no_false_positive(text):
    assert "tu_cam" not in _codes(g.check(text)), text
    r = g.check_publish(text + AI, channel="web")
    assert not ({"tu_cam", "ruou_cam_quang_cao"} & set(_codes(r))), text


def test_fold_homoglyph_fullwidth_keeps_length():
    for s in ("\u0441\u043e\u0440\u0442\u03c4\u03bf\uff54\uff21",
              "ß ﬁ İ İ \U0001f48a", "Thực phẩm này"):
        assert len(g._fold(s)) == len(s)
    assert g._fold("\u0441\u03bf\uff54") == "cot"


def test_redteam_whitespace_runs_and_dotted_words_not_merged():
    # Biến thể LLM thật (W42.7): chuỗi trắng Unicode trộn giữa chữ đơn.
    for text in ("Uống sâm c \u2009 h ữ a mất ngủ",
                 "Uống sâm c \u2003 \u2002 h ữ a mất ngủ",
                 "Sâm — t h u ố c."):
        assert "tu_cam" in _codes(g.check(text)), ascii(text)
    # Nhánh chữ-đơn KHÔNG nối các từ viết chấm liền nhau (v4.1 vẫn bắt).
    r = g.check("uống t.h.u.o.c t.h.u.o.c nhé")
    assert [v["span"] for v in r["violations"]] == ["t.h.u.o.c"] * 2
    # Giới hạn đã ghi known-gap rt-ws-06: nhiều từ cách chữ liền nhau.
    assert g._compress("t h u ố c t r ị")[0] == "thuốctrị"
