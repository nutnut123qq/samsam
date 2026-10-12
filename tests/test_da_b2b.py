"""v8.3 W83.6 — DA-05 `org_prospects`: tổ chức mua quà Tết, KHÔNG PII,
KHÔNG tự liên hệ.

`dedup_key` chuẩn hóa (hoa/dấu/ký tự lạ) → `b2b:<sha256>`; `read_csv` kiểm
toàn file trước connect (≥10 biến thể lỗi, message có số dòng, KHÔNG chứa
giá trị ô); nạp ×2 idempotent; lô → 1 mục pending; chỉ chuyển
`chuyen_sales` khi NGƯỜI duyệt + bảng dựng lại khớp sha256; sửa dữ liệu
sau khi duyệt → lệch → 0 dòng đổi; lô bị từ chối → dòng về `moi`.
DB thật trong schema tạm + ROLLBACK.
"""

import re
from pathlib import Path

import pytest

from agents import da_b2b
from pipelines import approval_queue as aq
from pipelines.pii import _PII_RE
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
FX = ROOT / "tests" / "fixtures" / "du_an"
MAU = FX / "to_chuc_MAU.csv"
LOI = FX / "to_chuc_loi.csv"
HDR = "org_name,org_type,region,website,source_url,fit_reason\n"
OK_ROW = ("Công ty MẪU X,doanh_nghiep,Đà Nẵng,https://x.example.com/,"
          "https://x.example.com/gt,MẪU — tặng quà Tết đối tác\n")
APPROVER = "GĐ bán hàng MẪU"


@pytest.fixture
def db():
    yield from da_db()


# ---------------------------------------------------------------- thuần


def test_dedup_key_normalization():
    k = da_b2b.dedup_key("Khách sạn MẪU A", "Đà Nẵng")
    assert re.fullmatch(r"b2b:[0-9a-f]{64}", k)
    assert da_b2b.dedup_key("khach  san mau-a", "Đà Nẵng") == k
    assert da_b2b.dedup_key("KHÁCH SẠN MẪU  A!", "đà nẵng") == k
    assert da_b2b.dedup_key("Khách sạn MẪU B", "Đà Nẵng") != k
    assert da_b2b.dedup_key("Khách sạn MẪU A", "Hà Nội") != k


def test_read_csv_fixture_ok():
    rows, errs = da_b2b.read_csv(MAU)
    assert errs == [] and len(rows) >= 15
    assert all(r["dedup_key"].startswith("b2b:") for r in rows)
    assert all("MẪU" in r["org_name"] for r in rows)
    assert len({r["dedup_key"] for r in rows}) == len(rows)
    for r in rows:
        for k in ("org_name", "region", "website", "source_url",
                  "fit_reason"):
            assert not _PII_RE.search(r[k] or ""), (k, r["org_name"])


def _w(tmp_path, body: bytes, name="x.csv"):
    p = tmp_path / name
    p.write_bytes(body)
    return p


