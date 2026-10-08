"""Zalo OA webhook connector — nhận event -> ACK 200 nhanh -> reply async.

Spec webhook (docs.zaloplatforms.com):
- POST JSON, header `X-ZEvent-Signature` =
  `mac=` + sha256(app_id + raw_body + timestamp + OA_secret_key).
- event_name `user_send_text`: sender.id + message.{msg_id,text}.
- Zalo retry khi webhook timeout -> phải dedup msg_id, không thì reply nhân đôi.

`answer()` mất ~10s -> KHÔNG sync-block trong handler: ACK 200 trước rồi
trả lời async qua send API. Reply qua `pipelines.guardrail.check()`; bị flag
-> gửi FALLBACK, không gửi text vi phạm. Event `user_send_*` không phải
text (ảnh/file/sticker/...) vẫn được reply hằng NON_TEXT_TEXT có hotline —
khách không bị câm (V1.4). Chỉ inbox reply — không endpoint nào đăng
bài/listing mới (C2.4).

Multi-turn (D4.1): history hội thoại giữ in-memory per user (tối đa 4 lượt
Q&A gần nhất, tối đa HIST_MAX_USERS user — LRU evict) — restart process
mất history, chấp nhận được cho pilot.

Access token Zalo hết hạn ~25h -> token store data/zalo_tokens.json là
source-of-truth, seed từ env lần đầu; send API báo lỗi -> refresh qua
oauth rồi retry 1 lần (V1.1). refresh_token ROTATE mỗi lần -> persist
ngay, mất sync = mất khả năng refresh. V2.1: đọc expires_at để refresh
chủ động trước khi token chết; V2.3: persist-fail giữ token trong
_mem_tokens (restart mất — chấp nhận); V2.5: event follow -> welcome.

Chạy: `python -m connectors.zalo` -> :8788/zalo-webhook (port qua
ZALO_WEBHOOK_PORT). Env (V1.2 — 2 secret khác nhau): ZALO_OA_SECRET
(OA secret key -> verify signature), ZALO_APP_ID + ZALO_APP_SECRET
(oauth refresh), ZALO_ACCESS_TOKEN + ZALO_REFRESH_TOKEN (seed token
store). DEPLOY=1/true/yes khi public -> fail-closed nếu thiếu OA secret
hoặc không có đường send nào (D5.1); mặc định dev bypass signature —
runbook: docs/deploy.md.
"""

import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu (fatal/warn prints). Ép UTF-8 — no-op nếu đã là UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

APP_ID = os.environ.get("ZALO_APP_ID", "")
# V1.2 — 2 secret tách riêng theo contract Zalo: OA secret key dùng
# verify signature webhook; app secret đi header `secret_key` khi gọi
# oauth refresh. `.env` không có fallback tên cũ — đổi sạch.
OA_SECRET = os.environ.get("ZALO_OA_SECRET", "")
APP_SECRET = os.environ.get("ZALO_APP_SECRET", "")
# Seed cho token store (V1.1): sau lần refresh thành công đầu tiên,
# source-of-truth là data/zalo_tokens.json — env chỉ còn vai trò khởi tạo.
ACCESS_TOKEN = os.environ.get("ZALO_ACCESS_TOKEN", "")
REFRESH_TOKEN = os.environ.get("ZALO_REFRESH_TOKEN", "")
PORT = int(os.environ.get("ZALO_WEBHOOK_PORT", "8788"))

SEND_URL = "https://openapi.zalo.me/v3.0/oa/message/cs"
OAUTH_URL = "https://oauth.zaloapp.com/v4/oa/access_token"
MAX_TEXT = 2000  # giới hạn text của Zalo CS message
MAX_BODY = 1024 * 1024  # 1MB — event Zalo là JSON nhỏ; body lớn = DoS
FALLBACK = ("Sâm Sâm xin lỗi, câu trả lời tự động chưa đạt kiểm duyệt nội "
            "bộ. Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.")
# Hằng an toàn viết tay — gửi khi answer() crash; không cần qua check().
ERROR_FALLBACK = ("Sâm Sâm xin lỗi, hệ thống đang gặp sự cố. Quý khách "
                  "vui lòng gọi hotline 1800577732 để được hỗ trợ.")
# Hằng viết tay — gửi khi answer() trả NO_DATA (D6.1): khách có lối
# thoát thay vì câu NO_DATA trần; câu hỏi vẫn log answered:false vào
# queue cho nhân viên follow-up. Không cần qua check() (text viết tay).
HANDOFF_TEXT = ("Sâm Sâm chưa đủ dữ liệu để trả lời câu này — nhân "
                "viên sẽ phản hồi sớm nhất. Quý khách cần gấp vui lòng "
                "gọi hotline 1800577732 để được hỗ trợ.")
# Hằng viết tay theo mẫu HANDOFF_TEXT — gửi khi event user_send_* không
# phải text (ảnh/file/sticker/..., V1.4): khách có lối thoát thay vì bị
# câm. Không qua check() (text viết tay).
NON_TEXT_TEXT = ("Sâm Sâm hiện chỉ hỗ trợ trả lời tin nhắn văn bản. "
                 "Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.")
# Hằng viết tay theo mẫu HANDOFF_TEXT/NON_TEXT_TEXT — gửi khi user
# follow OA (V2.5): cảm ơn + giới thiệu 1 dòng chuyên sâm Ngọc Linh +
# hotline. Không qua check() (text viết tay).
WELCOME_TEXT = ("Cảm ơn Quý khách đã theo dõi Sâm Sâm! Sâm Sâm chuyên "
                "các sản phẩm sâm Ngọc Linh chính gốc. Quý khách cần hỗ "
                "trợ vui lòng nhắn tin hoặc gọi hotline 1800577732.")

