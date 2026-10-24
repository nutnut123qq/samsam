"""Đợt hợp đồng C04 — sales-03 "Listing đa sàn: một bản mô tả chuẩn cho mỗi
sản phẩm, xuất ra mọi sàn đúng giá đã duyệt".

  - MÔ TẢ CHUẨN của 1 SKU = nháp `content_drafts` loại `listing` kênh `web`
    (khung thông số do code dựng từ golden — `pipelines.content`) ĐÃ được
    NGƯỜI duyệt và `verify_publish` còn đúng (sửa sau duyệt → sha lệch →
    không dùng, phải duyệt lại). Phiên bản = id nháp. Không bảng sản phẩm
    thứ hai: tên/quy cách/ĐKSP/giá luôn từ golden.
  - XUẤT cho sàn (shopee|tiktok): mô tả = văn bản chuẩn NGUYÊN VĂN bỏ đúng
    dòng `Giá: …` (biến đổi tất định `bo_dong_gia`, ghi trong manifest) +
    giá `list` của kênh đích ĐÃ duyệt còn hiệu lực trong `price_list` (đợt an
    toàn S03: trước đây lấy golden JSON; không fallback JSON/kênh khác/floor/
    promo/giá chờ duyệt; manifest ghi id dòng giá → `--verify` phát hiện giá
    đổi/hết hiệu lực) ở cột riêng. Kênh
    đích phải qua `content.precheck` (readiness) + `guardrail.check_publish`
    (listing, kênh đích) — không đạt → từ chối, không ghi tệp. Cổng rollout
    sales-03 (biên DÙNG). Tệp CSV (utf-8-sig) + manifest JSON (sha nháp,
    sha mô tả, sha tệp, giá + nguồn, trạng thái mapping). Agent KHÔNG đăng /
    cập nhật sàn: người tải tệp lên Seller Center.
  - Cột tệp theo `data/listing_export_map.json` — CHƯA XÁC MINH với mẫu tải
    lên thật của sàn (UNVERIFIED_LIVE); chỉ đổi tiêu đề cột khi có mẫu thật.
  - `--verify MANIFEST`: tính lại từ DB + golden + tệp → khớp/lệch (exit 1).

  - Đợt hoàn thiện 22/10 (PL01 mục 3a/3c — website bán hàng làm ở repo
    riêng; "một bản mô tả, một bảng giá cho mọi kênh"): `--website-feed`
    xuất NGUỒN DỮ LIỆU cho website (JSON + manifest sha): mỗi SKU golden 1
    dòng; chỉ bán được (`gio_hang` true) khi kênh `web` qua precheck +
    guardrail, có mô tả chuẩn ĐÃ duyệt và giá `list` kênh web ĐÃ duyệt còn
    hiệu lực trong `price_list` (vá controller 22/10 F2: trước đây lấy giá
    từ golden JSON → DB chưa có giá duyệt vẫn bật giỏ; nay KHÔNG fallback
    JSON/kênh khác/floor/promo; đọc bảng giá lỗi → từ chối, không ghi tệp);
    RƯỢU luôn ẩn giá + không giỏ hàng ở MỌI trường hợp. Dòng không bán được
    ghi `ly_do` cụ thể (không bịa giá/mô tả). Không đẩy lên website: bên
    website đọc tệp/manifest (hợp đồng dữ liệu docs/handover/doi-chieu-docx.md).

Chạy:
  python -m agents.listing_export --sku K --channel shopee|tiktok --out DIR
  python -m agents.listing_export --verify DIR/listing-...manifest.json
  python -m agents.listing_export --website-feed --out DIR
"""

import argparse
import csv
import hashlib
import io
import json
import os
import sys
from pathlib import Path

import psycopg

from ingest.lead_store import connect
from pipelines import content, guardrail, store

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAP_FILE = ROOT / "data" / "listing_export_map.json"
FEATURE = "sales-03"
CHANNELS = ("shopee", "tiktok")
TRANSFORM = "bo_dong_gia"
FIELDS = ("sku_key", "ten_san_pham", "mo_ta", "quy_cach", "so_dksp",
          "gia_vnd")


