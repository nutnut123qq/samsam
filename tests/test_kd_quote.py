"""v8.2 KD-A3 — báo giá B2B quà Tết: ma trận GIẢ ĐỊNH, định giá/phân loại
TẤT ĐỊNH, báo giá markdown/HTML qua cổng `check_publish`, hàng duyệt đúng
lane, bản gửi phải khớp hash bản duyệt, không đường email.

Thuần: không DB/mạng. DB thật: schema tạm + ROLLBACK (`da_db`/`TxConn`).
Người trong test là tên GIẢ LẬP (test), SĐT dạng 09xxxxxxxx giả.
"""

import copy
import json
import re
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from agents import kd_quote as kq
from connectors import b2b_form
from ingest import crm
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import approval_queue as aq
from pipelines import director, kb_filter
from pipelines.pii import _PII_RE
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
FX = ROOT / "tests" / "fixtures" / "b2b"
DAY = date(2026, 10, 12)
H1 = "mat-ong-sam-120ml-1hu"
APPROVER = "GD Ban Hang Gia Lap (test)"
FIN = "Tai Chinh Gia Lap (test)"
PHONE = "0901234567"
CNAME = "Nguoi Lien He Mau"
EMAIL = "lienhe.mau@example.com"


def _j(p):
    return json.loads(Path(p).read_bytes().decode("utf-8"))


GOLD_REAL, _ = read_golden(GOLDEN_FILE)
GOLD = _j(FX / "golden_MAU.json")
MX_REAL = _j(ROOT / "data" / "b2b_pricing.json")
MX = _j(FX / "matrix_MAU.json")
BOM = _j(FX / "bom_MAU.json")["combos"]
SAMPLE_BOM = _j(ROOT / "data" / "sample_bom.json")["combos"]


def _v(sku, cost, vf=date(2026, 1, 1), by=FIN, i=1):
    return {"id": i, "sku_key": sku, "cost_vnd": cost, "valid_from": vf,
            "approved_by": by}


def _cls(items, cogs=(), matrix=MX, golden=GOLD, combos=BOM, **kw):
    return kq.classify(items, matrix, golden, combos, list(cogs), DAY, **kw)


# ---------------------------------------------------------- ma trận
def test_real_matrix_valid_and_assumed():
    assert kq.validate_matrix(MX_REAL) == []
    assert MX_REAL["finance_confirmed"] is None
    assert MX_REAL["sales_confirmed"] is None
    assert "GIẢ ĐỊNH" in MX_REAL["status"]
    g, c = kq.gidx(GOLD_REAL), kq.cidx(SAMPLE_BOM)
    for k in MX_REAL["items"]:
        assert not kq.is_alcohol_key(k, g, c), k
        assert g.get(k, {}).get("category") != "alcohol"


def _mut(fn):
    m = copy.deepcopy(MX_REAL)
    fn(m)
    return m


@pytest.mark.parametrize("name, fn, needle", [
    ("tiers-chong", lambda m: m["tiers"][1].update(min_qty=40), "liền ngay"),
    ("tiers-ho", lambda m: m["tiers"][1].update(min_qty=60), "liền ngay"),
    ("ck-60", lambda m: m["tiers"][0].update(discount_pct=60),
     "discount_pct"),
    ("ck-float", lambda m: m["tiers"][0].update(discount_pct=5.0),
     "discount_pct"),
    ("key-ruou", lambda m: m["items"].update(
        {"ruou-sam-chai-thuy-tinh-500ml": {"max_discount_pct": 5}}),
     "rượu không được vào ma trận"),
    ("key-ruou-ten-la", lambda m: m["items"].update(
        {"ruou-sam-moi": {"max_discount_pct": 5}}),
     "rượu không được vào ma trận"),
    ("finance-by-trang", lambda m: m.update(
        finance_confirmed={"by": "  ", "at": "2026-10-01"}),
     "finance_confirmed"),
    ("sales-at-sai", lambda m: m.update(
        sales_confirmed={"by": "X", "at": "01/10/2026"}), "sales_confirmed"),
    ("bien-91", lambda m: m.update(min_margin_pct=91), "min_margin_pct"),
    ("base-kenh-la", lambda m: m["base"].update(channel="lazada"), "base"),
    ("key-khong-slug", lambda m: m["items"].update(
        {"Mat Ong": {"max_discount_pct": 5}}), "slug"),
    ("thieu-finance", lambda m: m.pop("finance_confirmed"),
     "finance_confirmed"),
])
def test_validate_matrix_errors(name, fn, needle):
    errs = kq.validate_matrix(_mut(fn))
    assert errs and any(needle in e for e in errs), (name, errs)


