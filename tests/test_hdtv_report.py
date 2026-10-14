"""v10.0 W100.6 — `agents.hdtv_report`: gói báo cáo HĐTV tháng/quý.

DB thật: schema tạm + `docs/schema.sql` + `docs/roles.sql` → ROLLBACK
(`tests.test_ceo_audit.ceo_db`). Số cockpit/override/audit_runs chèn tay
với ngày cố định trong quá khứ (kỳ đã đóng); quyết toán nạp từ fixture
`tests/fixtures/bks/*_sach_MAU.csv` qua loader thật. GROUNDING: mọi token số
trên trang phải thuộc 1 fact có nguồn (kiểm độc lập ở đây, không gọi
`check_grounded` của module). Tên người là giả lập.
"""

import re
from datetime import date, datetime
from decimal import Decimal

import pytest
from psycopg.types.json import Jsonb

from agents import ceo_report
from agents import hdtv_report as hr
from agents.fp_pnl import vnd
from pipelines.period import VN_TZ
from tests.test_bks_recon import _load
from tests.test_ceo_audit import TxConn, ceo_db

NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
NUM = re.compile(r"\d[\d.,]*")
SKIP = re.compile(r"\d{2}/\d{2}/\d{4}|\d{4}-\d{2}-\d{2}|\b\d{2}:\d{2}\b"
                  r"|\b\d{4}-(?:Q[1-4]|\d{2})\b|#\d+")
ENQ = "select enqueue_item(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"


@pytest.fixture
def db():
    yield from ceo_db()


def _snap(db, mid, ch, month, value):
    return db.execute(
        "insert into channel_snapshots (channel, metric_id, period_kind,"
        " period_start, value, source, source_ref, captured_by) values"
        " (%s, %s, 'month', %s, %s, 'manual_export', 'sample:hdtv', 'test')"
        " returning id", (ch, mid, month, value)).fetchone()[0]


def _override(db, oid, when):
    qid = db.execute(ENQ, ("board_pack", oid, "ceo", "t", f"p {oid}",
                           "medium", Jsonb({"ok": True}), "fail", "agent:x",
                           48)
                     ).fetchone()[0]
    return db.execute(
        "insert into decisions (kind, queue_id, decided_by, reason,"
        " created_at) values ('override_qa', %s, 'Mai Gia Lap', 'ép trình"
        " vì hạn hợp đồng 3 ngày', %s) returning id", (qid, when)
    ).fetchone()[0]


def _world(db, months=("2026-07-01", "2026-08-01", "2026-09-01")):
    _load(db, "sach")
    for m in months:
        _snap(db, "sales.settlement_vnd", "shopee", m,
              Decimal(3_000_000 + int(m[5:7]) * 1000))
        _snap(db, "social.followers", "facebook", m,
              Decimal(1200 + int(m[5:7])))
    _override(db, "BP-1", datetime(2026, 9, 10, 10, tzinfo=VN_TZ))
    _override(db, "BP-2", datetime(2026, 9, 28, 10, tzinfo=VN_TZ))
    _override(db, "BP-3", datetime(2026, 10, 2, 10, tzinfo=VN_TZ))


def _build(db, period):
    return hr.build(TxConn(db), period, NOW)


def _ungrounded(text: str, facts: list[dict]) -> set[str]:
    known = set()
    for f in facts:
        assert str(f.get("source") or "").strip(), f
        known |= {t.rstrip(".,") for t in NUM.findall(f["text"])}
    return {t.rstrip(".,") for t in NUM.findall(SKIP.sub(" ", text))} - known


@pytest.mark.parametrize("period", ["2026-09", "2026-Q3"])
def test_every_number_has_source(db, period):
    _world(db)
    pack = _build(db, period)
    text, ok = hr.finalize(pack)
    assert ok, pack["guardrail_violations"]
    assert _ungrounded(text, pack["facts"]) == set()
    assert pack["unreadable"] == 0, text
    heads = [h for h in hr.SECTION_HEADS if h in text]
    assert heads == list(hr.SECTION_HEADS)
    assert text.index(hr.SECTION_HEADS[0]) < text.index(hr.SECTION_HEADS[6])
    assert "(MẪU)" in text.splitlines()[0]


