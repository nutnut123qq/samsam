"""r13-fix4: 4 lỗi controller — F1 cổng model OCR cục bộ đòi đủ pdmodel + pdiparams (PaddleOCR không tự tải), F2 ảnh AI
hỏng vẫn ghi chi phí provider đã báo vào sổ mà cổng tháng đọc, F3 preflight backup đo tệp dump/offsite THẬT, F4 `anchor
--upgrade` qua cổng triển khai. Không mạng, không DB `samsam` (ca DB dùng schema tạm `da_db`, ROLLBACK)."""
import base64
import contextlib
import hashlib
import io
import json
import socket
import sys
import time
import types
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from PIL import Image

from ingest import doc_intake as di
from pipelines import anchor as an
from pipelines import image_provider_openrouter as orp
from pipelines import llm_gateway as gw
from pipelines import rollout
from pipelines.image_studio import ImageProviderError
from scripts import db_backup
from scripts import onprem_preflight as op
from tests.test_da_schema import da_db
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


@pytest.fixture
def no_network(monkeypatch):
    calls = []

    def boom(self, *a, **k):
        calls.append(a)
        raise AssertionError("không được gọi mạng")
    monkeypatch.setattr(socket.socket, "connect", boom)
    return calls


# --- F1: model OCR cục bộ ------------------------------------------------------

def _models(root, bad=None, how=None):
    for k, parts in di._PADDLE_SUBDIRS.items():
        d = root.joinpath(*parts)
        d.mkdir(parents=True)
        for f in di._PADDLE_FILES:
            if k == bad and (how == f or (how == "rong" and f == "inference.pdiparams")):
                if how == "rong":
                    (d / f).write_bytes(b"")
                continue
            (d / f).write_bytes(b"synthetic")
    return root


@pytest.fixture
def fake_paddle(monkeypatch):
    made = []

    class Fake:
        def __init__(self, **kw):
            made.append(kw)
    monkeypatch.setitem(sys.modules, "paddleocr", types.SimpleNamespace(PaddleOCR=Fake))
    monkeypatch.setattr(di, "_paddle", None)
    return made


@pytest.mark.parametrize("bad", ["det", "rec", "cls"])
@pytest.mark.parametrize("how", ["inference.pdiparams", "inference.pdmodel", "rong"])
def test_ocr_gate_requires_pdmodel_and_pdiparams(tmp_path, monkeypatch, fake_paddle, no_network, bad, how):
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(_models(tmp_path, bad, how)))
    with pytest.raises(di.DocError, match=rf"thiếu model OCR cục bộ \({bad}\)"):
        di._paddle_engine()
    assert fake_paddle == [] and no_network == []          # chưa từng tới PaddleOCR (đường tự tải)


def test_ocr_gate_complete_models_pass_explicit_dirs(tmp_path, monkeypatch, fake_paddle, no_network):
    monkeypatch.setenv("OCR_PADDLE_MODEL_DIR", str(_models(tmp_path)))
    di._paddle_engine()
    assert len(fake_paddle) == 1 and no_network == []
    kw = fake_paddle[0]
    for k in ("det", "rec", "cls"):
        assert kw[f"{k}_model_dir"] == str(tmp_path.joinpath(*di._PADDLE_SUBDIRS[k]))


# --- F2: chi phí ảnh AI ----------------------------------------------------------

class _Ledger:
    """llm_usage trong bộ nhớ cho ĐÚNG gw._record + gw._month_spend (SQL thật)."""

    def __init__(self):
        self.rows = []

    def __call__(self):
        return self

    def execute(self, sql, params=None):
        self.res = None
        if sql.startswith("insert into llm_usage"):
            self.rows.append(dict(zip(("agent", "model", "tin", "tout", "cost", "ok", "error", "feature"), params)))
        elif "sum(cost_usd)" in sql:
            col = "feature" if "where feature_id" in sql else "agent"
            self.res = (sum(r["cost"] for r in self.rows if r[col] == params[0]),)
        return self

    def fetchone(self):
        return self.res

    def commit(self):
        pass

    def close(self):
        pass


