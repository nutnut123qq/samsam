"""v9.0 W90.5 — ACC-AR (`agents.acc_ar`): công nợ đại lý, tuổi nợ, hoa hồng
(BẢN NHÁP), cảnh báo quá hạn vào bản tin GĐ tài chính.

Thuần: biên tuổi nợ / FIFO / quá hạn / hoa hồng với `as_of` cố định. DB
thật: 1 transaction + schema tạm → ROLLBACK. Fixture `dealer_ar_MAU.csv`
là sổ công nợ TỔNG HỢP (mã đại lý giả, không tên/SĐT).
"""

import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

from agents import acc_ar as ar
from ingest import golden_store as gs

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "finance"
AR_FILE = FIX / "dealer_ar_MAU.csv"
AS_OF = date(2026, 10, 12)
VN = timezone(timedelta(hours=7))


def _cfg():
    cfg, why = ar.load_config()
    assert why is None, why
    return cfg


def _e(code="DL-01", kind="phat_sinh", amount=1_000_000, days_ago=0,
       due=None, sku="savina-12v", channel="offline", dtype="doanh_nghiep",
       row_no=2):
    return {"row_no": row_no, "dealer_code": code, "dealer_type": dtype,
            "kind": kind, "doc_ref": None,
            "doc_date": AS_OF - timedelta(days=days_ago), "due_date": due,
            "amount_vnd": amount, "sku_key": sku, "channel": channel}


# ---------- tuổi nợ (thuần) ----------

@pytest.mark.parametrize("days,bucket", [
    (0, "0-30"), (30, "0-30"), (31, "31-60"), (60, "31-60"), (61, "61-90"),
    (90, "61-90"), (91, ">90"), (400, ">90"), (-1, None)])
def test_age_bucket_boundaries(days, bucket):
    assert ar.age_bucket(AS_OF - timedelta(days=days), AS_OF) == bucket


def test_aging_fifo_and_future_dropped():
    es = [_e(amount=10_000_000, days_ago=90), _e(amount=5_000_000,
                                                  days_ago=10),
          _e(kind="thanh_toan", amount=-12_000_000, days_ago=1),
          _e(amount=7_000_000, days_ago=-1)]        # sau as_of → bỏ
    (r,) = ar.aging(es, AS_OF, 30)
    assert r["buckets"] == {"0-30": 3_000_000, "31-60": 0, "61-90": 0,
                            ">90": 0}
    assert r["con_no"] == 3_000_000 and r["du_co"] == 0
    # trả dư → dư có ghi riêng, không âm
    (r,) = ar.aging([_e(amount=1_000), _e(kind="thanh_toan", amount=-1_500)],
                    AS_OF, 30)
    assert r["con_no"] == 0 and r["du_co"] == 500
    # dieu_chinh âm là ghi có
    (r,) = ar.aging([_e(amount=1_000), _e(kind="dieu_chinh", amount=-400)],
                    AS_OF, 30)
    assert r["con_no"] == 600


def test_overdue_boundary_and_default_term():
    due = AS_OF
    (r,) = ar.aging([_e(days_ago=5, due=due)], AS_OF, 30)
    assert r["qua_han"] == 0                       # as_of == due
    (r,) = ar.aging([_e(days_ago=5, due=due - timedelta(days=1))], AS_OF, 30)
    assert r["qua_han"] == 1_000_000               # +1 ngày
    (r,) = ar.aging([_e(days_ago=30)], AS_OF, 30)  # due trống → +term_days
    assert r["qua_han"] == 0
    (r,) = ar.aging([_e(days_ago=31)], AS_OF, 30)
    assert r["qua_han"] == 1_000_000


# ---------- hoa hồng (thuần) ----------

SKUS = {"savina-12v": "tpbvsk", "ruou-sam-chai-thuy-tinh-500ml": "alcohol",
        "mat-ong-sam-300ml": "food"}
RUOU = "ruou-sam-chai-thuy-tinh-500ml"


def _comm(es):
    return ar.commission(es, SKUS, _cfg(), AS_OF - timedelta(days=60),
                         AS_OF + timedelta(days=1))


