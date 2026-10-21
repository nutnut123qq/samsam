"""v3.8-ocr-intake (W38.2–W38.6) — `ingest.doc_intake` trên PDF fixture
VIẾT TAY (không reportlab, không giấy tờ thật) + fake conn ghi SQL. Không
chạm DB thật, không mạng (test OCR chặn `socket.connect`)."""

import io
import os
import socket
from pathlib import Path

import psycopg
import pytest
from pypdf import PdfReader, PdfWriter

from ingest import doc_intake as di

ROOT = Path(__file__).resolve().parent.parent
PHONE = "0901234567"
GIAY = ["So: 1234/2024/DKSP", "ngay 05/03/2024",
        "Ten san pham: Sam Ngoc Linh X"]


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(lines: list[str] | None) -> bytes:
    """PDF 1 trang tối thiểu. `lines=None` → trang KHÔNG content stream
    (mô phỏng bản scan: lớp text rỗng)."""
    return make_pdf_pages([lines])


def make_pdf_pages(pages: list[list[str] | None]) -> bytes:
    """PDF nhiều trang; mỗi phần tử như `lines` của `make_pdf`."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for lines in pages:
        kids.append(f"{len(objs) + 1} 0 R")
        if lines is None:
            objs.append("<< /Type /Page /Parent 2 0 R"
                        " /MediaBox [0 0 612 792] >>")
            continue
        ops = ("BT /F1 12 Tf 14 TL 72 720 Td "
               + " ".join(f"({_esc(ln)}) Tj T*" for ln in lines) + " ET")
        objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
                    " /Resources << /Font << /F1 3 0 R >> >>"
                    f" /Contents {len(objs) + 2} 0 R >>")
        objs.append(f"<< /Length {len(ops)} >>\nstream\n{ops}\nendstream")
    objs[1] = (f"<< /Type /Pages /Kids [{' '.join(kids)}]"
               f" /Count {len(kids)} >>")
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += (f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
            + b"".join(f"{o:010d} 00000 n \n".encode() for o in offs)
            + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
              f"startxref\n{xref}\n%%EOF\n".encode())
    return out


class FakeCursor:
    def __init__(self, rows=(), rowcount=0):
        self._rows, self.rowcount = list(rows), rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class FakeConn:
    """Ghi SQL; mô phỏng tối thiểu documents/document_fields."""

    def __init__(self, docs=None):
        self.docs = dict(docs or {})   # sha -> status
        self.fields = {}               # (sha, field) -> [value, conf, verified]
        self.sql = []                  # (sql, params, rowcount)
        self.commits = self.rollbacks = self.closed = 0

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        rc, rows = 0, []
        if s.startswith("select status from documents"):
            st = self.docs.get(params[0])
            rows = [(st,)] if st else []
        elif s.startswith("insert into documents"):
            if params[0] not in self.docs:
                self.docs[params[0]] = params[6]
                rc = 1
        elif s.startswith("insert into document_fields"):
            assert "false)" in s  # verified luôn false lúc insert
            if (params[0], params[1]) not in self.fields:
                self.fields[(params[0], params[1])] = [params[2], params[3],
                                                       False]
                rc = 1
        elif s.startswith("update documents set status"):
            if self.docs.get(params[2]) == "pending_review":
                self.docs[params[2]] = params[0]
                rc = 1
        elif s.startswith("update document_fields set verified = true"):
            for k, v in self.fields.items():
                if k[0] == params[0]:
                    v[2] = True
                    rc += 1
        elif s.startswith("select doc_review_human"):
            # v15.4 (P10.1): mô phỏng function SECURITY DEFINER — chỉ từ
            # pending_review; verified kéo field verified.
            sha, status, _by = params
            ok = self.docs.get(sha) == "pending_review"
            if ok:
                self.docs[sha] = status
                if status == "verified":
                    for k, v in self.fields.items():
                        if k[0] == sha:
                            v[2] = True
            rows = [(ok,)]
        elif s.startswith("select d.sha256"):
            rows = [(k, "giay_tiep_nhan", v, True, "so_giay=1/2024/DKSP")
                    for k, v in self.docs.items()
                    if v in ("pending_review", "cho_ocr")]
        self.sql.append((s, params, rc))
        return FakeCursor(rows, rc)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed += 1

    def count(self, prefix):
        return sum(1 for s, _, _ in self.sql if s.startswith(prefix))


@pytest.fixture
def dirs(tmp_path):
    intake = tmp_path / "intake"
    (intake / "giay_tiep_nhan").mkdir(parents=True)
    return intake, tmp_path / "originals"


@pytest.fixture
def no_network(monkeypatch):
    calls = []

    def boom(self, *a, **k):
        calls.append(a)
        raise AssertionError("không được gọi mạng")
    monkeypatch.setattr(socket.socket, "connect", boom)
    return calls


def _put(intake, rel, data):
    p = intake / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


# --- W38.5 trích field ------------------------------------------------------
def test_extract_text_and_fields_ascii_fixture(tmp_path):
    p = _put(tmp_path, "g.pdf", make_pdf(GIAY))
    text, pages, src = di.extract_text(p)
    assert (pages, src) == (1, "pdf_text")
    f = di.extract_fields(text)
    assert f["so_giay"] == ("1234/2024/DKSP", 1.0)
    assert f["ngay_cap"] == ("2024-03-05", 1.0)
    assert f["ten_san_pham"] == ("Sam Ngoc Linh X", 1.0)


def test_extract_fields_unicode_and_chu_date_priority():
    t = ("Số: 0123/2023/ĐKSP\nHà Nội, ngày 7 tháng 11 năm 2023\n"
         "Hiệu lực 01/01/2020\nTên sản phẩm: Sâm Ngọc Linh Y  ")
    f = di.extract_fields(t)
    assert f["so_giay"] == ("0123/2023/ĐKSP", 1.0)
    # Dạng chữ ưu tiên — dd/mm/yyyy chỉ là fallback.
    assert f["ngay_cap"] == ("2023-11-07", 1.0)
    assert f["ten_san_pham"] == ("Sâm Ngọc Linh Y", 1.0)
    # NFD đầu vào (PDF có thể tách dấu) vẫn khớp sau NFC.
    import unicodedata
    nfd = unicodedata.normalize("NFD", t)
    assert di.extract_fields(nfd)["so_giay"][0] == "0123/2023/ĐKSP"


def test_extract_fields_invalid_date_and_bounds():
    assert "ngay_cap" not in di.extract_fields("ngay 31/02/2024")
    assert "ngay_cap" not in di.extract_fields("ngày 31 tháng 2 năm 2024")
    # Ngày chữ không hợp lệ → fallback số hợp lệ.
    f = di.extract_fields("ngày 31 tháng 2 năm 2024; ký 05-03-2024")
    assert f["ngay_cap"] == ("2024-03-05", 1.0)
    # Sep trộn không phải ngày; giá không phải ngày.
    assert di.extract_fields("05/03-2024 gia 1.500.000") == {}
    # Chuỗi 8 chữ số sát nhau KHÔNG bị cắt đuôi 6 số.
    assert "so_giay" not in di.extract_fields("12345678/2024/DKSP")
    assert "so_giay" not in di.extract_fields("1234/2024/DKSPX")
    assert di.extract_fields("") == {}
    assert "ten_san_pham" not in di.extract_fields("Tên sản phẩm:   \nX")
    long = di.extract_fields("Ten san pham: " + "a" * 500)
    assert len(long["ten_san_pham"][0]) == di.TEN_SP_MAX


def test_extract_fields_multiple_candidates_conf_half():
    f = di.extract_fields("1/2024/DKSP va 2/2024/DKSP, lai 1/2024/DKSP")
    assert f["so_giay"] == ("1/2024/DKSP", 0.5)
    same = di.extract_fields("1/2024/DKSP ... 1/2024/DKSP")
    assert same["so_giay"] == ("1/2024/DKSP", 1.0)


# --- W38.4 PII --------------------------------------------------------------
def test_has_pii_phone_email_price():
    assert di.has_pii(f"Dien thoai: {PHONE}") is True
    assert di.has_pii("lien he: abc@example.com") is True
    assert di.has_pii("So 1234/2024/DKSP ngay 05/03/2024 gia 1.500.000") \
        is False
    # `_mask_pii` unwrap "(1500)" → text đổi nhưng KHÔNG phải PII.
    assert di.has_pii("Gia (1500) va (90)") is False
    assert di.has_pii("ghi chu *** san co") is False


def test_intake_pii_flag_and_stdout_clean(dirs, capsys):
    intake, orig = dirs
    name = "hop dong Nguyen Van A.pdf"
    _put(intake, f"giay_tiep_nhan/{name}",
         make_pdf(GIAY + [f"Dien thoai: {PHONE}"]))
    _put(intake, "giay_tiep_nhan/b.pdf", make_pdf(GIAY + ["gia 1.500.000"]))
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert c["new"] == 2 and c["error"] == 0
    flags = {p[0]: p[5] for s, p, _ in conn.sql
             if s.startswith("insert into documents")}
    assert sorted(flags.values()) == [False, True]
    out = capsys.readouterr().out
    for leak in (PHONE, name, "Nguyen Van A", "Sam Ngoc Linh", "Dien thoai"):
        assert leak not in out


# --- W38.2 intake idempotent + bản gốc bất biến ------------------------------
def test_intake_twice_one_record_original_untouched(dirs):
    intake, orig = dirs
    p = _put(intake, "giay_tiep_nhan/g.pdf", make_pdf(GIAY))
    sha = di.sha256_file(p)
    conn = FakeConn()
    c1 = di.intake(intake, orig, conn)
    assert c1 == {"new": 1, "dup": 0, "cho_ocr": 0, "skipped": 0, "error": 0}
    o = orig / sha
    before = (o.read_bytes(), o.stat().st_mtime_ns)
    n_fields = conn.count("insert into document_fields")
    c2 = di.intake(intake, orig, conn)
    assert c2["dup"] == 1 and c2["new"] == 0
    ins = [(p_, rc) for s, p_, rc in conn.sql
           if s.startswith("insert into documents") and p_[0] == sha]
    assert ins == [(ins[0][0], 1)]          # đúng 1 lần, rowcount 1
    assert conn.count("insert into document_fields") == n_fields == 3
    assert all(v[2] is False for v in conn.fields.values())
    assert (o.read_bytes(), o.stat().st_mtime_ns) == before
    assert o.read_bytes() == p.read_bytes()
    assert p.exists()                       # intake không xoá file nguồn
    assert [x.name for x in orig.iterdir()] == [sha]  # không sót file tạm


def test_existing_original_wrong_hash_not_overwritten(dirs):
    intake, orig = dirs
    p = _put(intake, "giay_tiep_nhan/g.pdf", make_pdf(GIAY))
    sha = di.sha256_file(p)
    orig.mkdir()
    (orig / sha).write_bytes(b"khac noi dung")
    nxt = _put(intake, "nhan/z.pdf", make_pdf(["Nhan san pham abc xyz 123"]))
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert (orig / sha).read_bytes() == b"khac noi dung"
    assert c["error"] == 1 and c["new"] == 1   # lô chạy tiếp file sau
    assert sha not in conn.docs and di.sha256_file(nxt) in conn.docs
    with pytest.raises(di.DocError):
        di.store_original(p, sha, orig)


def test_same_content_two_names_one_record(dirs):
    intake, orig = dirs
    data = make_pdf(GIAY)
    _put(intake, "giay_tiep_nhan/a.pdf", data)
    _put(intake, "giay_tiep_nhan/b.pdf", data)
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert (c["new"], c["dup"]) == (1, 1)
    assert len(conn.docs) == 1 and len(list(orig.iterdir())) == 1


# --- biên intake (mỗi case 1 test) -------------------------------------------
def test_intake_missing_dir(tmp_path):
    c = di.intake(tmp_path / "khong-co", tmp_path / "o", FakeConn())
    assert c == dict.fromkeys(("new", "dup", "cho_ocr", "skipped", "error"), 0)


def test_intake_empty_dir(dirs):
    intake, orig = dirs
    conn = FakeConn()
    assert sum(di.intake(intake, orig, conn).values()) == 0
    assert conn.sql == []


def test_intake_zero_byte_skipped(dirs):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/rong.pdf", b"")
    conn = FakeConn()
    assert di.intake(intake, orig, conn)["skipped"] == 1
    assert conn.sql == [] and not orig.exists()


def test_intake_unknown_ext_skipped(dirs):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/a.docx", b"PK..")
    _put(intake, "giay_tiep_nhan/noext", b"x")
    c = di.intake(intake, orig, FakeConn())
    assert c["skipped"] == 2 and c["new"] == 0


def test_intake_corrupt_and_encrypted_pdf_error_batch_continues(dirs):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/1.pdf", b"%PDF-1.4\ngarbage")
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(make_pdf(GIAY))))
    w.encrypt("pw", algorithm="RC4-128")
    buf = io.BytesIO()
    w.write(buf)
    _put(intake, "giay_tiep_nhan/2.pdf", buf.getvalue())
    ok = _put(intake, "giay_tiep_nhan/3.pdf", make_pdf(GIAY))
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert c["error"] == 2 and c["new"] == 1
    assert list(conn.docs) == [di.sha256_file(ok)]


def test_doc_type_from_subdir(dirs):
    intake, _ = dirs
    assert di.doc_type_of(intake / "nhan" / "a.pdf", intake) == "nhan"
    assert di.doc_type_of(intake / "a.pdf", intake) == "khac"
    assert di.doc_type_of(intake / "la" / "a.pdf", intake) == "khac"
    assert di.doc_type_of(intake / "a" / "nhan" / "x.pdf", intake) == "khac"


def test_fields_only_for_giay_tiep_nhan(dirs):
    intake, orig = dirs
    _put(intake, "hop_dong_dai_ly/h.pdf", make_pdf(GIAY))
    conn = FakeConn()
    di.intake(intake, orig, conn)
    assert conn.fields == {} and list(conn.docs.values()) == ["pending_review"]


# --- W38.3 OCR provider, không mạng -----------------------------------------
def test_scan_pdf_and_image_cho_ocr_no_network(dirs, no_network):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/scan.pdf", make_pdf(None))
    _put(intake, "ho_so_vung_trong/anh.png", b"\x89PNG\r\n\x1a\nbytes")
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert (c["new"], c["cho_ocr"], c["error"]) == (2, 2, 0)
    rows = [p for s, p, _ in conn.sql if s.startswith("insert into documents")]
    for _sha, _fn, _dt, pages, src, pii, status in rows:
        assert (pages, src, pii, status) == (1, "none", None, "cho_ocr")
    assert conn.fields == {} and no_network == []


def test_domestic_provider_text_goes_ocr(dirs, monkeypatch, no_network):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/scan.pdf", make_pdf(None))
    calls = []

    def fake(path):
        calls.append(path)
        return "So 77/2025/ĐKSP ngày 2 tháng 1 năm 2025"
    monkeypatch.setitem(di.PROVIDERS, "fake_vn", (fake, True))
    conn = FakeConn()
    c = di.intake(intake, orig, conn, "fake_vn")
    assert c["new"] == 1 and c["cho_ocr"] == 0 and len(calls) == 1
    ins = [p for s, p, _ in conn.sql if s.startswith("insert into documents")]
    assert ins[0][4:] == ("ocr", False, "pending_review")
    sha = ins[0][0]
    assert conn.fields[(sha, "so_giay")][0] == "77/2025/ĐKSP"
    assert conn.fields[(sha, "ngay_cap")][0] == "2025-01-02"


def test_foreign_provider_never_called(dirs, monkeypatch, no_network):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/scan.pdf", make_pdf(None))
    _put(intake, "nhan/a.jpg", b"\xff\xd8\xff jpeg")
    calls = []
    monkeypatch.setitem(di.PROVIDERS, "fake_us",
                        (lambda p: calls.append(p) or "text", False))
    # v13.4 (flip): trước đây intake chạy tiếp, âm thầm để 2 tài liệu ở
    # cho_ocr như thể đã cấu hình OCR — nay từ chối NGAY, 0 tài liệu ghi.
    conn = FakeConn()
    with pytest.raises(ValueError, match="nước ngoài"):
        di.intake(intake, orig, conn, "fake_us")
    assert calls == [] and conn.docs == {} and not orig.exists()


@pytest.mark.parametrize("pages", [
    [["Scanned with CamScanner"]],   # trang scan + watermark (21 ký tự)
    [["Trang 1/10"]],                # trang scan + footer
    [GIAY, ["Trang 2/2"]],           # bìa đánh máy + trang scan có footer
    [GIAY, None],                    # bìa đánh máy + trang scan trống
], ids=["camscanner", "footer", "cover+footer", "cover+blank"])
def test_scan_with_small_text_layer_cho_ocr_pii_null(dirs, no_network, pages):
    """Finding A04: lớp text nhỏ trên trang scan KHÔNG được biến tài liệu
    thành pdf_text (pii_flag=False sai → 'được gửi LLM')."""
    intake, orig = dirs
    p = _put(intake, "giay_tiep_nhan/s.pdf", make_pdf_pages(pages))
    assert di.extract_text(p)[1:] == (len(pages), "none")
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert (c["new"], c["cho_ocr"], c["error"]) == (1, 1, 0)
    ins = [p_ for s, p_, _ in conn.sql if s.startswith("insert into documents")]
    assert ins[0][3:] == (len(pages), "none", None, "cho_ocr")
    assert conn.fields == {} and no_network == []


def test_multi_page_all_text_is_pdf_text(tmp_path):
    p = _put(tmp_path, "m.pdf",
             make_pdf_pages([GIAY, GIAY + [f"Dien thoai: {PHONE}"]]))
    text, pages, src = di.extract_text(p)
    assert (pages, src) == (2, "pdf_text") and di.has_pii(text) is True


def test_unknown_provider_exit2_no_connect(monkeypatch):
    n = []
    monkeypatch.setattr(di.lead_store, "connect", lambda: n.append(1))
    monkeypatch.setenv("OCR_PROVIDER", "google_vision")
    with pytest.raises(SystemExit) as e:
        di.main([])
    assert e.value.code == 2 and n == []
    with pytest.raises(ValueError):
        di.intake(Path("x"), Path("y"), FakeConn(), "fpt")


def test_module_has_no_llm_or_network_import():
    src = (ROOT / "ingest" / "doc_intake.py").read_text(encoding="utf-8")
    for bad in ("llm_gateway", "openai", "httpx", "requests", "urllib"):
        assert bad not in src, bad


# --- W38.6 CLI --------------------------------------------------------------
SHA = "a" * 64


@pytest.fixture
def cli(monkeypatch, tmp_path):
    state = {"connects": 0, "conn": FakeConn()}

    def connect():
        state["connects"] += 1
        return state["conn"]
    monkeypatch.setattr(di.lead_store, "connect", connect)
    monkeypatch.setenv("OCR_PROVIDER", "none")
    monkeypatch.setenv("DOC_INTAKE_DIR", str(tmp_path / "in"))
    monkeypatch.setenv("DOC_ORIGINALS_DIR", str(tmp_path / "orig"))
    return state


@pytest.mark.parametrize("argv", [
    ["--verify", SHA],
    ["--verify", SHA, "--by", "   "],
    ["--reject", SHA, "--by", ""],
    ["--verify", SHA[:-1], "--by", "A"],
    ["--verify", "g" * 64, "--by", "A"],
    ["--verify", SHA, "--reject", SHA, "--by", "A"],
    ["--pending", "--verify", SHA, "--by", "A"],
    ["--pending", "--by", "A"],
    ["--verify", SHA, "--by", "A\x1b[2J"],
    ["--verify", SHA, "--by", "x" * 101],
])
def test_cli_usage_errors_exit2_before_connect(cli, argv):
    with pytest.raises(SystemExit) as e:
        di.main(argv)
    assert e.value.code == 2 and cli["connects"] == 0


def test_cli_verify_pending_review(cli, capsys):
    conn = cli["conn"] = FakeConn({SHA: "pending_review"})
    conn.fields[(SHA, "so_giay")] = ["1/2024/DKSP", 1.0, False]
    assert di.main(["--verify", SHA.upper(), "--by", "Pháp chế A"]) == 0
    # v15.4 (P10.1): ghi qua function SECURITY DEFINER (danh tính theo login,
    # điều kiện pending_review nằm trong function) — không UPDATE thẳng.
    upd = [(s, p) for s, p, _ in conn.sql
           if s.startswith("select doc_review_human")]
    assert len(upd) == 1
    assert upd[0][0] == "select doc_review_human(%s, %s, %s)"
    assert upd[0][1] == (SHA, "verified", "Pháp chế A")
    assert conn.count("update documents") == 0
    assert conn.count("update document_fields") == 0
    assert conn.commits == 1 and conn.closed == 1
    assert conn.docs[SHA] == "verified" and conn.fields[(SHA, "so_giay")][2]
    out = capsys.readouterr().out
    assert SHA[:12] in out and SHA not in out


def test_cli_reject_keeps_fields_unverified(cli):
    conn = cli["conn"] = FakeConn({SHA: "pending_review"})
    conn.fields[(SHA, "so_giay")] = ["1/2024/DKSP", 1.0, False]
    assert di.main(["--reject", SHA, "--by", "B"]) == 0
    assert conn.docs[SHA] == "rejected"
    assert conn.count("update document_fields") == 0
    assert conn.count("select doc_review_human") == 1
    assert conn.fields[(SHA, "so_giay")][2] is False


@pytest.mark.parametrize("docs", [{SHA: "cho_ocr"}, {SHA: "verified"}, {}])
def test_cli_verify_not_pending_exit1_no_change(cli, docs):
    conn = cli["conn"] = FakeConn(docs)
    assert di.main(["--verify", SHA, "--by", "A"]) == 1
    assert conn.docs == docs and conn.commits == 0
    assert conn.count("update document_fields") == 0


def test_cli_pending_and_db_down(cli, monkeypatch, capsys):
    cli["conn"] = FakeConn({SHA: "pending_review", "b" * 64: "verified"})
    assert di.main(["--pending"]) == 0
    out = capsys.readouterr().out
    assert SHA in out and "b" * 64 not in out and "1 tài liệu" in out
    monkeypatch.setattr(di.lead_store, "connect", lambda: None)
    assert di.main(["--pending"]) == 1


def test_cli_intake_runs_and_closes(cli, tmp_path, capsys):
    _put(tmp_path / "in", "giay_tiep_nhan/g.pdf", make_pdf(GIAY))
    assert di.main([]) == 0
    assert cli["conn"].closed == 1 and len(cli["conn"].docs) == 1
    assert "new=1" in capsys.readouterr().out


# --- Phần B (OWASP) ---------------------------------------------------------
def test_ten_san_pham_strips_control_chars():
    v = di.extract_fields("Ten san pham: \x1b[31mSam\rX\x07")["ten_san_pham"][0]
    assert v == "[31mSamX" and v.isprintable()


def test_extract_from_stored_original(dirs, monkeypatch):
    intake, orig = dirs
    p = _put(intake, "giay_tiep_nhan/g.pdf", make_pdf(GIAY))
    seen = []
    real = di.extract_text

    def spy(path, provider="none", ext=None):
        seen.append((path, ext))
        return real(path, provider, ext)
    monkeypatch.setattr(di, "extract_text", spy)
    conn = FakeConn()
    assert di.intake(intake, orig, conn)["new"] == 1
    assert seen == [(orig / di.sha256_file(p), ".pdf")]
    assert len(conn.fields) == 3


def test_symlink_outside_intake_skipped(dirs, tmp_path):
    intake, orig = dirs
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "x.pdf").write_bytes(make_pdf(GIAY))
    try:
        (intake / "nhan").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("không tạo được symlink (Windows thiếu quyền)")
    conn = FakeConn()
    c = di.intake(intake, orig, conn)
    assert c["new"] == 0 and conn.docs == {}


def test_junction_outside_intake_skipped(dirs, tmp_path):
    """Finding A01: rglob ĐI VÀO junction (khác symlink dir) → chỉ guard
    `resolve().is_relative_to(root)` chặn kéo file ngoài vào kho bản gốc.
    Junction tạo được không cần quyền admin."""
    _winapi = pytest.importorskip("_winapi", reason="junction chỉ có Windows")
    intake, orig = dirs
    outside = tmp_path / "secret"
    outside.mkdir()
    (outside / "x.pdf").write_bytes(make_pdf(GIAY))
    link = intake / "nhan"
    _winapi.CreateJunction(str(outside), str(link))
    try:
        assert (link / "x.pdf").is_file()   # junction thật, đọc xuyên được
        conn = FakeConn()
        c = di.intake(intake, orig, conn)
        assert c["new"] == 0 and c["skipped"] >= 1 and conn.docs == {}
        assert not orig.exists() or not any(orig.iterdir())
    finally:
        os.rmdir(link)                       # gỡ junction, không đụng đích
    assert (outside / "x.pdf").exists()


# --- lỗi DB giữa lô ---------------------------------------------------------
class AbortingConn(FakeConn):
    """Như Postgres: 1 lệnh lỗi → transaction aborted, mọi execute sau
    raise InFailedSqlTransaction tới khi rollback()."""

    def __init__(self, fail_on):
        super().__init__()
        self.fail_on, self.aborted = fail_on, False

    def execute(self, sql, params=()):
        if self.aborted:
            raise psycopg.errors.InFailedSqlTransaction("tx aborted")
        if self.fail_on and " ".join(sql.split()).startswith(self.fail_on):
            self.fail_on, self.aborted = None, True
            raise psycopg.OperationalError("boom")
        return super().execute(sql, params)

    def rollback(self):
        self.aborted = False
        super().rollback()


def test_db_error_rolls_back_and_batch_continues(dirs):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/a.pdf", make_pdf(GIAY))
    b = _put(intake, "giay_tiep_nhan/b.pdf", make_pdf(GIAY + ["ban 2"]))
    conn = AbortingConn("insert into documents")
    c = di.intake(intake, orig, conn)
    assert (c["error"], c["new"]) == (1, 1) and conn.rollbacks >= 1
    assert list(conn.docs) == [di.sha256_file(b)] and len(conn.fields) == 3


class RaceConn(FakeConn):
    """select chưa thấy sha nhưng `insert ... on conflict do nothing` trả
    rowcount 0 (process khác vừa insert cùng sha)."""

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if s.startswith("insert into documents"):
            self.sql.append((s, params, 0))
            return FakeCursor((), 0)
        return super().execute(sql, params)


def test_insert_race_rowcount0_dup_no_fields(dirs):
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/g.pdf", make_pdf(GIAY))
    conn = RaceConn()
    c = di.intake(intake, orig, conn)
    assert (c["dup"], c["new"], c["error"]) == (1, 0, 0)
    assert conn.count("insert into document_fields") == 0
    assert (conn.rollbacks, conn.commits) == (1, 0)


# --- đợt hợp đồng G3: OCR lại tài liệu cho_ocr (DB thật, schema tạm) -------
@pytest.fixture
def realdb():
    from tests.test_ceo_audit import ceo_db
    yield from ceo_db()


def test_reprocess_pending_after_provider(dirs, realdb, monkeypatch,
                                          no_network, capsys):
    from tests.test_ceo_audit import TxConn
    intake, orig = dirs
    _put(intake, "giay_tiep_nhan/scan.pdf", make_pdf(None))
    _put(intake, "nhan/b.png", b"\x89PNG\r\n\x1a\nother")
    conn = TxConn(realdb)
    assert di.intake(intake, orig, conn)["cho_ocr"] == 2
    # provider none → chặn trước mọi truy vấn
    with pytest.raises(ValueError, match="BLOCKED"):
        di.reprocess_pending(conn, orig, "none")
    monkeypatch.setitem(di.PROVIDERS, "fake_us", (lambda p: "x", False))
    with pytest.raises(ValueError, match="nước ngoài"):
        di.reprocess_pending(conn, orig, "fake_us")
    calls = []

    def fake(path):     # PDF scan ra chữ; ảnh PNG giả không ra chữ
        calls.append(path)
        return ("So 77/2025/ĐKSP ngày 2 tháng 1 năm 2025 LH 0912345678"
                if Path(path).read_bytes()[:4] == b"%PDF" else "")
    monkeypatch.setitem(di.PROVIDERS, "fake_vn", (fake, True))
    c = di.reprocess_pending(conn, orig, "fake_vn")
    assert c == {"done": 1, "still": 1, "error": 0}
    st = dict(realdb.execute("select status, count(*) from documents"
                             " group by 1").fetchall())
    assert st == {"pending_review": 1, "cho_ocr": 1}
    # Không bao giờ tự verified; PII được quét; field là nháp chưa xác minh.
    row = realdb.execute("select sha256, text_source, pii_flag from documents"
                         " where status = 'pending_review'").fetchone()
    assert row[1:] == ("ocr", True)
    assert realdb.execute("select bool_or(verified) from document_fields"
                          " where sha256 = %s", (row[0],)).fetchone()[0] \
        is False
    out = capsys.readouterr().out
    assert "0912345678" not in out and "77/2025" not in out
    # Chạy lại: chỉ tài liệu còn cho_ocr được thử, không nhân đôi field.
    calls.clear()
    assert di.reprocess_pending(conn, orig, "fake_vn") == {
        "done": 0, "still": 1, "error": 0} and len(calls) == 1
    n = realdb.execute("select count(*) from document_fields where sha256 = %s",
                       (row[0],)).fetchone()[0]
    assert n == 2
    # Bản gốc bị sửa → error, không đụng DB.
    left = realdb.execute("select sha256 from documents where status ="
                          " 'cho_ocr'").fetchone()
    if left:
        (orig / left[0]).write_bytes(b"tampered")
        c = di.reprocess_pending(conn, orig, "fake_vn")
        assert c["error"] == 1
        assert realdb.execute("select status from documents where sha256 ="
                              " %s", (left[0],)).fetchone()[0] == "cho_ocr"


def test_reprocess_cli_blocked_without_provider(monkeypatch, capsys):
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    monkeypatch.setattr(di, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(di.lead_store, "connect",
                        lambda: pytest.fail("không được connect"))
    assert di.main(["--reprocess-pending"]) == 2
    assert "[blocked]" in capsys.readouterr().out
