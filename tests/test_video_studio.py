"""v6.3-video-ai (MKT-04, WP08) — video ngắn NHÁP dựng từ packshot thật.

- W63.1 bảng `video_assets` (DB thật, schema tạm, ROLLBACK — fixture `db` +
  `_TxConn` của tests/test_auth_approval.py), content type `video`, draft()
  chặn video.
- W63.2 kịch bản qua gateway (fake `video_studio.chat` đếm call): từ chối
  trước LLM, từ cấm kịch bản, guardrail, bỏ câu số/giá.
- W63.3 `make_video`: khung packshot (compose + kiểm lại bytes), B-roll có
  license, ffmpeg, nhãn AI trên khung TRÍCH từ mp4, không metadata.
- W63.4 `save_video` + CLI.
Packshot/B-roll = mẫu tự sinh "MẪU"; LLM giả — không mạng, không key thật.
Mã hóa mp4 thật ≤ 5 lần trong file (fixture scope module + 2 test đột biến).
"""

import copy
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import unicodedata
from contextlib import contextmanager
from datetime import datetime
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest
from PIL import Image, ImageDraw
from psycopg.types.json import Jsonb
from test_auth_approval import _TxConn, db  # noqa: F401 — fixture DB thật
from test_image_studio import _Conn

from ingest import golden_store as gs
from pipelines import content, guardrail, llm_gateway, store
from pipelines import image_studio as ims
from pipelines import video_studio as vs
from pipelines.guardrail_llm import check_publish_llm

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
RULES = json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
    encoding="utf-8"))
AI = RULES["labels"]["ai"][0]
AD = RULES["labels"]["ad"][0]
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json").read_text(
    encoding="utf-8"))
GOLD = {s["sku_key"]: s for s in GOLDEN["skus"]}
HONEY = "mat-ong-sam-300ml"
R_OK = {(HONEY, "tiktok"): "TP_THUONG"}
ALCOHOL = [k for k, s in GOLD.items() if s["category"] == "alcohol"]
TPBVSK = [k for k, s in GOLD.items() if s["category"] == "tpbvsk"]
BRIEF = "Quà tặng từ núi rừng Quảng Nam"
CLEAN = ["Núi rừng Quảng Nam xanh mướt", "Sương sớm phủ vùng trồng",
         "Ong làm mật bên hoa rừng", "Mật ong sóng sánh vàng óng",
         "Gói quà tặng người thân", "Hương vị đặc sản quê nhà",
         "Nắng sớm trên đồi xanh", "Chiếc hộp quà mộc mạc",
         "Ấm áp ngày sum vầy", "Quà quê gửi phương xa",
         "Thương hiệu Sâm Sâm Quảng Nam", "Món quà tử tế cho người thương"]
SCENES5 = [{"text": "Quà tặng từ núi rừng Quảng Nam", "visual": "packshot"},
           {"text": "Mật ong vàng óng từ vùng trồng sâm", "visual": "broll"},
           {"text": "Gói trọn tấm lòng gửi người thân", "visual": "packshot"},
           {"text": "Đặc sản quê hương trong từng giọt", "visual": "broll"},
           {"text": "Món quà tử tế cho dịp sum vầy", "visual": "packshot"}]
ENV_KEYS = ("TTS_PROVIDER", "VIDEO_OUT_DIR", "BROLL_DIR", "FFMPEG_BIN",
            "PACKSHOT_DIR", "IMAGE_PROVIDER", "IMAGE_OUT_DIR", "IMAGE_FONT",
            "GUARDRAIL_LLM_MODEL", "LLM_KILL")

NEED_RENDER = pytest.mark.skipif(
    vs.find_ffmpeg() is None or ims.fonts_for(
        f"{AI} {AD} MẪU {BRIEF} {''.join(s['text'] for s in SCENES5)}")
    is None,
    reason="không có ffmpeg / font đủ glyph tiếng Việt (CI Linux thiếu)")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _js(scenes) -> str:
    return json.dumps({"scenes": scenes}, ensure_ascii=False)


def _clean_scenes(texts, visual="packshot"):
    return [{"text": t, "visual": visual} for t in texts]


class FakeLLM:
    """`video_studio.chat` giả: trả lần lượt `answers` (lặp lại câu cuối),
    ghi (agent, messages, kw) mỗi call. Exception trong answers -> raise."""

    def __init__(self, answers):
        self.answers, self.calls = list(answers), []

    def __call__(self, agent, messages, **kw):
        self.calls.append((agent, copy.deepcopy(messages), kw))
        a = self.answers[min(len(self.calls), len(self.answers)) - 1]
        if isinstance(a, Exception):
            raise a
        return SimpleNamespace(model="fake/test-llm", choices=[
            SimpleNamespace(message=SimpleNamespace(content=a))])


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def llm(monkeypatch):
    def set_(*answers):
        f = FakeLLM(answers)
        monkeypatch.setattr(vs, "chat", f)
        return f
    return set_


@pytest.fixture
def pk(tmp_path):
    d = tmp_path / "packshots"
    ims.make_sample_packshot(d / f"{HONEY}.png", HONEY)
    return d


def _files(d: Path) -> list[str]:
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def _make(pk, out, **kw):
    base = {"fmt": "9:16", "readiness": R_OK, "packshot_dir": pk,
            "broll_dir": pk.parent / "no-broll", "out_dir": out}
    base.update(kw)
    return vs.make_video(HONEY, base.pop("channel", "tiktok"),
                         base.pop("brief", BRIEF), **base)


def _ws(sku=HONEY, channel="tiktok", brief=BRIEF, **kw):
    kw.setdefault("readiness", R_OK)
    return vs.write_script(sku, channel, brief, **kw)


# ======================= W63.1 content type + bảng ==========================

def test_rules_video_content_type_and_studio_filter():
    ct = RULES["content_types"]["video"]
    assert ct["public"] is True and ct["ad"] is True
    assert "chờ Pháp chế" in ct["trang_thai"] and "XNQC" in ct["trang_thai"]
    app = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    assert re.search(r'if k != "video"\] or \["post"\]', app)
    assert re.search(r'and k != "image"\]', app)       # lọc ảnh v6.2 giữ


def test_content_draft_video_refused_zero_llm(monkeypatch):
    calls = []
    monkeypatch.setattr(content, "chat", lambda *a, **k: calls.append(a))
    r = content.draft("x", "tiktok", content_type="video")
    assert r["meta"]["refused"]["code"] == "loai_la"
    assert "video_studio" in r["meta"]["refused"]["reason"]
    assert r["text"] == "" and r["guardrail"]["ok"] is False
    assert calls == []


