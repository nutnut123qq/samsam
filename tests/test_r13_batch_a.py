"""r13 đợt A: OCR tại chỗ (doc_intake `paddle_local` — production-03, data_platform-02.1), STT tại chỗ (zalo_garden
`whisper_local` — farming-01), API sinh ảnh nền (image_studio `openrouter_images` — marketing-02.1). Không DB, không mạng;
chữ/số trong fixture là GIẢ."""
import base64
import hashlib
import importlib.util
import io
import json
import math
import socket
import struct
import sys
import time
import wave
from pathlib import Path

import httpx
import pytest
from PIL import Image, ImageDraw, ImageFont

from connectors import zalo_garden as zg
from ingest import doc_intake as di
from pipelines import image_studio as ims
from pipelines import llm_gateway as gw


@pytest.fixture
def no_network(monkeypatch):
    calls = []

    def boom(self, *a, **k):
        calls.append(a)
        raise AssertionError("không được gọi mạng")
    monkeypatch.setattr(socket.socket, "connect", boom)
    return calls


# --- OCR ---------------------------------------------------------------------

def _models_ok():
    root = Path.home() / ".paddleocr" / "whl"
    return importlib.util.find_spec("paddleocr") is not None and all(
        root.joinpath(*v, f).is_file() for v in di._PADDLE_SUBDIRS.values() for f in di._PADDLE_FILES)


def _label_png(path):
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 34)
    except OSError:
        pytest.skip("không có font Arial để vẽ nhãn thử")
    im = Image.new("RGB", (1100, 300), "white")
    d = ImageDraw.Draw(im)
    for i, t in enumerate(["Mật ong sâm 300ml", "Số ĐKSP: 15/2026/ĐKSP", "NSX: 12/10/2026", "LOT: L2026-1012"]):
        d.text((30, 20 + 64 * i), t, fill="black", font=font)
    im.save(path)


@pytest.mark.skipif(not _models_ok(), reason="chưa có paddleocr/model latin cục bộ — OCR thật CHƯA KIỂM")
def test_ocr_paddle_local_reads_real_label(tmp_path, no_network, monkeypatch):
    from agents import sx_label
    monkeypatch.delenv("OCR_PADDLE_MODEL_DIR", raising=False)
    p = tmp_path / "nhan.png"
    _label_png(p)
    text, pages, src = di.extract_text(p, "paddle_local")
    f = sx_label.extract(text)
    assert (src, pages) == ("ocr", 1)
    assert f["dksp"] == ["15/2026/ĐKSP"] and f["lots"] == ["L2026-1012"]
    assert [str(d) for d in f["nsx"]] == ["2026-10-12"]
    assert no_network == []


def test_ocr_missing_models_refused_without_network(tmp_path, monkeypatch, no_network):
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(di, "_paddle", None)
    p = tmp_path / "a.png"
    Image.new("RGB", (40, 40), "white").save(p)
    with pytest.raises(di.DocError, match="thiếu model"):
        di.extract_text(p, "paddle_local")
    assert no_network == []


def test_ocr_page_cap_and_corrupt_image(tmp_path, monkeypatch):
    bad = tmp_path / "x.jpg"
    bad.write_bytes(b"\xff\xd8\xff\xe0" + bytes(200))
    with pytest.raises(di.DocError, match="ảnh hỏng"):
        di._page_images(bad)
    gif = tmp_path / "x.png"
    Image.new("RGB", (8, 8)).save(gif, "GIF")
    with pytest.raises(di.DocError, match="GIF"):
        di._page_images(gif)
    # r20: PyMuPDF (AGPL) chỉ đi cùng engine OCR tùy chọn, không có trong
    # requirements/CI — phần PDF skip khi thiếu, phần ảnh vẫn chạy ở trên
    fitz = pytest.importorskip("fitz")
    monkeypatch.setattr(di, "OCR_MAX_PAGES", 2)
    doc = fitz.open()
    for _ in range(3):
        doc.new_page(width=50, height=50)
    pdf = tmp_path / "x.pdf"
    doc.save(pdf)
    with pytest.raises(di.DocError, match="OCR_MAX_PAGES"):
        di._page_images(pdf)


def test_ocr_timeout(tmp_path, monkeypatch):
    # r14 C1: OCR chạy ở tiến trình con — treo → giết con khi quá hạn
    for parts in di._PADDLE_SUBDIRS.values():
        d = tmp_path.joinpath("m", *parts)
        d.mkdir(parents=True)
        for f in di._PADDLE_FILES:
            (d / f).write_bytes(b"x")
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path / "m"))
    monkeypatch.setattr(di, "OCR_WORKER", [sys.executable, "-c", "import time; time.sleep(30)"])
    monkeypatch.setattr(di, "OCR_TIMEOUT_S", 1)
    p = tmp_path / "a.png"
    Image.new("RGB", (20, 20), "white").save(p)
    t0 = time.monotonic()
    with pytest.raises(di.DocError, match="quá"):
        di._ocr_paddle_local(p)
    assert time.monotonic() - t0 < 20


