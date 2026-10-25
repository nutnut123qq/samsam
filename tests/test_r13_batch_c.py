"""r13 đợt C: gói so sánh bản sao sự cố (ceo-90/N22, `scripts/incident_compare.py`), preflight on-prem + bắt buộc mã hóa/
offsite khác thiết bị (data_platform-90, `scripts/onprem_preflight.py`, `scripts/db_backup.py`). Không DB `samsam`."""
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from scripts import db_backup
from scripts import incident_compare as ic
from scripts import onprem_preflight as op


@pytest.fixture
def no_connect(monkeypatch):
    calls = []
    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: calls.append(a) or pytest.fail("không được kết nối"))
    return calls


def test_incident_missing_inputs_unverified(monkeypatch, capsys, no_connect):
    monkeypatch.delenv("INCIDENT_BASELINE_URL", raising=False)
    monkeypatch.setenv("INCIDENT_NOW_URL", "host=127.0.0.1 dbname=ban_sao_hien_tai user=x")
    assert ic.main([]) == 2
    assert "UNVERIFIED" in capsys.readouterr().err and no_connect == []


@pytest.mark.parametrize("dsn", ["postgresql://u:p@127.0.0.1:5432/samsam", "host=127.0.0.1 dbname=SAMSAM user=u",
                                 "host=127.0.0.1 user=u"])
def test_incident_refuses_real_db_or_implicit_dbname(monkeypatch, capsys, no_connect, dsn):
    monkeypatch.setenv("INCIDENT_BASELINE_URL", "host=127.0.0.1 dbname=ban_sao_truoc user=x")
    monkeypatch.setenv("INCIDENT_NOW_URL", dsn)
    assert ic.main([]) == 2
    assert "[từ chối]" in capsys.readouterr().err and no_connect == []


def _snap(**over):
    s = {"tables": ["job_runs"], "cols": {"job_runs": {"id": ("bigint", "NO")}}, "stats": {"job_runs": (3, "3", None)},
         "window": {"job_runs": 0}, "chain": 0, "grants": {("bang", "svc_job", "job_runs", "INSERT")},
         "roles": {"svc_job": (False,) * 6}, "members": set()}
    s.update(over)
    return s


def test_incident_compare_reports_names_and_counts_only():
    assert ic.compare(_snap(), _snap()) == []
    diff = ic.compare(_snap(), _snap(stats={"job_runs": (4, "4", None)}, window={"job_runs": 1},
                                     grants={("bang", "svc_job", "job_runs", "INSERT"),
                                             ("bang", "public", "job_runs", "DELETE")}, chain=2))
    text = "\n".join(diff)
    assert "job_runs" in text and "khung sự cố" in text and "verify_action_log" in text and "public" in text


def test_incident_same_db_two_handles_no_diff(monkeypatch, capsys):
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("cần DB test (DATABASE_URL) — chế độ unit")
    monkeypatch.setenv("INCIDENT_BASELINE_URL", dsn)
    sep = " " if "://" not in dsn else ("&" if "?" in dsn else "?")
    monkeypatch.setenv("INCIDENT_NOW_URL", dsn + sep + "application_name=r13_now")
    rc = ic.main([])
    out = capsys.readouterr().out
    assert rc in (0, 1) and "Khác biệt:" in out           # 1 nếu DB test có dòng trong khung sự cố
    assert "@" not in out and "password" not in out.lower()


# ---------------------------------------------------------------- db_backup + preflight

def test_backup_require_encryption_and_other_device(tmp_path, monkeypatch, capsys):
    env = {"BACKUP_DIR": str(tmp_path / "b"), "BACKUP_REQUIRE_ENCRYPTION": "1"}
    with pytest.raises(db_backup.UsageError, match="BACKUP_REQUIRE_ENCRYPTION"):
        db_backup.read_config(env)
    env = {"BACKUP_DIR": str(tmp_path / "b"), "BACKUP_OFFSITE": f"dir:{tmp_path / 'o'}"}
    db_backup.read_config(env)
    assert "cùng thiết bị" in capsys.readouterr().out
    env["BACKUP_OFFSITE_REQUIRE_OTHER_DEVICE"] = "1"
    with pytest.raises(db_backup.UsageError, match="cùng thiết bị"):
        db_backup.read_config(env)


def test_preflight_nothing_configured_not_ready(monkeypatch, capsys, no_connect):
    for k in list(os.environ):
        if k.endswith("DATABASE_URL") or k.startswith(("BACKUP_", "PG")):
            monkeypatch.delenv(k)
    assert op.main([]) == 1
    out = capsys.readouterr().out
    assert "CHƯA SẴN SÀNG" in out and "CHUA_XAC_NHAN" in out and no_connect == []


def test_preflight_backup_checks_measure_real_files(tmp_path):
    passf = tmp_path / "khoa.txt"
    passf.write_text("mot-khoa-thu-du-dai-123\n", encoding="utf-8")
    bdir = tmp_path / "b"
    bdir.mkdir()
    env = {"BACKUP_DIR": str(bdir), "BACKUP_PASSPHRASE_FILE": str(passf), "BACKUP_REQUIRE_ENCRYPTION": "1",
           "BACKUP_OFFSITE": f"dir:{tmp_path / 'o'}"}
    now = datetime.now(timezone.utc)
    rows = {k: st for k, st, _n in op.check_backup(env, 0.0, 26.0, now)}
    assert rows["sao_luu:ma_hoa_bat_buoc"] == "DAT"
    assert rows["sao_luu:offsite"] == "CHUA_DAT"                  # cùng thiết bị tmp
    assert rows["sao_luu:ban_gan_nhat"] == "CHUA_DAT"             # chưa có bản nào
    (bdir / "x.dump.enc").write_bytes(b"x")
    (bdir / ("x.dump.enc" + db_backup.MANIFEST_SUFFIX)).write_text(json.dumps({"encrypted": True}), encoding="utf-8")
    rec = {"ts": (now - timedelta(hours=2)).isoformat(), "status": "ok", "file": "x.dump.enc", "offsite": {"dir": "o"}}
    (bdir / "backup_runs.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    rows = {k: st for k, st, _n in op.check_backup(env, 0.0, 26.0, now)}
    # r13-fix4 F3: sổ + manifest tối giản + dump giả KHÔNG đủ — phải có cặp dump/manifest thật ở cả local lẫn offsite.
    assert rows["sao_luu:ban_gan_nhat"] == "CHUA_DAT"
    name, dump = "db_20261024_080000_vn.dump.enc", b"Salted__" + bytes(64)
    man = {"format": 1, "created_at": (now - timedelta(hours=2)).isoformat(), "db_name": "db", "server_version": "17",
           "pg_dump_version": "17", "tool": "local", "file": name, "size_bytes": len(dump),
           "sha256": hashlib.sha256(dump).hexdigest(), "encrypted": True, "cipher": db_backup.CIPHER, "row_counts": {}}
    (tmp_path / "o").mkdir()
    for folder in (bdir, tmp_path / "o"):
        (folder / name).write_bytes(dump)
        (folder / (name + db_backup.MANIFEST_SUFFIX)).write_text(json.dumps(man), encoding="utf-8")
    rec.update(file=name, offsite="dir")
    (bdir / "backup_runs.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    rows = {k: st for k, st, _n in op.check_backup(env, 0.0, 26.0, now)}
    assert rows["sao_luu:ban_gan_nhat"] == "DAT"
    rows = {k: st for k, st, _n in op.check_backup(env, 0.0, 1.0, now)}
    assert rows["sao_luu:ban_gan_nhat"] == "CHUA_DAT"             # quá tuổi
