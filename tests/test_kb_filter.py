"""v3.9 W39.2 — pipelines.kb_filter.is_alcohol(): 0 LLM, NFC+casefold, cụm
có dấu/không dấu, biên từ, fail-closed khi keyword file không dùng được."""
import json
import unicodedata

import pytest

from pipelines import kb_filter


@pytest.fixture(autouse=True)
def _fresh_cache():
    kb_filter.reset_cache()
    yield
    kb_filter.reset_cache()


HITS = [
    "Rượu Sâm Ngọc Linh No. 9",
    "RƯỢU SAMSAM No.5",
    "Ru\u031bo\u031b\u0323u sâm",  # NFD (escape) — ascii "ruou" vẫn bắt
    # NFD của cụm CHỈ có dạng có dấu (bản bỏ dấu "nong do con" không bị
    # keyword nào bắt) -> bỏ normalize NFC thì case này đỏ.
    unicodedata.normalize("NFD", "nồng độ cồn 40"),
    unicodedata.normalize("NFD", "Sâm Sâm có bán đồ uống có cồn không?"),
    "ruou sam",
    "Ngoc Linh Ginseng Wine No. 7",
    "nồng độ cồn 27,5%",
    "40% vol",
    "sâm ngâm  rượu lâu năm",  # khoảng trắng kép trong cụm
    "SAMSAM No. 7 hảo hạng",
    "premium ginseng LIQUOR",
    # Nghiệm thu v3.9: cách nói rượu tiếng Anh/"có cồn" từng lọt (wp-1844).
    "Does Sam Sam sell alcohol?",
    "Do you sell alcoholic drinks?",
    "Exploring Alcoholic Beverages Derived from Ngoc Linh Ginseng",
    "health food supplements and alcoholic beverages",
    "Sâm Sâm có bán đồ uống có cồn không?",
    "Saphraton có cồn không",
    "ginseng spirits",
    "Ngoc Linh ginseng vodka",
    "ginseng whisky",
    "korean soju",
]
MISSES = [
    "có còn hàng không?",  # "còn" (still) khác "cồn" (alcohol)
    "a national past, and a modern spirit",  # spirit đơn lẻ không phải rượu
    "healthier than forest spirits",  # truyền thuyết wp-1842 — không chặn
    "the spirit of innovation",
    "đó còn",
    "độ cao 1.500m",
    "Hồ Chí Minh",
    "Saphraton 20 viên",
    "swine",
    "winery",
    "intertwined",
    "Savina giá bao nhiêu?",
    "",
]


@pytest.mark.parametrize("text", HITS)
def test_hits(text):
    assert kb_filter.is_alcohol(text) is True


@pytest.mark.parametrize("text", MISSES)
def test_misses(text):
    assert kb_filter.is_alcohol(text) is False


def test_non_str_is_false():
    assert kb_filter.is_alcohol(None) is False
    assert kb_filter.is_alcohol(123) is False


def test_golden_alcohol_sku_names_hit():
    data = json.loads(kb_filter.GOLDEN_FILE.read_text(encoding="utf-8"))
    names = [s["name"] for s in data["skus"] if s.get("category") == "alcohol"]
    assert len(names) >= 2
    for n in names:
        assert kb_filter.is_alcohol(n), n
    # SKU không phải rượu thì không trúng.
    others = [s["name"] for s in data["skus"] if s.get("category") != "alcohol"]
    assert others and not any(kb_filter.is_alcohol(n) for n in others)


def test_golden_name_used_without_keyword(tmp_path, monkeypatch):
    """Tên SKU alcohol golden là nguồn cụm thật (không chỉ nhờ 'rượu')."""
    kw = tmp_path / "kw.txt"
    kw.write_text("# CHỜ PHÁP CHẾ DUYỆT\nliquor\n", encoding="utf-8")
    golden = tmp_path / "g.json"
    golden.write_text(json.dumps({"skus": [
        {"name": "Tinh Chất Đặc Biệt X", "category": "alcohol"},
        {"name": "Mật ong", "category": "food"}]}, ensure_ascii=False),
        encoding="utf-8")
    monkeypatch.setattr(kb_filter, "KEYWORDS_FILE", kw)
    monkeypatch.setattr(kb_filter, "GOLDEN_FILE", golden)
    assert kb_filter.is_alcohol("mua tinh chất đặc biệt x ở đâu")
    assert not kb_filter.is_alcohol("mật ong")


@pytest.mark.parametrize("content", [None, b"", b"# chi comment\n\n   \n# CHO\n"])
def test_fail_closed_keyword_file(tmp_path, monkeypatch, content):
    kw = tmp_path / "ruou_keywords.txt"
    if content is not None:
        kw.write_bytes(content)
    monkeypatch.setattr(kb_filter, "KEYWORDS_FILE", kw)
    with pytest.raises(kb_filter.KbFilterError):
        kb_filter.is_alcohol("Rượu sâm")
    # Non-str cũng không "lọt" qua khi file hỏng (fail-closed trước).
    with pytest.raises(kb_filter.KbFilterError):
        kb_filter.is_alcohol(None)


@pytest.mark.parametrize("golden", [None, b"{not json", b'{"skus": 5}'])
def test_golden_missing_or_broken_uses_keywords_only(tmp_path, monkeypatch,
                                                     capsys, golden):
    g = tmp_path / "golden.json"
    if golden is not None:
        g.write_bytes(golden)
    monkeypatch.setattr(kb_filter, "GOLDEN_FILE", g)
    assert kb_filter.is_alcohol("Rượu sâm")
    assert not kb_filter.is_alcohol("Saphraton")
    assert "golden_skus.json" in capsys.readouterr().out


def test_keyword_file_header_pending_legal():
    head = kb_filter.KEYWORDS_FILE.read_text(encoding="utf-8").split("\n")[0]
    assert "CHỜ PHÁP CHẾ DUYỆT" in head
