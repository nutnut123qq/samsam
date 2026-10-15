"""v14.1 (p1) — PII tên không theo mẫu, convlog che bằng `scrub_user`, tab
Chat Streamlit bắt `GatewayBlocked`, sức khỏe đơn âm tiết theo ngữ cảnh,
red-team khép thêm ca known_gap bằng LUẬT.

Mỗi nhóm tái hiện đúng hở còn lại của board "Còn mở (16/10/2026)" mục A
v14.1 và FAIL trên code trước vá (v14-hop-dong a71bab5). Fake provider ghi
payload — không gọi mạng, không DB.
"""

import json
import runpy
import sys
import time
import types
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from api import rag
from connectors import zalo
from pipelines import guardrail as g
from pipelines import llm_gateway as gw
from pipelines import pii

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import redteam


class Fake:
    """Client giả: ghi MỌI payload chat/embed gửi ra provider."""

    def __init__(self):
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(
            create=self._chat))
        self.embeddings = SimpleNamespace(create=self._embed)

    def _chat(self, **kw):
        self.calls.append(("chat", kw))
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(
            message=SimpleNamespace(content="Saphraton: 1.000.000 đ"))])

    def _embed(self, **kw):
        self.calls.append(("embed", kw))
        return SimpleNamespace(usage=None,
                               data=[SimpleNamespace(embedding=[1.0, 0.0])])

    def user_payload(self) -> str:
        out = []
        for kind, kw in self.calls:
            if kind == "embed":
                out.append(json.dumps(kw["input"], ensure_ascii=False))
            else:
                out += [m["content"] for m in kw["messages"]
                        if m.get("role") == "user"]
        return "\n".join(out)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    cfg = {"provider_only": ["azure"],
           "prices_usd_per_1m": {"m": {"in": 1.0, "out": 2.0}},
           "monthly_cap_usd": {"default": 10.0, "chatbot": 1.0},
           "kill": [], "pii_allow": []}
    p = tmp_path / "llm_gateway.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", p)
    f = Fake()
    monkeypatch.setattr(gw, "_client", lambda: f)
    monkeypatch.setattr(rag, "retrieve_by_vector", lambda *a, **k: [
        {"score": 0.9, "url": "http://x/p", "title": "Saphraton",
         "content": "Saphraton — 1.000.000 đ", "doc_id": "p1",
         "lang": "vi"}])
    return f


# ---------------- PII: tên không theo mẫu (từ điển) ----------------

NAME_CASES = [
    ("giao Bích nhé", ("Bích",)),
    ("chị Hoa đặt 2 hộp", ("Hoa",)),
    ("nguyen thi hoa dat 2 hop", ("hoa",)),
    ("giao cho hoa ở Hải Châu", ("hoa ",)),
    ("Âu Bích đặt hộp 6 năm", ("Bích", "Âu")),
    ("Họ Âu tên Hoa, gửi giúp", ("Âu", "Hoa")),
    ("Gửi Mai Anh ở Hải Châu nhé", ("Mai Anh",)),
    ("Cho Phương 1 hộp quà Tết", ("Phương",)),
    ("Ship cho bé Na hộp nhỏ", ("Na ",)),
    ("nguyen minh anh mua 2 hop", ("minh anh",)),
    ("tên là lan, giao giúp", ("lan",)),
    ("nhận hàng: Quỳnh", ("Quỳnh",)),
    ("Tặng Quỳnh hộp 6 năm", ("Quỳnh",)),
    ("GIAO BÍCH TRƯỚC TẾT", ("BÍCH",)),
    ("giao Bich nhe shop", ("Bich",)),
]


@pytest.mark.parametrize("q,leaks", NAME_CASES)
def test_rag_dict_names_never_reach_provider(fake, q, leaks):
    """Câu có tên không theo mẫu xưng danh đi qua rag.answer: payload ra
    ngoài (embed + chat lượt user) không còn tên."""
    rag.answer(q)
    sent = fake.user_payload()
    for leak in leaks:
        assert leak not in sent, (q, leak, sent)


