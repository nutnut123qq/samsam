"""v12.5 B5 — doanh thu thuần trực tuyến + biên bản đối soát quý (HĐ hợp tác
Điều 7.3, 7.5, 8.3, 9; PL02 mục 4–5). Tất định, KHÔNG LLM/mạng, KHÔNG gửi.

Doanh thu thuần trực tuyến = Gộp − Phí sàn − Hủy − Hoàn, theo ngày quyết
toán `settled_on` trong kỳ (giờ VN):
  - Gộp = Σ `order_amount_vnd` của khoản quyết toán (view
    `v_settlement_khoan` trên `settlement_rows` — file quyết toán sàn kế
    toán xuất tay, v9.0; khoản xuất lại nguyên văn ở file khác tính 1 lần,
    v13.2) thuộc kênh trong `kenh_truc_tuyen`.
  - Phí sàn = Σ các cột `phi_san_cot` (GIẢ ĐỊNH ở `data/rev_share.json`).
  - Hủy = Σ giá trị đơn của dòng quyết toán mà đơn sàn (`orders`, source
    `market:%`, `agents.kd_orders --sync`) có trạng thái `cancelled`; hoàn
    của các dòng đó đã nằm trong Hủy (không trừ 2 lần).
  - Hoàn = Σ `refund_vnd` của các dòng còn lại.
  - Thực nhận trên file (Σ `payout_vnd`) chỉ in để đối chiếu.
THIẾU NGUỒN → "chưa có dữ liệu", KHÔNG suy, KHÔNG coi = 0: kênh không có
dòng quyết toán nào trong kỳ → kênh + tổng chưa có dữ liệu; có dòng chưa
thấy trạng thái đơn → Hủy/Thuần kênh đó + tổng chưa có dữ liệu. Hoàn > Gộp
hoặc Thuần âm → ghi "bất thường", KHÔNG tính phí. Khoản quyết toán xuất
lại ở ≥2 file trong kỳ (`settlement_csv.overlaps`, v13.2 F01) → "bất
thường" kèm tên file — trùng nguyên văn đã tính 1 lần, số khác nhau giữ cả
hai (KHÔNG tự chọn file mới nhất) — KHÔNG tính phí tới khi người đối soát
xử lý. Website/kênh khác: chưa có nguồn (website bán hàng làm riêng sau).

Phí vận hành = round_half_up(Thuần × `ty_le_phi_van_hanh`) — chỉ khi đã
chốt tỷ lệ VÀ `ngay_bat_dau_van_hanh` (Điều 8.1, 9.3); quý chứa ngày bắt
đầu chỉ tính từ ngày đó. `--year N` = năm hợp tác thứ N tính từ
`ngay_ky_hop_dong` (thời hạn hợp tác tính từ ngày ký — Điều 3.1; v13.2 F09:
KHÔNG dùng ngày vận hành, KHÔNG lấy ngày dự kiến), so các mức thưởng PL02
mục 4 (ngưỡng/tỷ lệ null = "chưa chốt"). Hai ngày null = chưa chốt.

XUNG ĐỘT LỢI ÍCH (HĐ Điều 7.6): Bên A vận hành hệ thống này VÀ hưởng phí
tính trên chính số này → mọi số ở đây chỉ là ĐỀ XUẤT; căn cứ duy nhất là
biên bản đối soát quý đã được đại diện 2 bên ký (Điều 8.3). Ô chữ ký để
trống; người của Bên A không tự duyệt quyền lợi của mình.

Ownership: CHỈ ĐỌC `settlement_rows`, `orders`; ghi DUY NHẤT `insert into
revenue_quarters` khi `--record` (append-only — lưu ≥180 ngày, không
sửa/xóa, Điều 7.3). Báo cáo/stdout KHÔNG mã đơn/hash/người mua; tên file
qua `_mask_pii`. Bên A xem số qua role `ben_a_reader` (`docs/roles.sql`).

Chạy:
  python -m agents.rev_share --quarter YYYY-Qn [--record | --dry-run]
      [--now ISO] [--out-dir DIR]   → data/reports/doi-soat-<YYYY-Qn>.md
  python -m agents.rev_share --year N [--dry-run] [--now ISO] [--out-dir DIR]
                                    → data/reports/doi-soat-nam-<N>.md
Exit: 0 ok (kể cả thiếu dữ liệu) · 1 cấu hình hỏng/chưa chốt ngày ký hợp
đồng (--year) · 2 tham số sai / kỳ chưa đóng / trước ngày vận hành / DB down /
lỗi DB.
"""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from agents.bks_recon import _fname
from agents.fp_pnl import frac, is_int, vnd
from agents.ra_kenh import parse_now
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.settlement_csv import CHANNELS, overlaps, round_half_up
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "rev_share.json"
RUN_BY = "agent:rev_share"
FEATURE = "finance-06"             # v14.3 cổng giai đoạn (HĐ 6.7)
NO_DATA = "chưa có dữ liệu"
NOT_SET = "chưa chốt"
FEE_COLS = ("fixed_fee", "payment_fee", "service_fee", "shipping_fee",
            "voucher_seller", "affiliate")
