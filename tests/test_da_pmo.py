"""v8.3 W83.7 (DA-01) — sổ mốc `project_milestones` + bảng tuần; đổi hạn
CHỈ qua hàng duyệt (`milestone_change`) + khớp sha256 + hạn cũ.

`render_board` thuần (TRỄ, nhắc T-7/T-2 đúng ngày, dd/mm/yyyy); `--seed`
không đè sửa tay; `xong` thiếu evidence → exit 1; `--propose-due` không đổi
DB; `--apply-due` chỉ khi NGƯỜI duyệt, idempotent, stale → exit 1.
DB thật trong schema tạm + ROLLBACK.
"""

import json
import re
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

import pytest

from agents import da_pmo
from pipelines import approval_queue as aq
from pipelines import guardrail
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
REAL = da_pmo.load_milestones()
APPROVER = "TGĐ MẪU"


@pytest.fixture
def db():
    yield from da_db()


@contextmanager
def _fake_job(name, seen):
    seen.append(name)
    run = {"ok": True, "detail": None}
    yield run
    seen.append(run["ok"])


# ---------------------------------------------------------------- thuần


def test_real_milestones_file():
    by = {m["code"]: m["due_date"] for m in REAL}
    assert len(REAL) >= 6
    # v12.0: mốc DA-00/02/03/04/QA (phòng Dự án ngoài phạm vi HĐ) đã gỡ.
    assert not {"DA-00", "DA-02", "DA-03", "DA-04", "DA-QA"} & set(by)
    want = {"DA-01": date(2026, 10, 24),
            "KD-A3-FORM": date(2026, 11, 16), "DA-05": date(2026, 11, 21),
            "MOC-C": date(2026, 11, 30), "MOC-D": date(2026, 12, 18),
            "TT3": date(2026, 12, 23)}
    assert {k: by.get(k) for k in want} == want
    for m in REAL:
        assert m["title"] and m["wp"] and m["gate"]
        assert re.fullmatch(r"[a-z_]+", m["owner_role"]), m["code"]
    doc = json.loads(da_pmo.MILESTONES_FILE.read_bytes().decode("utf-8"))
    assert "BẢN DEV SOẠN" in doc["_doc"] and "CHỜ TGĐ chốt" in doc["_doc"]
    assert all(m["owner_role"] != "gd_du_an" for m in REAL)


@pytest.mark.parametrize("bad,needle", [
    ({"milestones": []}, "0 mốc"),
    ({"milestones": [{"code": "DA-01", "title": "t", "owner_role": "r",
                      "gate": "g", "due_date": "24/10/2026"}]}, "due_date"),
    ({"milestones": [{"code": "da-01", "title": "t", "owner_role": "r",
                      "gate": "g", "due_date": "2026-10-24"}]}, "code"),
    ({"milestones": [{"code": "DA-01", "title": "t", "owner_role": "r",
                      "gate": " ", "due_date": "2026-10-24"}]}, "gate"),
    ({"milestones": [{"code": "DA-01", "title": "t", "owner_role": "r",
                      "gate": "g", "due_date": "2026-10-24"}] * 2}, "trùng"),
    ({"x": 1}, "không đọc được")])
def test_load_milestones_rejects(tmp_path, bad, needle):
    p = tmp_path / "m.json"
    p.write_bytes(json.dumps(bad, ensure_ascii=False).encode("utf-8"))
    with pytest.raises(ValueError) as e:
        da_pmo.load_milestones(p)
    assert needle in str(e.value)


def _rows(status=None):
    status = status or {}
    return [{**{k: m.get(k) for k in da_pmo.COLS},
             "status": status.get(m["code"], "chua_bat_dau"),
             "evidence": "bb-01" if status.get(m["code"]) == "xong" else None}
            for m in REAL]


def test_render_board_late_reminders_dates():
    md = da_pmo.render_board(_rows({"DA-05": "xong"}), date(2026, 10, 25))
    late = md.split("## Mốc trễ", 1)[1].split("## Nhắc", 1)[0]
    assert re.search(r"\*\*TRỄ\*\* DA-01 — hạn 24/10/2026", late)
    assert "DA-05" not in late and "KD-A3-FORM" not in late
    da05 = next(ln for ln in md.splitlines() if ln.startswith("| DA-05 |"))
    assert "TRỄ" not in da05 and "bb-01" in da05
    rem = md.split("## Nhắc hạn hôm nay", 1)[1]
    assert "KD-A3-FORM" not in rem and "DA-05" not in rem
    assert not re.search(r"\d{4}-\d{2}-\d{2}", md)
    dates = re.findall(r"\b\d{1,2}/\d{1,2}/\d{4}\b", md)
    assert dates and all(re.fullmatch(r"\d{2}/\d{2}/\d{4}", d) for d in dates)
    assert "tuần 2026-W43" in md and "chưa có" in md
    assert "BẢN NHÁP" in md


