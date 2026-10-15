"""v14.4 (p4) — 4 tính năng Kinh doanh TMĐT còn thiếu code (PL01 mục 2):

  sales-04.1  người phụ trách (MÃ nhân viên) + hạn xử lý theo giờ làm việc
              (`ingest.crm --owner`, qua `auth.cli_gate`); quá hạn →
              `agents.sales_director` mục `lead_followup` theo ĐỢT.
  sales-05    nhắc chốt đơn B2B (`agents.kd_quote --followups`): báo giá
              đã duyệt/đã gửi chưa có kết quả sau N giờ làm việc → NHÁP nhắc
              `b2b_followup`; `--verify-send` ghi mốc gửi, `--outcome` NGƯỜI
              ghi kết quả.
  sales-06.1  giá đại lý quan sát tay (`ingest.dealer_price`, kiểm toàn
              file) → `agents.kd_price --dealer-watch` so giá sàn golden →
              `dealer_price_alert` (kd_price vẫn KHÔNG có SQL ghi).
  sales-06.2  tỷ lệ hủy/hoàn bất thường tuần đã đóng (`agents.kd_orders
              --watch`) → `order_anomaly`, gom theo ĐỢT; đơn TRỄ "chưa đo".

Trên code cũ (v14-hop-dong trước p4) các hàm/cờ/bảng này không có → mọi test
dưới FAIL (AttributeError / argparse exit 2 / bảng thiếu) — xem
`evidence/v14_4_p4_oldcode_fail.log`.

DB thật: schema tạm `t_p4_<hex>` + ROLLBACK (mẫu test_crm/test_sales_director)
— không để lại dòng nào trong public.
"""

import json
import os
import re
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import kd_orders, kd_price, kd_quote, sales_watch
from agents import sales_director as sd
from ingest import crm, dealer_price
from pipelines import approval_queue as aq
from pipelines import auth, director, guardrail, period, rollout

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
VN = timezone(timedelta(hours=7))
AW, AH, JOB, LOADER = "agent_writer", "app_human", "svc_job", "svc_loader"
NAME, PHONE, EMAIL = "Nguyễn Văn An", "0912345678", "an@example.com"
PII = (NAME, PHONE, EMAIL, "an@example")
SALES = director.load_config("sales")
SHIFT = SALES["business_hours"]


def _t(d, h, m=0):
    """Giờ VN tháng 10/2026 — 12/10 là thứ Hai."""
    return datetime(2026, 10, d, h, m, tzinfo=VN)


# ======================================================== cấu hình (THUẦN)

def _watch_doc():
    return json.loads((ROOT / "data" / "sales_watch.json").read_bytes()
                      .decode("utf-8"))


def test_sales_watch_shipped_config_valid_and_unconfirmed():
    doc = sales_watch.load()
    assert doc["confirmed_by"] is None and "GIẢ ĐỊNH" in doc["status"]
    assert doc["lead_owner"]["staff_codes"] == []   # Bên B cấp, không bịa


@pytest.mark.parametrize("mut, frag", [
    (lambda d: d.update(la=1), "khóa lạ"),
    (lambda d: d["lead_owner"].update(max_per_run=0), "max_per_run"),
    (lambda d: d["lead_owner"].update(staff_codes=["Nguyễn An"]),
     "staff_codes"),
    (lambda d: d["lead_owner"].update(staff_codes=["nv01"]), "staff_codes"),
    (lambda d: d["quote_followup"].update(after_business_hours=True),
     "after_business_hours"),
    (lambda d: d["quote_followup"].pop("max_reminders"), "quote_followup"),
    (lambda d: d["dealer_price"].update(channels=[]), "channels"),
    (lambda d: d["order_watch"].update(return_status={}), "return_status"),
    (lambda d: d.update(confirmed_by=""), "confirmed_by"),
])
def test_sales_watch_bad_config_fail_closed(mut, frag):
    d = _watch_doc()
    mut(d)
    with pytest.raises(ValueError, match=frag):
        sales_watch.validate(d)


def test_sales_json_has_new_types_lane_b_and_catalog_maps_each():
    """4 loại việc mới vào khối sales (lớp B → GĐ bán hàng, quá hạn leo
    thang TGĐ) + mỗi loại thuộc ĐÚNG 1 tính năng danh mục (rollout cưỡng
    chế được ở biên enqueue)."""
    cfg = sd.load_sales_config()
    want = {"lead_followup": ("sales-04.1", "agent:sales_director"),
            "b2b_followup": ("sales-05", "agent:kd_quote"),
            "dealer_price_alert": ("sales-06.1", "agent:kd_price"),
            "order_anomaly": ("sales-06.2", "agent:kd_orders")}
    for ot, (fid, by) in want.items():
        spec = cfg["object_types"][ot]
        assert spec["handoff"] == "B" and spec["risk"] in ("medium", "high")
        assert rollout.feature_for(table="approval_queue", block="sales",
                                   object_type=ot, created_by=by) == fid
    feats = {f["id"]: f for f in rollout.load_features()}
    for fid, _ in want.values():
        f = feats[fid]
        assert f["code_status"] == "co_code", fid
        assert f["blocker"] and "chưa có lane" not in f["blocker"], fid
        assert "tests/test_v14_p4_sales.py" in f["bang_chung"]