MONEY_KEYS = ("gross", "fee", "cancel", "refund", "net", "payout")
MAX_YEAR = 50
_Q_RE = re.compile(r"([0-9]{4})-Q([1-4])")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_ROW_SQL = (
    "select s.channel, s.file_name, s.order_amount_vnd, "
    + ", ".join(f"s.{c}_vnd" for c in FEE_COLS)
    + ", s.refund_vnd, s.payout_vnd, o.status from v_settlement_khoan s"
    " left join orders o on o.id = s.channel || ':' || s.order_id_hash"
    " and o.source like 'market:%%' where s.settled_on >= %s and"
    " s.settled_on < %s and s.channel = any(%s) order by s.id")
_ROW_COLS = ("channel", "file_name", "order_amount", *FEE_COLS, "refund",
             "payout", "status")
_UNDATED_SQL = (
    "select channel, count(*) from v_settlement_khoan where settled_on is"
    " null"
    " and channel = any(%s) group by channel order by channel")


class ConfigError(ValueError):
    """`data/rev_share.json` hỏng — CLI exit 1 trước khi connect."""


# ------------------------------------------------------------------ cấu hình

def _date_or_none(raw: dict, key: str) -> date | None:
    """Ngày `YYYY-MM-DD` | null (= chưa chốt). Sai → ConfigError."""
    v = raw.get(key)
    if v is None:
        return None
    try:
        if not (isinstance(v, str) and _DATE_RE.fullmatch(v)):
            raise ValueError
        return date.fromisoformat(v)
    except ValueError:
        raise ConfigError(f"{key}: null hoặc YYYY-MM-DD") from None


def load_config(path: Path | None = None) -> dict:
    p = path or CONFIG_FILE
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise ConfigError(f"không đọc được {p.name}: {type(e).__name__}"
                          ) from None
    if not isinstance(raw, dict):
        raise ConfigError(f"{p.name}: phải là object")
    start = _date_or_none(raw, "ngay_bat_dau_van_hanh")
    sign = _date_or_none(raw, "ngay_ky_hop_dong")
    if sign is not None and start is not None and start < sign:
        raise ConfigError("ngay_bat_dau_van_hanh trước ngay_ky_hop_dong")
    rate = raw.get("ty_le_phi_van_hanh")
    if rate is not None:
        rate, why = frac(rate, "ty_le_phi_van_hanh")
        if why:
            raise ConfigError(why)
    chans = raw.get("kenh_truc_tuyen")
    if (not isinstance(chans, list) or not chans
            or len(set(map(str, chans))) != len(chans)
            or not set(chans) <= set(CHANNELS)):
        raise ConfigError(f"kenh_truc_tuyen: list không trùng ⊂ {CHANNELS}")
    cols = raw.get("phi_san_cot")
    if (not isinstance(cols, list) or not cols
            or len(set(map(str, cols))) != len(cols)
            or not set(cols) <= set(FEE_COLS)):
        raise ConfigError(f"phi_san_cot: list không trùng ⊂ {FEE_COLS}")
    tiers = raw.get("muc_thuong")
    if not isinstance(tiers, list):
        raise ConfigError("muc_thuong: phải là list")
    out_t = []
    for i, t in enumerate(tiers):
        if not isinstance(t, dict) or not is_int(t.get("muc"), 1, 99):
            raise ConfigError(f"muc_thuong[{i}]: thiếu muc (1..99)")
        tu = t.get("tu_vnd")
        if tu is not None and not is_int(tu, 0, 10**15):
            raise ConfigError(f"muc_thuong[{i}].tu_vnd: null hoặc số ≥ 0")
        tl = t.get("ty_le")
        if tl is not None:
            tl, why = frac(tl, f"muc_thuong[{i}].ty_le")
            if why:
                raise ConfigError(why)
        out_t.append({"muc": t["muc"], "tu_vnd": tu, "ty_le": tl})
    if len({t["muc"] for t in out_t}) != len(out_t):
        raise ConfigError("muc_thuong: trùng muc")
    return {"start": start, "sign": sign, "rate": rate,
            "channels": list(chans),
            "fee_cols": [c for c in FEE_COLS if c in cols],
            "tiers": sorted(out_t, key=lambda t: t["muc"])}