SEEN_TTL_S = 3600
SEEN_DB = ROOT / "data" / "zalo_seen.db"   # dedup sống qua restart (D3.5)
CONV_LOG = ROOT / "data" / "conversations.jsonl"  # log hội thoại (D3.3)
# Token store (V1.1): {"access_token", "refresh_token", "expires_at"} —
# secret-động tách khỏi .env config-tĩnh do user quản lý; gitignored,
# KHÔNG log nội dung file ở bất kỳ đâu.
TOKEN_STORE = ROOT / "data" / "zalo_tokens.json"
CONV_LOG_MAX = 5 * 1024 * 1024  # 5MB -> rotate sang .1 (D5.4)
# Entry convlog (user_hash + question đã mask) không nằm lại >30 ngày
# trên đĩa — purge lúc startup + ngay sau rotate (D5.11).
RETAIN_DAYS = 30
# SĐT VN hoặc email trong câu hỏi -> mask trước khi log (D5.3).
# Alternative 1 (D5.10 + D6.11): "0" + >=9 số, sep được LẶP nhiều ký tự
# NHƯNG phải cùng 1 ký tự ("0901  234  567", "0901--234--567") — sep
# trộn (" - ") không nối 2 số được, nên khoảng giá/ngày
# "50.000.000 - 100.000.000" không bị ăn (reviewer M1: `[ .-]*` cũ
# nuốt " - " -> 2 số dính thành run >=9 -> mất cả khoảng).
# `(?<!\d)` = số 0 mở đầu không đứng sau chữ số khác -> giá
# "10.050.000.000" không bị ăn giữa chừng; `{9,}` greedy mask hết
# run dài, không lộ đuôi số.
# Alternative 2 (D6.11): "+84"/"84" + >=8 số (VN mobile quốc tế),
# cùng luật sep cùng-ký-tự; `(?<![\d+])` chặn "84" đứng sau digit/'+'.
# Ngày "05.10.2026" (7 số) hay "1.500.000" quá ngắn -> không match.
# V3.1: `_mask_pii` unwrap nhóm ngoặc TOÀN-digit ("(90)" -> " 90 ",
# "(+84)" -> " +84 ") TRƯỚC khi match, nên SĐT dạng ngoặc
# ("+84 (90) 123 4567", "(0901) 234 567") được bắt qua đường đó —
# KHÔNG đưa ngoặc vào sep class (mở lại bridging ở trên) và không
# normalize ngoặc non-digit (làm ")(" -> sep-run -> bridging mới).
# Tên người vẫn không detect được bằng regex.
_PII_RE = re.compile(
    r"(?<!\d)0(?:(?:([ .-])\1*)?\d){9,}"
    r"|(?<![\d+])(?:\+84|84)(?:(?:([ .-])\2*)?\d){8,}"
    r"|[\w.+-]+@[\w-]+\.[\w.]+")

_seen_lock = threading.Lock()
_seen_conn: sqlite3.Connection | None = None  # lazy — không tạo file khi import
_log_lock = threading.Lock()
# Lock riêng quanh refresh flow (V1.1): refresh_token ROTATE mỗi lần —
# 2 reply thread refresh song song sẽ cùng gửi token cũ, bên thắng race
# persist token mới của mình còn bên thua ghi đè mất -> mất luôn khả
# năng refresh. Serialize toàn bộ đọc-refresh-ghi.
_token_lock = threading.Lock()
# Throttle refresh phía caller (send_text — reviewer M3): API error của
# send không chỉ là token hết hạn (user chặn OA, rate limit...) — mỗi
# lần fail đều rotate = burn oauth vô ích. Whitelist mã lỗi Zalo chưa
# chắc, sai whitelist = auto-refresh chết câm -> throttle an toàn hơn.
_last_refresh = 0.0  # lần attempt refresh gần nhất (thành công hay không)
# V2.2: mốc refresh THÀNH CÔNG gần nhất, tách khỏi _last_refresh (mọi
# attempt) — attempt fail mà đánh dấu "fresh" làm send_text retry bằng
# token cũ vô ích.
_last_refresh_ok = 0.0
REFRESH_MIN_INTERVAL_S = 60
# V2.1: refresh chủ động khi expires_at còn <= REFRESH_AHEAD_S — không
# chờ send-fail mới rotate (khách không ăn 1 lượt reply chậm/fail).
REFRESH_AHEAD_S = 300.0
# V2.3: fallback in-memory CHỈ trong cửa sổ _write_token_store fail —
# server Zalo đã rotate refresh_token nên bản trên đĩa chết, mất mem =
# mất luôn đường refresh. Persist OK thì mem xoá — store là source-of-
# truth để process khác (preflight --refresh, sửa tay) được tôn trọng
# (cold-check F1). Restart process vẫn mất token (giới hạn chấp nhận).
# Reader precedence: mem -> store -> env.
_mem_tokens: dict = {}
# user_id -> deque messages OpenAI-style; maxlen=8 = 4 cặp Q&A (D4.1)
# OrderedDict làm LRU: cap số user để dict không phình vô hạn khi webhook
# public — evict user lâu hoạt động nhất (D-nit v0.4).
HIST_MAX_USERS = 1000
_hist_lock = threading.Lock()
_histories: OrderedDict[str, deque] = OrderedDict()
# Lock striping (D5.5): cùng user -> cùng lock -> 2 message concurrent
# xử lý tuần tự (history append + reply đúng thứ tự). 64 lock bounded
# sẵn — va chạm stripe chỉ serialize 2 user khác nhau, vô hại.
_ULOCKS = [threading.Lock() for _ in range(64)]


