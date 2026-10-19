"""v9.1 FP-COGS-PnL (WP12) — giá vốn theo SKU có ngày hiệu lực (người lập ≠
người duyệt, chặn ở DB) + P&L SKU × kênh × tháng từ thực nhận quyết toán
sàn. Tất định Python/SQL, KHÔNG LLM/mạng, KHÔNG gửi, KHÔNG bút toán.

Ownership: ghi DUY NHẤT `cogs_versions` (INSERT dòng chưa duyệt; duyệt qua
function `approve_cogs`); chỉ ĐỌC `settlement_rows` + `recon_results` (v9.0),
`market_rows` (v3.3), `sku_master`. Báo cáo P&L → `data/reports/pnl-<YYYY-
MM>.md` (gitignored) — BẢN NHÁP tới khi GĐ tài chính ký; lọc `--channel K`
→ file riêng `pnl-<YYYY-MM>-<K>.md` (không đè bản toàn kênh).

Hàm thuần (thời gian là tham số — chỉ CLI đọc đồng hồ):
  - `cogs_at(versions, sku_key, day)`: dòng ĐÃ duyệt có `valid_from` lớn
    nhất ≤ day (hòa → id lớn nhất); không có → None (KHÔNG suy, KHÔNG 0).
  - `allocate(total, weights)`: phân bổ tỉ lệ ROUND_HALF_UP, phần dư dồn
    phần tử cuối → tổng giữ chính xác; weights toàn 0 → chia đều.
  - `pnl(rows, lines, versions, month, channel=None)`: channel → lọc dòng
    quyết toán TRƯỚC khi tính (mọi số đếm theo đúng kênh). rows = dòng
    quyết toán (+ nhãn đối soát), lines = dòng đơn sàn của snapshot
    `order` MỚI NHẤT chứa mã đơn
    (cùng quy tắc `ingest.settlement_csv._ORDER_SQL`). Mỗi dòng quyết toán
    phân bổ theo trọng số `price_vnd × qty`: doanh_thu, khau_tru_san, hoan,
    thuc_nhan; giá vốn = Σ qty × giá vốn đã duyệt tại `settled_on`. Ô thiếu
    giá vốn → gia_von/lai_gop/bien_gop_pct None + "chưa có giá vốn duyệt".
    Dòng không thấy đơn / dòng đơn không map SKU → ô "(chưa rõ SKU)" chỉ có
    thuc_nhan. GIẢ ĐỊNH thận trọng: dòng hoàn vẫn tính giá vốn theo qty đơn
    (hàng hoàn nhập kho lại chưa có nguồn).

Chạy:
  python -m agents.fp_pnl --cogs-add --sku K --cost N --from YYYY-MM-DD --by "Tên" [--note ..]
  python -m agents.fp_pnl --cogs-approve ID --by "Tên" [--note ..]
  python -m agents.fp_pnl --cogs-list
  python -m agents.fp_pnl --pnl --month YYYY-MM [--channel shopee|tiktok]
Exit: 0 ok · 1 dữ liệu/DB lỗi, duyệt bị từ chối · 2 tham số sai / DB down.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import _safe, _to_int
from ingest.settlement_csv import CHANNELS, overlaps, round_half_up
from pipelines.period import VN_TZ, period_bounds, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "fpa_config.json"
UNKNOWN_SKU = "(chưa rõ SKU)"
NO_COGS = "chưa có giá vốn duyệt"
DRAFT_HEAD = "BẢN NHÁP — chỉ thành chính thức khi GĐ tài chính ký"
MAX_BY = 100
COST_CAP = 10**12
_MONTH_RE = re.compile(r"([0-9]{4})-(0[1-9]|1[0-2])")
_SKU_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
# khoản sàn trừ (dương = sàn trừ, âm = sàn bù — đã chuẩn hóa ở v9.0)
_DEDUCT = ("fixed_fee_vnd", "payment_fee_vnd", "service_fee_vnd",
           "shipping_fee_vnd", "voucher_seller_vnd", "affiliate_vnd")


# ---------- dùng chung FP&A (fp_ads / fp_opscost / fp_cash / fin_director) --

def vnd(n) -> str:
    return f"{int(n):,}".replace(",", ".") + "đ"


def parse_month(s) -> date | None:
    """'YYYY-MM' → ngày 1 của tháng; sai → None (CLI → exit 2)."""
    m = _MONTH_RE.fullmatch(s) if isinstance(s, str) else None
    return date(int(m[1]), int(m[2]), 1) if m else None


def read_config(section: str, path: Path | None = None
                ) -> tuple[dict | None, str | None]:
    """Đọc 1 mục của `data/fpa_config.json` (mục chưa validate) → (dict,
    None) | (None, lý do). File hỏng / thiếu mục → lý do (caller exit 1
    trước connect)."""
    p = path or CONFIG_FILE
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, f"không đọc được {p.name}: {type(e).__name__}"
    sec = raw.get(section) if isinstance(raw, dict) else None
    if not isinstance(sec, dict):
        return None, f"{p.name}: thiếu mục '{section}'"
    return sec, None


def frac(v, where: str) -> tuple[Decimal | None, str | None]:
    """Số 0..1 (không bool) → Decimal."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None, f"{where}: phải là số 0..1"
    d = Decimal(str(v))
    if not Decimal(0) <= d <= Decimal(1):
        return None, f"{where}: ngoài 0..1"
    return d, None


