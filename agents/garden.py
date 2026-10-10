"""WS3 — agent nhật ký vùng trồng: form/chat → chuẩn hóa → cảnh báo.

Contract:
  - Intake ghi `plot_logs` (schema v1.8): `plot_id` FK → `plots`,
    unique `(plot_id, ts, activity)`. `source='manual:garden'` — row
    manual KHÔNG bị `core_store` delete-by-source đè (nhưng someday
    v1.8(a): manual rows chết theo CASCADE nếu plots cha reload
    delete+insert — pilot chấp nhận; khi có khoảnh thật thì plots
    cũng nhập tay).
  - Chuẩn hóa: `normalize_activity` fold bỏ dấu → map về
    `ACTIVITY_VOCAB`; activity lạ vẫn nhận (ghi nguyên văn) + warning.
  - Cảnh báo: `anomaly_check` — khoảnh active chưa có nhật ký nào;
    khoảnh lâu hơn `gap_days` chưa có log; log trong kỳ có keyword
    `agents.report.FLAG_KEYS` (sâu bệnh/rệp/...).
  - Nhật ký là thao tác NGƯỜI ghi tay — hệ thống KHÔNG tự sinh/tự
    sửa (human-gate đối xứng C2.4). Không LLM → output không cần
    `guardrail.check()` (message anomaly là template viết tay).
  - DB down: `connect()` (lead_store, connect_timeout=3) → None;
    `add` exit 2 báo lỗi, `--check` in "chưa nạp" exit 0 (precedent
    `data_audit.py`), UI `st.info`.

Chạy:
  python -m agents.garden --plot KV-A01 --activity "tưới" \
      [--detail "..."] [--author Tên] [--ts ISO]
  python -m agents.garden --check [--gap-days 14]
"""

import argparse
import sys
import unicodedata
from contextlib import contextmanager, suppress
from datetime import date, datetime, timedelta, timezone

import psycopg

from agents.report import FLAG_KEYS
from ingest.lead_store import _parse_ts, connect

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_GAP_DAYS = 14
RECENT_LIMIT = 20
SOURCE = "manual:garden"

ACTIVITY_VOCAB = (
    "trồng", "tưới", "bón", "làm cỏ", "kiểm tra sâu bệnh",
    "phun thuốc sinh học", "thu hoạch", "ghi nhận",
)

# Alias fold-không-dấu → hoạt động chuẩn (form/chat gõ tắt, sai chính
# tả nhẹ vẫn chuẩn hóa được).
ALIASES = {
    "tuoi": "tưới", "tuoi nuoc": "tưới", "tuoi phun suong": "tưới",
    "bon": "bón", "bon phan": "bón",
    "lam co": "làm cỏ", "co": "làm cỏ",
    "sau benh": "kiểm tra sâu bệnh", "kiem tra": "kiểm tra sâu bệnh",
    "kiem tra sau benh": "kiểm tra sâu bệnh",
    "phun thuoc": "phun thuốc sinh học",
    "phun thuoc sinh hoc": "phun thuốc sinh học",
    "thu hoach": "thu hoạch",
    "trong": "trồng", "trong moi": "trồng",
    "ghi nhan": "ghi nhận", "khac": "ghi nhận",
}

INSERT_SQL = (
    "insert into plot_logs (plot_id, ts, activity, detail, author, "
    "source) values (%s, %s, %s, %s, %s, %s) returning id")


def _fold(s: str) -> str:
    """lower + strip + bỏ dấu (NFD combining; đ→d) — so khớp vocab/
    alias bất kể cách gõ. 'đ' không có combining mark nên replace tay."""
    s = unicodedata.normalize("NFD", (s or "").lower().strip())
    return "".join(c for c in s if not unicodedata.combining(c)
                   ).replace("đ", "d")


_FOLDED_VOCAB = {_fold(a): a for a in ACTIVITY_VOCAB}


