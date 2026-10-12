"""Pipeline sinh draft nội dung FB/TikTok/Zalo/blog từ brief.

Contract:
  draft(brief: str, channel: str = "facebook", *, readiness=None)
      -> {"text": str, "guardrail": dict}
  draft_multi(brief: str, channels, *, readiness=None)
      -> {channel: {"text","guardrail"}}

  - Gọi LLM qua `pipelines.llm_gateway.chat("content", ...)` (v3.1 — PII
    mask + privacy routing + usage/cap; model OR_CHAT_MODEL)
    với system prompt chứa brand voice + claims_whitelist (chỉ được viết
    công dụng trong whitelist).
  - Output BẮT BUỘC qua guardrail CHẾ ĐỘ ĐĂNG BÀI trước khi trả về (v4.2):
    `pipelines.guardrail_llm.check_publish_llm(text, channel=<kênh>,
    content_type="post", is_ai=True)` = luật `check_publish` (XNQC, câu
    khuyến cáo, nhãn AI, "Ngọc Linh"...) + lớp LLM-check phụ nếu cấu hình
    GUARDRAIL_LLM_MODEL (chỉ chặn thêm). Trường "guardrail" = shape
    check_publish + `llm_check`/`llm_model`. Không bao giờ trả text
    chưa-check. Nhãn AI (labels.ai[0]) được nối TẤT ĐỊNH nếu bài thiếu —
    không trông LLM nhớ nhãn.
  - `readiness` (v4.2 fix): map `(sku_key, channel) -> readiness` của view
    `sku_readiness` (caller đọc qua `store.readiness_from_db`/
    `store.readiness_now`) truyền thẳng vào check_publish — None = soi
    gương golden file (fail-closed). Không truyền khi có DB thì bài claim
    SKU đã XNQC vẫn bị `sku_chua_xnqc` (file) và vòng sửa đẩy LLM gỡ claim
    hợp lệ.
  - Câu khuyến cáo trong prompt đọc NGUYÊN VĂN `disclaimer.canonical` của
    data/guardrail_rules.json (không chép tay — Pháp chế sửa 1 chỗ).
  - draft_multi: mỗi kênh 1 draft() riêng — guardrail độc lập; kênh lạ
    fallback hint facebook như draft(). draft() giữ nguyên contract.
"""

import json
import unicodedata
from pathlib import Path

from dotenv import load_dotenv

from pipelines.guardrail_llm import check_publish_llm
from pipelines.llm_gateway import chat

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

CHANNEL_HINT = {
    "facebook": "bài đăng Facebook 120-180 chữ, 1-2 emoji, có CTA inbox/hotline",
    "tiktok": ("kịch bản video TikTok ngắn 30-60 giây: hook 3 giây đầu "
               "+ 2-3 cảnh (mỗi cảnh ghi mô tả hình ảnh + lời thoại/"
               "text overlay) + CTA cuối"),
    "zalo": "tin nhắn Zalo OA ngắn 60-100 chữ, lịch sự, kèm CTA",
    "blog": "mở bài blog 200-300 chữ, có tiêu đề",
}


def _whitelist_block() -> str:
    """Render claims whitelist thành đoạn nhét vào system prompt."""
    raw = json.loads(
        (ROOT / "data" / "claims_whitelist.json").read_text(encoding="utf-8"))
    lines = []
    for sku, v in raw.items():
        if not isinstance(v, dict):
            continue
        claims = v.get("approved_claims") or []
        if claims:
            lines.append(f"- {sku}: " + "; ".join(claims))
        else:
            lines.append(f"- {sku}: CHƯA CÓ công dụng công bố — không được nêu công dụng")
    return "\n".join(lines)


def _publish_texts() -> tuple[str, list[str]]:
    """(câu khuyến cáo chuẩn, nhãn AI) đọc từ data/guardrail_rules.json.
    File hỏng -> ("", []) — guardrail tự fail-closed "config" ở bước check."""
    try:
        doc = json.loads((ROOT / "data" / "guardrail_rules.json")
                         .read_text(encoding="utf-8"))
        canon = str(doc["disclaimer"]["canonical"]).strip()
        labels = [str(x) for x in doc["labels"]["ai"] if str(x).strip()]
    except (OSError, ValueError, KeyError, TypeError):
        return "", []
    return canon, labels


