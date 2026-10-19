"""v15 lane p9 (P9.1–P9.6) — an toàn kênh chat: ký tự vô hình trong câu sức
khỏe, history Streamlit, từ điển tên tự phục hồi, gợi ý trả lời che PII.

Mỗi nhóm FAIL trên nền `a05c60f` (xem evidence/v15_p9_old_code.log). Fake
provider ghi MỌI payload gửi ra — không gọi mạng. P9.4 có thêm 1 test DB
thật (schema tạm + ROLLBACK, `tests.test_da_schema.da_db`).
"""

import contextlib
import json
import runpy
import sys
from pathlib import Path

import pytest

from api import rag
from connectors import channels, zalo
from pipelines import llm_gateway as gw
from pipelines import pii
from tests import test_v14_p1_pii_guardrail as p1
from tests.test_da_schema import TxConn, da_db

_fake_streamlit = p1._fake_streamlit
fake = p1.fake  # fixture dùng chung (Fake ghi payload gửi provider)

ROOT = Path(__file__).resolve().parent.parent

# Ký tự vô hình: ZWSP, ZWNJ, ZWJ, LRM, word joiner, BOM, soft hyphen (Cf) +
# Default_Ignorable không phải Cf: CGJ, chọn biến thể, Hangul filler,
# Mongolian FVS, tag space.
INVISIBLE = ["\u200b", "\u200c", "\u200d", "\u200e", "\u2060", "\ufeff",
             "\u00ad", "\u034f", "\ufe0f", "\u3164", "\u180b",
             "\U000e0020"]

# {Z} = chỗ chèn ký tự vô hình. Có dấu / không dấu / trộn dấu; chèn GIỮA
# hai từ, TRONG từ, và cả hai.
HEALTH_TPL = [
    "bị{Z}gan",                                  # giữa 2 từ, có dấu
    "bi{Z}gan",                                  # không dấu
    "Ba tôi bị{Z}gan, uống sâm được không",
    "đang bị{Z}sốt",
    "mắc{Z}phổi",
    "chữa{Z}ho",
    "hay bi{Z}tim",
    "bị{Z}g{Z}an",                               # giữa + trong từ
    "tác{Z}dụng ph{Z}ụ",                         # cụm 3 âm tiết, trộn
    "ba tôi bi{Z}tieu{Z}duong",                  # trộn dấu
    "bị{Z}giang{Z}mai",                          # bệnh 2 âm tiết
    "BỊ{Z}GAN",
    "b{Z}ị gan",                                 # trong từ ngữ cảnh
    "mẹ em bị{Z}tiểu đuong",                     # gõ thiếu dấu
]
SALES_TPL = [
    "sâm{Z}ngọc{Z}linh giá bao nhiêu",
    "giao{Z}đâu vậy shop",
    "hàng bị{Z}gần hết hạn không",
    "chua{Z}tim{Z}thay đơn",
    "bị{Z}than{Z}phiền về giao hàng",
    "hộp{Z}bị{Z}móp",
    "mac{Z}dau đắt nhưng vẫn mua",
    "Có hộp{Z}quà Tết không",
    "Saphraton gi{Z}á sao",
]


def _cases(tpls):
    return [(t, z) for t in tpls for z in INVISIBLE]


# ----------------------------- P9.1 ---------------------------------------

@pytest.mark.parametrize("tpl,z", _cases(HEALTH_TPL))
def test_p9_1_invisible_health_blocked_zero_ai_calls(fake, monkeypatch, tpl,
                                                     z):
    """Câu sức khỏe chèn ký tự vô hình → handoff health, 0 lời gọi AI,
    không retrieve."""
    q = tpl.replace("{Z}", z)
    monkeypatch.setattr(rag, "retrieve", lambda *a, **k: pytest.fail(q))
    assert gw.is_health_question(q), repr(q)
    r = rag.answer(q)
    assert r["handoff"] == "health" and fake.calls == [], repr(q)


@pytest.mark.parametrize("tpl,z", _cases(SALES_TPL))
def test_p9_1_invisible_sales_not_broken(fake, tpl, z):
    """Câu bán hàng có ký tự vô hình không bị coi là sức khỏe và vẫn tới
    AI bình thường (đã che PII)."""
    q = tpl.replace("{Z}", z)
    assert not gw.is_health_question(q), repr(q)
    r = rag.answer(q)
    assert r.get("handoff") is None and fake.calls, repr(q)


def test_p9_1_plain_behaviour_unchanged():
    """Không có ký tự vô hình: giữ đúng hành vi v14 (khóa vài mốc)."""
    for q in ("bị gan", "bi sot", "tieuduong", "tiểu\u200bđường",
              "giao đau"):
        assert gw.is_health_question(q), q
    for q in ("bigan", "macho", "giao đâu", "bị than phiền", "chưa tìm thấy",
              "Sâm này giá bao nhiêu?"):
        assert not gw.is_health_question(q), q