def normalize_activity(raw) -> tuple[str, bool]:
    """(activity, known). Fold → hit vocab/alias → chuẩn; lạ → nguyên
    văn + False; rỗng → ('ghi nhận', False)."""
    if not isinstance(raw, str) or not raw.strip():
        return "ghi nhận", False
    f = _fold(raw)
    if f in _FOLDED_VOCAB:
        return _FOLDED_VOCAB[f], True
    if f in ALIASES:
        return ALIASES[f], True
    return raw.strip(), False


def _coerce_ts(v):
    """date/datetime/ISO-str → aware datetime | None."""
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day, tzinfo=timezone.utc)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        dt = _parse_ts(s)
        if dt is not None:
            return dt
        try:
            d = date.fromisoformat(s)
            return datetime(d.year, d.month, d.day,
                            tzinfo=timezone.utc)
        except ValueError:
            pass
        try:
            dt = datetime.fromisoformat(s)
            return (dt if dt.tzinfo
                    else dt.replace(tzinfo=timezone.utc))
        except ValueError:
            return None
    return None


def flags_for(activity: str, detail) -> list[str]:
    """Keyword FLAG_KEYS khớp trong activity+detail → list hit."""
    hay = f"{activity} {detail or ''}".lower()
    return [k for k in FLAG_KEYS if k in hay]


def add_log(conn, plot_id, ts, activity, detail=None, author=None,
            source: str = SOURCE) -> tuple[int | None, list[str]]:
    """INSERT 1 nhật ký → (id|None, warnings). Chuẩn hóa activity
    trong này; FK `ForeignKeyViolation` / `UniqueViolation` → warning
    friendly KHÔNG raise (conn.transaction() rollback tự giữ conn
    sống). `ts` coerce qua `_coerce_ts`; None → warning thay raise."""
    warns = []
    pid = (plot_id or "").strip()
    if not pid:
        return None, ["thiếu --plot"]
    when = _coerce_ts(ts)
    if when is None:
        return None, [f"ts không hợp lệ: {ts!r} (ISO YYYY-MM-DD[THH:MM:SS])"]
    act, known = normalize_activity(activity)
    if not known:
        warns.append(f"hoạt động '{act}' chưa có trong vocab — "
                     f"ghi nguyên văn")
    warns += [f"nhật ký có dấu hiệu cần chú ý: '{k}'"
              for k in flags_for(act, detail)]
    params = (pid, when, act, (detail or None), (author or None),
              source)
    try:
        with conn.transaction():
            row = conn.execute(INSERT_SQL, params).fetchone()
        # conn có thể đang nằm trong tx ngoài (UI đã SELECT trước) —
        # khi đó block trên chỉ là savepoint, phải commit() tường minh
        # để ghi thật; conn mới thì commit() là no-op.
        conn.commit()
    except psycopg.errors.ForeignKeyViolation:
        return None, [(f"khoảnh '{pid}' không tồn tại trong bảng "
                       f"plots — thêm khoảnh trước")]
    except psycopg.errors.UniqueViolation:
        return None, [(f"đã có nhật ký trùng: {pid} "
                       f"{when:%Y-%m-%d %H:%M} '{act}'")]
    return (row[0] if row else None), warns


def active_plots(conn) -> list:
    """(id, location) các khoảnh status='active' — data cho form
    selectbox."""
    return conn.execute(
        "select id, coalesce(location, '') from plots "
        "where status = 'active' order by id").fetchall()


def recent_logs(conn, limit: int = RECENT_LIMIT) -> list:
    """Nhật ký mới nhất trước — (ts, plot_id, activity, detail,
    author, source)."""
    return conn.execute(
        "select ts, plot_id, activity, detail, author, source "
        "from plot_logs order by ts desc, id desc limit %s",
        (limit,)).fetchall()


