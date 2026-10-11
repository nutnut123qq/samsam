"""v4.4 W44.4 — scripts/contract_check.py (PC-A6): hợp đồng KOC/đại lý có
đủ điều khoản bắt buộc (luật thuần, không LLM, không echo nội dung file)."""

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import contract_check as cc
import dpia_draft

TEMPLATES = {
    "koc": ROOT / "docs" / "legal" / "mau-hop-dong-koc-NHAP.md",
    "dai_ly": ROOT / "docs" / "legal" / "mau-hop-dong-dai-ly-NHAP.md",
}
CASES = [(k, cid) for k in cc.CLAUSES for cid in cc.CLAUSES[k]]


def _text(kind):
    # read_text chuẩn hóa CRLF (checkout core.autocrlf=true).
    return TEMPLATES[kind].read_text(encoding="utf-8")


def _drop_clause(text, kind, cid):
    """Bỏ MỌI đoạn (tách dòng trống) thỏa điều khoản `cid`."""
    paras = re.split(r"\n[ \t]*\n", text)
    keep = [p for p in paras if not cc.satisfies(kind, cid, p)]
    assert len(keep) == len(paras) - 1, "mỗi điều khoản đúng 1 đoạn"
    return "\n\n".join(keep)


def test_clause_sets():
    common = {"nhan_quang_cao", "go_24h", "sku_duoc_phep",
              "cam_claim_suc_khoe", "cam_ruou", "bao_ve_dlcn",
              "gia_toi_thieu", "cham_dut"}
    assert set(cc.CLAUSES["koc"]) == common | {"nghia_vu_nguoi_chuyen_tai"}
    assert set(cc.CLAUSES["dai_ly"]) == common | {"cam_shop_trung_ten"}


@pytest.mark.parametrize("kind", sorted(TEMPLATES))
def test_templates_complete(kind, capsys):
    assert cc.missing_clauses(_text(kind), kind) == []
    assert cc.main(["--kind", kind, "--file", str(TEMPLATES[kind])]) == 0
    assert "KHÔNG thay rà soát" in capsys.readouterr().out


@pytest.mark.parametrize("kind,cid", CASES,
                         ids=[f"{k}-{c}" for k, c in CASES])
def test_each_clause_removed_is_reported(kind, cid, tmp_path, capsys):
    text = _drop_clause(_text(kind), kind, cid)
    assert cc.missing_clauses(text, kind) == [cid]
    p = tmp_path / "hd.md"
    p.write_bytes(text.encode("utf-8"))
    assert cc.main(["--kind", kind, "--file", str(p)]) == 1
    out = capsys.readouterr().out
    missing_lines = [ln for ln in out.splitlines() if ln.startswith("  - ")]
    assert missing_lines == [f"  - {cid}: {cc.CLAUSES[kind][cid][0]}"]


def test_negative_keyword_alone_or_split():
    assert "cam_ruou" in cc.missing_clauses("Phụ lục: Rượu sâm 500ml",
                                            "koc")
    split = ("Bên B không được làm điều sau.\n\n"
             "Quảng cáo, khuyến mại sản phẩm rượu.")
    assert "cam_ruou" in cc.missing_clauses(split, "koc")
    joined = split.replace("\n\n", " ")
    assert "cam_ruou" not in cc.missing_clauses(joined, "koc")
    # "cam kết" không phải "cấm"; "chưa" không phải "chữa".
    assert "cam_ruou" in cc.missing_clauses(
        "Bên B cam kết quảng cáo rượu đúng luật.", "koc")
    assert "cam_claim_suc_khoe" in cc.missing_clauses(
        "Bên B không được nói điều chưa kiểm chứng; câu khuyến cáo: "
        "không phải là thuốc.", "koc")


# "cảm" (cảm nhận/cảm ơn/phản cảm) bỏ dấu cũng → "cam": KHÔNG được đếm là
# "cấm" — điều khoản CHO PHÉP mà báo đủ là lỗi nặng nhất của tool này.
_CAM_FP = [
    ("koc", "cam_ruou",
     "KOC được quảng cáo rượu sâm và chia sẻ cảm nhận về sản phẩm."),
    ("koc", "cam_ruou",
     "KOC chia sẻ cảm nhận thật về rượu sâm trong bài quảng cáo."),
    ("koc", "cam_ruou", "Được quảng cáo rượu sâm, cảm ơn Bên B."),
    ("koc", "cam_ruou", "Quảng cáo rượu sâm, tránh hình ảnh phản cảm."),
    ("koc", "cam_claim_suc_khoe",
     ("KOC được nói sâm chữa bệnh, điều trị ung thư. Cảm ơn. Lưu ý: "
      "không phải là thuốc.")),
    ("koc", "cam_claim_suc_khoe",
     ("KOC đăng cảm nhận: sản phẩm hỗ trợ điều trị; câu khuyến cáo "
      "không phải là thuốc.")),
    ("dai_ly", "cam_shop_trung_ten",
     "Đại lý được mở gian hàng trùng tên, cảm ơn."),
    # Văn bản gõ KHÔNG dấu: fallback "cam" vẫn loại các tổ hợp "cảm".
    ("koc", "cam_ruou",
     "KOC duoc quang cao ruou sam va chia se cam nhan ve san pham."),
    ("koc", "cam_ruou", "Quang cao ruou sam, tranh noi dung phan cam."),
    ("dai_ly", "cam_shop_trung_ten",
     "Dai ly duoc mo gian hang trung ten, cam on."),
]


