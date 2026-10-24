"""v6.4 MKT-05 (WP08) — phiếu THỬ NGHIỆM quảng cáo + đề xuất dừng/tiếp từ
file kết quả xuất tay. Tất định Python/SQL, KHÔNG LLM, KHÔNG mạng.

Ranh giới (acceptance WP08): agent KHÔNG chi tiền, KHÔNG gọi API quảng cáo
(Meta/TikTok/Shopee Ads — tài khoản + API là external-dep), KHÔNG cài chiến
dịch. Output DUY NHẤT: 1 dòng `ad_test_plans` (insert-only) + 2 mục NHÁP
`approval_queue` risk high cùng object_id `adtest-<id>` —
`marketing/ad_campaign` (GĐ Marketing) + `finance/budget_change` (khối
finance — vai trò `tgd` tạm thay GĐ tài chính). Phiếu chỉ "đã duyệt" khi
CẢ 2 mục approved; Quản lý MXH cài tay sau đó.

Ánh xạ chính sách kênh (kế hoạch MKT) → readiness đang chạy (golden +
view `sku_readiness` là nguồn sự thật, không thêm cột):
  offline_only = category `alcohol` (rượu — xét TRƯỚC readiness)
  listing_only = readiness `MO_TA` (TPBVSK chưa XNQC)
  CAM          = readiness CAM còn lại (kênh ngoài allowed_channels, thực
                 phẩm chưa tự công bố, SKU không có trong view)
  online_ok    = `TP_THUONG` | `QC_DAY_DU` (`mkt_calendar.CONTENT_OK`)

Hàm THUẦN `validate_plan` → (mã | None, lý do), mã theo thứ tự ưu tiên
`REJECT_CODES`. Trần ngân sách = `fp_ads.propose` trên P&L tháng tham chiếu
(`cap_for` — không chép công thức). Bị từ chối → KHÔNG ghi gì.

File phiếu JSON (MẪU `tests/fixtures/mkt/`): `sku_key`, `channel`,
`hypothesis` (10..500 ký tự), `creative_draft_ids` (1..3 id
`content_drafts` đã duyệt, loại ads|image), `budget_vnd`, `start_date`/
`end_date` (YYYY-MM-DD, ≥ hôm nay VN, ≤ 30 ngày), `success_metric`
{metric, op, target}, `stop_rules` [{metric, op, value}] — metric ∈
ctr|cpc|cpa|don_hang (ctr = click/hiển thị dạng tỉ lệ 0..1), op ∈ >=|<=;
`_doc` tùy chọn (bỏ qua). Key lạ → ADS_INPUT.

File kết quả CSV (cột GIẢ ĐỊNH — người có tài khoản ads xuất 1 file thật
để đối chiếu header): `ngay,bien_the,hien_thi,click,chi_phi_vnd,don_hang`.
`evaluate` → `dung` | `dat_muc_tieu` | `tiep` | `chua_du_lieu` — KHÔNG có
nhánh nâng ngân sách (muốn chi thêm = lập phiếu mới qua trần).

Chạy:
  python -m agents.mkt_ads --plan FILE.json --by "Tên" [--month YYYY-MM] [--dry-run]
  python -m agents.mkt_ads --status ID
  python -m agents.mkt_ads --results FILE.csv --plan-id N --by "Tên" [--dry-run]
Exit: 0 ok/skip · 1 bị từ chối (in mã) / cấu hình / DB lỗi · 2 usage / DB down.
"""

import argparse
import csv
import hashlib
import io
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

import psycopg

from agents import fp_ads, fp_pnl
from agents.fp_pnl import parse_month, vnd
from ingest.golden_store import CHANNELS
from ingest.lead_store import connect
from pipelines import director, guardrail, store
from pipelines.mkt_calendar import CONTENT_OK
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

ROOT = Path(__file__).resolve().parent.parent

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

REJECT_CODES = ("ADS_INPUT", "ADS_OFFLINE_ONLY", "ADS_LISTING_ONLY", "ADS_CAM",
                "ADS_XNQC_DOSSIER", "ADS_CREATIVE_UNAPPROVED", "ADS_NO_CAP",
                "ADS_OVER_CAP")
NOT_APPROVED = "ADS_PLAN_NOT_APPROVED"
PLAN_KEYS = ("sku_key", "channel", "hypothesis", "creative_draft_ids",
             "budget_vnd", "start_date", "end_date", "success_metric",
             "stop_rules")
METRICS = ("ctr", "cpc", "cpa", "don_hang")
OPS = (">=", "<=")
CREATIVE_TYPES = ("ads", "image")
MAX_DAYS = 30
MAX_CREATIVES = 3
MAX_STOP_RULES = 10
BUDGET_CAP = 10**12
MAX_PLAN_BYTES = 64_000
MAX_CSV_BYTES = 5_000_000
MAX_CSV_ROWS = 10_000
RESULT_COLS = ("ngay", "bien_the", "hien_thi", "click", "chi_phi_vnd",
               "don_hang")
DECISIONS = ("dung", "dat_muc_tieu", "tiep", "chua_du_lieu")
ITEMS = (("marketing", "ad_campaign"), ("finance", "budget_change"))
RESULT_OT = "ad_result"           # marketing-03.2 (kết quả + giữ/tắt)
# v15.2 (P8.2): mục `finance/budget_change` của phiếu ads mang agent id RIÊNG
# (không phải tên người lập, không trùng `agent:fp_ads` của finance-04.2) để
# rollout quy đúng tính năng marketing-03 (đếm đầu ra + biên dùng). Người lập
# vẫn không tự duyệt được: mục marketing giữ created_by = người lập (DB chặn)
# + `plan_status` coi người lập duyệt mục ngân sách = `cung_nguoi_duyet`.
BUDGET_AGENT = "agent:mkt05_budget"
NOTE = ("ĐỀ XUẤT — agent không chi tiền, không gọi API quảng cáo; Quản lý "
        "MXH cài tay sau khi GĐ Marketing + GĐ tài chính duyệt.")
RES_NOTE = ("ĐỀ XUẤT dừng/tiếp — người quyết; agent không chi tiền, không "
            "đổi ngân sách trên nền tảng. Muốn chi thêm phải lập phiếu mới "
            "qua trần FP&A.")
