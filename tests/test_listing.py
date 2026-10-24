"""v6.1-content-listing (MKT-02, WP08) — listing chuẩn theo kênh + content
theo SKU/loại + cột ngữ cảnh `content_drafts` + batch idempotent.

- W61.1 store: cột content_type/sku/is_ai/prompt_* (fake conn + DB thật
  schema tạm, ROLLBACK — mẫu tests/test_auth_approval.py).
- W61.2 template `data/prompts/` (sha manifest, CRLF) + precheck draft.
- W61.3 listing: thông số khớp golden byte-by-byte, LLM bị lọc chữ số,
  rượu/readiness từ chối 0 LLM, nhãn/khuyến cáo do code chèn.
- W61.4 batch/CLI: idempotent (sku, kênh, prompt_version), DB chết exit 2.
Gateway giả qua `llm_gateway._client` (đếm call) — không mạng, không key
thật; conftest tắt ghi llm_usage + env lớp LLM-check.
"""

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import types
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest

from ingest import golden_store as gs
from pipelines import content, guardrail, guardrail_llm, llm_gateway, store

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json").read_text(
    encoding="utf-8"))
GOLD = {s["sku_key"]: s for s in GOLDEN["skus"]}
RULES = json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
    encoding="utf-8"))
CANON = RULES["disclaimer"]["canonical"]
AI = RULES["labels"]["ai"][0]
AD = RULES["labels"]["ad"][0]
MANIFEST = json.loads((ROOT / "data" / "prompts" / "manifest.json")
                      .read_text(encoding="utf-8"))
ALCOHOL = [k for k, s in GOLD.items() if s["category"] == "alcohol"]
LISTING_CH = ("shopee", "tiktok", "web")


def _resp(text):
    return types.SimpleNamespace(choices=[types.SimpleNamespace(
        message=types.SimpleNamespace(content=text))])


def _fake(monkeypatch, *texts, raise_exc=None):
    """Gateway giả: trả lần lượt `texts` (hết thì lặp cái cuối), đếm call
    (list messages mỗi call)."""
    calls = []

    def _create(model=None, messages=None, **kw):
        calls.append(list(messages or []))
        if raise_exc is not None:
            raise raise_exc
        return _resp(texts[min(len(calls), len(texts)) - 1])

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setattr(llm_gateway, "_client", lambda: types.SimpleNamespace(
        chat=types.SimpleNamespace(
            completions=types.SimpleNamespace(create=_create))))
    return calls


def _eligible():
    return [k for k in GOLD
            if guardrail.readiness(k, "shopee") != "CAM"]


def _llm_json(**kw):
    d = {"hook": "Quà biếu tinh tế", "description": "Vị ngọt dịu, sánh mịn.",
         "bullets": ["Đóng hũ thủy tinh sạch"],
         "keywords": ["mật ong sâm", "quà biếu"]}
    d.update(kw)
    return json.dumps(d, ensure_ascii=False)


def _codes(g):
    return [v.get("code") for v in g.get("violations") or []]


# ======================= W61.2 template + precheck ==========================

def test_manifest_sha_matches_every_template():
    assert set(MANIFEST["templates"]) == {
        "content_facebook", "content_zalo", "content_tiktok", "content_blog",
        "listing_shopee", "listing_tiktok", "listing_web",
        "image_background",                     # v6.2 MKT-03 prompt nền
        "video_script",                         # v6.3 MKT-04 kịch bản video
        "livestream_script", "youtube_long"}    # v10.1 KD-A9 + MKT-12
    for name, ent in MANIFEST["templates"].items():
        raw = (ROOT / "data" / "prompts" / f"{name}.md").read_bytes()
        sha = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()
        assert ent["sha256"] == sha, name
        assert ent["version"] == f"{name}@1"
        assert ent["trang_thai"] == "chờ GĐ Marketing duyệt"
        text, ver, got = content.load_template(name)
        assert (ver, got) == (ent["version"], sha) and text


def test_template_byte_change_raises_crlf_same_sha(tmp_path, monkeypatch):
    shutil.copytree(ROOT / "data" / "prompts", tmp_path / "p")
    monkeypatch.setattr(content, "PROMPTS_DIR", tmp_path / "p")
    f = tmp_path / "p" / "content_zalo.md"
    orig = f.read_bytes().replace(b"\r\n", b"\n")
    f.write_bytes(orig.replace(b"\n", b"\r\n"))         # CRLF cùng nội dung
    assert content.load_template("content_zalo")[2] == \
        MANIFEST["templates"]["content_zalo"]["sha256"]
    f.write_bytes(orig + b" ")                           # sửa 1 byte
    with pytest.raises(ValueError, match="bump version"):
        content.load_template("content_zalo")
    with pytest.raises(ValueError):
        content.load_template("khong-co")
    (tmp_path / "p" / "listing_web.md").unlink()
    with pytest.raises(ValueError):
        content.load_template("listing_web")


def test_channel_hint_is_view_of_templates():
    for ch, name in content.CONTENT_TEMPLATES.items():
        assert content.CHANNEL_HINT[ch] == content.load_template(name)[0]


@pytest.mark.parametrize("ch", ["facebook", "zalo", "tiktok", "blog"])
def test_prompt_contains_template_and_meta(monkeypatch, ch):
    calls = _fake(monkeypatch, "Sâm Sâm Quảng Nam — quà tặng.\n\n" + AI)
    r = content.draft("x", ch)
    name = content.CONTENT_TEMPLATES[ch]
    tmpl, _ver, sha = content.load_template(name)
    assert tmpl in calls[0][0]["content"]
    assert r["meta"] == {"content_type": "post", "sku": None, "is_ai": True,
                         "prompt_version": MANIFEST["templates"][name]
                         ["version"], "prompt_sha256": sha, "refused": None}


