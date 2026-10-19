"""v15 fix P8.7 — SQL phải kiểm KHÓA và PHIÊN BẢN đầu ra khi người duyệt.

Lỗi (evidence/v15_resume_p11_authz_probes.log): login người khối ceo KHÔNG
owner gọi thẳng `output_review_human('ceo-01', 'ar:does-not-exist',
'<sha256 hợp khuôn tùy ý>', 'approved', '<người của login>', null)` vẫn ghi
`output_reviews` + `agent_action_log` — function chỉ kiểm đầy đủ với khóa
báo cáo `rp:`; khóa bảng/file và sha nội dung chỉ kiểm ở Python. (Chưa
chứng minh vượt cổng vận hành — dòng rác không khớp đầu ra nào.)

Probe (login Postgres THẬT tạm, không superuser/owner — fixture `live` của
p10; SQL gọi TRỰC TIẾP, không qua Python): khóa không tồn tại; khóa thật
nhưng sai tính năng / sai nguồn; sai sha; phiên bản cũ (bảng + báo cáo);
mẫu; nguồn file (DB không đọc được — chưa có bản chụp tin cậy) bị từ chối
có lý do; thiếu nguồn / sổ chưa có bộ đếm; đầu ra có bước duyệt riêng / sai
tiền tố → TỪ CHỐI, 0 dòng `output_reviews`, 0 log `output_review`. Hợp lệ
(đúng người/khối/phiên bản, cả CLI) → duyệt được, danh tính theo login;
nội dung đổi → duyệt cũ không áp phiên bản mới; cổng PL02 vẫn chặn khi thiếu
người duyệt / có lỗi nghiêm trọng. Người/khối là dữ liệu GIẢ của test."""

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
    _q,
    live,
)

SINCE = datetime.now(VN_TZ) - timedelta(days=25)
A_SHA, V_SHA, S_SHA, R_SHA = "a" * 64, "7" * 64, "b" * 64, "c" * 64
K_A = f"ar:inside_out/2026-09/{A_SHA}"        # đầu ra thật ceo-04.2
K_V = f"ar:inside_out/2026-07/{V_SHA}"        # đầu ra thật — đổi phiên bản
K_S = f"ar:inside_out/2026-08/{S_SHA}"        # dòng MẪU (is_sample)
K_R = f"ar:recon/2026-09/{R_SHA}"             # có thật nhưng nguồn khác (recon)
JUNK = "e" * 64


def _custom(fid, srcs):
    return {"id": fid, "code_status": "co_code", "output_sources": srcs}


def _owner_dsn(live):  # noqa: F811
    return conninfo.make_conninfo(os.environ["DATABASE_URL"],
                                  options=f"-c search_path={live['schema']}")


@pytest.fixture(scope="module")
def p87(live):  # noqa: F811
    cat = {f["id"]: f for f in ro.load_features()}
    feats = {fid: cat[fid] for fid in ("ceo-01", "ceo-03", "ceo-04.2")}
    feats.update({
        "ceo-95": _custom("ceo-95", [{"file": "backup_runs.jsonl"}]),
        "ceo-96": _custom("ceo-96", [{"table": "decision_log"}]),
        "ceo-97": _custom("ceo-97", []),
        "ceo-98": _custom("ceo-98", [{"report": "ceo98-"}]),
    })
    with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
        ro.seed(c, list(feats.values()), "test-p87", now=SINCE)
    _q(live, "update feature_rollout set stage = 'co_nguoi_duyet' where"
       " feature_id in ('ceo-03', 'ceo-04.2')")
    _q(live, "update feature_rollout set count_spec = null where feature_id"
       " = 'ceo-98'")
    for kind, per, sha, smp in (("inside_out", "2026-09", A_SHA, False),
                                ("inside_out", "2026-07", V_SHA, False),
                                ("inside_out", "2026-08", S_SHA, True),
                                ("recon", "2026-09", R_SHA, False)):
        _q(live, "insert into audit_runs (kind, period_label, findings,"
           " report_sha256, run_by, is_sample) values (%s, %s, 0, %s,"
           " 'agent:bks', %s)", (kind, per, sha, smp))
    did = _q(live, "insert into decision_log (entry_kind, decided_on, topic,"
             " decision, decided_by, basis_kind, note, recorded_by) values"
             " ('quyet_dinh', current_date, 'chủ đề giả p87', 'quyết giả',"
             " %s, 'van_ban', 'văn bản giả p87 số 1', %s) returning id",
             (P_FARM, P_FARM))[0][0]
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-98', 'ceo98-x.md', %s)", ("9" * 64,))
    _q(live, "insert into report_outputs (feature_id, name, sha256,"
       " is_sample) values ('ceo-03', 'ceo-risk-mau.md', %s, true)",
       ("5" * 64,))
    return {"feats": feats, "dl": f"dl:{did}"}


