"""v9.3 W93.3/W93.4/W93.6 — agents/garden_director.py: precheck + gỡ dữ
liệu mẫu có `--by`, nhắc lịch/gap (rule thuần, `now` tham số), bản tin
tuần tất định, CLI đúng 1 op.

Không đọc đồng hồ thật: mọi `now`/`until` cố định. DB thật: temp schema +
ROLLBACK (fixture `db` của test_garden_chain), hàm commit → `_TxConn`.
"""

import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from agents import garden
from agents import garden_director as gd
from ingest import core_store as cs
from tests.test_garden_chain import (
    _sample_domains,
    _TxConn,
    _verify,
    temp_schema_conn,
)

NOW = datetime(2026, 10, 12, tzinfo=gd.VN_TZ)
SCHED = {"gap_days": 14, "activities": {"tưới": 7, "bón": 60}}
DEAD_DSN = "postgresql://u@10.255.255.1:5432/x"


@pytest.fixture
def db():
    yield from temp_schema_conn()


# ------------------------------------------------------- W93.4 rule thuần

def _rem(last_any=None, last_by=None, plots=("KV-1",), sched=SCHED):
    return gd.reminders(list(plots), last_any or {}, last_by or {}, sched,
                        NOW)


def test_no_logs_only_no_overdue():
    out = _rem()
    assert out == [{"type": "no-logs", "plot": "KV-1", "activity": None,
                    "last_ts": None, "days": None}]


def test_gap_strict_boundary():
    d14 = NOW - timedelta(days=14)
    both = {("KV-1", "tưới"): NOW, ("KV-1", "bón"): NOW}
    assert [r for r in _rem({"KV-1": d14}, both) if r["type"] == "gap"] == []
    out = _rem({"KV-1": d14 - timedelta(seconds=1)}, both)
    assert [(r["type"], r["days"]) for r in out] == [("gap", 14)]


def test_overdue_interval_and_never():
    last = {"KV-1": NOW}
    ok = {("KV-1", "tưới"): NOW - timedelta(days=7),
          ("KV-1", "bón"): NOW}
    assert _rem(last, ok) == []
    late = {("KV-1", "tưới"): NOW - timedelta(days=8),
            ("KV-1", "bón"): NOW}
    out = _rem(last, late)
    assert [(r["type"], r["activity"], r["days"]) for r in out] == [
        ("overdue", "tưới", 8)]
    never = _rem(last, {("KV-1", "tưới"): NOW})
    assert never == [{"type": "overdue", "plot": "KV-1", "activity": "bón",
                      "last_ts": None, "days": None}]


def test_reminders_deterministic_order():
    plots = ("KV-B", "KV-A", "KV-C")
    last = {"KV-B": NOW - timedelta(days=30), "KV-A": NOW - timedelta(days=20)}
    a = _rem(last, {}, plots)
    assert a == _rem(last, {}, plots)
    keys = [(r["type"], r["plot"], r["activity"] or "") for r in a]
    assert keys == sorted(keys)
    assert ("no-logs", "KV-C", "") in keys


@pytest.mark.parametrize("content", [None, "", "  \n", "{}",
                                     '{"_doc": "giả định"}'])
def test_load_schedule_empty_variants(tmp_path, content):
    p = tmp_path / "s.json"
    if content is not None:
        p.write_bytes(content.encode("utf-8"))
    sched, warns = gd.load_schedule(p)
    assert sched == {"gap_days": garden.DEFAULT_GAP_DAYS, "activities": {}}
    assert len(warns) == 1 and "chưa có lịch" in warns[0]


@pytest.mark.parametrize("content", [
    "{hỏng", "[1, 2]", '{"activities": {"bay": 3}}',
    '{"activities": {"tưới": 0}}', '{"activities": {"tưới": true}}',
    '{"activities": {"tưới": 400}}', '{"gap_days": "14"}',
    '{"gap_day": 14}', '{"activities": ["tưới"]}'])
def test_load_schedule_errors(tmp_path, content):
    p = tmp_path / "s.json"
    p.write_bytes(content.encode("utf-8"))
    with pytest.raises(ValueError):
        gd.load_schedule(p)