_DEPLOY_ON = ("1", "true", "yes")


def _startup_error() -> str | None:
    """DEPLOY bật (1/true/yes) -> refuse to serve khi (V1.1+V1.2):
    - thiếu ZALO_OA_SECRET — webhook không verify signature được, nhận
      request giả mạo; HOẶC
    - không có đường send nào: thiếu access token (token store lẫn env
      ZALO_ACCESS_TOKEN) VÀ đồng thời thiếu bộ refresh (refresh_token
      store/env + ZALO_APP_ID + ZALO_APP_SECRET) — ACK 200 nhưng reply
      không bao giờ tới, khó chẩn đoán hơn crash (D5.1).
    Dev local (DEPLOY tắt) vẫn serve. Đọc DEPLOY lúc call (không lúc
    import) để test monkeypatch env được."""
    if os.environ.get("DEPLOY", "").strip().lower() not in _DEPLOY_ON:
        return None
    if not OA_SECRET:
        return ("[fatal] zalo: DEPLOY bật nhưng thiếu ZALO_OA_SECRET — "
                "webhook không verify signature được, từ chối serve")
    if not _current_access_token() and not _can_refresh():
        return ("[fatal] zalo: DEPLOY bật nhưng không có đường send — "
                "thiếu ZALO_ACCESS_TOKEN và đồng thời thiếu bộ "
                "ZALO_REFRESH_TOKEN+ZALO_APP_ID+ZALO_APP_SECRET, "
                "từ chối serve")
    return None


def verify_signature(raw: bytes, header: str) -> bool:
    """mac = sha256(app_id + raw_body + timestamp + OA_secret_key). Chưa
    cấu hình OA secret (dev local) -> bỏ qua; có secret mà sai/thiếu
    signature -> False."""
    if not OA_SECRET:
        return True
    try:
        data = json.loads(raw)
        expect = "mac=" + hashlib.sha256(
            (data["app_id"] + raw.decode() + str(data["timestamp"])
             + OA_SECRET).encode()).hexdigest()
        return hmac.compare_digest(header, expect)
    except (KeyError, ValueError, TypeError):
        return False


def _seen_db() -> sqlite3.Connection:
    """Mở connection lazy — file db chỉ sinh ra ở lần dedup đầu tiên,
    không phải lúc import module (giữ import nhẹ cho test/dev)."""
    global _seen_conn
    if _seen_conn is None:
        SEEN_DB.parent.mkdir(parents=True, exist_ok=True)
        _seen_conn = sqlite3.connect(SEEN_DB, check_same_thread=False)
        _seen_conn.execute(
            "CREATE TABLE IF NOT EXISTS seen("
            "event_id TEXT PRIMARY KEY, ts REAL)")
    return _seen_conn


def _dedup(event_id: str) -> bool:
    """True nếu event đã xử lý — Zalo retry khi timeout sẽ nhân đôi reply.
    Persist sqlite trên đĩa nên restart process không mất state."""
    now = time.time()
    with _seen_lock:
        conn = _seen_db()
        conn.execute("DELETE FROM seen WHERE ts < ?", (now - SEEN_TTL_S,))
        cur = conn.execute(
            "INSERT OR IGNORE INTO seen(event_id, ts) VALUES(?, ?)",
            (event_id, now))
        conn.commit()
        return cur.rowcount == 0  # 0 row = event_id đã tồn tại


def _purge_convlog(path: Path) -> None:
    """Rewrite `path` bỏ dòng có ts cũ hơn RETAIN_DAYS (D5.11) — ts
    ISO-8601 Z so sánh lexicographic đúng. Đọc/ghi bytes: byte lỗi
    (dòng ghi dở khi crash) hay U+2028 trong question không phá purge/
    cắt đôi record. V3.3 ĐỔI POLICY "thà giữ thừa" -> "không chứng
    minh được tuổi = không được nằm lại": dòng parse lỗi / thiếu ts /
    ts sai format / ts tương lai xa (quá slack +1d clock-skew) bị
    DROP — retention 30d là intent cứng, dòng corrupt giữ PII mãi mãi
    mà reader `unanswered()` vốn skip nó nên giữ chỉ để rò PII. ts phải
    strptime được đúng format writer ("%Y-%m-%dT%H:%M:%SZ") — len==20
    thôi không đủ ("9999-99-99T99:99:99Z" cũng 20 ký tự). Ghi tmp +
    os.replace để crash giữa chừng không mất cả file."""
    if not path.exists():
        return
    now = time.time()
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                           time.gmtime(now - RETAIN_DAYS * 86400))
    # Slack +1 ngày cho clock-skew (writer trên máy giờ lệch nhẹ) — ts
    # tương lai xa hơn horizon = không chứng minh được tuổi -> drop.
    horizon = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                            time.gmtime(now + 86400))
    kept = []
    for line in path.read_bytes().split(b"\n"):
        if not line:
            continue
        try:
            obj = json.loads(line.decode("utf-8", "surrogateescape"))
        except ValueError:
            obj = None
        ts = obj.get("ts") if isinstance(obj, dict) else None
        try:
            time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
        except (TypeError, ValueError):
            continue  # corrupt/thiếu ts/ts sai format -> drop
        if ts < cutoff or ts > horizon:
            continue  # quá hạn / tương lai xa -> drop
        kept.append(line)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(b"\n".join(kept) + (b"\n" if kept else b""))
    os.replace(tmp, path)


