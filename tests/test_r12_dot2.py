"""r12 đợt 2 — hồi quy cho D1/P052/L5, G1-L1, RB, GATE-OUT, L3.

Bản probe đầy đủ (DB Docker thật, CLI thật) ở
`evidence/itacc_r12/harness/probe_dot2.py.txt`; ở đây khóa phần không cần DB:
tính năng TẮT → exit 2 + `[rollout] <mã>`, không đầu ra, không lời gọi AI;
chatbot chỉ hứa "nhân viên sẽ phản hồi" khi ĐÃ ghi được `cskh_handoff`.
"""
from datetime import date

import pytest

from pipelines import rollout

PROMISE = ("nhân viên sẽ", "sẽ liên hệ", "sẽ phản hồi")


@pytest.fixture
def tat(monkeypatch):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")


def _blocked(rc, out, fid):
    return rc == rollout.EXIT_BLOCKED and "[rollout]" in out and fid in out


# ------------------------------------------------------------ rollout API

def test_blocked_and_cli_entry(tat, capsys):
    why = rollout.blocked(None, "x", fid="sales-07.3")
    assert why and "sales-07.3" in why
    assert rollout.blocked(None, "x", fid=None) is None   # ngoài danh mục

    @rollout.cli_entry
    def main():
        rollout.check_generate(None, "finance-04.1", "P&L")
    assert main() == rollout.EXIT_BLOCKED
    assert "[rollout]" in capsys.readouterr().out


def test_blocked_none_when_running(monkeypatch):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")
    assert rollout.blocked(None, "x", fid="sales-07.3") is None


# ------------------------------------------------------------ D1 gateway

def test_gateway_blocks_feature_off(tat, monkeypatch):
    from pipelines import llm_gateway
    calls = []
    monkeypatch.setattr(llm_gateway, "_client",
                        lambda *a, **k: calls.append(1))
    cfg = llm_gateway.load_config() if hasattr(llm_gateway, "load_config") \
        else None
    with pytest.raises(llm_gateway.GatewayBlocked, match="TẮT"):
        llm_gateway._gate_feature(cfg or {"kill_features": []},
                                  "marketing-02.2")
    assert calls == []


# ------------------------------------------------------------ RB / GATE-OUT

def test_seo_web_off_no_report(tat, tmp_path, capsys):
    from agents import seo_web
    rc = seo_web.main(["--from-crawl", "--submit", "--out-dir", str(tmp_path)])
    assert _blocked(rc, capsys.readouterr().out, "marketing-06.1")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("argv,fid", [
    (["--jd", "nv_van_hanh_san"], "legal_hr-06.1"),
])
def test_pc_hr_off(tat, capsys, argv, fid):
    from agents import pc_hr
    assert _blocked(pc_hr.main(argv), capsys.readouterr().out, fid)


def test_kd_forecast_off_prints_nothing(tat, capsys):
    from agents import kd_forecast
    rc = kd_forecast.main(["--write"])
    out = capsys.readouterr().out
    assert _blocked(rc, out, "sales-07.3")
    assert len(out.strip().splitlines()) == 1