def test_render_board_t7_t2_on_the_day():
    md = da_pmo.render_board(_rows(), date(2026, 11, 9))
    rem = md.split("## Nhắc hạn hôm nay", 1)[1]
    assert "T-7: KD-A3-FORM — hạn 16/11/2026" in rem
    # T-7 của 16/11 = 09/11 — sang 10/11 KHÔNG nhắc lại.
    md1 = da_pmo.render_board(_rows(), date(2026, 11, 10))
    assert "KD-A3-FORM" not in md1.split("## Nhắc hạn hôm nay", 1)[1]
    md2 = da_pmo.render_board(_rows({"DA-05": "xong"}), date(2026, 11, 19))
    rem2 = md2.split("## Nhắc hạn hôm nay", 1)[1]
    assert "DA-05" not in rem2                       # đã xong → không nhắc
    md3 = da_pmo.render_board(_rows(), date(2026, 11, 19))
    assert "T-2: DA-05 — hạn 21/11/2026" in md3


def test_real_board_passes_guardrail_any_day():
    """Bảng tuần từ milestones.json THẬT phải duyệt được — `decide` kiểm lại
    guardrail; chữ nhóm rượu/từ cấm trong title/gate làm MỌI bảng tuần chỉ
    còn reject/expire (cold-check v8.3 MAJOR)."""
    for m in REAL:
        for k in ("title", "gate"):
            g = guardrail.check(m[k])
            assert g["ok"] is True, (m["code"], k, g["violations"])
    d = date(2026, 10, 1)
    while d <= date(2027, 1, 10):
        for st in ({}, {"DA-05": "xong", "MOC-C": "xong"}):
            g = guardrail.check(da_pmo.render_board(_rows(st), d))
            assert g["ok"] is True, (d, g["violations"])
        d += timedelta(days=3)


def test_change_payload_roundtrip_regex():
    p = da_pmo.change_payload("DA-05", date(2026, 11, 21), date(2026, 11, 28),
                              "TGĐ MẪU")
    m = da_pmo._PAYLOAD_RE.fullmatch(p)
    assert m and m["c"] == "DA-05" and m["new"] == "2026-11-28"


