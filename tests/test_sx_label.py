"""v12.3 SX — `agents/sx_label.py` (đối soát nhãn ↔ golden/hồ sơ lô/listing).

Phần thuần (chuẩn hóa, trích field, so, payload, luật config) không DB, không
đồng hồ (today truyền vào). Phần DB: schema tạm trong 1 transaction, ROLLBACK
cuối test (`kd_db`/`TxConn` dùng lại từ test_kd_listing). Dữ liệu nhãn GIẢ
LẬP. SKU nhóm hạn chế: payload không được lộ sku_key/tên.
"""

import copy
import datetime as dt
import json
import re
import uuid
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

from agents import sx_label as sx
from ingest import doc_intake
from pipelines import director, guardrail
from tests.test_kd_listing import TxConn, kd_db

ROOT = Path(__file__).resolve().parent.parent
TODAY = dt.date(2026, 10, 12)
RULES = sx.load_rules()
GOLDEN = {s["sku_key"]: s for s in json.loads(
    (ROOT / "data" / "golden_skus.json").read_text(encoding="utf-8"))["skus"]}
SAP = {k: GOLDEN["saphraton-20v"][k] for k in
       ("sku_key", "name", "category", "pack_spec", "receipt_no")}
RUOU_KEY = "ruou-sam-chai-thuy-tinh-500ml"
RUOU = {k: GOLDEN[RUOU_KEY][k] for k in
        ("sku_key", "name", "category", "pack_spec", "receipt_no")}
MO = {k: GOLDEN["mat-ong-sam-120ml-1hu"][k] for k in
      ("sku_key", "name", "category", "pack_spec", "receipt_no")}
GOOD = ("THỰC PHẨM BẢO VỆ SỨC KHỎE\nSAPHRATON\n"
        "Hộp 20 viên nang mềm (2 vỉ x 10 viên)\n"
        "Số ĐKSP: 2778/2018/ĐKSP\n"
        "Thực phẩm này không phải là thuốc, không có tác dụng thay thế "
        "thuốc chữa bệnh.\nSố lô: SAP-260901\n"
        "NSX: 01/09/2026   HSD: 01/09/2028\n")
LOT_OK = {"SAP-260901": {"sku_key": "saphraton-20v",
                         "mfg_date": dt.date(2026, 9, 1),
                         "exp_date": dt.date(2028, 9, 1),
                         "intake_status": "passed"}}
LISTING_OK = [{"channel": "shopee", "item_id": "24825885894",
               "title": "Saphraton 20 viên nang mềm"}]


def kinds(text, sku=SAP, listings=(), lots=None, today=TODAY, rules=RULES):
    f = sx.extract(text)
    return [x["kind"] for x in sx.compare(f, sku, rules, list(listings),
                                          lots or {}, today)]


# ---------------------------------------------------------------- chuẩn hóa / trích

def test_low_flat_fold_diacritics_and_d():
    assert sx.low("ĐKSP Ðksp Sức Khỏe") == "dksp dksp suc khoe"
    assert sx.flat("Thuốc, chữa—bệnh!!") == " thuoc chua benh "
    # NFD đầu vào (OCR hay trả) vẫn khớp như NFC
    assert sx.flat("khoẻ") == sx.flat("khỏe")


def test_extract_full_label():
    f = sx.extract(GOOD)
    assert f["dksp"] == ["2778/2018/ĐKSP"]
    assert f["qty"] == ["10 viên", "20 viên"]
    assert f["nsx"] == [dt.date(2026, 9, 1)]
    assert f["hsd"] == [dt.date(2028, 9, 1)]
    assert f["lots"] == ["SAP-260901"] and f["hsd_months"] == []
    assert "GOOD" not in json.dumps(f, default=str)


