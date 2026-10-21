"""Đợt hợp đồng G2 — luật cục bộ `ngam_y_suc_khoe` (claim sức khỏe NGẦM
không động từ claim): 3 known_gap red-team cũ + biến thể (không dấu, trộn
dấu, ký tự vô hình, homoglyph, chữ cách, tách câu) và ca âm tính câu bán
hàng/khuyến cáo bình thường. Ký tự vô hình/homoglyph viết escape."""

import pytest

from pipelines import guardrail as g

AI = " Nội dung có sử dụng AI."
CODE = "ngam_y_suc_khoe"


def _codes(text, **kw):
    kw.setdefault("channel", "facebook")
    return [v["code"] for v in g.check_publish(text, **kw)["violations"]]


@pytest.mark.parametrize("text", [
    # 3 ca gốc (rt-ay-02, rt-ay-03, rt-llm-05)
    "Món quà dành cho người hay mệt mỏi, ngủ không sâu giấc.",
    "Người bị gout dùng Sâm Sâm thấy khác hẳn sau 2 tuần.",
    ("Savina cho người mong muốn kiểm soát đường huyết. Thực phẩm này không "
     "phải là thuốc và không có tác dụng thay thế thuốc chữa bệnh."),
    # không dấu / trộn dấu
    "Mon qua danh cho nguoi hay met moi, ngu khong sau giac.",
    "Người bi gout dùng Sâm Sâm thay khác hẳn.",
    "NGƯỜI BỊ GOUT nên thử.",
    # ký tự vô hình giữa từ / trong từ / cả hai, soft hyphen
    "Người\u200bbị\u200bgout nên thử Sâm Sâm.",
    "Ng\u200bười bị g.o.u.t nên thử.",
    "Ng\u200bười\u200bbị gout nên thử.",
    "Người\u00adbị tiểu\u00adđường yên tâm.",
    # homoglyph Cyrillic, chữ cách
    "Ngườ\u0456 bị g\u043eut nên thử.",
    "Người bị g o u t nên thử.",
    # diễn đạt tương đương
    "Ai cũng mong muốn ổn định huyết áp.",
    "Quà cho người làm văn phòng hay mất ngủ.",
    "Người tiểu đường yên tâm dùng.",
    "Dành cho người có vấn đề về xương khớp.",
    "Bố mẹ đang bị cao huyết áp sẽ thích.",
    "Khách hàng thường xuyên mệt mỏi nên thử.",
    # tách câu khuyến cáo + lời chứng kết quả
    "Người bị gout nên hỏi ý kiến bác sĩ; dùng Sâm Sâm thấy khác hẳn.",
    "Uống đều 1 tháng thấy rõ khỏe hơn.",
])
def test_implied_health_blocked(text):
    codes = _codes(text + AI)
    assert CODE in codes, text
    r = g.check_publish(text + AI, channel="facebook")
    assert r["ok"] is False


@pytest.mark.parametrize("text", [
    "Sâm Sâm — món quà Tết ý nghĩa cho người thân.",
    "Không dùng cho người bị gout.",
    "Người bị gout không nên dùng sản phẩm này.",
    "Người đang mắc bệnh mãn tính nên hỏi ý kiến bác sĩ trước khi dùng.",
    "Thận trọng khi dùng cho người huyết áp cao.",
    "Ai tìm quà biếu sếp thì ghé Sâm Sâm nhé.",
    "Người ôm hoa, người cầm quà — Tết sum vầy.",
    "Dùng thử thấy ngon, đóng gói đẹp.",
    "Sau những ngày làm việc mệt mỏi, cả nhà quây quần bên tách trà.",
    "Người yêu và gia đình đều thích.",
    "Bạn bè gần xa ghé cửa hàng nhé.",
    "Khách hàng có thể đặt qua Zalo hoặc Shopee.",
    "Sâm\u200bSâm — quà Tết cho người thân, ai cũng thích.",
    "Khách\u00adhàng ăn thử thấy ngon.",
    "Giao hàng toàn quốc, khách ở gần được giao trong ngày.",
])
def test_normal_sales_text_not_flagged(text):
    assert CODE not in _codes(text + AI), text


