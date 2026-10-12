"""v9.4 — `pipelines.qr_trace` (Lô + QR truy xuất, thí điểm mật ong).

Hàm thuần nhận ngày làm tham số — test không đọc đồng hồ, không ngủ.
Phần DB thật: 1 transaction + schema tạm (`docs/schema.sql` ×2 +
`docs/roles.sql`) rồi ROLLBACK — mọi link/sign/issue/revoke thành công CHỈ
chạy ở đây (không giả người ký trên DB nào khác). Danh tính người ký là
FIXTURE (tmp `qr_signers.json`), không phải người thật.
"""

import copy
import datetime as dt
import hashlib
import io
import json
import os
import re
import unicodedata
import uuid
from pathlib import Path

import psycopg
import pytest
from PIL import Image
from psycopg.errors import InsufficientPrivilege, RaiseException

from agents import garden
from pipelines import production as prod
from pipelines import qr_trace as q
from pipelines.pii import _mask_pii
from tests.test_garden_media import _jpeg_gps, _png_gps, gm

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC = (ROOT / "pipelines" / "qr_trace.py").read_text(encoding="utf-8")
TZ = dt.timezone(dt.timedelta(hours=7))

LOT = "LOT-MO-001"
SKU = "mat-ong-sam-120ml-1hu"
SIGN = {"gd_san_xuat": "Trần Sản Xuất", "gd_vung_trong": "Lê Vùng Trồng",
        "phap_che_qa": "Phạm Pháp Chế"}
PLOT_LOC = "Trà My 15.0123, 107.9876"
LOG_DETAIL = "gọi 0905123456 a@b.vn"
LOG_AUTHOR = "Nguyễn Văn Vườn"
MEDIA_AUTHOR = "Lê Thị Ảnh"
SECRETS = (PLOT_LOC, "15.0123", "107.9876", "0905123456", "a@b.vn",
           LOG_AUTHOR, MEDIA_AUTHOR, *SIGN.values(), "KV-T01", "KV-T02")
FNS = ("qr_lot_snapshot_sha(text)", "link_lot_origin(text,bigint,text[],text)",
       "unlink_lot_origin(text,bigint,text)",
       "sign_qr_lot(text,text,text,text,text)",
       "issue_qr(text,text,text,text)", "revoke_qr(text,text,text)")
BANNED = [w.strip().lower() for w in (ROOT / "data" / "banned_words.txt")
          .read_text(encoding="utf-8").splitlines()
          if w.strip() and not w.startswith("#")]


def _write(tmp_path, name, obj) -> Path:
    p = tmp_path / name
    p.write_bytes((obj if isinstance(obj, str)
                   else json.dumps(obj, ensure_ascii=False)).encode("utf-8"))
    return p


CFG = json.loads((ROOT / "data" / "qr_config.json").read_text(encoding="utf-8"))
SIGNERS_DOC = {"status": "fixture", "roles": {r: [n] for r, n in SIGN.items()}}


# ---------- cấu hình (fail-closed) ----------

def test_config_repo_file():
    cfg = q.load_config()
    assert "GIẢ ĐỊNH" in cfg["status"]
    assert cfg["plan_b_deadline"] == dt.date(2026, 11, 27)
    assert cfg["pilot_skus"] == ["mat-ong-sam-120ml-1hu",
                                 "mat-ong-sam-120ml-2hu", "mat-ong-sam-300ml"]
    assert cfg["public_base_url"] == ""
    assert not any(c.isdigit() for c in cfg["region_text"])


def test_signers_repo_file_empty():
    doc = json.loads((ROOT / "data" / "qr_signers.json")
                     .read_text(encoding="utf-8"))
    assert doc["roles"] == {"gd_san_xuat": [], "gd_vung_trong": [],
                            "phap_che_qa": []}
    assert "external-dep" in doc["status"]
    assert q.load_signers() == {r: set() for r in q.ROLES}


def _cfg_variant(kind):
    c = copy.deepcopy(CFG)
    patch = {"region_digit": ("region_text", "Xã 5, Quảng Nam"),
             "region_coord": ("region_text", "Trà My 15.0123"),
             "region_nl": ("region_text", "Vùng Ngọc Linh"),
             "region_nl_ascii": ("region_text", "vung NGOC   linh"),
             "region_empty": ("region_text", "  "),
             "region_long": ("region_text", "a" * 121),
             "pilot_alcohol": ("pilot_skus", [SKU,
                                              "ruou-sam-chai-thuy-tinh-500ml"]),
             "pilot_unknown": ("pilot_skus", ["khong-co"]),
             "pilot_dup": ("pilot_skus", [SKU, SKU]),
             "pilot_empty": ("pilot_skus", []),
             "bad_deadline": ("plan_b_deadline", "27/11/2026"),
             "url_http": ("public_base_url", "http://x.vn"),
             "url_query": ("public_base_url", "https://x.vn/?a=1"),
             "url_none": ("public_base_url", None)}
    if kind == "no_status":
        del c["status"]
    else:
        k, v = patch[kind]
        c[k] = v
    return json.dumps(c, ensure_ascii=False)


@pytest.mark.parametrize("kind", [
    "missing", "empty", "broken", "obj_empty", "only_doc", "not_object",
    "no_status", "region_digit", "region_coord", "region_nl",
    "region_nl_ascii", "region_empty", "region_long", "pilot_alcohol",
    "pilot_unknown", "pilot_dup", "pilot_empty", "bad_deadline", "url_http",
    "url_query", "url_none"])
def test_config_variants_rejected(tmp_path, kind):
    raw = {"empty": " \n", "broken": "{\"status\": ", "obj_empty": "{}",
           "only_doc": "{\"_doc\": \"x\"}", "not_object": "[1]"}.get(kind)
    p = (tmp_path / "nope.json" if kind == "missing"
         else _write(tmp_path, "c.json", raw or _cfg_variant(kind)))
    with pytest.raises(q.QrError):
        q.load_config(p)


