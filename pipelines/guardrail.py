"""Guardrail pháp lý TPBVSK/rượu — chạy TRƯỚC khi mọi nội dung được hiển
thị/đăng.

Lớp check (v3.0 + v4.1 Guardrail v2, WP05/PC-A3):
  1. Banned words: data/banned_words.txt — match có dấu / không dấu,
     case-insensitive, sau chuẩn hóa NFC + casefold từng ký tự (`_fold`,
     giữ độ dài để offset không lệch). Thêm 1 pass trên bản "nén" bỏ ký tự
     chèn giữa 2 chữ cái (`th.uốc`, `c-h-ữ-a`, zero-width, soft hyphen).
  2. Claim whitelist: data/claims_whitelist.json — clause chứa động từ
     claim mà phần dư không khớp claim đã công bố -> "unverified_claim".
  3. Rượu: `pipelines.kb_filter.is_alcohol` -> "ruou_cam_quang_cao".
  4. Chỉ ở `check_publish()` (đăng bài theo kênh/loại nội dung): TPBVSK
     chưa XNQC (readiness soi gương view `sku_readiness`), claim theo đúng
     SKU, câu khuyến cáo bắt buộc, nhãn AI/quảng cáo, "Ngọc Linh", kênh
     chưa mở (cảnh báo).
  Severity/mode từng code: data/guardrail_rules.json (bản dev — CHỜ PHÁP
  CHẾ DUYỆT). Không gọi LLM/mạng/DB.

API (contract — không đổi signature khi chưa cập nhật TASKS.md):
  check(text) -> {"ok","violations","matched_claims","warnings","skus",
                  "required_labels"}
  check_publish(text, *, channel, content_type="post", sku=None,
                is_ai=True, is_sponsored=False) -> cùng shape.
  violations[]: {"type","detail","span","code","severity","start","end"};
  `type` cũ (banned_word/unverified_claim/config) giữ nguyên chuỗi.
"""

import bisect
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
# nằm trong các cụm này thì miễn (giống approved claim). MỌI mục phải
# mở đầu bằng "không " — mục trần "thay thế thuốc chữa bệnh" (v2.x) từng
# miễn luôn câu KHẲNG ĐỊNH "có thể thay thế thuốc chữa bệnh" (v3.0 vá).
# Mục dài "...thay thế thuốc chữa bệnh" là mục duy nhất bao được "chữa"
# trong câu khuyến cáo chuẩn — đừng bỏ.
SAFE_PHRASES = (
    "không phải là thuốc",
    "không có tác dụng thay thế thuốc chữa bệnh",
    "không có tác dụng thay thế thuốc",
    "không thay thế thuốc chữa bệnh",
    "không thay thế thuốc",
)

# Cụm đảo nghĩa đứng TRƯỚC disclaimer trong cùng clause -> phủ định kép/
# câu tu từ ("Ai bảo sản phẩm không phải là thuốc") -> KHÔNG miễn.
NEGATION_FLIPS = ("không ai", "ai bảo", "ai nói", "chẳng lẽ", "đâu phải")

SEVERITIES = ("critical", "major", "minor")

# Ký tự chèn giữa 2 CHỮ CÁI để lách từ cấm ("th.uốc", "đi<ZWSP>ều trị").
# Chỉ bỏ khi 2 bên đều là chữ cái — "No.5", "Tp. HCM" giữ nguyên.
_FILLER_RE = re.compile(
    r"(?<=[^\W\d_])[.\-_*\u00ad\u200b-\u200d\u2060\ufeff]+(?=[^\W\d_])")


@lru_cache(maxsize=65536)
def _fold_char(ch: str) -> str:
    f = ch.casefold()
    if len(f) == 1:
        return f
    f = ch.lower()
    return f if len(f) == 1 else ch  # "ß"/"ﬁ"/"İ": giữ nguyên, không lệch


def _fold(s: str) -> str:
    """casefold TỪNG ký tự, bất biến len(_fold(s)) == len(s)."""
    return "".join(map(_fold_char, s))


@lru_cache(maxsize=65536)
def _strip_char(ch: str) -> str:
    base = "".join(c for c in unicodedata.normalize("NFKD", ch)
                   if not unicodedata.combining(c)).replace("đ", "d")
    return base[0] if base else ch


