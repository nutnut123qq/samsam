"""Đợt DOCX vòng 2 — marketing-03 (PL01 Marketing "Đề xuất quảng cáo nhỏ cho
sản phẩm được phép; theo dõi chi phí mỗi đơn; đề xuất giữ hay tắt").

Trước sửa: `agents.mkt_ads` chỉ KIỂM phiếu người lập viết sẵn (`--plan`) +
đánh giá kết quả; không có đường agent tự đề xuất. Sau sửa: `--propose`
dựng phiếu từ ô FP&A `DE_XUAT` + creative ĐÃ duyệt + `data/ads_proposal.json`
(chủ khối chốt) → cùng luật chặn `validate_plan`/`submit_plan` + 2 mục hàng
duyệt; chạy lại không nhân bản; tham số chưa chốt → BLOCKED; tính năng tắt →
không ghi. Không gọi nền tảng quảng cáo, không chi tiền.

DB: schema tạm + ROLLBACK (`tests.test_fp_pnl.fpa_conn`), dữ liệu MẪU."""

from datetime import timedelta

import pytest

from agents import mkt_ads as ma
from pipelines import rollout as ro
from tests.test_mkt_ads import (
    ALCOHOL,
    HONEY,
    OCT,
    TODAY,
    _counts,
    _Env,
    db,  # noqa: F401 — fixture
)

PCFG = {"chot_boi": "GĐ Marketing Giả Lập", "can_cu": "biên bản giả test",
        "ty_le_tran": 0.5, "so_ngay_chay": 14, "bat_dau_sau_ngay": 1,
        "success_metric": {"metric": "cpa", "op": "<=", "target": 80000},
        "stop_rules": [{"metric": "cpa", "op": ">=", "value": 150000}]}


def _propose(env, today=TODAY, pcfg=PCFG, **kw):
    return ma.propose(env.tx, month=OCT, cfg=env.cfg, dcfg=env.dcfg,
                      pcfg=pcfg, today=today, **kw)


def test_mkt03_agent_proposes_from_sources(db, monkeypatch):  # noqa: F811
    env = _Env(db, monkeypatch)
    d1 = env.draft()
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)
    assert cap["code"] == "DE_XUAT"
    rows = _propose(env)
    honey = [r for r in rows if (r["sku_key"], r["channel"])
             == (HONEY, "shopee")]
    assert len(honey) == 1 and honey[0]["code"] == "DE_XUAT", rows
    pid = honey[0]["plan_id"]
    p = ma.get_plan(db, pid)
    assert p["created_by"] == ma.PROPOSE_AGENT
    assert p["creative_draft_ids"] == [d1]
    assert p["budget_vnd"] == int(cap["budget_vnd"] * 0.5) <= p["cap_vnd"]
    assert p["start_date"] == TODAY + timedelta(days=1)
    assert "trần FP&A" in p["hypothesis"] and "ads_proposal" in \
        p["hypothesis"]
    items = db.execute("select block, object_type, created_by, status from"
                       " approval_queue where object_id = %s order by id",
                       (f"adtest-{pid}",)).fetchall()
    assert items == [("marketing", "ad_campaign", ma.PROPOSE_AGENT,
                      "pending"),
                     ("finance", "budget_change", ma.BUDGET_AGENT,
                      "pending")]
    # SKU không được phép (rượu, chưa XNQC...) không bao giờ là ứng viên
    assert not {r["sku_key"] for r in rows} & set(ALCOHOL)
    # ô DE_XUAT khác không có creative đã duyệt → THIẾU, không ghi
    for r in rows:
        if r["sku_key"] != HONEY:
            assert r["code"] in ("THIEU_CREATIVE",
                                 "ADS_CREATIVE_UNAPPROVED"), r
            assert r["plan_id"] is None
    # chạy lại (cùng ngày / ngày sau) → không nhân bản
    before = _counts(db)
    for t in (TODAY, TODAY + timedelta(days=1)):
        again = [r for r in _propose(env, today=t) if r["sku_key"] == HONEY
                 and r["channel"] == "shopee"]
        assert again[0]["code"] == "DA_CO" and again[0]["plan_id"] == pid
    assert _counts(db) == before


def test_mkt03_blocked_cases_write_nothing(db, monkeypatch):  # noqa: F811
    env = _Env(db, monkeypatch)
    before = _counts(db)
    # không creative đã duyệt
    rows = [r for r in _propose(env) if r["sku_key"] == HONEY]
    assert rows and all(r["code"] == "THIEU_CREATIVE" for r in rows)
    assert _counts(db) == before
    env.draft()
    # vượt trần: phiếu người lập đã giữ trần → đề xuất 100% trần bị chặn
    cap = ma.cap_for(db, HONEY, "shopee", OCT, env.cfg)["budget_vnd"]
    d2 = env.draft(text="Mật ong sâm 300ml — vị ngọt dịu cho bữa sáng."
                   " #quangcao Nội dung có sử dụng AI")
    plan = {"sku_key": HONEY, "channel": "shopee",
            "hypothesis": "phiếu người lập giữ một phần trần",
            "creative_draft_ids": [d2], "budget_vnd": 1,
            "start_date": TODAY.isoformat(),
            "end_date": (TODAY + timedelta(days=5)).isoformat(),
            "success_metric": PCFG["success_metric"],
            "stop_rules": PCFG["stop_rules"]}
    assert env.submit(plan)["code"] is None
    before = _counts(db)
    full = {**PCFG, "ty_le_tran": 1.0}
    r = next(x for x in _propose(env, pcfg=full) if x["sku_key"] == HONEY
             and x["channel"] == "shopee")
    assert r["code"] == "ADS_OVER_CAP" and cap > 0, r
    assert _counts(db) == before
    # tính năng TẮT → chặn trước mọi ghi
    monkeypatch.setattr(ro, "_FORCE_MODE", "tat")
    with pytest.raises(ro.RolloutBlocked):
        _propose(env)
    assert _counts(db) == before


def test_mkt03_unsettled_policy_blocked(tmp_path, monkeypatch, capsys):
    cfg, why = ma.load_proposal_cfg()               # file repo: chưa chốt
    assert cfg is None and "CHƯA CHỐT" in why
    for bad in ({**PCFG, "chot_boi": "agent:x"}, {**PCFG, "ty_le_tran": 2},
                {**PCFG, "so_ngay_chay": 0}, {**PCFG, "extra": 1}):
        p = tmp_path / "p.json"
        import json
        p.write_text(json.dumps(bad), encoding="utf-8")
        assert ma.load_proposal_cfg(p)[0] is None, bad
    calls = []
    monkeypatch.setattr(ma, "connect", lambda: calls.append(1))
    assert ma.main(["--propose"], today=TODAY) == 2 and calls == []
    assert "[BLOCKED]" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        ma.main(["--propose", "--by", "ai đó"], today=TODAY)
