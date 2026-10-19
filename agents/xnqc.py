"""v4.3 PC-A1 (WP05) — sổ hồ sơ XNQC theo SKU + nhắc mốc + đề xuất đồng bộ
golden.

Mỗi maket/kịch bản là 1 hồ sơ (research_legal mục 2). Trạng thái chỉ đi
theo `TRANSITIONS`; `da_cap` CHỈ do NGƯỜI (Pháp chế) xác nhận: `--by` là
tên người + số giấy + ngày cấp (≤ hôm nay) + scan giấy trong `documents`
đã được Pháp chế đối chiếu bản gốc (`status = 'verified'`, qua `python -m
ingest.doc_intake --verify <sha> --by`). DB tự chặn thêm bằng CHECK (kể cả
INSERT/UPDATE thẳng). v15.4: ghi qua function SECURITY DEFINER
`xnqc_add_human`/`xnqc_set_status_human` (danh tính theo login Postgres —
`--by` phải là người của login; `--set` khối legal_hr; DB kiểm lại chuyển
trạng thái + scan). Mỗi lần đổi trạng thái: UPDATE + 1 dòng
`agent_action_log` (`xnqc_status`, detail chỉ {id, from, to}) cùng
transaction.

Đồng bộ golden: `golden_target` (thuần) suy `xnqc_status` nên có của SKU từ
hồ sơ; `sync_golden` so với `data/golden_skus.json` (nguồn mà
`guardrail.readiness()` và view `sku_readiness` dùng) — lệch thì ĐỀ XUẤT vào
`approval_queue` (`golden_xnqc_sync`, khối legal_hr). Agent KHÔNG ghi file
golden, KHÔNG ghi `sku_master`/`price_list`: sau khi duyệt, người phụ trách
golden sửa file rồi chạy `python -m ingest.golden_store`. Hồ sơ đổi trong
lúc mục cũ còn chờ (vd da_nop→da_cap→het_han trong 72 giờ) → mục mới ghi
"THAY THẾ mục #X — chỉ duyệt mục mới nhất"; `--sync-golden` + báo cáo
Pháp chế §1 liệt kê mục LỖI THỜI / đã duyệt chờ người sửa golden
(`sync_notes`). Agent KHÔNG tự quyết/rút mục.

Nhắc mốc (thuần, `today` là tham số): SKU TPBVSK chưa có hồ sơ đang nộp/
còn hiệu lực → CHƯA NỘP / SẮP HẠN / QUÁ HẠN đợt 2 (cấu hình
`data/phap_che.json`); giấy `da_cap` sắp hết hạn / đã quá hạn (agent KHÔNG
tự chuyển `het_han`).

Chạy:
  python -m agents.xnqc --add --sku K --loai maket --ten "maket fanpage" --by "<tên>"
  python -m agents.xnqc --set ID --status da_nop --ngay-nop 2026-11-20 --by "<tên>"
  python -m agents.xnqc --set ID --status da_cap --so-giay X --ngay-cap D --doc-sha SHA --by "<tên>" [--het-han D]
  python -m agents.xnqc --list | --remind [--today D] | --sync-golden [--today D]
`--today` CHỈ cho `--remind`/`--sync-golden`; `--set`/`--add` dùng ngày thật
(giờ VN) — chống đẩy "hôm nay" tới trước để ghi ngày cấp/nộp tương lai.
Giấy `da_cap` có ngày cấp sau `today` không tính còn hiệu lực.
Exit 0 ok · 1 bị từ chối (chuyển sai, thiếu điều kiện, SKU lạ) · 2 usage
(ngày sai ISO, >1 thao tác, `--by` không hợp lệ, `--today` với thao tác
ghi — kiểm TRƯỚC connect) /
cấu hình hỏng / DB không truy cập được.
"""

import argparse
import re
import sys
from datetime import date, datetime
from pathlib import Path

import psycopg

