"""v3.10 — pipelines/freeze.py (lịch đóng băng) + scripts/break_glass.py.

Thời gian luôn qua tham số `now` — không wall-clock, không sleep.
"""

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import break_glass as bg

from pipelines import freeze

VN = timezone(timedelta(hours=7))
IN_FREEZE = datetime(2027, 1, 5, 10, 0, tzinfo=VN)
OUT_FREEZE = datetime(2026, 11, 5, 10, 0, tzinfo=VN)
ALLOWED = ("hotfix", "disable", "restore")
BLOCKED = ("feature", "promote", "config", "migration")


@pytest.fixture(autouse=True)
def _no_bg_env(monkeypatch):
    # .env thật không được lấp BREAK_GLASS_LOG (load_dotenv không ghi đè
    # biến đã có — setenv "" thay vì delenv).
    monkeypatch.setenv("BREAK_GLASS_LOG", "")


# ---------------- lịch ----------------

def test_calendar_drift_guard_matches_v35():
    """Khung 2026-12-21..2027-02-10 — nguồn lịch DUY NHẤT (v4.0:
    deploy_gate đọc file này; key `freeze` của data/eval/config.json đã
    bỏ — khóa không để lịch thứ hai mọc lại)."""
    raw = json.loads((ROOT / "data" / "freeze_calendar.json")
                     .read_text(encoding="utf-8"))
    assert "freeze" not in json.loads(
        (ROOT / "data" / "eval" / "config.json").read_text(encoding="utf-8"))
    assert [(w["start"], w["end"]) for w in raw["windows"]] == [
        ("2026-12-21", "2027-02-10")]
    cal = freeze.load_calendar()
    assert cal["allowed_in_freeze"] == list(ALLOWED)
    assert set(BLOCKED) | set(ALLOWED) == set(cal["known_kinds"])
    assert cal["break_glass_max_hours"] == 4
    assert cal["break_glass_holders"] == []


@pytest.mark.parametrize("when,frozen", [
    (datetime(2026, 12, 20, 23, 59, 59, tzinfo=VN), False),
    (datetime(2026, 12, 21, 0, 0, 0, tzinfo=VN), True),
    (datetime(2026, 12, 20, 17, 0, 0, tzinfo=timezone.utc), True),
    (datetime(2026, 12, 20, 16, 59, 59, tzinfo=timezone.utc), False),
    (datetime(2027, 2, 10, 23, 59, 59, tzinfo=VN), True),
    (datetime(2027, 2, 11, 0, 0, 0, tzinfo=VN), False),
    (datetime(2027, 2, 10, 17, 0, 0, tzinfo=timezone.utc), False),
    (date(2026, 12, 21), True),
    (date(2026, 12, 20), False),
    (date(2027, 2, 10), True),
])
def test_is_frozen_boundaries(when, frozen):
    assert freeze.is_frozen(when) is frozen


def test_is_frozen_types():
    with pytest.raises(ValueError):
        freeze.is_frozen(datetime(2026, 12, 25, 10, 0))  # noqa: DTZ001
    with pytest.raises(TypeError):
        freeze.is_frozen("2026-12-25")
    with pytest.raises(TypeError):
        freeze.is_frozen(None)


@pytest.mark.parametrize("kind", BLOCKED)
def test_check_blocks_normal_change_in_freeze(kind):
    ok, why = freeze.check(kind, IN_FREEZE, windows=[])
    assert ok is False
    assert "21/12/2026" in why and "10/02/2027" in why
    assert "chỉ hotfix/tắt agent/khôi phục" in why


@pytest.mark.parametrize("kind", ALLOWED)
def test_check_allows_hotfix_disable_restore_in_freeze(kind):
    assert freeze.check(kind, IN_FREEZE, windows=[])[0] is True


@pytest.mark.parametrize("kind", BLOCKED + ALLOWED)
def test_check_outside_freeze_allows(kind):
    assert freeze.check(kind, OUT_FREEZE, windows=[]) == (
        True, "ngoài khung đóng băng")


@pytest.mark.parametrize("now", [IN_FREEZE, OUT_FREEZE])
def test_check_unknown_kind_raises(now):
    with pytest.raises(ValueError):
        freeze.check("deploy_moi", now, windows=[])


def test_check_naive_now_raises():
    with pytest.raises(ValueError):
        freeze.check("hotfix", datetime(2027, 1, 5, 10, 0), windows=[])  # noqa: DTZ001


GOOD = json.loads((ROOT / "data" / "freeze_calendar.json")
                  .read_text(encoding="utf-8"))


