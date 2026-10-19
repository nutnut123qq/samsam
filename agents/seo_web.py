"""v6.5 MKT-10 — rà SEO website CỦA CHÍNH CÔNG TY (chỉ đọc) → báo cáo + nháp
đề xuất sửa vào hàng duyệt khối marketing.

Contract:
  - Phạm vi: CHỈ host trong `data/seo_rules.json` `web.own_hosts`
    (samsam.net.vn, samsamngoclinh.com — khớp host chính xác hoặc đuôi
    "." + host; `evilsamsam.net.vn` KHÔNG khớp). URL ngoài → bỏ + đếm.
  - `--from-crawl` (mặc định, 0 request mạng): đọc dữ liệu đã crawl
    `data/{products,articles,news,about}.jsonl` (crawler/collect.py; BYTES +
    split `\\n`, dòng hỏng/`_doc` bỏ + đếm). Kiểm: tiêu đề NỘI DUNG
    (title/name — KHÔNG phải thẻ `<title>`) thiếu / trùng (NFC casefold
    strip, trong cùng host) / dài > `title_max`; sản phẩm không có ảnh; nội
    dung hoặc slug URL vi phạm `guardrail.check` → CODE vi phạm (không trích
    đoạn). Meta description/H1/alt/link gãy: dữ liệu crawl không có HTML thô
    → "chưa kiểm — cần --fetch".
  - `--fetch [--max-requests N]`: URL lấy từ chính các jsonl (own_hosts,
    sort, dedupe) → GET qua `crawler.intel.Fetcher` (robots.txt, ≥1s/host,
    ngân sách N, log `[req]`; redirect ra ngoài own_hosts bị chặn) — module
    này KHÔNG import http client. Parse `bs4` `html.parser`: `<title>`
    thiếu/trùng/dài, meta description thiếu/ngắn/dài/trùng, số H1 ≠ 1,
    `<img>` thiếu/rỗng alt, link nội bộ trỏ URL đã GET trong lượt trả
    404/410 = gãy (chưa GET = "chưa kiểm", đếm). Non-2xx / robots cấm / hết
    ngân sách → ghi trạng thái, không crash.
  - Output `data/reports/seo-web-<YYYY-MM-DD giờ VN>.md` (ngày từ `now`
    tham số; ghi qua `agents.report.write_report` — atomic, BYTES).
  - `--submit` (chỉ khi có vấn đề): 1 mục `approval_queue` khối marketing
    loại `seo_web_fix` qua `pipelines.director.submit`, object_id
    `seo-web:<ngày>:<sha256(payload)[:16]>`, created_by `agent:MKT-10`.
    Payload CHỈ URL + code vấn đề + đề xuất (không trích text vi phạm; URL có
    slug bị guardrail chặn → thay bằng mã băm). Payload không qua
    `guardrail.check` → KHÔNG submit (fail-closed). Trùng mục pending →
    skipped. Người sửa website TAY trên CMS sau khi duyệt — agent KHÔNG có
    đường ghi website.
  - 0 LLM. Print tiếng Việt có UTF-8 guard; DB qua `ingest.lead_store.connect`
    (connect_timeout); CLI nhiều chế độ → exit 2 TRƯỚC connect.

Chạy:
  python -m agents.seo_web [--from-crawl] [--submit] [--out-dir DIR]
  python -m agents.seo_web --fetch [--max-requests N] [--submit]
Exit: 0 ok · 1 lỗi luật/DB/payload không qua guardrail · 2 tham số sai.
"""

import argparse
import hashlib
import json
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import psycopg
from bs4 import BeautifulSoup

from agents.report import REPORTS_DIR, write_report
from crawler.intel import BlockedDomain, BudgetExhausted, Fetcher
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RULES_PATH = DATA_DIR / "seo_rules.json"
CRAWL_FILES = ("products", "articles", "news", "about")
AGENT = "agent:MKT-10"
OBJECT_TYPE = "seo_web_fix"
SOURCE = "seo_web"
MAX_PAYLOAD_ISSUES = 300
BROKEN = (404, 410)

