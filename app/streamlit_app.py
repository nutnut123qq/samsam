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
    st.info("T2.2 — chưa implement. Xem TASKS.md")

with tab_studio:
    st.info("T3.2 — chưa implement. Xem TASKS.md")
