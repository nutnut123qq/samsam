"""v6.4 MKT-07 (WP08) — UGC/review → ĐỀ XUẤT trả lời + xin phép dùng lại.
Tất định (luật + template), KHÔNG LLM, KHÔNG mạng.

Ranh giới: agent KHÔNG tự trả lời/đăng/nhắn khách. Output DUY NHẤT là mục
NHÁP trong `approval_queue`: `marketing/ugc_reply` (risk medium — câu trả
lời đề xuất HOẶC nháp tin xin phép dùng lại, người đăng/gửi tay sau duyệt)
và `marketing/ugc_reuse` (risk high — đề nghị tái sử dụng UGC, CHỈ khi
`ingest.crm.can_contact(conn, contact_id, "marketing")`).

Nguồn: (a) `--reviews FILE --channel shopee|tiktok` — file review sàn xuất
tay (map cột GIẢ ĐỊNH `data/ugc_rules.json`; cột người mua/ảnh bỏ NGAY khi
đọc; `noi_dung` qua `_mask_pii` ngay khi đọc, chỉ nằm trong RAM — không ghi
DB/không in); (b) `--mentions --since YYYY-MM-DD` — bảng `social_mentions`
v7.2 (CHỈ nhãn: DPIA chưa ký → không có text; fanpage→facebook,
zalo_oa→zalo).

`classify` THUẦN, ưu tiên: ruou → claim_suc_khoe (câu hỏi sức khỏe / nhãn
hoi_suc_khoe / guardrail thấy từ cấm hoặc claim công dụng trong lời khách)
→ khieu_nai → che (nhãn hoặc ≤2 sao) → khen (nhãn hoặc ≥4 sao) → hoi_gia →
khac (không soạn). `draft_reply` theo template; `no_claim_echo` chặn câu trả
lời lặp lại claim/từ khóa sức khỏe khách nói (so bản fold). Câu trả lời
phải qua `check_publish(content_type="post", is_ai=False)`.

object_id = `ugc-` + 16 hex đầu sha256 `INTEL_HASH_SALT|kênh|mã đánh giá`
(`ingest.intel_import.msg_hash` — thiếu muối → exit 1 trước connect); đã có
ở bất kỳ trạng thái → skip. Payload KHÔNG chép nội dung khách.

Chạy:
  python -m agents.mkt_ugc --reviews FILE.csv --channel shopee|tiktok --by "Tên" [--dry-run]
  python -m agents.mkt_ugc --mentions --since YYYY-MM-DD --by "Tên" [--dry-run]
  python -m agents.mkt_ugc --reuse-request REF --by "Tên"
  python -m agents.mkt_ugc --reuse REF --contact-id N --by "Tên"
Exit: 0 ok/skip · 1 bị chặn (in mã) / cấu hình / DB lỗi · 2 usage / DB down.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import date, datetime, time
from pathlib import Path

import psycopg

from ingest import crm
from ingest.intel_import import SALT_MIN, classify_social, load_social_rules, msg_hash
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import _strip_accents, is_health_question
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RULES_FILE = ROOT / "data" / "ugc_rules.json"
CHANNELS_FILE = ROOT / "data" / "channels.json"
CLASSES = ("ruou", "claim_suc_khoe", "nghi_hang_gia", "khieu_nai", "che",
           "khen", "hoi_gia", "khac")
SENSITIVE = ("ruou", "claim_suc_khoe")
TEMPLATE_KEYS = ("khen", "che", "khieu_nai", "hoi_gia", "xin_phep")
REVIEW_FIELDS = ("ma_danh_gia", "so_sao", "noi_dung", "thoi_gian")
REVIEW_CHANNELS = ("shopee", "tiktok")
MENTION_CHANNEL = {"fanpage": "facebook", "zalo_oa": "zalo",
                   "tiktok": "tiktok"}
CODES = ("UGC_ECHO", "UGC_GUARDRAIL", "UGC_UNKNOWN_REF", "UGC_SENSITIVE",
         "UGC_NO_CONSENT")
MAX_BYTES = 5_000_000
MAX_ROWS = 5_000
MAX_TEXT = 5_000      # ký tự / review — chặn DoS guardrail trên text khách
NOTE = ("Agent KHÔNG tự trả lời/đăng/nhắn khách — người phụ trách đăng/gửi "
        "TAY sau khi duyệt. Không chép nội dung khách (chỉ tham chiếu "
        "nguồn).")
_REF_RE = re.compile(r"ugc-[0-9a-f]{16}")
_LOP_RE = re.compile(r"\[lop=([a-z_]+)\]")
_KENH_RE = re.compile(r"\[kenh=([a-z_]+)\]")


class UgcConfigError(ValueError):
    """ugc_rules.json / channels.json / social_rules.json thiếu hoặc hỏng."""


def load_rules(path: Path | None = None,
               channels_path: Path | None = None) -> dict:
    """Fail-closed → {templates (gồm health/alcohol từ channels.json),
    health_terms, review_columns, social}."""
    p = Path(path or RULES_FILE)
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
        ch = json.loads(Path(channels_path or CHANNELS_FILE).read_bytes()
                        .decode("utf-8"))["templates"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise UgcConfigError(f"không đọc được luật UGC ({type(e).__name__})"
                             ) from e
    # docx P2: `counterfeit_terms` TÙY CHỌN (thiếu = không có lớp
    # nghi_hang_gia — như trước).
    if not isinstance(raw, dict) or set(raw) - {"counterfeit_terms"} != {
            "_doc", "templates", "health_terms", "review_columns"}:
        raise UgcConfigError(f"{p.name}: cần đúng key _doc, templates, "
                             "health_terms, review_columns")
    t = raw["templates"]
    if not isinstance(t, dict) or set(t) != set(TEMPLATE_KEYS) or not all(
            isinstance(v, str) and v.strip() for v in t.values()):
        raise UgcConfigError(f"templates phải đủ {TEMPLATE_KEYS}, không rỗng")
    reuse = {}
    for k in ("health", "health_san", "alcohol", "alcohol_san"):
        if not isinstance(ch.get(k), str) or not ch[k].strip():
            raise UgcConfigError(f"channels.json thiếu template '{k}'")
        reuse[k] = ch[k]
    terms = raw["health_terms"]
    if not isinstance(terms, list) or not terms or not all(
            isinstance(x, str) and x.strip() for x in terms):
        raise UgcConfigError("health_terms rỗng hoặc sai kiểu")
    cols = raw["review_columns"]
    if not isinstance(cols, dict) or set(cols) != set(REVIEW_CHANNELS):
        raise UgcConfigError(f"review_columns phải đúng {REVIEW_CHANNELS}")
    for c, spec in cols.items():
        if (not isinstance(spec, dict) or set(spec) != {"columns", "drop"}
                or not isinstance(spec["columns"], dict)
                or sorted(spec["columns"].values()) != sorted(REVIEW_FIELDS)
                or not isinstance(spec["drop"], list)
                or not all(isinstance(x, str) for x in spec["drop"])):
            raise UgcConfigError(f"review_columns.{c}: columns phải map đủ "
                                 f"{REVIEW_FIELDS} + drop list")
    social, errs = load_social_rules()
    if social is None:
        raise UgcConfigError(f"social_rules.json: {errs[:2]}")
    fake = raw.get("counterfeit_terms", [])
    if not isinstance(fake, list) or not all(
            isinstance(x, str) and x.strip() for x in fake):
        raise UgcConfigError("counterfeit_terms phải là danh sách chữ")
    return {"templates": {**t, **reuse}, "health_terms": list(terms),
            "review_columns": cols, "social": social,
            "counterfeit_terms": [_norm(x) for x in fake]}


# ---------- thuần ----------

def classify(text: str | None, stars: int | None, rules: dict,
             labels=()) -> str:
    """→ 1 lớp trong CLASSES. text đã che PII; labels = nhãn v7.2 có sẵn."""
    labs = set(labels or ())
    t = text if isinstance(text, str) and text.strip() else None
    if t:
        labs |= set(classify_social(t, rules["social"]))
    if "hoi_ruou" in labs or (t and is_alcohol(t)):
        return "ruou"
    if "hoi_suc_khoe" in labs or (t and is_health_question(t)):
        return "claim_suc_khoe"
    if t and any(v.get("code") in ("tu_cam", "claim_ngoai_cong_bo")
                 for v in guardrail.check(t).get("violations", [])):
        return "claim_suc_khoe"
    # docx P2 (PL01 Marketing "phân loại bình luận (hỏi giá, khiếu nại, nghi
    # hàng giả…)"): khách nghi hàng giả/nhái → lớp riêng, trước khiếu nại.
    if t and any(_has(x, _norm(t)) or _has(x, _norm(_strip_accents(t)))
                 for x in rules.get("counterfeit_terms", ())):
        return "nghi_hang_gia"
    if "khieu_nai" in labs:
        return "khieu_nai"
    if "che" in labs or (stars is not None and stars <= 2):
        return "che"
    if "khen" in labs or (stars is not None and stars >= 4):
        return "khen"
    if "hoi_gia" in labs:
        return "hoi_gia"
    return "khac"


def draft_reply(cls: str, rules: dict, *, san: bool) -> str | None:
    """Template theo lớp; sàn (`san=True`) dùng câu *_san. khac → None."""
    t = rules["templates"]
    if cls == "claim_suc_khoe":
        return t["health_san" if san else "health"]
    if cls == "ruou":
        return t["alcohol_san" if san else "alcohol"]
    if cls == "nghi_hang_gia":      # xin lỗi + mời liên hệ (như khiếu nại)
        return t["khieu_nai"]
    return t.get(cls) if cls in TEMPLATE_KEYS else None


def _norm(s: str) -> str:
    return " ".join(unicodedata.normalize("NFC", s or "").casefold().split())


def _has(term: str, hay: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(term)}(?!\w)", hay) is not None


def no_claim_echo(reply: str, customer: str,
                  terms) -> tuple[bool, list[str]]:
    """Câu trả lời KHÔNG được chứa (bản fold) span vi phạm guardrail trong
    lời khách hay từ khóa sức khỏe khách nói. Từ khách gõ không dấu → so
    trên bản bỏ dấu của câu trả lời. → (ok, cụm bị lặp)."""
    r, c = _norm(reply), _norm(customer)
    r_ascii = _strip_accents(r)
    cands = set()
    for term in terms:
        tt = _norm(term)
        if tt and _has(tt, c):
            cands.add(tt)
        ta = _strip_accents(tt)
        if ta and ta != tt and _has(ta, c):      # khách gõ không dấu
            cands.add(ta)
    for v in guardrail.check(customer or "").get("violations", []):
        sp = _norm(v.get("span") or "") if isinstance(v, dict) else ""
        if len(sp) >= 2:
            cands.add(sp)
    hits = [t for t in sorted(cands)
            if _has(t, r_ascii if _strip_accents(t) == t else r)]
    return not hits, hits


def propose(text: str | None, stars: int | None, channel: str, rules: dict,
            *, san: bool, labels=()) -> dict:
    """THUẦN → {lop, reply, code | None, why}. lop khac → reply None."""
    cls = classify(text, stars, rules, labels)
    reply = draft_reply(cls, rules, san=san)
    if reply is None:
        return {"lop": cls, "reply": None, "code": None, "why": "không soạn"}
    if text:
        ok, hits = no_claim_echo(reply, text, rules["health_terms"])
        if not ok:
            return {"lop": cls, "reply": reply, "code": "UGC_ECHO",
                    "why": f"câu trả lời lặp lại {len(hits)} cụm của khách"}
    g = guardrail.check_publish(reply, channel=channel, content_type="post",
                                is_ai=False)
    if g.get("ok") is not True:
        codes = sorted({v.get("code") for v in g.get("violations", [])})
        return {"lop": cls, "reply": reply, "code": "UGC_GUARDRAIL",
                "why": f"câu trả lời không qua guardrail {codes}"}
    return {"lop": cls, "reply": reply, "code": None, "why": "đạt"}


def read_reviews(path, channel: str, rules: dict
                 ) -> tuple[list[dict], list[str], str | None]:
    """CSV bytes (utf-8-sig) → (rows, lỗi, sha256). Cột drop bỏ ngay, cột
    lạ → chặn cả file; noi_dung `_mask_pii` ngay khi đọc. Lỗi 'dòng N cột
    X: lý do' — KHÔNG in giá trị ô."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        return [], [f"không đọc được file ({type(e).__name__})"], None
    sha = hashlib.sha256(raw).hexdigest()
    if len(raw) > MAX_BYTES:
        return [], [f"file quá lớn (> {MAX_BYTES} byte)"], sha
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [], ["file không phải UTF-8"], sha
    try:
        recs = list(csv.reader(io.StringIO(text, newline="")))
    except csv.Error:   # ô > field_limit / CSV hỏng — không traceback
        return [], ["file CSV hỏng (ô quá lớn hoặc sai định dạng)"], sha
    while recs and not any(c.strip() for c in recs[-1]):
        recs.pop()
    if not recs:
        return [], ["file rỗng"], sha
    spec = rules["review_columns"][channel]
    head = [h.strip() for h in recs[0]]
    errs, idx = [], {}
    for i, h in enumerate(head):
        if h in spec["columns"]:
            f = spec["columns"][h]
            if f in idx:
                errs.append(f"dòng 1 cột {f}: trùng cột")
            idx[f] = i
        elif h not in spec["drop"]:
            errs.append(f"dòng 1 cột {_oneline(_mask_pii(h), 30)!r}: cột lạ "
                        "— chặn cả file")
    errs += [f"dòng 1 cột {f}: thiếu cột" for f in REVIEW_FIELDS
             if f not in idx]
    if errs:
        return [], errs, sha
    if len(recs) - 1 > MAX_ROWS:
        return [], [f"quá {MAX_ROWS} dòng dữ liệu"], sha
    rows, seen = [], set()
    for n, rec in enumerate(recs[1:], start=2):
        if not any(c.strip() for c in rec):
            continue
        if len(rec) != len(head):
            errs.append(f"dòng {n}: số cột {len(rec)} ≠ {len(head)}")
            continue
        ma = rec[idx["ma_danh_gia"]].strip()
        sao = rec[idx["so_sao"]].strip()
        bad = []
        if not ma or len(ma) > 100:
            bad.append(("ma_danh_gia", "rỗng hoặc quá 100 ký tự"))
        elif ma in seen:
            bad.append(("ma_danh_gia", "trùng trong file"))
        if not (sao.isascii() and sao.isdigit() and 1 <= int(sao) <= 5):
            bad.append(("so_sao", "phải số nguyên 1..5"))
        if not rec[idx["thoi_gian"]].strip():
            bad.append(("thoi_gian", "rỗng"))
        if len(rec[idx["noi_dung"]]) > MAX_TEXT:
            bad.append(("noi_dung", f"quá {MAX_TEXT} ký tự"))
        errs += [f"dòng {n} cột {c}: {why}" for c, why in bad]
        if bad:
            continue
        seen.add(ma)
        rows.append({"row_no": n, "ma": ma, "stars": int(sao),
                     "text": _mask_pii(rec[idx["noi_dung"]])})
    if not errs and not rows:
        errs.append("file không có dòng dữ liệu")
    return ([], errs, sha) if errs else (rows, [], sha)


