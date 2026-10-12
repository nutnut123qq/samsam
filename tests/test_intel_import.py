"""v7.2-doi-thu-trend-social — `ingest.intel_import` (WP09 Competitor
Tracker, Trend, Social Listening P1).

Phần thuần (read_* / load_*_config / find_spikes / msg_hash / CLI argparse)
không cần DB. Phần DB thật chạy trên `DATABASE_URL` (samsam_infra) trong
schema tạm + ROLLBACK cuối test. Fixture `tests/fixtures/intel_import/*MAU*`
là dữ liệu TỔNG HỢP (đối thủ = nhãn giả DOI-THU-MAU-n, người dùng giả).
"""

import ast
import csv
import json
import os
import re
import uuid
from datetime import date
from pathlib import Path

import psycopg
import pytest

from crawler import intel
from ingest import golden_store as gs
from ingest import intel_import as ii
from pipelines import llm_gateway

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "intel_import"
COMP = FIX / "competitor_MAU.csv"
TL = FIX / "multiTimeline_MAU.csv"
REL = FIX / "relatedQueries_MAU.csv"
SOC = FIX / "social_fanpage_MAU.csv"
SOC2 = FIX / "social_fanpage_2_MAU.csv"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
SALT = "salt-test-MAU-0123456789"
TODAY = date(2026, 10, 12)

C_HDR = "doi_thu,kenh,ten_san_pham,gia_vnd,ngay_ghi,nguon"
C_OK = "DOI-THU-MAU-1,web,Sâm MẪU,150000,2026-10-06,https://x.example.com/a"
C_BASE = "DOI-THU-MAU-1,web,Sâm,1000,2026-10-06,https://a.vn/x,"


def _csv(tmp_path, text, name="f_MAU.csv"):
    p = tmp_path / name
    p.write_bytes(text.encode("utf-8"))
    return p


def _social_pii():
    """Mọi chuỗi định danh / SĐT / email gốc trong fixture social."""
    out = set()
    for f in (SOC, SOC2):
        with open(f, encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                out |= {r["ten_nguoi_dung"], r["id_nguoi_dung"], r["sdt"]}
    return out | {"0912 345 678", "khach.mau7@example.com", "+84 905 222 333"}


# ---------------------------------------------------------------- schema


def _v72_block():
    return SCHEMA_SQL.split("v7.2 đối thủ / trend / social", 1)[1]


def test_schema_v72_tables_and_no_identity_columns():
    block = _v72_block()
    tables = re.findall(r"^create table if not exists (\w+)", block, re.MULTILINE)
    assert tables == ["intel_imports", "competitor_observations",
                      "trends_weekly", "trends_related", "social_mentions"]
    assert not re.search(
        r"\b(author|user_id|user_name|ten_nguoi|sdt|phone|email|profile|"
        r"id_nguoi_dung)\w* +(text|bigint)", block, re.IGNORECASE)
    sm = block.split("create table if not exists social_mentions", 1)[1]
    sm = sm.split(");", 1)[0]
    cols = {ln.split()[0] for ln in sm.splitlines()[1:]
            if ln.strip() and not ln.strip().startswith("--")}
    bad = {c for c in cols if re.match(r"(author|user|name|phone|email|"
                                       r"profile)", c)}
    assert bad == set() and "msg_hash" in cols and "excerpt" in cols
    # không assert đếm cứng tổng số bảng — chỉ sàn
    assert len(re.findall(r"^create table if not exists", SCHEMA_SQL,
                          re.MULTILINE)) >= 30


# ---------------------------------------------------------------- competitor


def test_read_competitor_fixture():
    rows, errs, sha = ii.read_competitor(COMP, today=TODAY)
    assert errs == [] and len(rows) == 5 and len(sha) == 64
    by = {r["row_no"]: r for r in rows}
    assert by[2]["price_vnd"] == 150000 and by[2]["sku_key"] == "savina-12v"
    assert by[3]["promo_price_vnd"] == 280000
    assert by[4]["rating"] == 4.5 and by[4]["price_vnd"] == 399000
    assert by[4]["source_ref"].startswith("ảnh chụp")
    assert by[6]["sku_key"] is None
    assert all("ghi_chu" not in r for r in rows)


@pytest.mark.parametrize("hdr,row,col", [
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,abc123xyz,2026-10-06,https://a.vn/x",
     "gia_vnd"),
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,0,2026-10-06,https://a.vn/x", "gia_vnd"),
    (C_HDR, "DOI-THU-MAU-1,facebook,Sâm,1000,2026-10-06,https://a.vn/x",
     "kenh"),
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,1000,06/10/2026,https://a.vn/x",
     "ngay_ghi"),
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,1000,2026-12-30,https://a.vn/x",
     "ngay_ghi"),
    (C_HDR, "DOI-THU-MAU-1,shopee,Sâm,1000,2026-10-06,ghi tay", "nguon"),
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,1000,2026-10-06,", "nguon"),
    (C_HDR, "DOI-THU-MAU-1,web,Sâm,1000,2026-10-06," + "h" * 501, "nguon"),
    (C_HDR + ",gia_km_vnd", C_BASE + "1000", "gia_km_vnd"),
    (C_HDR + ",rating", C_BASE + "5.5", "rating"),
    (C_HDR + ",rating", C_BASE + "4.55", "rating"),
    (C_HDR + ",so_danh_gia", C_BASE + "-3", "so_danh_gia"),
])
def test_read_competitor_row_errors(tmp_path, hdr, row, col):
    p = _csv(tmp_path, f"{hdr}\n{C_OK}\n{row}\n")
    rows, errs, _ = ii.read_competitor(p, today=TODAY)
    assert rows == []
    assert errs == [f"dòng 3: cột '{col}' không hợp lệ"], errs
    assert "abc123xyz" not in " ".join(errs)


