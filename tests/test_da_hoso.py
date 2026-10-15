"""v8.3 W83.4–W83.5 — DA-04 checklist + nháp hồ sơ tham gia; bản nộp/bản
xuất phải khớp sha256 bản NGƯỜI đã duyệt.

W83.4: `eligible_skus`/`build` thuần trên golden thật (rượu loại khỏi mọi
phần, TPBVSK chưa XNQC → chỉ thành câu hỏi Pháp chế), cổng `check_publish`
+ lọc rượu + SKU bị loại; LLM mặc định TẮT, bật thì thư LLM qua CÙNG cổng,
prompt không chứa file nội bộ. `--submit` → 1 mục pending, không tự duyệt.
W83.5: `--export`/`--verify-submit` — chỉ mục `program_application` ĐÃ
duyệt + khớp hash; lệch 1 ký tự/CRLF/khoảng trắng/byte hỏng → exit 1.
DB thật trong schema tạm + ROLLBACK.
"""

import ast
import copy
import json
import re
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from agents import da_hoso
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import approval_queue as aq
from pipelines import director, guardrail, kb_filter, llm_gateway
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
GOLDEN, _GERR = read_golden(GOLDEN_FILE)
DOC = da_hoso.load_templates()
INTRO = DOC["company_intro"]
PROG = {"id": 7, "title": "[MẪU] Hội chợ Tết Đà Nẵng 2027",
        "organizer": "Sở Công Thương Đà Nẵng", "deadline": date(2026, 11, 25),
        "url": "https://mau.example.gov/hoi-cho-tet-2027"}
BANNED = [w.strip() for w in (ROOT / "data" / "banned_words.txt")
          .read_text(encoding="utf-8").splitlines()
          if w.strip() and not w.startswith("#")]
APPROVER = "GĐ dự án MẪU"


@pytest.fixture
def db():
    yield from da_db()


def _build(golden=GOLDEN, tpl="hoi_cho", **kw):
    return da_hoso.build(PROG, DOC["templates"][tpl], golden, intro=INTRO,
                         **kw)


def _golden_with(**changes):
    g = copy.deepcopy(GOLDEN)
    for s in g["skus"]:
        if s["sku_key"] in changes:
            s.update(changes[s["sku_key"]])
    return g


# ---------------------------------------------------------------- W83.4 pure


def test_real_templates_clean():
    assert _GERR is None
    assert set(DOC["templates"]) == {"hoi_cho", "ocop", "xuc_tien_tmdt"}
    assert "Ngọc Linh" not in INTRO["text"] and "BẢN DEV SOẠN" in DOC["_doc"]
    for t in DOC["templates"].values():
        assert {c["owner"] for c in t["checklist"]} <= set(da_hoso.OWNERS)


def test_eligible_skus_real_golden():
    allowed, qs = da_hoso.eligible_skus(GOLDEN)
    names = [s["name"] for s in allowed]
    assert "Mật ong sâm 300ml" in names
    assert all(s["category"] == "food" for s in allowed)   # golden: none XNQC
    assert any("`savigout-30v`" in q for q in qs)
    assert not [q for q in qs if "ruou" in q or "rượu" in q.casefold()]


@pytest.mark.parametrize("tpl", ["hoi_cho", "ocop", "xuc_tien_tmdt"])
def test_build_payload_real_golden(tpl):
    r = _build(tpl=tpl)
    p = r["payload"]
    assert r["problems"] == []
    assert "Mật ong sâm 300ml" in p and da_hoso.AI_LABEL in p
    for bad in ("Savigout", "Rượu", "rượu", "Saphraton"):
        assert bad not in p
    assert kb_filter.is_alcohol(p) is False
    assert guardrail.check_publish(p, channel="web",
                                   content_type="post")["ok"] is True
    low = p.casefold()
    assert not [w for w in BANNED
                if re.search(rf"(?<!\w){re.escape(w.casefold())}(?!\w)", low)]
    assert PROG["title"] in p and "25/11/2026" in p and PROG["url"] in p
    assert INTRO["source_url"] in p
    # file nội bộ: checklist + câu hỏi Pháp chế — KHÔNG nằm trong bản nộp
    assert "`savigout-30v`" in r["internal"]
    assert "Checklist giấy tờ" in r["internal"]
    assert "Checklist" not in p and "Pháp chế xác nhận" not in p