def test_repo_schedule_is_valid_assumption():
    sched, warns = gd.load_schedule()
    assert warns == [] and sched["gap_days"] == 14
    assert sched["activities"]["tưới"] == 7
    assert "GIẢ ĐỊNH" in gd.SCHEDULE_PATH.read_text(encoding="utf-8")


def test_flags_only_detail():
    assert gd.log_flags("định kỳ, không thấy gì") == []
    assert gd.log_flags(None) == []
    assert "rệp" in gd.log_flags("phát hiện rệp")


def test_test_file_never_reads_wall_clock():
    src = Path(__file__).read_text(encoding="utf-8")
    assert src.count("datetime" + ".now") == 0


# -------------------------------------------------------------- W93.3 CLI

def _no_connect(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("connect() không được gọi")
    monkeypatch.setattr(gd, "connect", boom)


@pytest.mark.parametrize("argv", [
    [], ["--bulletin", "--remind"], ["--verify", "--precheck"],
    ["--purge-sample"], ["--purge-sample", "--by", "  "],
    ["--bulletin", "--until", "12/10/2026"], ["--bulletin", "--days", "0"]])
def test_cli_usage_errors_exit2_before_connect(monkeypatch, capsys, argv):
    _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        gd.main(argv)
    assert e.value.code == 2
    if argv[:1] == ["--purge-sample"]:
        assert "--by" in capsys.readouterr().err


def test_purge_sample_blank_by_no_db():
    class Boom:
        def __getattr__(self, name):
            raise AssertionError("không được đụng DB")
    for by in (None, "", "   "):
        with pytest.raises(ValueError, match="--by"):
            gd.purge_sample(Boom(), by)


def test_broken_schedule_err_exit1(monkeypatch, tmp_path, capsys):
    _no_connect(monkeypatch)
    p = tmp_path / "s.json"
    p.write_bytes(b"{")
    assert gd.main(["--remind", "--schedule", str(p)]) == 1
    assert "[err]" in capsys.readouterr().err


@pytest.mark.parametrize("argv, code", [
    (["--remind"], 0), (["--precheck"], 0),
    (["--bulletin", "--until", "2026-10-12"], 0), (["--verify"], 2),
    (["--purge-sample", "--by", "GĐ"], 2)])
def test_cli_db_down(monkeypatch, capsys, tmp_path, argv, code):
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: None)
    assert gd.main(argv + (["--out-dir", str(tmp_path)]
                           if "--bulletin" in argv else [])) == code
    out = capsys.readouterr()
    if code == 0:
        assert "[warn] chưa nạp" in out.out
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("argv, code", [(["--remind"], 0), (["--verify"], 2)])
def test_cli_dead_host_real_connect(monkeypatch, capsys, argv, code):
    """Host chết THẬT (không mock connect) — connect_timeout của lead_store
    giữ CLI không treo; load_dotenv không đè biến đã set."""
    monkeypatch.setenv("DATABASE_URL", DEAD_DSN)
    assert gd.main(argv) == code


# ------------------------------------------------------- W93.3 DB (rollback)

def _load_samples(db):
    cs.apply_rows(db, _sample_domains())
    return gd.sample_precheck(db)


def _actions(db):
    return db.execute("select count(*) from agent_action_log where action ="
                      " 'garden_sample_purge'").fetchone()[0]


def test_purge_refused_with_blocker(db):
    pre = _load_samples(db)
    assert pre["plots"] == 3 and pre["plot_logs"] > 0 and pre["blockers"] == []
    lid, _ = garden.add_log(_TxConn(db), "KV-A01", "2026-10-10T08:00:00Z",
                            "tưới", "thật", "Bé")
    tx = _TxConn(db)
    res = gd.purge_sample(tx, "Nguyễn GĐ")
    assert res["ok"] is False
    assert res["blockers"] == [{"kind": "plot_log", "id": lid,
                                "plot_id": "KV-A01", "day": "2026-10-10",
                                "source": "manual:garden"}]
    assert "detail" not in res["blockers"][0]
    assert gd.sample_precheck(db)["plot_logs"] == pre["plot_logs"]
    assert _actions(db) == 0 and tx.committed == 0


