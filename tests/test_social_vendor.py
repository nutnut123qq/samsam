"""v10.3 W103.6 — `ingest.social_vendor` (cổng TGĐ fail-closed).

Config duyệt `true` CHỈ dựng trong `tmp_path` (monkeypatch đường dẫn) —
KHÔNG sửa `data/social_vendor.json` của repo. DB thật: fixture `db` của
`tests/test_market_csv.py` (schema tạm, ROLLBACK). Fixture CSV tổng hợp,
PII giả rõ ràng ("NGUOI DANG GIA", "0900000000", profile.gia).
"""

import json
import re
from pathlib import Path

import pytest

from ingest import social_vendor as sv
from tests import test_market_csv as tmc

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).resolve().parent / "fixtures" / "social_vendor"
EXPORT = FIX / "vendor_export.csv"
OVERLAP = FIX / "vendor_export_overlap.csv"
BAD_COL = FIX / "vendor_bad_column.csv"
BAD_PLAT = FIX / "vendor_bad_platform.csv"
PII_RE = r"NGUOI DANG GIA|0900000000|profile\.gia|nguoidanggia|avatar-gia|" \
         r"post/gia|bai-gia|u10[0-9]"
SALT = "salt-test-v103-0123456789"
_TxConn = tmc._TxConn
db = tmc.db   # fixture DB thật dùng chung (schema tạm + golden, rollback)


def _cfg(tmp_path, body) -> Path:
    p = tmp_path / "social_vendor.json"
    p.write_bytes(body if isinstance(body, bytes)
                  else json.dumps(body).encode("utf-8"))
    return p


APPROVED = {"vendor_approved_by_tgd": True, "approval_ref": "BB-TEST-01",
            "vendor_name": "VENDOR GIA"}


