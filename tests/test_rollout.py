"""v12.1 B1 — danh mục tính năng HĐ (`data/contract_features.json`) + sổ
triển khai 3 bước (`pipelines.rollout`, PL02 mục 1).

Thuần: kiểm danh mục (89 = 9 phòng ban, module tồn tại), lịch ngày làm
việc, cổng, `--by` người thật, hồ sơ. DB thật trong schema tạm + ROLLBACK
(`tests.test_da_schema.da_db`): cổng 5 ngày/50 đầu ra/10 ngày/0 lỗi, lỗi
nghiêm trọng tự lùi, append-only, quyền role.
"""

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from pipelines import rollout as ro
from pipelines.director import BLOCKS
from pipelines.period import VN_TZ
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
REAL = ro.load_features()
SHIFT = ro.load_shift()
# File do lane v12.2–v12.6 tạo trên nhánh khác — có sau khi gộp.
LANE_FILES = {"agents/pc_hr.py", "agents/sx_label.py", "agents/rev_share.py",
              "scripts/ops_monthly.py"}
BY = "Quản lý AI MẪU"


@pytest.fixture
def db():
    """TxConn: commit() của module chỉ ghi nhận — dữ liệu + `set local
    search_path` của schema tạm ở lại tx fixture tới ROLLBACK."""
    for conn in da_db():
        yield TxConn(conn)


def _doc(features, counts=None):
    return {"_doc": "x", "so_tinh_nang_hd": counts or {
        "ceo": 9, "sales": 12, "marketing": 14, "intel": 11, "finance": 9,
        "production": 6, "farming": 9, "legal_hr": 10, "data_platform": 9},
        "features": features}


def _f(fid="ceo-01", **kw):
    d = {"id": fid, "phong_ban": fid.rsplit("-", 1)[0], "nguon": "PL01",
         "ten": "Tính năng", "ho_tro": "Hỗ trợ.", "giai_doan": "P1",
         "modules": ["pipelines/rollout.py"], "agent_ids": ["agent:t_b1"],
         "trang_thai_code": "co_code"}
    d.update(kw)
    return d