def _strip_len(s: str) -> str:
    """Bỏ dấu tiếng Việt (đ→d) nhưng GIỮ NGUYÊN độ dài — mỗi ký tự map
    về base char đầu tiên, để index vào text gốc không lệch."""
    return "".join(map(_strip_char, s))


@lru_cache(maxsize=4096)
def _pat(term: str, strip: bool = False) -> re.Pattern:
    """Regex match nguyên cụm (word-boundary-ish), whitespace linh hoạt."""
    t = _strip_len(_fold(term)) if strip else _fold(term)
    body = r"\s+".join(re.escape(p) for p in t.split())
    return re.compile(r"(?<!\w)" + body + r"(?!\w)")


class _Txt:
    """Bản fold + bỏ dấu của text, tính 1 LẦN mỗi lần check (trước v4.1
    `_find_terms` bỏ dấu lại toàn văn mỗi lần gọi)."""
    def __init__(self, text: str):
        self.low = _fold(text)
        self.stripped = _strip_len(self.low)


@lru_cache(maxsize=1)
def _load_config() -> tuple[list[str], dict, str | None]:
    """Trả (banned_words, claims_by_sku, error). Thiếu/hỏng file -> error."""
    banned_path = DATA_DIR / "banned_words.txt"
    claims_path = DATA_DIR / "claims_whitelist.json"
    if not banned_path.exists() or not claims_path.exists():
        return [], {}, f"thiếu file config trong {DATA_DIR}"
    try:
        banned = [_fold(line.strip()) for line in
                  banned_path.read_text(encoding="utf-8").splitlines()
                  if line.strip() and not line.startswith("#")]
        raw = json.loads(claims_path.read_text(encoding="utf-8"))
        claims = {k: v.get("approved_claims", []) for k, v in raw.items()
                  if isinstance(v, dict)}
    except (OSError, ValueError, AttributeError) as e:
        return [], {}, f"file config hỏng ({type(e).__name__}) trong {DATA_DIR}"
    if not banned:
        # 0-record (rỗng / chỉ comment) khác missing nhưng cùng hậu quả
        # "không chặn gì" -> fail-closed như kb_filter (AGENTS.md gotcha).
        return [], {}, f"banned_words.txt rỗng — fail-closed trong {DATA_DIR}"
    return banned, claims, None


@lru_cache(maxsize=4)
def _load_rules(data_dir: Path) -> tuple[dict | None, str | None]:
    """Đọc guardrail_rules.json + golden_skus.json. Cache theo thư mục
    (test monkeypatch DATA_DIR không làm bẩn cache thư mục thật)."""
    try:
        doc = json.loads((data_dir / "guardrail_rules.json")
                         .read_text(encoding="utf-8"))
        gold = json.loads((data_dir / "golden_skus.json")
                          .read_text(encoding="utf-8"))
        golden = {s["sku_key"]: s for s in gold["skus"]}
        if not golden:
            raise ValueError("golden_skus.json 0 SKU")
        families, fam_of = {}, {}
        for fam, d in doc["families"].items():
            families[fam] = {"aliases": [str(a) for a in d["aliases"]
                                         if str(a).strip()],
                             "claims_keys": [str(k) for k in d["claims_keys"]],
                             "golden_skus": [str(k) for k in d["golden_skus"]]}
            if families[fam]["golden_skus"] and not families[fam]["aliases"]:
                # alias rỗng -> không bao giờ nhận ra SKU trong text -> bỏ
                # qua câm luật XNQC/khuyến cáo của family -> fail-closed.
                raise ValueError(f"family {fam} có SKU nhưng aliases rỗng")
            for k in families[fam]["golden_skus"]:
                if k not in golden:
                    # golden cắt cụt: family nhận alias mà ctx_skus rỗng ->
                    # bỏ qua câm luật XNQC/khuyến cáo -> fail-closed.
                    raise ValueError(f"family {fam} trỏ SKU thiếu trong golden")
                if k in fam_of:
                    raise ValueError(f"SKU {k} thuộc 2 family")
                fam_of[k] = fam
        # Chiều ngược (golden ⊆ families): Pháp chế sửa tay rules bỏ sót
        # family (`families: {}`, xoá 1 family, golden_skus=[]) -> SKU
        # TPBVSK/food không bao giờ được nhận diện -> fail-closed.
        orphan = sorted(k for k, s in golden.items()
                        if isinstance(s, dict)
                        and s.get("category") in ("tpbvsk", "food")
                        and k not in fam_of)
        if orphan:
            raise ValueError(f"SKU golden không thuộc family nào: {orphan[:5]}")
        cfg = {
            "rules": dict(doc["rules"]),
            "families": families,
            "fam_of": fam_of,
            "golden": golden,
            "canonical": str(doc["disclaimer"]["canonical"]),
            "labels_ai": [str(x) for x in doc["labels"]["ai"]],
            "labels_ad": [str(x) for x in doc["labels"]["ad"]],
            "content_types": dict(doc["content_types"]),
            "channels": list(doc["channels"]),
            "channel_alias": dict(doc["channel_alias"]),
            "nl_terms": [str(x) for x in doc["ngoc_linh"]["terms"]
                         if str(x).strip()],
            "nl_identity": [str(x) for x in doc["ngoc_linh"]["identity"]],
            "nl_confirmed": set(doc["ngoc_linh"]["confirmed_skus"]),
        }
        if (not cfg["canonical"].strip() or not cfg["labels_ai"]
                or not cfg["labels_ad"] or not cfg["nl_terms"]):
            raise ValueError("thiếu câu khuyến cáo/nhãn/cụm Ngọc Linh")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        return None, (f"file luật guardrail/golden không dùng được "
                      f"({type(e).__name__}) trong {data_dir}")
    return cfg, None