class ExportError(ValueError):
    """Từ chối xuất — không ghi tệp."""


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def load_map(path=MAP_FILE) -> dict:
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        cols = {ch: doc["channels"][ch]["columns"] for ch in CHANNELS}
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ExportError(f"{Path(path).name} hỏng ({type(e).__name__})"
                          ) from None
    for ch, c in cols.items():
        if not (isinstance(c, dict) and set(c) == set(FIELDS)
                and all(isinstance(v, str) and v.strip()
                        for v in c.values())):
            raise ExportError(f"{Path(path).name}: cột kênh {ch} phải đủ "
                              f"{FIELDS}")
    return {"status": str(doc.get("status") or ""), "columns": cols}


def master(conn, sku: str) -> tuple[int, str]:
    """(id nháp, văn bản) của mô tả chuẩn ĐÃ duyệt mới nhất còn khớp sha."""
    rows = conn.execute(
        "select id, text from content_drafts where content_type = 'listing'"
        " and channel = 'web' and sku = %s and status = 'approved'"
        " order by reviewed_at desc nulls last, id desc", (sku,)).fetchall()
    if not rows:
        raise ExportError(f"{sku}: chưa có mô tả chuẩn (listing web) được "
                          "người duyệt")
    did, text = rows[0]
    if not store.verify_publish(conn, did, text):
        raise ExportError(f"{sku}: mô tả chuẩn #{did} đã đổi sau duyệt "
                          "(sha lệch) — phải duyệt lại")
    return did, text


def describe(text: str) -> str:
    """Biến đổi tất định `bo_dong_gia`: bỏ dòng bắt đầu `Giá:`."""
    return "\n".join(ln for ln in text.split("\n")
                     if not ln.startswith("Giá:"))


def build(conn, sku: str, channel: str, readiness=None, today=None) -> dict:
    """→ {"row", "manifest"} — chưa ghi tệp. Từ chối → ExportError.
    Giá = `list` kênh đích ĐÃ duyệt hiệu lực ngày `today` (mặc định hôm nay
    giờ VN) trong `price_list` — không JSON/kênh khác/floor/promo."""
    from pipelines import rollout
    if channel not in CHANNELS:
        raise ExportError(f"kênh phải {CHANNELS}")
    if why := rollout.use_reason(conn, FEATURE, "xuất listing cho sàn",
                                 human_reviewed=True):
        raise ExportError(why)
    if readiness is None:
        readiness = store.readiness_from_db(conn)
    if ref := content.precheck(sku, channel, "listing", readiness=readiness):
        raise ExportError(f"{sku} × {channel}: {ref['reason']}")
    did, text = master(conn, sku)
    desc = describe(text)
    g = guardrail.check_publish(desc, channel=channel, content_type="listing",
                                sku=sku, readiness=readiness)
    if g.get("ok") is not True:
        raise ExportError(f"{sku} × {channel}: guardrail không đạt "
                          + ",".join(str(v.get("code"))
                                     for v in g.get("violations") or []))
    f = content.listing_fields(sku, channel)
    today = today or _vn_today()
    lp = channel_prices(conn, today, channel).get(sku)
    if lp is None:
        raise ExportError(f"{sku} × {channel}: chưa có giá list kênh còn hiệu"
                          " lực trong price_list")
    if not lp["approved"]:
        raise ExportError(f"{sku} × {channel}: giá list #{lp['id']} đang CHỜ"
                          " người duyệt — không xuất")
    price = lp["price"]
    row = {"sku_key": sku, "ten_san_pham": f["name"], "mo_ta": desc,
           "quy_cach": f["pack_spec"] or "", "so_dksp": f["receipt_no"] or "",
           "gia_vnd": str(price)}
    return {"row": row, "manifest": {
        "sku": sku, "channel": channel, "draft_id": did,
        "approved_sha256": _sha(text), "transform": TRANSFORM,
        "description_sha256": _sha(desc), "gia_vnd": price,
        "gia_id": lp["id"], "gia_ngay_hieu_luc": today.isoformat(),
        "gia_nguon": "price_list kênh đích loại list ĐÃ duyệt, hiệu lực theo"
                     " ngày giờ VN (không fallback golden JSON/kênh khác/"
                     "floor/promo)"}}


