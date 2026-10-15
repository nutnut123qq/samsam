"""Tests cho pipelines.guardrail.check — gate T3.1."""

import pytest

import pipelines.guardrail as g


def test_banned_word_case_bat_buoc():
    """Case chắc chắn phải chặn theo TASKS.md."""
    r = g.check("Saphraton chữa khỏi tiểu đường cho người bệnh")
    assert not r["ok"]
    assert any(v["type"] == "banned_word" for v in r["violations"])


def test_banned_word_khong_dau():
    """Viết trần để lách cũng bị chặn."""
    r = g.check("san pham nay chua khoi benh, dieu tri rat tot")
    assert not r["ok"]
    assert any(v["type"] == "banned_word" for v in r["violations"])


def test_thuoc_khong_bat_nham_thuoc_belong():
    """'thuộc' (belong) không được flag nhầm thành 'thuốc'."""
    r = g.check("Sản phẩm thuộc dòng thực phẩm bảo vệ sức khỏe của Sâm Sâm")
    assert all("thuốc" not in v["detail"] for v in r["violations"])


def test_approved_claim_pass_sach():
    """Claim đúng ĐKSP đi qua, kể cả khi chứa cụm trùng banned list
    ('hỗ trợ hạ đường huyết' ⊃ 'hạ đường huyết')."""
    r = g.check("Sapentol hỗ trợ hạ đường huyết, giảm mỡ máu cho người lớn.")
    assert r["ok"], r["violations"]
    assert any(m["sku"] == "sapentol" for m in r["matched_claims"])


def test_unverified_claim_flagged():
    r = g.check("Savina giúp tăng cường trí nhớ và làm đẹp da.")
    assert not r["ok"]
    assert any(v["type"] == "unverified_claim" for v in r["violations"])


def test_wrong_sku_claim_flagged():
    """Claim của Savigout gán cho Sapentol -> vẫn vi phạm (pool theo SKU
    được nhắc)."""
    r = g.check("Sapentol giúp giảm acid uric trong máu.")
    assert not r["ok"]
    assert any(v["type"] == "unverified_claim" for v in r["violations"])


def test_disclaimer_phat_ly_pass():
    """Câu disclaimer bắt buộc 'không phải là thuốc...' chứa từ cấm theo
    nghĩa phủ định — không được flag."""
    r = g.check("Sapentol hỗ trợ hạ đường huyết. Lưu ý: sản phẩm này không "
                "phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh.")
    assert r["ok"], r["violations"]


def test_thuoc_claim_van_chan():
    """Nói sản phẩm LÀ thuốc (khẳng định) thì vẫn chặn — chỉ disclaimer
    phủ định mới được miễn."""
    r = g.check("Sapentol là thuốc đặc trị tiểu đường hiệu quả nhất")
    assert not r["ok"]
    assert any(v["type"] == "banned_word" for v in r["violations"])


def test_compound_clause_escape_1():
    """Regression: 'giúp [claim đúng] VÀ [claim bịa]' — phần sau dấu 'và'
    không được thoát check nhờ phần trước đã khớp."""
    r = g.check("Savina giúp giảm ho và làm đẹp da cho phụ nữ.")
    assert not r["ok"]
    assert any(v["type"] == "unverified_claim" for v in r["violations"])


def test_compound_clause_escape_2():
    """Regression: claim whitelist đi trước 'và' không cứu được claim
    bịa đi sau."""
    r = g.check("Sapentol hỗ trợ hạ đường huyết và giúp tăng cường trí nhớ.")
    assert not r["ok"]
    assert any(v["type"] == "unverified_claim" for v in r["violations"])


def test_empty_text_ok():
    assert g.check("")["ok"]
    assert g.check("   \n  ")["ok"]


def test_missing_config(monkeypatch, tmp_path):
    monkeypatch.setattr(g, "DATA_DIR", tmp_path)
    g._load_config.cache_clear()
    try:
        r = g.check("bất kỳ text nào")
        assert not r["ok"]
        assert r["violations"][0]["type"] == "config"
    finally:
        g._load_config.cache_clear()


