"""v10.1 KD-A7 (WP16) — chăm sóc lại + xin đánh giá: lập NHÁP tin CHỈ cho
khách có đồng ý ĐÚNG mục đích → hàng duyệt khối `sales`. KHÔNG gửi, KHÔNG
LLM, KHÔNG gọi mạng; NGƯỜI gửi tay qua Zalo OA/ZNS sau khi GĐ bán hàng
duyệt (external-dep).

Nguồn: `care_purchases` (lần mua KÊNH SỞ HỮU do NGƯỜI ghi — `--record`;
khách sàn bị chặn ở DB), `consents` qua `ingest.crm.can_contact` (mặc định
False), view `v_promotable` (kênh `zalo`), `approval_queue` (đếm trần).
Luật (`data/care_rules.json`, GIẢ ĐỊNH chờ GĐ KD/Pháp chế):
  rebuy   CHỈ lần mua MỚI NHẤT của mỗi (khách, SKU) — đã mua lại thì lần
          cũ không nhắc; ngày mua trong [hôm nay − (rebuy_after_days +
          rebuy_window_days), hôm nay − rebuy_after_days] (lần mua quá cũ
          KHÔNG nhắc — chống dồn tồn đọng); đồng ý `marketing`; SKU ∈
          v_promotable kênh `channel` (rượu/TPBVSK chưa XNQC/giá chưa duyệt
          → BỎ, không đổi sang SKU khác); trần max_marketing_per_month tin/
          khách/tháng VN theo THÁNG GỬI `gui_luc` (mục `care_rebuy`
          pending+approved — rejected/expired không tính); 1 lần/lần mua
          (mọi status). object_id `<contact_id>:<YYYY-MM gửi>:p<purchase_id>`.
  review  giao trong [hôm nay − (review_after_days + review_window_days),
          hôm nay − review_after_days]; đồng ý `cskh`; 1 lần/lần mua
          (object_id `review:<purchase_id>`, mọi status). Không phải quảng
          cáo → kiểm `check_publish(content_type='post')`.
Tin = template CỐ ĐỊNH điền tên golden; TPBVSK → CODE nối câu khuyến cáo.
Qua `guardrail.check_publish(channel, sku, is_ai=False)` (rebuy
`post_sale` — có nhãn 'Quảng cáo') → vi phạm → không đẩy. `gui_luc` = now
nếu trong khung giờ, ngoài khung → mốc mở khung kế tiếp (22:30 → 08:00 hôm
sau). Payload = tin + dòng `contact_id`/`muc_dich`/`gui_luc` — KHÔNG SĐT/
tên/email/địa chỉ, không ciphertext/HMAC (module không đọc vault).

`verify_send(conn, item_id, text, now)`: ok CHỈ khi mục approved + sha bản
duyệt khớp (`approval_queue.verify`) + đồng ý CÒN hiệu lực TẠI LÚC GỬI +
`now` trong khung giờ + (rebuy) `now` cùng THÁNG GỬI ghi trong object_id
(gửi trễ sang tháng khác → `thang_khac`, không vượt trần tháng mới) —
NGƯỜI gửi chạy trước khi bấm gửi.

Chạy:
  python -m agents.kd_care --record --by "Tên người" < lan_mua.json
      (stdin JSON {contact_id, channel, sku_key, purchased_on,
       delivered_on?, order_ref?})
  python -m agents.kd_care --plan            # chỉ đọc, in kế hoạch
  python -m agents.kd_care --run [--dry-run] # đẩy nháp vào hàng duyệt
  python -m agents.kd_care --verify-send ID FILE
Print chỉ `contact_id`/mã lần mua + đếm. Exit: 0 ok · 1 cấu hình/DB lỗi /
verify fail · 2 tham số sai / DB không kết nối.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, time, timedelta
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from ingest.crm import can_contact
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import director, guardrail, kb_filter, store
from pipelines.director import DirectorConfigError
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _PII_RE
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RULES_FILE = ROOT / "data" / "care_rules.json"
BLOCK = "sales"
AGENT = "agent:kd_a7"
JOB = "agents.kd_care"
OWN_CHANNELS = ("web", "zalo", "b2b", "showroom")
TYPES = {"rebuy": "care_rebuy", "review": "care_review"}
PURPOSE = {"rebuy": "marketing", "review": "cskh"}
CTYPE = {"rebuy": "post_sale", "review": "post"}
MAX_INPUT_BYTES = 4096
MAX_BY = 100
_REF_RE = re.compile(r"[A-Za-z0-9_.:-]{1,40}")
_HHMM_RE = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])")
_CONTACT_LINE_RE = re.compile(r"^contact_id: ([0-9]{1,18})$", re.MULTILINE)


class CareRulesError(ValueError):
    """data/care_rules.json không dùng được."""


def _int(v, lo, hi, name) -> int:
    if not (isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi):
        raise CareRulesError(f"{name} phải số nguyên {lo}..{hi}")
    return v


def _hhmm(v, name) -> time:
    m = _HHMM_RE.fullmatch(v) if isinstance(v, str) else None
    if not m:
        raise CareRulesError(f"{name} phải HH:MM")
    return time(int(m.group(1)), int(m.group(2)))


def load_rules(path: Path = RULES_FILE) -> dict:
    """Luật đã validate. Lỗi → CareRulesError (fail-closed, không chạy)."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise CareRulesError(f"care_rules.json không đọc được "
                             f"({type(e).__name__})") from e
    if not isinstance(doc, dict):
        raise CareRulesError("care_rules.json không phải object")
    try:
        w = doc["window"]
        start, end = _hhmm(w[0], "window[0]"), _hhmm(w[1], "window[1]")
        tm = doc["templates"]
        rules = {
            "channel": doc["channel"],
            "window": (start, end),
            "rebuy_after_days": _int(doc["rebuy_after_days"], 1, 3650,
                                     "rebuy_after_days"),
            "rebuy_window_days": _int(doc["rebuy_window_days"], 0, 3650,
                                      "rebuy_window_days"),
            "review_after_days": _int(doc["review_after_days"], 0, 365,
                                      "review_after_days"),
            "review_window_days": _int(doc["review_window_days"], 0, 365,
                                       "review_window_days"),
            "max_marketing_per_month": _int(
                doc["max_marketing_per_month"], 0, 31,
                "max_marketing_per_month"),
            "templates": {k: tm[k] for k in ("rebuy", "review")},
        }
    except (KeyError, TypeError, IndexError) as e:
        raise CareRulesError(f"care_rules.json thiếu/sai khóa "
                             f"({type(e).__name__}: {e})") from e
    if len(w) != 2 or not start < end:
        raise CareRulesError("window phải [bắt đầu, kết thúc) với bắt đầu <"
                             " kết thúc")
    if rules["channel"] not in OWN_CHANNELS:
        raise CareRulesError(f"channel phải thuộc {OWN_CHANNELS}")
    for k, t in rules["templates"].items():
        if not (isinstance(t, str) and t.count("{ten_sp}") == 1
                and len(t) <= 1000):
            raise CareRulesError(f"templates.{k} phải chuỗi có đúng 1 chỗ"
                                 " {ten_sp}")
    return rules


