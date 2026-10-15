"""v5.3 W53.1/W53.4/W53.5/W53.6 — KD-A5 `agents/kd_price.py` (giám sát giá +
khuyến mãi). Phần thuần (cấu hình, luật giá đang chạy, đọc CSV kế hoạch KM,
luật KM, payload) không DB. Phần DB dùng lại `kd_db`/`seed`/`TxConn` của
`tests/test_kd_listing.py` (schema tạm + ROLLBACK). Kế hoạch KM chỉ là CSV
MẪU `tests/fixtures/kd_price/promo_plan_MAU.csv`. Không assert wall-clock;
`today` luôn là tham số (CLI truyền str qua --as-of).
"""

import inspect
import json
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from agents import kd_listing as kl
from agents import kd_price as kp
from pipelines import director, guardrail, mkt_calendar, scenario
from tests.test_kd_listing import (
    CFG,
    MAPPING,
    RUOU_TITLE,
    FakeRun,
    TxConn,
    kd_db,
    one,
    seed,
)

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "kd_price"
PLAN = FIX / "promo_plan_MAU.csv"
TODAY = date(2026, 10, 12)
WATCH, _ = kp.load_watch()
NET = {"shopee": Decimal("0.85"), "tiktok": Decimal("0.85")}
CAL = mkt_calendar.load_calendar()
COMPETITOR = 77777                       # giá đối thủ thấp (< 50% list)
COMP_STR = ("77.777", "77777")


# ---------------------------------------------------------------- W53.1 cấu hình

def test_config_ship_valid_and_assumed():
    raw = json.loads((ROOT / "data" / "price_watch.json").read_bytes())
    assert raw["confirmed_by"] is None and "GIẢ ĐỊNH" in raw["_doc"]
    assert kp.validate_watch(raw) is None
    assert all(v <= 49 for v in raw["max_discount_pct"].values())
    assert set(raw["channels"]) <= {"shopee", "tiktok"}
    cfg = director.load_config("sales")
    for t in ("listing_sync", "promo_change", "price_change"):
        s = cfg["object_types"][t]
        assert (s["risk"], s["handoff"], s["sla_hours"]) == ("high", "B", 96)
    assert "listing_sync" in cfg["_doc"] and "promo_change" in cfg["_doc"]


def _cfg(**over):
    d = json.loads((ROOT / "data" / "price_watch.json").read_bytes())
    for k, v in over.items():
        if v is KeyError:
            d.pop(k)
        else:
            d[k] = v
    return d


@pytest.mark.parametrize("name, content", [
    ("missing", None),
    ("rong", b""),
    ("trang", b"  \n"),
    ("json_hong", b"{broken"),
    ("rong_obj", b"{}"),
    ("chi_doc", json.dumps({"_doc": "x"}).encode()),
    ("cap_50", json.dumps(_cfg(max_discount_pct={"shopee": 50,
                                                 "tiktok": 40})).encode()),
    ("bool_so", json.dumps(_cfg(list_deviation_pct=True)).encode()),
    ("kenh_la", json.dumps(_cfg(channels=["shopee", "lazada"])).encode()),
    ("lech_0", json.dumps(_cfg(list_deviation_pct=0)).encode()),
    ("key_la", json.dumps(_cfg(extra=1)).encode()),
    ("thieu_kenh_cap", json.dumps(_cfg(max_discount_pct={"shopee": 40}
                                       )).encode()),
    ("lookahead_0", json.dumps(_cfg(lookahead_days=0)).encode()),
    ("loai_km_la", json.dumps(_cfg(promo_kinds=["mua1tang1"])).encode()),
    ("thieu_status", json.dumps(_cfg(status=KeyError)).encode()),
    ("list", b"[]"),
])
def test_config_broken_variants_rejected(tmp_path, name, content):
    p = tmp_path / "price_watch.json"
    if content is not None:
        p.write_bytes(content)
    w, why = kp.load_watch(p)
    assert w is None and why, name


def test_config_broken_cli_exit1_before_connect(tmp_path, monkeypatch,
                                                 cli_price):
    (tmp_path / "w.json").write_bytes(b"{}")
    monkeypatch.setattr(kp, "WATCH_FILE", tmp_path / "w.json")
    assert kp.main(["--run", "--dry-run"]) == 1
    assert cli_price["connect"] == 0


