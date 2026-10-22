"""v15 fix P8.7b — người được ủy quyền duyệt được đầu ra nguồn BẢNG qua CLI.

Lỗi (sau vá P8.7): login người thật (`in role app_human`, không owner, có
`human_logins` đúng khối) chạy `python -m pipelines.rollout --outputs ID` /
`--review-output ID --key K --sha S --decision approved --by <người>` cho
khóa nguồn BẢNG (vd `audit_runs`) thất bại: bộ đếm Python `output_rows` đọc
thẳng bảng nguồn mà app_human không có SELECT → "nguồn chưa đọc được"; chỉ
gọi SQL `output_review_human` trực tiếp mới duyệt được. Vá: function
SECURITY DEFINER `output_pending_human` liệt kê đầu ra cần duyệt (khóa + sha
phiên bản hiện hành + loại nguồn + đã/chưa duyệt — CÙNG bộ đếm DB
`count_spec`/`rollout_db_outputs`, loại mẫu) cho login người; Python dùng nó
cho liệt kê + kiểm sớm, DB vẫn quyết ở `output_review_human`. KHÔNG cấp
SELECT bảng nguồn cho app_human.

Probe (login Postgres THẬT tạm, không superuser/owner — fixture `live` của
p10; CLI chạy SUBPROCESS chế độ thực): đúng người/khối → `--outputs` exit 0
liệt kê khóa + sha, `--review-output` exit 0 + đúng 1 dòng `output_reviews`
gắn người của login, chạy lại theo thiết kế append-only; sai khối / `--by`
giả / login chưa ánh xạ / agent → chặn, 0 dòng; function liệt kê không lộ
nội dung bảng nguồn, không chạy được bởi svc_loader/agent_writer/bks_reader/
PUBLIC. Người/khối là dữ liệu GIẢ của test."""

import os
from datetime import datetime, timedelta

import psycopg
import pytest
from psycopg import conninfo

from pipelines import rollout as ro
from pipelines.period import VN_TZ
from tests.test_v15_p10_human_authz import (  # noqa: F401 — fixture live
    P_FARM,
    P_SALES,
    _cli,
    _conn,
    _db_raises,
    _q,
    live,
)

SINCE = datetime.now(VN_TZ) - timedelta(days=25)
FID = "ceo-04.6"     # (thay ceo-04.2) nguồn audit_runs inside_out + báo cáo
A_SHA, B_SHA, S_SHA = "a" * 64, "b" * 64, "5" * 64
K_A = f"ar:inside_out/2026-09/{A_SHA}"
K_B = f"ar:inside_out/2026-08/{B_SHA}"
K_S = f"ar:inside_out/2026-07/{S_SHA}"   # dòng MẪU (is_sample)
SECRET = "nội-dung-bảng-nguồn-p87b"      # chuỗi chỉ có trong bảng nguồn
FN = "output_pending_human"
COLS = ("o_key", "o_ts", "o_sha", "o_nguon", "o_quyet_dinh", "o_nguoi_duyet")


def _custom(fid, srcs):
    return {"id": fid, "code_status": "co_code", "output_sources": srcs}


def _owner_dsn(live):  # noqa: F811
    return conninfo.make_conninfo(os.environ["DATABASE_URL"],
                                  options=f"-c search_path={live['schema']}")


@pytest.fixture(scope="module")
def p87b(live):  # noqa: F811
    cat = {f["id"]: f for f in ro.load_features()}
    feats = {FID: cat[FID],
             "ceo-94": _custom("ceo-94", [{"table": "decision_log"}]),
             "ceo-95": _custom("ceo-95", [{"file": "backup_runs.jsonl"},
                                          {"table": "audit_runs",
                                           "kind": "inside_out"}])}
    with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
        ro.seed(c, list(feats.values()), "test-p87b", now=SINCE)
    for per, sha, smp in (("2026-09", A_SHA, False), ("2026-08", B_SHA, False),
                          ("2026-07", S_SHA, True)):
        _q(live, "insert into audit_runs (kind, period_label, findings,"
           " report_sha256, run_by, is_sample) values ('inside_out', %s, 0,"
           " %s, 'agent:bks', %s)", (per, sha, smp))
    _q(live, "insert into decision_log (entry_kind, decided_on, topic,"
       " decision, decided_by, basis_kind, note, recorded_by) values"
       " ('quyet_dinh', current_date, %s, %s, %s, 'van_ban', 'văn bản giả"
       " p87b', %s)", (SECRET, SECRET, P_FARM, P_FARM))
    return {"feats": feats}


