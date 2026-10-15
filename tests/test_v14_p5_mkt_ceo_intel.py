"""v14.5 (p5) — 3 mục danh mục còn thiếu code (PL01 mục 2):

  marketing-04.2  kiểm bài đăng của ĐỐI TÁC (KOC/đại lý) từ file xuất tay:
                  `agents.ra_kenh --partner-file` → guardrail theo kênh +
                  đối chiếu bộ tài liệu chuẩn ĐÃ duyệt → `marketing/
                  partner_post_review` theo ĐỢT (sổ `partner_post_scans`,
                  không text/URL đầy đủ/tên đối tác).
  ceo-04.1        so KM/voucher ĐANG CHẠY (listing sàn + file xuất KM) với
                  bản đã duyệt (kế hoạch KM `kd_price --plan` + giá KM golden
                  đã duyệt) → `ceo/promo_deviation` (`agents.ceo_audit
                  --promo`), khóa theo ĐỢT bằng chứng.
  intel-04.2      từ khóa Google Trends related → lọc luật (từ cấm/công
                  dụng/sức khỏe/rượu/PII) → `intel/keyword_suggest`
                  (`scripts/intel_weekly.py --suggest-keywords`).

Trên code cũ (v14-hop-dong trước p5) các hàm/cờ/loại việc/bảng này không có →
test FAIL (AttributeError / argparse exit 2 / ValueError loại việc / bảng
thiếu) — `evidence/v14_5_p5_oldcode_fail.log`.

DB thật: schema tạm `t_p5_<hex>` + ROLLBACK (mẫu test_v14_p4_sales).
"""

import importlib.util
import json
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from agents import ceo_audit, ceo_promo, ra_kenh
from pipelines import approval_queue as aq
from pipelines import director, guardrail, rollout

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
VN = timezone(timedelta(hours=7))
NOW = datetime(2026, 10, 14, 9, 0, tzinfo=VN)
TODAY = date(2026, 10, 14)

_spec = importlib.util.spec_from_file_location(
    "intel_weekly_p5", ROOT / "scripts" / "intel_weekly.py")
iw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(iw)


# ======================================================== cấu hình + danh mục

@pytest.mark.parametrize("block, ot, fid, by", [
    ("marketing", "partner_post_review", "marketing-04.2",
     "agent:mkt_doi_tac"),
    ("ceo", "promo_deviation", "ceo-04.1", "agent:ceo_audit"),
    ("intel", "keyword_suggest", "intel-04.2", "agent:intel_keywords"),
])
def test_block_type_and_catalog_map_each_feature(block, ot, fid, by):
    """Loại việc mới thuộc đúng khối + ĐÚNG 1 tính năng danh mục (rollout
    cưỡng chế ở biên enqueue/duyệt/dùng); danh mục hết 'thiếu code'."""
    cfg = director.load_config(block)
    assert cfg["object_types"][ot]["risk"] in ("medium", "high")
    assert rollout.feature_for(table="approval_queue", block=block,
                               object_type=ot, created_by=by) == fid
    f = {x["id"]: x for x in rollout.load_features()}[fid]
    assert f["code_status"] == "co_code"
    assert f["blocker"] and "chưa có lane" not in f["blocker"].lower()
    assert "Chưa có code" not in f["blocker"]
    assert "tests/test_v14_p5_mkt_ceo_intel.py" in f["bang_chung"]


# ======================================================== marketing-04.2 THUẦN

PHDR = "ma_doi_tac,url,kenh,text,ngay_dang,sku\n"
URL1 = "https://www.tiktok.com/@chi.lan.review/video/7300000000000000001"
URL2 = "https://www.tiktok.com/@chi.lan.review/video/7300000000000000002"
BAD_TEXT = "Sâm này chữa ung thư, uống là khỏi bệnh #quangcao"
OK_TEXT = "Hộp quà Tết biếu gia đình rất sang #quangcao"


def _pcsv(tmp_path, body, head=PHDR, name="doi_tac.csv"):
    p = tmp_path / name
    p.write_bytes((head + body).encode("utf-8"))
    return p


