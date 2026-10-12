"""v4.3 W43.3–W43.5 — PC-A4 rà kênh sở hữu (`agents/ra_kenh.py`).

THUẦN: `read_export` kiểm toàn file trước connect (12 case lỗi, không in
giá trị ô), `scan_row`, `load_config` fail-closed, grep ranh giới (không
egress, không SQL ghi thẳng bảng duyệt/golden). DB THẬT (schema tạm +
rollback, `set local timezone = 'UTC'`): fixture F1–F5 + P6–P8 E2E với
`now` tham số, đồng hồ 24h, red_alert S1, idempotent, kế thừa đợt, lệch
bản duyệt, `--mark-removed`, báo cáo tuần chỉ SELECT. Kết quả quét CHƯA được
Pháp chế xác nhận (external-dep); tên người trong test là giả lập.
"""

import json
import os
import re
import subprocess
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest

from agents import ra_kenh
from pipelines import approval_queue as aq
from pipelines import guardrail, store
from pipelines.period import VN_TZ
from scripts import dpia_draft

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "ra_kenh"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
CFG = ra_kenh.load_config()
U = {1: "https://samsamngoclinh.com/", 2: "http://samsam.net.vn/",
     3: "https://samsamngoclinh.com/product/savigout/",
     4: ("http://samsam.net.vn/vi/news/cam-nang-suc-khoe/"
         "savigout-xua-tan-noi-lo-benh-gout-10.html"),
     5: "https://samsam.net.vn/"}
T0 = datetime(2026, 10, 12, 9, 0, tzinfo=VN_TZ)
H = "url,kenh,is_ai,ngay_dang,draft_id,text\n"
NEUTRAL = ("Sâm Sâm chúc quý khách một tuần vui vẻ. Mời ghé cửa hàng xem"
           " sản phẩm mới.")


def _csv(tmp_path, body: str, name="x.csv", head=H, enc="utf-8") -> Path:
    p = tmp_path / name
    p.write_bytes((head + body).encode(enc))
    return p


def _no_connect(*a, **k):
    raise AssertionError("không được connect DB")


# ---------------------------------------------------------------- THUẦN
SECRET = "GIATRIDACTRUNG"
BAD = {
    "xlsx": ("x.xlsx", H + f"https://samsam.net.vn/a,web,0,,,{SECRET}\n"),
    "not_utf8": ("x.csv", None),
    "dup_header": ("x.csv", ("url,kenh,is_ai,text,text\n"
                             f"https://samsam.net.vn/a,web,0,{SECRET},"
                             f"{SECRET}\n")),
    "no_text": ("x.csv", ("url,kenh,is_ai\n"
                          f"https://samsam.net.vn/{SECRET},web,0\n")),
    "stray_col": ("x.csv", ("url,kenh,is_ai,text,ten_nguoi_binh_luan\n"
                            f"https://samsam.net.vn/a,web,0,bai viet,"
                            f"{SECRET}\n")),
    "bad_kenh": ("x.csv", H + f"https://samsam.net.vn/a,shopeee,0,,,{SECRET}\n"),
    "host_web": ("x.csv", H + f"https://{SECRET.lower()}.example/a,web,0,,,"
                 "bai viet\n"),
    "is_ai_yes": ("x.csv", H + f"https://samsam.net.vn/a,web,yes,,,{SECRET}\n"),
    "draft_abc": ("x.csv", H + f"https://samsam.net.vn/a,web,0,,abc,{SECRET}\n"),
    "bad_date": ("x.csv", H + f"https://samsam.net.vn/a,web,0,2026-13-01,,"
                 f"{SECRET}\n"),
    "dup_url": ("x.csv", H + f"https://samsam.net.vn/a,web,0,,,{SECRET}\n"
                f"https://samsam.net.vn/a,web,0,,,{SECRET}2\n"),
    "url_ctrl": ("x.csv", H + "https://samsam.net.vn/a\x1b[31m,web,0,,,"
                 + SECRET + "\n"),
    # urlsplit raise ValueError (IPv6 hỏng) → lỗi ô exit 1, không phải exit 2
    "url_ipv6": ("x.csv", H + f"http://[{SECRET.lower()}/,web,0,,,{SECRET}\n"),
    "text_long": ("x.csv", H + "https://samsam.net.vn/a,web,0,,,"
                  + SECRET + "a" * 20_001 + "\n"),
    # bài trên kênh luôn công khai — internal_note bỏ luật rượu (mất S1)
    "internal_note": ("x.csv", ("url,kenh,is_ai,loai_noi_dung,text\n"
                               "https://samsam.net.vn/a,web,0,internal_note,"
                               f"{SECRET}\n")),
    # các lỗi trước đây lọt read_export rồi nổ giữa lúc nạp (nạp dở, exit 2)
    "text_nul": ("x.csv", H + f"https://samsam.net.vn/a,web,0,,,{SECRET}"
                 "\x00x\n"),
    "draft_overflow": ("x.csv", H + "https://samsam.net.vn/a,web,0,,"
                       f"99999999999999999999,{SECRET}\n"),
    "draft_5000_digits": ("x.csv", H + "https://samsam.net.vn/a,web,0,,"
                          + "9" * 5000 + f",{SECRET}\n"),
    "url_long": ("x.csv", H + f"https://samsam.net.vn/{SECRET.lower()}"
                 + "a" * 2100 + ",web,0,,,bai viet\n"),
    # ≤ 2048 KÝ TỰ nhưng > 2704 BYTE (chữ có dấu 3 byte) — đếm ký tự lọt
    # read_export rồi nổ btree channel_posts_url_idx giữa lúc nạp (nạp dở)
    "url_long_bytes": ("x.csv", H + "https://www.facebook.com/samsam/posts/"
                       + SECRET.lower() + "ạ" * 1000 + ",facebook,0,,,"
                       "bai viet\n"),
}