# ------------------------------------------------------------------ kỳ

def _vn_midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=VN_TZ)


def quarter_range(label, now: datetime, start: date | None = None
                  ) -> tuple[date, date]:
    """'YYYY-Qn' → (ngày đầu, ngày sau cuối) — cắt từ `start` nếu quý chứa
    ngày bắt đầu vận hành. Sai dạng / chưa đóng / cả quý trước `start` →
    ValueError."""
    m = _Q_RE.fullmatch(label) if isinstance(label, str) else None
    if m is None:
        raise ValueError("--quarter phải dạng YYYY-Qn (n = 1..4)")
    y, q = int(m[1]), int(m[2])
    qs = date(y, 3 * q - 2, 1)
    qe = date(y + 1, 1, 1) if q == 4 else date(y, 3 * q + 1, 1)
    if _vn_midnight(qe) > now:
        raise ValueError(f"quý {label} chưa đóng (hết "
                         f"{qe - timedelta(days=1)} giờ VN)")
    if start is not None:
        if start >= qe:
            raise ValueError(f"quý {label} trước ngày bắt đầu vận hành "
                             f"thương mại {start}")
        qs = max(qs, start)
    return qs, qe


def _add_years(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year + n)
    except ValueError:                       # 29/02 → 01/03 năm thường
        return date(d.year + n, 3, 1)


def year_range(start: date, n, now: datetime) -> tuple[date, date]:
    """Năm hợp tác thứ n (1-based) từ `start` = NGÀY KÝ hợp đồng (Điều 3.1)
    → (đầu, sau cuối). n sai / năm chưa đóng (00:00 giờ VN ngày sau cuối)
    → ValueError. Ký 29/02 → năm thường dùng 01/03 (các năm liền nhau)."""
    if not is_int(n, 1, MAX_YEAR):
        raise ValueError(f"--year phải là số 1..{MAX_YEAR}")
    ys, ye = _add_years(start, n - 1), _add_years(start, n)
    if _vn_midnight(ye) > now:
        raise ValueError(f"năm hợp tác {n} chưa đóng (hết "
                         f"{ye - timedelta(days=1)} giờ VN)")
    return ys, ye


# ------------------------------------------------------------------ thuần

def channel_figures(rows: list[dict], fee_cols) -> dict:
    """Số 1 kênh từ dòng quyết toán (đã kèm `status` đơn; None = chưa thấy
    đơn trong `orders`)."""
    canc = [r for r in rows if r["status"] == "cancelled"]
    unknown = sum(1 for r in rows if r["status"] is None)
    gross = sum(r["order_amount"] for r in rows)
    fee = sum(r[c] for r in rows for c in fee_cols)
    cancel = None if unknown else sum(r["order_amount"] for r in canc)
    refund = sum(r["refund"] for r in rows if r["status"] != "cancelled")
    net = None if cancel is None else gross - fee - cancel - refund
    return {"n": len(rows), "n_cancelled": len(canc), "n_unknown": unknown,
            "gross": gross, "fee": fee, "cancel": cancel, "refund": refund,
            "net": net, "payout": sum(r["payout"] for r in rows),
            "files": sorted(Counter(_fname(r["file_name"])
                                    for r in rows).items())}