from agents.ra_kenh import CONFIG, _iso_date, by_error, load_config, safe
from ingest.golden_store import GOLDEN_FILE, read_golden
from ingest.lead_store import connect
from pipelines import auth, director
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

AGENT = "agent:phap_che_a1"
LOAI = ("maket", "kich_ban_video", "kich_ban_livestream", "khac")
STATUSES = ("chuan_bi", "da_nop", "bo_sung", "da_cap", "het_han")
TRANSITIONS = {"chuan_bi": {"da_nop"}, "da_nop": {"bo_sung", "da_cap"},
               "bo_sung": {"da_nop"}, "da_cap": {"het_han"}, "het_han": set()}
SYNC_AFTER = ("da_nop", "da_cap", "het_han")
MAX_TEN = 200
_SHA_RE = re.compile(r"[0-9a-f]{64}")
COLS = ("id", "sku_key", "loai_ho_so", "ten_ho_so", "status", "so_giay",
        "ngay_nop", "ngay_cap", "ngay_het_han", "document_sha256",
        "updated_by")


def _date(v, what: str) -> date | None:
    """str ISO / date / None → date | None. Sai → ValueError."""
    if v is None:
        return None
    try:
        return _iso_date(v, what)
    except ValueError:
        raise ValueError(f"{what}: cần ngày YYYY-MM-DD hợp lệ") from None


def list_dossiers(conn) -> list[dict]:
    return [dict(zip(COLS, r)) for r in conn.execute(
        f"select {', '.join(COLS)} from xnqc_dossiers"
        " order by sku_key, id").fetchall()]


def tpbvsk_skus() -> list[str]:
    doc, err = read_golden(GOLDEN_FILE)
    if err:
        raise ValueError(err)
    return [s["sku_key"] for s in doc["skus"] if s.get("category") == "tpbvsk"]


def add(conn, sku_key: str, loai: str, ten: str, by: str) -> int:
    """Hồ sơ mới `chuan_bi` → id. Thiếu/sai tham số, SKU lạ → ValueError."""
    err = by_error(by)
    if err:
        raise ValueError(err)
    if loai not in LOAI:
        raise ValueError(f"loại hồ sơ phải thuộc {LOAI}")
    ten = (ten or "").strip()
    if not ten or len(ten) > MAX_TEN:
        raise ValueError(f"tên hồ sơ rỗng hoặc dài quá {MAX_TEN} ký tự")
    if conn.execute("select 1 from sku_master where sku_key = %s",
                    (sku_key,)).fetchone() is None:
        raise ValueError("SKU không có trong sku_master")
    # v15.4 (P10.1): ghi qua function SECURITY DEFINER (danh tính theo
    # login — nhập liệu, không khối) + log cùng transaction trong function.
    with conn.transaction():
        did = auth.call_human(
            conn, "select xnqc_add_human(%s, %s, %s, %s)",
            (sku_key, loai, ten, by.strip()), by=by, block=None,
            action="add", object_type="xnqc_dossier",
            object_id=sku_key).fetchone()[0]
    conn.commit()
    return did