# Purge file active tối đa 1 lần/ngày khi có ghi — process chạy lâu ít
# traffic không giữ entry quá hạn tới tận restart (D5.11). Purge-fail
# backoff (V4.1): _last_purge chỉ set khi purge THÀNH CÔNG (D6.9);
# _last_purge_attempt ghi MỌI attempt — fail dai dẳng (đĩa hỏng/đầy)
# thì retry throttle PURGE_RETRY_S thay vì mỗi lần ghi một purge
# O(file) trong _log_lock (mọi reply thread xếp hàng). Precedent
# _last_refresh/_last_refresh_ok (V2.2).
PURGE_RETRY_S = 3600.0
_last_purge = 0.0
_last_purge_attempt = 0.0


def _log_conversation(entry: dict) -> None:
    """Append 1 dòng JSON vào conversations.jsonl; vượt CONV_LOG_MAX ->
    rotate sang `.1` (xóa `.1` cũ — 1 backup đủ cho pilot, D5.4) rồi
    purge entry quá hạn trong backup (D5.11). Lock vì nhiều thread reply
    song song; chỉ lưu user_hash, không lưu raw user_id (PII). Purge
    throw (PermissionError/disk full) chỉ warn — không được giết reply
    thread sau khi send thành công (D6.9)."""
    global _last_purge, _last_purge_attempt
    CONV_LOG.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _log_lock:
        now = time.time()
        if (now - _last_purge > 86400
                and now - _last_purge_attempt >= PURGE_RETRY_S):
            # _last_purge chỉ set SAU purge thành công (D6.9);
            # _last_purge_attempt set TRƯỚC try — fail dai dẳng thì
            # retry throttle PURGE_RETRY_S, không phải mọi lần ghi đều
            # purge O(file) trong _log_lock (V4.1).
            _last_purge_attempt = now
            try:
                _purge_convlog(CONV_LOG)
                _last_purge = now
            except Exception as e:  # noqa: BLE001 — warn-only, vẫn log
                print(f"[warn] zalo: purge convlog lỗi {e!r}", flush=True)
        if (CONV_LOG.exists()
                and CONV_LOG.stat().st_size > CONV_LOG_MAX):
            bak = Path(str(CONV_LOG) + ".1")
            bak.unlink(missing_ok=True)
            CONV_LOG.rename(bak)
            try:
                _purge_convlog(bak)
            except Exception as e:  # noqa: BLE001 — warn-only như trên
                print(f"[warn] zalo: purge convlog backup lỗi {e!r}",
                      flush=True)
        with CONV_LOG.open("a", encoding="utf-8") as f:
            f.write(line)


def unanswered() -> list[dict]:
    """Queue câu chưa trả lời cho nhân viên (D6.2): đọc convlog (+ `.1`
    backup nếu có — `.1` cũ hơn đọc trước), trả mọi entry
    `answered:false`. Đọc BYTES + split `\\n` — byte lỗi/U+2028 trong
    question không phá reader (bài học `_purge_convlog` v0.5.1). Reader
    chỉ để hiển thị nên decode `replace` (U+FFFD) — surrogateescape chỉ
    cần cho purge round-trip; lone surrogate làm crash st.dataframe."""
    out = []
    for p in (Path(str(CONV_LOG) + ".1"), CONV_LOG):
        if not p.exists():
            continue
        for line in p.read_bytes().split(b"\n"):
            if not line:
                continue
            try:
                e = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if isinstance(e, dict) and e.get("answered") is False:
                out.append(e)
    return out


def _history(user_id: str) -> deque:
    """Deque history của user: get-or-create + mark mới-dùng-nhất (LRU).
    PHẢI gọi dưới _hist_lock. Đầy HIST_MAX_USERS -> evict entry cũ nhất —
    bound RAM khi public (signature đã chặn user giả, evict nhầm chỉ làm
    mất context follow-up, không mất an toàn)."""
    h = _histories.get(user_id)
    if h is None:
        if len(_histories) >= HIST_MAX_USERS:
            _histories.popitem(last=False)
        h = _histories[user_id] = deque(maxlen=8)
    else:
        _histories.move_to_end(user_id)
    return h


def _ulock(user_id: str) -> threading.Lock:
    """Lock per user qua striping — hash ổn định trong 1 process là đủ,
    không cần persist."""
    return _ULOCKS[hash(user_id) % len(_ULOCKS)]


def _uhash(user_id: str) -> str:
    """user_hash như field convlog — mọi print/log chỉ được dùng hash
    này, KHÔNG raw user_id (invariant: id thật không lọt ra stdout)."""
    return hashlib.sha256(user_id.encode()).hexdigest()[:16]


def _ui_hash(session) -> str:
    """user_hash cho kênh streamlit — per-session uuid để queue phân
    biệt user UI (D6.10). `session` là st.session_state (dict-like:
    hỗ trợ `in` + `[]`/`[]=`)."""
    if "convlog_uid" not in session:
        session["convlog_uid"] = uuid.uuid4().hex[:8]
    return _uhash(f"streamlit:{session['convlog_uid']}")


def _mask_pii(text: str) -> str:
    """Che SĐT/email user gõ vào câu hỏi trước khi ghi convlog — file đã
    gitignore nhưng vẫn nằm plaintext trên đĩa khi deploy. Tên người
    không detect được bằng regex — production cần retention policy.
    V3.1: chỉ unwrap nhóm ngoặc chứa TOÀN digit (kèm '+' đầu tùy chọn)
    — "(90)" -> " 90 ", "(+84)" -> " +84 " — để bắt SĐT dạng ngoặc mà
    KHÔNG normalize mọi ngoặc (normalize tràn làm ")(" -> space-run ->
    bridging mới nối 2 số, reviewer F1). Ngoặc bọc non-digit (giá
    "(1.500.000)" có '.') không match -> ngoặc giữ nguyên -> ")" tự
    chặn bridging vì không thuộc sep class."""
    text = re.sub(r"\((\+?\d+)\)", r" \1 ", text)
    return _PII_RE.sub("***", text)