def summarize(rows: list[dict], channels, fee_cols,
              overlap: dict | None = None) -> dict:
    """→ {channels: {kênh: số | None}, total: {khóa: int | None}, notes,
    anomaly}. `overlap` = `settlement_csv.overlaps()` của kỳ: kênh có khoản
    xuất lại ở ≥2 file → BẤT THƯỜNG (không tính phí) kèm tên file."""
    out, notes = {}, []
    overlap = overlap or {}
    for ch in channels:
        mine = [r for r in rows if r["channel"] == ch]
        if not mine:
            out[ch] = None
            notes.append(f"{ch}: {NO_DATA} — không có dòng quyết toán trong"
                         " kỳ (chưa nạp file `ingest.settlement_csv` hoặc"
                         " kênh không phát sinh — 2 bên xác nhận)")
            continue
        f = out[ch] = channel_figures(mine, fee_cols)
        if f["n_unknown"]:
            notes.append(f"{ch}: {f['n_unknown']} dòng quyết toán chưa có"
                         " trạng thái đơn trong `orders` (nạp file đơn rồi"
                         " chạy `python -m agents.kd_orders --sync`) → Hủy/"
                         f"Thuần {NO_DATA}")
        if f["refund"] > f["gross"]:
            notes.append(f"{ch}: BẤT THƯỜNG — Hoàn ({vnd(f['refund'])}) >"
                         f" Gộp ({vnd(f['gross'])}): hoàn của đơn kỳ trước"
                         " hoặc lỗi file — cần giải trình (Điều 7.5)")
        if f["net"] is not None and f["net"] < 0:
            notes.append(f"{ch}: BẤT THƯỜNG — Thuần âm ({vnd(f['net'])})")
    for ch in channels:
        o = overlap.get(ch)
        if o and (o["trung"] or o["lech"]):
            notes.append(
                f"{ch}: BẤT THƯỜNG — khoản quyết toán xuất lại ở ≥2 file"
                f" (chồng kỳ): trùng nguyên văn {o['trung']} (đã tính 1"
                f" lần), lệch số {o['lech']} (giữ cả hai, KHÔNG tự chọn"
                " file) — nguồn: " + ", ".join(_fname(f) for f in
                                               o["files"])
                + " — người đối soát xác nhận/loại bản thừa (Điều 7.5)")
    total = {}
    for k in MONEY_KEYS:
        vals = [None if f is None else f[k] for f in out.values()]
        total[k] = None if any(v is None for v in vals) else sum(vals)
    return {"channels": out, "total": total, "notes": notes,
            "anomaly": any("BẤT THƯỜNG" in n for n in notes)}


def ops_fee(net, rate, start, anomaly=False) -> tuple[int | None, str | None]:
    """Phí vận hành quý → (số, None) | (None, lý do). `anomaly` = có kênh
    BẤT THƯỜNG (Hoàn > Gộp / Thuần âm) → không tính phí dù tổng dương."""
    if rate is None:
        return None, f"{NOT_SET} tỷ lệ phí vận hành"
    if start is None:
        return None, f"{NOT_SET} ngày bắt đầu vận hành thương mại"
    if net is None:
        return None, f"doanh thu thuần {NO_DATA}"
    if net < 0:
        return None, "doanh thu thuần âm — 2 bên giải trình (Điều 7.5)"
    if anomaly:
        return None, "có kênh bất thường — 2 bên giải trình (Điều 7.5)"
    return round_half_up(Decimal(net) * rate), None


def tier_rows(net, tiers, anomaly=False) -> list[dict]:
    """So doanh thu thuần năm với từng mức thưởng (PL02 mục 4).
    v13 vá review (F01): `anomaly` (kênh BẤT THƯỜNG — chồng kỳ lệch số giữ
    cả hai dòng, Hoàn > Gộp, Thuần âm) → không xét đạt/thưởng, như
    `ops_fee` ở đường quý; trước đây năm vẫn so mức trên số gấp đôi."""
    out = []
    for t in tiers:
        r = {"muc": t["muc"], "tu_vnd": t["tu_vnd"], "ty_le": t["ty_le"],
             "dat": None, "vuot": None, "thuong": None}
        if t["tu_vnd"] is None:
            r["trang_thai"] = f"{NOT_SET} ngưỡng"
        elif anomaly:
            r["trang_thai"] = ("bất thường — chưa xét mức, 2 bên giải trình"
                               " (Điều 7.5)")
        elif net is None:
            r["trang_thai"] = NO_DATA
        else:
            r["dat"] = net >= t["tu_vnd"]
            r["trang_thai"] = "đạt" if r["dat"] else "chưa đạt"
            if r["dat"]:
                r["vuot"] = net - t["tu_vnd"]
                if t["ty_le"] is not None:
                    r["thuong"] = round_half_up(Decimal(r["vuot"])
                                                * t["ty_le"])
        out.append(r)
    return out