def anomaly_check(conn, gap_days: int = DEFAULT_GAP_DAYS,
                  now=None) -> list[dict]:
    """→ [{'type','plot','ts','msg'}]:
    - 'no-logs': khoảnh active chưa có nhật ký nào
    - 'gap': `max(ts)` của khoảnh cũ hơn `gap_days` ngày
    - 'keyword': log trong `gap_days` gần có FLAG_KEYS
    `now` inject được cho test (mặc định UTC now)."""
    now = now or datetime.now(timezone.utc)
    horizon = now - timedelta(days=gap_days)
    out = []
    last = dict(conn.execute(
        "select plot_id, max(ts) from plot_logs group by plot_id"
    ).fetchall())
    for pid, _loc in active_plots(conn):
        mx = last.get(pid)
        if mx is None:
            out.append({"type": "no-logs", "plot": pid, "ts": None,
                        "msg": f"{pid}: chưa có nhật ký nào"})
        elif mx < horizon:
            out.append({"type": "gap", "plot": pid, "ts": mx,
                        "msg": f"{pid}: không có nhật ký "
                               f"{(now - mx).days} ngày"})
    for ts, pid, act, detail in conn.execute(
            "select ts, plot_id, activity, detail from plot_logs "
            "where ts >= %s order by ts desc", (horizon,)).fetchall():
        hits = flags_for(act, detail)
        if hits:
            out.append({"type": "keyword", "plot": pid, "ts": ts,
                        "msg": f"{pid}: {act} — {', '.join(hits)}"})
    return out


@contextmanager
def _conn_or_none():
    """Yield (conn, err|None) — None conn → degraded path gọn ở
    CLI; đóng conn an toàn sau dùng."""
    conn = connect()
    try:
        yield conn, (None if conn is not None
                     else "không kết nối được Postgres (DATABASE_URL "
                          "thiếu hoặc host chết)")
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.garden",
        description="Agent nhật ký vùng trồng — người ghi tay, hệ "
                    "thống chuẩn hóa + cảnh báo (không tự sinh)")
    ap.add_argument("--check", action="store_true",
                    help="in danh sách bất thường, không ghi gì")
    ap.add_argument("--gap-days", type=int,
                    default=DEFAULT_GAP_DAYS)
    ap.add_argument("--plot", help="mã khoảnh, vd KV-A01")
    ap.add_argument("--activity", help="hoạt động (tưới/bón/...)")
    ap.add_argument("--detail", default=None)
    ap.add_argument("--author", default=None)
    ap.add_argument("--ts", default=None,
                    help="ISO YYYY-MM-DD[THH:MM:SSZ] (mặc định now)")
    args = ap.parse_args(argv)
    if args.check and (args.plot or args.activity):
        ap.error("--check không đi với --plot/--activity")

    with _conn_or_none() as (conn, err):
        if args.check:
            if conn is None:
                print(f"[warn] chưa nạp — {err}")
                return 0
            items = anomaly_check(conn, gap_days=args.gap_days)
            if not items:
                print("[check] không có bất thường — mọi khoảnh "
                      "active đều có nhật ký gần đây")
            for it in items:
                print(f"[{it['type']}] {it['msg']}")
            return 0
        if not args.plot or not args.activity:
            ap.error("ghi nhật ký cần --plot và --activity "
                     "(hoặc dùng --check)")
        if conn is None:
            print(f"[error] {err} — không ghi được", file=sys.stderr)
            return 2
        ts = (_coerce_ts(args.ts) if args.ts
              else datetime.now(timezone.utc))
        if args.ts and ts is None:
            ap.error("--ts sai định dạng ISO")
        lid, warns = add_log(conn, args.plot, ts, args.activity,
                             args.detail, args.author)
        for w in warns:
            print(f"[warn] {w}")
        if lid is None:
            return 2
        print(f"[done] nhật ký #{lid}: {args.plot.strip()} — "
              f"{ts:%Y-%m-%d %H:%M} UTC")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