FLAG_OVER = "CHI VƯỢT PHIẾU"
FLAG_SPENT = "HẾT NGÂN SÁCH PHIẾU"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _num(v) -> Decimal | None:
    """Số JSON dương (int/float, không bool) → Decimal; sai → None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        return None
    return d if d.is_finite() and d > 0 else None


def _date(v) -> date | None:
    if isinstance(v, date):
        return v
    if not isinstance(v, str) or not _DATE_RE.fullmatch(v):
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        return None


def vn_today() -> date:
    return datetime.now(VN_TZ).date()


def _rule(r, key: str, where: str):
    if not isinstance(r, dict) or set(r) != {"metric", "op", key}:
        return None, f"{where}: cần object {{metric, op, {key}}}"
    if r["metric"] not in METRICS:
        return None, f"{where}.metric phải {'|'.join(METRICS)}"
    if r["op"] not in OPS:
        return None, f"{where}.op phải {'|'.join(OPS)}"
    n = _num(r[key])
    if n is None:
        return None, f"{where}.{key} phải là số > 0"
    return {"metric": r["metric"], "op": r["op"], key: str(n)}, None


def normalize_plan(plan, today: date) -> tuple[dict | None, str | None]:
    """Kiểm + chuẩn hóa phiếu (THUẦN) → (norm, None) | (None, lý do)."""
    if not isinstance(plan, dict):
        return None, "phiếu phải là object JSON"
    stray = sorted(set(plan) - set(PLAN_KEYS) - {"_doc"})
    if stray:
        return None, f"key lạ: {[str(k)[:30] for k in stray[:5]]}"
    miss = [k for k in PLAN_KEYS if k not in plan]
    if miss:
        return None, f"thiếu field: {miss}"
    sku, ch = plan["sku_key"], plan["channel"]
    if not isinstance(sku, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,79}",
                                                    sku):
        return None, "sku_key phải slug a-z0-9-"
    if ch not in CHANNELS:
        return None, f"channel phải ∈ {CHANNELS}"
    hyp = plan["hypothesis"]
    if not isinstance(hyp, str) or not 10 <= len(hyp.strip()) <= 500:
        return None, "hypothesis phải 10..500 ký tự"
    ids = plan["creative_draft_ids"]
    if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_CREATIVES
            or not all(_is_int(i) and i > 0 for i in ids)
            or len(set(ids)) != len(ids)):
        return None, (f"creative_draft_ids phải 1..{MAX_CREATIVES} id draft "
                      "số dương, không trùng")
    bud = plan["budget_vnd"]
    if not _is_int(bud) or not 0 < bud <= BUDGET_CAP:
        return None, "budget_vnd phải số nguyên đồng > 0"
    start, end = _date(plan["start_date"]), _date(plan["end_date"])
    if start is None or end is None:
        return None, "start_date/end_date phải YYYY-MM-DD hợp lệ"
    if start < today:
        return None, f"start_date trước hôm nay ({today:%Y-%m-%d}, giờ VN)"
    if end < start or (end - start).days > MAX_DAYS:
        return None, f"thời gian phải 0..{MAX_DAYS} ngày (end ≥ start)"
    sm, why = _rule(plan["success_metric"], "target", "success_metric")
    if why:
        return None, why
    rules = plan["stop_rules"]
    if not isinstance(rules, list) or not 1 <= len(rules) <= MAX_STOP_RULES:
        return None, f"stop_rules phải 1..{MAX_STOP_RULES} điều kiện"
    stops = []
    for i, r in enumerate(rules):
        s, why = _rule(r, "value", f"stop_rules[{i}]")
        if why:
            return None, why
        stops.append(s)
    return {"sku_key": sku, "channel": ch, "hypothesis": hyp.strip(),
            "creative_draft_ids": list(ids), "budget_vnd": bud,
            "start_date": start, "end_date": end, "success_metric": sm,
            "stop_rules": stops}, None


def plan_sha(norm: dict) -> str:
    """sha256 JSON chuẩn hóa (sort_keys, ngày ISO) — chạy lại cùng phiếu =
    cùng sha = không tạo phiếu thứ 2."""
    doc = {**norm, "start_date": norm["start_date"].isoformat(),
           "end_date": norm["end_date"].isoformat()}
    raw = json.dumps(doc, sort_keys=True, ensure_ascii=False,
                     separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _creative_why(i, c, norm, readiness) -> str | None:
    if not isinstance(c, dict):
        return f"draft #{i} không tồn tại"
    if c.get("status") != "approved":
        return f"draft #{i} chưa duyệt (trạng thái {c.get('status')})"
    if c.get("sku") != norm["sku_key"]:
        return f"draft #{i} gắn SKU khác SKU phiếu"
    if c.get("content_type") not in CREATIVE_TYPES:
        return f"draft #{i} loại {c.get('content_type')} — cần ads|image"
    if c.get("verified") is not True:
        return f"draft #{i} không khớp bản đã duyệt (verify_publish)"
    g = guardrail.check_publish(
        c.get("text") or "", channel=norm["channel"], content_type="ads",
        sku=norm["sku_key"], is_ai=c.get("is_ai") is not False,
        is_sponsored=True, readiness=readiness)
    if g.get("ok") is not True:
        codes = sorted({v.get("code") for v in g.get("violations", [])
                        if isinstance(v, dict)})
        return f"draft #{i} không qua guardrail quảng cáo kênh phiếu {codes}"
    return None


def validate_plan(plan, *, golden: dict, readiness: dict, creatives: dict,
                  cap: dict | None, today: date, dossier_ok: bool = False,
                  allocated: int = 0) -> tuple[str | None, str]:
    """THUẦN. golden {sku: {category}}, readiness {(sku, kênh): mức view},
    creatives {id: {status, sku, content_type, text, is_ai, verified}},
    cap {code, budget_vnd} từ fp_ads (None = không tính được), dossier_ok =
    SKU có hồ sơ XNQC `da_cap` còn hạn, allocated = tổng ngân sách phiếu
    KHÁC đang giữ trần cùng SKU × kênh × tháng (`allocated_vnd`) — trần là
    trần THÁNG, chẻ nhiều phiếu nhỏ vẫn cộng dồn. → (mã | None, lý do)."""
    norm, why = normalize_plan(plan, today)
    if norm is None:
        return "ADS_INPUT", why
    sku, ch = norm["sku_key"], norm["channel"]
    g = golden.get(sku)
    if isinstance(g, dict) and g.get("category") == "alcohol":
        return "ADS_OFFLINE_ONLY", ("SKU nhóm offline_only (đồ uống có cồn) "
                                    "— không quảng cáo online")
    lvl = readiness.get((sku, ch))
    if lvl == "MO_TA":
        return "ADS_LISTING_ONLY", (f"{sku} × {ch}: listing_only (TPBVSK "
                                    "chưa XNQC) — chỉ mô tả, không ads")
    if lvl not in CONTENT_OK or not isinstance(g, dict):
        return "ADS_CAM", f"{sku} × {ch}: readiness {lvl or 'không có'}"
    if g.get("category") == "tpbvsk" and not dossier_ok:
        return "ADS_XNQC_DOSSIER", (f"{sku}: không có hồ sơ XNQC da_cap còn "
                                    "hạn trong sổ xnqc_dossiers")
    for i in norm["creative_draft_ids"]:
        why = _creative_why(i, creatives.get(i), norm, readiness)
        if why:
            return "ADS_CREATIVE_UNAPPROVED", why
    if not isinstance(cap, dict) or cap.get("code") != "DE_XUAT":
        code = cap.get("code") if isinstance(cap, dict) else "không có"
        return "ADS_NO_CAP", (f"{sku} × {ch}: FP&A không có trần ngân sách "
                              f"(mã {code})")
    if norm["budget_vnd"] + allocated > cap["budget_vnd"]:
        extra = (f" + đã phân bổ {vnd(allocated)} (phiếu khác cùng SKU × kênh"
                 " × tháng, chưa từ chối/hết hạn)") if allocated else ""
        return "ADS_OVER_CAP", (f"ngân sách {vnd(norm['budget_vnd'])}{extra}"
                                f" > trần {vnd(cap['budget_vnd'])}")
    return None, "đạt"


# ---------- kết quả chạy ads (file xuất tay) ----------

_INT_RE = re.compile(r"\d+|\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*")


def _int_cell(raw: str) -> int | None:
    """Số nguyên ≥ 0, chấp nhận phân cách nghìn CÙNG ký tự (1.234.567) —
    '12.5' không phải số nguyên → None (không đoán)."""
    s = (raw or "").strip()
    if not s.isascii() or not _INT_RE.fullmatch(s):
        return None
    return int(s.replace(".", "").replace(",", ""))


def read_results(path, plan: dict) -> tuple[list[dict], list[str], str | None]:
    """THUẦN trên file: CSV bytes (utf-8-sig) → (rows, lỗi, sha256 file).
    Lỗi dạng 'dòng N cột X: lý do' — KHÔNG in giá trị ô."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        return [], [f"không đọc được file ({type(e).__name__})"], None
    sha = hashlib.sha256(raw).hexdigest()
    if len(raw) > MAX_CSV_BYTES:
        return [], [f"file quá lớn (> {MAX_CSV_BYTES} byte)"], sha
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [], ["file không phải UTF-8"], sha
    try:
        recs = list(csv.reader(io.StringIO(text, newline="")))
    except csv.Error:   # ô > field_limit / CSV hỏng — không traceback
        return [], ["file CSV hỏng (ô quá lớn hoặc sai định dạng)"], sha
    while recs and not any(c.strip() for c in recs[-1]):
        recs.pop()
    if not recs:
        return [], ["file rỗng"], sha
    head = [h.strip() for h in recs[0]]
    errs = []
    for h in head:
        if h not in RESULT_COLS:
            errs.append(f"dòng 1 cột {_oneline(_mask_pii(h), 30)!r}: cột lạ "
                        "— chặn cả file")
    for c in RESULT_COLS:
        if head.count(c) != 1:
            errs.append(f"dòng 1 cột {c}: thiếu hoặc trùng cột")
    if errs:
        return [], errs, sha
    if len(recs) - 1 > MAX_CSV_ROWS:
        return [], [f"quá {MAX_CSV_ROWS} dòng dữ liệu"], sha
    ids = set(plan["creative_draft_ids"])
    rows = []
    for n, rec in enumerate(recs[1:], start=2):
        if not any(c.strip() for c in rec):
            continue
        if len(rec) != len(head):
            errs.append(f"dòng {n}: số cột {len(rec)} ≠ {len(head)}")
            continue
        cell = dict(zip(head, rec))
        row, bad = {"row_no": n}, []
        d = _date(cell["ngay"].strip())
        if d is None:
            bad.append(("ngay", "không phải ngày YYYY-MM-DD"))
        elif not plan["start_date"] <= d <= plan["end_date"]:
            bad.append(("ngay", "ngoài thời gian phiếu"))
        row["ngay"] = d
        for c in RESULT_COLS[1:]:
            v = _int_cell(cell[c])
            if v is None:
                bad.append((c, "không phải số nguyên ≥ 0"))
            row[c] = v
        if row["bien_the"] is not None and row["bien_the"] not in ids:
            bad.append(("bien_the", "không thuộc creative_draft_ids của phiếu"))
        if (row["click"] is not None and row["hien_thi"] is not None
                and row["click"] > row["hien_thi"]):
            bad.append(("click", "click > hien_thi"))
        errs += [f"dòng {n} cột {c}: {why}" for c, why in bad]
        if not bad:
            rows.append(row)
    if not errs and not rows:
        errs.append("file không có dòng dữ liệu")
    return ([], errs, sha) if errs else (rows, [], sha)