@pytest.mark.parametrize("text,key,want", [
    ("HSD: 24 tháng kể từ NSX", "hsd_months", [24]),
    ("Hạn sử dụng 2 năm", "hsd_months", [24]),
    ("NSX 01.09.26 HSD 01-09-28", "hsd", [dt.date(2028, 9, 1)]),
    ("NSX 01.09.26", "nsx", [dt.date(2026, 9, 1)]),
    ("HSD: 31/02/2028", "hsd", []),                 # ngày không tồn tại
    ("HSD: 01/13/2028", "hsd", []),
    ("export 01/09/2028", "hsd", []),               # 'exp' trong từ khác
    ("Số lô: xem trên bao bì", "lots", []),         # mã không có chữ số
    ("Lot no: ab-12", "lots", ["AB-12"]),
    ("Batch: 7", "lots", []),                       # < 3 ký tự
    ("Số tự công bố: 01/SAMSAM/2023", "tu_cong_bo", ["01/SAMSAM/2023"]),
    ("Giá 1.500 ml", "qty", []),                    # số sau dấu chấm
    ("500ml", "qty", ["500 ml"]),
    ("2 vỉ x 10 v", "qty", ["10 viên"]),
    ("8014 / 2021 / Ðksp", "dksp", ["8014/2021/ĐKSP"]),
    ("98014/2021/ĐKSPX", "dksp", []),
])
def test_extract_boundaries(text, key, want):
    assert sx.extract(text)[key] == want


def test_name_tokens_ignore_digits_and_generic():
    assert sx.name_tokens("Combo Saphraton 2 hộp x 20 viên",
                          RULES["name_ignore"]) == ["saphraton", "vien"]
    assert sx.name_tokens("Mật ong sâm 120ml (1 hũ)",
                          RULES["name_ignore"]) == ["mat", "ong", "sam", "hu"]


# ---------------------------------------------------------------- so

def test_compare_clean_label_no_findings():
    assert kinds(GOOD, listings=LISTING_OK, lots=LOT_OK) == []


@pytest.mark.parametrize("mutate,want", [
    (lambda t: t.replace("SAPHRATON", "SAVINA"), "ten_thieu_tu"),
    (lambda t: t.replace("THỰC PHẨM BẢO VỆ SỨC KHỎE", ""), "bat_buoc_thieu"),
    (lambda t: t.replace("không phải là thuốc", "x"), "bat_buoc_thieu"),
    (lambda t: t.replace("Số ĐKSP: 2778/2018/ĐKSP", ""), "dang_ky_thieu"),
    (lambda t: t.replace("2778/2018", "2778/2019"), "dang_ky_lech"),
    (lambda t: t.replace("20 viên", "30 viên"), "quy_cach_lech"),
    (lambda t: t.replace("HSD: 01/09/2028", ""), "hsd_thieu"),
    (lambda t: t + "HSD: 01/10/2028\n", "ngay_nhieu"),
    (lambda t: t.replace("01/09/2028", "01/08/2026"), "hsd_truoc_nsx"),
    (lambda t: t.replace("01/09/2028", "11/10/2026"), "het_han"),
    (lambda t: t.replace("SAP-260901", "SAP-999999"), "lo_khong_ho_so"),
    (lambda t: t.replace("NSX: 01/09/2026", "NSX: 02/09/2026"),
     "lo_nsx_lech"),
    (lambda t: t.replace("01/09/2028", "02/09/2028"), "lo_hsd_lech"),
    (lambda t: t + "Độ cồn 29%\n", "nhom_lech"),
])
def test_compare_each_kind(mutate, want):
    got = kinds(mutate(GOOD), listings=LISTING_OK, lots=LOT_OK)
    assert want in got, got


def test_compare_hsd_today_not_expired_boundary():
    t = GOOD.replace("01/09/2028", "12/10/2026")
    assert "het_han" not in kinds(t, lots={})
    t = GOOD.replace("01/09/2028", "11/10/2026")
    assert "het_han" in kinds(t, lots={})


def test_compare_hsd_months_is_enough():
    t = GOOD.replace("HSD: 01/09/2028", "HSD: 24 tháng kể từ NSX")
    assert kinds(t, lots=LOT_OK) == []


