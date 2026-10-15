"""v12.6 B6 — Báo cáo vận hành tháng gửi Bên B (HĐ hợp tác TEDO–Sâm Sâm,
PL02 mục 3: "Báo cáo vận hành gửi Bên B trước ngày 05 hằng tháng").

Contract:
  - CHỈ ĐỌC (SELECT + đọc file), 0 LLM, KHÔNG gửi đi — người của Bên A gửi
    file cho Bên B. Ghi `<out-dir>/van-hanh-<YYYY-MM>.md` (mặc định
    `data/reports/`, gitignored).
  - Mỗi số kèm NGUỒN (bảng/file). Thiếu nguồn → "chưa có dữ liệu", KHÔNG
    suy, KHÔNG điền 0. Mẫu số 0 → "—" (không chấm Đạt).
  - (1) KPI vận hành PL02 mục 3:
      * Câu hỏi khách xử lý trong 2 giờ làm việc — câu hỏi = bản ghi convlog
        `answered` True|False trong tháng (dedup như `ingest.lead_store`).
        Bot trả lời (`True`) = đã xử lý. Chuyển người (`False`) = đạt khi mục
        `cskh_handoff` của NHÓM khách/ngày (`sales_director.cskh_object_id`,
        cả đợt `:<ts>`) được NGƯỜI quyết (approved|rejected) trong
        [lúc hỏi, lúc hỏi + 2 giờ làm việc]; ca làm việc = `business_hours`
        của `data/directors/sales.json` (GIẢ ĐỊNH, GĐ KD chốt). Chưa tới hạn
        → không tính. Convlog chỉ giữ 30 ngày → bản ghi sớm nhất muộn hơn
        đầu tháng thì báo thiếu phủ.
      * Báo động đỏ xác nhận trong 2 giờ (giờ đồng hồ, gồm T7/CN/Tết) —
        `red_alerts` gốc (bỏ bản leo thang) ↔ `red_alert_acks`.
      * Lệnh gỡ bài xong trong 24 giờ — đợt vi phạm `channel_posts`
        (url, first_detected_at) phát hiện trong tháng; đạt khi dòng cuối của
        đợt đóng `da_sua`|`da_go` trước `due_at`; đóng `thay_ban_moi` (đổi
        loại vi phạm) = chưa xử lý xong (fail-closed).
      * Bài chưa duyệt đã đăng / rượu-TPBVSK chưa đủ giấy lên quảng cáo — số
        URL có mã `thieu_ban_duyet|lech_ban_duyet` / `ruou_cam_quang_cao|
        sku_chua_xnqc` trong các lần rà kênh (`agents.ra_kenh`) của tháng.
        Tháng không có lần rà nào → "chưa có dữ liệu" (0 không phải bằng
        chứng). Quảng cáo trả phí/KOC ngoài kênh sở hữu chưa có nguồn.
  - (2) Tiêu chí kỹ thuật PL02 mục 2: ngày backup thành công
    (`$BACKUP_DIR/backup_runs.jsonl`, status ok; đếm riêng có bản sao ngoài),
    diễn tập khôi phục (`drill_runs.jsonl` + `dr_runs.jsonl`, mốc
    30/11/2026, 18/12/2026, sau đó mỗi quý), phản hồi chatbot p95 + % > 30
    giây (field `reply_ms` của convlog; không có → "chưa đo"), chi phí AI
    tháng (`llm_usage`).
  - (3) Danh mục tài sản hợp tác PL04 mục 3 từ `data/tai_san_hop_tac.json`
    + dữ kiện tự động (git HEAD, số module, số file test, `docs/handover/`).
  - Tháng tương lai / sai định dạng / danh mục tài sản hỏng → exit 2 (kiểm
    TRƯỚC khi connect, không ghi file). DB không truy cập được → vẫn ghi báo
    cáo với các mục DB "chưa có dữ liệu", exit 1 (cron thấy lỗi). Tháng
    chưa đóng → banner "số tạm".

  - v13.7 (F06):
      * KPI chat BỀN: `--snapshot` (job hằng ngày) chụp dữ kiện chat KHÔNG
        PII từ convlog vào `chat_kpi_facts` (insert-only, khóa sha256 khóa
        dedup) — convlog chỉ giữ 30 ngày nên tháng 31 ngày / chạy ngày 1–4
        không mất đầu tháng. Báo cáo đọc bảng + convlog, gộp theo khóa.
      * Sổ sự cố (`pipelines.ops_incidents`): phát hiện ≤15 phút, phản hồi
        lỗi nghiêm trọng ≤3 giờ / lỗi thường ≤3 ngày làm việc, sửa ≤7 ngày;
        "xử lý khách xong" đếm riêng. Không có sự cố trong sổ → ghi rõ "sổ
        không có sự cố" + nguồn, KHÔNG suy "đạt" cho phát hiện 15 phút khi
        thiếu `occurred_at`.
      * Cảnh báo đỏ: số cảnh báo gốc CHƯA gửi được tới ai
        (`red_alert_deliveries`) — ghi "đã định tuyến" không phải bằng chứng.
      * Rà bài: "Đạt" chỉ trong PHẠM VI file kênh sở hữu đã rà (số lần rà ghi
        rõ); quảng cáo trả phí/KOC/livestream chưa có nguồn → ghi rõ, không
        suy "sạch".
      * Bằng chứng gửi Bên B: CHỈ khi người gửi xác nhận `--mark-sent YYYY-MM
        --file <bản đã gửi> --by "<tên>"` (1 dòng `agent_action_log`
        `ops_report_sent` kèm sha256 file, giờ do DB đặt). Báo cáo tháng M ghi
        trạng thái gửi bản tháng M-1 (hạn trước ngày 05 tháng M).
      * `--month prev` = tháng trước theo giờ VN (cho job ngày 1).

Chạy: `python scripts/ops_monthly.py --month YYYY-MM|prev [--out-dir DIR]` ·
`--snapshot` · `--mark-sent YYYY-MM --file F --by "<tên>"`
"""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from agents.report import REPORTS_DIR, write_report
from agents.sales_director import cskh_object_id, load_sales_config
from ingest.lead_store import (
    CONSENT_REPLY_ROUTES,
    CONV_FILES,
    DATA_DIR,
    _parse_ts,
    connect,
    dedup_key,
    iter_convlog,
)
from pipelines import period
from pipelines.job_runs import clean_detail
from pipelines.period import VN_TZ