def test_partner_export_reads_code_only(tmp_path):
    rows = ra_kenh.read_partner_export(_pcsv(
        tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\",2026-10-13,\n"))
    r = rows[0]
    assert (r["partner"], r["channel"], r["host"]) == (
        "KOC-MAU-01", "tiktok", "tiktok.com")
    assert r["posted_on"] == date(2026, 10, 13) and r["sku"] is None
    assert len(r["url_sha"]) == 64 and len(r["sha"]) == 64


@pytest.mark.parametrize("head, body, frag", [
    # cột tên/handle/SĐT đối tác → cả file lỗi (không PII ngoài mã)
    ("ma_doi_tac,ten_koc,url,kenh,text,ngay_dang\n",
     f"KOC-MAU-01,Chị Lan,{URL1},tiktok,abc,2026-10-13\n", "cột lạ"),
    (PHDR, f"Chi Lan,{URL1},tiktok,abc,2026-10-13,\n", "ma_doi_tac"),
    (PHDR, f"koc-mau-01,{URL1},tiktok,abc,2026-10-13,\n", "ma_doi_tac"),
    (PHDR, f"KOC-MAU-01,{URL1},tiktok,abc,13/10/2026,\n", "ngay_dang"),
    (PHDR, f"KOC-MAU-01,{URL1},tiktok,abc,,\n", "ngay_dang"),
    (PHDR, "KOC-MAU-01,ftp://x/y,tiktok,abc,2026-10-13,\n", "url"),
    (PHDR, f"KOC-MAU-01,{URL1},myspace,abc,2026-10-13,\n", "kenh"),
    (PHDR, f"KOC-MAU-01,{URL1},tiktok,abc,2026-10-13,khong-co\n", "sku"),
    (PHDR, (f"KOC-MAU-01,{URL1},tiktok,a,2026-10-13,\n"
            f"KOC-MAU-02,{URL1},tiktok,b,2026-10-13,\n"), "trùng URL"),
    ("ma_doi_tac,url,kenh,text\n", f"KOC-MAU-01,{URL1},tiktok,a\n",
     "thiếu cột"),
])
def test_partner_export_rejects_whole_file(tmp_path, head, body, frag):
    with pytest.raises(ra_kenh.ExportError) as e:
        ra_kenh.read_partner_export(_pcsv(tmp_path, body, head))
    msg = "\n".join(e.value.errors)
    assert frag in msg
    assert "Chị Lan" not in msg and "chi.lan" not in msg   # không chép ô


@pytest.mark.parametrize("host, site", [
    ("www.tiktok.com", "tiktok.com"),
    ("chilan.blogspot.com", "blogspot.com"),          # subdomain = handle
    ("m.facebook.com", "facebook.com"),
    ("shop.abc.com.vn", "abc.com.vn"),
    ("abc.vn", "abc.vn"),
])
def test_partner_site_strips_personal_subdomain(host, site):
    assert ra_kenh._site(host) == site


def _g(viols=(), claims=()):
    return {"ok": not viols, "violations": [
        {"code": c, "severity": s} for c, s in viols],
        "matched_claims": [{"claim": c} for c in claims]}


KIT = {"skus": {"mat-ong-sam-300ml"}, "claims": {"hỗ trợ bồi bổ sức khỏe"},
       "refs": ["koc_brief#1"]}


@pytest.mark.parametrize("g, kit, sku, codes, sev", [
    (_g(), None, None, ["thieu_bo_tai_lieu"], "S2"),
    (_g([("tu_cam", "critical")]), KIT, None, ["tu_cam"], "S1"),
    (_g(claims=["hỗ trợ bồi bổ sức khỏe"]), KIT, "mat-ong-sam-300ml", [],
     None),
    (_g(claims=["hỗ trợ giảm mệt mỏi"]), KIT, "mat-ong-sam-300ml",
     ["ngoai_bo_tai_lieu"], "S2"),
    (_g(), KIT, "savina-12v", ["sku_ngoai_bo_tai_lieu"], "S2"),
    # kit đại lý không liệt kê claim → chỉ xét SKU
    (_g(claims=["x"]), {"skus": set(), "claims": None, "refs": []}, None,
     [], None),
])
def test_partner_verdict_kit_and_guardrail(g, kit, sku, codes, sev):
    v = ra_kenh.partner_verdict(g, kit, sku)
    assert (v["codes"], v["severity"]) == (codes, sev)


