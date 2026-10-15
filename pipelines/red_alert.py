"""v4.0 W40.4 — cảnh báo đỏ tới người nhận ĐỘC LẬP (WP03).

Contract:
  - Bảng `red_alerts` append-only: role người `app_human` (TGĐ, Quản lý hạ
    tầng AI khi kết nối bằng DSN theo role) không có quyền sửa/xóa; trigger
    chặn UPDATE/DELETE/TRUNCATE khi trigger còn bật. GIỚI HẠN: owner bảng
    `ALTER TABLE ... DISABLE TRIGGER` / superuser `session_replication_role
    = replica` vẫn xóa được — TGĐ/ha_tang KHÔNG được giữ DSN owner/superuser
    sau khi chuyển DSN theo role; neo ngoài (object-lock) = external-dep.
    Agent (`agent_writer`) chỉ INSERT.
  - Người nhận đọc từ `data/red_alert_routing.json`: recipients `{"name",
    "role", "channel"}`; role CHỈ nhận allowlist `INDEPENDENT_ROLES`
    (`phap_che`, `bks`) trừ `excluded_roles` (luôn gồm `tgd`, `ha_tang` —
    người có thể dập cảnh báo); role khác/lạ hoặc thiếu name/role/channel →
    BỎ + ghi `problems`. `raise_alert` lọc LẠI routing truyền tay cùng luật. File thiếu/rỗng/JSON hỏng/`{}`/chỉ `_doc` →
    recipients `[]` (không raise).
  - `raise_alert`: title/detail qua `_mask_pii` trước khi ghi. Không có
    người nhận hợp lệ → VẪN ghi dòng (`recipients='{}'`, `route_error`),
    in cảnh báo stderr, trả `(False, ...)` — fail-closed: không im lặng,
    không gửi nhầm TGĐ/ha_tang. Insert + 1 dòng log `red_alert_raise`
    cùng transaction + `conn.commit()`.
  - v13.7 (F06) GỬI THẬT qua SMTP stdlib (`smtplib`, STARTTLS có kiểm
    chứng chỉ): bật bằng env `RED_ALERT_NOTIFY=email` + `SMTP_HOST`
    [`SMTP_PORT` 587, `SMTP_USER`/`SMTP_PASSWORD`, `SMTP_FROM`]. Kênh người
    nhận `email:<địa chỉ>` hoặc `email:$TEN_BIEN` (địa chỉ để trong env —
    repo public, không ghi email người thật vào JSON). Sau khi ghi cảnh báo,
    `raise_alert` gửi NGAY từng người nhận và ghi 1 dòng
    `red_alert_deliveries` (ok/lỗi, không lưu địa chỉ). Trả `(True, ..)` CHỈ
    khi ≥1 người nhận ĐÃ GỬI ĐƯỢC — có người nhận mà chưa cấu hình kênh/gửi
    lỗi = `(False, ..)` "chưa thông báo" (không ghi "đã thông báo").
  - `--deliver` (job hằng giờ): gửi lại cảnh báo trong 48 giờ chưa có lần
    gửi ok và chưa ai xác nhận (trần `MAX_ATTEMPTS` lượt/người nhận) tới
    người nhận HIỆN HÀNH; còn cảnh báo chưa gửi được → exit 1.
  - `--ack ID --by` CHUNG cho MỌI cảnh báo đỏ gốc (không chỉ intel): người
    thật (không `agent:`/`system:`); chế độ thực (`pipelines.auth.
    approval_enforced`) chỉ nhận người có trong routing độc lập. Bản leo
    thang → xác nhận id gốc. KPI 2 giờ đồng hồ (kể cả T7/CN/Tết) tính ở
    `scripts/ops_monthly.py`.

Chạy: `python -m pipelines.red_alert --check-routing` (exit 0 khi có ≥1
người nhận GỬI ĐƯỢC; 1 khi thiếu người nhận HOẶC chưa có kênh gửi) ·
`--deliver` · `--ack ID --by "Tên" [--note ..]` · `--open`.
"""

import argparse
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