def test_config_net_ratio_from_fpa():
    net, why = kp.load_net_ratio(["shopee", "tiktok"])
    assert why is None and net == NET
    bad = Path(__file__).parent / "fixtures" / "kd_price" / "README.md"
    assert kp.load_net_ratio(["shopee"], bad)[0] is None


# ---------------------------------------------------------------- W53.4 thuần

def _gp(list_=200000, floor=150000, floor_ok=True, list_ok=True):
    out = {}
    if list_ is not None:
        out["list"] = {"price": list_, "id": 1, "approved": list_ok}
    if floor is not None:
        out["floor"] = {"price": floor, "id": 2, "approved": floor_ok}
    return {("sam-a", "shopee"): out}


def _row(price, sale=None):
    return [{"channel": "shopee", "item_id": "1001", "seller_sku": None,
             "sku_key": "sam-a", "price_vnd": price, "sale_price": sale}]


RD = {("sam-a", "shopee"): "QC_DAY_DU"}


def _cogs(cost, approved=True):
    return [{"id": 1, "sku_key": "sam-a", "cost_vnd": cost,
             "valid_from": date(2026, 1, 1),
             "approved_by": "GĐ tài chính (test)" if approved else None}]


def _kinds(fs):
    return sorted(f["kind"] for f in fs if f["severity"] != "INFO")


def test_below_floor_s1_even_unapproved_floor():
    fs = kp.check_listing_prices(_row(200000, 149999), _gp(floor_ok=False),
                                 [], NET, WATCH, TODAY, RD)
    [f] = [f for f in fs if f["kind"] == "below_floor"]
    assert f["severity"] == "S1" and f["evidence"]["floor_approved"] is False
    assert kp.object_type(f) == "market_alert_s1"
    assert _kinds(kp.check_listing_prices(_row(200000, 150000), _gp(), [],
                                          NET, WATCH, TODAY, RD)) == []


def test_negative_margin_s1_and_unapproved_cogs_not_inferred():
    fs = kp.check_listing_prices(_row(200000), _gp(), _cogs(170001), NET,
                                 WATCH, TODAY, RD)
    assert _kinds(fs) == ["negative_margin"]       # 200000×0.85 = 170000
    assert _kinds(kp.check_listing_prices(_row(200000), _gp(), _cogs(170000),
                                          NET, WATCH, TODAY, RD)) == []
    fs = kp.check_listing_prices(_row(200000), _gp(), _cogs(999999, False),
                                 NET, WATCH, TODAY, RD)
    assert _kinds(fs) == []
    assert [(f["kind"], f["note"]) for f in fs] == [
        ("no_cogs", "chưa có giá vốn duyệt")]
    # giá vốn hiệu lực SAU ngày kiểm → chưa áp
    later = _cogs(999999)
    later[0]["valid_from"] = date(2026, 12, 1)
    assert _kinds(kp.check_listing_prices(_row(200000), _gp(), later, NET,
                                          WATCH, TODAY, RD)) == []


def test_list_deviation_threshold_integer_boundary():
    # ngưỡng 5% của 200000 = 10000 đ: đúng ngưỡng → KHÔNG; +1đ → S2.
    assert WATCH["list_deviation_pct"] == 5
    assert _kinds(kp.check_listing_prices(_row(210000), _gp(), [], NET,
                                          WATCH, TODAY, RD)) == []
    assert _kinds(kp.check_listing_prices(_row(190000, 190000), _gp(), [],
                                          NET, WATCH, TODAY, RD)) == []
    fs = kp.check_listing_prices(_row(210001), _gp(), [], NET, WATCH, TODAY,
                                 RD)
    assert _kinds(fs) == ["list_deviation"]
    assert kp.object_type(fs[0]) == "price_change"
    assert _kinds(kp.check_listing_prices(_row(189999), _gp(), [], NET,
                                          WATCH, TODAY, RD)) == [
        "list_deviation"]


