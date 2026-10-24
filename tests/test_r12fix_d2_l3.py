"""r12-fix: hai lỗi controller bác ở r12 — D2 (SĐT dạng ngoặc lọt guardrail đăng bài) và L3 (quá 30 giây vẫn hứa
nhân viên khi chưa ghi handoff). Không DB: `channels._connect`/`director.submit` thay bằng giả ghi thứ tự.
SĐT/email trong test là GIẢ."""
import time

import psycopg
import pytest

from api import rag
from connectors import channels, zalo
from pipelines import director, rollout
from pipelines import guardrail as g
from pipelines.llm_gateway import GatewayBlocked
from pipelines.pii import _flatten_paren, _mask_pii

AI = "Nội dung có sử dụng AI."
CHANNELS = ("facebook", "shopee", "zalo", "web")


def _pub(text, ch="facebook", ct="post"):
    r = g.check_publish(f"{text} {AI}", channel=ch, content_type=ct, is_ai=True)
    return r["ok"], {v.get("code") for v in r["violations"]}


# --- D2 ---

@pytest.mark.parametrize("phone", ["(0912) 345 678", "+84 (912) 345 678", "(0912) - (345) - (678)",
                                   "(+84) 912 345 678", "0912345678", "0912 345 678"])
@pytest.mark.parametrize("ch", CHANNELS)
def test_d2_personal_phone_blocked_public(phone, ch):
    ok, codes = _pub(f"Gọi {phone} để đặt quà.", ch)
    assert not ok and "pii_ca_nhan" in codes


def test_d2_personal_email_blocked():
    ok, codes = _pub("Gửi đơn về ban.thu@example.com nhé.")
    assert not ok and "pii_ca_nhan" in codes


@pytest.mark.parametrize("text", [
    "Gọi hotline 1800577732 để được tư vấn.", "Gọi hotline 1800 577 732.", "Hotline (1800) 577 732.",
    "Showroom 0235 3699 899, email vnsamsam@gmail.com.", "Showroom 0235.3699.899.", "Showroom (0235) 3699 899.",
    "Showroom +84 235 3699 899.", "Showroom (+84) 235 3699 899.",
    "Giá 1.500.000 đ.", "Giá từ 50.000.000 - 100.000.000 đ.", "Combo (1.500.000 đ)(2.000.000 đ).",
    "Combo (1.500.000)(2.000.000).", "Giao từ 23/10/2026 đến 2026-10-30.", "Mã SP-2026-0301, quy cách (300ml).",
    "Sâm Sâm gửi lời chúc mùa thu an lành."])
@pytest.mark.parametrize("ch", CHANNELS)
def test_d2_company_contacts_prices_dates_kept(text, ch):
    ok, codes = _pub(text, ch)
    assert ok and "pii_ca_nhan" not in codes


def test_d2_pathological_parens_fail_closed_fast():
    t0 = time.perf_counter()
    ok, codes = _pub("(" * 5000 + " (0912) 345 678")
    assert not ok and "pii_ca_nhan" in codes
    assert time.perf_counter() - t0 < 3


def test_d2_scope_unchanged_for_chat_and_internal_note():
    r = g.check("Gọi (0912) 345 678 nhé")
    assert "pii_ca_nhan" not in {v.get("code") for v in r["violations"]}
    _, codes = _pub("Gọi (0912) 345 678 cho khách.", ct="internal_note")
    assert "pii_ca_nhan" not in codes


@pytest.mark.parametrize("text,masked", [
    # giá trị đông cứng từ `_mask_pii` của cây baseline r12 (trước khi tách `_flatten_paren`)
    ("Gọi (0912) 345 678", "Gọi  ***"),
    ("(0912) - (345) - (678)", " *** "),
    ("50.000.000 - 100.000.000", "50.000.000 - 100.000.000"),
    ("(1.500.000)(2.000.000)", "(1.500.000)(2.000.000)"),
    ("(" * 30 + "x(0901) - (234) - (567)", "(" * 12 + "***"),
    ("+84 (912) 345 678 và a@b.vn", " *** và ***"),
])
def test_d2_mask_pii_output_unchanged(text, masked):
    assert _mask_pii(text) == masked


def test_d2_flatten_reports_budget_cut():
    assert _flatten_paren("(0912) 345 678")[1] is False
    assert _flatten_paren("(" * 5000 + " (0912) 345 678")[1] is True