def test_commission_rules():
    cfg = _cfg()
    (x,) = _comm([_e(sku=RUOU, channel="online", amount=8_000_000)])
    assert x["hoa_hong"] == 0 and "ruou_online" in x["flags"]
    (x,) = _comm([_e(sku=RUOU, channel="offline", amount=6_000_000)])
    assert x["hoa_hong"] == round(6_000_000 * cfg["rates_pct"]["alcohol"])
    assert x["flags"] == []
    (x,) = _comm([_e(sku="savina-12v", channel="online", amount=1_250_005)])
    exp = (Decimal(1_250_005) * cfg["rates_pct"]["tpbvsk"]).quantize(
        Decimal(1), rounding="ROUND_HALF_UP")
    assert x["hoa_hong"] == int(exp) == 100_000    # 100000.4 → 100000
    (x,) = _comm([_e(sku="sku-khong-co", amount=5_000_000)])
    assert x["hoa_hong"] == 0 and x["flags"] == ["thieu_sku"]
    (x,) = _comm([_e(sku=None, amount=5_000_000)])
    assert x["hoa_hong"] == 0 and "thieu_sku" in x["flags"]
    (x,) = _comm([_e(sku=RUOU, channel=None, amount=5_000_000)])
    assert x["hoa_hong"] == 0 and "thieu_kenh" in x["flags"]
    (x,) = _comm([_e(dtype="ho_kinh_doanh")])
    assert "tncn" in x["flags"] and x["hoa_hong"] > 0
    # half-up: 0.08 × 6.25 = 0.5 → 1
    assert ar.round_half_up(Decimal("6.25") * Decimal("0.08")) == 1
    # sàn 0 + ngoài kỳ + thanh_toan không tính
    (x,) = _comm([_e(amount=1_000), _e(kind="dieu_chinh", amount=-5_000)])
    assert x["co_so"] == 0 and x["hoa_hong"] == 0
    assert _comm([_e(days_ago=200), _e(kind="thanh_toan", amount=-1)]) == []


def test_overdue_section_only_codes():
    es, errs, _ = ar.read_ar(AR_FILE)
    assert errs == [] and len(es) == 9
    L = ar.overdue_section(ar.aging(es, AS_OF, 30), AS_OF)
    text = "\n".join(L)
    assert L[0].startswith("## Công nợ đại lý quá hạn")
    assert "`DL-HN01`" in text and "`DL-DN02`" in text
    assert "DL-QN03" not in text                   # chưa quá hạn
    assert "PX-GIA" not in text and "PT-GIA" not in text   # không doc_ref
    assert ar.overdue_section([], AS_OF)[-1] == "- (không có)"


# ---------- file + CLI không DB ----------

def test_read_ar_errors_name_row_and_field(tmp_path):
    hdr = AR_FILE.read_bytes().decode("utf-8").split("\n")[0]
    for body, needle in (
            ("DL-01,doanh_nghiep,thanh_toan,,2026-10-01,,5.000,,",
             "dòng 2: field 'amount_vnd' phải < 0"),
            ("DL 01,doanh_nghiep,phat_sinh,,2026-10-01,,5.000,,",
             "dòng 2: field 'dealer_code'"),
            ("DL-01,doanh_nghiep,phat_sinh,,2026-10-05,2026-10-01,5.000,,",
             "'due_date' trước doc_date"),
            ("DL-01,ca_si,phat_sinh,,2026-10-01,,5.000,,", "'dealer_type'"),
            ("DL-01,ca_nhan,phat_sinh,,2026-10-01,,5.000,,shopee",
             "'channel'")):
        p = tmp_path / "a.csv"
        p.write_bytes((hdr + "\n" + body + "\n").encode("utf-8"))
        es, errs, _ = ar.read_ar(p)
        assert es == [] and any(needle in e for e in errs), (body, errs)
    p = tmp_path / "x.csv"
    p.write_bytes((hdr + ",ten_dai_ly\nDL-01,ca_nhan,phat_sinh,,2026-10-01,,"
                   "5,,,NGUYEN VAN GIA\n").encode("utf-8"))
    es, errs = ar.read_ar(p)[:2]
    assert es == [] and any("cột lạ 'ten_dai_ly'" in e for e in errs)
    assert not any("NGUYEN VAN GIA" in e for e in errs)