def render_reply(p: dict, channel: str, source: str) -> str:
    return "\n".join([
        "# Đề xuất trả lời UGC (NHÁP — người đăng tay sau duyệt)", "",
        f"- Lớp: {_SHOW.get(p['lop'], p['lop'])}", f"- Kênh: {channel}", f"- Nguồn: {source}",
        "- Câu đề xuất:", "", f"> {p['reply']}", "", NOTE, ""])


# Lớp "ruou" hiện trong title/payload bằng mã trung tính: chính chữ đó khớp
# bộ lọc rượu → `guardrail.check(payload)` chặn → mục không duyệt được.
_SHOW = {"ruou": "sp_cam_qc"}
_UNSHOW = {v: k for k, v in _SHOW.items()}


def _title(lop: str, channel: str, what: str = "Đề xuất trả lời UGC") -> str:
    return f"{what} [lop={_SHOW.get(lop, lop)}] [kenh={channel}]"


# ---------- DB ----------

def _exists(conn, object_id: str) -> bool:
    return conn.execute("select exists(select 1 from approval_queue where"
                        " object_id = %s)", (object_id,)).fetchone()[0]


def _submit(conn, otype: str, oid: str, title: str, payload: str, by: str,
            dcfg) -> int | None:
    if _exists(conn, oid):
        conn.commit()
        return None
    try:
        return director.submit(conn, "marketing", otype, oid, title, payload,
                               created_by=by, cfg=dcfg)
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        return None


