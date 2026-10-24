"""v8.0 W80.5–W80.7 — báo cáo tuần/tháng 1 trang cho TGĐ (cockpit WP10,
Agent Điều hành / Chief of Staff AI).

Contract:
  - Đọc `channel_snapshots` (do `pipelines.cockpit` ghi) của kỳ ĐÃ ĐÓNG + kỳ
    trước (kỳ qua `pipelines.period.period_bounds`, giờ VN). Cùng (kênh,
    metric) có cả `manual_export` lẫn `api` → ưu tiên `manual_export`.
  - MỌI con số trong trang do CODE điền từ snapshot; thiếu số → `[chưa có
    dữ liệu]` (KHÔNG hiện 0). Δ do code tính; đánh giá theo chiều tốt của
    `data/metrics.json`. Dòng nguồn `sample:` → `(MẪU)`.
  - Preflight tuyến cảnh báo đỏ (`pipelines.red_alert.load_routing`, KHÔNG
    gửi, KHÔNG ghi `red_alerts`): chưa có người nhận độc lập → dòng ĐỎ đầu
    trang (không im lặng); có → chỉ đếm, không in tên.
  - NHẬN XÉT: mặc định theo LUẬT (tất định, 0 lời gọi LLM). `--llm` → LLM qua
    gateway agent `cockpit`, prompt chỉ có metric_id/tên/chiều tốt/xu hướng
    (KHÔNG số tuyệt đối); LLM chỉ được viết placeholder `{metric_id:nhãn kỳ}`
    / `{metric_id:delta}`, `ground()` điền số. Văn bản còn chữ số / `%` /
    trăm-nghìn-triệu-tỷ ngoài placeholder → bị loại, rơi về nhận xét theo
    luật (cũng qua `ground()`). GIỚI HẠN: số viết bằng chữ ("một", "hai"...)
    chưa bị chặn.
  - Toàn trang qua `guardrail.check()` trước khi ghi; không ok → vẫn ghi file
    kèm dòng cảnh báo đầu trang và KHÔNG `--submit`.
  - `--submit` → hàng chờ khối `ceo` (`pipelines.director.submit`) — TGĐ
    duyệt; hệ thống KHÔNG tự duyệt, KHÔNG tự gửi.
  - v8.1 (WP10 phần còn lại): 3 section do CODE dựng chèn giữa "Thời gian
    duyệt" và "Nhận xét" — "Tiến độ & Sổ quyết định" (`agents.ceo_decisions`),
    "Rủi ro pháp lý mở" (`agents.ceo_risk`), "Audit outside-in (P1)"
    (`agents.ceo_audit`). Mỗi section đọc trong savepoint; lỗi DB/cấu hình →
    1 dòng "*(không đọc được: …)*", các section khác vẫn ra (không crash,
    không im lặng). LLM KHÔNG thấy section (prompt/`ground` không đổi).
    `--bulletin` → bản tin GĐ khối `ceo` (`director.run(..., extra=<3
    section>)`) → `data/reports/director-ceo-<ngày>.md`.

Chạy: python -m agents.ceo_report [--period week|month] [--ref YYYY-MM-DD]
      [--llm] [--submit] [--out-dir DIR]
      python -m agents.ceo_report --bulletin [--now ISO] [--out-dir DIR]
Exit: 0 ok · 1 từ điển lỗi / nộp hàng chờ lỗi · 2 tham số sai / kỳ chưa
đóng / DB down.
"""

import argparse
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import psycopg

from agents import ceo_audit, ceo_decisions, ceo_risk
from agents.ra_kenh import parse_now
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director, rollout
from pipelines.cockpit import (
    CEO_METRICS,
    INTERNAL_CHANNEL,
    MetricsError,
    _closed,
    last_closed_ref,
    load_metrics,
    metric_spec,
)
from pipelines.guardrail import check as guardrail_check
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.pii import _mask_pii
from pipelines.red_alert import load_routing
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

