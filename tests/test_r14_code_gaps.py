"""r14 — phần code còn thiếu bám DOCX: C1 OCR chạy ở tiến trình con (crash/treo/kết quả hỏng không giết tiến trình gọi),
C2 `anchor --upgrade` cho NGƯỜI được ủy quyền ở giai đoạn có người duyệt (function `anchor_upgrade_human`, 1 `da_nang_cap`/
lần gom), C3a refresh token Shopee/TikTok (kho token ngoài repo, xoay vòng, không in token). Login Postgres thật + PaddleOCR
thật ở probe evidence/itacc_r14_code_gaps (P1/P2); ở đây không mạng, DB = schema tạm `da_db`/fixture neo (ROLLBACK)."""
import hashlib
import json
import sys
import time

import pytest
from PIL import Image

from ingest import doc_intake as di
from ingest import market_api as ma
from pipelines import anchor as an
from pipelines import rollout
from tests.test_market_api import _Server
from tests.test_r13_batch_b import RESP, bitcoin
from tests.test_v13_c09_anchor_legal import (  # noqa: F401 — fixture DB thử
    OTS_CFG,
    _fake_post,
    _issued,
    _now,
    db,
    proxy,
    run,
)

# --- C1: OCR ở tiến trình con --------------------------------------------------

@pytest.fixture
def ocr_ready(tmp_path, monkeypatch):
    for parts in di._PADDLE_SUBDIRS.values():
        d = tmp_path.joinpath("m", *parts)
        d.mkdir(parents=True)
        for f in di._PADDLE_FILES:
            (d / f).write_bytes(b"x")
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path / "m"))
    p = tmp_path / "a.png"
    Image.new("RGB", (20, 20), "white").save(p)
    return p


def _worker(monkeypatch, code):
    monkeypatch.setattr(di, "OCR_WORKER", [sys.executable, "-c", code])


@pytest.mark.parametrize("code,msg", [
    ("import os; os.abort()", "thoát bất thường"),                       # crash native/abort
    ("import sys; sys.exit(7)", r"thoát bất thường \(mã 7\)"),
    ("print('rác không phải kết quả')", "kết quả hỏng"),
    ("print('OCR_RESULT {not json')", "kết quả hỏng"),
    ("print('OCR_RESULT {\"ok\": true, \"text\": 5}')", "kết quả hỏng"),
    ("print('OCR_RESULT {\"ok\": false, \"error\": \"ảnh hỏng/không đọc được\"}')", "ảnh hỏng")])
def test_ocr_worker_failures_are_controlled(ocr_ready, monkeypatch, code, msg):
    _worker(monkeypatch, code)
    with pytest.raises(di.DocError, match=msg):
        di._ocr_paddle_local(ocr_ready)


def test_ocr_worker_result_and_request(ocr_ready, monkeypatch, tmp_path):
    seen = tmp_path / "req.json"
    _worker(monkeypatch, "import sys,json,pathlib; r=sys.stdin.read(); pathlib.Path(sys.argv[1]).write_text(r);"
                         " print('log engine'); print('OCR_RESULT ' + json.dumps({'ok': True, 'text': 'LOT L1'}))")
    monkeypatch.setattr(di, "OCR_WORKER", di.OCR_WORKER + [str(seen)])
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:1/khong_dung")
    assert di._ocr_paddle_local(ocr_ready) == "LOT L1"
    req = json.loads(seen.read_text())
    assert req["max_pages"] == di.OCR_MAX_PAGES and req["path"].endswith("a.png")


def test_ocr_worker_env_has_no_db_credentials(ocr_ready, monkeypatch):
    # guard pytest đặt biến DSN = "" (chặn dotenv) — chỉ cấm giá trị THẬT lọt sang con
    _worker(monkeypatch, "import os,json; bad=[k for k, v in os.environ.items() if v and (k.endswith('DATABASE_URL')"
                         " or k.startswith('PG'))]; print('OCR_RESULT ' + json.dumps({'ok': True, 'text': ','.join(bad)}))")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@127.0.0.1:1/khong_dung")
    monkeypatch.setenv("PGPASSWORD", "khong-dung")
    assert di._ocr_paddle_local(ocr_ready) == ""


def test_ocr_missing_models_refused_before_spawn(tmp_path, monkeypatch):
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(tmp_path))
    _worker(monkeypatch, "raise SystemExit('không được sinh tiến trình')")
    monkeypatch.setattr(di.subprocess, "run", lambda *a, **k: pytest.fail("không được sinh tiến trình OCR"))
    with pytest.raises(di.DocError, match="thiếu model"):
        di._ocr_paddle_local(tmp_path / "x.png")


