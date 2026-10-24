"""Đợt an toàn S04 (HĐ 6.7, 7.2) — danh tính quyết định gắn LOGIN đã xác thực.

Lỗi trước sửa (nền 16b33fc): `person_login()` miễn kiểm cho `svc_ui` → login UI
DÙNG CHUNG gọi thẳng `decide_item`/`approve_draft`/`schedule_draft` (hoặc
INSERT log quyết định) mang tên BẤT KỲ người nào; DB không kiểm khối khi duyệt
draft nội dung (gọi thẳng function: người khối sales duyệt draft marketing).

Sau sửa: svc_ui không còn được tin tên; draft có cột `block` (code tính lúc
tạo); UI chế độ thực mở phiên bằng login Postgres riêng (`auth.person_connect`).

Login Postgres THẬT tạm (không owner/superuser) trên schema tạm ĐÃ COMMIT, dọn
cuối module. Người/khối là dữ liệu GIẢ. Skip khi không có DATABASE_URL."""

import os
import secrets
import uuid

import psycopg
import pytest
from psycopg import conninfo

from tests.test_docx_p0c_person_login import ROLES_SQL, SCHEMA_SQL

P_SALES, P_MKT = "Bán Hàng Giả S04", "Marketing Giả S04"
P_MKT2 = "Marketing Hai Giả S04"


@pytest.fixture(scope="module")
def live():
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_s04_{tag}"
    kinds = {"sales": "app_human", "mkt": "app_human", "mkt2": "app_human",
             "mkt_b": "app_human", "unmapped": "app_human",
             "ui": "svc_ui", "agent": "agent_writer", "job": "svc_job"}
    logins = {k: (f"t_s04_{k}_{tag}", secrets.token_urlsafe(18))
              for k in kinds}
    try:
        admin.execute("set lock_timeout = '60s'")
        admin.execute(f"create schema {schema}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}, pg_temp")
            admin.execute(SCHEMA_SQL)
            admin.execute(ROLES_SQL)
        for k, (n, pw) in logins.items():
            admin.execute(f"create role {n} login password '{pw}' nosuperuser"
                          f" nocreatedb nocreaterole in role {kinds[k]}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}")
            admin.execute(
                "insert into human_logins (db_login, person, blocks,"
                " granted_by) values (%s, %s, '{sales}', 'test-s04'),"
                " (%s, %s, '{marketing}', 'test-s04'),"
                " (%s, %s, '{marketing}', 'test-s04')",
                (logins["sales"][0], P_SALES, logins["mkt"][0], P_MKT,
                 logins["mkt2"][0], P_MKT2))
            # vòng r8: login THỨ HAI của cùng người P_MKT
            admin.execute(
                "insert into human_logins (db_login, person, blocks,"
                " granted_by) values (%s, %s, '{marketing,finance}',"
                " 'test-s04')", (logins["mkt_b"][0], P_MKT))
        d = conninfo.conninfo_to_dict(base)
        d["options"] = f"-c search_path={schema}"
        yield {"admin": admin, "schema": schema, "logins": logins,
               "base": conninfo.make_conninfo(**d)}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        for n, _ in logins.values():
            admin.execute(f"drop role if exists {n}")
        admin.close()


def _q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        cur = a.execute(sql, args)
        return cur.fetchall() if cur.description else []


def _dsn(live, who):
    d = conninfo.conninfo_to_dict(live["base"])
    d.update(user=live["logins"][who][0], password=live["logins"][who][1])
    return conninfo.make_conninfo(**d)


def _as(live, who, sql, args=()):
    with psycopg.connect(_dsn(live, who), connect_timeout=5) as c:
        cur = c.execute(sql, args)
        rows = cur.fetchall() if cur.description else []
        c.commit()
        return rows


def _denied(live, who, sql, args=()):
    with pytest.raises(psycopg.Error) as ei:
        _as(live, who, sql, args)
    assert ei.value.sqlstate in ("42501", "P0001"), ei.value
    return str(ei.value)