def test_schema_video_label_check_drift_guard():
    """Chuỗi nhãn trong check `video_assets` == labels.ai[0]."""
    block = SCHEMA_SQL[SCHEMA_SQL.index(
        "create table if not exists video_assets"):]
    block = block[:block.index(");")]
    m = re.search(r"label_text like '%([^%']+)%'", block)
    assert m and m.group(1) == AI
    assert "unique (file_sha256, sku, channel, format)" in block
    assert "check (duration_ms between 15000 and 45000)" in block
    assert "references content_drafts(id)" in block
    assert "check (label_text like" in block and "not ai_generated" not in \
        block                                    # nhãn VÔ ĐIỀU KIỆN


def test_roles_video_assets_insert_select_only():
    low = ROLES_SQL.lower()
    assert "grant select on video_assets to agent_writer;" in low
    m = re.search(r"grant insert \(([^)]*)\)\s+on video_assets to "
                  r"agent_writer;", low)
    assert m
    cols = [c.strip() for c in m.group(1).split(",")]
    assert cols == ["file_sha256", "file_name", "sku", "channel", "format",
                    "duration_ms", "label_text", "script_model",
                    "script_prompt_sha256", "script_prompt_version",
                    "tts_provider", "packshot_sha256", "draft_id", "meta",
                    "created_by"]
    assert not re.search(r"grant[^;]*\b(update|delete)\b[^;]*video_assets",
                         low)


_INS = vs._ASSET_SQL


def _asset(sha, did, *, label=None, dur=24000, ch="tiktok"):
    return (sha, f"{sha}.mp4", HONEY, ch, "9:16", dur,
            label if label is not None else f"{AI}\n{AD}", "fake/m",
            "p" * 64, "video_script@1", "none", "k" * 64, did,
            Jsonb({"k": 1}), "agent:mkt04")


def _denied(conn, exc, sql, params=None):
    with pytest.raises(exc), conn.transaction():
        conn.execute("set local role agent_writer")
        conn.execute(sql, params)


def test_db_video_assets_grants_unique_and_checks(db):  # noqa: F811
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    did = store.save_draft(tx, "video b", "tiktok",
                           f"Quà\n\n{AD}\n\n{AI}\n\nTệp video: a.mp4",
                           {"ok": True}, "cli", created_by="agent:mkt04",
                           content_type="video", sku=HONEY)
    aid = db.execute(_INS, _asset("a" * 64, did)).fetchone()[0]
    assert aid is not None
    db.execute("reset role")
    uv, cv = psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation
    _denied(db, uv, _INS, _asset("a" * 64, did))           # trùng 4 cột
    _denied(db, cv, _INS, _asset("b" * 64, did, label=AD))  # thiếu nhãn AI
    _denied(db, cv, _INS, _asset("c" * 64, did, dur=50000))
    _denied(db, cv, _INS, _asset("d" * 64, did, dur=14999))
    _denied(db, psycopg.errors.InsufficientPrivilege,
            "update video_assets set label_text = 'x'")
    _denied(db, psycopg.errors.InsufficientPrivilege,
            "delete from video_assets")
    with db.transaction():                     # cùng file, kênh khác -> OK
        db.execute("set local role agent_writer")
        db.execute(_INS, _asset("a" * 64, did, ch="facebook"))
    assert db.execute("select count(*) from video_assets").fetchone()[0] == 2


# ======================= W63.2 kịch bản (LLM giả) ===========================

@pytest.mark.parametrize("sku", ALCOHOL)
@pytest.mark.parametrize("ch", ["tiktok", "facebook"])
@pytest.mark.parametrize("inject", [False, True])
def test_alcohol_refused_zero_llm(llm, pk, tmp_path, sku, ch, inject):
    f = llm(_js(SCENES5))
    rmap = {(sku, ch): "QC_DAY_DU"} if inject else None
    r = _ws(sku, ch, readiness=rmap)
    assert r["refused"]["code"] == "ruou" and not r["ok"]
    m = vs.make_video(sku, ch, BRIEF, readiness=rmap, packshot_dir=pk,
                      out_dir=tmp_path / "o")
    assert m["refused"]["code"] == "ruou"
    assert f.calls == [] and _files(tmp_path / "o") == []


def test_tpbvsk_needs_maket_xnqc_zero_llm(llm):
    f = llm(_js(SCENES5))
    for rmap in (None, {("sapentol-30v", "tiktok"): "QC_DAY_DU"}):
        r = _ws("sapentol-30v", brief="video TikTok Sapentol hook mới",
                readiness=rmap)
        assert r["refused"]["code"] == "maket_xnqc"
        assert "creative TPBVSK phải dùng maket XNQC" in \
            r["refused"]["reason"]
    assert len(TPBVSK) == 8
    for sku in TPBVSK:
        assert _ws(sku, readiness=None)["refused"]["code"] == "maket_xnqc"
    assert f.calls == []


def test_readiness_channel_format_sku_refusals(llm):
    f = llm(_js(SCENES5))
    assert _ws("mat-ong-sam-120ml-1hu", readiness=None)["refused"][
        "code"] == "readiness"
    assert _ws(channel="zalo", readiness={(HONEY, "zalo"): "TP_THUONG"})[
        "refused"]["code"] == "kenh_la"
    assert _ws(channel="zalo")["refused"]["code"] == "kenh_la"
    assert _ws(fmt="4:5")["refused"]["code"] == "format_la"
    assert _ws(sku=None)["refused"]["code"] == "sku_la"
    assert f.calls == []


@pytest.mark.parametrize("brief", [
    "bác sĩ khuyên dùng mật ong sâm",
    unicodedata.normalize("NFD", "BÁC SĨ KHUYÊN DÙNG mật ong"),
    "sâm chữa tiểu đường",
    "x" * 501,
    "   ",
    "chuyên-gia gợi ý quà tặng",
    "Bác sỹ tin chọn mật ong",
    "Trước và sau khi dùng mật ong",
])
def test_brief_refused_zero_llm(llm, brief):
    f = llm(_js(SCENES5))
    r = _ws(brief=brief)
    assert r["refused"]["code"] == "brief_cam", r["refused"]
    assert f.calls == []


def test_brief_501_vs_500():
    assert vs.check_brief("Quà " + "a" * 496) is None
    assert vs.check_brief("Quà " + "a" * 497)["code"] == "brief_cam"