@pytest.mark.parametrize("ch", ["facebook", "zalo", "tiktok", "blog"])
def test_draft_alcohol_refused_every_channel_zero_calls(monkeypatch, ch):
    calls = _fake(monkeypatch, "x")
    for sku in ALCOHOL:
        r = content.draft("giới thiệu", ch, sku=sku)
        assert r["meta"]["refused"]["code"] == "ruou", sku
        assert r["text"] == "" and r["guardrail"]["ok"] is False
        assert "ruou_cam_quang_cao" in _codes(r["guardrail"])
    assert calls == []


def test_draft_ads_savina_xnqc_refused_unless_qc_day_du(monkeypatch):
    calls = _fake(monkeypatch, "Savina 12 viên hỗ trợ giảm ho.")
    r = content.draft("b", "facebook", sku="savina-12v", content_type="ads")
    assert r["meta"]["refused"]["code"] == "xnqc" and calls == []
    assert "sku_chua_xnqc" in _codes(r["guardrail"])
    r = content.draft("b", "facebook", sku="savina-12v", content_type="ads",
                      readiness={("savina-12v", "facebook"): "QC_DAY_DU"})
    assert len(calls) == 1 and r["meta"]["refused"] is None


def test_code_inserts_disclaimer_ad_and_ai_labels(monkeypatch):
    calls = _fake(monkeypatch, "Savina 12 viên hỗ trợ giảm ho.")
    r = content.draft("b", "facebook", sku="savina-12v", content_type="ads",
                      readiness={("savina-12v", "facebook"): "QC_DAY_DU"})
    assert len(calls) == 1                       # không tốn lượt sửa
    assert r["guardrail"]["ok"] is True, r["guardrail"]["violations"]
    assert CANON + "." in r["text"] and AD in r["text"] and AI in r["text"]
    assert r["meta"]["content_type"] == "ads"
    assert r["meta"]["sku"] == "savina-12v"
    # LLM không nhắc SKU/claim -> code không chèn câu khuyến cáo thừa.
    calls = _fake(monkeypatch, "Sâm Sâm Quảng Nam — quà tặng.")
    r = content.draft("b", "zalo")
    assert CANON not in r["text"] and r["text"].endswith(AI)


def test_draft_precheck_unknown_sku_and_channel(monkeypatch):
    calls = _fake(monkeypatch, "x")
    assert content.draft("b", "facebook", sku="khong-co")["meta"][
        "refused"]["code"] == "sku_la"
    assert content.draft("b", "insta", sku="savina-12v")["meta"][
        "refused"]["code"] == "kenh_la"
    assert content.draft("b", "facebook", content_type="la")["meta"][
        "refused"]["code"] == "loai_la"
    assert calls == []
    multi = content.draft_multi("b", ["facebook", "zalo"],
                                sku=ALCOHOL[0])
    assert {r["meta"]["refused"]["code"] for r in multi.values()} == {"ruou"}
    assert calls == []


# ======================= W61.3 listing ======================================

def test_listing_rules_and_content_type_config():
    lr = json.loads((ROOT / "data" / "listing_rules.json").read_text(
        encoding="utf-8"))
    assert "GIẢ ĐỊNH — chờ xác minh Seller Center" in lr["_doc"]
    assert set(lr["channels"]) == set(LISTING_CH)
    for d in lr["channels"].values():
        assert set(d) == {"title_max", "bullets_max", "keywords_max",
                          "desc_max"}
    assert lr["missing_price"] == "Liên hệ"
    assert lr["missing_attr"] == "Xem trên bao bì"
    assert lr["brand_keywords"] == ["Sâm Sâm"]
    ct = RULES["content_types"]["listing"]
    assert ct["public"] is True and ct["ad"] is False
    assert "chờ Pháp chế" in ct["trang_thai"]


def _claim_free(text):
    low = text.replace(CANON, "").casefold()
    return [v for v in guardrail.CLAIM_VERBS
            if re.search(rf"(?<!\w){re.escape(v)}(?!\w)", low)]


def test_listing_golden_byte_exact_all_eligible(monkeypatch):
    calls = _fake(monkeypatch, "x")
    elig = _eligible()
    assert len(elig) == 7 and all(GOLD[k]["category"] == "tpbvsk"
                                  for k in elig)
    for k in elig:
        g, r = GOLD[k], content.listing(k, "shopee")
        assert r["ok"] is True, (k, r["guardrail"]["violations"])
        f = r["fields"]
        assert f["name"] == g["name"] and f["pack_spec"] == g["pack_spec"]
        assert f["receipt_no"] == g["receipt_no"]
        lines = r["text"].split("\n")
        assert f"Quy cách: {g['pack_spec']}" in lines
        assert f"Số ĐKSP: {g['receipt_no']}" in lines
        [price] = [ln for ln in lines if ln.startswith("Giá: ")]
        assert re.sub(r"\D", "", price) == str(g["prices"]["shopee"]["list"])
        for kind in ("floor", "promo"):
            v = g["prices"]["shopee"][kind]
            assert str(v) not in r["text"], (k, kind)
            assert f"{v:,}".replace(",", ".") not in r["text"], (k, kind)
        assert "Hạn sử dụng: Xem trên bao bì" in lines
        assert _claim_free(r["text"]) == [], k
        assert CANON + "." in r["text"] and r["text"].endswith(AI)
        assert r["meta"]["llm_part"] == "none"
        assert r["meta"]["prompt_version"] == "listing_shopee@1"
    assert calls == []                          # MO_TA = khung, 0 LLM