_ERR_CASES = {
    "header-sai": ("org_name,loai,region,website,source_url,fit_reason\n"
                   + OK_ROW, "loai", 1),
    "org-type-la": (HDR + OK_ROW.replace("doanh_nghiep", "ca_nhan_bi_mat"),
                    "ca_nhan_bi_mat", 2),
    "tinh-khong-nhan-ra": (HDR + OK_ROW.replace("Đà Nẵng", "Xứ Thần Tiên"),
                           "Xứ Thần Tiên", 2),
    "tinh-mo-ho": (HDR + OK_ROW.replace("Đà Nẵng", "Đà Nẵng và Hà Nội"),
                   "Đà Nẵng và Hà Nội", 2),
    "website-facebook": (HDR + OK_ROW.replace("https://x.example.com/,",
                                              "https://facebook.com/xbi,"),
                         "facebook.com/xbi", 2),
    "source-zalo": (HDR + OK_ROW.replace("https://x.example.com/gt",
                                         "https://zalo.me/9999bimat"),
                    "zalo.me/9999bimat", 2),
    "source-ftp": (HDR + OK_ROW.replace("https://x.example.com/gt",
                                        "ftp://x.example.com/bimat"),
                   "ftp://x.example.com/bimat", 2),
    "source-thieu": (HDR + OK_ROW.replace("https://x.example.com/gt", ""),
                     None, 2),
    "sdt": (HDR + OK_ROW.replace("đối tác", "gọi 0905 123 456"),
            "0905 123 456", 2),
    "email": (HDR + OK_ROW.replace("đối tác", "abc@gmail.com"),
              "abc@gmail.com", 2),
    "sdt-o-ten": (HDR + OK_ROW.replace("Công ty MẪU X", "Công ty 0905123456"),
                  "0905123456", 2),
    "ruou": (HDR + OK_ROW.replace("tặng quà Tết đối tác", "rượu sâm biếu sếp"),
             "rượu sâm biếu sếp", 2),
    "trung-khac-hoa-dau": (HDR + OK_ROW + OK_ROW.replace(
        "Công ty MẪU X", "cong ty  mau-x").replace("Đà Nẵng", "da nang"),
        "cong ty  mau-x", 3),
    "thieu-cot": (HDR + "Công ty MẪU X,doanh_nghiep,Đà Nẵng\n", None, 2),
    "ten-1-ky-tu": (HDR + OK_ROW.replace("Công ty MẪU X", "Q"), None, 2),
    "fit-qua-dai": (HDR + OK_ROW.replace("đối tác", "a" * 301), None, 2),
    # Ô trượt guardrail → lô chứa ô đó không duyệt được, quay lại mãi.
    "tu-cam-ten-sua-chua": (HDR + OK_ROW.replace(
        "Công ty MẪU X", "Công ty Sửa chữa ô tô MẪU"),
        "Công ty Sửa chữa ô tô MẪU", 2),
    "tu-cam-nha-thuoc": (HDR + OK_ROW.replace("Công ty MẪU X",
                                              "Nhà thuốc MẪU"),
                         "Nhà thuốc MẪU", 2),
    "tu-cam-ung-thu": (HDR + OK_ROW.replace("Công ty MẪU X",
                                            "Bệnh viện Ung thư MẪU"),
                       "Bệnh viện Ung thư MẪU", 2),
    "tu-cam-fit": (HDR + OK_ROW.replace("tặng quà Tết đối tác",
                                        "hỗ trợ điều trị cho đối tác"),
                   "hỗ trợ điều trị cho đối tác", 2),
    "tu-cam-url": (HDR + OK_ROW.replace("https://x.example.com/gt",
                                        "https://x.example.com/thuoc"),
                   "x.example.com/thuoc", 2),
    "ruou-ten": (HDR + OK_ROW.replace("Công ty MẪU X", "Công ty Rượu MẪU"),
                 "Công ty Rượu MẪU", 2),
}


@pytest.mark.parametrize("name", sorted(_ERR_CASES))
def test_read_csv_errors_line_no_value(tmp_path, name):
    body, secret, line = _ERR_CASES[name]
    rows, errs = da_b2b.read_csv(_w(tmp_path, body.encode("utf-8")))
    assert rows == [] and errs, name
    assert any(f"dòng {line}" in e for e in errs), errs
    if secret:
        assert not [e for e in errs if secret in e], errs


def test_guardrail_cell_error_names_column(tmp_path):
    body = HDR + OK_ROW + OK_ROW.replace("Công ty MẪU X", "Nhà thuốc MẪU")
    rows, errs = da_b2b.read_csv(_w(tmp_path, body.encode("utf-8")))
    assert rows == [] and len(errs) == 1
    assert errs[0].startswith("dòng 3 cột org_name: chứa từ/cụm guardrail")
    assert "tu_cam" in errs[0] and "ghi khác" in errs[0]


def test_tier_c_config_broken_fails_closed(tmp_path, monkeypatch, capsys):
    """intel_sources.json hỏng → KHÔNG được bỏ qua danh sách tầng C
    (linkedin.com chỉ có ở tầng C, không trong HARD_BLOCK) — cả file bị từ
    chối, không connect."""
    body = HDR + OK_ROW.replace("https://x.example.com/gt",
                                "https://www.linkedin.com/in/nguyen-van-a")
    csvp = _w(tmp_path, body.encode("utf-8"))
    rows, errs = da_b2b.read_csv(csvp)                  # cấu hình thật
    assert rows == [] and any("cột source_url" in e and "tầng C" in e
                              for e in errs), errs
    broken = _w(tmp_path, b"{ hong", name="src.json")
    monkeypatch.setattr(da_b2b, "SOURCES_FILE", broken)
    rows, errs = da_b2b.read_csv(csvp)
    assert rows == [] and errs and "intel_sources.json hỏng" in errs[0]
    ok_csv = _w(tmp_path, (HDR + OK_ROW).encode("utf-8"), name="ok.csv")
    assert da_b2b.read_csv(ok_csv)[0] == []          # kể cả file sạch
    monkeypatch.setattr(da_b2b, "connect", lambda: pytest.fail("connect"))
    assert da_b2b.main(["--import", str(csvp), "--by", "X"]) == 1
    err = capsys.readouterr().err
    assert "KHÔNG nạp dòng nào" in err and "nguyen-van-a" not in err