def test_purge_ok_logs_action_and_blocks_reload(db):
    pre = _load_samples(db)
    tx = _TxConn(db)
    res = gd.purge_sample(tx, "  Nguyễn GĐ  ")
    assert res == {"ok": True, "plots": pre["plots"],
                   "plot_logs": pre["plot_logs"], "blockers": []}
    assert tx.committed == 1
    for t in ("plots", "plot_logs"):
        assert db.execute(f"select count(*) from {t} where source like"
                          " 'sample:%'").fetchone()[0] == 0
    rows = db.execute("select actor, object_type, detail from"
                      " agent_action_log where action ="
                      " 'garden_sample_purge'").fetchall()
    assert rows == [("Nguyễn GĐ", "plots",
                     {"plots": pre["plots"], "plot_logs": pre["plot_logs"]})]
    assert db.execute("select count(*) from verify_action_log()"
                      ).fetchone()[0] == 0
    assert cs.sample_garden_purged(db) is True
    with pytest.raises(Exception, match="đã được gỡ"), db.transaction():
        db.execute("insert into plot_logs (plot_id, ts, activity, source)"
                   " values ('KV-X', now(), 'tưới', 'sample:x')")


def test_precheck_cli_readonly(db, monkeypatch, capsys):
    _load_samples(db)
    before = db.execute("select count(*) from agent_action_log").fetchone()
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: _TxConn(db))
    assert gd.main(["--precheck"]) == 0
    assert "3 khoảnh" in capsys.readouterr().out
    assert db.execute("select count(*) from agent_action_log"
                      ).fetchone() == before


def test_purge_cli_exit_codes(db, monkeypatch, capsys):
    _load_samples(db)
    garden.add_log(_TxConn(db), "KV-A02", "2026-10-09", "bón", "x", "Bé")
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: _TxConn(db))
    assert gd.main(["--purge-sample", "--by", "GĐ"]) == 1
    assert "[blocker]" in capsys.readouterr().out
    assert _actions(db) == 0


def test_purge_sample_only_called_from_cli_and_tests():
    """Agent/cron KHÔNG gọi purge_sample/adopt_plot — chỉ định nghĩa + CLI
    main."""
    root = gd.ROOT
    hits = []
    for p in root.rglob("*.py"):
        if any(part in {".venv", "venv", "node_modules", ".git", ".claude"}
               for part in p.parts):
            continue
        src = p.read_text(encoding="utf-8", errors="replace")
        if "purge_sample(" in src or "adopt_plot(" in src:
            hits.append(p.relative_to(root).as_posix())
    assert sorted(h for h in hits if not h.startswith("tests/")) == [
        "agents/garden_director.py"]


# ----------------------------------------------------- W93.6 bản tin tuần

def _bulletin_fixture(db):
    cs.apply_rows(db, _sample_domains())      # location 'Trà My', author 'mẫu'
    tx = _TxConn(db)
    garden.add_log(tx, "KV-A01", "2026-10-10T03:00:00Z", "kiểm tra sâu bệnh",
                   "định kỳ, không thấy gì", "Nguyễn Văn Bí")
    garden.add_log(tx, "KV-A02", "2026-10-11T03:00:00Z", "ghi nhận",
                   "phát hiện rệp, gọi 0901234567 báo", "Nguyễn Văn Bí")
    db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
               " taken_on, author, created_at) values (%s, 'jpg', 9,"
               " 'KV-A01', '2026-10-11', 'Nguyễn Văn Bí',"
               " '2026-10-11T03:00:00Z')", ("c" * 64,))  # cố định, không now()


def _sql_blocks(text):
    return [s.strip().rstrip(";") for blk in
            re.findall(r"```sql\n(.*?)```", text, re.DOTALL)
            for s in blk.strip().split(";\n")]