def _outputs(live, p87, fid):  # noqa: F811
    """Đầu ra hiện hành (bộ đếm Python, đường owner) → {key: sha}."""
    with psycopg.connect(_owner_dsn(live), connect_timeout=5) as c:
        m, _, _ = ro.output_rows(c, p87["feats"][fid], SINCE,
                                 datetime.now(VN_TZ))
    return {k: o["sha"] for k, o in m.items()}


def _row_sha(live, table, where, args):  # noqa: F811
    return _q(live, f"select {ro._ROW_SHA} from {table} t where {where}",
              args)[0][0]


def _call(live, fid, key, sha, decision="approved", by=P_FARM, who="farm"):  # noqa: F811
    """Gọi THẲNG function bằng login người → (True, id) | (False, lỗi)."""
    try:
        with _conn(live, who) as c:
            rid = c.execute("select output_review_human(%s, %s, %s, %s, %s,"
                            " null)", (fid, key, sha, decision, by)
                            ).fetchone()[0]
        return True, rid
    except psycopg.Error as e:
        return False, str(e)


def _written(live, fid, key):  # noqa: F811
    """(dòng output_reviews, dòng log output_review) của đúng fid/khóa."""
    n = _q(live, "select count(*) from output_reviews where feature_id = %s"
           " and output_key = %s", (fid, key))[0][0]
    lg = _q(live, "select count(*) from agent_action_log where action ="
            " 'output_review' and object_id = %s", (f"{fid}:{key}",))[0][0]
    return n, lg


def _blocked(live, fid, key, sha, frag=None):  # noqa: F811
    ok, msg = _call(live, fid, key, sha)
    assert not ok, f"{fid} {key}: DB GHI duyệt (id {msg}) — phải từ chối"
    if frag:
        assert frag in msg, msg
    assert _written(live, fid, key) == (0, 0), (fid, key)
    return msg


def test_p87_unknown_key_blocked(live, p87):  # noqa: F811
    """Đúng ca lỗi: `ar:` không tồn tại, sha hợp khuôn tùy ý."""
    _blocked(live, "ceo-01", "ar:does-not-exist", JUNK)
    _blocked(live, "ceo-04.2", "ar:does-not-exist", JUNK)
    _blocked(live, "ceo-04.2", f"ar:inside_out/2026-01/{JUNK}", JUNK)


def test_p87_real_key_wrong_feature_or_source_blocked(live, p87):  # noqa: F811
    sha = _outputs(live, p87, "ceo-04.2")[K_A]
    _blocked(live, "ceo-03", K_A, sha)          # khóa thật của tính năng khác
    _blocked(live, "ceo-01", K_A, sha)
    # dòng có thật nhưng không thuộc nguồn của tính năng (kind=recon)
    _blocked(live, "ceo-04.2", K_R,
             _row_sha(live, "audit_runs", "t.report_sha256 = %s", (R_SHA,)))


def test_p87_wrong_sha_blocked(live, p87):  # noqa: F811
    _blocked(live, "ceo-04.2", K_A, JUNK)
    _blocked(live, "ceo-04.2", K_A, _outputs(live, p87, "ceo-04.2")[K_V])


def test_p87_sample_blocked(live, p87):  # noqa: F811
    assert K_S not in _outputs(live, p87, "ceo-04.2")
    _blocked(live, "ceo-04.2", K_S,
             _row_sha(live, "audit_runs", "t.report_sha256 = %s", (S_SHA,)))
    _blocked(live, "ceo-03", "rp:ceo-risk-mau.md", "5" * 64)


