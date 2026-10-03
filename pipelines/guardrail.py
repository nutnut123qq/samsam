"""Guardrail pháp lý TPBVSK — chạy TRƯỚC khi mọi nội dung được hiển thị/đăng.

2 lớp check:
  1. Banned words: load data/banned_words.txt — match không dấu/ có dấu,
     case-insensitive. VD chắc chắn phải chặn: "chữa", "điều trị",
     "thuốc", "khỏi bệnh", "trị khỏi", "chống ung thư".
  2. Claim whitelist: load data/claims_whitelist.json — phát hiện câu
     khẳng định công dụng (heuristic hoặc LLM check) không nằm trong
     claims đã công bố của SKU → flag "unverified_claim".

API (contract — không đổi signature khi chưa cập nhật TASKS.md):
"""

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Động từ mở đầu một claim công dụng — clause chứa chúng mà không khớp
# approved claim nào thì bị flag "unverified_claim".
CLAIM_VERBS = (
    "hỗ trợ", "giúp", "giảm", "tăng cường", "bồi bổ", "điều hòa",
    "phòng ngừa", "cải thiện", "tốt cho", "ngăn ngừa", "bảo vệ",
)

# Disclaimer pháp lý BẮT BUỘC của quảng cáo TPBVSK — bản thân nó chứa từ
# cấm ("thuốc", "chữa bệnh") nhưng dùng theo nghĩa phủ định. Banned span
# nằm trong các cụm này thì miễn (giống approved claim).
SAFE_PHRASES = (
    "không phải là thuốc",
    "không có tác dụng thay thế thuốc",
    "thay thế thuốc chữa bệnh",
    "không thay thế thuốc",
)


def _strip_len(s: str) -> str:
    """Bỏ dấu tiếng Việt (đ→d) nhưng GIỮ NGUYÊN độ dài — mỗi ký tự map
    về base char đầu tiên, để index vào text gốc không lệch."""
    out = []
    for ch in s:
        base = "".join(c for c in unicodedata.normalize("NFKD", ch)
                       if not unicodedata.combining(c)).replace("đ", "d")
        out.append(base[0] if base else ch)
    return "".join(out)


def _pat(term: str, strip: bool = False) -> re.Pattern:
    """Regex match nguyên cụm (word-boundary-ish), whitespace linh hoạt."""
    t = _strip_len(term.lower()) if strip else term.lower()
    body = r"\s+".join(re.escape(p) for p in t.split())
    return re.compile(r"(?<!\w)" + body + r"(?!\w)")


@lru_cache(maxsize=1)
def _load_config() -> tuple[list[str], dict, str | None]:
    """Trả (banned_words, claims_by_sku, error). Thiếu file -> error."""
    banned_path = DATA_DIR / "banned_words.txt"
    claims_path = DATA_DIR / "claims_whitelist.json"
    if not banned_path.exists() or not claims_path.exists():
        return [], {}, f"thiếu file config trong {DATA_DIR}"
    banned = [l.strip().lower() for l in
              banned_path.read_text(encoding="utf-8").splitlines()
              if l.strip() and not l.startswith("#")]
    raw = json.loads(claims_path.read_text(encoding="utf-8"))
    claims = {k: v.get("approved_claims", []) for k, v in raw.items()
              if isinstance(v, dict)}
    return banned, claims, None


def _find_terms(text: str, terms: list[str]) -> list[dict]:
    """Tìm mọi cụm trong terms (có dấu lẫn biến thể không dấu) trong text.

    Trả [{term,start,end}] — offset đúng theo `text` gốc. Biến thể không
    dấu chỉ flag khi span gốc cũng viết trần (tránh 'thuộc' bị bắt nhầm
    'thuốc').
    """
    low = text.lower()
    stripped = _strip_len(low)
    hits = []
    for term in terms:
        t = term.lower()
        hits += [{"term": term, "start": m.start(), "end": m.end()}
                 for m in _pat(t).finditer(low)]
        for m in _pat(t, strip=True).finditer(stripped):
            orig = low[m.start():m.end()]
            if re.sub(r"\s+", " ", orig) == t:
                continue  # trùng match có dấu, đã ghi ở pass trên
            if _strip_len(orig) != orig:
                continue  # từ khác hẳn khi có dấu (thuộc ≠ thuốc) -> bỏ
            hits.append({"term": term, "start": m.start(), "end": m.end()})
    return hits


