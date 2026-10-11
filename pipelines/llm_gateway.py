"""LLM gateway (v3.1) — cổng DUY NHẤT cho mọi lời gọi LLM/embedding.

Contract:
  chat(agent_id, messages, **kw) -> response chat.completions (openai)
  embed(agent_id, input, **kw)   -> response embeddings (openai)
  is_health_question(text) -> bool

  - `OpenAI(` chỉ được tạo ở `_client()` trong file này (grep gate W31.6).
  - Trước khi gửi: mọi `content` của MỌI message (system/history/user) và
    input embedding (str hoặc list) qua `pipelines.pii._mask_pii` — trừ
    liên hệ CÔNG KHAI của công ty liệt kê ở config `pii_allow`.
  - Privacy routing OpenRouter (cả chat lẫn embeddings — OpenRouter nhận
    cùng `provider` block cho /embeddings): data_collection=deny, zdr=True,
    allow_fallbacks=False, only=<whitelist config>. FAIL-CLOSED: whitelist
    rỗng/config hỏng/lỗi API -> raise GatewayError; client tạo với
    max_retries=0 và chỉ gọi 1 lần — không retry sang provider khác.
  - Kill-switch: agent_id trong config `kill` hoặc env LLM_KILL=a,b ->
    GatewayBlocked trước khi gọi client.
  - Trần chi phí tháng theo agent_id (`monthly_cap_usd`, key "default"):
    tổng `llm_usage.cost_usd` từ đầu tháng THEO GIỜ Asia/Ho_Chi_Minh.
    >=100% -> GatewayBlocked (0 call); >=80% -> cảnh báo rồi vẫn gọi.
    Cap 0 = tắt agent đó.
  - CHÍNH SÁCH DB không đọc được khi check cap: CHO QUA + cảnh báo (nhất
    quán với ghi usage: DB down không làm mất dịch vụ chatbot). Kill-switch
    không phụ thuộc DB nên vẫn chặn được khi DB down.
  - Ghi `llm_usage` 1 dòng/lời gọi (ok và err); ghi lỗi -> cảnh báo, kết
    quả vẫn trả. cost = tokens x giá config; model không có giá -> tính theo
    giá cao nhất đã biết + cảnh báo (không để trần mất tác dụng).

Config: data/llm_gateway.json (không secret, commit được). Env override:
LLM_PROVIDER_ONLY, LLM_KILL, LLM_CAP_DEFAULT_USD. Model mặc định qua
OR_CHAT_MODEL / OR_EMBED_MODEL như trước.
"""

import json
import os
import re
import sys
import unicodedata
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from openai import OpenAI

from pipelines.pii import _PII_RE, _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
CONFIG = ROOT / "data" / "llm_gateway.json"
BASE_URL = "https://openrouter.ai/api/v1"
WARN_RATIO = 0.8
_AGENT_RE = re.compile(r"[a-z0-9_-]{1,64}")
# Tháng tính theo giờ VN: mốc 00:00 ngày 1 local -> timestamptz.
_SPEND_SQL = (
    "select coalesce(sum(cost_usd), 0) from llm_usage where agent_id = %s"
    " and ts >= (date_trunc('month', now() at time zone 'Asia/Ho_Chi_Minh')"
    " at time zone 'Asia/Ho_Chi_Minh')")


class GatewayError(RuntimeError):
    """Lỗi cấu hình/provider — fail-closed, không gọi chỗ khác."""


class GatewayBlocked(GatewayError):
    """Bị chặn bởi kill-switch hoặc trần chi phí."""


def _warn(msg: str) -> None:
    print(f"[llm-gateway] {msg}", flush=True)


def _config() -> dict:
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except FileNotFoundError:
        cfg = {}
    except (OSError, ValueError) as e:
        raise GatewayError(f"config {CONFIG.name} hỏng: {type(e).__name__}") from e
    if not isinstance(cfg, dict):
        raise GatewayError(f"config {CONFIG.name} không phải object")
    env_only = os.environ.get("LLM_PROVIDER_ONLY")
    if env_only is not None:
        cfg["provider_only"] = [p.strip() for p in env_only.split(",") if p.strip()]
    kill = set(cfg.get("kill") or [])
    kill |= {a.strip() for a in os.environ.get("LLM_KILL", "").split(",") if a.strip()}
    cfg["kill"] = kill
    caps = dict(cfg.get("monthly_cap_usd") or {})
    if os.environ.get("LLM_CAP_DEFAULT_USD"):
        try:
            caps["default"] = float(os.environ["LLM_CAP_DEFAULT_USD"])
        except ValueError as e:
            raise GatewayError("LLM_CAP_DEFAULT_USD không phải số") from e
    caps.setdefault("default", 5.0)
    cfg["monthly_cap_usd"] = caps
    return cfg


