"""v14.5 ceo-04.1 → đợt hoàn thiện 22/10: ceo-04.5 — Kiểm soát nội bộ: so KM/voucher ĐANG CHẠY với bản đã duyệt.

PL01 mục 2 (Ban TGĐ/HĐTV/BKS — Kiểm soát nội bộ): "mỗi ngày so bài đăng,
giá, voucher đang chạy với bản đã duyệt". Bài đăng/listing = `agents.
ceo_audit` (CHỈ ĐỌC, giữ nguyên); giá = cảnh báo `price_mismatch`; module này
khép phần VOUCHER/KM — tách riêng để `ceo_audit` (section trang TGĐ) vẫn
không có đường ghi nào.

ĐANG CHẠY = (1) listing sàn mới nhất mỗi kênh có giá bán thực (`sale_price`)
< giá niêm yết (KM đang áp trên sản phẩm — `kd_listing.running_listings`) +
(2) file xuất KM/voucher Seller Center (`--running`, cùng định dạng CSV kế
hoạch của `kd_price --plan`, đọc bằng `kd_price.read_plan` — module đó KHÔNG
bị sửa; chỉ dòng có ngày hôm nay nằm trong khoảng). BẢN ĐÃ DUYỆT = (a) kế
hoạch KM do GĐ bán hàng chốt (`--plan`, nguồn của `kd_price --plan`; sha256
file ghi trong payload) + (b) giá KM golden `price_list` kind='promo' ĐÃ
duyệt (`approved_by`) hiệu lực hôm nay. So THUẦN (`compare_promos`), mã:
  km_ngoai_ke_hoach   SKU × kênh có KM chạy mà không có bản duyệt hiệu lực
  km_khac_loai        có bản duyệt nhưng khác loại KM (voucher/flash…)
  km_sau_hon_duyet    giá sau KM thấp hơn mức thấp nhất bản duyệt cho phép
  km_qua_thoi_gian    KM chạy tới sau ngày kết thúc của bản duyệt
  km_khong_so_duoc    thiếu giá list golden để quy % ↔ giá (không suy)
  khong_xac_dinh_sku  listing có KM nhưng không map SKU (fail-closed)
Lệch → mục `ceo/promo_deviation` (TGĐ/BKS) — khóa theo ĐỢT
`km:<khóa lệch>:<bằng chứng>` (bằng chứng = snapshot listing / sha file):
lệch đang chờ duyệt → không đẩy thêm; đã quyết mà file/snapshot MỚI vẫn lệch
→ đợt mới. Payload chỉ kênh/mã SKU (nhóm rượu ẩn)/số/nguồn — không tiêu đề
listing. Agent KHÔNG đổi KM/giá, không gọi sàn. Tính năng tắt → exit 2.

Chạy: python -m agents.ceo_promo [--plan CSV] [--running CSV]
                                 [--as-of YYYY-MM-DD] [--dry-run]
Exit: 0 ok (có lệch vẫn 0) · 1 file kế hoạch/KM không hợp lệ (trước connect)
· 2 cấu hình hỏng / DB down / lỗi DB / tính năng tắt / tham số sai.
"""

import argparse
import sys
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path

import psycopg

from agents.ceo_audit import NO_SKU
from agents.ra_kenh import safe
from ingest.lead_store import connect
from pipelines import store
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

FEATURE_PROMO = "ceo-04.5"
OT_PROMO = "promo_deviation"
PROMO_AGENT = "agent:ceo_audit"
KM_NGOAI, KM_LOAI = "km_ngoai_ke_hoach", "km_khac_loai"
KM_SAU, KM_HAN = "km_sau_hon_duyet", "km_qua_thoi_gian"
KM_KSD = "km_khong_so_duoc"
PROMO_LABELS = {
    KM_NGOAI: "KM đang chạy không có bản duyệt hiệu lực",
    KM_LOAI: "KM đang chạy khác loại với bản duyệt",
    KM_SAU: "giá sau KM thấp hơn mức bản duyệt cho phép",
    KM_HAN: "KM chạy quá ngày kết thúc của bản duyệt",
    KM_KSD: "không so được (thiếu giá list golden)",
    NO_SKU: "listing có KM nhưng không xác định được SKU"}