def set_status(conn, dossier_id, status: str, by: str, *, so_giay=None,
               ngay_nop=None, ngay_cap=None, ngay_het_han=None,
               doc_sha=None, today: date) -> tuple[bool, str]:
    """Chuyển trạng thái theo `TRANSITIONS` → (True, msg) | (False, lý do —
    không ghi gì). Sang da_nop/da_cap/het_han → tự `sync_golden` sau commit."""
    err = by_error(by)
    if err:
        return False, err
    if status not in STATUSES:
        return False, f"trạng thái phải thuộc {STATUSES}"
    try:
        did = int(dossier_id)
    except (TypeError, ValueError):
        return False, f"id hồ sơ '{safe(dossier_id)[:20]}' không hợp lệ"
    try:
        nop = _date(ngay_nop, "ngay_nop")
        cap = _date(ngay_cap, "ngay_cap")
        het = _date(ngay_het_han, "ngay_het_han")
    except ValueError as e:
        return False, str(e)
    row = conn.execute("select status from xnqc_dossiers where id = %s",
                       (did,)).fetchone()
    if row is None:
        return False, f"không tìm thấy hồ sơ #{did}"
    cur = row[0]
    if status not in TRANSITIONS[cur]:
        ok = ", ".join(sorted(TRANSITIONS[cur])) or "(không — trạng thái cuối)"
        return False, f"không chuyển được {cur} → {status}; hợp lệ: {ok}"
    if status == "da_nop" and (nop is None or nop > today):
        return False, "da_nop cần --ngay-nop (không ở tương lai)"
    sha = so = None
    if status == "da_cap":
        so = (so_giay or "").strip() or None
        if so is None or len(so) > 100:
            return False, "da_cap cần --so-giay (≤ 100 ký tự)"
        if cap is None or cap > today:
            return False, "da_cap cần --ngay-cap (không ở tương lai)"
        if het is not None and het <= cap:
            return False, "--het-han phải sau --ngay-cap"
        sha = (doc_sha or "").strip().lower()
        if not _SHA_RE.fullmatch(sha):
            return False, "da_cap cần --doc-sha (sha256 scan giấy trong documents)"
        d = conn.execute("select status from documents where sha256 = %s",
                         (sha,)).fetchone()
        if d is None:
            return False, "scan giấy không có trong documents (nạp qua doc_intake)"
        if d[0] != "verified":
            return False, (f"scan giấy đang '{d[0]}' — Pháp chế phải đối chiếu"
                           " bản gốc (doc_intake --verify) trước")
    try:
        # v15.4 (P10.1): ghi qua function SECURITY DEFINER — khối legal_hr
        # theo login (`human_actor`), DB kiểm lại chuyển trạng thái/scan.
        with conn.transaction():
            auth.call_human(
                conn, "select xnqc_set_status_human(%s, %s, %s, %s, %s, %s,"
                " %s, %s, %s)", (did, cur, status, by.strip(), so, nop, cap,
                                 het, sha or None),
                by=by, block="legal_hr", action="set_status",
                object_type="xnqc_dossier", object_id=did)
        conn.commit()
    except auth.HumanDenied as e:
        return False, f"DB từ chối: {e}"
    except ValueError as e:
        if "vừa đổi trạng thái" in str(e):
            return False, f"hồ sơ #{did} vừa đổi trạng thái — thử lại"
        return False, f"DB từ chối: {_mask_pii(str(e))[:200]}"
    except psycopg.Error as e:
        return False, f"DB từ chối: {_db_msg(e)}"
    msg = f"hồ sơ #{did}: {cur} → {status}"
    if status in SYNC_AFTER:
        try:
            ids = sync_golden(conn, today)
            msg += (f"; đề xuất đồng bộ golden mục {ids}" if ids
                    else "; golden không lệch / đã có đề xuất chờ duyệt")
        except (ValueError, psycopg.Error) as e:
            msg += f"; CHƯA đề xuất đồng bộ golden ({type(e).__name__})"
    return True, msg


def _valid_cap(d: dict, today: date) -> bool:
    """Giấy còn hiệu lực ở `today`: đã cấp (ngày cấp không sau `today` — dòng
    ghi thẳng DB với ngày cấp tương lai KHÔNG tính) và chưa hết hạn."""
    return (d["status"] == "da_cap" and d["ngay_cap"] is not None
            and d["ngay_cap"] <= today
            and (d["ngay_het_han"] is None or d["ngay_het_han"] >= today))


def golden_target(rows: list[dict], today: date) -> str:
    """Hồ sơ của 1 SKU → `xnqc_status` golden nên có. THUẦN."""
    if any(_valid_cap(d, today) for d in rows):
        return "approved"
    if any(d["status"] in ("da_nop", "bo_sung") for d in rows):
        return "pending"
    return "none"