def test_check_matrix_cli(tmp_path, capsys):
    assert kq.main(["--check-matrix"]) == 0
    assert "tài chính CHƯA xác nhận" in capsys.readouterr().out
    bad = tmp_path / "m.json"
    bad.write_bytes(json.dumps(_mut(
        lambda m: m["items"].update(
            {"ruou-sam-chai-thuy-tinh-500ml": {"max_discount_pct": 5}})),
        ensure_ascii=False).encode("utf-8"))
    assert kq.main(["--check-matrix", str(bad)]) == 1
    assert "rượu" in capsys.readouterr().err
    assert kq.main(["--check-matrix", str(tmp_path / "khong-co.json")]) == 1


# ---------------------------------------------------------- classify
def test_gate_case_within_matrix_exact_numbers():
    r = _cls([{"key": H1, "qty": 20}], [_v(H1, 300000)])
    (ln,) = r["lines"]
    assert (ln["list_unit"], ln["discount_pct"], ln["unit"], ln["amount"]) \
        == (745000, 5, 707000, 14140000)
    assert r["total"] == 14140000 and r["cogs_total"] == 6000000
    assert r["margin_pct"] == Decimal("57.6")
    assert isinstance(r["margin_pct"], Decimal)
    assert isinstance(ln["unit"], int) and not isinstance(ln["unit"], bool)
    assert r["within_matrix"] is True and r["reasons"] == [] \
        and r["problems"] == []


@pytest.mark.parametrize("cost,within,margin", [
    (494900, True, Decimal("30.0")),     # 9_898_000/14_140_000 = ĐÚNG 30%
    (495182, False, Decimal("30.0")),    # 29.9601% — làm tròn hiển thị 30.0
    (495200, False, Decimal("30.0")),    # 29.9576%
])
def test_margin_threshold_compares_unrounded(cost, within, margin):
    """Ngưỡng so trên biên CHƯA làm tròn: 29.96% không được lọt lane
    trong ma trận chỉ vì margin_pct hiển thị 30.0 (ngưỡng MAU = 30)."""
    r = _cls([{"key": H1, "qty": 20}], [_v(H1, cost)])
    assert r["total"] == 14140000 and r["margin_pct"] == margin
    assert r["within_matrix"] is within
    assert r["reasons"] == ([] if within else ["bien_duoi_nguong"])