@pytest.mark.parametrize("text,needle", [
    ("", "file rỗng"),
    (C_HDR + "\n", "chỉ có header"),
    ("doi_thu,kenh,ten_san_pham,gia_vnd,ngay_ghi\n" + C_OK[:-25] + "\n",
     "thiếu cột bắt buộc: nguon"),
    (C_HDR + ",cot_la\n" + C_OK + ",x\n", "cột lạ 'cot_la'"),
    (C_HDR + ",kenh\n" + C_OK + ",web\n", "header trùng"),
])
def test_read_competitor_structure_errors(tmp_path, text, needle):
    rows, errs, _ = ii.read_competitor(_csv(tmp_path, text), today=TODAY)
    assert rows == [] and any(needle in e for e in errs), errs


def test_read_competitor_bad_suffix(tmp_path):
    rows, errs, _ = ii.read_competitor(_csv(tmp_path, C_HDR, "f.txt"))
    assert rows == [] and "không hỗ trợ" in errs[0]


def test_read_competitor_masks_phone_in_source(tmp_path):
    p = _csv(tmp_path, f"{C_HDR},khuyen_mai\nDOI-THU-MAU-1,khac,Sâm,1000,"
             "2026-10-06,ảnh chụp gọi 0905 123 456,liên hệ a.b@example.com\n")
    rows, errs, _ = ii.read_competitor(p, today=TODAY)
    assert errs == []
    stored = json.dumps(rows[0], default=str, ensure_ascii=False)
    assert "0905 123 456" not in stored and "a.b@example.com" not in stored


# ---------------------------------------------------------------- trend


def _cfg():
    cfg, errs = ii.load_trend_config(ii.KEYWORDS_FILE)
    assert errs == []
    return cfg


def test_trend_config_real_and_fail_closed(tmp_path):
    cfg = _cfg()
    assert cfg["anchor"] == "quà tết"
    for k in ("quà tết", "sâm ngọc linh", "nhân sâm",
              "đồ ăn healthy giới trẻ"):
        assert k in cfg["keywords"]
    assert cfg["spike"] == {"window_weeks": 8, "ratio": 2.0, "min_delta": 10}
    base = json.loads(ii.KEYWORDS_FILE.read_text(encoding="utf-8"))
    for mut, needle in (
            (lambda d: d["keywords"].update({"rượu sâm giới trẻ": "gioi_tre"}),
             "rượu"),
            (lambda d: d.update(anchor="không có"), "anchor"),
            (lambda d: d["keywords"].update({"x": "nhom_la"}), "nhóm lạ"),
            (lambda d: d["spike"].update(window_weeks=0), "window_weeks"),
            (lambda d: d.pop("spike"), "spike")):
        d = json.loads(json.dumps(base))
        mut(d)
        p = tmp_path / "kw.json"
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        got, errs = ii.load_trend_config(p)
        assert got is None and any(needle in e for e in errs), errs


def test_find_spikes_fixture_exactly_one():
    kind, rows, errs, _sha = ii.read_trend(TL, _cfg())
    assert kind == "trend_timeline" and errs == []
    assert len({r["week"] for r in rows}) == 14
    assert {r["keyword"] for r in rows} == {
        "quà tết", "sâm ngọc linh", "nhân sâm", "đồ ăn healthy giới trẻ"}
    found = []
    for k in sorted({r["keyword"] for r in rows}):
        ser = sorted((r["week"], r["value"]) for r in rows if r["keyword"] == k)
        found += [(k, *s) for s in ii.find_spikes(ser, 8, 2.0, 10)]
    assert found == [("sâm ngọc linh", date(2026, 10, 11), 55, 20.5)]
    # "<1" → 0; tuần "gần spike" 2→6 (ratio đạt, delta < 10) không bị bắt
    hl = {r["week"]: r["value"] for r in rows
          if r["keyword"] == "đồ ăn healthy giới trẻ"}
    assert hl[date(2026, 8, 16)] == 0 and hl[date(2026, 10, 4)] == 6


