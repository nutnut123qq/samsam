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
  - KHÔNG gửi thật — kênh email/Zalo + người nhận thật (Pháp chế xác nhận)
    là external-dep.

Chạy: `python -m pipelines.red_alert --check-routing` — exit 0 khi có ≥1
người nhận hợp lệ, exit 1 "thiếu người nhận" (config hiện `[]` → exit 1).
"""

import argparse
import json
import sys
from pathlib import Path

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


def raise_alert(conn, source_agent: str, title: str, detail=None,
                routing: dict | None = None) -> tuple[bool, str]:
    """Ghi 1 cảnh báo đỏ → (đã định tuyến?, thông điệp)."""
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
    return True, (f"cảnh báo đỏ #{aid} → {len(names)} người nhận (chưa gửi"
                  " thật — kênh gửi external-dep)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.red_alert",
        description="Cảnh báo đỏ — kiểm cấu hình người nhận độc lập")
    ap.add_argument("--check-routing", action="store_true", required=True,
                    help="exit 0 khi có ≥1 người nhận hợp lệ, 1 khi thiếu")
    ap.parse_args(argv)
    r = load_routing()
    for prob in r["problems"]:
        print(f"[warn] {prob}")
    if not r["recipients"]:
        print(f"[FAIL] {MISSING} — cảnh báo đỏ vẫn được ghi bảng red_alerts "
              "nhưng chưa có ai nhận; Pháp chế xác nhận người nhận rồi điền "
              "data/red_alert_routing.json")
        return 1
    print(f"[ok] {len(r['recipients'])} người nhận độc lập: "
          + ", ".join(f"{x['name']} ({x['role']}/{x['channel']})"
                      for x in r["recipients"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