# ======================================================== sales-06.1 file (THUẦN)

HDR = "kenh,ma_dai_ly,sku_key,gia_vnd,ngay,url_nguon\n"
TODAY = date(2026, 10, 14)


def _csv(tmp_path, body, name="gia.csv"):
    p = tmp_path / name
    p.write_bytes((HDR + body).encode("utf-8"))
    return p


def _read(path, today=TODAY):
    dp = sales_watch.section("dealer_price")
    return dealer_price.read_dealer_file(path, dp["channels"], dp["max_rows"],
                                     today)


def test_dealer_file_valid(tmp_path):
    p = _csv(tmp_path, "shopee,DL-01,sam-a,\"1.200.000\",2026-10-13,"
             "https://shopee.vn/shop/1?x=2\n"
             "cua_hang,DL-02,sam-b,900000,2026-10-12,https://maps.example.vn/a\n")
    rows, errs, sha = _read(p)
    assert errs == [] and len(rows) == 2 and re.fullmatch(r"[0-9a-f]{64}", sha)
    assert rows[0]["price_vnd"] == 1_200_000 and rows[0]["row_no"] == 2
    assert rows[1]["channel"] == "cua_hang"


@pytest.mark.parametrize("line, frag", [
    ("lazada,DL-01,sam-a,1000,2026-10-13,https://a.vn/x", "kenh"),
    ("shopee,dl 01,sam-a,1000,2026-10-13,https://a.vn/x", "ma_dai_ly"),
    ("shopee,DL-01,Sâm A,1000,2026-10-13,https://a.vn/x", "sku_key"),
    ("shopee,DL-01,sam-a,0,2026-10-13,https://a.vn/x", "gia_vnd"),
    ("shopee,DL-01,sam-a,abc,2026-10-13,https://a.vn/x", "gia_vnd"),
    ("shopee,DL-01,sam-a,1000,2026-10-15,https://a.vn/x", "ngay"),
    ("shopee,DL-01,sam-a,1000,13/10/2026,https://a.vn/x", "ngay"),
    ("shopee,DL-01,sam-a,1000,2026-10-13,http://a.vn/x", "url_nguon"),
    ("shopee,DL-01,sam-a,1000,2026-10-13,https://a.vn/goi-0912345678",
     "url_nguon"),
    ("shopee,DL-01,sam-a,1000,2026-10-13,https://a.vn/x y", "url_nguon"),
    ("shopee,DL-01,sam-a,1000,2026-10-13,", "url_nguon"),
])
def test_dealer_file_bad_row_rejects_whole_file(tmp_path, line, frag):
    good = "shopee,DL-02,sam-b,5000,2026-10-12,https://b.vn/y\n"
    rows, errs, _ = _read(_csv(tmp_path, good + line + "\n"))
    assert rows == [] and len(errs) == 1 and frag in errs[0]
    assert errs[0].startswith("dòng 3")
    assert "0912345678" not in errs[0] and "Sâm A" not in errs[0]


def test_dealer_file_structure_errors(tmp_path):
    p = tmp_path / "h.csv"
    p.write_bytes(b"kenh,ma_dai_ly,sku_key,gia_vnd,ngay\n"
                  b"shopee,DL-01,sam-a,1,2026-10-13\n")
    assert "header" in _read(p)[1][0]
    p.write_bytes(HDR.encode() + HDR.encode().replace(b"\n", b",x\n"))
    assert _read(p)[0] == []
    dup = ("shopee,DL-01,sam-a,1000,2026-10-13,https://a.vn/1\n"
           "shopee,DL-01,sam-a,900,2026-10-13,https://a.vn/2\n")
    rows, errs, _ = _read(_csv(tmp_path, dup))
    assert rows == [] and "trùng" in errs[0]
    p.write_bytes(HDR.encode())
    assert "không có dòng" in _read(p)[1][0]
    p.write_bytes(b"\xff\xfe")
    assert "UTF-8" in _read(p)[1][0]


# ======================================================== sales-06.2 luật (THUẦN)

OW = {"min_orders": 10, "baseline_weeks": 4, "check_weeks": 2,
      "cancel_rate_max_pct": 15, "return_rate_max_pct": 10, "spike_ratio": 2,
      "return_status": {"shopee": ["Đã hoàn tiền"]}}
W = date(2026, 10, 12)            # thứ Hai tuần hiện hành (as-of 14/10)


def _wk(i):
    return W - timedelta(days=7 * i)