def test_tpbvsk_missing_xnqc_excluded_and_approved_included():
    g = copy.deepcopy(GOLDEN)
    for s in g["skus"]:
        if s["sku_key"] == "savigout-30v":
            s.pop("xnqc_status")              # thiếu field → coi 'none'
    allowed, qs = da_hoso.eligible_skus(g)
    assert "savigout-30v" not in {s["sku_key"] for s in allowed}
    assert any("`savigout-30v`" in q and "none" in q for q in qs)
    g2 = _golden_with(**{"savigout-30v": {"xnqc_status": "approved"}})
    allowed2, qs2 = da_hoso.eligible_skus(g2)
    assert "savigout-30v" in {s["sku_key"] for s in allowed2}
    assert not any("`savigout-30v`" in q for q in qs2)
    r = _build(g2)
    assert "Savigout 30 viên" in r["payload"] and r["problems"] == []
    # TPBVSK đã XNQC → bản nộp kèm câu khuyến cáo bắt buộc
    assert "không phải là thuốc" in r["payload"]


def test_alcohol_excluded_everywhere_even_if_category_wrong():
    g = _golden_with(**{"ruou-sam-binh-su-do-500ml": {"category": "food"}})
    allowed, _ = da_hoso.eligible_skus(g)
    assert not [s for s in allowed if "Rượu" in s["name"]]
    r = _build(g)
    assert "Rượu" not in r["payload"] and "ruou" not in r["internal"]


def test_unknown_category_and_zero_products():
    g = {"skus": [{"sku_key": "x-1", "name": "Sản phẩm MẪU", "category": "la"},
                  {"sku_key": "ruou-1", "name": "Rượu MẪU",
                   "category": "alcohol"}]}
    allowed, qs = da_hoso.eligible_skus(g)
    assert allowed == [] and len(qs) == 1 and "`x-1`" in qs[0]
    r = _build(g)
    assert any("0 sản phẩm" in p for p in r["problems"])


def test_excluded_sku_name_in_payload_is_problem():
    tpl = {**DOC["templates"]["hoi_cho"],
           "letter": DOC["templates"]["hoi_cho"]["letter"] + " Savigout 30 viên"}
    r = da_hoso.build(PROG, tpl, GOLDEN, intro=INTRO)
    assert "sku_bi_loai: savigout-30v" in r["problems"]


def test_feed_title_placeholder_not_reexpanded():
    prog = {**PROG, "title": "Hội chợ {products} {organizer}"}
    r = da_hoso.build(prog, DOC["templates"]["hoi_cho"], GOLDEN, intro=INTRO)
    assert "Hội chợ {products} {organizer}" in r["payload"]


# ---------------------------------------------------------------- LLM


class _Chat:
    def __init__(self, reply=None, exc=None):
        self.calls, self.reply, self.exc = [], reply, exc

    def __call__(self, agent_id, messages, **kw):
        self.calls.append((agent_id, messages))
        if self.exc:
            raise self.exc
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=self.reply))])


def test_llm_off_by_default_zero_calls(monkeypatch):
    fake = _Chat("Thư")
    monkeypatch.setattr(llm_gateway, "chat", fake)
    _build()
    _build(llm=False)
    assert fake.calls == []


def test_llm_letter_with_alcohol_rejected_template_used(monkeypatch):
    fake = _Chat("Kính gửi Ban tổ chức, xin giới thiệu rượu sâm làm quà Tết.")
    monkeypatch.setattr(llm_gateway, "chat", fake)
    r = _build(llm=True)
    assert len(fake.calls) == 1 and fake.calls[0][0] == "projects"
    assert "rượu" not in r["payload"] and r["problems"] == []
    assert "Kính gửi Ban tổ chức [MẪU] Hội chợ" in r["payload"]
    assert "Thư LLM bị loại" in r["internal"]


def test_llm_gateway_error_no_crash(monkeypatch):
    fake = _Chat(exc=llm_gateway.GatewayBlocked("cap"))
    monkeypatch.setattr(llm_gateway, "chat", fake)
    r = _build(llm=True)
    assert r["problems"] == [] and "Thư LLM bị loại" in r["internal"]
    for bad in (None, "   ", 123):
        monkeypatch.setattr(llm_gateway, "chat", _Chat(bad))
        r = _build(llm=True)
        assert r["problems"] == [] and "Thư LLM bị loại" in r["internal"]


