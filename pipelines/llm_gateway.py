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
    Cap <= 0 = tắt agent đó — chặn TRƯỚC khi đọc DB (v13.1).
  - CHÍNH SÁCH DB không đọc được khi check cap (v13.1, đổi từ "cho qua"):
    FAIL-CLOSED -> GatewayBlocked, 0 lời gọi. Chatbot (connectors.zalo /
    messenger, channels --suggest) bắt GatewayBlocked -> câu chuyển nhân
    viên cố định, không gọi AI. Ghi usage lỗi sau khi đã gọi vẫn chỉ cảnh
    báo. Kill-switch không phụ thuộc DB.
  - PII (v13.1, F02): ngoài SĐT/email, `pipelines.pii.mask_identity` che
    tên theo mẫu xưng danh ("tôi là/tên em là ...") và địa chỉ có số nhà
    (số nhà + đường/ngõ/hẻm/thôn... hoặc số + tên đường Viết Hoa sau từ gợi
    ý địa chỉ) trong MỌI message/input — trừ địa chỉ công khai của công ty
    trong `pii_allow`. Text do KHÁCH gõ còn qua `pii.scrub_user` ở
    `api.rag.answer` (danh xưng + tên Viết Hoa, dấu hiệu sót -> chuyển
    người, không gọi AI).
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

from pipelines.pii import _PII_RE, _mask_pii, mask_identity

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
    """Tổng cost tháng này; None = không đọc được (v13.1: `_gate` chặn)."""
    try:
        conn = _connect()
        if conn is None:
            return None
        try:
            return float(conn.execute(_SPEND_SQL, (agent_id,)).fetchone()[0])
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001 — caller quyết (fail-closed)
        _warn(f"không đọc được spend ({type(e).__name__}) — chặn lời gọi")
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
    try:
        cap = float(caps.get(agent_id, caps["default"]))
    except (TypeError, ValueError) as e:
        raise GatewayError(f"trần chi phí của '{agent_id}' không phải số") from e
    # v13.1 (FinOps): cap <= 0 = agent TẮT — chặn TRƯỚC khi đọc DB (trước
    # đây DB down thì cap 0 vẫn cho qua câm).
    if not cap > 0:
        raise GatewayBlocked(f"agent '{agent_id}' có trần 0 USD — đang tắt")
    spend = _month_spend(agent_id)
    if spend is None:
        # v13.1: không đọc được chi tiêu = không chứng minh được còn trong
        # trần -> FAIL-CLOSED (chatbot bắt GatewayBlocked -> chuyển người).
        raise GatewayBlocked(
            f"agent '{agent_id}': không đọc được chi tiêu tháng — chặn"
            " (fail-closed)")
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


def _mask(text: str, allow: frozenset, addr: tuple = ()) -> str:
    """_mask_pii nhưng GIỮ liên hệ công khai của công ty (`pii_allow` —
    hotline/email trên site public, vd câu eval "Hotline liên hệ?"): mask
    hết thì chatbot không trả được số công ty có trong ngữ cảnh KB. So khớp
    theo digits/email casefold; placeholder không chứa digit/sep/@ nên
    mask không đụng và không bridge.
    v13.1 (F02): trước đó che tên theo mẫu xưng danh + địa chỉ có số nhà
    (`pii.mask_identity`), giữ địa chỉ công khai trong `addr`."""
    text = mask_identity(text, addr)
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


def _mask_content(c, allow, addr=()):
    if isinstance(c, str):
        return _mask(c, allow, addr)
    if isinstance(c, list):  # multimodal parts [{"type":"text","text":..}]
        return [{**p, "text": _mask(p["text"], allow, addr)}
                if isinstance(p, dict) and isinstance(p.get("text"), str) else p
                for p in c]
    return c


def _is_addr(x: str) -> bool:
    return "@" not in x and any(c.isalpha() for c in x)


def _allow(cfg) -> frozenset:
    return frozenset(_norm_contact(x) for x in cfg.get("pii_allow") or []
                     if isinstance(x, str) and x and not _is_addr(x))


def _allow_addr(cfg) -> tuple:
    """Mục `pii_allow` có chữ (không '@') = địa chỉ công khai của công ty."""
    return tuple(x for x in cfg.get("pii_allow") or []
                 if isinstance(x, str) and x.strip() and _is_addr(x))


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
    allow, addr = _allow(cfg), _allow_addr(cfg)
    msgs = [{**m, "content": _mask_content(m.get("content"), allow, addr)}
            for m in messages]
    return _call(agent_id, model, cfg, lambda c: c.chat.completions.create,
                 {"messages": msgs, **kw})


def embed(agent_id: str, input, model: str | None = None, **kw):
    cfg = _gate(agent_id)
    model = model or os.environ.get("OR_EMBED_MODEL", "openai/text-embedding-3-small")
    allow, addr = _allow(cfg), _allow_addr(cfg)
    inp = ([_mask(t, allow, addr) for t in input] if isinstance(input, list)
           else _mask(input, allow, addr))
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
    "ho ra máu", "mất ngủ", "suy nhược", "đường huyết",
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
    # v13 vá review: bản không dấu còn thiếu của mục _HEALTH_VI — dạng CỤM
    # (âm tiết đơn "sot"/"dau"/"than" trùng "sốt"→"sót", "đâu", "than").
    "gan nhiem mo", "xo gan", "benh gan", "benh tim", "benh than",
    "soi than", "duong huyet", "dau lung", "dau khop", "dau nguc",
    "dau rang", "dau hong", "bi sot", "sot cao", "bi dau", "bi ho",
    "ho khan", "ho ra mau", "u buou", "tai bien",
]


def _kw_re(words):
    return re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, words)) + r")(?!\w)")


