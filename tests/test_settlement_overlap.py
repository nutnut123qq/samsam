"""v13.2 c02 — F01 khoản quyết toán xuất lại ở file khác/chồng kỳ + F09 mốc
năm hợp tác tách khỏi ngày bắt đầu vận hành.

F01 (probe `overlapping_export_duplicate`): 2 file quyết toán khác SHA cùng
1 khoản (doanh thu 1.000.000, phí 50.000) → thuần PHẢI là 950.000 (không
1.900.000 âm thầm), có cảnh báo chồng kỳ ghi nguồn 2 file, KHÔNG tính phí.
Mọi caller số doanh thu (rev_share / P&L / BKS / view Bên A / ACC-Recon
report / fp_cash) đọc CÙNG view `v_settlement_khoan` → số khớp nhau. Điều
chỉnh hợp lệ (2 dòng khác `txn_type` cùng đơn) vẫn giữ; nạp lại cùng file
vẫn idempotent.

F09 (probe `year_from_operating_date`): `--year N` tính từ
`ngay_ky_hop_dong` (HĐ Điều 3.1), KHÔNG từ `ngay_bat_dau_van_hanh` (mốc
phí, Điều 8.1/9.3). Cả hai null = chưa chốt.

DB: schema tạm + schema.sql ×2 + roles.sql ×2 → ROLLBACK
(`tests.test_ceo_audit.ceo_db`). Dữ liệu giả.
"""

import json
import re
from datetime import date, datetime, timedelta
from itertools import pairwise
from pathlib import Path

import pytest

from agents import bks_recon, fp_cash, fp_pnl
from agents import rev_share as rs
from ingest import settlement_csv as sc
from pipelines.period import VN_TZ
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
HEADER = ("Mã đơn hàng,Ngày hoàn thành thanh toán,Giá sản phẩm,Phí cố định,"
          "Phí thanh toán,Phí dịch vụ,Tổng tiền đã thanh toán")
# Khoản của probe: doanh thu 1.000.000, phí 50.000 → thực nhận 950.000.
ROW_A = "OVTEST0001,05/08/2026,1.000.000,-50.000,0,0,950.000"
HASH_RE = re.compile(r"\b[0-9a-f]{16}\b")


@pytest.fixture
def db():
    yield from ceo_db()


def _file(tmp_path, name, rows, eol="\n") -> Path:
    p = tmp_path / name
    p.write_bytes(eol.join([HEADER, *rows, ""]).encode("utf-8"))
    return p


def _load(db, monkeypatch, path, channel="shopee"):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(sc, "_connect", lambda _dsn: TxConn(db))
    return sc.main(["--file", str(path), "--channel", channel])


def _order(db, oid, status="Hoàn thành", ch="shopee"):
    db.execute(
        "insert into orders (id, ts, channel, total_vnd, status, source)"
        " values (%s, now(), %s, 0, %s, %s)",
        (f"{ch}:{sc.order_hash(ch, oid)}", ch, status, f"market:{ch}"))


def _cfg(tmp_path, monkeypatch, **over):
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(over)
    p = tmp_path / "rev_share.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(rs, "CONFIG_FILE", p)


def _quarter(db, monkeypatch, tmp_path, capsys, label="2026-Q3"):
    monkeypatch.setattr(rs, "connect", lambda: TxConn(db))
    capsys.readouterr()
    assert rs.main(["--quarter", label, "--dry-run"], now=NOW) == 0
    return capsys.readouterr().out


# ------------------------------------------------------------------ F01

def test_probe_overlapping_export_not_double_counted(db, monkeypatch,
                                                     tmp_path, capsys):
    """Probe F01: 2 file khác SHA (LF vs CRLF) cùng 1 khoản → thuần 950.000,
    BẤT THƯỜNG chồng kỳ có tên 2 file, không tính phí."""
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2026-01-01",
         ty_le_phi_van_hanh=0.05, kenh_truc_tuyen=["shopee"])
    a = _file(tmp_path, "quyet_toan_T8_lan1.csv", [ROW_A])
    b = _file(tmp_path, "quyet_toan_T8_lan2.csv", [ROW_A], eol="\r\n")
    assert a.read_bytes() != b.read_bytes()
    assert _load(db, monkeypatch, a) == 0
    assert _load(db, monkeypatch, b) == 0
    out = capsys.readouterr().out                   # cảnh báo ngay lúc nạp
    assert ("[warn] khoản xuất lại ở ≥2 file (chồng kỳ): trùng 1, lệch 0"
            in out)
    _order(db, "OVTEST0001")
    # dữ liệu thô GIỮ NGUYÊN 2 dòng (người đối soát xử lý), không xóa
    assert db.execute("select count(*) from settlement_rows").fetchone()[0] \
        == 2
    out = _quarter(db, monkeypatch, tmp_path, capsys)
    assert "1.900.000đ" not in out
    assert "**950.000đ**" in out
    assert "quyet_toan_T8_lan1.csv" in out and "quyet_toan_T8_lan2.csv" in out
    assert "BẤT THƯỜNG" in out and "chồng" in out
    assert "| Phí vận hành (quy đổi sản phẩm) | — (" in out   # không tính phí
    assert "47.500đ" not in out and "95.000đ" not in out
    assert not HASH_RE.search(out)


