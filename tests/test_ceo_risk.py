"""v8.1 W81.3 — `agents.ceo_risk`: sổ rủi ro pháp lý mở (CHỈ ĐỌC tracker
Pháp chế), xếp hạng TẤT ĐỊNH với `now` tham số, xu hướng tuần, đếm ngược mốc
phí XNQC T-30/T-14/T-7 (plan acceptance (1)).

Thuần: `rank`/`trend`/`render_section` trên facts viết tay, thứ tự kỳ vọng
VIẾT SẴN (không tính lại bằng `rank`). DB thật (schema tạm + rollback): as-of
bài vi phạm / cảnh báo đỏ / hồ sơ, `collect` trong transaction read only.
Config `data/ceo_risk.json` là BẢN DEV SOẠN chờ Pháp chế duyệt.
"""

import json
import os
import random
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

from agents import ceo_risk as cr
from ingest import golden_store as gs
from pipelines.period import VN_TZ
from scripts import dpia_draft
from tests.test_ceo_audit import TxConn, ceo_db

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def db():
    yield from ceo_db()


CFG = cr.load_config()
FEE_OLD = "550.000 đồng/hồ sơ đến hết 31/12/2026"
FEE_NEW = "1.100.000 đồng/hồ sơ từ 01/01/2027"


def _vn(*a) -> datetime:
    return datetime(*a, tzinfo=VN_TZ)


def _facts(**kw) -> dict:
    base = {"dossiers": [], "tpbvsk": [], "posts": [], "alerts": [],
            "dpia_signed": True, "gaps": 0, "recipients": 1}
    return base | kw


def _dos(i, sku, status, het=None, cap=None, nop=None) -> dict:
    return {"id": i, "sku_key": sku, "status": status, "ngay_nop": nop,
            "ngay_cap": cap, "ngay_het_han": het}


# ---------------------------------------------------------------- countdown
@pytest.mark.parametrize("now,marker,level", [
    (_vn(2026, 12, 1, 9), "T-30", "do"),     # đợt 2 (30/11) đã qua
    (_vn(2026, 12, 17, 9), "T-14", "do"),
    (_vn(2026, 12, 24, 9), "T-7", "do"),
    (_vn(2027, 1, 2, 9), "QUÁ MỐC PHÍ", "do"),
    (_vn(2026, 11, 1, 9), None, "vang"),     # 60 ngày tới mốc phí, 29 tới đợt 2
    (_vn(2026, 12, 2, 0, 30), "T-30", "do"),  # 29 ngày: vẫn T-30
])
def test_fee_countdown_markers(now, marker, level):
    r = cr.rank(_facts(tpbvsk=["sku-a"]), now, CFG)
    assert [x["code"] for x in r] == ["XNQC-CHO-NOP:sku-a"]
    assert r[0]["marker"] == marker and r[0]["level"] == level
    row = cr.risk_row(r[0])
    assert FEE_OLD in row and FEE_NEW in row
    assert CFG["xnqc_phi_nguon_url"] in row
    if marker:
        assert marker in row


def test_fee_marker_thresholds():
    marks = CFG["nhac_moc_ngay"]
    assert marks == [30, 14, 7]
    got = {d: cr.fee_marker(d, marks) for d in (-1, 0, 7, 8, 14, 15, 30, 31)}
    assert got == {-1: "QUÁ MỐC PHÍ", 0: "T-7", 7: "T-7", 8: "T-14",
                   14: "T-14", 15: "T-30", 30: "T-30", 31: None}


# ---------------------------------------------------------------- xếp hạng
NOW = _vn(2026, 11, 10, 9)
RANK_FACTS = _facts(
    tpbvsk=["A", "B", "C", "D"],
    dossiers=[_dos(2, "B", "da_nop", nop=date(2026, 11, 1)),
              _dos(3, "C", "da_cap", het=date(2026, 11, 20),
                   cap=date(2026, 1, 1), nop=date(2025, 12, 1)),
              _dos(4, "D", "da_cap", het=date(2026, 11, 1),
                   cap=date(2025, 11, 1), nop=date(2025, 10, 1))],
    posts=[{"url": "u-fb", "channel": "facebook", "severity": "S1",
            "due_at": NOW + timedelta(hours=10)},
           {"url": "u-web", "channel": "web", "severity": "S2",
            "due_at": NOW - timedelta(hours=2)},
           {"url": "u-sp", "channel": "shopee", "severity": "S2",
            "due_at": NOW + timedelta(hours=5)}],
    alerts=[11, 12],          # 2 cảnh báo GỐC (bản leo thang lọc ở collect)
    dpia_signed=False, gaps=5, recipients=0)