def test_doctor_in_script_refused_after_one_fix(llm, pk, tmp_path):
    """Acceptance (2): kịch bản chứa "bác sĩ khuyên dùng" bị chặn TRƯỚC
    render — 1 lượt sửa, vẫn vi phạm -> kich_ban, 0 file."""
    bad = _js([{"text": "Bác sĩ khuyên dùng mỗi sáng", "visual": "packshot"}]
              + _clean_scenes(CLEAN[:3]))
    f = llm(bad)
    r = _ws()
    assert r["refused"]["code"] == "kich_ban" and len(f.calls) == 2
    assert "bác sĩ" in r["refused"]["reason"] and r["llm_calls"] == 2
    f2 = llm(bad)
    m = _make(pk, tmp_path / "o")
    assert m["refused"]["code"] == "kich_ban" and len(f2.calls) == 2
    assert _files(tmp_path / "o") == []


def test_doctor_then_clean_ok_with_feedback(llm):
    f = llm(_js([{"text": "Bác sĩ khuyên dùng mỗi sáng", "visual": "broll"}]
                + _clean_scenes(CLEAN[:3])), _js(SCENES5))
    r = _ws()
    assert r["ok"] is True and len(f.calls) == 2 and r["llm_calls"] == 2
    fb = f.calls[1][1][-1]
    assert fb["role"] == "user" and "Trả lại DUY NHẤT JSON" in fb["content"]
    assert "bác sĩ" in fb["content"]
    assert f.calls[1][1][-2]["role"] == "assistant"
    assert [s["text"] for s in r["scenes"]] == [s["text"] for s in SCENES5]
    assert all(c[0] == "mkt_video" for c in f.calls)


@pytest.mark.parametrize("line, term", [
    ("Bác sỹ tin chọn", "bác sỹ"),
    ("Dược sỹ tin chọn", "dược sỹ"),
    ("Y sĩ gợi ý", "y sĩ"),
    ("Y sỹ gợi ý", "y sỹ"),
    ("Lương y gợi ý dùng", "lương y"),
    ("Thầy thuốc gợi ý", "thầy thuốc"),
    ("Trước và sau khi dùng", "trước và sau"),
    ("So sánh trước khi dùng và sau khi dùng", "so sánh trước"),
])
def test_doctor_before_after_variants_refused(llm, line, term):
    """Finding v6.3: biến thể chính tả/đồng nghĩa người-y-tế và cách nói
    trước-sau tự nhiên ('trước và sau') phải bị chặn như 'bác sĩ'."""
    f = llm(_js([{"text": line, "visual": "broll"}]
                + _clean_scenes(CLEAN[:3])))
    r = _ws()
    assert r["refused"]["code"] == "kich_ban" and len(f.calls) == 2
    assert term in r["refused"]["reason"], r["refused"]


def test_benign_before_use_not_banned():
    """'trước khi dùng' (hướng dẫn dùng) KHÔNG cấm — chỉ cụm so sánh
    trước-sau; chữ 'ý'/'y' đứng riêng không khớp 'lương y'/'y sĩ'."""
    cfg, err = vs.load_config()
    assert err is None
    assert vs._banned("Lắc nhẹ trước khi dùng", cfg["script_banned"]) == []
    assert vs._banned("Ý nghĩa quà tặng", cfg["script_banned"]) == []
    assert vs._banned("Quà tặng ý nghĩa", cfg["script_banned"]) == []


def test_doctor_in_dropped_line_still_counts(llm):
    """Từ cấm kịch bản kiểm trên MỌI câu LLM trả — câu có số bị bỏ vẫn
    tính vi phạm (không lọt nhờ bị lọc)."""
    f = llm(_js([{"text": "Bác sĩ khuyên dùng 2 thìa", "visual": "broll"}]
                + _clean_scenes(CLEAN[:3])))
    assert _ws()["refused"]["code"] == "kich_ban" and len(f.calls) == 2


def test_guardrail_violation_script_refused(llm, pk, tmp_path):
    bad = _js([{"text": "Sâm giúp chữa khỏi tiểu đường", "visual": "broll"}]
              + _clean_scenes(CLEAN[:3]))
    f = llm(bad)
    r = _ws()
    assert r["refused"]["code"] == "kich_ban" and len(f.calls) == 2
    assert "guardrail" in r["refused"]["reason"]
    assert r["guardrail"]["ok"] is False and r["guardrail"]["violations"]
    llm(bad)
    assert _make(pk, tmp_path / "o")["refused"]["code"] == "kich_ban"
    assert _files(tmp_path / "o") == []


def test_spec_lines_dropped_no_digits(llm):
    spec = ["Chỉ 350.000đ một hũ", "Hũ 300ml", "ba trăm nghìn",
            "１００%"]
    f = llm(_js(_clean_scenes(spec) + _clean_scenes(CLEAN[:3])))
    r = _ws()
    assert r["ok"] is True and len(f.calls) == 1
    assert [s["text"] for s in r["scenes"]] == CLEAN[:3]
    assert not any(c.isnumeric() for s in r["scenes"] for c in s["text"])
    assert not any(content._spec_like(s["text"]) for s in r["scenes"])
    assert [d["ly_do"] for d in r["dropped"]] == ["so_lieu"] * 4
    assert "350" not in r["caption"] and "300" not in r["caption"]


def test_long_line_few_scenes_and_cap(llm):
    long61 = "Núi rừng " + "x" * 52
    assert len(long61) == 61
    f = llm(_js(_clean_scenes([long61] + CLEAN[:3])))
    r = _ws()
    assert r["ok"] is True and r["dropped"] == [{"text": long61,
                                                 "ly_do": "dai"}]
    f = llm(_js(_clean_scenes(CLEAN[:2])))
    r = _ws()
    assert r["refused"]["code"] == "kich_ban" and len(f.calls) == 1
    assert "còn 2 cảnh" in r["refused"]["reason"]
    assert r["guardrail"]["ok"] is False      # kết quả bị loại: không ok
    llm(_js(_clean_scenes(CLEAN)))
    r = _ws()
    assert r["ok"] is True and len(r["scenes"]) == 10
    assert [d["ly_do"] for d in r["dropped"]] == ["thua", "thua"]


@pytest.mark.parametrize("ans", [
    "không phải JSON", '{"scenes": "x"}', '{"x": []}', '{"scenes": []}',
    '{"scenes": [{"text": "a", "visual": "người mẫu"}]}', "[]",
])
def test_bad_json_kich_ban_one_call(llm, ans):
    f = llm(ans)
    r = _ws()
    assert r["refused"]["code"] == "kich_ban" and len(f.calls) == 1