# ------------------------------------------------------------------ DB

def fetch(conn, start: date, end: date, channels) -> tuple[list, dict]:
    """CHỈ SELECT → (dòng quyết toán kèm trạng thái đơn, {kênh: số dòng
    không có ngày quyết toán})."""
    rows = [dict(zip(_ROW_COLS, r)) for r in conn.execute(
        _ROW_SQL, (start, end, list(channels)))]
    undated = dict(conn.execute(_UNDATED_SQL, (list(channels),)))
    return rows, undated


def record(conn, label: str, start: date, end: date, s: dict, rate,
           fee: int | None, text: str, cfg: dict) -> int:
    """Ghi 1 dòng `revenue_quarters` (append-only) + commit tường minh
    (conn đã mở tx bằng SELECT — gotcha v2.1). v14.3: finance-06 TẮT →
    RolloutBlocked (HĐ 6.7), không ghi."""
    from pipelines import rollout  # lười: rollout → director → ...
    rollout.check_generate(conn, FEATURE, "sổ đối soát quý")
    t = s["total"]
    detail = {"channels": s["channels"], "notes": s["notes"],
              "phi_san_cot": cfg["fee_cols"],
              "ngay_bat_dau_van_hanh": (None if cfg["start"] is None
                                        else cfg["start"].isoformat()),
              "ngay_ky_hop_dong": (None if cfg["sign"] is None
                                   else cfg["sign"].isoformat())}
    rid = conn.execute(
        "insert into revenue_quarters (quarter, period_start, period_end,"
        " gross_vnd, platform_fee_vnd, cancel_vnd, refund_vnd, net_vnd,"
        " payout_vnd, fee_rate, ops_fee_vnd, detail, report_sha256,"
        " recorded_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
        " %s, %s, %s) returning id",
        (label, start, end, t["gross"], t["fee"], t["cancel"], t["refund"],
         t["net"], t["payout"], rate, fee, Jsonb(detail),
         hashlib.sha256(text.encode("utf-8")).hexdigest(), RUN_BY)
    ).fetchone()[0]
    conn.commit()
    return rid


# ------------------------------------------------------------------ báo cáo

def _m(v) -> str:
    return NO_DATA if v is None else vnd(v)


def _pct(rate) -> str:
    return NOT_SET if rate is None else f"{(rate * 100).normalize():f}%"


def _figures_table(s: dict, start: date, end: date) -> list[str]:
    last = end - timedelta(days=1)
    out = [("| Kênh | Gộp | Phí sàn | Hủy | Hoàn | **Thuần** | Thực nhận"
            " trên file | Nguồn |"), "|---|---|---|---|---|---|---|---|"]
    for ch, f in s["channels"].items():
        if f is None:
            out.append(f"| {ch} | {NO_DATA} | {NO_DATA} | {NO_DATA} |"
                       f" {NO_DATA} | **{NO_DATA}** | {NO_DATA} | — |")
            continue
        files = ", ".join(f"{n} ({k} dòng)" for n, k in f["files"])
        src = (f"`v_settlement_khoan` (`settlement_rows`, bản xuất lại"
               f" nguyên văn tính 1 lần) settled_on {start} → {last},"
               f" {f['n']} khoản: {files}; Hủy: `orders` (source market:{ch})"
               f" {f['n_cancelled']} đơn hủy")
        if f["n_unknown"]:
            src += f", {f['n_unknown']} dòng chưa thấy đơn"
        out.append(f"| {ch} | {_m(f['gross'])} | {_m(f['fee'])} |"
                   f" {_m(f['cancel'])} | {_m(f['refund'])} |"
                   f" **{_m(f['net'])}** | {_m(f['payout'])} | {src} |")
    t = s["total"]
    out.append(f"| **Tổng** | {_m(t['gross'])} | {_m(t['fee'])} |"
               f" {_m(t['cancel'])} | {_m(t['refund'])} | **{_m(t['net'])}**"
               f" | {_m(t['payout'])} | Σ các kênh (thiếu 1 kênh → {NO_DATA})"
               " |")
    return out


