"""v10.2 W102.5 — DA-06 hồ sơ đối tác (`agents.da_doitac`).

Thuần: số liệu chỉ có nguồn + ngày, 0 dự phóng, loại rượu + TPBVSK chưa
XNQC, ô đối tác có PII → problem. DB THẬT trong schema tạm (schema.sql +
roles.sql) → ROLLBACK cuối test (`tests.test_da_schema.da_db`). Người duyệt
trong fixture là tên GIẢ (superuser fixture) — không phải người thật.
"""

import copy
import json
import re
import uuid
from datetime import datetime
from pathlib import Path

import pytest

from agents import da_doitac as da
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import approval_queue as aq
from pipelines import director
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "da_doitac.py").read_text(encoding="utf-8")
GOLDEN, _ = read_golden(GOLDEN_FILE)
FACTS = da.load_facts()
ROOM = da.load_data_room()
LIVE = datetime(2027, 2, 16, 0, 30, tzinfo=VN_TZ)
SHADOW = datetime(2027, 2, 15, 23, 30, tzinfo=VN_TZ)
APPROVER = "GĐ dự án MẪU"
PROSPECT = {"id": 5, "org_name": "Khách sạn MẪU Biển Xanh",
            "org_type": "khach_san", "region": "Đà Nẵng",
            "website": "https://ksmau.example.vn",
            "source_url": "https://ksmau.example.vn/gioi-thieu",
            "fit_reason": "Mua quà Tết cho khách doanh nghiệp"}


@pytest.fixture
def db():
    yield from da_db()


def _build(prospect=PROSPECT, facts=FACTS, golden=GOLDEN, now=LIVE):
    return da.build(prospect, facts, golden, ROOM, now=now)


# ---------------------------------------------------------------- thuần


def test_fact_with_source_and_date_printed_with_note():
    r = _build()
    p = r["payload"]
    assert r["problems"] == [] and r["mode"] == "live"
    line = [ln for ln in p.splitlines() if "21.585.320đ" in ln]
    assert len(line) == 1
    assert "nguồn Báo cáo Seller Center" in line[0]
    assert "ngày 30/09/2026" in line[0] and "(MẪU)" in line[0]
    assert "không phải doanh thu thực nhận" in line[0]


def test_fact_missing_source_or_date_not_printed():
    facts = [{"key": "a", "label": "Doanh thu MẪU", "value": 987654321,
              "unit": "đ", "source": None, "as_of": "2026-09-30"},
             {"key": "b", "label": "Sản lượng MẪU", "value": 4321,
              "unit": "kg", "source": "Kho", "as_of": None},
             {"key": "c", "label": "Ngày hỏng", "value": 777, "unit": "",
              "source": "x", "as_of": "30/09/2026"}]
    r = _build(facts=facts)
    p = r["payload"]
    for n in ("987.654.321", "987654321", "4.321", "4321", "777"):
        assert n not in p
    assert p.count("chưa xác minh") == 3
    assert "Doanh thu MẪU" in r["internal"] and "Sản lượng MẪU" in r[
        "internal"]


def test_no_forecast_lines_and_forecast_label_is_problem():
    p = _build()["payload"]
    assert [ln for ln in p.splitlines() if da.FORECAST_RE.search(ln)] == []
    for label in ("Lợi nhuận dự kiến 2027", "Dự phóng doanh số",
                  "ROI năm đầu", "Tăng trưởng 30 % mỗi năm",
                  "Biên lợi nhuận gộp"):
        f = [{"key": "x", "label": label, "value": 1, "unit": "%",
              "source": "MẪU", "as_of": "2026-09-30"}]
        r = _build(facts=f)
        assert any(pr.startswith("du_phong") for pr in r["problems"]), label
    assert not da.FORECAST_RE.search("rồi sẽ về Tam Kỳ")      # 'roi' ≠ ROI


def test_excluded_skus_never_in_payload():
    g = copy.deepcopy(GOLDEN)
    names = {s["name"] for s in g["skus"]
             if s["category"] == "alcohol"
             or (s["category"] == "tpbvsk" and s.get("xnqc_status") !=
                 "approved")}
    assert any("Rượu" in n for n in names) and any("Saphraton" in n
                                                   for n in names)
    p = _build(golden=g)["payload"]
    low = p.casefold()
    assert not [n for n in names if n.casefold() in low]
    assert "rượu" not in low and "Mật ong sâm 300ml" in p


@pytest.mark.parametrize("col,val", [
    ("fit_reason", "Liên hệ anh Nam 0905123456"),
    ("fit_reason", "email muahang@ksmau.example.vn"),
    ("region", "Đà Nẵng 0236 3888 999"),
    ("org_name", "KS Mẫu 0905 123 456")])