def _owner_pending(live, p87b, fid):  # noqa: F811
    """Đầu ra cần duyệt theo bộ đếm Python đường OWNER → {key: sha}."""
    with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
        m, _, _ = ro.output_rows(c, p87b["feats"][fid], SINCE,
                                 datetime.now(VN_TZ))
    return {k: o["sha"] for k, o in m.items() if o["needs_review"]}


def _reviews(live, key):  # noqa: F811
    return _q(live, "select reviewed_by, db_role, content_sha256, decision"
              " from output_reviews where feature_id = %s and output_key = %s"
              " order by id", (FID, key))


def _logs(live, key):  # noqa: F811
    return _q(live, "select count(*) from agent_action_log where action ="
              " 'output_review' and object_id = %s", (f"{FID}:{key}",))[0][0]


def _review(live, who, key, sha, by, decision="approved"):  # noqa: F811
    return _cli(live, who, "pipelines.rollout", "--review-output", FID,
                "--key", key, "--sha", sha, "--decision", decision,
                "--by", by)


def _line(out, key):
    return next((ln for ln in out.splitlines() if ln.startswith(key + "\t")),
                None)


def test_p87b_human_cli_lists_table_outputs(live, p87b):  # noqa: F811
    """Đúng người/khối: `--outputs` exit 0, liệt kê khóa nguồn bảng + sha
    phiên bản hiện hành (= bộ đếm owner), không liệt kê dòng mẫu."""
    want = _owner_pending(live, p87b, FID)
    assert K_A in want and K_B in want and K_S not in want
    rc, out = _cli(live, "farm", "pipelines.rollout", "--outputs", FID)
    assert rc == 0, out
    for k in (K_A, K_B):
        ln = _line(out, k)
        assert ln is not None, out
        assert f"sha={want[k]}" in ln and "CHƯA DUYỆT" in ln, ln
    assert K_S not in out and "nguồn chưa đọc được" not in out, out
    assert f"{FID}: {len(want)} đầu ra cần người duyệt" in out, out
    # vẫn KHÔNG có SELECT bảng nguồn — đường đọc là function DB
    _db_raises(live, "farm", "select * from audit_runs", (),
               "permission denied")


def test_p87b_human_cli_reviews_table_output(live, p87b):  # noqa: F811
    """`--review-output` đúng khóa + sha → exit 0, đúng 1 dòng gắn người của
    login; sha sai → chặn; chạy lại = thêm 1 quyết định (append-only, bản
    mới nhất thắng — thiết kế sổ), cổng DB vẫn 1 đầu ra đã duyệt."""
    sha = _owner_pending(live, p87b, FID)[K_A]
    rc, out = _review(live, "farm", K_A, "e" * 64, P_FARM)
    assert rc == 1 and "sha" in out, out
    assert _reviews(live, K_A) == [] and _logs(live, K_A) == 0
    rc, out = _review(live, "farm", K_A, sha, P_FARM)
    assert rc == 0, out
    assert _reviews(live, K_A) == [(P_FARM, live["name"]["farm"], sha,
                                    "approved")]
    assert _logs(live, K_A) == 1
    rc, out = _cli(live, "farm", "pipelines.rollout", "--outputs", FID)
    assert rc == 0, out
    ln = _line(out, K_A)
    assert ln is not None and "approved bởi" in ln, out
    assert "CHƯA DUYỆT" in _line(out, K_B), out
    rc, out = _review(live, "farm", K_A, sha, P_FARM)       # chạy lại
    assert rc == 0, out
    assert _reviews(live, K_A) == [(P_FARM, live["name"]["farm"], sha,
                                    "approved")] * 2
    assert _q(live, "select f.unrev, f.human from feature_rollout r,"
              " rollout_db_facts(r.feature_id, r.count_spec, r.stage_since,"
              " now()) f where r.feature_id = %s and f.k = %s",
              (FID, K_A)) == [(False, True)]


@pytest.mark.parametrize("who, by, rc_want", [
    ("sales", P_SALES, 1),          # sai khối (người sales, tính năng ceo)
    ("farm", P_SALES, 1),           # --by giả (tên người khác)
    ("unmapped", P_FARM, 1),        # login chưa ánh xạ human_logins
    ("farm", "agent:bks", 2),       # agent không duyệt
], ids=["sai-khoi", "by-gia", "login-chua-anh-xa", "agent"])
def test_p87b_wrong_actor_blocked(live, p87b, who, by, rc_want):  # noqa: F811
    sha = _owner_pending(live, p87b, FID)[K_B]
    rc, out = _review(live, who, K_B, sha, by)
    assert rc == rc_want, out
    assert _reviews(live, K_B) == [] and _logs(live, K_B) == 0


