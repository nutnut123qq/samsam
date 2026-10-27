"""v6.4 MKT-06 (WP08) — kit KOC/affiliate từ nội dung ĐÃ DUYỆT. Tất định
(template), KHÔNG LLM, KHÔNG mạng.

Ranh giới: agent KHÔNG gửi kit, KHÔNG liên hệ KOC, KHÔNG tạo link affiliate
thật. Output: 1 mục NHÁP `marketing/koc_brief` (`koc-<code>-<sha12>`) +
khi đã duyệt, `--release` ghi file `data/reports/koc-kit-<code>-<qid>.md`
(gitignored) để người phụ trách gửi TAY.

KOC = danh sách MẪU `data/koc_sample.json` (`KOC-MAU-xx`, không handle/tên/
SĐT — KOC thật + hợp đồng ký là external-dep). Mỗi KOC trỏ 1 file hợp đồng
(mẫu NHÁP v4.4) — `scripts.contract_check.missing_clauses(text, "koc")`
phải rỗng (kiểm từ khóa ≠ đã ký/đã rà luật sư).

`build_kit` THUẦN, chặn theo cùng ánh xạ MKT-05 (`agents.mkt_ads`):
  KIT_OFFLINE_ONLY       SKU rượu (xét trước readiness)
  KIT_LISTING_ONLY       readiness MO_TA (TPBVSK chưa XNQC)
  KIT_CAM                readiness ngoài `mkt_calendar.CONTENT_OK`
  KIT_CREATIVE_UNAPPROVED draft thiếu/chưa duyệt/khác SKU/loại lạ/lệch bản duyệt
  KIT_CONTRACT           hợp đồng thiếu điều khoản / file thiếu/ngoài repo/hỏng
  KIT_GUARDRAIL          kit không qua `check_publish(content_type="koc",
                         is_sponsored=True)` hoặc `check()` của hàng duyệt
Kit: brief = text NGUYÊN VĂN draft đã duyệt; "được nói" = `matched_claims`
snapshot guardrail của draft; "không được nói" diễn đạt theo NHÓM (không
chép từ cấm/tên SKU nhóm cấm); câu khuyến cáo khi TPBVSK; nhãn `#quangcao`
(+ nhãn AI); link/mã affiliate PLACEHOLDER; sha256 hợp đồng tham chiếu.

`--release`: mục `koc_brief` approved + `approval_queue.verify` khớp payload
+ sha hợp đồng hiện tại == sha trong kit + `missing_clauses == []` → file;
sai → KIT_NOT_APPROVED / KIT_CONTRACT_CHANGED (exit 1).

Chạy:
  python -m agents.mkt_koc --list
  python -m agents.mkt_koc --kit --koc CODE --sku SKU [--channel CH] --draft-ids 1,2 --by "Tên" [--dry-run]
  python -m agents.mkt_koc --release QID --by "Tên"
Exit: 0 ok/skip · 1 bị chặn (in mã) / cấu hình / DB lỗi · 2 usage / DB down.
"""

import argparse
import hashlib
import json
import re
import sys
from contextlib import suppress
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, queue_sample, write_report
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import director, guardrail, store
from pipelines.mkt_calendar import CONTENT_OK
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg
from scripts.contract_check import _read as read_contract_file
from scripts.contract_check import missing_clauses

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
KOC_FILE = ROOT / "data" / "koc_sample.json"
CODES = ("KIT_OFFLINE_ONLY", "KIT_LISTING_ONLY", "KIT_CAM",
         "KIT_CREATIVE_UNAPPROVED", "KIT_CONTRACT", "KIT_GUARDRAIL")
