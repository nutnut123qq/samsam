"""v5.4 KD-A8 (WP07) — affiliate đại lý: mã/link + kit từ nội dung ĐÃ DUYỆT
của Marketing, ghi nhận đơn qua mã, hoa hồng TẠM TÍNH. Tất định, KHÔNG LLM,
KHÔNG mạng.

Ranh giới: agent KHÔNG gửi kit, KHÔNG liên hệ đại lý, KHÔNG tạo voucher/
coupon trên sàn/WooCommerce. Output: (1) `--issue` → 1 mã `pending` trong
`affiliate_codes` + 1 mục NHÁP `sales/affiliate_program` (`aff-<id>`) chờ
GĐ bán hàng duyệt; (2) `--release` (mục approved + `approval_queue.verify`
khớp) → mã `active` + file `data/reports/affiliate-kit-<đại lý>-<qid>.md`
(gitignored) để Quản lý MXH tạo voucher TAY rồi gửi TAY; (3) `--attribute`
→ `affiliate_attributions` (idempotent); (4) `--report` → bảng hoa hồng
BẢN NHÁP (không phải lệnh chi).

Mã: "SS" + 10 ký tự `secrets.choice` trên bảng 32 ký tự (không 0/O/1/I,
≈ 50 bit) — không chứa mã đại lý/ngày/số thứ tự, không bao giờ bắt đầu '-'.
Mỗi (đại lý, kênh) tối đa 1 mã pending|active. Link chỉ kênh web (tham số
`coupon` GIẢ ĐỊNH — coupon thật do MXH tạo); sàn chỉ có MÃ.

`build_kit` THUẦN, mã chặn:
  AFF_DEALER              đại lý không tồn tại / không active
  AFF_RUOU_ONLINE         draft gắn SKU rượu (mọi kênh A8 là online)
  AFF_CREATIVE_UNAPPROVED 0 / > MAX_DRAFTS draft, draft chưa duyệt / lệch
                          bản duyệt / loại ngoài KIT_TYPES / không gắn SKU
  AFF_READINESS           readiness (SKU, kênh) ngoài CONTENT_OK
  AFF_GUARDRAIL           kit không qua `guardrail.check`
Hoa hồng: `ingest.crm.commission_rate(dealer, category, online=True)` — 1
nguồn tỷ lệ (rượu online = 0, đại lý không active = 0, nhóm lạ = 0),
Decimal ROUND_HALF_UP. `data/dealer_commission.json` (acc_ar, công nợ đại
lý offline) KHÔNG dùng ở đây.

Chạy:
  python -m agents.kd_affiliate --issue --dealer D --channel C --draft-ids 1,2 --by "Tên" [--dry-run]
  python -m agents.kd_affiliate --release QID --by "Tên"
  python -m agents.kd_affiliate --revoke CODE --by "Tên"
  python -m agents.kd_affiliate --attribute
  python -m agents.kd_affiliate --report --from YYYY-MM-DD --to YYYY-MM-DD
Exit: 0 ok/skip · 1 bị chặn (in mã) / DB lỗi · 2 usage / DB down.
"""

import argparse
import datetime as dt
import hashlib
import re
import secrets
import sys
from contextlib import suppress
from decimal import Decimal
from pathlib import Path

import psycopg

from agents.mkt_koc import KIT_TYPES, MAX_DRAFTS, load_drafts
from agents.report import REPORTS_DIR, write_report
from ingest import crm
from ingest.lead_store import connect
from ingest.market_csv import load_mapping
from ingest.settlement_csv import round_half_up
from pipelines import approval_queue as aq
from pipelines import director, guardrail, store
from pipelines.job_runs import job_run
from pipelines.mkt_calendar import CONTENT_OK
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LEN = 10
PREFIX = "SS"
CODE_RE = re.compile(r"SS[A-HJ-NP-Z2-9]{10}")
CHANNELS = ("shopee", "tiktok", "web")
WEB_LINK = "https://samsamngoclinh.com/?coupon={code}"   # GIẢ ĐỊNH tham số
SAMPLE_SOURCE = "dealer_regions.json"
CODES = ("AFF_DEALER", "AFF_RUOU_ONLINE", "AFF_CREATIVE_UNAPPROVED",
         "AFF_READINESS", "AFF_GUARDRAIL")