@pytest.mark.parametrize("unit", [
    "b\u200bi\u200b", "bi ", "g\u200ba\u200bn\u200b", "bi\u200bgi\u200bang\u200b",
    "t\u200ba\u200bc\u200b", "\u200b", "xin chào "])
def test_p9_1_pathological_linear(monkeypatch, unit):
    """Input dài/pathological: số bước nối mảnh tăng TUYẾN TÍNH theo độ dài
    (đếm bước, không đo giờ — tránh flake)."""
    if not hasattr(gw, "_virt"):
        pytest.fail("chưa có lớp nối mảnh tại ranh giới mềm")
    steps = [0]
    real = gw._virt

    def counted(atoms, i, pre):
        for x in real(atoms, i, pre):
            steps[0] += 1
            yield x
    monkeypatch.setattr(gw, "_virt", counted)
    out = []
    for n in (20_000, 200_000):
        steps[0] = 0
        gw.is_health_question(unit * (n // len(unit)))
        out.append(steps[0])
    assert out[1] <= 11 * out[0] + 100, out


# ----------------------------- P9.2 ---------------------------------------

def _run_turn(st, q):
    st.chat_input = lambda *a, **k: q
    st.sidebar = contextlib.nullcontext()   # ctx của fake dùng 1 lần
    runpy.run_path(str(ROOT / "app" / "streamlit_app.py"),
                   run_name="__main__")


def test_p9_2_streamlit_history_skips_health_alcohol(fake, monkeypatch):
    """Lượt sức khỏe/rượu không vào history gửi AI (parity Zalo); lượt
    thường vào history bằng câu trả lời GỐC, còn khung chat hiển thị câu
    hiển thị — hai mô hình tách nhau."""
    from pipelines import auth
    shown, logged = [], []
    st = _fake_streamlit("", shown)
    monkeypatch.setitem(sys.modules, "streamlit", st)
    monkeypatch.setattr(auth, "auth_mode", lambda: "dev")
    monkeypatch.setattr(auth, "tabs_for", lambda role: ("Chat Sâm Sâm",))
    monkeypatch.setattr(zalo, "_log_conversation", logged.append)

    _run_turn(st, "Ba tôi bị gan, uống sâm được không")
    _run_turn(st, "Rượu sâm bao nhiêu độ")
    assert st.session_state["history"] == []
    assert fake.calls == []
    # Khung chat vẫn hiện đủ 2 lượt (display = câu chuyển người)
    roles = [m["role"] for m in st.session_state["messages"]]
    assert roles == ["user", "assistant", "user", "assistant"]

    seen = []
    real_answer = rag.answer

    def spy(q, history=None, **kw):
        seen.append(history)
        return real_answer(q, history, **kw)
    monkeypatch.setattr(rag, "answer", spy)
    _run_turn(st, "Saphraton giá sao")
    assert seen == [None]
    sent = fake.user_payload()
    assert "gan" not in sent and "Rượu" not in sent
    hist = st.session_state["history"]
    assert [m["role"] for m in hist] == ["user", "assistant"]
    assert hist[1]["content"] == "Saphraton: 1.000.000 đ"   # raw answer
    assert st.session_state["messages"][-1]["content"].startswith(
        "Saphraton: 1.000.000 đ")


# ----------------------------- P9.3 ---------------------------------------

class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def names_env(monkeypatch, tmp_path):
    clock = _Clock()
    monkeypatch.setattr(pii, "_clock", clock, raising=False)
    monkeypatch.setattr(pii, "NAMES_CHECK_S", 5.0, raising=False)
    path = tmp_path / "vn_names.json"
    monkeypatch.setattr(pii, "NAMES_FILE", path)
    pii._names.cache_clear()
    yield clock, path
    monkeypatch.undo()
    pii._names.cache_clear()


def _valid_doc() -> str:
    return (ROOT / "data" / "vn_names.json").read_text(encoding="utf-8")


def test_p9_3_missing_at_start_then_recovers_without_restart(fake, names_env):
    clock, path = names_env
    q = "Saphraton giá sao"
    # Khởi động thiếu file → chặn AI
    assert pii.scrub_user(q)[1] is True
    assert rag.answer(q)["handoff"] == "pii" and fake.calls == []
    # Sửa file hợp lệ → sau khoảng kiểm, tự phục hồi (không restart)
    path.write_text(_valid_doc(), encoding="utf-8")
    clock.t += 6
    assert pii.scrub_user(q) == (q, False)
    assert rag.answer(q).get("handoff") is None and fake.calls


def test_p9_3_corrupt_then_fixed_recovers_and_fail_closed(names_env):
    clock, path = names_env
    q = "Saphraton giá sao"
    path.write_text('{"ho": [', encoding="utf-8")            # JSON hỏng
    assert pii.scrub_user(q)[1] is True
    path.write_text(_valid_doc(), encoding="utf-8")
    clock.t += 6
    assert pii.scrub_user(q) == (q, False)
    # Đang chạy mà file bị hỏng → lần kiểm kế tiếp fail-closed lại
    path.write_text('{"ho": []}', encoding="utf-8")
    clock.t += 6
    assert pii.scrub_user(q)[1] is True
    path.write_text(_valid_doc(), encoding="utf-8")
    clock.t += 6
    assert pii.scrub_user(q) == (q, False)


def test_p9_3_not_reread_every_request(names_env, monkeypatch):
    """Đếm số lần đọc file: nhiều request trong khoảng kiểm = 0 lần đọc
    thêm; hết khoảng + file không đổi = 0 lần đọc; file đổi = 1 lần."""
    clock, path = names_env
    path.write_text(_valid_doc(), encoding="utf-8")
    reads = [0]
    real = getattr(pii, "_load_names", None)

    def counted():
        reads[0] += 1
        return real()
    monkeypatch.setattr(pii, "_load_names", counted, raising=False)
    for _ in range(200):
        pii.scrub_user("giao Bích 2 hộp")
    assert reads[0] == 1
    clock.t += 6
    for _ in range(50):
        pii.scrub_user("giao Bích 2 hộp")
    assert reads[0] == 1                      # dấu vết không đổi → không đọc
    doc = json.loads(_valid_doc())
    doc["ten"] = [*doc["ten"], "zyxw"]
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    pii.scrub_user("x")
    assert reads[0] == 1                      # chưa hết khoảng kiểm
    clock.t += 6
    pii.scrub_user("x")
    assert reads[0] == 2


# ----------------------------- P9.4 ---------------------------------------

BOT_PII = ("Dạ chị Nguyễn Thị Hoa ơi, shop giao tới 12 Lê Lợi, Hải Châu; "
           "chị gọi 0905123456 hoặc mail hoa.nguyen@example.com nhé.")
LEAKS = ("Nguyễn", "Hoa ơi", "12 Lê Lợi", "0905123456", "hoa.nguyen")


def _inb():
    return channels.Inbound("zalo", "ab" * 16, "giá?", "2026-10-16T08:00")


def test_p9_4_record_suggestion_payload_scrubbed(monkeypatch):
    got = []
    from pipelines import director

    def submit(conn, block, otype, **kw):
        got.append(kw["payload"])
        return 7
    monkeypatch.setattr(director, "submit", submit)
    sid = channels.record_suggestion(_inb(), BOT_PII, "m1", conn=object())
    assert sid == 7
    (payload,) = got
    for leak in LEAKS:
        assert leak not in payload, (leak, payload)
    assert "***" in payload and "Hải Châu" in payload   # địa bàn thô giữ
    # raw (câu gốc khi câu có nguồn bị guardrail bắt) cũng che
    got.clear()
    assert channels.record_suggestion(
        _inb(), BOT_PII + "\nNguồn: https://x/sam-chua-benh", "m2",
        conn=object(), raw=BOT_PII) == 7
    (payload,) = got
    assert "Nguồn" not in payload
    for leak in LEAKS:
        assert leak not in payload, (leak, payload)


def test_p9_4_names_dict_broken_not_recorded(monkeypatch, tmp_path):
    from pipelines import director
    got = []
    monkeypatch.setattr(director, "submit",
                        lambda *a, **kw: got.append(kw) or 1)
    monkeypatch.setattr(pii, "NAMES_FILE", tmp_path / "khong_co.json")
    pii._names.cache_clear()
    try:
        assert channels.record_suggestion(
            _inb(), "Dạ hộp quà 6 năm ạ.", "m1", conn=object()) is None
        assert got == []
    finally:
        monkeypatch.undo()
        pii._names.cache_clear()


@pytest.fixture
def db():
    for conn in da_db():
        yield TxConn(conn)


def test_p9_4_record_row_has_no_pii_db(db):
    """Ghi THẬT vào approval_queue (schema tạm): dòng không chứa PII."""
    sid = channels.record_suggestion(_inb(), BOT_PII, "m1", conn=db)
    assert sid is not None
    (payload, title, oid) = db.execute(
        "select payload, title, object_id from approval_queue where id = %s",
        (sid,)).fetchone()
    for leak in LEAKS:
        assert leak not in payload and leak not in title and leak not in oid
    assert "***" in payload


# ----------------------------- P9.6 ---------------------------------------

@pytest.mark.parametrize("q", ["giao đau", "Giao đau không shop",
                               "giao\u200bđau"])
def test_p9_6_giao_dau_accented_stays_health(fake, q):
    """Khóa hành vi an toàn hiện tại: "giao đau" (có dấu, "đau" = đau)
    vẫn coi là sức khỏe → chuyển người, 0 lời gọi AI. Nới hay không là
    quyết định của Pháp chế (board P9.6) — đổi hành vi phải FLIP test."""
    assert gw.is_health_question(q)
    assert rag.answer(q)["handoff"] == "health" and fake.calls == []
