"""Guardrail pháp lý TPBVSK — chạy TRƯỚC khi mọi nội dung được hiển thị/đăng.

2 lớp check:
  1. Banned words: load data/banned_words.txt — match không dấu/ có dấu,
     case-insensitive. VD chắc chắn phải chặn: "chữa", "điều trị",
     "thuốc", "khỏi bệnh", "trị khỏi", "chống ung thư".
  2. Claim whitelist: load data/claims_whitelist.json — phát hiện câu
     khẳng định công dụng (heuristic hoặc LLM check) không nằm trong
     claims đã công bố của SKU → flag "unverified_claim".

API (contract — không đổi signature khi chưa cập nhật TASKS.md):
"""


def check(text: str) -> dict:
    """Return {"ok": bool, "violations": [{"type","detail","span"}],
    "matched_claims": [...]}.

    violations[].type ∈ {"banned_word","unverified_claim"}.
    Không raise lỗi ra ngoài; file data thiếu → ok=False + violation "config".
    """
    raise NotImplementedError("T3.1 — xem TASKS.md")
