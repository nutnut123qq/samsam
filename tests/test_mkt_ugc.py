"""v6.4 W64.5 — MKT-07 UGC/review (`agents.mkt_ugc`): phân loại, đề xuất trả
lời không lặp claim sức khỏe của khách, xin phép/tái sử dụng UGC chỉ khi có
consent `marketing` (v5.2), không chép nội dung khách.

File review `tests/fixtures/mkt/review_shopee_MAU.csv` là dữ liệu TỔNG HỢP
(mã `FAKEREV*`, người mua/SĐT/email GIẢ). Phần DB: schema tạm + rollback
(`tests.test_fp_pnl.fpa_conn`).
"""

import json
from pathlib import Path

import pytest

from agents import mkt_ugc as mu
from ingest import crm
from pipelines import approval_queue as aq
from pipelines import guardrail
from pipelines.llm_gateway import _strip_accents
from tests.test_fp_pnl import _TxConn, fpa_conn

ROOT = Path(__file__).resolve().parent.parent
REVIEWS = ROOT / "tests" / "fixtures" / "mkt" / "review_shopee_MAU.csv"
SALT = "salt-test-v64-0123456789"
GOUT = "uống Saphraton hết đau khớp, chữa được gout"
# Không được lọt ra stdout/payload: PII giả + nội dung khách.
LEAK = ("0901234567", "nguoimuagia@example.com", "NGUOI MUA GIA", "FAKEREV",
        "đau khớp", "gout", "thất vọng", "Giao chậm", "Rượu sâm biếu",
        "báo giá sỉ", "thơm ngon")


@pytest.fixture(scope="module")
def rules():
    return mu.load_rules()


def _fold(s):
    return _strip_accents(" ".join(s.casefold().split()))


# ---------- luật + template ----------

def test_templates_pass_publish_every_channel(rules):
    assert set(mu.TEMPLATE_KEYS) <= set(rules["templates"])
    raw = json.loads((ROOT / "data" / "ugc_rules.json")
                     .read_text(encoding="utf-8"))
    for ch in ("shopee", "tiktok", "facebook", "zalo"):
        for k, t in rules["templates"].items():
            g = guardrail.check_publish(t, channel=ch, content_type="post",
                                        is_ai=False)
            assert g["ok"] is True, (ch, k, g["violations"])
    # câu sức khỏe/rượu TÁI DÙNG channels.json — không viết câu thứ hai
    ch_t = json.loads((ROOT / "data" / "channels.json")
                      .read_text(encoding="utf-8"))["templates"]
    assert rules["templates"]["health_san"] == ch_t["health_san"]
    assert not set(raw["templates"]) & {"health", "alcohol", "health_san",
                                        "alcohol_san"}
    assert "NHÁP" in raw["_doc"] and "Pháp chế" in raw["_doc"]


@pytest.mark.parametrize("mut", [
    {"la": 1}, {"templates": {"khen": "a"}}, {"health_terms": []},
    {"review_columns": {"shopee": {"columns": {}, "drop": []}}}])
def test_load_rules_fail_closed(tmp_path, mut):
    doc = json.loads((ROOT / "data" / "ugc_rules.json")
                     .read_text(encoding="utf-8"))
    doc.update(mut)
    p = tmp_path / "u.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(mu.UgcConfigError):
        mu.load_rules(p)
    p.write_text("{", encoding="utf-8")
    with pytest.raises(mu.UgcConfigError):
        mu.load_rules(p)


def test_classify_each_class(rules):
    c = mu.classify
    assert c("Rượu sâm biếu sếp, sếp khen", 5, rules) == "ruou"
    assert c(GOUT, 5, rules) == "claim_suc_khoe"
    assert c("Sản phẩm giúp tôi ngủ ngon hơn", 5, rules) == "claim_suc_khoe"
    assert c("Giao chậm, hộp bị vỡ", 4, rules) == "khieu_nai"
    assert c("Hàng dở", 5, rules) == "che"
    assert c("Đã nhận", 1, rules) == "che"            # ≤ 2 sao
    assert c("Thơm ngon, hài lòng", 3, rules) == "khen"
    assert c("Đã nhận", 5, rules) == "khen"           # ≥ 4 sao
    assert c("Shop báo giá sỉ bao nhiêu ạ", 3, rules) == "hoi_gia"
    assert c("Đã nhận", 3, rules) == "khac"
    # social_mentions: chỉ nhãn (DPIA chưa ký → không có text)
    assert c(None, None, rules, ["hoi_suc_khoe"]) == "claim_suc_khoe"
    assert c(None, None, rules, ["hoi_ruou", "khen"]) == "ruou"
    assert c(None, None, rules, ["khen"]) == "khen"
    assert c(None, None, rules, ["khac"]) == "khac"


