"""Drift-guard cho bộ tài liệu bàn giao WS4 (v2.3) — gate W6.4.

Bắt drift giữa docs/handover/ và code/data thật:
  - 8 file handover tồn tại + non-empty.
  - Tab names trong playbook/kien-truc khớp `TABS` trong
    pipelines/auth.py (v3.4: nguồn duy nhất — streamlit_app tạo tab theo
    vai trò từ đó; parse AST, không import, không hardcode).
  - phu-luc-d.md chứa đủ id câu hỏi parse từ tests/questions.md.
  - sop.md chứa các lệnh cốt vận hành.
  - kien-truc.md liệt kê đủ tên bảng parse từ docs/schema.sql + đúng
    số lượng bảng.
  - phu-luc-d.md ghi đúng số câu bẫy/disclaimer/tổng case guardrail
    (parse AST tests/test_guardrail.py) — v3.0.
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
    "runbook-ha-tang.md",
)

# Tab nào thuộc vai trò nào — theo checklist W6.1. Tên phải khớp đúng
# chuỗi trong TABS (pipelines/auth.py — assert chéo trong test_tab_names_real()).
PLAYBOOK_TABS = {
    "playbook-mkt.md": ("Content Studio", "Duyệt & Lịch", "Báo cáo"),
    "playbook-sales-admin.md": ("Chat Sâm Sâm", "Chưa trả lời", "Leads"),
    "playbook-vuon.md": ("Nhật ký vườn",),
}

SOP_COMMANDS = ("streamlit run", "apply_schema", "lead_store",
                "agents.report", "agents.garden", "pipelines.store",
                "ingest.market_csv", "agent_eval", "deploy_gate",
                "health_bulletin", "docker-compose.monitoring.yml",
                "pipelines.auth",
                "db_backup", "db_restore_drill", "dr_drill",
                "break_glass", "pipelines.approval_queue",
                "pipelines.director", "pipelines.red_alert", "crawler.intel",
                "agents.sales_director")


def _doc(name: str) -> str:
    return (HANDOVER / name).read_text(encoding="utf-8")


def _tab_names() -> list[str]:
    """Parse tuple tên tab thật `TABS = (...)` trong pipelines/auth.py
    (AST, không import). streamlit_app phải tạo tab từ đó."""
    import ast

    src = (ROOT / "pipelines" / "auth.py").read_text(encoding="utf-8")
    tabs = [ast.literal_eval(n.value) for n in ast.parse(src).body
            if isinstance(n, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "TABS"
                for t in n.targets)]
    assert len(tabs) == 1, "không parse được TABS trong pipelines/auth.py"
    app = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    assert "st.tabs(" in app and "_auth.tabs_for(" in app, (
        "streamlit_app.py không còn tạo tab từ pipelines.auth")
    return list(tabs[0])


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
    # Mỗi playbook chứa đúng tab của vai trò đó.
    for name, names in PLAYBOOK_TABS.items():
        body = _doc(name)
        for t in names:
            assert t in body, f"{name} thiếu tab '{t}'"
    # kien-truc.md liệt kê đủ mọi tab (không sót tab nào).
    arch = _doc("kien-truc.md")
    for t in tabs:
        assert t in arch, f"kien-truc.md thiếu tab '{t}'"


def test_phu_luc_d_covers_all_questions():
    body = _doc("phu-luc-d.md")
    ids = _question_ids()
    assert ids == sorted(ids) and len(ids) == 12, (
        f"questions.md parse được {ids} — contract 12 câu đổi?")
    for n in ids:
        assert f"Q{n}" in body, f"phu-luc-d.md thiếu Q{n}"
    # 2 câu bẫy phải được đánh dấu rõ.
    assert "NO_DATA" in body and "bẫy" in body


def test_sop_core_commands():
    body = _doc("sop.md")
    for cmd in SOP_COMMANDS:
        assert cmd in body, f"sop.md thiếu lệnh '{cmd}'"


def test_kien_truc_lists_all_tables():
    body = _doc("kien-truc.md")
    tables = _table_names()
    assert tables, "schema.sql không parse được bảng nào"
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


def test_guardrail_case_counts_in_phu_luc_d():
    """Số câu bẫy / disclaimer / tổng case trong phu-luc-d khớp test thật.

    Pháp chế duyệt 'bộ câu bẫy' theo doc này — số sai là drift (v3.0 vòng
    3 thêm 4 câu, doc vẫn ghi 14/35). Parse AST, không import test module.
    """
    import ast

    tree = ast.parse((ROOT / "tests" / "test_guardrail.py").read_text(
        encoding="utf-8"))
    lists = {
        t.id: len(ast.literal_eval(node.value))
        for node in tree.body if isinstance(node, ast.Assign)
        for t in node.targets
        if isinstance(t, ast.Name) and isinstance(node.value, ast.List)
    }
    n_tests = n_cases = 0
    for fn in tree.body:
        if not (isinstance(fn, ast.FunctionDef)
                and fn.name.startswith("test_")):
            continue
        n_tests += 1
        size = 1
        for d in fn.decorator_list:
            if (isinstance(d, ast.Call) and getattr(d.func, "attr", "")
                    == "parametrize" and isinstance(d.args[1], ast.Name)):
                size = lists[d.args[1].id]
        n_cases += size
    body = _doc("phu-luc-d.md")
    n_aff = lists["AFFIRMATIVE_THAY_THE_THUOC"]
    n_disc = lists["DISCLAIMER_VARIANTS"]
    assert f"`test_affirmative_thay_the_thuoc_flagged` | {n_aff} câu bẫy" \
        in body, f"phu-luc-d.md phải ghi {n_aff} câu bẫy"
    assert f"`test_disclaimer_variants_pass` | {n_disc} câu" in body, \
        f"phu-luc-d.md phải ghi {n_disc} câu disclaimer"
    assert f"{n_tests} test ({n_cases} case)" in body, \
        f"phu-luc-d.md phải ghi '{n_tests} test ({n_cases} case)'"


def test_guardrail_v2_tests_and_case_counts_in_phu_luc_d():
    """v4.1: mục Guardrail v2 liệt kê đủ tên test của
    tests/test_guardrail_v2.py + số ca theo kind của
    data/eval/guardrail.jsonl (word-boundary — gotcha v2.3)."""
    import json
    from collections import Counter

    body = _doc("phu-luc-d.md")
    assert "Guardrail v2" in body and "chờ Pháp chế duyệt nhãn" in body
    src = (ROOT / "tests" / "test_guardrail_v2.py").read_text(
        encoding="utf-8")
    names = re.findall(r"def (test_\w+)\(", src)
    assert names
    for n in names:
        assert re.search(rf"(?<!\w){n}(?!\w)", body), \
            f"phu-luc-d.md thiếu test v2 '{n}'"
    rows = [json.loads(line) for line in (ROOT / "data" / "eval"
            / "guardrail.jsonl").read_text(encoding="utf-8").split("\n")
            if line.strip()]
    kinds = Counter(r["kind"] for r in rows if "_doc" not in r)
    for kind, n in kinds.items():
        assert re.search(rf"\|\s*`{kind}`\s*\|\s*{n}\s*\|", body), \
            f"phu-luc-d.md phải ghi '| `{kind}` | {n} |'"
    assert re.search(rf"(?<!\d){sum(kinds.values())} ca(?!\w)", body)


def test_sop_warns_role_dsn_while_grants_partial():
    """roles.sql chưa grant đủ bảng → SOP/kiến trúc KHÔNG được hướng dẫn
    đổi DSN app/agent sang role (gãy tab + trần chi phí LLM tắt câm do
    `_month_spend` lỗi = cho qua). Grant đủ rồi thì sửa docs + test này."""
    roles = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
    granted = set()
    for m in re.finditer(r"grant\s+[^;]*?\bon\s+(?!function)([\w\s,]+?)\s+to",
                         roles, re.IGNORECASE):
        granted |= {t.strip() for t in m.group(1).split(",")}
    missing = set(_table_names()) - granted
    assert "llm_usage" in missing and "chunks" in missing, granted
    sop, kt = _doc("sop.md"), _doc("kien-truc.md")
    assert "CHƯA đổi `DATABASE_URL`" in sop
    assert "Rồi đổi `DATABASE_URL` của agent/app" not in sop
    for body in (sop, kt):
        assert "llm_usage" in body and "cho qua" in body
    assert "CHƯA chuyển DSN Streamlit/agent" in kt
