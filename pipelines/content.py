"""Pipeline sinh draft nội dung FB/Zalo/blog từ brief.

Contract:
  draft(brief: str, channel: str = "facebook") -> {"text": str, "guardrail": dict}

  - Gọi Claude (ANTHROPIC_API_KEY) với system prompt chứa brand voice +
    claims_whitelist (chỉ được viết công dụng trong whitelist).
  - Output BẮT BUỘC qua pipelines.guardrail.check() trước khi trả về —
    trường "guardrail" chứa kết quả check. Không bao giờ trả text
    chưa-check.
"""


def draft(brief: str, channel: str = "facebook") -> dict:
    raise NotImplementedError("T3.2 — xem TASKS.md")