_WARN = ("> **BẢN ĐỀ XUẤT do hệ thống lập** — chỉ có giá trị khi đại diện 2"
         " bên ký (HĐ hợp tác Điều 7.5, 8.3). Xung đột lợi ích (Điều 7.6):"
         " Bên A vận hành hệ thống và hưởng phí tính trên số này → Bên B kiểm"
         " và ký; người của Bên A không tự duyệt. Chênh lệch → bên quản lý số"
         " liệu giải trình bằng văn bản trong 05 ngày làm việc.")
_FORMULA = ("Công thức: Thuần = Gộp − Phí sàn − Hủy − Hoàn. Hủy = Σ giá trị"
            " đơn của dòng quyết toán có đơn trạng thái hủy (hoàn của các"
            " dòng đó đã nằm trong Hủy, không trừ 2 lần). Thực nhận trên"
            " file (Σ `payout_vnd`) chỉ để đối chiếu.")


def _head(cfg: dict, period: str, now: datetime) -> list[str]:
    cols = ", ".join(f"`{c}_vnd`" for c in cfg["fee_cols"])
    start = NOT_SET if cfg["start"] is None else str(cfg["start"])
    sign = NOT_SET if cfg["sign"] is None else str(cfg["sign"])
    return [_WARN, "", "| Ô | Nội dung |", "|---|---|",
            f"| Kỳ | {period} |",
            f"| Ngày lập | {now.astimezone(VN_TZ):%Y-%m-%d %H:%M} (giờ VN) |",
            (f"| Kênh trực tuyến | {', '.join(cfg['channels'])} · website:"
             " chưa có nguồn (website bán hàng làm riêng sau) |"),
            f"| Phí sàn gồm | {cols} (GIẢ ĐỊNH — 2 bên chốt) |",
            f"| Ngày ký hợp đồng (mốc năm hợp tác) | {sign} |",
            f"| Ngày bắt đầu vận hành thương mại | {start} |", "",
            "## Số liệu", ""]


def _notes(s: dict, undated: dict) -> list[str]:
    notes = list(s["notes"]) + [
        (f"{ch}: {n} dòng quyết toán không có ngày quyết toán — không xếp"
         " được vào kỳ nào (KHÔNG tính)") for ch, n in sorted(undated.items())]
    return ["## Ghi chú / thiếu nguồn", ""] + (
        [f"- {n}" for n in notes] or ["- (không)"])


def render_quarter(label: str, start: date, end: date, s: dict,
                   undated: dict, cfg: dict, fee, fee_why,
                   now: datetime) -> str:
    period = (f"{label}: {start} → {end - timedelta(days=1)} (giờ VN, theo"
              " ngày quyết toán)")
    fee_txt = vnd(fee) if fee is not None else f"— ({fee_why})"
    lines = [f"# Biên bản đối soát doanh thu thuần trực tuyến — quý {label}",
             "", *_head(cfg, period, now), *_figures_table(s, start, end),
             "", _FORMULA, "", "## Phí vận hành (Điều 9.3, PL02 mục 5)", "",
             "| Ô | Nội dung |", "|---|---|",
             f"| Tỷ lệ phí vận hành | {_pct(cfg['rate'])} |",
             f"| Phí vận hành (quy đổi sản phẩm) | {fee_txt} |",
             "", *_notes(s, undated), "",
             "## Chênh lệch và giải trình (Điều 7.5)", "",
             "(2 bên ghi tay)", "", "## Ký xác nhận", "",
             "| Đại diện Bên A | Đại diện Bên B |", "|---|---|",
             "| (ký, ghi rõ họ tên) | (ký, ghi rõ họ tên) |", "| | |", ""]
    return "\n".join(lines)


