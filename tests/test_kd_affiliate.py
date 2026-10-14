"""v5.4 KD-A8 affiliate đại lý — mã ngẫu nhiên, kit từ nội dung đã duyệt,
hoa hồng (rượu online = 0), phát hành qua hàng duyệt, ghi nhận đơn qua mã
idempotent. Đại lý = MẪU `data/dealer_regions.json`. Phần DB: schema tạm +
`docs/schema.sql` rồi ROLLBACK (như `tests/test_mkt_koc.py::db`)."""

import datetime as dt
import re
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from agents import acc_ar
from agents import kd_affiliate as ka
from ingest import crm
from ingest import market_csv as mc
from pipelines import approval_queue as aq
from pipelines import guardrail, store
from tests.test_fp_pnl import _TxConn, fpa_conn

ROOT = Path(__file__).resolve().parent.parent
SRC = (ROOT / "agents" / "kd_affiliate.py").read_text(encoding="utf-8")
HONEY = "mat-ong-sam-300ml"
SAPH = "saphraton-20v"
RUOU = "ruou-sam-chai-thuy-tinh-500ml"
HONEY_TEXT = ("Mật ong sâm 300ml — quà biếu Tết ấm áp cho gia đình. #quangcao "
              "Nội dung có sử dụng AI")
GOLD = {HONEY: {"category": "food"}, SAPH: {"category": "tpbvsk"},
        RUOU: {"category": "alcohol"}}
RD = {(HONEY, "shopee"): "TP_THUONG", (HONEY, "web"): "TP_THUONG",
      (HONEY, "tiktok"): "CAM", (RUOU, "shopee"): "CAM"}
DEALER = {"code": "DLM01", "name": "Đại lý MẪU 01", "region": "MIEN_TRUNG",
          "status": "active", "commission_default": Decimal(10),
          "source": "dealer_regions.json"}
CODE = "SSABCDEFGH23"


def _d(i=5, text=HONEY_TEXT, sku=HONEY, **kw):
    return {"id": i, "status": "approved", "sku": sku, "content_type": "ads",
            "text": text, "is_ai": True, "verified": True,
            "guardrail": {"ok": True, "matched_claims": []}, **kw}


def _kit(drafts=None, dealer=DEALER, channel="shopee", rd=RD):
    return ka.build_kit(dealer, channel, CODE,
                        [_d()] if drafts is None else drafts, GOLD, rd)


# ---------- mã ----------

def test_new_code_random_pattern_unique():
    codes = [ka.new_code() for _ in range(2000)]
    assert len(set(codes)) == 2000
    pat = re.compile(r"^SS[A-HJ-NP-Z2-9]{10}$")
    for c in codes:
        assert pat.fullmatch(c) and ka.CODE_RE.fullmatch(c)
        assert not c.startswith("-") and "DLM01" not in c
    assert len(set(ka.ALPHABET)) == len(ka.ALPHABET) == 32
    assert not set("0O1I") & set(ka.ALPHABET)
    assert len(ka.ALPHABET) ** ka.CODE_LEN >= 2 ** 50


def test_new_code_injectable_and_no_random_module():
    class Fake:
        @staticmethod
        def choice(seq):
            return seq[0]
    assert ka.new_code(rand=Fake) == "SS" + "A" * 10
    assert ka.new_code(rand=Fake) == ka.new_code(rand=Fake)
    assert "import secrets" in SRC
    assert not re.search(r"^import random|from random|random\.", SRC, re.MULTILINE)


def test_no_send_no_llm_in_source():
    pat = (r"smtplib|import httpx|import requests|urllib\.request|\.post\(|"
           r"llm_gateway|openai|guardrail_llm|decide\(|auto_approve")
    assert not re.search(pat, SRC)


def test_link_only_web():
    assert ka.link_for(CODE, "web") == \
        f"https://samsamngoclinh.com/?coupon={CODE}"
    assert ka.link_for(CODE, "shopee") is None
    assert ka.link_for(CODE, "tiktok") is None


# ---------- hoa hồng ----------

