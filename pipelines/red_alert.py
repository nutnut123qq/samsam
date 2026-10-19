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
  - v14.6 `--escalate` (job 15 phút MỌI ngày, kể cả T7/CN/Tết): cảnh báo
    đỏ GỐC của MỌI nguồn (không chỉ intel) quá `ESCALATE_AFTER` = 2 giờ ĐỒNG
    HỒ (không tính giờ làm việc) chưa có `red_alert_acks` → đúng 1 bản leo
    thang (`detail.escalation_of`, cùng `source_agent` với bản gốc, unique
    index chung mọi nguồn) gửi tới người nhận độc lập. Mỗi cảnh báo gốc = 1
    đợt: leo thang 1 lần, không lặp mỗi lần quét; trần `ESC_MAX_PER_RUN`/lần
    (cũ trước, dư → lần sau). Bản leo thang chưa thông báo được → exit 1.
    `intel_alert.escalate` dùng chung hàm này (lọc nguồn intel).
  - v15 P12.2 TỒN khi bật leo thang: mốc bật = dòng `agent_action_log`
    `red_alert_escalation_start` đầu tiên (ghi 1 lần ở lần `--escalate` thật
    đầu tiên; giờ DB, không lùi được). Cảnh báo gốc ĐÃ quá 2 giờ TRƯỚC mốc
    (`ts < mốc − 2 giờ`) = TỒN: KHÔNG tự leo thang khi `backlog.chinh_sach`
    trong routing còn null (chờ Bên B) — chỉ đếm/in; "leo_thang_dan" = leo
    thang dần, cũ trước, CHUNG trần `ESC_MAX_PER_RUN`/lần; "khong_leo_thang"
    = không leo thang (vẫn ở `--open`). Chính sách khác null phải kèm
    `quyet_boi` (người) + `can_cu`. Truy vấn tồn TÁCH khỏi luồng thường →
    tồn bị giữ không chiếm chỗ trần 50 của cảnh báo mới. `--escalate
    --dry-run [--after ID]` = xem trước KHÔNG ghi gì (kể cả mốc): luồng
    thường + tồn phân trang theo id (keyset `id > after`, 50/trang, in id
    trang sau) — đi hết các trang = đủ mọi id, không trùng, không sót.
  - v15 P12.3 cấp 2 / ngoài giờ THEO CẤU HÌNH (routing): `cap2.sau_phut` +
    `cap2.recipients` → cảnh báo gốc vẫn chưa xác nhận `sau_phut` phút sau
    bản leo thang cấp 1 → đúng 1 bản cấp 2 (`detail.escalation_of =
    "<id>:cap2"`, `escalation_root`, cùng unique index → idempotent).
    `ngoai_gio.gio_lam_viec` {thu, tu, den, ngay_nghi} + `ngoai_gio.
    nguoi_truc` → bản leo thang tạo NGOÀI giờ làm việc (giờ VN) gửi thêm người
    trực. Người nhận cấp 2/trực cùng luật độc lập (`INDEPENDENT_ROLES`, loại
    TGĐ/hạ tầng). Chưa cấu hình (null/rỗng) → KHÔNG leo thang cấp 2, KHÔNG
    gửi người trực, in rõ "chưa cấu hình" — không tự chọn người (không lấy
    người nhận cấp 1/TGĐ thay). Cấu hình dở (có giờ mà không người hợp lệ…)
    → `problems` + coi như chưa cấu hình.