def test_llm_prompt_has_no_internal_and_clean_letter_used(monkeypatch):
    letter = ("Kính gửi Sở Công Thương Đà Nẵng, Công ty TNHH Sâm Sâm trân "
              "trọng đăng ký tham gia hội chợ với Mật ong sâm 300ml.")
    fake = _Chat(letter)
    monkeypatch.setattr(llm_gateway, "chat", fake)
    r = _build(llm=True)
    assert r["problems"] == [] and letter in r["payload"]
    prompt = "\n".join(m["content"] for m in fake.calls[0][1])
    internal_bits = [ln[2:].strip() for ln in r["internal"].splitlines()
                     if ln.startswith(("- [ ] ", "- SKU"))]
    assert internal_bits and not [b for b in internal_bits if b in prompt]
    assert "savigout" not in prompt.casefold() and "NỘI BỘ" not in prompt
    assert PROG["title"] in prompt and "Mật ong sâm 300ml" in prompt


# ---------------------------------------------------------------- egress


def test_only_da_hoso_has_egress_and_declared():
    import sys
    sys.path.insert(0, str(ROOT / "scripts"))
    import dpia_draft
    for mod in ("da_radar", "da_hoso", "da_b2b", "da_pmo", "da_cr"):
        tree = ast.parse((ROOT / "agents" / f"{mod}.py").read_bytes()
                         .decode("utf-8"))
        assert dpia_draft._is_egress(tree) is (mod == "da_hoso"), mod
    flows = json.loads((ROOT / "data" / "data_flow_map.json").read_bytes()
                       .decode("utf-8"))["flows"]
    df = [f for f in flows if "agents/da_hoso.py" in f["modules"]]
    assert len(df) == 1 and df[0]["cross_border"] is True
    assert df[0]["class"] == "xanh" and "--llm" in df[0]["recipients"]


def test_no_send_path_grep():
    src = (ROOT / "agents" / "da_hoso.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|email\.mime|httpx|requests|"
                         r"urllib\.request|webbrowser", src)


# ---------------------------------------------------------------- DB helpers


def _program(db, n=1, title=None):
    url = f"https://mau.example.gov/ct-{n}"
    iid = db.execute(
        "insert into intel_items (url, domain, source, tier, title,"
        " content_sha256, topics) values (%s, 'mau.example.gov', 'fx', 'A',"
        " %s, encode(sha256(convert_to(%s, 'UTF8')), 'hex'),"
        " '{chuong_trinh}') returning id",
        (url, title or PROG["title"], url)).fetchone()[0]
    return db.execute(
        "insert into programs (intel_item_id, title, organizer, deadline,"
        " url, source, tier) values (%s, %s, %s, %s, %s, 'fx', 'A')"
        " returning id", (iid, title or PROG["title"], PROG["organizer"],
                          PROG["deadline"], url)).fetchone()[0]


def _count(db, table, where="true", params=()):
    return db.execute(f"select count(*) from {table} where {where}",
                      params).fetchone()[0]


def _use_db(monkeypatch, db):
    monkeypatch.setattr(da_hoso, "connect", lambda: TxConn(db))


def _draft_submit(db, monkeypatch, tmp_path, pid, tpl="hoi_cho"):
    _use_db(monkeypatch, db)
    rc = da_hoso.main(["--draft", str(pid), "--template", tpl, "--submit",
                       "--out-dir", str(tmp_path)])
    qid = db.execute("select max(id) from approval_queue where object_id ="
                     " %s", (f"program:{pid}:{tpl}",)).fetchone()[0]
    return rc, qid


# ---------------------------------------------------------------- W83.4 DB/CLI


def test_cli_template_unknown_exit2_before_connect(monkeypatch):
    monkeypatch.setattr(da_hoso, "connect", lambda: pytest.fail("connect"))
    for argv in (["--draft", "1", "--template", "la"],
                 ["--checklist", "1"],
                 ["--draft", "1", "--checklist", "1", "--template", "ocop"],
                 ["--export", "1"], ["--checklist", "1", "--template",
                                     "ocop", "--submit"],
                 ["--verify-submit", "x", "f.md"]):
        with pytest.raises(SystemExit) as e:
            da_hoso.main(argv)
        assert e.value.code == 2, argv


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(da_hoso, "connect", lambda: None)
    assert da_hoso.main(["--checklist", "1", "--template", "ocop"]) == 2