def _readiness_of(s, channel: str) -> str:
    """Soi gương CASE của view `sku_readiness` (docs/schema.sql)."""
    if not isinstance(s, dict) or s.get("category") == "alcohol":
        return "CAM"
    allowed = s.get("allowed_channels")
    if not isinstance(allowed, list) or channel not in allowed:
        return "CAM"
    if s.get("category") == "tpbvsk" and s.get("xnqc_status") == "approved":
        return "QC_DAY_DU"
    if s.get("category") == "tpbvsk":
        return "MO_TA"
    if s.get("category") == "food" and s.get("self_declaration_ok") is True:
        return "TP_THUONG"
    return "CAM"


def readiness(sku_key: str, channel: str) -> str:
    """Mức được phép nói/bán của SKU × kênh, tính từ golden file (không
    connect DB). SKU lạ / file lỗi -> CAM (fail-closed)."""
    cfg, err = _load_rules(DATA_DIR)
    if err:
        return "CAM"
    return _readiness_of(cfg["golden"].get(sku_key), channel)


def _find_terms(text: str, terms: list[str], pre: _Txt | None = None
                ) -> list[dict]:
    """Tìm mọi cụm trong terms (có dấu lẫn biến thể không dấu) trong text.

    Trả [{term,start,end}] — offset đúng theo `text` gốc. Biến thể không
    dấu chỉ flag khi span gốc cũng viết trần (tránh 'thuộc' bị bắt nhầm
    'thuốc'). `pre`: bản fold/bỏ dấu đã tính sẵn của chính `text`.
    """
    pre = pre if pre is not None else _Txt(text)
    low, stripped = pre.low, pre.stripped
    hits = []
    for term in terms:
        t = _fold(term)
        words = t.split()
        if not words:
            continue  # cụm rỗng -> regex rỗng khớp mọi vị trí
        # Lọc trước bằng tìm chuỗi con (C, nhanh): từ đầu cụm không có
        # trong text thì bỏ qua quét regex (text dài × nhiều cụm).
        if words[0] in low:
            hits += [{"term": term, "start": m.start(), "end": m.end()}
                     for m in _pat(t).finditer(low)]
        if _strip_len(words[0]) not in stripped:
            continue
        for m in _pat(t, strip=True).finditer(stripped):
            orig = low[m.start():m.end()]
            if re.sub(r"\s+", " ", orig) == t:
                continue  # trùng match có dấu, đã ghi ở pass trên
            if _strip_len(orig) != orig:
                continue  # từ khác hẳn khi có dấu (thuộc ≠ thuốc) -> bỏ
            hits.append({"term": term, "start": m.start(), "end": m.end()})
    return hits


def _compress(text: str) -> tuple[str | None, list[int]]:
    """Bản nén bỏ ký tự chèn giữa 2 chữ cái + cmap (index nén -> index
    `text`). Không có ký tự chèn -> (None, [])."""
    runs = list(_FILLER_RE.finditer(text))
    if not runs:
        return None, []
    parts, cmap, pos = [], [], 0
    for m in runs:
        parts.append(text[pos:m.start()])
        cmap.extend(range(pos, m.start()))
        pos = m.end()
    parts.append(text[pos:])
    cmap.extend(range(pos, len(text)))
    return "".join(parts), cmap