def test_prospect_pii_cell_is_problem_and_hidden(col, val):
    r = _build(prospect={**PROSPECT, col: val})
    assert f"pii: {col}" in r["problems"]
    assert val not in r["payload"]
    for frag in ("0905123456", "muahang@", "3888", "123 456"):
        assert frag not in r["payload"]


def test_payload_pii_free_and_guardrail_publish():
    p = _build()["payload"]
    assert _mask_pii(p) == p
    from pipelines import guardrail
    assert guardrail.check_publish(p, channel="web")["ok"] is True


@pytest.mark.parametrize("field,val", [
    ("source", "anh Nam 0905123456"),
    ("label", "Doanh số (liên hệ muahang@ksmau.example.vn)")])
def test_fact_pii_in_payload_is_problem(field, val):
    f = {"key": "x", "label": "Doanh số MẪU", "value": 1000, "unit": "đ",
         "source": "Seller Center", "as_of": "2026-09-30", field: val}
    assert "pii: payload" in _build(facts=[f])["problems"]
    assert "pii: payload" not in _build()["problems"]


def test_payload_independent_of_now_and_mode():
    a, b = _build(now=LIVE), _build(now=SHADOW)
    assert a["payload"] == b["payload"]
    assert (a["mode"], b["mode"]) == ("live", "shadow")
    assert da.GO_LIVE.isoformat() == "2027-02-16"


def test_data_room_status():
    assert [s["id"] for s in ROOM] == list(da.SECTIONS)
    assert da.item_status({"evidence": None, "verified_by": None}) == "thieu"
    assert da.item_status({"evidence": "x.pdf",
                           "verified_by": None}) == "chua_xac_minh"
    assert da.item_status({"evidence": "x.pdf",
                           "verified_by": "Người thật"}) == "da_xac_minh"
    assert all(it["verified_by"] is None for s in ROOM for it in s["items"])
    txt = da.render_internal(ROOM)
    assert "| thieu |" in txt and "| chua_xac_minh |" in txt
    raw = json.loads(da.FACTS_FILE.read_text(encoding="utf-8"))
    assert all(f.get("sample") is True for f in raw["facts"])
    assert "MẪU" in raw["_doc"]


@pytest.mark.parametrize("doc", [
    {"sections": []}, {"sections": [{"id": "phap_ly"}]}, [],
    {"sections": [{"id": s, "title": "t", "items": [{"id": "x"}]}
                  for s in da.SECTIONS]}])
def test_data_room_fail_closed(tmp_path, doc):
    p = tmp_path / "room.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(da.DataError):
        da.load_data_room(p)


# ---------------------------------------------------------------- DB


def _prospect(db, **over):
    row = {**{k: v for k, v in PROSPECT.items() if k != "id"}, **over}
    return db.execute(
        "insert into org_prospects (dedup_key, org_name, org_type, region,"
        " website, source_url, fit_reason, source, created_by) values"
        " (%s, %s, %s, %s, %s, %s, %s, 'test-v102', 'test-v102')"
        " returning id",
        ("b2b:" + uuid.uuid4().hex * 2, row["org_name"], row["org_type"],
         row["region"], row["website"], row["source_url"],
         row["fit_reason"])).fetchone()[0]


def _use(db, monkeypatch, tmp_path):
    monkeypatch.setattr(da, "connect", lambda: TxConn(db))
    monkeypatch.setattr(da, "REPORTS_DIR", tmp_path / "reports")


def _queue(db):
    return db.execute("select id, block, object_type, status, created_by,"
                      " risk from approval_queue order by id").fetchall()


def test_shadow_refuses_submit_then_live_pending(db, monkeypatch, tmp_path,
                                                 capsys):
    _use(db, monkeypatch, tmp_path)
    pid = _prospect(db)
    assert da.main(["--draft", str(pid), "--submit"], now=SHADOW) == 1
    assert "shadow trước go-live 16/02/2027" in capsys.readouterr().err
    assert _queue(db) == []
    assert (tmp_path / "reports" / f"da-doitac-{pid}.md").exists()
    assert da.main(["--draft", str(pid), "--submit", "--date",
                    "2027-02-15"]) == 1
    assert _queue(db) == []
    assert da.main(["--draft", str(pid), "--submit"], now=LIVE) == 0
    q = _queue(db)
    assert len(q) == 1
    assert q[0][1:] == ("projects", "partner_profile", "pending",
                        "agent:DA-06", "high")
    assert da.main(["--draft", str(pid), "--submit"], now=LIVE) == 1  # trùng
    assert len(_queue(db)) == 1


