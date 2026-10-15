"""v8.3 W83.7 (DA-02) — GỢI Ý phân loại CR theo SOW.

Luật `data/projects/sow_scope.json`: mọi `sow_quote` là chuỗi con NGUYÊN VĂN
của SOW (trích bịa → lỗi cấu hình); `classify` thuần (bỏ dấu, ranh giới từ,
can_cr thắng, không khớp → chua_ro); nháp CR có dòng "Xung đột lợi ích",
không số tiền, đã che PII; `--eval` trên bộ MẪU dev (KHÔNG phải nghiệm thu);
`--cr --submit` → mục `change_request` pending.
DB thật trong schema tạm + ROLLBACK.
"""

import json
import re
import unicodedata
from pathlib import Path

import pytest

from agents import da_cr
from pipelines import approval_queue as aq
from pipelines import guardrail
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
SCOPE = da_cr.load_scope()
SOW = unicodedata.normalize("NFC", (ROOT / "SOW_SamSam_AI_6-thang.md")
                            .read_bytes().decode("utf-8")
                            .replace("\r\n", "\n"))
CASES = json.loads(da_cr.CASES_FILE.read_bytes().decode("utf-8"))
MONEY_RE = re.compile(r"\d[\d.,]*\s*(đ|đồng|VND|triệu|tỷ)", re.IGNORECASE)


@pytest.fixture
def db():
    yield from da_db()


def test_every_quote_verbatim_in_sow():
    raw = json.loads(da_cr.SCOPE_FILE.read_bytes().decode("utf-8"))
    assert raw["rules"] and "GỢI Ý" in raw["_doc"]
    for r in raw["rules"]:
        assert unicodedata.normalize("NFC", r["sow_quote"]) in SOW, r["id"]
        assert r["label"] in ("trong_sow", "can_cr")
    labels = {r["label"] for r in raw["rules"]}
    assert labels == {"trong_sow", "can_cr"}


def _scope_file(tmp_path, mutate):
    raw = json.loads(da_cr.SCOPE_FILE.read_bytes().decode("utf-8"))
    mutate(raw)
    p = tmp_path / "scope.json"
    p.write_bytes(json.dumps(raw, ensure_ascii=False).encode("utf-8"))
    return p


@pytest.mark.parametrize("mutate,needle", [
    (lambda d: d["rules"][0].update(
        {"sow_quote": "Gói dịch vụ bao gồm chạy quảng cáo không giới hạn"}),
     "nguyên văn trong SOW"),
    (lambda d: d["rules"][1].update({"id": d["rules"][0]["id"]}), "trùng"),
    (lambda d: d["rules"][0].update({"label": "mien_phi"}), "label"),
    (lambda d: d["rules"][0].update({"keywords": []}), "keywords"),
    (lambda d: d["rules"][0].update({"sow_ref": " "}), "sow_ref"),
    (lambda d: d.update({"rules": []}), "rỗng"),
    (lambda d: d.update({"sow_file": "khong-co.md"}), "không đọc được")])
def test_scope_config_errors(tmp_path, mutate, needle):
    with pytest.raises(da_cr.ScopeError) as e:
        da_cr.load_scope(_scope_file(tmp_path, mutate))
    assert needle in str(e.value)


@pytest.mark.parametrize("text,sug,ref", [
    ("chạy ads TikTok cho Tết", "can_cr", "WS2"),
    ("Nhờ chạy quảng cáo Shopee", "can_cr", "WS2"),
    ("Làm ERP bán hàng", "can_cr", "Mục 9"),
    ("lam erp ban hang", "can_cr", "Mục 9"),
    ("Vector index dữ liệu P0", "trong_sow", "WS1"),
    ("Đào tạo workshop marketing", "trong_sow", "WS4"),
    ("Đào tạo workshop về chạy quảng cáo", "can_cr", "WS2"),   # can_cr thắng
    ("Mua máy scanner mới", "chua_ro", None),                  # ranh giới từ
    ("Thiết kế logo Superpower", "chua_ro", None),
    ("Mua máy pha cà phê", "chua_ro", None),
    ("", "chua_ro", None)])
