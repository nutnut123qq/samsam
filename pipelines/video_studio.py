"""MKT-04 "Agent Video ngắn" (v6.3, WP08) — video dọc NHÁP từ packshot thật.

Contract:
  write_script(sku, channel, brief, *, fmt="9:16", readiness=None)
      -> {"ok", "refused", "error", "scenes" [{"text", "visual"}],
          "dropped" [{"text", "ly_do"}], "caption", "guardrail", "model",
          "prompt_version", "template_sha256", "prompt_sha256", "llm_calls"}
  make_video(sku, channel, brief, *, fmt="9:16", readiness=None,
             packshot_dir=None, broll_dir=None, out_dir=None)
      -> {"ok", "refused", "error", "path", "sidecar", "sha256", "sku",
          "channel", "format", "packshot_sha256", "script", "draft_text",
          "guardrail", "meta"}
  save_video(conn, res, *, by, source="cli") -> {"status", ...}
  precheck_video(sku, channel, fmt, *, readiness=None) -> dict | None
  check_brief(brief) -> dict | None
  find_ffmpeg() -> str | None
  label_visible(frame, ref, box, rgb, *, tol=40) -> float
  make_sample_broll(path, *, exif_gps=False, license=SAMPLE_LICENSE)

Bất biến (acceptance WP08 + final_plans MKT-04):
  - Video dựng TẤT ĐỊNH từ khung PNG: khung packshot (và khung kết = tên
    SKU golden, do CODE) = `image_studio.compose` (packshot thật dán sau
    cùng, nhãn AI, phụ đề ở ô headline); video_studio đọc BYTES khung 1 lần
    và kiểm lại `verify_packshot` TRƯỚC khi ghép — lệch 1 pixel ->
    `packshot_lech`, 0 mp4/sidecar/DB. Khung B-roll = ảnh tĩnh công ty cấp
    trong BROLL_DIR, CHỈ dùng khi có license trong `licenses.json`, dựng lại
    RGB từ pixel (mất EXIF/GPS/ICC) + cùng lớp chữ `_layout_text` với ảnh.
    Clip video làm B-roll chưa hỗ trợ (bỏ qua).
  - Kịch bản LUÔN do LLM (gateway, agent `mkt_video`, cap tháng) -> video
    LUÔN là nội dung AI: nhãn "Nội dung có sử dụng AI" (labels.ai[0]) +
    nhãn QC (labels.ad[0] — `video` có ad: true) vẽ trên MỌI khung (= suốt
    video) và có trong caption. Sau mã hóa trích 3 khung (đầu/giữa/cuối)
    từ mp4 kiểm nhãn còn hiện — thiếu -> `nhan_ai`, xóa mp4.
  - Câu kịch bản chạm số/giá/quy cách (`content._spec_like`) bị BỎ (v6.3
    không đưa giá vào video — giá đổi theo kênh/khuyến mãi, video sống lâu
    hơn giá); câu có từ cấm kịch bản (`script_banned`: bác sĩ, khuyên
    dùng...) hoặc caption vi phạm `check_publish_llm` -> 1 lượt sửa có
    feedback -> còn vi phạm -> `kich_ban`.
  - Từ chối TRƯỚC LLM (0 lời gọi, 0 file, 0 DB), theo thứ tự: config |
    precheck ảnh (ruou — mọi kênh kể cả map tiêm QC_DAY_DU; maket_xnqc —
    MỌI SKU TPBVSK; sku_la) | kenh_la | format_la | readiness | brief_cam |
    tts | packshot_thieu (chỉ make_video). Sau LLM: kich_ban -> ffmpeg_thieu
    (kịch bản vẫn trả trong `script`) -> mã từ chối của compose (headline/
    font/packshot_loi...) -> packshot_lech -> nhan_ai.
  - mp4 không track âm thanh khi TTS `none`, không metadata (`-map_metadata
    -1`, bitexact): không vị trí/thiết bị/thời điểm. ffmpeg gọi bằng
    subprocess KHÔNG shell, input chỉ PNG local.
  - Chỉ là NHÁP: `save_video` ghi `content_drafts` content_type 'video'
    (status mặc định pending) + `video_assets`. Danh tính asset =
    (file_sha256, sku, channel, format) = 1 mục CLI; sidecar mô tả FILE
    (không sku/kênh/format/sha packshot gốc/prompt_sha256 theo kênh).
    Module này không có đường chuyển trạng thái/duyệt/đăng và không gọi
    mạng ngoài LLM gateway.

TTS: env `TTS_PROVIDER` đọc LÚC GỌI, mặc định `none` (video không tiếng,
không nhạc). Chỗ cắm provider thật (external-dep — key + hợp đồng TTS tiếng
Việt có phí): `fn(text: str, voice: str) -> (wav_bytes, {"model", "voice"})`
đăng ký vào `TTS_PROVIDERS`, `voice` ∈ `video_studio.json` `tts.voices`
(giọng THƯ VIỆN của nhà cung cấp). KHÔNG có tham số âm thanh/ảnh mẫu — không
nhân bản giọng/hình người thật. Hàm đó PHẢI bọc như `pipelines.llm_gateway`
(kill-switch + trần chi phí agent `mkt_video_tts` + ghi `llm_usage`) — v6.3
chưa cắm.

ffmpeg: env `FFMPEG_BIN` -> gói `imageio-ffmpeg` (requirements) -> PATH.
Không có -> `ffmpeg_thieu` (external-dep), phần kịch bản/kiểm luật vẫn chạy.

CLI:
  python -m pipelines.video_studio --sku mat-ong-sam-300ml --channel tiktok
      [--format 9:16] [--format 1:1] --brief "..." [--by agent:mkt04]
  `--sku all` = mọi SKU golden. Packshot `<PACKSHOT_DIR>/<sku>.png`, B-roll
  `<BROLL_DIR>` (mặc định data/broll/, cần licenses.json), output
  `<VIDEO_OUT_DIR>/<sha256>.mp4` + `.json` (mặc định data/video_assets/).
  Exit 0 khi không `failed`; 1 khi có `failed`; 2 khi usage sai / TTS hoặc
  IMAGE_PROVIDER chưa cắm / thiếu ffmpeg / DB không kết nối (kiểm TRƯỚC mọi
  lời gọi LLM).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import suppress
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import psycopg
from PIL import Image, ImageChops, ImageDraw, ImageOps
from psycopg.types.json import Jsonb

from pipelines import content, guardrail, store
from pipelines import image_studio as ims
from pipelines.guardrail_llm import check_publish_llm
from pipelines.llm_gateway import chat, is_health_question

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "video_studio.json"
DEFAULT_BROLL_DIR = ROOT / "data" / "broll"
DEFAULT_OUT_DIR = ROOT / "data" / "video_assets"
TEMPLATE = "video_script"
CONTENT_TYPE = "video"
AGENT = "mkt_video"
DEFAULT_BY = "agent:mkt04"
DEFAULT_MODEL = "openai/gpt-4o-mini"   # = mặc định llm_gateway.chat
SIDECAR_SCHEMA = "video_asset@1"
SAMPLE_LICENSE = "MẪU — tự sinh, không phải tư liệu thật"
MAX_BRIEF = 500
FFMPEG_TIMEOUT_S = 300
BROLL_EXT = (".png", ".jpg", ".jpeg")
CHANNEL_NAME = {"tiktok": "TikTok", "facebook": "Facebook Reels"}
VISUALS = ("packshot", "broll")
# name -> fn(text, voice) -> (wav_bytes, {"model", "voice"}). `none` = không
# tiếng. Provider thật = external-dep (docstring module).
TTS_PROVIDERS = {"none": None}
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
_PUNCT_RE = re.compile(r"[^\w\s]+")
_DUR_RE = re.compile(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)")


# ---------------------------------------------------------------- config

def _int(v, lo, hi) -> int:
    if not (isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi):
        raise ValueError(f"giá trị {v!r} ngoài {lo}..{hi}")
    return v


def load_config(path=None) -> tuple[dict | None, str | None]:
    """data/video_studio.json + data/image_studio.json (cỡ/layout khung,
    nhãn) đã validate -> (cfg, None) | (None, lý do). Kiểm thời lượng:
    scene_s × (min_scenes+1) ≥ duration_s[0] và scene_s × (max_scenes+1)
    ≤ duration_s[1] (mỗi cảnh 1 khung + 1 khung kết)."""
    icfg, err = ims.load_config()
    if err:
        return None, err
    try:
        doc = json.loads(Path(path or CONFIG).read_text(encoding="utf-8"))
        lo, hi = doc["duration_s"]
        cfg = {
            "channels": [str(c) for c in doc["channels"]],
            "formats": [str(f) for f in doc["formats"]],
            "scene_s": _int(doc["scene_s"], 1, 60),
            "min_scenes": _int(doc["min_scenes"], 1, 100),
            "max_scenes": _int(doc["max_scenes"], 1, 100),
            "duration_s": (_int(lo, 1, 600), _int(hi, 1, 600)),
            "fps": _int(doc["fps"], 1, 60),
            "max_chars": _int(doc["subtitle"]["max_chars"], 1,
                              icfg["headline"]["max_chars"]),
            "script_banned": [str(x) for x in doc["script_banned"]
                              if str(x).strip()],
            "voices": [str(v) for v in doc["tts"]["voices"]],
            "extract_tol": _int(doc["extract_tol"], 0, 255),
            "extract_min_ratio": float(doc["extract_min_ratio"]),
            "img": icfg,
        }
        bad = [f for f in cfg["formats"] if f not in icfg["formats"]]
        if bad:
            raise ValueError(f"format {bad} không có trong image_studio.json")
        if not cfg["channels"] or not cfg["formats"] \
                or not cfg["script_banned"]:
            raise ValueError("thiếu kênh/format/từ cấm kịch bản")
        if cfg["min_scenes"] > cfg["max_scenes"]:
            raise ValueError("min_scenes > max_scenes")
        if not 0 < cfg["extract_min_ratio"] <= 1:
            raise ValueError("extract_min_ratio phải trong (0, 1]")
        s = cfg["scene_s"]
        if s * (cfg["min_scenes"] + 1) < lo or s * (cfg["max_scenes"] + 1) > hi:
            raise ValueError(f"scene_s × (số cảnh + 1) phải nằm trong "
                             f"[{lo}, {hi}] giây")
    except (OSError, ValueError, KeyError, TypeError, IndexError,
            AttributeError) as e:
        return None, (f"video_studio.json không dùng được "
                      f"({type(e).__name__}: {str(e)[:160]})")
    return cfg, None


# ------------------------------------------------------------- precheck

def precheck_video(sku, channel, fmt, *, readiness=None) -> dict | None:
    """Từ chối rẻ (0 LLM, 0 file) -> {"code", "reason"} | None. Tái dùng
    `image_studio.precheck_image` (rượu theo category TRƯỚC readiness —
    map tiêm QC_DAY_DU vẫn từ chối; MỌI SKU TPBVSK -> maket_xnqc), rồi kênh
    / format của video (kiểm TRƯỚC readiness — kênh ngoài video báo đúng
    kenh_la)."""
    cfg, err = load_config()
    if err:
        return {"code": "config", "reason": err}
    ref = ims.precheck_image(sku, channel, fmt, readiness=readiness)
    if ref and ref["code"] not in ("readiness", "format_la"):
        return ref
    if channel not in cfg["channels"]:
        return {"code": "kenh_la",
                "reason": f"kênh {str(channel)[:40]!r} không hỗ trợ cho video "
                          f"({', '.join(cfg['channels'])})"}
    if fmt not in cfg["formats"]:
        return {"code": "format_la",
                "reason": f"format {str(fmt)[:20]!r} không hỗ trợ cho video "
                          f"({', '.join(cfg['formats'])})"}
    return ref


def _banned(text: str, terms: list[str]) -> list[str]:
    """Từ cấm khớp (chuẩn hóa như guardrail: NFC, casefold, có/không dấu,
    ký tự chèn giữa chữ) — kiểm cả bản thay dấu câu bằng khoảng trắng:
    "chuyên-gia", "bác.sĩ" (bản nén của guardrail nối liền "chuyêngia" nên
    không khớp cụm có dấu cách)."""
    hits = []
    for t in dict.fromkeys((text, _PUNCT_RE.sub(" ", text))):
        hits += (guardrail._find_terms(t, terms)
                 + guardrail._filler_hits(t, terms))
    return list(dict.fromkeys(h["term"] for h in hits))


def check_brief(brief) -> dict | None:
    """Brief do người nhập -> {"code": "brief_cam", "reason"} | None. Chặn:
    rỗng / dài > MAX_BRIEF / từ cấm kịch bản / nhắc sức khỏe-bệnh /
    `guardrail.check` không ok. Kiểm trên `_clean(brief)` = chuỗi vào
    prompt."""
    cfg, err = load_config()
    if err:
        return {"code": "config", "reason": err}
    s = ims._clean(brief)
    if not s:
        return {"code": "brief_cam", "reason": "brief rỗng"}
    if len(s) > MAX_BRIEF:
        return {"code": "brief_cam",
                "reason": f"brief dài hơn {MAX_BRIEF} ký tự"}
    hits = _banned(s, cfg["script_banned"])
    if hits:
        return {"code": "brief_cam",
                "reason": f"brief có từ cấm ({', '.join(hits)}) — video "
                          "không dùng người/y tế/chuyên gia, trước-sau, cam "
                          "kết"}
    if is_health_question(s):
        return {"code": "brief_cam",
                "reason": "brief nhắc sức khỏe/bệnh — video không gợi công "
                          "dụng chữa bệnh"}
    g = guardrail.check(s)
    if g.get("ok") is not True:
        codes = ", ".join(dict.fromkeys(
            str(v.get("code") or v.get("type"))
            for v in g.get("violations") or [])) or "?"
        return {"code": "brief_cam",
                "reason": f"brief vi phạm guardrail ({codes})"}
    return None


def _tts_name() -> str:
    return (os.environ.get("TTS_PROVIDER") or "").strip() or "none"


def _pre(sku, channel, fmt, brief, readiness) -> dict | None:
    """Thứ tự từ chối trước LLM (1)-(4): config | precheck | brief | tts."""
    _cfg, err = load_config()
    if err:
        return {"code": "config", "reason": err}
    ref = precheck_video(sku, channel, fmt, readiness=readiness) \
        or check_brief(brief)
    if ref:
        return ref
    name = _tts_name()
    if name not in TTS_PROVIDERS:
        return {"code": "tts",
                "reason": f"chưa cắm TTS {name[:40]!r} — TTS tiếng Việt có "
                          f"phí là external-dep; hỗ trợ: "
                          f"{', '.join(sorted(TTS_PROVIDERS))}"}
    return None


# --------------------------------------------------------------- kịch bản

def _parse_scenes(text) -> list[dict] | None:
    """JSON chặt {"scenes": [{"text": str, "visual": packshot|broll}]}
    (bỏ 1 lớp code-fence). Sai shape -> None."""
    if not isinstance(text, str):
        return None
    s = text.strip()
    m = _FENCE_RE.fullmatch(s)
    if m:
        s = m.group(1)
    try:
        obj = json.loads(s)
    except ValueError:
        return None
    sc = obj.get("scenes") if isinstance(obj, dict) else None
    if not (isinstance(sc, list) and sc and all(
            isinstance(x, dict) and isinstance(x.get("text"), str)
            and x.get("visual") in VISUALS for x in sc)):
        return None
    return [{"text": x["text"], "visual": x["visual"]} for x in sc]


def _filter(scenes, cfg) -> tuple[list[dict], list[dict]]:
    """Giữ câu sạch (sau `_clean`); bỏ rỗng, câu chạm số/giá (`so_lieu`),
    câu dài (`dai`), cảnh vượt max_scenes (`thua`)."""
    kept, dropped = [], []
    for sc in scenes:
        t = ims._clean(sc["text"])
        if not t:
            continue
        if content._spec_like(t):
            dropped.append({"text": t, "ly_do": "so_lieu"})
        elif len(t) > cfg["max_chars"]:
            dropped.append({"text": t, "ly_do": "dai"})
        elif len(kept) >= cfg["max_scenes"]:
            dropped.append({"text": t, "ly_do": "thua"})
        else:
            kept.append({"text": t, "visual": sc["visual"]})
    return kept, dropped


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _msgs_sha(messages) -> str:
    return _sha(json.dumps(messages, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8"))


def _codes(g) -> str:
    return ", ".join(dict.fromkeys(
        str(v.get("code") or v.get("type"))
        for v in (g or {}).get("violations") or [])) or "?"


def write_script(sku, channel, brief, *, fmt="9:16", readiness=None) -> dict:
    """Kịch bản qua LLM gateway (agent `mkt_video`) -> lọc -> guardrail.
    Từ chối (1)-(4) = 0 LLM. Vi phạm (từ cấm kịch bản trên MỌI câu LLM trả,
    kể cả câu bị bỏ; caption không qua `check_publish_llm`) -> 1 lượt sửa
    có feedback -> còn vi phạm -> `kich_ban`. JSON sai shape / còn <
    min_scenes cảnh -> `kich_ban` (không sửa). Lỗi gateway (kill/cap/
    provider) -> `error`."""
    out = {"ok": False, "refused": None, "error": None, "scenes": [],
           "dropped": [], "caption": "", "guardrail": None, "model": None,
           "prompt_version": None, "template_sha256": None,
           "prompt_sha256": None, "llm_calls": 0}

    def refuse(code, reason, g=None, **kw):
        ref = {"code": code, "reason": reason}
        return {**out, **kw, "refused": ref,
                "guardrail": g if g is not None
                else content._refused_guardrail(ref)}

    ref = _pre(sku, channel, fmt, brief, readiness)
    if ref:
        return refuse(ref["code"], ref["reason"])
    cfg, _ = load_config()
    try:
        tmpl, ver, tsha = content.load_template(TEMPLATE)
    except ValueError as e:
        return refuse("config", str(e))
    gcfg, gerr = content._cfg()
    if gerr:
        return refuse("config", gerr)
    name = gcfg["golden"][sku]["name"]
    # {brief} thay CUỐI — chữ trong brief không bị thay tiếp.
    fmt_text = (tmpl.replace("{channel}", CHANNEL_NAME.get(channel, channel))
                .replace("{sku_name}", name)
                .replace("{brief}", ims._clean(brief)))
    messages = [{"role": "system",
                 "content": content._system(fmt_text, price_rule=False)},
                {"role": "user",
                 "content": f"SẢN PHẨM: {name} (mã {sku}). Trả về DUY NHẤT "
                            "JSON đúng mẫu."}]
    ctx = {"channel": channel, "content_type": CONTENT_TYPE, "sku": sku,
           "readiness": readiness}
    meta = {"prompt_version": ver, "template_sha256": tsha}
    for calls in (1, 2):   # bản nháp + 1 lượt sửa có feedback
        meta["prompt_sha256"] = _msgs_sha(messages)
        try:
            resp = chat(AGENT, messages, temperature=0.3, max_tokens=700)
            text = resp.choices[0].message.content
        except Exception as e:  # noqa: BLE001 — gateway fail-closed
            return {**out, **meta, "llm_calls": calls,
                    "error": f"llm: {type(e).__name__}: {str(e)[:160]}"}
        model = getattr(resp, "model", None)
        meta["model"] = (model if isinstance(model, str) and model.strip()
                         else os.environ.get("OR_CHAT_MODEL")
                         or DEFAULT_MODEL)[:100]
        scenes = _parse_scenes(text)
        if scenes is None:
            return refuse("kich_ban", "LLM trả sai mẫu JSON {\"scenes\": "
                          "[{\"text\", \"visual\"}]}", **meta,
                          llm_calls=calls)
        kept, dropped = _filter(scenes, cfg)
        lines = [s["text"] for s in kept]
        caption = content._with_required("\n".join(lines), **ctx)
        hits = list(dict.fromkeys(
            h for s in scenes
            for h in _banned(ims._clean(s["text"]), cfg["script_banned"])))
        g = check_publish_llm(caption, is_ai=True, **ctx)
        state = {**meta, "llm_calls": calls, "scenes": kept,
                 "dropped": dropped, "caption": caption}
        if not hits and g.get("ok") is True:
            if len(kept) < cfg["min_scenes"]:
                # guardrail = bản từ chối (không trả g ok cho kết quả bị loại)
                return refuse("kich_ban", f"sau lọc còn {len(kept)} cảnh < "
                              f"{cfg['min_scenes']} (câu số/giá/dài bị bỏ)",
                              **state)
            return {**out, **state, "ok": True, "guardrail": g}
        why = []
        if hits:
            why.append(f"từ cấm kịch bản ({', '.join(hits)})")
        if g.get("ok") is not True:
            why.append(f"guardrail ({_codes(g)})")
        if calls == 2:
            return refuse("kich_ban", "kịch bản vi phạm sau 1 lượt sửa: "
                          + "; ".join(why), g, **state)
        fb = {"violations": [{"code": "tu_cam_kich_ban", "span": h}
                             for h in hits]
              + list(g.get("violations") or [])}
        messages = messages + [
            {"role": "assistant", "content": str(text)},
            {"role": "user", "content": content._feedback(fb)
             + " Không nhắc bác sĩ/chuyên gia/cơ sở y tế. Trả lại DUY NHẤT "
               "JSON đúng mẫu."}]
    raise AssertionError("unreachable")


# ------------------------------------------------------------- ffmpeg

def find_ffmpeg() -> str | None:
    """env FFMPEG_BIN (file có thật) -> imageio-ffmpeg -> PATH -> None."""
    p = (os.environ.get("FFMPEG_BIN") or "").strip()
    if p and Path(p).is_file():
        return p
    with suppress(Exception):   # gói thiếu/hỏng -> thử PATH
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).is_file():
            return exe
    return shutil.which("ffmpeg")


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    """ffmpeg không shell, không stdin; lỗi/timeout -> RuntimeError."""
    try:
        r = subprocess.run(cmd, shell=False, capture_output=True,
                           stdin=subprocess.DEVNULL,
                           timeout=FFMPEG_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"ffmpeg không chạy được ({type(e).__name__})") \
            from e
    return r


def _encode(ff, seq: Path, out: Path, scene_s: int, total_s: int,
            fps: int) -> None:
    r = _run([ff, "-nostdin", "-y", "-loglevel", "error",
              "-f", "image2", "-framerate", f"1/{scene_s}",
              "-i", str(seq / "%03d.png"), "-t", str(total_s),
              "-r", str(fps), "-c:v", "libx264", "-preset", "ultrafast",
              "-tune", "stillimage", "-threads", "1", "-pix_fmt", "yuv420p",
              "-fflags", "+bitexact", "-flags:v", "+bitexact",
              "-map_metadata", "-1", "-map_chapters", "-1", "-an",
              "-movflags", "+faststart", str(out)])
    if r.returncode != 0 or not out.is_file():
        raise RuntimeError(f"ffmpeg mã hóa lỗi (rc={r.returncode}): "
                           + r.stderr.decode("utf-8", "replace")[-200:])


def _probe(ff, path: Path) -> str:
    """stderr của `ffmpeg -i` (thông tin luồng)."""
    return _run([ff, "-nostdin", "-hide_banner", "-i", str(path)]
                ).stderr.decode("utf-8", "replace")


def _duration_ms(info: str) -> int | None:
    m = _DUR_RE.search(info)
    if not m:
        return None
    h, mi, s = m.groups()
    return round((int(h) * 3600 + int(mi) * 60 + float(s)) * 1000)


def _extract_frame(ff, path: Path, t_ms: int) -> Image.Image:
    """Khung tại t_ms trích từ mp4 (PNG qua pipe) -> ảnh RGB."""
    r = _run([ff, "-nostdin", "-loglevel", "error", "-ss",
              f"{t_ms / 1000:.3f}", "-i", str(path), "-frames:v", "1",
              "-f", "image2", "-c:v", "png", "pipe:1"])
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"ffmpeg trích khung {t_ms} ms lỗi")
    with Image.open(BytesIO(r.stdout)) as im:
        im.load()
        return im.convert("RGB")


def _near_count(img: Image.Image, box, rgb, tol: int) -> int:
    x, y, w, h = box
    crop = img.convert("RGB").crop((x, y, x + w, y + h))
    r, g, b = ImageChops.difference(
        crop, Image.new("RGB", crop.size, tuple(rgb))).split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), b)
    return m.point(lambda v: 255 if v <= tol else 0).histogram()[255]


def label_visible(frame, ref, box, rgb, *, tol=40) -> float:
    """Tỉ lệ (số pixel gần màu chữ nhãn — mọi kênh |Δ| ≤ tol — trong `box`
    của `frame`) / (số đó trên `ref`). ref 0 pixel / khác cỡ / input hỏng
    -> 0.0. Thuần (không I/O). Mã hóa yuv420p làm mềm viền chữ nên so có
    dung sai, không so tuyệt đối."""
    try:
        if frame.size != ref.size:
            return 0.0
        n = _near_count(ref, box, rgb, tol)
        return _near_count(frame, box, rgb, tol) / n if n else 0.0
    except (AttributeError, TypeError, ValueError, IndexError):
        return 0.0


def _label_drawn(img: Image.Image, box, rgb) -> bool:
    """Khung PNG có chữ nhãn THẬT: pixel ĐÚNG màu label.text_rgb trong
    label_box ≥ 0.05% (ngưỡng v6.2 — tấm nền bán trong suốt không trùng
    màu tuyệt đối)."""
    x, y, w, h = box
    m = ims._color_mask(img.crop((x, y, x + w, y + h)), rgb)
    return m.histogram()[255] >= 0.0005 * w * h


# ------------------------------------------------------------- B-roll

def _licenses(bdir: Path) -> dict:
    try:
        d = json.loads((bdir / "licenses.json").read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _brolls(bdir: Path, icfg: dict) -> tuple[list[dict], list[dict]]:
    """B-roll hợp lệ (sắp theo tên) + danh sách bị bỏ {file, ly_do}. Chỉ
    ảnh .png/.jpg/.jpeg có license chuỗi khác rỗng trong licenses.json,
    kiểm byte + pixel từ HEADER (chưa decode). Clip video chưa hỗ trợ."""
    if not bdir.is_dir():
        return [], []
    lic = _licenses(bdir)
    ok, skipped = [], []
    for p in sorted(bdir.iterdir(), key=lambda q: q.name):
        if p.name == "licenses.json" or not p.is_file():
            continue
        if p.suffix.casefold() not in BROLL_EXT:
            skipped.append({"file": p.name, "ly_do": "dinh_dang"})
            continue
        license_ = lic.get(p.name)
        if not (isinstance(license_, str) and license_.strip()):
            skipped.append({"file": p.name, "ly_do": "license"})
            continue
        try:
            if p.stat().st_size > icfg["max_bytes"]:
                raise ValueError("bytes")
            with Image.open(p) as im:
                if im.format not in ("PNG", "JPEG") \
                        or im.width * im.height > icfg["max_pixels"]:
                    raise ValueError("pixels")
        except (OSError, ValueError, SyntaxError,
                Image.DecompressionBombError):
            skipped.append({"file": p.name, "ly_do": "anh_loi"})
            continue
        ok.append({"path": p, "file": p.name, "license": license_.strip()})
    return ok, skipped


def _broll_frame(b: dict, text, fmt, icfg, labels):
    """-> (png_bytes, img RGB, file_sha256) | (None, code, reason). Ảnh
    B-roll cover-crop về cỡ format, DỰNG LẠI từ pixel (không EXIF/GPS/ICC)
    + lớp chữ `_layout_text` (phụ đề ô headline + nhãn) như ảnh."""
    font = ims.fonts_for("\n".join([text, *labels]))
    if font is None:
        return None, "font", "không font nào phủ đủ glyph phụ đề/nhãn"
    laid = ims._layout_text(font, icfg, fmt, text, labels)
    if laid[0] is None:
        return None, laid[1], laid[2]
    W, H = icfg["formats"][fmt]
    try:
        raw = b["path"].read_bytes()
        if len(raw) > icfg["max_bytes"]:
            raise ValueError("bytes")
        with Image.open(BytesIO(raw)) as im:
            if im.width * im.height > icfg["max_pixels"]:
                raise ValueError("pixels")
            im.load()
            src = im.convert("RGB")
    except (OSError, ValueError, SyntaxError,
            Image.DecompressionBombError) as e:
        return None, "broll_loi", (f"B-roll {b['file']} không đọc được "
                                   f"({type(e).__name__})")
    bg = ImageOps.fit(src, (W, H), Image.Resampling.LANCZOS)
    canvas = Image.alpha_composite(bg.convert("RGBA"), laid[0]).convert("RGB")
    final = Image.new("RGB", (W, H))
    final.paste(canvas, (0, 0))
    buf = BytesIO()
    final.save(buf, format="PNG")
    return buf.getvalue(), final, _sha(raw)


def make_sample_broll(path, *, exif_gps: bool = False,
                      license: str | None = SAMPLE_LICENSE) -> Path:
    """B-roll MẪU (núi xanh + chữ "MẪU B-roll") cho test/eval/evidence —
    KHÔNG phải tư liệu quay thật. Đuôi .jpg/.jpeg -> JPEG (exif_gps=True
    nhúng EXIF GPS IFD để test output không mang vị trí), khác -> PNG.
    `license` khác None -> ghi/gộp vào `<thư mục>/licenses.json`."""
    path = Path(path)
    W, H = 1280, 960
    img = Image.new("RGB", (W, H), (150, 190, 220))
    d = ImageDraw.Draw(img)
    d.polygon([(0, H), (W * 2 // 5, H // 3), (W * 4 // 5, H), (0, H)],
              fill=(40, 110, 60))
    d.polygon([(W // 3, H), (W * 3 // 4, H // 2), (W, H * 3 // 4), (W, H)],
              fill=(70, 140, 80))
    font = ims.fonts_for("MẪU B-roll")
    d.text((W // 2, H // 2), "MẪU B-roll", fill=(200, 20, 20), anchor="mm",
           font=font.font_variant(size=H // 10) if font else None)
    path.parent.mkdir(parents=True, exist_ok=True)
    jpeg = path.suffix.casefold() in (".jpg", ".jpeg")
    kw = {}
    if exif_gps:
        ex = Image.Exif()
        ex[0x010F] = "MAU-Camera"
        ex[0x0110] = "MAU-Model"
        ex[0x8825] = {1: "N", 2: (15.0, 30.0, 0.0), 3: "E",
                      4: (108.0, 0.0, 0.0)}
        kw["exif"] = ex
    img.save(path, format="JPEG" if jpeg else "PNG", **kw)
    if license is not None:
        lic = _licenses(path.parent)
        lic[path.name] = license
        (path.parent / "licenses.json").write_bytes(
            json.dumps(lic, ensure_ascii=False, indent=2).encode("utf-8"))
    return path


# ------------------------------------------------------------ make_video

def make_video(sku, channel, brief, *, fmt="9:16", readiness=None,
               packshot_dir=None, broll_dir=None, out_dir=None) -> dict:
    """Dựng 1 video nháp. Từ chối -> ok False + `refused` {code, reason},
    0 file (thứ tự ở docstring module); lỗi LLM/ffmpeg -> `error`. Thành
    công -> `<out>/<sha256>.mp4` + sidecar `.json` (mp4 cùng tên giữ khi
    bytes đúng sha; sidecar giữ khi trùng mọi field trừ created_at — lệch/
    sửa tay -> ghi lại); `draft_text` = caption + dòng tên file."""
    out = {"ok": False, "refused": None, "error": None, "path": None,
           "sidecar": None, "sha256": None, "sku": None, "channel": None,
           "format": None, "packshot_sha256": None, "script": None,
           "draft_text": "", "guardrail": None, "meta": None}

    def refuse(code, reason, g=None, **kw):
        ref = {"code": code, "reason": reason}
        return {**out, **kw, "refused": ref,
                "guardrail": g if g is not None
                else content._refused_guardrail(ref)}

    ref = _pre(sku, channel, fmt, brief, readiness)
    if ref:
        return refuse(ref["code"], ref["reason"])
    cfg, _ = load_config()
    icfg = cfg["img"]
    pdir = Path(packshot_dir or os.environ.get("PACKSHOT_DIR")
                or ims.DEFAULT_PACKSHOT_DIR)
    if not (ims._SKU_FILE_RE.fullmatch(sku)
            and (pdir / f"{sku}.png").is_file()):
        return refuse("packshot_thieu", f"thiếu packshot {sku}.png trong "
                      "PACKSHOT_DIR — công ty cấp ảnh sản phẩm thật")
    script = write_script(sku, channel, brief, fmt=fmt, readiness=readiness)
    if script["error"]:
        return {**out, "error": script["error"], "script": script}
    if not script["ok"]:
        return {**out, "refused": script["refused"], "script": script,
                "guardrail": script["guardrail"]}
    ff = find_ffmpeg()
    if ff is None:
        return refuse("ffmpeg_thieu", "không tìm thấy ffmpeg (FFMPEG_BIN / "
                      "imageio-ffmpeg / PATH) — external-dep; kịch bản vẫn "
                      "có trong `script`", script=script)
    _canon, ai, ad = content._publish_texts()
    if not (ai and ad):
        return refuse("config", "guardrail_rules.json thiếu labels.ai/ad",
                      script=script)
    labels = [ai[0], ad[0]]
    rgb = icfg["label"]["text_rgb"]
    W, H = icfg["formats"][fmt]
    lbox = ims._px(icfg["layout"][fmt]["label_box"], (W, H))
    golden = content._cfg()[0]["golden"][sku]["name"]
    brolls, broll_skipped = _brolls(
        Path(broll_dir or os.environ.get("BROLL_DIR") or DEFAULT_BROLL_DIR),
        icfg)
    odir = Path(out_dir or os.environ.get("VIDEO_OUT_DIR") or DEFAULT_OUT_DIR)
    odir.mkdir(parents=True, exist_ok=True)
    items = [(s["text"], s["visual"]) for s in script["scenes"]] \
        + [(golden, "end_card")]
    S = cfg["scene_s"]
    total_ms = S * len(items) * 1000
    with tempfile.TemporaryDirectory(prefix=".tmp-", dir=odir,
                                     ignore_cleanup_errors=True) as td:
        td = Path(td)
        seq = td / "seq"
        seq.mkdir()
        frames, scenes, psha, k = [], [], None, 0
        for i, (text, vis) in enumerate(items):
            sc = {"i": i, "source": vis, "subtitle": text,
                  "start_ms": i * S * 1000, "dur_ms": S * 1000,
                  "frame_sha256": None, "packshot": None, "broll": None,
                  "background": None}
            if vis == "broll" and brolls:
                b = brolls[k % len(brolls)]
                k += 1
                r = _broll_frame(b, text, fmt, icfg, labels)
                if r[0] is None:
                    return refuse(r[1], r[2], script=script)
                data, img, bsha = r
                sc["broll"] = {"file_sha256": bsha, "file": b["file"],
                               "license": b["license"]}
                sc["background"] = {"provider": "broll", "model": None}
            else:
                if vis == "broll":
                    sc["source"] = "packshot"   # không B-roll hợp lệ
                res = ims.compose(sku, channel, text, fmt=fmt,
                                  readiness=readiness, packshot_dir=pdir,
                                  out_dir=td / "compose")
                if not res["ok"]:
                    return refuse(res["refused"]["code"],
                                  res["refused"]["reason"], script=script)
                # Đọc BYTES khung đúng 1 lần — kiểm và ghép cùng bytes này.
                data = Path(res["path"]).read_bytes()
                with Image.open(BytesIO(data)) as im:
                    im.load()
                    img = im.convert("RGB")
                if not ims.verify_packshot(img, res["fitted"],
                                           res["packshot_xy"]):
                    return refuse("packshot_lech", "khung cảnh "
                                  f"{i} có vùng packshot lệch pixel so với "
                                  "packshot gốc — loại video (không lớp nào "
                                  "được sửa nhãn sản phẩm)", script=script)
                if res["meta"]["labels"] != labels:
                    return refuse("nhan_ai", f"khung cảnh {i} có nhãn lệch "
                                  f"{labels}", script=script)
                psha = res["packshot_sha256"]
                bg = res["meta"]["background"]
                sc["packshot"] = res["meta"]["packshot"]
                sc["background"] = {"provider": bg["provider"],
                                    "model": bg["model"]}
            if not _label_drawn(img, lbox, rgb):
                return refuse("nhan_ai", f"khung cảnh {i} không có chữ nhãn "
                              "AI trong label_box", script=script)
            sc["frame_sha256"] = _sha(data)
            (seq / f"{i:03d}.png").write_bytes(data)
            frames.append(img)
            scenes.append(sc)
        tmp = td / "out.mp4"
        try:
            _encode(ff, seq, tmp, S, total_ms // 1000, cfg["fps"])
            info = _probe(ff, tmp)
            got = _duration_ms(info)
            if got is None or abs(got - total_ms) > 100 \
                    or re.search(r"Stream #\S+: Audio:", info):
                raise RuntimeError("mp4 sai thời lượng / có track âm thanh")
            checks = []
            # đầu / giữa cảnh giữa / cuối (không trích đúng ranh giới cảnh)
            mid = (len(items) // 2) * S * 1000 + S * 500
            for t in (500, mid, total_ms - 500):
                ref_img = frames[min(t // (S * 1000), len(frames) - 1)]
                ratio = label_visible(_extract_frame(ff, tmp, t), ref_img,
                                      lbox, rgb, tol=cfg["extract_tol"])
                checks.append({"t_ms": t, "label_ratio": round(ratio, 4)})
        except RuntimeError as e:
            return {**out, "error": str(e)[:300], "script": script}
        low = [c for c in checks if c["label_ratio"]
               < cfg["extract_min_ratio"]]
        if low:
            return refuse("nhan_ai", "nhãn AI không còn hiện trên khung trích "
                          f"từ mp4: {low}", script=script)
        data = tmp.read_bytes()
        sha = _sha(data)
        mp4 = odir / f"{sha}.mp4"
        try:
            same = _sha(mp4.read_bytes()) == sha
        except OSError:
            same = False
        if not same:
            os.replace(tmp, mp4)

    side = odir / f"{sha}.json"
    meta = {
        "schema": SIDECAR_SCHEMA, "file": mp4.name, "asset_sha256": sha,
        "size": [W, H], "bytes": len(data), "fps": cfg["fps"],
        "duration_ms": total_ms, "labels": labels, "label_box": list(lbox),
        "script": {"model": script["model"],
                   "prompt_version": script["prompt_version"],
                   "template_sha256": script["template_sha256"],
                   "lines": [s["text"] for s in script["scenes"]]},
        "scenes": scenes,
        "broll_skipped": broll_skipped,
        "tts": {"provider": _tts_name(), "voice": None},
        "music": None,
        "extract_check": checks,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "guardrail_ok": True,
    }
    kept = ims._same_sidecar(side, meta)
    if kept is not None:
        meta = kept
    else:
        ims._write_atomic(side, json.dumps(meta, ensure_ascii=False,
                                           indent=2).encode("utf-8"))
    return {**out, "ok": True, "path": str(mp4), "sidecar": str(side),
            "sha256": sha, "sku": sku, "channel": channel, "format": fmt,
            "packshot_sha256": psha, "script": script,
            "draft_text": f"{script['caption']}\n\nTệp video: {mp4.name}",
            "guardrail": script["guardrail"], "meta": meta}


# --------------------------------------------------------------- lưu DB

_ASSET_SQL = (
    "insert into video_assets (file_sha256, file_name, sku, channel, format, "
    "duration_ms, label_text, script_model, script_prompt_sha256, "
    "script_prompt_version, tts_provider, packshot_sha256, draft_id, meta, "
    "created_by) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
    "%s, %s) returning id")


def save_video(conn, res: dict, *, by: str, source: str = store.SOURCE_CLI
               ) -> dict:
    """Lưu video nháp: `res` = make_video ok=True (khác -> ValueError).
    Danh tính asset = (file_sha256, sku, channel, format): đã có dòng ->
    {"status": "skipped", "draft_id"}. Chưa có -> `store.save_draft`
    (content_type 'video', status DB mặc định pending, text = draft_text có
    tên file sha) rồi INSERT `video_assets` + commit() tường minh (gotcha
    v2.1). UniqueViolation lúc INSERT (2 process cùng mục) -> {"status":
    "skipped", "orphan_draft_id"} — nháp mồ côi để NGƯỜI reject (agent
    không có quyền xóa)."""
    if not (isinstance(res, dict) and res.get("ok") is True
            and isinstance(res.get("meta"), dict) and res.get("sha256")
            and isinstance(res.get("script"), dict)):
        raise ValueError("save_video: chỉ lưu kết quả make_video ok=True")
    who = (by or "").strip()
    if not who:
        raise ValueError("save_video: thiếu by (người/agent tạo)")
    for k in ("channel", "sku", "format", "packshot_sha256"):
        if not (isinstance(res.get(k), str) and res[k]):
            raise ValueError(f"save_video: thiếu {k}")
    ch, sku, fmt = res["channel"], res["sku"], res["format"]
    m, sha, sc = res["meta"], res["sha256"], res["script"]
    row = conn.execute("select draft_id from video_assets where "
                       "file_sha256 = %s and sku = %s and channel = %s "
                       "and format = %s", (sha, sku, ch, fmt)).fetchone()
    if row:
        return {"status": "skipped", "draft_id": row[0]}
    did = store.save_draft(
        conn, f"video {sku} {ch} {fmt}", ch, res["draft_text"],
        res["guardrail"], source, created_by=who, content_type=CONTENT_TYPE,
        sku=sku, is_ai=True, prompt_version=sc["prompt_version"],
        prompt_sha256=sc["prompt_sha256"])
    try:
        with conn.transaction():
            aid = conn.execute(_ASSET_SQL, (
                sha, m["file"], sku, ch, fmt, m["duration_ms"],
                "\n".join(m["labels"]), sc["model"], sc["prompt_sha256"],
                sc["prompt_version"], m["tts"]["provider"],
                res["packshot_sha256"], did, Jsonb(m), who)).fetchone()[0]
        conn.commit()
    except psycopg.errors.UniqueViolation:
        return {"status": "skipped", "orphan_draft_id": did}
    return {"status": "created", "draft_id": did, "asset_id": aid}


# ------------------------------------------------------------------- CLI

def _line(head: str, it: dict) -> str:
    st = it["status"]
    if st == "created":
        return f"{head}created #{it['draft_id']} {it['file']}"
    if st == "skipped":
        orphan = it.get("orphan_draft_id")
        return f"{head}skipped {it['file']}" + (
            f" (nháp mồ côi #{orphan} do chạy song song — người reject)"
            if orphan is not None else "")
    if st == "refused":
        return f"{head}refused {it['code']}: {it['reason']}"
    return f"{head}failed: {it['reason']}"


def _one(conn, sku, ch, fmt, args, readiness) -> dict:
    try:
        res = make_video(sku, ch, args.brief, fmt=fmt, readiness=readiness)
    except OSError as e:
        return {"status": "failed", "reason": f"lỗi ghi file "
                                              f"({type(e).__name__})"}
    if res["error"]:
        return {"status": "failed", "reason": res["error"]}
    if not res["ok"]:
        return {"status": "refused", **res["refused"]}
    name = Path(res["path"]).name
    try:
        r = save_video(conn, res, by=args.by.strip())
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        return {"status": "failed", "reason": f"lỗi DB: {store._db_msg(e)}"}
    return {**r, "file": name}


def main(argv=None) -> int:
    cfg, err = load_config()
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.video_studio",
        description="Dựng VIDEO NHÁP MKT-04 (khung packshot thật + phụ đề "
                    "kịch bản AI, nhãn 'Nội dung có sử dụng AI' mọi khung) "
                    "vào hàng duyệt (pending) — agent KHÔNG đăng")
    ap.add_argument("--sku", action="append", default=[],
                    help="sku_key golden, lặp được; 'all' = mọi SKU golden")
    ap.add_argument("--channel", action="append", default=[],
                    choices=cfg["channels"] if cfg else None,
                    help="kênh, lặp được")
    ap.add_argument("--format", dest="formats", action="append",
                    choices=cfg["formats"] if cfg else None,
                    help="format video, lặp được (mặc định 9:16)")
    ap.add_argument("--brief", required=True, help="brief video")
    ap.add_argument("--by", default=DEFAULT_BY,
                    help=f"người/agent tạo nháp (mặc định {DEFAULT_BY})")
    args = ap.parse_args(argv)
    if err:
        print(f"[error] {err}", file=sys.stderr)
        return 2
    if not args.sku or not args.channel:
        ap.error("cần ít nhất 1 --sku và 1 --channel")
    if not args.by.strip():
        ap.error("--by không được rỗng")
    # Kiểm TRƯỚC mọi lời gọi LLM: không render được thì không đốt LLM.
    tts = _tts_name()
    if tts not in TTS_PROVIDERS:
        print(f"[error] TTS_PROVIDER={tts[:40]!r} chưa cắm — TTS có phí là "
              f"external-dep; hỗ trợ: {', '.join(sorted(TTS_PROVIDERS))}",
              file=sys.stderr)
        return 2
    prov = ims._provider_name(None)
    if prov not in ims.PROVIDERS:
        print(f"[error] IMAGE_PROVIDER={prov[:40]!r} chưa cắm — external-dep;"
              f" hỗ trợ: {', '.join(sorted(ims.PROVIDERS))}", file=sys.stderr)
        return 2
    if find_ffmpeg() is None:
        print("[error] không tìm thấy ffmpeg (FFMPEG_BIN / imageio-ffmpeg / "
              "PATH) — external-dep, không dựng được video", file=sys.stderr)
        return 2
    skus = list(args.sku)
    if "all" in skus:
        gcfg, gerr = content._cfg()
        if gerr:
            print(f"[error] {gerr}", file=sys.stderr)
            return 2
        skus = [s for s in skus if s != "all"] + list(gcfg["golden"])
    fmts = args.formats or ["9:16"]
    items = []
    with store._conn_or_none() as (conn, cerr):
        if conn is None:  # ghi-tác-vụ: DB chết -> exit 2, 0 lời gọi LLM
            print(f"[error] {cerr} — không ghi được nháp", file=sys.stderr)
            return 2
        readiness = store.readiness_from_db(conn)
        for sku in dict.fromkeys(skus):
            for ch in dict.fromkeys(args.channel):
                for fmt in dict.fromkeys(fmts):
                    it = _one(conn, sku, ch, fmt, args, readiness)
                    items.append(it)
                    print(_line(f"{sku} × {ch} × {fmt}: ", it), flush=True)
    n = {k: sum(it["status"] == k for it in items)
         for k in ("created", "skipped", "refused", "failed")}
    print(f"[done] {len(items)} video — created {n['created']}, skipped "
          f"{n['skipped']}, refused {n['refused']}, failed {n['failed']} "
          "(nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải video "
          "lên kênh tay; agent không đăng)")
    return 1 if n["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