def test_read_csv_bad_bytes_and_size(tmp_path):
    body = (HDR + OK_ROW).encode("utf-8") + b"Cong ty \xff,khac,Hue,,"
    rows, errs = da_b2b.read_csv(_w(tmp_path, body))
    assert rows == [] and errs == [errs[0]] and "dòng 3" in errs[0]
    rows, errs = da_b2b.read_csv(_w(tmp_path, b"a" * (da_b2b.MAX_BYTES + 1)))
    assert rows == [] and "1 MB" in errs[0]
    rows, errs = da_b2b.read_csv(_w(tmp_path, HDR.encode("utf-8")))
    assert rows == [] and errs
    bom = b"\xef\xbb\xbf" + (HDR + OK_ROW).encode("utf-8")
    rows, errs = da_b2b.read_csv(_w(tmp_path, bom))
    assert errs == [] and len(rows) == 1


def test_read_csv_one_bad_row_rejects_whole_file(tmp_path):
    body = HDR + OK_ROW + OK_ROW.replace("Công ty MẪU X", "Công ty MẪU Y") \
        .replace("đối tác", "0905 123 456")
    rows, errs = da_b2b.read_csv(_w(tmp_path, body.encode("utf-8")))
    assert rows == [] and len(errs) == 1


def test_loi_fixture_cli_exit1_no_connect(monkeypatch, capsys):
    monkeypatch.setattr(da_b2b, "connect", lambda: pytest.fail("connect"))
    assert da_b2b.main(["--import", str(LOI), "--by", "X"]) == 1
    err = capsys.readouterr().err
    assert "KHÔNG nạp dòng nào" in err
    for secret in ("0905 123 456", "abc@gmail.com", "facebook.com/mau-l3",
                   "zalo.me", "rượu sâm"):
        assert secret not in err


def test_render_batch_footer_and_escape():
    rows = [{"id": 1, "dedup_key": "b2b:" + "a" * 64, "org_name": "Tổ chức A|B",
             "org_type": "khac", "region": "Đà Nẵng", "website": None,
             "source_url": "https://a.example.org/", "fit_reason": None}]
    md = da_b2b.render_batch(rows)
    assert da_b2b.FOOTER in md and "Tổ chức A\\|B" in md
    assert "KHÔNG tự liên hệ" in md


@pytest.mark.parametrize("argv", [
    ["--import", "a.csv", "--list", "--by", "X"],
    ["--submit-batch", "--list"], [], ["--import", "a.csv"],
    ["--handover", "1"], ["--handover", "1", "--by", "  "],
    ["--submit-batch", "--limit", "0"], ["--list", "--status", "la"]])
def test_cli_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(da_b2b, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        da_b2b.main(argv)
    assert e.value.code == 2


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(da_b2b, "connect", lambda: None)
    assert da_b2b.main(["--import", str(MAU), "--by", "X"]) == 2


def test_no_contact_path_grep():
    src = (ROOT / "agents" / "da_b2b.py").read_text(encoding="utf-8")
    assert not re.search(r"smtplib|email\.mime|httpx|requests|"
                         r"urllib\.request|socket|llm_gateway", src)


# ---------------------------------------------------------------- DB


def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(da_b2b, "connect", lambda: TxConn(db))
    return da_b2b.main(list(argv))


def _n(db, where="true", params=()):
    return db.execute(f"select count(*) from org_prospects where {where}",
                      params).fetchone()[0]


def _batch(db, monkeypatch, limit="15"):
    assert _cli(db, monkeypatch, "--import", str(MAU), "--by",
                "Người nhập MẪU") == 0
    assert _cli(db, monkeypatch, "--submit-batch", "--limit", limit) == 0
    qid = db.execute("select max(id) from approval_queue where object_type"
                     " = 'org_prospect_batch'").fetchone()[0]
    assert qid is not None
    return qid


def test_import_twice_idempotent_no_pii(db, monkeypatch, capsys):
    assert _cli(db, monkeypatch, "--import", str(MAU), "--by", "MẪU") == 0
    n = _n(db)
    assert n == 16 and "inserted=16" in capsys.readouterr().out
    assert _cli(db, monkeypatch, "--import", str(MAU), "--by", "MẪU") == 0
    assert "inserted=0 dup=16" in capsys.readouterr().out
    assert _n(db) == n
    cols = [r[0] for r in db.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = 'org_prospects'"
        " and data_type = 'text'")]
    # dedup_key = sha256 hex (CHECK ^b2b:[0-9a-f]{64}$) — chuỗi số trong hash
    # khớp giả regex SĐT, không phải dữ liệu nhập → kiểm định dạng thay.
    assert "dedup_key" in cols and len(cols) >= 9
    cols.remove("dedup_key")
    assert db.execute("select count(*) from org_prospects where dedup_key"
                      " !~ '^b2b:[0-9a-f]{64}$'").fetchone()[0] == 0
    hits = 0
    for row in db.execute(f"select {', '.join(cols)} from org_prospects"):
        hits += sum(bool(_PII_RE.search(v or "")) for v in row)
    assert hits == 0
    src = db.execute("select distinct source, status from org_prospects"
                     ).fetchall()
    assert src == [("manual:to_chuc_MAU.csv", "moi")]
    assert _cli(db, monkeypatch, "--list", "--status", "moi") == 0
    assert "[done] 16 tổ chức" in capsys.readouterr().out


