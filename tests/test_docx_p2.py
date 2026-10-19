"""Đợt DOCX P2 — bản tin sức khỏe (data_platform-07.1) đi qua `write_report`.

Lỗi trước sửa (nền 667f763): `scripts/health_bulletin.py` ghi
`health-<ngày>.md` thẳng ra đĩa — tính năng TẮT vẫn sinh + gửi, bản chạy thử
không mang nhãn "CHẠY THỬ — KHÔNG GỬI", không ghi sổ `report_outputs` nên
data_platform-07.1 không bao giờ đếm được đầu ra (HĐ 6.7, PL02 mục 1)."""

import importlib

import pytest

from pipelines import rollout

hb = importlib.import_module("scripts.health_bulletin")


@pytest.fixture
def quiet(monkeypatch):
    sent = []
    monkeypatch.setattr(hb, "gather", lambda: {"db_ok": False,
                                               "db_error": "test"})
    monkeypatch.setattr(hb, "notify", lambda text, env=None: sent.append(text))
    return sent


def test_p2_health_off_writes_and_sends_nothing(quiet, monkeypatch, tmp_path):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    rc = hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-19",
                  "--notify"])
    assert rc == 2 and quiet == []
    assert not (tmp_path / "health-2026-10-19.md").exists()


def test_p2_health_trial_labeled_and_sent_labeled(quiet, monkeypatch,
                                                 tmp_path):
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")
    rc = hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-19",
                  "--notify"])
    md = (tmp_path / "health-2026-10-19.md").read_text(encoding="utf-8")
    assert rc == 0 and md.startswith("> **CHẠY THỬ — KHÔNG GỬI.**")
    assert quiet == [md]


def test_p2_health_records_report_output(monkeypatch, tmp_path, quiet):
    """Sổ đầu ra: `write_report` → `record_report(name, text, False)`."""
    seen = []
    monkeypatch.setattr(rollout, "_FORCE_MODE", None)
    monkeypatch.setattr(rollout, "report_stage",
                        lambda name: ("data_platform-07.1", "van_hanh"))
    monkeypatch.setattr(rollout, "record_report",
                        lambda name, text, sample=None: seen.append(
                            (name, sample)) or True)
    assert hb.main(["--out-dir", str(tmp_path), "--date", "2026-10-19"]) == 0
    assert seen == [("health-2026-10-19.md", False)]


# ------------------------------------------- báo cáo trước đây chỉ stdout

@pytest.fixture
def trial(monkeypatch):
    """Giai đoạn chạy thử (không DB): write_report gắn nhãn, không ghi sổ."""
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu")


def test_p2_report_prefixes_registered():
    want = {"intel-doithu-": "intel-03", "intel-trend-": "intel-04.1",
            "sx-bantin-": "production-01", "sx-canhan-": "production-04.2",
            "kich-ban-": "intel-06", "dong-tien-": "finance-05.2",
            "hd-mau-": "legal_hr-05.1"}
    for pre, fid in want.items():
        assert rollout.feature_for_report(pre + "x.md") == fid, pre


def test_p2_contract_check_writes_counted_report(trial, tmp_path):
    cc = importlib.import_module("scripts.contract_check")
    f = tmp_path / "hd.txt"
    f.write_text("Hợp đồng KOC mẫu — điều khoản chung.", encoding="utf-8")
    out = tmp_path / "rep"
    rc = cc.main(["--kind", "koc", "--file", str(f), "--out-dir", str(out)])
    files = list(out.glob("hd-mau-koc-*.md"))
    assert rc == 1 and len(files) == 1          # thiếu điều khoản → exit 1
    body = files[0].read_text(encoding="utf-8")
    assert body.startswith("> **CHẠY THỬ") and "Hợp đồng KOC mẫu" not in body


def test_p2_scenario_writes_counted_report(trial, tmp_path):
    from pipelines import scenario
    rc = scenario.main(["--sku", "savina-12v", "--channel", "shopee",
                        "--weeks", "2", "--start", "2026-11-02",
                        "--out-dir", str(tmp_path)])
    assert rc == 0
    assert (tmp_path / "kich-ban-savina-12v-shopee-2026-11-02.md").exists()
    with pytest.raises(SystemExit):
        scenario.main(["--sku", "savina-12v", "--channel", "shopee",
                       "--json", "--out-dir", str(tmp_path)])


def test_p2_scenario_off_blocks(monkeypatch, tmp_path):
    from pipelines import scenario
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    assert scenario.main(["--sku", "savina-12v", "--channel", "shopee",
                          "--weeks", "2", "--out-dir", str(tmp_path)]) == 1
    assert list(tmp_path.iterdir()) == []


def test_p2_production_bulletin_splits_fefo(trial, tmp_path):
    from datetime import date

    from pipelines import production as pr
    text = ("# Bản tin Sản xuất tháng — 2026-10-01\n\nx\n\n"
            "## Hàng cận hạn (FEFO)\n- L1 · sku · HSD\n")
    assert pr._write_bulletin(text, {"sample": True}, tmp_path,
                              date(2026, 10, 1), "month") == 0
    full = (tmp_path / "sx-bantin-thang-2026-10-01.md").read_text("utf-8")
    fefo = (tmp_path / "sx-canhan-2026-10-01.md").read_text("utf-8")
    assert "\nx\n" in full and "## Hàng cận hạn (FEFO)" in fefo \
        and "\nx\n" not in fefo


