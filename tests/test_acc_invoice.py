"""v9.0 W90.4 — ACC-Invoice (`agents.acc_invoice`): lô hóa đơn NHÁP vào
hàng duyệt chung, không ký số/không gửi.

Thuần: cấu hình, file yêu cầu xuất HĐ, `build_batch`, CSV/payload. DB thật:
1 transaction + schema tạm (docs/schema.sql ×2) → ROLLBACK cuối test; đơn
nạp qua `ingest.market_csv` (fixture `order_invoice_MAU.csv`: 13 Hoàn
thành, 2 Đã hủy, 1 Đang giao). Người duyệt trong test là tên GIẢ LẬP —
không phải người duyệt thật. Thông tin người mua (`BUYER`) là dữ liệu GIẢ,
khai báo hằng để quét rò rỉ.
"""

import json
import os
import re
import subprocess
import uuid
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest

from agents import acc_invoice as ai
from ingest import golden_store as gs
from ingest import market_csv as mc
from ingest.settlement_csv import order_hash
from pipelines import approval_queue as aq

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "finance"
ORDERS = FIX / "order_invoice_MAU.csv"
REQS = FIX / "invoice_requests_MAU.csv"
BUYER = ("CONG TY GIA LAP HOA DON MAU", "0109999999",
         "SO 99 PHO HOA DON GIA LAP", "hoadon.gialap@example.invalid")
MARKET_PII = ("nguoimuagia", "NGUOI NHAN GIA", "DUONG GIA LAP", "FAKEINV")
DECIDER = "nguoi_duyet_gia_lap"


def _cfg(**over):
    cfg, why = ai.load_config()
    assert why is None, why
    cfg.update(over)
    return cfg


def _leak(text: str, needles=BUYER) -> list[str]:
    return [n for n in needles if n in text]


# ---------- cấu hình + file yêu cầu (thuần) ----------

def test_config_assumed_and_valid():
    raw = (ROOT / "data" / "invoice_config.json").read_text(encoding="utf-8")
    assert "GIẢ ĐỊNH" in raw and "25/10/2026" in raw
    cfg = _cfg()
    assert cfg["invoice_trigger"] == "giao_thanh_cong"
    assert cfg["confirmed_by"] is None
    assert cfg["cancel_status"]["shopee"] == ["Đã hủy"]


@pytest.mark.parametrize("mut,needle", [
    ({"invoice_trigger": "khi_thanh_toan"}, "invoice_trigger"),
    ({"confirmed_by": ""}, "confirmed_by"),
    ({"csv_columns": ["ma_tham_chieu", "so_cmnd"]}, "csv_columns"),
    ({"request_columns": {"order_id": "Mã đơn hàng"}}, "request_columns"),
    ({"return_status": {"shopee": []}}, "return_status"),
])
def test_bad_config_rejected(tmp_path, mut, needle):
    raw = json.loads((ROOT / "data" / "invoice_config.json").read_text(
        encoding="utf-8"))
    raw.update(mut)
    p = tmp_path / "c.json"
    p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    cfg, why = ai.load_config(p)
    assert cfg is None and needle in why


def test_read_yeu_cau_ok_and_errors(tmp_path):
    cfg = _cfg()
    got, errs = ai.read_yeu_cau(REQS, "shopee", cfg)
    assert errs == []
    key = ("shopee", order_hash("shopee", "FAKEINV0005"))
    assert set(got) == {key}
    assert got[key]["tax_code"] == "0109999999"
    hdr = REQS.read_bytes().decode("utf-8").split("\n")[0].rstrip("\r")
    for body, needle in (
            ("FAKEINV0001,CONG TY GIA,010999999,DC,e@x.vn", "'tax_code'"),
            ("FAKEINV0001,,0109999999,DC,e@x.vn", "thiếu field 'buyer_name'"),
            ("FAKEINV0001,A,0109999999,,\nFAKEINV0001,B,0109999999-001,,",
             "mã đơn trùng dòng 2")):
        p = tmp_path / "r.csv"
        p.write_bytes((hdr + "\n" + body + "\n").encode("utf-8"))
        got, errs = ai.read_yeu_cau(p, "shopee", cfg)
        assert got == {} and any(needle in e for e in errs), (body, errs)
        assert not _leak(" ".join(errs), ("CONG TY GIA", "010999999",
                                          "e@x.vn"))


# ---------- build_batch (thuần) ----------

