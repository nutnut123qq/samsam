"""v4.4 W44.2 — bản đồ luồng dữ liệu + drift-guard egress (PC-A5).

Mọi module gửi dữ liệu ra ngoài (import mạng / chat|embed từ gateway) phải
được khai báo trong `data/data_flow_map.json` — thêm module mới mà quên map
→ test đỏ, nêu tên module. Quét bằng `ast` (bắt cả import lười trong hàm).
"""

import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dpia_draft

MAP_PATH = ROOT / "data" / "data_flow_map.json"
RAW = json.loads(MAP_PATH.read_bytes().decode("utf-8"))
# Module KHÔNG có đường gửi ra ngoài (v5.2: CRM — agent không tự liên hệ).
# v5.1: lớp kênh CSKH thuần — việc gửi là của adapter (zalo/messenger).
NEW_SCRIPTS = {"scripts/review_load.py", "scripts/dpia_draft.py",
               "scripts/contract_check.py", "ingest/crm.py",
               # v8.3 phòng Dự án: 4 agent KHÔNG gửi gì ra ngoài
               "agents/da_radar.py", "agents/da_b2b.py", "agents/da_pmo.py",
               "agents/da_cr.py", "connectors/channels.py",
               # v6.5 WP08: số đo + gợi ý SEO sàn — KHÔNG gửi gì ra ngoài
               "agents/seo_san.py", "pipelines/mkt_metrics.py",
               # v5.3 KD-A4/A5: agent luật, KHÔNG gửi gì ra ngoài
               "agents/kd_listing.py", "agents/kd_price.py",
               # v10.3: cổng vendor nạp FILE — không request mạng
               "ingest/social_vendor.py"}
KNOWN_EGRESS = {
    "connectors/zalo.py", "crawler/collect.py", "pipelines/llm_gateway.py",
    "scripts/health_bulletin.py", "scripts/zalo_mock.py",
    "scripts/zalo_preflight.py", "api/rag.py", "pipelines/content.py",
    "ingest/embed_store.py", "connectors/messenger.py"}
# Luồng BẮT BUỘC (rà từ code thật) — tra theo module.
REQUIRED_MODULES = [
    "connectors/zalo.py", "scripts/zalo_preflight.py", "scripts/zalo_mock.py",
    "ingest/lead_store.py", "api/rag.py", "pipelines/llm_gateway.py",
    "app/streamlit_app.py", "pipelines/content.py", "ingest/embed_store.py",
    "ingest/kb_internal.py", "ingest/doc_intake.py", "ingest/market_csv.py",
    "scripts/health_bulletin.py", "crawler/collect.py", "scripts/db_backup.py",
    "ingest/crm.py",
    # v9.0 kế toán — luồng có PII người mua hóa đơn / mã đơn / công nợ
    "ingest/settlement_csv.py", "agents/acc_invoice.py", "agents/acc_ar.py",
    # v9.1 FP&A — số liệu tổng hợp + tên người lập/duyệt giá vốn
    "agents/fp_pnl.py", "agents/fp_ads.py", "agents/fp_opscost.py",
    "agents/fp_cash.py", "agents/fin_director.py",
    # v5.1 CSKH đa kênh
    "connectors/messenger.py", "connectors/channels.py",
    # v6.5 MKT-10 rà SEO website công ty (GET qua collector)
    "agents/seo_web.py",
    # v10.3 WP16 nền P2: API sàn chỉ đọc + social listening nhà cung cấp
    "ingest/market_api.py", "ingest/social_vendor.py",
    # v6.4 MKT-07 review/UGC → nháp trả lời + consent tái sử dụng
    "agents/mkt_ugc.py"]


def _declared(m):
    return {mod for f in m["flows"] for mod in f["modules"]}


def test_repo_map_loads():
    m = dpia_draft.load_map(MAP_PATH)
    assert len(m["flows"]) >= 15
    ids = [f["id"] for f in m["flows"]]
    assert len(ids) == len(set(ids))


def test_every_egress_module_declared():
    egress = dpia_draft.egress_modules(ROOT)
    assert KNOWN_EGRESS <= egress, KNOWN_EGRESS - egress   # chống scanner rỗng
    undeclared = sorted(egress - _declared(dpia_draft.load_map(MAP_PATH)))
    assert not undeclared, (
        "module gửi dữ liệu ra ngoài CHƯA khai báo trong "
        f"data/data_flow_map.json: {undeclared}")