def test_sale_price_deeper_than_cap_s2():
    # trần 40% của 200000 → giá thực tối thiểu 120000.
    gp = _gp(floor=100000)
    assert _kinds(kp.check_listing_prices(_row(200000, 120000), gp, [], NET,
                                          WATCH, TODAY, RD)) == []
    fs = kp.check_listing_prices(_row(200000, 119999), gp, [], NET, WATCH,
                                 TODAY, RD)
    assert _kinds(fs) == ["listing_promo_over_cap"]
    assert kp.object_type(fs[0]) == "price_change"


def test_cam_and_unmapped_not_price_checked():
    rows = _row(200000, 1) + [dict(_row(1)[0], sku_key=None)]
    assert kp.check_listing_prices(rows, _gp(), [], NET, WATCH, TODAY,
                                   {("sam-a", "shopee"): "CAM"}) == []
    assert kp.check_listing_prices(rows, _gp(), [], NET, WATCH, TODAY,
                                   {}) == []


def test_competitor_price_is_never_a_rule_input():
    """Luật không có tham số đối thủ — giá đối thủ không thể sinh đề xuất."""
    for fn in (kp.check_listing_prices, kp.check_promos):
        params = " ".join(inspect.signature(fn).parameters)
        assert "competitor" not in params and "doi_thu" not in params


def test_payloads_guardrail_ok_and_proposal_numbers_from_golden():
    fs = kp.check_listing_prices(_row(230000, 110000), _gp(), _cogs(150000),
                                 NET, WATCH, TODAY, RD)
    assert _kinds(fs) == ["below_floor", "list_deviation",
                          "listing_promo_over_cap", "negative_margin"]
    items = kp.to_items(fs, CFG)
    for it in items:
        assert guardrail.check(it["payload"])["ok"] is True, it["payload"]
        assert "KHÔNG tự đổi giá" in it["payload"]
        assert it["object_id"].startswith("a5:")
    p = {f["kind"]: kp.payload_of(f)[1] for f in fs}
    assert "đưa giá bán về ≥ giá sàn 150.000 đ" in p["below_floor"]
    assert "đưa về giá niêm yết 200.000 đ" in p["list_deviation"]


# ---------------------------------------------------------------- W53.5 kế hoạch KM

def test_read_plan_mau_and_tet_from_scenario():
    rows, errs = kp.read_plan(PLAN, WATCH["promo_kinds"], CAL)
    assert errs == [] and len(rows) == 8
    first = (PLAN.read_text(encoding="utf-8").splitlines()[1])
    assert first.startswith("KM1111-A,")
    tet = [r for r in rows if r["event"] == "tet_2027"]
    assert tet and tet[0]["event_date"] == scenario.tet_date(2027)
    assert tet[0]["price"] == 180000 and tet[0]["pct"] is None
    assert "MẪU dev — không phải kế hoạch thật" in (
        FIX / "README.md").read_text(encoding="utf-8").splitlines()[0]


HDR = ("program_id,kenh,sku_key,loai_km,ngay_bat_dau,ngay_ket_thuc,giam_pct,"
       "gia_km_vnd,su_kien")
OK = "P1,shopee,sam-a,voucher,2026-11-11,2026-11-11,10,,11.11"
SECRET = "XQZ_BI_MAT"


