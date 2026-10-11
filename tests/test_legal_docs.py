"""v4.4 W44.5 — docs/legal (mọi file là NHÁP) + JD/KPI 2 người vận hành:
KPI phải trỏ tới lệnh/bảng CÓ THẬT, hoặc ghi "CHƯA ĐO ĐƯỢC"."""

import re
from pathlib import Path

import pytest

from pipelines import auth

ROOT = Path(__file__).resolve().parent.parent
LEGAL = sorted((ROOT / "docs" / "legal").glob("*.md"))
JD = ROOT / "docs" / "handover" / "jd-kpi-van-hanh.md"
JD_TEXT = JD.read_text(encoding="utf-8")
SCHEMA = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
TABLES = set(re.findall(r"create table if not exists (\w+)", SCHEMA))
NOT_MEASURED = "CHƯA ĐO ĐƯỢC"


def test_legal_dir_has_all_docs():
    names = {p.name for p in LEGAL}
    assert len(LEGAL) >= 6
    assert {"DPIA-nhap.md", "TIA-nhap.md", "form-dong-y-NHAP.md",
            "mau-hop-dong-koc-NHAP.md",
            "mau-hop-dong-dai-ly-NHAP.md"} <= names


@pytest.mark.parametrize("p", LEGAL, ids=[p.name for p in LEGAL])
def test_legal_doc_is_draft(p):
    # read_text chuẩn hóa CRLF (checkout core.autocrlf=true).
    text = p.read_text(encoding="utf-8")
    assert "NHÁP" in "\n".join(text.splitlines()[:15])
    assert "đã tuân thủ" not in text.casefold()


def test_jd_markers():
    for w in ("NHÁP", "15 triệu", "10 triệu", "GỠ/ẨN", "chờ TGĐ duyệt"):
        assert w in JD_TEXT, w
    assert re.search(r"CẤM:[^\n]*approve thay người duyệt", JD_TEXT)
    assert "đã tuân thủ" not in JD_TEXT.casefold()


def test_jd_roles_exist_in_auth():
    for role in ("ha_tang", "mxh"):
        assert role in auth.ROLES
        assert f"`{role}`" in JD_TEXT


def test_jd_commands_exist():
    scripts = set(re.findall(r"scripts/(\w+)\.py", JD_TEXT))
    mods = set(re.findall(r"python -m ([\w.]+)", JD_TEXT))
    assert {"health_bulletin", "agent_eval", "db_backup", "db_restore_drill",
            "review_load", "dpia_draft"} <= scripts
    for s in scripts:
        assert (ROOT / "scripts" / f"{s}.py").is_file(), s
    assert mods
    for m in mods:
        assert (ROOT / (m.replace(".", "/") + ".py")).is_file(), m


def _kpi_rows():
    rows = []
    for ln in JD_TEXT.splitlines():
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if (ln.startswith("|") and len(cells) == 3
                and cells[0] not in ("Chỉ tiêu",)
                and not set(cells[0]) <= set("-")):
            rows.append(cells)
    return rows


def test_kpi_rows_have_real_source():
    rows = _kpi_rows()
    assert len(rows) >= 12
    for target, threshold, source in rows:
        assert threshold, target
        ticks = re.findall(r"`([^`]+)`", source)
        if NOT_MEASURED in source:
            continue
        assert ticks, f"KPI '{target}' thiếu nguồn đo thật"
        for t in ticks:
            if t.startswith("python "):
                continue                        # lệnh: kiểm ở test khác
            assert t in TABLES, f"bảng '{t}' không có trong schema.sql"


def test_kpi_unmeasured_named():
    assert JD_TEXT.count(NOT_MEASURED) >= 4
    for w in ("ticket gỡ 24h", "hậu kiểm", "≥20 câu"):
        assert w in JD_TEXT, w
