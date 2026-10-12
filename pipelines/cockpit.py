"""v8.0 W80.1–W80.4 — thu số liệu điều hành cho cockpit TGĐ (WP10) vào bảng
`channel_snapshots` (có từ v4.0).

Contract:
  - Từ điển chỉ số `data/metrics.json` (`load_metrics` — lỗi cấu trúc →
    `MetricsError`; `metric_spec` tra đúng id hoặc `ai.cost_usd.<agent>`).
  - `collect_internal(conn, kind, ref)`: CHỈ kỳ ĐÃ ĐÓNG (`end <= now` giờ VN,
    kỳ qua `pipelines.period.period_bounds`) — kỳ đang chạy → `ValueError`.
    Mỗi metric 1 query trong savepoint; lỗi DB (thiếu bảng) → metric vào
    `errors`, KHÔNG thành 0. Số nội bộ ghi `channel='noi_bo'`,
    `source='api'` (CHECK v4.0 chỉ cho manual_export|api), nguồn thật ở
    `source_ref` (`db:<bảng>` / `file:conversations.jsonl`). Mốc thời gian
    truyền aware +07:00 làm tham số (không cắt kỳ bằng UTC trong SQL).
  - Số chatbot (convlog) chỉ chụp khi đầu kỳ còn trong hạn lưu convlog
    (`connectors.zalo.RETAIN_DAYS` = 30 ngày, purge hằng ngày): kỳ vượt hạn
    → metric vào `errors` (số đếm thiếu ≠ số thật, sổ insert-only sẽ đóng
    băng số sai).
  - `store`: INSERT thường (không ON CONFLICT/RETURNING — 2 thứ đó đòi quyền
    SELECT mà `agent_writer` không có), savepoint từng dòng, trùng khóa
    (`UniqueViolation`) → số đã chụp KHÔNG bị ghi đè (sửa số âm thầm = rủi ro
    "lọc dữ liệu"). Role có SELECT → so giá trị: bằng → unchanged, khác →
    conflict (giữ bản cũ); role không SELECT (agent_writer) → `unverified`.
    `atomic=True` (CSV): có conflict hoặc có dòng `unverified` (kể cả file
    y nguyên — không phân biệt được với file đã sửa số) → rollback CẢ lô,
    exit 1 (fail-closed).
  - `read_csv`: kiểm TOÀN file trước khi connect; lỗi in `dòng N, cột X:
    <lý do>` — KHÔNG in giá trị ô (precedent ingest/market_csv.py).
  - `approval_times` / `summarize_hours`: thời gian duyệt của TGĐ (hàng
    `approval_queue` khối ceo, created_at → decided_at); không có quyết định
    → median/max None (KHÔNG 0).

Chạy:
  python -m pipelines.cockpit --metrics
  python -m pipelines.cockpit --collect [--period week|month] [--ref YYYY-MM-DD] [--dry-run]
  python -m pipelines.cockpit --import FILE --by "<người xuất>" [--sample]
Exit: 0 ok · 1 file CSV lỗi / khác giá trị đã nạp / từ điển lỗi ·
2 tham số sai / kỳ chưa đóng / DB down.
"""

import argparse
import csv
import hashlib
import io
import json
import re
import statistics
import sys
import unicodedata
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

import psycopg

from agents.report import collect_chat
from connectors.zalo import RETAIN_DAYS as CONVLOG_RETAIN_DAYS
from ingest.lead_store import CONV_FILES, connect
from pipelines.director import DirectorConfigError
from pipelines.director import load_config as load_director
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
METRICS_PATH = DATA_DIR / "metrics.json"
INTERNAL_CHANNEL = "noi_bo"
CAPTURED_BY = "agent:cockpit"
METRIC_RE = re.compile(r"[a-z][a-z0-9_.]{1,63}")
CHANNEL_RE = re.compile(r"[a-z][a-z0-9_]{1,31}")
UNITS = ("lead", "câu", "bản", "cảnh báo", "USD", "job", "mục", "giờ",
         "VND", "đơn", "người", "lượt")
