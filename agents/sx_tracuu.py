"""v10.2 W102.3 — SX-A7 Agent Tra cứu Khoa học nội bộ (khối Sản xuất, WP16).

Tra cứu tài liệu khoa học NỘI BỘ đã được GĐ SX duyệt nạp vào
`chunks_internal` collection `internal:sx` — CHỈ dùng nội bộ, KHÔNG dùng
cho truyền thông, chatbot khách không đọc được (`api.rag.answer()` không
có tham số collection, retrieve mặc định chỉ đọc `chunks` public).

Contract:
  - Nạp tài liệu: KHÔNG có code nạp riêng — dùng `python -m
    ingest.kb_internal --file F --collection internal:sx --approved-by
    "<GĐ SX>"` (khuyến nghị 20 dòng đầu có `DOI: 10.xxxx/...` hoặc
    `URL: https://...` để trích nguồn).
  - `ask(question, k=5, llm=False)`: câu rỗng/chỉ dấu câu, câu về rượu
    (`kb_filter.is_alcohol`) → NO_DATA, 0 embed. Embed qua
    `llm_gateway.embed("sx_tracuu", q)` → `api.rag.retrieve_by_vector(...,
    collection=COLLECTION)` (HẰNG module, không tham số); điểm top <
    `api.rag.MIN_SCORE` → NO_DATA. Nguồn: DOI/URL parse từ 20 dòng đầu
    chunk 0 của doc (1 SELECT), không có → "(chưa có DOI/URL — tên file …)".
  - Mặc định `extract`: trích đoạn NGUYÊN VĂN (≤600 ký tự/đoạn, ≤3 đoạn, qua
    `_mask_pii`) + `[n]` trỏ nguồn — không tổng hợp. `--llm`: 1 lời gọi
    `llm_gateway.chat("sx_tracuu")`; None/rỗng/GatewayError/guardrail
    `ok is not True` → về `extract` + ghi lý do (mã vi phạm, không trích span).
  - MỌI đầu ra (stdout + file `--out`) mở đầu nhãn `LABEL`.
  - Module CHỈ ĐỌC DB (0 ghi bảng), không có đường sang bản nháp nội dung/
    hàng duyệt/chatbot khách; không gửi/đăng gì.

Chạy:
  python -m agents.sx_tracuu --ask "<câu hỏi>" [--k N] [--llm] [--out]
Exit: 0 ok (kể cả NO_DATA) · 2 tham số sai / câu quá dài / DB down / lỗi DB.
"""

import argparse
import hashlib
import re
import sys
from contextlib import suppress
from datetime import datetime

import psycopg

from agents.report import REPORTS_DIR, write_report
from api import rag
from ingest.lead_store import connect
from pipelines import guardrail, kb_filter, llm_gateway
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

AGENT_ID = "sx_tracuu"
# HẰNG — không nhận collection từ CLI/hàm (không tra chéo phòng khác).
COLLECTION = "internal:sx"
LABEL = "NỘI BỘ – không dùng cho truyền thông"
NO_DATA = rag.NO_DATA
MAX_Q = 2000
DEFAULT_K = 5
MAX_K = 20
EXTRACT_MAX = 600
MAX_EXTRACTS = 3
CITE_LINES = 20
CITE_MAX = 300
LLM_MAX = 3000
_CITE_RE = re.compile(r"^(doi|url)\s*:\s*(\S+)")
_URL_OK = re.compile(r"https?://[^\s<>`\"']+")
_DOI_OK = re.compile(r"10\.\d{4,9}/[^\s<>`\"']+")
_WORD_RE = re.compile(r"\w")
_CITE_SQL = ("select doc_id, content from chunks_internal where collection ="
             " %s and doc_id = any(%s) and chunk_index = 0")
SYSTEM = ("Bạn hỗ trợ tra cứu tài liệu khoa học NỘI BỘ của bộ phận sản xuất."
          " Chỉ dựa vào NGỮ CẢNH được cung cấp, trích số nguồn dạng [n] sau"
          " mỗi ý. Không bổ sung kiến thức ngoài ngữ cảnh. Không kết luận"
          " công dụng cho người tiêu dùng, không khuyến nghị sử dụng sản"
          " phẩm. Thiếu thông tin thì nói rõ là tài liệu chưa đề cập.")


def _norm_q(question) -> str:
    return " ".join(str(question or "").split())


