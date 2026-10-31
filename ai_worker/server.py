"""AI worker nội bộ (viết lại TS — docs/rewrite/KE_HOACH.md mục 2): HTTP stdlib cho api/worker TS trên
mạng `ai_private` (internal), bọc đúng code Python đang chạy — không viết lại engine:
  - OCR tại chỗ `paddle_local`: `ingest.doc_intake._ocr_paddle_local` (kiểm model → tiến trình con
    `ingest.ocr_worker`, hạn OCR_TIMEOUT_S bọc cả nạp model, crash/treo → lỗi có kiểm soát).
  - STT tại chỗ `whisper_local`: `connectors.zalo_garden.stt_provider` + `audio_kind`, chép lời ở
    tiến trình con `ai_worker.stt_worker` (`_stt_whisper_local`; ctranslate2 xung đột DLL với
    PaddleOCR nên không chung tiến trình; treo → giết con). Bản chép là NHÁP đã `_mask_pii`.

Giao thức (JSON UTF-8):
  GET  /readyz → 200 {"ocr": null|lý do, "stt": null|lý do}   (không nhận dữ liệu)
  POST /ocr    thân = byte JPG/PNG/PDF (≤ OCR_MAX_BYTES) → 200 {"ok": true, "text"} | {"ok": false, "error"}
  POST /stt    thân = byte ghi âm (≤ MAX_MEDIA, magic bytes) → 200 {"ok": true, "text": NHÁP} | {"ok": false, "error"}
  503 {"ok": false, "blocked": true, "error"} = provider chưa cấu hình — trả TRƯỚC khi đọc thân (không
  nhận/ghi audio, như `--transcribe` exit 2); 400/413 thân sai/quá lớn; 403 client ngoài mạng nội bộ.
Chỉ nhận client loopback/mạng riêng (RFC1918/ULA). Mặc định nghe 127.0.0.1:8790 (AI_WORKER_HOST/
AI_WORKER_PORT; compose đặt 0.0.0.0 trong mạng internal). Không DB, không gọi mạng ra ngoài; tệp tạm ở thư
mục riêng, xóa ngay sau xử lý; một việc OCR/STT một lúc (RAM/GPU máy chủ).

Chạy: python -m ai_worker
"""

import ipaddress
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OCR_MAX_BYTES = 50 * 1024 * 1024       # GIẢ ĐỊNH — tài liệu scan ≤ OCR_MAX_PAGES trang
STT_WORKER = [sys.executable, "-m", "ai_worker.stt_worker"]
STT_RESULT_TAG = "STT_RESULT "
STT_DECODE_GRACE_S = 60                 # giải mã PyAV nằm ngoài hạn STT_TIMEOUT_S của Python
_job = threading.Lock()


def _di():
    from ingest import doc_intake
    return doc_intake


def _zg():
    from connectors import zalo_garden
    return zalo_garden


def client_allowed(host: str) -> bool:
    """Chỉ loopback / mạng riêng (IPv4-mapped IPv6 xét theo IPv4)."""
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback or (ip.is_private and not ip.is_link_local)


def ocr_blocked() -> str | None:
    if os.environ.get("OCR_PROVIDER", "").strip() != "paddle_local":
        return _di().OCR_BLOCKED
    return None


def stt_blocked() -> str | None:
    return _zg().stt_provider()[1]


def ready() -> dict:
    ocr = ocr_blocked()
    if ocr is None:
        di = _di()
        try:
            di._model_root()
        except di.DocError as e:
            ocr = str(e)
    return {"ocr": ocr, "stt": stt_blocked()}


def handle_ocr(data: bytes) -> tuple[int, dict]:
    di = _di()
    with tempfile.TemporaryDirectory(prefix="aiw-ocr-") as d:
        p = Path(d) / "doc"
        p.write_bytes(data)
        try:
            return 200, {"ok": True, "text": di._ocr_paddle_local(p)}
        except di.DocError as e:
            return 200, {"ok": False, "error": str(e)[:200]}


def _child_env() -> dict:
    return {k: v for k, v in os.environ.items()
            if not (k.endswith("DATABASE_URL") or k.startswith("PG"))}


