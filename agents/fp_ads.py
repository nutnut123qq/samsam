"""v9.1 FP-AdsBudget (WP12) — chấm biên gộp → ĐỀ XUẤT ngân sách quảng cáo
theo SKU × kênh. Tất định Python/SQL, KHÔNG LLM/mạng.

Ranh giới: output DUY NHẤT là 1 mục ĐỀ XUẤT `budget_change` trong hàng duyệt
chung (`pipelines.director.submit` → `approval_queue`, risk/SLA lấy từ
`data/directors/finance.json` — risk high nên `auto_policies` không bao giờ
áp). Agent KHÔNG chi tiền, KHÔNG bật voucher, KHÔNG đổi giá, KHÔNG cài ngân
sách trên nền tảng quảng cáo — Quản lý MXH cài tay sau khi người duyệt.
Module không có lời gọi API quảng cáo/voucher nào.

Hàm THUẦN `propose(cells, readiness, cfg)`: cells = ô P&L tháng tham chiếu
(`agents.fp_pnl.pnl`), readiness = `{(sku_key, kênh): mức}` đọc từ view
`sku_readiness` (không chép lại luật CASE). Mỗi SKU × kênh đúng 1 mã, ưu
tiên:
  CHAN_CAM     readiness CAM (gồm SKU không có trong view — fail-closed) → 0
  CHAN_XNQC    readiness MO_TA (TPBVSK chưa XNQC) → 0
  CHO_DU_LIEU  ô không có / biên None (thiếu giá vốn duyệt) → 0, không tính
  DUOI_NGUONG  biên gộp < ngưỡng cấu hình → 0
  AM_BIEN      lãi gộp ≤ 0 → 0
  DE_XUAT      lãi gộp × hệ số (ROUND_HALF_UP)
Payload KHÔNG nêu tên/sku_key SKU bị CHAN_CAM (guardrail chặn mọi nhắc tới
đồ uống có cồn) — chỉ số đếm.

Cấu hình `data/fpa_config.json` mục `ads` (GIẢ ĐỊNH — chờ GĐ tài chính
chốt): `min_gross_margin_pct` 0..1, `budget_share_of_margin` 0..1,
`channels` ⊂ golden CHANNELS.

Chạy:
  python -m agents.fp_ads --propose --month YYYY-MM   (tháng tham chiếu P&L)
Exit: 0 ok/skip · 1 cấu hình/DB lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import sys
from contextlib import suppress
from decimal import Decimal
from pathlib import Path

import psycopg

from agents import fp_pnl
from agents.fp_pnl import frac, parse_month, read_config, vnd
from ingest.golden_store import CHANNELS
from ingest.lead_store import connect
from ingest.settlement_csv import round_half_up
from pipelines import director
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

CODES = ("CHAN_CAM", "CHAN_XNQC", "CHO_DU_LIEU", "DUOI_NGUONG", "AM_BIEN",
         "DE_XUAT")
CREATED_BY = "agent:fp_ads"
NOTE = ("ĐỀ XUẤT — agent không chi tiền, không bật voucher, không đổi giá, "
        "không cài ngân sách trên nền tảng; quản lý MXH cài tay sau khi duyệt.")


def load_cfg(path: Path | None = None) -> tuple[dict | None, str | None]:
    sec, why = read_config("ads", path)
    if sec is None:
        return None, why
    mn, why = frac(sec.get("min_gross_margin_pct"), "ads.min_gross_margin_pct")
    if why:
        return None, why
    share, why = frac(sec.get("budget_share_of_margin"),
                      "ads.budget_share_of_margin")
    if why:
        return None, why
    ch = sec.get("channels")
    if (not isinstance(ch, list) or not ch or len(set(ch)) != len(ch)
            or not all(isinstance(c, str) and c in CHANNELS for c in ch)):
        return None, f"ads.channels: list kênh ⊂ {CHANNELS}, không trùng"
    return {"min_gross_margin_pct": mn, "budget_share_of_margin": share,
            "channels": list(ch)}, None


def propose(cells: list[dict], readiness: dict, cfg: dict) -> list[dict]:
    """→ [{sku_key, channel, code, budget_vnd, bien_gop_pct, lai_gop}] sắp
    theo sku_key rồi thứ tự kênh cấu hình."""
    by = {(c["sku_key"], c["channel"]): c for c in cells
          if c["sku_key"] != fp_pnl.UNKNOWN_SKU}
    floor = cfg["min_gross_margin_pct"] * 100      # biên P&L tính theo %
    share = cfg["budget_share_of_margin"]
    skus = sorted({k for k, _ in readiness} | {k for k, _ in by})
    out = []
    for sku in skus:
        for ch in cfg["channels"]:
            c = by.get((sku, ch))
            lvl = readiness.get((sku, ch))
            bien = c["bien_gop_pct"] if c else None
            lai = c["lai_gop"] if c else None
            budget = 0
            if lvl is None or lvl == "CAM":
                code = "CHAN_CAM"
            elif lvl == "MO_TA":
                code = "CHAN_XNQC"
            elif bien is None or lai is None:
                code = "CHO_DU_LIEU"
            elif bien < floor:
                code = "DUOI_NGUONG"
            elif lai <= 0:
                code = "AM_BIEN"
            else:
                code = "DE_XUAT"
                budget = round_half_up(Decimal(lai) * share)
            out.append({"sku_key": sku, "channel": ch, "code": code,
                        "budget_vnd": budget, "bien_gop_pct": bien,
                        "lai_gop": lai})
    return out


def render_payload(month, props: list[dict], cfg: dict) -> str:
    """Payload markdown của mục `budget_change` — SKU CHAN_CAM chỉ đếm."""
    cam = [p for p in props if p["code"] == "CHAN_CAM"]
    shown = [p for p in props if p["code"] != "CHAN_CAM"]
    total = sum(p["budget_vnd"] for p in props)
    L = [f"# Đề xuất ngân sách quảng cáo theo biên gộp — P&L tháng {month:%m/%Y}",
         "", f"**{NOTE}**", "",
         (f"Ngưỡng biên gộp tối thiểu {cfg['min_gross_margin_pct'] * 100}%;"
          f" ngân sách = lãi gộp tháng tham chiếu × "
          f"{cfg['budget_share_of_margin']} (GIẢ ĐỊNH `data/fpa_config.json`"
          " — chờ GĐ tài chính chốt)."), "",
         "| SKU | Kênh | Biên gộp | Lãi gộp | Ngân sách đề xuất | Mã |",
         "|---|---|---|---|---|---|"]
    for p in shown:
        bien = "—" if p["bien_gop_pct"] is None else f"{p['bien_gop_pct']}%"
        lai = "—" if p["lai_gop"] is None else vnd(p["lai_gop"])
        L.append(f"| `{p['sku_key']}` | {p['channel']} | {bien} | {lai} | "
                 f"{vnd(p['budget_vnd'])} | {p['code']} |")
    if not shown:
        L.append("| (không có) | | | | | |")
    n_cam_sku = len({p["sku_key"] for p in cam})
    L += ["", (f"- {len(cam)} cặp SKU × kênh ({n_cam_sku} SKU) readiness "
               "CAM — ngân sách 0 (không liệt kê tên)."),
          "- CHAN_XNQC: TPBVSK chưa có xác nhận nội dung quảng cáo — 0.",
          ("- CHO_DU_LIEU: thiếu giá vốn duyệt hoặc chưa có doanh thu tháng "
           "tham chiếu — không tính."),
          f"- Tổng ngân sách đề xuất: {vnd(total)}.", ""]
    return "\n".join(L)


# ---------- DB ----------

def fetch_readiness(conn, channels) -> dict:
    return {(k, ch): lv for k, ch, lv in conn.execute(
        "select sku_key, channel, readiness from sku_readiness where channel"
        " = any(%s)", (list(channels),))}


def pending_for_month(conn, month) -> int | None:
    row = conn.execute(
        "select id from approval_queue where block = 'finance' and"
        " object_type = 'budget_change' and status = 'pending' and object_id"
        " like %s order by id limit 1", (f"ads-{month:%Y-%m}-%",)).fetchone()
    return row[0] if row else None


def submit_proposal(conn, month, cfg: dict, dcfg: dict | None = None):
    """→ (queue_id | None nếu skip, props, payload)."""
    qid = pending_for_month(conn, month)
    if qid is not None:
        conn.commit()
        return None, [], ""
    res = fp_pnl.compute(conn, month)
    props = propose(res["cells"], fetch_readiness(conn, cfg["channels"]),
                    cfg)
    conn.commit()
    payload = render_payload(month, props, cfg)
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    title = (f"Đề xuất ngân sách ads tháng {month:%m/%Y} — tổng "
             f"{vnd(sum(p['budget_vnd'] for p in props))}")
    qid = director.submit(conn, "finance", "budget_change",
                          f"ads-{month:%Y-%m}-{sha[:12]}", title, payload,
                          created_by=CREATED_BY, cfg=dcfg)
    return qid, props, payload


# ---------- CLI ----------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.fp_ads",
        description="FP-AdsBudget: ĐỀ XUẤT ngân sách ads theo biên gộp vào "
                    "hàng duyệt (không chi tiền)")
    ap.add_argument("--propose", action="store_true")
    ap.add_argument("--month", help="tháng tham chiếu P&L YYYY-MM")
    args = ap.parse_args(argv)
    if not args.propose:
        ap.error("cần --propose --month YYYY-MM")
    month = parse_month(args.month)
    if month is None:
        ap.error("--month phải dạng YYYY-MM (tháng 01..12)")
    cfg, why = load_cfg()
    if cfg is None:
        print(f"[err] {why} — không connect.", flush=True)
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
        qid, props, _ = submit_proposal(conn, month, cfg, dcfg)
        if qid is None:
            print(f"[skip] đã có đề xuất ngân sách ads tháng {month:%Y-%m} "
                  "đang chờ duyệt — không tạo thêm.")
            return 0
        n = {c: sum(p["code"] == c for p in props) for c in CODES}
        print(f"[propose] mục hàng duyệt #{qid} (budget_change, CHỜ NGƯỜI "
              "DUYỆT) — " + ", ".join(f"{c}={v}" for c, v in n.items()))
        print(f"[propose] tổng đề xuất "
              f"{vnd(sum(p['budget_vnd'] for p in props))} — agent không "
              "chi tiền, không cài ngân sách.")
        return 0
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        print(f"[skip] đề xuất ads tháng {month:%Y-%m} vừa được tạo song "
              "song — không tạo thêm.")
        return 0
    except (psycopg.Error, ValueError, OSError) as e:
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
