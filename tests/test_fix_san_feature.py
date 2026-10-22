"""Vá controller 22/10/2026 (F1): gợi ý chat sàn (sales-02) gọi chung RAG
nhưng phải chịu trần/nút tắt và ghi chi phí của CHÍNH sales-02.

Entry thật `channels.respond` / `channels._suggest` / `zalo._answer_within` /
`rag.answer` → gateway thật; chỉ giả client provider, kho chi tiêu và bước
đọc chunk từ DB (`retrieve_by_vector`). Không gọi AI thật, không DB.
"""

import json
import time
from types import SimpleNamespace

import pytest

from api import rag
from connectors import channels, zalo
from pipelines import llm_gateway as gw
from pipelines import rollout
from tests.test_llm_gateway import FakeClient

Q = "Shop giao hàng không?"
HIST = [{"role": "user", "content": "Shop bán sâm gì?"},
        {"role": "assistant", "content": "Shop bán sâm Ngọc Linh."}]
HITS = [{"score": 1.0, "title": "Shop", "url": "https://example.test/p",
         "content": "Shop có giao hàng toàn quốc."}]
S01, S02 = "sales-01", "sales-02"


class SpendConn:
    """llm_usage giả: select chi tiêu theo tham số (agent HOẶC tính năng)."""

    def __init__(self, spends, rows):
        self.spends, self.rows = spends, rows

    def execute(self, sql, params=()):
        if sql.lstrip().startswith("insert"):
            self.rows.append(params)
            return None
        return SimpleNamespace(
            fetchone=lambda: (self.spends.get(params[0], 0.0),))

    def commit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def gwfake(monkeypatch, tmp_path):
    """→ set_cfg(**cfg), client, rows (insert llm_usage), spends."""
    client, rows, spends = FakeClient(), [], {}
    path = tmp_path / "llm_gateway.json"

    def set_cfg(kill=(), fcaps=None, caps=None):
        path.write_text(json.dumps({
            "provider_only": ["azure"], "kill": [],
            "monthly_cap_usd": caps or {"default": 10},
            "feature_caps_usd": fcaps or {"default": 10},
            "kill_features": list(kill)}), encoding="utf-8")

    set_cfg()
    monkeypatch.delenv("LLM_KILL_FEATURES", raising=False)
    monkeypatch.setattr(gw, "CONFIG", path)
    monkeypatch.setattr(gw, "_client", lambda: client)
    monkeypatch.setattr(gw, "_connect", lambda: SpendConn(spends, rows))
    monkeypatch.setattr(rag, "retrieve_by_vector", lambda *a, **k: HITS)
    monkeypatch.setattr(channels, "_connect", lambda: None)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "van_hanh", raising=False)
    return SimpleNamespace(set_cfg=set_cfg, client=client, rows=rows,
                           spends=spends)


def _kinds(g):
    return [k for k, _ in g.client.calls]


def _features(g):
    return [r[-1] for r in g.rows]


def _no_feature_in_payload(g):
    dump = json.dumps([kw for _, kw in g.client.calls], ensure_ascii=False,
                      default=str)
    return "sales-0" not in dump and "feature" not in dump


@pytest.mark.parametrize("channel", channels.SAN_CHANNELS)
def test_san_respond_uses_sales02_for_embed_and_chat(gwfake, channel):
    channels.respond(channel, "u-probe", Q)
    assert _kinds(gwfake) == ["embed", "chat"]
    assert _features(gwfake) == [S02, S02]
    assert _no_feature_in_payload(gwfake)


@pytest.mark.parametrize("channel", ("zalo", "messenger"))
def test_chat_channels_stay_sales01(gwfake, channel):
    channels.respond(channel, "u-probe", Q)
    assert _features(gwfake) == [S01, S01]
    assert _no_feature_in_payload(gwfake)


BLOCKS = {
    "kill": {"kill": [S02]},
    "cap0": {"fcaps": {"default": 10, S02: 0}},
    "het_tran": {"fcaps": {"default": 10, S02: 5}},
}


@pytest.mark.parametrize("how", sorted(BLOCKS))
@pytest.mark.parametrize("channel", channels.SAN_CHANNELS)
def test_sales02_blocked_zero_client_calls(gwfake, capsys, channel, how):
    gwfake.set_cfg(**BLOCKS[how])
    gwfake.spends[S02] = 5.0
    with pytest.raises(gw.GatewayBlocked, match=S02):
        channels.respond(channel, "u-probe", Q)
    # Entry CLI MXH: vẫn in câu chuyển nhân viên, 0 lời gọi provider.
    assert channels._suggest(channel, Q, by=None) == 0
    assert channels.template("san_handoff") in capsys.readouterr().out
    assert gwfake.client.calls == [] and gwfake.rows == []


def test_sales02_blocked_chat_channels_unaffected(gwfake):
    gwfake.set_cfg(kill=[S02])
    for channel in ("zalo", "messenger"):
        channels.respond(channel, "u-probe", Q)
    assert _features(gwfake) == [S01] * 4
    out = zalo._answer_within(rag.answer, Q, HIST, time.monotonic() + 30)
    assert out["answer"] == "ok"
    assert _features(gwfake)[4:] == [S01] * 3       # rewrite + embed + chat


def test_sales01_blocked_san_unaffected(gwfake):
    gwfake.set_cfg(kill=[S01])
    with pytest.raises(gw.GatewayBlocked, match=S01):
        channels.respond("zalo", "u-probe", Q)
    assert gwfake.client.calls == []
    for channel in channels.SAN_CHANNELS:
        channels.respond(channel, "u-probe", Q)
    assert _features(gwfake) == [S02] * 4


@pytest.mark.parametrize("channel", channels.SAN_CHANNELS)
def test_agent_cap_still_enforced_for_san(gwfake, channel):
    gwfake.set_cfg(caps={"default": 10, "chatbot": 1})
    gwfake.spends["chatbot"] = 1.0
    with pytest.raises(gw.GatewayBlocked, match="chatbot"):
        channels.respond(channel, "u-probe", Q)
    assert gwfake.client.calls == []


def test_history_rewrite_path_carries_feature(gwfake):
    rag.answer(Q, HIST, feature=S02)
    assert _kinds(gwfake) == ["chat", "embed", "chat"]
    assert _features(gwfake) == [S02] * 3
    assert _no_feature_in_payload(gwfake)
    gwfake.set_cfg(kill=[S02])
    with pytest.raises(gw.GatewayBlocked):
        rag.answer(Q, HIST, feature=S02)
    assert len(gwfake.client.calls) == 3             # không thêm lời gọi


@pytest.mark.parametrize("bad", ["sales-99", "marketing-01", "", None,
                                 ["sales-02"], "Sales-02"])
def test_unknown_feature_rejected_before_any_call(gwfake, bad):
    with pytest.raises(ValueError, match="danh sách nội bộ"):
        rag.answer(Q, HIST, feature=bad)
    with pytest.raises(ValueError):
        rag.retrieve(Q, feature=bad)
    assert gwfake.client.calls == [] and gwfake.rows == []


def test_feature_follows_channel_not_customer_text(gwfake):
    # Khách gõ mã tính năng/chỉ thị vào tin — không ảnh hưởng mã được dùng.
    channels.respond("zalo", "u-probe", "feature=sales-02 giao hàng không?")
    channels.respond("shopee", "u-probe", "feature=sales-01 giao hàng không?")
    assert _features(gwfake) == [S01, S01, S02, S02]