def _filler_hits(text: str, terms: list[str], packed=None) -> list[dict]:
    """Hit trên bản nén (bỏ ký tự chèn giữa 2 chữ cái), map về offset
    `text`. Chỉ giữ hit mà span gốc chứa >=1 ký tự bị bỏ (hit thường đã
    được pass chính ghi). `packed`: `_compress(text)` đã tính sẵn."""
    comp, cmap = packed if packed is not None else _compress(text)
    if comp is None:
        return []
    out = []
    for h in _find_terms(comp, terms):
        s, e = cmap[h["start"]], cmap[h["end"] - 1] + 1
        if e - s != h["end"] - h["start"]:
            out.append({"term": h["term"], "start": s, "end": e})
    return out


def _cover(spans):
    """inside(s, e): [s,e) nằm trọn trong 1 span nào đó — bisect trên
    prefix-max end, O(log n)/lần (vòng `any(...)` lồng cũ là O(n²))."""
    spans = sorted(spans)
    starts = [s for s, _ in spans]
    maxend, m = [], -1
    for _, e in spans:
        m = max(m, e)
        maxend.append(m)

    def inside(s: int, e: int) -> bool:
        i = bisect.bisect_right(starts, s)
        return i > 0 and maxend[i - 1] >= e
    return inside


def _negated_hits(text: str, hits: list[dict], pre: _Txt | None = None
                  ) -> list[dict]:
    """Lọc safe hit — chỉ giữ hit đúng dạng khuyến cáo: clause chứa nó
    (ngắt .,;:!?xuống dòng như `_claim_spans`) không kết thúc bằng '?'
    và không có cụm đảo nghĩa (`NEGATION_FLIPS`, có dấu lẫn không dấu)
    đứng TRƯỚC hit trong clause. Sep/flip tính 1 lần cho cả text rồi
    bisect — không quét lại prefix mỗi hit (quadratic trên text dài)."""
    seps = [m.start() for m in re.finditer(r"[.,;:!?\n]", text)]
    flip_end = {}  # clause index -> end nhỏ nhất của cụm đảo nghĩa
    for f in _find_terms(text, list(NEGATION_FLIPS), pre):
        k = bisect.bisect_right(seps, f["start"])
        flip_end[k] = min(flip_end.get(k, f["end"]), f["end"])
    keep = []
    for h in hits:
        j = bisect.bisect_left(seps, h["end"])
        if j < len(seps) and text[seps[j]] == "?":
            continue  # câu hỏi tu từ, không phải khuyến cáo
        k = bisect.bisect_right(seps, h["start"])
        if flip_end.get(k, len(text) + 1) <= h["start"]:
            continue  # phủ định kép: "ai bảo ... không phải là thuốc"
        keep.append(h)
    return keep


def _claim_spans(low: str) -> list[tuple[int, int]]:
    """Span các clause (ngắt .,;:!?xuống dòng) chứa động từ claim."""
    spans = []
    for m in re.finditer(r"[^.,;:!?\n]+", low):
        clause = m.group(0)
        if any(_pat(v).search(clause) for v in CLAIM_VERBS):
            spans.append((m.start(), m.end()))
    return spans


def _alcohol_span(kb, pre: _Txt) -> tuple[int, int] | None:
    """Match đầu tiên của cụm rượu (kb_filter) trên text fold / bản bỏ dấu
    giữ độ dài. Không tìm được -> None (violation vẫn ghi)."""
    acc, asc = kb._patterns()
    found = [m for m in ((acc.search(pre.low) if acc else None),
                         (asc.search(pre.stripped) if asc else None)) if m]
    if not found:
        return None
    m = min(found, key=lambda x: x.start())
    return m.start(), m.end()


def _vdict(code, severity, detail, span=None, start=None, end=None,
           type_=None) -> dict:
    return {"type": type_ or code, "detail": detail, "span": span,
            "code": code, "severity": severity, "start": start, "end": end}


def _result(viols, warns, matched, skus, labels) -> dict:
    return {"ok": not viols, "violations": viols, "matched_claims": matched,
            "warnings": warns, "skus": skus, "required_labels": labels}