def _ratio(a: int, b: int) -> Decimal | None:
    return None if not b else Decimal(a) / Decimal(b)


def _metrics(agg: dict) -> dict:
    return {**agg, "ctr": _ratio(agg["click"], agg["hien_thi"]),
            "cpc": _ratio(agg["chi_phi_vnd"], agg["click"]),
            "cpa": _ratio(agg["chi_phi_vnd"], agg["don_hang"])}


def _hit(m: dict, rule: dict, key: str) -> bool:
    v = m.get(rule["metric"])
    if v is None:
        return False
    t = Decimal(str(rule[key]))
    return Decimal(v) >= t if rule["op"] == ">=" else Decimal(v) <= t


def evaluate(plan: dict, rows: list[dict]) -> dict:
    """THUẦN: tổng + theo biến thể (ctr/cpc/cpa — mẫu 0 → None) +
    điều kiện dừng chạm + đề xuất ∈ DECISIONS (không có nhánh nâng ngân
    sách)."""
    zero = dict.fromkeys(RESULT_COLS[2:], 0)
    tot, per = dict(zero), {i: dict(zero) for i in plan["creative_draft_ids"]}
    for r in rows:
        for c in RESULT_COLS[2:]:
            tot[c] += r[c]
            per[r["bien_the"]][c] += r[c]
    m = _metrics(tot)
    hits = [r for r in plan["stop_rules"] if _hit(m, r, "value")]
    flags = []
    if tot["chi_phi_vnd"] > plan["budget_vnd"]:
        flags.append(FLAG_OVER)
    elif tot["chi_phi_vnd"] == plan["budget_vnd"]:
        flags.append(FLAG_SPENT)
    dat = _hit(m, plan["success_metric"], "target")
    if hits or flags:
        dx = "dung"
    elif tot["hien_thi"] == 0:
        dx = "chua_du_lieu"
    elif dat:
        dx = "dat_muc_tieu"
    else:
        dx = "tiep"
    return {"tong": m, "bien_the": {i: _metrics(a) for i, a in per.items()},
            "stop_hits": hits, "dat_muc_tieu": dat, "co": flags,
            "de_xuat": dx}


