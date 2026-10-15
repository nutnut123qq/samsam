"""v6.5 MKT-11 — SEO sàn: gợi ý từ khóa tiêu đề/thuộc tính listing Shopee/
TikTok Shop từ listing hiện tại (`market_rows` v3.3) + Google Trends xuất tay
(`trends_related` v7.2) → nháp listing `pending` (flow v6.1). KHÔNG sửa sàn,
KHÔNG gọi API sàn, 0 LLM, 0 mạng.

Contract:
  - `suggest(sku, channel, current_title, related, *, rules, listing_rules,
    readiness=None)` THUẦN (0 DB/mạng):
      * `content.precheck(sku, channel, "listing")` từ chối (rượu `ruou`,
        readiness, SKU/kênh lạ) → `{"refused": {...}}`, 0 gợi ý.
      * Ứng viên = dòng `related` có `seed` ∈ `seo_rules.san.default_seeds`
        ∪ `sku_seeds[sku]`; loại khi `'ruou' in flags` hoặc
        `kb_filter.is_alcohol(query)` (code `ruou`); mỗi từ khóa còn lại giữ
        CHỈ KHI `guardrail.check_publish(content._with_required("Từ khóa:
        <q>"), channel, content_type="listing", sku)` ok — bị loại kèm code
        (vd "sâm ngọc linh" → `ngoc_linh_chua_xac_nhan`).
      * Thứ tự tất định: `top` theo value số giảm dần, rồi `rising`
        (Breakout > +% giảm dần); hòa → query (NFC casefold).
      * Bỏ từ khóa đã có trong tiêu đề gốc (NFC casefold). Tiêu đề gốc =
        tiêu đề hiện tại trên sàn; chưa có listing / vượt `title_max` → tên
        golden (ghi lý do). Nối từ khóa (`san.title_sep`) khi còn vừa
        `title_max` của `data/listing_rules.json` (GIẢ ĐỊNH). Danh sách từ
        khóa ≤ `keywords_max` (gồm `brand_keywords`).
      * Toàn văn cuối qua `check_publish` lần nữa — không ok → `failed` +
        codes, KHÔNG ghi.
  - `run(conn, skus, channels, *, dry_run, now)`: tiêu đề hiện tại = snapshot
    `listing` MỚI NHẤT mỗi kênh (`market_rows.sku_key`, row_no nhỏ nhất);
    `trends_related` của import mới nhất mỗi seed. Không dry-run →
    `store.save_draft(..., created_by="agent:MKT-11", content_type=
    "listing", prompt_version="seo-san-v1", prompt_sha256=sha256(
    seo_rules.json))`; đã có nháp sống (`content._existing`) hoặc
    `UniqueViolation` → `skipped`. Báo cáo `data/reports/seo-san-<ngày VN>.md`
    (từ khóa bị loại chỉ in CODE + số lượng, không trích).

Chạy:
  python -m agents.seo_san --run [--dry-run] [--sku all|K]
                           [--channel shopee|tiktok ...]
Exit: 0 ok · 1 có `failed` / lỗi luật / DB lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from agents.seo_web import RULES_PATH, SeoRulesError, load_rules
from ingest.lead_store import connect
from pipelines import content, guardrail, kb_filter, store
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

AGENT = "agent:MKT-11"
PROMPT_VERSION = "seo-san-v1"
CHANNELS = ("shopee", "tiktok")
_PCT_RE = re.compile(r"\+?([0-9]{1,9})%")


def _key(s: str) -> str:
    return unicodedata.normalize("NFC", s).casefold().strip()


def rules_sha256(path=None) -> str:
    """sha256 file luật (CRLF→LF — checkout Windows/Linux cùng giá trị)."""
    p = Path(path) if path is not None else RULES_PATH
    return hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _rank(row: dict) -> tuple:
    """top (value số giảm dần) → rising (Breakout, +% giảm dần) → query."""
    v = str(row.get("value") or "").strip().replace(",", "")
    if row.get("section") == "top":
        n = int(v) if v.isdigit() else -1
        return (0, -n, _key(row["query"]))
    if v.casefold() == "breakout":
        return (1, -10**12, _key(row["query"]))
    m = _PCT_RE.fullmatch(v)
    return (1, -int(m.group(1)) if m else 1, _key(row["query"]))


def _codes(res: dict) -> list[str]:
    return sorted({str(v.get("code") or v.get("type") or "?")
                   for v in res.get("violations") or []
                   if isinstance(v, dict)})


def _publish(text, sku, channel, readiness) -> dict:
    full = content._with_required(text, channel=channel,
                                  content_type="listing", sku=sku,
                                  readiness=readiness)
    res = guardrail.check_publish(full, channel=channel,
                                  content_type="listing", sku=sku,
                                  is_ai=True, readiness=readiness)
    return {"text": full, "guardrail": res}


def _empty(sku, channel) -> dict:
    return {"sku": sku, "channel": channel, "refused": None, "failed": None,
            "title": None, "base_title": None, "title_reason": None,
            "added": [], "keywords": [], "rejected": [], "already": [],
            "text": None, "guardrail": None}


def suggest(sku, channel, current_title, related, *, rules: dict,
            listing_rules: dict, readiness=None) -> dict:
    """THUẦN — xem docstring module."""
    out = _empty(sku, channel)
    ref = content.precheck(sku, channel, "listing", readiness=readiness)
    if ref:
        out["refused"] = ref
        return out
    san = rules["san"]
    lim = listing_rules["channels"][channel]
    seeds = {_key(s) for s in [*san["default_seeds"],
                               *san["sku_seeds"].get(sku, [])]}
    cands, seen = [], set()
    for r in related or []:
        q = r.get("query") if isinstance(r, dict) else None
        if not isinstance(q, str) or not q.strip() \
                or _key(str(r.get("seed") or "")) not in seeds:
            continue
        q = " ".join(q.split())
        if _key(q) in seen:
            continue
        seen.add(_key(q))
        flags = r.get("flags") or []
        if "ruou" in flags or kb_filter.is_alcohol(q):
            out["rejected"].append({"query": q, "codes": ["ruou"]})
            continue
        res = _publish(f"Từ khóa: {q}", sku, channel, readiness)["guardrail"]
        if res.get("ok") is not True:
            out["rejected"].append({"query": q, "codes": _codes(res)})
            continue
        cands.append({**r, "query": q})
    cands.sort(key=_rank)
    out["rejected"].sort(key=lambda x: _key(x["query"]))

    cfg, _ = content._cfg()
    name = cfg["golden"][sku]["name"]
    cur = " ".join(current_title.split()) \
        if isinstance(current_title, str) else ""
    if not cur:
        base, reason = name, "chưa có listing trên sàn — dùng tên golden"
    elif len(cur) > lim["title_max"]:
        base, reason = name, (f"tiêu đề hiện tại {len(cur)} ký tự > "
                              f"title_max {lim['title_max']} — dùng tên golden")
    else:
        base, reason = cur, "tiêu đề hiện tại trên sàn"
    title, kws = base, []
    for c in cands:
        q = c["query"]
        if _key(q) in _key(base):
            out["already"].append(q)
            continue
        kws.append(q)
        cand = f"{title}{san['title_sep']}{q}"
        if len(cand) <= lim["title_max"]:
            title = cand
            out["added"].append(q)
    keywords, kseen = [], set()
    for k in [*listing_rules["brand_keywords"], *kws]:
        if _key(k) not in kseen:
            kseen.add(_key(k))
            keywords.append(k)
    keywords = keywords[:lim["keywords_max"]]
    pub = _publish(f"{title}\nTừ khóa: {', '.join(keywords)}", sku, channel,
                   readiness)
    out.update(title=title, base_title=base, title_reason=reason,
               keywords=keywords, text=pub["text"],
               guardrail=pub["guardrail"])
    if pub["guardrail"].get("ok") is not True:
        out["failed"] = {"codes": _codes(pub["guardrail"])}
    return out


_RELATED_SQL = (
    "select tr.seed, tr.section, tr.query, tr.value, tr.flags"
    " from trends_related tr where tr.import_id = (select max(t2.import_id)"
    " from trends_related t2 where t2.seed = tr.seed) order by tr.id")
_TITLE_SQL = (
    "select r.title from market_rows r where r.snapshot_id = (select s.id"
    " from market_snapshots s where s.channel = %s and s.export_kind ="
    " 'listing' order by s.imported_at desc, s.id desc limit 1)"
    " and r.sku_key = %s and r.title is not null order by r.row_no limit 1")


def load_related(conn) -> list[dict]:
    return [{"seed": s, "section": sec, "query": q, "value": v,
             "flags": list(f or [])}
            for s, sec, q, v, f in conn.execute(_RELATED_SQL).fetchall()]


def current_title(conn, sku: str, channel: str):
    row = conn.execute(_TITLE_SQL, (channel, sku)).fetchone()
    return row[0] if row else None


def run(conn, skus, channels, *, dry_run: bool, now=None, rules=None,
        readiness=None) -> list[dict]:
    """→ [{"sku", "channel", "status", ...}] created|skipped|dry_run|
    refused|failed. Chỉ ghi nháp pending qua store.save_draft."""
    rules = rules if rules is not None else load_rules()
    lrules, err = content._listing_rules()
    if err:
        raise ValueError(err)
    if readiness is None:
        readiness = store.readiness_from_db(conn)
    related = load_related(conn)
    sha = rules_sha256()
    out = []
    for sku in dict.fromkeys(skus):
        for ch in dict.fromkeys(channels):
            s = suggest(sku, ch, current_title(conn, sku, ch), related,
                        rules=rules, listing_rules=lrules,
                        readiness=readiness)
            item = {"sku": sku, "channel": ch, "suggestion": s}
            if s["refused"]:
                out.append({**item, "status": "refused", **s["refused"]})
                continue
            if s["failed"]:
                out.append({**item, "status": "failed", **s["failed"]})
                continue
            if dry_run:
                out.append({**item, "status": "dry_run"})
                continue
            did = content._existing(conn, sku, ch, PROMPT_VERSION)
            if did is not None:
                out.append({**item, "status": "skipped", "id": did})
                continue
            try:
                did = store.save_draft(
                    conn, f"seo-san {sku} {ch}", ch, s["text"],
                    s["guardrail"], store.SOURCE_CLI, created_by=AGENT,
                    content_type="listing", sku=sku, is_ai=True,
                    prompt_version=PROMPT_VERSION, prompt_sha256=sha)
            except psycopg.errors.UniqueViolation:
                out.append({**item, "status": "skipped",
                            "id": content._existing(conn, sku, ch,
                                                    PROMPT_VERSION)})
                continue
            out.append({**item, "status": "created", "id": did})
    return out


def _cell(v) -> str:
    return ("" if v is None else str(v)).replace("|", "\\|") \
        .replace("\n", " ")


def render(day: str, items: list[dict], dry_run: bool) -> str:
    L = [f"# Gợi ý SEO tiêu đề listing sàn — {day}", "",
         ("> **BẢN NHÁP** — gợi ý thành nháp listing `pending` (người duyệt "
          "rồi sửa TAY trên Seller Center). Agent KHÔNG sửa sàn/không gọi API "
          "sàn. Giới hạn ký tự `data/listing_rules.json` và seed "
          "`data/seo_rules.json` là GIẢ ĐỊNH; Google Trends xuất tay."
          + (" **Chạy thử (--dry-run): không ghi DB.**" if dry_run else "")),
         "", ("| SKU | Kênh | Trạng thái | Tiêu đề đề xuất | Từ khóa thêm "
              "| Bị loại (code) |"), "|---|---|---|---|---|---|"]
    for it in items:
        s = it["suggestion"]
        st = it["status"] + (f" #{it['id']}" if it.get("id") else "")
        if it["status"] == "refused":
            st += f" `{it['code']}`"
        elif it["status"] == "failed":
            st += " " + ", ".join(f"`{c}`" for c in it["codes"])
        rej: dict[str, int] = {}
        for r in s["rejected"]:
            for c in r["codes"]:
                rej[c] = rej.get(c, 0) + 1
        L.append(f"| {it['sku']} | {it['channel']} | {st} | "
                 f"{_cell(s['title'])} | {_cell(', '.join(s['added']))} | "
                 + _cell(", ".join(f"{k}×{v}" for k, v in sorted(
                     rej.items()))) + " |")
    L += ["", "---", "*Sinh tự động bởi `python -m agents.seo_san` — 0 LLM.*",
          ""]
    return "\n".join(L)


def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.seo_san",
        description="Gợi ý từ khóa tiêu đề listing sàn (Trends xuất tay) → "
                    "nháp listing pending — không sửa sàn")
    ap.add_argument("--run", action="store_true", help="chạy gợi ý")
    ap.add_argument("--dry-run", action="store_true",
                    help="không ghi nháp (0 INSERT)")
    ap.add_argument("--sku", default="all", help="all | sku_key")
    ap.add_argument("--channel", action="append", choices=CHANNELS,
                    help="kênh (lặp được; mặc định shopee + tiktok)")
    ap.add_argument("--out-dir", default=str(REPORTS_DIR))
    args = ap.parse_args(argv)
    if not args.run:
        ap.error("cần --run")
    try:
        rules = load_rules()
    except SeoRulesError as e:
        print(f"[error] seo_rules.json: {e}", file=sys.stderr)
        return 1
    cfg, err = content._cfg()
    if err:
        print(f"[error] cấu hình guardrail/golden: {err}", file=sys.stderr)
        return 1
    skus = sorted(cfg["golden"]) if args.sku == "all" else [args.sku]
    channels = args.channel or list(CHANNELS)
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres", file=sys.stderr)
        return 2
    try:
        items = run(conn, skus, channels, dry_run=args.dry_run, rules=rules)
    except (psycopg.Error, ValueError) as e:
        print(f"[error] {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    day = (now or datetime.now(VN_TZ)).astimezone(VN_TZ).strftime("%Y-%m-%d")
    path = write_report(render(day, items, args.dry_run), Path(args.out_dir),
                        f"seo-san-{day}.md")
    cnt: dict[str, int] = {}
    for it in items:
        cnt[it["status"]] = cnt.get(it["status"], 0) + 1
    print(f"[done] {path} — " + " ".join(
        f"{k}={v}" for k, v in sorted(cnt.items())), flush=True)
    return 1 if cnt.get("failed") else 0


if __name__ == "__main__":
    with job_run("agents.seo_san") as run_rec:
        rc = main()
        run_rec["ok"] = rc == 0
    raise SystemExit(rc)
