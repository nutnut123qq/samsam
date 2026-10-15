"""v13.8 C09 — cập nhật văn bản pháp luật mới → hàng duyệt Pháp chế (PL01
"Nhân sự: … cập nhật văn bản pháp luật mới (P2)", tính năng `legal_hr-07`).

NỐI PC-A8 (v10.2), không viết luật mới:
  - Nguồn: `intel_items` do `crawler.intel` thu từ nguồn văn bản tầng A
    (`legal_sources` trong `data/intel_alert_rules.json`, id thuộc
    `data/intel_sources.json` — URL nguồn chờ Pháp chế duyệt). Chọn tin bằng
    CHÍNH luật `legal_doc` của `pipelines.intel_alert.match` (nguồn ∈
    legal_sources ∧ chủ đề tpbvsk|quang_cao hoặc cờ rượu). Cảnh báo đỏ của
    PC-A8 giữ nguyên; module này thêm bước NGƯỜI KIỂM.
  - Mỗi tin khớp, thu trong `LOOKBACK_DAYS` ngày, CHƯA từng vào hàng (mọi
    trạng thái, khóa `legal_doc_review` + `intel:<id>`) → 1 mục khối
    `legal_hr` qua `director.submit` (SLA/risk theo
    `data/directors/legal_hr.json` = lịch kiểm; tính năng `tat` → không sinh).
    Trần `--limit` mỗi lần (tin cũ trước); dư → lần chạy sau.
  - Payload TEMPLATE tất định: nguồn, link, ngày đăng/thu, sha256 tiêu đề,
    việc Pháp chế cần làm. Tiêu đề văn bản nằm ở `title` của mục (đã che
    PII) — tiêu đề chính thức có thể chứa chữ guardrail chặn ("thuốc"...)
    làm mục không duyệt được nếu đặt trong payload. KHÔNG diễn giải, KHÔNG tự
    đổi guardrail/từ cấm/claim — đổi luật là việc Pháp chế qua quy trình riêng.
  - Không mạng, không LLM, không gửi ai.

Chạy:
  python -m pipelines.legal_updates --submit [--limit N] [--dry-run]
Exit: 0 ok · 1 luật hỏng / DB lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import sys
from datetime import datetime, timedelta, timezone

import psycopg

from ingest.lead_store import connect
from pipelines import director
from pipelines import intel_alert as ia
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

BLOCK = "legal_hr"
OBJECT_TYPE = "legal_doc_review"
CREATED_BY = "agent:legal_updates"
LOOKBACK_DAYS = 30
LIMIT = 20
TITLE_MAX = 150

_SQL = ("select i.id, i.title, i.snippet, i.topics, i.flags, i.url, i.source,"
        " i.published_at, i.fetched_at from intel_items i"
        " where i.source = any(%s) and i.fetched_at >= %s"
        " and not exists (select 1 from approval_queue q where"
        " q.object_type = %s and q.object_id = 'intel:' || i.id::text)"
        " order by i.fetched_at, i.id")


def _day(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%Y-%m-%d") if ts else "chưa rõ"


def payload(item: dict) -> str:
    """Template tất định — không diễn giải văn bản."""
    t_sha = hashlib.sha256((item["title"] or "").encode("utf-8")).hexdigest()
    return (
        "# Văn bản pháp luật mới — chờ Pháp chế kiểm\n\n"
        f"intel_item: {item['id']}\n"
        f"Nguồn: {item['source']} (tầng A, nguồn chính thức)\n"
        f"Link: {item['url']}\n"
        f"Ngày đăng: {_day(item.get('published_at'))} · "
        f"ngày thu: {_day(item.get('fetched_at'))}\n"
        f"sha256 tiêu đề: {t_sha}\n\n"
        "Pháp chế đọc bản gốc tại link và ghi kết luận khi duyệt: (a) không "
        "ảnh hưởng; (b) cần cập nhật luật kiểm duyệt/claim/hồ sơ — thay đổi "
        "đó làm qua quy trình riêng có người duyệt.\n"
        "Agent KHÔNG diễn giải văn bản, KHÔNG tự đổi luật kiểm duyệt.\n")


def candidates(conn, now: datetime, rules: dict | None = None) -> list[dict]:
    rules = rules if rules is not None else ia.load_rules()
    rows = conn.execute(_SQL, (sorted(rules["legal_sources"]),
                               now - timedelta(days=LOOKBACK_DAYS),
                               OBJECT_TYPE)).fetchall()
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    out = []
    for iid, title, snip, topics, flags, url, src, pub, fetched in rows:
        item = {"id": iid, "title": title, "snippet": snip, "topics": topics,
                "flags": flags, "url": url, "source": src,
                "published_at": pub, "fetched_at": fetched}
        if "legal_doc" in ia.match(item, rules):
            out.append(item)
    return out


def submit(conn, now: datetime, rules: dict | None = None,
           limit: int = LIMIT, dry_run: bool = False) -> dict:
    """→ {"found", "queued": [qid], "left"}."""
    items = candidates(conn, now, rules)
    st = {"found": len(items), "queued": [], "left": max(0,
                                                         len(items) - limit)}
    if dry_run:
        return st
    cfg = director.load_config(BLOCK)
    for it in items[:limit]:
        title = "Văn bản mới: " + _oneline(_mask_pii(it["title"] or ""),
                                          TITLE_MAX)
        st["queued"].append(director.submit(
            conn, BLOCK, OBJECT_TYPE, f"intel:{it['id']}", title,
            payload(it), CREATED_BY, cfg=cfg))
    return st


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.legal_updates",
                                 description=__doc__.split("\n")[0])
    ap.add_argument("--submit", action="store_true", required=True)
    ap.add_argument("--limit", type=int, default=LIMIT)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if not 1 <= a.limit <= 200:
        ap.error("--limit 1..200")
    try:
        rules = ia.load_rules()
    except ia.IntelAlertConfigError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[err] DB không kết nối được", file=sys.stderr)
        return 2
    try:
        st = submit(conn, datetime.now(timezone.utc), rules, a.limit,
                    a.dry_run)
    except (ValueError, director.DirectorConfigError) as e:  # cấu hình/tắt
        print(f"[err] {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[err] DB: {_oneline(_db_msg(e), 200)}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    tag = " (dry-run)" if a.dry_run else ""
    print(f"[ok]{tag} văn bản khớp chưa vào hàng: {st['found']} · đã đẩy: "
          f"{len(st['queued'])} {st['queued']} · còn lại lần sau: "
          f"{st['left']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
