"""MKT-03 "Agent Ảnh AI" (v6.2, WP08) — ảnh marketing NHÁP ghép packshot thật.

Contract:
  compose(sku, channel, headline, *, fmt="1:1", scene=None, readiness=None,
          provider=None, packshot_dir=None, out_dir=None)
      -> {"ok", "refused", "path", "sidecar", "sha256", "channel", "sku",
          "format", "packshot_sha256", "text_layer", "draft_text",
          "guardrail", "meta", "fitted", "packshot_xy"}
  save_image(conn, res, *, by, source="cli") -> {"status", ...}
  generate_background(prompt, size, *, provider=None) -> (Image RGB, meta)
  precheck_image(sku, channel, fmt, *, readiness=None) -> dict | None
  check_scene(scene) -> dict | None
  background_prompt(scene) -> (prompt, version, template_sha256)
  verify_packshot(img, fitted, box) -> bool
  fonts_for(text) -> FreeTypeFont | None
  make_sample_packshot(path, sku, size=(600, 800), *, exif_gps=False)

Bất biến (acceptance WP08: "100% asset AI có nhãn 'Nội dung có sử dụng AI' +
metadata model/prompt/ngày; QA không phát hiện ảnh nào bị AI sửa chữ trên
nhãn"):
  - AI KHÔNG chạm vùng nhãn — bằng CẤU TRÚC: provider nền chỉ nhận
    `(prompt: str, size)`, KHÔNG BAO GIỜ nhận ảnh/bytes packshot, không có
    tham số mask/sửa vùng ảnh. Thứ tự dựng: nền -> tấm nhãn + chữ (ô cấu hình
    không giao ô packshot) -> packshot dán SAU CÙNG bằng alpha của chính nó.
    Packshot chỉ được THU NHỎ 1 lần (LANCZOS, giữ tỉ lệ) — bản đã thu nhỏ
    (`fitted`) là chuẩn so. Toàn vẹn: MỌI pixel alpha 255 của `fitted` khớp
    TUYỆT ĐỐI (RGB) với file PNG ĐÃ GHI rồi đọc lại; lệch 1 pixel ->
    `packshot_lech`, xóa file tạm, không sidecar, không DB. Output chỉ PNG
    (lossless).
  - Nhãn AI (`labels.ai[0]` của data/guardrail_rules.json) LUÔN vẽ lên ảnh —
    kể cả nền tất định (provider `none`): lúc duyệt store kiểm lại với
    is_ai cố định True, nháp thiếu nhãn AI không duyệt được (fail-closed;
    Pháp chế quyết sau). `ai_generated` = True CHỈ khi nền do provider AI.
    Loại `image` có `ad: true` -> nhãn QC (`labels.ad[0]`) cũng vẽ. MỌI chữ
    trên ảnh nằm trong `text_layer` và qua `check_publish_llm`.
  - Ảnh output dựng MỚI từ pixel (Image.new + paste) và lưu PNG không
    exif/pnginfo — không EXIF/GPS/XMP/ICC.
  - Từ chối TRƯỚC khi gọi provider (0 file, 0 dòng DB), theo thứ tự:
    config | precheck của content (sku_la/kenh_la/loai_la/ruou) |
    maket_xnqc (MỌI SKU TPBVSK — "creative TPBVSK phải dùng maket XNQC")
    | sku_la (thiếu SKU) | kenh_la (kênh ngoài image_studio.json) |
    readiness (∉ TP_THUONG/QC_DAY_DU) | format_la | headline (rỗng/dài/
    guardrail) | prompt_cam (mô tả nền) | font (thiếu glyph) | config/
    headline (không vừa ô) | packshot_thieu / packshot_loi | provider.
  - Chỉ là NHÁP: `save_image` ghi `content_drafts` content_type 'image'
    (status mặc định pending) + `image_assets`. Danh tính asset =
    (file_sha256, sku, channel, format) = 1 mục CLI: cùng ảnh cho 2 kênh /
    2 SKU có packshot y hệt / 2 format cùng cỡ = 2 nháp, chung file PNG +
    sidecar. Sidecar mô tả FILE — không chứa sku/kênh/format/sha file
    packshot gốc (ngữ cảnh của từng dòng `image_assets`/nháp), nên `meta`
    mọi dòng cùng ảnh == sidecar. Module này không có đường chuyển trạng
    thái/duyệt/đăng và không gọi mạng.

Provider nền: env `IMAGE_PROVIDER` đọc LÚC GỌI, mặc định `none` (gradient
tất định từ `brand_colors`, 0 lời gọi mạng). Chỗ cắm provider thật
(external-dep — key + hợp đồng API sinh ảnh, có phí): hàm
`fn(prompt, size) -> (PIL.Image, {"model": str})` đăng ký vào `PROVIDERS`;
hàm đó PHẢI bọc như `pipelines.llm_gateway` (kill-switch LLM_KILL + trần chi
phí tháng agent `image` trong data/llm_gateway.json + ghi `llm_usage`) —
v6.2 chưa cắm, chưa có cap. Provider trả ảnh sai kích thước -> lỗi (không
resize ngầm).

CLI:
  python -m pipelines.image_studio --sku mat-ong-sam-300ml --channel facebook
      [--format 1:1] [--format 9:16] --headline "..." [--scene "..."]
      [--by agent:mkt03]
  `--sku all` = mọi SKU golden. Packshot `<PACKSHOT_DIR>/<sku_key>.png`
  (mặc định data/packshots/), output `<IMAGE_OUT_DIR>/<sha256>.png` +
  `.json` (mặc định data/image_assets/). Exit 0 khi không `failed`; 1 khi có
  `failed`; 2 khi usage sai / IMAGE_PROVIDER chưa cắm / DB không kết nối
  (kiểm TRƯỚC mọi lời gọi provider).
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
from contextlib import suppress
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import psycopg
from PIL import Image, ImageChops, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo
from psycopg.types.json import Jsonb

from pipelines import content, guardrail, store
from pipelines.guardrail_llm import check_publish_llm
from pipelines.llm_gateway import is_health_question

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "image_studio.json"
DEFAULT_PACKSHOT_DIR = ROOT / "data" / "packshots"
DEFAULT_OUT_DIR = ROOT / "data" / "image_assets"
TEMPLATE = "image_background"
CONTENT_TYPE = "image"
DEFAULT_BY = "agent:mkt03"
READY_LEVELS = ("TP_THUONG", "QC_DAY_DU")
SIDECAR_SCHEMA = "image_asset@1"
MAKET_REASON = "creative TPBVSK phải dùng maket XNQC"
MAX_SCENE = 300
FONT_PROBE_PX = 32
_MISSING_GLYPH = "\ue000"   # PUA — font thường không có -> mask glyph thiếu
_SKU_FILE_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")


class ImageProviderError(Exception):
    """Provider nền lạ/lỗi/trả ảnh sai — compose từ chối `provider`."""


# ---------------------------------------------------------------- config

def _rgb(v, n: int) -> tuple:
    if not (isinstance(v, list) and len(v) == n
            and all(isinstance(x, int) and not isinstance(x, bool)
                    and 0 <= x <= 255 for x in v)):
        raise ValueError(f"màu phải là {n} số nguyên 0..255")
    return tuple(v)


def _box(v) -> tuple:
    if not (isinstance(v, list) and len(v) == 4
            and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                    for x in v)):
        raise ValueError("box phải là [x, y, w, h] (phần trăm)")
    x, y, w, h = (float(t) for t in v)
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > 100 or y + h > 100:
        raise ValueError("box ngoài khung 0..100%")
    return (x, y, w, h)


def _overlap(a, b) -> bool:
    return (a[0] < b[0] + b[2] and b[0] < a[0] + a[2]
            and a[1] < b[1] + b[3] and b[1] < a[1] + a[3])


def load_config(path=None) -> tuple[dict | None, str | None]:
    """data/image_studio.json đã validate -> (cfg, None) | (None, lý do).
    headline_box/label_box giao packshot_box -> lỗi (chữ/nhãn không được
    nằm trên vùng packshot)."""
    try:
        doc = json.loads(Path(path or CONFIG).read_text(encoding="utf-8"))
        formats, layout = {}, {}
        for name, wh in doc["formats"].items():
            if not (isinstance(wh, list) and len(wh) == 2 and all(
                    isinstance(v, int) and not isinstance(v, bool)
                    and 64 <= v <= 4096 for v in wh)):
                raise ValueError(f"format {name}: kích thước phải 64..4096")
            boxes = {k: _box(doc["layout"][name][k])
                     for k in ("packshot_box", "headline_box", "label_box")}
            for k in ("headline_box", "label_box"):
                if _overlap(boxes[k], boxes["packshot_box"]):
                    raise ValueError(f"{k} giao packshot_box (format {name})"
                                     " — chữ/nhãn không được đè vùng packshot")
            formats[str(name)] = (wh[0], wh[1])
            layout[str(name)] = boxes
        lab, hl = doc["label"], doc["headline"]
        cfg = {
            "channels": [str(c) for c in doc["channels"]],
            "formats": formats,
            "layout": layout,
            "label": {"font_ratio": float(lab["font_ratio"]),
                      "font_px_min": int(lab["font_px_min"]),
                      "plate_rgba": _rgb(lab["plate_rgba"], 4),
                      "text_rgb": _rgb(lab["text_rgb"], 3),
                      "padding_px": int(lab["padding_px"])},
            "headline": {"max_chars": int(hl["max_chars"]),
                         "font_ratio": float(hl["font_ratio"]),
                         "text_rgb": _rgb(hl["text_rgb"], 3)},
            "brand_colors": [_rgb(c, 3) for c in doc["brand_colors"]],
            "default_scene": str(doc["default_scene"]),
            "fonts": [str(f) for f in doc["fonts"]],
            "max_pixels": int(doc["packshot"]["max_pixels"]),
            "max_bytes": int(doc["packshot"]["max_bytes"]),
            "prompt_banned": [str(x) for x in doc["prompt_banned"]
                              if str(x).strip()],
        }
        if (not cfg["channels"] or not formats
                or len(cfg["brand_colors"]) != 2 or not cfg["prompt_banned"]
                or not cfg["default_scene"].strip()
                or min(cfg["label"]["font_px_min"],
                       cfg["headline"]["max_chars"], cfg["max_pixels"],
                       cfg["max_bytes"]) < 1
                or cfg["label"]["font_ratio"] <= 0
                or cfg["headline"]["font_ratio"] <= 0
                or cfg["label"]["padding_px"] < 0):
            raise ValueError("thiếu kênh/format/màu/từ cấm hoặc giá trị ≤ 0")
    except (OSError, ValueError, KeyError, TypeError, IndexError,
            AttributeError) as e:
        return None, (f"image_studio.json không dùng được "
                      f"({type(e).__name__}: {str(e)[:160]})")
    return cfg, None


def _px(box, size) -> tuple[int, int, int, int]:
    """Box phần trăm -> (x, y, w, h) pixel. Tính theo 2 góc nên 2 ô kề nhau
    (y1 của ô trên == y0 của ô dưới) không bao giờ giao nhau vì làm tròn."""
    W, H = size
    x0, y0 = round(box[0] * W / 100), round(box[1] * H / 100)
    x1 = round((box[0] + box[2]) * W / 100)
    y1 = round((box[1] + box[3]) * H / 100)
    return (x0, y0, x1 - x0, y1 - y0)


# ------------------------------------------------------- nền (provider)

def _bg_none(prompt, size):
    """Nền TẤT ĐỊNH: gradient dọc 2 màu thương hiệu (bản dev) — bỏ qua
    prompt, 0 mạng."""
    cfg, err = load_config()
    if err:
        raise ImageProviderError(err)
    c0, c1 = cfg["brand_colors"]
    mask = Image.linear_gradient("L").resize(size, Image.Resampling.BILINEAR)
    img = Image.composite(Image.new("RGB", size, c1),
                          Image.new("RGB", size, c0), mask)
    return img, {"model": "none"}


# name -> fn(prompt, size) -> (PIL.Image, {"model": str}). Provider thật =
# external-dep (docstring module: phải bọc kill/cap/usage như llm_gateway).
PROVIDERS = {"none": _bg_none}


def _provider_name(provider) -> str:
    name = provider if provider is not None else \
        os.environ.get("IMAGE_PROVIDER")
    return (str(name).strip() if name is not None else "") or "none"


def generate_background(prompt: str | None, size: tuple[int, int], *,
                        provider: str | None = None
                        ) -> tuple[Image.Image, dict]:
    """Ảnh nền RGB đúng `size` + meta {"provider", "model",
    "ai_generated"}. Provider None -> env IMAGE_PROVIDER (mặc định `none`).
    Provider CHỈ nhận (prompt, size) — không có đường đưa ảnh sản phẩm vào.
    Tên lạ / lỗi / sai kích thước / không khai model -> ImageProviderError
    (fail-closed, không resize ngầm)."""
    name = _provider_name(provider)
    fn = PROVIDERS.get(name)
    if fn is None:
        raise ImageProviderError(
            f"chưa cắm provider {name[:40]!r} — API sinh ảnh là external-dep "
            f"(key + hợp đồng); hỗ trợ: {', '.join(sorted(PROVIDERS))}")
    size = (int(size[0]), int(size[1]))
    ai = name != "none"
    try:
        img, info = fn(prompt if ai else None, size)
    except ImageProviderError:
        raise
    except Exception as e:  # lỗi provider bất kỳ -> từ chối `provider`
        raise ImageProviderError(
            f"provider {name} lỗi ({type(e).__name__})") from e
    if not isinstance(img, Image.Image) or img.size != size:
        raise ImageProviderError(
            f"provider {name} trả ảnh sai kích thước (cần {size[0]}x{size[1]})"
            " — không resize ngầm")
    model = info.get("model") if isinstance(info, dict) else None
    if not isinstance(model, str) or not model.strip():
        raise ImageProviderError(f"provider {name} không khai model — không "
                                 "truy vết được")
    return img.convert("RGB"), {"provider": name, "model": model.strip()[:100],
                                "ai_generated": ai}


def _clean(s) -> str:
    """NFC, bỏ ký tự điều khiển/vô hình (Cc/Cf), gộp khoảng trắng — chữ vẽ
    lên ảnh == chữ guardrail chấm."""
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFC", s)
    s = "".join(c for c in s if c.isspace()
                or unicodedata.category(c) not in ("Cc", "Cf"))
    return " ".join(s.split())


def check_scene(scene) -> dict | None:
    """Mô tả nền do người nhập -> {"code": "prompt_cam", "reason"} | None.
    Kiểm trên `_clean(scene)` — đúng chuỗi `background_prompt` đưa vào
    prompt. Chặn: từ `prompt_banned` (chuẩn hóa như guardrail — NFC,
    casefold, có/không dấu, ký tự chèn), câu nhắc sức khỏe/bệnh
    (`is_health_question`), `guardrail.check` không ok. Rỗng/None = dùng
    `default_scene`."""
    if scene is None or (isinstance(scene, str) and not scene.strip()):
        return None
    if not isinstance(scene, str):
        return {"code": "prompt_cam", "reason": "mô tả nền không phải chuỗi"}
    cfg, err = load_config()
    if err:
        return {"code": "config", "reason": err}
    # Kiểm ĐÚNG chuỗi sẽ vào prompt (background_prompt dùng _clean): bỏ cả
    # Cc (\x01, \x7f...) — chỉ bỏ Cf thì "lo\x01go" lọt kiểm rồi nối lại
    # thành "logo" trong prompt (nghiệm thu v6.2).
    s = _clean(scene)
    if len(s) > MAX_SCENE:
        return {"code": "prompt_cam",
                "reason": f"mô tả nền dài hơn {MAX_SCENE} ký tự"}
    hits = (guardrail._find_terms(s, cfg["prompt_banned"])
            + guardrail._filler_hits(s, cfg["prompt_banned"]))
    if hits:
        terms = ", ".join(dict.fromkeys(h["term"] for h in hits))
        return {"code": "prompt_cam",
                "reason": f"mô tả nền có từ cấm ({terms}) — nền chỉ là bối "
                          "cảnh: không người/y tế, không chữ/nhãn/logo/bao bì"}
    if is_health_question(s):
        return {"code": "prompt_cam",
                "reason": "mô tả nền nhắc sức khỏe/bệnh — nền không được gợi "
                          "công dụng"}
    g = guardrail.check(s)
    if g.get("ok") is not True:
        codes = ", ".join(dict.fromkeys(
            str(v.get("code") or v.get("type"))
            for v in g.get("violations") or [])) or "?"
        return {"code": "prompt_cam",
                "reason": f"mô tả nền vi phạm guardrail ({codes})"}
    return None


def background_prompt(scene) -> tuple[str, str, str]:
    """(prompt, version, template_sha256) từ template `image_background`
    (manifest data/prompts — lệch sha -> ValueError). `{scene}` thay bằng
    str.replace; scene rỗng -> `default_scene` của config."""
    cfg, err = load_config()
    if err:
        raise ValueError(err)
    tmpl, ver, sha = content.load_template(TEMPLATE)
    s = _clean(scene) or cfg["default_scene"]
    return tmpl.replace("{scene}", s), ver, sha


# ------------------------------------------------------------- precheck

def precheck_image(sku, channel, fmt, *, readiness=None) -> dict | None:
    """Từ chối rẻ (0 provider, 0 file) -> {"code", "reason"} | None.
    Tái dùng `content.precheck` (rượu kiểm theo category TRƯỚC readiness —
    map tiêm QC_DAY_DU vẫn từ chối); `xnqc` của nó thay bằng `maket_xnqc`
    cho MỌI SKU TPBVSK (kể cả QC_DAY_DU — creative TPBVSK chỉ dùng maket
    XNQC, xnqc_records chưa có)."""
    cfg, err = load_config()
    if err:
        return {"code": "config", "reason": err}
    ref = content.precheck(sku, channel, CONTENT_TYPE, readiness=readiness)
    if ref and ref["code"] != "xnqc":
        return ref
    if sku is None:
        return {"code": "sku_la",
                "reason": "ảnh cần SKU có packshot (ảnh sản phẩm thật)"}
    gcfg, gerr = content._cfg()
    if gerr:
        return {"code": "config", "reason": gerr}
    if gcfg["golden"][sku].get("category") == "tpbvsk":
        return {"code": "maket_xnqc",
                "reason": f"{sku} là TPBVSK — {MAKET_REASON} (hồ sơ XNQC chưa "
                          "có — external-dep); agent không tạo biến thể ảnh"}
    if channel not in cfg["channels"]:
        return {"code": "kenh_la",
                "reason": f"kênh {str(channel)[:40]!r} không hỗ trợ cho ảnh "
                          f"({', '.join(cfg['channels'])})"}
    level = content._level(gcfg, sku, channel, readiness)
    if level not in READY_LEVELS:
        return {"code": "readiness",
                "reason": f"{sku} mức {level} trên kênh {channel} — chưa đủ "
                          "điều kiện ảnh quảng cáo (cần TP_THUONG/QC_DAY_DU: "
                          "tự công bố đã xác minh + kênh trong "
                          "allowed_channels)"}
    if not isinstance(fmt, str) or fmt not in cfg["formats"]:
        return {"code": "format_la",
                "reason": f"format {str(fmt)[:20]!r} không có trong "
                          f"image_studio.json ({', '.join(cfg['formats'])})"}
    return None


# ----------------------------------------------------------------- font

def _font_covers(font, text: str) -> bool:
    miss = font.getmask(_MISSING_GLYPH)
    key = (miss.size, bytes(miss))
    for ch in dict.fromkeys(unicodedata.normalize("NFC", text)):
        if ch.isspace():
            continue
        m = font.getmask(ch)
        if (m.size, bytes(m)) == key:
            return False
    return True


def fonts_for(text: str):
    """Font đầu tiên (env IMAGE_FONT rồi `fonts` của config) phủ đủ glyph
    MỌI ký tự không-khoảng-trắng của `text` (NFC) — so mask từng ký tự với
    mask glyph thiếu (U+E000), không dùng fontTools. Không font nào ->
    None (compose từ chối `font`, không vẽ ô vuông). Trả font cỡ
    FONT_PROBE_PX — caller đổi cỡ bằng `font_variant(size=...)`."""
    cfg, _ = load_config()
    cands = [os.environ.get("IMAGE_FONT") or ""] + (cfg["fonts"] if cfg
                                                     else [])
    for p in dict.fromkeys(c.strip() for c in cands if c and c.strip()):
        try:
            font = ImageFont.truetype(p, FONT_PROBE_PX)
        except (OSError, ValueError):
            continue
        if _font_covers(font, text):
            return font
    return None


def _measure(d, text, font, spacing) -> tuple[int, int, int, int]:
    return d.multiline_textbbox((0, 0), text, font=font, spacing=spacing)


def _wrap(d, text: str, font, width: int) -> str | None:
    """Ngắt dòng tham lam theo từ cho vừa `width`; 1 từ dài hơn -> None."""
    lines, cur = [], ""
    for w in text.split():
        cand = f"{cur} {w}" if cur else w
        if d.textlength(cand, font=font) <= width:
            cur = cand
            continue
        if not cur or d.textlength(w, font=font) > width:
            return None
        lines.append(cur)
        cur = w
    lines.append(cur)
    return "\n".join(lines)


def _layout_text(font, cfg, fmt, headline, labels):
    """Dựng lớp chữ (RGBA trong suốt) -> (overlay, lbox, hbox, pbox) |
    (None, code, reason). Nhãn cỡ CỐ ĐỊNH max(font_px_min, font_ratio×H) —
    không vừa -> config; headline tự thu nhỏ tới cỡ nhãn, không vừa ->
    headline."""
    W, H = cfg["formats"][fmt]
    lay, lab = cfg["layout"][fmt], cfg["label"]
    lbox = _px(lay["label_box"], (W, H))
    hbox = _px(lay["headline_box"], (W, H))
    pbox = _px(lay["packshot_box"], (W, H))
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    pad = lab["padding_px"]
    lsize = max(lab["font_px_min"], round(lab["font_ratio"] * H))
    lfont = font.font_variant(size=lsize)
    sp = max(2, lsize // 4)
    ltext = "\n".join(labels)
    l0, t0, r0, b0 = _measure(d, ltext, lfont, sp)
    if r0 - l0 > lbox[2] - 2 * pad or b0 - t0 > lbox[3] - 2 * pad:
        return None, "config", (f"nhãn cỡ {lsize}px không vừa label_box "
                                f"format {fmt} — sửa layout (không thu nhỏ "
                                "nhãn)")
    hfont = htext = None
    hsize = max(lsize, round(cfg["headline"]["font_ratio"] * H))
    while hsize >= lsize:
        f = font.font_variant(size=hsize)
        t = _wrap(d, headline, f, hbox[2])
        if t is not None:
            hl, ht, hr, hb = _measure(d, t, f, max(2, hsize // 5))
            if hr - hl <= hbox[2] and hb - ht <= hbox[3]:
                hfont, htext = f, t
                break
        hsize -= max(1, hsize // 10)
    if hfont is None:
        return None, "headline", (f"headline không vừa headline_box format "
                                  f"{fmt} (cỡ tối thiểu {lsize}px)")
    x, y, w, h = lbox
    d.rectangle((x, y, x + w - 1, y + h - 1), fill=lab["plate_rgba"])
    d.multiline_text((x + pad - l0, y + (h - (b0 - t0)) // 2 - t0), ltext,
                     font=lfont, fill=lab["text_rgb"] + (255,), spacing=sp)
    hsp = max(2, hfont.size // 5)
    hl, ht, hr, hb = _measure(d, htext, hfont, hsp)
    x, y, w, h = hbox
    d.multiline_text((x + (w - (hr - hl)) // 2 - hl,
                      y + (h - (hb - ht)) // 2 - ht), htext, font=hfont,
                     fill=cfg["headline"]["text_rgb"] + (255,), spacing=hsp,
                     align="center")
    return overlay, lbox, hbox, pbox


# ------------------------------------------------------------- packshot

def _load_packshot(pdir: Path, sku: str, cfg: dict):
    """-> ({"img": RGBA, "file_sha256"}, None) | (None, (code, reason)).
    Kiểm kích thước byte + pixel TRƯỚC `load()` (chống bomb); chỉ PNG."""
    if not _SKU_FILE_RE.fullmatch(sku):
        return None, ("packshot_loi", "sku_key không hợp lệ làm tên file")
    path = pdir / f"{sku}.png"
    if not path.is_file():
        return None, ("packshot_thieu",
                      (f"thiếu packshot {sku}.png trong PACKSHOT_DIR — công "
                       "ty cấp ảnh sản phẩm thật (PNG nền trong suốt)"))
    try:
        if path.stat().st_size > cfg["max_bytes"]:
            return None, ("packshot_loi", (f"packshot {sku} lớn hơn "
                                           f"{cfg['max_bytes']} byte"))
        raw = path.read_bytes()
        with Image.open(BytesIO(raw)) as im:
            if im.format != "PNG":
                return None, ("packshot_loi",
                              f"packshot {sku} không phải PNG ({im.format})")
            if im.width * im.height > cfg["max_pixels"]:
                return None, ("packshot_loi",
                              (f"packshot {sku} {im.width}x{im.height} vượt "
                               f"{cfg['max_pixels']} pixel"))
            im.load()
            rgba = im.convert("RGBA")
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) \
            as e:
        return None, ("packshot_loi",
                      f"packshot {sku} không đọc được ({type(e).__name__})")
    return {"img": rgba, "file_sha256": hashlib.sha256(raw).hexdigest()}, None


def _fit_packshot(img: Image.Image, box) -> Image.Image:
    """Chỉ THU NHỎ (không phóng) 1 lần LANCZOS giữ tỉ lệ cho vừa ô. RGB dưới
    alpha 0 (không hiện lên ảnh) chuẩn hóa về 0 — 2 file cùng hình khác
    "rác" vùng trong suốt ra cùng ảnh thì cũng cùng `fitted_sha256`."""
    w, h = img.size
    scale = min(box[2] / w, box[3] / h, 1.0)
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                         Image.Resampling.LANCZOS)
    seen = img.getchannel("A").point(lambda a: 255 if a else 0)
    return Image.composite(img, Image.new("RGBA", img.size), seen)


def _solid(fitted: Image.Image) -> Image.Image:
    """Mặt nạ L: 255 đúng tại pixel alpha 255 (pixel đặc) của packshot."""
    return fitted.getchannel("A").point(lambda a: 255 if a == 255 else 0)


def _paste_packshot(canvas: Image.Image, fitted: Image.Image, xy):
    """Dán packshot SAU CÙNG bằng alpha của chính nó (pixel đặc = giữ
    nguyên RGB gốc). Không lớp nào được vẽ sau bước này."""
    canvas.paste(fitted.convert("RGB"), xy, fitted.getchannel("A"))
    return canvas


def verify_packshot(img, fitted, box) -> bool:
    """True khi MỌI pixel alpha 255 của `fitted` khớp TUYỆT ĐỐI (RGB) với
    `img` tại vị trí `box` (x, y[, w, h]). 0 pixel đặc / lệch 1 pixel / ra
    ngoài khung / input hỏng -> False. Thuần (không I/O)."""
    try:
        x, y = int(box[0]), int(box[1])
        fw, fh = fitted.size
        if x < 0 or y < 0 or x + fw > img.width or y + fh > img.height:
            return False
        solid = _solid(fitted)
        if solid.getbbox() is None:
            return False
        diff = ImageChops.difference(
            img.convert("RGB").crop((x, y, x + fw, y + fh)),
            fitted.convert("RGB"))
        return Image.composite(diff, Image.new("RGB", diff.size),
                               solid).getbbox() is None
    except (AttributeError, TypeError, ValueError, IndexError):
        return False


def _changed_ratio(a: Image.Image, b: Image.Image) -> float:
    """Tỉ lệ pixel khác nhau (bất kỳ kênh RGB) giữa 2 ảnh cùng cỡ."""
    r, g, bl = ImageChops.difference(a.convert("RGB"),
                                     b.convert("RGB")).split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    return m.point(lambda v: 255 if v else 0).histogram()[255] / (
        m.width * m.height)


def _color_mask(img: Image.Image, rgb) -> Image.Image:
    """Mặt nạ L: 255 tại pixel đúng bằng `rgb`. Trong label_box chỉ CHỮ
    nhãn (tô đặc `label.text_rgb`) ra đúng màu này — tấm nền bán trong suốt
    pha nền không bao giờ trùng tuyệt đối -> QA/eval đo được nhãn có vẽ chữ
    thật (so với nền trơn thì riêng tấm nền đã khác 100%)."""
    r, g, bl = ImageChops.difference(
        img.convert("RGB"), Image.new("RGB", img.size, tuple(rgb))).split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    return m.point(lambda v: 255 if v == 0 else 0)


# -------------------------------------------------------------- compose

def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _write_atomic(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=path.suffix,
                               dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        with suppress(OSError):
            os.unlink(tmp)


def _same_sidecar(path: Path, meta: dict) -> dict | None:
    """Sidecar đã có trên đĩa -> giữ (trả bản đĩa) CHỈ khi mọi field trừ
    `created_at` trùng meta vừa tính. Hỏng / bị sửa tay (vd ai_generated
    false, bỏ nhãn) / lệch -> None (caller ghi lại) — metadata truy vết
    không lấy từ file chưa kiểm (rà OWASP A08 v6.2)."""
    try:
        d = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None
    if not (isinstance(d, dict) and isinstance(d.get("created_at"), str)):
        return None
    strip = {k: v for k, v in meta.items() if k != "created_at"}
    return d if {k: v for k, v in d.items() if k != "created_at"} == strip \
        else None


def compose(sku, channel, headline, *, fmt="1:1", scene=None, readiness=None,
            provider=None, packshot_dir=None, out_dir=None) -> dict:
    """Ghép 1 ảnh nháp. Từ chối -> ok False, `refused` {code, reason},
    0 file (thứ tự từ chối ở docstring module). Thành công -> PNG
    `<out>/<sha256>.png` + sidecar `.json` (PNG cùng tên giữ nguyên CHỈ khi
    bytes đúng sha, lệch -> ghi lại; sidecar giữ nguyên khi trùng mọi field
    trừ created_at, lệch/bị sửa tay -> ghi lại; sidecar không chứa ngữ
    cảnh dòng — `channel`/`sku`/`format`/`packshot_sha256` (sha file gốc)
    trả riêng cho save_image), `meta` = sidecar, `draft_text` =
    text_layer + dòng tên file (sha ràng ảnh vào bản duyệt). `fitted`/
    `packshot_xy` = chuẩn so toàn vẹn (QA/eval gọi lại `verify_packshot`)."""
    out = {"ok": False, "refused": None, "path": None, "sidecar": None,
           "sha256": None, "channel": None, "sku": None, "format": None,
           "packshot_sha256": None, "text_layer": "",
           "draft_text": "", "guardrail": None, "meta": None, "fitted": None,
           "packshot_xy": None}

    def refuse(code, reason, g=None, **kw):
        ref = {"code": code, "reason": reason}
        return {**out, **kw, "refused": ref,
                "guardrail": g if g is not None
                else content._refused_guardrail(ref)}

    cfg, err = load_config()
    if err:
        return refuse("config", err)
    ref = precheck_image(sku, channel, fmt, readiness=readiness)
    if ref:
        return refuse(ref["code"], ref["reason"])
    # (5) Chữ trên ảnh: headline + nhãn do CODE chèn (_with_required) —
    # nhãn AI luôn đứng đầu nhóm nhãn.
    hl = _clean(headline)
    if not hl:
        return refuse("headline", "headline rỗng")
    if len(hl) > cfg["headline"]["max_chars"]:
        return refuse("headline", f"headline {len(hl)} ký tự > "
                                  f"{cfg['headline']['max_chars']}")
    _canon, ai, _ad = content._publish_texts()
    if not ai:
        return refuse("config", "guardrail_rules.json thiếu labels.ai")
    ctx = {"channel": channel, "content_type": CONTENT_TYPE, "sku": sku,
           "readiness": readiness}
    full = content._with_required(hl, **ctx)
    pieces = [p.strip() for p in full[len(hl):].split("\n\n") if p.strip()]
    labels = [ai[0]] + [p for p in pieces if p != ai[0]]
    text_layer = "\n".join([hl, *labels])
    g = check_publish_llm(text_layer, is_ai=True, **ctx)
    if g.get("ok") is not True:
        codes = ", ".join(dict.fromkeys(
            str(v.get("code") or v.get("type"))
            for v in g.get("violations") or [])) or "?"
        return refuse("headline", f"chữ trên ảnh vi phạm guardrail ({codes})",
                      g, text_layer=text_layer)
    # (6) mô tả nền
    ref = check_scene(scene)
    if ref:
        return refuse(ref["code"], ref["reason"], text_layer=text_layer)
    # (7) font phủ đủ glyph + bố cục chữ vừa ô
    font = fonts_for(text_layer)
    if font is None:
        return refuse("font", "không font nào (IMAGE_FONT / fonts trong "
                      "image_studio.json) phủ đủ glyph chữ trên ảnh — không "
                      "vẽ ô vuông", text_layer=text_layer)
    laid = _layout_text(font, cfg, fmt, hl, labels)
    if laid[0] is None:
        return refuse(laid[1], laid[2], text_layer=text_layer)
    overlay, lbox, hbox, pbox = laid
    # (8) packshot thật — thu nhỏ vừa ô, phải có pixel đặc
    pdir = Path(packshot_dir or os.environ.get("PACKSHOT_DIR")
                or DEFAULT_PACKSHOT_DIR)
    pk, perr = _load_packshot(pdir, sku, cfg)
    if perr:
        return refuse(*perr, text_layer=text_layer)
    fitted = _fit_packshot(pk["img"], pbox)
    if _solid(fitted).getbbox() is None:
        return refuse("packshot_loi", "packshot không có pixel đặc (alpha "
                      "255) — không kiểm được toàn vẹn nhãn",
                      text_layer=text_layer)
    xy = (pbox[0] + (pbox[2] - fitted.width) // 2,
          pbox[1] + (pbox[3] - fitted.height) // 2)
    # (9) nền — provider CHỈ nhận (prompt, size)
    W, H = cfg["formats"][fmt]
    name = _provider_name(provider)
    prompt = ver = tsha = None
    if name != "none":
        try:
            prompt, ver, tsha = background_prompt(scene)
        except ValueError as e:
            return refuse("config", str(e), text_layer=text_layer)
    try:
        bg, bmeta = generate_background(prompt, (W, H), provider=name)
    except ImageProviderError as e:
        return refuse("provider", str(e), text_layer=text_layer)

    canvas = Image.alpha_composite(bg.convert("RGBA"), overlay).convert("RGB")
    canvas = _paste_packshot(canvas, fitted, xy)
    final = Image.new("RGB", (W, H))     # dựng mới từ pixel: không info/EXIF
    final.paste(canvas, (0, 0))
    odir = Path(out_dir or os.environ.get("IMAGE_OUT_DIR") or DEFAULT_OUT_DIR)
    odir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".png", dir=odir)
    os.close(fd)
    try:
        final.save(tmp, format="PNG")
        data = Path(tmp).read_bytes()
        with Image.open(BytesIO(data)) as back:
            back.load()
            intact = verify_packshot(back, fitted, xy)
        if not intact:
            return refuse("packshot_lech",
                          "vùng packshot trong ảnh đã ghi lệch pixel so với "
                          "packshot gốc — loại ảnh (không lớp nào được vẽ đè "
                          "nhãn sản phẩm)", text_layer=text_layer)
        sha = _sha(data)
        png = odir / f"{sha}.png"
        # File cùng tên chỉ được giữ khi bytes đúng sha — tên không chứng
        # minh nội dung (ảnh bị ghi đè tay/hỏng -> ghi lại bản vừa kiểm).
        try:
            same = _sha(png.read_bytes()) == sha
        except OSError:
            same = False
        if not same:
            os.replace(tmp, png)
    finally:
        with suppress(OSError):
            os.unlink(tmp)

    # Sidecar mô tả FILE (1 ảnh = 1 sidecar): chỉ field cùng giá trị cho
    # MỌI mục (SKU × kênh × format) ra đúng ảnh này. KHÔNG chứa sku/kênh/
    # format/sha file packshot gốc — 2 SKU packshot y hệt (kể cả 2 file khác
    # bytes cùng pixel), 2 kênh, 2 format cùng cỡ đều ra cùng ảnh; các thứ
    # đó nằm ở cột image_assets/nháp của từng dòng. `fitted_sha256` = sha
    # RGBA packshot đã thu nhỏ (RGB vùng trong suốt chuẩn hóa 0).
    side = odir / f"{sha}.json"
    meta = {
        "schema": SIDECAR_SCHEMA, "file": png.name, "asset_sha256": sha,
        "size": [W, H],
        "ai_generated": bmeta["ai_generated"], "labels": labels,
        "label_box": list(lbox), "headline": hl, "headline_box": list(hbox),
        "packshot": {"fitted_sha256": _sha(fitted.tobytes()),
                     "box": [xy[0], xy[1], fitted.width, fitted.height]},
        "background": {"provider": bmeta["provider"], "model": bmeta["model"],
                       "prompt": prompt,
                       "prompt_sha256": (_sha(prompt.encode("utf-8"))
                                         if prompt else None),
                       "prompt_version": ver, "template_sha256": tsha},
        "created_at": datetime.now(timezone.utc).isoformat(
            timespec="seconds"),
        "guardrail_ok": True,
    }
    kept = _same_sidecar(side, meta)
    if kept is not None:
        meta = kept           # cùng ảnh cùng ngữ cảnh: giữ file, giữ ngày
    else:
        _write_atomic(side, json.dumps(meta, ensure_ascii=False,
                                       indent=2).encode("utf-8"))
    return {**out, "ok": True, "path": str(png), "sidecar": str(side),
            "sha256": sha, "channel": channel, "sku": sku, "format": fmt,
            "packshot_sha256": pk["file_sha256"], "text_layer": text_layer,
            "draft_text": f"{text_layer}\n\nTệp ảnh: {png.name}",
            "guardrail": g, "meta": meta, "fitted": fitted,
            "packshot_xy": xy}


# --------------------------------------------------------------- lưu DB

_ASSET_SQL = (
    "insert into image_assets (file_sha256, file_name, sku, channel, format, "
    "ai_generated, label_text, provider, model, prompt_sha256, "
    "prompt_version, packshot_sha256, draft_id, meta, created_by) values "
    "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
    "returning id")


def save_image(conn, res: dict, *, by: str, source: str = store.SOURCE_CLI
               ) -> dict:
    """Lưu ảnh nháp: `res` = compose ok=True (khác -> ValueError).
    Danh tính asset = (file_sha256, sku, channel, format) — đúng 1 mục CLI:
    đã có `image_assets` cùng ảnh CÙNG sku + kênh + format -> {"status":
    "skipped", "draft_id"} (kể cả nháp đó đã bị reject — muốn ảnh mới thì
    đổi headline/scene); cùng ảnh khác SKU (packshot y hệt) / kênh / format
    -> nháp + dòng asset riêng (chung file PNG + sidecar; sku/kênh/format/
    sha file packshot gốc lấy từ `res`, không từ sidecar). Chưa có ->
    `store.save_draft` (content_type 'image', status DB mặc định pending,
    text = draft_text có tên file sha -> sha bản duyệt ràng cả ảnh) rồi
    INSERT `image_assets` + commit() tường minh (gotcha v2.1).
    UniqueViolation lúc INSERT asset (2 process cùng mục) -> rollback phần
    asset, {"status": "skipped", "orphan_draft_id"} — nháp mồ côi để
    NGƯỜI reject (agent không có quyền xóa). Thành công -> {"status":
    "created", "draft_id", "asset_id"}."""
    if not (isinstance(res, dict) and res.get("ok") is True
            and isinstance(res.get("meta"), dict) and res.get("sha256")):
        raise ValueError("save_image: chỉ lưu kết quả compose ok=True")
    who = (by or "").strip()
    if not who:
        raise ValueError("save_image: thiếu by (người/agent tạo)")
    for k in ("channel", "sku", "format", "packshot_sha256"):
        if not (isinstance(res.get(k), str) and res[k]):
            raise ValueError(f"save_image: thiếu {k}")
    ch, sku, fmt = res["channel"], res["sku"], res["format"]
    m, sha = res["meta"], res["sha256"]
    bg = m["background"]
    row = conn.execute("select draft_id from image_assets where "
                       "file_sha256 = %s and sku = %s and channel = %s "
                       "and format = %s", (sha, sku, ch, fmt)).fetchone()
    if row:
        return {"status": "skipped", "draft_id": row[0]}
    did = store.save_draft(
        conn, f"image {sku} {ch} {fmt}", ch,
        res["draft_text"], res["guardrail"], source, created_by=who,
        content_type=CONTENT_TYPE, sku=sku, is_ai=True,
        prompt_version=bg["prompt_version"],
        prompt_sha256=bg["prompt_sha256"])
    try:
        with conn.transaction():
            aid = conn.execute(_ASSET_SQL, (
                sha, m["file"], sku, ch, fmt,
                bool(m["ai_generated"]), "\n".join(m["labels"]),
                bg["provider"], bg["model"], bg["prompt_sha256"],
                bg["prompt_version"], res["packshot_sha256"], did,
                Jsonb(m), who)).fetchone()[0]
        conn.commit()
    except psycopg.errors.UniqueViolation:
        return {"status": "skipped", "orphan_draft_id": did}
    return {"status": "created", "draft_id": did, "asset_id": aid}


# --------------------------------------------------------- mẫu packshot

def make_sample_packshot(path, sku: str, size=(600, 800), *,
                         exif_gps: bool = False) -> Path:
    """Packshot MẪU (PNG RGBA nền trong suốt, khối nhãn chữ "MẪU" + mã SKU)
    cho test/eval/evidence — KHÔNG phải ảnh sản phẩm thật. Vẽ trên RGB +
    alpha riêng nên mọi pixel thân/nhãn (kể cả viền chữ) là alpha 255 ->
    được so toàn vẹn. `exif_gps=True`: nhúng EXIF (GPS IFD) + XMP để test
    ảnh output không mang metadata."""
    W, H = size
    rgb = Image.new("RGB", (W, H), (0, 0, 0))
    alpha = Image.new("L", (W, H), 0)
    d, da = ImageDraw.Draw(rgb), ImageDraw.Draw(alpha)
    body = (int(W * .18), int(H * .16), int(W * .82), int(H * .97))
    cap = (int(W * .36), int(H * .03), int(W * .64), int(H * .17))
    for dd, c1, c2 in ((d, (122, 74, 32), (40, 40, 40)), (da, 255, 255)):
        dd.rounded_rectangle(body, radius=int(W * .08), fill=c1)
        dd.rectangle(cap, fill=c2)
    lx0, ly0, lx1, ly1 = int(W * .24), int(H * .38), int(W * .76), int(H * .78)
    d.rectangle((lx0, ly0, lx1, ly1), fill=(250, 246, 232))
    font = fonts_for(f"MẪU {sku}")
    big = (font.font_variant(size=max(12, H // 10)) if font
           else ImageFont.load_default())
    small = (font.font_variant(size=max(10, H // 40)) if font
             else ImageFont.load_default())
    cx = (lx0 + lx1) // 2
    d.text((cx, ly0 + (ly1 - ly0) // 3), "MẪU", font=big, fill=(200, 20, 20),
           anchor="mm")
    d.text((cx, ly0 + 2 * (ly1 - ly0) // 3), sku, font=small,
           fill=(20, 20, 20), anchor="mm")
    img = rgb.convert("RGBA")
    img.putalpha(alpha)
    kw = {}
    if exif_gps:
        ex = Image.Exif()
        ex[0x010E] = "MAU packshot test GPS"
        ex[0x8825] = {1: "N", 2: (15.0, 30.0, 0.0), 3: "E",
                      4: (108.0, 0.0, 0.0)}
        info = PngInfo()
        info.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta xmlns:x='adobe:ns:"
                      "meta/'>GPS 15.5N 108E</x:xmpmeta>")
        kw = {"exif": ex, "pnginfo": info}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", **kw)
    return path


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
        res = compose(sku, ch, args.headline, fmt=fmt, scene=args.scene,
                      readiness=readiness)
    except OSError as e:
        return {"status": "failed", "reason": f"lỗi ghi file "
                                              f"({type(e).__name__})"}
    if not res["ok"]:
        return {"status": "refused", **res["refused"]}
    name = Path(res["path"]).name
    try:
        r = save_image(conn, res, by=args.by.strip())
    except psycopg.Error as e:
        with suppress(Exception):
            conn.rollback()
        return {"status": "failed", "reason": f"lỗi DB: {store._db_msg(e)}"}
    return {**r, "file": name}


def main(argv=None) -> int:
    cfg, err = load_config()
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.image_studio",
        description="Sinh ẢNH NHÁP MKT-03 (packshot thật ghép lên nền, nhãn "
                    "'Nội dung có sử dụng AI') vào hàng duyệt (pending) — "
                    "agent KHÔNG đăng")
    ap.add_argument("--sku", action="append", default=[],
                    help="sku_key golden, lặp được; 'all' = mọi SKU golden")
    ap.add_argument("--channel", action="append", default=[],
                    choices=cfg["channels"] if cfg else None,
                    help="kênh, lặp được")
    ap.add_argument("--format", dest="formats", action="append",
                    choices=list(cfg["formats"]) if cfg else None,
                    help="format ảnh, lặp được (mặc định 1:1)")
    ap.add_argument("--headline", required=True, help="chữ chính trên ảnh")
    ap.add_argument("--scene", default=None,
                    help="mô tả bối cảnh nền (chỉ dùng khi có provider AI)")
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
    name = _provider_name(None)
    if name not in PROVIDERS:
        print(f"[error] IMAGE_PROVIDER={name[:40]!r} chưa cắm — API sinh ảnh "
              f"là external-dep; hỗ trợ: {', '.join(sorted(PROVIDERS))}",
              file=sys.stderr)
        return 2
    if name == "none" and (args.scene or "").strip():
        # v13.4: yêu cầu nền AI (--scene) mà chưa có provider → KHÔNG âm thầm
        # bỏ scene rồi ra nền gradient như thể đã đáp ứng.
        print("[blocked] --scene cần nền AI nhưng IMAGE_PROVIDER chưa cấu "
              "hình (none = nền gradient tất định) — BLOCKED: API sinh ảnh "
              "(vendor + hợp đồng/DPA + key + trần chi phí agent `image` "
              "trong data/llm_gateway.json), cắm vào "
              "pipelines.image_studio.PROVIDERS; bỏ --scene để ra nháp "
              "nền gradient", file=sys.stderr)
        return 2
    skus = list(args.sku)
    if "all" in skus:
        gcfg, gerr = content._cfg()
        if gerr:
            print(f"[error] {gerr}", file=sys.stderr)
            return 2
        skus = [s for s in skus if s != "all"] + list(gcfg["golden"])
    fmts = args.formats or ["1:1"]
    items = []
    with store._conn_or_none() as (conn, cerr):
        if conn is None:  # ghi-tác-vụ: DB chết -> exit 2, 0 lời gọi provider
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
    print(f"[done] {len(items)} ảnh — created {n['created']}, skipped "
          f"{n['skipped']}, refused {n['refused']}, failed {n['failed']} "
          "(nháp pending — người duyệt ở tab 'Duyệt & Lịch', người tải ảnh "
          "lên kênh tay; agent không đăng)")
    return 1 if n["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