def test_overlap_same_number_across_callers(db, monkeypatch, tmp_path,
                                            capsys):
    """Cùng dataset → rev_share = P&L = BKS(Q) = view Bên A = ACC-Recon
    report = fp_cash: thực nhận 950.000, đều thấy chồng kỳ."""
    a = _file(tmp_path, "lan1.csv", [ROW_A])
    b = _file(tmp_path, "lan2.csv", [ROW_A], eol="\r\n")
    for p in (a, b):
        assert _load(db, monkeypatch, p) == 0
    _order(db, "OVTEST0001")
    conn = TxConn(db)
    rows, _undated = rs.fetch(conn, date(2026, 7, 1), date(2026, 10, 1),
                              ["shopee"])
    ov = sc.overlaps(conn, ["shopee"], date(2026, 7, 1), date(2026, 10, 1))
    s = rs.summarize(rows, ["shopee"], rs.FEE_COLS, ov)
    assert s["total"]["payout"] == 950_000 and s["total"]["net"] == 950_000
    assert s["anomaly"] is True
    assert ov == {"shopee": {"trung": 1, "lech": 0,
                             "files": ["lan1.csv", "lan2.csv"]}}
    # P&L (và gói HĐTV dùng lại fp_pnl.compute)
    pn = fp_pnl.compute(conn, date(2026, 8, 1))
    assert pn["tong_thuc_nhan"] == 950_000 and pn["n_rows"] == 1
    assert pn["chong_ky"]["shopee"]["trung"] == 1
    assert "xuất lại ở ≥2 file" in fp_pnl.render(pn)
    # BKS: Q khớp + mã phát hiện riêng, chạy được dưới role bks_reader
    fees, why = sc.load_fees()
    assert why is None
    with db.transaction(force_rollback=True):
        db.execute("set local role bks_reader")
        data = bks_recon.collect(conn, date(2026, 8, 1), 1, fees)
    q = data["src"]["channels"]["shopee"]["Q"]
    assert (q["payout"], q["order_amount"], q["n"]) == (950_000, 1_000_000, 1)
    ck = [f for f in data["row_findings"]
          if f["code"] == "quyet_toan_chong_ky"]
    assert len(ck) == 1 and ck[0]["refs"] == ["lan1.csv", "lan2.csv"]
    assert "quyet_toan_chong_ky" in bks_recon.render(data, NOW)
    # view Bên A
    with db.transaction(force_rollback=True):
        db.execute("set local role ben_a_reader")
        got = db.execute("select sum(payout_vnd), sum(n_rows) from"
                         " v_ben_a_settlement_daily").fetchone()
    assert got == (950_000, 1)
    # fp_cash tỷ lệ thực nhận
    assert fp_cash.measure(conn, date(2026, 8, 17))["shopee"] == (
        950_000, 1_000_000, 1)
    # ACC-Recon report
    capsys.readouterr()
    assert sc.main(["--report"]) == 0
    out = capsys.readouterr().out
    assert "thực nhận theo file 950.000đ" in out
    assert "xuất lại ở ≥2 file: trùng 1, lệch 0" in out