def test_anomalies_threshold_and_spike_closed_weeks_only():
    counts = {
        ("shopee", W): {"n": 50, "cancel": 40, "return": 0},     # tuần mở
        ("shopee", _wk(1)): {"n": 20, "cancel": 4, "return": 0},  # 20% > 15
        ("shopee", _wk(2)): {"n": 40, "cancel": 4, "return": 4},  # 10%: =ngưỡng
        **{("shopee", _wk(i)): {"n": 40, "cancel": 2, "return": 1}
           for i in range(3, 7)},
        ("tiktok", _wk(1)): {"n": 9, "cancel": 9, "return": 0},   # < min
    }
    fs = kd_orders.anomalies(counts, TODAY, OW)
    got = {(f["channel"], f["kind"], f["week"]): f for f in fs}
    assert set(got) == {("shopee", "cancel", _wk(1)),
                        ("shopee", "cancel", _wk(2)),
                        ("shopee", "return", _wk(2))}
    a = got[("shopee", "cancel", _wk(1))]
    assert a["over"] and a["object_id"] == f"ow:shopee:cancel:{_wk(1)}:4"
    b = got[("shopee", "cancel", _wk(2))]    # 10% ≥ 2 × nền 5%, không vượt 15
    assert not b["over"] and b["spike"]
    c = got[("shopee", "return", _wk(2))]    # 10% ≥ 2 × 2.5%
    assert not c["over"] and c["spike"]


def test_anomalies_no_baseline_or_zero_bad_no_spike():
    counts = {("shopee", _wk(1)): {"n": 20, "cancel": 2, "return": 0},
              ("shopee", _wk(2)): {"n": 5, "cancel": 0, "return": 0}}
    assert kd_orders.anomalies(counts, TODAY, OW) == []


# ======================================================== CLI tham số (không DB)

@pytest.mark.parametrize("fn, argv", [
    (crm.main, ["--owner", "5", "--by", "Lan"]),
    (crm.main, ["--status", "5", "new", "--staff", "NV01", "--by", "Lan"]),
    (kd_quote.main, ["--outcome", "5", "chot"]),
    (kd_quote.main, ["--outcome", "5", "thang", "--by", "Lan"]),
    (kd_quote.main, ["--followups", "--by", "Lan"]),
    (dealer_price.main, ["--file", "x.csv"]),
    (kd_price.main, ["--dealer-file", "x.csv", "--by", "Lan"]),
    (kd_price.main, ["--dealer-watch", "--by", "Lan"]),
    (kd_price.main, ["--dealer-watch", "--as-of", "2026-10-01"]),
    (kd_orders.main, ["--watch", "--as-of", "2026-10-01"]),
    (kd_orders.main, ["--watch", "--sync"]),
])
def test_cli_usage_errors_exit2_before_db(fn, argv, monkeypatch):
    for m in (crm, kd_quote, kd_price, kd_orders, dealer_price):
        monkeypatch.setattr(m, "connect" if m is not crm else "_connect",
                            lambda: pytest.fail("không được connect"))
    with pytest.raises(SystemExit) as e:
        fn(argv)
    assert e.value.code == 2


def test_crm_owner_rejects_name_as_staff_code_before_db(monkeypatch, capsys):
    monkeypatch.setattr(crm, "_connect", lambda: pytest.fail("connect"))
    assert crm.main(["--owner", "5", "--staff", "Nguyen An", "--by",
                     "Lan"]) == 2
    assert "MÃ nhân viên" in capsys.readouterr().out


def test_bad_watch_config_exit1_before_connect(monkeypatch, tmp_path):
    bad = tmp_path / "w.json"
    bad.write_bytes(b"{broken")
    monkeypatch.setattr(sales_watch, "WATCH_FILE", bad)
    for m in (kd_price, kd_orders):
        monkeypatch.setattr(m, "connect", lambda: pytest.fail("connect"))
    assert kd_price.main(["--dealer-watch", "--dry-run"]) == 1
    assert kd_orders.main(["--watch", "--dry-run"]) == 1


# ======================================================== DB

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
        schema = f"t_p4_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)          # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close no-op; rollback → savepoint `sp` nếu có."""

    def __init__(self, conn, sp=None):
        self.conn, self.sp = conn, sp

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def cursor(self):
        return self.conn.cursor()

    def commit(self):
        pass

    def rollback(self):
        if self.sp:
            self.conn.execute(f"rollback to savepoint {self.sp}")

    def close(self):
        pass

    @property
    def info(self):
        return self.conn.info


@contextmanager
def _role(conn, role):
    conn.execute(f"set local role {role}")
    try:
        yield
    finally:
        conn.execute("reset role")


def _one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


def _lead(conn, ts, status="new", q=f"giá hộp quà, gọi {PHONE}"):
    return _one(conn, "insert into leads (dedup_key, ts, channel, user_hash,"
                " question, intent, status, source) values (%s, %s, 'zalo',"
                " 'uh-p4', %s, 'price', %s, 'conversations.jsonl')"
                " returning id", (f"t:{uuid.uuid4().hex}", ts, q, status))


def _queue(conn, ot):
    return conn.execute("select id, object_id, title, payload, status,"
                        " created_by from approval_queue where object_type ="
                        " %s order by id", (ot,)).fetchall()


# ---------------------------------------------------- sales-04.1

def test_assign_owner_sets_code_due_and_log(db):
    lid = _lead(db, _t(12, 9))
    with _role(db, AH):
        due = crm.assign_owner(_TxConn(db), lid, "NV01", "Lan",
                               now=_t(12, 16))
    # 8 giờ làm việc từ T2 16:00 (ca 08–18) → T3 14:00 VN.
    assert due == _t(13, 14) == period.business_deadline(
        _t(12, 16), 8, SHIFT)
    row = db.execute("select owner_code, owner_due_at, owner_assigned_by,"
                     " owner_assigned_at from leads where id = %s",
                     (lid,)).fetchone()
    assert row == ("NV01", due, "Lan", _t(12, 16))
    log = db.execute("select actor, action, detail from agent_action_log"
                     " where object_type = 'lead' and object_id = %s",
                     (str(lid),)).fetchall()
    assert [(a, b) for a, b, _ in log] == [("Lan", "crm_owner")]
    assert log[0][2]["to"] == "NV01" and log[0][2]["from"] is None
    for s in (PHONE, "giá hộp"):
        assert s not in json.dumps(log[0][2], ensure_ascii=False)