def _read_token_store() -> dict:
    """Đọc data/zalo_tokens.json; thiếu/hỏng -> {}. File chứa secret —
    KHÔNG log nội dung ở bất kỳ nhánh nào."""
    try:
        obj = json.loads(TOKEN_STORE.read_bytes())
    except (OSError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def _write_token_store(obj: dict) -> None:
    """Ghi atomic tmp + os.replace (precedent _purge_convlog) — crash
    giữa chừng không nát file token đang dùng."""
    TOKEN_STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = TOKEN_STORE.with_name(TOKEN_STORE.name + ".tmp")
    tmp.write_bytes(json.dumps(obj).encode("utf-8"))
    if os.name != "nt":
        os.chmod(tmp, 0o600)  # file chứa token thật — siết quyền trên VPS
    os.replace(tmp, TOKEN_STORE)


def _current_access_token() -> str:
    """Access token hiện hành — precedence mem -> store -> env (V2.3):
    _mem_tokens giữ token mới rotate khi persist fail; token store là
    source-of-truth sau refresh; env ZALO_ACCESS_TOKEN chỉ là seed."""
    tok = _mem_tokens.get("access_token")
    if isinstance(tok, str) and tok:
        return tok
    tok = _read_token_store().get("access_token")
    return tok if isinstance(tok, str) and tok else ACCESS_TOKEN


def _current_refresh_token() -> str:
    """Refresh token hiện hành — ROTATE mỗi lần refresh nên đọc mem ->
    store trước; env ZALO_REFRESH_TOKEN chỉ là seed lần đầu."""
    tok = _mem_tokens.get("refresh_token")
    if isinstance(tok, str) and tok:
        return tok
    tok = _read_token_store().get("refresh_token")
    return tok if isinstance(tok, str) and tok else REFRESH_TOKEN


def _current_expires_at() -> float:
    """expires_at (epoch) của token hiện hành — mem -> store -> 0.0
    khi không biết (store trống/field hỏng). V2.1 đọc để quyết refresh
    chủ động."""
    exp = _mem_tokens.get("expires_at")
    if exp is None:
        exp = _read_token_store().get("expires_at")
    try:
        return float(exp)
    except (TypeError, ValueError):
        return 0.0


def _token_expiring_soon() -> bool:
    """V2.1: expires_at còn <= REFRESH_AHEAD_S -> refresh chủ động trước
    khi send thay vì chờ send-fail mới rotate. Không biết expires_at
    (0) -> False: giữ lazy-on-fail cũ."""
    exp = _current_expires_at()
    return exp > 0 and time.time() > exp - REFRESH_AHEAD_S


def _can_refresh() -> bool:
    """Đủ credential để chạy refresh flow: refresh_token (store/env) +
    ZALO_APP_ID + ZALO_APP_SECRET."""
    return bool(_current_refresh_token() and APP_ID and APP_SECRET)


def refresh_access_token() -> bool:
    """Refresh access_token qua oauth Zalo (grant_type=refresh_token;
    header `secret_key` = ZALO_APP_SECRET). Thành công -> persist
    access_token + refresh_token MỚI + expires_at vào store ngay —
    refresh_token ROTATE mỗi lần, token cũ vô hiệu tức thì nên mất
    sync = mất khả năng refresh. Dưới _token_lock để 2 reply thread
    không rotate song song. Thành công -> persist store + _last_refresh_ok
    (V2.2, throttle retry của send_text); persist-fail -> _mem_tokens
    giữ bản vừa rotate (V2.3). Mọi lỗi oauth -> warn + False, KHÔNG
    throw: reply path không được chết vì token hết hạn; persist-fail
    riêng vẫn True (token usable trong-process).
    Preflight (V1.3) import hàm này để ép refresh flow thật."""
    global _last_refresh, _last_refresh_ok, _mem_tokens
    with _token_lock:
        _last_refresh = time.time()  # mốc throttle attempt cho send_text
        refresh_tok = _current_refresh_token()
        if not (refresh_tok and APP_ID and APP_SECRET):
            print("[warn] zalo: refresh thiếu credential "
                  "(ZALO_REFRESH_TOKEN/ZALO_APP_ID/ZALO_APP_SECRET)",
                  flush=True)
            return False
        try:
            r = httpx.post(
                OAUTH_URL,
                headers={"secret_key": APP_SECRET,
                         "Content-Type":
                             "application/x-www-form-urlencoded"},
                data={"app_id": APP_ID,
                      "grant_type": "refresh_token",
                      "refresh_token": refresh_tok},
                timeout=15)
            body = r.json()
        except (httpx.HTTPError, ValueError) as e:
            print(f"[warn] zalo: refresh token lỗi {e!r}", flush=True)
            return False
        access = body.get("access_token") if isinstance(body, dict) else None
        if r.status_code != 200 or not access:
            # Không log body — response oauth có thể chứa chi tiết nhạy cảm.
            print(f"[warn] zalo: refresh token HTTP {r.status_code}",
                  flush=True)
            return False
        try:
            expires_in = float(body.get("expires_in") or 0)
        except (TypeError, ValueError):
            expires_in = 0.0
        new_refresh = body.get("refresh_token")
        tokens = {
            "access_token": access,
            # Spec luôn trả refresh_token mới; phòng thiếu field thì
            # giữ token đang có — vẫn tốt hơn ghi None làm mất hẳn
            # đường refresh.
            "refresh_token": (new_refresh
                              if isinstance(new_refresh, str)
                              and new_refresh else refresh_tok),
            # expires_in thiếu/<=0 -> 0 = "không biết": ghi now() sẽ làm
            # _token_expiring_soon luôn đúng -> mọi send đều rotate
            # (reviewer v1.1 F1).
            "expires_at": (time.time() + expires_in
                           if expires_in > 0 else 0.0),
        }
        # V2.3: persist fail -> _mem_tokens giữ bản token vừa rotate
        # (server Zalo đã vô hiệu bản cũ — mất mem = mất luôn đường
        # refresh cho tới khi user seed lại env). Persist OK -> xoá
        # mem: store lại là source-of-truth để process khác (preflight
        # --refresh, operator sửa tay) ghi store mới được tôn trọng —
        # giữ mem sau persist-ok sẽ đè store ngoài = regression v1.0
        # (cold-check F1). Rebind nguyên tử — reader không qua lock.
        try:
            _write_token_store(tokens)
        except OSError as e:
            _mem_tokens = tokens
            print(f"[warn] zalo: ghi token store lỗi {e!r} — token đã "
                  f"rotate, chỉ giữ trong-process tới restart",
                  flush=True)
        else:
            _mem_tokens = {}
        _last_refresh_ok = time.time()  # V2.2: mốc THÀNH CÔNG
        return True


def _send_once(user_id: str, text: str, token: str) -> bool | None:
    """Gọi Zalo CS message API đúng 1 lần. True = đã gửi; False = API
    trả lỗi rõ (status != 200 hoặc error != 0 — vd token hết hạn) ->
    đáng thử refresh + retry; None = lỗi transport/decode, không rõ
    request có tới Zalo không -> KHÔNG retry, tránh reply nhân đôi."""
    try:
        r = httpx.post(SEND_URL, params={"access_token": token},
                       json={"recipient": {"user_id": user_id},
                             "message": {"text": text[:MAX_TEXT]}},
                       timeout=15)
        # json() throw (body không phải JSON) -> except ValueError -> None;
        # JSON hợp lệ nhưng không phải dict -> coi như API error rõ.
        body = r.json()
        ok = (r.status_code == 200 and isinstance(body, dict)
              and body.get("error") == 0)
        if not ok:
            print(f"[warn] zalo: send API trả {r.status_code} "
                  f"{r.text[:200]}", flush=True)
        return ok
    except (httpx.HTTPError, ValueError) as e:
        print(f"[warn] zalo: send API lỗi {e!r}", flush=True)
        return None


def send_text(user_id: str, text: str) -> bool:
    """Gửi text qua Zalo CS message API; access_token lấy mem -> store
    -> env seed (V2.3+V1.1). Chưa có token, hoặc có mà expires_at sắp
    tới (V2.1 — refresh chủ động, khách không ăn lượt reply chậm/fail
    khi token vừa chết), mà đủ credential -> refresh trước rồi mới gửi;
    refresh fail vẫn send thử token hiện tại. API báo lỗi rõ + còn
    đường refresh -> retry ĐÚNG 1 lần theo V2.2: refresh vừa THÀNH
    CÔNG gần đây -> retry cùng token mới; attempt-fail gần đây -> bỏ
    (không còn gì tốt hơn để thử, retry token hỏng là waste); còn lại
    -> refresh rồi retry nếu được. Lỗi transport không retry (không rõ
    lượt trước có tới Zalo không)."""
    token = _current_access_token()
    if _can_refresh() and (not token or _token_expiring_soon()):
        # Gộp bootstrap (chưa có token — nhánh _startup_error cho phép
        # serve chỉ với bộ refresh) lẫn proactive (V2.1). Best-effort:
        # fail thì cứ send token hiện tại. Throttle trên attempt
        # (_last_refresh): oauth sập mà không throttle = mỗi send một
        # call 15s-timeout (reviewer v1.1 F1).
        if time.time() - _last_refresh > REFRESH_MIN_INTERVAL_S:
            refresh_access_token()
        else:
            # Thread khác đang refresh (hoặc vừa fail) — chờ lock xong
            # rồi đọc lại token mới nhất thay vì send bản cũ/mất lượt.
            with _token_lock:
                pass
        token = _current_access_token()
    if not token:
        print(f"[warn] zalo: chưa có access token "
              f"(ZALO_ACCESS_TOKEN/token store) — không gửi "
              f"(uh={_uhash(user_id)})", flush=True)
        return False
    res = _send_once(user_id, text, token)
    if res is False and _can_refresh():
        if (time.time() - _last_refresh > REFRESH_MIN_INTERVAL_S
                # Lâu rồi không ai refresh -> thử rotate rồi retry.
                and refresh_access_token()):
            res = _send_once(user_id, text, _current_access_token())
        else:
            # Attempt gần đây: thread khác ĐANG refresh, hoặc vừa fail
            # — chờ _token_lock để phân biệt (in-flight thì chờ xong,
            # reviewer v1.1 F2); fail xong rồi thì lock rảnh ngay.
            with _token_lock:
                pass
            if time.time() - _last_refresh_ok <= REFRESH_MIN_INTERVAL_S:
                # Refresh vừa THÀNH CÔNG -> retry 1 lần với token mới
                # (throttle M3 giữ). Attempt-fail (_last_refresh_ok cũ)
                # -> không retry bằng token hỏng (waste, V2.2).
                res = _send_once(user_id, text, _current_access_token())
    return res is True


def handle_text(user_id: str, question: str, msg_id: str = "") -> dict:
    """Điểm vào từ webhook thread — serialize per user (D5.5): 2 message
    concurrent cùng user_id xử lý tuần tự (lượt sau thấy history lượt
    trước, reply ra đúng thứ tự); user khác nhau vẫn song song."""
    with _ulock(user_id):
        return _reply(user_id, question, msg_id)


def _reply(user_id: str, question: str, msg_id: str = "") -> dict:
    """answer() -> guardrail -> send -> ghi conversation log. Lazy import
    vì api.rag nặng (numpy/psycopg/openai) — phần webhook thuần test
    không cần nó. History per user truyền vào answer() để câu follow-up
    ("còn loại kia?") resolve đúng ngữ cảnh."""
    from api.rag import NO_DATA, answer
    from pipelines.guardrail import check

    t0 = time.time()
    with _hist_lock:
        history = list(_history(user_id))
    try:
        # Chỉ truyền kwarg history khi đã có lượt trước — 1-turn gọi
        # y hệt signature cũ (mock `lambda q:` trong test cũ vẫn dùng được).
        res = (answer(question, history=history) if history
               else answer(question))
    except Exception as e:  # noqa: BLE001 — catch-all có chủ đích ở
        # thread boundary (D4.4): MỌI crash của answer() phải log +
        # fallback, thread không được chết câm mất vết câu hỏi.
        sent = send_text(user_id, ERROR_FALLBACK)
        _log_conversation({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "msg_id": msg_id,
            "user_hash": _uhash(user_id),
            "question": _mask_pii(question),
            "answer": "",
            "sources": [],
            # null chứ không phải False — guardrail chưa chạy (crash
            # trước check()); False sẽ đếm nhầm crash vào "violation".
            "guardrail_ok": None,
            "latency_ms": int((time.time() - t0) * 1000),
            "answered": False,
            "sent": sent,
            "error": repr(e)[:300],
        })
        return {"sent": sent, "text": ERROR_FALLBACK, "sources": []}
    latency_ms = int((time.time() - t0) * 1000)
    raw = res["answer"]
    # Check TRƯỚC khi append nguồn — URL là citation, slug tiếng Việt có
    # thể chứa từ cấm dạng viết trần ("chua-") và flag oan câu trả lời đúng.
    guardrail_ok = check(raw)["ok"]
    if not guardrail_ok:
        print(f"[warn] zalo: reply bị guardrail chặn -> fallback "
              f"(uh={_uhash(user_id)})", flush=True)
        text = FALLBACK
    else:
        if NO_DATA in raw:
            # D6.1: khách nhận handoff text có lối thoát, không phải câu
            # NO_DATA trần — câu hỏi vẫn log answered:false vào queue.
            text = HANDOFF_TEXT
            print(f"[handoff] zalo: NO_DATA -> handoff "
                  f"(uh={_uhash(user_id)})", flush=True)
        else:
            text = raw
            if res["sources"]:
                text += "\nNguồn: " + res["sources"][0]
        # Lượt hợp lệ (kể cả NO_DATA -> handoff) mới vào history — câu
        # bị flag thì không cho LLM "nhớ" text vi phạm ở lượt sau.
        with _hist_lock:
            h = _history(user_id)
            h.append({"role": "user", "content": question})
            h.append({"role": "assistant", "content": raw})
    sent = send_text(user_id, text)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "msg_id": msg_id,
        "user_hash": _uhash(user_id),
        "question": _mask_pii(question),
        "answer": text[:500],
        "sources": res["sources"],
        "guardrail_ok": guardrail_ok,
        "latency_ms": latency_ms,
        # `in` thay `==`: rag.py cũng coi NO_DATA-là-substring là không có
        # data (line `if NO_DATA in text: sources = []`).
        "answered": NO_DATA not in raw,
        "sent": sent,  # send-fail khác "đã xử lý" — giữ riêng để đối soát
    }
    if not guardrail_ok:
        entry["flagged_text"] = raw[:500]  # raw bị flag, debug guardrail
    _log_conversation(entry)
    return {"sent": sent, "text": text, "sources": res["sources"]}