def process(items, channel: str, rules: dict, *, salt: str, san: bool,
            conn=None, by: str = "", dcfg=None) -> dict:
    """items = [{key, source, text, stars, labels}] → thống kê; conn None =
    dry-run (không ghi). Không in/không lưu nội dung khách."""
    st = {"lop": dict.fromkeys(CLASSES, 0), "moi": [], "skip": 0,
          "chan": [], "khong_soan": 0}
    for it in items:
        p = propose(it.get("text"), it.get("stars"), channel, rules, san=san,
                    labels=it.get("labels", ()))
        st["lop"][p["lop"]] += 1
        if p["reply"] is None:
            st["khong_soan"] += 1
            continue
        if p["code"]:
            st["chan"].append((it["source"], p["code"]))
            continue
        payload = render_reply(p, channel, it["source"])
        if guardrail.check(payload).get("ok") is not True:
            st["chan"].append((it["source"], "UGC_GUARDRAIL"))
            continue
        oid = "ugc-" + msg_hash(salt, channel, it["key"])[:16]
        if conn is None:
            st["moi"].append(oid)
            continue
        qid = _submit(conn, "ugc_reply", oid, _title(p["lop"], channel),
                      payload, by, dcfg)
        if qid is None:
            st["skip"] += 1
        else:
            st["moi"].append(qid)
    return st


