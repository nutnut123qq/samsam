"""v10.1 W101.5 — MKT-12 `agents.mkt_youtube`: gói video YouTube dài NHÁP
(kịch bản, tiêu đề, mô tả, chương, SRT, Shorts) + Shorts xem trước dựng
bằng helper video_studio từ B-roll MẪU có license.

LLM = fake monkeypatch `mkt_youtube.chat` (đếm lời gọi) — 0 mạng. B-roll =
`video_studio.make_sample_broll` (ảnh MẪU, không phải tư liệu thật); ffmpeg
từ gói imageio-ffmpeg (requirements). DB thật: schema tạm → ROLLBACK.
"""

import hashlib
import json
import os
import re
import subprocess
import uuid
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from agents import mkt_youtube as my
from pipelines import guardrail
from pipelines import video_studio as vs

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
RULES = json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
    encoding="utf-8"))
AI, AD = RULES["labels"]["ai"][0], RULES["labels"]["ad"][0]
BRIEF = "Câu chuyện vùng trồng sâm và mùa quà Tết"
SEGS = [
    {"title": "Sương sớm vùng trồng", "text": "Buổi sớm trên núi rừng"
     " Quảng Nam. Giá chỉ 199k cho khách xem video.", "visual": "núi rừng",
     "duration_s": 90},
    {"title": "Người làm vườn", "text": "Những luống đất được chăm chút"
     " mỗi ngày. Bác sĩ cũng khen ngợi.", "visual": "vườn",
     "duration_s": 120},
    {"title": "Đóng gói quà quê", "text": "Từng hộp quà được gói cẩn thận.",
     "visual": "làm quà", "duration_s": 120},
    {"title": "Gửi quà phương xa", "text": "Món quà tử tế cho người thương.",
     "visual": "hộp quà", "duration_s": 90},
]
GOOD = {"title": "Hành trình quà quê Quảng Nam",
        "description": "Câu chuyện vùng trồng và những món quà tử tế.",
        "segments": SEGS,
        "shorts": [{"segments": [0, 2], "title": "Sương sớm và hộp quà"},
                   {"segments": [9], "title": "chỉ số sai"}]}


def _resp(obj):
    content = obj if isinstance(obj, str) else json.dumps(
        obj, ensure_ascii=False)
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content))], model="fake/llm")


@pytest.fixture
def llm(monkeypatch):
    st = {"calls": [], "queue": [GOOD]}

    def fake_chat(agent, messages, **kw):
        st["calls"].append((agent, messages))
        q = st["queue"]
        return _resp(q[min(len(st["calls"]), len(q)) - 1])
    monkeypatch.setattr(my, "chat", fake_chat)
    for k in ("BROLL_DIR", "VIDEO_OUT_DIR", "FFMPEG_BIN", "IMAGE_FONT"):
        monkeypatch.delenv(k, raising=False)
    return st


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
        schema = f"t_w101y_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _srt_cues(srt: str) -> list[tuple[str, str, str]]:
    out = []
    for block in srt.strip().split("\n\n"):
        n, times, text = block.split("\n", 2)
        a, b = times.split(" --> ")
        assert n.isdigit()
        out.append((a, b, text))
    return out


def _sec(ts: str) -> int:
    h, m, s = ts.replace(",000", "").split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


# ---------------------------------------------------------------- thuần

def test_youtube_alias_and_grep_private_only():
    g = guardrail.check_publish(f"Quà quê. {AI} {AD}", channel="youtube",
                                content_type="video", is_ai=True)
    assert g["ok"] is True and not [v for v in g["violations"]
                                    if v["code"] == "config"]
    assert "youtube" not in RULES["channels"]
    src = (ROOT / "agents" / "mkt_youtube.py").read_text(encoding="utf-8")
    assert not re.search(r"googleapiclient|upload|privacyStatus.*public",
                         src)
    assert my.PRIVACY == "private"