def test_listing_llm_wrong_numbers_stripped(monkeypatch):
    calls = _fake(monkeypatch, _llm_json(
        description="Quy cách 999ml, giá chỉ 99.000đ. Vị ngọt dịu.",
        bullets=["Hộp \uff19\uff19\uff19ml", "Sánh mịn tự nhiên"],
        keywords=["giá 1 triệu", "mật ong sâm"], hook="Size 500ml"))
    rmap = {("mat-ong-sam-300ml", "shopee"): "TP_THUONG"}
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap)
    assert len(calls) == 1 and r["meta"]["llm_part"] == "used"
    assert r["ok"] is True, r["guardrail"]["violations"]
    t = r["text"]
    for bad in ("999", "\uff19\uff19\uff19", "99.000", "500ml", "1 triệu"):
        assert bad not in t, bad
    assert "Vị ngọt dịu" in t and "- Sánh mịn tự nhiên" in t
    lines = t.split("\n")
    assert "Quy cách: 300ml x 1 hũ" in lines
    assert "Giá: 2.980.000 đ" in lines
    assert lines[0] == "Mật ong sâm 300ml"      # hook có số bị bỏ
    assert "Số ĐKSP" not in t                    # food: không dòng ĐKSP
    assert r["fields"]["receipt_no"] is None


def test_listing_llm_newline_cannot_forge_frame_line(monkeypatch):
    _fake(monkeypatch, _llm_json(description="Ngon.\nGiá: Liên hệ ngay",
                                 hook="Quà\nQuy cách: hộp lớn"))
    r = content.listing("mat-ong-sam-300ml", "shopee",
                        readiness={("mat-ong-sam-300ml", "shopee"):
                                   "TP_THUONG"})
    lines = r["text"].split("\n")
    assert [ln for ln in lines if ln.startswith("Giá:")] == \
        ["Giá: 2.980.000 đ"]
    assert [ln for ln in lines if ln.startswith("Quy cách:")] == \
        ["Quy cách: 300ml x 1 hũ"]


def test_listing_llm_spec_words_and_unicode_numerics_stripped(monkeypatch):
    """Fix nghiệm thu v6.1: ký tự số ngoài Nd (①²Ⅻ), nhãn khung không có
    số ('Giá: Liên hệ'), số viết bằng chữ -> bị loại; câu thường giữ."""
    calls = _fake(monkeypatch, _llm_json(
        hook="Hộp năm mươi gram",
        description=("Giá chỉ còn chín mươi chín nghìn đồng. Hộp năm mươi "
                     "gram. Hạn dùng hai năm. Bảo quản được ba năm. Một món "
                     "quà ý nghĩa. Giữ giá trị truyền thống. Được khách đánh "
                     "giá cao. Chế biến tỉ mỉ."),
        bullets=["Giá: Liên hệ hotline", "Hộp ①②③ ml", "Quy cách: một hũ lớn",
                 "Quy cách mười viên", "Đủ dùng Ⅻ tuần", "Nồng độ x²",
                 "Sánh mịn tự nhiên"],
        keywords=["giá năm trăm nghìn", "mật ong ①", "quà biếu"]))
    rmap = {("mat-ong-sam-300ml", "shopee"): "TP_THUONG"}
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap)
    assert len(calls) == 1 and r["meta"]["llm_part"] == "used"
    assert r["ok"] is True, r["guardrail"]["violations"]
    t = r["text"]
    lines = t.split("\n")
    assert lines[0] == "Mật ong sâm 300ml"            # hook chữ-số bị bỏ
    assert lines[2] == ("Một món quà ý nghĩa. Giữ giá trị truyền thống. "
                        "Được khách đánh giá cao. Chế biến tỉ mỉ.")
    assert [ln for ln in lines if ln.startswith("- ")] == \
        ["- Sánh mịn tự nhiên"]
    assert [ln for ln in lines if "giá" in ln.casefold()
            and ln.startswith(("Giá", "- "))] == ["Giá: 2.980.000 đ"]
    assert [ln for ln in lines if ln.startswith("Quy cách")] == \
        ["Quy cách: 300ml x 1 hũ"]
    for bad in ("Liên hệ", "①", "²", "Ⅻ", "mươi", "nghìn", "trăm",
                "mười viên", "một hũ", "hai năm", "ba năm"):
        assert bad not in t, bad
    [kw] = [ln for ln in lines if ln.startswith("Từ khóa: ")]
    assert "quà biếu" in kw
    # System prompt listing không còn câu xúi tự ghi "Liên hệ"; draft giữ.
    sys_listing = calls[0][0]["content"]
    assert 'ghi "Liên hệ"' not in sys_listing
    assert "KHÔNG viết giá" in sys_listing
    assert 'ghi "Liên hệ"' in content._system("x")


