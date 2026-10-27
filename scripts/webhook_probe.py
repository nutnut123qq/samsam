"""Đợt hợp đồng C01 — dò `/readyz` của webhook Zalo/Messenger (job
`webhook_health` 5 phút; PL02 mục 2 "phát hiện sự cố trong 15 phút").

  python scripts/webhook_probe.py [--url URL ...] [--dry-run]

Mặc định dò `http://127.0.0.1:<ZALO_WEBHOOK_PORT|8788>/readyz` và
`…:<MESSENGER_WEBHOOK_PORT|8789>/readyz`. Mọi URL 200 + `ready: true` → exit
0. Có URL không sẵn sàng (không kết nối/timeout/503) → 1 cảnh báo đỏ
`webhook_probe` cho ĐỢT sự cố (đã có cảnh báo cùng nguồn chưa ai xác nhận
trong 24 giờ → không báo lặp) + exit 1. Không theo redirect, timeout 5 giây,
không in nội dung trả về ngoài mã trạng thái. `--dry-run` không ghi DB.
"""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SOURCE = "webhook_probe"
TIMEOUT_S = 5


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def default_urls(env=None) -> list[str]:
    env = os.environ if env is None else env
    return [f"http://127.0.0.1:{env.get(k) or d}/readyz"
            for k, d in (("ZALO_WEBHOOK_PORT", "8788"),
                         ("MESSENGER_WEBHOOK_PORT", "8789"))]


def probe(url: str, opener=None) -> tuple[bool, str]:
    opener = opener or urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(url, timeout=TIMEOUT_S) as r:
            body = json.loads(r.read(4096) or b"{}")
            ok = r.status == 200 and body.get("ready") is True
            return ok, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ValueError,
            http.client.HTTPException) as e:   # r17: BadStatusLine...
        return False, type(e).__name__


def alert(conn, failed: list[tuple[str, str]], routing=None) -> int | None:
    """1 cảnh báo đỏ / đợt; đã có cảnh báo `webhook_probe` chưa ack trong 24
    giờ → None (không lặp)."""
    from pipelines import red_alert
    if conn.execute(
            "select 1 from red_alerts r where r.source_agent = %s and r.ts >"
            " now() - interval '24 hours' and not exists (select 1 from"
            " red_alert_acks a where a.alert_id = r.id) limit 1",
            (SOURCE,)).fetchone():
        return None
    red_alert.raise_alert(
        conn, SOURCE, f"Webhook chatbot KHÔNG sẵn sàng ({len(failed)} điểm)",
        detail={"failed": [{"url": u, "status": st} for u, st in failed]},
        routing=routing)
    return conn.execute("select max(id) from red_alerts where source_agent ="
                        " %s", (SOURCE,)).fetchone()[0]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/webhook_probe.py")
    ap.add_argument("--url", action="append")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    urls = a.url or default_urls()
    failed = []
    for u in urls:
        ok, st = probe(u)
        print(f"[{'ok' if ok else 'LỖI'}] {u} — {st}")
        if not ok:
            failed.append((u, st))
    if not failed:
        return 0
    if a.dry_run:
        return 1
    from ingest.lead_store import connect
    conn = connect()
    if conn is None:
        print("[error] không kết nối được DB — chưa ghi cảnh báo đỏ",
              file=sys.stderr)
        return 1
    try:
        aid = alert(conn, failed)
        conn.commit()
    finally:
        conn.close()
    print(f"[ALERT] cảnh báo đỏ #{aid}" if aid else
          "[ALERT] đã có cảnh báo cùng đợt chưa xác nhận — không báo lặp",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