def test_find_spikes_rules():
    ser = [(i, 2) for i in range(8)] + [(8, 6)]
    assert ii.find_spikes(ser, 8, 2.0, 10) == []           # delta < 10
    assert ii.find_spikes(ser[:5] + [(5, 90)], 8, 2.0, 10) == []  # < window
    zero = [(i, 0) for i in range(8)]
    assert ii.find_spikes(zero + [(8, 10)], 8, 2.0, 10) == [(8, 10, 0)]
    assert ii.find_spikes(zero + [(8, 9)], 8, 2.0, 10) == []
    flat = [(i, 30) for i in range(8)]
    assert ii.find_spikes(flat + [(8, 59)], 8, 2.0, 10) == []  # ratio < 2
    assert ii.find_spikes(flat + [(8, 60)], 8, 2.0, 10) == [(8, 60, 30)]


def _tl(tmp_path, cols, rows, first="Week"):
    hdr = first + "," + ",".join(f"{c}: (Việt Nam)" for c in cols)
    return _csv(tmp_path, "Category: All categories\n\n" + hdr + "\n"
                + "\n".join(rows) + "\n")


@pytest.mark.parametrize("cols,rows,needle", [
    (["sâm ngọc linh"], ["2026-10-04,5"], "thiếu neo 'quà tết'"),
    (["quà tết", "sâm ngọc linh", "nhân sâm", "hồng sâm", "quà biếu",
      "trà thảo mộc"], ["2026-10-04,1,2,3,4,5,6"], "1–5 cột"),
    (["quà tết", "từ khóa lạ"], ["2026-10-04,1,2"], "không có trong"),
    (["quà tết"], ["2026-10-04,abc"], "dòng 4: cột 2"),
    (["quà tết"], ["2026-10-04,101"], "0–100"),
    (["quà tết"], ["04/10/2026,1"], "không phải ngày"),
    (["quà tết"], ["2026-10-04,1", "2026-10-04,2"], "tuần trùng"),
])
def test_read_trend_timeline_errors(tmp_path, cols, rows, needle):
    _kind, got, errs, _ = ii.read_trend(_tl(tmp_path, cols, rows), _cfg())
    assert got == [] and any(needle in e for e in errs), errs
    assert "abc" not in " ".join(errs)


def test_read_trend_pathological_header_linear(tmp_path):
    """Ô header khổng lồ lặp ': (' — bị chặn bởi trần độ dài trước regex
    (không quét O(n²)); kết quả là lỗi header, không treo."""
    big = "a: (" * 20000
    nl = chr(10)
    p = _csv(tmp_path, f'Week,quà tết: (Việt Nam),"{big}"{nl}2026-10-04,1,2{nl}')
    _k, rows, errs, _ = ii.read_trend(p, _cfg())
    assert rows == [] and any("header cột 3" in e for e in errs), errs


def test_read_trend_daily_and_unknown(tmp_path):
    kind, rows, errs, _ = ii.read_trend(FIX / "multiTimeline_daily_MAU.csv",
                                        _cfg())
    assert rows == [] and "chỉ nhận chuỗi tuần" in errs[0]
    kind, rows, errs, _ = ii.read_trend(_csv(tmp_path, "a,b\n1,2\n"), _cfg())
    assert kind is None and "không nhận dạng" in errs[0]


def test_read_trend_related_flags_alcohol():
    kind, rows, errs, _ = ii.read_trend(REL, _cfg())
    assert kind == "trend_related" and errs == [] and len(rows) == 6
    ruou = [r for r in rows if r["flags"] == ["ruou"]]
    assert [r["query"] for r in ruou] == ["rượu sâm ngọc linh"]
    assert {r["section"] for r in rows} == {"top", "rising"}
    assert [r["value"] for r in rows if r["section"] == "rising"] == [
        "+350%", "+120%", "Breakout"]


# ---------------------------------------------------------------- social


def _rules(dpia=False, tmp_path=None):
    if tmp_path is None:
        rules, errs = ii.load_social_rules(ii.RULES_FILE)
        assert errs == [] and rules["dpia_signed"] is False
        return rules
    d = json.loads(ii.RULES_FILE.read_text(encoding="utf-8"))
    d["dpia_signed"] = dpia
    p = tmp_path / "rules_MAU.json"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


def test_read_social_labels_and_pii():
    rows, errs, _ = ii.read_social(SOC, "fanpage", _rules())
    assert errs == [] and len(rows) == 21
    by = {r["row_no"]: r for r in rows}
    assert by[3]["labels"] == ["hoi_suc_khoe"] and by[3]["sensitive"]
    assert "hoi_gia" in by[4]["labels"]
    assert "hoi_ruou" in by[5]["labels"]
    assert "khieu_nai" in by[6]["labels"]
    assert by[12]["labels"] == ["khac"]
    assert all(r["excerpt"] is None for r in rows)
    dump = json.dumps([{k: v for k, v in r.items() if k != "key"}
                       for r in rows], default=str, ensure_ascii=False)
    for s in _social_pii():
        assert s not in dump
    # vật liệu hash (chỉ RAM) cũng đã che SĐT/email nội dung
    keys = " ".join(r["key"] for r in rows)
    assert "0912 345 678" not in keys and "khach.mau7@example.com" not in keys


