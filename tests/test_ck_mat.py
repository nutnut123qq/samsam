"""v9.5 W95.2 — CK-A1 luồng MẬT `agents.ck_mat`: tra cứu HOÀN TOÀN local.

Egress: fixture chặn mọi đường mở kết nối (socket connect/connect_ex,
create_connection, getaddrinfo) — dựng index (PDF + md + ảnh OCR) và mọi
nhánh ask() phải để danh sách kết nối RỖNG. Module mật không nạp module
mạng/LLM (subprocess). NO_DATA đủ 6 biến thể biên. Tài liệu test là MẪU."""
import re
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_doc_intake import make_pdf_pages

from agents import ck_mat as ck

ROOT = Path(__file__).resolve().parent.parent
BANNED = ["pipelines.llm_gateway", "ingest.embed_store", "api.rag", "openai",
          "httpx", "requests", "urllib3", "urllib.request", "google.cloud"]

PDF_P1 = ["Thong tin chung may chiet rot SS-EQ-07 (MAU).",
          "Hang san xuat MAU C, nam san xuat 2020, dat tai xuong Da Nang."]
PDF_P2 = ["Bao tri may chiet rot SS-EQ-07 (MAU).",
          "Thay gioang cao su voi chiet moi 60 ngay.",
          "Ve sinh bon chua cuoi moi ca."]
MD = ("MẪU — tài liệu giả định do dev soạn\n\n"
      "--- trang 1 ---\nMáy nén khí SS-EQ-08 (MẪU): xả nước bình chứa mỗi"
      " ngày, liên hệ tổ kỹ thuật 0901234567.\n\n"
      "--- trang 2 ---\nMáy nén khí SS-EQ-08 thay lọc gió mỗi 120 ngày.\n\n"
      "--- trang 3 ---\nSơ đồ đấu nối tủ điện nhánh 3 pha cho máy nén khí"
      " SS-EQ-08: aptomat 40 ampe, cáp 6 mm vuông.\n1. Ngắt nguồn\n"
      "2. Đấu dây pha\n")
OCR_TEXT = "Bang thong so may dong nap SS-EQ-09 toc do 30 nap moi phut MAU"


