"""Báo cáo tuần intel (v7.2, WP09) — `python scripts/intel_weekly.py
[--week YYYY-MM-DD] [--llm]`.

Contract:
  - `--week` = ngày bất kỳ → tuần thứ Hai..Chủ nhật chứa nó; mặc định tuần
    ĐỦ gần nhất theo giờ VN; ngày hỏng → exit 2 (trước khi connect).
  - Markdown ra stdout, TẤT ĐỊNH (khóa sắp xếp tường minh, không in giờ
    chạy — 2 lần chạy cùng dữ liệu cho ra byte y hệt). 4 mục: (1) Đối thủ —
    lệch giá/KM so giá `list` golden (mỗi số kèm obs#/nguồn và
    price_list#/đã duyệt hay chưa); (2) Trend — giá trị tuần mới nhất từng
    từ khóa + tăng đột biến trong tuần (trung vị N tuần, ghi query_id) +
    related RISING của file mới nhất (cờ rượu ghi chú riêng); (3) Social —
    CHỈ ĐẾM theo kênh × nhãn (nhạy cảm riêng), không in nội dung bình luận;
    (4) Tin `intel_items` trong tuần theo chủ đề (≤5 tiêu đề/chủ đề + link).
    Mục rỗng → "chưa có dữ liệu tuần này".
  - CHỈ ĐỌC: connect `connect_timeout=10`, `read_only = True`; không ghi
    bảng nào, không gửi ai, không đường sang hàng duyệt nội dung.
  - `--llm` (mặc định tắt): chỉ khi `llm.enabled is True` trong
    `data/intel_sources.json` (cùng cổng Pháp chế v7.0); input = mục 1+2+4
    đã render (KHÔNG mục social); 1 lời gọi `chat("intel", ...)`; output qua
    `guardrail.check` — không ok → bỏ tóm tắt + `[warn]`; lỗi gateway →
    `[warn]`, báo cáo vẫn in, exit 0. `[warn]` in ra stderr.
"""

import argparse
import os
import sys
from datetime import datetime, time, timedelta
from pathlib import Path

import psycopg
from dotenv import load_dotenv

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from crawler.intel import SOURCES_FILE, load_sources
from ingest import intel_import as ii
from ingest.market_csv import _clean
from pipelines import guardrail, llm_gateway

EMPTY = "_chưa có dữ liệu tuần này_"
TABLES = ("intel_imports", "competitor_observations", "trends_weekly",
          "trends_related", "social_mentions", "intel_items",
          "price_list")
TITLES_PER_TOPIC = 5
LLM_PROMPT = ("Tóm tắt báo cáo tình báo thị trường tuần dưới đây trong tối "
              "đa 5 gạch đầu dòng tiếng Việt, trung tính, chỉ dựa trên số "
              "liệu có trong báo cáo, không đề xuất giá, không nói về công "
              "dụng sức khỏe.")


def _md(s, n: int = 120) -> str:
    """Text từ DB vào ô Markdown: bỏ ký tự điều khiển, cắt, chặn '|'."""
    return _clean(s, n).replace("|", "/")


def _vnd(n) -> str:
    return "—" if n is None else f"{n:,}".replace(",", ".")


def _warn(msg: str) -> None:
    print(f"[warn] {msg}", file=sys.stderr, flush=True)


def week_bounds(day):
    mon = day - timedelta(days=day.weekday())
    sun = mon + timedelta(days=6)
    start = datetime.combine(mon, time(), ii.VN_TZ)
    return mon, sun, start, start + timedelta(days=7)


def section_competitor(conn, mon) -> list[str]:
    gaps = ii.competitor_gaps(conn, mon)
    out = ["## 1. Đối thủ — lệch giá/KM so giá golden (chỉ đọc)", ""]
    if not gaps:
        return out + [EMPTY, ""]
    out += [("| Ngày | Đối thủ | Kênh | Sản phẩm | SKU mình | Giá đối thủ "
             "(nguồn) | Giá KM | Golden (nguồn) | Lệch |"),
            "|---|---|---|---|---|---|---|---|---|"]
    for g in gaps:
        if g["golden_ref"]:
            gold = (f"{_vnd(g['golden_vnd'])} ({g['golden_ref']} "
                    f"{g['golden_channel']}, "
                    f"{'đã duyệt' if g['golden_approved'] else 'CHƯA duyệt'})")
            gap = f"{g['gap_pct'] * 100:+.1f}%"
        else:
            gold, gap = g["note"], "—"
        out.append(
            f"| {g['observed_on']} | {_md(g['competitor'], 60)} | "
            f"{g['channel']} | {_md(g['product_name'], 80)} | "
            f"{_md(g['sku_key'], 60)} | {_vnd(g['price_vnd'])} "
            f"({g['obs_ref']}: {_md(g['source_ref'], 160)}) | "
            f"{_vnd(g['promo_price_vnd'])} | {gold} | {gap} |")
    return out + ["", ("Ghi chú: số liệu đối thủ do người ghi tay — agent "
                        "không cào sàn, không đề xuất giá."), ""]