def test_commission_alcohol_zero_flag():
    r = ka.commission_line(DEALER, "alcohol", 1_000_000, "active", False)
    assert r["rate_pct"] == 0 and r["commission_vnd"] == 0
    assert "ruou_online" in r["flags"] and r["status"] == "tinh"


def test_commission_half_up():
    r = ka.commission_line(DEALER, "tpbvsk", 1_234_567, "active", False)
    assert r["rate_pct"] == Decimal(10)
    assert r["commission_vnd"] == 123_457 and r["flags"] == []
    r = ka.commission_line({**DEALER, "commission_default": Decimal(5)},
                           "food", 10_010, "active", False)
    assert r["commission_vnd"] == 501          # 500.5 → 501


@pytest.mark.parametrize("dealer,cat,cst,cancel,flag,status", [
    ({**DEALER, "status": "paused"}, "tpbvsk", "active", False,
     "dai_ly_ngung", "tinh"),
    (None, "tpbvsk", "active", False, "dai_ly_ngung", "tinh"),
    (DEALER, None, "active", False, "thieu_sku", "tinh"),
    (DEALER, "tpbvsk", "pending", False, "ma_chua_kich_hoat", "tinh"),
    (DEALER, "tpbvsk", "void", False, "ma_chua_kich_hoat", "tinh"),
    (DEALER, "tpbvsk", "active", True, "huy", "huy"),
])
def test_commission_zero_cases(dealer, cat, cst, cancel, flag, status):
    r = ka.commission_line(dealer, cat, 1_000_000, cst, cancel)
    assert r["commission_vnd"] == 0 and flag in r["flags"]
    assert r["status"] == status


def test_commission_revoked_still_counted_flagged():
    r = ka.commission_line(DEALER, "food", 100_000, "revoked", False)
    assert r["commission_vnd"] == 10_000 and "ma_da_thu_hoi" in r["flags"]


def test_parity_acc_ar_alcohol_online_zero():
    """2 nguồn tỷ lệ (crm A8 / dealer_commission.json acc_ar) đều cho rượu
    online = 0 — A8 chỉ dùng crm."""
    cfg, why = acc_ar.load_config()
    assert why is None
    assert {"category": "alcohol", "channel": "online"} in cfg["zero_rules"]
    e = {"kind": "phat_sinh", "doc_date": date(2026, 10, 1),
         "sku_key": RUOU, "dealer_code": "DLM01", "channel": "online",
         "dealer_type": "doanh_nghiep", "amount_vnd": 1_000_000}
    [row] = acc_ar.commission([e], {RUOU: "alcohol"}, cfg, date(2026, 10, 1),
                              date(2026, 11, 1))
    assert row["hoa_hong"] == 0 and "ruou_online" in row["flags"]
    assert crm.commission_rate(DEALER, "alcohol", online=True) == 0
    assert "dealer_commission" not in SRC.split('"""', 2)[2]


# ---------- kit ----------

def test_build_kit_ok_contains_code_not_name():
    r = _kit()
    assert r["code"] is None and re.fullmatch(r"[0-9a-f]{12}", r["sha12"])
    kit = r["kit"]
    assert CODE in kit and HONEY_TEXT in kit and "(ĐẠI LÝ MẪU)" in kit
    assert DEALER["name"] not in kit and "DLM01" in kit
    assert "BẢN NHÁP — hệ thống không gửi" in kit and "gửi TAY" in kit
    assert "coupon=" not in kit                     # sàn: chỉ mã
    assert guardrail.check(kit)["ok"] is True
    web = _kit(channel="web")
    assert web["code"] is None
    assert f"https://samsamngoclinh.com/?coupon={CODE}" in web["kit"]
    manual = _kit(dealer={**DEALER, "source": "manual"})
    assert "(ĐẠI LÝ MẪU)" not in manual["kit"]


