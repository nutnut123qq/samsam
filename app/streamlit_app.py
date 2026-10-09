"""Demo UI — `streamlit run app/streamlit_app.py`

3 tab:
  - "Chat Sâm Sâm": hỏi/đáp trên knowledge base, mỗi câu trả lời kèm
    link nguồn (RAG — retrieve từ pgvector, trả lời bằng Claude).
    Answer qua guardrail như mọi kênh (invariant); NO_DATA → handoff
    text + ghi convlog để vào queue nhân viên.
  - "Content Studio": nhập brief → pipelines.content.draft() → hiển thị
    bài + kết quả guardrail (violation tô đỏ).
  - "Chưa trả lời": queue câu NO_DATA cho nhân viên follow-up / bổ
    sung knowledge base (đọc convlog `answered:false`).

Contract với UI: mọi câu trả lời chat phải render ít nhất 1 URL nguồn;
không có nguồn → hiển thị "không đủ dữ liệu" thay vì để model bịa.
"""

import time

import streamlit as st

st.set_page_config(page_title="Sâm Sâm AI Pilot", page_icon="🌿")
tab_chat, tab_studio, tab_queue = st.tabs(
    ["Chat Sâm Sâm", "Content Studio", "Chưa trả lời"])

with tab_chat:
    st.caption("Hỏi đáp trên knowledge base public của Sâm Sâm — "
               "câu trả lời luôn kèm nguồn; thiếu dữ liệu bot sẽ nói thẳng.")
    if "messages" not in st.session_state:
        st.session_state.messages = []
    # History riêng cho answer() — parity zalo._histories: chỉ lượt hợp
    # lệ (kể cả NO_DATA) vào và lưu RAW answer; lượt bị flag không vào.
    # messages[] chỉ để render (lưu text user thấy = display).
    if "history" not in st.session_state:
        st.session_state.history = []

    for m in st.session_state.messages:
        with st.chat_message(m["role"]):
            st.write(m["content"])
            if m.get("caption"):
                st.caption(m["caption"])
            for s in m.get("sources", []):
                st.markdown(f"- [{s}]({s})")

    if q := st.chat_input("Hỏi về Sâm Sâm..."):
        st.session_state.messages.append({"role": "user", "content": q})
        with st.chat_message("user"):
            st.write(q)
        with st.chat_message("assistant"):
            with st.spinner("Đang tra knowledge base..."):
                from api.rag import NO_DATA, answer
                # [-8:] = 4 lượt Q&A gần nhất — giống deque(maxlen=8).
                # monotonic cho latency_ms — elapsed-time, miễn clock
                # skew (V7.2, parity zalo.py).
                t0 = time.monotonic()
                r = answer(
                    q, history=st.session_state.history[-8:] or None)
                latency_ms = int((time.monotonic() - t0) * 1000)

            # Invariant: mọi text AI trước khi hiển thị phải qua
            # guardrail.check() — giống pipeline reply của zalo.
            from pipelines.guardrail import check
            g = check(r["answer"])
            if not g["ok"]:
                from connectors.zalo import FALLBACK
                display = FALLBACK
            elif NO_DATA in r["answer"]:
                # D6.1: handoff text có lối thoát thay câu NO_DATA trần
                from connectors.zalo import HANDOFF_TEXT
                display = HANDOFF_TEXT
            else:
                display = r["answer"]
            st.write(display)
            caption = None
            if g["ok"]:
                if NO_DATA in r["answer"]:
                    caption = ("Không có nguồn — chưa đủ dữ liệu, đã "
                               "chuyển nhân viên (xem tab 'Chưa trả lời').")
                    st.caption(caption)
                elif r["sources"]:
                    caption = "Nguồn:"
                    st.caption(caption)
                    for s in r["sources"]:
                        st.markdown(f"- [{s}]({s})")
            # Lượt bị flag: FALLBACK trần — không nguồn/caption "đã
            # chuyển nhân viên" (entry flagged không vào queue).

            # Cập nhật history theo semantics zalo: chỉ lượt hợp lệ, lưu
            # raw — flagged không cho LLM nhớ text vi phạm lượt sau.
            if g["ok"]:
                st.session_state.history = (
                    st.session_state.history
                    + [{"role": "user", "content": q},
                       {"role": "assistant", "content": r["answer"]}]
                )[-8:]

            # Ghi convlog như kênh Zalo — câu chưa trả lời vào queue
            # (answered:false). Log fail không được chặn hiển thị.
            try:
                from connectors import zalo as _z
                _z._log_conversation({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                        time.gmtime()),
                    "msg_id": "",
                    "user_hash": _z._ui_hash(st.session_state),
                    "question": _z._mask_pii(q),
                    "answer": display[:500],
                    "sources": r["sources"],
                    "guardrail_ok": g["ok"],
                    "latency_ms": latency_ms,
                    "answered": NO_DATA not in r["answer"],
                    # null chứ không phải False — kênh UI không có send
                    # API; sent:false = send-FAIL, đếm nhầm khi đối
                    # soát (D6.8, semantics D4.4).
                    "sent": None,
                    **({"flagged_text": r["answer"][:500]}
                       if not g["ok"] else {}),
                })
            except Exception as e:  # noqa: BLE001 — log không được chặn UI
                print(f"[warn] convlog streamlit: {e!r}", flush=True)

        st.session_state.messages.append(
            {"role": "assistant", "content": display,
             # Caption + nguồn chỉ kèm lượt hợp lệ — replay giữ đúng
             # hiển thị lượt live (flagged trần, handoff chỉ caption).
             "caption": caption,
             "sources": (r["sources"] if g["ok"] and NO_DATA
                         not in r["answer"] else [])})