def test_overlap_different_values_flagged_not_picked(db, monkeypatch,
                                                     tmp_path, capsys):
    """Cùng đơn ở 2 file nhưng số khác (xuất lại sau sửa? điều chỉnh?) →
    KHÔNG tự chọn file mới nhất: giữ cả 2 dòng, BẤT THƯỜNG lệch, không
    tính phí."""
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2026-01-01",
         ty_le_phi_van_hanh=0.05, kenh_truc_tuyen=["shopee"])
    a = _file(tmp_path, "lan1.csv", [ROW_A])
    b = _file(tmp_path, "lan2.csv",
              ["OVTEST0001,05/08/2026,1.000.000,-60.000,0,0,940.000"])
    for p in (a, b):
        assert _load(db, monkeypatch, p) == 0
    _order(db, "OVTEST0001")
    ov = sc.overlaps(TxConn(db), ["shopee"], date(2026, 7, 1),
                     date(2026, 10, 1))
    assert ov["shopee"]["lech"] == 1 and ov["shopee"]["trung"] == 0
    out = _quarter(db, monkeypatch, tmp_path, capsys)
    assert "BẤT THƯỜNG" in out and "lệch" in out
    assert "lan1.csv" in out and "lan2.csv" in out
    assert "| Phí vận hành (quy đổi sản phẩm) | — (" in out


def test_overlap_outside_period_not_flagged(db, monkeypatch, tmp_path):
    """Khoản trùng nằm ngoài kỳ → không gắn bất thường cho kỳ khác."""
    a = _file(tmp_path, "lan1.csv", [ROW_A])
    b = _file(tmp_path, "lan2.csv", [ROW_A], eol="\r\n")
    for p in (a, b):
        assert _load(db, monkeypatch, p) == 0
    conn = TxConn(db)
    assert sc.overlaps(conn, ["shopee"], date(2026, 10, 1),
                       date(2027, 1, 1)) == {}
    assert sc.overlaps(conn, ["tiktok"]) == {}
    assert sc.overlaps(conn, ["shopee"])["shopee"]["trung"] == 1


def test_adjustment_rows_same_order_kept(db, monkeypatch, tmp_path):
    """Điều chỉnh hợp lệ: cùng đơn, 2 dòng khác `txn_type` trong 1 file →
    nạp được, cả 2 dòng tính, KHÔNG bất thường. Cùng đơn + cùng loại trong
    1 file vẫn lỗi (GIẢ ĐỊNH 1 dòng/đơn/loại)."""
    m, why = sc.load_mapping()
    assert why is None
    m["shopee"]["optional"]["txn_type"] = "Loại giao dịch"
    monkeypatch.setattr(sc, "load_mapping", lambda: (m, None))
    hdr = HEADER + ",Loại giao dịch"
    p = tmp_path / "dieu_chinh.csv"
    p.write_bytes("\n".join([
        hdr, ROW_A + ",Đơn hàng",
        "OVTEST0001,20/08/2026,0,0,0,0,-30.000,Điều chỉnh", ""]
    ).encode("utf-8"))
    assert _load(db, monkeypatch, p) == 0
    _order(db, "OVTEST0001")
    conn = TxConn(db)
    assert db.execute("select array_agg(txn_type order by row_no) from"
                      " settlement_rows").fetchone()[0] == [
        "Đơn hàng", "Điều chỉnh"]
    rows, _ = rs.fetch(conn, date(2026, 7, 1), date(2026, 10, 1), ["shopee"])
    ov = sc.overlaps(conn, ["shopee"], date(2026, 7, 1), date(2026, 10, 1))
    s = rs.summarize(rows, ["shopee"], rs.FEE_COLS, ov)
    assert ov == {} and s["anomaly"] is False
    assert s["total"]["payout"] == 920_000 and len(rows) == 2
    # cùng đơn + cùng loại trong 1 file → lỗi cả file, 0 dòng
    dup = tmp_path / "trung_loai.csv"
    dup.write_bytes("\n".join([hdr, ROW_A + ",Đơn hàng",
                               ROW_A + ",Đơn hàng", ""]).encode("utf-8"))
    rows2, errs, _sha = sc.read_settlement(dup, "shopee", m)
    assert rows2 == [] and any("trùng" in e for e in errs)


def test_reload_same_file_idempotent(db, monkeypatch, tmp_path, capsys):
    a = _file(tmp_path, "lan1.csv", [ROW_A])
    assert _load(db, monkeypatch, a) == 0
    assert _load(db, monkeypatch, a) == 0
    assert "[skip]" in capsys.readouterr().out
    assert db.execute("select count(*) from settlement_rows").fetchone()[0] \
        == 1
    assert sc.overlaps(TxConn(db), ["shopee"]) == {}