RELEASE_CODES = ("KIT_NOT_APPROVED", "KIT_CONTRACT_CHANGED")
KOC_KEYS = ("code", "platform", "niche", "contract_file", "contract_status")
PLATFORMS = ("tiktok", "facebook")
KIT_TYPES = ("post", "ads", "koc", "image")
MAX_DRAFTS = 5
_CODE_RE = re.compile(r"KOC-MAU-\d{2}")
_OID_RE = re.compile(r"koc-(KOC-MAU-\d{2})-[0-9a-f]{12}")
_FILE_LINE = re.compile(r"^- File hợp đồng: `([^`\n]+)`$", re.MULTILINE)
_SHA_LINE = re.compile(r"^- contract_sha256: `([0-9a-f]{64})`$", re.MULTILINE)
AD_LABEL = "#quangcao"
DONT_SAY = (
    ("- Mọi công dụng ngoài đúng các câu đã duyệt ở trên — không tự thêm, "
    "không nói quá, không kể trải nghiệm sức khỏe cá nhân."),
    ("- Không so sánh sản phẩm với dược phẩm, không nói sản phẩm thay thế "
    "việc khám bác sĩ."),
    ("- Không dùng các từ/cụm trong danh sách từ cấm của Sâm Sâm (Pháp chế "
    "giữ danh sách, KOC nhận bản riêng kèm hợp đồng)."),
    ("- Không nhắc tới đồ uống thuộc nhóm cấm quảng cáo của công ty; không "
    "nêu địa danh vùng trồng/chỉ dẫn địa lý khi Pháp chế chưa xác nhận."),
    "- Không đưa số điện thoại, link mua hàng thật hay mã khuyến mãi tự đặt.",
)


class KocConfigError(ValueError):
    """koc_sample.json thiếu/hỏng/sai mẫu."""


def load_kocs(path: Path | None = None) -> list[dict]:
    """Fail-closed: file thiếu/hỏng, `{}`/chỉ `_doc`, key lạ, code sai mẫu,
    trùng code → KocConfigError."""
    p = Path(path or KOC_FILE)
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError as e:
        raise KocConfigError(f"không có file {p.name}") from e
    except (OSError, ValueError) as e:
        raise KocConfigError(f"{p.name} hỏng ({type(e).__name__})") from e
    if not isinstance(raw, dict) or set(raw) != {"_doc", "kocs"}:
        raise KocConfigError(f"{p.name}: gốc phải có đúng '_doc' + 'kocs'")
    kocs = raw["kocs"]
    if not isinstance(kocs, list) or not kocs:
        raise KocConfigError(f"{p.name}: 'kocs' rỗng")
    seen = set()
    for i, k in enumerate(kocs):
        if not isinstance(k, dict) or set(k) != set(KOC_KEYS):
            raise KocConfigError(f"kocs[{i}]: cần đúng key {KOC_KEYS}")
        if not isinstance(k["code"], str) or not _CODE_RE.fullmatch(k["code"]):
            raise KocConfigError(f"kocs[{i}].code phải KOC-MAU-<2 số>")
        if k["code"] in seen:
            raise KocConfigError(f"kocs[{i}].code trùng")
        seen.add(k["code"])
        if k["platform"] not in PLATFORMS:
            raise KocConfigError(f"kocs[{i}].platform phải {PLATFORMS}")
        if not isinstance(k["niche"], str) or not 1 <= len(
                k["niche"].strip()) <= 60:
            raise KocConfigError(f"kocs[{i}].niche phải 1..60 ký tự")
        cf = k["contract_file"]
        if (not isinstance(cf, str) or not cf.strip() or Path(cf).is_absolute()
                or ".." in Path(cf).parts):
            raise KocConfigError(f"kocs[{i}].contract_file phải đường dẫn "
                                 "tương đối trong repo")
        if k["contract_status"] != "NHAP_MAU":
            raise KocConfigError(f"kocs[{i}].contract_status phải NHAP_MAU "
                                 "(hợp đồng ký thật = external-dep)")
    return kocs


