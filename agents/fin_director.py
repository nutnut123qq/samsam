"""v9.1 FIN-Director (WP12) — bản tin TUẦN cho GĐ tài chính: gom công nợ đại
lý quá hạn (ACC-AR v9.0) + P&L tháng (FP-COGS-PnL) + chi phí vận hành so
trần (FP-OpsCost) + dòng tiền 13 tuần (FP-Cash) + số đề xuất ngân sách ads
đang chờ duyệt (FP-AdsBudget) → `pipelines.director.run(..., extra=...)` →
`data/reports/director-finance-<ngày>.md` (gitignored). KHÔNG gửi, KHÔNG
LLM/mạng — chỉ gọi lại hàm của các agent nhân viên, không chép công thức.

Thứ tự mục cố định (trước "## Người duyệt" của khuôn director):
  ## Công nợ đại lý quá hạn · ## P&L tháng <MM/YYYY> · ## Chi phí vận hành
  tháng <MM/YYYY> · ## Dòng tiền <N> tuần · ## Đề xuất ngân sách ads
Mỗi mục lỗi dữ liệu (cấu hình thiếu mục, bảng trống/thiếu, giả định hỏng)
→ mục đó ghi "(chưa có dữ liệu: <lý do ngắn>)", bản tin vẫn ra. File
`data/fpa_config.json` hỏng JSON → exit 1 trước connect.

Cùng tên file với `python -m agents.acc_ar --bulletin` (bản hằng ngày, chỉ
mục công nợ): bản tuần là SUPERSET — chạy sau sẽ ghi đè bản trước cùng ngày.

Chạy:
  python -m agents.fin_director --weekly [--as-of YYYY-MM-DD]
Exit: 0 ok · 1 cấu hình lỗi / ghi file lỗi · 2 tham số sai / DB down.
"""

import argparse
import json
import sys
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path

import psycopg

from agents import acc_ar, fp_cash, fp_opscost, fp_pnl
from agents.fp_pnl import NO_COGS, vnd
from agents.report import REPORTS_DIR
from ingest.lead_store import connect
from pipelines import director
from pipelines.auth import load_users
from pipelines.period import VN_TZ, vn_date
from pipelines.scenario import ScenarioError
from pipelines.store import _db_msg, _oneline

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

H_AR = "## Công nợ đại lý quá hạn"
H_ADS = "## Đề xuất ngân sách ads"
_ERRORS = (psycopg.Error, ValueError, KeyError, TypeError, ScenarioError)


def nodata(heading: str, why: str) -> list[str]:
    return [heading, "", f"(chưa có dữ liệu: {_oneline(why, 120)})"]


def h_pnl(month: date) -> str:
    return f"## P&L tháng {month:%m/%Y}"


def h_ops(month: date) -> str:
    return f"## Chi phí vận hành tháng {month:%m/%Y}"


def h_cash(weeks: int) -> str:
    return f"## Dòng tiền {weeks} tuần"


# ---------- mục bản tin (thuần) ----------

def pnl_section(res: dict) -> list[str]:
    m = res["month"]
    loai = res["loai"]
    return [h_pnl(m), "",
            (f"- Tổng thực nhận: {vnd(res['tong_thuc_nhan'])} "
             f"({res['n_rows']} dòng quyết toán trong tháng)"),
            (f"- Tổng lãi gộp (chỉ ô có giá vốn duyệt): "
             f"{vnd(res['tong_lai_gop'])}"),
            (f"- {len(loai)} SKU {NO_COGS}: "
             + (", ".join(f"`{s}`" for s in loai) if loai else "(không có)")),
            (f"- BẢN NHÁP — chi tiết: `python -m agents.fp_pnl --pnl --month "
             f"{m:%Y-%m}`")]


def ops_section(month: date, s: dict, cfg: dict) -> list[str]:
    L = [h_ops(month), ""]
    L += [(f"- [{a['label']} {a['level']}%] `{a['scope']}`: "
           f"{vnd(a['spent'])} / trần {vnd(a['budget'])}")
          for a in s["alerts"]] or [
        (f"- Không phạm vi nào chạm {cfg['warn_pct']}%/{cfg['stop_pct']}% "
         "trần")]
    wait = sum(st == "cho_tgd_ky" for _, st in s["over"])
    L += [(f"- Khoản > ngưỡng X ({vnd(cfg['threshold_x_vnd'])}) đang chờ TGĐ "
           f"ký: {wait}"),
          ("- Trần/ngưỡng là GIẢ ĐỊNH (`data/fpa_config.json`) — agent không "
           "chi, không tắt key")]
    return L


