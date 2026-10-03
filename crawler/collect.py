"""Entry point: `python -m crawler.collect` → ghi data/*.jsonl

Contract output (mỗi dòng JSONL = 1 record):
  products.jsonl : {"id","name","price_vnd"|null,"description","url","images":[url]}
  articles.jsonl : {"id","title","body","url","published_at"|null}
  about.jsonl    : {"id","title","body","url"}
  news.jsonl     : giống articles nhưng từ samsam.net.vn

Luật: delay ≥1s/request (CRAWL_DELAY_S), chỉ trang public, log ra stdout
để tee vào evidence/m1_crawl.log. Lỗi 1 item không được làm chết cả job —
ghi warning rồi chạy tiếp.
"""

import json
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from .sources import CRAWL_DELAY_S, SOURCES

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; samsam-pilot/0.1)"}
TIMEOUT_S = 20.0


def get(client: httpx.Client, url: str) -> httpx.Response | None:
    """GET 1 url có delay; lỗi trả None — caller quyết định skip."""
    time.sleep(CRAWL_DELAY_S)
    try:
        r = client.get(url, headers=HEADERS, timeout=TIMEOUT_S,
                       follow_redirects=True)
        r.raise_for_status()
        return r
    except httpx.HTTPError as e:
        print(f"[warn] GET {url}: {e}", flush=True)
        return None


def strip_html(html: str) -> str:
    """HTML → text sạch (bỏ tag, gom whitespace)."""
    return re.sub(r"\s+", " ", BeautifulSoup(html, "html.parser").get_text(" ", strip=True))


def wp_items(client: httpx.Client, url: str):
    """Yield item JSON qua hết các trang (phân trang header X-WP-TotalPages)."""
    page = 1
    while True:
        sep = "&" if "?" in url else "?"
        r = get(client, f"{url}{sep}per_page=100&page={page}")
        if r is None:
            return
        try:
            items = r.json()
        except ValueError:
            print(f"[warn] {url} page {page}: response không phải JSON", flush=True)
            return
        yield from items
        if page >= int(r.headers.get("x-wp-totalpages") or 1):
            return
        page += 1


def wc_product(p: dict) -> dict:
    """WooCommerce Store API → record products.jsonl.

    prices.price ở đơn vị nhỏ nhất theo currency_minor_unit; VND = 0 nên
    price đã là đồng nguyên. "0"/thiếu giá -> None (site ghi 'liên hệ').
    """
    prices = p.get("prices") or {}
    raw = (prices.get("price") or "").strip()
    minor = prices.get("currency_minor_unit") or 0
    price = int(int(raw) / (10**minor)) if raw.isdigit() and int(raw) > 0 else None
    desc = p.get("short_description") or p.get("description") or ""
    return {
        "id": f"wc-{p['id']}",
        "name": strip_html(p.get("name") or ""),
        "price_vnd": price,
        "description": strip_html(desc),
        "url": p.get("permalink") or "",
        "images": [i["src"] for i in p.get("images") or [] if i.get("src")],
    }


def wp_post(p: dict) -> dict:
    """WP REST post/page → record articles.jsonl. WP id unique xuyên post-type."""
    return {
        "id": f"wp-{p['id']}",
        "title": strip_html((p.get("title") or {}).get("rendered") or ""),
        "body": strip_html((p.get("content") or {}).get("rendered") or ""),
        "url": p.get("link") or "",
        "published_at": p.get("date") or None,
    }


def sitemap_urls(client: httpx.Client, url: str) -> list[str]:
    r = get(client, url)
    if r is None:
        return []
    return re.findall(r"<loc>([^<]+)</loc>", r.text)


def nv_id(url: str) -> str:
    """id từ slug file .html — duy nhất trong phạm vi site net.vn."""
    return "nv-" + url.rsplit("/", 1)[-1].removesuffix(".html")