def test_cli_program_missing_exit1(db, monkeypatch, tmp_path):
    _use_db(monkeypatch, db)
    assert da_hoso.main(["--checklist", "999999", "--template", "ocop",
                         "--out-dir", str(tmp_path)]) == 1


def test_cli_checklist_internal_file_only(db, monkeypatch, tmp_path):
    pid = _program(db)
    _use_db(monkeypatch, db)
    assert da_hoso.main(["--checklist", str(pid), "--template", "ocop",
                         "--out-dir", str(tmp_path)]) == 0
    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == [f"da-hoso-{pid}-ocop-noi-bo.md"]
    assert _count(db, "approval_queue") == 0


def test_cli_submit_one_pending_no_self_approve(db, monkeypatch, tmp_path):
    pid = _program(db)
    n_appr = _count(db, "approvals")
    rc, qid = _draft_submit(db, monkeypatch, tmp_path, pid)
    assert rc == 0 and qid is not None
    rows = db.execute("select block, object_type, status, created_by, payload"
                      " from approval_queue").fetchall()
    assert len(rows) == 1
    assert rows[0][:4] == ("projects", "program_application", "pending",
                           "agent:da_hoso")
    disk = (tmp_path / f"da-hoso-{pid}-hoi_cho.md").read_bytes()
    assert disk.decode("utf-8") == rows[0][4]          # file nháp = bản nộp
    assert _count(db, "approvals") == n_appr
    rc2, qid2 = _draft_submit(db, monkeypatch, tmp_path, pid)
    assert rc2 == 1 and qid2 == qid                    # trùng pending
    assert _count(db, "approval_queue") == 1


def test_cli_ngoc_linh_template_blocks_submit(db, monkeypatch, tmp_path):
    doc = json.loads(da_hoso.TEMPLATES_FILE.read_bytes().decode("utf-8"))
    doc["company_intro"]["text"] += " Sản phẩm từ sâm Ngọc Linh."
    tf = tmp_path / "tpl.json"
    tf.write_bytes(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    monkeypatch.setattr(da_hoso, "TEMPLATES_FILE", tf)
    calls = []
    monkeypatch.setattr(director, "submit",
                        lambda *a, **kw: calls.append(1) or 1)
    pid = _program(db)
    out = tmp_path / "out"
    rc, qid = _draft_submit(db, monkeypatch, out, pid)
    assert rc == 1 and calls == [] and qid is None
    text = (out / f"da-hoso-{pid}-hoi_cho.md").read_text(encoding="utf-8")
    assert text.startswith("> **CẢNH BÁO") and "ngoc_linh_chua_xac_nhan" in text
    r = da_hoso.build(PROG, doc["templates"]["hoi_cho"], GOLDEN,
                      intro=doc["company_intro"])
    assert "guardrail: ngoc_linh_chua_xac_nhan" in r["problems"]


# ---------------------------------------------------------------- W83.5


def _approve(db, qid, decision="approved"):
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, decision)
    assert ok, msg


def _export(db, monkeypatch, qid, out):
    _use_db(monkeypatch, db)
    return da_hoso.main(["--export", str(qid), "--out", str(out)])


def _vs(db, monkeypatch, qid, f):
    _use_db(monkeypatch, db)
    return da_hoso.main(["--verify-submit", str(qid), str(f)])