def test_new_scripts_send_nothing_out():
    bad = sorted(NEW_SCRIPTS & dpia_draft.egress_modules(ROOT))
    assert not bad, f"module phải KHÔNG gửi gì ra ngoài nhưng có egress: {bad}"


@pytest.mark.parametrize("mod", REQUIRED_MODULES)
def test_required_flow_present(mod):
    assert mod in _declared(RAW)


def test_known_facts_in_map():
    by_mod = {}
    for f in RAW["flows"]:
        for mod in f["modules"]:
            by_mod.setdefault(mod, []).append(f)
    from connectors.zalo import RETAIN_DAYS
    conv = [f for f in RAW["flows"] if "conversations.jsonl" in f["storage"]]
    assert conv and f"RETAIN_DAYS = {RETAIN_DAYS}" in conv[0]["retention"]
    rag = [f for f in by_mod["api/rag.py"] if f["cross_border"]]
    assert rag and "OpenRouter" in rag[0]["recipients"]
    assert all(not f["cross_border"] for f in by_mod["scripts/zalo_mock.py"])
    assert all(not f["cross_border"] for f in by_mod["ingest/doc_intake.py"])
    leads = by_mod["ingest/lead_store.py"]
    assert any("GAP" in f["retention"] for f in leads)


# ---------------------------------------------------------------- validate
def _bad(tmp_path, mutate):
    m = copy.deepcopy(RAW)
    mutate(m)
    p = tmp_path / "map.json"
    p.write_bytes(json.dumps(m, ensure_ascii=False).encode("utf-8"))
    return p


@pytest.mark.parametrize("mutate,needle", [
    (lambda m: m["flows"][0].pop("retention"), "DF-01.retention"),
    (lambda m: m["flows"][0].update({"class": "tim"}), "DF-01.class"),
    (lambda m: m["flows"][1].update({"id": "DF-01"}), "DF-01.id"),
    (lambda m: m["flows"][0].update({"cross_border": "false"}),
     "DF-01.cross_border"),
    (lambda m: m["flows"][0].update({"modules": []}), "DF-01.modules"),
    (lambda m: m["flows"][0].update({"modules": ["khong/co.py"]}),
     "DF-01.modules"),
    (lambda m: m["flows"][0].update({"modules": ["..\\x.py"]}),
     "DF-01.modules"),
    (lambda m: m["flows"][0].update({"gaps": "chuỗi"}), "DF-01.gaps"),
    (lambda m: m["flows"][0].update({"id": "X1"}), "flows[0].id"),
    (lambda m: m.update({"flows": []}), "flows"),
    (lambda m: m.update({"version": "12/10/2026"}), "version"),
], ids=["thieu-key", "class-la", "id-trung", "cross-str", "modules-rong",
        "modules-khong-ton-tai", "modules-backslash", "gaps-str", "id-sai",
        "flows-rong", "version-sai"])
def test_load_map_rejects(tmp_path, mutate, needle):
    with pytest.raises(ValueError) as e:
        dpia_draft.load_map(_bad(tmp_path, mutate))
    assert needle in str(e.value)


def test_load_map_broken_json(tmp_path):
    p = tmp_path / "map.json"
    p.write_bytes(b"{")
    with pytest.raises(ValueError):
        dpia_draft.load_map(p)


# ---------------------------------------------------------------- scanner
def test_egress_scanner_tmp_tree(tmp_path):
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    files = {
        "a.py": "import requests\n",
        "b.py": "def f():\n    import httpx\n    return httpx\n",
        "c.py": "from urllib import request\n",
        "d.py": "from urllib.parse import urljoin\n",
        "e.py": "import socket\nsocket.gethostname()\n",
        "f.py": "from pipelines.llm_gateway import chat\n",
        "g.py": "from pipelines.llm_gateway import _strip_accents\n",
        "h.py": "import urllib.request as u\n",
        "i.py": "from http.client import HTTPSConnection\n",
        # Các cách import gateway phổ biến khác — phải tính egress.
        "j.py": ("from pipelines import llm_gateway\n"
                 "llm_gateway.chat('a', [])\n"),
        "k.py": "import pipelines.llm_gateway as gw\ngw.chat('a', [])\n",
        "l.py": "from pipelines.llm_gateway import chat as c\n",
    }
    for n, src in files.items():
        (pkg / n).write_text(src, encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "t.py").write_text("import requests\n",
                                             encoding="utf-8")
    got = dpia_draft.egress_modules(tmp_path)
    assert got == {"pkg/a.py", "pkg/b.py", "pkg/c.py", "pkg/f.py",
                   "pkg/h.py", "pkg/i.py", "pkg/j.py", "pkg/k.py",
                   "pkg/l.py"}