Chạy: `python -m pipelines.red_alert --check-routing` (exit 0 khi có ≥1
người nhận GỬI ĐƯỢC; 1 khi thiếu người nhận HOẶC chưa có kênh gửi; in trạng
thái tồn/cấp 2/ngoài giờ) · `--deliver` · `--escalate [--dry-run] [--after
ID]` · `--ack ID --by "Tên" [--note ..]` · `--open`.
"""

import argparse
import json
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta, timezone
from datetime import time as dtime
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
# v14.6 — PL02 mục 3: 02 giờ ĐỒNG HỒ, hằng code (cấu hình không nới được).
ESCALATE_AFTER = timedelta(hours=2)
ESC_LABEL = "CHƯA XÁC NHẬN"
ESC_PREFIX = f"[LEO THANG — {ESC_LABEL}] "
ESC_MAX_PER_RUN = 50
# v15 P12.2 — tồn khi bật leo thang (Bên B quyết; null = chưa quyết).
START_ACTION = "red_alert_escalation_start"
BACKLOG_POLICIES = {
    "leo_thang_dan": "leo thang dần tồn (cũ trước, chung trần 50/lần)",
    "khong_leo_thang": "không leo thang tồn (vẫn ở --open)"}
BACKLOG_UNSET = ("chính sách xử lý tồn CHƯA QUYẾT (Bên B — routing "
                 "`backlog.chinh_sach`) → tồn KHÔNG tự leo thang")
# v15 P12.3 — cấp 2 / ngoài giờ (Bên B chỉ định; rỗng = chưa cấu hình).
CAP2_LABEL = "CẤP 2 — CHƯA XÁC NHẬN"
CAP2_PREFIX = f"[LEO THANG {CAP2_LABEL}] "
CAP2_SUFFIX = ":cap2"
CAP2_MAX_MIN = 7 * 24 * 60
CAP2_UNSET = ("leo thang cấp 2 CHƯA CẤU HÌNH (Bên B chỉ định người cấp 2 + "
              "số phút — routing `cap2`) → không leo thang cấp 2")
OFF_UNSET = ("người trực ngoài giờ CHƯA CẤU HÌNH (Bên B — routing "
             "`ngoai_gio`) → ngoài giờ chỉ gửi người nhận cấp 1")
VN = timezone(timedelta(hours=7))


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


def _human(v) -> str:
    s = " ".join(v.split()) if isinstance(v, str) else ""
    ok = (s and len(s) <= BY_MAX and s.isprintable()
          and not s.casefold().startswith(("agent:", "system:")))
    return s if ok else ""


def backlog_cfg(raw) -> tuple[dict, list[str]]:
    """Chính sách tồn → ({"policy", "by", "ref"}, problems). Thiếu/lỗi →
    policy None (không tự gửi tồn)."""
    none = {"policy": None, "by": None, "ref": None}
    if raw is None:
        return none, []
    if not isinstance(raw, dict):
        return none, ["backlog không phải object — coi như chưa quyết"]
    pol = raw.get("chinh_sach")
    if pol is None:
        return none, []
    if pol not in BACKLOG_POLICIES:
        return none, [f"backlog.chinh_sach '{str(pol)[:40]}' không hợp lệ ("
                      + " | ".join(BACKLOG_POLICIES) + ") — coi như chưa quyết"]
    by, ref = _human(raw.get("quyet_boi")), _human(raw.get("can_cu"))
    if not by or not ref:
        return none, [("backlog.chinh_sach đã đặt nhưng thiếu quyet_boi"
                       " (người thật) / can_cu — coi như chưa quyết")]
    return {"policy": pol, "by": by, "ref": ref}, []


def cap2_cfg(raw, excluded) -> tuple[dict | None, list[str]]:
    """Cấp 2 → ({"after": timedelta, "recipients"}, problems) | None."""
    if raw is None or raw == {}:
        return None, []
    if not isinstance(raw, dict):
        return None, ["cap2 không phải object — chưa cấu hình"]
    m, rc = raw.get("sau_phut"), raw.get("recipients")
    if m is None and not rc:
        return None, []
    probs = []
    if (not isinstance(m, int) or isinstance(m, bool)
            or not 1 <= m <= CAP2_MAX_MIN):
        probs.append(f"cap2.sau_phut cần số nguyên 1..{CAP2_MAX_MIN}")
    valid, p2 = _valid_recipients(rc, excluded)
    probs += [f"cap2.{x}" for x in p2]
    if not valid:
        probs.append("cap2 không có người nhận hợp lệ")
    if probs:
        return None, [x + " — không leo thang cấp 2" for x in probs]
    return {"after": timedelta(minutes=m), "recipients": valid}, []


def _hhmm(v) -> dtime | None:
    try:
        h, mi = str(v).split(":")
        return dtime(int(h), int(mi)) if len(h) == 2 and len(mi) == 2 else None
    except ValueError:
        return None


def off_hours_cfg(raw, excluded) -> tuple[dict | None, list[str]]:
    """Ngoài giờ → ({"thu", "tu", "den", "ngay_nghi", "recipients"},
    problems) | None."""
    if raw is None or raw == {}:
        return None, []
    if not isinstance(raw, dict):
        return None, ["ngoai_gio không phải object — chưa cấu hình"]
    g, rc = raw.get("gio_lam_viec"), raw.get("nguoi_truc")
    if g is None and not rc:
        return None, []
    probs = []
    g = g if isinstance(g, dict) else {}
    thu = g.get("thu")
    tu, den = _hhmm(g.get("tu")), _hhmm(g.get("den"))
    if (not isinstance(thu, list) or not thu or not all(
            isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 6
            for x in thu)):
        probs.append("ngoai_gio.gio_lam_viec.thu cần list 0..6 (0 = thứ Hai)")
    if tu is None or den is None or not tu < den:
        probs.append("ngoai_gio.gio_lam_viec.tu/den cần 'HH:MM', tu < den")
    nghi = []
    for x in g.get("ngay_nghi") or []:
        try:
            nghi.append(date.fromisoformat(x))
        except (TypeError, ValueError):
            probs.append(f"ngoai_gio.gio_lam_viec.ngay_nghi '{str(x)[:12]}'"
                         " không phải YYYY-MM-DD")
    valid, p2 = _valid_recipients(rc, excluded)
    probs += [f"ngoai_gio.nguoi_truc: {x}" for x in p2]
    if not valid:
        probs.append("ngoai_gio không có người trực hợp lệ")
    if probs:
        return None, [x + " — không gửi người trực" for x in probs]
    return {"thu": set(thu), "tu": tu, "den": den, "ngay_nghi": set(nghi),
            "recipients": valid}, []


def is_off_hours(cfg: dict, now: datetime) -> bool:
    """THUẦN: `now` (aware) ngoài giờ làm việc theo giờ VN?"""
    t = now.astimezone(VN)
    return (t.weekday() not in cfg["thu"] or t.date() in cfg["ngay_nghi"]
            or not cfg["tu"] <= t.time() < cfg["den"])


def tiers(routing: dict | None) -> dict:
    """Cấu hình tồn/cấp 2/ngoài giờ đã kiểm (cả routing truyền tay)."""
    routing = routing if isinstance(routing, dict) else {}
    ex = routing.get("excluded_roles") or ()
    b, p1 = backlog_cfg(routing.get("backlog"))
    c2, p2 = cap2_cfg(routing.get("cap2"), ex)
    og, p3 = off_hours_cfg(routing.get("ngoai_gio"), ex)
    return {"backlog": b, "cap2": c2, "ngoai_gio": og,
            "problems": p1 + p2 + p3}


def tier_lines(t: dict) -> list[str]:
    b = t["backlog"]
    out = [f"[tồn] {BACKLOG_UNSET}" if b["policy"] is None else
           f"[tồn] {b['policy']} ({BACKLOG_POLICIES[b['policy']]}) — quyết "
           f"bởi {b['by']}, căn cứ {b['ref']}"]
    c2 = t["cap2"]
    out.append(f"[cấp 2] {CAP2_UNSET}" if c2 is None else
               f"[cấp 2] sau {int(c2['after'].total_seconds() // 60)} phút "
               "kể từ leo thang cấp 1 → "
               + ", ".join(f"{r['name']} ({r['role']})"
                           for r in c2["recipients"]))
    og = t["ngoai_gio"]
    out.append(f"[ngoài giờ] {OFF_UNSET}" if og is None else
               f"[ngoài giờ] giờ làm việc thứ {sorted(og['thu'])} "
               f"{og['tu']:%H:%M}–{og['den']:%H:%M} (giờ VN), ngoài giờ gửi "
               "thêm: " + ", ".join(f"{r['name']} ({r['role']})"
                                     for r in og["recipients"]))
    return out


def load_routing(path=None) -> dict:
    """→ {"recipients": [hợp lệ], "excluded_roles": [...], "problems": [...],
    "backlog", "cap2", "ngoai_gio"} (v15 P12.2/P12.3 — cấu hình thô, kiểm
    bằng `tiers`). Không raise: file hỏng → recipients [] + problems."""
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
    out = {"recipients": recipients, "excluded_roles": excluded,
           "backlog": cfg.get("backlog"), "cap2": cfg.get("cap2"),
           "ngoai_gio": cfg.get("ngoai_gio")}
    return {**out, "problems": problems + probs + tiers(out)["problems"]}


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


# Cảnh báo GỐC tới hạn cấp 1, chưa xác nhận, chưa leo thang. `edge` = mốc
# bật − 2 giờ: luồng thường `ts >= edge`, TỒN `ts < edge` (truy vấn tách →
# tồn bị giữ không chiếm chỗ trần của cảnh báo mới; keyset `id > after`).
_DUE_BASE = (
    " from red_alerts r where not (r.detail ? 'escalation_of')"
    " and r.ts <= %(due)s"
    " and (%(src)s::text is null or r.source_agent = %(src)s)"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " and not exists (select 1 from red_alerts e where e.detail ?"
    " 'escalation_of' and e.detail->>'escalation_of' = r.id::text)")
_DUE_COLS = "select r.id, r.source_agent, r.title, r.detail->>'url'"
_DUE_SQL = (_DUE_COLS + _DUE_BASE + " and r.ts >= %(edge)s"
            " order by r.id limit %(lim)s")
_BACKLOG_SQL = (_DUE_COLS + _DUE_BASE + " and r.ts < %(edge)s"
                " and r.id > %(after)s order by r.id limit %(lim)s")
_BACKLOG_N_SQL = "select count(*)" + _DUE_BASE + " and r.ts < %(edge)s"
# Cấp 2: gốc chưa xác nhận, bản cấp 1 đã quá `sau_phut`, chưa có cấp 2.
_CAP2_SQL = (
    "select r.id, r.source_agent, r.title, r.detail->>'url' from red_alerts r"
    " where not (r.detail ? 'escalation_of')"
    " and (%(src)s::text is null or r.source_agent = %(src)s)"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " and exists (select 1 from red_alerts e where e.detail ? 'escalation_of'"
    " and e.detail->>'escalation_of' = r.id::text and e.ts <= %(due2)s)"
    " and not exists (select 1 from red_alerts e2 where e2.detail ?"
    " 'escalation_of' and e2.detail->>'escalation_of' = r.id::text || %(sfx)s)"
    " order by r.id limit %(lim)s")
_START_SQL = "select min(ts) from agent_action_log where action = %s"


def escalation_start(conn, *, create: bool) -> datetime | None:
    """Mốc bật leo thang (giờ DB) — ghi 1 lần khi `create` và chưa có.
    Song song: 2 dòng → `min(ts)` vẫn là 1 mốc. Không đọc được (thiếu quyền
    SELECT agent_action_log) → lỗi DB nổi lên (fail-closed: không đoán tồn)."""
    ts = conn.execute(_START_SQL, (START_ACTION,)).fetchone()[0]
    if ts is not None or not create:
        conn.commit()
        return ts
    with conn.transaction():
        conn.execute(
            "insert into agent_action_log (actor, action, object_type,"
            " object_id, detail) values (%s, %s, %s, %s, %s)",
            ("system:red_alert", START_ACTION, "red_alert", "escalation",
             Jsonb({"escalate_after_h": ESCALATE_AFTER.total_seconds() / 3600,
                    "max_per_run": ESC_MAX_PER_RUN})))
    ts = conn.execute(_START_SQL, (START_ACTION,)).fetchone()[0]
    conn.commit()
    return ts


def _merge(*groups) -> list[dict]:
    seen, out = set(), []
    for g in groups:
        for r in g or ():
            k = (r["name"].casefold(), r["channel"])
            if k not in seen:
                seen.add(k)
                out.append(r)
    return out


def _raise_esc(conn, st, aid, src, title, url, detail, prefix, recipients,
               routing, sender, ids_key) -> None:
    if url:
        detail["url"] = url
    t = " ".join(str(title or "").split())[:200]
    try:
        routed, _ = raise_alert(
            conn, src, f"{prefix}#{aid} {t}", detail=detail,
            routing={"recipients": recipients,
                     "excluded_roles": routing.get("excluded_roles") or ()},
            sender=sender)
    except UniqueViolation:            # khối transaction() đã tự rollback
        st["dup"] += 1
        return
    st["escalated" if ids_key == "ids" else "cap2_escalated"] += 1
    st["unrouted"] += not routed
    st[ids_key].append(aid)


def escalate(conn, now: datetime, routing: dict | None = None,
             sender=_ENV, *, source: str | None = None,
             dry_run: bool = False, after: int = 0) -> dict:
    """Cảnh báo GỐC quá 2 giờ đồng hồ chưa xác nhận → 1 bản leo thang/cảnh
    báo (mọi nguồn; `source` = chỉ 1 nguồn) → {"escalated", "dup",
    "unrouted", "ids", "cap2_ids", "backlog", "off_hours", ...}. Chạy song
    song: unique index → đếm `dup`. TỒN (quá hạn trước mốc bật) theo
    `backlog.chinh_sach`; cấp 2/ngoài giờ theo routing (v15 P12.2/P12.3).
    `dry_run` → không ghi gì, trả danh sách sẽ làm + 1 trang tồn từ `after`."""
    routing = routing if routing is not None else load_routing()
    if not isinstance(routing, dict):
        routing = {}
    tc = tiers(routing)
    lvl1, _ = _valid_recipients(routing.get("recipients"),
                                routing.get("excluded_roles") or ())
    start = escalation_start(conn, create=not dry_run)
    edge = (start if start is not None else now) - ESCALATE_AFTER
    off = tc["ngoai_gio"] is not None and is_off_hours(tc["ngoai_gio"], now)
    extra = tc["ngoai_gio"]["recipients"] if off else []
    q = {"due": now - ESCALATE_AFTER, "src": source, "edge": edge,
         "lim": ESC_MAX_PER_RUN, "after": max(int(after or 0), 0)}
    rows = conn.execute(_DUE_SQL, q).fetchall()
    c2_rows = []
    if tc["cap2"] is not None:
        c2_rows = conn.execute(_CAP2_SQL, {
            **q, "due2": now - tc["cap2"]["after"],
            "sfx": CAP2_SUFFIX}).fetchall()
    n_back = conn.execute(_BACKLOG_N_SQL, q).fetchone()[0]
    page = conn.execute(_BACKLOG_SQL, {**q, "lim": ESC_MAX_PER_RUN + 1}
                        ).fetchall()
    conn.commit()
    pol = tc["backlog"]["policy"]
    st = {"escalated": 0, "dup": 0, "unrouted": 0, "ids": [],
          "cap2_escalated": 0, "cap2_ids": [], "off_hours": off,
          "start": start, "dry_run": dry_run, "after": q["after"],
          "backlog": {"policy": pol, "total": n_back, "escalated": [],
                      "held": n_back,
                      "page": [r[0] for r in page[:ESC_MAX_PER_RUN]],
                      "next_after": (page[ESC_MAX_PER_RUN - 1][0]
                                     if len(page) > ESC_MAX_PER_RUN
                                     else None)},
          "problems": tc["problems"]}
    room = ESC_MAX_PER_RUN
    todo = rows[:room]
    room -= len(todo)
    c2_todo = c2_rows[:room]
    room -= len(c2_todo)
    back_todo = []
    if pol == "leo_thang_dan" and room > 0:
        back_todo = conn.execute(_BACKLOG_SQL, {**q, "after": 0, "lim": room}
                                 ).fetchall()
        conn.commit()
    if dry_run:
        st["ids"] = [r[0] for r in todo]
        st["cap2_ids"] = [r[0] for r in c2_todo]
        st["backlog"]["escalated"] = [r[0] for r in back_todo]
        st["backlog"]["held"] = n_back - len(back_todo)
        return st
    for aid, src, title, url in todo:
        _raise_esc(conn, st, aid, src, title, url,
                   {"escalation_of": aid, "label": ESC_LABEL,
                    **({"ngoai_gio": True} if off else {})},
                   ESC_PREFIX, _merge(lvl1, extra), routing, sender, "ids")
    for aid, src, title, url in c2_todo:
        _raise_esc(conn, st, aid, src, title, url,
                   {"escalation_of": f"{aid}{CAP2_SUFFIX}",
                    "escalation_root": aid, "level": 2, "label": CAP2_LABEL,
                    **({"ngoai_gio": True} if off else {})},
                   CAP2_PREFIX, _merge(tc["cap2"]["recipients"], extra),
                   routing, sender, "cap2_ids")
    for aid, src, title, url in back_todo:
        n0 = len(st["ids"])
        _raise_esc(conn, st, aid, src, title, url,
                   {"escalation_of": aid, "label": ESC_LABEL, "backlog": True,
                    "backlog_policy": pol,
                    "backlog_quyet_boi": tc["backlog"]["by"],
                    **({"ngoai_gio": True} if off else {})},
                   ESC_PREFIX, _merge(lvl1, extra), routing, sender, "ids")
        if len(st["ids"]) > n0:
            st["backlog"]["escalated"].append(aid)
    st["backlog"]["held"] = n_back - len(st["backlog"]["escalated"])
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
        root = detail.get("escalation_root", detail["escalation_of"])
        return False, (f"#{aid} là bản leo thang — xác nhận id gốc "
                       f"#{root}")
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
    for line in tier_lines(tiers(r)):
        print(line)
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


def _print_tiers(st: dict, routing_lines: bool = False) -> None:
    for p in st["problems"]:
        print(f"[warn] {p}", flush=True)
    b = st["backlog"]
    if b["total"] and b["policy"] is None:
        print(f"[warn] {b['total']} cảnh báo TỒN (quá hạn trước mốc bật leo "
              f"thang) — {BACKLOG_UNSET}; xem: --escalate --dry-run",
              flush=True)
    elif b["total"] and b["policy"] == "khong_leo_thang":
        print(f"[info] {b['total']} cảnh báo tồn không leo thang theo chính "
              "sách khong_leo_thang (vẫn ở --open)", flush=True)
    if routing_lines:
        t = tiers(load_routing())
        for line in tier_lines(t)[1:]:
            if "CHƯA CẤU HÌNH" in line:
                print(line, flush=True)


def _print_preview(st: dict) -> None:
    b = st["backlog"]
    mark = (f"mốc bật leo thang {st['start']:%Y-%m-%d %H:%M %Z}"
            if st["start"] else "CHƯA bật leo thang lần nào — nếu bật bây "
            "giờ, mọi cảnh báo đang quá hạn là TỒN")
    print(f"[dry-run] KHÔNG ghi/gửi gì — {mark}")
    print(f"[dry-run] luồng thường: sẽ leo thang {len(st['ids'])} — "
          f"{st['ids']}" + (" (ngoài giờ: gửi thêm người trực)"
                            if st["off_hours"] else ""))
    print(f"[dry-run] cấp 2: {len(st['cap2_ids'])} — {st['cap2_ids']}")
    print(f"[dry-run] tồn: tổng {b['total']}, chính sách "
          f"{b['policy'] or 'CHƯA QUYẾT'} — lần chạy tới leo thang "
          f"{len(b['escalated'])}: {b['escalated']}")
    print(f"[dry-run] trang tồn (id > {st.get('after', 0)}): {b['page']}")
    if b["next_after"] is not None:
        print(f"[dry-run] trang sau: --escalate --dry-run --after "
              f"{b['next_after']}")
    _print_tiers(st)
    for line in tier_lines(tiers(load_routing())):
        print(line)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.red_alert",
        description="Cảnh báo đỏ — người nhận độc lập, gửi SMTP, xác nhận")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check-routing", action="store_true",
                   help="exit 0 khi có ≥1 người nhận gửi được, 1 khi thiếu")
    g.add_argument("--deliver", action="store_true",
                   help="gửi lại cảnh báo 48 giờ chưa gửi được/chưa xác nhận")
    g.add_argument("--escalate", action="store_true",
                   help="leo thang cảnh báo gốc quá 2 giờ chưa xác nhận")
    g.add_argument("--ack", type=int, metavar="ID",
                   help="xác nhận cảnh báo đỏ gốc (cần --by)")
    g.add_argument("--open", action="store_true",
                   help="liệt kê cảnh báo gốc chưa xác nhận")
    ap.add_argument("--by", help="tên người xác nhận")
    ap.add_argument("--note", default=None)
    ap.add_argument("--dry-run", action="store_true",
                    help="--escalate: xem trước, KHÔNG ghi/gửi gì")
    ap.add_argument("--after", type=int, default=0, metavar="ID",
                    help="--escalate --dry-run: trang tồn tiếp theo (id > ID)")
    args = ap.parse_args(argv)
    if (args.dry_run or args.after) and not args.escalate:
        ap.error("--dry-run/--after chỉ đi với --escalate")
    if args.after and not args.dry_run:
        ap.error("--after chỉ đi với --escalate --dry-run")
    if args.after < 0:
        ap.error("--after phải ≥ 0")
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
        if args.escalate and args.dry_run:
            st = escalate(conn, now, dry_run=True, after=args.after)
            _print_preview(st)
            return 0
        if args.escalate:
            with job_run("pipelines.red_alert.escalate") as jr:
                st = escalate(conn, now)
                b = st["backlog"]
                jr["detail"] = (f"escalated={st['escalated']} dup={st['dup']}"
                                f" unrouted={st['unrouted']}"
                                f" cap2={st['cap2_escalated']}"
                                f" backlog={b['total']}"
                                f" backlog_escalated={len(b['escalated'])}"
                                f" backlog_held={b['held']}")
                jr["ok"] = not st["unrouted"]
            print(f"[done] {jr['detail']} escalated_of={st['ids']}"
                  f" cap2_of={st['cap2_ids']}", flush=True)
            _print_tiers(st, routing_lines=True)
            if st["unrouted"]:
                print(f"[RED-ALERT][FAIL] {st['unrouted']} bản leo thang "
                      f"CHƯA thông báo được ({MISSING} hoặc {NOT_SENT})",
                      flush=True)
                return 1
            return 0
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
