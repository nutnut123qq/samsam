"""v10.3 cổng nạp social listening NHÀ CUNG CẤP (WP16 nền P2: "Ingest dữ
liệu social listening từ nhà cung cấp, nếu TGĐ duyệt") —
`python -m ingest.social_vendor --file F` (CSV/XLSX export của vendor).

FAIL-CLOSED theo TGĐ: thứ tự argparse → `data/social_vendor.json` (thiếu
file / JSON hỏng / `vendor_approved_by_tgd` không phải đúng `true` JSON —
kể cả "true" chuỗi, 1 / `approval_ref` rỗng) → `[blocked]`, exit 2, KHÔNG
đọc file, KHÔNG connect. File config CHỈ người thật đổi sau khi TGĐ duyệt
hợp đồng + DPA. Sau cổng: bộ lọc rượu + `social_rules.json` (fail-closed
như v7.2) → đọc + kiểm TOÀN file (lỗi → exit 1, 0 dòng, không connect) →
muối `INTEL_HASH_SALT` (≥16, thiếu → exit 1) → connect → `[skip]` theo
`file_sha256` → 1 transaction `intel_imports` (kind `social`, channel
`vendor`) + `social_mentions_vendor` → `conn.commit()`.

Format file vendor (GIẢ ĐỊNH — chưa có file thật, external-dep):
  bắt buộc  thoi_gian (ISO, không múi giờ = giờ VN), nen_tang (facebook|
            tiktok|youtube|instagram|forum|news|khac), noi_dung
  tùy chọn  ma_tin, id_tac_gia (CHỈ vào vật liệu hash dedup, không lưu),
            loai (post|comment|review, mặc định post)
  BỎ NGAY   ten_tac_gia, link_tac_gia, avatar, so_nguoi_theo_doi, email,
            sdt, url_bai (URL bài có thể định danh), cam_xuc_vendor
  cột lạ → lỗi cả file (cột lạ có thể là PII).
PII/nhãn/hash/excerpt TÁI DÙNG v7.2 (`ingest.intel_import`): noi_dung che
SĐT/email ngay khi đọc (`_text`), nhãn `classify_social`, `msg_hash(salt,
"vendor:<nen_tang>", key)` (dedup `on conflict do nothing`), `excerpt`
CHỈ khi `dpia_signed` true và tin không nhạy cảm.

Quyền sở hữu: ghi DUY NHẤT `intel_imports` + `social_mentions_vendor`.
KHÔNG ghi `social_mentions` (kênh sở hữu — báo cáo `intel_weekly` không bị
trộn dữ liệu bên thứ ba). Không request mạng, không LLM, không trả lời.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from ingest import intel_import as ii
from pipelines import kb_filter

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "social_vendor.json"
RULES_FILE = ii.RULES_FILE

V_REQUIRED = ("thoi_gian", "nen_tang", "noi_dung")
V_OPTIONAL = ("ma_tin", "id_tac_gia", "loai")
V_DROP = ("ten_tac_gia", "link_tac_gia", "avatar", "so_nguoi_theo_doi",
          "email", "sdt", "url_bai", "cam_xuc_vendor")
PLATFORMS = ("facebook", "tiktok", "youtube", "instagram", "forum", "news",
             "khac")
V_KINDS = ("post", "comment", "review")


def check_approval(path: Path | None = None) -> str | None:
    """None = TGĐ đã duyệt; ngược lại lý do chặn (fail-closed)."""
    path = Path(path or CONFIG_FILE)
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return f"{path.name}: không đọc được ({type(e).__name__})"
    if not isinstance(raw, dict):
        return f"{path.name}: gốc phải là object"
    if raw.get("vendor_approved_by_tgd") is not True:
        return "vendor_approved_by_tgd chưa là true"
    ref = raw.get("approval_ref")
    if not isinstance(ref, str) or not ref.strip():
        return "approval_ref rỗng"
    return None


def read_vendor(path, rules: dict, now: datetime | None = None
                ) -> tuple[list[dict], list[str], str | None]:
    """Hàm thuần: export vendor → (rows, errors, sha). Cột định danh tác giả
    bỏ NGAY khi đọc; row['key'] = vật liệu hash dedup (chỉ RAM)."""
    recs, errs, sha = ii._parse_table(path, V_REQUIRED, V_OPTIONAL, V_DROP)
    if errs:
        return [], errs, sha
    limit = (now or datetime.now(ii.VN_TZ)) + timedelta(days=1)
    rows = []
    for n, r in recs:
        bad = []
        ts = ii._iso_ts(r["thoi_gian"])
        if ts is None or ts > limit:
            bad.append("thoi_gian")
        plat = ii._kw(r["nen_tang"] or "")
        if plat not in PLATFORMS:
            bad.append("nen_tang")
        kind = ii._kw(r.get("loai") or "post")
        if kind not in V_KINDS:
            bad.append("loai")
        text = ii._text(r["noi_dung"], ii.PRE_MAX)   # che NGAY khi đọc
        if not text:
            bad.append("noi_dung")
        if bad:
            errs += [f"dòng {n}: cột '{c}' không hợp lệ" for c in bad]
            continue
        labels = ii.classify_social(text, rules)
        sensitive = "hoi_suc_khoe" in labels
        key = (f"id:{r['ma_tin']}" if r.get("ma_tin") else
               f"u:{r.get('id_tac_gia') or ''}|{r['thoi_gian']}|{text}")
        rows.append({
            "row_no": n, "platform": plat, "kind": kind, "posted_at": ts,
            "key": key, "labels": labels, "sensitive": sensitive,
            "excerpt": (text[:200] if rules["dpia_signed"] is True
                        and not sensitive else None)})
    if errs:
        return [], errs, sha
    return rows, [], sha


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def load_vendor(conn, rows, salt, file_name, sha) -> tuple[int, int, int]:
    """→ (import_id, new, dup) — không commit."""
    iid = ii._new_import(conn, "social", "vendor", file_name, sha, len(rows))
    new = 0
    for r in rows:
        got = conn.execute(
            "insert into social_mentions_vendor (import_id, platform, kind,"
            " posted_at, msg_hash, labels, sensitive, excerpt) values (%s, %s,"
            " %s, %s, %s, %s, %s, %s) on conflict (msg_hash) do nothing"
            " returning id",
            (iid, r["platform"], r["kind"], r["posted_at"],
             ii.msg_hash(salt, f"vendor:{r['platform']}", r["key"]),
             r["labels"], r["sensitive"], r["excerpt"])).fetchone()
        new += got is not None
    return iid, new, len(rows) - new


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m ingest.social_vendor",
        description="Nạp file social listening của nhà cung cấp (cổng TGĐ "
                    "duyệt) — không request mạng.")
    ap.add_argument("--file", type=Path, required=True, metavar="F")
    args = ap.parse_args(argv)
    why = check_approval()
    if why:
        print(f"[blocked] nhà cung cấp chưa được TGĐ duyệt — không nạp ({why})."
              " Cần hợp đồng + DPA + TGĐ duyệt; người thật cập nhật "
              "data/social_vendor.json.", flush=True)
        return 2
    try:
        kb_filter.is_alcohol("rượu")   # bộ lọc rượu hỏng → fail-closed
    except kb_filter.KbFilterError as e:
        print(f"[err] bộ lọc rượu hỏng: {e}", flush=True)
        return 1
    rules, errs = ii.load_social_rules(RULES_FILE)
    if errs:
        for e in errs:
            print(f"[err] {e}", flush=True)
        return 1
    rows, errs, sha = read_vendor(args.file, rules)
    if errs:
        ii._print_errs(errs)
        return 1
    load_dotenv(ROOT / ".env")
    salt = os.environ.get("INTEL_HASH_SALT", "")
    if len(salt) < ii.SALT_MIN:
        print(f"[err] thiếu INTEL_HASH_SALT (≥{ii.SALT_MIN} ký tự) trong .env"
              " — không nạp.", flush=True)
        return 1
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env", flush=True)
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.Error as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}",
              flush=True)
        return 1
    fname = ii._safe(args.file.name, 200)   # che SĐT/email nếu tên file có
    try:
        if None in conn.execute(
                "select to_regclass('intel_imports'),"
                " to_regclass('social_mentions_vendor')").fetchone():
            print("[err] thiếu bảng v10.3 — chạy `python "
                  "scripts/apply_schema.py` trước.", flush=True)
            return 1
        old = conn.execute("select id, kind from intel_imports where"
                           " file_sha256 = %s", (sha,)).fetchone()
        if old:
            print(f"[skip] file đã nạp: import #{old[0]} ({old[1]}) — không "
                  "ghi gì.", flush=True)
            return 0
        iid, new, dup = load_vendor(conn, rows, salt, fname, sha)
        conn.commit()
    except psycopg.errors.UniqueViolation as e:
        conn.rollback()
        if "file_sha256" in (e.diag.constraint_name or ""):
            print("[skip] file vừa được nạp song song — không ghi gì.",
                  flush=True)
            return 0
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    except psycopg.Error as e:
        conn.rollback()
        print(f"[err] lỗi DB, đã rollback: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()
    print(f"[load] vendor #{iid} {fname}: {len(rows)} dòng new={new} "
          f"dup={dup}", flush=True)
    print("[done]", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