def load_contract(rel: str) -> tuple[str | None, str | None, str | None]:
    """→ (text, sha256 text utf-8, lỗi). File ngoài repo/thiếu/hỏng → lỗi."""
    try:
        base = ROOT.resolve()
        p = (base / rel).resolve()
        p.relative_to(base)
    except (ValueError, OSError):
        return None, None, "file hợp đồng nằm ngoài repo"
    try:
        text = read_contract_file(p)
    except (ValueError, OSError) as e:
        why = str(e) if isinstance(e, ValueError) else type(e).__name__
        return None, None, f"file hợp đồng không dùng được ({why})"
    return text, hashlib.sha256(text.encode("utf-8")).hexdigest(), None


def _codes(g: dict) -> list:
    return sorted({v.get("code") for v in g.get("violations", [])
                   if isinstance(v, dict)})


def _draft_why(d, sku: str) -> str | None:
    if not isinstance(d, dict) or d.get("id") is None:
        return "draft không tồn tại"
    i = d["id"]
    if d.get("status") != "approved":
        return f"draft #{i} chưa duyệt (trạng thái {d.get('status')})"
    if d.get("sku") != sku:
        return f"draft #{i} gắn SKU khác SKU kit"
    if d.get("content_type") not in KIT_TYPES:
        return f"draft #{i} loại {d.get('content_type')} — cần {KIT_TYPES}"
    if d.get("verified") is not True:
        return f"draft #{i} không khớp bản đã duyệt (verify_publish)"
    return None


def render_kit(koc: dict, sku: str, channel: str, drafts: list[dict],
               category: str | None, contract_sha: str) -> tuple[str, bool]:
    """→ (kit markdown, is_ai). Tất định theo input."""
    is_ai = any(d.get("is_ai") is not False for d in drafts)
    claims, seen = [], set()
    for d in drafts:
        g = d.get("guardrail") if isinstance(d.get("guardrail"), dict) else {}
        for m in g.get("matched_claims") or []:
            c = m.get("claim") if isinstance(m, dict) else None
            if isinstance(c, str) and c.strip() and c not in seen:
                seen.add(c)
                claims.append(c)
    cfg, _err = guardrail._load_rules(guardrail.DATA_DIR)
    canonical = cfg["canonical"] if cfg else None
    code = koc["code"]
    L = [(f"# Kit KOC {code} — `{sku}` × {channel} (NHÁP — chỉ phát hành bản "
         "đã duyệt)"), "",
         (f"KOC MẪU {code} ({koc['platform']}, {koc['niche'].strip()}). Hệ "
         "thống KHÔNG gửi kit, KHÔNG liên hệ KOC — người phụ trách gửi tay "
         "sau khi GĐ Marketing duyệt."), "",
         "## Brief (nguyên văn nội dung đã duyệt)", ""]
    for d in drafts:
        L += [f"### Bài #{d['id']}", "", (d.get("text") or "").strip(), ""]
    L += ["## Điểm được nói", ""]
    L += ([f"- {c}" for c in claims] or [
        ("- Chỉ nội dung trong brief ở trên — sản phẩm không có câu công "
        "dụng nào được duyệt để nhắc thêm.")])
    L += ["", "## Điểm KHÔNG được nói", "", *DONT_SAY, ""]
    if category == "tpbvsk":
        L += ["## Câu khuyến cáo bắt buộc (đọc/ghi nguyên văn)", "",
              f"{canonical}", ""]
    L += ["## Nhãn bắt buộc khi đăng", "", f"- {AD_LABEL}"]
    if is_ai:
        L.append(f"- {cfg['labels_ai'][0] if cfg else ''}")
    L += ["", "## Link/mã affiliate (placeholder — chưa phải link thật)", "",
          "- Link: {{LINK_AFFILIATE}}",
          f"- Mã: AFF-{code}-{sku}-PLACEHOLDER", "",
          "## Hợp đồng tham chiếu (NHÁP mẫu — chưa ký)", "",
          f"- File hợp đồng: `{koc['contract_file']}`",
          f"- contract_sha256: `{contract_sha}`",
          ("- contract_check: đủ điều khoản theo kiểm từ khóa — KHÔNG thay rà"
          " soát của Pháp chế/luật sư."), ""]
    return "\n".join(L), is_ai