def test_read_social_dpia_signed_excerpt(tmp_path):
    rules, errs = ii.load_social_rules(_rules(True, tmp_path))
    assert errs == []
    rows, errs, _ = ii.read_social(SOC, "fanpage", rules)
    sens = [r for r in rows if r["sensitive"]]
    assert sens and all(r["excerpt"] is None for r in sens)
    normal = [r for r in rows if not r["sensitive"]]
    assert all(r["excerpt"] for r in normal)
    ex = " ".join(r["excerpt"] for r in normal)
    assert "0912 345 678" not in ex and "khach.mau7@example.com" not in ex
    assert "+84 905 222 333" not in ex


def test_social_rules_fail_closed(tmp_path):
    for d, needle in (({"dpia_signed": "yes", "labels": {"khen": ["a"]}},
                       "dpia_signed"),
                      ({"dpia_signed": False, "labels": {"spam": ["a"]}},
                       "nhãn lạ"),
                      ({"dpia_signed": False, "labels": {"khen": []}},
                       "0 từ khóa")):
        p = tmp_path / "r.json"
        p.write_text(json.dumps(d), encoding="utf-8")
        got, errs = ii.load_social_rules(p)
        assert got is None and any(needle in e for e in errs), errs


def test_msg_hash_salted():
    a = ii.msg_hash(SALT, "fanpage", "id:1")
    assert a != ii.msg_hash(SALT + "x", "fanpage", "id:1")
    assert a != ii.msg_hash(SALT, "zalo_oa", "id:1")
    assert a == ii.msg_hash(SALT, "fanpage", "id:1") and len(a) == 64


@pytest.mark.parametrize("name,needle", [
    ("social_bad_cot_la_MAU.csv", "cột lạ"),
    ("social_bad_thoi_gian_MAU.csv", "thoi_gian"),
])
def test_read_social_bad_files(name, needle):
    rows, errs, _ = ii.read_social(FIX / name, "fanpage", _rules())
    assert rows == [] and any(needle in e for e in errs), errs


def test_read_social_drops_identity_columns(tmp_path):
    p = _csv(tmp_path, "thoi_gian,noi_dung,ten_nguoi_dung,sdt,email,"
             "link_profile,avatar,id_nguoi_dung\n2026-10-05 08:00,"
             "Sâm ngon,Tên Giả MAU,0905000111,x@example.com,"
             "https://fb.example/u1,https://img.example/a.png,uid-MAU-1\n")
    rows, errs, _ = ii.read_social(p, "fanpage", _rules())
    assert errs == [] and set(rows[0]) == {
        "row_no", "kind", "posted_at", "key", "labels", "sensitive",
        "excerpt"}
    assert "Tên Giả MAU" not in json.dumps(rows, default=str,
                                           ensure_ascii=False)


# ---------------------------------------------------------------- CLI thuần


class _Spy:
    def __init__(self, conn=None, exc=None):
        self.n, self.conn, self.exc = 0, conn, exc

    def __call__(self, dsn):
        self.n += 1
        if self.exc:
            raise self.exc
        return self.conn


