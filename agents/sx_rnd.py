"""v11.0 SX-A6 (WP17) — Agent R&D sản phẩm phái sinh: CHỈ concept brief nội bộ.

Contract:
  - Danh mục concept `data/rd_concepts.json` (GIẢ ĐỊNH — GĐ sản xuất chốt):
    `load_concepts(path, golden)` fail-closed (`RndConfigError`) — khóa
    thiếu/thừa, id trùng/sai dạng, giá không phải khoảng int 0 < low <= high,
    SKU nền không có trong golden hoặc là rượu, trường chữ nhắc rượu, chủ đề
    tín hiệu ngoài `INTEL_TOPICS`.
  - Tín hiệu thị trường = `intel_items` (tin public đã thu) theo chủ đề,
    trong `SIGNAL_DAYS` ngày tới `now`; loại tin cờ `ruou` / nhắc rượu. Mỗi
    tín hiệu chỉ giữ URL + ngày VN + chủ đề — KHÔNG chép tiêu đề/đoạn trích
    (tránh mang claim của báo vào brief).
  - Brief = template tất định đúng 5 mục (Hương vị / Nguồn gốc / Nghi thức
    dùng / Quy cách / Giá dự kiến dạng khoảng) + "Tín hiệu (nguồn)" + nhãn
    NỘI BỘ + khối "Sinh bởi" (model/seed/ngày). KHÔNG nêu công dụng.
    "ngày lập"/"Sinh bởi ngày=" = ngày THẬT lập; "tín hiệu tới" = --date.
  - `--llm` (mặc định TẮT): 1 lời gọi `llm_gateway.chat("sx_rnd")` chỉ viết
    lại đoạn hương vị + nghi thức dùng; lỗi/rỗng/sai định dạng/không qua
    cổng 0-công-dụng / có cụm `HEALTH_TERMS` mới so với concept → về
    template + ghi lý do (mã, không trích nội dung).
  - Cổng `claim_free(text)`: `guardrail.check_publish(internal_note)` ok ∧
    0 matched_claims ∧ 0 động từ claim (`guardrail.CLAIM_VERBS`) ∧ không
    rượu. Có lỗi → không ghi file, không vào hàng duyệt.
  - `--submit` → `director.submit("production", "rd_concept_brief")` (risk
    high — không bao giờ tự duyệt); trùng mục pending → skipped. GĐ SX chọn
    concept; brief KHÔNG công bố ra ngoài, không ghi bảng nháp đăng bài.

Chạy: python -m agents.sx_rnd (--list | --brief CONCEPT_ID) [--llm]
      [--submit] [--date YYYY-MM-DD]
Exit: 0 ok · 1 lỗi cấu hình / brief không qua cổng · 2 usage / DB down.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import unicodedata
from contextlib import suppress
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest import golden_store
from ingest.lead_store import connect
from pipelines import director, guardrail, kb_filter, llm_gateway
from pipelines.job_runs import job_run
from pipelines.pii import _mask_pii
from pipelines.production import TZ_VN

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONCEPTS_FILE = ROOT / "data" / "rd_concepts.json"
AGENT = "agent:SX-A6"
AGENT_ID = "sx_rnd"             # khóa trần chi phí gateway
BLOCK = "production"
OBJECT_TYPE = "rd_concept_brief"
INTEL_TOPICS = ("sam", "tpbvsk", "gioi_tre", "quang_cao", "doi_thu",
                "chuong_trinh", "phap_ly")
KEYS = frozenset({"id", "name", "flavor", "origin", "ritual", "pack_spec",
                  "price_vnd", "base_skus", "signal_topics"})
TEXT_KEYS = ("name", "flavor", "origin", "ritual", "pack_spec")
ID_RE = re.compile(r"[a-z0-9-]{1,64}")
URL_RE = re.compile(r"https?://[^\s<>()\[\]|`]{1,500}")
SIGNAL_DAYS = 90
SIGNAL_LIMIT = 50
MAX_SIGNALS_SHOWN = 10
SEED = 0
TEMPLATE_MODEL = "sx_rnd-template-v1"
LLM_FIELD_MAX = 400
INTERNAL_LABEL = "NỘI BỘ – concept chưa duyệt, không công bố ra ngoài"
AI_LABEL = "Nội dung có sử dụng AI"
NO_SIGNAL = "thiếu tín hiệu có nguồn"
# Cụm chỉ hiệu quả sức khỏe — chỉ chặn trên đường LLM (bản viết lại phải
# không thêm cụm mới so với concept). Thừa còn hơn thiếu: chặn nhầm chỉ làm
# brief về template (an toàn). Viết có dấu, cả 2 kiểu đặt dấu oa/oe.
HEALTH_TERMS = (
    "sức khỏe", "sức khoẻ", "khỏe", "khoẻ", "đề kháng", "miễn dịch",
    "sinh lực", "sinh lý", "lão hóa", "lão hoá", "trẻ hóa", "trẻ hoá",
    "an thần", "ngủ", "mất ngủ", "đẹp da", "làm đẹp", "huyết áp",
    "đường huyết", "tiểu đường", "gan", "thận", "tim mạch", "hồi phục",
    "phục hồi", "minh mẫn", "tỉnh táo", "trí nhớ", "mệt mỏi", "căng thẳng",
    "stress", "năng lượng", "sảng khoái", "dẻo dai", "giải độc", "thải độc",
    "thanh lọc", "oxy hóa", "oxy hoá", "tuần hoàn", "nội tiết", "xương khớp",
    "tiêu hóa", "tiêu hoá", "bệnh", "ung thư", "đẩy lùi", "bổ", "bổ dưỡng",
    "công dụng", "tác dụng", "lợi ích", "hiệu quả", "chống")
SYSTEM = (
    "Bạn là biên tập viên mô tả sản phẩm thực phẩm. Viết lại ngắn gọn, tự "
    "nhiên đoạn HƯƠNG VỊ và NGHI THỨC DÙNG của một concept sản phẩm từ sâm. "
    "TUYỆT ĐỐI KHÔNG nêu công dụng, tác dụng, lợi ích sức khỏe; không dùng "
    "các từ: " + ", ".join(guardrail.CLAIM_VERBS) + "; không nhắc rượu; "
    "không thêm số liệu/giá/thành phần mới. Trả đúng 2 dòng:\n"
    "Hương vị: <câu>\nNghi thức dùng: <câu>")


class RndConfigError(ValueError):
    """Danh mục concept thiếu/hỏng/sai luật — fail-closed."""


# ---------- cấu hình ----------

def _golden_index(golden) -> dict:
    skus = golden.get("skus") if isinstance(golden, dict) else None
    if not isinstance(skus, list) or not skus:
        raise RndConfigError("golden không có danh sách SKU")
    return {s["sku_key"]: s for s in skus
            if isinstance(s, dict) and isinstance(s.get("sku_key"), str)}


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_concepts(doc, golden) -> list[dict]:
    if not isinstance(doc, dict) or set(doc) - {"_doc", "concepts"}:
        raise RndConfigError("root phải là object chỉ có _doc/concepts")
    items = doc.get("concepts")
    if not isinstance(items, list) or not items:
        raise RndConfigError("'concepts' rỗng/thiếu")
    gold = _golden_index(golden)
    seen, out = set(), []
    for i, c in enumerate(items):
        where = f"concepts[{i}]"
        if not isinstance(c, dict):
            raise RndConfigError(f"{where}: phải là object")
        if set(c) != KEYS:
            raise RndConfigError(f"{where}: khóa thiếu {sorted(KEYS - set(c))}"
                                 f" / thừa {sorted(set(c) - KEYS)}")
        cid = c["id"]
        if not isinstance(cid, str) or not ID_RE.fullmatch(cid):
            raise RndConfigError(f"{where}.id: phải dạng [a-z0-9-]+")
        if cid in seen:
            raise RndConfigError(f"{where}.id: trùng '{cid}'")
        seen.add(cid)
        for k in TEXT_KEYS:
            v = c[k]
            if not isinstance(v, str) or not v.strip() or "\n" in v:
                raise RndConfigError(f"{cid}.{k}: phải là chuỗi 1 dòng")
            if kb_filter.is_alcohol(v):
                raise RndConfigError(f"{cid}.{k}: nhắc rượu — không làm "
                                     "concept rượu")
        p = c["price_vnd"]
        if (not isinstance(p, dict) or set(p) != {"low", "high"}
                or not _is_int(p["low"]) or not _is_int(p["high"])
                or not 0 < p["low"] <= p["high"]):
            raise RndConfigError(f"{cid}.price_vnd: phải {{low, high}} int,"
                                 " 0 < low <= high")
        skus = c["base_skus"]
        if (not isinstance(skus, list) or not skus
                or not all(isinstance(s, str) for s in skus)):
            raise RndConfigError(f"{cid}.base_skus: list sku_key không rỗng")
        for s in skus:
            if s not in gold:
                raise RndConfigError(f"{cid}.base_skus: '{s}' không có trong"
                                     " golden")
            if gold[s].get("category") == "alcohol" or kb_filter.is_alcohol(s):
                raise RndConfigError(f"{cid}.base_skus: '{s}' là SKU rượu")
        tps = c["signal_topics"]
        if (not isinstance(tps, list) or not tps
                or not all(isinstance(t, str) for t in tps)
                or not set(tps) <= set(INTEL_TOPICS)):
            raise RndConfigError(f"{cid}.signal_topics: phải ⊂ {INTEL_TOPICS}")
        out.append(c)
    return out


def load_concepts(path=None, golden=None) -> list[dict]:
    p = Path(path) if path else CONCEPTS_FILE
    try:
        doc = json.loads(p.read_bytes().decode("utf-8-sig"))
    except FileNotFoundError as e:
        raise RndConfigError(f"thiếu file {p.name}") from e
    except (OSError, ValueError) as e:
        raise RndConfigError(f"{p.name} hỏng ({type(e).__name__})") from e
    return validate_concepts(doc, golden)


# ---------- tín hiệu ----------

def _vn_day(ts) -> str:
    if isinstance(ts, dt.datetime):
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        return ts.astimezone(TZ_VN).date().isoformat()
    return ts.isoformat()


def load_signals(conn, topics, now: dt.datetime,
                 days: int = SIGNAL_DAYS) -> list[dict]:
    """Tin public theo chủ đề trong `days` ngày tới `now` (mới nhất trước).
    Loại tin cờ `ruou` hoặc tiêu đề/đoạn trích nhắc rượu."""
    rows = conn.execute(
        "select url, title, snippet, coalesce(published_at, fetched_at) d,"
        " topics, flags from intel_items where topics && %s::text[]"
        " and coalesce(published_at, fetched_at) > %s"
        " and coalesce(published_at, fetched_at) <= %s"
        " order by d desc, id desc limit %s",
        (list(topics), now - dt.timedelta(days=days), now,
         SIGNAL_LIMIT)).fetchall()
    out = []
    for url, title, snippet, d, tps, flags in rows:
        if "ruou" in (flags or []) or kb_filter.is_alcohol(
                f"{title or ''} {snippet or ''}"):
            continue
        out.append({"url": url, "date": _vn_day(d),
                    "topics": sorted(set(tps or []) & set(topics))})
    return out


# ---------- cổng 0 công dụng ----------

def claim_free(text: str, *, is_ai: bool = False) -> list[str]:
    """→ danh sách mã lỗi (rỗng = qua cổng). Không trích nội dung."""
    errs = []
    g = guardrail.check_publish(text, channel="web",
                                content_type="internal_note", is_ai=is_ai)
    if g.get("ok") is not True:
        codes = sorted({str(v.get("type") or v.get("code") or "?")
                        for v in g.get("violations") or []
                        if isinstance(v, dict)})
        errs.append("guardrail:" + (",".join(codes) or "ok_not_true"))
    if g.get("matched_claims"):
        errs.append("matched_claims")
    low = guardrail._fold(text)
    errs += [f"claim_verb:{v}" for v in guardrail.CLAIM_VERBS
             if guardrail._pat(v).search(low)]
    if kb_filter.is_alcohol(text):
        errs.append("ruou")
    return errs


# ---------- brief ----------

def _vnd(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def _signal_lines(signals) -> tuple[list[str], int]:
    lines, dropped = [], 0
    for s in signals:
        url = s.get("url") if isinstance(s, dict) else None
        if not isinstance(url, str) or not URL_RE.fullmatch(url):
            dropped += 1
            continue
        tps = ", ".join(s.get("topics") or [])
        ln = f"- {s.get('date')} · {url}" + (f" · chủ đề: {tps}" if tps else "")
        if claim_free(ln):
            dropped += 1
            continue
        lines.append(ln)
    return lines[:MAX_SIGNALS_SHOWN], dropped


def build_brief(concept: dict, signals, *, now: dt.datetime,
                flavor: str | None = None, ritual: str | None = None,
                gen: dict | None = None,
                generated: dt.date | None = None) -> dict:
    """THUẦN. → {"text", "problems"}. 0 tín hiệu hợp lệ → problem, text rỗng.
    `flavor`/`ritual` = bản LLM viết lại (None → dùng concept); `gen` =
    {model, prompt_sha256, seed} khi LLM đã dùng. `now` = mốc tín hiệu
    (--date); `generated` = ngày THẬT lập brief (None → ngày của `now`)."""
    sig, dropped = _signal_lines(signals)
    if not sig:
        return {"text": "", "problems": [NO_SIGNAL]}
    day = now.astimezone(TZ_VN).date().isoformat()
    gday = generated.isoformat() if generated else day
    p = concept["price_vnd"]
    L = [f"# Concept brief R&D — {concept['name']}", "",
         f"**{INTERNAL_LABEL}**", "",
         (f"Mã concept: `{concept['id']}` · SKU nền: "
         f"{', '.join(concept['base_skus'])} · ngày lập: {gday} · tín hiệu"
         f" tới: {day}"), "",
         "## Hương vị", "", flavor or concept["flavor"], "",
         "## Nguồn gốc", "", concept["origin"], "",
         "## Nghi thức dùng", "", ritual or concept["ritual"], "",
         "## Quy cách", "", concept["pack_spec"], "",
         "## Giá dự kiến (khoảng)", "",
         f"{_vnd(p['low'])}–{_vnd(p['high'])} đ (GIẢ ĐỊNH — GĐ sản xuất chốt)",
         "", "## Tín hiệu (nguồn)", "", *sig]
    if dropped:
        L.append(f"- (đã loại {dropped} tín hiệu: URL không hợp lệ hoặc "
                 "không qua cổng nội dung)")
    L += ["", "## Ghi chú", "",
          ("- Brief chỉ mô tả cảm quan, nguồn gốc, cách dùng, quy cách và giá"
          " — không nêu công dụng."),
          ("- GĐ sản xuất chọn concept thử mẫu; R&D thật, mock-up, xếp hạng "
          "persona là phần việc riêng (external-dep)."), ""]
    if gen:
        L += [(f"Sinh bởi: model={gen['model']} · prompt_sha256="
              f"{gen['prompt_sha256'][:12]} · seed={gen['seed']} · ngày={gday}"),
              "", f"*{AI_LABEL}*", ""]
    else:
        L += [(f"Sinh bởi: model={TEMPLATE_MODEL} (template tất định) · "
              f"seed={SEED} (không lấy mẫu) · ngày={gday}"), ""]
    return {"text": "\n".join(L), "problems": []}


def _one_line(s: str) -> str:
    # NFC: LLM có thể trả tiếng Việt dạng tổ hợp (NFD) — brief lưu NFC.
    s = unicodedata.normalize("NFC", s)
    return " ".join(_mask_pii(s).split())[:LLM_FIELD_MAX]


def llm_rewrite(concept: dict) -> tuple[dict | None, str]:
    """1 lời gọi gateway → ({flavor, ritual, gen}, "") | (None, mã lý do)."""
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Hương vị: {concept['flavor']}\n"
                                        f"Nghi thức dùng: {concept['ritual']}"}]
    sha = hashlib.sha256(json.dumps(msgs, ensure_ascii=False,
                                    sort_keys=True).encode()).hexdigest()
    try:
        resp = llm_gateway.chat(AGENT_ID, msgs, temperature=0.0, seed=SEED,
                                max_tokens=400)
        text = resp.choices[0].message.content
    except llm_gateway.GatewayError as e:
        return None, f"gateway:{type(e).__name__}"
    except (AttributeError, IndexError, TypeError):
        return None, "phan_hoi_hong"
    if not isinstance(text, str) or not text.strip():
        return None, "llm_rong"
    got = {}
    for ln in text.splitlines():
        k, sep, v = ln.partition(":")
        k = k.strip().strip("*").strip().lower()
        if sep and k in ("hương vị", "nghi thức dùng") and v.strip():
            got[k] = _one_line(v)
    if set(got) != {"hương vị", "nghi thức dùng"}:
        return None, "sai_dinh_dang"
    model = getattr(resp, "model", None)
    if not isinstance(model, str) or not model:
        model = os.environ.get("OR_CHAT_MODEL", "openai/gpt-4o-mini")
    return {"flavor": got["hương vị"], "ritual": got["nghi thức dùng"],
            "gen": {"model": _one_line(model)[:80], "prompt_sha256": sha,
                    "seed": SEED}}, ""


def health_terms(text: str, allowed: str = "") -> list[str]:
    """Cụm chỉ hiệu quả sức khỏe có trong `text` mà KHÔNG có sẵn trong
    `allowed` (văn bản concept do người soạn). Bù lỗ hổng list từ cấm/động
    từ claim: 'Tăng sức đề kháng', 'An thần, dễ ngủ' qua `claim_free`."""
    # NFC cả chuỗi trước `_fold` (fold chỉ NFKC từng ký tự → NFD lọt).
    low, base = (guardrail._fold(unicodedata.normalize("NFC", x))
                 for x in (text, allowed))
    return [t for t in HEALTH_TERMS
            if guardrail._pat(t).search(low) and not guardrail._pat(t)
            .search(base)]


def make_brief(concept: dict, signals, *, now: dt.datetime,
               llm: bool = False, generated: dt.date | None = None) -> dict:
    """→ {"text", "problems", "llm_used", "llm_reason"}. LLM hỏng/không qua
    cổng → template + lý do; brief cuối luôn qua `claim_free`. Bản LLM còn
    phải 0 cụm `HEALTH_TERMS` mới (system prompt KHÔNG phải kiểm soát)."""
    base = build_brief(concept, signals, now=now, generated=generated)
    res = {**base, "llm_used": False, "llm_reason": ""}
    if base["problems"]:
        return res
    if llm:
        rw, why = llm_rewrite(concept)
        if rw is not None:
            b2 = build_brief(concept, signals, now=now, flavor=rw["flavor"],
                             ritual=rw["ritual"], gen=rw["gen"],
                             generated=generated)
            errs = claim_free(b2["text"], is_ai=True)
            errs += [f"health:{t}" for t in health_terms(
                f"{rw['flavor']} {rw['ritual']}",
                f"{concept['flavor']} {concept['ritual']}")]
            if not errs:
                return {**b2, "llm_used": True, "llm_reason": ""}
            # chỉ mã nhóm (guardrail/claim_verb/...) — tên động từ claim
            # chèn vào brief sẽ tự làm hỏng cổng.
            why = "khong_qua_cong:" + ",".join(
                sorted({e.split(":")[0] for e in errs}))
        res["llm_reason"] = why
        res["text"] += (f"\nLLM: không dùng — về template (lý do: {why})\n")
    errs = claim_free(res["text"])
    if errs:
        res["problems"] = [f"không qua cổng 0 công dụng: {'; '.join(errs)}"]
    return res


# ---------- hàng duyệt ----------

def submit(conn, concept: dict, text: str) -> tuple[str, int]:
    """→ ("pending", id) | ("skipped", id mục pending trùng)."""
    oid = (f"rd:{concept['id']}:"
           f"{hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]}")
    row = conn.execute(
        "select id from approval_queue where block = %s and object_type = %s"
        " and object_id = %s and status = 'pending' order by id limit 1",
        (BLOCK, OBJECT_TYPE, oid)).fetchone()
    if row:
        conn.commit()
        return "skipped", row[0]
    qid = director.submit(conn, BLOCK, OBJECT_TYPE, oid,
                          f"Concept brief R&D: {concept['name']}", text,
                          created_by=AGENT)
    conn.commit()
    return "pending", qid


# ---------- CLI ----------

def _date(s: str) -> dt.date:
    try:
        d = dt.date.fromisoformat(s)
    except ValueError as e:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from e
    if not dt.date(2000, 1, 1) <= d <= dt.date(2100, 12, 31):
        raise argparse.ArgumentTypeError("ngày ngoài khoảng hợp lệ")
    return d


def _golden():
    doc, why = golden_store.read_golden(golden_store.GOLDEN_FILE)
    if doc is None:
        raise RndConfigError(f"golden: {why}")
    errs = golden_store.validate(doc)
    if errs:
        raise RndConfigError(f"golden không hợp lệ: {errs[0]}")
    return doc


def main(argv=None, now: dt.datetime | None = None,
         generated: dt.date | None = None) -> int:
    """`now` = mốc tín hiệu (--date ghi đè); `generated` = ngày THẬT lập
    brief (đồng hồ, test truyền cố định) — backdate không sai ngày lập."""
    ap = argparse.ArgumentParser(
        prog="python -m agents.sx_rnd",
        description="SX-A6 concept brief R&D sản phẩm phái sinh (NỘI BỘ, "
                    "không nêu công dụng, GĐ sản xuất duyệt)")
    ap.add_argument("--list", action="store_true", help="liệt kê concept")
    ap.add_argument("--brief", metavar="CONCEPT_ID")
    ap.add_argument("--llm", action="store_true",
                    help="viết lại hương vị/nghi thức qua LLM gateway")
    ap.add_argument("--submit", action="store_true",
                    help="đẩy brief vào hàng duyệt khối production")
    ap.add_argument("--date", type=_date, help="ngày lập (giờ VN)")
    a = ap.parse_args(argv)
    n_ops = int(a.list) + int(a.brief is not None)
    if n_ops != 1:
        ap.error("cần đúng 1 trong --list / --brief")
    if a.list and (a.llm or a.submit or a.date):
        ap.error("--llm/--submit/--date chỉ dùng với --brief")
    if a.date:
        now = dt.datetime.combine(a.date, dt.time(23, 59), TZ_VN)
    now = now or dt.datetime.now(TZ_VN)
    generated = generated or dt.datetime.now(TZ_VN).date()
    try:
        concepts = load_concepts(golden=_golden())
    except RndConfigError as e:
        print(f"[err] concept: {e}", file=sys.stderr)
        return 1
    if a.list:
        for c in concepts:
            p = c["price_vnd"]
            print(f"- {c['id']}: {c['name']} · {_vnd(p['low'])}–"
                  f"{_vnd(p['high'])} đ · SKU nền {', '.join(c['base_skus'])}")
        return 0
    concept = next((c for c in concepts if c["id"] == a.brief), None)
    if concept is None:
        print(f"[err] không có concept '{_one_line(a.brief)[:64]}'",
              file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc "
              "host chết)", file=sys.stderr)
        return 2
    try:
        signals = load_signals(conn, concept["signal_topics"], now)
        conn.commit()
        res = make_brief(concept, signals, now=now, llm=a.llm,
                         generated=generated)
        if res["llm_reason"]:
            print(f"[warn] LLM về template: {res['llm_reason']}",
                  file=sys.stderr)
        if res["problems"]:
            print("[err] " + "; ".join(res["problems"]), file=sys.stderr)
            return 1
        day = now.astimezone(TZ_VN).date().isoformat()
        path = write_report(res["text"], REPORTS_DIR,
                            f"rd-brief-{concept['id']}-{day}.md")
        print(res["text"])
        print(f"[write] {path}")
        if a.submit:
            st, qid = submit(conn, concept, res["text"])
            print(f"[submit] {st} #{qid} ({BLOCK}/{OBJECT_TYPE})")
    except psycopg.Error as e:
        print(f"[warn] lỗi DB ({type(e).__name__})", file=sys.stderr)
        return 2
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[err] không ghi được báo cáo ({type(e).__name__})",
              file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    return 0


if __name__ == "__main__":
    with job_run("agents.sx_rnd") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