RELEASE_CODES = ("AFF_NOT_APPROVED", "AFF_PAYLOAD_CHANGED")
NEW_CODE_TRIES = 5
DRAFT_NOTE = ("BẢN NHÁP — hệ thống không gửi; Quản lý MXH tạo voucher/coupon "
              "và gửi TAY sau khi GĐ bán hàng duyệt")
REPORT_HEAD = ("BẢN NHÁP — không phải lệnh chi; chính sách hoa hồng chưa ký "
               "(tỷ lệ MẪU)")
_OID_RE = re.compile(r"aff-([1-9][0-9]{0,17})")
TZ_VN = dt.timezone(dt.timedelta(hours=7))


# ---------- thuần ----------

def new_code(rand=secrets) -> str:
    """Mã affiliate ngẫu nhiên mật mã học (`rand` tiêm được để test)."""
    return PREFIX + "".join(rand.choice(ALPHABET) for _ in range(CODE_LEN))


def link_for(code: str, channel: str) -> str | None:
    """Chỉ kênh web có link; sàn chỉ dùng MÃ (voucher MXH tạo tay)."""
    return WEB_LINK.format(code=code) if channel == "web" else None


def _draft_why(d) -> str | None:
    if not isinstance(d, dict) or d.get("id") is None:
        return "draft không tồn tại"
    i = d["id"]
    if d.get("status") != "approved":
        return f"draft #{i} chưa duyệt (trạng thái {d.get('status')})"
    if d.get("content_type") not in KIT_TYPES:
        return f"draft #{i} loại {d.get('content_type')} — cần {KIT_TYPES}"
    if d.get("verified") is not True:
        return f"draft #{i} không khớp bản đã duyệt (verify_publish)"
    if not d.get("sku"):
        return f"draft #{i} không gắn SKU"
    return None


def render_kit(dealer: dict, channel: str, code: str, drafts: list) -> str:
    sample = dealer.get("source") == SAMPLE_SOURCE
    link = link_for(code, channel)
    L = [(f"# Kit affiliate đại lý {dealer['code']}"
          f"{' (ĐẠI LÝ MẪU)' if sample else ''} × {channel}"), "",
         f"{DRAFT_NOTE}.", "",
         "## Mã affiliate", "", f"- Mã: {code}"]
    L.append(f"- Link: {link}" if link else
             "- Sàn chỉ dùng MÃ — Quản lý MXH tạo voucher tương ứng trong "
             "Seller Center (chưa phải voucher thật).")
    L += ["", "## Nội dung đã duyệt (nguyên văn — không sửa khi đăng)", ""]
    for d in drafts:
        L += [f"### Bài #{d['id']} — `{d['sku']}`", "",
              (d.get("text") or "").strip(), ""]
    L += ["## Hoa hồng", "",
          ("- Tạm tính theo chính sách hoa hồng CHƯA ký — chỉ để tham khảo, "
           "không phải cam kết chi."), ""]
    return "\n".join(L)


def build_kit(dealer: dict | None, channel: str, code: str, drafts: list,
              golden: dict, readiness: dict) -> dict:
    """THUẦN → {code | None, reason, kit, sha12}. `code` ở kết quả là MÃ
    CHẶN (None = đạt); mã affiliate là tham số `code`. golden = {sku:
    {category}}, readiness = {(sku, kênh): mức}, drafts = như
    `mkt_koc.load_drafts`."""
    if not isinstance(dealer, dict) or dealer.get("status") != "active":
        st = dealer.get("status") if isinstance(dealer, dict) else None
        return {"code": "AFF_DEALER",
                "reason": f"đại lý không tồn tại / không active ({st})"}
    if channel not in CHANNELS:
        return {"code": "AFF_READINESS", "reason": f"kênh '{channel}' lạ"}
    drafts = drafts if isinstance(drafts, list) else []
    for d in drafts:
        g = golden.get(d.get("sku")) if isinstance(d, dict) else None
        if isinstance(g, dict) and g.get("category") == "alcohol":
            return {"code": "AFF_RUOU_ONLINE", "reason": (
                f"draft #{d.get('id')} gắn SKU đồ uống có cồn — kênh online "
                "không có affiliate")}
    if not drafts or len(drafts) > MAX_DRAFTS:
        return {"code": "AFF_CREATIVE_UNAPPROVED",
                "reason": f"cần 1..{MAX_DRAFTS} draft đã duyệt"}
    for d in drafts:
        why = _draft_why(d)
        if why:
            return {"code": "AFF_CREATIVE_UNAPPROVED", "reason": why}
    for d in drafts:   # kênh web tra readiness 'web' (view sku_readiness)
        g = golden.get(d["sku"])
        lvl = (readiness or {}).get((d["sku"], channel))
        if not isinstance(g, dict) or lvl not in CONTENT_OK:
            return {"code": "AFF_READINESS", "reason": (
                f"{d['sku']} × {channel}: readiness {lvl or 'không có'}")}
    kit = render_kit(dealer, channel, code, drafts)
    g = guardrail.check(kit)
    if g.get("ok") is not True:
        vs = sorted({v.get("code") or v.get("type") for v in
                     g.get("violations", []) if isinstance(v, dict)},
                    key=str)
        return {"code": "AFF_GUARDRAIL",
                "reason": f"kit không qua guardrail {vs}"}
    sha = hashlib.sha256(kit.encode("utf-8")).hexdigest()
    return {"code": None, "reason": "đạt", "kit": kit, "sha12": sha[:12]}