ASSETS = ROOT / "data" / "tai_san_hop_tac.json"
MISSING = "missing"
NO_DATA = "chưa có dữ liệu"
CSKH_HOURS = 2                      # PL02 mục 3: 02 giờ làm việc
CSKH_TARGET = 90.0                  # ≥ 90%
ALERT_ACK = timedelta(hours=2)      # 02 giờ đồng hồ, kể cả cuối tuần/Tết
CHAT_LIMIT_MS = 30_000              # PL02 mục 2: phản hồi tự động ≤ 30 giây
DRILL_MOCS = (date(2026, 11, 30), date(2026, 12, 18))  # sau đó mỗi quý
UNAPPROVED = ["thieu_ban_duyet", "lech_ban_duyet"]
NO_PAPER_AD = ["ruou_cam_quang_cao", "sku_chua_xnqc"]
DONE_REASONS = ("da_sua", "da_go")
SCOPE_OK = "Đạt trong phạm vi đã rà"
CODE_DIRS = ("agents", "app", "connectors", "crawler", "ingest", "pipelines",
             "scripts")
_MONTH_RE = re.compile(r"(\d{4})-(0[1-9]|1[0-2])")


class UsageError(ValueError):
    """Tham số/cấu hình sai — exit 2, không connect, không ghi file."""


# ------------------------------------------------------------------ đầu vào
def month_bounds(month: str, now: datetime) -> tuple[datetime, datetime]:
    """'YYYY-MM' → [đầu tháng, đầu tháng sau) giờ VN. Sai/tương lai →
    UsageError."""
    m = _MONTH_RE.fullmatch(month.strip()) if isinstance(month, str) else None
    if m is None:
        raise UsageError("--month cần dạng YYYY-MM")
    start, end = period.period_bounds(
        "month", date(int(m.group(1)), int(m.group(2)), 1))
    if start > now:
        raise UsageError(f"tháng {month} chưa bắt đầu")
    return start, end