BETTER = ("up", "down", "none")
SNAP_KINDS = ("day", "week", "month")
SOURCES = ("manual_export", "api")
CSV_HEADER = ["channel", "metric_id", "period_kind", "period_start", "value"]
CSV_MAX_BYTES = 2 * 1024 * 1024
# [0-9] tường minh: `\d` khớp cả chữ số Unicode (full-width U+FF11..) mà
# Decimal() vẫn nhận → số mơ hồ lọt vào sổ (A03 validate đầu vào).
_INT_RE = re.compile(r"[0-9]{1,15}")
_DEC_RE = re.compile(r"[0-9]{1,15}(\.[0-9]{1,6})?")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_AGENT_KEY = "ai.cost_usd"
CEO_METRICS = ("approvals.ceo_decided", "approvals.ceo_hours_median",
               "approvals.ceo_hours_max", "approvals.ceo_expired")


class MetricsError(Exception):
    """data/metrics.json thiếu/hỏng/sai luật."""


# ---------------------------------------------------------------- W80.1

def _validate_metrics(cfg) -> dict:
    if not isinstance(cfg, dict) or not isinstance(cfg.get("metrics"), dict) \
            or not cfg["metrics"]:
        raise MetricsError("thiếu object 'metrics'")
    for mid, s in cfg["metrics"].items():
        if not isinstance(mid, str) or not METRIC_RE.fullmatch(mid):
            raise MetricsError(f"metric_id '{mid}' không khớp "
                               "^[a-z][a-z0-9_.]{1,63}$")
        if not isinstance(s, dict):
            raise MetricsError(f"{mid}: không phải object")
        if not isinstance(s.get("name"), str) or not s["name"].strip():
            raise MetricsError(f"{mid}: thiếu name")
        if s.get("unit") not in UNITS:
            raise MetricsError(f"{mid}: unit thiếu/lạ — dùng {UNITS}")
        if s.get("better") not in BETTER:
            raise MetricsError(f"{mid}: better phải {BETTER}")
        if s.get("kind") not in ("internal", "external"):
            raise MetricsError(f"{mid}: kind phải internal|external")
        if not isinstance(s.get("integer"), bool):
            raise MetricsError(f"{mid}: integer phải true|false")
        ch = s.get("channels")
        if not isinstance(ch, list) or not ch or not all(
                isinstance(c, str) and CHANNEL_RE.fullmatch(c) for c in ch):
            raise MetricsError(f"{mid}: channels thiếu/sai định dạng")
        if s["kind"] == "internal":
            if ch != [INTERNAL_CHANNEL]:
                raise MetricsError(f"{mid}: internal chỉ có channels "
                                   f"['{INTERNAL_CHANNEL}']")
            src = s.get("source")
            if not isinstance(src, str) or not (
                    src.startswith(("db:", "file:"))):
                raise MetricsError(f"{mid}: source internal phải db:|file:")
        else:
            if INTERNAL_CHANNEL in ch:
                raise MetricsError(f"{mid}: external không dùng kênh "
                                   f"'{INTERNAL_CHANNEL}'")
            if s.get("source") != "manual_export":
                raise MetricsError(f"{mid}: source external phải "
                                   "manual_export")
        if "per_agent" in s and not isinstance(s["per_agent"], bool):
            raise MetricsError(f"{mid}: per_agent phải true|false")
    return cfg["metrics"]


def load_metrics(path=None) -> dict:
    """→ {metric_id: spec}. Lỗi → MetricsError (không trả dict rỗng)."""
    p = Path(path) if path is not None else METRICS_PATH
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError as e:
        raise MetricsError(f"không có file {p.name}") from e
    except (OSError, ValueError) as e:
        raise MetricsError(f"{p.name} hỏng: {type(e).__name__}") from e
    return _validate_metrics(cfg)


