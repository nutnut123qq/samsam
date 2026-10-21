"""v10.0 W100.6 (WP16) — Gói báo cáo HĐTV tháng/quý (Agent Điều hành, khối
`ceo`): markdown, MỌI số do code điền + có nguồn.

Contract:
  - Kỳ `YYYY-MM` hoặc `YYYY-Qn` (`parse_period` THUẦN; quý = 3 tháng liên
    tiếp, KHÔNG thêm vào `pipelines.period.KINDS`); mỗi tháng cắt qua
    `period_bounds` (giờ VN). Kỳ chưa đóng → ValueError → exit 2.
  - 7 mục cố định, mỗi mục đọc trong savepoint (lỗi → 1 dòng "*(không đọc
    được: …)*", mục khác vẫn ra):
      Chỉ số cockpit (`ceo_report.build` từng tháng; quý: 3 cột tháng + cột
        quý theo `data/hdtv_report.json` `quarter_agg` {metric: sum|last} —
        metric không khai → "—"; `sum` thiếu ≥1 tháng / `last` thiếu tháng
        cuối → `[chưa đủ dữ liệu]`, KHÔNG cộng thiếu);
      Tiến độ & Sổ quyết định (`ceo_decisions.section`); Rủi ro pháp lý mở
        (`ceo_risk.section`, as-of cuối kỳ); Chi so ngân sách vận hành
        (`fp_opscost.summary` từng tháng); P&L tóm tắt (`fp_pnl.compute`,
        BẢN NHÁP tới khi GĐ tài chính ký); Ép trình QA (override_qa — từ
        `bks_audit.check_overrides`); Kiểm soát BKS (dòng `audit_runs` mới
        nhất mỗi kind trong/sau kỳ; chưa có → "chưa chạy — không kiểm chứng
        được", KHÔNG "không vi phạm").
  - GROUNDING: `build` trả `facts: [{text, source}]`; số chỉ vào trang qua
    `Pack.fact(text, source)` (hoặc dòng section tái dùng đăng ký nguyên
    dòng với nguồn `fn:<module.hàm>`). `render` quét mọi token số — token
    không thuộc fact nào (trừ ngày/giờ, nhãn kỳ, `#id`) → `UngroundedNumber`
    (fail-closed, KHÔNG ghi trang).
  - Toàn trang qua `guardrail.check()`; không ok → dòng CẢNH BÁO đầu trang +
    chặn `--submit` (rc 1). Nguồn `sample:`/file `*_MAU` → `(MẪU)`.
  - `--submit` → `director.submit(conn, 'ceo', 'hdtv_pack', ...)` — TGĐ
    duyệt trước khi gửi HĐTV; hệ thống KHÔNG tự duyệt/gửi. `--record` →
    `audit_runs` kind `hdtv_pack`. Ngoài 2 đường đó CHỈ ĐỌC. Không LLM,
    không mạng. Không chép mã đơn/người mua/text bài; tên người + lý do
    override qua `_mask_pii` + `_oneline`.

Chạy: python -m agents.hdtv_report --month YYYY-MM | --quarter YYYY-Qn
      [--now ISO] [--out-dir DIR] [--submit] [--record]
Exit: 0 ok · 1 cấu hình hỏng / guardrail chặn submit / nộp lỗi · 2 tham số
sai / kỳ chưa đóng / DB down / lỗi DB.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import psycopg

from agents import bks_audit, ceo_decisions, ceo_report, ceo_risk, fp_opscost, fp_pnl
from agents.ra_kenh import parse_now, safe
from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import director
from pipelines.auth import load_users
from pipelines.cockpit import load_metrics
from pipelines.guardrail import check as guardrail_check
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ, period_bounds
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "hdtv_report.json"
RUN_BY = "agent:hdtv_report"
OBJECT_TYPE = "hdtv_pack"
FEATURE = "ceo-05"                 # v14.3 cổng giai đoạn (HĐ 6.7)
NO_DATA = "[chưa có dữ liệu]"
NOT_ENOUGH = "[chưa đủ dữ liệu]"
NOT_RUN = "chưa chạy — không kiểm chứng được"
AGGS = ("sum", "last")
BKS_KINDS = (("inside_out", "Audit inside-out"),
             ("recon", "Đối soát độc lập"))
SECTION_HEADS = ("## Chỉ số cockpit", "## Tiến độ & Sổ quyết định",
                 "## Rủi ro pháp lý mở", "## Chi so ngân sách vận hành",
                 "## P&L tóm tắt", "## Ép trình QA (override_qa)",
                 "## Kiểm soát BKS")
_PERIOD_RE = re.compile(r"([0-9]{4})-(?:(0[1-9]|1[0-2])|Q([1-4]))")
_METRIC_RE = re.compile(r"[a-z][a-z0-9_.]{1,63}")
NUM_RE = re.compile(r"\d[\d.,]*")
# Token số được phép KHÔNG cần fact: ngày/giờ, nhãn kỳ, #id nội bộ.
_ALLOWED_RE = re.compile(
    r"\d{2}/\d{2}/\d{4}|\d{4}-\d{2}-\d{2}|\b\d{2}:\d{2}\b"
    r"|\b\d{4}-(?:Q[1-4]|\d{2})\b|#\d+")


class ConfigError(ValueError):
    """data/hdtv_report.json thiếu/hỏng."""


class UngroundedNumber(ValueError):
    """Số trên trang không có fact/nguồn — fail-closed."""


# ------------------------------------------------------------------ thuần

def parse_period(s, now: datetime | None = None) -> dict:
    """'YYYY-MM' | 'YYYY-Qn' → {label, kind, months [date], start, end}.
    Sai dạng / kỳ chưa đóng (end > now, giờ VN) → ValueError."""
    m = _PERIOD_RE.fullmatch(s) if isinstance(s, str) else None
    if m is None:
        raise ValueError("kỳ phải dạng YYYY-MM hoặc YYYY-Qn (n = 1..4)")
    y = int(m[1])
    if m[2]:
        months = [date(y, int(m[2]), 1)]
    else:
        q = int(m[3])
        months = [date(y, 3 * q - 2 + i, 1) for i in range(3)]
    start = period_bounds("month", months[0])[0]
    end = period_bounds("month", months[-1])[1]
    now = now or datetime.now(VN_TZ)
    if end > now:
        raise ValueError(f"kỳ {s} chưa đóng (hết "
                         f"{(end - timedelta(days=1)).date()} giờ VN)")
    return {"label": s, "kind": "month" if m[2] else "quarter",
            "months": months, "start": start, "end": end}


def load_config(path: Path | None = None) -> dict:
    p = path or CONFIG_FILE
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise ConfigError(f"không đọc được {p.name}: "
                          f"{type(e).__name__}") from None
    agg = raw.get("quarter_agg") if isinstance(raw, dict) else None
    if not isinstance(agg, dict):
        raise ConfigError(f"{p.name}: thiếu object quarter_agg")
    for k, v in agg.items():
        if not (isinstance(k, str) and _METRIC_RE.fullmatch(k)) or v not in AGGS:
            raise ConfigError(f"{p.name}: quarter_agg mục sai "
                              f"('{_oneline(safe(k), 40)}' phải sum|last)")
    return {"quarter_agg": dict(agg)}


def quarter_value(agg: str | None, vals: list):
    """3 giá trị tháng (None = thiếu) → (giá trị | None, nhãn). `sum` cần
    đủ 3 tháng; `last` cần tháng cuối; không khai → '—'."""
    if agg is None:
        return None, "—"
    if agg == "sum":
        if any(v is None for v in vals):
            return None, NOT_ENOUGH
        return sum(vals, Decimal(0)), None
    if vals[-1] is None:
        return None, NOT_ENOUGH
    return vals[-1], None


def num_tokens(text: str) -> set[str]:
    return {t.rstrip(".,") for t in NUM_RE.findall(_ALLOWED_RE.sub(" ", text))}


class Pack(dict):
    """dict gói + `fact()` đăng ký số kèm nguồn."""

    def fact(self, text, source: str) -> str:
        text = str(text)
        if not source or not str(source).strip():
            raise UngroundedNumber("fact thiếu nguồn")
        self["facts"].append({"text": text, "source": str(source)})
        return text

    def lines(self, lines, source: str) -> list[str]:
        """Dòng section tái dùng (code dựng) → đăng ký dòng có chữ số."""
        out = [str(x) for x in lines]
        for x in out:
            if NUM_RE.search(_ALLOWED_RE.sub(" ", x)):
                self.fact(x, source)
        return out


# ------------------------------------------------------------------ mục

def _cell(s) -> str:
    return re.sub(r"[|`\r\n]+", " ", str(s)).strip()


def _mlabel(m: date) -> str:
    return f"{m:%Y-%m}"


def _snap_src(snap) -> tuple[str, bool]:
    ref = str(snap.get("source_ref") or "—")
    return f"{snap['source']} · {_cell(ref)}", ref.startswith("sample:")


def _mname(pack: Pack, r: dict) -> str:
    """Tên + mã chỉ số (mã có thể chứa chữ số, vd `p90`) — nguồn từ điển."""
    return pack.lines([f"{r['name']} ({r['metric_id']})"],
                      "fn:pipelines.cockpit.load_metrics (data/metrics.json)"
                      )[0]


def sec_cockpit(conn, pack: Pack, now) -> list[str]:
    metrics = load_metrics()
    agg = pack["config"]["quarter_agg"]
    months = pack["months"]
    reps = [ceo_report.build(conn, "month", m, now=now, metrics=metrics)
            for m in months]
    keys, rows = [], {}
    for i, rep in enumerate(reps):
        for r in rep["rows"]:
            if r["per_agent"]:
                continue
            k = (r["metric_id"], r["channel"])
            if k not in rows:
                keys.append(k)
                rows[k] = {"row": r, "vals": [None] * len(reps)}
            rows[k]["vals"][i] = r["cur"]
    L = [SECTION_HEADS[0], ""]
    src_fn = "fn:agents.ceo_report.build"
    if pack["kind"] == "month":
        L += ["| Chỉ số | Kênh | Kỳ này | Kỳ trước | Δ | Nguồn |",
              "|---|---|---|---|---|---|"]
        for k in keys:
            r = rows[k]["row"]
            c, p = r["cur"], r["prev"]
            src = f"db:channel_snapshots {r['metric_id']}/{r['channel']}"
            cur = (pack.fact(ceo_report.fmt_value(c["value"], r["unit"]),
                             src) if c else NO_DATA)
            prev = (pack.fact(ceo_report.fmt_value(p["value"], r["unit"]),
                              src) if p else NO_DATA)
            dl = (pack.fact(ceo_report.fmt_delta(c["value"], p["value"],
                                                 r["unit"]), src_fn)
                  if c and p else "—")
            sn = c or p
            if sn:
                s, sample = _snap_src(sn)
                pack["sample"] |= sample
                srcs = pack.fact(s + (" (MẪU)" if sample else ""), src)
            else:
                srcs = "—"
            L.append("| " + " | ".join(_cell(x) for x in (
                _mname(pack, r), r["channel"], cur, prev,
                dl, srcs)) + " |")
        return L
    heads = [_mlabel(m) for m in months]
    L += ["| Chỉ số | Kênh | " + " | ".join(heads) + " | Quý | Cách gộp |",
          "|---|---|" + "---|" * len(heads) + "---|---|"]
    for k in keys:
        r, vals = rows[k]["row"], rows[k]["vals"]
        src = f"db:channel_snapshots {r['metric_id']}/{r['channel']}"
        cells = []
        for v in vals:
            if v is None:
                cells.append(NO_DATA)
                continue
            pack["sample"] |= _snap_src(v)[1]
            cells.append(pack.fact(ceo_report.fmt_value(v["value"],
                                                        r["unit"]), src))
        how = agg.get(r["metric_id"])
        qv, why = quarter_value(how, [None if v is None else v["value"]
                                      for v in vals])
        qcell = (why if qv is None else pack.fact(
            ceo_report.fmt_value(qv, r["unit"]),
            f"fn:agents.hdtv_report.quarter_value ({how}) {src}"))
        L.append("| " + " | ".join(_cell(x) for x in (
            _mname(pack, r), r["channel"], *cells, qcell,
            how or "không khai")) + " |")
    return L


def sec_decisions(conn, pack: Pack, now) -> list[str]:
    last = (pack["end"] - timedelta(days=1)).date()
    return pack.lines(ceo_decisions.section(conn, last),
                      "fn:agents.ceo_decisions.section")


def sec_risk(conn, pack: Pack, now) -> list[str]:
    as_of = min(pack["end"] - timedelta(seconds=1), now)
    return pack.lines(ceo_risk.section(conn, as_of),
                      "fn:agents.ceo_risk.section")


def sec_opscost(conn, pack: Pack, now) -> list[str]:
    cfg, why = fp_opscost.load_cfg()
    if cfg is None:
        raise ValueError(f"data/fpa_config.json: {why}")
    users = load_users()
    budget = cfg["budget_vnd"]
    src_cfg = "fn:agents.fp_opscost.load_cfg (data/fpa_config.json)"
    L = [SECTION_HEADS[3], "",
         "| Tháng | Phạm vi | Thực chi | Trần | % trần |",
         "|---|---|---|---|---|"]
    tail = []
    for m in pack["months"]:
        s = fp_opscost.summary(conn, m, cfg, users)
        acts = s["actuals"]
        src = f"fn:agents.fp_opscost.summary {_mlabel(m)}"
        for scope in sorted(set(budget) | {k for k, v in acts.items() if v}):
            spent = acts.get(scope, 0)
            b = budget.get(scope)
            L.append(f"| {_mlabel(m)} | `{scope}` | "
                     f"{pack.fact(fp_pnl.vnd(spent), src)} | "
                     + (f"{pack.fact(fp_pnl.vnd(b), src_cfg)} | "
                        f"{pack.fact(fp_opscost._pct(spent, b), src)} |"
                        if b else "chưa có trần | — |"))
        wait = sum(1 for _e, st in s["over"] if st == "cho_tgd_ky")
        tail.append(
            f"- {_mlabel(m)}: cảnh báo trần "
            f"{pack.fact(len(s['alerts']), src)} · khoản vượt ngưỡng X "
            f"{pack.fact(len(s['over']), src)} (chờ TGĐ ký "
            f"{pack.fact(wait, src)})")
    return L + [""] + tail + [
        "", ("*Trần + ngưỡng X: `data/fpa_config.json` (GIẢ ĐỊNH — chờ GĐ "
             "tài chính chốt). Agent chỉ báo, không chi/không tắt key.*")]


def sec_pnl(conn, pack: Pack, now) -> list[str]:
    L = [SECTION_HEADS[4], "", f"**{fp_pnl.DRAFT_HEAD}.**", "",
         "| Tháng | Kênh | Doanh thu | Thực nhận | Lãi gộp (ô đủ giá vốn) |",
         "|---|---|---|---|---|"]
    totals, complete = 0, True
    for m in pack["months"]:
        res = fp_pnl.compute(conn, m)
        start, end = (d.date() for d in period_bounds("month", m))
        mau = conn.execute(
            "select coalesce(bool_or(file_name like '%%\\_MAU%%'), false)"
            " from settlement_rows where settled_on >= %s and settled_on"
            " < %s", (start, end)).fetchone()[0]
        pack["sample"] |= bool(mau)
        src = f"fn:agents.fp_pnl.compute {_mlabel(m)}"
        if not res["n_rows"]:
            complete = False
            L.append(f"| {_mlabel(m)} | — | {NO_DATA} | {NO_DATA} | — |")
            continue
        totals += res["tong_thuc_nhan"]
        by: dict = {}
        for c in res["cells"]:
            t = by.setdefault(c["channel"], [0, 0, None])
            t[0] += c["doanh_thu"] or 0
            t[1] += c["thuc_nhan"]
            if c["lai_gop"] is not None:      # ô thiếu giá vốn: không cộng
                t[2] = (t[2] or 0) + c["lai_gop"]
        for ch, (dt, tn, lg) in sorted(by.items()):
            L.append(f"| {_mlabel(m)} | {ch}{' (MẪU)' if mau else ''} | "
                     f"{pack.fact(fp_pnl.vnd(dt), src)} | "
                     f"{pack.fact(fp_pnl.vnd(tn), src)} | "
                     + ("—" if lg is None else pack.fact(fp_pnl.vnd(lg), src))
                     + " |")
        if res["loai"]:
            L.append(f"| {_mlabel(m)} | (ô thiếu giá vốn duyệt) | "
                     f"{pack.fact(len(res['loai']), src)} SKU | | |")
    tot = (pack.fact(fp_pnl.vnd(totals),
                     "db:settlement_rows Σ payout_vnd (fn:agents.fp_pnl."
                     "compute)")
           if complete else NOT_ENOUGH)
    pack["key"]["tong_thuc_nhan"] = totals if complete else None
    return L + ["", f"Tổng thực nhận quyết toán kỳ: {tot}"]


def sec_overrides(conn, pack: Pack, now) -> list[str]:
    res = bks_audit.check_overrides(conn, pack["start"], pack["end"])
    ovr = res["overrides"]
    pack["key"]["override_qa"] = len(ovr)
    src = "db:decisions kind override_qa (fn:agents.bks_audit."
    L = [SECTION_HEADS[5], "",
         (f"Số lần ép trình bản QA FAIL trong kỳ: "
          f"{pack.fact(len(ovr), src + 'check_overrides)')}"), ""]
    L += [pack.lines([bks_audit.override_line(o)],
                     f"db:decisions#{o['id']}")[0] for o in ovr] or [
        "- (không có)"]
    bad = [f for f in res["findings"] if f["code"] != "can_cu_sai"]
    if bad:
        L += ["", "Bất thường:"]
        L += pack.lines([bks_audit._finding_line(f) for f in bad],
                        "fn:agents.bks_audit.check_overrides")
    return L


_RUNS_SQL = (
    "select distinct on (kind) kind, id, created_at, findings,"
    " report_sha256, period_label from audit_runs where kind = any(%s) and"
    " created_at >= %s order by kind, id desc")


def sec_bks(conn, pack: Pack, now) -> list[str]:
    runs = {r[0]: r for r in conn.execute(
        _RUNS_SQL, ([k for k, _ in BKS_KINDS], pack["start"]))}
    L = [SECTION_HEADS[6], ""]
    for kind, name in BKS_KINDS:
        r = runs.get(kind)
        if r is None:
            L.append(f"- {name}: {NOT_RUN}")
            continue
        _k, rid, ts, n, sha, lbl = r
        src = f"audit_runs#{rid}"
        L.append(f"- {name}: chạy {ts.astimezone(VN_TZ):%d/%m/%Y} (kỳ "
                 f"{_cell(lbl)}) · {pack.fact(n, src)} phát hiện · mã băm "
                 f"báo cáo {pack.fact(sha[:12], src)} (audit_runs #{rid})")
    return L + ["", f"*{bks_audit.LIMIT_NOTE}*"]


SECTIONS = (sec_cockpit, sec_decisions, sec_risk, sec_opscost, sec_pnl,
            sec_overrides, sec_bks)


def build(conn, period: str, now: datetime, *, cfg: dict | None = None
          ) -> Pack:
    """→ Pack {label, kind, months, start, end, sections, facts, ...}. Kỳ
    sai/chưa đóng → ValueError."""
    per = parse_period(period, now)
    pack = Pack(per, facts=[], sections=[], sample=False, key={},
                config=cfg if cfg is not None else load_config(),
                generated_at=now, guardrail_violations=[], unreadable=0)
    for head, fn in zip(SECTION_HEADS, SECTIONS):
        n_facts = len(pack["facts"])
        try:
            with conn.transaction():
                pack["sections"].append(fn(conn, pack, now))
        except Exception as e:  # noqa: BLE001 — mục lỗi HIỆN trên trang
            del pack["facts"][n_facts:]     # fact của mục hỏng không tính
            why = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
            why = _cell(_mask_pii(safe(f"{type(e).__name__}: {why}")))[:160]
            pack["unreadable"] += 1
            pack["sections"].append([head, "", pack.lines(
                [f"*(không đọc được: {why})*"],
                f"fn:agents.hdtv_report.{fn.__name__}")[0]])
    return pack


# ------------------------------------------------------------------ render

def check_grounded(text: str, facts: list[dict]) -> list[str]:
    """Token số trên trang KHÔNG thuộc fact nào có nguồn → danh sách."""
    known: set[str] = set()
    for f in facts:
        if str(f.get("source") or "").strip():
            known |= num_tokens(f["text"]) | {
                t.rstrip(".,") for t in NUM_RE.findall(f["text"])}
    return sorted(num_tokens(text) - known)


def render(pack: dict) -> str:
    """Pack → markdown. Số không có fact → UngroundedNumber (fail-closed)."""
    kind_vi = "tháng" if pack["kind"] == "month" else "quý"
    last = pack["end"] - timedelta(days=1)
    mau = " (MẪU)" if pack["sample"] else ""
    L = [f"# Gói báo cáo HĐTV — {kind_vi} {pack['label']}{mau}", ""]
    if pack.get("guardrail_violations"):
        L += [("> **CẢNH BÁO GUARDRAIL — trang có vi phạm ("
               + ", ".join(pack["guardrail_violations"])
               + "), KHÔNG nộp duyệt cho tới khi sửa.**"), ""]
    gen = pack["generated_at"].astimezone(VN_TZ)
    L += [(f"**Kỳ:** {pack['start']:%d/%m/%Y} → {last:%d/%m/%Y} (giờ VN) · "
           f"**Sinh lúc:** {gen:%d/%m/%Y %H:%M} giờ VN"), "",
          ("Mọi con số do code điền từ DB/cấu hình và có nguồn (danh sách "
           "fact đi kèm bản dựng); thiếu số hiện `[chưa có dữ liệu]`, không "
           "hiện số không. Dòng *(MẪU)* là số liệu mẫu, không phải số vận "
           "hành thật.")]
    for sec in pack["sections"]:
        L += ["", *sec]
    L += ["", "---",
          ("*BẢN NHÁP — chờ TGĐ duyệt rồi trình HĐTV; chữ ký HĐTV/BKS là "
           "external-dep. Hệ thống KHÔNG tự duyệt, KHÔNG tự gửi. Sinh bởi "
           "`python -m agents.hdtv_report`.*"), ""]
    text = "\n".join(L)
    bad = check_grounded(text, pack["facts"])
    if bad:
        raise UngroundedNumber("số không có nguồn trên trang: "
                               + ", ".join(bad[:10]))
    return text


def finalize(pack: dict) -> tuple[str, bool]:
    text = render(pack)
    g = guardrail_check(text)
    if g.get("ok"):
        return text, True
    pack["guardrail_violations"] = sorted(
        {str(v.get("type")) for v in g.get("violations", [])
         if isinstance(v, dict)}) or ["?"]
    return render(pack), False


# ------------------------------------------------------------------ CLI

def main(argv=None, now=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.hdtv_report",
        description="Gói báo cáo HĐTV tháng/quý (BẢN NHÁP — không tự gửi)")
    ap.add_argument("--month", help="YYYY-MM")
    ap.add_argument("--quarter", help="YYYY-Qn")
    ap.add_argument("--now", help="ISO; thiếu múi giờ = giờ VN")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--submit", action="store_true",
                    help="nộp gói vào hàng chờ khối ceo (TGĐ duyệt)")
    ap.add_argument("--record", action="store_true",
                    help="ghi 1 dòng audit_runs kind hdtv_pack")
    a = ap.parse_args(argv)
    n_ops = (a.month is not None) + (a.quarter is not None)
    if n_ops != 1:
        ap.error("cần đúng 1 trong --month | --quarter")
    try:
        now = parse_now(a.now) if a.now else (now or datetime.now(VN_TZ))
    except ValueError:
        ap.error("--now sai định dạng ISO")
    period = a.month if a.month is not None else a.quarter
    if period == "prev":
        # Đợt hợp đồng C11: job tháng (deploy/onprem/jobs.json `hdtv_month`)
        # = tháng vừa ĐÓNG theo giờ VN.
        first = now.astimezone(VN_TZ).date().replace(day=1)
        period = f"{(first - timedelta(days=1)):%Y-%m}"
    try:
        parse_period(period, now)
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    try:
        cfg = load_config()
    except ConfigError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if not (a.submit or a.record):
            conn.read_only = True
        # v14.3 (HĐ 6.7): ceo-05 TẮT → không dựng gói (không file/sổ/hàng).
        from pipelines import rollout  # lười: rollout → director → ...
        try:
            rollout.check_generate(conn, FEATURE, "gói báo cáo HĐTV")
        except rollout.RolloutBlocked as e:
            print(f"[blocked] {e}", file=sys.stderr)
            return 2
        try:
            pack = build(conn, period, now, cfg=cfg)
            text, ok = finalize(pack)
        except UngroundedNumber as e:
            print(f"[error] {e}", file=sys.stderr)
            return 1
        path = write_report(text, a.out_dir, f"hdtv-{period}.md",
                            sample=pack["sample"])
        print(f"[done] {path} — kỳ {period}, {len(pack['facts'])} fact có "
              f"nguồn, {pack['unreadable']} mục không đọc được")
        if not ok:
            print("[warn] guardrail vi phạm: "
                  + ", ".join(pack["guardrail_violations"]))
        if a.record:
            rid = bks_audit.record_run(
                conn, "hdtv_pack", period,
                {"facts": len(pack["facts"]),
                 "unreadable": pack["unreadable"],
                 "guardrail_ok": ok}, pack["unreadable"], text, RUN_BY,
                sample=pack["sample"])
            print(f"[record] audit_runs #{rid}")
        if not a.submit:
            return 0
        if not ok:
            print("[error] gói vi phạm guardrail — KHÔNG nộp",
                  file=sys.stderr)
            return 1
        kind_vi = "tháng" if pack["kind"] == "month" else "quý"
        old = conn.execute("select id, status from approval_queue where"
                           " object_type = %s and object_id = %s order by id"
                           " desc limit 1", (OBJECT_TYPE, period)).fetchone()
        if old is not None:      # C11: chạy lại lịch không nhân bản/không lỗi
            print(f"[skipped] kỳ {period} đã có mục #{old[0]} ({old[1]}) — "
                  "không nộp lại")
            return 0
        try:
            qid = director.submit(
                conn, "ceo", OBJECT_TYPE, object_id=period,
                title=f"Gói báo cáo HĐTV {kind_vi} {period}", payload=text,
                created_by=RUN_BY, sample=pack["sample"])
        except (psycopg.Error, ValueError, director.DirectorConfigError) as e:
            msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
            print(f"[error] không nộp được hàng chờ: {_cell(msg)[:300]}",
                  file=sys.stderr)
            return 1
        print(f"[submit] mục #{qid} vào hàng chờ khối ceo (pending — TGĐ "
              "duyệt; hệ thống KHÔNG tự duyệt, KHÔNG tự gửi HĐTV)")
        return 0
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_cell(_mask_pii(_db_msg(e)))[:300]}",
              file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.rollback()
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2).
    with job_run("agents.hdtv_report") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