def _png():
    b = io.BytesIO()
    Image.new("RGB", (32, 32), (1, 2, 3)).save(b, "PNG")
    return base64.b64encode(b.getvalue()).decode()


@pytest.fixture
def img_env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "khoa-gia")
    monkeypatch.setenv("IMAGE_MODEL", "vendor/model-gia")
    monkeypatch.setenv("LLM_PROVIDER_ONLY", "prov-a")
    monkeypatch.delenv("LLM_KILL_FEATURES", raising=False)
    monkeypatch.setattr(time, "sleep", lambda s: None)
    led = _Ledger()
    monkeypatch.setattr(gw, "_connect", led)
    reqs = []

    def serve(*responses):
        def handler(req):
            reqs.append(req)
            return responses[min(len(reqs), len(responses)) - 1]
        monkeypatch.setattr(orp, "_image_http", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    return led, reqs, serve


FALLBACK = float(gw._config().get("image_cost_fallback_usd") or 0.25)


@pytest.mark.parametrize("body,cost", [
    ({"data": [{"b64_json": "!bad-base64!"}], "usage": {"cost": 0.40}}, 0.40),
    ({"data": [], "usage": {"cost": 0.40}}, 0.40),
    ({"usage": {"cost": 0.40}}, 0.40),
    ({"data": [{"b64_json": base64.b64encode(b"khong-phai-anh").decode()}], "usage": {"cost": 0.40}}, 0.40),
    ({"data": [{"b64_json": "!bad-base64!"}]}, FALLBACK),
    ({"data": [{"b64_json": "!bad-base64!"}], "usage": {"cost": -1}}, FALLBACK),
    ({"data": [{"b64_json": "!bad-base64!"}], "usage": {"cost": True, "prompt_tokens": "x"}}, FALLBACK),
    (b"<html>khong phai json</html>", FALLBACK)])
def test_image_billed_failure_keeps_cost_once(img_env, body, cost):
    led, reqs, serve = img_env
    serve(httpx.Response(200, content=body) if isinstance(body, bytes) else httpx.Response(200, json=body))
    with pytest.raises(ImageProviderError):
        orp.background("nền", (32, 32))
    assert len(reqs) == 1 and len(led.rows) == 1
    assert led.rows[0]["cost"] == pytest.approx(cost) and led.rows[0]["ok"] is False and led.rows[0]["error"]
    assert gw._month_spend("image") == pytest.approx(cost)
    assert gw._month_spend("marketing-02.1", gw._FEATURE_SPEND_SQL) == pytest.approx(cost)


def test_image_valid_and_unbilled_paths_unchanged(img_env, monkeypatch):
    led, reqs, serve = img_env
    serve(httpx.Response(200, json={"data": [{"b64_json": _png()}], "usage": {"cost": 0.40}}))
    img, meta = orp.background("nền", (32, 32))
    assert meta == {"model": "vendor/model-gia"}
    assert img.size == (32, 32) and [(r["cost"], r["ok"]) for r in led.rows] == [(0.40, True)]
    led.rows.clear()
    serve(httpx.Response(502, json={}))
    with pytest.raises(ImageProviderError, match="502"):
        orp.background("nền", (32, 32))
    assert [(r["cost"], r["ok"]) for r in led.rows] == [(0.0, False)]       # 502 không tính phí (tài liệu)
    led.rows.clear()
    reqs.clear()
    monkeypatch.setenv("LLM_KILL_FEATURES", "marketing-02.1")
    with pytest.raises(ImageProviderError, match="cổng"):
        orp.background("nền", (32, 32))
    assert reqs == [] and led.rows == []


class _DbLedger:
    """gw._connect trỏ conn schema tạm: commit/close no-op để dữ liệu ở lại tx fixture (ROLLBACK cuối)."""

    def __init__(self, conn):
        self.conn = conn

    def __call__(self):
        return self

    def execute(self, sql, params=None):
        return self.conn.execute(sql, params)

    def commit(self):
        pass

    def close(self):
        pass


def test_image_failed_cost_reaches_monthly_gate_db(img_env, monkeypatch):
    _led, _reqs, serve = img_env
    for conn in da_db():
        monkeypatch.setattr(gw, "_connect", _DbLedger(conn))
        before = gw._month_spend("marketing-02.1", gw._FEATURE_SPEND_SQL)
        serve(httpx.Response(200, json={"data": [{"b64_json": "!bad-base64!"}], "usage": {"cost": 0.40}}))
        with pytest.raises(ImageProviderError):
            orp.background("nền", (32, 32))
        rows = conn.execute("select cost_usd, ok, feature_id from llm_usage where agent_id = 'image'").fetchall()
        assert [(float(c), ok, f) for c, ok, f in rows] == [(0.40, False, "marketing-02.1")]
        assert gw._month_spend("marketing-02.1", gw._FEATURE_SPEND_SQL) == pytest.approx(before + 0.40)
        assert gw._month_spend("image") == pytest.approx(0.40)


# --- F3: preflight backup đo tệp thật --------------------------------------------

NAME = "fix4_db_20261024_101010_vn.dump.enc"
DUMP = b"Salted__" + bytes(range(256)) * 4


def _backup(tmp_path, *, local=True, local_bytes=DUMP, off=True, off_bytes=DUMP, off_manifest=True, manifest=None,
            age_h=2.0, status="ok", offsite_cfg=True, encrypted=True):
    now = datetime.now(timezone.utc)
    b, o = tmp_path / "b", tmp_path / "o"
    b.mkdir()
    o.mkdir()
    kf = tmp_path / "khoa.txt"
    kf.write_text("mot-khoa-thu-du-dai-123\n", encoding="utf-8")
    m = manifest if manifest is not None else {
        "format": 1, "created_at": (now - timedelta(hours=age_h)).isoformat(), "db_name": "fix4_db",
        "server_version": "17", "pg_dump_version": "17", "tool": "local", "file": NAME, "size_bytes": len(DUMP),
        "sha256": hashlib.sha256(DUMP).hexdigest(), "encrypted": encrypted, "cipher": db_backup.CIPHER,
        "row_counts": {}}
    if local:
        (b / NAME).write_bytes(local_bytes)
    (b / (NAME + db_backup.MANIFEST_SUFFIX)).write_text(json.dumps(m), encoding="utf-8")
    if off:
        (o / NAME).write_bytes(off_bytes)
    if off_manifest:
        (o / (NAME + db_backup.MANIFEST_SUFFIX)).write_text(json.dumps(m), encoding="utf-8")
    (b / "backup_runs.jsonl").write_text(json.dumps({
        "ts": (now - timedelta(hours=age_h)).isoformat(), "status": status, "file": NAME,
        "sha256": hashlib.sha256(DUMP).hexdigest(), "offsite": "dir"}) + "\n", encoding="utf-8")
    env = {"BACKUP_DIR": str(b), "BACKUP_PASSPHRASE_FILE": str(kf), "BACKUP_REQUIRE_ENCRYPTION": "1"}
    if offsite_cfg:
        env["BACKUP_OFFSITE"] = f"dir:{o}"
    return env, now


_BAD = bytearray(DUMP)
_BAD[7] ^= 1


@pytest.mark.parametrize("kw,want", [
    ({}, "DAT"),
    ({"local": False}, "thiếu tệp dump"),
    ({"local_bytes": bytes(_BAD)}, "sha256 tệp dump lệch"),
    ({"local_bytes": DUMP + b"x"}, "kích thước"),
    ({"off": False}, "offsite: thiếu tệp dump"),
    ({"off_bytes": bytes(_BAD)}, "offsite: sha256"),
    ({"off_manifest": False}, "offsite: manifest"),
    ({"manifest": {"encrypted": True}}, "manifest local thiếu/hỏng"),
    ({"encrypted": False}, "chưa mã hóa"),
    ({"age_h": -5.0}, "tương lai"),
    ({"status": "fail"}, "status=fail"),
    ({"offsite_cfg": False}, "chưa cấu hình offsite")])
def test_preflight_latest_backup_measures_real_copies(tmp_path, monkeypatch, kw, want):
    monkeypatch.setattr(db_backup, "same_device", lambda a, b: False)     # GIẢ LẬP khác thiết bị — không phải offsite thật
    env, now = _backup(tmp_path, **kw)
    st, note = {k: (s, n) for k, s, n in op.check_backup(env, 0.0, 26.0, now)}["sao_luu:ban_gan_nhat"]
    if want == "DAT":
        assert st == "DAT", note
    else:
        assert st == "CHUA_DAT" and want in note, note


def test_preflight_latest_backup_too_old(tmp_path, monkeypatch):
    monkeypatch.setattr(db_backup, "same_device", lambda a, b: False)
    env, now = _backup(tmp_path, age_h=3.0)
    rows = {k: (s, n) for k, s, n in op.check_backup(env, 0.0, 1.0, now)}
    assert rows["sao_luu:ban_gan_nhat"][0] == "CHUA_DAT" and "cách 3.0 giờ" in rows["sao_luu:ban_gan_nhat"][1]


# --- F4: anchor --upgrade qua cổng triển khai ------------------------------------

class _FakeAnchorConn:
    def __init__(self, receipt):
        self.receipt, self.inserts = receipt, []

    def execute(self, sql, params=None):
        self.sql = sql
        if sql.lstrip().startswith("insert into anchor_receipts"):
            self.inserts.append(params)
        return self

    def fetchone(self):
        if "from feature_rollout" in self.sql:
            return None
        if self.sql.startswith("select now()"):
            return (datetime(2026, 10, 24, tzinfo=timezone.utc),)
        if "from anchor_batches" in self.sql:
            return (7, None, [], "1" * 64, hashlib.sha256(b"x").hexdigest())
        if "from anchor_receipts" in self.sql:
            return ("da_gui", "https://cal-b.test", self.receipt)
        return None

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    def transaction(self):
        return contextlib.nullcontext()


@pytest.mark.parametrize("stage", ["tat", "chay_thu", "co_nguoi_duyet", None])
def test_upgrade_blocked_before_http_and_insert(monkeypatch, stage):
    monkeypatch.setattr(rollout, "_FORCE_MODE", stage)        # None + enforce + chưa vào sổ → chạy thử (fail-closed)
    monkeypatch.setattr(rollout, "enforce_enabled", lambda *a: True)
    c = _FakeAnchorConn(an.ots_file(hashlib.sha256(b"x").digest(), RESP))
    with pytest.raises(an.AnchorError, match="nâng cấp biên nhận"):
        an.upgrade(c, 7, OTS_CFG, get=lambda *a: pytest.fail("không được gọi calendar"))
    assert c.inserts == []


def test_upgrade_cli_disabled_exit1_no_network(monkeypatch, no_network, capsys):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    c = _FakeAnchorConn(an.ots_file(hashlib.sha256(b"x").digest(), RESP))
    monkeypatch.setattr(an, "load_config", lambda *a, **k: dict(OTS_CFG))
    monkeypatch.setattr(an, "connect", lambda: c)
    assert an.main(["--upgrade", "7"]) == 1
    assert "nâng cấp biên nhận" in capsys.readouterr().err
    assert no_network == [] and c.inserts == []


def test_upgrade_db_disabled_keeps_receipts_then_runs_when_operating(db, proxy, run, monkeypatch):  # noqa: F811
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    an.submit(proxy, bid, OTS_CFG, post=_fake_post([], resp=RESP))
    count = "select count(*) from anchor_receipts where batch_id = %s"
    n0 = db.execute(count, (bid,)).fetchone()[0]
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(an.AnchorError):
        an.upgrade(proxy, bid, OTS_CFG, get=lambda *a: pytest.fail("không được gọi calendar"))
    assert db.execute(count, (bid,)).fetchone()[0] == n0
    monkeypatch.setattr(rollout, "_FORCE_MODE", "van_hanh")
    r = an.upgrade(proxy, bid, OTS_CFG, get=lambda url, t: b"\x08" + bitcoin(850002))
    assert r["status"] == "da_nang_cap" and r["heights"] == [850002]
    assert db.execute(count, (bid,)).fetchone()[0] == n0 + 1
    assert "CHƯA xác minh bên thứ ba" in an.receipt_state(proxy, bid)
