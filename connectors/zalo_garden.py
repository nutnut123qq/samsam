"""v12.4 VT — Nhật ký vườn qua Zalo OA (HĐ PL01 mục 7 "Nhật ký vườn qua
Zalo": nhân viên gửi chữ, giọng nói, ảnh → nhật ký chuẩn, không sửa lén).

Contract:
  - Chỉ áp cho NHÂN VIÊN VƯỜN: allowlist `data/garden_staff.json`
    (gitignored; mẫu `data/garden_staff.sample.json`) gồm `user_hash` =
    sha256(user_id Zalo)[:16] (y hệt `zalo._uhash`) + `ma_nv`. KHÔNG lưu
    user_id thô. File thiếu/hỏng/có dòng sai dạng → KHÔNG ai là nhân viên
    (fail-closed: tin đi chatbot khách như cũ, không ghi gì vào vườn).
  - Tin của nhân viên KHÔNG vào chatbot khách / convlog / history.
  - Chữ "<mã khoảnh> <hoạt động> <chi tiết>": hoạt động chuẩn hóa bằng
    `agents.garden` (khớp dài nhất ≤4 từ; chữ CÓ dấu phải khớp đúng dấu —
    "có" không thành "làm cỏ"; 'co' không dấu mơ hồ → bỏ); không khớp →
    'ghi nhận' + giữ nguyên câu ở chi tiết. Ghi qua `garden.add_log`
    (source `zalo:garden`, author `zalo:<ma_nv>`) → trigger hash chain
    `plot_logs` (không sửa/xóa được). Chi tiết qua `_mask_pii`, cắt 1000 ký
    tự. Thiếu mã / khoảnh không tồn tại → trả hướng dẫn, KHÔNG ghi.
  - Ảnh: tải URL trong payload (chỉ https + host CDN Zalo GIẢ ĐỊNH, không
    theo redirect, ≤25 MB) → `scripts/garden_media` gỡ EXIF/GPS → kho
    `GARDEN_MEDIA_DIR` NGOÀI repo + bảng `garden_media`. Khoảnh = mã ở chú
    thích ảnh, hoặc khoảnh nhân viên vừa ghi trong 2 giờ; không có → hướng
    dẫn, KHÔNG tải. Kho thiếu/nằm trong repo → báo, KHÔNG tải.
  - Video (v13.4, event `user_send_video`, attachment `video` — GIẢ ĐỊNH
    theo tài liệu OA, đối chiếu event thật): như ảnh (cần khoảnh) nhưng đi
    nhánh VIDEO của `scripts/garden_media` (magic bytes MP4/MOV, ≤200 MB,
    remux ffmpeg gỡ metadata/GPS; thiếu ffmpeg → KHÔNG lưu). Video không
    bao giờ vào nhánh xử lý ảnh.
  - Giọng nói: kiểm magic bytes (AAC/M4A/MP3/AMR/WAV/OGG — đuôi lưu theo
    NỘI DUNG, không theo URL; lạ → không lưu), lưu file vào
    `<GARDEN_MEDIA_DIR>/audio/` + dòng `garden_voice_drafts` trạng thái
    `cho_chep_loi`; NGƯỜI nghe rồi ghi nhật ký (`python -m agents.garden`)
    và đóng nháp `--done`.
  - STT (v13.4): registry `STT_PROVIDERS` name → (callable(path)->text,
    domestic). Chỉ có `none` — CHƯA chọn vendor (BLOCKED: vendor STT trong
    nước + hợp đồng/DPA + key do Bên B/Pháp chế quyết; không viết adapter
    trước). `--transcribe ID` = đường cắm: provider `none`/lạ/nước ngoài →
    exit 2 kèm hướng dẫn (không gửi audio, không trả chữ rỗng như thành
    công); có provider → in bản chép (qua `_mask_pii`) làm NHÁP cho người
    nghe đối chiếu rồi tự ghi nhật ký + `--done` — agent không tự ghi.
    Webhook không bao giờ gọi STT.
  - Trả lời xác nhận ngắn — text viết tay, không LLM. stdout chỉ `uh=`.
  - KHÔNG import `connectors.zalo`: `python -m connectors.zalo` sẽ nạp 2 bản
    module (2 bộ token/lock/dedup) — zalo truyền `send` vào `handle`.

Chạy:
  python -m connectors.zalo_garden --hash < file_user_id   (STDIN → user_hash)
  python -m connectors.zalo_garden --pending
  python -m connectors.zalo_garden --done ID --log LOG_ID --by "<tên>"
  python -m connectors.zalo_garden --transcribe ID   (exit 2 tới khi có STT)
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from pipelines.pii import _mask_pii

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
STAFF_FILE = ROOT / "data" / "garden_staff.json"
SOURCE = "zalo:garden"
MAX_DETAIL = 1000
MAX_MEDIA = 25 * 1024 * 1024
MAX_ATTACH = 5
LAST_PLOT_TTL_S = 2 * 3600
# GIẢ ĐỊNH — host CDN Zalo trong payload ảnh/ghi âm; đối chiếu event thật
# của OA (external-dep). Host lạ → không tải (chặn SSRF khi bypass chữ ký dev).
MEDIA_HOSTS = ("zdn.vn", "zadn.vn", "zalo.me", "zaloapp.com")
MEDIA_TYPES = {"image": ("image",), "video": ("video",),
               "audio": ("audio", "voice")}
STT_HELP = ("chưa cấu hình STT: BLOCKED — cần vendor STT trong nước + hợp "
            "đồng/DPA + key (Bên B/Pháp chế chọn), cắm vào "
            "connectors.zalo_garden.STT_PROVIDERS rồi đặt GARDEN_STT_PROVIDER; "
            "tạm thời người nghe ghi âm rồi ghi nhật ký tay "
            "(python -m agents.garden) và đóng nháp --done")
_HASH_RE = re.compile(r"[0-9a-f]{16}")
_PLOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,31}")
# 'co' không dấu: có / cỏ / cơ — không đoán là 'làm cỏ'.
_AMBIGUOUS = {"co"}
# Dạng CÓ dấu được nhận (vocab + bản có dấu của alias `agents.garden`).
_ACCENTED = {
    "trồng", "tưới", "bón", "làm cỏ", "kiểm tra sâu bệnh",
    "phun thuốc sinh học", "thu hoạch", "ghi nhận",
    "tưới nước", "tưới phun sương", "bón phân", "kiểm tra", "sâu bệnh",
    "phun thuốc", "trồng mới", "khác"}

HELP = ("Cú pháp nhật ký vườn: <mã khoảnh> <hoạt động> <chi tiết>, vd: "
        "KV-A01 tưới 30 phút. Hoạt động: trồng, tưới, bón, làm cỏ, kiểm tra "
        "sâu bệnh, phun thuốc sinh học, thu hoạch, ghi nhận. Ảnh: ghi mã "
        "khoảnh ở chú thích, hoặc gửi trong 2 giờ sau tin chữ của khoảnh đó.")
DB_DOWN = ("Hệ thống chưa ghi được (lỗi kết nối) — vui lòng gửi lại sau ít "
           "phút.")
ERROR = "Hệ thống gặp lỗi, chưa ghi được — vui lòng gửi lại sau ít phút."
NO_STORE = ("Kho ảnh vườn chưa được cấu hình — tệp CHƯA lưu, vui lòng báo "
            "quản trị.")
NEED_PLOT = ("Ảnh/video CHƯA lưu: chưa biết khoảnh. Ghi mã khoảnh ở chú "
             "thích hoặc gửi tin chữ có mã khoảnh trước (vd: KV-A01 kiểm tra "
             "sâu bệnh) rồi gửi ảnh/video trong 2 giờ.")
NO_FILE = "Không đọc được tệp đính kèm — vui lòng gửi lại."
FEATURE_OFF = ("Tính năng này đang TẮT theo sổ triển khai — CHƯA ghi; vui "
               "lòng báo quản lý vùng trồng để ghi tay.")
# v13 vá review (F03): nhật ký chữ/ghi âm = farming-01, ảnh/video =
# farming-04 (output_sources plot_logs/garden_voice_drafts/garden_media).
FEATURE_LOG = "farming-01"
FEATURE_MEDIA = "farming-04"
UNSUPPORTED = ("Nhật ký vườn qua Zalo nhận chữ, ảnh, video và ghi âm "
               "(chưa nhận tệp/sticker/vị trí). ") + HELP

# Cache allowlist (key = mtime_ns+size) — rebind nguyên tử, đọc không lock.
_staff: tuple = (None, {})
# user_hash → (mã khoảnh, monotonic lúc ghi) — ảnh/ghi âm sau tin chữ.
_last_plot: dict[str, tuple[str, float]] = {}


def uhash(user_id: str) -> str:
    """Như `zalo._uhash` — test khóa 2 hàm bằng nhau."""
    return hashlib.sha256(user_id.encode()).hexdigest()[:16]


def _load_staff() -> dict:
    """{user_hash: ma_nv}. Thiếu file → {}; hỏng / một dòng sai dạng → {}
    + cảnh báo (cả file bị bỏ, không nhận nửa vời)."""
    global _staff
    try:
        st = STAFF_FILE.stat()
    except OSError:
        _staff = (None, {})
        return {}
    key = (st.st_mtime_ns, st.st_size)
    if _staff[0] == key:
        return _staff[1]
    m = {}
    try:
        obj = json.loads(STAFF_FILE.read_bytes())
        rows = obj.get("staff") if isinstance(obj, dict) else None
        if not isinstance(rows, list):
            raise ValueError("thiếu mảng 'staff'")  # noqa: TRY004
        for i, r in enumerate(rows):
            h = r.get("user_hash") if isinstance(r, dict) else None
            code = r.get("ma_nv") if isinstance(r, dict) else None
            if not (isinstance(h, str) and _HASH_RE.fullmatch(h)
                    and isinstance(code, str) and code.strip()
                    and len(code.strip()) <= 32):
                raise ValueError(f"staff[{i}] sai dạng")
            m[h] = code.strip()
    except (OSError, ValueError) as e:
        print(f"[warn] garden: {STAFF_FILE.name} hỏng ({e}) — không ai được "
              f"nhận là nhân viên vườn", flush=True)
        m = {}
    _staff = (key, m)
    return m


def plot_owners(path=None) -> dict:
    """Đợt hợp đồng C02 — {mã khoảnh: [mã NV]} từ `khoanh` của từng dòng
    staff (tùy chọn). File thiếu → {}; hỏng/1 dòng sai dạng → {} + cảnh báo
    (khoảnh thành "chưa có người phụ trách" → leo thang GĐ, không đoán)."""
    p = STAFF_FILE if path is None else Path(path)
    try:
        obj = json.loads(p.read_bytes())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"[warn] garden: {p.name} hỏng ({type(e).__name__}) — không"
              " khoảnh nào có người phụ trách", flush=True)
        return {}
    out: dict = {}
    try:
        rows = obj.get("staff") if isinstance(obj, dict) else None
        if not isinstance(rows, list):
            raise ValueError("thiếu mảng 'staff'")  # noqa: TRY004
        for i, r in enumerate(rows):
            code = r.get("ma_nv") if isinstance(r, dict) else None
            ks = r.get("khoanh", []) if isinstance(r, dict) else None
            if not (isinstance(code, str) and code.strip()
                    and len(code.strip()) <= 32 and isinstance(ks, list)
                    and all(isinstance(k, str) and _PLOT_RE.fullmatch(k)
                            for k in ks)):
                raise ValueError(f"staff[{i}] sai dạng")
            for k in ks:
                out.setdefault(k, []).append(code.strip())
    except ValueError as e:
        print(f"[warn] garden: {p.name} ({e}) — không khoảnh nào có người"
              " phụ trách", flush=True)
        return {}
    return {k: sorted(set(v)) for k, v in out.items()}


def staff_code(user_id: str) -> str | None:
    """Mã nhân viên vườn của user Zalo, None = không phải nhân viên."""
    return _load_staff().get(uhash(user_id)) if user_id else None


def _match_activity(words: list[str]) -> tuple[str, list[str]]:
    """(hoạt động chuẩn, phần còn lại). Khớp dài nhất ≤4 từ đầu."""
    from agents.garden import _fold, normalize_activity
    for n in range(min(4, len(words)), 0, -1):
        cand = unicodedata.normalize("NFC", " ".join(words[:n])).lower()
        f = _fold(cand)
        if f in _AMBIGUOUS or (cand != f and cand not in _ACCENTED):
            continue
        act, known = normalize_activity(cand)
        if known:
            return act, words[n:]
    return "ghi nhận", words


def parse_text(text: str) -> tuple[str, str, str | None] | None:
    """'<mã khoảnh> <hoạt động> <chi tiết>' → (mã, hoạt động, chi tiết|None);
    thiếu từ / mã sai dạng → None."""
    words = (text or "").split()
    if len(words) < 2 or not _PLOT_RE.fullmatch(words[0]):
        return None
    act, rest = _match_activity(words[1:])
    return words[0], act, " ".join(rest) or None


def _connect():
    from ingest.lead_store import connect
    return connect()


def _find_plot(conn, raw: str) -> str | None:
    if not _PLOT_RE.fullmatch(raw or ""):
        return None
    row = conn.execute("select id from plots where upper(id) = upper(%s) "
                       "order by id limit 1", (raw,)).fetchone()
    return row[0] if row else None


def _recent_plot(uh: str) -> str | None:
    hit = _last_plot.get(uh)
    if hit and time.monotonic() - hit[1] <= LAST_PLOT_TTL_S:
        return hit[0]
    return None


def _store_dir() -> Path | None:
    """Kho `GARDEN_MEDIA_DIR` — thiếu hoặc nằm trong repo → None."""
    d = os.environ.get("GARDEN_MEDIA_DIR", "").strip()
    if not d:
        return None
    p, root = Path(d).resolve(), ROOT.resolve()
    if p == root or p.is_relative_to(root):
        print("[warn] garden: GARDEN_MEDIA_DIR nằm trong repo — không lưu",
              flush=True)
        return None
    return p


def _fetch(url: str, max_bytes: int = MAX_MEDIA, client=None) -> bytes:
    """GET tệp từ CDN Zalo → bytes. Từ chối (ValueError, không in URL):
    không https / host ngoài MEDIA_HOSTS / HTTP != 200 (kể cả redirect) /
    rỗng / > max_bytes / lỗi mạng."""
    p = urlsplit(url or "")
    host = (p.hostname or "").lower()
    if p.scheme != "https" or not any(
            host == h or host.endswith("." + h) for h in MEDIA_HOSTS):
        raise ValueError("URL tệp không thuộc CDN Zalo")
    c = client or httpx.Client(timeout=15, follow_redirects=False)
    buf = bytearray()
    try:
        with c.stream("GET", url) as r:
            if r.status_code != 200:
                raise ValueError(f"tải tệp HTTP {r.status_code}")
            cl = r.headers.get("content-length", "")
            if cl.isdigit() and int(cl) > max_bytes:
                raise ValueError("tệp quá lớn")
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > max_bytes:
                    raise ValueError("tệp quá lớn")
    except httpx.HTTPError as e:
        raise ValueError(f"tải tệp lỗi {type(e).__name__}") from e
    finally:
        if client is None:
            c.close()
    if not buf:
        raise ValueError("tệp rỗng")
    return bytes(buf)


def _gm():
    from scripts import garden_media
    return garden_media


def audio_kind(data: bytes) -> str:
    """Đuôi ghi âm theo MAGIC BYTES (không tin đuôi URL) → aac | m4a | mp3 |
    amr | wav | ogg. Khác → ValueError (không lưu tệp lạ vào kho)."""
    if data.startswith(b"#!AMR"):
        return "amr"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data.startswith(b"OggS"):
        return "ogg"
    if data.startswith(b"ID3"):
        return "mp3"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "m4a"
    if len(data) >= 2 and data[0] == 0xFF:
        if data[1] & 0xF6 == 0xF0:          # ADTS: sync 12 bit + layer 00
            return "aac"
        if data[1] & 0xE0 == 0xE0 and data[1] & 0x06:  # MPEG audio layer I-III
            return "mp3"
    raise ValueError("tệp ghi âm không đúng định dạng (magic bytes)")


# name -> (callable(path) -> text, domestic). `none` = chưa có STT. Vendor
# thật là external-dep (xem STT_HELP) — KHÔNG viết adapter trước khi chọn.
STT_PROVIDERS = {"none": (None, True)}


def stt_provider() -> tuple[str, str | None]:
    """(tên provider, lỗi|None). Lỗi khi `none`/không có trong registry/
    nước ngoài — người gọi KHÔNG gửi audio."""
    name = os.environ.get("GARDEN_STT_PROVIDER", "").strip() or "none"
    fn, domestic = STT_PROVIDERS.get(name, (None, True))
    if name not in STT_PROVIDERS:
        return name, (f"GARDEN_STT_PROVIDER={name[:40]!r} chưa tích hợp — "
                      + STT_HELP)
    if fn is None:
        return name, STT_HELP
    if not domestic:
        return name, ("provider STT nước ngoài bị từ chối (giọng nói nhân "
                      "viên là dữ liệu cá nhân) — " + STT_HELP)
    return name, None


def _stt_note(uh: str) -> None:
    name, err = stt_provider()
    if err and name != "none":
        print(f"[warn] garden: GARDEN_STT_PROVIDER đặt nhưng chưa tích hợp "
              f"provider — KHÔNG gửi audio, giữ chờ chép lời (uh={uh})",
              flush=True)


def _off(conn, fid: str, uh: str) -> bool:
    """Tính năng `tat` (rollout, HĐ 6.7) → True: không ghi gì. Chạy thử vẫn
    ghi (nhật ký nội bộ)."""
    from pipelines import rollout
    try:
        rollout.check_generate(conn, fid, "nhật ký vườn qua Zalo")
    except rollout.RolloutBlocked as e:
        print(f"[blocked] garden: {e} (uh={uh})", flush=True)
        return True
    return False


def _on_text(uh: str, code: str, text: str) -> str:
    parsed = parse_text(text)
    if parsed is None:
        return HELP
    raw_plot, act, detail = parsed
    conn = _connect()
    if conn is None:
        return DB_DOWN
    try:
        if _off(conn, FEATURE_LOG, uh):
            return FEATURE_OFF
        plot = _find_plot(conn, raw_plot)
        if plot is None:
            return f"Không tìm thấy khoảnh '{raw_plot}' — CHƯA ghi. {HELP}"
        from agents import garden
        detail = _mask_pii(detail)[:MAX_DETAIL] if detail else None
        lid, warns = garden.add_log(conn, plot, datetime.now(timezone.utc),
                                    act, detail, author=f"zalo:{code}",
                                    source=SOURCE)
    finally:
        with suppress(Exception):
            conn.close()
    if lid is None:
        return f"CHƯA ghi: {warns[0] if warns else 'lỗi không rõ'}."
    _last_plot[uh] = (plot, time.monotonic())
    out = f"Đã ghi nhật ký #{lid}: {plot} — {act}."
    if any("dấu hiệu" in w for w in warns):
        out += " Có dấu hiệu cần chú ý — GĐ vùng trồng sẽ thấy trong bản tin."
    return out


def _on_media(uh: str, code: str, msg: dict, kind: str) -> str:
    atts = [a for a in (msg.get("attachments") or [])
            if isinstance(a, dict) and a.get("type") in MEDIA_TYPES[kind]]
    urls = [u for a in atts[:MAX_ATTACH]
            if isinstance(u := (a.get("payload") or {}).get("url"), str) and u]
    if not urls:
        return NO_FILE
    store_dir = _store_dir()
    if store_dir is None:
        return NO_STORE
    conn = _connect()
    if conn is None:
        return DB_DOWN
    ok = 0
    try:
        if _off(conn, FEATURE_LOG if kind == "audio" else FEATURE_MEDIA, uh):
            return FEATURE_OFF
        words = str(msg.get("text") or "").split()
        plot = _find_plot(conn, words[0]) if words else None
        plot = plot or _recent_plot(uh)
        if kind in ("image", "video") and plot is None:
            return NEED_PLOT
        gm = _gm()
        for url in urls:
            try:
                if kind in ("image", "video"):
                    # video: nhánh riêng (magic MP4/MOV + remux ffmpeg),
                    # KHÔNG bao giờ qua Pillow.
                    if kind == "video":
                        clean, ext, info = gm.strip_video(
                            _fetch(url, gm.MAX_VIDEO_BYTES),
                            tmp_dir=store_dir / ".tmp")
                    else:
                        clean, ext, info = gm.strip_image(_fetch(url))
                    sha, _ = gm.store(clean, ext, store_dir)
                    from pipelines.period import vn_date
                    gm.record(conn, sha, ext, len(clean), info, plot,
                              vn_date(datetime.now(timezone.utc)),
                              f"zalo:{code}", source=SOURCE)
                else:
                    raw = _fetch(url)
                    ext = audio_kind(raw)
                    sha, _ = gm.store(raw, ext, store_dir / "audio")
                    _stt_note(uh)
                    with conn.transaction():
                        conn.execute(
                            "insert into garden_voice_drafts (sha256, ext, "
                            "bytes, staff_code, plot_id, source) values "
                            "(%s, %s, %s, %s, %s, %s) "
                            "on conflict (sha256) do nothing",
                            (sha, ext, len(raw), code, plot, SOURCE))
                    conn.commit()
                ok += 1
            except (ValueError, RuntimeError) as e:
                print(f"[warn] garden: bỏ tệp — {e} (uh={uh})", flush=True)
    finally:
        with suppress(Exception):
            conn.close()
    if not ok:
        return ("CHƯA lưu được tệp (tải lỗi hoặc tệp không hợp lệ) — vui "
                "lòng gửi lại.")
    if kind in ("image", "video"):
        what = "ảnh" if kind == "image" else "video"
        return (f"Đã lưu {ok}/{len(urls)} {what} cho khoảnh {plot} (đã xóa "
                f"vị trí GPS).")
    return (f"Đã nhận {ok} ghi âm{f' (khoảnh {plot})' if plot else ''} — "
            f"chờ người chép lời rồi mới thành nhật ký chính thức.")


def handle(user_id: str, event: str, msg, msg_id: str = "", *,
           send) -> dict:
    """Tin của nhân viên vườn → intake vườn + trả lời xác nhận qua `send`.
    Mọi lỗi bắt ở đây (ranh giới thread) — nhân viên luôn nhận phản hồi."""
    uh = uhash(user_id)
    code = staff_code(user_id)
    msg = msg if isinstance(msg, dict) else {}
    try:
        if code is None:  # bị gỡ khỏi allowlist giữa chừng
            reply = ERROR
        elif event == "user_send_text":
            reply = _on_text(uh, code, str(msg.get("text") or ""))
        elif event == "user_send_image":
            reply = _on_media(uh, code, msg, "image")
        elif event == "user_send_video":
            reply = _on_media(uh, code, msg, "video")
        elif event in ("user_send_audio", "user_send_voice"):
            reply = _on_media(uh, code, msg, "audio")
        else:
            reply = UNSUPPORTED
    except Exception as e:  # noqa: BLE001 — ranh giới thread, như zalo._reply
        print(f"[warn] garden: lỗi {type(e).__name__} (uh={uh})", flush=True)
        reply = ERROR
    sent = send(user_id, reply)
    print(f"[garden] zalo: {event[:40]} -> "
          f"{'sent' if sent else 'send-fail'} (uh={uh})", flush=True)
    return {"sent": sent, "text": reply}


def _transcribe(conn, draft_id: int, name: str) -> int:
    """Chép lời 1 nháp ghi âm đang chờ qua provider STT ĐÃ cắm → in NHÁP
    (đã `_mask_pii`). Không ghi nhật ký/không đóng nháp — người làm."""
    row = conn.execute(
        "select sha256, ext from garden_voice_drafts where id = %s and "
        "status = 'cho_chep_loi'", (draft_id,)).fetchone()
    if row is None:
        print(f"[err] không có nháp #{draft_id} đang chờ chép lời",
              file=sys.stderr)
        return 1
    store_dir = _store_dir()
    if store_dir is None:
        print("[err] thiếu GARDEN_MEDIA_DIR (kho ngoài repo)",
              file=sys.stderr)
        return 2
    sha, ext = row
    path = store_dir / "audio" / sha[:2] / f"{sha}.{ext}"
    try:
        data = path.read_bytes()
    except OSError as e:
        print(f"[err] thiếu file ghi âm {sha[:12]} ({type(e).__name__})",
              file=sys.stderr)
        return 1
    if hashlib.sha256(data).hexdigest() != sha:
        print(f"[err] file ghi âm {sha[:12]} lệch sha256", file=sys.stderr)
        return 1
    fn, _domestic = STT_PROVIDERS[name]
    try:
        text = unicodedata.normalize("NFC", str(fn(path) or "")).strip()
    except Exception as e:  # noqa: BLE001 — lỗi provider bất kỳ
        print(f"[err] STT {name} lỗi ({type(e).__name__})", file=sys.stderr)
        return 1
    if not text:
        print(f"[err] STT {name} không ra chữ — người nghe ghi tay",
              file=sys.stderr)
        return 1
    print(f"[nhap] #{draft_id} ({name}) — NHÁP, người nghe đối chiếu rồi "
          f"ghi nhật ký + --done:\n{_mask_pii(text)[:MAX_DETAIL]}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m connectors.zalo_garden",
        description="Nhật ký vườn qua Zalo — tiện ích allowlist + nháp ghi âm")
    ap.add_argument("--hash", action="store_true",
                    help="đọc user_id Zalo từ STDIN → in user_hash")
    ap.add_argument("--pending", action="store_true",
                    help="liệt kê ghi âm chờ chép lời")
    ap.add_argument("--done", type=int, metavar="ID",
                    help="đóng nháp ghi âm đã chép thành nhật ký")
    ap.add_argument("--log", type=int, metavar="LOG_ID",
                    help="id plot_logs đã ghi từ ghi âm (đi với --done)")
    ap.add_argument("--by", default=None, help="người chép lời")
    ap.add_argument("--transcribe", type=int, metavar="ID",
                    help="chép lời nháp ghi âm qua STT (exit 2 khi chưa có "
                         "provider) — in NHÁP cho người đối chiếu")
    args = ap.parse_args(argv)
    n_ops = sum(bool(x) for x in (args.hash, args.pending,
                                  args.done is not None,
                                  args.transcribe is not None))
    if n_ops != 1:
        ap.error("chọn đúng 1 trong --hash / --pending / --done / "
                 "--transcribe")
    if args.hash:
        uid = sys.stdin.readline().strip()
        if not uid:
            ap.error("STDIN rỗng — cần user_id Zalo")
        print(uhash(uid))
        return 0
    if args.done is not None and (args.log is None
                                  or not (args.by or "").strip()):
        ap.error("--done cần --log và --by")
    if args.transcribe is not None:
        name, err = stt_provider()
        if err:  # kiểm TRƯỚC khi connect/đọc audio — không gửi gì
            print(f"[blocked] {err}", file=sys.stderr)
            return 2
    conn = _connect()
    if conn is None:
        print("[err] không kết nối được Postgres", file=sys.stderr)
        return 2
    try:
        if args.pending:
            rows = conn.execute(
                "select id, received_at, staff_code, plot_id, sha256, ext "
                "from garden_voice_drafts where status = 'cho_chep_loi' "
                "order by id").fetchall()
            for i, at, code, plot, sha, ext in rows:
                print(f"#{i} {at:%Y-%m-%d %H:%M} UTC {code} "
                      f"{plot or '-'} {sha[:12]}.{ext}")
            print(f"[pending] {len(rows)} ghi âm chờ chép lời")
            if rows and stt_provider()[1]:
                print("[blocked] STT chưa cấu hình — người nghe ghi âm rồi "
                      "ghi nhật ký tay; vendor STT: BLOCKED (xem "
                      "--transcribe)")
            return 0
        if args.transcribe is not None:
            return _transcribe(conn, args.transcribe, name)
        import psycopg
        try:
            with conn.transaction():
                row = conn.execute(
                    "update garden_voice_drafts set status = 'da_chep_loi', "
                    "plot_log_id = %s, closed_by = %s, closed_at = now() "
                    "where id = %s and status = 'cho_chep_loi' returning id",
                    (args.log, args.by.strip(), args.done)).fetchone()
            conn.commit()
        except psycopg.errors.ForeignKeyViolation:
            print(f"[err] nhật ký #{args.log} không tồn tại", file=sys.stderr)
            return 1
        if row is None:
            print(f"[err] không có nháp #{args.done} đang chờ chép lời",
                  file=sys.stderr)
            return 1
        print(f"[done] nháp #{args.done} → nhật ký #{args.log}")
        return 0
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
