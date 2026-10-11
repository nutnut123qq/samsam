"""RAG trên bảng `chunks`: embed câu hỏi → cosine top-k (numpy) → LLM trả lời.

Contract với UI (xem app/streamlit_app.py): answer() trả
{"answer": str, "sources": [url, ...]} — sources rỗng nghĩa là
"không đủ dữ liệu", UI hiển thị thông báo thay vì bịa.
v3.1: mọi lời gọi LLM/embedding qua `pipelines.llm_gateway` (agent_id
"chatbot"); câu hỏi sức khỏe chặn TRƯỚC LLM -> thêm key "handoff".
"""

import os
from pathlib import Path

import numpy as np
import psycopg
from dotenv import load_dotenv

from pipelines.llm_gateway import chat, embed, is_health_question

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOP_K = 8
MIN_SCORE = 0.25  # cosine dưới ngưỡng -> coi như KB không có thông tin
NO_DATA = "Chưa đủ dữ liệu để trả lời."
AGENT = "chatbot"

SYSTEM = """Bạn là trợ lý CSKH của Công ty TNHH Sâm Sâm (sâm Ngọc Linh).
Trả lời bằng tiếng Việt, ngắn gọn, CHỈ dựa vào NGỮ CẢNH bên dưới.

Luật:
- Thông tin không có trong ngữ cảnh -> trả lời đúng câu "Chưa đủ dữ liệu để trả lời."
- Giá ghi 'Liên hệ' -> nói nguyên văn 'Liên hệ', tuyệt đối không tự bịa giá.
- Tên sản phẩm kèm hậu tố quy cách (vd 'Saphraton 20V') là MỘT QUY CÁCH
  của sản phẩm gốc, không phải sản phẩm khác. Hỏi giá/loại sản phẩm X phải
  nêu ĐỦ giá của cả X lẫn mọi quy cách 'X ...' trong ngữ cảnh.
  VD: hỏi 'Saphraton giá bao nhiêu' mà ngữ cảnh có 'Saphraton — 1.000.000 đ'
  và 'Saphraton 20V — 236.000 đ' thì PHẢI trả lời: 'Saphraton hộp 80 viên:
  1.000.000 đ; gói Saphraton 20V: 236.000 đ'. Hỏi danh sách sản phẩm ->
  liệt kê tên sản phẩm, không kể nhóm công dụng.
- 'Mã số doanh nghiệp' chính là mã số thuế của công ty.
- Hỏi liên hệ/hotline/điện thoại -> liệt kê ĐỦ mọi số xuất hiện trong
  ngữ cảnh kèm nhãn của nó (vd 'Hotline:', 'ĐT:').
- Không khẳng định công dụng y tế ngoài công dụng đã công bố trong ngữ cảnh;
  tuyệt đối không nói sản phẩm "chữa", "điều trị", "thuốc", "khỏi bệnh".
- Không trích link trong câu trả lời — nguồn do hệ thống hiển thị riêng.
"""


def retrieve(question: str, k: int = TOP_K) -> list[dict]:
    """Top-k chunk theo cosine similarity, kèm score/url/title/content."""
    qv = np.array(embed(AGENT, question).data[0].embedding)
    with psycopg.connect(os.environ["DATABASE_URL"],
                         connect_timeout=5) as conn:
        rows = conn.execute(
            "select title, source_url, lang, content, embedding, doc_id"
            " from chunks"
        ).fetchall()
    if not rows:
        return []
    mat = np.array([r[4] for r in rows], dtype=np.float64)
    scores = mat @ qv / (np.linalg.norm(mat, axis=1) * np.linalg.norm(qv) + 1e-12)
    top = scores.argsort()[::-1][:k]
    hits = [{"title": rows[i][0], "url": rows[i][1], "lang": rows[i][2],
             "content": rows[i][3], "score": float(scores[i]),
             "doc_id": rows[i][5]} for i in top]
    # Doc "Danh mục sản phẩm" list đủ SKU+giá trong 1 chunk -> luôn ghim vào
    # context nếu liên quan (tránh model chỉ đọc 1 chunk giá rồi thiếu quy cách).
    cat = [i for i, r in enumerate(rows) if r[5] == "catalog-products"]
    if cat and all(h["doc_id"] != "catalog-products" for h in hits):
        i = cat[int(np.argmax(scores[cat]))]
        if scores[i] >= 0.15:
            hits.append({"title": rows[i][0], "url": rows[i][1],
                         "lang": rows[i][2], "content": rows[i][3],
                         "score": float(scores[i]), "doc_id": "catalog-products"})
    return hits