def is_int(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


# ---------- hàm thuần ----------

def cogs_at(versions: list[dict], sku_key: str, day: date) -> int | None:
    best = None
    for v in versions:
        if v["sku_key"] != sku_key or not (v.get("approved_by") or "").strip():
            continue
        if v["valid_from"] > day:
            continue
        k = (v["valid_from"], v["id"])
        if best is None or k > best[0]:
            best = (k, v["cost_vnd"])
    return None if best is None else best[1]


def allocate(total: int, weights: list[int]) -> list[int]:
    if not weights:
        if total:
            raise ValueError("allocate: không có phần tử để phân bổ")
        return []
    ws = list(weights) if any(weights) else [1] * len(weights)
    s = Decimal(sum(ws))
    out = [round_half_up(Decimal(total) * Decimal(w) / s) for w in ws[:-1]]
    return out + [total - sum(out)]


def _bien(lai: int, dt_: int) -> Decimal | None:
    if not dt_:
        return None
    return (Decimal(lai) * 100 / Decimal(dt_)).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP)


def pnl(rows: list[dict], lines: list[dict], versions: list[dict],
        month: date, channel: str | None = None) -> dict:
    """→ {"month", "channel", "cells": [..], "tong_thuc_nhan",
    "tong_lai_gop", "loai": [sku_key...], "n_rows", "thieu_ngay",
    "thieu_chung_tu", "hoan"}. Ô = (sku_key, channel). `channel` lọc dòng
    quyết toán trước khi tính → số đếm (dòng/thiếu chứng từ/hoàn/thiếu
    ngày) khớp đúng kênh lọc, không lẫn kênh khác."""
    start, end = (d.date() for d in period_bounds("month", month))
    if channel is not None:
        rows = [r for r in rows if r["channel"] == channel]
    by_order: dict = {}
    for ln in sorted(lines, key=lambda x: x["row_no"]):
        by_order.setdefault((ln["channel"], ln["order_id_hash"]), []).append(
            ln)
    cells: dict = {}

    def cell(sku, ch):
        return cells.setdefault((sku, ch), {
            "sku_key": sku, "channel": ch, "doanh_thu": 0, "khau_tru_san": 0,
            "hoan": 0, "thuc_nhan": 0, "gia_von": 0, "thieu_gia_von": False,
            "so_dong": 0})

    out = {"month": month, "channel": channel, "n_rows": 0, "thieu_ngay": 0,
           "thieu_chung_tu": 0, "hoan": 0, "tong_thuc_nhan": 0}
    for r in rows:
        day = r.get("settled_on")
        if day is None:
            out["thieu_ngay"] += 1
            continue
        if not start <= day < end:
            continue
        out["n_rows"] += 1
        out["tong_thuc_nhan"] += r["payout_vnd"]
        out["hoan"] += r.get("label") == "hoan"
        ls = by_order.get((r["channel"], r["order_id_hash"]))
        if not ls:
            out["thieu_chung_tu"] += 1
            c = cell(UNKNOWN_SKU, r["channel"])
            c["thuc_nhan"] += r["payout_vnd"]
            c["so_dong"] += 1
            continue
        w = [ln["price_vnd"] * ln["qty"] for ln in ls]
        parts = {
            "doanh_thu": allocate(r["order_amount_vnd"], w),
            "khau_tru_san": allocate(sum(r[f] for f in _DEDUCT), w),
            "hoan": allocate(r["refund_vnd"], w),
            "thuc_nhan": allocate(r["payout_vnd"], w)}
        for i, ln in enumerate(ls):
            sku = ln["sku_key"] or UNKNOWN_SKU
            c = cell(sku, r["channel"])
            c["so_dong"] += 1
            if sku == UNKNOWN_SKU:
                c["thuc_nhan"] += parts["thuc_nhan"][i]
                continue
            for k, v in parts.items():
                c[k] += v[i]
            if ln["qty"]:
                cost = cogs_at(versions, sku, day)
                if cost is None:
                    c["thieu_gia_von"] = True
                else:
                    c["gia_von"] += ln["qty"] * cost
    res, loai, tong_lai = [], set(), 0
    for (sku, ch), c in sorted(cells.items()):
        if sku == UNKNOWN_SKU:
            c.update(doanh_thu=None, khau_tru_san=None, hoan=None,
                     gia_von=None, lai_gop=None, bien_gop_pct=None, nhan=None)
        elif c["thieu_gia_von"]:
            loai.add(sku)
            c.update(gia_von=None, lai_gop=None, bien_gop_pct=None,
                     nhan=NO_COGS)
        else:
            c["lai_gop"] = c["thuc_nhan"] - c["gia_von"]
            c["bien_gop_pct"] = _bien(c["lai_gop"], c["doanh_thu"])
            c["nhan"] = None
            tong_lai += c["lai_gop"]
        del c["thieu_gia_von"]
        res.append(c)
    out.update(cells=res, tong_lai_gop=tong_lai, loai=sorted(loai))
    return out


