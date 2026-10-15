"""v9.1 W91.4 — FP-OpsCost (`agents.fp_opscost`): chi phí AI theo agent +
cloud/SaaS nhập tay so trần tháng (cảnh báo 80%/100%), khoản > ngưỡng X chỉ
"được chi" khi TGĐ ký.

Thuần: biên cảnh báo (số nguyên, đúng ≤1 cảnh báo/scope), `spend_status`
fail-closed. DB thật: schema tạm + rollback (fixture `db` của
tests/test_fp_pnl.py). `opex_MAU.csv` + `users` trong test là MẪU.
"""

import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

from agents import fp_opscost as fo
from agents import fp_pnl as fp
from pipelines import approval_queue as aq
from pipelines import auth
from tests.test_fp_pnl import _TxConn, fpa_conn

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def db():
    yield from fpa_conn()


FIX = Path(__file__).resolve().parent / "fixtures" / "finance"
OPEX = FIX / "opex_MAU.csv"
OCT = date(2026, 10, 1)
VN = timezone(timedelta(hours=7))
HDR = "month,category,service,amount_vnd,doc_ref\n"


def _cfg(**over):
    base = {"usd_vnd": 25000, "budget_vnd": {"ai:content": 5_000_000},
            "warn_pct": 80, "stop_pct": 100, "threshold_x_vnd": 5_000_000}
    base.update(over)
    return base


def _alerts(spent, cfg=None):
    cfg = cfg or _cfg()
    return fo.budget_alerts({"ai:content": spent}, cfg["budget_vnd"],
                            cfg["warn_pct"], cfg["stop_pct"])


# ---------- thuần ----------

@pytest.mark.parametrize("spent,levels", [
    (3_999_999, []), (4_000_000, [80]), (4_100_000, [80]),
    (4_999_999, [80]), (5_000_000, [100]), (5_050_000, [100]), (0, [])])
def test_alert_boundaries_one_per_scope(spent, levels):
    al = _alerts(spent)
    assert [a["level"] for a in al] == levels
    if levels:
        assert al[0]["label"] == ("VƯỢT TRẦN" if levels == [100]
                                  else "CẢNH BÁO")


def test_warn_pct_read_from_cfg_and_usd_conversion():
    assert _alerts(4_000_000, _cfg(warn_pct=90)) == []
    assert [a["level"] for a in _alerts(4_500_000, _cfg(warn_pct=90))] == \
        [90]
    # 159.99996 USD × 25.000 = 3.999.999đ (half-up) → chưa tới 80%
    assert fo.ai_vnd(Decimal("159.99996"), 25000) == 3_999_999
    assert fo.ai_vnd(160, 25000) == 4_000_000
    assert fo.ai_vnd(0.1, 3) == 0 and fo.ai_vnd("0.5", 1) == 1
    acts = fo.actuals({"content": Decimal(160), "chatbot": Decimal(1)},
                      [{"category": "cloud", "amount_vnd": 7},
                       {"category": "saas", "amount_vnd": 5}], 25000)
    assert acts["ai:content"] == 4_000_000 and acts["ai"] == 4_025_000
    assert acts["tong"] == 4_025_012 and acts["ads"] == 0
    # scope không có trần → không cảnh báo; liệt kê "chưa có trần"
    assert fo.budget_alerts(acts, {}, 80, 100) == []
    text = fo.render_report(OCT, acts, _cfg(), [], [])
    assert "`ai:chatbot` | 25.000đ | chưa có trần" in text


X = 5_000_000
# Khoản MẪU > X: khóa tự nhiên = sha file + số dòng (id chỉ để hiển thị).
E7 = {"id": 7, "file_sha256": "a" * 64, "row_no": 5, "month": OCT,
      "category": "saas", "service": "misa-amis", "amount_vnd": X + 1}


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _it(status="approved", lane="per_item", by="tgd@samsam.test",
        oid=None, ot="opex_over_x", entry=E7, block="finance",
        creator=fo.CREATED_BY, signed=None, qid=1):
    """Mục hàng duyệt cho `entry`; `signed` = khoản mà payload mô tả (mặc
    định chính `entry`)."""
    return {"id": qid, "object_type": ot,
            "object_id": oid or fo.opex_key(entry), "block": block,
            "created_by": creator,
            "content_sha256": _sha(fo.render_over_x(signed or entry)),
            "status": status, "lane": lane, "decided_by": by}


USERS = {"tgd@samsam.test": {"role": "tgd"},
         "banhang@samsam.test": {"role": "gd_ban_hang"}}


