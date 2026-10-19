"""v7.2 — `scripts/intel_weekly.py` (báo cáo tuần intel, tất định, chỉ đọc).

DB thật (samsam_infra) trong schema tạm + ROLLBACK; dữ liệu = fixture MẪU
nạp qua hàm của `ingest.intel_import` + vài `intel_items` chèn tay. LLM
luôn là spy (không gọi mạng).
"""

import importlib.util
import json
import os
import types
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import pytest

from ingest import golden_store as gs
from ingest import intel_import as ii
from pipelines import llm_gateway

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "intel_import"
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
SALT = "salt-test-MAU-0123456789"
WEEK = "2026-10-08"   # tuần 2026-10-05 → 2026-10-11 (tuần cài spike)

_spec = importlib.util.spec_from_file_location(
    "intel_weekly", ROOT / "scripts" / "intel_weekly.py")
iw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(iw)

HEADS = ("## 1. Đối thủ", "## 2. Trend", "## 3. Social", "## 4. Tin thị trường")


def _social_strings():
    import csv
    out = set()
    for f in ("social_fanpage_MAU.csv", "social_fanpage_2_MAU.csv"):
        with open(FIX / f, encoding="utf-8", newline="") as fh:
            for r in csv.DictReader(fh):
                out |= {r["ten_nguoi_dung"], r["id_nguoi_dung"], r["sdt"],
                        r["noi_dung"], r["ma_tin"]}
    return out | {"0912 345 678", "khach.mau7@example.com"}


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
        schema = f"t_iweekly_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        yield conn
    finally:
        conn.rollback()
        conn.close()


