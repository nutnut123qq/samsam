"""v7.1 W71.4/W71.5 — Summarizer & Bulletin intel (WP09): bản tin thị
trường ngày/tuần từ `intel_items` (v7.0) + cảnh báo đỏ đang mở + sức khỏe
nguồn; tùy chọn gợi ý chủ đề nội dung vào hàng duyệt chung.

Contract:
  - Kỳ = `pipelines.period.period_bounds(period, ref)` giờ VN; tin thuộc kỳ
    theo `fetched_at`. Nhóm theo `TOPICS` (sâm, TPBVSK, giới trẻ, quảng cáo,
    đối thủ, văn bản pháp luật), trần `PER_TOPIC` tin/chủ đề + "(+N tin
    nữa)".
  - v10.2 PC-A8 chủ đề `phap_ly` (Văn bản pháp luật): mỗi dòng tiêu đề +
    nguồn + ngày VN `YYYY-MM-DD` (`published_at`, thiếu → `fetched_at` kèm
    "(ngày thu)") + link; KHÔNG diễn giải pháp lý (không tóm tắt LLM,
    không gợi ý nội dung — `NO_CONTENT_TOPICS`), dòng chân "Pháp chế
    quyết".
  - Khối "NỘI BỘ – trích nguồn": tiêu đề + nguồn + ngày VN + link, giữ
    nguyên từ ngữ nguồn — CHỈ để đọc, KHÔNG có đường sang hàng duyệt nội
    dung (module không ghi bảng nào ngoài `director.submit` cho gợi ý).
  - Tóm tắt LLM: CHỈ khi `--llm` VÀ `llm.enabled is True` trong
    `data/intel_sources.json` (mặc định TẮT → bản tin tất định, 0 lời gọi
    gateway). Mỗi chủ đề 1 lời gọi `llm_gateway.chat("intel", ...)`, input
    CHỈ tiêu đề + trích đã lưu (≤300 ký tự/tin, bỏ link, ≤10 tin) — không
    mở bài gốc. Đầu ra `clean_text` TRƯỚC rồi `guardrail.check(...)["ok"]
    is True` mới dùng; vi phạm → BỎ + dòng "[đã loại ...]" + đếm
    `llm_guardrail_fail`. `GatewayError` → tắt LLM phần còn lại, bản tin
    vẫn ra.
  - `--suggest`: chủ đề có ≥2 tin → 1 gợi ý từ TEMPLATE tất định (không
    trích tiêu đề/link/trích tin, không tên/giá SKU), guardrail ok=True mới
    `director.submit(..., "intel_topic", ...)` (risk medium theo cấu hình
    khối → luật tự duyệt chỉ áp low không bao giờ áp được). Module KHÔNG
    gọi hàm duyệt; Quản lý MXH duyệt. Đã có mục cùng object_id → bỏ qua.
  - Output: `data/reports/intel-bulletin-<period>-<YYYY-MM-DD>.md` (atomic,
    gitignored) — BẢN NHÁP, hệ thống không tự gửi.

Chạy: `python scripts/intel_bulletin.py --period day|week
[--date YYYY-MM-DD] [--llm] [--suggest]`
Exit: 0 ok · 1 DB down/lỗi DB/cấu hình khối lỗi/không ghi được file ·
2 tham số sai.
"""

import argparse
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from pathlib import Path

import psycopg
from psycopg.errors import UniqueViolation

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from agents.report import REPORTS_DIR, write_report
from crawler.intel import SOURCES_FILE, clean_text, load_sources
from ingest.lead_store import connect
from pipelines import director, guardrail, intel_alert, llm_gateway
from pipelines.job_runs import clean_detail, job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.pii import _mask_pii

