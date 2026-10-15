"""v8.3 DA-05 — danh sách TỔ CHỨC tiềm năng mua quà Tết.

v12.0: phòng Dự án đã gỡ (ngoài phạm vi HĐ TEDO–Sâm Sâm) — module này GIỮ
và chuyển sang khối **sales**, thuộc tính năng "Báo giá B2B quà Tết"
(cùng `agents/kd_quote.py`, `connectors/b2b_form.py`).

Contract:
  - Bảng `org_prospects` chỉ giữ thông tin TỔ CHỨC công khai (tên, loại,
    tỉnh/thành, website, nguồn công khai, lý do phù hợp) — KHÔNG cột SĐT/
    email/tên người/địa chỉ/liên hệ. Nạp từ CSV NHẬP TAY.
  - `dedup_key(org_name, region)` = "b2b:" + sha256(norm(tên) + "|" +
    norm(tỉnh)); norm = NFKC → casefold → bỏ dấu (đ→d) → gom ký tự không
    chữ-số thành 1 khoảng trắng → strip.
  - `read_csv(path)` THUẦN, kiểm TOÀN file trước khi connect: ≤1 MB, UTF-8
    (BOM được), header đúng `org_name,org_type,region,website,source_url,
    fit_reason`; loại ∈ enum; tỉnh nhận ra bằng `ingest.crm.province_of`;
    URL http(s) và host KHÔNG thuộc MXH/sàn/tầng C (`crawler.intel.
    is_blocked`; `data/intel_sources.json` hỏng → lỗi cả file, fail-closed);
    ô nào có SĐT/email (`_mask_pii` đổi ô) → lỗi; lý do có rượu → lỗi; ô
    trượt `guardrail.check` (từ cấm "thuốc"/"chữa"..., rượu) → lỗi — lô
    chứa ô đó KHÔNG duyệt được và quay lại mãi; trùng key trong file →
    lỗi. Lỗi in số dòng + cột + lý do, KHÔNG in giá trị ô. Có lỗi → 0 dòng
    nạp, không connect.
  - KHÔNG liên hệ tự động: không có đường gửi thư/gọi/nhắn. Lô tổ chức vào
    hàng duyệt khối `sales` (`org_prospect_batch`) cho GĐ bán hàng; chỉ
    khi NGƯỜI duyệt và bảng dựng lại từ DB khớp sha256 bản duyệt
    thì dòng mới thành `chuyen_sales` (người liên hệ = GĐ bán hàng/đại lý).
    Lô bị từ chối HOẶC hết hạn SLA (`expired`) → dòng về `moi` để lập lô
    mới; lệch sha256 → 0 dòng đổi (điều tra — xem SOP).

Chạy:
  python -m agents.da_b2b --import FILE --by "<người nhập>"
  python -m agents.da_b2b --submit-batch [--limit N]
  python -m agents.da_b2b --handover QUEUE_ID --by "<người>"
  python -m agents.da_b2b --list [--status moi|cho_duyet|chuyen_sales]
Exit: 0 ok · 1 CSV lỗi / lô chưa duyệt / lệch hash · 2 tham số sai / DB
down / lỗi DB.
"""

import argparse
import csv
import hashlib
import io
import re
import sys
import unicodedata
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from crawler.intel import SOURCES_FILE, is_blocked, load_sources, tier_c_hosts
from ingest.crm import province_of
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import director, guardrail, kb_filter
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

HEADER = ["org_name", "org_type", "region", "website", "source_url",
          "fit_reason"]
ORG_TYPES = ("doanh_nghiep", "khach_san", "su_kien_hoi_nghi", "hiep_hoi",
             "co_quan", "khac")
STATUSES = ("moi", "cho_duyet", "chuyen_sales")
MAX_BYTES = 1_000_000
MAX_URL = 500
BLOCK = "sales"
LEGACY_BLOCK = "projects"   # khối cũ trước v12.0 (đã gỡ)
OBJECT_TYPE = "org_prospect_batch"
FOOTER = ("Hệ thống KHÔNG tự liên hệ — GĐ bán hàng/đại lý liên hệ sau khi "
          "duyệt.")
COLS = ("id", "dedup_key", "org_name", "org_type", "region", "website",
        "source_url", "fit_reason")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", str(s or "")).casefold()
    s = unicodedata.normalize("NFD", s).replace("đ", "d")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[\W_]+", " ", s).strip()


def dedup_key(org_name: str, region: str) -> str:
    raw = f"{norm(org_name)}|{norm(region)}".encode()
    return "b2b:" + hashlib.sha256(raw).hexdigest()