def build_kit(koc: dict, sku: str, channel: str, drafts: list, golden: dict,
              *, readiness: dict | None = None, contract_text: str | None,
              contract_sha: str | None = None,
              contract_err: str | None = None) -> dict:
    """THUẦN → {code | None, reason, kit, sha12, contract_sha}. golden =
    {sku: {category}}, readiness = map view (None → soi golden file),
    drafts = [{id, status, sku, content_type, text, is_ai, verified,
    guardrail}]."""
    g = golden.get(sku)
    cat = g.get("category") if isinstance(g, dict) else None
    if cat == "alcohol":
        return {"code": "KIT_OFFLINE_ONLY", "reason": (
            "SKU nhóm offline_only (đồ uống có cồn) — không có kit KOC")}
    lvl = (readiness.get((sku, channel)) if readiness is not None
           else guardrail.readiness(sku, channel))
    if lvl == "MO_TA":
        return {"code": "KIT_LISTING_ONLY", "reason": (
            f"{sku} × {channel}: listing_only (TPBVSK chưa XNQC)")}
    if lvl not in CONTENT_OK or cat is None:
        return {"code": "KIT_CAM", "reason": (
            f"{sku} × {channel}: readiness {lvl or 'không có'}")}
    if not drafts or len(drafts) > MAX_DRAFTS:
        return {"code": "KIT_CREATIVE_UNAPPROVED",
                "reason": f"cần 1..{MAX_DRAFTS} draft đã duyệt"}
    for d in drafts:
        why = _draft_why(d, sku)
        if why:
            return {"code": "KIT_CREATIVE_UNAPPROVED", "reason": why}
    if contract_text is None:
        return {"code": "KIT_CONTRACT",
                "reason": contract_err or "không đọc được hợp đồng"}
    miss = missing_clauses(contract_text, "koc")
    if miss:
        return {"code": "KIT_CONTRACT",
                "reason": f"hợp đồng thiếu điều khoản: {', '.join(miss)}"}
    csha = contract_sha or hashlib.sha256(
        contract_text.encode("utf-8")).hexdigest()
    kit, is_ai = render_kit(koc, sku, channel, drafts, cat, csha)
    pub = guardrail.check_publish(kit, channel=channel, content_type="koc",
                                  sku=sku, is_ai=is_ai, is_sponsored=True,
                                  readiness=readiness)
    if pub.get("ok") is not True:
        return {"code": "KIT_GUARDRAIL",
                "reason": f"kit không qua guardrail đăng bài {_codes(pub)}"}
    base = guardrail.check(kit)
    if base.get("ok") is not True:
        return {"code": "KIT_GUARDRAIL",
                "reason": f"kit không qua guardrail hàng duyệt {_codes(base)}"}
    sha = hashlib.sha256(kit.encode("utf-8")).hexdigest()
    return {"code": None, "reason": "đạt", "kit": kit, "sha12": sha[:12],
            "contract_sha": csha}


# ---------- DB ----------

def load_drafts(conn, ids: list[int]) -> list[dict]:
    rows = {r[0]: r for r in conn.execute(
        "select id, status, sku, content_type, text, is_ai, guardrail from"
        " content_drafts where id = any(%s)", (ids,))}
    out = []
    for i in ids:
        r = rows.get(i)
        if r is None:
            out.append({"id": i, "status": "khong_ton_tai"})
            continue
        out.append({"id": i, "status": r[1], "sku": r[2],
                    "content_type": r[3], "text": r[4], "is_ai": r[5],
                    "guardrail": r[6],
                    "verified": store.verify_publish(conn, i, r[4])})
    return out