def nv_article(soup: BeautifulSoup, url: str) -> dict:
    """Trang about/news NukeViet: h1 + div.bodytext (+ .hometext tóm tắt)."""
    h1 = soup.find("h1")
    parts = []
    for sel in ("div.hometext", "div.bodytext"):
        el = soup.select_one(sel)
        if el:
            parts.append(el.get_text(" ", strip=True))
    pub = soup.select_one("[itemprop=datePublished]")
    return {
        "id": nv_id(url),
        "title": h1.get_text(strip=True) if h1 else url,
        "body": re.sub(r"\s+", " ", " ".join(parts)),
        "url": url,
        "published_at": (pub.get("content") or pub.get_text(strip=True)) if pub else None,
    }


def nv_page(soup: BeautifulSoup, url: str) -> dict:
    rec = nv_article(soup, url)
    del rec["published_at"]  # contract about.jsonl không có field này
    return rec


def nv_shop(soup: BeautifulSoup, url: str) -> dict:
    """Trang product NukeViet shops: giá trong microdata itemprop=price."""
    h1 = soup.find("h1")
    price_el = soup.select_one("[itemprop=price]")
    digits = re.sub(r"[^\d]", "", price_el.get_text()) if price_el else ""
    detail = soup.select_one("div#detail")
    if detail:
        # công dụng nằm ở cả block tóm tắt cạnh giá lẫn tab Mô tả -> lấy hết
        # #detail, chỉ bỏ phần rác: sản phẩm cùng loại, từ khóa, tab đánh giá
        for junk in detail.select(".other-box, .keywords, .nav, [id^=content_rate], form"):
            junk.decompose()
    imgs = [
        urljoin(url, i["src"])
        for i in (detail or soup).select("img")
        if i.get("src")
    ]
    return {
        "id": nv_id(url),
        "name": h1.get_text(strip=True) if h1 else url,
        "price_vnd": int(digits) if digits else None,
        "description": re.sub(r"\s+", " ", detail.get_text(" ", strip=True)) if detail else "",
        "url": url,
        "images": imgs,
    }


def bricks_loc(li: BeautifulSoup, page_url: str) -> dict:
    """1 item `li.brxe-loop-builder-on` trong listing hệ thống phân phối ->
    record dạng article: title = tên điểm, body = địa chỉ + loại + SĐT."""
    h5 = li.find("h5")
    divs = [d.get_text(" ", strip=True) for d in li.select("div.brxe-text-basic")]
    tel = li.select_one('a[href^="tel:"]')
    title = h5.get_text(strip=True) if h5 else ""
    slug = re.sub(r"[^a-z0-9]+", "-",
                  unicodedata.normalize("NFKD", title)
                  .encode("ascii", "ignore").decode().lower()).strip("-")
    body = (f"Địa chỉ: {divs[0] if divs else '—'}. "
            f"Loại hình: {divs[-1] if len(divs) > 1 else '—'}. "
            f"Điện thoại: {tel.get_text(strip=True) if tel else '—'}.")
    return {"id": f"dist-{slug}", "title": title, "body": body,
            "url": page_url, "published_at": None}