def _m(v) -> str:
    return "—" if v is None else vnd(v)


def render(result: dict) -> str:
    """Markdown P&L — chỉ sku_key/kênh/số tiền (không mã đơn/hash/tên).
    Kênh lọc lấy từ `result` (đã lọc trong `pnl`) — số đếm luôn cùng phạm
    vi với tổng tiền."""
    m = result["month"]
    channel = result.get("channel")
    cells = result["cells"]
    L = [f"# P&L theo SKU × kênh — tháng {m:%m/%Y}", "", f"**{DRAFT_HEAD}.**",
         "", ("Nguồn: thực nhận quyết toán sàn (`settlement_rows`, theo ngày "
              "quyết toán giờ VN) phân bổ theo dòng đơn sàn; giá vốn = dòng "
              "ĐÃ duyệt (`cogs_versions`) hiệu lực tại ngày quyết toán."
              + (f" Lọc kênh: {channel}." if channel else "")), "",
         ("| SKU | Kênh | Doanh thu | Khấu trừ sàn | Hoàn | Thực nhận | "
          "Giá vốn | Lãi gộp | Biên gộp |"),
         "|---|---|---|---|---|---|---|---|---|"]
    for c in cells:
        cost = NO_COGS if c["nhan"] else _m(c["gia_von"])
        bien = ("—" if c["bien_gop_pct"] is None
                else f"{c['bien_gop_pct']}%")
        L.append(f"| `{c['sku_key']}` | {c['channel']} | {_m(c['doanh_thu'])}"
                 f" | {_m(c['khau_tru_san'])} | {_m(c['hoan'])} | "
                 f"{vnd(c['thuc_nhan'])} | {cost} | {_m(c['lai_gop'])} | "
                 f"{bien} |")
    if not cells:
        L.append("| (không có dòng quyết toán trong tháng) | | | | | | | | |")
    tn = sum(c["thuc_nhan"] for c in cells)
    lai = sum(c["lai_gop"] for c in cells if c["lai_gop"] is not None)
    loai = sorted({c["sku_key"] for c in cells if c["nhan"]})
    L += ["", f"- Tổng thực nhận: {vnd(tn)} ({result['n_rows']} dòng quyết "
          "toán trong tháng" + ("" if channel else
                                " — khớp tổng thực nhận ACC-Recon") + ")",
          f"- Tổng lãi gộp (chỉ ô có giá vốn duyệt): {vnd(lai)}",
          (f"- {len(loai)} SKU bị loại vì {NO_COGS}: "
           + (", ".join(f"`{s}`" for s in loai) if loai else "(không có)")),
          (f"- Dòng chưa thấy đơn sàn (vào ô {UNKNOWN_SKU}): "
           f"{result['thieu_chung_tu']}; dòng hoàn: {result['hoan']}"),
          (f"- Dòng thiếu ngày quyết toán (không vào tháng nào): "
           f"{result['thieu_ngay']}"),
          ("- GIẢ ĐỊNH thận trọng: dòng hoàn vẫn tính giá vốn theo số lượng "
           "đơn (hàng hoàn nhập kho lại chưa có nguồn)."),
          ("- Chưa có doanh thu đại lý/B2B (MISA — external-dep): P&L chỉ "
           "kênh sàn.")]
    for ch, o in sorted((result.get("chong_ky") or {}).items()):
        L.append(f"- **BẤT THƯỜNG** {ch}: khoản quyết toán xuất lại ở ≥2 file"
                 f" (chồng kỳ) — trùng nguyên văn {o['trung']} (tính 1 lần),"
                 f" lệch số {o['lech']} (giữ cả hai, chờ người đối soát): "
                 + ", ".join(_safe(f, 80).replace("|", "/")
                             for f in o["files"]))
    L.append("")
    return "\n".join(L)