def test_assign_owner_rejects(db):
    won = _lead(db, _t(12, 9), status="won")
    lid = _lead(db, _t(12, 9))
    tx = _TxConn(db)
    with pytest.raises(ValueError, match="đã kết thúc"):
        crm.assign_owner(tx, won, "NV01", "Lan", now=_t(12, 10))
    with pytest.raises(ValueError, match="không có lead"):
        crm.assign_owner(tx, 10**12, "NV01", "Lan", now=_t(12, 10))
    for bad in ("nv01", "Nguyễn An", "N", "A" * 21):
        with pytest.raises(ValueError, match="MÃ nhân viên"):
            crm.assign_owner(tx, lid, bad, "Lan", now=_t(12, 10))
    with pytest.raises(ValueError, match="--by"):
        crm.assign_owner(tx, lid, "NV01", " ", now=_t(12, 10))
    watch = dict(sales_watch.section("lead_owner"), staff_codes=["NV02"])
    with pytest.raises(ValueError, match="không có trong danh sách"):
        crm.assign_owner(tx, lid, "NV01", "Lan", now=_t(12, 10), watch=watch)
    assert crm.assign_owner(tx, lid, "NV02", "Lan", now=_t(12, 10),
                            watch=watch)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("update leads set owner_code = 'Nguyễn' where id = %s",
                   (lid,))


def test_cli_owner_through_gate(db, monkeypatch, capsys):
    """`--owner` là quyết định người → `auth.cli_gate` khối sales hành động
    assign; bị chặn → không ghi (code cũ: không có cờ)."""
    lid = _lead(db, _t(12, 9))
    monkeypatch.setattr(crm, "_connect", lambda: _TxConn(db))
    calls = []

    def gate(conn, by, block, action, otype, oid, **kw):
        calls.append((by, block, action, otype, oid))
        return "chưa được Bên B ủy quyền (test)"
    monkeypatch.setattr(auth, "cli_gate", gate)
    assert crm.main(["--owner", str(lid), "--staff", "NV01", "--by",
                     "Lan"]) == 1
    assert calls == [("Lan", "sales", "assign", "crm", lid)]
    assert _one(db, "select owner_code from leads where id = %s",
                (lid,)) is None
    monkeypatch.setattr(auth, "cli_gate", lambda *a, **k: None)
    assert crm.main(["--owner", str(lid), "--staff", "NV01", "--by",
                     "Lan"]) == 0
    out = capsys.readouterr().out
    assert "NV01" in out and "hạn xử lý" in out and "staff_codes" in out


def test_cli_owner_enforced_mode_blocked_empty_approvers(db, monkeypatch,
                                                         capsys):
    """Chế độ thực + approvers khối sales rỗng (Bên B chưa ủy quyền) → chặn,
    ghi `authz_denied` (deny_log) — không gán."""
    lid = _lead(db, _t(12, 9))
    monkeypatch.setattr(crm, "_connect", lambda: _TxConn(db))
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    denied = []
    monkeypatch.setattr(auth, "deny_log",
                        lambda conn, by, block, action, ot, oid, why, **k:
                        denied.append((block, action, ot, oid)))
    assert crm.main(["--owner", str(lid), "--staff", "NV01", "--by",
                     "Lan"]) == 1
    assert denied == [("sales", "assign", "crm", lid)]
    assert "ủy quyền" in capsys.readouterr().out
    assert _one(db, "select owner_code from leads where id = %s",
                (lid,)) is None


CFG = sd.load_sales_config()


def _lead_items(db, now):
    with _role(db, AW):
        return [i for i in sd.collect(_TxConn(db), now, CFG, Path("/nonexist"))
                if i["object_type"] == "lead_followup"]


def test_lead_followup_unassigned_and_assigned_overdue(db):
    """Probe sales-04.1: lead mới không ai phụ trách quá 4 giờ làm việc /
    đã gán mà quá hạn xử lý → mục hàng duyệt (code cũ: chỉ nhắc bản tin)."""
    a = _lead(db, _t(12, 9))                  # hạn gán T2 13:00
    b = _lead(db, _t(12, 9))
    young = _lead(db, _t(12, 11))             # hạn gán T2 15:00
    done = _lead(db, _t(12, 9), status="contacted")
    old = _lead(db, _t(12, 9) - timedelta(days=30))     # ngoài lookback 14
    crm.assign_owner(_TxConn(db), b, "NV07", "Lan", now=_t(12, 10))
    # b: hạn 8 giờ làm việc từ T2 10:00 → T2 18:00.
    got = {i["object_id"]: i for i in _lead_items(db, _t(12, 14))}
    assert set(got) == {f"lead:{a}:chua_gan"}
    got = {i["object_id"]: i for i in _lead_items(db, _t(13, 9))}
    kb = f"lead:{b}:20261012T030000000000Z"
    assert set(got) == {f"lead:{a}:chua_gan", f"lead:{young}:chua_gan", kb}
    assert all(f":{x}:" not in " ".join(got) for x in (done, old))
    pb = got[kb]["payload"]
    assert "NV07" in pb and "13/10" not in pb and "12/10/2026 18:00" in pb
    for it in got.values():
        assert guardrail.check(it["payload"])["ok"] is True
        for s in (*PII, "giá hộp", "uh-p4"):
            assert s not in it["payload"] and s not in it["title"], s


