"""v3.1 LLM gateway: PII mask, privacy routing fail-closed, usage/cap/kill,
bộ lọc câu hỏi sức khỏe. Fake client ghi payload — không gọi mạng/DB thật."""
import json
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from api import rag
from pipelines import llm_gateway as gw

ROOT = Path(__file__).resolve().parent.parent
PHONE_RE = re.compile(r"0\d{9}|\+84\d{8,}|0\d{3}[ .]\d{3}[ .]\d{3}")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.\w+")


class FakeClient:
    def __init__(self, fail=False, usage=(10, 5)):
        self.calls = []
        self.fail = fail
        self.usage = SimpleNamespace(prompt_tokens=usage[0],
                                     completion_tokens=usage[1])
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._chat))
        self.embeddings = SimpleNamespace(create=self._embed)

    def _chat(self, **kw):
        self.calls.append(("chat", kw))
        if self.fail:
            raise ConnectionError("provider down")
        return SimpleNamespace(usage=self.usage, choices=[SimpleNamespace(
            message=SimpleNamespace(content="ok"))])

    def _embed(self, **kw):
        self.calls.append(("embed", kw))
        if self.fail:
            raise ConnectionError("provider down")
        n = len(kw["input"]) if isinstance(kw["input"], list) else 1
        return SimpleNamespace(usage=self.usage,
                               data=[SimpleNamespace(embedding=[1.0, 0.0])] * n)


class FakeConn:
    """Ghi insert llm_usage; select spend trả `spend`."""

    def __init__(self, spend=0.0, rows=None):
        self.spend, self.rows = spend, rows if rows is not None else []

    def execute(self, sql, params=()):
        if sql.lstrip().startswith("insert"):
            self.rows.append(params)
            return None
        return SimpleNamespace(fetchone=lambda: (self.spend,))

    def commit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def fake(monkeypatch, tmp_path):
    cfg = {"provider_only": ["azure"],
           "prices_usd_per_1m": {"m": {"in": 1.0, "out": 2.0}},
           "monthly_cap_usd": {"default": 10.0, "chatbot": 1.0}, "kill": []}
    p = tmp_path / "llm_gateway.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", p)
    c = FakeClient()
    monkeypatch.setattr(gw, "_client", lambda: c)
    c.cfg_path = p
    return c


def _dump(calls):
    return json.dumps([kw for _, kw in calls], ensure_ascii=False)


def test_pii_masked_in_all_messages_and_embed(fake):
    pii = "gọi 0901234567 hoặc +84901234567, 0901 234 567, mail a.b@x.vn"
    gw.chat("chatbot", [{"role": "system", "content": "sys " + pii},
                        {"role": "user", "content": "hist " + pii},
                        {"role": "assistant", "content": "ans " + pii},
                        {"role": "user", "content": [{"type": "text",
                                                      "text": "part " + pii}]},
                        {"role": "user", "content": "q " + pii}], model="m")
    gw.embed("ingest", "e " + pii, model="m")
    gw.embed("ingest", ["l1 " + pii, "l2 " + pii], model="m")
    out = _dump(fake.calls)
    assert len(fake.calls) == 3
    assert not PHONE_RE.search(out), out
    assert not EMAIL_RE.search(out), out
    assert "sys" in out and "hist" in out and "part" in out  # nội dung khác giữ


def test_provider_params_exact(fake):
    gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    gw.embed("ingest", "x", model="m")
    for _, kw in fake.calls:
        assert kw["extra_body"] == {"provider": {
            "data_collection": "deny", "zdr": True,
            "allow_fallbacks": False, "only": ["azure"]}}
    assert fake.calls[0][1]["model"] == "m"