# ---------- DB ----------

_V_COLS = ("id", "sku_key", "cost_vnd", "valid_from", "approved_by")
_R_COLS = ("id", "channel", "order_id_hash", "order_amount_vnd", *_DEDUCT,
           "refund_vnd", "payout_vnd", "settled_on", "label")
# Dòng đơn của snapshot `order` MỚI NHẤT chứa mã đơn — CÙNG quy tắc
# `settlement_csv._ORDER_SQL` (test khóa Σ trọng số == order_amount_vnd
# của recon_results).
_LINES_SQL = (
    "with latest as (select distinct on (channel, order_id_hash) channel,"
    " order_id_hash, snapshot_id from market_rows where export_kind ="
    " 'order' and order_id_hash = any(%s) order by channel, order_id_hash,"
    " snapshot_id desc) select m.channel, m.order_id_hash, m.row_no,"
    " m.sku_key, coalesce(m.qty, 0), coalesce(m.price_vnd, 0) from latest l"
    " join market_rows m on m.snapshot_id = l.snapshot_id and m.channel ="
    " l.channel and m.order_id_hash = l.order_id_hash and m.export_kind ="
    " 'order' order by m.channel, m.order_id_hash, m.row_no")


def fetch_versions(conn) -> list[dict]:
    return [dict(zip(_V_COLS, r)) for r in conn.execute(
        "select " + ", ".join(_V_COLS) + " from cogs_versions order by id")]