_CASES = {
    "bien-duoi-nguong": ({"items": [{"key": H1, "qty": 20}],
                              "cogs": [_v(H1, 600000)]}, ["bien_duoi_nguong"]),
    "gia-von-chua-duyet": ({"items": [{"key": H1, "qty": 20}],
                                "cogs": [_v(H1, 300000, by=None)]},
                           ["thieu_gia_von_duyet"]),
    "gia-von-by-trang": ({"items": [{"key": H1, "qty": 20}],
                              "cogs": [_v(H1, 300000, by="   ")]},
                         ["thieu_gia_von_duyet"]),
    "gia-von-hieu-luc-sau": ({"items": [{"key": H1, "qty": 20}],
                                  "cogs": [_v(H1, 300000,
                                           vf=date(2026, 11, 1))]},
                             ["thieu_gia_von_duyet"]),
    "qty-5": ({"items": [{"key": H1, "qty": 5}], "cogs": [_v(H1, 300000)]},
              ["ngoai_bac_so_luong"]),
    "qty-2000": ({"items": [{"key": H1, "qty": 2000}],
                      "cogs": [_v(H1, 300000)]}, ["ngoai_bac_so_luong"]),
    "ck-20": ({"items": [{"key": H1, "qty": 20}], "cogs": [_v(H1, 300000)],
                   "discount": 20}, ["chiet_khau_vuot"]),
    "ck-40-duoi-san": ({"items": [{"key": H1, "qty": 20}],
                            "cogs": [_v(H1, 300000)], "discount": 40},
                       ["chiet_khau_vuot", "duoi_gia_san"]),
    "ngoai-ma-tran": ({"items": [{"key": "mat-ong-sam-300ml", "qty": 20}],
                           "cogs": [_v("mat-ong-sam-300ml", 900000)],
                           "matrix": _mut(lambda m: (m.update(
                               finance_confirmed=MX["finance_confirmed"],
                               sales_confirmed=MX["sales_confirmed"]),
                               m["items"].pop("mat-ong-sam-300ml")))},
                      ["ngoai_ma_tran"]),
    "ma-tran-that-chua-xac-nhan": ({"items": [{"key": H1, "qty": 20}],
                                        "cogs": [_v(H1, 300000)],
                                        "matrix": MX_REAL},
                                   ["ma_tran_chua_xac_nhan"]),
    "tpbvsk-none": ({"items": [{"key": "saphraton-20v", "qty": 20}],
                         "cogs": [_v("saphraton-20v", 100000)],
                         "golden": GOLD_REAL}, ["tpbvsk_chua_xnqc"]),
    "combo-thieu-bao-bi": ({"items": [{"key": "hop-qua-tet-sam-sam-mau",
                                        "qty": 20}],
                                "cogs": [_v("saphraton-80v", 400000),
                                      _v("mat-ong-sam-120ml-2hu", 500000,
                                         i=2)]},
                           ["thieu_chi_phi_bao_bi", "tpbvsk_chua_xnqc"]),
    "thieu-gia-niem-yet": ({"items": [{"key": "saphraton-40v", "qty": 20}],
                                "cogs": [_v("saphraton-40v", 100000)],
                                "matrix": _mut(lambda m: (m.update(
                                    finance_confirmed=MX["finance_confirmed"],
                                    sales_confirmed=MX["sales_confirmed"]),
                                    m["items"].update({"saphraton-40v": {
                                        "max_discount_pct": 12}})))},
                           ["thieu_gia_niem_yet", "tpbvsk_chua_xnqc"]),
}


@pytest.mark.parametrize("name", sorted(_CASES))
def test_classify_reasons(name):
    kw, want = _CASES[name]
    r = _cls(**kw)
    assert r["problems"] == [], name
    assert r["reasons"] == want, (name, r["reasons"])
    assert r["within_matrix"] is False


def test_tpbvsk_approved_and_combo_pricing_within():
    r = _cls([{"key": "savina-12v", "qty": 20}],
             [_v("savina-12v", 50000)])
    assert r["within_matrix"] is True and r["lines"][0]["unit"] == 151000
    r = _cls([{"key": "hop-qua-mat-ong-mau", "qty": 20}], [_v(H1, 300000)])
    (ln,) = r["lines"]
    assert (ln["list_unit"], ln["floor_unit"], ln["unit"], ln["cogs_unit"]) \
        == (1490000, 1000000, 1415000, 650000)
    assert r["margin_pct"] == Decimal("54.1") and r["within_matrix"] is True


@pytest.mark.parametrize("items, code", [
    ([{"key": "ruou-sam-chai-thuy-tinh-500ml", "qty": 20}],
     "ruou_khong_bao_gia"),
    ([{"key": "hop-qua-cao-cap-mau", "qty": 20}], "ruou_khong_bao_gia"),
    ([{"key": "hop-sum-vay-mau", "qty": 20}], "ruou_khong_bao_gia"),
    ([{"key": "ruou-sam-moi-chua-co", "qty": 20}], "ruou_khong_bao_gia"),
    ([{"key": H1, "qty": 20}, {"key": "ruou-sam-binh-su-do-500ml",
                               "qty": 10}], "ruou_khong_bao_gia"),
    ([{"key": "khong-co-ma", "qty": 20}], "ma_khong_ton_tai"),
    ([{"key": H1, "qty": "10"}], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": 0}], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": -1}], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": True}], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": 100001}], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": 1.5}], "so_luong_khong_hop_le"),
    ([], "so_luong_khong_hop_le"),
    ([{"key": H1, "qty": 1}] * 11, "so_luong_khong_hop_le"),
])
def test_classify_problems_block(items, code):
    r = _cls(items, [_v(H1, 300000)])
    assert code in r["problems"] and r["within_matrix"] is False


