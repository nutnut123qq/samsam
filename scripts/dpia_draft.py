"""PC-A5 (v4.4 W44.2–W44.3) — sinh DPIA/TIA NHÁP từ bản đồ luồng dữ liệu.

Nguồn: `data/data_flow_map.json` (rà từ code thật). Ra:
`docs/legal/DPIA-nhap.md` + `docs/legal/TIA-nhap.md` — TẤT ĐỊNH (ngày lấy
`version` của map, không timestamp chạy; chạy 2 lần byte y hệt). Template +
luật cố định, KHÔNG gọi LLM/mạng. Mọi output là BẢN NHÁP chờ Chuyên viên
Pháp chế ký, luật sư rà — agent không kết luận tuân thủ.

Căn cứ (research_legal.md): Luật BVDLCN 91/2025/QH15 + NĐ 356/2025 (hiệu
lực 01/01/2026, NĐ 356 thay NĐ 13/2023). Khung mục dựng theo cấu trúc hồ sơ
đánh giá tác động của NĐ 13/2023 Điều 24 (xử lý) / Điều 25 (chuyển ra nước
ngoài); nguyên văn + mẫu biểu NĐ 356/2025 CHƯA mở nguồn → ghi "CẦN LUẬT SƯ
XÁC NHẬN" tại chỗ.

Hàm dùng chung (test drift-guard import):
  - `load_map(path)` — validate map; lỗi → ValueError nêu id + field.
  - `egress_modules(root)` — quét `ast` MỌI `*.py` dưới root (bỏ tests,
    .venv, venv, __pycache__, .git), cả import LƯỜI trong hàm. Module tính
    là "gửi dữ liệu ra ngoài" khi import gốc ∈ NET_ROOTS, hoặc dotted
    `urllib.request` / `http.client` (kể cả `from urllib import request`),
    hoặc dùng gateway `pipelines.llm_gateway` — FAIL-CLOSED: import cả
    module (`import pipelines.llm_gateway [as g]`, `from pipelines import
    llm_gateway`, tương đối `from . import llm_gateway`) hoặc import BẤT KỲ
    tên nào ngoài allowlist helper thuần `GATEWAY_SAFE` (chat, embed,
    _client, _call, `*`... đều tính) — kể cả tương đối `from .llm_gateway
    import X` (bảo thủ: mọi module tên cuối `llm_gateway`).
    KHÔNG tính: `urllib.parse` (chỉ ghép URL), `socket` (job_runs chỉ dùng
    gethostname — socket thô cần rà tay nếu có). Giới hạn: import động
    (`importlib`/`__import__`), `import pipelines` rồi truy cập thuộc tính
    `pipelines.llm_gateway`, và gọi gián tiếp qua module trung gian
    (vd kb_internal → embed_store.embed_all) KHÔNG bắt — map vẫn phải khai
    báo module trung gian đó bằng tay.

Chạy: `python scripts/dpia_draft.py [--map PATH] [--out-dir DIR] [--check]`.
Exit 0 ok; 1 `--check` lệch/thiếu file; 2 map hỏng (không ghi file nào).
"""

import argparse
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_MAP = ROOT / "data" / "data_flow_map.json"
DEFAULT_OUT = ROOT / "docs" / "legal"
DPIA_NAME = "DPIA-nhap.md"
TIA_NAME = "TIA-nhap.md"
SKIP_DIRS = {"tests", ".venv", "venv", "__pycache__", ".git", ".claude"}
NET_ROOTS = {"openai", "httpx", "requests", "smtplib", "aiohttp", "urllib3",
             "ftplib"}
NET_DOTTED = ("urllib.request", "http.client")
GATEWAY = "pipelines.llm_gateway"
# Tên import từ gateway KHÔNG gửi gì ra ngoài (helper thuần / exception /
# hằng / đọc config local). Tên khác → tính egress (fail-closed).
GATEWAY_SAFE = {"_strip_accents", "is_health_question", "GatewayError",
                "GatewayBlocked", "WARN_RATIO", "_config"}
CLASSES = {"do": ("Đỏ", "cao"), "vang": ("Vàng", "trung bình"),
           "xanh": ("Xanh", "thấp")}
STR_FIELDS = ("name", "data", "subjects", "purpose", "storage", "retention",
              "recipients", "legal_basis")
LIST_FIELDS = ("safeguards", "gaps")
_ID_RE = re.compile(r"DF-\d{2,3}")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
LAWYER = "CẦN LUẬT SƯ XÁC NHẬN"


class MapError(ValueError):
    """Map hỏng → exit 2 (subclass ValueError)."""