def fetch_rows(conn, month: date) -> list[dict]:
    """Khoản quyết toán trong tháng (giờ VN) + dòng thiếu ngày — đọc view
    `v_settlement_khoan` (bản xuất lại nguyên văn ở file khác tính 1 lần,
    v13.2 — cùng số với `agents.rev_share`/BKS/view Bên A)."""
    start, end = (d.date() for d in period_bounds("month", month))
    cols = ", ".join(f"s.{c}" for c in _R_COLS[:-1])
    return [dict(zip(_R_COLS, r)) for r in conn.execute(
        f"select {cols}, r.label from v_settlement_khoan s left join"
        " recon_results r on r.settlement_row_id = s.id where"
        " (s.settled_on >= %s and s.settled_on < %s) or s.settled_on is null"
        " order by s.id", (start, end))]


def fetch_lines(conn, hashes: list[str]) -> list[dict]:
    if not hashes:
        return []
    return [dict(zip(("channel", "order_id_hash", "row_no", "sku_key", "qty",
                      "price_vnd"), r))
            for r in conn.execute(_LINES_SQL, (sorted(set(hashes)),))]


def compute(conn, month: date, channel: str | None = None) -> dict:
    rows = fetch_rows(conn, month)
    lines = fetch_lines(conn, [r["order_id_hash"] for r in rows])
    res = pnl(rows, lines, fetch_versions(conn), month, channel)
    start, end = (d.date() for d in period_bounds("month", month))
    res["chong_ky"] = overlaps(conn, [channel] if channel else CHANNELS,
                               start, end)
    return res


def add_cogs(conn, sku: str, cost: int, valid_from: date, by: str,
             note: str | None = None) -> int | None:
    """INSERT dòng chưa duyệt (không commit) → id | None khi SKU không có
    trong sku_master."""
    if not conn.execute("select 1 from sku_master where sku_key = %s",
                        (sku,)).fetchone():
        return None
    return conn.execute(
        "insert into cogs_versions (sku_key, cost_vnd, valid_from,"
        " created_by, note) values (%s, %s, %s, %s, %s) returning id",
        (sku, cost, valid_from, by, note)).fetchone()[0]


def approve(conn, cogs_id: int, by: str, note: str | None = None
            ) -> tuple[bool, str | None]:
    """Gọi `approve_cogs` (savepoint + commit) → (True, None) | (False,
    thông điệp tiếng Việt của function)."""
    try:
        with conn.transaction():
            conn.execute("select approve_cogs(%s, %s, %s)",
                         (cogs_id, by, note))
        conn.commit()
    except psycopg.Error as e:
        return False, _db_msg(e)
    return True, None


# ---------- CLI ----------

