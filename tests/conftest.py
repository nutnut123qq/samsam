"""Fixture chung: không test nào chạm DB thật qua LLM gateway (llm_usage)
— `_connect` -> conn GIẢ: chi tiêu tháng đọc được = 0, ghi usage bị bỏ.
v13.1: gateway FAIL-CLOSED khi không đọc được chi tiêu (trước đây `_connect`
-> None = "cho qua"), nên fixture trả conn đọc-được thay vì None để test cũ
giữ hành vi "trong trần". Test cần DB down/trần tự monkeypatch `_connect`/
`_month_spend`.
v4.2: xóa env lớp LLM-check/red-team — test không bao giờ gọi LLM thật dù
máy dev có đặt GUARDRAIL_LLM_MODEL/REDTEAM_MODEL."""
import pytest

from pipelines import llm_gateway


class _ZeroSpendConn:
    """llm_usage giả: SELECT chi tiêu -> 0; INSERT bỏ qua."""

    def execute(self, sql, params=()):
        return _Row()

    def commit(self):
        pass

    def close(self):
        pass


class _Row:
    def fetchone(self):
        return (0,)


@pytest.fixture(autouse=True)
def _no_gateway_db(monkeypatch):
    monkeypatch.setattr(llm_gateway, "_connect", _ZeroSpendConn)
    monkeypatch.delenv("LLM_KILL", raising=False)
    monkeypatch.delenv("LLM_PROVIDER_ONLY", raising=False)
    monkeypatch.delenv("LLM_CAP_DEFAULT_USD", raising=False)
    for k in ("GUARDRAIL_LLM_MODEL", "GUARDRAIL_LLM_TIMEOUT", "REDTEAM_MODEL"):
        monkeypatch.delenv(k, raising=False)
    # v5.1: không muối lớp kênh → zalo._reply KHÔNG đọc/ghi DB thật
    # (chat_consents/approval_queue) dù .env máy dev có CHANNEL_HASH_SALT;
    # test cần muối tự setenv.
    monkeypatch.delenv("CHANNEL_HASH_SALT", raising=False)
