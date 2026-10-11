"""PC-A0 (v4.4 W44.1) — mô hình tải người duyệt: hàng duyệt so với quota.

Chuyên viên Pháp chế là người duyệt DUY NHẤT; plan_legal_hr §2 đề xuất trần
~25 mục/ngày (quỹ 120→240 phút/ngày). Script này CHỈ ĐỌC (SELECT
`content_drafts` + `approvals`) rồi nhắc khi quá tải — KHÔNG gán người
duyệt, KHÔNG đổi status, KHÔNG ghi DB (A0 chỉ nhắc, người quyết là người).

  - Quota: `data/review_quota.json` — `phases` [{from, to|null, daily_cap}]
    (trần quyết định/ngày của MỖI người duyệt), `absent_days` (ngày vắng →
    trần 0), `status` (`chot` = TGĐ đã chốt; khác = ĐỀ XUẤT). Quota thật
    là external-dep.
  - Hàng chờ = draft `status='pending'` tách theo `guardrail->'ok'`:
    boolean true → "vào hàng" (tính quota); boolean false → "trả tác giả"
    (KHÔNG tính quota — §6 bước 2, tác giả sửa trước); thiếu/khác kiểu →
    "KHÔNG RÕ", tính VÀO hàng (fail-closed).
  - Inflow = số draft tạo theo ngày VN trong `days` ngày gần nhất (gồm hôm
    nay). Throughput = số dòng `approvals` (approved + rejected, mọi
    object_type) theo (ngày VN của approved_at, btrim(approved_by)).
  - Ngày luôn theo giờ Asia/Ho_Chi_Minh (`at time zone`), không UTC.

Chạy: `python scripts/review_load.py [--today YYYY-MM-DD] [--days N]
[--quota PATH]`. Exit 2 = tham số/quota sai (TRƯỚC khi connect DB); exit 1
= DB không truy cập được; exit 0 còn lại (cảnh báo chỉ in, không đổi exit).
Tên người duyệt in nguyên (nhân viên, không phải khách); KHÔNG in
`text`/`brief` của draft.
"""

import argparse
import json
import math
import re
import sys
from datetime import date, datetime, timedelta, timezone
from itertools import pairwise
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from ingest import lead_store

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_QUOTA = ROOT / "data" / "review_quota.json"
VN_TZ = timezone(timedelta(hours=7))
class QuotaError(ValueError):
    """Quota/tham số sai → exit 2 (subclass ValueError)."""


_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
MAX_DAYS = 366
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# Mọi câu SQL bắt đầu bằng `select` (read-only — test fake-conn kiểm).
_VN = "at time zone 'Asia/Ho_Chi_Minh'"
SQL_QUEUE = (
    "select case when guardrail -> 'ok' = 'true'::jsonb then 'vao_hang'"
    " when guardrail -> 'ok' = 'false'::jsonb then 'tra_tac_gia'"
    " else 'khong_ro' end as g, count(*),"
    f" min((created_at {_VN})::date)"
    " from content_drafts where status = 'pending' group by 1")
SQL_INFLOW = (
    f"select (created_at {_VN})::date as d, count(*) from content_drafts"
    f" where (created_at {_VN})::date between %s and %s group by 1")
SQL_THROUGHPUT = (
    f"select (approved_at {_VN})::date as d, btrim(approved_by) as who,"
    " count(*) from approvals"
    f" where (approved_at {_VN})::date between %s and %s"
    " group by 1, 2 order by 1, 2")


def _iso(v, where: str) -> date:
    if not isinstance(v, str) or not _ISO_RE.fullmatch(v):
        raise QuotaError(f"{where}: cần ngày YYYY-MM-DD, nhận {v!r}")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise QuotaError(f"{where}: ngày không hợp lệ {v!r}") from None


def load_quota(path) -> dict:
    """Đọc + validate quota → {"status", "phases": [(from, to|None, cap)],
    "absent_days": frozenset[date]}. Lỗi bất kỳ → ValueError."""
    try:
        raw = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise QuotaError(f"quota không đọc được: {type(e).__name__}") from None
    if not isinstance(raw, dict):
        raise QuotaError("quota phải là object JSON")
    phases = raw.get("phases")
    if not isinstance(phases, list) or not phases:
        raise QuotaError("quota.phases rỗng hoặc không phải list")
    out = []
    for i, p in enumerate(phases):
        where = f"phases[{i}]"
        if not isinstance(p, dict):
            raise QuotaError(f"{where} phải là object")
        start = _iso(p.get("from"), f"{where}.from")
        end = None if p.get("to") is None else _iso(p.get("to"), f"{where}.to")
        if end is not None and end < start:
            raise QuotaError(f"{where}: to < from")
        cap = p.get("daily_cap")
        if isinstance(cap, bool) or not isinstance(cap, int) or cap < 0:
            raise QuotaError(f"{where}.daily_cap phải là số nguyên >= 0")
        out.append((start, end, cap))
    out.sort(key=lambda x: x[0])
    for (s1, e1, _), (s2, _, _) in pairwise(out):
        if e1 is None or e1 >= s2:
            raise QuotaError(f"phases chồng nhau quanh {s2.isoformat()}")
    absent = raw.get("absent_days", [])
    if not isinstance(absent, list):
        raise QuotaError("absent_days phải là list")
    status = raw.get("status", "")
    return {"status": status if isinstance(status, str) else "",
            "phases": out,
            "absent_days": frozenset(_iso(d, "absent_days") for d in absent)}


def cap_for(day: date, quota: dict) -> int | None:
    """Trần quyết định/ngày của 1 người duyệt; ngày vắng → 0; không phase
    nào phủ → None."""
    if day in quota["absent_days"]:
        return 0
    for start, end, cap in quota["phases"]:
        if start <= day and (end is None or day <= end):
            return cap
    return None


