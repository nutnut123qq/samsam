"""v5.3 KD-A4 — Agent catalog & listing đa sàn (WP07, khối `sales`). LUẬT
tất định, KHÔNG LLM, KHÔNG gọi sàn, KHÔNG sửa listing/giá: so listing ĐANG
CHẠY trên sàn (snapshot `listing` mới nhất mỗi kênh của `ingest.market_csv`
v3.3) với nháp listing ĐÃ DUYỆT (`content_drafts.content_type='listing'`,
v6.1) + golden (v3.2) → danh sách lệch → mục NHÁP vào hàng duyệt khối KD.
Người sửa trên Seller Center là Quản lý MXH SAU KHI GĐ bán hàng duyệt.

Loại phát hiện (hàm thuần `diff_catalog`):
  unready_listed    S1  listing đang bán map SKU readiness `CAM` (rượu,
                        TPBVSK/thực phẩm ngoài allowed_channels, thiếu dữ
                        liệu) → `market_alert_s1`
  title_drift       S2  tiêu đề sàn ≠ tiêu đề bản duyệt (sau NFC + gộp
                        khoảng trắng + casefold) → `listing_sync`
  price_drift       S2  giá niêm yết sàn ≠ giá bản duyệt → `listing_sync`
  draft_stale       S2  giá bản duyệt ≠ giá list golden đang mở cùng kênh
                        (bản duyệt cũ — sinh lại nháp) → `listing_sync`
  no_approved_draft S2  listing đang chạy map SKU nhưng chưa có bản duyệt
  missing_listing   S2  SKU readiness MO_TA|TP_THUONG|QC_DAY_DU trên kênh
                        CÓ snapshot mà không có dòng đang bán
Dòng không map SKU → chỉ đếm (đã là `item_unmapped` của v3.3). Kênh chưa
có snapshot → `[warn]`, KHÔNG sinh `missing_listing` (vắng file ≠ thiếu
listing). Status thuộc `inactive_status` của mapping = không còn bán;
status lạ/None = đang bán (fail-closed như v3.3).

Ghi DB DUY NHẤT qua `director.submit` (→ `approval_queue.enqueue`, guardrail
do module hàng duyệt tự chạy). `object_id` theo ĐỢT:
`a4:<loại>:<kênh>:<item_id|sku>:<sha256(bằng chứng)[:12]>` — đã có ở BẤT
KỲ status → không đẩy lại; bằng chứng đổi = đợt mới. Phát hiện trùng
`market_alerts` OPEN `alcohol_listed` cùng (kênh, item_id, seller_sku) →
vẫn có trong báo cáo kèm "(đã có cảnh báo sàn #id)" nhưng KHÔNG enqueue.
`payload`/`title` dựng từ TEMPLATE (nhãn + kênh + mã sàn + số liệu golden/
sàn) — KHÔNG chép tiêu đề/mô tả listing; SKU nhóm CAM KHÔNG in `sku_key`.

Chạy:
  python -m agents.kd_listing --run --dry-run     # chỉ đọc, in kế hoạch
  python -m agents.kd_listing --run               # đẩy mục mới (job_runs)
  python -m agents.kd_listing --report [--out-dir D]
Exit: 0 ok · 1 cấu hình lỗi · 2 DB down / lỗi DB / tham số sai.
"""

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from ingest.market_csv import CHANNELS, _clean, _to_int, load_mapping
from pipelines import director
from pipelines.director import DirectorConfigError
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, vn_date
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

BLOCK = "sales"
AGENT = "agent:kd_listing"
JOB = "agents.kd_listing"
LISTABLE = ("MO_TA", "TP_THUONG", "QC_DAY_DU")
SEVERITY = {"unready_listed": "S1", "title_drift": "S2", "price_drift": "S2",
            "draft_stale": "S2", "no_approved_draft": "S2",
            "missing_listing": "S2"}
KIND_LABELS = {
    "unready_listed": "listing thuộc nhóm không được bán/quảng bá online",
    "title_drift": "tiêu đề trên sàn khác bản đã duyệt",
    "price_drift": "giá niêm yết trên sàn khác bản đã duyệt",
    "draft_stale": "bản listing đã duyệt có giá cũ so với bảng giá golden",
    "no_approved_draft": "listing đang bán chưa có bản listing đã duyệt",
    "missing_listing": "SKU đủ điều kiện nhưng chưa có listing đang bán"}
