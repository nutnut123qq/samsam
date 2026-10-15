"""v10.1 KD-A9 (WP16) — kịch bản livestream NHÁP. LLM CHỈ viết lời dẫn
từng SKU + hỏi-đáp bình luận (gateway agent `kd_livestream`, cap tháng);
GIỎ + GIÁ do CODE dựng từ view `v_promotable` (giá `list` đã duyệt). Bản
nháp vào `content_drafts` (pending) — người duyệt qua `pipelines.store`;
module KHÔNG có đường duyệt/đăng/lên sóng (tài khoản live = external-dep).

Contract `write_script(conn, channel, cart, session_day, brief,
dry_run=False)` → {"ok", "refused", "text", "cart", "dropped", "guardrail",
"draft_id", "llm_calls"}:
  - Từ chối TRƯỚC LLM (0 lời gọi, 0 ghi DB), theo thứ tự: kenh_la |
    gio_hang (rỗng/quá max_cart/trùng) | brief (rỗng/quá dài) | sku_la |
    ruou (category alcohol hoặc tên/brief nhắc rượu) | khong_promotable
    (SKU không có trong v_promotable của kênh — vd TPBVSK chưa XNQC, giá
    chưa duyệt) | vuot_tran_phien (đã có ≥ max_sessions_per_week nháp
    livestream chưa bị từ chối cùng tuần ISO của ngày phiên).
  - Sau LLM: câu chạm số/giá/quy cách (`content._spec_like`) → BỎ
    (`so_lieu`); câu nhắc rượu → BỎ (`ruou`); câu hỏi sức khỏe
    (`is_health_question`) → câu đáp = `data/channels.json`
    templates.health NGUYÊN VĂN (LLM không trả lời sức khỏe).
  - Giỏ có TPBVSK → CODE nối câu khuyến cáo chuẩn; CODE nối nhãn QC + nhãn
    AI. Toàn văn qua `check_publish(content_type='livestream_script',
    is_ai=True, readiness=DB)` → vi phạm → 1 lượt sửa có feedback → còn →
    `kich_ban` (0 draft). Đạt → `store.save_draft` (created_by
    agent:kd_a9, prompt_version/sha) — status pending.
  - Ngày phiên ghi DÒNG ĐẦU `brief` của draft: `phien: YYYY-MM-DD kenh: K`
    (đếm trần phiên bằng regex — không thêm cột).

CLI: python -m agents.kd_live --channel tiktok --cart sku1,sku2 --day
2026-10-20 --brief "..." [--dry-run]
Exit: 0 ok · 1 từ chối/kịch bản vi phạm/lỗi LLM · 2 tham số sai / DB down.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from contextlib import suppress
from datetime import date
from pathlib import Path

import psycopg

from ingest.lead_store import connect
from pipelines import content, guardrail, kb_filter, store
from pipelines.llm_gateway import chat, is_health_question
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RULES_FILE = ROOT / "data" / "livestream_rules.json"
CHANNELS_FILE = ROOT / "data" / "channels.json"
TEMPLATE = "livestream_script"
CONTENT_TYPE = "livestream_script"
AGENT = "kd_livestream"
CREATED_BY = "agent:kd_a9"
MAX_BRIEF = 500
MAX_LINE = 300
MAX_LINES = 12
CHANNEL_NAME = {"shopee": "Shopee Live", "tiktok": "TikTok Live",
                "facebook": "Facebook Live"}
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
_PHIEN_RE = re.compile(r"^phien: ([0-9]{4}-[0-9]{2}-[0-9]{2}) kenh: [a-z]+")
_SKU_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def load_rules(path: Path = RULES_FILE) -> dict:
    """Luật đã validate → dict; lỗi → ValueError (fail-closed)."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        rules = {"channels": [str(c) for c in doc["channels"]],
                 "max_sessions_per_week": doc["max_sessions_per_week"],
                 "max_cart": doc["max_cart"],
                 "duration_min": doc["duration_min"]}
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ValueError(f"livestream_rules.json không dùng được "
                         f"({type(e).__name__})") from e
    for k, hi in (("max_sessions_per_week", 14), ("max_cart", 30),
                  ("duration_min", 600)):
        v = rules[k]
        if not (isinstance(v, int) and not isinstance(v, bool)
                and 1 <= v <= hi):
            raise ValueError(f"livestream_rules.json: {k} phải 1..{hi}")
    if not rules["channels"]:
        raise ValueError("livestream_rules.json: channels rỗng")
    return rules