@pytest.mark.parametrize("case", sorted(BAD))
def test_read_export_rejects_whole_file(tmp_path, monkeypatch, capsys, case):
    name, content = BAD[case]
    p = tmp_path / name
    if content is None:
        p.write_bytes((H + f"https://samsam.net.vn/a,web,0,,,{SECRET}"
                       " Sâm\n").encode("cp1258"))
    else:
        p.write_bytes(content.encode("utf-8"))
    monkeypatch.setattr(ra_kenh, "connect", _no_connect)
    assert ra_kenh.main(["--file", str(p), "--by", "test"]) == 1
    out = capsys.readouterr()
    assert "0 dòng nạp" in out.out
    assert SECRET not in out.out + out.err
    assert SECRET.lower() not in out.out + out.err


def test_read_export_draft_id_bigint_boundary(tmp_path):
    ok = _csv(tmp_path, f"https://samsam.net.vn/a,web,0,,{2**63 - 1},x\n",
              "ok.csv")
    assert ra_kenh.read_export(ok, CFG)[0]["draft_id"] == 2**63 - 1
    # tràn bigint / 0 / âm / chữ số toàn hình (isdigit True, không ASCII)
    for v in (2**63, 0, "-1", "１２"):
        p = _csv(tmp_path, f"https://samsam.net.vn/a,web,0,,{v},x\n", "b.csv")
        with pytest.raises(ra_kenh.ExportError) as e:
            ra_kenh.read_export(p, CFG)
        assert any("cột draft_id" in m for m in e.value.errors), v