# ------------------------------------------------------------------ load_map
def load_map(path=DEFAULT_MAP, root: Path = ROOT) -> dict:
    """Đọc + validate bản đồ luồng. Lỗi → ValueError '<id>.<field>: ...'."""
    try:
        m = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise MapError(f"map không đọc được: {type(e).__name__}") from None
    if not isinstance(m, dict):
        raise MapError("map phải là object JSON")
    v = m.get("version")
    if not isinstance(v, str) or not _DATE_RE.fullmatch(v):
        raise MapError("version: cần ngày YYYY-MM-DD")
    flows = m.get("flows")
    if not isinstance(flows, list) or not flows:
        raise MapError("flows rỗng hoặc không phải list")
    seen = set()
    for i, f in enumerate(flows):
        if not isinstance(f, dict):
            raise MapError(f"flows[{i}]: phải là object")
        fid = f.get("id")
        if not isinstance(fid, str) or not _ID_RE.fullmatch(fid):
            raise MapError(f"flows[{i}].id: cần dạng DF-xx, nhận {fid!r}")
        if fid in seen:
            raise MapError(f"{fid}.id: trùng")
        seen.add(fid)
        for k in STR_FIELDS:
            if not isinstance(f.get(k), str) or not f[k].strip():
                raise MapError(f"{fid}.{k}: thiếu hoặc rỗng")
        for k in LIST_FIELDS:
            val = f.get(k)
            if not isinstance(val, list) or not all(
                    isinstance(x, str) and x.strip() for x in val):
                raise MapError(f"{fid}.{k}: phải là list chuỗi")
        if f.get("class") not in CLASSES:
            raise MapError(f"{fid}.class: phải thuộc {sorted(CLASSES)}")
        if not isinstance(f.get("cross_border"), bool):
            raise MapError(f"{fid}.cross_border: phải là bool")
        mods = f.get("modules")
        if not isinstance(mods, list) or not mods:
            raise MapError(f"{fid}.modules: rỗng")
        for mod in mods:
            if (not isinstance(mod, str) or "\\" in mod or mod.startswith("/")
                    or ".." in mod.split("/") or ":" in mod):
                raise MapError(f"{fid}.modules: đường dẫn posix tương đối "
                                 f"không hợp lệ {mod!r}")
            if not (root / mod).is_file():
                raise MapError(f"{fid}.modules: không tồn tại {mod}")
    return m


# ------------------------------------------------------------ egress_modules
def _is_egress(tree: ast.AST) -> bool:
    gw_pkg, gw_leaf = GATEWAY.rsplit(".", 1)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if (a.name.split(".")[0] in NET_ROOTS
                        or any(a.name == d or a.name.startswith(d + ".")
                               for d in NET_DOTTED)
                        or a.name == GATEWAY
                        or a.name.startswith(GATEWAY + ".")):
                    return True
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            names = {a.name for a in node.names}
            if node.level:           # tương đối: bảo thủ theo tên cuối
                if gw_leaf in names or (
                        mod.split(".")[-1] == gw_leaf
                        and names - GATEWAY_SAFE):
                    return True
                continue
            if mod.split(".")[0] in NET_ROOTS or any(
                    mod == d or mod.startswith(d + ".") for d in NET_DOTTED):
                return True
            if any(f"{mod}.{n}" in NET_DOTTED for n in names):
                return True          # from urllib import request
            if mod == gw_pkg and gw_leaf in names:
                return True          # from pipelines import llm_gateway
            if mod == GATEWAY and names - GATEWAY_SAFE:
                return True
    return False


def egress_modules(root: Path = ROOT) -> set[str]:
    """→ tập đường dẫn posix tương đối các module gửi dữ liệu ra ngoài."""
    root = Path(root)
    out = set()
    for p in root.rglob("*.py"):
        rel = p.relative_to(root)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        tree = ast.parse(p.read_bytes().decode("utf-8"), filename=str(rel))
        if _is_egress(tree):
            out.add(rel.as_posix())
    return out


# ------------------------------------------------------------------ render
def _cell(s) -> str:
    if isinstance(s, list):
        s = "; ".join(s) if s else "(không)"
    return str(s).replace("|", "\\|").replace("\n", " ")


def _draft_banner(who: str, version: str) -> list[str]:
    return [
        (f"> **BẢN NHÁP — chưa có giá trị pháp lý; chờ {who} — agent không "
        "kết luận tuân thủ.**"),
        (f"> Sinh tự động bởi `python scripts/dpia_draft.py` từ "
        f"`data/data_flow_map.json` (bản đồ rà từ code ngày {version}). "
        "KHÔNG sửa tay — sửa map rồi chạy lại (`--check` bắt lệch)."),
    ]