def test_health_claim_reply_no_echo(rules):
    for san, ch in ((True, "shopee"), (False, "facebook")):
        p = mu.propose(GOUT, 5, ch, rules, san=san)
        assert p["lop"] == "claim_suc_khoe" and p["code"] is None, p
        assert p["reply"] == rules["templates"]["health_san" if san
                                                else "health"]
        f = _fold(p["reply"])
        for w in ("đau khớp", "gout", "chữa", "saphraton"):
            assert _fold(w) not in f, w
        assert guardrail.check_publish(p["reply"], channel=ch,
                                       content_type="post",
                                       is_ai=False)["ok"] is True
    ok, hits = mu.no_claim_echo("Dạ, Sâm Sâm mừng vì hết đau khớp ạ", GOUT,
                                rules["health_terms"])
    assert not ok and {"đau", "khớp"} <= set(hits)
    ok, hits = mu.no_claim_echo("Da, mung vi het dau khop", "uong het dau "
                                "khop", rules["health_terms"])
    assert not ok and "khop" in hits
    ok, hits = mu.no_claim_echo("Dạ, cảm ơn Quý khách", GOUT,
                                rules["health_terms"])
    assert ok and hits == []
    assert mu.propose("Đã nhận", 3, "shopee", rules, san=True)["reply"] is None


def test_propose_and_process_enforce_no_echo(rules, monkeypatch):
    """propose() PHẢI gọi no_claim_echo: template (sửa nhầm sau này) lặp
    cụm sức khỏe của khách → UGC_ECHO, process() xếp 'chan', 0 mục hàng
    duyệt — bỏ khối kiểm trong propose thì test này đỏ."""
    echo = "Dạ, Sâm Sâm mừng vì Quý khách đỡ mệt mỏi ạ"
    bad = {**rules, "templates": {**rules["templates"], "khen": echo,
                                  "health": echo, "health_san": echo}}
    for text in ("Uống thấy đỡ mệt mỏi, thơm ngon", "uong do met moi, thom"):
        for san in (True, False):
            p = mu.propose(text, 5, "shopee", bad, san=san)
            assert p["code"] == "UGC_ECHO", (text, san, p)
    calls = []
    monkeypatch.setattr(mu, "_submit", lambda *a, **k: calls.append(a) or 1)
    items = [{"key": "r1", "source": "`review#1`", "text": "Uống thấy đỡ mệt"
              " mỏi, thơm ngon", "stars": 5}]
    st = mu.process(items, "shopee", bad, salt=SALT, san=True,
                    conn=object(), by="mkt", dcfg={})
    assert st["chan"] == [("`review#1`", "UGC_ECHO")]
    assert st["moi"] == [] and calls == []
    # template gốc không lặp → cùng review được soạn bình thường
    st = mu.process(items, "shopee", rules, salt=SALT, san=True,
                    conn=object(), by="mkt", dcfg={})
    assert st["chan"] == [] and len(calls) == 1