@pytest.mark.parametrize("argv", [
    ["--seed", "--board"], [], ["--set-status", "DA-05", "--status", "xong"],
    ["--set-status", "DA-05", "--by", "X"], ["--board", "--dry-run"],
    ["--seed", "--submit"], ["--propose-due", "DA-05", "--by", "X"],
    ["--propose-due", "DA-05", "--due", "21/11/2026", "--by", "X"],
    ["--apply-due", "1"], ["--board", "--evidence", "x"],
    ["--set-status", "DA-05", "--status", "la", "--by", "X"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(da_pmo, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        da_pmo.main(argv)
    assert e.value.code == 2


def test_cli_xong_without_evidence_exit1_before_connect(monkeypatch):
    monkeypatch.setattr(da_pmo, "connect", lambda: pytest.fail("connect"))
    assert da_pmo.main(["--set-status", "DA-05", "--status", "xong", "--by",
                        "X"]) == 1
    assert da_pmo.main(["--set-status", "DA-05", "--status", "xong", "--by",
                        "X", "--evidence", "  "]) == 1


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(da_pmo, "connect", lambda: None)
    assert da_pmo.main(["--seed", "--dry-run"]) == 2


def test_no_send_path_grep():
    src = (ROOT / "agents" / "da_pmo.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|email\.mime|httpx|requests|"
                         r"urllib\.request|socket|llm_gateway", src)


# ---------------------------------------------------------------- DB


def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(da_pmo, "connect", lambda: TxConn(db))
    return da_pmo.main(list(argv))


def _due(db, code):
    return db.execute("select due_date from project_milestones where code"
                      " = %s", (code,)).fetchone()[0]


def test_seed_twice_keeps_manual_edit(db, monkeypatch, capsys):
    assert _cli(db, monkeypatch, "--seed", "--dry-run") == 0
    assert f"would_insert={len(REAL)}" in capsys.readouterr().out
    assert db.execute("select count(*) from project_milestones"
                      ).fetchone()[0] == 0
    assert _cli(db, monkeypatch, "--seed") == 0
    assert f"inserted={len(REAL)} existing=0" in capsys.readouterr().out
    db.execute("update project_milestones set due_date = '2026-11-28'"
               " where code = 'DA-05'")
    assert _cli(db, monkeypatch, "--seed") == 0
    assert f"inserted=0 existing={len(REAL)}" in capsys.readouterr().out
    assert _due(db, "DA-05") == date(2026, 11, 28)


def test_set_status_rules(db, monkeypatch):
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--set-status", "DA-05", "--status", "xong",
                "--by", "X") == 1
    assert _cli(db, monkeypatch, "--set-status", "DA-05", "--status",
                "dang_lam", "--by", "X") == 0
    assert _cli(db, monkeypatch, "--set-status", "DA-05", "--status", "xong",
                "--by", "X", "--evidence", "evidence/bb-da05.md") == 0
    row = db.execute("select status, evidence, updated_by from"
                     " project_milestones where code = 'DA-05'").fetchone()
    assert row == ("xong", "evidence/bb-da05.md", "X")
    assert _cli(db, monkeypatch, "--set-status", "KHONG-CO", "--status",
                "dang_lam", "--by", "X") == 1


def test_board_writes_file_and_submits(db, monkeypatch, tmp_path, capsys):
    seen = []
    monkeypatch.setattr(da_pmo, "job_run", lambda n: _fake_job(n, seen))
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--board", "--date", "2026-10-25",
                "--out-dir", str(tmp_path)) == 0
    md = (tmp_path / "da-pmo-board-2026-10-25.md").read_text(encoding="utf-8")
    assert "**TRỄ** DA-01" in md
    assert seen == ["agents.da_pmo", True]
    assert db.execute("select count(*) from approval_queue").fetchone()[0] == 0
    assert _cli(db, monkeypatch, "--board", "--date", "2026-10-25",
                "--out-dir", str(tmp_path), "--submit") == 0
    q = db.execute("select block, object_type, object_id, status, payload,"
                   " id from approval_queue").fetchall()
    assert len(q) == 1 and q[0][:4] == ("ceo", "weekly_board",
                                        "board:2026-W43", "pending")
    assert q[0][4] == md
    assert _cli(db, monkeypatch, "--board", "--date", "2026-10-24",
                "--out-dir", str(tmp_path), "--submit") == 1   # trùng W43
    assert seen[-1] is False
    # Bảng từ milestones.json thật DUYỆT được (decide kiểm lại guardrail).
    ok, msg = aq.decide(TxConn(db), q[0][5], APPROVER, "approved")
    assert ok, msg
    assert db.execute("select status from approval_queue where id = %s",
                      (q[0][5],)).fetchone()[0] == "approved"


def test_board_submit_refused_when_guardrail_fails(db, monkeypatch,
                                                   tmp_path, capsys):
    """Evidence/gate sửa tay chứa từ cấm → `--submit` exit 1, KHÔNG đẩy mục
    (mục trượt guardrail chỉ còn reject/expire); file nháp vẫn ghi."""
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--set-status", "MOC-C", "--status",
                "dang_lam", "--by", "X", "--evidence",
                "biên bản sửa chữa máy chủ") == 0
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--board", "--date", "2026-10-25",
                "--out-dir", str(tmp_path), "--submit") == 1
    err = capsys.readouterr().err
    assert "trượt guardrail" in err and "tu_cam" in err and "KHÔNG đẩy" in err
    assert db.execute("select count(*) from approval_queue").fetchone()[0] == 0
    assert (tmp_path / "da-pmo-board-2026-10-25.md").exists()


