"""v9.0 W90.6 FIN-QA nhẹ — chứng minh 0 payload Tài chính đi ra LLM/mạng.

(a) import 3 module kế toán trong subprocess `python -I` sạch → không kéo
    theo module mạng/gateway nào (kể cả bắc cầu);
(b) drift-guard egress (`dpia_draft.egress_modules`) không tính 3 module;
(c) chạy luồng fixture W90.3/W90.4/W90.5 với `llm_gateway.chat`/`embed`
    bị thay bằng hàm raise → 0 lời gọi. Mặc định không gọi LLM — nếu sau
    này thêm LLM vào khối Tài chính, đây là chỗ cắm quét PII 100% payload.
"""

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dpia_draft

FIN_MODULES = ("ingest.settlement_csv", "agents.acc_invoice", "agents.acc_ar")
FIN_FILES = {"ingest/settlement_csv.py", "agents/acc_invoice.py",
             "agents/acc_ar.py"}
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