def _item(live, block, created_by="agent:s04"):
    return _q(live, "insert into approval_queue (object_type, object_id,"
              " block, title, payload, content_sha256, risk, guardrail,"
              " created_by, due_at) values ('price_review', %s, %s, 'mục s04',"
              " 'p', %s, 'low', '{\"ok\": true}', %s, now() + interval"
              " '1 day') returning id",
              (uuid.uuid4().hex[:8], block, "a" * 64, created_by))[0][0]


def _draft(live, *, content_type="post", created_by="agent:mkt02"):
    """Draft qua `store.save_draft` THẬT (ghi cột block theo danh mục)."""
    from pipelines import content, rollout, store
    from tests.test_contract_c04_listing_export import RD, SKU
    with psycopg.connect(live["base"], connect_timeout=5) as c:
        old = rollout._FORCE_MODE
        rollout._FORCE_MODE = "van_hanh"
        try:
            if content_type == "listing":
                r = content.listing(SKU, "web", readiness=RD, llm=False)
                assert r["ok"], r["guardrail"]
                return store.save_draft(
                    c, f"listing {SKU} web", "web", r["text"],
                    r["guardrail"], store.SOURCE_CLI, created_by=created_by,
                    content_type="listing", sku=SKU)
            return store.save_draft(
                c, "brief s04", "facebook", "Nội dung thử S04 an toàn.",
                {"ok": True}, created_by=created_by)
        finally:
            rollout._FORCE_MODE = old


def _counts(live):
    return _q(live, "select (select count(*) from approvals), (select count(*)"
              " from agent_action_log where action <> 'authz_denied')")[0]


def test_shared_ui_login_cannot_decide_under_any_name(live):
    qid = _item(live, "sales")
    did = _draft(live)
    before = _counts(live)
    for name in ("Người UI Tự Khai", P_SALES):
        assert "ánh xạ" in _denied(live, "ui", "select decide_item(%s, %s,"
                                    " 'approved')", (qid, name))
    _q(live, "update content_drafts set guardrail = '{\"ok\": true}' where"
       " id = %s", (did,))         # chỉ thử cổng danh tính
    assert "ánh xạ" in _denied(live, "ui", "select approve_draft(%s, %s,"
                                " null)", (did, P_MKT))
    _denied(live, "ui", "insert into agent_action_log (actor, action,"
            " object_type, object_id, detail) values (%s, 'queue_approve',"
            " 'approval_queue', %s, jsonb_build_object('queue_id', %s))",
            (P_SALES, str(qid), qid))
    assert _counts(live) == before                       # không ghi dở
    assert _q(live, "select status from approval_queue where id = %s",
              (qid,))[0][0] == "pending"


def test_draft_block_enforced_in_db(live):
    post = _draft(live)                                   # marketing
    listing = _draft(live, content_type="listing")        # sales (danh mục)
    assert _q(live, "select id, block from content_drafts where id in"
              " (%s, %s) order by id", (post, listing)) == [
        (post, "marketing"), (listing, "sales")]
    # schema tạm chưa có golden/readiness → snapshot guardrail lúc lưu không
    # đạt; owner đặt ok để thử cổng KHỐI (không phải cổng guardrail).
    _q(live, "update content_drafts set guardrail = '{\"ok\": true}' where"
       " id in (%s, %s)", (post, listing))
    _denied(live, "sales", "select approve_draft(%s, %s, null)",
            (post, P_SALES))
    _denied(live, "mkt", "select approve_draft(%s, %s, null)",
            (listing, P_MKT))
    _as(live, "mkt", "select approve_draft(%s, %s, null)", (post, P_MKT))
    _as(live, "sales", "select approve_draft(%s, %s, null)",
        (listing, P_SALES))
    _as(live, "mkt", "select schedule_draft(%s, current_date + 1, %s)",
        (post, P_MKT))
    _denied(live, "ui", "select schedule_draft(%s, current_date + 2, %s)",
            (post, P_MKT))
    # Người tạo tự rút bài: không kiểm khối (draft marketing do người sales tạo)
    own = _draft(live, created_by=P_SALES)
    _as(live, "sales", "select reject_draft(%s, %s, 'rút')", (own, P_SALES))
    # Bản cũ không có block → 'marketing' (mặc định Python)
    legacy = _q(live, "insert into content_drafts (brief, channel, text,"
                " guardrail, source, created_by) values ('b', 'facebook',"
                " 'cũ', '{\"ok\": true}', 'cli', 'agent:mkt02')"
                " returning id")[0][0]
    _denied(live, "sales", "select approve_draft(%s, %s, null)",
            (legacy, P_SALES))
    _as(live, "mkt", "select approve_draft(%s, %s, null)", (legacy, P_MKT))