def _variant(name: str):
    """Trả bytes nội dung file lịch hỏng (None = file mất)."""
    def dump(obj):
        return json.dumps(obj).encode("utf-8")
    if name == "missing":
        return None
    if name == "empty":
        return b""
    if name == "obj_empty":
        return b"{}"
    if name == "only_doc":
        return dump({"_doc": GOOD["_doc"]})
    if name == "windows_empty":
        return dump({**GOOD, "windows": []})
    if name == "json_broken":
        return b'{"windows": [{"start": "2026-12-21"'
    if name == "start_gt_end":
        return dump({**GOOD, "windows": [
            {"name": "x", "start": "2027-02-10", "end": "2026-12-21"}]})
    if name == "date_suffix":
        return dump({**GOOD, "windows": [
            {"name": "x", "start": "2026-12-21x", "end": "2027-02-10"}]})
    if name == "date_vn_format":
        return dump({**GOOD, "windows": [
            {"name": "x", "start": "21/12/2026", "end": "2027-02-10"}]})
    if name == "allowed_not_known":
        return dump({**GOOD, "allowed_in_freeze": ["hotfix", "yolo"]})
    raise AssertionError(name)


BROKEN = ("missing", "empty", "obj_empty", "only_doc", "windows_empty",
          "json_broken", "start_gt_end", "date_suffix", "date_vn_format",
          "allowed_not_known")


@pytest.mark.parametrize("variant", BROKEN)
def test_broken_calendar_fail_closed(monkeypatch, tmp_path, variant):
    p = tmp_path / "freeze_calendar.json"
    body = _variant(variant)
    if body is not None:
        p.write_bytes(body)
    monkeypatch.setattr(freeze, "CALENDAR", p)
    with pytest.raises(freeze.FreezeConfigError):
        freeze.load_calendar()
    with pytest.raises(freeze.FreezeConfigError):
        freeze.is_frozen(IN_FREEZE)
    # Fail-closed: kind thường bị chặn cả TRONG lẫn NGOÀI khung, kể cả khi
    # có break-glass hợp lệ (không có trần giờ đáng tin).
    win = [{"action": "open", "opened_at": IN_FREEZE - timedelta(hours=1),
            "expires_at": IN_FREEZE + timedelta(hours=1), "by": "A",
            "reason": "x", "holder_verified": False}]
    for now in (IN_FREEZE, OUT_FREEZE):
        ok, why = freeze.check("feature", now, windows=win)
        assert ok is False and "lịch đóng băng lỗi" in why
        for kind in ALLOWED:
            assert freeze.check(kind, now, windows=[])[0] is True


def test_freeze_module_is_pure():
    src = (ROOT / "pipelines" / "freeze.py").read_text(encoding="utf-8")
    for bad in ("print(", "psycopg", "subprocess"):
        assert bad not in src, bad


# ---------------- break-glass ----------------

T = datetime(2027, 1, 5, 9, 0, 0, tzinfo=VN)
REASON = "Sự cố webhook Zalo cần đổi cấu hình gấp"


@pytest.fixture
def bglog(monkeypatch, tmp_path):
    p = tmp_path / "bg" / "break_glass.jsonl"
    monkeypatch.setenv("BREAK_GLASS_LOG", str(p))
    return p


def _open(now=T, hours="2", reason=REASON, by="Nguyễn Văn A"):
    argv = ["--open", "--reason", reason, "--by", by]
    if hours is not None:
        argv += ["--hours", hours]
    return bg.main(argv, now=now)


def _allowed_at(path: Path, now: datetime) -> bool:
    return freeze.check("feature", now,
                        windows=freeze.load_break_glass(path))[0]


def test_open_window_expires_exactly(bglog, capsys):
    assert _open() == 0
    out = capsys.readouterr().out
    assert "BREAK-GLASS mở tới 11:00 05/01/2027 bởi Nguyễn Văn A" in out
    assert "chưa được công ty cấp (external-dep)" in out
    rec = json.loads(bglog.read_bytes().split(b"\n")[0])
    assert rec["holder_verified"] is False
    assert rec["expires_at"] == "2027-01-05T11:00:00+07:00"
    assert _allowed_at(bglog, T) is True
    assert _allowed_at(bglog, T + timedelta(hours=1)) is True
    assert _allowed_at(bglog, T + timedelta(hours=2)) is False  # biên
    assert _allowed_at(bglog, T - timedelta(seconds=1)) is False