def test_key_numbers_match_independent_sql(db):
    _world(db)
    text, _ = hr.finalize(_build(db, "2026-09"))
    payout = db.execute(
        "select sum(payout_vnd) from settlement_rows where settled_on >="
        " '2026-09-01' and settled_on < '2026-10-01'").fetchone()[0]
    assert f"Tổng thực nhận quyết toán kỳ: {vnd(payout)}" in text
    n = db.execute(
        "select count(*) from decisions where kind = 'override_qa' and"
        " created_at >= '2026-09-01 00:00+07' and created_at <"
        " '2026-10-01 00:00+07'").fetchone()[0]
    assert n == 2
    assert f"Số lần ép trình bản QA FAIL trong kỳ: {n}" in text
    v = db.execute(
        "select value from channel_snapshots where metric_id ="
        " 'sales.settlement_vnd' and channel = 'shopee' and period_start ="
        " '2026-09-01'").fetchone()[0]
    row = next(x for x in text.splitlines()
               if "(sales.settlement_vnd)" in x and "| shopee |" in x)
    assert f"| {ceo_report.fmt_value(v, 'VND')} |" in row


def test_override_list_in_period_only(db):
    _world(db)
    text, _ = hr.finalize(_build(db, "2026-09"))
    sec = text[text.index(hr.SECTION_HEADS[5]):
               text.index(hr.SECTION_HEADS[6])]
    lines = [x for x in sec.splitlines() if x.startswith("- #")]
    assert len(lines) == 2 and all("ceo" in x for x in lines)
    assert "02/10/2026" not in sec and "Mai Gia Lap" in sec
    q = hr.finalize(_build(db, "2026-Q3"))[0]
    assert "Số lần ép trình bản QA FAIL trong kỳ: 2" in q


def test_mutation_literal_number_in_template_raises(db, monkeypatch):
    """Mutation: chèn số literal vào template mục → render raise (guard
    fail-closed). Bỏ guard trong `render` → test này ĐỎ (đã thử, evidence/
    v100_hdtv.log)."""
    _world(db)
    orig = hr.sec_bks

    def bad(conn, pack, now):
        return orig(conn, pack, now) + ["- Tỷ lệ tuân thủ 987654 điểm"]

    monkeypatch.setattr(hr, "SECTIONS", hr.SECTIONS[:-1] + (bad,))
    pack = _build(db, "2026-09")
    with pytest.raises(hr.UngroundedNumber, match="987654"):
        hr.render(pack)


def test_quarter_missing_month_not_partial_sum(db):
    _world(db, months=("2026-07-01", "2026-09-01"))
    text, _ = hr.finalize(_build(db, "2026-Q3"))
    rows = {m: next(x for x in text.splitlines() if f"({m})" in x)
            for m in ("sales.settlement_vnd", "social.followers")}
    cells = [c.strip() for c in rows["sales.settlement_vnd"].split("|")]
    assert cells[4] == hr.NO_DATA and cells[6] == hr.NOT_ENOUGH
    partial = ceo_report.fmt_value(Decimal(3_007_000 + 3_009_000), "VND")
    assert partial not in text
    cells = [c.strip() for c in rows["social.followers"].split("|")]
    assert cells[6] == ceo_report.fmt_value(Decimal(1209), "người")
    assert cells[7] == "last"


def test_quarter_value_pure():
    assert hr.quarter_value(None, [1, 2, 3]) == (None, "—")
    assert hr.quarter_value("sum", [Decimal(1), None, Decimal(3)]) == (
        None, hr.NOT_ENOUGH)
    assert hr.quarter_value("sum", [Decimal(1)] * 3) == (Decimal(3), None)
    assert hr.quarter_value("last", [None, None, Decimal(5)]) == (
        Decimal(5), None)
    assert hr.quarter_value("last", [Decimal(5), Decimal(5), None]) == (
        None, hr.NOT_ENOUGH)


def test_section_db_error_others_still_render(db):
    _world(db)
    with db.transaction(force_rollback=True):
        db.execute("revoke select on llm_usage from bks_reader")
        db.execute("set local role bks_reader")
        pack = _build(db, "2026-09")
        text, _ = hr.finalize(pack)
    assert pack["unreadable"] == 1
    sec = text[text.index(hr.SECTION_HEADS[3]):
               text.index(hr.SECTION_HEADS[4])]
    assert "*(không đọc được:" in sec
    assert text.count("không đọc được") == 1
    assert "Tổng thực nhận quyết toán kỳ:" in text


def test_bks_section_not_run_vs_run(db):
    _world(db)
    text, _ = hr.finalize(_build(db, "2026-09"))
    sec = text[text.index(hr.SECTION_HEADS[6]):]
    assert sec.count(hr.NOT_RUN) == 2 and "không vi phạm" not in sec
    rid = db.execute(
        "insert into audit_runs (kind, period_label, findings, report_sha256,"
        " run_by) values ('inside_out', '2026-09', 4, %s, 'agent:bks_audit')"
        " returning id", ("ab12" * 16,)).fetchone()[0]
    text, _ = hr.finalize(_build(db, "2026-09"))
    sec = text[text.index(hr.SECTION_HEADS[6]):]
    assert sec.count(hr.NOT_RUN) == 1
    assert f"4 phát hiện · mã băm báo cáo {'ab12' * 3} (audit_runs #{rid})" \
        in sec