def metric_spec(metrics: dict, metric_id) -> dict | None:
    """Spec của metric_id; `ai.cost_usd.<agent>` → spec `ai.cost_usd`
    (chỉ khi `per_agent`). Không khớp → None."""
    if not isinstance(metric_id, str) or not METRIC_RE.fullmatch(metric_id):
        return None
    if metric_id in metrics:
        return metrics[metric_id]
    head, _, tail = metric_id.rpartition(".")
    s = metrics.get(head)
    if s and s.get("per_agent") and re.fullmatch(r"[a-z0-9_]+", tail):
        return s
    return None


def agent_metric_id(agent_id) -> str:
    """llm_usage.agent_id → `ai.cost_usd.<agent>` ([^a-z0-9_] → _)."""
    a = re.sub(r"[^a-z0-9_]", "_", str(agent_id or "").lower())[:51] or "_"
    return f"{_AGENT_KEY}.{a}"


# ---------------------------------------------------------------- W80.4

def summarize_hours(hours) -> dict:
    """THUẦN: n=0 → median/max None (thiếu số ≠ 0 giờ)."""
    hs = [float(h) for h in hours]
    if not hs:
        return {"n": 0, "median_h": None, "max_h": None}
    return {"n": len(hs), "median_h": round(statistics.median(hs), 1),
            "max_h": round(max(hs), 1)}


def approval_times(conn, start, end, block: str = "ceo") -> dict:
    """Quyết định của khối trong [start, end): approved/rejected → giờ
    created→decided; expired đếm riêng."""
    hours, expired = [], 0
    for status, created, decided in conn.execute(
            "select status, created_at, decided_at from approval_queue"
            " where block = %s and decided_at >= %s and decided_at < %s",
            (block, start, end)).fetchall():
        if status == "expired":
            expired += 1
        elif status in ("approved", "rejected"):
            hours.append((decided - created).total_seconds() / 3600)
    return {**summarize_hours(hours), "expired": expired}


# ---------------------------------------------------------------- W80.2

def _closed(kind: str, ref, now) -> tuple[datetime, datetime]:
    start, end = period_bounds(kind, ref)
    now = now or datetime.now(VN_TZ)
    if end > now:
        raise ValueError(f"kỳ chưa đóng ({start.date()} → hết "
                         f"{(end - timedelta(days=1)).date()} giờ VN)")
    return start, end


def last_closed_ref(kind: str, now=None) -> date:
    """Ngày tham chiếu của kỳ VỪA ĐÓNG tính theo giờ VN."""
    start, _ = period_bounds(kind, now or datetime.now(VN_TZ))
    return (start - timedelta(days=1)).date()


_COUNT_SQL = {
    "leads.new": ("db:leads", (
        "select count(*) from leads where ts >= %(s)s and ts < %(e)s")),
    "content.drafts_created": ("db:content_drafts", (
        "select count(*) from content_drafts where created_at >= %(s)s"
        " and created_at < %(e)s")),
    "content.drafts_approved": ("db:approvals", (
        "select count(distinct object_id) from approvals where object_type"
        " = 'content_draft' and decision = 'approved' and approved_at >="
        " %(s)s and approved_at < %(e)s")),
    "content.drafts_pending_end": ("db:content_drafts", (
        "select count(*) from content_drafts d where d.created_at < %(e)s"
        " and not exists (select 1 from approvals a where a.object_type ="
        " 'content_draft' and a.object_id = d.id::text and a.approved_at"
        " < %(e)s)")),
    "market.alerts_open_end": ("db:market_alerts", (
        "select count(*) from market_alerts where opened_at < %(e)s and"
        " (closed_at is null or closed_at >= %(e)s)")),
    "jobs.failed": ("db:job_runs", (
        "select count(*) from job_runs where ok is not true"
        " and started_at >= %(s)s and started_at < %(e)s")),
    "approvals.overdue": ("db:approval_queue", (
        "select count(*) from approval_queue where due_at >= %(s)s and"
        " due_at < %(e)s and status in ('expired', 'pending') and due_at"
        " <= now()")),
}


