"""V1.3 — test nhánh chính của scripts/zalo_preflight.py.

Mock env dict + httpx.get (getoa) + connectors.zalo.refresh_access_token;
token store isolate vào tmp_path — không động data/ thật, không gọi
network ngoài."""
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import zalo_preflight as pf

import connectors


class _Resp:
    """Response giả cho httpx.get — chỉ cần json()."""
    status_code = 200

    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    """TOKEN_FILE trỏ tmp_path — test không đọc/ghi data/zalo_tokens.json
    thật (precedent _isolated_files trong test_zalo.py)."""
    monkeypatch.setattr(pf, "TOKEN_FILE", tmp_path / "zalo_tokens.json")


def _by_name(results):
    return {r["name"]: r for r in results}


def test_env_deploy_missing_fail():
    """DEPLOY=1 + thiếu mọi ZALO_* -> env FAIL liệt kê đúng mục thiếu;
    token check cũng FAIL (không token nào) -> script exit 1."""
    res = _by_name(pf.run_checks({"DEPLOY": "1"}))
    assert res["env"]["status"] == "FAIL"
    for k in ("ZALO_OA_SECRET", "ZALO_APP_ID", "ZALO_APP_SECRET",
              "DATABASE_URL", "OPENROUTER_API_KEY"):
        assert k in res["env"]["detail"]
    assert "ZALO_ACCESS_TOKEN|(" in res["env"]["detail"]
    assert res["token"]["status"] == "FAIL"


def test_env_dev_missing_is_skip_not_fail():
    """DEPLOY tắt + thiếu env -> SKIP (dev hợp lệ), không FAIL."""
    res = _by_name(pf.run_checks({"DEPLOY": "0"}))
    assert res["env"]["status"] == "SKIP"
    assert "ZALO_OA_SECRET" in res["env"]["detail"]
    # openrouter thiếu ở dev cũng chỉ SKIP
    assert res["openrouter"]["status"] == "SKIP"


def test_env_deploy_store_tokens_satisfy_send_path(tmp_path):
    """DEPLOY + env thiếu token nhưng token store có sẵn (mirror
    _startup_error: store là source-of-truth) -> env không FAIL vì
    đường send (reviewer minor: bản cũ chỉ đọc env -> false-FAIL trên
    máy deploy đã có store hợp lệ)."""
    store = tmp_path / "zalo_tokens.json"
    store.write_text(json.dumps(
        {"access_token": "t", "refresh_token": "rt",
         "expires_at": time.time() + 3600}), encoding="utf-8")
    env = {"DEPLOY": "1", "ZALO_OA_SECRET": "s",
           "DATABASE_URL": "x", "OPENROUTER_API_KEY": "k"}
    res = pf.check_env(env)
    assert res["status"] == "PASS"
    assert "không có bộ refresh" in res["detail"]


def test_env_deploy_full_passes(monkeypatch):
    """DEPLOY=1 đủ env -> env PASS (db/token tự FAIL/SKIP theo nhánh,
    không quan tâm ở test này)."""
    monkeypatch.setattr(pf.httpx, "get",
                        lambda *a, **k: _Resp({"error": 0}))
    env = {"DEPLOY": "yes", "ZALO_OA_SECRET": "s", "ZALO_APP_ID": "a",
           "ZALO_APP_SECRET": "x", "ZALO_REFRESH_TOKEN": "rt",
           "DATABASE_URL": "", "OPENROUTER_API_KEY": "k"}
    # DATABASE_URL rỗng -> env FAIL đúng mục db-side; đặt dsn giả thì
    # check_db connect thật — để env PASS phải có non-empty.
    env["DATABASE_URL"] = "postgresql://localhost/x"
    res = _by_name(pf.run_checks(env))
    assert res["env"]["status"] == "PASS"


def test_token_getoa_ok(monkeypatch):
    """access_token env + getoa error=0 -> token PASS."""
    monkeypatch.setattr(pf.httpx, "get",
                        lambda *a, **k: _Resp({"error": 0}))
    res = _by_name(pf.run_checks({"ZALO_ACCESS_TOKEN": "tok"}))
    assert res["token"]["status"] == "PASS"


