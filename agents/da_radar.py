"""v8.3 DA-03 — radar chương trình xúc tiến/hội chợ/OCOP cho phòng Dự án.

Contract:
  - KHÔNG tự ra mạng, KHÔNG collector thứ 2: tin được thu bằng CHÍNH
    collector v7.0 (`python -m crawler.intel --run --source <id>` — robots,
    nhịp ≥1s/host, chặn HARD_BLOCK + tầng C). Module này chỉ ĐỌC
    `intel_items` có chủ đề `chuong_trinh` và ghi bảng `programs`.
  - `deadline_of(text, published_at)` THUẦN: chỉ nhận ngày đứng SAU từ khóa
    hạn (hạn chót/hạn đăng ký/hạn nộp/trước ngày/đến hết ngày/đăng ký đến/
    deadline — có dấu hoặc gõ không dấu), lazy, không vượt `.;`; "hạn" TRẦN
    loại cụm khác nghĩa (hạn chế, giới hạn, thời hạn, hạn hán, hữu hạn...),
    không vượt dấu phẩy, bản không dấu ngày phải đứng ngay sau ("Han Quoc"
    không phải hạn); "từ X đến Y"/"X - Y" → Y. Dạng dd/mm[/yyyy],
    dd-mm-yyyy, dd.mm.yyyy với ranh giới chống ăn giá "10.050.000", khoảng
    "2025-2026". Thiếu năm → năm của ngày đăng (giờ VN), nhỏ hơn ngày đăng
    → +1 năm. Ngày sai lịch → bỏ. Đoạn trích (`deadline_text`) in ở `--list`
    để người đọc thấy hạn suy từ đâu.
  - `organizer_of(text)` THUẦN: "(do|bởi) (Sở|Bộ|Cục|UBND|Hội|...) ..." dừng
    ở "tổ chức|phối hợp|,.;", ≤120 ký tự; không khớp → 'chưa công bố'.
  - `scan`: bỏ tin cờ `ruou` (+ kiểm lại `kb_filter.is_alcohol`), bỏ url
    thuộc `crawler.intel.is_blocked` (HARD_BLOCK ∪ tầng C — phòng thủ thêm
    lớp), insert `programs` `on conflict (intel_item_id) do nothing`,
    `conn.commit()` tường minh. `--dry-run` không ghi.
  - `reminders(programs, today)` THUẦN: hạn − ngày phát hiện (VN) ≥ 7 → nhắc
    T-7 và T-2; < 7 → nhắc NGAY ngày phát hiện (`phat_hien_muon`) + T-2 nếu
    T-2 sau ngày phát hiện; hạn < today → không nhắc; không hạn → mục
    "chưa công bố hạn".
  - Báo cáo `--list` là BẢN NHÁP nội bộ — agent KHÔNG tự đăng ký/gửi gì.

Chạy:
  python -m agents.da_radar --scan [--days N] [--dry-run]
  python -m agents.da_radar --list [--date YYYY-MM-DD] [--out-dir DIR]
Exit: 0 ok · 1 cấu hình nguồn hỏng · 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import json
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from agents.report import REPORTS_DIR, write_report
from crawler.intel import SOURCES_FILE, is_blocked, load_sources, tier_c_hosts
from ingest.lead_store import connect
from pipelines import kb_filter
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, vn_date
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

TOPIC = "chuong_trinh"
NO_ORG = "chưa công bố"
MAX_TEXT = 2000          # cắt trước regex
# Từ khóa "mạnh" (khoảng lazy ≤40 tới ngày, không vượt .;) và "hạn" TRẦN
# (dễ nhầm: hạn chế, giới hạn, thời hạn, hạn hán, TNHH "hữu hạn"... → loại;
# khoảng ngắn hơn, không vượt dấu phẩy; bản không dấu: ngày phải đứng NGAY
# sau — "Han Quoc 25/10" không phải hạn).
_KW_ACC = ("hạn chót", "hạn đăng ký", "hạn nộp", "trước ngày", "đến hết ngày",
           "đăng ký đến", "deadline")
_BARE_NOT_BEFORE = ("giới", "thời", "quyền", "hữu", "vô", "kỳ")
_BARE_NOT_AFTER = ("chế", "hán", "mặn", "mức", "ngạch")
_DATE = (r"(?<![\d.,/-])(?:(?P<d1>\d{1,2})/(?P<m1>\d{1,2})(?:/(?P<y1>\d{4}))?"
         r"|(?P<d2>\d{1,2})-(?P<m2>\d{1,2})-(?P<y2>\d{4})"
         r"|(?P<d3>\d{1,2})\.(?P<m3>\d{1,2})\.(?P<y3>\d{4}))"
         r"(?![\d.,/-]?\d)")
# "từ X đến Y" / "X - Y" ngay sau ngày đầu → hạn là Y.
_RANGE_END = re.compile(r" ?(?:(?:đến|tới|den|toi)(?: (?:hết|het))?"
                        r"(?: (?:ngày|ngay))?|[-–]) ?" + _DATE, re.IGNORECASE)


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s.casefold()).replace("đ", "d")
    return "".join(c for c in s if not unicodedata.combining(c))


def _kw_re(words, bare: str, not_before, not_after, bare_gap: str
           ) -> re.Pattern:
    alt = "|".join(r"\s+".join(map(re.escape, w.split()))
                   for w in sorted(words, key=len, reverse=True))
    nb = "".join(f"(?<!{re.escape(w)} )" for w in not_before)
    na = "|".join(map(re.escape, not_after))
    # Văn bản đã gom khoảng trắng về 1 dấu cách trước khi so.
    return re.compile(rf"(?<!\w)(?:(?:{alt})(?!\w)[^.;]{{0,40}}?"
                      rf"|{nb}{bare}(?! (?:{na})(?!\w))(?!\w){bare_gap})"
                      rf"{_DATE}", re.IGNORECASE)


_DL_ACC = _kw_re(_KW_ACC, "hạn", _BARE_NOT_BEFORE, _BARE_NOT_AFTER,
                 r"[^.;,]{0,40}?")
_DL_ASC = _kw_re(tuple(map(_fold, _KW_ACC)), "han",
                 tuple(map(_fold, _BARE_NOT_BEFORE)),
                 tuple(map(_fold, _BARE_NOT_AFTER)),
                 r"[ :]*(?:(?:den|toi|la) )?(?:(?:het )?ngay )?")
_ORG_RE = re.compile(
    r"(?<!\w)(?i:do|bởi)\s+((?:Sở|Bộ|Cục|UBND|Hiệp hội|Hội|Trung tâm|Ban"
    r"|Liên minh)(?!\w)[^,.;]{0,160}?)(?=\s+(?i:tổ\s+chức|phối\s+hợp)(?!\w)"
    r"|\s*[,.;]|\s*$)")


def _to_date(m, ref: date | None) -> date | None:
    n = next(i for i in (1, 2, 3) if m.group(f"d{i}"))
    d, mo, y = (int(m.group(f"{k}{n}") or 0) for k in ("d", "m", "y"))
    try:
        if y:
            return date(y, mo, d)
        if ref is None:
            return None
        out = date(ref.year, mo, d)
        return out if out >= ref else date(ref.year + 1, mo, d)
    except ValueError:
        return None


def deadline_of(text, published_at) -> tuple[date | None, str | None]:
    """→ (hạn, đoạn văn chứa hạn ≤120) | (None, None). Thuần."""
    if not isinstance(text, str) or not text:
        return None, None
    t = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text[:MAX_TEXT]))
    bare = _fold(t) == t.casefold()
    ref = None
    if isinstance(published_at, datetime):
        ref = vn_date(published_at) if published_at.tzinfo else \
            published_at.date()
    elif isinstance(published_at, date):
        ref = published_at
    for m in (_DL_ASC if bare else _DL_ACC).finditer(t):
        out, end = _to_date(m, ref), m.end()
        if out is None:             # sai lịch (31/02) / thiếu năm + ngày đăng
            continue
        r = _RANGE_END.match(t, end)
        if r and (y := _to_date(r, ref)) is not None and y >= out:
            out, end = y, r.end()
        return out, t[m.start():end].strip()[:120]
    return None, None


def organizer_of(text) -> str:
    """Đơn vị tổ chức theo luật; không chắc → 'chưa công bố'. Thuần."""
    if not isinstance(text, str) or not text:
        return NO_ORG
    m = _ORG_RE.search(unicodedata.normalize("NFC", text[:MAX_TEXT]))
    if not m:
        return NO_ORG
    return re.sub(r"\s+", " ", m.group(1)).strip()[:120] or NO_ORG


def _tier_c(cfg) -> tuple[str, ...]:
    if cfg is None:
        cfg, errs = load_sources(SOURCES_FILE)
        if errs:
            raise ValueError("data/intel_sources.json hỏng: " + "; ".join(errs))
    return tier_c_hosts(cfg)


_SELECT = ("select id, url, source, tier, title, snippet, published_at,"
           " fetched_at, flags from intel_items"
           " where %s = any(topics) and fetched_at >= %s order by id")
_INSERT = ("insert into programs (intel_item_id, title, organizer, deadline,"
           " deadline_text, url, source, tier, flags)"
           " values (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
           " on conflict (intel_item_id) do nothing")


def scan(conn, *, since_days: int = 30, now: datetime | None = None,
         cfg: dict | None = None, dry_run: bool = False, log=print) -> dict:
    """intel_items(chuong_trinh) → programs. Trả số đếm."""
    blocked_hosts = _tier_c(cfg)
    now = now or datetime.now(VN_TZ)
    st = dict.fromkeys(("seen", "inserted", "dup", "skipped_ruou",
                        "blocked"), 0)
    rows = conn.execute(_SELECT, (TOPIC, now - timedelta(days=since_days))
                        ).fetchall()
    for (iid, url, src, tier, title, snippet, pub, fetched, flags) in rows:
        st["seen"] += 1
        text = f"{title or ''}. {snippet or ''}"
        if "ruou" in (flags or ()) or kb_filter.is_alcohol(text):
            st["skipped_ruou"] += 1
            continue
        try:
            host = urlsplit(url).hostname or ""
        except ValueError:
            host = ""
        if not host or is_blocked(host, blocked_hosts):   # fail-closed
            st["blocked"] += 1
            log("[blocked] " + json.dumps({"intel_item_id": iid,
                                           "host": host[:200]}))
            continue
        deadline, dl_text = deadline_of(text, pub or fetched)
        if dry_run:
            hit = conn.execute("select 1 from programs where intel_item_id"
                               " = %s", (iid,)).fetchone()
            st["dup" if hit else "inserted"] += 1
            continue
        cur = conn.execute(_INSERT, (
            iid, title[:300], organizer_of(text), deadline, dl_text, url,
            src, tier, [f for f in (flags or ()) if f != "ruou"]))
        st["inserted" if cur.rowcount == 1 else "dup"] += 1
    conn.commit()           # ghi (hoặc đóng tx đọc khi dry-run)
    return st


def reminders(programs, today: date) -> list[dict]:
    """Lịch nhắc từng chương trình (thuần). Mỗi phần tử: {id, title,
    deadline, remind_on, kind ∈ T-7|T-2|phat_hien_muon|chua_cong_bo_han}."""
    out = []
    for p in programs:
        base = {"id": p.get("id"), "title": p.get("title"),
                "deadline": p.get("deadline")}
        dl = p.get("deadline")
        if dl is None:
            out.append({**base, "remind_on": None,
                        "kind": "chua_cong_bo_han"})
            continue
        if dl < today:
            continue                      # hạn đã qua — không nhắc
        seen = p.get("first_seen") or today
        found = vn_date(seen) if isinstance(seen, datetime) else seen
        t2 = dl - timedelta(days=2)
        if (dl - found).days >= 7:
            out += [{**base, "remind_on": dl - timedelta(days=7),
                     "kind": "T-7"},
                    {**base, "remind_on": t2, "kind": "T-2"}]
        else:
            out.append({**base, "remind_on": found,
                        "kind": "phat_hien_muon"})
            if t2 > found:
                out.append({**base, "remind_on": t2, "kind": "T-2"})
    return out


def _cell(s, n: int = 160) -> str:
    s = re.sub(r"\s+", " ", _mask_pii(str(s or ""))).strip()[:n]
    return s.replace("|", "\\|") or "—"


def _d(x) -> str:
    return x.strftime("%d/%m/%Y") if x else "chưa công bố"


_KIND_VN = {"T-7": "còn 7 ngày", "T-2": "còn 2 ngày",
            "phat_hien_muon": "PHÁT HIỆN MUỘN (còn < 7 ngày)"}


def render_list(programs: list[dict], today: date) -> str:
    """Markdown báo cáo radar (thuần)."""
    live = [p for p in programs
            if p.get("deadline") is None or p["deadline"] >= today]
    rem = reminders(live, today)
    L = [f"# Radar chương trình — {today:%d/%m/%Y}", "",
         ("Nguồn: `intel_items` chủ đề `chuong_trinh` (collector v7.0, "
          "tầng A/B). Giờ VN."), "", "## Nhắc hôm nay", ""]
    L += [f"- #{r['id']} {_cell(r['title'], 120)} — hạn {_d(r['deadline'])}"
          f" ({_KIND_VN[r['kind']]})" for r in rem
          if r["kind"] != "chua_cong_bo_han" and r["remind_on"] == today] \
        or ["- (không có)"]
    L += ["", "## Chương trình còn hạn / chưa công bố hạn", "",
          ("| # | Chương trình | Đơn vị tổ chức | Hạn | Trích hạn | Link |"
           " Nguồn |"), "|---|---|---|---|---|---|---|"]
    L += [f"| {p['id']} | {_cell(p['title'])} | {_cell(p['organizer'], 120)}"
          f" | {_d(p.get('deadline'))} | {_cell(p.get('deadline_text'), 120)}"
          f" | {_cell(p['url'], 300)} | {_cell(p['source'], 64)} |"
          for p in live] or ["| — | (không có) | | | | | |"]
    L += ["", "## Chưa công bố hạn (theo dõi tiếp)", ""]
    L += [f"- #{r['id']} {_cell(r['title'], 120)}" for r in rem
          if r["kind"] == "chua_cong_bo_han"] or ["- (không có)"]
    L += ["", "---", ("*BẢN NHÁP — KHÔNG tự đăng ký/gửi. GĐ dự án xem "
                      "rồi quyết định tham gia (hồ sơ qua `agents.da_hoso`)"
                      ".*"), ""]
    return "\n".join(L)


_PROG_COLS = ("id", "title", "organizer", "deadline", "deadline_text", "url",
              "source", "first_seen")


def _date_arg(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError("ngày phải dạng YYYY-MM-DD") from None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_radar",
        description="DA-03 radar chương trình (chỉ đọc intel_items — không "
                    "tự ra mạng, không tự đăng ký)")
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--date", type=_date_arg)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    a = ap.parse_args(argv)
    if a.scan + a.list != 1:
        ap.error("cần đúng 1 thao tác: --scan | --list")
    if a.scan and a.date:
        ap.error("--date chỉ dùng với --list")
    if a.list and a.dry_run:
        ap.error("--dry-run chỉ dùng với --scan")
    if not 1 <= a.days <= 3660:
        ap.error("--days phải trong 1..3660")
    cfg = None
    if a.scan:
        cfg, errs = load_sources(SOURCES_FILE)
        if errs:
            print("[error] data/intel_sources.json hỏng — không quét",
                  file=sys.stderr)
            return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.scan:
            if a.dry_run:
                st = scan(conn, since_days=a.days, cfg=cfg, dry_run=True)
            else:
                with job_run("agents.da_radar") as jr:
                    st = scan(conn, since_days=a.days, cfg=cfg)
                    jr["detail"] = (f"inserted={st['inserted']} "
                                    f"blocked={st['blocked']}")
            print(f"[done] seen={st['seen']} "
                  f"{'would_insert' if a.dry_run else 'inserted'}="
                  f"{st['inserted']} dup={st['dup']} skipped_ruou="
                  f"{st['skipped_ruou']} blocked={st['blocked']}"
                  + (" (dry-run, không ghi)" if a.dry_run else ""))
            return 0
        today = a.date or datetime.now(VN_TZ).date()
        progs = [dict(zip(_PROG_COLS, r)) for r in conn.execute(
            f"select {', '.join(_PROG_COLS)} from programs"
            " order by deadline nulls last, id").fetchall()]
        conn.commit()
        path = write_report(render_list(progs, today), a.out_dir,
                            f"da-radar-{today:%Y-%m-%d}.md")
        print(f"[done] {len(progs)} chương trình → {path}")
        return 0
    except kb_filter.KbFilterError as e:
        print(f"[error] bộ lọc rượu hỏng: {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