def test_p87_valid_report_and_table_approved(live, p87):  # noqa: F811
    """Luồng hợp lệ vẫn duyệt được — SQL thẳng (báo cáo + bảng) và CLI
    (báo cáo); danh tính theo login; người khối khác / --by giả vẫn bị chặn.
    (CLI cho khóa BẢNG: login app_human không SELECT được bảng nguồn như
    `audit_runs` → bộ đếm Python báo "nguồn chưa đọc được" — có từ trước,
    ngoài P8.7, ghi ở báo cáo.)"""
    name = "ceo-risk-2026-10-11.md"
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-03', %s, %s)", (name, "1" * 64))
    ok, msg = _call(live, "ceo-03", f"rp:{name}", "1" * 64, by=P_SALES)
    assert not ok and _written(live, "ceo-03", f"rp:{name}") == (0, 0), msg
    ok, msg = _call(live, "ceo-03", f"rp:{name}", "1" * 64, who="sales",
                    by=P_SALES)
    assert not ok and _written(live, "ceo-03", f"rp:{name}") == (0, 0), msg
    ok, rid = _call(live, "ceo-03", f"rp:{name}", "1" * 64)
    assert ok, rid
    assert _q(live, "select reviewed_by, db_role, content_sha256, decision"
              " from output_reviews where id = %s", (rid,)) == [
        (P_FARM, live["name"]["farm"], "1" * 64, "approved")]
    assert _written(live, "ceo-03", f"rp:{name}") == (1, 1)
    sha = _outputs(live, p87, "ceo-04.2")[K_A]
    ok, rid = _call(live, "ceo-04.2", K_A, sha)
    assert ok, rid
    assert _q(live, "select reviewed_by, db_role, content_sha256 from"
              " output_reviews where id = %s", (rid,)) == [
        (P_FARM, live["name"]["farm"], sha)]
    name = "ceo-risk-2026-10-13.md"
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-03', %s, %s)", (name, "8" * 64))
    rc, out = _cli(live, "farm", "pipelines.rollout", "--review-output",
                   "ceo-03", "--key", f"rp:{name}", "--sha", "8" * 64,
                   "--decision", "approved", "--by", P_FARM)
    assert rc == 0, out
    assert _q(live, "select reviewed_by, db_role from output_reviews where"
              " feature_id = 'ceo-03' and output_key = %s", (f"rp:{name}",)
              ) == [(P_FARM, live["name"]["farm"])]


def _unrev(live, fid, key):  # noqa: F811
    """Bộ đếm DB (`rollout_db_facts`, đường cổng PL02): đầu ra còn CHƯA
    duyệt trên phiên bản hiện hành?"""
    return _q(live, "select f.unrev, f.human from feature_rollout r,"
              " rollout_db_facts(r.feature_id, r.count_spec, r.stage_since,"
              " now()) f where r.feature_id = %s and f.k = %s", (fid, key))


def test_p87_content_change_old_review_not_applied(live, p87):  # noqa: F811
    sha1 = _outputs(live, p87, "ceo-04.2")[K_V]
    ok, rid = _call(live, "ceo-04.2", K_V, sha1)
    assert ok, rid
    assert _unrev(live, "ceo-04.2", K_V) == [(False, True)]
    # nội dung đổi (thêm dòng cùng khóa) → phiên bản mới, duyệt cũ không áp
    _q(live, "insert into audit_runs (kind, period_label, findings,"
       " report_sha256, run_by) values ('inside_out', '2026-07', 3, %s,"
       " 'agent:bks')", (V_SHA,))
    sha2 = _outputs(live, p87, "ceo-04.2")[K_V]
    assert sha2 != sha1
    assert _unrev(live, "ceo-04.2", K_V) == [(True, False)]
    ok, msg = _call(live, "ceo-04.2", K_V, sha1)     # phiên bản CŨ
    assert not ok, f"DB ghi duyệt phiên bản cũ (id {msg})"
    assert "MỚI NHẤT" in msg, msg
    assert _q(live, "select count(*) from output_reviews where output_key ="
              " %s", (K_V,)) == [(1,)]
    ok, rid2 = _call(live, "ceo-04.2", K_V, sha2)
    assert ok, rid2
    assert _unrev(live, "ceo-04.2", K_V) == [(False, True)]
    # báo cáo: ghi lại nội dung khác → sha cũ bị chặn, bản mới chưa duyệt
    name = "ceo-risk-2026-10-12.md"
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-03', %s, %s)", (name, "2" * 64))
    assert _call(live, "ceo-03", f"rp:{name}", "2" * 64)[0]
    _q(live, "insert into report_outputs (feature_id, name, sha256) values"
       " ('ceo-03', %s, %s)", (name, "3" * 64))
    assert _unrev(live, "ceo-03", f"rp:{name}") == [(True, False)]
    ok, msg = _call(live, "ceo-03", f"rp:{name}", "2" * 64)
    assert not ok and "MỚI NHẤT" in msg, msg
    assert _call(live, "ceo-03", f"rp:{name}", "3" * 64)[0]


