"""WS2 — hàng duyệt + lịch đăng nội dung (`content_drafts`).

Contract:
  - Bảng `content_drafts` tạo bởi `docs/schema.sql` — chạy
    `python scripts/apply_schema.py`. Draft là tài sản NGƯỜI tạo →
    update theo id, KHÔNG delete-by-source (precedent leads v1.9).
  - Status one-way `pending -> approved|rejected`: mọi chuyển khác
    (sai id, đã duyệt/từ chối trước đó) → `set_status` trả
    (False, warn) KHÔNG raise — UI/CLI hiện warn thân thiện.
  - v3.4: function DB là NGUỒN SỰ THẬT cho mọi chuyển trạng thái —
    `approve_draft` / `reject_draft` / `schedule_draft` (SECURITY
    DEFINER, docs/schema.sql). Module này KHÔNG chạy UPDATE lên bảng draft
    trực tiếp; role `agent_writer` (agent) không có quyền UPDATE nên
    không tự duyệt được, role `app_human` (người) chỉ đi qua function.
  - approve CHỈ khi guardrail ok (double-gate SOW): bài vi phạm phải
    reject/regen — không có duyệt-kèm-ghi-nhận. Python chạy LẠI guardrail
    CHẾ ĐỘ ĐĂNG BÀI (v4.2) trên text từ DB với kênh của draft —
    `guardrail_llm.check_publish_llm(text, channel=<draft.channel>,
    readiness=<view sku_readiness>)` (luật + lớp LLM-check nếu cấu hình;
    snapshot jsonb do agent ghi có thể giả `ok:true`) trước khi gọi
    function; function kiểm lại snapshot + `created_by` có + người duyệt
    ≠ người tạo (atomic, `for update` — race 2 người duyệt thì người sau
    thua).
  - v6.1 ngữ cảnh draft THEO CỘT: `content_type` (mặc định `post`),
    `sku` (None = không gắn SKU), `is_ai` (mặc định True — fail-closed),
    `prompt_version`/`prompt_sha256` (template data/prompts/). Lưu và
    duyệt chạy `check_publish` với đúng loại/SKU của draft — lúc duyệt
    đọc TỪ DÒNG DB (`.get` — dòng thiếu cột coi như mặc định), không tin
    caller. Riêng `is_ai`: lúc DUYỆT luôn True (fail-closed như v4.2) —
    cột chỉ để truy vết, vì agent_writer ghi được cột (is_ai=false sẽ tự
    bỏ yêu cầu nhãn AI). Bỏ cố định khi có đường ghi is_ai=false chỉ
    dành cho người (app_human). Không tài trợ (`is_sponsored` chưa có
    cột). Kênh `blog` -> `web` (alias); kênh lạ -> "config" -> không duyệt được.
  - Readiness (v4.2/v6.1): đọc view `sku_readiness` (`readiness_from_db`,
    trong savepoint) khi text nhắc SKU HOẶC draft có cột `sku`; lỗi DB /
    conn None -> soi gương golden file (fail-closed: file chưa SKU nào
    XNQC).
  - v6.1 listing: partial unique index (sku, channel, prompt_version)
    với `content_type='listing'` và status ≠ rejected — INSERT trùng raise
    `psycopg.errors.UniqueViolation` cho caller (batch content coi là
    `skipped`).
  - `save_draft` (v4.2) chạy lại LUẬT đăng bài (không gọi LLM) và lưu
    snapshot không bao giờ lỏng hơn luật hay snapshot caller.
  - Mỗi quyết định ghi `approvals` kèm sha256 text lúc duyệt;
    `verify_publish(conn, id, text)` so bản phát hành với bản đã duyệt.
  - `save_draft` bắt buộc `created_by` + ghi 1 dòng `agent_action_log`
    (`draft_create`) cùng transaction. `--verify-log` kiểm hash chain.
  - `schedule` chỉ trên draft approved + ngày ≥ hôm nay giờ VN + text
    còn khớp sha bản đã duyệt; bắt buộc người xếp lịch (`--by`).
  - v13.5 ủy quyền (F08): approve/reject/schedule qua
    `pipelines.auth.authorize` (khối = phòng ban của tính năng trong danh
    mục, không thuộc → marketing). Chế độ thực (AUTH_MODE local|proxy /
    APPROVAL_ENFORCE / DEPLOY): người thuộc `approvers` khối, vai trò đúng,
    CLI chạy bằng login Postgres riêng khớp `db_login` — `--by` free-text
    không còn đủ. Dev: cảnh báo. Gọi thẳng `approve_draft` bằng login
    `app_human` (bỏ qua module này) thì DB vẫn chặn agent/người tạo nhưng
    không đối chiếu approvers — vì vậy mỗi người duyệt 1 login riêng,
    `approvals.db_role`/log ghi login thật.
  - Mọi ghi-tác-vụ: `conn.transaction()` + `conn.commit()` TƯỜNG
    MINH — trên conn chia sẻ đã-trong-tx (UI SELECT trước) block
    transaction() chỉ là savepoint, thiếu commit() → INSERT/UPDATE
    rollback ngầm (bug v2.1).
  - v13.3 cưỡng chế giai đoạn (`pipelines.rollout.mode`, HĐ 6.7), draft
    gắn tính năng qua `output_sources` content_drafts (created_by + loại):
    `save_draft` của tính năng `tat` → RolloutBlocked (ValueError);
    approve → (False, lý do) khi `tat`; `schedule` (biên DÙNG) chặn khi
    `chay_thu`/`tat`/không thuộc danh mục, `co_nguoi_duyet` chỉ draft NGƯỜI
    duyệt. `verify_publish` KHÔNG gắn cổng (đọc cho audit ceo_audit/
    mkt_ads/bks_audit).
  - Lịch đăng là KẾ HOẠCH cho người đăng tay — hệ thống KHÔNG tự
    đăng/tự chuyển status (human-gate C2.4).
  - DB down: `connect()` (ingest.lead_store, connect_timeout=3) →
    None; đọc (`--pending`/`--calendar`) → "chưa nạp" exit 0
    (precedent report); ghi (`--approve`/`--reject`/`--schedule`)
    → exit 2 (precedent garden). UI `st.info`.

Chạy:
  python -m pipelines.store --pending
  python -m pipelines.store --approve ID --by "Tên" [--note "..."]
  python -m pipelines.store --reject  ID --by "Tên" [--note "..."]
  python -m pipelines.store --schedule ID YYYY-MM-DD --by "Tên"
  python -m pipelines.store --calendar [--days 14]
  python -m pipelines.store --verify-log
"""