def _signers_variant(kind):
    d = copy.deepcopy(SIGNERS_DOC)
    nfd = unicodedata.normalize("NFD", "  trần  SẢN xuất ")
    if kind == "same_person_two_roles":
        d["roles"]["phap_che_qa"].append(nfd)
    elif kind == "missing_role":
        del d["roles"]["phap_che_qa"]
    elif kind == "extra_role":
        d["roles"]["tgd"] = []
    elif kind == "not_list":
        d["roles"]["gd_san_xuat"] = "Trần Sản Xuất"
    elif kind == "blank_name":
        d["roles"]["gd_san_xuat"] = ["  "]
    elif kind == "no_status":
        del d["status"]
    return json.dumps(d, ensure_ascii=False)


@pytest.mark.parametrize("kind", [
    "missing", "empty", "broken", "obj_empty", "only_doc",
    "same_person_two_roles", "missing_role", "extra_role", "not_list",
    "blank_name", "no_status"])
def test_signers_variants_rejected(tmp_path, kind):
    raw = {"empty": "  ", "broken": "{", "obj_empty": "{}",
           "only_doc": "{\"_doc\": \"x\"}"}.get(kind)
    p = (tmp_path / "nope.json" if kind == "missing"
         else _write(tmp_path, "s.json", raw or _signers_variant(kind)))
    with pytest.raises(q.QrError):
        q.load_signers(p)


def test_signers_normalized(tmp_path):
    s = q.load_signers(_write(tmp_path, "s.json", SIGNERS_DOC))
    nfd = unicodedata.normalize("NFD", "  TRẦN   sản xuất ")
    assert q.norm_name(nfd) in s["gd_san_xuat"]
    assert q.norm_name(nfd) not in s["phap_che_qa"]


# ---------- lời văn trang + guardrail (thuần) ----------

def _lot(**kw):
    d = {"lot_code": LOT, "sku_key": SKU, "mfg_date": dt.date(2026, 9, 15),
         "exp_date": dt.date(2036, 3, 15), "intake_status": "passed",
         "source": "manual"}
    d.update(kw)
    return d


ORIGINS = [{"plot_log_id": 7, "harvest": dt.date(2026, 9, 1),
            "media": ["a" * 64]},
           {"plot_log_id": 9, "harvest": dt.date(2026, 8, 20), "media": []}]


def test_guardrail_qr_channel_alias():
    r = q.guardrail.check_publish("x", channel="qr")
    assert "config" not in {v["code"] for v in r["violations"]}
    r = q.guardrail.check_publish("x", channel="kenh-la")
    assert "config" in {v["code"] for v in r["violations"]}


def test_page_text_deterministic_and_clean():
    cfg, golden = q.load_config(), q.golden_map()
    t = q.page_text(_lot(source="sample"), ORIGINS, golden[SKU], cfg)
    assert t == q.page_text(_lot(source="sample"), ORIGINS, golden[SKU], cfg)
    for s in ("Mật ong sâm 120ml (1 hũ)", f"Lô: {LOT}",
              "Ngày sản xuất: 15/09/2026", "Hạn sử dụng: 15/03/2036",
              f"Vùng nguyên liệu: {cfg['region_text']}",
              "Thu hoạch: tháng 08/2026, tháng 09/2026",
              "Ảnh tư liệu vườn: 1 ảnh", q.SAMPLE_LINE):
        assert s in t, s
    assert q.check_page(t, SKU) == []
    assert _mask_pii(t) == t and not q.COORD_RE.search(t)
    low = t.lower()
    assert "ngọc linh" not in low
    assert [w for w in BANNED if w in low] == []
    assert "plot" not in low and "#7" not in t
    assert q.SAMPLE_LINE not in q.page_text(_lot(), ORIGINS, golden[SKU], cfg)
    assert q.text_sha(t) == hashlib.sha256(t.encode("utf-8")).hexdigest()


def test_page_tpbvsk_canonical(tmp_path, monkeypatch):
    golden = q.golden_map()
    c = dict(CFG, pilot_skus=[SKU, "savina-12v"])
    cfg = q.load_config(_write(tmp_path, "c.json", c), golden)
    lot = _lot(sku_key="savina-12v")
    t = q.page_text(lot, ORIGINS, golden["savina-12v"], cfg)
    canon = q._canonical()
    assert canon in t
    assert q.check_page(t, "savina-12v") == []
    monkeypatch.setattr(q, "_tail_lines", lambda *_a: [])
    t2 = q.page_text(lot, ORIGINS, golden["savina-12v"], cfg)
    assert canon not in t2
    assert "thieu_khuyen_cao" in q.check_page(t2, "savina-12v")


@pytest.mark.parametrize("extra,code", [
    ("Giúp chữa bệnh", "tu_cam"), ("gọi 0905123456", "pii"),
    ("liên hệ a@b.vn", "pii"), ("15.0123, 107.9876", "toa_do"),
    ("sâm Ngọc Linh", "ngoc_linh_chua_xac_nhan")])
def test_check_page_flags(extra, code):
    cfg, golden = q.load_config(), q.golden_map()
    t = q.page_text(_lot(), ORIGINS, golden[SKU], cfg) + extra + "\n"
    assert code in q.check_page(t, SKU)


def test_new_code_random_not_derived():
    codes = [q.new_code() for _ in range(100)]
    assert len(set(codes)) == 100
    for c in codes:
        assert re.fullmatch(r"[A-Za-z0-9_-]{22}", c), c
        assert LOT.lower() not in c.lower()
    assert re.search(r"token_urlsafe", SRC)
    assert not re.search(r"sha256\(.*lot|lot_code.*hexdigest", SRC)
    gen = SRC.split("def new_code", 1)[1].split("\ndef ", 1)[0]
    assert "lot" not in gen.split('"""')[-1]


def test_html_render_static_escaped():
    t = "Tiêu đề\nSP <script>alert(1)</script>\nLô: X & Y\n"
    h = q.page_html(t, [("b" * 64, "jpg"), ("../x", "jpg"), ("c" * 64, "exe")])
    assert "<script" not in h and "&lt;script&gt;" in h
    assert "http" not in h
    assert '<meta name="robots" content="noindex">' in h
    assert h.count("<img") == 1 and f"../media/{'b' * 64}.jpg" in h
    r = q.revoked_html(dt.date(2026, 12, 1))
    assert q.REVOKED in r and "01/12/2026" in r and "<img" not in r


