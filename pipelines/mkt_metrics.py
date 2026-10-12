"""v6.5 MKT-09 — số đo marketing THUẦN + query cho mục 5 báo cáo định kỳ
(`agents/report.py`) và cockpit (`pipelines/cockpit.collect_internal`).

Contract (định nghĩa đo chốt TRƯỚC khi code — DONE.md v6.5):
  - Tỷ lệ trả lại = rejected / (approved + rejected) trên nháp CÓ QUYẾT ĐỊNH
    trong kỳ: `content_drafts` theo `reviewed_at`, `approval_queue` khối
    `marketing` theo `decided_at`. `pending` KHÔNG vào mẫu số (in riêng
    `pending_end` = còn chờ ở cuối kỳ); `expired` của hàng chờ đếm riêng,
    không phải "trả lại". Mẫu số 0 → `rate` None (báo cáo in "—", không 0%).
  - Thời gian duyệt = giờ `created_at → reviewed_at|decided_at`; trung vị
    `statistics.median`, p90 nearest-rank `sorted(h)[ceil(0.9*n)-1]`, làm
    tròn 1 chữ số; n=0 → None (thiếu số ≠ 0 giờ). Mốc thiếu / âm (quyết
    định trước lúc tạo) → loại khỏi mẫu + đếm `bad_ts`.
  - Kỳ [since, until) aware (giờ VN do caller — `pipelines.period`); naive →
    ValueError TRƯỚC mọi execute. Hiệu quả kênh = tuần ISO ĐÃ ĐÓNG gần nhất
    trước `until` (cùng công thức `cockpit.last_closed_ref("week",
    now=until)` — không import cockpit để tránh vòng import với
    agents.report).
  - Mọi số do CODE tính từ DB — 0 LLM. `psycopg.Error` raise lên caller
    (báo cáo quyết degrade mục 5, cockpit ghi `errors`).
  - Không trích text nội dung/vi phạm: chỉ đếm CODE guardrail.
"""

import math
import statistics
from datetime import datetime, timedelta
from decimal import Decimal

from pipelines.period import period_bounds

MARKETING_BLOCK = "marketing"
UNKNOWN_AGENT = "(không rõ)"
CHANNEL_METRICS = ("social.reach", "social.engagement",
                   "sales.orders_completed")
_INTERNAL_CHANNEL = "noi_bo"


def _aware(dt, name: str) -> datetime:
    if not isinstance(dt, datetime) or dt.tzinfo is None \
            or dt.utcoffset() is None:
        raise ValueError(f"{name} phải là datetime có múi giờ (aware)")
    return dt


def review_summary(hours) -> dict:
    """THUẦN → {"n", "median_h", "p90_h", "max_h"}; n=0 → 3 giá trị None."""
    hs = sorted(float(h) for h in hours)
    n = len(hs)
    if not n:
        return {"n": 0, "median_h": None, "p90_h": None, "max_h": None}
    return {"n": n, "median_h": round(statistics.median(hs), 1),
            "p90_h": round(hs[math.ceil(0.9 * n) - 1], 1),
            "max_h": round(hs[-1], 1)}


def rate(rejected: int, decided: int):
    """% trả lại 1 chữ số; mẫu số 0 → None (in "—")."""
    return round(100 * rejected / decided, 1) if decided else None


def _hours(created, decided):
    """Giờ created→decided; thiếu mốc / âm → None (bad_ts)."""
    if created is None or decided is None or decided < created:
        return None
    return (decided - created).total_seconds() / 3600


def _bucket() -> dict:
    return {"decided": 0, "approved": 0, "rejected": 0, "pending_end": 0,
            "rate": None}


def _tally(rows, key_of) -> tuple[dict, dict, list, int, int]:
    """rows (status, created, decided, *key) → (by_key, total, hours,
    bad_ts, expired)."""
    by, total = {}, _bucket()
    hours, bad, expired = [], 0, 0
    for status, created, decided, *rest in rows:
        if status == "expired":
            expired += 1
            continue
        if status not in ("approved", "rejected"):
            continue
        b = by.setdefault(key_of(rest), _bucket())
        for x in (b, total):
            x["decided"] += 1
            x[status] += 1
        h = _hours(created, decided)
        if h is None:
            bad += 1
        else:
            hours.append(h)
    return by, total, hours, bad, expired


def _finish(by: dict, total: dict) -> None:
    for b in (*by.values(), total):
        b["rate"] = rate(b["rejected"], b["decided"])


def draft_decisions(conn, since: datetime, until: datetime) -> dict:
    """Nháp `content_drafts` có quyết định trong [since, until) — dùng chung
    cho báo cáo (mục 5) và cockpit (content.drafts_rejected/review_hours_*).
    → {"by": {(channel, content_type): bucket}, "total": bucket,
       "hours": review_summary + bad_ts}."""
    _aware(since, "since")
    _aware(until, "until")
    rows = conn.execute(
        "select status, created_at, reviewed_at, channel, content_type"
        " from content_drafts where status in ('approved', 'rejected')"
        " and reviewed_at >= %s and reviewed_at < %s",
        (since, until)).fetchall()
    by, total, hours, bad, _ = _tally(
        rows, lambda r: (r[0] or "?", r[1] or "?"))
    for ch, ct, n in conn.execute(
            "select channel, content_type, count(*) from content_drafts"
            " where created_at < %s and (status = 'pending' or reviewed_at"
            " >= %s) group by 1, 2", (until, until)).fetchall():
        b = by.setdefault((ch or "?", ct or "?"), _bucket())
        b["pending_end"] += n
        total["pending_end"] += n
    _finish(by, total)
    return {"by": by, "total": total,
            "hours": {**review_summary(hours), "bad_ts": bad}}


