"""Bộ phát hiện nội dung RƯỢU cho kênh chatbot khách (v3.9 W39.2, F15.3).

Luật quảng cáo rượu >=15 độ: chunk/câu hỏi nói về rượu sâm KHÔNG được trả
cho chatbot khách. 0 LLM — chỉ luật:
  - Nguồn cụm: `data/ruou_keywords.txt` (1 cụm/dòng, `#` comment — CHỜ PHÁP
    CHẾ DUYỆT) + `name` của SKU `category == "alcohol"` trong
    `data/golden_skus.json` (v3.2).
  - Text NFC + casefold; cụm CÓ dấu so trên text đó, cụm KHÔNG dấu so trên
    bản bỏ dấu (`đ`→`d`). Biên từ `(?<!\\w)`/`(?!\\w)` chỉ ở đầu/cuối cụm là
    ký tự chữ-số (cụm "% vol" đứng sau "40"); khoảng trắng trong cụm khớp
    `\\s+`.
  - FAIL-CLOSED: keyword file missing / 0 byte / chỉ comment-dòng trắng ->
    `KbFilterError` (không bao giờ "0 cụm = không lọc gì"). Golden thiếu/
    hỏng -> chỉ dùng keyword file + cảnh báo.
  - Load 1 lần (cache); test gọi `reset_cache()` sau khi đổi đường dẫn.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

from pipelines.llm_gateway import _strip_accents

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
KEYWORDS_FILE = ROOT / "data" / "ruou_keywords.txt"
GOLDEN_FILE = ROOT / "data" / "golden_skus.json"

_cache: tuple[re.Pattern | None, re.Pattern | None] | None = None


class KbFilterError(RuntimeError):
    """Keyword file rượu không dùng được — fail-closed."""


def reset_cache() -> None:
    global _cache
    _cache = None


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", s).casefold()


def _golden_alcohol_names() -> list[str]:
    try:
        data = json.loads(GOLDEN_FILE.read_text(encoding="utf-8"))
        return [s["name"] for s in data["skus"]
                if isinstance(s, dict) and s.get("category") == "alcohol"
                and isinstance(s.get("name"), str) and s["name"].strip()]
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"[kb-filter] golden_skus.json không đọc được "
              f"({type(e).__name__}) — chỉ dùng {KEYWORDS_FILE.name}", flush=True)
        return []


def _phrases() -> list[str]:
    try:
        raw = KEYWORDS_FILE.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise KbFilterError(
            f"{KEYWORDS_FILE.name} không đọc được ({type(e).__name__})") from e
    words = [ln.strip() for ln in raw.split("\n")]
    words = [w for w in words if w and not w.startswith("#")]
    if not words:
        raise KbFilterError(f"{KEYWORDS_FILE.name} rỗng — fail-closed")
    return words + _golden_alcohol_names()


def _compile(phrases: list[str]) -> re.Pattern | None:
    parts = []
    for p in sorted(set(phrases), key=len, reverse=True):
        body = r"\s+".join(map(re.escape, p.split()))
        pre = r"(?<!\w)" if p[0].isalnum() else ""
        post = r"(?!\w)" if p[-1].isalnum() else ""
        parts.append(pre + body + post)
    return re.compile("|".join(parts)) if parts else None


def _patterns() -> tuple[re.Pattern | None, re.Pattern | None]:
    global _cache
    if _cache is None:
        ph = [_norm(p) for p in _phrases()]
        accented = [p for p in ph if _strip_accents(p) != p]
        ascii_ = [p for p in ph if _strip_accents(p) == p]
        _cache = (_compile(accented), _compile(ascii_))
    return _cache


def is_alcohol(text) -> bool:
    """True nếu text nhắc rượu (keyword/SKU rượu). Không phải str -> False."""
    acc, asc = _patterns()
    if not isinstance(text, str) or not text:
        return False
    t = _norm(text)
    if acc is not None and acc.search(t):
        return True
    return asc is not None and bool(asc.search(_strip_accents(t)))
