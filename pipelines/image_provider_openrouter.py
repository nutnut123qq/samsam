"""r13 marketing-02.1 — adapter nền AI OpenRouter Images API cho `pipelines.image_studio` (provider
`openrouter_images`). Tách khỏi image_studio để module ghép ảnh giữ bất biến "không có đường mạng"; đường mạng DUY
NHẤT là hàm `background` dưới đây, chỉ chạy sau cổng `llm_gateway._gate`."""
import base64
import math
import os
import time
from io import BytesIO

import httpx
from PIL import Image

from pipelines import llm_gateway as gw
from pipelines.image_studio import ImageProviderError

# r13: OpenRouter Images API (docs "Image Generation — dedicated Image API",
# openrouter.ai/docs/features/multimodal/image-generation, đọc 24/10/2026):
# POST {BASE}/images {model, prompt, size "WxH", output_format, n, provider}
# → {"data": [{"b64_json", "media_type"}], "usage": {"cost": USD}}; 502 =
# không hoàn tất, KHÔNG tính phí. Provider CHỈ nhận prompt nền + kích thước
# (packshot ghép tại chỗ). Cổng: kill agent/tính năng, trần tháng agent
# `image` + tính năng marketing-02.1, chi tiêu không đọc được → chặn, rollout
# TẮT → chặn, whitelist provider (llm_gateway) — TRƯỚC mọi request. Model
# phải đặt tường minh IMAGE_MODEL (chọn vendor/model = quyết định ngoài).
IMAGE_AGENT, IMAGE_FEATURE = "image", "marketing-02.1"
IMAGE_TIMEOUT_S = 120.0
IMAGE_MAX_BYTES = 20 * 1024 * 1024
IMAGE_RETRY_STATUS = (429, 502, 503)   # 502/503 không tính phí; tối đa 1 lần thử lại


def _image_http():
    """Điểm DUY NHẤT tạo HTTP client (test thay transport)."""
    return httpx.Client(timeout=IMAGE_TIMEOUT_S, follow_redirects=False)


def background(prompt: str, size: tuple[int, int]):
    model = os.environ.get("IMAGE_MODEL", "").strip()
    if not model:
        raise ImageProviderError("IMAGE_MODEL chưa đặt — chọn model sinh ảnh"
                                 " là quyết định ngoài (vendor/điều khoản/DPA)")
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise ImageProviderError("thiếu OPENROUTER_API_KEY")
    try:
        cfg = gw._gate(IMAGE_AGENT, IMAGE_FEATURE)   # kill/trần/rollout/whitelist
    except gw.GatewayError as e:
        raise ImageProviderError(f"cổng chi phí/tắt chặn: {e}") from None
    body = {"model": model, "prompt": prompt, "size": f"{size[0]}x{size[1]}",
            "output_format": "png", "n": 1,
            "provider": {"only": list(cfg["provider_only"]),
                         "allow_fallbacks": False}}
    resp = None
    with _image_http() as http:
        for attempt in range(2):
            try:
                resp = http.post(f"{gw.BASE_URL}/images", json=body,
                                 headers={"Authorization": f"Bearer {key}"})
            except httpx.HTTPError as e:
                gw._record(IMAGE_AGENT, model, 0, 0, 0.0, False,
                           f"http {type(e).__name__}", IMAGE_FEATURE)
                raise ImageProviderError(f"lỗi kết nối ({type(e).__name__})"
                                         ) from None
            if resp.status_code not in IMAGE_RETRY_STATUS or attempt:
                break
            ra = resp.headers.get("retry-after", "")
            time.sleep(min(float(ra), 10.0) if ra.isdigit() else 2.0)
    if resp.status_code != 200:
        gw._record(IMAGE_AGENT, model, 0, 0, 0.0, False,
                   f"http {resp.status_code}", IMAGE_FEATURE)
        raise ImageProviderError(f"API sinh ảnh trả HTTP {resp.status_code}")
    # r13-fix4 F2: HTTP 200 = provider đã sinh ảnh/tính phí → ghi chi phí ĐÚNG 1
    # lần TRƯỚC khi giải mã/kiểm ảnh, kể cả ảnh hỏng (ghi 0 làm trần tháng hụt
    # khoản đã chi). Không đọc được `usage.cost` hợp lệ → mức dự phòng (fail-closed
    # FinOps, cùng chính sách cũ cho ảnh không kèm cost).
    try:
        doc = resp.json()
    except ValueError:
        doc = None
    usage = doc.get("usage") if isinstance(doc, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    cost = usage.get("cost")
    if not (isinstance(cost, (int, float)) and not isinstance(cost, bool)
            and math.isfinite(cost) and cost >= 0):
        cost = float(cfg.get("image_cost_fallback_usd") or 0.25)
    img, err, label = None, None, None
    try:
        raw = base64.b64decode(doc["data"][0]["b64_json"], validate=True)
    except (ValueError, KeyError, IndexError, TypeError) as e:
        err, label = "response API sinh ảnh sai định dạng", f"response hỏng {type(e).__name__}"
    else:
        if len(raw) > IMAGE_MAX_BYTES:
            err, label = "ảnh trả về quá lớn", "ảnh quá lớn"
        else:
            try:
                img = Image.open(BytesIO(raw))
                img.load()
            except Exception as e:  # noqa: BLE001 — byte không phải ảnh
                err, label = f"ảnh trả về hỏng ({type(e).__name__})", f"ảnh hỏng {type(e).__name__}"
            else:
                if img.format not in ("PNG", "JPEG", "WEBP"):
                    err = label = f"ảnh trả về định dạng {img.format}"
    tok = [v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0
           for v in (usage.get("prompt_tokens"), usage.get("completion_tokens"))]
    gw._record(IMAGE_AGENT, model, tok[0], tok[1], float(cost), err is None,
               label, feature=IMAGE_FEATURE)
    if err:
        raise ImageProviderError(err)
    return img, {"model": model}
