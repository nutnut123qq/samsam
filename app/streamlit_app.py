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
                r = answer(q)
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
    st.info("T3.2 — chưa implement. Xem TASKS.md")