def test_compare_lot_other_sku_and_not_passed():
    other = {"SAP-260901": {**LOT_OK["SAP-260901"], "sku_key": "savina-12v"}}
    got = kinds(GOOD, lots=other)
    assert got == ["lo_khac_sku"]       # khác SKU → không so ngày nữa
    pend = {"SAP-260901": {**LOT_OK["SAP-260901"],
                           "intake_status": "pending"}}
    assert kinds(GOOD, lots=pend) == ["lo_chua_kiem"]


def test_compare_golden_receipt_missing_or_garbled():
    for rec in (None, "", "đang chờ"):
        got = kinds(GOOD, sku={**SAP, "receipt_no": rec}, lots=LOT_OK)
        assert got == ["dang_ky_golden_thieu"], rec


def test_compare_golden_spec_none_skips_qty():
    assert kinds(GOOD.replace("20 viên", "33 viên"),
                 sku={**SAP, "pack_spec": None}, lots=LOT_OK) == []


def test_compare_listing_rules():
    bad = [{"channel": "tiktok", "item_id": "x\x1b[2J",
            "title": "Saphraton 30 viên"},
           {"channel": "shopee", "item_id": "1", "title": "Saphraton"},
           {"channel": "shopee", "item_id": "2", "title": None}]
    f = sx.compare(sx.extract(GOOD), SAP, RULES, bad, LOT_OK, TODAY)
    assert [x["kind"] for x in f] == ["listing_quy_cach_lech"]
    assert "(mã lạ)" in f[0]["msg"] and "\x1b" not in f[0]["msg"]
    # nhãn không đọc được quy cách → chỉ quy_cach_lech, không so listing
    t = GOOD.replace("Hộp 20 viên nang mềm (2 vỉ x 10 viên)", "")
    got = kinds(t, listings=bad, lots=LOT_OK)
    assert "quy_cach_lech" in got and "listing_quy_cach_lech" not in got


def test_compare_food_requires_self_declaration_number():
    t = "MẬT ONG SÂM\n120ml x 1 hũ\nHSD: 18 tháng\n"
    assert kinds(t, sku=MO) == ["dang_ky_thieu"]
    assert kinds(t + "Số tự công bố: 01/SS/2024\n", sku=MO) == []
    assert "nhom_lech" in kinds(t + "Thực phẩm bảo vệ sức khỏe\n", sku=MO)


def test_compare_alcohol_required_warnings():
    t = "RƯỢU SÂM CHAI THỦY TINH\n500ml\nĐộ cồn 29%\nHSD: 10 năm\n" \
        "Số tự công bố: 02/SS/2024\n"
    assert kinds(t, sku=RUOU) == ["bat_buoc_thieu"]
    assert kinds(t + "Không dùng cho người dưới 18 tuổi\n", sku=RUOU) == []


def test_compare_does_not_copy_free_label_text():
    t = GOOD + "Chữa bách bệnh, uống là khỏi bệnh 0912345678\n"
    f = sx.compare(sx.extract(t), SAP, RULES, [], {}, TODAY)
    blob = json.dumps(f, ensure_ascii=False)
    assert "bách" not in blob and "0912345678" not in blob


# ---------------------------------------------------------------- payload

def _payload(sku, text, lots=None):
    f = sx.compare(sx.extract(text), sku, RULES, [], lots or {}, TODAY)
    return f, sx.payload_of(sku, f, "ab" * 32)


def test_payload_alcohol_hides_sku_and_passes_guardrail():
    f, (oid, title, payload) = _payload(RUOU, "Nhãn trắng")
    assert len(f) >= 3
    ref = sx.sku_ref(RUOU)
    assert re.fullmatch(r"H-[0-9a-f]{8}", ref)
    for s in (oid, title, payload):
        assert RUOU_KEY not in s and "ruou" not in sx.low(s)
        assert ref in s
    assert guardrail.check(payload)["ok"] and guardrail.check(title)["ok"]
    assert "chi tiết bị ẩn" not in payload and f"{len(f)} điểm lệch" in title