def test_matrix_error_is_problem():
    r = _cls([{"key": H1, "qty": 20}], [_v(H1, 300000)],
             matrix=_mut(lambda m: m["tiers"][0].update(discount_pct=99)))
    assert r["problems"] == ["ma_tran_loi"] and r["lines"] == []


def test_classify_pure_no_db_no_network(monkeypatch):
    import httpx

    from ingest import lead_store

    def boom(*a, **k):
        raise AssertionError("không được gọi mạng/DB")

    monkeypatch.setattr(httpx.Client, "__init__", boom)
    monkeypatch.setattr(lead_store, "connect", boom)
    monkeypatch.setattr(kq, "connect", boom)
    r = _cls([{"key": H1, "qty": 20}], [_v(H1, 300000)])
    assert r["within_matrix"] is True


# ---------------------------------------------------------- báo giá
REQ = {"id": 7, "org_name": "Công ty MẪU B2B", "org_type": "doanh_nghiep",
       "region": "Đà Nẵng", "need_by": date(2026, 12, 20)}


def _built(items, cogs, golden=GOLD, req=REQ, matrix=MX):
    r = kq.classify(items, matrix, golden, BOM, cogs, DAY)
    return r, kq.build_quote(req, r, golden, DAY, matrix)


def test_quote_payload_honey_only_gate_clean():
    _r, b = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)],
                  golden=GOLD_REAL)
    p = b["payload"]
    assert re.fullmatch(r"BG-20261012-7-[0-9a-f]{8}", b["quote_no"])
    assert b["quote_no"] in p and "707.000đ" in p and "14.140.000đ" in p
    assert kq.disclaimer() not in p
    assert "Công ty MẪU B2B (Doanh nghiệp) — Đà Nẵng" in p
    assert "hệ thống không tự gửi" in p and "Ngọc Linh" not in p
    assert "biên" not in p.lower() and "300.000" not in p  # giá vốn nội bộ
    assert "57.6%" in b["internal"] and "6.000.000đ" in b["internal"]
    assert kq.gate_quote(p, kq.alcohol_names(GOLD_REAL),
                         kq.readiness_map(GOLD_REAL),
                         ids=[b["quote_no"]]) == []
    # quote_no ổn định ×2 (cùng đầu vào → cùng số)
    _, b2 = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)],
                   golden=GOLD_REAL)
    assert b2 == b


def test_quote_payload_tpbvsk_has_disclaimer():
    _, b = _built([{"key": "saphraton-20v", "qty": 20}],
                  [_v("saphraton-20v", 100000)], golden=GOLD_REAL)
    assert kq.disclaimer() in b["payload"]
    assert kq.gate_quote(b["payload"], kq.alcohol_names(GOLD_REAL),
                         kq.readiness_map(GOLD_REAL),
                         ids=[b["quote_no"]]) == []


def test_quote_no_contact_pii():
    req = {**REQ, "contact_name": CNAME, "phone": PHONE, "email": EMAIL}
    _, b = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)], req=req)
    for s in (CNAME, PHONE, EMAIL):
        assert s not in b["payload"] and s not in b["internal"]
    assert not _PII_RE.search(b["payload"].replace(b["quote_no"], ""))


def test_quote_org_with_banned_word_blocked():
    _, b = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)],
                  req={**REQ, "org_name": "Nhà thuốc MẪU X"})
    errs = kq.gate_quote(b["payload"], kq.alcohol_names(GOLD),
                         kq.readiness_map(GOLD), ids=[b["quote_no"]])
    assert "guardrail:tu_cam" in errs


def test_gate_catches_alcohol_and_pii():
    names = kq.alcohol_names(GOLD)
    assert "ruou-sam-chai-thuy-tinh-500ml" in names
    assert "ruou" in kq.gate_quote("# Báo giá\n\nRượu sâm chai thủy tinh"
                                   " 500ml\n", names)
    assert "pii" in kq.gate_quote("# Báo giá\n\nGọi 0905 123 456\n", names)
    # mã hệ thống tự sinh không bị coi là SĐT
    fake = "BG-20261012-84-01234567"
    assert "pii" in kq.gate_quote(f"# Báo giá {fake}\n", names)
    assert "pii" not in kq.gate_quote(f"# Báo giá {fake}\n", names,
                                      ids=[fake])


