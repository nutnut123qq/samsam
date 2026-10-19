"""v15 fix P8.1 — loại mock/mẫu khỏi bộ đếm đầu ra thật (sales-01 convlog).

Lỗi tái hiện (`evidence/v15_resume_pure_probes.log`): `rollout._conv_row` đếm
bản ghi `{"msg_id": "mock0-…", "answered": true, "sent": true,
"guardrail_ok": true}` — kể cả khi có `is_sample=True` — vì convlog không có
trường provenance và bộ đếm chỉ nhìn answered/sent/guardrail.

Probe (FAIL trên bản trước sửa, ĐẠT sau sửa — trừ probe "thật vẫn tính" là
probe không-hồi-quy, ĐẠT cả hai):
  * chạy ĐƯỜNG GHI mock thật (`scripts/zalo_mock.py` → webhook Handler thật
    → `_reply_turn` → `_log_conversation`) với answer giả → 0 đầu ra;
  * transport giả (test/replay gọi `handle_text` với `send=` giả) → 0;
  * dict mẫu: không provenance (bản ghi cũ), `is_sample=True`, provenance
    mẫu, dry_run/replay/mock, provenance rác → 0; dòng hỏng không thành thật;
  * đường gửi THẬT (transport Zalo/Messenger thật, chỉ lớp HTTP giả) → tính,
    trùng chính/`.1` tính 1;
  * 50 dòng mẫu rải 5 ngày làm việc → cổng chay_thu KHÔNG đạt.
Không cần DB (nguồn file convlog không đọc DB)."""

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from connectors import channels as ch
from connectors import messenger, zalo
from pipelines import rollout as ro
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
F = {"id": "sales-01", "output_sources": [{"file": "conversations.jsonl"}]}
SHIFT = ro.load_shift()          # lịch repo: T2–T6, không ngày nghỉ tháng 10
S1 = datetime(2026, 10, 1, tzinfo=VN_TZ)
N1 = datetime(2026, 10, 10, tzinfo=VN_TZ)
# Đúng bản ghi trong spec lỗi (evidence v15_resume_pure_probes.log).
SPEC_MOCK = {"ts": "2026-10-16T09:00:00+07:00", "channel": "zalo",
             "msg_id": "mock0-1234567890123", "answered": True, "sent": True,
             "guardrail_ok": True}


@pytest.fixture(autouse=True)
def _iso(monkeypatch, tmp_path):
    """convlog/dedup/token/nhân viên vườn sang tmp; bộ đếm đọc cùng thư mục;
    không muối (lớp kênh không chạm DB); chatbot vận hành (gửi câu bot)."""
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "TOKEN_STORE", tmp_path / "zalo_tokens.json")
    monkeypatch.setattr(zalo, "_last_refresh", float("-inf"))
    monkeypatch.setattr(zalo, "_last_refresh_ok", float("-inf"))
    monkeypatch.setattr(zalo, "_mem_tokens", {})
    monkeypatch.setattr(zalo, "_last_purge", float("-inf"))
    monkeypatch.setattr(zalo, "_last_purge_attempt", float("-inf"))
    monkeypatch.setattr(zalo.zalo_garden, "STAFF_FILE",
                        tmp_path / "garden_staff.json")
    monkeypatch.setattr(zalo.zalo_garden, "_staff", (None, {}))
    monkeypatch.setattr(zalo.zalo_garden, "_last_plot", {})
    monkeypatch.delenv("CHANNEL_HASH_SALT", raising=False)
    monkeypatch.setattr(ro, "DATA_DIR", tmp_path)
    monkeypatch.setattr(ch, "chatbot_mode", lambda: "van_hanh")
    monkeypatch.setattr("api.rag.answer", lambda q, history=None: {
        "answer": "Dạ sản phẩm có giá niêm yết trên website.",
        "sources": ["https://samsamngoclinh.com/a"]})
    zalo._histories.clear()
    ch.reset_cache()
    yield
    zalo._histories.clear()
    ch.reset_cache()


