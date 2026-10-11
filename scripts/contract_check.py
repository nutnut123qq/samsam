"""PC-A6 (v4.4 W44.4) — kiểm hợp đồng KOC/đại lý có đủ điều khoản bắt buộc.

Luật thuần (KHÔNG LLM, không mạng): mỗi điều khoản = (nhãn, [nhóm]).
Điều khoản "có" khi CÓ 1 đoạn (tách theo dòng trống) mà MỌI nhóm đều trúng.
Nhóm chuỗi regex so trên text đã bỏ dấu + lower (`pipelines.llm_gateway.
_strip_accents`, "đ"→"d"). Bỏ dấu làm trùng chữ: "chưa"/"chữa" → "chua",
"gỡ"/"gò" → "go" — regex đã né (vd chỉ khớp "chua benh"). Hai nhóm KHÔNG
so trên bản bỏ dấu vì va chạm quá nhiều:
  - "cấm" (`_cam`): "cấm"/"cảm"/"cam kết" đều → "cam" ("cảm nhận", "cảm ơn",
    "phản cảm" bị đếm thành CẤM → báo đủ sai). Đoạn CÓ dấu → chỉ khớp
    `cấm|không được` trên text còn dấu (NFC + casefold); đoạn gõ KHÔNG dấu
    (bỏ dấu không đổi gì) → fallback `cam` + loại "cam kết" và các tổ hợp
    "cảm" hay gặp. Đoạn trộn ("Cam" không dấu + "rượu" có dấu) → không
    khớp = báo THIẾU (lệch về phía an toàn, người rà tay).
  - nhãn AI (`_ai`): `\bai\b` trên bản bỏ-dấu-lower ăn đại từ "ai" ("bất kỳ
    ai") → khớp `AI` PHÂN BIỆT hoa thường trên text gốc, hoặc "trí tuệ nhân
    tạo".

Kết quả chỉ là KIỂM TỪ KHÓA — KHÔNG thay rà soát của Pháp chế/luật sư.
KHÔNG in nội dung file (hợp đồng có thể chứa dữ liệu đối tác) — chỉ in id +
nhãn điều khoản.

Chạy: `python scripts/contract_check.py --kind koc|dai_ly --file <.md|.txt>`
Exit 0 đủ; 1 thiếu (in từng id thiếu); 2 usage (file không tồn tại / 0 byte /
chỉ khoảng trắng / đuôi khác .md|.txt / không UTF-8 / > 1MB / kind sai).
"""

import argparse
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipelines.llm_gateway import _strip_accents

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

MAX_BYTES = 1_000_000
EXTS = {".md", ".txt"}
_CAM_VI = re.compile(r"\bcấm\b|không được")
# Văn bản gõ không dấu: "cam" mơ hồ — loại "cam kết" + tổ hợp "cảm" hay gặp.
_CAM_ASCII = re.compile(
    r"(?<!phan )(?<!tinh )(?<!nhay )(?<!truyen )(?<!thien )(?<!ac )"
    r"(?<!kha )(?<!giao )(?<!bieu )\bcam\b"
    r"(?! (?:ket|on|nhan|xuc|thay|giac|tinh|dong|hung|ung|quan|tu|phuc"
    r"|kich|nghi|nhiem)\b)|khong duoc")
_AI_RAW = re.compile(r"\bAI\b")
_AI_ASC = re.compile(r"tri tue nhan tao")


def _cam(p) -> bool:
    """'cấm'/'không được' — p = `_para()`; xem docstring module."""
    if p[1] != p[2]:                       # đoạn có dấu
        return bool(_CAM_VI.search(p[1]))
    return bool(_CAM_ASCII.search(p[2]))


def _ai(p) -> bool:
    """Nhãn AI — 'AI' hoa trên text gốc (không ăn đại từ 'ai')."""
    return bool(_AI_RAW.search(p[0]) or _AI_ASC.search(p[2]))