@pytest.mark.parametrize("q,leaks", NAME_CASES)
def test_scrub_user_masks_dict_names(q, leaks):
    out, _risky = pii.scrub_user(q)
    assert "***" in out, (q, out)
    for leak in leaks:
        assert leak not in out, (q, leak, out)


SALES_NEGATIVE = [
    "Hà Nội", "Hồ Chí Minh", "quà Tết", "sâm Ngọc Linh", "hộp 6 năm",
    "Sâm Ngọc Linh 6 năm tuổi giá bao nhiêu",
    "Giao Bình Dương bao lâu", "Giao Đà Nẵng nhé", "giao Hội An được không",
    "giao Quảng Nam mấy ngày", "Ship Hải Phòng", "Giao Tam Kỳ được không",
    "giao Kim Long", "gửi Thanh Hóa", "Giao Long An", "giao Phú Quốc",
    "Ship về Thủ Đức", "giao Sài Gòn", "Giao Vũng Tàu",
    "Từ Hà Nội giao vào Đà Nẵng mấy ngày",
    "Cho mình hỏi giá", "Cho em 2 hộp", "Cho tôi hỏi", "cho hỏi phí ship",
    "Tặng Mẹ hộp sâm", "Tặng Sếp hộp nào", "Tặng ba mẹ",
    "Mua tặng Phụ Nữ 20/10", "Có hộp quà tặng Trung Thu không",
    "Hộp quà Tết Bính Ngọ", "Hồng Sâm Hàn Quốc khác gì",
    "Kim Long có đại lý không", "Shop có hoa sâm không",
    "giao cho em nhé", "giao cho anh trước 5h", "giao cho mẹ em",
    "giao cho kịp Tết nhé", "giao cho nhanh nha shop", "gui cho ba toi",
    "gửi cho shop ảnh", "Ship cho chị nhé", "tên sản phẩm là gì",
    "tên shop là gì", "Cho Thanh toán khi nhận hàng được không",
    "Giao Hàng Tiết Kiệm hay Giao Hàng Nhanh", "Saphraton giá sao",
    "Chính sách đổi trả ra sao", "Đơn của chị giao chưa",
    "Mình ở Đà Nẵng", "Hộp Sâm Cao Cấp", "nguyen lieu la gi",
    "Lễ vẫn mở cửa không shop", "do vận chuyển xa nên phí bao nhiêu",
]


@pytest.mark.parametrize("q", SALES_NEGATIVE)
def test_scrub_user_sales_negatives_untouched(q):
    """Địa danh / tên SP / từ thường / câu bán hàng: không che, không
    chuyển người."""
    assert pii.scrub_user(q) == (q, False)


def test_names_dict_missing_fail_closed(fake, monkeypatch, tmp_path):
    """Thiếu/hỏng từ điển tên -> không biết che tên -> mọi câu có chữ coi
    là còn dấu hiệu PII: rag chuyển người, 0 lời gọi AI."""
    monkeypatch.setattr(pii, "NAMES_FILE", tmp_path / "khong_co.json")
    pii._names.cache_clear()
    try:
        assert pii.scrub_user("Saphraton giá sao")[1] is True
        r = rag.answer("Saphraton giá sao")
        assert r["handoff"] == "pii" and fake.calls == []
        (tmp_path / "hong.json").write_text('{"ho": []}', encoding="utf-8")
        monkeypatch.setattr(pii, "NAMES_FILE", tmp_path / "hong.json")
        pii._names.cache_clear()
        assert pii.scrub_user("Saphraton giá sao")[1] is True
    finally:
        monkeypatch.undo()
        pii._names.cache_clear()
    assert pii.scrub_user("Saphraton giá sao") == ("Saphraton giá sao",
                                                   False)


def test_names_dict_shape():
    doc = json.loads((ROOT / "data" / "vn_names.json")
                     .read_text(encoding="utf-8"))
    assert doc["status"] == "gia_dinh"
    for k in ("ho", "ho_ro", "dem", "ten", "khong_phai_ten", "dia_danh"):
        assert doc[k] and all(isinstance(w, str) and w == w.lower()
                              for w in doc[k]), k
    assert set(doc["ho_ro"]) <= set(doc["ho"])