def _price_of(p: dict, lst):
    """Giá sau KM của 1 dòng (Fraction) | None khi cần list mà thiếu."""
    from fractions import Fraction
    if p.get("price") is not None:
        return Fraction(p["price"])
    if p.get("pct") is not None and lst:
        return Fraction(lst) * (100 - p["pct"]) / 100
    return None


def compare_promos(running: list[dict], approved: list[dict], lists: dict,
                   today) -> dict:
    """THUẦN. running = [{src listing|file, channel, sku, kind (None =
    không rõ), price|pct, start, end (None = không rõ), ref, evidence}];
    approved = [{src plan|golden, channel, sku, kind (None = mọi loại),
    price|pct, start, end, ref}]; lists = {(sku, kênh): giá list}.
    → {findings, ok, planned_idle}."""
    live = [a for a in approved if a["start"] <= today
            and (a["end"] is None or a["end"] >= today)]
    findings, ok, used = [], 0, set()
    for r in running:
        base = {"channel": r["channel"], "sku": r["sku"], "src": r["src"],
                "ref": r["ref"], "evidence": r["evidence"], "run": r}
        if r["sku"] is None:
            findings.append(dict(base, code=NO_SKU, allowed=[]))
            continue
        cands = [a for a in live if a["channel"] == r["channel"]
                 and a["sku"] == r["sku"]]
        used |= {id(a) for a in cands}
        if not cands:
            findings.append(dict(base, code=KM_NGOAI, allowed=[]))
            continue
        if r["kind"] is not None:
            same = [a for a in cands if a["kind"] in (None, r["kind"])]
            if not same:
                findings.append(dict(base, code=KM_LOAI, allowed=cands))
                continue
            cands = same
        lst = lists.get((r["sku"], r["channel"]))
        rp = _price_of(r, lst)
        ap = [_price_of(a, lst) for a in cands]
        codes = []
        if rp is None or any(x is None for x in ap):
            codes.append(KM_KSD)
        elif rp < min(ap):
            codes.append(KM_SAU)
        ends = [a["end"] for a in cands]
        if (r["end"] is not None and None not in ends
                and r["end"] > max(ends)):
            codes.append(KM_HAN)
        if not codes:
            ok += 1
        findings += [dict(base, code=c, allowed=cands) for c in codes]
    idle = [a for a in live if id(a) not in used]
    return {"findings": sorted(findings, key=lambda f: (
        f["channel"], f["sku"] or "", f["code"], f["src"], f["ref"])),
        "ok": ok, "planned_idle": idle}


def _plan_rows(rows: list[dict], src: str, evidence: str) -> list[dict]:
    """Dòng `kd_price.read_plan` → dạng chung của `compare_promos`."""
    return [{"src": src, "channel": r["channel"], "sku": r["sku_key"],
             "kind": r["kind"], "price": r["price"], "pct": r["pct"],
             "start": r["start"], "end": r["end"],
             "ref": f"dòng {r['row_no']} chương trình {r['program_id']}",
             "evidence": evidence} for r in rows]


def promo_sources(conn, mapping: dict, today) -> dict:
    """CHỈ SELECT → {running listing, approved golden, lists, alcohol}."""
    from agents import kd_listing as kl
    rows, _chans = kl.running_listings(conn, mapping)
    running = []
    for m in rows:
        sp, lp = m["sale_price"], m["price_vnd"]
        if sp is None or lp is None or not 0 < sp < lp:
            continue
        ref = " · ".join(x for x in (kl.ref_code(m["item_id"]) if
                                     m["item_id"] else None,
                                     kl.ref_code(m["seller_sku"]) if
                                     m["seller_sku"] else None) if x)
        running.append({"src": "listing", "channel": m["channel"],
                        "sku": m["sku_key"], "kind": None, "price": sp,
                        "pct": None, "start": None, "end": None,
                        "ref": f"listing {ref or 'dòng ' + str(m['row_no'])}",
                        "evidence": f"s{m['snapshot_id']}"})
    golden = [{"src": "golden", "channel": ch, "sku": sku, "kind": None,
               "price": price, "pct": None, "start": vf,
               "end": (vt - timedelta(days=1)) if vt else None,
               "ref": f"price_list #{pid} chương trình {kl.ref_code(prog)}",
               "evidence": "g"}
              for pid, sku, ch, price, prog, vf, vt in conn.execute(
                  "select id, sku_key, channel, price_vnd, program_id,"
                  " valid_from, valid_to from price_list where kind ="
                  " 'promo' and approved_by is not null and program_id is"
                  " not null and valid_from <= %s and (valid_to is null or"
                  " valid_to > %s) order by id", (today, today)).fetchall()]
    lists = kl.list_prices(kl.golden_prices(conn, today))
    alcohol = {k for k, c in conn.execute(
        "select sku_key, category from sku_master") if c == "alcohol"}
    return {"running": running, "golden": golden, "lists": lists,
            "alcohol": alcohol}