COMMON = {
    "nhan_quang_cao": ("Gắn nhãn quảng cáo/hợp tác + nhãn nội dung AI",
                       [r"gan nhan|dan nhan", r"quang cao|hop tac",
                        _ai]),
    "go_24h": ("Gỡ/ẩn nội dung trong 24 giờ khi có yêu cầu",
               [r"\bgo\b", r"\b24 ?(?:gio|h)\b", r"yeu cau"]),
    "sku_duoc_phep": ("Chỉ SKU trong phụ lục, đúng maket đóng băng",
                      [r"\bsku\b", r"phu luc", r"maket|dong bang"]),
    "cam_claim_suc_khoe": (("Cấm claim chữa bệnh + câu khuyến cáo "
                           "'không phải là thuốc'"),
                           [r"chua benh|dieu tri|khoi benh", _cam,
                            r"khong phai la thuoc"]),
    "cam_ruou": ("Cấm quảng cáo, khuyến mại rượu (Luật 44/2019 Đ5)",
                 [r"\bruou\b", _cam, r"quang cao|khuyen mai"]),
    "bao_ve_dlcn": ("Bảo vệ dữ liệu cá nhân khách (Luật 91/2025)",
                    [r"du lieu ca nhan",
                     r"khong (?:duoc )?(?:thu thap|su dung|chia se)"]),
    "gia_toi_thieu": ("Giá bán tối thiểu",
                      [r"gia (?:ban )?toi thieu",
                       r"thap hon|duoi muc"]),
    "cham_dut": ("Chấm dứt/đơn phương chấm dứt khi vi phạm",
                 [r"cham dut", r"don phuong", r"vi pham"]),
}
CLAUSES = {
    "koc": {**COMMON,
            "nghia_vu_nguoi_chuyen_tai": (
                ("Nghĩa vụ người chuyển tải quảng cáo (kiểm tài liệu, đã dùng "
                "sản phẩm)"),
                [r"nguoi chuyen tai", r"kiem tra tai lieu",
                 r"da (?:truc tiep )?su dung"])},
    "dai_ly": {**COMMON,
               "cam_shop_trung_ten": (
                   "Cấm mở shop/gian hàng trùng tên, gây nhầm lẫn",
                   [r"trung ten|gay nham lan", r"shop|gian hang", _cam])},
}


def _matcher(g):
    """Nhóm chuỗi → regex trên bản bỏ dấu; nhóm callable giữ nguyên."""
    if callable(g):
        return g
    r = re.compile(g)
    return lambda p: bool(r.search(p[2]))


_COMPILED = {k: {cid: [_matcher(g) for g in groups]
                 for cid, (_, groups) in v.items()}
             for k, v in CLAUSES.items()}
_PARA_RE = re.compile(r"\n[ \t]*\n")


def _para(raw: str) -> tuple[str, str, str]:
    """1 đoạn → (gốc NFC, có dấu casefold, bỏ dấu lower)."""
    raw = unicodedata.normalize("NFC", raw)
    return raw, raw.casefold(), _strip_accents(raw).lower()


def satisfies(kind: str, cid: str, para: str) -> bool:
    """Đoạn `para` (text thô) thỏa đủ nhóm của điều khoản `cid`?"""
    p = _para(para)
    return all(g(p) for g in _COMPILED[kind][cid])


def _paragraphs(text: str) -> list[tuple[str, str, str]]:
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    return [_para(p) for p in _PARA_RE.split(t) if p.strip()]


def missing_clauses(text: str, kind: str) -> list[str]:
    """→ id các điều khoản bắt buộc KHÔNG có đoạn nào thỏa đủ nhóm từ khóa
    (theo thứ tự khai báo). kind sai → KeyError."""
    paras = _paragraphs(text)
    return [cid for cid, groups in _COMPILED[kind].items()
            if not any(all(g(p) for g in groups) for p in paras)]


def _read(path: Path) -> str:
    """Đọc + validate; lỗi → ValueError (usage, exit 2). Không echo nội dung."""
    if path.suffix.lower() not in EXTS:
        raise ValueError("chỉ nhận file .md hoặc .txt")
    if not path.is_file():
        raise ValueError("file không tồn tại")
    size = path.stat().st_size
    if size == 0:
        raise ValueError("file rỗng (0 byte)")
    if size > MAX_BYTES:
        raise ValueError(f"file quá lớn (> {MAX_BYTES} byte)")
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("file không phải UTF-8") from None
    if not text.strip():
        raise ValueError("file chỉ có khoảng trắng")
    return text


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--kind", required=True, choices=sorted(CLAUSES))
    ap.add_argument("--file", required=True, type=Path)
    a = ap.parse_args(argv)
    try:
        text = _read(a.file)
    except (ValueError, OSError) as e:
        msg = str(e) if isinstance(e, ValueError) else type(e).__name__
        print(f"[err] {msg}", file=sys.stderr)
        return 2
    miss = missing_clauses(text, a.kind)
    if miss:
        print(f"[thiếu] {len(miss)} điều khoản bắt buộc ({a.kind}):")
        for cid in miss:
            print(f"  - {cid}: {CLAUSES[a.kind][cid][0]}")
        print("Kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư.")
        return 1
    print(f"[ok] đủ {len(CLAUSES[a.kind])} điều khoản bắt buộc ({a.kind}) "
          "theo kiểm từ khóa — KHÔNG thay rà soát của Pháp chế/luật sư.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