def _row(mid, kind, start, value, source_ref) -> dict:
    return {"channel": INTERNAL_CHANNEL, "metric_id": mid,
            "period_kind": kind, "period_start": start.date(),
            "value": Decimal(value), "source": "api",
            "source_ref": source_ref}


def _savepoint(conn, fn):
    """Chạy fn trong savepoint — lỗi DB rollback đúng phần đó, raise."""
    with conn.transaction():
        return fn()


def collect_internal(conn, kind: str, ref, *, data_dir: Path = DATA_DIR,
                     now=None) -> tuple[list[dict], list[str]]:
    """→ (rows, errors). Kỳ chưa đóng → ValueError (0 execute)."""
    now = now or datetime.now(VN_TZ)
    start, end = _closed(kind, ref, now)
    p = {"s": start, "e": end}
    rows, errors = [], []
    for mid, (src, sql) in _COUNT_SQL.items():
        try:
            n = _savepoint(conn, lambda q=sql: conn.execute(q, p).fetchone()[0])
        except psycopg.Error as e:
            errors.append(f"{mid}: {_db_msg(e)[:200]}")
            continue
        rows.append(_row(mid, kind, start, n, src))

    try:
        usage = _savepoint(conn, lambda: conn.execute(
            "select agent_id, coalesce(sum(cost_usd), 0) from llm_usage"
            " where ts >= %(s)s and ts < %(e)s group by agent_id", p
        ).fetchall())
    except psycopg.Error as e:
        errors.append(f"{_AGENT_KEY}: {_db_msg(e)[:200]}")
    else:
        per: dict[str, Decimal] = {}
        for agent, cost in usage:
            k = agent_metric_id(agent)
            per[k] = per.get(k, Decimal(0)) + Decimal(cost)
        rows.append(_row(_AGENT_KEY, kind, start,
                         sum(per.values(), Decimal(0)), "db:llm_usage"))
        rows += [_row(k, kind, start, v, "db:llm_usage")
                 for k, v in sorted(per.items())]

    try:
        block = load_director("ceo")["block"]
        t = _savepoint(conn, lambda: approval_times(conn, start, end, block))
    except (psycopg.Error, DirectorConfigError) as e:
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        errors += [f"{m}: {msg[:200]}" for m in CEO_METRICS]
    else:
        src = "db:approval_queue"
        rows.append(_row("approvals.ceo_decided", kind, start, t["n"], src))
        if t["median_h"] is not None:   # thiếu số ≠ 0 giờ
            rows.append(_row("approvals.ceo_hours_median", kind, start,
                             str(t["median_h"]), src))
            rows.append(_row("approvals.ceo_hours_max", kind, start,
                             str(t["max_h"]), src))
        rows.append(_row("approvals.ceo_expired", kind, start, t["expired"],
                         src))

    chat_ids = ("chatbot.questions", "chatbot.unanswered")
    if start < now - timedelta(days=CONVLOG_RETAIN_DAYS):
        # Convlog đã purge phần đầu kỳ → đếm ra số THIẾU; insert-only sẽ
        # đóng băng số sai thành "số thật" → không ghi (báo cáo hiện thiếu).
        errors += [f"{m}: convlog chỉ giữ {CONVLOG_RETAIN_DAYS} ngày — kỳ "
                   "vượt hạn lưu" for m in chat_ids]
    elif not any((data_dir / n).exists() for n in CONV_FILES):
        errors += [f"{m}: không có file {CONV_FILES[0]}" for m in chat_ids]
    else:
        chat = collect_chat(data_dir, start, end)
        src = "file:conversations.jsonl"
        rows.append(_row("chatbot.questions", kind, start,
                         chat["in_period"], src))
        rows.append(_row("chatbot.unanswered", kind, start,
                         chat["in_period"] - chat["answered_period"], src))
    return rows, errors


