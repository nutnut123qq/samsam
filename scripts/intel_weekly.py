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
  - Báo cáo CHỈ ĐỌC: connect `connect_timeout=10`, `read_only = True`;
    không ghi bảng nào, không gửi ai, không đường sang hàng duyệt nội dung.
  - v14.5 `--suggest-keywords [--import ID] [--dry-run]` (intel-04.2): đường
    ghi DUY NHẤT — 1 mục `intel/keyword_suggest` mỗi file Trends related
    (xem khối "v14.5 từ khóa"). File nạp có tên chứa MAU → mục cờ mẫu
    (`intel_imports` chưa có cột provenance — quy ước tên chỉ để loại thêm).
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


# ---------------------------------------------------------- v14.5 từ khóa
# intel-04.2 (PL01 Tình báo thị trường — "gợi ý từ khóa an toàn về pháp
# lý"): truy vấn liên quan Google Trends (top + rising) của 1 file
# `trend_related` đã nạp (mặc định file mới nhất) → lọc LUẬT, không LLM:
#   tu_cam     `guardrail.check` trúng từ cấm
#   cong_dung  câu công dụng ngoài công bố (claim_*)
#   ruou       rượu (`kb_filter.is_alcohol` hoặc luật rượu guardrail)
#   suc_khoe   ngữ cảnh bệnh/sức khỏe (`llm_gateway.is_health_question`)
#   pii        có SĐT/email/tên theo mẫu (`pii._mask_pii` đổi chuỗi)
#   chi_dan_dia_ly  "Ngọc Linh" khi Pháp chế chưa xác nhận quyền dùng chỉ
#              dẫn địa lý (luật `ngoc_linh_chua_xac_nhan` của check_publish
#              — `data/guardrail_rules.json`; Pháp chế điền identity/
#              confirmed_skus thì tự hết loại)
# → 1 mục `intel/keyword_suggest` mỗi file (`kw:<import_id>` — nạp file
# mới = đợt mới): danh sách AN TOÀN (nguyên văn) + lý do loại theo dòng
# `trends_related #id` (KHÔNG chép từ khóa bị loại — payload phải qua được
# guardrail để người duyệt). Gợi ý ≠ được dùng: Quản lý Marketing duyệt;
# agent không chạy quảng cáo/SEO. Đây là đường ghi DUY NHẤT của script.
KW_FEATURE = "intel-04.2"
KW_AGENT = "agent:intel_keywords"
OT_KW = "keyword_suggest"
KW_REASONS = {"tu_cam": "từ cấm", "cong_dung": "công dụng ngoài công bố",
              "ruou": "nhóm sản phẩm cấm quảng cáo",
              "suc_khoe": "ngữ cảnh bệnh/sức khỏe",
              "pii": "thông tin cá nhân",
              "chi_dan_dia_ly": "chỉ dẫn địa lý chưa được xác nhận"}


class KeywordConfigError(ValueError):
    """Guardrail hỏng khi lọc từ khóa — fail-closed, không đề xuất gì."""


def keyword_reasons(q: str) -> list[str]:
    """THUẦN: từ khóa → lý do loại (rỗng = an toàn). Guardrail cấu hình
    hỏng → KeywordConfigError."""
    from pipelines.kb_filter import is_alcohol
    from pipelines.pii import _mask_pii
    out = []
    if _mask_pii(q) != q:
        out.append("pii")
    g = guardrail.check(q)
    for v in g.get("violations", []):
        c = str(v.get("code") or "")
        if c == "config":
            raise KeywordConfigError("guardrail cấu hình hỏng")
        out.append("cong_dung" if c.startswith("claim") else
                   "ruou" if c.startswith("ruou") else c)
    if is_alcohol(q):
        out.append("ruou")
    if llm_gateway.is_health_question(q):
        out.append("suc_khoe")
    # Từ khóa dùng cho SEO/quảng cáo = ngữ cảnh ĐĂNG: luật chỉ dẫn địa lý
    # "Ngọc Linh" của `check_publish` (không gắn SKU) — chỉ lấy đúng mã đó.
    pub = guardrail.check_publish(q, channel="web", content_type="post",
                                  is_ai=False)
    if any(v.get("code") == "config" for v in pub.get("violations", [])):
        raise KeywordConfigError("guardrail cấu hình hỏng")
    if any(v.get("code") == "ngoc_linh_chua_xac_nhan"
           for v in pub.get("violations", [])):
        out.append("chi_dan_dia_ly")
    return list(dict.fromkeys(out))


