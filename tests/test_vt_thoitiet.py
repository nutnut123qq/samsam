"""v10.2 W102.4 — VT cảnh báo thời tiết & sâu bệnh (`agents.vt_thoitiet`).

Thuần: cấu hình fail-closed, CSV nhập tay, `evaluate` (replay 90 ngày đối
chiếu bộ đếm ĐỘC LẬP), digest không tọa độ/liều lượng. Mạng = `httpx.
MockTransport` qua `crawler.intel.Fetcher` (clock/sleep giả, 0 request
thật). DB THẬT trong schema tạm + docs/schema.sql + docs/roles.sql →
ROLLBACK cuối test.
"""

import json
import os
import re
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import psycopg
import pytest

from agents import vt_thoitiet as vt
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
SRC = (ROOT / "agents" / "vt_thoitiet.py").read_text(encoding="utf-8")
CFG = vt.load_config()
TH = CFG["thresholds"]
CODES = [a["code"] for a in CFG["areas"]]
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN_TZ)
DOSE_RE = re.compile(r"\d+\s*(ml|lít|l|g|gam|kg|cc|ppm)\b|/ha\b", re.IGNORECASE)
BANNED = [w.strip() for w in (ROOT / "data" / "banned_words.txt")
          .read_text(encoding="utf-8").splitlines()
          if w.strip() and not w.startswith("#")]
FORECAST = json.dumps({"daily": {
    "time": ["2026-10-15", "2026-10-16", "2026-10-17"],
    "precipitation_sum": [12.0, 80.5, None],
    "temperature_2m_min": [6.0, 4.0, 7.0],
    "temperature_2m_max": [20.0, 18.0, 22.0]}}).encode()


# ---------------------------------------------------------------- helpers


def _cfg_file(tmp_path, **over):
    doc = json.loads(vt.CONFIG_FILE.read_text(encoding="utf-8"))
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(doc.get(k), dict):
            doc[k] = {**doc[k], **v}
        else:
            doc[k] = v
    p = tmp_path / "weather.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return p


def _csv(tmp_path, lines, name="w.csv", header=True, raw=None):
    p = tmp_path / name
    if raw is not None:
        p.write_bytes(raw)
        return p
    body = ([",".join(vt.CSV_HEADER)] if header else []) + lines
    p.write_bytes(("\n".join(body) + "\n").encode("utf-8"))
    return p


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


class Mock:
    def __init__(self, routes):
        self.routes = routes
        self.reqs = []

    def __call__(self, request):
        self.reqs.append(request)
        st, body = self.routes.get((request.url.host, request.url.path),
                                   (404, b"no"))
        return httpx.Response(st, stream=httpx.ByteStream(body))


class TxConn:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

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
        schema = f"t_w102v_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


# ---------------------------------------------------------------- cấu hình


def test_real_config_is_assumption_and_rounded():
    raw = json.loads(vt.CONFIG_FILE.read_text(encoding="utf-8"))
    assert "GIẢ ĐỊNH" in raw["_doc"] and "GĐ vùng trồng" in raw["_doc"]
    assert CFG["fetch"]["enabled"] is False
    assert TH == {"rain_mm_day": 50, "tmin_c": 5}
    assert CFG["fetch"]["days"] == 7 and CFG["flag_days"] == 7
    for a in CFG["areas"]:
        for k in ("lat", "lon"):
            assert round(a[k] * 10) == a[k] * 10


