"""v4.0 W40.6 — `pipelines.director`: 11 cấu hình khối (không người thật),
validate cấu hình hỏng, `digest` thuần theo ngày VN, `submit` lấy SLA/risk
từ cấu hình, CLI dry-run không DB. Đường DB thật ở
tests/test_director_framework.py."""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipelines import director as dr
from pipelines.auth import ROLES

ROOT = Path(__file__).resolve().parent.parent
UTC = timezone.utc
VN = timezone(timedelta(hours=7))


def test_eleven_blocks_no_real_people():
    files = sorted(p.stem for p in dr.DIRECTORS_DIR.glob("*.json"))
    assert files == sorted(dr.BLOCKS) and len(dr.BLOCKS) == 11
    cfgs = dr.load_all()
    assert set(cfgs) == set(dr.BLOCKS)
    for b, c in cfgs.items():
        assert c["block"] == b
        assert set(c["approver_roles"]) <= set(ROLES), b
        assert c["approvers"] == [] and c["digest_recipients"] == [], b
        assert "content_draft" not in c["object_types"]
    assert cfgs["sales"]["approver_roles"] == ["gd_ban_hang"]
    assert cfgs["marketing"]["approver_roles"] == ["gd_marketing"]
    assert cfgs["legal_hr"]["approver_roles"] == ["phap_che"]
    assert cfgs["data_platform"]["approver_roles"] == ["ha_tang", "tgd"]
    assert cfgs["finance"]["approver_roles"] == ["tgd"]