def test_package_ok_chapters_srt_labels(llm):
    pkg = my.write_package(BRIEF)
    assert pkg["ok"], pkg["refused"]
    assert len(llm["calls"]) == 1 and llm["calls"][0][0] == "mkt_youtube"
    assert pkg["meta"]["privacyStatus"] == "private"
    # câu số/giá, từ cấm kịch bản → BỎ
    assert {d["ly_do"] for d in pkg["dropped"]} == {"so_lieu",
                                                    "tu_cam_kich_ban"}
    assert "199" not in pkg["text"] and "Bác sĩ" not in pkg["text"]
    # (d) chương: dòng đầu 00:00, mốc tăng dần, ≥ 3, mỗi chương ≥ 10 s
    ch = pkg["chapters"]
    assert ch[0].startswith("00:00 ") and len(ch) == 4
    secs = [int(c[:2]) * 60 + int(c[3:5]) for c in ch]
    assert secs == [0, 90, 210, 330] and all(
        b - a >= 10 for a, b in pairwise(secs))
    cues = _srt_cues(pkg["srt"])
    assert len(cues) == 4
    assert [(_sec(a), _sec(b)) for a, b, _ in cues] == [
        (0, 90), (90, 210), (210, 330), (330, 420)]
    assert cues[0][2] == "Buổi sớm trên núi rừng Quảng Nam."
    # (e) mô tả có nhãn AI + QC + chương
    d = pkg["description"]
    assert AI in d and AD in d and "Chương:" in d and ch[1] in d
    # Short chỉ số sai bị bỏ
    assert pkg["shorts"] == [{"title": "Sương sớm và hộp quà",
                              "segments": [0, 2]}]
    assert pkg["guardrail"]["ok"] is True
    assert guardrail.check(pkg["text"])["ok"] is True


def test_refuse_before_llm_and_duration(llm):
    for brief, code in (("Rượu sâm ngày Tết", "ruou"), ("", "brief_cam"),
                        ("x" * 501, "brief_cam"),
                        ("Video có bác sĩ giới thiệu", "brief_cam")):
        r = my.write_package(brief)
        assert r["refused"]["code"] == code, brief
    assert llm["calls"] == []
    short = json.loads(json.dumps(GOOD))
    for s in short["segments"]:
        s["duration_s"] = 30                        # Σ 120 s
    llm["queue"] = [short]
    r = my.write_package(BRIEF)
    assert r["refused"]["code"] == "thoi_luong" and len(llm["calls"]) == 1
    two = json.loads(json.dumps(GOOD))
    two["segments"] = two["segments"][:2]
    llm["queue"] = [two]
    assert my.write_package(BRIEF)["refused"]["code"] == "kich_ban"
    llm["queue"] = ["không phải json"]
    assert my.write_package(BRIEF)["refused"]["code"] == "kich_ban"


def test_banned_description_retry_then_kich_ban(llm):
    bad = json.loads(json.dumps(GOOD))
    bad["description"] = "Món quà như thuốc bổ cho cả nhà."
    llm["queue"] = [bad]
    r = my.write_package(BRIEF)
    assert r["refused"]["code"] == "kich_ban" and not r["ok"]
    assert len(llm["calls"]) == 2
    assert "vi phạm" in llm["calls"][1][1][-1]["content"]
    assert r["guardrail"]["ok"] is False
    llm["calls"].clear()
    llm["queue"] = [bad, GOOD]
    assert my.write_package(BRIEF)["ok"] and len(llm["calls"]) == 2


def test_render_refusals_no_broll_no_ffmpeg(llm, tmp_path, monkeypatch):
    pkg = my.write_package(BRIEF)
    res = my.render_shorts(pkg, broll_dir=tmp_path / "trong",
                           out_dir=tmp_path / "out")
    assert [r["refused"] for r in res] == ["broll_thieu"]
    vs.make_sample_broll(tmp_path / "b" / "a.png")
    monkeypatch.setattr(vs, "find_ffmpeg", lambda: None)
    res = my.render_shorts(pkg, broll_dir=tmp_path / "b",
                           out_dir=tmp_path / "out")
    assert [r["refused"] for r in res] == ["ffmpeg_thieu"]
    assert not (tmp_path / "out").exists() or not list(
        (tmp_path / "out").glob("*.mp4"))


# ---------------------------------------------------------------- DB + ffmpeg

