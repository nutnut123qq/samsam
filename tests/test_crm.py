"""v5.2 — CRM lead & đại lý (ingest/crm.py): contact_vault mã hóa, HMAC
tra trùng, đồng ý theo mục đích, tỉnh 34 + vùng + đại lý, gán lead,
trạng thái, report không PII, handoff đích danh (WP07 acceptance (1)(5)).

DB thật: schema tạm `t_crm_<hex>` + ROLLBACK (mẫu test_auth_approval) —
không để lại dòng nào trong public.
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import uuid
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest
from cryptography.fernet import Fernet
from psycopg.errors import CheckViolation, InsufficientPrivilege

from ingest import crm
from pipelines.pii import _PII_RE

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
CASES = json.loads((ROOT / "tests" / "fixtures" / "crm_province_cases.json")
                   .read_bytes().decode("utf-8"))["cases"]

# 63 tỉnh/thành CŨ (trước 01/7/2025) → tỉnh mới — GIẢ ĐỊNH NQ 202/2025/QH15,
# viết độc lập với file data (không đọc từ file).
OLD63 = {
    "An Giang": "An Giang", "Bà Rịa - Vũng Tàu": "TP. Hồ Chí Minh",
    "Bạc Liêu": "Cà Mau", "Bắc Giang": "Bắc Ninh", "Bắc Kạn": "Thái Nguyên",
    "Bắc Ninh": "Bắc Ninh", "Bến Tre": "Vĩnh Long",
    "Bình Dương": "TP. Hồ Chí Minh", "Bình Định": "Gia Lai",
    "Bình Phước": "Đồng Nai", "Bình Thuận": "Lâm Đồng", "Cà Mau": "Cà Mau",
    "Cao Bằng": "Cao Bằng", "Cần Thơ": "Cần Thơ", "Đà Nẵng": "Đà Nẵng",
    "Đắk Lắk": "Đắk Lắk", "Đắk Nông": "Lâm Đồng", "Điện Biên": "Điện Biên",
    "Đồng Nai": "Đồng Nai", "Đồng Tháp": "Đồng Tháp", "Gia Lai": "Gia Lai",
    "Hà Giang": "Tuyên Quang", "Hà Nam": "Ninh Bình", "Hà Nội": "Hà Nội",
    "Hà Tĩnh": "Hà Tĩnh", "Hải Dương": "Hải Phòng", "Hải Phòng": "Hải Phòng",
    "Hậu Giang": "Cần Thơ", "Hòa Bình": "Phú Thọ", "Hưng Yên": "Hưng Yên",
    "Khánh Hòa": "Khánh Hòa", "Kiên Giang": "An Giang",
    "Kon Tum": "Quảng Ngãi", "Lai Châu": "Lai Châu", "Lâm Đồng": "Lâm Đồng",
    "Lạng Sơn": "Lạng Sơn", "Lào Cai": "Lào Cai", "Long An": "Tây Ninh",
    "Nam Định": "Ninh Bình", "Nghệ An": "Nghệ An", "Ninh Bình": "Ninh Bình",
    "Ninh Thuận": "Khánh Hòa", "Phú Thọ": "Phú Thọ", "Phú Yên": "Đắk Lắk",
    "Quảng Bình": "Quảng Trị", "Quảng Nam": "Đà Nẵng",
    "Quảng Ngãi": "Quảng Ngãi", "Quảng Ninh": "Quảng Ninh",
    "Quảng Trị": "Quảng Trị", "Sóc Trăng": "Cần Thơ", "Sơn La": "Sơn La",
    "Tây Ninh": "Tây Ninh", "Thái Bình": "Hưng Yên",
    "Thái Nguyên": "Thái Nguyên", "Thanh Hóa": "Thanh Hóa",
    "Thừa Thiên Huế": "Huế", "Tiền Giang": "Đồng Tháp",
    "TP. Hồ Chí Minh": "TP. Hồ Chí Minh", "Trà Vinh": "Vĩnh Long",
    "Tuyên Quang": "Tuyên Quang", "Vĩnh Long": "Vĩnh Long",
    "Vĩnh Phúc": "Phú Thọ", "Yên Bái": "Lào Cai",
}

PHONE = "0905123456"
PERSON = {"phone": "0905 123 456", "name": "Nguyễn Văn Mẫu",
          "email": "mau@example.com", "address": "12 Lê Duẩn",
          "province": "Quảng Nam"}
PII_NEEDLES = ("0905123456", "905123456", "Nguyễn", "Mẫu", "mau@example",
               "Lê Duẩn")


@pytest.fixture
def keys():
    return crm.load_vault_key({"CONTACT_VAULT_KEY":
                               Fernet.generate_key().decode()})


# ================================================================ unit
@pytest.mark.parametrize("raw", ["0905 123 456", "+84 905.123.456",
                                 "84905123456", "(0905) 123-456",
                                 "+84 0905 123 456", "840905123456",
                                 "(+84) 0905123456", "+84 (0) 905 123 456",
                                 "+84 0905123456", "84 0905123456"])
def test_normalize_phone_variants(raw):
    assert crm.normalize_phone(raw) == PHONE


@pytest.mark.parametrize("raw", ["12345", "0905abc", "", None, 905123456,
                                 "0" * 50, "0905-12x-98765",
                                 "0905123456 ext", "++84905123456",
                                 "00905123456", "0090 5123 456",
                                 "0084 905123456",
                                 "0905\u2028123456", "0905\x85123456",
                                 "٠٩٠٥123456"])
def test_normalize_phone_bad_no_echo(raw):
    with pytest.raises(ValueError) as e:
        crm.normalize_phone(raw)
    assert not re.search(r"\d{3,}", str(e.value))


def test_phone_lookup_keyed_hmac():
    k1 = crm.load_vault_key({"CONTACT_VAULT_KEY":
                             Fernet.generate_key().decode()})[1]
    k2 = crm.load_vault_key({"CONTACT_VAULT_KEY":
                             Fernet.generate_key().decode()})[1]
    h1, h2 = crm.phone_lookup(PHONE, k1), crm.phone_lookup(PHONE, k2)
    assert h1 != h2
    assert h1 != hashlib.sha256(PHONE.encode()).hexdigest()
    assert re.fullmatch(r"[0-9a-f]{64}", h1)
    assert crm.phone_lookup(PHONE, k1) == h1          # tất định


@pytest.mark.parametrize("env", [{}, {"CONTACT_VAULT_KEY": ""},
                                 {"CONTACT_VAULT_KEY": "   "},
                                 {"CONTACT_VAULT_KEY": "not-a-key"},
                                 {"CONTACT_VAULT_KEY": "khóa-có-dấu"}])
def test_load_vault_key_rejects(env):
    with pytest.raises(crm.VaultKeyError) as e:
        crm.load_vault_key(env)
    assert "not-a-key" not in str(e.value)
    assert "khóa-có-dấu" not in str(e.value)


def test_seal_unseal_roundtrip_and_wrong_key(keys):
    f = keys[0]
    tok = crm.seal(f, "Nguyễn Văn Mẫu — 12 Lê Duẩn")
    assert tok.startswith("gAAAAA") and "Nguyễn" not in tok
    assert crm.unseal(f, tok) == "Nguyễn Văn Mẫu — 12 Lê Duẩn"
    assert crm.seal(f, None) is None and crm.seal(f, "  ") is None
    other = Fernet(Fernet.generate_key())
    with pytest.raises(crm.VaultKeyError):
        crm.unseal(other, tok)


# ---------------------------------------------------------------- tỉnh
def test_province_file_34_and_aliases():
    doc = json.loads((ROOT / "data" / "vn_provinces_2025.json")
                     .read_bytes().decode("utf-8"))
    assert doc["status"] == "gia_dinh" and "GIẢ ĐỊNH" in doc["_doc"]
    assert len(doc["provinces"]) == 34 == len(set(doc["provinces"]))
    assert set(doc["aliases"].values()) <= set(doc["provinces"])
    assert len(OLD63) == 63
    assert set(OLD63.values()) == set(doc["provinces"])


@pytest.mark.parametrize("old", sorted(OLD63))
def test_old_province_maps_to_new(old):
    assert crm.province_of(f"đại lý ở {old}") == OLD63[old]


def test_province_cases_fixture_100pct():
    assert len(CASES) >= 24
    wrong = [(t, exp, crm.province_of(t)) for t, exp in CASES
             if crm.province_of(t) != exp]
    assert not wrong, wrong


@pytest.mark.parametrize("text", ["", "   ", None, 123, "Việt Nam",
                                  "miền Nam", "hoa huệ", "sơn là"])
def test_province_none(text):
    assert crm.province_of(text) is None


# ---------------------------------------------------------------- vùng
def test_load_regions_repo_each_province_one_region():
    reg = crm.load_regions()
    assert set(reg["province_region"]) == set(crm.provinces())
    counts = {}
    for provs in reg["regions"].values():
        for p in provs:
            counts[p] = counts.get(p, 0) + 1
    assert set(counts.values()) == {1}
    codes = [d["code"] for d in reg["dealers"]]
    assert len(codes) >= 3
    dn = reg["province_region"]["Đà Nẵng"]
    assert {"DLM01", "DLM02"} <= {d["code"] for d in reg["dealers"]
                                  if d["region"] == dn}
    assert any(d["region"] != dn for d in reg["dealers"])
    doc = json.loads((ROOT / "data" / "dealer_regions.json")
                     .read_bytes().decode("utf-8"))
    assert doc["status"] == "mau" and not _PII_RE.search(json.dumps(doc))


def _mut_regions(tmp_path, fn):
    doc = json.loads((ROOT / "data" / "dealer_regions.json")
                     .read_bytes().decode("utf-8"))
    fn(doc)
    p = tmp_path / "r.json"
    p.write_bytes(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    return p


@pytest.mark.parametrize("fn,needle", [
    (lambda d: d["regions"]["MIEN_BAC"].append("Atlantis"), "ngoài 34"),
    (lambda d: d["regions"]["MIEN_BAC"].append("Đà Nẵng"), "đã thuộc vùng"),
    (lambda d: d["regions"]["MIEN_NAM"].remove("Cà Mau"),
     "không thuộc vùng nào"),
    (lambda d: d["dealers"][0].update({"region": "SAO_HOA"}), ".region"),
    (lambda d: d["dealers"][0].update({"code": "dl 01"}), ".code"),
    (lambda d: d["dealers"][0].update({"commission_default": 150}),
     ".commission_default"),
    (lambda d: d["dealers"][0].update({"commission_default": True}),
     ".commission_default"),
    (lambda d: d["dealers"][0].update({"status": "zombie"}), ".status"),
    (lambda d: d["dealers"].append(dict(d["dealers"][0])), "trùng"),
], ids=["tinh-la", "tinh-2-vung", "tinh-mo-coi", "vung-la", "code-sai",
        "hh-100+", "hh-bool", "status-la", "code-trung"])
def test_load_regions_rejects(tmp_path, fn, needle):
    with pytest.raises(ValueError) as e:
        crm.load_regions(_mut_regions(tmp_path, fn))
    assert needle in str(e.value)


def test_commission_rate():
    d = {"code": "DLM01", "status": "active", "commission_default": 10}
    assert crm.commission_rate(d, "alcohol", True) == 0
    assert crm.commission_rate(d, "alcohol", False) == Decimal(10)
    assert crm.commission_rate(d, None, False) == 0
    assert crm.commission_rate(d, "ruou", False) == 0
    assert crm.commission_rate(dict(d, status="paused"), "tpbvsk", True) == 0
    assert crm.commission_rate(d, "tpbvsk", True) == Decimal(10)
    assert crm.commission_rate(d, "food", True) == Decimal(10)


# ---------------------------------------------------------------- CLI (no DB)
@pytest.fixture
def no_db(monkeypatch):
    calls = []

    def boom():
        calls.append(1)
        raise AssertionError("connect không được gọi")
    monkeypatch.setattr(crm, "_connect", boom)
    monkeypatch.setattr(crm.lead_store, "connect", boom)
    return calls


def _stdin(monkeypatch, obj):
    raw = obj if isinstance(obj, bytes) else json.dumps(
        obj, ensure_ascii=False).encode("utf-8")
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(raw)))


def test_cli_add_contact_missing_key_exit2(monkeypatch, capsys, no_db):
    monkeypatch.setenv("CONTACT_VAULT_KEY", "")   # KHÔNG delenv (gotcha v2.0)
    _stdin(monkeypatch, PERSON)
    assert crm.main(["--add-contact", "-", "--by", "Lan"]) == 2
    out = capsys.readouterr().out
    assert "[err]" in out and "CONTACT_VAULT_KEY" in out
    assert not no_db


def test_cli_add_contact_bad_phone_no_echo(monkeypatch, capsys, no_db):
    monkeypatch.setenv("CONTACT_VAULT_KEY", Fernet.generate_key().decode())
    _stdin(monkeypatch, dict(PERSON, phone="0905-12x-9876543"))
    assert crm.main(["--add-contact", "-", "--by", "Lan"]) == 2
    out = capsys.readouterr().out
    assert "9876543" not in out and "Nguyễn" not in out and not no_db


@pytest.mark.parametrize("raw", [b"{", b"[1]", b"\xff\xfe", b"x" * 70000],
                         ids=["broken", "list", "not-utf8", "too-big"])
def test_cli_add_contact_bad_json_exit2(monkeypatch, capsys, no_db, raw):
    monkeypatch.setenv("CONTACT_VAULT_KEY", Fernet.generate_key().decode())
    _stdin(monkeypatch, raw)
    assert crm.main(["--add-contact", "-", "--by", "Lan"]) == 2
    assert not no_db


def test_cli_add_contact_file_inside_repo_refused(monkeypatch, capsys,
                                                  no_db):
    monkeypatch.setenv("CONTACT_VAULT_KEY", Fernet.generate_key().decode())
    assert crm.main(["--add-contact", str(ROOT / "data" /
                                          "dealer_regions.json"),
                     "--by", "Lan"]) == 2
    assert "NGOÀI repo" in capsys.readouterr().out and not no_db


@pytest.mark.parametrize("argv", [
    ["--report", "--assign", "1", "--dealer", "DLM01", "--by", "Lan"],
    ["--status", "1", "bogus", "--by", "Lan"],
    ["--status", "x", "won", "--by", "Lan"],
    ["--status", "²", "won", "--by", "Lan"],
    ["--status", "1", "won", "--by", ""],
    ["--status", "1", "won", "--by", "a" * 101],
    ["--status", "1", "won", "--by", "Lan\x07"],
    ["--status", "1", "won"],
    ["--consent", "1", "--purpose", "dai_ly", "--grant", "--source",
     "form_giay", "--evidence", "BB-1", "--policy-version", "v1",
     "--by", "Lan"],
    ["--consent", "1", "--purpose", "marketing", "--grant", "--source",
     "form_giay", "--by", "Lan"],
    ["--consent", "1", "--purpose", "cskh", "--withdraw", "--source", "web",
     "--dealer", "DLM01", "--by", "Lan"],
    ["--consent", "1", "--purpose", "cskh", "--source", "web", "--by", "Lan"],
    ["--assign", "1", "--by", "Lan"],
    ["--assign", "1", "--dealer", "0905123456 x", "--by", "Lan"],
    ["--report", "--by", "Lan"],
    ["--report", "--lead", "3"],
    ["--report", "--province", "Huế"],
    [],
], ids=["2-ops", "status-bogus", "status-lead-x", "status-lead-sup2",
        "by-rong", "by-101",
        "by-ctrl", "by-thieu", "dai-ly-no-dealer", "grant-no-evidence",
        "cskh-dealer", "no-grant-withdraw", "assign-no-dealer",
        "dealer-sai-mau", "report-by",
        "report-lead", "report-province", "no-op"])
def test_cli_usage_exit2_before_connect(argv, no_db, capsys):
    with pytest.raises(SystemExit) as e:
        crm.main(argv)
    assert e.value.code == 2 and not no_db


class _FakeConn:
    """Ghi lại SQL — report() chỉ được SELECT/WITH."""

    def __init__(self):
        self.sql = []

    def execute(self, sql, params=None):
        self.sql.append(sql)
        return self

    def fetchone(self):
        return (0,)

    def fetchall(self):
        return []


def test_report_select_only_fake_conn():
    fc = _FakeConn()
    out = crm.report(fc)
    assert fc.sql and all(re.match(r"\s*(select|with)\b", s, re.IGNORECASE)
                          for s in fc.sql), fc.sql
    assert "CRM" in out


def test_crm_not_egress():
    sys.path.insert(0, str(ROOT / "scripts"))
    import dpia_draft
    assert "ingest/crm.py" not in dpia_draft.egress_modules(ROOT)


def test_cli_db_down_exit1_no_hang():
    env = dict(os.environ,
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x",
               CONTACT_VAULT_KEY="", PYTHONIOENCODING="utf-8")
    p = subprocess.run([sys.executable, "-m", "ingest.crm", "--report"],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       check=False)
    assert p.returncode == 1, p.stdout + p.stderr
    assert "DB không truy cập được" in p.stdout.decode("utf-8")


# ================================================================ DB
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
        schema = f"t_crm_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _lead(conn, question, intent="order", key=None):
    return conn.execute(
        "insert into leads (dedup_key, ts, channel, user_hash, question, "
        "intent, source) values (%s, now(), 'zalo', 'uhash-crm-test', %s, %s, "
        "'conversations.jsonl') returning id",
        (key or f"t:{uuid.uuid4().hex}", question, intent)).fetchone()[0]


def _raises(conn, exc, sql, params=None):
    with pytest.raises(exc), conn.transaction():
        conn.execute(sql, params)


@pytest.fixture
def dealers(db):
    crm.load_dealers(db, crm.load_regions(), "Lan")
    return db


def test_schema_tables_view_constraints(db):
    names = {r[0] for r in db.execute(
        "select table_name from information_schema.tables "
        "where table_schema = current_schema()").fetchall()}
    assert {"contacts", "dealers", "consents", "v_consent_current"} <= names
    ncon = db.execute("select count(*) from pg_constraint where "
                      "conrelid = 'leads'::regclass and contype = 'f'"
                      ).fetchone()[0]
    assert ncon == 2                       # ×2 schema không nhân FK
    _raises(db, CheckViolation,
            "insert into contacts (phone_hmac, phone_enc, source, "
            "created_by) values (%s, '0905123456', 'manual', 'x')",
            ("a" * 64,))
    _raises(db, CheckViolation,
            "insert into contacts (phone_hmac, phone_enc, name_enc, source,"
            " created_by) values (%s, 'gAAAAAabc', 'Nguyễn', 'manual', 'x')",
            ("b" * 64,))
    _raises(db, CheckViolation,
            "insert into contacts (phone_hmac, phone_enc, source, "
            "created_by) values ('0905123456', 'gAAAAAabc', 'manual', 'x')")
    cid = db.execute(
        "insert into contacts (phone_hmac, phone_enc, source, created_by) "
        "values (%s, 'gAAAAAabc', 'manual', 'x') returning id",
        ("c" * 64,)).fetchone()[0]
    db.execute("insert into dealers (code, name, region, source) values "
               "('DLX', 'x', 'MIEN_TRUNG', 'manual')")
    _raises(db, CheckViolation,
            "insert into consents (contact_id, purpose, granted, source, "
            "recorded_by) values (%s, 'dai_ly', false, 'web', 'x')", (cid,))
    _raises(db, CheckViolation,
            "insert into consents (contact_id, purpose, granted, "
            "recipient_dealer, source, recorded_by) values "
            "(%s, 'cskh', false, 'DLX', 'web', 'x')", (cid,))
    _raises(db, CheckViolation,
            "insert into consents (contact_id, purpose, granted, source, "
            "policy_version, recorded_by) values "
            "(%s, 'marketing', true, 'web', 'v1', 'x')", (cid,))
    db.execute("insert into consents (contact_id, purpose, granted, source, "
               "recorded_by) values (%s, 'marketing', false, 'web', 'x')",
               (cid,))
    # v8.2: `b2b_requests` FK → consents nên TRUNCATE trần bị chặn bởi FK
    # TRƯỚC trigger; CASCADE thì trigger append-only (cả 2 bảng) chặn.
    for sql in ("update consents set granted = true",
                "delete from consents", "truncate consents",
                "truncate consents cascade"):
        with pytest.raises(psycopg.Error) as e, db.transaction():
            db.execute(sql)
        assert "append-only" in str(e.value) or (
            sql == "truncate consents" and "foreign key" in str(e.value))
    lid = _lead(db, "giá bao nhiêu")
    _raises(db, CheckViolation,
            "update leads set status = 'bogus' where id = %s", (lid,))
    with pytest.raises(InsufficientPrivilege), db.transaction():
        db.execute("set local role agent_writer")
        db.execute("select * from contacts")


def test_add_contact_ciphertext_dedup_and_log(db, keys):
    cid, new = crm.add_contact(db, dict(PERSON), keys, "Lan")
    assert new is True
    raw = "\n".join(r[0] for r in db.execute(
        "select c::text from contacts c").fetchall())
    for needle in PII_NEEDLES:
        assert needle not in raw, needle
    assert db.execute("select province from contacts where id = %s",
                      (cid,)).fetchone()[0] == "Đà Nẵng"
    name0 = db.execute("select name_enc from contacts where id = %s",
                       (cid,)).fetchone()[0]
    assert crm.unseal(keys[0], name0) == "Nguyễn Văn Mẫu"
    cid2, new2 = crm.add_contact(db, {"phone": "+84905123456",
                                      "name": "Tên Khác"}, keys, "Lan")
    assert (cid2, new2) == (cid, False)
    for alt in ("+84 0905 123 456", "+84 (0) 905 123 456", "84 0905123456"):
        assert crm.add_contact(db, {"phone": alt}, keys, "Lan") \
            == (cid, False), alt
    assert db.execute("select count(*), max(name_enc) from contacts"
                      ).fetchone() == (1, name0)
    with pytest.raises(ValueError):
        crm.add_contact(db, {"phone": "0911222333"}, keys, "Lan",
                        lead_id=999999)
    assert db.execute("select count(*) from contacts").fetchone()[0] == 1
    for bad in ({"phone": PHONE, "zalo_id": "x"},
                {"phone": PHONE, "province": "Atlantis"},
                {"phone": PHONE, "name": "x" * 201},
                {"phone": PHONE, "source": "Có Dấu"},
                {"name": "thiếu phone"}):
        with pytest.raises(ValueError):
            crm.add_contact(db, bad, keys, "Lan")
    lid = _lead(db, "đặt mua giao Đà Nẵng")
    assert crm.add_contact(db, {"phone": PHONE}, keys, "Lan",
                           lead_id=lid) == (cid, False)
    assert db.execute("select contact_id from leads where id = %s",
                      (lid,)).fetchone()[0] == cid
    with pytest.raises(ValueError, match="đã gắn contact khác"):
        crm.add_contact(db, {"phone": "0911222333"}, keys, "Lan",
                        lead_id=lid)
    assert db.execute("select contact_id from leads where id = %s",
                      (lid,)).fetchone()[0] == cid
    assert db.execute("select count(*) from contacts").fetchone()[0] == 1
    logs = db.execute("select detail::text from agent_action_log").fetchall()
    assert logs
    for (d,) in logs:
        assert not _PII_RE.search(d) and "gAAAAA" not in d
        assert not re.search(r"[0-9a-f]{64}", d)


def test_consent_flow(dealers, keys):
    db = dealers
    cid, _ = crm.add_contact(db, dict(PERSON), keys, "Lan")
    for p in crm.PURPOSES:
        assert crm.can_contact(db, cid, p, "DLM01" if p == "dai_ly"
                               else None) is False
    kw = {"evidence_ref": "BB-2026-001", "policy_version": "v0-nhap"}
    crm.record_consent(db, cid, "marketing", True, "form_giay", "Lan", **kw)
    assert crm.can_contact(db, cid, "marketing") is True
    crm.record_consent(db, cid, "marketing", False, "dien_thoai", "Lan")
    assert crm.can_contact(db, cid, "marketing") is False
    assert db.execute(
        "select withdrawn_at is not null, granted_at from v_consent_current "
        "where contact_id = %s and purpose = 'marketing'",
        (cid,)).fetchone() == (True, None)
    crm.record_consent(db, cid, "marketing", True, "web", "Lan", **kw)
    assert crm.can_contact(db, cid, "marketing") is True
    assert db.execute("select count(*) from consents where purpose = "
                      "'marketing'").fetchone()[0] == 3
    crm.record_consent(db, cid, "dai_ly", True, "form_giay", "Lan",
                       dealer_code="DLM01", **kw)
    assert crm.can_contact(db, cid, "dai_ly", "DLM01") is True
    assert crm.can_contact(db, cid, "dai_ly", "DLM02") is False
    assert crm.can_contact(db, cid, "dai_ly") is False
    crm.record_consent(db, cid, "cskh", True, "zalo", "Lan", **kw)
    crm.record_consent(db, cid, "marketing", False, "web", "Lan")
    assert crm.can_contact(db, cid, "cskh") is True
    assert crm.can_contact(db, cid, "marketing") is False   # tách mục đích
    with pytest.raises(ValueError):
        crm.can_contact(db, cid, "spam")
    # backdate: dòng grant ghi SAU nhưng ts cũ hơn — vẫn theo id
    db.execute("insert into consents (contact_id, purpose, granted, source,"
               " evidence_ref, policy_version, recorded_by, ts) values "
               "(%s, 'marketing', true, 'web', 'BB-x', 'v0', 'Lan', "
               "now() - interval '30 days')", (cid,))
    assert crm.can_contact(db, cid, "marketing") is True
    n0 = db.execute("select count(*) from consents").fetchone()[0]
    bad = [
        dict(purpose="spam", granted=True, source="web", **kw),
        dict(purpose="cskh", granted=True, source="fax", **kw),
        dict(purpose="dai_ly", granted=True, source="web", **kw),
        {"purpose": "cskh", "granted": False, "source": "web",
         "dealer_code": "DLM01"},
        {"purpose": "cskh", "granted": True, "source": "web",
         "policy_version": "v1"},
        {"purpose": "cskh", "granted": True, "source": "web",
         "evidence_ref": "BB-1"},
        {"purpose": "cskh", "granted": True, "source": "web",
         "evidence_ref": "0905123456", "policy_version": "v1"},
        {"purpose": "cskh", "granted": True, "source": "web",
         "evidence_ref": "x" * 201, "policy_version": "v1"},
        dict(purpose="dai_ly", granted=True, source="web",
             dealer_code="KHONGCO", **kw),
    ]
    for b in bad:
        with pytest.raises(ValueError):
            crm.record_consent(db, cid, by="Lan", **b)
    with pytest.raises(ValueError):
        crm.record_consent(db, 999999, "cskh", False, "web", "Lan")
    assert db.execute("select count(*) from consents").fetchone()[0] == n0


def test_load_dealers_idempotent_keeps_manual(db):
    db.execute("insert into dealers (code, name, region, status, "
               "commission_default, source) values ('DLM02', 'Sửa tay', "
               "'MIEN_TRUNG', 'paused', 5, 'manual')")
    reg = crm.load_regions()
    r1 = crm.load_dealers(db, reg, "Lan")
    assert r1["new"] == len(reg["dealers"]) - 1 and r1["kept"] == 1
    r2 = crm.load_dealers(db, reg, "Lan")
    assert r2["new"] == 0 and r2["updated"] == 0
    assert db.execute("select name, status, source from dealers where code "
                      "= 'DLM02'").fetchone() == ("Sửa tay", "paused",
                                                  "manual")


def test_assign_status(dealers):
    db = dealers
    lid = _lead(db, "Tôi muốn làm đại lý ở Quảng Nam", "partner")
    with pytest.raises(ValueError):
        crm.assign_lead(db, lid, "DLM03", "Lan")          # vùng khác
    assert db.execute("select dealer_code from leads where id = %s",
                      (lid,)).fetchone()[0] is None
    assert crm.assign_lead(db, lid, "DLM01", "Lan") == "Đà Nẵng"
    row = db.execute("select province, dealer_code, assigned_by, "
                     "assigned_at is not null from leads where id = %s",
                     (lid,)).fetchone()
    assert row == ("Đà Nẵng", "DLM01", "Lan", True)
    with pytest.raises(ValueError, match="tranh chấp"):
        crm.assign_lead(db, lid, "DLM02", "Lan")
    nop = _lead(db, "sâm tươi giá bao nhiêu", "price")
    with pytest.raises(ValueError, match="--province"):
        crm.assign_lead(db, nop, "DLM01", "Lan")
    assert crm.assign_lead(db, nop, "DLM03", "Lan",
                           province="Bình Dương") == "TP. Hồ Chí Minh"
    with pytest.raises(ValueError):
        crm.assign_lead(db, 999999, "DLM01", "Lan")
    lp = _lead(db, "Tôi muốn làm đại lý ở Quảng Nam", "partner")
    db.execute("update dealers set status = 'paused' where code = 'DLM02'")
    with pytest.raises(ValueError, match="đang paused"):
        crm.assign_lead(db, lp, "DLM02", "Lan")
    assert db.execute("select dealer_code from leads where id = %s",
                      (lp,)).fetchone()[0] is None
    db.execute("update dealers set status = 'active' where code = 'DLM02'")
    for st in ("contacted", "qualified", "won"):
        crm.set_lead_status(db, lid, st, "Lan")
    for st in ("new", "lost"):
        with pytest.raises(ValueError):
            crm.set_lead_status(db, lid, st, "Lan")
    l2 = _lead(db, "giá sỉ")
    crm.set_lead_status(db, l2, "qualified", "Lan")
    with pytest.raises(ValueError):
        crm.set_lead_status(db, l2, "contacted", "Lan")
    l3 = _lead(db, "giá sỉ")
    crm.set_lead_status(db, l3, "contacted", "Lan")
    crm.set_lead_status(db, l3, "lost", "Lan")
    with pytest.raises(ValueError):
        crm.set_lead_status(db, l3, "lost", "Lan")


def test_handoff_acceptance_1(dealers, keys):
    db = dealers
    lid = _lead(db, "đặt mua 3 hộp giao Đà Nẵng, sđt 0905 123 456", "order")
    cid, _ = crm.add_contact(db, dict(PERSON), keys, "Lan", lead_id=lid)
    crm.assign_lead(db, lid, "DLM01", "Lan")
    p = crm.handoff_payload(db, lid, "DLM01", keys)
    assert not {"phone", "name", "email", "address"} & set(p)
    assert PHONE not in json.dumps(p) and "0905 123 456" not in json.dumps(p)
    assert p["province"] == "Đà Nẵng" and p["intent"] == "order"
    crm.record_consent(db, cid, "dai_ly", True, "form_giay", "Lan",
                       "BB-1", "v0", "DLM01")
    p = crm.handoff_payload(db, lid, "DLM01", keys)
    assert p["phone"] == PHONE and p["name"] == "Nguyễn Văn Mẫu"
    assert p["email"] == "mau@example.com" and p["address"] == "12 Lê Duẩn"
    with pytest.raises(ValueError):
        crm.handoff_payload(db, lid, "DLM02", keys)       # DL02 cùng vùng
    db.execute("update dealers set status = 'paused' where code = 'DLM01'")
    with pytest.raises(ValueError, match="không active") as e:
        crm.handoff_payload(db, lid, "DLM01", keys)
    for needle in PII_NEEDLES:
        assert needle not in str(e.value)
    db.execute("update dealers set status = 'active' where code = 'DLM01'")
    crm.record_consent(db, cid, "dai_ly", False, "dien_thoai", "Lan",
                       dealer_code="DLM01")
    p = crm.handoff_payload(db, lid, "DLM01", keys)
    assert "phone" not in p and PHONE not in json.dumps(p)


def test_report_no_pii(dealers, keys):
    db = dealers
    lid = _lead(db, "đặt mua giao Đà Nẵng mau@example.com", "order")
    _lead(db, "làm đại lý ở Kon Tum", "partner")
    _lead(db, "giá bao nhiêu", "price")
    cid, _ = crm.add_contact(db, dict(PERSON), keys, "Lan", lead_id=lid)
    crm.record_consent(db, cid, "marketing", True, "web", "Lan", "BB", "v0")
    out = crm.report(db)
    for needle in PII_NEEDLES + ("gAAAAA", "phone_hmac", "uhash-crm-test"):
        assert needle not in out, needle
    assert _PII_RE.search(out) is None
    assert "Quảng Ngãi" in out and "DLM01, DLM02" in out
    assert "marketing: 1 / 0" in out and "chưa xác định" in out


class _Proxy:
    """Conn fixture cho CLI: commit/close/rollback không đụng tx ngoài
    (savepoint của từng hàm vẫn rollback lỗi)."""

    def __init__(self, conn):
        self._c = conn

    def __getattr__(self, name):
        return getattr(self._c, name)

    def commit(self):
        pass

    def close(self):
        pass

    def rollback(self):
        pass


def test_cli_chain_on_db(dealers, monkeypatch, capsys):
    db = dealers
    monkeypatch.setattr(crm, "_connect", lambda: _Proxy(db))
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("CONTACT_VAULT_KEY", key)
    lid = _lead(db, "đặt mua giao Quảng Nam", "order")
    _stdin(monkeypatch, PERSON)
    assert crm.main(["--add-contact", "-", "--lead", str(lid),
                     "--by", "Lan"]) == 0
    out = capsys.readouterr().out
    assert "[ok] contact #" in out
    for needle in PII_NEEDLES:
        assert needle not in out
    cid = db.execute("select contact_id from leads where id = %s",
                     (lid,)).fetchone()[0]
    monkeypatch.setenv("CONTACT_VAULT_KEY", "")     # consent không cần khóa
    assert crm.main(["--consent", str(cid), "--purpose", "dai_ly",
                     "--grant", "--source", "form_giay", "--evidence",
                     "BB-9", "--policy-version", "v0", "--dealer", "DLM01",
                     "--by", "Lan"]) == 0
    assert crm.main(["--assign", str(lid), "--dealer", "DLM01",
                     "--by", "Lan"]) == 0
    assert crm.main(["--status", str(lid), "contacted", "--by", "Lan"]) == 0
    assert crm.main(["--status", str(lid), "new", "--by", "Lan"]) == 1
    assert crm.main(["--report"]) == 0
    out = capsys.readouterr().out
    for needle in PII_NEEDLES:
        assert needle not in out
    assert crm.main(["--handoff", str(lid), "--dealer", "DLM01",
                     "--by", "Lan"]) == 2                # thiếu khóa
    monkeypatch.setenv("CONTACT_VAULT_KEY", key)
    capsys.readouterr()
    assert crm.main(["--handoff", str(lid), "--dealer", "DLM01",
                     "--by", "Lan"]) == 0
    assert PHONE in capsys.readouterr().out
    assert crm.main(["--handoff", str(lid), "--dealer", "DLM02",
                     "--by", "Lan"]) == 1
    det = db.execute("select detail from agent_action_log where action = "
                     "'crm_handoff'").fetchall()
    assert [d[0]["pii_included"] for d in det] == [True]