def test_has_metadata_parses_segments():
    clean, ext, _ = gm.strip_image(_jpeg_gps())
    assert ext == "jpg" and q._has_metadata(clean, "jpg") is False
    assert q._has_metadata(_jpeg_gps(), "jpg") is True
    pclean, pext, _ = gm.strip_image(_png_gps())
    assert pext == "png" and q._has_metadata(pclean, "png") is False
    assert q._has_metadata(_png_gps(), "png") is True
    assert q._has_metadata(b"not an image", "jpg") is True
    assert q._has_metadata(clean, "gif") is True
    # JPEG thêm COM sau SOI → bị chặn
    assert q._has_metadata(clean[:2] + b"\xff\xfe\x00\x05abc" + clean[2:],
                           "jpg") is True


def _app1_exif(raw: bytes) -> bytes:
    i = raw.index(b"Exif\x00\x00") - 4
    assert raw[i:i + 2] == b"\xff\xe1"
    return raw[i:i + 2 + int.from_bytes(raw[i + 2:i + 4], "big")]


def test_has_metadata_catches_exif_hidden_after_sos_or_eoi():
    """Khối EXIF GPS nhét SAU SOS (trước EOI) hoặc SAU EOI — parser header
    dừng ở SOS nên bỏ sót; lớp 2 (marker dài + đuôi thừa) phải bắt."""
    raw = _jpeg_gps()
    clean, _, _ = gm.strip_image(raw)
    app1 = _app1_exif(raw)
    assert clean.endswith(b"\xff\xd9") and q._has_metadata(clean, "jpg") is False
    # trước EOI: EOI vẫn là 2 byte cuối → chỉ marker `Exif\0\0` bắt
    assert q._has_metadata(clean[:-2] + app1 + clean[-2:], "jpg") is True
    assert q._has_metadata(clean + app1, "jpg") is True          # sau EOI
    xmp = b"\xff\xe1\x00\x14ns.adobe.com/xap/1.0"
    assert q._has_metadata(clean[:-2] + xmp + clean[-2:], "jpg") is True
    # đuôi thừa không chứa marker → chỉ check EOI-cuối bắt
    assert q._has_metadata(clean + b"\x00" * 8, "jpg") is True
    pclean, _, _ = gm.strip_image(_png_gps())
    assert q._has_metadata(pclean + app1, "png") is True          # sau IEND
    assert q._has_metadata(pclean + b"\x00" * 8, "png") is True


# ---------- phương án B (thuần) ----------

def _planb_lots():
    return [dict(_lot(lot_code="MAU-MO-A", source="sample",
                      intake_status="pending"), n_origins=0, issued=False),
            dict(_lot(lot_code="LOT-MO-B"), n_origins=1, issued=False),
            dict(_lot(lot_code="LOT-MO-C"), n_origins=1, issued=True)]


def _planb(day):
    signed = {"LOT-MO-B": {"gd_san_xuat"},
              "LOT-MO-C": set(q.ROLES)}
    return q.plan_b_report(_planb_lots(), signed, day, q.load_config(),
                           q.golden_map())


def test_planb_before_deadline():
    out = _planb(dt.date(2026, 11, 26))
    assert "còn 1 ngày" in out and "ĐỀ XUẤT" not in out
    assert "Lời văn tem" not in out and "Hạn sử dụng" not in out
    assert "GĐ vùng trồng, Pháp chế/QA" in out
    assert out == _planb(dt.date(2026, 11, 26))


@pytest.mark.parametrize("day", [dt.date(2026, 11, 27),
                                 dt.date(2026, 11, 28)])
def test_planb_on_after_deadline(day):
    out = _planb(day)
    assert out == _planb(day)
    assert "ĐỀ XUẤT phương án B" in out and "agent KHÔNG tự đổi tem" in out
    issued, todo = out.split("Chưa phát hành:")
    assert "LOT-MO-C" in issued and "LOT-MO-C" not in todo
    a = todo.split("- lô MAU-MO-A")[1].split("- lô")[0]
    assert "[MẪU]" in todo and "chưa đủ điều kiện in tem" in a
    b = todo.split("- lô LOT-MO-B")[1]
    assert "Lời văn tem KHÔNG QR (guardrail: OK)" in b
    assert "Hạn sử dụng: 15/03/2036" in b and "Vùng nguyên liệu" not in b
    assert "http" not in out
    for name in SIGN.values():
        assert name not in out


# ---------- CLI usage (không DB) ----------

@pytest.fixture
def no_connect(monkeypatch):
    calls = []

    def boom(_dsn):
        calls.append(1)
        raise AssertionError("không được connect")
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", boom)
    return calls


@pytest.mark.parametrize("argv", [
    ["link", "--lot", LOT, "--log", "1"],
    ["link", "--lot", LOT, "--log", "1", "--by", "   "],
    ["unlink", "--lot", LOT, "--log", "1"],
    ["sign", "--lot", LOT, "--role", "gd_san_xuat"],
    ["sign", "--lot", LOT, "--role", "gd_san_xuat", "--by", " "],
    ["sign", "--lot", LOT, "--role", "tgd", "--by", "A"],
    ["issue", "--lot", LOT],
    ["issue", "--lot", LOT, "--by", "x" * 101],
    ["revoke", "--code", "A" * 22],
    ["revoke", "--code", "ngan", "--by", "A"],
    ["link", "--lot", LOT, "--log", "1", "--media", "xyz", "--by", "A"],
    ["planb", "--date", "27/11/2026"]])
def test_cli_usage_exit2(no_connect, argv):
    with pytest.raises(SystemExit) as e:
        q.main(argv)
    assert e.value.code == 2
    assert no_connect == []


def test_cli_help_lists_subcommands(capsys):
    with pytest.raises(SystemExit):
        q.main(["--help"])
    out = capsys.readouterr().out
    for c in ("link", "unlink", "preview", "sign", "issue", "revoke", "site",
              "planb"):
        assert re.search(rf"(?<![\w-]){c}(?![\w-])", out), c


