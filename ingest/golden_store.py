"""v3.2 golden master — nạp `data/golden_skus.json` vào bảng golden
(`sku_master`, `sku_map`, `price_list`) + dựng phiếu lệch
`golden_discrepancies` + CLI duyệt giá cho NGƯỜI thật.

Ownership:
  - `products` thuộc `ingest.core_store` (crawl web) — module này CHỈ ĐỌC
    products để đối chiếu, không bao giờ ghi.
  - Golden = nguồn sự thật DUY NHẤT cho listing/giá/trạng thái pháp lý.
    Agent lập phiếu lệch nhưng KHÔNG tự chọn giá; mọi giá nạp với
    `approved_by=null` → `v_promotable` rỗng tới khi GĐ bán hàng duyệt.

Contract nạp (`python -m ingest.golden_store [--file PATH]`):
  - Đọc + `validate()` TOÀN file TRƯỚC khi connect. File thiếu / rỗng /
    JSON hỏng / `{}` / chỉ `_doc` / `skus: []` → `[warn]`, exit 1, KHÔNG
    connect, KHÔNG xóa gì (gotcha delete-trắng). Có lỗi validate → in từng
    lỗi, exit 1, 0 ghi DB.
  - Hợp lệ → 1 transaction, upsert theo khóa (KHÔNG delete-by-source):
      sku_master  on conflict (sku_key): chỉ update khi row không phải
                  `source='manual'` VÀ dữ liệu đổi thật → version+1.
      sku_map     on conflict (product_id): giữ row manual; đổi sku_key
                  thì xóa approved_by (duyệt cũ không còn giá trị).
      price_list  APPEND-ONLY: chưa có dòng mở → insert chờ duyệt; dòng mở
                  cùng giá → bỏ qua; khác giá → đóng valid_to=hôm nay VN
                  + insert dòng mới chờ duyệt (không UPDATE giá).
  - SKU / mapping / giá có trong DB mà VẮNG khỏi file → GIỮ NGUYÊN: ngừng
    bán / gỡ giá là quyết định của người, không suy từ file thiếu dòng.
  - Ngày hiệu lực = `(now() at time zone 'Asia/Ho_Chi_Minh')::date`.

Schema JSON: `{"_doc": "...", "skus": [ {sku_key, name, category
(tpbvsk|food|alcohol), pack_spec, receipt_no, receipt_date (ISO),
xnqc_status (none|pending|approved), self_declaration_ok (bool|null),
allowed_channels [kênh], shopee_item_id, product_ids [products.id],
prices {kênh: {floor, list, promo}} (VND nguyên dương, thiếu key = chưa
có giá), note} ]}`.

Ràng buộc giá (số nguyên, không float — nhiều SKU đúng biên 149%):
  R1 list*100 <= floor*149   (giá thường ≤ 149% giá sàn)
  R2 (list-promo)*100 <= list*49   (giảm từ thường xuống KM ≤ 49%)
  R3 floor <= promo <= list
Mỗi rule chỉ xét khi đủ giá trị liên quan.

Phiếu lệch (dựng lại mỗi lần nạp từ dữ liệu DB, upsert theo
(kind, sku_key, product_id); `status`/`resolved_by` do người cập nhật,
loader KHÔNG đụng — phiếu đã xử lý không bị mở lại; phiếu `pending` mà
điều kiện hết đúng thì xóa): price_mismatch, spec_mismatch,
product_unmapped, sku_no_product, missing_price, alcohol_online_listing.
`detail` ghi giá trị theo TỪNG nguồn — không có trường "đề xuất/chọn".

CLI khác:
  --report                          in phiếu lệch pending + giá chờ duyệt
  --approve-price <id> --by <tên>   NGƯỜI thật duyệt 1 dòng giá
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.types.json import Jsonb

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
GOLDEN_FILE = ROOT / "data" / "golden_skus.json"

CATEGORIES = ("tpbvsk", "food", "alcohol")
XNQC = ("none", "pending", "approved")
CHANNELS = ("shopee", "tiktok", "web", "facebook", "zalo", "chatbot")
KINDS = ("floor", "list", "promo")
DISC_SOURCE = "golden_store"
MAX_BY_LEN = 100
TODAY_VN = "(now() at time zone 'Asia/Ho_Chi_Minh')::date"

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SPEC_RE = re.compile(r"(\d+)\s*(viên|v|ml)\b", re.IGNORECASE)

# Cột dữ liệu sku_master do file golden quản (so "đổi thật" để version+1).
SKU_COLS = ("name", "category", "pack_spec", "receipt_no", "receipt_date",
            "xnqc_status", "self_declaration_ok", "allowed_channels",
            "shopee_item_id", "note")


# ---------- đọc + validate (thuần, không DB) ----------

def read_golden(path: Path) -> tuple[dict | None, str | None]:
    """→ (doc, None) hoặc (None, lý do). Mọi biến thể "không có dữ liệu"
    (thiếu / rỗng / JSON hỏng / `{}` / chỉ `_doc` / `skus: []`) trả lý do
    để caller dừng TRƯỚC khi connect — không bao giờ xóa trắng."""
    if not path.is_file():
        return None, f"thiếu file {path}"
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError as e:
        return None, f"{path} không phải UTF-8: {e}"
    if not text.strip():
        return None, f"{path} rỗng"
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        return None, f"{path} JSON hỏng: {e}"
    if not isinstance(doc, dict) or not doc.get("skus"):
        return None, f"{path} không có SKU nào (0 record) — không nạp"
    return doc, None


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def check_prices(sku_key: str, channel: str, p: dict) -> list[str]:
    """3 ràng buộc giá người dùng đặt — số nguyên, chỉ khi đủ giá trị."""
    errs = []
    floor, lst, promo = p.get("floor"), p.get("list"), p.get("promo")
    where = f"{sku_key}/{channel}"
    if floor is not None and lst is not None and lst * 100 > floor * 149:
        errs.append(f"{where} R1: giá thường {lst} > 149% giá sàn {floor}")
    if lst is not None and promo is not None and \
            (lst - promo) * 100 > lst * 49:
        errs.append(f"{where} R2: KM {promo} giảm > 49% từ giá thường {lst}")
    if ((floor is not None and promo is not None and promo < floor)
            or (promo is not None and lst is not None and promo > lst)
            or (floor is not None and lst is not None and floor > lst)):
        errs.append(f"{where} R3: phải sàn {floor} <= KM {promo} <= "
                    f"thường {lst}")
    return errs


def validate(doc) -> list[str]:
    """Hàm thuần: schema + R1/R2/R3. [] = hợp lệ. Mỗi lỗi nêu sku_key."""
    if not isinstance(doc, dict):
        return ["root phải là object {\"_doc\", \"skus\"}"]
    skus = doc.get("skus")
    if not isinstance(skus, list) or not skus:
        return ["skus phải là list không rỗng"]
    errs: list[str] = []
    seen_keys: set[str] = set()
    pid_owner: dict[str, str] = {}
    for i, s in enumerate(skus):
        if not isinstance(s, dict):
            errs.append(f"skus[{i}] không phải object")
            continue
        key = s.get("sku_key")
        if not isinstance(key, str) or not _SLUG_RE.match(key):
            errs.append(f"skus[{i}] sku_key {key!r} không phải slug ascii")
            key = f"skus[{i}]"
        elif key in seen_keys:
            errs.append(f"{key}: sku_key trùng")
        seen_keys.add(key)
        if not isinstance(s.get("name"), str) or not s["name"].strip():
            errs.append(f"{key}: thiếu name")
        if s.get("category") not in CATEGORIES:
            errs.append(f"{key}: category {s.get('category')!r} không hợp lệ")
        if s.get("xnqc_status", "none") not in XNQC:
            errs.append(f"{key}: xnqc_status {s.get('xnqc_status')!r} "
                        "không hợp lệ")
        if s.get("self_declaration_ok") not in (True, False, None):
            errs.append(f"{key}: self_declaration_ok phải true/false/null")
        for f in ("pack_spec", "receipt_no", "shopee_item_id", "note"):
            if s.get(f) is not None and not isinstance(s[f], str):
                errs.append(f"{key}: {f} phải là chuỗi hoặc null")
        rd = s.get("receipt_date")
        if rd is not None:
            try:
                dt.date.fromisoformat(rd)
            except (TypeError, ValueError):
                errs.append(f"{key}: receipt_date {rd!r} không phải ISO")
        chans = s.get("allowed_channels", [])
        if not isinstance(chans, list) or any(c not in CHANNELS
                                              for c in chans):
            errs.append(f"{key}: allowed_channels phải ⊂ {CHANNELS}")
        pids = s.get("product_ids", [])
        if not isinstance(pids, list) or not all(
                isinstance(p, str) and p for p in pids):
            errs.append(f"{key}: product_ids phải là list chuỗi")
            pids = []
        for p in pids:
            if p in pid_owner:
                errs.append(f"{key}: product_id {p} đã map cho "
                            f"{pid_owner[p]}")
            else:
                pid_owner[p] = key
        prices = s.get("prices", {})
        if not isinstance(prices, dict):
            errs.append(f"{key}: prices phải là object")
            continue
        for ch, p in prices.items():
            if ch not in CHANNELS:
                errs.append(f"{key}: kênh giá {ch!r} không hợp lệ")
                continue
            if not isinstance(p, dict):
                errs.append(f"{key}/{ch}: giá phải là object")
                continue
            bad = False
            for k, v in p.items():
                if k not in KINDS:
                    errs.append(f"{key}/{ch}: loại giá {k!r} không hợp lệ")
                    bad = True
                elif not _is_int(v) or v <= 0:
                    errs.append(f"{key}/{ch}: giá {k}={v!r} phải nguyên "
                                "dương")
                    bad = True
            if not bad:
                errs.extend(check_prices(key, ch, p))
    return errs


def spec_of(text: str | None) -> str | None:
    """Tách quy cách đầu tiên 'số + đơn vị' (viên|v|ml) → '12 viên',
    '120 ml'. Không có → None (tên không ghi quy cách thì không so)."""
    m = _SPEC_RE.search(text or "")
    if not m:
        return None
    unit = m.group(2).lower()
    return f"{int(m.group(1))} {'ml' if unit == 'ml' else 'viên'}"


# ---------- phiếu lệch (thuần) ----------

def build_discrepancies(skus: list[dict], prices: dict, maps: dict,
                        products: list[dict]) -> list[dict]:
    """Dựng phiếu lệch từ dữ liệu đã đọc DB.

    skus: [{sku_key, name, category, pack_spec, shopee_item_id,
    allowed_channels}]; prices: {sku_key: {channel: {kind: price}}} (dòng
    mở); maps: {product_id: sku_key}; products: [{id, name, price_vnd}].
    → [{kind, sku_key, product_id, detail}]. Giá trị ghi theo TỪNG nguồn,
    KHÔNG chọn giá nào đúng."""
    out = []
    by_key = {s["sku_key"]: s for s in skus}
    prod_ids = {p["id"] for p in products}

    for p in products:
        sku_key = maps.get(p["id"])
        if sku_key is None or sku_key not in by_key:
            out.append({"kind": "product_unmapped", "sku_key": None,
                        "product_id": p["id"],
                        "detail": {"web": {"name": p["name"],
                                           "price_vnd": p["price_vnd"]}}})
            continue
        s = by_key[sku_key]
        golden = prices.get(sku_key, {})
        lists = {ch: kp["list"] for ch, kp in golden.items() if "list" in kp}
        if p["price_vnd"] is not None and lists and \
                p["price_vnd"] not in lists.values():
            out.append({"kind": "price_mismatch", "sku_key": sku_key,
                        "product_id": p["id"],
                        "detail": {"web": {"product_id": p["id"],
                                           "name": p["name"],
                                           "price_vnd": p["price_vnd"]},
                                   "golden": golden}})
        web_spec, gold_spec = spec_of(p["name"]), spec_of(s["pack_spec"])
        if web_spec and gold_spec and web_spec != gold_spec:
            out.append({"kind": "spec_mismatch", "sku_key": sku_key,
                        "product_id": p["id"],
                        "detail": {"web": {"name": p["name"],
                                           "spec": web_spec},
                                   "golden": {"pack_spec": s["pack_spec"],
                                              "spec": gold_spec}}})

    for s in skus:
        key = s["sku_key"]
        mapped = sorted(pid for pid, k in maps.items() if k == key)
        if not any(pid in prod_ids for pid in mapped):
            out.append({"kind": "sku_no_product", "sku_key": key,
                        "product_id": None,
                        "detail": {"golden": {"name": s["name"]},
                                   "mapped_product_ids": mapped}})
        shopee = prices.get(key, {}).get("shopee", {})
        missing = [k for k in KINDS if k not in shopee]
        if missing:
            out.append({"kind": "missing_price", "sku_key": key,
                        "product_id": None,
                        "detail": {"golden": {"shopee": shopee},
                                   "missing": missing}})
        if s["category"] == "alcohol" and s.get("shopee_item_id"):
            out.append({"kind": "alcohol_online_listing", "sku_key": key,
                        "product_id": None,
                        "detail": {"golden": {
                            "shopee_item_id": s["shopee_item_id"],
                            "allowed_channels": s["allowed_channels"]}}})
    return out


# ---------- DB ----------

def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def _sku_params(s: dict, source: str) -> dict:
    return {"sku_key": s["sku_key"], "name": s["name"],
            "category": s["category"], "pack_spec": s.get("pack_spec"),
            "receipt_no": s.get("receipt_no"),
            "receipt_date": s.get("receipt_date"),
            "xnqc_status": s.get("xnqc_status", "none"),
            "self_declaration_ok": s.get("self_declaration_ok"),
            "allowed_channels": list(s.get("allowed_channels", [])),
            "shopee_item_id": s.get("shopee_item_id"),
            "note": s.get("note"), "source": source}


def load(conn, doc: dict, source: str = "golden_skus.json") -> dict:
    """Upsert golden (doc ĐÃ validate). Không commit — caller commit
    (CLI) hoặc rollback (test)."""
    stats = {"sku_changed": 0, "map_changed": 0, "price_inserted": 0,
             "price_closed": 0, "price_same": 0}
    cols = ("sku_key",) + SKU_COLS + ("source",)
    upd = ", ".join(f"{c} = excluded.{c}" for c in SKU_COLS)
    cur_t = ", ".join(f"sku_master.{c}" for c in SKU_COLS)
    exc_t = ", ".join(f"excluded.{c}" for c in SKU_COLS)
    sku_sql = (
        f"insert into sku_master ({', '.join(cols)}) values ("
        + ", ".join(f"%({c})s" for c in cols) + ") "
        f"on conflict (sku_key) do update set {upd}, "
        "source = excluded.source, version = sku_master.version + 1, "
        "updated_at = now() "
        "where sku_master.source <> 'manual' "
        f"and ({cur_t}) is distinct from ({exc_t})")
    map_sql = (
        "insert into sku_map (product_id, sku_key, note, source) "
        "values (%s, %s, %s, %s) on conflict (product_id) do update set "
        "sku_key = excluded.sku_key, note = excluded.note, "
        "approved_by = case when sku_map.sku_key = excluded.sku_key "
        "then sku_map.approved_by end "
        "where sku_map.source <> 'manual' and (sku_map.sku_key, "
        "sku_map.note) is distinct from (excluded.sku_key, excluded.note)")
    map_note = "đề xuất của agent — chờ Sản xuất duyệt"
    for s in doc["skus"]:
        stats["sku_changed"] += conn.execute(
            sku_sql, _sku_params(s, source)).rowcount
        for pid in s.get("product_ids", []):
            stats["map_changed"] += conn.execute(
                map_sql, (pid, s["sku_key"], map_note, source)).rowcount
        for ch, kp in s.get("prices", {}).items():
            for kind in KINDS:
                if kind not in kp:
                    continue
                price = kp[kind]
                row = conn.execute(
                    "select id, price_vnd from price_list where sku_key = %s"
                    " and channel = %s and kind = %s and program_id is null"
                    " and valid_to is null", (s["sku_key"], ch, kind)
                ).fetchone()
                if row and row[1] == price:
                    stats["price_same"] += 1
                    continue
                if row:
                    conn.execute(f"update price_list set valid_to = "
                                 f"{TODAY_VN} where id = %s", (row[0],))
                    stats["price_closed"] += 1
                conn.execute(
                    "insert into price_list (sku_key, channel, kind,"
                    " price_vnd, valid_from) values (%s, %s, %s, %s,"
                    f" {TODAY_VN})", (s["sku_key"], ch, kind, price))
                stats["price_inserted"] += 1
    return stats


def apply_discrepancies(conn) -> dict:
    """Dựng lại phiếu lệch từ DB. Upsert: detail/updated_at đổi,
    status/resolved_by KHÔNG đụng. Xóa phiếu `pending` của loader mà
    điều kiện hết đúng. Chỉ ĐỌC products."""
    skus = [dict(zip(("sku_key", "name", "category", "pack_spec",
                      "shopee_item_id", "allowed_channels"), r))
            for r in conn.execute(
                "select sku_key, name, category, pack_spec, shopee_item_id,"
                " allowed_channels from sku_master order by sku_key")]
    prices: dict = {}
    for key, ch, kind, price in conn.execute(
            "select sku_key, channel, kind, price_vnd from price_list"
            " where valid_to is null and program_id is null"):
        prices.setdefault(key, {}).setdefault(ch, {})[kind] = price
    maps = dict(conn.execute("select product_id, sku_key from sku_map"))
    products = [{"id": r[0], "name": r[1], "price_vnd": r[2]}
                for r in conn.execute(
                    "select id, name, price_vnd from products order by id")]
    tickets = build_discrepancies(skus, prices, maps, products)
    for t in tickets:
        conn.execute(
            "insert into golden_discrepancies (kind, sku_key, product_id,"
            " detail, source) values (%s, %s, %s, %s, %s)"
            " on conflict (kind, (coalesce(sku_key, '')),"
            " (coalesce(product_id, ''))) do update set"
            " detail = excluded.detail, updated_at = now()"
            " where golden_discrepancies.detail is distinct from"
            " excluded.detail",
            (t["kind"], t["sku_key"], t["product_id"], Jsonb(t["detail"]),
             DISC_SOURCE))
    conn.execute(
        "delete from golden_discrepancies d where d.status = 'pending'"
        " and d.source = %s and not exists (select 1 from"
        " unnest(%s::text[], %s::text[], %s::text[]) as k(kind, sku, pid)"
        " where k.kind = d.kind and k.sku = coalesce(d.sku_key, '')"
        " and k.pid = coalesce(d.product_id, ''))",
        (DISC_SOURCE, [t["kind"] for t in tickets],
         [t["sku_key"] or "" for t in tickets],
         [t["product_id"] or "" for t in tickets]))
    counts: dict = {}
    for t in tickets:
        counts[t["kind"]] = counts.get(t["kind"], 0) + 1
    return counts


def approve_price(conn, price_id: int, by: str) -> tuple[bool, str]:
    """NGƯỜI thật duyệt 1 dòng giá. Không commit (caller commit).
    Từ chối: id không tồn tại / đã duyệt / đã đóng valid_to."""
    row = conn.execute(
        "select sku_key, channel, kind, price_vnd, approved_by, valid_to"
        " from price_list where id = %s", (price_id,)).fetchone()
    if row is None:
        return False, f"không có dòng giá id={price_id}"
    sku_key, channel, kind, price, approved_by, valid_to = row
    if approved_by is not None:
        return False, f"id={price_id} đã được duyệt trước đó"
    if valid_to is not None:
        return False, f"id={price_id} đã đóng (valid_to={valid_to})"
    n = conn.execute(
        "update price_list set approved_by = %s, approved_at = now()"
        " where id = %s and approved_by is null and valid_to is null",
        (by, price_id)).rowcount
    if n != 1:
        return False, f"id={price_id} vừa đổi trạng thái — thử lại"
    return True, (f"đã duyệt id={price_id} {sku_key} {channel} {kind} "
                  f"{price} VND")


def report(conn) -> None:
    rows = conn.execute(
        "select id, kind, sku_key, product_id, detail from"
        " golden_discrepancies where status = 'pending'"
        " order by kind, sku_key nulls first, product_id").fetchall()
    print(f"[report] {len(rows)} phiếu lệch pending (giá trị theo nguồn,"
          " agent không chọn):")
    for pid_, kind, sku, prod, detail in rows:
        print(f"  #{pid_} {kind} sku={sku} product={prod} "
              + json.dumps(detail, ensure_ascii=False, sort_keys=True))
    prices = conn.execute(
        "select id, sku_key, channel, kind, price_vnd from price_list"
        " where approved_by is null and valid_to is null"
        " order by sku_key, channel, kind").fetchall()
    print(f"[report] {len(prices)} dòng giá chờ GĐ bán hàng duyệt "
          "(--approve-price <id> --by <tên>):")
    for pid_, sku, ch, kind, price in prices:
        print(f"  id={pid_} {sku} {ch} {kind} {price}")


# ---------- CLI ----------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.golden_store",
        description="Nạp golden master / báo phiếu lệch / duyệt giá.")
    ap.add_argument("--file", type=Path, help="file golden (mặc định "
                    "data/golden_skus.json)")
    ap.add_argument("--report", action="store_true",
                    help="in phiếu lệch pending + giá chờ duyệt")
    ap.add_argument("--approve-price", type=int, metavar="ID",
                    help="duyệt 1 dòng giá — CHỈ người thật chạy")
    ap.add_argument("--by", help="tên người duyệt (bắt buộc với "
                    "--approve-price)")
    args = ap.parse_args(argv)

    n_ops = sum([args.file is not None, args.report,
                 args.approve_price is not None])
    if n_ops > 1:
        ap.error("chỉ được 1 thao tác mỗi lần (--file | --report | "
                 "--approve-price)")
    by = (args.by or "").strip()
    if args.approve_price is not None:
        if not by:
            ap.error("--approve-price cần --by <tên người duyệt> không rỗng")
        if len(by) > MAX_BY_LEN or not by.isprintable():
            ap.error(f"--by tối đa {MAX_BY_LEN} ký tự in được")
    elif args.by is not None:
        ap.error("--by chỉ dùng với --approve-price")

    doc = None
    if not args.report and args.approve_price is None:
        path = args.file or GOLDEN_FILE
        doc, why = read_golden(path)
        if doc is None:
            print(f"[warn] {why} — không connect, không ghi/xóa gì.",
                  flush=True)
            return 1
        errs = validate(doc)
        if errs:
            for e in errs:
                print(f"[err] {e}", flush=True)
            print(f"[err] {len(errs)} lỗi — không nạp gì.", flush=True)
            return 1
        source = path.name
        # v14.2: nạp file = login dịch vụ (LOADER_DATABASE_URL, svc_loader);
        # --approve-price/--report là người → DSN của người.
        from pipelines import auth  # lười: auth → director → ...
        if why := auth.bind_service("loader"):
            print(f"[err] {why}", flush=True)
            return 2

    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env")
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.OperationalError as e:
        print(f"[err] không kết nối được Postgres: {e}")
        return 1
    try:
        if args.report:
            report(conn)
            return 0
        if args.approve_price is not None:
            # v14.2: GĐ bán hàng được Bên B ủy quyền (auth.cli_gate).
            from pipelines import auth  # lười: auth → director → ...
            why = auth.cli_gate(conn, by, "sales", "approve_price",
                                "price_list", args.approve_price)
            if why:
                conn.rollback()
                print(f"[err] {why} — không ghi.")
                return 1
            ok, msg = approve_price(conn, args.approve_price, by)
            if not ok:
                conn.rollback()
                print(f"[err] {msg} — không ghi.")
                return 1
            conn.commit()
            print(f"[done] {msg} — người duyệt: {by}")
            return 0
        stats = load(conn, doc, source)
        disc = apply_discrepancies(conn)
        conn.commit()
        totals = {t: conn.execute(f"select count(*) from {t}").fetchone()[0]
                  for t in ("sku_master", "sku_map", "price_list",
                            "golden_discrepancies")}
    except psycopg.errors.UndefinedTable as e:
        conn.rollback()
        print(f"[err] thiếu bảng golden — chạy `python "
              f"scripts/apply_schema.py` trước: {e}")
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {e}")
        return 1
    finally:
        conn.close()
    print("[load] " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    print("[disc] " + ", ".join(f"{k}={v}" for k, v in sorted(disc.items())))
    print("[done] totals: " + ", ".join(f"{k}={v}"
                                        for k, v in totals.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