def queue_decisions(conn, since: datetime, until: datetime,
                    block: str = MARKETING_BLOCK) -> dict:
    """Hàng chờ `approval_queue` của khối theo `object_type` (decided_at ∈
    kỳ); `expired` đếm riêng, không vào tỷ lệ trả lại."""
    _aware(since, "since")
    _aware(until, "until")
    rows = conn.execute(
        "select status, created_at, decided_at, object_type"
        " from approval_queue where block = %s and decided_at >= %s"
        " and decided_at < %s", (block, since, until)).fetchall()
    by, total, hours, bad, expired = _tally(rows, lambda r: r[0] or "?")
    for ot, n in conn.execute(
            "select object_type, count(*) from approval_queue where block ="
            " %s and created_at < %s and (status = 'pending' or decided_at"
            " >= %s) group by 1", (block, until, until)).fetchall():
        by.setdefault(ot or "?", _bucket())["pending_end"] += n
        total["pending_end"] += n
    _finish(by, total)
    return {"by": by, "total": total, "expired": expired,
            "hours": {**review_summary(hours), "bad_ts": bad}}


def _codes(snapshot, out: dict) -> None:
    """Đếm violations[].code (thiếu → type → '?'); snapshot hỏng →
    `snapshot_hong`."""
    viols = snapshot.get("violations") if isinstance(snapshot, dict) else None
    if not isinstance(viols, list):
        out["snapshot_hong"] = out.get("snapshot_hong", 0) + 1
        return
    for v in viols:
        c = None
        if isinstance(v, dict):
            c = v.get("code") or v.get("type")
        c = c if isinstance(c, str) and c.strip() else "?"
        out[c] = out.get(c, 0) + 1


def _created(conn, since, until, block) -> tuple[dict, dict]:
    """Nháp TẠO trong kỳ (content_drafts + hàng chờ khối) → (by_agent,
    guardrail_codes)."""
    by_agent, codes = {}, {}
    rows = conn.execute(
        "select created_by, guardrail from content_drafts"
        " where created_at >= %s and created_at < %s",
        (since, until)).fetchall()
    rows += conn.execute(
        "select created_by, guardrail from approval_queue where block = %s"
        " and created_at >= %s and created_at < %s",
        (block, since, until)).fetchall()
    for by, snap in rows:
        who = by.strip() if isinstance(by, str) and by.strip() \
            else UNKNOWN_AGENT
        by_agent[who] = by_agent.get(who, 0) + 1
        _codes(snap, codes)
    return by_agent, codes


def closed_week(until: datetime) -> tuple[datetime, str]:
    """Đầu tuần ISO ĐÃ ĐÓNG gần nhất trước `until` + nhãn `YYYY-Www`
    (= cockpit.last_closed_ref("week", now=until))."""
    start = period_bounds("week", until)[0] - timedelta(days=7)
    y, w, _ = start.date().isocalendar()
    return start, f"{y}-W{w:02d}"


def _num(v):
    """Decimal nguyên → int (in không đuôi .0)."""
    if v is None:
        return None
    d = Decimal(str(v))
    return int(d) if d == d.to_integral_value() else float(d)


def channel_week(conn, until: datetime) -> dict:
    """Số kênh ngoài (manual_export) tuần đã đóng → {"week", "rows": [...]}.
    Cờ `sample` khi BẤT KỲ dòng nào của kênh nguồn `sample:`."""
    start, label = closed_week(until)
    per: dict[str, dict] = {}
    for ch, mid, val, ref in conn.execute(
            "select channel, metric_id, value, source_ref from"
            " channel_snapshots where period_kind = 'week' and period_start"
            " = %s and channel <> %s and metric_id = any(%s)"
            " order by channel, metric_id",
            (start.date(), _INTERNAL_CHANNEL, list(CHANNEL_METRICS))
    ).fetchall():
        d = per.setdefault(ch, {"channel": ch, "reach": None,
                                "engagement": None, "orders": None,
                                "eng_rate": None, "sample": False})
        key = {"social.reach": "reach", "social.engagement": "engagement",
               "sales.orders_completed": "orders"}[mid]
        d[key] = _num(val)
        if isinstance(ref, str) and ref.startswith("sample:"):
            d["sample"] = True
    for d in per.values():
        if d["reach"] and d["engagement"] is not None:
            d["eng_rate"] = round(100 * d["engagement"] / d["reach"], 1)
    return {"week": label, "rows": [per[k] for k in sorted(per)]}


def collect(conn, since: datetime, until: datetime) -> dict:
    """Toàn bộ số mục 5 báo cáo. Naive → ValueError (0 execute);
    psycopg.Error raise lên caller."""
    _aware(since, "since")
    _aware(until, "until")
    drafts = draft_decisions(conn, since, until)
    queue = queue_decisions(conn, since, until)
    by_agent, codes = _created(conn, since, until, MARKETING_BLOCK)
    return {"ok": True,
            "drafts": drafts["by"], "drafts_total": drafts["total"],
            "drafts_hours": drafts["hours"],
            "queue": queue["by"], "queue_total": queue["total"],
            "queue_hours": queue["hours"], "queue_expired": queue["expired"],
            "by_agent": by_agent, "guardrail_codes": codes,
            "channels": channel_week(conn, until)}