def test_classify(text, sug, ref):
    r = da_cr.classify(text, SCOPE)
    assert r["suggestion"] == sug
    if ref is None:
        assert r["rule_id"] is None and r["sow_quote"] is None
    else:
        assert r["sow_ref"].startswith(ref) and r["sow_quote"] in SOW


def test_draft_cr_coi_no_money_pii_masked():
    req = ("Chạy ads TikTok ngân sách 50 triệu, chi 10.000.000 đồng/tháng, "
           "giá 2,5 tỷ, gọi 0905 123 456 hoặc abc@gmail.com")
    md = da_cr.draft_cr(req, da_cr.classify(req, SCOPE))
    assert da_cr.COI_LINE in md and "Xung đột lợi ích" in md
    assert da_cr.PRICE_LINE in md and "chưa ước tính" in md
    assert not MONEY_RE.search(md), MONEY_RE.findall(md)
    assert "0905 123 456" not in md and "abc@gmail.com" not in md
    assert "WS2" in md and "CẦN change request" in md
    md2 = da_cr.draft_cr("Sơn biển hiệu", da_cr.classify("Sơn biển hiệu",
                                                           SCOPE))
    assert "CHƯA RÕ" in md2 and da_cr.COI_LINE in md2


def test_drafts_from_every_rule_pass_guardrail():
    """Phần tất định của nháp (gợi ý + trích SOW + dòng cố định) không tự
    làm mục `change_request` trượt guardrail."""
    for r in SCOPE["rules"]:
        req = r["keywords"][0]
        res = da_cr.classify(req, SCOPE)
        assert res["rule_id"] is not None, r["id"]
        g = guardrail.check(da_cr.draft_cr(req, res))
        assert g["ok"] is True, (r["id"], g["violations"])
    g = guardrail.check(da_cr.draft_cr("Sửa lỗi chatbot trả lời sai giá",
                                       da_cr.classify("Sửa lỗi", SCOPE)))
    assert g["ok"] is True, g["violations"]


@pytest.mark.parametrize("req", [
    "Chữa lỗi chatbot trả lời sai giá", "sửa chữa lỗi dashboard số liệu kênh",
    "Thêm mục thuốc bổ vào danh mục web"])
def test_cr_banned_word_submit_refused_before_connect(monkeypatch, tmp_path,
                                                      capsys, req):
    """Yêu cầu có từ cấm → nháp trượt guardrail → mục sẽ không duyệt được:
    `--submit` exit 1 TRƯỚC connect (0 mục hàng duyệt), có hướng dẫn diễn
    đạt lại; không `--submit` → vẫn ghi nháp + cảnh báo, exit 0."""
    monkeypatch.setattr(da_cr, "connect", lambda: pytest.fail("connect"))
    argv = ["--cr", req, "--out-dir", str(tmp_path)]
    assert da_cr.main(argv + ["--submit"]) == 1
    err = capsys.readouterr().err
    assert "trượt guardrail" in err and "tu_cam" in err
    assert "sửa lỗi" in err and "KHÔNG đẩy" in err
    assert da_cr.main(argv) == 0
    assert "trượt guardrail" in capsys.readouterr().err
    assert len(list(tmp_path.glob("da-cr-*.md"))) == 1


def test_mau_cases_file_and_eval():
    assert CASES["labeled_by"] == "dev_MAU" and "KHÔNG phải" in CASES["_doc"]
    cases = CASES["cases"]
    assert len(cases) >= 15
    want = {"chua_ro", "can_cr", "trong_sow"}
    assert {c["expect"] for c in cases} == want
    acc, miss = da_cr.evaluate(cases, SCOPE)
    assert acc >= da_cr.THRESHOLD, miss