def _vnd(x) -> str:
    return "—" if x is None else f"{int(x):,}".replace(",", ".") + " đ"


def _desc(p: dict, lst) -> str:
    from fractions import Fraction
    if p.get("price") is not None:
        s = f"giá KM {_vnd(p['price'])}"
    else:
        s = f"chiết khấu {p['pct']}%"
        pr = _price_of(p, lst)
        if isinstance(pr, Fraction):
            s += f" (≈ {_vnd(int(pr))})"
    if p.get("start") is not None:
        end = p.get("end")
        s += f", {p['start']:%d/%m/%Y}–" + (f"{end:%d/%m/%Y}" if end
                                             else "không hạn")
    return s


def promo_item(f: dict, lists: dict, alcohol: set, plan_sha: str | None
               ) -> dict:
    from agents import kd_listing as kl
    sku = ("nhóm hạn chế" if f["sku"] in alcohol else
           kl.ref_code(f["sku"]) if f["sku"] else "(chưa map SKU)")
    lst = lists.get((f["sku"], f["channel"]))
    allowed = "; ".join(f"{a['ref']} ({a['src']}): {_desc(a, lst)}"
                        for a in f["allowed"]) or "không có"
    key = "|".join([f["code"], f["channel"], f["sku"] or "", f["src"],
                    f["ref"], _desc(f["run"], lst), allowed])
    base = store.content_sha256(key)[:16]
    where = f"kênh {f['channel']}, SKU {sku}"
    plan = (f" Kế hoạch KM đối chiếu: sha256 {plan_sha[:12]}." if plan_sha
            else " Không có file kế hoạch KM (--plan) — chỉ đối chiếu giá"
                 " KM golden đã duyệt.")
    return {"object_type": OT_PROMO, "base": f"km:{base}:",
            "object_id": f"km:{base}:{f['evidence']}",
            "title": f"Kiểm soát KM — {PROMO_LABELS[f['code']]} — {where}"[:300],
            "payload": (
                f"Kiểm soát nội bộ ceo-04.5 (NHÁP): {where} — mã {f['code']}"
                f" ({PROMO_LABELS[f['code']]}). Đang chạy ({f['src']}"
                f" {f['ref']}): {_desc(f['run'], lst)}. Bản duyệt hiệu lực:"
                f" {allowed}. Giá list golden: {_vnd(lst)}.{plan} Việc cần"
                " làm: TGĐ/BKS yêu cầu GĐ bán hàng giải trình hoặc điều chỉnh"
                " trên Seller Center. Agent KHÔNG đổi KM/giá.")}


def promo_check(conn, today, *, mapping: dict, plan: list[dict] | None,
                running_file: list[dict] | None, plan_sha: str | None,
                running_sha: str | None, cfg: dict,
                dry_run: bool = False) -> dict:
    """So KM đang chạy ↔ bản duyệt → đẩy mục lệch theo đợt. Tắt →
    RolloutBlocked (0 ghi)."""
    from pipelines import director, rollout
    rollout.check_generate(conn, FEATURE_PROMO, "so KM đang chạy")
    src = promo_sources(conn, mapping, today)
    live = [r for r in running_file or []
            if r["start"] <= today <= r["end"]]    # file: chỉ dòng ĐANG chạy
    running = src["running"] + _plan_rows(live, "file",
                                          f"f{(running_sha or '')[:12]}")
    approved = src["golden"] + _plan_rows(plan or [], "plan", "p")
    res = compare_promos(running, approved, src["lists"], today)
    items = [promo_item(f, src["lists"], src["alcohol"], plan_sha)
             for f in res["findings"]]
    have = conn.execute("select object_id, status from approval_queue where"
                        " object_type = %s", (OT_PROMO,)).fetchall()
    conn.commit()
    exact = {o for o, _ in have}
    pending = {o.rsplit(":", 1)[0] + ":" for o, s in have if s == "pending"}
    new, seen = [], set()
    for it in items:
        if (it["object_id"] in exact or it["base"] in pending
                or it["object_id"] in seen):
            continue
        seen.add(it["object_id"])
        new.append(it)
    n = 0
    if not dry_run:
        for it in new:
            try:
                director.submit(conn, "ceo", OT_PROMO, it["object_id"],
                                it["title"], it["payload"], PROMO_AGENT,
                                cfg=cfg)
            except psycopg.errors.UniqueViolation:
                with suppress(Exception):
                    conn.rollback()
                continue
            n += 1
    return {**res, "running": len(running), "new": len(new),
            "enqueued": n, "items": items}


