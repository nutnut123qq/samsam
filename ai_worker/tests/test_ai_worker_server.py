"""ai_worker: HTTP nội bộ bọc OCR paddle_local + STT whisper_local. Tiến trình con GIẢ (như
tests/test_r14_code_gaps.py) — không nạp PaddleOCR/faster-whisper, không DB, không mạng ngoài.
Chạy: python -m pytest ai_worker/tests"""
import io
import json
import os
import sys
import threading
import urllib.error
import urllib.request

import pytest

from ai_worker import server as srv
from ai_worker import stt_worker
from connectors import zalo_garden as zg
from ingest import doc_intake as di

WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 40


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    # lỡ có đường chạm DB thì lỗi ngay, không bao giờ DB samsam
    monkeypatch.setenv("DATABASE_URL", "postgresql://golden@127.0.0.1:9/golden_none")


@pytest.fixture
def base(monkeypatch):
    for k in ("OCR_PROVIDER", "GARDEN_STT_PROVIDER", "GARDEN_STT_MODEL_DIR", "OCR_PADDLE_MODEL_DIR"):
        monkeypatch.delenv(k, raising=False)
    s = srv.make_server("127.0.0.1", 0)
    t = threading.Thread(target=s.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{s.server_address[1]}"
    s.shutdown()
    s.server_close()


def call(url, data=None):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@pytest.fixture
def stt_ready(tmp_path, monkeypatch):
    md = tmp_path / "whisper"
    md.mkdir()
    (md / "model.bin").write_bytes(b"x")
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "whisper_local")
    monkeypatch.setenv("GARDEN_STT_MODEL_DIR", str(md))


@pytest.fixture
def ocr_ready(tmp_path, monkeypatch):
    for parts in di._PADDLE_SUBDIRS.values():
        d = tmp_path.joinpath("m", *parts)
        d.mkdir(parents=True)
        for f in di._PADDLE_FILES:
            (d / f).write_bytes(b"x")
    monkeypatch.setenv("OCR_PROVIDER", "paddle_local")
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path / "m"))


def _child(monkeypatch, code, *args):
    monkeypatch.setattr(srv, "STT_WORKER", [sys.executable, "-c", code, *map(str, args)])


@pytest.mark.parametrize("host,ok", [
    ("127.0.0.1", True), ("::1", True), ("10.1.2.3", True), ("172.18.0.5", True),
    ("192.168.1.9", True), ("fd00::1", True), ("::ffff:10.0.0.1", True),
    ("8.8.8.8", False), ("169.254.1.1", False), ("100.64.0.1", False),
    ("2001:4860::1", False), ("::ffff:8.8.8.8", False), ("abc", False), ("", False)])
def test_client_allowed_only_internal(host, ok):
    assert srv.client_allowed(host) is ok


def test_readyz_reports_blocked(base, stt_ready, ocr_ready, monkeypatch):
    monkeypatch.delenv("OCR_PROVIDER")
    monkeypatch.delenv("GARDEN_STT_PROVIDER")
    assert call(base + "/readyz") == (200, {"ocr": di.OCR_BLOCKED, "stt": zg.STT_HELP})
    monkeypatch.setenv("OCR_PROVIDER", "paddle_local")
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "whisper_local")
    assert call(base + "/readyz") == (200, {"ocr": None, "stt": None})
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", "/khong/co")
    monkeypatch.delenv("GARDEN_STT_MODEL_DIR")
    _st, body = call(base + "/readyz")
    assert "thiếu model OCR" in body["ocr"] and "GARDEN_STT_MODEL_DIR" in body["stt"]


def test_stt_blocked_before_child(base, tmp_path, monkeypatch):
    mark = tmp_path / "ran"
    _child(monkeypatch, "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('x')", mark)
    for prov in ("", "google_stt", "whisper_local"):     # whisper_local thiếu model
        monkeypatch.setenv("GARDEN_STT_PROVIDER", prov)
        st, body = call(base + "/stt", WAV)
        assert st == 503 and body["blocked"] is True and "BLOCKED" in body["error"]
    assert not mark.exists()


def test_stt_ok_masked_draft_and_child_env(base, stt_ready, tmp_path, monkeypatch):
    seen = tmp_path / "req.json"
    # tests/_db_guard chèn DSN RỖNG vào env mọi tiến trình con (chặn dotenv) → chỉ bắt biến có giá trị
    _child(monkeypatch, "import sys,os,json,pathlib; r=json.loads(sys.stdin.read());"
                        " bad=[k for k, v in os.environ.items()"
                        " if v and (k.endswith('DATABASE_URL') or k.startswith('PG'))];"
                        " pathlib.Path(sys.argv[1]).write_text(json.dumps([r['path'], bad]));"
                        " print('log engine'); print('STT_RESULT ' + json.dumps({'ok': True, 'text': 'KV-A01 tưới'}))",
           seen)
    monkeypatch.setenv("PGPASSWORD", "khong-dung")
    assert call(base + "/stt", WAV) == (200, {"ok": True, "text": "KV-A01 tưới"})
    path, bad = json.loads(seen.read_text())
    assert path.endswith("audio.wav") and bad == []
    assert not os.path.exists(path)                       # tệp tạm đã xóa