def test_lead_followup_enqueue_idempotent_reassign_new_wave(db):
    lid = _lead(db, _t(12, 9))
    now = _t(13, 9)
    with _role(db, AW):
        n = sd.enqueue_new(_TxConn(db), sd.collect(_TxConn(db), now, CFG,
                                                   Path("/x")), CFG)
    assert n == 1
    assert _lead_items(db, now) == []                     # chạy lại → 0
    rows = _queue(db, "lead_followup")
    assert rows[0][1] == f"lead:{lid}:chua_gan" and rows[0][4] == "pending"
    assert rows[0][5] == "agent:sales_director"
    crm.assign_owner(_TxConn(db), lid, "NV01", "Lan", now=_t(13, 9))
    assert _lead_items(db, _t(13, 16)) == []              # chưa quá hạn mới
    nxt = _lead_items(db, _t(14, 9))                      # hạn T3 17:00
    assert [i["object_id"] for i in nxt] == [
        f"lead:{lid}:20261013T020000000000Z"]
    db.execute("update leads set status = 'contacted' where id = %s", (lid,))
    assert _lead_items(db, _t(14, 9)) == []               # đã xử lý


def test_lead_followup_cap_per_run(db, monkeypatch):
    for _ in range(5):
        _lead(db, _t(12, 8))
    cfg = dict(CFG, lead_owner=dict(CFG["lead_owner"], max_per_run=2))
    with _role(db, AW):
        assert len(sd.lead_items(_TxConn(db), _t(13, 9), cfg)) == 2


def test_lead_followup_overdue_escalates_like_other_sales_items(db):
    """Mục lead_followup đi đúng khuôn SLA khối sales: lớp B quá 4 giờ làm
    việc → `sla_escalations` (leo thang TGĐ)."""
    _lead(db, _t(12, 8))
    with _role(db, AW):
        sd.enqueue_new(_TxConn(db), _lead_items(db, _t(12, 13)), CFG)
    created = _one(db, "select created_at from approval_queue")
    # created_at = giờ DB thật → quét sau 6 ngày (luôn ≥ 4 giờ làm việc).
    with _role(db, AW):
        res = sd.sweep(_TxConn(db), created + timedelta(days=6), CFG)
    assert res["escalated"] == 1
    assert db.execute("select handoff_class, escalate_to_role from"
                      " sla_escalations").fetchall() == [("B", "tgd")]


# ---------------------------------------------------- sales-05

QNO = "BG-20261012-7-abcdef12"


def _approved_quote(db, qno=QNO):
    tx = _TxConn(db)
    qid = director.submit(tx, "sales", "b2b_quote", qno, f"Báo giá {qno}",
                          f"# Báo giá {qno}\n\nTổng 1.000.000đ.\n",
                          "agent:kd_quote")
    with _role(db, AH):
        ok, msg = aq.decide(tx, qid, "Lan", "approved")
    assert ok, msg
    return qid


def _fu(db, now, fu=None):
    fu = fu or sales_watch.section("quote_followup")
    with _role(db, AW):
        return kd_quote.followup_items(_TxConn(db), now, fu, SHIFT)


def _decided_at(db, qid):
    return _one(db, "select decided_at from approval_queue where id = %s",
                (qid,))


def test_followup_after_business_hours_then_rounds(db):
    """Probe sales-05: báo giá đã duyệt chưa có kết quả sau N giờ làm việc →
    NHÁP nhắc (code cũ: không có nhắc chốt đơn)."""
    qid = _approved_quote(db)
    base = _decided_at(db, qid)
    due = period.business_deadline(base, 24, SHIFT)
    assert _fu(db, due - timedelta(minutes=1)) == []
    items = _fu(db, due)
    assert len(items) == 1
    it = items[0]
    key = f"fu:{qid}:{kd_quote._utc(base)}"
    assert it["object_id"] == f"{key}:1" and QNO in it["payload"]
    assert "CHƯA xác nhận gửi" in it["payload"]
    assert guardrail.check(it["payload"])["ok"] is True
    tx = _TxConn(db)
    with _role(db, AW):
        director.submit(tx, "sales", "b2b_followup", it["object_id"],
                        it["title"], it["payload"], "agent:kd_quote")
    assert _fu(db, due + timedelta(days=30)) == []        # đang pending
    rid = _queue(db, "b2b_followup")[0][0]
    with _role(db, AH):
        assert aq.decide(tx, rid, "Lan", "approved")[0]
    dec = _decided_at(db, rid)
    nxt = _fu(db, period.business_deadline(dec, 24, SHIFT))
    assert [i["object_id"] for i in nxt] == [f"{key}:2"]
    director.submit(tx, "sales", "b2b_followup", nxt[0]["object_id"],
                    nxt[0]["title"], nxt[0]["payload"], "agent:kd_quote")
    rid2 = _queue(db, "b2b_followup")[1][0]
    with _role(db, AH):
        assert aq.decide(tx, rid2, "Lan", "rejected")[0]
    assert _fu(db, due + timedelta(days=60)) == []        # max_reminders 2


