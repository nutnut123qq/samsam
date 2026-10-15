"""v12.2 PC-HR — Nhân sự (PL01 HĐ hợp tác TEDO–Sâm Sâm, phòng "Pháp chế –
nhân sự": mô tả công việc, sàng lọc hồ sơ, chấm công). Khối `legal_hr`,
người duyệt Chuyên viên pháp chế. Tất định Python, KHÔNG LLM, KHÔNG mạng.

Ranh giới: agent CHỈ ĐỀ XUẤT → hàng duyệt chung (`pipelines.director.submit`,
loại `hr_jd` / `hr_screening` / `hr_attendance`, risk medium — không
auto_policy). KHÔNG đăng tuyển, KHÔNG liên hệ/loại ứng viên, KHÔNG tính lương,
KHÔNG đề xuất kỷ luật. Không có bảng riêng: ghi DUY NHẤT qua `enqueue_item`
(kèm dòng `agent_action_log`).

1) `--jd <vi_tri>` — nháp mô tả công việc từ `data/hr/jd_templates.json`
   (BẢN DEV SOẠN). Payload qua guardrail TRƯỚC khi đẩy (vi phạm → exit 1,
   không đẩy).

2) `--screen --jd <vi_tri> [--dir D]` — xếp hạng hồ sơ .txt/.md trong thư mục
   (mặc định env `HR_INBOX_DIR`; thư mục NẰM TRONG repo → từ chối, exit 2:
   CV có PII, repo public). Không đệ quy, bỏ symlink, ≤500 file, ≤1MB/file.
   - Mã ứng viên = 12 ký tự đầu sha256 NỘI DUNG file (trùng nội dung = 1 hồ
     sơ). KHÔNG lưu tên/SĐT/email/tên file vào hàng duyệt; bảng mã ↔ tên file
     chỉ in ra console người chạy, tên file qua `_mask_pii`.
   - Chấm TẤT ĐỊNH: tiêu chí `bat_buoc`/`uu_tien` của JD, từ khóa so khớp
     không dấu, theo từ trọn vẹn. Xếp (số bắt buộc đạt ↓, điểm ưu tiên ↓,
     mã). KHÔNG tự loại ai: mọi hồ sơ đều có trong danh sách + lý do; file
     không đọc được (rỗng/không UTF-8/quá lớn) đứng cuối "cần người đọc tay".
   - Cấu hình chứa tiêu chí phân biệt đối xử (giới tính, tuổi, hôn nhân, tôn
     giáo, dân tộc, quê quán, mang thai, ngoại hình) → từ chối (exit 1).

3) `--attendance <csv|xlsx> --month YYYY-MM` — cột `ma_nv,ngay,gio_vao,gio_ra`.
   Kiểm TOÀN file trước (lỗi → exit 1, không connect, không ghi gì): header
   đúng 4 cột, mã NV `^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$` và không giống
   SĐT/email (không tên), ngày thuộc tháng và không ở tương lai, giờ HH:MM
   (HH:MM:SS của xlsx nhận), giờ ra > giờ vào, ít nhất 1 trong 2 giờ, không
   trùng (mã NV, ngày). Luật ca `data/hr/attendance_rules.json` (GIẢ ĐỊNH,
   `pipelines.period.parse_shift`) → theo mã NV: ngày công (đủ vào+ra), đi
   trễ / về sớm (lần + phút, ngoài du di, chỉ ngày làm), thiếu chấm (1 giờ),
   vắng không chấm (ngày làm KHÔNG có dòng, tính tới hôm qua nếu kỳ chưa
   đóng), chấm ngoài lịch. NV không có dòng nào trong file thì agent không
   biết (không có danh sách NV) — ghi chú trong payload.

`--dry-run`: in payload, không connect DB.

Chạy:
  python -m agents.pc_hr --jd <vi_tri> [--dry-run]
  python -m agents.pc_hr --screen --jd <vi_tri> [--dir D] [--dry-run]
  python -m agents.pc_hr --attendance F --month YYYY-MM [--dry-run]
Exit: 0 ok / đã có mục chờ · 1 file/cấu hình/guardrail lỗi · 2 tham số sai /
DB down.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

from agents.fp_pnl import parse_month
from ingest.lead_store import connect
from ingest.market_csv import MAX_PRINT_ERRS, _clean, _TableError
from ingest.settlement_csv import _to_date, map_header, read_table
from pipelines import director
from pipelines.guardrail import check as guardrail_check
from pipelines.period import parse_shift, vn_date
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
JD_FILE = ROOT / "data" / "hr" / "jd_templates.json"
RULES_FILE = ROOT / "data" / "hr" / "attendance_rules.json"
BLOCK = "legal_hr"
CREATED_BY = "agent:pc_hr"
CV_SUFFIXES = (".txt", ".md")
MAX_CV_FILES = 500
MAX_CV_BYTES = 1024 * 1024
ATT_FIELDS = ("ma_nv", "ngay", "gio_vao", "gio_ra")
MAX_GRACE = 120
_KEY_RE = re.compile(r"[a-z][a-z0-9_]{1,39}")
_MA_NV_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,19}")
_TIME_RE = re.compile(r"([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?")
# Tiêu chí phân biệt đối xử (Bộ luật Lao động) — dạng không dấu. Cụm nhiều
# từ / từ hiếm khớp ở bất kỳ đâu trong từ khóa; 'nam'/'nu' chỉ khớp NGUYÊN
# từ khóa ('quảng nam' hợp lệ).
_BIAS_ANY = ("tuoi", "gioi tinh", "nam gioi", "nu gioi", "hon nhan",
             "ket hon", "doc than", "ton giao", "dan toc", "mang thai",
             "que quan", "ngoai hinh", "chieu cao", "can nang")
_BIAS_EXACT = ("nam", "nu")
NOTE_SCREEN = ("Agent KHÔNG loại ai — danh sách chỉ xếp hạng theo từ khóa; "
               "CV diễn đạt khác từ khóa có thể bị chấm thấp. Người duyệt "
               "đọc hồ sơ gốc và quyết.")
NOTE_ATT = ("Agent chỉ tổng hợp theo mã NV — KHÔNG tính lương, KHÔNG đề xuất "
            "kỷ luật; người duyệt đối chiếu đơn từ/phép trước khi dùng số.")


class HrConfigError(Exception):
    """Cấu hình JD / luật ca thiếu, hỏng hoặc sai luật."""


# ---------- tiện ích (thuần) ----------

def norm(s: str) -> str:
    """Không dấu, chữ thường, chỉ [a-z0-9] cách nhau 1 dấu cách."""
    s = unicodedata.normalize("NFD", str(s).lower()).replace("đ", "d")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(re.findall(r"[a-z0-9]+", s))


def has_kw(text_norm: str, kw_norm: str) -> bool:
    return f" {kw_norm} " in f" {text_norm} "


def sha12(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()[:12]


def _read_json(path: Path):
    try:
        return json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise HrConfigError(f"không đọc được {Path(path).name}: "
                            f"{type(e).__name__}") from None


def _strs(v, name: str, min_n: int = 0) -> list[str]:
    if (not isinstance(v, list) or len(v) < min_n
            or not all(isinstance(x, str) and x.strip() for x in v)):
        raise HrConfigError(f"{name}: phải là list ≥{min_n} chuỗi không rỗng")
    return v


def _bias(s: str) -> bool:
    n = norm(s)
    return n in _BIAS_EXACT or any(has_kw(n, b) for b in _BIAS_ANY)


def _crit(c, where: str, with_score: bool) -> dict:
    if not isinstance(c, dict):
        raise HrConfigError(f"{where}: phải là object")
    cid = c.get("id")
    if not (isinstance(cid, str) and _KEY_RE.fullmatch(cid)):
        raise HrConfigError(f"{where}.id: cần mã ^[a-z][a-z0-9_]{{1,39}}$")
    mo_ta = c.get("mo_ta")
    if not (isinstance(mo_ta, str) and mo_ta.strip()):
        raise HrConfigError(f"{where}.mo_ta: trống")
    kws = _strs(c.get("tu_khoa"), f"{where}.tu_khoa", 1)
    norms = [norm(k) for k in kws]
    if not all(norms):
        raise HrConfigError(f"{where}.tu_khoa: có từ khóa không chứa chữ/số")
    if _bias(mo_ta) or any(_bias(k) for k in kws):
        raise HrConfigError(f"{where}: tiêu chí phân biệt đối xử (giới tính/"
                            "tuổi/hôn nhân/tôn giáo/dân tộc/quê quán/ngoại "
                            "hình) — không được dùng để sàng lọc")
    out = {"id": cid, "mo_ta": mo_ta.strip(), "kw": norms}
    if with_score:
        d = c.get("diem")
        if not (isinstance(d, int) and not isinstance(d, bool) and 1 <= d <= 5):
            raise HrConfigError(f"{where}.diem: phải int 1..5")
        out["diem"] = d
    return out


def validate_position(key: str, p) -> dict:
    where = f"positions.{key}"
    if not _KEY_RE.fullmatch(key):
        raise HrConfigError(f"{where}: mã vị trí sai dạng")
    if not isinstance(p, dict):
        raise HrConfigError(f"{where}: phải là object")
    for f in ("ten", "muc_dich"):
        if not (isinstance(p.get(f), str) and p[f].strip()):
            raise HrConfigError(f"{where}.{f}: trống")
    if p.get("phong_ban") not in director.BLOCKS:
        raise HrConfigError(f"{where}.phong_ban: phải thuộc {director.BLOCKS}")
    _strs(p.get("nhiem_vu"), f"{where}.nhiem_vu", 1)
    _strs(p.get("quyen_loi", []), f"{where}.quyen_loi")
    bb, ut = p.get("bat_buoc"), p.get("uu_tien", [])
    if not isinstance(bb, list) or not bb:
        raise HrConfigError(f"{where}.bat_buoc: cần ≥1 tiêu chí")
    if not isinstance(ut, list):
        raise HrConfigError(f"{where}.uu_tien: phải là list")
    must = [_crit(c, f"{where}.bat_buoc[{i}]", False) for i, c in enumerate(bb)]
    pref = [_crit(c, f"{where}.uu_tien[{i}]", True) for i, c in enumerate(ut)]
    ids = [c["id"] for c in must + pref]
    if len(ids) != len(set(ids)):
        raise HrConfigError(f"{where}: id tiêu chí trùng")
    return {"key": key, "raw": p, "must": must, "pref": pref}


def load_position(key: str, path: Path | None = None) -> dict:
    """→ vị trí đã kiểm. Kiểm MỌI vị trí trong file (1 vị trí hỏng = file
    hỏng, không dùng nửa vời). Vị trí không có → HrConfigError."""
    raw = _read_json(path or JD_FILE)
    pos = raw.get("positions") if isinstance(raw, dict) else None
    if not isinstance(pos, dict) or not pos:
        raise HrConfigError("jd_templates: thiếu 'positions' (object ≥1 vị trí)")
    checked = {k: validate_position(k, v) for k, v in pos.items()}
    if key not in checked:
        raise HrConfigError(f"không có vị trí '{_clean(key, 40)}' — có: "
                            f"{sorted(checked)}")
    return checked[key]


def position_sha(pos: dict) -> str:
    return sha12(json.dumps(pos["raw"], ensure_ascii=False, sort_keys=True))


# ---------- 1) mô tả công việc ----------

def render_jd(pos: dict) -> str:
    p = pos["raw"]
    L = [f"# Mô tả công việc — {p['ten']} (NHÁP chờ duyệt)", "",
         f"- Mã vị trí: `{pos['key']}` · phòng ban: `{p['phong_ban']}`",
         ("- Nguồn: `data/hr/jd_templates.json` (BẢN DEV SOẠN — chờ Chuyên "
          "viên pháp chế–nhân sự + TGĐ chốt)"), "",
         "## Mục đích", "", p["muc_dich"].strip(), "", "## Nhiệm vụ", ""]
    L += [f"- {x.strip()}" for x in p["nhiem_vu"]]
    L += ["", "## Yêu cầu bắt buộc", ""]
    L += [f"- {c['mo_ta']}" for c in pos["must"]]
    if pos["pref"]:
        L += ["", "## Ưu tiên", ""]
        L += [f"- {c['mo_ta']}" for c in pos["pref"]]
    if p.get("quyen_loi"):
        L += ["", "## Quyền lợi", ""]
        L += [f"- {x.strip()}" for x in p["quyen_loi"]]
    L += ["", ("Agent chỉ soạn nháp — người duyệt sửa/duyệt trước khi đăng "
               "tuyển; hệ thống không đăng tự động."), ""]
    return "\n".join(L)


# ---------- 2) sàng lọc hồ sơ ----------

def inside_repo(d: Path) -> bool:
    d, root = Path(d).resolve(), ROOT.resolve()
    return d == root or root in d.parents


def read_cvs(d: Path) -> tuple[list[dict], int, str | None]:
    """→ (hồ sơ, số file bỏ qua, lỗi | None). Hồ sơ = {ma, files, text |
    None, why}; trùng nội dung gộp 1 mã. Lỗi ≠ None → hồ sơ = []."""
    d = Path(d)
    if not d.is_dir():
        return [], 0, "thư mục hồ sơ không tồn tại"
    picked, skipped = [], 0
    for p in sorted(d.iterdir(), key=lambda x: x.name):
        if (p.is_symlink() or not p.is_file()
                or p.suffix.lower() not in CV_SUFFIXES):
            skipped += 1
            continue
        picked.append(p)
        if len(picked) > MAX_CV_FILES:
            return [], skipped, (f"quá {MAX_CV_FILES} hồ sơ .txt/.md — tách "
                                 "đợt sàng lọc")
    by_ma: dict[str, dict] = {}
    for p in picked:
        text, why, data = None, None, b""
        try:
            if p.stat().st_size > MAX_CV_BYTES:
                with p.open("rb") as f:     # băm luồng, không nạp cả file
                    ma = hashlib.file_digest(f, "sha256").hexdigest()[:12]
                why = f"file > {MAX_CV_BYTES // 1024}KB"
            else:
                data = p.read_bytes()
                ma = sha12(data)
        except OSError as e:
            # không đọc được nội dung → mã theo tên file (chỉ nằm trong mã băm)
            ma = sha12(b"\0unreadable\0" + p.name.encode("utf-8"))
            why = f"không đọc được ({type(e).__name__})"
        if why is None:
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                why = "không phải UTF-8"
            else:
                if not text.strip():
                    text, why = None, "file rỗng"
        if ma in by_ma:
            by_ma[ma]["files"].append(p.name)
            continue
        by_ma[ma] = {"ma": ma, "files": [p.name], "text": text, "why": why}
    return list(by_ma.values()), skipped, None


def score(pos: dict, text: str) -> dict:
    t = norm(text)
    hit = [c for c in pos["must"] if any(has_kw(t, k) for k in c["kw"])]
    pref = [c for c in pos["pref"] if any(has_kw(t, k) for k in c["kw"])]
    return {"must_ok": [c["id"] for c in hit],
            "must_miss": [c["id"] for c in pos["must"] if c not in hit],
            "pref_ok": [c["id"] for c in pref],
            "diem": sum(c["diem"] for c in pref)}


def rank(pos: dict, cands: list[dict]) -> list[dict]:
    """Hồ sơ đọc được xếp (bắt buộc đạt ↓, điểm ↓, mã); không đọc được cuối
    (theo mã). Không bỏ hồ sơ nào."""
    ok = [{**c, **score(pos, c["text"])} for c in cands if c["text"] is not None]
    ok.sort(key=lambda c: (-len(c["must_ok"]), -c["diem"], c["ma"]))
    bad = sorted((c for c in cands if c["text"] is None),
                 key=lambda c: c["ma"])
    return ok + bad


def render_screening(pos: dict, ranked: list[dict], skipped: int) -> str:
    p = pos["raw"]
    desc = {c["id"]: c["mo_ta"] for c in pos["must"] + pos["pref"]}
    n_bad = sum(c["text"] is None for c in ranked)
    L = [f"# Sàng lọc hồ sơ — {p['ten']} (NHÁP xếp hạng chờ duyệt)", "",
         (f"- Vị trí `{pos['key']}` · tiêu chí mẫu `{position_sha(pos)}` "
          "(`data/hr/jd_templates.json`, BẢN DEV SOẠN)"),
         (f"- Hồ sơ: {len(ranked)} (đọc được {len(ranked) - n_bad}, cần "
          f"người đọc tay {n_bad}); file khác loại bỏ qua: {skipped}"),
         ("- Mã ứng viên = 12 ký tự đầu sha256 nội dung file — hàng duyệt "
          "KHÔNG có tên/SĐT/email/tên file"), "",
         "| Hạng | Mã ứng viên | Bắt buộc đạt | Điểm ưu tiên | Lý do |",
         "|---|---|---|---|---|"]
    n_must = len(pos["must"])
    for i, c in enumerate(ranked, 1):
        if c["text"] is None:
            L.append(f"| {i} | `{c['ma']}` | — | — | cần người đọc tay: "
                     f"{c['why']} |")
            continue
        why = []
        if c["must_ok"]:
            why.append("đạt: " + "; ".join(desc[x] for x in c["must_ok"]))
        if c["must_miss"]:
            why.append("THIẾU: " + "; ".join(desc[x] for x in c["must_miss"]))
        if c["pref_ok"]:
            why.append("ưu tiên: " + "; ".join(desc[x] for x in c["pref_ok"]))
        L.append(f"| {i} | `{c['ma']}` | {len(c['must_ok'])}/{n_must} | "
                 f"{c['diem']} | {' · '.join(why)} |")
    L += ["", f"**{NOTE_SCREEN}**", ""]
    return "\n".join(L)


# ---------- 3) chấm công ----------

def load_rules(path: Path | None = None) -> dict:
    raw = _read_json(path or RULES_FILE)
    if not isinstance(raw, dict):
        raise HrConfigError("attendance_rules: phải là object")
    try:
        shift = parse_shift(raw.get("shift"))
    except ValueError as e:
        raise HrConfigError(f"attendance_rules.shift: {e}") from None
    out = {"shift": shift}
    for f in ("grace_late_min", "grace_early_min"):
        v = raw.get(f)
        if not (isinstance(v, int) and not isinstance(v, bool)
                and 0 <= v <= MAX_GRACE):
            raise HrConfigError(f"attendance_rules.{f}: phải int 0..{MAX_GRACE}")
        out[f] = v
    return out


def _minutes(s: str | None) -> int | None:
    m = _TIME_RE.fullmatch(s.strip()) if s is not None else None
    return int(m[1]) * 60 + int(m[2]) if m else None


def _month_end(month: date) -> date:
    return (month.replace(day=28) + timedelta(days=4)).replace(day=1) \
        - timedelta(days=1)


def read_attendance(path: Path, month: date, today: date
                    ) -> tuple[list[dict], list[str], str | None]:
    """→ (dòng, lỗi, sha256 file). Lỗi ≠ [] → dòng = [] (kiểm toàn file).
    Lỗi chỉ nêu số dòng + tên field, KHÔNG giá trị ô."""
    table, sha, err = read_table(path)
    if err:
        return [], [err], sha
    rows, errs, seen = [], [], {}
    end = _month_end(month)
    try:
        first = next(table, None)
        if first is None:
            return [], ["file rỗng"], sha
        col_of, errs = map_header(first[1], {f: f for f in ATT_FIELDS}, {},
                                  [], "chấm công")
        if errs:
            return [], errs, sha
        width = len(first[1])
        for row_no, cells in table:
            if any(c is not None for c in cells[width:]):
                errs.append(f"dòng {row_no}: thừa ô ngoài header")
                continue
            rec = {f: (cells[j] if j < len(cells) else None)
                   for f, j in col_of.items()}

            def bad(f, why, row_no=row_no):
                errs.append(f"dòng {row_no}: field '{f}' {why}")

            ma, n0 = rec["ma_nv"], len(errs)
            if ma is None:
                bad("ma_nv", "trống")
            elif not _MA_NV_RE.fullmatch(ma) or _mask_pii(ma) != ma:
                bad("ma_nv", "phải là mã NV ^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$"
                    " (không tên, không SĐT/email)")
            day = _to_date(rec["ngay"])
            if rec["ngay"] is None:
                bad("ngay", "trống")
            elif day is None:
                bad("ngay", "phải YYYY-MM-DD hoặc DD/MM/YYYY")
            elif not (month <= day <= end):
                bad("ngay", f"ngoài tháng {month:%m/%Y}")
            elif day > today:
                bad("ngay", "ở tương lai")
            t_in, t_out = _minutes(rec["gio_vao"]), _minutes(rec["gio_ra"])
            if rec["gio_vao"] is None and rec["gio_ra"] is None:
                bad("gio_vao/gio_ra", "trống cả hai")
            if rec["gio_vao"] is not None and t_in is None:
                bad("gio_vao", "phải HH:MM")
            if rec["gio_ra"] is not None and t_out is None:
                bad("gio_ra", "phải HH:MM")
            if t_in is not None and t_out is not None and t_out <= t_in:
                bad("gio_ra", "phải sau gio_vao (không hỗ trợ ca qua đêm)")
            if len(errs) > n0:
                continue
            if (ma, day) in seen:
                errs.append(f"dòng {row_no}: trùng (ma_nv, ngay) với dòng "
                            f"{seen[(ma, day)]}")
                continue
            seen[(ma, day)] = row_no
            rows.append({"row_no": row_no, "ma_nv": ma, "ngay": day,
                         "vao": t_in, "ra": t_out})
        if not rows and not errs:
            return [], ["file chỉ có header, không có dòng dữ liệu"], sha
    except _TableError as e:
        return [], [str(e)], sha
    return ([] if errs else rows), errs, sha


def is_workday(d: date, shift: dict) -> bool:
    return d.weekday() in shift["workdays"] and d not in shift["holidays"]


def summarize(rows: list[dict], month: date, rules: dict, until: date
              ) -> dict[str, dict]:
    """→ {mã NV: số liệu}. `until` = ngày cuối được tính vắng (≤ cuối
    tháng); ngày làm sau `until` không tính vắng."""
    sh = rules["shift"]
    late_at = sh["start_min"] + rules["grace_late_min"]
    early_at = sh["end_min"] - rules["grace_early_min"]
    last = min(until, _month_end(month))
    workdays = []
    d = month
    while d <= last:
        if is_workday(d, sh):
            workdays.append(d)
        d += timedelta(days=1)
    out: dict[str, dict] = {}
    for r in rows:
        s = out.setdefault(r["ma_nv"], {
            "ngay_cong": 0, "di_tre": 0, "phut_tre": 0, "ve_som": 0,
            "phut_som": 0, "thieu_cham": 0, "vang": 0, "ngoai_lich": 0,
            "_days": set()})
        s["_days"].add(r["ngay"])
        work = is_workday(r["ngay"], sh)
        if not work:
            s["ngoai_lich"] += 1
        if r["vao"] is not None and r["ra"] is not None:
            s["ngay_cong"] += 1
        else:
            s["thieu_cham"] += 1
        if work and r["vao"] is not None and r["vao"] > late_at:
            s["di_tre"] += 1
            s["phut_tre"] += r["vao"] - sh["start_min"]
        if work and r["ra"] is not None and r["ra"] < early_at:
            s["ve_som"] += 1
            s["phut_som"] += sh["end_min"] - r["ra"]
    for s in out.values():
        s["vang"] = sum(d not in s["_days"] for d in workdays)
        del s["_days"]
    return out


def _hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def render_attendance(month: date, stats: dict, rules: dict, until: date,
                      sha: str) -> str:
    sh = rules["shift"]
    closed = until >= _month_end(month)
    L = [f"# Tổng hợp chấm công tháng {month:%m/%Y} (NHÁP chờ duyệt)", "",
         (f"- Ca GIẢ ĐỊNH `data/hr/attendance_rules.json`: {_hhmm(sh['start_min'])}"
          f"–{_hhmm(sh['end_min'])}, du di trễ {rules['grace_late_min']} phút /"
          f" về sớm {rules['grace_early_min']} phút; lịch nghỉ lễ: "
          + (f"{len(sh['holidays'])} ngày" if sh["holidays"]
             else "CHƯA CÓ (ngày lễ bị tính là ngày làm)")),
         f"- File chấm công sha256 `{sha[:12]}` · {len(stats)} mã NV",
         ("- Kỳ ĐÃ ĐÓNG" if closed else
          f"- Kỳ CHƯA ĐÓNG — vắng chỉ tính tới {until:%d/%m/%Y}"),
         ("- NV không có dòng nào trong file KHÔNG xuất hiện ở đây (agent "
          "không có danh sách NV)"), "",
         ("| Mã NV | Ngày công | Đi trễ (lần/phút) | Về sớm (lần/phút) | "
          "Thiếu chấm | Vắng không chấm | Chấm ngoài lịch |"),
         "|---|---|---|---|---|---|---|"]
    for ma in sorted(stats):
        s = stats[ma]
        L.append(f"| `{ma}` | {s['ngay_cong']} | {s['di_tre']}/{s['phut_tre']}"
                 f" | {s['ve_som']}/{s['phut_som']} | {s['thieu_cham']} | "
                 f"{s['vang']} | {s['ngoai_lich']} |")
    L += ["", f"**{NOTE_ATT}**", ""]
    return "\n".join(L)


# ---------- CLI ----------

def _print_errs(errs: list[str]) -> None:
    for e in errs[:MAX_PRINT_ERRS]:
        print(f"[err] {e}", flush=True)
    if len(errs) > MAX_PRINT_ERRS:
        print(f"[err] ... và {len(errs) - MAX_PRINT_ERRS} lỗi khác")
    print(f"[err] {len(errs)} lỗi — không connect, không ghi gì.", flush=True)


def _today() -> date:
    return vn_date(datetime.now(timezone.utc))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.pc_hr",
        description="PC-HR: nháp mô tả công việc, xếp hạng hồ sơ, tổng hợp "
                    "chấm công → hàng duyệt khối legal_hr (agent chỉ đề xuất)")
    ap.add_argument("--jd", metavar="VI_TRI")
    ap.add_argument("--screen", action="store_true")
    ap.add_argument("--dir", type=Path, metavar="THU_MUC_CV")
    ap.add_argument("--attendance", type=Path, metavar="FILE")
    ap.add_argument("--month", help="YYYY-MM (với --attendance)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if args.attendance is not None:
        if args.screen or args.jd:
            ap.error("--attendance không dùng chung với --jd/--screen")
        op = "attendance"
    elif args.screen:
        if not args.jd:
            ap.error("--screen cần --jd <vi_tri>")
        op = "screen"
    elif args.jd:
        op = "jd"
    else:
        ap.error("cần --jd VI_TRI | --screen --jd VI_TRI | --attendance FILE "
                 "--month YYYY-MM")
    if op != "attendance" and args.month:
        ap.error("--month chỉ dùng với --attendance")
    if op != "screen" and args.dir is not None:
        ap.error("--dir chỉ dùng với --screen")
    month = None
    if op == "attendance":
        month = parse_month(args.month)
        if month is None:
            ap.error("cần --month YYYY-MM (tháng 01..12)")
        if month > _today():
            ap.error(f"tháng {month:%m/%Y} chưa bắt đầu")
    cv_dir = None
    if op == "screen":
        cv_dir = args.dir or (Path(os.environ["HR_INBOX_DIR"])
                              if os.environ.get("HR_INBOX_DIR") else None)
        if cv_dir is None:
            ap.error("cần --dir hoặc env HR_INBOX_DIR (thư mục CV ngoài repo)")
        if inside_repo(cv_dir):
            ap.error("thư mục CV nằm TRONG repo — CV có dữ liệu cá nhân, đặt "
                     "ngoài repo (HR_INBOX_DIR)")

    try:
        dcfg = director.load_config(BLOCK)
        if op == "attendance":
            rules = load_rules()
        else:
            pos = load_position(args.jd)
    except (HrConfigError, director.DirectorConfigError) as e:
        print(f"[err] cấu hình: {e} — không connect.", flush=True)
        return 1

    if op == "jd":
        payload = render_jd(pos)
        otype, oid = "hr_jd", f"jd:{pos['key']}:{sha12(payload)}"
        title = f"Nháp mô tả công việc: {pos['raw']['ten']}"
    elif op == "screen":
        cands, skipped, err = read_cvs(cv_dir)
        if err is None and not cands:
            err = "không có hồ sơ .txt/.md nào trong thư mục"
        if err:
            print(f"[err] {err} — không connect.", flush=True)
            return 1
        ranked = rank(pos, cands)
        for c in ranked:
            names = ", ".join(_clean(_mask_pii(n), 80) for n in c["files"])
            print(f"[map] {c['ma']} ← {names}  (chỉ hiện trên máy người chạy)")
        payload = render_screening(pos, ranked, skipped)
        key = sha12("\n".join(sorted(c["ma"] for c in ranked))
                    + position_sha(pos))
        otype, oid = "hr_screening", f"screen:{pos['key']}:{key}"
        title = (f"Sàng lọc hồ sơ {pos['raw']['ten']}: {len(ranked)} hồ sơ "
                 "(xếp hạng, không tự loại)")
    else:
        today = _today()
        rows, errs, sha = read_attendance(args.attendance, month, today)
        if errs:
            _print_errs(errs)
            return 1
        until = min(_month_end(month), today - timedelta(days=1))
        stats = summarize(rows, month, rules, until)
        payload = render_attendance(month, stats, rules, until, sha)
        otype, oid = "hr_attendance", f"att:{month:%Y-%m}:{sha[:12]}"
        title = (f"Chấm công {month:%m/%Y}: {len(stats)} mã NV (tổng hợp, "
                 "chờ duyệt)")

    g = guardrail_check(payload)
    if not g.get("ok"):
        kinds = sorted({v.get("type", "?") for v in g.get("violations", [])})
        print(f"[err] nội dung không qua guardrail ({', '.join(kinds)}) — "
              "sửa mẫu, không đẩy.", flush=True)
        return 1
    if args.dry_run:
        print(payload)
        print(f"[dry-run] {otype} `{oid}` — không connect, không ghi gì.")
        return 0

    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        qid = director.submit(conn, BLOCK, otype, oid, title, payload,
                              created_by=CREATED_BY, cfg=dcfg)
    except psycopg.errors.UniqueViolation:
        conn.rollback()
        print(f"[skip] đã có mục {otype} `{oid}` đang chờ duyệt — không đẩy "
              "trùng.")
        return 0
    except psycopg.Error as e:
        conn.rollback()
        print(f"[error] DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    print(f"[submit] {otype} → mục hàng duyệt #{qid} (khối {BLOCK}, chờ "
          "Chuyên viên pháp chế duyệt — agent không tự duyệt/gửi)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