def _fold_kw(q: str) -> str:
    import unicodedata
    return " ".join(unicodedata.normalize("NFC", q).casefold().split())


def keyword_suggestions(conn, import_id: int | None = None) -> dict | None:
    """CHỈ SELECT → {import_id, file_name, safe [(id, seed|None, section,
    query, value)], excluded [(id, [lý do])]} | None (chưa có file)."""
    if import_id is None:
        r = conn.execute("select max(id) from intel_imports where kind ="
                         " 'trend_related'").fetchone()
        import_id = r[0] if r else None
    if import_id is None:
        return None
    imp = conn.execute("select id, file_name from intel_imports where id ="
                       " %s and kind = 'trend_related'",
                       (import_id,)).fetchone()
    if imp is None:
        return None
    safe, excluded, seen = [], [], set()
    for rid, seed, section, q, value in conn.execute(
            "select id, seed, section, query, value from trends_related"
            " where import_id = %s order by id", (import_id,)).fetchall():
        key = _fold_kw(q)
        if key in seen:
            continue
        seen.add(key)
        why = keyword_reasons(q)
        if why:
            excluded.append((rid, why))
        else:
            safe.append((rid, None if keyword_reasons(seed) else seed,
                         section, q, value))
    return {"import_id": imp[0], "file_name": imp[1], "safe": safe,
            "excluded": excluded}


def render_keywords(res: dict) -> str:
    """THUẦN → payload mục hàng duyệt (không chép từ khóa bị loại)."""
    from collections import Counter
    L = [(f"Gợi ý từ khóa an toàn pháp lý (intel-04.2, NHÁP) — file Google"
          f" Trends đã nạp #{res['import_id']}"
          f" ({_md(res['file_name'], 80)}): an toàn {len(res['safe'])},"
          f" loại {len(res['excluded'])}."), "",
         ("Từ khóa đề xuất (đã qua luật: không từ cấm, không công dụng"
          " ngoài công bố, không ngữ cảnh bệnh, không nhóm sản phẩm cấm"
          " quảng cáo, không thông tin cá nhân, không chỉ dẫn địa lý chưa"
          " xác nhận):")]
    L += [f"- {_md(q, 120)} — {section} {_md(v, 20)}"
          + (f" (gốc: {_md(s, 60)})" if s else "")
          for _rid, s, section, q, v in res["safe"]] or ["- (không có)"]
    cnt = Counter(r for _rid, why in res["excluded"] for r in why)
    L += ["", "Lý do loại (theo số dòng): " + (" · ".join(
        f"{KW_REASONS.get(k, k)} {n}" for k, n in sorted(cnt.items()))
        or "không có")]
    L += [f"- trends_related #{rid}: "
          + ", ".join(KW_REASONS.get(w, w) for w in why)
          for rid, why in res["excluded"]]
    L += ["", ("Việc cần làm: Quản lý Marketing duyệt trước khi dùng cho SEO/"
               "quảng cáo; luật lọc là từ khóa tất định (chưa có lớp LLM-check"
               " — Pháp chế duyệt bộ luật). Agent không chạy quảng cáo/SEO.")]
    return "\n".join(L)


