"""r14 C1 — tiến trình OCR CON của `ingest.doc_intake` (provider `paddle_local`). Chỉ cha gọi:
`python -m ingest.ocr_worker` + JSON qua stdin {path, model_dir, max_pages}. Nạp PaddleOCR + render trang + nhận dạng ở
ĐÂY để engine native hỏng (crash/treo) chỉ chết tiến trình này — cha thấy mã thoát/timeout và báo DocError.
Kết quả: 1 dòng cuối stdout `OCR_RESULT {"ok": true, "text": …}` | `{"ok": false, "error": …}` (thông điệp lỗi không
chứa nội dung tài liệu). Không DB, không mạng."""
import json
import os
import sys
from pathlib import Path


def main() -> int:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    os.environ["OCR_PADDLE_MODEL_DIR"] = str(req["model_dir"])
    from ingest import doc_intake as di
    di.OCR_MAX_PAGES = int(req["max_pages"])
    try:
        out = {"ok": True, "text": di.ocr_pages(Path(req["path"]))}
    except di.DocError as e:
        out = {"ok": False, "error": str(e)[:200]}
    except Exception as e:  # noqa: BLE001 — lỗi Python của engine → lỗi có kiểm soát
        out = {"ok": False, "error": f"OCR lỗi ({type(e).__name__})"}
    sys.stdout.flush()
    sys.stdout.buffer.write(("\n" + di.OCR_RESULT_TAG + json.dumps(out) + "\n").encode("utf-8"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
