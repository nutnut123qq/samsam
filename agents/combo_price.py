"""Đợt hợp đồng C09 — intel-05.2 (trước intel-05) phương án NHÁP giá combo (PL01 Tình báo
"thử thông điệp, giá combo ... để loại phương án yếu trước khi chi tiền").

Nguồn (chỉ đọc): `bom_combos`/`bom_items` (thành phần + số lượng), giá
`list`/`floor` ĐÃ DUYỆT hiệu lực của từng thành phần (`price_list`, kênh),
giá vốn ĐÃ DUYỆT (`cogs_versions`), tỷ lệ thực nhận kênh
(`fpa_config.cash.net_ratio_default`, GIẢ ĐỊNH), mức giảm
`data/combo_price.json` (GIẢ ĐỊNH).

Mỗi (combo, kênh):
  - thành phần thuộc nhóm hạn chế (không có trong `v_promotable`: rượu,
    TPBVSK chưa XNQC...) → `nhom_han_che`, KHÔNG đề xuất;
  - thiếu giá list đã duyệt của thành phần → `thieu_du_lieu`, KHÔNG đề xuất
    (không bịa giá);
  - còn lại: mỗi mức giảm → giá = tổng list × (1 − %), làm tròn xuống; đánh
    giá `duoi_san` (dưới Σ floor đã duyệt) | `lo` (biên ước tính âm) |
    `khong_tinh_duoc` (thiếu giá vốn/floor/tỷ lệ — không kết luận không lỗ)
    | `dat`. Nội dung mục qua `guardrail.check`.
→ 1 mục `intel/combo_price_option` (Quản lý Marketing duyệt) / combo × kênh
× dữ liệu đầu vào (khóa sha — chạy lại không nhân bản; đầu vào đổi → đợt
mới). Agent KHÔNG áp giá, KHÔNG đổi KM. Rollout intel-05.2 tắt → không sinh.
Chạy thử thông điệp/giá trên khách giả lập vẫn chờ DPIA (`persona_sim`).

Chạy: python -m agents.combo_price [--as-of YYYY-MM-DD] [--dry-run]
"""

import argparse
import hashlib
import json
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from agents import kd_listing as kl
from agents.fp_pnl import cogs_at, fetch_versions
from agents.kd_price import load_net_ratio
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.period import VN_TZ

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CFG_FILE = ROOT / "data" / "combo_price.json"
FEATURE, BLOCK, OT, AGENT = ("intel-05.2", "intel", "combo_price_option",
                             "agent:combo_price")