import psycopg
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from pipelines.pii import _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ROUTING = ROOT / "data" / "red_alert_routing.json"
# Luôn loại, kể cả khi file cấu hình xóa khỏi excluded_roles.
ALWAYS_EXCLUDED = ("tgd", "ha_tang")
# ALLOWLIST vai trò độc lập (không thể dập cảnh báo): Pháp chế, Ban kiểm
# soát. Vai trò KHÁC (kể cả 'TGĐ' có dấu, 'tong_giam_doc', 'giam_doc',
# 'quan_ly_ha_tang', vai trò lạ) → bỏ — fail-closed, không deny-list nhãn.
# Thêm vai trò = sửa code + Pháp chế xác nhận (external-dep), không qua file.
INDEPENDENT_ROLES = ("phap_che", "bks")
MISSING = "thiếu người nhận độc lập (external-dep)"
NOT_SENT = "chưa gửi được tới người nhận nào"
NOTIFY_TIMEOUT_S = 10
DELIVER_WINDOW = timedelta(hours=48)
MAX_ATTEMPTS = 5          # lượt gửi lỗi tối đa / người nhận / cảnh báo
BY_MAX = 100
NOTE_MAX = 500
BIGINT_MAX = 2 ** 63 - 1
_ENV = object()           # sender mặc định = đọc cấu hình SMTP từ env


def _norm(v) -> str:
    return v.strip().lower() if isinstance(v, str) else ""


def _valid_recipients(raw, excluded) -> tuple[list[dict], list[str]]:
    """Lọc recipients theo allowlist INDEPENDENT_ROLES trừ `excluded` (luôn
    gồm ALWAYS_EXCLUDED) + đủ name/role/channel → (hợp lệ, problems). Dùng
    chung cho load_routing VÀ raise_alert (routing truyền tay cũng bị lọc)."""
    excl = {_norm(r) for r in excluded} | set(ALWAYS_EXCLUDED)
    out, problems = [], []
    for i, r in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(r, dict):
            problems.append(f"recipients[{i}] không phải object")
            continue
        name = r.get("name").strip() if isinstance(r.get("name"), str) else ""
        channel = (r.get("channel").strip()
                   if isinstance(r.get("channel"), str) else "")
        role = _norm(r.get("role"))
        if not name or not channel or not role:
            problems.append(f"recipients[{i}] thiếu name/role/channel")
            continue
        if role in excl or role not in INDEPENDENT_ROLES:
            problems.append(f"recipients[{i}] role '{role}' bị loại (chỉ "
                            f"nhận {', '.join(INDEPENDENT_ROLES)} — độc lập "
                            "với người có thể dập cảnh báo)")
            continue
        out.append({"name": name, "role": role, "channel": channel})
    return out, problems


def load_routing(path=None) -> dict:
    """→ {"recipients": [hợp lệ], "excluded_roles": [...], "problems": [...]}
    Không raise: file hỏng → recipients [] + problems."""
    p = Path(path) if path is not None else ROUTING
    problems: list[str] = []
    cfg = {}
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        problems.append(f"không có file {p.name}")
    except (OSError, ValueError) as e:  # JSON hỏng, rỗng, UTF-8 lỗi
        problems.append(f"{p.name} hỏng: {type(e).__name__}")
    if not isinstance(cfg, dict):
        problems.append(f"{p.name} không phải object JSON")
        cfg = {}
    raw_ex = cfg.get("excluded_roles")
    excluded = sorted({_norm(r) for r in (raw_ex if isinstance(raw_ex, list)
                                         else []) if _norm(r)}
                      | set(ALWAYS_EXCLUDED))
    recipients, probs = _valid_recipients(cfg.get("recipients"), excluded)
    return {"recipients": recipients, "excluded_roles": excluded,
            "problems": problems + probs}