class Ro:
    """Proxy conn: chỉ execute; close no-op (dữ liệu ở lại tx fixture)."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def close(self):
        pass


def _seed(db):
    cfg, _ = ii.load_trend_config(ii.KEYWORDS_FILE)
    rules, _ = ii.load_social_rules(ii.RULES_FILE)
    # golden nạp từ file có valid_from = hôm nay → thêm giá web hiệu lực từ
    # đầu năm cho 1 SKU để có dòng so được (chưa duyệt).
    db.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
               " valid_from) values ('savina-12v', 'web', 'list', 160000,"
               " '2026-01-01')")
    rows, errs, sha = ii.read_competitor(FIX / "competitor_MAU.csv")
    assert not errs
    assert ii.load_competitor(db, rows, "competitor_MAU.csv", sha)[1] == []
    _k, rows, errs, sha = ii.read_trend(FIX / "multiTimeline_MAU.csv", cfg)
    ii.load_trend_timeline(db, rows, cfg, "multiTimeline_MAU.csv", sha)
    _k, rows, errs, sha = ii.read_trend(FIX / "relatedQueries_MAU.csv", cfg)
    ii.load_trend_related(db, rows, "nhân sâm", "relatedQueries_MAU.csv", sha)
    rows, errs, sha = ii.read_social(FIX / "social_fanpage_MAU.csv",
                                     "fanpage", rules)
    ii.load_social(db, rows, "fanpage", SALT, "social_fanpage_MAU.csv", sha)
    vn = ii.VN_TZ
    for i, (t, topics, day) in enumerate((
            ("Tin MẪU sâm ngọc linh mùa thu hoạch", ["sam"], 6),
            ("Tin MẪU quảng cáo TPBVSK bị phạt", ["quang_cao", "tpbvsk"], 7),
            ("Tin MẪU tuần trước", ["sam"], 1))):
        db.execute(
            "insert into intel_items (url, domain, source, tier, title,"
            " fetched_at, content_sha256, topics) values (%s, 'bao.example.vn',"
            " 'fx', 'A', %s, %s, %s, %s)",
            (f"https://bao.example.vn/{i}", t,
             datetime(2026, 10, day, 9, 0, tzinfo=vn), f"sha-{i}", topics))


def _main(db, monkeypatch, capsys, argv):
    n = {"connect": 0}

    def fake(dsn):
        n["connect"] += 1
        return Ro(db)
    monkeypatch.setattr(iw, "_connect", fake)
    monkeypatch.setattr(iw, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    try:
        rc = iw.main(argv)
    except SystemExit as e:
        rc = e.code
    out = capsys.readouterr()
    return rc, out.out, out.err, n["connect"]


@pytest.fixture
def chat_spy(monkeypatch):
    calls = []
    reply = {"text": "Tuần này giá đối thủ thấp hơn golden ở 2 SKU."}

    def fake(agent_id, messages, **kw):
        calls.append((agent_id, messages))
        if isinstance(reply["text"], Exception):
            raise reply["text"]
        msg = types.SimpleNamespace(content=reply["text"])
        return types.SimpleNamespace(
            choices=[types.SimpleNamespace(message=msg)])
    monkeypatch.setattr(llm_gateway, "chat", fake)
    return calls, reply


def test_report_deterministic_sections_spike(db, monkeypatch, capsys,
                                             chat_spy):
    _seed(db)
    rc1, out1, _e, _n = _main(db, monkeypatch, capsys, ["--week", WEEK])
    rc2, out2, _e, _n = _main(db, monkeypatch, capsys, ["--week", WEEK])
    assert rc1 == rc2 == 0 and out1.encode() == out2.encode()
    for h in HEADS:
        assert h in out1
    assert "# Báo cáo tuần intel 2026-10-05 → 2026-10-11" in out1
    spikes = [ln for ln in out1.splitlines() if "TĂNG ĐỘT BIẾN" in ln]
    assert len(spikes) == 1 and "sâm ngọc linh" in spikes[0]
    assert "tuần 2026-10-11: 55 so trung vị 20.5" in spikes[0]
    assert "query_id" in spikes[0]
    # đối thủ: mỗi số có nguồn obs# + price_list#/duyệt
    comp = out1.split("## 2.")[0]
    assert comp.count("obs#") == 4 and "price_list#" in comp
    assert "CHƯA duyệt" in comp and "chưa có giá golden" in comp
    assert "rượu sâm ngọc linh: +120% (rượu — không dùng cho nhóm giới trẻ)" \
        in out1
    soc = out1.split("## 3.")[1].split("## 4.")[0]
    assert "| fanpage | 21 |" in soc and "| 3 |" in soc
    news = out1.split("## 4.")[1]
    assert "Tin MẪU sâm ngọc linh" in news and "Tin MẪU tuần trước" not in news
    for s in _social_strings():
        assert s not in out1, s
    assert chat_spy[0] == []


def test_report_other_week_no_spike_and_empty(db, monkeypatch, capsys):
    _seed(db)
    rc, out, _e, _n = _main(db, monkeypatch, capsys, ["--week", "2026-10-01"])
    assert rc == 0 and "TĂNG ĐỘT BIẾN" not in out
    assert "- không có" in out
    # tuần SAU spike: chuỗi vẫn chứa tuần 2026-10-11 ≤ CN → chỉ lọc trong-tuần
    # mới loại được (không in lại spike tuần trước)
    rc, out, _e, _n = _main(db, monkeypatch, capsys, ["--week", "2026-10-14"])
    assert rc == 0 and "TĂNG ĐỘT BIẾN" not in out
    rc, out, _e, _n = _main(db, monkeypatch, capsys, ["--week", "2026-06-01"])
    # docx P2 FLIP có lý do: thêm mục "Sản phẩm đối thủ lần đầu ghi nhận
    # trong tuần" (intel-03 "sản phẩm mới") — tuần trống → 5 mục rỗng.
    assert rc == 0 and out.count("chưa có dữ liệu tuần này") == 5


def test_bad_week_exit2_no_connect(db, monkeypatch, capsys):
    rc, _o, _e, n = _main(db, monkeypatch, capsys, ["--week", "2026-13-40"])
    assert (rc, n) == (2, 0)


def test_llm_gate_disabled_warns_no_call(db, monkeypatch, capsys, chat_spy):
    _seed(db)
    monkeypatch.setattr(iw, "load_sources",
                        lambda p: ({"llm": {"enabled": False}}, []))
    rc, out, err, _n = _main(db, monkeypatch, capsys,
                             ["--week", WEEK, "--llm"])
    assert rc == 0 and "[warn]" in err and chat_spy[0] == []
    assert "Tóm tắt (LLM" not in out


def test_llm_enabled_one_call_no_social(db, monkeypatch, capsys, chat_spy):
    _seed(db)
    monkeypatch.setattr(iw, "load_sources",
                        lambda p: ({"llm": {"enabled": True}}, []))
    rc, out, _err, _n = _main(db, monkeypatch, capsys,
                              ["--week", WEEK, "--llm"])
    calls = chat_spy[0]
    assert rc == 0 and len(calls) == 1 and calls[0][0] == "intel"
    payload = json.dumps(calls[0][1], ensure_ascii=False)
    assert "## 1. Đối thủ" in payload and "## 3. Social" not in payload
    for s in _social_strings():
        assert s not in payload, s
    assert "Tóm tắt (LLM" in out and "golden ở 2 SKU" in out


def test_llm_guardrail_blocks_summary(db, monkeypatch, capsys, chat_spy):
    _seed(db)
    chat_spy[1]["text"] = "Sâm giúp chữa bệnh tiểu đường."
    monkeypatch.setattr(iw, "load_sources",
                        lambda p: ({"llm": {"enabled": True}}, []))
    rc, out, err, _n = _main(db, monkeypatch, capsys,
                             ["--week", WEEK, "--llm"])
    assert rc == 0 and len(chat_spy[0]) == 1
    assert "chữa" not in out and "guardrail" in err


def test_llm_gateway_blocked_report_still_prints(db, monkeypatch, capsys,
                                                 chat_spy):
    _seed(db)
    chat_spy[1]["text"] = llm_gateway.GatewayBlocked("cap")
    monkeypatch.setattr(iw, "load_sources",
                        lambda p: ({"llm": {"enabled": True}}, []))
    rc, out, err, _n = _main(db, monkeypatch, capsys,
                             ["--week", WEEK, "--llm"])
    assert rc == 0 and "[warn]" in err
    for h in HEADS:
        assert h in out


def test_isolation_counts_unchanged(db, monkeypatch, capsys, chat_spy):
    tables = ("content_drafts", "agent_action_log", "approvals")

    def counts():
        return [db.execute(f"select count(*) from {t}").fetchone()[0]
                for t in tables]
    before = counts()
    _seed(db)
    rc, _o, _e, _n = _main(db, monkeypatch, capsys, ["--week", WEEK])
    assert rc == 0 and counts() == before


def test_default_week_is_last_full_week(monkeypatch):
    seen = {}

    def fake_render(conn, day, cfg):
        seen["day"] = day
        return "x", "x"
    monkeypatch.setattr(ii, "today_vn",
                        lambda: datetime(2026, 10, 14, tzinfo=timezone.utc)
                        .date())
    monkeypatch.setattr(iw, "render", fake_render)
    monkeypatch.setattr(iw, "_connect", lambda dsn: types.SimpleNamespace(
        execute=lambda *a: types.SimpleNamespace(fetchone=lambda: ("t",)),
        close=lambda: None))
    monkeypatch.setattr(iw, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    assert iw.main([]) == 0
    mon, sun, _s, _e = iw.week_bounds(seen["day"])
    assert (str(mon), str(sun)) == ("2026-10-05", "2026-10-11")


def test_weekly_connect_read_only_source():
    src = (ROOT / "scripts" / "intel_weekly.py").read_text(encoding="utf-8")
    assert "read_only = True" in src and "connect_timeout=10" in src
