"""Đợt hợp đồng C04 — sales-03 "Listing đa sàn: một bản mô tả chuẩn cho mỗi
sản phẩm, xuất ra mọi sàn đúng giá đã duyệt".

  - MÔ TẢ CHUẨN của 1 SKU = nháp `content_drafts` loại `listing` kênh `web`
    (khung thông số do code dựng từ golden — `pipelines.content`) ĐÃ được
    NGƯỜI duyệt và `verify_publish` còn đúng (sửa sau duyệt → sha lệch →
    không dùng, phải duyệt lại). Phiên bản = id nháp. Không bảng sản phẩm
    thứ hai: tên/quy cách/ĐKSP/giá luôn từ golden.
  - XUẤT cho sàn (shopee|tiktok): mô tả = văn bản chuẩn NGUYÊN VĂN bỏ đúng
    dòng `Giá: …` (biến đổi tất định `bo_dong_gia`, ghi trong manifest) +
    giá `list` của kênh đích từ golden (không floor/promo) ở cột riêng. Kênh
    đích phải qua `content.precheck` (readiness) + `guardrail.check_publish`
    (listing, kênh đích) — không đạt → từ chối, không ghi tệp. Cổng rollout
    sales-03 (biên DÙNG). Tệp CSV (utf-8-sig) + manifest JSON (sha nháp,
    sha mô tả, sha tệp, giá + nguồn, trạng thái mapping). Agent KHÔNG đăng /
    cập nhật sàn: người tải tệp lên Seller Center.
  - Cột tệp theo `data/listing_export_map.json` — CHƯA XÁC MINH với mẫu tải
    lên thật của sàn (UNVERIFIED_LIVE); chỉ đổi tiêu đề cột khi có mẫu thật.
  - `--verify MANIFEST`: tính lại từ DB + golden + tệp → khớp/lệch (exit 1).

Chạy:
  python -m agents.listing_export --sku K --channel shopee|tiktok --out DIR
  python -m agents.listing_export --verify DIR/listing-...manifest.json
"""

import argparse
import csv
import hashlib
import io
import json
import os
import sys
from pathlib import Path

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


def build(conn, sku: str, channel: str, readiness=None) -> dict:
    """→ {"row", "manifest"} — chưa ghi tệp. Từ chối → ExportError."""
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
    gold = content._cfg()[0]["golden"][sku]
    price = ((gold.get("prices") or {}).get(channel) or {}).get("list")
    if not (isinstance(price, int) and not isinstance(price, bool)
            and price > 0):
        raise ExportError(f"{sku} × {channel}: golden thiếu giá list kênh")
    row = {"sku_key": sku, "ten_san_pham": f["name"], "mo_ta": desc,
           "quy_cach": f["pack_spec"] or "", "so_dksp": f["receipt_no"] or "",
           "gia_vnd": str(price)}
    return {"row": row, "manifest": {
        "sku": sku, "channel": channel, "draft_id": did,
        "approved_sha256": _sha(text), "transform": TRANSFORM,
        "description_sha256": _sha(desc), "gia_vnd": price,
        "gia_nguon": "data/golden_skus.json prices.<kênh>.list"}}


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
    for k in ("draft_id", "approved_sha256", "description_sha256", "gia_vnd"):
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.listing_export")
    ap.add_argument("--sku")
    ap.add_argument("--channel", choices=CHANNELS)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--verify", type=Path, metavar="MANIFEST")
    a = ap.parse_args(argv)
    if a.verify is None and not (a.sku and a.channel and a.out):
        ap.error("cần --sku --channel --out, hoặc --verify MANIFEST")
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
