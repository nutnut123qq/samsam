"""Guard v3.6: mọi `psycopg.connect(...)` trong code (trừ tests/) phải có
`connect_timeout` — gotcha v1.9: psycopg không timeout mặc định, host chết
là treo cả tab/CLI. Quét bằng `ast` (bắt cả lời gọi bẻ dòng), không grep.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"tests", ".venv", "venv", "__pycache__", ".git"}


def scan_source(src: str, name: str = "<src>") -> tuple[int, list[str]]:
    """(số lời gọi `<alias>.connect(` tìm thấy, danh sách vi phạm)."""
    tree = ast.parse(src, filename=name)
    aliases: set[str] = set()
    bad: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "psycopg":
                    aliases.add(a.asname or "psycopg")
        elif isinstance(node, ast.ImportFrom) and node.module == "psycopg":
            for a in node.names:
                if a.name == "connect":
                    bad.append(f"{name}:{node.lineno} from psycopg import "
                               "connect (dùng psycopg.connect + "
                               "connect_timeout)")
    found = 0
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "connect"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in aliases):
            found += 1
            if not any(k.arg == "connect_timeout" for k in node.keywords):
                bad.append(f"{name}:{node.lineno} thiếu connect_timeout")
    return found, bad


def _repo_files():
    for p in ROOT.rglob("*.py"):
        rel = p.relative_to(ROOT)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            continue
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        yield p, rel


def test_all_psycopg_connect_have_timeout():
    total, bad = 0, []
    for p, rel in _repo_files():
        n, b = scan_source(p.read_bytes().decode("utf-8"), str(rel))
        total += n
        bad += b
    assert not bad, "\n".join(bad)
    # Chống guard rỗng/pass-ảo: 5 chỗ có sẵn timeout + 7 chỗ vá ở v3.6.
    assert total >= 12, total


def test_guard_catches_bad_samples():
    n, bad = scan_source("import psycopg as p\np.connect(d)\n")
    assert n == 1 and len(bad) == 1 and "thiếu connect_timeout" in bad[0]
    n, bad = scan_source("from psycopg import connect\nconnect(d)\n")
    assert len(bad) == 1 and "from psycopg import connect" in bad[0]
    # Lời gọi bẻ dòng có timeout ở dòng sau vẫn hợp lệ.
    n, bad = scan_source("import psycopg\npsycopg.connect(\n  d,\n"
                         "  connect_timeout=5)\n")
    assert n == 1 and bad == []
    # import trong hàm (kiểu streamlit_app) cũng được quét.
    n, bad = scan_source("def f():\n    import psycopg as _pg\n"
                         "    return _pg.connect(d)\n")
    assert n == 1 and len(bad) == 1