def test_spend_status_fail_closed():
    x = X
    assert fo.spend_status({**E7, "amount_vnd": x}, [], {}, x) == \
        "trong_nguong"
    e = E7
    assert fo.spend_status(e, [], USERS, x) == "cho_tgd_ky"
    assert fo.spend_status(e, [_it(by="banhang@samsam.test")], USERS, x) == \
        "cho_tgd_ky"
    assert fo.spend_status(e, [_it(by="  TGD@SamSam.test ")], USERS, x) == \
        "duoc_chi"
    assert fo.spend_status(e, [_it()], {}, x) == "cho_tgd_ky"
    assert fo.spend_status(e, [_it(lane="auto_policy")], USERS, x) == \
        "cho_tgd_ky"
    for st in ("rejected", "expired", "pending"):
        assert fo.spend_status(e, [_it(status=st)], USERS, x) == "cho_tgd_ky"
    assert fo.spend_status(e, [_it(oid="opex-8")], USERS, x) == "cho_tgd_ky"
    assert fo.spend_status(e, [_it(ot="budget_change")], USERS, x) == \
        "cho_tgd_ky"
    assert fo.spend_status(e, [_it(by=None)], USERS, x) == "cho_tgd_ky"


def test_signature_bound_to_natural_key_and_content():
    """Chữ ký TGĐ gắn khóa tự nhiên + nội dung, không gắn id tự tăng; mục
    khác khối / agent khác / payload khác KHÔNG bao giờ cho `duoc_chi`."""
    x = X
    ok = [_it()]
    assert fo.spend_status(E7, ok, USERS, x) == "duoc_chi"
    # dựng lại DB: cùng khoản (sha file + dòng) nhưng id mới → vẫn được chi
    assert fo.spend_status({**E7, "id": 99}, ok, USERS, x) == "duoc_chi"
    # id 7 sau restore trỏ sang khoản KHÁC (dòng khác / file khác) → chờ ký
    for other in ({**E7, "row_no": 6}, {**E7, "file_sha256": "b" * 64}):
        assert fo.spend_status(other, ok, USERS, x) == "cho_tgd_ky"
    # cùng khóa nhưng nội dung khoản đổi (số tiền/dịch vụ/tháng) → ký lại
    for changed in ({**E7, "amount_vnd": 500_000_000},
                    {**E7, "service": "aws"},
                    {**E7, "month": date(2026, 11, 1)}):
        assert fo.spend_status(changed, ok, USERS, x) == "cho_tgd_ky"
    # đổi ngưỡng X không làm mất chữ ký (X không nằm trong payload)
    assert fo.spend_status(E7, ok, USERS, 1_000_000) == "duoc_chi"
    # probe A08: khoản thật 500tr, mục do agent khác / khối khác / payload
    # ghi số nhỏ, TGĐ ký theo payload đó → KHÔNG được chi
    big = {**E7, "amount_vnd": 500_000_000}
    small = {**E7, "amount_vnd": 5_100_000}
    for forged in (_it(entry=big, signed=small),
                   _it(entry=big, block="marketing"),
                   _it(entry=big, creator="agent:other"),
                   _it(entry=big, block="marketing", creator="agent:other",
                       signed=small)):
        assert fo.verdict(big, [forged], USERS, x) == ("cho_tgd_ky",
                                                       "chua_co")
    assert fo.spend_status(big, [_it(entry=big)], USERS, x) == "duoc_chi"


def test_verdict_reasons():
    x = X
    other = _it(by="banhang@samsam.test")
    assert fo.verdict(E7, [], USERS, x) == ("cho_tgd_ky", "chua_co")
    assert fo.verdict(E7, [other], USERS, x) == ("cho_tgd_ky",
                                                 "khac_vai_tro")
    assert fo.verdict(E7, [_it(lane="auto_policy")], USERS, x)[1] == \
        "khac_vai_tro"
    assert fo.verdict(E7, [other, _it(status="pending", qid=2)], USERS,
                      x) == ("cho_tgd_ky", "cho_ky")
    assert fo.verdict(E7, [other, _it(qid=2)], USERS, x) == ("duoc_chi",
                                                            "tgd_ky")
    forged = _it(status="pending", creator="agent:other")
    assert fo.verdict(E7, [forged], USERS, x) == ("cho_tgd_ky", "bi_chan")
    assert fo.verdict(E7, [_it(status="rejected")], USERS, x)[1] == \
        "chua_co"
    assert set(fo.WHY) == {"tgd_ky", "cho_ky", "khac_vai_tro", "bi_chan",
                           "chua_co"}