def submit_kit(conn, koc: dict, sku: str, channel: str, ids: list[int], *,
               by: str, dcfg: dict | None = None,
               dry_run: bool = False) -> dict:
    golden = {k: {"category": c} for k, c in conn.execute(
        "select sku_key, category from sku_master")}
    rmap = store.readiness_from_db(conn)
    drafts = load_drafts(conn, ids)
    conn.commit()   # đóng tx đọc
    text, csha, err = load_contract(koc["contract_file"])
    res = build_kit(koc, sku, channel, drafts, golden,
                    readiness=rmap if rmap is not None else {},
                    contract_text=text, contract_sha=csha, contract_err=err)
    if res["code"] or dry_run:
        return {**res, "qid": None, "skipped": False}
    oid = f"koc-{koc['code']}-{res['sha12']}"
    if conn.execute("select exists(select 1 from approval_queue where"
                    " object_type = 'koc_brief' and object_id = %s)",
                    (oid,)).fetchone()[0]:
        conn.commit()
        return {**res, "qid": None, "skipped": True, "object_id": oid}
    try:
        qid = director.submit(conn, "marketing", "koc_brief", oid,
                              f"Kit KOC {koc['code']} — {sku} × {channel}",
                              res["kit"], created_by=by, cfg=dcfg)
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        return {**res, "qid": None, "skipped": True, "object_id": oid}
    return {**res, "qid": qid, "skipped": False, "object_id": oid}


def release(conn, qid, *, out_dir: Path | None = None) -> dict:
    """→ {code | None, reason, path}. Không gửi — chỉ ghi file."""
    row = conn.execute("select block, object_type, object_id, payload, status"
                       " from approval_queue where id = %s", (qid,)).fetchone()
    if row is None or row[0] != "marketing" or row[1] != "koc_brief":
        conn.commit()
        return {"code": "KIT_NOT_APPROVED",
                "reason": f"mục #{qid} không phải kit KOC"}
    _, _, oid, payload, status = row
    ok = status == "approved" and aq.verify(conn, qid, payload)
    conn.commit()
    m = _OID_RE.fullmatch(oid or "")
    if not ok or m is None:
        return {"code": "KIT_NOT_APPROVED",
                "reason": f"mục #{qid} trạng thái {status} / không khớp bản "
                          "đã duyệt"}
    fm, sm = _FILE_LINE.search(payload), _SHA_LINE.search(payload)
    if fm is None or sm is None:
        return {"code": "KIT_CONTRACT_CHANGED",
                "reason": "kit không ghi hợp đồng tham chiếu"}
    text, csha, err = load_contract(fm.group(1))
    if text is None:
        return {"code": "KIT_CONTRACT_CHANGED", "reason": err}
    if csha != sm.group(1):
        return {"code": "KIT_CONTRACT_CHANGED",
                "reason": "hợp đồng đã sửa sau khi kit được lập — lập kit lại"}
    miss = missing_clauses(text, "koc")
    if miss:
        return {"code": "KIT_CONTRACT_CHANGED",
                "reason": f"hợp đồng thiếu điều khoản: {', '.join(miss)}"}
    # P8.4: sổ KOC hiện là MẪU (`KOC-MAU-xx`) → luôn mẫu; ngoài ra theo cờ
    # mục hàng duyệt.
    path = write_report(payload, out_dir or REPORTS_DIR,
                        f"koc-kit-{m.group(1)}-{qid}.md",
                        sample=bool(re.search(r"KOC-MAU-\d{2}", oid or ""))
                        or queue_sample(conn, qid))
    return {"code": None, "reason": "đạt", "path": path}


# ---------- CLI ----------

def _ids(s: str) -> list[int] | None:
    parts = [p.strip() for p in (s or "").split(",")]
    if not parts or not all(p.isascii() and p.isdigit() for p in parts):
        return None
    ids = [int(p) for p in parts]
    ok = 1 <= len(ids) <= MAX_DRAFTS and len(set(ids)) == len(ids)
    return ids if ok and all(i > 0 for i in ids) else None