# Thứ tự VIẾT SẴN: đỏ (ngày còn lại tăng, không hạn cuối, mã) → vàng → xanh.
EXPECTED = ["XNQC-HET-HAN:4", "KENH:facebook", "KENH:web", "CANH-BAO-DO",
            "DPIA", "TUYEN-CANH-BAO", "KENH:shopee", "XNQC-HET-HAN:3",
            "XNQC-CHO-NOP:A", "XNQC-CHO-NOP:D", "XNQC-CHO-CAP:B"]


def test_rank_fixture_expected_order():
    r = cr.rank(RANK_FACTS, NOW, CFG)
    assert [x["code"] for x in r] == EXPECTED
    lv = {x["code"]: x["level"] for x in r}
    assert lv["XNQC-CHO-CAP:B"] == "xanh" and r[-1]["code"] == \
        "XNQC-CHO-CAP:B"
    assert lv["KENH:web"] == "do" and lv["KENH:shopee"] == "vang"
    assert lv["XNQC-HET-HAN:3"] == "vang" and lv["XNQC-HET-HAN:4"] == "do"
    by = {x["code"]: x for x in r}
    assert by["CANH-BAO-DO"]["title"].startswith("2 cảnh báo đỏ gốc")
    assert by["KENH:web"]["title"].endswith("S1 0, S2 1, quá 24h 1")
    assert by["XNQC-HET-HAN:3"]["days_left"] == 10
    assert by["XNQC-CHO-NOP:A"]["days_left"] == 20     # tới hạn đợt 2
    assert {x["owner_role"] for x in r} <= {"phap_che", "phap_che/bks"}


def test_rank_input_order_independent():
    want = cr.rank(RANK_FACTS, NOW, CFG)
    rnd = random.Random(81)
    for _ in range(5):
        f = dict(RANK_FACTS)
        for k in ("dossiers", "tpbvsk", "posts", "alerts"):
            f[k] = rnd.sample(list(RANK_FACTS[k]), len(RANK_FACTS[k]))
        assert cr.rank(f, NOW, CFG) == want


def test_rank_dpia_signed_with_gaps_is_vang():
    r = cr.rank(_facts(dpia_signed=True, gaps=3), NOW, CFG)
    assert [(x["code"], x["level"]) for x in r] == [("DPIA", "vang")]
    assert cr.rank(_facts(), NOW, CFG) == []


def test_trend_up_new_gone():
    prev = cr.rank(_facts(posts=[{"url": "u", "channel": "web",
                                  "severity": "S2",
                                  "due_at": NOW + timedelta(hours=5)}],
                          tpbvsk=["Z"]), NOW - timedelta(days=7), CFG)
    cur = cr.rank(_facts(posts=[{"url": "u", "channel": "web",
                                 "severity": "S1",
                                 "due_at": NOW + timedelta(hours=5)}],
                         recipients=0), NOW, CFG)
    assert {x["code"]: x["level"] for x in prev}["KENH:web"] == "vang"
    t = cr.trend(cur, prev)
    assert t["codes"] == {"KENH:web": "↑", "TUYEN-CANH-BAO": "mới"}
    assert t["gone"] == 1                       # XNQC-CHO-NOP:Z đã hết
    assert cr.trend(prev, cur)["codes"]["KENH:web"] == "↓"
    assert cr.trend(cur, cur)["codes"]["KENH:web"] == "="
    sec = "\n".join(cr.render_section(cur, t, NOW))
    assert "đã hết trong tuần: 1" in sec and "| ↑ |" in sec


def test_render_section_caps_and_counts():
    r = cr.rank(RANK_FACTS, NOW, CFG)
    tr = cr.trend(r, [])
    sec = cr.render_section(r, tr, NOW)
    rows = [ln for ln in sec if ln.startswith("| ") and "---" not in ln
            and not ln.startswith("| Mức")]
    assert len(rows) == 8
    assert any("…và 3 rủi ro khác" in ln for ln in sec)
    text = "\n".join(sec)
    assert text.startswith("## Rủi ro pháp lý mở")
    assert "Đỏ 6 · Vàng 4 · Xanh 1" in text
    assert "| ĐỎ | XNQC-HET-HAN:4 |" in text
    full = cr.render_section(r, tr, NOW, limit=None)
    assert sum(1 for ln in full if ln.startswith("| ") and "---" not in ln
               and not ln.startswith("| Mức")) == 11
    assert "| mới |" in text


# ---------------------------------------------------------------- cấu hình
GOOD = json.loads((ROOT / "data" / "ceo_risk.json").read_text("utf-8"))