def test_person_queue_decisions_bound(live):
    qid = _item(live, "sales")
    _denied(live, "sales", "select decide_item(%s, %s, 'approved')",
            (qid, P_MKT))                                 # tên người khác
    _denied(live, "unmapped", "select decide_item(%s, %s, 'approved')",
            (qid, P_SALES))
    for who in ("agent", "job"):
        _denied(live, who, "select decide_item(%s, %s, 'approved')",
                (qid, P_SALES))
    _denied(live, "mkt", "select decide_item(%s, %s, 'approved')",
            (qid, P_MKT))                                 # sai khối
    mine = _item(live, "sales", created_by=P_SALES)
    _denied(live, "sales", "select decide_item(%s, %s, 'approved')",
            (mine, P_SALES))                              # tự duyệt
    _as(live, "sales", "select decide_item(%s, %s, 'approved')",
        (qid, P_SALES))
    assert _q(live, "select status, decided_by from approval_queue where"
              " id = %s", (qid,))[0] == ("approved", P_SALES)


def test_person_connect_only_mapped_person_login(live):
    from pipelines import auth
    lg = live["logins"]
    c, person, blocks = auth.person_connect(live["base"], *lg["mkt"])
    try:
        assert (person, blocks) == (P_MKT, ["marketing"])
        assert auth.session_login(c) == lg["mkt"][0]
    finally:
        c.close()
    for who in ("ui", "unmapped", "agent"):
        with pytest.raises(auth.PersonSessionError):
            auth.person_connect(live["base"], *lg[who])
    with pytest.raises(auth.PersonSessionError) as ei:
        auth.person_connect(live["base"], lg["mkt"][0], "sai-" + lg["mkt"][1])
    assert lg["mkt"][1] not in str(ei.value)              # không lộ mật khẩu
    with pytest.raises(auth.PersonSessionError):
        auth.person_connect(live["base"], "x; drop role y", "p")


def test_service_logins_not_widened(live):
    rows = _q(live, "select rolname, rolsuper or rolcreaterole or rolcreatedb"
              " or rolbypassrls from pg_roles where rolname = any(%s)",
              ([n for n, _ in live["logins"].values()],))
    assert rows and not any(flag for _n, flag in rows)
    ui = live["logins"]["ui"][0]
    assert _q(live, "select has_table_privilege(%s, 'human_logins', 'INSERT'),"
              " has_table_privilege(%s, 'content_drafts', 'UPDATE')",
              (ui, ui))[0] == (False, False)


# ---- đợt an toàn S04b: tác giả thật theo login, không tự duyệt qua nhãn agent

INS_D = ("insert into content_drafts (brief, channel, text, guardrail, source,"
         " created_by, content_type, is_ai, block) values ('s04b', 'facebook',"
         " 'Noi dung thu an toan.', '{\"ok\":true}', 'cli', %s, 'post', false,"
         " %s) returning id")


@pytest.mark.parametrize("label", ["agent:controller", "system:auto",
                                   "auto_policy:x", "AGENT :x", "agent：x"])