@pytest.mark.parametrize("name, data", [
    ("thieu_cot", (b"program_id,kenh,loai_km,ngay_bat_dau,ngay_ket_thuc,"
                   b"giam_pct\nP1,shopee,voucher,2026-11-11,2026-11-11,10\n")
),
    ("cot_la", (HDR + f",{SECRET}\n" + OK + ",x\n").encode()),
    ("header_trung", (HDR + ",kenh\n" + OK + ",shopee\n").encode()),
    ("rong", b""),
    ("chi_header", (HDR + "\n").encode()),
    ("ngay_sai", (HDR + "\nP1,shopee,sam-a,voucher,2026-13-01,2026-11-11,"
                  "10,,\n").encode()),
    ("ket_thuc_truoc", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-12,"
                        "2026-11-11,10,,\n").encode()),
    ("ca_hai_gia", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-11,2026-11-11,"
                    "10,100000,\n").encode()),
    ("pct_0", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-11,2026-11-11,0,,\n"
               ).encode()),
    ("kenh_la", (HDR + f"\nP1,{SECRET},sam-a,voucher,2026-11-11,2026-11-11,"
                 "10,,\n").encode()),
    ("su_kien_la", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-11,2026-11-11,"
                    f"10,,{SECRET}\n").encode()),
    ("loai_la", (HDR + f"\nP1,shopee,sam-a,{SECRET},2026-11-11,2026-11-11,"
                 "10,,\n").encode()),
    ("thua_o", (HDR + "\n" + OK + f",{SECRET}\n").encode()),
    ("khong_utf8", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-11,2026-11-11,"
                    "10,,\n").encode() + b"\xff\xfe"),
    ("gia_km_le", (HDR + "\nP1,shopee,sam-a,voucher,2026-11-11,2026-11-11,"
                   ",12.5,\n").encode()),
])
def test_bad_plan_csv_exit1_no_connect_no_cell_value(tmp_path, capsys,
                                                     cli_price, name, data):
    p = tmp_path / f"{name}.csv"
    p.write_bytes(data)
    rows, errs = kp.read_plan(p, WATCH["promo_kinds"], CAL)
    assert rows == [] and errs, name
    assert kp.main(["--report", "--plan", str(p), "--as-of",
                    "2026-10-12"]) == 1
    out = capsys.readouterr()
    assert cli_price["connect"] == 0
    for s in (SECRET, "2026-13-01", "12.5"):
        assert s not in out.out + out.err, (name, s)
    assert "không connect" in out.err


def test_plan_over_max_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(kp, "PLAN_MAX_ROWS", 2)
    p = tmp_path / "big.csv"
    p.write_bytes(("\n".join([HDR] + [OK] * 3) + "\n").encode())
    rows, errs = kp.read_plan(p, WATCH["promo_kinds"], CAL)
    assert rows == [] and errs == ["file > 2 dòng — tách file"]


# Golden/readiness/khuyến mãi của schema test (khớp tests/test_kd_listing).
GP = {("sam-a", "shopee"): {"list": {"price": 200000, "id": 1,
                                     "approved": True},
                            "floor": {"price": 150000, "id": 2,
                                      "approved": True}},
      ("sam-b", "shopee"): {"list": {"price": 100000, "id": 3,
                                     "approved": True},
                            "floor": {"price": 80000, "id": 4,
                                      "approved": True}},
      ("sam-g", "shopee"): {"list": {"price": 200000, "id": 5,
                                     "approved": True},
                            "floor": {"price": 100000, "id": 6,
                                      "approved": True}}}
RDP = {("sam-a", "shopee"): "QC_DAY_DU", ("sam-a", "tiktok"): "QC_DAY_DU",
       ("sam-b", "shopee"): "TP_THUONG", ("sam-c", "shopee"): "MO_TA",
       ("sam-g", "shopee"): "TP_THUONG", ("ruou-x", "shopee"): "CAM"}
PROM = {("sam-a", "shopee"), ("sam-a", "tiktok"), ("sam-b", "shopee"),
        ("sam-g", "shopee")}
COGS = [{"id": 1, "sku_key": "sam-b", "cost_vnd": 90000,
         "valid_from": date(2026, 1, 1), "approved_by": "GĐ (test)"}]


def _promo(today):
    rows, errs = kp.read_plan(PLAN, WATCH["promo_kinds"], CAL)
    assert errs == []
    return kp.check_promos(rows, GP, RDP, PROM, COGS, NET, WATCH, today)


def _by(fs):
    return sorted((f["kind"], tuple(f["program_ids"])) for f in fs)