def bricks_listing(src: dict) -> list[dict]:
    """Render listing Bricks (AJAX pagination) bằng playwright — REST API
    chỉ trả title, địa chỉ chỉ có trong DOM sau khi JS chạy. Thiếu
    playwright -> warn + skip (không chết job)."""
    try:
        from playwright.sync_api import Error, sync_playwright
    except ImportError:
        print(f"[warn] {src['name']}: thiếu playwright — bỏ qua source",
              flush=True)
        return []
    recs, seen = [], set()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(src["url"], timeout=45000)
                page.wait_for_selector("li.brxe-loop-builder-on[data-map]",
                                       timeout=20000)
                for _ in range(10):  # tối đa 10 trang pagination
                    time.sleep(CRAWL_DELAY_S)
                    soup = BeautifulSoup(page.content(), "html.parser")
                    new = 0
                    # [data-map]: chi item phan phoi co google-maps embed —
                    # tranh bat nham card khac neu click navigate sai trang.
                    items = soup.select("li.brxe-loop-builder-on[data-map]")
                    for it in items:
                        rec = bricks_loc(it, src["url"])
                        if (rec["id"] not in seen and rec["title"]
                                and "Địa chỉ: —" not in rec["body"]):
                            seen.add(rec["id"])
                            recs.append(rec)
                            new += 1
                    nxt = page.locator("a.next.page-numbers")
                    if not new or not nxt.count():
                        break
                    nxt.first.click()
                    page.wait_for_timeout(int(CRAWL_DELAY_S * 2000))
            finally:
                browser.close()
    except Error as e:
        print(f"[warn] {src['name']}: playwright lỗi "
              f"({type(e).__name__}: {str(e).splitlines()[0]}) — bỏ qua",
              flush=True)
        return []
    return recs


PARSERS = {"wc_product": wc_product, "wp_post": wp_post,
           "nv_shop": nv_shop, "nv_article": nv_article, "nv_page": nv_page}

ARTICLE_KINDS = {"wp_post", "nv_article", "nv_page", "bricks_loc"}


def degenerate(kind: str, rec: dict) -> bool:
    """Record rỗng payload: article thiếu body, product thiếu name."""
    if kind in ARTICLE_KINDS:
        return not rec["body"].strip()
    return not rec.get("name", "").strip()


def crawl(client: httpx.Client, src: dict) -> list[dict]:
    """Crawl 1 source theo type/kind, trả list record (skip item lỗi/rỗng)."""
    kind = src["kind"]
    if src["type"] == "bricks_listing":
        return bricks_listing(src)
    parse = PARSERS[kind]
    if src["type"] == "wp_api":
        out = []
        for item in wp_items(client, src["url"]):
            try:
                rec = parse(item)
            except (KeyError, ValueError, AttributeError, TypeError) as e:
                print(f"[warn] {src['name']} item {item.get('id')}: {e}", flush=True)
                continue
            if degenerate(kind, rec):
                print(f"[warn] {src['name']} item {item.get('id')} rỗng — bỏ qua",
                      flush=True)
                continue
            out.append(rec)
        return out
    out = []
    for url in sitemap_urls(client, src["url"]):
        rec = None
        # net.vn throttle theo burst: đôi khi trả trang skeleton (không h1/body).
        # Retry tối đa 3 lần, backoff tăng dần chờ cửa sổ throttle nguội.
        for attempt in range(3):
            r = get(client, url)
            if r is None:
                break
            try:
                rec = parse(BeautifulSoup(r.text, "html.parser"), url)
            except (KeyError, ValueError, AttributeError, TypeError) as e:
                print(f"[warn] {src['name']} {url}: {e}", flush=True)
                rec = None
                break
            if not degenerate(kind, rec):
                break
            print(f"[warn] {src['name']} {url}: trang rỗng, retry {attempt + 1}",
                  flush=True)
            time.sleep(CRAWL_DELAY_S * 8 * (attempt + 1))
        if rec is None or degenerate(kind, rec):
            print(f"[warn] {src['name']} {url}: không lấy được nội dung — bỏ qua",
                  flush=True)
            continue
        out.append(rec)
    return out


def main() -> int:
    """Crawl tất cả SOURCES, ghi jsonl, return exit code."""
    files: dict[str, list[dict]] = {}
    with httpx.Client() as client:
        for src in SOURCES:
            print(f"[src] {src['name']} -> {src['output']}", flush=True)
            recs = crawl(client, src)
            files.setdefault(src["output"], []).extend(recs)
            print(f"[src] {src['name']}: {len(recs)} records", flush=True)
    for name, recs in files.items():
        path = DATA_DIR / name
        with path.open("w", encoding="utf-8") as f:
            for rec in recs:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[done] {name}: {len(recs)} records -> {path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