def test_bulletin_sections_and_privacy(db):
    _bulletin_fixture(db)
    a = gd.build_bulletin(db, "2026-10-12", 7, SCHED)
    b = gd.build_bulletin(db, date(2026, 10, 12), 7, SCHED)
    assert a == b == gd.build_bulletin(db, "2026-10-12", 7, SCHED)
    for n in range(1, 7):
        assert re.search(rf"^## {n}\. ", a, re.MULTILINE), n
    for bad in ("Trà My", "Nam Giang", "Nguyễn Văn Bí", "0901234567",
                "area_m2", "location"):
        assert bad not in a, bad
    # Cờ chỉ quét detail: 'kiểm tra sâu bệnh' (activity) không flag.
    sec5 = a.split("## 5.")[1].split("## 6.")[0]
    assert "rệp" in sec5 and "KV-A02" in sec5
    assert "định kỳ" not in sec5
    assert "OK — 2 nhật ký đã chain" in a


def test_bulletin_numbers_match_reference_sql(db):
    _bulletin_fixture(db)
    text = gd.build_bulletin(db, "2026-10-12", 7, SCHED)
    sqls = _sql_blocks(text)
    assert len(sqls) == 9                     # 2+1+3+1+1+1
    assert db.execute(sqls[0]).fetchall() == [] and _verify(db) == []
    n_chain = db.execute(sqls[1]).fetchone()[0]
    assert f"OK — {n_chain} nhật ký đã chain" in text
    n_sp, n_sl = db.execute(sqls[2]).fetchone()
    assert f"{n_sp} khoảnh mẫu, {n_sl} nhật ký mẫu" in text
    plots = [r[0] for r in db.execute(sqls[3])]
    last_any = dict(db.execute(sqls[4]).fetchall())
    last_by = {(p, a): t for p, a, t in db.execute(sqls[5])}
    end = datetime(2026, 10, 13, tzinfo=gd.VN_TZ)
    rems = gd.reminders(plots, last_any, last_by, SCHED, end)
    assert rems
    for r in rems:
        assert f"- {gd.fmt_reminder(r)}" in text
    rows4 = db.execute(sqls[6]).fetchall()
    assert rows4
    for p, mau, that in rows4:
        assert f"| {p} | {that} | {mau} |" in text
    flagged = [r for r in db.execute(sqls[7]) if gd.log_flags(r[4])]
    assert [f"#{r[0]} " in text for r in flagged] == [True] * len(flagged)
    assert db.execute(sqls[8]).fetchall() == [("KV-A01", 1)]
    assert "| KV-A01 | 1 |" in text


def test_bulletin_reports_chain_problem(db):
    _bulletin_fixture(db)
    lid = db.execute("select max(id) from plot_logs where row_hash is not"
                     " null").fetchone()[0]
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("update plot_logs set detail = 'sửa' where id = %s",
                   (lid,))
        text = gd.build_bulletin(db, "2026-10-12", 7, SCHED)
        assert f"#{lid} (row_hash)" in text and "CẢNH BÁO" in text


def test_bulletin_detail_masked_and_truncated(db):
    cs.apply_rows(db, _sample_domains())
    garden.add_log(_TxConn(db), "KV-A01", "2026-10-11T03:00:00Z", "ghi nhận",
                   "rệp " + "x" * 300 + "\nmail a.b@vd.vn", "Bé")
    text = gd.build_bulletin(db, "2026-10-12", 7, SCHED)
    line = next(ln for ln in text.splitlines() if ln.startswith("- #")
                and "rệp" in ln)
    assert len(line.split(": ", 1)[1]) <= gd.DETAIL_MAX + 1
    assert "a.b@vd.vn" not in text


def test_bulletin_cli_writes_file(db, monkeypatch, tmp_path, capsys):
    _bulletin_fixture(db)
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: _TxConn(db))
    assert gd.main(["--bulletin", "--until", "2026-10-12", "--out-dir",
                    str(tmp_path)]) == 0
    out = tmp_path / "garden-week-2026-10-12.md"
    assert out.exists() and str(out) in capsys.readouterr().out
    body = out.read_bytes().decode("utf-8")
    assert "Trà My" not in body and "\r\n" not in body
    assert [p.name for p in tmp_path.iterdir()] == [out.name]


