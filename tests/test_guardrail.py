"""Tests cho pipelines.guardrail.check — gate T3.1."""

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