def commission_line(dealer: dict | None, category, amount_vnd: int,
                    code_status: str, cancelled: bool) -> dict:
    """→ {rate_pct, commission_vnd, flags, status}. Tỷ lệ từ
    `crm.commission_rate(..., online=True)` — không công thức thứ 2."""
    d = dealer if isinstance(dealer, dict) else {"status": "ended"}
    rate = crm.commission_rate(d, category, online=True)
    flags = []
    if category == "alcohol":
        flags.append("ruou_online")
    if category not in crm.CATEGORIES:
        flags.append("thieu_sku")
    if d.get("status", "active") != "active":
        flags.append("dai_ly_ngung")
    if code_status in ("pending", "void"):
        flags.append("ma_chua_kich_hoat")
    elif code_status == "revoked":
        flags.append("ma_da_thu_hoi")
    if cancelled:
        flags.append("huy")
    paid = not cancelled and code_status in ("active", "revoked")
    com = (round_half_up(Decimal(max(0, int(amount_vnd))) * rate / 100)
           if paid else 0)
    return {"rate_pct": rate, "commission_vnd": com, "flags": flags,
            "status": "huy" if cancelled else "tinh"}


# ---------- DB: phát hành mã ----------

def _dealer(conn, code: str) -> dict | None:
    row = conn.execute("select code, name, region, status, commission_default,"
                       " source from dealers where code = %s",
                       (code,)).fetchone()
    if row is None:
        return None
    return dict(zip(("code", "name", "region", "status",
                     "commission_default", "source"), row))


def _fresh_code(conn, rand=secrets) -> str:
    for _ in range(NEW_CODE_TRIES):
        c = new_code(rand)
        if not conn.execute("select exists(select 1 from affiliate_codes"
                            " where code = %s)", (c,)).fetchone()[0]:
            return c
    raise RuntimeError(f"sinh mã trùng {NEW_CODE_TRIES} lần liên tiếp")