def test_verify_and_remind_cli_on_temp_schema(db, monkeypatch, capsys):
    _bulletin_fixture(db)
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: _TxConn(db))
    assert gd.main(["--verify"]) == 0
    assert gd.main(["--remind"]) == 0
    out = capsys.readouterr().out
    assert "[verify] OK" in out and "KV-B01" in out
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        db.execute("delete from plot_logs where id = (select min(id) from"
                   " plot_logs where row_hash is not null)")
        assert gd.main(["--verify"]) == 1


# ------------------------------------------- vòng sửa: ghi bù / nhận khoảnh

def test_bulletin_includes_backfilled_log_by_created_at(db):
    """Sổ giấy nhập bù: ts tuần trước, ghi (created_at, trigger ép now())
    trong kỳ → vẫn vào mục 4/5 (không lọt giữa 2 bản tin). Mẫu chỉ theo
    ts (loader nạp lại mẫu mỗi lần → created_at mẫu luôn mới)."""
    cs.apply_rows(db, _sample_domains())
    now = db.execute("select now()").fetchone()[0]     # mốc DB, không đồng hồ
    until = now.astimezone(gd.VN_TZ).date()
    late = (now - timedelta(days=10)).isoformat()
    lid, _ = garden.add_log(_TxConn(db), "KV-A02", late, "ghi nhận",
                            "phát hiện rệp ở luống 3", "Bé")
    assert lid is not None
    text = gd.build_bulletin(db, until, 7, SCHED)
    sec4 = text.split("## 4.")[1].split("## 5.")[0]
    sec5 = text.split("## 5.")[1].split("## 6.")[0]
    line = next(ln for ln in sec5.splitlines() if ln.startswith(f"- #{lid} "))
    assert "(ghi bù)" in line and "rệp" in line
    sqls = _sql_blocks(text)
    assert lid in [r[0] for r in db.execute(sqls[7])]
    rows4 = {p: (mau, that) for p, mau, that in db.execute(sqls[6])}
    assert rows4["KV-A02"][1] == 1 and "| KV-A02 | 1 |" in sec4
    end = datetime(until.year, until.month, until.day,
                   tzinfo=gd.VN_TZ) + timedelta(days=1)
    n_mau = db.execute(
        "select count(*) from plot_logs where source like 'sample:%%'"
        " and ts >= %s and ts < %s", (end - timedelta(days=7), end)
    ).fetchone()[0]
    assert sum(m for m, _ in rows4.values()) == n_mau


def _adopt_actions(db):
    return db.execute("select actor, object_type, object_id, detail from"
                      " agent_action_log where action = %s order by id",
                      (gd.ADOPT_ACTION,)).fetchall()


def test_adopt_plot_unblocks_purge(db):
    """Nhật ký thật đã chain trên khoảnh mẫu (blocker không chuyển được) →
    GĐ ký nhận khoảnh → purge thành công; nhật ký thật + chuỗi nguyên vẹn."""
    pre = _load_samples(db)
    lid, _ = garden.add_log(_TxConn(db), "KV-A01", "2026-10-10T08:00:00Z",
                            "tưới", "thật", "Bé")
    db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
               " taken_on, author) values (%s, 'jpg', 9, 'KV-B01',"
               " '2026-10-11', 'Bé')", ("e" * 64,))
    assert {b["kind"] for b in gd.purge_sample(_TxConn(db), "GĐ")["blockers"]
            } == {"plot_log", "garden_media"}
    tx = _TxConn(db)
    res = gd.adopt_plot(tx, " KV-A01 ", "  Nguyễn GĐ ")
    assert res == {"ok": True, "plot_id": "KV-A01",
                   "from_source": "sample:sample_plots.jsonl"}
    assert tx.committed == 1
    assert _adopt_actions(db) == [("Nguyễn GĐ", "plots", "KV-A01",
                                   {"from_source":
                                    "sample:sample_plots.jsonl"})]
    # Blocker ảnh: chuyển plot_id sang khoảnh thật (garden_media không chain).
    db.execute("update garden_media set plot_id = 'KV-A01'")
    assert gd.sample_precheck(db)["blockers"] == []
    # Loader chạy lại giữa chừng: không đè/xóa khoảnh đã nhận.
    cs.apply_rows(db, _sample_domains())
    assert db.execute("select source from plots where id = 'KV-A01'"
                      ).fetchone()[0] == gd.ADOPT_SOURCE
    res = gd.purge_sample(_TxConn(db), "Nguyễn GĐ")
    assert res["ok"] is True and res["plots"] == pre["plots"] - 1
    for t in ("plots", "plot_logs"):
        assert db.execute(f"select count(*) from {t} where source like"
                          " 'sample:%'").fetchone()[0] == 0
    assert db.execute("select id, source from plot_logs").fetchall() == [
        (lid, garden.SOURCE)]
    assert _verify(db) == []
    assert db.execute("select count(*) from verify_action_log()"
                      ).fetchone()[0] == 0


