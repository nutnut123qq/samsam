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
v10.3 (WP16): retrieve() = validate -> embed -> retrieve_by_vector();
backend `float8` (numpy, mặc định) | `pgvector` (HNSW, cột embedding_v)
qua env RAG_VECTOR_BACKEND — lọc rượu/ghim catalog dùng chung 1 hàm.
v13.7 (F06, PL02 "phản hồi tự động ≤30 giây"): `answer()` nhận hạn chót
TUYỆT ĐỐI (`time.monotonic()`) qua tham số `deadline` hoặc contextvar
`DEADLINE` (connector đặt trong luồng trả lời). Trước MỖI bước tốn thời
gian (rewrite, embed, đọc DB vector, chat) kiểm thời gian còn lại: < 1 giây
→ `DeadlineExceeded(bước)`; còn đủ → truyền `timeout=<còn lại>` xuống lời
gọi gateway (timeout client openai) và `connect_timeout` DB. Lời gọi hết
giờ ở client (GatewayError do timeout) cũng thành `DeadlineExceeded`.
Không có hạn chót (CLI/eval/Streamlit) → hành vi cũ.
"""

import math
import os
import re
import sys
import time
from contextvars import ContextVar
from pathlib import Path

import numpy as np
import psycopg
from dotenv import load_dotenv

from pipelines.kb_filter import is_alcohol
from pipelines.llm_gateway import (
    GatewayError,
    chat,
    embed,
    is_health_question,
)
from pipelines.pii import scrub_user

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

TOP_K = 8
MIN_SCORE = 0.25  # cosine dưới ngưỡng -> coi như KB không có thông tin
NO_DATA = "Chưa đủ dữ liệu để trả lời."
AGENT = "chatbot"
CONNECT_TIMEOUT_S = 10
# v13.7 — PL02 mục 2: phản hồi tự động của chatbot ≤ 30 giây TÍNH TỪ LÚC
# NHẬN TIN tới khi gửi xong. Connector chia: trả lời ≤ 30 − SEND_RESERVE_S,
# phần còn lại cho lời gọi gửi (timeout send API = SEND_RESERVE_S).
CHAT_BUDGET_S = 30.0
SEND_RESERVE_S = 5.0
MIN_CALL_S = 1.0           # còn ít hơn → không bắt đầu lời gọi mới
DEADLINE: ContextVar[float | None] = ContextVar("rag_deadline", default=None)
_clock = time.monotonic    # test thay bằng đồng hồ giả (không wall-clock)


class DeadlineExceeded(TimeoutError):
    """Hết ngân sách thời gian trả lời — connector chuyển người."""

    def __init__(self, stage: str):
        super().__init__(f"hết hạn 30 giây ở bước {stage}")
        self.stage = stage


def _left(deadline: float | None, stage: str) -> float | None:
    """Giây còn lại trước `deadline` (None = không hạn chót)."""
    if deadline is None:
        return None
    left = deadline - _clock()
    if left < MIN_CALL_S:
        raise DeadlineExceeded(stage)
    return left


def _timed(fn, stage: str, deadline: float | None, *a, **kw):
    """Gọi gateway với `timeout` = thời gian còn lại; hết giờ → Deadline."""
    left = _left(deadline, stage)
    if left is not None:
        kw["timeout"] = left
    try:
        return fn(*a, **kw)
    except GatewayError as e:
        cause = e.__cause__
        if deadline is not None and (
                _clock() >= deadline or isinstance(cause, TimeoutError)
                or "Timeout" in type(cause).__name__):
            raise DeadlineExceeded(stage) from e
        raise
_INTERNAL_RE = re.compile(r"internal:[a-z0-9_]{1,32}")
FEATURE = "sales-01"      # chatbot CSKH — trần/nút tắt theo tính năng (PL01)
# Vá controller 22/10 (F1): gợi ý chat sàn (sales-02) dùng chung RAG nhưng
# phải chịu trần/nút tắt/ghi chi phí của CHÍNH nó. Caller chọn mã theo KÊNH
# (hằng nội bộ, `connectors.channels`), không bao giờ từ text khách — chỉ
# nhận mã trong danh sách này, mã khác -> ValueError trước mọi lời gọi.
FEATURES = frozenset({FEATURE, "sales-02"})


def _feature(feature) -> str:
    if not isinstance(feature, str) or feature not in FEATURES:
        raise ValueError("feature RAG không thuộc danh sách nội bộ "
                         f"{sorted(FEATURES)}")
    return feature
_COLS = "title, source_url, lang, content, embedding, doc_id"
_COLS_INTERNAL = "title, source_ref, null, content, embedding, doc_id"
# v10.3 (WP16): backend vector chọn qua env RAG_VECTOR_BACKEND.
VECTOR_BACKENDS = ("float8", "pgvector")
PGVECTOR_CANDIDATES = 64   # ứng viên lấy từ HNSW trước lọc rượu
PGVECTOR_EF_SEARCH = 100   # >= số ứng viên (mặc định pgvector 40)
CATALOG_MIN_SCORE = 0.15
_PG_MISSING = (psycopg.errors.UndefinedColumn, psycopg.errors.UndefinedObject,
               psycopg.errors.UndefinedFunction)
_pg_warned = False
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


def _query(collection, ident: bool = False) -> tuple[str, tuple]:
    """collection -> (SQL, params). Chỉ "public" hoặc internal:<phong>
    (regex chặt); mọi giá trị khác -> ValueError (deny-by-default).
    `ident` thêm cột chunk_index (chỉ cho eval so 2 backend)."""
    extra = ", chunk_index" if ident else ""
    if isinstance(collection, str) and collection == "public":
        return f"select {_COLS}{extra} from chunks", ()
    if isinstance(collection, str) and _INTERNAL_RE.fullmatch(collection):
        return ((f"select {_COLS_INTERNAL}{extra} from chunks_internal"
                 " where collection = %s"), (collection,))
    raise ValueError("collection không hợp lệ — chỉ 'public' hoặc"
                     " 'internal:<phong>' ([a-z0-9_]{1,32})")


def vector_backend(backend: str | None = None) -> str:
    """v10.3: backend vector = tham số > env RAG_VECTOR_BACKEND > 'float8'.
    Giá trị lạ -> ValueError (deny-by-default như collection)."""
    b = backend if backend is not None else (
        (os.environ.get("RAG_VECTOR_BACKEND") or "").strip() or "float8")
    if b not in VECTOR_BACKENDS:
        raise ValueError("RAG_VECTOR_BACKEND không hợp lệ — chỉ 'float8' |"
                         " 'pgvector'")
    return b


def _allowed(row, public: bool) -> bool:
    return not public or not (is_alcohol(row[3]) or is_alcohol(row[0]))


def _hit(row, score, ident: bool) -> dict:
    h = {"title": row[0], "url": row[1], "lang": row[2], "content": row[3],
         "score": float(score), "doc_id": row[5]}
    if ident:
        h["chunk_index"] = row[6]
    return h


def _select(cands, k: int, public: bool, catalog: list, ident: bool
            ) -> tuple[list[dict], int]:
    """CHUNG cho 2 backend. cands = iterable (row, score) giảm dần; catalog
    = [(row, score)] các chunk `catalog-products` (public). Lọc rượu theo
    thứ tự điểm, dừng khi đủ k (quét cả bảng mỗi câu ~0.4s/870 chunk, kết
    quả như nhau). -> (hits, số hit TRƯỚC khi ghim catalog)."""
    top = []
    for row, score in cands:
        if len(top) >= k:
            break
        if _allowed(row, public):
            top.append(_hit(row, score, ident))
    n = len(top)
    # Doc "Danh mục sản phẩm" list đủ SKU+giá trong 1 chunk -> luôn ghim vào
    # context nếu liên quan (tránh model chỉ đọc 1 chunk giá rồi thiếu quy cách).
    if public and catalog and all(h["doc_id"] != "catalog-products"
                                  for h in top):
        ok = [(r, s) for r, s in catalog if _allowed(r, public)]
        if ok:
            r, s = max(ok, key=lambda x: x[1])
            if s >= CATALOG_MIN_SCORE:
                top.append(_hit(r, s, ident))
    return top, n


def _rank_float8(conn, sql: str, params: tuple, qv):
    """Đường gốc: đọc mọi row float8[] -> cosine numpy. -> (rows, scores)."""
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return rows, None
    mat = np.array([r[4] for r in rows], dtype=np.float64)
    scores = mat @ qv / (np.linalg.norm(mat, axis=1) * np.linalg.norm(qv)
                         + 1e-12)
    return rows, scores


def _vec_literal(qv) -> str:
    return "[" + ",".join(repr(float(x)) for x in qv) + "]"


def _rank_pgvector(conn, collection: str, qv, limit: int,
                   ident: bool = False) -> tuple[list, list]:
    """v10.3: top-`limit` ứng viên theo cosine qua index HNSW (`embedding_v`
    vector, docs/schema_pgvector.sql) + điểm các chunk `catalog-products`
    (public). Cột trả CÙNG thứ tự _COLS, vị trí embedding thay bằng điểm.
    -> (cands [(row, score)] giảm dần, catalog [(row, score)])."""
    lit = _vec_literal(qv)
    extra = ", chunk_index" if ident else ""
    score = "1 - (embedding_v <=> %s::vector)"
    if collection == "public":
        cols = f"title, source_url, lang, content, {score}, doc_id{extra}"
        src, where, wp = "chunks", "", ()
    else:
        cols = f"title, source_ref, null, content, {score}, doc_id{extra}"
        src, where, wp = "chunks_internal", "collection = %s and ", (collection,)
        # lọc collection SAU khi quét HNSW có thể trả thiếu -> quét lặp
        conn.execute("set local hnsw.iterative_scan = strict_order")
    ef = min(1000, max(PGVECTOR_EF_SEARCH, int(limit)))
    conn.execute(f"set local hnsw.ef_search = {ef}")
    rows = conn.execute(
        f"select {cols} from {src} where {where}embedding_v is not null"
        " order by embedding_v <=> %s::vector limit %s",
        (lit, *wp, lit, int(limit))).fetchall()
    catalog = []
    if collection == "public":
        catalog = [(r, float(r[4])) for r in conn.execute(
            f"select {cols} from chunks where doc_id = 'catalog-products'"
            " and embedding_v is not null", (lit,)).fetchall()]
    return [(r, float(r[4])) for r in rows], catalog


def _warn_pg_missing(e: Exception) -> None:
    global _pg_warned
    if not _pg_warned:
        _pg_warned = True
        print(f"[warn] RAG_VECTOR_BACKEND=pgvector nhưng DB thiếu cột "
              f"embedding_v/extension vector ({type(e).__name__}) — dùng "
              "float8 (chạy `apply_schema.py --pgvector`).", file=sys.stderr,
              flush=True)


def retrieve_by_vector(qv, k: int = TOP_K, *, collection: str = "public",
                       backend: str | None = None, ident: bool = False,
                       deadline: float | None = None) -> list[dict]:
    """Top-k chunk cho vector đã embed. Backend `float8` (numpy, mặc định)
    | `pgvector` (HNSW, cần schema_pgvector.sql). Lọc rượu + ghim catalog
    dùng CHUNG `_select`. pgvector: DB thiếu cột/extension -> rollback +
    [warn] 1 lần/process -> float8 (kênh khách không sập); lọc rượu ăn hết
    `limit` ứng viên mà còn < k -> chạy lại float8 (không trả thiếu)."""
    sql, params = _query(collection, ident)
    backend = vector_backend(backend)
    public = collection == "public"
    qv = np.asarray(qv, dtype=np.float64)
    left = _left(deadline, "db")
    ct = (CONNECT_TIMEOUT_S if left is None
          else max(1, min(CONNECT_TIMEOUT_S, math.floor(left))))
    with psycopg.connect(os.environ["DATABASE_URL"],
                         connect_timeout=ct) as conn:
        if backend == "pgvector":
            limit = max(PGVECTOR_CANDIDATES, k)
            try:
                cands, catalog = _rank_pgvector(conn, collection, qv, limit,
                                                ident)
            except _PG_MISSING as e:
                conn.rollback()
                _warn_pg_missing(e)
            else:
                hits, n = _select(cands, k, public, catalog, ident)
                if n >= k or len(cands) < limit:
                    return hits
        rows, scores = _rank_float8(conn, sql, params, qv)
    if not rows:
        return []
    cands = ((rows[i], scores[i]) for i in scores.argsort()[::-1])
    catalog = [(r, s) for r, s in zip(rows, scores)
               if public and r[5] == "catalog-products"]
    return _select(cands, k, public, catalog, ident)[0]


def retrieve(question: str, k: int = TOP_K, *,
             collection: str = "public",
             deadline: float | None = None,
             feature: str = FEATURE) -> list[dict]:
    """Top-k chunk theo cosine similarity, kèm score/url/title/content.
    `collection` + backend validate TRƯỚC khi gọi embed; public bỏ row nhắc
    rượu (lớp phòng thủ cho row nạp ngoài embed_store/legacy)."""
    _query(collection)
    feature = _feature(feature)
    backend = vector_backend()
    qv = np.array(_timed(embed, "embed", deadline, AGENT, question,
                         feature=feature).data[0].embedding)
    return retrieve_by_vector(qv, k, collection=collection, backend=backend,
                              deadline=deadline)


def _standalone(question: str, history: list[dict],
                deadline: float | None = None, *,
                feature: str = FEATURE) -> str:
    """Rewrite câu follow-up thành câu độc lập đủ ngữ cảnh để retrieve —
    vd "còn loại rẻ hơn?" sau lượt hỏi Saphraton -> "sản phẩm nào rẻ
    hơn Saphraton?". Chỉ phục vụ retrieval; câu trả lời cuối vẫn do LLM
    sinh từ câu hỏi GỐC của user. LLM refusal trả content=None -> trả
    "" -> caller fallback dùng câu gốc (D5.2 — trước đây AttributeError
    crash xuyên qua streamlit/zalo)."""
    resp = _timed(
        chat, "rewrite", deadline,
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
        feature=_feature(feature),
    )
    return (resp.choices[0].message.content or "").strip()


def _scrub_history(history: list[dict] | None) -> list[dict]:
    """v13.1: lượt user -> `scrub_user`; lượt còn dấu hiệu PII thì bỏ luôn
    câu trả lời kế tiếp của nó (cặp hỏi/đáp)."""
    out, skip = [], False
    for m in history or []:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if m.get("role") == "user" and isinstance(c, str):
            c, skip = scrub_user(c)
            if skip:
                continue
            out.append({**m, "content": c})
        elif skip and m.get("role") == "assistant":
            skip = False
        elif m.get("role") == "assistant" and isinstance(c, str):
            # docx P1: câu bot cũ cũng che trước khi gửi AI (có thể nhắc
            # lại tên/địa chỉ khách).
            out.append({**m, "content": scrub_user(c)[0]})
        else:
            out.append(m)
    return out


def answer(question: str, history: list[dict] | None = None, *,
           deadline: float | None = None, feature: str = FEATURE) -> dict:
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
    chuỗi >=9 chữ số không có trong ngữ cảnh (MST/SĐT bịa) -> NO_DATA.
    v13.1 (F02): câu hỏi + lượt user của history qua `pii.scrub_user` trước
    MỌI lời gọi AI; còn dấu hiệu PII -> NO_DATA + handoff="pii" (0 lời gọi);
    câu rewrite cũng qua lọc sức khỏe. Gateway chặn (trần/kill/không đọc
    được chi tiêu) -> GatewayBlocked lan ra caller (zalo/messenger/channels
    chuyển người).
    Vá controller 22/10 (F1): `feature` = mã tính năng nội bộ cho MỌI lời
    gọi rewrite/embed/chat của lượt (mặc định sales-01 chatbot; gợi ý chat
    sàn truyền sales-02) — ngoài `FEATURES` -> ValueError, 0 lời gọi."""
    feature = _feature(feature)
    if deadline is None:
        deadline = DEADLINE.get()
    if is_health_question(question):
        return {"answer": NO_DATA, "sources": [], "handoff": "health"}
    if is_alcohol(question):
        return {"answer": NO_DATA, "sources": [], "handoff": "alcohol"}
    # v13.1 (F02): text KHÁCH gõ (câu hỏi + lượt user trong history) che
    # tên/địa chỉ/SĐT/email TRƯỚC mọi lời gọi rewrite/embed/chat; câu hỏi
    # còn dấu hiệu PII không che chắc -> chuyển người, 0 lời gọi AI. Lượt
    # history còn dấu hiệu -> bỏ cả cặp hỏi/đáp khỏi ngữ cảnh gửi đi.
    # Đối chiếu số (`_unverified_number`) vẫn dùng text GỐC — kiểm cục bộ,
    # không gửi đi (giữ hành vi: số khách tự gõ được phép nhắc lại).
    raw_turns = [question, *(m["content"] for m in history or []
                             if isinstance(m, dict)
                             and isinstance(m.get("content"), str))]
    question, risky = scrub_user(question)
    if risky:
        return {"answer": NO_DATA, "sources": [], "handoff": "pii"}
    history = _scrub_history(history)
    search_q = question
    if history:
        dl = {} if deadline is None else {"deadline": deadline}
        search_q = scrub_user(_standalone(question, history, **dl,
                                          feature=feature)
                              or question)[0]
        if is_alcohol(search_q):
            return {"answer": NO_DATA, "sources": [], "handoff": "alcohol"}
        if is_health_question(search_q):
            return {"answer": NO_DATA, "sources": [], "handoff": "health"}
    hits = (retrieve(search_q, feature=feature) if deadline is None
            else retrieve(search_q, deadline=deadline, feature=feature))
    if not hits or hits[0]["score"] < MIN_SCORE:
        return {"answer": NO_DATA, "sources": []}

    context = "\n\n".join(
        f"[{i + 1}] {h['title']} ({h['url']})\n{h['content']}"
        for i, h in enumerate(hits)
    )
    resp = _timed(
        chat, "chat", deadline,
        AGENT,
        [
            {"role": "system", "content": SYSTEM},
            *(history or []),
            {"role": "user", "content":
                f"NGỮ CẢNH:\n{context}\n\nCÂU HỎI: {question}"},
        ],
        temperature=0.0,
        max_tokens=500,
        feature=feature,
    )
    # content=None (refusal) -> NO_DATA, không bịa — D5.2, cùng lớp lỗi
    # với _standalone ở trên. Whitespace-only (" ") cũng -> NO_DATA
    # (D5.8): " " truthy nên `or NO_DATA` trước strip không bắt được —
    # trả "" làm zalo gửi message rỗng.
    text = (resp.choices[0].message.content or "").strip() or NO_DATA
    grounding = "\n".join([context, *raw_turns])
    if _unverified_number(text, grounding):
        return {"answer": NO_DATA, "sources": []}
    sources = sorted({h["url"] for h in hits if h["score"] >= MIN_SCORE and h["url"]})
    if NO_DATA in text:
        sources = []
    return {"answer": text, "sources": sources}