def _csv(row: dict, cols: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([cols[k] for k in FIELDS])
    w.writerow([row[k] for k in FIELDS])
    return buf.getvalue().encode("utf-8-sig")


def _atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def export(conn, sku: str, channel: str, out_dir, readiness=None,
           map_path=MAP_FILE) -> Path:
    m = load_map(map_path)
    b = build(conn, sku, channel, readiness)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = f"listing-{channel}-{sku}-d{b['manifest']['draft_id']}"
    data = _csv(b["row"], m["columns"][channel])
    _atomic(out / f"{stem}.csv", data)
    man = {**b["manifest"], "file": f"{stem}.csv",
           "file_sha256": hashlib.sha256(data).hexdigest(),
           "mapping_status": m["status"]}
    mp = out / f"{stem}.manifest.json"
    _atomic(mp, (json.dumps(man, ensure_ascii=False, indent=2) + "\n")
            .encode("utf-8"))
    return mp


def verify(conn, manifest_path, readiness=None,
           map_path=MAP_FILE) -> list[str]:
    """Danh sách lệch (rỗng = khớp): mô tả chuẩn còn đúng bản đã duyệt, mô
    tả/giá/tệp tính lại trùng manifest."""
    mp = Path(manifest_path)
    man = json.loads(mp.read_bytes().decode("utf-8"))
    bad = []
    try:
        b = build(conn, man["sku"], man["channel"], readiness)
    except ExportError as e:
        return [f"không dựng lại được: {e}"]
    for k in ("draft_id", "approved_sha256", "description_sha256", "gia_vnd",
              "gia_id"):
        if b["manifest"][k] != man.get(k):
            bad.append(f"{k} lệch (hiện {b['manifest'][k]})")
    data = _csv(b["row"], load_map(map_path)["columns"][man["channel"]])
    f = mp.with_name(man["file"])
    if not f.is_file():
        bad.append("thiếu tệp CSV")
    else:
        if hashlib.sha256(f.read_bytes()).hexdigest() != man["file_sha256"]:
            bad.append("tệp CSV đã bị sửa (sha lệch manifest)")
        if hashlib.sha256(data).hexdigest() != man["file_sha256"]:
            bad.append("tệp dựng lại khác bản đã xuất")
    return bad


WEB = "web"
FEED_VERSION = 1


def channel_prices(conn, today, channel: str) -> dict:
    """{sku: {price, id, approved}} giá `list` kênh `channel` thường trực
    hiệu lực ngày `today` (giờ VN) — CÙNG quy tắc `kd_listing.golden_prices`
    (dòng mở mới nhất; `approved` = đã có người duyệt). Không đọc được bảng
    giá (thiếu bảng/quyền/DB lỗi) → ExportError: không bán bằng giá đoán."""
    from agents import kd_listing
    try:
        prices = kd_listing.golden_prices(conn, today)
    except psycopg.Error as e:
        raise ExportError("không đọc được bảng giá đã duyệt (price_list: "
                          f"{type(e).__name__}) — không xuất") from None
    return {sku: kinds["list"] for (sku, ch), kinds in prices.items()
            if ch == channel and "list" in kinds}


def web_prices(conn, today) -> dict:
    return channel_prices(conn, today, WEB)


def _vn_today():
    from datetime import datetime, timezone

    from pipelines.period import vn_date
    return vn_date(datetime.now(timezone.utc))


def website_row(conn, sku: str, gold: dict, readiness, prices=None,
                today=None) -> dict:
    """1 dòng nguồn dữ liệu website — golden (tên/quy cách) + mô tả ĐÃ duyệt
    + giá web ĐÃ duyệt từ DB (`prices` của `web_prices`; None → tự đọc ngày
    `today`, mặc định hôm nay giờ VN)."""
    if prices is None:
        prices = web_prices(conn, today or _vn_today())
    alcohol = gold.get("category") == "alcohol"
    row = {"sku_key": sku, "ten_san_pham": gold.get("name"),
           "quy_cach": gold.get("pack_spec"), "so_dksp": gold.get("receipt_no"),
           "mo_ta": None, "draft_id": None, "approved_sha256": None,
           "gia_vnd": None, "gia_id": None, "an_gia": alcohol,
           "gio_hang": False, "ly_do": []}
    if ref := content.precheck(sku, WEB, "listing", readiness=readiness):
        row["ly_do"].append(f"kênh web: {ref['reason']}")
    try:
        did, text = master(conn, sku)
    except ExportError as e:
        row["ly_do"].append(str(e))
    else:
        desc = describe(text)
        g = guardrail.check_publish(desc, channel=WEB, content_type="listing",
                                    sku=sku, readiness=readiness)
        if g.get("ok") is True:
            row.update(mo_ta=desc, draft_id=did, approved_sha256=_sha(text))
        else:
            row["ly_do"].append("guardrail không đạt " + ",".join(
                str(v.get("code")) for v in g.get("violations") or []))
    lp = prices.get(sku)
    ok_price = bool(lp and lp["approved"])
    if alcohol:
        row["ly_do"].append("rượu: ẩn giá + không giỏ hàng (PL01 mục 3a)")
    elif lp is None:
        row["ly_do"].append("chưa có giá list kênh web còn hiệu lực trong "
                            "price_list")
    elif not ok_price:
        row["ly_do"].append(f"giá list kênh web #{lp['id']} đang CHỜ người "
                            "duyệt — chưa dùng")
    else:
        row.update(gia_vnd=lp["price"], gia_id=lp["id"])
    row["gio_hang"] = (not alcohol and ok_price and row["mo_ta"] is not None
                       and not row["ly_do"])
    return row


def website_feed(conn, out_dir, readiness=None, now=None) -> Path:
    """Ghi website-feed-<ngày>.json + .manifest.json → đường manifest."""
    from datetime import datetime, timedelta, timezone

    from pipelines import rollout
    if why := rollout.use_reason(conn, FEATURE, "xuất nguồn dữ liệu website",
                                 human_reviewed=True):
        raise ExportError(why)
    if readiness is None:
        readiness = store.readiness_from_db(conn)
    golden = content._cfg()[0]["golden"]
    vn = (now or datetime.now(timezone.utc)).astimezone(
        timezone(timedelta(hours=7)))
    prices = web_prices(conn, vn.date())
    rows = [website_row(conn, k, golden[k], readiness, prices)
            for k in sorted(golden)]
    stem = f"website-feed-{vn:%Y-%m-%d}"
    data = (json.dumps({"version": FEED_VERSION, "rows": rows},
                       ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _atomic(out / f"{stem}.json", data)
    man = {"file": f"{stem}.json", "file_sha256": hashlib.sha256(
        data).hexdigest(), "version": FEED_VERSION, "so_sku": len(rows),
        "ban_duoc": sum(r["gio_hang"] for r in rows),
        "gia_nguon": "price_list kênh web loại list ĐÃ duyệt, hiệu lực theo"
                     " ngày giờ VN (không fallback golden JSON/kênh khác/"
                     "floor/promo)",
        "gia_ngay_hieu_luc": vn.date().isoformat(),
        "gia_phien_ban": {r["sku_key"]: r["gia_id"] for r in rows
                          if r["gia_id"] is not None},
        "mo_ta_nguon": "content_drafts listing kênh web ĐÃ duyệt (sha)"}
    mp = out / f"{stem}.manifest.json"
    _atomic(mp, (json.dumps(man, ensure_ascii=False, indent=2) + "\n")
            .encode("utf-8"))
    return mp


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.listing_export")
    ap.add_argument("--website-feed", action="store_true")
    ap.add_argument("--sku")
    ap.add_argument("--channel", choices=CHANNELS)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--verify", type=Path, metavar="MANIFEST")
    a = ap.parse_args(argv)
    if a.website_feed and not a.out:
        ap.error("--website-feed cần --out DIR")
    if not a.website_feed and a.verify is None and not (
            a.sku and a.channel and a.out):
        ap.error("cần --sku --channel --out, --verify MANIFEST hoặc "
                 "--website-feed --out DIR")
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres", file=sys.stderr)
        return 2
    try:
        if a.verify is not None:
            bad = verify(conn, a.verify)
            for b in bad:
                print(f"[LỆCH] {b}")
            print("[done] khớp bản đã duyệt" if not bad else
                  f"[done] {len(bad)} điểm lệch")
            return 1 if bad else 0
        if a.website_feed:
            try:
                mp = website_feed(conn, a.out)
            except ExportError as e:
                print(f"[từ chối] {e} — không ghi tệp", file=sys.stderr)
                return 1
            man = json.loads(mp.read_bytes().decode("utf-8"))
            print(f"[done] {mp.name} — {man['ban_duoc']}/{man['so_sku']} SKU"
                  " bán được trên web (còn lại ghi ly_do); agent không đẩy "
                  "lên website")
            return 0
        try:
            mp = export(conn, a.sku, a.channel, a.out)
        except ExportError as e:
            print(f"[từ chối] {e} — không ghi tệp", file=sys.stderr)
            return 1
        print(f"[done] {mp.name} — mapping CHƯA XÁC MINH với mẫu sàn; người "
              "tải lên Seller Center (agent không đăng)")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
