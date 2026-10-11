"""Báo cáo câu NO_DATA lặp lại để bổ sung KB (v3.9 W39.6, F03d bước 6).

0 LLM — cụm bằng luật: đọc convlog `data/conversations.jsonl` (+`.1`) qua
`ingest.lead_store.iter_convlog` (BYTES + split `\\n`), lấy record
`answered is False` (đúng bool False — "false" str / thiếu key không đếm).
Khóa cụm = câu (đã mask) NFC + casefold + gộp khoảng trắng + bỏ dấu câu
cuối. Mỗi cụm: số lần, số user_hash khác nhau, ts gần nhất, loại:
  - "sức khỏe" (is_health_question) / "rượu" (is_alcohol) -> KHÔNG bổ sung
    KB cho 2 loại này (chuyển người / luật QC rượu).
Câu hiển thị qua `_mask_pii` lần nữa (entry cũ trước khi mask) + escape `|`.

Chạy: `python scripts/kb_gaps.py [--min 2] [--out report.md]` (ghi atomic).
"""

import argparse
import os
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest.lead_store import CONV_FILES, DATA_DIR, iter_convlog
from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import is_health_question
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

_TRAIL_RE = re.compile(r"[\s?!.,;:…]+$")


def cluster_key(q: str) -> str:
    q = " ".join(unicodedata.normalize("NFC", q).casefold().split())
    return _TRAIL_RE.sub("", q)


def collect(data_dir: Path = DATA_DIR) -> list[dict]:
    """-> cụm NO_DATA, sắp theo số lần giảm dần."""
    stats = {"corrupt": 0, "doc": 0}
    groups: dict[str, dict] = {}
    for name in CONV_FILES:
        path = data_dir / name
        if not path.exists():
            continue
        for rec in iter_convlog(path, stats):
            q = rec.get("question")
            if rec.get("answered") is not False or not isinstance(q, str):
                continue
            shown = " ".join(_mask_pii(q).split())
            key = cluster_key(shown)
            if not key:
                continue
            g = groups.setdefault(key, {"question": shown, "count": 0,
                                        "users": set(), "last_ts": ""})
            g["count"] += 1
            if isinstance(rec.get("user_hash"), str):
                g["users"].add(rec["user_hash"])
            ts = rec.get("ts")
            if isinstance(ts, str) and ts > g["last_ts"]:
                g["last_ts"] = ts
    out = []
    for g in groups.values():
        kind = ("sức khỏe" if is_health_question(g["question"])
                else "rượu" if is_alcohol(g["question"]) else "")
        out.append({**g, "users": len(g["users"]), "kind": kind})
    return sorted(out, key=lambda g: (-g["count"], -g["users"], g["question"]))


def _cell(s: str) -> str:
    # Câu do khách gõ: escape để không vỡ bảng/không thành HTML khi render.
    return (s.replace("\\", "\\\\").replace("|", "\\|")
            .replace("<", "&lt;").replace(">", "&gt;"))


def render(groups: list[dict], min_count: int) -> str:
    rows = [g for g in groups if g["count"] >= min_count]
    lines = [f"# Câu NO_DATA lặp lại (>= {min_count} lần) — {len(rows)} câu",
             "",
             "Loại `sức khỏe`/`rượu`: KHÔNG bổ sung KB (chuyển người / luật QC rượu).",
             ""]
    if rows:
        lines += ["| # | Câu hỏi (đã mask) | Số lần | Số người | Gần nhất | Loại |",
                  "|---|---|---|---|---|---|"]
        lines += [f"| {i} | {_cell(g['question'])} | {g['count']} | {g['users']}"
                  f" | {_cell(g['last_ts'])} | {g['kind']} |"
                  for i, g in enumerate(rows, 1)]
    else:
        lines.append("0 câu.")
    return "\n".join(lines) + "\n"


def main(argv=None, data_dir: Path = DATA_DIR) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--min", type=int, default=2, dest="min_count")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    if a.min_count < 1:
        ap.error("--min phải >= 1")
    text = render(collect(data_dir), a.min_count)
    if a.out:
        out = Path(a.out)
        tmp = out.with_name(out.name + ".tmp")
        tmp.write_bytes(text.encode("utf-8"))
        os.replace(tmp, out)
        print(f"[kb-gaps] đã ghi {out.name}", flush=True)
    else:
        print(text, end="", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