@pytest.mark.parametrize("code,msg", [
    ("import os; os.abort()", "thoát bất thường"),
    ("import sys; sys.exit(7)", r"thoát bất thường (mã 7)"),
    ("print('rác')", "kết quả hỏng"),
    ("print('STT_RESULT {not json')", "kết quả hỏng"),
    ("print('STT_RESULT {\"ok\": true, \"text\": 5}')", "kết quả hỏng"),
    ("print('STT_RESULT {\"ok\": false, \"error\": \"STT whisper_local: ghi âm rỗng\"}')", "ghi âm rỗng")])
def test_stt_child_failures_controlled(base, stt_ready, monkeypatch, code, msg):
    _child(monkeypatch, code)
    st, body = call(base + "/stt", WAV)
    assert st == 200 and body["ok"] is False and msg in body["error"]


def test_stt_timeout_kills_child(base, stt_ready, tmp_path, monkeypatch):
    late = tmp_path / "late"
    _child(monkeypatch, f"import time,pathlib; time.sleep(4); pathlib.Path(r'{late}').write_text('muon')")
    monkeypatch.setattr(zg, "STT_TIMEOUT_S", 1.0)
    monkeypatch.setattr(srv, "STT_DECODE_GRACE_S", 0)
    st, body = call(base + "/stt", WAV)
    assert st == 200 and "quá 1 giây" in body["error"]
    import time
    time.sleep(4.5)
    assert not late.exists()


def test_stt_bad_magic_and_limits(base, stt_ready, monkeypatch):
    st, body = call(base + "/stt", b"not audio at all")
    assert st == 400 and "magic bytes" in body["error"]
    monkeypatch.setattr(zg, "MAX_MEDIA", 10)
    assert call(base + "/stt", WAV)[0] == 413
    assert call(base + "/khong")[0] == 404


def test_ocr_paths(base, ocr_ready, tmp_path, monkeypatch):
    monkeypatch.setattr(di, "OCR_WORKER", [sys.executable, "-c",
                        "import json; print('OCR_RESULT ' + json.dumps({'ok': True, 'text': 'LOT L1'}))"])
    assert call(base + "/ocr", b"%PDF-1.4 ...") == (200, {"ok": True, "text": "LOT L1"})
    monkeypatch.setattr(di, "OCR_WORKER", [sys.executable, "-c", "import sys; sys.exit(3)"])
    st, body = call(base + "/ocr", b"%PDF-1.4 ...")
    assert st == 200 and body["ok"] is False and "mã 3" in body["error"]
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path / "khong"))
    st, body = call(base + "/ocr", b"x")
    assert st == 200 and "thiếu model OCR" in body["error"]
    monkeypatch.setenv("OCR_PROVIDER", "none")
    st, body = call(base + "/ocr", b"x")
    assert st == 503 and body["error"] == di.OCR_BLOCKED
    monkeypatch.setenv("OCR_PROVIDER", "paddle_local")
    monkeypatch.setattr(srv, "OCR_MAX_BYTES", 4)
    assert call(base + "/ocr", b"12345")[0] == 413


# ---- tiến trình con STT (chạy main() tại chỗ với _stt_whisper_local GIẢ) -------
def _run_child(monkeypatch, fn):
    monkeypatch.setattr(zg, "_stt_whisper_local", fn)
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(b'{"path": "a.wav"}')))
    buf = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(buf))
    assert stt_worker.main() == 0
    sys.stdout.flush()
    line = buf.getvalue().decode().strip().splitlines()[-1]
    assert line.startswith(stt_worker.RESULT_TAG)
    return json.loads(line[len(stt_worker.RESULT_TAG):])


def _raise(e):
    def f(_p):
        raise e
    return f


def test_stt_child_masks_and_maps_errors(monkeypatch):
    out = _run_child(monkeypatch, lambda p: " Khoảnh KV-A01 tưới 30 phút gọi 0912345678 ")
    assert out["ok"] is True and "KV-A01" in out["text"] and "0912345678" not in out["text"]
    assert _run_child(monkeypatch, lambda p: "  ") == {
        "ok": False, "error": "STT whisper_local không ra chữ — người nghe ghi tay"}
    assert _run_child(monkeypatch, _raise(RuntimeError("ghi âm rỗng"))) == {
        "ok": False, "error": "STT whisper_local: ghi âm rỗng"}
    assert _run_child(monkeypatch, _raise(ValueError("x"))) == {
        "ok": False, "error": "STT whisper_local lỗi (ValueError)"}