def test_token_invalid_with_refresh_skips(monkeypatch):
    """getoa error!=0 + có refresh_token, không --refresh -> SKIP
    'sẽ refresh khi chạy'."""
    monkeypatch.setattr(pf.httpx, "get",
                        lambda *a, **k: _Resp({"error": -216}))
    env = {"ZALO_ACCESS_TOKEN": "old", "ZALO_REFRESH_TOKEN": "rt"}
    res = _by_name(pf.run_checks(env))
    assert res["token"]["status"] == "SKIP"
    assert "refresh" in res["token"]["detail"]


def test_token_refresh_flag_impl_missing_skips(monkeypatch):
    """--refresh nhưng connectors.zalo chưa có refresh_access_token
    (V1.1 chưa merge) -> SKIP, không crash."""
    monkeypatch.setattr(pf.httpx, "get",
                        lambda *a, **k: _Resp({"error": -216}))
    monkeypatch.setattr(connectors, "zalo", SimpleNamespace(),
                        raising=False)
    env = {"ZALO_ACCESS_TOKEN": "old", "ZALO_REFRESH_TOKEN": "rt"}
    res = _by_name(pf.run_checks(env, refresh=True))
    assert res["token"]["status"] == "SKIP"
    assert "refresh_access_token" in res["token"]["detail"]


def test_token_refresh_success_rechecks_getoa(monkeypatch, tmp_path):
    """--refresh + token cũ đã chết: refresh_access_token() viết store
    mới -> getoa với token mới ok -> PASS. M1: --refresh đi thẳng vào
    refresh, không getoa trên token cũ trước."""
    store = tmp_path / "zalo_tokens.json"
    calls = []

    def fake_get(url, headers=None, timeout=None):
        tok = (headers or {}).get("access_token")
        calls.append(tok)
        return _Resp({"error": 0} if tok == "new-tok"
                     else {"error": -216})

    def fake_refresh():
        store.write_text(json.dumps(
            {"access_token": "new-tok", "refresh_token": "rt2",
             "expires_at": time.time() + 3600}), encoding="utf-8")
        return True

    monkeypatch.setattr(pf.httpx, "get", fake_get)
    monkeypatch.setattr(
        connectors, "zalo",
        SimpleNamespace(refresh_access_token=fake_refresh),
        raising=False)
    env = {"ZALO_ACCESS_TOKEN": "old-tok", "ZALO_REFRESH_TOKEN": "rt"}
    res = _by_name(pf.run_checks(env, refresh=True))
    assert res["token"]["status"] == "PASS"
    assert calls == ["new-tok"]  # getoa chỉ sau refresh, trên token mới


def test_token_alive_forced_refresh(monkeypatch, tmp_path):
    """--refresh ép rotation kể cả khi access còn sống (reviewer M1):
    store có token valid + getoa error=0 nhưng refresh=True vẫn gọi
    refresh_access_token rồi getoa lại chỉ trên token mới."""
    store = tmp_path / "zalo_tokens.json"
    store.write_text(json.dumps(
        {"access_token": "old-tok", "refresh_token": "rt",
         "expires_at": time.time() + 3600}), encoding="utf-8")
    refresh_calls, getoa_calls = [], []

    def fake_get(url, headers=None, timeout=None):
        getoa_calls.append((headers or {}).get("access_token"))
        return _Resp({"error": 0})

    def fake_refresh():
        refresh_calls.append(1)
        store.write_text(json.dumps(
            {"access_token": "new-tok", "refresh_token": "rt2",
             "expires_at": time.time() + 3600}), encoding="utf-8")
        return True

    monkeypatch.setattr(pf.httpx, "get", fake_get)
    monkeypatch.setattr(
        connectors, "zalo",
        SimpleNamespace(refresh_access_token=fake_refresh),
        raising=False)
    env = {"ZALO_ACCESS_TOKEN": "old-tok", "ZALO_REFRESH_TOKEN": "rt"}
    res = _by_name(pf.run_checks(env, refresh=True))
    assert res["token"]["status"] == "PASS"
    assert refresh_calls == [1]          # refresh CHẠY dù token cũ sống
    assert getoa_calls == ["new-tok"]    # getoa chỉ trên token mới


def test_signature_roundtrip_with_oa_secret(monkeypatch):
    """ZALO_OA_SECRET set -> tự ký + verify_signature thật -> PASS."""
    res = _by_name(pf.run_checks({"ZALO_OA_SECRET": "s3cret"}))
    assert res["signature"]["status"] == "PASS"


def test_signature_no_secret_skips():
    res = _by_name(pf.run_checks({}))
    assert res["signature"]["status"] == "SKIP"
    assert "event live" in res["signature"]["detail"]
