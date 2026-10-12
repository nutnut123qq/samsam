"""v5.0 — Agent GĐ Kinh doanh TMĐT (WP07; final_plans khối `sales`, luồng
F03c "Handoff A/B, SLA, escalation"). Agent giám đốc ĐẦU TIÊN cấu hình thật
trên khung v4.0 (`pipelines.director` + `approval_queue` + `red_alert`) —
MẪU cho 10 khối còn lại.

Contract:
  - Cấu hình `data/directors/sales.json` = luật v4.0 (`director.load_config`)
    + `load_sales_config` kiểm thêm: mọi loại việc có `handoff` A|B + `label`;
    lớp A = 2, B = 4 giờ LÀM VIỆC (khóa cứng theo WP07); role ⊂
    `pipelines.auth.ROLES`; `market_alert_s1` risk PHẢI high (S1 không bao giờ
    vào lane tự duyệt); ca qua `period.parse_shift`; `sla_hours` tuyệt đối mỗi
    loại ≥ thời lượng đồng hồ tệ nhất của SLA giờ làm việc lớp đó (1 tuần
    không lễ, mốc 15 phút) — chặn cấu hình làm mục expired cuối tuần thường.
    Lễ/Tết/cron chết KHÔNG được guard này che: `sweep` tự leo thang cả mục
    hết hạn tuyệt đối chưa leo thang (xem dưới).
  - `collect` (THUẦN đọc) 4 nguồn thật: `market_alerts` open → S1/S2,
    `object_id` = `ma:<id>:<opened_at UTC>` theo ĐỢT (market_csv reopen
    CÙNG dòng, đổi `opened_at` → đợt tái phát là mục mới, SLA mới);
    `golden_discrepancies` pending (kind giá) → `price_review` `gd:<id>`
    (golden_store xóa phiếu pending khi hết lệch, tái phát → INSERT id mới
    nên id đã là theo đợt); convlog `answered is False` trong cửa sổ →
    `cskh_handoff` GOM 1 mục/`user_hash`/ngày VN (kênh inbound khách kiểm
    soát — 1000 sticker ≠ 1000 mục) + trần `sources.max_cskh_per_run` mục
    mới/lần (phần vượt chờ lần sau, đếm trong bản tin); idempotent theo
    `(object_type, object_id)` đã có trong `approval_queue` Ở BẤT KỲ status
    (cùng đợt đã duyệt/từ chối/expired không bị đẩy lại).
    Lead `new` quá N giờ làm việc → CHỈ nhắc trong bản tin (`stale_leads`).
    `payload`/`title` dựng từ TEMPLATE (mã/loại/kênh/giờ VN) — KHÔNG câu hỏi
    khách, tiêu đề listing, sku_key, detail (guardrail ok, người duyệt được).
  - `sweep`: `expire_overdue` (quá hạn TUYỆT ĐỐI → expired, không bao giờ
    approved) → ứng viên leo thang = mục chưa leo thang: pending quá SLA giờ
    làm việc, HOẶC đã quá `due_at` (pending/expired trong
    `EXPIRED_LOOKBACK` — expired bởi chính sweep, bởi `director.run`/CLI
    hàng duyệt, hay khi cron chết/lễ Tết đều không thoát leo thang) → 1 dòng
    `sla_escalations` (`on conflict (queue_id) do nothing`); loại A kèm
    `red_alert.raise_alert` cùng transaction (lỗi giữa chừng → rollback, lần
    sau thử lại): S1 1 cảnh báo/mục, loại A khác (đầu vào khách) GOM 1 cảnh
    báo/loại/lần quét kèm `queue_ids`; loại B → TGĐ trong bản tin. Agent
    KHÔNG gọi hàm duyệt/tự duyệt/ép trình QA.
  - Bản tin (`gather` chỉ SELECT + `render_bulletin` THUẦN, tất định): chỉ
    số đếm + `#id` + nhãn loại từ cấu hình — KHÔNG in câu hỏi khách,
    user_hash, title tự do, tên nhân viên, payload. KHÔNG LLM, KHÔNG tự gửi.
    v5.3: mục 6 "Catalog & giá (A4/A5)" — số mục pending `a4:`/`a5:` theo
    loại việc + lần chạy gần nhất `agents.kd_listing`/`agents.kd_price`
    (`job_runs`); mục 5 đếm cả `promo_change`.
  - Mọi hàm thời gian nhận `now` aware (naive → ValueError); chỉ CLI đọc
    đồng hồ.

Chạy:
  python -m agents.sales_director --run --dry-run --bulletin   # chỉ đọc
  python -m agents.sales_director --run                        # đẩy + quét SLA
  python -m agents.sales_director --bulletin [--period week]   # file bản tin
Exit: 0 ok · 1 cấu hình lỗi · 2 DB down / lỗi DB / tham số sai.
"""

import argparse
import hashlib
import re
import sys
import unicodedata
from collections import Counter
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import (
    CONV_FILES,
    DATA_DIR,
    _parse_ts,
    channel_of,
    connect,
    dedup_key,
    iter_convlog,
)
from pipelines import approval_queue as aq
from pipelines import director, period, red_alert
from pipelines.auth import ROLES
from pipelines.director import DirectorConfigError
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

BLOCK = "sales"
AGENT = "agent:sales_director"
JOB = "agents.sales_director"
SWEEP_BY = "system:sla:sales"
CLASS_HOURS = {"A": 2, "B": 4}          # WP07: handoff A 2h, B 4h làm việc
SOURCE_TYPES = ("cskh_handoff", "market_alert_s1", "market_alert_s2",
                "price_review")