def _check_row(metrics: dict, r: dict) -> None:
    s = metric_spec(metrics, r.get("metric_id"))
    if s is None:
        raise ValueError(f"metric lạ: {r.get('metric_id')!r}")
    if r.get("channel") not in s["channels"]:
        raise ValueError(f"{r['metric_id']}: kênh không cho phép")
    if r.get("period_kind") not in SNAP_KINDS:
        raise ValueError(f"{r['metric_id']}: period_kind lạ")
    if not isinstance(r.get("period_start"), date) or isinstance(
            r["period_start"], datetime):
        raise TypeError(f"{r['metric_id']}: period_start phải là date")
    if r.get("source") not in SOURCES:
        raise ValueError(f"{r['metric_id']}: source lạ")
    v = r.get("value")
    if not isinstance(v, Decimal) or not v.is_finite() or v < 0:
        raise ValueError(f"{r['metric_id']}: value phải Decimal hữu hạn ≥ 0")


class _Conflict(Exception):
    pass


def store(conn, rows: list[dict], captured_by: str, *, metrics=None,
          atomic: bool = False) -> dict:
    """Ghi insert-only → {inserted, unchanged, conflict, unverified,
    rolled_back}. Row sai → ValueError TRƯỚC mọi execute. Chạy được dưới
    `agent_writer` (chỉ INSERT 8 cột): không ON CONFLICT/RETURNING."""
    by = (captured_by or "").strip()
    if not by:
        raise ValueError("store: thiếu captured_by")
    metrics = metrics if metrics is not None else load_metrics()
    for r in rows:
        _check_row(metrics, r)
    st = {"inserted": 0, "unchanged": 0, "conflict": 0, "unverified": 0,
          "rolled_back": False}
    try:
        with conn.transaction():
            for r in rows:
                key = (r["channel"], r["metric_id"], r["period_kind"],
                       r["period_start"], r["source"])
                try:
                    with conn.transaction():
                        conn.execute(
                            "insert into channel_snapshots (channel,"
                            " metric_id, period_kind, period_start, value,"
                            " source, source_ref, captured_by) values (%s,"
                            " %s, %s, %s, %s, %s, %s, %s)",
                            (*key[:4], r["value"], r["source"],
                             r.get("source_ref"), by))
                except psycopg.errors.UniqueViolation:
                    pass
                else:
                    st["inserted"] += 1
                    continue
                try:
                    with conn.transaction():
                        old = conn.execute(
                            "select value from channel_snapshots where"
                            " channel = %s and metric_id = %s and"
                            " period_kind = %s and period_start = %s and"
                            " source = %s", key).fetchone()
                except psycopg.errors.InsufficientPrivilege:
                    st["unverified"] += 1     # đã có, role không đọc được
                    continue
                if old is not None and Decimal(old[0]) == r["value"]:
                    st["unchanged"] += 1
                else:
                    st["conflict"] += 1
            # CSV fail-closed: dòng đã có mà không đọc được để so (agent_
            # writer) KHÔNG phân biệt được file y nguyên với file đã sửa số
            # → không được báo [done] (số mới bị bỏ câm, báo cáo giữ số cũ).
            if atomic and (st["conflict"] or st["unverified"]):
                raise _Conflict
    except _Conflict:
        st["inserted"] = 0
        st["rolled_back"] = True
    conn.commit()   # conn chia sẻ: transaction() có thể chỉ là savepoint
    return st


# ---------------------------------------------------------------- W80.3