def test_db_save_and_render_short(db, llm, tmp_path):
    tx = _TxConn(db)
    pkg = my.write_package(BRIEF)
    did = my.save_package(tx, pkg, BRIEF)
    row = db.execute("select status, channel, content_type, created_by,"
                     " is_ai, prompt_version, text, guardrail->>'ok' from"
                     " content_drafts where id = %s", (did,)).fetchone()
    assert row[:6] == ("pending", "youtube", "video", "agent:mkt12", True,
                       "youtube_long@1")
    assert row[6] == pkg["text"] and row[7] == "true"
    bdir = tmp_path / "broll"
    vs.make_sample_broll(bdir / "a.png")
    vs.make_sample_broll(bdir / "b.jpg", exif_gps=True)
    out = tmp_path / "out"
    [r] = my.render_shorts(pkg, broll_dir=bdir, out_dir=out, conn=tx,
                           draft_id=did)
    assert r["ok"], r
    mp4 = Path(r["path"])
    data = mp4.read_bytes()
    assert mp4.name == hashlib.sha256(data).hexdigest() + ".mp4"
    side = json.loads((out / f"{r['sha256']}.json").read_text(
        encoding="utf-8"))
    assert side["privacyStatus"] == "private" and side["labels"] == [AI, AD]
    assert 15000 <= side["duration_ms"] <= 45000
    assert all(b["license"] for b in side["broll"])
    cfg, _ = vs.load_config()
    assert len(r["checks"]) == 3 and all(
        c["label_ratio"] >= cfg["extract_min_ratio"] for c in r["checks"])
    ff = vs.find_ffmpeg()
    info = subprocess.run([ff, "-hide_banner", "-i", str(mp4)],
                          capture_output=True, check=False
                          ).stderr.decode("utf-8", "replace")
    assert "Audio:" not in info and "location" not in info.lower()
    assert "creation_time" not in info and "Lavf" not in info
    log = db.execute("select actor, detail from agent_action_log where"
                     " action = 'youtube_short_render'").fetchall()
    assert log == [("agent:mkt12", {"sha256": r["sha256"],
                                    "draft_id": did})]
    assert db.execute("select count(*) from video_assets").fetchone()[0] == 0


def test_cli_dry_run_no_db(llm, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(my, "connect", lambda: calls.append(1))
    assert my.main(["--brief", BRIEF, "--dry-run"]) == 0
    assert calls == []
    with pytest.raises(SystemExit) as e:
        my.main(["--brief", BRIEF, "--dry-run", "--render"])
    assert e.value.code == 2
    assert my.main(["--brief", "Rượu sâm", "--dry-run"]) == 1
    out = capsys.readouterr().out
    assert "[refuse] ruou" in out and "private" in out


def _saph_rmap(level):
    golden = json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8"))
    rows = golden["skus"] if isinstance(golden, dict) else golden
    keys = [r["sku_key"] for r in rows
            if r["sku_key"].startswith("saphraton-")]
    assert keys
    return {(k, ch): level for k in keys for ch in ("youtube", "web")}


def test_tpbvsk_disclaimer_appended_without_repair(llm):
    """Nghiệm thu v10.1 MINOR: mô tả nhắc Saphraton (TPBVSK) → CODE nối câu
    khuyến cáo chuẩn, KHÔNG tốn lượt sửa LLM; chưa XNQC → từ chối."""
    canon = RULES["disclaimer"]["canonical"].strip()
    obj = {**GOOD, "description": "Câu chuyện vùng trồng và hộp quà"
           " Saphraton gửi người thân."}
    llm["queue"] = [obj]
    pkg = my.write_package(BRIEF, readiness=_saph_rmap("QC_DAY_DU"))
    assert pkg["ok"], pkg["refused"]
    assert len(llm["calls"]) == 1
    assert canon in pkg["description"] and canon in pkg["text"]
    assert pkg["guardrail"]["ok"] is True
    # chưa XNQC (map rỗng = CAM / readiness thấp) → từ chối fail-closed
    for rmap in ({}, _saph_rmap("CAM")):
        llm["calls"].clear()
        r = my.write_package(BRIEF, readiness=rmap)
        assert not r["ok"] and r["refused"]["code"] == "kich_ban"
        assert "sku_chua_xnqc" in {v["code"] for v in
                                   r["guardrail"]["violations"]}