def _sync_items(conn) -> dict[str, list[tuple[int, str, str]]]:
    """Mục `golden_xnqc_sync` pending/approved theo SKU, cũ → mới (CHỈ
    SELECT) → {sku: [(id, đích, status)]}. object_id `<sku>:<đích>` hoặc
    `<sku>:<đích>@<id mục bị thay>` (unique index chỉ 1 pending/object_id)."""
    out: dict[str, list[tuple[int, str, str]]] = {}
    for qid, oid, st in conn.execute(
            "select id, object_id, status from approval_queue where"
            " object_type = 'golden_xnqc_sync' and status in ('pending',"
            " 'approved') order by id").fetchall():
        sku, _, rest = oid.partition(":")
        out.setdefault(sku, []).append((qid, rest.partition("@")[0], st))
    return out


def _golden_state(conn, today: date):
    """→ [(sku, golden hiện tại, đích theo hồ sơ, hồ sơ, mục đề xuất)]."""
    doc, err = read_golden(GOLDEN_FILE)
    if err:
        raise ValueError(err)
    by_sku: dict[str, list[dict]] = {}
    for d in list_dossiers(conn):
        by_sku.setdefault(d["sku_key"], []).append(d)
    items = _sync_items(conn)
    return [(s["sku_key"], s.get("xnqc_status", "none"),
             golden_target(by_sku.get(s["sku_key"], []), today),
             by_sku.get(s["sku_key"], []), items.get(s["sku_key"], []))
            for s in doc["skus"]]


def sync_golden(conn, today: date, created_by: str = AGENT) -> list[int]:
    """So `golden_target` với golden file → ĐỀ XUẤT vào hàng duyệt → id mục
    mới. Mục mới nhất (pending/approved) của SKU luôn khớp đích hiện tại:
    đã khớp → bỏ qua (đang chờ duyệt / đã duyệt chờ người sửa golden);
    lệch → mục mới ghi "THAY THẾ mục #X" cho mọi mục cũ trái đích (gồm mục
    đã duyệt mà golden chưa sửa). Đích = golden nhưng còn mục cũ trái đích
    → mục "GIỮ NGUYÊN". Agent KHÔNG tự quyết/rút mục nào."""
    cfg = director.load_config("legal_hr")
    ids = []
    for sku, cur, target, rows, mine in _golden_state(conn, today):
        last = mine[-1] if mine else None
        if (last[1] == target) if last else (target == cur):
            continue
        stale = [i for i in mine if i[2] == "pending" and i[1] != target]
        if last and last[2] == "approved" and last[1] != cur:
            stale.append(last)          # đã duyệt nhưng golden chưa sửa
        oid = f"{sku}:{target}"
        if any(i[2] == "pending" and i[1] == target for i in mine):
            oid += f"@{last[0]}"        # mục cùng đích cũ hơn còn pending
        basis = ([d for d in rows if _valid_cap(d, today)]
                 or [d for d in rows if d["status"] in ("da_nop", "bo_sung")]
                 or rows)
        why = (f"hồ sơ #{basis[-1]['id']} ({basis[-1]['status']}, xác nhận"
               f" bởi {safe(basis[-1]['updated_by'])})" if basis
               else "không có hồ sơ nào")
        repl = (f" THAY THẾ mục {', '.join(f'#{i[0]}' for i in stale)} —"
                " chỉ duyệt mục mới nhất, KHÔNG sửa golden theo mục cũ."
                if stale else "")
        if target == cur:
            title = f"Giữ XNQC golden: {sku} {cur} (thay mục cũ)"
            payload = (f"Đề xuất GIỮ NGUYÊN data/golden_skus.json: {sku}"
                       f" xnqc_status {cur} theo {why}.{repl} Agent không"
                       " ghi file golden.")
        else:
            title = f"Đồng bộ XNQC golden: {sku} {cur}→{target}"
            payload = (f"Đề xuất sửa data/golden_skus.json: {sku} xnqc_status"
                       f" {cur}→{target} theo {why}; sau khi duyệt, người phụ"
                       " trách golden sửa file rồi chạy `python -m"
                       f" ingest.golden_store`.{repl} Agent không ghi file"
                       " golden.")
        ids.append(director.submit(conn, "legal_hr", "golden_xnqc_sync", oid,
                                   title, payload, created_by, cfg=cfg))
    return ids