def _broken(tmp_path, block="sales", **mut):
    cfg = json.loads((dr.DIRECTORS_DIR / "sales.json").read_text(
        encoding="utf-8"))
    for k, v in mut.items():
        if k == "type":
            cfg["object_types"] = v
        else:
            cfg[k] = v
    (tmp_path / f"{block}.json").write_text(json.dumps(cfg),
                                            encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize("mut", [
    {"approver_roles": ["ke_toan"]},
    {"approver_roles": []},
    {"type": {"price_change": {"sla_hours": 0, "risk": "high"}}},
    {"type": {"price_change": {"sla_hours": 721, "risk": "high"}}},
    {"type": {"price_change": {"sla_hours": True, "risk": "high"}}},
    {"type": {"price_change": {"sla_hours": 24, "risk": "critical"}}},
    {"type": {"content_draft": {"sla_hours": 24, "risk": "low"}}},
    {"type": {}},
    {"block": "marketing"},
    {"approvers": "Nguoi A"},
    {"due_soon_hours": 0},
    {"name": "  "},
])
def test_broken_config_raises(tmp_path, mut):
    with pytest.raises(dr.DirectorConfigError):
        dr.load_config("sales", _broken(tmp_path, **mut))


@pytest.mark.parametrize("content", [b"", b"{x", b"[]"])
def test_unreadable_config_raises(tmp_path, content):
    (tmp_path / "sales.json").write_bytes(content)
    with pytest.raises(dr.DirectorConfigError):
        dr.load_config("sales", tmp_path)
    with pytest.raises(dr.DirectorConfigError):
        dr.load_config("ceo", tmp_path)             # file thiếu


def _item(i, status, created, decided=None, due=None, title="Mục"):
    return {"id": i, "object_type": "price_change", "object_id": str(i),
            "title": title, "risk": "high", "qa_status": "none",
            "status": status, "created_by": "agent:a5",
            "created_at": created, "due_at": due, "decided_by": None,
            "decided_at": decided, "lane": None}


def test_digest_counts_only_vn_day():
    cfg = dr.load_config("sales")
    now = datetime(2026, 10, 12, 23, 30, tzinfo=VN)
    in_day = datetime(2026, 10, 12, 16, 59, tzinfo=UTC)    # 23:59 VN 12/10
    next_day = datetime(2026, 10, 12, 17, 0, tzinfo=UTC)   # 00:00 VN 13/10
    before = datetime(2026, 10, 11, 16, 59, tzinfo=UTC)    # 23:59 VN 11/10
    items = [
        _item(1, "approved", before, in_day),
        _item(2, "approved", before, next_day),
        _item(3, "expired", before, in_day, due=before),
        _item(4, "expired", before, before, due=before),
        _item(5, "rejected", in_day, in_day),
        _item(6, "pending", in_day, due=now + timedelta(hours=2),
              title="Gọi 0912 345 678"),
        _item(7, "pending", next_day, due=now + timedelta(days=3)),
    ]
    overrides = [{"queue_id": 6, "decided_by": "Hoa", "created_at": in_day},
                 {"queue_id": 7, "decided_by": "Mai",
                  "created_at": next_day}]
    md = dr.digest(cfg, items, now, overrides)
    assert md.startswith(f"# Bản tin GĐ {cfg['name']} — 12/10/2026")
    assert "| Mới vào hàng | 2 |" in md            # #5, #6 (không #7)
    assert "| Đang chờ duyệt (tồn) | 2 |" in md
    assert "| Đã duyệt | 1 |" in md and "| Từ chối | 1 |" in md
    assert "| Hết hạn SLA (expired) | 1 |" in md
    soon = md.split("## Sắp quá hạn")[1].split("##")[0]
    assert "#6" in soon and "#7" not in soon and "0912" not in soon
    exp = md.split("## Hết hạn hôm nay")[1].split("##")[0]
    assert "#3" in exp and "#4" not in exp
    ovr = md.split("## Override QA hôm nay")[1].split("##")[0]
    assert "mục #6" in ovr and "mục #7" not in ovr
    assert "Người duyệt chưa cấu hình (external-dep)" in md
    assert "BẢN NHÁP — hệ thống không tự gửi" in md


class _Conn:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self

    def fetchone(self):
        return (42,)

    def transaction(self):
        from contextlib import nullcontext
        return nullcontext()

    def commit(self):
        pass


def test_submit_takes_sla_risk_from_config():
    cfg = dr.load_config("sales")
    conn = _Conn()
    with pytest.raises(ValueError):
        dr.submit(conn, "sales", "ad_campaign", "1", "t", "x", "agent:a",
                  cfg=cfg)
    assert conn.calls == []
    assert dr.submit(conn, "sales", "price_change", "SKU-1", "Giảm giá",
                     "Hộp quà Sâm Ngọc Linh", "agent:a5", cfg=cfg) == 42
    params = conn.calls[-1][1]
    spec = cfg["object_types"]["price_change"]
    assert params[2] == "sales" and params[5] == spec["risk"]
    assert params[9] == spec["sla_hours"]


def test_cli_dry_run_no_db(monkeypatch, capsys):
    monkeypatch.setattr(dr, "connect", lambda: pytest.fail("connect gọi"))
    assert dr.main(["--all", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.count("[ok] ") == 11 and "external-dep" in out


def test_cli_db_down_exit_2(monkeypatch, capsys):
    monkeypatch.setattr(dr, "connect", lambda: None)
    assert dr.main(["--block", "sales"]) == 2
    err = capsys.readouterr().err
    assert "không kết nối" in err and "acc_ar --bulletin" not in err


@pytest.mark.parametrize("argv", [["--block", "finance"], ["--all"]])
def test_cli_finance_warns_overwrites_acc_ar_bulletin(monkeypatch, capsys,
                                                      argv):
    # v9.0: director-finance-<ngày>.md dùng chung với acc_ar --bulletin
    monkeypatch.setattr(dr, "connect", lambda: None)
    assert dr.main(argv) == 2
    err = capsys.readouterr().err
    assert "[warn] khối finance" in err and "acc_ar --bulletin" in err


@pytest.mark.parametrize("argv", [[], ["--block", "sales", "--all"],
                                  ["--block", "ke_toan"]])
def test_cli_usage_exit_2(argv):
    with pytest.raises(SystemExit) as e:
        dr.main(argv)
    assert e.value.code == 2


def test_cli_module_dry_run_subprocess():
    # DATABASE_URL rỗng: job_run không ghi job_runs của DB thật từ test
    # (load_dotenv không ghi đè biến đã có).
    env = dict(os.environ, PYTHONIOENCODING="utf-8", DATABASE_URL="")
    r = subprocess.run([sys.executable, "-m", "pipelines.director", "--all",
                        "--dry-run"], cwd=ROOT, env=env, capture_output=True,
                       timeout=60, encoding="utf-8", errors="replace",
                       check=False)
    assert r.returncode == 0 and "11 khối hợp lệ" in r.stdout, r.stderr


def test_ceo_cockpit_object_types():
    """v8.0 W80.8 — khối ceo đủ loại việc cockpit; không người thật."""
    c = dr.load_config("ceo")
    types = c["object_types"]
    assert {"weekly_report", "decision_record", "board_pack",
            "monthly_report", "change_request",
            "price_voucher_frame"} <= set(types)
    assert "content_draft" not in types
    assert all(1 <= t["sla_hours"] <= 720 for t in types.values())
    assert types["monthly_report"] == {"sla_hours": 72, "risk": "medium"}
    assert types["change_request"]["risk"] == "high"
    assert types["price_voucher_frame"]["risk"] == "high"
    assert c["approvers"] == [] and c["digest_recipients"] == []
def test_digest_extra_inserted_before_approvers_default_unchanged():
    """v9.0: `extra` (vd ACC-AR nợ quá hạn) chèn ngay trước "## Người
    duyệt"; không truyền → byte-identical bản cũ (bỏ đúng khối chèn khỏi
    bản có extra phải ra y hệt bản không extra)."""
    cfg = dr.load_config("finance")
    now = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
    items = [_item(1, "pending", now, due=now + timedelta(hours=2))]
    base = dr.digest(cfg, items, now)
    assert dr.digest(cfg, items, now, (), ()) == base
    assert dr.digest(cfg, items, now, extra=[]) == base
    extra = ["## Công nợ đại lý quá hạn (tính tới 12/10/2026)", "",
             "- `DL-01` 1.000đ"]
    md = dr.digest(cfg, items, now, extra=extra)
    block = "\n" + "\n".join(["", *extra])
    assert block in md and md.replace(block, "", 1) == base
    assert md.index("## Công nợ đại lý quá hạn") < md.index("## Người duyệt")
    assert md.index("## Override QA") < md.index("## Công nợ đại lý")



def test_projects_object_types_v83():
    """v8.3 W83.8 — khối projects đủ loại việc 5 agent phòng Dự án; không
    người thật."""
    c = dr.load_config("projects")
    types = c["object_types"]
    assert {"change_request", "program_application", "org_prospect_batch",
            "weekly_board", "milestone_change"} <= set(types)
    assert "content_draft" not in types
    assert all(1 <= t["sla_hours"] <= 720 for t in types.values())
    assert types["change_request"] == {"sla_hours": 48, "risk": "high"}
    assert types["program_application"] == {"sla_hours": 72, "risk": "high"}
    assert types["org_prospect_batch"]["risk"] == "medium"
    assert c["approvers"] == [] and c["digest_recipients"] == []
    assert c["approver_roles"] == ["tgd"]


@pytest.mark.parametrize("argv", [["--block", "ceo"], ["--all"]])
def test_cli_ceo_warns_overwrites_ceo_report_bulletin(monkeypatch, capsys,
                                                      argv):
    # v8.1: director-ceo-<ngày>.md dùng chung với ceo_report --bulletin
    monkeypatch.setattr(dr, "connect", lambda: None)
    assert dr.main(argv) == 2
    err = capsys.readouterr().err
    assert "[warn] khối ceo" in err and "ceo_report --bulletin" in err