def issue(conn, dealer_code: str, channel: str, draft_ids: list[int], *,
          by: str, dry_run: bool = False, dcfg: dict | None = None) -> dict:
    """→ {code (mã chặn) | None, reason, skipped, aff_code, qid}."""
    dealer = _dealer(conn, dealer_code)
    if dealer is None or dealer["status"] != "active":
        conn.commit()
        return build_kit(dealer, channel, "", [], {}, {}) | {
            "skipped": False, "qid": None}
    old = conn.execute(
        "select code, status from affiliate_codes where dealer_code = %s"
        " and channel = %s and status in ('pending', 'active')",
        (dealer_code, channel)).fetchone()
    if old is not None:
        conn.commit()
        return {"code": None, "reason": "đã có mã", "skipped": True,
                "aff_code": old[0], "aff_status": old[1], "qid": None}
    golden = {k: {"category": c} for k, c in conn.execute(
        "select sku_key, category from sku_master")}
    rmap = store.readiness_from_db(conn) or {}
    drafts = load_drafts(conn, draft_ids)
    code = _fresh_code(conn)
    conn.commit()   # đóng tx đọc
    res = build_kit(dealer, channel, code, drafts, golden, rmap)
    if res["code"] or dry_run:
        return {**res, "skipped": False, "aff_code": code, "qid": None}
    try:
        cid = conn.execute(
            "insert into affiliate_codes (code, dealer_code, channel,"
            " created_by) values (%s, %s, %s, %s) returning id",
            (code, dealer_code, channel, by)).fetchone()[0]
        # submit → enqueue commit CẢ insert mã ở trên (cùng tx) — mã và mục
        # hàng duyệt cùng sống/cùng mất; queue_id chỉ là liên kết tiện tra
        # (release dò mã theo object_id `aff-<id>`).
        qid = director.submit(conn, "sales", "affiliate_program",
                              f"aff-{cid}",
                              f"Affiliate đại lý {dealer_code} × {channel}",
                              res["kit"], created_by=by, cfg=dcfg)
        conn.execute("update affiliate_codes set queue_id = %s where id = %s",
                     (qid, cid))
        conn.commit()
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        return {"code": None, "reason": "đã có mã (ghi song song)",
                "skipped": True, "aff_code": None, "qid": None}
    except Exception:
        # Lỗi trước commit của enqueue → insert mã còn treo trong tx: bỏ.
        with suppress(Exception):
            conn.rollback()
        raise
    return {**res, "skipped": False, "aff_code": code, "qid": qid}


def release(conn, qid, *, by: str, out_dir: Path | None = None) -> dict:
    """→ {code | None, reason, path}. Không gửi — chỉ kích hoạt mã + ghi
    file."""
    row = conn.execute("select block, object_type, object_id, payload, status"
                       " from approval_queue where id = %s", (qid,)).fetchone()
    m = _OID_RE.fullmatch(row[2] or "") if row else None
    if (row is None or row[0] != "sales" or row[1] != "affiliate_program"
            or m is None):
        conn.commit()
        return {"code": "AFF_NOT_APPROVED",
                "reason": f"mục #{qid} không phải chương trình affiliate"}
    _, _, _, payload, status = row
    c = conn.execute("select id, code, dealer_code, status, queue_id from"
                     " affiliate_codes where id = %s",
                     (int(m.group(1)),)).fetchone()
    if c is None or c[4] not in (None, qid):
        conn.commit()
        return {"code": "AFF_NOT_APPROVED",
                "reason": f"mục #{qid} không có mã affiliate tương ứng"}
    cid, code, dealer_code, cstatus, _ = c
    if status in ("rejected", "expired"):
        conn.execute("update affiliate_codes set status = 'void', queue_id ="
                     " %s where id = %s and status = 'pending'", (qid, cid))
        conn.commit()
        return {"code": "AFF_NOT_APPROVED",
                "reason": f"mục #{qid} {status} — mã đã hủy (void)"}
    if status != "approved":
        conn.commit()
        return {"code": "AFF_NOT_APPROVED",
                "reason": f"mục #{qid} trạng thái {status} — chưa duyệt"}
    if cstatus not in ("pending", "active"):
        conn.commit()
        return {"code": "AFF_NOT_APPROVED",
                "reason": f"mã của mục #{qid} đang {cstatus}"}
    ok = aq.verify(conn, qid, payload) and code in (payload or "")
    if not ok:
        conn.commit()
        return {"code": "AFF_PAYLOAD_CHANGED",
                "reason": f"mục #{qid} không khớp bản đã duyệt"}
    conn.execute("update affiliate_codes set status = 'active', activated_at"
                 " = now(), activated_by = %s, queue_id = %s where id = %s"
                 " and status = 'pending'", (by, qid, cid))
    conn.commit()
    path = write_report(payload, out_dir or REPORTS_DIR,
                        f"affiliate-kit-{dealer_code}-{qid}.md")
    return {"code": None, "reason": "đạt", "path": path, "aff_code": code}


def revoke(conn, code: str, *, by: str) -> bool:
    """Chỉ thu hồi mã `active`. → True nếu đã thu hồi."""
    row = conn.execute(
        "update affiliate_codes set status = 'revoked', revoked_at = now(),"
        " revoked_by = %s where code = %s and status = 'active' returning id",
        (by, code)).fetchone()
    conn.commit()
    return row is not None


# ---------- DB: ghi nhận đơn + báo cáo ----------