def test_ocr_timeout_kills_worker_no_late_result(ocr_ready, monkeypatch, tmp_path):
    late = tmp_path / "late"
    _worker(monkeypatch, f"import time,pathlib; time.sleep(4); pathlib.Path(r'{late}').write_text('muon')")
    monkeypatch.setattr(di, "OCR_TIMEOUT_S", 1)
    with pytest.raises(di.DocError, match="quá 1 giây"):
        di._ocr_paddle_local(ocr_ready)
    time.sleep(5)
    assert not late.exists()


# --- C2: nâng cấp neo cho người ------------------------------------------------

def _submitted(db, proxy, run):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    an.submit(proxy, bid, OTS_CFG, post=_fake_post([], resp=RESP))
    return bid


def _new_receipt(db, bid):  # noqa: F811
    rec = bytes(db.execute("select receipt from anchor_receipts where batch_id = %s and status = 'da_gui'",
                           (bid,)).fetchone()[0])
    return rec + b"\x00"   # đúng tiền tố digest (cây OTS kiểm ở ứng dụng, không ở DB)


def test_upgrade_human_function_append_once_and_logged(db, proxy, run):  # noqa: F811
    bid = _submitted(db, proxy, run)
    cal = db.execute("select calendar from anchor_receipts where batch_id = %s", (bid,)).fetchone()[0]
    q = "select receipt_id, created from anchor_upgrade_human(%s, %s, %s, %s)"
    rid, made = db.execute(q, (bid, cal, _new_receipt(db, bid), "Người Duyệt Neo")).fetchone()
    again, made2 = db.execute(q, (bid, cal, _new_receipt(db, bid), "Người Duyệt Neo")).fetchone()
    assert again == rid and made is True and made2 is False
    rows = db.execute("select status, created_by from anchor_receipts where batch_id = %s order by id",
                      (bid,)).fetchall()
    assert [tuple(r) for r in rows][-1] == ("da_nang_cap", "Người Duyệt Neo") and len(rows) == 2
    assert db.execute("select count(*) from agent_action_log where action = 'anchor_upgrade' and object_id = %s",
                      (str(bid),)).fetchone()[0] == 1


@pytest.mark.parametrize("bad", ["digest", "calendar", "agent"])
def test_upgrade_human_function_rejects(db, proxy, run, bad):  # noqa: F811
    bid = _submitted(db, proxy, run)
    rec, by = _new_receipt(db, bid), "Người Duyệt Neo"
    cal = db.execute("select calendar from anchor_receipts where batch_id = %s", (bid,)).fetchone()[0]
    if bad == "digest":
        rec = an.OTS_HEAD + b"\x11" * 32 + b"\x00"
    elif bad == "calendar":
        cal = "https://cal-la.test" if cal != "https://cal-la.test" else "https://cal-x.test"
    else:
        by = "agent:anchor"
    import psycopg
    db.execute("savepoint s")
    with pytest.raises(psycopg.Error):
        db.execute("select * from anchor_upgrade_human(%s, %s, %s, %s)", (bid, cal, rec, by))
    db.execute("rollback to savepoint s")
    assert db.execute("select count(*) from anchor_receipts where batch_id = %s and status = 'da_nang_cap'",
                      (bid,)).fetchone()[0] == 0


def test_upgrade_function_grants_minimal(db):  # noqa: F811
    q = db.execute("select has_function_privilege('app_human', 'anchor_upgrade_human(bigint, text, bytea, text)',"
                   " 'execute'), has_table_privilege('app_human', 'anchor_receipts', 'insert'),"
                   " exists (select 1 from information_schema.routine_privileges where routine_name ="
                   " 'anchor_upgrade_human' and grantee = 'PUBLIC'), (select prosecdef and proconfig is not null"
                   " from pg_proc where proname = 'anchor_upgrade_human' and pronamespace ="
                   " current_schema()::regnamespace)").fetchone()
    assert q == (True, False, False, True)


def test_upgrade_human_path_in_review_stage(db, proxy, run, monkeypatch):  # noqa: F811
    bid = _submitted(db, proxy, run)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "co_nguoi_duyet")
    with pytest.raises(an.AnchorError, match="người duyệt"):          # job agent vẫn chặn
        an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("không được hỏi calendar"))
    r = an.upgrade(proxy, bid, OTS_CFG, get=lambda url, t: b"\x08" + bitcoin(850003), by="Người Duyệt Neo")
    assert r["status"] == "da_nang_cap" and r["heights"] == [850003]
    assert db.execute("select created_by from anchor_receipts where batch_id = %s and status = 'da_nang_cap'",
                      (bid,)).fetchone()[0] == "Người Duyệt Neo"
    assert an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("đã nâng cấp"),
                      by="Người Duyệt Neo")["new"] is False