def _cite(doc_id: str, source_ref, head: str | None) -> str:
    """DOI/URL từ 20 dòng đầu chunk 0 (casefold); không có → tên file."""
    for line in (head or "").splitlines()[:CITE_LINES]:
        m = _CITE_RE.match(line.strip().casefold())
        if not m:
            continue
        # giữ nguyên chữ hoa/thường của giá trị (URL phân biệt hoa thường)
        raw = line.strip()[m.start(2):][:CITE_MAX].split()[0]
        if m.group(1) == "doi" and _DOI_OK.fullmatch(raw.casefold()):
            return f"DOI: {raw}"
        if m.group(1) == "url" and _URL_OK.fullmatch(raw):
            return f"URL: {raw}"
    name = " ".join(str(source_ref or doc_id).split())[:CITE_MAX]
    return f"(chưa có DOI/URL — tên file {name})"


def _no_data(reason: str) -> dict:
    return {"answer": NO_DATA, "sources": [], "label": LABEL,
            "mode": "no_data", "reason": reason}


def _extract(hits: list[dict], idx: dict) -> str:
    out = []
    for h in hits[:MAX_EXTRACTS]:
        text = _mask_pii(str(h.get("content") or "")[:EXTRACT_MAX * 2])
        text = " ".join(text.split())[:EXTRACT_MAX]
        out.append(f"[{idx[h['doc_id']]}] \"{text}\"")
    return "\n\n".join(out)


def _violation_codes(g: dict) -> str:
    codes = [str(v.get("type") or v.get("code") or "?")
             for v in (g.get("violations") or []) if isinstance(v, dict)]
    return ",".join(dict.fromkeys(codes)) or "ok_not_true"


def _llm_answer(question: str, hits: list[dict], idx: dict
                ) -> tuple[str | None, str]:
    ctx = "\n\n".join(f"[{idx[h['doc_id']]}] {h.get('title') or ''}\n"
                      f"{h.get('content') or ''}" for h in hits)
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"NGỮ CẢNH:\n{ctx}\n\n"
                                        f"CÂU HỎI: {question}"}]
    try:
        resp = llm_gateway.chat(AGENT_ID, msgs, feature="production-05.2",
                                temperature=0.0,
                                max_tokens=600)
        text = resp.choices[0].message.content
    except llm_gateway.GatewayError as e:
        return None, f"gateway: {type(e).__name__}"
    except (AttributeError, IndexError, TypeError):
        return None, "phản hồi LLM hỏng"
    if not isinstance(text, str) or not text.strip():
        return None, "LLM trả rỗng"
    text = _mask_pii(text.strip()[:LLM_MAX])
    g = guardrail.check(text)
    if g.get("ok") is not True:
        return None, f"guardrail: {_violation_codes(g)}"
    return text, ""


def ask(question, *, k: int = DEFAULT_K, llm: bool = False, now=None,
        conn=None) -> dict:
    """→ {"answer","sources":[{doc_id,title,source_ref,cite}],"label",
    "mode": extract|llm|no_data, "reason"}. `conn` dùng cho 1 SELECT
    trích nguồn (None → tự mở qua `lead_store.connect`)."""
    del now   # chữ ký thống nhất (không đọc đồng hồ)
    q = _norm_q(question)
    if not _WORD_RE.search(q):
        return _no_data("câu hỏi rỗng")
    if len(q) > MAX_Q:
        raise ValueError(f"câu hỏi dài quá {MAX_Q} ký tự")
    if kb_filter.is_alcohol(q):
        return _no_data("không tra cứu đồ uống có cồn")
    k = max(1, min(int(k), MAX_K))
    try:
        qv = llm_gateway.embed(AGENT_ID, q, feature="production-05.1"
                               ).data[0].embedding
    except llm_gateway.GatewayError as e:
        return _no_data(f"embed lỗi ({type(e).__name__})")
    hits = rag.retrieve_by_vector(qv, k, collection=COLLECTION)
    hits = [h for h in hits if h["score"] >= rag.MIN_SCORE]
    if not hits:
        return _no_data("không có tài liệu đủ liên quan")
    doc_ids = list(dict.fromkeys(h["doc_id"] for h in hits))
    own = conn is None
    c = connect() if own else conn
    if c is None:
        raise psycopg.OperationalError("không kết nối được Postgres")
    try:
        heads = dict(c.execute(_CITE_SQL, (COLLECTION, doc_ids)).fetchall())
        c.commit()   # đóng tx đọc (conn chia sẻ)
    finally:
        if own:
            with suppress(Exception):
                c.close()
    first = {}
    for h in hits:
        first.setdefault(h["doc_id"], h)
    idx = {d: i for i, d in enumerate(doc_ids, 1)}
    sources = [{"doc_id": d, "title": first[d].get("title"),
                "source_ref": first[d].get("url"),
                "cite": _cite(d, first[d].get("url"), heads.get(d))}
               for d in doc_ids]
    res = {"answer": _extract(hits, idx), "sources": sources, "label": LABEL,
           "mode": "extract", "reason": ""}
    if llm:
        text, why = _llm_answer(q, hits, idx)
        if text is None:
            res["reason"] = f"LLM bị loại: {why} — dùng trích đoạn"
        else:
            res["answer"], res["mode"] = text, "llm"
    return res