def test_read_opex_fixture_and_errors(tmp_path):
    es, errs, sha = fo.read_opex(OPEX)
    assert errs == [] and len(es) == 7 and re.fullmatch(r"[0-9a-f]{64}", sha)
    assert es[0] == {"row_no": 2, "month": OCT, "category": "cloud",
                     "service": "supabase-db", "amount_vnd": 2_500_000,
                     "doc_ref": "HD-MAU-001"}
    p = tmp_path / "bad.csv"
    p.write_bytes((HDR + "2026-10,cloud,aws,-5000,X1\n"
                   "2026-10,luong,aws,5000,\n"
                   "2026-13,cloud,my svc,0,\n").encode("utf-8"))
    es, errs, _ = fo.read_opex(p)
    assert es == [] and len(errs) == 5
    assert errs[0] == ("dòng 2: field 'amount_vnd' phải là số nguyên VND > "
                       "0")
    assert "dòng 3: field 'category'" in errs[1]
    assert {e.split("'")[1] for e in errs[2:]} == {"month", "service",
                                                   "amount_vnd"}
    assert not any("-5000" in e or "luong" in e or "my svc" in e
                   for e in errs)
    p.write_bytes(b"month,category,service,amount_vnd,ten_nguoi\n")
    assert "cột lạ" in fo.read_opex(p)[1][0]


def test_cfg_validation(tmp_path):
    raw = json.loads((ROOT / "data" / "fpa_config.json").read_text(
        encoding="utf-8"))
    cfg, why = fo.load_cfg()
    assert why is None and cfg["warn_pct"] == 80 and cfg["stop_pct"] == 100
    for mut, needle in (({"usd_vnd": 0}, "usd_vnd"),
                        ({"usd_vnd": True}, "usd_vnd"),
                        ({"budget_vnd": {"lazada": 1}}, "scope lạ"),
                        ({"budget_vnd": {"ai:content": 0}}, "phải int > 0"),
                        ({"warn_pct": 100}, "warn < stop"),
                        ({"threshold_x_vnd": -1}, "threshold_x_vnd")):
        doc = json.loads(json.dumps(raw))
        doc["opscost"].update(mut)
        p = tmp_path / "c.json"
        p.write_text(json.dumps(doc), encoding="utf-8")
        cfg, why = fo.load_cfg(p)
        assert cfg is None and needle in why, (mut, why)


def test_module_no_network_or_gateway():
    src = (ROOT / "agents" / "fp_opscost.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|httpx|requests|urllib|llm_gateway|openai",
                         src)


def _no_connect(monkeypatch):
    calls = []
    monkeypatch.setattr(fo, "connect", lambda: calls.append(1))
    return calls


@pytest.mark.parametrize("argv", [
    ["--report", "--status", "--month", "2026-10"], ["--report"],
    ["--report", "--month", "2026-13"], ["--load", "x.csv", "--month",
                                         "2026-10"], []])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = _no_connect(monkeypatch)
    with pytest.raises(SystemExit) as e:
        fo.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_bad_file_or_cfg_exit1_zero_connect(monkeypatch, tmp_path,
                                                 capsys):
    calls = _no_connect(monkeypatch)
    p = tmp_path / "bad.csv"
    p.write_bytes((HDR + "2026-10,cloud,aws,-5000,\n2026-10,khac2,aws,5,\n")
                  .encode("utf-8"))
    assert fo.main(["--load", str(p)]) == 1
    assert "không connect, không nạp gì" in capsys.readouterr().out
    bad = tmp_path / "c.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", bad)
    assert fo.main(["--report", "--month", "2026-10"]) == 1
    assert calls == []


# ---------- DB thật ----------

def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(fo, "connect", lambda: _TxConn(db))
    return fo.main(list(argv))


def _usage(db, agent, usd, ts):
    db.execute("insert into llm_usage (ts, agent_id, model, cost_usd, ok)"
               " values (%s, %s, 'test/mau', %s, true)", (ts, agent, usd))