@pytest.mark.parametrize("doc", [
    None, "{hỏng", {}, {"_doc": "x"},
    GOOD | {"xnqc_phi_moc": "31/12/2026"},
    GOOD | {"xnqc_phi_moc": "2026-02-30"},
    GOOD | {"nhac_moc_ngay": []}, GOOD | {"nhac_moc_ngay": [30, 0]},
    GOOD | {"do_khi_con_ngay": -1}, GOOD | {"do_khi_con_ngay": True},
    GOOD | {"xnqc_phi_text": " "}, GOOD | {"xnqc_phi_nguon_url": "ftp://x"},
], ids=["thieu", "hong", "rong", "chi-doc", "ngay-vn", "ngay-sai",
        "list-rong", "moc-0", "am", "bool", "text-rong", "url-sai"])
def test_load_config_fail_closed(tmp_path, monkeypatch, doc):
    p = tmp_path / "ceo_risk.json"
    if doc is not None:
        p.write_text(doc if isinstance(doc, str)
                     else json.dumps(doc, ensure_ascii=False),
                     encoding="utf-8")
    with pytest.raises(ValueError):
        cr.load_config(p)
    monkeypatch.setattr(cr, "CONFIG", p)
    monkeypatch.setattr(cr, "connect", lambda: pytest.fail("connect"))
    assert cr.main(["--report", "--out-dir", str(tmp_path / "o")]) == 2


def test_config_reads_phap_che_not_copied():
    pc = json.loads((ROOT / "data" / "phap_che.json").read_text("utf-8"))
    assert CFG["dot2_han_nop"] == date.fromisoformat(
        pc["xnqc"]["dot2_han_nop"])
    assert "dot2_han_nop" not in GOOD and "BẢN DEV SOẠN" in GOOD["_doc"]
    assert CFG["xnqc_phi_text"] == f"{FEE_OLD}, {FEE_NEW}"


# ---------------------------------------------------------------- DB as-of
def _post(db, url, ch, sev, scanned, due=None, closed=None, reason=None):
    db.execute(
        "insert into channel_posts (url, channel, content_type, is_ai, text,"
        " text_sha256, guardrail, codes, severity, first_detected_at, due_at,"
        " imported_by, scanned_at, closed_at, close_reason) values (%s, %s,"
        " 'post', true, 'bài mẫu', %s, '{}', %s, %s, %s, %s, 'Người Test', %s,"
        " %s, %s)",
        (url, ch, "0" * 64, ["thieu_ban_duyet"] if sev else [], sev,
         scanned if sev else None, due, scanned, closed, reason))


def test_collect_as_of_db(db):
    gs.load(db, json.loads((ROOT / "data" / "golden_skus.json")
                           .read_text(encoding="utf-8")))
    n = db.execute("select now()").fetchone()[0]
    t = _vn(2026, 10, 12, 9)
    # A: vi phạm, đóng SAU mốc t → vẫn mở tại t; tại t+2 ngày → đã đóng
    _post(db, "u-a", "facebook", "S2", t - timedelta(days=2),
          due=t - timedelta(days=1), closed=t + timedelta(days=1),
          reason="da_go")
    # B: S1 đóng TRƯỚC t → không tính
    _post(db, "u-b", "web", "S1", t - timedelta(days=2),
          due=t - timedelta(days=1), closed=t - timedelta(days=1),
          reason="da_go")
    # C: dòng vi phạm cũ + snapshot sạch mới hơn trước t → không tính
    _post(db, "u-c", "web", "S2", t - timedelta(days=3),
          due=t - timedelta(days=2), closed=t - timedelta(days=1),
          reason="da_sua")
    _post(db, "u-c", "web", None, t - timedelta(days=1))
    ids = [db.execute("insert into red_alerts (source_agent, title, detail)"
                      " values ('test', %s, %s) returning id",
                      (f"cảnh báo {i}", Jsonb(d))).fetchone()[0]
           for i, d in enumerate([{}, {}, {"escalation_of": "1"}])]
    db.execute("insert into red_alert_acks (alert_id, acked_by) values (%s,"
               " 'Phap Che Gia Lap')", (ids[1],))
    db.execute("insert into xnqc_dossiers (sku_key, loai_ho_so, ten_ho_so,"
               " status, ngay_nop, updated_by) values ('savigout-30v',"
               " 'maket', 'maket fanpage', 'da_nop', '2026-10-01',"
               " 'Phap Che Gia Lap')")
    tx = TxConn(db)
    f = cr.collect(tx, t)
    assert [p["url"] for p in f["posts"]] == ["u-a"]
    assert [p["url"] for p in cr.collect(tx, t + timedelta(days=2))
            ["posts"]] == []
    # red_alerts.ts / acked_at = now() của tx (DB đặt) → mốc ± 1 giây
    after = cr.collect(tx, n + timedelta(seconds=1))
    assert after["alerts"] == [ids[0]]        # ack ≤ as_of + leo thang: bỏ
    assert [d["sku_key"] for d in after["dossiers"]] == ["savigout-30v"]
    early = cr.collect(tx, n - timedelta(seconds=1))
    assert early["alerts"] == [] and early["dossiers"] == []
    assert after["recipients"] == 0 and after["dpia_signed"] is False
    assert after["gaps"] == sum(len(x["gaps"])
                                for x in dpia_draft.load_map()["flows"])
    r = cr.rank(after, n + timedelta(seconds=1), CFG)
    codes = [x["code"] for x in r]
    assert "XNQC-CHO-CAP:savigout-30v" in codes
    assert "XNQC-CHO-NOP:savigout-30v" not in codes
    assert {x["code"]: x["title"] for x in r}["CANH-BAO-DO"].startswith(
        "1 cảnh báo")
    # chỉ đọc: collect trong transaction read only
    with db.transaction():
        db.execute("set local transaction_read_only = on")
        cr.collect(tx, n)
        cur, tr = cr.compute(tx, n + timedelta(seconds=1))
        raise psycopg.Rollback()
    assert [x["code"] for x in cur] == codes
    sec = "\n".join(cr.render_section(cur, tr, n))
    assert "bài mẫu" not in sec and "Phap Che Gia Lap" not in sec