def test_followup_sent_resets_base_outcome_stops(db):
    qid = _approved_quote(db)
    base = _decided_at(db, qid)
    sent = base + timedelta(days=3)
    db.execute("insert into b2b_quote_events (queue_id, quote_no, kind,"
               " created_at) values (%s, %s, 'da_gui', %s)", (qid, QNO, sent))
    due = period.business_deadline(sent, 24, SHIFT)
    assert _fu(db, due - timedelta(minutes=1)) == []
    it = _fu(db, due)[0]
    assert it["object_id"] == f"fu:{qid}:{kd_quote._utc(sent)}:1"
    assert "đã gửi lúc" in it["payload"]
    with _role(db, AH):
        kd_quote.record_event(_TxConn(db), qid, "khong_chot", "Lan")
        with pytest.raises(ValueError, match="đã ghi kết quả"):
            kd_quote.record_event(_TxConn(db), qid, "chot", "Mai")
    assert _fu(db, due + timedelta(days=10)) == []
    with pytest.raises(psycopg.errors.RaiseException), db.transaction():
        db.execute("delete from b2b_quote_events")


def test_record_event_rules(db):
    tx = _TxConn(db)
    pend = director.submit(tx, "sales", "b2b_quote", "BG-20261012-8-abcdef12",
                           "t", "# Báo giá\n", "agent:kd_quote")
    with pytest.raises(ValueError, match="ĐÃ duyệt"):
        kd_quote.record_event(tx, pend, "chot", "Lan")
    qid = _approved_quote(db)
    for by in (None, " ", "agent:kd_quote", "System:x"):
        with pytest.raises(ValueError, match="NGƯỜI"):
            kd_quote.record_event(tx, qid, "chot", by)
    with pytest.raises(ValueError, match="kết quả phải"):
        kd_quote.record_event(tx, qid, "thang", "Lan")
    assert kd_quote.record_event(tx, qid, "da_gui") > 0     # mốc gửi: không cần tên


def test_cli_verify_send_records_sent_and_outcome(db, monkeypatch, tmp_path,
                                                  capsys):
    qid = _approved_quote(db)
    payload = _one(db, "select payload from approval_queue where id = %s",
                   (qid,))
    f = tmp_path / "bg.md"
    f.write_bytes(payload.encode("utf-8"))
    monkeypatch.setattr(kd_quote, "connect", lambda: _TxConn(db))
    assert kd_quote.main(["--verify-send", str(qid), str(f), "--by",
                          "Lan"]) == 0
    assert db.execute("select kind, recorded_by from b2b_quote_events"
                      ).fetchall() == [("da_gui", "Lan")]
    f.write_bytes(b"khac")
    assert kd_quote.main(["--verify-send", str(qid), str(f)]) == 1
    assert _one(db, "select count(*) from b2b_quote_events") == 1
    assert kd_quote.main(["--outcome", str(qid), "chot", "--by", "Lan"]) == 0
    assert kd_quote.main(["--outcome", str(qid), "huy", "--by", "Lan"]) == 1
    out = capsys.readouterr()
    assert "đã chốt" in out.out and "không ghi đè" in out.err


def test_run_followups_enqueue_and_rollout_off(db, monkeypatch):
    qid = _approved_quote(db)
    now = period.business_deadline(_decided_at(db, qid), 24, SHIFT)
    with _role(db, JOB):
        r = kd_quote.run_followups(_TxConn(db), now, dry_run=True)
        assert r == {"found": 1, "enqueued": 0}
        assert _queue(db, "b2b_followup") == []
        assert kd_quote.run_followups(_TxConn(db), now)["enqueued"] == 1
        assert kd_quote.run_followups(_TxConn(db), now)["enqueued"] == 0
    row = _queue(db, "b2b_followup")[0]
    assert row[5] == "agent:kd_quote" and row[4] == "pending"
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        kd_quote.run_followups(_TxConn(db), now + timedelta(days=30))
    assert len(_queue(db, "b2b_followup")) == 1


# ---------------------------------------------------- sales-06.1

