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
                is_ai=True, is_sponsored=False, readiness=None) -> cùng shape.
  with_violation(result, code, detail, span=None, start=None, end=None)
      -> dict MỚI có thêm 1 violation (v4.2 — lớp LLM/store chỉ CHẶN THÊM,
      không bao giờ đổi ok False -> True).
  violations[]: {"type","detail","span","code","severity","start","end"};
  `type` cũ (banned_word/unverified_claim/config) giữ nguyên chuỗi.

v4.2: `readiness` = map (sku_key, kênh-sau-alias) -> CAM|MO_TA|TP_THUONG|
QC_DAY_DU do CALLER đọc từ view `sku_readiness` (pipelines.store) — module
này vẫn không chạm DB. None -> soi gương golden file như v4.1; thiếu key ->
CAM (fail-closed); map không phải dict / giá trị lạ -> "config".
"""

import bisect
import json
import re
import unicodedata
from functools import lru_cache
from itertools import compress
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
# v14.1 (p1): banned có từ tiếng Anh ("medicine"...) -> câu khuyến cáo bản
# tiếng Anh trong KB ("This food is not a medicine and cannot replace
# medicine") cũng là phủ định, miễn như SAFE_PHRASES. Mọi mục mở đầu bằng
# từ phủ định "not"/"cannot" (cùng luật v3.0: không có mục khẳng định trần).
SAFE_PHRASES_EN = (
    "not a medicine",
    "not a substitute for medicine",
    "not replace medicine",
    "cannot replace medicine",
)

# Cụm đảo nghĩa đứng TRƯỚC disclaimer trong cùng clause -> phủ định kép/
# câu tu từ ("Ai bảo sản phẩm không phải là thuốc") -> KHÔNG miễn.
NEGATION_FLIPS = ("không ai", "ai bảo", "ai nói", "chẳng lẽ", "đâu phải")

SEVERITIES = ("critical", "major", "minor")
READINESS_LEVELS = ("CAM", "MO_TA", "TP_THUONG", "QC_DAY_DU")

# Ký tự chèn giữa 2 CHỮ CÁI để lách từ cấm ("th.uốc", "đi<ZWSP>ều trị").
# Chỉ bỏ khi 2 bên đều là chữ cái — "No.5", "Tp. HCM" giữ nguyên.
# v4.2 (red-team PC-A9): thêm khoảng trắng Unicode hẹp (U+2000–U+200A,
# U+202F, U+205F), variation selector U+FE0F, emoji/biểu tượng (U+2600–
# U+27BF, U+1F300–U+1FAFF) chèn giữa chữ ("th\U0001f48auốc", "thu<thin>ốc"); và
# nhánh 2: khoảng trắng (kể cả chuỗi trắng Unicode trộn — biến thể red-team
# LLM "c <thin> h") giữa 2 chữ cái ĐƠN ("t h u ố c") — chữ nhiều ký tự
# hai bên ("đi ều") không gộp (dễ nối nhầm 2 từ thật). Chữ "đơn" = không
# dính chữ/ký tự chèn khác 2 bên (không gộp "t.h.u.o.c t.h.u.o.c" thành 1
# chuỗi liền mất biên từ). Giới hạn đã biết: nhiều từ viết cách chữ LIỀN
# nhau ("t h u ố c t r ị") bị gộp thành 1 chuỗi -> lọt (known-gap red-team).
_FILL = (r".\-_*\u00ad\u200b-\u200d\u2060\ufeff\u2000-\u200a\u202f\u205f"
         r"\ufe0f\u2600-\u27bf\U0001f300-\U0001faff")
_SPACES = r" \u00a0\u2000-\u200a\u202f\u205f\u3000"
_FILLER_RE = re.compile(
    rf"(?<=[^\W\d_])[{_FILL}]+(?=[^\W\d_])"
    rf"|(?<=(?<![^\W\d_]|[{_FILL}])[^\W\d_])[{_SPACES}]+"
    rf"(?=[^\W\d_](?![^\W\d_]|[{_FILL[1:]}]))")

# v4.2 (red-team PC-A9): homoglyph Cyrillic/Greek -> Latin, 1 ký tự -> 1 ký
# tự (giữ bất biến len(_fold(s)) == len(s)). Áp SAU casefold.
_HOMOGLYPH = str.maketrans({
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
    "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0442": "t",
    "\u043d": "h", "\u043a": "k", "\u043c": "m", "\u0432": "b",
    "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u04bb": "h",
    "\u0501": "d", "\u04cf": "l", "\u0261": "g",
    "\u03b1": "a", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t",
    "\u03c5": "u", "\u03bd": "v", "\u03b9": "i", "\u03ba": "k",
    "\u03c7": "x", "\u03b5": "e",
})

_FLIP = bytes.maketrans(b"\x00\x01", b"\x01\x00")


@lru_cache(maxsize=65536)
def _fold_char(ch: str) -> str:
    # v4.2: NFKC 1 ký tự (fullwidth "\uff54" -> "t") rồi casefold, rồi homoglyph.
    k = unicodedata.normalize("NFKC", ch)
    ch = k if len(k) == 1 else ch
    f = ch.casefold()
    if len(f) != 1:
        f = ch.lower()
        if len(f) != 1:
            return ch  # "ß"/"ﬁ"/"İ": giữ nguyên, không lệch
    return f.translate(_HOMOGLYPH)


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
    runs = [m.span() for m in _FILLER_RE.finditer(text)]
    if not runs:
        return None, []
    # v4.2: mặt nạ byte + itertools.compress (C) thay vòng append/extend
    # Python mỗi run — văn bản toàn chữ cái đơn ("a b a b…") có ~n/2 run.
    drop = bytearray(len(text))
    for s, e in runs:
        drop[s:e] = b"\x01" * (e - s)
    keep = drop.translate(_FLIP)
    return ("".join(compress(text, keep)),
            list(compress(range(len(text)), keep)))


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


# v13.1 (F07 red-team): 3 lớp lách từ cấm còn lọt sau v4.2, khép bằng
# LUẬT (không đổi nhãn/known_gap). Áp trên bản fold (`_Txt.low`, cùng độ
# dài text gốc), hit trùng span pass chính thì bỏ.
#  (A) cụm cấm NHIỀU âm tiết bị chèn khoảng trắng TRONG âm tiết ("đi ều
#      trị") hoặc dính liền ("khỏibệnh"): giữa 2 ký tự cùng âm tiết cho
#      <=2 khoảng trắng, giữa 2 âm tiết <=3 (kể cả 0). Chỉ cụm >=2 âm tiết
#      — từ đơn ("thu ốc") dễ trùng 2 từ thật.
#  (B) cụm cấm nhiều âm tiết bị dấu câu/emoji chia ("Khỏi. Bệnh."): giữa 2
#      âm tiết 1–4 ký tự không phải chữ (không xuống dòng), VÀ âm tiết đầu
#      không đứng ngay sau một từ khác ("giá trị. Bệnh nhân" KHÔNG khớp
#      "trị bệnh") — mẫu lách là mảnh 1 từ tách câu.
#  (C) chuỗi chữ cái ĐƠN cách nhau ("t h u ố c t r ị"): nối lại rồi tìm từ
#      cấm như CHUỖI CON (chuỗi chữ đơn nối là hiện vật lách, không có biên
#      từ thật — v4.2 mất biên từ "thuốctrị").
# Cộng biểu tượng viên thuốc (U+1F48A) = "thuốc" (đứng riêng hay chèn thay chữ).
_PILL = "\U0001f48a"
_HSP = r"[^\S\n]"
_LETTER = r"[^\W\d_]"
_SPACED_RUN_RE = re.compile(
    rf"(?<!{_LETTER}){_LETTER}(?!{_LETTER})"
    rf"(?:{_HSP}+{_LETTER}(?!{_LETTER})){{2,}}")


@lru_cache(maxsize=1024)
def _split_pats(term: str) -> tuple[re.Pattern, re.Pattern] | None:
    words = _fold(term).split()
    if len(words) < 2:
        return None
    intra = [f"{_HSP}{{0,2}}".join(map(re.escape, w)) for w in words]
    a = re.compile(r"(?<!\w)" + f"{_HSP}{{0,3}}".join(intra) + r"(?!\w)")
    b = re.compile(rf"(?<!\w{_HSP})(?<!\w{_HSP}{{2}})(?<!\w)"
                   + r"[^\w\n]{1,4}".join(map(re.escape, words))
                   + r"(?!\w)")
    return a, b


def _evasion_hits(text: str, terms: list[str], pre: _Txt,
                  taken: list[tuple[int, int]]) -> list[tuple[dict, str]]:
    """Hit (A)(B)(C) + biểu tượng viên thuốc, bỏ hit chồng span đã có (`taken`)."""
    low = pre.low
    used = bytearray(len(text) + 1)  # 1 = vị trí đã thuộc hit (O(span)/lần)
    for s, e in taken:
        used[s:e] = b"\x01" * (e - s)
    out = []

    def add(term, s, e, how):
        if not any(used[s:e]):
            out.append(({"term": term, "start": s, "end": e}, how))
            used[s:e] = b"\x01" * (e - s)

    for term in terms:
        pats = _split_pats(term)
        if pats is None:
            continue
        for p, how in zip(pats, (" (tách âm tiết)", " (chia bằng dấu câu)")):
            for m in p.finditer(low):
                add(term, m.start(), m.end(), how)
    for m in _SPACED_RUN_RE.finditer(low):
        pos = [i for i in range(m.start(), m.end()) if not low[i].isspace()]
        joined = "".join(low[i] for i in pos)
        bare = _strip_len(joined) == joined
        for term in terms:
            t = "".join(_fold(term).split())
            for cand in {t, _strip_len(t)} if bare else {t}:
                k = joined.find(cand) if cand else -1
                if k >= 0:
                    add(term, pos[k], pos[k + len(cand) - 1] + 1,
                        " (chữ cách rời)")
    i = text.find(_PILL)
    while i >= 0:
        add("thuốc", i, i + len(_PILL), " (biểu tượng viên thuốc)")
        i = text.find(_PILL, i + 1)
    # v14.1 (D): nhầm dấu hỏi/ngã — cụm cấm >=2 âm tiết so trên bản đổi
    # ngã -> hỏi ("khõi bịnh" = "khỏi bịnh"). Chỉ hỏi/ngã (lỗi chính tả phổ
    # biến nhất), KHÔNG nới mọi dấu thanh: "thuộc bộ" ≠ "thuốc bổ", "chưa
    # khỏi" ≠ "chữa khỏi" vẫn khác. Từ đơn ("chửa" = có chửa) không áp.
    hn = "".join(map(_hoi_nga, low))
    if hn != low:
        for term in terms:
            t = "".join(map(_hoi_nga, _fold(term)))
            if len(t.split()) < 2:
                continue
            for m in _pat(t).finditer(hn):
                add(term, m.start(), m.end(), " (nhầm dấu hỏi/ngã)")
    # v14.1 (E): viết tắt "UT" (= ung thư) CHỈ khi viết HOA và có ngữ cảnh
    # bệnh ngay quanh ("khỏi hẳn UT", "UT giai đoạn đầu", "bị UT") — "UT"
    # trần ngoài ngữ cảnh (tên riêng/viết tắt khác) không bắt.
    if "ung thư" in terms:
        st = pre.stripped
        for m in _UT_RE.finditer(text):
            s, e = m.span()
            if (_UT_BEFORE_RE.search(st, max(0, s - 25), s)
                    or _UT_AFTER_RE.match(st, e)):
                add("ung thư", s, e, " (viết tắt UT)")
    return out


@lru_cache(maxsize=65536)
def _hoi_nga(ch: str) -> str:
    """1 ký tự: dấu ngã -> dấu hỏi (giữ độ dài; ký tự lạ giữ nguyên)."""
    d = unicodedata.normalize("NFD", ch)
    if "\u0303" not in d:
        return ch
    r = unicodedata.normalize("NFC", d.replace("\u0303", "\u0309"))
    return r if len(r) == 1 else ch


_UT_RE = re.compile(r"(?<!\w)UT(?!\w)")
_UT_BEFORE_RE = re.compile(
    r"(?<!\w)(?:khoi|chua|tri|bi|mac|benh|chong|phong|ngua|tieu diet|"
    r"di can|dieu tri)(?:[ \t]+(?:han|het|duoc|luon|ca))?[ \t]+$")
_UT_AFTER_RE = re.compile(r"[ \t]+(?:giai[ \t]+doan|di[ \t]+can|vu|gan|"
                          r"phoi|da[ \t]+day|mau)(?!\w)")

# v14.1 (F, red-team chia_cau): claim tách câu "rất tốt. Cho tim mạch của
# bạn" — clause sau không còn động từ claim. Bắt "tốt" kết câu + câu sau mở
# bằng "cho" + đích sức khỏe (cơ quan/chỉ số) không nằm trong claim đã công
# bố -> claim_ngoai_cong_bo. Không đích sức khỏe ("rất tốt. Cho mình xin
# địa chỉ") thì không bắt.
_SPLIT_CLAIM_RE = re.compile(
    r"(?<!\w)tốt(?:[ \t]+(?:nhất|lắm|quá|hơn|lắm[ \t]+luôn))?[ \t]*"
    r"[.;:!…]+[ \t]*cho[ \t]+([^.,;:!?\n]{1,120})")
_HEALTH_TARGETS = (
    "tim mạch", "tim", "gan", "thận", "phổi", "dạ dày", "xương khớp",
    "khớp", "huyết áp", "đường huyết", "mỡ máu", "trí não", "não",
    "giấc ngủ", "sinh lý", "tiêu hóa", "miễn dịch", "đề kháng", "mắt",
    "người bệnh", "bệnh nhân", "nội tiết", "thần kinh", "máu")
_HEALTH_TARGET_RE = re.compile(
    r"(?<!\w)(?:" + "|".join(map(re.escape, _HEALTH_TARGETS)) + r")(?!\w)")


# Đợt hợp đồng (G2, red-team rt-ay-02/03, rt-llm-05): claim NGẦM không động
# từ claim/từ cấm — (a) nhắm ĐỐI TƯỢNG bệnh/triệu chứng ("dành cho người hay
# mệt mỏi", "người bị gout", "người mong muốn kiểm soát đường huyết"); (b) lời
# chứng KẾT QUẢ trên người dùng ("dùng ... thấy khác hẳn"). Trước đây chỉ lớp
# LLM (tắt mặc định) có thể bắt -> nay luật cục bộ, code `ngam_y_suc_khoe`.
# Quét bản fold+bỏ dấu (có dấu/không dấu/trộn dấu/homoglyph cùng 1 nhánh) và
# bản nén ký tự chèn (`_compress`); ZWSP/soft hyphen giữa 2 TỪ = khoảng trắng.
# Chỉ áp ở đăng bài công khai (check_publish). Miễn: câu khuyến cáo phủ định
# ("không dùng cho người bị gout", "người bị gout nên hỏi ý kiến bác sĩ").
# ponytail: danh sách từ cố định — Pháp chế bổ sung; diễn đạt ngoài danh sách
# vẫn chỉ lớp LLM/người duyệt bắt (giới hạn ghi ở docs/handover/doi-chieu-docx.md).
_ISEP = r"[\s\u00ad\u200b-\u200d\u2060\ufeff]"


def _alt(words, sep):
    return "(?:" + "|".join(sorted((sep.join(map(re.escape, w.split()))
                                    for w in words), key=len, reverse=True)) + ")"


_AUD_W = ("nguoi", "nguoi dung", "ai", "ban", "cac ban", "khach", "khach hang",
          "quy khach", "benh nhan", "ong ba", "bo me", "cha me", "anh chi",
          "chi em", "nhung ai", "moi nguoi", "dan van phong")
_COND_W = ("bi", "mac", "hay", "hay bi", "thuong", "thuong bi", "thuong xuyen",
           "thuong xuyen bi", "dang", "dang bi", "dang mac", "co", "co benh",
           "gap", "dang gap", "gap van de ve", "dang gap van de ve",
           "co van de ve", "mong muon", "muon", "can", "dang can", "lo",
           "lo lang ve", "lo ngai ve", "kho")
_ACT_W = ("kiem soat", "on dinh", "duy tri", "dieu chinh", "ha", "het",
          "thoat khoi", "vuot qua", "cai thien", "giam", "chong", "ngua",
          "phong ngua")
# Từ mạnh: tên bệnh/chỉ số/triệu chứng rõ nghĩa sau khi bỏ dấu.
_HEALTH_W = ("tieu duong", "dai thao duong", "duong huyet", "duong trong mau",
             "huyet ap", "cao huyet ap", "huyet ap cao", "mo mau", "cholesterol",
             "gout", "gut", "axit uric", "acid uric", "ung thu", "khoi u",
             "u buou", "tim mach", "benh tim", "suy tim", "dot quy", "tai bien",
             "xuong khop", "dau khop", "viem khop", "thoai hoa", "gan nhiem mo",
             "men gan", "benh gan", "suy than", "soi than", "benh than",
             "da day", "trao nguoc", "mat ngu", "kho ngu", "ngu khong sau",
             "ngu khong ngon", "met moi", "suy nhuoc", "suy giam tri nho",
             "suy giam mien dich", "hen suyen", "benh tri", "yeu sinh ly",
             "roi loan cuong", "xuat tinh som", "vo sinh", "hiem muon",
             "tram cam", "roi loan lo au", "dau dau", "dau nua dau",
             "chong mat", "hoa mat", "thieu mau", "beo phi", "thua can",
             "tao bon", "roi loan tieu hoa", "benh man tinh", "benh nen",
             "parkinson", "alzheimer", "sa sut tri tue", "benh", "hoa tri",
             "xa tri", "sau phau thuat")
# Từ yếu (1 âm tiết/đa nghĩa khi bỏ dấu: ốm/ôm) — chỉ khi có điều kiện ("bị").
_WEAK_W = ("om", "om yeu", "cang thang", "stress", "suy yeu")
_USE_W = ("dung", "uong", "su dung", "an", "xai")
_RESULT_W = ("khac han", "khac ro", "khac biet ro", "thay doi ro", "do han",
             "do nhieu", "het", "het han", "giam han", "giam ro", "cai thien",
             "on dinh", "hieu qua", "khoe", "khoe hon", "khoe han", "ngu ngon",
             "nhe nguoi", "tinh tao", "bot han", "tien trien", "ro ret")


@lru_cache(maxsize=2)
def _implied_res(s: str):
    """s = phân cách giữa token: `_ISEP+` (bản gốc) | `_ISEP*` (bản nén —
    ký tự chèn giữa 2 từ đã bị bỏ, từ có thể dính liền)."""
    aud, cond = _alt(_AUD_W, s), _alt(_COND_W, s)
    act, hl, weak = _alt(_ACT_W, s), _alt(_HEALTH_W, s), _alt(_WEAK_W, s)
    gap = rf"(?:{_ISEP}+\w+){{0,3}}?"
    aud_re = re.compile(
        rf"(?<!\w){aud}(?:{gap}{s}{cond})?(?:{s}{act})?{s}{hl}(?!\w)"
        rf"|(?<!\w){aud}{gap}{s}{cond}(?:{s}{act})?{s}{weak}(?!\w)")
    res_re = re.compile(
        rf"(?<!\w){_alt(_USE_W, s)}(?!\w)[^.!?;\n]{{0,60}}?(?<!\w)"
        rf"(?:cam{s}thay|nhan{s}thay|thay)(?:{s}ro)?{s}{_alt(_RESULT_W, s)}"
        rf"(?!\w)")
    return aud_re, res_re


_CAUTION_BEFORE = re.compile(
    r"(?:(?:khong|chua|tranh)\s+(?:nen\s+)?(?:dung|su\s+dung|uong|danh|phu\s+hop"
    r"|khuyen\s+dung)(?:\s+(?:cho|voi))?|chong\s+chi\s+dinh(?:\s+(?:cho|voi))?"
    r"|than\s+trong(?:\s+khi\s+dung)?(?:\s+(?:cho|voi))?)\s*:?\s*$")
_CAUTION_AFTER = re.compile(
    r"^\s*,?\s*(?:(?:nen|can|phai|vui\s+long)\s+(?:hoi|tham\s+khao|xin)\s+y\s+kien"
    r"|(?:khong|chua)\s+(?:nen\s+)?(?:dung|su\s+dung|uong))")


def _implied_health(low_stripped: str, sep: str
                    ) -> list[tuple[int, int, str]]:
    """Không miễn theo HÌNH THỨC (vd dòng `Hỏi: …?`): nhãn/định dạng do
    caller viết không phải bằng chứng câu đó an toàn (vá controller 20/10).
    Câu hỏi sức khỏe của khách trong kịch bản livestream được `kd_live` thay
    bằng dòng trung tính TRƯỚC khi gọi guardrail."""
    aud_re, res_re = _implied_res(sep)
    out = []
    for m in aud_re.finditer(low_stripped):
        cs = max(low_stripped.rfind(c, 0, m.start()) for c in ".!?;\n,") + 1
        ce = min([i for i in (low_stripped.find(c, m.end()) for c in ".!?;\n")
                  if i >= 0] or [len(low_stripped)])
        before = re.sub(_ISEP + "+", " ", low_stripped[cs:m.start()])
        after = re.sub(_ISEP + "+", " ", low_stripped[m.end():ce])
        if _CAUTION_BEFORE.search(before) or _CAUTION_AFTER.search(after):
            continue
        out.append((m.start(), m.end(), "đối tượng bệnh/triệu chứng"))
    out += [(m.start(), m.end(), "lời chứng kết quả trên người dùng")
            for m in res_re.finditer(low_stripped)]
    return out


def _implied_health_hits(pre: "_Txt", packed) -> list[tuple[int, int, str]]:
    hits = _implied_health(pre.stripped, _ISEP + "+")
    comp, cmap = packed
    if comp is not None:
        for s, e, why in _implied_health(_Txt(comp).stripped, _ISEP + "*"):
            hits.append((cmap[s], cmap[e - 1] + 1, why))
    return sorted(set(hits))


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


# docx P1 (PL02 mục 2 "rượu xuất hiện trong nội dung công khai" = lỗi nghiêm
# trọng; red-team rt-ruou-01/02, rt-llm-06): rượu NÓI VÒNG không có từ khóa
# rượu — luật TỔ HỢP hẹp trên bản bỏ dấu (giữ độ dài, span dùng chung), mỗi
# luật cần ≥ 2 tín hiệu cùng lúc để không bắt nhầm 'sâm ngâm mật ong',
# 'nhiệt độ 18–25 độ C', 'nâng ly' ở tin sự kiện, 'nồng độ acid uric' (quét
# data/articles|news|products.jsonl: 0 khớp). Không đổi `kb_filter` (lọc KB/
# chat giữ nguyên).
_ALC_DEG = re.compile(r"(?<![\d.,])(?:1[5-9]|[2-6]\d|70)\s*(?:do|°)"
                      r"(?!\s*c(?![a-z]))(?!\s*[\d′'])(?![a-z0-9])")
_ALC_DEG_NOT = re.compile(r"(?:nhiet do|duoi|tren|khoang|tu|den|[-–])\s*$")
# tín hiệu đi kèm độ cồn: bản CÓ dấu (1 âm tiết như 'rót'/'chén'/'chai' trùng
# chữ tiếng Anh khi bỏ dấu) + bản bỏ dấu chỉ cho cụm không nhập nhằng.
_ALC_CUE = re.compile(r"(?<!\w)(?:ngâm|nhâm nhi|rót|chén|cụng ly|nâng ly"
                      r"|lên men|chai|bình)(?!\w)")
_ALC_CUE_ASC = re.compile(r"(?<![a-z])(?:ngam|nham nhi|cung ly|nang ly"
                          r"|len men)(?![a-z])")
_ALC_POUR = re.compile(r"(?<![a-z])rot(?![a-z])[^.!?;\n]{0,30}?"
                       r"(?<![a-z])(?:chen|ly)(?![a-z])")
_ALC_HOST = re.compile(r"(?<![a-z])(?:dai khach|moi khach|am bung|nham nhi"
                       r"|cung ly|nang ly)(?![a-z])")
_ALC_SOAK = re.compile(r"(?<![a-z])ngam(?![a-z])")
_ALC_FERM = re.compile(r"(?<![a-z])len men(?![a-z])")
_ALC_STRONG = re.compile(r"(?<![a-z])nong do\s+(?:manh|cao|nang)(?![a-z])")


def _alcohol_indirect(pre: _Txt) -> tuple[str, int, int] | None:
    """Rượu nói vòng → (luật, start, end) trên text gốc | None."""
    s = pre.stripped
    for m in _ALC_DEG.finditer(s):
        if not _ALC_DEG_NOT.search(s[max(0, m.start() - 14):m.start()]) \
                and (_ALC_CUE.search(pre.low) or _ALC_CUE_ASC.search(s)):
            return "độ cồn + ngâm/rót/chén/lên men", m.start(), m.end()
    m = _ALC_POUR.search(s)
    if m and _ALC_SOAK.search(s) and _ALC_HOST.search(s):
        return "ngâm + rót chén/ly + mời/đãi/nhâm nhi", m.start(), m.end()
    m = _ALC_STRONG.search(s)
    if m and _ALC_FERM.search(s):
        return "lên men + nồng độ mạnh/cao", m.start(), m.end()
    return None


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def _contact_key(s: str) -> str:
    """Khóa so `pii_allow`: email → casefold; số → chỉ chữ số, đầu 84 → 0
    (r12-fix D2: "+84 235 3699 899" là số công ty "0235 3699 899")."""
    if "@" in s:
        return s.casefold()
    d = _digits(s)
    return "0" + d[2:] if d.startswith("84") else d


@lru_cache(maxsize=1)
def _public_contacts() -> frozenset:
    """Liên hệ CÔNG KHAI của công ty — cùng nguồn `pii_allow` của gateway
    (số → chỉ chữ số, email → casefold). Không đọc được → rỗng (fail-closed:
    số công ty cũng bị chặn, không lọt số cá nhân)."""
    try:
        allow = json.loads((DATA_DIR / "llm_gateway.json").read_bytes()
                           .decode("utf-8")).get("pii_allow") or []
    except (OSError, ValueError, AttributeError):
        return frozenset()
    return frozenset(_contact_key(a) for a in allow if isinstance(a, str))


def _sev_mode(rules, code) -> tuple[str, str]:
    """(severity, mode) theo rules[code]; thiếu/hỏng -> critical + block."""
    r = rules.get(code) if isinstance(rules, dict) else None
    if (isinstance(r, dict) and r.get("severity") in SEVERITIES
            and r.get("mode") in ("block", "warn")):
        return r["severity"], r["mode"]
    return "critical", "block"  # code thiếu luật -> fail-closed


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
        sev, mode = _sev_mode(rules, code)
        (warns if mode == "warn" else viols).append(
            _vdict(code, sev, detail, span, start, end, type_))

    if not isinstance(text, str):
        text = "" if text is None else str(text)
    text = unicodedata.normalize("NFC", text)

    public, ad, channel, sku, rmap = False, False, None, None, None
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
        rmap = ctx.get("readiness")
        if rmap is not None and not (
                isinstance(rmap, dict)
                and all(r in READINESS_LEVELS for r in rmap.values())):
            return _config_fail("readiness không hợp lệ (không phải map "
                                "sku×kênh -> mức sku_readiness)")
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

    safe_hits = _negated_hits(text, _find_terms(text, list(SAFE_PHRASES)
                                                + list(SAFE_PHRASES_EN),
                                                pre), pre)
    exempt = _cover((h["start"], h["end"]) for h in claim_hits + safe_hits)

    # --- Lớp 1: banned words (trừ span nằm trong approved claim /
    # disclaimer pháp lý bắt buộc) — pass thường + pass ký tự chèn.
    packed = _compress(text)  # bản nén dùng chung cho từ cấm + rượu
    base = ([(h, "") for h in _find_terms(text, banned, pre)]
            + [(h, " (chèn ký tự)")
               for h in _filler_hits(text, banned, packed)])
    base += _evasion_hits(text, banned, pre,
                          [(h["start"], h["end"]) for h, _ in base])
    for h, how in base:
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
    split_claim = False
    for m in _SPLIT_CLAIM_RE.finditer(low):
        s1, e1 = m.span(1)
        tg = _HEALTH_TARGET_RE.search(low, s1, e1)
        if tg is None or exempt(tg.start(), tg.end()) or any(
                s < e1 and e > s1 for s, e in spans):
            continue
        split_claim = True
        flag("claim_ngoai_cong_bo",
             "claim công dụng tách câu ('tốt. Cho <cơ quan/chỉ số>') không "
             "nằm trong whitelist đã công bố",
             text[m.start():e1].rstrip(), m.start(),
             m.start() + len(text[m.start():e1].rstrip()),
             type_="unverified_claim")
    implied = _implied_health_hits(pre, packed) if public else []
    for s, e, why in implied:
        flag("ngam_y_suc_khoe",
             f"claim sức khỏe ngầm ({why}) — không có trong hồ sơ công bố; "
             "người duyệt/Pháp chế phải xem", text[s:e], s, e,
             type_="unverified_claim")
    has_claim = (bool(claim_hits) or bool(claim_clauses) or split_claim
                 or bool(implied))

    # --- Rượu: mọi chế độ trừ ghi chú nội bộ (A3-2).
    if ctx is None or public:
        from pipelines import kb_filter  # lười: kéo llm_gateway/openai
        try:
            alc = kb_filter.is_alcohol(text)
            if not alc and pre.low != text.casefold():
                # v4.2: homoglyph/fullwidth ("ru<Cyrillic o>u") — quét bản
                # fold (1-1 với text, span dùng chung).
                alc = kb_filter.is_alcohol(pre.low)
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
        ind = None if alc or not public else _alcohol_indirect(pre)
        if ind:
            flag("ruou_cam_quang_cao",
                 f"rượu nói vòng ({ind[0]}) — cấm quảng cáo/khuyến mại rượu",
                 text[ind[1]:ind[2]], ind[1], ind[2])
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
            # v4.2: map từ view DB (caller đọc) — thiếu key = CAM.
            r = (rmap.get((k, channel), "CAM") if rmap is not None
                 else _readiness_of(golden[k], channel))
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
        # 8. r12 D2: SĐT/email cá nhân trong nội dung công khai → chặn;
        # liên hệ công khai của công ty (pii_allow) được giữ.
        # r12-fix D2: quét thêm bản phẳng của `pii._flatten_paren` (cùng luật
        # chống nối/ngân sách với `_mask_pii`) — "(0912) 345 678" lọt
        # `_PII_RE` thô; cạn ngân sách (đuôi ngoặc không kiểm hết) → chặn.
        from pipelines.pii import _PII_RE, _flatten_paren
        allow = _public_contacts()
        pii_msg = ("SĐT/email cá nhân trong nội dung công khai — chỉ dùng"
                   " liên hệ công khai của công ty")
        seen = set()
        for m in _PII_RE.finditer(text):
            seen.add(_contact_key(m.group(0)))
            if _contact_key(m.group(0)) not in allow:
                flag("pii_ca_nhan", pii_msg, m.group(0), m.start(), m.end())
        flat, cut = _flatten_paren(text)
        for m in _PII_RE.finditer(flat):
            key = _contact_key(m.group(0))
            if key not in allow and key not in seen:
                seen.add(key)
                flag("pii_ca_nhan", pii_msg, m.group(0).strip())
        if cut:
            flag("pii_ca_nhan", pii_msg + " (chuỗi ngoặc quá dài, không"
                 " kiểm hết được)")
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
                  is_sponsored: bool = False,
                  readiness: dict | None = None) -> dict:
    """Chế độ đăng bài: luật của `check()` + XNQC/readiness, claim theo
    đúng SKU, câu khuyến cáo, nhãn AI/quảng cáo, "Ngọc Linh", kênh chưa
    mở (warning). `content_type="internal_note"`: chỉ luật `check()` trừ
    rượu. `is_ai` mặc định True (không khai = coi là AI, fail-closed).
    Kênh/loại/SKU lạ -> ok=False + "config". Không raise.
    `readiness`: map (sku_key, kênh sau alias) -> mức view `sku_readiness`
    (caller đọc DB); None -> soi gương golden file. Thiếu key -> CAM."""
    return _guarded(text, {"channel": channel, "content_type": content_type,
                           "sku": sku, "is_ai": is_ai,
                           "is_sponsored": is_sponsored,
                           "readiness": readiness})


def with_violation(result, code: str, detail, span=None, start=None,
                   end=None) -> dict:
    """Trả dict MỚI = `result` + 1 violation `code` (severity/mode theo
    data/guardrail_rules.json; code thiếu luật -> critical block). Không
    mutate input. `ok` mới = `result["ok"] is True` VÀ mode != block —
    KHÔNG BAO GIỜ nâng ok lên True (lớp LLM/store chỉ được chặn thêm).
    `result` không phải dict -> coi như ok=False rỗng. Không raise."""
    base = result if isinstance(result, dict) else {}
    cfg, err = _load_rules(DATA_DIR)
    sev, mode = _sev_mode(cfg["rules"] if not err else {}, code)
    v = _vdict(code, sev, None if detail is None else str(detail)[:500],
               span, start, end)
    out = dict(base)
    viols = base.get("violations")
    warns = base.get("warnings")
    out["violations"] = list(viols) if isinstance(viols, list) else []
    out["warnings"] = list(warns) if isinstance(warns, list) else []
    (out["warnings"] if mode == "warn" else out["violations"]).append(v)
    out["ok"] = base.get("ok") is True and mode != "block"
    return out