@pytest.mark.parametrize("key", sorted(GOLDEN))
def test_payload_every_golden_sku_blank_label_guardrail_ok(key):
    sku = {k: GOLDEN[key][k] for k in SAP}
    f, (_oid, _title, payload) = _payload(sku, "nhãn trắng")
    assert f and guardrail.check(payload)["ok"]
    assert "chi tiết bị ẩn" not in payload        # không cần bản rút gọn


def test_payload_with_marker_mismatch_guardrail_ok():
    f, (_o, _t, payload) = _payload(SAP, GOOD + "rượu, độ cồn\n", LOT_OK)
    assert [x["kind"] for x in f] == ["nhom_lech"]
    assert guardrail.check(payload)["ok"] and "rượu" not in payload


def test_payload_fallback_when_guardrail_fails():
    bad = [{"kind": "x", "msg": "khỏi bệnh ngay"}]
    oid, _t, payload = sx.payload_of(SAP, bad, "cd" * 32)
    assert "khỏi bệnh" not in payload and "chi tiết bị ẩn" in payload
    assert guardrail.check(payload)["ok"] and oid.startswith("sxlabel:")


def test_payload_object_id_episodes():
    f = [{"kind": "a", "msg": "m"}]
    a = sx.payload_of(SAP, f, "ab" * 32)[0]
    assert a == sx.payload_of(SAP, copy.deepcopy(f), "ab" * 32)[0]
    assert a != sx.payload_of(SAP, f, "ac" * 32)[0]         # nhãn khác
    assert a != sx.payload_of(SAP, f + f, "ab" * 32)[0]     # phát hiện khác
    assert a.startswith("sxlabel:saphraton-20v:abababababab:")


# ---------------------------------------------------------------- config

def test_rules_repo_file():
    assert "GIẢ ĐỊNH" in RULES["status"]
    assert RULES["registration"]["tpbvsk"] == "dksp"
    assert {i["id"] for i in RULES["required"]["tpbvsk"]} >= {
        "khuyen_cao_1", "khuyen_cao_2"}


def _rules_variant(kind):
    d = json.loads((ROOT / "data" / "label_rules.json")
                   .read_text(encoding="utf-8"))
    if kind == "no_status":
        del d["status"]
    elif kind == "missing_cat":
        del d["required"]["food"]
    elif kind == "bad_reg":
        d["registration"]["food"] = "xyz"
    elif kind == "unsafe_label":
        d["required"]["tpbvsk"][0]["label"] = "giúp điều trị bệnh"
    elif kind == "dup_id":
        d["required"]["tpbvsk"][1]["id"] = d["required"]["tpbvsk"][0]["id"]
    elif kind == "empty_phrase":
        d["required"]["tpbvsk"][0]["phrase"] = " ,. "
    elif kind == "markers_not_list":
        d["markers"]["alcohol"] = "độ cồn"
    elif kind == "marker_unknown_cat":
        d["markers"]["thuoc"] = ["x"]
    elif kind == "ignore_not_list":
        d["name_ignore"] = "combo"
    elif kind == "item_not_obj":
        d["required"]["food"] = ["x"]
    return json.dumps(d, ensure_ascii=False)


@pytest.mark.parametrize("kind", [
    "missing", "empty", "broken", "obj_empty", "only_doc", "not_obj",
    "no_status", "missing_cat", "bad_reg", "unsafe_label", "dup_id",
    "empty_phrase", "markers_not_list", "marker_unknown_cat",
    "ignore_not_list", "item_not_obj", "bad_utf8"])
def test_rules_variants_rejected(tmp_path, kind):
    p = tmp_path / "r.json"
    raw = {"empty": "  ", "broken": "{\"status\": ", "obj_empty": "{}",
           "only_doc": "{\"_doc\": \"x\"}", "not_obj": "[1]"}.get(kind)
    if kind == "bad_utf8":
        p.write_bytes(b"\xff\xfe{")
    elif kind != "missing":
        p.write_bytes((raw or _rules_variant(kind)).encode("utf-8"))
    with pytest.raises(sx.LabelError):
        sx.load_rules(p)


