"""v9.3 W93.1–W93.2 — hash chain `plot_logs` (trigger + guard + verify +
backfill), bảng `garden_media`, loader `core_store` không xóa dòng đã chain.

DB thật: 1 transaction + temp schema (`docs/schema.sql` ×2) rồi ROLLBACK —
không ghi gì lên schema public. Sửa lén mô phỏng bằng superuser tắt trigger
(`session_replication_role = replica`) trong savepoint force_rollback.
"""

import os
import re
import uuid
from itertools import pairwise
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import CheckViolation, RaiseException

from agents import garden
from ingest import core_store as cs

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ZERO = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
S_PLOTS = "sample:sample_plots.jsonl"
S_LOGS = "sample:sample_plot_logs.jsonl"


def _own_conn(**kw):
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        return psycopg.connect(dsn, connect_timeout=5, **kw)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")


def _setup_schema(conn, prefix="t_garden"):
    conn.execute("set local lock_timeout = '10s'")
    schema = f"{prefix}_{uuid.uuid4().hex[:12]}"
    conn.execute(f"create schema {schema}")
    conn.execute(f"set local search_path to {schema}, pg_temp")
    conn.execute(SCHEMA_SQL)
    return schema


def temp_schema_conn():
    """Generator conn trên temp schema (schema.sql ×2) — ROLLBACK cuối.
    Dùng chung cho fixture `db` của các test_garden_*."""
    conn = _own_conn()
    try:
        schema = _setup_schema(conn)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


@pytest.fixture
def db():
    yield from temp_schema_conn()