@pytest.mark.parametrize("bad", ["2026-13", "2026-Q0", "2026-Q5", "2026-9",
                                 "26-09", "2026-W41", None])
def test_parse_period_rejects(bad):
    with pytest.raises(ValueError):
        hr.parse_period(bad, NOW)


def test_parse_period_ok_and_open():
    q = hr.parse_period("2026-Q3", NOW)
    assert q["months"] == [date(2026, 7, 1), date(2026, 8, 1),
                           date(2026, 9, 1)]
    assert q["end"] == datetime(2026, 10, 1, tzinfo=VN_TZ)
    for open_ in ("2026-10", "2026-Q4"):
        with pytest.raises(ValueError, match="chưa đóng"):
            hr.parse_period(open_, NOW)


@pytest.mark.parametrize("argv", [["--month", "2026-10"],
                                  ["--quarter", "2026-Q4"],
                                  ["--quarter", "2026-Q5"],
                                  ["--month", "2026-13"]])
def test_cli_open_or_bad_period_exit2(monkeypatch, argv):
    monkeypatch.setattr(hr, "connect", lambda: pytest.fail("connect"))
    assert hr.main(argv, now=NOW) == 2


@pytest.mark.parametrize("argv", [[], ["--month", "2026-09", "--quarter",
                                       "2026-Q3"], ["--now", "x"]])
def test_cli_usage_exit2(monkeypatch, argv):
    monkeypatch.setattr(hr, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        hr.main(argv, now=NOW)
    assert e.value.code == 2


def test_cli_bad_config_exit1_db_down_exit2(monkeypatch, tmp_path):
    monkeypatch.setattr(hr, "connect", lambda: pytest.fail("connect"))
    bad = tmp_path / "hdtv.json"
    bad.write_text('{"quarter_agg": {"sales.gmv_vnd": "avg"}}',
                   encoding="utf-8")
    monkeypatch.setattr(hr, "CONFIG_FILE", bad)
    assert hr.main(["--month", "2026-09"], now=NOW) == 1
    monkeypatch.undo()
    monkeypatch.setattr(hr, "connect", lambda: None)
    assert hr.main(["--month", "2026-09", "--out-dir", str(tmp_path / "o")],
                   now=NOW) == 2


def test_guardrail_violation_blocks_submit(db, monkeypatch, tmp_path,
                                           capsys):
    _world(db)
    calls = []
    monkeypatch.setattr(hr, "connect", lambda: TxConn(db))
    monkeypatch.setattr(hr, "guardrail_check", lambda t: {
        "ok": False, "violations": [{"type": "banned_word"}]})
    monkeypatch.setattr(hr.director, "submit",
                        lambda *a, **k: calls.append(a) or 1)
    rc = hr.main(["--month", "2026-09", "--submit", "--out-dir",
                  str(tmp_path)], now=NOW)
    assert rc == 1 and calls == []
    text = (tmp_path / "hdtv-2026-09.md").read_text(encoding="utf-8")
    assert "CẢNH BÁO GUARDRAIL" in text and "banned_word" in text
    assert "KHÔNG nộp" in capsys.readouterr().err


def test_submit_and_record_real_path(db, monkeypatch, tmp_path):
    _world(db)
    log: list[str] = []
    monkeypatch.setattr(hr, "connect", lambda: TxConn(db, log))
    rc = hr.main(["--quarter", "2026-Q3", "--submit", "--record",
                  "--out-dir", str(tmp_path)], now=NOW)
    assert rc == 0
    q = db.execute("select object_type, object_id, block, status, risk,"
                   " created_by from approval_queue where object_type ="
                   " 'hdtv_pack'").fetchall()
    assert q == [("hdtv_pack", "2026-Q3", "ceo", "pending", "high",
                  "agent:hdtv_report")]
    r = db.execute("select kind, period_label, run_by from audit_runs"
                   ).fetchall()
    assert r == [("hdtv_pack", "2026-Q3", "agent:hdtv_report")]


def test_month_cli_read_only_sql(db, monkeypatch, tmp_path):
    _world(db)
    log: list[str] = []
    monkeypatch.setattr(hr, "connect", lambda: TxConn(db, log))
    assert hr.main(["--month", "2026-09", "--out-dir", str(tmp_path)],
                   now=NOW) == 0
    bad = [s for s in log if re.search(
        r"\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b", s,
        re.IGNORECASE)]
    assert bad == []
    text = (tmp_path / "hdtv-2026-09.md").read_text(encoding="utf-8")
    assert "FAKESET" not in text and "0900000" not in text