def test_rules_from_data_not_hardcoded(tmp_path):
    d = json.loads((ROOT / "data" / "label_rules.json")
                   .read_text(encoding="utf-8"))
    d["required"]["food"] = [{"id": "nguon_goc", "phrase": "xuất xứ",
                              "label": "dòng xuất xứ"}]
    p = tmp_path / "r.json"
    p.write_bytes(json.dumps(d, ensure_ascii=False).encode("utf-8"))
    rules = sx.load_rules(p)
    t = "MẬT ONG SÂM\n120ml x 1 hũ\nHSD: 18 tháng\nSố tự công bố: 01/SS/24\n"
    assert kinds(t, sku=MO, rules=rules) == ["bat_buoc_thieu"]


# ---------------------------------------------------------------- CLI không DB

@pytest.fixture
def no_db(monkeypatch):
    calls = {"connect": 0}

    def fake():
        calls["connect"] += 1

    monkeypatch.setattr(sx, "connect", fake)
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    return calls


def _label(tmp_path, text=GOOD, name="n.txt"):
    p = tmp_path / name
    p.write_bytes(text.encode("utf-8") if isinstance(text, str) else text)
    return p


@pytest.mark.parametrize("argv", [
    [], ["--sku", "saphraton-20v"],
    ["--text", "a.txt"],
    ["--sku", "saphraton-20v", "--text", "a.txt", "--image", "b.png"],
    ["--sku", "Bad SKU!", "--text", "a.txt"],
    ["--sku", "a" * 65, "--text", "a.txt"],
])
def test_cli_usage_exit2(argv, no_db):
    with pytest.raises(SystemExit) as e:
        sx.main(argv)
    assert e.value.code == 2 and no_db["connect"] == 0


@pytest.mark.parametrize("content", ["", "  \n\t", b"\xff\xfeabc",
                                     b"x" * (sx.MAX_TEXT_BYTES + 1), None],
                         ids=["empty", "blank", "bad_utf8", "too_big",
                              "missing"])
def test_cli_bad_text_file_exit1_no_connect(tmp_path, no_db, capsys, content):
    p = tmp_path / "missing.txt" if content is None else _label(tmp_path,
                                                                 content)
    assert sx.main(["--sku", "saphraton-20v", "--text", str(p)]) == 1
    assert no_db["connect"] == 0
    assert "không connect" in capsys.readouterr().err


def test_cli_image_provider_none_exit2_with_guidance(tmp_path, no_db, capsys):
    p = _label(tmp_path, b"\x89PNG", "n.png")
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    err = capsys.readouterr().err
    assert "OCR_PROVIDER" in err and "--text" in err
    assert no_db["connect"] == 0


def test_cli_image_unknown_or_foreign_provider_exit2(tmp_path, no_db,
                                                     monkeypatch):
    p = _label(tmp_path, b"\x89PNG", "n.png")
    monkeypatch.setenv("OCR_PROVIDER", "google_vision")
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    called = []
    monkeypatch.setitem(doc_intake.PROVIDERS, "ngoai",
                        (lambda _p: called.append(1) or "x", False))
    monkeypatch.setenv("OCR_PROVIDER", "ngoai")
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    assert called == [] and no_db["connect"] == 0     # không gửi ảnh ra ngoài


def test_cli_image_bad_ext_or_missing_exit1(tmp_path, no_db, monkeypatch):
    monkeypatch.setitem(doc_intake.PROVIDERS, "trongnuoc",
                        (lambda _p: GOOD, True))
    monkeypatch.setenv("OCR_PROVIDER", "trongnuoc")
    p = _label(tmp_path, b"x", "n.gif")
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 1
    assert sx.main(["--sku", "saphraton-20v", "--image",
                    str(tmp_path / "khong.png")]) == 1
    assert no_db["connect"] == 0