SUGGEST = {
    "title_thieu": "bổ sung tiêu đề nội dung",
    "title_trung": "đặt tiêu đề riêng cho từng trang",
    "title_dai": "rút gọn tiêu đề về ≤ title_max ký tự",
    "sp_khong_anh": "thêm ảnh sản phẩm (packshot thật)",
    "guardrail": "sửa nội dung theo luật TPBVSK (Pháp chế duyệt) — xem code",
    "url_guardrail": "đổi slug URL không chứa cụm bị cấm (giữ redirect 301)",
    "html_title_thieu": "thêm thẻ <title>",
    "html_title_trung": "đặt <title> riêng cho từng trang",
    "html_title_dai": "rút gọn <title> về ≤ title_max ký tự",
    "meta_desc_thieu": "thêm meta description desc_min–desc_max ký tự",
    "meta_desc_ngan": "viết dài thêm meta description (≥ desc_min ký tự)",
    "meta_desc_dai": "rút gọn meta description (≤ desc_max ký tự)",
    "meta_desc_trung": "viết meta description riêng cho từng trang",
    "h1_khong_bang_1": "mỗi trang đúng 1 thẻ H1",
    "img_thieu_alt": "bổ sung alt mô tả ảnh",
    "link_gay": "sửa/bỏ link nội bộ trỏ trang 404/410",
    "trang_loi": "kiểm tra trang trả mã lỗi",
}


class SeoRulesError(ValueError):
    """data/seo_rules.json thiếu/hỏng/sai luật."""


def _int_in(v, lo, hi) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def load_rules(path=None) -> dict:
    """→ doc đã validate (web + san). Lỗi → SeoRulesError."""
    p = Path(path) if path is not None else RULES_PATH
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise SeoRulesError(f"{p.name} hỏng/thiếu: {type(e).__name__}") \
            from e
    web = doc.get("web") if isinstance(doc, dict) else None
    if not isinstance(web, dict):
        raise SeoRulesError("thiếu object 'web'")
    hosts = web.get("own_hosts")
    if not (isinstance(hosts, list) and hosts and all(
            isinstance(h, str) and h.strip() and "/" not in h
            for h in hosts)):
        raise SeoRulesError("web.own_hosts phải list host khác rỗng")
    for k, lo, hi in (("title_max", 10, 500), ("desc_min", 1, 1000),
                      ("desc_max", 1, 2000), ("max_requests", 1, 200)):
        if not _int_in(web.get(k), lo, hi):
            raise SeoRulesError(f"web.{k} phải số nguyên {lo}..{hi}")
    if web["desc_min"] > web["desc_max"]:
        raise SeoRulesError("web.desc_min > desc_max")
    san = doc.get("san")
    if not isinstance(san, dict):
        raise SeoRulesError("thiếu object 'san'")
    seeds = san.get("default_seeds")
    if not (isinstance(seeds, list)
            and all(isinstance(x, str) and x.strip() for x in seeds)):
        raise SeoRulesError("san.default_seeds phải list chuỗi")
    ss = san.get("sku_seeds")
    if not (isinstance(ss, dict) and all(
            isinstance(v, list) and all(isinstance(x, str) for x in v)
            for v in ss.values())):
        raise SeoRulesError("san.sku_seeds phải {sku: [seed]}")
    if not (isinstance(san.get("title_sep"), str) and san["title_sep"]):
        raise SeoRulesError("san.title_sep phải chuỗi khác rỗng")
    web["own_hosts"] = [h.strip().lower().rstrip(".") for h in hosts]
    return doc


def is_own(host, own_hosts) -> bool:
    """Host chính xác hoặc subdomain ('.' + host) của website công ty."""
    if not isinstance(host, str) or not host:
        return False
    h = host.strip().lower().rstrip(".")
    return any(h == o or h.endswith("." + o) for o in own_hosts)


def _host(url) -> str:
    try:
        return (urlsplit(url).hostname or "") if isinstance(url, str) else ""
    except ValueError:
        return ""


def _key(s: str) -> str:
    return unicodedata.normalize("NFC", s).casefold().strip()