def _promo_main(a) -> int:
    import hashlib

    from agents import kd_price
    from ingest.market_csv import load_mapping
    from pipelines import auth, director, mkt_calendar
    from pipelines.rollout import RolloutBlocked

    mapping, why = load_mapping()
    if mapping is None:
        print(f"[error] {why}", file=sys.stderr)
        return 2
    try:
        cfg = director.load_config("ceo")
        if OT_PROMO not in cfg["object_types"]:
            raise ValueError(f"ceo.json thiếu loại việc {OT_PROMO}")
        cal = mkt_calendar.load_calendar()
    except (ValueError, mkt_calendar.CalendarError) as e:
        print(f"[error] cấu hình lỗi: {e} — không connect", file=sys.stderr)
        return 2
    files = {}
    for flag, path in (("--plan", a.plan), ("--running", a.running)):
        if path is None:
            continue
        rows, errs = kd_price.read_plan(path, kd_price.PROMO_KINDS, cal)
        if errs:
            print(f"[error] {flag} không hợp lệ — 0 dòng:", file=sys.stderr)
            for e in errs[:20]:
                print(f"  - {e}", file=sys.stderr)
            return 1
        files[flag] = (rows, hashlib.sha256(path.read_bytes()).hexdigest())
    today = a.as_of or datetime.now(VN_TZ).date()
    if why := auth.bind_service("job"):
        print(f"[err] {why}", flush=True)
        return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    plan, psha = files.get("--plan", (None, None))
    run, rsha = files.get("--running", (None, None))
    try:
        r = promo_check(conn, today, mapping=mapping, plan=plan,
                        running_file=run, plan_sha=psha, running_sha=rsha,
                        cfg=cfg, dry_run=a.dry_run)
    except RolloutBlocked as e:
        print(f"[rollout] {e}", file=sys.stderr)
        return 2
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        print(f"[error] lỗi DB: {safe(_mask_pii(store._db_msg(e)))[:300]}",
              file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    tag = "dry-run" if a.dry_run else "promo"
    print(f"[{tag}] ngày {today:%Y-%m-%d}: {r['running']} KM đang chạy, khớp"
          f" {r['ok']}, lệch {len(r['findings'])} (mới {r['new']}), bản"
          f" duyệt chưa thấy chạy {len(r['planned_idle'])} · đẩy"
          f" {r['enqueued']} mục" + (" — KHÔNG ghi DB" if a.dry_run else ""))
    for it in r["items"]:
        print(f"  - {it['title']}")
    if plan is None:
        print("[info] không có --plan — chỉ đối chiếu giá KM golden đã duyệt")
    return 0


def _day(s: str):
    from agents.kd_price import coerce_day
    try:
        return coerce_day(s)
    except ValueError:
        raise argparse.ArgumentTypeError("cần ngày YYYY-MM-DD") from None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ceo_promo",
        description="ceo-04.5: so KM/voucher đang chạy với bản đã duyệt →"
                    " mục ceo/promo_deviation (agent KHÔNG đổi KM/giá)")
    ap.add_argument("--plan", type=Path, help="kế hoạch KM ĐÃ duyệt (CSV"
                    " định dạng kd_price --plan)")
    ap.add_argument("--running", type=Path, help="file xuất KM/voucher đang"
                    " chạy (cùng định dạng CSV)")
    ap.add_argument("--as-of", type=_day, help="ngày so (YYYY-MM-DD),"
                    " mặc định hôm nay giờ VN")
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ đọc, không đẩy hàng duyệt")
    return _promo_main(ap.parse_args(argv))


if __name__ == "__main__":
    with job_run("agents.ceo_promo") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