def read_csv(path, metrics: dict, *, now=None) -> tuple[list[dict], list[str]]:
    """THUẦN, toàn file → (rows, errors). Lỗi KHÔNG chứa giá trị ô."""
    p = Path(path)
    now = now or datetime.now(VN_TZ)
    try:
        size = p.stat().st_size
        if size > CSV_MAX_BYTES:
            return [], [f"dòng 1, cột (file): file > {CSV_MAX_BYTES} byte"]
        raw = p.read_bytes()
    except OSError as e:
        return [], [("dòng 1, cột (file): không đọc được file "
                     f"({type(e).__name__})")]
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        line = raw[:e.start].count(b"\n") + 1
        return [], [f"dòng {line}, cột (file): byte không phải UTF-8"]
    rd = csv.reader(io.StringIO(text, newline=""))
    errors: list[str] = []
    try:
        header = next(rd, None)
    except csv.Error:
        return [], ["dòng 1, cột (header): CSV hỏng"]
    if header is None:
        return [], ["dòng 1, cột (header): file rỗng"]
    hdr = [h.strip() for h in header]
    if hdr != CSV_HEADER:
        missing = [c for c in CSV_HEADER if c not in hdr]
        return [], ["dòng 1, cột (header): header phải đúng "
                    f"{','.join(CSV_HEADER)}"
                    + (f" — thiếu {', '.join(missing)}" if missing
                       else " — thừa cột hoặc sai thứ tự")]
    rows, seen = [], set()
    try:
        for cells in rd:
            n = rd.line_num
            if not cells or all(not c.strip() for c in cells):
                continue
            if len(cells) != len(CSV_HEADER):
                errors.append(f"dòng {n}, cột (dòng): cần "
                              f"{len(CSV_HEADER)} cột")
                continue
            r, errs = _csv_row(dict(zip(CSV_HEADER,
                                        (c.strip() for c in cells))),
                               metrics, now)
            errors += [f"dòng {n}, cột {col}: {why}" for col, why in errs]
            if errs:
                continue
            key = (r["channel"], r["metric_id"], r["period_kind"],
                   r["period_start"])
            if key in seen:
                errors.append(f"dòng {n}, cột (khóa): trùng khóa "
                              "channel+metric_id+kỳ với dòng trước")
                continue
            seen.add(key)
            rows.append(r)
    except csv.Error:
        errors.append(f"dòng {rd.line_num}, cột (dòng): CSV hỏng")
    if not rows and not errors:
        errors.append("dòng 2, cột (file): không có dòng dữ liệu")
    return (rows if not errors else []), errors


def _csv_row(c: dict, metrics: dict, now) -> tuple[dict, list]:
    errs = []
    spec = metric_spec(metrics, c["metric_id"])
    if spec is None:
        errs.append(("metric_id", "không có trong data/metrics.json"))
    elif spec["kind"] != "external":
        errs.append(("metric_id", "metric nội bộ — không nạp từ CSV"))
    elif c["channel"] not in spec["channels"]:
        errs.append(("channel", "kênh không cho phép với metric này"))
    if c["period_kind"] not in SNAP_KINDS:
        errs.append(("period_kind", f"phải {'|'.join(SNAP_KINDS)}"))
    d = None
    if not _DATE_RE.fullmatch(c["period_start"]):
        errs.append(("period_start", "phải YYYY-MM-DD"))
    else:
        try:
            d = date.fromisoformat(c["period_start"])
        except ValueError:
            errs.append(("period_start", "ngày không hợp lệ"))
    if d is not None and c["period_kind"] in SNAP_KINDS:
        start, end = period_bounds(c["period_kind"], d)
        if start.date() != d:
            errs.append(("period_start", ("không phải ngày đầu kỳ (tuần: "
                                          "thứ Hai; tháng: ngày 1)")))
        elif end > now:
            errs.append(("period_start", "kỳ chưa đóng"))
    v = None
    rx = _INT_RE if spec and spec["integer"] else _DEC_RE
    if not rx.fullmatch(c["value"]):
        errs.append(("value", "phải là số " + (
            "nguyên ≥ 0, không dấu nghìn" if rx is _INT_RE
            else "≥ 0, dấu chấm thập phân, không dấu nghìn")))
    else:
        try:
            v = Decimal(c["value"])
        except InvalidOperation:
            errs.append(("value", "không đọc được số"))
    if errs:
        return {}, errs
    return {"channel": c["channel"], "metric_id": c["metric_id"],
            "period_kind": c["period_kind"], "period_start": d,
            "value": v}, []