def test_export_only_approved_and_verify_submit(db, monkeypatch, tmp_path,
                                                capsys):
    pid = _program(db)
    _, qid = _draft_submit(db, monkeypatch, tmp_path, pid)
    payload = db.execute("select payload from approval_queue where id = %s",
                         (qid,)).fetchone()[0]
    out = tmp_path / "nop" / "ban-nop.md"
    assert _export(db, monkeypatch, qid, out) == 1 and not out.exists()
    assert _vs(db, monkeypatch, qid, tmp_path / f"da-hoso-{pid}-hoi_cho.md") \
        == 1                                       # pending → không KHỚP
    _approve(db, qid)
    capsys.readouterr()
    assert _export(db, monkeypatch, qid, out) == 0
    assert out.read_bytes() == payload.encode("utf-8")
    assert b"\r\n" not in out.read_bytes()
    assert _vs(db, monkeypatch, qid, out) == 0
    assert "KHỚP bản đã duyệt" in capsys.readouterr().out
    raw = out.read_bytes()
    i = raw.index("Hội chợ".encode())
    variants = {
        "1-ky-tu": raw[:i] + "Hội chơ".encode()
        + raw[i + len("Hội chợ".encode()):],
        "crlf-cuoi": raw + b"\r\n",
        "khoang-trang": raw + b" ",
        "crlf-toan-bo": raw.replace(b"\n", b"\r\n"),
        "bom": b"\xef\xbb\xbf" + raw,
        "byte-hong": b"\xff" + raw,
        "rong": b""}
    for name, data in variants.items():
        f = tmp_path / f"sua-{name}.md"
        f.write_bytes(data)
        capsys.readouterr()
        assert _vs(db, monkeypatch, qid, f) == 1, name
        assert "KHÔNG nộp" in capsys.readouterr().err, name
    assert _vs(db, monkeypatch, qid, tmp_path / "khong-co.md") == 1
    assert _vs(db, monkeypatch, 999999, out) == 1
    # Soạn lại cùng chương trình → mục mới PENDING: file bản cũ KHÔNG được
    # báo KHỚP cho mục mới.
    _, qid2 = _draft_submit(db, monkeypatch, tmp_path, pid)
    assert qid2 != qid and _vs(db, monkeypatch, qid2, out) == 1


def test_export_rejected_and_wrong_type(db, monkeypatch, tmp_path):
    pid = _program(db, 2, "[MẪU] Chương trình OCOP 2026")
    _, qid = _draft_submit(db, monkeypatch, tmp_path, pid, "ocop")
    _approve(db, qid, "rejected")
    f = tmp_path / f"da-hoso-{pid}-ocop.md"
    out = tmp_path / "x.md"
    assert _export(db, monkeypatch, qid, out) == 1 and not out.exists()
    assert _vs(db, monkeypatch, qid, f) == 1
    cr_payload = "# CR MẪU\n\nXung đột lợi ích: GỢI Ý.\n"
    cq = director.submit(TxConn(db), "projects", "change_request",
                         object_id="cr:mau000000001", title="CR MẪU",
                         payload=cr_payload, created_by="agent:da_cr")
    _approve(db, cq)
    assert aq.verify(db, cq, cr_payload) is True
    assert _export(db, monkeypatch, cq, out) == 1 and not out.exists()
    f2 = tmp_path / "cr.md"
    f2.write_bytes(cr_payload.encode("utf-8"))
    assert _vs(db, monkeypatch, cq, f2) == 1


def test_verify_submit_oversize_rejected(db, monkeypatch, tmp_path):
    f = tmp_path / "big.md"
    f.write_bytes(b"a" * (da_hoso.MAX_SUBMIT_BYTES + 1))
    assert _vs(db, monkeypatch, 1, f) == 1


def test_export_stale_approved_version_blocked(db, monkeypatch, tmp_path):
    """Bản duyệt CŨ của cùng chương trình (đã có bản duyệt mới hơn) không
    được xuất/báo KHỚP — chỉ bản duyệt mới nhất có hiệu lực."""
    pid = _program(db)
    _, q1 = _draft_submit(db, monkeypatch, tmp_path / "v1", pid)
    _approve(db, q1)
    old = tmp_path / "v1.md"
    assert _export(db, monkeypatch, q1, old) == 0
    db.execute("update programs set organizer = 'Sở MẪU khác' where id = %s",
               (pid,))
    _, q2 = _draft_submit(db, monkeypatch, tmp_path / "v2", pid)
    assert q2 != q1
    _approve(db, q2)
    out = tmp_path / "x.md"
    assert _export(db, monkeypatch, q1, out) == 1 and not out.exists()
    assert _vs(db, monkeypatch, q1, old) == 1
    assert _export(db, monkeypatch, q2, out) == 0
    assert _vs(db, monkeypatch, q2, out) == 0 and _vs(db, monkeypatch, q2,
                                                       old) == 1