with tab_studio:
    st.caption("Sinh bài từ brief — mọi text AI đều qua guardrail "
               "trước khi hiển thị (banned words + claim whitelist TPBVSK).")
    brief = st.text_area(
        "Brief", placeholder="VD: Viết bài FB giới thiệu Sapentol cho người "
        "tiểu đường, nhấn công dụng đã công bố...", height=100)
    channel = st.selectbox("Kênh", ["facebook", "zalo", "blog"])

    def _render_guardrail(g: dict):
        if g["ok"]:
            st.success("Guardrail: PASS — không vi phạm")
        else:
            for v in g["violations"]:
                st.error(f"**{v['type']}** — {v['detail']}"
                         + (f" → `{v['span']}`" if v.get("span") else ""))
        if g.get("matched_claims"):
            st.caption("Claim khớp whitelist: " + "; ".join(
                f"{m['sku']}: {m['claim']}" for m in g["matched_claims"]))

    if st.button("Sinh bài", type="primary", disabled=not brief.strip()):
        with st.spinner("Đang viết + kiểm guardrail..."):
            from pipelines.content import draft
            st.session_state.last_draft = draft(brief, channel)
    if r := st.session_state.get("last_draft"):
        st.markdown("##### Draft")
        st.markdown(r["text"])
        _render_guardrail(r["guardrail"])

    st.divider()
    st.caption("Kiểm tra nhanh một đoạn text có sẵn (không qua LLM):")
    raw = st.text_area("Text cần check", height=80, label_visibility="collapsed",
                       placeholder="Dán text vào đây — VD: Saphraton chữa khỏi tiểu đường")
    if st.button("Check guardrail") and raw.strip():
        from pipelines.guardrail import check
        _render_guardrail(check(raw))

with tab_queue:
    st.caption("Câu khách hỏi mà bot chưa trả lời được (convlog "
               "`answered:false`) — nhân viên follow-up / input cho vòng "
               "bổ sung knowledge base. Mới nhất lên đầu.")
    from connectors import zalo as _zalo
    _recs = _zalo.unanswered()
    if not _recs:
        st.info("Chưa có câu nào chờ — mọi câu hỏi đều đã được trả lời.")
    else:
        st.dataframe(
            [{"Thời gian (UTC)": e.get("ts", ""),
              "Câu hỏi": e.get("question", ""),
              "user_hash": e.get("user_hash", "")}
             for e in reversed(_recs)],
            use_container_width=True)