PERIODS = ("day", "week")
# Nhãn mã cảnh báo sàn trong payload — KHÔNG đưa mã thô (vd chứa từ khóa
# rượu → guardrail chặn approve vĩnh viễn).
ALERT_LABELS = {"alcohol_listed": "listing thuộc nhóm hàng cấm bán online",
                "price_mismatch": "lệch giá niêm yết so với bảng giá",
                "tpbvsk_ads_no_xnqc": "quảng cáo TPBVSK chưa có XNQC",
                "item_unmapped": "sản phẩm trên sàn chưa map SKU"}
PRICE_LABELS = {"price_mismatch": "lệch giá golden so với kênh bán",
                "missing_price": "thiếu giá trong bảng giá golden"}
STATE_ORDER = ("overdue", "due_soon", "on_time")
# Loại A cảnh báo đỏ TỪNG mục (pháp lý, nguồn do hệ thống sinh); loại A khác
# (cskh_* — đầu vào khách kiểm soát) gom 1 cảnh báo/loại/lần quét.
RED_PER_ITEM = frozenset({"market_alert_s1"})
# v5.3 mục 6 bản tin: agent luật A4/A5 đẩy mục `object_id` tiền tố a4:/a5:.
CATALOG_AGENTS = (("a4", "agents.kd_listing", "A4 Catalog/listing đa sàn"),
                  ("a5", "agents.kd_price", "A5 Giá & khuyến mãi"))
EXPIRED_LOOKBACK = timedelta(days=7)    # mục quá due_at chưa leo thang
MAX_ALERT_IDS = 100                     # queue_ids trong 1 cảnh báo gộp
_CODE_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{0,31}")
_PENDING_SQL = ("select id, object_type, created_at, due_at from"
                " approval_queue where block = %s and status = 'pending'"
                " order by id")
_CAND_SQL = (
    "select a.id, a.object_type, a.created_at, a.due_at, a.status"
    " from approval_queue a where a.block = %s and (a.status = 'pending'"
    " or (a.status = 'expired' and a.due_at >= %s)) and not exists"
    " (select 1 from sla_escalations e where e.queue_id = a.id)"
    " order by a.id")
_ESC_SQL = (
    "insert into sla_escalations (queue_id, block, handoff_class,"
    " assignee_role, escalate_to_role, business_due_at, red_alert,"
    " created_by) values (%s, %s, %s, %s, %s, %s, %s, %s)"
    " on conflict (queue_id) do nothing returning id")


# ---------------------------------------------------------------- cấu hình