def _cli(monkeypatch, argv, conn=None, exc=None, salt=SALT):
    spy = _Spy(conn, exc)
    monkeypatch.setattr(ii, "_connect", spy)
    monkeypatch.setattr(ii, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    if salt is None:
        monkeypatch.delenv("INTEL_HASH_SALT", raising=False)
    else:
        monkeypatch.setenv("INTEL_HASH_SALT", salt)
    try:
        rc = ii.main(argv)
    except SystemExit as e:
        rc = e.code
    return rc, spy.n


@pytest.mark.parametrize("argv", [
    [],
    ["--competitor", str(COMP), "--trend", str(TL)],
    ["--competitor", str(COMP), "--seed", "nhân sâm"],
    ["--competitor", str(COMP), "--channel", "fanpage"],
    ["--social", str(SOC)],
    ["--social", str(SOC), "--channel", "facebook"],
    ["--trend", str(REL)],
    ["--trend", str(REL), "--seed", "từ khóa lạ"],
    ["--trend", str(TL), "--seed", "nhân sâm"],
])
def test_cli_usage_exit2_no_connect(monkeypatch, argv):
    assert _cli(monkeypatch, argv) == (2, 0)


@pytest.mark.parametrize("argv", [
    ["--competitor", str(FIX / "competitor_bad_gia_MAU.csv")],
    ["--trend", str(FIX / "multiTimeline_no_anchor_MAU.csv")],
    ["--trend", str(FIX / "multiTimeline_daily_MAU.csv")],
    ["--social", str(FIX / "social_bad_cot_la_MAU.csv"), "--channel",
     "fanpage"],
    ["--social", str(FIX / "social_bad_thoi_gian_MAU.csv"), "--channel",
     "fanpage"],
])
def test_cli_bad_file_exit1_no_connect(monkeypatch, capsys, argv):
    assert _cli(monkeypatch, argv) == (1, 0)
    out = capsys.readouterr().out
    assert "không connect" in out and "abc123xyz" not in out


def test_cli_social_missing_salt_no_connect(monkeypatch, capsys):
    argv = ["--social", str(SOC), "--channel", "fanpage"]
    assert _cli(monkeypatch, argv, salt=None) == (1, 0)
    assert _cli(monkeypatch, argv, salt="ngan") == (1, 0)
    assert "INTEL_HASH_SALT" in capsys.readouterr().out


def test_cli_salt_read_from_dotenv(monkeypatch):
    """Muối nằm trong .env → phải load_dotenv TRƯỚC khi kiểm muối."""
    spy = _Spy(exc=psycopg.OperationalError("down"))
    monkeypatch.setattr(ii, "_connect", spy)
    monkeypatch.delenv("INTEL_HASH_SALT", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(ii, "load_dotenv", lambda *a, **k: monkeypatch.setenv(
        "INTEL_HASH_SALT", SALT))
    assert ii.main(["--social", str(SOC), "--channel", "fanpage"]) == 1
    assert spy.n == 1   # qua cổng muối, tới bước connect


def test_cli_connect_error_exit1(monkeypatch):
    rc, n = _cli(monkeypatch, ["--competitor", str(COMP)],
                 exc=psycopg.OperationalError("down"))
    assert (rc, n) == (1, 1)


def test_cli_missing_dsn_exit1(monkeypatch):
    monkeypatch.setattr(ii, "load_dotenv", lambda *a, **k: None)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    spy = _Spy()
    monkeypatch.setattr(ii, "_connect", spy)
    assert ii.main(["--competitor", str(COMP)]) == 1 and spy.n == 0


# ---------------------------------------------------------------- tĩnh


def _imports(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            out |= {a.name for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module:
            out.add(n.module)
            out |= {f"{n.module}.{a.name}" for a in n.names}
    return out


MODS = (ROOT / "ingest" / "intel_import.py", ROOT / "scripts" /
        "intel_weekly.py")


def test_no_network_or_trends_lib_imports():
    banned = {"pytrends", "httpx", "requests", "urllib.request",
              "http.client", "socket"}
    for p in MODS:
        imps = _imports(p)
        hit = {i for i in imps if i in banned or i.split(".")[0] in banned}
        assert hit == set(), (p, hit)
    for d in ("ingest", "scripts", "crawler", "pipelines", "agents", "app",
              "api"):
        for f in (ROOT / d).rglob("*.py"):
            src = f.read_text(encoding="utf-8")
            assert not re.search(r"pytrends|trends\.google\.[a-z]+/trends/api",
                                 src, re.IGNORECASE), f
    assert "pytrends" not in (ROOT / "requirements.txt").read_text(
        encoding="utf-8").lower()


def test_isolation_static():
    for p in MODS:
        src = p.read_text(encoding="utf-8")
        assert not re.search(r"content_drafts|pipelines\.store|"
                             r"pipelines\.content|save_draft|connectors\.",
                             src), p
        assert not {"pipelines.store", "pipelines.content", "connectors.zalo",
                    "agents.report"} & _imports(p), p
    src = MODS[0].read_text(encoding="utf-8")
    hits = {m.group(2).lower() for m in re.finditer(
        r"(insert into|update|delete from) +([a-z_]+)", src, re.IGNORECASE)}
    assert hits <= {"intel_imports", "competitor_observations",
                    "trends_weekly", "trends_related", "social_mentions"}, hits
    assert "social_mentions" in hits and "intel_imports" in hits
    assert not re.search(r"(insert into|update|delete from) +[a-z_]+",
                         MODS[1].read_text(encoding="utf-8"), re.IGNORECASE)


def test_hard_block_still_blocks_marketplaces():
    for h in ("shopee.vn", "vt.tiktok.com", "lazada.vn",
              "https://shopee.vn/product/1"):
        assert intel.is_blocked(h), h
    assert not intel.is_blocked("doi-thu-mau-2.example.com")


# ---------------------------------------------------------------- DB thật


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
        schema = f"t_intel72_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.social_mentions",)).fetchone()[0]
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class TxConn:
    """commit/rollback/close chỉ ghi nhận — dữ liệu ở lại tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = self.rolled_back = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        pass


def _n(conn, table):
    return conn.execute(f"select count(*) from {table}").fetchone()[0]


V72 = ("intel_imports", "competitor_observations", "trends_weekly",
       "trends_related", "social_mentions")


def _counts(conn):
    return {t: _n(conn, t) for t in V72}


def _run(db, monkeypatch, argv, salt=SALT):
    proxy = TxConn(db)
    rc, _n = _cli(monkeypatch, argv, conn=proxy, salt=salt)
    return rc, proxy


def test_db_checks_and_unique(db):
    iid = db.execute("insert into intel_imports (kind, file_name, file_sha256,"
                     " row_count) values ('competitor', 'x', 'sha-x', 1)"
                     " returning id").fetchone()[0]
    ok_obs = ("insert into competitor_observations (import_id, row_no,"
              " competitor, channel, product_name, price_vnd, rating,"
              " observed_on, source_ref) values (%s, %s, 'D', %s, 'p', %s, %s,"
              " '2026-10-06', 'https://a')")
    soc = ("insert into social_mentions (import_id, channel, kind, posted_at,"
           " msg_hash, labels, sensitive) values (%s, %s, 'comment', now(),"
           " %s, %s, false)")
    cases = [
        (ok_obs, (iid, 1, "web", 0, None)),
        (ok_obs, (iid, 2, "web", 100, 5.5)),
        (("insert into trends_weekly (import_id, query_id, keyword, anchor,"
          " geo, week, value) values (%s, 'q', 'k', 'a', 'g', '2026-10-04',"
          " 101)"), (iid,)),
        (soc, (iid, "facebook", "h1", ["khen"])),
        (soc, (iid, "fanpage", "h2", [])),
        (("insert into intel_imports (kind, file_name, file_sha256,"
          " row_count) values ('khac', 'y', 'sha-y', 1)"), None),
    ]
    for sql, params in cases:
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute(sql, params)
    db.execute(soc, (iid, "fanpage", "h3", ["khen"]))
    with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
        db.execute(soc, (iid, "zalo_oa", "h3", ["che"]))


def test_db_competitor_idempotent_and_unknown_sku(db, monkeypatch, capsys):
    rc, px = _run(db, monkeypatch, ["--competitor", str(COMP)])
    assert rc == 0 and px.committed == 1
    assert "[load] competitor" in capsys.readouterr().out
    before = _counts(db)
    assert before["competitor_observations"] == 5
    rc, px = _run(db, monkeypatch, ["--competitor", str(COMP)])
    assert rc == 0 and px.committed == 0
    assert "[skip]" in capsys.readouterr().out and _counts(db) == before
    rc, px = _run(db, monkeypatch,
                  ["--competitor", str(FIX / "competitor_bad_sku_MAU.csv")])
    out = capsys.readouterr().out
    assert rc == 1 and px.committed == 0 and px.rolled_back == 1
    assert "dòng 2: sku_tuong_duong không có trong golden" in out
    assert _counts(db) == before


def _golden_price(db, sku, ch, price, day):
    return db.execute(
        "insert into price_list (sku_key, channel, kind, price_vnd,"
        " valid_from) values (%s, %s, 'list', %s, %s) returning id",
        (sku, ch, price, day)).fetchone()[0]


def _obs(db, iid, row, ch, sku, price, promo, day):
    db.execute(
        "insert into competitor_observations (import_id, row_no, competitor,"
        " channel, product_name, sku_key, price_vnd, promo_price_vnd,"
        " observed_on, source_ref) values (%s, %s, 'DOI-THU-MAU-9', %s, 'p',"
        " %s, %s, %s, %s, %s)",
        (iid, row, ch, sku, price, promo, day, f"https://src.example/{row}"))


def test_db_competitor_gaps(db):
    db.execute("insert into sku_master (sku_key, name, category, source)"
               " values ('mau-a', 'A', 'food', 'manual'),"
               " ('mau-b', 'B', 'food', 'manual'),"
               " ('mau-c', 'C', 'food', 'manual')")
    old = _golden_price(db, "mau-a", "shopee", 120000, date(2026, 1, 1))
    db.execute("update price_list set valid_to = '2026-10-06' where id = %s",
               (old,))
    new = _golden_price(db, "mau-a", "shopee", 100000, date(2026, 10, 6))
    db.execute("update price_list set approved_by = 'GĐ MAU', approved_at ="
               " now() where id = %s", (new,))
    # mau-a có CẢ giá web (cùng ngày, id lớn hơn) → vẫn phải chọn shopee
    web_a = _golden_price(db, "mau-a", "web", 110000, date(2026, 10, 6))
    web = _golden_price(db, "mau-b", "web", 100000, date(2026, 1, 1))
    iid = db.execute("insert into intel_imports (kind, file_name, file_sha256,"
                     " row_count) values ('competitor', 'g', 'sha-g', 4)"
                     " returning id").fetchone()[0]
    d = date(2026, 10, 6)
    _obs(db, iid, 1, "shopee", "mau-a", 90000, None, d)
    _obs(db, iid, 2, "shopee", "mau-a", 90000, 80000, d)
    _obs(db, iid, 3, "lazada", "mau-b", 95000, None, d)
    _obs(db, iid, 4, "web", "mau-c", 95000, None, d)
    _obs(db, iid, 5, "web", "mau-b", 95000, None, date(2026, 10, 13))
    gaps = ii.competitor_gaps(db, date(2026, 10, 8))
    assert len(gaps) == 4 and all(g["week"] == date(2026, 10, 5)
                                  for g in gaps)
    by = {g["source_ref"].rsplit("/", 1)[1]: g for g in gaps}
    assert by["1"]["gap_pct"] == -0.1 and by["2"]["gap_pct"] == -0.2
    assert by["1"]["golden_ref"] == f"price_list#{new}"
    assert by["1"]["golden_vnd"] == 100000 and by["1"]["golden_approved"]
    assert by["1"]["golden_channel"] == "shopee" and web_a > new
    assert by["2"]["golden_ref"] == f"price_list#{new}"
    assert by["3"]["golden_ref"] == f"price_list#{web}"
    assert by["3"]["golden_channel"] == "web"
    assert by["3"]["golden_approved"] is False
    assert by["4"]["golden_vnd"] is None and by["4"]["gap_pct"] is None
    assert by["4"]["note"] == "chưa có giá golden"
    assert all(g["obs_ref"].startswith("obs#") for g in gaps)


def test_no_golden_writes_static():
    src = MODS[0].read_text(encoding="utf-8")
    assert not re.search(r"(insert into|update|delete from) +(sku_master|"
                         r"price_list|products)", src, re.IGNORECASE)


def test_db_trend_idempotent(db, monkeypatch, capsys):
    rc, px = _run(db, monkeypatch, ["--trend", str(TL)])
    out = capsys.readouterr().out
    assert rc == 0 and px.committed == 1
    assert "[spike] sâm ngọc linh tuần 2026-10-11: 55" in out
    n = _n(db, "trends_weekly")
    assert n == 56
    assert db.execute("select count(*) from trends_weekly where anchor ="
                      " 'quà tết' and query_id is not null").fetchone()[0] == n
    rc, px = _run(db, monkeypatch, ["--trend", str(TL)])
    assert rc == 0 and "[skip]" in capsys.readouterr().out
    assert _n(db, "trends_weekly") == n
    rc, px = _run(db, monkeypatch, ["--trend", str(REL), "--seed",
                                    "Nhân Sâm"])
    assert rc == 0 and px.committed == 1
    assert db.execute("select seed, query, flags from trends_related where"
                      " 'ruou' = any(flags)").fetchall() == [
        ("nhân sâm", "rượu sâm ngọc linh", ["ruou"])]


def test_db_social_pii_dedup_no_llm(db, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(llm_gateway, "chat",
                        lambda *a, **k: calls.append(a))
    argv = ["--social", str(SOC), "--channel", "fanpage"]
    rc, px = _run(db, monkeypatch, argv)
    out = capsys.readouterr().out
    assert rc == 0 and px.committed == 1 and "new=21 dup=0" in out
    dump = " ".join(r[0] for r in db.execute(
        "select row_to_json(s)::text from social_mentions s").fetchall())
    dump += " ".join(r[0] for r in db.execute(
        "select row_to_json(i)::text from intel_imports i").fetchall())
    for s in _social_pii():
        assert s not in dump, s
    assert db.execute("select count(*) from social_mentions where excerpt is"
                      " not null").fetchone()[0] == 0
    labels = dict(db.execute(
        "select l, count(*) from social_mentions, unnest(labels) l"
        " group by 1").fetchall())
    assert labels["hoi_suc_khoe"] == 3 and labels["hoi_ruou"] == 1
    assert labels["khieu_nai"] >= 3 and labels["hoi_gia"] >= 3
    assert db.execute("select count(*) from social_mentions where sensitive"
                      ).fetchone()[0] == 3
    rc, px = _run(db, monkeypatch, argv)
    assert rc == 0 and "[skip]" in capsys.readouterr().out
    rc, px = _run(db, monkeypatch, ["--social", str(SOC2), "--channel",
                                    "fanpage"])
    assert rc == 0 and "new=3 dup=5" in capsys.readouterr().out
    assert _n(db, "social_mentions") == 24
    assert calls == []


def test_db_social_dpia_signed(db, monkeypatch, tmp_path):
    monkeypatch.setattr(ii, "RULES_FILE", _rules(True, tmp_path))
    rc, _px = _run(db, monkeypatch, ["--social", str(SOC), "--channel",
                                     "zalo_oa"])
    assert rc == 0
    rows = db.execute("select sensitive, excerpt from social_mentions"
                      ).fetchall()
    assert all(e is None for s, e in rows if s)
    assert all(e for s, e in rows if not s)
    ex = " ".join(e for _s, e in rows if e)
    for s in _social_pii():
        assert s not in ex


def test_db_cli_bad_files_change_nothing(db, monkeypatch):
    _run(db, monkeypatch, ["--competitor", str(COMP)])
    before = _counts(db)
    for argv in (["--competitor", str(FIX / "competitor_bad_gia_MAU.csv")],
                 ["--trend", str(FIX / "multiTimeline_no_anchor_MAU.csv")],
                 ["--social", str(FIX / "social_bad_cot_la_MAU.csv"),
                  "--channel", "fanpage"]):
        rc, _px = _run(db, monkeypatch, argv)
        assert rc == 1
    assert _counts(db) == before


def test_db_missing_table_hint(db, monkeypatch, capsys):
    db.execute("drop table social_mentions")
    rc, px = _run(db, monkeypatch, ["--social", str(SOC), "--channel",
                                    "fanpage"])
    assert rc == 1 and px.committed == 0
    assert "apply_schema" in capsys.readouterr().out


# ---------------------------------------------------------------- v7.2 fix


@pytest.mark.parametrize("text", [
    "uống sâm có tác dụng gì", "công dụng của sâm ngọc linh là gì",
    "sâm có tốt cho sức khỏe không", "có bổ không ạ",
    "uong sam co tac dung gi"])
def test_classify_social_health_usage_sensitive(text):
    assert "hoi_suc_khoe" in ii.classify_social(text, _rules())


@pytest.mark.parametrize("text,has_price", [
    ("đánh giá 5 sao, rất ngon", False), ("sản phẩm có giá trị", False),
    ("định giá thế nào cũng đáng giá", False),
    ("giá hộp bao nhiêu", True), ("Đánh giá tốt, giá hộp bao nhiêu", True),
    # Chỉ 'giá' mang nhãn (không có 'bao nhiêu') — bắt scrub lan quá tay
    # nuốt mất câu hỏi giá thật (mutant scrub mọi 'giá' phải đỏ).
    ("cho xin giá hộp quà", True), ("đánh giá tốt, cho xin giá sỉ", True),
    ("Giá hộp quà?", True), ("giá?", True),
])
def test_classify_social_price_scrub(text, has_price):
    assert ("hoi_gia" in ii.classify_social(text, _rules())) is has_price


def test_read_social_health_usage_no_excerpt_when_dpia(tmp_path):
    rules, errs = ii.load_social_rules(_rules(True, tmp_path))
    assert errs == [] and rules["dpia_signed"] is True
    qs = ["uống sâm có tác dụng gì", "công dụng của sâm ngọc linh là gì",
          "sâm có tốt cho sức khỏe không", "có bổ không ạ"]
    body = "".join(f"2026-10-05 08:0{i}:00,{q}\n" for i, q in enumerate(qs))
    p = _csv(tmp_path, "thoi_gian,noi_dung\n" + body
             + "2026-10-05 09:00:00,đánh giá 5 sao rất ngon\n")
    rows, errs, _ = ii.read_social(p, "fanpage", rules)
    assert errs == [] and len(rows) == 5
    for r in rows[:4]:
        assert r["sensitive"] is True and r["excerpt"] is None, r
    assert rows[4]["sensitive"] is False and rows[4]["excerpt"]
    assert rows[4]["labels"] == ["khen"]


def _xlsx(tmp_path, rows, name="c_MAU.xlsx"):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(C_HDR.split(",") + ["rating", "so_danh_gia"])
    for r in rows:
        ws.append(r)
    p = tmp_path / name
    wb.save(p)
    return p


def test_read_competitor_xlsx_date_and_float_rating(tmp_path):
    base = ["DOI-THU-MAU-1", "web", "Sâm MẪU", 150000, date(2026, 10, 6),
            "https://x.example.com/a"]
    rows, errs, _ = ii.read_competitor(
        _xlsx(tmp_path, [base + [4.5, 120], base + [5, None]]), today=TODAY)
    assert errs == [] and len(rows) == 2, errs
    assert rows[0]["observed_on"] == date(2026, 10, 6)
    assert rows[0]["rating"] == 4.5 and rows[0]["review_count"] == 120
    assert rows[1]["rating"] == 5
    # vẫn fail-closed: 2 số lẻ / > 5 / giờ khác nửa đêm
    # ô datetime xlsx có giờ → `_cell` ra "2026-10-06 09:30:00" (Excel lưu
    # naive; ghi dạng chuỗi tương đương để khỏi datetime không tz)
    bad = [base + [4.55, None], base + [5.5, None],
           base[:4] + ["2026-10-06 09:30:00"] + base[5:] + [4, None]]
    rows, errs, _ = ii.read_competitor(_xlsx(tmp_path, bad, "b_MAU.xlsx"),
                                       today=TODAY)
    assert rows == [] and errs == [
        "dòng 2: cột 'rating' không hợp lệ",
        "dòng 3: cột 'rating' không hợp lệ",
        "dòng 4: cột 'ngay_ghi' không hợp lệ"]


def test_read_trend_header_length_cap_bites(tmp_path):
    """Header ĐÚNG dạng nhưng > MAX_HEADER → lỗi; bỏ trần thì parse được
    (test này đỏ nếu mất trần chống O(n²))."""
    nl = chr(10)
    long_hdr = "quà tết: (" + "V" * 300 + ")"
    p = _csv(tmp_path, f"Week,{long_hdr}{nl}2026-10-04,1{nl}")
    _k, rows, errs, _ = ii.read_trend(p, _cfg())
    assert rows == [] and any("header cột 2" in e for e in errs), errs
    ok = _csv(tmp_path, f"Week,quà tết: ({'V' * 150}){nl}2026-10-04,1{nl}",
              name="ok_MAU.csv")
    _k, rows, errs, _ = ii.read_trend(ok, _cfg())
    assert errs == [] and len(rows) == 1


def test_db_file_name_pii_masked(db, monkeypatch, capsys, tmp_path):
    p = tmp_path / "gia_0905123456_a.b@example.com_MAU.csv"
    p.write_bytes(COMP.read_bytes())
    rc, px = _run(db, monkeypatch, ["--competitor", str(p)])
    out = capsys.readouterr().out
    assert rc == 0 and px.committed == 1 and "[load] competitor" in out
    names = " ".join(n for (n,) in db.execute(
        "select file_name from intel_imports").fetchall())
    for s in ("0905123456", "a.b@example.com"):
        assert s not in names and s not in out