def test_sign_allowlist_before_connect(no_connect, tmp_path, monkeypatch,
                                        capsys):
    # file repo thật: vai rỗng → external-dep
    assert q.main(["sign", "--lot", LOT, "--role", "phap_che_qa", "--by",
                   "Ai Đó"]) == 1
    assert "external-dep" in capsys.readouterr().out
    monkeypatch.setattr(q, "SIGNERS_FILE",
                        _write(tmp_path, "s.json", SIGNERS_DOC))
    assert q.main(["sign", "--lot", LOT, "--role", "phap_che_qa", "--by",
                   "Người Ngoài"]) == 1
    # đúng người nhưng SAI vai → cũng từ chối trước connect
    assert q.main(["sign", "--lot", LOT, "--role", "phap_che_qa", "--by",
                   SIGN["gd_san_xuat"]]) == 1
    out = capsys.readouterr().out
    assert "không thuộc danh sách" in out and "không connect" in out
    assert no_connect == []


def test_config_broken_no_connect(no_connect, tmp_path, monkeypatch):
    monkeypatch.setattr(q, "CONFIG_FILE", _write(tmp_path, "c.json", "{}"))
    for argv in (["link", "--lot", LOT, "--log", "1", "--by", "A"],
                 ["preview", "--lot", LOT], ["issue", "--lot", LOT, "--by",
                                             "A"],
                 ["site", "--out", str(tmp_path / "o")], ["planb"]):
        assert q.main(argv) == 1, argv
    monkeypatch.setattr(q, "CONFIG_FILE",
                        _write(tmp_path, "c2.json",
                               _cfg_variant("pilot_alcohol")))
    assert q.main(["planb"]) == 1
    assert no_connect == []
    assert not (tmp_path / "o").exists()


def test_docs_mention_cli():
    for rel in ("docs/handover/sop.md", "docs/handover/playbook-vuon.md",
                "docs/handover/kien-truc.md", "AGENTS.md"):
        body = (ROOT / rel).read_text(encoding="utf-8")
        assert "pipelines.qr_trace" in body, rel
    sop = (ROOT / "docs" / "handover" / "sop.md").read_text(encoding="utf-8")
    for c in ("link", "unlink", "preview", "sign", "issue", "revoke", "site",
              "planb"):
        assert f"pipelines.qr_trace {c}" in sop, c
    assert "data/qr_site/" in (ROOT / ".gitignore").read_text(
        encoding="utf-8").splitlines()


def test_no_direct_insert_into_protected_tables():
    assert not re.search(r"insert\s+into\s+(approvals|qr_|lot_origins)", SRC,
                         re.IGNORECASE)
    assert not re.search(r"(update|delete\s+from)\s+(qr_|lot_origins|"
                         r"approvals)", SRC, re.IGNORECASE)


# ---------- DB thật (schema tạm, rollback) ----------

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
        schema = f"t_qr_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)          # idempotent ×2
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self, *a, **kw):
        return self.conn.transaction(*a, **kw)   # savepoint trong tx test

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


@pytest.fixture
def proxy(db):
    return TxConn(db)


@pytest.fixture
def run(db, proxy, monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(q, "SIGNERS_FILE",
                        _write(tmp_path, "signers.json", SIGNERS_DOC))
    return lambda *argv: q.main(list(argv))


def _one(db, sql, params=None):
    return db.execute(sql, params).fetchone()[0]


def _count(db, table, where="true", params=None):
    return _one(db, f"select count(*) from {table} where {where}", params)


def _plot(db, pid="KV-T01", source="manual"):
    db.execute("insert into plots (id, location, source) values (%s, %s, %s)",
               (pid, PLOT_LOC, source))


def _harvest(proxy, ts, pid="KV-T01", activity="thu hoạch"):
    lid, _w = garden.add_log(proxy, pid, ts, activity, LOG_DETAIL, LOG_AUTHOR)
    assert lid is not None
    return lid


def _mk_lot(db, code=LOT, status="passed", mfg="2026-09-15",
            exp="2036-03-15", sku=SKU, source="manual"):
    db.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
               " exp_date, qty, source) values (%s, %s, %s, %s, 100, %s)",
               (code, sku, mfg, exp, source))
    if status != "pending":
        db.execute("select record_lot_intake(%s, %s, 'QA fixture')",
                   (code, status))


def _media(proxy, store, size=(32, 16), pid="KV-T01"):
    clean, ext, info = gm.strip_image(_jpeg_gps(size))
    sha, _p = gm.store(clean, ext, store)
    gm.record(proxy, sha, ext, len(clean), info, pid, dt.date(2026, 9, 1),
              MEDIA_AUTHOR)
    return sha


H1 = dt.datetime(2026, 9, 1, 8, 0, tzinfo=TZ)


def _ready(db, proxy, run, media=()):
    """Khoảnh thật + nhật ký thu hoạch đã chain + lô passed + link OK."""
    _plot(db)
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    argv = ["link", "--lot", LOT, "--log", str(lid), "--by", "GĐ SX fixture"]
    if media:
        argv[5:5] = ["--media", *media]
    assert run(*argv) == 0
    return lid


def _sign(run, roles=tuple(SIGN)):
    for r in roles:
        assert run("sign", "--lot", LOT, "--role", r, "--by", SIGN[r]) == 0, r


def _tamper_chain(db, lid):
    db.execute("set local session_replication_role = replica")
    db.execute("update plot_logs set detail = 'sửa lén' where id = %s",
               (lid,))
    db.execute("set local session_replication_role = origin")
    assert db.execute("select * from verify_plot_logs()").fetchall() != []


def _raises(db, sql, params=None, exc=RaiseException, match=None):
    with pytest.raises(exc) as e, db.transaction():
        db.execute(sql, params)
    if match:
        assert match in str(e.value), str(e.value)