def _inside(outer: dict, inner: dict) -> bool:
    return outer["start"] <= inner["start"] and inner["end"] <= outer["end"]


def _claim_spans(low: str) -> list[tuple[int, int]]:
    """Span các clause (ngắt .,;:!?xuống dòng) chứa động từ claim."""
    spans = []
    for m in re.finditer(r"[^.,;:!?\n]+", low):
        clause = m.group(0)
        if any(_pat(v).search(clause) for v in CLAIM_VERBS):
            spans.append((m.start(), m.end()))
    return spans


def check(text: str) -> dict:
    """Return {"ok": bool, "violations": [{"type","detail","span"}],
    "matched_claims": [...]}.

    violations[].type ∈ {"banned_word","unverified_claim"}.
    Không raise lỗi ra ngoài; file data thiếu → ok=False + violation "config".
    """
    banned, claims_by_sku, err = _load_config()
    violations, matched = [], []
    if err:
        return {"ok": False,
                "violations": [{"type": "config", "detail": err, "span": None}],
                "matched_claims": []}
    if not text or not text.strip():
        return {"ok": True, "violations": [], "matched_claims": []}

    # --- Lớp 2 trước: approved claim là "vùng an toàn" — banned word nằm
    # trong claim đã công bố (vd 'hỗ trợ hạ đường huyết' ⊃ 'hạ đường huyết')
    # thì KHÔNG flag. Text nhắc tên SKU -> đối whitelist chỉ SKU đó.
    low = text.lower()
    mentioned = [sku for sku in claims_by_sku
                 if _pat(sku.replace("-", " ")).search(low)
                 or _pat(sku).search(low)]
    pool = {sku: claims_by_sku[sku] for sku in mentioned} or claims_by_sku
    claim_hits = []
    for sku, claims in pool.items():
        for c in claims:
            # Match nguyên văn HOẶC "claim core" (bỏ prefix động từ dẫn
            # 'hỗ trợ'/'giúp') — substance công dụng phải đúng, động từ
            # dẫn được phép đồng nghĩa.
            core = re.sub(r"^(hỗ trợ|giúp)\s+", "", c.lower())
            for h in _find_terms(text, [c] + ([core] if core != c.lower()
                                              else [])):
                claim_hits.append({"sku": sku, "claim": c,
                                   "start": h["start"], "end": h["end"]})
                matched.append({"sku": sku, "claim": c})

    safe_hits = _find_terms(text, list(SAFE_PHRASES))

    # --- Lớp 1: banned words (trừ span nằm trong approved claim /
    # disclaimer pháp lý bắt buộc)
    for h in _find_terms(text, banned):
        if any(_inside(c, h) for c in claim_hits + safe_hits):
            continue
        violations.append({
            "type": "banned_word",
            "detail": f"từ/cụm cấm: \"{h['term']}\"",
            "span": text[h["start"]:h["end"]],
        })

    # --- Lớp 2: clause có động từ claim — trừ các span đã khớp whitelist;
    # phần dư mà vẫn chứa động từ claim -> công dụng không công bố -> flag.
    # (Fix lỗ hổng mệnh đề ghép: 'giảm ho VÀ làm đẹp da' từng pass vì
    # cả clause được coi là covered khi overlap 1 claim.)
    matched_spans = sorted((c["start"], c["end"]) for c in claim_hits)
    for start, end in _claim_spans(low):
        cur = start
        leftovers = []
        for ms, me in matched_spans:
            if me <= start or ms >= end:
                continue
            if ms > cur:
                leftovers.append(low[cur:ms])
            cur = max(cur, me)
        if cur < end:
            leftovers.append(low[cur:end])
        if any(_pat(v).search(seg) for seg in leftovers
               for v in CLAIM_VERBS):
            violations.append({
                "type": "unverified_claim",
                "detail": "claim công dụng không nằm trong whitelist đã công bố",
                "span": text[start:end].strip(),
            })

    # dedupe matched_claims
    seen, uniq = set(), []
    for m in matched:
        k = (m["sku"], m["claim"])
        if k not in seen:
            seen.add(k)
            uniq.append(m)
    return {"ok": not violations, "violations": violations,
            "matched_claims": uniq}