def test_schema_view_and_grant_blocks():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("===== v13.2 c02"):].split("\n-- =====", 1)[0]
    for v in ("v_ben_a_settlement_daily",):
        body = block[block.index(f"view {v}"):].split(";", 1)[0]
        assert "order_id_hash" not in body and "from v_settlement_khoan" \
            in body
    roles = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
    rb = roles[roles.index("===== v13.2 c02"):].split("\n-- =====", 1)[0]
    grants = re.findall(r"(?is)^grant\b.*?;", rb, re.MULTILINE)
    assert grants == ["grant select on v_settlement_khoan to bks_reader;"]


def test_ben_a_reader_cannot_read_khoan_view(db):
    with pytest.raises(Exception) as e, db.transaction():
        db.execute("set local role ben_a_reader")
        db.execute("select count(*) from v_settlement_khoan")
    assert "permission denied" in str(e.value)


# ------------------------------------------------------------------ F09

def test_default_config_dates_unset():
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    assert raw["ngay_ky_hop_dong"] is None           # KHÔNG lấy 12/10 dự kiến
    assert raw["ngay_bat_dau_van_hanh"] is None
    cfg = rs.load_config()
    assert cfg["sign"] is None and cfg["start"] is None


@pytest.mark.parametrize("over", [
    {"ngay_ky_hop_dong": "2026-02-30"}, {"ngay_ky_hop_dong": "12/10/2026"},
    {"ngay_ky_hop_dong": 20261012},
    {"ngay_ky_hop_dong": "2026-11-01", "ngay_bat_dau_van_hanh": "2026-10-31"},
])
def test_sign_date_config_invalid(tmp_path, over):
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(over)
    p = tmp_path / "c.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(rs.ConfigError):
        rs.load_config(p)


def test_probe_year_from_signing_not_operating(db, monkeypatch, tmp_path,
                                               capsys):
    """Probe F09: vận hành 11/02/2027 → năm 1 KHÔNG được là
    [2027-02-11, 2028-02-11); năm hợp tác tính từ ngày ký."""
    _cfg(tmp_path, monkeypatch, ngay_ky_hop_dong="2026-10-15",
         ngay_bat_dau_van_hanh="2027-02-11")
    monkeypatch.setattr(rs, "connect", lambda: TxConn(db))
    late = datetime(2027, 10, 15, 0, 0, tzinfo=VN_TZ)
    assert rs.main(["--year", "1", "--dry-run"], now=late) == 0
    out = capsys.readouterr().out
    assert "năm 1: 2026-10-15 → 2027-10-14" in out
    assert "2028-02-1" not in out
    assert "| Ngày ký hợp đồng (mốc năm hợp tác) | 2026-10-15 |" in out
    assert "| Ngày bắt đầu vận hành thương mại | 2027-02-11 |" in out
    # 1 giây trước 00:00 giờ VN ngày tròn năm → năm 1 chưa đóng
    assert rs.main(["--year", "1", "--dry-run"],
                   now=late - timedelta(seconds=1)) == 2


def test_year_needs_sign_even_when_operating_set(monkeypatch, tmp_path):
    _cfg(tmp_path, monkeypatch, ngay_bat_dau_van_hanh="2025-01-01")
    monkeypatch.setattr(rs, "connect", lambda: pytest.fail("connect"))
    assert rs.main(["--year", "1"], now=NOW) == 1


def test_quarter_fee_still_from_operating_date(tmp_path, monkeypatch):
    """Phí quý vẫn cắt theo ngày vận hành, KHÔNG theo ngày ký."""
    _cfg(tmp_path, monkeypatch, ngay_ky_hop_dong="2026-01-05",
         ngay_bat_dau_van_hanh="2026-08-20")
    cfg = rs.load_config()
    assert rs.quarter_range("2026-Q3", NOW, cfg["start"]) == (
        date(2026, 8, 20), date(2026, 10, 1))
    with pytest.raises(ValueError, match="trước ngày bắt đầu"):
        rs.quarter_range("2026-Q2", NOW, cfg["start"])


def test_year_range_leap_day_contiguous():
    """Ký 29/02 → các năm hợp tác liền nhau, không hở/chồng ngày."""
    far = datetime(2040, 1, 1, tzinfo=VN_TZ)
    spans = [rs.year_range(date(2028, 2, 29), n, far) for n in range(1, 6)]
    assert spans[0] == (date(2028, 2, 29), date(2029, 3, 1))
    assert spans[3] == (date(2031, 3, 1), date(2032, 2, 29))   # năm nhuận
    for (_s1, e1), (s2, _e2) in pairwise(spans):
        assert e1 == s2
    assert sum((e - s).days for s, e in spans) == (
        spans[-1][1] - spans[0][0]).days