def collect(conn, today: date, days: int) -> dict:
    """CHỈ SELECT. → {today, days, start, queue{vao_hang, tra_tac_gia,
    khong_ro}, queue_total, oldest_age_days, inflow{date: n},
    throughput{date: {who: n}}}."""
    start = today - timedelta(days=days - 1)
    queue = {"vao_hang": 0, "tra_tac_gia": 0, "khong_ro": 0}
    oldest = None
    for g, n, d in conn.execute(SQL_QUEUE).fetchall():
        queue[g] = n
        if g != "tra_tac_gia" and d is not None:
            oldest = d if oldest is None else min(oldest, d)
    inflow = {d: n for d, n in
              conn.execute(SQL_INFLOW, (start, today)).fetchall()}
    tp: dict = {}
    for d, who, n in conn.execute(SQL_THROUGHPUT, (start, today)).fetchall():
        # Tên in ra terminal: thay ký tự điều khiển (chống chèn ANSI/dòng
        # giả vào báo cáo — OWASP A09); trùng sau thay thì cộng dồn.
        who = _CTRL_RE.sub("?", who)
        day = tp.setdefault(d, {})
        day[who] = day.get(who, 0) + n
    return {"today": today, "days": days, "start": start, "queue": queue,
            "queue_total": queue["vao_hang"] + queue["khong_ro"],
            "oldest_age_days": None if oldest is None else (today - oldest).days,
            "inflow": inflow, "throughput": tp}


def warnings(stats: dict, quota: dict, today: date) -> list[str]:
    out = []
    cap = cap_for(today, quota)
    n = stats["queue_total"]
    if today in quota["absent_days"] and n > 0:
        out.append(f"CẢNH BÁO: người duyệt vắng hôm nay — {n} mục pending "
                   "giữ nguyên, không ai được duyệt thay")
    elif cap is not None and n > cap:
        need = "∞ (trần 0)" if cap == 0 else f"≥ {math.ceil(n / cap)} ngày"
        out.append(f"QUÁ TẢI: hàng chờ {n} mục > trần {cap}/ngày — cần "
                   f"{need} duyệt")
    for d in sorted(stats["throughput"]):
        dcap = cap_for(d, quota)
        for who, k in sorted(stats["throughput"][d].items()):
            if dcap is not None and k > dcap:
                out.append(f"QUÁ TẢI: {who} {k} quyết định ngày "
                           f"{d.isoformat()} > trần {dcap} — vượt trần, rủi "
                           "ro duyệt vội")
    avg = sum(stats["inflow"].values()) / stats["days"]
    if cap is not None and avg > cap:
        out.append(f"CẢNH BÁO: nháp vào TB {avg:.1f}/ngày > trần {cap} — "
                   "nháp vào nhanh hơn trần — giảm volume, không hạ chuẩn (§2)")
    return out


def render(stats: dict, quota: dict, today: date) -> str:
    cap = cap_for(today, quota)
    q = stats["queue"]
    lines = [(f"# Tải hàng duyệt — {today.isoformat()} (cửa sổ "
             f"{stats['start'].isoformat()}..{today.isoformat()}, giờ VN)")]
    if quota["status"] != "chot":
        lines.append("Quota ĐỀ XUẤT, chưa TGĐ chốt (plan_legal_hr §2).")
    lines.append(f"Trần hôm nay/người: {'không có phase' if cap is None else cap}")
    lines.append(f"Hàng chờ: vào hàng {q['vao_hang']} · KHÔNG RÕ "
                 f"{q['khong_ro']} (tính vào hàng) · trả tác giả "
                 f"{q['tra_tac_gia']} (không tính quota) → tính quota "
                 f"{stats['queue_total']}")
    age = stats["oldest_age_days"]
    lines.append("Mục chờ cũ nhất: "
                 + ("—" if age is None else f"{age} ngày"))
    total_in = sum(stats["inflow"].values())
    lines.append(f"Nháp vào: {total_in} trong {stats['days']} ngày "
                 f"(TB {total_in / stats['days']:.1f}/ngày)")
    lines.append("Quyết định duyệt theo ngày/người:")
    if not stats["throughput"]:
        lines.append("  (không có)")
    for d in sorted(stats["throughput"]):
        for who, k in sorted(stats["throughput"][d].items()):
            lines.append(f"  {d.isoformat()} {who}: {k}")
    warns = warnings(stats, quota, today)
    lines.append("")
    lines += warns or ["Không có cảnh báo tải."]
    lines.append("(Chỉ nhắc — không phân việc, không đổi trạng thái; người "
                 "duyệt quyết.)")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--today", help="YYYY-MM-DD (mặc định hôm nay giờ VN)")
    ap.add_argument("--days", type=int, default=7, help="cửa sổ 1..366 ngày")
    ap.add_argument("--quota", default=str(DEFAULT_QUOTA))
    a = ap.parse_args(argv)
    try:
        today = (_iso(a.today, "--today") if a.today is not None
                 else datetime.now(VN_TZ).date())
        if not 1 <= a.days <= MAX_DAYS:
            raise QuotaError(f"--days phải trong 1..{MAX_DAYS}")
        quota = load_quota(a.quota)
        if cap_for(today, quota) is None:
            raise QuotaError(f"không phase quota nào phủ {today.isoformat()}")
    except ValueError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 2
    conn = lead_store.connect()
    if conn is None:
        print("[err] DB không truy cập được", file=sys.stderr)
        return 1
    try:
        stats = collect(conn, today, a.days)
    except psycopg.Error as e:
        print(f"[err] DB không truy cập được ({type(e).__name__})",
              file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(render(stats, quota, today), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
