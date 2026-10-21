"""Đợt hợp đồng C05 — ceo-02 việc chờ TGĐ quyết định / chờ ký
(agents.ceo_decisions.wait_lines + read; mốc `sign_required` từ da_pmo).
DB thật (schema tạm + roles ×2, ROLLBACK)."""

from datetime import date

import pytest

from agents import ceo_decisions as cd
from agents import da_pmo
from tests.test_ceo_audit import ceo_db

TODAY = date(2026, 11, 12)
ENQ = "select enqueue_item(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"


@pytest.fixture
def db():
    yield from ceo_db()


def _text(db):
    return "\n".join(cd.render_section(cd.read(db), TODAY))


def _sec(db):
    return _text(db).split("### Việc chờ TGĐ quyết định / chờ ký")[1]


def test_seed_flags_signature_milestones(db):
    st = da_pmo.seed(db, da_pmo.load_milestones())
    assert st["inserted"] >= 5
    rows = dict(db.execute("select code, sign_required from"
                           " project_milestones").fetchall())
    assert rows["DUYET-1111"] and rows["NGHIEM-THU-P1"]
    assert not rows.get("MOC-A", False)


def test_waiting_lists_and_clear(db):
    da_pmo.seed(db, da_pmo.load_milestones())
    # hạn = lúc enqueue + 48h (giờ thật 10/2026) → TODAY 12/11 là quá hạn
    db.execute(ENQ, ("weekly_report", "c5-1", "ceo", "Báo cáo tuần chờ TGĐ",
                     "payload", "low", '{"ok": true}', "none",
                     "agent:ceo_report", 48))
    db.execute("insert into revenue_quarters (quarter, period_start,"
               " period_end, report_sha256, recorded_by) values ('2026-Q4',"
               " '2026-10-01', '2027-01-01', %s, 'agent:rev_share')",
               ("a" * 64,))
    sec = _sec(db)
    assert "weekly_report · Báo cáo tuần chờ TGĐ" in sec and "QUÁ HẠN" in sec
    assert "DUYET-1111" in sec and "TRỄ 3 ngày" in sec
    assert "2026-Q4" in sec and "chưa có bằng chứng ký" in sec
    # mốc xong kèm bằng chứng (người ghi) → hết chờ ký; không suy "đã ký"
    db.execute("update project_milestones set status = 'xong', evidence ="
               " 'Văn bản số 12/QĐ' where code = 'DUYET-1111'")
    assert "DUYET-1111" not in _sec(db)


def test_unreadable_source_shown_not_silent(db):
    da_pmo.seed(db, da_pmo.load_milestones())
    data = cd.read(db)
    with db.transaction(force_rollback=True):
        db.execute("set local role app_human")   # không có revenue_quarters
        data["waiting_rev"] = cd._try(db, cd._WAIT_REV_SQL)
    assert data["waiting_rev"] is None
    assert "không đọc được — thiếu quyền/bảng" in "\n".join(
        cd.wait_lines(data, TODAY))


def test_svc_job_can_read_sources(db):
    da_pmo.seed(db, da_pmo.load_milestones())
    with db.transaction(force_rollback=True):
        db.execute("set local role svc_job")
        data = cd.read(db)
    assert data["waiting_queue"] == [] and data["waiting_rev"] == []