def test_fp_cash_off_prints_no_forecast(tat, tmp_path, capsys):
    from agents import fp_cash
    rc = fp_cash.main(["--forecast", "--start", "2026-10-26",
                       "--out-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert _blocked(rc, out, "finance-05.2")
    assert len(out.strip().splitlines()) == 1 and not list(tmp_path.iterdir())


def test_ceo_risk_off_no_report(tat, tmp_path, capsys):
    from agents import ceo_risk
    rc = ceo_risk.main(["--report", "--now", "2026-10-24T10:00:00+07:00",
                        "--out-dir", str(tmp_path)])
    assert _blocked(rc, capsys.readouterr().out, "ceo-03")
    assert list(tmp_path.iterdir()) == []


def test_ceo_audit_both_off_no_file(tat, tmp_path, capsys):
    from agents import ceo_audit
    rc = ceo_audit.main(["--report", "--now", "2026-10-24T10:00:00+07:00",
                         "--out-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert _blocked(rc, out, "ceo-04.3") and "ceo-04.4" in out
    assert list(tmp_path.iterdir()) == []


# ------------------------------------------------------------ G1-L1 bản tin SX

TEXT = ("# Bản tin Sản xuất tuần — 2026-10-23\n\n## Thiếu hàng theo mốc chốt\n"
        "- A\n\n## Hàng cận hạn (FEFO)\n- L1 · sku · HSD\n\n"
        "## Tiến độ kế hoạch sản xuất\n- P1\n")


def test_split_fefo():
    from pipelines.production import split_fefo
    bantin, canhan = split_fefo(TEXT)
    assert "Thiếu hàng" in bantin and "Tiến độ" in bantin
    assert "Hàng cận hạn" not in bantin
    assert "L1" in canhan and "Thiếu hàng" not in canhan \
        and "Tiến độ" not in canhan
    assert split_fefo("# T\nx\n") == ("# T\nx\n", "")


@pytest.mark.parametrize("skip,want", [
    ({"bantin"}, ["sx-canhan-2026-10-23.md"]),
    ({"canhan"}, ["sx-bantin-tuan-2026-10-23.md"]),
])
def test_write_bulletin_skips_only_blocked(monkeypatch, tmp_path, skip, want):
    from pipelines import production as pr
    rc = pr._write_bulletin(TEXT, {"sample": True}, tmp_path,
                            date(2026, 10, 23), "week", skip=skip)
    assert rc == 0 and sorted(p.name for p in tmp_path.iterdir()) == want


# ------------------------------------------------------------ L3 chatbot

@pytest.fixture
def chat(monkeypatch, tmp_path):
    from api import rag
    from connectors import zalo
    monkeypatch.setenv("DEPLOY", "1")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conv.jsonl")
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "seen.db")
    monkeypatch.setattr(rag, "answer",
                        lambda *a, **k: {"answer": rag.NO_DATA, "sources": []})
    monkeypatch.setattr("pipelines.guardrail.check", lambda t: {"ok": True})

    def turn(q, recorded):
        monkeypatch.setattr("connectors.channels.record_handoff",
                            lambda *a, **k: 5 if recorded else None)
        out = []
        r = zalo._reply_turn("u-r12", q, "m1",
                             send=lambda u, t: out.append(t) or True)
        assert out == [r["text"]]
        return r["text"]
    return turn


@pytest.mark.parametrize("q", ["Hũ 300ml giá bao nhiêu?",
                               "Uống sâm có chữa tiểu đường không?",
                               "Rượu sâm giá bao nhiêu?"])
def test_no_promise_without_handoff(chat, q):
    text = chat(q, recorded=False)
    assert not any(p in text.lower() for p in PROMISE)
    assert "1800577732" in text


@pytest.mark.parametrize("q", ["Hũ 300ml giá bao nhiêu?",
                               "Uống sâm có chữa tiểu đường không?"])
def test_promise_when_handoff_recorded(chat, q):
    assert any(p in chat(q, recorded=True).lower() for p in PROMISE)


@pytest.mark.parametrize("md", ["tat", "chay_thu"])
def test_held_no_promise_without_handoff(chat, monkeypatch, md):
    monkeypatch.setattr("connectors.channels.chatbot_mode", lambda: md)
    text = chat("Hũ 300ml còn hàng không?", recorded=False)
    assert not any(p in text.lower() for p in PROMISE)
    assert "1800577732" in text
    assert any(p in chat("Hũ 300ml còn hàng không?", recorded=True).lower()
               for p in PROMISE)


def test_record_handoff_swallows_rollout_blocked(monkeypatch):
    from connectors import channels
    from pipelines import director

    class _C:
        def close(self):
            pass

    monkeypatch.setenv("CHANNEL_HASH_SALT", "muoi-test-r12-0000000001")
    monkeypatch.setattr(channels, "_connect", _C)

    def boom(*a, **k):
        raise rollout.RolloutBlocked("sales-01 tắt")
    monkeypatch.setattr(director, "submit", boom)
    inb = channels.normalize("zalo", "u1", "xin chào")
    assert channels.record_handoff(inb, "rollout", "m1") is None