# ---------- payload ----------

def _fmt(v, metric: str) -> str:
    if v is None:
        return "—"
    v = Decimal(v)
    if metric == "ctr":
        return f"{(v * 100).quantize(Decimal('0.01'))}%"
    if metric == "don_hang":
        return str(int(v))
    return vnd(v.quantize(Decimal(1)))


def _rule_txt(r: dict, key: str) -> str:
    return f"{r['metric']} {r['op']} {_fmt(r[key], r['metric'])}"


def render_plan(row: dict) -> str:
    """Payload markdown 2 mục hàng duyệt — dựng từ DÒNG DB (tất định)."""
    L = [f"# Phiếu thử nghiệm ads #{row['id']} (NHÁP)", "", f"**{NOTE}**", "",
         (f"- SKU: `{row['sku_key']}` · kênh ads: {row['channel']} · "
         f"readiness {row['readiness']}"),
         f"- Giả thuyết: {_oneline(row['hypothesis'], 500)}",
         "- Biến thể creative (content_drafts đã duyệt): "
         + ", ".join(f"#{i}" for i in row["creative_draft_ids"]),
         (f"- Ngân sách đề xuất: {vnd(row['budget_vnd'])} (trần FP&A "
         f"{vnd(row['cap_vnd'])} theo P&L tháng "
         f"{row['cap_ref_month']:%m/%Y} — cấu hình fpa_config GIẢ ĐỊNH; "
         f"phiếu khác cùng SKU × kênh × tháng đã giữ "
         f"{vnd(row['allocated_vnd'])} lúc lập)"),
         (f"- Thời gian: {row['start_date']:%d/%m/%Y} → "
         f"{row['end_date']:%d/%m/%Y}"),
         f"- Chỉ số thành công: {_rule_txt(row['success_metric'], 'target')}",
         "- Điều kiện dừng (bất kỳ): "
         + "; ".join(_rule_txt(r, "value") for r in row["stop_rules"]),
         (f"- plan_sha256: `{row['plan_sha256']}` · người lập: "
         f"{row['created_by']}"), "",
         ("Duyệt đủ 2 mục (marketing/ad_campaign + finance/budget_change cùng "
         f"`adtest-{row['id']}`) phiếu mới được cài."), ""]
    return "\n".join(L)


def render_result(row: dict, ev: dict, file_sha: str, n_rows: int) -> str:
    t = ev["tong"]
    L = [f"# Kết quả thử nghiệm ads — phiếu #{row['id']} (NHÁP)", "",
         f"**{RES_NOTE}**", "",
         f"- Đề xuất: **{ev['de_xuat']}**"
         + (f" — {', '.join(ev['co'])}" if ev["co"] else ""),
         f"- File kết quả sha256 `{file_sha[:12]}` · {n_rows} dòng",
         (f"- Tổng: hiển thị {t['hien_thi']}, click {t['click']}, chi "
         f"{vnd(t['chi_phi_vnd'])} / ngân sách phiếu {vnd(row['budget_vnd'])}"
         f", đơn {t['don_hang']}"),
         (f"- CTR {_fmt(t['ctr'], 'ctr')} · CPC {_fmt(t['cpc'], 'cpc')} · CPA "
         f"{_fmt(t['cpa'], 'cpa')}"),
         (f"- Chỉ số thành công {_rule_txt(row['success_metric'], 'target')}"
         f": {'ĐẠT' if ev['dat_muc_tieu'] else 'chưa đạt'}"),
         "- Điều kiện dừng chạm: "
         + ("; ".join(_rule_txt(r, "value") for r in ev["stop_hits"])
            or "(không)"), "",
         "| Biến thể | Hiển thị | Click | Chi | Đơn | CTR | CPC | CPA |",
         "|---|---|---|---|---|---|---|---|"]
    for i, m in ev["bien_the"].items():
        L.append(f"| #{i} | {m['hien_thi']} | {m['click']} | "
                 f"{vnd(m['chi_phi_vnd'])} | {m['don_hang']} | "
                 f"{_fmt(m['ctr'], 'ctr')} | {_fmt(m['cpc'], 'cpc')} | "
                 f"{_fmt(m['cpa'], 'cpa')} |")
    L.append("")
    return "\n".join(L)


# ---------- DB ----------

def load_cfgs():
    """→ (fp_ads cfg, {block: director cfg}, lỗi | None) — gọi TRƯỚC
    connect."""
    cfg, why = fp_ads.load_cfg()
    if cfg is None:
        return None, None, why
    try:
        dcfg = {b: director.load_config(b) for b, _ in ITEMS}
    except director.DirectorConfigError as e:
        return None, None, f"cấu hình khối: {e}"
    return cfg, dcfg, None


def cap_for(conn, sku: str, channel: str, month: date, cfg: dict) -> dict:
    """Trần = `fp_ads.propose` trên P&L tháng tham chiếu (không chép công
    thức) → {code, budget_vnd}. Kênh ngoài cấu hình ads → NGOAI_KENH_ADS."""
    if channel not in cfg["channels"]:
        return {"code": "NGOAI_KENH_ADS", "budget_vnd": 0}
    props = fp_ads.propose(fp_pnl.compute(conn, month)["cells"],
                           fp_ads.fetch_readiness(conn, cfg["channels"]), cfg)
    for p in props:
        if (p["sku_key"], p["channel"]) == (sku, channel):
            return {"code": p["code"], "budget_vnd": p["budget_vnd"]}
    return {"code": "CHAN_CAM", "budget_vnd": 0}