def cash_section(fc: dict) -> list[str]:
    weeks = fc["weeks"]
    warn = fc["warn_weeks"]
    last = weeks[-1]["close"]
    L = [h_cash(len(weeks)), "",
         (f"- Tuần đầu tiên số dư kịch bản thấp < "
          f"{vnd(fc['min_balance_vnd'])}: "
          + (f"{warn[0]:%d/%m/%Y}" if warn else "(không có)")),
         f"- Số tuần âm ở kịch bản thấp: {len(warn)}/{len(weeks)}",
         (f"- Số dư cuối kỳ (tuần {weeks[-1]['week_start']:%d/%m}): thấp "
          f"{vnd(last['low'])} · cơ sở {vnd(last['base'])} · cao "
          f"{vnd(last['high'])}")]
    if fc["opening"] is None:
        L.append(f"- {fp_cash.NO_OPENING}")
    L.append("- Khoảng trên GIẢ ĐỊNH — chi tiết: `python -m agents.fp_cash "
             "--forecast`")
    return L


def ads_section(n_pending: int) -> list[str]:
    return [H_ADS, "",
            (f"- Mục `budget_change` đang chờ duyệt: {n_pending} — ĐỀ XUẤT, "
             "agent không chi tiền; duyệt qua `python -m "
             "pipelines.approval_queue`")]


# ---------- gom (DB) ----------

def _safe(conn, heading: str, fn) -> list[str]:
    """Chạy 1 mục trong savepoint — lỗi → '(chưa có dữ liệu)' (tx ngoài
    không bị hỏng)."""
    try:
        with conn.transaction():
            return fn()
    except _ERRORS as e:
        why = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        return nodata(heading, why or type(e).__name__)


def build_extra(conn, as_of: date) -> list[str]:
    month = as_of.replace(day=1)

    def ar():
        cfg, why = acc_ar.load_config()
        if cfg is None:
            raise ValueError(why)
        rows = acc_ar.aging(acc_ar.fetch_entries(conn), as_of,
                            cfg["term_days"])
        return acc_ar.overdue_section(rows, as_of)

    def pnl():
        return pnl_section(fp_pnl.compute(conn, month))

    def ops():
        cfg, why = fp_opscost.load_cfg()
        if cfg is None:
            raise ValueError(why)
        return ops_section(month, fp_opscost.summary(conn, month, cfg,
                                                     load_users()), cfg)

    weeks = 13

    def cash():
        cfg, a, golden = fp_cash.load_inputs()
        fc = fp_cash.run(fp_cash.measure(conn, as_of), as_of,
                         cfg["opening_balance_vnd"], cfg, a, golden)
        return cash_section(fc)

    cfg, _ = fp_cash.load_cfg()
    if cfg is not None:
        weeks = cfg["weeks"]

    def ads():
        n = conn.execute(
            "select count(*) from approval_queue where block = 'finance' and"
            " object_type = 'budget_change' and status = 'pending'"
        ).fetchone()[0]
        return ads_section(n)

    out: list[str] = []
    for heading, fn in ((H_AR, ar), (h_pnl(month), pnl), (h_ops(month), ops),
                        (h_cash(weeks), cash), (H_ADS, ads)):
        if out:
            out.append("")
        out += _safe(conn, heading, fn)
    return out


def weekly(conn, as_of: date, now: datetime, out_dir: Path | None = None,
           dcfg: dict | None = None):
    """→ (path, text) — bản tin GĐ tài chính kèm 5 mục FP&A/kế toán."""
    extra = build_extra(conn, as_of)
    return director.run(conn, "finance", now, cfg=dcfg,
                        out_dir=out_dir or REPORTS_DIR, extra=extra)


# ---------- CLI ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.fin_director",
        description="FIN-Director: bản tin tuần GĐ tài chính (BẢN NHÁP, "
                    "không tự gửi)")
    ap.add_argument("--weekly", action="store_true")
    ap.add_argument("--as-of", help="ngày chốt YYYY-MM-DD (mặc định hôm nay "
                                    "VN)")
    args = ap.parse_args(argv)
    if not args.weekly:
        ap.error("cần --weekly")
    now = datetime.now(VN_TZ)
    as_of = vn_date(now)
    if args.as_of is not None:
        try:
            as_of = date.fromisoformat(args.as_of)
        except ValueError:
            ap.error("--as-of phải dạng YYYY-MM-DD")
        if as_of != vn_date(now):
            now = datetime(as_of.year, as_of.month, as_of.day, 12,
                           tzinfo=VN_TZ)
    try:
        raw = json.loads(fp_pnl.CONFIG_FILE.read_bytes().decode("utf-8"))
        if not isinstance(raw, dict):
            raise TypeError("không phải object")
    except (OSError, ValueError, TypeError) as e:
        print(f"[err] {fp_pnl.CONFIG_FILE.name} hỏng ({type(e).__name__}) — "
              "không connect.", flush=True)
        return 1
    try:
        dcfg = director.load_config("finance")
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối finance: {e} — không connect.")
        return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        path, text = weekly(conn, as_of, now, REPORTS_DIR, dcfg)
        n_nodata = text.count("(chưa có dữ liệu:")
        print(f"[weekly] bản tin GĐ tài chính tính tới {as_of} → {path.name}"
              f" (BẢN NHÁP, không tự gửi; {n_nodata} mục chưa có dữ liệu)")
        return 0
    except (psycopg.Error, OSError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else type(e).__name__
        print(f"[error] {type(e).__name__}: {msg}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