def sync_notes(conn, today: date) -> list[str]:
    """CHỈ ĐỌC (SELECT + golden file) → dòng nhắc cho `--sync-golden` và báo
    cáo Pháp chế §1: mục pending LỖI THỜI (trái đích hiện tại), mục đã duyệt
    chờ người sửa golden / đã duyệt nhưng lỗi thời, golden lệch chưa có đề
    xuất."""
    out = []
    for sku, cur, target, _, mine in _golden_state(conn, today):
        for qid, t, st in mine:
            if st == "pending" and t != target:
                out.append(f"mục #{qid} {sku}→{t} LỖI THỜI (hồ sơ hiện suy"
                           f" ra {target}) — KHÔNG duyệt mục này")
        if mine and mine[-1][2] == "approved" and mine[-1][1] != cur:
            qid, t, _ = mine[-1]
            out.append(
                f"mục #{qid} {sku}→{t} đã duyệt — chờ người sửa golden (đang"
                f" {cur}) rồi chạy python -m ingest.golden_store" if t == target
                else f"mục #{qid} {sku}→{t} đã duyệt nhưng LỖI THỜI (hồ sơ"
                f" hiện suy ra {target}) — KHÔNG sửa golden theo mục này")
        if target != cur and not any(t == target for _, t, _ in mine):
            out.append(f"{sku}: golden {cur} lệch hồ sơ ({target}) — chưa có"
                       " đề xuất, chạy python -m agents.xnqc --sync-golden")
    return out


def _ddmm(d: date) -> str:
    return d.strftime("%d/%m/%Y")


def reminders(rows: list[dict], tpbvsk_skus: list[str], cfg: dict,
              today: date) -> list[str]:
    """Nhắc mốc đợt 2 + giấy sắp/đã hết hạn. THUẦN."""
    han, lead = cfg["dot2_han_nop"], cfg["nhac_truoc_ngay"]
    n = (han - today).days
    out = []
    for sku in tpbvsk_skus:
        mine = [d for d in rows if d["sku_key"] == sku]
        if any(_valid_cap(d, today) or d["status"] in ("da_nop", "bo_sung")
               for d in mine):
            continue
        if n < 0:
            out.append(f"QUÁ HẠN đợt 2 — {sku}: hạn {_ddmm(han)} đã qua"
                       f" {-n} ngày, chưa nộp hồ sơ")
        elif n <= lead:
            out.append(f"SẮP HẠN — {sku}: hạn đợt 2 {_ddmm(han)} còn {n}"
                       " ngày, chưa nộp hồ sơ")
        else:
            out.append(f"CHƯA NỘP — {sku}: hạn đợt 2 {_ddmm(han)} còn {n}"
                       " ngày")
    for d in rows:
        het = d["ngay_het_han"]
        if d["status"] != "da_cap" or het is None:
            continue
        left = (het - today).days
        if left < 0:
            out.append(f"ĐÃ QUÁ HẠN — Pháp chế chuyển het_han: hồ sơ"
                       f" #{d['id']} {d['sku_key']} hết hạn {_ddmm(het)}")
        elif left <= cfg["het_han_canh_bao_ngay"]:
            out.append(f"SẮP HẾT HẠN — hồ sơ #{d['id']} {d['sku_key']} hết"
                       f" hạn {_ddmm(het)} còn {left} ngày")
    return out