def _reply_non_text(user_id: str, event: str, msg_id: str = "") -> dict:
    """Event user_send_* không phải text (ảnh/file/sticker/link/...):
    gửi hằng NON_TEXT_TEXT — khách có lối thoát thay vì bị câm (V1.4).
    Không gọi answer()/check() — text viết tay; convlog ghi
    answered:false + question dạng `[non-text:<event>]` để nhân viên
    thấy trong queue."""
    t0 = time.time()
    sent = send_text(user_id, NON_TEXT_TEXT)
    _log_conversation({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "msg_id": msg_id,
        "user_hash": _uhash(user_id),
        # event_name do client gửi — cap length phòng chuỗi dài bất
        # thường khi signature bypass (dev).
        "question": f"[non-text:{event[:50]}]",
        "answer": NON_TEXT_TEXT[:500],  # text ĐÃ GỬI — parity HANDOFF
        "sources": [],
        # guardrail không chạy (text viết tay) -> null như nhánh crash;
        # False sẽ đếm nhầm vào "violation".
        "guardrail_ok": None,
        "latency_ms": int((time.time() - t0) * 1000),
        "answered": False,
        "sent": sent,
    })
    return {"sent": sent, "text": NON_TEXT_TEXT, "sources": []}


def handle_non_text(user_id: str, event: str, msg_id: str = "") -> dict:
    """Wrapper _ulock cho _reply_non_text (V2.4) — text + ảnh/file cùng
    user serialize, reply không đảo thứ tự (như handle_text)."""
    with _ulock(user_id):
        return _reply_non_text(user_id, event, msg_id)