# ---- v14 vá review (MINOR): từ điển so sai cách, không phải thiếu tên ----
# Probe review: 5 câu dưới lọt nguyên tên tới payload embed/chat với
# handoff=None trên code v14.1 (kiểu dấu cũ, tên gõ thường sau tự giới
# thiệu, họ Viết Hoa + đệm gõ thường, họ "Bế").
REVIEW_NAME_CASES = [
    ("giao Thuỳ 2 hộp Saphraton", ("Thuỳ",)),
    ("gửi Hoà 1 hộp", ("Hoà",)),
    ("gửi Thuý ở Hải Châu", ("Thuý",)),
    ("tôi là tuấn, giao 2 hộp Saphraton", ("là tuấn",)),
    ("em là ngọc", ("là ngọc",)),
    ("tôi là tuan", ("tuan",)),
    ("đặt cho mẹ tôi Trần thị Bé 1 hộp", ("Trần", "Bé")),
    ("Bế Văn Đàn đặt 1 hộp", ("Bế", "Đàn")),
]
REVIEW_NEGATIVE = [
    "tôi là khách quen", "em là sinh viên", "mình là chủ shop",
    "tôi là người Quảng Nam", "quý khách cần gì", "hoà vốn không shop",
    "Thuỷ tinh hay hộp gỗ", "khoẻ không shop", "em là khách mới",
    "Bé nhà mình dùng được không",
]


@pytest.mark.parametrize("q,leaks", REVIEW_NAME_CASES)
def test_review_names_masked(q, leaks):
    out, _risky = pii.scrub_user(q)
    assert "***" in out, (q, out)
    for leak in leaks:
        assert leak not in out, (q, leak, out)


@pytest.mark.parametrize("q,leaks", REVIEW_NAME_CASES)
def test_review_names_never_reach_provider(fake, q, leaks):
    rag.answer(q)
    sent = fake.user_payload()
    assert sent, q
    for leak in leaks:
        assert leak not in sent, (q, leak, sent)


@pytest.mark.parametrize("q", REVIEW_NEGATIVE)
def test_review_negatives_untouched(q):
    assert pii.scrub_user(q) == (q, False)


def test_tone_placement_fold_both_sides(monkeypatch, tmp_path):
    """Từ điển ghi kiểu dấu CŨ ("hoà") vẫn bắt khách gõ kiểu mới ("Hòa") và
    ngược lại; "quý" (q + uy) không bị đổi."""
    assert pii._tone("hoà") == pii._tone("hòa") == "hòa"
    assert pii._tone("thuỷ") == "thủy" and pii._tone("quý") == "quý"
    assert pii._tone("hoàng") == "hoàng"
    doc = json.loads((ROOT / "data" / "vn_names.json")
                     .read_text(encoding="utf-8"))
    doc["ten"] = [w for w in doc["ten"] if w not in ("hòa",)] + ["hoà"]
    p = tmp_path / "names.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(pii, "NAMES_FILE", p)
    pii._names.cache_clear()
    try:
        assert pii.scrub_user("giao Hòa 1 hộp")[0] == "giao *** 1 hộp"
        assert pii.scrub_user("giao Hoà 1 hộp")[0] == "giao *** 1 hộp"
    finally:
        monkeypatch.undo()
        pii._names.cache_clear()


# ---------------- convlog Zalo/Messenger/Streamlit ----------------

@pytest.fixture
def zlog(monkeypatch, tmp_path):
    log = tmp_path / "conversations.jsonl"
    monkeypatch.setattr(zalo, "CONV_LOG", log)
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "seen.db")
    monkeypatch.setattr(zalo, "_histories", type(zalo._histories)())
    monkeypatch.delenv("CHANNEL_HASH_SALT", raising=False)

    def rows():
        return [json.loads(x) for x in log.read_text(
            encoding="utf-8").split("\n") if x.strip()]
    return rows


def _ans(answer="Saphraton giá 1.000.000 đ", sources=("http://x/p",)):
    return lambda *a, **k: {"answer": answer, "sources": list(sources)}