# --- v3.0-guardrail-hotfix: SAFE_PHRASES chỉ miễn disclaimer PHỦ ĐỊNH ---
# Mục trần "thay thế thuốc chữa bệnh" từng miễn luôn câu khẳng định
# (probe 2026-10-11: 7 câu dưới đây ok=True, 0 violation).
AFFIRMATIVE_THAY_THE_THUOC = [
    "Dạ An Sâm có thể thay thế thuốc chữa bệnh mất ngủ.",
    "Da An Sam co the thay the thuoc chua benh mat ngu.",
    "Sản phẩm dùng để thay thế thuốc chữa bệnh.",
    "Uống sâm là đủ, thay thế thuốc chữa bệnh hoàn toàn.",
    ("Sản phẩm không thay thế thuốc được thì sao, nó thay thế thuốc chữa "
     "bệnh tốt."),
    "Không ai nói nó không phải là thuốc, nó thay thế thuốc chữa bệnh.",
    "Ai bảo sản phẩm không thay thế thuốc? Nó thay thế được.",
    "Sản phẩm giúp thay thế thuốc chữa bệnh.",
    "Sản phẩm thay thuốc hiệu quả.",
    "Dùng sâm thì không cần uống thuốc nữa.",
    "Sản phẩm không chỉ thay thế thuốc chữa bệnh mà còn bồi bổ.",
    "Sâm không phải là thuốc nhưng còn tốt hơn thuốc.",
    "Chẳng lẽ sản phẩm không phải là thuốc?",
    "Khong ai bao san pham khong phai la thuoc.",
    # nhánh '?' đứng RIÊNG (không kèm cụm đảo nghĩa) — chốt rule câu hỏi
    "Sản phẩm không thay thế thuốc?",
    "San pham khong phai la thuoc?",
    # nhánh cụm đảo nghĩa CÓ DẤU, không '?' — chốt flip có dấu riêng
    "Ai bảo sản phẩm không phải là thuốc.",
    "Đâu phải sản phẩm không thay thế thuốc.",
]

DISCLAIMER_VARIANTS = [
    # nguyên văn pipelines/content.py (prompt disclaimer bắt buộc)
    ("Sản phẩm không phải là thuốc và không có tác dụng thay thế thuốc "
     "chữa bệnh."),
    ("Thực phẩm này không phải là thuốc và không có tác dụng thay thế "
     "thuốc chữa bệnh."),
    ("Thuc pham nay khong phai la thuoc va khong co tac dung thay the "
     "thuoc chua benh."),
    "Sản phẩm không thay thế thuốc chữa bệnh.",
    "Lưu ý: sản phẩm không phải là thuốc.",
    # disclaimer đứng GIỮA đoạn dài, kèm claim whitelist Sapentol
    ("Sâm Sâm mang đặc sản núi Ngọc Linh tới mọi nhà. Sapentol hỗ trợ hạ "
     "đường huyết. Sản phẩm không phải là thuốc và không có tác dụng thay "
     "thế thuốc chữa bệnh. Món quà ý nghĩa cho gia đình dịp Tết."),
    # cụm đảo nghĩa ở clause KHÁC / đứng SAU disclaimer không làm mất miễn
    "Không ai muốn mệt mỏi, sản phẩm không phải là thuốc.",
    "Sản phẩm không phải là thuốc và không ai phủ nhận điều đó.",
]


@pytest.mark.parametrize("text", AFFIRMATIVE_THAY_THE_THUOC)
def test_affirmative_thay_the_thuoc_flagged(text):
    """Câu KHẲNG ĐỊNH (hoặc phủ định kép/tu từ) chứa cụm 'thay thế thuốc'
    không được ăn ké miễn trừ của disclaimer."""
    r = g.check(text)
    assert not r["ok"]
    assert r["violations"]


@pytest.mark.parametrize("text", DISCLAIMER_VARIANTS)
def test_disclaimer_variants_pass(text):
    """Disclaimer phủ định đúng dạng vẫn pass — có dấu, không dấu, đứng
    giữa đoạn dài."""
    r = g.check(text)
    assert r["ok"], r["violations"]


def test_safe_phrases_all_negated():
    """Mọi mục miễn trừ phải mở đầu bằng phủ định — chặn tái phát mục trần."""
    assert g.SAFE_PHRASES
    assert all(p.startswith("không ") for p in g.SAFE_PHRASES)
    assert "không có tác dụng thay thế thuốc chữa bệnh" in g.SAFE_PHRASES
