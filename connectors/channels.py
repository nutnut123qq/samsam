"""v5.1 (WP07, KD-A1) — lớp kênh CSKH chung: Zalo, Messenger, Shopee, TikTok.

Module THUẦN: không tự gửi gì ra ngoài (không httpx/requests/urllib/socket,
không gọi chat/embed trực tiếp — `api.rag.answer` import lười trong hàm).
Việc gửi là của adapter kênh (`connectors/zalo.py`, `connectors/messenger.py`);
kênh sàn KHÔNG có adapter — chỉ CLI gợi ý để Quản lý MXH DÁN TAY trên Seller
Center (chưa có API chat sàn — P2).

Luồng 1 tin: `normalize` (kênh, user_hash có muối, text, ts) → `pre_route`
(luật trước LLM, cùng cho 4 kênh: (1) câu đồng ý/rút đồng ý khớp TRỌN tin —
chỉ zalo/messenger; (2) `is_alcohol` → template rượu cố định; (3)
`is_health_question` → template sức khỏe; rượu đứng trước sức khỏe) → nếu
không route: `api.rag.answer` → `format_reply` theo kênh (chat: y hệt Zalo cũ
+ nguồn; sàn: không nguồn, có vi phạm `san_violations` hoặc guardrail chặn →
thay CẢ câu bằng `san_fallback`, không cắt-gọt).

Ghi DB (chỉ kênh chat, chạy SAU khi đã gửi trả lời, DB down → [warn], không
raise): `record_handoff` → `pipelines.director.submit` loại `cskh_handoff`
khối sales (payload cố định, KHÔNG câu hỏi/câu trả lời/user_id);
`record_consent` → bảng append-only `chat_consents` (chỉ khi khách gõ đồng ý
TƯỜNG MINH — không suy diễn). `user_hash` = HMAC-SHA256(muối env
`CHANNEL_HASH_SALT`, "kênh:user_id")[:32]; thiếu muối → bỏ qua MỌI ghi
(fail-closed: không có dòng = chưa đồng ý), không fallback hash không muối.

Văn bản khách thấy nằm ở `data/channels.json` (NHÁP chờ Pháp chế).

Chạy:
  echo "<tin buyer>" | python -m connectors.channels --suggest shopee --by "<tên MXH>"
  python -m connectors.channels --eval-real --limit 8   # gọi LLM thật, vài cent
Exit: 0 ok · 1 eval thật FAIL/thiếu key · 2 tham số sai/stdin rỗng.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path
from typing import NamedTuple

from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import _strip_accents, is_health_question
from pipelines.pii import _PII_RE, _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "data" / "channels.json"
SUITE_PATH = ROOT / "data" / "eval" / "suites" / "kd_a1.json"

CHANNELS = ("zalo", "messenger", "shopee", "tiktok")
CHAT_CHANNELS = ("zalo", "messenger")
SAN_CHANNELS = ("shopee", "tiktok")
MAX_INBOUND = 4000
MAX_STDIN = 64_000
MAX_BY_LEN = 100          # như ingest/golden_store.py
SALT_ENV = "CHANNEL_HASH_SALT"
MIN_SALT_LEN = 16         # muối ngắn = dò ngược được → coi như thiếu
AGENT_ID = "agent:kd_a1"
HANDOFF_TYPE = "cskh_handoff"
# Mã lý do → nhãn ghi trong payload/title. KHÔNG ghi chữ 'alcohol'/'rượu':
# guardrail.check soi luật rượu trên payload → mục không đóng được.
HANDOFF_REASONS = {"alcohol": "san_pham_han_che", "health": "suc_khoe",
                   "no_data": "thieu_du_lieu", "guardrail": "kiem_duyet"}
CONSENT_ACTIONS = ("prompted", "granted", "withdrawn")
TEMPLATE_KEYS = ("alcohol", "alcohol_san", "health", "health_san",
                 "consent_prompt", "consent_ack", "consent_withdrawn_ack",
                 "consent_withdrawn_fail", "san_fallback", "san_handoff")
EVAL_REAL_KINDS = ("fact", "fact_san", "trap_san")
EVAL_REAL_BUDGET_USD = 0.05
CSKH_EXPECT_KEYS = {"route", "handoff", "text_regex", "forbid_regex",
                    "max_llm_calls"}

# Đồng ý (sau bỏ dấu + casefold + bỏ dấu câu + bỏ từ lễ/xưng hô `_FILLER`)
# phải còn ĐÚNG "dong y". "ok", "ừ", "đồng ý không?", "tôi đồng ý mua 2
# hộp" → KHÔNG phải đồng ý tư vấn. Rút đồng ý nới hơn (rủi ro lệch: lọt 1
# câu rút = xử lý trái ý khách; rút nhầm chỉ tạm dừng LLM): tin ngắn
# ≤ `_WITHDRAW_MAX_WORDS` từ có phủ định/"rút"/"hủy" ĐỨNG TRƯỚC "dong y",
# không kết bằng từ hỏi ("... đồng ý không?").
_FILLER = {"a", "da", "vang", "nhe", "nha", "minh", "toi", "em", "con",
           "chau", "roi"}
_NEG = {"khong", "ko", "k", "kg", "khg", "kh", "hong", "hok", "khum"}
_WITHDRAW_VERBS = {"rut", "huy"}
_WITHDRAW_MAX_WORDS = 6

# --- Luật kênh sàn (chính sách Shopee/TikTok: không dẫn khách ra ngoài) ---
_URL_RE = re.compile(r"https?://|\bwww\.", re.IGNORECASE)
# `(?<![\w-])` (không `\b`): chỉ bắt đầu ở ĐẦU 1 cụm [\w-] — `\b` cho
# phép bắt đầu sau mỗi '-' → "a-a-a-..." backtrack bậc hai (probe v5.1).
_DOMAIN_RE = re.compile(
    r"(?<![\w-])[\w-]+\.(?:com|vn|net|org|me|info|shop|store|online|site|io)"
    r"\b", re.IGNORECASE)
# Tổng đài 1800/1900 (không bắt đầu bằng 0 nên `_PII_RE` không bắt).
_HOTLINE_RE = re.compile(r"(?<!\d)1[89]00(?:[ .-]?\d){4,6}(?!\d)")
_ZALO_RE = re.compile(r"(?<!\w)zalo(?!\w)")
_FB_RE = re.compile(r"(?<!\w)(?:facebook|fanpage|messenger|inbox page)(?!\w)")
# Địa chỉ cửa hàng (so trên bản bỏ dấu). "địa chỉ" trần KHÔNG tính — câu
# giao hàng "địa chỉ nhận hàng" là hợp lệ trên sàn (chống lọc thừa).
_ADDR_RE = re.compile(
    r"(?<!\w)(?:showroom|cua hang tai|ghe cua hang"
    r"|dia chi\s*(?::|cua hang|showroom|cong ty|van phong|shop))")


class ChannelConfigError(ValueError):
    """data/channels.json thiếu/hỏng/sai cấu trúc."""


@dataclass(frozen=True)
class Inbound:
    channel: str
    user_hash: str | None
    text: str
    ts: str


class Route(NamedTuple):
    kind: str            # consent_granted|consent_withdrawn|alcohol|health
    text: str
    handoff: str | None  # None|"alcohol"|"health"


class Gate(NamedTuple):
    prefix: str          # tiền tố câu chào + chính sách ("" = không)
    block: bool          # True = KHÔNG gọi answer(), chỉ gửi prefix
    prompted: bool       # True = ghi dòng 'prompted' sau khi gửi


_cfg_cache: tuple | None = None   # (path, mtime_ns, cfg)


def reset_cache() -> None:
    global _cfg_cache
    _cfg_cache = None


def _warn(msg: str) -> None:
    print(f"[warn] channels: {msg}", flush=True)


def load_config(path: Path | None = None) -> dict:
    """Đọc + validate `data/channels.json` (cache theo mtime). Lỗi →
    ChannelConfigError nêu rõ key."""
    global _cfg_cache
    p = Path(path or CONFIG_PATH)
    try:
        mtime = p.stat().st_mtime_ns
    except OSError as e:
        raise ChannelConfigError(f"không có {p.name}") from e
    if _cfg_cache and _cfg_cache[0] == p and _cfg_cache[1] == mtime:
        return _cfg_cache[2]
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise ChannelConfigError(f"{p.name} hỏng: {type(e).__name__}") from e
    if not isinstance(cfg, dict):
        raise ChannelConfigError(f"{p.name}: không phải object JSON")
    for k in ("policy_url", "policy_version"):
        if not isinstance(cfg.get(k), str) or not cfg[k].strip():
            raise ChannelConfigError(f"{p.name}: thiếu '{k}'")
    if not isinstance(cfg.get("require_consent_for_llm"), bool):
        raise ChannelConfigError(f"{p.name}: 'require_consent_for_llm' phải"
                                 " true/false")
    tpl = cfg.get("templates")
    if not isinstance(tpl, dict):
        raise ChannelConfigError(f"{p.name}: thiếu 'templates'")
    for k in TEMPLATE_KEYS:
        if not isinstance(tpl.get(k), str) or not tpl[k].strip():
            raise ChannelConfigError(f"{p.name}: thiếu template '{k}'")
    if "{policy_url}" not in tpl["consent_prompt"]:
        raise ChannelConfigError(f"{p.name}: consent_prompt phải chứa"
                                 " {policy_url}")
    # replace (không str.format): ngoặc nhọn khác trong text không crash.
    cfg = {**cfg, "templates": {
        **tpl, "consent_prompt": tpl["consent_prompt"].replace(
            "{policy_url}", cfg["policy_url"].strip())}}
    _cfg_cache = (p, mtime, cfg)
    return cfg


def template(key: str) -> str:
    return load_config()["templates"][key]


def _salt() -> str:
    s = os.environ.get(SALT_ENV, "").strip()
    return s if len(s) >= MIN_SALT_LEN else ""


def user_hash(channel: str, user_id: str) -> str | None:
    """HMAC-SHA256(muối, "kênh:user_id") 32 hex. Thiếu/ngắn muối → None."""
    salt = _salt()
    if not salt:
        return None
    return hmac.new(salt.encode(), f"{channel}:{user_id}".encode(),
                    hashlib.sha256).hexdigest()[:32]


def _iso(ts: datetime | None) -> str:
    ts = ts or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize(channel: str, user_id, text, ts: datetime | None = None
              ) -> Inbound:
    """Chuẩn hóa tin vào. Kênh lạ → ValueError; text NFC + strip + cắt
    MAX_INBOUND ký tự; ts ISO UTC."""
    if channel not in CHANNELS:
        raise ValueError(f"kênh '{channel}' không hỗ trợ — {CHANNELS}")
    t = unicodedata.normalize("NFC", text if isinstance(text, str)
                              else "").strip()[:MAX_INBOUND]
    return Inbound(channel, user_hash(channel, str(user_id)), t, _iso(ts))


def parse_consent(text) -> str | None:
    """'granted' | 'withdrawn' | None — đồng ý phải khớp TRỌN "đồng ý"
    (trừ từ lễ/xưng hô); rút đồng ý: tin ngắn có phủ định/rút/hủy trước
    "đồng ý", không phải câu hỏi (xem `_FILLER`/`_NEG`)."""
    if not isinstance(text, str):
        return None
    t = _strip_accents(unicodedata.normalize("NFC", text).casefold())
    words = [w for w in re.sub(r"[^\w\s]|_", " ", t).split()
             if w not in _FILLER]
    if words == ["dong", "y"]:
        return "granted"
    if not 3 <= len(words) <= _WITHDRAW_MAX_WORDS or words[-1] in _NEG:
        return None
    for i in range(1, len(words) - 1):
        if words[i:i + 2] == ["dong", "y"] and any(
                w in _NEG or w in _WITHDRAW_VERBS for w in words[:i]):
            return "withdrawn"
    return None


def pre_route(inb: Inbound) -> Route | None:
    """Luật trước LLM (thứ tự cố định). None = đi tiếp answer()."""
    san = inb.channel in SAN_CHANNELS
    if not san:
        c = parse_consent(inb.text)
        if c == "granted":
            return Route("consent_granted", template("consent_ack"), None)
        if c == "withdrawn":
            return Route("consent_withdrawn",
                         template("consent_withdrawn_ack"), None)
    if is_alcohol(inb.text):
        return Route("alcohol", template("alcohol_san" if san
                                         else "alcohol"), "alcohol")
    if is_health_question(inb.text):
        return Route("health", template("health_san" if san else "health"),
                     "health")
    return None


def san_violations(text) -> list[str]:
    """Mã vi phạm chính sách sàn trong `text` (rỗng = sạch): url, domain,
    phone, email, zalo, facebook, dia_chi."""
    if not isinstance(text, str) or not text:
        return []
    t = unicodedata.normalize("NFC", text)
    plain = _strip_accents(t.casefold())
    out = []
    if _URL_RE.search(t):
        out.append("url")
    if _DOMAIN_RE.search(t):
        out.append("domain")
    # SĐT: tái dùng `_mask_pii` (có bóc ngoặc — "(0235) 3699 899",
    # "(+84) 905 ..." mà `_PII_RE` thô bỏ lọt); email bỏ trước để tách mã.
    # So "***" (không so text != text: _mask_pii đổi "(2)" → " 2 ").
    emails = [m for m in _PII_RE.finditer(t) if "@" in m.group(0)]
    rest = _PII_RE.sub(lambda m: " " if "@" in m.group(0) else m.group(0),
                       t.replace("*", " "))
    if "***" in _mask_pii(rest) or _HOTLINE_RE.search(t):
        out.append("phone")
    if emails:
        out.append("email")
    if _ZALO_RE.search(plain):
        out.append("zalo")
    if _FB_RE.search(plain):
        out.append("facebook")
    if _ADDR_RE.search(plain):
        out.append("dia_chi")
    return out


def format_reply(channel: str, res: dict) -> tuple[str, dict]:
    """Kết quả answer() → (text gửi khách, meta). Guardrail chạy ĐÚNG 1
    lần trên câu trả lời gốc (trước khi nối nguồn — slug URL không flag
    oan). meta: guardrail_ok, handoff (None|alcohol|health|no_data|
    guardrail), blocked (mã vi phạm sàn)."""
    from api.rag import NO_DATA
    from pipelines import guardrail

    if channel not in CHANNELS:
        raise ValueError(f"kênh '{channel}' không hỗ trợ — {CHANNELS}")
    san = channel in SAN_CHANNELS
    raw = res["answer"]
    sources = res.get("sources") or []
    ok = guardrail.check(raw)["ok"]
    meta = {"guardrail_ok": ok, "handoff": None, "blocked": []}
    hand = res.get("handoff")
    if hand in ("alcohol", "health"):
        # Lớp 2: answer() tự nhận ra rượu/sức khỏe (vd câu rewrite theo
        # history) → vẫn template cố định, không HANDOFF_TEXT chung.
        meta["handoff"] = hand
        return template(f"{hand}_san" if san else hand), meta
    if not ok:
        meta.update(handoff="guardrail", blocked=["guardrail"])
        if san:
            return template("san_fallback"), meta
        from connectors.zalo import FALLBACK
        return FALLBACK, meta
    if NO_DATA in raw:
        meta["handoff"] = "no_data"
        if san:
            return template("san_handoff"), meta
        from connectors.zalo import HANDOFF_TEXT
        return HANDOFF_TEXT, meta
    if san:
        v = san_violations(raw)
        if v:
            meta["blocked"] = v
            return template("san_fallback"), meta
        return raw, meta
    return (raw + "\nNguồn: " + sources[0]) if sources else raw, meta


# --- DB: consent + handoff (chỉ kênh chat) -----------------------------------

def _connect():
    """lead_store.connect (connect_timeout) — None khi thiếu DSN/host chết."""
    from ingest.lead_store import connect
    return connect()


def _ref(msg_id) -> str | None:
    return (hashlib.sha256(str(msg_id).encode("utf-8")).hexdigest()[:16]
            if msg_id else None)


def consent_state(conn, channel: str, uh: str) -> str:
    """'none' | 'prompted' | 'granted' | 'withdrawn' — dòng mới nhất theo id."""
    row = conn.execute(
        "select action from chat_consents where user_hash = %s and"
        " channel = %s order by id desc limit 1", (uh, channel)).fetchone()
    return row[0] if row else "none"


def _state(inb: Inbound) -> str:
    """consent_state an toàn: thiếu muối / DB down / lỗi → 'unknown'."""
    import psycopg
    if inb.user_hash is None:
        return "unknown"
    conn = _connect()
    if conn is None:
        return "unknown"
    try:
        return consent_state(conn, inb.channel, inb.user_hash)
    except psycopg.Error as e:
        _warn(f"đọc chat_consents lỗi {type(e).__name__}")
        return "unknown"
    finally:
        conn.close()


def consent_gate(inb: Inbound) -> Gate:
    """Quyết tiền tố câu chào/chặn LLM cho tin KHÔNG khớp pre_route.
    Sàn: không consent (F03b). Cờ `require_consent_for_llm` bật → chưa
    granted (kể cả không biết vì DB down/thiếu muối) = chặn (fail-closed).
    Cờ tắt → tin đầu (none) có tiền tố + ghi prompted; không biết → [warn],
    trả lời bình thường không tiền tố. Khách đã RÚT đồng ý (withdrawn) →
    chặn LLM BẤT KỂ cờ (F03a bước 3 "khách rút đồng ý: dừng LLM") — chỉ
    gửi câu chào, tới khi khách nhắn lại "Đồng ý"."""
    if inb.channel not in CHAT_CHANNELS:
        return Gate("", False, False)
    require = load_config()["require_consent_for_llm"]
    state = _state(inb)
    if state == "granted":
        return Gate("", False, False)
    prompt = template("consent_prompt")
    if require or state == "withdrawn":
        return Gate(prompt, True, state == "none")
    if state == "unknown":
        _warn(f"không xác định được đồng ý ({inb.channel}) — thiếu"
              f" {SALT_ENV} hoặc DB down; trả lời không tiền tố")
        return Gate("", False, False)
    if state == "none":
        return Gate(prompt, False, True)
    return Gate("", False, False)


def record_consent(inb: Inbound, action: str, msg_id: str = "",
                   conn=None) -> int | None:
    """Ghi 1 dòng append-only chat_consents → id | None (sàn / thiếu muối /
    DB down — warn, không raise)."""
    import psycopg
    if action not in CONSENT_ACTIONS:
        raise ValueError(f"action '{action}' không hợp lệ — {CONSENT_ACTIONS}")
    if inb.channel not in CHAT_CHANNELS:
        return None
    if inb.user_hash is None:
        _warn(f"thiếu {SALT_ENV} — không ghi đồng ý ({action})")
        return None
    own = conn is None
    conn = _connect() if own else conn
    if conn is None:
        _warn(f"DB down — không ghi đồng ý ({action})")
        return None
    try:
        with conn.transaction():
            rid = conn.execute(
                "insert into chat_consents (user_hash, channel, action,"
                " policy_version, evidence_ref) values (%s, %s, %s, %s, %s)"
                " returning id",
                (inb.user_hash, inb.channel, action,
                 load_config()["policy_version"], _ref(msg_id))).fetchone()[0]
        conn.commit()   # gotcha v2.1: conn chia sẻ → savepoint, commit tường minh
        return rid
    except psycopg.Error as e:
        _warn(f"ghi chat_consents lỗi {type(e).__name__}")
        return None
    finally:
        if own:
            conn.close()


def handoff_payload(inb: Inbound, reason: str, msg_id: str = "",
                    sla_hours: int = 2) -> str:
    """Payload CỐ ĐỊNH — không câu hỏi/câu trả lời/user_id/psid."""
    return (f"kênh={inb.channel}; lý do={HANDOFF_REASONS[reason]}; "
            f"user_hash={inb.user_hash}; msg_ref={_ref(msg_id) or '-'}; "
            f"ts={inb.ts}; sla={int(sla_hours)}h")


def record_handoff(inb: Inbound, reason: str, msg_id: str = "",
                   conn=None) -> int | None:
    """Tạo mục `cskh_handoff` (khối sales) → id | None. Sàn / thiếu muối /
    DB down / đã có mục chờ cùng khách → None + log, không raise."""
    import psycopg

    from pipelines import director
    if reason not in HANDOFF_REASONS:
        raise ValueError(f"lý do '{reason}' không hợp lệ —"
                         f" {sorted(HANDOFF_REASONS)}")
    if inb.channel not in CHAT_CHANNELS:
        return None
    if inb.user_hash is None:
        _warn(f"thiếu {SALT_ENV} — không tạo mục handoff ({reason})")
        return None
    try:
        cfg = director.load_config("sales")
        sla = cfg["object_types"][HANDOFF_TYPE]["sla_hours"]
    except (director.DirectorConfigError, KeyError) as e:
        _warn(f"cấu hình sales thiếu {HANDOFF_TYPE} ({type(e).__name__})")
        return None
    own = conn is None
    conn = _connect() if own else conn
    if conn is None:
        _warn(f"DB down — không tạo mục handoff ({reason})")
        return None
    label = HANDOFF_REASONS[reason]
    try:
        return director.submit(
            conn, "sales", HANDOFF_TYPE,
            object_id=f"{inb.channel}:{inb.user_hash}",
            title=f"Handoff {label} — {inb.channel}",
            payload=handoff_payload(inb, reason, msg_id, sla),
            created_by=AGENT_ID, cfg=cfg)
    except psycopg.errors.UniqueViolation:
        print(f"[handoff] {inb.channel}: đã có mục chờ cho khách"
              f" (uh={inb.user_hash[:12]}) — không nhân đôi", flush=True)
        return None
    except psycopg.Error as e:
        _warn(f"tạo mục handoff lỗi {type(e).__name__}")
        return None
    finally:
        if own:
            conn.close()


# --- Hàm thuần dùng chung CLI sàn + eval ------------------------------------

def respond(channel: str, user_id: str, text: str, *,
            persist: bool = False) -> dict:
    """pre_route → answer() → format_reply, KHÔNG gửi, KHÔNG history.
    persist=True → tạo mục handoff (chỉ kênh chat)."""
    inb = normalize(channel, user_id, text)
    route = pre_route(inb)
    if route is not None:
        out = {"answer": route.text, "route": route.kind,
               "handoff": route.handoff, "blocked": []}
    else:
        from api.rag import answer
        txt, meta = format_reply(channel, answer(inb.text))
        out = {"answer": txt, "route": None, "handoff": meta["handoff"],
               "blocked": meta["blocked"]}
    if persist and out["handoff"]:
        record_handoff(inb, out["handoff"])
    return out


def score_cskh(case: dict, out: dict, *, content: bool = True
               ) -> tuple[bool, str]:
    """Scorer `cskh` (scripts/agent_eval.py): mọi khóa expect phải đạt; ca
    kênh sàn tự kiểm thêm san_violations == []. content=False (lần chạy
    LLM thật): chỉ kiểm route/forbid_regex/vi phạm sàn."""
    exp = case.get("expect") or {}
    ans = str(out.get("answer", ""))
    errs = []
    if "route" in exp and out.get("route") != exp["route"]:
        errs.append(f"route={out.get('route')!r}")
    if content and "handoff" in exp and out.get("handoff") != exp["handoff"]:
        errs.append(f"handoff={out.get('handoff')!r}")
    if content and "text_regex" in exp and not re.search(
            exp["text_regex"], ans):
        errs.append("không khớp text_regex")
    if "forbid_regex" in exp and re.search(exp["forbid_regex"], ans):
        errs.append("khớp forbid_regex")
    if content and "max_llm_calls" in exp and \
            out.get("llm_calls", 0) > exp["max_llm_calls"]:
        errs.append(f"llm_calls={out.get('llm_calls')}")
    if case.get("channel") in SAN_CHANNELS:
        v = san_violations(ans)
        if v:
            errs.append(f"vi phạm sàn {v}")
    return (not errs), "; ".join(errs)


# --- CLI ----------------------------------------------------------------------

def _suggest(channel: str, text: str) -> int:
    try:
        out = respond(channel, "cli:mxh", text)
    except Exception as e:  # noqa: BLE001 — gateway chặn/DB lỗi: vẫn có câu dán
        _warn(f"answer() lỗi {type(e).__name__} — dùng câu chuyển nhân viên")
        out = {"answer": template("san_handoff"), "handoff": "no_data",
               "blocked": []}
    print("[GỢI Ý — NHÁP, MXH đọc/sửa trước khi DÁN TAY trên Seller Center]")
    print(out["answer"])
    if out.get("handoff"):
        print(f"handoff={out['handoff']}")
    if out.get("blocked"):
        print(f"blocked={','.join(out['blocked'])}")
    return 0


def _eval_real(limit: int) -> int:
    """`limit` ca loại fact/fact_san/trap_san (xen kẽ) với answer() THẬT.
    Không ghi eval_runs (không phải gate deploy)."""
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("[external-dep] thiếu OPENROUTER_API_KEY — không chạy thật,"
              " không có kết quả", flush=True)
        return 1
    suite = json.loads(SUITE_PATH.read_bytes().decode("utf-8"))
    # Xen kẽ theo loại (fact, fact_san, trap_san, fact, ...) — `--limit`
    # nhỏ vẫn có ca kênh sàn để kiểm vi phạm trên LLM THẬT.
    pools = [[c for c in suite["cases"] if c.get("kind") == k]
             for k in EVAL_REAL_KINDS]
    cases = [c for grp in zip_longest(*pools) for c in grp
             if c is not None][:limit]
    conn = _connect()
    start = conn.execute("select now()").fetchone()[0] if conn else None
    if conn:
        conn.commit()
    n_fail = 0
    for c in cases:
        try:
            out = respond(c["channel"], f"eval-real:{c['id']}", c["text"])
            ok, detail = score_cskh(c, out, content=False)
        except Exception as e:  # noqa: BLE001 — ca lỗi = FAIL, chạy tiếp
            out, ok, detail = {"answer": ""}, False, type(e).__name__
        n_fail += not ok
        ans = _mask_pii(" ".join(str(out.get("answer", "")).split()))[:160]
        print(f"[{'PASS' if ok else 'FAIL'}] {c['id']} ({c['kind']},"
              f" {c['channel']}) handoff={out.get('handoff')}"
              f"{' — ' + detail if detail else ''} | answer=\"{ans}\"",
              flush=True)
    cost = None
    if conn is not None:
        try:
            cost, n = conn.execute(
                "select coalesce(sum(cost_usd), 0), count(*) from llm_usage"
                " where agent_id = 'chatbot' and ts >= %s", (start,)
            ).fetchone()
            print(f"[cost] llm_usage agent chatbot: {n} lời gọi,"
                  f" cost_usd={float(cost):.6f} (trần {EVAL_REAL_BUDGET_USD})",
                  flush=True)
        finally:
            conn.close()
    else:
        print("[cost] DB down — không đọc được llm_usage", flush=True)
    over = cost is not None and float(cost) > EVAL_REAL_BUDGET_USD
    print(f"[done] eval thật {len(cases) - n_fail}/{len(cases)} PASS"
          f"{' — VƯỢT TRẦN CHI PHÍ' if over else ''}", flush=True)
    return 1 if n_fail or over else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m connectors.channels",
        description="Lớp kênh CSKH — gợi ý trả lời chat sàn (MXH DÁN TAY, "
                    "không gọi API sàn) / chạy eval A1 thật nhỏ")
    ap.add_argument("--suggest", choices=SAN_CHANNELS,
                    help="đọc tin buyer từ STDIN, in câu gợi ý")
    ap.add_argument("--by", help="tên người MXH dùng gợi ý (bắt buộc với"
                                 " --suggest)")
    ap.add_argument("--eval-real", action="store_true",
                    help="chạy ca kd_a1 với answer() THẬT (tốn vài cent)")
    ap.add_argument("--limit", type=int, default=8)
    args = ap.parse_args(argv)
    n_ops = (args.suggest is not None) + args.eval_real
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --suggest KÊNH | --eval-real")
    if args.eval_real:
        if not 1 <= args.limit <= 50:
            ap.error("--limit phải 1..50")
        return _eval_real(args.limit)
    by = (args.by or "").strip()
    if not by or len(by) > MAX_BY_LEN or not by.isprintable():
        ap.error(f"--suggest cần --by <tên MXH> (1..{MAX_BY_LEN} ký tự in"
                 " được)")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    text = sys.stdin.read(MAX_STDIN)
    if not text.strip():
        ap.error("STDIN rỗng — dán tin buyer qua STDIN (không qua argv)")
    return _suggest(args.suggest, text)


if __name__ == "__main__":
    raise SystemExit(main())