def test_listing_llm_obfuscated_frame_label_stripped(monkeypatch):
    """Fix nghiệm thu v6.1 F2 (probe reviewer): LLM giả nhãn 'Giá' bằng
    ZWSP/homoglyph Cyrillic/fullwidth/dấu chấm chèn -> bị loại; listing chỉ
    còn 1 dòng giá = golden."""
    calls = _fake(monkeypatch, _llm_json(
        bullets=["Gi\u200bá: Liên hệ hotline", "G\u0456á sỉ: liên hệ",
                 "\uff47\uff49á: Liên hệ", "Gi.á: Liên hệ",
                 "Sánh mịn tự nhiên"],
        keywords=["g\u0456á rẻ", "quà biếu"]))
    rmap = {("mat-ong-sam-300ml", "shopee"): "TP_THUONG"}
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap)
    assert len(calls) == 1 and r["meta"]["llm_part"] == "used"
    assert r["ok"] is True, r["guardrail"]["violations"]
    t = r["text"]
    assert [ln for ln in t.split("\n") if ln.startswith("- ")] == \
        ["- Sánh mịn tự nhiên"]
    assert "Liên hệ" not in t and "liên hệ" not in t
    for ch in ("\u200b", "\u0456", "\uff47"):
        assert ch not in t, ascii(ch)
    assert t.count("2.980.000") == 1 and "Giá: 2.980.000 đ" in t


def test_spec_like_unit_cases():
    sl = content._spec_like
    for s in ("Hộp ①②③ ml", "x²", "Ⅻ", "\uff15\uff10\uff10", "Giá: Liên hệ",
              "giá năm trăm nghìn", "Quy cách mười viên", "Hạn sử dụng dài",
              "khối lượng tịnh", "dung tích lớn", "chín mươi chín",
              "hai tháng", "nửa cân", "hai triệu", "vnđ", "GIÁ SỐC"):
        assert sl(s), s
    # Fix nghiệm thu v6.1 F2: giả nhãn khung qua ký tự chèn/homoglyph/
    # fullwidth (cùng lớp guardrail đã chặn "th\u200buốc") -> vẫn bị loại.
    for s in ("Gi\u200bá: Liên hệ", "G\u0456á: Liên hệ",
              "\uff47\uff49á: Liên hệ", "Gi.á: Liên hệ", "G i á sỉ",
              "Gi\u00adá: Liên hệ", "Gi\u2063á: Liên hệ",
              "G\u0456a\u0301 sỉ: liên hệ", "\uff27\uff29Á sốc",
              "Quy\u200b cách: hộp lớn", "Kh\u043e\u0302\u0301i lượng tịnh",
              "H\u200bSD dài"):
        assert sl(s), ascii(s)
    for s in ("Một món quà ý nghĩa", "giá trị truyền thống",
              "G\u0456á tr\u0456\u0323 truyền thống", "Quà biếu tinh tế.Sang trọng",
              "được đánh giá cao", "tỉ mỉ", "cộng đồng", "đồng hành",
              "Đóng hũ thủy tinh sạch", "Quà biếu tinh tế"):
        assert not sl(s), s


def test_listing_channel_limits_enforced(tmp_path, monkeypatch):
    """title_max/desc_max/bullets_max/keywords_max của listing_rules.json
    được áp (bản tmp giới hạn nhỏ); tên > title_max -> từ chối config."""
    lr = json.loads((ROOT / "data" / "listing_rules.json").read_text(
        encoding="utf-8"))
    lim = {"title_max": 30, "desc_max": 40, "bullets_max": 2,
           "keywords_max": 3}
    lr["channels"]["shopee"] = dict(lim)
    p = tmp_path / "listing_rules.json"
    p.write_text(json.dumps(lr, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(content, "LISTING_RULES", p)
    hook = "Quà biếu tinh tế cho gia đình mỗi dịp lễ"
    calls = _fake(monkeypatch, _llm_json(
        hook=hook,
        description=("Vị ngọt dịu, sánh mịn. Hương thơm tự nhiên của hoa "
                     "rừng. Quà biếu ý nghĩa."),
        bullets=["Đóng hũ thủy tinh sạch", "Sánh mịn tự nhiên",
                 "Màu vàng óng", "Thơm hoa rừng", "Hợp làm quà"],
        keywords=["mật ong sâm", "quà biếu", "quà tết", "đặc sản",
                  "mật ong"]))
    rmap = {("mat-ong-sam-300ml", "shopee"): "TP_THUONG"}
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap)
    assert len(calls) == 1 and r["meta"]["llm_part"] == "used"
    assert r["ok"] is True, r["guardrail"]["violations"]
    lines = r["text"].split("\n")
    name = "Mật ong sâm 300ml"
    full, title = f"{name} – {hook}", lines[0]
    assert len(full) > lim["title_max"] >= len(title) > len(name)
    assert full.startswith(title) and full[len(title)] == " "  # cắt theo từ
    assert lines[2] == "Vị ngọt dịu, sánh mịn."
    assert len(lines[2]) <= lim["desc_max"]
    assert len([ln for ln in lines if ln.startswith("- ")]) == 2
    [kw] = [ln for ln in lines if ln.startswith("Từ khóa: ")]
    assert kw[len("Từ khóa: "):].split(", ") == \
        [name, "Sâm Sâm", "mật ong sâm"]
    # Tên SKU dài hơn title_max -> từ chối config, 0 LLM.
    lr["channels"]["shopee"]["title_max"] = 10
    p.write_text(json.dumps(lr, ensure_ascii=False), encoding="utf-8")
    n = len(calls)
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap)
    assert r["refused"]["code"] == "config" and r["text"] == ""
    assert r["ok"] is False and len(calls) == n


