"""v10.0 W100.5 — `agents.bks_recon`: đối soát độc lập BKS 4 nguồn.

Phần thuần (`diffs`, `pick_sample`, `recheck_rows`) không cần DB. Phần DB:
schema tạm + `docs/schema.sql` + `docs/roles.sql` → ROLLBACK
(`tests.test_ceo_audit.ceo_db`); fixture nạp bằng đường THẬT
`ingest.market_csv.read_export/load` + `ingest.settlement_csv.
read_settlement/load/reconcile`. Kỳ vọng viết sẵn trong
`tests/fixtures/bks/README.md`. Dữ liệu GIẢ `FAKESET*`.
"""

import json
import re
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

import pytest

from agents import bks_recon as br
from ingest import golden_store as gs
from ingest import market_csv as mc
from ingest import settlement_csv as sc
from pipelines.period import VN_TZ
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "bks"
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
PII_RE = re.compile(r"FAKESET|nguoimuagia|NGUOI NHAN GIA|DUONG GIA LAP|"
                    r"VDGIA|090000\d{4}|\b[0-9a-f]{16}\b")
TOL = {"shopee": 100, "tiktok": 100}


@pytest.fixture
def db():
    yield from ceo_db()


# ------------------------------------------------------------------ thuần

def _src(**ch):
    return {"month": "2026-09", "channels": {
        k: {"Q": None, "D": None, "P": None, "C": None, "tol": 100, **v}
        for k, v in ch.items()}}


def _q(amount=1000, payout=900):
    return {"order_amount": amount, "payout": payout, "n": 2,
            "refs": ["f.csv (2 dòng)"], "row_refs": ["f.csv dòng 3"]}


def test_diffs_match_and_codes():
    ok = _src(shopee={"Q": _q(), "D": {"value": 1000, "refs": []},
                      "P": {"thuc_nhan": 900, "refs": ["pnl:2026-09/shopee"]},
                      "C": {"value": 900, "refs": ["channel_snapshots#1"]}})
    assert br.diffs(ok) == []
    bad = _src(shopee={"Q": _q(), "D": {"value": 800, "refs": []},
                       "P": {"thuc_nhan": 700, "refs": ["pnl:2026-09/shopee"]},
                       "C": {"value": 1200, "refs": ["channel_snapshots#7"]}})
    got = {(d["code"], d["delta"]) for d in br.diffs(bad)}
    assert got == {("pnl_lech_quyet_toan", 200),
                   ("cockpit_lech_quyet_toan", -300),
                   ("don_lech_quyet_toan", 200)}
    by = {d["code"]: d for d in br.diffs(bad)}
    assert by["cockpit_lech_quyet_toan"]["refs"][-1] == "channel_snapshots#7"
    assert by["don_lech_quyet_toan"]["refs"] == ["f.csv dòng 3"]
    assert "pnl:2026-09/shopee" in by["pnl_lech_quyet_toan"]["refs"]


def test_diffs_missing_source_not_zero():
    s = _src(shopee={"Q": _q(), "D": {"value": 1000, "refs": []},
                     "P": {"thuc_nhan": 900, "refs": []}})
    ds = br.diffs(s)
    assert [(d["code"], d["pair"]) for d in ds] == [
        ("thieu_nguon", "cockpit_lech_quyet_toan")]
    assert ds[0]["delta"] is None and ds[0]["b"]["gia_tri"] is None
    # kênh không có nguồn nào → không có khác biệt
    assert br.diffs(_src(tiktok={})) == []


@pytest.mark.parametrize("off,n", [(100, 0), (-100, 0), (101, 1),
                                   (-101, 1)])
def test_diffs_tolerance_boundary(off, n):
    s = _src(shopee={"Q": _q(), "D": {"value": 1000, "refs": []},
                     "P": {"thuc_nhan": 900, "refs": []},
                     "C": {"value": 900 + off, "refs": []}})
    assert len(br.diffs(s)) == n


def test_pick_sample():
    assert br.pick_sample([3, 1, 2], seed=1) == [1, 2, 3]
    ids = list(range(1, 201))
    assert br.pick_sample(ids, 5) == ids
    big = list(range(1, 251))
    a, b = br.pick_sample(big, 7), br.pick_sample(list(reversed(big)), 7)
    assert len(a) == 200 == len(set(a)) and a == sorted(a) and a == b
    assert br.pick_sample(big, 8) != a