def test_cli_image_domestic_ocr_reaches_db(tmp_path, no_db, monkeypatch,
                                           capsys):
    monkeypatch.setitem(doc_intake.PROVIDERS, "trongnuoc",
                        (lambda _p: GOOD, True))
    monkeypatch.setenv("OCR_PROVIDER", "trongnuoc")
    p = _label(tmp_path, b"\x89PNG", "n.jpg")
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    assert no_db["connect"] == 1            # DB down (connect → None)
    monkeypatch.setitem(doc_intake.PROVIDERS, "trongnuoc",
                        (lambda _p: "   ", True))
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 1
    assert no_db["connect"] == 1


def test_cli_pdf_text_layer_without_ocr_ok(tmp_path, no_db, monkeypatch):
    p = _label(tmp_path, b"%PDF-1.4", "n.pdf")
    monkeypatch.setattr(doc_intake, "extract_text",
                        lambda _p, _prov: (GOOD, 1, "pdf_text"))
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    assert no_db["connect"] == 1
    monkeypatch.setattr(doc_intake, "extract_text",
                        lambda _p, _prov: ("", 1, "none"))
    assert sx.main(["--sku", "saphraton-20v", "--image", str(p)]) == 2
    assert no_db["connect"] == 1            # PDF scan + provider none


def test_cli_bad_rules_exit1_no_connect(tmp_path, no_db, monkeypatch):
    bad = tmp_path / "r.json"
    bad.write_bytes(b"{}")
    monkeypatch.setattr(sx, "RULES_FILE", bad)
    assert sx.main(["--sku", "saphraton-20v", "--text",
                    str(_label(tmp_path))]) == 1
    assert no_db["connect"] == 0


def test_no_llm_no_write_sql_grep():
    src = (ROOT / "agents" / "sx_label.py").read_text(encoding="utf-8")
    assert not re.search(r"llm_gateway|openai|requests\.|httpx", src)
    assert not re.search(r"\b(insert|update|delete)\s+(into\s+)?\w+",
                         src, re.IGNORECASE)


# ---------------------------------------------------------------- DB

@pytest.fixture
def db():
    yield from kd_db()


def _seed(conn):
    for s in (SAP, RUOU):
        conn.execute("insert into sku_master (sku_key, name, category,"
                     " pack_spec, receipt_no, source) values"
                     " (%s, %s, %s, %s, %s, 'manual')",
                     (s["sku_key"], s["name"], s["category"],
                      s["pack_spec"], s["receipt_no"]))
    for i, (title, sku) in enumerate([("Saphraton 30 viên", "saphraton-20v"),
                                      ("Khác 12 viên", "savina-12v")]):
        sid = conn.execute(
            "insert into market_snapshots (channel, export_kind, file_name,"
            " file_sha256, row_count) values ('shopee', 'listing', 'l.csv',"
            " %s, 1) returning id", (uuid.uuid4().hex,)).fetchone()[0]
        conn.execute(
            "insert into market_rows (snapshot_id, row_no, channel,"
            " export_kind, item_id, sku_key, title, raw) values (%s, 2,"
            " 'shopee', 'listing', %s, %s, %s, '{}')",
            (sid, str(100 + i), sku, title))
    conn.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
                 " exp_date, qty, source) values ('SAP-260901',"
                 " 'saphraton-20v', '2026-09-01', '2028-09-01', 5, 'sample')")


def _queue(conn):
    return conn.execute("select object_type, object_id, block, risk, title,"
                        " payload, status from approval_queue order by id"
                        ).fetchall()


@pytest.fixture
def live(db, monkeypatch):
    _seed(db)
    proxy = TxConn(db)
    monkeypatch.setattr(sx, "connect", lambda: proxy)
    return db