def render(res: dict, question: str) -> str:
    """Markdown — dòng ĐẦU luôn là nhãn nội bộ."""
    L = [f"**{LABEL}**", "",
         f"Câu hỏi: {_mask_pii(_norm_q(question))[:MAX_Q]}",
         f"Chế độ: {res['mode']}", "", res["answer"], ""]
    if res.get("reason"):
        L += [f"Ghi chú: {res['reason']}", ""]
    if res["sources"]:
        L += ["Nguồn:"]
        L += [f"[{i}] {' '.join(str(s.get('title') or s['doc_id']).split())}"
              f" — {s['cite']}" for i, s in enumerate(res["sources"], 1)]
        L.append("")
    L.append(f"*{LABEL}. Không trích dẫn ra kênh khách/marketing.*")
    return "\n".join(L) + "\n"


# Đợt hoàn thiện 22/10 (PL01 Kho tài liệu R&D (P2) "Tra cứu, tóm tắt tài
# liệu"): TRA CỨU (trích nguyên văn — production-05.1) và TÓM TẮT (LLM tổng
# hợp ĐÃ qua guardrail — production-05.2) là 2 đầu ra riêng. Tóm tắt bị loại
# (LLM lỗi/guardrail) → bản rơi về trích đoạn = đầu ra TRA CỨU, không tính là
# tóm tắt.
PREFIX_LOOKUP, PREFIX_SUMMARY = "sx-tracuu-", "sx-tomtat-"


def report_name(question: str, now: datetime, mode: str = "extract") -> str:
    sha = hashlib.sha256(_norm_q(question).encode("utf-8")).hexdigest()[:8]
    pre = PREFIX_SUMMARY if mode == "llm" else PREFIX_LOOKUP
    return f"{pre}{now.astimezone(VN_TZ):%Y-%m-%d}-{sha}.md"


def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.sx_tracuu",
        description=f"SX-A7 tra cứu khoa học nội bộ ({LABEL})")
    ap.add_argument("--ask", required=True, metavar="CÂU_HỎI")
    ap.add_argument("--k", type=int, default=DEFAULT_K,
                    help=f"số đoạn lấy về (1..{MAX_K})")
    ap.add_argument("--llm", action="store_true",
                    help="tổng hợp qua LLM (mặc định TẮT — trích đoạn)")
    ap.add_argument("--out", action="store_true",
                    help="ghi file data/reports/sx-tracuu-<ngày>-<sha8>.md "
                         "(tóm tắt LLM đạt guardrail → sx-tomtat-…)")
    a = ap.parse_args(argv)
    if len(_norm_q(a.ask)) > MAX_Q:
        ap.error(f"--ask dài quá {MAX_Q} ký tự")
    if not 1 <= a.k <= MAX_K:
        ap.error(f"--k phải trong 1..{MAX_K}")
    conn = connect()
    if conn is None:
        print("[warn] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    now = now or datetime.now(VN_TZ)
    try:
        res = ask(a.ask, k=a.k, llm=a.llm, conn=conn)
    except psycopg.Error as e:
        print(f"[warn] lỗi DB: {type(e).__name__}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()
    text = render(res, a.ask)
    print(text, end="")
    if a.out:
        try:
            # P8.4: tài liệu nội bộ trưởng phòng duyệt (chunks_internal).
            p = write_report(text, REPORTS_DIR,
                             report_name(a.ask, now, res["mode"]),
                             sample=False)
        except OSError as e:
            print(f"[warn] không ghi được file ({type(e).__name__})",
                  file=sys.stderr)
            return 2
        print(f"[done] {p}")
    return 0


if __name__ == "__main__":
    with job_run("agents.sx_tracuu") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