def _standalone(question: str, history: list[dict]) -> str:
    """Rewrite câu follow-up thành câu độc lập đủ ngữ cảnh để retrieve —
    vd "còn loại rẻ hơn?" sau lượt hỏi Saphraton -> "sản phẩm nào rẻ
    hơn Saphraton?". Chỉ phục vụ retrieval; câu trả lời cuối vẫn do LLM
    sinh từ câu hỏi GỐC của user. LLM refusal trả content=None -> trả
    "" -> caller fallback dùng câu gốc (D5.2 — trước đây AttributeError
    crash xuyên qua streamlit/zalo)."""
    resp = chat(
        AGENT,
        [
            {"role": "system", "content":
                "Viết lại câu hỏi cuối của user thành một câu hỏi độc "
                "lập, đủ ngữ cảnh để tra knowledge base, giữ nguyên "
                "ngôn ngữ. Chỉ trả về câu hỏi đã viết lại, không giải "
                "thích."},
            *history,
            {"role": "user", "content": question},
        ],
        temperature=0.0,
        max_tokens=100,
    )
    return (resp.choices[0].message.content or "").strip()


def answer(question: str, history: list[dict] | None = None) -> dict:
    """Trả lời câu hỏi kèm nguồn. Thiếu context/score thấp -> NO_DATA.

    `history` = các lượt Q&A trước (OpenAI-style, caller giới hạn 4 lượt
    gần nhất). Có history -> rewrite câu hỏi thành standalone trước khi
    retrieve (câu trần follow-up retrieve về score thấp -> NO_DATA giả),
    còn prompt trả lời vẫn giữ câu hỏi gốc + history. Không truyền ->
    y hệt 1-turn, không tốn thêm LLM call.

    v3.1 (W31.5): câu hỏi sức khỏe -> KHÔNG gọi LLM/embedding, trả NO_DATA
    + handoff="health" (zalo nhánh NO_DATA gửi HANDOFF_TEXT chuyển người)."""
    if is_health_question(question):
        return {"answer": NO_DATA, "sources": [], "handoff": "health"}
    search_q = question
    if history:
        search_q = _standalone(question, history) or question
    hits = retrieve(search_q)
    if not hits or hits[0]["score"] < MIN_SCORE:
        return {"answer": NO_DATA, "sources": []}

    context = "\n\n".join(
        f"[{i + 1}] {h['title']} ({h['url']})\n{h['content']}"
        for i, h in enumerate(hits)
    )
    resp = chat(
        AGENT,
        [
            {"role": "system", "content": SYSTEM},
            *(history or []),
            {"role": "user", "content":
                f"NGỮ CẢNH:\n{context}\n\nCÂU HỎI: {question}"},
        ],
        temperature=0.0,
        max_tokens=500,
    )
    # content=None (refusal) -> NO_DATA, không bịa — D5.2, cùng lớp lỗi
    # với _standalone ở trên. Whitespace-only (" ") cũng -> NO_DATA
    # (D5.8): " " truthy nên `or NO_DATA` trước strip không bắt được —
    # trả "" làm zalo gửi message rỗng.
    text = (resp.choices[0].message.content or "").strip() or NO_DATA
    sources = sorted({h["url"] for h in hits if h["score"] >= MIN_SCORE and h["url"]})
    if NO_DATA in text:
        sources = []
    return {"answer": text, "sources": sources}