# ------------------------------------------------------------ thời gian

def _vn(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("now phải có múi giờ (aware)")
    return now.astimezone(VN_TZ)


def in_window(now: datetime, window) -> bool:
    t = _vn(now).time()
    return window[0] <= t < window[1]


def gui_luc(now: datetime, window) -> datetime:
    """now trong khung → now; trước khung → mốc mở khung cùng ngày; sau
    khung → mốc mở khung hôm sau (giờ VN)."""
    v = _vn(now)
    if in_window(v, window):
        return v
    day = v.date() if v.time() < window[0] else v.date() + timedelta(days=1)
    return datetime.combine(day, window[0], tzinfo=VN_TZ)


def month_key(now: datetime) -> str:
    return _vn(now).strftime("%Y-%m")


# ------------------------------------------------------------ chọn (THUẦN)

def _canon() -> str:
    try:
        doc = json.loads((guardrail.DATA_DIR / "guardrail_rules.json")
                         .read_bytes().decode("utf-8"))
        return str(doc["disclaimer"]["canonical"]).strip()
    except (OSError, ValueError, KeyError, TypeError):
        return ""


def render_text(kind: str, p: dict, rules: dict) -> str:
    """Tin = template cố định + tên golden; TPBVSK → nối câu khuyến cáo."""
    text = rules["templates"][kind].replace("{ten_sp}", p["name"])
    if p.get("category") == "tpbvsk":
        canon = _canon()
        if canon:
            text += f"\n{canon}."
    return text


def payload_of(text: str, contact_id: int, kind: str, send_at) -> str:
    return (f"{text}\n---\ncontact_id: {int(contact_id)}\n"
            f"muc_dich: {PURPOSE[kind]}\n"
            f"gui_luc: {send_at:%Y-%m-%d %H:%M} (giờ VN)\n"
            "Hệ thống KHÔNG tự gửi — người gửi tay phần tin phía trên dòng"
            " '---' qua Zalo OA sau khi duyệt và chạy --verify-send.")


def select_items(data: dict, now: datetime, rules: dict,
                 readiness: dict | None = None) -> dict:
    """THUẦN, tất định → {"items": [...], "skipped": [...]}.
    `data`: purchases [{id, contact_id, channel, sku_key, name, category,
    purchased_on, delivered_on}], consent {(contact_id, purpose): bool},
    promotable set(sku_key) (kênh rules.channel), month_counts {contact_id:
    n mục care_rebuy pending/approved tháng này}, seen_rebuy set(purchase
    id), seen_review set(purchase id)."""
    today = _vn(now).date()
    send_at = gui_luc(now, rules["window"])
    # Trần theo THÁNG GỬI (22:30 ngày 31 → gửi 08:00 ngày 1 tháng sau →
    # tính vào tháng sau), khớp khóa `load_data` đếm.
    mk = month_key(send_at)
    rb_hi = today - timedelta(days=rules["rebuy_after_days"])
    rb_lo = rb_hi - timedelta(days=rules["rebuy_window_days"])
    rv_hi = today - timedelta(days=rules["review_after_days"])
    rv_lo = rv_hi - timedelta(days=rules["review_window_days"])
    purchases = sorted(data.get("purchases") or [],
                       key=lambda x: (x["purchased_on"], x["id"]))
    # lần mua MỚI NHẤT mỗi (khách, SKU) — lần cũ hơn đã được mua lại
    latest = {(p["contact_id"], p["sku_key"]): p["id"] for p in purchases}
    counts = dict(data.get("month_counts") or {})
    consent = data.get("consent") or {}
    items, skipped = [], []

    def skip(p, kind, why):
        skipped.append({"purchase_id": p["id"], "contact_id": p["contact_id"],
                        "kind": kind, "ly_do": why})

    def push(p, kind, oid):
        text = render_text(kind, p, rules)
        g = guardrail.check_publish(
            text, channel=rules["channel"], content_type=CTYPE[kind],
            sku=p["sku_key"], is_ai=False, readiness=readiness)
        if g.get("ok") is not True:
            skip(p, kind, "guardrail")
            return False
        items.append({
            "kind": kind, "object_type": TYPES[kind], "object_id": oid,
            "purchase_id": p["id"], "contact_id": p["contact_id"],
            "sku_key": p["sku_key"], "gui_luc": send_at,
            "title": (f"{'Nhắc mua lại' if kind == 'rebuy' else 'Xin đánh giá'}"
                      f" — khách #{int(p['contact_id'])}, lần mua #{p['id']}"),
            "payload": payload_of(text, p["contact_id"], kind, send_at)})
        return True

    for p in purchases:
        if p.get("channel") not in OWN_CHANNELS:
            skip(p, "rebuy", "kenh_san")     # chặn cả ở DB — phòng thủ kép
            continue
        cid = p["contact_id"]
        # --- nhắc mua lại
        if rb_lo <= p["purchased_on"] <= rb_hi and \
                latest[(cid, p["sku_key"])] == p["id"] and \
                p["id"] not in (data.get("seen_rebuy") or set()):
            alcohol = (p.get("category") == "alcohol"
                       or kb_filter.is_alcohol(p.get("name") or ""))
            if not consent.get((cid, "marketing")):
                skip(p, "rebuy", "consent")
            elif alcohol:
                skip(p, "rebuy", "ruou")
            elif p["sku_key"] not in (data.get("promotable") or set()):
                skip(p, "rebuy", "khong_promotable")
            elif counts.get(cid, 0) >= rules["max_marketing_per_month"]:
                skip(p, "rebuy", "tran_thang")
            elif push(p, "rebuy", f"{int(cid)}:{mk}:p{p['id']}"):
                counts[cid] = counts.get(cid, 0) + 1
        # --- xin đánh giá
        d = p.get("delivered_on")
        if d is not None and rv_lo <= d <= rv_hi and \
                p["id"] not in (data.get("seen_review") or set()):
            if not consent.get((cid, "cskh")):
                skip(p, "review", "consent")
            else:
                push(p, "review", f"review:{p['id']}")
    return {"items": items, "skipped": skipped}


# ------------------------------------------------------------ đọc DB

def load_data(conn, now: datetime, rules: dict) -> dict:
    """CHỈ SELECT. Đồng ý đọc qua `crm.can_contact` (mặc định False)."""
    cols = ("id", "contact_id", "channel", "sku_key", "name", "category",
            "purchased_on", "delivered_on")
    purchases = [dict(zip(cols, r)) for r in conn.execute(
        "select p.id, p.contact_id, p.channel, p.sku_key, m.name,"
        " m.category, p.purchased_on, p.delivered_on from care_purchases p"
        " join sku_master m on m.sku_key = p.sku_key order by p.id")]
    consent = {}
    for cid in sorted({p["contact_id"] for p in purchases}):
        for purpose in ("marketing", "cskh"):
            consent[(cid, purpose)] = can_contact(conn, cid, purpose)
    promotable = {k for (k,) in conn.execute(
        "select sku_key from v_promotable where channel = %s",
        (rules["channel"],))}
    counts: dict = {}
    for (oid,) in conn.execute(
            "select object_id from approval_queue where object_type ="
            " 'care_rebuy' and status in ('pending', 'approved')"
            " and object_id like %s",
            (f"%:{month_key(gui_luc(now, rules['window']))}:%",)):
        with suppress(ValueError):
            c = int(oid.split(":", 1)[0])
            counts[c] = counts.get(c, 0) + 1
    seen_rebuy, seen_review = set(), set()
    for ot, oid in conn.execute(
            "select object_type, object_id from approval_queue where"
            " object_type in ('care_rebuy', 'care_review')"):
        tail = oid.rsplit(":", 1)[-1]
        with suppress(ValueError):
            if ot == "care_rebuy" and tail.startswith("p"):
                seen_rebuy.add(int(tail[1:]))
            elif ot == "care_review" and oid.startswith("review:"):
                seen_review.add(int(tail))
    return {"purchases": purchases, "consent": consent,
            "promotable": promotable, "month_counts": counts,
            "seen_rebuy": seen_rebuy, "seen_review": seen_review}


def plan(conn, now: datetime, rules: dict | None = None) -> dict:
    rules = rules or load_rules()
    return select_items(load_data(conn, now, rules), now, rules,
                        store.readiness_from_db(conn))


def run(conn, now: datetime, dry_run: bool = False,
        rules: dict | None = None, cfg: dict | None = None) -> dict:
    """plan → `director.submit` từng mục (dry_run: không ghi). → {"new",
    "items", "skipped"}."""
    res = plan(conn, now, rules)
    conn.commit()           # đóng tx đọc (conn chia sẻ — gotcha v2.1)
    n = 0
    if not dry_run:
        cfg = cfg or director.load_config(BLOCK)
        for it in res["items"]:
            try:
                director.submit(conn, BLOCK, it["object_type"],
                                it["object_id"], it["title"], it["payload"],
                                AGENT, cfg=cfg)
            except psycopg.errors.UniqueViolation:
                conn.rollback()
                continue          # cùng mục vừa được đẩy song song
            n += 1
    return {"new": n, **res}


def verify_send(conn, item_id, text: str, now: datetime,
                rules: dict | None = None) -> tuple[bool, str]:
    """Kiểm NGAY TRƯỚC KHI NGƯỜI gửi → (ok, lý do). Lý do: khong_tim_thay
    | loai_la | chua_duyet | sha | consent | khung_gio | thang_khac | ok."""
    rules = rules or load_rules()
    try:
        qid = int(item_id)
        row = conn.execute("select object_type, status, object_id from"
                           " approval_queue where id = %s", (qid,)).fetchone()
    except (TypeError, ValueError, psycopg.Error):
        return False, "khong_tim_thay"
    if row is None:
        return False, "khong_tim_thay"
    kind = {v: k for k, v in TYPES.items()}.get(row[0])
    if kind is None:
        return False, "loai_la"
    if row[1] != "approved":
        return False, "chua_duyet"
    if not aq.verify(conn, qid, text):
        return False, "sha"
    m = _CONTACT_LINE_RE.search(text)
    if m is None or not can_contact(conn, int(m.group(1)), PURPOSE[kind]):
        return False, "consent"
    if not in_window(now, rules["window"]):
        return False, "khung_gio"
    # Trần tháng tính theo tháng gửi trong object_id → gửi trễ sang tháng
    # khác sẽ vượt trần tháng đó: chặn, để --run tháng mới lập lại.
    if kind == "rebuy" and str(row[2]).split(":")[1:2] != [month_key(now)]:
        return False, "thang_khac"
    return True, "ok"


# ------------------------------------------------------------ ghi lần mua

def _check_by(by) -> str:
    s = (by or "").strip()
    if not s or len(s) > MAX_BY or not s.isprintable() \
            or s.casefold().startswith(("agent:", "system:")):
        raise ValueError("--by phải là tên NGƯỜI ghi (≤ 100 ký tự, không"
                         " 'agent:'/'system:')")
    return s


def _date_of(v, name, required=True):
    if v is None and not required:
        return None
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        raise ValueError(f"{name} phải YYYY-MM-DD") from None


def record(conn, rec: dict, by: str) -> int:
    """Ghi 1 lần mua (NGƯỜI ghi) → id. Validate TRƯỚC khi ghi; không nhận
    trường PII (chỉ contact_id). Log `agent_action_log` không PII."""
    by = _check_by(by)
    if not isinstance(rec, dict):
        raise TypeError("input phải là object JSON")
    extra = set(rec) - {"contact_id", "channel", "sku_key", "purchased_on",
                        "delivered_on", "order_ref"}
    if extra:
        # Không echo tên trường: key do người nhập có thể chính là SĐT/tên
        # (rà OWASP A09 v10.1).
        raise ValueError(f"có {len(extra)} trường không nhận — chỉ ghi"
                         " contact_id, channel, sku_key, purchased_on,"
                         " delivered_on, order_ref (PII nằm trong vault"
                         " contacts)")
    cid = rec.get("contact_id")
    if not (isinstance(cid, int) and not isinstance(cid, bool) and cid > 0):
        raise ValueError("contact_id phải số nguyên dương")
    ch = rec.get("channel")
    if ch not in OWN_CHANNELS:
        raise ValueError(f"channel phải {'|'.join(OWN_CHANNELS)} — khách sàn"
                         " chăm sóc bằng công cụ của sàn")
    sku = rec.get("sku_key")
    if not (isinstance(sku, str) and _REF_RE.fullmatch(sku)):
        raise ValueError("sku_key không hợp lệ")
    bought = _date_of(rec.get("purchased_on"), "purchased_on")
    got = _date_of(rec.get("delivered_on"), "delivered_on", required=False)
    ref = rec.get("order_ref")
    if ref is not None and not (isinstance(ref, str) and _REF_RE.fullmatch(ref)
                                and not _PII_RE.search(ref)):
        raise ValueError("order_ref phải MÃ nội bộ [A-Za-z0-9_.:-] ≤ 40 ký"
                         " tự, không phải SĐT/email")
    with conn.transaction():
        pid = conn.execute(
            "insert into care_purchases (contact_id, channel, order_ref,"
            " sku_key, purchased_on, delivered_on, recorded_by) values"
            " (%s, %s, %s, %s, %s, %s, %s) returning id",
            (cid, ch, ref, sku, bought, got, by)).fetchone()[0]
        conn.execute(store._LOG_SQL, (
            by, "care_purchase_record", "care_purchase", str(pid),
            Jsonb({"contact_id": cid, "channel": ch, "sku_key": sku})))
    conn.commit()
    return pid


# ------------------------------------------------------------ CLI

def _print_plan(res: dict, tag: str) -> None:
    for it in res["items"]:
        print(f"  [{it['object_type']}] khách #{it['contact_id']} lần mua"
              f" #{it['purchase_id']} gửi lúc {it['gui_luc']:%d/%m %H:%M}")
    reasons: dict = {}
    for s in res["skipped"]:
        reasons[f"{s['kind']}:{s['ly_do']}"] = \
            reasons.get(f"{s['kind']}:{s['ly_do']}", 0) + 1
    print(f"[{tag}] {len(res['items'])} nháp · bỏ qua "
          + (", ".join(f"{k} {v}" for k, v in sorted(reasons.items()))
             or "0"))


def _main(args, rules, cfg, now) -> int:
    rec = None
    if args.record:
        try:
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise ValueError("input quá 4 KB")
            rec = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            print(f"[error] input JSON không hợp lệ ({type(e).__name__})",
                  file=sys.stderr)
            return 1
    text = None
    if args.verify_send:
        try:
            text = Path(args.verify_send[1]).read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError) as e:
            print(f"[error] không đọc được file ({type(e).__name__})",
                  file=sys.stderr)
            return 1
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if args.record:
            pid = record(conn, rec, args.by)
            print(f"[ok] ghi lần mua #{pid} (khách #{rec['contact_id']})")
        elif args.verify_send:
            ok, why = verify_send(conn, args.verify_send[0], text, now, rules)
            print(f"[{'ok' if ok else 'fail'}] mục #{args.verify_send[0]}:"
                  f" {why}" + ("" if ok else " — KHÔNG gửi"))
            return 0 if ok else 1
        elif args.plan:
            _print_plan(plan(conn, now, rules), "plan")
        else:
            res = run(conn, now, dry_run=args.dry_run, rules=rules, cfg=cfg)
            _print_plan(res, "dry-run" if args.dry_run else "run")
            if not args.dry_run:
                print(f"[run] đẩy {res['new']} nháp mới vào hàng duyệt khối"
                      f" {BLOCK} — hệ thống KHÔNG gửi")
    except (ValueError, TypeError) as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)[:300]}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    return 0