@pytest.mark.parametrize("who,block", [("mkt", "marketing"), ("sales", "sales")])
def test_person_cannot_create_draft_as_agent(live, who, block, label):
    before = _counts(live)
    _denied(live, who, INS_D, (label, block))
    assert _counts(live) == before


def test_person_draft_block_and_self_approval(live):
    _denied(live, "sales", INS_D, (P_SALES, "sales"))     # tự khai khối
    did = _as(live, "mkt", INS_D, (P_MKT, "marketing"))[0][0]
    assert _q(live, "select created_by, created_login, block from"
              " content_drafts where id = %s", (did,))[0] == (
        P_MKT, live["logins"]["mkt"][0], "marketing")
    for name in (P_MKT, "  marketing   giả s04 "):          # cả biến thể tên
        _denied(live, "mkt", "select approve_draft(%s, %s, null)", (did, name))
    _denied(live, "sales", "select approve_draft(%s, %s, null)",
            (did, P_SALES))                                  # sai khối
    _as(live, "mkt2", "select approve_draft(%s, %s, null)", (did, P_MKT2))
    assert _q(live, "select status, reviewer from content_drafts where id"
              " = %s", (did,))[0] == ("approved", P_MKT2)


def test_service_draft_approved_by_person(live):
    for svc in ("agent", "job"):
        did = _as(live, svc, INS_D, ("agent:mkt02", "marketing"))[0][0]
        _as(live, "mkt", "select approve_draft(%s, %s, null)", (did, P_MKT))


ENQ = ("select enqueue_item('price_review', %s, %s, 'mục', 'p', 'low',"
       " '{\"ok\": true}'::jsonb, 'none', %s, 24)")


def test_queue_agent_label_from_person_cannot_self_decide(live):
    qid = _as(live, "sales", ENQ, (uuid.uuid4().hex[:8], "sales",
                                   "agent:controller"))[0][0]
    assert _q(live, "select created_login from approval_queue where id = %s",
              (qid,))[0][0] == live["logins"]["sales"][0]
    _denied(live, "sales", "select decide_item(%s, %s, 'approved')",
            (qid, P_SALES))
    _denied(live, "ui", ENQ, (uuid.uuid4().hex[:8], "sales", "agent:x"))
    qid = _as(live, "job", ENQ, (uuid.uuid4().hex[:8], "sales",
                                 "agent:kd_price"))[0][0]
    _as(live, "sales", "select decide_item(%s, %s, 'approved')",
        (qid, P_SALES))


# ---- vòng r8: CÙNG NGƯỜI qua login thứ hai không tự duyệt/quyết/override


def test_same_person_second_login_cannot_self_decide(live):
    before = _counts(live)
    q1 = _as(live, "mkt", ENQ, (uuid.uuid4().hex[:8], "marketing",
                                "agent:controller"))[0][0]
    _denied(live, "mkt_b", "select decide_item(%s, %s, 'approved')",
            (q1, P_MKT))
    _denied(live, "mkt_b", "select override_qa(%s, %s, 'lý do kiểm thử đủ"
            " dài')", (q1, P_MKT))
    assert _counts(live)[0] == before[0]                     # không approvals
    _as(live, "mkt2", "select decide_item(%s, %s, 'approved')", (q1, P_MKT2))


def test_person_cogs_bound_to_login_person(live):
    _q(live, "insert into sku_master (sku_key, name, category, source) values"
       " ('s04-cogs', 'SKU', 'food', 'manual') on conflict do nothing")
    ins = ("insert into cogs_versions (sku_key, cost_vnd, valid_from,"
           " created_by) values ('s04-cogs', 1000, current_date, %s)"
           " returning id")
    _denied(live, "mkt", ins, ("agent:controller",))         # nhãn agent
    cid = _as(live, "mkt", ins, (P_MKT,))[0][0]
    _denied(live, "mkt_b", "select approve_cogs(%s, %s, null)", (cid, P_MKT))