def health_template() -> str:
    doc = json.loads(CHANNELS_FILE.read_bytes().decode("utf-8"))
    t = doc["templates"]["health"]
    if not (isinstance(t, str) and t.strip()):
        raise ValueError("channels.json thiếu templates.health")
    return t


def vnd(n: int) -> str:
    return f"{int(n):,}".replace(",", ".") + " đ"


def iso_week(d: date) -> tuple[int, int]:
    y, w, _ = d.isocalendar()
    return y, w


# ------------------------------------------------------------ đọc DB

def load_ctx(conn, channel: str, session_day: date) -> dict:
    """CHỈ SELECT → ngữ cảnh cho `generate`: skus {key: {name, category}},
    promotable {key: giá} (kênh), n_sessions (nháp livestream chưa
    rejected cùng tuần ISO ngày phiên), readiness (view)."""
    skus = {k: {"name": n, "category": c} for k, n, c in conn.execute(
        "select sku_key, name, category from sku_master")}
    prom = {k: p for k, p in conn.execute(
        "select sku_key, price_vnd from v_promotable where channel = %s",
        (channel,))}
    wk = iso_week(session_day)
    n = 0
    for (brief,) in conn.execute(
            "select brief from content_drafts where content_type = %s and"
            " status <> 'rejected'", (CONTENT_TYPE,)):
        m = _PHIEN_RE.match(brief or "")
        if m:
            with suppress(ValueError):
                n += iso_week(date.fromisoformat(m.group(1))) == wk
    return {"skus": skus, "promotable": prom, "n_sessions": n,
            "readiness": store.readiness_from_db(conn)}


# ------------------------------------------------------------ luật (THUẦN)

def precheck(channel, cart, brief, ctx: dict, rules: dict) -> dict | None:
    """Từ chối rẻ TRƯỚC LLM → {"code", "reason"} | None."""
    if channel not in rules["channels"]:
        return {"code": "kenh_la", "reason": f"kênh {str(channel)[:30]!r}"
                f" ngoài {rules['channels']}"}
    if not isinstance(cart, list) or not cart \
            or len(cart) > rules["max_cart"] or len(set(cart)) != len(cart):
        return {"code": "gio_hang", "reason": f"giỏ phải 1..{rules['max_cart']}"
                " SKU, không trùng"}
    b = (brief or "").strip()
    if not b or len(b) > MAX_BRIEF:
        return {"code": "brief", "reason": f"brief rỗng hoặc dài hơn"
                f" {MAX_BRIEF} ký tự"}
    skus = ctx["skus"]
    for k in cart:
        if not (isinstance(k, str) and k in skus):
            return {"code": "sku_la", "reason": "SKU không có trong golden"}
    if kb_filter.is_alcohol(b) or any(
            skus[k]["category"] == "alcohol"
            or kb_filter.is_alcohol(skus[k]["name"]) for k in cart):
        return {"code": "ruou", "reason": "giỏ/brief có rượu — cấm quảng cáo"
                "/khuyến mại rượu (Luật 44/2019)"}
    bad = [k for k in cart if k not in ctx["promotable"]]
    if bad:
        return {"code": "khong_promotable",
                "reason": f"{', '.join(bad)} chưa được quảng bá trên kênh"
                f" {channel} (readiness/giá chưa duyệt)"}
    if ctx["n_sessions"] >= rules["max_sessions_per_week"]:
        return {"code": "vuot_tran_phien",
                "reason": f"tuần này đã có {ctx['n_sessions']} phiên ≥ trần"
                f" {rules['max_sessions_per_week']}"}
    return None


def _parse(text) -> dict | None:
    if not isinstance(text, str):
        return None
    s = text.strip()
    m = _FENCE_RE.fullmatch(s)
    try:
        obj = json.loads(m.group(1) if m else s)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _lines(v) -> list[str]:
    return [x for x in v if isinstance(x, str)][:MAX_LINES] \
        if isinstance(v, list) else []


def _keep(s, dropped: list) -> str | None:
    """Câu LLM sau khi làm sạch → giữ | None (đã ghi `dropped`). Không phải
    chuỗi → bỏ; bỏ ký tự điều khiển/vô hình Cc/Cf (escape terminal khi CLI
    in kịch bản, ZWSP lách lọc — rà OWASP A03 v10.1)."""
    if not isinstance(s, str):
        return None
    s = "".join(c for c in unicodedata.normalize("NFC", s)
                if c.isspace() or unicodedata.category(c) not in ("Cc", "Cf"))
    t = " ".join(s.split())[:MAX_LINE]
    if not t:
        return None
    if content._spec_like(t):
        dropped.append({"text": t, "ly_do": "so_lieu"})
        return None
    if kb_filter.is_alcohol(t):
        dropped.append({"text": t, "ly_do": "ruou"})
        return None
    return t