import argparse
import hashlib
import re
import sys
from contextlib import contextmanager, suppress
from datetime import date, datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Jsonb

from ingest.lead_store import connect
from pipelines import guardrail

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in
# tiếng Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

CHANNELS = ("facebook", "tiktok", "blog", "zalo")
STATUSES = ("pending", "approved", "rejected")
SOURCE_STUDIO = "manual:studio"
SOURCE_CLI = "cli"
DEFAULT_LIMIT = 50
DEFAULT_DAYS = 14
OBJECT_TYPE = "content_draft"
# Việt Nam không có DST — offset cố định, không cần tzdata.
VN_TZ = timezone(timedelta(hours=7))

COLS = ("id", "created_at", "brief", "channel", "text", "guardrail",
        "status", "reviewer", "reviewed_at", "review_note",
        "scheduled_date", "source", "created_by",
        "content_type", "sku", "is_ai", "prompt_version", "prompt_sha256")

_INSERT_SQL = (
    "insert into content_drafts (brief, channel, text, guardrail, source, "
    "created_by, content_type, sku, is_ai, prompt_version, prompt_sha256) "
    "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning id")

_LOG_SQL = (
    "insert into agent_action_log (actor, action, object_type, object_id, "
    "detail) values (%s, %s, %s, %s, %s)")


