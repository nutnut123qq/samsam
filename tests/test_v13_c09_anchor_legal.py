"""v13.8 C09+C10 — neo blockchain (PL01 mục 4b), cập nhật văn bản pháp luật
→ hàng duyệt Pháp chế (PL01 Nhân sự, P2), API sàn/QR BLOCKED, mốc PL01 mục 7,
tài sản hợp tác, sổ nghĩa vụ ngoài code (F10, F11).

Mạng: provider OpenTimestamps chỉ chạy với `post` GIẢ (ghi nhận lời gọi) —
0 request ra Internet. DB THẬT trong schema tạm (fixture `db` của
tests/test_qr_trace.py) → ROLLBACK cuối test.
"""

import hashlib
import json
import re
import urllib.error
from datetime import date, timedelta
from pathlib import Path

import pytest

from agents import da_pmo
from pipelines import anchor as an
from pipelines import approval_queue as aq
from pipelines import guardrail, legal_updates, rollout
from pipelines import production as prod
from pipelines import qr_trace as q
from scripts import ops_monthly as om
from tests import test_qr_trace as qt
from tests.test_da_schema import da_db
from tests.test_qr_trace import (
    LOT,
    SECRETS,
    _mk_lot,
    _ready,
    _sign,
    _tamper_chain,
)


@pytest.fixture
def db():
    """Schema tạm (schema.sql ×2 + roles.sql ×2) — ROLLBACK cuối test."""
    yield from da_db()


@pytest.fixture
def proxy(db):
    return qt.TxConn(db)


