"""v8.3 DA-02 — GỢI Ý phân loại yêu cầu thay đổi phạm vi (CR) theo SOW.

Contract:
  - Luật `data/projects/sow_scope.json` (BẢN DEV SOẠN): {id, label
    trong_sow|can_cr, keywords[], sow_ref, sow_quote}. `load_scope` kiểm
    `sow_quote` là chuỗi con NGUYÊN VĂN của file SOW — lệch → `ScopeError`
    (lỗi cấu hình, exit 1). Agent không được "trích" điều SOW không viết.
  - `classify(text, scope)` THUẦN: casefold + bỏ dấu, ranh giới từ; khớp
    cả 2 nhãn → `can_cr` thắng; không khớp → `chua_ro` (KHÔNG mặc định
    trong_sow).
  - `draft_cr` markdown: mô tả đã `_mask_pii` + che số tiền, trích SOW,
    effort "chưa ước tính", "Giá/phạm vi do TGĐ chốt — agent KHÔNG đặt
    giá", dòng bắt buộc "Xung đột lợi ích".
  - Nháp trượt `guardrail.check` (vd "chữa lỗi", "thuốc" trong yêu cầu)
    → cảnh báo; `--submit` bị TỪ CHỐI exit 1 TRƯỚC connect (mục trượt
    không duyệt được — người gửi diễn đạt lại, vd "sửa lỗi").
  - Sổ CR = mục `approval_queue` khối `projects` loại `change_request`
    (trạng thái = quyết định của TGĐ). Không mạng, không LLM.
  - `--eval` chạy bộ MẪU dev (`tests/fixtures/du_an/cr_cases_MAU.json`,
    labeled_by dev_MAU) — KHÔNG phải nghiệm thu; bộ thật do TGĐ/Pháp chế
    gán nhãn (external-dep).

Chạy:
  python -m agents.da_cr --classify "<yêu cầu>"
  python -m agents.da_cr --cr "<yêu cầu>" [--submit] [--out-dir DIR]
  python -m agents.da_cr --eval [--cases FILE]
  python -m agents.da_cr --list
Exit: 0 ok · 1 cấu hình lỗi / eval < 0.9 / trùng mục chờ · 2 tham số sai /
DB down / lỗi DB.
"""

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from contextlib import suppress
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SCOPE_FILE = ROOT / "data" / "projects" / "sow_scope.json"
CASES_FILE = ROOT / "tests" / "fixtures" / "du_an" / "cr_cases_MAU.json"
LABELS = ("trong_sow", "can_cr")
MAX_TEXT = 2000
THRESHOLD = 0.9
BLOCK = "projects"
CREATED_BY = "agent:da_cr"
COI_LINE = ("Xung đột lợi ích: agent do đơn vị thực hiện SOW xây dựng — "
            "phân loại chỉ là GỢI Ý.")
PRICE_LINE = "Giá/phạm vi do TGĐ chốt — agent KHÔNG đặt giá."
_ID_RE = re.compile(r"[a-z0-9_]{1,40}")
_MONEY_RE = re.compile(r"\d[\d.,]*\s*(?:đồng|đ|vnđ|vnd|triệu|tr|tỷ|k)(?!\w)",
                       re.IGNORECASE)
_LABEL_VN = {"trong_sow": "TRONG phạm vi SOW",
             "can_cr": "CẦN change request (ngoài phạm vi)",
             "chua_ro": "CHƯA RÕ — người phân loại"}


class ScopeError(ValueError):
    """File luật hỏng hoặc trích SOW không nguyên văn."""


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", unicodedata.normalize(
        "NFKC", str(s or "")).casefold()).replace("đ", "d")
    return "".join(c for c in s if not unicodedata.combining(c))


def _kw_re(words: list[str]) -> re.Pattern:
    alt = "|".join(r"\s+".join(map(re.escape, fold(w).split()))
                   for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alt})(?!\w)")