def _norm_url(url: str) -> str:
    """So link: scheme/host thường, bỏ fragment, path rỗng → '/'."""
    try:
        u = urlsplit(url)
    except ValueError:
        return url
    return urlunsplit((u.scheme.lower(), u.netloc.lower(), u.path or "/",
                       u.query, ""))


def read_crawl(data_dir: Path, own_hosts) -> tuple[list[dict], dict]:
    """jsonl đã crawl → (records own-host, stats). 0 request mạng."""
    stats = {"files": 0, "bad": 0, "external": 0, "no_url": 0}
    recs = []
    for name in CRAWL_FILES:
        p = Path(data_dir) / f"{name}.jsonl"
        if not p.exists():
            continue
        stats["files"] += 1
        for line in p.read_bytes().split(b"\n"):
            if not line.strip():
                continue
            try:
                r = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                stats["bad"] += 1
                continue
            if not isinstance(r, dict) or "_doc" in r:
                stats["bad"] += 1
                continue
            url = r.get("url")
            if not isinstance(url, str) or not url.strip():
                stats["no_url"] += 1
                continue
            if not is_own(_host(url), own_hosts):
                stats["external"] += 1
                continue
            title = r.get("title") if name != "products" else r.get("name")
            body = r.get("body") if name != "products" \
                else r.get("description")
            recs.append({"kind": name, "url": url.strip(),
                         "title": title if isinstance(title, str) else "",
                         "body": body if isinstance(body, str) else "",
                         "images": r.get("images")})
    return recs, stats


def _issue(url, code, detail=None) -> dict:
    return {"url": url, "code": code, "detail": detail}


def _gr_codes(res: dict) -> tuple[list, list]:
    """(codes, types) của violations — KHÔNG trích span/detail."""
    viols = res.get("violations") or []
    codes = sorted({str(v.get("code") or v.get("type") or "?")
                    for v in viols if isinstance(v, dict)})
    types = sorted({str(v.get("type") or "?")
                    for v in viols if isinstance(v, dict)})
    return codes, types


def _dup_titles(items, code, out) -> None:
    """items [(url, title)] → issue trùng (NFC casefold) trong cùng host."""
    seen: dict[tuple, list] = {}
    for url, t in items:
        if t and t.strip():
            seen.setdefault((_host(url).lower(), _key(t)), []).append(url)
    for urls in seen.values():
        if len(urls) > 1:
            for u in urls:
                out.append(_issue(u, code, {"so_trang": len(urls)}))


def audit_crawl(records: list[dict], web: dict) -> list[dict]:
    """Rà dữ liệu đã crawl (thuần) → list issue {url, code, detail}."""
    out = []
    tmax = web["title_max"]
    for r in records:
        t = r["title"].strip()
        if not t:
            out.append(_issue(r["url"], "title_thieu"))
        elif len(t) > tmax:
            out.append(_issue(r["url"], "title_dai", {"ky_tu": len(t)}))
        if r["kind"] == "products" and not (
                isinstance(r["images"], list) and any(
                    isinstance(x, str) and x.strip() for x in r["images"])):
            out.append(_issue(r["url"], "sp_khong_anh"))
        res = guardrail.check(f"{t}\n{r['body']}")
        if res.get("ok") is not True:
            codes, types = _gr_codes(res)
            out.append(_issue(r["url"], "guardrail",
                              {"codes": codes, "types": types}))
        ures = guardrail.check(r["url"])
        if ures.get("ok") is not True:
            codes, types = _gr_codes(ures)
            out.append(_issue(r["url"], "url_guardrail",
                              {"codes": codes, "types": types}))
    _dup_titles([(r["url"], r["title"]) for r in records], "title_trung", out)
    return out


def crawl_urls(records: list[dict]) -> list[str]:
    return sorted({r["url"] for r in records})


class OwnFetcher(Fetcher):
    """Fetcher chỉ cho phép host website công ty — kể cả hop redirect
    (redirect ra host lạ → BlockedDomain, không GET)."""

    def __init__(self, own_hosts, **kw):
        super().__init__(**kw)
        self.own_hosts = list(own_hosts)

    def _check(self, url, source):
        u, host = super()._check(url, source)
        if not is_own(host, self.own_hosts):
            self.blocked += 1
            self.log(f"[blocked] {SOURCE}: host ngoài own_hosts — bỏ")
            raise BlockedDomain(host)
        return u, host


