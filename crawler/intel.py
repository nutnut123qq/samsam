"""Collector tin thị trường tầng A/B (v7.0, WP09) — `python -m crawler.intel`.

Dùng chung cho DA-03, PC-A8, Red Alert. Tầng P1-Shadow: KHÔNG gửi ai,
KHÔNG đăng gì. Chỉ đọc RSS/Atom của nguồn tầng A (báo chính thống/cơ quan
nhà nước) và B (trang ngành/blog công khai) trong `data/intel_sources.json`
(danh sách ĐỀ XUẤT — mọi nguồn `cho_duyet` tới khi BGĐ/Quản lý MXH duyệt).

Contract CLI:
  --run [--source ID ...] [--max-requests N] [--sources PATH] [--llm]
  --report
  Thứ tự kiểm: argparse (đúng 1 op; --max-requests 1..200) → exit 2 →
  load_sources lỗi → exit 1 → --source lạ → exit 2, --source tầng C →
  [blocked] exit 2 → bộ lọc rượu hỏng → exit 1 → connect DB
  (connect_timeout=10; lỗi/thiếu DSN/thiếu bảng → exit 1, 0 request mạng)
  → mới ra mạng. `--run` không `--source`: chỉ nguồn `status == "duyet"`;
  `--source X` cho phép CHẠY THỬ nguồn `cho_duyet` (in [warn]). Exit 1 nếu
  ≥1 nguồn được thử mà 0 nguồn thành công (fetch + parse).

Luật CHẶN (cứng, cấu hình không nới được): `HARD_BLOCK` (sàn/MXH) ∪ host
mọi nguồn tầng C. Khớp hậu tố theo nhãn (`host == d` hoặc đuôi `"." + d`),
không substring. Kiểm TRƯỚC mọi request — URL nguồn, robots.txt, MỌI hop
redirect (tự theo, tối đa 3 hop; mỗi hop kiểm scheme, chặn, robots và nhịp
của host mới).

robots.txt: tải 1 lần/origin/lượt qua chính fetcher. 2xx → luật file
(`Crawl-delay` > 1 → dùng, trần 60s); 401/403 → cấm hết; 4xx khác (trừ
429) → cho hết; 429/5xx/lỗi mạng/quá lớn/redirect hỏng → BỎ origin cả
lượt (fail-closed). Nhịp: ≥ CRAWL_DELAY_S (1s) giữa 2 lần BẮT ĐẦU request
cùng host, tuần tự. Content 429 → không retry, bỏ origin cả lượt.
`--max-requests` = ngân sách TỔNG (robots + hop + feed). Trần body: feed
2MB, robots 500KB (Content-Length vượt → đóng trước khi đọc; stream vượt →
hủy, `too_large`). Log mỗi request gửi đi: `[req] {json}`; bị chặn
`[blocked] {json}`; robots cấm `[robots-deny] {json}` (2 loại sau không có
request). Log ra stdout → `tee` vào evidence (không file runtime trong
data/).

Bảng `intel_items` (docs/schema.sql, block v7.0): url (chuẩn hóa, unique),
domain, source, tier A|B, title/snippet/summary ≤300 ký tự, published_at,
fetched_at, content_sha256 (unique), topics (≥1), flags (`ruou`,
`suc_khoe`, `llm_guardrail_fail`). KHÔNG lưu toàn văn (bản quyền) — chỉ
tiêu đề + trích ≤300 ký tự đã che SĐT/email + link; KHÔNG bao giờ GET
trang bài. Tin 0 chủ đề → không lưu.

Quyền sở hữu: module này CHỈ ghi `intel_items` (+ `job_runs` qua
`job_run`). Không có đường ghi bảng hàng duyệt nội dung, không đăng,
không gửi. LLM tóm tắt tùy chọn (mặc định TẮT): chỉ khi `--llm` VÀ
`llm.enabled is True`, qua `pipelines.llm_gateway.chat("intel", ...)`
(cap tháng riêng) + `guardrail.check` trước khi lưu.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import httpx
import psycopg
from dotenv import load_dotenv

from crawler.collect import strip_html
from crawler.sources import CRAWL_DELAY_S
from pipelines import guardrail, kb_filter, llm_gateway
from pipelines.job_runs import job_run
from pipelines.llm_gateway import _strip_accents, is_health_question
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "data" / "intel_sources.json"
GATEWAY_FILE = ROOT / "data" / "llm_gateway.json"
VN_TZ = timezone(timedelta(hours=7))  # VN không DST — không cần tzdata

HARD_BLOCK = ("shopee.vn", "shopee.com", "shp.ee", "tiktok.com",
              "tiktokv.com", "lazada.vn", "lazada.com", "lzd.co", "tiki.vn",
              "sendo.vn", "facebook.com", "fb.com", "fb.watch",
              "instagram.com", "threads.net", "x.com", "twitter.com",
              "zalo.me")
UA_TOKEN = "samsam-intel"
TIMEOUT_S = 10.0
TOTAL_S = 30.0          # trần tổng 1 request (chống server nhỏ giọt)
MAX_BYTES = 2_000_000   # feed
ROBOTS_MAX = 500_000
MAX_HOPS = 3
MAX_ENTRIES = 200
MAX_URL = 2000          # btree unique index giới hạn ~2.7KB
TEXT_MAX = 300
PRE_MAX = TEXT_MAX * 4  # cắt trước _mask_pii (chống DoS regex)
RAW_MAX = 20_000        # cắt HTML thô trước strip_html
LLM_MAX_ITEMS = 20
DEFAULT_MAX_REQUESTS = 60
REDIRECTS = (301, 302, 303, 307, 308)
TIERS = ("A", "B", "C")
KINDS = ("rss", "atom")
STATUSES = ("cho_duyet", "duyet")
_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_DROP_Q = ("fbclid", "gclid", "zarsrc")
# Ký tự điều khiển C0/C1 + line/para separator + zero-width + bidi.
_CTRL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029"
                      "\u202a-\u202e\u2066-\u2069\ufeff]")
_INSERT = ("insert into intel_items (url, domain, source, tier, title,"
           " snippet, summary, published_at, content_sha256, topics, flags)"
           " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
           " on conflict do nothing")
_LLM_PROMPT = ("Tóm tắt tin sau trong 1-2 câu tiếng Việt, trung tính, tối đa"
               " 250 ký tự. Không thêm thông tin ngoài tin, không nêu công"
               " dụng sức khỏe.")


class BlockedDomain(Exception):
    """Host thuộc HARD_BLOCK / tầng C / scheme lạ — không gửi request."""


class BudgetExhausted(Exception):
    """Hết ngân sách --max-requests."""


class FeedError(ValueError):
    """Feed không parse được (XML hỏng, DOCTYPE, encoding lạ)."""


class Resp(NamedTuple):
    status: int | str
    body: bytes | None
    location: str | None


def _clean(s, n: int = 300) -> str:
    """Bỏ ký tự điều khiển + gom khoảng trắng + cắt n (in/log an toàn)."""
    return re.sub(r"\s+", " ", _CTRL_RE.sub(" ", str(s))).strip()[:n]


def _emit(log, tag: str, d: dict) -> None:
    log(f"[{tag}] " + json.dumps(d, ensure_ascii=False))


def _norm_host(h: str) -> str:
    h = unicodedata.normalize("NFKC", h or "").strip()
    if "://" in h:
        h = urlsplit(h).netloc
    h = h.rsplit("@", 1)[-1]
    if h.startswith("["):
        h = h[1:].split("]", 1)[0]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.lower().rstrip(".")


def is_blocked(host: str, extra=()) -> bool:
    """True nếu host (hoặc URL) thuộc HARD_BLOCK ∪ extra — khớp hậu tố theo
    nhãn, KHÔNG substring (`shopee.vn.evil.com`, `notshopee.vn` → False)."""
    h = _norm_host(host)
    if not h:
        return False
    for d in (*HARD_BLOCK, *extra):
        d = _norm_host(d)
        if d and (h == d or h.endswith("." + d)):
            return True
    return False


def tier_c_hosts(cfg: dict) -> tuple[str, ...]:
    """Host các nguồn tầng C (bỏ 'www.' để chặn cả domain)."""
    out = []
    for s in cfg.get("sources", []):
        if s.get("tier") == "C":
            h = _norm_host(s.get("url", ""))
            out.append(h.removeprefix("www."))
    return tuple(h for h in out if h)


def _contact() -> str:
    c = os.environ.get("INTEL_CONTACT", "").strip()
    if re.fullmatch(r"[^\s()<>@]{1,64}@[^\s()<>@]{1,190}", c):
        return c
    try:
        allow = json.loads(GATEWAY_FILE.read_text(encoding="utf-8"))["pii_allow"]
        return next(a for a in allow if isinstance(a, str) and "@" in a)
    except (OSError, ValueError, KeyError, TypeError, StopIteration):
        return "unknown"


def user_agent() -> str:
    return f"{UA_TOKEN}/0.1 (+mailto:{_contact()})"


# ---------------------------------------------------------------- nguồn


def load_sources(path) -> tuple[dict | None, list[str]]:
    """Đọc + kiểm file nguồn. Fail-closed: bất kỳ lỗi nào → (None, errors)
    — errors nêu id + field, không in giá trị dài."""
    path = Path(path)
    try:
        cfg = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, [f"{path.name}: không đọc được ({type(e).__name__})"]
    if not isinstance(cfg, dict):
        return None, [f"{path.name}: gốc phải là object"]
    errs = []
    topics = cfg.get("topics")
    if not isinstance(topics, dict) or not topics:
        errs.append("topics: rỗng hoặc sai kiểu")
    else:
        for t, ph in topics.items():
            if (not isinstance(ph, list) or not ph
                    or not all(isinstance(p, str) and p.strip() for p in ph)):
                errs.append(f"topics.{_clean(t, 40)}: 0 cụm hoặc cụm rỗng")
    llm = cfg.get("llm", {"enabled": False})
    if not isinstance(llm, dict) or not isinstance(llm.get("enabled"), bool):
        errs.append("llm.enabled: phải là true/false")
    srcs = cfg.get("sources")
    if not isinstance(srcs, list) or not srcs:
        errs.append("sources: rỗng hoặc sai kiểu")
        srcs = []
    seen = set()
    for i, s in enumerate(srcs):
        if not isinstance(s, dict):
            errs.append(f"sources[{i}]: phải là object")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not _ID_RE.fullmatch(sid):
            errs.append(f"sources[{i}].id: thiếu/sai dạng [a-z0-9_-]")
            sid = f"#{i}"
        elif sid in seen:
            errs.append(f"{sid}.id: trùng")
        seen.add(sid)
        if s.get("tier") not in TIERS:
            errs.append(f"{sid}.tier: phải là A|B|C")
        url = s.get("url")
        try:
            u = urlsplit(url) if isinstance(url, str) else None
            ok_url = (u is not None and u.scheme in ("http", "https")
                      and bool(u.hostname) and len(url) <= MAX_URL)
        except ValueError:
            ok_url = False
        if not ok_url:
            errs.append(f"{sid}.url: phải là http(s) có host")
        if s.get("kind") not in KINDS:
            errs.append(f"{sid}.kind: phải là rss|atom")
        if s.get("status") not in STATUSES:
            errs.append(f"{sid}.status: phải là cho_duyet|duyet")
    if errs:
        return None, errs
    cfg.setdefault("llm", {"enabled": False})
    return cfg, []


# ---------------------------------------------------------------- fetcher


class Fetcher:
    """GET tuần tự, an toàn: chặn cứng, robots, nhịp/host, trần, ngân sách.

    `sleep`/`clock`/`transport`/`log` tiêm được cho test (không assert
    wall-clock)."""

    def __init__(self, budget=DEFAULT_MAX_REQUESTS, extra_block=(),
                 transport=None, sleep=time.sleep, clock=time.perf_counter,
                 log=None, max_bytes=MAX_BYTES, robots_max=ROBOTS_MAX):
        self.budget = budget
        self.extra = tuple(extra_block)
        self.sleep, self.clock = sleep, clock
        self.log = log or (lambda s: print(s, flush=True))
        self.max_bytes, self.robots_max = max_bytes, robots_max
        self.client = httpx.Client(
            transport=transport, timeout=httpx.Timeout(TIMEOUT_S),
            follow_redirects=False,
            headers={"User-Agent": user_agent(), "Accept-Encoding": "gzip"})
        self.used = self.blocked = self.robots_deny = 0
        self.last: dict[str, float] = {}     # host -> clock lúc bắt đầu
        self.delay: dict[str, float] = {}    # host -> crawl-delay robots
        self.robots: dict[str, RobotFileParser | None] = {}  # origin
        self.dead: set[str] = set()          # origin bỏ cả lượt

    def close(self):
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _check(self, url: str, source: str):
        """URL → (httpx.URL, host). Chặn → log [blocked] + BlockedDomain."""
        try:
            u = httpx.URL(url)
            hosts = {u.host, u.raw_host.decode("ascii", "replace")}
            scheme_ok = u.scheme in ("http", "https") and bool(u.host)
        except (httpx.InvalidURL, ValueError, TypeError, UnicodeError):
            u, hosts, scheme_ok = None, {_norm_host(str(url))}, False
        reason = None
        if not scheme_ok:
            reason = "scheme"
        elif any(is_blocked(h) for h in hosts):
            reason = "hard"
        elif any(is_blocked(h, self.extra) for h in hosts):
            reason = "tier_c"
        host = _norm_host(u.host) if u is not None and u.host else ""
        if reason:
            self.blocked += 1
            _emit(self.log, "blocked", {"source": source,
                                        "host": _clean(host or url, 200),
                                        "reason": reason})
            raise BlockedDomain(host)
        return u, host

    def fetch(self, url: str, source: str) -> Resp | None:
        """GET 1 URL nội dung (kiểm robots). None = bỏ (robots cấm/lỗi)."""
        return self._get(url, source, "feed", True, self.max_bytes)

    def _get(self, url, source, kind, robots_check, cap) -> Resp | None:
        for _hop in range(MAX_HOPS + 1):
            u, host = self._check(url, source)
            origin = f"{u.scheme}://{u.netloc.decode('ascii', 'replace')}"
            if origin in self.dead:
                self.log(f"[warn] {_clean(source, 64)}: bỏ {_clean(origin, 200)}"
                         " (đã lỗi/429 trong lượt)")
                return None
            if robots_check:
                rp = self._robots(origin, host, source)
                if rp is None:
                    return None
                if not rp.can_fetch(UA_TOKEN, str(u)):
                    self.robots_deny += 1
                    _emit(self.log, "robots-deny",
                          {"source": source, "url": _clean(str(u))})
                    return None
            r = self._send(u, host, source, kind, robots_check, cap)
            if r is None:
                return None
            if r.status in REDIRECTS and r.location:
                try:
                    url = urljoin(str(u), r.location)
                except ValueError:
                    self.log(f"[warn] {_clean(source, 64)}: redirect Location"
                             " hỏng — bỏ")
                    return None
                continue
            if r.status == 429:
                self.dead.add(origin)
            return r
        self.log(f"[warn] {_clean(source, 64)}: quá {MAX_HOPS} redirect — bỏ")
        return None

    def _robots(self, origin, host, source) -> RobotFileParser | None:
        if origin in self.robots:
            return self.robots[origin]
        rp = None
        try:
            r = self._get(origin + "/robots.txt", source, "robots", False,
                          self.robots_max)
        except BlockedDomain:
            r = None
        st = r.status if r is not None else None
        if isinstance(st, int) and 200 <= st < 300 and r.body is not None:
            rp = RobotFileParser()
            rp.parse(r.body.decode("utf-8", "replace").splitlines())
            cd = rp.crawl_delay(UA_TOKEN)
            if cd and float(cd) > CRAWL_DELAY_S:
                self.delay[host] = min(float(cd), 60.0)
        elif st in (401, 403):
            rp = RobotFileParser()
            rp.disallow_all = True
        elif isinstance(st, int) and 400 <= st < 500 and st != 429:
            rp = RobotFileParser()
            rp.allow_all = True
        if rp is None:
            self.dead.add(origin)
            self.log(f"[warn] {_clean(source, 64)}: robots.txt của "
                     f"{_clean(origin, 200)} không đọc được ({st}) — bỏ host"
                     " cả lượt")
        self.robots[origin] = rp
        return rp

    def _send(self, u, host, source, kind, robots_ok, cap) -> Resp | None:
        if self.used >= self.budget:
            raise BudgetExhausted
        need = self.delay.get(host, CRAWL_DELAY_S)
        prev = self.last.get(host)
        if prev is not None:
            while (gap := self.clock() - prev) < need:
                self.sleep(max(need - gap, 0.001))
        start = self.clock()
        self.last[host] = start
        self.used += 1
        status, body, loc, nbytes = None, None, None, 0
        try:
            with self.client.stream("GET", u) as r:
                status, loc = r.status_code, r.headers.get("location")
                if 200 <= status < 300:
                    status, body, nbytes = self._read(r, cap, start)
        except httpx.HTTPError as e:
            status = f"error:{type(e).__name__}"
        _emit(self.log, "req", {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": source, "host": host, "kind": kind,
            "url": _clean(str(u)), "status": status,
            "robots_ok": True if robots_ok else None, "bytes": nbytes,
            "ms": round((self.clock() - start) * 1000),
            "gap_s": None if prev is None else round(start - prev, 3)})
        if isinstance(status, str) and status.startswith("error:"):
            return None
        return Resp(status, body, loc)

    def _read(self, r, cap, start):
        """Đọc body có trần. Trả (status, body|None, số byte đã nhận)."""
        cl = (r.headers.get("content-length") or "").strip()
        if cl.isascii() and cl.isdigit() and (len(cl) > 18 or int(cl) > cap):
            return "too_large", None, 0
        raw = bytearray()
        for chunk in r.iter_raw():
            raw += chunk
            if len(raw) > cap:
                return "too_large", None, len(raw)
            if self.clock() - start > TOTAL_S:
                return "timeout", None, len(raw)
        enc = (r.headers.get("content-encoding") or "identity").strip().lower()
        if enc in ("gzip", "x-gzip"):
            try:
                body = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(
                    bytes(raw), cap + 1)
            except zlib.error:
                return "bad_encoding", None, len(raw)
            if len(body) > cap:
                return "too_large", None, len(raw)
            return r.status_code, body, len(raw)
        if enc != "identity":
            return "bad_encoding", None, len(raw)
        return r.status_code, bytes(raw), len(raw)


# ---------------------------------------------------------------- parse


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child(el, name):
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def _text(el) -> str:
    return "".join(el.itertext()) if el is not None else ""


def parse_date(s, now=None) -> datetime | None:
    """RFC 822 hoặc ISO 8601; naive → giờ VN; lỗi → None. Ngoài cửa sổ
    hợp lý (năm < 2000 hoặc > now+2 ngày) → None: ngày 9999/0001 từ feed
    làm `astimezone` OverflowError ở --report và ghim tin lên đầu sort.
    Trường số tràn C long/int (năm 2147483648, offset 20 chữ số) làm
    parsedate_to_datetime raise OverflowError (không phải ValueError) →
    cũng None, để 1 pubDate độc không giết cả lượt run."""
    s = (s or "").strip()[:100]
    if not s:
        return None
    dt = None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError, OverflowError):
        try:
            dt = datetime.fromisoformat(s)
        except (ValueError, OverflowError):
            return None
    dt = dt if dt.tzinfo else dt.replace(tzinfo=VN_TZ)
    limit = (now or datetime.now(timezone.utc)) + timedelta(days=2)
    return None if dt.year < 2000 or dt > limit else dt


def _parse(data: bytes) -> list[dict]:
    """bytes RSS 2.0 / Atom → [{title, link, desc, published}] (≤200).
    Từ chối DOCTYPE/ENTITY (chặn entity expansion) + UTF-16/32."""
    head = data[:4]
    if head[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in data[:200]:
        raise FeedError("encoding UTF-16/32 không hỗ trợ")
    if re.search(rb"<!(?:doctype|entity)", data, re.IGNORECASE):
        raise FeedError("feed có DOCTYPE/ENTITY — từ chối")
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, LookupError, ValueError) as e:
        # LookupError: encoding khai báo lạ ("bogus") — không được làm chết
        # cả lượt (OWASP self-review v7.0).
        raise FeedError(f"XML hỏng ({_clean(e, 80)})") from e
    out = []
    if _local(root.tag) == "rss":
        ch = _child(root, "channel")
        for it in (c for c in (ch if ch is not None else []) if _local(c.tag) == "item"):
            out.append({"title": _text(_child(it, "title")),
                        "link": _text(_child(it, "link")).strip(),
                        "desc": _text(_child(it, "description")),
                        "published": _text(_child(it, "pubDate"))})
            if len(out) >= MAX_ENTRIES:
                break
    elif _local(root.tag) == "feed":
        for e in (c for c in root if _local(c.tag) == "entry"):
            link = ""
            for ln in e:
                if (_local(ln.tag) == "link"
                        and ln.get("rel", "alternate") == "alternate"):
                    link = (ln.get("href") or "").strip()
                    break
            summ = _child(e, "summary")
            if summ is None:
                summ = _child(e, "content")
            pub = _child(e, "published")
            if pub is None:
                pub = _child(e, "updated")
            out.append({"title": _text(_child(e, "title")), "link": link,
                        "desc": _text(summ), "published": _text(pub)})
            if len(out) >= MAX_ENTRIES:
                break
    else:
        raise FeedError(f"gốc XML lạ <{_clean(_local(root.tag), 40)}>")
    return out


def parse_feed(data: bytes, log=None) -> list[dict]:
    """Như `_parse` nhưng lỗi → [warn] + [] (lượt chạy tiếp)."""
    try:
        return _parse(data)
    except FeedError as e:
        (log or print)(f"[warn] feed bỏ: {e}")
        return []


def clean_text(s, n: int = TEXT_MAX) -> str:
    """HTML/thô → text ngắn ≤n: strip_html → gom trắng → cắt PRE_MAX →
    _mask_pii → bỏ ký tự điều khiển → cắt n."""
    s = str(s or "")[:RAW_MAX]
    if "<" in s or "&" in s:
        s = strip_html(s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > PRE_MAX:
        # Bỏ token dở ở mép + đuôi số/dấu (SĐT/email bị cắt đôi không lọt).
        s = (s[:PRE_MAX].rsplit(None, 1) or [""])[0].rstrip("0123456789 .+-()@")
    return _clean(_mask_pii(s), n)


def _norm(s: str) -> str:
    return unicodedata.normalize("NFC", s).casefold()


@lru_cache(maxsize=8)
def _compile_topics(key: str):
    out = {}
    for t, phrases in json.loads(key).items():
        ph = [_norm(p.strip()) for p in phrases if p.strip()]
        acc = [p for p in ph if _strip_accents(p) != p]
        asc = [p for p in ph if _strip_accents(p) == p]
        out[t] = (kb_filter._compile(acc), kb_filter._compile(asc),
                  kb_filter._compile([_strip_accents(p) for p in acc]))
    return out


def classify(title: str, snippet: str, topics: dict) -> tuple[list, list]:
    """(chủ đề, cờ) theo LUẬT. Cụm có dấu khớp text có dấu; cụm ASCII khớp
    bản bỏ dấu; bản bỏ dấu tự sinh của cụm có dấu CHỈ áp khi text hoàn toàn
    không dấu ("săm lốp" không thành "sâm"). Cờ: `ruou` (kb_filter — raise
    KbFilterError khi keyword hỏng), `suc_khoe` (is_health_question)."""
    text = f"{title or ''} {snippet or ''}"
    t = _norm(text)
    plain = _strip_accents(t)
    bare = plain == t
    hit = []
    for name, (acc, asc, derived) in _compile_topics(
            json.dumps(topics, ensure_ascii=False, sort_keys=True)).items():
        if ((acc is not None and acc.search(t))
                or (asc is not None and asc.search(plain))
                or (bare and derived is not None and derived.search(plain))):
            hit.append(name)
    flags = []
    if kb_filter.is_alcohol(text):
        flags.append("ruou")
    if is_health_question(text):
        flags.append("suc_khoe")
    return sorted(hit), flags


def normalize_url(url: str) -> str:
    """scheme/host lowercase, bỏ port mặc định/userinfo/fragment, bỏ query
    utm_*/fbclid/gclid/zarsrc, sort query còn lại, bỏ '/' cuối path."""
    s = urlsplit(url.strip())
    scheme = s.scheme.lower()
    host = (s.hostname or "").lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    port = s.port
    if port and (scheme, port) not in (("http", 80), ("https", 443)):
        host += f":{port}"
    q = sorted((k, v) for k, v in parse_qsl(s.query, keep_blank_values=True)
               if not (k.lower().startswith("utm_") or k.lower() in _DROP_Q))
    path = s.path or "/"
    if len(path) > 1:
        path = path.rstrip("/") or "/"
    return urlunsplit((scheme, host, path, urlencode(q), ""))


def content_sha(title: str, snippet: str) -> str:
    def n(s):
        return re.sub(r"\s+", " ", _norm(s or "")).strip()
    return hashlib.sha256(f"{n(title)}\n{n(snippet)}".encode()).hexdigest()


def build_items(entries, src: dict, base_url: str, topics: dict):
    """entries feed → (items để lưu, số tin 0 chủ đề). KHÔNG GET link."""
    items, off = [], 0
    for e in entries:
        title = clean_text(e.get("title"))
        try:
            # urljoin cũng raise ValueError (host ngoặc hỏng "http://[::1")
            # — 1 link hỏng chỉ bỏ entry đó, không làm chết cả lượt.
            link = urljoin(base_url, (e.get("link") or "").strip())
            url = normalize_url(link)
            parts = urlsplit(url)
        except ValueError:
            continue
        if (not title or parts.scheme not in ("http", "https")
                or not parts.hostname or len(url) > MAX_URL):
            continue
        snippet = clean_text(e.get("desc"))
        tps, flags = classify(title, snippet, topics)
        if not tps:
            off += 1
            continue
        items.append({"url": url, "domain": parts.hostname, "source": src["id"],
                      "tier": src["tier"], "title": title,
                      "snippet": snippet or None, "summary": None,
                      "published_at": parse_date(e.get("published")),
                      "content_sha256": content_sha(title, snippet),
                      "topics": tps, "flags": flags})
    return items, off


# ---------------------------------------------------------------- lưu


def store_items(conn, items: list[dict], enrich=None) -> dict:
    """Insert-only, idempotent. Dedup url chuẩn hóa + content_sha256 (tra
    trước trong cùng tx, kể cả trùng trong lô). `enrich(item)` chạy CHỈ
    cho tin mới trước khi insert (LLM). 1 tx + commit tường minh."""
    res = {"new": 0, "dup_url": 0, "dup_content": 0}
    if not items:
        return res
    try:
        urls = {r[0] for r in conn.execute(
            "select url from intel_items where url = any(%s)",
            ([i["url"] for i in items],)).fetchall()}
        shas = {r[0] for r in conn.execute(
            "select content_sha256 from intel_items where content_sha256 ="
            " any(%s)", ([i["content_sha256"] for i in items],)).fetchall()}
        for it in items:
            if it["url"] in urls:
                res["dup_url"] += 1
                continue
            if it["content_sha256"] in shas:
                res["dup_content"] += 1
                continue
            urls.add(it["url"])
            shas.add(it["content_sha256"])
            if enrich is not None:
                enrich(it)
            cur = conn.execute(_INSERT, (
                it["url"], it["domain"], it["source"], it["tier"], it["title"],
                it["snippet"], it["summary"], it["published_at"],
                it["content_sha256"], it["topics"], it["flags"]))
            res["new" if cur.rowcount == 1 else "dup_url"] += 1
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return res


class _Llm:
    """Tóm tắt tùy chọn qua gateway (agent 'intel'); lỗi gateway → tắt
    phần còn lại của lượt, tin vẫn lưu."""

    def __init__(self):
        self.n, self.off = 0, False

    def __call__(self, it: dict) -> None:
        if self.off or self.n >= LLM_MAX_ITEMS:
            return
        self.n += 1
        msgs = [{"role": "system", "content": _LLM_PROMPT},
                {"role": "user", "content": f"{it['title']}\n{it['snippet'] or ''}"}]
        try:
            resp = llm_gateway.chat("intel", msgs, max_tokens=200)
            text = resp.choices[0].message.content
        except llm_gateway.GatewayError as e:
            print(f"[warn] LLM tắt phần còn lại của lượt ({type(e).__name__})",
                  flush=True)
            self.off = True
            return
        except (AttributeError, IndexError, TypeError):
            return
        # Làm sạch TRƯỚC rồi mới guardrail, lưu ĐÚNG chuỗi đã kiểm:
        # strip_html giải mã entity ("&#99;hữa" → "chữa") nên kiểm text thô
        # rồi lưu bản sạch = lọt từ cấm (cold-check v7.0).
        s = clean_text(text) if isinstance(text, str) else ""
        if not s:
            return
        if guardrail.check(s).get("ok") is not True:
            it["flags"] = [*it["flags"], "llm_guardrail_fail"]
            return
        it["summary"] = s


# ---------------------------------------------------------------- CLI


def _connect(dsn: str):
    return psycopg.connect(dsn, connect_timeout=10)


def run(conn, cfg: dict, sources: list[dict], fetcher: Fetcher,
        use_llm: bool) -> int:
    st = dict.fromkeys(("ok", "new", "dup_url", "dup_content", "off_topic"), 0)
    enrich = _Llm() if use_llm else None
    for src in sources:
        sid = src["id"]
        try:
            r = fetcher.fetch(src["url"], sid)
        except BlockedDomain:
            continue
        except BudgetExhausted:
            print(f"[warn] hết ngân sách --max-requests {fetcher.budget} — "
                  "dừng lượt", flush=True)
            break
        if r is None or r.status != 200 or r.body is None:
            if r is not None:
                print(f"[warn] {sid}: feed status {r.status} — bỏ nguồn",
                      flush=True)
            continue
        try:
            entries = _parse(r.body)
        except FeedError as e:
            print(f"[warn] {sid}: {e} — bỏ nguồn", flush=True)
            continue
        items, off = build_items(entries, src, src["url"], cfg["topics"])
        res = store_items(conn, items, enrich)
        st["ok"] += 1
        st["off_topic"] += off
        for k, v in res.items():
            st[k] += v
        print(f"[src] {sid}: {len(entries)} tin, {len(items)} đúng chủ đề, "
              f"mới {res['new']}", flush=True)
    print(f"[done] sources={len(sources)} ok={st['ok']} "
          f"requests={fetcher.used} new={st['new']} dup_url={st['dup_url']} "
          f"dup_content={st['dup_content']} off_topic={st['off_topic']} "
          f"blocked={fetcher.blocked} robots_deny={fetcher.robots_deny}",
          flush=True)
    return 1 if sources and st["ok"] == 0 else 0


def report(conn) -> None:
    total = conn.execute("select count(*) from intel_items").fetchone()[0]
    if not total:
        print("chưa có tin trong intel_items")
        return
    print(f"Tổng tin: {total}")
    for label, sql in (
            ("Theo tầng", ("select tier, count(*) from intel_items"
                           " group by 1 order by 1")),
            ("Theo nguồn", ("select source, count(*) from intel_items"
                            " group by 1 order by 2 desc, 1")),
            ("Theo chủ đề", ("select t, count(*) from intel_items,"
                             " unnest(topics) t group by 1"
                             " order by 2 desc, 1")),
            ("Cờ", ("select f, count(*) from intel_items, unnest(flags) f"
                    " where f in ('ruou', 'suc_khoe') group by 1"
                    " order by 1"))):
        rows = conn.execute(sql).fetchall()
        print(f"{label}: " + (", ".join(f"{_clean(k, 40)}={n}" for k, n in rows)
                              or "—"))
    print("10 tin mới nhất:")
    for pub, src, tps, title, url in conn.execute(
            "select published_at, source, topics, title, url from intel_items"
            " order by fetched_at desc, id desc limit 10").fetchall():
        try:
            day = pub.astimezone(VN_TZ).strftime("%Y-%m-%d") if pub else "?"
        except (OverflowError, ValueError):  # dòng cũ trước khi chặn ngày
            day = "?"
        print(f"  {day} [{_clean(src, 40)}] {_clean(','.join(tps), 60)} | "
              f"{_clean(title, 160)} | {_clean(url, 200)}")


def main(argv=None, *, transport=None, sleep=time.sleep,
         clock=time.perf_counter) -> int:
    ap = argparse.ArgumentParser(prog="python -m crawler.intel")
    ap.add_argument("--run", action="store_true", help="thu tin tầng A/B")
    ap.add_argument("--report", action="store_true", help="tóm tắt intel_items")
    ap.add_argument("--source", action="append", metavar="ID",
                    help="chạy THỬ nguồn này (lặp được; cho phép cho_duyet)")
    ap.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS,
                    help="ngân sách TỔNG request (1..200, mặc định 60)")
    ap.add_argument("--sources", type=Path, default=SOURCES_FILE,
                    help="file nguồn (mặc định data/intel_sources.json)")
    ap.add_argument("--llm", action="store_true",
                    help="tóm tắt LLM (chỉ khi llm.enabled = true)")
    args = ap.parse_args(argv)
    if args.run + args.report != 1:
        ap.error("cần đúng 1 thao tác: --run hoặc --report")
    if args.report and (args.source or args.llm):
        ap.error("--source/--llm chỉ dùng với --run")
    if not 1 <= args.max_requests <= 200:
        ap.error("--max-requests phải trong 1..200")
    cfg, errs = load_sources(args.sources)
    if errs:
        for e in errs:
            print(f"[err] {e}", flush=True)
        return 1
    by_id = {s["id"]: s for s in cfg["sources"]}
    picked = list(dict.fromkeys(args.source or []))
    for sid in picked:
        if sid not in by_id:
            ap.error(f"--source không tồn tại: {_clean(sid, 64)}")
    for sid in picked:
        if by_id[sid]["tier"] == "C":
            _emit(lambda s: print(s, flush=True), "blocked",
                  {"source": sid, "host": _norm_host(by_id[sid]["url"]),
                   "reason": "tier_c"})
            return 2
    try:
        kb_filter.is_alcohol("rượu")  # fail-closed TRƯỚC khi ra mạng
    except kb_filter.KbFilterError as e:
        print(f"[err] bộ lọc rượu hỏng: {e} — không thu tin", flush=True)
        return 1
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("[err] thiếu DATABASE_URL trong .env", flush=True)
        return 1
    try:
        conn = _connect(dsn)
    except psycopg.Error as e:
        print(f"[err] không kết nối được Postgres: {type(e).__name__}",
              flush=True)
        return 1
    try:
        if conn.execute("select to_regclass('intel_items')").fetchone()[0] is None:
            print("[err] chưa có bảng intel_items — chạy "
                  "`python scripts/apply_schema.py`", flush=True)
            return 1
        if args.report:
            report(conn)
            return 0
        with job_run("crawler.intel") as jr:
            rc = _run_cli(conn, cfg, args, picked, by_id, transport, sleep,
                          clock)
            jr["ok"] = rc == 0
        return rc
    except psycopg.Error as e:
        print(f"[err] lỗi DB: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()


def _run_cli(conn, cfg, args, picked, by_id, transport, sleep, clock) -> int:
    if picked:
        sources = [by_id[s] for s in picked]
        for s in sources:
            if s["status"] != "duyet":
                print(f"[warn] {s['id']}: nguồn chưa duyệt — chạy thử",
                      flush=True)
    else:
        sources = [s for s in cfg["sources"]
                   if s["tier"] in ("A", "B") and s["status"] == "duyet"]
        if not sources:
            print("[warn] 0 nguồn đã duyệt — không thu gì (BGĐ/Quản lý MXH "
                  "duyệt danh sách; chạy thử: --source ID)", flush=True)
            return 0
    use_llm = False
    if args.llm:
        if cfg["llm"].get("enabled") is True:
            use_llm = True
        else:
            print("[warn] LLM tắt — chờ Pháp chế xác nhận", flush=True)
    with Fetcher(args.max_requests, tier_c_hosts(cfg), transport, sleep,
                 clock) as f:
        try:
            return run(conn, cfg, sources, f, use_llm)
        except kb_filter.KbFilterError as e:
            print(f"[err] bộ lọc rượu hỏng: {e}", flush=True)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