def suggest_keywords(conn, import_id: int | None, cfg: dict,
                     dry_run: bool = False) -> dict:
    """→ {res, payload, object_id, qid, skipped}. Tắt → RolloutBlocked."""
    from pipelines import director, rollout
    rollout.check_generate(conn, KW_FEATURE, "gợi ý từ khóa")
    res = keyword_suggestions(conn, import_id)
    if res is None:
        conn.commit()
        return {"res": None, "qid": None, "skipped": False}
    payload = render_keywords(res)
    oid = f"kw:{res['import_id']}"
    exists = conn.execute("select id from approval_queue where object_type"
                          " = %s and object_id = %s", (OT_KW, oid)).fetchone()
    sample = conn.execute(
        "select exists(select 1 from intel_imports where id = %s and"
        " file_name like '%%MAU%%')", (res["import_id"],)).fetchone()[0]
    conn.commit()
    if exists or dry_run:
        return {"res": res, "payload": payload, "object_id": oid,
                "qid": exists[0] if exists else None,
                "skipped": bool(exists)}
    qid = director.submit(conn, "intel", OT_KW, oid,
                          f"Gợi ý từ khóa an toàn — file Trends"
                          f" #{res['import_id']}", payload, KW_AGENT,
                          cfg=cfg, sample=sample)
    return {"res": res, "payload": payload, "object_id": oid, "qid": qid,
            "skipped": False}


def _keywords_main(args) -> int:
    from ingest.lead_store import connect
    from pipelines import auth, director
    from pipelines.rollout import RolloutBlocked
    try:
        cfg = director.load_config("intel")
        if OT_KW not in cfg["object_types"]:
            raise ValueError(f"intel.json thiếu loại việc {OT_KW}")
    except ValueError as e:
        print(f"[err] cấu hình lỗi: {e} — không connect", flush=True)
        return 1
    if why := auth.bind_service("job"):
        print(f"[err] {why}", flush=True)
        return 2
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres", flush=True)
        return 2
    try:
        r = suggest_keywords(conn, args.import_id, cfg, args.dry_run)
    except RolloutBlocked as e:
        print(f"[rollout] {e}", flush=True)
        return 2
    except KeywordConfigError as e:
        print(f"[err] {e} — không đề xuất (fail-closed)", flush=True)
        return 1
    except psycopg.Error as e:
        print(f"[err] lỗi DB: {type(e).__name__}", flush=True)
        return 2
    finally:
        conn.close()
    if r["res"] is None:
        print("[info] không có file Google Trends related (trend_related)"
              " phù hợp (--import) — không có gì để gợi ý", flush=True)
        return 0
    print(r["payload"], flush=True)
    if args.dry_run:
        print(f"[dry-run] {r['object_id']} — KHÔNG ghi DB"
              + (" (đã có trong hàng duyệt)" if r["skipped"] else ""))
    elif r["skipped"]:
        print(f"[skip] {r['object_id']} đã có mục #{r['qid']}")
    else:
        print(f"[ok] mục hàng duyệt #{r['qid']} ({OT_KW}, chờ Quản lý"
              " Marketing)")
    return 0


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
    ap.add_argument("--suggest-keywords", action="store_true",
                    help="v14.5 gợi ý từ khóa an toàn pháp lý từ file Trends"
                    " related → hàng duyệt intel (keyword_suggest)")
    ap.add_argument("--import", dest="import_id", type=int,
                    help="id intel_imports (trend_related) — mặc định mới"
                    " nhất; chỉ với --suggest-keywords")
    ap.add_argument("--dry-run", action="store_true",
                    help="--suggest-keywords: in gợi ý, không ghi DB")
    args = ap.parse_args(argv)
    if args.suggest_keywords:
        if args.week is not None or args.llm:
            ap.error("--suggest-keywords không đi với --week/--llm")
        return _keywords_main(args)
    if args.import_id is not None or args.dry_run:
        ap.error("--import/--dry-run chỉ đi với --suggest-keywords")
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