# Cảnh báo v3.3 trùng nghĩa → không nhân đôi việc.
V33_DUP = {"unready_listed": "alcohol_listed"}
NO_AUTO = ("Agent không tự sửa sàn, không tự duyệt.")
_ITEM_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}")
_WS_RE = re.compile(r"\s+")


# ---------------------------------------------------------------- tiện ích

def vnd(n) -> str:
    return "—" if n is None else f"{int(n):,}".replace(",", ".") + " đ"


def ref_code(s) -> str:
    """Mã sàn từ file (item_id/seller_sku) trước khi vào payload: chỉ
    [A-Za-z0-9_.-] ≤ 40 ký tự, khác → '(mã lạ)' (không lọt free text)."""
    return s if isinstance(s, str) and _ITEM_RE.fullmatch(s) else "(mã lạ)"


def norm_title(s) -> str:
    """NFC + gộp khoảng trắng + casefold — chỉ khác hoa/thường/khoảng
    trắng không tính là lệch."""
    if not isinstance(s, str):
        return ""
    return _WS_RE.sub(" ", unicodedata.normalize("NFC", s)).strip().casefold()


def evidence_sha(ev: dict) -> str:
    raw = json.dumps(ev, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def parse_draft(text) -> tuple[str | None, int | None]:
    """Nháp listing v6.1 → (tiêu đề = dòng đầu, giá dòng `Giá:` VND |
    None). `Giá: Liên hệ` / thiếu dòng / số hỏng → giá None."""
    if not isinstance(text, str):
        return None, None
    lines = text.replace("\r\n", "\n").split("\n")
    title = lines[0].strip() or None
    price = None
    for ln in lines[1:]:
        s = ln.strip()
        if s.startswith("Giá:"):
            price = _to_int(s[4:].strip() or None, 10**15)
            break
    return title, price


# ---------------------------------------------------------------- đọc DB (SELECT)

def listing_snapshots(conn) -> dict:
    """{kênh: snapshot_id} — snapshot `listing` mới nhất mỗi kênh."""
    return {ch: sid for sid, ch in conn.execute(
        "select distinct on (channel) id, channel from market_snapshots"
        " where export_kind = 'listing'"
        " order by channel, imported_at desc, id desc").fetchall()}


def running_listings(conn, mapping: dict) -> tuple[list[dict], set]:
    """→ (dòng ĐANG BÁN của snapshot listing mới nhất mỗi kênh, tập kênh có
    snapshot). Status ∈ `inactive_status` của mapping → bỏ; status lạ/None
    = đang bán (fail-closed). `sale_price` lấy từ `raw` (v5.3, tùy chọn)."""
    snaps = listing_snapshots(conn)
    if not snaps:
        return [], set()
    rows = []
    for (sid, ch, rno, iid, ss, sku, title, price, status,
         sale) in conn.execute(
            "select snapshot_id, channel, row_no, item_id, seller_sku,"
            " sku_key, title, price_vnd, status, raw->>'sale_price'"
            " from market_rows where snapshot_id = any(%s)"
            " order by channel, row_no", (list(snaps.values()),)).fetchall():
        inactive = {unicodedata.normalize("NFC", s).strip() for s in (
            ((mapping.get(ch) or {}).get("listing") or {})
            .get("inactive_status", []))}
        if status is not None and \
                unicodedata.normalize("NFC", status).strip() in inactive:
            continue
        sp = None
        if sale is not None:
            with suppress(ValueError):
                sp = int(sale)
        rows.append({"snapshot_id": sid, "channel": ch, "row_no": rno,
                     "item_id": iid, "seller_sku": ss, "sku_key": sku,
                     "title": title, "price_vnd": price, "status": status,
                     "sale_price": sp})
    return rows, set(snaps)


def approved_drafts(conn) -> dict:
    """{(sku, kênh): {id, title, price}} — bản listing ĐÃ DUYỆT mới nhất mỗi
    (sku, kênh) theo (reviewed_at, id)."""
    out = {}
    for did, sku, ch, text in conn.execute(
            "select distinct on (sku, channel) id, sku, channel, text"
            " from content_drafts where content_type = 'listing'"
            " and status = 'approved' and sku is not null"
            " order by sku, channel, reviewed_at desc nulls last, id desc"
    ).fetchall():
        title, price = parse_draft(text)
        out[(sku, ch)] = {"id": did, "title": title, "price": price}
    return out


def golden_skus(conn) -> dict:
    return {k: {"category": c} for k, c in conn.execute(
        "select sku_key, category from sku_master order by sku_key")}


def readiness_map(conn) -> dict:
    return {(k, ch): lv for k, ch, lv in conn.execute(
        "select sku_key, channel, readiness from sku_readiness")}


def golden_prices(conn, today: date) -> dict:
    """{(sku, kênh): {kind: {price, id, approved}}} — giá thường trực
    (program_id null) `list`/`floor` hiệu lực ngày `today`; nhiều dòng mở
    (lỗi dữ liệu) → lấy dòng valid_from/id mới nhất."""
    out: dict = {}
    for sku, ch, kind, price, pid, by in conn.execute(
            "select sku_key, channel, kind, price_vnd, id, approved_by"
            " from price_list where program_id is null"
            " and kind in ('list', 'floor') and valid_from <= %s"
            " and (valid_to is null or valid_to > %s)"
            " order by valid_from, id", (today, today)).fetchall():
        out.setdefault((sku, ch), {})[kind] = {
            "price": price, "id": pid, "approved": by is not None}
    return out


def list_prices(prices: dict) -> dict:
    """{(sku, kênh): giá list} từ `golden_prices`."""
    return {k: v["list"]["price"] for k, v in prices.items() if "list" in v}


def open_v33_alerts(conn, kinds: tuple) -> dict:
    """{(kind, kênh, item_id, seller_sku): id} cảnh báo v3.3 đang mở."""
    return {(k, ch, i or "", s or ""): aid for aid, k, ch, i, s in
            conn.execute(
                "select id, kind, channel, item_id, seller_sku from"
                " market_alerts where status = 'open' and export_kind ="
                " 'listing' and kind = any(%s) order by id",
                (list(kinds),)).fetchall()}


def seen_ids(conn, prefix: str) -> set:
    """(object_type, object_id) đã có trong hàng duyệt Ở BẤT KỲ status."""
    return {(t, o) for t, o in conn.execute(
        "select object_type, object_id from approval_queue"
        " where object_id like %s", (prefix + ":%",)).fetchall()}


# ---------------------------------------------------------------- luật (THUẦN)

def _finding(kind, ch, row, sku, evidence) -> dict:
    iid = (row or {}).get("item_id")
    ss = (row or {}).get("seller_sku")
    key = iid or ss or sku or "-"
    return {"kind": kind, "severity": SEVERITY[kind], "channel": ch,
            "item_id": iid, "seller_sku": ss, "sku_key": sku,
            "evidence": evidence,
            "object_id": (f"a4:{kind}:{ch}:{ref_code(key)}:"
                          f"{evidence_sha({'sku': sku, **evidence})}")}


def diff_catalog(listings: list[dict], drafts: dict, skus: dict,
                 readiness: dict, prices: dict, channels) -> dict:
    """THUẦN, tất định → {"findings": [...], "unmapped": n,
    "no_snapshot": [kênh]}. `prices` = {(sku, kênh): giá list golden};
    `channels` = kênh CÓ snapshot listing; readiness thiếu key = CAM."""
    findings: list[dict] = []
    channels = set(channels)
    unmapped = 0
    running: set = set()
    for r in listings:
        ch, sku = r["channel"], r.get("sku_key")
        if sku is None:
            unmapped += 1
            continue
        running.add((sku, ch))
        lv = readiness.get((sku, ch), "CAM")
        if (skus.get(sku) or {}).get("category") == "alcohol" or lv == "CAM":
            findings.append(_finding("unready_listed", ch, r, sku,
                                     {"readiness": "CAM"}))
            continue
        d = drafts.get((sku, ch))
        if d is None:
            findings.append(_finding("no_approved_draft", ch, r, sku,
                                     {"price_san": r.get("price_vnd")}))
            continue
        if norm_title(r.get("title")) != norm_title(d["title"]):
            findings.append(_finding("title_drift", ch, r, sku, {
                "draft_id": d["id"],
                "title_san_sha": evidence_sha({"t": norm_title(
                    r.get("title"))})}))
        if d["price"] is not None and r.get("price_vnd") != d["price"]:
            findings.append(_finding("price_drift", ch, r, sku, {
                "draft_id": d["id"], "price_san": r.get("price_vnd"),
                "price_draft": d["price"]}))
    # Bản duyệt cũ: xét MỌI bản duyệt của SKU đủ điều kiện listing (kể cả
    # chưa lên sàn / kênh web) — đăng bản cũ = sai giá golden.
    for (sku, ch), d in sorted(drafts.items()):
        if readiness.get((sku, ch)) not in LISTABLE or \
                (skus.get(sku) or {}).get("category") == "alcohol":
            continue
        g = prices.get((sku, ch))
        if d["price"] != g:
            findings.append(_finding("draft_stale", ch, None, sku, {
                "draft_id": d["id"], "price_draft": d["price"],
                "price_golden": g}))
    for ch in sorted(channels):
        for sku in sorted(skus):
            if readiness.get((sku, ch)) in LISTABLE and \
                    (skus[sku].get("category") != "alcohol") and \
                    (sku, ch) not in running:
                findings.append(_finding("missing_listing", ch, None, sku,
                                         {"readiness": readiness[(sku, ch)]}))
    findings.sort(key=lambda f: (f["severity"], f["kind"], f["channel"],
                                 f["item_id"] or "", f["sku_key"] or ""))
    return {"findings": findings, "unmapped": unmapped,
            "no_snapshot": sorted(set(CHANNELS) - channels)}


def mark_dups(findings: list[dict], v33: dict) -> None:
    """Gắn `dup_alert` = id cảnh báo v3.3 đang mở cùng nghĩa (không đẩy)."""
    for f in findings:
        k = V33_DUP.get(f["kind"])
        if k:
            aid = v33.get((k, f["channel"], f["item_id"] or "",
                           f["seller_sku"] or ""))
            if aid is not None:
                f["dup_alert"] = aid


def object_type(f: dict) -> str:
    return "market_alert_s1" if f["severity"] == "S1" else "listing_sync"


def _where(f: dict) -> str:
    """Vị trí trong payload: mã sàn; SKU chỉ in khi KHÔNG thuộc nhóm CAM."""
    parts = [f"kênh {f['channel']}"]
    if f.get("item_id"):
        parts.append(f"mã sản phẩm sàn {ref_code(f['item_id'])}")
    if f["kind"] != "unready_listed" and f.get("sku_key"):
        parts.append(f"SKU {ref_code(f['sku_key'])}")
    return ", ".join(parts)


def payload_of(f: dict) -> tuple[str, str]:
    """(title, payload) từ TEMPLATE — không chép tiêu đề/mô tả listing."""
    ev, kind = f["evidence"], f["kind"]
    label = KIND_LABELS[kind]
    where = _where(f)
    if kind == "unready_listed":
        body = (f"Cảnh báo sàn S1 (A4 catalog): {label} — {where}; mức sẵn"
                " sàng golden CAM. Việc cần làm: Quản lý MXH ẩn listing"
                " trên Seller Center sau khi GĐ bán hàng/Pháp chế xác nhận.")
    elif kind == "title_drift":
        body = (f"Lệch listing (A4, NHÁP): {label} — {where}; bản duyệt là"
                f" nháp listing #{ev['draft_id']}. Việc cần làm: MXH sửa"
                " tiêu đề trên Seller Center theo bản duyệt SAU KHI GĐ bán"
                " hàng duyệt mục này.")
    elif kind == "price_drift":
        body = (f"Lệch listing (A4, NHÁP): {label} — {where}; giá trên sàn"
                f" {vnd(ev['price_san'])}, giá bản duyệt"
                f" {vnd(ev['price_draft'])} (nháp listing #{ev['draft_id']})."
                " Việc cần làm: MXH sửa trên Seller Center SAU KHI GĐ bán"
                " hàng duyệt mục này.")
    elif kind == "draft_stale":
        body = (f"Lệch listing (A4, NHÁP): {label} — {where}; giá trong bản"
                f" duyệt {vnd(ev['price_draft'])} (nháp listing"
                f" #{ev['draft_id']}), giá list golden đang mở"
                f" {vnd(ev['price_golden'])}. Việc cần làm: sinh lại nháp"
                " listing (MKT-02, SOP mục 4 'Sinh listing hàng loạt') để Pháp"
                " chế/GĐ bán hàng duyệt lại.")
    elif kind == "no_approved_draft":
        body = (f"Lệch listing (A4, NHÁP): {label} — {where}; giá trên sàn"
                f" {vnd(ev['price_san'])}. Việc cần làm: sinh nháp listing"
                " (MKT-02, SOP mục 4 'Sinh listing hàng loạt') để duyệt, rồi MXH"
                " đối chiếu listing trên Seller Center.")
    else:   # missing_listing
        body = (f"Lệch listing (A4, NHÁP): {label} — {where}; mức sẵn sàng"
                f" {ev['readiness']}. Việc cần làm: GĐ bán hàng quyết có mở"
                " listing không; nếu mở, MXH đăng tay theo bản listing đã"
                " duyệt.")
    title = f"{label} — {where}"
    return title, f"{body} {NO_AUTO}"


def to_items(findings: list[dict], cfg: dict) -> list[dict]:
    """Phát hiện → mục sẽ đẩy (bỏ mục trùng cảnh báo v3.3)."""
    types = cfg["object_types"]
    out = []
    for f in findings:
        if f.get("dup_alert") is not None:
            continue
        ot = object_type(f)
        title, payload = payload_of(f)
        out.append({"object_type": ot, "object_id": f["object_id"],
                    "title": f"{types[ot]['label']} — {title}",
                    "payload": payload})
    return out


def enqueue_new(conn, items: list[dict], cfg: dict, seen: set,
                agent: str) -> int:
    """Đẩy qua `director.submit` mục chưa có (mọi status) → số mục mới."""
    n = 0
    for it in items:
        if (it["object_type"], it["object_id"]) in seen:
            continue
        try:
            director.submit(conn, BLOCK, it["object_type"], it["object_id"],
                            it["title"], it["payload"], agent, cfg=cfg)
        except psycopg.errors.UniqueViolation:
            continue          # cùng mục vừa được đẩy song song
        seen.add((it["object_type"], it["object_id"]))
        n += 1
    return n


# ---------------------------------------------------------------- báo cáo

def render_report(res: dict, today: date, plan: dict | None = None) -> str:
    """THUẦN, tất định. Không in tiêu đề listing; nhóm CAM không in SKU."""
    fs = res["findings"]
    L = [f"# Đồng bộ catalog/listing đa sàn (A4) — {today:%d/%m/%Y}", "",
         ("Agent CHỈ ĐỌC: so listing đang chạy (file Seller Center mới nhất"
          " mỗi kênh) với bản listing đã duyệt + golden. Agent KHÔNG sửa"
          " sàn — mọi việc là NHÁP trong hàng duyệt khối KD."), ""]
    for ch in res["no_snapshot"]:
        L.append(f"- [warn] chưa có file listing {ch} — không kiểm thiếu"
                 " listing kênh này")
    L.append(f"- Dòng listing chưa map SKU (đã là cảnh báo sàn v3.3):"
             f" {res['unmapped']}")
    if plan is not None:
        L.append(f"- Sẽ đẩy mục mới: {plan['new']} · đã có trong hàng duyệt:"
                 f" {plan['seen']} · trùng cảnh báo sàn: {plan['dup']}")
    for sev in ("S1", "S2"):
        part = [f for f in fs if f["severity"] == sev]
        L += ["", f"## {sev} ({len(part)})", ""]
        for f in part:
            dup = (f" (đã có cảnh báo sàn #{f['dup_alert']})"
                   if f.get("dup_alert") is not None else "")
            L.append(f"- {KIND_LABELS[f['kind']]} — {_where(f)}{dup}")
        if not part:
            L.append("- (không có)")
    L += ["", "---", "*BẢN NHÁP — hệ thống không tự gửi, không tự sửa sàn.*",
          ""]
    return "\n".join(L)


# ---------------------------------------------------------------- CLI

def analyze(conn, mapping: dict, today: date) -> dict:
    """CHỈ SELECT → kết quả `diff_catalog` + `dup_alert`."""
    rows, chans = running_listings(conn, mapping)
    res = diff_catalog(rows, approved_drafts(conn), golden_skus(conn),
                       readiness_map(conn),
                       list_prices(golden_prices(conn, today)), chans)
    mark_dups(res["findings"], open_v33_alerts(conn,
                                               tuple(V33_DUP.values())))
    return res


def plan_of(items: list[dict], findings: list[dict], seen: set) -> dict:
    return {"new": sum((i["object_type"], i["object_id"]) not in seen
                       for i in items),
            "seen": sum((i["object_type"], i["object_id"]) in seen
                        for i in items),
            "dup": sum(f.get("dup_alert") is not None for f in findings)}


def _main(args, mapping: dict, cfg: dict) -> int:
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        today = vn_date(datetime.now(VN_TZ))
        res = analyze(conn, mapping, today)
        items = to_items(res["findings"], cfg)
        seen = seen_ids(conn, "a4")
        plan = plan_of(items, res["findings"], seen)
        for ch in res["no_snapshot"]:
            print(f"[warn] chưa có file listing {ch}")
        n_s1 = sum(f["severity"] == "S1" for f in res["findings"])
        print(f"[A4] {len(res['findings'])} phát hiện (S1 {n_s1}) · dòng"
              f" chưa map {res['unmapped']}")
        if args.report:
            # P8.4: listing sàn từ file xuất Seller Center (không cột mẫu).
            path = write_report(render_report(res, today, plan),
                                args.out_dir,
                                f"catalog-sync-{today:%Y-%m-%d}.md",
                                sample=False)
            print(f"[report] {path}")
        elif args.dry_run:
            for f in res["findings"]:
                print(f"  [{f['severity']}] {KIND_LABELS[f['kind']]} —"
                      f" {_where(f)}")
            print(f"[dry-run] sẽ đẩy {plan['new']} mục mới · đã có"
                  f" {plan['seen']} · trùng cảnh báo sàn {plan['dup']}"
                  " — KHÔNG ghi DB")
        else:
            n = enqueue_new(conn, items, cfg, seen, AGENT)
            conn.commit()     # đóng tx đọc (conn chia sẻ)
            print(f"[run] đẩy {n} mục mới vào hàng duyệt khối {BLOCK}")
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_clean(_db_msg(e), 300)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_listing",
        description="KD-A4 — so listing đang chạy trên sàn với bản duyệt + "
                    "golden → NHÁP hàng duyệt (agent KHÔNG sửa sàn)")
    ap.add_argument("--run", action="store_true",
                    help="đẩy mục lệch mới vào hàng duyệt khối KD")
    ap.add_argument("--report", action="store_true",
                    help="báo cáo catalog-sync-<ngày>.md → data/reports/")
    ap.add_argument("--dry-run", action="store_true",
                    help="với --run: chỉ đọc, in kế hoạch")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    args = ap.parse_args(argv)
    n_ops = sum([args.run, args.report])
    if n_ops > 1:
        ap.error("chỉ được 1 thao tác mỗi lần (--run | --report)")
    if n_ops == 0:
        ap.error("cần --run hoặc --report")
    if args.dry_run and not args.run:
        ap.error("--dry-run chỉ đi với --run")
    from pipelines import rollout
    # r19 (r12 RB): tắt → không đọc listing/in kế hoạch/đẩy mục, cả --dry-run.
    if args.run and (why := rollout.blocked(None, "rà listing sàn",
                                            fid="sales-03")):
        return rollout.say_blocked(why)
    mapping, why = load_mapping()
    if mapping is None:
        print(f"[error] {why}", file=sys.stderr)
        return 1
    try:
        cfg = director.load_config(BLOCK)
        if "listing_sync" not in cfg["object_types"] or \
                "market_alert_s1" not in cfg["object_types"]:
            raise DirectorConfigError("sales.json thiếu loại việc"
                                      " listing_sync/market_alert_s1")
    except DirectorConfigError as e:
        print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
        return 1
    if not args.run or args.dry_run:
        return _main(args, mapping, cfg)
    # Ghi lần chạy vào job_runs (bản tin GĐ KD mục 6 + sức khỏe F17.2).
    with job_run(JOB) as r:
        rc = _main(args, mapping, cfg)
        r["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