def test_check_promos_mau_as_of_2026_10_12():
    fs = _promo(TODAY)
    assert _by(fs) == sorted([
        ("promo_banned", ("KM1111-D",)),            # rượu
        ("promo_banned", ("KM1111-E",)),            # TPBVSK chưa XNQC
        ("promo_below_floor", ("KM1111-A",)),       # 30% → 140000 < 150000
        ("promo_below_floor", ("KM1111-A", "KM1111-B")),
        ("promo_stacked", ("KM1111-A", "KM1111-B")),
        ("promo_over_cap", ("KM1111-A", "KM1111-B")),   # tổng 40,5% > 40
        ("promo_over_cap", ("KM1111-C",)),          # 45% > 40
        ("promo_below_floor", ("KM1111-C",)),
        ("promo_negative_margin", ("KM1111-C",))])  # 55000×0.85 − 90000
    # KM-OLD đã kết thúc; KM1212-A/KMTET-A ngoài 45 ngày → bỏ qua.
    assert not [f for f in fs if set(f["program_ids"]) & {
        "KM-OLD", "KM1212-A", "KMTET-A"}]
    items = kp.to_items(fs, CFG)
    banned = [it for it in items if "KM1111-D" in it["object_id"]
              or "KM1111-E" in it["object_id"]]
    assert len(banned) == 2 and {it["object_type"] for it in banned} == {
        "market_alert_s1"}                         # 0 promo/price_change
    for it in items:
        assert guardrail.check(it["payload"])["ok"] is True, it["payload"]
        assert "ruou" not in it["payload"] and "rượu" not in it["payload"]
    assert {kp.object_type(f) for f in fs} == {"market_alert_s1",
                                               "promo_change"}


def test_check_promos_labels_shift_with_as_of_str():
    a = {(f["kind"], tuple(f["program_ids"])): f["label"]
         for f in kp.check_promos(*_promo_args("2026-10-12"))}
    assert a[("promo_below_floor", ("KM1111-A",))] == "dự kiến T-29"
    assert a[("promo_stacked", ("KM1111-A", "KM1111-B"))] == "dự kiến T-30"
    b = {(f["kind"], tuple(f["program_ids"])): f["label"]
         for f in kp.check_promos(*_promo_args("2026-11-12"))}
    assert b == {("promo_below_floor", ("KM1111-A",)): "đang chạy",
                 ("promo_over_cap", ("KM1212-A",)): "dự kiến T-30"}


def _promo_args(as_of):
    rows, _ = kp.read_plan(PLAN, WATCH["promo_kinds"], CAL)
    return rows, GP, RDP, PROM, COGS, NET, WATCH, as_of


def test_promo_unverifiable_without_golden():
    rows, _ = kp.read_plan(PLAN, WATCH["promo_kinds"], CAL)
    fs = kp.check_promos(rows, {}, RDP, PROM, [], NET, WATCH, TODAY)
    assert {f["kind"] for f in fs} == {"promo_banned", "promo_unverifiable"}


@pytest.mark.parametrize("start_off,end_off,expect,label", [
    (-3, 0, True, "đang chạy"),         # ngày cuối = hôm nay → vẫn cảnh báo
    (-3, -1, False, None),              # đã kết thúc hôm qua
    (45, 45, True, "dự kiến T-45"),     # bắt đầu đúng biên lookahead
    (46, 46, False, None),              # ngoài lookahead 1 ngày
])
def test_check_promos_window_inclusive_edges(start_off, end_off, expect,
                                             label):
    """Khóa biên bao-gồm của cửa sổ: end >= today và start <= horizon —
    flash sale 1 ngày chạy hôm nay 45% (dưới sàn) PHẢI ra S1."""
    from datetime import timedelta
    assert WATCH["lookahead_days"] == 45
    row = {"row_no": 2, "program_id": "KM-EDGE", "channel": "shopee",
           "sku_key": "sam-a", "kind": "voucher",
           "start": TODAY + timedelta(days=start_off),
           "end": TODAY + timedelta(days=end_off), "pct": 45,
           "price": None, "event": "", "event_date": None}
    fs = kp.check_promos([row], GP, RDP, PROM, COGS, NET, WATCH, TODAY)
    if not expect:
        assert fs == []
        return
    assert {f["kind"] for f in fs} == {"promo_below_floor", "promo_over_cap"}
    assert {f["label"] for f in fs} == {label}


# ---------------------------------------------------------------- DB

@pytest.fixture
def db():
    yield from kd_db()


@pytest.fixture
def cli_price(monkeypatch):
    FakeRun.calls = []
    calls = {"connect": 0}

    def no_db():
        calls["connect"] += 1

    monkeypatch.setattr(kp, "connect", no_db)
    monkeypatch.setattr(kp, "job_run", FakeRun)
    return calls