def test_code_fence_json_accepted(llm):
    llm("```json\n" + _js(SCENES5) + "\n```")
    assert _ws()["ok"] is True


def test_gateway_blocked_error_zero_file(llm, pk, tmp_path):
    f = llm(llm_gateway.GatewayBlocked("agent 'mkt_video' đang bị "
                                       "kill-switch"))
    r = _ws()
    assert r["ok"] is False and r["refused"] is None
    assert r["error"].startswith("llm") and len(f.calls) == 1
    m = _make(pk, tmp_path / "o")
    assert m["error"].startswith("llm") and _files(tmp_path / "o") == []


def test_real_gateway_kill_switch(monkeypatch):
    """chat THẬT + LLM_KILL=mkt_video -> GatewayBlocked trước mạng."""
    monkeypatch.setenv("LLM_KILL", "mkt_video")
    monkeypatch.setattr(llm_gateway, "_client",
                        lambda: pytest.fail("không được tạo client"))
    r = _ws()
    assert r["error"].startswith("llm: GatewayBlocked")


def test_caption_has_labels_and_passes_publish(llm):
    llm(_js(SCENES5))
    r = _ws()
    assert r["ok"] is True and AI in r["caption"] and AD in r["caption"]
    g = check_publish_llm(r["caption"], channel="tiktok",
                          content_type="video", sku=HONEY, is_ai=True,
                          readiness=R_OK)
    assert g["ok"] is True
    assert r["model"] == "fake/test-llm"
    assert r["prompt_version"] == "video_script@1"
    assert re.fullmatch(r"[0-9a-f]{64}", r["prompt_sha256"])


def test_template_manifest_and_guardrail():
    man = json.loads((ROOT / "data" / "prompts" / "manifest.json")
                     .read_text(encoding="utf-8"))["templates"]
    tmpl, ver, sha = content.load_template("video_script")
    assert (ver, sha) == (man["video_script"]["version"],
                          man["video_script"]["sha256"])
    assert "chờ GĐ Marketing duyệt" in man["video_script"]["trang_thai"]
    for ph in ("{channel}", "{sku_name}", "{brief}"):
        assert ph in tmpl
    assert guardrail.check(tmpl)["ok"] is True
    cap = json.loads((ROOT / "data" / "llm_gateway.json").read_text(
        encoding="utf-8"))["monthly_cap_usd"]
    assert cap["mkt_video"] == 2.0


def test_config_duration_bounds(tmp_path):
    cfg, err = vs.load_config()
    assert err is None and cfg["channels"] == ["tiktok", "facebook"]
    assert cfg["scene_s"] * (cfg["min_scenes"] + 1) >= 15
    assert cfg["scene_s"] * (cfg["max_scenes"] + 1) <= 45
    doc = json.loads(vs.CONFIG.read_text(encoding="utf-8"))
    assert "chờ GĐ Marketing" in doc["_doc"]
    for bad in ({"scene_s": 5}, {"min_scenes": 2}, {"formats": ["2:3"]},
                {"subtitle": {"max_chars": 61}}, {"extract_min_ratio": 0}):
        p = tmp_path / "v.json"
        p.write_text(json.dumps({**doc, **bad}), encoding="utf-8")
        assert vs.load_config(p)[0] is None, bad


# ======================= W63.3 dựng video (mã hóa thật) =====================

@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """3 lần mã hóa: 9:16 (socket chặn — 0 mạng), lặp lại y hệt (tất
    định), 1:1. B-roll: 1 JPEG có EXIF GPS + 1 PNG (có license), 1 ảnh
    không license, 1 file .mp4 (bỏ qua)."""
    if vs.find_ffmpeg() is None:
        pytest.skip("không có ffmpeg")
    base = tmp_path_factory.mktemp("v63")
    with pytest.MonkeyPatch.context() as mp:
        for k in ENV_KEYS:
            mp.delenv(k, raising=False)
        fake = FakeLLM([_js(SCENES5)])
        mp.setattr(vs, "chat", fake)
        pk = base / "pk"
        ims.make_sample_packshot(pk / f"{HONEY}.png", HONEY)
        br = base / "broll"
        vs.make_sample_broll(br / "a_vuon.jpg", exif_gps=True)
        vs.make_sample_broll(br / "b_nui.png")
        vs.make_sample_broll(br / "c_khong_license.png", license=None)
        (br / "d_clip.mp4").write_bytes(b"\x00" * 64)
        out = base / "out"

        def no_net(*a, **k):
            raise AssertionError("không được gọi mạng")

        def make(fmt):
            return vs.make_video(HONEY, "tiktok", BRIEF, fmt=fmt,
                                 readiness=R_OK, packshot_dir=pk,
                                 broll_dir=br, out_dir=out)

        with pytest.MonkeyPatch.context() as net:
            net.setattr(socket.socket, "connect", no_net)
            net.setattr(socket, "create_connection", no_net)
            r1 = make("9:16")
        side1 = Path(r1["sidecar"]).read_bytes() if r1["ok"] else None
        r2 = make("9:16")
        files2 = _files(out)
        side2 = Path(r2["sidecar"]).read_bytes() if r2["ok"] else None
        r3 = make("1:1")
    return {"base": base, "pk": pk, "br": br, "out": out, "r1": r1,
            "r2": r2, "r3": r3, "side1": side1, "side2": side2,
            "files2": files2, "calls": len(fake.calls)}


def _probe(path) -> str:
    return vs._probe(vs.find_ffmpeg(), Path(path))