def _by(ap, s: str | None, flag: str) -> str:
    by = (s or "").strip()
    if not by or len(by) > MAX_BY or not by.isprintable():
        ap.error(f"{flag} cần tên người (1..{MAX_BY} ký tự in được)")
    return by


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.fp_pnl",
        description="FP-COGS-PnL: giá vốn (người lập ≠ người duyệt) + P&L "
                    "SKU × kênh × tháng (BẢN NHÁP)")
    ap.add_argument("--cogs-add", action="store_true")
    ap.add_argument("--cogs-approve", type=int, metavar="ID")
    ap.add_argument("--cogs-list", action="store_true")
    ap.add_argument("--pnl", action="store_true")
    ap.add_argument("--sku")
    ap.add_argument("--cost", help="giá vốn VND / đơn vị (số nguyên > 0)")
    ap.add_argument("--from", dest="valid_from", help="hiệu lực từ YYYY-MM-DD")
    ap.add_argument("--by", help="người lập (--cogs-add) / người duyệt "
                                 "(--cogs-approve)")
    ap.add_argument("--note")
    ap.add_argument("--month", help="YYYY-MM")
    ap.add_argument("--channel", choices=CHANNELS)
    args = ap.parse_args(argv)

    n_ops = sum([args.cogs_add, args.cogs_approve is not None,
                 args.cogs_list, args.pnl])
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--cogs-add | --cogs-approve | "
                 "--cogs-list | --pnl)")
    if n_ops == 0:
        ap.error("cần --cogs-add | --cogs-approve ID | --cogs-list | --pnl")
    if (args.sku or args.cost or args.valid_from) and not args.cogs_add:
        ap.error("--sku/--cost/--from chỉ dùng với --cogs-add")
    if args.by and not (args.cogs_add or args.cogs_approve is not None):
        ap.error("--by chỉ dùng với --cogs-add/--cogs-approve")
    if (args.month or args.channel) and not args.pnl:
        ap.error("--month/--channel chỉ dùng với --pnl")
    note = (args.note or "").strip() or None
    if note and (len(note) > 200 or not note.isprintable()):
        ap.error("--note tối đa 200 ký tự in được")
    if args.cogs_add:
        if not args.sku or not _SKU_RE.fullmatch(args.sku):
            ap.error("--sku phải là sku_key golden (vd savina-12v)")
        cost = _to_int(args.cost, COST_CAP)
        if not cost:
            ap.error("--cost phải là số nguyên VND > 0")
        try:
            valid_from = date.fromisoformat(args.valid_from or "")
        except ValueError:
            ap.error("--from phải dạng YYYY-MM-DD")
        by = _by(ap, args.by, "--by")
    if args.cogs_approve is not None:
        by = _by(ap, args.by, "--by")
    month = None
    if args.pnl:
        month = parse_month(args.month)
        if month is None:
            ap.error("--pnl cần --month YYYY-MM (tháng 01..12)")

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.cogs_add:
            cid = add_cogs(conn, args.sku, cost, valid_from, by, note)
            if cid is None:
                print(f"[err] SKU '{args.sku}' không có trong sku_master — "
                      "nạp golden trước.")
                return 1
            conn.commit()
            print(f"[cogs-add] giá vốn #{cid}: {args.sku} {vnd(cost)} từ "
                  f"{valid_from} — CHỜ DUYỆT (người duyệt phải khác người "
                  "lập).")
            return 0
        if args.cogs_approve is not None:
            # v14.2: GĐ tài chính được Bên B ủy quyền (auth.cli_gate) — DB
            # function `approve_cogs` vẫn chặn người lập tự duyệt.
            from pipelines import auth  # lười: auth → director → ...
            why = auth.cli_gate(conn, by, "finance", "approve",
                                "cogs_versions", args.cogs_approve)
            if why:
                conn.rollback()
                print(f"[err] giá vốn #{args.cogs_approve}: {why}")
                return 1
            ok, msg = approve(conn, args.cogs_approve, by, note)
            if not ok:
                print(f"[err] giá vốn #{args.cogs_approve}: {msg}")
                return 1
            print(f"[cogs-approve] giá vốn #{args.cogs_approve} đã duyệt.")
            return 0
        if args.cogs_list:
            vs = fetch_versions(conn)
            conn.commit()
            today = vn_date(datetime.now(VN_TZ))
            print(f"[cogs-list] giá vốn ĐÃ duyệt hiệu lực ngày {today} + dòng"
                  " chờ duyệt:")
            for sku in sorted({v["sku_key"] for v in vs}):
                c = cogs_at(vs, sku, today)
                print(f"  {sku}: " + (vnd(c) if c is not None else NO_COGS))
            for v in vs:
                if not (v["approved_by"] or "").strip():
                    print(f"  [chờ duyệt] #{v['id']} {v['sku_key']} "
                          f"{vnd(v['cost_vnd'])} từ {v['valid_from']}")
            return 0
        res = compute(conn, month, args.channel)
        conn.commit()
        text = render(res)
        # Lọc kênh → file riêng: KHÔNG đè bản P&L toàn kênh GĐ tài chính ký.
        suffix = f"-{args.channel}" if args.channel else ""
        # P8.4: quyết toán/đơn sàn từ file xuất + giá vốn người duyệt — bảng
        # nguồn không có cột mẫu (settlement_rows/market_rows).
        path = write_report(text, REPORTS_DIR,
                            f"pnl-{month:%Y-%m}{suffix}.md", sample=False)
        print(text)
        print(f"[pnl] → {path.name} (BẢN NHÁP, không tự gửi)")
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
