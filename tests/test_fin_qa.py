"""v9.0 W90.6 / v9.1 W91.7 FIN-QA nhẹ — chứng minh 0 payload Tài chính đi ra
LLM/mạng.

(a) import 8 module kế toán + FP&A trong subprocess `python -I` sạch →
    không kéo theo module mạng/gateway nào (kể cả bắc cầu);
(b) drift-guard egress (`dpia_draft.egress_modules`) không tính 8 module;
(c) chạy luồng fixture W90.3/W90.4/W90.5 + W91.2–W91.6 với
    `llm_gateway.chat`/`embed` bị thay bằng hàm raise → 0 lời gọi, và MỌI
    text FP&A sinh ra (payload hàng duyệt ads + khoản vượt X, file P&L, bản
    tin tuần, stdout CLI) thỏa `_mask_pii(x) == x` — quét PII 100% payload.
    Mặc định không gọi LLM — nếu sau này thêm LLM vào khối Tài chính, đây là
    chỗ cắm.
"""

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dpia_draft

FIN_MODULES = ("ingest.settlement_csv", "agents.acc_invoice", "agents.acc_ar",
               "agents.fp_pnl", "agents.fp_ads", "agents.fp_opscost",
               "agents.fp_cash", "agents.fin_director")
FIN_FILES = {"ingest/settlement_csv.py", "agents/acc_invoice.py",
             "agents/acc_ar.py", "agents/fp_pnl.py", "agents/fp_ads.py",
             "agents/fp_opscost.py", "agents/fp_cash.py",
             "agents/fin_director.py"}
NET = ("openai", "httpx", "requests", "smtplib", "urllib.request",
       "http.client", "pipelines.llm_gateway")
FIX = Path(__file__).resolve().parent / "fixtures" / "finance"


def test_imports_pull_no_network_or_gateway():
    code = ("import json, sys; sys.path.insert(0, sys.argv[1]); "
            + "; ".join(f"import {m}" for m in FIN_MODULES)
            + f"; print(json.dumps([m for m in {list(NET)!r} "
              "if m in sys.modules]))")
    r = subprocess.run([sys.executable, "-I", "-c", code, str(ROOT)],
                       cwd=ROOT, capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout.strip().splitlines()[-1]) == []


def test_not_egress_in_flow_map_scanner():
    egress = dpia_draft.egress_modules(ROOT)
    assert "pipelines/llm_gateway.py" in egress      # scanner không rỗng
    assert not FIN_FILES & egress


def test_fixture_flows_call_llm_zero_times(monkeypatch):
    from pipelines import llm_gateway
    calls = []

    def _boom(*a, **kw):
        calls.append(1)
        raise AssertionError("khối Tài chính gọi LLM")

    monkeypatch.setattr(llm_gateway, "chat", _boom)
    monkeypatch.setattr(llm_gateway, "embed", _boom)

    from agents import acc_ar as ar
    from agents import acc_invoice as ai
    from ingest import market_csv as mc
    from ingest import settlement_csv as sc
    from pipelines import director

    # W90.3 đối soát
    rows, errs, _ = sc.read_settlement(FIX / "settlement_shopee_MAU.csv",
                                       "shopee", sc.load_mapping()[0])
    assert errs == []
    fees = sc.load_fees()[0]["shopee"]
    labels = {sc.reconcile_row(r, r["order_amount"], fees)[0] for r in rows}
    assert labels
    # W90.4 lô hóa đơn
    cfg = ai.load_config()[0]
    orows, errs, _ = mc.read_export(FIX / "order_invoice_MAU.csv", "shopee",
                                    "order", mc.load_mapping()[0])
    assert errs == []
    orders = [{"channel": "shopee", "order_id_hash": r["order_id_hash"],
               "status": r["status"], "amount_vnd": r["price"] * r["qty"],
               "items": [{"title": r["title"], "qty": r["qty"],
                          "price_vnd": r["price"]}]} for r in orows]
    reqs, errs = ai.read_yeu_cau(FIX / "invoice_requests_MAU.csv", "shopee",
                                 cfg)
    assert errs == []
    b = ai.build_batch(orders, reqs, [], cfg, date(2026, 10, 12))
    ai.render_csv(b, cfg, 1)
    ai.render_payload(b, "2026-10-12-abcdef012345", "0" * 64, cfg, 1)
    # W90.5 công nợ + bản tin
    es, errs, _ = ar.read_ar(FIX / "dealer_ar_MAU.csv")
    assert errs == []
    acfg = ar.load_config()[0]
    aged = ar.aging(es, date(2026, 10, 12), acfg["term_days"])
    ar.commission(es, {"savina-12v": "tpbvsk"}, acfg, date(2026, 9, 1),
                  date(2026, 11, 1))
    from datetime import datetime, timedelta, timezone
    director.digest(director.load_config("finance"), [],
                    datetime(2026, 10, 12, 9, tzinfo=timezone(
                        timedelta(hours=7))),
                    extra=ar.overdue_section(aged, date(2026, 10, 12)))
    assert calls == []