def test_db_dry_run_reads_latest_listing_and_lot_writes_nothing(
        live, tmp_path, capsys):
    p = _label(tmp_path)
    assert sx.main(["--sku", "saphraton-20v", "--text", str(p)]) == 0
    out = capsys.readouterr().out
    # snapshot listing MỚI NHẤT của shopee chỉ có dòng savina → không lệch
    # listing; lô pending → lo_chua_kiem
    assert "[lo_chua_kiem]" in out and "listing_quy_cach_lech" not in out
    assert "[dry]" in out and _queue(live) == []
    assert "không phải là thuốc" not in out       # không in nguyên văn nhãn


def test_db_submit_once_per_episode(live, tmp_path, capsys):
    live.execute("update production_lots set intake_status = 'passed',"
                 " checked_by = 'QA test', checked_at = now()")
    p = _label(tmp_path, GOOD.replace("20 viên", "30 viên"))
    argv = ["--sku", "saphraton-20v", "--text", str(p), "--submit"]
    assert sx.main(argv) == 0
    q = _queue(live)
    assert len(q) == 1
    ot, oid, block, risk, _title, payload, status = q[0]
    cfg = director.load_config("production")
    assert (ot, block, status) == ("label_check", "production", "pending")
    assert risk == cfg["object_types"]["label_check"]["risk"]
    assert oid.startswith("sxlabel:saphraton-20v:")
    assert "quy cách" in payload and guardrail.check(payload)["ok"]
    assert sx.main(argv) == 0                     # cùng đợt → bỏ qua
    assert len(_queue(live)) == 1
    assert "[skip]" in capsys.readouterr().out
    p.write_bytes(GOOD.replace("20 viên", "40 viên").encode("utf-8"))
    assert sx.main(argv) == 0                     # nhãn khác → đợt mới
    assert len(_queue(live)) == 2


def test_db_clean_label_submit_enqueues_nothing(live, tmp_path, capsys):
    live.execute("update production_lots set intake_status = 'passed',"
                 " checked_by = 'QA test', checked_at = now()")
    assert sx.main(["--sku", "saphraton-20v", "--text",
                    str(_label(tmp_path)), "--submit"]) == 0
    assert "[ok]" in capsys.readouterr().out and _queue(live) == []


def test_db_alcohol_submit_hides_sku(live, tmp_path, capsys):
    p = _label(tmp_path, "Nhãn chai 500ml\n")
    assert sx.main(["--sku", RUOU_KEY, "--text", str(p), "--submit"]) == 0
    out = capsys.readouterr().out
    ref = sx.sku_ref(RUOU)
    assert f"{RUOU_KEY} → mã tra cứu {ref}" in out
    (_ot, oid, _b, _r, title, payload, _s), = _queue(live)
    for s in (oid, title, payload):
        assert RUOU_KEY not in s and ref in s
    assert guardrail.check(payload)["ok"]


def test_db_unknown_sku_exit1(live, tmp_path):
    assert sx.main(["--sku", "khong-co", "--text",
                    str(_label(tmp_path))]) == 1
    assert _queue(live) == []


def test_db_listing_mismatch_from_latest_snapshot(live, tmp_path, capsys):
    sid = live.execute(
        "insert into market_snapshots (channel, export_kind, file_name,"
        " file_sha256, row_count, imported_at) values ('tiktok', 'listing',"
        " 't.csv', %s, 1, now() + interval '1 minute') returning id",
        (uuid.uuid4().hex,)).fetchone()[0]
    live.execute("insert into market_rows (snapshot_id, row_no, channel,"
                 " export_kind, item_id, sku_key, title, raw) values"
                 " (%s, 2, 'tiktok', 'listing', 'T1', 'saphraton-20v',"
                 " 'Saphraton 40 viên', %s)", (sid, Jsonb({})))
    assert sx.main(["--sku", "saphraton-20v", "--text",
                    str(_label(tmp_path))]) == 0
    out = capsys.readouterr().out
    assert "[listing_quy_cach_lech] listing tiktok mã T1 ghi 40 viên" in out