def load_scope(path: Path | None = None, sow_path: Path | None = None) -> dict:
    path = path or SCOPE_FILE
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        sow_path = sow_path or ROOT / doc["sow_file"]
        sow = unicodedata.normalize("NFC", Path(sow_path).read_bytes()
                                    .decode("utf-8").replace("\r\n", "\n"))
        rules = doc["rules"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ScopeError(f"luật SOW không đọc được ({type(e).__name__})") \
            from None
    if not isinstance(rules, list) or not rules:
        raise ScopeError("rules rỗng")
    seen, out = set(), []
    for i, r in enumerate(rules):
        rid = r.get("id") if isinstance(r, dict) else None
        if not isinstance(rid, str) or not _ID_RE.fullmatch(rid) \
                or rid in seen:
            raise ScopeError(f"rules[{i}].id: thiếu/sai/trùng")
        seen.add(rid)
        if r.get("label") not in LABELS:
            raise ScopeError(f"{rid}.label: phải {LABELS}")
        kws = r.get("keywords")
        if not isinstance(kws, list) or not kws or not all(
                isinstance(k, str) and k.strip() for k in kws):
            raise ScopeError(f"{rid}.keywords: rỗng")
        for k in ("sow_ref", "sow_quote"):
            if not isinstance(r.get(k), str) or not r[k].strip():
                raise ScopeError(f"{rid}.{k}: thiếu")
        if unicodedata.normalize("NFC", r["sow_quote"]) not in sow:
            raise ScopeError(f"{rid}.sow_quote: KHÔNG có nguyên văn trong "
                             "SOW — sửa trích dẫn")
        out.append({**r, "_re": _kw_re(kws)})
    return {"rules": out}


def classify(text: str, scope: dict) -> dict:
    """→ {suggestion, rule_id, sow_ref, sow_quote}. Thuần."""
    t = fold(str(text or "")[:MAX_TEXT])
    hits = [r for r in scope["rules"] if r["_re"].search(t)]
    pick = next((r for r in hits if r["label"] == "can_cr"), None) \
        or (hits[0] if hits else None)
    if pick is None:
        return {"suggestion": "chua_ro", "rule_id": None, "sow_ref": None,
                "sow_quote": None}
    return {"suggestion": pick["label"], "rule_id": pick["id"],
            "sow_ref": pick["sow_ref"], "sow_quote": pick["sow_quote"]}


def clean_request(text: str) -> str:
    """Mô tả yêu cầu: che SĐT/email + số tiền (agent không ghi giá)."""
    s = " ".join(str(text or "")[:MAX_TEXT].split())
    return _MONEY_RE.sub("[số tiền đã ẩn]", _mask_pii(s))


def draft_cr(text: str, result: dict) -> str:
    L = ["# Nháp yêu cầu thay đổi (CR) — GỢI Ý phân loại", "",
         "## Mô tả yêu cầu", "", clean_request(text) or "(trống)", "",
         f"## Gợi ý: {_LABEL_VN[result['suggestion']]}", ""]
    if result["rule_id"]:
        L += [f"- Luật: `{result['rule_id']}`",
              f"- Trích SOW ({result['sow_ref']}): \"{result['sow_quote']}\""]
    else:
        L.append("- Không khớp luật nào — TGĐ/GĐ dự án tự phân loại.")
    L += ["", "## Ước tính", "", "- Effort: chưa ước tính",
          f"- {PRICE_LINE}", "", COI_LINE, ""]
    return "\n".join(L)


def load_cases(path: Path) -> list[dict]:
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        cases = doc["cases"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ScopeError(f"bộ ca không đọc được ({type(e).__name__})") \
            from None
    if not isinstance(cases, list) or not cases or not all(
            isinstance(c, dict) and isinstance(c.get("text"), str)
            and c.get("expect") in (*LABELS, "chua_ro") for c in cases):
        raise ScopeError("bộ ca: cần list {text, expect}")
    return cases


def evaluate(cases: list[dict], scope: dict) -> tuple[float, list[str]]:
    miss = [f"{c.get('id', i)}: mong {c['expect']}, ra {got}"
            for i, c in enumerate(cases)
            if (got := classify(c["text"], scope)["suggestion"])
            != c["expect"]]
    return (len(cases) - len(miss)) / len(cases), miss


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_cr",
        description="DA-02 GỢI Ý phân loại CR theo SOW — TGĐ quyết, agent "
                    "không đặt giá")
    ap.add_argument("--classify", metavar="TEXT")
    ap.add_argument("--cr", metavar="TEXT")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--eval", action="store_true")
    ap.add_argument("--cases", type=Path, default=CASES_FILE)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    a = ap.parse_args(argv)
    n_ops = ((a.classify is not None) + (a.cr is not None) + a.eval
             + a.list)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --classify | --cr | --eval | --list")
    if a.submit and a.cr is None:
        ap.error("--submit chỉ dùng với --cr")
    for t in (a.classify, a.cr):
        if t is not None and not t.strip():
            ap.error("nội dung yêu cầu rỗng")
    scope = None
    if not a.list:
        try:
            scope = load_scope()
        except ScopeError as e:
            print(f"[error] cấu hình luật SOW lỗi: {e}", file=sys.stderr)
            return 1
    if a.classify is not None:
        r = classify(a.classify, scope)
        print(f"[goi-y] {r['suggestion']} — {_LABEL_VN[r['suggestion']]}"
              + (f" · luật {r['rule_id']} · {r['sow_ref']}: "
                 f"\"{r['sow_quote']}\"" if r["rule_id"] else ""))
        print(f"[note] {COI_LINE}")
        return 0
    if a.eval:
        try:
            cases = load_cases(a.cases)
        except ScopeError as e:
            print(f"[error] {e}", file=sys.stderr)
            return 1
        acc, miss = evaluate(cases, scope)
        for m in miss:
            print(f"  [miss] {m}")
        print(f"[eval] độ khớp {acc:.2f} trên {len(cases)} ca "
              f"(ngưỡng {THRESHOLD}) — MẪU dev — không phải nghiệm thu; bộ "
              "thật do TGĐ/Pháp chế gán nhãn")
        return 0 if acc >= THRESHOLD else 1
    if a.cr is not None:
        r = classify(a.cr, scope)
        text = draft_cr(a.cr, r)
        sha = hashlib.sha256(clean_request(a.cr).encode()).hexdigest()[:12]
        path = write_report(text, a.out_dir, f"da-cr-{sha}.md")
        print(f"[done] nháp CR ({r['suggestion']}) → {path}")
        g = guardrail.check(text)
        if g.get("ok") is not True:
            hits = sorted({f'{v.get("code")} "{_oneline(v.get("span"), 40)}"'
                           for v in g.get("violations") or ()})
            print(f"[warn] nháp CR trượt guardrail ({', '.join(hits)}) — mục"
                  " sẽ KHÔNG duyệt được; diễn đạt lại yêu cầu (vd 'chữa lỗi'"
                  " → 'sửa lỗi')" + (" — KHÔNG đẩy" if a.submit else ""),
                  file=sys.stderr)
            if a.submit:
                return 1
        if not a.submit:
            return 0
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.list:
            rows = conn.execute(
                "select id, object_id, title, status, created_at, decided_by"
                " from approval_queue where block = %s and object_type ="
                " 'change_request' order by id", (BLOCK,)).fetchall()
            conn.commit()
            for qid, oid, title, st, ts, by in rows:
                print(f"  #{qid} {oid} · {st} · {ts:%d/%m/%Y} · "
                      f"{_oneline(_mask_pii(title or ''), 70)}"
                      + (f" · quyết: {_oneline(_mask_pii(by), 40)}" if by else ""))
            print(f"[done] sổ CR: {len(rows)} mục (trạng thái = quyết định "
                  "TGĐ)")
            return 0
        try:
            qid = director.submit(
                conn, BLOCK, "change_request", object_id=f"cr:{sha}",
                title="CR: " + _oneline(clean_request(a.cr), 80),
                payload=text, created_by=CREATED_BY)
        except psycopg.errors.UniqueViolation:
            print("[warn] CR này đã có mục đang chờ duyệt", file=sys.stderr)
            return 1
        print(f"[done] đã đẩy CR mục #{qid} (PENDING — TGĐ quyết)")
        return 0
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