def test_schema_role_privileges(db):
    schema = _one(db, "select current_schema()")
    for t in ("lot_origins", "qr_signatures", "qr_codes"):
        assert _one(db, "select to_regclass(%s) is not null",
                    (f"{schema}.{t}",))
    names = [f.split("(")[0] for f in FNS]
    rows = db.execute(
        "select proname, prosecdef, proconfig from pg_proc where"
        " pronamespace = %s::regnamespace and proname = any(%s)",
        (schema, names)).fetchall()
    assert {r[0] for r in rows} == set(names)
    for name, secdef, cfg in rows:
        assert secdef is True, name
        assert f"search_path={schema}, pg_temp" in (cfg or []), (name, cfg)
    priv = "select has_function_privilege(%s, %s, 'execute')"
    for fn in FNS:
        assert _one(db, priv, ("app_human", fn)) is True, fn
        assert _one(db, priv, ("agent_writer", fn)) is False, fn
        assert _one(db, priv, ("public", fn)) is False, fn
    for role in ("app_human", "agent_writer"):
        for t in ("approvals", "qr_signatures", "qr_codes", "lot_origins"):
            for p in ("insert", "update", "delete"):
                assert _one(db, "select has_table_privilege(%s, %s, %s)",
                            (role, t, p)) is False, (role, t, p)
    _mk_lot(db)
    c22, ha, hb = "A" * 22, "a" * 64, "b" * 64
    inserts = (
        (("insert into qr_codes (code, lot_code, snapshot_sha256,"
          " text_sha256, issued_by) values (%s, %s, %s, %s, 'x')"),
         (c22, LOT, ha, hb)),
        (("insert into approvals (object_type, object_id, content_sha256,"
          " decision, approved_by) values ('qr_lot_sign', %s, %s,"
          " 'approved', 'x')"), (LOT, ha)),
        (("insert into qr_signatures (lot_code, role, signer, signer_norm,"
          " snapshot_sha256, text_sha256, approval_id) values"
          " (%s, 'gd_san_xuat', 'x', 'x', %s, %s, 1)"), (LOT, ha, hb)),
        (("insert into lot_origins (lot_code, plot_log_id, linked_by)"
          " values (%s, 1, 'x')"), (LOT,)))
    for role in ("app_human", "agent_writer"):
        for sql, params in inserts:
            with pytest.raises(InsufficientPrivilege), db.transaction():
                db.execute(f"set local role {role}")
                db.execute(sql, params)
    calls = (("select sign_qr_lot(%s, 'gd_san_xuat', 'A', %s)", (LOT, ha)),
             ("select issue_qr(%s, %s, %s, 'A')", (LOT, c22, ha)),
             ("select revoke_qr(%s, 'A')", (c22,)),
             ("select link_lot_origin(%s, 1, '{}', 'A')", (LOT,)))
    for sql, params in calls:
        with pytest.raises(InsufficientPrivilege), db.transaction():
            db.execute("set local role agent_writer")
            db.execute(sql, params)
    # app_human CÓ quyền gọi — function tự từ chối nghiệp vụ (0 nguồn)
    with pytest.raises(RaiseException) as e, db.transaction():
        db.execute("set local role app_human")
        db.execute(f"select sign_qr_lot('{LOT}', 'gd_san_xuat', 'A',"
                   f" '{'a' * 64}')")
    assert "chưa có nguồn" in str(e.value)
    assert _one(db, "select current_user") != "app_human"
    assert db.execute("select * from verify_action_log()").fetchall() == []


def test_link_ok_and_refusals(db, proxy, run, capsys):
    lid = _ready(db, proxy, run)
    assert db.execute("select lot_code, plot_log_id, media_sha256, linked_by"
                      " from lot_origins").fetchall() == [
        (LOT, lid, [], "GĐ SX fixture")]
    assert db.execute("select action, object_id, detail from agent_action_log"
                      " where action like 'qr_%'").fetchall() == [
        ("qr_lot_link", LOT, {"plot_log_id": lid, "media": 0})]
    out = capsys.readouterr().out
    assert PLOT_LOC not in out and LOG_AUTHOR not in out
    n0 = _count(db, "lot_origins")
    # biến thể nhật ký
    sample = _one(db, "insert into plot_logs (plot_id, ts, activity, source)"
                  " values ('KV-T01', '2026-09-02T08:00:00+07', 'thu hoạch',"
                  " 'sample:x') returning id")
    assert _one(db, "select row_hash from plot_logs where id = %s",
                (sample,)) is None
    water = _harvest(proxy, dt.datetime(2026, 9, 3, 8, 0, tzinfo=TZ),
                     activity="tưới")
    late = _harvest(proxy, dt.datetime(2026, 9, 16, 0, 30, tzinfo=TZ))
    edge = _harvest(proxy, dt.datetime(2026, 9, 15, 0, 30, tzinfo=TZ))
    _plot(db, "KV-T02", "sample:sample_plots.jsonl")
    on_sample_plot = _harvest(proxy, dt.datetime(2026, 9, 4, 8, 0, tzinfo=TZ),
                              pid="KV-T02")
    cases = [(sample, "mẫu / chưa chain"), (water, "không phải"),
             (late, "sau ngày sản xuất"), (on_sample_plot, "khoảnh"),
             (lid, "đã ánh xạ"), (999999, "không có nhật ký")]
    for log_id, why in cases:
        assert run("link", "--lot", LOT, "--log", str(log_id), "--by",
                   "A") == 1, why
        assert why in capsys.readouterr().out, why
    assert _count(db, "lot_origins") == n0
    # biên ngày giờ VN: 16/09 00:30 VN = 15/09 UTC → vẫn từ chối (đã ở trên);
    # 15/09 00:30 VN = 14/09 UTC → cùng ngày SX → nhận
    assert run("link", "--lot", LOT, "--log", str(edge), "--by", "A") == 0
    # lô failed / lô không có
    _mk_lot(db, "LOT-MO-FAIL", status="failed")
    assert run("link", "--lot", "LOT-MO-FAIL", "--log", str(lid), "--by",
               "A") == 1
    assert "failed" in capsys.readouterr().out
    assert run("link", "--lot", "KHONG-CO", "--log", str(lid), "--by",
               "A") == 1
    _raises(db, "select link_lot_origin('KHONG-CO', %s, '{}', 'A')", (lid,),
            match="không có lô")
    _raises(db, "select link_lot_origin(%s, %s, '{}', '  ')", (LOT, lid),
            match="thiếu tên")
    # lô SKU ngoài pilot_skus → từ chối TRƯỚC khi gọi function
    _mk_lot(db, "LOT-SAP-001", sku="saphraton-20v")
    assert run("link", "--lot", "LOT-SAP-001", "--log", str(lid), "--by",
               "A") == 1
    assert "ngoài pilot_skus" in capsys.readouterr().out
    assert _count(db, "lot_origins", "lot_code <> %s", (LOT,)) == 0