def _int_in(v, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _nonblank(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def worst_clock_hours(shift, hours: int) -> float:
    """Thời lượng ĐỒNG HỒ tệ nhất (giờ) để đủ `hours` giờ làm việc, quét mốc
    mỗi 15 phút trên 1 tuần không lễ (vd A 2h: T6 18:00 → T2 10:00 = 64h).
    KHÔNG tính lễ — mục hết hạn tuyệt đối trước hạn giờ làm việc (Tết) vẫn
    được `sweep` leo thang (lý do `expired`), guard này chỉ chặn cấu hình
    expire cả cuối tuần thường."""
    s = dict(period.parse_shift(shift), holidays=frozenset())
    t0 = datetime(2026, 1, 5, tzinfo=VN_TZ)          # thứ Hai
    worst = timedelta(0)
    for i in range(7 * 96):
        t = t0 + timedelta(minutes=15 * i)
        worst = max(worst, period.business_deadline(t, hours, s) - t)
    return worst.total_seconds() / 3600


def validate_sales(cfg: dict) -> dict:
    """Luật riêng khối KD (sau luật v4.0) → cfg | DirectorConfigError."""
    def err(msg):
        return DirectorConfigError(f"{BLOCK}: {msg}")

    classes = cfg.get("handoff_classes")
    if not isinstance(classes, dict) or set(classes) != set(CLASS_HOURS):
        raise err("'handoff_classes' phải có đúng 2 lớp A, B")
    for k, c in classes.items():
        if not isinstance(c, dict) or c.get("business_hours") != \
                CLASS_HOURS[k] or isinstance(c.get("business_hours"), bool):
            raise err(f"lớp {k}: business_hours phải = {CLASS_HOURS[k]} "
                      "(khóa theo WP07 — đổi phải sửa code + test)")
        for r in ("assignee_role", "escalate_to_role"):
            if c.get(r) not in ROLES:
                raise err(f"lớp {k}: {r} {c.get(r)!r} không thuộc {ROLES}")
        if not isinstance(c.get("red_alert"), bool):
            raise err(f"lớp {k}: red_alert phải true|false")
        if not _int_in(c.get("due_soon_minutes"), 1, 600):
            raise err(f"lớp {k}: due_soon_minutes phải 1..600")
    if classes["A"]["red_alert"] is not True:
        raise err("lớp A quá hạn PHẢI bật cảnh báo đỏ (WP07)")
    try:
        period.parse_shift(cfg.get("business_hours"))
    except ValueError as e:
        raise err(f"business_hours: {e}") from None
    types = cfg["object_types"]
    missing = [t for t in SOURCE_TYPES if t not in types]
    if missing:
        raise err(f"thiếu loại việc nguồn {missing}")
    worst = {k: worst_clock_hours(cfg["business_hours"], h)
             for k, h in CLASS_HOURS.items()}
    for t, spec in types.items():
        h = spec.get("handoff")
        if h not in CLASS_HOURS:
            raise err(f"{t}: handoff phải A|B")
        if not _nonblank(spec.get("label")):
            raise err(f"{t}: thiếu label")
        if spec["sla_hours"] < worst[h]:
            raise err(f"{t}: sla_hours {spec['sla_hours']} < {worst[h]:g} giờ"
                      f" đồng hồ tệ nhất của SLA lớp {h} — mục sẽ expired"
                      " trước khi kịp leo thang")
    if types["market_alert_s1"]["risk"] != "high":
        raise err("market_alert_s1 risk PHẢI high (S1 không vào lane tự "
                  "duyệt)")
    src = cfg.get("sources")
    if (not isinstance(src, dict)
            or not _int_in(src.get("convlog_lookback_hours"), 1, 720)
            or not _int_in(src.get("lead_stale_business_hours"), 1, 720)):
        raise err("sources: convlog_lookback_hours/lead_stale_business_hours"
                  " phải 1..720")
    if not _int_in(src.get("max_cskh_per_run"), 1, 1000):
        raise err("sources.max_cskh_per_run phải 1..1000 (trần mục CSKH mới"
                  " mỗi lần chạy — chống spam kênh inbound)")
    kinds = src.get("price_discrepancy_kinds")
    if not isinstance(kinds, list) or not kinds or \
            not all(_nonblank(k) for k in kinds):
        raise err("sources.price_discrepancy_kinds phải là list chuỗi")
    regions = cfg.get("regions")
    if not isinstance(regions, dict) or not regions or not all(
            _nonblank(n) and isinstance(kw, list) and kw
            and all(_nonblank(x) for x in kw) for n, kw in regions.items()):
        raise err("regions phải là {tên vùng: [từ khóa tỉnh không rỗng]}")
    return cfg


def load_sales_config(base_dir: Path | None = None) -> dict:
    return validate_sales(director.load_config(BLOCK, base_dir))


def route(cfg: dict, object_type: str) -> dict:
    """Loại việc → lớp handoff, rủi ro, người nhận, leo thang."""
    spec = cfg["object_types"].get(object_type)
    if spec is None:
        raise ValueError(f"khối {BLOCK} không có loại việc '{object_type}'")
    cls = cfg["handoff_classes"][spec["handoff"]]
    return {"object_type": object_type, "handoff": spec["handoff"],
            "risk": spec["risk"], "label": spec["label"],
            "assignee_role": cls["assignee_role"],
            "escalate_to_role": cls["escalate_to_role"],
            "red_alert": cls["red_alert"],
            # auto_policy chỉ áp risk low (DB chặn cứng) — medium/high luôn
            # cần người duyệt.
            "auto_eligible": spec["risk"] == "low"}


def alert_type(severity: str) -> str:
    if severity == "S1":
        return "market_alert_s1"
    if severity == "S2":
        return "market_alert_s2"
    raise ValueError(f"severity '{severity}' lạ — S1|S2")


def _check_now(now) -> datetime:
    if not isinstance(now, datetime) or now.tzinfo is None \
            or now.utcoffset() is None:
        raise ValueError("now phải là datetime có múi giờ (aware)")
    return now


def sla_state(item: dict, cfg: dict, now: datetime) -> dict:
    """THUẦN: hạn giờ làm việc + trạng thái on_time|due_soon|overdue."""
    _check_now(now)
    r = route(cfg, item["object_type"])
    cls = cfg["handoff_classes"][r["handoff"]]
    due = period.business_deadline(item["created_at"], cls["business_hours"],
                                   cfg["business_hours"])
    if now >= due:
        state = "overdue"
    elif period.business_minutes(now, due, cfg["business_hours"]) <= \
            cls["due_soon_minutes"]:
        state = "due_soon"
    else:
        state = "on_time"
    return {"handoff_class": r["handoff"], "business_due_at": due,
            "state": state, "assignee_role": r["assignee_role"],
            "escalate_to_role": r["escalate_to_role"],
            "red_alert": r["red_alert"]}


# ---------------------------------------------------------------- nguồn việc

def _fmt_vn(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y %H:%M") if ts else "—"


def _code(v) -> str:
    """Mã kênh/loại file từ DB → chỉ [a-z0-9_.-] (không lọt free text)."""
    s = (v or "").strip().lower() if isinstance(v, str) else ""
    return s if _CODE_RE.fullmatch(s) else "khác"


def _ref(object_id: str) -> str:
    return hashlib.sha1(object_id.encode("utf-8")).hexdigest()[:10]


def cskh_object_id(rec: dict, ts: datetime) -> str:
    """Khóa NHÓM khách/ngày VN: `cskh:<sha1(user_hash|ngày)[:16]>`; entry
    thiếu `user_hash` → theo từng entry (`dedup_key`). Mục trong hàng duyệt
    đi theo ĐỢT trong nhóm (`_collect`): đợt đầu dùng nguyên khóa, đợt sau
    (câu hỏi mới SAU khi mục trước đã quyết) thêm `:<ts đầu đợt UTC>`."""
    uh = rec.get("user_hash")
    if not _nonblank(uh):
        return dedup_key(rec)
    raw = f"{uh.strip()}|{period.vn_date(ts).isoformat()}"
    return "cskh:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _unanswered(now: datetime, cfg: dict, data_dir: Path) -> list[dict]:
    """Entry convlog `answered is False` có ts trong [now - lookback, now]
    (dedup entry theo `dedup_key`) → nhóm theo `cskh_object_id`:
    [{object_id, channel, ts (sớm nhất), n, recs: [(ts, channel)] tăng dần}]
    cũ nhất trước. KHÔNG mang câu hỏi/user_hash."""
    since = now - timedelta(hours=cfg["sources"]["convlog_lookback_hours"])
    groups: dict = {}
    seen = set()
    stats = {"corrupt": 0, "doc": 0, "io_error": 0}
    for name in CONV_FILES:
        path = Path(data_dir) / name
        if not path.exists():
            continue
        for rec in iter_convlog(path, stats):
            if rec.get("answered") is not False:
                continue
            ts = _parse_ts(rec.get("ts"))
            if ts is None or not since <= ts <= now:
                continue
            key = dedup_key(rec)
            if key in seen:
                continue
            seen.add(key)
            oid = cskh_object_id(rec, ts)
            g = groups.get(oid)
            if g is None:
                groups[oid] = {"object_id": oid, "channel": channel_of(rec),
                               "ts": ts, "n": 1,
                               "recs": [(ts, channel_of(rec))]}
            else:
                g["n"] += 1
                g["recs"].append((ts, channel_of(rec)))
                if ts < g["ts"]:
                    g["ts"], g["channel"] = ts, channel_of(rec)
    for g in groups.values():
        g["recs"].sort(key=lambda r: r[0])
    return sorted(groups.values(), key=lambda g: (g["ts"], g["object_id"]))


def _cskh_state(conn) -> dict:
    """Khóa nhóm `cskh:<16hex>` → (còn mục pending?, decided_at muộn nhất)
    trên MỌI đợt của nhóm (expired cũng có decided_at — trigger đặt)."""
    state: dict = {}
    for oid, st, dec in conn.execute(
            "select object_id, status, decided_at from approval_queue"
            " where object_type = 'cskh_handoff' and object_id like %s",
            ("cskh:%",)).fetchall():
        base = ":".join(oid.split(":")[:2])
        pend, last = state.get(base, (False, None))
        if st == "pending":
            pend = True
        elif dec is not None and (last is None or dec > last):
            last = dec
        state[base] = (pend, last)
    return state


def collect(conn, now: datetime, cfg: dict,
            data_dir: Path = DATA_DIR) -> list[dict]:
    """THUẦN đọc → mục SẼ đẩy vào hàng duyệt (chưa có ở bất kỳ status)."""
    return _collect(conn, now, cfg, data_dir)[0]


def _ma_object_id(aid: int, opened: datetime) -> str:
    """Theo ĐỢT: market_csv reopen cùng dòng và đặt `opened_at` mới. Chuẩn
    hóa UTC — session DB khác múi giờ vẫn ra cùng chuỗi."""
    return f"ma:{aid}:{opened.astimezone(timezone.utc):%Y%m%dT%H%M%S%fZ}"


def _collect(conn, now: datetime, cfg: dict,
             data_dir: Path = DATA_DIR) -> tuple[list[dict], int]:
    """→ (mục sẽ đẩy, số nhóm CSKH mới vượt trần `max_cskh_per_run`)."""
    _check_now(now)
    seen = {(t, o) for t, o in conn.execute(
        "select object_type, object_id from approval_queue"
        " where object_type = any(%s)", (list(SOURCE_TYPES),)).fetchall()}
    types = cfg["object_types"]
    items: list[dict] = []

    def add(ot, oid, title, payload):
        if (ot, oid) not in seen:
            seen.add((ot, oid))
            items.append({"object_type": ot, "object_id": oid,
                          "title": f"{types[ot]['label']} — {title}",
                          "payload": payload})

    for aid, kind, sev, ch, ek, opened in conn.execute(
            "select id, kind, severity, channel, export_kind, opened_at"
            " from market_alerts where status = 'open' order by id"
    ).fetchall():
        ot = alert_type(sev)
        add(ot, _ma_object_id(aid, opened), f"cảnh báo #{aid}",
            f"Cảnh báo sàn {sev} #{aid}: "
            f"{ALERT_LABELS.get(kind, 'cảnh báo sàn khác')} — kênh "
            f"{_code(ch)}, file xuất {_code(ek)}, mở lúc {_fmt_vn(opened)}"
            " (giờ VN). Việc cần làm: Quản lý MXH/sàn kiểm tra listing trên"
            " Seller Center, xử lý theo SOP mục 4d; cảnh báo đóng khi file"
            " xuất kế tiếp không còn lỗi. Agent không tự sửa sàn.")
    for gid, kind, created in conn.execute(
            "select id, kind, created_at from golden_discrepancies"
            " where status = 'pending' and kind = any(%s) order by id",
            (list(cfg["sources"]["price_discrepancy_kinds"]),)).fetchall():
        add("price_review", f"gd:{gid}", f"phiếu #{gid}",
            f"Phiếu lệch golden #{gid}: "
            f"{PRICE_LABELS.get(kind, 'lệch dữ liệu giá')} — tạo lúc "
            f"{_fmt_vn(created)} (giờ VN). Việc cần làm: GĐ bán hàng đối"
            " chiếu giá theo từng nguồn trong phiếu và quyết giá đúng;"
            " agent không chọn giá.")
    cap, n_cskh, deferred = cfg["sources"]["max_cskh_per_run"], 0, 0
    cskh = _cskh_state(conn)
    for u in _unanswered(now, cfg, data_dir):
        oid, recs = u["object_id"], u["recs"]
        if oid.startswith("cskh:"):
            # Còn mục pending → tin mới (sticker dồn) đã nằm trong mục đó.
            # Đã quyết hết → chỉ câu SAU lần quyết muộn nhất mở ĐỢT mới.
            pend, last = cskh.get(oid, (False, None))
            if pend:
                continue
            recs = [r for r in recs if last is None or r[0] > last]
            if not recs:
                continue
            if last is not None:
                oid = f"{oid}:{recs[0][0].astimezone(timezone.utc):%Y%m%dT%H%M%SZ}"
        if ("cskh_handoff", oid) in seen:
            continue
        if n_cskh >= cap:
            deferred += 1
            continue
        n_cskh += 1
        ref = _ref(oid)
        add("cskh_handoff", oid, f"mã {ref}",
            f"Khách hỏi qua kênh {recs[0][1]} từ {_fmt_vn(recs[0][0])} (giờ"
            f" VN), {len(recs)} câu chatbot chưa trả lời (không có dữ liệu hoặc"
            f" chuyển người). Mã tham chiếu {ref}. Việc cần làm: nhân viên"
            " CSKH mở tab 'Chưa trả lời' đọc câu hỏi gốc (đã che SĐT/email)"
            " và liên hệ lại khách qua kênh gốc.")
    return items, deferred


def enqueue_new(conn, items: list[dict], cfg: dict) -> int:
    """Đẩy qua `director.submit` (SLA/risk từ cấu hình) → số mục mới."""
    n = 0
    for it in items:
        try:
            director.submit(conn, BLOCK, it["object_type"], it["object_id"],
                            it["title"], it["payload"], AGENT, cfg=cfg)
        except psycopg.errors.UniqueViolation:
            continue          # mục pending cùng object vừa được đẩy song song
        n += 1
    return n


def stale_leads(conn, now: datetime, cfg: dict) -> list[int]:
    """id lead `new` quá `lead_stale_business_hours` giờ làm việc → nhắc."""
    _check_now(now)
    hours = cfg["sources"]["lead_stale_business_hours"]
    rows = conn.execute("select id, ts from leads where status = 'new'"
                        " order by id").fetchall()
    # So với HẠN (quét tiến từ ts, có trần) thay vì đếm phút [ts, now) —
    # lead `ts` rất cũ (nhập tay) không kéo vòng quét theo tuổi lead.
    return [i for i, ts in rows
            if now >= period.business_deadline(ts, hours,
                                               cfg["business_hours"])]


# ---------------------------------------------------------------- SLA sweep

def _pending(conn) -> list[dict]:
    return [dict(zip(("id", "object_type", "created_at", "due_at"), r))
            for r in conn.execute(_PENDING_SQL, (BLOCK,)).fetchall()]


def _escalated(conn, ids: list[int]) -> dict:
    if not ids:
        return {}
    return dict(conn.execute(
        "select queue_id, created_at from sla_escalations"
        " where queue_id = any(%s)", (ids,)).fetchall())


def _overdue(conn, now: datetime, cfg: dict) -> list[tuple[dict, dict]]:
    """Mục khối KD CHƯA leo thang cần leo thang → [(mục, sla_state +
    `reason`)]: `expired` = đã quá `due_at` (pending sắp bị expire, hoặc đã
    expired trong `EXPIRED_LOOKBACK` — bởi bất kỳ ai), `sla` = pending quá
    SLA giờ làm việc."""
    since = now - EXPIRED_LOOKBACK
    rows = conn.execute(_CAND_SQL, (BLOCK, since)).fetchall()
    out = []
    for r in rows:
        p = dict(zip(("id", "object_type", "created_at", "due_at", "status"),
                     r))
        # Pending quá due_at ngoài cửa sổ: sweep expire trước rồi SQL loại —
        # plan (không expire) phải loại y hệt.
        if p["object_type"] not in cfg["object_types"] or p["due_at"] < since:
            continue
        st = sla_state(p, cfg, now)
        if p["status"] == "expired" or p["due_at"] <= now:
            st["reason"] = "expired"
        elif st["state"] == "overdue":
            st["reason"] = "sla"
        else:
            continue
        out.append((p, st))
    return out


def _batches(over: list) -> list[list]:
    """Lô leo thang (1 lô = 1 commit, ≤ 1 cảnh báo đỏ): lớp B và S1 → mỗi mục
    1 lô; loại A khác (đầu vào khách) → 1 lô/loại — spam N tin ≠ N cảnh báo."""
    out, agg = [], {}
    for p, st in over:
        if st["red_alert"] and p["object_type"] not in RED_PER_ITEM:
            agg.setdefault(p["object_type"], []).append((p, st))
        else:
            out.append([(p, st)])
    return out + list(agg.values())


def _alert_of(new: list, cfg: dict) -> tuple[str, dict]:
    """(title, detail) cảnh báo đỏ cho các mục vừa leo thang của 1 lô."""
    (p, st), cls = new[0], new[0][1]["handoff_class"]
    if len(new) == 1:
        what = ("Hết hạn tuyệt đối chưa ai xử lý" if st["reason"] == "expired"
                else "Quá SLA")
        return (f"{what} loại {cls} — mục #{p['id']}",
                {"queue_id": p["id"], "object_type": p["object_type"],
                 "reason": st["reason"],
                 "business_due_at": st["business_due_at"].isoformat()})
    ids = [q["id"] for q, _ in new]
    label = cfg["object_types"][p["object_type"]]["label"]
    return (f"Quá SLA loại {cls} — {len(ids)} mục {label}",
            {"object_type": p["object_type"], "n": len(ids),
             "queue_ids": ids[:MAX_ALERT_IDS],
             "reasons": dict(sorted(Counter(s["reason"]
                                            for _, s in new).items()))})


def sweep(conn, now: datetime, cfg: dict) -> dict:
    """expire tuyệt đối → leo thang mục chưa leo thang (quá SLA giờ làm việc
    hoặc đã quá `due_at`) theo lô (idempotent)."""
    _check_now(now)
    res = {"expired": aq.expire_overdue(conn, SWEEP_BY), "escalated": 0,
           "red_alerts": 0, "errors": 0}
    for batch in _batches(_overdue(conn, now, cfg)):
        try:
            new = []
            for p, st in batch:
                if conn.execute(_ESC_SQL, (
                        p["id"], BLOCK, st["handoff_class"],
                        st["assignee_role"], st["escalate_to_role"],
                        st["business_due_at"], st["red_alert"],
                        AGENT)).fetchone() is not None:
                    new.append((p, st))
            if new and batch[0][1]["red_alert"]:
                # raise_alert commit CẢ các dòng leo thang lẫn cảnh báo đỏ.
                red_alert.raise_alert(conn, JOB, *_alert_of(new, cfg))
                res["red_alerts"] += 1
            else:
                conn.commit()
            res["escalated"] += len(new)
        except Exception as e:  # noqa: BLE001 — 1 lô lỗi không chặn lô khác
            with suppress(Exception):
                conn.rollback()
            res["errors"] += len(batch)
            print(f"[warn] leo thang {len(batch)} mục (từ #{batch[0][0]['id']})"
                  f" lỗi ({type(e).__name__}) — rollback, lần quét sau thử lại",
                  file=sys.stderr)
    return res


def plan(conn, now: datetime, cfg: dict, data_dir: Path = DATA_DIR) -> dict:
    """Dry-run: CHỈ ĐỌC — số mục sẽ đẩy/expire/leo thang (cùng ứng viên +
    cùng cách gom lô với `sweep`)."""
    items, deferred = _collect(conn, now, cfg, data_dir)
    n_exp = conn.execute("select count(*) from approval_queue where status ="
                         " 'pending' and due_at <= %s", (now,)).fetchone()[0]
    over = _overdue(conn, now, cfg)
    return {"dry_run": True,
            "enqueue": dict(sorted(Counter(i["object_type"]
                                           for i in items).items())),
            "cskh_deferred": deferred,
            "expire": n_exp, "escalate": len(over),
            "red_alerts": sum(b[0][1]["red_alert"] for b in _batches(over)),
            "stale_leads": len(stale_leads(conn, now, cfg))}


def run(conn, now: datetime, cfg: dict, data_dir: Path = DATA_DIR,
        dry_run: bool = False) -> dict:
    """collect → enqueue → sweep (dry_run: chỉ `plan`)."""
    if dry_run:
        return plan(conn, now, cfg, data_dir)
    items, deferred = _collect(conn, now, cfg, data_dir)
    n = enqueue_new(conn, items, cfg)
    res = sweep(conn, now, cfg)
    res.update(dry_run=False, enqueued=n, cskh_deferred=deferred,
               stale_leads=len(stale_leads(conn, now, cfg)))
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    return res


# ---------------------------------------------------------------- bản tin

def period_of(kind: str, now: datetime) -> tuple[datetime, datetime]:
    """day = ngày VN hôm qua; week = tuần ISO trước (giờ VN)."""
    if kind not in PERIODS:
        raise ValueError(f"period '{kind}' lạ — {PERIODS}")
    d = period.vn_date(_check_now(now))
    ref: date = d - timedelta(days=1 if kind == "day" else 7)
    return period.period_bounds(kind, ref)


def region_counts(cfg: dict, questions: list) -> list[tuple[str, int]]:
    """Đếm lead theo vùng (từ khóa tỉnh, biên từ 2 phía — 'huế' không ăn
    'thuế'); không khớp → 'chưa rõ vùng'. Chỉ trả SỐ."""
    pats = []
    for name, kws in cfg["regions"].items():
        alt = "|".join(re.escape(unicodedata.normalize("NFC", k).casefold()
                                 .strip()) for k in kws)
        pats.append((name, re.compile(rf"(?<!\w)(?:{alt})(?!\w)")))
    cnt = Counter()
    for q in questions:
        s = unicodedata.normalize("NFC", q or "").casefold()
        cnt[next((n for n, p in pats if p.search(s)), "chưa rõ vùng")] += 1
    return [(n, cnt[n]) for n, _ in pats] + [("chưa rõ vùng",
                                               cnt["chưa rõ vùng"])]


def catalog_stats(conn) -> dict:
    """v5.3 — CHỈ SELECT: mục pending khối KD của A4/A5 theo (tiền tố, loại
    việc) → [id], và lần chạy gần nhất mỗi job từ `job_runs`. Role chạy
    bản tin không có quyền đọc `job_runs` (agent_writer — least privilege,
    roles.sql không cấp) → `jobs` None ("không đọc được"), không crash: đọc
    trong savepoint để lỗi quyền không hủy tx chia sẻ."""
    pend: dict = {}
    for pre, ot, qid in conn.execute(
            "select split_part(object_id, ':', 1), object_type, id from"
            " approval_queue where block = %s and status = 'pending' and"
            " object_id like any(%s) order by id",
            (BLOCK, [f"{p}:%" for p, _, _ in CATALOG_AGENTS])).fetchall():
        pend.setdefault((pre, ot), []).append(qid)
    try:
        with conn.transaction():
            jobs = {j: (ts, ok) for j, ts, ok in conn.execute(
                "select distinct on (job) job, coalesce(finished_at,"
                " started_at), ok from job_runs where job = any(%s)"
                " order by job, started_at desc, id desc",
                ([j for _, j, _ in CATALOG_AGENTS],)).fetchall()}
    except psycopg.errors.InsufficientPrivilege:
        jobs = None
    return {"pending": pend, "jobs": jobs}


def gather(conn, now: datetime, cfg: dict, period_kind: str = "day",
           data_dir: Path = DATA_DIR) -> dict:
    """CHỈ SELECT → số liệu bản tin (không câu hỏi/tên/payload)."""
    start, end = period_of(period_kind, now)
    pend = [p for p in _pending(conn)
            if p["object_type"] in cfg["object_types"]]
    esc = _escalated(conn, [p["id"] for p in pend])
    queue = []
    for p in pend:
        st = sla_state(p, cfg, now)
        queue.append({"id": p["id"], "object_type": p["object_type"],
                      "handoff_class": st["handoff_class"],
                      "business_due_at": st["business_due_at"],
                      "state": st["state"], "escalated_at": esc.get(p["id"])})
    decided = dict(conn.execute(
        "select status, count(*) from approval_queue where block = %s and"
        " status <> 'pending' and decided_at >= %s and decided_at < %s"
        " group by status", (BLOCK, start, end)).fetchall())
    alerts = [tuple(r) for r in conn.execute(
        "select severity, kind, channel, count(*) from market_alerts"
        " where status = 'open' group by 1, 2, 3 order by 1, 2, 3"
    ).fetchall()]
    qs = [q for (q,) in conn.execute(
        "select question from leads where ts >= %s and ts < %s",
        (start, end)).fetchall()]
    golden = conn.execute(
        "select count(*) from golden_discrepancies where status = 'pending'"
        " and kind = any(%s)",
        (list(cfg["sources"]["price_discrepancy_kinds"]),)).fetchone()[0]
    return {"period": period_kind, "start": start, "end": end,
            "queue": queue, "decided": decided, "alerts": alerts,
            "n_leads": len(qs), "regions": region_counts(cfg, qs),
            "stale_leads": stale_leads(conn, now, cfg),
            "golden_pending": golden,
            "unanswered": sum(u["n"] for u in _unanswered(now, cfg,
                                                           data_dir)),
            "cskh_deferred": _collect(conn, now, cfg, data_dir)[1],
            "catalog": catalog_stats(conn)}


def _state_text(q: dict) -> str:
    if q["state"] == "overdue":
        return (f"quá hạn (đã leo thang lúc {_fmt_vn(q['escalated_at'])})"
                if q.get("escalated_at") else
                "quá hạn (chưa leo thang — chờ lần quét kế)")
    return "sắp quá hạn" if q["state"] == "due_soon" else "đúng hạn"


def _shift_text(cfg: dict) -> str:
    s = cfg["business_hours"]
    names = ("T2", "T3", "T4", "T5", "T6", "T7", "CN")
    days = ", ".join(names[d] for d in sorted(s["workdays"]))
    return (f"{s['start']}–{s['end']}, {days}, "
            f"{len(s.get('holidays', []))} ngày lễ")


def render_bulletin(cfg: dict, data: dict, now: datetime,
                    period_kind: str = "day") -> str:
    """THUẦN, tất định: cùng input → cùng chuỗi."""
    start, end = data["start"], data["end"]
    last = end - timedelta(days=1)
    span = (f"ngày {start:%d/%m/%Y}" if period_kind == "day" else
          f"tuần {start:%d/%m}–{last:%d/%m/%Y}")
    types = cfg["object_types"]
    queue = sorted(data["queue"], key=lambda q: (
        STATE_ORDER.index(q["state"]), q["business_due_at"], q["id"]))
    n_state = Counter(q["state"] for q in queue)
    L = [f"# Bản tin GĐ Kinh doanh TMĐT — {span}", "",
         (f"Agent: {cfg['director_agent']} · khối `{BLOCK}` · ảnh chụp "
          f"hàng chờ lúc {_fmt_vn(now)} (giờ VN)"), "",
         "## 1. Hàng chờ theo SLA giờ làm việc", "",
         "| Trạng thái | Số |", "|---|---|",
         f"| Quá hạn | {n_state['overdue']} |",
         f"| Sắp quá hạn | {n_state['due_soon']} |",
         f"| Đúng hạn | {n_state['on_time']} |",
         f"| Tổng đang chờ | {len(queue)} |", ""]
    L += [f"- #{q['id']} · {types[q['object_type']]['label']} · lớp "
          f"{q['handoff_class']} · hạn {_fmt_vn(q['business_due_at'])} · "
          f"{_state_text(q)}" for q in queue] or ["- (không có)"]
    tgd = [q for q in queue if q["state"] == "overdue"
           and cfg["handoff_classes"][q["handoff_class"]]["escalate_to_role"]
           == "tgd"]
    L += ["", "### Leo thang TGĐ (lớp B quá hạn)", ""]
    L += [f"- #{q['id']} · {types[q['object_type']]['label']}"
          for q in tgd] or ["- (không có)"]
    dec = data["decided"]
    L += ["", f"## 2. Kết quả trong kỳ ({span})", "",
          "| Kết quả | Số |", "|---|---|",
          f"| Đã duyệt | {dec.get('approved', 0)} |",
          f"| Từ chối | {dec.get('rejected', 0)} |",
          (f"| Hết hạn tuyệt đối (expired — KHÔNG tự duyệt) | "
           f"{dec.get('expired', 0)} |"), "",
          "## 3. Cảnh báo sàn đang mở", "",
          "| Mức | Loại | Kênh | Số |", "|---|---|---|---|"]
    L += [f"| {sev} | {ALERT_LABELS.get(kind, 'khác')} | {_code(ch)} | {n} |"
          for sev, kind, ch, n in data["alerts"]] or ["| — | — | — | 0 |"]
    n_s = Counter()
    for sev, _, _, n in data["alerts"]:
        n_s[sev] += n
    L += ["", f"Tổng: S1 {n_s['S1']} · S2 {n_s['S2']}", "",
          f"## 4. Lead mới trong kỳ theo vùng (tổng {data['n_leads']})", "",
          "| Vùng | Số lead |", "|---|---|"]
    L += [f"| {name} | {n} |" for name, n in data["regions"]]
    stale = sorted(data["stale_leads"])
    hrs = cfg["sources"]["lead_stale_business_hours"]
    L += ["", f"Lead `new` quá {hrs} giờ làm việc chưa xử lý: {len(stale)}"
          + (" — " + ", ".join(f"#{i}" for i in stale[:50])
             + (" …" if len(stale) > 50 else "") if stale else ""),
          (f"Câu chatbot chưa trả lời "
           f"({cfg['sources']['convlog_lookback_hours']} giờ qua): "
           f"{data['unanswered']}"),
          (f"Nhóm khách chưa trả lời vượt trần "
           f"{cfg['sources']['max_cskh_per_run']} mục/lần chạy (chờ lần "
           f"sau): {data.get('cskh_deferred', 0)}"), "",
          "## 5. Giá chờ duyệt", ""]
    price = [q for q in queue if q["object_type"] in (
        "price_review", "price_change", "promo_change")]
    L += [f"- Mục giá đang chờ trong hàng duyệt: {len(price)}"
          + (" — " + ", ".join(f"#{q['id']}" for q in price) if price
             else ""),
          f"- Phiếu lệch golden (giá) đang pending: {data['golden_pending']}",
          ""]
    L += _catalog_lines(cfg, data.get("catalog"))
    L += ["", "## Người duyệt", "",
          f"- Vai trò duyệt: {', '.join(cfg['approver_roles'])}"]
    if not cfg["approvers"] or not cfg["digest_recipients"]:
        L.append("- Người duyệt/người nhận chưa cấu hình (external-dep)")
    L += [f"- Ca làm việc GIẢ ĐỊNH: {_shift_text(cfg)} — GĐ KD chốt",
          "", "---", ("*BẢN NHÁP — hệ thống không tự gửi. Người đọc rồi "
                      "chuyển tay cho GĐ Kinh doanh.*"), ""]
    return "\n".join(L)


def _catalog_lines(cfg: dict, cat) -> list[str]:
    """Mục 6 (v5.3) — chỉ số đếm + #id + nhãn cấu hình (không sku_key/tiêu
    đề/payload/giá đối thủ). Caller cũ không có `catalog` → chưa có số
    liệu."""
    L = ["## 6. Catalog & giá (A4/A5)", ""]
    if not isinstance(cat, dict):
        return L + ["- (chưa có số liệu)"]
    types = cfg["object_types"]
    L += ["| Agent | Lần chạy gần nhất (giờ VN) | Kết quả |", "|---|---|---|"]
    jobs = cat.get("jobs")
    for _, job, name in CATALOG_AGENTS:
        if jobs is None:
            L.append(f"| {name} | không đọc được (role thiếu quyền job_runs)"
                     " | — |")
            continue
        ts, ok = jobs.get(job, (None, None))
        L.append(f"| {name} | {_fmt_vn(ts) if ts else 'chưa chạy'} | "
                 + ("—" if ts is None else ("ok" if ok else "lỗi")) + " |")
    L += ["", "| Agent | Loại việc | Mục chờ duyệt |", "|---|---|---|"]
    pend = cat.get("pending") or {}
    rows = []
    for pre, _, name in CATALOG_AGENTS:
        for (p, ot), ids in sorted(pend.items()):
            if p != pre:
                continue
            ids = sorted(ids)
            label = types[ot]["label"] if ot in types else "loại khác"
            rows.append(f"| {name} | {label} | {len(ids)} — "
                        + ", ".join(f"#{i}" for i in ids[:50])
                        + (" …" if len(ids) > 50 else "") + " |")
    return L + (rows or ["| — | — | 0 |"])


def bulletin_name(kind: str, start: datetime) -> str:
    return f"sales-director-{kind}-{start:%Y-%m-%d}.md"


# ---------------------------------------------------------------- CLI

def _print_run(res: dict) -> None:
    if res["dry_run"]:
        enq = ", ".join(f"{k} {v}" for k, v in res["enqueue"].items()) \
            or "0"
        print(f"[dry-run] sẽ đẩy: {enq} · CSKH vượt trần chờ lần sau "
              f"{res['cskh_deferred']} · sẽ expire {res['expire']} · sẽ "
              f"leo thang {res['escalate']} (cảnh báo đỏ "
              f"{res['red_alerts']}) · lead quá hạn nhắc "
              f"{res['stale_leads']} — KHÔNG ghi DB")
        return
    print(f"[run] đẩy {res['enqueued']} mục mới (CSKH vượt trần chờ lần "
          f"sau {res['cskh_deferred']}) · expired "
          f"{res['expired']} · leo thang {res['escalated']} (cảnh báo đỏ "
          f"{res['red_alerts']}) · lead quá hạn nhắc {res['stale_leads']}"
          + (f" · LỖI leo thang {res['errors']}" if res["errors"] else ""))


def _main(args, now: datetime | None) -> int:
    try:
        cfg = load_sales_config()
    except DirectorConfigError as e:
        print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
        return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    rc = 0
    try:
        now = now or datetime.now(VN_TZ)
        if args.run:
            res = run(conn, now, cfg, data_dir=DATA_DIR,
                      dry_run=args.dry_run)
            _print_run(res)
            rc = 2 if res.get("errors") else 0
        if args.bulletin:
            data = gather(conn, now, cfg, args.period, data_dir=DATA_DIR)
            text = render_bulletin(cfg, data, now, args.period)
            if args.dry_run:
                print(text)
            else:
                path = write_report(text, args.out_dir,
                                    bulletin_name(args.period, data["start"]))
                n_over = sum(q["state"] == "overdue" for q in data["queue"])
                print(f"[bulletin] {path} · hàng chờ {len(data['queue'])}"
                      f" (quá hạn {n_over}) · lead mới {data['n_leads']}")
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.sales_director",
        description="Agent GĐ Kinh doanh TMĐT — hàng duyệt + SLA handoff "
                    "A/B + bản tin (BẢN NHÁP, không tự gửi)")
    ap.add_argument("--run", action="store_true",
                    help="đẩy việc từ nguồn thật + quét SLA/leo thang")
    ap.add_argument("--bulletin", action="store_true",
                    help="bản tin GĐ KD → data/reports/")
    ap.add_argument("--dry-run", action="store_true",
                    help="với --run: chỉ đọc, in kế hoạch; bản tin in stdout")
    ap.add_argument("--period", choices=PERIODS, default="day")
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    ap.add_argument("--now", help="giờ giả ISO có múi giờ — chỉ với "
                                  "--dry-run")
    args = ap.parse_args(argv)
    if not (args.run or args.bulletin):
        ap.error("cần --run và/hoặc --bulletin")
    if args.dry_run and not args.run:
        ap.error("--dry-run chỉ đi với --run")
    now = None
    if args.now is not None:
        if not args.dry_run:
            ap.error("--now chỉ dùng với --dry-run (không ghi DB theo đồng "
                     "hồ giả)")
        try:
            now = datetime.fromisoformat(args.now)
        except ValueError:
            ap.error("--now phải là ISO 8601, vd 2026-10-12T09:00+07:00")
        if now.tzinfo is None or now.utcoffset() is None:
            ap.error("--now phải có múi giờ (vd +07:00)")
    if args.dry_run:
        return _main(args, now)
    # Ghi lần chạy vào job_runs (bản tin sức khỏe F17.2, mục "Job 24h").
    with job_run(JOB) as r:
        rc = _main(args, None)
        r["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