_SAMPLE_NAME_RE = re.compile(r"(^|[^a-z])(mau|sample)([^a-z]|$)")


def is_sample_name(path) -> bool:
    """Tên file có dấu hiệu MẪU (`mau`/`mẫu`/`sample`, tách khỏi chữ khác)."""
    name = unicodedata.normalize("NFD", Path(path).name.casefold())
    name = "".join(ch for ch in name if not unicodedata.combining(ch))
    return bool(_SAMPLE_NAME_RE.search(name.replace("đ", "d")))


def csv_source_ref(path, sample: bool) -> str:
    p = Path(path)
    sha = hashlib.sha256(p.read_bytes()).hexdigest()[:12]
    name = re.sub(r"[^\w.-]", "_", p.name)[:80]
    return ("sample:" if sample else "") + f"{name}#sha256:{sha}"


# ---------------------------------------------------------------- CLI

def _fmt(v: Decimal) -> str:
    return format(v.normalize(), "f") if v == v.to_integral() else str(v)


def _cli_metrics() -> int:
    try:
        m = load_metrics()
    except MetricsError as e:
        print(f"[error] data/metrics.json: {e}", file=sys.stderr)
        return 1
    n_int = sum(1 for s in m.values() if s["kind"] == "internal")
    print(f"[ok] {len(m)} metric — internal {n_int}, external "
          f"{len(m) - n_int}")
    for mid, s in m.items():
        print(f"  {mid:<30} {s['kind']:<8} {s['unit']:<9} better={s['better']}"
              f" · {s['name']}")
    return 0


def _cli_collect(args, now) -> int:
    try:
        ref = (date.fromisoformat(args.ref) if args.ref
               else last_closed_ref(args.period, now))
        start, _ = _closed(args.period, ref, now)
        metrics = load_metrics()
    except MetricsError as e:
        print(f"[error] data/metrics.json: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        rows, errors = collect_internal(conn, args.period, ref, now=now)
        print(f"[cockpit] kỳ {args.period} bắt đầu {start.date()} (giờ VN)"
              f" — {len(rows)} số, {len(errors)} lỗi nguồn")
        for r in rows:
            print(f"  {r['metric_id']:<34} {_fmt(r['value']):>14}  "
                  f"{r['source_ref']}")
        for e in errors:
            print(f"[warn] thiếu nguồn — {e}")
        if args.dry_run:
            conn.rollback()
            print("[dry-run] không ghi channel_snapshots")
            return 0
        st = store(conn, rows, CAPTURED_BY, metrics=metrics)
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)[:300]}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    print(f"[done] inserted={st['inserted']} unchanged={st['unchanged']}"
          f" conflict={st['conflict']}"
          + (f" unverified={st['unverified']}" if st["unverified"] else ""))
    if st["unverified"]:
        print(f"[warn] {st['unverified']} số đã có trong sổ — role DB hiện "
              "tại không có SELECT channel_snapshots nên không so được giá "
              "trị; GIỮ bản cũ")
    if st["conflict"]:
        print(f"[warn] {st['conflict']} số khác bản đã chụp — GIỮ bản cũ, "
              "không ghi đè; báo người quản trị DB kiểm tra")
    return 0