def _config_fail(detail: str) -> dict:
    return _result([_vdict("config", "critical", detail, type_="config")],
                   [], [], [], [])


def _run(text, ctx: dict | None) -> dict:
    banned, claims_by_sku, err = _load_config()
    if err:
        return _config_fail(err)
    cfg, err = _load_rules(DATA_DIR)
    if err:
        return _config_fail(err)
    rules, golden = cfg["rules"], cfg["golden"]
    viols, warns = [], []

    def flag(code, detail, span=None, start=None, end=None, type_=None):
        r = rules.get(code)
        if (isinstance(r, dict) and r.get("severity") in SEVERITIES
                and r.get("mode") in ("block", "warn")):
            sev, mode = r["severity"], r["mode"]
        else:
            sev, mode = "critical", "block"  # code thiếu luật -> fail-closed
        (warns if mode == "warn" else viols).append(
            _vdict(code, sev, detail, span, start, end, type_))

    if not isinstance(text, str):
        text = "" if text is None else str(text)
    text = unicodedata.normalize("NFC", text)

    public, ad, channel, sku = False, False, None, None
    if ctx is not None:
        ch = ctx["channel"]
        ch = cfg["channel_alias"].get(ch, ch) if isinstance(ch, str) else ch
        if ch not in cfg["channels"]:
            return _config_fail(f"kênh lạ: {str(ctx['channel'])[:40]!r}")
        ct = ctx["content_type"]
        ctype = cfg["content_types"].get(ct) if isinstance(ct, str) else None
        if not isinstance(ctype, dict):
            return _config_fail(f"loại nội dung lạ: {str(ct)[:40]!r}")
        sku = ctx["sku"]
        if sku is not None and (not isinstance(sku, str) or sku not in golden):
            return _config_fail(f"SKU lạ: {str(sku)[:60]!r}")
        public = bool(ctype.get("public", True))
        ad = bool(ctype.get("ad")) or bool(ctx["is_sponsored"])
        channel = ch
    if not public and not text.strip():
        return _result([], [], [], [], [])

    pre = _Txt(text)
    low = pre.low

    # --- SKU nhận diện qua alias family (thứ tự theo golden file).
    fams = [f for f, d in cfg["families"].items()
            if _find_terms(text, d["aliases"], pre)]
    found = {k for f in fams for k in cfg["families"][f]["golden_skus"]}
    skus = [k for k in golden if k in found]

    # --- Pool claim. Chat/nội bộ: như v3.0 (SKU được nhắc theo key
    # claims_whitelist, không nhắc -> toàn bộ). Đăng bài: CHỈ claims của
    # family thuộc SKU ngữ cảnh — không có SKU -> pool rỗng.
    if public:
        ctx_skus = [k for k in golden if k in found or k == sku]
        if sku in cfg["fam_of"]:
            fams = fams + [cfg["fam_of"][sku]]
        keys = {k for f in fams for k in cfg["families"][f]["claims_keys"]}
        pool = {k: claims_by_sku.get(k, []) for k in sorted(keys)}
    else:
        ctx_skus = []
        mentioned = [k for k in claims_by_sku
                     if _pat(k.replace("-", " ")).search(low)
                     or _pat(k).search(low)]
        pool = {k: claims_by_sku[k] for k in mentioned} or claims_by_sku

    # --- Lớp 2 trước: approved claim là "vùng an toàn" — banned word nằm
    # trong claim đã công bố (vd 'hỗ trợ hạ đường huyết' ⊃ 'hạ đường huyết')
    # thì KHÔNG flag.
    claim_hits, matched = [], []
    for k, claims in pool.items():
        for c in claims:
            # Match nguyên văn HOẶC "claim core" (bỏ prefix động từ dẫn
            # 'hỗ trợ'/'giúp') — substance công dụng phải đúng, động từ
            # dẫn được phép đồng nghĩa.
            cf = _fold(c)
            core = re.sub(r"^(hỗ trợ|giúp)\s+", "", cf)
            for h in _find_terms(text, [c] + ([core] if core != cf else []),
                                 pre):
                claim_hits.append({"sku": k, "claim": c,
                                   "start": h["start"], "end": h["end"]})
                matched.append({"sku": k, "claim": c})

    safe_hits = _negated_hits(text, _find_terms(text, list(SAFE_PHRASES),
                                                pre), pre)
    exempt = _cover((h["start"], h["end"]) for h in claim_hits + safe_hits)

    # --- Lớp 1: banned words (trừ span nằm trong approved claim /
    # disclaimer pháp lý bắt buộc) — pass thường + pass ký tự chèn.
    packed = _compress(text)  # bản nén dùng chung cho từ cấm + rượu
    for h, how in ([(h, "") for h in _find_terms(text, banned, pre)]
                   + [(h, " (chèn ký tự)")
                      for h in _filler_hits(text, banned, packed)]):
        if exempt(h["start"], h["end"]):
            continue
        flag("tu_cam", f"từ/cụm cấm{how}: \"{h['term']}\"",
             text[h["start"]:h["end"]], h["start"], h["end"],
             type_="banned_word")

    # --- Lớp 2: clause có động từ claim — trừ các span đã khớp whitelist;
    # phần dư mà vẫn chứa động từ claim -> công dụng không công bố -> flag.
    # (Fix lỗ hổng mệnh đề ghép: 'giảm ho VÀ làm đẹp da' từng pass vì
    # cả clause được coi là covered khi overlap 1 claim.) Claim span chỉ
    # xét trong cửa sổ bisect [start - maxlen, end) — không quét hết mỗi
    # clause (O(clause × claim) cũ).
    spans = sorted((c["start"], c["end"]) for c in claim_hits)
    starts = [s for s, _ in spans]
    maxlen = max((e - s for s, e in spans), default=0)
    claim_clauses = _claim_spans(low)
    for start, end in claim_clauses:
        cur, leftovers = start, []
        i = bisect.bisect_left(starts, start - maxlen)
        while i < len(spans) and spans[i][0] < end:
            ms, me = spans[i]
            i += 1
            if me <= start:
                continue
            if ms > cur:
                leftovers.append(low[cur:ms])
            cur = max(cur, me)
        if cur < end:
            leftovers.append(low[cur:end])
        if any(_pat(v).search(seg) for seg in leftovers
               for v in CLAIM_VERBS):
            seg = text[start:end]
            s2 = start + len(seg) - len(seg.lstrip())
            e2 = end - (len(seg) - len(seg.rstrip()))
            flag("claim_ngoai_cong_bo",
                 "claim công dụng không nằm trong whitelist đã công bố",
                 text[s2:e2], s2, e2, type_="unverified_claim")
    has_claim = bool(claim_hits) or bool(claim_clauses)

    # --- Rượu: mọi chế độ trừ ghi chú nội bộ (A3-2).
    if ctx is None or public:
        from pipelines import kb_filter  # lười: kéo llm_gateway/openai
        try:
            alc = kb_filter.is_alcohol(text)
            sp = _alcohol_span(kb_filter, pre) if alc else None
            if not alc:
                # Cùng lớp ký tự chèn với từ cấm ("r\u200bượu", "r.ượu"):
                # quét bản nén, map span về text gốc qua `_compress`.
                comp, cmap = packed
                if comp is not None and kb_filter.is_alcohol(comp):
                    alc = True
                    cs = _alcohol_span(kb_filter, _Txt(comp))
                    sp = (cmap[cs[0]], cmap[cs[1] - 1] + 1) if cs else None
        except kb_filter.KbFilterError as e:
            alc, sp = False, None
            flag("config", f"bộ lọc rượu không dùng được: {e}")
        if alc:
            flag("ruou_cam_quang_cao",
                 "nội dung nhắc rượu — cấm quảng cáo/khuyến mại rượu",
                 *((text[sp[0]:sp[1]], sp[0], sp[1]) if sp else ()))
        elif public and sku and golden[sku].get("category") == "alcohol":
            flag("ruou_cam_quang_cao",
                 f"SKU {sku} là rượu — cấm quảng cáo/khuyến mại rượu")

    labels = []
    if public:
        tp = [k for k in ctx_skus if golden[k].get("category") == "tpbvsk"]
        food = [k for k in ctx_skus if golden[k].get("category") == "food"]
        # 2+3. TPBVSK chưa XNQC: có claim, hoặc là nội dung quảng cáo.
        for k in tp:
            r = _readiness_of(golden[k], channel)
            if r != "QC_DAY_DU" and (has_claim or ad):
                flag("sku_chua_xnqc",
                     f"{k}: readiness {r} trên kênh {channel} — TPBVSK chưa"
                     " có XNQC, không được quảng cáo/nêu công dụng")
        if has_claim:
            for k in food:
                flag("claim_suc_khoe_tp_thuong",
                     f"{k}: thực phẩm thường không được nêu công dụng sức"
                     " khỏe")
            if not ctx_skus:
                flag("claim_khong_ro_sku",
                     "có claim sức khỏe nhưng không xác định được SKU")
        # 4. Câu khuyến cáo chuẩn (có dấu, còn sống sau lọc phủ định kép).
        if tp or has_claim:
            dh = [{"start": m.start(), "end": m.end()}
                  for m in _pat(cfg["canonical"]).finditer(low)]
            if not _negated_hits(text, dh, pre):
                flag("thieu_khuyen_cao",
                     f"thiếu câu khuyến cáo bắt buộc: \"{cfg['canonical']}\"")
        # 5. Nhãn AI / nhãn quảng cáo.
        if ctx["is_ai"]:
            labels.append(cfg["labels_ai"][0])
            if not _find_terms(text, cfg["labels_ai"], pre):
                flag("thieu_nhan_ai",
                     f"thiếu nhãn \"{cfg['labels_ai'][0]}\"")
        if ad:
            labels.append(cfg["labels_ad"][0])
            if not _find_terms(text, cfg["labels_ad"], pre):
                flag("thieu_nhan_quang_cao",
                     "thiếu nhãn nhận diện quảng cáo (vd \""
                     f"{cfg['labels_ad'][0]}\")")
        # 6. "Ngọc Linh" — chỉ khi MỌI SKU ngữ cảnh đã được xác nhận.
        if not (ctx_skus and all(k in cfg["nl_confirmed"] for k in ctx_skus)):
            ident = _cover((h["start"], h["end"]) for h in
                           _find_terms(text, cfg["nl_identity"], pre))
            for h in _find_terms(text, cfg["nl_terms"], pre):
                if not ident(h["start"], h["end"]):
                    flag("ngoc_linh_chua_xac_nhan",
                         "\"Ngọc Linh\" chỉ dùng khi SKU có quyết định công"
                         " nhận chỉ dẫn địa lý",
                         text[h["start"]:h["end"]], h["start"], h["end"])
        # 7. Kênh ngoài allowed_channels (hiện trạng listing) -> cảnh báo.
        for k in ctx_skus:
            s = golden[k]
            allowed = s.get("allowed_channels")
            if s.get("category") != "alcohol" and (
                    not isinstance(allowed, list) or channel not in allowed):
                flag("sku_chua_mo_kenh",
                     f"{k}: kênh {channel} ngoài allowed_channels hiện tại")

    seen, uniq = set(), []
    for m in matched:
        key = (m["sku"], m["claim"])
        if key not in seen:
            seen.add(key)
            uniq.append(m)
    return _result(viols, warns, uniq, skus, labels)