def test_p87_file_source_blocked_with_reason(live, p87):  # noqa: F811
    """Nguồn file (backup_runs/convlog trên máy ứng dụng) DB không đọc được,
    chưa có bản chụp tin cậy trong DB → từ chối rõ ràng có lý do."""
    _blocked(live, "ceo-95", f"bk:{'4' * 64}", "4" * 64, frag="nguồn file")
    _blocked(live, "ceo-95", "cv:zalo/mid-1", JUNK, frag="nguồn file")


def test_p87_missing_source_or_counter_blocked(live, p87):  # noqa: F811
    _blocked(live, "ceo-97", "ar:does-not-exist", JUNK)        # 0 nguồn
    _blocked(live, "ceo-98", "rp:ceo98-x.md", "9" * 64,        # chưa có
             frag="count_spec")                                # bộ đếm
    _blocked(live, "ceo-99", "rp:x.md", JUNK, frag="chưa vào sổ")


def test_p87_own_review_step_or_bad_prefix_blocked(live, p87):  # noqa: F811
    """Đầu ra có bước NGƯỜI duyệt riêng (decision_log — người ghi) không
    thuộc cơ chế duyệt này; tiền tố lạ → từ chối."""
    key = p87["dl"]
    sha = _outputs(live, p87, "ceo-96")[key]
    _blocked(live, "ceo-96", key, sha, frag="bước duyệt riêng")
    _blocked(live, "ceo-04.2", "zz:abc", JUNK)
    _blocked(live, "ceo-04.2", f"rp:{K_A[3:]}", JUNK)


def _promote(live, fid):  # noqa: F811
    ev = {"human": 1, "unapproved": 0, "unreviewed": 0}
    try:
        with _conn(live, "farm") as c:
            return True, c.execute(
                "select rollout_transition_human(%s, 'promote',"
                " 'co_nguoi_duyet', 'van_hanh', %s, null, null, %s, now())",
                (fid, P_FARM, psycopg.types.json.Jsonb(ev))).fetchone()[0]
    except psycopg.Error as e:
        return False, str(e)


def test_p87_pl02_gate_still_blocks(live, p87):  # noqa: F811
    """Cổng PL02 (DB tự đếm lại) vẫn chặn khi còn đầu ra chưa duyệt đúng
    phiên bản (kể cả sau các lần duyệt rác bị từ chối) / có lỗi nghiêm
    trọng; đủ người duyệt đúng phiên bản → nâng được."""
    _q(live, "insert into audit_runs (kind, period_label, findings,"
       " report_sha256, run_by) values ('inside_out', '2026-06', 1, %s,"
       " 'agent:bks')", ("6" * 64,))
    key = f"ar:inside_out/2026-06/{'6' * 64}"
    outs = _outputs(live, p87, "ceo-04.2")
    sha = outs.pop(key)
    for k, s in outs.items():   # đầu ra khác: duyệt đúng phiên bản hiện hành
        _call(live, "ceo-04.2", k, s)
    for k, s in ((key, JUNK), ("ar:does-not-exist", sha)):
        _call(live, "ceo-04.2", k, s)           # duyệt rác (đã bị chặn)
    assert _unrev(live, "ceo-04.2", key) == [(True, False)]
    ok, msg = _promote(live, "ceo-04.2")
    assert not ok and "DB đếm lại" in msg and "1 chưa duyệt" in msg, msg
    # lỗi nghiêm trọng từ mốc giai đoạn (ghi bằng owner) → chặn
    _q(live, "insert into feature_rollout_events (ts, feature_id, kind,"
       " from_stage, to_stage, severe_code, by_person) values (now(),"
       " 'ceo-03', 'severe', 'co_nguoi_duyet', 'co_nguoi_duyet', 'tu_cam',"
       " 'test-p87')")
    ok, msg = _promote(live, "ceo-03")
    assert not ok and "lỗi nghiêm trọng" in msg, msg
    # duyệt đúng phiên bản hiện hành → cổng DB đạt
    assert _call(live, "ceo-04.2", key, sha)[0]
    ok, to = _promote(live, "ceo-04.2")
    assert ok and to == "van_hanh", to