def test_build_quote_refuses_problems():
    r = _cls([{"key": "ruou-sam-chai-thuy-tinh-500ml", "qty": 20}])
    b = kq.build_quote(REQ, r, GOLD, DAY, MX)
    assert b["problems"] == ["ruou_khong_bao_gia"] and b["payload"] == ""


# ---------------------------------------------------------- HTML
def test_render_html_deterministic_escaped():
    _, b = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)],
                  req={**REQ, "org_name": "<script>alert(1)</script> & Co"})
    h1, h2 = kq.render_html(b["payload"]), kq.render_html(b["payload"])
    assert h1 == h2 and h1.encode("utf-8") == h2.encode("utf-8")
    low = h1.lower()
    assert "<script" not in low and "&lt;script&gt;" in low
    assert '<meta charset="utf-8">' in h1 and "size: A4" in h1
    assert not re.search(r"(?i)(src|href)=\"(https?:|//)", h1)
    assert "<table>" in h1 and "<th>Sản phẩm</th>" in h1
    assert "<strong>Tổng cộng: 14.140.000đ</strong>" in h1


def test_render_html_image_only_relative_packshot():
    h = kq.render_html("# T\n\n![a](packshots/mat-ong.png)\n\n"
                       "![b](https://evil.example/x.png)\n")
    assert '<img src="packshots/mat-ong.png" alt="a">' in h
    assert "evil.example" in h and "<img src=\"https" not in h


def test_no_email_path_in_modules():
    for f in ("agents/kd_quote.py", "agents/kd_catalog.py",
              "connectors/b2b_form.py"):
        src = (ROOT / f).read_text(encoding="utf-8")
        assert not re.search(
            r"import (httpx|requests|socket|smtplib)|from (httpx|requests|"
            r"smtplib|urllib\.request|http\.client|email)|urllib\.request|"
            r"email\.mime|sendmail|webbrowser|llm_gateway", src), f


# ---------------------------------------------------------- CLI tham số
@pytest.mark.parametrize("argv", [
    ["--requests", "--quote", "1"],
    ["--check-matrix", "--requests"],
    ["--quote", "1", "--export", "2", "--out", "x.md"],
    ["--quote", "1", "--submit", "--dry-run"],
    ["--requests", "--submit"],
    ["--export", "1"],
    ["--quote", "1", "--discount", "60"],
    ["--quote", "1", "--date", "12/10/2026"],
    [],
])
def test_cli_bad_args_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(kq, "connect",
                        lambda: pytest.fail("không được connect"))
    with pytest.raises(SystemExit) as e:
        kq.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(kq, "connect", lambda: None)
    assert kq.main(["--requests"]) == 2
    assert kq.main(["--verify-send", "1", "x.md"]) == 2


# ---------------------------------------------------------- DB thật
@pytest.fixture
def db():
    yield from da_db()


@pytest.fixture
def keys():
    return crm.load_vault_key({"CONTACT_VAULT_KEY":
                               Fernet.generate_key().decode()})


def _skus(db, *keys_):
    g = kq.gidx(GOLD)
    for k in keys_:
        db.execute("insert into sku_master (sku_key, name, category, source)"
                   " values (%s, %s, %s, 'test') on conflict do nothing",
                   (k, g[k]["name"], g[k]["category"]))
        # r12 L2: báo giá chỉ đọc giá price_list ĐÃ duyệt (không JSON) —
        # dựng giá shopee list/floor đã duyệt = giá golden của ca.
        for kind in ("list", "floor"):
            v = ((g[k].get("prices") or {}).get("shopee") or {}).get(kind)
            if v and not db.execute(
                    "select 1 from price_list where sku_key = %s and channel ="
                    " 'shopee' and kind = %s and approved_by is not null",
                    (k, kind)).fetchone():
                pid = db.execute(
                    "insert into price_list (sku_key, channel, kind,"
                    " price_vnd, valid_from) values (%s, 'shopee', %s, %s,"
                    " '2026-01-01') returning id", (k, kind, v)).fetchone()[0]
                db.execute("update price_list set approved_by = 'GĐ Bán Hàng"
                           " Giả Lập (test)', approved_at = now() where id ="
                           " %s", (pid,))