def _sign_block() -> list[str]:
    return [
        "| Vai trò | Họ tên | Chữ ký | Ngày ký |",
        "|---|---|---|---|",
        ("| Chuyên viên Pháp chế | {{ho_ten_phap_che}} | {{chu_ky_phap_che}} "
        "| {{ngay_ky_phap_che}} |"),
        ("| Luật sư rà soát | {{ho_ten_luat_su}} | {{chu_ky_luat_su}} "
        "| {{ngay_ky_luat_su}} |"),
        "| Tổng giám đốc | {{ho_ten_tgd}} | {{chu_ky_tgd}} | {{ngay_ky_tgd}} |",
    ]


def render_dpia(m: dict) -> str:
    v = m["version"]
    flows = m["flows"]
    L = ["# DPIA — Đánh giá tác động xử lý dữ liệu cá nhân (NHÁP)", ""]
    L += _draft_banner("Chuyên viên Pháp chế ký, luật sư rà", v)
    L += [
        ("> Căn cứ: Luật BVDLCN 91/2025/QH15 + NĐ 356/2025 (hiệu lực "
        "01/01/2026, NĐ 356/2025 thay NĐ 13/2023). Khung mục dựng theo cấu "
        "trúc hồ sơ đánh giá tác động xử lý của NĐ 13/2023 Điều 24 — mẫu "
        f"biểu chính thức theo NĐ 356/2025: {LAWYER}."),
        "",
        "## 1. Bên kiểm soát / bên xử lý dữ liệu",
        "",
        "- Tên doanh nghiệp: {{ten_cong_ty}}",
        "- Mã số doanh nghiệp: {{ma_so_doanh_nghiep}}",
        "- Người phụ trách bảo vệ dữ liệu cá nhân: {{nguoi_phu_trach_dlcn}}",
        "- Liên hệ đầu mối: {{lien_he_dau_moi}}",
        ("- Bên xử lý / bên nhận: theo dòng \"Bên nhận\" của từng hoạt động ở "
        "mục 2."),
        "",
        "## 2. Mô tả từng hoạt động xử lý",
        "",
        "Phân lớp dữ liệu (plan_data_platform §2):",
        "",
    ]
    for k, (label, _) in CLASSES.items():
        L.append(f"- **{label}** (`{k}`): {_cell(m.get('classes', {}).get(k, ''))}")
    L.append("")
    for f in flows:
        label = CLASSES[f["class"]][0]
        L += [
            f"### {f['id']} — {_cell(f['name'])}",
            "",
            "| Mục | Nội dung |",
            "|---|---|",
            f"| Mã luồng | {f['id']} |",
            f"| Module (code) | {_cell(['`' + x + '`' for x in f['modules']])} |",
            f"| Mục đích | {_cell(f['purpose'])} |",
            f"| Dữ liệu | {_cell(f['data'])} |",
            f"| Lớp | {label} |",
            f"| Chủ thể | {_cell(f['subjects'])} |",
            f"| Nơi lưu | {_cell(f['storage'])} |",
            f"| Thời hạn lưu | {_cell(f['retention'])} |",
            f"| Bên nhận | {_cell(f['recipients'])} |",
            f"| Chuyển ra nước ngoài | {'CÓ — xem TIA' if f['cross_border'] else 'Không'} |",
            f"| Biện pháp bảo vệ (có trong code) | {_cell(f['safeguards'])} |",
            f"| Căn cứ xử lý | {_cell(f['legal_basis'])} |",
            f"| GAP | {_cell(f['gaps'])} |",
            "",
        ]
    L += [
        "## 3. Đánh giá rủi ro",
        "",
        ("Mức đề xuất, Pháp chế chốt. Quy tắc cố định: lớp Đỏ → cao, Vàng → "
        "trung bình, Xanh → thấp; luồng chuyển ra nước ngoài đánh giá thêm "
        "ở TIA."),
        "",
        "| Mã | Hoạt động | Lớp | Mức rủi ro đề xuất | Ra nước ngoài | Số GAP |",
        "|---|---|---|---|---|---|",
    ]
    for f in flows:
        label, risk = CLASSES[f["class"]]
        L.append(f"| {f['id']} | {_cell(f['name'])} | {label} | {risk} | "
                 f"{'có' if f['cross_border'] else 'không'} | "
                 f"{len(f['gaps'])} |")
    L += ["", "## 4. Tổng hợp GAP", ""]
    any_gap = False
    for f in flows:
        for g in f["gaps"]:
            L.append(f"- [{f['id']}] {_cell(g)}")
            any_gap = True
    if not any_gap:
        L.append("- (map không ghi GAP nào — Pháp chế rà lại)")
    L += [
        "",
        "## 5. Câu hỏi cho luật sư",
        "",
        ("1. NĐ 356/2025 thay NĐ 13/2023: mẫu hồ sơ đánh giá tác động xử lý "
        f"và thời hạn nộp — {LAWYER}."),
        ("2. Ân hạn 5 năm cho doanh nghiệp nhỏ (nghĩa vụ DPIA, nhân sự bảo vệ "
        "dữ liệu) có còn áp dụng khi chatbot nhận tin nhắn có yếu tố sức "
        f"khỏe (dữ liệu nhạy cảm) hay không — {LAWYER}."),
        ("3. Mốc 72 giờ báo cáo sự cố dữ liệu: căn cứ chưa xác minh nguyên "
        f"văn — {LAWYER}."),
        ("4. Zalo/VNG (kênh OA) là bên xử lý dữ liệu (cần hợp đồng xử lý) hay "
        f"bên nhận độc lập — {LAWYER}."),
        ("5. `user_hash` (sha256 không muối của user_id) là dữ liệu bút danh — "
        f"vẫn là dữ liệu cá nhân, biện pháp đủ chưa — {LAWYER}."),
        "",
        "## 6. Ký duyệt",
        "",
        "Chưa ai ký — ô để trống chờ người thật.",
        "",
    ]
    L += _sign_block()
    return "\n".join(L) + "\n"