@pytest.fixture
def egress(monkeypatch):
    """Ghi lại + chặn mọi nỗ lực mở kết nối mạng."""
    calls = []

    def _block(name):
        def f(*a, **k):
            calls.append((name, a[1:] if name.startswith("socket.") else a))
            raise ConnectionRefusedError(f"egress bị chặn: {name}")
        return f
    monkeypatch.setattr(socket.socket, "connect", _block("socket.connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", _block("socket.connect_ex"))
    monkeypatch.setattr(socket, "create_connection", _block("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", _block("getaddrinfo"))
    return calls


@pytest.fixture
def fake_ocr(monkeypatch):
    seen = []

    def f(data):
        seen.append(len(data))
        return OCR_TEXT
    monkeypatch.setattr(ck, "_ocr_local", f)
    return seen


@pytest.fixture
def docs(tmp_path):
    d = tmp_path / "mat"
    d.mkdir()
    (d / "A.pdf").write_bytes(make_pdf_pages([PDF_P1, PDF_P2]))
    (d / "B.md").write_text(MD, encoding="utf-8")
    (d / "anh").mkdir()
    (d / "anh" / "C.png").write_bytes(b"\x89PNG fake MAU")
    (d / "scan.pdf").write_bytes(make_pdf_pages([None]))  # trang trắng/scan
    (d / "rong.md").write_bytes(b"")
    (d / "x.docx").write_bytes(b"MAU")
    return d


def _is_no_data(r):
    return (r["answer"] == ck.NO_DATA and r["sources"] == []
            and r["high_risk"] is False and not re.search(r"\d", r["answer"]))


# --- (a) egress: index + mọi nhánh ask, 0 kết nối ---------------------------
def test_egress_zero_connections_all_branches(docs, egress, fake_ocr, capsys):
    idx = ck.build_index(docs)
    s = idx["stats"]
    assert (s["files"], s["skipped"], s["cho_ocr"]) == (6, 2, 1)
    assert s["indexed"] == 2 + 3 + 1 and fake_ocr  # pdf 2 + md 3 + ảnh 1
    hit = ck.ask("Thay gioăng vòi chiết máy chiết rót SS-EQ-07 bao lâu?", index=idx)
    assert hit["sources"][0] == {"file": "A.pdf", "page": 2}
    img = ck.ask("Tốc độ máy đóng nắp SS-EQ-09 bao nhiêu nắp mỗi phút?", index=idx)
    assert img["sources"][0] == {"file": "anh/C.png", "page": 1}
    assert _is_no_data(ck.ask("Máy SS-EQ-99 bảo trì thế nào?", index=idx))
    hr = ck.ask("Sơ đồ đấu nối tủ điện máy nén khí SS-EQ-08?", index=idx)
    assert hr["high_risk"] is True
    out = capsys.readouterr().out
    assert "gioang" not in out.casefold()  # không in nội dung
    assert egress == []


# --- (b)(c) module mật không nạp/import module mạng-LLM ----------------------
def test_subprocess_no_banned_modules_loaded():
    code = (f"import sys, agents.ck_mat; ban = {BANNED!r};"
            " print([m for m in ban if m in sys.modules])")
    r = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                       capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 0, r.stderr[-500:]
    assert r.stdout.strip().splitlines()[-1] == "[]"


def test_no_banned_import_lines():
    src = (ROOT / "agents" / "ck_mat.py").read_text(encoding="utf-8")
    bad = re.findall(r"(?m)^\s*(?:import|from)\s+(?:openai|httpx|requests|urllib"
                     r"|google|pipelines\.llm_gateway|ingest\.embed_store"
                     r"|api\.rag)\b.*$", src)
    assert bad == []
    assert "doc_intake.PROVIDERS" not in src and "PROVIDERS" not in src


def test_no_data_matches_rag_drift_guard():
    from api import rag
    assert ck.NO_DATA == rag.NO_DATA


# --- (d) NO_DATA 6 biến thể ---------------------------------------------------
def test_no_data_missing_dir(tmp_path, egress):
    assert _is_no_data(ck.ask("máy chiết rót bảo trì", root=tmp_path / "nope"))
    assert egress == []


def test_no_data_empty_dir(tmp_path):
    (tmp_path / "e").mkdir()
    assert _is_no_data(ck.ask("máy chiết rót bảo trì", root=tmp_path / "e"))


def test_no_data_only_skipped_or_cho_ocr(tmp_path, monkeypatch, egress):
    d = tmp_path / "s"
    d.mkdir()
    (d / "rong.md").write_bytes(b"")
    (d / "x.docx").write_bytes(b"MAU")
    (d / "to.md").write_text("máy chiết rót bảo trì MẪU", encoding="utf-8")
    (d / "scan.png").write_bytes(b"\x89PNG fake")
    monkeypatch.setattr(ck, "MAX_BYTES", 12)  # to.md > MAX_BYTES → bỏ qua; png 10 byte
    monkeypatch.setattr(ck, "_ocr_local", lambda b: None)  # chưa có engine
    idx = ck.build_index(d)
    assert idx["stats"]["indexed"] == 0 and idx["stats"]["cho_ocr"] == 1
    assert idx["stats"]["skipped"] == 3
    assert _is_no_data(ck.ask("máy chiết rót bảo trì", index=idx))
    assert egress == []


@pytest.mark.parametrize("q", ["", "   ", "?!... ---", "là của và cho các"])
def test_no_data_empty_punct_stopword_question(docs, fake_ocr, q):
    assert _is_no_data(ck.ask(q, root=docs))


def test_no_data_low_coverage(docs, fake_ocr):
    q = "Quy trình hiệu chuẩn cân điện tử phòng thí nghiệm vi sinh chiết"
    assert _is_no_data(ck.ask(q, root=docs))


@pytest.mark.parametrize("q", ["Máy chiết rót SS-EQ-99 thay gioăng vòi chiết?",
                               "Máy chiết rót SS-EQ-7 thay gioăng vòi chiết?",
                               "Máy chiết rót SS-EQ-070 thay gioăng vòi chiết?"])
def test_no_data_machine_code_absent(docs, fake_ocr, q):
    # Không có mã → nội dung y hệt vẫn trúng; có mã lạ → NO_DATA.
    base = ck.ask("Máy chiết rót thay gioăng vòi chiết?", root=docs)
    assert base["sources"][0] == {"file": "A.pdf", "page": 2}
    assert _is_no_data(ck.ask(q, root=docs))


def test_question_truncated_500(docs, fake_ocr):
    q = "Thay gioăng vòi chiết máy chiết rót SS-EQ-07 " + "x" * 2000
    r = ck.ask(q, root=docs)
    assert r["sources"][0] == {"file": "A.pdf", "page": 2}


# --- (e) trúng + trích nguyên văn có mask PII ---------------------------------
def test_hit_page_and_pii_masked(docs, fake_ocr):
    r = ck.ask("Máy chiết rót SS-EQ-07 thay gioăng vòi chiết mấy ngày?", root=docs)
    assert r["high_risk"] is False
    assert r["sources"][0] == {"file": "A.pdf", "page": 2}
    assert "60 ngay" in r["answer"] and "A.pdf trang 2" in r["answer"]
    r2 = ck.ask("Máy nén khí SS-EQ-08 xả nước bình chứa liên hệ ai?", root=docs)
    assert r2["sources"][0] == {"file": "B.md", "page": 1}
    assert "0901234567" not in r2["answer"]


# --- (f) rủi ro cao: chỉ tham chiếu ------------------------------------------
@pytest.mark.parametrize("q,src,q_risky", [
    ("Sơ đồ đấu nối tủ điện máy nén khí SS-EQ-08 aptomat?", ("B.md", 3), True),
    # câu trúng chủ đề rủi ro, trang thường
    ("Đấu dây máy chiết rót SS-EQ-07 thay gioăng vòi chiết?", ("A.pdf", 2), True),
    # câu "vô hại" (không từ rủi ro) nhưng trang tốt nhất là sơ đồ đấu nối
    # tủ điện 3 pha → nhánh rủi ro phía TRANG phải chặn trích bước đấu dây.
    ("Aptomat máy nén khí SS-EQ-08 bao nhiêu ampe, cáp mấy mm vuông?",
     ("B.md", 3), False),
])
def test_high_risk_reference_only(docs, fake_ocr, q, src, q_risky):
    assert bool(ck._HIGH_RISK_RE.search(ck._fold(q))) is q_risky
    r = ck.ask(q, root=docs)
    assert r["high_risk"] is True
    assert r["sources"] == [{"file": src[0], "page": src[1]}]
    assert r["answer"] == f"Xem {src[0]} trang {src[1]} — kiểm tra với Kỹ sư trưởng"
    assert "aptomat" not in r["answer"] and "gioang" not in r["answer"]
    assert not re.search(r"(?m)^\s*\d+[.)]", r["answer"])


# --- (g) không có engine OCR → cho_ocr, không exception ------------------------
def test_ocr_engine_missing_cho_ocr(tmp_path, monkeypatch, egress, capsys):
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", None)
    assert ck._ocr_local(b"\x89PNG") is None
    d = tmp_path / "o"
    d.mkdir()
    (d / "scan.png").write_bytes(b"\x89PNG fake")
    (d / "scan.pdf").write_bytes(make_pdf_pages([None]))
    idx = ck.build_index(d)
    assert idx["stats"]["cho_ocr"] == 2 and idx["stats"]["indexed"] == 0
    assert ck.OCR_MISSING_MSG in capsys.readouterr().out
    assert egress == []


# --- (h) OCR thật local, không mạng ------------------------------------------
def test_real_local_ocr_under_egress_block(tmp_path, egress):
    pytest.importorskip("rapidocr_onnxruntime")
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    img = np.full((120, 600, 3), 255, np.uint8)
    cv2.putText(img, "SS-EQ-03", (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 2,
                (0, 0, 0), 4)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    assert "SS-EQ-03" in ck._ocr_local(buf.tobytes())
    d = tmp_path / "r"
    d.mkdir()
    (d / "nhan.png").write_bytes(buf.tobytes())
    assert ck.build_index(d)["stats"]["indexed"] == 1
    assert egress == []


# --- file lạ / symlink / PDF hỏng --------------------------------------------
def test_symlink_and_broken_pdf_skipped(tmp_path, fake_ocr):
    d = tmp_path / "l"
    d.mkdir()
    real = tmp_path / "ngoai.md"
    real.write_text("máy chiết rót bảo trì MẪU", encoding="utf-8")
    (d / "hong.pdf").write_bytes(b"%PDF-1.4 hong MAU")
    n_skip = 1
    try:
        (d / "link.md").symlink_to(real)
        n_skip += 1
    except OSError:
        pass  # Windows không có quyền tạo symlink — phần symlink bỏ qua
    idx = ck.build_index(d)
    assert idx["stats"]["skipped"] == n_skip and idx["stats"]["indexed"] == 0


# --- CLI ----------------------------------------------------------------------
def test_cli_stats_no_content(docs, fake_ocr, capsys):
    assert ck.main(["--stats", "--dir", str(docs)]) == 0
    out = capsys.readouterr().out
    assert "file=6" in out and "indexed=6" in out and "cho_ocr=1" in out
    assert "SS-EQ" not in out and "gioang" not in out


def test_cli_ask_and_bad_args(docs, fake_ocr, capsys):
    assert ck.main(["--ask", "Máy SS-EQ-99 là gì?", "--dir", str(docs)]) == 0
    assert ck.NO_DATA in capsys.readouterr().out
    for argv in ([], ["--ask", "x", "--stats"]):
        with pytest.raises(SystemExit) as e:
            ck.main(argv)
        assert e.value.code == 2


def test_gitignored_mat_dir():
    r = subprocess.run(["git", "-C", str(ROOT), "check-ignore",
                        "data/co_khi_mat/x.pdf"], capture_output=True,
                       text=True, timeout=30, check=False)
    assert r.returncode == 0


# --- rà OWASP (A04/DoS + toàn vẹn) ---------------------------------------------
def test_chunks_long_paragraph_lossless_bounded():
    # Đoạn 1 dòng dài: cắt theo chỉ số (bản cũ `p = p[N:]` quadratic — đo
    # ~97 s với 20 MB); không mất ký tự, mọi chunk <= CHUNK_CHARS.
    big = "a" * (ck.CHUNK_CHARS * 50 + 7)
    chunks = ck._chunks("mở đầu\n\n" + big + "\n\nkết")
    assert max(map(len, chunks)) <= ck.CHUNK_CHARS
    assert "".join(c.replace("\n\n", "").replace("mở đầu", "").replace("kết", "")
                   for c in chunks) == big


def test_duplicate_page_marker_merged():
    pages = ck._text_pages("MẪU\n--- trang 1 ---\nA\n--- trang 2 ---\nB\n"
                           "--- trang 1 ---\nC\n")
    assert [n for n, _ in pages] == [1, 2]
    assert "A" in pages[0][1] and "C" in pages[0][1]


def test_duplicate_page_marker_many_merged_in_order():
    # 60k dấu cùng số trang (convert hàng loạt lỗi): bản cũ nối chuỗi lặp
    # quadratic (~13 s ở 2.88 MB). Gộp ra 1 trang, đủ body, đúng thứ tự,
    # độ dài = tổng body + separator (không mất/nhân ký tự).
    n = 60_000
    raw = "".join(f"--- trang 1 ---\nx{i}\n" for i in range(n))
    pages = ck._text_pages(raw)
    assert len(pages) == 1 and pages[0][0] == 1
    text = pages[0][1]
    assert re.findall(r"x\d+", text) == [f"x{i}" for i in range(n)]
    assert len(text) == sum(len(f"\nx{i}\n") for i in range(n)) + 2 * (n - 1)


# --- mã máy lọc theo FILE (manual thật chỉ in mã ở bìa/trang 1) --------------
def test_machine_code_only_on_first_page_found(tmp_path, egress):
    d = tmp_path / "f"
    d.mkdir()
    (d / "manual_MAU.md").write_text(
        "MẪU\n--- trang 1 ---\nSổ tay máy co màng SS-EQ-03 (MẪU).\n"
        "--- trang 2 ---\nNhiệt độ buồng co đặt 160 đến 180 độ C.\n",
        encoding="utf-8")
    (d / "may-dan-nhan-ss-eq-05_MAU.md").write_text(  # mã chỉ ở TÊN file
        "MẪU\nCon lăn ép nhãn vệ sinh mỗi 7 ngày.\n", encoding="utf-8")
    idx = ck.build_index(d)
    for q in ("Nhiệt độ buồng co máy SS-EQ-03 đặt bao nhiêu?",
              "Nhiệt độ buồng co đặt bao nhiêu?"):
        r = ck.ask(q, index=idx)
        assert r["sources"][0] == {"file": "manual_MAU.md", "page": 2}, q
        assert "160" in r["answer"]
    r = ck.ask("Con lăn ép nhãn máy SS-EQ-05 vệ sinh mấy ngày?", index=idx)
    assert r["sources"][0] == {"file": "may-dan-nhan-ss-eq-05_MAU.md", "page": 1}
    # mã không có ở file nào → NO_DATA dù nội dung trùng
    assert _is_no_data(ck.ask("Nhiệt độ buồng co máy SS-EQ-04 đặt bao nhiêu?",
                              index=idx))
    # mã của file KHÁC → không lấy trang file này
    assert _is_no_data(ck.ask("Nhiệt độ buồng co máy SS-EQ-05 đặt bao nhiêu?",
                              index=idx))
    assert egress == []


class _CountFindall:
    """Bọc EQ_RE đếm số lần findall (thay assert wall-clock — gotcha)."""

    def __init__(self, rx):
        self.rx, self.n = rx, 0

    def findall(self, s):
        self.n += 1
        return self.rx.findall(s)

    def __getattr__(self, name):
        return getattr(self.rx, name)


def test_machine_code_question_no_per_chunk_page_rescan(tmp_path, monkeypatch):
    # A04 DoS: bản cũ findall cả TRANG cho MỖI chunk → O(chunks × page_len)
    # (trang đơn 1.4 MB ~187 s/câu). Mã từng trang tính 1 lần lúc index.
    d = tmp_path / "big"
    d.mkdir()
    body = "".join(f"Đoạn {i} MẪU vận hành máy co màng kiểm tra băng tải.\n\n"
                   for i in range(20000))
    (d / "to_MAU.md").write_text("Máy co màng SS-EQ-03 MẪU\n\n" + body,
                                 encoding="utf-8")
    assert (d / "to_MAU.md").stat().st_size >= 1_000_000
    idx = ck.build_index(d)
    assert len(idx["page_terms"]) == 1 and len(idx["chunks"]) > 1000
    rx = _CountFindall(ck.EQ_RE)
    monkeypatch.setattr(ck, "EQ_RE", rx)
    r = ck.ask("Kiểm tra băng tải máy co màng SS-EQ-03?", index=idx)
    assert r["sources"][0] == {"file": "to_MAU.md", "page": 1}
    assert rx.n == 1  # chỉ quét câu hỏi, không quét lại trang
    assert _is_no_data(ck.ask("Kiểm tra băng tải máy SS-EQ-04?", index=idx))
    assert rx.n == 2


# --- PDF scan: OCR ảnh nhúng (pypdf import lười trong _pdf_pages) ------------
class _Page:
    def __init__(self, images=None, boom=False):
        self._images, self._boom = images or [], boom

    @property
    def images(self):
        if self._boom:
            raise ValueError("XObject ảnh hỏng MAU")
        return self._images


def _fake_reader(monkeypatch, page):
    import pypdf
    monkeypatch.setattr(pypdf, "PdfReader",
                        lambda path: SimpleNamespace(pages=[page]))


@pytest.fixture
def scan_dir(tmp_path):
    d = tmp_path / "scan"
    d.mkdir()
    (d / "scan.pdf").write_bytes(make_pdf_pages([None]))  # trang không text
    return d


def test_pdf_scan_ocr_indexed(scan_dir, monkeypatch, egress, fake_ocr):
    _fake_reader(monkeypatch, _Page([SimpleNamespace(data=b"MAU-img")]))
    idx = ck.build_index(scan_dir)
    s = idx["stats"]
    assert (s["indexed"], s["cho_ocr"], s["ocr_missing"]) == (1, 0, False)
    assert fake_ocr == [len(b"MAU-img")]
    r = ck.ask("Tốc độ máy đóng nắp SS-EQ-09 bao nhiêu nắp mỗi phút?", index=idx)
    assert r["sources"][0] == {"file": "scan.pdf", "page": 1}
    assert egress == []


def test_pdf_scan_ocr_engine_missing(scan_dir, monkeypatch, egress, capsys):
    _fake_reader(monkeypatch, _Page([SimpleNamespace(data=b"MAU-img"),
                                     SimpleNamespace(data=b"MAU-img2")]))
    seen = []
    monkeypatch.setattr(ck, "_ocr_local", lambda b: seen.append(b) or None)
    idx = ck.build_index(scan_dir)
    s = idx["stats"]
    assert (s["indexed"], s["cho_ocr"], s["ocr_missing"]) == (0, 1, True)
    assert len(seen) == 1  # thiếu engine → break, không thử ảnh còn lại
    assert ck.OCR_MISSING_MSG in capsys.readouterr().out
    assert egress == []


def test_pdf_scan_images_access_error_cho_ocr(scan_dir, monkeypatch, egress,
                                               fake_ocr):
    _fake_reader(monkeypatch, _Page(boom=True))
    idx = ck.build_index(scan_dir)  # không raise
    s = idx["stats"]
    assert (s["indexed"], s["cho_ocr"], s["skipped"]) == (0, 1, 0)
    assert fake_ocr == []
    assert egress == []
