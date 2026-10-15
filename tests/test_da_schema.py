"""v8.3 W83.1 — schema bảng phòng Dự án (`org_prospects`,
`project_milestones`): idempotent ×2 (schema.sql + roles.sql), không cột
PII, CHECK chặn dedup_key sai/'xong' thiếu evidence, block mới không
ALTER/DROP bảng cũ. v12.0: `programs` (DA-03 radar, ngoài phạm vi HĐ) đã
gỡ khỏi schema; 2 bảng còn lại phục vụ khối sales (DA-05) và ceo (DA-01).

DB thật (`DATABASE_URL`) trong schema tạm + ROLLBACK cuối test. Fixture
`da_db` + `TxConn` dùng chung cho tests/test_da_*.py.
"""

import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
_REST = SCHEMA_SQL.split("v8.3 phòng Dự án (WP11 DA)", 1)[1]
_HDR_END = _REST.index("-- ====")           # dòng đóng header của block
_NEXT = _REST.find("-- ====", _HDR_END + 7)  # block gộp sau (nếu có)
BLOCK = _REST if _NEXT < 0 else _REST[:_NEXT]
ORG_COLS = {"id", "dedup_key", "org_name", "org_type", "region", "website",
            "source_url", "fit_reason", "source", "created_by", "created_at",
            "status", "batch_queue_id", "handed_at"}
PII_COL_RE = re.compile(r"(?i)phone|sdt|email|mail|contact|lien_he|nguoi|"
                        r"person|address|dia_chi")


def da_db():
    """Generator conn trên schema tạm (schema.sql ×2 + roles.sql ×2) —
    ROLLBACK cuối. Skip khi không có DB (gate đòi 0 skipped)."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w83_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        for sql in (SCHEMA_SQL, SCHEMA_SQL, ROLES_SQL, ROLES_SQL):
            conn.execute(sql)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại tx fixture;
    transaction() = savepoint thật."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture
def db():
    yield from da_db()


def _cols(conn, table):
    return {r[0] for r in conn.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = %s", (table,))}


def test_block_no_alter_drop_and_two_tables():
    assert not re.search(r"(?im)^\s*alter table|drop table", BLOCK)
    names = re.findall(r"(?m)^create table if not exists (\w+)", BLOCK)
    assert names == ["org_prospects", "project_milestones"]
    assert "KHÔNG PII" in BLOCK
    assert not re.search(r"(?m)^create table if not exists programs\b",
                         SCHEMA_SQL)


def test_tables_and_no_pii_columns(db):
    cols = _cols(db, "org_prospects")
    assert cols == ORG_COLS
    for t in ("org_prospects", "project_milestones"):
        c = _cols(db, t)
        assert c, t
        assert not [x for x in c if PII_COL_RE.search(x)], (t, c)


@pytest.mark.parametrize("sql,params", [
    (("insert into org_prospects (dedup_key, org_name, org_type, region,"
      " source_url, source, created_by) values ('b2b:abc', 'Tổ chức', 'khac',"
      " 'Đà Nẵng', 'https://a.vn', 'manual', 'x')"), None),
    (("insert into org_prospects (dedup_key, org_name, org_type, region,"
      " source_url, source, created_by) values (%s, 'Tổ chức', 'khac',"
      " 'Đà Nẵng', 'facebook.com/x', 'manual', 'x')"), ("b2b:" + "a" * 64,)),
    (("insert into org_prospects (dedup_key, org_name, org_type, region,"
      " source_url, source, created_by) values (%s, 'Tổ chức', 'ca_nhan',"
      " 'Đà Nẵng', 'https://a.vn', 'manual', 'x')"), ("b2b:" + "b" * 64,)),
    (("insert into project_milestones (code, title, owner_role, due_date,"
      " gate, status, source) values ('DA-04', 't', 'tgd',"
      " '2026-11-14', 'g', 'xong', 's')"), None),
    (("insert into project_milestones (code, title, owner_role, due_date,"
      " gate, source) values ('da-04', 't', 'tgd', '2026-11-14', 'g',"
      " 's')"), None),
])
def test_check_violations(db, sql, params):
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute(sql, params)


def test_milestone_xong_with_evidence_ok(db):
    db.execute("insert into project_milestones (code, title, owner_role,"
               " due_date, gate, status, evidence, source) values ('DA-04',"
               " 't', 'tgd', '2026-11-14', 'g', 'xong', 'bb-01', 's')")
    assert db.execute("select status from project_milestones").fetchone()[0] \
        == "xong"


def test_new_tables_not_granted_to_roles(db):
    for role in ("agent_writer", "app_human"):
        for t in ("org_prospects", "project_milestones"):
            assert db.execute("select has_table_privilege(%s, %s, 'select')",
                              (role, t)).fetchone()[0] is False, (role, t)