def test_partner_scan_uses_channel_ad_rules():
    """Bài đối tác = quảng cáo: thiếu nhãn #quangcao bị bắt, từ cấm S1."""
    row = {"text": "Sâm này chữa ung thư", "channel": "tiktok", "sku": None}
    v = ra_kenh.partner_scan(row, None)
    assert v["severity"] == "S1"
    assert {"tu_cam", "thieu_nhan_quang_cao", "thieu_bo_tai_lieu"} <= set(
        v["codes"])


def test_ra_kenh_partner_cli_usage_and_dry_run(tmp_path, monkeypatch,
                                               capsys):
    f = _pcsv(tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\","
                        "2026-10-13,\n")
    with pytest.raises(SystemExit) as e:
        ra_kenh.main(["--partner-file", str(f), "--by", "Lan", "--now",
                      "2026-10-14T09:00"])
    assert e.value.code == 2
    with pytest.raises(SystemExit):
        ra_kenh.main(["--partner-file", str(f), "--report"])
    with pytest.raises(SystemExit):
        ra_kenh.main(["--partner-file", str(f), "--by", "agent:x"])
    monkeypatch.setattr(ra_kenh, "connect", lambda: pytest.fail("connect"))
    assert ra_kenh.main(["--partner-file", str(f), "--by", "Lan",
                         "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "tu_cam" in out and "chi.lan" not in out and "ung thư" not in out


# ======================================================== ceo-04.1 THUẦN

def _run(src="listing", sku="mat-ong-sam-300ml", price=None, pct=None,
         kind=None, start=None, end=None, ch="shopee"):
    return {"src": src, "channel": ch, "sku": sku, "kind": kind,
            "price": price, "pct": pct, "start": start, "end": end,
            "ref": "r", "evidence": "s1"}


def _ap(sku="mat-ong-sam-300ml", price=None, pct=None, kind=None,
        start=date(2026, 10, 1), end=date(2026, 10, 31), ch="shopee",
        src="plan"):
    return {"src": src, "channel": ch, "sku": sku, "kind": kind,
            "price": price, "pct": pct, "start": start, "end": end,
            "ref": "a"}


LISTS = {("mat-ong-sam-300ml", "shopee"): 1_000_000}


@pytest.mark.parametrize("running, approved, lists, codes", [
    ([_run(price=900_000)], [], LISTS, ["km_ngoai_ke_hoach"]),
    # bản duyệt đã hết hạn = không có bản hiệu lực
    ([_run(price=900_000)], [_ap(pct=20, end=date(2026, 10, 10))], LISTS,
     ["km_ngoai_ke_hoach"]),
    ([_run(price=800_000)], [_ap(pct=20)], LISTS, []),
    ([_run(price=799_000)], [_ap(pct=20)], LISTS, ["km_sau_hon_duyet"]),
    ([_run(src="file", pct=30, kind="voucher", start=date(2026, 10, 1),
           end=date(2026, 10, 31))], [_ap(pct=30, kind="flash_sale")],
     LISTS, ["km_khac_loai"]),
    ([_run(src="file", pct=20, kind="voucher", start=date(2026, 10, 1),
           end=date(2026, 11, 5))], [_ap(pct=20, kind="voucher")], LISTS,
     ["km_qua_thoi_gian"]),
    ([_run(src="file", pct=25, kind="voucher", start=date(2026, 10, 1),
           end=date(2026, 11, 5))], [_ap(pct=20, kind="voucher")], LISTS,
     ["km_sau_hon_duyet", "km_qua_thoi_gian"]),
    # % ↔ giá cần giá list golden — thiếu thì không suy
    ([_run(price=800_000)], [_ap(pct=20)], {}, ["km_khong_so_duoc"]),
    ([_run(sku=None, price=800_000)], [_ap(pct=20)], LISTS,
     ["khong_xac_dinh_sku"]),
    # golden giá KM cố định, mọi loại
    ([_run(price=850_000)], [_ap(price=850_000, src="golden", end=None)],
     LISTS, []),
])
def test_compare_promos_codes(running, approved, lists, codes):
    res = ceo_promo.compare_promos(running, approved, lists, TODAY)
    assert sorted(f["code"] for f in res["findings"]) == sorted(codes)
    assert res["ok"] == (1 if not codes else 0)


def test_compare_promos_planned_not_running_is_info_only():
    res = ceo_promo.compare_promos([], [_ap(pct=10)], LISTS, TODAY)
    assert res["findings"] == [] and len(res["planned_idle"]) == 1


def test_ceo_promo_cli_usage():
    for argv in (["--now", "2026-10-14"], ["--as-of", "14/10/2026"],
                 ["--report"]):
        with pytest.raises(SystemExit) as e:
            ceo_promo.main(argv)
        assert e.value.code == 2, argv
    # ceo_audit giữ nguyên CHỈ ĐỌC (không cờ --promo/đường ghi)
    with pytest.raises(SystemExit):
        ceo_audit.main(["--promo"])


def test_ceo_promo_bad_plan_exit1_before_connect(tmp_path,
                                                       monkeypatch):
    p = tmp_path / "plan.csv"
    p.write_bytes(b"program_id,kenh\nX,shopee\n")
    monkeypatch.setattr(ceo_promo, "connect", lambda: pytest.fail("connect"))
    assert ceo_promo.main(["--plan", str(p)]) == 1


# ======================================================== intel-04.2 THUẦN

@pytest.mark.parametrize("q, want", [
    ("sâm ngọc linh chữa ung thư", {"tu_cam"}),
    ("sam ngoc linh tri tieu duong", {"suc_khoe"}),
    ("sâm ngọc linh cho người tiểu đường", {"suc_khoe"}),
    ("rượu sâm ngọc linh", {"ruou"}),
    ("sam ngoc linh ngam ruou", {"ruou"}),
    ("sâm ngọc linh tốt cho gan", {"cong_dung"}),
    ("sâm ngọc linh giải độc gan", {"tu_cam"}),
    ("sâm ngọc linh 0912345678", {"pii"}),
    # chỉ dẫn địa lý chưa được Pháp chế xác nhận (luật đăng bài)
    ("sâm ngọc linh", {"chi_dan_dia_ly"}),
    ("sam ngoc linh quang nam", {"chi_dan_dia_ly"}),
])
def test_keyword_reasons_excluded(q, want):
    assert want <= set(iw.keyword_reasons(q))


@pytest.mark.parametrize("q", [
    "sâm giá bao nhiêu", "quà tết sâm", "hộp quà sâm biếu tết",
    "mật ong sâm", "sâm mua ở đâu", "hồng sâm",
])
def test_keyword_reasons_safe(q):
    assert iw.keyword_reasons(q) == []


def test_keyword_payload_passes_guardrail_and_hides_excluded():
    res = {"import_id": 7, "file_name": "related_MAU.csv",
           "safe": [(1, "sâm ngọc linh", "rising", "hộp quà sâm", "+250%"),
                    (2, None, "top", "sâm ngọc linh giá", "100")],
           "excluded": [(3, ["tu_cam", "suc_khoe"]), (4, ["ruou"]),
                        (5, ["cong_dung"]), (6, ["pii"])]}
    text = iw.render_keywords(res)
    assert guardrail.check(text)["ok"] is True
    assert "hộp quà sâm" in text and "trends_related #3" in text
    assert "rượu" not in text and "chữa" not in text


def test_intel_weekly_cli_usage():
    for argv in (["--import", "3"], ["--dry-run"],
                 ["--suggest-keywords", "--week", "2026-10-08"]):
        with pytest.raises(SystemExit) as e:
            iw.main(argv)
        assert e.value.code == 2, argv


# ======================================================== DB

@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_p5_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)          # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close no-op; rollback → savepoint `sp` nếu có."""

    def __init__(self, conn, sp=None):
        self.conn, self.sp = conn, sp

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def cursor(self):
        return self.conn.cursor()

    def commit(self):
        pass

    def rollback(self):
        if self.sp:
            self.conn.execute(f"rollback to savepoint {self.sp}")

    def close(self):
        pass

    @property
    def info(self):
        return self.conn.info


def _queue(conn, ot):
    return conn.execute("select id, block, object_id, title, payload,"
                        " status, created_by, is_sample, guardrail from"
                        " approval_queue where object_type = %s order by id",
                        (ot,)).fetchall()


# ---------------------------------------------------- marketing-04.2 DB

KIT_PAYLOAD = ("# Kit KOC KOC-MAU-01 — `mat-ong-sam-300ml` × tiktok (NHÁP — chỉ"
               " phát hành bản đã duyệt)\n\n## Brief\n\nHộp quà Tết\n\n"
               "## Điểm được nói\n\n- Chỉ nội dung trong brief ở trên\n\n"
               "## Nhãn bắt buộc khi đăng\n\n- #quangcao\n")


def _approved_kit(tx):
    qid = director.submit(tx, "marketing", "koc_brief",
                          "koc-KOC-MAU-01-aaaaaaaaaaaa",
                          "Kit KOC KOC-MAU-01", KIT_PAYLOAD,
                          "agent:mkt_koc")
    assert aq.decide(tx, qid, "GD Marketing", "approved") == (True, None)
    return qid


def _prow(tmp_path, body, name):
    return ra_kenh.read_partner_export(_pcsv(tmp_path, body, name=name))


def test_partner_ingest_items_by_wave_no_pii(db, tmp_path):
    tx = _TxConn(db)
    kit = _approved_kit(tx)
    rows = _prow(tmp_path, (f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\","
                            "2026-10-13,mat-ong-sam-300ml\n"
                            f"KOC-MAU-01,{URL2},tiktok,\"{OK_TEXT}\","
                            "2026-10-13,mat-ong-sam-300ml\n"), "a.csv")
    st = ra_kenh.ingest_partner(tx, rows, by="Lan MXH", now=NOW)
    assert (st["new"], st["S1"], st["tickets"]) == (2, 1, 1)
    q = _queue(db, "partner_post_review")
    assert len(q) == 1
    _id, block, oid, title, payload, status, by, sample, g = q[0]
    assert (block, status, by, sample) == ("marketing", "pending",
                                           "agent:mkt_doi_tac", True)
    assert f"koc_brief#{kit}" in payload and "tu_cam" in payload
    for leak in ("chi.lan", "@", "/video/", "ung thư", "khỏi bệnh"):
        assert leak not in payload and leak not in title and leak not in oid
    assert g["ok"] is True          # payload duyệt được (không chép vi phạm)
    scans = db.execute("select partner_code, host, codes, severity,"
                       " queue_id, is_sample from partner_post_scans order"
                       " by id").fetchall()
    assert [s[3] for s in scans] == ["S1", None]
    assert scans[0][4] == q[0][0] and scans[1][4] is None
    # nạp lại y hệt → bỏ qua, không mục mới
    st2 = ra_kenh.ingest_partner(tx, rows, by="Lan MXH", now=NOW)
    assert (st2["new"], st2["skip"], st2["tickets"]) == (0, 2, 0)
    assert len(_queue(db, "partner_post_review")) == 1
    # sổ append-only
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("update partner_post_scans set codes = '{}'")


def test_partner_revert_after_clean_opens_new_wave(db, tmp_path):
    """Gotcha khóa theo ĐỢT: vi phạm A → sửa sạch B → quay lại A = đợt mới
    (khóa 'đã thấy text này' sẽ nuốt câm lần tái phát)."""
    tx = _TxConn(db)
    _approved_kit(tx)
    bad = _prow(tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\","
                          "2026-10-13,\n", "bad.csv")
    ok = _prow(tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{OK_TEXT}\","
                         "2026-10-13,\n", "ok.csv")
    for rows in (bad, ok, bad):
        ra_kenh.ingest_partner(tx, rows, by="Lan MXH", now=NOW)
    assert len(_queue(db, "partner_post_review")) == 2
    assert db.execute("select count(*) from partner_post_scans"
                      ).fetchone()[0] == 3


def test_partner_without_kit_and_unknown_partner(db, tmp_path):
    tx = _TxConn(db)
    rows = _prow(tmp_path, f"KOC-MAU-02,{URL1},tiktok,\"{OK_TEXT}\","
                           "2026-10-13,\n", "nokit.csv")
    st = ra_kenh.ingest_partner(tx, rows, by="Lan MXH", now=NOW)
    assert st["S2"] == 1
    assert "thieu_bo_tai_lieu" in _queue(db, "partner_post_review")[0][4]
    unk = _prow(tmp_path, f"KOL-NGOAI-99,{URL2},tiktok,abc,2026-10-13,\n",
                "unk.csv")
    with pytest.raises(ValueError, match="không có trong sổ"):
        ra_kenh.ingest_partner(tx, unk, by="Lan MXH", now=NOW)
    assert db.execute("select count(*) from partner_post_scans where"
                      " partner_code = 'KOL-NGOAI-99'").fetchone()[0] == 0


def test_partner_feature_off_writes_nothing(db, tmp_path, monkeypatch):
    rows = _prow(tmp_path, f"KOC-MAU-01,{URL1},tiktok,\"{BAD_TEXT}\","
                           "2026-10-13,\n", "off.csv")
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        ra_kenh.ingest_partner(_TxConn(db), rows, by="Lan MXH", now=NOW)
    assert db.execute("select count(*) from partner_post_scans"
                      ).fetchone()[0] == 0


# ---------------------------------------------------- ceo-04.1 DB

SKU, RUOU = "mat-ong-sam-300ml", "ruou-sam-chai-thuy-tinh-500ml"


def _replica(db, on: bool):
    """Giá đã duyệt: golden_store nạp dòng mở chưa duyệt rồi người duyệt —
    fixture bỏ qua trigger append-only (replica) để dựng thẳng trạng thái
    (mẫu test_v14_p4_sales)."""
    db.execute("set local session_replication_role = "
               + ("replica" if on else "origin"))


def _seed_promo(db):
    _replica(db, True)
    for k, cat in ((SKU, "food"), (RUOU, "alcohol")):
        db.execute("insert into sku_master (sku_key, name, category, source)"
                   " values (%s, %s, %s, 'manual')", (k, k, cat))
        db.execute("insert into price_list (sku_key, channel, kind,"
                   " price_vnd, valid_from, approved_by) values (%s,"
                   " 'shopee', 'list', 1000000, '2026-01-01', 'GD KD')", (k,))
    _replica(db, False)


def _snapshot(db, n, rows):
    sid = db.execute("insert into market_snapshots (channel, export_kind,"
                     " file_name, file_sha256, row_count, imported_at) values"
                     " ('shopee', 'listing', %s, %s, %s, %s) returning id",
                     (f"listing{n}.csv", f"{n:064x}", len(rows),
                      NOW + timedelta(minutes=n))).fetchone()[0]
    for i, (sku, price, sale) in enumerate(rows, start=2):
        db.execute("insert into market_rows (snapshot_id, row_no, channel,"
                   " export_kind, item_id, seller_sku, sku_key, title,"
                   " price_vnd, raw) values (%s, %s, 'shopee', 'listing',"
                   " %s, %s, %s, 'Tiêu đề bí mật', %s, %s)",
                   (sid, i, f"99{i}", f"SS-{i}", sku, price,
                    json.dumps({"sale_price": str(sale)})))
    return sid


def _plan(tmp_path, body):
    p = tmp_path / "plan.csv"
    p.write_bytes(("program_id,kenh,sku_key,loai_km,ngay_bat_dau,"
                   "ngay_ket_thuc,giam_pct\n" + body).encode("utf-8"))
    from agents import kd_price
    rows, errs = kd_price.read_plan(p)
    assert errs == []
    return rows


CEO = director.load_config("ceo")


def _promo(tx, plan=None, dry_run=False):
    return ceo_promo.promo_check(tx, TODAY, mapping={}, plan=plan,
                                 running_file=None, plan_sha="ab" * 32,
                                 running_sha=None, cfg=CEO, dry_run=dry_run)


def test_promo_check_deviation_waves(db, tmp_path):
    _seed_promo(db)
    _snapshot(db, 1, [(SKU, 1_000_000, 700_000), (RUOU, 1_000_000, 900_000),
                      (None, 500_000, 400_000), (SKU, 1_000_000, None)])
    tx = _TxConn(db)
    plan = _plan(tmp_path, f"P1,shopee,{SKU},giam_gia,2026-10-01,"
                           "2026-10-31,20\n")
    r = _promo(tx, plan, dry_run=True)
    assert sorted(f["code"] for f in r["findings"]) == [
        "khong_xac_dinh_sku", "km_ngoai_ke_hoach", "km_sau_hon_duyet"]
    assert _queue(db, "promo_deviation") == []          # dry-run 0 ghi
    r = _promo(tx, plan)
    q = _queue(db, "promo_deviation")
    assert r["enqueued"] == len(q) == 3
    for _id, block, oid, title, payload, status, by, _s, g in q:
        assert (block, status, by) == ("ceo", "pending", "agent:ceo_audit")
        assert "Tiêu đề bí mật" not in payload + title
        assert RUOU not in payload + title          # nhóm rượu ẩn mã
        assert g["ok"] is True
    # chạy lại cùng bằng chứng → 0 mới; snapshot MỚI khi đang chờ → dồn
    assert _promo(tx, plan)["enqueued"] == 0
    _snapshot(db, 2, [(SKU, 1_000_000, 700_000)])
    assert _promo(tx, plan)["enqueued"] == 0
    # đã quyết rồi mà snapshot mới VẪN lệch → đợt mới
    sau = next(x for x in q if "thấp hơn" in x[3])
    assert aq.decide(tx, sau[0], "TGD", "rejected")[0] is True
    _snapshot(db, 3, [(SKU, 1_000_000, 700_000)])
    assert _promo(tx, plan)["enqueued"] == 1
    # kế hoạch nới (giảm 30%) → hết lệch giá
    plan30 = _plan(tmp_path, f"P1,shopee,{SKU},giam_gia,2026-10-01,"
                             "2026-10-31,30\n")
    assert _promo(tx, plan30, dry_run=True)["findings"] == []


def test_promo_check_golden_approved_promo_counts_as_approved(db):
    _seed_promo(db)
    _replica(db, True)
    db.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
               " program_id, valid_from, approved_by) values (%s, 'shopee',"
               " 'promo', 700000, 'TET27', '2026-10-01', 'GD KD')", (SKU,))
    db.execute("insert into price_list (sku_key, channel, kind, price_vnd,"
               " program_id, valid_from) values (%s, 'shopee', 'promo',"
               " 600000, 'CHUADUYET', '2026-10-01')", (SKU,))
    _replica(db, False)
    _snapshot(db, 1, [(SKU, 1_000_000, 700_000)])
    r = _promo(_TxConn(db), dry_run=True)
    assert r["findings"] == [] and r["ok"] == 1
    _snapshot(db, 2, [(SKU, 1_000_000, 600_000)])   # mức CHƯA duyệt
    r = _promo(_TxConn(db), dry_run=True)
    assert [f["code"] for f in r["findings"]] == ["km_sau_hon_duyet"]


