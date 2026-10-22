"""Đợt hoàn thiện 22/10/2026 — kiểm sổ HỒ SƠ GỐC sản phẩm (production-02,
PL01 Sản xuất R&D "Hồ sơ gốc 14 sản phẩm (thành phần, quy cách, số công bố);
cấp dữ liệu chuẩn cho mọi kênh").

Sổ = `data/product_dossiers.json` (`danh_muc_ho_so_goc` do Bên B điền —
repo KHÔNG bịa thành phần/số hồ sơ). Module này chỉ KIỂM, không ghi DB:
  - cấu trúc từng hồ sơ: `ma_ho_so` (duy nhất), `ten`, `thanh_phan`,
    `quy_cach`, `so_cong_bo`, `loai` ∈ tpbvsk|food|alcohol, `sku_keys` (mã
    golden có thật), `xac_nhan_boi` (NGƯỜI — không agent:/system:), `can_cu`
    (văn bản/biên bản giao hồ sơ);
  - đối chiếu golden: mỗi SKU golden đúng 1 dòng `sku`; `ho_so_goc` null
    hoặc mã có trong danh mục; SKU đã gắn hồ sơ phải cùng số công bố;
  - đủ số: `so_ho_so_hop_dong` (14) hồ sơ + mọi SKU đã gắn.

  python -m ingest.product_dossiers --check [--file F] [--golden G]
Exit: 0 đủ + khớp · 1 sai cấu trúc/lệch (không dùng được) · 2 CHƯA ĐỦ dữ
liệu (BLOCKED — chờ Bên B), in rõ thiếu gì.
"""

import argparse
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DOSSIER_FILE = ROOT / "data" / "product_dossiers.json"
GOLDEN_FILE = ROOT / "data" / "golden_skus.json"
REQUIRED = ("ma_ho_so", "ten", "thanh_phan", "quy_cach", "so_cong_bo",
            "loai", "sku_keys", "xac_nhan_boi", "can_cu")
LOAI = ("tpbvsk", "food", "alcohol")


def _txt(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _human(v) -> bool:
    return _txt(v) and not v.strip().casefold().startswith(
        ("agent:", "system:", "auto_policy:"))


def _norm_no(v) -> str:
    return " ".join(str(v or "").split()).casefold()


def check(doc: dict, golden_skus: list[dict]) -> dict:
    """THUẦN → {errors: [...], missing: [...], dossiers, mapped, skus}."""
    errs, miss = [], []
    gold = {s["sku_key"]: s for s in golden_skus}
    items = doc.get("danh_muc_ho_so_goc")
    if not isinstance(items, list):
        return {"errors": ["danh_muc_ho_so_goc: phải là list"], "missing": [],
                "dossiers": 0, "mapped": 0, "skus": len(gold)}
    by_id: dict[str, dict] = {}
    for i, d in enumerate(items):
        w = f"danh_muc_ho_so_goc[{i}]"
        if not isinstance(d, dict):
            errs.append(f"{w}: phải là object")
            continue
        for k in REQUIRED:
            v = d.get(k)
            as_list = isinstance(v, list) and bool(v) and all(
                _txt(x) for x in v)
            if k == "sku_keys":
                ok = as_list
            elif k == "thanh_phan":        # chuỗi hoặc danh sách thành phần
                ok = as_list or _txt(v)
            else:
                ok = _txt(v)
            if not ok:
                errs.append(f"{w}.{k}: thiếu/rỗng")
        mid = d.get("ma_ho_so")
        if _txt(mid):
            if mid in by_id:
                errs.append(f"{w}.ma_ho_so: trùng {mid}")
            by_id[mid] = d
        if d.get("loai") not in LOAI:
            errs.append(f"{w}.loai: phải ∈ {'|'.join(LOAI)}")
        if _txt(d.get("xac_nhan_boi")) and not _human(d["xac_nhan_boi"]):
            errs.append(f"{w}.xac_nhan_boi: phải là NGƯỜI (không agent:/"
                        "system:)")
        for sk in d.get("sku_keys") or []:
            if sk not in gold:
                errs.append(f"{w}.sku_keys: '{sk}' không có trong golden")
            elif _norm_no(gold[sk].get("receipt_no")) and _norm_no(
                    d.get("so_cong_bo")) != _norm_no(gold[sk]["receipt_no"]):
                errs.append(f"{w}: số công bố lệch golden của {sk}")
    rows = doc.get("sku")
    rows = rows if isinstance(rows, list) else []
    seen = {}
    for r in rows:
        k = r.get("sku_key") if isinstance(r, dict) else None
        seen[k] = seen.get(k, 0) + 1
        hs = r.get("ho_so_goc") if isinstance(r, dict) else None
        if hs is not None and hs not in by_id:
            errs.append(f"sku[{k}].ho_so_goc: '{hs}' không có trong danh mục")
        if hs is not None and hs in by_id and k not in (
                by_id[hs].get("sku_keys") or []):
            errs.append(f"sku[{k}]: gắn {hs} nhưng hồ sơ không liệt kê SKU này")
    for k in gold:
        if seen.get(k) != 1:
            errs.append(f"sku: SKU golden '{k}' phải có đúng 1 dòng")
    mapped = sum(1 for r in rows if isinstance(r, dict) and r.get(
        "ho_so_goc") in by_id)
    need = doc.get("so_ho_so_hop_dong")
    if not isinstance(need, int) or isinstance(need, bool) or need < 1:
        errs.append("so_ho_so_hop_dong: phải là số nguyên ≥ 1")
        need = 0
    if len(by_id) < need:
        miss.append(f"danh mục hồ sơ gốc: {len(by_id)}/{need} (Bên B cung "
                    "cấp tên, thành phần, quy cách, số công bố + căn cứ)")
    if mapped < len(gold):
        miss.append(f"SKU golden đã gắn hồ sơ gốc: {mapped}/{len(gold)}")
    return {"errors": errs, "missing": miss, "dossiers": len(by_id),
            "mapped": mapped, "skus": len(gold)}


def _load(path: Path) -> dict:
    return json.loads(path.read_bytes().decode("utf-8"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ingest.product_dossiers",
                                 description="kiểm sổ hồ sơ gốc sản phẩm "
                                             "(chỉ đọc file, không DB)")
    ap.add_argument("--check", action="store_true", required=True)
    ap.add_argument("--file", type=Path, default=DOSSIER_FILE)
    ap.add_argument("--golden", type=Path, default=GOLDEN_FILE)
    a = ap.parse_args(argv)
    try:
        doc, gold = _load(a.file), _load(a.golden)["skus"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        print(f"[err] không đọc được sổ/golden ({type(e).__name__})")
        return 1
    if not isinstance(doc, dict) or not isinstance(gold, list):
        print("[err] sổ/golden sai cấu trúc")
        return 1
    r = check(doc, gold)
    for e in r["errors"]:
        print(f"[err] {e}")
    for m in r["missing"]:
        print(f"[blocked] {m}")
    print(f"[done] hồ sơ {r['dossiers']} · SKU golden {r['skus']} · đã gắn "
          f"{r['mapped']} · lỗi {len(r['errors'])}")
    if r["errors"]:
        return 1
    return 2 if r["missing"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