def content_sha256(text: str) -> str:
    """sha256 hex byte-exact UTF-8, không normalize — khớp PG
    `encode(sha256(convert_to(t, 'UTF8')), 'hex')`."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _db_msg(e: Exception) -> str:
    """Thông điệp lỗi function DB (raise tiếng Việt) — không kèm
    context/SQL."""
    diag = getattr(e, "diag", None)
    return (getattr(diag, "message_primary", None) or str(e)).strip()

_SELECT_SQL = f"select {', '.join(COLS)} from content_drafts"

_READINESS_SQL = "select sku_key, channel, readiness from sku_readiness"


def readiness_from_db(conn) -> dict | None:
    """Map (sku_key, channel) -> readiness từ view `sku_readiness`.

    Đọc trong `conn.transaction()` (savepoint nếu conn đã trong tx — lỗi
    không làm hỏng tx ngoài, gotcha v2.1). conn None / lỗi DB / hàng sai
    shape -> None (= guardrail soi gương golden file, fail-closed)."""
    if conn is None:
        return None
    try:
        with conn.transaction():
            rows = conn.execute(_READINESS_SQL).fetchall()
        return {(str(k), str(c)): str(r) for k, c, r in rows}
    except (psycopg.Error, TypeError, ValueError):
        return None


def readiness_now() -> dict | None:
    """Mở conn ngắn (`connect` có connect_timeout) đọc view `sku_readiness`
    cho caller không giữ conn (Studio: sinh bài + ô check tay). DB chết /
    lỗi -> None (= soi gương golden file, fail-closed)."""
    with _conn_or_none() as (conn, _err):
        return readiness_from_db(conn)


def _publish_check(conn, text: str, channel, *, llm: bool,
                   content_type="post", sku=None, is_ai=True) -> dict:
    """Guardrail đăng bài cho draft theo ngữ cảnh draft (loại/SKU/is_ai —
    docstring module). Readiness DB đọc khi text nhắc SKU HOẶC draft gắn
    `sku`. `llm=False` -> chỉ luật (bước lưu)."""
    ctx = {"channel": channel, "content_type": content_type, "sku": sku,
           "is_ai": is_ai}
    rules = guardrail.check_publish(text, **ctx)
    rmap = (readiness_from_db(conn)
            if rules.get("skus") or sku is not None else None)
    if not llm:
        res = (rules if rmap is None
               else guardrail.check_publish(text, readiness=rmap, **ctx))
    else:
        # Import LƯỜI (gộp M31 đợt 4): guardrail_llm kéo llm_gateway/openai
        # lúc import — import ở đầu module làm MỌI module chỉ cần helper
        # của store (`_db_msg`, `_oneline` — vd pipelines.director, khối kế
        # toán v9.0) kéo theo gateway/mạng (test_fin_qa). Chỉ nhánh llm=True
        # mới cần lớp LLM-check.
        from pipelines import guardrail_llm
        res = guardrail_llm.check_publish_llm(text, readiness=rmap, **ctx)
    # v6.1 (rà OWASP A01): loại `public: false` (internal_note) bỏ qua luật
    # đăng bài (rượu/XNQC/nhãn) — dòng mang loại đó không được vào hàng
    # duyệt ĐĂNG (agent_writer ghi được cột content_type) -> chặn "config".
    cfg, _err = guardrail._load_rules(guardrail.DATA_DIR)
    ctype = (cfg["content_types"].get(content_type)
             if cfg and isinstance(content_type, str) else None)
    if isinstance(ctype, dict) and not ctype.get("public", True):
        res = guardrail.with_violation(
            res, "config", f"loại nội dung {content_type!r} không công khai "
            "— không vào hàng duyệt đăng bài")
    return res


def _merge_snapshot(rules: dict, caller) -> dict:
    """Snapshot lưu = kết quả luật + violation `llm_*` của caller (thêm qua
    `with_violation`, chỉ chặn thêm) + `llm_check`/`llm_model` caller. ok =
    luật.ok VÀ caller.ok is True — không bao giờ lỏng hơn bên nào.
    ok False mà không còn violation nào (caller chặn bằng luật mà lần chạy
    lại không lặp lại, vd caller soi file còn lưu dùng view DB) -> chép
    violation của caller kèm "(snapshot lúc sinh)"; caller không có chi
    tiết -> violation `config` — UI không bao giờ hiện "KHÔNG RÕ"."""
    out = dict(rules)
    c = caller if isinstance(caller, dict) else {}
    viols = c.get("violations")
    for v in viols if isinstance(viols, list) else []:
        code = v.get("code") if isinstance(v, dict) else None
        if isinstance(code, str) and code.startswith("llm_"):
            out = guardrail.with_violation(
                out, code, v.get("detail"), v.get("span"), v.get("start"),
                v.get("end"))
    for k in ("llm_check", "llm_model"):
        if isinstance(c.get(k), str):
            out[k] = c[k][:100]
    out["ok"] = out.get("ok") is True and c.get("ok") is True
    if out["ok"] is False and not out.get("violations"):
        for v in viols if isinstance(viols, list) else []:
            if isinstance(v, dict) and isinstance(v.get("code"), str):
                out = guardrail.with_violation(
                    out, v["code"][:64],
                    f"(snapshot lúc sinh) {v.get('detail') or ''}",
                    v.get("span"), v.get("start"), v.get("end"))
        if not out.get("violations"):
            out = guardrail.with_violation(
                out, "config", "snapshot lúc sinh ok != true, không có chi "
                "tiết vi phạm — sinh/kiểm lại bài trước khi lưu")
    return out


def _rollout():
    from pipelines import rollout  # lười: rollout import module này
    return rollout


def _draft_block(cur: dict) -> str:
    """v13.5: khối sở hữu draft = phòng ban của tính năng (output_sources
    content_drafts); không thuộc danh mục → 'marketing' (nội dung)."""
    fid = _draft_feature(cur.get("created_by"),
                         cur.get("content_type") or "post")
    for f in _rollout()._catalog() or []:
        if f["id"] == fid and f.get("phong_ban"):
            return f["phong_ban"]
    return "marketing"


def _authz(conn, cur: dict, by, action: str, via: str, role) -> str | None:
    """v13.5 (F08): cổng `auth.authorize` cho draft → lý do chặn | None.
    Chế độ thực: khối theo danh mục, người tạo từ DÒNG DB, login Postgres
    của kết nối (CLI). Lần bị chặn ghi `authz_denied` vào log."""
    from pipelines import auth  # lười: auth → director → module này
    block = _draft_block(cur)
    enforced = auth.approval_enforced()
    ok, why = auth.authorize(
        by, block, action, created_by=cur.get("created_by"), role=role,
        via=via, db_login=(auth.session_login(conn)
                           if enforced and via != "ui" else None))
    if ok and enforced and via != "ui":
        # v14.2: CLI chế độ thực không chạy bằng login superuser/owner.
        why = auth.privileged_login(conn)
        ok = why is None
    if ok:
        return None
    auth.deny_log(conn, by, block, action, OBJECT_TYPE, cur["id"], why)
    return f"draft #{cur['id']}: {why}"


def _draft_feature(created_by, content_type) -> str | None:
    """v13.3: draft → tính năng theo `output_sources` content_drafts."""
    return _rollout().feature_for(table="content_drafts",
                                  created_by=(created_by or "").strip(),
                                  content_type=content_type)


def save_draft(conn, brief: str, channel: str, text: str,
               guardrail: dict, source: str = SOURCE_STUDIO, *,
               created_by: str | None = None, content_type: str = "post",
               sku: str | None = None, is_ai: bool = True,
               prompt_version: str | None = None,
               prompt_sha256: str | None = None):
    """INSERT 1 draft → id. `guardrail` = snapshot kết quả guardrail lúc
    sinh (caller); v4.2 LƯU snapshot = luật `check_publish` chạy lại trên
    text với kênh draft (readiness DB nếu có) gộp chặt-nhất với snapshot
    caller (`_merge_snapshot`) — không gọi LLM ở bước lưu. Channel lạ vẫn
    ghi nguyên văn (draft của người — DB không chặn vocab, queue
    hiển thị đúng thứ đã lưu). `created_by` BẮT BUỘC (rỗng →
    ValueError trước khi chạm DB) — không có người tạo thì không kiểm
    được "người duyệt ≠ người tạo". Ghi kèm 1 dòng log `draft_create`
    cùng transaction. commit() tường minh — xem docstring module.
    v6.1: `content_type`/`sku`/`is_ai`/`prompt_*` ghi vào cột và là ngữ
    cảnh luật lúc lưu (mặc định = hành vi cũ: post, None, True)."""
    by = (created_by or "").strip()
    if not by:
        raise ValueError("save_draft: thiếu created_by (người/agent tạo)")
    text = text or ""
    ch = (channel or "").strip()
    is_ai = is_ai is not False
    _rollout().check_generate(conn, _draft_feature(by, content_type),
                              f"nháp {content_type}")
    snap = _merge_snapshot(
        _publish_check(conn, text, ch, llm=False, content_type=content_type,
                       sku=sku, is_ai=is_ai), guardrail)
    with conn.transaction():
        row = conn.execute(
            _INSERT_SQL,
            ((brief or "").strip(), ch, text,
             Jsonb(snap), source, by, content_type, sku, is_ai,
             prompt_version, prompt_sha256)).fetchone()
        did = row[0] if row else None
        if did is not None:
            conn.execute(_LOG_SQL, (
                by, "draft_create", OBJECT_TYPE, str(did),
                Jsonb({"channel": ch,
                       "source": source,
                       "content_type": content_type,
                       "sku": sku,
                       "prompt_version": prompt_version,
                       "content_sha256": content_sha256(text)})))
    conn.commit()
    return did


def _rows(cur) -> list[dict]:
    return [dict(zip(COLS, r)) for r in cur.fetchall()]


def list_drafts(conn, status: str | None = None,
                limit: int = DEFAULT_LIMIT) -> list[dict]:
    """→ list dict theo COLS, mới nhất trước. `status` None → tất cả;
    status lạ → truyền thẳng vào WHERE (DB trả rỗng, không raise)."""
    if status is None:
        cur = conn.execute(
            _SELECT_SQL + " order by created_at desc, id desc limit %s",
            (limit,))
    else:
        cur = conn.execute(
            _SELECT_SQL + " where status = %s "
            "order by created_at desc, id desc limit %s",
            (status, limit))
    return _rows(cur)


def _get(conn, draft_id) -> dict | None:
    """→ row dict | None khi không tìm thấy / id không phải số.
    `psycopg.Error` PROPAGATE — caller phải phân biệt 'không có'
    vs 'conn chết' thay vì báo 'không tìm thấy' ảo (NIT v2.2)."""
    row = conn.execute(
        _SELECT_SQL + " where id = %s", (draft_id,)).fetchone()
    return dict(zip(COLS, row)) if row else None


def _same_person(a, b) -> bool:
    """So khớp người như function DB: lower(btrim(.))."""
    return (a or "").strip().lower() == (b or "").strip().lower()


def set_status(conn, draft_id, status: str, reviewer: str,
               note: str | None = None, *, via: str = "cli",
               role: str | None = None) -> tuple[bool, str | None]:
    """pending -> approved|rejected → (True, None) | (False, warn).

    Warn không raise: id không tồn tại / id không phải số / draft
    không còn pending / approve khi guardrail chưa ok (snapshot HOẶC
    chạy lại `check_publish_llm` với kênh draft trên text từ DB — chạy
    SAU các pre-check rẻ để không tốn lời gọi LLM) / thiếu người tạo /
    người duyệt = người tạo / thiếu tên người duyệt / status đích lạ /
    function DB từ chối (thông điệp của function). Chuyển trạng thái CHỈ qua
    `approve_draft` / `reject_draft` (DB là nguồn sự thật; pre-check
    Python chỉ để warn thân thiện)."""
    status = (status or "").strip()
    if status not in ("approved", "rejected"):
        return False, (f"status đích '{status}' không hợp lệ — chỉ "
                       f"approved|rejected (one-way từ pending)")
    if not (reviewer or "").strip():
        return False, "thiếu tên người duyệt (--by) — bắt buộc cho audit"
    try:
        did = int(draft_id)
    except (TypeError, ValueError):
        return False, f"id '{draft_id}' không hợp lệ"
    try:
        cur = _get(conn, did)
    except psycopg.Error as e:
        return False, f"lỗi DB khi đọc draft #{did}: {e}"
    if cur is None:
        return False, f"không tìm thấy draft #{did}"
    if cur["status"] != "pending":
        return False, (f"draft #{did} đã ở trạng thái "
                       f"'{cur['status']}' — chỉ duyệt từ pending")
    if status == "approved":
        why = _rollout().decide_reason(
            conn, _draft_feature(cur.get("created_by"),
                                 cur.get("content_type") or "post"),
            f"draft #{did}")
        if why:
            return False, why
        g = cur["guardrail"]
        if not (isinstance(g, dict) and g.get("ok") is True):
            return False, (f"draft #{did} vi phạm guardrail (ok != true) "
                           f"— phải reject hoặc viết lại; không có "
                           f"duyệt-kèm-ghi-nhận")
        if not (cur.get("created_by") or "").strip():
            return False, (f"draft #{did} không có người tạo (draft trước "
                           f"v3.4) — không duyệt được, reject rồi tạo lại")
        if _same_person(cur.get("created_by"), reviewer):
            return False, (f"bạn là người tạo draft #{did} — cần người "
                           f"khác duyệt")
        # v13.5: ủy quyền người duyệt khối TRƯỚC lời gọi LLM-check.
        why = _authz(conn, cur, reviewer, "approve", via, role)
        if why:
            return False, why
        # Snapshot jsonb do agent ghi — có thể giả ok:true. Chạy LẠI
        # guardrail ĐĂNG BÀI (kênh draft + readiness DB + LLM-check nếu
        # cấu hình) trên text thật trong DB trước khi gọi function.
        # v6.1: ngữ cảnh luật đọc TỪ DÒNG DB (`.get` — dòng thiếu cột coi
        # như mặc định post/None), không tin caller. `is_ai` CỐ ĐỊNH True
        # (fail-closed như v4.2): cột is_ai chỉ để truy vết — agent_writer
        # ghi được cột này, tin nó = agent tự bỏ yêu cầu nhãn AI.
        recheck = _publish_check(conn, cur["text"] or "", cur["channel"],
                                 llm=True,
                                 content_type=cur.get("content_type")
                                 or "post",
                                 sku=cur.get("sku"), is_ai=True)
        if recheck.get("ok") is not True:
            vs = [v for v in recheck.get("violations") or []
                  if isinstance(v, dict)]
            codes = ", ".join(dict.fromkeys(
                str(v.get("code") or v.get("type")) for v in vs)) or "?"
            return False, (f"draft #{did} vi phạm guardrail khi kiểm lại "
                           f"text ({len(vs)} vi phạm: {codes}) — snapshot "
                           f"lúc lưu không khớp; phải reject hoặc viết lại")
        sql = "select approve_draft(%s, %s, %s)"
    else:
        why = _authz(conn, cur, reviewer, "reject", via, role)
        if why:
            return False, why
        sql = "select reject_draft(%s, %s, %s)"
    try:
        with conn.transaction():
            conn.execute(sql, (did, reviewer.strip(), (note or None)))
        conn.commit()
    except psycopg.Error as e:
        return False, f"draft #{did}: {_db_msg(e)}"
    return True, None


def _coerce_date(v) -> date | None:
    """date / 'YYYY-MM-DD' → date | None (datetime lấy phần ngày)."""
    if isinstance(v, date):
        return v if type(v) is date else v.date()
    if isinstance(v, str):
        try:
            return date.fromisoformat(v.strip())
        except ValueError:
            return None
    return None


def _vn_today() -> date:
    return datetime.now(VN_TZ).date()


def schedule(conn, draft_id, day, by: str | None = None,
             today: date | None = None, *, via: str = "cli",
             role: str | None = None) -> tuple[bool, str | None]:
    """Xếp lịch đăng → (True, None) | (False, warn). Chỉ draft
    approved; `day` (date/ISO-str) không được quá khứ (giờ VN — function
    DB kiểm lại); `by` = người xếp lịch, bắt buộc. Đi qua
    `schedule_draft` (kiểm thêm text còn khớp sha bản đã duyệt).
    `today` inject được cho test."""
    if not (by or "").strip():
        return False, "thiếu tên người xếp lịch (--by) — bắt buộc cho audit"
    d = _coerce_date(day)
    if d is None:
        return False, (f"ngày '{day}' không hợp lệ — định dạng "
                       f"YYYY-MM-DD")
    today = today or _vn_today()
    if d < today:
        return False, (f"ngày {d:%Y-%m-%d} đã qua — chỉ xếp lịch "
                       f"từ hôm nay trở đi")
    try:
        did = int(draft_id)
    except (TypeError, ValueError):
        return False, f"id '{draft_id}' không hợp lệ"
    try:
        cur = _get(conn, did)
    except psycopg.Error as e:
        return False, f"lỗi DB khi đọc draft #{did}: {e}"
    if cur is None:
        return False, f"không tìm thấy draft #{did}"
    if cur["status"] != "approved":
        return False, (f"draft #{did} đang '{cur['status']}' — chỉ "
                       f"xếp lịch bài đã approved")
    why = _authz(conn, cur, by, "schedule", via, role)
    if why:
        return False, why
    ro = _rollout()
    why = ro.use_reason(conn, _draft_feature(cur.get("created_by"),
                                             cur.get("content_type")
                                             or "post"),
                        f"xếp lịch đăng draft #{did}",
                        ro.is_human(cur.get("reviewer")))
    if why:
        return False, why
    try:
        with conn.transaction():
            conn.execute("select schedule_draft(%s, %s, %s)",
                         (did, d, by.strip()))
        conn.commit()
    except psycopg.Error as e:
        return False, f"draft #{did}: {_db_msg(e)}"
    return True, None


def verify_publish(conn, draft_id, text: str) -> bool:
    """Bản sắp đăng có đúng bản đã duyệt? → True chỉ khi quyết định mới
    nhất của draft là approved VÀ sha256(text) khớp. Lỗi DB/id xấu →
    False (fail-closed)."""
    try:
        did = int(draft_id)
        row = conn.execute("select verify_publish(%s, %s, %s)",
                           (OBJECT_TYPE, str(did), text)).fetchone()
    except (TypeError, ValueError, psycopg.Error):
        return False
    return bool(row and row[0] is True)


def verify_log(conn) -> tuple[int, list[tuple]]:
    """Kiểm hash chain `agent_action_log` → (số dòng, [(id, problem)]).
    List rỗng = nguyên vẹn (trừ xóa dòng CUỐI — cần neo ngoài)."""
    n = conn.execute("select count(*) from agent_action_log").fetchone()[0]
    probs = [tuple(r) for r in conn.execute(
        "select id, problem from verify_action_log()").fetchall()]
    return n, probs


def calendar(conn, days: int = DEFAULT_DAYS,
             today: date | None = None) -> dict:
    """Lịch đăng `days` ngày tới → {"today", "days", "scheduled",
    "unscheduled"}: `scheduled` = approved có scheduled_date trong
    [today, today+days] theo ngày tăng; `unscheduled` = approved chưa
    có ngày (mới nhất trước)."""
    today = today or datetime.now(timezone.utc).date()
    horizon = today + timedelta(days=days)
    scheduled = _rows(conn.execute(
        _SELECT_SQL + " where status = 'approved' "
        "and scheduled_date >= %s and scheduled_date <= %s "
        "order by scheduled_date, id", (today, horizon)))
    unscheduled = _rows(conn.execute(
        _SELECT_SQL + " where status = 'approved' "
        "and scheduled_date is null "
        "order by created_at desc, id desc"))
    return {"today": today, "days": days,
            "scheduled": scheduled, "unscheduled": unscheduled}


def _vline(v: dict) -> str:
    sev = v.get("severity")
    code = v.get("code") or v.get("type") or "?"
    line = (f"[{sev}] " if sev else "") + f"{code} — {v.get('detail') or ''}"
    if v.get("span"):
        line += f' → "{v["span"]}"'
        if isinstance(v.get("start"), int) and isinstance(v.get("end"), int):
            line += f" ({v['start']}–{v['end']})"
    return line


_MD_SPECIAL_RE = re.compile(r"([\\`*_{}\[\]()#+\-.!<>|~$:])")


def md_plain(s) -> str:
    """Escape markdown cho dòng guardrail render trong widget Streamlit:
    span/detail lấy từ text draft hoặc lý do LLM — không để link/ảnh
    tracker (`[x](u)`, `![a](u)`), màu `:red[..]` render (WYSIWYS)."""
    return _MD_SPECIAL_RE.sub(r"\\\1", str(s))


def guardrail_lines(g) -> list[tuple[str, str]]:
    """Formatter thuần cho UI: [(level, text)], level ∈ success|error|
    warning|info. Mỗi violation `[severity] code — detail → "span"
    (start–end)` (snapshot cũ thiếu `code` dùng `type`); warnings ->
    warning; llm_check/required_labels/claim khớp -> info. Non-dict /
    thiếu ok / ok falsy mà không có violation -> error "KHÔNG RÕ" (parity
    `_fmt_guardrail`). Không raise."""
    if not isinstance(g, dict):
        return [("error", "Guardrail: KHÔNG RÕ — snapshot không đọc được")]
    viols = g.get("violations")
    viols = ([v for v in viols if isinstance(v, dict)]
             if isinstance(viols, list) else [])
    out = []
    if g.get("ok") is True and not viols:
        out.append(("success", "Guardrail: PASS — không vi phạm"))
    elif not viols:
        out.append(("error", ("Guardrail: KHÔNG RÕ — ok != true, không "
                              "có chi tiết vi phạm")))
    out += [("error", _vline(v)) for v in viols]
    warns = g.get("warnings")
    out += [("warning", _vline(w)) for w in
            (warns if isinstance(warns, list) else []) if isinstance(w, dict)]
    if g.get("llm_check"):
        out.append(("info", f"Lớp LLM-check: {g['llm_check']}"
                    + (f" ({g['llm_model']})" if g.get("llm_model") else "")))
    labels = g.get("required_labels")
    if isinstance(labels, list) and labels:
        out.append(("info", "Nhãn bắt buộc: " + "; ".join(map(str, labels))))
    mc = g.get("matched_claims")
    if isinstance(mc, list) and mc:
        out.append(("info", "Claim khớp whitelist: " + "; ".join(
            f"{m.get('sku')}: {m.get('claim')}" for m in mc
            if isinstance(m, dict))))
    return out


def _fmt_guardrail(d: dict) -> str:
    g = d.get("guardrail")
    if isinstance(g, dict) and g.get("ok") is True:
        return "PASS"
    if not isinstance(g, dict) or "ok" not in g:
        # Snapshot ngoại lai/thiếu key — không gán 'vi phạm' cho
        # dữ liệu không đủ cấu trúc.
        return "KHÔNG RÕ"
    n = len(g.get("violations") or [])
    return f"VI PHẠM ({n})" if n else "VI PHẠM"


def _oneline(s: str, n: int = 60) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[:n - 1] + "…"


def _print_draft_line(d: dict) -> None:
    ts = d.get("created_at")
    ts_s = ts.strftime("%m-%d %H:%M") if hasattr(ts, "strftime") else ""
    print(f"  #{d['id']} [{d['channel']}] {_oneline(d['brief'])} "
          f"— guardrail {_fmt_guardrail(d)} {ts_s}")


@contextmanager
def _conn_or_none():
    """Yield (conn, err|None); đóng conn an toàn sau dùng."""
    conn = connect()
    try:
        yield conn, (None if conn is not None
                     else "không kết nối được Postgres (DATABASE_URL "
                          "thiếu hoặc host chết)")
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m pipelines.store",
        description="Hàng duyệt + lịch đăng content drafts — NGƯỜI "
                    "duyệt từng bài, hệ thống KHÔNG tự đăng (C2.4)")
    ap.add_argument("--pending", action="store_true",
                    help="liệt kê draft đang chờ duyệt")
    ap.add_argument("--approve", type=int, metavar="ID",
                    help="duyệt draft (chỉ khi guardrail ok)")
    ap.add_argument("--reject", type=int, metavar="ID",
                    help="từ chối draft")
    ap.add_argument("--by", dest="reviewer",
                    help="người duyệt/xếp lịch — bắt buộc với "
                         "--approve/--reject/--schedule; chế độ thực phải "
                         "thuộc approvers khối + chạy bằng login DB riêng")
    ap.add_argument("--note", default=None, help="ghi chú duyệt")
    ap.add_argument("--schedule", nargs=2,
                    metavar=("ID", "YYYY-MM-DD"),
                    help="xếp lịch đăng cho draft approved")
    ap.add_argument("--calendar", action="store_true",
                    help="xem lịch đăng sắp tới")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help=f"số ngày lịch (mặc định {DEFAULT_DAYS})")
    ap.add_argument("--verify-log", action="store_true",
                    help="kiểm hash chain agent_action_log (exit 1 nếu "
                         "phát hiện sửa/xóa)")
    args = ap.parse_args(argv)

    n_ops = (sum(w is not None
                 for w in (args.approve, args.reject, args.schedule))
             + args.pending + args.calendar + args.verify_log)
    if n_ops == 0:
        ap.error("cần 1 thao tác: --pending | --calendar | "
                 "--approve | --reject | --schedule | --verify-log")
    if n_ops > 1:
        ap.error("chỉ 1 thao tác mỗi lần — tách lệnh")
    if (args.approve is not None or args.reject is not None) \
            and not (args.reviewer or "").strip():
        ap.error("--approve/--reject cần --by <tên người duyệt>")
    if args.schedule is not None and not (args.reviewer or "").strip():
        ap.error("--schedule cần --by <tên người xếp lịch>")

    if (args.reviewer or "").strip():
        from pipelines import auth
        if not auth.approval_enforced():
            print(f"[warn] {auth.DEV_WARNING}", file=sys.stderr)
    with _conn_or_none() as (conn, err):
        # ---- ĐỌC: DB down → "chưa nạp" exit 0 (precedent report) ----
        if args.pending:
            if conn is None:
                print(f"[warn] chưa nạp — {err}")
                return 0
            rows = list_drafts(conn, status="pending")
            if not rows:
                print("[pending] hàng chờ trống — sinh draft ở Studio "
                      "rồi 'Lưu vào hàng duyệt'")
            else:
                print(f"[pending] {len(rows)} draft chờ duyệt:")
                for d in rows:
                    _print_draft_line(d)
            return 0
        if args.calendar:
            if conn is None:
                print(f"[warn] chưa nạp — {err}")
                return 0
            cal = calendar(conn, days=args.days)
            horizon = cal["today"] + timedelta(days=cal["days"])
            print(f"[calendar] {cal['today']:%Y-%m-%d} → "
                  f"{horizon:%Y-%m-%d}:")
            if not cal["scheduled"]:
                print("  (trống — chưa có bài nào trong lịch)")
            for d in cal["scheduled"]:
                print(f"  {d['scheduled_date']}  #{d['id']} "
                      f"[{d['channel']}] {_oneline(d['brief'])}")
            if cal["unscheduled"]:
                print(f"[unscheduled] {len(cal['unscheduled'])} draft "
                      f"đã duyệt chưa xếp lịch:")
                for d in cal["unscheduled"]:
                    _print_draft_line(d)
            return 0

        if args.verify_log:
            # Kiểm toàn vẹn: DB down → exit 2 (không kết luận được).
            if conn is None:
                print(f"[error] {err} — không kiểm được", file=sys.stderr)
                return 2
            try:
                n, probs = verify_log(conn)
            except psycopg.Error as e:
                print(f"[error] lỗi DB khi kiểm log: {_db_msg(e)}",
                      file=sys.stderr)
                return 2
            if not probs:
                print(f"[ok] chuỗi nguyên vẹn ({n} dòng)")
                return 0
            print(f"[FAIL] hash chain agent_action_log hỏng — "
                  f"{len(probs)} vấn đề / {n} dòng:")
            for lid, prob in probs:
                print(f"  id={lid} problem={prob}")
            return 1

        # ---- GHI: DB down → exit 2 (precedent garden) ----
        if conn is None:
            print(f"[error] {err} — không ghi được", file=sys.stderr)
            return 2
        if args.approve is not None or args.reject is not None:
            did = (args.approve if args.approve is not None
                   else args.reject)
            st = ("approved" if args.approve is not None
                  else "rejected")
            ok, warn = set_status(conn, did, st, args.reviewer,
                                  args.note)
            if not ok:
                print(f"[warn] {warn}", file=sys.stderr)
                return 2
            print(f"[done] draft #{did} → {st} "
                  f"(người duyệt: {args.reviewer.strip()})")
            return 0
        # --schedule ID YYYY-MM-DD
        did, day_s = args.schedule
        ok, warn = schedule(conn, did, day_s, args.reviewer)
        if not ok:
            print(f"[warn] {warn}", file=sys.stderr)
            return 2
        print(f"[done] draft #{did} xếp lịch {day_s} (người xếp: "
              f"{args.reviewer.strip()}) — người đăng tay (hệ thống "
              f"không tự đăng)")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