def _with_ai_label(text: str, labels: list[str]) -> str:
    """Nối nhãn AI nếu bài chưa có cụm nào trong labels.ai (so NFC
    casefold) — tất định, không tốn lượt sửa."""
    if not labels:
        return text
    low = unicodedata.normalize("NFC", text).casefold()
    if any(unicodedata.normalize("NFC", lb).casefold() in low
           for lb in labels):
        return text
    return text + "\n\n" + labels[0]


def draft(brief: str, channel: str = "facebook", *,
          readiness: dict | None = None) -> dict:
    """Sinh draft theo brief -> qua guardrail đăng bài (kênh `channel`,
    readiness DB nếu caller truyền) -> trả {"text", "guardrail"}."""
    fmt = CHANNEL_HINT.get(channel, CHANNEL_HINT["facebook"])
    canon, labels = _publish_texts()
    ai_label = labels[0] if labels else "Nội dung có sử dụng AI"

    system = f"""Bạn là copywriter của Công ty TNHH Sâm Sâm (Quảng Nam). Giọng
điệu: tự hào đặc sản quê hương, tử tế, không phóng đại. Viết {fmt}.

LUẬT TPBVSK — vi phạm là bài bị loại:
- CHỈ được nêu công dụng nằm trong whitelist dưới đây của ĐÚNG sản phẩm,
  dùng gần nguyên văn:
{_whitelist_block()}
- Câu trang trí TUYỆT ĐỐI không chứa động từ claim (giúp/hỗ trợ/bồi bổ/
  giảm/tăng cường/cải thiện/tốt cho/phòng ngừa) — những từ đó chỉ xuất
  hiện trong cụm claim whitelist. Mở bài/kết bài chỉ kể chuyện thương
  hiệu, đặc sản quê hương, quà tặng.
- Sản phẩm không có claim -> chỉ giới thiệu, không nêu công dụng.
- Khi nêu công dụng hoặc nhắc sản phẩm TPBVSK, kết bài bằng câu khuyến
  cáo NGUYÊN VĂN (không sửa chữ nào): "{canon}."
- Không dùng tên vùng chỉ dẫn địa lý "Ngọc Linh" (không dùng — chờ Pháp
  chế xác nhận quyền sử dụng chỉ dẫn địa lý cho từng sản phẩm).
- Bài đăng có nhãn "{ai_label}" ở cuối (hệ thống tự thêm nếu thiếu).
- TUYỆT ĐỐI cấm các từ dùng theo nghĩa khẳng định: chữa, điều trị, thuốc,
  khỏi bệnh, trị bệnh, đặc trị, thần dược, tiêu diệt, chống ung thư.
- Không bịa giá — sản phẩm không có giá công khai thì ghi "Liên hệ".
- TRƯỚC KHI XUẤT: rà từng câu — câu nào chứa động từ claim (giúp, hỗ trợ,
  giảm, bồi bổ, tăng cường, cải thiện, tốt cho, phòng ngừa, góp phần) mà
  không phải cụm claim whitelist nguyên văn thì VIẾT LẠI câu đó.
"""
    messages = [{"role": "system", "content": system},
                {"role": "user", "content": f"BRIEF: {brief}"}]
    for _ in range(2):  # draft -> check; vi phạm -> 1 lượt sửa có feedback
        resp = chat("content", messages, temperature=0.3, max_tokens=600)
        text = _with_ai_label((resp.choices[0].message.content or "").strip(),
                              labels)
        result = check_publish_llm(text, channel=channel,
                                   content_type="post", is_ai=True,
                                   readiness=readiness)
        if result["ok"]:
            return {"text": text, "guardrail": result}
        detail = "; ".join(f"{v.get('code') or v.get('type')}: "
                           f"{v.get('span') or v.get('detail')}"
                           for v in result["violations"])
        messages += [{"role": "assistant", "content": text},
                     {"role": "user", "content":
                         f"Bài vi phạm guardrail: {detail}. Viết lại — chỉ "
                         "dùng claim whitelist nguyên văn, câu trang trí "
                         "không chứa động từ claim."}]
    return {"text": text, "guardrail": result}


def draft_multi(brief: str, channels, *,
                readiness: dict | None = None) -> dict:
    """Sinh draft cho nhiều kênh → {channel: {"text","guardrail"}}.

    Mỗi kênh qua `draft()` riêng — guardrail check độc lập từng bài
    (invariant). Kênh lạ vẫn được draft() (fallback hint facebook như
    draft() hiện). Trùng kênh trong `channels` tự gộp (giữ thứ tự)."""
    if isinstance(channels, str):
        channels = [channels]
    return {ch: draft(brief, ch, readiness=readiness)
            for ch in dict.fromkeys(channels)}