def test_batch_pending_then_handover_after_human(db, monkeypatch, capsys):
    qid = _batch(db, monkeypatch)
    q = db.execute("select block, object_type, status, created_by, payload"
                   " from approval_queue where id = %s", (qid,)).fetchone()
    assert q[:4] == ("projects", "org_prospect_batch", "pending",
                     "agent:da_b2b")
    assert da_b2b.FOOTER in q[4] and "15 tổ chức" in q[4]
    assert _count_q(db) == 1
    assert _n(db, "status = 'cho_duyet' and batch_queue_id = %s", (qid,)) \
        == 15
    assert _n(db, "status = 'moi'") == 1 and _n(db, "status = "
                                               "'chuyen_sales'") == 0
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 1
    assert _n(db, "status = 'chuyen_sales'") == 0
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert "15 tổ chức → chuyen_sales" in capsys.readouterr().out
    assert _n(db, "status = 'chuyen_sales' and handed_at is not null") == 15
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert "0 tổ chức" in capsys.readouterr().out
    assert _n(db, "status = 'chuyen_sales'") == 15
    # Lô tiếp theo chỉ còn 1 dòng 'moi'; hết dòng → "không có lô".
    assert _cli(db, monkeypatch, "--submit-batch") == 0
    assert _cli(db, monkeypatch, "--submit-batch") == 0
    assert "không có lô" in capsys.readouterr().out
    assert _count_q(db) == 2


def _count_q(db):
    return db.execute("select count(*) from approval_queue where object_type"
                      " = 'org_prospect_batch'").fetchone()[0]


def test_tampered_after_approval_blocks_handover(db, monkeypatch):
    qid = _batch(db, monkeypatch)
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "approved")
    assert ok, msg
    db.execute("update org_prospects set fit_reason = 'MẪU — sửa sau duyệt'"
               " where id = (select min(id) from org_prospects)")
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 1
    assert _n(db, "status = 'chuyen_sales'") == 0
    assert _n(db, "status = 'cho_duyet'") == 15


def test_rejected_batch_rows_back_to_moi(db, monkeypatch):
    qid = _batch(db, monkeypatch)
    ok, msg = aq.decide(TxConn(db), qid, APPROVER, "rejected")
    assert ok, msg
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert _n(db, "status = 'moi' and batch_queue_id is null") == 16
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert _n(db, "status = 'moi'") == 16


def test_expired_batch_rows_back_to_moi_and_rebatchable(db, monkeypatch,
                                                       capsys):
    """Lô hết hạn SLA (`expired`) → dòng về 'moi' (không kẹt 'cho_duyet'),
    lập lô mới được và lô mới duyệt + chuyển được."""
    qid = _batch(db, monkeypatch)
    db.execute("set local session_replication_role = replica")
    db.execute("update approval_queue set due_at = now() - interval '1 h'"
               " where id = %s", (qid,))
    db.execute("set local session_replication_role = origin")
    assert aq.expire_overdue(TxConn(db)) == 1
    assert db.execute("select status from approval_queue where id = %s",
                      (qid,)).fetchone()[0] == "expired"
    capsys.readouterr()
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert "hết hạn SLA — 15 dòng về 'moi'" in capsys.readouterr().out
    assert _n(db, "status = 'moi' and batch_queue_id is null") == 16
    assert _cli(db, monkeypatch, "--handover", str(qid), "--by", "X") == 0
    assert _n(db, "status = 'moi'") == 16                      # chạy lại 0
    assert _cli(db, monkeypatch, "--submit-batch", "--limit", "15") == 0
    q2 = db.execute("select max(id) from approval_queue").fetchone()[0]
    assert q2 != qid
    ok, msg = aq.decide(TxConn(db), q2, APPROVER, "approved")
    assert ok, msg
    assert _cli(db, monkeypatch, "--handover", str(q2), "--by", "X") == 0
    assert _n(db, "status = 'chuyen_sales'") == 15


def test_handover_wrong_item_type_and_missing(db, monkeypatch):
    from pipelines import director
    cq = director.submit(TxConn(db), "projects", "change_request",
                         object_id="cr:mau000000002", title="CR MẪU",
                         payload="# CR MẪU\n", created_by="agent:da_cr")
    assert _cli(db, monkeypatch, "--handover", str(cq), "--by", "X") == 1
    assert _cli(db, monkeypatch, "--handover", "999999", "--by", "X") == 1