@pytest.mark.parametrize("over", [
    {"areas": []}, {"areas": "x"},
    {"areas": [{"code": "a", "name": "A", "lat": 15.12, "lon": 108.0,
                "plots": []}]},
    {"areas": [{"code": "a", "name": "A", "lat": 95.0, "lon": 108.0,
                "plots": []}]},
    {"areas": [{"code": "a", "name": "A", "lat": 15.1, "lon": 181.0,
                "plots": []}]},
    {"areas": [{"code": "a", "name": "A", "lat": True, "lon": 108.0,
                "plots": []}]},
    {"areas": [{"code": "A B", "name": "A", "lat": 15.1, "lon": 108.0,
                "plots": []}]},
    {"areas": [{"code": "a", "name": "A", "lat": 15.1, "lon": 108.0,
                "plots": ["KV-1"]},
               {"code": "b", "name": "B", "lat": 15.1, "lon": 108.0,
                "plots": ["KV-1"]}]},
    {"thresholds": {"rain_mm_day": "50"}}, {"thresholds": {"tmin_c": 99}},
    {"fetch": {"enabled": "false"}},
    {"fetch": {"url_template": "http://api.example/{lat}/{lon}"}},
    {"fetch": {"url_template": "https://api.example/x"}},
    {"fetch": {"days": 0}}, {"flag_days": 0}, {"flag_days": True}])
def test_load_config_fail_closed(tmp_path, over):
    with pytest.raises(vt.ConfigError):
        vt.load_config(_cfg_file(tmp_path, **over))


def test_load_config_missing_or_broken(tmp_path):
    with pytest.raises(vt.ConfigError):
        vt.load_config(tmp_path / "khong-co.json")
    (tmp_path / "b.json").write_bytes(b"{areas")
    with pytest.raises(vt.ConfigError):
        vt.load_config(tmp_path / "b.json")


# ---------------------------------------------------------------- CSV + replay


def _replay_rows():
    """90 ngày × 2 vùng, sinh TẤT ĐỊNH (không random)."""
    rains = [0.0, 12.5, 50.0, 50.1, 120.0, 3.0, 49.9]
    tmins = [12.0, 5.0, 4.9, 8.0, 5.1, -1.0, 10.0, 6.0, 5.0, 2.5, 7.0]
    out, d0 = [], date(2026, 7, 1)
    for ai, code in enumerate(CODES):
        for i in range(90):
            out.append((code, d0 + timedelta(days=i),
                        rains[(i + ai) % len(rains)],
                        tmins[(i * 3 + ai) % len(tmins)]))
    return out


def test_replay_90_days_matches_independent_count(tmp_path):
    data = _replay_rows()
    p = _csv(tmp_path, [f"{a},{d.isoformat()},{r},{t},{t + 10}"
                        for a, d, r, t in data])
    rows, errs = vt.read_csv(p, set(CODES))
    assert errs == [] and len(rows) == 180
    alerts = vt.evaluate(rows, TH)
    # Bộ đếm ĐỘC LẬP — không gọi evaluate, so sánh literal 50/5.
    want = {(a, d) for a, d, r, t in data if r > 50 or t < 5}
    want_rain = sum(1 for _, _, r, _ in data if r > 50)
    want_cold = sum(1 for _, _, _, t in data if t < 5)
    assert {(x["area"], x["day"]) for x in alerts} == want
    assert len(alerts) == len(want) and want
    assert sum("mua_lon" in x["kinds"] for x in alerts) == want_rain
    assert sum("ret" in x["kinds"] for x in alerts) == want_cold
    # biên: đúng ngưỡng 50.0 / 5.0 KHÔNG cảnh báo; 50.1 / 4.9 có
    by = {(x["area"], x["day"]): x for x in alerts}
    for a, d, r, t in data:
        if r == 50.0 and t >= 5:
            assert (a, d) not in by
        if r == 50.1:
            assert "mua_lon" in by[(a, d)]["kinds"]
        if t == 4.9:
            assert "ret" in by[(a, d)]["kinds"]
        if t == 5.0 and r <= 50:
            assert (a, d) not in by


BAD_CSV = [
    (["vung-x,2026-10-15,1,10,20"], "area_code"),
    (["vung-a,15/10/2026,1,10,20"], "cột day"),
    (["vung-a,2026-10-15,abc,10,20"], "cột rain_mm"),
    (["vung-a,2026-10-15,1001,10,20"], "cột rain_mm"),
    (["vung-a,2026-10-15,-1,10,20"], "cột rain_mm"),
    (["vung-a,2026-10-15,nan,10,20"], "cột rain_mm"),
    (["vung-a,2026-10-15,1,-21,20"], "cột tmin_c"),
    (["vung-a,2026-10-15,1,10,inf"], "cột tmax_c"),
    (["vung-a,2026-10-15,1,10"], "cần 5 cột"),
    (["vung-a,2026-10-15,1,10,20", "vung-a,2026-10-15,2,10,20"], "trùng"),
]


