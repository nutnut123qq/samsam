"""v9.1 FP-OpsCost (WP12) — chi phí vận hành: chi phí AI theo agent (bảng
`llm_usage`, USD → VND theo tỷ giá cấu hình) + chi phí cloud/SaaS/ads/khác
nhập tay từ CSV → so trần tháng, cảnh báo mức 80% và 100%; khoản chi > ngưỡng
X chỉ "được chi" khi TGĐ ký trong hàng duyệt. Tất định Python/SQL, KHÔNG
LLM/mạng.

Ranh giới: agent CHỈ cảnh báo + đẩy mục chờ TGĐ ký (`opex_over_x`, risk high
— `auto_policies` không áp). KHÔNG chi tiền, KHÔNG gọi API nhà cung cấp,
KHÔNG tắt key, KHÔNG đổi hạn mức cổng LLM. Ownership: ghi DUY NHẤT
`opex_entries` (insert-only, idempotent theo sha256 file); chỉ ĐỌC
`llm_usage` + `approval_queue`.

File nạp (`--load F`, .csv/.xlsx, header CỐ ĐỊNH, thứ tự tùy ý):
  month, category, service, amount_vnd, doc_ref
  - month `YYYY-MM`; category cloud|saas|ads|khac; service mã
    `^[a-z0-9][a-z0-9_.-]{1,39}$` (tên dịch vụ, KHÔNG tên người); amount_vnd
    số nguyên VND > 0 (nhóm nghìn được); doc_ref (số hóa đơn, ≤64 ký tự,
    tùy chọn — không in ra báo cáo).
  - Kiểm TOÀN file TRƯỚC connect (trần byte/dòng/cột của `ingest.market_csv`),
    lỗi chỉ nêu số dòng + tên field (KHÔNG giá trị ô) → exit 1, 0 dòng.

Hàm THUẦN (tháng là tham số — chỉ CLI đọc đồng hồ):
  - `ai_vnd(usd, rate)` = ROUND_HALF_UP(Decimal(str(usd)) × rate).
  - `budget_alerts(actuals, budgets, warn_pct, stop_pct)`: mỗi scope có trần
    ĐÚNG ≤1 cảnh báo, mức cao nhất đạt (so số nguyên `spent×100 ≥
    budget×pct`, không float).
  - `spend_status(entry, items, users, x)`: ≤ X → `trong_nguong` (quy trình
    chi thường, ngoài agent); > X → `duoc_chi` CHỈ khi có mục `opex_over_x`
    CỦA agent này (khối `finance`, `created_by` `agent:fp_opscost`) cho đúng
    khóa tự nhiên `opex_key` (sha file + số dòng — KHÔNG id tự tăng: dựng lại
    DB làm id lệch) VÀ `content_sha256` = sha256 payload dựng lại từ khoản
    hiện tại, approved, lane `per_item`, người quyết có vai trò `tgd` trong
    `pipelines.auth.load_users()`; mọi trường hợp khác → `cho_tgd_ky`
    (fail-closed). Ngưỡng X KHÔNG nằm trong payload (đổi X không làm mất chữ
    ký của khoản); đổi nội dung khoản → phải ký lại.

Cấu hình `data/fpa_config.json` mục `opscost` (GIẢ ĐỊNH — chờ GĐ tài chính
chốt): `usd_vnd`, `budget_vnd {scope: VND}` với scope `ai:<agent_id>` | `ai`
| `cloud` | `saas` | `ads` | `khac` | `tong`, `warn_pct` (80), `stop_pct`
(100), `threshold_x_vnd`.

Chạy:
  python -m agents.fp_opscost --load F
  python -m agents.fp_opscost --report --month YYYY-MM
  python -m agents.fp_opscost --submit-over-x --month YYYY-MM
  python -m agents.fp_opscost --status --month YYYY-MM
Exit: 0 ok/skip · 1 file/cấu hình/DB lỗi · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import re
import sys
from contextlib import suppress
from decimal import Decimal
from pathlib import Path

import psycopg

from agents.fp_pnl import is_int, parse_month, read_config, vnd
from ingest.lead_store import connect
from ingest.market_csv import MAX_PRINT_ERRS, _clean, _TableError, _to_int
from ingest.settlement_csv import map_header, read_table, round_half_up
from pipelines import director
from pipelines.auth import load_users
from pipelines.period import period_bounds
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

HEADER = ("month", "category", "service", "amount_vnd", "doc_ref")
REQUIRED = ("month", "category", "service", "amount_vnd")
CATEGORIES = ("cloud", "saas", "ads", "khac")
SCOPES = ("ai", *CATEGORIES, "tong")
STATUSES = ("trong_nguong", "duoc_chi", "cho_tgd_ky")
MONEY_CAP = 10**13
MAX_REF = 64
CREATED_BY = "agent:fp_opscost"
_SERVICE_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{1,39}")
_AI_SCOPE_RE = re.compile(r"ai:[a-z0-9][a-z0-9_.:-]{0,63}")
NOTE_X = ("CHỜ TGĐ KÝ — agent không chi, không tắt key, không đổi limit. "
          "Chỉ \"được chi\" khi người có vai trò `tgd` duyệt đúng mục này "
          "(per_item).")


# ---------- cấu hình ----------

def load_cfg(path: Path | None = None) -> tuple[dict | None, str | None]:
    sec, why = read_config("opscost", path)
    if sec is None:
        return None, why
    rate = sec.get("usd_vnd")
    if not is_int(rate, 1, 10**6):
        return None, "opscost.usd_vnd: phải int 1..1000000"
    b = sec.get("budget_vnd")
    if not isinstance(b, dict):
        return None, "opscost.budget_vnd: phải là object {scope: VND}"
    for k, v in b.items():
        if not (k in SCOPES or (isinstance(k, str)
                                and _AI_SCOPE_RE.fullmatch(k))):
            return None, f"opscost.budget_vnd: scope lạ '{_clean(k, 40)}'"
        if not is_int(v, 1, MONEY_CAP):
            return None, f"opscost.budget_vnd.{k}: phải int > 0"
    warn, stop = sec.get("warn_pct", 80), sec.get("stop_pct", 100)
    if not is_int(warn, 1, 1000) or not is_int(stop, 1, 1000) or warn >= stop:
        return None, "opscost.warn_pct/stop_pct: int 1..1000, warn < stop"
    x = sec.get("threshold_x_vnd")
    if not is_int(x, 1, MONEY_CAP):
        return None, "opscost.threshold_x_vnd: phải int > 0"
    return {"usd_vnd": rate, "budget_vnd": dict(b), "warn_pct": warn,
            "stop_pct": stop, "threshold_x_vnd": x}, None


# ---------- đọc file (thuần) ----------

def read_opex(path: Path) -> tuple[list[dict], list[str], str | None]:
    """→ (entries, lỗi, sha256 file). Lỗi ≠ [] → entries = []."""
    table, sha, err = read_table(path)
    if err:
        return [], [err], sha
    rows: list[dict] = []
    try:
        first = next(table, None)
        if first is None:
            return [], ["file rỗng"], sha
        col_of, errs = map_header(
            first[1], {f: f for f in REQUIRED},
            {f: f for f in HEADER if f not in REQUIRED}, [],
            "chi phí vận hành")
        if errs:
            return [], errs, sha
        width = len(first[1])
        n_body = 0
        for row_no, cells in table:
            n_body += 1
            if any(c is not None for c in cells[width:]):
                errs.append(f"dòng {row_no}: thừa ô ngoài header")
                continue
            rec = {f: (cells[j] if j < len(cells) else None)
                   for f, j in col_of.items()}
            e = _row(rec, row_no)
            if isinstance(e, list):
                errs += e
            else:
                rows.append(e)
        if not n_body:
            return [], ["file chỉ có header, không có dòng dữ liệu"], sha
    except _TableError as e:
        return [], [str(e)], sha
    return ([] if errs else rows), errs, sha


def _row(rec: dict, row_no: int) -> dict | list[str]:
    errs = []

    def bad(f, why):
        errs.append(f"dòng {row_no}: field '{f}' {why}")

    for f in REQUIRED:
        if rec.get(f) is None:
            bad(f, "trống")
    if errs:
        return errs
    month = parse_month(rec["month"])
    if month is None:
        bad("month", "phải dạng YYYY-MM")
    if rec["category"] not in CATEGORIES:
        bad("category", f"phải thuộc {CATEGORIES}")
    if not _SERVICE_RE.fullmatch(rec["service"]):
        bad("service", "phải mã ^[a-z0-9][a-z0-9_.-]{1,39}$ (không dấu cách)")
    amt = _to_int(rec["amount_vnd"], MONEY_CAP)
    if not amt:
        bad("amount_vnd", "phải là số nguyên VND > 0")
    ref = rec.get("doc_ref")
    if ref is not None and (len(ref) > MAX_REF or not ref.isprintable()):
        bad("doc_ref", f"dài quá {MAX_REF} hoặc có ký tự điều khiển")
    if errs:
        return errs
    return {"row_no": row_no, "month": month, "category": rec["category"],
            "service": rec["service"], "amount_vnd": amt, "doc_ref": ref}


# ---------- tính (thuần) ----------

def ai_vnd(spend_usd, usd_vnd: int) -> int:
    return round_half_up(Decimal(str(spend_usd)) * usd_vnd)


def actuals(ai_usd: dict, opex: list[dict], usd_vnd: int) -> dict:
    """ai_usd = {agent_id: USD}, opex = dòng `opex_entries` của tháng →
    {scope: VND} (`ai:<agent>`, `ai`, category, `tong`)."""
    out = {f"ai:{a}": ai_vnd(u, usd_vnd) for a, u in sorted(ai_usd.items())}
    out["ai"] = sum(out.values())
    for c in CATEGORIES:
        out[c] = sum(e["amount_vnd"] for e in opex if e["category"] == c)
    out["tong"] = out["ai"] + sum(out[c] for c in CATEGORIES)
    return out


def budget_alerts(actuals: dict, budgets: dict, warn_pct: int,
                  stop_pct: int) -> list[dict]:
    out = []
    for scope in sorted(budgets):
        budget = budgets[scope]
        spent = actuals.get(scope, 0)
        if spent * 100 >= budget * stop_pct:
            lvl, label = stop_pct, "VƯỢT TRẦN"
        elif spent * 100 >= budget * warn_pct:
            lvl, label = warn_pct, "CẢNH BÁO"
        else:
            continue
        out.append({"scope": scope, "level": lvl, "label": label,
                    "spent": spent, "budget": budget})
    return out


def opex_key(entry: dict) -> str:
    """object_id mục `opex_over_x` = khóa tự nhiên (sha file + số dòng),
    KHÔNG id tự tăng: dựng lại `opex_entries` (nạp lại / thứ tự khác / id bị
    đốt) làm id lệch → chữ ký TGĐ trỏ sang khoản khác (fail-open)."""
    return f"opex-{entry['file_sha256'][:16]}-{entry['row_no']}"


# Lý do `cho_tgd_ky` (in ở --status); `chua_co`/`khac_vai_tro` → --submit-over-x
# đẩy 1 mục pending mới; `bi_chan` = mục pending KHÔNG hợp lệ chiếm unique
# pending của khóa này — người duyệt phải reject mục đó trước.
WHY = {"tgd_ky": "TGĐ đã ký",
       "cho_ky": "đang chờ TGĐ ký",
       "khac_vai_tro": ("đã duyệt bởi vai trò khác — cần TGĐ (chạy "
                        "--submit-over-x để đẩy lại)"),
       "bi_chan": ("mục chờ duyệt KHÔNG hợp lệ (khác khối/agent/nội dung) "
                   "đang chặn — người duyệt reject mục đó"),
       "chua_co": "chưa có mục chờ TGĐ ký (hoặc đã bị từ chối/hết hạn)"}


def _mine(it: dict, entry: dict) -> bool:
    """Mục do CHÍNH agent này đẩy cho đúng khoản + đúng nội dung (payload
    dựng lại từ khoản hiện tại) — mục agent/khối khác hoặc payload khác
    không bao giờ tính (A08)."""
    sha = hashlib.sha256(render_over_x(entry).encode("utf-8")).hexdigest()
    return (it.get("object_type") == "opex_over_x"
            and it.get("object_id") == opex_key(entry)
            and it.get("block") == "finance"
            and it.get("created_by") == CREATED_BY
            and it.get("content_sha256") == sha)


def verdict(entry: dict, items: list[dict], users: dict, x: int
            ) -> tuple[str, str | None]:
    """→ (trạng thái, mã lý do `WHY` | None khi trong ngưỡng)."""
    if entry["amount_vnd"] <= x:
        return "trong_nguong", None
    oid = opex_key(entry)
    same = [it for it in items if it.get("object_type") == "opex_over_x"
            and it.get("object_id") == oid]
    mine = [it for it in same if _mine(it, entry)]
    for it in mine:
        who = (it.get("decided_by") or "").strip().lower()
        if (it.get("status") == "approved" and it.get("lane") == "per_item"
                and who and (users.get(who) or {}).get("role") == "tgd"):
            return "duoc_chi", "tgd_ky"
    if any(it.get("status") == "pending" for it in mine):
        return "cho_tgd_ky", "cho_ky"
    if any(it.get("status") == "pending" for it in same):
        return "cho_tgd_ky", "bi_chan"
    if any(it.get("status") == "approved" for it in mine):
        return "cho_tgd_ky", "khac_vai_tro"
    return "cho_tgd_ky", "chua_co"


def spend_status(entry: dict, items: list[dict], users: dict, x: int) -> str:
    return verdict(entry, items, users, x)[0]


def _pct(spent: int, budget: int) -> str:
    p = (Decimal(spent) * 100 / Decimal(budget)).quantize(Decimal("0.1"))
    return f"{p}%"


def render_report(month, acts: dict, cfg: dict, alerts: list[dict],
                  over: list[tuple[dict, str]]) -> str:
    b = cfg["budget_vnd"]
    scopes = sorted(set(b) | {k for k, v in acts.items() if v})
    L = [f"# Chi phí vận hành tháng {month:%m/%Y} — so trần (GIẢ ĐỊNH)", "",
         (f"Tỷ giá quy đổi chi phí AI {vnd(cfg['usd_vnd'])}/USD; cảnh báo "
          f"{cfg['warn_pct']}% / {cfg['stop_pct']}% trần; ngưỡng X "
          f"{vnd(cfg['threshold_x_vnd'])} — `data/fpa_config.json` chờ GĐ "
          "tài chính chốt."), "",
         "| Phạm vi | Thực chi | Trần | % trần |", "|---|---|---|---|"]
    for s in scopes:
        spent = acts.get(s, 0)
        L.append(f"| `{s}` | {vnd(spent)} | "
                 + (f"{vnd(b[s])} | {_pct(spent, b[s])} |" if s in b
                    else "chưa có trần | — |"))
    L += ["", "Cảnh báo:"]
    L += [f"- [{a['label']} {a['level']}%] `{a['scope']}`: {vnd(a['spent'])}"
          f" / trần {vnd(a['budget'])}" for a in alerts] or ["- (không có)"]
    wait = [e for e, st in over if st == "cho_tgd_ky"]
    L += ["", (f"Khoản > ngưỡng X: {len(over)} — đang chờ TGĐ ký: {len(wait)}"
               f", được chi: {sum(st == 'duoc_chi' for _, st in over)}.")]
    L += ["", ("Agent chỉ cảnh báo — không chi, không tắt key, không đổi hạn "
               "mức; người quyết theo quy trình tài chính."), ""]
    return "\n".join(L)


def render_over_x(entry: dict) -> str:
    """Payload mục `opex_over_x` — CHỈ nội dung khoản (hash = chữ ký TGĐ gắn
    với khoản): không id tự tăng, không ngưỡng X (X ở tiêu đề mục)."""
    return "\n".join([
        "# Khoản chi vượt ngưỡng X — chờ TGĐ ký", "",
        f"- Tháng: {entry['month']:%m/%Y}",
        f"- Nhóm: `{entry['category']}` · dịch vụ `{entry['service']}`",
        f"- Số tiền: {vnd(entry['amount_vnd'])}",
        ("- Chữ ký gắn với đúng dòng file chi phí đã nạp + nội dung trên; "
         "nội dung đổi → phải ký lại."), "", f"**{NOTE_X}**", ""])


# ---------- DB ----------

_E_COLS = ("id", "file_sha256", "row_no", "month", "category", "service",
           "amount_vnd")


def load(conn, entries: list[dict], file_name: str, sha: str) -> int:
    with conn.cursor() as cur:
        cur.executemany(
            "insert into opex_entries (file_sha256, file_name, row_no, month,"
            " category, service, amount_vnd, doc_ref) values (%s, %s, %s, %s,"
            " %s, %s, %s, %s)",
            [(sha, file_name, e["row_no"], e["month"], e["category"],
              e["service"], e["amount_vnd"], e["doc_ref"]) for e in entries])
    return len(entries)


def fetch_ai_usd(conn, month) -> dict:
    start, end = period_bounds("month", month)
    return {a: u for a, u in conn.execute(
        "select agent_id, coalesce(sum(cost_usd), 0) from llm_usage where"
        " ts >= %s and ts < %s group by agent_id", (start, end))}


def fetch_opex(conn, month) -> list[dict]:
    return [dict(zip(_E_COLS, r)) for r in conn.execute(
        "select " + ", ".join(_E_COLS) + " from opex_entries where month = %s"
        " order by id", (month,))]


def fetch_items(conn) -> list[dict]:
    """MỌI mục `opex_over_x` (kể cả khối/agent khác — để `verdict` nhận ra mục
    lạ đang chiếm unique pending); chỉ mục `_mine` mới được tính."""
    cols = ("id", "object_type", "object_id", "block", "created_by",
            "content_sha256", "status", "lane", "decided_by")
    return [dict(zip(cols, r)) for r in conn.execute(
        "select " + ", ".join(cols) + " from approval_queue where"
        " object_type = 'opex_over_x' order by id")]


def summary(conn, month, cfg: dict, users: dict) -> dict:
    """→ {actuals, alerts, over: [(entry, status)], why: {entry id: mã lý
    do}} — dùng chung report/status/fin_director."""
    opex = fetch_opex(conn, month)
    acts = actuals(fetch_ai_usd(conn, month), opex, cfg["usd_vnd"])
    items = fetch_items(conn)
    x = cfg["threshold_x_vnd"]
    vs = [(e, *verdict(e, items, users, x)) for e in opex
          if e["amount_vnd"] > x]
    return {"actuals": acts, "over": [(e, st) for e, st, _ in vs],
            "why": {e["id"]: why for e, _, why in vs},
            "alerts": budget_alerts(acts, cfg["budget_vnd"], cfg["warn_pct"],
                                    cfg["stop_pct"])}


def submit_over_x(conn, month, cfg: dict, users: dict,
                  dcfg: dict | None = None
                  ) -> tuple[list[tuple[int, int]], list[int]]:
    """Mỗi khoản > X chưa có chữ ký TGĐ hợp lệ và chưa có mục pending hợp lệ
    (`verdict` lý do `chua_co` / `khac_vai_tro`) → 1 mục `opex_over_x` mới.
    Mục approved bởi vai trò khác / auto_policy KHÔNG chặn đẩy lại (nếu
    chặn, khoản kẹt `cho_tgd_ky` vĩnh viễn — TGĐ không quyết được mục đã
    approved). → ([(entry id, queue id)], [entry id bị mục lạ chặn])."""
    x = cfg["threshold_x_vnd"]
    items = fetch_items(conn)
    todo, blocked = [], []
    for e in fetch_opex(conn, month):
        if e["amount_vnd"] <= x:
            continue
        why = verdict(e, items, users, x)[1]
        if why in ("chua_co", "khac_vai_tro"):
            todo.append(e)
        elif why == "bi_chan":
            blocked.append(e["id"])
    conn.commit()
    out = []
    for e in todo:
        title = (f"Khoản chi vượt ngưỡng X {vnd(x)}: {e['category']}/"
                 f"{e['service']} {vnd(e['amount_vnd'])}")
        qid = director.submit(conn, "finance", "opex_over_x", opex_key(e),
                              title, render_over_x(e),
                              created_by=CREATED_BY, cfg=dcfg)
        out.append((e["id"], qid))
    return out, blocked


# ---------- CLI ----------

def _print_errs(errs: list[str]) -> None:
    for e in errs[:MAX_PRINT_ERRS]:
        print(f"[err] {e}", flush=True)
    if len(errs) > MAX_PRINT_ERRS:
        print(f"[err] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác")
    print(f"[err] {len(errs)} lỗi — không connect, không nạp gì.", flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.fp_opscost",
        description="FP-OpsCost: chi phí AI + cloud/SaaS so trần tháng; khoản"
                    " > ngưỡng X chờ TGĐ ký (agent chỉ cảnh báo)")
    ap.add_argument("--load", type=Path, metavar="FILE")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--submit-over-x", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--month", help="YYYY-MM")
    args = ap.parse_args(argv)
    n_ops = sum([args.load is not None, args.report, args.submit_over_x,
                 args.status])
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--load | --report | --submit-over-x"
                 " | --status)")
    if n_ops == 0:
        ap.error("cần --load | --report | --submit-over-x | --status")
    month = None
    if args.load is not None:
        if args.month:
            ap.error("--month không dùng với --load (tháng nằm trong file)")
    else:
        month = parse_month(args.month)
        if month is None:
            ap.error("cần --month YYYY-MM (tháng 01..12)")
    cfg, why = load_cfg()
    if cfg is None:
        print(f"[err] {why} — không connect.", flush=True)
        return 1
    dcfg = None
    if args.submit_over_x:
        try:
            dcfg = director.load_config("finance")
        except director.DirectorConfigError as e:
            print(f"[err] cấu hình khối finance: {e} — không connect.")
            return 1
    entries = sha = None
    if args.load is not None:
        entries, errs, sha = read_opex(args.load)
        if errs:
            _print_errs(errs)
            return 1

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.load is not None:
            if conn.execute("select 1 from opex_entries where file_sha256 ="
                            " %s limit 1", (sha,)).fetchone():
                print("[skip] file chi phí đã nạp — không ghi gì.")
                return 0
            n = load(conn, entries, args.load.name, sha)
            conn.commit()
            print(f"[load] {n} dòng chi phí từ {_clean(args.load.name, 80)}")
            return 0
        if args.submit_over_x:
            done, blocked = submit_over_x(conn, month, cfg, load_users(),
                                          dcfg)
            for eid, qid in done:
                print(f"[submit] khoản #{eid} → mục hàng duyệt #{qid} "
                      "(opex_over_x, CHỜ TGĐ KÝ)")
            for eid in blocked:
                print(f"[chặn] khoản #{eid}: {WHY['bi_chan']}")
            print(f"[submit] {len(done)} mục mới — agent không chi, không "
                  "tắt key, không đổi limit.")
            return 0
        s = summary(conn, month, cfg, load_users())
        conn.commit()
        if args.report:
            print(render_report(month, s["actuals"], cfg, s["alerts"],
                                s["over"]))
            return 0
        print(f"[status] khoản > ngưỡng X {vnd(cfg['threshold_x_vnd'])} "
              f"tháng {month:%m/%Y}:")
        for e, st in s["over"]:
            print(f"  khoản #{e['id']} {e['category']}/{e['service']} "
                  f"{vnd(e['amount_vnd'])}: {st} — {WHY[s['why'][e['id']]]}")
        if not s["over"]:
            print("  (không có)")
        return 0
    except psycopg.errors.UniqueViolation as e:
        with suppress(Exception):
            conn.rollback()
        cname = e.diag.constraint_name or ""
        if args.load is not None and "file_sha256" in cname:
            print("[skip] file vừa được nạp song song — không ghi gì.")
            return 0
        if args.submit_over_x and cname == "approval_queue_pending_uq":
            print("[skip] mục chờ TGĐ ký vừa được tạo song song — chạy lại "
                  "để đẩy các khoản còn lại.")
            return 0
        print(f"[error] {type(e).__name__}: {_db_msg(e)}", file=sys.stderr)
        return 1
    except (psycopg.Error, ValueError, OSError) as e:
        with suppress(Exception):
            conn.rollback()
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else type(e).__name__
        print(f"[error] {type(e).__name__}: {msg}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