def _write(tmp_path, doc) -> Path:
    p = tmp_path / "f.json"
    p.write_bytes(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    return p


# ------------------------------------------------------------ danh mục thật


def test_real_catalog_matches_contract():
    doc = json.loads(ro.FEATURES_FILE.read_bytes().decode("utf-8"))
    counts = doc["so_tinh_nang_hd"]
    assert counts == {"ceo": 9, "sales": 12, "marketing": 14, "intel": 11,
                      "finance": 9, "production": 6, "farming": 9,
                      "legal_hr": 10, "data_platform": 9}
    assert sum(counts.values()) == 89
    assert "89" in doc["_doc"] and "chờ hai bên chốt".casefold() in \
        doc["_doc"].casefold() and "NHÓM" in doc["_doc"]
    assert {f["phong_ban"] for f in REAL} == set(BLOCKS)
    rieng = {f["ten"] for f in REAL if f["trang_thai_code"] == "lam_rieng"}
    assert rieng == {"Website bán hàng", "Chatbot trên website"}
    for f in REAL:
        assert len(f["ho_tro"]) <= 120 and f["ho_tro"].count(". ") == 0, \
            f["id"]
    # P2 theo PL01 mục 2 có trong danh mục với đúng giai đoạn.
    p2 = {f["ten"] for f in REAL if f["giai_doan"] == "P2"}
    assert {"Báo cáo HĐTV", "Kho tài liệu R&D", "Cảnh báo, dự báo",
            "Cập nhật văn bản pháp luật mới"} <= p2


def test_real_catalog_lane_features_present():
    mods = {m for f in REAL for m in f["modules"]}
    assert LANE_FILES <= mods
    assert "pipelines/rollout.py" in mods and "connectors/zalo.py" in mods


def _missing(paths):
    return sorted(p for p in paths if not (ROOT / p).is_file())


def test_real_catalog_modules_exist():
    paths = {m for f in REAL if f["trang_thai_code"] != "lam_rieng"
             for m in f["modules"]} - LANE_FILES
    assert _missing(paths) == []
    for f in REAL:
        if f["trang_thai_code"] == "lam_rieng":
            assert f["modules"] == [] and f["agent_ids"] == []


@pytest.mark.xfail(bool(_missing(LANE_FILES)), strict=True,
                   reason="module lane v12.2–v12.6 chưa gộp vào nhánh này")
def test_lane_modules_exist_after_merge():
    assert _missing(LANE_FILES) == []


def test_agent_ids_are_real_actors():
    """agent_ids phải là chuỗi có thật trong code (không bịa actor)."""
    src = "".join(p.read_bytes().decode("utf-8") for d in
                  ("agents", "pipelines", "connectors", "scripts", "ingest")
                  for p in (ROOT / d).glob("*.py"))
    for f in REAL:
        for a in f["agent_ids"]:
            assert f'"{a}"' in src, (f["id"], a)


@pytest.mark.parametrize("doc,needle", [
    (_doc([_f()], counts={"ceo": 89}), "so_tinh_nang_hd"),
    (_doc([_f()], counts={b: 1 for b in BLOCKS}), "tổng 89"),
    (_doc([]), "rỗng"),
    (_doc([_f("CEO-01")]), "id"),
    (_doc([_f("ceo-1")]), "id"),
    (_doc([_f(), _f()]), "trùng"),
    (_doc([_f(phong_ban="sales")]), "phong_ban"),
    (_doc([_f("co_khi-01")]), "phong_ban"),
    (_doc([_f(ten=" ")]), "ten"),
    (_doc([_f(giai_doan="P3")]), "giai_doan"),
    (_doc([_f(trang_thai_code="xong")]), "trang_thai_code"),
    (_doc([_f(modules=[])]), "co_code phải có"),
    (_doc([_f(modules="a.py")]), "modules"),
    (_doc([_f(modules=["a.py", "a.py"])]), "trùng"),
    (_doc([_f(agent_ids=[""])]), "agent_ids"),
    ({"features": [_f()]}, "không đọc được"),
])
def test_load_features_rejects(tmp_path, doc, needle):
    with pytest.raises(ValueError) as e:
        ro.load_features(_write(tmp_path, doc))
    assert needle in str(e.value)


def test_load_features_unreadable(tmp_path):
    p = tmp_path / "f.json"
    p.write_bytes(b"\xff{")
    with pytest.raises(ValueError, match="không đọc được"):
        ro.load_features(p)
    with pytest.raises(ValueError, match="không đọc được"):
        ro.load_features(tmp_path / "missing.json")


def test_load_features_thieu_without_modules_ok(tmp_path):
    feats = ro.load_features(_write(tmp_path, _doc(
        [_f(), _f("ceo-02", modules=[], agent_ids=[],
                  trang_thai_code="thieu")])))
    assert [f["id"] for f in feats] == ["ceo-01", "ceo-02"]


# ------------------------------------------------------------ lịch + cổng


def test_real_shift_is_mon_fri_assumption():
    assert SHIFT["workdays"] == frozenset(range(5))
    doc = json.loads(ro.CONFIG_FILE.read_bytes().decode("utf-8"))
    assert "GIẢ ĐỊNH" in doc["_doc"]


@pytest.mark.parametrize("cfg,needle", [
    ({"workdays": [], "holidays": []}, "workdays"),
    ({"workdays": [7]}, "workdays"),
    ({"workdays": [0], "holidays": ["01/01/2027"]}, "YYYY-MM-DD"),
    ({"holidays": []}, "không đọc được"),
])
def test_load_shift_rejects(tmp_path, cfg, needle):
    p = tmp_path / "c.json"
    p.write_bytes(json.dumps(cfg).encode("utf-8"))
    with pytest.raises(ValueError, match=needle):
        ro.load_shift(p)


def _vn(y, m, d, h=9):
    return datetime(y, m, d, h, tzinfo=VN_TZ)


def test_business_days_boundaries():
    mon = _vn(2026, 10, 12)
    assert ro.business_days(mon, mon, SHIFT) == 0
    assert ro.business_days(mon, mon + timedelta(days=-3), SHIFT) == 0
    assert ro.business_days(_vn(2026, 10, 16), _vn(2026, 10, 19), SHIFT) == 1
    assert ro.business_days(mon, _vn(2026, 10, 17), SHIFT) == 4   # T3..T6
    assert ro.business_days(mon, _vn(2026, 10, 19), SHIFT) == 5
    hol = ro.period.parse_shift({"start": "00:00", "end": "23:59",
                                 "workdays": [0, 1, 2, 3, 4],
                                 "holidays": ["2026-10-14"]})
    assert ro.business_days(mon, _vn(2026, 10, 19), hol) == 4
    # 17:30 UTC = 00:30 VN hôm sau — đếm theo ngày VN.
    since = datetime(2026, 10, 12, 17, 30, tzinfo=timezone.utc)   # T3 VN
    assert ro.business_days(since, _vn(2026, 10, 14), SHIFT) == 1


def test_business_days_rejects_bad_types():
    with pytest.raises(ValueError):
        ro.business_days(datetime(2026, 10, 12),  # noqa: DTZ001 — naive
                         _vn(2026, 10, 13), SHIFT)
    with pytest.raises(TypeError):
        ro.business_days(date(2026, 10, 12), _vn(2026, 10, 13), SHIFT)
    with pytest.raises(TypeError):
        ro.business_days("2026-10-12", _vn(2026, 10, 13), SHIFT)


@pytest.mark.parametrize("stage,days,outputs,severe,target,n_why,needle", [
    ("chay_thu", 5, 50, 0, "co_nguoi_duyet", 0, None),
    ("chay_thu", 4, 50, 0, "co_nguoi_duyet", 1, "4/5"),
    ("chay_thu", 5, 49, 0, "co_nguoi_duyet", 1, "49/50"),
    ("chay_thu", 9, None, 0, "co_nguoi_duyet", 1, "agent_ids"),
    ("chay_thu", 0, 0, 0, "co_nguoi_duyet", 2, None),
    ("co_nguoi_duyet", 10, None, 0, "van_hanh", 0, None),
    ("co_nguoi_duyet", 9, 0, 0, "van_hanh", 1, "9/10"),
    ("co_nguoi_duyet", 30, 0, 1, "van_hanh", 1, "lỗi nghiêm trọng"),
    ("tat", 0, None, 3, "chay_thu", 0, None),
    ("van_hanh", 99, 99, 0, None, 1, "đã vận hành"),
])
def test_evaluate(stage, days, outputs, severe, target, n_why, needle):
    t, why = ro.evaluate(stage, days, outputs, severe)
    assert t == target and len(why) == n_why
    if needle:
        assert needle in "; ".join(why)


@pytest.mark.parametrize("by", [None, "", "  ", "agent:kd_a1", "System:sla",
                                 " AGENT:x", "a" * 101, "tên\nngười", 5])
def test_check_by_rejects(by):
    with pytest.raises(ValueError):
        ro.check_by(by)


def test_check_by_and_note():
    assert ro.check_by("  GĐ bán hàng ") == "GĐ bán hàng"
    assert ro._clean_note("  ") is None and ro._clean_note(None) is None
    n = ro._clean_note("khách 0905123456 phản ánh " + "x" * 500)
    assert "0905123456" not in n and len(n) <= ro.MAX_NOTE


# ------------------------------------------------------------ hồ sơ thuần


def test_evidence_status(tmp_path):
    (tmp_path / "a.py").write_bytes(b"latency_ms = 1\n")
    assert ro.evidence_status((), tmp_path) == "chưa có bằng chứng"
    assert ro.evidence_status((("a.py", None),), tmp_path).startswith("có")
    assert ro.evidence_status((("a.py", "latency_ms"),),
                              tmp_path).startswith("có")
    s = ro.evidence_status((("a.py", "p95"), ("b.py", None)), tmp_path)
    assert s == "chưa có bằng chứng (thiếu a.py, b.py)"


def test_criteria_cover_pl02_muc2():
    names = [c[0] for c in ro.CRITERIA]
    assert len(names) == 11 and len(set(names)) == 11
    assert names[0].startswith("Lỗi nghiêm trọng")
    assert len(ro.SEVERE) == 7
    # Bằng chứng tham chiếu file có thật hoặc file lane khác tạo sau gộp.
    allowed = LANE_FILES | {"deploy/onprem/README.md"}
    for _, _, _, ev in ro.CRITERIA:
        for rel, _ in ev:
            assert (ROOT / rel).is_file() or rel in allowed, rel


def _row(fid, stage=None, days=0, outputs=None, severe=0, ten="T"):
    f = _f(fid, ten=ten)
    if stage is None:
        return {"feature": f, "stage": None, "since": None, "facts": None}
    t, why = ro.evaluate(stage, days, outputs, severe)
    return {"feature": f, "stage": stage, "since": _vn(2026, 10, 12),
            "facts": {"days": days, "outputs": outputs, "severe": severe,
                      "target": t, "why": why}}


def test_render_dossier_sections():
    rows = [_row("ceo-01"), _row("ceo-02", "chay_thu", 6, 50),
            _row("ceo-03", "chay_thu", 2, None, ten="A | B"),
            _row("sales-01", "van_hanh", 30, 80)]
    sev = [{"ts": _vn(2026, 10, 13), "feature_id": "ceo-02",
            "severe_code": "lo_pii", "from_stage": "co_nguoi_duyet",
            "note": "SĐT 0905123456 lộ", "by_person": "GĐ bán hàng"}]
    md = ro.render_dossier("P1", rows, sev, 1, _vn(2026, 10, 20))
    for h in ("# Hồ sơ đề nghị nghiệm thu P1",
              "## 1. Danh sách tính năng (4 nhóm)",
              "## 2. Kết quả chạy thử", "## 3. Nhật ký lỗi",
              "## 4. Tiêu chí kỹ thuật", "## 5. Ký nhận", "20/10/2026"):
        assert h in md, h
    assert re.search(r"\| ceo-01 \|.*chưa vào sổ", md)
    assert "không đếm được" in md and "A / B" in md
    assert "`ceo-02` chạy thử: đủ điều kiện nâng lên có người duyệt" in md
    assert "`ceo-03` chạy thử: CHƯA đủ" in md and "`sales-01` vận hành" in md
    assert "Lộ dữ liệu cá nhân" in md and "0905123456" not in md
    sec4 = md.split("## 4.", 1)[1].split("## 5.", 1)[0]
    assert sec4.count("\n| ") == len(ro.CRITERIA) + 1
    assert "1 lỗi ghi nhận (1 lần vào giai đoạn có người duyệt)" in sec4
    assert sec4.count("chưa có bằng chứng") >= 3


def test_render_dossier_empty():
    md = ro.render_dossier("P2", [_row("ceo-05")], [], 0, _vn(2026, 10, 20))
    assert "Chưa tính năng nào vào sổ" in md
    assert "Chưa ghi nhận lỗi nghiêm trọng nào" in md
    assert "chưa có tính năng nào qua giai đoạn có người duyệt" in md


# ------------------------------------------------------------ CLI không DB


@pytest.mark.parametrize("argv", [
    [], ["--seed", "--status"], ["--promote", "ceo-01"],
    ["--promote", "ceo-01", "--by", "agent:x"], ["--seed", "--by", " "],
    ["--severe", "ceo-01", "--by", BY],
    ["--severe", "ceo-01", "--reason", "khac", "--by", BY],
    ["--promote", "ceo-01", "--by", BY, "--reason", "lo_pii"],
    ["--promote", "ceo-01", "--by", BY, "--note", "x"],
    ["--dossier"], ["--status", "--phase", "P1"], ["--status", "--out", "x"],
    ["--dossier", "--phase", "P3"],
])
def test_cli_usage_errors(argv, monkeypatch):
    monkeypatch.setattr(ro, "connect", lambda: pytest.fail("không connect"))
    with pytest.raises(SystemExit) as e:
        ro.main(argv)
    assert e.value.code == 2


def test_cli_db_down_and_bad_config(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(ro, "connect", lambda: None)
    assert ro.main(["--status"]) == 2
    assert "DB không kết nối" in capsys.readouterr().err
    monkeypatch.setattr(ro, "FEATURES_FILE", tmp_path / "missing.json")
    assert ro.main(["--status"]) == 2
    assert "cấu hình" in capsys.readouterr().err


# ------------------------------------------------------------ DB


FEATS = [_f("ceo-01"), _f("ceo-02", agent_ids=[]),
         _f("sales-08", modules=[], agent_ids=[],
            trang_thai_code="lam_rieng"),
         _f("ceo-05", giai_doan="P2", agent_ids=["agent:t_b1_p2"])]
NOW = datetime.now(VN_TZ)


def _log(conn, actor, n):
    for i in range(n):
        conn.execute("insert into agent_action_log (actor, action,"
                     " object_type, object_id) values (%s, 'test_b1',"
                     " 't', %s)", (actor, str(i)))


def _state(conn, fid):
    return conn.execute("select stage, stage_since from feature_rollout"
                        " where feature_id = %s", (fid,)).fetchone()


def _events(conn, fid):
    return [r[0] for r in conn.execute(
        "select kind from feature_rollout_events where feature_id = %s"
        " order by id", (fid,))]


def test_schema_tables_append_only_and_checks(db):
    ro.seed(db, FEATS, BY, now=NOW)
    for sql in ("update feature_rollout_events set note = 'x'",
                "delete from feature_rollout_events",
                "truncate feature_rollout_events cascade"):
        with pytest.raises(psycopg.errors.RaiseException), db.transaction():
            db.execute(sql)
    bad = [
        ("ceo-01", "seed", None, "chay_thu", None, "agent:x"),
        ("ceo-01", "seed", None, "chay_thu", None, "System:sla"),
        ("ceo-01", "severe", "chay_thu", "chay_thu", None, BY),
        ("ceo-01", "seed", None, "chay_thu", "lo_pii", BY),
        ("ceo-01", "seed", None, "xong", None, BY),
        ("ceo-01", "khac", None, "chay_thu", None, BY),
    ]
    for p in bad:
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute("insert into feature_rollout_events (feature_id, kind,"
                       " from_stage, to_stage, severe_code, by_person) values"
                       " (%s, %s, %s, %s, %s, %s)", p)
    for p in (("CEO-01", "chay_thu"), ("ceo-09", "xong")):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute("insert into feature_rollout (feature_id, stage,"
                       " updated_by) values (%s, %s, 'x')", p)
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        db.execute("insert into feature_rollout_events (feature_id, kind,"
                   " to_stage, by_person) values ('ceo-77', 'seed',"
                   " 'chay_thu', %s)", (BY,))


def test_roles_select_only(db):
    for t in ("feature_rollout", "feature_rollout_events"):
        for priv, want in (("select", True), ("insert", False),
                           ("update", False), ("delete", False)):
            assert db.execute("select has_table_privilege('app_human', %s,"
                              " %s)", (t, priv)).fetchone()[0] is want
        assert db.execute("select has_table_privilege('agent_writer', %s,"
                          " 'select')", (t,)).fetchone()[0] is False


def test_seed_idempotent_only_co_code(db):
    st = ro.seed(db, FEATS, BY, now=NOW - timedelta(days=30))
    assert st == {"inserted": 3, "existing": 0, "skipped": 1} and db.committed
    assert _state(db, "sales-08") is None
    st2 = ro.seed(db, FEATS, BY, now=NOW)
    assert st2 == {"inserted": 0, "existing": 3, "skipped": 1}
    stage, since = _state(db, "ceo-01")
    assert stage == "chay_thu" and since < NOW - timedelta(days=29)
    assert _events(db, "ceo-01") == ["seed"]
    with pytest.raises(ValueError):
        ro.seed(db, FEATS, "agent:x")


def test_promote_refusals_write_nothing(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=1))
    with pytest.raises(ro.RolloutError, match="không có trong danh mục"):
        ro.promote(db, FEATS, "ceo-99", BY, SHIFT)
    with pytest.raises(ro.RolloutError, match="lam_rieng"):
        ro.promote(db, FEATS, "sales-08", BY, SHIFT)
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.promote(db, FEATS + [_f("intel-01")], "intel-01", BY, SHIFT)
    _log(db, "agent:t_b1", 60)
    with pytest.raises(ro.RolloutError, match="ngày làm việc"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert _state(db, "ceo-01")[0] == "chay_thu"
    assert _events(db, "ceo-01") == ["seed"]
    with pytest.raises(ValueError):
        ro.promote(db, FEATS, "ceo-01", "system:x", SHIFT)


def test_promote_no_agent_ids_fail_closed(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=60))
    _log(db, "agent:t_b1", 80)
    with pytest.raises(ro.RolloutError, match="agent_ids"):
        ro.promote(db, FEATS, "ceo-02", BY, SHIFT)


def test_promote_counts_outputs_only_since_stage_start(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=30))
    _log(db, "agent:t_b1", 49)
    _log(db, "agent:khac", 10)
    with pytest.raises(ro.RolloutError, match="49/50"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    _log(db, "agent:t_b1", 1)
    n = db.committed
    r = ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert (r["from"], r["to"]) == ("chay_thu", "co_nguoi_duyet")
    assert db.committed == n + 1
    ev = db.execute("select from_stage, to_stage, evidence, by_person from"
                    " feature_rollout_events where kind = 'promote'"
                    ).fetchone()
    assert ev[:2] == ("chay_thu", "co_nguoi_duyet") and ev[3] == BY
    assert ev[2]["outputs"] == 50 and ev[2]["days"] >= 5
    # Log ghi TRƯỚC mốc vào giai đoạn không được tính.
    ro.seed(db, [_f("ceo-03")], BY, now=NOW + timedelta(hours=1))
    _log(db, "agent:t_b1", 50)
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, [_f("ceo-03")], "ceo-03", BY, SHIFT,
                   now=NOW + timedelta(days=30))