def render_year(n: int, start: date, end: date, s: dict, undated: dict,
                cfg: dict, now: datetime) -> str:
    period = f"năm {n}: {start} → {end - timedelta(days=1)} (giờ VN)"
    lines = [f"# Doanh thu thuần trực tuyến — năm hợp tác thứ {n}", "",
             *_head(cfg, period, now), *_figures_table(s, start, end), "",
             _FORMULA, "", "## So mức thưởng (PL02 mục 4)", "",
             ("| Mức | Ngưỡng/năm | Tỷ lệ trên phần vượt | Trạng thái |"
              " Phần vượt | Thưởng tạm tính |"), "|---|---|---|---|---|---|"]
    for t in tier_rows(s["total"]["net"], cfg["tiers"], s["anomaly"]):
        tu = NOT_SET if t["tu_vnd"] is None else vnd(t["tu_vnd"])
        vuot = "—" if t["vuot"] is None else vnd(t["vuot"])
        thuong = "—" if t["thuong"] is None else vnd(t["thuong"])
        lines.append(f"| {t['muc']} | {tu} | {_pct(t['ty_le'])} |"
                     f" {t['trang_thai']} | {vuot} | {thuong} |")
    lines += ["", ("Cách cộng dồn giữa các mức chưa xác định (2 bên chốt);"
                   " căn cứ chính thức là các biên bản đối soát quý đã ký."),
              "", *_notes(s, undated), ""]
    return "\n".join(lines)


# ------------------------------------------------------------------ CLI

def main(argv=None, now=None) -> int:
    from pipelines.rollout import RolloutBlocked  # lười: tránh vòng import
    ap = argparse.ArgumentParser(
        prog="python -m agents.rev_share",
        description="Doanh thu thuần trực tuyến + biên bản đối soát quý"
                    " (CHỈ ĐỌC; ghi duy nhất revenue_quarters khi --record)")
    ap.add_argument("--quarter", help="YYYY-Qn")
    ap.add_argument("--year", type=int, help="năm hợp tác thứ N (1-based)")
    ap.add_argument("--now", help="ISO; thiếu múi giờ = giờ VN")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if (a.quarter is None) == (a.year is None):
        ap.error("cần đúng 1 trong --quarter | --year")
    if a.record and a.dry_run:
        ap.error("--record và --dry-run loại trừ nhau")
    if a.record and a.year is not None:
        ap.error("--record chỉ dùng với --quarter")
    try:
        now = parse_now(a.now) if a.now else (now or datetime.now(VN_TZ))
    except ValueError:
        ap.error("--now sai định dạng ISO")
    try:
        cfg = load_config()
    except ConfigError as e:
        print(f"[error] {e} — không connect.", file=sys.stderr)
        return 1
    if a.year is not None and cfg["sign"] is None:
        print(f"[error] {NOT_SET} ngay_ky_hop_dong trong"
              f" {CONFIG_FILE.name} — năm hợp tác tính từ ngày ký hợp đồng"
              " (không dùng ngày vận hành/ngày dự kiến).", file=sys.stderr)
        return 1
    try:
        if a.quarter is not None:
            label = a.quarter
            start, end = quarter_range(a.quarter, now, cfg["start"])
        else:
            label = f"nam-{a.year}"
            start, end = year_range(cfg["sign"], a.year, now)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    rid = path = None
    try:
        if not a.record:
            conn.read_only = True
        rows, undated = fetch(conn, start, end, cfg["channels"])
        s = summarize(rows, cfg["channels"], cfg["fee_cols"],
                      overlaps(conn, cfg["channels"], start, end))
        if a.quarter is not None:
            fee, why = ops_fee(s["total"]["net"], cfg["rate"], cfg["start"],
                               s["anomaly"])
            text = render_quarter(label, start, end, s, undated, cfg, fee,
                                  why, now)
        else:
            text = render_year(a.year, start, end, s, undated, cfg, now)
        if a.dry_run:
            print(text)
            return 0
        path = write_report(text, a.out_dir, f"doi-soat-{label}.md")
        if a.record:
            rid = record(conn, label, start, end, s, cfg["rate"], fee, text,
                         cfg)
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {type(e).__name__}", file=sys.stderr)
        return 2
    except RolloutBlocked as e:      # HĐ 6.7
        print(f"[blocked] {e}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.rollback()
        with suppress(Exception):
            conn.close()
    net = s["total"]["net"]
    print(f"[done] {path} — {label}: thuần {_m(net)}, {len(s['notes'])} ghi"
          " chú" + (f" · revenue_quarters #{rid}" if rid else
                    " · không ghi sổ"))
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.rev_share") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