# ------------------------------------------------------- docx P2 soạn nháp
# legal_hr-02 (PL01 Pháp chế: "Soạn hồ sơ xác nhận nội dung quảng cáo
# TPBVSK, theo dõi kết quả"): trước đây chỉ có sổ theo dõi, không có đường
# SOẠN hồ sơ → loại việc `xnqc_dossier` (khối legal_hr) không bao giờ có mục.
# Nay `--draft` dựng NHÁP từ dữ liệu sẵn có (golden: tên, quy cách, số/ngày
# tiếp nhận công bố; claims đã công bố đúng SKU; maket người đưa vào) +
# danh mục thành phần `data/xnqc_draft.json` (GIẢ ĐỊNH chờ Pháp chế) →
# 1 mục hàng duyệt. Agent KHÔNG nộp, KHÔNG đổi trạng thái sổ.
DRAFT_FILE = CONFIG.parent / "xnqc_draft.json"
DRAFT_AGENT = "agent:xnqc"
CLAIMS_FILE = CONFIG.parent / "claims_whitelist.json"


def load_draft_config(path=DRAFT_FILE) -> dict:
    import json
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"{path.name} không đọc được ({type(e).__name__})")
    parts = doc.get("thanh_phan") if isinstance(doc, dict) else None
    if not (isinstance(parts, list) and parts
            and all(isinstance(x, str) and x.strip() for x in parts)):
        raise ValueError(f"{path.name}: thanh_phan phải là danh sách chữ")
    return doc


def draft_payload(sku: dict, loai: str, ten: str, claims: list[str],
                  cfg: dict, maket: str | None) -> str:
    """THUẦN → nội dung nháp hồ sơ (markdown, không PII)."""
    duyet = cfg.get("trang_thai") == "da_duyet"
    L = [f"# NHÁP hồ sơ XNQC — {safe(sku.get('name') or sku['sku_key'])}",
         "",
         f"- SKU: {sku['sku_key']} · loại hồ sơ: {loai} · tên: {safe(ten)}",
         f"- Quy cách: {safe(sku.get('pack_spec') or 'chưa có trong golden')}",
         (f"- Số tiếp nhận bản công bố: {safe(sku.get('receipt_no'))}"
          f" ngày {safe(sku.get('receipt_date') or '?')}"
          if sku.get("receipt_no") else
          "- Số tiếp nhận bản công bố: CHƯA CÓ trong golden — bổ sung"),
         "", "## Nội dung được nêu (claims đã công bố đúng SKU)"]
    L += [f"- {safe(c)}" for c in claims] or ["- (chưa có claim đã công bố)"]
    L += ["", "## Thành phần hồ sơ cần chuẩn bị"
          + ("" if duyet else " (danh mục CHƯA được Pháp chế duyệt)")]
    L += [f"- [ ] {safe(x)}" for x in cfg["thanh_phan"]]
    if maket:
        L += ["", "## Maket / kịch bản đưa vào", "", maket.strip()]
    L += ["", ("Agent chỉ soạn nháp — Pháp chế rà, hoàn thiện, nộp; ghi sổ"
               " bằng `python -m agents.xnqc --add/--set ... --by <tên>`.")]
    return "\n".join(L) + "\n"


