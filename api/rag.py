"""RAG trên bảng `chunks`: embed câu hỏi → cosine top-k (numpy) → LLM trả lời.

Contract với UI (xem app/streamlit_app.py): answer() trả
{"answer": str, "sources": [url, ...]} — sources rỗng nghĩa là
"không đủ dữ liệu", UI hiển thị thông báo thay vì bịa.
v3.1: mọi lời gọi LLM/embedding qua `pipelines.llm_gateway` (agent_id
"chatbot"); câu hỏi sức khỏe chặn TRƯỚC LLM -> thêm key "handoff".
v3.9 (W39.4, F15.3): retrieve() DENY-BY-DEFAULT — mặc định chỉ đọc corpus
CÔNG KHAI `chunks` (lọc thêm chunk nhắc rượu); `internal:<phong>` phải
truyền tường minh và đọc bảng RIÊNG `chunks_internal`. answer() (kênh
khách Zalo + tab Chat) KHÔNG có tham số collection. Câu hỏi về rượu ->
NO_DATA + handoff="alcohol", không gọi LLM/embed (luật QC rượu >=15 độ).
"""

import os
import re
from pathlib import Path

import numpy as np
import psycopg
from dotenv import load_dotenv

from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import chat, embed, is_health_question

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOP_K = 8
MIN_SCORE = 0.25  # cosine dưới ngưỡng -> coi như KB không có thông tin
NO_DATA = "Chưa đủ dữ liệu để trả lời."
AGENT = "chatbot"
CONNECT_TIMEOUT_S = 10
_INTERNAL_RE = re.compile(r"internal:[a-z0-9_]{1,32}")
_COLS = "title, source_url, lang, content, embedding, doc_id"
_COLS_INTERNAL = "title, source_ref, null, content, embedding, doc_id"
# Hậu kiểm định danh (nghiệm thu v3.9): MST thật chỉ nằm trong record rượu
# đã lọc -> LLM bịa MST (0402021985...). Chuỗi >=9 chữ số liền trong câu
# trả lời (MST/SĐT/STK) phải có nguyên văn trong ngữ cảnh/câu hỏi/history
# (so cả bản bỏ 1 dấu cách/chấm/gạch giữa 2 chữ số: "0905.123.456").
_LONG_NUM_RE = re.compile(r"(?<!\d)\d{9,}(?!\d)")
_DIGIT_SEP_RE = re.compile(r"(?<=\d)[ .\-](?=\d)")


def _unverified_number(text: str, grounding: str) -> bool:
    """True nếu `text` có chuỗi >=9 chữ số liền không có trong `grounding`."""
    nums = _LONG_NUM_RE.findall(text)
    if not nums:
        return False
    pool = grounding + "\n" + _DIGIT_SEP_RE.sub("", grounding)
    return any(n not in pool for n in nums)

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


def _query(collection) -> tuple[str, tuple]:
    """collection -> (SQL, params). Chỉ "public" hoặc internal:<phong>
    (regex chặt); mọi giá trị khác -> ValueError (deny-by-default)."""
    if isinstance(collection, str) and collection == "public":
        return f"select {_COLS} from chunks", ()
    if isinstance(collection, str) and _INTERNAL_RE.fullmatch(collection):
        return ((f"select {_COLS_INTERNAL} from chunks_internal"
                 " where collection = %s"), (collection,))
    raise ValueError("collection không hợp lệ — chỉ 'public' hoặc"
                     " 'internal:<phong>' ([a-z0-9_]{1,32})")


def retrieve(question: str, k: int = TOP_K, *,
             collection: str = "public") -> list[dict]:
    """Top-k chunk theo cosine similarity, kèm score/url/title/content.
    `collection` validate TRƯỚC khi gọi embed; public bỏ row nhắc rượu
    (lớp phòng thủ cho row nạp ngoài embed_store/legacy)."""
    sql, params = _query(collection)
    public = collection == "public"
    qv = np.array(embed(AGENT, question).data[0].embedding)
    with psycopg.connect(os.environ["DATABASE_URL"],
                         connect_timeout=CONNECT_TIMEOUT_S) as conn:
        rows = conn.execute(sql, params).fetchall()
    if not rows:
        return []
    mat = np.array([r[4] for r in rows], dtype=np.float64)
    scores = mat @ qv / (np.linalg.norm(mat, axis=1) * np.linalg.norm(qv) + 1e-12)

    def allowed(i) -> bool:
        # Lọc rượu theo thứ tự điểm, dừng khi đủ k — quét cả bảng mỗi câu
        # hỏi tốn ~0.4s/870 chunk, kết quả như nhau.
        return not public or not (is_alcohol(rows[i][3]) or is_alcohol(rows[i][0]))

    top = []
    for i in scores.argsort()[::-1]:
        if len(top) >= k:
            break
        if allowed(i):
            top.append(i)
    hits = [{"title": rows[i][0], "url": rows[i][1], "lang": rows[i][2],
             "content": rows[i][3], "score": float(scores[i]),
             "doc_id": rows[i][5]} for i in top]
    # Doc "Danh mục sản phẩm" list đủ SKU+giá trong 1 chunk -> luôn ghim vào
    # context nếu liên quan (tránh model chỉ đọc 1 chunk giá rồi thiếu quy cách).
    cat = [i for i, r in enumerate(rows) if public and r[5] == "catalog-products"]
    cat = [i for i in cat if allowed(i)]
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
    + handoff="health" (zalo nhánh NO_DATA gửi HANDOFF_TEXT chuyển người).
    v3.9 (W39.4): câu hỏi về rượu (kể cả câu rewrite) -> NO_DATA +
    handoff="alcohol", không gọi LLM/embed, không mời mua. Kênh khách luôn
    retrieve corpus public — KHÔNG có tham số collection. Câu trả lời chứa
    chuỗi >=9 chữ số không có trong ngữ cảnh (MST/SĐT bịa) -> NO_DATA."""
    if is_health_question(question):
        return {"answer": NO_DATA, "sources": [], "handoff": "health"}
    if is_alcohol(question):
        return {"answer": NO_DATA, "sources": [], "handoff": "alcohol"}
    search_q = question
    if history:
        search_q = _standalone(question, history) or question
        if is_alcohol(search_q):
            return {"answer": NO_DATA, "sources": [], "handoff": "alcohol"}
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
    grounding = "\n".join([context, question, *(
        m["content"] for m in history or []
        if isinstance(m, dict) and isinstance(m.get("content"), str))])
    if _unverified_number(text, grounding):
        return {"answer": NO_DATA, "sources": []}
    sources = sorted({h["url"] for h in hits if h["score"] >= MIN_SCORE and h["url"]})
    if NO_DATA in text:
        sources = []
    return {"answer": text, "sources": sources}