@pytest.mark.parametrize("kind,cid,text", _CAM_FP,
                         ids=[f"{i}-{c}" for i, (_, c, _t) in
                              enumerate(_CAM_FP)])
def test_cam_not_confused_with_cam_accentless(kind, cid, text):
    assert cid in cc.missing_clauses(text, kind)


@pytest.mark.parametrize("kind,cid,text", [
    ("koc", "cam_ruou", "Cấm quảng cáo rượu sâm."),
    ("koc", "cam_ruou", "Bên B không được quảng cáo rượu sâm."),
    ("koc", "cam_ruou", "Cam quang cao ruou sam."),
    ("koc", "cam_ruou", "Ben B khong duoc quang cao ruou sam."),
    ("koc", "cam_claim_suc_khoe",
     "Cấm nói chữa bệnh; khuyến cáo: không phải là thuốc."),
    ("dai_ly", "cam_shop_trung_ten", "Cấm mở gian hàng trùng tên."),
    ("dai_ly", "cam_shop_trung_ten", "Cam mo gian hang trung ten."),
], ids=["vi-cam", "vi-khong-duoc", "ascii-cam", "ascii-khong-duoc",
        "claim-vi", "shop-vi", "shop-ascii"])
def test_cam_positive_forms(kind, cid, text):
    assert cid not in cc.missing_clauses(text, kind)


def test_ai_label_not_pronoun_ai():
    # Đại từ "ai" (bất kỳ ai) KHÔNG phải nhãn AI.
    assert "nhan_quang_cao" in cc.missing_clauses(
        "Gắn nhãn hợp tác cho bất kỳ ai.", "koc")
    assert "nhan_quang_cao" in cc.missing_clauses(
        "Gắn nhãn quảng cáo, ai đăng thì người đó chịu.", "koc")
    assert "nhan_quang_cao" not in cc.missing_clauses(
        "Gắn nhãn quảng cáo; nội dung có dùng AI gắn nhãn AI.", "koc")
    assert "nhan_quang_cao" not in cc.missing_clauses(
        "Gắn nhãn quảng cáo; nội dung dùng trí tuệ nhân tạo phải ghi rõ.",
        "koc")


def test_unaccented_variant_still_matches():
    t = cc._strip_accents(_text("dai_ly"))
    assert cc.missing_clauses(t, "dai_ly") == []
    assert cc.missing_clauses(t.upper(), "dai_ly") == []


def test_crlf_paragraphs():
    t = _text("koc").replace("\n", "\r\n")
    assert cc.missing_clauses(t, "koc") == []


@pytest.fixture
def usage_files(tmp_path):
    f = {}
    f["missing"] = tmp_path / "khong-co.md"
    f["empty"] = tmp_path / "rong.md"
    f["empty"].write_bytes(b"")
    f["blank"] = tmp_path / "trang.txt"
    f["blank"].write_bytes(b" \n\t\n")
    f["ext"] = tmp_path / "hd.docx"
    f["ext"].write_bytes(b"abc")
    f["latin1"] = tmp_path / "l1.txt"
    f["latin1"].write_bytes("Điều".encode("utf-16"))
    f["big"] = tmp_path / "lon.md"
    f["big"].write_bytes(b"a" * (cc.MAX_BYTES + 1))
    return f


@pytest.mark.parametrize("key", ["missing", "empty", "blank", "ext",
                                 "latin1", "big"])
def test_usage_exit2(usage_files, key, capsys):
    assert cc.main(["--kind", "koc", "--file", str(usage_files[key])]) == 2
    assert "[err]" in capsys.readouterr().err


def test_bad_kind_exit2(tmp_path):
    with pytest.raises(SystemExit) as e:
        cc.main(["--kind", "ncc", "--file", str(TEMPLATES["koc"])])
    assert e.value.code == 2


def test_no_echo_of_file_content(tmp_path, capsys):
    secret = "DOI_TAC_BI_MAT_0123"
    p = tmp_path / "hd.txt"
    p.write_bytes(f"{secret}\n\nĐiều 1. Không có gì.\n".encode())
    assert cc.main(["--kind", "dai_ly", "--file", str(p)]) == 1
    c = capsys.readouterr()
    assert secret not in c.out and secret not in c.err


def test_contract_check_not_egress():
    assert "scripts/contract_check.py" not in dpia_draft.egress_modules(ROOT)