def build_text(obj: dict, channel, cart, session_day, ctx,
               health: str) -> tuple[str, list[dict]]:
    """JSON LLM → toàn văn kịch bản (CODE dựng giỏ/giá/khuyến cáo/nhãn)."""
    canon, ai, ad = content._publish_texts()
    dropped: list = []
    by_sku: dict = {}
    for it in obj.get("san_pham") if isinstance(obj.get("san_pham"),
                                                list) else []:
        if isinstance(it, dict) and it.get("sku") in cart:
            by_sku.setdefault(it["sku"], _lines(it.get("loi_dan")))
    L = [(f"Kịch bản livestream {CHANNEL_NAME.get(channel, channel)} —"
          f" phiên {session_day:%d/%m/%Y} (NHÁP)"), "", "[Mở đầu]"]
    L += [t for t in (_keep(s, dropped) for s in _lines(obj.get("mo_dau")))
          if t]
    L += ["", "[Giỏ hàng]"]
    for i, k in enumerate(cart, 1):
        L.append(f"{i}. {ctx['skus'][k]['name']} — Giá:"
                 f" {vnd(ctx['promotable'][k])}")
        L += [f"   {t}" for t in (_keep(s, dropped)
                                  for s in by_sku.get(k, [])) if t]
    qa = [x for x in obj.get("hoi_dap") if isinstance(x, dict)][:MAX_LINES] \
        if isinstance(obj.get("hoi_dap"), list) else []
    L += ["", "[Hỏi đáp bình luận]"]
    for x in qa:
        q = _keep(x.get("hoi") or "", dropped)
        if not q:
            continue
        if is_health_question(q):
            a = health
        else:
            a = _keep(x.get("dap") or "", dropped)
            if not a:
                continue
        L += [f"Hỏi: {q}", f"Đáp: {a}"]
    L += ["", "[Kết]"]
    L += [t for t in (_keep(s, dropped) for s in _lines(obj.get("ket"))) if t]
    L.append("")
    if canon and any(ctx["skus"][k]["category"] == "tpbvsk" for k in cart):
        L.append(f"{canon}.")
    L += [x for x in (ad[:1] + ai[:1])]
    return "\n".join(L), dropped


def _messages(tmpl: str, channel, cart, brief, ctx, rules) -> list[dict]:
    products = "; ".join(f"{ctx['skus'][k]['name']} (mã {k})" for k in cart)
    fmt = (tmpl.replace("{channel}", CHANNEL_NAME.get(channel, channel))
           .replace("{duration_min}", str(rules["duration_min"]))
           .replace("{products}", products)
           .replace("{brief}", " ".join(brief.split())))   # brief CUỐI
    return [{"role": "system",
             "content": content._system(fmt, price_rule=False)},
            {"role": "user", "content": "Trả về DUY NHẤT JSON đúng mẫu."}]