def allocated_vnd(conn, norm: dict, month: date) -> int:
    """Tổng `budget_vnd` các phiếu KHÁC (sha khác) cùng SKU × kênh đang giữ
    trần tháng: cùng `cap_ref_month` HOẶC khung chạy chạm cùng tháng lịch
    với phiếu mới (chặn cả đường đổi --month để lách). Phiếu `tu_choi`/
    `het_han` trả trần lại; trạng thái khác (chờ/thiếu mục/lệch bản
    duyệt/đã duyệt) vẫn tính — fail-closed."""
    m0 = norm["start_date"].replace(day=1)
    m1 = norm["end_date"].replace(day=1)
    rows = conn.execute(
        "select id, budget_vnd from ad_test_plans where sku_key = %s and"
        " channel = %s and plan_sha256 <> %s and (cap_ref_month = %s or"
        " (end_date >= %s and start_date < %s::date + interval '1 month'))",
        (norm["sku_key"], norm["channel"], plan_sha(norm), month, m0,
         m1)).fetchall()
    return sum(b for pid, b in rows
               if plan_status(conn, pid) not in ("tu_choi", "het_han"))


def load_context(conn, norm: dict, month: date, cfg: dict,
                 today: date) -> dict:
    golden = {k: {"category": c} for k, c in conn.execute(
        "select sku_key, category from sku_master")}
    readiness = fp_ads.fetch_readiness(conn, CHANNELS)
    creatives = {}
    for did, st, sku, ct, text, is_ai in conn.execute(
            "select id, status, sku, content_type, text, is_ai from"
            " content_drafts where id = any(%s)",
            (norm["creative_draft_ids"],)):
        creatives[did] = {"status": st, "sku": sku, "content_type": ct,
                          "text": text, "is_ai": is_ai,
                          "verified": store.verify_publish(conn, did, text)}
    dossier_ok = conn.execute(
        "select exists(select 1 from xnqc_dossiers where sku_key = %s and"
        " status = 'da_cap' and (ngay_het_han is null or ngay_het_han >= %s))",
        (norm["sku_key"], today)).fetchone()[0]
    cap = cap_for(conn, norm["sku_key"], norm["channel"], month, cfg)
    return {"golden": golden, "readiness": readiness, "creatives": creatives,
            "cap": cap, "dossier_ok": bool(dossier_ok),
            "allocated": allocated_vnd(conn, norm, month)}


_ROW_COLS = ("id", "plan_sha256", "sku_key", "channel", "hypothesis",
             "creative_draft_ids", "budget_vnd", "cap_vnd", "allocated_vnd",
             "cap_ref_month",
             "start_date", "end_date", "success_metric", "stop_rules",
             "readiness", "created_by")


def get_plan(conn, pid) -> dict | None:
    row = conn.execute(f"select {', '.join(_ROW_COLS)} from ad_test_plans"
                       " where id = %s", (pid,)).fetchone()
    return dict(zip(_ROW_COLS, row)) if row else None


def _item_exists(conn, object_type: str, object_id: str) -> bool:
    return conn.execute(
        "select exists(select 1 from approval_queue where object_type = %s"
        " and object_id = %s)", (object_type, object_id)).fetchone()[0]


class _OverCap(Exception):
    """Đếm lại sau khóa vượt trần — thoát tx, không ghi."""


def submit_plan(conn, plan, *, by: str, month: date, cfg: dict, dcfg: dict,
                today: date, dry_run: bool = False) -> dict:
    """→ {code, reason, plan_id, new_items, created}. Bị từ chối → 0 ghi."""
    norm, why = normalize_plan(plan, today)
    if norm is None:
        return {"code": "ADS_INPUT", "reason": why}
    ctx = load_context(conn, norm, month, cfg, today)
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    code, why = validate_plan(plan, today=today, **ctx)
    if code:
        return {"code": code, "reason": why}
    sha = plan_sha(norm)
    probe = {**norm, "id": 0, "plan_sha256": sha, "cap_vnd":
             ctx["cap"]["budget_vnd"], "allocated_vnd": ctx["allocated"],
             "cap_ref_month": month,
             "readiness": ctx["readiness"][(norm["sku_key"],
                                            norm["channel"])],
             "created_by": by}
    g = guardrail.check(render_plan(probe))
    if g.get("ok") is not True:
        codes = sorted({v.get("code") for v in g.get("violations", [])})
        return {"code": "ADS_INPUT", "reason": ("giả thuyết làm phiếu vi phạm"
                                                f" guardrail {codes} — viết "
                                                "lại")}
    if dry_run:
        return {"code": None, "reason": "đạt (dry-run, không ghi)",
                "plan_id": None, "new_items": [], "created": False,
                "cap": ctx["cap"]["budget_vnd"]}
    row = conn.execute("select id from ad_test_plans where plan_sha256 = %s",
                       (sha,)).fetchone()
    created = row is None
    if created:
        try:
            with conn.transaction():
                # khóa theo SKU × kênh tới commit: 2 phiếu song song không
                # cùng thấy "còn trần" rồi cùng ghi (đếm lại sau khóa)
                lock_key = f"ad_test_plans:{norm['sku_key']}:{norm['channel']}"
                conn.execute("select pg_advisory_xact_lock(hashtext(%s))",
                             (lock_key,))
                alloc = allocated_vnd(conn, norm, month)
                if alloc + norm["budget_vnd"] > probe["cap_vnd"]:
                    raise _OverCap(alloc)
                row = conn.execute(
                    "insert into ad_test_plans (plan_sha256, sku_key, channel,"
                    " hypothesis, creative_draft_ids, budget_vnd, cap_vnd,"
                    " allocated_vnd, cap_ref_month, start_date, end_date,"
                    " success_metric, stop_rules, readiness, created_by)"
                    " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
                    " %s::jsonb, %s::jsonb, %s, %s) returning id",
                    (sha, norm["sku_key"], norm["channel"], norm["hypothesis"],
                     norm["creative_draft_ids"], norm["budget_vnd"],
                     probe["cap_vnd"], alloc, month, norm["start_date"],
                     norm["end_date"], json.dumps(norm["success_metric"]),
                     json.dumps(norm["stop_rules"]), probe["readiness"],
                     by)).fetchone()
            conn.commit()
        except _OverCap as e:
            with suppress(Exception):
                conn.rollback()
            return {"code": "ADS_OVER_CAP", "reason": (
                f"ngân sách {vnd(norm['budget_vnd'])} + đã phân bổ "
                f"{vnd(e.args[0])} > trần {vnd(probe['cap_vnd'])} (phiếu khác "
                "vừa ghi song song)")}
        except psycopg.errors.UniqueViolation:   # tạo song song cùng phiếu
            with suppress(Exception):
                conn.rollback()
            created = False
            row = conn.execute("select id from ad_test_plans where"
                               " plan_sha256 = %s", (sha,)).fetchone()
    pid = row[0]
    prow = get_plan(conn, pid)
    payload = render_plan(prow)
    title = (f"Phiếu thử nghiệm ads #{pid} — {prow['sku_key']} × "
             f"{prow['channel']} — {vnd(prow['budget_vnd'])}")
    new = []
    for block, otype in ITEMS:
        oid = f"adtest-{pid}"
        if _item_exists(conn, otype, oid):
            continue
        try:
            new.append(director.submit(
                conn, block, otype, oid, title, payload,
                created_by=BUDGET_AGENT if otype == "budget_change" else by,
                cfg=dcfg[block]))
        except psycopg.errors.UniqueViolation:
            with suppress(Exception):
                conn.rollback()
    conn.commit()
    return {"code": None, "reason": "đạt", "plan_id": pid, "new_items": new,
            "created": created, "cap": prow["cap_vnd"]}