NO_DATA = "[chưa có dữ liệu]"
LLM_AGENT = "cockpit"
MAX_COMMENTARY = 1200
PLACEHOLDER_RE = re.compile(r"\{([a-z][a-z0-9_.]{1,63}):([0-9A-Za-z-]{4,8})\}")
_NUMWORD_RE = re.compile(r"(?<!\w)(trăm|nghìn|ngàn|triệu|tỷ|tỉ)(?!\w)")
# Văn bản LLM vào trang TGĐ: cấm link/HTML/ảnh markdown (A03 — chèn nội dung).
_MARKUP_RE = re.compile(r"(?i)https?:|www\.|<[a-z/!]|\]\(|javascript:")
_MAX_ADJ = 17   # |giá trị| < 1e18 — ngoài khoảng/NaN coi như số hỏng
RED_LINE = ("**ĐỎ — chưa có người nhận cảnh báo độc lập** "
            "(data/red_alert_routing.json, external-dep: Pháp chế xác nhận)")
_SNAP_SQL = (
    "select channel, metric_id, period_start, value, source, source_ref,"
    " captured_at from channel_snapshots where period_kind = %s and"
    " period_start in (%s, %s) order by id")


# ---------------------------------------------------------------- định dạng

def period_label(kind: str, start) -> str:
    d = start.date() if isinstance(start, datetime) else start
    if kind == "week":
        iso = d.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    return f"{d:%Y-%m}"