_HEALTH_VI_RE = _kw_re(_HEALTH_VI)
_HEALTH_ASCII_RE = _kw_re(_HEALTH_ASCII)


def _strip_accents(s: str) -> str:
    s = unicodedata.normalize("NFD", s).replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in s if not unicodedata.combining(c))


# v13.1 (F02): lọc theo ÂM TIẾT trên TOÀN câu — trước đây danh sách không
# dấu chỉ áp khi CẢ câu không dấu, nên câu trộn dấu "Ba tôi bi tieu duong,
# mua loại nào?" lọt tới retrieve/embed ngoài. Giờ mỗi cụm khớp theo bản
# bỏ dấu của từng âm tiết, rồi kiểm âm tiết GỐC: (a) viết trần (không dấu)
# — chỉ cho cụm trong danh sách không dấu đã rà (`_HEALTH_ASCII`); hoặc
# (b) cùng bộ dấu với âm tiết của cụm có dấu (không phân biệt vị trí dấu:
# "hoá"="hóa"). "thuộc" ≠ "thuốc", "đâu" ≠ "đau" (khác bộ dấu) -> không
# trúng oan. Ký tự định dạng vô hình (ZWSP, soft hyphen...) bỏ trước;
# NFKC gộp fullwidth/NFD. Cụm dính liền không cách ("tieuduong") cũng bắt.
_SYL_RE = re.compile(r"[^\W_]+")


def _marks(syl: str) -> tuple:
    d = unicodedata.normalize("NFD", syl)
    return (tuple(sorted(c for c in d if unicodedata.combining(c))),
            "đ" in syl)


def _health_rules() -> list[tuple[tuple, tuple | None, bool]]:
    """[(âm tiết bỏ dấu, âm tiết có dấu|None, cho phép viết trần)]."""
    vi = {}
    for p in _HEALTH_VI:
        vi.setdefault(tuple(_strip_accents(p).split()), tuple(p.split()))
    rules = {}
    for key, acc in vi.items():
        rules[key] = (acc, False)
    for p in _HEALTH_ASCII:
        key = tuple(p.split())
        acc = vi.get(key) or _HEALTH_ASCII_ACCENT.get(p)
        rules[key] = (tuple(acc.split()) if isinstance(acc, str) else acc,
                      True)
    return [(k, a, bare) for k, (a, bare) in rules.items()]


# Cụm không dấu chưa có dạng có dấu trong `_HEALTH_VI` (để chấp nhận câu
# gõ dấu một phần đúng âm tiết, vd "đau dau").
_HEALTH_ASCII_ACCENT = {
    "chua benh": "chữa bệnh", "suy than": "suy thận", "dau dau": "đau đầu",
    "dau bung": "đau bụng", "mang bau": "mang bầu", "co bau": "có bầu",
    "gut": "gút", "soi than": "sỏi thận", "dau lung": "đau lưng",
    "dau khop": "đau khớp", "dau nguc": "đau ngực", "dau rang": "đau răng",
    "dau hong": "đau họng", "bi sot": "bị sốt", "sot cao": "sốt cao",
    "bi dau": "bị đau", "bi ho": "bị ho", "u buou": "u bướu",
    "tai bien": "tai biến",
}
_HEALTH_RULES = _health_rules()
_HEALTH_BY_FIRST: dict[str, list] = {}
for _r in _HEALTH_RULES:
    _HEALTH_BY_FIRST.setdefault(_r[0][0], []).append(_r)
# Cụm dính liền: bản bỏ dấu → bản có dấu (None nếu chỉ có dạng trần).
# v13 vá review: trước chỉ nhận dạng TRẦN ("tieuduong") — "tiểu<ZWSP>đường"
# (ZWSP bị bỏ → "tiểuđường") lọt dù docstring nói bắt được.
_HEALTH_JOINED = {"".join(k): ("".join(a) if a else None, bare)
                  for k, a, bare in _HEALTH_RULES if len(k) > 1}


def _marks_sub(orig: str, acc: str) -> bool:
    """Bộ dấu của `orig` là TẬP CON bộ dấu của `acc` (gõ thiếu dấu:
    "đuong" ⊂ "đường"). Dấu sai ("thuộc" vs "thuốc") → False."""
    (mo, do), (ma, da) = _marks(orig), _marks(acc)
    rest = list(ma)
    for c in mo:
        if c not in rest:
            return False
        rest.remove(c)
    return da or not do


def _syl_ok(orig: str, acc: str | None, bare: bool,
            partial: bool = False) -> bool:
    if _strip_accents(orig) == orig:
        return bare or acc == orig
    if acc is None:
        return False
    # v13 vá review: cụm >=2 âm tiết chấp nhận âm tiết GÕ THIẾU dấu
    # ("tiểu đuong"); cụm 1 âm tiết vẫn phải đúng bộ dấu ("chưa" ≠ "chữa").
    return _marks(orig) == _marks(acc) or (partial and _marks_sub(orig, acc))


def is_health_question(text: str) -> bool:
    if not isinstance(text, str):
        return False
    t = "".join(c for c in unicodedata.normalize("NFKC", text)
                if unicodedata.category(c) != "Cf").casefold()
    if _HEALTH_VI_RE.search(t):
        return True
    syls = _SYL_RE.findall(t)
    plain = [_strip_accents(s) for s in syls]
    for i, p in enumerate(plain):
        joined = _HEALTH_JOINED.get(p)
        if joined and _syl_ok(syls[i], joined[0], joined[1], partial=True):
            return True
        for key, acc, bare in _HEALTH_BY_FIRST.get(p, ()):
            n = len(key)
            if tuple(plain[i:i + n]) == key and all(
                    _syl_ok(syls[i + j], acc[j] if acc else None, bare,
                            partial=n > 1)
                    for j in range(n)):
                return True
    return False