def test_read_reviews_masks_and_errors(rules, tmp_path):
    rows, errs, sha = mu.read_reviews(REVIEWS, "shopee", rules)
    assert errs == [] and len(rows) == 7 and len(sha) == 64
    blob = json.dumps(rows, ensure_ascii=False)
    assert "0901234567" not in blob and "nguoimuagia@example.com" not in blob
    assert "NGUOI MUA GIA" not in blob             # cột người mua bị bỏ
    lops = [mu.classify(r["text"], r["stars"], rules) for r in rows]
    assert lops == ["khen", "che", "khieu_nai", "claim_suc_khoe", "hoi_gia",
                    "ruou", "khac"]
    bad = tmp_path / "r.csv"
    bad.write_text("Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá,"
                   "SĐT người mua\nA,5,x,t,0909999999\n", encoding="utf-8")
    rows, errs, _ = mu.read_reviews(bad, "shopee", rules)
    assert rows == [] and any("cột lạ" in e for e in errs)
    assert "0909999999" not in "".join(errs)
    bad.write_text("Mã đánh giá,Số sao,Thời gian đánh giá\nA,5,t\n",
                   encoding="utf-8")
    assert any("noi_dung: thiếu cột" in e
               for e in mu.read_reviews(bad, "shopee", rules)[1])
    bad.write_text("Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá\n"
                   "A,6,bí mật khách,t\nA,5,x,t\nA,5,y,t\n",
                   encoding="utf-8")
    errs = mu.read_reviews(bad, "shopee", rules)[1]
    assert "dòng 2 cột so_sao: phải số nguyên 1..5" in errs
    assert "dòng 4 cột ma_danh_gia: trùng trong file" in errs
    assert "bí mật khách" not in "".join(errs)
    bad.write_text("Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá\n"
                   "A,5," + "a" * (mu.MAX_TEXT + 1) + ",t\n", encoding="utf-8")
    assert mu.read_reviews(bad, "shopee", rules)[1] == [
        f"dòng 2 cột noi_dung: quá {mu.MAX_TEXT} ký tự"]
    assert mu.read_reviews(bad, "tiktok", rules)[1]   # header shopee ≠ tiktok
    # ô > csv field_limit → lỗi file, không traceback (OWASP v6.4)
    bad.write_text("Mã đánh giá,Số sao,Nội dung đánh giá,Thời gian đánh giá\n"
                   'A,5,"' + "a" * 200_000 + '",t\n', encoding="utf-8")
    assert mu.read_reviews(bad, "shopee", rules)[1] == [
        "file CSV hỏng (ô quá lớn hoặc sai định dạng)"]


# ---------- CLI không DB ----------

