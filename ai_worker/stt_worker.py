"""Tiến trình STT CON của `ai_worker.server` (provider `whisper_local`) — như `ingest.ocr_worker` cho OCR.
Chỉ cha gọi: `python -m ai_worker.stt_worker` + JSON qua stdin {path}. Nạp faster-whisper + chép lời ở ĐÂY
(`connectors.zalo_garden._stt_whisper_local`: giải mã PyAV, trần GARDEN_STT_MAX_SECONDS, hạn
GARDEN_STT_TIMEOUT_S bọc cả nạp model) để engine native hỏng/treo chỉ chết tiến trình này.
Kết quả: 1 dòng cuối stdout `STT_RESULT {"ok": true, "text": NHÁP}` | `{"ok": false, "error": …}` — chữ
và lỗi đã qua `_mask_pii` (như `zalo_garden._transcribe`). Không DB, không mạng."""
import json
import sys
import unicodedata
from pathlib import Path

RESULT_TAG = "STT_RESULT "


def main() -> int:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    from connectors import zalo_garden as zg
    from pipelines.pii import _mask_pii
    name = "whisper_local"
    try:
        text = unicodedata.normalize("NFC", str(zg._stt_whisper_local(Path(req["path"])) or "")).strip()
        out = ({"ok": True, "text": _mask_pii(text)[:zg.MAX_DETAIL]} if text else
               {"ok": False, "error": f"STT {name} không ra chữ — người nghe ghi tay"})
    except RuntimeError as e:  # lỗi đã mô tả (định dạng/độ dài/timeout/thiếu model)
        out = {"ok": False, "error": f"STT {name}: {_mask_pii(str(e))[:200]}"}
    except Exception as e:  # noqa: BLE001 — lỗi provider bất kỳ → lỗi có kiểm soát
        out = {"ok": False, "error": f"STT {name} lỗi ({type(e).__name__})"}
    sys.stdout.flush()
    sys.stdout.buffer.write(("\n" + RESULT_TAG + json.dumps(out) + "\n").encode("utf-8"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