def _golden(db):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('sam-a', 'Sâm A', 'food', 'manual'),"
               " ('sam-b', 'Sâm B', 'food', 'manual'),"
               " ('ruou-x', 'Rượu X', 'alcohol', 'manual'),"
               " ('sam-c', 'Sâm C', 'food', 'manual')")
    db.execute("insert into dealers (code, name, region, source) values"
               " ('DL-01', 'Đại lý 1', 'MIEN_TRUNG', 'manual'),"
               " ('DL-02', 'Đại lý 2', 'MIEN_TRUNG', 'manual')")
    # Giá đã duyệt: golden_store nạp dòng mở chưa duyệt rồi người duyệt —
    # fixture bỏ qua trigger append-only (replica) để dựng thẳng trạng thái.
    db.execute("set local session_replication_role = replica")
    for sku, ch, price, by in (("sam-a", "shopee", 1_000_000, "Lan"),
                               ("sam-a", "web", 800_000, None),
                               ("sam-b", "shopee", 500_000, "Lan"),
                               ("sam-b", "web", 450_000, "Lan"),
                               ("ruou-x", "web", 300_000, "Lan")):
        db.execute("insert into price_list (sku_key, channel, kind,"
                   " price_vnd, valid_from, approved_by) values (%s, %s,"
                   " 'floor', %s, '2026-01-01', %s)", (sku, ch, price, by))
    db.execute("set local session_replication_role = origin")


OBS = ("shopee,DL-01,sam-a,950000,2026-10-13,https://shopee.vn/dl1/a\n"
       "shopee,DL-01,sam-b,520000,2026-10-13,https://shopee.vn/dl1/b\n"
       "cua_hang,DL-02,sam-b,440000,2026-10-12,https://dl2.example.vn/b\n"
       "web,DL-02,ruou-x,250000,2026-10-12,https://dl2.example.vn/r\n"
       "tiktok,DL-02,sam-a,10,2026-10-12,https://tiktok.com/x\n"
       "shopee,DL-02,sam-c,1,2026-10-12,https://shopee.vn/c\n")


def _load(db, tmp_path, body=OBS, name="obs.csv", source="manual_export"):
    rows, errs, sha = _read(_csv(tmp_path, body, name))
    assert errs == []
    with _role(db, LOADER):
        return dealer_price.load_dealer_obs(_TxConn(db), rows, sha, "Lan", source)


def test_dealer_load_whole_file_check_idempotent_append_only(db, tmp_path):
    _golden(db)
    bad = OBS + "shopee,DL-99,sam-a,1,2026-10-12,https://a.vn/z\n"
    rows, errs, sha = _read(_csv(tmp_path, bad, "bad.csv"))
    assert errs == [] and len(rows) == 7        # file đúng mẫu, sai sổ
    with _role(db, LOADER), pytest.raises(ValueError, match="dòng 8"):
        dealer_price.load_dealer_obs(_TxConn(db), rows, sha, "Lan")
    assert _one(db, "select count(*) from dealer_price_obs") == 0
    assert _load(db, tmp_path) == {"inserted": 6, "skipped_file": False}
    assert _load(db, tmp_path) == {"inserted": 0, "skipped_file": True}
    with pytest.raises(ValueError, match="NGƯỜI"):
        dealer_price.load_dealer_obs(_TxConn(db), rows, "0" * 64, "agent:x")
    with pytest.raises(psycopg.errors.RaiseException), db.transaction():
        db.execute("update dealer_price_obs set price_vnd = 1")
    with pytest.raises(psycopg.errors.RaiseException), db.transaction():
        db.execute("delete from dealer_price_obs")


def test_dealer_findings_floor_rules(db, tmp_path):
    """Probe sales-06.1: đại lý bán dưới giá sàn golden (kênh cùng tên → floor
    cùng kênh; cửa hàng → floor thấp nhất) → phát hiện (code cũ: chỉ so
    listing sàn của Sâm Sâm, không có giá đại lý)."""
    _golden(db)
    _load(db, tmp_path)
    _load(db, tmp_path, "shopee,DL-02,sam-a,1,2026-10-12,https://s.vn/m\n",
          "mau.csv", "sample")
    dp = sales_watch.section("dealer_price")
    with _role(db, JOB):
        r = kd_price.dealer_findings(_TxConn(db), TODAY, dp)
    got = {f["object_id"]: f for f in r["findings"]}
    assert set(got) == {"dp:DL-01:sam-a:shopee:2026-10-13",
                        "dp:DL-02:sam-b:cua_hang:2026-10-12",
                        "dp:DL-02:ruou-x:web:2026-10-12"}
    assert got["dp:DL-02:sam-b:cua_hang:2026-10-12"]["floor"] == 450_000
    # tiktok sam-a: không có floor tiktok → không kiểm được; sam-c: không floor
    assert r["unverifiable"] == 2 and r["checked"] == 6     # mẫu bị loại
    cfg = director.load_config("sales")
    it = kd_price.dealer_item(got["dp:DL-02:ruou-x:web:2026-10-12"], cfg)
    assert "ruou" not in it["payload"] and "nhóm hạn chế" in it["payload"]
    it = kd_price.dealer_item(got["dp:DL-01:sam-a:shopee:2026-10-13"], cfg)
    assert "950.000" in it["payload"] and "shopee.vn" in it["payload"]
    assert "/dl1/" not in it["payload"] and "Đại lý 1" not in it["payload"]
    assert guardrail.check(it["payload"])["ok"] is True
    late = date(2026, 12, 1)                                 # ngoài lookback
    with _role(db, JOB):
        assert kd_price.dealer_findings(_TxConn(db), late, dp)["checked"] == 0