@pytest.mark.parametrize("argv", [
    [], ["--mentions", "--by", "a"], ["--reviews", "x.csv", "--by", "a"],
    ["--reuse", "ugc-0000000000000000", "--by", "a"],
    ["--reviews", "x.csv", "--channel", "shopee"],
    ["--mentions", "--since", "2026-13-01", "--by", "a"],
    ["--mentions", "--since", "2026-10-01", "--reuse", "x", "--by", "a"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(mu, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        mu.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_salt_and_dry_run_no_db_no_leak(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(mu, "connect", lambda: calls.append(1))
    monkeypatch.delenv("INTEL_HASH_SALT", raising=False)
    argv = ["--reviews", str(REVIEWS), "--channel", "shopee", "--by", "a",
            "--dry-run"]
    assert mu.main(argv) == 1
    assert "INTEL_HASH_SALT" in capsys.readouterr().out and calls == []
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    assert mu.main(argv) == 0
    out = capsys.readouterr().out
    assert calls == [] and "6 đề xuất" in out and "khac 1" in out
    for s in LEAK:
        assert s not in out, s


# ---------- DB thật ----------

@pytest.fixture
def db(monkeypatch):
    monkeypatch.delenv("GUARDRAIL_LLM_MODEL", raising=False)
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    yield from fpa_conn()


def _q(db, otype="ugc_reply"):
    return db.execute("select id, object_id, title, risk, status, payload,"
                      " created_by from approval_queue where object_type = %s"
                      " order by id", (otype,)).fetchall()


def _ref(db, lop):
    return next(o for _, o, t, *_ in _q(db) if f"[lop={lop}]" in t)


def test_alcohol_class_hidden_in_title_payload(rules):
    p = mu.propose("Rượu sâm biếu sếp", 5, "shopee", rules, san=True)
    assert p["lop"] == "ruou" and p["code"] is None
    for text in (mu.render_reply(p, "shopee", "x"), mu._title("ruou", "shopee")):
        assert guardrail.check(text)["ok"] is True and "ruou" not in text


def _contact(db, n):
    return db.execute(
        "insert into contacts (phone_hmac, phone_enc, source, created_by)"
        " values (%s, 'gAAAAAmau', 'manual', 'Lan') returning id",
        (f"{n:064x}",)).fetchone()[0]


def test_db_reviews_reuse_flow(db, monkeypatch, capsys):
    monkeypatch.setattr(mu, "connect", lambda: _TxConn(db))
    argv = ["--reviews", str(REVIEWS), "--channel", "shopee", "--by",
            "mxh lap"]
    assert mu.main(argv) == 0
    out = capsys.readouterr().out
    rows = _q(db)
    assert len(rows) == 6 and all(r[3] == "medium" and r[4] == "pending"
                                  and r[6] == "mxh lap" for r in rows)
    for _, oid, title, _, _, payload, _ in rows:
        assert oid.startswith("ugc-") and len(oid) == 20
        for s in LEAK:
            assert s not in payload and s not in title, s
        assert "người phụ trách đăng/gửi TAY" in payload
    for s in LEAK:
        assert s not in out, s
    tx = _TxConn(db)
    ok, _msg = aq.auto_approve(tx, rows[0][0])
    assert ok is False                                  # không có luật
    assert mu.main(argv) == 0                           # nạp lại → skip
    assert "skip 6" in capsys.readouterr().out and len(_q(db)) == 6
    khen, claim = _ref(db, "khen"), _ref(db, "claim_suc_khoe")
    ruou = _ref(db, "sp_cam_qc")
    # xin phép dùng lại
    assert mu.main(["--reuse-request", khen, "--by", "mxh lap"]) == 0
    assert len(_q(db)) == 7 and "xin_phep" in _q(db)[-1][2]
    for r in (claim, ruou):
        assert mu.main(["--reuse-request", r, "--by", "mxh lap"]) == 1
        assert "UGC_SENSITIVE" in capsys.readouterr().out
    assert mu.main(["--reuse-request", "ugc-ffffffffffffffff", "--by",
                    "a"]) == 1
    assert "UGC_UNKNOWN_REF" in capsys.readouterr().out
    # tái sử dụng: không consent / consent rút → chặn, 0 ghi
    c1 = _contact(db, 1)
    n0 = len(_q(db, "ugc_reuse")) + len(_q(db))
    reuse = ["--reuse", khen, "--contact-id", str(c1), "--by", "mxh lap"]
    assert mu.main(reuse) == 1
    assert "UGC_NO_CONSENT" in capsys.readouterr().out
    crm.record_consent(db, c1, "marketing", True, "form_giay", "Lan",
                       evidence_ref="BB-MAU-01", policy_version="nhap-2026-10")
    crm.record_consent(db, c1, "marketing", False, "form_giay", "Lan")
    assert mu.main(reuse) == 1 and len(_q(db, "ugc_reuse")) + len(_q(db)) \
        == n0
    # consent cskh không thay được marketing
    crm.record_consent(db, c1, "cskh", True, "form_giay", "Lan",
                       evidence_ref="BB-MAU-02", policy_version="nhap-2026-10")
    assert mu.main(reuse) == 1
    crm.record_consent(db, c1, "marketing", True, "form_giay", "Lan",
                       evidence_ref="BB-MAU-03", policy_version="nhap-2026-10")
    assert mu.main(reuse) == 0
    [(_qid, oid, _title, risk, st, payload, _)] = _q(db, "ugc_reuse")
    assert (risk, st) == ("high", "pending") and oid == f"reuse-{khen}-c{c1}"
    assert f"contact_id: {c1}" in payload and "gAAAAA" not in payload
    assert mu.main(reuse) == 0 and "[skip]" in capsys.readouterr().out
    # lớp nhạy cảm + có consent → vẫn chặn
    assert mu.main(["--reuse", claim, "--contact-id", str(c1), "--by",
                    "a"]) == 1
    assert "UGC_SENSITIVE" in capsys.readouterr().out
    assert len(_q(db, "ugc_reuse")) == 1


def test_db_mentions_labels_only(db, monkeypatch, capsys):
    monkeypatch.setattr(mu, "connect", lambda: _TxConn(db))
    iid = db.execute("insert into intel_imports (kind, file_name, file_sha256,"
                     " row_count) values ('social', 'MAU', 'sha-mau', 3)"
                     " returning id").fetchone()[0]
    for ch, labels, sens, h in (("fanpage", ["khen"], False, "a"),
                                ("zalo_oa", ["hoi_suc_khoe"], True, "b"),
                                ("tiktok", ["khac"], False, "c")):
        db.execute("insert into social_mentions (import_id, channel, kind,"
                   " posted_at, msg_hash, labels, sensitive) values (%s, %s,"
                   " 'comment', '2026-10-05 10:00+07', %s, %s, %s)",
                   (iid, ch, h * 64, labels, sens))
    argv = ["--mentions", "--since", "2026-10-01", "--by", "mxh lap"]
    assert mu.main(argv + ["--dry-run"]) == 0 and _q(db) == []
    assert mu.main(argv) == 0
    rows = _q(db)
    assert len(rows) == 2
    titles = sorted(r[2] for r in rows)
    assert any("[lop=khen] [kenh=facebook]" in t for t in titles)
    assert any("[lop=claim_suc_khoe] [kenh=zalo]" in t for t in titles)
    assert all("social_mentions#" in r[5] for r in rows)
    assert mu.main(["--mentions", "--since", "2026-10-06", "--by",
                    "a"]) == 0
    assert len(_q(db)) == 2