# ------------------------------------------------------- xnqc --draft

def test_p2_xnqc_draft_payload_and_submit(monkeypatch):
    from agents import xnqc
    sent = []
    monkeypatch.setattr(xnqc.director, "submit",
                        lambda conn, blk, ot, oid, title, payload, by:
                        sent.append((blk, ot, oid, by, payload)) or 9)
    payload, qid = xnqc.draft(object(), "savina-12v", "maket", "maket fb",
                              "Savina tuýp 12 viên ngậm.", submit=True)
    assert qid == 9 and sent[0][:2] == ("legal_hr", "xnqc_dossier")
    assert sent[0][3] == "agent:xnqc"
    assert sent[0][2].startswith("savina-12v:maket:")
    assert "8014/2021/ĐKSP" in payload
    assert "CHƯA được Pháp chế duyệt" in payload
    assert "Guardrail maket" in payload
    with pytest.raises(ValueError):          # không phải TPBVSK
        xnqc.draft(None, "khong-co", "maket", "x", None, submit=False)


# ---------------------------------------------- UGC nghi hàng giả

@pytest.mark.parametrize(("text", "stars", "want"), [
    ("Shop ơi đây có phải hàng giả không", 3, "nghi_hang_gia"),
    ("nghi hang gia qua", None, "nghi_hang_gia"),
    ("Hàng fake rồi, tem khác", 2, "nghi_hang_gia"),
    ("Sâm ngon, cảm ơn shop", 5, "khen"),
])
def test_p2_ugc_counterfeit_class(text, stars, want):
    from agents import mkt_ugc
    r = mkt_ugc.load_rules()
    got = mkt_ugc.classify(text, stars, r)
    assert got == want
    if want == "nghi_hang_gia":
        assert mkt_ugc.draft_reply(got, r, san=False)


# ---------------------------------------------- sổ rủi ro TGĐ

def test_p2_ceo_risk_alcohol_and_gi():
    from datetime import datetime

    from agents import ceo_risk
    from agents.ra_kenh import page_safe
    from pipelines.period import VN_TZ
    f = {"tpbvsk": [], "dossiers": [], "posts": [], "alerts": [],
         "dpia_signed": True, "gaps": 0, "recipients": 1,
         "alcohol": [("ruou-x", ("shopee",)), ("ruou-y", ())],
         "gi_named": ["a", "b"], "gi_confirmed": ["a"], "gi_identity": False}
    rs = ceo_risk.rank(f, datetime(2026, 10, 19, tzinfo=VN_TZ),
                       ceo_risk.load_config())
    codes = [r["code"] for r in rs]
    assert sum(c.startswith("NHOM-HAN-CHE:H-") for c in codes) == 1
    assert "CDDL-NGOC-LINH" in codes
    for r in rs:                      # ô trang TGĐ không bị ẩn vì guardrail
        assert page_safe(r["title"]) == r["title"], r
        assert "ruou" not in r["code"]


# ---------------------------------------------- vườn: báo GĐ khi vẫn bỏ trống

class _Q:
    def __init__(self, seen=()):
        self.seen = set(seen)

    def execute(self, sql, args=None):
        hit = bool(args) and args[1] in self.seen
        return type("R", (), {"fetchone": lambda s: (1,) if hit else None})()


def test_p2_garden_escalates_only_still_empty(monkeypatch):
    from datetime import datetime, timezone

    from agents import garden_director as gd
    sent = []
    monkeypatch.setattr("pipelines.director.submit",
                        lambda conn, blk, ot, oid, title, payload, by:
                        sent.append((blk, ot, oid, by)) or 1)
    t = datetime(2026, 10, 1, tzinfo=timezone.utc)
    rems = [{"type": "no-logs", "plot": "K1", "activity": None,
             "last_ts": None, "days": None},
            {"type": "gap", "plot": "K2", "activity": None, "last_ts": t,
             "days": 20},                       # < 2 × 14 → chỉ nhắc
            {"type": "gap", "plot": "K3", "activity": None, "last_ts": t,
             "days": 30},
            {"type": "overdue", "plot": "K4", "activity": "tưới",
             "last_ts": t, "days": 40}]
    assert gd.escalate_gaps(_Q(), rems, {"gap_days": 14}) == 2
    assert [s[2] for s in sent] == ["gap:K1:none", "gap:K3:20261001T000000"]
    assert all(s[:2] == ("farming", "plot_log_gap") for s in sent)
    sent.clear()                                  # đã đẩy (mọi trạng thái)
    assert gd.escalate_gaps(_Q({"gap:K1:none"}), rems[:1],
                            {"gap_days": 14}) == 0
    assert sent == []


# ---------------------------------------------- tỷ lệ hủy kênh

def test_p2_channel_cancel_rate():
    from datetime import datetime, timezone

    from pipelines import mkt_metrics as mm
    until = datetime(2026, 10, 19, tzinfo=timezone.utc)
    rows = [("shopee", "sales.orders_completed", 90, "x"),
            ("shopee", "sales.orders_cancelled", 10, "x")]

    class C:
        def execute(self, sql, args=None):
            return type("R", (), {"fetchall": lambda s: rows})()
    r = mm.channel_week(C(), until)["rows"][0]
    assert r["cancelled"] == 10 and r["cancel_rate"] == 10.0