TOPICS = ("sam", "tpbvsk", "gioi_tre", "quang_cao", "doi_thu", "phap_ly")
# Văn bản pháp luật KHÔNG phải chủ đề truyền thông và không được diễn giải:
# 0 tóm tắt LLM, 0 gợi ý nội dung (v10.2 PC-A8).
NO_CONTENT_TOPICS = frozenset({"phap_ly"})
LEGAL_FOOTER = "Diễn giải/đổi rule: Pháp chế quyết — agent không kết luận."
TOPIC_LABELS = {
    "sam": "Sâm & thị trường sâm",
    # Không viết đủ "bảo vệ sức khỏe": guardrail coi là claim công dụng.
    "tpbvsk": "TPBVSK — quy định & thị trường thực phẩm chức năng",
    "gioi_tre": "Giới trẻ & xu hướng tiêu dùng",
    "quang_cao": "Quảng cáo & người có ảnh hưởng",
    "doi_thu": "Đối thủ",
    "phap_ly": "Văn bản pháp luật",
}
# Góc nội dung TẤT ĐỊNH cho gợi ý chủ đề — chung về thương hiệu/vùng trồng,
# không trích tin, không tên/giá SKU, không công dụng.
ANGLES = {
    "sam": "câu chuyện vùng trồng Ngọc Linh, quy trình chăm sóc và truy "
           "xuất nguồn gốc",
    "tpbvsk": "hướng dẫn đọc nhãn và thông tin công bố sản phẩm trên bao bì",
    "gioi_tre": "quà tặng và phong cách sống của người trẻ",
    "quang_cao": "minh bạch thông tin quảng cáo, nội dung đúng quy định",
    "doi_thu": "điểm khác biệt về vùng trồng và quy trình của thương hiệu "
               "Sâm Sâm",
}
QUOTE_HEAD = "NỘI BỘ – trích nguồn, KHÔNG dùng làm nội dung"
DROPPED = "[đã loại: tóm tắt vi phạm guardrail]"
FOOTER = ("*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi chuyển tay; "
          "khối trích nguồn chỉ để đọc nội bộ.*")
PER_TOPIC = 20
MAX_ROWS = 2000
LLM_ITEMS = 10
SEG_MAX = 300
MIN_SUGGEST = 2
SUGGEST_BY = "agent:intel_bulletin"
SUM_PROMPT = ("Tóm tắt nhóm tin thị trường sau trong 2-3 câu tiếng Việt, "
              "trung tính, CHỈ dựa trên tiêu đề và trích dẫn được cung cấp. "
              "Không nêu công dụng sức khỏe, không khuyến nghị mua bán.")
_URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)\S*")
_FAIL_RE = re.compile(r"\bfail=([a-z0-9_,-]+)")
# Ký tự markdown/HTML trong text NGOÀI (tiêu đề RSS, tóm tắt LLM) → escape:
# tiêu đề kiểu "![](https://...)" không thành ảnh/link tự tải khi mở bản
# tin (giữ nguyên từ ngữ, chỉ vô hiệu cú pháp).
_MD_RE = re.compile(r"([\\`\[\]<>!])")
_SAFE_URL_RE = re.compile(r"https?://[^\s<>`]+")
_ITEMS_SQL = (
    "select id, title, snippet, url, source, published_at, fetched_at,"
    " topics, flags from intel_items where fetched_at >= %s"
    " and fetched_at < %s order by fetched_at desc, id desc limit %s")
_JOBS_SQL = (
    "select started_at, ok, detail from job_runs where job = 'crawler.intel'"
    " and started_at >= %s and started_at < %s order by started_at desc")
_ITEM_COLS = ("id", "title", "snippet", "url", "source", "published_at",
              "fetched_at", "topics", "flags")


def _oneline(s, n: int = 160) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _md(s, n: int = 160) -> str:
    return _MD_RE.sub(r"\\\1", _oneline(s, n))


def _link(url) -> str:
    u = _oneline(url, 300)
    return f"<{u}>" if _SAFE_URL_RE.fullmatch(u) else _md(u, 300)