def test_p87b_listing_function_identity(live, p87b):  # noqa: F811
    """Gọi thẳng function liệt kê: người khối khác / --by giả / login chưa
    ánh xạ / agent → 42501; CLI `--outputs` của người khối khác không liệt
    kê gì."""
    sql = f"select * from {FN}(%s, %s)"
    _db_raises(live, "sales", sql, (FID, None), "không được ủy quyền khối")
    _db_raises(live, "farm", sql, (FID, P_SALES), "không phải người của login")
    _db_raises(live, "unmapped", sql, (FID, None), "chưa được ánh xạ")
    _db_raises(live, "farm", sql, (FID, "agent:bks"), "không hợp lệ")
    rc, out = _cli(live, "sales", "pipelines.rollout", "--outputs", FID)
    assert rc == 1 and "ar:" not in out, out


def test_p87b_listing_function_locked_down(live, p87b):  # noqa: F811
    """SECURITY DEFINER + search_path cố định; chỉ app_human EXECUTE;
    kết quả chỉ khóa + sha + loại nguồn + quyết định (không cột nội dung)."""
    rows = _q(live, "select p.prosecdef, p.proconfig,"
              " pg_get_function_result(p.oid),"
              " has_function_privilege('public', p.oid, 'EXECUTE'),"
              " has_function_privilege('svc_loader', p.oid, 'EXECUTE'),"
              " has_function_privilege('agent_writer', p.oid, 'EXECUTE'),"
              " has_function_privilege('bks_reader', p.oid, 'EXECUTE'),"
              " has_function_privilege('app_human', p.oid, 'EXECUTE')"
              " from pg_proc p where p.pronamespace = current_schema()"
              "::regnamespace and p.proname = %s", (FN,))
    assert len(rows) == 1, rows
    secdef, cfg, result, pub, loader, agent, bks, human = rows[0]
    assert secdef and any(c.startswith("search_path=") for c in cfg or ())
    assert not (pub or loader or agent or bks) and human
    assert [c.split()[0] for c in
            result.removeprefix("TABLE(").removesuffix(")").split(", ")
            ] == list(COLS), result
    _db_raises(live, "loader", f"select * from {FN}(%s, null)", (FID,),
               "permission denied")
    # không lộ nội dung bảng nguồn: decision_log (có bước người ghi riêng)
    # không vào danh sách; dòng audit_runs chỉ ra khóa/sha
    with _conn(live, "farm") as c:
        got = c.execute(f"select * from {FN}('ceo-94', null)").fetchall()
        assert got == []
        got = c.execute(f"select * from {FN}(%s, null)", (FID,)).fetchall()
    assert {r[0]: r[2] for r in got} == _owner_pending(live, p87b, FID)
    assert {r[3] for r in got} <= {"bang", "bao_cao"}
    flat = " ".join(map(str, got))
    assert SECRET not in flat and "agent:bks" not in flat, flat


def test_p87b_file_source_rejected_clearly(live, p87b):  # noqa: F811
    """Nguồn FILE vẫn bị từ chối rõ ở đường login người (DB chưa có bản chụp
    tin cậy); nguồn bảng cùng tính năng vẫn duyệt được."""
    feats = list(p87b["feats"].values())
    with _conn(live, "farm") as c:
        with pytest.raises(ro.RolloutError, match="nguồn file"):
            ro.review_output(c, feats, "ceo-95", f"bk:{'4' * 64}", "4" * 64,
                             "approved", P_FARM)
        rows = ro.pending_outputs(c, feats, "ceo-95")
        assert {r["key"] for r in rows} == {K_A, K_B}
        rid = ro.review_output(c, feats, "ceo-95", K_B,
                               next(r["sha"] for r in rows
                                    if r["key"] == K_B), "approved", P_FARM)
    assert _q(live, "select feature_id, output_key, reviewed_by from"
              " output_reviews where id = %s", (rid,)) == [
        ("ceo-95", K_B, P_FARM)]
    assert _q(live, "select count(*) from output_reviews where feature_id ="
              " 'ceo-95' and output_key like 'bk:%%'") == [(0,)]