def section_trend(conn, sun, mon, cfg) -> list[str]:
    out = ["## 2. Trend — Google Trends (file xuất tay)", ""]
    groups: dict = {}
    for imp, qid, kw, geo, week, val in conn.execute(
            "select import_id, query_id, keyword, geo, week, value"
            " from trends_weekly where week <= %s"
            " order by query_id, keyword, geo, week", (sun,)):
        g = groups.setdefault((qid, kw, geo), {"imp": imp, "series": []})
        g["imp"] = max(g["imp"], imp)
        g["series"].append((week, val))
    latest = []
    for kw in sorted(cfg["keywords"]):
        cands = [(g["imp"], k) for k, g in groups.items() if k[1] == kw]
        if not cands:
            continue
        _imp, key = max(cands)
        week, val = groups[key]["series"][-1]
        latest.append(f"- {_md(kw, 60)} ({_md(key[2], 40)}): {val} — tuần "
                      f"{week} [query_id {key[0]}]")
    sp = cfg["spike"]
    spikes = []
    for (qid, kw, geo), g in sorted(groups.items()):
        for w, v, m in ii.find_spikes(g["series"], sp["window_weeks"],
                                      sp["ratio"], sp["min_delta"]):
            if mon <= w <= sun:
                spikes.append(f"- TĂNG ĐỘT BIẾN {_md(kw, 60)} ({_md(geo, 40)})"
                              f" tuần {w}: {v} so trung vị {m} của "
                              f"{sp['window_weeks']} tuần trước "
                              f"[query_id {qid}]")
    rel = conn.execute(
        "select r.seed, r.query, r.value, r.flags from trends_related r"
        " where r.section = 'rising' and r.import_id = (select max(i.id)"
        " from intel_imports i where i.kind = 'trend_related')"
        " order by r.id").fetchall()
    if not (latest or spikes or rel):
        return out + [EMPTY, ""]
    out += ["Giá trị mới nhất (thang 0–100, chỉ so được trong cùng query_id):"]
    out += latest or [EMPTY]
    out += ["", "Tăng đột biến trong tuần:"] + (spikes or ["- không có"])
    out += ["", "Truy vấn liên quan đang tăng (RISING, file mới nhất):"]
    for seed, q, v, flags in rel:
        note = (" (rượu — không dùng cho nhóm giới trẻ)" if "ruou" in flags
                else "")
        out.append(f"- [{_md(seed, 40)}] {_md(q, 120)}: {_md(v, 20)}{note}")
    if not rel:
        out.append("- không có")
    return out + [""]


def section_social(conn, start, end) -> list[str]:
    out = ["## 3. Social — kênh sở hữu (chỉ đếm, không trích nội dung)", ""]
    rows = conn.execute(
        "select channel, l, count(*) from social_mentions, unnest(labels) l"
        " where posted_at >= %s and posted_at < %s group by 1, 2"
        " order by 1, 2", (start, end)).fetchall()
    if not rows:
        return out + [EMPTY, ""]
    sens = dict(conn.execute(
        "select channel, count(*) from social_mentions where sensitive"
        " and posted_at >= %s and posted_at < %s group by 1 order by 1",
        (start, end)).fetchall())
    tot = dict(conn.execute(
        "select channel, count(*) from social_mentions"
        " where posted_at >= %s and posted_at < %s group by 1 order by 1",
        (start, end)).fetchall())
    out += ["| Kênh | Tổng tin | Theo nhãn | Nhạy cảm (hỏi sức khỏe) |",
            "|---|---|---|---|"]
    for ch in sorted(tot):
        labs = ", ".join(f"{lab}={n}" for c, lab, n in rows if c == ch)
        out.append(f"| {ch} | {tot[ch]} | {labs} | {sens.get(ch, 0)} |")
    return out + ["", ("Tin nhạy cảm chuyển người (CSKH/Pháp chế) — agent "
                        "không trả lời tự động."), ""]