def test_adopt_plot_refusals(db):
    _load_samples(db)
    db.execute("insert into plots (id, source) values ('KV-M1', 'manual')")
    assert gd.adopt_plot(_TxConn(db), "KV-ZZ", "GĐ")["ok"] is False
    assert gd.adopt_plot(_TxConn(db), "KV-M1", "GĐ")["ok"] is False
    for by in (None, "", "  "):
        with pytest.raises(ValueError, match="--by"):
            gd.adopt_plot(_TxConn(db), "KV-A01", by)
    assert _adopt_actions(db) == []
    assert db.execute("select source from plots where id = 'KV-M1'"
                      ).fetchone()[0] == "manual"


def test_adopt_cli_and_blocker_hint(db, monkeypatch, capsys):
    _load_samples(db)
    garden.add_log(_TxConn(db), "KV-A02", "2026-10-09", "bón", "x", "Bé")
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: _TxConn(db))
    assert gd.main(["--purge-sample", "--by", "GĐ"]) == 1
    out = capsys.readouterr().out
    assert "KHÔNG chuyển/sửa được" in out and "--adopt-plot KV-A02" in out
    assert gd.main(["--adopt-plot", "KV-ZZ", "--by", "GĐ"]) == 1
    assert gd.main(["--adopt-plot", "KV-A02", "--by", "GĐ"]) == 0
    assert "giá trị MẪU" in capsys.readouterr().out
    assert gd.main(["--purge-sample", "--by", "GĐ"]) == 0


@pytest.mark.parametrize("argv", [
    ["--adopt-plot", "KV-A01"], ["--adopt-plot", "KV-A01", "--by", " "],
    ["--adopt-plot", " ", "--by", "GĐ"],
    ["--adopt-plot", "KV-A01", "--purge-sample", "--by", "GĐ"]])
def test_adopt_cli_usage_exit2_before_connect(monkeypatch, argv):
    _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        gd.main(argv)
    assert e.value.code == 2


def test_adopt_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: None)
    assert gd.main(["--adopt-plot", "KV-A01", "--by", "GĐ"]) == 2


# ------------------------------------- core_store.main() sau / trước gỡ mẫu