def test_promo_running_file_only_rows_live_today(db, tmp_path):
    """File xuất KM: dòng chưa bắt đầu/đã kết thúc không phải 'đang chạy'."""
    _seed_promo(db)
    run = _plan(tmp_path, (
        f"V1,shopee,{SKU},voucher,2026-11-01,2026-11-30,30\n"
        f"V2,shopee,{SKU},voucher,2026-09-01,2026-09-30,30\n"
        f"V3,shopee,{SKU},voucher,2026-10-10,2026-10-20,30\n"))
    r = ceo_promo.promo_check(_TxConn(db), TODAY, mapping={}, plan=None,
                              running_file=run, plan_sha=None,
                              running_sha="cd" * 32, cfg=CEO, dry_run=True)
    assert r["running"] == 1
    assert [f["code"] for f in r["findings"]] == ["km_ngoai_ke_hoach"]
    assert "V3" in r["items"][0]["payload"]


def test_promo_feature_off_blocks(db, monkeypatch):
    _seed_promo(db)
    _snapshot(db, 1, [(SKU, 1_000_000, 700_000)])
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        _promo(_TxConn(db))
    assert _queue(db, "promo_deviation") == []


# ---------------------------------------------------- intel-04.2 DB

def _trends(db, name="related_MAU.csv"):
    iid = db.execute("insert into intel_imports (kind, file_name,"
                     " file_sha256, row_count) values ('trend_related', %s,"
                     " %s, 5) returning id",
                     (name, uuid.uuid4().hex * 2)).fetchone()[0]
    for seed, sec, q, v in (
            ("sâm ngọc linh", "rising", "hộp quà sâm biếu tết", "+250%"),
            ("sâm ngọc linh", "top", "sâm ngọc linh chữa ung thư", "100"),
            ("sâm ngọc linh", "rising", "rượu sâm ngọc linh", "Breakout"),
            ("sâm ngọc linh", "top", "Hộp quà sâm biếu Tết", "80"),
            ("sâm ngọc linh", "top", "sam ngoc linh tri tieu duong", "40")):
        db.execute("insert into trends_related (import_id, seed, section,"
                   " query, value) values (%s, %s, %s, %s, %s)",
                   (iid, seed, sec, q, v))
    return iid