@pytest.mark.parametrize("channel", ["zalo", "messenger"])
def test_convlog_question_scrubbed_answer_path(zlog, monkeypatch, channel):
    """Nhánh trả lời thường: convlog ghi câu khách qua `scrub_user` (tên +
    địa chỉ), không chỉ SĐT/email; format record giữ nguyên."""
    monkeypatch.setattr(rag, "answer", _ans())
    q = "giao Bích ở 34 Lê Lợi nhé, sđt 0901234567"
    zalo.handle_text("u1", q, "m1", channel=channel,
                     send=lambda u, t: True)
    (row,) = zlog()
    for leak in ("Bích", "Lê Lợi", "0901234567"):
        assert leak not in row["question"], row["question"]
    assert row["question"] == pii.scrub_user(q)[0]
    assert {"ts", "msg_id", "user_hash", "question", "answer", "sources",
            "guardrail_ok", "answered", "sent", "channel"} <= set(row)
    assert row["channel"] == channel


def test_convlog_question_scrubbed_gateway_blocked(zlog, monkeypatch):
    def boom(*a, **k):
        raise gw.GatewayBlocked("trần 0")
    monkeypatch.setattr(rag, "answer", boom)
    zalo.handle_text("u2", "chị Hoa hỏi Saphraton giá sao", "m2",
                     send=lambda u, t: True)
    (row,) = zlog()
    assert "Hoa" not in row["question"] and row["answered"] is False


def test_convlog_question_scrubbed_fixed_route(zlog, monkeypatch):
    """Nhánh template cố định (sức khỏe/rượu — 0 lời gọi answer) cũng che
    tên trong convlog."""
    monkeypatch.setattr(rag, "answer", lambda *a, **k: pytest.fail("AI"))
    zalo.handle_text("u3", "chị Hoa bị tiểu đường dùng được không", "m3",
                     send=lambda u, t: True)
    (row,) = zlog()
    assert row.get("route") and "Hoa" not in row["question"]


def test_convlog_reader_reads_scrubbed_record(zlog, monkeypatch):
    """Reader cũ (`unanswered`) vẫn đọc record mới — chỉ giá trị chuỗi đổi."""
    monkeypatch.setattr(rag, "answer", _ans(answer=rag.NO_DATA, sources=()))
    zalo.handle_text("u4", "giao Bích 2 hộp", "m4", send=lambda u, t: True)
    got = [r["question"] for r in zalo.unanswered()]
    assert got and "Bích" not in got[-1]


# ---------------- Streamlit tab Chat: GatewayBlocked ----------------

class _SS(dict):
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError as e:
            raise AttributeError(k) from e

    def __setattr__(self, k, v):
        self[k] = v


def _fake_streamlit(q, shown):
    st = types.ModuleType("streamlit")

    @contextmanager
    def ctx(*a, **k):
        yield

    def noop(*a, **k):
        return None

    st.session_state = _SS()
    st.sidebar = ctx()
    st.set_page_config = st.caption = st.warning = st.markdown = noop
    st.error = st.info = st.success = noop
    st.button = lambda *a, **k: False
    st.tabs = lambda names: [ctx() for _ in names]
    st.chat_message = st.spinner = ctx
    st.chat_input = lambda *a, **k: q
    st.write = lambda x, *a, **k: shown.append(x)

    def stop():
        raise RuntimeError("st.stop")
    st.stop = stop
    return st