@pytest.fixture
def setup(db, monkeypatch, tmp_path):
    # Session UTC: biên tháng phải là giờ VN tường minh (period_bounds), không
    # dựa timezone của session — mốc ngày naive/UTC sẽ lệch 2 dòng bên dưới.
    db.execute("set local timezone = 'UTC'")
    raw = json.loads((ROOT / "data" / "fpa_config.json").read_text(
        encoding="utf-8"))
    raw["opscost"]["budget_vnd"] = {"ai:content": 5_000_000,
                                    "ai:chatbot": 2_000_000,
                                    "cloud": 4_000_000, "saas": 7_000_000,
                                    "ads": 20_000_000}
    cfgp = tmp_path / "fpa.json"
    cfgp.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(fp, "CONFIG_FILE", cfgp)
    users = tmp_path / "users.json"
    users.write_text(json.dumps({
        "tgd@samsam.test": {"role": "tgd"},
        "banhang@samsam.test": {"role": "gd_ban_hang"}}), encoding="utf-8")
    monkeypatch.setattr(fo, "load_users", lambda: auth.load_users(users))
    _usage(db, "content", Decimal(120), datetime(2026, 10, 3, 9, tzinfo=VN))
    # 03:00 01/10 giờ VN = 20:00 30/09 UTC: tháng 10 theo giờ VN → TÍNH
    # (biên UTC/naive bỏ dòng này → content 3.000.000đ = 60%, mất mức 80)
    _usage(db, "content", Decimal(40), datetime(2026, 10, 1, 3, tzinfo=VN))
    _usage(db, "chatbot", Decimal(64), datetime(2026, 10, 31, 23, 59,
                                                  tzinfo=VN))
    # 03:00 01/11 giờ VN = 20:00 31/10 UTC: tháng 11 theo giờ VN → KHÔNG
    # tính (biên UTC/naive tính → chatbot 2.000.000đ = 100%, lật 80 → 100)
    _usage(db, "chatbot", Decimal(16), datetime(2026, 11, 1, 3, tzinfo=VN))
    # 23:30 30/09 giờ VN = tháng 9 → không tính (nếu tính: content 100%)
    _usage(db, "content", Decimal(100), datetime(2026, 9, 30, 23, 30,
                                                   tzinfo=VN))
    return db


def _items(db):
    return db.execute("select id, object_id, risk, status, block from"
                      " approval_queue where object_type = 'opex_over_x'"
                      " order by id").fetchall()