# ---------- docx vòng 2: agent TỰ đề xuất (marketing-03) ----------
# PL01 Marketing "Đề xuất quảng cáo nhỏ cho sản phẩm được phép; theo dõi chi
# phí mỗi đơn; đề xuất giữ hay tắt": trước đây người lập phải viết sẵn cả
# phiếu (`--plan`). `propose` dựng phiếu từ nguồn đã có: ô SKU × kênh FP&A
# cho `DE_XUAT` (trần = `fp_ads.propose`, đã loại CAM/XNQC/biên thấp), nháp
# creative ĐÃ duyệt đúng SKU (verify_publish + guardrail quảng cáo — chọn bởi
# chính `validate_plan`), tham số `data/ads_proposal.json` (chủ khối chốt) →
# `submit_plan` (cùng luật chặn + 2 mục hàng duyệt marketing/finance). Mỗi
# SKU × kênh × tháng trần tối đa 1 đề xuất agent còn hiệu lực (chạy lại
# không nhân bản). Không đủ điều kiện → THIẾU có lý do, không bịa số.
PROPOSAL_FILE = ROOT / "data" / "ads_proposal.json"
PROPOSE_AGENT = "agent:mkt05"
FEATURE = "marketing-03.1"        # đề xuất phiếu (03.2 = ad_result)
_PROP_KEYS = ("chot_boi", "can_cu", "ty_le_tran", "so_ngay_chay",
              "bat_dau_sau_ngay", "success_metric", "stop_rules")


def load_proposal_cfg(path=None) -> tuple[dict | None, str | None]:
    """→ (cfg, None) | (None, lý do BLOCKED). Thiếu/null/sai = chưa chốt."""
    try:
        doc = json.loads(Path(path or PROPOSAL_FILE).read_bytes()
                         .decode("utf-8"))
    except (OSError, ValueError) as e:
        return None, f"ads_proposal.json không đọc được ({type(e).__name__})"
    if not isinstance(doc, dict) or set(doc) - {"_doc"} != set(_PROP_KEYS):
        return None, f"ads_proposal.json cần đúng key {_PROP_KEYS}"
    miss = [k for k in _PROP_KEYS if doc[k] is None]
    if miss:
        return None, ("tham số đề xuất CHƯA CHỐT (GĐ Marketing): "
                      + ", ".join(miss))
    if not all(isinstance(doc[k], str) and doc[k].strip()
               and not doc[k].strip().lower().startswith(("agent:",
                                                          "system:"))
               for k in ("chot_boi", "can_cu")):
        return None, "chot_boi/can_cu phải là người + căn cứ"
    r = doc["ty_le_tran"]
    if isinstance(r, bool) or not isinstance(r, (int, float)) \
            or not 0 < r <= 1:
        return None, "ty_le_tran phải trong (0, 1]"
    if not (_is_int(doc["so_ngay_chay"]) and 1 <= doc["so_ngay_chay"]
            <= MAX_DAYS + 1) or not (_is_int(doc["bat_dau_sau_ngay"])
                                     and 0 <= doc["bat_dau_sau_ngay"] <= 30):
        return None, "so_ngay_chay 1..31, bat_dau_sau_ngay 0..30"
    return doc, None


def _creative_ids(conn, sku: str) -> list[int]:
    """Nháp creative ĐÃ duyệt đúng SKU (mới nhất trước, tối đa 3)."""
    return [r[0] for r in conn.execute(
        "select id from content_drafts where sku = %s and status ="
        " 'approved' and content_type = any(%s) order by id desc limit %s",
        (sku, list(CREATIVE_TYPES), MAX_CREATIVES))]


def _agent_plan_live(conn, sku: str, ch: str, month: date) -> int | None:
    for (pid,) in conn.execute(
            "select id from ad_test_plans where sku_key = %s and channel = %s"
            " and cap_ref_month = %s and created_by = %s order by id",
            (sku, ch, month, PROPOSE_AGENT)).fetchall():
        if plan_status(conn, pid) not in ("tu_choi", "het_han"):
            return pid
    return None


def propose(conn, *, month: date, cfg: dict, dcfg: dict, pcfg: dict,
            today: date, dry_run: bool = False) -> list[dict]:
    """→ [{sku_key, channel, code, reason, plan_id, new_items}] — 1 dòng mỗi
    ô FP&A `DE_XUAT` (ô khác không phải ứng viên). Tính năng TẮT →
    RolloutBlocked trước mọi ghi."""
    from pipelines import rollout  # lười: rollout → director → ...
    if not dry_run:
        rollout.check_generate(conn, FEATURE, "đề xuất phiếu thử nghiệm ads")
    props = fp_ads.propose(fp_pnl.compute(conn, month)["cells"],
                           fp_ads.fetch_readiness(conn, cfg["channels"]), cfg)
    conn.commit()
    out = []
    for p in props:
        if p["code"] != "DE_XUAT":
            continue
        sku, ch = p["sku_key"], p["channel"]
        row = {"sku_key": sku, "channel": ch, "plan_id": None,
               "new_items": []}
        old = _agent_plan_live(conn, sku, ch, month)
        if old is not None:
            out.append({**row, "code": "DA_CO", "plan_id": old, "reason":
                        f"đã có đề xuất #{old} còn hiệu lực tháng trần"})
            continue
        ids = _creative_ids(conn, sku)
        if not ids:
            out.append({**row, "code": "THIEU_CREATIVE", "reason":
                        "chưa có nháp ads/image ĐÃ duyệt cho SKU"})
            continue
        budget = int(p["budget_vnd"] * Decimal(str(pcfg["ty_le_tran"])))
        if budget <= 0:
            out.append({**row, "code": "THIEU_TRAN", "reason":
                        "trần FP&A × tỷ lệ = 0đ"})
            continue
        start = today + timedelta(days=pcfg["bat_dau_sau_ngay"])
        plan = {"sku_key": sku, "channel": ch,
                "hypothesis": (
                    f"Đề xuất của agent ({PROPOSE_AGENT}): thử quảng cáo nhỏ "
                    f"{sku} trên {ch}, đo chi phí mỗi đơn. Nguồn: trần FP&A "
                    f"tháng {month:%Y-%m} {vnd(p['budget_vnd'])}, ngân sách "
                    f"{pcfg['ty_le_tran']:.0%} trần theo ads_proposal.json "
                    f"(chốt bởi {pcfg['chot_boi']}); creative đã duyệt "
                    f"{', '.join(f'#{i}' for i in ids)}."),
                "creative_draft_ids": ids, "budget_vnd": budget,
                "start_date": start.isoformat(),
                "end_date": (start + timedelta(days=pcfg["so_ngay_chay"]
                                               - 1)).isoformat(),
                "success_metric": pcfg["success_metric"],
                "stop_rules": pcfg["stop_rules"]}
        res = submit_plan(conn, plan, by=PROPOSE_AGENT, month=month, cfg=cfg,
                          dcfg=dcfg, today=today, dry_run=dry_run)
        out.append({**row, "code": res["code"] or "DE_XUAT",
                    "reason": res["reason"], "plan_id": res.get("plan_id"),
                    "new_items": res.get("new_items", [])})
    return out