def _orders():
    rows, errs, _ = mc.read_export(ORDERS, "shopee", "order",
                                   mc.load_mapping()[0])
    assert errs == []
    out: dict = {}
    for r in rows:
        o = out.setdefault(r["order_id_hash"], {
            "channel": "shopee", "order_id_hash": r["order_id_hash"],
            "status": r["status"], "amount_vnd": 0, "items": []})
        o["amount_vnd"] += r["price"] * r["qty"]
        o["items"].append({"title": r["title"], "qty": r["qty"],
                           "price_vnd": r["price"]})
    return list(out.values())


def test_build_batch_counts_and_trigger_switch():
    from datetime import date
    cfg = _cfg()
    reqs, _ = ai.read_yeu_cau(REQS, "shopee", cfg)
    day = date(2026, 10, 12)
    b = ai.build_batch(_orders(), reqs, [], cfg, day)
    kinds = [x["kind"] for x in b["lines"]]
    assert len(kinds) == 13 and kinds.count("thuong") == 12
    assert kinds.count("can_mst") == 1
    assert b["excluded"] == {"huy": 2, "chua_dat_moc": 1, "da_lap": 0}
    assert b["unmatched_yeu_cau"] == 0
    b2 = ai.build_batch(_orders(), reqs, [],
                        _cfg(invoice_trigger="ban_giao_van_chuyen"), day)
    assert len(b2["lines"]) == 14 and b2["excluded"]["huy"] == 2
    # đơn đã thuộc lô pending/approved → không chọn lại; rejected không
    # nằm trong `invoiced` (fetch_invoiced lọc) → được chọn lại.
    first = b["lines"][0]
    inv = [{"channel": "shopee", "order_id_hash": first["order_id_hash"],
            "kind": "thuong", "batch_key": "2026-10-11-aaaaaaaaaaaa",
            "status": "pending", "amount_vnd": first["amount_vnd"]}]
    b3 = ai.build_batch(_orders(), reqs, inv, cfg, day)
    assert len(b3["lines"]) == 12 and b3["excluded"]["da_lap"] == 1


def test_csv_and_payload_buyer_only_in_csv():
    from datetime import date
    cfg = _cfg()
    reqs, _ = ai.read_yeu_cau(REQS, "shopee", cfg)
    b = ai.build_batch(_orders(), reqs, [], cfg, date(2026, 10, 12))
    data = ai.render_csv(b, cfg, 1)
    text = data.decode("utf-8")
    assert sorted(_leak(text)) == sorted(BUYER)
    assert text.count(cfg["retail_buyer"]) >= 12
    assert not _leak(text, MARKET_PII)
    title, payload = ai.render_payload(b, "2026-10-12-abcdef012345",
                                       "c" * 64, cfg, 1)
    assert not _leak(title + payload)
    assert "csv_sha256: " + "c" * 64 in payload
    assert "BẢN NHÁP — agent không ký số, không phát hành" in payload
    assert "cần MST" in payload and "GIẢ ĐỊNH" in payload
    full = {x["order_id_hash"] for x in b["lines"]}
    assert not any(h in payload for h in full)       # chỉ hash rút gọn
    from pipelines.guardrail import check
    assert check(payload)["ok"] is True


def test_csv_formula_injection_neutralised():
    from datetime import date
    cfg = _cfg()
    o = {"channel": "shopee", "order_id_hash": "a" * 16,
         "status": "Hoàn thành", "amount_vnd": 1,
         "items": [{"title": "=HYPERLINK(\"x\")", "qty": 1,
                    "price_vnd": 1}]}
    b = ai.build_batch([o], {}, [], cfg, date(2026, 10, 12))
    text = ai.render_csv(b, cfg, 1).decode("utf-8")
    assert "'=HYPERLINK" in text and ",=HYPERLINK" not in text


def _adj_case(orig_kind):
    o = {"channel": "shopee", "order_id_hash": "d" * 16,
         "status": "Trả hàng/Hoàn tiền", "amount_vnd": 100,
         "items": [{"title": "X", "qty": 1, "price_vnd": 100}]}
    inv = [{"channel": "shopee", "order_id_hash": "d" * 16,
            "kind": orig_kind, "batch_key": "2026-10-11-abcdefabcdef",
            "status": "approved", "amount_vnd": 100}]
    return o, inv