# Mỗi (kênh, đơn, dòng): trạng thái/giá/số lượng từ snapshot đơn MỚI NHẤT
# (imported_at desc, id desc — quy ước settlement v9.0); mã voucher từ dòng
# mới nhất CÓ mã (file export sau thiếu cột mã không xóa ghi nhận).
_ATTR_SQL = """
with o as (
  select r.id, r.channel, r.order_id_hash,
         coalesce(r.seller_sku, r.item_id) as line_key, r.sku_key,
         r.price_vnd, r.qty, r.status,
         upper(btrim(r.raw->>'voucher_code')) as vcode,
         s.imported_at
  from market_rows r join market_snapshots s on s.id = r.snapshot_id
  where r.export_kind = 'order' and r.order_id_hash is not null
    and coalesce(r.seller_sku, r.item_id) is not null
), l as (
  select distinct on (channel, order_id_hash, line_key) *
  from o order by channel, order_id_hash, line_key, imported_at desc, id desc
), v as (
  select distinct on (channel, order_id_hash, line_key)
         channel, order_id_hash, line_key, vcode
  from o where coalesce(vcode, '') <> ''
  order by channel, order_id_hash, line_key, imported_at desc, id desc
)
select l.id, l.channel, l.order_id_hash, l.line_key, l.sku_key, m.category,
       coalesce(l.price_vnd, 0), coalesce(l.qty, 0), l.status, v.vcode,
       exists(select 1 from settlement_rows sr where sr.channel = l.channel
              and sr.order_id_hash = l.order_id_hash)
from l join v using (channel, order_id_hash, line_key)
left join sku_master m on m.sku_key = l.sku_key
order by l.channel, l.order_id_hash, l.line_key
"""

_UPSERT_SQL = """
insert into affiliate_attributions as a (code_id, dealer_code, channel,
  order_id_hash, line_key, market_row_id, sku_key, category, qty, amount_vnd,
  rate_pct, commission_vnd, status, flags, settled)
values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
on conflict (channel, order_id_hash, line_key) do update set
  code_id = excluded.code_id, dealer_code = excluded.dealer_code,
  market_row_id = excluded.market_row_id, sku_key = excluded.sku_key,
  category = excluded.category, qty = excluded.qty,
  amount_vnd = excluded.amount_vnd, rate_pct = excluded.rate_pct,
  commission_vnd = excluded.commission_vnd, status = excluded.status,
  flags = excluded.flags, settled = excluded.settled, updated_at = now()
where (a.code_id, a.dealer_code, a.market_row_id, a.sku_key, a.category,
       a.qty, a.amount_vnd, a.rate_pct, a.commission_vnd, a.status, a.flags,
       a.settled)
  is distinct from
      (excluded.code_id, excluded.dealer_code, excluded.market_row_id,
       excluded.sku_key, excluded.category, excluded.qty, excluded.amount_vnd,
       excluded.rate_pct, excluded.commission_vnd, excluded.status,
       excluded.flags, excluded.settled)
returning (xmax = 0)
"""


def _cancel_map() -> dict:
    m, why = load_mapping()
    if m is None:
        raise ValueError(why)
    return {ch: set(m[ch]["order"].get("cancel_status") or [])
            for ch in ("shopee", "tiktok")}


FEATURE_ATTR = "finance-03.2"


def attribute(conn, cancel: dict | None = None) -> dict:
    """Ghi nhận đơn sàn qua mã → affiliate_attributions (idempotent).
    v14.3: tính năng finance-03.2 TẮT → RolloutBlocked (HĐ 6.7), không
    ghi (main in [error] exit 1)."""
    from pipelines import rollout  # lười: rollout → director → ...
    rollout.check_generate(conn, FEATURE_ATTR, "ghi nhận đơn affiliate")
    cancel = cancel if cancel is not None else _cancel_map()
    res = {"new": 0, "updated": 0, "same": 0, "unknown_code": 0,
           "web_skipped": 0}
    with conn.transaction():
        codes = {c: (i, d, ch, st) for i, c, d, ch, st in conn.execute(
            "select id, code, dealer_code, channel, status from"
            " affiliate_codes")}
        dealers = {r[0]: {"status": r[1], "commission_default": r[2]}
                   for r in conn.execute(
                       "select code, status, commission_default from"
                       " dealers")}
        for (rid, ch, oh, lk, sku, cat, price, qty, st, vcode,
             settled) in conn.execute(_ATTR_SQL).fetchall():
            hit = codes.get(vcode)
            if hit is None:
                res["unknown_code"] += 1
                continue
            cid, dcode, cch, cst = hit
            if cch == "web":
                res["web_skipped"] += 1
                continue
            if cch != ch:
                res["unknown_code"] += 1
                continue
            amount = int(price) * int(qty)
            line = commission_line(dealers.get(dcode), cat, amount, cst,
                                   st in cancel.get(ch, ()))
            row = conn.execute(_UPSERT_SQL, (
                cid, dcode, ch, oh, lk, rid, sku, cat, qty, amount,
                line["rate_pct"], line["commission_vnd"], line["status"],
                line["flags"], settled)).fetchone()
            res["same" if row is None else
                "new" if row[0] else "updated"] += 1
    conn.commit()
    return res