def _cogs(db, sku, cost, approve=True):
    from agents import fp_pnl
    _skus(db, sku)
    cid = fp_pnl.add_cogs(db, sku, cost, date(2026, 1, 1), "GD San Xuat Gia"
                          " Lap (test)")
    if approve:
        assert fp_pnl.approve(TxConn(db), cid, FIN)[0] is True
    return cid


def _request(db, keys, items, org="Công ty MẪU B2B", phone=PHONE):
    form = {"org_name": org, "org_type": "doanh_nghiep", "region": "Đà Nẵng",
            "contact": {"name": CNAME, "phone": phone, "email": EMAIL},
            "items": items, "need_by": None}
    rid, new = b2b_form.intake(TxConn(db), form, keys, today=DAY)
    assert new
    return rid


def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(kq, "connect", lambda: TxConn(db))
    monkeypatch.setattr(kq, "MATRIX_FILE", FX / "matrix_MAU.json")
    monkeypatch.setattr(kq, "GOLDEN_FILE", FX / "golden_MAU.json")
    return kq.main(list(argv))


def _items(db):
    return db.execute("select id, block, object_type, risk, status,"
                      " qa_status, created_by, lane from approval_queue"
                      " order by id").fetchall()


def test_db_within_matrix_low_lane_pending_then_auto_policy(
        db, keys, monkeypatch, capsys, tmp_path):
    _cogs(db, H1, 300000)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    db.execute("insert into eval_runs (commit_sha, agent, n_total, n_pass,"
               " pass_rate, passed) values (%s, 'kd_a3', 18, 18, 1.0, true)",
               ("a" * 40,))
    out_dir = tmp_path / "out"
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit", "--date",
                "2026-10-12", "--out-dir", str(out_dir)) == 0
    out = capsys.readouterr().out
    assert "b2b_quote_matrix" in out and "[done]" in out
    (it,) = _items(db)
    assert it[1:7] == ("sales", "b2b_quote_matrix", "low", "pending", "pass",
                       "agent:kd_quote")
    files = sorted(p.name for p in out_dir.iterdir())
    assert len(files) == 3 and any(f.endswith("-noi-bo.md") for f in files)
    for p in out_dir.iterdir():
        body = p.read_text(encoding="utf-8")
        assert PHONE not in body and CNAME not in body and EMAIL not in body
    # không có luật đã ký → director.run KHÔNG tự duyệt
    director.run(TxConn(db), "sales", out_dir=tmp_path / "rep")
    assert _items(db)[0][4] == "pending"
    # luật ký (test) → lane auto_policy
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('b2b_matrix_auto',"
               " 'b2b_quote_matrix', 'low', true, 'Chu Khoi Gia Lap (test)',"
               " now())")
    director.run(TxConn(db), "sales", out_dir=tmp_path / "rep")
    assert _items(db)[0][4] == "approved" and _items(db)[0][7] == \
        "auto_policy"
    # chạy lại → [skip], không thêm mục
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit", "--date",
                "2026-10-12", "--out-dir", str(out_dir)) == 0
    assert "[skip]" in capsys.readouterr().out and len(_items(db)) == 1


def test_db_qa_none_and_high_never_auto(db, keys, monkeypatch, capsys,
                                        tmp_path):
    _cogs(db, H1, 300000)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit",
                "--discount", "10", "--date", "2026-10-12", "--out-dir",
                str(tmp_path)) == 0
    (it,) = _items(db)
    assert it[1:5] == ("sales", "b2b_quote", "high", "pending")
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('b2b_q_auto',"
               " 'b2b_quote', 'low', true, 'Chu Khoi Gia Lap (test)', now())")
    ok, msg = aq.auto_approve(TxConn(db), it[0])
    assert ok is False and "rủi ro high" in msg
    director.run(TxConn(db), "sales", out_dir=tmp_path / "rep")
    assert _items(db)[0][4] == "pending"