def _run_stt(path: Path) -> dict:
    """Tiến trình con chép lời; hỏng/treo/kết quả lạ → lỗi có kiểm soát (như `_ocr_paddle_local`)."""
    timeout = _zg().STT_TIMEOUT_S + STT_DECODE_GRACE_S
    try:
        r = subprocess.run(STT_WORKER, input=json.dumps({"path": str(path)}).encode("utf-8"),
                           capture_output=True, timeout=timeout, check=False, cwd=ROOT,
                           env=_child_env())
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"STT whisper_local: STT quá {timeout:g} giây — đã dừng tiến "
                                      "trình STT, bỏ"}
    except OSError as e:
        return {"ok": False, "error": f"không chạy được tiến trình STT ({type(e).__name__})"}
    if r.returncode != 0:
        return {"ok": False, "error": f"tiến trình STT thoát bất thường (mã {r.returncode}) — "
                                      "model/engine hỏng? không có kết quả"}
    out = None
    for line in reversed(r.stdout.decode("utf-8", "replace").splitlines()):
        if line.startswith(STT_RESULT_TAG):
            try:
                out = json.loads(line[len(STT_RESULT_TAG):])
            except ValueError:
                pass
            break
    if not isinstance(out, dict) or not (
            (out.get("ok") is True and isinstance(out.get("text"), str))
            or (out.get("ok") is False and isinstance(out.get("error"), str))):
        return {"ok": False, "error": "tiến trình STT trả kết quả hỏng — bỏ"}
    return out


def handle_stt(data: bytes) -> tuple[int, dict]:
    try:
        ext = _zg().audio_kind(data)
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}
    with tempfile.TemporaryDirectory(prefix="aiw-stt-") as d:
        p = Path(d) / f"audio.{ext}"
        p.write_bytes(data)
        return 200, _run_stt(p)


# route → (giới hạn byte, kiểm chặn trước khi đọc thân, xử lý)
ROUTES = {
    "/ocr": (lambda: OCR_MAX_BYTES, ocr_blocked, handle_ocr),
    "/stt": (lambda: _zg().MAX_MEDIA, stt_blocked, handle_stt),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "samsam-ai-worker"
    sys_version = ""

    def log_message(self, fmt, *args):  # không in IP/thân — chỉ dòng yêu cầu + mã
        print(f"[ai-worker] {fmt % args}", flush=True)

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, code: int, obj: dict) -> None:
        self.close_connection = True       # thân chưa đọc — không giữ kết nối
        self._send(code, obj)

    def do_GET(self):
        if not client_allowed(self.client_address[0]):
            return self._reject(403, {"ok": False, "error": "chỉ nhận mạng nội bộ"})
        if self.path != "/readyz":
            return self._reject(404, {"ok": False, "error": "không có"})
        self._send(200, ready())

    def do_POST(self):
        if not client_allowed(self.client_address[0]):
            return self._reject(403, {"ok": False, "error": "chỉ nhận mạng nội bộ"})
        route = ROUTES.get(self.path)
        if route is None:
            return self._reject(404, {"ok": False, "error": "không có"})
        limit, blocked, handle = route
        if self.headers.get("Transfer-Encoding"):
            return self._reject(411, {"ok": False, "error": "cần Content-Length"})
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            n = -1
        if n <= 0:
            return self._reject(400, {"ok": False, "error": "thân rỗng / thiếu Content-Length"})
        if n > limit():
            return self._reject(413, {"ok": False, "error": "tệp quá lớn"})
        why = blocked()
        if why:
            # Bỏ thân KHÔNG ghi đĩa/không xử lý (đọc hết để client nhận được 503, không bị reset).
            left = n
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
            return self._send(503, {"ok": False, "blocked": True, "error": why})
        data = self.rfile.read(n)
        if len(data) != n:
            return self._reject(400, {"ok": False, "error": "thân bị cắt"})
        with _job:
            code, obj = handle(data)
        self._send(code, obj)


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


def main() -> int:
    host = os.environ.get("AI_WORKER_HOST", "").strip() or "127.0.0.1"
    port = int(os.environ.get("AI_WORKER_PORT", "").strip() or "8790")
    srv = make_server(host, port)
    print(f"[ai-worker] nghe {host}:{port} — chỉ nhận client mạng nội bộ", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0
