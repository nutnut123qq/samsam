"""v13.1 (lane c01) — khép F02 (PII tên/địa chỉ + lọc sức khỏe trộn dấu),
F07 (red-team: luật chặn thêm 7 ca known-gap) và probe FinOps
`zero_cap_without_db`. Mỗi test regression tái hiện đúng probe của audit
hợp đồng và FAIL trên code trước v13.1. Fake provider ghi payload — không
gọi mạng/DB thật. Không wall-clock flake: bound thời gian rộng >=30 lần."""
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from api import rag
from pipelines import guardrail as g
from pipelines import llm_gateway as gw
from pipelines import pii

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import redteam

# Probe `synthetic_pii_gateway_payload` (findings F02) — tên/địa chỉ GIẢ.
PROBE_PII = ("Tôi là Nguyễn Văn Mẫu, giao hàng đến số 12 đường Ví Dụ, "
             "Đà Nẵng. SĐT 0901234567, email mau.vidu@example.vn.")
LEAKS = ("Nguyễn Văn Mẫu", "Văn Mẫu", "12 đường", "Ví Dụ", "0901234567",
         "mau.vidu@example.vn")
PROBE_HEALTH = "Ba tôi bi tieu duong, mua loại nào?"
HITS = [{"title": "Saphraton", "url": "http://x/saphraton", "lang": "vi",
         "content": "Saphraton — 1.000.000 đ", "score": 0.9, "doc_id": "p1"}]


class Fake:
    """Client giả: ghi MỌI payload chat/embed gửi ra provider."""

    def __init__(self):
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(
            create=self._chat))
        self.embeddings = SimpleNamespace(create=self._embed)

    def _chat(self, **kw):
        self.calls.append(("chat", kw))
        rewrite = "Viết lại" in str(kw["messages"][0].get("content"))
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(
            message=SimpleNamespace(
                content="Saphraton giá bao nhiêu?" if rewrite
                else "Saphraton: 1.000.000 đ"))])

    def _embed(self, **kw):
        self.calls.append(("embed", kw))
        return SimpleNamespace(usage=None,
                               data=[SimpleNamespace(embedding=[1.0, 0.0])])

    def dump(self) -> str:
        return json.dumps([kw for _, kw in self.calls], ensure_ascii=False)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    cfg = {"provider_only": ["azure"],
           "prices_usd_per_1m": {"m": {"in": 1.0, "out": 2.0}},
           "monthly_cap_usd": {"default": 10.0, "chatbot": 1.0},
           "kill": [],
           "pii_allow": ["0235 3699 899", "vnsamsam@gmail.com",
                         "425 Phan Bội Châu"]}
    p = tmp_path / "llm_gateway.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", p)
    f = Fake()
    monkeypatch.setattr(gw, "_client", lambda: f)
    f.cfg_path = p
    return f


# ---------------- F02: sức khỏe trộn dấu ----------------

def test_probe_mixed_accent_health_handoff_no_ai(fake, monkeypatch):
    """Probe `mixed_accent_health`: trước v13.1 health_filter=false, câu đi
    tới retrieve. Giờ handoff sức khỏe, 0 lời gọi AI, không retrieve."""
    monkeypatch.setattr(rag, "retrieve", lambda q: pytest.fail("retrieve"))
    assert gw.is_health_question(PROBE_HEALTH)
    r = rag.answer(PROBE_HEALTH)
    assert r == {"answer": rag.NO_DATA, "sources": [], "handoff": "health"}
    r = rag.answer(PROBE_HEALTH, history=[{"role": "user", "content": "chào"},
                                          {"role": "assistant",
                                           "content": "chào anh"}])
    assert r["handoff"] == "health"
    assert fake.calls == []


def test_mixed_accent_health_channel_template(fake):
    from connectors import channels
    inb = channels.normalize("zalo", "u1", PROBE_HEALTH)
    route = channels.pre_route(inb)
    assert route is not None and route.handoff == "health"
    assert fake.calls == []


@pytest.mark.parametrize("q", [
    PROBE_HEALTH,
    "me em bị tiểu duong uống được ko",
    "Mẹ tôi bi huyet ap cao",
    "ba toi bi tieuduong",                      # dính liền
    "tiể\u200bu đường dùng được không",         # ZWSP chèn
    "hoá trị xong uống được không",             # dấu đặt kiểu cũ
    "\uff22\u1ec6NH gì cũng uống được à",   # fullwidth + có dấu
    "Ông nhà em đang uong thuoc tim mach",
    "dang mang bau co dung duoc khong",
])
def test_health_mixed_variants_hit(q):
    assert gw.is_health_question(q), q