def _mask(o):
    """Mask PII trong mọi chuỗi của detail (giữ cấu trúc JSON)."""
    if isinstance(o, str):
        return _mask_pii(o)
    if isinstance(o, dict):
        return {str(k): _mask(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_mask(v) for v in o]
    return o


def channel_kind(channel: str) -> str:
    return (channel or "").split(":", 1)[0].strip().lower()


def resolve_address(channel: str, env=None) -> str | None:
    """`email:<địa chỉ>` | `email:$TEN_BIEN` → địa chỉ; khác → None. Không
    in/ghi địa chỉ ở đâu ngoài lời gọi SMTP."""
    env = os.environ if env is None else env
    if channel_kind(channel) != "email" or ":" not in (channel or ""):
        return None
    v = channel.split(":", 1)[1].strip()
    if v.startswith("$"):
        v = (env.get(v[1:]) or "").strip()
    ok = (v.count("@") == 1 and len(v) <= 254 and v.isprintable()
          and not any(c.isspace() or c in ",;<>\"" for c in v))
    return v if ok else None


def smtp_sender(env=None):
    """→ hàm gửi `(địa chỉ, tiêu đề, nội dung)` | None khi chưa cấu hình
    (`RED_ALERT_NOTIFY` != email hoặc thiếu `SMTP_HOST`). Chỉ mở mạng lúc
    gọi hàm trả về."""
    env = os.environ if env is None else env
    if (env.get("RED_ALERT_NOTIFY") or "").strip().lower() != "email" \
            or not (env.get("SMTP_HOST") or "").strip():
        return None
    host = env["SMTP_HOST"].strip()
    port = int(env.get("SMTP_PORT") or 587)
    user = env.get("SMTP_USER") or ""
    from_addr = env.get("SMTP_FROM") or user or "red-alert@localhost"

    def send(to: str, subject: str, body: str) -> None:
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = subject, from_addr, to
        msg.set_content(body)
        with smtplib.SMTP(host, port, timeout=NOTIFY_TIMEOUT_S) as smtp:
            # context kiểm chứng chỉ + hostname (starttls trần = MITM).
            smtp.starttls(context=ssl.create_default_context())
            if user:
                smtp.login(user, env.get("SMTP_PASSWORD", ""))
            smtp.send_message(msg)
    return send


def _message(aid: int, title: str) -> tuple[str, str]:
    t = " ".join(title.split())
    subject = f"[BÁO ĐỘNG ĐỎ #{aid}] {t}"[:200]
    body = (f"Cảnh báo đỏ #{aid}: {t}\n\n"
            "Yêu cầu xác nhận trong 02 giờ, kể cả cuối tuần và Tết (PL02 mục "
            "3). Xác nhận trên máy chủ:\n"
            f"  python -m pipelines.red_alert --ack {aid} --by \"<tên>\"\n"
            "Chi tiết xem bảng red_alerts (thư không chứa dữ liệu khách).")
    return subject, body


def deliver(conn, alert_id: int, title: str, recipients: list[dict],
            sender=_ENV, env=None) -> int:
    """Gửi 1 cảnh báo tới từng người nhận hợp lệ, ghi `red_alert_deliveries`
    1 dòng/người (ok/lỗi — lỗi chỉ ghi TÊN loại lỗi, không địa chỉ) →
    số người đã gửi được. Ghi DB lỗi → rollback + cảnh báo, vẫn trả số gửi."""
    sender = smtp_sender(env) if sender is _ENV else sender
    subject, body = _message(alert_id, _mask_pii(title or ""))
    rows, n_ok = [], 0
    for r in recipients:
        kind, err = channel_kind(r["channel"]), None
        addr = resolve_address(r["channel"], env)
        if kind != "email":
            err = f"kênh '{kind[:20]}' chưa hỗ trợ — chỉ email (SMTP)"
        elif sender is None:
            err = "kênh gửi chưa cấu hình (RED_ALERT_NOTIFY=email + SMTP_HOST)"
        elif addr is None:
            err = "địa chỉ người nhận chưa cấu hình (email:<địa chỉ>|$BIEN)"
        else:
            try:
                sender(addr, subject, body)
            except Exception as e:  # noqa: BLE001 — ghi lỗi, gửi người khác
                err = f"gửi lỗi: {type(e).__name__}"
        n_ok += err is None
        rows.append((alert_id, r["name"], r["role"], kind[:20] or "?",
                     err is None, err))
    try:
        with conn.transaction():
            for row in rows:
                conn.execute(
                    "insert into red_alert_deliveries (alert_id, recipient,"
                    " role, channel, ok, error) values (%s, %s, %s, %s, %s,"
                    " %s)", row)
        conn.commit()
    except psycopg.Error as e:
        conn.rollback()
        print(f"[RED-ALERT][warn] không ghi được nhật ký gửi cảnh báo "
              f"#{alert_id} ({type(e).__name__})", file=sys.stderr, flush=True)
    return n_ok


def raise_alert(conn, source_agent: str, title: str, detail=None,
                routing: dict | None = None, sender=_ENV
                ) -> tuple[bool, str]:
    """Ghi 1 cảnh báo đỏ rồi gửi ngay → (đã gửi tới ≥1 người?, thông điệp)."""
    agent = (source_agent or "").strip()
    if not agent:
        raise ValueError("raise_alert: thiếu source_agent")
    t = _mask_pii((title or "").strip())
    if not t:
        raise ValueError("raise_alert: thiếu title")
    routing = routing if routing is not None else load_routing()
    if not isinstance(routing, dict):
        routing = {}
    # Lọc LẠI cả routing truyền tay — không tin caller (TGĐ/ha_tang/vai trò
    # ngoài allowlist không bao giờ là người nhận).
    valid, _ = _valid_recipients(routing.get("recipients"),
                                 routing.get("excluded_roles") or ())
    names = [r["name"] for r in valid]
    route_error = None if names else MISSING
    with conn.transaction():
        aid = conn.execute(
            "insert into red_alerts (source_agent, title, detail, recipients,"
            " route_error) values (%s, %s, %s, %s, %s) returning id",
            (agent, t, Jsonb(_mask(detail or {})), names, route_error)
        ).fetchone()[0]
        conn.execute(
            "insert into agent_action_log (actor, action, object_type,"
            " object_id, detail) values (%s, %s, %s, %s, %s)",
            (agent, "red_alert_raise", "red_alert", str(aid),
             Jsonb({"alert_id": aid, "routed": bool(names),
                    "n_recipients": len(names)})))
    conn.commit()
    if not names:
        msg = f"cảnh báo đỏ #{aid} đã ghi nhưng {MISSING} — chưa ai nhận"
        print(f"[RED-ALERT][warn] {msg}", file=sys.stderr, flush=True)
        return False, msg
    n_ok = deliver(conn, aid, t, valid, sender)
    if not n_ok:
        msg = (f"cảnh báo đỏ #{aid} đã ghi, {NOT_SENT} ({len(names)} người "
               "nhận) — CHƯA thông báo; `--deliver` sẽ gửi lại")
        print(f"[RED-ALERT][warn] {msg}", file=sys.stderr, flush=True)
        return False, msg
    return True, f"cảnh báo đỏ #{aid} → đã gửi {n_ok}/{len(names)} người nhận"


_PENDING_SQL = (
    "select r.id, r.title from red_alerts r where r.ts >= %s"
    " and not exists (select 1 from red_alert_deliveries d"
    " where d.alert_id = r.id and d.ok)"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " order by r.id")


def deliver_pending(conn, now: datetime, routing: dict | None = None,
                    sender=_ENV, env=None) -> dict:
    """Gửi lại cảnh báo trong `DELIVER_WINDOW` chưa có lần gửi ok + chưa ai
    xác nhận, tới người nhận độc lập HIỆN HÀNH (cảnh báo ghi lúc thiếu người
    nhận cũng được gửi khi đã có). → {"pending", "sent", "failed",
    "capped"} (list id)."""
    routing = routing if routing is not None else load_routing()
    valid, _ = _valid_recipients(routing.get("recipients"),
                                 routing.get("excluded_roles") or ())
    rows = conn.execute(_PENDING_SQL, (now - DELIVER_WINDOW,)).fetchall()
    conn.commit()
    st = {"pending": len(rows), "sent": [], "failed": [], "capped": []}
    if not valid:
        st["failed"] = [aid for aid, _ in rows]
        return st
    cap = MAX_ATTEMPTS * len(valid)
    for aid, title in rows:
        n = conn.execute("select count(*) from red_alert_deliveries where"
                         " alert_id = %s", (aid,)).fetchone()[0]
        conn.commit()
        if n >= cap:
            st["capped"].append(aid)
            continue
        ok = deliver(conn, aid, title, valid, sender, env)
        st["sent" if ok else "failed"].append(aid)
    return st


def ack(conn, alert_id, by: str, note: str | None = None, *,
        routing: dict | None = None, env=None) -> tuple[bool, str]:
    """NGƯỜI xác nhận MỌI cảnh báo đỏ gốc → (True, msg) | (False, lý do).
    Không raise với đầu vào lỗi."""
    from pipelines import auth
    by = _mask_pii(" ".join(str(by or "").split())[:BY_MAX + 1])
    if not by:
        return False, "thiếu tên người xác nhận (--by)"
    if len(by) > BY_MAX:
        return False, f"tên người xác nhận dài quá {BY_MAX} ký tự"
    if not auth.is_human(by):
        return False, "người xác nhận phải là người thật (không agent:/system:)"
    allow = None
    if auth.approval_enforced(env):
        routing = routing if routing is not None else load_routing()
        valid, _ = _valid_recipients(routing.get("recipients"),
                                     routing.get("excluded_roles") or ())
        allow = [r["name"] for r in valid]
    try:
        aid = int(alert_id)
    except (TypeError, ValueError):
        aid = 0
    if not 1 <= aid <= BIGINT_MAX:
        return False, f"id '{' '.join(str(alert_id).split())[:40]}' không hợp lệ"
    # v14.2: chế độ thực — chỉ người nhận độc lập, có tài khoản + `--by` khớp
    # login Postgres đang dùng (không còn tên tự khai); lần bị chặn vào log
    # hash chain.
    why = auth.cli_gate(conn, by, None, "ack", "red_alert", aid, allow=allow,
                        allow_src="người nhận độc lập trong "
                                  "data/red_alert_routing.json", env=env)
    if why:
        return False, f"chế độ thực: {why}"
    # Cắt TRƯỚC regex mask (chống DoS), cắt lại sau mask.
    note = (_mask_pii(str(note).strip()[:NOTE_MAX * 2])[:NOTE_MAX] or None
            if note else None)
    row = conn.execute("select detail from red_alerts where id = %s",
                       (aid,)).fetchone()
    if row is None:
        conn.commit()
        return False, f"không tìm thấy cảnh báo #{aid}"
    detail = row[0] if isinstance(row[0], dict) else {}
    if "escalation_of" in detail:
        conn.commit()
        return False, (f"#{aid} là bản leo thang — xác nhận id gốc "
                       f"#{detail['escalation_of']}")
    try:
        with conn.transaction():
            conn.execute("insert into red_alert_acks (alert_id, acked_by,"
                         " note) values (%s, %s, %s)", (aid, by, note))
        conn.commit()
    except UniqueViolation:
        conn.rollback()
        return False, f"cảnh báo #{aid} đã được xác nhận trước đó"
    except psycopg.Error as e:
        conn.rollback()
        diag = getattr(e, "diag", None)
        why = getattr(diag, "message_primary", None) or type(e).__name__
        return False, f"cảnh báo #{aid}: {why}"
    return True, f"đã xác nhận cảnh báo #{aid} (người: {by})"


_OPEN_SQL = (
    "select r.id, r.ts, r.source_agent, r.title, r.route_error,"
    " exists (select 1 from red_alert_deliveries d where d.alert_id = r.id"
    " and d.ok) from red_alerts r where not (r.detail ? 'escalation_of')"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " order by r.ts, r.id")


def open_alerts(conn, now: datetime) -> list[dict]:
    """Cảnh báo GỐC (mọi nguồn) chưa xác nhận, cũ nhất trước."""
    rows = conn.execute(_OPEN_SQL).fetchall()
    conn.commit()
    return [{"id": i, "ts": ts, "source": src, "title": t,
             "route_error": er, "delivered": bool(dl),
             "age_h": round((now - ts).total_seconds() / 3600, 1)}
            for i, ts, src, t, er, dl in rows]


def _check_routing() -> int:
    r = load_routing()
    for prob in r["problems"]:
        print(f"[warn] {prob}")
    if not r["recipients"]:
        print(f"[FAIL] {MISSING} — cảnh báo đỏ vẫn được ghi bảng red_alerts "
              "nhưng chưa có ai nhận; Pháp chế xác nhận người nhận rồi điền "
              "data/red_alert_routing.json")
        return 1
    print(f"[ok] {len(r['recipients'])} người nhận độc lập: "
          + ", ".join(f"{x['name']} ({x['role']}/{channel_kind(x['channel'])})"
                      for x in r["recipients"]))
    ready = [x for x in r["recipients"]
             if resolve_address(x["channel"]) is not None]
    if smtp_sender() is None or not ready:
        print("[FAIL] chưa có kênh gửi: cần RED_ALERT_NOTIFY=email + "
              "SMTP_HOST và người nhận kênh email:<địa chỉ>|$BIEN — cảnh báo "
              "chỉ nằm trong DB, CHƯA thông báo ai")
        return 1
    print(f"[ok] {len(ready)} người nhận có kênh email gửi được")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.red_alert",
        description="Cảnh báo đỏ — người nhận độc lập, gửi SMTP, xác nhận")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check-routing", action="store_true",
                   help="exit 0 khi có ≥1 người nhận gửi được, 1 khi thiếu")
    g.add_argument("--deliver", action="store_true",
                   help="gửi lại cảnh báo 48 giờ chưa gửi được/chưa xác nhận")
    g.add_argument("--ack", type=int, metavar="ID",
                   help="xác nhận cảnh báo đỏ gốc (cần --by)")
    g.add_argument("--open", action="store_true",
                   help="liệt kê cảnh báo gốc chưa xác nhận")
    ap.add_argument("--by", help="tên người xác nhận")
    ap.add_argument("--note", default=None)
    args = ap.parse_args(argv)
    if args.ack is not None and not (args.by or "").strip():
        ap.error("--ack cần --by <tên người>")
    if args.ack is None and (args.by is not None or args.note is not None):
        ap.error("--by/--note chỉ dùng với --ack")
    if args.check_routing:
        return _check_routing()
    from ingest.lead_store import connect
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", flush=True)
        return 1
    now = datetime.now(timezone.utc)
    try:
        if args.ack is not None:
            ok, msg = ack(conn, args.ack, args.by, args.note)
            print(f"[{'done' if ok else 'warn'}] {msg}", flush=True)
            return 0 if ok else 1
        if args.open:
            rows = open_alerts(conn, now)
            print(f"[open] {len(rows)} cảnh báo đỏ gốc chưa xác nhận")
            for d in rows:
                sent = "đã gửi" if d["delivered"] else "CHƯA GỬI ĐƯỢC"
                print(f"  #{d['id']} {d['age_h']}h [{d['source']}] {sent} — "
                      f"{_mask_pii(d['title'] or '')[:120]}")
            return 0
        from pipelines.job_runs import job_run
        with job_run("pipelines.red_alert.deliver") as jr:
            st = deliver_pending(conn, now)
            undone = st["failed"] + st["capped"]
            jr["detail"] = (f"pending={st['pending']} sent={len(st['sent'])}"
                            f" failed={len(st['failed'])}"
                            f" capped={len(st['capped'])}")
            jr["ok"] = not undone
        print(f"[done] {jr['detail']}", flush=True)
        if undone:
            print(f"[RED-ALERT][FAIL] {len(undone)} cảnh báo {NOT_SENT}: #"
                  + ", #".join(map(str, undone)), flush=True)
            return 1
        return 0
    except psycopg.Error as e:
        print(f"[err] lỗi DB: {type(e).__name__}", flush=True)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
