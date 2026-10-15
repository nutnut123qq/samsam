"""v9.1 W91.6 — FIN-Director (`agents.fin_director`): bản tin tuần GĐ tài
chính gom công nợ quá hạn + P&L + chi phí vận hành + dòng tiền + đề xuất ads.

DB thật: schema tạm + rollback (`fpa_conn` của tests/test_fp_pnl.py), dữ
liệu MẪU của W91.2–W91.4 + `dealer_ar_MAU.csv`. Không sửa director/acc_ar.
"""

import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from agents import acc_ar as ar
from agents import fin_director as fd
from agents import fp_ads as fa
from agents import fp_opscost as fo
from agents import fp_pnl as fp
from pipelines.pii import _mask_pii
from tests.test_fp_pnl import (
    COST,
    FIX,
    LEAK,
    _TxConn,
    add_costs,
    fpa_conn,
    load_fixtures,
)

ROOT = Path(__file__).resolve().parent.parent
VN = timezone(timedelta(hours=7))
HEADS = ("## Công nợ đại lý quá hạn", "## P&L tháng 10/2026",
         "## Chi phí vận hành tháng 10/2026", "## Dòng tiền 13 tuần",
         "## Đề xuất ngân sách ads", "## Người duyệt")


@pytest.fixture
def db():
    yield from fpa_conn()


def _seed(db, monkeypatch, costs=True):
    load_fixtures(db, monkeypatch)
    if costs:
        add_costs(db, monkeypatch, [k for k in COST if k != "sapentol-30v"])
    monkeypatch.setattr(fo, "connect", lambda: _TxConn(db))
    assert fo.main(["--load", str(FIX / "opex_MAU.csv")]) == 0
    monkeypatch.setattr(ar, "connect", lambda: _TxConn(db))
    assert ar.main(["--load", str(FIX / "dealer_ar_MAU.csv")]) == 0
    db.execute("insert into llm_usage (ts, agent_id, model, cost_usd, ok)"
               " values (%s, 'content', 'test/mau', %s, true)",
               (datetime(2026, 10, 5, 9, tzinfo=VN), Decimal(120)))
    monkeypatch.setattr(fd, "load_users", dict)


def _weekly(db, monkeypatch, tmp_path, *argv):
    monkeypatch.setattr(fd, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(fd, "REPORTS_DIR", tmp_path)
    return fd.main(["--weekly", *argv])


def _text(tmp_path):
    return (tmp_path / "director-finance-2026-10-12.md").read_text(
        encoding="utf-8")


def test_db_weekly_bulletin_sections(db, monkeypatch, tmp_path, capsys):
    _seed(db, monkeypatch)
    monkeypatch.setattr(fa, "connect", lambda: _TxConn(db))
    assert fa.main(["--propose", "--month", "2026-10"]) == 0
    capsys.readouterr()
    assert _weekly(db, monkeypatch, tmp_path, "--as-of", "2026-10-12") == 0
    out = capsys.readouterr().out
    assert "director-finance-2026-10-12.md" in out
    assert "0 mục chưa có dữ liệu" in out
    text = _text(tmp_path)
    pos = [text.index(h) for h in HEADS]
    assert pos == sorted(pos), pos
    assert "`DL-HN01`" in text and "PX-GIA" not in text
    assert "[CẢNH BÁO 80%] `cloud`: 3.300.000đ" in text
    assert "[VƯỢT TRẦN 100%] `saas`: 7.200.000đ" in text
    assert "đang chờ TGĐ ký: 2" in text
    assert f"1 SKU {fp.NO_COGS}: `sapentol-30v`" in text
    assert "Mục `budget_change` đang chờ duyệt: 1" in text
    assert "Số tuần âm ở kịch bản thấp:" in text
    assert _mask_pii(text) == text and _mask_pii(out) == out
    hashes = [r[0] for r in db.execute(
        "select order_id_hash from settlement_rows")]
    assert not any(h in text for h in hashes)
    assert not any(x in text for x in LEAK)
    assert "chưa có dữ liệu" not in text


def test_db_weekly_empty_cogs_still_lists_skus(db, monkeypatch, tmp_path,
                                               capsys):
    _seed(db, monkeypatch, costs=False)
    assert db.execute("select count(*) from cogs_versions").fetchone()[0] == 0
    assert _weekly(db, monkeypatch, tmp_path, "--as-of", "2026-10-12") == 0
    text = _text(tmp_path)
    m = re.search(rf"- (\d+) SKU {fp.NO_COGS}: (.+)", text)
    assert m and int(m[1]) == len(COST)
    assert all(f"`{k}`" in m[2] for k in COST)
    assert "Tổng lãi gộp (chỉ ô có giá vốn duyệt): 0đ" in text


def test_db_weekly_missing_section_cfg_nodata(db, monkeypatch, tmp_path,
                                              capsys):
    _seed(db, monkeypatch)
    raw = json.loads(fp.CONFIG_FILE.read_text(encoding="utf-8"))
    del raw["cash"], raw["opscost"]
    p = tmp_path / "fpa.json"
    p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", p)
    db.execute("drop table dealer_ar")
    assert _weekly(db, monkeypatch, tmp_path, "--as-of", "2026-10-12") == 0
    assert "3 mục chưa có dữ liệu" in capsys.readouterr().out
    text = _text(tmp_path)
    for h in HEADS:
        assert h in text, h
    assert text.count("(chưa có dữ liệu:") == 3
    assert "thiếu mục 'cash'" in text and "thiếu mục 'opscost'" in text
    assert "## P&L tháng 10/2026" in text and "Tổng thực nhận" in text


@pytest.mark.parametrize("argv", [["--weekly", "--as-of", "2026-13-01"],
                                  ["--as-of", "2026-10-12"], []])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(fd, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        fd.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_broken_cfg_exit1_before_connect(monkeypatch, tmp_path, capsys):
    calls = []
    monkeypatch.setattr(fd, "connect", lambda: calls.append(1))
    bad = tmp_path / "fpa.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", bad)
    assert fd.main(["--weekly"]) == 1
    assert "không connect" in capsys.readouterr().out and calls == []


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(fd, "connect", lambda: None)
    assert fd.main(["--weekly", "--as-of", "2026-10-12"]) == 2


def test_pure_sections_no_pii():
    res = {"month": date(2026, 10, 1), "loai": ["savina-12v"],
           "tong_thuc_nhan": 1_000_000, "tong_lai_gop": 0, "n_rows": 3}
    lines = fd.pnl_section(res) + fd.ads_section(2) + fd.nodata(
        fd.H_AR, "lỗi\nnhiều dòng")
    text = "\n".join(lines)
    assert "(chưa có dữ liệu: lỗi nhiều dòng)" in text
    assert _mask_pii(text) == text