@pytest.mark.parametrize("q", [
    "Saphraton giá bao nhiêu?",
    "giao hàng về Đà Nẵng mất mấy ngày",
    "Quà Tết cho bố mẹ loại nào đẹp?",
    "mua 2 hộp có giảm giá không",
    "ship COD được không shop",
    "sản phẩm này thuộc loại nào",              # thuộc ≠ thuốc
    "đâu là loại tốt nhất",                     # đâu ≠ đau
    "giá trị của sâm",
    "Giao hàng ở Ho Chi Minh mất mấy ngày",
    "than hoạt tính có không",                  # than ≠ thận
    "giá bao nhieu vay shop",
])
def test_health_sales_questions_not_blocked(q):
    assert not gw.is_health_question(q), q


# ---------------- F02: tên + địa chỉ ----------------

def test_probe_synthetic_pii_gateway_payload(fake):
    """Probe `synthetic_pii_gateway_payload`: trước v13.1 payload sau
    gateway còn 'Nguyễn Văn Mẫu' + địa chỉ. Giờ mọi message/embed che."""
    gw.chat("chatbot", [{"role": "system", "content": "sys " + PROBE_PII},
                        {"role": "user", "content": PROBE_PII},
                        {"role": "user", "content": [
                            {"type": "text", "text": PROBE_PII}]}],
            model="m")
    gw.embed("ingest", PROBE_PII, model="m")
    gw.embed("ingest", [PROBE_PII], model="m")
    out = fake.dump()
    assert len(fake.calls) == 3
    for leak in LEAKS:
        assert leak not in out, leak
    assert "Đà Nẵng" in out and "sys" in out   # phần không định danh giữ


def test_rag_payload_no_name_address_health(fake, monkeypatch):
    """Đường chatbot đủ 3 lời gọi (rewrite + embed + chat): câu hỏi và
    history có tên/địa chỉ giả -> không có trong payload ra ngoài."""
    monkeypatch.setattr(rag, "retrieve_by_vector",
                        lambda qv, k=8, **kw: HITS)
    hist = [{"role": "user", "content":
             "Tên em là Trần Thị Thử, gửi cho chị Lan Giả ở hẻm 34/5 "
             "Đường Giả"},
            {"role": "assistant", "content": "Dạ shop ghi nhận ạ"}]
    r = rag.answer("Anh Nguyễn Văn Mẫu hỏi Saphraton giá bao nhiêu, giao "
                   "đến 425 Lê Giả Định nhé", history=hist)
    kinds = [k for k, _ in fake.calls]
    assert kinds == ["chat", "embed", "chat"]
    out = fake.dump()
    for leak in ("Trần Thị Thử", "Thị Thử", "Lan Giả", "34/5",
                 "Nguyễn Văn Mẫu", "425 Lê Giả Định", "Lê Giả"):
        assert leak not in out, leak
    assert "Saphraton" in out and r["answer"]


def test_rag_residual_pii_handoff_no_ai(fake, monkeypatch):
    """Dấu hiệu địa chỉ không che chắc (gõ thường, không dấu) -> chuyển
    người, 0 lời gọi AI."""
    monkeypatch.setattr(rag, "retrieve", lambda q: pytest.fail("retrieve"))
    for q in ("ship ve 123 nguyen trai q1 nhe",
              "địa chỉ nhà em ở 45 le loi phuong 3"):
        r = rag.answer(q)
        assert r == {"answer": rag.NO_DATA, "sources": [], "handoff": "pii"}
    assert fake.calls == []


def test_rag_history_residual_pair_dropped(fake, monkeypatch):
    monkeypatch.setattr(rag, "retrieve_by_vector",
                        lambda qv, k=8, **kw: HITS)
    hist = [{"role": "user", "content": "ship ve 123 nguyen trai q1"},
            {"role": "assistant", "content": "da 123 nguyen trai"},
            {"role": "user", "content": "Saphraton giá bao nhiêu?"},
            {"role": "assistant", "content": "1.000.000 đ"}]
    rag.answer("còn loại rẻ hơn?", history=hist)
    out = fake.dump()
    assert "nguyen trai" not in out and "1.000.000" in out