def test_review_stage_needs_10_days_and_no_severe(db):
    t0 = NOW - timedelta(days=40)
    ro.seed(db, FEATS, BY, now=t0)
    _log(db, "agent:t_b1", 50)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=14))
    t1 = t0 + timedelta(days=14)
    with pytest.raises(ro.RolloutError, match="/10 ngày"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t1 + timedelta(days=7))
    # Lỗi chèn tay không kèm đổi giai đoạn vẫn chặn (phòng thủ 2 lớp).
    db.execute("insert into feature_rollout_events (ts, feature_id, kind,"
               " from_stage, to_stage, severe_code, by_person) values"
               " (%s, 'ceo-01', 'severe', 'co_nguoi_duyet', 'co_nguoi_duyet',"
               " 'tu_cam', %s)", (t1 + timedelta(days=1), BY))
    with pytest.raises(ro.RolloutError, match="1 lỗi nghiêm trọng"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t1 + timedelta(days=20))
    assert _state(db, "ceo-01")[0] == "co_nguoi_duyet"


def test_full_path_to_van_hanh_then_no_more(db):
    t0 = NOW - timedelta(days=40)
    ro.seed(db, FEATS, BY, now=t0)
    _log(db, "agent:t_b1", 50)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=8))
    r = ro.promote(db, FEATS, "ceo-01", "GĐ bán hàng", SHIFT,
                   now=t0 + timedelta(days=24))
    assert r["to"] == "van_hanh" and r["facts"]["days"] >= 10
    with pytest.raises(ro.RolloutError, match="đã vận hành"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert _events(db, "ceo-01") == ["seed", "promote", "promote"]


def test_severe_rolls_back_to_trial_and_resets_clock(db):
    t0 = NOW - timedelta(days=10)
    ro.seed(db, FEATS, BY, now=t0)
    _log(db, "agent:t_b1", 50)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=8))
    t_err = NOW + timedelta(hours=1)        # sau mọi dòng log đã ghi
    r = ro.record_severe(db, "ceo-01", "thieu_nhan_ai", BY,
                         note="khách 0905123456 báo", now=t_err)
    assert (r["from"], r["to"]) == ("co_nguoi_duyet", "chay_thu")
    stage, since = _state(db, "ceo-01")
    assert stage == "chay_thu" and since == t_err
    note = db.execute("select note from feature_rollout_events where kind ="
                      " 'severe'").fetchone()[0]
    assert "0905123456" not in note
    # Đầu ra cũ (trước mốc mới) không được tính lại.
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT,
                   now=t_err + timedelta(days=10))
    # Lỗi khi đang chạy thử: vẫn chạy thử, mốc đếm lại.
    t2 = t_err + timedelta(days=3)
    assert ro.record_severe(db, "ceo-01", "lo_pii", BY, now=t2)["to"] == \
        "chay_thu"
    assert _state(db, "ceo-01")[1] == t2
    with pytest.raises(ValueError, match="--reason"):
        ro.record_severe(db, "ceo-01", "khac", BY)
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.record_severe(db, "intel-01", "lo_pii", BY)