@pytest.mark.parametrize("kw,code", [
    ({"dealer": None}, "AFF_DEALER"),
    ({"dealer": {**DEALER, "status": "ended"}}, "AFF_DEALER"),
    ({"drafts": [_d(sku=RUOU)]}, "AFF_RUOU_ONLINE"),
    ({"drafts": [_d(), _d(6, sku=RUOU)]}, "AFF_RUOU_ONLINE"),
    ({"drafts": []}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [_d(i) for i in range(1, 8)]}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [_d(status="pending")]}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [_d(verified=False)]}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [_d(content_type="listing")]}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [_d(sku=None)]}, "AFF_CREATIVE_UNAPPROVED"),
    ({"drafts": [{"id": 9, "status": "khong_ton_tai"}]},
     "AFF_CREATIVE_UNAPPROVED"),
    ({"channel": "tiktok"}, "AFF_READINESS"),
    ({"rd": {}}, "AFF_READINESS"),
    ({"drafts": [_d(sku="sku-la")]}, "AFF_READINESS"),
    ({"drafts": [_d(text="Mật ong sâm chữa khỏi bệnh. #quangcao")]},
     "AFF_GUARDRAIL"),
])
def test_build_kit_block_codes(kw, code):
    r = _kit(**kw)
    assert r["code"] == code and r["code"] in ka.CODES and "kit" not in r


# ---------- CLI không DB ----------

@pytest.mark.parametrize("argv", [
    [],
    ["--issue", "--release", "1", "--by", "x"],
    ["--attribute", "--report", "--from", "2026-10-01", "--to",
     "2026-10-31"],
    ["--issue", "--dealer", "DLM01", "--channel", "shopee", "--draft-ids",
     "1"],                                             # thiếu --by
    ["--issue", "--dealer", "DLM01", "--channel", "shopee", "--draft-ids",
     "1", "--by", "  "],
    ["--release", "3"],
    ["--revoke", "SSABC", "--by", "x"],
    ["--issue", "--dealer", "DLM01", "--channel", "shopee", "--draft-ids",
     "a", "--by", "x"],
    ["--report", "--from", "2026-10-31", "--to", "2026-10-01"],
])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    calls = []
    monkeypatch.setattr(ka, "connect", lambda: calls.append(1))
    with pytest.raises(SystemExit) as e:
        ka.main(argv)
    assert e.value.code == 2 and calls == []


def test_cli_db_down_exit2(monkeypatch, capsys):
    monkeypatch.setattr(ka, "connect", lambda: None)
    assert ka.main(["--attribute"]) == 2
    assert "không kết nối được" in capsys.readouterr().err


# ---------- DB thật ----------

@pytest.fixture
def db(monkeypatch, tmp_path):
    monkeypatch.delenv("GUARDRAIL_LLM_MODEL", raising=False)
    monkeypatch.setattr(ka, "REPORTS_DIR", tmp_path / "reports")
    for conn in fpa_conn():
        crm.load_dealers(conn, crm.load_regions(), "test nap dai ly")
        conn.execute("update sku_master set self_declaration_ok = true,"
                     " allowed_channels = '{shopee,tiktok,web}' where"
                     " sku_key = %s", (HONEY,))
        monkeypatch.setattr(ka, "connect", lambda c=conn: _TxConn(c))
        yield conn


def _draft(db, text=HONEY_TEXT, approve=True):
    g = guardrail.check_publish(text, channel="shopee", content_type="ads",
                                sku=HONEY, is_ai=True)
    did = store.save_draft(_TxConn(db), "brief MẪU", "shopee", text, g,
                           created_by="mkt lap", content_type="ads",
                           sku=HONEY, is_ai=True)
    if approve:
        db.execute("select approve_draft(%s, 'duyet mkt', null)", (did,))
    return did


def _n(db, table):
    return db.execute(f"select count(*) from {table}").fetchone()[0]


def _codes(db):
    return db.execute("select code, dealer_code, channel, status, queue_id"
                      " from affiliate_codes order by id").fetchall()


def _issue(dealer, ids, channel="shopee", extra=()):
    return ka.main(["--issue", "--dealer", dealer, "--channel", channel,
                    "--draft-ids", ",".join(map(str, ids)), "--by",
                    "nv kinh doanh", *extra])