def mention_items(conn, since: date) -> list[dict]:
    start = datetime.combine(since, time(0), tzinfo=VN_TZ)
    out = []
    for mid, ch, labels, sensitive in conn.execute(
            "select id, channel, labels, sensitive from social_mentions where"
            " posted_at >= %s order by id", (start,)):
        labs = list(labels or []) + (["hoi_suc_khoe"] if sensitive else [])
        out.append({"key": f"social_mentions#{mid}", "channel":
                    MENTION_CHANNEL.get(ch), "labels": labs, "text": None,
                    "stars": None, "source": f"`social_mentions#{mid}`"})
    conn.commit()
    return out


def ref_item(conn, ref: str) -> tuple[str | None, str | None]:
    """→ (lớp, kênh) đọc từ title mục ugc_reply của REF; không thấy →
    (None, None)."""
    if not _REF_RE.fullmatch(ref or ""):
        return None, None
    row = conn.execute(
        "select title from approval_queue where block = 'marketing' and"
        " object_type = 'ugc_reply' and object_id = %s order by id limit 1",
        (ref,)).fetchone()
    conn.commit()
    if row is None:
        return None, None
    lm, km = _LOP_RE.search(row[0] or ""), _KENH_RE.search(row[0] or "")
    lop = _UNSHOW.get(lm.group(1), lm.group(1)) if lm else None
    return lop, (km.group(1) if km else None)