def test_link_media_variants(db, proxy, run, tmp_path, capsys):
    store = tmp_path / "store"
    _plot(db)
    _plot(db, "KV-T03")
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    shas = [_media(proxy, store, (16 + i, 16)) for i in range(4)]
    other = _media(proxy, store, (40, 16), pid="KV-T03")
    base = ["link", "--lot", LOT, "--log", str(lid), "--by", "A", "--media"]
    for media, why in ((shas, "tối đa 3"), ([other], "kho tư liệu"),
                       (["f" * 64], "kho tư liệu"),
                       ([shas[0], shas[0]], "trùng")):
        assert run(*base, *media) == 1, why
        assert why in capsys.readouterr().out
    assert _count(db, "lot_origins") == 0
    assert run(*base, *shas[:3]) == 0
    assert _one(db, "select cardinality(media_sha256) from lot_origins") == 3


def test_link_refused_when_chain_broken(db, proxy, run, capsys):
    _plot(db)
    good = _harvest(proxy, H1)
    other = _harvest(proxy, dt.datetime(2026, 9, 2, 8, 0, tzinfo=TZ),
                     activity="tưới")
    _mk_lot(db)
    _tamper_chain(db, other)          # hỏng dòng KHÁC dòng được link
    assert run("link", "--lot", LOT, "--log", str(good), "--by", "A") == 1
    assert "chuỗi nhật ký" in capsys.readouterr().out
    assert _count(db, "lot_origins") == 0


def test_sign_three_people_and_refusals(db, proxy, run, capsys):
    _ready(db, proxy, run)
    st = q.lot_state(db, LOT, q.load_config(), q.golden_map())
    _sign(run, ("gd_san_xuat", "gd_vung_trong"))
    # cùng người ký vai thứ 2 (NFD + hoa/thường + khoảng trắng) → DB từ chối
    nfd = unicodedata.normalize("NFD", "  trần   SẢN xuất ")
    _raises(db, "select sign_qr_lot(%s, 'phap_che_qa', %s, %s)",
            (LOT, nfd, st["tsha"]), match="hai vai")
    _raises(db, "select sign_qr_lot(%s, 'gd_san_xuat', 'Người Khác', %s)",
            (LOT, st["tsha"]), match="đã ký")
    _raises(db, "select sign_qr_lot(%s, 'tgd', 'X', %s)", (LOT, st["tsha"]),
            match="vai trò")
    _raises(db, "select sign_qr_lot(%s, 'phap_che_qa', 'X', 'abc')", (LOT,),
            match="text_sha256")
    assert run("sign", "--lot", LOT, "--role", "gd_san_xuat", "--by",
               SIGN["gd_san_xuat"]) == 1
    assert _count(db, "qr_signatures") == 2
    _sign(run, ("phap_che_qa",))
    assert db.execute("select role, signer, snapshot_sha256, text_sha256 from"
                      " qr_signatures order by role").fetchall() == [
        (r, SIGN[r], st["snap"], st["tsha"]) for r in sorted(SIGN)]
    assert _count(db, "approvals", "object_type = 'qr_lot_sign'") == 3
    assert _one(db, "select bool_and(content_sha256 = %s) from approvals"
                " where object_type = 'qr_lot_sign'", (hashlib.sha256(
                    f"{st['snap']}:{st['tsha']}".encode()).hexdigest(),))
    assert _count(db, "agent_action_log", "action = 'qr_lot_sign'") == 3
    out = capsys.readouterr().out
    assert run("preview", "--lot", LOT) == 0
    out = capsys.readouterr().out
    assert "Còn thiếu: không" in out and "guardrail kênh qr: OK" in out
    for name in SIGN.values():
        assert name not in out
    for s in SECRETS:
        assert s not in out, s
    assert db.execute("select * from verify_action_log()").fetchall() == []


def test_sign_refused_pending_and_guardrail(db, proxy, run, monkeypatch,
                                           capsys):
    _plot(db)
    lid = _harvest(proxy, H1)
    _mk_lot(db, status="pending")
    assert run("link", "--lot", LOT, "--log", str(lid), "--by", "A") == 0
    assert run("sign", "--lot", LOT, "--role", "gd_san_xuat", "--by",
               SIGN["gd_san_xuat"]) == 1
    assert "passed" in capsys.readouterr().out
    _raises(db, "select sign_qr_lot(%s, 'gd_san_xuat', 'A', %s)",
            (LOT, "a" * 64), match="passed")
    db.execute("select record_lot_intake(%s, 'passed', 'QA')", (LOT,))
    orig = q.page_text
    monkeypatch.setattr(q, "page_text",
                        lambda *a: orig(*a) + "Giúp chữa bệnh\n")
    assert run("sign", "--lot", LOT, "--role", "gd_san_xuat", "--by",
               SIGN["gd_san_xuat"]) == 1
    assert "guardrail" in capsys.readouterr().out
    assert _count(db, "qr_signatures") == 0


