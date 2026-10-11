"""Drift-guard cho bộ tài liệu bàn giao WS4 (v2.3) — gate W6.4.

Bắt drift giữa docs/handover/ và code/data thật:
  - 8 file handover tồn tại + non-empty.
  - Tab names trong playbook/kien-truc khớp `st.tabs` trong
    app/streamlit_app.py (parse source, không hardcode).
  - phu-luc-d.md chứa đủ id câu hỏi parse từ tests/questions.md.
  - sop.md chứa các lệnh cốt vận hành.
  - kien-truc.md liệt kê đủ tên bảng parse từ docs/schema.sql + đúng
    số lượng bảng.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HANDOVER = ROOT / "docs" / "handover"

DOC_FILES = (
    "playbook-mkt.md",
    "playbook-sales-admin.md",
    "playbook-vuon.md",
    "workshops.md",
    "sop.md",
    "kien-truc.md",
    "prompt-library.md",
    "phu-luc-d.md",
)

# Tab nào thuộc vai trò nào — theo checklist W6.1. Tên phải khớp đúng
# chuỗi trong st.tabs (assert chéo trong test_tab_names_real()).
PLAYBOOK_TABS = {
    "playbook-mkt.md": ("Content Studio", "Duyệt & Lịch", "Báo cáo"),
    "playbook-sales-admin.md": ("Chat Sâm Sâm", "Chưa trả lời", "Leads"),
    "playbook-vuon.md": ("Nhật ký vườn",),
}

SOP_COMMANDS = ("streamlit run", "apply_schema", "lead_store",
                "agents.report", "agents.garden", "pipelines.store")


def _doc(name: str) -> str:
    return (HANDOVER / name).read_text(encoding="utf-8")


def _tab_names() -> list[str]:
    """Parse list tên tab thật từ st.tabs([...]) trong streamlit_app."""
    src = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    m = re.search(r"st\.tabs\(\s*\[(.*?)\]", src, re.DOTALL)
    assert m, "không parse được st.tabs trong streamlit_app.py"
    return re.findall(r'"([^"]+)"', m.group(1))


def _question_ids() -> list[int]:
    """Parse 'N. câu → ...' từ questions.md — cùng rule eval_qa."""
    qs = []
    for line in (ROOT / "tests" / "questions.md").read_text(
            encoding="utf-8").splitlines():
        m = re.match(r"^\s*(\d+)\.\s+(.+?)\s*→", line)
        if m:
            qs.append(int(m.group(1)))
    return qs


def _table_names() -> list[str]:
    """Parse 'create table if not exists <name>' từ docs/schema.sql."""
    src = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    return re.findall(r"create table if not exists (\w+)", src)


def test_doc_files_exist_nonempty():
    for name in DOC_FILES:
        p = HANDOVER / name
        assert p.is_file(), f"thiếu {name}"
        assert len(p.read_text(encoding="utf-8").strip()) > 500, (
            f"{name} rỗng/stub")


def test_tab_names_real():
    """Playbook chỉ được nhắc tab tồn tại thật trong st.tabs."""
    tabs = set(_tab_names())
    required = {t for names in PLAYBOOK_TABS.values() for t in names}
    assert required <= tabs, (
        f"tab checklist không còn trong st.tabs: {required - tabs}")
    # Mỗi playbook chứa đúng tab của vai trò đó (word-boundary —
    # substring 'Leads' trong 'misleads' không tính).
    for name, names in PLAYBOOK_TABS.items():
        body = _doc(name)
        for t in names:
            assert re.search(
                rf"(?<!\w){re.escape(t)}(?!\w)", body), \
                f"{name} thiếu tab '{t}'"
    # kien-truc.md liệt kê đủ mọi tab (không sót tab nào).
    arch = _doc("kien-truc.md")
    for t in tabs:
        assert re.search(rf"(?<!\w){re.escape(t)}(?!\w)", arch), \
            f"kien-truc.md thiếu tab '{t}'"


def test_phu_luc_d_covers_all_questions():
    body = _doc("phu-luc-d.md")
    ids = _question_ids()
    assert ids == sorted(ids) and len(ids) == 12, (
        f"questions.md parse được {ids} — contract 12 câu đổi?")
    for n in ids:
        # Word-boundary: 'Q1' phải khớp đúng 'Q1', không ăn ké 'Q10'
        # (audit-bù MINOR — substring cũ pass-ảo khi mất Q1).
        assert re.search(rf"\bQ{n}\b", body), f"phu-luc-d.md thiếu Q{n}"
    # 2 câu bẫy phải được đánh dấu rõ.
    assert "NO_DATA" in body and "bẫy" in body


def test_sop_core_commands():
    body = _doc("sop.md")
    for cmd in SOP_COMMANDS:
        assert cmd in body, f"sop.md thiếu lệnh '{cmd}'"


def test_kien_truc_lists_all_tables():
    body = _doc("kien-truc.md")
    tables = _table_names()
    assert len(tables) == 9, (
        f"schema.sql có {len(tables)} bảng ({tables}) — contract "
        "9 bảng đổi thì cập nhật kien-truc.md")
    for t in tables:
        assert t in body, f"kien-truc.md thiếu bảng '{t}'"
    # Doc tuyên bố đúng số bảng hiện có (drift-guard số lượng).
    assert f"{len(tables)} bảng" in body


def test_guardrail_test_names_in_phu_luc_d():
    """Case guardrail trích đúng tên test thật trong test_guardrail.py."""
    src = (ROOT / "tests" / "test_guardrail.py").read_text(
        encoding="utf-8")
    names = re.findall(r"def (test_\w+)\(", src)
    body = _doc("phu-luc-d.md")
    for n in names:
        assert n in body, f"phu-luc-d.md thiếu case '{n}'"