class _TxConn:
    """Bọc conn test: commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại
    trong tx của fixture (rollback cuối test). transaction() = savepoint."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


def _plot(db, pid="KV-T01", source="manual"):
    db.execute("insert into plots (id, location, source) values (%s, %s, %s)",
               (pid, "Trà My", source))


def _log(db, day, activity="tưới", detail="d", source="manual:garden",
         plot="KV-T01"):
    return db.execute(
        "insert into plot_logs (plot_id, ts, activity, detail, author, source)"
        " values (%s, %s, %s, %s, %s, %s) returning id",
        (plot, f"2026-10-{day:02d}T08:00:00Z", activity, detail, "A",
         source)).fetchone()[0]


def _hashes(db):
    return db.execute("select id, prev_hash, row_hash, source from plot_logs"
                      " order by id").fetchall()


def _verify(db):
    return [tuple(r) for r in db.execute(
        "select id, problem from verify_plot_logs() order by id, problem")]


def _raises(db, sql, params=None, exc=RaiseException):
    with pytest.raises(exc), db.transaction():
        db.execute(sql, params)


def _chain3(db):
    _plot(db)
    return [_log(db, d) for d in (1, 2, 3)]


# ------------------------------------------------------------ W93.1 schema

def test_chain_links_rows_and_verify_clean(db):
    ids = _chain3(db)
    assert _verify(db) == []
    rows = _hashes(db)
    assert [r[0] for r in rows] == ids
    assert rows[0][1] == ZERO
    for prev, cur in pairwise(rows):
        assert cur[1] == prev[2]
    assert all(HEX64.match(r[2]) for r in rows)


def test_client_hash_and_created_at_overwritten(db):
    _plot(db)
    lid = db.execute(
        "insert into plot_logs (plot_id, ts, activity, source, prev_hash,"
        " row_hash, created_at) values ('KV-T01', '2026-10-01T00:00:00Z',"
        " 'tưới', 'manual:garden', 'x', %s, '2000-01-01T00:00:00Z')"
        " returning id", ("f" * 64,)).fetchone()[0]
    prev, row, created_now = db.execute(
        "select prev_hash, row_hash, created_at = now() from plot_logs"
        " where id = %s", (lid,)).fetchone()
    assert prev == ZERO and row != "f" * 64 and HEX64.match(row)
    assert created_now is True
    assert _verify(db) == []


def test_sample_rows_stay_out_of_chain(db):
    _plot(db)
    a = _log(db, 1)
    s = db.execute(
        "insert into plot_logs (plot_id, ts, activity, source, prev_hash,"
        " row_hash) values ('KV-T01', '2026-10-02T00:00:00Z', 'bón',"
        " 'sample:x', 'p', 'r') returning id").fetchone()[0]
    b = _log(db, 3)
    rows = {r[0]: r for r in _hashes(db)}
    assert rows[s][1] is None and rows[s][2] is None
    assert rows[b][1] == rows[a][2]           # mẫu không làm gãy chuỗi
    assert _verify(db) == []
    # Dòng mẫu sửa/xóa được (loader quản).
    db.execute("update plot_logs set detail = 'x' where id = %s", (s,))
    db.execute("delete from plot_logs where id = %s", (s,))
    assert _verify(db) == []


def test_guard_blocks_update_delete_truncate_on_chained(db):
    ids = _chain3(db)
    _raises(db, "update plot_logs set detail = 'sửa' where id = %s",
            (ids[1],))
    # Đổi khoảnh cũng bị chặn → nhật ký thật trên khoảnh mẫu KHÔNG "chuyển
    # sang khoảnh thật" được (docs phải chỉ đường --adopt-plot, không chỉ
    # đường này).
    _plot(db, "KV-T02")
    _raises(db, "update plot_logs set plot_id = 'KV-T02' where id = %s",
            (ids[1],))
    _raises(db, "delete from plot_logs where id = %s", (ids[1],))
    _raises(db, "delete from plots where id = 'KV-T01'")   # FK cascade
    _raises(db, "truncate plot_logs")
    _raises(db, "truncate plots cascade")
    assert db.execute("select count(*) from plot_logs").fetchone()[0] == 3
    assert _verify(db) == []


def test_guard_blocks_promoting_sample_to_chain(db):
    """Không superuser: chèn 'sample:x' (không qua chain, created_at tùy ý)
    rồi đổi source/tự gán hash → bị chặn; dòng mẫu vẫn sửa nội dung được."""
    ids = _chain3(db)
    s = db.execute(
        "insert into plot_logs (plot_id, ts, activity, source, created_at)"
        " values ('KV-T01', '2026-10-05T00:00:00Z', 'tưới', 'sample:x',"
        " '2020-01-01T00:00:00Z') returning id").fetchone()[0]
    last = _hashes(db)[2][2]
    _raises(db, "update plot_logs set source = 'manual:garden' where id = %s",
            (s,))
    _raises(db, "update plot_logs set prev_hash = %s, row_hash ="
            " plot_log_row_hash(%s, id, plot_id, ts, activity, detail,"
            " author, source, created_at) where id = %s", (last, last, s))
    db.execute("update plot_logs set detail = 'ok' where id = %s", (s,))
    assert _verify(db) == []
    assert _log(db, 8) > ids[-1] and _verify(db) == []


def test_verify_detects_replica_tampering(db):
    ids = _chain3(db)
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("update plot_logs set detail = 'sửa lén' where id = %s",
                   (ids[1],))
        assert _verify(db) == [(ids[1], "row_hash")]
    assert _verify(db) == []
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("delete from plot_logs where id = %s", (ids[1],))
        assert _verify(db) == [(ids[2], "prev_hash")]
    with db.transaction(force_rollback=True):
        # Giấu dòng khỏi chuỗi bằng cách đổi thành "mẫu".
        db.execute("set local session_replication_role = replica")
        db.execute("update plot_logs set source = 'sample:x', row_hash = null,"
                   " prev_hash = null where id = %s", (ids[1],))
        assert _verify(db) == [(ids[2], "prev_hash")]
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        lid = _log(db, 9)
        assert _verify(db) == [(lid, "unchained")]
    assert _verify(db) == []


def test_hash_independent_of_timezone_datestyle(db):
    _plot(db)
    db.execute("set local timezone = 'UTC'")
    _log(db, 1)
    db.execute("set local timezone = 'Asia/Ho_Chi_Minh'")
    db.execute("set local datestyle = 'SQL, DMY'")
    _log(db, 2)
    assert _verify(db) == []
    db.execute("set local timezone = 'UTC'")
    db.execute("set local datestyle = 'ISO, MDY'")
    assert _verify(db) == []


def test_chain_rejects_repeatable_read():
    """Snapshot REPEATABLE READ không thấy dòng tx khác vừa commit → rẽ
    nhánh chuỗi. Trigger từ chối; dòng mẫu (không chain) vẫn ghi được."""
    conn = _own_conn()
    try:
        conn.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        _setup_schema(conn)
        assert conn.execute("select current_setting('transaction_isolation')"
                            ).fetchone()[0] == "repeatable read"
        _plot(conn)
        with pytest.raises(RaiseException, match="READ COMMITTED"), \
                conn.transaction():
            _log(conn, 1)
        _log(conn, 2, source="sample:x")
        assert conn.execute("select count(*) from plot_logs where row_hash"
                            " is not null").fetchone()[0] == 0
    finally:
        conn.rollback()
        conn.close()


def test_backfill_legacy_rows_idempotent(db):
    _plot(db)
    db.execute("set local session_replication_role = replica")
    a, b = _log(db, 1), _log(db, 2)
    s = _log(db, 3, source="sample:x")
    db.execute("set local session_replication_role = origin")
    assert _verify(db) == [(a, "unchained"), (b, "unchained")]
    db.execute(SCHEMA_SQL)
    assert _verify(db) == []
    rows = {r[0]: r for r in _hashes(db)}
    assert rows[a][1] == ZERO and rows[b][1] == rows[a][2]
    assert rows[s][1] is None and rows[s][2] is None
    db.execute(SCHEMA_SQL)                     # lần 2 → no-op
    assert {r[0]: r for r in _hashes(db)} == rows
    c = _log(db, 4)                            # chain nối tiếp backfill
    assert _hashes(db)[-1][1] == rows[b][2] and _hashes(db)[-1][0] == c


def test_sample_insert_blocked_after_purge_marker(db):
    _plot(db)
    _log(db, 1, source="sample:x")
    db.execute("insert into agent_action_log (actor, action, object_type)"
               " values ('GĐ', 'garden_sample_purge', 'plots')")
    with pytest.raises(RaiseException, match="đã được gỡ"), \
            db.transaction():
        _log(db, 2, source="sample:x")
    _log(db, 3)                                # nhật ký thật vẫn ghi được
    assert _verify(db) == []


@pytest.mark.parametrize("col, val", [
    ("sha256", "ABC"), ("sha256", "g" * 64), ("ext", "gif"),
    ("author", "  "), ("bytes", 0)])
def test_garden_media_checks(db, col, val):
    _plot(db)
    row = {"sha256": "a" * 64, "ext": "jpg", "bytes": 10, "plot_id": "KV-T01",
           "taken_on": "2026-10-12", "author": "Bé"}
    row[col] = val
    with pytest.raises(CheckViolation), db.transaction():
        db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
                   " taken_on, author) values (%(sha256)s, %(ext)s,"
                   " %(bytes)s, %(plot_id)s, %(taken_on)s, %(author)s)", row)


def test_garden_media_has_no_location_columns(db):
    cols = {r[0] for r in db.execute(
        "select column_name from information_schema.columns"
        " where table_schema = current_schema()"
        " and table_name = 'garden_media'")}
    assert "plot_id" in cols
    assert not cols & {"location", "lat", "lon", "gps", "path", "filename"}


def test_add_log_goes_through_chain(db):
    """agents/garden.py KHÔNG sửa — add_log vẫn ghi được, row có hash."""
    _plot(db)
    tx = _TxConn(db)
    lid, _ = garden.add_log(tx, "KV-T01", "2026-10-10", "tuoi", "sáng",
                            "Bé")
    assert lid is not None and tx.committed == 1
    row = db.execute("select prev_hash, row_hash, source from plot_logs"
                     " where id = %s", (lid,)).fetchone()
    assert row[0] == ZERO and HEX64.match(row[1])
    assert row[2] == garden.SOURCE
    assert _verify(db) == []


# ------------------------------------------------------------ W93.2 loader

def _sample_domains(drop=(), tree_count=None):
    plots = []
    for r in cs.iter_jsonl(DATA / "sample_plots.jsonl"):
        if r["id"] in drop:
            continue
        row = cs.plot_row(r, S_PLOTS)
        if tree_count is not None and r["id"] == "KV-A01":
            row["tree_count"] = tree_count
        plots.append(row)
    logs = [cs.plot_log_row(r, S_LOGS)
            for r in cs.iter_jsonl(DATA / "sample_plot_logs.jsonl")
            if r["plot_id"] not in drop]
    return [("plots", S_PLOTS, plots), ("plot_logs", S_LOGS, logs)]


def _count_src(db, table, src):
    return db.execute(f"select count(*) from {table} where source = %s",
                      (src,)).fetchone()[0]


def test_loader_keeps_chained_plot_and_upserts(db):
    cs.apply_rows(db, _sample_domains())
    n_logs = _count_src(db, "plot_logs", S_LOGS)
    assert n_logs > 0
    lid, _ = garden.add_log(_TxConn(db), "KV-A01", "2026-10-10T08:00:00Z",
                            "tưới", "thật")
    rh = db.execute("select row_hash from plot_logs where id = %s",
                    (lid,)).fetchone()[0]
    cs.apply_rows(db, _sample_domains(tree_count=4242))   # không exception
    assert db.execute("select id, row_hash from plot_logs where source ="
                      " 'manual:garden'").fetchall() == [(lid, rh)]
    assert db.execute("select tree_count from plots where id = 'KV-A01'"
                      ).fetchone()[0] == 4242
    assert _count_src(db, "plot_logs", S_LOGS) == n_logs   # không nhân đôi
    assert _verify(db) == []
    # File mẫu bỏ KV-A01 → vẫn còn (có nhật ký chain) + báo keep.
    doms = _sample_domains(drop=("KV-A01",))
    cs.apply_rows(db, doms)
    assert db.execute("select source from plots where id = 'KV-A01'"
                      ).fetchone()[0] == S_PLOTS
    assert cs.kept_plots(db, doms) == [("KV-A01", 1, 0)]
    assert _verify(db) == []


def test_loader_never_overwrites_manual_plot(db):
    db.execute("insert into plots (id, tree_count, source) values"
               " ('KV-A02', 7, 'manual')")
    cs.apply_rows(db, _sample_domains())
    cs.apply_rows(db, _sample_domains())
    assert db.execute("select source, tree_count, location from plots"
                      " where id = 'KV-A02'").fetchone() == ("manual", 7, None)


def test_loader_keeps_plot_with_media(db):
    cs.apply_rows(db, _sample_domains())
    db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
               " taken_on, author) values (%s, 'jpg', 1, 'KV-B01',"
               " '2026-10-12', 'Bé')", ("b" * 64,))
    doms = _sample_domains(drop=("KV-B01",))
    cs.apply_rows(db, doms)                    # không ForeignKeyViolation
    assert cs.kept_plots(db, doms) == [("KV-B01", 0, 1)]


def test_sample_garden_purged_and_drop(db):
    assert cs.sample_garden_purged(db) is False
    db.execute("insert into agent_action_log (actor, action, object_type)"
               " values ('GĐ', 'garden_sample_purge', 'plots')")
    assert cs.sample_garden_purged(db) is True
    doms = _sample_domains() + [("orders", "sample:sample_orders.jsonl",
                                 [{"id": "x"}])]
    left = cs.drop_sample_garden(doms)
    assert [t for t, _, _ in left] == ["orders"]
    manual = [("plots", "plots_that.jsonl", [])]
    assert cs.drop_sample_garden(manual) == manual


def test_sample_garden_purged_missing_table_false(db):
    with db.transaction(force_rollback=True):
        empty = f"t_empty_{uuid.uuid4().hex[:8]}"
        db.execute(f"create schema {empty}")
        db.execute(f"set local search_path to {empty}, pg_temp")
        assert cs.sample_garden_purged(db) is False
        assert db.execute("select 1").fetchone() == (1,)   # conn còn sống