def _vnd(n) -> str:
    return f"{int(n or 0):,}".replace(",", ".") + "đ"


def report(conn, start: dt.date, end_excl: dt.date) -> str:
    """THUẦN đọc. Kỳ theo `market_snapshots.imported_at` giờ VN [start,
    end_excl). Không in mã đơn/hash, không tên đại lý."""
    t0 = dt.datetime.combine(start, dt.time(), TZ_VN)
    t1 = dt.datetime.combine(end_excl, dt.time(), TZ_VN)
    agg: dict = {}
    for dcode, ch, amt, com, settled, st, flags in conn.execute(
            "select a.dealer_code, a.channel, a.amount_vnd, a.commission_vnd,"
            " a.settled, a.status, a.flags from affiliate_attributions a"
            " join market_rows r on r.id = a.market_row_id"
            " join market_snapshots s on s.id = r.snapshot_id"
            " where s.imported_at >= %s and s.imported_at < %s",
            (t0, t1)):
        g = agg.setdefault((dcode, ch), {"n": 0, "amt": 0, "com": 0,
                                         "sett": 0, "flags": {}})
        g["n"] += 1
        g["amt"] += amt if st == "tinh" else 0
        g["com"] += com
        g["sett"] += com if settled else 0
        for f in flags or []:
            g["flags"][f] = g["flags"].get(f, 0) + 1
    conn.commit()
    end_incl = end_excl - dt.timedelta(days=1)
    L = [(f"# Hoa hồng affiliate đại lý {start.isoformat()} → "
          f"{end_incl.isoformat()}"), "", REPORT_HEAD + ".", "",
         ("| Đại lý | Kênh | Dòng | Doanh số (trừ hủy) | Hoa hồng tạm tính | "
          "Đã quyết toán sàn | Cờ |"), "|---|---|---|---|---|---|---|"]
    for (dcode, ch), g in sorted(agg.items()):
        fl = ", ".join(f"{k}×{v}" for k, v in sorted(g["flags"].items()))
        L.append(f"| {dcode} | {ch} | {g['n']} | {_vnd(g['amt'])} | "
                 f"{_vnd(g['com'])} | {_vnd(g['sett'])} | {fl or '-'} |")
    if not agg:
        L.append("| (không có dòng) | | | | | | |")
    L += ["", ("Ghi chú: 'đã quyết toán sàn' = đơn đã có trong file quyết "
               "toán (settlement), KHÔNG phải đã chi hoa hồng; phí affiliate "
               "sàn thu (AMS) không cộng vào đây. Rượu và đơn hủy = 0."), ""]
    return "\n".join(L)


# ---------- CLI ----------

def _ids(s: str) -> list[int] | None:
    parts = [p.strip() for p in (s or "").split(",")]
    if not parts or not all(p.isascii() and p.isdigit() for p in parts):
        return None
    ids = [int(p) for p in parts]
    ok = 1 <= len(ids) <= MAX_DRAFTS and len(set(ids)) == len(ids)
    return ids if ok and all(i > 0 for i in ids) else None


def _date(ap, s, flag) -> dt.date:
    try:
        return dt.date.fromisoformat(s or "")
    except ValueError:
        ap.error(f"{flag} phải dạng YYYY-MM-DD")