def test_check_reads_log_from_env(bglog):
    assert freeze.check("feature", T + timedelta(minutes=5))[0] is False
    assert _open() == 0
    ok, why = freeze.check("feature", T + timedelta(minutes=5))
    assert ok is True and "BREAK-GLASS" in why and "Nguyễn Văn A" in why


@pytest.mark.parametrize("hours", ["5", "0", "-1"])
def test_hours_out_of_range_exit2_no_write(bglog, hours):
    assert _open(hours=hours) == 2
    assert not bglog.exists()


def test_hand_edited_48h_is_capped(bglog):
    bglog.parent.mkdir(parents=True)
    rec = {"action": "open", "ts": T.isoformat(), "opened_at": T.isoformat(),
           "expires_at": (T + timedelta(hours=48)).isoformat(), "hours": 48,
           "by": "X", "reason": "sửa tay log", "holder_verified": False}
    bglog.write_bytes(json.dumps(rec).encode() + b"\n")
    assert _allowed_at(bglog, T + timedelta(hours=3)) is True
    assert _allowed_at(bglog, T + timedelta(hours=4)) is False
    assert _allowed_at(bglog, T + timedelta(hours=5)) is False


def test_future_opened_at_not_active(bglog):
    assert _open(now=T + timedelta(hours=1)) == 0
    assert _allowed_at(bglog, T + timedelta(minutes=30)) is False


def test_close_early(bglog, capsys):
    assert _open() == 0
    before = bglog.read_bytes()
    assert bg.main(["--close", "--by", "Nguyễn Văn A", "--reason",
                    "Đã xử lý xong sự cố webhook"],
                   now=T + timedelta(minutes=30)) == 0
    assert bglog.read_bytes().startswith(before)
    assert _allowed_at(bglog, T + timedelta(minutes=29)) is True
    assert _allowed_at(bglog, T + timedelta(minutes=31)) is False
    # Mở lại sau khi đóng → cửa sổ mới có hiệu lực (close cũ không chặn).
    assert _open(now=T + timedelta(hours=1)) == 0
    assert _allowed_at(bglog, T + timedelta(hours=1, minutes=1)) is True


def test_close_without_active_writes_nothing(bglog):
    assert bg.main(["--close", "--by", "A", "--reason", "không có gì mở"],
                   now=T) == 0
    assert not bglog.exists()


@pytest.mark.parametrize("argv", [
    ["--open", "--by", "A"],                                # thiếu reason
    ["--open", "--by", "A", "--reason", "123456789"],       # 9 ký tự
    ["--open", "--by", "A", "--reason", "   123456789   "],  # 9 sau strip
    ["--open", "--reason", REASON],                         # thiếu by
    ["--open", "--reason", REASON, "--by", "  "],
    ["--open", "--reason", REASON, "--by", "x" * 81],
    ["--open", "--reason", REASON, "--by", "A\x1b[31m"],
    ["--open", "--status", "--reason", REASON, "--by", "A"],
    ["--open", "--close", "--reason", REASON, "--by", "A"],
    [],
    ["--status", "--hours", "2"],
    ["--close", "--by", "A"],
])
def test_usage_exit2_file_unchanged(bglog, argv):
    assert _open() == 0
    before = bglog.read_bytes()
    assert bg.main(argv, now=T + timedelta(minutes=1)) == 2
    assert bglog.read_bytes() == before


@pytest.mark.parametrize("where", ["", "repo"])
def test_log_must_be_set_and_outside_repo(monkeypatch, where):
    target = ROOT / "data" / "bg_test_should_not_exist.jsonl"
    monkeypatch.setenv("BREAK_GLASS_LOG", str(target) if where else "")
    for argv in (["--open", "--reason", REASON, "--by", "A"], ["--status"]):
        assert bg.main(argv, now=T) == 2
    assert not target.exists()