@pytest.mark.parametrize("orig_kind", ["can_mst", "thuong"])
def test_adjustment_buyer_points_to_original_invoice(orig_kind):
    """Dòng điều chỉnh KHÔNG được mang retail_buyer — gốc có thể là HĐ
    doanh nghiệp có MST (finding v9.0 cold-check)."""
    from datetime import date
    cfg = _cfg()
    o, inv = _adj_case(orig_kind)
    b = ai.build_batch([o], {}, inv, cfg, date(2026, 10, 12))
    assert [x["kind"] for x in b["lines"]] == ["dieu_chinh"]
    assert b["lines"][0]["orig_kind"] == orig_kind
    text = ai.render_csv(b, cfg, 1).decode("utf-8")
    assert cfg["retail_buyer"] not in text
    assert "THEO HĐ GỐC lô 2026-10-11-abcdefabcdef" in text
    _t, payload = ai.render_payload(b, "2026-10-12-abcdef012345", "c" * 64,
                                    cfg, 1)
    assert "người mua THEO HĐ GỐC" in payload
    assert "số tiền ghi DƯƠNG = giá trị điều chỉnh GIẢM" in payload
    if orig_kind == "can_mst":
        assert "gốc cần MST: lấy tên/MST/địa chỉ từ HĐ gốc" in text
        assert "— gốc cần MST" in payload
    else:
        assert "gốc cần MST" not in text + payload


def test_adjustment_buyer_from_yeu_cau():
    from datetime import date
    cfg = _cfg()
    o, inv = _adj_case("can_mst")
    buyer = dict(zip(("buyer_name", "tax_code", "address", "email"), BUYER))
    b = ai.build_batch([o], {("shopee", "d" * 16): buyer}, inv, cfg,
                       date(2026, 10, 12))
    assert b["unmatched_yeu_cau"] == 0
    text = ai.render_csv(b, cfg, 1).decode("utf-8")
    assert sorted(_leak(text)) == sorted(BUYER)
    assert cfg["retail_buyer"] not in text and "THEO HĐ GỐC" not in text
    _t, payload = ai.render_payload(b, "2026-10-12-abcdef012345", "c" * 64,
                                    cfg, 1)
    assert "người mua theo file yêu cầu" in payload and not _leak(payload)


def test_module_imports_no_network():
    src = (ROOT / "agents" / "acc_invoice.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|httpx|requests|urllib|llm_gateway|openai",
                         src)


def test_draft_dir_gitignored():
    r = subprocess.run(["git", "check-ignore", "-q",
                        "data/reports/hoa-don-nhap/x.csv"], cwd=ROOT,
                       check=False)
    assert r.returncode == 0


# ---------- CLI không DB ----------

def _no_connect(monkeypatch):
    calls = []
    monkeypatch.setattr(ai, "connect", lambda: calls.append(1))
    return calls