def _egress(src):
    import ast
    return dpia_draft._is_egress(ast.parse(src))


@pytest.mark.parametrize("src", [
    "import pipelines.llm_gateway as g\ng.chat('a', [])\n",
    "import pipelines.llm_gateway\n",
    "from pipelines import llm_gateway\n",
    "from pipelines import content, llm_gateway as g\n",
    "from .llm_gateway import chat\n",
    "from . import llm_gateway\n",
    "from ..pipelines.llm_gateway import embed\n",
    "from pipelines.llm_gateway import _client\n",
    "from pipelines.llm_gateway import _call\n",
    "from pipelines.llm_gateway import *\n",
    "from pipelines.llm_gateway import _strip_accents, embed\n",
    "def f():\n    from pipelines.llm_gateway import chat\n",
], ids=["import-as", "import-plain", "from-pkg", "from-pkg-multi",
        "rel-chat", "rel-module", "rel-parent", "_client", "_call", "star",
        "safe+embed", "lazy"])
def test_gateway_import_forms_are_egress(src):
    assert _egress(src) is True


@pytest.mark.parametrize("src", [
    "from pipelines.llm_gateway import _strip_accents\n",
    "from pipelines.llm_gateway import GatewayBlocked\n",
    "from pipelines.llm_gateway import WARN_RATIO, _config\n",
    "from pipelines.llm_gateway import GatewayError, is_health_question\n",
    "from .llm_gateway import _strip_accents\n",
    "from pipelines import content\n",
    "import pipelines\n",
], ids=["strip", "blocked", "warn-config", "error-health", "rel-safe",
        "other-sibling", "pkg-only"])
def test_gateway_safe_imports_not_egress(src):
    assert _egress(src) is False


def test_v51_messenger_flow_facts():
    """v5.1: Messenger là luồng MỚI ra Meta (cross-border); gợi ý sàn không
    lưu; DF-01 ghi đồng ý chat tường minh nhưng còn GAP cờ tắt."""
    by_mod = {}
    for f in RAW["flows"]:
        for mod in f["modules"]:
            by_mod.setdefault(mod, []).append(f)
    [msgr] = [f for f in by_mod["connectors/messenger.py"]
              if f["name"].startswith("Kênh Messenger")]
    assert msgr["cross_border"] is True and msgr["class"] == "do"
    assert "graph.facebook.com" in msgr["recipients"]
    assert any("X-Hub-Signature-256" in s for s in msgr["safeguards"])
    assert any("DEPLOY" in s for s in msgr["safeguards"])
    assert any("DPIA" in g for g in msgr["gaps"])
    san = [f for f in by_mod["connectors/channels.py"]
           if "sàn" in f["name"]]
    assert san and "staff_assist_dpia_v1" in san[0]["legal_basis"]
    df01 = next(f for f in RAW["flows"] if f["id"] == "DF-01")
    assert "chat_consents" in df01["legal_basis"]
    assert "GAP" in df01["legal_basis"]


def test_v51_probe_messenger_flow_removed_is_caught(tmp_path):
    """Probe: bản copy map bỏ luồng Messenger → logic drift-guard báo thiếu
    `connectors/messenger.py` (không sửa file thật)."""
    p = _bad(tmp_path, lambda m: m.update(flows=[
        f for f in m["flows"]
        if "connectors/messenger.py" not in f["modules"]]))
    egress = dpia_draft.egress_modules(ROOT)
    undeclared = egress - _declared(dpia_draft.load_map(p))
    assert "connectors/messenger.py" in undeclared