def seed_price(conn):
    ids = seed(conn)
    for sku, cost, ok in (("sam-b", 90000, True), ("sam-c", 100000, False)):
        cid = one(conn, "insert into cogs_versions (sku_key, cost_vnd,"
                  " valid_from, created_by) values (%s, %s, '2026-01-01',"
                  " 'KT (test)') returning id", (sku, cost))
        if ok:
            conn.execute("update cogs_versions set approved_by = 'GĐ tài"
                         " chính (test)', approved_at = now() where id = %s",
                         (cid,))
    imp = one(conn, "insert into intel_imports (kind, file_name, file_sha256,"
              " row_count) values ('competitor', 'dt.csv', %s, 1)"
              " returning id", (uuid.uuid4().hex,))
    conn.execute("insert into competitor_observations (import_id, row_no,"
                 " competitor, channel, product_name, sku_key, price_vnd,"
                 " promo_price_vnd, observed_on, source_ref) values (%s, 2,"
                 " 'Đối thủ X', 'shopee', 'Sâm A loại khác', 'sam-a', %s,"
                 " %s, '2026-10-10', 'ảnh chụp dt.png')",
                 (imp, COMPETITOR, COMPETITOR - 7))
    return ids


def _q(db):
    return db.execute(
        "select object_type, object_id, block, status, risk, decided_by,"
        " guardrail->>'ok', title, payload from approval_queue"
        " where object_id like 'a5:%' order by id").fetchall()


def test_db_analyze_enqueue_idempotent_no_auto(db):
    ids = seed_price(db)
    plan, _ = kp.read_plan(PLAN, WATCH["promo_kinds"], CAL)
    tx = TxConn(db)
    res = kp.analyze(tx, MAPPING, WATCH, NET, TODAY, plan)
    lk = sorted((f["kind"], f.get("item_id")) for f in res["listing"]
                if f["severity"] != "INFO")
    assert lk == sorted([("below_floor", "1001"), ("list_deviation", "1002"),
                         ("negative_margin", "1002"),
                         ("list_deviation", "1003"),
                         ("listing_promo_over_cap", "1008")])
    dup = [f for f in res["listing"] if f.get("dup_alert")]
    assert [(f["item_id"], f["dup_alert"]) for f in dup] == [
        ("1003", ids["mismatch"])]
    info = [f for f in res["listing"] if f["severity"] == "INFO"]
    assert {f["sku_key"] for f in info} == {"sam-a", "sam-c", "sam-g"}
    # giá đối thủ: chỉ trong dữ liệu báo cáo
    assert [r[3] for r in res["competitor"]] == [COMPETITOR]
    # SKU nhóm CAM (rượu) trong giá đối thủ: không in sku_key ra báo cáo
    imp = one(db, "insert into intel_imports (kind, file_name, file_sha256,"
              " row_count) values ('competitor', 'r.csv', %s, 1)"
              " returning id", (uuid.uuid4().hex,))
    db.execute("insert into competitor_observations (import_id, row_no,"
               " competitor, channel, product_name, sku_key, price_vnd,"
               " observed_on, source_ref) values (%s, 2, 'Đối thủ Y',"
               " 'shopee', 'r', 'ruou-x', 500000, '2026-10-10', 'r.png')",
               (imp,))
    comp = kp.analyze(tx, MAPPING, WATCH, NET, TODAY, plan)["competitor"]
    assert sorted(r[0] or "" for r in comp) == ["", "sam-a"]
    rep = kp.render_report({**res, "competitor": comp}, WATCH, TODAY, plan,
                           None)
    assert "ruou" not in rep and "(nhóm CAM)" in rep
    db.execute("delete from competitor_observations where import_id = %s",
               (imp,))
    items = kp.to_items(res["listing"] + res["promo"], CFG)
    n = kl.enqueue_new(tx, items, CFG, kl.seen_ids(tx, "a5"), kp.AGENT)
    assert n == len(items) == 4 + 9
    q = _q(db)
    assert len(q) == 13
    for ot, oid, block, st, risk, by, gok, title, payload in q:
        assert (block, st, risk, by, gok) == ("sales", "pending", "high",
                                              None, "true"), oid
        assert ot in ("market_alert_s1", "price_change", "promo_change")
        for s in COMP_STR:
            assert s not in payload and s not in title
        assert "ruou" not in payload and RUOU_TITLE not in payload
    assert not [r for r in q if ":1003:" in r[1]]              # trùng v3.3
    assert {r[0] for r in q if "KM1111-D" in r[1] or "KM1111-E" in r[1]} \
        == {"market_alert_s1"}
    assert one(db, "select count(*) from approval_queue where object_id like"
               " 'a5:%%' and lane is not null") == 0
    # Lần 2 cùng dữ liệu → 0 mục mới.
    res2 = kp.analyze(tx, MAPPING, WATCH, NET, TODAY, plan)
    items2 = kp.to_items(res2["listing"] + res2["promo"], CFG)
    assert kl.enqueue_new(tx, items2, CFG, kl.seen_ids(tx, "a5"),
                          kp.AGENT) == 0
    # Giá golden/sàn không bị đụng.
    assert one(db, "select count(*) from price_list") == 12
    assert one(db, "select count(*) from market_alerts") == 2


