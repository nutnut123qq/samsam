"""WS2 — gom lead từ convlog (`data/conversations.jsonl`) vào bảng `leads`.

Contract:
  - Chỉ cần `DATABASE_URL` trong .env (không gọi OpenRouter). Bảng
    `leads` tạo bởi `docs/schema.sql` — chạy `python scripts/apply_schema.py`.
  - KHÁC `core_store`: convlog là LOG xoay (`.1`) + purge 30d, lead là
    fact suy ra một lần → insert-only `on conflict (dedup_key) do
    nothing`, KHÔNG delete-by-source. Entry convlog bị purge sau này
    không kéo theo lead (lead đã là dữ liệu vận hành riêng).
  - File convlog user-influenced → đọc BYTES + split `\\n` tường minh
    (AGENTS.md: splitlines cắt U+2028/\\x85 đôi record; decode
    `errors="replace"` không crash trên byte lỗi).
  - Edge (enumerate theo bài học v1.8): file thiếu / 0-record / chỉ
    `_doc` / dòng corrupt JSON / rec không phải dict / thiếu
    question-ts-user_hash / ts sai ISO / question không khớp intent →
    skip + đếm, exit 0 — KHÔNG xóa leads đang có.
  - `channel`: `msg_id` rỗng → 'streamlit' (writer streamlit ghi
    `msg_id:""`); còn lại → 'zalo'. Không dùng field `sent` vì entry
    convlog cũ (trước D4.4) không có key đó.
  - `dedup_key`: `convlog:<msg_id>` khi có msg_id (mock re-run cùng id
    tự gộp — convlog thật có mock0..2 lặp lại), else
    `convlog:<sha1[:16](ts|user_hash|question)>`.
  - `question`/`user_hash` đã mask/hash tại convlog — bảng không lưu
    PII thêm; intent là heuristic keyword (pilot, someday: refine khi
    có data thật).

Chạy: `python -m ingest.lead_store` → in mới/trùng + tổng leads.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONV_FILES = ("conversations.jsonl", "conversations.jsonl.1")
CONNECT_TIMEOUT_S = 3

LEAD_COLS = ("dedup_key", "ts", "channel", "user_hash", "question",
             "intent", "status", "source")

# Intent thương mại — thứ tự là priority (first-match thắng): "giá sỉ"
# → partner chứ không price; "mua ở đâu" → order chứ không contact.
INTENTS = (
    ("partner", ("đại lý", "cộng tác", "nhập hàng", "sỉ", "bán buôn",
                 "phân phối", "số lượng lớn")),
    ("order", ("mua", "đặt hàng", "đặt mua", "đơn hàng", "ship",
               "giao hàng", "giao tận", "thanh toán", "chuyển khoản")),
    ("price", ("giá", "bao nhiêu", "khuyến mãi", "giảm giá", "ưu đãi")),
    ("contact", ("showroom", "địa chỉ", "ở đâu", "văn phòng", "cửa hàng",
                 "liên hệ", "tư vấn", "hotline", "điện thoại", "sđt")),
)

INSERT_SQL = (
    f"insert into leads ({', '.join(LEAD_COLS)}) values ("
    + ", ".join(f"%({c})s" for c in LEAD_COLS)
    + ") on conflict (dedup_key) do nothing")


def intent_of(question: str):
    """Phân loại intent thương mại theo keyword (first-match theo thứ
    tự INTENTS); None = không phải lead (câu hỏi thông tin/y tế)."""
    q = question.lower()
    for intent, keys in INTENTS:
        if any(k in q for k in keys):
            return intent
    return None


def channel_of(rec: dict) -> str:
    """streamlit ghi msg_id:"" — msg_id rỗng/thiếu → 'streamlit'."""
    msg_id = rec.get("msg_id")
    return "zalo" if isinstance(msg_id, str) and msg_id.strip() else "streamlit"


def dedup_key(rec: dict) -> str:
    msg_id = rec.get("msg_id")
    if isinstance(msg_id, str) and msg_id.strip():
        return f"convlog:{msg_id.strip()}"
    parts = (rec.get("ts"), rec.get("user_hash"), rec.get("question"))
    raw = "|".join(part if isinstance(part, str) else "" for part in parts)
    return "convlog:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _parse_ts(raw: str):
    """ISO 'YYYY-MM-DDTHH:MM:SSZ' → aware dt | None khi sai format."""
    try:
        return datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def iter_convlog(path: Path, stats: dict):
    """Yield dict record từ convlog (BYTES + split `\\n`; decode
    replace). Skip + đếm: file không đọc được, dòng corrupt JSON, rec
    không phải dict, `_doc`. Không raise."""
    try:
        lines = path.read_bytes().split(b"\n")
    except OSError:
        stats["io_error"] = stats.get("io_error", 0) + 1
        return
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        try:
            rec = json.loads(line.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, RecursionError):
            stats["corrupt"] += 1
            continue
        if not isinstance(rec, dict):
            stats["corrupt"] += 1
            continue
        if "_doc" in rec:
            stats["doc"] += 1
            continue
        yield rec


def lead_row(rec: dict) -> tuple[dict | None, str | None]:
    """convlog record → (row leads, None) | (None, lý-do-skip).
    Lý do: 'fields' (thiếu/trống question·ts·user_hash), 'ts' (sai ISO),
    'intent' (không khớp intent thương mại — câu hỏi thông tin)."""
    question = rec.get("question")
    ts_value = rec.get("ts")
    user_hash = rec.get("user_hash")
    if (not isinstance(question, str) or not question.strip()
            or not isinstance(user_hash, str) or not user_hash.strip()
            or ts_value is None or ts_value == ""):
        return None, "fields"
    if not isinstance(ts_value, str):
        return None, "ts"
    q = question.strip()
    ts_raw = ts_value.strip()
    uh = user_hash.strip()
    if not ts_raw:
        return None, "fields"
    ts = _parse_ts(ts_raw)
    if ts is None:
        return None, "ts"
    intent = intent_of(q)
    if intent is None:
        return None, "intent"
    return {"dedup_key": dedup_key(rec), "ts": ts, "channel": channel_of(rec),
            "user_hash": uh, "question": q[:500], "intent": intent,
            "status": "new", "source": "conversations.jsonl"}, None


def harvest(data_dir: Path = DATA_DIR) -> tuple[list[dict], dict]:
    """Đọc convlog (+.1) → (rows đã dedup trong-file, stats). File
    thiếu/0-record → rows rỗng — KHÔNG raise, KHÔNG xóa leads đang có."""
    stats = {"corrupt": 0, "doc": 0, "io_error": 0, "fields": 0,
             "ts": 0, "intent": 0, "dup_in_file": 0, "missing": [],
             "records": 0}
    rows, seen = [], set()
    for name in CONV_FILES:
        path = data_dir / name
        if not path.exists():
            stats["missing"].append(name)
            continue
        for rec in iter_convlog(path, stats):
            stats["records"] += 1
            row, why = lead_row(rec)
            if row is None:
                stats[why or "fields"] += 1
                continue
            if row["dedup_key"] in seen:
                stats["dup_in_file"] += 1
                continue
            seen.add(row["dedup_key"])
            rows.append(row)
    return rows, stats


def apply_leads(conn, rows: list[dict]) -> dict:
    """insert per-row `on conflict (dedup_key) do nothing` →
    {"new": n, "dup": m}. KHÔNG delete — leads sống sót sau khi
    convlog purge (fact suy ra, không mirror file)."""
    new = dup = 0
    with conn.cursor() as cur:
        for r in rows:
            cur.execute(INSERT_SQL, r)
            if cur.rowcount:
                new += 1
            else:
                dup += 1
    return {"new": new, "dup": dup}


def connect(dsn: str | None = None):
    """load .env → conn | None (thiếu DSN / không kết nối được → None —
    dashboard hiện 'chưa nạp' thay vì crash)."""
    if dsn is None:
        load_dotenv(ROOT / ".env")
        dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    try:
        return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)
    except psycopg.Error:
        return None


def lead_stats(conn) -> dict | None:
    """Số liệu dashboard từ bảng leads; None khi DB lỗi/thiếu bảng
    (chưa apply_schema hoặc mất kết nối)."""
    if conn is None:
        return None
    try:
        total = conn.execute("select count(*) from leads").fetchone()[0]
        new7 = conn.execute(
            "select count(*) from leads "
            "where ts > now() - interval '7 days'").fetchone()[0]
        by_channel = dict(conn.execute(
            "select channel, count(*) from leads "
            "group by channel").fetchall())
        by_intent = dict(conn.execute(
            "select intent, count(*) from leads "
            "group by intent").fetchall())
        by_status = dict(conn.execute(
            "select status, count(*) from leads "
            "group by status").fetchall())
        recent = conn.execute(
            "select ts, channel, intent, question, user_hash, status "
            "from leads order by ts desc limit 20").fetchall()
    except psycopg.Error:
        return None
    return {"total": total, "new_7d": new7, "by_channel": by_channel,
            "by_intent": by_intent, "by_status": by_status,
            "recent": recent}


def convlog_stats(data_dir: Path = DATA_DIR) -> dict:
    """Số liệu kênh từ convlog (file-based — hiện được cả khi DB chưa
    nạp): total, answered, theo kênh. File thiếu → zeros."""
    stats = {"total": 0, "answered": 0,
             "by_channel": {"zalo": 0, "streamlit": 0}}
    tmp = {"corrupt": 0, "doc": 0, "io_error": 0}
    for name in CONV_FILES:
        path = data_dir / name
        if not path.exists():
            continue
        for rec in iter_convlog(path, tmp):
            stats["total"] += 1
            if rec.get("answered"):
                stats["answered"] += 1
            stats["by_channel"][channel_of(rec)] += 1
    stats["skipped"] = tmp["corrupt"] + tmp["doc"] + tmp["io_error"]
    return stats


def main() -> int:
    load_dotenv(ROOT / ".env")
    rows, stats = harvest()
    print(f"[scan] convlog: {stats['records']} record — "
          f"lead={len(rows)}, intent-miss={stats['intent']}, "
          f"fields-miss={stats['fields']}, ts-bad={stats['ts']}, "
          f"corrupt={stats['corrupt']}, _doc={stats['doc']}, "
          f"io-error={stats['io_error']}, "
          f"dup-in-file={stats['dup_in_file']}"
          + (f" — thiếu {stats['missing']}" if stats["missing"] else ""),
          flush=True)
    if not rows:
        print("[warn] không có lead nào suy ra được — leads đang có "
              "giữ nguyên (insert-only, không xóa)", flush=True)
        return 0

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    try:
        with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S) as conn:
            res = apply_leads(conn, rows)
            total = conn.execute("select count(*) from leads") \
                .fetchone()[0]
            by_channel = conn.execute(
                "select channel, count(*) from leads group by channel "
                "order by channel").fetchall()
    except psycopg.errors.UndefinedTable as e:
        print(f"[err] thiếu bảng leads — chạy `python "
              f"scripts/apply_schema.py` trước: {e}")
        return 1
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {e}")
        return 1
    except psycopg.Error as e:
        print(f"[err] Postgres từ chối nạp leads: {e}")
        return 1
    print(f"[done] mới={res['new']} trùng={res['dup']} — "
          f"total leads={total} "
          f"({', '.join(f'{c}={n}' for c, n in by_channel)})", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