def draft(conn, sku_key: str, loai: str, ten: str, maket: str | None,
          submit: bool) -> tuple[str, int | None]:
    """→ (payload, id mục hàng duyệt | None khi chỉ in). SKU phải là TPBVSK
    trong golden; maket qua guardrail đăng bài (vi phạm → vẫn soạn nháp,
    ghi rõ để Pháp chế sửa — không phải bài đăng)."""
    import hashlib
    import json

    from pipelines import guardrail
    doc, err = read_golden(GOLDEN_FILE)
    if err:
        raise ValueError(err)
    sku = next((s for s in doc.get("skus", []) if isinstance(s, dict)
                and s.get("sku_key") == sku_key), None)
    if sku is None or sku.get("category") != "tpbvsk":
        raise ValueError(f"SKU '{sku_key}' không phải TPBVSK trong golden")
    cl = json.loads(CLAIMS_FILE.read_text(encoding="utf-8")).get(sku_key)
    claims = (cl or {}).get("approved_claims") or []
    payload = draft_payload(sku, loai, ten, claims, load_draft_config(),
                            maket)
    if maket:
        v = guardrail.check_publish(maket, channel="facebook",
                                    content_type="post", sku=sku_key)
        codes = sorted({x.get("code") or x.get("type")
                        for x in v["violations"]})
        payload += ("\nGuardrail maket: " + (", ".join(codes) or "đạt")
                    + "\n")
    if not submit:
        return payload, None
    oid = (f"{sku_key}:{loai}:"
           f"{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:12]}")
    qid = director.submit(conn, "legal_hr", "xnqc_dossier", oid,
                          f"Nháp hồ sơ XNQC {sku_key} ({loai})", payload,
                          DRAFT_AGENT)
    return payload, qid