def _msgs_sha(messages) -> str:
    return hashlib.sha256(json.dumps(messages, ensure_ascii=False,
                                     sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def generate(channel, cart, session_day: date, brief, ctx: dict,
             rules: dict | None = None) -> dict:
    """Không ghi DB. → {"ok", "refused", "error", "text", "cart",
    "dropped", "guardrail", "llm_calls", "prompt_version",
    "prompt_sha256"}."""
    rules = rules or load_rules()
    out = {"ok": False, "refused": None, "error": None, "text": "",
           "cart": [], "dropped": [], "guardrail": None, "llm_calls": 0,
           "prompt_version": None, "prompt_sha256": None}

    def refuse(code, reason, g=None, **kw):
        ref = {"code": code, "reason": reason}
        return {**out, **kw, "refused": ref,
                "guardrail": g if g is not None
                else content._refused_guardrail(ref)}

    ref = precheck(channel, cart, brief, ctx, rules)
    if ref:
        return refuse(ref["code"], ref["reason"])
    try:
        tmpl, ver, _tsha = content.load_template(TEMPLATE)
        health = health_template()
    except (OSError, ValueError, KeyError, TypeError) as e:
        return refuse("config", str(e)[:200])
    cart_out = [{"sku_key": k, "name": ctx["skus"][k]["name"],
                 "price_vnd": ctx["promotable"][k]} for k in cart]
    messages = _messages(tmpl, channel, cart, brief, ctx, rules)
    for calls in (1, 2):    # bản nháp + 1 lượt sửa có feedback
        sha = _msgs_sha(messages)
        try:
            resp = chat(AGENT, messages, temperature=0.3, max_tokens=1200)
            raw = resp.choices[0].message.content
        except Exception as e:  # noqa: BLE001 — gateway fail-closed
            return {**out, "llm_calls": calls,
                    "error": f"llm: {type(e).__name__}: {str(e)[:160]}"}
        state = {"llm_calls": calls, "prompt_version": ver,
                 "prompt_sha256": sha, "cart": cart_out}
        obj = _parse(raw)
        if obj is None:
            return refuse("kich_ban", "LLM trả sai mẫu JSON", **state)
        text, dropped = build_text(obj, channel, cart, session_day, ctx,
                                   health)
        g = guardrail.check_publish(text, channel=channel,
                                    content_type=CONTENT_TYPE, is_ai=True,
                                    readiness=ctx.get("readiness"))
        state.update(text=text, dropped=dropped)
        if g.get("ok") is True:
            return {**out, **state, "ok": True, "guardrail": g}
        if calls == 2:
            return refuse("kich_ban", "kịch bản vi phạm guardrail sau 1 lượt"
                          " sửa", g, **state)
        messages = messages + [
            {"role": "assistant", "content": str(raw)},
            {"role": "user", "content": content._feedback(g)
             + " Không viết số/giá. Trả lại DUY NHẤT JSON đúng mẫu."}]
    raise AssertionError("unreachable")


def write_script(conn, channel, cart, session_day: date, brief,
                 dry_run: bool = False, rules: dict | None = None) -> dict:
    """`generate` trên ngữ cảnh DB → đạt (và không dry_run) → lưu nháp
    pending. Từ chối trước LLM: 0 lời gọi, 0 ghi DB."""
    rules = rules or load_rules()
    ctx = load_ctx(conn, channel, session_day)
    res = generate(channel, cart, session_day, brief, ctx, rules)
    res["draft_id"] = None
    if res["ok"] and not dry_run:
        head = f"phien: {session_day.isoformat()} kenh: {channel}"
        res["draft_id"] = store.save_draft(
            conn, f"{head}\n{' '.join(brief.split())}", channel, res["text"],
            res["guardrail"], store.SOURCE_CLI, created_by=CREATED_BY,
            content_type=CONTENT_TYPE, is_ai=True,
            prompt_version=res["prompt_version"],
            prompt_sha256=res["prompt_sha256"])
    else:
        conn.rollback()     # đóng tx đọc (conn chia sẻ)
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.kd_live",
        description="KD-A9 — nháp kịch bản livestream (LLM lời dẫn, giỏ + "
                    "giá do code) → content_drafts pending; không lên sóng")
    ap.add_argument("--channel", required=True)
    ap.add_argument("--cart", required=True, help="sku1,sku2,... (thứ tự)")
    ap.add_argument("--day", required=True, help="ngày phiên YYYY-MM-DD")
    ap.add_argument("--brief", required=True)
    ap.add_argument("--dry-run", action="store_true",
                    help="không lưu nháp")
    args = ap.parse_args(argv)
    try:
        day = date.fromisoformat(args.day)
    except ValueError:
        ap.error("--day phải YYYY-MM-DD")
    cart = [s.strip() for s in args.cart.split(",") if s.strip()]
    if not all(_SKU_RE.fullmatch(s) for s in cart):
        ap.error("--cart chỉ gồm mã SKU [a-z0-9-]")
    try:
        rules = load_rules()
    except ValueError as e:
        print(f"[error] cấu hình lỗi: {e}", file=sys.stderr)
        return 1
    if args.channel not in rules["channels"]:
        ap.error(f"--channel phải thuộc {rules['channels']}")
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        res = write_script(conn, args.channel, cart, day, args.brief,
                           dry_run=args.dry_run, rules=rules)
    except (psycopg.Error, ValueError) as e:
        msg = _db_msg(e) if isinstance(e, psycopg.Error) else str(e)
        print(f"[error] {type(e).__name__}: {msg[:300]}", file=sys.stderr)
        return 1
    finally:
        with suppress(Exception):
            conn.close()
    if res["error"]:
        print(f"[error] {res['error']}", file=sys.stderr)
        return 1
    if not res["ok"]:
        r = res["refused"]
        print(f"[refuse] {r['code']}: {r['reason']} (LLM {res['llm_calls']}"
              " lời gọi)")
        return 1
    print(res["text"])
    print(f"[ok] bỏ {len(res['dropped'])} câu LLM (số/giá/rượu) · "
          + (f"nháp #{res['draft_id']} pending — chờ người duyệt"
             if res["draft_id"] else "dry-run, KHÔNG lưu")
          + f" · model {os.environ.get('OR_CHAT_MODEL') or 'mặc định'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