def test_recheck_rows_pure():
    fees = {"shopee": {**sc.load_fees()[0]["shopee"]}}
    row = {"channel": "shopee", "order_id_hash": "h", "ref": "f dòng 2",
           "order_amount": 100000, "fixed_fee": 4000, "payment_fee": 5000,
           "service_fee": 3000, "shipping_fee": 0, "voucher_seller": 0,
           "affiliate": 0, "refund": 0, "payout": 88000}
    ok = dict(row, stored={"label": "khop", "expected": 88000})
    assert br.recheck_rows([ok], {("shopee", "h"): 100000}, fees) == []
    wrong = dict(ok, stored={"label": "lech", "expected": 88000})
    assert [f["code"] for f in br.recheck_rows(
        [wrong], {("shopee", "h"): 100000}, fees)] == ["nhan_lech"]
    none = dict(row, stored=None)
    assert [f["code"] for f in br.recheck_rows([none], {}, fees)] == [
        "chua_doi_soat", "quyet_toan_khong_don"]


# ------------------------------------------------------------------ DB

def _load(db, kind: str):
    """Nạp golden + đơn + quyết toán bản `sach`/`lech` qua loader thật."""
    gs.load(db, json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8")))
    of = FIX / f"order_shopee_{kind}_MAU.csv"
    rows, errs, sha = mc.read_export(of, "shopee", "order",
                                     mc.load_mapping()[0])
    assert errs == []
    snap = mc.load(db, rows, "shopee", "order", of.name, sha)[0]
    sf = FIX / f"settlement_shopee_{kind}_MAU.csv"
    srows, errs, ssha = sc.read_settlement(sf, "shopee", sc.load_mapping()[0])
    assert errs == []
    sc.load(db, srows, "shopee", sf.name, ssha)
    sc.reconcile(db, sc.load_fees()[0], ssha)
    return snap


def _cockpit(db, delta: int):
    payout = db.execute("select sum(payout_vnd) from settlement_rows"
                        ).fetchone()[0]
    return db.execute(
        "insert into channel_snapshots (channel, metric_id, period_kind,"
        " period_start, value, source, source_ref, captured_by) values"
        " ('shopee', 'sales.settlement_vnd', 'month', '2026-09-01', %s,"
        " 'manual_export', 'sample:bks', 'test') returning id",
        (payout + delta,)).fetchone()[0]


def _collect(db, seed=1):
    return br.collect(TxConn(db), date(2026, 9, 1), seed,
                      sc.load_fees()[0])


def test_clean_fixture_zero_findings(db):
    _load(db, "sach")
    _cockpit(db, 0)
    data = _collect(db)
    assert br.findings_of(data) == []
    assert data["n_total"] == data["n_checked"] == 11
    sh = data["src"]["channels"]["shopee"]
    assert sh["Q"]["payout"] == sh["P"]["thuc_nhan"] == sh["C"]["value"]


def test_planted_mismatches_exact(db):
    snap = _load(db, "lech")
    cid = _cockpit(db, 50000)
    data = _collect(db)
    got = sorted((f["code"], f["channel"], tuple(f["refs"]))
                 for f in data["row_findings"])
    sf = "settlement_shopee_lech_MAU.csv"
    assert got == sorted([
        ("quyet_toan_lech", "shopee", (f"{sf} dòng 3",)),
        ("quyet_toan_khong_don", "shopee", (f"{sf} dòng 13",)),
        ("don_chua_quyet_toan", "shopee",
         (f"market_snapshots#{snap} dòng 14",))])
    assert [r for f in data["row_findings"] if f["code"] == "quyet_toan_lech"
            for r in f["reasons"]] == ["thuc_nhan"]
    ds = {d["code"]: d for d in br.diffs(data["src"])}
    assert set(ds) == {"don_lech_quyet_toan", "cockpit_lech_quyet_toan"}
    assert ds["don_lech_quyet_toan"]["delta"] == 300000
    assert ds["don_lech_quyet_toan"]["refs"] == [f"{sf} dòng 13"]
    assert ds["cockpit_lech_quyet_toan"]["delta"] == -50000
    assert f"channel_snapshots#{cid}" in ds["cockpit_lech_quyet_toan"]["refs"]


def test_cockpit_missing_is_thieu_nguon(db):
    _load(db, "sach")
    ds = br.diffs(_collect(db)["src"])
    assert [(d["code"], d["pair"]) for d in ds] == [
        ("thieu_nguon", "cockpit_lech_quyet_toan")]


@contextmanager
def _tamper(db):
    with db.transaction(force_rollback=True):
        db.execute("set local session_replication_role = replica")
        yield


def test_stored_label_tampered_is_nhan_lech(db):
    _load(db, "lech")
    _cockpit(db, 0)
    with _tamper(db):
        db.execute("update recon_results set label = 'khop', reasons = '[]'"
                   " where label = 'lech'")
        fs = [f for f in _collect(db)["row_findings"]
              if f["code"] == "nhan_lech"]
        assert [(f["refs"], f["stored"], f["recomputed"]) for f in fs] == [
            (["settlement_shopee_lech_MAU.csv dòng 3"], "khop", "lech")]
    with _tamper(db):
        db.execute("delete from recon_results where settlement_row_id ="
                   " (select min(id) from settlement_rows)")
        assert [f["code"] for f in _collect(db)["row_findings"]].count(
            "chua_doi_soat") == 1


def _cli(db, monkeypatch, *argv, log=None):
    monkeypatch.setattr(br, "connect", lambda: TxConn(db, log))
    return br.main(list(argv), now=NOW)


def _is_read(sql):
    s = sql.strip().lower()
    return s.startswith(("select", "with")) and not \
        re.search(r"\b(insert|update|delete)\b", s)


def test_cli_report_no_pii_read_only(db, monkeypatch, tmp_path, capsys):
    _load(db, "lech")
    _cockpit(db, 50000)
    log: list[str] = []
    rc = _cli(db, monkeypatch, "--month", "2026-09", "--seed", "3",
              "--out-dir", str(tmp_path), log=log)
    assert rc == 0
    assert all(_is_read(s) for s in log), [s for s in log if not _is_read(s)]
    text = (tmp_path / "bks-recon-2026-09.md").read_text(encoding="utf-8")
    out = capsys.readouterr().out
    for body in (text, out):
        assert not PII_RE.search(body), PII_RE.search(body)
    assert "seed 3" in text and "(MẪU)" in text
    assert "settlement_shopee_lech_MAU.csv dòng 13" in text
    assert db.execute("select count(*) from audit_runs").fetchone()[0] == 0


def test_cli_record_and_as_bks_reader(db, monkeypatch, tmp_path):
    _load(db, "lech")
    log: list[str] = []
    with db.transaction(force_rollback=True):
        db.execute("set local role bks_reader")
        assert _cli(db, monkeypatch, "--month", "2026-09", "--seed", "9",
                    "--record", "--out-dir", str(tmp_path), log=log) == 0
        writes = [s for s in log if not _is_read(s)]
        assert len(writes) == 1 and writes[0].lower().startswith(
            "insert into audit_runs")
        kind, label, params, n, by = db.execute(
            "select kind, period_label, params, findings, run_by from"
            " audit_runs").fetchone()
    assert (kind, label, by) == ("recon", "2026-09", "agent:bks_recon")
    assert params == {"seed": 9, "n_total": 12, "n_checked": 12}
    assert n == 5     # 3 dòng cài + don_lech + thieu_nguon (cockpit thiếu)


@pytest.mark.parametrize("argv", [
    [], ["--month", "2026-09", "--record", "--dry-run"],
    ["--month", "2026-09", "--seed", "-1"], ["--month", "2026-09", "--x"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(br, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        br.main(argv, now=NOW)
    assert e.value.code == 2


def test_cli_open_month_db_down_bad_fees(monkeypatch, tmp_path):
    monkeypatch.setattr(br, "connect", lambda: pytest.fail("connect"))
    assert br.main(["--month", "2026-10"], now=NOW) == 2
    monkeypatch.setattr(br, "load_fees", lambda: (None, "hỏng"))
    assert br.main(["--month", "2026-09"], now=NOW) == 1
    monkeypatch.undo()
    monkeypatch.setattr(br, "connect", lambda: None)
    assert br.main(["--month", "2026-09", "--out-dir", str(tmp_path)],
                   now=NOW) == 2
    assert list(tmp_path.iterdir()) == []