@pytest.fixture
def run(db, proxy, monkeypatch, tmp_path):
    """CLI qr_trace trên conn test (như tests/test_qr_trace.py)."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(prod, "_connect", lambda _dsn: proxy)
    monkeypatch.setattr(q, "SIGNERS_FILE", qt._write(
        tmp_path, "signers.json", qt.SIGNERS_DOC))
    return lambda *argv: q.main(list(argv))


ROOT = Path(__file__).resolve().parent.parent
FEATS = {f["id"]: f for f in rollout.load_features()}
OTS_CFG = {"provider": "opentimestamps", "timeout_s": 5,
           "calendars": ["https://cal-a.test", "https://cal-b.test"]}


# ================================================================ thuần


def test_merkle_root_shape():
    a, b, c = (hashlib.sha256(x).hexdigest() for x in (b"a", b"b", b"c"))
    h = lambda *xs: hashlib.sha256(b"\x01" + b"".join(
        bytes.fromhex(x) for x in xs)).hexdigest()
    assert an.merkle_root([a]) == a
    assert an.merkle_root([a, b]) == h(a, b)
    assert an.merkle_root([a, b, c]) == h(h(a, b), c)     # lẻ → đẩy lên
    assert an.merkle_root([a, b]) != an.merkle_root([b, a])
    with pytest.raises(an.AnchorError):
        an.merkle_root([])


def test_leaf_hash_domain_separated_and_canonical():
    d = {"t": "x", "b": 2, "a": "ạ"}
    assert an.leaf_hash(d) == an.leaf_hash(dict(reversed(list(d.items()))))
    assert an.leaf_hash(d) != hashlib.sha256(an.canon(d)).hexdigest()
    assert an.canon(d).isascii()


def test_ots_file_header():
    dg = hashlib.sha256(b"m").digest()
    f = an.ots_file(dg, b"\xf0\x00")
    assert f.startswith(b"\x00OpenTimestamps\x00\x00Proof\x00")
    assert f[len(an.OTS_MAGIC):len(an.OTS_MAGIC) + 2] == b"\x01\x08"
    assert f[len(an.OTS_HEAD):len(an.OTS_HEAD) + 32] == dg
    assert f.endswith(b"\xf0\x00")


def test_real_config_provider_none():
    cfg = an.load_config()
    assert cfg["provider"] == "none" and cfg["calendars"] == []
    raw = json.loads((ROOT / "data" / "anchor_config.json").read_text(
        encoding="utf-8"))
    assert "hai bên" in raw["_doc"].lower() and "CHƯA CHỐT" in raw["status"]


@pytest.mark.parametrize("doc", [
    None, "x", {}, {"provider": "bitcoin"},
    {"provider": "opentimestamps"},
    {"provider": "opentimestamps", "opentimestamps": {"calendars": []}},
    {"provider": "opentimestamps",
     "opentimestamps": {"calendars": ["http://a.test"]}},
    {"provider": "opentimestamps",
     "opentimestamps": {"calendars": ["https://a.test/?x=1"]}},
    {"provider": "opentimestamps",
     "opentimestamps": {"calendars": ["https://u@a.test"]}},
    {"provider": "opentimestamps",
     "opentimestamps": {"calendars": ["https://a.test"], "timeout_s": 0}},
    {"provider": "opentimestamps",
     "opentimestamps": {"calendars": ["https://a.test"], "timeout_s": True}},
])
def test_config_variants_rejected(tmp_path, doc):
    p = tmp_path / "a.json"
    if doc is not None:
        p.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(an.AnchorError):
        an.load_config(p)


def test_config_ots_ok(tmp_path):
    p = tmp_path / "a.json"
    p.write_text(json.dumps({"provider": "opentimestamps", "opentimestamps":
                             {"calendars": ["https://a.test/"]}}),
                 encoding="utf-8")
    assert an.load_config(p)["calendars"] == ["https://a.test"]


def test_http_post_refuses_plain_http():
    with pytest.raises(ValueError, match="https"):
        an.http_post("http://a.test/digest", b"x" * 32, 1)


@pytest.fixture
def no_connect(monkeypatch):
    monkeypatch.setattr(an, "connect",
                        lambda: pytest.fail("không được connect DB"))


@pytest.mark.parametrize("argv", [
    [], ["--build", "--status"], ["--export", "1"], ["--verify", "1",
                                                     "--submit", "1"]])
def test_cli_usage_exit2(no_connect, argv):
    with pytest.raises(SystemExit) as e:
        an.main(argv)
    assert e.value.code == 2


def test_cli_submit_provider_none_blocked_before_connect(no_connect, capsys):
    assert an.main(["--submit", "latest"]) == 2
    err = capsys.readouterr().err
    assert "CHƯA NEO" in err and "hai bên" in err


# ================================================================ DB neo


def _fake_post(calls, fail=(), resp=b"\xf0\x10" + b"\x00" * 8):
    def post(url, body, timeout):
        calls.append((url, body, timeout))
        if any(url.startswith(f) for f in fail):
            raise urllib.error.URLError("calendar giả lỗi")
        return resp
    return post


def _now(db):
    return db.execute("select now()").fetchone()[0]


def _issued(db, proxy, run):
    _ready(db, proxy, run)
    _sign(run)
    assert run("issue", "--lot", LOT, "--by", "Người phát hành") == 0
    return db.execute("select code from qr_codes").fetchone()[0]


def test_build_leaves_no_pii_and_deterministic(db, proxy, run):
    code = _issued(db, proxy, run)
    assert run("revoke", "--code", code, "--by", "GĐ fixture") == 0
    # Lô MẪU có chữ ký → không vào lá.
    _mk_lot(db, code="LOT-MAU-01", source="sample")
    aid = db.execute("insert into approvals (object_type, object_id,"
                     " content_sha256, decision, approved_by) values"
                     " ('qr_lot_sign', 'LOT-MAU-01', %s, 'approved', 'x')"
                     " returning id", ("c" * 64,)).fetchone()[0]
    db.execute("insert into qr_signatures (lot_code, role, signer,"
               " signer_norm, snapshot_sha256, text_sha256, approval_id)"
               " values ('LOT-MAU-01', 'gd_san_xuat', 'x', 'x', %s, %s, %s)",
               ("d" * 64, "e" * 64, aid))
    now = _now(db)
    r = an.build(proxy, now)
    assert r["new"] and r["id"]
    leaves = db.execute("select leaves from anchor_batches where id = %s",
                        (r["id"],)).fetchone()[0]
    kinds = sorted(x["k"].split(":")[0] for x in leaves)
    assert kinds == ["plot_logs_head", "qr_issue", "qr_revoke",
                     "qr_sig", "qr_sig", "qr_sig"]
    assert [x["k"] for x in leaves] == sorted(x["k"] for x in leaves)
    blob = json.dumps(leaves, ensure_ascii=False)
    assert "LOT-MAU-01" not in blob
    for s in SECRETS:                      # tên người ký/tọa độ/khoảnh/SĐT
        assert s not in blob, s
    assert an.build(proxy, now)["new"] is False          # không đổi → no-op
    assert db.execute("select count(*) from anchor_batches").fetchone()[0] == 1
    assert an.collect(proxy, now) == leaves


def test_build_refuses_broken_chain_and_empty(db, proxy, run):
    with pytest.raises(an.AnchorError, match="chưa có"):
        an.build(proxy, _now(db))
    lid = _ready(db, proxy, run)
    _tamper_chain(db, lid)
    with pytest.raises(an.AnchorError, match="chuỗi plot_logs"):
        an.build(proxy, _now(db))
    assert db.execute("select count(*) from anchor_batches").fetchone()[0] == 0


def test_verify_detects_tamper_and_tables_append_only(db, proxy, run):
    from psycopg.errors import RaiseException
    code = _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    assert an.verify(proxy, bid) == (bid, [])
    assert an.verify(proxy, "latest")[1] == []
    for sql in ("update anchor_batches set merkle_root = %s",
                "delete from anchor_batches"):
        with pytest.raises(RaiseException, match="append-only"), \
                db.transaction():
            db.execute(sql, ("0" * 64,) if "%s" in sql else None)
    # Sửa lén dữ liệu QR đã neo (bỏ qua trigger) → verify bắt.
    db.execute("set local session_replication_role = replica")
    db.execute("update qr_codes set text_sha256 = %s where code = %s",
               ("f" * 64, code))
    db.execute("set local session_replication_role = origin")
    probs = an.verify(proxy, bid)[1]
    assert any(f"qr_issue:{code}" in p and "đã đổi" in p for p in probs)


def test_verify_detects_stored_leaf_tamper(db, proxy, run):
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    db.execute("set local session_replication_role = replica")
    db.execute("update anchor_batches set leaves = jsonb_set(leaves,"
               " '{0,h}', to_jsonb(%s::text)) where id = %s", ("a" * 64, bid))
    db.execute("set local session_replication_role = origin")
    probs = an.verify(proxy, bid)[1]
    assert any("gốc Merkle" in p for p in probs)
    assert any("sha256 bản kê" in p for p in probs)
    with pytest.raises(an.AnchorError, match="LỆCH"):
        an.submit(proxy, bid, OTS_CFG, post=_fake_post([]))


def test_submit_none_records_nothing(db, proxy, run):
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    with pytest.raises(an.AnchorBlocked, match="CHƯA NEO"):
        an.submit(proxy, bid, {"provider": "none", "calendars": [],
                               "timeout_s": 15})
    assert db.execute("select count(*) from anchor_receipts").fetchone()[0] \
        == 0
    assert an.receipt_state(proxy, bid) == "chưa neo"


def test_submit_ots_only_digest_failover_retry(db, proxy, run, tmp_path):
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    sha = db.execute("select manifest_sha256 from anchor_batches where id ="
                     " %s", (bid,)).fetchone()[0]
    # Mọi calendar lỗi → 1 dòng `loi`, chưa neo.
    calls = []
    r = an.submit(proxy, bid, OTS_CFG, post=_fake_post(
        calls, fail=("https://cal-a", "https://cal-b")))
    assert r["status"] == "loi" and len(calls) == 2
    assert "chưa neo" in an.receipt_state(proxy, bid)
    # Thử lại: calendar A lỗi, B nhận.
    calls = []
    r = an.submit(proxy, bid, OTS_CFG,
                  post=_fake_post(calls, fail=("https://cal-a",)))
    assert r["status"] == "da_gui" and r["calendar"] == "https://cal-b.test"
    assert [c[0] for c in calls] == ["https://cal-a.test/digest",
                                     "https://cal-b.test/digest"]
    for _u, body, t in calls:            # CHỈ digest 32 byte rời hệ thống
        assert body == bytes.fromhex(sha) and t == 5
    rec = bytes(db.execute("select receipt from anchor_receipts where status"
                           " = 'da_gui'").fetchone()[0])
    assert rec == an.ots_file(bytes.fromhex(sha), b"\xf0\x10" + b"\x00" * 8)
    state = an.receipt_state(proxy, bid)
    assert "chờ xác nhận Bitcoin" in state and "đã neo" not in state
    # Đã gửi → no-op, không gọi mạng.
    calls = []
    assert an.submit(proxy, bid, OTS_CFG, post=_fake_post(calls))["new"] \
        is False and calls == []
    assert an.verify(proxy, bid)[1] == []
    # Xuất cho bên thứ ba: bản kê có sha đúng + .ots.
    files = an.export(proxy, bid, tmp_path / "out")
    assert [f.name for f in files] == [f"anchor-{bid}.json",
                                       f"anchor-{bid}.json.ots"]
    assert hashlib.sha256(files[0].read_bytes()).hexdigest() == sha
    assert files[1].read_bytes() == rec
    man = json.loads(files[0].read_bytes())
    assert man["merkle_root"] == an.merkle_root(
        [x["h"] for x in man["leaves"]])
    # Biên nhận bị sửa → verify bắt.
    db.execute("set local session_replication_role = replica")
    db.execute("update anchor_receipts set receipt = %s", (b"x" * 40,))
    db.execute("set local session_replication_role = origin")
    assert any("biên nhận" in p for p in an.verify(proxy, bid)[1])


def test_rollout_gates(db, proxy, run, monkeypatch):
    _issued(db, proxy, run)
    bid = an.build(proxy, _now(db))["id"]
    monkeypatch.setattr(rollout, "_FORCE_MODE", None)
    calls = []
    # Chưa vào sổ = chạy thử → không gửi ra ngoài.
    with pytest.raises(an.AnchorError, match="farming-06"):
        an.submit(proxy, bid, OTS_CFG, post=_fake_post(calls))
    assert calls == []
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        an.build(proxy, _now(db))
    monkeypatch.setattr(rollout, "_FORCE_MODE", "co_nguoi_duyet")
    with pytest.raises(an.AnchorError, match="NGƯỜI duyệt"):
        an.submit(proxy, bid, OTS_CFG, post=_fake_post(calls))
    assert calls == []
    r = an.submit(proxy, bid, OTS_CFG, by="Quản lý AI", post=_fake_post(calls))
    assert r["status"] == "da_gui" and len(calls) == 1


# ================================================================ VBPL


def _intel(db, title, source="cuc-attp-van-ban", topics=("phap_ly",
                                                          "tpbvsk"),
           days_ago=0):
    return db.execute(
        "insert into intel_items (url, domain, source, tier, title, snippet,"
        " fetched_at, content_sha256, topics) values (%s, 'vfa.gov.vn', %s,"
        " 'A', %s, '', now() - %s * interval '1 day', %s, %s) returning id",
        (f"https://vfa.gov.vn/van-ban/{abs(hash(title))}", source, title,
         days_ago, hashlib.sha256(title.encode()).hexdigest(), list(topics))
    ).fetchone()[0]


def test_feature_mapping_legal_doc_review():
    assert rollout.feature_for(
        table="approval_queue", block="legal_hr",
        object_type="legal_doc_review",
        created_by=legal_updates.CREATED_BY) == "legal_hr-07"
    f = FEATS["legal_hr-07"]
    assert "pipelines/legal_updates.py" in f["modules"]
    assert {"table": "approval_queue", "block": "legal_hr",
            "object_type": "legal_doc_review"} in f["output_sources"]


def test_legal_updates_queue_idempotent_and_approvable(db, proxy):
    hit = _intel(db, "Nghị định quy định về thuốc và thực phẩm bảo vệ sức "
                 "khỏe")
    _intel(db, "Thông tư về lao động tiền lương", topics=("phap_ly",))
    _intel(db, "Tin tpbvsk từ báo", source="vnexpress-suc-khoe")
    _intel(db, "Nghị định cũ về quảng cáo thực phẩm", days_ago=40,
           topics=("phap_ly", "quang_cao"))
    st = legal_updates.submit(proxy, _now(db))
    assert st["found"] == 1 and len(st["queued"]) == 1 and st["left"] == 0
    row = db.execute("select block, object_type, object_id, title, payload,"
                     " created_by, guardrail->>'ok', risk from approval_queue"
                     " where id = %s", (st["queued"][0],)).fetchone()
    assert row[:3] == ("legal_hr", "legal_doc_review", f"intel:{hit}")
    assert "thuốc" in row[3] and "thuốc" not in row[4]
    assert row[5] == "agent:legal_updates" and row[6] == "true"
    assert row[7] == "medium"
    assert "KHÔNG diễn giải" in row[4] and "vfa.gov.vn" in row[4]
    # Người kiểm duyệt được (guardrail payload đạt), agent không duyệt được.
    ok, _m = aq.decide(proxy, st["queued"][0], "agent:legal_updates",
                       "approved")
    assert ok is False
    ok, msg = aq.decide(proxy, st["queued"][0], "Chuyên viên pháp chế",
                        "approved")
    assert ok, msg
    # Chạy lại (kể cả mục đã duyệt) → không đẩy lại.
    st2 = legal_updates.submit(proxy, _now(db))
    assert st2["found"] == 0 and st2["queued"] == []


def test_legal_updates_limit_dry_run_and_rollout_off(db, proxy, monkeypatch):
    for i in range(3):
        _intel(db, f"Dự thảo nghị định quảng cáo thực phẩm số {i}",
               topics=("phap_ly", "quang_cao"))
    st = legal_updates.submit(proxy, _now(db), dry_run=True)
    assert st == {"found": 3, "queued": [], "left": 0}
    assert db.execute("select count(*) from approval_queue").fetchone()[0] \
        == 0
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        legal_updates.submit(proxy, _now(db))
    monkeypatch.setattr(rollout, "_FORCE_MODE", "van_hanh")
    st = legal_updates.submit(proxy, _now(db), limit=2)
    assert len(st["queued"]) == 2 and st["left"] == 1
    assert len(legal_updates.submit(proxy, _now(db))["queued"]) == 1


# ================================================================ API sàn / QR


def test_p2_blockers_recorded_not_verified():
    src = (ROOT / "ingest" / "market_api.py").read_text(encoding="utf-8")
    assert "BLOCKED — CHƯA VERIFIED" in src
    f = FEATS["data_platform-06"]
    assert f["code_status"] != "co_code"
    assert f["blocker"].startswith("BLOCKED") and "CHƯA VERIFIED" in \
        f["blocker"]
    qr = json.loads((ROOT / "data" / "qr_config.json").read_text(
        encoding="utf-8"))
    assert qr["public_base_url"] == ""
    assert any("BLOCKED domain" in x for x in FEATS["farming-03.2"][
        "phu_thuoc"])
    f6 = FEATS["farming-06"]
    assert f6["modules"] == ["pipelines/anchor.py"]
    assert f6["output_sources"] == [{"table": "anchor_batches"}]
    assert f6["code_status"] == "mot_phan"           # chưa neo thật
    assert "hai bên" in f6["blocker"].lower() and "CHƯA NEO" in f6["blocker"]
    assert all(f["acceptance_status"] == "chua_nghiem_thu"
               for f in (f, f6, FEATS["legal_hr-07"]))


# ================================================================ C10 mốc


MS = {m["code"]: m for m in da_pmo.load_milestones()}
UNDATED = {m["code"]: m for m in da_pmo.load_undated()}


def test_contract_milestones_pl01_muc7():
    want = {"MOC-A": "2026-10-31", "MOC-B": "2026-11-07",
            "DUYET-1111": "2026-11-09", "MOC-C": "2026-11-30",
            "MOC-D": "2026-12-18", "KH-NAM-2027-TRINH": "2026-11-30",
            "KH-NAM-2027-DUYET": "2026-12-31",
            "P1-XAY-DUNG": "2027-01-11", "DONG-BANG": "2027-02-10",
            "NGHIEM-THU-P1": "2027-02-20", "API-SAN": "2027-03-31"}
    got = {k: MS[k]["due_date"].isoformat() for k in want if k in MS}
    assert got == want
    assert MS["DONG-BANG"]["tu_ngay"] == "2026-12-21"
    assert MS["NGHIEM-THU-P1"]["tu_ngay"] == "2027-02-11"
    assert MS["API-SAN"]["tu_ngay"] == "2027-02-01"
    # Kết thúc xây dựng P1 tách khỏi nghiệm thu P1 (không gộp).
    assert MS["P1-XAY-DUNG"]["due_date"] < MS["NGHIEM-THU-P1"]["due_date"]
    assert "KHÔNG phải nghiệm thu" in MS["P1-XAY-DUNG"]["gate"]
    assert "PL05" in MS["NGHIEM-THU-P1"]["gate"]
    for m in MS.values():
        assert m["nguon"].strip(), m["code"]
        assert m["code"] not in want or m["nguon"].startswith("PL01 mục")
    assert "KHÔNG phải" in MS["TT3"]["nguon"]


def test_undated_milestones_have_blockers():
    assert set(UNDATED) == {"BAN-GIAO-DAU-VAO", "HA-TANG", "BLOCKCHAIN",
                            "NGHIEM-THU-P2", "DANH-GIA-NAM"}
    for m in UNDATED.values():
        assert m["blocker"].strip() and "due_date" not in m
        assert not re.search(r"\d{4}-\d{2}-\d{2}", json.dumps(m))
    assert "05 ngày" in UNDATED["BAN-GIAO-DAU-VAO"]["han_theo_hd"]


@pytest.mark.parametrize("bad,needle", [
    ({"milestones": [], "moc_chua_co_ngay": {}}, "list"),
    ({"milestones": [{"code": "MOC-A"}],
      "moc_chua_co_ngay": [{"code": "MOC-A", "title": "t", "owner_role": "r",
                            "han_theo_hd": "h", "blocker": "b"}]}, "trùng"),
    ({"milestones": [], "moc_chua_co_ngay": [
        {"code": "X-1", "title": "t", "owner_role": "r", "han_theo_hd": "h",
         "blocker": " "}]}, "blocker"),
    ("[]", "không đọc được")])
def test_load_undated_rejects(tmp_path, bad, needle):
    p = tmp_path / "m.json"
    p.write_text(bad if isinstance(bad, str) else json.dumps(bad),
                 encoding="utf-8")
    with pytest.raises(ValueError, match=needle):
        da_pmo.load_undated(p)


def _rows():
    return [{**{k: m.get(k) for k in da_pmo.COLS}, "status": "chua_bat_dau",
             "evidence": None} for m in MS.values()]


def test_board_lists_undated_and_passes_guardrail():
    for m in [*MS.values(), *UNDATED.values()]:
        for k in ("title", "gate", "blocker", "han_theo_hd"):
            if k in m:
                g = guardrail.check(m[k])
                assert g["ok"] is True, (m["code"], k, g["violations"])
    d = date(2026, 10, 15)
    while d <= date(2027, 3, 31):
        md = da_pmo.render_board(_rows(), d, list(UNDATED.values()))
        assert guardrail.check(md)["ok"] is True, d
        d += timedelta(days=9)
    sec = md.split("## Mốc chưa có ngày", 1)[1]
    for c in UNDATED:
        assert re.search(rf"\| {re.escape(c)} \|", sec)
    assert "## Mốc chưa có ngày" not in da_pmo.render_board(_rows(), d)


@pytest.fixture
def pmo_db():
    yield from da_db()


def test_seed_reports_drift_keeps_db(pmo_db, monkeypatch, capsys):
    from tests.test_da_schema import TxConn
    pmo_db.execute("insert into project_milestones (code, title, owner_role,"
                   " due_date, gate, source) values ('MOC-C', 'Mốc C — OCR"
                   " đợt 1', 'tgd', '2026-11-30', 'cũ', 'seed')")
    monkeypatch.setattr(da_pmo, "connect", lambda: TxConn(pmo_db))
    assert da_pmo.main(["--seed"]) == 0
    assert "[lệch] MOC-C" in capsys.readouterr().err
    assert pmo_db.execute("select title from project_milestones where code"
                          " = 'MOC-C'").fetchone()[0] == "Mốc C — OCR đợt 1"
    n = pmo_db.execute("select count(*) from project_milestones").fetchone()[0]
    assert n == len(MS)


def test_board_cli_undated_broken_exit1(pmo_db, monkeypatch, tmp_path,
                                        capsys):
    from tests.test_da_schema import TxConn
    monkeypatch.setattr(da_pmo, "connect", lambda: TxConn(pmo_db))
    assert da_pmo.main(["--seed"]) == 0
    assert da_pmo.main(["--board", "--date", "2026-10-15", "--out-dir",
                        str(tmp_path)]) == 0
    body = next(tmp_path.glob("da-pmo-board-*.md")).read_text(
        encoding="utf-8")
    assert "## Mốc chưa có ngày" in body and "NGHIEM-THU-P2" in body
    p = tmp_path / "m.json"
    doc = json.loads(da_pmo.MILESTONES_FILE.read_text(encoding="utf-8"))
    doc["moc_chua_co_ngay"][0].pop("blocker")
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(da_pmo, "MILESTONES_FILE", p)
    assert da_pmo.main(["--board", "--date", "2026-10-16", "--out-dir",
                        str(tmp_path)]) == 1
    assert "không dựng bảng" in capsys.readouterr().err


# ================================================================ C10 tài sản / sổ


def test_assets_inventory_fields_pending_confirmation():
    raw = json.loads((ROOT / "data" / "tai_san_hop_tac.json").read_text(
        encoding="utf-8"))
    assert raw["trang_thai"] == "cho_xac_nhan"
    assert "Bên B" in raw["nguoi_giu_quyen_cao_nhat"]
    for it in raw["hang_muc"]:
        for k in ("vi_tri", "phien_ban", "chu_quan", "quyen_truy_cap"):
            assert isinstance(it[k], str) and it[k].strip(), (it, k)
        assert it["trang_thai"] == "cho_xac_nhan"
    blob = json.dumps(raw, ensure_ascii=False)
    assert not re.search(r"\d{10,}", blob)            # không MST/số TK
    assert len(om.load_assets()["items"]) == 5        # reader cũ vẫn đọc


def test_obligation_register_complete():
    body = (ROOT / "docs" / "handover" / "so-nghia-vu-hop-dong.md"
            ).read_text(encoding="utf-8")
    for kw in ("02 người", "05 ngày", "Đào tạo", "trực", "hoàn trả",
               "Xung đột lợi ích", "Bảo hành", "15 ngày", "30 ngày",
               "07 ngày", "PL05", "nhận bàn giao"):
        assert kw.lower() in body.lower(), kw
    rows = [ln for ln in body.splitlines() if re.match(r"\| N\d{2} \|", ln)]
    assert len(rows) >= 20
    for ln in rows:
        cells = [c.strip() for c in ln.strip("|").split(" | ")]
        assert len(cells) == 8, ln
        assert cells[3] and cells[4] and (cells[5] or cells[6]), ln
        assert cells[7] in ("de_xuat", "cho_ky", "da_duyet"), ln
    assert not re.search(r"\d{10,}", body)
    assert "agent" in body.lower() and "KHÔNG" in body