def handle_follow(user_id: str) -> dict:
    """Wrapper _ulock cho _reply_follow (V2.5) — cùng striping với text/
    non-text để mọi reply của 1 user ra đúng thứ tự."""
    with _ulock(user_id):
        return _reply_follow(user_id)


def _reply_follow(user_id: str) -> dict:
    """Event follow (V2.5): khách vừa theo dõi OA -> gửi WELCOME_TEXT
    (hằng viết tay — không qua check()). Convlog `answered:null`:
    follow không phải câu hỏi nên KHÔNG vào queue "Chưa trả lời"
    (precedent `guardrail_ok:null` — null = "không áp dụng", khác
    False = "bot bó tay")."""
    t0 = time.time()
    sent = send_text(user_id, WELCOME_TEXT)
    _log_conversation({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        # Event follow không có msg_id — dedup per-user ở Handler
        # (key "uid:follow", V3.2), không qua msg_id.
        "msg_id": "",
        "user_hash": _uhash(user_id),
        "question": "[event:follow]",
        "answer": WELCOME_TEXT[:500],  # text ĐÃ GỬI — parity HANDOFF
        "sources": [],
        "guardrail_ok": None,
        "latency_ms": int((time.time() - t0) * 1000),
        "answered": None,
        "sent": sent,
    })
    return {"sent": sent, "text": WELCOME_TEXT, "sources": []}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._json(200, {"status": "up"})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        # Chunked body không parse được (stdlib) — reject rõ 411 thay vì
        # coi length=0 rồi 403/400 mập mờ; định nghĩa trước để lỡ bật
        # keep-alive sau này không bị body sót đầu độc request kế (D5.9).
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self._json(411, {"error": "length required"})
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return self._json(400, {"error": "bad content-length"})
        if length < 0:
            # read(-1) = đọc tới EOF — client giữ connection mở được
            return self._json(400, {"error": "bad content-length"})
        if length > MAX_BODY:
            return self._json(413, {"error": "payload too large"})
        raw = self.rfile.read(length)
        if self.path != "/zalo-webhook":
            return self._json(404, {"error": "not found"})
        sig = self.headers.get("X-ZEvent-Signature", "")
        if not verify_signature(raw, sig):
            return self._json(403, {"error": "bad signature"})
        try:
            ev = json.loads(raw)
        except ValueError:
            return self._json(400, {"error": "bad json"})
        self._json(200, {"ok": True})  # ACK nhanh — reply async bên dưới
        event = ev.get("event_name") or ""
        if event == "follow":
            # V2.5: khách vừa follow OA -> welcome (uid ở follower.id
            # theo spec; fallback sender.id phòng payload lệch). V3.2:
            # dedup per-user bỏ timestamp — chặn welcome-spam khi user
            # unfollow/refollow liên tục trong SEEN_TTL_S; retry cùng
            # event vẫn chặn (mạnh hơn key cũ — cùng uid là đủ). Refollow
            # SAU TTL vẫn welcome: coi là re-engagement, chủ đích.
            # Someday: muốn chặn lâu hơn cần TTL riêng cho key này —
            # cleanup hiện xóa theo SEEN_TTL_S chung, không phân biệt
            # loại key.
            uid = ((ev.get("follower") or {}).get("id")
                   or (ev.get("sender") or {}).get("id") or "")
            if uid and not _dedup(f"{uid}:follow"):
                threading.Thread(target=handle_follow, args=(uid,),
                                 daemon=True).start()
            return
        if not event.startswith("user_send"):
            return  # unfollow/... — không phải tin nhắn -> ignore
        msg, sender = ev.get("message") or {}, ev.get("sender") or {}
        uid, mid = sender.get("id", ""), msg.get("msg_id") or ""
        if event == "user_send_text":
            text = (msg.get("text") or "").strip()
            if not text or not uid:
                return
            target, args = handle_text, (uid, text, mid)
        else:
            # V1.4: ảnh/file/sticker/... — vẫn dedup rồi reply hằng
            # NON_TEXT_TEXT + convlog answered:false, khách không bị câm.
            if not uid:
                return
            target, args = handle_non_text, (uid, event, mid)
        eid = f"{uid}:{mid or ev.get('timestamp', '')}"
        # Return sớm phía trên -> chỉ event thật sự xử lý mới tới dedup.
        if not _dedup(eid):
            threading.Thread(target=target, args=args,
                             daemon=True).start()

    def log_message(self, fmt: str, *args: object) -> None:
        pass  # yên console — evidence do script/test ghi


def main() -> None:
    if err := _startup_error():
        print(err, flush=True)
        sys.exit(1)
    # Retention theo tuổi mỗi lần boot (D5.11); throw chỉ warn — miss 1
    # lần boot không đáng kill service, lần ghi sau retry (D6.9).
    try:
        _purge_convlog(CONV_LOG)
    except Exception as e:  # noqa: BLE001 — warn-only ở boot
        print(f"[warn] zalo: purge convlog lúc boot lỗi {e!r}", flush=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[zalo] webhook :{PORT}/zalo-webhook "
          f"(oa_secret={'set' if OA_SECRET else 'MISSING'}, "
          f"token={'set' if _current_access_token() else 'MISSING'}, "
          f"refresh={'set' if _can_refresh() else 'MISSING'})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