def test_intake_records_ocr_engine_same_tx(tmp_path, monkeypatch):
    from tests.test_doc_intake import FakeConn, make_pdf
    intake, orig = tmp_path / "intake", tmp_path / "orig"
    (intake / "giay_tiep_nhan").mkdir(parents=True)
    (intake / "giay_tiep_nhan" / "scan.pdf").write_bytes(make_pdf(None))
    monkeypatch.setitem(di.PROVIDERS, "paddle_local", (lambda p: "So 77/2025/ĐKSP", True))
    conn = FakeConn()
    c = di.intake(intake, orig, conn, "paddle_local")
    upd = [p for s, p, _ in conn.sql if s.startswith("update documents set ocr_engine")]
    assert c["new"] == 1 and upd and upd[0][0] == di.OCR_ENGINES["paddle_local"]
    assert [s for s, _, _ in conn.sql].index(next(s for s, _, _ in conn.sql if s.startswith("update documents"))) \
        > [s for s, _, _ in conn.sql].index(next(s for s, _, _ in conn.sql if s.startswith("insert into documents")))


# --- STT ---------------------------------------------------------------------

def _wav(seconds):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000)))
                               for i in range(int(16000 * seconds))))
    return buf.getvalue()


@pytest.fixture
def stt(tmp_path, monkeypatch):
    pytest.importorskip("av")
    import sys
    import types
    calls = {"init": 0, "audio": [], "text": "", "sleep": 0}

    class Seg:
        def __init__(self, t):
            self.text = t

    class Fake:
        def __init__(self, path, **kw):
            calls["init"] += 1
            calls["kw"] = kw

        def transcribe(self, audio, **kw):
            calls["audio"].append((len(audio), kw.get("language")))
            time.sleep(calls["sleep"])
            return iter([Seg(x) for x in calls["text"].split("|")]), None
    # module giả: không nạp ctranslate2 (xung đột DLL với PaddleOCR cùng tiến trình)
    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Fake))
    monkeypatch.setattr(zg, "_whisper", None)
    md = tmp_path / "model"
    md.mkdir()
    (md / "model.bin").write_bytes(b"x")
    monkeypatch.setenv("GARDEN_STT_MODEL_DIR", str(md))
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "whisper_local")
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "store"))

    class Conn:
        def __init__(self, row):
            self.row = row

        def execute(self, *a, **k):
            return self

        def fetchone(self):
            return self.row

    def run(data, ext):
        sha = hashlib.sha256(data).hexdigest()
        d = tmp_path / "store" / "audio" / sha[:2]
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{sha}.{ext}").write_bytes(data)
        return zg._transcribe(Conn((sha, ext)), 1, "whisper_local")
    return calls, run


def test_stt_transcribe_draft_masks_pii(stt, capsys, no_network):
    calls, run = stt
    calls["text"] = "Khoảnh KV-A01 tưới 30 phút|gọi 0912345678"
    assert run(_wav(2.0), "wav") == 0
    out = capsys.readouterr().out
    assert "NHÁP" in out and "KV-A01" in out and "0912345678" not in out
    n, lang = calls["audio"][-1]
    assert abs(n - 32000) <= 1600 and lang == "vi"
    assert calls["kw"].get("local_files_only") is True and calls["init"] == 1
    assert no_network == []


def test_stt_empty_corrupt_long_timeout(stt, monkeypatch):
    calls, run = stt
    calls["text"] = " "
    assert run(_wav(1.0), "wav") == 1
    n0 = len(calls["audio"])
    assert run(b"#!AMR\n" + bytes(range(256)) * 4, "amr") == 1
    monkeypatch.setattr(zg, "STT_MAX_SECONDS", 1.0)
    assert run(_wav(2.5), "wav") == 1
    assert len(calls["audio"]) == n0                     # hỏng/quá dài: không gọi model
    monkeypatch.setattr(zg, "STT_MAX_SECONDS", 600.0)
    monkeypatch.setattr(zg, "STT_TIMEOUT_S", 0.2)
    calls["text"], calls["sleep"] = "muộn", 1.0
    assert run(_wav(1.1), "wav") == 1


def test_stt_without_model_blocked_before_db(monkeypatch, capsys):
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "whisper_local")
    monkeypatch.delenv("GARDEN_STT_MODEL_DIR", raising=False)
    monkeypatch.setattr(zg, "_connect", lambda: pytest.fail("không được kết nối DB"))
    assert zg.main(["--transcribe", "1"]) == 2
    assert "GARDEN_STT_MODEL_DIR" in capsys.readouterr().err


# --- ảnh nền AI ----------------------------------------------------------------