def _vn_day(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y") if ts else "?"


def _db_msg(e: Exception) -> str:
    diag = getattr(e, "diag", None)
    return getattr(diag, "message_primary", None) or type(e).__name__


def collect(conn, start: datetime, end: datetime, now: datetime) -> dict:
    """Đọc DB (chỉ SELECT) → dữ liệu thô cho `render`."""
    rows = [dict(zip(_ITEM_COLS, r)) for r in conn.execute(
        _ITEMS_SQL, (start, end, MAX_ROWS)).fetchall()]
    groups = {t: [d for d in rows if t in (d["topics"] or ())]
              for t in TOPICS}
    jobs = conn.execute(_JOBS_SQL, (start, end)).fetchall()
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    alerts = intel_alert.open_alerts(conn, now)
    fail_ids: list[str] = []
    for _, _, det in jobs:
        m = _FAIL_RE.search(det or "")
        for sid in (m.group(1).split(",") if m else ()):
            if sid and sid != "-" and sid not in fail_ids:
                fail_ids.append(sid)
    cfg, errs = load_sources(SOURCES_FILE)
    ab = [s for s in (cfg or {}).get("sources", ())
          if s.get("tier") in ("A", "B")]
    return {
        "n_items": len(rows), "groups": groups, "alerts": alerts,
        "jobs": {"runs": len(jobs),
                 "failed": sum(1 for _, ok, _ in jobs if ok is not True),
                 "last_detail": clean_detail(jobs[0][2]) if jobs else None,
                 "fail_ids": fail_ids},
        "sources": {"ab": len(ab),
                    "not_approved": sum(1 for s in ab
                                        if s.get("status") != "duyet"),
                    "errors": len(errs)},
        "suggested": [],
    }


def _quote(d: dict) -> str:
    when = d.get("published_at") or d.get("fetched_at")
    return (f"> - {_md(d['title'])} — {_md(d['source'], 40)} · "
            f"{_vn_day(when)} · {_link(d['url'])}")


def _legal_quote(d: dict) -> str:
    """Dòng tin văn bản pháp luật: ngày ISO bắt buộc (thiếu published_at →
    fetched_at + "(ngày thu)"), link http(s) — không diễn giải."""
    pub, got = d.get("published_at"), d.get("fetched_at")
    if pub:
        day = pub.astimezone(VN_TZ).strftime("%Y-%m-%d")
    elif got:
        day = got.astimezone(VN_TZ).strftime("%Y-%m-%d") + " (ngày thu)"
    else:
        day = "? (chưa rõ ngày)"
    return (f"> - {_md(d['title'])} — {_md(d['source'], 40)} · {day} · "
            f"{_link(d['url'])}")


def render(data: dict, start: datetime, end: datetime,
           summaries: dict | None = None, period: str = "day") -> str:
    """THUẦN — bản tin markdown. `summaries` {chủ đề: text | None (bị
    guardrail loại)}; thiếu key = không có tóm tắt LLM."""
    summaries = summaries or {}
    last = (end - timedelta(days=1)).date()
    kind = "ngày" if period == "day" else ("tuần" if period == "week"
                                           else period)
    L = [f"# Bản tin thị trường (intel) — {kind} "
         f"{start.date():%d/%m/%Y}" + ("" if last == start.date()
                                        else f"–{last:%d/%m/%Y}"), "",
         (f"Kỳ giờ VN · {data['n_items']} tin mới · nguồn: bảng "
          "`intel_items` (tiêu đề + trích ≤300 ký tự + link, không toàn "
          "văn)"), "",
         "## Cảnh báo đỏ đang mở (chưa xác nhận)", ""]
    for a in data["alerts"][:50]:
        esc = "ĐÃ LEO THANG" if a["escalated"] else "chưa leo thang"
        rcp = (", ".join(a["recipients"]) if a["recipients"]
               else "CHƯA AI NHẬN (thiếu người nhận độc lập)")
        L.append(f"- #{a['id']} — {a['age_h']} giờ — {esc} — "
                 f"{_md(_mask_pii(a['title'] or ''), 120)} — {rcp}")
    if len(data["alerts"]) > 50:
        L.append(f"- (+{len(data['alerts']) - 50} cảnh báo nữa)")
    if not data["alerts"]:
        L.append("- (không có)")
    L += ["", ("Xác nhận: `python -m pipelines.intel_alert --ack ID --by "
               "\"Tên\"`"), "", "## Tin theo chủ đề", ""]
    for i, t in enumerate(TOPICS, 1):
        items = data["groups"].get(t, [])
        L += [f"### {i}. {TOPIC_LABELS[t]} — {len(items)} tin", ""]
        if t in summaries:
            L.append(f"Tóm tắt (AI, đã qua guardrail): "
                     f"{_md(summaries[t], 600)}" if summaries[t] else DROPPED)
            L.append("")
        if not items:
            L += ["- (không có tin mới)", ""]
            continue
        L.append(f"> **{QUOTE_HEAD}**")
        q = _legal_quote if t == "phap_ly" else _quote
        L += [q(d) for d in items[:PER_TOPIC]]
        if len(items) > PER_TOPIC:
            L.append(f"> - (+{len(items) - PER_TOPIC} tin nữa)")
        if t == "phap_ly":
            L.append(f"> {LEGAL_FOOTER}")
        L.append("")
    if data.get("suggested"):
        L += ["## Gợi ý chủ đề nội dung (chờ Quản lý MXH duyệt)", ""]
        L += [f"- #{qid} `intel_topic` {TOPIC_LABELS.get(t, t)} — "
              f"{'mới' if new else 'đã có'} — chờ Quản lý MXH duyệt"
              for t, qid, new in data["suggested"]]
        L.append("")
    j, s = data["jobs"], data["sources"]
    L += ["## Nguồn lỗi / robots chặn", "",
          f"- Lượt `crawler.intel` trong kỳ: {j['runs']} (lỗi {j['failed']})",
          "- Nguồn lỗi trong kỳ: " + (", ".join(j["fail_ids"]) or "(không có)"),
          f"- Chi tiết lượt gần nhất: {_md(j['last_detail'] or '—', 300)}",
          f"- Nguồn A/B chưa duyệt: {s['not_approved']}/{s['ab']}"
          + (" · file nguồn LỖI" if s["errors"] else ""), "", "---",
          FOOTER, ""]
    return "\n".join(L)


def _segment(d: dict) -> str:
    raw = f"{d.get('title') or ''} — {d.get('snippet') or ''}"
    return _URL_RE.sub("", clean_text(raw, SEG_MAX)).strip()


def summarize(groups: dict) -> tuple[dict, int]:
    """Tóm tắt LLM theo chủ đề → ({chủ đề: text|None}, số bị guardrail loại)."""
    out, n_fail = {}, 0
    for t in TOPICS:
        items = groups.get(t) or []
        if not items or t in NO_CONTENT_TOPICS:
            continue
        body = "\n".join(f"- {_segment(d)}" for d in items[:LLM_ITEMS])
        msgs = [{"role": "system", "content": SUM_PROMPT},
                {"role": "user", "content": f"Chủ đề: {TOPIC_LABELS[t]}\n"
                                            f"{body}"}]
        try:
            resp = llm_gateway.chat("intel", msgs, max_tokens=300,
                                    feature="intel-01.1")
            text = resp.choices[0].message.content
        except llm_gateway.GatewayError as e:
            print(f"[warn] LLM tắt phần còn lại ({type(e).__name__}) — bản "
                  "tin tất định", flush=True)
            break
        except (AttributeError, IndexError, TypeError):
            continue
        # Làm sạch TRƯỚC rồi guardrail, dùng ĐÚNG chuỗi đã kiểm (entity
        # "&#99;hữa" giải mã thành "chữa" — bài học v7.0).
        s = clean_text(text) if isinstance(text, str) else ""
        if not s:
            continue
        if guardrail.check(s).get("ok") is True:
            out[t] = s
        else:
            out[t] = None
            n_fail += 1
    return out, n_fail


def suggestion(topic: str, n: int, start: datetime, end: datetime,
               period: str) -> tuple[str, str]:
    """(title, payload) — TEMPLATE tất định, không trích tin."""
    last = (end - timedelta(days=1)).date()
    title = f"Gợi ý chủ đề nội dung: {TOPIC_LABELS[topic]}"
    kind = "tuần" if period == "week" else "ngày"
    payload = (f"{title}. Kỳ {kind} {start.date():%d/%m/%Y}–"
               f"{last:%d/%m/%Y}: {n} tin mới về chủ đề này. Góc nội dung "
               f"đề xuất: {ANGLES[topic]}. Chỉ là gợi ý nội bộ từ bản tin "
               "thị trường (không trích tin gốc) — Quản lý MXH duyệt trước "
               "khi giao viết.")
    return title, payload


def suggest(conn, period: str, start: datetime, end: datetime,
            groups: dict) -> list[tuple[str, int, bool]]:
    """Gợi ý → hàng duyệt chung (`intel_topic`). → [(chủ đề, id, mới?)]."""
    cfg = director.load_config("intel")
    out = []
    for t in TOPICS:
        n = len(groups.get(t) or [])
        if n < MIN_SUGGEST or t in NO_CONTENT_TOPICS:
            continue
        title, payload = suggestion(t, n, start, end, period)
        if guardrail.check(payload).get("ok") is not True:
            print(f"[warn] gợi ý chủ đề {t} vi phạm guardrail — bỏ",
                  flush=True)
            continue
        oid = f"{period}-{start:%Y%m%d}-{t}"
        row = conn.execute("select id from approval_queue where object_type"
                           " = 'intel_topic' and object_id = %s order by id"
                           " desc limit 1", (oid,)).fetchone()
        conn.commit()
        if row:
            out.append((t, row[0], False))
            continue
        try:
            qid = director.submit(conn, "intel", "intel_topic", oid, title,
                                  payload, created_by=SUGGEST_BY, cfg=cfg)
        except UniqueViolation:   # tiến trình khác vừa đẩy cùng mục
            continue
        out.append((t, qid, True))
    return out


def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python scripts/intel_bulletin.py",
        description="Bản tin thị trường intel (BẢN NHÁP, không tự gửi)")
    ap.add_argument("--period", choices=("day", "week"), default="day")
    ap.add_argument("--date", default=None,
                    help="YYYY-MM-DD — ngày VN trong kỳ (mặc định hôm nay)")
    ap.add_argument("--llm", action="store_true",
                    help="tóm tắt LLM (chỉ khi llm.enabled = true)")
    ap.add_argument("--suggest", action="store_true",
                    help="đẩy gợi ý chủ đề vào hàng duyệt (Quản lý MXH duyệt)")
    args = ap.parse_args(argv)
    try:
        day = date.fromisoformat(args.date) if args.date else None
    except ValueError:
        ap.error("--date sai định dạng YYYY-MM-DD")
    now = now or datetime.now(VN_TZ)
    try:
        start, end = period_bounds(args.period, day or now)
    except OverflowError:   # --date 9999-12-31: cuối kỳ vượt năm 9999
        ap.error("--date ngoài khoảng tính được kỳ")
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", flush=True)
        return 1
    try:
        data = collect(conn, start, end, now)
        if args.suggest:
            data["suggested"] = suggest(conn, args.period, start, end,
                                        data["groups"])
    except director.DirectorConfigError as e:
        print(f"[err] cấu hình khối intel lỗi: {e}", flush=True)
        return 1
    except psycopg.Error as e:
        print(f"[err] lỗi DB: {_db_msg(e)} (thiếu bảng → chạy `python "
              "scripts/apply_schema.py`)", flush=True)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    summaries, n_fail = {}, 0
    if args.llm:
        cfg, _ = load_sources(SOURCES_FILE)
        if cfg is not None and cfg["llm"].get("enabled") is True:
            summaries, n_fail = summarize(data["groups"])
        else:
            print("[warn] LLM tắt — chờ Pháp chế xác nhận (bản tin tất "
                  "định)", flush=True)
    text = render(data, start, end, summaries, args.period)
    try:
        # P8.4: tin thu thật (intel_items, không đường mẫu).
        path = write_report(text, REPORTS_DIR, f"intel-bulletin-{args.period}"
                                               f"-{start:%Y-%m-%d}.md",
                            sample=False)
    except OSError as e:
        print(f"[err] không ghi được bản tin ({type(e).__name__})",
              flush=True)
        return 1
    new_sug = sum(1 for _, _, new in data["suggested"] if new)
    print(f"[done] {path} items={data['n_items']} "
          f"open_alerts={len(data['alerts'])} suggested_new={new_sug} "
          f"suggested_total={len(data['suggested'])} "
          f"llm_summaries={sum(1 for v in summaries.values() if v)} "
          f"llm_guardrail_fail={n_fail}", flush=True)
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("scripts.intel_bulletin") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