def _client() -> OpenAI:
    """Điểm DUY NHẤT tạo OpenAI client (test monkeypatch hàm này)."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise GatewayError("thiếu OPENROUTER_API_KEY")
    return OpenAI(base_url=BASE_URL, api_key=key, max_retries=0)


def _connect():
    """Conn llm_usage; None nếu thiếu DSN. connect_timeout chống treo."""
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return None
    return psycopg.connect(dsn, connect_timeout=5)


def _month_spend(agent_id: str) -> float | None:
    """Tổng cost tháng này; None = không đọc được (policy: cho qua)."""
    try:
        conn = _connect()
        if conn is None:
            return None
        try:
            return float(conn.execute(_SPEND_SQL, (agent_id,)).fetchone()[0])
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 — DB lỗi không chặn dịch vụ
        _warn(f"không đọc được spend ({type(e).__name__}) — cho qua")
        return None


def _record(agent_id, model, tin, tout, cost, ok, error=None) -> None:
    try:
        conn = _connect()
        if conn is None:
            _warn("không có DATABASE_URL — bỏ ghi llm_usage")
            return
        try:
            conn.execute(
                "insert into llm_usage (agent_id, model, tokens_in, tokens_out,"
                " cost_usd, ok, error) values (%s,%s,%s,%s,%s,%s,%s)",
                (agent_id, model, tin, tout, cost, ok, error))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        _warn(f"ghi llm_usage lỗi ({type(e).__name__}) — lời gọi vẫn trả kết quả")


def _gate(agent_id: str) -> dict:
    """Validate agent_id + config + kill + cap. Trả config."""
    if not isinstance(agent_id, str) or not _AGENT_RE.fullmatch(agent_id):
        raise GatewayError("agent_id không hợp lệ")
    cfg = _config()
    only = cfg.get("provider_only")
    if not isinstance(only, list) or not only or not all(
            isinstance(p, str) and p for p in only):
        raise GatewayError("provider whitelist rỗng — fail-closed, không gọi LLM")
    if agent_id in cfg["kill"]:
        raise GatewayBlocked(f"agent '{agent_id}' đang bị kill-switch")
    caps = cfg["monthly_cap_usd"]
    cap = float(caps.get(agent_id, caps["default"]))
    spend = _month_spend(agent_id)
    if spend is not None:
        if spend >= cap:
            raise GatewayBlocked(
                f"agent '{agent_id}' vượt trần tháng {spend:.4f}/{cap:.2f} USD")
        if spend >= WARN_RATIO * cap:
            _warn(f"agent '{agent_id}' đã dùng {spend:.4f}/{cap:.2f} USD (>=80%)")
    return cfg


def _provider(cfg: dict) -> dict:
    return {"provider": {"data_collection": "deny", "zdr": True,
                         "allow_fallbacks": False,
                         "only": list(cfg["provider_only"])}}


def _norm_contact(s: str) -> str:
    return s.casefold() if "@" in s else re.sub(r"\D", "", s)


def _mask(text: str, allow: frozenset) -> str:
    """_mask_pii nhưng GIỮ liên hệ công khai của công ty (`pii_allow` —
    hotline/email trên site public, vd câu eval "Hotline liên hệ?"): mask
    hết thì chatbot không trả được số công ty có trong ngữ cảnh KB. So khớp
    theo digits/email casefold; placeholder không chứa digit/sep/@ nên
    mask không đụng và không bridge."""
    if not allow:
        return _mask_pii(text)
    text = text.replace("\x00", "")  # NUL user gõ không giả được placeholder
    keep = []

    def _hold(m):
        if _norm_contact(m.group(0)) not in allow:
            return m.group(0)
        keep.append(m.group(0))
        return "\x00" + "".join(chr(0x61 + int(d)) for d in str(len(keep) - 1)) + "\x00"
    out = _mask_pii(_PII_RE.sub(_hold, text))
    return re.sub("\x00([a-j]+)\x00",
                  lambda m: keep[int("".join(str(ord(c) - 0x61) for c in m.group(1)))],
                  out)


def _mask_content(c, allow):
    if isinstance(c, str):
        return _mask(c, allow)
    if isinstance(c, list):  # multimodal parts [{"type":"text","text":..}]
        return [{**p, "text": _mask(p["text"], allow)}
                if isinstance(p, dict) and isinstance(p.get("text"), str) else p
                for p in c]
    return c


def _allow(cfg) -> frozenset:
    return frozenset(_norm_contact(x) for x in cfg.get("pii_allow") or []
                     if isinstance(x, str) and x)


def _cost(cfg, model, tin, tout) -> float:
    prices = cfg.get("prices_usd_per_1m") or {}
    price = prices.get(model)
    if not price:
        # Fail-closed cho FinOps: model chưa có giá tính theo giá ĐẮT nhất
        # đã biết — ghi 0 sẽ làm trần tháng mất tác dụng.
        price = max(prices.values(),
                    key=lambda p: float(p.get("in", 0)) + float(p.get("out", 0)),
                    default={})
        _warn(f"model {model} chưa có giá trong config — tính theo giá cao nhất")
    return (tin * float(price.get("in", 0)) + tout * float(price.get("out", 0))) / 1e6


def _call(agent_id, model, cfg, fn, payload):
    """Gọi đúng 1 lần; lỗi -> ghi usage err + GatewayError."""
    try:
        client = _client()
        resp = fn(client)(model=model, extra_body=_provider(cfg), **payload)
    except GatewayError:
        raise
    except Exception as e:  # mọi lỗi provider -> fail-closed
        err = _mask_pii(f"{type(e).__name__}: {e}")[:300]
        _record(agent_id, model, 0, 0, 0.0, False, err)
        raise GatewayError(f"LLM provider lỗi ({type(e).__name__}) — fail-closed") from e
    usage = getattr(resp, "usage", None)
    tin = int(getattr(usage, "prompt_tokens", 0) or 0)
    tout = int(getattr(usage, "completion_tokens", 0) or 0)
    _record(agent_id, model, tin, tout, _cost(cfg, model, tin, tout), True)
    return resp


def chat(agent_id: str, messages: list[dict], model: str | None = None, **kw):
    cfg = _gate(agent_id)
    model = model or os.environ.get("OR_CHAT_MODEL", "openai/gpt-4o-mini")
    allow = _allow(cfg)
    msgs = [{**m, "content": _mask_content(m.get("content"), allow)}
            for m in messages]
    return _call(agent_id, model, cfg, lambda c: c.chat.completions.create,
                 {"messages": msgs, **kw})


def embed(agent_id: str, input, model: str | None = None, **kw):
    cfg = _gate(agent_id)
    model = model or os.environ.get("OR_EMBED_MODEL", "openai/text-embedding-3-small")
    allow = _allow(cfg)
    inp = ([_mask(t, allow) for t in input] if isinstance(input, list)
           else _mask(input, allow))
    return _call(agent_id, model, cfg, lambda c: c.embeddings.create,
                 {"input": inp, **kw})


# --- Bộ lọc câu hỏi sức khỏe (W31.5) ------------------------------------
# Khách hỏi bệnh/thuốc/triệu chứng -> KHÔNG để LLM trả lời (TPBVSK không
# được tư vấn điều trị) -> chuyển người. Có dấu: so trên text NFC casefold.
# Không dấu: CHỈ áp khi khách gõ hoàn toàn không dấu (tránh "thuộc"->
# "thuoc", "đâu"->"dau", "giá trị"->"tri" trúng oan); list ascii bỏ từ
# 1 âm tiết mơ hồ. Lệch về phía chuyển người là an toàn.
_HEALTH_VI = [
    "bệnh", "thuốc", "triệu chứng", "chữa", "điều trị", "trị bệnh",
    "gout", "gút", "ung thư", "khối u", "tiểu đường", "đái tháo đường",
    "huyết áp", "tim mạch", "bệnh tim", "đột quỵ", "mỡ máu", "thận",
    # "ho"/"gan" trần trùng chữ không dấu ("Ho Chi Minh", "gan" = gần) ->
    # chỉ giữ dạng cụm.
    "men gan", "bệnh gan", "xơ gan", "gan nhiễm mỡ",
    "dạ dày", "viêm", "đau", "sốt", "bị ho", "ho khan", "ho có đờm",
    "ho ra máu", "mất ngủ", "suy nhược",
    "mang thai", "có thai", "bầu", "cho con bú", "tác dụng phụ",
    "chống chỉ định", "liều", "kê đơn", "bác sĩ", "hóa trị", "xạ trị",
    "savigout",
]
_HEALTH_ASCII = [
    "benh", "thuoc", "trieu chung", "chua benh", "dieu tri", "tri benh",
    "gout", "gut", "ung thu", "khoi u", "tieu duong", "dai thao duong",
    "huyet ap", "tim mach", "dot quy", "mo mau", "men gan", "suy than",
    "da day", "viem", "dau dau", "dau bung", "mat ngu", "suy nhuoc",
    "mang thai", "co thai", "mang bau", "co bau", "cho con bu",
    "tac dung phu", "chong chi dinh", "ke don", "bac si", "hoa tri",
    "xa tri", "savigout",
]


def _kw_re(words):
    return re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, words)) + r")(?!\w)")


_HEALTH_VI_RE = _kw_re(_HEALTH_VI)
_HEALTH_ASCII_RE = _kw_re(_HEALTH_ASCII)


def _strip_accents(s: str) -> str:
    s = unicodedata.normalize("NFD", s).replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in s if not unicodedata.combining(c))


def is_health_question(text: str) -> bool:
    if not isinstance(text, str):
        return False
    t = unicodedata.normalize("NFC", text).casefold()
    if _HEALTH_VI_RE.search(t):
        return True
    return _strip_accents(t) == t and bool(_HEALTH_ASCII_RE.search(t))