def test_zalo_pii_question_gets_handoff_no_ai(fake, monkeypatch):
    from connectors import zalo
    sent = {}
    monkeypatch.setattr(zalo, "CONV_LOG", fake.cfg_path.parent / "c.jsonl")
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(t=t) or True)
    monkeypatch.setattr(zalo, "_histories", type(zalo._histories)())
    # r12 L3: câu hứa nhân viên chỉ khi ĐÃ ghi được handoff — giả lập.
    monkeypatch.setattr("connectors.channels.record_handoff",
                        lambda *a, **k: 77)
    zalo.handle_text("u1", "ship ve 123 nguyen trai q1 nhe")
    assert sent["t"] == zalo.HANDOFF_TEXT
    assert fake.calls == []


def test_kb_public_address_kept_dealer_masked(fake):
    kb = ("Showroom — Địa chỉ: 425 Phan Bội Châu, phường Bàn Thạch, TP. Đà "
          "Nẵng. Đại lý — Địa chỉ: Số 35, đường Nguyễn Trường Tộ, Thành Phố "
          "Tam Kỳ. Vùng trồng: Thôn 2, xã Trà Linh. Hotline 0235 3699 899.")
    gw.chat("chatbot", [{"role": "user", "content": kb}], model="m")
    out = fake.dump()
    assert "425 Phan Bội Châu" in out          # địa chỉ công khai (pii_allow)
    assert "Thôn 2, xã Trà Linh" in out        # đơn vị thô, không số nhà
    assert "0235 3699 899" in out
    assert "Nguyễn Trường Tộ" not in out and "Số 35" not in out


def test_default_config_allows_showroom_address():
    cfg = gw._config()
    assert "425 Phan Bội Châu" in gw._allow_addr(cfg)
    assert all(any(c.isdigit() for c in x) or "@" in x
               for x in gw._allow(cfg))


@pytest.mark.parametrize("q", [
    "Saphraton giá bao nhiêu?",
    "Showroom ở đâu?",
    "Địa chỉ showroom ở đâu ạ",
    "giao về quận 7 mất mấy ngày?",
    "mua 2 hộp Saphraton giao về Hà Nội được không",
    "cho em 2 Hộp Saphraton nhé",
    "giao hàng đến trước 20/12 được không",
    "Chị ơi cho em hỏi Sâm Ngọc Linh giá sao",
    "Có Saphraton không chị",
    "tên sản phẩm là gì",
])
def test_scrub_user_keeps_sales_questions(q):
    assert pii.scrub_user(q) == (q, False)


@pytest.mark.parametrize("q,leak", [
    ("tên em là nguyễn thị lan", "nguyễn thị lan"),
    ("Tên tôi là Lê Thị Thu Hà", "Thu Hà"),
    ("họ tên: Trần Văn B; đ/c: 7 ngõ 12 Láng Hạ", "Láng Hạ"),
    ("gửi cho chị Lan ở hẻm 34/5 Trần Phú", "Trần Phú"),
    ("Ship về 12/3 Lê Lợi, phường 3 nhé", "Lê Lợi"),
    ("em là Hoa, nhà ở số 5 thôn Phú Mỹ", "Phú Mỹ"),
    ("toi ten la tran van an", "tran van an"),
])
def test_scrub_user_masks_names_addresses(q, leak):
    out, _risky = pii.scrub_user(q)
    assert leak not in out and "***" in out, out


PATHOLOGICAL = {
    "space_after_num": "giao về 1" + " " * 200000 + "x",  # bản đầu O(n²)
    "space_after_kw": "ngõ" + " " * 200000 + "x",
    "space_colon": "số nhà" + " " * 100000 + ":" + " " * 100000,
    "name_cue_run": "tên em là " * 20000,
    "cue_digits": "địa chỉ " + "9 " * 100000,
    "cue_num_spaces": "ship về " + ("9" + " " * 30) * 6000,
    "paren": "(" * 100000,
    "health_run": "Ba tôi bi tieu duong " * 10000,
}


@pytest.mark.parametrize("name", sorted(PATHOLOGICAL))
def test_pathological_inputs_linear(name):
    text = PATHOLOGICAL[name]
    t = time.perf_counter()
    pii.scrub_user(text)
    pii.mask_identity(text, ["425 Phan Bội Châu"])
    gw.is_health_question(text)
    g.check(text)
    assert time.perf_counter() - t < 20, "nghi bậc hai trên input dài"


# ---------------- FinOps: cap 0 / không đọc được chi tiêu ----------------

def _boom():
    raise OSError("db down")