def test_empty_whitelist_fail_closed(fake, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER_ONLY", "")
    with pytest.raises(gw.GatewayError):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    with pytest.raises(gw.GatewayError):
        gw.embed("ingest", "x")
    assert fake.calls == []


def test_missing_or_corrupt_config_fail_closed(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(gw, "CONFIG", tmp_path / "nope.json")
    with pytest.raises(gw.GatewayError):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", bad)
    with pytest.raises(gw.GatewayError):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    assert fake.calls == []


def test_provider_error_single_call_and_err_row(fake, monkeypatch):
    rows = []
    monkeypatch.setattr(gw, "_connect", lambda: FakeConn(rows=rows))
    fake.fail = True
    with pytest.raises(gw.GatewayError):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    assert len(fake.calls) == 1
    assert len(rows) == 1 and rows[0][0] == "chatbot" and rows[0][5] is False


def test_real_client_no_sdk_retry(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    c = gw._client()
    assert c.max_retries == 0 and "openrouter.ai" in str(c.base_url)


def test_usage_row_ok(fake, monkeypatch):
    rows = []
    monkeypatch.setattr(gw, "_connect", lambda: FakeConn(rows=rows))
    gw.chat("content", [{"role": "user", "content": "hi"}], model="m")
    agent, model, tin, tout, cost, ok, err = rows[0]
    assert (agent, model, tin, tout, ok, err) == ("content", "m", 10, 5, True, None)
    assert cost == pytest.approx((10 * 1.0 + 5 * 2.0) / 1e6)


def test_unpriced_model_costed_at_max_price_warn(fake, monkeypatch, capsys):
    # Model chưa có giá KHÔNG được ghi 0 (trần tháng sẽ mất tác dụng):
    # tính theo giá cao nhất đã biết trong config.
    rows = []
    monkeypatch.setattr(gw, "_connect", lambda: FakeConn(rows=rows))
    gw.chat("content", [{"role": "user", "content": "hi"}], model="unknown")
    gw.chat("content", [{"role": "user", "content": "hi"}], model="m")
    assert rows[0][4] > 0 and rows[0][4] >= rows[1][4]
    assert "chưa có giá" in capsys.readouterr().out


def test_db_down_does_not_block(fake, monkeypatch, capsys):
    def boom():
        raise OSError("db down")
    monkeypatch.setattr(gw, "_connect", boom)
    r = gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    assert r.choices[0].message.content == "ok" and len(fake.calls) == 1
    out = capsys.readouterr().out
    assert "cho qua" in out and "ghi llm_usage lỗi" in out


def test_dead_host_no_hang(monkeypatch):
    # connect_timeout: host chết -> lỗi trong vài giây, không treo vô hạn.
    env = {"DATABASE_URL": "postgresql://u@10.255.255.1:5432/x",
           "PATH": "", "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")}
    code = ("from pipelines import llm_gateway as g;"
            "print(g._month_spend('chatbot'))")
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                       capture_output=True, timeout=60, check=False)
    assert r.returncode == 0 and b"None" in r.stdout


def test_kill_switch_config_and_env(fake, monkeypatch):
    cfg = json.loads(fake.cfg_path.read_text(encoding="utf-8"))
    cfg["kill"] = ["content"]
    fake.cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("content", [{"role": "user", "content": "hi"}])
    monkeypatch.setenv("LLM_KILL", "chatbot, ingest")
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    with pytest.raises(gw.GatewayBlocked):
        gw.embed("ingest", "x")
    assert fake.calls == []
    gw.chat("other", [{"role": "user", "content": "hi"}], model="m")
    assert len(fake.calls) == 1  # agent khác không bị ảnh hưởng


def test_cap_100_blocks_80_warns_other_agent_ok(fake, monkeypatch, capsys):
    spend = {"chatbot": 1.0}
    monkeypatch.setattr(gw, "_month_spend", lambda a: spend.get(a, 0.0))
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    assert fake.calls == []
    gw.chat("content", [{"role": "user", "content": "hi"}], model="m")
    assert len(fake.calls) == 1
    spend["chatbot"] = 0.8
    capsys.readouterr()
    gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    assert len(fake.calls) == 2 and ">=80%" in capsys.readouterr().out


def test_cap_reads_spend_from_db(fake, monkeypatch):
    monkeypatch.setattr(gw, "_connect", lambda: FakeConn(spend=1.5))
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("chatbot", [{"role": "user", "content": "hi"}])
    assert fake.calls == []


def test_invalid_agent_id(fake):
    for bad in ("", "Chat Bot", "x" * 65, None):
        with pytest.raises(gw.GatewayError):
            gw.chat(bad, [{"role": "user", "content": "hi"}])
    assert fake.calls == []


@pytest.mark.parametrize("q", [
    "bị gout uống Savigout được không",
    "bi gout uong thuoc duoc khong",
    "Sâm có dùng được cho người tiểu đường không?",
    "Saphraton chữa được ung thư không?",
    "dang mang bau co uong duoc khong",
    "BỊ GOUT",
    "con tôi bị ho uống được không",
    "dạo này men gan cao",
])
def test_health_question_hits(q):
    assert gw.is_health_question(q)


def test_health_question_nfd_input():
    nfd = __import__("unicodedata").normalize("NFD", "tôi bị tiểu đường")
    assert gw.is_health_question(nfd)


@pytest.mark.parametrize("q", [
    "sâm Ngọc Linh giá bao nhiêu",
    "Sâm Sâm có showroom ở đâu?",
    "sản phẩm này thuộc loại nào",
    "giá trị của sâm",
    "Saphraton giá bao nhiêu?",
    "o dau ban sam",
    "regout xyz",
    "Giao hàng ở Ho Chi Minh mất mấy ngày",
    "giao gan Da Nang khong",
])
def test_health_question_misses(q):
    assert not gw.is_health_question(q)


def test_rag_health_question_no_llm_call(fake, monkeypatch):
    monkeypatch.setattr(rag, "retrieve", lambda q: pytest.fail("retrieve"))
    r = rag.answer("bị gout uống Savigout được không",
                   history=[{"role": "user", "content": "chào"}])
    assert r == {"answer": rag.NO_DATA, "sources": [], "handoff": "health"}
    r = rag.answer("bi gout uong thuoc duoc khong")
    assert r["handoff"] == "health"
    assert fake.calls == []


def test_zalo_health_question_gets_handoff(fake, monkeypatch):
    from connectors import zalo
    sent = {}
    monkeypatch.setattr(zalo, "CONV_LOG", fake.cfg_path.parent / "c.jsonl")
    monkeypatch.setattr(zalo, "send_text", lambda u, t: sent.update(t=t) or True)
    monkeypatch.setattr(zalo, "_histories", type(zalo._histories)())
    zalo.handle_text("u1", "bị gout uống Savigout được không")
    # FLIP v5.1: câu sức khỏe chặn ở connectors.channels.pre_route TRƯỚC
    # answer() → template sức khỏe (hỏi ý kiến bác sĩ + chuyển người), không
    # còn HANDOFF_TEXT chung; vẫn 0 lời gọi LLM. 2 assert giữ nguyên số.
    from connectors import channels
    assert sent["t"] == channels.template("health")
    assert fake.calls == []


def test_zalo_gateway_blocked_gets_handoff_not_error(fake, monkeypatch):
    # Kill-switch/vượt trần là chặn có chủ đích -> khách được chuyển người,
    # không nhận ERROR_FALLBACK "hệ thống lỗi".
    from connectors import zalo
    sent = {}
    monkeypatch.setattr(zalo, "CONV_LOG", fake.cfg_path.parent / "c.jsonl")
    monkeypatch.setattr(zalo, "send_text", lambda u, t: sent.update(t=t) or True)
    monkeypatch.setattr(zalo, "_histories", type(zalo._histories)())
    monkeypatch.setenv("LLM_KILL", "chatbot")
    zalo.handle_text("u1", "Sâm Sâm có showroom ở đâu?")
    assert sent["t"] == zalo.HANDOFF_TEXT
    assert fake.calls == []


def test_no_openai_constructor_outside_gateway():
    hits = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*.py")
            if ".venv" not in p.parts and "venv" not in p.parts
            and p.name not in ("llm_gateway.py", "test_llm_gateway.py")
            and "OpenAI(" in p.read_text(encoding="utf-8", errors="replace")]
    assert hits == []