def load_cfg(path=CFG_FILE) -> dict:
    try:
        d = json.loads(Path(path).read_bytes().decode("utf-8"))
        pcts, step, chs = d["muc_giam_pct"], d["lam_tron_vnd"], d["channels"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ValueError(f"{Path(path).name} hỏng ({type(e).__name__})"
                         ) from None
    if not (isinstance(pcts, list) and pcts and all(
            isinstance(p, int) and not isinstance(p, bool) and 0 < p < 90
            for p in pcts) and isinstance(step, int) and step > 0
            and isinstance(chs, list) and chs):
        raise ValueError("combo_price.json: muc_giam_pct/lam_tron_vnd/channels"
                         " sai")
    return {"pcts": sorted(set(pcts)), "step": step, "channels": chs,
            "status": str(d.get("status") or ""),
            "chot_boi": d.get("chot_boi")}


def allowed_set(conn) -> set:
    """r12 G1-L6: (sku, kênh) được phép nói/bán theo READINESS (view
    `sku_readiness` TP_THUONG/QC_DAY_DU) — KHÔNG dùng `v_promotable` vì view
    đó còn đòi giá list đã duyệt, làm SKU chỉ thiếu giá bị gắn nhầm
    `nhom_han_che` (nhánh `thieu_du_lieu` không bao giờ tới)."""
    return {(k, ch) for k, ch in conn.execute(
        "select sku_key, channel from sku_readiness"
        " where readiness in ('TP_THUONG', 'QC_DAY_DU')")}


def evaluate(items, prices, promotable, cogs, net, cfg, ch, today) -> dict:
    """THUẦN. items [(sku, qty)] → {status, base, floor, cost, options}."""
    if any((sku, ch) not in promotable for sku, _ in items):
        return {"status": "nhom_han_che"}
    base = floor = cost = 0
    for sku, q in items:
        g = prices.get((sku, ch), {})
        lst = g.get("list")
        if not lst or not lst["approved"]:
            return {"status": "thieu_du_lieu",
                    "why": f"thiếu giá list ĐÃ DUYỆT của {sku}"}
        base += q * lst["price"]
        fl = g.get("floor")
        floor = None if floor is None or not fl or not fl["approved"] \
            else floor + q * fl["price"]
        c = cogs_at(cogs, sku, today)
        cost = None if cost is None or c is None else cost + q * c
    ratio = net.get(ch) if net else None
    opts = []
    for p in cfg["pcts"]:
        price = int(Decimal(base) * (100 - p) / 100) // cfg["step"] * \
            cfg["step"]
        if floor is not None and price < floor:
            st = "duoi_san"
        elif cost is None or ratio is None or floor is None:
            st = "khong_tinh_duoc"
        elif int(price * Decimal(ratio)) - cost < 0:
            st = "lo"
        else:
            st = "dat"
        opts.append({"pct": p, "price": price, "status": st})
    return {"status": "de_xuat", "base": base, "floor": floor, "cost": cost,
            "options": opts}


def _payload(key, name, ch, r, cfg) -> str:
    L = [f"Phương án NHÁP giá combo {key} ({name}) trên kênh {ch} — agent "
         "KHÔNG áp giá. Tổng giá list ĐÃ DUYỆT các thành phần: "
         f"{r['base']:,} đ".replace(",", ".")
         + (f"; tổng giá sàn: {r['floor']:,} đ".replace(",", ".")
            if r["floor"] is not None else "; thiếu giá sàn đã duyệt")
         + ("" if r["cost"] is not None else "; thiếu giá vốn đã duyệt "
            "(biên không tính được)") + "."]
    L += [f"- Chiết khấu {o['pct']}% → {o['price']:,} đ: {o['status']}"
          .replace(",", ".") for o in r["options"]]
    L.append(f"Giả định mức chiết khấu: data/combo_price.json ({cfg['status']}; "
             f"người chốt: {cfg['chot_boi'] or 'chưa có'}). Nguồn: bom_items,"
             " price_list (đã duyệt), cogs_versions (đã duyệt), fpa_config.")
    return "\n".join(L)


def propose(conn, today: date, cfg: dict, net) -> list[dict]:
    """CHỈ SELECT → [{combo, channel, status, item?}]."""
    prices = kl.golden_prices(conn, today)
    promotable = allowed_set(conn)
    cogs = fetch_versions(conn)
    out = []
    for key, name, chans, src in conn.execute(
            "select combo_key, name, channels, source from bom_combos"
            " order by combo_key").fetchall():
        items = conn.execute("select sku_key, qty from bom_items where"
                             " combo_key = %s order by sku_key",
                             (key,)).fetchall()
        for ch in [c for c in cfg["channels"] if c in chans]:
            r = evaluate(items, prices, promotable, cogs, net, cfg, ch, today)
            rec = {"combo": key, "channel": ch, "status": r["status"],
                   "why": r.get("why"), "sample": src == "sample"}
            if r["status"] == "de_xuat":
                sig = hashlib.sha256(json.dumps(
                    [items, r["base"], r["floor"], r["cost"], r["options"]],
                    default=str).encode()).hexdigest()[:12]
                payload = _payload(key, name, ch, r, cfg)
                if guardrail.check(payload).get("ok") is not True:
                    rec["status"], rec["why"] = "guardrail", "payload"
                else:
                    rec["item"] = {"object_id": f"cb:{key}:{ch}:{sig}",
                                   "title": f"Giá combo {key} ({ch}) — "
                                   "phương án nháp", "payload": payload}
            out.append(rec)
    return out


def submit(conn, recs: list[dict]) -> int:
    from pipelines import rollout
    rollout.check_generate(conn, FEATURE, "phương án giá combo")
    seen = {o for (o,) in conn.execute(
        "select object_id from approval_queue where object_type = %s", (OT,))}
    n = 0
    for r in recs:
        it = r.get("item")
        if not it or it["object_id"] in seen:
            continue
        director.submit(conn, BLOCK, OT, it["object_id"], it["title"],
                        it["payload"], AGENT, sample=r["sample"])
        seen.add(it["object_id"])
        n += 1
    conn.commit()
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.combo_price")
    ap.add_argument("--as-of", type=date.fromisoformat)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    try:
        cfg = load_cfg()
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1
    net, _why = load_net_ratio(cfg["channels"])
    today = a.as_of or datetime.now(VN_TZ).date()
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres", file=sys.stderr)
        return 2
    try:
        recs = propose(conn, today, cfg, net)
        for r in recs:
            print(f"- {r['combo']} × {r['channel']}: {r['status']}"
                  + (f" ({r['why']})" if r.get("why") else ""))
        if a.dry_run:
            print("[dry-run] không ghi DB")
            return 0
        from pipelines.rollout import RolloutBlocked
        try:
            n = submit(conn, recs)
        except RolloutBlocked as e:
            print(f"[rollout] {e}", file=sys.stderr)
            return 2
        print(f"[done] {n} mục combo_price_option mới (khối intel)")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