def reuse_request(conn, ref: str, rules: dict, *, by: str, dcfg=None) -> dict:
    lop, ch = ref_item(conn, ref)
    if lop is None or ch is None:
        return {"code": "UGC_UNKNOWN_REF", "why": f"không có mục ugc_reply "
                f"{_oneline(ref, 40)!r}"}
    if lop in SENSITIVE:
        return {"code": "UGC_SENSITIVE", "why": (f"lớp {lop} — không xin "
                "phép/không tái sử dụng UGC nhạy cảm")}
    msg = rules["templates"]["xin_phep"]
    g = guardrail.check_publish(msg, channel=ch, content_type="post",
                                is_ai=False)
    if g.get("ok") is not True:
        return {"code": "UGC_GUARDRAIL", "why": "template xin_phep không qua "
                "guardrail"}
    payload = "\n".join([
        "# Nháp tin xin phép dùng lại UGC (CHƯA GỬI)", "",
        f"- Tham chiếu: `{ref}` · kênh {ch}", "- Tin nhắn đề xuất:", "",
        f"> {msg}", "",
        ("Chỉ tái sử dụng khi khách đồng ý VÀ đã ghi consent `marketing` qua "
         "`python -m ingest.crm --consent` — rồi lập `--reuse`."), NOTE, ""])
    qid = _submit(conn, "ugc_reply", f"xp-{ref}",
                  _title("xin_phep", ch, "Nháp xin phép dùng lại UGC"),
                  payload, by, dcfg)
    return {"code": None, "qid": qid}