def _guard(monkeypatch):
    calls = []
    monkeypatch.setattr(sv, "_connect",
                        lambda dsn: calls.append("connect") or 1 / 0)
    monkeypatch.setattr(sv, "read_vendor",
                        lambda *a, **k: calls.append("read") or 1 / 0)
    monkeypatch.setattr(sv.ii, "_parse_table",
                        lambda *a, **k: calls.append("parse") or 1 / 0)
    monkeypatch.setattr(sv, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    return calls


def test_repo_config_default_blocked(monkeypatch, capsys):
    raw = (ROOT / "data" / "social_vendor.json").read_text(encoding="utf-8")
    assert '"vendor_approved_by_tgd": false' in raw
    assert "CHỈ người thật" in json.loads(raw)["_doc"]
    calls = _guard(monkeypatch)
    assert sv.main(["--file", str(EXPORT)]) == 2
    assert calls == []
    assert "[blocked] nhà cung cấp chưa được TGĐ duyệt" in \
        capsys.readouterr().out


@pytest.mark.parametrize("body", [
    None, b"{", b"[]",
    {**APPROVED, "vendor_approved_by_tgd": "true"},
    {**APPROVED, "vendor_approved_by_tgd": 1},
    {**APPROVED, "approval_ref": ""},
    {**APPROVED, "approval_ref": "   "},
    {**APPROVED, "approval_ref": None},
    {k: v for k, v in APPROVED.items() if k != "vendor_approved_by_tgd"},
], ids=["thieu-file", "json-hong", "goc-list", "chuoi-true", "so-1",
        "ref-rong", "ref-trang", "ref-null", "thieu-key"])
def test_not_approved_exit2_no_read_no_connect(tmp_path, monkeypatch, capsys,
                                               body):
    cfg = tmp_path / "missing.json" if body is None else _cfg(tmp_path, body)
    monkeypatch.setattr(sv, "CONFIG_FILE", cfg)
    calls = _guard(monkeypatch)
    assert sv.main(["--file", str(EXPORT)]) == 2
    assert calls == [] and "[blocked]" in capsys.readouterr().out


def test_approved_config_passes_gate(tmp_path):
    assert sv.check_approval(_cfg(tmp_path, APPROVED)) is None


def _rules(dpia=False):
    r, errs = sv.ii.load_social_rules(sv.RULES_FILE)
    assert errs == []
    return {**r, "dpia_signed": dpia}


def test_read_vendor_drops_identity_and_labels():
    rows, errs, sha = sv.read_vendor(EXPORT, _rules())
    assert errs == [] and len(rows) == 4 and sha
    blob = json.dumps([{k: v for k, v in r.items() if k != "key"}
                       for r in rows], default=str, ensure_ascii=False)
    assert not re.search(PII_RE, blob)
    by = {r["row_no"]: r for r in rows}
    assert by[2]["sensitive"] is True and "hoi_suc_khoe" in by[2]["labels"]
    assert "hoi_ruou" in by[3]["labels"]
    assert "hoi_gia" in by[4]["labels"]
    assert [r["platform"] for r in rows] == ["facebook", "tiktok", "forum",
                                             "news"]
    assert [r["kind"] for r in rows] == ["comment", "post", "comment",
                                         "review"]
    assert all(r["excerpt"] is None for r in rows)   # DPIA chưa ký


def test_read_vendor_excerpt_only_when_dpia_and_not_sensitive():
    rows, errs, _ = sv.read_vendor(EXPORT, _rules(dpia=True))
    assert errs == []
    by = {r["row_no"]: r for r in rows}
    assert by[2]["excerpt"] is None                     # nhạy cảm
    assert by[4]["excerpt"] and "0900000000" not in by[4]["excerpt"]
    assert all(len(r["excerpt"] or "") <= 200 for r in rows)


@pytest.mark.parametrize("path,needle", [(BAD_COL, "cột lạ"),
                                         (BAD_PLAT, "nen_tang")])
def test_bad_file_exit1_no_connect(tmp_path, monkeypatch, capsys, path,
                                   needle):
    monkeypatch.setattr(sv, "CONFIG_FILE", _cfg(tmp_path, APPROVED))
    calls = []
    monkeypatch.setattr(sv, "_connect",
                        lambda dsn: calls.append("connect") or 1 / 0)
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    assert sv.main(["--file", str(path)]) == 1
    out = capsys.readouterr().out
    assert calls == [] and needle in out and "nguoidanggia" not in out


def test_missing_salt_exit1(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sv, "CONFIG_FILE", _cfg(tmp_path, APPROVED))
    monkeypatch.setattr(sv, "load_dotenv", lambda *a, **k: None)
    calls = []
    monkeypatch.setattr(sv, "_connect",
                        lambda dsn: calls.append("connect") or 1 / 0)
    monkeypatch.setenv("INTEL_HASH_SALT", "short")
    assert sv.main(["--file", str(EXPORT)]) == 1
    assert calls == [] and "INTEL_HASH_SALT" in capsys.readouterr().out


def test_module_never_writes_owned_social_mentions():
    src = (ROOT / "ingest" / "social_vendor.py").read_text(encoding="utf-8")
    assert not re.search(r"insert into social_mentions\b", src)
    assert "insert into social_mentions_vendor" in src


def test_schema_vendor_table_no_identity_columns():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    blk = sql.split("create table if not exists social_mentions_vendor")[1]
    blk = blk.split(");")[0].lower()
    for bad in ("author", "tac_gia", "name", "phone", "sdt", "email", "url",
                "link", "user_id"):
        assert bad not in blk, bad
    tail = sql.split("v10.3 social listening nhà cung cấp")[1].lower()
    assert not re.search(r"^\s*(alter|drop)\s+table", tail, re.MULTILINE)


# ---------------------------------------------------------------- DB thật


def _run(db, monkeypatch, tmp_path, path):
    proxy = _TxConn(db)
    monkeypatch.setattr(sv, "CONFIG_FILE", _cfg(tmp_path, APPROVED))
    monkeypatch.setattr(sv, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(sv, "_connect", lambda _dsn: proxy)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    return sv.main(["--file", str(path)]), proxy.committed


def _n(db, sql, *p):
    return db.execute(sql, p).fetchone()[0]


def test_db_load_no_pii_dedup_skip(db, monkeypatch, tmp_path, capsys):
    owned = _n(db, "select count(*) from social_mentions")
    assert _run(db, monkeypatch, tmp_path, EXPORT) == (0, 1)
    assert _n(db, "select count(*) from social_mentions_vendor") == 4
    assert _n(db, "select count(*) from social_mentions_vendor s where"
                  " row_to_json(s)::text ~* %s", PII_RE) == 0
    assert _n(db, "select count(*) from intel_imports i where"
                  " row_to_json(i)::text ~* %s", PII_RE) == 0
    assert _n(db, "select count(*) from social_mentions_vendor where"
                  " excerpt is not null") == 0
    assert db.execute("select kind, channel, row_count from intel_imports"
                      ).fetchall() == [("social", "vendor", 4)]
    sens = db.execute("select sensitive, labels from social_mentions_vendor"
                      " where platform = 'facebook'").fetchone()
    assert sens[0] is True and "hoi_suc_khoe" in sens[1]
    assert "hoi_ruou" in _n(db, "select labels from social_mentions_vendor"
                                " where platform = 'tiktok'")
    out = capsys.readouterr().out
    assert "new=4 dup=0" in out and not re.search(PII_RE, out)

    assert _run(db, monkeypatch, tmp_path, EXPORT) == (0, 0)
    assert "[skip] file đã nạp" in capsys.readouterr().out
    assert _n(db, "select count(*) from social_mentions_vendor") == 4

    assert _run(db, monkeypatch, tmp_path, OVERLAP) == (0, 1)
    assert "new=1 dup=1" in capsys.readouterr().out
    assert _n(db, "select count(*) from social_mentions_vendor") == 5
    assert _n(db, "select count(*) from social_mentions") == owned


@pytest.mark.parametrize("path", [BAD_COL, BAD_PLAT])
def test_db_bad_file_zero_rows(db, monkeypatch, tmp_path, path):
    assert _run(db, monkeypatch, tmp_path, path) == (1, 0)
    assert _n(db, "select count(*) from social_mentions_vendor") == 0
    assert _n(db, "select count(*) from intel_imports") == 0