def _no_connect(monkeypatch):
    calls = []
    monkeypatch.setattr(ar, "connect", lambda: calls.append(1))
    return calls


@pytest.mark.parametrize("argv", [
    ["--aging", "--as-of", "2026-13-01"], ["--aging", "--bulletin"],
    ["--commission", "--from", "2026-10-01"],
    ["--commission", "--from", "2026-10-02", "--to", "2026-10-01"],
    ["--load", "x.csv", "--as-of", "2026-10-01"], []])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        ar.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_bad_file_exit1_zero_connect(tmp_path, monkeypatch, capsys):
    calls = _no_connect(monkeypatch)
    hdr = AR_FILE.read_bytes().decode("utf-8").split("\n")[0]
    p = tmp_path / "a.csv"
    p.write_bytes((hdr + "\nDL-01,ca_nhan,thanh_toan,,2026-10-01,,5,,\n"
                   "DL 02,ca_nhan,phat_sinh,,2026-10-01,,5,,\n")
                  .encode("utf-8"))
    assert ar.main(["--load", str(p)]) == 1
    assert "không connect, không nạp gì" in capsys.readouterr().out
    assert calls == []


# ---------- DB thật (schema tạm, rollback) ----------

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_w90a_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(ar, "connect", lambda: _TxConn(db))
    return ar.main(list(argv))


def test_db_load_aging_commission_bulletin(db, monkeypatch, tmp_path,
                                           capsys):
    assert _cli(db, monkeypatch, "--load", str(AR_FILE)) == 0
    assert db.execute("select count(*) from dealer_ar").fetchone()[0] == 9
    assert _cli(db, monkeypatch, "--load", str(AR_FILE)) == 0
    assert "[skip]" in capsys.readouterr().out
    assert db.execute("select count(*) from dealer_ar").fetchone()[0] == 9
    assert _cli(db, monkeypatch, "--aging", "--as-of", "2026-10-12") == 0
    out = capsys.readouterr().out
    assert "DL-HN01: còn nợ 10.000.000đ" in out and "PX-GIA" not in out
    assert _cli(db, monkeypatch, "--commission", "--from", "2026-09-01",
                "--to", "2026-10-31") == 0
    out = capsys.readouterr().out
    assert "BẢN NHÁP — không phải lệnh chi" in out
    assert "DL-DN02 alcohol/online: cơ sở 8.000.000đ × 0 = 0đ [ruou_online" \
        in out
    assert "[thieu_sku, tncn]" in out
    # bản tin GĐ tài chính có mục quá hạn + mã đại lý fixture
    now = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
    path, rows = ar.bulletin(_TxConn(db), AS_OF, now, out_dir=tmp_path)
    text = path.read_text(encoding="utf-8")
    assert path.name == "director-finance-2026-10-12.md"
    assert "## Công nợ đại lý quá hạn" in text and "`DL-HN01`" in text
    assert text.index("## Công nợ đại lý quá hạn") < text.index(
        "## Người duyệt")
    assert "PX-GIA" not in text
    assert {r["dealer_code"] for r in rows if r["qua_han"]} == {
        "DL-HN01", "DL-DN02"}


def test_db_bulletin_write_error_exit1_no_traceback(db, monkeypatch, capsys):
    assert _cli(db, monkeypatch, "--load", str(AR_FILE)) == 0
    capsys.readouterr()

    def boom(*_a, **_kw):
        raise PermissionError("denied")

    monkeypatch.setattr(ar.director, "run", boom)
    assert _cli(db, monkeypatch, "--bulletin", "--as-of", "2026-10-12") == 1
    cap = capsys.readouterr()
    assert "[error] PermissionError" in cap.err
    assert "Traceback" not in cap.err + cap.out and "[bulletin]" not in \
        cap.out


def test_code_regex_fullmatch():
    assert ar._CODE_RE.fullmatch("DL-01\n") is None
    assert ar._CODE_RE.fullmatch("dl-01") is None
    assert ar._CODE_RE.fullmatch("DL-01")
    assert ar._SKU_RE.fullmatch("savina-12v\n") is None