def reuse(conn, ref: str, contact_id: int, *, by: str, dcfg=None) -> dict:
    lop, ch = ref_item(conn, ref)
    if lop is None or ch is None:
        return {"code": "UGC_UNKNOWN_REF", "why": f"không có mục ugc_reply "
                f"{_oneline(ref, 40)!r}"}
    if lop in SENSITIVE:
        return {"code": "UGC_SENSITIVE", "why": (f"lớp {lop} — UGC nhạy cảm "
                "không được tái sử dụng (kể cả khi có consent)")}
    ok = crm.can_contact(conn, contact_id, "marketing")
    conn.commit()
    if not ok:
        return {"code": "UGC_NO_CONSENT", "why": (f"contact_id {contact_id} "
                "không có consent marketing hiện hành (chưa có / đã rút)")}
    payload = "\n".join([
        "# Đề nghị tái sử dụng UGC (NHÁP)", "",
        f"- Tham chiếu: `{ref}` · kênh {ch} · lớp {lop}",
        (f"- contact_id: {contact_id} — consent `marketing` granted (view "
        "`v_consent_current` lúc lập)"), "",
        ("Kiểm lại consent ngay trước khi đăng — khách rút thì KHÔNG dùng. "
         "Mục đích consent `marketing` có bao gồm tái sử dụng UGC hay không: "
         "chờ Pháp chế xác nhận (GAP DF-34)."), NOTE, ""])
    qid = _submit(conn, "ugc_reuse", f"reuse-{ref}-c{contact_id}",
                  _title(lop, ch, "Đề nghị tái sử dụng UGC"), payload, by,
                  dcfg)
    return {"code": None, "qid": qid}


# ---------- CLI ----------

def _print_stats(label: str, st: dict, dry: bool) -> None:
    lops = ", ".join(f"{k} {v}" for k, v in st["lop"].items() if v)
    new = (f"{len(st['moi'])} đề xuất (dry-run, không ghi)" if dry else
           f"mục mới {', '.join(f'#{q}' for q in st['moi']) or '(không)'}")
    print(f"[{label}] lớp: {lops or '(không)'} · {new} · skip {st['skip']} "
          f"· không soạn {st['khong_soan']} · chặn {len(st['chan'])}")
    for src, code in st["chan"][:50]:
        print(f"  - chặn {code}: {src}")
    print("Agent không tự trả lời/đăng — người phụ trách đăng tay sau duyệt.")