@NEED_RENDER
def test_video_valid_9x16(built):
    r = built["r1"]
    assert r["ok"] is True, (r["refused"], r["error"])
    p = Path(r["path"])
    assert p.suffix == ".mp4" and p.stem == _sha(p.read_bytes()) == \
        r["sha256"]
    info = _probe(p)
    assert "1080x1920" in info and "Audio:" not in info
    m = r["meta"]
    assert m["duration_ms"] == 4 * 6 * 1000 and 15000 <= m["duration_ms"] \
        <= 45000
    assert vs._duration_ms(info) == m["duration_ms"]
    disk = json.loads(Path(r["sidecar"]).read_bytes().decode("utf-8"))
    assert disk == m
    assert {"schema", "file", "asset_sha256", "size", "fps", "duration_ms",
            "labels", "label_box", "script", "scenes", "tts", "music",
            "extract_check", "created_at", "guardrail_ok"} <= set(m)
    assert m["schema"] == "video_asset@1" and m["labels"] == [AI, AD]
    assert m["tts"] == {"provider": "none", "voice": None}
    assert m["music"] is None
    br = [s for s in m["scenes"] if s["source"] == "broll"]
    assert len(br) == 2 and all(s["broll"]["license"] == vs.SAMPLE_LICENSE
                                for s in br)
    assert [s["broll"]["file"] for s in br] == ["a_vuon.jpg", "b_nui.png"]
    end = m["scenes"][-1]
    assert end["source"] == "end_card" and end["subtitle"] == \
        GOLD[HONEY]["name"]
    assert [s["source"] for s in m["scenes"]] == [
        "packshot", "broll", "packshot", "broll", "packshot", "end_card"]
    for s in m["scenes"]:
        assert (s["packshot"] is None) == (s["source"] == "broll")
    assert [s["start_ms"] for s in m["scenes"]] == list(range(0, 24000,
                                                             4000))
    assert m["script"]["model"] == "fake/test-llm"
    assert m["script"]["prompt_version"] == "video_script@1"
    assert m["script"]["lines"] == [s["text"] for s in SCENES5]
    assert datetime.fromisoformat(m["created_at"]).utcoffset() is not None
    assert {b["file"]: b["ly_do"] for b in m["broll_skipped"]} == {
        "c_khong_license.png": "license", "d_clip.mp4": "dinh_dang"}
    # sidecar mô tả FILE: không ngữ cảnh dòng, không đường dẫn tuyệt đối
    raw = Path(r["sidecar"]).read_text(encoding="utf-8")
    for k in ("sku", "channel", "format", "packshot_sha256",
              "prompt_sha256"):
        assert f'"{k}"' not in raw, k
    assert str(built["base"]) not in raw and "\\\\" not in raw
    assert r["packshot_sha256"] == _sha((built["pk"] / f"{HONEY}.png")
                                        .read_bytes())
    assert r["draft_text"].endswith(f"Tệp video: {p.name}")
    assert AI in r["draft_text"] and AD in r["draft_text"]
    assert built["calls"] == 3       # 1 call LLM / lần dựng


@NEED_RENDER
def test_video_1x1(built):
    r = built["r3"]
    assert r["ok"] is True, (r["refused"], r["error"])
    assert "1080x1080" in _probe(r["path"])
    assert r["sha256"] != built["r1"]["sha256"]


def _ref_frame(built, sc, fmt, tmp):
    """Dựng lại khung nguồn của cảnh `sc` (tất định) -> (bytes, Image)."""
    if sc["source"] == "broll":
        b = {"path": built["br"] / sc["broll"]["file"],
             "file": sc["broll"]["file"], "license": sc["broll"]["license"]}
        data, img, _ = vs._broll_frame(b, sc["subtitle"], fmt,
                                       ims.load_config()[0], [AI, AD])
        return data, img
    res = ims.compose(HONEY, "tiktok", sc["subtitle"], fmt=fmt,
                      readiness=R_OK, packshot_dir=built["pk"], out_dir=tmp)
    data = Path(res["path"]).read_bytes()
    return data, Image.open(BytesIO(data)).convert("RGB")


