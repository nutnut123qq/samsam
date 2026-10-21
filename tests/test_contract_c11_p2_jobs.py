"""Đợt hợp đồng C11 — lịch P2: ceo-05 (HĐTV tháng), farming-05.1 (thời
tiết/sâu bệnh), farming-05.2 (dự báo sản lượng). Job ↔ timer khớp, lệnh
thật chạy được, HĐTV `--month prev` + chạy lại không nhân bản."""

import json
from pathlib import Path

import pytest

from agents import hdtv_report as hr
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
JOBS = json.loads((ROOT / "deploy" / "onprem" / "jobs.json").read_text(
    encoding="utf-8"))["jobs"]


@pytest.mark.parametrize("name,step,cal", [
    ("hdtv_month", ["-m", "agents.hdtv_report", "--month", "prev",
                    "--submit"], "*-*-03 08:30:00"),
    ("vt_weather", ["-m", "agents.vt_thoitiet", "--digest", "--fetch",
                    "--submit"], "*-*-* 06:30:00"),
    ("vt_harvest", ["-m", "agents.vt_thuhoach", "--submit"],
     "Mon *-*-* 08:20:00")])
def test_jobs_and_timers(name, step, cal):
    assert JOBS[name]["steps"] == [step]
    t = (ROOT / "deploy" / "onprem" / "systemd" /
         f"samsam-job-{name}.timer").read_text(encoding="utf-8")
    assert f"OnCalendar={cal}" in t and f"samsam-job@{name}.service" in t


@pytest.fixture
def db():
    yield from ceo_db()


def test_hdtv_prev_month_and_rerun_skip(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(hr, "connect", lambda: TxConn(db))
    argv = ["--month", "prev", "--now", "2026-11-03T08:30:00+07:00",
            "--submit", "--out-dir", str(tmp_path)]
    assert hr.main(argv) == 0
    out = capsys.readouterr().out
    assert "kỳ 2026-10" in out and "[submit]" in out
    assert hr.main(argv) == 0
    assert "[skipped] kỳ 2026-10 đã có mục" in capsys.readouterr().out
    assert db.execute("select count(*) from approval_queue where object_type"
                      " = 'hdtv_pack'").fetchone()[0] == 1


def test_weather_job_blocked_without_source(monkeypatch, capsys):
    from agents import vt_thoitiet as vt
    monkeypatch.setattr(vt, "connect", lambda: pytest.fail("không connect"),
                        raising=False)
    assert vt.main(["--digest", "--fetch", "--submit"]) == 2
    assert "--fetch chưa bật" in capsys.readouterr().out


# Vòng 2 (phép thử nâng cấp bằng login svc_job THẬT): job dưới login dịch vụ
# thiếu quyền đọc — có từ dda0089, test fixture owner không bắt được.
@pytest.mark.parametrize("table,cols", [
    ("plots", "id, status, source, tree_count, planted_year"),   # garden/vt
    ("allocation_proposals", None), ("bom_combos", None),        # bản tin SX
    ("bom_items", None), ("inventory_snapshots", None),
    ("v_promotable", None), ("cogs_versions", None),             # price_watch
    ("competitor_observations", None)])
def test_svc_job_can_read_job_sources(db, table, cols):
    if cols:
        for c in cols.split(", "):
            assert db.execute("select has_column_privilege('svc_job', %s, %s,"
                              " 'select')", (table, c)).fetchone()[0], c
        # không tọa độ/diện tích khoảnh
        assert not db.execute("select has_table_privilege('svc_job', %s,"
                              " 'select')", (table,)).fetchone()[0]
    else:
        assert db.execute("select has_table_privilege('svc_job', %s,"
                          " 'select')", (table,)).fetchone()[0]