@pytest.mark.parametrize("lines,msg", BAD_CSV)
def test_csv_errors_zero_processing(tmp_path, lines, msg):
    good = "vung-b,2026-10-15,120,10,20"            # dòng tốt vẫn bị bỏ
    rows, errs = vt.read_csv(_csv(tmp_path, [good, *lines]), set(CODES))
    assert rows == [] and errs and any(msg in e for e in errs)
    # lỗi KHÔNG in giá trị
    assert not any(v in e for e in errs for v in ("abc", "1001", "15/10"))


@pytest.mark.parametrize("raw,msg", [
    (b"a,b,c\n", "header"), (b"\xff\xfe\x00x", "UTF-8"),
    (b"#" * (vt.CSV_MAX + 1), "quá")], ids=["header", "utf8", "size"])
def test_csv_file_level_errors(tmp_path, raw, msg):
    rows, errs = vt.read_csv(_csv(tmp_path, [], raw=raw), set(CODES))
    assert rows == [] and any(msg in e for e in errs)


def test_csv_bom_ok(tmp_path):
    body = ("﻿" + ",".join(vt.CSV_HEADER) + "\r\nvung-a,2026-10-15,"
            "60,10,20\r\n").encode("utf-8")
    rows, errs = vt.read_csv(_csv(tmp_path, [], raw=body), set(CODES))
    assert errs == [] and rows[0]["rain_mm"] == 60.0