def _fpa_pnl():
    """P&L thuần từ fixture đơn sàn + quyết toán MẪU (không DB)."""
    from agents import fp_pnl as fp
    from ingest import market_csv as mc
    from ingest import settlement_csv as sc

    rows = []
    for f in ("settlement_shopee_MAU.csv", "settlement_shopee_multi_MAU.csv"):
        rs, errs, _ = sc.read_settlement(FIX / f, "shopee",
                                         sc.load_mapping()[0])
        assert errs == []
        rows += [{"id": i, "channel": "shopee",
                  "order_id_hash": r["order_id_hash"],
                  "order_amount_vnd": r["order_amount"],
                  **{f"{k}_vnd": r[k] for k in sc.DEDUCT}, "payout_vnd":
                  r["payout"], "settled_on": r["settled_on"], "label": None}
                 for i, r in enumerate(rs, len(rows))]
    lines = []
    for f in ("order_shopee_MAU.csv", "order_shopee_multi_MAU.csv"):
        os_, errs, _ = mc.read_export(FIX / f, "shopee", "order",
                                      mc.load_mapping()[0])
        assert errs == []
        lines += [{"channel": "shopee", "order_id_hash": r["order_id_hash"],
                   "row_no": r["row_no"], "sku_key": r.get("seller_sku"),
                   "qty": r["qty"], "price_vnd": r["price"]} for r in os_]
    # giá vốn MẪU — bỏ trống 1 SKU để có dòng "chưa có giá vốn duyệt"
    vs = [{"id": i, "sku_key": k, "cost_vnd": 50_000, "valid_from":
           date(2026, 10, 1), "approved_by": "nguoi duyet mau"}
          for i, k in enumerate(("savina-12v", "saphraton-20v",
                                 "savigout-30v", "mat-ong-sam-300ml",
                                 "mat-ong-sam-120ml-1hu"))]
    return fp.pnl(rows, lines, vs, date(2026, 10, 1))


def test_fpa_flows_no_llm_and_every_text_pii_clean(monkeypatch, capsys):
    from pipelines import llm_gateway
    calls = []

    def _boom(*a, **kw):
        calls.append(1)
        raise AssertionError("khối Tài chính (FP&A) gọi LLM")

    monkeypatch.setattr(llm_gateway, "chat", _boom)
    monkeypatch.setattr(llm_gateway, "embed", _boom)

    from datetime import datetime, timedelta, timezone

    from agents import fin_director as fd
    from agents import fp_ads as fa
    from agents import fp_cash as fc
    from agents import fp_opscost as fo
    from agents import fp_pnl as fp
    from pipelines import director, guardrail
    from pipelines.pii import _mask_pii

    texts = {}
    month = date(2026, 10, 1)
    # W91.2 P&L
    res = _fpa_pnl()
    assert res["loai"] == ["sapentol-30v"]
    texts["pnl"] = fp.render(res)
    # W91.3 đề xuất ads (readiness soi gương view từ golden)
    acfg = fa.load_cfg()[0]
    golden = json.loads((ROOT / "data" / "golden_skus.json").read_text(
        encoding="utf-8"))["skus"]
    rd = {(s["sku_key"], ch): guardrail.readiness(s["sku_key"], ch)
          for s in golden for ch in acfg["channels"]}
    texts["ads_payload"] = fa.render_payload(month, fa.propose(
        res["cells"], rd, acfg), acfg)
    # W91.4 chi phí vận hành + khoản vượt X
    ocfg = fo.load_cfg()[0]
    es, errs, sha = fo.read_opex(FIX / "opex_MAU.csv")
    assert errs == []
    opex = [{**e, "id": i, "file_sha256": sha} for i, e in enumerate(es, 1)
            if e["month"] == month]
    acts = fo.actuals({"content": 150}, opex, ocfg["usd_vnd"])
    alerts = fo.budget_alerts(acts, ocfg["budget_vnd"], ocfg["warn_pct"],
                              ocfg["stop_pct"])
    over = [(e, fo.spend_status(e, [], {}, ocfg["threshold_x_vnd"]))
            for e in opex if e["amount_vnd"] > ocfg["threshold_x_vnd"]]
    texts["ops_report"] = fo.render_report(month, acts, ocfg, alerts, over)
    for e, _st in over:
        texts[f"opex_payload_{e['id']}"] = fo.render_over_x(e)
    # W91.5 dòng tiền (DB down → tỷ lệ mặc định) + stdout CLI
    ccfg, a, gold = fc.load_inputs()
    cash = fc.run({}, date(2026, 10, 12), None, ccfg, a, gold)
    texts["cash"] = fc.render(cash)
    monkeypatch.setattr(fc, "connect", lambda: None)
    capsys.readouterr()
    assert fc.main(["--forecast", "--start", "2026-10-12"]) == 0
    cap = capsys.readouterr()
    texts["cash_stdout"] = cap.out + cap.err
    # W91.6 bản tin tuần (khuôn director + 5 mục)
    extra = (fd.nodata(fd.H_AR, "fixture không nạp công nợ") + [""]
             + fd.pnl_section(res) + [""]
             + fd.ops_section(month, {"alerts": alerts, "over": over}, ocfg)
             + [""] + fd.cash_section(cash) + [""] + fd.ads_section(1))
    texts["bulletin"] = director.digest(
        director.load_config("finance"), [],
        datetime(2026, 10, 12, 9, tzinfo=timezone(timedelta(hours=7))),
        extra=extra)

    assert calls == []
    for name, t in texts.items():
        assert t.strip(), name
        assert _mask_pii(t) == t, name
        for leak in ("FAKESET", "nguoimuagia", "090000000", "nguoi duyet"):
            assert leak not in t, (name, leak)
    # payload vào hàng duyệt phải qua guardrail (enqueue tự kiểm lại)
    for name, t in texts.items():
        if "payload" in name:
            assert guardrail.check(t)["ok"] is True, name


def test_sop_5f_commands_point_to_real_modules():
    import re
    sop = (ROOT / "docs" / "handover" / "sop.md").read_bytes().decode("utf-8")
    sec = sop.split("## 5f.")[1].split("\n## ")[0]
    mods = set(re.findall(r"python -m ([\w.]+)", sec))
    assert {"agents.fp_pnl", "agents.fp_ads", "agents.fp_opscost",
            "agents.fp_cash", "agents.fin_director"} <= mods
    for m in mods:
        assert (ROOT / (m.replace(".", "/") + ".py")).is_file(), m
