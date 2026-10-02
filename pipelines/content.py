"""Pipeline sinh draft nội dung FB/Zalo/blog từ brief.

Contract:
  draft(brief: str, channel: str = "facebook") -> {"text": str, "guardrail": dict}

  - Gọi LLM qua OpenRouter (OPENROUTER_API_KEY + OR_CHAT_MODEL, openai client)
    với system prompt chứa brand voice + claims_whitelist (chỉ được viết
    công dụng trong whitelist).
  - Output BẮT BUỘC qua pipelines.guardrail.check() trước khi trả về —
    trường "guardrail" chứa kết quả check. Không bao giờ trả text
    chưa-check.
"""

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from pipelines.guardrail import check

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

CHANNEL_HINT = {
    "facebook": "bài đăng Facebook 120-180 chữ, 1-2 emoji, có CTA inbox/hotline",
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


def draft(brief: str, channel: str = "facebook") -> dict:
    """Sinh draft theo brief -> qua guardrail -> trả {"text", "guardrail"}."""
    client = OpenAI(base_url="https://openrouter.ai/api/v1",
                    api_key=os.environ["OPENROUTER_API_KEY"])
    model = os.environ.get("OR_CHAT_MODEL", "openai/gpt-4o-mini")
    fmt = CHANNEL_HINT.get(channel, CHANNEL_HINT["facebook"])

    system = f"""Bạn là copywriter của Công ty TNHH Sâm Sâm — thương hiệu sâm
Ngọc Linh Quảng Nam. Giọng điệu: tự hào đặc sản quê hương, tử tế, không
phóng đại. Viết {fmt}.

LUẬT TPBVSK — vi phạm là bài bị loại:
- CHỈ được nêu công dụng nằm trong whitelist dưới đây của ĐÚNG sản phẩm,
  dùng gần nguyên văn:
{_whitelist_block()}
- Câu trang trí TUYỆT ĐỐI không chứa động từ claim (giúp/hỗ trợ/bồi bổ/
  giảm/tăng cường/cải thiện/tốt cho/phòng ngừa) — những từ đó chỉ xuất
  hiện trong cụm claim whitelist. Mở bài/kết bài chỉ kể chuyện thương
  hiệu, đặc sản quê hương, quà tặng.
- Sản phẩm không có claim -> chỉ giới thiệu, không nêu công dụng.
- Khi nêu công dụng, kết bài bằng disclaimer: "Sản phẩm không phải là
  thuốc và không có tác dụng thay thế thuốc chữa bệnh."
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
        resp = client.chat.completions.create(
            model=model, messages=messages, temperature=0.3, max_tokens=600)
        text = resp.choices[0].message.content.strip()
        result = check(text)
        if result["ok"]:
            return {"text": text, "guardrail": result}
        detail = "; ".join(f"{v['type']}: {v.get('span') or v['detail']}"
                           for v in result["violations"])
        messages += [{"role": "assistant", "content": text},
                     {"role": "user", "content":
                         f"Bài vi phạm guardrail: {detail}. Viết lại — chỉ "
                         "dùng claim whitelist nguyên văn, câu trang trí "
                         "không chứa động từ claim."}]
    return {"text": text, "guardrail": result}