@pytest.fixture
def img_api(monkeypatch):
    req, rec, state = [], [], {"spend": 0.0, "script": []}
    monkeypatch.setattr(gw, "_month_spend", lambda agent, sql=None: state["spend"])
    monkeypatch.setattr(gw, "_record", lambda *a, **k: rec.append((a[0], a[4], a[5], k.get("feature"))))
    monkeypatch.setattr(gw, "_config", lambda: {"provider_only": ["prov-a"], "kill": set(),
                                                "monthly_cap_usd": {"default": 5.0}, "kill_features": set(),
                                                "feature_caps_usd": {"default": 5.0}})

    def handler(request):
        body = json.loads(request.content)
        req.append(body)
        step = state["script"].pop(0) if state["script"] else 200
        if step != 200:
            return httpx.Response(step, json={})
        w, h = map(int, body["size"].split("x"))
        b = io.BytesIO()
        Image.new("RGB", (w, h), (10, 90, 40)).save(b, "PNG")
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b.getvalue()).decode(),
                                                   "media_type": "image/png"}], "usage": {"cost": 0.04}})
    from pipelines import image_provider_openrouter as orp
    monkeypatch.setattr(orp, "_image_http", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(time, "sleep", lambda s: None)
    monkeypatch.setenv("OPENROUTER_API_KEY", "khoa-gia")
    monkeypatch.setenv("IMAGE_MODEL", "vendor/model-gia")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    return req, rec, state


def test_image_openrouter_success_contract(img_api):
    req, rec, _ = img_api
    img, meta = ims.generate_background("nền vườn sâm", (64, 48), provider="openrouter_images")
    assert img.size == (64, 48) and meta == {"provider": "openrouter_images", "model": "vendor/model-gia",
                                             "ai_generated": True}
    assert req == [{"model": "vendor/model-gia", "prompt": "nền vườn sâm", "size": "64x48", "output_format": "png",
                    "n": 1, "provider": {"only": ["prov-a"], "allow_fallbacks": False}}]
    assert rec == [("image", 0.04, True, "marketing-02.1")]


@pytest.mark.parametrize("setup", ["no_model", "no_key", "kill", "spend_unknown", "over_cap"])
def test_image_blocked_zero_requests(img_api, monkeypatch, setup):
    req, _, state = img_api
    if setup == "no_model":
        monkeypatch.delenv("IMAGE_MODEL")
    elif setup == "no_key":
        monkeypatch.delenv("OPENROUTER_API_KEY")
    elif setup == "kill":
        monkeypatch.setattr(gw, "_config", lambda: {"provider_only": ["prov-a"], "kill": set(),
                                                    "monthly_cap_usd": {"default": 5.0},
                                                    "kill_features": {"marketing-02.1"},
                                                    "feature_caps_usd": {"default": 5.0}})
    else:
        state["spend"] = None if setup == "spend_unknown" else 99.0
    with pytest.raises(ims.ImageProviderError):
        ims.generate_background("nền", (32, 32), provider="openrouter_images")
    assert req == []


def test_image_retry_once_then_fail(img_api):
    req, rec, state = img_api
    state["script"] = [502]
    ims.generate_background("nền", (32, 32), provider="openrouter_images")
    assert len(req) == 2 and [r[2] for r in rec] == [True]
    req.clear()
    rec.clear()
    state["script"] = [429, 429]
    with pytest.raises(ims.ImageProviderError, match="429"):
        ims.generate_background("nền", (32, 32), provider="openrouter_images")
    assert len(req) == 2 and [r[2] for r in rec] == [False]


def test_ocr_missing_cls_model_refused(tmp_path, monkeypatch, no_network):
    """PaddleOCR 2.x tự tải model cls khi thiếu thư mục (kể cả use_angle_cls=False) → phải từ chối trước."""
    for k in ("det", "rec"):
        d = tmp_path.joinpath(*di._PADDLE_SUBDIRS[k])
        d.mkdir(parents=True)
        (d / "inference.pdmodel").write_bytes(b"x")
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(di, "_paddle", None)
    with pytest.raises(di.DocError, match="cls"):
        di._paddle_engine()
    assert no_network == []


def test_intake_cli_ocr_empty_not_silent(tmp_path, monkeypatch, capsys):
    from pipelines import loader_gate
    from tests.test_doc_intake import FakeConn
    intake = tmp_path / "intake" / "nhan"
    intake.mkdir(parents=True)
    Image.new("RGB", (40, 40), "white").save(intake / "trang.png")
    monkeypatch.setenv("DOC_INTAKE_DIR", str(tmp_path / "intake"))
    monkeypatch.setenv("DOC_ORIGINALS_DIR", str(tmp_path / "orig"))
    monkeypatch.setenv("OCR_PROVIDER", "paddle_local")
    monkeypatch.setitem(di.PROVIDERS, "paddle_local", (lambda p: "", True))
    monkeypatch.setattr(di.lead_store, "connect", lambda: FakeConn())
    monkeypatch.setattr(di, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(loader_gate, "check", lambda *a, **k: None)
    assert di.main([]) == 2
    assert "[cho_ocr] 1 tài liệu OCR (paddle_local) không ra chữ" in capsys.readouterr().out