def _blocked_hosts() -> tuple[str, ...] | None:
    """Host tầng C từ cấu hình nguồn; file hỏng → None (fail-closed)."""
    cfg, errs = load_sources(SOURCES_FILE)
    return None if errs else tier_c_hosts(cfg)


def _url_err(u: str, blocked: tuple) -> str | None:
    if len(u) > MAX_URL or any(c.isspace() for c in u):
        return "URL quá dài hoặc có khoảng trắng"
    try:
        p = urlsplit(u)
        host = p.hostname or ""
    except ValueError:
        return "URL hỏng"
    if p.scheme not in ("http", "https") or not host:
        return "phải là URL http(s) có host"
    if is_blocked(host, blocked):
        return "nguồn tầng C (MXH/sàn/trang cần đăng nhập) — không dùng"
    return None


def read_csv(path) -> tuple[list[dict], list[str]]:
    """→ (dòng hợp lệ, lỗi). Có lỗi → dòng = []. Không in giá trị ô."""
    p = Path(path)
    try:
        if p.stat().st_size > MAX_BYTES:
            return [], [f"{p.name}: file > 1 MB"]
        raw = p.read_bytes()
        text = raw.decode("utf-8-sig")
    except OSError as e:
        return [], [f"{p.name}: không đọc được ({type(e).__name__})"]
    except UnicodeDecodeError as e:
        ln = raw[:e.start].count(b"\n") + 1
        return [], [(f"dòng {ln}: byte không phải UTF-8 — lưu lại file "
                     "dạng CSV UTF-8")]
    blocked = _blocked_hosts()
    if blocked is None:
        return [], [("data/intel_sources.json hỏng — không kiểm được nguồn "
                     "tầng C (MXH/sàn); sửa cấu hình rồi nạp lại")]
    errs, rows, seen = [], [], {}
    rd = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(rd, None)
        if [h.strip() for h in (header or [])] != HEADER:
            return [], [f"dòng 1: header phải đúng {','.join(HEADER)}"]
        for rec in rd:
            ln = rd.line_num
            if not any(c.strip() for c in rec):
                continue
            if len(rec) != len(HEADER):
                errs.append(f"dòng {ln}: cần {len(HEADER)} cột, có "
                            f"{len(rec)}")
                continue
            r = dict(zip(HEADER, (c.strip() for c in rec)))
            bad = []
            for k, v in r.items():
                if v and _mask_pii(v) != v:
                    bad.append((k, ("chứa SĐT/email — chỉ nhập thông tin"
                                    " tổ chức")))
            if not 2 <= len(r["org_name"]) <= 200:
                bad.append(("org_name", "cần 2..200 ký tự"))
            if r["org_type"] not in ORG_TYPES:
                bad.append(("org_type", f"phải thuộc {'|'.join(ORG_TYPES)}"))
            prov = province_of(r["region"])
            if prov is None:
                bad.append(("region", "không nhận ra tỉnh/thành (hoặc mơ hồ)"))
            for k in ("website", "source_url"):
                if not r[k]:
                    if k == "source_url":
                        bad.append((k, "bắt buộc (nguồn công khai)"))
                    continue
                why = _url_err(r[k], blocked)
                if why:
                    bad.append((k, why))
            if len(r["fit_reason"]) > 300:
                bad.append(("fit_reason", "quá 300 ký tự"))
            if kb_filter.is_alcohol(r["fit_reason"]):
                bad.append(("fit_reason", "không gợi ý rượu"))
            # Ô vào payload lô; trượt guardrail → lô không duyệt được.
            flagged = {k for k, _ in bad}
            for k, v in r.items():
                if not v or k in flagged:
                    continue
                g = guardrail.check(v)
                if g.get("ok") is not True:
                    codes = sorted({str(x.get("code"))
                                    for x in g.get("violations") or ()})
                    bad.append((k, (f"chứa từ/cụm guardrail chặn "
                                    f"({', '.join(codes)}; xem data/"
                                    "banned_words.txt) — ghi khác")))
            if bad:
                errs += [f"dòng {ln} cột {k}: {why}" for k, why in bad]
                continue
            key = dedup_key(r["org_name"], prov)
            if key in seen:
                errs.append(f"dòng {ln} cột org_name: trùng tổ chức ở dòng "
                            f"{seen[key]} (cùng tên chuẩn hóa + tỉnh)")
                continue
            seen[key] = ln
            rows.append({**r, "region": prov, "dedup_key": key,
                         "website": r["website"] or None,
                         "fit_reason": r["fit_reason"] or None})
    except csv.Error as e:
        errs.append(f"dòng {rd.line_num}: CSV hỏng ({type(e).__name__})")
    if not rows and not errs:
        errs.append(f"{p.name}: 0 dòng dữ liệu")
    return ([] if errs else rows), errs