def test_status_only_shared_when_approved_and_hash_matches(db, monkeypatch,
                                                           tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    pid = _prospect(db)
    assert da.main(["--draft", str(pid), "--submit"], now=LIVE) == 0
    qid = _queue(db)[0][0]
    capsys.readouterr()
    assert da.main(["--status", str(qid)], now=LIVE) == 1
    out = capsys.readouterr().out
    assert da.NOT_SHARED in out and "chưa được duyệt" in out
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    assert da.main(["--status", str(qid)], now=LIVE) == 0
    out = capsys.readouterr().out
    assert da.SHARED in out and da.NOT_SHARED not in out
    # Sửa số liệu SAU khi duyệt → lệch sha256 → không được chia sẻ.
    raw = json.loads(da.FACTS_FILE.read_text(encoding="utf-8"))
    raw["facts"][0]["value"] = 99999999
    f2 = tmp_path / "facts.json"
    f2.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(da, "FACTS_FILE", f2)
    assert da.main(["--status", str(qid)], now=LIVE) == 1
    out = capsys.readouterr().out
    assert da.NOT_SHARED in out and "sha256" in out
    # Mục không tồn tại / loại khác → không được chia sẻ.
    assert da.main(["--status", "999999"], now=LIVE) == 1
    other = director.submit(TxConn(db), "projects", "weekly_board", "wb-1",
                            "Bảng tuần", "Bảng tuần MẪU", "agent:test")
    assert da.status(TxConn(db), other, LIVE)[0] is False


def test_future_date_flag_cannot_open_go_live(db, monkeypatch, tmp_path,
                                              capsys):
    """--date chỉ đổi nhãn; đồng hồ thật trước go-live → submit bị chối."""
    _use(db, monkeypatch, tmp_path)
    pid = _prospect(db)
    for d in ("2027-02-16", "2030-01-01"):
        assert da.main(["--draft", str(pid), "--submit", "--date", d],
                       now=SHADOW) == 1
        assert "shadow trước go-live" in capsys.readouterr().err
    assert _queue(db) == []


def test_submit_refused_when_fact_has_pii(db, monkeypatch, tmp_path,
                                          capsys):
    _use(db, monkeypatch, tmp_path)
    monkeypatch.setattr(da, "load_facts", lambda: [
        {"key": "x", "label": "Doanh số MẪU", "value": 1000, "unit": "đ",
         "source": "anh Nam 0905123456", "as_of": "2026-09-30"}])
    pid = _prospect(db)
    assert da.main(["--draft", str(pid), "--submit"], now=LIVE) == 1
    assert "pii: payload" in capsys.readouterr().err
    assert _queue(db) == []


def test_submit_refused_when_problems(db, monkeypatch, tmp_path, capsys):
    _use(db, monkeypatch, tmp_path)
    pid = _prospect(db, fit_reason="Gọi 0905123456 để chốt")
    assert da.main(["--draft", str(pid), "--submit"], now=LIVE) == 1
    assert "pii: fit_reason" in capsys.readouterr().err
    assert _queue(db) == []
    text = (tmp_path / "reports" / f"da-doitac-{pid}.md").read_text(
        encoding="utf-8")
    assert text.startswith("> **CẢNH BÁO") and "0905123456" not in text


def test_data_room_cli_no_db(monkeypatch, tmp_path, capsys):
    calls = []
    monkeypatch.setattr(da, "connect", lambda: calls.append(1))
    monkeypatch.setattr(da, "REPORTS_DIR", tmp_path / "reports")
    assert da.main(["--data-room"]) == 0
    assert calls == [] and "thieu=" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["--draft", "1", "--status", "2"], ["--draft", "1", "--data-room"],
    ["--data-room", "--status", "2"], [], ["--status", "1", "--submit"],
    ["--data-room", "--date", "2027-02-16"],
    ["--draft", "1", "--date", "16/02/2027"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(da, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        da.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(da, "connect", lambda: None)
    assert da.main(["--draft", "1"], now=LIVE) == 2


def test_director_config_partner_profile():
    cfg = director.load_config("projects")
    assert cfg["object_types"]["partner_profile"] == {"sla_hours": 72,
                                                      "risk": "high"}
    assert cfg["approvers"] == []


def test_module_no_llm_no_send():
    assert not re.search(r"llm_gateway|openai|import httpx|import requests|"
                         r"\.post\(|smtp", SRC, re.IGNORECASE)
    assert "verified_by\"] =" not in SRC and "verified_by'] =" not in SRC


def test_external_markdown_escaped():
    """OWASP (injection): dữ liệu org_prospects/fact không thành ảnh/link
    tự tải khi mở hồ sơ."""
    evil = "KS ![x](https://evil.example/t.png) <img src=x>"
    r = _build(prospect={**PROSPECT, "fit_reason": evil},
               facts=[{"key": "a", "label": "Số <b>MẪU</b>", "value": 1,
                       "unit": "SKU", "source": "[nguồn](https://e.x)",
                       "as_of": "2026-09-30"}])
    p = r["payload"]
    # ký tự đặc biệt chỉ được còn ở dạng đã escape (\\x)
    raw = re.compile(r"(?<!\\)(?:!\[|<img|<b>|\]\()")
    assert not raw.search(p)
    assert r"\!\[x\]" in p and r"\<img" in p