def test_report_cli_db(db, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cr, "connect", lambda: TxConn(db))
    out = tmp_path / "rep"
    assert cr.main(["--report", "--now", "2026-12-17T09:00", "--out-dir",
                    str(out)]) == 0
    page = (out / "ceo-risk-2026-12-17.md").read_bytes().decode("utf-8")
    assert "T-14" in page and FEE_OLD in page and FEE_NEW in page
    assert "| ĐỎ | XNQC-CHO-NOP:savigout-30v |" in page
    assert "[done]" in capsys.readouterr().out


# ---------------------------------------------------------------- CLI/grep
@pytest.mark.parametrize("argv", [
    [], ["--now", "2026-10-12"], ["--report", "--now", "12/10/2026"],
    ["--report", "--x"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(cr, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        cr.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "connect", lambda: None)
    assert cr.main(["--report", "--out-dir", str(tmp_path)]) == 2
    assert list(tmp_path.iterdir()) == []


def test_cli_dead_host_subprocess():
    env = dict(os.environ, PYTHONIOENCODING="utf-8",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x")
    r = subprocess.run([sys.executable, "-m", "agents.ceo_risk", "--report",
                        "--out-dir", str(ROOT / "data" / "reports")],
                       cwd=ROOT, env=env, capture_output=True, timeout=60,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2 and "không kết nối" in r.stderr


def test_grep_read_only_no_egress():
    src = (ROOT / "agents" / "ceo_risk.py").read_text(encoding="utf-8")
    assert not re.search(r"insert into|update |delete from|raise_alert|"
                         r"submit\(", src)
    assert not re.search(
        r"import (httpx|requests|socket|smtplib|openai)|from (httpx|requests"
        r"|smtplib|urllib\.request|http\.client|openai)|urllib\.request|"
        r"email\.mime|webbrowser|llm_gateway", src)
    assert "agents/ceo_risk.py" not in dpia_draft.egress_modules(ROOT)


def test_section_passes_guardrail():
    """Trang TGĐ chép section → phải sạch guardrail (mã rủi ro không được
    chứa chữ không dấu mà guardrail gập thành từ cấm, vd "CHUA" → "chữa")."""
    from pipelines import guardrail

    for now in (NOW, _vn(2027, 1, 2, 9)):
        r = cr.rank(RANK_FACTS, now, CFG)
        text = "\n".join(cr.render_section(r, cr.trend(r, []), now,
                                           limit=None))
        g = guardrail.check(text)
        assert g["ok"] is True, g["violations"]


def test_risk_row_bare_ascii_cell_hidden_not_page_failing():
    """Cold-check MAJOR (vá theo cụm): sku_key/kênh/URL nguồn chép vào ô
    bảng — chữ trần 'thuoc'/'chua' gập dấu thành từ cấm → trang TGĐ trượt.
    Ô tự trượt guardrail → HIDDEN; ô sạch giữ nguyên."""
    from agents.ra_kenh import HIDDEN
    from pipelines.guardrail import check

    r = {"level": "do", "code": "XNQC-CHO-NOP:sam-thuoc", "title": "SKU x",
         "owner_role": "phap_che", "due": date(2026, 11, 30), "marker": None,
         "source": "https://example.vn/van-ban-chua-ro"}
    row = cr.risk_row(r)
    assert "thuoc" not in row and "chua" not in row
    assert row.startswith(f"| ĐỎ | {HIDDEN} | {HIDDEN} | phap_che |")
    assert check(row)["ok"] is True
    clean = cr.risk_row(dict(r, code="DPIA", source=None))
    assert "| DPIA | SKU x | phap_che | 30/11/2026 |" in clean