def test_upgrade_job_insert_no_duplicate(db, proxy, run):  # noqa: F811
    # r14-fix2 F2: trigger chặn mọi INSERT da_nang_cap thứ 2 (kể cả owner ghi thẳng) — 23505
    import psycopg
    bid = _submitted(db, proxy, run)
    r = an.upgrade(proxy, bid, OTS_CFG, get=lambda url, t: b"\x08" + bitcoin(850004))
    assert r["new"] is True
    db.execute("savepoint s")
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)"
                   " select batch_id, provider, status, calendar, receipt, 'agent:anchor' from anchor_receipts"
                   " where batch_id = %s and status = 'da_nang_cap'", (bid,))
    db.execute("rollback to savepoint s")
    assert db.execute("select count(*) from anchor_receipts where batch_id = %s and status = 'da_nang_cap'",
                      (bid,)).fetchone()[0] == 1


def test_upgrade_legacy_duplicates_kept_and_reported(db, proxy, run):  # noqa: F811
    # lịch sử trước r14 có 2 da_nang_cap hợp lệ (FIXTURE dựng khi tắt trigger): giữ nguyên, chạy lại không HTTP/ghi
    bid = _submitted(db, proxy, run)
    an.upgrade(proxy, bid, OTS_CFG, get=lambda url, t: b"\x08" + bitcoin(850005))
    db.execute("alter table anchor_receipts disable trigger anchor_receipts_upgrade_once")
    db.execute("insert into anchor_receipts (batch_id, provider, status, calendar, receipt, created_by)"
               " select batch_id, provider, status, calendar, receipt, 'agent:anchor' from anchor_receipts"
               " where batch_id = %s and status = 'da_nang_cap'", (bid,))
    db.execute("alter table anchor_receipts enable trigger anchor_receipts_upgrade_once")
    r = an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("đã nâng cấp — không hỏi calendar"))
    assert r == {"id": bid, "status": "da_nang_cap", "new": False, "so_dong_nang_cap": 2}
    assert db.execute("select count(*) from anchor_receipts where batch_id = %s and status = 'da_nang_cap'",
                      (bid,)).fetchone()[0] == 2


@pytest.mark.parametrize("field,leak", [("error", "R1_SECRET_OLD_TOKEN"), ("error", "SPKEY_SECRET_R14"),
                                        ("error", {"t": "R1_SECRET_OLD_TOKEN"}), ("code", ["TTSEC_R14"]),
                                        ("code", "R1_SECRET_OLD_TOKEN")])
def test_refresh_error_field_never_reflected(field, leak):
    # r14-fix2 F1: trường lỗi phản chiếu credential → chỉ mã đúng dạng được in
    ch = "shopee" if field == "error" else "tiktok"
    creds = ({"SHOPEE_PARTNER_ID": PID, "SHOPEE_PARTNER_KEY": PKEY, "SHOPEE_SHOP_ID": SHOP} if ch == "shopee"
             else {"TIKTOK_APP_KEY": "ak01", "TIKTOK_APP_SECRET": "TTSEC_R14"})
    srv = _Server(lambda *a: (200, {field: leak, "message": "x"}, None))
    try:
        with pytest.raises(ma.ApiError) as ei:
            ma.refresh_token(ch, creds, R1, srv.url)
    finally:
        srv.close()
    text = f"{ei.value!s} {ei.value!r}"
    assert not any(x in text for x in (R1, PKEY, "TTSEC_R14")) and "đã ẩn" in text


@pytest.mark.parametrize("code,shown", [("error_auth", "error_auth"), (36004004, "36004004"), (True, "đã ẩn"),
                                        ("Error Auth", "đã ẩn"), ("error_" + "x" * 50, "đã ẩn")])
def test_err_code_shapes(code, shown):
    assert shown in ma._err_code(code, {"K": "SPKEY_SECRET_R14"})
    assert "đã ẩn" in ma._err_code("error_spkey_secret_r14", {"K": "spkey_secret_r14"})


# --- C3a: refresh token sàn ----------------------------------------------------

PID, PKEY, SHOP = "1000001", "SPKEY_SECRET_R14", "2000002"
R1, R2, A2 = "R1_SECRET_OLD_TOKEN", "R2_SECRET_NEW_TOKEN", "A2_SECRET_ACCESS_TOKEN"


