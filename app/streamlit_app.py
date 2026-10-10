"""Demo UI — `streamlit run app/streamlit_app.py`

6 tabs:
  - "Chat Sâm Sâm": hỏi/đáp trên knowledge base, mỗi câu trả lời kèm
    link nguồn (RAG — retrieve từ pgvector, trả lời bằng Claude).
    Answer qua guardrail như mọi kênh (invariant); NO_DATA → handoff
    text + ghi convlog để vào queue nhân viên.
  - "Content Studio": nhập brief → pipelines.content.draft() → hiển thị
    bài + kết quả guardrail (violation tô đỏ).
  - "Chưa trả lời": queue câu NO_DATA cho nhân viên follow-up / bổ
    sung knowledge base (đọc convlog `answered:false`).
  - "Leads": dashboard số liệu kênh + leads (WS2) — convlog theo kênh
    (file-based, luôn hiện) + bảng `leads` do `ingest.lead_store` nạp
    (DB lỗi/chưa nạp → info, không crash). Read-only ở pilot.
  - "Báo cáo": agent báo cáo định kỳ (WS3) — sinh/xem file markdown
    trong `data/reports/`; BẢN NHÁP cho người duyệt + gửi lãnh đạo,
    hệ thống KHÔNG tự gửi (C2.4). DB chết → vẫn sinh báo cáo degraded
    (phần convlog file-based vẫn có).
  - "Nhật ký vườn": agent nhật ký vùng trồng (WS3) — form ghi hoạt
    động vào `plot_logs` (source 'manual:garden'), chuẩn hóa hoạt
    động + cảnh báo bất thường (khoảnh lâu chưa ghi / keyword sâu
    bệnh). NGƯỜI ghi tay; DB chết → info, không crash.

Contract với UI: mọi câu trả lời chat phải render ít nhất 1 URL nguồn;
không có nguồn → hiển thị "không đủ dữ liệu" thay vì để model bịa.
"""

import time
from datetime import timezone

import streamlit as st

st.set_page_config(page_title="Sâm Sâm AI Pilot", page_icon="🌿")
tab_chat, tab_studio, tab_queue, tab_leads, tab_report, tab_garden = (
    st.tabs(["Chat Sâm Sâm", "Content Studio", "Chưa trả lời", "Leads",
             "Báo cáo", "Nhật ký vườn"]))

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

with tab_leads:
    st.caption("Dashboard WS2: số liệu kênh chat + lead gom từ convlog "
               "(câu hỏi có ý định mua/giá/địa-điểm/đại-lý → bảng "
               "`leads`). Read-only ở pilot — cập nhật `status` qua DB.")
    from ingest import lead_store as _ls

    # Phần file-based luôn hiện được (kể cả khi DB lõi chưa nạp).
    _conv = _ls.convlog_stats()
    st.markdown("##### Kênh chat (convlog)")
    c1, c2, c3 = st.columns(3)
    c1.metric("Tin nhắn", _conv["total"])
    _rate = (f"{round(100 * _conv['answered'] / _conv['total'])}%"
             if _conv["total"] else "—")
    c2.metric("Đã trả lời", _rate)
    c3.metric("Zalo / Streamlit",
              f"{_conv['by_channel'].get('zalo', 0)} / "
              f"{_conv['by_channel'].get('streamlit', 0)}")

    st.divider()
    st.markdown("##### Leads (bảng `leads`)")
    _conn = _ls.connect()
    _stats = _ls.lead_stats(_conn) if _conn else None
    if _conn:
        _conn.close()
    if _stats is None:
        st.info("Chưa có dữ liệu leads — chạy `python "
                "scripts/apply_schema.py` rồi `python -m "
                "ingest.lead_store`.")
    else:
        c1, c2 = st.columns(2)
        c1.metric("Tổng leads", _stats["total"])
        c2.metric("Mới 7 ngày", _stats["new_7d"])
        ic1, ic2, ic3 = st.columns(3)
        for col, label, key in (
                (ic1, "Theo kênh", "by_channel"),
                (ic2, "Theo intent", "by_intent"),
                (ic3, "Theo trạng thái", "by_status")):
            counts = _stats[key]
            summary = "; ".join(
                f"{k}={v}" for k, v in sorted(counts.items())) or "—"
            col.caption(f"{label}: {summary}")
        if not _stats["recent"]:
            st.info("Bảng leads trống — chạy `python -m ingest.lead_store`.")
        else:
            st.dataframe(
                [{"Thời gian (UTC)": e[0].astimezone(timezone.utc)
                  .strftime("%Y-%m-%d %H:%M"), "Kênh": e[1],
                  "Intent": e[2], "Câu hỏi": e[3], "user_hash": e[4],
                  "Trạng thái": e[5]}
                 for e in _stats["recent"]],
                use_container_width=True,
                column_config={
                    "Thời gian (UTC)": st.column_config.TextColumn(width=145),
                    "Kênh": st.column_config.TextColumn(width=60),
                    "Intent": st.column_config.TextColumn(width=70),
                    "Câu hỏi": st.column_config.TextColumn(width=200),
                    "user_hash": st.column_config.TextColumn(width=115),
                    "Trạng thái": st.column_config.TextColumn(width=80),
                })