def test_disable_and_reenable(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=3))
    assert ro.disable(db, "ceo-02", BY, note="tạm dừng")["to"] == "tat"
    with pytest.raises(ro.RolloutError, match="đã tắt"):
        ro.disable(db, "ceo-02", BY)
    r = ro.record_severe(db, "ceo-02", "tu_cam", BY)
    assert (r["from"], r["to"]) == ("tat", "tat")
    assert _state(db, "ceo-02")[0] == "tat"
    r = ro.promote(db, FEATS, "ceo-02", BY, SHIFT)
    assert (r["from"], r["to"]) == ("tat", "chay_thu")
    assert _events(db, "ceo-02") == ["seed", "disable", "severe", "promote"]
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.disable(db, "intel-01", BY)


def test_dossier_from_db_filters_phase(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=2))
    ro.record_severe(db, "ceo-05", "so_lieu_khong_nguon", BY)
    p1 = ro.dossier(db, FEATS, "P1", SHIFT)
    assert "(3 nhóm)" in p1 and "| ceo-05 |" not in p1
    assert "| sales-08 |" in p1 and "Chưa ghi nhận lỗi nghiêm trọng" in p1
    p2 = ro.dossier(db, FEATS, "P2", SHIFT)
    assert "(1 nhóm)" in p2 and "Số liệu không có nguồn" in p2
    with pytest.raises(ValueError):
        ro.dossier(db, FEATS, "P9", SHIFT)


def test_cli_end_to_end(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(ro, "connect", lambda: TxConn(db))
    feats_file = _write(tmp_path, _doc(FEATS))
    monkeypatch.setattr(ro, "FEATURES_FILE", feats_file)
    assert ro.main(["--seed", "--by", BY]) == 0
    assert "vào sổ 3" in capsys.readouterr().out
    assert ro.main(["--status"]) == 0
    out = capsys.readouterr().out
    assert "ceo-01" in out and "chưa vào sổ" in out
    assert ro.main(["--promote", "ceo-01", "--by", BY]) == 1
    assert "TỪ CHỐI" in capsys.readouterr().err
    assert ro.main(["--severe", "ceo-01", "--reason", "lo_pii", "--by", BY,
                    "--note", "x"]) == 0
    assert ro.main(["--disable", "ceo-02", "--by", BY]) == 0
    out_file = tmp_path / "hs" / "nt.md"
    assert ro.main(["--dossier", "--phase", "P1", "--out",
                    str(out_file)]) == 0
    md = out_file.read_bytes().decode("utf-8")
    assert "Lộ dữ liệu cá nhân" in md and "\r\n" not in md