def test_db_issue_release_revoke(db, tmp_path, capsys):
    d1, d2 = _draft(db), _draft(db)
    assert _issue("DLM01", [d1, d2], extra=["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "[dry-run]" in out and HONEY_TEXT in out
    assert _n(db, "affiliate_codes") == 0 and _n(db, "approval_queue") == 0
    assert _issue("DLM01", [d1, d2]) == 0
    assert "[issue]" in capsys.readouterr().out
    [(code, dcode, ch, st, qid)] = _codes(db)
    assert (dcode, ch, st) == ("DLM01", "shopee", "pending")
    assert ka.CODE_RE.fullmatch(code)
    row = db.execute("select block, object_type, object_id, status, payload"
                     " from approval_queue where id = %s", (qid,)).fetchone()
    assert row[:3] == ("sales", "affiliate_program", f"aff-{_cid(db, code)}")
    assert row[3] == "pending" and code in row[4] and HONEY_TEXT in row[4]
    assert "Đại lý MẪU 01" not in row[4]
    # chạy lại cùng (đại lý, kênh) → skip, không sinh mã/mục mới
    assert _issue("DLM01", [d1]) == 0
    assert "[skip]" in capsys.readouterr().out
    assert _n(db, "affiliate_codes") == 1 and _n(db, "approval_queue") == 1
    # release khi chưa duyệt → chặn, mã vẫn pending
    tx = _TxConn(db)
    rel = ["--release", str(qid), "--by", "nguoi phat hanh"]
    assert ka.main(rel) == 1
    assert "AFF_NOT_APPROVED" in capsys.readouterr().out
    assert _codes(db)[0][3] == "pending"
    assert not (tmp_path / "reports").exists()
    # revoke mã pending → lỗi
    assert ka.main(["--revoke", code, "--by", "x"]) == 1
    # NGƯỜI duyệt (trong test) → release
    assert aq.decide(tx, qid, "GD ban hang", "approved") == (True, None)
    assert ka.main(rel) == 0
    assert "gửi TAY" in capsys.readouterr().out
    c = db.execute("select status, activated_by, queue_id from"
                   " affiliate_codes where code = %s", (code,)).fetchone()
    assert c == ("active", "nguoi phat hanh", qid)
    f = tmp_path / "reports" / f"affiliate-kit-DLM01-{qid}.md"
    assert f.read_bytes().decode("utf-8") == row[4]
    # payload lệch bản duyệt → AFF_PAYLOAD_CHANGED
    orig = aq.verify
    aq.verify = lambda *a: False
    try:
        assert ka.release(tx, qid, by="x")["code"] == "AFF_PAYLOAD_CHANGED"
    finally:
        aq.verify = orig
    # revoke active → revoked
    assert ka.main(["--revoke", code.lower(), "--by", "GD ban hang"]) == 0
    assert _codes(db)[0][3] == "revoked"
    assert ka.main(["--revoke", code, "--by", "x"]) == 1
    # sau thu hồi được cấp mã mới cho cùng (đại lý, kênh)
    assert _issue("DLM01", [d1]) == 0
    assert _n(db, "affiliate_codes") == 2
    assert ka.release(tx, 99_999_999, by="x")["code"] == "AFF_NOT_APPROVED"


def _cid(db, code):
    return db.execute("select id from affiliate_codes where code = %s",
                      (code,)).fetchone()[0]


def test_db_rejected_void_and_dealer_ended(db, capsys):
    d1 = _draft(db)
    d_pend = _draft(db, approve=False)
    assert _issue("DLM02", [d_pend]) == 1
    assert "AFF_CREATIVE_UNAPPROVED" in capsys.readouterr().out
    assert _n(db, "affiliate_codes") == 0
    assert _issue("DLM02", [d1]) == 0
    [(_, _, _, _, qid)] = _codes(db)
    assert aq.decide(_TxConn(db), qid, "GD ban hang", "rejected") == \
        (True, None)
    assert ka.main(["--release", str(qid), "--by", "x"]) == 1
    assert "AFF_NOT_APPROVED" in capsys.readouterr().out
    assert _codes(db)[0][3] == "void"
    db.execute("update dealers set status = 'ended' where code = 'DLM04'")
    n_q = _n(db, "approval_queue")
    assert _issue("DLM04", [d1]) == 1
    assert "AFF_DEALER" in capsys.readouterr().out
    assert _n(db, "affiliate_codes") == 1 and _n(db, "approval_queue") == n_q
    assert _issue("NOPE9", [d1]) == 1


def test_db_check_constraints(db):
    import psycopg
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("insert into affiliate_codes (code, dealer_code, channel,"
                   " created_by) values ('SS0OOOOOOOOO', 'DLM01', 'shopee',"
                   " 'x')")
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("insert into affiliate_codes (code, dealer_code, channel,"
                   " created_by) values ('-SABCDEFGHJ', 'DLM01', 'shopee',"
                   " 'x')")
    db.execute("insert into affiliate_codes (code, dealer_code, channel,"
               " created_by) values ('SSAAAAAAAAAA', 'DLM01', 'shopee', 'x')")
    with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
        db.execute("insert into affiliate_codes (code, dealer_code, channel,"
                   " created_by) values ('SSBBBBBBBBBB', 'DLM01', 'shopee',"
                   " 'x')")
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute("update affiliate_codes set status = 'active' where"
                   " code = 'SSAAAAAAAAAA'")     # thiếu activated_at
    sid = db.execute("insert into market_snapshots (channel, export_kind,"
                     " file_name, file_sha256, row_count) values ('shopee',"
                     " 'order', 'f.csv', 'x', 1) returning id").fetchone()[0]
    mr = db.execute("insert into market_rows (snapshot_id, row_no, channel,"
                    " export_kind, raw) values (%s, 2, 'shopee', 'order',"
                    " '{}') returning id", (sid,)).fetchone()[0]
    cid = _cid(db, "SSAAAAAAAAAA")
    sql = ("insert into affiliate_attributions (code_id, dealer_code,"
           " channel, order_id_hash, line_key, market_row_id, category, qty,"
           " amount_vnd, rate_pct, commission_vnd, status) values (%s,"
           " 'DLM01', 'shopee', '0123456789abcdef', 'k', %s, %s, 1, 100, 0,"
           " %s, %s)")
    for cat, com, st in (("alcohol", 1, "tinh"), ("tpbvsk", 1, "huy")):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute(sql, (cid, mr, cat, com, st))
    db.execute(sql, (cid, mr, "alcohol", 0, "tinh"))


# ---------- ghi nhận đơn ----------

ORDER_HDR = ("Mã đơn hàng,Trạng thái đơn hàng,Tên sản phẩm,SKU phân loại hàng,"
             "Số lượng,Giá ưu đãi,Mã giảm giá của Shop")


def _load_order(db, tmp_path, name, lines):
    p = tmp_path / name
    p.write_bytes(("\n".join([ORDER_HDR, *lines]) + "\n").encode("utf-8"))
    m, _ = mc.load_mapping()
    rows, errs, sha = mc.read_export(p, "shopee", "order", m)
    assert errs == []
    mc.load(db, rows, "shopee", "order", name, sha)
    return rows


def _active(db, code, dealer):
    db.execute("insert into affiliate_codes (code, dealer_code, channel,"
               " created_by, status, activated_at, activated_by) values (%s,"
               " %s, 'shopee', 'x', 'active', now(), 'y')", (code, dealer))


def _attr(db):
    return {r[0]: r[1:] for r in db.execute(
        "select line_key, commission_vnd, status, flags, settled, rate_pct"
        " from affiliate_attributions")}


def test_db_attribute_idempotent_cancel_settled_report(db, tmp_path,
                                                       capsys):
    a, b = "SSAAAAAAAAAA", "SSBBBBBBBBBB"
    _active(db, a, "DLM01")
    _active(db, b, "DLM02")
    rows = _load_order(db, tmp_path, "o1.csv", [
        f"FAKE-A1,Hoàn thành,Saphraton,{SAPH},2,299000, {a.lower()} ",
        f"FAKE-A2,Hoàn thành,Rượu,{RUOU},1,500000,{b}",
        f"FAKE-A3,Hoàn thành,Mật ong,{HONEY},1,100000,SSZZZZZZZZZZ"])
    hashes = [r["order_id_hash"] for r in rows]
    tx = _TxConn(db)
    assert ka.attribute(tx) == {"new": 2, "updated": 0, "same": 0,
                                "unknown_code": 1, "web_skipped": 0}
    got = _attr(db)
    assert got[SAPH][:3] == (59_800, "tinh", [])
    assert got[RUOU][0] == 0 and "ruou_online" in got[RUOU][2]
    # chạy lại → không đổi
    assert ka.attribute(tx) == {"new": 0, "updated": 0, "same": 2,
                                "unknown_code": 1, "web_skipped": 0}
    assert _n(db, "affiliate_attributions") == 2
    # snapshot MỚI cùng đơn, đã hủy → updated, vẫn 1 dòng/khóa
    _load_order(db, tmp_path, "o2.csv", [
        f"FAKE-A1,Đã hủy,Saphraton,{SAPH},2,299000,{a}"])
    r = ka.attribute(tx)
    assert (r["new"], r["updated"]) == (0, 1)
    got = _attr(db)
    assert got[SAPH][:2] == (0, "huy") and "huy" in got[SAPH][2]
    assert _n(db, "affiliate_attributions") == 2
    # file quyết toán có đơn rượu → settled
    db.execute("insert into settlement_rows (file_sha256, file_name, channel,"
               " row_no, order_id_hash, order_amount_vnd, payout_vnd) values"
               " (%s, 's.csv', 'shopee', 2, %s, 500000, 450000)",
               ("a" * 64, hashes[1]))
    assert ka.attribute(tx)["updated"] == 1
    assert _attr(db)[RUOU][3] is True
    # mã pending trong file → 0 + ma_chua_kich_hoat
    db.execute("insert into affiliate_codes (code, dealer_code, channel,"
               " created_by) values ('SSCCCCCCCCCC', 'DLM03', 'shopee', 'x')")
    _load_order(db, tmp_path, "o3.csv", [
        f"FAKE-A4,Hoàn thành,Mật ong,{HONEY},3,100000,SSCCCCCCCCCC"])
    assert ka.attribute(tx)["new"] == 1
    p = _attr(db)[HONEY]
    assert p[0] == 0 and "ma_chua_kich_hoat" in p[2]
    # báo cáo BẢN NHÁP, không in hash đơn
    rep = ka.report(tx, date(2000, 1, 1), date(2100, 1, 1))
    assert "BẢN NHÁP" in rep and "DLM01" in rep and "DLM02" in rep
    assert not any(h in rep for h in hashes)
    assert "Đại lý MẪU" not in rep
    today = dt.datetime.now(ka.TZ_VN).date()
    assert ka.main(["--report", "--from", str(today - dt.timedelta(days=2)),
                    "--to", str(today + dt.timedelta(days=2))]) == 0
    out = capsys.readouterr().out
    assert "BẢN NHÁP" in out and not any(h in out for h in hashes)
    assert ka.main(["--attribute"]) == 0
    assert "mới 0" in capsys.readouterr().out


def test_db_report_period_excludes_other_days(db, tmp_path):
    _active(db, "SSAAAAAAAAAA", "DLM01")
    _load_order(db, tmp_path, "o1.csv", [
        f"FAKE-B1,Hoàn thành,Saphraton,{SAPH},1,100000,SSAAAAAAAAAA"])
    ka.attribute(_TxConn(db))
    today = dt.datetime.now(ka.TZ_VN).date()
    old = ka.report(_TxConn(db), date(2000, 1, 1), date(2000, 1, 2))
    assert "(không có dòng)" in old
    now = ka.report(_TxConn(db), today - dt.timedelta(days=1),
                    today + dt.timedelta(days=2))
    assert "| DLM01 | shopee | 1 |" in now


def _active_ch(db, code, dealer, channel):
    db.execute("insert into affiliate_codes (code, dealer_code, channel,"
               " created_by, status, activated_at, activated_by) values (%s,"
               " %s, %s, 'x', 'active', now(), 'y')", (code, dealer, channel))


def test_db_attribute_code_channel_mismatch_and_web(db, tmp_path):
    """Mã kênh tiktok dùng trên đơn Shopee → unknown_code (không trả hoa hồng
    sai kênh); mã kênh web xuất hiện trong file sàn → web_skipped."""
    _active_ch(db, "SSDDDDDDDDDD", "DLM01", "tiktok")
    _active_ch(db, "SSEEEEEEEEEE", "DLM02", "web")
    _load_order(db, tmp_path, "o1.csv", [
        f"FAKE-C1,Hoàn thành,Mật ong,{HONEY},1,100000,SSDDDDDDDDDD",
        f"FAKE-C2,Hoàn thành,Saphraton,{SAPH},1,299000,SSEEEEEEEEEE",
        f"FAKE-C3,Hoàn thành,Mật ong,{HONEY},1,100000,SSZZZZZZZZZZ"])
    assert ka.attribute(_TxConn(db)) == {"new": 0, "updated": 0, "same": 0,
                                         "unknown_code": 2, "web_skipped": 1}
    assert _n(db, "affiliate_attributions") == 0


def test_db_attribute_voucher_from_latest_line_with_code(db, tmp_path):
    """Trạng thái/số lượng theo snapshot MỚI NHẤT; mã voucher theo dòng mới
    nhất CÓ mã — file sau để trống ô mã / thiếu hẳn cột mã không xóa ghi
    nhận."""
    a = "SSAAAAAAAAAA"
    _active(db, a, "DLM01")
    _load_order(db, tmp_path, "o1.csv", [
        f"FAKE-A1,Hoàn thành,Mật ong,{HONEY},1,100000,{a}"])
    tx = _TxConn(db)
    assert ka.attribute(tx)["new"] == 1
    cid = _cid(db, a)

    def _row():
        return db.execute("select code_id, qty, amount_vnd, status from"
                          " affiliate_attributions").fetchall()
    assert _row() == [(cid, 1, 100_000, "tinh")]
    # snapshot mới: ô mã trống, qty đổi → giữ mã cũ, qty theo file mới
    _load_order(db, tmp_path, "o2.csv", [
        f"FAKE-A1,Hoàn thành,Mật ong,{HONEY},3,100000,"])
    r = ka.attribute(tx)
    assert (r["new"], r["updated"], r["same"]) == (0, 1, 0)
    assert _row() == [(cid, 3, 300_000, "tinh")]
    # snapshot mới hơn nữa: KHÔNG có cột mã, trạng thái hủy
    hdr = ORDER_HDR.rsplit(",", 1)[0]
    p = tmp_path / "o3.csv"
    p.write_bytes((hdr + "\n" + f"FAKE-A1,Đã hủy,Mật ong,{HONEY},3,100000"
                   "\n").encode("utf-8"))
    m, _ = mc.load_mapping()
    rows, errs, sha = mc.read_export(p, "shopee", "order", m)
    assert errs == []
    mc.load(db, rows, "shopee", "order", "o3.csv", sha)
    r = ka.attribute(tx)
    assert (r["new"], r["updated"], r["same"]) == (0, 1, 0)
    assert _row() == [(cid, 3, 300_000, "huy")]
    assert _n(db, "affiliate_attributions") == 1


class _SpConn(_TxConn):
    """rollback() quay về savepoint `iss` — để test thấy nhánh rollback."""

    def rollback(self):
        self.conn.execute("rollback to savepoint iss")


def test_db_issue_submit_error_rolls_back_code(db, monkeypatch):
    d1 = _draft(db)
    n_q = _n(db, "approval_queue")
    orig = ka.director.submit

    def boom(*a, **kw):
        raise RuntimeError("submit hỏng")
    monkeypatch.setattr(ka.director, "submit", boom)
    db.execute("savepoint iss")
    with pytest.raises(RuntimeError, match="submit hỏng"):
        ka.issue(_SpConn(db), "DLM01", "shopee", [d1], by="nv kinh doanh")
    assert _n(db, "affiliate_codes") == 0
    assert _n(db, "approval_queue") == n_q
    monkeypatch.setattr(ka.director, "submit", orig)
    res = ka.issue(_TxConn(db), "DLM01", "shopee", [d1], by="nv kinh doanh",
                   dcfg=ka.director.load_config("sales"))
    assert res["skipped"] is False and res["qid"] is not None
    assert _n(db, "affiliate_codes") == 1
    assert _n(db, "approval_queue") == n_q + 1