@pytest.mark.parametrize("argv", [
    ["--batch", "--verify-draft", "1", "--file", "x.csv"],
    ["--batch", "--day", "2026-13-01"],
    ["--verify-draft", "1"],
    ["--batch", "--yeu-cau", "x.csv"],
    [],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        ai.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_bad_request_file_exit1_zero_connect(tmp_path, monkeypatch,
                                                 capsys):
    calls = _no_connect(monkeypatch)
    hdr = REQS.read_bytes().decode("utf-8").split("\n")[0].rstrip("\r")
    p = tmp_path / "r.csv"
    p.write_bytes((hdr + "\nFAKEINV0001,CONG TY GIA,12345,DC,e@x.vn\n")
                  .encode("utf-8"))
    assert ai.main(["--batch", "--yeu-cau", str(p), "--channel",
                    "shopee"]) == 1
    out = capsys.readouterr().out
    assert "không connect, không ghi gì" in out and "12345" not in out
    assert "CONG TY GIA" not in out and calls == []


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
        schema = f"t_w90i_{uuid.uuid4().hex[:12]}"
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
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

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


def _load_orders(db, monkeypatch, path=ORDERS):
    proxy = _TxConn(db)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(mc, "_connect", lambda _dsn: proxy)
    assert mc.main(["--file", str(path), "--channel", "shopee", "--kind",
                    "order"]) == 0


def _today(db):
    return db.execute("select (now() at time zone 'Asia/Ho_Chi_Minh')::date"
                      ).fetchone()[0]


def _cli(db, monkeypatch, tmp_path, *argv):
    proxy = _TxConn(db)
    monkeypatch.setattr(ai, "connect", lambda: proxy)
    monkeypatch.setattr(ai, "DRAFT_DIR", tmp_path)
    return ai.main(list(argv))


def _queue(db):
    return db.execute(
        "select id, object_type, object_id, block, status, risk, title,"
        " payload, due_at - created_at from approval_queue order by id"
    ).fetchall()


def test_db_batch_skip_reject_rerun_adjust_verify(db, monkeypatch, tmp_path,
                                                  capsys):
    _load_orders(db, monkeypatch)
    day = _today(db)
    argv = ["--batch", "--day", day.isoformat(), "--yeu-cau", str(REQS),
            "--channel", "shopee"]
    assert _cli(db, monkeypatch, tmp_path, *argv) == 0
    out = capsys.readouterr().out
    q = _queue(db)
    assert len(q) == 1
    qid, otype, key1, block, status, risk, title, payload, sla = q[0]
    assert (otype, block, status, risk) == ("invoice_batch", "finance",
                                            "pending", "high")
    assert sla == timedelta(hours=24)                # finance.json
    assert re.fullmatch(rf"{day.isoformat()}-[0-9a-f]{{12}}", key1)
    lines = db.execute("select kind, count(*) from invoice_lines where"
                       " batch_key = %s group by 1", (key1,)).fetchall()
    assert dict(lines) == {"thuong": 12, "can_mst": 1}
    draft = tmp_path / f"lo-{key1}.csv"
    assert draft.is_file() and sorted(_leak(draft.read_text(
        encoding="utf-8"))) == sorted(BUYER)
    # không lộ người mua: payload/title/invoice_lines/action log/stdout
    inv_txt = " ".join(str(r) for r in db.execute(
        "select * from invoice_lines").fetchall())
    log_txt = " ".join(json.dumps(r[0], ensure_ascii=False) for r in
                       db.execute("select detail from agent_action_log"))
    for blob in (title, payload, inv_txt, log_txt, out):
        assert not _leak(blob), blob[:200]
        assert not _leak(blob, MARKET_PII)
    hashes = [r[0] for r in db.execute("select order_id_hash from"
                                       " invoice_lines")]
    assert not any(h in out for h in hashes)

    # chạy lại cùng ngày → skip, không thêm mục
    assert _cli(db, monkeypatch, tmp_path, *argv) == 0
    assert "[skip]" in capsys.readouterr().out
    assert len(_queue(db)) == 1

    # verify-draft: mục còn pending → exit 1
    assert _cli(db, monkeypatch, tmp_path, "--verify-draft", str(qid),
                "--file", str(draft)) == 1
    # từ chối → chạy lại → lô mới cùng 13 đơn, khóa mới (lần lập 2)
    ok, msg = aq.decide(_TxConn(db), qid, DECIDER, "rejected")
    assert ok, msg
    assert _cli(db, monkeypatch, tmp_path, *argv) == 0
    q = _queue(db)
    assert len(q) == 2 and q[1][4] == "pending" and q[1][2] != key1
    qid2, key2 = q[1][0], q[1][2]
    assert db.execute("select count(*) from invoice_lines where batch_key ="
                      " %s", (key2,)).fetchone()[0] == 13
    assert "Lần lập trong ngày: 2" in q[1][7]

    # duyệt lô 2 → verify-draft file nguyên OK, sửa 1 byte → fail
    ok, msg = aq.decide(_TxConn(db), qid2, DECIDER, "approved")
    assert ok, msg
    draft2 = tmp_path / f"lo-{key2}.csv"
    assert _cli(db, monkeypatch, tmp_path, "--verify-draft", str(qid2),
                "--file", str(draft2)) == 0
    bad = tmp_path / "sua.csv"
    raw = bytearray(draft2.read_bytes())
    raw[-3] ^= 1
    bad.write_bytes(bytes(raw))
    assert _cli(db, monkeypatch, tmp_path, "--verify-draft", str(qid2),
                "--file", str(bad)) == 1
    assert _cli(db, monkeypatch, tmp_path, "--verify-draft", str(qid),
                "--file", str(draft)) == 1           # lô rejected

    # 1 đơn đã duyệt nay trả hàng → lô D+1 chỉ 1 dòng điều chỉnh
    txt = ORDERS.read_bytes().decode("utf-8")
    line = next(ln for ln in txt.split("\n")
                if ln.startswith("FAKEINV0001"))
    p = tmp_path / "order_tra_hang.csv"
    p.write_bytes(txt.replace(line, line.replace(
        "Hoàn thành", "Trả hàng/Hoàn tiền")).encode("utf-8"))
    _load_orders(db, monkeypatch, p)
    day2 = day + timedelta(days=1)
    assert _cli(db, monkeypatch, tmp_path, "--batch", "--day",
                day2.isoformat()) == 0
    q = _queue(db)
    assert len(q) == 3
    rows = db.execute(
        "select kind, ref_batch_key, order_id_hash, amount_vnd from"
        " invoice_lines where batch_key = %s", (q[2][2],)).fetchall()
    assert len(rows) == 1 and rows[0][:2] == ("dieu_chinh", key2)
    assert rows[0][2] == order_hash("shopee", "FAKEINV0001")
    assert "điều chỉnh — lô gốc" in q[2][7]
    # chạy lại D+2 (lô D+1 còn pending): đơn đã có điều chỉnh → không lặp
    batch = ai.build_batch(ai.fetch_orders(db, day2), {},
                           ai.fetch_invoiced(db), _cfg(), day2)
    assert batch["lines"] == []


def test_db_empty_batch_and_lock(db, monkeypatch, tmp_path, capsys):
    day = _today(db)
    assert _cli(db, monkeypatch, tmp_path, "--batch", "--day",
                day.isoformat()) == 0
    assert "không có đơn cần lập hóa đơn" in capsys.readouterr().out
    assert _queue(db) == []
    # lần chạy khác đang giữ advisory lock → exit 1, không ghi
    other = psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=5,
                            autocommit=True)
    try:
        other.execute("select pg_advisory_lock(%s)", (ai.LOCK_KEY,))
        _load_orders(db, monkeypatch)
        assert _cli(db, monkeypatch, tmp_path, "--batch", "--day",
                    day.isoformat()) == 1
        assert "đang có 1 lần --batch khác chạy" in capsys.readouterr().out
        assert _queue(db) == []
    finally:
        other.close()
    assert _cli(db, monkeypatch, tmp_path, "--batch", "--day",
                day.isoformat()) == 0
    assert len(_queue(db)) == 1


def test_db_snapshot_cutoff_end_of_day(db, monkeypatch, tmp_path):
    """Lô ngày D chỉ dùng snapshot nạp TRƯỚC hết ngày D (VN) — chạy bù ngày
    cũ không được lấy trạng thái từ snapshot nạp sau D."""
    _load_orders(db, monkeypatch)                    # FAKEINV0016 Đang giao
    txt = ORDERS.read_bytes().decode("utf-8")
    line = next(ln for ln in txt.split("\n") if ln.startswith("FAKEINV0016"))
    p = tmp_path / "order_giao_xong.csv"
    p.write_bytes(txt.replace(line, line.replace("Đang giao", "Hoàn thành"))
                  .encode("utf-8"))
    _load_orders(db, monkeypatch, p)
    sid2 = db.execute("select max(id) from market_snapshots").fetchone()[0]
    db.execute("update market_snapshots set imported_at = now() + interval"
               " '1 day' where id = %s", (sid2,))
    day = _today(db)
    h = order_hash("shopee", "FAKEINV0016")

    def status(d):
        return {o["order_id_hash"]: o["status"]
                for o in ai.fetch_orders(db, d)}[h]

    assert status(day) == "Đang giao"
    assert ai.build_batch(ai.fetch_orders(db, day), {}, [], _cfg(),
                          day)["excluded"]["chua_dat_moc"] == 1
    assert status(day + timedelta(days=1)) == "Hoàn thành"
    assert ai.build_batch(ai.fetch_orders(db, day + timedelta(days=1)), {},
                          [], _cfg(), day)["excluded"]["chua_dat_moc"] == 0


def test_db_draft_write_error_exit1_hint(db, monkeypatch, tmp_path, capsys):
    _load_orders(db, monkeypatch)

    def boom(*_a, **_kw):
        raise PermissionError("denied")

    monkeypatch.setattr(ai, "write_report", boom)
    assert _cli(db, monkeypatch, tmp_path, "--batch", "--day",
                _today(db).isoformat()) == 1
    cap = capsys.readouterr()
    assert "ghi file nháp lỗi (PermissionError)" in cap.err
    assert "TỪ CHỐI mục đó rồi chạy lại --batch" in cap.err
    assert "Traceback" not in cap.err + cap.out
    q = _queue(db)
    assert [(r[1], r[4]) for r in q] == [("invoice_batch", "pending")]
    assert list(tmp_path.glob("lo-*.csv")) == []


def test_mst_ascii_digits_only():
    fullwidth = "".join(chr(0xFF10 + int(c)) for c in "0109999999")
    for bad in (fullwidth, "0109999999\n", "0109999999-01", "01099999990"):
        assert ai._MST_RE.fullmatch(bad) is None, repr(bad)
    for ok in ("0109999999", "0109999999-001"):
        assert ai._MST_RE.fullmatch(ok)