def _block(code: str, why: str) -> int:
    print(f"[chặn] {code}: {_mask_pii(why)} — không ghi gì.")
    return 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.mkt_koc",
        description="MKT-06 kit KOC/affiliate từ nội dung đã duyệt — NHÁP vào"
                    " hàng duyệt (không gửi, không liên hệ KOC)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--kit", action="store_true")
    ap.add_argument("--release", type=int, metavar="QID")
    ap.add_argument("--koc")
    ap.add_argument("--sku")
    ap.add_argument("--channel")
    ap.add_argument("--draft-ids")
    ap.add_argument("--by")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    n_ops = a.list + a.kit + (a.release is not None)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --list | --kit | --release")
    by = (a.by or "").strip()
    if (a.kit or a.release is not None) and not by:
        ap.error("--kit/--release cần --by <tên người>")
    try:
        kocs = {k["code"]: k for k in load_kocs()}
    except KocConfigError as e:
        print(f"[err] {e} — không connect.")
        return 1
    if a.list:
        for k in kocs.values():
            text, _, err = load_contract(k["contract_file"])
            miss = missing_clauses(text, "koc") if text is not None else None
            st = (err if text is None else
                  "đủ điều khoản (kiểm từ khóa)" if not miss else
                  f"THIẾU {', '.join(miss)}")
            print(f"- {k['code']} [{k['platform']}] {k['niche']} — hợp đồng "
                  f"{k['contract_status']}: {st}")
        print("Danh sách MẪU — không phải KOC thật; agent không liên hệ KOC.")
        return 0
    koc = None
    ids = None
    channel = None
    if a.kit:
        koc = kocs.get(a.koc or "")
        if koc is None:
            ap.error(f"--koc phải một trong {sorted(kocs)}")
        if not a.sku:
            ap.error("--kit cần --sku")
        ids = _ids(a.draft_ids)
        if ids is None:
            ap.error(f"--draft-ids phải 1..{MAX_DRAFTS} id số, cách dấu phẩy")
        channel = a.channel or koc["platform"]
        if channel != koc["platform"]:
            ap.error(f"--channel phải trùng nền tảng KOC ({koc['platform']})")
        from pipelines import rollout
        # r19 (r12 RB): tắt → không dựng kit/đẩy mục, cả --dry-run.
        if why := rollout.blocked(None, "kit KOC", fid="marketing-04.1"):
            return rollout.say_blocked(why)
    try:
        dcfg = director.load_config("marketing")
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối marketing: {e} — không connect.")
        return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.release is not None:
            res = release(conn, a.release)
            if res["code"]:
                return _block(res["code"], res["reason"])
            print(f"[release] kit mục #{a.release} → {res['path']} (phát hành"
                  f" bởi {by}) — người phụ trách gửi TAY cho KOC; hệ thống "
                  "không gửi.")
            return 0
        res = submit_kit(conn, koc, a.sku, channel, ids, by=by, dcfg=dcfg,
                         dry_run=a.dry_run)
        if res["code"]:
            return _block(res["code"], res["reason"])
        if a.dry_run:
            print(f"[dry-run] kit {koc['code']} × `{a.sku}` đạt mọi luật chặn"
                  " — không ghi.")
        elif res["skipped"]:
            print(f"[skip] kit {res['object_id']} đã có trong hàng duyệt — "
                  "không tạo thêm.")
        else:
            print(f"[kit] mục hàng duyệt #{res['qid']} (koc_brief, CHỜ GĐ "
                  "Marketing duyệt) — agent không gửi/liên hệ KOC.")
        return 0
    except (psycopg.Error, ValueError, OSError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else type(e).__name__
        print(f"[error] {type(e).__name__}: {_mask_pii(msg)}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