def test_zalo_reexports_same_mask():
    from connectors.zalo import _mask_pii
    from pipelines.pii import _mask_pii as m
    assert _mask_pii is m


def test_pii_allow_keeps_company_contact_only(fake):
    cfg = json.loads(fake.cfg_path.read_text(encoding="utf-8"))
    cfg["pii_allow"] = ["0235 3699 899", "vnsamsam@gmail.com"]
    fake.cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    gw.chat("chatbot", [{"role": "system", "content":
                         "Hotline: 0235.3699.899 / VNsamsam@gmail.com"},
                        {"role": "user", "content":
                         "tôi 0901234567, a@b.vn, 0235 3699 899 123"
                         " \x00j\x00 \x00a\x00"}], model="m")
    msgs = fake.calls[0][1]["messages"]
    assert "0235.3699.899" in msgs[0]["content"]
    assert "VNsamsam@gmail.com" in msgs[0]["content"]
    u = msgs[1]["content"]
    assert "0901234567" not in u and "a@b.vn" not in u
    assert "3699" not in u          # số dài hơn allow -> vẫn mask trọn
    assert "\x00" not in u          # NUL user gõ bị bỏ, không crash


def test_default_config_routing_and_allow():
    cfg = gw._config()
    assert cfg["provider_only"] and gw._allow(cfg)


def test_local_only_agent_ck_mat_blocked_before_config(fake, monkeypatch, tmp_path):
    # v9.5: luồng MẬT CK-A1 không bao giờ ra mạng — chặn TRƯỚC config/DB/
    # client; không config/env nào gỡ được.
    assert "ck_mat" in gw.LOCAL_ONLY_AGENTS
    n = {"client": 0, "connect": 0, "spend": 0, "record": 0}

    def _count(key, ret=None):
        def f(*a, **k):
            n[key] += 1
            return ret
        return f
    monkeypatch.setattr(gw, "_client", _count("client", fake))
    monkeypatch.setattr(gw, "_connect", _count("connect"))
    monkeypatch.setattr(gw, "_month_spend", _count("spend"))
    monkeypatch.setattr(gw, "_record", _count("record"))
    monkeypatch.setenv("LLM_PROVIDER_ONLY", "azure")
    monkeypatch.setenv("LLM_CAP_DEFAULT_USD", "1000")
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("ck_mat", [{"role": "user", "content": "tủ điện"}], model="m")
    with pytest.raises(gw.GatewayBlocked):
        gw.embed("ck_mat", ["trang 1"], model="m")
    # config hỏng vẫn ra GatewayBlocked (kiểm trước _config()).
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", bad)
    with pytest.raises(gw.GatewayBlocked):
        gw.chat("ck_mat", [{"role": "user", "content": "x"}])
    assert n == {"client": 0, "connect": 0, "spend": 0, "record": 0}
    assert fake.calls == []
    # agent khác không đổi hành vi.
    monkeypatch.setattr(gw, "CONFIG", fake.cfg_path)
    gw.chat("chatbot", [{"role": "user", "content": "hi"}], model="m")
    assert len(fake.calls) == 1 and n["client"] == 1
