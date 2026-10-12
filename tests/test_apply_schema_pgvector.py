"""v10.3 W103.3 — `apply_schema.py --pgvector` + `docs/schema_pgvector.sql`.

Unit bằng fake conn (không đụng DB thật): thiếu extension → exit 3, KHÔNG
chạy migration; có extension → chạy sau schema.sql; không flag → hành vi
cũ (không hỏi extension). Chạy thật trên Postgres có pgvector nằm ở
`scripts/vector_eval.py` (container tạm).
"""

import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import apply_schema

PGV = (ROOT / "docs" / "schema_pgvector.sql").read_text(encoding="utf-8")


class _Res(list):
    def __init__(self, one=None):
        super().__init__()
        self._one = one

    def fetchone(self):
        return self._one


class _Conn:
    def __init__(self, st):
        self.st = st

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.st.log.append(sql)
        if "pg_available_extensions" in sql:
            return _Res((1 if self.st.has_vector else 0,))
        return _Res()


@pytest.fixture
def fake(monkeypatch):
    st = SimpleNamespace(log=[], has_vector=False, kw=None)

    def connect(dsn, **kw):
        st.kw = kw
        return _Conn(st)

    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/x")
    monkeypatch.setattr(apply_schema.psycopg, "connect", connect)
    return st


def test_pgvector_missing_exit3_no_migration(fake, capsys):
    assert apply_schema.main(["--pgvector"]) == 3
    out = capsys.readouterr().out
    assert "[external-dep]" in out and "float8" in out
    assert not any("create extension" in s for s in fake.log)
    assert any("create table if not exists chunks" in s for s in fake.log)
    assert fake.kw.get("connect_timeout")


def test_pgvector_present_applies_after_schema(fake, capsys):
    fake.has_vector = True
    assert apply_schema.main(["--pgvector"]) == 0
    i_schema = next(i for i, s in enumerate(fake.log)
                    if "create table if not exists chunks" in s)
    i_pgv = next(i for i, s in enumerate(fake.log)
                 if "create extension if not exists vector" in s)
    assert i_schema < i_pgv
    assert "pgvector applied" in capsys.readouterr().out


def test_no_flag_unchanged(fake):
    fake.has_vector = True
    assert apply_schema.main([]) == 0
    assert not any("pg_available_extensions" in s for s in fake.log)
    assert not any("create extension" in s for s in fake.log)


def test_migration_only_adds_keeps_float8():
    low = PGV.lower()
    assert not re.search(r"drop\s+(column|table|index|extension)", low)
    # mọi alter table chỉ là `add column if not exists` (drift-guard v3.4)
    alters = re.findall(r"alter\s+table[^;]*;", low)
    assert len(alters) == 2
    assert all(re.fullmatch(r"alter\s+table\s+\w+\s+add\s+column\s+if\s+not"
                            r"\s+exists\s+embedding_v\s+vector\(1536\);", a)
               for a in alters)
    assert "alter column" not in low
    assert low.count("using hnsw (embedding_v vector_cosine_ops)") == 2
    assert low.count("before insert or update of embedding on") == 2
    assert "create extension if not exists vector" in low