def plan_status(conn, pid) -> str:
    """cho_duyet | da_duyet (CẢ 2 mục approved) | tu_choi | het_han |
    thieu_muc | lech_ban_duyet | cung_nguoi_duyet — theo mục mới nhất mỗi
    loại. 2 mục approved bởi CÙNG 1 người (lower+btrim) → `cung_nguoi_duyet`
    (kiểm soát kép GĐ MKT + GĐ tài chính, fail-closed). `da_duyet`
    còn đòi bản đã duyệt của CẢ 2 mục khớp sha256 phiếu dựng lại từ dòng
    `ad_test_plans` (`verify_publish`) — mục `adtest-<id>` do nguồn khác
    đẩy vào với nội dung khác không làm phiếu "đã duyệt" (fail-closed)."""
    st, who = {}, {}
    for otype, status, by in conn.execute(
            "select object_type, status, lower(btrim(coalesce(decided_by,"
            " ''))) from approval_queue where object_id"
            " = %s and (block, object_type) in (('marketing', 'ad_campaign'),"
            " ('finance', 'budget_change')) order by id",
            (f"adtest-{pid}",)):
        st[otype], who[otype] = status, by
    if len(st) < len(ITEMS):
        return "thieu_muc"
    vals = set(st.values())
    if "rejected" in vals:
        return "tu_choi"
    if "expired" in vals:
        return "het_han"
    if vals != {"approved"}:
        return "cho_duyet"
    prow = get_plan(conn, pid)
    author = " ".join(str((prow or {}).get("created_by") or "").split()
                      ).casefold()
    if len(set(who.values())) < len(ITEMS) or "" in who.values()             or any(" ".join(w.split()).casefold() == author
                   for w in who.values()):
        return "cung_nguoi_duyet"         # P8.2: người lập không tự duyệt
    try:
        payload = render_plan(prow) if prow else None
    except (KeyError, TypeError, ValueError, ArithmeticError):
        payload = None          # dòng jsonb sai khuôn (ghi tay) → fail-closed
    for _block, otype in ITEMS:
        ok = payload is not None and conn.execute(
            "select verify_publish(%s, %s, %s)",
            (otype, f"adtest-{pid}", payload)).fetchone()[0]
        if ok is not True:
            return "lech_ban_duyet"
    return "da_duyet"


def submit_results(conn, pid, path, *, by: str, dcfg: dict,
                   dry_run: bool = False) -> dict:
    """→ {code, reason|errors, ev, qid, skipped}."""
    prow = get_plan(conn, pid)
    if prow is None:
        conn.commit()
        return {"code": NOT_APPROVED, "reason": f"không có phiếu #{pid}"}
    st = plan_status(conn, pid)
    conn.commit()
    if st != "da_duyet":
        return {"code": NOT_APPROVED, "reason": (f"phiếu #{pid} trạng thái "
                                                 f"{st} — cần duyệt đủ 2 mục")}
    rows, errs, sha = read_results(path, prow)
    if errs:
        return {"code": "ADS_RESULTS_FILE", "errors": errs}
    ev = evaluate(prow, rows)
    oid = f"adres-{pid}-{sha[:12]}"
    # Đợt hoàn thiện 22/10 (marketing-03.2, PL01 "theo dõi chi phí mỗi đơn;
    # đề xuất giữ hay tắt"): kết quả là ĐẦU RA RIÊNG `ad_result` (trước đây
    # chung object_type ad_campaign với đề xuất phiếu). Mục cũ cùng oid ở
    # ad_campaign vẫn tính là đã có → không nộp lại.
    if _item_exists(conn, RESULT_OT, oid) or _item_exists(conn, "ad_campaign",
                                                          oid):
        conn.commit()
        return {"code": None, "ev": ev, "qid": None, "skipped": True}
    if dry_run:
        conn.commit()
        return {"code": None, "ev": ev, "qid": None, "skipped": False}
    payload = render_result(prow, ev, sha, len(rows))
    title = f"Kết quả ads phiếu #{pid} — đề xuất {ev['de_xuat']}"
    try:
        qid = director.submit(conn, "marketing", RESULT_OT, oid, title,
                              payload, created_by=by, cfg=dcfg["marketing"])
    except psycopg.errors.UniqueViolation:
        with suppress(Exception):
            conn.rollback()
        return {"code": None, "ev": ev, "qid": None, "skipped": True}
    return {"code": None, "ev": ev, "qid": qid, "skipped": False}


# ---------- CLI ----------

def _read_plan(path: Path):
    try:
        raw = path.read_bytes()
    except OSError as e:
        return None, f"không đọc được file phiếu ({type(e).__name__})"
    if len(raw) > MAX_PLAN_BYTES:
        return None, f"file phiếu quá lớn (> {MAX_PLAN_BYTES} byte)"
    try:
        return json.loads(raw.decode("utf-8-sig")), None
    except (UnicodeDecodeError, ValueError):
        return None, "file phiếu không phải JSON UTF-8"