def _block(code: str, why: str) -> int:
    print(f"[chặn] {code}: {_mask_pii(why)}")
    return 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_affiliate",
        description="KD-A8 affiliate đại lý — mã + kit NHÁP vào hàng duyệt, "
                    "ghi nhận đơn qua mã, hoa hồng BẢN NHÁP (không gửi gì)")
    ap.add_argument("--issue", action="store_true")
    ap.add_argument("--release", type=int, metavar="QID")
    ap.add_argument("--revoke", metavar="CODE")
    ap.add_argument("--attribute", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--dealer")
    ap.add_argument("--channel", choices=CHANNELS)
    ap.add_argument("--draft-ids")
    ap.add_argument("--by")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    n_ops = (a.issue + (a.release is not None) + (a.revoke is not None)
             + a.attribute + a.report)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --issue | --release | --revoke |"
                 " --attribute | --report")
    by = (a.by or "").strip()
    if (a.issue or a.release is not None or a.revoke is not None) and (
            not by or len(by) > crm.MAX_BY_LEN):
        ap.error(f"--issue/--release/--revoke cần --by <tên người> "
                 f"(≤ {crm.MAX_BY_LEN} ký tự)")
    ids = None
    if a.issue:
        if not a.dealer or not crm.DEALER_CODE_RE.fullmatch(a.dealer):
            ap.error("--issue cần --dealer <mã đại lý>")
        if not a.channel:
            ap.error(f"--issue cần --channel {'|'.join(CHANNELS)}")
        ids = _ids(a.draft_ids)
        if ids is None:
            ap.error(f"--draft-ids phải 1..{MAX_DRAFTS} id số, cách dấu phẩy")
    code = None
    if a.revoke is not None:
        code = a.revoke.strip().upper()
        if not CODE_RE.fullmatch(code):
            ap.error("--revoke: mã sai mẫu SS + 10 ký tự")
    start = end = None
    if a.report:
        start, end = _date(ap, a.start, "--from"), _date(ap, a.end, "--to")
        if end < start or (end - start).days > 3660:
            ap.error("--to phải ≥ --from và kỳ ≤ 3660 ngày")
    dcfg = None
    if a.issue:
        try:
            dcfg = director.load_config("sales")
        except director.DirectorConfigError as e:
            print(f"[err] cấu hình khối sales: {e} — không connect.")
            return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.issue:
            res = issue(conn, a.dealer, a.channel, ids, by=by,
                        dry_run=a.dry_run, dcfg=dcfg)
            if res["code"]:
                return _block(res["code"], res["reason"] + " — không ghi gì.")
            if res["skipped"]:
                print(f"[skip] {a.dealer} × {a.channel} đã có mã "
                      f"{res.get('aff_code') or '(đang ghi)'} "
                      f"({res.get('aff_status', 'pending')}) — không sinh mã"
                      " mới.")
            elif a.dry_run:
                print(res["kit"])
                print("[dry-run] kit đạt mọi luật chặn — không ghi (mã trên "
                      "chỉ minh họa, không giữ).")
            else:
                print(f"[issue] mã {res['aff_code']} (pending) + mục hàng "
                      f"duyệt #{res['qid']} (affiliate_program, CHỜ GĐ bán "
                      "hàng duyệt) — agent không gửi/liên hệ đại lý.")
            return 0
        if a.release is not None:
            res = release(conn, a.release, by=by)
            if res["code"]:
                return _block(res["code"], res["reason"])
            print(f"[release] mã {res['aff_code']} active, kit → "
                  f"{res['path']} (phát hành bởi {by}) — Quản lý MXH tạo "
                  "voucher/coupon và gửi TAY; hệ thống không gửi.")
            return 0
        if a.revoke is not None:
            if not revoke(conn, code, by=by):
                print(f"[err] mã {code} không ở trạng thái active — không "
                      "thu hồi.")
                return 1
            print(f"[revoke] mã {code} đã thu hồi bởi {by} — nhớ tắt voucher"
                  " TAY trên sàn/web.")
            return 0
        if a.attribute:
            r = attribute(conn)
            print(f"[attribute] mới {r['new']} · cập nhật {r['updated']} · "
                  f"không đổi {r['same']} · mã không khớp "
                  f"{r['unknown_code']} · mã web (chưa có nguồn đơn) "
                  f"{r['web_skipped']}")
            return 0
        print(report(conn, start, end + dt.timedelta(days=1)))
        return 0
    except (psycopg.Error, ValueError, OSError, RuntimeError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        print(f"[error] {type(e).__name__}: {_mask_pii(msg)}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    with job_run("agents.kd_affiliate") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