@pytest.mark.parametrize("ch", LISTING_CH)
def test_listing_alcohol_refused_even_if_map_qc(monkeypatch, ch):
    calls = _fake(monkeypatch, _llm_json())
    for sku in ALCOHOL:
        for rmap in (None, {(sku, ch): "QC_DAY_DU"}):
            r = content.listing(sku, ch, readiness=rmap)
            assert r["refused"]["code"] == "ruou", (sku, rmap)
            assert r["ok"] is False and r["text"] == ""
    assert calls == []


def test_listing_readiness_refusals_zero_calls(monkeypatch):
    calls = _fake(monkeypatch, _llm_json())
    cases = [("savina-12v", "tiktok", "readiness"),
             ("saphraton-40v", "shopee", "readiness"),
             ("mat-ong-sam-120ml-1hu", "shopee", "readiness"),
             ("khong-co-sku", "shopee", "sku_la"),
             ("savina-12v", "facebook", "kenh_la")]
    for sku, ch, code in cases:
        r = content.listing(sku, ch)
        assert r["refused"]["code"] == code, (sku, ch, r["refused"])
        assert r["text"] == "" and r["guardrail"]["ok"] is False
        assert store.guardrail_lines(r["guardrail"])[0][0] == "error"
    assert "CAM" in content.listing("savina-12v", "tiktok")["refused"][
        "reason"]
    # map có mà thiếu key = CAM.
    assert content.listing("savina-12v", "shopee", readiness={})[
        "refused"]["code"] == "readiness"
    assert calls == []


@pytest.mark.parametrize("bad", ["không phải json", '{"hook": 1}',
                                 '```json\n[1, 2]\n```'])
def test_listing_garbage_llm_falls_back_to_frame(monkeypatch, bad):
    calls = _fake(monkeypatch, bad)
    r = content.listing("mat-ong-sam-300ml", "shopee",
                        readiness={("mat-ong-sam-300ml", "shopee"):
                                   "TP_THUONG"})
    assert len(calls) == 1 and r["ok"] is True
    assert r["meta"]["llm_part"] == "dropped:parse"
    assert "Quy cách: 300ml x 1 hũ" in r["text"].split("\n")


def test_listing_gateway_error_falls_back(monkeypatch):
    _fake(monkeypatch, raise_exc=llm_gateway.GatewayError("down"))
    r = content.listing("mat-ong-sam-300ml", "shopee",
                        readiness={("mat-ong-sam-300ml", "shopee"):
                                   "TP_THUONG"})
    assert r["ok"] is True and r["meta"]["llm_part"].startswith("dropped:")


def test_listing_ngoc_linh_dropped_by_guardrail(monkeypatch):
    calls = _fake(monkeypatch, _llm_json(
        description="Mật ong từ vùng Ngọc Linh. Sâm Ngọc Linh thơm."))
    r = content.listing("mat-ong-sam-300ml", "shopee",
                        readiness={("mat-ong-sam-300ml", "shopee"):
                                   "TP_THUONG"})
    assert len(calls) == 2                      # 1 lượt sửa có feedback
    assert "ngoc_linh_chua_xac_nhan" in calls[1][-1]["content"]
    assert r["meta"]["llm_part"] == "dropped:guardrail"
    assert r["ok"] is True and "Ngọc Linh" not in r["text"]


def test_listing_tp_thuong_llm_off_or_mo_ta_no_call(monkeypatch):
    calls = _fake(monkeypatch, _llm_json())
    rmap = {("mat-ong-sam-300ml", "shopee"): "TP_THUONG"}
    r = content.listing("mat-ong-sam-300ml", "shopee", readiness=rmap,
                        llm=False)
    assert r["ok"] is True and r["meta"]["llm_part"] == "none"
    assert calls == []


def test_listing_missing_price_lien_he(tmp_path, monkeypatch):
    """saphraton-40v không có giá list -> 'Liên hệ' (không lộ floor)."""
    rmap = {("saphraton-40v", "shopee"): "MO_TA"}
    r = content.listing("saphraton-40v", "shopee", readiness=rmap)
    assert r["ok"] is True
    assert "Giá: Liên hệ" in r["text"].split("\n")
    assert "450" not in r["text"]