def _group(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def _dec(v: Decimal, places: int) -> str:
    q = v.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    whole, _, frac = format(abs(q), "f").partition(".")
    return ("-" if q < 0 else "") + _group(int(whole)) + "," + frac


def fmt_value(v, unit: str) -> str:
    """Decimal đã coerce → chuỗi VN (dấu nghìn '.', thập phân ',')."""
    v = Decimal(v)
    if unit == "VND":
        n = int(v.quantize(Decimal(1), rounding=ROUND_HALF_UP))
        return f"{'-' if n < 0 else ''}{_group(abs(n))} đ"
    if unit == "USD":
        return f"{_dec(v, 2)} USD"
    if unit == "giờ":
        return f"{_dec(v, 1)} giờ"
    if v == v.to_integral_value():
        n = int(v)
        return f"{'-' if n < 0 else ''}{_group(abs(n))} {unit}"
    return f"{_dec(v, 2)} {unit}"


def fmt_delta(cur, prev, unit: str) -> str:
    cur, prev = Decimal(cur), Decimal(prev)
    d = cur - prev
    sign = "+" if d > 0 else ("-" if d < 0 else "±")
    out = f"{sign}{fmt_value(abs(d), unit)}"
    if prev != 0:
        pct = abs(d) / abs(prev) * 100
        out += f" ({sign}{_dec(pct, 1)}%)"
    return out


def assess(cur, prev, better: str) -> str:
    if cur is None or prev is None or better == "none":
        return "—"
    d = Decimal(cur) - Decimal(prev)
    if d == 0:
        return "không đổi"
    good = (d > 0) == (better == "up")
    return "tốt" if good else "xấu"


def _cell(s) -> str:
    return re.sub(r"[|`\r\n]+", " ", str(s)).strip()


def _vn_day(ts) -> str:
    if isinstance(ts, datetime) and ts.tzinfo is not None:
        return ts.astimezone(VN_TZ).strftime("%d/%m/%Y")
    return "—"


# ---------------------------------------------------------------- build

def _pick(snaps: list[tuple]) -> tuple[dict, int]:
    """→ ({(metric_id, channel, period_start): snap}, số giá trị hỏng) —
    manual_export > api; NaN/khổng lồ (ghi ngoài cockpit) bị bỏ + đếm."""
    out: dict = {}
    bad = 0
    for ch, mid, ps, val, src, ref, cap in snaps:
        v = Decimal(val)
        if not v.is_finite() or (v != 0 and v.adjusted() > _MAX_ADJ):
            bad += 1
            continue
        k = (mid, ch, ps)
        if k in out and out[k]["source"] == "manual_export":
            continue
        out[k] = {"value": v, "source": src, "source_ref": ref,
                  "captured_at": cap}
    return out, bad


def _rows(metrics: dict, picked: dict, cur_d, prev_d) -> tuple[list, int]:
    seen = {(m, c) for (m, c, _) in picked}
    rows, used = [], set()

    def add(mid, ch, spec, name):
        used.add((mid, ch))
        rows.append({
            "metric_id": mid, "channel": ch, "name": name,
            "unit": spec["unit"], "better": spec["better"],
            "key": mid if ch in (INTERNAL_CHANNEL, "—") else f"{mid}.{ch}",
            "section": "ceo" if mid in CEO_METRICS else "main",
            "per_agent": mid not in metrics,
            "cur": picked.get((mid, ch, cur_d)),
            "prev": picked.get((mid, ch, prev_d))})

    for mid, spec in metrics.items():
        if spec["kind"] == "internal":
            add(mid, INTERNAL_CHANNEL, spec, spec["name"])
            if spec.get("per_agent"):
                for m2, c2 in sorted(seen):
                    if (m2.startswith(mid + ".") and c2 == INTERNAL_CHANNEL
                            and metric_spec(metrics, m2) is spec):
                        add(m2, c2, spec,
                            f"{spec['name']} — agent {m2[len(mid) + 1:]}")
        else:
            chans = [c for c in spec["channels"] if (mid, c) in seen]
            for c in chans:
                add(mid, c, spec, spec["name"])
            if not chans:
                add(mid, "—", spec, spec["name"])
    ignored = len(seen - used)
    return rows, ignored


def build(conn, kind: str, ref, *, now=None, llm: bool = False,
          routing=None, metrics=None, sections=None) -> dict:
    """→ rep (dict). Kỳ chưa đóng / kind lạ → ValueError. `sections` (v8.1)
    = list các khối dòng markdown do code dựng (`compute_sections`); None →
    trang y hệt v8.0."""
    if kind not in ("week", "month"):
        raise ValueError("kind phải week|month")
    start, end = _closed(kind, ref, now)
    prev_start, _ = period_bounds(kind, start - timedelta(days=1))
    metrics = metrics if metrics is not None else load_metrics()
    snaps = conn.execute(_SNAP_SQL, (kind, start.date(),
                                     prev_start.date())).fetchall()
    picked, bad = _pick(snaps)
    rows, ignored = _rows(metrics, picked, start.date(), prev_start.date())
    r = load_routing(routing)
    rep = {"kind": kind, "label": period_label(kind, start),
           "prev_label": period_label(kind, prev_start), "start": start,
           "end": end, "prev_start": prev_start, "rows": rows,
           "ignored": ignored, "bad_values": bad,
           "preflight": {"ok": bool(r["recipients"]),
                         "n": len(r["recipients"]),
                         "problems": len(r["problems"])},
           "generated_at": now or datetime.now(VN_TZ),
           "llm_used": False, "llm_note": None, "guardrail_violations": [],
           "sections": sections}
    if llm:
        text, why = llm_commentary(rep)
        if text is None:
            rep["llm_note"] = f"Nhận xét LLM bị loại: {why}"
        else:
            rep["commentary"], rep["llm_used"] = text, True
    if not rep["llm_used"]:
        rep["commentary"] = rule_commentary(rep)
    return rep


# ---------------------------------------------------------------- W80.7

def _labels(rep) -> tuple[str, str]:
    return rep["label"], rep["prev_label"]


def commentary_values(rep) -> dict:
    """{key: {nhãn kỳ này|nhãn kỳ trước|'delta': chuỗi đã định dạng}} —
    nguồn DUY NHẤT của con số trong nhận xét."""
    cur_l, prev_l = _labels(rep)
    out = {}
    for row in rep["rows"]:
        if row["per_agent"]:
            continue
        c, p = row["cur"], row["prev"]
        v = {}
        if c is not None:
            v[cur_l] = fmt_value(c["value"], row["unit"])
        if p is not None:
            v[prev_l] = fmt_value(p["value"], row["unit"])
        if c is not None and p is not None:
            v["delta"] = fmt_delta(c["value"], p["value"], row["unit"])
        if v:
            out[row["key"]] = v
    return out


def _has_number(text: str) -> list[str]:
    reasons = []
    # Mọi ký tự số Unicode (Nd chữ số, No ¹²½①, Nl Ⅻ) — `\d` chỉ bắt Nd.
    if any(unicodedata.category(ch)[0] == "N" for ch in text):
        reasons.append("LLM tự viết số (chữ số ngoài placeholder)")
    t = unicodedata.normalize("NFKC", text).casefold()
    if "%" in t or "‰" in t:
        reasons.append("LLM tự viết số (ký hiệu % ngoài placeholder)")
    if _NUMWORD_RE.search(t):
        reasons.append("LLM tự viết số (trăm/nghìn/triệu/tỷ ngoài "
                       "placeholder)")
    return reasons


def ground(template, values: dict, labels) -> tuple[str | None, list[str]]:
    """Template chỉ có placeholder → (văn bản đã điền số, []) hoặc
    (None, lý do). Số CHỈ đến từ `values` (code tính)."""
    if not isinstance(template, str) or not template.strip():
        return None, ["nhận xét rỗng"]
    if len(template) > 4 * MAX_COMMENTARY:     # chặn sớm trước regex
        return None, [f"nhận xét dài quá {MAX_COMMENTARY} ký tự"]
    t = unicodedata.normalize("NFC", template)
    allowed = set(labels) | {"delta"}
    reasons = []
    for m in PLACEHOLDER_RE.finditer(t):
        mid, tok = m.groups()
        if mid not in values:
            reasons.append(f"placeholder metric lạ/không có số: {mid}")
        elif tok not in allowed:
            reasons.append(f"placeholder kỳ lạ: {mid}:{tok}")
        elif values[mid].get(tok) is None:
            reasons.append(f"placeholder thiếu giá trị: {mid}:{tok}")
    rest = PLACEHOLDER_RE.sub(" ", t)
    reasons += _has_number(rest)
    if "{" in rest or "}" in rest:
        reasons.append("placeholder sai cú pháp")
    if _MARKUP_RE.search(rest):
        reasons.append("chứa link/HTML (không cho chèn vào trang TGĐ)")
    if reasons:
        return None, reasons
    filled = PLACEHOLDER_RE.sub(lambda m: values[m[1]][m[2]], t)
    if len(filled) > MAX_COMMENTARY:
        return None, [f"nhận xét dài quá {MAX_COMMENTARY} ký tự"]
    g = guardrail_check(filled)
    if not g.get("ok"):
        kinds = sorted({str(v.get("type")) for v in g.get("violations", [])
                        if isinstance(v, dict)})
        return None, [f"guardrail không ok ({', '.join(kinds) or '?'})"]
    return filled, []


def rule_templates(rep) -> tuple[list[str], dict, tuple[str, str]]:
    """Câu template theo luật (TẤT ĐỊNH) cho mọi metric có đủ 2 kỳ."""
    cur_l, prev_l = _labels(rep)
    values = commentary_values(rep)
    tpls = []
    for row in rep["rows"]:
        k = row["key"]
        if row["per_agent"] or "delta" not in values.get(k, {}):
            continue
        name = row["name"] + ("" if row["channel"] == INTERNAL_CHANNEL
                              else f" (kênh {row['channel']})")
        if _has_number(name):
            continue
        d = row["cur"]["value"] - row["prev"]["value"]
        if d == 0:
            tpls.append(f"{name} không đổi ở mức {{{k}:{cur_l}}}.")
            continue
        verdict = {"tốt": "tốt", "xấu": "cần xem"}.get(
            assess(row["cur"]["value"], row["prev"]["value"],
                   row["better"]), "để theo dõi")
        # "giảm" là động từ claim công dụng trong guardrail → dùng "hạ".
        move = "tăng" if d > 0 else "hạ"
        to = "lên" if d > 0 else "xuống"
        tpls.append(f"{name} {move} từ {{{k}:{prev_l}}} {to} {{{k}:{cur_l}}}"
                    f" ({{{k}:delta}}) — {verdict}.")
    return tpls, values, (cur_l, prev_l)


def rule_commentary(rep) -> str:
    tpls, values, labels = rule_templates(rep)
    out = []
    for t in tpls:
        text, reasons = ground(t, values, labels)
        out.append(f"- {text}" if text is not None
                   else f"- (câu bị loại: {'; '.join(reasons)})")
    if not out:
        return "- Chưa đủ số liệu hai kỳ để so sánh — xem bảng."
    return "\n".join(out)


_BETTER_VI = {"up": "tăng là tốt", "down": "đi xuống là tốt",
              "none": "chỉ theo dõi"}


def llm_prompt(rep) -> list[dict]:
    """Prompt KHÔNG chứa số tuyệt đối — chỉ key/tên/chiều tốt/xu hướng."""
    cur_l, prev_l = _labels(rep)
    values = commentary_values(rep)
    lines = []
    for row in rep["rows"]:
        v = values.get(row["key"])
        if row["per_agent"] or not v:
            continue
        if "delta" in v:
            d = row["cur"]["value"] - row["prev"]["value"]
            trend = "tăng" if d > 0 else ("đi xuống" if d < 0 else "không đổi")
        else:
            trend = "thiếu số một kỳ"
        lines.append(f"- {row['key']} | {row['name']} | "
                     f"{_BETTER_VI[row['better']]} | xu hướng: {trend} | "
                     f"placeholder có: {', '.join(sorted(v))}")
    system = (
        "Bạn viết phần NHẬN XÉT ngắn (tối đa 6 gạch đầu dòng, tiếng Việt) "
        "cho báo cáo điều hành gửi Tổng giám đốc. LUẬT BẮT BUỘC: KHÔNG viết "
        "bất kỳ chữ số, ký hiệu phần trăm hay từ chỉ số lượng nào. Muốn nhắc "
        "số thì CHỈ viết placeholder dạng {metric:kỳ} với kỳ là "
        f"'{cur_l}' (kỳ này), '{prev_l}' (kỳ trước) hoặc 'delta' (chênh "
        "lệch) — hệ thống tự điền số. Chỉ dùng metric và placeholder có "
        "trong danh sách. Không dùng chữ 'giảm' (viết 'đi xuống'/'hạ'). "
        "Không nói về công dụng sức khỏe.")
    user = ("Danh sách chỉ số (key | tên | chiều tốt | xu hướng | "
            "placeholder có):\n" + "\n".join(lines))
    return [{"role": "system", "content": system},
            {"role": "user", "content": user}]


def llm_commentary(rep) -> tuple[str | None, str | None]:
    """Gọi gateway agent `cockpit` → (văn bản đã điền, None) | (None, lý do)."""
    from pipelines import llm_gateway  # lười: --llm tắt → không chạm gateway

    try:
        resp = llm_gateway.chat(LLM_AGENT, llm_prompt(rep), temperature=0,
                                feature="ceo-01")
        content = resp.choices[0].message.content
    except llm_gateway.GatewayError as e:
        return None, f"gateway lỗi ({type(e).__name__})"
    except (AttributeError, IndexError, TypeError):
        return None, "phản hồi LLM sai cấu trúc"
    _, values, labels = rule_templates(rep)
    text, reasons = ground(content, values, labels)
    if text is None:
        return None, "; ".join(reasons)
    return text, None


# ---------------------------------------------------------------- render

def rep_sample(rep: dict) -> bool:
    """P8.4: có số chụp nguồn `sample:` (cockpit --import --sample)."""
    return any(s and str(s.get("source_ref") or "").startswith("sample:")
               for r in rep.get("rows") or () for s in (r["cur"], r["prev"]))


def _table(rows: list[dict]) -> list[str]:
    L = ["| Chỉ số | Kênh | Kỳ này | Kỳ trước | Δ | Đánh giá | Nguồn |",
         "|---|---|---|---|---|---|---|"]
    for r in rows:
        c, p = r["cur"], r["prev"]
        cv = c["value"] if c else None
        pv = p["value"] if p else None
        src = c or p
        if src is None:
            source = "—"
        else:
            sample = any(s and str(s.get("source_ref") or "").startswith(
                "sample:") for s in (c, p))
            source = (f"{src['source']} · {src.get('source_ref') or '—'} · "
                      f"chụp {_vn_day(src.get('captured_at'))}"
                      + (" (MẪU)" if sample else ""))
        L.append("| " + " | ".join(_cell(x) for x in (
            f"{r['name']} ({r['metric_id']})", r["channel"],
            fmt_value(cv, r["unit"]) if cv is not None else NO_DATA,
            fmt_value(pv, r["unit"]) if pv is not None else NO_DATA,
            fmt_delta(cv, pv, r["unit"]) if c and p else "—",
            assess(cv, pv, r["better"]), source)) + " |")
    return L


def render(rep: dict) -> str:
    """rep → markdown (THUẦN)."""
    kind_vi = "tuần" if rep["kind"] == "week" else "tháng"
    last = (rep["end"] - timedelta(days=1)).strftime("%d/%m/%Y")
    L = [f"# Báo cáo {kind_vi} {rep['label']} — TGĐ", ""]
    if rep.get("guardrail_violations"):
        L += [("> **CẢNH BÁO GUARDRAIL — trang có vi phạm ("
               + ", ".join(rep["guardrail_violations"])
               + "), KHÔNG nộp duyệt cho tới khi sửa.**"), ""]
    pf = rep["preflight"]
    if pf["ok"]:
        L.append(f"Tuyến cảnh báo đỏ: {pf['n']} người nhận độc lập")
    else:
        L.append(RED_LINE + (f" · vấn đề cấu hình: {pf['problems']}"
                             if pf["problems"] else ""))
    L += ["",
          (f"**Kỳ:** {rep['start']:%d/%m/%Y} → {last} (giờ VN) · **Kỳ "
           f"trước:** {rep['prev_label']} · **Sinh lúc:** "
           f"{rep['generated_at'].astimezone(VN_TZ):%d/%m/%Y %H:%M} giờ VN"),
          "",
          ("Mọi con số do code điền từ bảng `channel_snapshots` (chụp bởi "
           "`pipelines.cockpit`); thiếu số hiện "
           f"`{NO_DATA}`, không hiện 0. Dòng *(MẪU)* là số liệu mẫu, không "
           "phải số vận hành thật."), "",
          "## Số liệu điều hành", ""]
    L += _table([r for r in rep["rows"] if r["section"] == "main"])
    L += ["", "## Thời gian duyệt của TGĐ (khối ceo)", "",
          ("Từ hàng chờ duyệt khối `ceo`: tạo → quyết định. Tuần không có "
           "quyết định thì không có số giờ (không ghi 0)."), ""]
    L += _table([r for r in rep["rows"] if r["section"] == "ceo"])
    for sec in rep.get("sections") or ():
        L += ["", *sec]
    L += ["", "## Nhận xét", "",
          ("*Nhận xét do LLM viết bằng placeholder, code điền số.*"
           if rep.get("llm_used") else
           "*Nhận xét theo luật (tất định, không dùng LLM).*"), "",
          rep.get("commentary") or "- (không có)"]
    if rep.get("llm_note"):
        L += ["", f"*{_cell(rep['llm_note'])}*"]
    if rep.get("bad_values"):
        L += ["", (f"*Bỏ qua {rep['bad_values']} số hỏng (NaN/ngoài khoảng)"
                   " trong channel_snapshots — báo người quản trị DB.*")]
    if rep.get("ignored"):
        L += ["", (f"*Bỏ qua {rep['ignored']} chỉ số trong channel_snapshots "
                   "không có trong data/metrics.json.*")]
    L += ["", "---",
          ("*BẢN NHÁP — chờ TGĐ ký; hệ thống KHÔNG tự gửi. Sinh bởi "
           "`python -m agents.ceo_report`.*"), ""]
    return "\n".join(L)


def finalize(rep: dict) -> tuple[str, bool]:
    """render + guardrail toàn trang → (markdown, ok). Không ok → dòng cảnh
    báo đầu trang."""
    text = render(rep)
    g = guardrail_check(text)
    if g.get("ok"):
        return text, True
    rep["guardrail_violations"] = sorted(
        {str(v.get("type")) for v in g.get("violations", [])
         if isinstance(v, dict)}) or ["?"]
    return render(rep), False


FEATURE_WEEK = "ceo-01"            # r12 G1-L4: báo cáo tuần tự động


def report_name(rep: dict) -> str:
    return f"ceo-{rep['label']}.md"


# ---------------------------------------------------------------- v8.1

SECTION_HEADS = ("## Tiến độ & Sổ quyết định", "## Rủi ro pháp lý mở",
                 "## Audit outside-in (P1)")


def _sections_fns():
    # Gọi qua thuộc tính module lúc chạy (test monkeypatch được).
    return (lambda c, n: ceo_decisions.section(c, n.astimezone(VN_TZ).date()),
            lambda c, n: ceo_risk.section(c, n),
            lambda c, n: ceo_audit.section(c, n))


def compute_sections(conn, now: datetime) -> list[list[str]]:
    """3 section v8.1, mỗi cái trong savepoint `conn.transaction()`. Lỗi
    `psycopg.Error`/`ValueError` → section 1 dòng "không đọc được" (không
    crash, không im lặng); section khác vẫn ra."""
    out = []
    for head, fn in zip(SECTION_HEADS, _sections_fns()):
        try:
            with conn.transaction():
                out.append(list(fn(conn, now)))
        # Ngoài psycopg.Error/ValueError (DB/cấu hình) còn lỗi lạ (conn giả,
        # dữ liệu sai kiểu): trang TGĐ vẫn phải ra — lỗi HIỆN trên trang.
        except Exception as e:  # noqa: BLE001
            why = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
            why = _cell(_mask_pii(f"{type(e).__name__}: {why}"))[:160]
            out.append([head, "", f"*(không đọc được: {why})*"])
    return out


def bulletin_extra(sections: list[list[str]]) -> list[str]:
    out: list[str] = []
    for sec in sections:
        out += ([""] if out else []) + list(sec)
    return out


# ---------------------------------------------------------------- CLI

def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.ceo_report",
        description="Báo cáo tuần/tháng cho TGĐ (BẢN NHÁP — không tự gửi)")
    ap.add_argument("--period", choices=("week", "month"), default=None)
    ap.add_argument("--ref", default=None, help="YYYY-MM-DD (ngày VN)")
    ap.add_argument("--llm", action="store_true",
                    help="nhận xét qua LLM gateway agent 'cockpit' (mặc định "
                         "TẮT)")
    ap.add_argument("--submit", action="store_true",
                    help="nộp trang vào hàng chờ khối ceo để TGĐ duyệt")
    ap.add_argument("--bulletin", action="store_true",
                    help="bản tin GĐ khối ceo kèm 3 section v8.1 → "
                         "data/reports/director-ceo-<ngày>.md")
    ap.add_argument("--now", default=None,
                    help="ISO CHỈ cho --bulletin; thiếu múi giờ = giờ VN")
    ap.add_argument("--out-dir", default=str(REPORTS_DIR))
    args = ap.parse_args(argv)
    if args.bulletin:
        if args.submit or args.llm or args.period or args.ref:
            ap.error("--bulletin không đi với --submit/--llm/--period/--ref")
        try:
            now = parse_now(args.now) if args.now else now
        except ValueError:
            ap.error("--now sai định dạng ISO")
        return _bulletin(now or datetime.now(VN_TZ), Path(args.out_dir))
    if args.now is not None:
        ap.error("--now chỉ đi với --bulletin")
    args.period = args.period or "week"
    try:
        ref = (date.fromisoformat(args.ref) if args.ref
               else last_closed_ref(args.period, now))
        _closed(args.period, ref, now)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    try:
        metrics = load_metrics()
    except MetricsError as e:
        print(f"[error] data/metrics.json: {e}", file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    # r12 G1-L4: báo cáo TUẦN = đầu ra ceo-01 (tiền tố ceo- không thuộc
    # output_sources) — cổng tắt TRƯỚC khi dựng/gọi LLM, ghi tường minh
    # tính năng để có nhãn giai đoạn + sổ report_outputs.
    fid = FEATURE_WEEK if args.period == "week" else None
    why = rollout.blocked(conn, "báo cáo tuần TGĐ", fid=fid)
    if why:
        with suppress(Exception):
            conn.close()
        return rollout.say_blocked(why)
    try:
        try:
            secs = compute_sections(conn, now or datetime.now(VN_TZ))
            rep = build(conn, args.period, ref, now=now, llm=args.llm,
                        metrics=metrics, sections=secs)
        except psycopg.Error as e:
            print(f"[error] lỗi DB: {_db_msg(e)[:300]}", file=sys.stderr)
            return 2
        text, ok = finalize(rep)
        path = write_report(text, Path(args.out_dir), report_name(rep),
                            sample=rep_sample(rep), feature=fid)
        n_data = sum(1 for r in rep["rows"] if r["cur"] is not None)
        print(f"[done] {path} — kỳ {rep['label']}, {n_data}/"
              f"{len(rep['rows'])} chỉ số có số kỳ này"
              + ("" if rep["preflight"]["ok"]
                 else " · ĐỎ: chưa có người nhận cảnh báo độc lập"))
        if rep["llm_note"]:
            print(f"[warn] {rep['llm_note']}")
        if not ok:
            print("[warn] guardrail vi phạm: "
                  + ", ".join(rep["guardrail_violations"]))
        if not args.submit:
            return 0
        if not ok:
            print("[error] trang vi phạm guardrail — KHÔNG nộp",
                  file=sys.stderr)
            return 1
        otype = "weekly_report" if args.period == "week" else "monthly_report"
        kind_vi = "tuần" if args.period == "week" else "tháng"
        try:
            qid = director.submit(
                conn, "ceo", otype, object_id=rep["label"],
                title=f"Báo cáo {kind_vi} {rep['label']} — TGĐ",
                payload=text, created_by="agent:ceo_report")
        except (psycopg.Error, ValueError, director.DirectorConfigError) as e:
            msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
            print(f"[error] không nộp được hàng chờ: {msg[:300]}",
                  file=sys.stderr)
            return 1
        print(f"[submit] mục #{qid} vào hàng chờ khối ceo (pending — TGĐ "
              "duyệt; hệ thống KHÔNG tự duyệt)")
        return 0
    finally:
        with suppress(Exception):
            conn.close()


def _bulletin(now: datetime, out_dir: Path) -> int:
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        secs = compute_sections(conn, now)
        path, _ = director.run(conn, "ceo", now, out_dir=out_dir,
                               extra=bulletin_extra(secs))
    except (psycopg.Error, director.DirectorConfigError) as e:
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        print(f"[error] bản tin khối ceo: {_cell(msg)[:300]}",
              file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    print(f"[bulletin] {path} — bản tin GĐ khối ceo + 3 section (BẢN NHÁP, "
          "không tự gửi)")
    return 0


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.ceo_report") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
