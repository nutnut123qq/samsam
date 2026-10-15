"""WP13 (VT) — Agent GĐ vùng trồng: bản tin tuần, nhắc lịch/gap, kiểm
hash chain nhật ký, hồ sơ khoảnh (precheck + gỡ dữ liệu mẫu có người ký).

Contract:
  - Tất định, KHÔNG LLM, KHÔNG gọi mạng. Mọi hàm thời gian nhận `now`/
    `until` tham số — chỉ CLI đọc đồng hồ. Ngày/cửa sổ tuần theo giờ VN
    (UTC+7 cố định, VN không DST).
  - Nhật ký (`plot_logs`) nằm trong hash chain do trigger DB tính
    (`docs/schema.sql` v9.3) — agent chỉ ĐỌC và gọi `verify_plot_logs()`.
  - Gỡ dữ liệu mẫu (`source like 'sample:%'`) CHỈ qua CLI
    `--purge-sample --by "<GĐ vùng trồng>"`: 1 transaction, có blocker
    (nhật ký thật / ảnh trỏ khoảnh mẫu) thì KHÔNG xóa; xong ghi
    `agent_action_log` action `garden_sample_purge`. Agent/cron KHÔNG
    gọi `purge_sample`/`adopt_plot` — `--by` là tên người thật khai báo
    (vai trò `gd_vung_trong` trong SSO = external-dep).
  - Blocker nhật ký thật trên khoảnh mẫu: nhật ký đã chain KHÔNG sửa/
    chuyển được (guard chặn cả UPDATE plot_id) → GĐ vùng trồng ký NHẬN
    khoảnh đó thành khoảnh thật `--adopt-plot <id> --by` (đổi
    `plots.source`, ghi agent_action_log `garden_plot_adopt`). Blocker ảnh:
    nhận khoảnh như trên hoặc chuyển `garden_media.plot_id` sang khoảnh
    thật.
  - Lịch hoạt động định kỳ `data/garden_schedule.json` là GIẢ ĐỊNH chờ
    GĐ vùng trồng chốt lịch canh tác thật.
  - Cờ keyword CHỈ quét `detail` (`garden.flags_for("", detail)`) — tên
    activity 'kiểm tra sâu bệnh' chứa chính keyword (gotcha AGENTS.md).
  - Output (bản tin, stdout) KHÔNG chứa tọa độ/GPS, `location`,
    `area_m2`, người ghi; detail in ra qua `_mask_pii` + cắt 120 ký tự.
  - DB down: `--bulletin`/`--remind`/`--precheck` → `[warn] chưa nạp`
    exit 0; `--verify`/`--purge-sample` → exit 2.

Chạy:
  python -m agents.garden_director --bulletin [--until YYYY-MM-DD]
      (mặc định hôm qua VN — kỳ chỉ gồm ngày đã hết) [--days 7] [--out-dir data/reports] [--schedule PATH]
  python -m agents.garden_director --remind [--schedule PATH]
  python -m agents.garden_director --verify
  python -m agents.garden_director --precheck
  python -m agents.garden_director --purge-sample --by "<GĐ vùng trồng>"
  python -m agents.garden_director --adopt-plot KV-A01 --by "<GĐ vùng trồng>"
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from agents import garden
from agents.report import write_report
from ingest.lead_store import connect
from pipelines.pii import _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SCHEDULE_PATH = ROOT / "data" / "garden_schedule.json"
REPORTS_DIR = ROOT / "data" / "reports"
VN_TZ = timezone(timedelta(hours=7))  # VN không DST — không cần tzdata
SAMPLE_LIKE = "sample:%"
PURGE_ACTION = "garden_sample_purge"
ADOPT_ACTION = "garden_plot_adopt"
ADOPT_SOURCE = "manual:adopted"
DETAIL_MAX = 120
MAX_DAYS = 366


# ---------------------------------------------------------------- hồ sơ khoảnh

def sample_precheck(conn) -> dict:
    """CHỈ ĐỌC. Số dòng mẫu + blocker (thứ chặn gỡ mẫu): nhật ký KHÔNG-mẫu
    trỏ khoảnh mẫu (id, plot_id, ngày VN, source — không detail/author)
    và ảnh `garden_media` trỏ khoảnh mẫu (id, plot_id)."""
    n_plots = conn.execute(
        "select count(*) from plots where source like %s",
        (SAMPLE_LIKE,)).fetchone()[0]
    n_logs = conn.execute(
        "select count(*) from plot_logs where source like %s",
        (SAMPLE_LIKE,)).fetchone()[0]
    blockers = [
        {"kind": "plot_log", "id": i, "plot_id": p,
         "day": ts.astimezone(VN_TZ).date().isoformat(), "source": s}
        for i, p, ts, s in conn.execute(
            "select l.id, l.plot_id, l.ts, l.source from plot_logs l"
            " join plots p on p.id = l.plot_id"
            " where p.source like %s and l.source not like %s"
            " order by l.id", (SAMPLE_LIKE, SAMPLE_LIKE)).fetchall()]
    blockers += [
        {"kind": "garden_media", "id": i, "plot_id": p}
        for i, p in conn.execute(
            "select m.id, m.plot_id from garden_media m"
            " join plots p on p.id = m.plot_id"
            " where p.source like %s order by m.id",
            (SAMPLE_LIKE,)).fetchall()]
    return {"plots": n_plots, "plot_logs": n_logs, "blockers": blockers}


def purge_sample(conn, by) -> dict:
    """Gỡ TOÀN BỘ dữ liệu mẫu vườn — chỉ người thật (GĐ vùng trồng) qua
    CLI. `by` rỗng → ValueError (không đụng DB). 1 transaction: precheck
    lại → có blocker thì KHÔNG xóa; không → xóa nhật ký mẫu rồi khoảnh
    mẫu, số dòng lệch precheck → raise (rollback); ghi agent_action_log
    → commit tường minh (conn có thể đang trong tx ngoài)."""
    by = by.strip() if isinstance(by, str) else ""
    if not by:
        raise ValueError("thiếu --by (tên GĐ vùng trồng ký gỡ dữ liệu mẫu)")
    with conn.transaction():
        pre = sample_precheck(conn)
        if pre["blockers"]:
            return {"ok": False, **pre}
        n_logs = conn.execute("delete from plot_logs where source like %s",
                              (SAMPLE_LIKE,)).rowcount
        n_plots = conn.execute("delete from plots where source like %s",
                               (SAMPLE_LIKE,)).rowcount
        if (n_plots, n_logs) != (pre["plots"], pre["plot_logs"]):
            raise RuntimeError(
                f"số dòng xóa lệch precheck (plots {n_plots}/{pre['plots']},"
                f" plot_logs {n_logs}/{pre['plot_logs']}) — rollback")
        conn.execute(
            "insert into agent_action_log (actor, action, object_type,"
            " object_id, detail) values (%s, %s, 'plots', null, %s)",
            (by, PURGE_ACTION, Jsonb({"plots": n_plots,
                                      "plot_logs": n_logs})))
    conn.commit()
    return {"ok": True, "plots": n_plots, "plot_logs": n_logs,
            "blockers": []}


def adopt_plot(conn, plot_id, by) -> dict:
    """GĐ vùng trồng ký NHẬN khoảnh mẫu thành khoảnh thật — đường gỡ
    blocker 'nhật ký đã chain' (dòng chain KHÔNG UPDATE/DELETE được, kể cả
    đổi plot_id → không "chuyển sang khoảnh thật" được). Chỉ đổi
    `plots.source` → ADOPT_SOURCE (loader không còn xóa/đè khoảnh này);
    thuộc tính khoảnh (vị trí, diện tích, số cây...) VẪN là giá trị mẫu —
    GĐ phải cập nhật bằng số thật. `by` rỗng → ValueError (không đụng DB).
    Khoảnh không tồn tại / không phải mẫu → {"ok": False, "reason"}.
    Xong ghi agent_action_log `garden_plot_adopt` → commit tường minh."""
    by = by.strip() if isinstance(by, str) else ""
    if not by:
        raise ValueError("thiếu --by (tên GĐ vùng trồng ký nhận khoảnh)")
    plot_id = plot_id.strip() if isinstance(plot_id, str) else ""
    with conn.transaction():
        row = conn.execute("select source from plots where id = %s"
                           " for update", (plot_id,)).fetchone()
        if row is None:
            return {"ok": False, "reason": f"khoảnh {plot_id!r} không tồn tại"}
        if not row[0].startswith("sample:"):
            return {"ok": False,
                    "reason": f"khoảnh {plot_id} không phải khoảnh mẫu"}
        conn.execute("update plots set source = %s, updated_at = now()"
                     " where id = %s", (ADOPT_SOURCE, plot_id))
        conn.execute(
            "insert into agent_action_log (actor, action, object_type,"
            " object_id, detail) values (%s, %s, 'plots', %s, %s)",
            (by, ADOPT_ACTION, plot_id, Jsonb({"from_source": row[0]})))
    conn.commit()
    return {"ok": True, "plot_id": plot_id, "from_source": row[0]}


def verify(conn) -> list[tuple[int, str]]:
    """Kết quả `verify_plot_logs()` — rỗng = chuỗi nguyên vẹn."""
    return [tuple(r) for r in conn.execute(
        "select id, problem from verify_plot_logs() order by id, problem"
    ).fetchall()]


# ------------------------------------------------------------ nhắc lịch / gap

class ScheduleError(ValueError):
    """Lịch hoạt động sai cấu trúc/giá trị (CLI `[err]` exit 1)."""


def _valid_days(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 366


def load_schedule(path=SCHEDULE_PATH) -> tuple[dict, list[str]]:
    """→ ({'gap_days', 'activities'}, warnings). Biên: file thiếu / rỗng /
    `{}` / chỉ `_doc` (hoặc không có activity) → lịch rỗng + `gap_days`
    mặc định + warning "chưa có lịch". JSON hỏng / không phải object /
    key lạ / activity ngoài `garden.ACTIVITY_VOCAB` / số ngày không phải
    int 1..366 / `gap_days` sai → ValueError (CLI `[err]` exit 1)."""
    path = Path(path)
    empty = {"gap_days": garden.DEFAULT_GAP_DAYS, "activities": {}}
    warn = [(f"chưa có lịch hoạt động định kỳ ({path.name}) — chỉ nhắc "
             "khoảnh chưa có nhật ký / gap")]
    if not path.exists():
        return empty, warn
    try:
        raw = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise ValueError(f"không đọc được lịch {path.name}: "
                         f"{type(e).__name__}") from e
    if not raw.strip():
        return empty, warn
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"lịch {path.name} JSON hỏng: {e}") from e
    if not isinstance(data, dict):
        raise ScheduleError(f"lịch {path.name} phải là object JSON")
    unknown = sorted(k for k in data if not k.startswith("_")
                     and k not in ("gap_days", "activities"))
    if unknown:
        raise ValueError(f"lịch {path.name} có key lạ: {unknown}")
    gap = data.get("gap_days", garden.DEFAULT_GAP_DAYS)
    if not _valid_days(gap):
        raise ValueError(f"gap_days phải là số nguyên 1..366: {gap!r}")
    acts = data.get("activities", {})
    if not isinstance(acts, dict):
        raise ScheduleError("activities phải là object {hoạt động: số ngày}")
    for act, days in acts.items():
        if act not in garden.ACTIVITY_VOCAB:
            raise ValueError(f"hoạt động '{act}' không thuộc vocab "
                             f"{garden.ACTIVITY_VOCAB}")
        if not _valid_days(days):
            raise ValueError(f"'{act}': số ngày phải là số nguyên 1..366:"
                             f" {days!r}")
    sched = {"gap_days": gap, "activities": dict(sorted(acts.items()))}
    return sched, ([] if acts else warn)


def reminders(plots, last_any: dict, last_by_activity: dict,
              schedule: dict, now: datetime) -> list[dict]:
    """THUẦN (không DB, không đồng hồ). `plots` = id khoảnh active;
    `last_any[plot]` / `last_by_activity[(plot, activity)]` = ts nhật ký
    gần nhất (aware). Sinh:
      - 'no-logs': khoảnh chưa có nhật ký nào (KHÔNG sinh overdue kèm);
      - 'gap': now - last > gap_days (nghiêm ngặt);
      - 'overdue': activity trong lịch chưa từng có hoặc now - last >
        chu kỳ.
    Mỗi mục {type, plot, activity, last_ts, days}; sắp xếp tất định."""
    gap = timedelta(days=schedule.get("gap_days", garden.DEFAULT_GAP_DAYS))
    acts = schedule.get("activities") or {}
    out = []
    for pid in plots:
        last = last_any.get(pid)
        if last is None:
            out.append({"type": "no-logs", "plot": pid, "activity": None,
                        "last_ts": None, "days": None})
            continue
        if now - last > gap:
            out.append({"type": "gap", "plot": pid, "activity": None,
                        "last_ts": last, "days": (now - last).days})
        for act, interval in acts.items():
            la = last_by_activity.get((pid, act))
            if la is None or now - la > timedelta(days=interval):
                out.append({"type": "overdue", "plot": pid, "activity": act,
                            "last_ts": la,
                            "days": None if la is None else (now - la).days})
    out.sort(key=lambda r: (r["type"], r["plot"], r["activity"] or ""))
    return out


def _lit(dt: datetime) -> str:
    """Literal timestamptz cho SQL đối chứng — CHỈ dùng với datetime do
    code sinh (không phải chuỗi người dùng)."""
    return f"'{dt.astimezone(timezone.utc).isoformat()}'::timestamptz"


def _reminder_sql(now: datetime) -> list[str]:
    n = _lit(now)
    return [
        "select id from plots where status = 'active' order by id",
        (f"select plot_id, max(ts) from plot_logs where ts < {n}"
         " group by plot_id order by plot_id"),
        (f"select plot_id, activity, max(ts) from plot_logs where ts < {n}"
         " group by plot_id, activity order by plot_id, activity"),
    ]


def due_reminders(conn, schedule: dict, now: datetime) -> list[dict]:
    """Gom dữ liệu (khoảnh active + nhật ký gần nhất trước `now`) rồi gọi
    `reminders` thuần."""
    q_plots, q_any, q_act = _reminder_sql(now)
    plots = [r[0] for r in conn.execute(q_plots).fetchall()]
    last_any = {p: t for p, t in conn.execute(q_any).fetchall()}
    last_by = {(p, a): t for p, a, t in conn.execute(q_act).fetchall()}
    return reminders(plots, last_any, last_by, schedule, now)


def log_flags(detail) -> list[str]:
    """Keyword cần chú ý — CHỈ quét detail (không quét tên activity)."""
    return garden.flags_for("", detail)


def _vn_day(ts) -> str:
    return ts.astimezone(VN_TZ).date().isoformat() if ts else "chưa từng"


def fmt_reminder(r: dict) -> str:
    if r["type"] == "no-logs":
        return f"[no-logs] {r['plot']}: chưa có nhật ký nào"
    if r["type"] == "gap":
        return (f"[gap] {r['plot']}: {r['days']} ngày chưa có nhật ký "
                f"(gần nhất {_vn_day(r['last_ts'])})")
    tail = "" if r["days"] is None else f", {r['days']} ngày trước"
    return (f"[overdue] {r['plot']}: '{r['activity']}' trễ lịch (gần nhất "
            f"{_vn_day(r['last_ts'])}{tail})")


# ------------------------------------------------------------- bản tin tuần

def _coerce_until(until) -> date:
    """str 'YYYY-MM-DD' (kiểu CLI thật) / date / datetime → date (VN).
    Coerce TRƯỚC mọi format-spec (gotcha v2.2)."""
    if isinstance(until, datetime):
        if until.tzinfo is None:
            raise ValueError("until datetime phải có tzinfo")
        return until.astimezone(VN_TZ).date()
    if isinstance(until, date):
        return until
    if isinstance(until, str):
        try:
            return date.fromisoformat(until.strip())
        except ValueError as e:
            raise ValueError(f"--until sai định dạng YYYY-MM-DD: "
                             f"{until!r}") from e
    raise ValueError(f"until không hợp lệ: {until!r}")


def _default_until(now: datetime) -> date:
    """`--until` mặc định = HÔM QUA giờ VN — kỳ chỉ gồm ngày ĐÃ HẾT. Lấy
    'hôm nay' thì nhật ký ghi sau giờ sinh bản tin trong chính ngày đó
    (ts + created_at đều thuộc kỳ đã sinh, kỳ sau bắt đầu 0h hôm sau)
    không vào bản tin nào. `now` tham số (chỉ CLI đọc đồng hồ)."""
    if now.tzinfo is None:
        raise ValueError("now phải có tzinfo")
    return now.astimezone(VN_TZ).date() - timedelta(days=1)


def _clean_detail(detail) -> str:
    """Mask SĐT/email → gộp khoảng trắng (không vỡ dòng markdown) → cắt."""
    text = re.sub(r"\s+", " ", _mask_pii(detail or "")).strip()
    return text if len(text) <= DETAIL_MAX else text[:DETAIL_MAX] + "…"


def _sql_block(sqls: list[str]) -> list[str]:
    return ["", "SQL đối chứng:", "```sql",
            *[s + ";" for s in sqls], "```", ""]


def build_bulletin(conn, until, days: int = 7, schedule=None) -> str:
    """Bản tin tuần markdown TẤT ĐỊNH cho GĐ vùng trồng — kỳ = `days`
    ngày VN kết thúc hết ngày `until`. 6 mục, mỗi mục kèm SQL đối chứng
    tái lập con số. Không in location/area_m2/người ghi/tọa độ."""
    until_d = _coerce_until(until)
    if not _valid_days(days):
        raise ValueError(f"days phải là số nguyên 1..366: {days!r}")
    if schedule is None:
        schedule = load_schedule()[0]
    end = datetime(until_d.year, until_d.month, until_d.day,
                   tzinfo=VN_TZ) + timedelta(days=1)
    start = end - timedelta(days=days)
    s, e = _lit(start), _lit(end)
    # Nhật ký "mới trong kỳ" = ts trong kỳ HOẶC (dòng thật) GHI trong kỳ —
    # ghi bù sổ giấy (ts tuần trước, nhập tuần này) không lọt giữa 2 bản
    # tin — với điều kiện kỳ chỉ gồm ngày đã hết (`until` <= hôm qua; CLI
    # mặc định `_default_until`). created_at dòng thật do trigger chain ép
    # now() (không giả được);
    # dòng mẫu loại khỏi nhánh created_at vì loader nạp lại mẫu mỗi lần.
    in_period = (f"(ts >= {s} and ts < {e}) or (source not like 'sample:%'"
                 f" and created_at >= {s} and created_at < {e})")
    first_day = (until_d - timedelta(days=days - 1)).isoformat()
    out = [(f"# Bản tin vùng trồng — {first_day} → {until_d.isoformat()}"
            f" ({days} ngày, giờ VN)"), "",
           ("_Tất định, không LLM. Không chứa tọa độ/vị trí/diện tích/người "
            "ghi. Mỗi mục có SQL đối chứng tái lập con số._"), ""]

    # (1) toàn vẹn nhật ký
    q1 = ["select id, problem from verify_plot_logs() order by id, problem",
          "select count(*) from plot_logs where row_hash is not null"]
    problems = conn.execute(q1[0]).fetchall()
    n_chained = conn.execute(q1[1]).fetchone()[0]
    out.append("## 1. Toàn vẹn nhật ký (hash chain)")
    out.append("")
    if problems:
        out.append(f"**CẢNH BÁO: {len(problems)} vấn đề** — nhật ký có thể "
                   f"đã bị sửa/xóa ngoài hệ thống: "
                   + ", ".join(f"#{i} ({p})" for i, p in problems))
    else:
        out.append(f"OK — {n_chained} nhật ký đã chain, 0 vấn đề.")
    out += _sql_block(q1)

    # (2) dữ liệu mẫu còn lại
    q2 = [("select (select count(*) from plots where source like"
           " 'sample:%') as plots, (select count(*) from plot_logs where"
           " source like 'sample:%') as plot_logs")]
    n_sp, n_sl = conn.execute(q2[0]).fetchone()
    out.append("## 2. Dữ liệu mẫu còn lại")
    out.append("")
    out.append(f"{n_sp} khoảnh mẫu, {n_sl} nhật ký mẫu"
               + (" — chờ GĐ vùng trồng ký gỡ (`--precheck` rồi "
                  "`--purge-sample --by`)." if n_sp or n_sl
                  else " — đã sạch."))
    out += _sql_block(q2)

    # (3) nhắc lịch / gap tại cuối ngày until (VN)
    rems = due_reminders(conn, schedule, end)
    out.append(f"## 3. Nhắc lịch & gap (tính tại hết ngày {until_d}, "
               f"gap {schedule.get('gap_days')} ngày)")
    out.append("")
    if not schedule.get("activities"):
        out.append("_Chưa có lịch hoạt động định kỳ — chỉ nhắc no-logs/gap._")
    out += [f"- {fmt_reminder(r)}" for r in rems] or ["Không có nhắc."]
    out += _sql_block(_reminder_sql(end))

    # (4) nhật ký mới trong kỳ theo khoảnh
    q4 = [("select plot_id, count(*) filter (where source like 'sample:%')"
           " as mau, count(*) filter (where source not like 'sample:%')"
           f" as that from plot_logs where {in_period}"
           " group by plot_id order by plot_id")]
    rows4 = conn.execute(q4[0]).fetchall()
    out.append("## 4. Nhật ký mới trong kỳ (ngày hoạt động hoặc ngày ghi)")
    out.append("")
    if rows4:
        out += ["| Khoảnh | Thật | Mẫu |", "|---|---:|---:|"]
        out += [f"| {p} | {that} | {mau} |" for p, mau, that in rows4]
    else:
        out.append("Không có nhật ký nào trong kỳ.")
    out += _sql_block(q4)

    # (5) cảnh báo keyword — CHỈ detail
    q5 = [("select id, plot_id, ts, source, detail from plot_logs"
           f" where ({in_period}) and detail is not null"
           " order by ts, id")]
    flagged = []
    for i, p, ts, src, detail in conn.execute(q5[0]).fetchall():
        hits = log_flags(detail)
        if hits:
            tag = (" (mẫu)" if src.startswith("sample:")
                   else " (ghi bù)" if ts < start else "")
            flagged.append(f"- #{i} {p} {_vn_day(ts)}{tag} — "
                           f"{', '.join(hits)}: {_clean_detail(detail)}")
    out.append("## 5. Cảnh báo từ khóa (chỉ quét chi tiết nhật ký)")
    out.append("")
    out += flagged or ["Không có cảnh báo."]
    out += ["", ("_Lọc keyword `FLAG_KEYS` trên cột detail bằng Python "
                 "(lower), không quét tên hoạt động._")]
    out += _sql_block(q5)

    # (6) ảnh/video mới — v13.4 `garden_media` nhận cả video (mp4/mov) nên
    # nhãn "Ảnh" đếm cả video là sai nghĩa (v14.6).
    q6 = [("select plot_id, count(*) from garden_media"
           f" where created_at >= {s} and created_at < {e}"
           " group by plot_id order by plot_id")]
    rows6 = conn.execute(q6[0]).fetchall()
    out.append("## 6. Ảnh/video vườn mới (đã gỡ EXIF/GPS)")
    out.append("")
    if rows6:
        out += ["| Khoảnh | Ảnh/video |", "|---|---:|"]
        out += [f"| {p} | {n} |" for p, n in rows6]
    else:
        out.append("Không có ảnh/video mới.")
    out += _sql_block(q6)
    return "\n".join(out).rstrip("\n") + "\n"


# ---------------------------------------------------------------------- CLI

OPS = ("bulletin", "remind", "verify", "precheck", "purge_sample",
       "adopt_plot")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.garden_director",
        description="Agent GĐ vùng trồng — bản tin tuần, nhắc lịch/gap, "
                    "kiểm hash chain nhật ký, gỡ dữ liệu mẫu (người ký)")
    ap.add_argument("--bulletin", action="store_true",
                    help="ghi bản tin tuần data/reports/garden-week-<until>.md")
    ap.add_argument("--remind", action="store_true",
                    help="in danh sách nhắc lịch/gap (không ghi gì)")
    ap.add_argument("--verify", action="store_true",
                    help="kiểm hash chain plot_logs (exit 1 nếu có vấn đề)")
    ap.add_argument("--precheck", action="store_true",
                    help="đếm dữ liệu mẫu + blocker (chỉ đọc)")
    ap.add_argument("--purge-sample", action="store_true",
                    help="gỡ dữ liệu mẫu vườn — CHỈ GĐ vùng trồng, cần --by")
    ap.add_argument("--adopt-plot", default=None, metavar="ID",
                    help="GĐ vùng trồng ký nhận khoảnh mẫu thành khoảnh "
                         "thật (gỡ blocker nhật ký đã chain) — cần --by")
    ap.add_argument("--by", default=None,
                    help="tên GĐ vùng trồng ký (gỡ mẫu / nhận khoảnh)")
    ap.add_argument("--until", default=None,
                    help="YYYY-MM-DD ngày cuối kỳ (mặc định HÔM QUA giờ "
                         "VN — kỳ chỉ gồm ngày đã hết; until = hôm nay thì "
                         "nhật ký ghi sau giờ chạy không vào bản tin nào)")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out-dir", default=str(REPORTS_DIR))
    ap.add_argument("--schedule", default=str(SCHEDULE_PATH))
    args = ap.parse_args(argv)
    n_ops = sum(bool(getattr(args, o)) for o in OPS)
    if n_ops != 1:
        ap.error("chọn đúng 1 thao tác: --bulletin | --remind | --verify | "
                 "--precheck | --purge-sample | --adopt-plot")
    if args.adopt_plot is not None and not args.adopt_plot.strip():
        ap.error("--adopt-plot cần mã khoảnh")
    if (args.purge_sample or args.adopt_plot) and not (args.by or "").strip():
        op = "--purge-sample" if args.purge_sample else "--adopt-plot"
        ap.error(f'{op} cần --by "<tên GĐ vùng trồng>" (người thật ký — '
                 'agent không tự làm)')
    until = None
    if args.bulletin:
        try:
            until = (_coerce_until(args.until) if args.until
                     else _default_until(datetime.now(VN_TZ)))
        except ValueError as e:
            ap.error(str(e))
        if not _valid_days(args.days):
            ap.error("--days phải trong 1..366")
    schedule = None
    if args.bulletin or args.remind:
        try:
            schedule, warns = load_schedule(args.schedule)
        except ValueError as e:
            print(f"[err] {e}", file=sys.stderr)
            return 1
        for w in warns:
            print(f"[warn] {w}")

    strict = bool(args.verify or args.purge_sample or args.adopt_plot)
    conn = connect()
    if conn is None:
        msg = ("không kết nối được Postgres (DATABASE_URL thiếu hoặc host "
               "chết)")
        if strict:
            print(f"[err] {msg}", file=sys.stderr)
            return 2
        print(f"[warn] chưa nạp — {msg}")
        return 0
    try:
        if args.purge_sample or args.adopt_plot:
            # v14.2: gỡ mẫu / nhận khoảnh = quyết định của GĐ vùng trồng
            # được Bên B ủy quyền (auth.cli_gate, khối farming).
            from pipelines import auth  # lười: auth → director → ...
            why = auth.cli_gate(
                conn, args.by, "farming",
                "purge_sample" if args.purge_sample else "adopt_plot",
                "plots", args.adopt_plot or "sample")
            if why:
                conn.rollback()
                print(f"[err] {why} — không đổi gì", file=sys.stderr)
                return 1
        if args.verify:
            probs = verify(conn)
            for i, p in probs:
                print(f"[verify] #{i}: {p}")
            if probs:
                print(f"[verify] {len(probs)} vấn đề — nhật ký bị sửa/xóa "
                      f"ngoài hệ thống")
                return 1
            print("[verify] OK — chuỗi nhật ký nguyên vẹn")
            return 0
        if args.remind:
            rems = due_reminders(conn, schedule, datetime.now(VN_TZ))
            for r in rems:
                print(fmt_reminder(r))
            if not rems:
                print("[remind] không có nhắc")
            return 0
        if args.precheck:
            pre = sample_precheck(conn)
            _print_precheck(pre)
            return 0
        if args.purge_sample:
            res = purge_sample(conn, args.by)
            if not res["ok"]:
                _print_precheck(res)
                print("[err] còn blocker — KHÔNG gỡ. Xử lý theo từng "
                      "[blocker] ở trên rồi chạy lại.", file=sys.stderr)
                return 1
            print(f"[done] đã gỡ {res['plots']} khoảnh mẫu, "
                  f"{res['plot_logs']} nhật ký mẫu — ghi agent_action_log "
                  f"'{PURGE_ACTION}'")
            return 0
        if args.adopt_plot:
            res = adopt_plot(conn, args.adopt_plot, args.by)
            if not res["ok"]:
                print(f"[err] {res['reason']} — không đổi gì",
                      file=sys.stderr)
                return 1
            print(f"[done] khoảnh {res['plot_id']} thành khoảnh thật "
                  f"(source {ADOPT_SOURCE}) — ghi agent_action_log "
                  f"'{ADOPT_ACTION}'. Vị trí/diện tích/số cây vẫn là giá "
                  "trị MẪU — cập nhật số thật.")
            return 0
        text = build_bulletin(conn, until, args.days, schedule)
        path = write_report(text, Path(args.out_dir),
                            f"garden-week-{until.isoformat()}.md")
        print(f"[done] {path}")
        return 0
    except RuntimeError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 2
    except psycopg.Error as e:
        first = (str(e).splitlines() or [""])[0]
        print(f"[err] lỗi DB {type(e).__name__}: {first} — đã chạy "
              f"`python scripts/apply_schema.py`?", file=sys.stderr)
        return 2 if strict else 1
    finally:
        with suppress(Exception):
            conn.close()


def _print_precheck(pre: dict) -> None:
    print(f"[precheck] dữ liệu mẫu: {pre['plots']} khoảnh, "
          f"{pre['plot_logs']} nhật ký")
    blockers = pre["blockers"]
    if not blockers:
        print("[precheck] không có blocker — GĐ vùng trồng có thể ký gỡ "
              "(--purge-sample --by)")
    for b in blockers:
        if b["kind"] == "plot_log":
            print(f"[blocker] nhật ký #{b['id']} ({b['source']}, "
                  f"{b['day']}) trỏ khoảnh mẫu {b['plot_id']} — đã chain, "
                  "KHÔNG chuyển/sửa được: GĐ vùng trồng ký nhận khoảnh "
                  f'(--adopt-plot {b["plot_id"]} --by "<tên>")')
        else:
            print(f"[blocker] ảnh #{b['id']} trỏ khoảnh mẫu {b['plot_id']}"
                  f" — chuyển garden_media.plot_id sang khoảnh thật hoặc "
                  f"nhận khoảnh (--adopt-plot {b['plot_id']} --by)")


if __name__ == "__main__":
    raise SystemExit(main())