@pytest.mark.parametrize("change", ["relink", "region"])
def test_signatures_invalidated_by_change(db, proxy, run, tmp_path,
                                          monkeypatch, capsys, change):
    lid = _ready(db, proxy, run)
    _sign(run, ("gd_san_xuat", "gd_vung_trong"))
    if change == "relink":
        assert run("unlink", "--lot", LOT, "--log", str(lid), "--by",
                   "A") == 0
        extra = _harvest(proxy, dt.datetime(2026, 9, 5, 8, 0, tzinfo=TZ))
        assert run("link", "--lot", LOT, "--log", str(extra), "--by",
                   "A") == 0
    else:
        monkeypatch.setattr(q, "CONFIG_FILE", _write(
            tmp_path, "c.json", dict(CFG, region_text="Quảng Nam")))
    capsys.readouterr()
    assert run("preview", "--lot", LOT) == 0
    out = capsys.readouterr().out
    assert "Đã ký (bản hiện tại): chưa vai nào" in out
    assert "Còn thiếu: GĐ Sản xuất, GĐ vùng trồng, Pháp chế/QA" in out
    _sign(run, ("phap_che_qa",))
    assert run("issue", "--lot", LOT, "--by", "A") == 1
    assert _count(db, "qr_codes") == 0


def _code(db):
    return _one(db, "select code from qr_codes where revoked_at is null")


def test_issue_gates_and_revoke(db, proxy, run, capsys):
    lid = _ready(db, proxy, run)
    _sign(run, ("gd_san_xuat", "gd_vung_trong"))
    assert run("issue", "--lot", LOT, "--by", "A") == 1          # 2/3
    assert "chưa đủ 3 chữ ký" in capsys.readouterr().out
    assert _count(db, "qr_codes") == 0
    _sign(run, ("phap_che_qa",))
    assert run("issue", "--lot", LOT, "--by", "Người phát hành") == 0
    out = capsys.readouterr().out
    code = _code(db)
    assert re.fullmatch(r"[A-Za-z0-9_-]{22}", code)
    assert LOT.lower() not in code.lower()
    assert f"{code}/" in out and "external-dep" in out
    assert run("issue", "--lot", LOT, "--by", "A") == 1          # lần 2
    _raises(db, "select issue_qr(%s, %s, %s, 'A')",
            (LOT, "x" + LOT + "abcdefghijklmn", "a" * 64), match="mã lô")
    # lô đang có mã → không đổi ánh xạ
    assert run("unlink", "--lot", LOT, "--log", str(lid), "--by", "A") == 1
    assert "còn hiệu lực" in capsys.readouterr().out
    # revoke thiếu --by → exit 2, mã vẫn hiệu lực
    with pytest.raises(SystemExit) as e:
        run("revoke", "--code", code)
    assert e.value.code == 2
    assert _code(db) == code
    assert run("revoke", "--code", code, "--by", "GĐ fixture", "--reason",
               "thử") == 0
    assert run("revoke", "--code", code, "--by", "GĐ fixture") == 1
    assert run("revoke", "--code", "Z" * 22, "--by", "A") == 1
    # phát hành lại (snapshot/lời văn không đổi → không cần ký lại) → mã MỚI
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    assert _code(db) != code
    assert _count(db, "qr_codes") == 2
    assert [r[0] for r in db.execute(
        "select action from agent_action_log where action in"
        " ('qr_issue', 'qr_revoke') order by id")] == [
        "qr_issue", "qr_revoke", "qr_issue"]
    assert db.execute("select * from verify_action_log()").fetchall() == []


def test_issue_refuses_forged_signer_norm(db, proxy, run, capsys):
    _ready(db, proxy, run)
    _sign(run, ("gd_san_xuat", "gd_vung_trong"))
    st = q.lot_state(db, LOT, q.load_config(), q.golden_map())
    aid = _one(db, "insert into approvals (object_type, object_id,"
               " content_sha256, decision, approved_by, note) values"
               " ('qr_lot_sign', %s, %s, 'approved', 'TRẦN SẢN XUẤT',"
               " 'phap_che_qa') returning id", (LOT, "c" * 64))
    db.execute("insert into qr_signatures (lot_code, role, signer,"
               " signer_norm, snapshot_sha256, text_sha256, approval_id)"
               " values (%s, 'phap_che_qa', ' TRẦN  SẢN XUẤT', 'gia-khac',"
               " %s, %s, %s)", (LOT, st["snap"], st["tsha"], aid))
    assert run("issue", "--lot", LOT, "--by", "A") == 1
    assert "3 người khác nhau" in capsys.readouterr().out
    assert _count(db, "qr_codes") == 0


@pytest.mark.parametrize("case", ["pending", "failed", "no_origin",
                                  "chain_broken", "expired", "guardrail"])
def test_issue_refusals(db, proxy, run, monkeypatch, capsys, case):
    lid = _ready(db, proxy, run)
    _sign(run)
    if case in ("pending", "failed", "no_origin", "expired"):
        # superuser sửa thẳng trạng thái (mô phỏng dữ liệu xấu) — DB vẫn chặn
        sql = {"pending": "update production_lots set intake_status ="
                          " 'pending', checked_by = null, checked_at = null",
               "failed": "update production_lots set intake_status ="
                         " 'failed'",
               "no_origin": "delete from lot_origins",
               "expired": "update production_lots set mfg_date ="
                          " '2020-01-01', exp_date = '2026-01-02'"}[case]
        db.execute(sql)
        # qua cổng Python (qr_payload) hoặc DB — đều exit 1
        assert run("issue", "--lot", LOT, "--by", "A") == 1
        st = q.lot_state(db, LOT, q.load_config(), q.golden_map())
        why = {"pending": "passed", "failed": "passed",
               "no_origin": "nguồn", "expired": "hết hạn"}[case]
        _raises(db, "select issue_qr(%s, %s, %s, 'A')",
                (LOT, "Q" * 22, st["tsha"]), match=why)
    elif case == "chain_broken":
        _tamper_chain(db, lid)
        assert run("issue", "--lot", LOT, "--by", "A") == 1
        assert "chuỗi nhật ký" in capsys.readouterr().out
    else:
        orig = q.page_text
        monkeypatch.setattr(q, "page_text",
                            lambda *a: orig(*a) + "gọi 0905123456\n")
        assert run("issue", "--lot", LOT, "--by", "A") == 1
        assert "pii" in capsys.readouterr().out
    assert _count(db, "qr_codes") == 0


