"""Đợt DOCX P1 — guardrail rượu nói vòng, PII câu bot, provenance tới
consumer vận hành, hạn 30 giây lần gửi đầu Zalo. Không DB, không mạng, không
gọi AI (đồng hồ/transport giả).

Lỗi trước sửa (nền 667f763):
  * red-team 3 ca CRITICAL rượu nói vòng (rt-ruou-01/02, rt-llm-06) lọt
    `check_publish` (PL02 mục 2: rượu trong nội dung công khai = lỗi nghiêm
    trọng);
  * câu BOT ghi nguyên văn ở convlog `answer`/`flagged_text`, gợi ý sàn
    `san_suggestions.answer` chỉ `_mask_pii` (tên/địa chỉ khách lọt), câu bot
    cũ trong history gửi AI không che (HĐ 12.1);
  * lead thật / KPI tháng / cockpit / SLA CSKH đọc MỌI dòng convlog — mock/
    demo/dòng thiếu provenance thành dữ liệu vận hành (PL02 mục 3, HĐ 7.3);
  * lần gửi ĐẦU của Zalo timeout cố định 5 giây — gần hết 30 giây vẫn chờ
    thêm, vượt hạn tổng (PL02 mục 2)."""

import json
import time
import types

import pytest

from connectors import channels, zalo
from pipelines import guardrail

ALC = [
    "Sâm ngâm bình sứ 40 độ, nhâm nhi ngày Tết. Nội dung có sử dụng AI.",
    "Chai sâm ngâm 500ml, rót một chén đãi khách là ấm bụng.",
    "Thức uống lên men từ sâm, nồng độ mạnh, thích hợp cho ngày vui.",
    "Sam ngam binh su 40 do, nham nhi ngay Tet.",
    "Chai sam ngam 500ml, rot mot chen dai khach la am bung.",
]
NOT_ALC = [
    "Sâm ngâm mật ong, bảo quản nơi khô ráo dưới 30 độ C.",
    "Ngâm sâm trong mật ong 40 ngày rồi dùng dần.",
    "Pha trà sâm với nước 80 độ, rót một chén mời khách.",
    "Khí hậu Ngọc Linh mát mẻ, nhiệt độ 18-25 độ C quanh năm.",
    "Nồng độ saponin cao trong củ sâm, có thể lên men tự nhiên.",
    "Vùng trồng nằm trong khoảng 14° 44′ đến 15° 13′ vĩ độ Bắc.",
    "Đối tác cùng nâng ly chúc mừng sự kiện ra mắt Sâm Sâm.",
]


@pytest.mark.parametrize("text", ALC)
def test_p1_indirect_alcohol_blocked_on_publish(text):
    r = guardrail.check_publish(text, channel="facebook", content_type="post")
    assert "ruou_cam_quang_cao" in {v["code"] for v in r["violations"]}, r


@pytest.mark.parametrize("text", NOT_ALC)
def test_p1_indirect_alcohol_no_false_positive(text):
    r = guardrail.check_publish(text, channel="facebook", content_type="post")
    assert "ruou_cam_quang_cao" not in {v["code"] for v in r["violations"]}


# ------------------------------------------------------------------ PII

NAMEY = "Dạ chị Hoa ở 12 Lê Lợi, Saphraton giá 1.500.000đ. Gọi 0905123456 ạ."


@pytest.fixture
def zfiles(monkeypatch, tmp_path):
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo.zalo_garden, "STAFF_FILE",
                        tmp_path / "garden_staff.json")
    monkeypatch.setattr(zalo.zalo_garden, "_staff", (None, {}))
    monkeypatch.setattr(channels, "record_handoff",
                        lambda inb, reason, msg_id="": None)
    monkeypatch.setattr(channels, "chatbot_mode", lambda: "van_hanh")
    monkeypatch.setattr(channels, "consent_gate",
                        lambda inb: channels.Gate("", False, False))
    zalo._histories.clear()
    yield tmp_path
    zalo._histories.clear()


def _log(tmp_path):
    return [json.loads(x) for x in (tmp_path / "conversations.jsonl")
            .read_text(encoding="utf-8").splitlines()]


def test_p1_convlog_bot_answer_scrubbed(zfiles, monkeypatch):
    monkeypatch.setattr("api.rag.answer", lambda q, history=None: {
        "answer": NAMEY, "sources": ["https://samsamngoclinh.com/x"]})
    monkeypatch.setattr("pipelines.guardrail.check",
                        lambda t: {"ok": False, "violations": []})
    sent = []
    zalo._reply("u-p1", "Saphraton giá bao nhiêu?", "mid.p1", channel="zalo",
                send=lambda u, t: sent.append(t) or True,
                t_recv=time.monotonic())
    rec = _log(zfiles)[-1]
    blob = (rec.get("answer") or "") + (rec.get("flagged_text") or "")
    assert blob, rec
    for pii in ("Hoa", "12 Lê Lợi", "0905123456"):
        assert pii not in blob, (pii, rec)


class _Conn:
    def __init__(self):
        self.sql = []

    def transaction(self):
        import contextlib
        return contextlib.nullcontext()

    def execute(self, sql, args=None):
        self.sql.append((sql, args))
        return types.SimpleNamespace(fetchone=lambda: (7,))

    def commit(self):
        pass


def test_p1_san_suggestion_answer_scrubbed():
    c = _Conn()
    sid = channels.record_san_suggestion(
        c, "shopee", "tin buyer", {"answer": NAMEY}, "co_nguoi_duyet",
        "MXH Giả")
    assert sid == 7
    stored = c.sql[0][1][2]
    for pii in ("Hoa", "12 Lê Lợi", "0905123456"):
        assert pii not in stored, stored