# ------------------------------------------------------------------ CLI
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.xnqc",
        description="PC-A1 sổ hồ sơ XNQC theo SKU + nhắc mốc + đề xuất đồng"
                    " bộ golden. da_cap CHỈ do người (Pháp chế) xác nhận.")
    ap.add_argument("--add", action="store_true", help="thêm hồ sơ chuan_bi")
    ap.add_argument("--set", metavar="ID", help="đổi trạng thái hồ sơ")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--remind", action="store_true",
                    help="nhắc mốc đợt 2 + giấy sắp hết hạn")
    ap.add_argument("--sync-golden", action="store_true",
                    help="đề xuất đồng bộ xnqc_status golden vào hàng duyệt")
    ap.add_argument("--sku")
    ap.add_argument("--loai", choices=LOAI)
    ap.add_argument("--ten")
    ap.add_argument("--status", choices=STATUSES)
    ap.add_argument("--by", help="tên NGƯỜI (không agent:/system:)")
    ap.add_argument("--so-giay")
    ap.add_argument("--ngay-nop")
    ap.add_argument("--ngay-cap")
    ap.add_argument("--het-han")
    ap.add_argument("--doc-sha")
    ap.add_argument("--today", help="ngày YYYY-MM-DD CHỈ cho --remind/"
                    "--sync-golden (mặc định hôm nay giờ VN)")
    ap.add_argument("--draft", action="store_true",
                    help="soạn NHÁP hồ sơ XNQC (--sku --loai --ten "
                    "[--maket FILE] [--submit])")
    ap.add_argument("--maket", help="file .txt/.md maket/kịch bản (--draft)")
    ap.add_argument("--submit", action="store_true",
                    help="--draft: đẩy nháp vào hàng duyệt legal_hr")
    a = ap.parse_args(argv)
    n_ops = sum([a.add, a.set is not None, a.list, a.remind, a.sync_golden,
                 a.draft])
    if n_ops != 1:
        ap.error("chọn đúng 1 thao tác: --add | --set | --list | --remind |"
                 " --sync-golden | --draft")
    if (a.maket or a.submit) and not a.draft:
        ap.error("--maket/--submit chỉ đi với --draft")
    if a.draft:
        if not (a.sku and a.loai and a.ten):
            ap.error("--draft cần --sku --loai --ten")
        try:
            maket = (Path(a.maket).read_text(encoding="utf-8")[:5000]
                     if a.maket else None)
        except OSError as e:
            ap.error(f"--maket không đọc được ({type(e).__name__})")
        conn = connect() if a.submit else None
        if a.submit and conn is None:
            print("[err] DB không truy cập được")
            return 2
        try:
            payload, qid = draft(conn, a.sku, a.loai, a.ten, maket, a.submit)
        except (ValueError, OSError) as e:
            print(f"[err] {e}")
            return 1
        except psycopg.Error as e:
            print(f"[err] lỗi DB: {_db_msg(e)}")
            return 2
        finally:
            if conn is not None:
                conn.close()
        print(payload)
        if qid is not None:
            print(f"[ok] nháp hồ sơ → hàng duyệt legal_hr #{qid}")
        return 0
    if a.today is not None and not (a.remind or a.sync_golden):
        # đẩy "hôm nay" tới trước = lách chặn ngày cấp/nộp tương lai
        ap.error("--today chỉ đi với --remind/--sync-golden — --set/--add"
                 " dùng ngày thật")
    try:
        today = _date(a.today, "--today") or datetime.now(VN_TZ).date()
        for v, w in ((a.ngay_nop, "--ngay-nop"), (a.ngay_cap, "--ngay-cap"),
                     (a.het_han, "--het-han")):
            _date(v, w)
    except ValueError as e:
        ap.error(str(e))
    if a.add or a.set is not None:
        err = by_error(a.by)
        if err:
            ap.error(err)
    if a.add and not (a.sku and a.loai and a.ten):
        ap.error("--add cần --sku --loai --ten --by")
    if a.set is not None and (a.status is None or not a.set.isdigit()):
        ap.error("--set cần ID số và --status")
    tp = cfg = None
    if a.remind:
        try:
            cfg, tp = load_config(CONFIG), tpbvsk_skus()
        except ValueError as e:
            print(f"[err] cấu hình: {e}")
            return 2
    conn = connect()
    if conn is None:
        print("[err] DB không truy cập được")
        return 2
    try:
        if a.add:
            try:
                did = add(conn, a.sku, a.loai, a.ten, a.by)
            except ValueError as e:
                print(f"[err] {e}")
                return 1
            print(f"[ok] hồ sơ #{did} ({a.sku}, {a.loai}) — chuan_bi")
            return 0
        if a.set is not None:
            # v14.2: đổi trạng thái hồ sơ (kể cả da_cap) = quyết định của
            # Pháp chế được Bên B ủy quyền (auth.cli_gate, khối legal_hr).
            why = auth.cli_gate(conn, a.by, "legal_hr", "set_status",
                                "xnqc_dossier", a.set)
            if why:
                conn.rollback()
                print(f"[từ chối] {why}")
                return 1
            ok, msg = set_status(conn, a.set, a.status, a.by,
                                 so_giay=a.so_giay, ngay_nop=a.ngay_nop,
                                 ngay_cap=a.ngay_cap, ngay_het_han=a.het_han,
                                 doc_sha=a.doc_sha, today=today)
            print(("[ok] " if ok else "[từ chối] ") + msg)
            return 0 if ok else 1
        if a.list:
            rows = list_dossiers(conn)
            print(f"[xnqc] {len(rows)} hồ sơ")
            for d in rows:
                print(f"#{d['id']} {d['sku_key']} {d['loai_ho_so']}"
                      f" [{d['status']}] {_mask_pii(safe(d['ten_ho_so']))[:80]}"
                      f" — số giấy {safe(d['so_giay'] or '—')}, nộp"
                      f" {d['ngay_nop'] or '—'}, cấp {d['ngay_cap'] or '—'},"
                      f" hết hạn {d['ngay_het_han'] or '—'} — bởi"
                      f" {safe(d['updated_by'])}")
            return 0
        if a.remind:
            ms = reminders(list_dossiers(conn), tp, cfg, today)
            print(f"[xnqc] nhắc mốc ngày {_ddmm(today)} — {len(ms)} mục")
            for m in ms:
                print(f"- {m}")
            return 0
        ids = sync_golden(conn, today)
        print(f"[ok] đề xuất đồng bộ golden mới: {ids or 'không có'}")
        for m in sync_notes(conn, today):
            print(f"- {m}")
        return 0
    except (psycopg.Error, ValueError) as e:
        conn.rollback()
        print(f"[err] {type(e).__name__}: {safe(_mask_pii(str(e)))[:200]}")
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