def test_tables_append_only_guards(db, proxy, run):
    _ready(db, proxy, run)
    _sign(run)
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    code = _code(db)
    for sql in ("update qr_signatures set signer = 'x'",
                "delete from qr_signatures", "truncate qr_signatures",
                "delete from qr_codes", "truncate qr_codes cascade",
                "update qr_codes set lot_code = 'LOT-KHAC'",
                "update qr_codes set issued_by = 'x'"):
        _raises(db, sql)
    db.execute("select revoke_qr(%s, 'A')", (code,))
    _raises(db, "update qr_codes set revoked_by = 'B'", match="đã thu hồi")
    _raises(db, "update qr_codes set revoked_at = null, revoked_by = null",
            match="đã thu hồi")


def _files(d: Path) -> list[Path]:
    return sorted(p for p in d.rglob("*") if p.is_file())


def test_site_pages_media_revoke(db, proxy, run, tmp_path, monkeypatch,
                                 capsys):
    store = tmp_path / "store"
    _plot(db)
    sha = _media(proxy, store)
    raw = _jpeg_gps()
    with Image.open(io.BytesIO(raw)) as im:     # tiền điều kiện: nguồn CÓ GPS
        assert dict(im.getexif().get_ifd(0x8825))
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    assert run("link", "--lot", LOT, "--log", str(lid), "--media", sha,
               "--by", "A") == 0
    _sign(run)
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    code = _code(db)
    out_dir = tmp_path / "site"
    # thiếu env kho ảnh → không ghi trang, exit 1
    monkeypatch.delenv("GARDEN_MEDIA_DIR", raising=False)
    assert run("site", "--out", str(out_dir)) == 1
    assert not (out_dir / code / "index.html").exists()
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    capsys.readouterr()
    assert run("site", "--out", str(out_dir)) == 0
    page = (out_dir / code / "index.html").read_text(encoding="utf-8")
    for s in ("Mật ong sâm 120ml (1 hũ)", f"Lô: {LOT}", "15/09/2026",
              "15/03/2036", CFG["region_text"], f"../media/{sha}.jpg"):
        assert s in page, s
    assert not (out_dir / "index.html").exists()
    files = _files(out_dir)
    assert {p.relative_to(out_dir).as_posix() for p in files} == {
        f"{code}/index.html", f"media/{sha}.jpg"}
    for p in files:
        data = p.read_bytes()
        txt = data.decode("utf-8", errors="replace")
        for s in SECRETS:
            assert s not in txt, (p.name, s)
        assert not q.COORD_RE.search(re.sub(r"<[^>]+>", " ", txt)) or \
            p.suffix == ".jpg"
    visible = re.sub(r"<[^>]+>", "\n", page)
    assert _mask_pii(visible) == visible
    assert not q.COORD_RE.search(visible)
    assert "<script" not in page and "http" not in page
    assert "ngọc linh" not in page.lower()
    img = (out_dir / "media" / f"{sha}.jpg").read_bytes()
    with Image.open(io.BytesIO(img)) as im:
        assert len(im.getexif()) == 0
    assert b"Exif\x00\x00" not in img and b"ns.adobe.com/xap" not in img
    out = capsys.readouterr().out
    for s in SECRETS:
        assert s not in out
    # file ảnh trong kho bị tráo (sha lệch) → exit 1, không ghi lại trang
    stored = store / sha[:2] / f"{sha}.jpg"
    good = stored.read_bytes()
    page_bytes = (out_dir / code / "index.html").read_bytes()
    stored.write_bytes(gm.strip_image(_jpeg_gps((50, 50)))[0])
    (out_dir / code / "index.html").write_bytes(b"cu")
    assert run("site", "--out", str(out_dir)) == 1
    assert "lệch sha256" in capsys.readouterr().out
    assert (out_dir / code / "index.html").read_bytes() == b"cu"
    stored.write_bytes(good)
    assert run("site", "--out", str(out_dir)) == 0
    assert (out_dir / code / "index.html").read_bytes() == page_bytes
    # đổi region_text sau phát hành → exit 1, trang cũ giữ nguyên
    monkeypatch.setattr(q, "CONFIG_FILE", _write(
        tmp_path, "c.json", dict(CFG, region_text="Quảng Nam")))
    assert run("site", "--out", str(out_dir)) == 1
    assert "thu hồi + ký lại" in capsys.readouterr().out
    assert (out_dir / code / "index.html").read_bytes() == page_bytes
    monkeypatch.setattr(q, "CONFIG_FILE", ROOT / "data" / "qr_config.json")
    # thu hồi có --by → trang "đã thu hồi", không còn lô/HSD/ảnh
    assert run("revoke", "--code", code, "--by", "GĐ fixture") == 0
    assert run("site", "--out", str(out_dir)) == 0
    page = (out_dir / code / "index.html").read_text(encoding="utf-8")
    assert "đã thu hồi" in page
    for s in (LOT, "Hạn sử dụng", "<img", CFG["region_text"]):
        assert s not in page, s
    assert not (out_dir / "media" / f"{sha}.jpg").exists()
    assert not (out_dir / "index.html").exists()


def test_planb_db_read_only(db, proxy, run, capsys):
    _ready(db, proxy, run)
    _sign(run, ("gd_san_xuat",))
    _mk_lot(db, "MAU-MO120-260915", status="pending", mfg="2026-09-15",
            exp="2028-03-15", source="sample")
    tables = ("lot_origins", "qr_signatures", "qr_codes", "approvals",
              "agent_action_log", "production_lots")
    before = [_count(db, t) for t in tables]
    capsys.readouterr()
    assert run("planb", "--date", "2026-11-27") == 0
    out = capsys.readouterr().out
    assert [_count(db, t) for t in tables] == before
    assert "MAU-MO120-260915 [MẪU]" in out and "chưa đủ điều kiện in tem" in out
    seg = out.split(f"- lô {LOT}")[1]
    assert "chữ ký vai GĐ vùng trồng, Pháp chế/QA" in seg
    assert "Lời văn tem KHÔNG QR (guardrail: OK)" in seg
    for s in SECRETS:
        assert s not in out, s
