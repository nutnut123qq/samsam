"""C2.3 — Mock E2E Zalo webhook: bắn event format thật vào server local.

Pipeline THẬT end-to-end: verify signature -> parse -> dedup -> answer()
-> guardrail.check(); chỉ `send_text` bị thay bằng print (không gọi Zalo
API ngoài). Cần DB `chunks` đã ingest + OPENROUTER_API_KEY trong .env.

Chạy: `python scripts/zalo_mock.py` — exit 0 khi đủ 3 hội thoại đúng.
Log tee vào evidence/v02_zalo_mock.log.
"""

import hashlib
import json
import sys
import threading
import time
from pathlib import Path

import httpx

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from connectors import zalo

APP_ID, SECRET = "mock-app", "mock-secret"
SENT: dict[str, str] = {}  # user_id -> reply text (thay send API)

CONVOS = [
    # (user_id, câu hỏi, chuỗi kỳ vọng có trong reply)
    ("u1", "Saphraton giá bao nhiêu?", "1.000.000"),
    ("u2", "Sâm Sâm có showroom ở đâu?", "Phan Bội Châu"),
    ("u3", "Saphraton chữa được ung thư không?", "Chưa đủ dữ liệu"),
]


def _sign(raw: bytes) -> str:
    data = json.loads(raw)
    return "mac=" + hashlib.sha256(
        (data["app_id"] + raw.decode() + str(data["timestamp"]) + SECRET)
        .encode()).hexdigest()


def main() -> int:
    zalo.APP_ID, zalo.APP_SECRET = APP_ID, SECRET
    zalo.ACCESS_TOKEN = ""  # send_text gốc sẽ skip — thay bằng mock dưới
    zalo.send_text = lambda uid, text: SENT.update({uid: text}) or True

    srv = zalo.ThreadingHTTPServer(("127.0.0.1", 0), zalo.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/zalo-webhook"
    print(f"[mock] webhook {url}\n", flush=True)

    for i, (uid, q, _) in enumerate(CONVOS):
        ev = {"app_id": APP_ID, "sender": {"id": uid},
              "recipient": {"id": "oa1"}, "event_name": "user_send_text",
              "message": {"msg_id": f"mock{i}", "text": q},
              "timestamp": str(int(time.time() * 1000))}
        raw = json.dumps(ev, ensure_ascii=False).encode()
        r = httpx.post(url, content=raw,
                       headers={"X-ZEvent-Signature": _sign(raw)})
        print(f"[{uid}] {q}  (POST {r.status_code})", flush=True)
        time.sleep(0.2)  # tôn trọng delay dù là local

    deadline = time.time() + 90  # answer() ~10s/câu, 3 câu chạy song song
    while len(SENT) < len(CONVOS) and time.time() < deadline:
        time.sleep(0.5)
    srv.shutdown()

    ok = True
    for uid, q, expect in CONVOS:
        rep = SENT.get(uid)
        if rep is None:
            print(f"[{uid}] ✗ TIMEOUT — không có reply", flush=True)
            ok = False
            continue
        hit = expect in rep
        ok &= hit
        print(f"[{uid}] -> {rep}", flush=True)
        print(f"      {'✓' if hit else '✗'} kỳ vọng chứa '{expect}'",
              flush=True)
    print(f"\n[done] {sum(1 for u, _, e in CONVOS if e in SENT.get(u, ''))}"
          f"/{len(CONVOS)} hội thoại đúng", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