def _guarded(text, ctx) -> dict:
    try:
        return _run(text, ctx)
    except Exception as e:  # noqa: BLE001 — guardrail không bao giờ raise
        return _config_fail(f"guardrail lỗi nội bộ ({type(e).__name__}) —"
                            " fail-closed")


def check(text: str) -> dict:
    """Chế độ chat / không rõ ngữ cảnh: từ cấm + claim whitelist + rượu.

    Return {"ok","violations","matched_claims","warnings","skus",
    "required_labels"}; violations[].type ∈ {"banned_word",
    "unverified_claim","config","ruou_cam_quang_cao"}.
    Không raise lỗi ra ngoài; file data thiếu → ok=False + violation "config".
    """
    return _guarded(text, None)


def check_publish(text: str, *, channel: str, content_type: str = "post",
                  sku: str | None = None, is_ai: bool = True,
                  is_sponsored: bool = False) -> dict:
    """Chế độ đăng bài: luật của `check()` + XNQC/readiness, claim theo
    đúng SKU, câu khuyến cáo, nhãn AI/quảng cáo, "Ngọc Linh", kênh chưa
    mở (warning). `content_type="internal_note"`: chỉ luật `check()` trừ
    rượu. `is_ai` mặc định True (không khai = coi là AI, fail-closed).
    Kênh/loại/SKU lạ -> ok=False + "config". Không raise."""
    return _guarded(text, {"channel": channel, "content_type": content_type,
                           "sku": sku, "is_ai": is_ai,
                           "is_sponsored": is_sponsored})