def test_chat_mode_unchanged():
    # Chatbot (check()) không áp luật đăng bài — giữ hành vi chat cũ.
    r = g.check("Người bị gout nên hỏi ý kiến bác sĩ.")
    assert CODE not in [v["code"] for v in r["violations"]]


def test_internal_note_not_public():
    assert CODE not in _codes("Người bị gout hỏi giá.",
                              content_type="internal_note")


def test_implied_counts_as_claim_for_xnqc():
    # Claim ngầm trên SKU TPBVSK chưa XNQC -> thêm sku_chua_xnqc (critical).
    codes = _codes("Savina cho người tiểu đường. Thực phẩm này không phải là"
                   " thuốc và không có tác dụng thay thế thuốc chữa bệnh." + AI)
    assert CODE in codes and "sku_chua_xnqc" in codes


def test_rule_in_rules_file_major_block():
    cfg, err = g._load_rules(g.DATA_DIR)
    assert err is None
    r = cfg["rules"][CODE]
    assert (r["severity"], r["mode"]) == ("major", "block")


def test_pathological_input_fast():
    # Regex bị chặn độ dài (gap {0,3}, cửa sổ 60) — chuỗi dài không treo.
    import time
    t = time.perf_counter()
    g.check_publish("người " * 4000 + "ai bị " * 2000 + AI, channel="facebook")
    assert time.perf_counter() - t < 20


# Vá controller 20/10/2026: ngoại lệ hình thức `Hỏi: …?` (livestream) từng
# cho claim ngầm đi qua (ok=True, 0 violation). FLIP có lý do: không còn miễn
# theo hình thức; câu hỏi sức khỏe của khách do kd_live thay dòng trung tính.
CONTROLLER = ("Hỏi: Món quà dành cho người hay mệt mỏi, ngủ không sâu giấc?\n"
              "#quangcao Nội dung có sử dụng AI.")


@pytest.mark.parametrize("text", [
    CONTROLLER,
    CONTROLLER.replace("Hỏi:", "Hoi:").replace("người hay mệt mỏi",
                                                 "nguoi hay met moi"),
    CONTROLLER.upper(),
    CONTROLLER.replace("Hỏi: ", "Hỏi:\n"),
    CONTROLLER.replace("người hay", "người\u200bhay"),
    ("[Hỏi đáp bình luận]\nHỏi: Người bị tiểu đường dùng được không?\n"
     "Đáp: Dạ có ạ.\n#quangcao Nội dung có sử dụng AI."),
    ("Hỏi: Bạn hay mất ngủ?\nĐáp: Thử Sâm Sâm nhé.\n#quangcao Nội dung có"
     " sử dụng AI."),
    ("Hỏi: Giao Hà Nội không?\nĐáp: Người bị gout dùng thấy khác hẳn ạ.\n"
     "#quangcao Nội dung có sử dụng AI."),
])
def test_livestream_question_form_not_exempt(text):
    r = g.check_publish(text, channel="tiktok",
                        content_type="livestream_script")
    assert r["ok"] is False and CODE in [v["code"] for v in r["violations"]]


def test_livestream_neutral_health_line_passes():
    from agents import kd_live
    text = ("[Hỏi đáp bình luận]\nHỏi: Shop có giao Hà Nội không?\n"
            "Đáp: Dạ giao toàn quốc ạ.\nHỏi: " + kd_live.HEALTH_Q + "\n"
            "Đáp: " + kd_live.health_template() + "\n#quangcao Nội dung có sử"
            " dụng AI.")
    assert CODE not in _codes(text, channel="tiktok",
                              content_type="livestream_script")