def _recs(tmp_path) -> list[dict]:
    p = tmp_path / "conversations.jsonl"
    return [json.loads(ln) for ln in p.read_bytes().split(b"\n") if ln]


def _write(path: Path, recs) -> None:
    path.write_bytes(b"".join(
        (r if isinstance(r, bytes) else json.dumps(r, ensure_ascii=False)
         .encode("utf-8")) + b"\n" for r in recs))


def _rec(ts, mid, **kw):
    r = {"ts": ts, "msg_id": mid, "user_hash": "uh-p81", "question": "giá",
         "answer": "x", "answered": True, "sent": True, "guardrail_ok": True,
         "channel": "zalo"}
    r.update(kw)
    return r


def _win():
    now = datetime.now(timezone.utc)
    return now - timedelta(days=1), now + timedelta(hours=1)


# ------------------------------------------------- đường ghi mock THẬT


def test_p81_zalo_mock_script_write_path_not_counted(monkeypatch, tmp_path):
    """Chạy `scripts/zalo_mock.py` thật: webhook Handler thật + chữ ký mock +
    `_reply_turn` + `_log_conversation`; chỉ answer() giả (không DB/LLM).
    Câu bot của mock có answered/sent/guardrail True nhưng KHÔNG phải đầu
    ra thật → 0."""
    for k in ("APP_ID", "OA_SECRET", "ACCESS_TOKEN", "send_text"):
        monkeypatch.setattr(zalo, k, getattr(zalo, k))  # khôi phục sau test
    if hasattr(zalo, "CONV_SAMPLE"):
        monkeypatch.setattr(zalo, "CONV_SAMPLE", zalo.CONV_SAMPLE)
    spec = importlib.util.spec_from_file_location(
        "zalo_mock_p81", ROOT / "scripts" / "zalo_mock.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.main()                                   # exit code không quan trọng
    recs = _recs(tmp_path)
    bot = [r for r in recs if r.get("answered") is True]
    # đường mock thật đã ghi câu bot "đã gửi, đạt guardrail"
    assert len(bot) == 2 and all(r["sent"] is True and r["guardrail_ok"]
                                 is True for r in bot)
    a, b = _win()
    o = ro.output_facts(None, F, a, b, SHIFT)
    assert o["outputs"] == 0, recs


def test_p81_fake_transport_replay_not_counted(tmp_path):
    """Replay/test gọi `handle_text` với transport giả (send= trả True) —
    câu bot không tới khách thật → 0 đầu ra; Messenger cũng vậy."""
    zalo.handle_text("u-replay", "giá sâm?", "rp-1",
                     send=lambda u, t: True)
    zalo.handle_text("messenger:123", "giá sâm?", "rp-2",
                     channel="messenger", send=lambda u, t: True)
    recs = _recs(tmp_path)
    assert [r["answered"] for r in recs] == [True, True]
    a, b = _win()
    assert ro.output_facts(None, F, a, b, SHIFT)["outputs"] == 0


# ------------------------------------------------- đường gửi THẬT vẫn tính


def test_p81_live_transport_counted_and_dedup_rotation(monkeypatch,
                                                       tmp_path):
    """Transport THẬT (`zalo.send_text`/`messenger.send_text`, chỉ lớp HTTP
    giả) → đầu ra tính; trùng khóa giữa file chính và `.1` tính 1."""
    monkeypatch.setattr(zalo, "_current_access_token", lambda: "tok")
    monkeypatch.setattr(zalo, "_can_refresh", lambda: False)
    monkeypatch.setattr(zalo, "_send_once",
                        lambda u, t, tok, timeout=None: True)
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setenv("MESSENGER_PAGE_TOKEN", "page-token-gia")

    class _R:
        status_code = 200
    monkeypatch.setattr(messenger.httpx, "post", lambda *a, **k: _R())
    zalo.handle_text("u-live", "giá sâm?", "live-1")
    zalo.handle_text("messenger:456", "giá sâm?", "live-2",
                     channel="messenger", send=messenger.send_text)
    recs = _recs(tmp_path)
    assert [r["sent"] for r in recs] == [True, True]
    a, b = _win()
    assert ro.output_facts(None, F, a, b, SHIFT)["outputs"] == 2
    # xoay vòng: cùng dòng thật nằm cả `.1` → vẫn 2
    (tmp_path / "conversations.jsonl.1").write_bytes(
        (tmp_path / "conversations.jsonl").read_bytes())
    o = ro.output_facts(None, F, a, b, SHIFT)
    assert o["outputs"] == 2 and o["uncounted"] == []


# ------------------------------------------------- dict mẫu / thiếu provenance


def test_p81_sample_and_legacy_records_not_counted(tmp_path):
    ts = "2026-10-05T03:00:00Z"
    _write(tmp_path / "conversations.jsonl", [
        SPEC_MOCK,                                         # bản ghi cũ
        dict(SPEC_MOCK, msg_id="mock1-1", is_sample=True),
        _rec(ts, "s1", provenance="sample", is_sample=True),
        _rec(ts, "s2", provenance="live", is_sample=True),
        _rec(ts, "s3", provenance="live", dry_run=True),
        _rec(ts, "s4", provenance="live", replay=True),
        _rec(ts, "s5", provenance="live", mock=True),
        _rec(ts, "s6", provenance="LIVE"),
        _rec(ts, "s7", provenance=["live"]),
        _rec(ts, "s8", provenance="unknown"),
        _rec(ts, "s9"),                                    # thiếu provenance
    ])
    o = ro.output_facts(None, F, S1, N1, SHIFT)
    assert o["outputs"] == 0 and o["out_days"] == 0


def test_p81_live_record_counted_bad_lines_never_real(tmp_path):
    """Thật hợp lệ (provenance live) tính; DISTINCT kênh+msg_id; dòng hỏng
    → 'dòng hỏng' (uncounted), không bao giờ thành đầu ra thật."""
    ts = "2026-10-05T03:00:00Z"
    _write(tmp_path / "conversations.jsonl.1", [
        _rec(ts, "m1", provenance="live")])
    _write(tmp_path / "conversations.jsonl", [
        _rec(ts, "m1", provenance="live"),                 # trùng .1
        _rec("2026-10-06T03:00:00Z", "m2", channel="messenger",
             provenance="live"),
        _rec(ts, "m3", provenance="live", channel="streamlit"),
        _rec("2026-10-05 03:00", "m4", provenance="live"),  # ts hỏng
        b"{hong",
        _rec(ts, "m6"),                     # bản ghi cũ: thiếu provenance
    ])
    o = ro.output_facts(None, F, S1, N1, SHIFT)
    assert o["outputs"] == 2 and o["out_days"] == 2, o
    assert any("2 dòng hỏng" in u for u in o["uncounted"]), o
    assert any("thiếu provenance" in u for u in o["uncounted"]), o


def test_p81_fifty_sample_lines_five_workdays_gate_blocked(tmp_path):
    """50 dòng mẫu (mock/is_sample) rải 5 ngày làm việc T2–T6 → 0 đầu ra
    → cổng chạy thử KHÔNG đạt."""
    recs = []
    for i in range(50):
        day = 5 + i % 5                                   # 05..09/10 = T2–T6
        r = _rec(f"2026-10-{day:02d}T03:{i:02d}:00Z", f"mock{i}-{1000 + i}")
        if i % 2:
            r["is_sample"] = True
        recs.append(r)
    _write(tmp_path / "conversations.jsonl", recs)
    o = ro.output_facts(None, F, S1, N1, SHIFT)
    tgt, why = ro.evaluate("chay_thu", 9, o["outputs"], 0, o["out_days"])
    assert tgt == "co_nguoi_duyet" and why, (o, why)
    assert o["outputs"] == 0