def _since(s) -> date | None:
    try:
        return date.fromisoformat(s) if isinstance(s, str) and re.fullmatch(
            r"\d{4}-\d{2}-\d{2}", s) else None
    except ValueError:
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.mkt_ugc",
        description="MKT-07 UGC/review → ĐỀ XUẤT trả lời + xin phép dùng lại "
                    "(NHÁP — không tự trả lời/đăng/nhắn khách)")
    ap.add_argument("--reviews", type=Path, metavar="FILE.csv")
    ap.add_argument("--channel", choices=REVIEW_CHANNELS)
    ap.add_argument("--mentions", action="store_true")
    ap.add_argument("--since")
    ap.add_argument("--reuse-request", metavar="REF")
    ap.add_argument("--reuse", metavar="REF")
    ap.add_argument("--contact-id", type=int)
    ap.add_argument("--by")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    n_ops = ((a.reviews is not None) + a.mentions
             + (a.reuse_request is not None) + (a.reuse is not None))
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --reviews | --mentions | "
                 "--reuse-request | --reuse")
    by = (a.by or "").strip()
    if not by:
        ap.error("cần --by <tên người lập>")
    if a.reviews is not None and a.channel is None:
        ap.error("--reviews cần --channel shopee|tiktok")
    since = _since(a.since)
    if a.mentions and since is None:
        ap.error("--mentions cần --since YYYY-MM-DD")
    if a.reuse is not None and (a.contact_id is None or a.contact_id <= 0):
        ap.error("--reuse cần --contact-id N (số dương)")
    try:
        rules = load_rules()
        dcfg = director.load_config("marketing")
    except (UgcConfigError, director.DirectorConfigError) as e:
        print(f"[err] cấu hình: {e} — không connect.")
        return 1
    salt = os.environ.get("INTEL_HASH_SALT", "")
    if (a.reviews is not None or a.mentions) and len(salt) < SALT_MIN:
        print(f"[err] thiếu INTEL_HASH_SALT (≥{SALT_MIN} ký tự) — không "
              "connect.")
        return 1
    if a.reviews is not None:
        rows, errs, sha = read_reviews(a.reviews, a.channel, rules)
        if errs:
            print(f"[err] file review lỗi ({len(errs)}) — chặn cả file, "
                  "không ghi:")
            for e in errs[:50]:
                print(f"  - {e}")
            return 1
        items = [{"key": r["ma"], "text": r["text"], "stars": r["stars"],
                  "source": f"file review sha256 `{sha[:12]}` dòng "
                            f"{r['row_no']}"} for r in rows]
        if a.dry_run:
            _print_stats("reviews", process(items, a.channel, rules,
                                            salt=salt, san=True), True)
            return 0
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.reviews is not None:
            st = process(items, a.channel, rules, salt=salt, san=True,
                         conn=conn, by=by, dcfg=dcfg)
            _print_stats("reviews", st, False)
            return 0
        if a.mentions:
            items = mention_items(conn, since)
            st = {"lop": dict.fromkeys(CLASSES, 0), "moi": [], "skip": 0,
                  "chan": [], "khong_soan": 0}
            for ch in sorted({i["channel"] for i in items if i["channel"]}):
                part = process([i for i in items if i["channel"] == ch], ch,
                               rules, salt=salt, san=False,
                               conn=None if a.dry_run else conn, by=by,
                               dcfg=dcfg)
                for k, v in part["lop"].items():
                    st["lop"][k] += v
                for k in ("moi", "chan"):
                    st[k] += part[k]
                st["skip"] += part["skip"]
                st["khong_soan"] += part["khong_soan"]
            _print_stats("mentions", st, a.dry_run)
            return 0
        if a.reuse_request is not None:
            res = reuse_request(conn, a.reuse_request, rules, by=by,
                                dcfg=dcfg)
        else:
            res = reuse(conn, a.reuse, a.contact_id, by=by, dcfg=dcfg)
        if res["code"]:
            print(f"[chặn] {res['code']}: {res['why']} — không ghi gì.")
            return 1
        if res["qid"] is None:
            print("[skip] đã có mục này trong hàng duyệt — không tạo thêm.")
        else:
            print(f"[done] mục hàng duyệt #{res['qid']} (NHÁP, chờ duyệt) — "
                  "agent không gửi/không đăng.")
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