def _prev_month(today: date) -> date:
    return (date(today.year - 1, 12, 1) if today.month == 1
            else date(today.year, today.month - 1, 1))


def _reject(code: str, why: str) -> int:
    print(f"[từ chối] {code}: {why} — không ghi gì.")
    return 1


def _print_status(conn, pid) -> int:
    prow = get_plan(conn, pid)
    if prow is None:
        print(f"[err] không có phiếu #{pid}")
        return 1
    st = plan_status(conn, pid)
    print(f"[status] phiếu #{pid} `{prow['sku_key']}` × {prow['channel']} "
          f"{vnd(prow['budget_vnd'])} — {st}")
    for qid, block, otype, status in conn.execute(
            "select id, block, object_type, status from approval_queue where"
            " object_id = %s order by id", (f"adtest-{pid}",)):
        print(f"  mục #{qid} {block}/{otype}: {status}")
    return 0


def main(argv=None, today: date | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.mkt_ads",
        description="MKT-05 phiếu thử nghiệm ads — NHÁP vào hàng duyệt (agent"
                    " không chi tiền, không gọi API quảng cáo)")
    ap.add_argument("--plan", type=Path, metavar="FILE.json")
    ap.add_argument("--status", type=int, metavar="ID")
    ap.add_argument("--results", type=Path, metavar="FILE.csv")
    ap.add_argument("--plan-id", type=int, metavar="N")
    ap.add_argument("--by", help="người lập (free-text — SSO external-dep)")
    ap.add_argument("--month", help="tháng P&L tham chiếu trần YYYY-MM "
                                    "(mặc định tháng trước, giờ VN)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--propose", action="store_true",
                    help="agent TỰ đề xuất phiếu từ trần FP&A + creative đã "
                    "duyệt + data/ads_proposal.json (marketing-03)")
    a = ap.parse_args(argv)
    n_ops = (sum(x is not None for x in (a.plan, a.status, a.results))
             + a.propose)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --plan | --status | --results |"
                 " --propose")
    if a.propose and a.by:
        ap.error("--propose do agent lập (agent:mkt05) — không nhận --by")
    by = (a.by or "").strip()
    if (a.plan or a.results) and not by:
        ap.error("--plan/--results cần --by <tên người lập>")
    if a.results and a.plan_id is None:
        ap.error("--results cần --plan-id N")
    today = today or vn_today()
    month = _prev_month(today)
    if a.month is not None:
        month = parse_month(a.month)
        if month is None:
            ap.error("--month phải dạng YYYY-MM")
    plan = None
    if a.plan:
        plan, why = _read_plan(a.plan)
        if why is None:
            _, why = normalize_plan(plan, today)
        if why:
            return _reject("ADS_INPUT", why)
    cfg, dcfg, why = load_cfgs()
    if why:
        print(f"[err] {why} — không connect.")
        return 1
    pcfg = None
    if a.propose:
        pcfg, why = load_proposal_cfg()
        if why:
            print(f"[BLOCKED] {why} — agent không đề xuất, không tự điền số.")
            return 2
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    from pipelines import rollout  # lười: rollout → director → ...
    if not a.dry_run and a.status is None:
        # r12 RB: phiếu/đề xuất = 03.1, kết quả = 03.2 — tắt → exit 2 rõ lý
        # do, trước mọi ghi (trước đây RolloutBlocked rơi vào nhánh ValueError
        # → "[error] RolloutBlocked" exit 1).
        why = rollout.blocked(conn, "phiếu thử nghiệm ads",
                              fid="marketing-03.2" if a.results else FEATURE)
        if why:
            with suppress(Exception):
                conn.close()
            return rollout.say_blocked(why)
    try:
        if a.status is not None:
            return _print_status(conn, a.status)
        if a.propose:
            rows = propose(conn, month=month, cfg=cfg, dcfg=dcfg, pcfg=pcfg,
                           today=today, dry_run=a.dry_run)
            for r in rows:
                q = ", ".join(f"#{x}" for x in r["new_items"]) or "-"
                print(f"[{r['code']}] {r['sku_key']} × {r['channel']}: "
                      f"{r['reason']} (phiếu {r['plan_id'] or '-'}, mục {q})")
            if not rows:
                print("[THIẾU] FP&A không có ô SKU × kênh DE_XUAT tháng "
                      f"{month:%Y-%m} — không đề xuất")
            return 0
        if a.plan:
            res = submit_plan(conn, plan, by=by, month=month, cfg=cfg,
                              dcfg=dcfg, today=today, dry_run=a.dry_run)
            if res["code"]:
                return _reject(res["code"], res["reason"])
            if a.dry_run:
                print(f"[dry-run] phiếu đạt mọi luật chặn (trần "
                      f"{vnd(res['cap'])}) — không ghi.")
                return 0
            print(f"[plan] phiếu #{res['plan_id']} "
                  f"({'mới' if res['created'] else 'đã có — chỉ bổ sung mục thiếu'})"
                  f" · mục hàng duyệt mới: "
                  f"{', '.join(f'#{q}' for q in res['new_items']) or '(không)'}"
                  " — CHỜ GĐ Marketing + GĐ tài chính duyệt; agent không chi "
                  "tiền.")
            return 0
        res = submit_results(conn, a.plan_id, a.results, by=by, dcfg=dcfg,
                             dry_run=a.dry_run)
        if res["code"] == "ADS_RESULTS_FILE":
            print(f"[err] file kết quả lỗi ({len(res['errors'])}) — chặn cả "
                  "file, không ghi:")
            for e in res["errors"][:50]:
                print(f"  - {e}")
            return 1
        if res["code"]:
            return _reject(res["code"], res["reason"])
        ev = res["ev"]
        flags = f" [{', '.join(ev['co'])}]" if ev["co"] else ""
        if res["skipped"]:
            print(f"[skip] file kết quả này đã nạp cho phiếu #{a.plan_id} — "
                  "không tạo thêm.")
        elif res["qid"] is None:
            print(f"[dry-run] phiếu #{a.plan_id}: đề xuất {ev['de_xuat']}"
                  f"{flags} — không ghi.")
        else:
            print(f"[results] mục hàng duyệt #{res['qid']} — đề xuất "
                  f"{ev['de_xuat']}{flags} (CHỜ NGƯỜI QUYẾT).")
        return 0
    except rollout.RolloutBlocked as e:
        with suppress(Exception):
            conn.rollback()
        return rollout.say_blocked(str(e))
    except (psycopg.Error, ValueError, OSError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else type(e).__name__
        print(f"[error] {type(e).__name__}: {_mask_pii(msg)}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