def test_cli_eval_prints_mau(capsys):
    assert da_cr.main(["--eval"]) == 0
    out = capsys.readouterr().out
    assert "MẪU dev — không phải nghiệm thu" in out
    assert "TGĐ/Pháp chế gán nhãn" in out


def test_cli_eval_below_threshold_exit1(tmp_path, capsys):
    p = tmp_path / "c.json"
    p.write_bytes(json.dumps({"cases": [
        {"id": "X1", "text": "Mua máy pha cà phê", "expect": "trong_sow"},
        {"id": "X2", "text": "Làm ERP", "expect": "can_cr"}]},
        ensure_ascii=False).encode("utf-8"))
    assert da_cr.main(["--eval", "--cases", str(p)]) == 1
    assert "[miss] X1" in capsys.readouterr().out
    p.write_bytes(b"{}")
    assert da_cr.main(["--eval", "--cases", str(p)]) == 1


def test_cli_scope_broken_exit1(tmp_path, monkeypatch):
    p = _scope_file(tmp_path, lambda d: d["rules"][0].update(
        {"sow_quote": "trích bịa không có trong SOW"}))
    monkeypatch.setattr(da_cr, "SCOPE_FILE", p)
    assert da_cr.main(["--classify", "chạy ads"]) == 1


def test_cli_classify_and_cr_without_submit_no_db(monkeypatch, tmp_path,
                                                  capsys):
    monkeypatch.setattr(da_cr, "connect", lambda: pytest.fail("connect"))
    assert da_cr.main(["--classify", "chạy ads TikTok"]) == 0
    out = capsys.readouterr().out
    assert "[goi-y] can_cr" in out and "Xung đột lợi ích" in out
    assert da_cr.main(["--cr", "Làm ERP bán hàng", "--out-dir",
                       str(tmp_path)]) == 0
    files = list(tmp_path.glob("da-cr-*.md"))
    assert len(files) == 1
    assert "Mục 9" in files[0].read_text(encoding="utf-8")


@pytest.mark.parametrize("argv", [
    ["--classify", "a", "--eval"], [], ["--classify", "  "],
    ["--eval", "--submit"], ["--list", "--cr", "x"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(da_cr, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        da_cr.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch, tmp_path):
    monkeypatch.setattr(da_cr, "connect", lambda: None)
    assert da_cr.main(["--list"]) == 2
    assert da_cr.main(["--cr", "x", "--submit", "--out-dir",
                       str(tmp_path)]) == 2


def test_no_send_path_grep():
    src = (ROOT / "agents" / "da_cr.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|email\.mime|httpx|requests|"
                         r"urllib\.request|socket|llm_gateway", src)


def test_cr_submit_pending_and_list(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(da_cr, "connect", lambda: TxConn(db))
    n_appr = db.execute("select count(*) from approvals").fetchone()[0]
    argv = ["--cr", "Chạy ads TikTok mùa Tết", "--submit", "--out-dir",
            str(tmp_path)]
    assert da_cr.main(argv) == 0
    rows = db.execute("select block, object_type, object_id, status,"
                      " created_by, payload from approval_queue").fetchall()
    assert len(rows) == 1
    b, ot, oid, st, by, payload = rows[0]
    assert (b, ot, st, by) == ("projects", "change_request", "pending",
                               "agent:da_cr")
    assert re.fullmatch(r"cr:[0-9a-f]{12}", oid)
    assert da_cr.COI_LINE in payload and not MONEY_RE.search(payload)
    assert db.execute("select count(*) from approvals").fetchone()[0] \
        == n_appr
    assert da_cr.main(argv) == 1                     # trùng mục đang chờ
    capsys.readouterr()
    assert da_cr.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert oid in out and "pending" in out and "sổ CR: 1 mục" in out
    # Nháp CR sạch DUYỆT được (decide kiểm lại guardrail payload).
    qid = db.execute("select id from approval_queue").fetchone()[0]
    ok, msg = aq.decide(TxConn(db), qid, "TGĐ MẪU", "approved")
    assert ok, msg
