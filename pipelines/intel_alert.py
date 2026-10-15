"""v7.1 W71.2 — Red Alert intel (WP09): luật TẤT ĐỊNH quét `intel_items`
→ cảnh báo đỏ + leo thang 2 giờ chưa xác nhận.

Contract:
  - Luật: 4 luật CỨNG trong code (`RULES`), từ khóa trong
    `data/intel_alert_rules.json` (GIẢ ĐỊNH — chờ Pháp chế/Quản lý MXH):
      brand_negative     = nhóm brand ∧ nhóm negative
      regulation         = nhóm regulation ∧ (chủ đề tpbvsk|quang_cao hoặc
                           cờ ruou)
      competitor_penalty = chủ đề doi_thu ∧ nhóm penalty
      legal_doc          = (v10.2 PC-A8 Theo dõi văn bản pháp luật) nguồn
                           tin ∈ `legal_sources` (id nguồn văn bản tầng A
                           trong data/intel_sources.json) ∧ (chủ đề
                           tpbvsk|quang_cao hoặc cờ ruou)
    Khớp cụm qua `crawler.intel.classify` (có dấu/không dấu, "săm lốp" ≠
    "sâm"). `load_rules` fail-closed: file thiếu/rỗng/hỏng/thiếu nhóm/nhóm
    rỗng/lookback lạ/`legal_sources` thiếu-rỗng-sai dạng →
    `IntelAlertConfigError` (KHÔNG quét "0 luật" im lặng).
  - `scan`: tin `fetched_at >= now - lookback_hours` chưa có cảnh báo → mỗi
    tin khớp ĐÚNG 1 `pipelines.red_alert.raise_alert` (người nhận độc lập
    v4.0; thiếu → dòng vẫn ghi + `route_error`, fail-closed). v13.7:
    `unrouted` = cảnh báo CHƯA THÔNG BÁO được (thiếu người nhận HOẶC chưa
    gửi được qua SMTP) → `--run` exit 1. Unique index
    partial chặn báo trùng khi chạy song song → đếm `dup`.
  - `escalate`: cảnh báo gốc quá `ESCALATE_AFTER` (2 giờ, hằng code) chưa
    có dòng `red_alert_acks` và chưa leo thang → 1 cảnh báo leo thang (1 cấp,
    không lặp), cùng routing độc lập v4.0.
  - `ack`: NGƯỜI xác nhận cảnh báo gốc (`red_alert_acks`, append-only,
    `acked_at` do DB đặt). Lỗi đầu vào → (False, msg), không raise. v13.7:
    kiểm riêng intel rồi giao `red_alert.ack` (đường xác nhận CHUNG cho mọi
    cảnh báo đỏ — chặn agent:/system:, chế độ thực chỉ người nhận độc lập).
  - Thời gian: mọi hàm nhận `now` (aware) — không đọc đồng hồ bên trong.
  - Module không tự mở mạng/không gọi LLM: chỉ ghi DB qua
    `red_alert.raise_alert` — v13.7 chính `raise_alert` gửi email (SMTP) tới
    người nhận ĐỘC LẬP đã cấu hình (Pháp chế/BKS), không ai khác.

Chạy:
  python -m pipelines.intel_alert --run
  python -m pipelines.intel_alert --ack ID --by "Tên" [--note ".."]
  python -m pipelines.intel_alert --open
Exit: 0 ok · 1 luật hỏng / DB lỗi / có cảnh báo nhưng thiếu người nhận
(fail-closed) / xác nhận bị từ chối · 2 tham số sai.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from psycopg.errors import UniqueViolation

from crawler.intel import classify
from ingest.lead_store import connect
from pipelines import kb_filter, red_alert
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RULES_FILE = ROOT / "data" / "intel_alert_rules.json"
GROUPS = ("brand", "negative", "regulation", "penalty")
RULES = ("brand_negative", "regulation", "competitor_penalty", "legal_doc")
REG_TOPICS = ("tpbvsk", "quang_cao")
_SRC_ID_RE = re.compile(r"[a-z0-9_-]+")
SOURCE_AGENT = "intel_red_alert"
# Hằng code — KHÔNG đọc từ file (cấu hình không nới được thời hạn leo thang).
ESCALATE_AFTER = timedelta(hours=2)
ALERT_PREFIX = "[BÁO ĐỎ intel] "
ESC_LABEL = "CHƯA XÁC NHẬN"
ESC_PREFIX = f"[LEO THANG — {ESC_LABEL}] "
TITLE_MAX = 200
BY_MAX = 100
NOTE_MAX = 500
BIGINT_MAX = 2 ** 63 - 1

_NEW_SQL = (
    "select i.id, i.title, i.snippet, i.topics, i.flags, i.url, i.source,"
    " i.published_at, i.fetched_at from intel_items i"
    " where i.fetched_at >= %s and not exists (select 1 from red_alerts r"
    " where r.source_agent = %s and r.detail ? 'intel_item_id'"
    " and r.detail->>'intel_item_id' = i.id::text) order by i.id")
_DUE_SQL = (
    "select r.id, r.title, r.detail->>'url' from red_alerts r"
    " where r.source_agent = %s and r.detail ? 'intel_item_id'"
    " and r.ts <= %s"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " and not exists (select 1 from red_alerts e where e.source_agent = %s"
    " and e.detail ? 'escalation_of'"
    " and e.detail->>'escalation_of' = r.id::text) order by r.id")
_OPEN_SQL = (
    "select r.id, r.ts, r.title, r.detail->>'url', r.recipients,"
    " r.route_error, exists (select 1 from red_alerts e"
    " where e.source_agent = %s and e.detail ? 'escalation_of'"
    " and e.detail->>'escalation_of' = r.id::text)"
    " from red_alerts r where r.source_agent = %s"
    " and r.detail ? 'intel_item_id'"
    " and not exists (select 1 from red_alert_acks a where a.alert_id = r.id)"
    " order by r.ts, r.id")


class IntelAlertConfigError(Exception):
    """File luật cảnh báo thiếu/hỏng — fail-closed, không quét."""


def _oneline(s, n: int) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _db_msg(e: Exception) -> str:
    diag = getattr(e, "diag", None)
    return (getattr(diag, "message_primary", None) or type(e).__name__)


def load_rules(path=None) -> dict:
    """→ {"groups": {nhóm: [cụm]}, "lookback_hours": int, "status": str}."""
    p = Path(path) if path is not None else RULES_FILE
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError as e:
        raise IntelAlertConfigError(f"không có file {p.name}") from e
    except (OSError, ValueError) as e:  # rỗng, JSON hỏng, UTF-8 lỗi
        raise IntelAlertConfigError(f"{p.name} hỏng: {type(e).__name__}") \
            from e
    if not isinstance(cfg, dict):
        raise IntelAlertConfigError(f"{p.name}: gốc phải là object")
    groups = cfg.get("groups")
    if not isinstance(groups, dict):
        raise IntelAlertConfigError(f"{p.name}: thiếu 'groups'")
    out = {}
    for g in GROUPS:
        ph = groups.get(g)
        if (not isinstance(ph, list) or not ph
                or not all(isinstance(x, str) and x.strip() for x in ph)):
            raise IntelAlertConfigError(f"{p.name}: groups.{g} thiếu/rỗng "
                                        "hoặc có cụm rỗng")
        out[g] = [x.strip() for x in ph]
    lb = cfg.get("lookback_hours")
    if isinstance(lb, bool) or not isinstance(lb, int) or not 1 <= lb <= 720:
        raise IntelAlertConfigError(f"{p.name}: lookback_hours phải 1..720")
    legal = cfg.get("legal_sources")
    if (not isinstance(legal, list) or not legal
            or not all(isinstance(x, str) and _SRC_ID_RE.fullmatch(x)
                       for x in legal)):
        raise IntelAlertConfigError(f"{p.name}: legal_sources phải là list "
                                    "id nguồn [a-z0-9_-] không rỗng")
    return {"groups": out, "lookback_hours": lb,
            "legal_sources": frozenset(legal),
            "status": str(cfg.get("status") or "")}


def match(item: dict, rules: dict) -> list[str]:
    """THUẦN — tên luật khớp (thứ tự `RULES`). item: title/snippet/topics/
    flags/source như dòng `intel_items` (không mở URL)."""
    hit, flags = classify(item.get("title") or "", item.get("snippet") or "",
                          rules["groups"])
    hit = set(hit)
    topics = set(item.get("topics") or ())
    flags = set(flags) | set(item.get("flags") or ())
    out = []
    if {"brand", "negative"} <= hit:
        out.append("brand_negative")
    if "regulation" in hit and (topics & set(REG_TOPICS) or "ruou" in flags):
        out.append("regulation")
    if "doi_thu" in topics and "penalty" in hit:
        out.append("competitor_penalty")
    if (item.get("source") in rules.get("legal_sources", ())
            and (topics & set(REG_TOPICS) or "ruou" in flags)):
        out.append("legal_doc")
    return out


def _iso(ts):
    return ts.isoformat() if ts is not None else None


def scan(conn, now: datetime, rules: dict | None = None,
         routing: dict | None = None, sender=red_alert._ENV) -> dict:
    """Quét tin mới → cảnh báo đỏ. → {"scanned","alerts","dup","unrouted",
    "ids"}."""
    rules = rules if rules is not None else load_rules()
    since = now - timedelta(hours=rules["lookback_hours"])
    rows = conn.execute(_NEW_SQL, (since, SOURCE_AGENT)).fetchall()
    conn.commit()   # đóng tx đọc (conn chia sẻ)
    st = {"scanned": len(rows), "alerts": 0, "dup": 0, "unrouted": 0,
          "ids": []}
    for iid, title, snip, topics, flags, url, src, pub, fetched in rows:
        hits = match({"title": title, "snippet": snip, "topics": topics,
                      "flags": flags, "source": src}, rules)
        if not hits:
            continue
        try:
            routed, _ = red_alert.raise_alert(
                conn, SOURCE_AGENT,
                ALERT_PREFIX + _oneline(title, TITLE_MAX),
                detail={"intel_item_id": iid, "rules": hits, "url": url,
                        "source": src, "published_at": _iso(pub),
                        "fetched_at": _iso(fetched)},
                routing=routing, sender=sender)
        except UniqueViolation:   # tiến trình khác vừa báo cùng tin
            st["dup"] += 1
            continue
        st["alerts"] += 1
        st["unrouted"] += not routed
        st["ids"].append(conn.execute(
            "select id from red_alerts where source_agent = %s"
            " and detail ? 'intel_item_id'"
            " and detail->>'intel_item_id' = %s", (SOURCE_AGENT, str(iid))
        ).fetchone()[0])
    conn.commit()
    return st


def escalate(conn, now: datetime, routing: dict | None = None,
             sender=red_alert._ENV) -> dict:
    """Cảnh báo gốc quá 2 giờ chưa xác nhận → 1 bản leo thang (1 cấp)."""
    rows = conn.execute(_DUE_SQL, (SOURCE_AGENT, now - ESCALATE_AFTER,
                                   SOURCE_AGENT)).fetchall()
    conn.commit()
    st = {"escalated": 0, "dup": 0, "unrouted": 0, "ids": []}
    for aid, title, url in rows:
        base = (title or "").removeprefix(ALERT_PREFIX)
        try:
            routed, _ = red_alert.raise_alert(
                conn, SOURCE_AGENT,
                ESC_PREFIX + f"#{aid} " + _oneline(base, TITLE_MAX),
                detail={"escalation_of": aid, "url": url,
                        "label": ESC_LABEL},
                routing=routing, sender=sender)
        except UniqueViolation:
            st["dup"] += 1
            continue
        st["escalated"] += 1
        st["unrouted"] += not routed
        st["ids"].append(aid)
    return st


def ack(conn, alert_id, by: str, note: str | None = None
        ) -> tuple[bool, str]:
    """Người xác nhận cảnh báo gốc → (True, msg) | (False, lý do)."""
    by = _mask_pii(" ".join(str(by or "").split())[:BY_MAX + 1])
    if not by:
        return False, "thiếu tên người xác nhận (--by)"
    if len(by) > BY_MAX:
        return False, f"tên người xác nhận dài quá {BY_MAX} ký tự"
    try:
        aid = int(alert_id)
    except (TypeError, ValueError):
        aid = 0
    if not 1 <= aid <= BIGINT_MAX:
        return False, f"id '{_oneline(alert_id, 40)}' không hợp lệ"
    # Cắt TRƯỚC regex mask (chống DoS), cắt lại sau mask.
    note = (_mask_pii(str(note).strip()[:NOTE_MAX * 2])[:NOTE_MAX] or None
            if note else None)
    row = conn.execute("select source_agent, detail from red_alerts"
                       " where id = %s", (aid,)).fetchone()
    if row is None:
        conn.commit()
        return False, f"không tìm thấy cảnh báo #{aid}"
    src, detail = row
    detail = detail if isinstance(detail, dict) else {}
    if src != SOURCE_AGENT:
        conn.commit()
        return False, f"cảnh báo #{aid} không thuộc Red Alert intel"
    if "escalation_of" in detail:
        conn.commit()
        return False, (f"#{aid} là bản leo thang — xác nhận id gốc "
                       f"#{detail['escalation_of']}")
    if "intel_item_id" not in detail:
        conn.commit()
        return False, f"cảnh báo #{aid} không phải cảnh báo gốc intel"
    return red_alert.ack(conn, aid, by, note)


def open_alerts(conn, now: datetime) -> list[dict]:
    """Cảnh báo gốc CHƯA xác nhận (cũ nhất trước), kèm `escalated`, `age_h`."""
    rows = conn.execute(_OPEN_SQL, (SOURCE_AGENT, SOURCE_AGENT)).fetchall()
    conn.commit()
    out = []
    for aid, ts, title, url, rcp, err, esc in rows:
        out.append({"id": aid, "ts": ts, "title": title, "url": url,
                    "recipients": list(rcp or []), "route_error": err,
                    "escalated": bool(esc),
                    "age_h": round((now - ts).total_seconds() / 3600, 1)})
    return out


def _print_open(rows: list[dict]) -> None:
    if not rows:
        print("[open] không có cảnh báo đỏ intel đang mở")
        return
    print(f"[open] {len(rows)} cảnh báo đỏ intel chưa xác nhận:")
    for d in rows:
        esc = " · ĐÃ LEO THANG" if d["escalated"] else ""
        rcp = (", ".join(d["recipients"]) if d["recipients"]
               else f"CHƯA AI NHẬN ({d['route_error'] or '?'})")
        print(f"  #{d['id']} {d['age_h']}h{esc} — "
              f"{_oneline(_mask_pii(d['title'] or ''), 120)} — {rcp}")


def _run(conn, rules: dict, now: datetime) -> tuple[int, str]:
    s = scan(conn, now, rules)
    e = escalate(conn, now)
    summary = (f"scanned={s['scanned']} alerts={s['alerts']} dup={s['dup']}"
               f" escalated={e['escalated']} esc_dup={e['dup']}"
               f" unrouted={s['unrouted'] + e['unrouted']}")
    print(f"[done] {summary} alert_ids={s['ids']} escalated_of={e['ids']}",
          flush=True)
    if rules["status"] == "gia_dinh":
        print("[warn] bộ từ khóa cảnh báo là GIẢ ĐỊNH — chờ Pháp chế/Quản lý"
              " MXH duyệt", flush=True)
    if s["unrouted"] + e["unrouted"]:
        print(f"[RED-ALERT][warn] {s['unrouted'] + e['unrouted']} cảnh báo "
              f"đã ghi nhưng CHƯA thông báo được ({red_alert.MISSING} hoặc "
              f"{red_alert.NOT_SENT}) — fail-closed, exit 1",
              flush=True)
        return 1, summary
    return 0, summary


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.intel_alert",
        description="Cảnh báo đỏ intel — luật tất định, leo thang 2 giờ "
                    "chưa xác nhận (KHÔNG tự gửi/liên hệ ai)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--run", action="store_true",
                   help="quét tin mới + leo thang cảnh báo quá 2 giờ")
    g.add_argument("--ack", type=int, metavar="ID",
                   help="xác nhận cảnh báo gốc (cần --by)")
    g.add_argument("--open", action="store_true",
                   help="liệt kê cảnh báo chưa xác nhận")
    ap.add_argument("--by", help="tên người xác nhận (free-text — SSO là "
                                 "external-dep)")
    ap.add_argument("--note", default=None)
    args = ap.parse_args(argv)
    if args.ack is not None and not (args.by or "").strip():
        ap.error("--ack cần --by <tên người>")
    if args.ack is None and (args.by is not None or args.note is not None):
        ap.error("--by/--note chỉ dùng với --ack")
    rules = None
    if args.run:
        try:
            rules = load_rules()
        except IntelAlertConfigError as e:
            print(f"[err] luật cảnh báo hỏng: {e} — không quét", flush=True)
            return 1
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", flush=True)
        return 1
    now = datetime.now(VN_TZ)
    try:
        if args.open:
            _print_open(open_alerts(conn, now))
            return 0
        if args.ack is not None:
            ok, msg = ack(conn, args.ack, args.by, args.note)
            print(f"[{'done' if ok else 'warn'}] {msg}", flush=True)
            return 0 if ok else 1
        with job_run("pipelines.intel_alert") as jr:
            rc, summary = _run(conn, rules, now)
            jr["ok"] = rc == 0
            jr["detail"] = summary
        return rc
    except kb_filter.KbFilterError as e:
        print(f"[err] bộ lọc rượu hỏng: {e} — không quét", flush=True)
        return 1
    except psycopg.Error as e:
        hint = (" — chạy `python scripts/apply_schema.py`"
                if isinstance(e, psycopg.errors.UndefinedTable) else "")
        print(f"[err] lỗi DB: {_db_msg(e)}{hint}", flush=True)
        return 1
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