def test_cli_run_no_plan_job_run_and_dry_run_counts(db, cli_price,
                                                    monkeypatch, capsys):
    seed_price(db)
    monkeypatch.setattr(kp, "connect", lambda: TxConn(db))
    tables = ("approval_queue", "price_list", "market_alerts", "sku_master",
              "cogs_versions", "job_runs")
    before = {t: one(db, f"select count(*) from {t}") for t in tables}
    assert kp.main(["--run", "--dry-run", "--plan", str(PLAN), "--as-of",
                    "2026-10-12"]) == 0
    out = capsys.readouterr().out
    assert {t: one(db, f"select count(*) from {t}") for t in tables} == before
    assert "[dry-run] sẽ đẩy 13 mục mới" in out and FakeRun.calls == []
    for s in COMP_STR:
        assert s not in out
    assert kp.main(["--run"]) == 0 and FakeRun.calls == [kp.JOB]
    out = capsys.readouterr().out
    assert "[info] chưa có kế hoạch KM" in out
    assert "[run] đẩy 4 mục mới" in out


def test_cli_report_as_of_str_labels_and_sections(db, cli_price, monkeypatch,
                                                  tmp_path):
    seed_price(db)
    monkeypatch.setattr(kp, "connect", lambda: TxConn(db))
    for as_of in ("2026-10-12", "2026-11-12"):
        assert kp.main(["--report", "--plan", str(PLAN), "--as-of", as_of,
                        "--out-dir", str(tmp_path)]) == 0
    a = (tmp_path / "price-watch-2026-10-12.md").read_text(encoding="utf-8")
    b = (tmp_path / "price-watch-2026-11-12.md").read_text(encoding="utf-8")
    assert "dự kiến T-29" in a and "đang chạy" not in a
    assert "đang chạy" in b and "dự kiến T-30" in b and "T-29" not in b
    assert a.index("## S1") < a.index("## S2")
    assert "| 11.11 | 11/11/2026 | 5 | 9 |" in a
    assert "Tham khảo đối thủ (KHÔNG dùng để đề xuất giá)" in a
    assert "77.777 đ" in a                       # chỉ ở mục tham khảo
    s12 = a.split("## Tham khảo đối thủ")[0]
    for s in COMP_STR:
        assert s not in s12
    assert "ruou" not in a and RUOU_TITLE not in a
    assert a == (tmp_path / "price-watch-2026-10-12.md").read_text(
        encoding="utf-8")
    assert FakeRun.calls == []


@pytest.mark.parametrize("argv", [
    [], ["--run", "--report"], ["--dry-run"], ["--report", "--dry-run"],
    ["--run", "--as-of", "2026-10-12"],
    ["--report", "--as-of", "12/10/2026"],
    ["--report", "--as-of", "2026-02-30"]])
def test_cli_usage_exit2_before_connect(cli_price, argv):
    with pytest.raises(SystemExit) as e:
        kp.main(argv)
    assert e.value.code == 2 and cli_price["connect"] == 0
    assert FakeRun.calls == []


def test_cli_help_exit0():
    with pytest.raises(SystemExit) as e:
        kp.main(["--help"])
    assert e.value.code == 0