def render_tia(m: dict) -> str:
    v = m["version"]
    cross = [f for f in m["flows"] if f["cross_border"]]
    local = [f for f in m["flows"] if not f["cross_border"]]
    L = [("# TIA — Đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài "
         "(NHÁP)"), ""]
    L += _draft_banner("Chuyên viên Pháp chế ký, luật sư rà", v)
    L += [
        ("> Căn cứ: Luật BVDLCN 91/2025/QH15 (chuyển dữ liệu xuyên biên giới "
        "phải có hồ sơ đánh giá tác động) + NĐ 356/2025; khung mục theo cấu "
        f"trúc NĐ 13/2023 Điều 25 — {LAWYER}."),
        "",
        "## 1. Bên chuyển dữ liệu",
        "",
        "- Tên doanh nghiệp: {{ten_cong_ty}}",
        "- Người phụ trách bảo vệ dữ liệu cá nhân: {{nguoi_phu_trach_dlcn}}",
        "",
        "## 2. Đánh giá từng luồng chuyển ra nước ngoài",
        "",
    ]
    if not cross:
        L += ["(map không có luồng chuyển ra nước ngoài)", ""]
    for f in cross:
        label = CLASSES[f["class"]][0]
        L += [
            f"### {f['id']} — {_cell(f['name'])}",
            "",
            "| Mục | Nội dung |",
            "|---|---|",
            f"| Bên nhận / nước | {_cell(f['recipients'])} |",
            f"| Dữ liệu gửi đi (sau biện pháp) | {_cell(f['data'])} |",
            f"| Lớp | {label} |",
            f"| Mục đích | {_cell(f['purpose'])} |",
            f"| Biện pháp kỹ thuật | {_cell(f['safeguards'])} |",
            f"| Thời hạn lưu (theo map) | {_cell(f['retention'])} |",
            f"| Rủi ro tồn dư | {_cell(f['gaps'])} |",
            f"| Căn cứ | {_cell(f['legal_basis'])} — Luật 91/2025: {LAWYER} |",
            "",
        ]
    L += [
        "## 3. Luồng không thuộc TIA",
        "",
        "Không thuộc TIA (không chuyển ra nước ngoài theo code hiện tại): "
        + (", ".join(f["id"] for f in local) or "(không có)") + ".",
        "",
        "## 4. Ký duyệt",
        "",
        "Chưa ai ký — ô để trống chờ người thật.",
        "",
    ]
    L += _sign_block()
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", default=str(DEFAULT_MAP))
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT))
    ap.add_argument("--check", action="store_true",
                    help="không ghi; so nội dung sinh với file trên đĩa")
    a = ap.parse_args(argv)
    try:
        m = load_map(a.map)
    except ValueError as e:
        print(f"[err] {e}", file=sys.stderr)
        return 2
    out = Path(a.out_dir)
    docs = {DPIA_NAME: render_dpia(m), TIA_NAME: render_tia(m)}
    if a.check:
        # core.autocrlf=true (máy Windows) checkout file thành CRLF — so sau
        # khi chuẩn hóa xuống dòng, không coi đó là lệch nội dung.
        stale = [n for n, txt in docs.items()
                 if not (out / n).is_file()
                 or (out / n).read_bytes().replace(b"\r\n", b"\n")
                 != txt.encode("utf-8")]
        if stale:
            print(f"[lệch] {', '.join(stale)} không khớp map — chạy lại "
                  "dpia_draft", file=sys.stderr)
            return 1
        print(f"[ok] {', '.join(docs)} khớp map {m['version']}")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for n, txt in docs.items():
        (out / n).write_bytes(txt.encode("utf-8"))   # bytes: giữ \n
    print(f"[ok] ghi {', '.join(docs)} ({len(m['flows'])} luồng, "
          f"{sum(f['cross_border'] for f in m['flows'])} ra nước ngoài)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