def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_care",
        description="KD-A7 — nháp tin chăm sóc lại / xin đánh giá CHỈ cho "
                    "khách có đồng ý (hệ thống KHÔNG gửi)")
    ap.add_argument("--record", action="store_true",
                    help="ghi 1 lần mua từ stdin JSON (cần --by)")
    ap.add_argument("--by", help="tên NGƯỜI ghi")
    ap.add_argument("--plan", action="store_true", help="chỉ đọc, in kế hoạch")
    ap.add_argument("--run", action="store_true",
                    help="đẩy nháp mới vào hàng duyệt khối sales")
    ap.add_argument("--dry-run", action="store_true",
                    help="với --run: không ghi DB")
    ap.add_argument("--verify-send", nargs=2, metavar=("ID", "FILE"))
    args = ap.parse_args(argv)
    n_ops = sum([args.record, args.plan, args.run,
                 args.verify_send is not None])
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần (--record | --plan | --run |"
                 " --verify-send)")
    if n_ops == 0:
        ap.error("cần --record | --plan | --run | --verify-send ID FILE")
    if args.dry_run and not args.run:
        ap.error("--dry-run chỉ đi với --run")
    if args.record:
        try:
            _check_by(args.by)
        except ValueError as e:
            ap.error(str(e))
    elif args.by:
        ap.error("--by chỉ đi với --record")
    try:
        rules = load_rules()
        cfg = director.load_config(BLOCK)
        if not set(TYPES.values()) <= set(cfg["object_types"]):
            raise DirectorConfigError("sales.json thiếu loại việc care_rebuy"
                                      "/care_review")
    except (CareRulesError, DirectorConfigError) as e:
        print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
        return 1
    now = now or datetime.now(VN_TZ)
    if not args.run or args.dry_run:
        return _main(args, rules, cfg, now)
    with job_run(JOB) as r:
        rc = _main(args, rules, cfg, now)
        r["ok"] = rc == 0
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