def test_dealer_watch_enqueue_idempotent_and_rollout_off(db, tmp_path,
                                                         monkeypatch):
    _golden(db)
    _load(db, tmp_path)
    cfg = director.load_config("sales")
    dp = sales_watch.section("dealer_price")
    with _role(db, JOB):
        r = kd_price.dealer_watch(_TxConn(db), TODAY, cfg, dp, dry_run=True)
        assert r["new"] == 3 and r["enqueued"] == 0
        assert kd_price.dealer_watch(_TxConn(db), TODAY, cfg,
                                     dp)["enqueued"] == 3
        assert kd_price.dealer_watch(_TxConn(db), TODAY, cfg,
                                     dp)["enqueued"] == 0
    rows = _queue(db, "dealer_price_alert")
    assert {r[5] for r in rows} == {"agent:kd_price"}
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        kd_price.dealer_watch(_TxConn(db), TODAY, cfg, dp)


def test_cli_dealer_file_and_watch(db, tmp_path, monkeypatch, capsys):
    _golden(db)
    monkeypatch.setattr(kd_price, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(dealer_price, "connect", lambda: _TxConn(db))
    p = _csv(tmp_path, OBS)
    assert dealer_price.main(["--file", str(p), "--by", "Lan"]) == 0
    assert dealer_price.main(["--file", str(p), "--by", "Lan"]) == 0
    assert kd_price.main(["--dealer-watch", "--dry-run", "--as-of",
                          "2026-10-14"]) == 0
    out = capsys.readouterr().out
    assert "[ok] nạp 6" in out and "[skip]" in out
    assert "dưới giá sàn 3" in out and "KHÔNG ghi DB" in out
    bad = _csv(tmp_path, OBS.replace("950000", "x"), "b.csv")
    assert dealer_price.main(["--file", str(bad), "--by", "Lan"]) == 1


# ---------------------------------------------------- sales-06.2

def _order(db, ch, ts, status, source=None):
    db.execute("insert into orders (id, ts, channel, qty, total_vnd, status,"
               " source) values (%s, %s, %s, 1, 100000, %s, %s)",
               (f"{ch}:{uuid.uuid4().hex[:16]}", ts, ch, status,
                source or f"market:{ch}"))


def _week(db, monday, n, cancel=0, ret=0, ch="shopee", source=None):
    ts = datetime(monday.year, monday.month, monday.day, 10, tzinfo=VN)
    for i in range(n):
        st = ("cancelled" if i < cancel else
              "Đã hoàn tiền" if i < cancel + ret else "Đã giao")
        _order(db, ch, ts + timedelta(hours=i % 50), st, source)


def _ow():
    return sales_watch.section("order_watch")


def test_watch_counts_and_enqueue_waves(db, monkeypatch):
    """Probe sales-06.2: tuần đã đóng hủy 4/20 = 20% > 15% → mục hàng duyệt
    (code cũ: chỉ đếm đơn hủy ở báo cáo stdout). Đợt: pending nuốt; đã
    quyết → chỉ mục mới khi số đơn hủy TĂNG."""
    _week(db, _wk(1), 20, cancel=4)
    for i in range(2, 6):
        _week(db, _wk(i), 20, cancel=1)
    _week(db, _wk(1), 30, cancel=30, source="sample")      # MẪU bị loại
    _week(db, W, 20, cancel=20)                            # tuần chưa đóng
    cfg = director.load_config("sales")
    with _role(db, JOB):
        r = kd_orders.watch(_TxConn(db), TODAY, _ow(), cfg)
    assert r["enqueued"] == 1
    rows = _queue(db, "order_anomaly")
    assert rows[0][1] == f"ow:shopee:cancel:{_wk(1)}:4"
    assert rows[0][5] == "agent:kd_orders"
    p = rows[0][3]
    assert "20 đơn, hủy 4 (20.0%)" in p and "chưa đo" in p.lower()
    assert guardrail.check(p)["ok"] is True
    _order(db, "shopee", datetime.combine(_wk(1), datetime.min.time(),
                                          VN) + timedelta(hours=9),
           "cancelled")
    with _role(db, JOB):
        assert kd_orders.watch(_TxConn(db), TODAY, _ow(), cfg)["new"] == 0
    with _role(db, AH):
        assert aq.decide(_TxConn(db), rows[0][0], "Lan", "rejected")[0]
    with _role(db, JOB):
        r = kd_orders.watch(_TxConn(db), TODAY, _ow(), cfg)
    assert r["enqueued"] == 1
    assert _queue(db, "order_anomaly")[1][1] == f"ow:shopee:cancel:{_wk(1)}:5"
    with _role(db, JOB):
        assert kd_orders.watch(_TxConn(db), TODAY, _ow(), cfg)["new"] == 0
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        kd_orders.watch(_TxConn(db), TODAY, _ow(), cfg)


def test_watch_return_status_and_cli_dry_run(db, monkeypatch, capsys):
    _week(db, _wk(1), 20, ret=3)                           # 15% > 10%
    monkeypatch.setattr(kd_orders, "connect", lambda: _TxConn(db))
    assert kd_orders.main(["--watch", "--dry-run", "--as-of",
                           "2026-10-14"]) == 0
    out = capsys.readouterr().out
    assert "hoàn/trả 3/20 (15.0%)" in out and "KHÔNG ghi DB" in out
    assert "CHƯA ĐO" in out
    assert _queue(db, "order_anomaly") == []
