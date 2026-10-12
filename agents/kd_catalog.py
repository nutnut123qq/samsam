"""v8.2 KD-A3 (WP11) — catalog quà Tết (tài liệu chào hàng B2B) từ golden
(v3.2) + BOM hộp quà (v9.2) + ma trận báo giá GIẢ ĐỊNH (`data/
b2b_pricing.json`). Đầu ra markdown + HTML in được (A4 — "In → Lưu PDF" ở
trình duyệt; PDF dựng sẵn + logo/font = external-dep).

Contract:
  - `eligible(golden, combos)` THUẦN: SKU `alcohol` / tên nhắc rượu → loại
    khỏi MỌI phần (excluded chỉ ghi key + mã `ruou`, không tên); TPBVSK
    `xnqc_status != 'approved'` → loại (`tpbvsk_chua_xnqc` — catalog = tài
    liệu chào hàng = quảng cáo); combo có thành phần bị loại / thành phần lạ /
    tên nhắc rượu → loại; food → vào.
  - `build` → payload markdown có nhãn "Quảng cáo", câu khuyến cáo khi có
    TPBVSK, giá tham khảo theo `base` + bậc CK (chỉ mục trong ma trận;
    ngoài → "liên hệ báo giá"), ảnh packshot `<dir>/<key>.png` (magic PNG)
    → dòng ảnh đường tương đối + sha256[:16] (không nhúng), thiếu → chờ
    công ty cấp. Text do TEMPLATE (không LLM) → cổng `check_publish(...,
    content_type="ads", is_ai=False)` + không rượu + không tên/key bị loại.
  - Không đường gửi: `--submit` → hàng duyệt `sales/b2b_catalog` (risk
    high); `--export`/`--verify-send` tái dùng `kd_quote` — GĐ bán hàng tự
    gửi file đã KHỚP bản duyệt.

Chạy:
  python -m agents.kd_catalog --build [--bom FILE] [--date D] [--out-dir DIR]
                              [--packshot-dir DIR]
  python -m agents.kd_catalog --submit [--bom FILE] [--date D]
                              [--packshot-dir DIR]
  python -m agents.kd_catalog --export QID --out FILE(.md|.html)
  python -m agents.kd_catalog --verify-send QID FILE
Exit: 0 ok · 1 bị chặn (cổng / ma trận / BOM lỗi / chưa duyệt / lệch hash)
· 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import hashlib
import sys
from contextlib import suppress
from datetime import date
from pathlib import Path

import psycopg

from agents import kd_quote as kq
from agents.report import REPORTS_DIR, write_report
from ingest.golden_store import GOLDEN_FILE, read_golden
from ingest.lead_store import connect
from pipelines import director, kb_filter
from pipelines.store import _db_msg

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

OBJECT_TYPE = "b2b_catalog"
CATALOG_TYPES = frozenset({OBJECT_TYPE})
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
MAX_PNG = 10 * 1024 * 1024
NO_PHOTO = "(ảnh: chờ packshot công ty cấp)"
REF_NOTE = ("Giá tham khảo — báo giá chính thức theo yêu cầu, hệ thống không"
            " tự gửi.")


def eligible(golden, combos) -> tuple[list[dict], list[dict]]:
    """→ (mục vào catalog, [{key, code}] bị loại — KHÔNG tên)."""
    g, c = kq.gidx(golden), kq.cidx(combos)
    items, excluded, bad = [], [], {}
    for k, s in g.items():
        if s.get("category") == "alcohol" or kb_filter.is_alcohol(
                s.get("name") or "") or kb_filter.is_alcohol(
                k.replace("-", " ")):
            bad[k] = "ruou"
        elif kq._tp_unapproved(s):
            bad[k] = "tpbvsk_chua_xnqc"
        elif s.get("category") not in ("food", "tpbvsk"):
            bad[k] = "loai_khong_ho_tro"
        else:
            items.append({"key": k, "kind": "sku", "name": s.get("name") or k,
                          "spec": s.get("pack_spec") or "—",
                          "parts": [(k, 1)],
                          "tp": s.get("category") == "tpbvsk"})
            continue
        excluded.append({"key": k, "code": bad[k]})
    for k in sorted(c):
        cb = c[k]
        parts = kq._parts(k, {}, c)
        if kb_filter.is_alcohol(cb.get("name") or "") or \
                kb_filter.is_alcohol(k.replace("-", " ")):
            code = "ruou"
        elif parts is None or any(s not in g for s, _ in parts):
            code = "thanh_phan_khong_ro"
        else:
            codes = {bad[s] for s, _ in parts if s in bad}
            code = "ruou" if "ruou" in codes else (min(codes) if codes
                                                   else None)
        if code:
            excluded.append({"key": k, "code": code})
            continue
        items.append({"key": k, "kind": "combo", "name": cb.get("name") or k,
                      "spec": " + ".join(f"{g[s].get('name') or s} ×{q}"
                                         for s, q in parts),
                      "parts": parts,
                      "tp": any(g[s].get("category") == "tpbvsk"
                                for s, _ in parts)})
    return items, excluded


def packshot(packshot_dir, key: str) -> str | None:
    """sha256[:16] của `<dir>/<key>.png` nếu là PNG thật (magic) ≤ 10 MB."""
    if packshot_dir is None or not kq._SLUG_RE.fullmatch(key or ""):
        return None
    p = Path(packshot_dir) / f"{key}.png"
    try:
        if not p.is_file():
            return None
        with p.open("rb") as fh:
            data = fh.read(MAX_PNG + 1)
    except OSError:
        return None
    if len(data) > MAX_PNG or not data.startswith(PNG_MAGIC):
        return None
    return hashlib.sha256(data).hexdigest()[:16]


def excluded_names(golden, combos, excluded) -> list[str]:
    g, c = kq.gidx(golden), kq.cidx(combos)
    out = []
    for e in excluded:
        k = e["key"]
        name = (g.get(k) or c.get(k) or {}).get("name")
        out += [k] + ([name] if name else [])
    return out


def build(golden, combos, matrix, *, day: date, packshot_dir=None) -> dict:
    """→ {payload, excluded, problems, n_items}. THUẦN trừ đọc packshot."""
    items, excluded = eligible(golden, combos)
    errs = kq.validate_matrix(matrix, golden, combos)
    if errs:
        return {"payload": "", "excluded": excluded, "problems":
                ["ma_tran_loi"], "n_items": 0, "matrix_errors": errs}
    if not items:
        return {"payload": "", "excluded": excluded,
                "problems": ["khong_co_san_pham"], "n_items": 0}
    g = kq.gidx(golden)
    shas: list[str] = []
    base = matrix["base"]
    r = matrix["rounding_vnd"]
    L = ["# Catalog quà Tết — Sâm Sâm", "", "Quảng cáo", "",
         f"- Ngày lập: {day:%d/%m/%Y}", f"- {REF_NOTE}", "", "## Sản phẩm"]
    for i, it in enumerate(items, 1):
        L += ["", f"### {i}. {kq._md(it['name'])}", ""]
        sha = packshot(packshot_dir, it["key"])
        if sha:
            shas.append(sha)
            L += [f"![{kq._md(it['name'])}](packshots/{it['key']}.png)", "",
                  f"- Ảnh: packshots/{it['key']}.png (sha256 {sha})"]
        else:
            L.append(f"- {NO_PHOTO}")
        lst = kq._sum_price(it["parts"], g, base["channel"], base["kind"])
        L += [f"- Quy cách: {kq._md(it['spec'])}",
              f"- Giá niêm yết: {kq.vnd(lst) if lst else 'liên hệ báo giá'}"]
        spec_m = matrix["items"].get(it["key"])
        if spec_m is None or not lst:
            L.append("- Giá theo số lượng: liên hệ báo giá")
            continue
        L += ["", "| Số lượng | Chiết khấu | Đơn giá tham khảo |",
              "|---|---|---|"]
        for t in matrix["tiers"]:
            ck = min(t["discount_pct"], spec_m["max_discount_pct"])
            unit = lst * (100 - ck) // (100 * r) * r
            L.append(f"| {t['min_qty']}–{t['max_qty']} | {ck}% | "
                     f"{kq.vnd(unit)} |")
    if any(it["tp"] for it in items):
        L += ["", kq.disclaimer() + "."]
    L += ["", REF_NOTE, ""]
    payload = "\n".join(L)
    problems = kq.gate_text(payload, excluded_names(golden, combos, excluded),
                            content_type="ads",
                            readiness=kq.readiness_map(golden), ids=shas)
    return {"payload": payload, "excluded": excluded, "problems": problems,
            "n_items": len(items)}


def _object_id(day: date, payload: str) -> str:
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]
    return f"catalog-tet-{day:%Y%m%d}-{sha}"


def submit(conn, built: dict, day: date) -> int | None:
    """→ qid | None (đã có mục pending/đã duyệt cùng nội dung)."""
    if built["problems"]:
        raise ValueError("catalog có problems — không vào hàng duyệt")
    oid = _object_id(day, built["payload"])
    row = conn.execute(
        "select id from approval_queue where object_type = %s and object_id"
        " = %s and status in ('pending', 'approved') limit 1",
        (OBJECT_TYPE, oid)).fetchone()
    if row:
        conn.commit()
        return None
    return director.submit(conn, kq.BLOCK, OBJECT_TYPE, oid,
                           f"Catalog quà Tết {day:%d/%m/%Y} "
                           f"({built['n_items']} mục)", built["payload"],
                           created_by="agent:kd_catalog")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_catalog",
        description="Catalog quà Tết B2B — NHÁP; không rượu, không TPBVSK "
                    "chưa XNQC; agent không tự gửi")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--export", type=int, metavar="QID")
    ap.add_argument("--verify-send", nargs=2, metavar=("QID", "FILE"))
    ap.add_argument("--bom", type=Path, metavar="FILE",
                    help="đọc combo từ file BOM (không DB) thay bom_combos")
    ap.add_argument("--date", type=kq._date_arg)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--packshot-dir", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    n_ops = (a.build + a.submit + (a.export is not None)
             + (a.verify_send is not None))
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --build | --submit | --export | "
                 "--verify-send")
    if not (a.build or a.submit) and (a.bom or a.date or a.packshot_dir):
        ap.error("--bom/--date/--packshot-dir chỉ dùng với --build/--submit")
    if (a.export is not None) != (a.out is not None):
        ap.error("--export cần --out FILE (.md|.html) và ngược lại")
    vqid = None
    if a.verify_send is not None:
        try:
            vqid = int(a.verify_send[0])
        except ValueError:
            ap.error("--verify-send QID phải là số")
    combos = None
    if a.build or a.submit:
        from pipelines.production import ProductionError, read_json
        golden, why = read_golden(GOLDEN_FILE)
        matrix, why2 = kq.read_matrix(kq.MATRIX_FILE)
        if golden is None or matrix is None:
            print(f"[error] {why or why2}", file=sys.stderr)
            return 1
        if a.bom is not None:
            try:
                combos = read_json(a.bom, "combos")["combos"]
            except ProductionError as e:
                print(f"[error] BOM: {e}", file=sys.stderr)
                return 1
    conn = None
    if not (a.build and combos is not None):
        conn = connect()
        if conn is None:
            print("[error] không kết nối được Postgres (DATABASE_URL thiếu "
                  "hoặc host chết)", file=sys.stderr)
            return 2
    try:
        if a.build or a.submit:
            if combos is None:
                from pipelines.production import db_combos
                combos = db_combos(conn)
                conn.commit()
            day = a.date or kq._today_vn()
            built = build(golden, combos, matrix, day=day,
                          packshot_dir=a.packshot_dir)
            print(f"[catalog] {built['n_items']} mục · loại "
                  f"{len(built['excluded'])}: "
                  + (", ".join(f"{e['key']}({e['code']})"
                               for e in built["excluded"]
                               if e["code"] != "ruou") or "—")
                  + f" · rượu loại {sum(e['code'] == 'ruou' for e in built['excluded'])}")
            if built["problems"]:
                print(f"[error] bị chặn: {', '.join(built['problems'])}",
                      file=sys.stderr)
                return 1
            if a.build:
                for ext, body in (("md", built["payload"]),
                                  ("html", kq.render_html(built["payload"]))):
                    p = write_report(body, a.out_dir,
                                     f"catalog-tet-{day:%Y-%m-%d}.{ext}")
                    print(f"[file] {p}")
                print("[done] NHÁP — --submit để vào hàng duyệt; HTML → In →"
                      " Lưu PDF")
                return 0
            try:
                qid = submit(conn, built, day)
            except psycopg.errors.UniqueViolation:
                with suppress(Exception):
                    conn.rollback()
                qid = None
            if qid is None:
                print("[skip] catalog cùng nội dung đã có mục pending/đã "
                      "duyệt — không ghi thêm")
                return 0
            print(f"[done] catalog → mục #{qid} `{OBJECT_TYPE}` (risk high —"
                  " GĐ bán hàng duyệt; hệ thống không tự gửi)")
            return 0
        if a.export is not None:
            ok, msg = kq.export(conn, a.export, a.out, CATALOG_TYPES)
            if not ok:
                print(f"[warn] {msg}", file=sys.stderr)
                return 1
            print(f"[done] xuất catalog ĐÃ DUYỆT mục #{a.export} → {msg}")
            return 0
        if kq.verify_send(conn, vqid, Path(a.verify_send[1]), CATALOG_TYPES):
            print(f"[ok] mục #{vqid}: KHỚP bản đã duyệt — GĐ bán hàng tự gửi")
            return 0
        print(f"[warn] mục #{vqid}: LỆCH — KHÔNG gửi", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
