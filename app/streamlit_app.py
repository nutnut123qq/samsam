"""Demo UI — `streamlit run app/streamlit_app.py`

2 tab:
  - "Chat Sâm Sâm": hỏi/đáp trên knowledge base, mỗi câu trả lời kèm
    link nguồn (RAG — retrieve từ pgvector, trả lời bằng Claude).
  - "Content Studio": nhập brief → pipelines.content.draft() → hiển thị
    bài + kết quả guardrail (violation tô đỏ).

Contract với UI: mọi câu trả lời chat phải render ít nhất 1 URL nguồn;
không có nguồn → hiển thị "không đủ dữ liệu" thay vì để model bịa.
"""

import streamlit as st

st.set_page_config(page_title="Sâm Sâm AI Pilot", page_icon="🌿")
tab_chat, tab_studio = st.tabs(["Chat Sâm Sâm", "Content Studio"])

with tab_chat:
    st.caption("Hỏi đáp trên knowledge base public của Sâm Sâm — "
               "câu trả lời luôn kèm nguồn; thiếu dữ liệu bot sẽ nói thẳng.")
    if "messages" not in st.session_state:
        st.session_state.messages = []

    for m in st.session_state.messages:
        with st.chat_message(m["role"]):
            st.write(m["content"])
            for s in m.get("sources", []):
                st.markdown(f"- [{s}]({s})")

    if q := st.chat_input("Hỏi về Sâm Sâm..."):
        st.session_state.messages.append({"role": "user", "content": q})
        with st.chat_message("user"):
            st.write(q)
        with st.chat_message("assistant"):
            with st.spinner("Đang tra knowledge base..."):
                from api.rag import answer
                # [:-1] bỏ câu hiện tại (vừa append ở trên) — history chỉ
                # gồm các lượt TRƯỚC; [-8:] = 4 lượt Q&A gần nhất.
                history = [{"role": m["role"], "content": m["content"]}
                           for m in st.session_state.messages[:-1][-8:]]
                r = answer(q, history=history)
            st.write(r["answer"])
            if r["sources"]:
                st.caption("Nguồn:")
                for s in r["sources"]:
                    st.markdown(f"- [{s}]({s})")
            else:
                st.caption("Không có nguồn — chưa đủ dữ liệu.")
        st.session_state.messages.append(
            {"role": "assistant", "content": r["answer"],
             "sources": r["sources"]})

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