with tab_report:
    st.caption("Agent báo cáo định kỳ (WS3) — tổng hợp bán hàng + "
               "leads + kênh chat + nhật ký vườn ra file markdown "
               "trong `data/reports/`. Báo cáo là BẢN NHÁP: duyệt + "
               "gửi lãnh đạo do NGƯỜI — hệ thống KHÔNG tự gửi (C2.4). "
               "Chạy định kỳ ngoài UI: `python -m agents.report`.")
    from agents import report as _rep

    _days = st.selectbox("Kỳ báo cáo", [7, 14, 30],
                         format_func=lambda d: f"{d} ngày gần nhất")
    if st.button("Sinh báo cáo", type="primary"):
        with st.spinner("Đang tổng hợp số liệu..."):
            _path, _r = _rep.generate(days=_days)
            st.session_state.report_path = str(_path)
            st.session_state.report_db_ok = _r["db"].get("db_ok")
    # Thông báo kết quả lần sinh gần nhất (persist qua rerun —
    # report_path chỉ có sau khi đã bấm nút ít nhất 1 lần).
    if st.session_state.get("report_path"):
        if st.session_state.get("report_db_ok") is False:
            st.warning("Đã ghi báo cáo DEGRADED — không kết nối "
                       "được DB, phần DB đánh dấu [chưa nạp]: "
                       + st.session_state.report_path)
        else:
            st.success("Đã ghi " + st.session_state.report_path)

    st.divider()
    _files = _rep.list_reports()
    if not _files:
        st.info("Chưa có báo cáo nào — bấm 'Sinh báo cáo' hoặc chạy "
                "`python -m agents.report`.")
    else:
        _pick = st.selectbox(
            "Báo cáo đã sinh (mới nhất trước)", _files,
            format_func=lambda p: p.name)
        # File do chính agent ghi utf-8 — read_text strict được
        # (không phải file user-influenced như convlog).
        st.markdown(_pick.read_text(encoding="utf-8"))

with tab_garden:
    st.caption("Agent nhật ký vùng trồng (WS3) — nhân viên ghi hoạt "
               "động theo khoảnh; hệ thống chuẩn hóa + cảnh báo bất "
               "thường (khoảnh lâu chưa ghi, nhật ký có dấu hiệu sâu "
               "bệnh). Nhật ký do NGƯỜI nhập — hệ thống không tự sinh. "
               "CLI: `python -m agents.garden --check`.")
    from datetime import datetime as _dt

    import psycopg as _pg

    from agents import garden as _g
    from ingest.lead_store import connect as _ldb

    _gconn = _ldb()
    if _gconn is None:
        st.info("Chưa nạp — không kết nối được Postgres (kiểm tra "
                "DATABASE_URL). Nhật ký vườn cần DB.")
    else:
        try:
            _plots = _g.active_plots(_gconn)
            _anoms = _g.anomaly_check(_gconn)
            _recent = _g.recent_logs(_gconn)
        except _pg.Error:
            _gconn = None
            st.info("Lỗi đọc DB — thử tải lại trang.")
    if _gconn is not None:
        st.subheader("Ghi nhật ký")
        _labels = [f"{pid} — {loc}" if loc else pid
                   for pid, loc in _plots]
        _pick_plot = (st.selectbox("Khoảnh", _labels)
                      if _labels else None)
        _act_pick = st.selectbox("Hoạt động",
                                 list(_g.ACTIVITY_VOCAB) + ["khác…"])
        _act_free = (st.text_input("Hoạt động khác (tự ghi)")
                     if _act_pick == "khác…" else "")
        _d = st.date_input("Ngày")
        _det = st.text_area("Chi tiết", height=68)
        _auth = st.text_input("Người ghi")
        if st.button("Ghi nhật ký", type="primary"):
            if not _pick_plot:
                st.error("Chưa có khoảnh active nào trong DB.")
            elif _d is None:
                st.error("Chọn ngày cho nhật ký.")
            else:
                _pid = _pick_plot.split(" — ")[0]
                _act = _act_free.strip() or _act_pick
                _ts = _dt.combine(_d, _dt.now(timezone.utc).time(),
                                  tzinfo=timezone.utc)
                try:
                    _lid, _warns = _g.add_log(
                        _gconn, _pid, _ts, _act, _det.strip(),
                        _auth.strip())
                except _pg.Error:
                    _lid, _warns = None, ["Lỗi DB khi ghi — thử lại."]
                for _w in _warns:
                    st.warning(_w)
                if _lid is not None:
                    st.success(f"Đã ghi nhật ký #{_lid}: {_pid} — {_act}")
                else:
                    st.error("Không ghi được — xem cảnh báo.")

        st.subheader("Cần chú ý")
        if _anoms:
            for _a in _anoms:
                st.warning(_a["msg"])
        else:
            st.info("Không có bất thường — mọi khoảnh active đều có "
                    "nhật ký gần đây.")

        st.subheader("Nhật ký gần nhất")
        if _recent:
            st.dataframe([
                {"Thời gian (UTC)": (ts.astimezone(timezone.utc)
                     .strftime("%Y-%m-%d %H:%M")
                     if hasattr(ts, "astimezone") else str(ts)[:16]),
                 "Khoảnh": pid, "Hoạt động": act,
                 "Chi tiết": det or "", "Người ghi": au or "",
                 "Nguồn": src}
                for ts, pid, act, det, au, src in _recent],
                hide_index=True)
        else:
            st.info("Chưa có nhật ký nào.")
        _gconn.close()