# --- L3 ---

PROMISE = ("nhân viên sẽ", "nhân viên sâm sâm sẽ", "sẽ phản hồi", "sẽ liên hệ")


@pytest.fixture
def turn(monkeypatch):
    monkeypatch.setenv(channels.SALT_ENV, "test-salt-gia-khong-phai-that-01")
    monkeypatch.setattr(channels, "pre_route", lambda inb: None)
    monkeypatch.setattr(channels, "consent_gate", lambda inb: channels.Gate("", False, False))
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "van_hanh")
    monkeypatch.setattr(channels, "record_consent", lambda *a, **k: None)
    monkeypatch.setattr(channels, "record_suggestion", lambda *a, **k: None)
    ev, logs = [], []
    state = {"db": "ok"}

    class Conn:
        def close(self):
            pass

    def connect():
        ev.append("connect")
        return None if state["db"] == "down" else Conn()

    def submit(*a, **k):
        ev.append("submit")
        if state["db"] == "error":
            raise psycopg.OperationalError("lỗi DB giả")
        if state["db"] == "rollout":
            raise rollout.RolloutBlocked("chatbot tắt")
        return 77

    monkeypatch.setattr(channels, "_connect", connect)
    monkeypatch.setattr(director, "submit", submit)
    monkeypatch.setattr(zalo, "_log_conversation", logs.append)

    def go(db="ok", channel="zalo", late=True, answer=None, entry="reply"):
        state["db"] = db
        monkeypatch.setattr(rag, "answer", answer or (lambda *a, **k: {"answer": "x", "sources": []}))
        budget = []

        def send(u, t):
            ev.append(("send", t))
            budget.append(zalo._SEND_DEADLINE.get() - time.monotonic())
            return True
        if entry == "handle_text":
            out = zalo.handle_text("fixture-u", "Xin thông tin hộp quà.", "fixture-m", channel=channel, send=send)
        else:
            out = zalo._reply("fixture-u", "Xin thông tin hộp quà.", "fixture-m", channel=channel, send=send,
                              t_recv=time.monotonic() - 26 if late else None)
        return out, ev, logs, budget
    return go


@pytest.mark.parametrize("channel", ["zalo", "messenger"])
@pytest.mark.parametrize("db", ["down", "error", "rollout", "ok"])
def test_l3_deadline_no_promise_send_first_record_once(turn, channel, db):
    out, ev, logs, budget = turn(db=db, channel=channel)
    sends = [e for e in ev if isinstance(e, tuple)]
    assert len(sends) == 1 and sends[0][1] == zalo.NO_HANDOFF_TEXT == out["text"]
    assert not any(p in out["text"].casefold() for p in PROMISE) and "1800577732" in out["text"]
    assert isinstance(ev[0], tuple), "gửi trước mọi kết nối DB"
    assert ev.count("connect") == 1 and ev.count("submit") == (0 if db == "down" else 1)
    assert out["deadline"] == "cho_lock" and budget[0] > 0
    assert [lg["provenance"] for lg in logs] == ["sample"]       # transport giả không mang provenance live


def test_l3_handle_text_messenger_deadline(turn):
    def timeout(*a, **k):
        raise rag.DeadlineExceeded("tra_loi")
    out, ev, _, _ = turn(db="ok", channel="messenger", answer=timeout, entry="handle_text")
    assert [e[1] for e in ev if isinstance(e, tuple)] == [zalo.NO_HANDOFF_TEXT] and out["deadline"] == "tra_loi"
    assert isinstance(ev[0], tuple) and ev.count("submit") == 1


@pytest.mark.parametrize("db,promise", [("down", False), ("ok", True)])
@pytest.mark.parametrize("kind", ["no_data", "gateway"])
def test_l3_controls_record_before_send(turn, kind, db, promise):
    def no_data(*a, **k):
        return {"answer": rag.NO_DATA, "sources": []}

    def blocked(*a, **k):
        raise GatewayBlocked("kill-switch")
    out, ev, _, _ = turn(db=db, late=False, answer=no_data if kind == "no_data" else blocked)
    assert any(p in out["text"].casefold() for p in PROMISE) is promise
    assert "1800577732" in out["text"]
    assert isinstance(ev[-1], tuple) and ev.count("connect") == 1, "ghi handoff TRƯỚC khi gửi, đúng 1 lần"