def load_assets(path: Path = ASSETS) -> dict:
    """Danh mục tài sản PL04 → dict đã kiểm. Thiếu/hỏng/rỗng → UsageError."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8-sig"))
    except FileNotFoundError:
        raise UsageError(f"không có {Path(path).name}") from None
    except (OSError, ValueError) as e:
        raise UsageError(f"{Path(path).name} hỏng: {type(e).__name__}") \
            from None
    if not isinstance(doc, dict):
        raise UsageError("danh mục tài sản: không phải object JSON")
    try:
        upd = date.fromisoformat(str(doc.get("cap_nhat")))
    except ValueError:
        raise UsageError("cap_nhat: cần ngày YYYY-MM-DD") from None
    items = doc.get("hang_muc")
    keys = ("hang_muc", "mo_ta", "noi_luu", "ben_quan_ly")
    if not isinstance(items, list) or not items or not all(
            isinstance(i, dict) and all(isinstance(i.get(k), str)
                                        and i[k].strip() for k in keys)
            for i in items):
        raise UsageError("hang_muc: cần list không rỗng, mỗi mục đủ "
                         + ", ".join(keys))
    excl = doc.get("khong_thuoc_tai_san_hop_tac", [])
    if not isinstance(excl, list) or not all(
            isinstance(x, str) and x.strip() for x in excl):
        raise UsageError("khong_thuoc_tai_san_hop_tac: cần list chuỗi")
    return {"cap_nhat": upd, "items": [{k: i[k].strip() for k in keys}
                                       for i in items],
            "excluded": [x.strip() for x in excl]}


# ------------------------------------------------------------------ DB
def _q_alerts(conn, start, end):
    return conn.execute(
        "select r.id, r.ts, a.acked_at from red_alerts r left join"
        " red_alert_acks a on a.alert_id = r.id where not (r.detail ?"
        " 'escalation_of') and r.ts >= %s and r.ts < %s order by r.id",
        (start, end)).fetchall()


def _q_takedown(conn, start, end):
    return conn.execute(
        "select distinct on (url, first_detected_at) url, first_detected_at,"
        " due_at, closed_at, close_reason from channel_posts where severity"
        " is not null and first_detected_at >= %s and first_detected_at < %s"
        " order by url, first_detected_at, id desc", (start, end)).fetchall()


def _q_posts(conn, start, end):
    scans = conn.execute(
        "select count(*) from channel_posts where scanned_at >= %s and"
        " scanned_at < %s", (start, end)).fetchone()[0]
    n = {}
    for key, codes in (("unapproved", UNAPPROVED), ("no_paper", NO_PAPER_AD)):
        n[key] = conn.execute(
            "select count(distinct url) from channel_posts where codes && %s"
            " and scanned_at >= %s and scanned_at < %s",
            (codes, start, end)).fetchone()[0]
    return {"scans": scans, **n}


def _q_cskh(conn, start, end):
    # Mục tạo trước tháng vẫn có thể là mục xử lý câu hỏi trong tháng.
    return conn.execute(
        "select object_id, status, decided_at from approval_queue where"
        " object_type = 'cskh_handoff' and status in ('approved', 'rejected')"
        " and decided_at >= %s", (start,)).fetchall()


def _q_cost(conn, start, end):
    return conn.execute(
        "select agent_id, count(*), coalesce(sum(cost_usd), 0),"
        " count(*) filter (where not ok) from llm_usage where ts >= %s and"
        " ts < %s group by agent_id order by 3 desc, 1", (start, end)
    ).fetchall()


def _q_chat_facts(conn, start, end):
    return conn.execute(
        "select qkey, ts, channel, is_question, handled_by_bot, group_oid,"
        " reply_ms from chat_kpi_facts where ts >= %s and ts < %s",
        (start, end)).fetchall()


def _q_incidents(conn, start, end):
    from pipelines.ops_incidents import load
    return load(conn, start, end)


def _q_deliveries(conn, start, end):
    """Cảnh báo GỐC trong tháng chưa có lần gửi ok tới ai."""
    return [r[0] for r in conn.execute(
        "select r.id from red_alerts r where not (r.detail ? 'escalation_of')"
        " and r.ts >= %s and r.ts < %s and not exists (select 1 from"
        " red_alert_deliveries d where d.alert_id = r.id and d.ok)"
        " order by r.id", (start, end)).fetchall()]


def _q_report_sent(conn, start, end):
    """Xác nhận gửi bản báo cáo THÁNG TRƯỚC (hạn trước ngày 05 tháng này)."""
    prev = (period.vn_date(start) - timedelta(days=1)).strftime("%Y-%m")
    return conn.execute(
        "select ts, actor, detail->>'file_sha256' from agent_action_log"
        " where action = 'ops_report_sent' and object_type = 'ops_monthly'"
        " and object_id = %s order by ts, id limit 1", (prev,)).fetchone() \
        or ()


DB_SECTIONS = (("alerts", _q_alerts), ("takedown", _q_takedown),
               ("posts", _q_posts), ("cskh", _q_cskh), ("cost", _q_cost),
               ("chat_facts", _q_chat_facts), ("incidents", _q_incidents),
               ("undelivered", _q_deliveries),
               ("report_sent", _q_report_sent))


def collect_db(conn, start: datetime, end: datetime) -> dict:
    """CHỈ SELECT. Lỗi từng mục (savepoint) không làm hỏng mục khác."""
    out = {}
    for key, fn in DB_SECTIONS:
        try:
            with conn.transaction():
                out[key] = fn(conn, start, end)
        except psycopg.errors.UndefinedTable:
            out[key] = MISSING
        except psycopg.Error as e:
            out[key] = {"error": type(e).__name__}
    return out


# ------------------------------------------------------------------ file
def chat_fact(rec: dict, ts: datetime) -> tuple | None:
    """1 bản ghi convlog → dữ kiện KPI KHÔNG PII | None khi không liên quan:
    (qkey sha256, ts, channel, is_question, handled_by_bot, group_oid,
    reply_ms). Không mang câu hỏi/câu trả lời/user_hash/msg_id thô."""
    # PL02 ≤30 giây đo `reply_ms` (nhận tin → gửi xong, v12.4);
    # `latency_ms` chỉ đo answer() → báo thấp hơn thật, không dùng.
    lat = rec.get("reply_ms")
    lat = lat if isinstance(lat, int) and not isinstance(lat, bool) \
        and lat >= 0 else None
    ans = rec.get("answered")
    # `None` = chào/đồng ý/không áp dụng — không phải câu hỏi.
    is_q = (ans is True or ans is False) \
        and rec.get("route") not in CONSENT_REPLY_ROUTES
    if not is_q and lat is None:
        return None
    # Bot trả lời nhưng gửi lỗi (`sent` False) = khách chưa nhận → không
    # tính "đã xử lý" (fail-closed).
    ok = (ans is True and rec.get("sent") is not False) if is_q else None
    ch = rec.get("channel")
    qkey = hashlib.sha256(dedup_key(rec).encode("utf-8")).hexdigest()
    return (qkey, ts, ch if isinstance(ch, str) else None, is_q, ok,
            cskh_object_id(rec, ts) if is_q else None, lat)


def _iter_facts(data_dir: Path, stats: dict, start=None, end=None):
    """→ (exists, earliest, {qkey: fact}) từ convlog (dedup theo khóa)."""
    facts: dict = {}
    exists, earliest = False, None
    for name in CONV_FILES:
        path = Path(data_dir) / name
        if not path.exists():
            continue
        exists = True
        for rec in iter_convlog(path, stats):
            ts = _parse_ts(rec.get("ts"))
            if ts is None:
                continue
            earliest = ts if earliest is None else min(earliest, ts)
            if start is not None and not start <= ts < end:
                continue
            f = chat_fact(rec, ts)
            if f is not None and f[0] not in facts:
                facts[f[0]] = f
    return exists, earliest, facts


def _derive(facts) -> tuple[list, list]:
    """facts → (questions [(ts, ok, group_oid)], latencies [ms])."""
    fs = sorted(facts, key=lambda f: (f[1], f[0]))
    return ([(f[1], f[4], f[5]) for f in fs if f[3]],
            [f[6] for f in fs if f[6] is not None])


def read_convlog(data_dir: Path, start: datetime, end: datetime) -> dict:
    """Convlog → câu hỏi + độ trễ trong tháng (không mang nội dung khách).
    {exists, earliest, questions: [(ts, answered, group_oid)],
     latencies: [ms], facts: {qkey: fact}}."""
    stats = {"corrupt": 0, "doc": 0, "io_error": 0}
    exists, earliest, facts = _iter_facts(data_dir, stats, start, end)
    qs, lats = _derive(facts.values())
    return {"exists": exists, "earliest": earliest, "questions": qs,
            "latencies": lats, "stats": stats, "facts": facts}


def merge_chat(conv: dict, db_facts) -> dict:
    """Gộp dữ kiện chat đã chụp (`chat_kpi_facts`) với convlog theo khóa —
    convlog đã xoay vòng thì vẫn còn đầu tháng từ bảng."""
    if not isinstance(db_facts, list) or not db_facts:
        return {**conv, "snapshot_rows": 0}
    facts = {f[0]: tuple(f) for f in db_facts}
    facts.update(conv.get("facts") or {})
    qs, lats = _derive(facts.values())
    snap_min = min(f[1] for f in db_facts)
    earliest = (snap_min if conv.get("earliest") is None
                else min(conv["earliest"], snap_min))
    return {**conv, "exists": True, "earliest": earliest, "questions": qs,
            "latencies": lats, "facts": facts,
            "snapshot_rows": len(db_facts)}


def snapshot(conn, data_dir: Path = DATA_DIR) -> tuple[int, int]:
    """Chụp MỌI dữ kiện chat trong convlog hiện có vào `chat_kpi_facts`
    (on conflict do nothing — chạy lại không nhân bản) → (đọc, mới)."""
    stats = {"corrupt": 0, "doc": 0, "io_error": 0}
    _exists, _earliest, facts = _iter_facts(data_dir, stats)
    new = 0
    with conn.transaction():
        for f in facts.values():
            new += conn.execute(
                "insert into chat_kpi_facts (qkey, ts, channel, is_question,"
                " handled_by_bot, group_oid, reply_ms) values (%s, %s, %s,"
                " %s, %s, %s, %s) on conflict (qkey) do nothing", f).rowcount
    conn.commit()
    return len(facts), new


def _backup_dir() -> Path | None:
    v = os.environ.get("BACKUP_DIR")
    return Path(v).expanduser() if v else None


def read_runs(bdir: Path | None, name: str) -> list[dict] | None:
    """`<BACKUP_DIR>/<name>` → [{ts: aware, status, offsite}] | None khi
    chưa cấu hình/không có file."""
    if bdir is None or not (Path(bdir) / name).exists():
        return None
    out = []
    for rec in iter_convlog(Path(bdir) / name,
                            {"corrupt": 0, "doc": 0, "io_error": 0}):
        try:
            ts = datetime.fromisoformat(str(rec.get("ts")))
        except ValueError:
            continue
        if ts.tzinfo is None:
            continue
        out.append({"ts": ts, "status": rec.get("status"),
                    "offsite": rec.get("offsite")})
    return out


def repo_facts(root: Path = ROOT) -> dict:
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True,
            text=True, timeout=10, check=True).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        head = None
    modules = sum(1 for d in CODE_DIRS if (root / d).is_dir()
                  for p in (root / d).rglob("*.py")
                  if p.name != "__init__.py" and "__pycache__" not in p.parts)
    tests = len(list((root / "tests").glob("test_*.py")))
    handover = sorted(p.name for p in (root / "docs" / "handover").glob("*.md"))
    return {"head": head, "modules": modules, "tests": tests,
            "handover": handover}


# ------------------------------------------------------------------ tính KPI
def kpi_cskh(questions, decisions, shift, now: datetime) -> dict:
    """THUẦN. → {ok, late, pending}. Bot trả lời = ok; chuyển người = ok khi
    nhóm có quyết định trong [ts, ts + 2 giờ làm việc]."""
    by_group: dict = {}
    for oid, _status, decided_at in decisions:
        # đợt sau của nhóm = `cskh:<16hex>:<ts UTC>` (sales_director).
        base = (":".join(oid.split(":")[:2]) if oid.startswith("cskh:")
                else oid)
        by_group.setdefault(base, []).append(decided_at)
    r = {"ok": 0, "late": 0, "pending": 0, "bot": 0, "handoff": 0}
    for ts, answered, oid in questions:
        if answered is True:
            r["ok"] += 1
            r["bot"] += 1
            continue
        r["handoff"] += 1
        due = period.business_deadline(ts, CSKH_HOURS, shift)
        if any(ts <= d <= due for d in by_group.get(oid, [])):
            r["ok"] += 1
        elif now < due:
            r["pending"] += 1
        else:
            r["late"] += 1
    return r


def kpi_alerts(rows, now: datetime) -> dict:
    r = {"ok": 0, "late": 0, "pending": 0, "unacked": []}
    for aid, ts, acked_at in rows:
        if acked_at is not None and acked_at - ts <= ALERT_ACK:
            r["ok"] += 1
        elif acked_at is None and now - ts < ALERT_ACK:
            r["pending"] += 1
        else:
            r["late"] += 1
            if acked_at is None:
                r["unacked"].append(aid)
    return r


def kpi_takedown(rows, now: datetime) -> dict:
    r = {"ok": 0, "late": 0, "pending": 0}
    for _url, _first, due, closed_at, reason in rows:
        if closed_at is not None and reason in DONE_REASONS \
                and closed_at <= due:
            r["ok"] += 1
        elif closed_at is None and now < due:
            r["pending"] += 1
        else:
            r["late"] += 1
    return r


def p95(values: list[int]) -> int | None:
    """Nearest-rank p95; rỗng → None."""
    if not values:
        return None
    s = sorted(values)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)]


def backup_days(runs, start: datetime, end: datetime, now: datetime) -> dict:
    """Ngày VN đã qua trong tháng (hôm nay chưa tính) → ngày có bản ok."""
    last = min(period.vn_date(end) - timedelta(days=1),
               period.vn_date(now) - timedelta(days=1))
    d, days = period.vn_date(start), []
    while d <= last:
        days.append(d)
        d += timedelta(days=1)
    ok = {period.vn_date(r["ts"]) for r in runs if r["status"] == "ok"}
    off = {period.vn_date(r["ts"]) for r in runs
           if r["status"] == "ok" and r["offsite"]}
    return {"days": len(days), "ok": sum(1 for x in days if x in ok),
            "offsite": sum(1 for x in days if x in off),
            "missing": [x for x in days if x not in ok]}


def drill_status(runs, start: datetime, end: datetime, now: datetime) -> dict:
    """Mốc diễn tập PL02 → [(nhãn, trạng thái)] + lần chạy trong tháng."""
    ok_days = sorted(period.vn_date(r["ts"]) for r in runs
                     if r["status"] == "ok")
    # ngày CUỐI của tháng báo cáo (`end` là 00:00 đầu tháng sau — loại trừ)
    today = period.vn_date(now)
    m_end = period.vn_date(end) - timedelta(days=1)
    marks, prev = [], date.min
    for moc in DRILL_MOCS:
        if moc - timedelta(days=60) > m_end:
            break
        hit = [d for d in ok_days if prev < d <= moc]
        st = (f"đạt ({hit[-1]:%d/%m/%Y})" if hit else
              "chưa tới hạn" if today <= moc else "KHÔNG ĐẠT")
        marks.append((f"mốc {moc:%d/%m/%Y}", st))
        prev = moc
    m_start = period.vn_date(start)
    if m_start > DRILL_MOCS[-1]:
        q = (m_start.month - 1) // 3
        q_start = date(m_start.year, 3 * q + 1, 1)
        q_end = (date(m_start.year + 1, 1, 1) if q == 3
                 else date(m_start.year, 3 * q + 4, 1))
        hit = [d for d in ok_days if q_start <= d < q_end and d <= m_end]
        st = (f"đạt ({hit[-1]:%d/%m/%Y})" if hit else
              "chưa có lần đạt — hạn cuối quý" if today < q_end
              else "KHÔNG ĐẠT")
        marks.append((f"quý {q + 1}/{m_start.year}", st))
    month_runs = [(period.vn_date(r["ts"]), r["status"]) for r in runs
                  if start <= r["ts"] < end]
    return {"marks": marks, "month_runs": sorted(month_runs)}


# ------------------------------------------------------------------ render
def _pct(ok: int, total: int) -> str:
    return "—" if total == 0 else f"{100 * ok / total:.1f}%"


def _verdict_pct(ok: int, total: int, target: float) -> str:
    if total == 0:
        return "— (không có mục tới hạn)"
    return "Đạt" if 100 * ok / total >= target else "KHÔNG ĐẠT"


def _state(val, table: str) -> str | None:
    if val is None:
        return f"{NO_DATA} (DB không truy cập được)"
    if val == MISSING:
        return f"{NO_DATA} (chưa có bảng `{table}`)"
    if isinstance(val, dict) and "error" in val:
        return f"{NO_DATA} (lỗi đọc `{table}`: {val['error']})"
    return None


def _cell(v) -> str:
    """Chuỗi từ DB/cấu hình vào markdown: mask PII/secret, bỏ xuống dòng/|."""
    s = clean_detail(v) or ""
    return " ".join(s.replace("|", "/").split())[:300]


def _vn(ts: datetime) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M")


def _sent_row(sent, start: datetime) -> tuple:
    """KPI "Báo cáo vận hành gửi Bên B trước ngày 05": bằng chứng = người
    gửi xác nhận (`--mark-sent`) cho bản THÁNG TRƯỚC; hạn = 00:00 ngày 05
    tháng này (giờ VN). Không có xác nhận → không chấm."""
    prev = period.vn_date(start) - timedelta(days=1)
    due = start.replace(day=5)
    label = (f"Báo cáo vận hành tháng {prev:%m/%Y} gửi Bên B")
    src = "`agent_action_log` `ops_report_sent` (người gửi xác nhận)"
    if (msg := _state(sent, "agent_action_log")):
        return (label, "Trước ngày 05", msg, "—", "Bên A", src)
    if not sent:
        return (label, "Trước ngày 05", ("chưa có xác nhận gửi (người gửi "
                                         "chạy `--mark-sent`)"), "—",
                "Bên A", src)
    ts, actor, sha = sent
    return (label, "Trước ngày 05",
            (f"gửi {_vn(ts)} — {_cell(actor)} xác nhận, sha256 "
             f"{_cell(sha)[:12]}"), "Đạt" if ts < due else "KHÔNG ĐẠT",
            "Bên A", src)


def incident_rows(inc, shift, now: datetime) -> tuple[list, list]:
    """Mục sổ sự cố → (dòng bảng PL02 mục 2, ghi chú)."""
    from pipelines import ops_incidents as oi
    src = "`ops_incidents` + `ops_incident_events`"
    labels = (("Phát hiện sự cố hệ thống", "≤ 15 phút", "detect", None),
              ("Phản hồi lỗi nghiêm trọng", "≤ 03 giờ", "respond",
               "nghiem_trong"),
              ("Phản hồi lỗi thường", "≤ 03 ngày làm việc", "respond",
               "thuong"),
              ("Sửa lỗi phát sinh", "≤ 07 ngày", "fix", None))
    if (msg := _state(inc, "ops_incidents")):
        return [(a, b, msg, src) for a, b, _k, _s in labels], []
    if shift is None:
        return [(a, b, f"{NO_DATA} (lịch ngày làm việc lỗi)", src)
                for a, b, _k, _s in labels], []
    rows = oi.evaluate(inc["incidents"], inc["events"], shift, now)
    if not rows:
        empty = ("sổ sự cố không có sự cố phát hiện trong tháng (không "
                 "phải bằng chứng hệ thống không có sự cố — chỉ là sổ ghi)")
        return [(a, b, empty, src) for a, b, _k, _s in labels], []
    out = []
    for a, b, key, sev in labels:
        c = oi.summarize(rows, key, sev)
        tot = c["ok"] + c["late"]
        txt = (f"{_pct(c['ok'], tot)} ({c['ok']}/{tot}); chưa tới hạn "
               f"{c['pending']}")
        if c["unmeasured"]:
            txt += f"; chưa đo (thiếu lúc xảy ra) {c['unmeasured']}"
        out.append((a, b, txt, src))
    done = sum(1 for r in rows if r["customer_resolved_at"] is not None)
    notes = [(f"- Sổ sự cố: {len(rows)} sự cố; xử lý khách/đối tác xong "
              f"{done} (đếm RIÊNG — không thay phản hồi/sửa kỹ thuật).")]
    return out, notes


def render(f: dict) -> str:
    """THUẦN từ facts → markdown. Không chép nội dung khách/URL bài."""
    start, end, now = f["start"], f["end"], f["now"]
    db = f.get("db") or {}
    due = period.vn_date(end).replace(day=5)
    L = [f"# Báo cáo vận hành tháng {start:%m/%Y}", "",
         (f"_Sinh lúc {_vn(now)} giờ VN. Hạn gửi Bên B: trước ngày "
          f"{due:%d/%m/%Y} (PL02 mục 3). Số do code tính từ bảng/file nêu ở "
          "cột Nguồn, không dùng LLM; báo cáo chỉ đọc, không tự gửi._"), ""]
    if now < end:
        L += [f"> **THÁNG CHƯA ĐÓNG** — số tạm tính tới {_vn(now)}.", ""]
    if not f.get("db_ok"):
        L += [("> **DB không truy cập được** — mọi mục lấy từ DB ghi "
               f"\"{NO_DATA}\"."), ""]

    # ---- (1) KPI vận hành
    rows, notes = [], []
    conv = f["conv"]
    cs = db.get("cskh") if f.get("db_ok") else None
    src = ("convlog `conversations.jsonl` + `approval_queue` "
           "(`cskh_handoff`), ca `data/directors/sales.json`")
    if not conv["exists"]:
        rows.append(("Câu hỏi khách xử lý trong 2 giờ làm việc", "≥ 90%",
                     f"{NO_DATA} (không có convlog)", "—", "Bên B", src))
    elif f.get("shift_error"):
        rows.append(("Câu hỏi khách xử lý trong 2 giờ làm việc", "≥ 90%",
                     f"{NO_DATA} (ca làm việc lỗi: {f['shift_error']})", "—",
                     "Bên B", src))
    elif (msg := _state(cs, "approval_queue")):
        rows.append(("Câu hỏi khách xử lý trong 2 giờ làm việc", "≥ 90%",
                     msg, "—", "Bên B", src))
    else:
        k = kpi_cskh(conv["questions"], cs, f["shift"], now)
        tot = k["ok"] + k["late"]
        rows.append(("Câu hỏi khách xử lý trong 2 giờ làm việc", "≥ 90%",
                     f"{_pct(k['ok'], tot)} ({k['ok']}/{tot})",
                     _verdict_pct(k["ok"], tot, CSKH_TARGET), "Bên B", src))
        notes.append(f"- Câu hỏi khách: bot trả lời {k['bot']}, chuyển người "
                     f"{k['handoff']} (trễ {k['late']}, chưa tới hạn "
                     f"{k['pending']}).")
        if conv["earliest"] is not None and conv["earliest"] > start:
            notes.append(f"- Convlog chỉ còn từ {_vn(conv['earliest'])} "
                         "(giữ 30 ngày; bảng `chat_kpi_facts` cũng không có "
                         "sớm hơn) — câu hỏi trước mốc này không tính.")

    al = db.get("alerts") if f.get("db_ok") else None
    src = "`red_alerts` (bỏ bản leo thang) + `red_alert_acks`"
    if (msg := _state(al, "red_alerts")):
        rows.append(("Báo động đỏ xác nhận trong 2 giờ", "100%", msg, "—",
                     "Bên B", src))
    else:
        k = kpi_alerts(al, now)
        tot = k["ok"] + k["late"]
        rows.append(("Báo động đỏ xác nhận trong 2 giờ", "100%",
                     f"{_pct(k['ok'], tot)} ({k['ok']}/{tot})",
                     _verdict_pct(k["ok"], tot, 100.0), "Bên B", src))
        notes.append(f"- Báo động đỏ: {len(al)} cảnh báo gốc, đúng hạn "
                     f"{k['ok']}, trễ/chưa xác nhận {k['late']}, chưa tới hạn "
                     f"{k['pending']}"
                     + (f"; chưa xác nhận: #{', #'.join(map(str, k['unacked']))}"
                        if k["unacked"] else "") + ".")

    td = db.get("takedown") if f.get("db_ok") else None
    src = "`channel_posts` (đợt vi phạm, `agents.ra_kenh`)"
    if (msg := _state(td, "channel_posts")):
        rows.append(("Lệnh gỡ bài vi phạm xong trong 24 giờ", "100%", msg,
                     "—", "Bên B", src))
    else:
        k = kpi_takedown(td, now)
        tot = k["ok"] + k["late"]
        rows.append(("Lệnh gỡ bài vi phạm xong trong 24 giờ", "100%",
                     f"{_pct(k['ok'], tot)} ({k['ok']}/{tot})",
                     _verdict_pct(k["ok"], tot, 100.0), "Bên B", src))
        notes.append(f"- Gỡ/sửa bài: {len(td)} đợt vi phạm phát hiện trong "
                     f"tháng, xong đúng hạn {k['ok']}, trễ {k['late']}, chưa "
                     f"tới hạn {k['pending']}.")

    po = db.get("posts") if f.get("db_ok") else None
    src = "`channel_posts` (rà kênh sở hữu trong tháng)"
    for label, key, codes in (
            ("Bài đăng chưa được duyệt", "unapproved", UNAPPROVED),
            ("Rượu/TPBVSK chưa đủ giấy lên quảng cáo", "no_paper",
             NO_PAPER_AD)):
        resp = "Hai Bên"
        if (msg := _state(po, "channel_posts")):
            rows.append((label, "0", msg, "—", resp, src))
        elif po["scans"] == 0:
            rows.append((label, "0", (f"{NO_DATA} (không có lần rà kênh "
                                      "nào trong tháng)"), "—", resp, src))
        else:
            # v13.7: 0 URL vi phạm chỉ nói về các file kênh SỞ HỮU đã rà —
            # không phải "toàn kênh/KOC/ads/livestream sạch".
            n = po[key]
            rows.append((label, "0", (f"{n} URL ({'/'.join(codes)}) — phạm "
                                      f"vi: {po['scans']} lượt rà kênh sở "
                                      "hữu"),
                         SCOPE_OK if n == 0 else "KHÔNG ĐẠT", resp, src))
    rows.append(_sent_row(db.get("report_sent") if f.get("db_ok") else None,
                          start))
    L += ["## 1. KPI vận hành hằng tháng (PL02 mục 3)", "",
          ("| Chỉ tiêu | Yêu cầu | Kết quả | Đánh giá | Bên chịu trách nhiệm"
           " | Nguồn |"), "|---|---|---|---|---|---|"]
    L += ["| " + " | ".join(r) + " |" for r in rows]
    L += [""] + notes
    L.append("- Quảng cáo trả phí/KOC/livestream ngoài kênh sở hữu: "
             f"{NO_DATA} (chỉ rà file xuất kênh sở hữu) — hai chỉ tiêu bài "
             "đăng/quảng cáo KHÔNG được coi là đạt cho phần này.")
    und = db.get("undelivered") if f.get("db_ok") else None
    if (msg := _state(und, "red_alert_deliveries")):
        L.append(f"- Gửi cảnh báo đỏ: {msg}.")
    elif und:
        L.append(f"- Cảnh báo đỏ CHƯA gửi được tới người nhận nào ("
                 f"`red_alert_deliveries`): {len(und)} — #"
                 + ", #".join(map(str, und[:20])) + ".")
    else:
        L.append("- Cảnh báo đỏ gốc trong tháng: đều có lần gửi thành công "
                 "(`red_alert_deliveries`).")
    if conv.get("snapshot_rows"):
        L.append(f"- Dữ kiện chat: {conv['snapshot_rows']} dòng từ "
                 "`chat_kpi_facts` (chụp hằng ngày) gộp convlog.")

    # ---- (2) tiêu chí kỹ thuật
    L += ["", "## 2. Tiêu chí kỹ thuật (PL02 mục 2)", "",
          "| Chỉ tiêu | Yêu cầu | Kết quả | Nguồn |", "|---|---|---|---|"]
    bk = f["backups"]
    if bk is None:
        L.append(f"| Backup dữ liệu thành công | 100% số ngày | {NO_DATA} "
                 "(chưa cấu hình `BACKUP_DIR` hoặc chưa có nhật ký) | "
                 "`backup_runs.jsonl` |")
    else:
        b = backup_days(bk, start, end, now)
        L.append(f"| Backup dữ liệu thành công | 100% số ngày | "
                 f"{b['ok']}/{b['days']} ngày ({_pct(b['ok'], b['days'])}); "
                 f"có bản sao ngoài {b['offsite']} ngày | "
                 "`$BACKUP_DIR/backup_runs.jsonl` |")
    dr = f["drills"]
    if dr is None:
        L.append(f"| Diễn tập khôi phục | 30/11/2026, 18/12/2026, sau đó mỗi "
                 f"quý | {NO_DATA} (chưa có nhật ký diễn tập) | "
                 "`drill_runs.jsonl`, `dr_runs.jsonl` |")
    else:
        d = drill_status(dr, start, end, now)
        res = "; ".join(f"{a}: {b}" for a, b in d["marks"]) or "chưa tới mốc"
        L.append(f"| Diễn tập khôi phục | 30/11/2026, 18/12/2026, sau đó mỗi "
                 f"quý | {res}; trong tháng {len(d['month_runs'])} lần | "
                 "`$BACKUP_DIR/drill_runs.jsonl`, `dr_runs.jsonl` |")
    lats = conv["latencies"]
    if not lats:
        L.append("| Phản hồi tự động của chatbot | ≤ 30 giây | chưa đo "
                 "(không có `reply_ms` trong convlog tháng — bản ghi trước v12.4 không đo) | convlog |")
    else:
        slow = sum(1 for x in lats if x > CHAT_LIMIT_MS)
        L.append(f"| Phản hồi tự động của chatbot | ≤ 30 giây | p95 "
                 f"{p95(lats) / 1000:.1f} giây; > 30 giây {slow}/{len(lats)} "
                 f"({_pct(slow, len(lats))}) | convlog `reply_ms` |")
    co = db.get("cost") if f.get("db_ok") else None
    if (msg := _state(co, "llm_usage")):
        L.append(f"| Chi phí AI tháng | trong trần `data/llm_gateway.json` | "
                 f"{msg} | `llm_usage` |")
    else:
        tot = sum(float(c) for _, _, c, _ in co)
        calls = sum(n for _, n, _, _ in co)
        L.append(f"| Chi phí AI tháng | trong trần `data/llm_gateway.json` | "
                 f"{tot:.4f} USD / {calls} lời gọi | `llm_usage` |")
    inc_rows, inc_notes = incident_rows(
        db.get("incidents") if f.get("db_ok") else None, f.get("workdays"),
        now)
    L += [f"| {a} | {b} | {c} | {d} |" for a, b, c, d in inc_rows]
    L.append("")
    L += inc_notes
    if f.get("holiday_warning"):
        L.append(f"- {f['holiday_warning']}")
    if bk is not None:
        b = backup_days(bk, start, end, now)
        if b["missing"]:
            L.append("- Ngày không có backup thành công: "
                     + ", ".join(f"{x:%d/%m}" for x in b["missing"]) + ".")
    if dr is not None:
        for day, st in drill_status(dr, start, end, now)["month_runs"]:
            L.append(f"- Diễn tập {day:%d/%m/%Y}: {st}.")
    if co not in (None, MISSING) and not isinstance(co, dict):
        for agent, n, cost, err in co[:10]:
            L.append(f"- AI `{_cell(agent)}`: {float(cost):.4f} USD, {n} lời gọi, "
                     f"lỗi {err}.")

    # ---- (3) tài sản hợp tác
    a, rf = f["assets"], f["repo"]
    L += ["", "## 3. Danh mục tài sản hợp tác (PL04 mục 3)", "",
          (f"_Nguồn: `data/tai_san_hop_tac.json` (cập nhật "
           f"{a['cap_nhat']:%d/%m/%Y})._"), "",
          "| Hạng mục | Mô tả | Nơi lưu giữ | Bên quản lý |", "|---|---|---|---|"]
    L += ["| " + " | ".join(_cell(i[k]) for k in ("hang_muc", "mo_ta",
                                                 "noi_luu", "ben_quan_ly"))
          + " |" for i in a["items"]]
    if a["excluded"]:
        L += ["", "Không thuộc tài sản hợp tác (tài sản riêng Bên B): "
                + ", ".join(_cell(x) for x in a["excluded"]) + "."]
    L += ["", "Dữ kiện tự động của kho mã nguồn:",
          f"- Commit hiện tại: `{rf['head'] or 'không đọc được'}`",
          f"- Số module Python: {rf['modules']}; số file test: {rf['tests']}",
          "- Tài liệu bàn giao `docs/handover/`: "
          + (", ".join(rf["handover"]) or "(không có)")]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ chạy
def gather(start, end, now, *, conn=None, data_dir: Path = DATA_DIR,
           backup_dir: Path | None = None, assets: dict) -> dict:
    f = {"start": start, "end": end, "now": now, "assets": assets,
         "conv": read_convlog(data_dir, start, end), "repo": repo_facts()}
    try:
        f["shift"] = load_sales_config()["business_hours"]
    except Exception as e:  # noqa: BLE001 — chỉ tên lỗi, mục ghi "chưa có"
        f["shift"], f["shift_error"] = None, type(e).__name__
    f["backups"] = read_runs(backup_dir, "backup_runs.jsonl")
    logs = [read_runs(backup_dir, n)
            for n in ("drill_runs.jsonl", "dr_runs.jsonl")]
    f["drills"] = (None if all(x is None for x in logs)
                   else [r for x in logs for r in (x or [])])
    own = conn is None
    if own:
        conn = connect()
    f["db_ok"] = conn is not None
    if conn is not None:
        try:
            f["db"] = collect_db(conn, start, end)
        finally:
            if own:
                conn.rollback()
                conn.close()
        f["conv"] = merge_chat(f["conv"], f["db"].get("chat_facts"))
    try:
        from pipelines.rollout import holiday_warning, load_shift
        f["workdays"], f["holiday_warning"] = load_shift(), holiday_warning()
    except ValueError as e:
        f["workdays"], f["workdays_error"] = None, str(e)
    return f


def _cli_snapshot(conn, data_dir: Path) -> int:
    own = conn is None
    conn = connect() if own else conn
    if conn is None:
        print("[err] DB không truy cập được — chưa chụp KPI chat")
        return 1
    try:
        seen, new = snapshot(conn, data_dir)
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB khi chụp KPI chat: {type(e).__name__}")
        return 1
    finally:
        if own:
            conn.close()
    print(f"[ok] chat_kpi_facts: đọc {seen} dữ kiện, mới {new}")
    return 0


def _cli_mark_sent(args, conn, now: datetime) -> int:
    """Người gửi xác nhận đã gửi bản báo cáo tháng → 1 dòng hash chain."""
    from pipelines import auth
    m = _MONTH_RE.fullmatch((args.mark_sent or "").strip())
    by = " ".join(str(args.by or "").split())
    if m is None:
        print("[usage] --mark-sent cần YYYY-MM")
        return 2
    start, _end = period.period_bounds(
        "month", date(int(m.group(1)), int(m.group(2)), 1))
    if _end > now:
        print("[usage] tháng chưa đóng — chưa thể gửi báo cáo tháng này")
        return 2
    if not by or len(by) > 100 or not auth.is_human(by):
        print("[usage] --by phải là tên NGƯỜI đã gửi (không agent:/system:)")
        return 2
    want = f"van-hanh-{start:%Y-%m}.md"
    if args.file is None or args.file.name != want or not args.file.is_file():
        print(f"[usage] --file phải là bản đã gửi `{want}`")
        return 2
    sha = hashlib.sha256(args.file.read_bytes()).hexdigest()
    own = conn is None
    conn = connect() if own else conn
    if conn is None:
        print("[err] DB không truy cập được — chưa ghi xác nhận")
        return 1
    try:
        conn.execute(
            "insert into agent_action_log (actor, action, object_type,"
            " object_id, detail) values (%s, 'ops_report_sent',"
            " 'ops_monthly', %s, %s)",
            (clean_detail(by), f"{start:%Y-%m}",
             json.dumps({"file_sha256": sha, "confirmed_by_sender": True})))
        conn.commit()
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB: {type(e).__name__}")
        return 1
    finally:
        if own:
            conn.close()
    print(f"[ok] đã ghi xác nhận gửi báo cáo {start:%m/%Y} (sha256 "
          f"{sha[:12]}; giờ ghi do DB đặt)")
    return 0


def main(argv=None, *, now: datetime | None = None, conn=None,
         data_dir: Path = DATA_DIR) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--month", help="YYYY-MM | prev (tháng trước, giờ VN)")
    g.add_argument("--snapshot", action="store_true",
                   help="chụp dữ kiện chat không PII từ convlog vào DB")
    g.add_argument("--mark-sent", metavar="YYYY-MM",
                   help="NGƯỜI GỬI xác nhận đã gửi báo cáo tháng cho Bên B")
    ap.add_argument("--file", type=Path, help="bản báo cáo đã gửi")
    ap.add_argument("--by", help="tên người đã gửi")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    now = now or datetime.now(VN_TZ)
    if args.snapshot:
        return _cli_snapshot(conn, data_dir)
    if args.mark_sent is not None:
        return _cli_mark_sent(args, conn, now)
    if args.month.strip() == "prev":
        args.month = (period.vn_date(now).replace(day=1)
                      - timedelta(days=1)).strftime("%Y-%m")
    try:
        start, end = month_bounds(args.month, now)
        assets = load_assets(ASSETS)
    except UsageError as e:
        print(f"[usage] {e}")
        return 2
    f = gather(start, end, now, conn=conn, data_dir=data_dir,
               backup_dir=_backup_dir(), assets=assets)
    path = write_report(render(f), args.out_dir,
                        f"van-hanh-{start:%Y-%m}.md")
    print(f"[ok] {path}")
    if not f["db_ok"]:
        print("[err] DB không truy cập được — mục DB ghi 'chưa có dữ liệu'")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