def _url_bytes(n: int) -> str:
    """URL facebook đúng n byte UTF-8; path là chữ CJK 3 byte KHÔNG lặp
    (pglz không nén được → ca xấu nhất cho dòng btree)."""
    base = "https://www.facebook.com/samsam/posts/"
    s = base + "".join(chr(0x4E00 + (i * 7919) % 20000)
                       for i in range((n - len(base)) // 3))
    return s + "a" * (n - len(s.encode("utf-8")))


def test_read_export_url_limit_counts_bytes(tmp_path):
    ok = _url_bytes(ra_kenh.MAX_URL)
    assert len(ok.encode("utf-8")) == ra_kenh.MAX_URL and len(ok) < 1000
    p = _csv(tmp_path, f"{ok},facebook,0,,,x\n", "ok.csv")
    assert [r["url"] for r in ra_kenh.read_export(p, CFG)] == [ok]
    over = _url_bytes(ra_kenh.MAX_URL + 1)
    p = _csv(tmp_path, f"{over},facebook,0,,,x\n", "b.csv")
    with pytest.raises(ra_kenh.ExportError) as e:
        ra_kenh.read_export(p, CFG)
    msg = f"dòng 2 cột url: dài quá {ra_kenh.MAX_URL} byte UTF-8"
    assert e.value.errors == [msg]


def test_read_export_wide_header_capped(tmp_path):
    """Header rộng (file 5 MB toàn cột lạ): lỗi chỉ liệt kê 10 tên + số còn
    lại (không in cả trăm nghìn tên); đếm trùng bằng Counter (tuyến tính)."""
    p = tmp_path / "wide.csv"
    p.write_text("url,kenh,is_ai,text," + ",".join(f"c{i}" for i in range(500))
                 + ",c1\n", encoding="utf-8")
    with pytest.raises(ra_kenh.ExportError) as e:
        ra_kenh.read_export(p, CFG)
    errs = e.value.errors
    assert any("header trùng ['c1']" in m for m in errs), errs
    stray = next(m for m in errs if "cột lạ" in m)
    assert "(+491)" in stray and "c499" not in stray and len(stray) < 400


def test_read_export_crlf_scheme_defaults(tmp_path):
    a = _csv(tmp_path, 'https://samsam.net.vn/a,web,,,,"dòng 1\ndòng 2"\n',
             "a.csv")
    b = _csv(tmp_path, 'https://samsam.net.vn/a,web,,,,"dòng 1\r\ndòng 2"'
             "\r\n", "b.csv")
    ra, rb = ra_kenh.read_export(a, CFG), ra_kenh.read_export(b, CFG)
    assert ra[0]["sha"] == rb[0]["sha"] and ra[0]["text"] == "dòng 1\ndòng 2"
    assert ra[0]["is_ai"] is True and ra[0]["is_sponsored"] is False
    assert ra[0]["content_type"] == "post" and ra[0]["posted_on"] is None
    c = _csv(tmp_path, "http://samsam.net.vn/,web,0,,,x\n"
             "https://www.samsam.net.vn/,blog,0,,,x\n", "c.csv")
    rc = ra_kenh.read_export(c, CFG)
    assert [r["url"] for r in rc] == ["http://samsam.net.vn/",
                                      "https://www.samsam.net.vn/"]
    assert [r["channel"] for r in rc] == ["web", "web"]   # blog → web


def _row(text, **kw):
    return {"url": "https://samsam.net.vn/x", "channel": "web",
            "content_type": "post", "posted_on": None, "draft_id": None,
            "sku": None, "is_ai": False, "is_sponsored": False,
            "text": text} | kw


def test_scan_row_rules():
    # marker hosting KHÔNG che vi phạm nội dung (trước: chỉ còn code hosting
    # S2 → mất red_alert + ticket Pháp chế) — luôn chạy check_publish
    s = ra_kenh.scan_row(_row("Welcome to nginx! Sâm chữa bệnh"), CFG)
    assert s["kind"] == "content" and s["severity"] == "S1"
    assert "tu_cam" in s["codes"]
    assert s["codes"][-1] == "trang_mac_dinh_hosting"
    s = ra_kenh.scan_row(_row("Default Web Page\nThis is the default web"
                              " page for this server."), CFG)
    assert s["codes"] == ["trang_mac_dinh_hosting"] and s["kind"] == "hosting"
    assert s["severity"] == "S2"
    # marker chỉ xét kênh web — câu thường gặp trên MXH không thành hạ tầng
    fb = "https://facebook.com/samsam/posts/1"
    s = ra_kenh.scan_row(_row("Website đang được xây dựng. Sâm Ngọc Linh chữa"
                              " khỏi ung thư, thuốc quý", channel="facebook",
                              url=fb), CFG)
    assert s["kind"] == "content" and s["severity"] == "S1"
    assert "tu_cam" in s["codes"]
    assert "trang_mac_dinh_hosting" not in s["codes"]
    s = ra_kenh.scan_row(_row("Website đang được xây dựng. " + NEUTRAL,
                              channel="facebook", url=fb,
                              posted_on=date(2021, 1, 11)), CFG)
    assert s["kind"] == "content" and s["codes"] == []
    assert s["severity"] is None
    for posted in (None, date(2026, 10, 12)):
        s = ra_kenh.scan_row(_row(NEUTRAL, posted_on=posted), CFG)
        assert s["codes"] == ["thieu_ban_duyet"] and s["severity"] == "S2"
    s = ra_kenh.scan_row(_row(NEUTRAL, posted_on=date(2021, 1, 11)), CFG)
    assert s["codes"] == [] and s["severity"] is None
    s = ra_kenh.scan_row(_row(NEUTRAL, draft_id=5), CFG)
    assert s["severity"] is None          # lệch bản duyệt kiểm ở ingest (DB)
    s = ra_kenh.scan_row(_row("Mật ong sâm 300ml — hũ thủy tinh, giao hàng"
                              " toàn quốc.", sku="mat-ong-sam-300ml",
                              posted_on=date(2021, 1, 11)), CFG)
    assert {w["code"] for w in s["guardrail"]["warnings"]} == \
        {"sku_chua_mo_kenh"}
    assert s["codes"] == [] and s["severity"] is None   # warn → không ticket
    s = ra_kenh.scan_row(_row("Sâm chữa khỏi bệnh gout, gọi 0912 345 678",
                              posted_on=date(2021, 1, 11)), CFG)
    assert s["severity"] == "S1" and "tu_cam" in s["codes"]
    assert "0912 345 678" not in s["excerpt"] and len(s["excerpt"]) <= 160


@pytest.mark.parametrize("phone", ["0912345678", "0912 345 678",
                                   "0912.345.678"])
def test_excerpt_masks_phone_across_window_edge(phone):
    """Che PII toàn văn TRƯỚC khi cắt: SĐT vắt mép cửa sổ ±60 (đầu hoặc
    cuối, có/không khoảng trắng) không lộ chữ số nào."""
    viol = "Sâm chữa khỏi bệnh gout"
    for k in range(100):
        for text in (f"Hotline {phone} {'x' * k} {viol}",
                     f"{viol} {'x' * k} {phone} hết",
                     f"Hotline {phone}{'x' * k}{viol}",
                     f"{viol}{'x' * k}{phone}"):
            s = ra_kenh.scan_row(_row(text, posted_on=date(2021, 1, 11)), CFG)
            assert s["severity"] == "S1"
            assert not re.search(r"\d", s["excerpt"]), (k, text, s["excerpt"])
            assert "chữa" in s["excerpt"] and len(s["excerpt"]) <= 160


@pytest.mark.parametrize("doc", [
    None, "{hỏng", {}, {"_doc": "x"},
    {"xnqc": {"dot2_han_nop": "30/11/2026", "nhac_truoc_ngay": 14,
              "het_han_canh_bao_ngay": 30}},
    "neg", "bool", "empty_hosts", "bad_marker"])
def test_load_config_fail_closed(tmp_path, doc):
    good = json.loads((ROOT / "data" / "phap_che.json").read_text("utf-8"))
    p = tmp_path / "phap_che.json"
    if doc == "neg":
        good["xnqc"]["nhac_truoc_ngay"] = -1
        doc = good
    elif doc == "bool":
        good["xnqc"]["het_han_canh_bao_ngay"] = True
        doc = good
    elif doc == "empty_hosts":
        good["ra_kenh"]["owned_web_hosts"] = []
        doc = good
    elif doc == "bad_marker":
        good["ra_kenh"]["hosting_default_markers"] = ["  "]
        doc = good
    elif isinstance(doc, dict) and "xnqc" in doc:
        doc = good | {"xnqc": doc["xnqc"]}
    if doc is not None:
        p.write_text(doc if isinstance(doc, str) else json.dumps(doc),
                     encoding="utf-8")
    with pytest.raises(ValueError):
        ra_kenh.load_config(p)


@pytest.mark.parametrize("by,ok", [
    ("Quản lý MXH", True), ("", False), ("   ", False), ("agent:x", False),
    ("  AGENT : x", False), ("System:y", False), ("Ten\x00", False),
    ("a\u202eb", False), ("x" * 101, False)])
def test_by_rule(by, ok):
    assert (ra_kenh.by_error(by) is None) is ok


def test_grep_no_egress_no_direct_writes():
    eg = dpia_draft.egress_modules(ROOT)
    for mod in ("agents/ra_kenh.py", "agents/xnqc.py"):
        assert mod not in eg
        src = (ROOT / mod).read_text(encoding="utf-8")
        for w in ("wp-json", "urlopen", "requests", "httpx",
                  "graph.facebook"):
            assert w not in src, (mod, w)
        assert not re.search(
            r"(insert\s+into|update|delete\s+from)\s+(sku_master|price_list|"
            r"content_drafts|approvals|approval_queue|red_alerts)\b", src,
            re.IGNORECASE), mod
        assert not re.search(r"(write_text|write_bytes|open\()[^\n]*golden",
                             src, re.IGNORECASE), mod


def test_dry_run_fixture_no_connect(monkeypatch, capsys):
    monkeypatch.setattr(ra_kenh, "connect", _no_connect)
    assert ra_kenh.main(["--file", str(FIX / "f1_f5.csv"), "--by", "test",
                         "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "chưa kiểm lệch bản duyệt" in out
    lines = [ln for ln in out.splitlines() if ln.startswith("[")][1:]
    sev = {ln.split()[3]: ln.split("]")[0][1:] for ln in lines}
    assert sev == {U[1]: "S1", U[2]: "S2", U[3]: "S1", U[4]: "S1",
                   U[5]: "S2"}, out
    f5 = next(ln for ln in lines if ln.split()[3] == U[5])
    assert "— trang_mac_dinh_hosting → ticket hosting_fix" in f5
    f4 = next(ln for ln in lines if ln.split()[3] == U[4])
    assert "thieu_ban_duyet" not in f4 and "tu_cam" in f4
    f2 = next(ln for ln in lines if ln.split()[3] == U[2])
    assert "ngoc_linh_chua_xac_nhan, thieu_ban_duyet →" in f2
    assert "red_alert" not in f2


@pytest.mark.parametrize("argv", [
    [], ["--report", "--file", "x.csv", "--by", "A"],
    ["--report", "--days", "0"], ["--report", "--days", "367"],
    ["--report", "--now", "12/10/2026"], ["--report", "--dry-run"],
    ["--file", "x.csv", "--by", "agent:x"], ["--mark-removed", "u"],
    ["--mark-removed", "u", "--by", "system: y"],
    # --now CHỈ cho --report/--dry-run: lùi giờ ghi = giả "đúng hạn"
    ["--file", "x.csv", "--by", "A", "--now", "2026-10-12T09:00"],
    ["--mark-removed", "u", "--by", "A", "--now", "2026-10-12T09:00"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(ra_kenh, "connect", _no_connect)
    with pytest.raises(SystemExit) as e:
        ra_kenh.main(argv)
    assert e.value.code == 2


def test_cli_help_and_db_down():
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, "-m", "agents.ra_kenh", "--help"],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 0 and "+07:00" in r.stdout
    env["DATABASE_URL"] = "postgresql://u@10.255.255.1:5432/x"
    r = subprocess.run([sys.executable, "-m", "agents.ra_kenh", "--report"],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2 and "DB không truy cập được" in r.stdout


# ---------------------------------------------------------------- DB THẬT
class _TxConn:
    """commit/rollback/close CHỈ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn, log=None):
        self.conn = conn
        self.log = log

    def execute(self, sql, *a, **kw):
        if self.log is not None:
            self.log.append(str(sql))
        return self.conn.execute(sql, *a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


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
        conn.execute("set local timezone = 'UTC'")
        schema = f"t_w43r_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        yield conn
    finally:
        conn.rollback()
        conn.close()


def _n(db, table, where="true"):
    return db.execute(f"select count(*) from {table} where {where}"
                      ).fetchone()[0]


def _counts(db):
    return tuple(_n(db, t) for t in ("channel_posts", "approval_queue",
                                     "red_alerts"))


def _latest(db, url):
    cols = ("id", "codes", "severity", "first_detected_at", "due_at",
            "queue_id", "alert_id", "closed_at", "close_reason")
    r = db.execute(f"select {', '.join(cols)} from channel_posts where url"
                   " = %s order by id desc limit 1", (url,)).fetchone()
    return dict(zip(cols, r))


def _load(tx, path, now, by="Quản lý MXH (test)"):
    return ra_kenh.ingest(tx, ra_kenh.read_export(path, CFG), CFG, by=by,
                          now=now)


def _drafts(tx):
    g = guardrail.check(NEUTRAL)
    assert g["ok"] and guardrail.check_publish(
        NEUTRAL, channel="facebook", is_ai=False)["ok"]
    did = store.save_draft(tx, "brief test", "facebook", NEUTRAL, g,
                           created_by="agent:mkt-test")
    assert store.set_status(tx, did, "approved", "Phap Che Gia Lap") == \
        (True, None)
    return did


def _p_csv(tmp_path, did, p7_text, name):
    rows = [f"https://facebook.com/samsam/posts/6,facebook,0,,{did},{NEUTRAL}",
            f"https://facebook.com/samsam/posts/7,facebook,0,,{did},{p7_text}",
            (f"https://facebook.com/samsam/posts/8,facebook,0,2026-10-13,,"
             f"{NEUTRAL}")]
    return _csv(tmp_path, "\n".join(rows) + "\n", name)


def test_e2e_f1_f5_p6_p8_and_report(db, tmp_path, monkeypatch, capsys):
    tx = _TxConn(db)
    st = _load(tx, FIX / "f1_f5.csv", T0)
    assert (st["new"], st["S1"], st["S2"], st["tickets"], st["alerts"]) == \
        (5, 3, 2, 5, 3)
    q = db.execute("select object_type, block, payload, id, object_id,"
                   " due_at - created_at from approval_queue order by id"
                   ).fetchall()
    assert [(t, b) for t, b, *_ in q].count(("channel_takedown",
                                              "legal_hr")) == 4
    assert [(t, b) for t, b, *_ in q].count(("hosting_fix",
                                              "data_platform")) == 1
    assert all(sla == timedelta(hours=24) for *_, sla in q)
    post = {k: _latest(db, U[k]) for k in U}
    for k, p in post.items():
        assert p["due_at"] - p["first_detected_at"] == timedelta(hours=24)
        assert p["due_at"] == datetime(2026, 10, 13, 9, 0, tzinfo=VN_TZ)
        assert p["queue_id"] is not None and p["closed_at"] is None
        assert (p["alert_id"] is not None) is (k in (1, 3, 4)), k
    assert post[5]["codes"] == ["trang_mac_dinh_hosting"]
    assert "thieu_ban_duyet" not in post[4]["codes"]
    assert post[2]["codes"] == ["ngoc_linh_chua_xac_nhan", "thieu_ban_duyet"]
    assert {"ruou_cam_quang_cao", "tu_cam", "sku_chua_xnqc",
            "thieu_khuyen_cao"} <= set(post[1]["codes"])
    assert {"sku_chua_xnqc", "thieu_khuyen_cao", "claim_ngoai_cong_bo"} <= \
        set(post[3]["codes"])
    alerts = db.execute("select title, route_error, detail from red_alerts"
                        " order by id").fetchall()
    assert len(alerts) == 3 and all(r for _, r, _ in alerts)
    assert {d["post_id"] for *_, d in alerts} == {post[k]["id"]
                                                 for k in (1, 3, 4)}
    for _, _, payload, qid, oid, _ in q:
        assert guardrail.check(payload)["ok"] is True
        assert "chữa" not in payload and "thuốc" not in payload
        assert "agent không gỡ/sửa" in payload
    assert aq.decide(tx, post[1]["queue_id"], "Pháp chế A", "approved") == \
        (True, None)
    assert _latest(db, U[1])["closed_at"] is None       # approve ≠ đóng
    # nạp lại y hệt → 0 mới
    before = _counts(db)
    st = _load(tx, FIX / "f1_f5.csv", T0 + timedelta(hours=1))
    assert st["new"] == 0 and st["skip"] == 5 and _counts(db) == before
    # F4 quét lại sau khi người sửa: hết từ cấm, đồng hồ KHÔNG reset
    t3 = T0 + timedelta(hours=3)
    st = _load(tx, FIX / "f4_quet_lai.csv", t3)
    assert (st["new"], st["tickets"], st["alerts"]) == (1, 0, 0)
    f4 = _latest(db, U[4])
    assert "tu_cam" not in f4["codes"] and "sku_chua_xnqc" in f4["codes"]
    for k in ("first_detected_at", "due_at", "queue_id", "alert_id"):
        assert f4[k] == post[4][k], k
    assert db.execute("select close_reason from channel_posts where id = %s",
                      (post[4]["id"],)).fetchone()[0] == "thay_ban_moi"
    # revert về text gốc → snapshot mới, mở lại tu_cam (vẫn cùng đợt)
    before = _counts(db)
    st = _load(tx, FIX / "f1_f5.csv", t3)
    assert st["new"] == 1 and _counts(db)[1:] == before[1:]
    f4b = _latest(db, U[4])
    assert "tu_cam" in f4b["codes"] and f4b["due_at"] == post[4]["due_at"]
    # P6–P8: đối chiếu bản duyệt
    did = _drafts(tx)
    st = _load(tx, _p_csv(tmp_path, did, NEUTRAL + "!", "p.csv"), t3)
    p6, p7, p8 = (_latest(db, f"https://facebook.com/samsam/posts/{i}")
                  for i in (6, 7, 8))
    assert p6["severity"] is None and p6["queue_id"] is None
    assert store.verify_publish(tx, did, NEUTRAL + "!") is False
    assert p7["codes"] == ["lech_ban_duyet"] and p7["severity"] == "S2"
    assert p7["queue_id"] and p7["alert_id"] is None
    assert p8["codes"] == ["thieu_ban_duyet"] and p8["severity"] == "S2"
    assert (st["tickets"], st["alerts"]) == (2, 0)
    st = _load(tx, _p_csv(tmp_path, did, NEUTRAL, "p2.csv"), t3)
    assert db.execute("select close_reason from channel_posts where id = %s",
                      (p7["id"],)).fetchone()[0] == "da_sua"
    assert db.execute("select actor, detail->'ids' from agent_action_log"
                      " where action = 'channel_post_fixed'").fetchall() == \
        [("Quản lý MXH (test)", [p7["id"]])]
    # mục F3 bị Pháp chế reject, F5 expired → vi phạm VẪN mở
    assert aq.decide(tx, post[3]["queue_id"], "Pháp chế A", "rejected") == \
        (True, None)
    db.execute("update approval_queue set status = 'expired', decided_by ="
               " 'system:sla' where id = %s", (post[5]["queue_id"],))
    assert _latest(db, U[3])["closed_at"] is None
    assert _latest(db, U[5])["closed_at"] is None

    # ---- W43.5 báo cáo (chỉ SELECT)
    log: list = []
    rc = _TxConn(db, log)
    before = _counts(db)
    noon = T0 + timedelta(hours=3)
    rep = ra_kenh.collect_report(rc, noon, 7)
    assert _counts(db) == before and log
    assert all(re.match(r"\s*(select|with)\b", s, re.IGNORECASE) for s in log), log
    s1 = [d["url"] for d in rep["open"] if d["severity"] == "S1"]
    assert sorted(s1) == sorted([U[1], U[3], U[4]])
    assert [d["severity"] for d in rep["open"]][:3] == ["S1"] * 3
    s2 = {d["url"] for d in rep["open"] if d["severity"] == "S2"}
    assert s2 == {U[2], U[5], "https://facebook.com/samsam/posts/8"}
    assert not [d for d in rep["open"] if noon > d["due_at"]]
    assert [c["reason"] for c in rep["closed"]] == ["da_sua"]
    text = ra_kenh.render_report(rep, noon)
    assert "đúng hạn 1, trễ 0" in text and "### QUÁ 24H — 0" in text
    assert "CẢNH BÁO" in text and U[1] in text
    assert "chữa" not in text and "thuốc" not in text
    for h in ("## 1.", "## 2.", "## 3.", "## 4.", "## 5."):
        assert h in text
    assert "lech_ban_duyet: đang mở 0, phát hiện trong kỳ 1" in text
    assert "thieu_ban_duyet: đang mở 4, phát hiện trong kỳ 4" in text
    # --mark-removed qua CLI
    monkeypatch.setattr(ra_kenh, "connect", lambda: _TxConn(db))
    with pytest.raises(SystemExit) as e:
        ra_kenh.main(["--mark-removed", U[2], "--by", "agent:x"])
    assert e.value.code == 2 and _latest(db, U[2])["closed_at"] is None
    monkeypatch.setattr(ra_kenh, "_now", lambda: T0 + timedelta(hours=4))
    assert ra_kenh.main(["--mark-removed", U[2], "--by", "Quản lý MXH"]) == 0
    f2 = _latest(db, U[2])
    assert f2["close_reason"] == "da_go"
    assert f2["closed_at"] == T0 + timedelta(hours=4)
    assert ra_kenh.main(["--mark-removed", U[2], "--by", "Quản lý MXH"]) == 1
    assert ra_kenh.main(["--mark-removed", "https://samsam.net.vn/khong",
                         "--by", "Quản lý MXH"]) == 1
    due = post[1]["due_at"]
    rep = ra_kenh.collect_report(rc, due, 7)           # biên: = due → chưa quá
    assert not [d for d in rep["open"] if due > d["due_at"]]
    after = due + timedelta(seconds=1)
    rep = ra_kenh.collect_report(rc, after, 7)
    over = {d["url"] for d in rep["open"] if after > d["due_at"]}
    assert over == {U[1], U[3], U[4], U[5]}            # F2 đã da_go
    text = ra_kenh.render_report(rep, after)
    assert "### QUÁ 24H — 4" in text and "QUÁ 0.0 giờ" in text
    # CLI --report ghi file vào thư mục báo cáo (tmp)
    monkeypatch.setattr(ra_kenh, "REPORTS_DIR", tmp_path / "reports")
    capsys.readouterr()
    assert ra_kenh.main(["--report", "--now", "2026-10-13T09:00:01"]) == 0
    assert (tmp_path / "reports" / "phap-che-tuan-2026-10-13.md").is_file()
    assert "QUÁ 24H — 4" in capsys.readouterr().out


def test_mark_removed_then_still_exported_reopens(db):
    tx = _TxConn(db)
    _load(tx, FIX / "f1_f5.csv", T0)
    ok, _ = ra_kenh.mark_removed(tx, U[2], "Quản lý MXH", T0)
    assert ok
    log = db.execute("select actor, object_type from agent_action_log where"
                     " action = 'channel_post_removed'").fetchall()
    assert log == [("Quản lý MXH", "channel_post")]
    assert db.execute("select * from verify_action_log()").fetchall() == []
    assert ra_kenh.mark_removed(tx, U[2], "agent:x", T0)[0] is False
    t = T0 + timedelta(hours=30)
    st = _load(tx, FIX / "f1_f5.csv", t)
    assert st["new"] == 1 and st["tickets"] == 1
    p = _latest(db, U[2])
    assert p["first_detected_at"] == t and p["closed_at"] is None


def test_ingest_cli_prints_masked(db, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(ra_kenh, "connect", lambda: _TxConn(db))
    monkeypatch.setattr(ra_kenh, "_now", lambda: T0)
    p = _csv(tmp_path, "https://samsam.net.vn/a,web,0,2021-01-11,,"
             "Sâm chữa khỏi bệnh — gọi 0912 345 678\n")
    assert ra_kenh.main(["--file", str(p), "--by", "Quản lý MXH"]) == 0
    out = capsys.readouterr().out
    assert "mới 1" in out and "red_alert mới 1" in out
    assert "0912 345 678" not in out and "13/10/2026 09:00" in out
    title = db.execute("select title from red_alerts").fetchone()[0]
    assert title == "S1 web: https://samsam.net.vn/a"


def test_link_heals_after_crash(db, monkeypatch):
    """Sự cố giữa snapshot và mục hàng duyệt → nạp lại gắn lại, không trùng."""
    tx = _TxConn(db)
    real = ra_kenh._link
    monkeypatch.setattr(ra_kenh, "_link", lambda *a, **k: None)
    _load(tx, FIX / "f4_quet_lai.csv", T0)
    p = _latest(db, U[4])
    assert p["queue_id"] is None and p["alert_id"] is None
    monkeypatch.setattr(ra_kenh, "_link", real)
    st = _load(tx, FIX / "f4_quet_lai.csv", T0)
    assert st["skip"] == 1 and (st["tickets"], st["alerts"]) == (1, 1)
    p = _latest(db, U[4])
    assert p["queue_id"] and p["alert_id"]
    st = _load(tx, FIX / "f4_quet_lai.csv", T0)
    assert (st["tickets"], st["alerts"]) == (0, 0)
    assert _n(db, "approval_queue") == 1 and _n(db, "red_alerts") == 1


FB = "https://facebook.com/samsam/posts/"


def test_reimport_same_text_rescans_meta_and_rules(db, tmp_path, monkeypatch):
    """Cùng text_sha256 KHÔNG đủ để bỏ qua: cột bài (draft_id...) hoặc luật
    guardrail đổi → rà lại ra snapshot mới; cùng file y hệt → 0 mới."""
    tx = _TxConn(db)
    a = _csv(tmp_path, f"{FB}1,facebook,0,,,{NEUTRAL}\n"
             f"{FB}2,facebook,0,2021-01-11,,{NEUTRAL}\n", "a.csv")
    st = _load(tx, a, T0)
    assert (st["new"], st["S2"], st["tickets"]) == (2, 1, 1)
    p1 = _latest(db, FB + "1")
    assert p1["codes"] == ["thieu_ban_duyet"]
    assert _latest(db, FB + "2")["severity"] is None
    before = _counts(db)
    st = _load(tx, a, T0 + timedelta(hours=1))            # cùng file → 0 mới
    assert (st["new"], st["skip"]) == (0, 2) and _counts(db) == before
    # thêm draft_id bản đã duyệt (text y hệt) → sạch, đóng da_sua (trước:
    # skip vì cùng sha → vi phạm treo tới QUÁ 24H)
    did = _drafts(tx)
    t2 = T0 + timedelta(hours=2)
    st = _load(tx, _csv(tmp_path, f"{FB}1,facebook,0,,{did},{NEUTRAL}\n",
                        "b.csv"), t2)
    assert (st["new"], st["closed"], st["tickets"]) == (1, 1, 0)
    assert _latest(db, FB + "1")["severity"] is None
    old = db.execute("select close_reason, closed_at from channel_posts where"
                     " id = %s", (p1["id"],)).fetchone()
    assert old == ("da_sua", t2)
    assert db.execute("select detail->'ids' from agent_action_log where"
                      " action = 'channel_post_fixed'").fetchall() == \
        [([p1["id"]],)]
    assert db.execute("select * from verify_action_log()").fetchall() == []
    # luật chặt hơn (vd golden none → sku_chua_xnqc) → bài từng sạch nay S1
    real = guardrail.check_publish

    def strict(text, **kw):
        g = real(text, **kw)
        v = {"code": "tu_cam", "severity": "critical", "type": "banned_word",
             "detail": "luật mới", "span": text[:3], "start": 0, "end": 3}
        return dict(g, ok=False, violations=g["violations"] + [v])

    monkeypatch.setattr(guardrail, "check_publish", strict)
    t3 = T0 + timedelta(hours=3)
    st = _load(tx, a, t3)
    assert (st["new"], st["S1"], st["tickets"], st["alerts"]) == (2, 2, 2, 2)
    p2 = _latest(db, FB + "2")
    assert p2["codes"] == ["tu_cam"] and p2["due_at"] == t3 + timedelta(hours=24)
    st = _load(tx, a, t3)                                  # luật mới, y hệt
    assert (st["new"], st["skip"], st["tickets"], st["alerts"]) == (0, 2, 0, 0)


def test_kind_change_opens_new_dot_in_right_block(db, tmp_path):
    """Hạ tầng ↔ nội dung trên cùng URL KHÔNG kế thừa ticket khối khác:
    đóng đợt cũ, mở đợt mới (hạn mới, ticket đúng khối)."""
    tx = _TxConn(db)
    url = "https://samsam.net.vn/k"

    def load(text, h):
        st = _load(tx, _csv(tmp_path, f"{url},web,0,,,{text}\n",
                            f"k{h}.csv"), T0 + timedelta(hours=h))
        return st, _latest(db, url)

    def tickets():
        return db.execute("select object_type, block from approval_queue"
                          " order by id").fetchall()

    st, p0 = load("Welcome to nginx!", 0)
    assert p0["codes"] == ["trang_mac_dinh_hosting"]
    assert tickets() == [("hosting_fix", "data_platform")]
    # trang mặc định + vi phạm nội dung → đợt nội dung mới (Pháp chế + alert)
    st, p1 = load("Welcome to nginx! Sâm chữa khỏi bệnh gout", 1)
    assert p1["severity"] == "S1" and "tu_cam" in p1["codes"]
    assert "trang_mac_dinh_hosting" in p1["codes"]
    assert p1["due_at"] == T0 + timedelta(hours=25)
    assert tickets()[-1] == ("channel_takedown", "legal_hr")
    assert (st["tickets"], st["alerts"]) == (1, 1) and p1["alert_id"]
    assert db.execute("select close_reason from channel_posts where id = %s",
                      (p0["id"],)).fetchone()[0] == "thay_ban_moi"
    # nội dung hết, chỉ còn trang mặc định → đóng đợt nội dung da_sua, mở
    # đợt hạ tầng mới
    st, p2 = load("Welcome to nginx!", 2)
    assert p2["codes"] == ["trang_mac_dinh_hosting"] and p2["alert_id"] is None
    assert p2["due_at"] == T0 + timedelta(hours=26)
    assert tickets()[-1] == ("hosting_fix", "data_platform")
    assert (st["tickets"], st["closed"]) == (1, 1)
    assert db.execute("select close_reason from channel_posts where id = %s",
                      (p1["id"],)).fetchone()[0] == "da_sua"
    # hạ tầng sửa xong, trang thật có vi phạm → đợt nội dung mới
    st, p3 = load("Sâm chữa khỏi bệnh gout", 3)
    assert "trang_mac_dinh_hosting" not in p3["codes"]
    assert p3["severity"] == "S1" and p3["due_at"] == T0 + timedelta(hours=27)
    assert db.execute("select close_reason from channel_posts where id = %s",
                      (p2["id"],)).fetchone()[0] == "da_sua"
    assert tickets() == [
        ("hosting_fix", "data_platform"), ("channel_takedown", "legal_hr"),
        ("hosting_fix", "data_platform"), ("channel_takedown", "legal_hr")]
    assert _n(db, "red_alerts") == 2


def test_s2_to_s1_same_dot_raises_alert(db, tmp_path):
    """Leo thang S2 → S1 trong cùng đợt: kế thừa ticket, BẮN red_alert."""
    tx = _TxConn(db)
    url = "https://samsam.net.vn/s"
    _load(tx, _csv(tmp_path, f"{url},web,0,,,{NEUTRAL}\n", "s1.csv"), T0)
    p = _latest(db, url)
    assert p["codes"] == ["thieu_ban_duyet"] and p["alert_id"] is None
    st = _load(tx, _csv(tmp_path, f"{url},web,0,,,Sâm chữa khỏi bệnh gout\n",
                        "s2.csv"), T0 + timedelta(hours=2))
    q = _latest(db, url)
    assert (st["tickets"], st["alerts"]) == (0, 1)
    assert q["severity"] == "S1" and q["alert_id"] is not None
    assert (q["queue_id"], q["due_at"]) == (p["queue_id"], p["due_at"])


def test_url_max_bytes_fits_btree(db, tmp_path):
    """URL đúng MAX_URL byte, CJK không lặp (không nén) + S1 → vào được cả
    channel_posts_url_idx lẫn index đợt mở (trần btree 2704 byte/dòng)."""
    tx = _TxConn(db)
    url = _url_bytes(ra_kenh.MAX_URL)
    st = _load(tx, _csv(tmp_path, f"{url},facebook,0,,,Sâm chữa khỏi bệnh"
                        " gout\n"), T0)
    assert (st["new"], st["alerts"]) == (1, 1)
    assert _latest(db, url)["severity"] == "S1"
    assert ra_kenh.mark_removed(tx, url, "Quản lý MXH", T0)[0] is True