@pytest.fixture
def sp(monkeypatch, tmp_path):
    for k in ("SHOPEE_ACCESS_TOKEN", "SHOPEE_REFRESH_TOKEN", "MARKET_TOKEN_FILE"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SHOPEE_PARTNER_ID", PID)
    monkeypatch.setenv("SHOPEE_PARTNER_KEY", PKEY)
    monkeypatch.setenv("SHOPEE_SHOP_ID", SHOP)
    monkeypatch.setattr(ma, "load_dotenv", lambda *a, **k: None)
    store = tmp_path / "kho.json"
    store.write_text(json.dumps({"shopee": {"access_token": "AOLD_SECRET_X", "refresh_token": R1, "expire_at": 1}}))
    monkeypatch.setenv("MARKET_TOKEN_FILE", str(store))
    return store


def _auth_ok(m, p, q, b):
    return 200, {"error": "", "message": "", "access_token": A2, "refresh_token": R2, "expire_in": 14400}, None


def test_refresh_shopee_rotates_and_signs(sp, monkeypatch, capsys):
    srv = _Server(_auth_ok)
    try:
        monkeypatch.setenv("SHOPEE_API_BASE", srv.url)
        assert ma.main(["--channel", "shopee", "--refresh"]) == 0
    finally:
        srv.close()
    st = json.loads(sp.read_text())["shopee"]
    assert (st["access_token"], st["refresh_token"]) == (A2, R2) and st["expire_at"] > time.time() + 14000
    (rq,) = srv.requests
    ts = rq["query"]["timestamp"][0]
    assert rq["method"] == "POST" and rq["path"] == ma.SP_AUTH_REFRESH and "access_token" not in rq["query"]
    assert rq["query"]["sign"][0] == __import__("hmac").new(
        PKEY.encode(), f"{PID}{ma.SP_AUTH_REFRESH}{ts}".encode(), hashlib.sha256).hexdigest()
    assert json.loads(rq["body"]) == {"refresh_token": R1, "partner_id": int(PID), "shop_id": int(SHOP)}
    out = capsys.readouterr()
    assert not any(s in out.out + out.err for s in (R1, R2, A2, PKEY))


@pytest.mark.parametrize("resp", [
    (200, {"error": "error_auth", "message": "invalid"}, None),
    (200, {"error": "", "access_token": A2, "expire_in": 14400}, None),           # thiếu refresh_token
    (200, {"error": "", "access_token": A2, "refresh_token": R2, "expire_in": 0}, None),
    (500, {"error": "error_server"}, None),
    (302, {}, {"Location": "http://127.0.0.1:1/x"})])
def test_refresh_failure_keeps_store_single_attempt(sp, monkeypatch, resp):
    srv = _Server(lambda *a: resp)
    before = sp.read_bytes()
    try:
        monkeypatch.setenv("SHOPEE_API_BASE", srv.url)
        assert ma.main(["--channel", "shopee", "--kind", "listing"]) == 1
    finally:
        srv.close()
    assert sp.read_bytes() == before and len(srv.requests) == 1


def test_refresh_store_inside_repo_refused(sp, monkeypatch):
    monkeypatch.setenv("MARKET_TOKEN_FILE", str(ma.ROOT / "data" / "kho_token.json"))
    monkeypatch.setattr(ma.urllib.request, "urlopen", lambda *a, **k: pytest.fail("không được gửi request"))
    assert ma.main(["--channel", "shopee", "--refresh"]) == 2


def test_refresh_lock_busy_no_request(sp, monkeypatch):
    from pipelines.job_runs import _file_lock
    monkeypatch.setattr(ma, "refresh_token", lambda *a, **k: pytest.fail("không được refresh khi đang khóa"))
    with _file_lock(sp.with_name(sp.name + ".lock")) as got:
        assert got
        assert ma._do_refresh("shopee", {}, sp, True) is None


def test_refresh_reread_inside_lock_skips_when_fresh(sp, monkeypatch):
    sp.write_text(json.dumps({"shopee": {"access_token": A2, "refresh_token": R2,
                                         "expire_at": int(time.time()) + 7200}}))
    monkeypatch.setattr(ma, "refresh_token", lambda *a, **k: pytest.fail("token còn hạn — không refresh"))
    assert ma._do_refresh("shopee", {}, sp, False) == A2


def test_refresh_tiktok_contract(monkeypatch, tmp_path):
    seen = []

    def route(m, p, q, b):
        seen.append((m, p, {k: v[0] for k, v in q.items()}))
        return 200, {"code": 0, "data": {"access_token": A2, "refresh_token": R2,
                                         "access_token_expire_in": int(time.time()) + 604800}}, None
    srv = _Server(route)
    try:
        r = ma.refresh_token("tiktok", {"TIKTOK_APP_KEY": "ak01", "TIKTOK_APP_SECRET": "TTSEC_R14"}, R1, srv.url)
    finally:
        srv.close()
    assert r["access_token"] == A2 and r["refresh_token"] == R2
    assert seen == [("GET", ma.TT_AUTH_REFRESH, {"app_key": "ak01", "app_secret": "TTSEC_R14", "refresh_token": R1,
                                                 "grant_type": "refresh_token"})]