def test_reader_skips_bad_lines(bglog, capsys):
    bglog.parent.mkdir(parents=True)
    # U+2028 viết escape (AGENTS.md: không nhúng literal vô hình vào source);
    # ensure_ascii=False để byte U+2028 THẬT nằm trong log — splitlines()
    # cắt đôi record ở ký tự này, reader phải split b"\n" tường minh.
    reason = "dòng\u2028có ký tự lạ"
    good = {"action": "open", "ts": T.isoformat(),
            "opened_at": T.isoformat(),
            "expires_at": (T + timedelta(hours=1)).isoformat(), "hours": 1,
            "by": "B", "reason": reason, "holder_verified": False}
    naive = {**good, "opened_at": "2027-01-05T09:00:00"}
    no_by = {k: v for k, v in good.items() if k != "by"}
    good_line = json.dumps(good, ensure_ascii=False).encode()
    assert "\u2028".encode() in good_line
    body = (b"{not json\n"
            + good_line + b"\n"
            + json.dumps(naive).encode() + b"\n"
            + json.dumps(no_by).encode() + b"\n"
            + b"\xff\xfe garbage\n"
            + b'{"action": "close", "ts": "2027-01-05T09:1')  # ghi dở
    bglog.write_bytes(body)
    bad: list[int] = []
    recs = freeze.load_break_glass(bglog, bad)
    assert len(recs) == 1 and recs[0]["reason"] == reason
    assert bad == [1, 3, 4, 5, 6]
    assert _allowed_at(bglog, T + timedelta(minutes=10)) is True
    # --status: U+2028 không in raw ra terminal (thay '?').
    capsys.readouterr()
    assert bg.main(["--status"], now=T + timedelta(minutes=10)) == 0
    out = capsys.readouterr().out
    assert "\u2028" not in out and "dòng?có ký tự lạ" in out
    # Append sau dòng ghi dở: record mới nằm trên dòng riêng, đọc được.
    assert _open(now=T + timedelta(hours=2)) == 0
    assert bglog.read_bytes().startswith(body)
    assert len(freeze.load_break_glass(bglog)) == 2


def test_reason_pii_masked(bglog):
    assert _open(reason="Khách 0905 123 456 báo lỗi đơn hàng gấp") == 0
    body = bglog.read_bytes().decode("utf-8")
    assert "0905123456" not in body and "0905 123 456" not in body


def test_append_only_two_opens(bglog):
    assert _open() == 0
    first = bglog.read_bytes()
    assert _open(now=T + timedelta(minutes=5)) == 0
    after = bglog.read_bytes()
    assert after.startswith(first) and len(after) > len(first)
    assert after.count(b"\n") == 2


def test_holders_enforced(bglog, monkeypatch, tmp_path):
    cal = {**GOOD, "break_glass_holders": ["Tên A"]}
    p = tmp_path / "cal.json"
    p.write_text(json.dumps(cal), encoding="utf-8")
    monkeypatch.setattr(freeze, "CALENDAR", p)
    assert _open(by="Tên B") == 2
    assert not bglog.exists()
    assert _open(by="  tên a ") == 0
    rec = json.loads(bglog.read_bytes().split(b"\n")[0])
    assert rec["holder_verified"] is True and rec["by"] == "tên a"


def test_broken_calendar_open_exit1(bglog, monkeypatch, tmp_path):
    monkeypatch.setattr(freeze, "CALENDAR", tmp_path / "missing.json")
    assert _open() == 1
    assert not bglog.exists()


def test_open_outside_freeze_warns(bglog, capsys):
    assert _open(now=OUT_FREEZE) == 0
    assert "KHÔNG trong khung đóng băng" in capsys.readouterr().out


def test_status_lists_active(bglog, capsys):
    assert _open() == 0
    capsys.readouterr()
    assert bg.main(["--status"], now=T + timedelta(minutes=10)) == 0
    out = capsys.readouterr().out
    assert "ĐANG đóng băng" in out and "1 cửa sổ" in out
    assert "Nguyễn Văn A" in out and "11:00 05/01/2027" in out
    assert bg.main(["--status"], now=T + timedelta(hours=2)) == 0
    assert "0 cửa sổ" in capsys.readouterr().out


def test_control_chars_from_log_not_honored_or_printed(bglog, capsys):
    """Log sửa tay: `by` chứa ANSI → record bị bỏ (fail-closed); reason chứa
    ký tự điều khiển → --status in đã thay '?' (không chèn escape terminal)."""
    bglog.parent.mkdir(parents=True)
    base = {"action": "open", "ts": T.isoformat(), "opened_at": T.isoformat(),
            "expires_at": (T + timedelta(hours=1)).isoformat(), "hours": 1,
            "holder_verified": False}
    evil_by = {**base, "by": "X\x1b[2J", "reason": "abcdefghijk"}
    evil_reason = {**base, "by": "Y", "reason": "lý do\x1b[2Jxoá màn hình"}
    bglog.write_bytes(json.dumps(evil_by).encode() + b"\n"
                      + json.dumps(evil_reason).encode() + b"\n")
    recs = freeze.load_break_glass(bglog)
    assert [r["by"] for r in recs] == ["Y"]
    assert bg.main(["--status"], now=T + timedelta(minutes=1)) == 0
    out = capsys.readouterr().out
    assert "\x1b" not in out and "lý do?[2Jxoá màn hình" in out