def test_db_margin_below_two_items_atomic(db, keys, monkeypatch, capsys,
                                          tmp_path):
    _cogs(db, H1, 600000)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    req = kq.fetch_request(db, rid)
    res = kq.classify(req["items"], MX, GOLD, [], kq.fetch_versions(db), DAY)
    assert res["reasons"] == ["bien_duoi_nguong"]
    built = kq.build_quote(req, res, GOLD, DAY, MX)
    real = director.submit

    def flaky(conn, block, *a, **kw):
        if block == "finance":
            raise RuntimeError("lỗi giả ở mục 2")
        return real(conn, block, *a, **kw)

    monkeypatch.setattr(director, "submit", flaky)
    with pytest.raises(RuntimeError):
        kq.submit(TxConn(db), req, built, res)
    assert _items(db) == []
    monkeypatch.setattr(director, "submit", real)
    ids = kq.submit(TxConn(db), req, built, res)
    got = _items(db)
    assert len(ids) == 2 and [(r[1], r[2], r[3]) for r in got] == [
        ("sales", "b2b_quote", "high"), ("finance", "b2b_margin_review",
                                         "high")]
    fin = db.execute("select payload from approval_queue where block ="
                     " 'finance'").fetchone()[0]
    assert "bien_duoi_nguong" in fin and "KHÔNG gửi khách" in fin
    assert kq.submit(TxConn(db), req, built, res) == []
    assert len(_items(db)) == 2


def test_db_missing_cogs_goes_finance(db, keys, monkeypatch, capsys,
                                      tmp_path):
    _cogs(db, H1, 300000, approve=False)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit", "--date",
                "2026-10-12", "--out-dir", str(tmp_path)) == 0
    assert [(r[1], r[2]) for r in _items(db)] == [
        ("sales", "b2b_quote"), ("finance", "b2b_margin_review")]


def test_db_alcohol_request_refused(db, keys, monkeypatch, capsys, tmp_path):
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    row = db.execute("select contact_id, consent_id from b2b_requests where"
                     " id = %s", (rid,)).fetchone()
    bad = db.execute(
        "insert into b2b_requests (request_key, org_name, org_type, region,"
        " items, contact_id, consent_id, source) values (%s, 'Công ty MẪU"
        " Y', 'doanh_nghiep', 'Đà Nẵng', %s::jsonb, %s, %s, 'test')"
        " returning id",
        ("b2r:" + "f" * 64, json.dumps([
            {"key": H1, "qty": 20},
            {"key": "ruou-sam-chai-thuy-tinh-500ml", "qty": 10}]),
         *row)).fetchone()[0]
    assert _cli(db, monkeypatch, "--quote", str(bad), "--submit", "--date",
                "2026-10-12", "--out-dir", str(tmp_path)) == 1
    err = capsys.readouterr().err
    assert "ruou_khong_bao_gia" in err and _items(db) == []
    assert list(tmp_path.iterdir()) == []


def test_db_quote_not_found_and_requests(db, keys, monkeypatch, capsys):
    assert _cli(db, monkeypatch, "--quote", "999999999", "--dry-run") == 1
    _request(db, keys, [{"key": H1, "qty": 20}])
    assert _cli(db, monkeypatch, "--requests") == 0
    out = capsys.readouterr().out
    assert "Công ty MẪU B2B" in out and "1 yêu cầu" in out
    assert PHONE not in out and CNAME not in out and EMAIL not in out


