"""Fixture chung: không test nào chạm DB thật qua LLM gateway (llm_usage)
— `_connect` -> None (spend không đọc được = cho qua; ghi usage bỏ qua).
Test gateway cần DB tự monkeypatch lại `_connect` bằng fake conn.
v4.2: xóa env lớp LLM-check/red-team — test không bao giờ gọi LLM thật dù
máy dev có đặt GUARDRAIL_LLM_MODEL/REDTEAM_MODEL."""
import pytest

from pipelines import llm_gateway


@pytest.fixture(autouse=True)
def _no_gateway_db(monkeypatch):
    monkeypatch.setattr(llm_gateway, "_connect", lambda: None)
    monkeypatch.delenv("LLM_KILL", raising=False)
    monkeypatch.delenv("LLM_PROVIDER_ONLY", raising=False)
    monkeypatch.delenv("LLM_CAP_DEFAULT_USD", raising=False)
    for k in ("GUARDRAIL_LLM_MODEL", "GUARDRAIL_LLM_TIMEOUT", "REDTEAM_MODEL"):
        monkeypatch.delenv(k, raising=False)