INTEL = director.load_config("intel")


def test_suggest_keywords_one_item_per_file(db):
    iid = _trends(db)
    tx = _TxConn(db)
    r = iw.suggest_keywords(tx, None, INTEL, dry_run=True)
    assert [s[3] for s in r["res"]["safe"]] == ["hộp quà sâm biếu tết"]
    assert len(r["res"]["excluded"]) == 3          # trùng hoa/thường gộp
    assert _queue(db, "keyword_suggest") == []
    r = iw.suggest_keywords(tx, None, INTEL)
    q = _queue(db, "keyword_suggest")
    assert len(q) == 1 and r["qid"] == q[0][0]
    _id, block, oid, _t, payload, _st, by, sample, g = q[0]
    assert (block, oid, by, sample) == ("intel", f"kw:{iid}",
                                        "agent:intel_keywords", True)
    assert g["ok"] is True
    for leak in ("chữa", "ung thư", "rượu", "tieu duong"):
        assert leak not in payload
    assert iw.suggest_keywords(tx, None, INTEL)["skipped"] is True
    assert len(_queue(db, "keyword_suggest")) == 1
    _trends(db, "related_2.csv")                    # file mới = đợt mới
    assert iw.suggest_keywords(tx, None, INTEL)["qid"] is not None
    assert [x[7] for x in _queue(db, "keyword_suggest")] == [True, False]


def test_suggest_keywords_off_and_empty(db, monkeypatch):
    tx = _TxConn(db)
    assert iw.suggest_keywords(tx, None, INTEL)["res"] is None
    _trends(db)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat")
    with pytest.raises(rollout.RolloutBlocked):
        iw.suggest_keywords(tx, None, INTEL)
    assert _queue(db, "keyword_suggest") == []