def parse_page(url: str, body: bytes, own_hosts) -> dict:
    """HTML → {title, desc, h1, img_no_alt, links (nội bộ, đã chuẩn hóa)}."""
    soup = BeautifulSoup(body, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    desc = None
    for m in soup.find_all("meta"):
        if str(m.get("name") or "").strip().lower() == "description":
            desc = str(m.get("content") or "").strip()
            break
    imgs = soup.find_all("img")
    links = set()
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith(("#", "mailto:", "tel:",
                                        "javascript:")):
            continue
        try:
            full = urljoin(url, href)
        except ValueError:
            continue
        if urlsplit(full).scheme in ("http", "https") \
                and is_own(_host(full), own_hosts):
            links.add(_norm_url(full))
    return {"title": title, "desc": desc, "h1": len(soup.find_all("h1")),
            "img_no_alt": sum(1 for i in imgs
                              if not str(i.get("alt") or "").strip()),
            "img_total": len(imgs), "links": sorted(links)}


def fetch_audit(urls: list[str], web: dict, fetcher) -> tuple[list, dict]:
    """GET tuần tự qua Fetcher → (issues, stats). Không crash vì mạng."""
    issues, pages, status = [], {}, {}
    stats = {"urls": len(urls), "ok": 0, "non_2xx": 0, "robots_cam": 0,
             "loi": 0, "blocked": 0, "het_ngan_sach": 0, "link_chua_kiem": 0}
    for i, url in enumerate(urls):
        deny0 = fetcher.robots_deny
        try:
            r = fetcher.fetch(url, SOURCE)
        except BlockedDomain:
            stats["blocked"] += 1
            continue
        except BudgetExhausted:
            stats["het_ngan_sach"] = len(urls) - i
            break
        if r is None:
            stats["robots_cam" if fetcher.robots_deny > deny0 else "loi"] += 1
            continue
        status[_norm_url(url)] = r.status
        if not (isinstance(r.status, int) and 200 <= r.status < 300) \
                or r.body is None:
            stats["non_2xx"] += 1
            issues.append(_issue(url, "trang_loi", {"status": r.status}))
            continue
        stats["ok"] += 1
        pages[url] = parse_page(url, r.body, web["own_hosts"])
    for url, p in pages.items():
        t = p["title"]
        if not t:
            issues.append(_issue(url, "html_title_thieu"))
        elif len(t) > web["title_max"]:
            issues.append(_issue(url, "html_title_dai", {"ky_tu": len(t)}))
        d = p["desc"]
        if not d:
            issues.append(_issue(url, "meta_desc_thieu"))
        elif len(d) < web["desc_min"]:
            issues.append(_issue(url, "meta_desc_ngan", {"ky_tu": len(d)}))
        elif len(d) > web["desc_max"]:
            issues.append(_issue(url, "meta_desc_dai", {"ky_tu": len(d)}))
        if p["h1"] != 1:
            issues.append(_issue(url, "h1_khong_bang_1", {"h1": p["h1"]}))
        if p["img_no_alt"]:
            issues.append(_issue(url, "img_thieu_alt",
                                 {"anh": p["img_no_alt"],
                                  "tong": p["img_total"]}))
        for link in p["links"]:
            st = status.get(link)
            if st is None:
                stats["link_chua_kiem"] += 1
            elif st in BROKEN:
                issues.append(_issue(url, "link_gay",
                                     {"toi": link, "status": st}))
    _dup_titles([(u, p["title"]) for u, p in pages.items()],
                "html_title_trung", issues)
    _dup_titles([(u, p["desc"] or "") for u, p in pages.items()],
                "meta_desc_trung", issues)
    return issues, stats


def _safe_url(url: str) -> str:
    """URL có slug bị guardrail chặn → mã băm (payload hàng duyệt phải qua
    guardrail; URL đầy đủ nằm trong file báo cáo)."""
    if guardrail.check(url).get("ok") is True:
        return url
    return f"[url {hashlib.sha256(url.encode()).hexdigest()[:12]} — xem báo cáo]"


def build_payload(day: str, mode: str, issues: list[dict]) -> str:
    """Payload hàng duyệt: URL + code + đề xuất (không trích text)."""
    items = []
    for it in issues[:MAX_PAYLOAD_ISSUES]:
        det = it["detail"]
        if isinstance(det, dict) and "toi" in det:
            det = {**det, "toi": _safe_url(det["toi"])}
        items.append({"url": _safe_url(it["url"]), "code": it["code"],
                      "chi_tiet": det, "de_xuat": SUGGEST[it["code"]]})
    return json.dumps({"ngay": day, "che_do": mode, "so_van_de": len(issues),
                       "van_de": items,
                       "ghi_chu": "Người sửa website TAY trên CMS sau khi "
                                  "duyệt — agent không có quyền ghi."},
                      ensure_ascii=False, sort_keys=True)


def _cell(v) -> str:
    if isinstance(v, dict):
        v = ", ".join(f"{k}={'/'.join(x) if isinstance(x, list) else x}"
                      for k, x in sorted(v.items()))
    return ("" if v is None else str(v)).replace("|", "\\|") \
        .replace("\n", " ")


def render(day: str, mode: str, issues: list[dict], stats: dict,
           web: dict) -> str:
    counts: dict[str, int] = {}
    for it in issues:
        counts[it["code"]] = counts.get(it["code"], 0) + 1
    L = [f"# Rà SEO website công ty — {day}", "",
         (f"**Chế độ:** `{mode}` · **Nguồn:** `agents/seo_web.py` · host: "
          + ", ".join(f"`{h}`" for h in web["own_hosts"])), "",
         ("> **BẢN NHÁP — chỉ đọc.** Agent KHÔNG sửa website; người sửa TAY "
          "trên CMS sau khi GĐ Marketing duyệt. Ngưỡng `data/seo_rules.json` "
          "là GIẢ ĐỊNH chờ MKT/SEO chốt. Search Console/GA4 chờ bàn giao "
          "(external-dep)."), "",
         "## Thống kê", "",
         "- " + " · ".join(f"{k}={v}" for k, v in sorted(stats.items())),
         "- Vấn đề theo loại: " + (" · ".join(
             f"`{k}` {v}" for k, v in sorted(counts.items())) or "không có")]
    if mode == "from-crawl":
        L.append("- Tiêu đề ở đây là tiêu đề NỘI DUNG (title/name đã crawl),"
                 " không phải thẻ `<title>`. Meta description / H1 / alt ảnh"
                 " / link gãy: **chưa kiểm — cần `--fetch`**.")
    L += ["", "## Vấn đề + đề xuất sửa", ""]
    if not issues:
        L.append("- Không phát hiện vấn đề.")
    else:
        L += ["| URL | Vấn đề | Chi tiết | Đề xuất |", "|---|---|---|---|"]
        for it in sorted(issues, key=lambda x: (x["code"], x["url"])):
            L.append(f"| {_cell(it['url'])} | `{it['code']}` | "
                     f"{_cell(it['detail'])} | {SUGGEST[it['code']]} |")
    L += ["", "---", ("*Sinh tự động bởi `python -m agents.seo_web` — "
                      "kiểm chứng trước khi sửa.*"), ""]
    return "\n".join(L)


def submit(conn, day: str, mode: str, issues: list[dict]) -> dict:
    """1 mục hàng duyệt khối marketing. Trùng pending → skipped; payload
    không qua guardrail → refused (không ghi)."""
    payload = build_payload(day, mode, issues)
    g = guardrail.check(payload)
    if g.get("ok") is not True:
        return {"status": "refused", "codes": _gr_codes(g)[0]}
    oid = f"seo-web:{day}:{hashlib.sha256(payload.encode()).hexdigest()[:16]}"
    title = f"Đề xuất sửa SEO website {day} — {len(issues)} vấn đề ({mode})"
    try:
        qid = director.submit(conn, "marketing", OBJECT_TYPE, oid, title,
                              payload, created_by=AGENT)
    except psycopg.errors.UniqueViolation:
        return {"status": "skipped", "object_id": oid}
    return {"status": "created", "id": qid, "object_id": oid}


def run(*, mode: str, data_dir: Path = DATA_DIR, rules=None,
        max_requests=None, fetcher_factory=None, now=None) -> dict:
    """Rà (không ghi DB) → {"day", "mode", "issues", "stats", "text"}."""
    rules = rules if rules is not None else load_rules()
    web = rules["web"]
    now = now or datetime.now(VN_TZ)
    day = now.astimezone(VN_TZ).strftime("%Y-%m-%d")
    records, stats = read_crawl(data_dir, web["own_hosts"])
    if mode == "fetch":
        n = max_requests if max_requests is not None else web["max_requests"]
        factory = fetcher_factory or (lambda budget: OwnFetcher(
            web["own_hosts"], budget=budget))
        with factory(n) as f:
            issues, fstats = fetch_audit(crawl_urls(records), web, f)
            fstats["requests"] = f.used
        stats = {**stats, **fstats}
    else:
        issues = audit_crawl(records, web)
        stats["requests"] = 0
    stats["pages"] = len(records)
    return {"day": day, "mode": mode, "issues": issues, "stats": stats,
            "text": render(day, mode, issues, stats, web)}


def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.seo_web",
        description="Rà SEO website công ty (chỉ đọc) → báo cáo + nháp "
                    "đề xuất sửa vào hàng duyệt khối marketing")
    ap.add_argument("--from-crawl", action="store_true",
                    help="dùng dữ liệu đã crawl (mặc định, 0 request)")
    ap.add_argument("--fetch", action="store_true",
                    help="GET trang qua collector (robots + ≥1s/host)")
    ap.add_argument("--max-requests", type=int, default=None,
                    help="ngân sách request cho --fetch (1..200)")
    ap.add_argument("--submit", action="store_true",
                    help="đẩy 1 mục đề xuất vào hàng duyệt khối marketing")
    ap.add_argument("--out-dir", default=str(REPORTS_DIR))
    args = ap.parse_args(argv)
    n_ops = int(args.from_crawl) + int(args.fetch)
    if n_ops > 1:
        ap.error("chỉ chọn 1 chế độ: --from-crawl HOẶC --fetch")
    if args.max_requests is not None:
        if not args.fetch:
            ap.error("--max-requests chỉ đi với --fetch")
        if not 1 <= args.max_requests <= 200:
            ap.error("--max-requests phải 1..200")
    try:
        rules = load_rules()
    except SeoRulesError as e:
        print(f"[error] seo_rules.json: {e}", file=sys.stderr)
        return 1
    mode = "fetch" if args.fetch else "from-crawl"
    res = run(mode=mode, rules=rules, max_requests=args.max_requests,
              now=now)
    # P8.4: rà site công khai của công ty (crawl/fetch thật).
    path = write_report(res["text"], Path(args.out_dir),
                        f"seo-web-{res['day']}.md", sample=False)
    print(f"[done] {path} — {mode} vấn đề={len(res['issues'])} "
          f"requests={res['stats']['requests']}", flush=True)
    if not args.submit:
        return 0
    if not res["issues"]:
        print("[skip] không có vấn đề — không submit", flush=True)
        return 0
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres — chưa submit",
              file=sys.stderr)
        return 1
    try:
        out = submit(conn, res["day"], mode, res["issues"])
    except psycopg.Error as e:
        print(f"[error] lỗi DB ({type(e).__name__}) — chưa submit",
              file=sys.stderr)
        return 1
    finally:
        conn.close()
    if out["status"] == "refused":
        print(f"[error] payload không qua guardrail ({out['codes']}) — "
              "không submit", file=sys.stderr)
        return 1
    print(f"[submit] {out['status']} {out['object_id']}"
          + (f" → mục #{out['id']}" if "id" in out else ""), flush=True)
    return 0


if __name__ == "__main__":
    with job_run("agents.seo_web") as run_rec:
        rc = main()
        run_rec["ok"] = rc == 0
    raise SystemExit(rc)