def section_news(conn, start, end) -> list[str]:
    out = ["## 4. Tin thị trường mới (intel_items) theo chủ đề", ""]
    topics = conn.execute(
        "select t, count(*) from intel_items, unnest(topics) t"
        " where fetched_at >= %s and fetched_at < %s group by 1 order by 1",
        (start, end)).fetchall()
    if not topics:
        return out + [EMPTY, ""]
    for t, n in topics:
        out.append(f"### {_md(t, 40)} ({n} tin)")
        for title, url in conn.execute(
                "select title, url from intel_items where %s = any(topics)"
                " and fetched_at >= %s and fetched_at < %s"
                " order by fetched_at desc, id desc limit %s",
                (t, start, end, TITLES_PER_TOPIC)):
            out.append(f"- {_md(title, 160)} — {_md(url, 300)}")
        out.append("")
    return out


def render(conn, day, cfg) -> tuple[str, str]:
    """→ (báo cáo đầy đủ, phần được phép gửi LLM = mục 1+2+4)."""
    mon, sun, start, end = week_bounds(day)
    head = [f"# Báo cáo tuần intel {mon} → {sun}", "",
            ("Nguồn: file nhập tay (đối thủ, Google Trends, export kênh sở "
             "hữu) + collector RSS v7.0. Tầng P1-Shadow: chỉ đọc, không gửi "
             "ai."), ""]
    s1 = section_competitor(conn, mon)
    s2 = section_trend(conn, sun, mon, cfg)
    s3 = section_social(conn, start, end)
    s4 = section_news(conn, start, end)
    full = "\n".join(head + s1 + s2 + s3 + s4)
    return full, "\n".join(s1 + s2 + s4)


def summarize(payload: str) -> str | None:
    """1 lời gọi gateway agent 'intel' + guardrail. Lỗi → None + warn."""
    msgs = [{"role": "system", "content": LLM_PROMPT},
            {"role": "user", "content": payload}]
    try:
        resp = llm_gateway.chat("intel", msgs, max_tokens=400)
        text = resp.choices[0].message.content
    except llm_gateway.GatewayError as e:
        _warn(f"LLM lỗi ({type(e).__name__}) — bỏ tóm tắt")
        return None
    except (AttributeError, IndexError, TypeError):
        _warn("LLM trả về rỗng — bỏ tóm tắt")
        return None
    s = _clean(text, 2000) if isinstance(text, str) else ""
    if not s:
        return None
    if guardrail.check(s).get("ok") is not True:
        _warn("tóm tắt LLM không qua guardrail — bỏ tóm tắt")
        return None
    return s


def _connect(dsn: str):
    conn = psycopg.connect(dsn, connect_timeout=10)
    conn.read_only = True
    return conn


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/intel_weekly.py")
    ap.add_argument("--week", help="ngày bất kỳ trong tuần cần báo cáo "
                                   "(YYYY-MM-DD)")
    ap.add_argument("--llm", action="store_true",
                    help="tóm tắt LLM (chỉ khi llm.enabled = true)")
    args = ap.parse_args(argv)
    if args.week is not None:
        day = ii._iso_date(args.week)
        if day is None:
            ap.error("--week phải là ngày YYYY-MM-DD hợp lệ")
    else:
        today = ii.today_vn()
        day = today - timedelta(days=today.weekday() + 7)
    cfg, errs = ii.load_trend_config(ii.KEYWORDS_FILE)
    if errs:
        for e in errs:
            print(f"[err] {e}", flush=True)
        return 1
    use_llm = False
    if args.llm:
        src, _e = load_sources(SOURCES_FILE)
        if src is None or src.get("llm", {}).get("enabled") is not True:
            _warn("llm.enabled chưa bật (chờ Pháp chế) — không gọi LLM")
        else:
            use_llm = True
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
        missing = [t for t in TABLES if conn.execute(
            "select to_regclass(%s)", (t,)).fetchone()[0] is None]
        if missing:
            print("[err] thiếu bảng " + ", ".join(missing) + " — chạy "
                  "`python scripts/apply_schema.py`", flush=True)
            return 1
        full, payload = render(conn, day, cfg)
    except psycopg.Error as e:
        print(f"[err] lỗi DB: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()
    print(full, flush=True)
    if use_llm:
        s = summarize(payload)
        if s:
            print("\n## Tóm tắt (LLM, đã qua guardrail — chỉ tham khảo)\n",
                  flush=True)
            print(s, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