class _CtxConn(_TxConn):
    """`with psycopg.connect(...) as conn` trong core_store.main — không
    commit/close thật (dữ liệu ở lại tx fixture, rollback cuối test)."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _run_loader(db, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:1/fake")
    monkeypatch.setattr(cs.psycopg, "connect", lambda *a, **kw: _CtxConn(db))
    code = cs.main()
    return code, capsys.readouterr().out


def test_loader_main_skips_samples_after_purge(db, monkeypatch, capsys):
    """Sau khi GĐ ký gỡ mẫu: main() bỏ domain mẫu vườn (không thì trigger
    raise 'đã được gỡ' → rollback cả lần nạp), domain khác vẫn nạp."""
    _load_samples(db)
    assert gd.purge_sample(_TxConn(db), "Nguyễn GĐ")["ok"] is True
    code, out = _run_loader(db, monkeypatch, capsys)
    assert code == 0 and "[skip] plots/plot_logs mẫu" in out
    for t in ("plots", "plot_logs"):
        assert db.execute(f"select count(*) from {t} where source like"
                          " 'sample:%'").fetchone()[0] == 0
    for t in ("products", "orders"):
        assert db.execute(f"select count(*) from {t}").fetchone()[0] > 0, t
    assert "[done] totals:" in out


def test_loader_main_keeps_chained_sample_plot(db, monkeypatch, capsys):
    _load_samples(db)
    garden.add_log(_TxConn(db), "KV-A01", "2026-10-10T08:00:00Z", "tưới",
                   "thật", "Bé")
    code, out = _run_loader(db, monkeypatch, capsys)
    assert code == 0 and "[skip]" not in out
    assert "[keep] plots: KV-A01 (1 nhật ký đã chain, 0 ảnh)" in out
    assert db.execute("select count(*) from plot_logs where source like"
                      " 'sample:%'").fetchone()[0] > 0
    assert _verify(db) == []


# ------------------------------- vòng sửa: --until mặc định = hôm qua VN

@pytest.mark.parametrize("now, want", [
    (datetime(2026, 10, 12, 9, 0, tzinfo=gd.VN_TZ), date(2026, 10, 11)),
    # 23:30 UTC ngày 11 = 06:30 VN ngày 12 → hôm qua VN = 11 (không phải 10)
    (datetime(2026, 10, 11, 23, 30, tzinfo=timezone.utc), date(2026, 10, 11)),
    # 00:05 VN đầu năm → hôm qua = 31/12 năm trước
    (datetime(2027, 1, 1, 0, 5, tzinfo=gd.VN_TZ), date(2026, 12, 31))])
def test_default_until_is_yesterday_vn(now, want):
    assert gd._default_until(now) == want


def test_default_until_naive_rejected():
    with pytest.raises(ValueError, match="tzinfo"):
        gd._default_until(datetime(2026, 10, 12, 9, 0))  # noqa: DTZ001


def test_cli_bulletin_without_until_uses_yesterday(monkeypatch, tmp_path):
    """Nhánh CLI không --until: đồng hồ thay bằng mốc cố định (không
    wall-clock) → kỳ kết thúc HÔM QUA VN."""
    fixed = datetime(2026, 10, 12, 1, 0, tzinfo=timezone.utc)  # 08:00 VN

    class _FixedDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    seen = {}

    def fake_build(conn, until, days, schedule):
        seen["until"] = until
        return "# x\n"

    monkeypatch.setattr(gd, "datetime", _FixedDT)
    monkeypatch.setattr(gd, "connect", lambda *a, **kw: object())
    monkeypatch.setattr(gd, "build_bulletin", fake_build)
    # v15.2 (P8.4): cờ mẫu của bản tin đọc DB riêng — conn giả ở đây.
    monkeypatch.setattr(gd, "bulletin_sample", lambda *a, **k: False)
    assert gd.main(["--bulletin", "--out-dir", str(tmp_path)]) == 0
    assert seen["until"] == date(2026, 10, 11)
    assert (tmp_path / "garden-week-2026-10-11.md").exists()


def test_log_written_after_default_bulletin_lands_next_week(db):
    """Regression probe cold-check: bản tin A sinh với until mặc định
    (hôm qua theo mốc DB) → nhật ký có rệp ghi SAU đó, ts = now, phải vào
    bản tin tuần sau B (until + 7) — không lọt giữa 2 bản tin."""
    cs.apply_rows(db, _sample_domains())
    now = db.execute("select now()").fetchone()[0]     # mốc DB, không đồng hồ
    until = gd._default_until(now)
    a = gd.build_bulletin(db, until, 7, SCHED)
    lid, _ = garden.add_log(_TxConn(db), "KV-A02", now.isoformat(),
                            "ghi nhận", "phát hiện rệp ở luống 3", "Bé")
    assert lid is not None
    b = gd.build_bulletin(db, until + timedelta(days=7), 7, SCHED)
    assert f"- #{lid} " not in a
    sec5 = b.split("## 5.")[1].split("## 6.")[0]
    assert any(ln.startswith(f"- #{lid} ") and "rệp" in ln
               for ln in sec5.splitlines())