def test_cli_bad_csv_exit1_no_connect(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(vt, "connect", lambda: calls.append(1))
    p = _csv(tmp_path, ["vung-a,2026-10-15,abc,10,20"])
    assert vt.main(["--digest", "--from-csv", str(p)], now=NOW) == 1
    assert calls == [] and "không xử lý" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["--digest", "--from-csv", "x.csv", "--fetch"], ["--digest"],
    ["--from-csv", "x.csv"], ["--digest", "--fetch", "--max-requests", "0"],
    ["--digest", "--from-csv", "x.csv", "--date", "14/10/2026"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(vt, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        vt.main(argv, now=NOW)
    assert e.value.code == 2 and calls == []


# ---------------------------------------------------------------- open-meteo


def test_parse_open_meteo_ok_and_broken():
    rows = vt.parse_open_meteo(FORECAST, "vung-a")
    assert [r["day"].isoformat() for r in rows] == ["2026-10-15",
                                                     "2026-10-16"]
    assert vt.evaluate(rows, TH)[0]["kinds"] == ["mua_lon", "ret"]
    for body in (b"{x", b"{}", b'{"daily": {"time": ["2026-10-15"]}}',
                 json.dumps({"daily": {"time": ["2026-10-15"],
                                       "precipitation_sum": [1, 2],
                                       "temperature_2m_min": [1],
                                       "temperature_2m_max": [1]}}).encode(),
                 json.dumps({"daily": {"time": ["x"],
                                       "precipitation_sum": [1],
                                       "temperature_2m_min": [1],
                                       "temperature_2m_max": [1]}}).encode()):
        with pytest.raises(vt.SourceError):
            vt.parse_open_meteo(body, "vung-a")


# ---------------------------------------------------------------- fetch


def _fetch_cli(tmp_path, monkeypatch, routes, enabled=True, tpl=None,
               argv=("--digest", "--fetch")):
    over = {"fetch": {"enabled": enabled}}
    if tpl:
        over["fetch"]["url_template"] = tpl
    monkeypatch.setattr(vt, "CONFIG_FILE", _cfg_file(tmp_path, **over))
    monkeypatch.setattr(vt, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(vt, "connect", lambda: None)
    mock, clk = Mock(routes), Clock()
    rc = vt.main(list(argv), now=NOW, transport=httpx.MockTransport(mock),
                 sleep=clk.sleep, clock=clk.clock)
    return rc, mock, clk


def _reqs(out):
    return [json.loads(ln.split(" ", 1)[1]) for ln in out.splitlines()
            if ln.startswith("[req] ")]


H = "api.open-meteo.com"


def test_fetch_robots_first_rounded_coords_and_delay(tmp_path, monkeypatch,
                                                     capsys):
    rc, mock, _ = _fetch_cli(tmp_path, monkeypatch, {
        (H, "/robots.txt"): (200, b"User-agent: *\nAllow: /\n"),
        (H, "/v1/forecast"): (200, FORECAST)})
    out = capsys.readouterr().out
    assert rc == 0, out
    paths = [r.url.path for r in mock.reqs]
    assert paths == ["/robots.txt", "/v1/forecast", "/v1/forecast"]
    assert all(r.method == "GET" for r in mock.reqs)
    reqs = _reqs(out)
    assert len(reqs) == 3
    for r in reqs[1:]:
        q = parse_qs(urlsplit(r["url"]).query)
        for k in ("latitude", "longitude"):
            assert re.fullmatch(r"-?\d+(\.\d)?", q[k][0]), q[k]
        assert r["gap_s"] >= 1.0
    md = (tmp_path / "reports" / "vt-canh-bao-2026-10-14.md").read_text(
        encoding="utf-8")
    assert "mưa 80.5 mm" in md and "chưa nạp nhật ký" in md
    assert "[warn] chưa nạp nhật ký" in out


def test_fetch_robots_disallow_zero_forecast_get(tmp_path, monkeypatch,
                                                 capsys):
    rc, mock, _ = _fetch_cli(tmp_path, monkeypatch, {
        (H, "/robots.txt"): (200, b"User-agent: *\nDisallow: /v1/\n"),
        (H, "/v1/forecast"): (200, FORECAST)})
    out = capsys.readouterr().out
    assert rc == 0
    assert [r.url.path for r in mock.reqs] == ["/robots.txt"]
    assert out.count("[robots-deny] ") == 2
    md = (tmp_path / "reports" / "vt-canh-bao-2026-10-14.md").read_text(
        encoding="utf-8")
    assert md.count("chưa có dự báo") == 2


@pytest.mark.parametrize("tpl", [
    "https://shopee.vn/api?lat={lat}&lon={lon}&d={days}",
    "https://www.facebook.com/x?lat={lat}&lon={lon}&d={days}",
    "https://www.linkedin.com/x?lat={lat}&lon={lon}&d={days}"])
def test_fetch_blocked_host_zero_requests(tmp_path, monkeypatch, capsys, tpl):
    rc, mock, _ = _fetch_cli(tmp_path, monkeypatch, {}, tpl=tpl)
    out = capsys.readouterr().out
    assert rc == 0 and mock.reqs == []
    assert out.count("[blocked] ") >= 2


def test_fetch_disabled_exit2_zero_requests(tmp_path, monkeypatch, capsys):
    rc, mock, _ = _fetch_cli(tmp_path, monkeypatch, {}, enabled=False)
    assert rc == 2 and mock.reqs == []
    assert "chưa bật" in capsys.readouterr().out


def test_fetch_budget_and_5xx_mark_missing(tmp_path, monkeypatch, capsys):
    rc, mock, _ = _fetch_cli(tmp_path, monkeypatch, {
        (H, "/robots.txt"): (200, b"User-agent: *\nAllow: /\n"),
        (H, "/v1/forecast"): (503, b"")},
        argv=("--digest", "--fetch", "--max-requests", "2"))
    assert rc == 0 and len(mock.reqs) == 2
    md = (tmp_path / "reports" / "vt-canh-bao-2026-10-14.md").read_text(
        encoding="utf-8")
    assert md.count("chưa có dự báo") == 2
    assert "hết ngân sách" in capsys.readouterr().out


# ---------------------------------------------------------------- digest


def _digest(flags=()):
    rows = [{"area": "vung-a", "day": date(2026, 10, 15), "rain_mm": 120.0,
             "tmin_c": 4.9, "tmax_c": 20.0},
            {"area": "vung-b", "day": date(2026, 10, 15), "rain_mm": 50.0,
             "tmin_c": 5.0, "tmax_c": 20.0}]
    return vt.build_digest(
        vt.evaluate(rows, TH), list(flags),
        {a["code"]: a["plots"] for a in CFG["areas"]}, NOW,
        areas=CFG["areas"], thresholds=TH, unassigned=["KV-Z09"])


def test_digest_no_coords_no_dose_no_banned():
    md = _digest([{"plot": "KV-A01", "day": date(2026, 10, 12),
                   "flag": "sâu bệnh"}])
    assert md == _digest([{"plot": "KV-A01", "day": date(2026, 10, 12),
                           "flag": "sâu bệnh"}])            # tất định
    for p in ("KV-A01", "KV-A02", "KV-B01", "KV-Z09"):
        assert p in md
    assert "chưa gán vùng" in md
    assert "cần đi kiểm tra thoát nước" in md
    assert "cần đi kiểm tra che chắn" in md
    for a in CFG["areas"]:
        for k in ("lat", "lon"):
            assert f"{a[k]}" not in md and f"{a[k]:.1f}" not in md
    for w in ("latitude", "longitude", "location", "area_m2", "tọa độ"):
        assert w not in md.lower()
    assert not DOSE_RE.search(md)
    low = md.casefold()
    assert not [w for w in BANNED
                if re.search(rf"(?<!\w){re.escape(w.casefold())}(?!\w)", low)]
    vb = md.split("### Vùng B")[1].split("##")[0]
    assert "không vượt ngưỡng" in vb                 # 50.0 / 5.0 = biên


def test_digest_dose_regex_catches_mutant():
    assert DOSE_RE.search("phun 20 ml/bình") and DOSE_RE.search("50 g/ha")
    assert DOSE_RE.search("bón 2 kg")


# ---------------------------------------------------------------- DB


def _seed(db):
    for pid in ("KV-A01", "KV-A02", "KV-B01", "KV-Z09"):
        db.execute("insert into plots (id, location, area_m2, source) values"
                   " (%s, 'Toạ độ 15.123,107.987', 500, 'test-v102')", (pid,))
    ins = ("insert into plot_logs (plot_id, ts, activity, detail, author,"
           " source) values (%s, %s, %s, %s, 'Người Ghi Giả', 'test-v102')")
    db.execute(ins, ("KV-A01", NOW - timedelta(days=1), "kiểm tra sâu bệnh",
                     "bình thường"))
    db.execute(ins, ("KV-A02", NOW - timedelta(days=2), "kiểm tra sâu bệnh",
                     "phát hiện sâu bệnh ở góc khoảnh"))
    db.execute(ins, ("KV-B01", NOW - timedelta(days=30), "tưới",
                     "phát hiện rệp"))                  # ngoài 7 ngày


def test_pest_flags_detail_only_and_window(db):
    _seed(db)
    flags = vt.pest_flags(db, NOW, 7)
    assert flags == [{"plot": "KV-A02", "day": (NOW - timedelta(days=2))
                      .date(), "flag": "sâu bệnh"}]


def _db_cli(db, monkeypatch, tmp_path, lines, extra=()):
    monkeypatch.setattr(vt, "connect", lambda: TxConn(db))
    monkeypatch.setattr(vt, "REPORTS_DIR", tmp_path / "reports")
    p = _csv(tmp_path, lines)
    return vt.main(["--digest", "--from-csv", str(p), "--date", "2026-10-14",
                    *extra])


def _queue(db):
    return db.execute("select block, object_type, object_id, status, risk,"
                      " created_by, payload from approval_queue"
                      " order by id").fetchall()


def test_cli_submit_pending_then_skipped(db, monkeypatch, tmp_path, capsys):
    _seed(db)
    lines = ["vung-a,2026-10-15,120,10,20", "vung-b,2026-10-15,10,4.9,15"]
    assert _db_cli(db, monkeypatch, tmp_path, lines, ["--submit"]) == 0
    q = _queue(db)
    assert len(q) == 1
    assert q[0][:6] == ("farming", "weather_digest", "vt-digest:2026-10-14",
                        "pending", "medium", "agent:VT")
    payload = q[0][6]
    assert "khoảnh KV-A02: ghi nhận 'sâu bệnh'" in payload
    assert "KV-A01: ghi nhận" not in payload        # 'bình thường' → 0 cờ
    for leak in ("15.123", "107.987", "Toạ độ", "Người Ghi Giả", "500"):
        assert leak not in payload
    assert "KV-Z09: chưa gán vùng" in payload
    md = (tmp_path / "reports" / "vt-canh-bao-2026-10-14.md").read_text(
        encoding="utf-8")
    assert md == payload
    capsys.readouterr()
    assert _db_cli(db, monkeypatch, tmp_path, lines, ["--submit"]) == 0
    assert "[skipped]" in capsys.readouterr().out and len(_queue(db)) == 1


def test_cli_no_alert_no_flag_zero_submit(db, monkeypatch, tmp_path, capsys):
    db.execute("insert into plots (id, source) values ('KV-A01', 't')")
    assert _db_cli(db, monkeypatch, tmp_path,
                   ["vung-a,2026-10-15,50,5,20"], ["--submit"]) == 0
    assert _queue(db) == []
    assert "không đẩy hàng duyệt" in capsys.readouterr().out


def test_cli_db_down_weather_only(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(vt, "connect", lambda: None)
    monkeypatch.setattr(vt, "REPORTS_DIR", tmp_path / "reports")
    p = _csv(tmp_path, ["vung-a,2026-10-15,120,10,20"])
    assert vt.main(["--digest", "--from-csv", str(p), "--submit"],
                   now=NOW) == 0
    out = capsys.readouterr().out
    assert "[warn] chưa nạp nhật ký" in out and "--submit bỏ qua" in out


def test_module_no_http_client_no_llm():
    assert not re.search(r"import httpx|import requests|llm_gateway|\.post\(",
                         SRC)


@pytest.mark.parametrize("tpl", [
    "https://api.example/{lat}/{lon}/{x}", "https://api.example/{lat}/{lon}/{0}"])
def test_url_template_unknown_placeholder_fail_closed(tmp_path, tpl):
    with pytest.raises(vt.ConfigError):
        vt.load_config(_cfg_file(tmp_path, fetch={"url_template": tpl}))


@pytest.mark.parametrize("tpl", [
    "https://127.0.0.1/f?lat={lat}&lon={lon}&d={days}",
    "https://169.254.169.254/f?lat={lat}&lon={lon}&d={days}",
    "https://localhost/f?lat={lat}&lon={lon}&d={days}",
    "https://db.internal/f?lat={lat}&lon={lon}&d={days}",
    "https://[::1]/f?lat={lat}&lon={lon}&d={days}"])
def test_url_template_internal_host_rejected_ssrf(tmp_path, tpl):
    with pytest.raises(vt.ConfigError, match="SSRF"):
        vt.load_config(_cfg_file(tmp_path, fetch={"url_template": tpl}))


def test_digest_escapes_db_plot_ids():
    md = vt.build_digest([], [{"plot": "![x](https://e.x/t.png)",
                               "day": date(2026, 10, 12), "flag": "rệp"}],
                         {}, NOW, unassigned=["<img src=x>"])
    # ký tự đặc biệt chỉ được còn ở dạng đã escape (\\x)
    raw = re.compile(r"(?<!\\)(?:!\[|<img|<b>|\]\()")
    assert not raw.search(md)
    assert r"\!\[x\]" in md and r"\<img" in md