@NEED_RENDER
def test_ai_label_in_extracted_frames(built, tmp_path):
    """Nhãn AI hiện trên khung TRÍCH từ mp4 (đầu/giữa/cuối): sidecar
    extract_check ≥ 0.5 + test tự trích lại và so khung nguồn dựng lại
    (sha khớp frame_sha256 trong sidecar)."""
    r = built["r1"]
    m = r["meta"]
    assert [c["t_ms"] for c in m["extract_check"]] == [500, 14000, 23500]
    assert all(c["label_ratio"] >= 0.5 for c in m["extract_check"])
    cfg = ims.load_config()[0]
    rgb = cfg["label"]["text_rgb"]
    ff = vs.find_ffmpeg()
    for c in m["extract_check"]:
        sc = m["scenes"][c["t_ms"] // 4000]
        data, ref = _ref_frame(built, sc, "9:16", tmp_path)
        assert _sha(data) == sc["frame_sha256"]
        frame = vs._extract_frame(ff, Path(r["path"]), c["t_ms"])
        ratio = vs.label_visible(frame, ref, m["label_box"], rgb)
        assert ratio >= 0.5, (c, ratio)
        print(f"[extract] t={c['t_ms']}ms nguồn={sc['source']} "
              f"label_ratio={ratio:.4f}")


@NEED_RENDER
def test_mp4_has_no_location_device_metadata(built):
    r = built["r1"]
    data = Path(r["path"]).read_bytes()
    for needle in (b"GPS", b"ISO6709", b"\xa9xyz", b"MAU-Camera",
                   b"MAU-Model", b"Exif"):
        assert needle not in data, needle
    meta = subprocess.run([vs.find_ffmpeg(), "-nostdin", "-loglevel",
                           "error", "-i", r["path"], "-f", "ffmetadata",
                           "-"], capture_output=True, timeout=120,
                          check=False).stdout.decode("utf-8", "replace")
    assert meta.startswith(";FFMETADATA1")
    for line in meta.casefold().splitlines():
        for bad in ("location", "creation_time", "make", "model",
                    "com.apple"):
            assert bad not in line, line


@NEED_RENDER
def test_deterministic_same_file_sidecar_kept(built):
    r1, r2 = built["r1"], built["r2"]
    assert r2["ok"] is True and r2["sha256"] == r1["sha256"]
    sha = r1["sha256"]
    assert built["files2"] == sorted([f"{sha}.json", f"{sha}.mp4"])
    assert built["side2"] == built["side1"]          # giữ nguyên bytes
    assert r2["meta"] == r1["meta"]


@NEED_RENDER
def test_tampered_mp4_and_sidecar_rewritten(built, llm, tmp_path):
    """mp4 cùng tên bị sửa bytes + sidecar sửa tay (bỏ nhãn) -> ghi lại."""
    llm(_js(SCENES5))
    out = tmp_path / "o"
    shutil.copytree(built["out"], out)
    sha = built["r1"]["sha256"]
    with open(out / f"{sha}.mp4", "ab") as f:
        f.write(b"tampered")
    d = json.loads((out / f"{sha}.json").read_bytes().decode("utf-8"))
    d["labels"] = []
    (out / f"{sha}.json").write_bytes(json.dumps(d).encode("utf-8"))
    r = vs.make_video(HONEY, "tiktok", BRIEF, readiness=R_OK,
                      packshot_dir=built["pk"], broll_dir=built["br"],
                      out_dir=out)
    assert r["ok"] is True and r["sha256"] == sha
    assert _sha((out / f"{sha}.mp4").read_bytes()) == sha
    back = json.loads((out / f"{sha}.json").read_bytes().decode("utf-8"))
    assert back["labels"] == [AI, AD] and back == r["meta"]
    assert sorted(p.name for p in out.iterdir() if p.name.startswith(
        sha)) == [f"{sha}.json", f"{sha}.mp4"]


@NEED_RENDER
def test_label_lost_in_extracted_frame_refused(built, llm, monkeypatch,
                                               tmp_path, capsys):
    """Đột biến: khung trích từ mp4 mất chữ nhãn (vùng nhãn tô đen) ->
    nhan_ai, xóa mp4, 0 sidecar, không sót thư mục tạm."""
    llm(_js(SCENES5))
    real = vs._extract_frame

    def blackout(ff, path, t_ms):
        img = real(ff, path, t_ms)
        cfg = ims.load_config()[0]
        x, y, w, h = ims._px(cfg["layout"]["9:16"]["label_box"], img.size)
        ImageDraw.Draw(img).rectangle((x, y, x + w, y + h), fill=(0, 0, 0))
        return img

    monkeypatch.setattr(vs, "_extract_frame", blackout)
    out = tmp_path / "o"
    r = vs.make_video(HONEY, "tiktok", BRIEF, readiness=R_OK,
                      packshot_dir=built["pk"], broll_dir=built["br"],
                      out_dir=out)
    assert r["refused"]["code"] == "nhan_ai" and not r["ok"]
    assert "label_ratio" in r["refused"]["reason"]
    assert _files(out) == []
    print(f"[mutation] {r['refused']['reason']}")


def test_label_not_drawn_refused_before_encode(llm, pk, monkeypatch,
                                               tmp_path):
    """Đột biến: bước vẽ nhãn bỏ chữ nhãn (khung packshot + B-roll) ->
    nhan_ai trước khi mã hóa, 0 mp4. Cảnh đầu là `broll`: có B-roll ->
    khung B-roll bị bắt; không B-roll -> rơi về compose, khung packshot
    bị bắt."""
    llm(_js([{**SCENES5[1]}] + SCENES5[2:]))
    real = ImageDraw.ImageDraw.multiline_text

    def no_label(self, xy, text, *a, **kw):
        if AI in text:
            return None
        return real(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "multiline_text", no_label)
    monkeypatch.setattr(vs, "_encode",
                        lambda *a, **k: pytest.fail("không được mã hóa"))
    br = tmp_path / "br"
    vs.make_sample_broll(br / "a.png")
    for d in (br, tmp_path / "none"):
        r = _make(pk, tmp_path / "o", broll_dir=d)
        assert r["refused"]["code"] == "nhan_ai", r["refused"]
        assert _files(tmp_path / "o") == []


def test_packshot_tampered_frame_refused(llm, pk, monkeypatch, tmp_path):
    """Khung packshot bị sửa 1 pixel SAU khi compose ghi file -> video bị
    loại `packshot_lech`, out dir không còn mp4/json/thư mục tạm."""
    llm(_js(SCENES5))
    real = ims.compose

    def tamper(*a, **k):
        res = real(*a, **k)
        if res["ok"]:
            img = Image.open(res["path"]).convert("RGB")
            solid = ims._solid(res["fitted"])
            i = next(i for i, v in enumerate(solid.getdata()) if v == 255)
            xy = res["packshot_xy"]
            p = (xy[0] + i % solid.width, xy[1] + i // solid.width)
            px = img.getpixel(p)
            img.putpixel(p, ((px[0] + 1) % 256, px[1], px[2]))
            img.save(res["path"], format="PNG")
        return res

    monkeypatch.setattr(ims, "compose", tamper)
    monkeypatch.setattr(vs, "_encode",
                        lambda *a, **k: pytest.fail("không được mã hóa"))
    out = tmp_path / "o"
    r = _make(pk, out)
    assert r["refused"]["code"] == "packshot_lech"
    assert _files(out) == []


def test_ffmpeg_missing_keeps_script(llm, pk, monkeypatch, tmp_path):
    f = llm(_js(SCENES5))
    monkeypatch.setattr(vs, "find_ffmpeg", lambda: None)
    r = _make(pk, tmp_path / "o")
    assert r["refused"]["code"] == "ffmpeg_thieu" and "external-dep" in \
        r["refused"]["reason"]
    assert r["script"]["ok"] is True and len(f.calls) == 1
    assert _files(tmp_path / "o") == []


def test_tts_unknown_refused_zero_llm(llm, pk, monkeypatch, tmp_path):
    f = llm(_js(SCENES5))
    monkeypatch.setenv("TTS_PROVIDER", "elevenlabs")
    assert _ws()["refused"]["code"] == "tts"
    r = _make(pk, tmp_path / "o")
    assert r["refused"]["code"] == "tts" and "external-dep" in \
        r["refused"]["reason"]
    assert f.calls == [] and _files(tmp_path / "o") == []
    assert vs.TTS_PROVIDERS == {"none": None}


def test_broll_without_license_falls_back_to_packshot(llm, pk, monkeypatch,
                                                      tmp_path):
    llm(_js(SCENES5))
    br = tmp_path / "br"
    vs.make_sample_broll(br / "a.png", license=None)
    vs.make_sample_broll(br / "b.jpg", license="   ")
    (br / "c.mov").write_bytes(b"\x00")
    ok, skipped = vs._brolls(br, ims.load_config()[0])
    assert ok == [] and {s["file"]: s["ly_do"] for s in skipped} == {
        "a.png": "license", "b.jpg": "license", "c.mov": "dinh_dang"}
    n = []
    real = ims.compose
    monkeypatch.setattr(ims, "compose",
                        lambda *a, **k: n.append(a[2]) or real(*a, **k))

    def stop(*a, **k):
        raise RuntimeError("dừng trước mã hóa (test)")

    monkeypatch.setattr(vs, "_encode", stop)
    r = _make(pk, tmp_path / "o", broll_dir=br)
    assert r["error"] == "dừng trước mã hóa (test)"
    assert n == [s["text"] for s in SCENES5] + [GOLD[HONEY]["name"]]
    assert _files(tmp_path / "o") == []


def test_broll_too_big_skipped_no_crash(tmp_path):
    br = tmp_path / "br"
    vs.make_sample_broll(br / "a.jpg")
    vs.make_sample_broll(br / "b.png")
    (br / "c.png").write_bytes(b"not a png")
    (br / "licenses.json").write_text(json.dumps(
        {"a.jpg": "x", "b.png": "x", "c.png": "x"}), encoding="utf-8")
    cfg = dict(ims.load_config()[0])
    ok, skipped = vs._brolls(br, cfg)
    assert [b["file"] for b in ok] == ["a.jpg", "b.png"]
    assert skipped == [{"file": "c.png", "ly_do": "anh_loi"}]
    ok, skipped = vs._brolls(br, {**cfg, "max_pixels": 1000})
    assert ok == [] and len(skipped) == 3
    ok, _ = vs._brolls(br, {**cfg, "max_bytes": 100})
    assert ok == []
    (br / "licenses.json").write_text("{hỏng", encoding="utf-8")
    assert vs._brolls(br, cfg)[0] == []
    assert vs._brolls(tmp_path / "khong-co", cfg) == ([], [])


def test_packshot_missing_zero_llm(llm, tmp_path):
    f = llm(_js(SCENES5))
    r = _make(tmp_path / "empty", tmp_path / "o")
    assert r["refused"]["code"] == "packshot_thieu" and f.calls == []
    assert _files(tmp_path / "o") == []


def test_find_ffmpeg_order(monkeypatch, tmp_path):
    exe = tmp_path / "ffmpeg.exe"
    exe.write_bytes(b"x")
    monkeypatch.setenv("FFMPEG_BIN", str(exe))
    assert vs.find_ffmpeg() == str(exe)
    monkeypatch.setenv("FFMPEG_BIN", str(tmp_path / "khong-co"))
    got = vs.find_ffmpeg()
    assert got is None or Path(got).is_file()


def test_label_visible_pure():
    ref = Image.new("RGB", (100, 50), (20, 20, 20))
    ImageDraw.Draw(ref).rectangle((10, 10, 30, 30), fill=(255, 255, 255))
    box, rgb = (0, 0, 100, 50), (255, 255, 255)
    assert vs.label_visible(ref, ref, box, rgb) == 1.0
    soft = Image.new("RGB", (100, 50), (20, 20, 20))
    ImageDraw.Draw(soft).rectangle((10, 10, 30, 30), fill=(230, 240, 228))
    assert vs.label_visible(soft, ref, box, rgb) == 1.0       # dung sai 40
    assert vs.label_visible(soft, ref, box, rgb, tol=10) == 0.0
    blank = Image.new("RGB", (100, 50), (20, 20, 20))
    assert vs.label_visible(blank, ref, box, rgb) == 0.0
    assert vs.label_visible(ref, blank, box, rgb) == 0.0      # nguồn 0
    assert vs.label_visible(ref.resize((50, 25)), ref, box, rgb) == 0.0
    assert vs.label_visible(None, ref, box, rgb) == 0.0


# ======================= W63.4 lưu nháp + CLI ===============================

@NEED_RENDER
def test_db_save_video_created_skipped_second_channel(db, built):  # noqa: F811
    r = built["r1"]
    assert r["ok"] is True
    gs.load(db, copy.deepcopy(GOLDEN))
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    s1 = vs.save_video(tx, r, by="agent:mkt04")
    assert s1["status"] == "created" and tx.committed >= 2
    did = s1["draft_id"]
    row = db.execute("select status, content_type, sku, channel, text, "
                     "is_ai, created_by, source, prompt_version, "
                     "prompt_sha256 from content_drafts where id = %s",
                     (did,)).fetchone()
    sc = r["script"]
    assert row[:4] == ("pending", "video", HONEY, "tiktok")
    assert AI in row[4] and AD in row[4] and f"{r['sha256']}.mp4" in row[4]
    assert row[4] == r["draft_text"]
    assert row[5:] == (True, "agent:mkt04", "cli", sc["prompt_version"],
                       sc["prompt_sha256"])
    m = r["meta"]
    a = db.execute("select file_sha256, file_name, sku, channel, format, "
                   "duration_ms, label_text, script_model, "
                   "script_prompt_sha256, script_prompt_version, "
                   "tts_provider, packshot_sha256, draft_id, meta, "
                   "created_by from video_assets").fetchall()
    assert a == [(r["sha256"], m["file"], HONEY, "tiktok", "9:16", 24000,
                  f"{AI}\n{AD}", sc["model"], sc["prompt_sha256"],
                  sc["prompt_version"], "none", r["packshot_sha256"], did,
                  m, "agent:mkt04")]
    assert vs.save_video(tx, r, by="agent:mkt04") == {"status": "skipped",
                                                      "draft_id": did}
    db.execute("reset role")
    n = db.execute("select (select count(*) from content_drafts), "
                   "(select count(*) from video_assets)").fetchone()
    assert n == (1, 1)
    log = db.execute("select actor, action, object_id from agent_action_log"
                     " where action = 'draft_create'").fetchall()
    assert log == [("agent:mkt04", "draft_create", str(did))]
    # Cùng file mp4 (khung không phụ thuộc kênh) cho facebook -> nháp + dòng
    # riêng; meta 2 dòng == sidecar.
    db.execute("set local role agent_writer")
    s3 = vs.save_video(tx, {**r, "channel": "facebook"}, by="agent:mkt04")
    assert s3["status"] == "created" and s3["draft_id"] != did
    db.execute("reset role")
    disk = json.loads(Path(r["sidecar"]).read_bytes().decode("utf-8"))
    rows = db.execute("select channel, meta from video_assets order by id"
                      ).fetchall()
    assert [x[0] for x in rows] == ["tiktok", "facebook"]
    assert all(x[1] == disk for x in rows)


def test_save_video_rejects_non_ok():
    for bad in (None, {"ok": False}, {"ok": True, "meta": None},
                {"ok": True, "meta": {}, "sha256": "a"}):
        with pytest.raises(ValueError):
            vs.save_video(object(), bad, by="x")
    full = {"ok": True, "meta": {}, "sha256": "a", "script": {},
            "channel": "tiktok", "sku": HONEY, "format": "9:16",
            "packshot_sha256": "p"}
    with pytest.raises(ValueError):
        vs.save_video(object(), full, by=" ")
    for k in ("channel", "sku", "format", "packshot_sha256"):
        for bad in (None, ""):
            with pytest.raises(ValueError, match=k):
                vs.save_video(object(), {**full, k: bad}, by="x")


@NEED_RENDER
def test_video_draft_approvable_by_human(built):
    """Nháp video duyệt được (re-check guardrail lúc duyệt không ngõ cụt
    thieu_nhan_ai / thieu_nhan_quang_cao)."""
    r = built["r1"]
    base = dict.fromkeys(store.COLS)
    base.update({"id": 7, "brief": "video", "channel": "tiktok",
                 "text": r["draft_text"], "guardrail": r["guardrail"],
                 "status": "pending", "source": "cli",
                 "created_by": "agent:mkt04", "content_type": "video",
                 "sku": HONEY, "is_ai": True})
    conn = _Conn([(("from content_drafts", "where id = %s"),
                   [tuple(base[c] for c in store.COLS)]),
                  (("from sku_readiness",), [(HONEY, "tiktok",
                                              "TP_THUONG")]),
                  (("select approve_draft(",), [(1,)])])
    assert store.set_status(conn, 7, "approved", "Hoa") == (True, None)
    assert any("approve_draft(" in s for s, _ in conn.calls)


def test_cli_usage_errors_exit_2(capsys):
    for argv in (["--sku", "all", "--channel", "tiktok"],
                 ["--sku", "all", "--channel", "zalo", "--brief", "x"],
                 ["--sku", "all", "--channel", "tiktok", "--format", "4:5",
                  "--brief", "x"],
                 ["--channel", "tiktok", "--brief", "x"]):
        with pytest.raises(SystemExit) as e:
            vs.main(argv)
        assert e.value.code == 2, argv


@pytest.mark.parametrize("setup", ["tts", "ffmpeg", "image"])
def test_cli_preflight_exit_2_before_db_and_llm(monkeypatch, llm, tmp_path,
                                                capsys, setup):
    f = llm(_js(SCENES5))
    monkeypatch.setenv("VIDEO_OUT_DIR", str(tmp_path / "o"))
    if setup == "tts":
        monkeypatch.setenv("TTS_PROVIDER", "x")
    elif setup == "ffmpeg":
        monkeypatch.setattr(vs, "find_ffmpeg", lambda: None)
    else:
        monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setattr(store, "_conn_or_none",
                        lambda: pytest.fail("không được mở DB"))
    assert vs.main(["--sku", "all", "--channel", "tiktok",
                    "--brief", BRIEF]) == 2
    assert "external-dep" in capsys.readouterr().err
    assert f.calls == [] and _files(tmp_path / "o") == []


def test_cli_db_down_exit_2_zero_llm(monkeypatch, llm, tmp_path, capsys):
    f = llm(_js(SCENES5))
    monkeypatch.setenv("VIDEO_OUT_DIR", str(tmp_path / "o"))

    @contextmanager
    def dead():
        yield None, "không kết nối được Postgres"

    monkeypatch.setattr(store, "_conn_or_none", dead)
    assert vs.main(["--sku", "all", "--channel", "tiktok",
                    "--brief", BRIEF]) == 2
    assert f.calls == [] and "không ghi được" in capsys.readouterr().err
    assert _files(tmp_path / "o") == []


def test_cli_lines_and_exit_codes(monkeypatch, capsys):
    @contextmanager
    def fake_conn():
        yield object(), None

    monkeypatch.setattr(store, "_conn_or_none", fake_conn)
    monkeypatch.setattr(store, "readiness_from_db", lambda c: {})
    plan = {"a": {"ok": True, "error": None, "path": "/x/aa.mp4"},
            "b": {"ok": True, "error": None, "path": "/x/bb.mp4"},
            "c": {"ok": False, "error": None,
                  "refused": {"code": "ruou", "reason": "rượu"}},
            "d": {"ok": True, "error": None, "path": "/x/dd.mp4"},
            "e": {"ok": False, "error": "llm: GatewayBlocked: kill",
                  "refused": None}}
    monkeypatch.setattr(vs, "make_video", lambda sku, *a, **k: plan[sku])
    saved = {"a": {"status": "created", "draft_id": 1, "asset_id": 9},
             "b": {"status": "skipped", "draft_id": 2}}

    def save(conn, res, by):
        sku = Path(res["path"]).stem[0]
        if sku == "d":
            raise psycopg.OperationalError("mất kết nối")
        return saved[sku]

    monkeypatch.setattr(vs, "save_video", save)
    assert vs.main(["--sku", "a", "--sku", "b", "--sku", "c",
                    "--channel", "tiktok", "--brief", "x"]) == 0
    o = capsys.readouterr().out
    assert "a × tiktok × 9:16: created #1 aa.mp4" in o
    assert "b × tiktok × 9:16: skipped bb.mp4" in o
    assert "c × tiktok × 9:16: refused ruou: rượu" in o
    assert "created 1, skipped 1, refused 1, failed 0" in o
    assert vs.main(["--sku", "d", "--sku", "e", "--channel", "tiktok",
                    "--brief", "x"]) == 1
    o = capsys.readouterr().out
    assert "d × tiktok × 9:16: failed: lỗi DB" in o
    assert "e × tiktok × 9:16: failed: llm: GatewayBlocked" in o


def test_cli_dead_host_subprocess_exit_2(tmp_path):
    """Gotcha v2.0: host chết thật (KHÔNG `env -u`) — exit 2, 0 file."""
    o = tmp_path / "o"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", OPENROUTER_API_KEY="",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x",
               VIDEO_OUT_DIR=str(o), PACKSHOT_DIR=str(tmp_path / "p"))
    for k in ("TTS_PROVIDER", "IMAGE_PROVIDER", "FFMPEG_BIN"):
        env.pop(k, None)
    r = subprocess.run([sys.executable, "-m", "pipelines.video_studio",
                        "--sku", "all", "--channel", "tiktok",
                        "--brief", "Quà núi rừng"],
                       cwd=ROOT, env=env, capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2, (r.stdout, r.stderr)
    assert "không ghi được" in r.stderr and r.stdout == ""
    assert _files(o) == []


def test_module_has_no_publish_or_network_path():
    src = (ROOT / "pipelines" / "video_studio.py").read_text(
        encoding="utf-8")
    assert not re.search(r"set_status|approve_draft|schedule|requests|httpx"
                         r"|urllib|import socket|shell=True|clone|speaker_wav"
                         r"|reference_audio", src)
    assert "shell=False" in src and "-map_metadata" in src and '"-an"' in src


def test_env_example_and_gitignore():
    env = (ROOT / "env.example").read_text(encoding="utf-8")
    for k in ("TTS_PROVIDER=none", "VIDEO_OUT_DIR=", "BROLL_DIR=",
              "FFMPEG_BIN="):
        assert k in env, k
    gi = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "data/video_assets/" in gi and "data/broll/" in gi