def test_propose_apply_due_flow(db, monkeypatch, capsys):
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due",
                "2026-11-21", "--by", "X") == 1            # trùng hạn cũ
    assert _cli(db, monkeypatch, "--propose-due", "KHONG-CO", "--due",
                "2026-11-20", "--by", "X") == 1
    assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due",
                "2026-11-28", "--by", "Chuyên viên MẪU") == 0
    q = db.execute("select id, status, object_id from approval_queue"
                   " where object_type = 'milestone_change'").fetchall()
    assert len(q) == 1 and q[0][1:] == ("pending", "milestone:DA-05")
    qid = q[0][0]
    assert _due(db, "DA-05") == date(2026, 11, 21)          # chưa đổi
    assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due",
                "2026-11-29", "--by", "X") == 1            # đang chờ
    assert _cli(db, monkeypatch, "--apply-due", str(qid), "--by", "X") == 1
    assert _due(db, "DA-05") == date(2026, 11, 21)
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    before = db.execute("select code, due_date from project_milestones"
                        " order by code").fetchall()
    assert _cli(db, monkeypatch, "--apply-due", str(qid), "--by", "X") == 0
    after = db.execute("select code, due_date from project_milestones"
                       " order by code").fetchall()
    diff = [(b, a) for b, a in zip(before, after) if b != a]
    assert diff == [(("DA-05", date(2026, 11, 21)),
                     ("DA-05", date(2026, 11, 28)))]
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--apply-due", str(qid), "--by", "X") == 0
    assert "no-op" in capsys.readouterr().out
    assert _due(db, "DA-05") == date(2026, 11, 28)


def test_apply_due_stale_and_wrong_items(db, monkeypatch):
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due",
                "2026-11-25", "--by", "X") == 0
    qid = db.execute("select max(id) from approval_queue").fetchone()[0]
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    db.execute("update project_milestones set due_date = '2026-11-22'"
               " where code = 'DA-05'")                    # sửa tay → stale
    assert _cli(db, monkeypatch, "--apply-due", str(qid), "--by", "X") == 1
    assert _due(db, "DA-05") == date(2026, 11, 22)
    # Mục bị từ chối / sai loại / không tồn tại → exit 1.
    assert _cli(db, monkeypatch, "--propose-due", "MOC-C", "--due",
                "2026-12-01", "--by", "X") == 0
    rq = db.execute("select max(id) from approval_queue").fetchone()[0]
    ok, msg = aq.decide(TxConn(db), rq, APPROVER, "rejected")
    assert ok, msg
    assert _cli(db, monkeypatch, "--apply-due", str(rq), "--by", "X") == 1
    assert _due(db, "MOC-C") == date(2026, 11, 30)
    assert _cli(db, monkeypatch, "--apply-due", "999999", "--by", "X") == 1


def test_propose_due_proposer_cannot_self_approve(db, monkeypatch):
    """created_by = NGƯỜI đề xuất (không phải agent) → `decide_item` chặn
    người đó tự duyệt đổi hạn mốc của mình (tách quyền A01)."""
    assert _cli(db, monkeypatch, "--seed") == 0
    assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due",
                "2026-11-28", "--by", "Chuyên viên MẪU") == 0
    qid, by = db.execute("select id, created_by from approval_queue where"
                         " object_type = 'milestone_change'").fetchone()
    assert by == "Chuyên viên MẪU"
    ok, msg = aq.decide(TxConn(db), qid, " Chuyên viên MẪU ", "approved")
    assert not ok and "người duyệt trùng người tạo" in msg
    assert _cli(db, monkeypatch, "--apply-due", str(qid), "--by", "X") == 1
    assert _due(db, "DA-05") == date(2026, 11, 21)
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg


def test_apply_due_older_approval_blocked(db, monkeypatch):
    """2 đề xuất cùng mốc đều approved → chỉ bản duyệt MỚI NHẤT áp dụng
    được (verify sha256); bản cũ → exit 1, hạn giữ nguyên (không đè quyết
    định sau của người duyệt). Bỏ nhánh verify → test đỏ."""
    assert _cli(db, monkeypatch, "--seed") == 0
    ids = []
    for due in ("2026-11-28", "2026-12-02"):
        assert _cli(db, monkeypatch, "--propose-due", "DA-05", "--due", due,
                    "--by", "X") == 0
        ids.append(db.execute("select max(id) from approval_queue"
                              ).fetchone()[0])
        ok, msg = aq.decide(TxConn(db), ids[-1], APPROVER, "approved")
        assert ok, msg
    q1, q2 = ids
    assert _cli(db, monkeypatch, "--apply-due", str(q1), "--by", "X") == 1
    assert _due(db, "DA-05") == date(2026, 11, 21)
    assert _cli(db, monkeypatch, "--apply-due", str(q2), "--by", "X") == 0
    assert _due(db, "DA-05") == date(2026, 12, 2)