def _cli_import(args, now) -> int:
    # A08: nguồn gốc MẪU/thật không được chỉ dựa vào trí nhớ người chạy —
    # số MẪU vào sổ insert-only như số thật thì không gỡ được (và chặn vĩnh
    # viễn file thật cùng kỳ). Tên file và cờ --sample phải khớp nhau.
    if is_sample_name(args.import_file) and not args.sample:
        print("[error] tên file có dấu hiệu MẪU (mau/sample) nhưng thiếu "
              "--sample — không nạp số mẫu như số thật", file=sys.stderr)
        return 2
    if args.sample and not is_sample_name(args.import_file):
        print("[error] --sample chỉ dùng cho file tên có 'MAU'/'sample' — "
              "file thật KHÔNG nạp với --sample", file=sys.stderr)
        return 2
    try:
        metrics = load_metrics()
    except MetricsError as e:
        print(f"[error] data/metrics.json: {e}", file=sys.stderr)
        return 1
    rows, errors = read_csv(args.import_file, metrics, now=now)
    if errors:
        for e in errors[:50]:
            print(f"[error] {e}", file=sys.stderr)
        if len(errors) > 50:
            print(f"[error] ... và {len(errors) - 50} lỗi khác",
                  file=sys.stderr)
        print("[fail] file lỗi — 0 dòng được nạp, chưa kết nối DB",
              file=sys.stderr)
        return 1
    ref = csv_source_ref(args.import_file, args.sample)
    for r in rows:
        r.update(source="manual_export", source_ref=ref)
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        st = store(conn, rows, args.by.strip(), metrics=metrics, atomic=True)
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)[:300]}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    if st["rolled_back"]:
        if st["conflict"]:
            print(f"[fail] {st['conflict']} dòng khác giá trị đã nạp — 0 dòng "
                  "(không ghi đè số đã chụp; báo người quản trị DB)",
                  file=sys.stderr)
        else:
            print(f"[fail] {st['unverified']} dòng đã có trong sổ nhưng role "
                  "DB hiện tại không có SELECT channel_snapshots để so giá "
                  "trị (file y nguyên hay đã sửa số đều không phân biệt "
                  "được) — 0 dòng, số mới KHÔNG được nạp (fail-closed; chạy "
                  "lại bằng DSN có quyền SELECT sổ)", file=sys.stderr)
        return 1
    print(f"[done] {len(rows)} dòng — inserted={st['inserted']} "
          f"unchanged={st['unchanged']}"
          + (" (MẪU)" if args.sample else ""))
    return 0


def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.cockpit",
        description="Cockpit TGĐ — thu số liệu điều hành vào "
                    "channel_snapshots (insert-only)")
    ap.add_argument("--metrics", action="store_true",
                    help="kiểm + in từ điển chỉ số")
    ap.add_argument("--collect", action="store_true",
                    help="chụp số nội bộ của kỳ ĐÃ ĐÓNG")
    ap.add_argument("--import", dest="import_file", metavar="FILE",
                    help="nạp CSV manual_export số kênh ngoài")
    ap.add_argument("--period", choices=("week", "month"), default=None)
    ap.add_argument("--ref", default=None, help="YYYY-MM-DD (ngày VN)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--by", default=None, help="người xuất file (--import)")
    ap.add_argument("--sample", action="store_true",
                    help="file MẪU → source_ref 'sample:'")
    args = ap.parse_args(argv)
    n_ops = sum((args.metrics, args.collect, args.import_file is not None))
    if n_ops != 1:
        ap.error("chọn ĐÚNG 1 trong --metrics | --collect | --import")
    if not args.collect and (args.period or args.ref or args.dry_run):
        ap.error("--period/--ref/--dry-run chỉ dùng với --collect")
    if args.import_file is None and (args.by is not None or args.sample):
        ap.error("--by/--sample chỉ dùng với --import")
    if args.import_file is not None and not (args.by or "").strip():
        ap.error("--import cần --by \"<người xuất file>\"")
    if args.ref and not _DATE_RE.fullmatch(args.ref):
        ap.error("--ref phải YYYY-MM-DD")
    args.period = args.period or "week"
    if args.metrics:
        return _cli_metrics()
    if args.collect:
        return _cli_collect(args, now)
    return _cli_import(args, now)


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("pipelines.cockpit") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