def _tmp_data(tmp_path, monkeypatch, mutate):
    d = tmp_path / "data"
    d.mkdir()
    for f in ("banned_words.txt", "claims_whitelist.json",
              "golden_skus.json"):
        shutil.copy(ROOT / "data" / f, d)
    rules = copy.deepcopy(RULES)
    mutate(rules)
    (d / "guardrail_rules.json").write_text(
        json.dumps(rules, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(guardrail, "DATA_DIR", d)
    guardrail._load_config.cache_clear()
    return d


def test_config_switch_listing_ad_true_blocks_unapproved(tmp_path,
                                                         monkeypatch):
    frame = content.listing("savina-12v", "shopee")["text"]
    _tmp_data(tmp_path, monkeypatch,
              lambda r: r["content_types"]["listing"].update(ad=True))
    try:
        r = content.listing("savina-12v", "shopee")
        assert r["refused"]["code"] == "xnqc"
        assert "sku_chua_xnqc" in _codes(r["guardrail"])
        # Chính guardrail cũng chặn khung khi listing là quảng cáo.
        g = guardrail.check_publish(frame, channel="shopee",
                                    content_type="listing",
                                    sku="savina-12v")
        assert "sku_chua_xnqc" in _codes(g)
    finally:
        guardrail._load_config.cache_clear()


def test_llm_check_layer_applies_to_listing(monkeypatch):
    monkeypatch.setenv("GUARDRAIL_LLM_MODEL", "google/gemini-test")
    calls = _fake(monkeypatch, '{"flag": true, "reasons": [{"quote": '
                               '"Savina", "why": "ẩn ý"}]}')
    r = content.listing("savina-12v", "shopee")
    assert r["ok"] is False and r["guardrail"]["llm_check"] == "flag"
    assert "llm_ngam_y_suc_khoe" in _codes(r["guardrail"])
    assert len(calls) == 1                      # chỉ lớp check, 0 content


def test_content_py_has_no_publish_path():
    src = (ROOT / "pipelines" / "content.py").read_text(encoding="utf-8")
    assert not re.search(r"set_status|approve_draft|schedule|requests|"
                         r"httpx|urllib", src)


# ======================= W61.1 store (fake conn) ============================

class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self, routes=()):
        self.routes, self.calls, self.committed = list(routes), [], 0

    def execute(self, sql, params=None):
        self.calls.append((sql, tuple(params or ())))
        for subs, rows in self.routes:
            if all(s in sql for s in subs):
                return _Cur(rows)
        raise AssertionError(f"no route: {sql!r}")

    @contextmanager
    def transaction(self):
        yield

    def commit(self):
        self.committed += 1


def _row(**kw):
    base = dict.fromkeys(store.COLS)
    base.update({"id": 1, "brief": "b", "channel": "facebook",
                 "guardrail": {"ok": True, "violations": []},
                 "status": "pending", "source": "cli",
                 "created_by": "agent:mkt02"})
    base.update(kw)
    return tuple(base[c] for c in store.COLS)


def test_save_draft_default_kwargs_insert_params():
    conn = _Conn([(("insert into content_drafts",), [(5,)]),
                  (("insert into agent_action_log",), []),
                  (("from sku_readiness",), [])])
    store.save_draft(conn, "b", "facebook", "t", {"ok": True},
                     created_by="Lan")
    sql, params = conn.calls[0]
    assert "content_type, sku, is_ai, prompt_version, prompt_sha256" in sql
    assert params[:3] == ("b", "facebook", "t")
    assert params[4:6] == ("manual:studio", "Lan")
    # + khối sở hữu (đợt an toàn S04 — DB kiểm khối khi duyệt draft)
    assert params[6:] == ("post", None, True, None, None, "marketing")
    log = conn.calls[1][1][4].obj
    assert log["content_type"] == "post" and log["sku"] is None
    assert "prompt_version" in log


def test_save_draft_listing_kwargs_and_view_read():
    frame = content.listing("savina-12v", "shopee")
    conn = _Conn([(("from sku_readiness",),
                   [("savina-12v", "shopee", "MO_TA")]),
                  (("insert into content_drafts",), [(6,)]),
                  (("insert into agent_action_log",), [])])
    store.save_draft(conn, "listing", "shopee", frame["text"],
                     frame["guardrail"], "cli", created_by="agent:mkt02",
                     content_type="listing", sku="savina-12v", is_ai=True,
                     prompt_version="listing_shopee@1", prompt_sha256="ab")
    ins = next(c for c in conn.calls if "insert into content_drafts" in c[0])
    assert ins[1][6:] == ("listing", "savina-12v", True,
                          "listing_shopee@1", "ab", "sales")   # + khối (S04)
    assert ins[1][3].obj["ok"] is True, ins[1][3].obj["violations"]
    assert any("from sku_readiness" in c[0] for c in conn.calls)


def test_approve_rechecks_with_row_context(monkeypatch):
    seen = []
    real = guardrail_llm.check_publish_llm

    def spy(text, **kw):
        seen.append(kw)
        return real(text, **kw)

    # gộp M31 đợt 4: store import guardrail_llm LƯỜI (trong _publish_check)
    # — patch thẳng module guardrail_llm (cùng object store gọi lúc chạy).
    monkeypatch.setattr(guardrail_llm, "check_publish_llm", spy)
    frame = content.listing("savina-12v", "shopee")["text"]
    conn = _Conn([(("from content_drafts", "where id = %s"),
                   [_row(channel="shopee", text=frame,
                         content_type="listing", sku="savina-12v")]),
                  (("from sku_readiness",),
                   [("savina-12v", "shopee", "MO_TA")]),
                  (("select approve_draft(",), [(1,)])])
    assert store.set_status(conn, 1, "approved", "Hoa") == (True, None)
    assert seen[-1]["content_type"] == "listing"
    assert seen[-1]["sku"] == "savina-12v" and seen[-1]["is_ai"] is True
    assert seen[-1]["readiness"] == {("savina-12v", "shopee"): "MO_TA"}


def test_approve_ads_row_missing_ad_label_blocked():
    text = (f"Savina 12 viên hỗ trợ giảm ho. {CANON}.\n{AI}")
    view = [("savina-12v", "facebook", "QC_DAY_DU")]

    def conn_for(**kw):
        return _Conn([(("from content_drafts", "where id = %s"),
                       [_row(**{"text": text, **kw})]),
                      (("from sku_readiness",), view),
                      (("select approve_draft(",), [(1,)])])

    # Trước v6.1 (luôn `post`) bài này duyệt được.
    assert store.set_status(conn_for(), 1, "approved", "Hoa") == (True, None)
    c = conn_for(content_type="ads", sku="savina-12v")
    ok, warn = store.set_status(c, 1, "approved", "Hoa")
    assert not ok and "thieu_nhan_quang_cao" in warn
    assert not any("approve_draft(" in s for s, _ in c.calls)
    # Fix nghiệm thu v6.1 (A01): cột is_ai do agent_writer ghi được ->
    # duyệt KHÔNG tin is_ai=False: thiếu nhãn AI vẫn bị chặn (fail-closed
    # như v4.2); có nhãn AI thì duyệt bình thường.
    c = conn_for(text="Quà Tết gia đình.", is_ai=False)
    ok, warn = store.set_status(c, 1, "approved", "Hoa")
    assert not ok and "thieu_nhan_ai" in warn
    assert not any("approve_draft(" in s for s, _ in c.calls)
    c = conn_for(text=f"Quà Tết gia đình.\n{AI}", is_ai=False)
    assert store.set_status(c, 1, "approved", "Hoa") == (True, None)


def test_non_public_content_type_row_cannot_be_approved():
    """Rà OWASP A01: dòng `internal_note` (public false — bỏ luật rượu/
    nhãn) do agent ghi cột content_type -> store chặn config, không duyệt."""
    conn = _Conn([(("from content_drafts", "where id = %s"),
                   [_row(text="Rượu sâm ngâm uống ngon",
                         content_type="internal_note")]),
                  (("select approve_draft(",), [(1,)])])
    ok, warn = store.set_status(conn, 1, "approved", "Hoa")
    assert not ok and "config" in warn
    assert not any("approve_draft(" in s for s, _ in conn.calls)
    ins = _Conn([(("insert into content_drafts",), [(9,)]),
                 (("insert into agent_action_log",), [])])
    store.save_draft(ins, "b", "facebook", "ghi chú", {"ok": True},
                     created_by="agent:x", content_type="internal_note")
    snap = ins.calls[0][1][3].obj
    assert snap["ok"] is False and "config" in _codes(snap)


# ======================= DB thật (schema tạm, ROLLBACK) =====================

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
        schema = f"t_v61_{uuid.uuid4().hex[:12]}"
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
    """commit/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _load_golden(db, honey_ok=True):
    doc = copy.deepcopy(GOLDEN)
    if honey_ok:
        next(s for s in doc["skus"] if s["sku_key"] == "mat-ong-sam-300ml"
             )["self_declaration_ok"] = True
    gs.load(db, doc)


def test_db_listing_columns_unique_index_and_grants(db):
    _load_golden(db, honey_ok=False)
    frame = content.listing("savina-12v", "shopee")
    kw = {"created_by": "agent:mkt02", "content_type": "listing",
          "sku": "savina-12v", "is_ai": True,
          "prompt_version": "listing_shopee@1", "prompt_sha256": "ab"}
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    did = store.save_draft(tx, "listing", "shopee", frame["text"],
                           frame["guardrail"], "cli", **kw)
    row = db.execute("select content_type, sku, is_ai, prompt_version, "
                     "prompt_sha256, status, guardrail->>'ok' from "
                     "content_drafts where id = %s", (did,)).fetchone()
    assert row == ("listing", "savina-12v", True, "listing_shopee@1", "ab",
                   "pending", "true")
    with pytest.raises(psycopg.errors.UniqueViolation):
        store.save_draft(tx, "listing", "shopee", frame["text"],
                         frame["guardrail"], "cli", **kw)
    # Draft `post` cùng sku/kênh không bị index chặn.
    store.save_draft(tx, "b", "shopee", frame["text"], frame["guardrail"],
                     "cli", created_by="agent:mkt02", sku="savina-12v",
                     prompt_version="listing_shopee@1")
    db.execute("reset role")
    db.execute("set local role app_human")
    assert store.set_status(tx, did, "rejected", "Hoa") == (True, None)
    db.execute("reset role")
    db.execute("set local role agent_writer")
    did2 = store.save_draft(tx, "listing", "shopee", frame["text"],
                            frame["guardrail"], "cli", **kw)
    assert did2 != did
    db.execute("reset role")
    # Draft cũ (không truyền cột) tự thành post / is_ai true.
    old = db.execute("insert into content_drafts (brief, channel, text, "
                     "guardrail, source) values ('b','facebook','t','{}',"
                     "'cli') returning content_type, sku, is_ai"
                     ).fetchone()
    assert old == ("post", None, True)


def test_db_batch_idempotent_reject_regenerates(db, monkeypatch):
    _load_golden(db)
    calls = _fake(monkeypatch, _llm_json())
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    skus = list(GOLD)
    r1 = content.listing_batch(tx, skus, list(LISTING_CH), by="agent:mkt02")
    created = [r for r in r1 if r["status"] == "created"]
    assert len(created) == 8, [(r["sku"], r["channel"], r["status"])
                               for r in r1]
    assert {(r["sku"], r["channel"]) for r in created} == \
        {(k, "shopee") for k in _eligible()} | {("mat-ong-sam-300ml",
                                                 "shopee")}
    assert {r["status"] for r in r1} == {"created", "refused"}
    assert len(r1) == len(skus) * 3
    assert len(calls) == 1                      # chỉ mật ong TP_THUONG
    honey = next(r for r in created if r["sku"] == "mat-ong-sam-300ml")
    assert honey["llm_part"] == "used"
    n1 = db.execute("select count(*) from content_drafts").fetchone()[0]

    r2 = content.listing_batch(tx, skus, list(LISTING_CH), by="agent:mkt02")
    assert [r for r in r2 if r["status"] == "created"] == []
    skipped = [r for r in r2 if r["status"] == "skipped"]
    assert len(skipped) == 8 and len(calls) == 1
    assert {r["id"] for r in skipped} == {r["id"] for r in created}
    assert db.execute("select count(*) from content_drafts").fetchone()[0] \
        == n1
    rows = db.execute("select status, content_type, sku, channel, "
                      "prompt_version, is_ai, created_by, source from "
                      "content_drafts order by id").fetchall()
    assert len(rows) == 8
    for st, ct, sku, ch, pv, ai, by, src in rows:
        assert (st, ct, ch, ai, by, src) == ("pending", "listing", "shopee",
                                             True, "agent:mkt02", "cli")
        assert pv == f"listing_{ch}@1" and sku in GOLD
    db.execute("reset role")

    db.execute("set local role app_human")
    victim = created[0]["id"]
    assert store.set_status(tx, victim, "rejected", "Hoa") == (True, None)
    db.execute("reset role")
    db.execute("set local role agent_writer")
    r3 = content.listing_batch(tx, skus, list(LISTING_CH), by="agent:mkt02")
    again = [r for r in r3 if r["status"] == "created"]
    assert len(again) == 1 and again[0]["sku"] == created[0]["sku"]
    # Race: SELECT bỏ sót (batch song song) -> UniqueViolation -> skipped.
    monkeypatch.setattr(content, "_existing",
                        lambda conn, s, c, v, _real=content._existing:
                        None if conn is tx and s == "savina-12v"
                        else _real(conn, s, c, v))
    r4 = content.listing_batch(tx, ["savina-12v"], ["shopee"],
                               by="agent:mkt02")
    assert r4[0]["status"] == "skipped" and r4[0]["id"] is None
    db.execute("reset role")


def test_batch_failed_not_written(monkeypatch):
    """Guardrail không ok (lớp LLM-check cờ) -> failed, KHÔNG gọi
    save_draft."""
    monkeypatch.setenv("GUARDRAIL_LLM_MODEL", "google/gemini-test")
    _fake(monkeypatch, '{"flag": true, "reasons": []}')
    conn = _Conn([(("from content_drafts",), []),
                  (("from sku_readiness",),
                   [("savina-12v", "shopee", "MO_TA")])])
    monkeypatch.setattr(store, "save_draft",
                        lambda *a, **k: pytest.fail("không được ghi"))
    r = content.listing_batch(conn, ["savina-12v"], ["shopee"], by="x")
    assert r[0]["status"] == "failed"
    assert "llm_ngam_y_suc_khoe" in r[0]["codes"]


# ======================= W61.4 CLI ==========================================

def test_cli_usage_errors_exit_2(capsys):
    for argv in (["--sku", "all", "--channel", "shopee"],
                 ["--listing", "--sku", "all", "--channel", "facebook"],
                 ["--listing", "--channel", "shopee"],
                 ["--listing", "--sku", "all"]):
        with pytest.raises(SystemExit) as e:
            content.main(argv)
        assert e.value.code == 2, argv


def test_cli_db_down_exit_2_before_llm(monkeypatch, capsys):
    calls = _fake(monkeypatch, _llm_json())

    @contextmanager
    def dead():
        yield None, "không kết nối được Postgres"

    monkeypatch.setattr(store, "_conn_or_none", dead)
    assert content.main(["--listing", "--sku", "all", "--channel",
                         "shopee"]) == 2
    assert calls == [] and "không ghi được" in capsys.readouterr().err


def test_cli_exit_codes_and_lines(monkeypatch, capsys):
    @contextmanager
    def fake_conn():
        yield object(), None

    monkeypatch.setattr(store, "_conn_or_none", fake_conn)
    items = [{"sku": "a", "channel": "shopee", "status": "created", "id": 1},
             {"sku": "b", "channel": "shopee", "status": "skipped", "id": 2},
             {"sku": "c", "channel": "web", "status": "refused",
              "code": "ruou", "reason": "rượu"}]
    monkeypatch.setattr(content, "listing_batch", lambda *a, **k: items)
    assert content.main(["--listing", "--sku", "a", "--channel",
                         "shopee"]) == 0
    out = capsys.readouterr().out
    assert "a × shopee: created #1" in out
    assert "b × shopee: skipped #2" in out
    assert "c × web: refused ruou: rượu" in out
    assert "created 1, skipped 1, refused 1, failed 0" in out
    items.append({"sku": "d", "channel": "tiktok", "status": "failed",
                  "codes": ["thieu_nhan_ai"]})
    assert content.main(["--listing", "--sku", "a", "--channel",
                         "shopee"]) == 1
    assert "d × tiktok: failed: thieu_nhan_ai" in capsys.readouterr().out


def test_cli_dead_host_subprocess_exit_2():
    """Gotcha v2.0: host chết thật (KHÔNG `env -u`) — exit 2, không gọi LLM
    (key rỗng: nếu lọt tới LLM sẽ lỗi khác, không phải exit 2 sạch)."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", OPENROUTER_API_KEY="",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "pipelines.content",
                        "--listing", "--sku", "all", "--channel", "shopee"],
                       cwd=ROOT, env=env, capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2, (r.stdout, r.stderr)
    assert "không ghi được" in r.stderr and r.stdout == ""


# ======================= W61.6 Studio (grep) ================================

def test_studio_wires_listing_and_guardrail_lines():
    app = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    assert "content_type=" in app and "listing(" in app
    assert "_render_guardrail" in app
    assert "prompt_version=" in app and "sku=" in app