def test_p1_san_suggestion_not_stored_when_name_dict_broken(monkeypatch):
    from pipelines import pii
    monkeypatch.setattr(pii, "_names", lambda: None)
    c = _Conn()
    assert channels.record_san_suggestion(
        c, "shopee", "tin buyer", {"answer": NAMEY}, "co_nguoi_duyet",
        "MXH Giả") is None
    assert c.sql == []


def test_p1_ai_history_assistant_turn_scrubbed():
    from api import rag
    out = rag._scrub_history([{"role": "user", "content": "giá sao"},
                              {"role": "assistant", "content": NAMEY}])
    assert "Hoa" not in out[1]["content"] \
        and "0905123456" not in out[1]["content"]


# ------------------------------------------------------------ provenance

def _conv_lines(tmp_path):
    base = {"user_hash": "u" * 16, "channel": "zalo", "sent": True,
            "guardrail_ok": True, "answer": "x"}
    recs = [
        {**base, "ts": "2026-10-15T02:00:00Z", "msg_id": "live-1",
         "question": "cho tôi đặt mua 2 hộp sâm", "answered": False,
         "provenance": "live"},
        {**base, "ts": "2026-10-15T02:05:00Z", "msg_id": "mock0-1",
         "question": "cho tôi đặt mua 3 hộp sâm", "answered": False,
         "provenance": "sample", "is_sample": True},
        {**base, "ts": "2026-10-15T02:06:00Z", "msg_id": "old-1",
         "question": "cho tôi đặt mua 4 hộp sâm", "answered": False},
        {**base, "ts": "2026-10-15T02:07:00Z", "msg_id": "demo-1",
         "channel": "streamlit", "question": "cho tôi đặt mua 5 hộp",
         "answered": False, "provenance": "demo", "is_sample": True},
    ]
    (tmp_path / "conversations.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n",
        encoding="utf-8")


def test_p1_leads_only_from_live(tmp_path):
    from ingest import lead_store
    _conv_lines(tmp_path)
    rows, st = lead_store.harvest(tmp_path)
    assert [r["dedup_key"] for r in rows] == ["convlog:live-1"], rows
    assert st["thu_nghiem"] == 2 and st["thieu_provenance"] == 1, st


def test_p1_weekly_chat_counts_only_live(tmp_path):
    from datetime import datetime, timezone

    from agents import report
    _conv_lines(tmp_path)
    s = report.collect_chat(tmp_path,
                            datetime(2026, 10, 1, tzinfo=timezone.utc),
                            datetime(2026, 11, 1, tzinfo=timezone.utc))
    assert s["in_period"] == 1 and s["excluded_not_live"] == 3, s


def test_p1_monthly_kpi_only_live(tmp_path):
    import importlib
    from datetime import datetime, timezone
    om = importlib.import_module("scripts.ops_monthly")
    _conv_lines(tmp_path)
    c = om.read_convlog(tmp_path, datetime(2026, 10, 1, tzinfo=timezone.utc),
                        datetime(2026, 11, 1, tzinfo=timezone.utc))
    assert len(c["questions"]) == 1, c["questions"]
    assert c["stats"]["thu_nghiem"] == 2 \
        and c["stats"]["thieu_provenance"] == 1


# ------------------------------------------------- 30 giây — gửi đầu Zalo

class _Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def install(self, monkeypatch):
        fake = types.SimpleNamespace(**{k: getattr(time, k) for k in dir(time)
                                        if not k.startswith("_")})
        fake.monotonic = lambda: self.t
        monkeypatch.setattr(zalo, "time", fake)
        return self


@pytest.fixture
def zsend(monkeypatch):
    monkeypatch.setenv("DEPLOY", "1")  # G5: send_text dry-run khi DEPLOY tắt
    calls = []

    class R:
        status_code = 200
        text = "{}"

        @staticmethod
        def json():
            return {"error": 0}

    monkeypatch.setattr(zalo, "_current_access_token", lambda: "TOK")
    monkeypatch.setattr(zalo, "_can_refresh", lambda: False)
    monkeypatch.setattr(zalo.httpx, "post",
                        lambda url, **kw: calls.append(kw["timeout"]) or R())
    return calls


def _with_deadline(dl, fn):
    tok, late = zalo._SEND_DEADLINE.set(dl), zalo._SEND_LATE.set(None)
    try:
        return fn(), zalo._SEND_LATE.get()
    finally:
        zalo._SEND_LATE.reset(late)
        zalo._SEND_DEADLINE.reset(tok)


def test_p1_zalo_first_send_uses_remaining_budget(zsend, monkeypatch):
    clk = _Clock().install(monkeypatch)
    ok, late = _with_deadline(clk.t + 3.0, lambda: zalo.send_text("u1", "x"))
    assert ok is True and late is None and zsend == [3.0]   # cũ: 5 cố định
    zsend.clear()
    ok, _ = _with_deadline(clk.t + 12.0, lambda: zalo.send_text("u1", "x"))
    assert ok is True and zsend == [zalo.SEND_TIMEOUT_S]
    zsend.clear()
    assert zalo.send_text("u1", "x") is True and zsend == [zalo.SEND_TIMEOUT_S]


@pytest.mark.parametrize("left", [0.5, 0.0, -1.0])
def test_p1_zalo_first_send_budget_exhausted_no_call(zsend, monkeypatch,
                                                    left):
    clk = _Clock().install(monkeypatch)
    ok, late = _with_deadline(clk.t + left, lambda: zalo.send_text("u1", "x"))
    assert ok is False and late == "gui" and zsend == []