def test_probe_zero_cap_without_db_blocked(fake, monkeypatch):
    """Probe `zero_cap_without_db=ALLOWED`: cap 0 + DB down từng cho qua."""
    cfg = json.loads(fake.cfg_path.read_text(encoding="utf-8"))
    cfg["monthly_cap_usd"]["chatbot"] = 0
    fake.cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    zero = SimpleNamespace(
        execute=lambda sql, params=(): SimpleNamespace(fetchone=lambda: (0,)),
        commit=lambda: None, close=lambda: None)
    # DB lỗi / thiếu DSN / DB đọc được chi tiêu 0 — cap 0 chặn cả 3.
    for conn in (_boom, lambda: None, lambda: zero):
        monkeypatch.setattr(gw, "_connect", conn)
        with pytest.raises(gw.GatewayBlocked, match="trần 0"):
            gw.chat("chatbot", [{"role": "user", "content": "hi"}],
                    model="m")
    assert fake.calls == []


def test_spend_unreadable_blocks_and_chatbot_handoff(fake, monkeypatch):
    from connectors import zalo
    monkeypatch.setattr(gw, "_connect", _boom)
    with pytest.raises(gw.GatewayBlocked):
        gw.embed("chatbot", "x", model="m")
    sent = {}
    monkeypatch.setattr(zalo, "CONV_LOG", fake.cfg_path.parent / "c.jsonl")
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.update(t=t) or True)
    monkeypatch.setattr(zalo, "_histories", type(zalo._histories)())
    # r12 L3: câu hứa nhân viên chỉ khi ĐÃ ghi được handoff — giả lập.
    monkeypatch.setattr("connectors.channels.record_handoff",
                        lambda *a, **k: 77)
    zalo.handle_text("u1", "Sâm Sâm có showroom ở đâu?")
    assert sent["t"] == zalo.HANDOFF_TEXT       # chuyển người, không lỗi
    assert fake.calls == []


def test_bad_cap_value_fail_closed(fake):
    cfg = json.loads(fake.cfg_path.read_text(encoding="utf-8"))
    cfg["monthly_cap_usd"]["chatbot"] = "abc"
    fake.cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(gw.GatewayError):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    assert fake.calls == []


# ---------------- F07: red-team luật ----------------

CLOSED = ("rt-vt-01", "rt-vt-04", "rt-emo-03", "rt-ws-03", "rt-ws-06",
          "rt-split-01", "rt-llm-02")


def _cases():
    return {c["id"]: c for c in redteam.load_cases(redteam.CASES)}


@pytest.mark.parametrize("cid", CLOSED)
def test_redteam_closed_cases_blocked_tu_cam(cid):
    c = _cases()[cid]
    assert "known_gap" not in c
    blocked, codes = redteam.judge(c["text"], redteam._ctx(c), c["code"])
    assert blocked, (cid, codes)
    r = g.check(c["text"])                     # chatbot cũng chặn
    assert "tu_cam" in [v["code"] for v in r["violations"]], cid


def test_redteam_static_probe_counts_improved():
    """Probe `redteam_static` (F07): trước v13.1 18 ca 0 violation (14
    critical). Không nới nhãn/severity: chỉ đếm lại bằng luật."""
    cases = list(_cases().values())
    empty = [c for c in cases
             if not redteam.judge(c["text"], redteam._ctx(c), c["code"])[1]]
    assert len(cases) == 50
    assert len(empty) <= 13
    assert sum(c["severity"] == "critical" for c in empty) <= 9
    assert all("known_gap" in c for c in empty)


@pytest.mark.parametrize("text", [
    "Sâm có giá trị. Bệnh nhân nên hỏi ý kiến bác sĩ trước khi dùng.",
    "Vitamin A B C cho bé",
    "Quà Tết sang trọng cho cả nhà",
    ("Thực phẩm này không phải là thuốc và không có tác dụng thay thế "
     "thuốc chữa bệnh."),
    "Đi đều đặn mỗi sáng, ăn uống điều độ.",
    "Sâm \U0001f33f Sâm — quà biếu",
])
def test_redteam_v13_rules_no_false_positive(text):
    assert "tu_cam" not in [v["code"] for v in g.check(text)["violations"]]


def test_pill_emoji_and_spaced_run_spans_map_to_text():
    for text in ("Sâm Sâm = \U0001f48a tự nhiên",
                 "Hũ sâm là t h u ố c t r ị mất ngủ",
                 "Uống sâm. Khỏi. Bệnh. Luôn.", "Sâm giúp đi ều trị mệt"):
        r = g.check(text)
        v = next(v for v in r["violations"] if v["code"] == "tu_cam")
        assert text[v["start"]:v["end"]] == v["span"], text