def test_streamlit_chat_gateway_blocked_handoff_no_crash(monkeypatch,
                                                         tmp_path):
    """Tab Chat: answer() raise GatewayBlocked (trần 0/vượt trần/không đọc
    được chi tiêu) -> hiện câu chuyển nhân viên, ghi convlog (câu đã che),
    không crash, không vào history."""
    from pipelines import auth
    shown, logged = [], []
    st = _fake_streamlit("chị Hoa hỏi Saphraton giá sao", shown)
    monkeypatch.setitem(sys.modules, "streamlit", st)
    monkeypatch.setattr(auth, "auth_mode", lambda: "dev")
    monkeypatch.setattr(auth, "tabs_for", lambda role: ("Chat Sâm Sâm",))

    def blocked(*a, **k):
        raise gw.GatewayBlocked("agent 'chatbot' có trần 0 USD")
    monkeypatch.setattr(rag, "answer", blocked)
    monkeypatch.setattr(zalo, "_log_conversation", logged.append)
    runpy.run_path(str(ROOT / "app" / "streamlit_app.py"),
                   run_name="__main__")
    assert zalo.HANDOFF_TEXT in shown
    assert st.session_state["history"] == []
    (row,) = logged
    assert row["answered"] is False and "Hoa" not in row["question"]


def test_streamlit_chat_convlog_scrubbed(monkeypatch):
    from pipelines import auth
    shown, logged = [], []
    st = _fake_streamlit("giao Bích 2 hộp", shown)
    monkeypatch.setitem(sys.modules, "streamlit", st)
    monkeypatch.setattr(auth, "auth_mode", lambda: "dev")
    monkeypatch.setattr(auth, "tabs_for", lambda role: ("Chat Sâm Sâm",))
    monkeypatch.setattr(rag, "answer", _ans())
    monkeypatch.setattr(zalo, "_log_conversation", logged.append)
    runpy.run_path(str(ROOT / "app" / "streamlit_app.py"),
                   run_name="__main__")
    (row,) = logged
    assert "Bích" not in row["question"]


# ---------------- Sức khỏe đơn âm tiết theo ngữ cảnh ----------------

HEALTH_CTX = [
    "bị sốt", "bi sot", "đang bị đau", "hay bị ho", "bị thận", "bi gan",
    "bị gan", "ba tôi bị gan", "đang bị gan", "bị tim", "bi tim",
    "ba em bị tim uống được không", "mẹ bị gan", "hay bị tim", "bị cảm",
    "bị cúm", "bi cum", "mắc phổi", "mac gan", "chua gan", "chữa ho",
    "bị sôt", "bị than", "bị gút", "bi gout", "mắc giang mai", "bị u",
    "bị trĩ", "bị phổi", "bị khớp", "bi khop", "BỊ GAN", "bị nám da",
    "Mẹ tôi hay bị ho, có dùng được không",
]


@pytest.mark.parametrize("q", HEALTH_CTX)
def test_health_ctx_handoff_before_any_ai(fake, monkeypatch, q):
    monkeypatch.setattr(rag, "retrieve", lambda *a, **k: pytest.fail(q))
    assert gw.is_health_question(q), q
    r = rag.answer(q)
    assert r["handoff"] == "health" and fake.calls == []


@pytest.mark.parametrize("q", [
    "giao dau", "giao đâu", "o dau", "mac dau", "mặc dầu", "chua tim thay",
    "chưa tìm thấy", "bi phoi nang", "sâm bị phơi", "bị soi kỹ",
    "sâm bị ủ", "bị cấm", "bi cam", "bị than phiền", "bi than phien",
    "bị trễ", "bị hủy", "chua ho tro", "chưa hỗ trợ", "mặc tím",
    "chưa gần", "bị tìm thấy", "giá trị", "mắc quá", "bị họ lừa",
    "đơn bị hoàn", "bị lao xuống", "hộp bị móp", "chưa giao",
    "bị giao trễ", "mua ở đâu", "chưa tìm được", "bi tim thay",
    "hàng bị gần hết hạn", "bị u ám", "bị mất", "bị bể", "mắc tiền không",
    "bị nhầm", "Sâm này giá bao nhiêu?", "Có hộp quà Tết không",
])
def test_health_ctx_no_false_positive(q):
    assert not gw.is_health_question(q), q


# ---------------- Red-team: khép known_gap bằng luật ----------------

CLOSED_V14 = ("rt-vt-02", "rt-split-02", "rt-en-01", "rt-en-02",
              "rt-en-04", "rt-en-05", "rt-llm-01")


def _cases():
    return {c["id"]: c for c in redteam.load_cases(redteam.CASES)}