def _md(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().replace("|", "\\|") \
        or "—"


def render_batch(rows: list[dict]) -> str:
    """Payload lô (tất định từ các cột tổ chức, thứ tự theo id)."""
    L = [f"# Lô tổ chức tiềm năng mua quà Tết — {len(rows)} tổ chức", "",
         ("Nguồn: thông tin TỔ CHỨC công khai do người nhập tay — không có"
          " thông tin cá nhân. Duyệt = đồng ý chuyển danh sách cho GĐ bán"
          " hàng/đại lý."), "",
         ("| # | Tổ chức | Loại | Tỉnh/thành | Website | Nguồn công khai |"
          " Lý do phù hợp | Mã |"), "|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows, 1):
        L.append(f"| {i} | {_md(r['org_name'])} | {r['org_type']} | "
                 f"{_md(r['region'])} | {_md(r.get('website'))} | "
                 f"{_md(r['source_url'])} | {_md(r.get('fit_reason'))} | "
                 f"{r['dedup_key'][4:16]} |")
    L += ["", FOOTER, ""]
    return "\n".join(L)


class _HoldCommit:
    """Chuyển tiếp conn nhưng hoãn commit — enqueue + đánh dấu dòng trong
    CÙNG 1 transaction (caller commit 1 lần)."""

    def __init__(self, conn):
        self._c = conn

    def execute(self, *a, **kw):
        return self._c.execute(*a, **kw)

    def transaction(self):
        return self._c.transaction()

    def commit(self):
        pass


def import_rows(conn, rows: list[dict], by: str, source: str) -> dict:
    st = {"inserted": 0, "dup": 0}
    for r in rows:
        cur = conn.execute(
            "insert into org_prospects (dedup_key, org_name, org_type,"
            " region, website, source_url, fit_reason, source, created_by)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " on conflict (dedup_key) do nothing",
            (r["dedup_key"], r["org_name"], r["org_type"], r["region"],
             r["website"], r["source_url"], r["fit_reason"], source, by))
        st["inserted" if cur.rowcount == 1 else "dup"] += 1
    conn.commit()
    return st


def _rows(conn, sql: str, params) -> list[dict]:
    return [dict(zip(COLS, r)) for r in conn.execute(
        f"select {', '.join(COLS)} from org_prospects {sql}", params)]


def submit_batch(conn, limit: int = 50) -> tuple[int | None, int]:
    """Dòng `moi` → 1 mục hàng duyệt + dòng `cho_duyet`. → (qid, n).

    Mỗi lô chỉ gồm dòng của MỘT người nhập (người nhập dòng `moi` cũ nhất) và
    mục hàng duyệt ghi `created_by` = người nhập đó → hàng duyệt v4.0 chặn
    người nhập tự duyệt lô của chính mình (gộp M31 đợt 5)."""
    first = conn.execute("select created_by from org_prospects where status"
                         " = 'moi' order by id limit 1").fetchone()
    if not first:
        conn.commit()
        return None, 0
    importer = first[0]
    rows = _rows(conn, "where status = 'moi' and created_by = %s order by id"
                       " limit %s for update", (importer, limit))
    if not rows:
        conn.commit()
        return None, 0
    keys = "".join(r["dedup_key"] for r in rows)
    oid = "b2b-batch:" + hashlib.sha256(keys.encode()).hexdigest()[:12]
    try:
        qid = director.submit(_HoldCommit(conn), BLOCK, OBJECT_TYPE,
                              object_id=oid, title=f"Lô {len(rows)} tổ chức"
                              " tiềm năng mua quà Tết",
                              payload=render_batch(rows),
                              created_by=importer)
        conn.execute("update org_prospects set status = 'cho_duyet',"
                     " batch_queue_id = %s where id = any(%s)",
                     (qid, [r["id"] for r in rows]))
    except BaseException:
        conn.rollback()
        raise
    conn.commit()
    return qid, len(rows)


def handover(conn, qid: int) -> tuple[bool, str, int]:
    """→ (ok, thông điệp, số dòng đổi). Chỉ đổi khi người đã quyết."""
    row = conn.execute("select block, object_type, status from"
                       " approval_queue where id = %s", (qid,)).fetchone()
    # v12.0: lô nộp trước v12.0 nằm ở khối `projects` (đã gỡ) — vẫn nhận để
    # dòng 'cho_duyet' của lô cũ không kẹt vĩnh viễn (trả 'moi'/chuyển sales).
    if row is None or row[0] not in (BLOCK, LEGACY_BLOCK)             or row[1] != OBJECT_TYPE:
        return False, f"mục #{qid} không phải lô `{OBJECT_TYPE}`", 0
    if row[2] in ("rejected", "expired"):
        # Lô kết thúc không duyệt → trả dòng về 'moi' để lập lô mới (không
        # để kẹt 'cho_duyet' — submit_batch chỉ lấy 'moi').
        n = conn.execute("update org_prospects set status = 'moi',"
                         " batch_queue_id = null where batch_queue_id = %s"
                         " and status = 'cho_duyet'", (qid,)).rowcount
        conn.commit()
        why = "bị từ chối" if row[2] == "rejected" else "hết hạn SLA"
        return True, f"lô #{qid} {why} — {n} dòng về 'moi'", n
    if row[2] != "approved":
        return False, (f"lô #{qid} đang '{row[2]}' — chỉ chuyển khi NGƯỜI "
                       "đã duyệt"), 0
    rows = _rows(conn, "where batch_queue_id = %s order by id", (qid,))
    if not rows or not aq.verify(conn, qid, render_batch(rows)):
        conn.commit()
        return False, (f"lô #{qid}: dữ liệu hiện tại LỆCH bản đã duyệt "
                       "(sha256) — KHÔNG chuyển"), 0
    n = conn.execute("update org_prospects set status = 'chuyen_sales',"
                     " handed_at = now() where batch_queue_id = %s and"
                     " status = 'cho_duyet'", (qid,)).rowcount
    conn.commit()
    return True, f"lô #{qid}: {n} tổ chức → chuyen_sales", n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_b2b",
        description="DA-05 tổ chức tiềm năng mua quà Tết — không PII, hệ "
                    "thống KHÔNG tự liên hệ")
    ap.add_argument("--import", dest="imp", type=Path, metavar="FILE")
    ap.add_argument("--submit-batch", action="store_true")
    ap.add_argument("--handover", type=int, metavar="QUEUE_ID")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--by")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--status", choices=STATUSES)
    a = ap.parse_args(argv)
    n_ops = ((a.imp is not None) + a.submit_batch
             + (a.handover is not None) + a.list)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --import | --submit-batch | "
                 "--handover | --list")
    by = (a.by or "").strip()
    if (a.imp is not None or a.handover is not None) and not by:
        ap.error("--import/--handover cần --by <tên người>")
    if not 1 <= a.limit <= 200:
        ap.error("--limit phải trong 1..200")
    rows = None
    if a.imp is not None:
        rows, errs = read_csv(a.imp)
        if errs:
            for e in errs[:50]:
                print(f"[err] {e}", file=sys.stderr)
            print(f"[error] {len(errs)} lỗi — KHÔNG nạp dòng nào",
                  file=sys.stderr)
            return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if rows is not None:
            st = import_rows(conn, rows, by, f"manual:{a.imp.name}")
            print(f"[done] inserted={st['inserted']} dup={st['dup']}")
            return 0
        if a.submit_batch:
            qid, n = submit_batch(conn, a.limit)
            if qid is None:
                print("[done] không có lô (0 tổ chức 'moi')")
            else:
                print(f"[done] lô {n} tổ chức → mục #{qid} (PENDING — GĐ dự "
                      f"án/GĐ bán hàng duyệt). {FOOTER}")
            return 0
        if a.handover is not None:
            ok, msg, _ = handover(conn, a.handover)
            print(f"[{'done' if ok else 'warn'}] {msg} (người chạy: "
                  f"{_oneline(_mask_pii(by), 60)})",
                  file=sys.stdout if ok else sys.stderr)
            return 0 if ok else 1
        sql, params = "order by id", ()
        if a.status:
            sql, params = "where status = %s order by id", (a.status,)
        got = conn.execute(f"select id, org_name, org_type, region, status"
                           f" from org_prospects {sql}", params).fetchall()
        conn.commit()
        for r in got:
            print(f"  #{r[0]} {_oneline(_mask_pii(r[1]), 60)} · {r[2]} · "
                  f"{r[3]} · {r[4]}")
        print(f"[done] {len(got)} tổ chức")
        return 0
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