def test_db_export_verify_send(db, keys, monkeypatch, capsys, tmp_path):
    _cogs(db, H1, 300000)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit", "--date",
                "2026-10-12", "--out-dir", str(tmp_path / "d")) == 0
    qid = _items(db)[0][0]
    md, ht = tmp_path / "bg.md", tmp_path / "bg.html"
    # pending → không xuất, không KHỚP
    assert _cli(db, monkeypatch, "--export", str(qid), "--out", str(md)) == 1
    draft = next((tmp_path / "d").glob("bao-gia-*[0-9a-f].md"))
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(draft)) == 1
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    assert _cli(db, monkeypatch, "--export", str(qid), "--out", str(md)) == 0
    assert _cli(db, monkeypatch, "--export", str(qid), "--out", str(ht)) == 0
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(md)) == 0
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(ht)) == 0
    assert "KHỚP bản đã duyệt" in capsys.readouterr().out
    assert md.read_bytes() == draft.read_bytes()   # nháp == bản duyệt
    for f in (md, ht):
        data = f.read_bytes()
        bad = tmp_path / ("x" + f.suffix)
        bad.write_bytes(data.replace(b"707.000", b"706.000"))
        assert _cli(db, monkeypatch, "--verify-send", str(qid), str(bad)) == 1
        bad.write_bytes(data + b" ")
        assert _cli(db, monkeypatch, "--verify-send", str(qid), str(bad)) == 1
    big = tmp_path / "big.md"
    big.write_bytes(b"a" * (2 * 1024 * 1024 + 1))
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(big)) == 1
    nu = tmp_path / "nu.md"
    nu.write_bytes(md.read_bytes() + b"\xff")
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(nu)) == 1
    assert _cli(db, monkeypatch, "--export", str(qid), "--out",
                str(tmp_path / "x.pdf")) == 1
    # mục khác loại đã duyệt (khối ceo) → sai loại
    tx = TxConn(db)
    pq = aq.enqueue(tx, object_type="change_request", object_id="p-1",
                    block="ceo", title="Hồ sơ", payload="Hồ sơ mẫu",
                    risk="high", created_by="agent:test", sla_hours=72)
    assert aq.decide(tx, pq, APPROVER, "approved")[0]
    pf = tmp_path / "p.md"
    pf.write_bytes("Hồ sơ mẫu".encode())
    assert aq.verify(tx, pq, "Hồ sơ mẫu") is True
    assert _cli(db, monkeypatch, "--verify-send", str(pq), str(pf)) == 1
    assert _cli(db, monkeypatch, "--export", str(pq), "--out",
                str(tmp_path / "p2.md")) == 1
    assert _cli(db, monkeypatch, "--verify-send", "999999999", str(md)) == 1


def test_db_rejected_not_sendable(db, keys, monkeypatch, capsys, tmp_path):
    _cogs(db, H1, 300000)
    rid = _request(db, keys, [{"key": H1, "qty": 20}])
    assert _cli(db, monkeypatch, "--quote", str(rid), "--submit", "--date",
                "2026-10-12", "--out-dir", str(tmp_path)) == 0
    qid = _items(db)[0][0]
    assert aq.decide(TxConn(db), qid, APPROVER, "rejected")[0]
    draft = next(tmp_path.glob("bao-gia-*[0-9a-f].md"))
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(draft)) == 1
    assert _cli(db, monkeypatch, "--export", str(qid), "--out",
                str(tmp_path / "r.md")) == 1


def test_kb_filter_sees_no_alcohol_in_real_quote():
    _, b = _built([{"key": H1, "qty": 20}], [_v(H1, 300000)],
                  golden=GOLD_REAL)
    assert not kb_filter.is_alcohol(b["payload"])
    assert not kb_filter.is_alcohol(kq.render_html(b["payload"]))


# ---------------------------------------------------------- suite kd_a3
def test_kd_a3_suite_pass_and_planted_failure_exit(tmp_path, monkeypatch,
                                                     capsys):
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    import agent_eval as ae

    suite = ae.load_suite("kd_a3")
    assert len(suite["cases"]) >= 12 and suite["status"] == "active"
    assert suite["frozen"] is False and suite["labeled_by"] is None
    res = ae.run_kd_a3(suite["cases"])
    assert ae.score(res, suite["threshold"])["passed"] is True
    assert ae.run_kd_a3(suite["cases"]) == res          # tất định ×2
    # cấy lỗi: đổi expect 1 ca bẫy trong bản tmp → suite FAIL, exit ≠ 0
    bad = copy.deepcopy(suite)
    case = next(c for c in bad["cases"] if c["kind"] == "trap_hard")
    case.update(expect="within_matrix", expect_reasons=[])
    case.pop("expect_code")
    bad["cases_sha256"] = ae.sha256_json(bad["cases"])
    (tmp_path / "kd_a3.json").write_bytes(
        json.dumps(bad, ensure_ascii=False).encode("utf-8"))
    monkeypatch.setattr(ae, "SUITES_DIR", tmp_path)
    assert ae.main(["--agent", "kd_a3", "--no-record"]) != 0
    assert "FAIL" in capsys.readouterr().out