@pytest.mark.parametrize("cid", CLOSED_V14)
def test_redteam_v14_closed_cases_blocked(cid):
    c = _cases()[cid]
    assert "known_gap" not in c
    blocked, codes = redteam.judge(c["text"], redteam._ctx(c), c["code"])
    assert blocked, (cid, codes)


def test_redteam_v14_counts_and_labels_unchanged():
    """Không đổi nhãn/severity/code: bộ vẫn 50 ca; ca 0 violation <= 6
    (critical <= 3), mọi ca còn lọt có known_gap."""
    cases = list(_cases().values())
    assert len(cases) == 50
    crit = {c["id"]: c["severity"] for c in cases}
    assert crit["rt-vt-02"] == "critical" and crit["rt-split-02"] == "major"
    empty = [c for c in cases
             if not redteam.judge(c["text"], redteam._ctx(c), c["code"])[1]]
    assert len(empty) <= 6
    assert sum(c["severity"] == "critical" for c in empty) <= 3
    assert all("known_gap" in c for c in empty)
    assert redteam.main([]) == 0


@pytest.mark.parametrize("text", [
    "Note: This food is not a medicine and cannot replace medicine.",
    "Savina is a health food, not a medicine and does not replace medicine.",
    "This food is not a medicine and is not a substitute for medicine.",
    "Sản phẩm thuộc bộ sưu tập Tết", "Mẹ em chưa khỏi hẳn cảm",
    "Thanh toán secure qua cổng", "Dịch vụ manicure", "Mã UT-2024",
    "Khách UT đặt hàng", "Sâm rất tốt. Cho mình xin địa chỉ",
    "Hộp quà rất tốt. Cho cả nhà dịp Tết", "Giao hàng rất tốt. Cho 5 sao",
    "Sâm Ngọc Linh 6 năm tuổi, quà biếu sang trọng.",
])
def test_redteam_v14_rules_no_false_positive(text):
    codes = [v["code"] for v in g.check(text)["violations"]]
    assert "tu_cam" not in codes and "claim_ngoai_cong_bo" not in codes, \
        (text, codes)


def test_redteam_v14_spans_map_to_text():
    for text, code in (("Sâm Sâm uo'ng đèu là khõi bịnh lun", "tu_cam"),
                       ("Khỏi hẳn UT giai đoạn đầu", "tu_cam"),
                       ("Sapentol rất tốt. Cho tim mạch của bạn.",
                        "claim_ngoai_cong_bo"),
                       ("Natural medicine cho người Việt", "tu_cam")):
        v = next(v for v in g.check(text)["violations"] if v["code"] == code)
        assert text[v["start"]:v["end"]] == v["span"], (text, v)


# ---------------- Probe pathological (luật mới tuyến tính) ----------------

LONG_V14 = {
    "give_cue": ("giao ", 100000), "give_cap": ("Giao Bích ", 60000),
    "ten_cue": ("tên là ", 60000), "ho_cue": ("họ ", 100000),
    "rare_ho": ("Âu ", 100000), "ho_ro": ("nguyen ", 100000),
    "low_recipient": ("giao cho ", 60000), "ctx_health": ("bị ", 100000),
    "ctx_pair": ("bi gan ", 60000), "hoi_nga": ("khõi ", 100000),
    "ut": ("UT ", 100000), "split": ("tốt. cho ", 60000),
    "space_after_cue": ("giao" + " " * 200000 + "Bích", 1),
    # v14 vá review: tự giới thiệu + tên gõ thường, kiểu dấu cũ, họ Viết
    # Hoa + đệm gõ thường
    "weak_low": ("tôi là tuấn ", 60000), "old_tone": ("giao Hoà ", 60000),
    "cap_ho_low_dem": ("Trần thị ", 60000),
}


@pytest.mark.parametrize("name", sorted(LONG_V14))
def test_v14_rules_linear_on_long_input(name):
    unit, n = LONG_V14[name]
    text = unit * n
    t = time.perf_counter()
    pii.scrub_user(text)
    gw.is_health_question(text)
    g.check(text)
    assert time.perf_counter() - t < 30, "nghi bậc hai trên input dài"