def test_db_report_load_submit_status(setup, monkeypatch, capsys):
    db = setup
    assert _cli(db, monkeypatch, "--load", str(OPEX)) == 0
    assert _cli(db, monkeypatch, "--load", str(OPEX)) == 0
    assert "[skip]" in capsys.readouterr().out
    assert db.execute("select count(*) from opex_entries").fetchone()[0] == 7

    assert _cli(db, monkeypatch, "--report", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert "[CẢNH BÁO 80%] `ai:content`: 4.000.000đ / trần 5.000.000đ" in out
    assert "[CẢNH BÁO 80%] `ai:chatbot`: 1.600.000đ / trần 2.000.000đ" in out
    assert "[CẢNH BÁO 80%] `cloud`: 3.300.000đ" in out
    assert "[VƯỢT TRẦN 100%] `saas`: 7.200.000đ" in out
    assert "`ads`" in out and "[CẢNH BÁO 80%] `ads`" not in out
    assert out.count("[CẢNH BÁO") + out.count("[VƯỢT TRẦN") == 4
    assert "`ai` | 5.600.000đ | chưa có trần" in out
    assert "HD-MAU" not in out

    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    items = _items(db)
    ents = {e["service"]: e for e in fo.fetch_opex(db, OCT)}
    ids = {s: e["id"] for s, e in ents.items()}
    keys = {s: fo.opex_key(e) for s, e in ents.items()}
    assert sorted(i[1] for i in items) == sorted(
        keys[s] for s in ("misa-amis", "shopee-ads"))
    # object_id = khóa tự nhiên (sha file + dòng), không id tự tăng
    sha = fo.read_opex(OPEX)[2]
    assert keys["misa-amis"] == f"opex-{sha[:16]}-5"
    assert {(i[2], i[3], i[4]) for i in items} == {("high", "pending",
                                                    "finance")}
    assert db.execute("select bool_and(guardrail->>'ok' = 'true') from"
                      " approval_queue").fetchone()[0] is True
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    assert "0 mục mới" in capsys.readouterr().out and len(_items(db)) == 2
    # auto_policy đã ký vẫn không duyệt được (risk high) → chờ TGĐ
    db.execute("insert into auto_policies (id, object_type, max_risk,"
               " enabled, signed_by, signed_at) values ('opex_auto',"
               " 'opex_over_x', 'low', true, 'Chu Khoi Gia Lap (test)',"
               " now())")
    q = {oid: qid for qid, oid, *_ in _items(db)}
    misa, ads = q[keys["misa-amis"]], q[keys["shopee-ads"]]
    assert aq.auto_approve(_TxConn(db), misa)[0] is False
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert out.count("cho_tgd_ky") == 2 and "duoc_chi" not in out
    # người không phải TGĐ duyệt → vẫn chờ; TGĐ duyệt → được chi
    assert aq.decide(_TxConn(db), misa, "banhang@samsam.test",
                     "approved") == (True, None)
    assert aq.decide(_TxConn(db), ads, " TGD@samsam.test ",
                     "approved") == (True, None)
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert f"khoản #{ids['misa-amis']} saas/misa-amis 6.000.000đ: cho_tgd_ky"\
        in out
    assert (f"khoản #{ids['shopee-ads']} ads/shopee-ads 12.000.000đ: "
            "duoc_chi") in out
    assert f"cho_tgd_ky — {fo.WHY['khac_vai_tro']}" in out
    # users rỗng (file thiếu) → không ai là TGĐ → fail-closed
    real_users = fo.load_users
    monkeypatch.setattr(fo, "load_users", dict)
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    assert "duoc_chi" not in capsys.readouterr().out
    monkeypatch.setattr(fo, "load_users", real_users)
    # misa đã approved bởi vai trò KHÁC → không kẹt: submit đẩy 1 mục pending
    # MỚI cho misa; ads đã có chữ ký TGĐ → không đẩy lại
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert f"[submit] khoản #{ids['misa-amis']} →" in out and "1 mục mới" in out
    items = _items(db)
    assert len(items) == 3
    new = [qid for qid, oid, _r, st, _b in items
           if oid == keys["misa-amis"] and st == "pending"]
    assert len(new) == 1 and new[0] != misa
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    assert f"cho_tgd_ky — {fo.WHY['cho_ky']}" in capsys.readouterr().out
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    assert "0 mục mới" in capsys.readouterr().out and len(_items(db)) == 3
    # TGĐ duyệt mục mới → misa được chi qua hệ thống
    assert aq.decide(_TxConn(db), new[0], "tgd@samsam.test", "approved") == \
        (True, None)
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert out.count("duoc_chi") == 2 and "cho_tgd_ky" not in out
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    assert "0 mục mới" in capsys.readouterr().out and len(_items(db)) == 3


def test_db_forged_item_never_counts(setup, monkeypatch, capsys):
    """Agent khác (role agent_writer gọi enqueue_item tự do) giả mục
    `opex_over_x` cho đúng khóa của khoản, khối finance + created_by của
    fp_opscost, payload ghi số NHỎ; TGĐ ký theo payload đó → khoản thật vẫn
    `cho_tgd_ky`. Mục giả còn pending → `--submit-over-x` báo [chặn]."""
    db = setup
    assert _cli(db, monkeypatch, "--load", str(OPEX)) == 0
    misa = next(e for e in fo.fetch_opex(db, OCT)
                if e["service"] == "misa-amis")
    fake = aq.enqueue(_TxConn(db), object_type="opex_over_x",
                      object_id=fo.opex_key(misa), block="finance",
                      title="giả", payload=fo.render_over_x(
                          {**misa, "amount_vnd": 5_100_000}),
                      risk="high", created_by=fo.CREATED_BY, sla_hours=72)
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    out = capsys.readouterr().out
    assert f"[chặn] khoản #{misa['id']}: {fo.WHY['bi_chan']}" in out
    assert "1 mục mới" in out           # chỉ shopee-ads
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    assert f"6.000.000đ: cho_tgd_ky — {fo.WHY['bi_chan']}" in \
        capsys.readouterr().out
    # TGĐ ký mục giả → khoản thật vẫn không được chi
    assert aq.decide(_TxConn(db), fake, "tgd@samsam.test", "approved") == \
        (True, None)
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    assert f"6.000.000đ: cho_tgd_ky — {fo.WHY['chua_co']}" in \
        capsys.readouterr().out
    # hết chặn → đẩy mục thật; TGĐ ký đúng mục → được chi
    assert _cli(db, monkeypatch, "--submit-over-x", "--month", "2026-10") == 0
    assert f"[submit] khoản #{misa['id']} →" in capsys.readouterr().out
    real = db.execute("select id from approval_queue where object_id = %s"
                      " and status = 'pending'",
                      (fo.opex_key(misa),)).fetchone()[0]
    assert aq.decide(_TxConn(db), real, "tgd@samsam.test", "approved") == \
        (True, None)
    assert _cli(db, monkeypatch, "--status", "--month", "2026-10") == 0
    assert "6.000.000đ: duoc_chi" in capsys.readouterr().out
