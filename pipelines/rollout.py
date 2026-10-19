"""v12.1 B1 — sổ triển khai 3 bước + hồ sơ đề nghị nghiệm thu (HĐ hợp tác
TEDO–Sâm Sâm, PL02 mục 1).

Quy trình HĐ: mỗi tính năng chạy thử nội bộ ≥05 ngày làm việc VÀ ≥50 đầu
ra → chạy có người duyệt ≥10 ngày làm việc, 0 lỗi nghiêm trọng → vận hành.
Một lỗi nghiêm trọng (PL02 mục 2) → tắt, quay về chạy thử.

Contract:
  - Danh mục `data/contract_features.json` (`load_features`, v13.0) — BẢN ĐỀ
    XUẤT 1 dòng / mục yêu cầu (tách nhóm PL01 mục 2 khi chữ gốc liệt kê đầu
    ra phân biệt: id `<nhóm>.<n>` + `nhom_goc`), chờ hai bên chốt 89 mục.
    Loader kiểm schema (code_status, acceptance_status, output_sources,
    blocker...), không 2 mục chung 1 agent_id / 1 nguồn đầu ra, và
    `tong_hop` khớp `summary()` (số mục đề xuất ↔ số HĐ) — lệch → ValueError.
    Chỉ `code_status = co_code` được vào sổ.
  - Migration ID: dòng sổ của id NHÓM cũ (v12) giữ nguyên, không sửa/xóa;
    mục tách vào sổ với mốc MỚI (không kế thừa ngày); nhóm cũ đang `tat` →
    mục tách vào `tat` (không tự bật lại). `--status`/hồ sơ liệt kê id cũ.
  - Bảng `feature_rollout` (trạng thái hiện tại) + `feature_rollout_events`
    (append-only) — docs/schema.sql khối `v12.1 B1`.
  - Giai đoạn `chay_thu` → `co_nguoi_duyet` → `van_hanh`; `tat` (tắt tay)
    → `--promote` đưa lại `chay_thu` (bắt đầu đếm lại). Mọi ghi cần
    `--by` NGƯỜI thật (chặn 'agent:'/'system:' ở code + CHECK DB).
  - Cổng nâng (tính trong tx, khóa dòng `for update`). v13.3 (F04): ĐẦU RA
    = mục DISTINCT ở `output_sources` của ĐÚNG tính năng (không đếm dòng
    `agent_action_log` theo actor — 50 log bất kỳ không phải 50 đầu ra):
    `approval_queue` (khối + loại [+ created_by]; 1 object_id = 1 đầu ra dù
    xếp hàng lại) và `content_drafts` (created_by + loại; trùng nội dung =
    1). Chỉ đầu ra guardrail ok, KHÔNG mẫu (object_id 'sample'/'mau', tiêu
    đề/brief có 'MẪU', source 'sample…'), tạo trong [lúc vào giai đoạn,
    bây giờ]. v14.3: nguồn `report` đếm DISTINCT tên trong sổ
    `report_outputs` (ghi bởi `write_report` → `record_report`); nguồn bảng
    riêng đếm DISTINCT khóa tự nhiên theo `_TABLES` (thời điểm tạo, mẫu
    theo cột provenance `is_sample`/`source`/`dry_run`/lô mẫu, người quyết
    từng mục nếu bảng có bước đó — không có thì đầu ra không đủ bằng chứng
    người duyệt cho co_nguoi_duyet → van_hanh); khóa trùng giữa 2 nguồn của
    cùng tính năng gộp 1. Khóa lọc danh mục phải có bộ lọc thật của bảng
    (loader từ chối). v15.2 (P8.1): nguồn `file` đếm theo `_FILES` —
    `conversations.jsonl` (+`.1`, sales-01: câu bot ĐÃ GỬI khách thật zalo/
    messenger, DISTINCT kênh+msg_id, gửi không người duyệt = dùng thiếu
    người; v15 fix P8.1: CHỈ dòng `provenance == "live"` do transport kênh
    thật đặt lúc ghi — mock/replay/test/demo/`is_sample` không tính, bản
    ghi cũ thiếu provenance không công nhận + báo `uncounted`) và
    `$BACKUP_DIR/backup_runs.jsonl` (data_platform-07.2: backup
    `ok` DISTINCT sha bản dump — v15 fix P8.7c: danh mục data_platform-07.2
    nay đếm sổ DB `file_output_evidence`, bộ đếm file giữ cho nguồn file
    khác/tương thích); file chính thiếu/BACKUP_DIR chưa cấu hình/
    lỗi IO → `uncounted` (không phải 0 đầu ra), dòng hỏng bỏ qua + ghi
    `uncounted`; file khác tên → loader từ chối. Nguồn đọc lỗi (bảng thiếu
    / login thiếu quyền) → vào `uncounted`, không làm hỏng tx.
    v15.2 (P8.7): đầu ra KHÔNG có bước người duyệt riêng (báo cáo file,
    bảng không cột người quyết, backup) chỉ được tính "NGƯỜI duyệt" qua sổ
    append-only `output_reviews` (người theo login + sha phiên bản nội dung
    hiện hành; báo cáo = bản mới nhất trong `report_outputs`) — sinh ra ≠ đã
    duyệt; nội dung đổi → duyệt cũ hết hiệu lực. v15 fix P8.7: function DB
    tự kiểm khóa/phiên bản bằng `count_spec`; khóa nguồn FILE chưa có bản
    chụp tin cậy trong DB → chưa duyệt được (runbook 9.7). v15 fix P8.7c:
    backup (data_platform-07.2) có bằng chứng DB `file_output_evidence` do
    chính tiến trình backup (login svc_backup) ghi → đếm/liệt kê/duyệt/cổng
    PL02 từ sổ đó như nguồn bảng (khóa `bk:`, phiên bản = bản ghi mới nhất).
      chay_thu → co_nguoi_duyet: ≥5 ngày làm việc VÀ ≥50 đầu ra VÀ đầu ra
        rải trên ≥5 ngày làm việc khác nhau.
      co_nguoi_duyet → van_hanh: ≥10 ngày làm việc VÀ ≥1 đầu ra được NGƯỜI
        duyệt từng mục (không 'agent:'/'system:'/auto_policy) VÀ không đầu
        ra nào được duyệt/dùng thiếu người duyệt VÀ (v15.2) 0 đầu ra báo
        cáo/bảng/file chưa có người duyệt đúng phiên bản VÀ 0 sự kiện
        `severe`. Lý do chặn = `evaluate(...)[1]`; chỉ đạt khi RỖNG.
  - Cưỡng chế runtime v13.3 (F03, HĐ 6.7): `mode(conn, feature_id)` là
    nguồn DUY NHẤT; chưa vào sổ / bảng thiếu / DB down / không thuộc tính
    năng nào → `chay_thu` (fail-closed). `rollout_config.json` `enforce:
    false` (tường minh) mới tắt cưỡng chế. Biên: sinh (`approval_queue.
    enqueue`, `store.save_draft`, `agents.report.write_report`) chặn khi
    `tat`; quyết duyệt chặn khi `tat`; DÙNG (`approval_queue.verify` —
    mọi --verify-send/--export/áp dụng, `store.schedule`, chatbot gửi
    khách) chặn khi `chay_thu`/`tat`, `co_nguoi_duyet` chỉ mục người
    duyệt từng mục.
    Ngày làm việc = số ngày làm việc SAU ngày vào giai đoạn tới hết hôm nay
    (giờ VN; ngày vào không tính) theo `data/rollout_config.json` (GIẢ
    ĐỊNH T2–T6, chưa lịch lễ), kiểm qua `pipelines.period.parse_shift`.
  - `--severe ID --reason <mã PL02>` ghi sự kiện + tự lùi về `chay_thu`
    (đặt lại mốc đếm); tính năng đang `tat` giữ `tat`.
  - `--dossier --phase P1|P2` → markdown hồ sơ đề nghị nghiệm thu (danh sách
    tính năng, kết quả cổng, nhật ký lỗi nghiêm trọng, bảng tiêu chí PL02
    mục 2 kèm lệnh/bằng chứng có trong repo hoặc "chưa có bằng chứng").
    Chỉ đọc DB, không gửi đi. Bản nháp — Bên B ký biên bản.
  - Không LLM, không mạng. `note` qua `_mask_pii` trước khi ghi.

Chạy:
  python -m pipelines.rollout --seed --by NAME
  python -m pipelines.rollout --status
  python -m pipelines.rollout --promote ID --by NAME
  python -m pipelines.rollout --severe ID --reason CODE --by NAME [--note ..]
  python -m pipelines.rollout --disable ID --by NAME [--note ..]
  python -m pipelines.rollout --dossier --phase P1 [--out F]
  python -m pipelines.rollout --catalog       (tổng hợp danh mục, không DB)
  python -m pipelines.rollout --outputs ID [--by NAME]
      (đầu ra cần người duyệt + sha; login người → bộ đếm DB)
  python -m pipelines.rollout --review-output ID --key K --sha S
      --decision approved|rejected --by NAME [--note ..]
Exit: 0 ok · 1 bị từ chối (chưa đủ cổng / không có trong sổ) · 2 tham số
sai / cấu hình lỗi / DB down.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from psycopg import sql as pgsql
from psycopg.types.json import Jsonb

from agents.report import REPORTS_DIR, write_report
from ingest.lead_store import connect
from pipelines import period
from pipelines.director import BLOCKS
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
FEATURES_FILE = ROOT / "data" / "contract_features.json"
CONFIG_FILE = ROOT / "data" / "rollout_config.json"

STAGES = ("chay_thu", "co_nguoi_duyet", "van_hanh", "tat")
STAGE_LABEL = {"chay_thu": "chạy thử", "co_nguoi_duyet": "có người duyệt",
               "van_hanh": "vận hành", "tat": "tắt"}
CODE_STATES = ("co_code", "mot_phan", "thieu", "lam_rieng", "ngoai_code")
CODED = ("co_code", "mot_phan")             # có module trong repo
ACCEPTANCE = ("chua_nghiem_thu", "da_nghiem_thu")
PHAM_VI = ("tinh_nang_ai", "nen_tang_tmdt", "truy_xuat_blockchain",
           "nghia_vu_hd")                   # chỉ tinh_nang_ai tính vào 89
PHASES = ("P1", "P2")
HD_TOTAL = 89                     # HĐ: 89 tính năng / 9 phòng ban
SRC_KINDS = ("table", "report", "file")
SRC_KEYS = frozenset(SRC_KINDS) | {"block", "object_type", "created_by",
                                   "content_type", "source_agent", "rules_any",
                                   "kind", "source"}
TRIAL_DAYS, TRIAL_OUTPUTS, REVIEW_DAYS = 5, 50, 10    # PL02 mục 1a, 1b
MAX_BY = 100
MAX_NOTE = 300
_ID_RE = re.compile(r"([a-z_]+)-([0-9]{2})(?:\.([0-9]{1,2}))?")

# PL02 mục 2 — danh sách lỗi nghiêm trọng.
SEVERE = {
    "tu_cam": "Từ cấm trong đầu ra",
    "ruou_cong_khai": "Rượu xuất hiện trong nội dung công khai",
    "tpbvsk_chua_xnqc": "TPBVSK chưa có giấy XNQC ở quảng cáo/KOC/livestream",
    "thieu_khuyen_cao": "Thiếu câu khuyến cáo",
    "thieu_nhan_ai": "Nội dung AI thiếu nhãn",
    "lo_pii": "Lộ dữ liệu cá nhân",
    "so_lieu_khong_nguon": "Số liệu không có nguồn",
}

# PL02 mục 2 — tiêu chí kỹ thuật: (chỉ tiêu, yêu cầu, lệnh, bằng chứng).
# Bằng chứng = (đường dẫn repo, chuỗi phải có hoặc None). Thiếu file/chuỗi
# → "chưa có bằng chứng". Dòng đầu tính từ DB (`_severe_review_line`).
CRITERIA = (
    ("Lỗi nghiêm trọng trong giai đoạn chạy có người duyệt", "0 lỗi",
     None, ()),
    ("Nội dung đăng tải đã qua kiểm duyệt tự động và người duyệt", "100%",
     ("python -m agents.bks_audit --report --month YYYY-MM · "
     "python -m pipelines.store --verify-log"),
     (("agents/bks_audit.py", None), ("pipelines/store.py", "verify_log"))),
    ("Lời gọi AI đi qua cổng an toàn (che dữ liệu cá nhân)", "100%",
     ("python -m pytest tests/test_llm_gateway.py -k "
     "no_openai_constructor_outside_gateway"),
     (("tests/test_llm_gateway.py",
       "def test_no_openai_constructor_outside_gateway"),)),
    ("Backup dữ liệu thành công", "100% số ngày",
     ("python scripts/db_backup.py (ghi job_runs) · "
     "python scripts/ops_monthly.py --month YYYY-MM"),
     (("scripts/db_backup.py", None), ("scripts/ops_monthly.py", None))),
    ("Diễn tập khôi phục dữ liệu", "30/11/2026, 18/12/2026, sau đó mỗi quý",
     "python scripts/db_restore_drill.py · python scripts/dr_drill.py",
     (("scripts/db_restore_drill.py", None), ("scripts/dr_drill.py", None))),
    ("Phát hiện sự cố hệ thống", "Trong vòng 15 phút",
     ("deploy/docker-compose.monitoring.yml (Uptime Kuma) · "
     "python scripts/health_bulletin.py"),
     (("deploy/docker-compose.monitoring.yml", None),
      ("scripts/health_bulletin.py", None))),
    ("Phản hồi lỗi nghiêm trọng", "Trong vòng 03 giờ", None, ()),
    ("Phản hồi lỗi thường", "Trong vòng 03 ngày làm việc", None, ()),
    ("Sửa lỗi phát sinh", "Trong vòng 07 ngày", None, ()),
    ("Phản hồi tự động của chatbot", "Trong vòng 30 giây",
     "convlog `reply_ms` · python scripts/ops_monthly.py --month YYYY-MM",
     (("connectors/zalo.py", "reply_ms"), ("scripts/ops_monthly.py", None))),
    ("Hạ tầng", "Theo PL01 mục 8", "deploy/onprem/README.md",
     (("deploy/onprem/README.md", None),)),
)


class RolloutError(Exception):
    """Bị từ chối (exit 1) — chưa đủ cổng, không có trong sổ/danh mục."""


# ------------------------------------------------------------ cấu hình


def _str_list(v, where: str) -> list[str]:
    if not isinstance(v, list) or not all(
            isinstance(x, str) and x.strip() for x in v):
        raise ValueError(f"{where}: phải là list chuỗi không rỗng")
    if len(set(v)) != len(v):
        raise ValueError(f"{where}: có phần tử trùng")
    return v


def _nonblank(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _check_sources(fid: str, srcs) -> list[dict]:
    if not isinstance(srcs, list):      # loader chỉ ném ValueError (fail-closed)
        raise ValueError(f"{fid}.output_sources: phải là list")  # noqa: TRY004
    for j, d in enumerate(srcs):
        w = f"{fid}.output_sources[{j}]"
        if not isinstance(d, dict) or set(d) - SRC_KEYS \
                or sum(k in d for k in SRC_KINDS) != 1:
            raise ValueError(f"{w}: phải là object có đúng 1 trong "
                             f"{SRC_KINDS}, key ⊂ {sorted(SRC_KEYS)}")
        for k, v in d.items():
            if k == "rules_any":
                _str_list(v, f"{w}.rules_any")
            elif not _nonblank(v):
                raise ValueError(f"{w}.{k}: chuỗi rỗng")
        need = {"approval_queue": ("block", "object_type"),
                "content_drafts": ("created_by", "content_type")}.get(
                    d.get("table"), ())
        if any(k not in d for k in need):
            raise ValueError(f"{w}: bảng {d['table']} cần {need}")
        if "file" in d and (set(d) != {"file"} or d["file"] not in _FILES):
            raise ValueError(f"{w}: nguồn file chỉ nhận {sorted(_FILES)} "
                             "(không khóa lọc) — file khác chưa có bộ đếm")
        spec = _TABLES.get(d.get("table"))
        if spec is not None:        # v14.3: khóa lọc phải có bộ lọc thật
            bad = set(d) - {"table"} - set(spec.get("filters", {}))
            if bad:                 # (bỏ qua câm = đếm chéo tính năng khác)
                raise ValueError(f"{w}: bảng {d['table']} không lọc được "
                                 f"theo {sorted(bad)} — có "
                                 f"{sorted(spec.get('filters', {}))}")
    return srcs


def _status(hd: int, n: int) -> str:
    if n == hd:
        return "khớp số lượng — nội dung chờ hai bên chốt"
    return f"chưa xác định — chờ hai bên chốt (đề xuất {n}/{hd})"


def summary(feats: list[dict], counts: dict, phases: dict) -> dict:
    """Số mục `tinh_nang_ai` đề xuất ↔ số HĐ theo khối/giai đoạn/tổng.
    Khớp số lượng KHÔNG có nghĩa đã chốt."""
    ai = [f for f in feats if f.get("pham_vi") == "tinh_nang_ai"]
    out = {}
    for key, hd, n in (
            [(b, counts[b], sum(f["phong_ban"] == b for f in ai))
             for b in BLOCKS]
            + [(p, phases[p], sum(f["giai_doan"] == p for f in ai))
               for p in PHASES]
            + [("tong", sum(counts.values()), len(ai))]):
        out[key] = {"hd": hd, "de_xuat": n, "trang_thai": _status(hd, n)}
    out["ngoai_89"] = {p: sum(f.get("pham_vi") == p for f in feats)
                       for p in PHAM_VI[1:]}
    return out


def split_map(feats: list[dict]) -> dict[str, list[str]]:
    """id nhóm cũ (v12) → các mục đã tách (theo `nhom_goc`)."""
    m: dict[str, list[str]] = {}
    for f in feats:
        if f.get("nhom_goc"):
            m.setdefault(f["nhom_goc"], []).append(f["id"])
    return m


def _check_item(i: int, f) -> str:
    fid = f.get("id") if isinstance(f, dict) else None
    m = _ID_RE.fullmatch(fid) if isinstance(fid, str) else None
    if not m:
        raise ValueError(f"features[{i}].id: thiếu/sai")
    if f.get("phong_ban") not in BLOCKS or m.group(1) != f["phong_ban"]:
        raise ValueError(f"{fid}.phong_ban: phải ∈ {BLOCKS} và khớp "
                         "tiền tố id")
    base = f"{m.group(1)}-{m.group(2)}"
    bad_goc = (f.get("nhom_goc") != base) if m.group(3) else (
        "nhom_goc" in f)
    if bad_goc:
        raise ValueError(f"{fid}.nhom_goc: mục tách '<nhóm>.<n>' phải có "
                         "nhom_goc = id nhóm; mục nguyên nhóm không có")
    if f.get("pham_vi") not in PHAM_VI:
        raise ValueError(f"{fid}.pham_vi: phải ∈ {PHAM_VI}")
    for k in ("ten", "nguon", "nguoi_duyet", "owner", "dau_ra"):
        if not _nonblank(f.get(k)):
            raise ValueError(f"{fid}.{k}: thiếu")
    if f.get("giai_doan") not in PHASES:
        raise ValueError(f"{fid}.giai_doan: phải ∈ {PHASES}")
    code = f.get("code_status")
    if code not in CODE_STATES:
        raise ValueError(f"{fid}.code_status: phải ∈ {CODE_STATES}")
    if f.get("acceptance_status") not in ACCEPTANCE:
        raise ValueError(f"{fid}.acceptance_status: phải ∈ {ACCEPTANCE}")
    if f["acceptance_status"] == "da_nghiem_thu" and \
            not _nonblank(f.get("bien_ban")):
        raise ValueError(f"{fid}.bien_ban: da_nghiem_thu cần số biên bản "
                         "đã ký")
    for k in ("modules", "agent_ids", "phu_thuoc", "bang_chung"):
        v = f.get(k)
        if v or not isinstance(v, list):
            _str_list(v, f"{fid}.{k}")
    if code in CODED and not f["modules"]:
        raise ValueError(f"{fid}.modules: {code} phải có ≥1 module")
    if code in ("lam_rieng", "ngoai_code") and (f["modules"]
                                                 or f["agent_ids"]):
        raise ValueError(f"{fid}.modules: {code} không có module/agent_ids"
                         " trong repo")
    srcs = _check_sources(fid, f.get("output_sources"))
    if code in CODED and not srcs and not _nonblank(
            f.get("output_sources_note")):
        raise ValueError(f"{fid}.output_sources_note: output_sources rỗng "
                         "phải nêu lý do")
    b = f.get("blocker")
    if not (b is None or _nonblank(b)) or (code != "co_code" and b is None):
        raise ValueError(f"{fid}.blocker: null hoặc chuỗi; code_status "
                         f"{code} phải có blocker cụ thể")
    return fid


def _overlap(a: dict, b: dict) -> bool:
    """2 nguồn bảng cùng bảng mà mọi key chung bằng nhau (key thiếu = mọi
    giá trị; rules_any giao nhau) → 1 dòng thuộc được cả 2 = đếm chéo."""
    if a.get("table") != b.get("table"):
        return False
    for k in set(a) & set(b):
        if k == "rules_any":
            if not set(a[k]) & set(b[k]):
                return False
        elif a[k] != b[k]:
            return False
    return True


def load_features(path: Path = FEATURES_FILE) -> list[dict]:
    """Đọc + kiểm danh mục → list dòng. Sai → ValueError (fail-closed)."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        items, counts = doc["features"], doc["so_tinh_nang_hd"]
        phases, tong = doc["so_giai_doan_hd"], doc["tong_hop"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    if not isinstance(counts, dict) or set(counts) != set(BLOCKS) or any(
            isinstance(n, bool) or not isinstance(n, int) or n < 1
            for n in counts.values()) or sum(counts.values()) != HD_TOTAL:
        raise ValueError(f"so_tinh_nang_hd: phải đủ {len(BLOCKS)} phòng ban,"
                         f" số nguyên ≥1, tổng {HD_TOTAL}")
    if not isinstance(phases, dict) or set(phases) != set(PHASES) or any(
            isinstance(n, bool) or not isinstance(n, int) or n < 0
            for n in phases.values()) or sum(phases.values()) != HD_TOTAL:
        raise ValueError(f"so_giai_doan_hd: phải có {PHASES}, tổng "
                         f"{HD_TOTAL}")
    if not isinstance(items, list) or not items:
        raise ValueError("features: rỗng")
    out, seen, aid_of, src_of, tables = [], set(), {}, {}, []
    for i, f in enumerate(items):
        fid = _check_item(i, f)
        if fid in seen:
            raise ValueError(f"features[{i}].id: trùng {fid}")
        for a in f["agent_ids"]:
            if aid_of.setdefault(a, fid) != fid:
                raise ValueError(f"{fid}.agent_ids: '{a}' đã thuộc "
                                 f"{aid_of[a]} — không đếm chéo")
        for d in f["output_sources"]:
            k = json.dumps(d, sort_keys=True, ensure_ascii=False)
            if src_of.setdefault(k, fid) != fid:
                raise ValueError(f"{fid}.output_sources: {k} đã thuộc "
                                 f"{src_of[k]} — không đếm chéo")
            for ofid, o in tables:          # v13.3: phạm vi lọc giao nhau
                if ofid != fid and _overlap(d, o):
                    raise ValueError(f"{fid}.output_sources: {k} giao phạm "
                                     f"vi với nguồn của {ofid} — không đếm "
                                     "chéo")
            if "table" in d:
                tables.append((fid, d))
        seen.add(fid)
        out.append(f)
    if tong != summary(out, counts, phases):
        raise ValueError("tong_hop: lệch số mục thực của features — chạy "
                         "lại summary()")
    return out


def load_shift(path: Path = CONFIG_FILE) -> dict:
    """Lịch ngày làm việc → shift chuẩn hóa của `pipelines.period`.
    Giờ ca không dùng (đếm theo NGÀY) — đặt cả ngày để tái dùng kiểm."""
    try:
        cfg = json.loads(Path(path).read_bytes().decode("utf-8"))
        wd, hol = cfg["workdays"], cfg.get("holidays", [])
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    return period.parse_shift({"start": "00:00", "end": "23:59",
                               "workdays": wd, "holidays": hol})


# ------------------------------------------------------------ thuần


def business_days(since: datetime, now: datetime, shift) -> int:
    """Số ngày làm việc d với ngày_VN(since) < d ≤ ngày_VN(now)."""
    if not isinstance(since, datetime) or not isinstance(now, datetime):
        raise TypeError("since/now phải là datetime có múi giờ")
    s = period.parse_shift(shift)
    a, b = period.vn_date(since), period.vn_date(now)
    n, d = 0, a + timedelta(days=1)
    while d <= b:
        if d.weekday() in s["workdays"] and d not in s["holidays"]:
            n += 1
        d += timedelta(days=1)
    return n


def check_by(by) -> str:
    s = (by or "").strip() if isinstance(by, str) else ""
    if not s or len(s) > MAX_BY or not s.isprintable() \
            or s.casefold().startswith(("agent:", "system:")):
        raise ValueError(f"--by phải là tên NGƯỜI thật (1..{MAX_BY} ký tự,"
                         " không 'agent:'/'system:')")
    return s


def _clean_note(note) -> str | None:
    if note is None or not str(note).strip():
        return None
    return _oneline(_mask_pii(str(note)), MAX_NOTE)


def _feature(feats: list[dict], fid: str) -> dict:
    for f in feats:
        if f["id"] == fid:
            return f
    raise RolloutError(f"{fid}: không có trong danh mục contract_features")


_NO_COUNT = ("không đếm được đầu ra — output_sources không có nguồn đếm "
             "được (chỉ có file nhật ký / bảng chưa có bộ đếm / không đọc "
             "được)")


def evaluate(stage: str, days: int, outputs: int | None, severe: int,
             out_days: int = 0, human: int = 0, unapproved: int = 0,
             unreviewed: int = 0) -> tuple[str | None, list[str]]:
    """Cổng PL02 mục 1 → (giai đoạn đích, [lý do chưa đạt]). Rỗng = đạt.
    `out_days` = số ngày làm việc khác nhau có đầu ra; `human` = số đầu ra
    NGƯỜI duyệt từng mục; `unapproved` = đầu ra duyệt/dùng thiếu người;
    `unreviewed` (v15.2 P8.7) = đầu ra báo cáo/bảng/file KHÔNG có bước duyệt
    riêng mà chưa có NGƯỜI duyệt từng mục trên đúng sha nội dung hiện hành
    (sổ `output_reviews`). Mặc định 0 → fail-closed (không truyền bằng chứng
    = chưa đạt; riêng `unreviewed` mặc định 0 chỉ để caller cũ — `_facts`
    luôn truyền số thật)."""
    why = []
    if stage == "chay_thu":
        if days < TRIAL_DAYS:
            why.append(f"mới {days}/{TRIAL_DAYS} ngày làm việc chạy thử")
        if outputs is None:
            why.append(_NO_COUNT)
        else:
            if outputs < TRIAL_OUTPUTS:
                why.append(f"mới {outputs}/{TRIAL_OUTPUTS} đầu ra")
            if out_days < TRIAL_DAYS:
                why.append(f"đầu ra mới rải trên {out_days}/{TRIAL_DAYS} "
                           "ngày làm việc")
        return "co_nguoi_duyet", why
    if stage == "co_nguoi_duyet":
        if days < REVIEW_DAYS:
            why.append(f"mới {days}/{REVIEW_DAYS} ngày làm việc có người "
                       "duyệt")
        if outputs is None:
            why.append(_NO_COUNT)
        elif not outputs:
            why.append("chưa có đầu ra nào trong giai đoạn có người duyệt")
        elif human < 1:
            why.append("chưa có đầu ra nào được NGƯỜI duyệt từng mục "
                       "(không tính agent:/system:/auto_policy)")
        if unapproved:
            why.append(f"{unapproved} đầu ra được duyệt/dùng không có người "
                       "duyệt từng mục")
        if unreviewed:
            why.append(f"{unreviewed} đầu ra báo cáo/bảng/file chưa có NGƯỜI "
                       "duyệt từng mục trên đúng phiên bản nội dung (sinh ra "
                       "≠ đã duyệt — `--review-output`)")
        if severe:
            why.append(f"{severe} lỗi nghiêm trọng trong giai đoạn")
        return "van_hanh", why
    if stage == "tat":
        return "chay_thu", []
    return None, ["đã vận hành — không còn bước nâng"]


# ------------------------------------------------------------ cưỡng chế


# CHỈ test: tests/conftest.py đặt 'van_hanh' (test cũ giữ hành vi); test
# cưỡng chế đặt lại None. Production luôn None — không env/cờ nào đổi được.
_FORCE_MODE: str | None = None
FAIL_CLOSED = "chay_thu"
USABLE = ("co_nguoi_duyet", "van_hanh")


class RolloutBlocked(ValueError):
    """Biên sinh/quyết/dùng đầu ra bị chặn theo giai đoạn (HĐ 6.7)."""


def enforce_enabled(path: Path | None = None) -> bool:
    """Chỉ `"enforce": false` TƯỜNG MINH mới tắt; file lỗi/thiếu → bật."""
    try:
        cfg = json.loads(Path(path or CONFIG_FILE).read_bytes()
                         .decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return True
    return not (isinstance(cfg, dict) and cfg.get("enforce") is False)


def quick_mode() -> str | None:
    """Giai đoạn biết được KHÔNG cần DB (ép test / cưỡng chế tắt) | None."""
    if _FORCE_MODE is not None:
        return _FORCE_MODE
    return None if enforce_enabled() else "van_hanh"


def mode(conn, feature_id: str | None) -> str:
    """Giai đoạn hiện hành của tính năng — nguồn DUY NHẤT cho mọi biên.
    Chưa vào sổ / không thuộc tính năng nào / bảng thiếu / DB down →
    `chay_thu` (fail-closed). Đọc trong savepoint: lỗi không làm hỏng tx
    của conn chia sẻ."""
    q = quick_mode()
    if q is not None:
        return q
    if conn is None or not feature_id:
        return FAIL_CLOSED
    try:
        with conn.transaction():
            row = conn.execute("select stage from feature_rollout where"
                               " feature_id = %s", (feature_id,)).fetchone()
    except psycopg.Error:
        return FAIL_CLOSED
    return row[0] if row and row[0] in STAGES else FAIL_CLOSED


_cat_cache: tuple | None = None        # (path, mtime_ns, features)


def _catalog() -> list[dict] | None:
    global _cat_cache
    p = Path(FEATURES_FILE)
    try:
        mt = p.stat().st_mtime_ns
    except OSError:
        return None
    if _cat_cache and _cat_cache[:2] == (p, mt):
        return _cat_cache[2]
    try:
        feats = load_features(p)
    except ValueError:
        return None
    _cat_cache = (p, mt, feats)
    return feats


def _src_hit(src: dict, attrs: dict, skip=()) -> bool:
    return all(k == "rules_any" or k in skip or attrs.get(k) == v
               for k, v in src.items())


def feature_for(**attrs) -> str | None:
    """Tính năng sở hữu 1 đầu ra theo `output_sources` (key của nguồn là
    ràng buộc, key thiếu = mọi giá trị). 0 hoặc >1 mục khớp → None. Khối
    cũ ngoài BLOCKS (vd 'projects' trước v12.0) → khớp bỏ qua khối nếu duy
    nhất."""
    feats = _catalog() or []
    hits = {f["id"] for f in feats for s in f["output_sources"]
            if _src_hit(s, attrs)}
    if not hits and "block" in attrs and attrs["block"] not in BLOCKS:
        hits = {f["id"] for f in feats for s in f["output_sources"]
                if _src_hit(s, attrs, skip=("block",))}
    return next(iter(hits)) if len(hits) == 1 else None


def feature_for_report(name: str) -> str | None:
    """Báo cáo `data/reports/<tiền tố>…` → tính năng (tiền tố dài nhất)."""
    best = None
    for f in _catalog() or []:
        for s in f["output_sources"]:
            p = s.get("report")
            if p and str(name).startswith(p) and (
                    best is None or len(p) > len(best[0])):
                best = (p, f["id"])
    return best[1] if best else None


def _why(fid, md: str, what: str) -> str:
    return (f"{what}: tính năng {fid or '(không thuộc danh mục)'} đang "
            f"{STAGE_LABEL[md]} — HĐ 6.7/PL02 mục 1")


def check_generate(conn, fid: str | None, what: str) -> None:
    """Biên SINH: tính năng `tat` → RolloutBlocked. Chạy thử vẫn sinh
    (ghi nội bộ). Không thuộc danh mục → không chặn sinh (chặn ở biên dùng)."""
    if fid is not None and mode(conn, fid) == "tat":
        raise RolloutBlocked(_why(fid, "tat", what) + " — không sinh đầu ra")


def decide_reason(conn, fid: str | None, what: str) -> str | None:
    """Biên DUYỆT: mục của tính năng `tat` không được duyệt (kể cả mục đang
    chờ từ trước khi tắt). Từ chối vẫn được (dọn hàng)."""
    if fid is not None and mode(conn, fid) == "tat":
        return _why(fid, "tat", what) + " — không duyệt mục của tính năng tắt"
    return None


def use_reason(conn, fid: str | None, what: str,
               human_reviewed: bool) -> str | None:
    """Biên DÙNG (gửi khách / xuất / áp dụng / xếp lịch đăng) → lý do chặn
    | None. `chay_thu`/`tat` chặn; `co_nguoi_duyet` chỉ mục NGƯỜI duyệt từng
    mục; `van_hanh` theo duyệt sẵn có của biên (vẫn cổng người HĐ 6.7)."""
    md = mode(conn, fid)
    if md not in USABLE:
        return _why(fid, md, what) + " — đầu ra chỉ ghi nội bộ, không dùng"
    if md == "co_nguoi_duyet" and not human_reviewed:
        return (_why(fid, md, what) + " — mục chưa được NGƯỜI duyệt từng "
                "mục")
    return None


def report_stage(name: str) -> tuple[str | None, str | None]:
    """(tính năng, giai đoạn) của báo cáo file theo tiền tố — None khi không
    thuộc danh mục. Biết giai đoạn không cần DB → không mở DB; DB down →
    `chay_thu` (fail-closed)."""
    q = quick_mode()
    fid = feature_for_report(name)
    if fid is None:
        return None, None
    if q is not None:
        return fid, q
    conn = connect()
    try:
        return fid, mode(conn, fid)
    finally:
        if conn is not None:
            conn.close()


def gate_report(name: str) -> str | None:
    """Biên sinh báo cáo file: tiền tố thuộc tính năng `tat` →
    RolloutBlocked. → giai đoạn (None = không thuộc danh mục)."""
    fid, md = report_stage(name)
    if md == "tat":
        raise RolloutBlocked(_why(fid, "tat", f"báo cáo {name}")
                             + " — không sinh đầu ra")
    return md


# v15.2 (P8.5): báo cáo file của tính năng chưa cho dùng mang nhãn NGAY TRONG
# nội dung (không chỉ tên file) — bản bị chuyển tiếp vẫn đọc được trạng thái.
REPORT_LABELS = {
    "chay_thu": ("> **CHẠY THỬ — KHÔNG GỬI.** Tính năng {fid} đang chạy thử "
                 "nội bộ (HĐ 6.7, PL02 mục 1): báo cáo chỉ để kiểm tra, không"
                 " gửi/không dùng ra ngoài."),
    "co_nguoi_duyet": ("> **CHỜ NGƯỜI DUYỆT — CHƯA GỬI.** Tính năng {fid} "
                       "đang chạy có người duyệt: sinh ra ≠ đã duyệt; chỉ "
                       "dùng sau khi người được ủy quyền duyệt đúng phiên bản"
                       " này (`python -m pipelines.rollout --review-output`)."),
}


def label_report(name: str, text: str, md: str | None) -> str:
    """Chèn nhãn giai đoạn vào đầu báo cáo markdown (.md) của tính năng đang
    `chay_thu`/`co_nguoi_duyet`; file khác đuôi (csv/ics — sha phải khớp dữ
    liệu gốc) giữ nguyên."""
    lab = REPORT_LABELS.get(md)
    if lab is None or not str(name).endswith(".md"):
        return text
    fid = feature_for_report(name) or "?"
    return lab.format(fid=fid) + "\n\n" + (text or "")


# Nhãn MẪU chuẩn của báo cáo dựng trên dữ liệu mẫu ("(MẪU)" / "[MẪU]") —
# chỉ LOẠI THÊM khi caller chưa truyền cờ `sample` (fail-closed).
_REPORT_SAMPLE_RE = re.compile(r"[(\[]MẪU[)\]]")


def record_report(name: str, text: str, sample: bool | None = None) -> bool:
    """v14.3 (F04): báo cáo file của TÍNH NĂNG (tiền tố `output_sources.
    report`) → 1 dòng `report_outputs` (tên, sha256 nội dung, `is_sample` =
    cờ caller HOẶC nhãn MẪU trong bản) để bộ đếm đầu ra loại `report` đếm
    DISTINCT tên trong cửa sổ giai đoạn. → True khi đã ghi. Không thuộc
    danh mục / test ép giai đoạn (`_FORCE_MODE`) → False, không mở DB. DB
    down / login không có quyền → cảnh báo stderr, False (báo cáo vẫn ghi —
    chỉ là không được ĐẾM, fail-closed)."""
    if _FORCE_MODE is not None:
        return False
    fid = feature_for_report(name)
    if fid is None:
        return False
    is_sample = bool(sample) or bool(_REPORT_SAMPLE_RE.search(text or ""))
    sha = hashlib.sha256((text or "").encode("utf-8")).hexdigest()
    conn = connect()
    if conn is None:
        print(f"[warn] báo cáo {name}: DB không kết nối được — không ghi sổ "
              "đầu ra (không được đếm)", file=sys.stderr)
        return False
    try:
        with conn.transaction():
            conn.execute("insert into report_outputs (feature_id, name,"
                         " sha256, is_sample) values (%s, %s, %s, %s)",
                         (fid, name, sha, is_sample))
        conn.commit()
        return True
    except psycopg.Error as e:
        print(f"[warn] báo cáo {name}: không ghi được sổ đầu ra "
              f"({type(e).__name__}) — không được đếm", file=sys.stderr)
        return False
    finally:
        conn.close()


def is_human(name) -> bool:
    s = name.strip().casefold() if isinstance(name, str) else ""
    return bool(s) and not s.startswith(("agent:", "system:"))


def holiday_warning(path: Path | None = None) -> str | None:
    """Lịch nghỉ chưa chốt → cảnh báo (không bịa ngày nghỉ)."""
    try:
        hol = json.loads(Path(path or CONFIG_FILE).read_bytes()
                         .decode("utf-8")).get("holidays")
    except (OSError, UnicodeDecodeError, ValueError, AttributeError):
        hol = None
    if hol:
        return None
    return ("CẢNH BÁO: lịch nghỉ lễ/Tết chưa chốt (`data/rollout_config.json`"
            " holidays rỗng) — ngày làm việc đang tính T2–T6 kể cả ngày lễ;"
            " chờ Hành chính Sâm Sâm chốt, KHÔNG tự điền.")


# ------------------------------------------------------------ DB


# Người duyệt thật: không rỗng, không 'agent:'/'system:' (cùng luật check_by).
_HUMAN = ("(btrim(coalesce({c}, '')) <> '' and lower(btrim({c})) not like"
          " 'agent:%%' and lower(btrim({c})) not like 'system:%%')")
# Quy ước tên CŨ (trước cột cờ `is_sample` v14.3): object_id chứa từ
# 'sample'/'mau' đứng riêng, tiêu đề/brief có 'MẪU'. Chỉ LOẠI THÊM (dòng cũ
# chưa có cờ) — không bao giờ biến mẫu thành thật.
SAMPLE_ID_RE = r"(^|[^a-z0-9])(sample|mau)([^a-z0-9]|$)"


def _h(col: str) -> str:
    return _HUMAN.format(c=col)


# Mỗi bộ đếm → SQL trả từng dòng (khóa DISTINCT có tiền tố nguồn, thời điểm
# tạo đầu tiên trong cửa sổ, có NGƯỜI duyệt từng mục?, duyệt/dùng thiếu
# người?). Khóa trùng giữa 2 nguồn của CÙNG tính năng (vd ảnh nháp ↔
# `image_assets` của chính nháp đó) gộp 1 đầu ra.
_COUNTERS = {
    "approval_queue": (
        "select 'aq:' || block || '/' || object_type || '/' || object_id,"
        " min(created_at),"
        " bool_or(status = 'approved' and lane = 'per_item' and "
        + _h("decided_by") + "),"
        " bool_or(status = 'approved' and not (lane is not distinct from"
        " 'per_item' and " + _h("decided_by") + ")), null::text"
        " from approval_queue where block = %s and object_type = %s"
        " and (%s::text is null or created_by = %s)"
        " and created_at >= %s and created_at <= %s"
        " and coalesce(guardrail->>'ok', '') = 'true' and not is_sample"
        " and object_id !~* %s and title not like '%%MẪU%%'"
        " group by block, object_type, object_id",
        lambda s, a, b: (s["block"], s["object_type"], s.get("created_by"),
                         s.get("created_by"), a, b, SAMPLE_ID_RE)),
    "content_drafts": (
        "select 'cd:' || md5(text), min(created_at),"
        " bool_or(status = 'approved' and " + _h("reviewer")
        + "), bool_or(status = 'approved' and not " + _h("reviewer") + "),"
        " null::text from content_drafts where created_by = %s and content_type = %s"
        " and created_at >= %s and created_at <= %s"
        " and coalesce(guardrail->>'ok', '') = 'true'"
        " and coalesce(source, '') not ilike 'sample%%'"
        " and brief not like '%%MẪU%%' group by md5(text)",
        lambda s, a, b: (s["created_by"], s["content_type"], a, b)),
}

# v14.3 — bộ đếm bảng riêng: bảng → spec. `ts` thời điểm tạo, `key` khóa tự
# nhiên DISTINCT (ghi lại/nạp lại = 1), `sample` điều kiện MẪU theo cột
# provenance (None = bảng không có đường ghi mẫu — lý do ở `nosample`),
# `human`/`unapp` = có NGƯỜI quyết từng mục / quyết thiếu người (None =
# bảng không có bước người duyệt từng mục → đầu ra đếm được nhưng KHÔNG đủ
# bằng chứng người duyệt cho cổng co_nguoi_duyet → van_hanh), `where` lọc
# cố định, `filters` khóa danh mục → điều kiện (giá trị = tham số).
_SRC_SAMPLE = "coalesce(t.source, '') ilike 'sample%%'"
# v15.2 (P8.7): sha256 nội dung các dòng của 1 khóa (phiên bản để người
# duyệt gắn vào; dòng đổi → sha đổi → duyệt cũ hết hiệu lực).
_ROW_SHA = ("encode(sha256(convert_to(string_agg(row_to_json(t)::text,"
            " E'\\n' order by row_to_json(t)::text), 'UTF8')), 'hex')")
_LOT_SAMPLE = ("exists (select 1 from production_lots l where l.lot_code ="
               " t.lot_code and l.source = 'sample')")
_DRAFT_JOIN = "join content_drafts d on d.id = t.draft_id"
_DRAFT_OK = "coalesce(d.guardrail->>'ok', '') = 'true'"
_TABLES = {
    "decision_log": {
        "ts": "t.recorded_at", "key": "'dl:' || t.id",
        "where": "t.entry_kind = 'quyet_dinh'", "human": _h("t.recorded_by"),
        "nosample": "NGƯỜI ghi (--by, CHECK chặn agent/system)"},
    "audit_runs": {
        "ts": "t.created_at",
        "key": "'ar:' || t.kind || '/' || t.period_label || '/' "
               "|| t.report_sha256",
        "sample": "t.is_sample", "filters": {"kind": "t.kind = %s"}},
    "leads": {
        "ts": "t.created_at", "key": "'ld:' || t.dedup_key",
        "human": _h("t.assigned_by"),
        "nosample": "gom từ convlog thật / nhập tay (source conversations."
                    "jsonl|manual)"},
    "consents": {
        "ts": "t.ts", "key": "'cn:' || t.id", "human": _h("t.recorded_by"),
        "nosample": "NGƯỜI ghi bằng chứng đồng ý (evidence_ref)"},
    "image_assets": {
        "ts": "t.created_at", "key": "'cd:' || md5(d.text)",
        "join": _DRAFT_JOIN, "where": _DRAFT_OK,
        "sample": "coalesce(d.source, '') ilike 'sample%%'",
        "human": "d.status = 'approved' and " + _h("d.reviewer"),
        "unapp": "d.status = 'approved' and not " + _h("d.reviewer")},
    "video_assets": {
        "ts": "t.created_at", "key": "'cd:' || md5(d.text)",
        "join": _DRAFT_JOIN, "where": _DRAFT_OK,
        "sample": "coalesce(d.source, '') ilike 'sample%%'",
        "human": "d.status = 'approved' and " + _h("d.reviewer"),
        "unapp": "d.status = 'approved' and not " + _h("d.reviewer")},
    "channel_snapshots": {
        "ts": "t.captured_at",
        "key": "'cs:' || t.channel || '/' || t.metric_id || '/' || "
               "t.period_kind || '/' || t.period_start || '/' || t.source",
        "sample": "coalesce(t.source_ref, '') ilike 'sample:%%'",
        "human": _h("t.captured_by")},
    "red_alerts": {
        "ts": "t.ts",
        "key": "'ra:' || coalesce(t.detail->>'intel_item_id', t.id::text)",
        "where": "not (t.detail ? 'escalation_of')",
        "human": ("exists (select 1 from red_alert_acks k where k.alert_id"
                  " = t.id and " + _h("k.acked_by") + ")"),
        "nosample": "cảnh báo sinh từ tin thật đã thu",
        "filters": {"source_agent": "t.source_agent = %s",
                    "rules_any": "t.detail->'rules' ?| %s::text[]"}},
    "sim_runs": {
        "ts": "t.created_at", "key": "'sr:' || t.run_id",
        "sample": "t.dry_run"},
    "recon_results": {
        "ts": "t.reconciled_at", "key": "'rr:' || t.settlement_row_id",
        "nosample": "file quyết toán thật do kế toán xuất (settlement_rows "
                    "không có cột mẫu)"},
    "affiliate_attributions": {
        "ts": "t.updated_at",
        "key": "'aa:' || t.channel || '/' || t.order_id_hash || '/' || "
               "t.line_key",
        "nosample": "đơn sàn nạp từ file xuất Seller Center"},
    "allocation_proposals": {
        "ts": "t.created_at",
        "key": "'ap:' || t.cutoff_id || '/' || t.sku_key || '/' || t.channel",
        "sample": "t.is_sample",
        "human": "t.status = 'approved' and " + _h("t.decided_by"),
        "unapp": "t.status = 'approved' and not " + _h("t.decided_by")},
    "golden_discrepancies": {
        "ts": "t.created_at", "key": "'gd:' || t.id",
        "human": "t.status = 'resolved' and " + _h("t.resolved_by"),
        "unapp": "t.status = 'resolved' and not " + _h("t.resolved_by"),
        "nosample": "so golden master với dữ liệu sản phẩm đã nạp"},
    "production_lots": {
        "ts": "t.created_at", "key": "'pl:' || t.lot_code",
        "sample": "t.source = 'sample'",
        "human": "t.intake_status = 'passed' and " + _h("t.checked_by"),
        "unapp": "t.intake_status = 'passed' and not " + _h("t.checked_by")},
    "plot_logs": {
        "ts": "t.created_at", "key": "'lg:' || t.id", "sample": _SRC_SAMPLE,
        "human": _h("t.author"), "filters": {"source": "t.source = %s"}},
    "garden_voice_drafts": {
        "ts": "t.received_at", "key": "'gv:' || t.sha256",
        "human": "t.status = 'da_chep_loi' and " + _h("t.closed_by"),
        "nosample": "ghi âm nhân viên gửi qua Zalo"},
    "lot_origins": {
        "ts": "t.linked_at", "key": "'lo:' || t.lot_code || '/' || "
                                    "t.plot_log_id",
        "sample": _LOT_SAMPLE, "human": _h("t.linked_by"),
        "unapp": "not " + _h("t.linked_by")},
    "qr_codes": {
        "ts": "t.issued_at", "key": "'qr:' || t.code", "sample": _LOT_SAMPLE,
        "human": _h("t.issued_by"), "unapp": "not " + _h("t.issued_by")},
    "garden_media": {
        "ts": "t.created_at", "key": "'gm:' || t.sha256",
        "human": _h("t.author"),
        "nosample": "ảnh/video nhân viên nạp (gỡ EXIF), không có lô mẫu"},
    "documents": {
        "ts": "t.created_at", "key": "'dc:' || t.sha256",
        "human": "t.status = 'verified' and " + _h("t.verified_by"),
        "unapp": "t.status = 'verified' and not " + _h("t.verified_by"),
        "nosample": "bản scan/PDF gốc do người đưa vào thư mục intake"},
    "document_fields": {
        "ts": "d.created_at", "key": "'df:' || t.sha256 || '/' || t.field",
        "join": "join documents d on d.sha256 = t.sha256",
        "human": ("t.verified and d.status = 'verified' and "
                  + _h("d.verified_by")),
        "nosample": "trích từ tài liệu gốc (documents)"},
    "chunks": {
        "ts": "t.ingested_at", "key": "'ck:' || t.doc_id",
        "nosample": "KB công khai crawl từ site công ty"},
    "chunks_internal": {
        "ts": "t.ingested_at",
        "key": "'ci:' || t.collection || '/' || t.doc_id",
        "human": _h("t.approved_by"),
        "nosample": "tài liệu nội bộ trưởng phòng duyệt (approved_by)"},
    "market_snapshots": {
        "ts": "t.imported_at", "key": "'ms:' || t.file_sha256",
        "nosample": "file xuất Seller Center (bảng không có cột mẫu)"},
    "eval_runs": {
        "ts": "t.ts",
        "key": "'ev:' || t.agent || '/' || t.commit_sha || '/' || "
               "coalesce(t.suite_sha256, '')",
        "nosample": "lần chạy bộ ca kiểm thử (không phải dữ liệu khách)"},
    "anchor_batches": {
        "ts": "t.created_at", "key": "'ab:' || t.manifest_sha256",
        "human": _h("t.created_by"),
        "nosample": "`anchor --build` loại sẵn lô/khoảnh mẫu khỏi lá"},
    "revenue_quarters": {
        "ts": "t.recorded_at",
        "key": "'rq:' || t.quarter || '/' || t.report_sha256",
        "human": _h("t.recorded_by"),
        "nosample": "số quyết toán thật (rev_share không nhận file mẫu)"},
    "feature_rollout_events": {
        # `seed` = vào sổ hàng loạt (1 lệnh → N dòng), không phải đầu ra.
        "ts": "t.ts", "key": "'fe:' || t.id", "where": "t.kind <> 'seed'",
        "human": _h("t.by_person"),
        "nosample": "NGƯỜI ghi sổ triển khai"},
    "san_suggestions": {
        "ts": "t.created_at",
        "key": "'ss:' || t.channel || '/' || t.msg_ref",
        "where": "t.guardrail_ok",
        "human": ("exists (select 1 from san_suggestion_uses u where"
                  " u.suggestion_id = t.id and " + _h("u.used_by") + ")"),
        "nosample": "tin buyer thật MXH dán qua STDIN"},
    # v15 fix P8.7c: bằng chứng đầu ra nguồn FILE do ĐƯỜNG DỊCH VỤ ghi vào
    # DB (backup → `scripts/db_backup.py` login svc_backup qua function
    # `file_output_evidence_backup`; khóa + sha DB tự tính từ bản ghi). Thời
    # điểm = `captured_at` (đồng hồ DB); phiên bản hiện hành = bản ghi MỚI
    # NHẤT của khóa (như báo cáo); mẫu theo `is_sample`. Không có bước người
    # riêng → cần sổ `output_reviews`.
    "file_output_evidence": {
        "ts": "t.captured_at", "key": "t.output_key",
        "sample": "t.is_sample",
        "sha": ("(array_agg(t.content_sha256 order by t.captured_at desc,"
                " t.id desc))[1]"),
        "filters": {"source": "t.nguon = %s"}},
}
# v15.2 (P8.7): cột 5 = sha256 phiên bản MỚI NHẤT của báo cáo (người duyệt
# gắn với đúng phiên bản; ghi lại nội dung khác → duyệt cũ hết hiệu lực).
_REPORT_SQL = (
    "select 'rp:' || name, min(created_at), false, false,"
    " (array_agg(sha256 order by created_at desc, id desc))[1]"
    " from report_outputs"
    " where feature_id = %s and left(name, length(%s)) = %s"
    " and created_at >= %s and created_at <= %s and not is_sample"
    " group by name")


def _table_sql(src: dict, a, b) -> tuple[str, tuple] | None:
    """SQL đếm 1 nguồn bảng riêng | None (bảng chưa có bộ đếm)."""
    spec = _TABLES.get(src.get("table"))
    if spec is None:
        return None
    conds, params = [f"{spec['ts']} >= %s", f"{spec['ts']} <= %s"], [a, b]
    if spec.get("where"):
        conds.append(f"({spec['where']})")
    if spec.get("sample"):
        conds.append(f"not coalesce(({spec['sample']}), false)")
    for k, cond in spec.get("filters", {}).items():
        if k in src:
            conds.append(cond)
            params.append(src[k])
    sql = (f"select {spec['key']}, min({spec['ts']}),"
           f" bool_or(coalesce(({spec.get('human') or 'false'}), false)),"
           f" bool_or(coalesce(({spec.get('unapp') or 'false'}), false)),"
           f" {spec.get('sha', _ROW_SHA)}"
           f" from {src['table']} t {spec.get('join', '')}"
           f" where {' and '.join(conds)} group by 1")
    return sql, tuple(params)


def _source_sql(f: dict, s: dict, a, b) -> tuple[str, tuple] | None:
    c = _COUNTERS.get(s.get("table"))
    if c is not None:
        return c[0], c[1](s, a, b)
    if "report" in s:
        return _REPORT_SQL, (f["id"], s["report"], s["report"], a, b)
    if "table" in s:
        return _table_sql(s, a, b)
    return None                      # `file`: đọc ở `_file_rows`


_PH_RE = re.compile(r"%%|%s")
_WIN_A, _WIN_B = object(), object()     # chỗ cửa sổ [since, now] → $1/$2


def _db_sql(f: dict, s: dict) -> str | None:
    """Vá review v15 (P8.7/P10.1): câu đếm 1 nguồn ở dạng DB tự chạy được —
    CHÍNH câu `_source_sql` Python chạy, cửa sổ thành `$1`/`$2`, tham số khác
    thành literal (thay đúng ngữ nghĩa placeholder psycopg: `%%` → `%`)."""
    q = _source_sql(f, s, _WIN_A, _WIN_B)
    if q is None:
        return None
    it = iter(q[1])

    def sub(m):
        if m.group() == "%%":
            return "%"
        p = next(it)
        return ("$1" if p is _WIN_A else "$2" if p is _WIN_B
                else pgsql.Literal(p).as_string())
    out = _PH_RE.sub(sub, q[0])
    if next(it, _WIN_A) is not _WIN_A:
        raise ValueError(f"{f['id']}: số tham số câu đếm lệch")
    return out


def count_spec(f: dict, shift) -> dict:
    """Bộ đếm đầu ra ghi vào sổ DB (`feature_rollout.count_spec`, đường
    OWNER `--seed`) để `rollout_transition_human` TỰ đếm lại, không tin số
    caller khai: câu SQL từng nguồn bảng/báo cáo + cờ cần duyệt qua
    `output_reviews` + lịch ngày làm việc. Nguồn file (DB không đọc được
    file máy chủ ứng dụng) chỉ đếm số lượng — runbook 9.7."""
    sh = period.parse_shift(shift)
    qs, files = [], 0
    for s in f.get("output_sources") or []:
        if "file" in s:
            files += s["file"] in _FILES
            continue
        q = _db_sql(f, s)
        if q is not None:
            qs.append({"q": q, "review": _needs_review(s)})
    return {"sql": qs, "file": files, "workdays": sorted(sh["workdays"]),
            "holidays": sorted(d.isoformat() for d in sh["holidays"])}


def _needs_review(s: dict) -> bool:
    """v15.2 (P8.7): nguồn KHÔNG có bước người duyệt từng mục riêng (báo cáo
    file, bảng `_TABLES` không có `human`, file nhật ký không gửi khách) →
    đầu ra chỉ có bằng chứng người duyệt qua sổ `output_reviews`."""
    if "report" in s:
        return True
    if "file" in s:
        return bool(_FILES.get(s["file"], {}).get("review"))
    spec = _TABLES.get(s.get("table"))
    return spec is not None and not spec.get("human")


def _src_label(s: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in s.items() if k != "rules_any")


# ------------------------------------------------ v15.2 (P8.1) nguồn file

class _Unreadable(Exception):
    """Nguồn file không đọc được (thiếu/chưa cấu hình/lỗi IO) → uncounted."""


def _aware(v) -> datetime | None:
    """ISO 8601 có múi giờ ('Z' nhận) → datetime aware | None."""
    if not isinstance(v, str):
        return None
    try:
        ts = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo is not None else None


def _rec_sha(rec: dict) -> str:
    return hashlib.sha256(json.dumps(rec, sort_keys=True, ensure_ascii=False)
                          .encode("utf-8")).hexdigest()


# v15 fix P8.1: cờ mẫu trên dòng convlog — có mặt với giá trị khác
# None/False → không bao giờ là đầu ra thật (dù provenance ghi "live").
_CONV_SAMPLE_FLAGS = ("is_sample", "dry_run", "replay", "mock", "test")


def _conv_row(rec: dict):
    """convlog (sales-01) → đầu ra = câu bot ĐÃ GỬI tới khách thật (kênh
    zalo/messenger, `answered` True, `sent` True, guardrail đạt, có msg_id
    để DISTINCT). Streamlit (demo nội bộ), handoff/chuyển người, gợi ý giữ
    lại do chạy thử (đã đếm ở hàng duyệt `cskh_reply`), gửi lỗi → không phải
    đầu ra. Câu bot gửi KHÔNG có người duyệt từng mục → `una` (dùng thiếu
    người — chặn cổng co_nguoi_duyet → van_hanh). → (key, ts) | None |
    'bad' (đầu ra mà ts hỏng) | ('legacy', ts).
    v15 fix P8.1 — provenance BẮT BUỘC, đặt TỪ NƠI GHI (`connectors.zalo.
    _provenance`): chỉ `provenance == "live"` (câu gửi bằng transport kênh
    thật đã đăng ký) và không cờ mẫu (`_CONV_SAMPLE_FLAGS`) mới là đầu ra.
    Mock (`scripts/zalo_mock.py`), replay/test (transport giả), Streamlit
    ("demo"), provenance lạ/khác kiểu → None. Bản ghi CŨ thiếu trường
    provenance mà trông như đầu ra → `('legacy', ts)`: KHÔNG công nhận là
    thật (không suy ngược từ answered/sent/guardrail hay msg_id), chỉ báo ở
    `uncounted` để người vận hành biết; ts hỏng → None (không thành 'bad'
    của dòng thật)."""
    ch, mid = rec.get("channel"), rec.get("msg_id")
    if not (ch in ("zalo", "messenger") and rec.get("answered") is True
            and rec.get("sent") is True and rec.get("guardrail_ok") is True
            and isinstance(mid, str) and mid.strip()):
        return None
    if "provenance" not in rec:
        ts = _aware(rec.get("ts"))
        return None if ts is None else ("legacy", ts)
    if rec.get("provenance") != "live" or any(
            rec.get(k) not in (None, False) for k in _CONV_SAMPLE_FLAGS):
        return None
    ts = _aware(rec.get("ts"))
    return "bad" if ts is None else (f"cv:{ch}/{mid.strip()}", ts)


_DUMP_RE = re.compile(r"[A-Za-z0-9_.-]+_\d{8}_\d{6}_vn\.dump(\.enc)?")


def _backup_row(rec: dict):
    """backup_runs (data_platform-07.2) → đầu ra = lần backup `ok` có file
    dump đúng khuôn tên + sha256 (DISTINCT theo sha bản dump: ghi lại cùng
    bản = 1). Lần fail / thiếu sha / tên lạ / `.partial` → không phải đầu
    ra."""
    sha, fn = rec.get("sha256"), rec.get("file")
    if not (rec.get("status") == "ok" and isinstance(sha, str)
            and re.fullmatch(r"[0-9a-f]{64}", sha) and isinstance(fn, str)
            and _DUMP_RE.fullmatch(Path(fn).name)):
        return None
    ts = _aware(rec.get("ts"))
    return "bad" if ts is None else (f"bk:{sha}", ts)


def _backup_paths() -> list[Path]:
    d = (os.environ.get("BACKUP_DIR") or "").strip()
    if not d:
        raise _Unreadable("BACKUP_DIR chưa cấu hình")
    return [Path(d) / "backup_runs.jsonl"]


DATA_DIR = ROOT / "data"
# file → (đường dẫn [bắt buộc cuối, phụ trước], hàm dòng, `una` (dùng thiếu
# người), `review` (cần sổ output_reviews)).
_FILES = {
    "conversations.jsonl": {
        "paths": lambda: [DATA_DIR / "conversations.jsonl.1",
                          DATA_DIR / "conversations.jsonl"],
        "row": _conv_row, "una": True, "review": False},
    "backup_runs.jsonl": {
        "paths": _backup_paths, "row": _backup_row, "una": False,
        "review": True},
}


def _file_rows(s: dict, a, b) -> tuple[list, int, int]:
    """Đọc nguồn file → ([(key, ts, hum, una, sha)], số dòng hỏng, số dòng
    cũ thiếu provenance trong cửa sổ — v15 fix P8.1, không tính). Đọc
    BYTES + split `\\n` (không splitlines — U+2028 trong câu khách). File
    CHÍNH thiếu / lỗi IO → `_Unreadable` (nguồn không đếm, không phải 0 đầu
    ra); file phụ (`.1` xoay vòng) thiếu → bỏ qua. Dòng không phải JSON
    object / đầu ra có ts hỏng → đếm `bad`, KHÔNG thành đầu ra."""
    spec = _FILES.get(s.get("file"))
    if spec is None:
        raise _Unreadable("chưa có bộ đếm")
    paths = spec["paths"]()
    out, bad, legacy = {}, 0, 0
    for i, p in enumerate(paths):
        try:
            raw = Path(p).read_bytes()
        except FileNotFoundError:
            if i == len(paths) - 1:
                raise _Unreadable("không có file") from None
            continue
        except OSError as e:
            raise _Unreadable(f"lỗi đọc {type(e).__name__}") from None
        for line in raw.split(b"\n"):
            if not line.strip():
                continue
            try:
                rec = json.loads(line.decode("utf-8"))
            except ValueError:          # gồm UnicodeDecodeError
                bad += 1
                continue
            if not isinstance(rec, dict):
                bad += 1
                continue
            got = spec["row"](rec)
            if got is None:
                continue
            if got == "bad":
                bad += 1
                continue
            if got[0] == "legacy":
                legacy += a <= got[1] <= b
                continue
            key, ts = got
            if not a <= ts <= b:
                continue
            sha = _rec_sha(rec)
            o = out.get(key)
            if o is None or ts < o[0]:   # trùng khóa (ghi lại/xoay vòng) = 1
                out[key] = (ts, sha)
    return ([(k, ts, False, spec["una"], sha)
             for k, (ts, sha) in out.items()], bad, legacy)


# ------------------------------------------- v15.2 (P8.7) duyệt từng đầu ra

def _reviews(conn, fid: str) -> dict:
    """{(output_key, sha): (quyết định, người)} — quyết định MỚI NHẤT mỗi
    phiên bản nội dung. Bảng thiếu / không có quyền đọc → {} (fail-closed:
    chưa ai duyệt)."""
    try:
        with conn.transaction():
            rows = conn.execute(
                "select distinct on (output_key, content_sha256) output_key,"
                " content_sha256, decision, reviewed_by from output_reviews"
                " where feature_id = %s order by output_key, content_sha256,"
                " ts desc, id desc", (fid,)).fetchall()
    except psycopg.Error:
        return {}
    return {(k, h): (d, by) for k, h, d, by in rows}


def output_rows(conn, f: dict, since, now) -> tuple[dict, bool, list]:
    """Từng đầu ra DISTINCT của tính năng trong [since, now] → ({key: {ts,
    human, unapproved, sha, needs_review, review}}, đếm được?, uncounted).
    Mỗi nguồn đọc trong savepoint: lỗi (bảng thiếu, login không có quyền
    đọc) → nguồn đó vào `uncounted`, không làm hỏng tx của conn chia sẻ
    (fail-closed: thiếu nguồn = ít đầu ra hơn, không bao giờ nhiều hơn)."""
    merged, counted, uncounted = {}, False, []
    for s in f.get("output_sources") or []:
        if "file" in s:
            try:
                got, bad, legacy = _file_rows(s, since, now)
            except _Unreadable as e:
                uncounted.append(f"{_src_label(s)} (không đọc được: {e})")
                continue
            if bad:
                uncounted.append(f"{_src_label(s)} ({bad} dòng hỏng — bỏ "
                                 "qua, không đếm)")
            if legacy:
                uncounted.append(f"{_src_label(s)} ({legacy} dòng thiếu "
                                 "provenance — bản ghi cũ, không công nhận "
                                 "là đầu ra thật)")
        else:
            q = _source_sql(f, s, since, now)
            if q is None:
                uncounted.append(_src_label(s))
                continue
            try:
                with conn.transaction():
                    got = conn.execute(*q).fetchall()
            except psycopg.Error as e:
                uncounted.append(f"{_src_label(s)} (không đọc được: "
                                 f"{type(e).__name__})")
                continue
        counted = True
        need = _needs_review(s)
        for key, ts, hum, una, sha in got:
            o = merged.get(key)
            if o is None:
                merged[key] = {"ts": ts, "human": bool(hum),
                               "unapproved": bool(una), "sha": sha,
                               "needs_review": need, "review": None}
            else:       # khóa trùng giữa 2 nguồn cùng tính năng = 1 đầu ra
                o.update(ts=min(o["ts"], ts), human=o["human"] or bool(hum),
                         unapproved=o["unapproved"] or bool(una),
                         sha=o["sha"] or sha,
                         needs_review=o["needs_review"] and need)
    if any(o["needs_review"] for o in merged.values()):
        rev = _reviews(conn, f["id"])
        for key, o in merged.items():
            if not o["needs_review"]:
                continue
            r = rev.get((key, o["sha"]))
            o["review"] = r
            if r and r[0] == "approved" and is_human(r[1]):
                o["human"] = True
    return merged, counted, uncounted


def output_facts(conn, f: dict, since, now, shift) -> dict:
    """Đầu ra THẬT của đúng tính năng trong [since, now] (F04) →
    {outputs (None = không đếm được), out_days, human, unapproved,
    unreviewed, uncounted: [nguồn chưa có bộ đếm / không đọc được / dòng
    hỏng]}. `unreviewed` (P8.7) = đầu ra cần duyệt qua `output_reviews` mà
    phiên bản hiện hành chưa có quyết định NGƯỜI."""
    merged, counted, uncounted = output_rows(conn, f, since, now)
    rows = list(merged.values())
    sh = period.parse_shift(shift)
    days = {d for d in (period.vn_date(r["ts"]) for r in rows)
            if d.weekday() in sh["workdays"] and d not in sh["holidays"]}
    return {"outputs": len(rows) if counted else None,
            "out_days": len(days),
            "human": sum(1 for r in rows if r["human"]),
            "unapproved": sum(1 for r in rows if r["unapproved"]),
            "unreviewed": sum(1 for r in rows if r["needs_review"]
                              and r["review"] is None),
            "uncounted": uncounted}


def _count_severe(conn, fid: str, since) -> int:
    return conn.execute(
        "select count(*) from feature_rollout_events where feature_id = %s"
        " and kind = 'severe' and ts >= %s", (fid, since)).fetchone()[0]


def _facts(conn, f: dict, stage: str, since, now, shift) -> dict:
    days = business_days(since, now, shift)
    o = output_facts(conn, f, since, now, shift)
    severe = _count_severe(conn, f["id"], since)
    target, why = evaluate(stage, days, o["outputs"], severe, o["out_days"],
                           o["human"], o["unapproved"], o["unreviewed"])
    return {"days": days, **o, "severe": severe, "target": target,
            "why": why}


def _event(conn, fid, kind, frm, to, by, now, *, code=None, note=None,
           evidence=None):
    conn.execute(
        "insert into feature_rollout_events (ts, feature_id, kind,"
        " from_stage, to_stage, severe_code, note, evidence, by_person)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (now, fid, kind, frm, to, code, note, Jsonb(evidence or {}), by))


def _transition(conn, fid, kind, frm, to, by, now, *, code=None, note=None,
                evidence=None):
    """v15.4 (P10.1): nâng/lùi/tắt giai đoạn qua function SECURITY DEFINER
    `rollout_transition_human` — DB khóa dòng, kiểm lại giai đoạn hiện hành
    = `frm` (đổi giữa chừng → từ chối), chuyển hợp lệ, danh tính theo login
    (khối = tiền tố mã tính năng), ghi sự kiện + log. Login người (app_human)
    KHÔNG có UPDATE/INSERT trực tiếp sổ triển khai."""
    from pipelines import auth  # lười: auth → director → rollout
    try:
        auth.call_human(
            conn, "select rollout_transition_human(%s, %s, %s, %s, %s, %s,"
            " %s, %s, %s)", (fid, kind, frm, to, by, code, note,
                             Jsonb(evidence or {}), now),
            by=by, block=fid.split("-")[0], action=kind,
            object_type="feature_rollout", object_id=fid)
    except ValueError as e:
        raise RolloutError(str(e)) from None


def _locked(conn, fid: str):
    """Giai đoạn hiện hành (CHỈ ĐỌC — khóa dòng nằm trong function ghi)."""
    row = conn.execute("select stage, stage_since from feature_rollout"
                       " where feature_id = %s", (fid,)).fetchone()
    if row is None:
        raise RolloutError(f"{fid}: chưa vào sổ triển khai (chạy --seed)")
    return row


def _now(now):
    return now if now is not None else datetime.now(VN_TZ)


def seed(conn, feats: list[dict], by: str, now=None, shift=None) -> dict:
    """Đưa tính năng `co_code` chưa có vào `chay_thu` (bắt đầu đếm). Có rồi
    → giữ nguyên (không reset mốc). Idempotent.

    Vá review v15: ghi kèm bộ đếm `count_spec` vào sổ (đường OWNER —
    app_human/svc không ghi được `feature_rollout`) để function chuyển giai
    đoạn TỰ đếm lại đầu ra trong DB, không tin số đếm caller truyền. Dòng có
    sẵn: chỉ đồng bộ lại bộ đếm khi đổi (giai đoạn/mốc giữ nguyên) — đổi
    `output_sources`/bộ đếm/lịch ngày làm việc thì owner chạy lại `--seed`."""
    by, now = check_by(by), _now(now)
    shift = load_shift(CONFIG_FILE) if shift is None else shift
    st = {"inserted": 0, "existing": 0, "skipped": 0}
    with conn.transaction():
        for f in feats:
            if f["code_status"] != "co_code":
                st["skipped"] += 1
                continue
            stage, ev = "chay_thu", None
            if f.get("nhom_goc"):           # mục tách: mốc MỚI, không kế thừa
                g = conn.execute("select stage from feature_rollout where"
                                 " feature_id = %s", (f["nhom_goc"],)
                                 ).fetchone()
                ev = {"nhom_goc": f["nhom_goc"],
                      "stage_nhom_goc": g[0] if g else None}
                if g and g[0] == "tat":     # nhóm đã tắt → không tự bật lại
                    stage = "tat"
            row = conn.execute(
                "insert into feature_rollout (feature_id, stage, stage_since,"
                " updated_by, updated_at, count_spec) values (%s, %s, %s,"
                " %s, %s, %s) on conflict (feature_id) do update set"
                " count_spec = excluded.count_spec where"
                " feature_rollout.count_spec is distinct from"
                " excluded.count_spec returning (xmax = 0)",
                (f["id"], stage, now, by, now,
                 Jsonb(count_spec(f, shift)))).fetchone()
            if row is not None and row[0]:
                _event(conn, f["id"], "seed", None, stage, by, now,
                       evidence=ev)
                st["inserted"] += 1
            else:
                st["existing"] += 1
    conn.commit()           # transaction() trên conn đã mở tx = savepoint
    return st


def promote(conn, feats, fid: str, by: str, shift, now=None) -> dict:
    """Nâng 1 bước nếu đủ cổng → {from, to, facts}. Chưa đủ → RolloutError
    (không ghi gì)."""
    by, now = check_by(by), _now(now)
    f = _feature(feats, fid)
    if f["code_status"] != "co_code":
        raise RolloutError(f"{fid}: code_status={f['code_status']}"
                           " — chưa đủ code để triển khai (chỉ co_code)")
    with conn.transaction():
        stage, since = _locked(conn, fid)
        facts = _facts(conn, f, stage, since, now, shift)
        if facts["target"] is None or facts["why"]:
            raise RolloutError(f"{fid} ({STAGE_LABEL[stage]}) chưa đủ cổng: "
                               + "; ".join(facts["why"]))
        _transition(conn, fid, "promote", stage, facts["target"], by, now,
                    evidence={k: facts[k] for k in (
                        "days", "outputs", "out_days", "human", "unapproved",
                        "unreviewed", "severe")}
                    | {"since": since.isoformat()})
    conn.commit()
    return {"from": stage, "to": facts["target"], "facts": facts}


def record_severe(conn, fid: str, code: str, by: str, note=None,
                  now=None) -> dict:
    """Ghi lỗi nghiêm trọng PL02 mục 2 → lùi về `chay_thu` (mốc đếm lại);
    đang `tat` thì giữ `tat`."""
    by, now = check_by(by), _now(now)
    if code not in SEVERE:
        raise ValueError(f"--reason phải ∈ {sorted(SEVERE)}")
    with conn.transaction():
        stage, _ = _locked(conn, fid)
        to = "tat" if stage == "tat" else "chay_thu"
        # về chạy thử, đếm lại từ đầu (đang tắt → giữ tắt)
        _transition(conn, fid, "severe", stage, to, by, now, code=code,
                    note=_clean_note(note))
    conn.commit()
    return {"from": stage, "to": to}


def disable(conn, fid: str, by: str, note=None, now=None) -> dict:
    by, now = check_by(by), _now(now)
    with conn.transaction():
        stage, _ = _locked(conn, fid)
        if stage == "tat":
            raise RolloutError(f"{fid}: đã tắt")
        _transition(conn, fid, "disable", stage, "tat", by, now,
                    note=_clean_note(note))
    conn.commit()
    return {"from": stage, "to": "tat"}


DECISIONS = ("approved", "rejected")
_SHA_RE = re.compile(r"[0-9a-f]{64}")


_PENDING_FN = "output_pending_human(text, text)"


def _db_listing(conn) -> bool:
    """v15 fix P8.7b: login NGƯỜI (không superuser/owner, có EXECUTE
    `output_pending_human`) → liệt kê/kiểm sớm đầu ra cần duyệt qua function
    DB — app_human KHÔNG có SELECT bảng nguồn (đọc thẳng = "nguồn chưa đọc
    được"). Owner/dev, login dịch vụ, schema chưa có function → bộ đếm
    Python như cũ."""
    from pipelines import auth  # lười: auth → director → rollout
    if auth.privileged_login(conn) is not None:
        return False
    try:
        with conn.transaction():
            return bool(conn.execute(
                "select has_function_privilege(%s, 'EXECUTE')",
                (_PENDING_FN,)).fetchone()[0])
    except psycopg.Error:
        return False


def _pending_db(conn, fid: str, by, action: str) -> list[dict]:
    """Đầu ra cần duyệt qua sổ theo bộ đếm DB (`output_pending_human` — CÙNG
    `count_spec` mà `output_review_human` kiểm; cửa sổ = giai đoạn hiện hành
    tới đồng hồ DB; chỉ khóa/sha/quyết định, không nội dung bảng nguồn) →
    [{key, ts, sha, review}]. DB từ chối danh tính/khối (42501) →
    `authz_denied` + RolloutError; chưa vào sổ / chưa có bộ đếm →
    RolloutError. `by` None = người của chính login."""
    from pipelines import auth  # lười: auth → director → rollout
    try:
        with conn.transaction():
            rows = auth.call_human(
                conn, "select o_key, o_ts, o_sha, o_quyet_dinh,"
                " o_nguoi_duyet from output_pending_human(%s, %s)",
                (fid, by), by=by or "", block=fid.split("-")[0],
                action=action, object_type="output_review",
                object_id=fid).fetchall()
    except ValueError as e:
        raise RolloutError(str(e)) from None
    return [{"key": k, "ts": ts, "sha": h,
             "review": (d, who) if d is not None else None}
            for k, ts, h, d, who in rows]


def _file_note(f: dict) -> str:
    fs = [s["file"] for s in f.get("output_sources") or []
          if "file" in s and _needs_review(s)]
    return (f" — nguồn file ({', '.join(fs)}) trên máy ứng dụng DB không đọc"
            " được, CHƯA có bản chụp tin cậy trong DB: không duyệt nguồn"
            " file qua sổ này" if fs else "")


def pending_outputs(conn, feats, fid: str, now=None, by=None) -> list[dict]:
    """Đầu ra trong cửa sổ giai đoạn hiện hành của tính năng cần duyệt qua
    `output_reviews` → [{key, ts, sha, review}] (cũ trước). Chỉ đọc.
    v15 fix P8.7b: login người → bộ đếm DB `output_pending_human` (danh
    tính/khối theo login; `by` = người khai, None = người của login; nguồn
    file không liệt kê — DB không duyệt được), không đọc bảng nguồn."""
    now = _now(now)
    f = _feature(feats, fid)
    if _db_listing(conn):
        rows = _pending_db(conn, fid, by, "list")
        conn.commit()
        return rows
    _, since = _locked(conn, fid)
    merged, _, _ = output_rows(conn, f, since, now)
    conn.commit()           # đóng tx đọc (conn chia sẻ)
    return [{"key": k, "ts": o["ts"], "sha": o["sha"], "review": o["review"]}
            for k, o in sorted(merged.items(), key=lambda x: (x[1]["ts"],
                                                              x[0]))
            if o["needs_review"]]


def review_output(conn, feats, fid: str, key: str, sha: str, decision: str,
                  by: str, note=None, now=None) -> int:
    """v15.2 (P8.7): NGƯỜI duyệt 1 đầu ra trên đúng phiên bản nội dung →
    id dòng `output_reviews`. Đọc lại bộ đếm: khóa phải là đầu ra của ĐÚNG
    tính năng trong giai đoạn hiện hành, cần duyệt (báo cáo/bảng/file không
    có bước người riêng) và `sha` = phiên bản hiện hành — lệch → RolloutError
    (không ghi). Ghi qua function `output_review_human` (danh tính theo
    login, append-only). v15 fix P8.7: kiểm ở đây chỉ để báo lỗi sớm — DB TỰ
    kiểm lại khóa/nguồn/mẫu/sha phiên bản hiện hành bằng bộ đếm `count_spec`
    (không tin key/sha caller truyền); khóa nguồn FILE (convlog/backup_runs)
    DB chưa có bản chụp tin cậy → DB từ chối (RolloutError kèm lý do).
    v15 fix P8.7b: login người (app_human — không SELECT bảng nguồn) → kiểm
    sớm bằng bộ đếm DB `output_pending_human` thay vì đọc bảng nguồn."""
    by, now = check_by(by), _now(now)
    if decision not in DECISIONS:
        raise ValueError(f"--decision phải ∈ {DECISIONS}")
    if not isinstance(sha, str) or not _SHA_RE.fullmatch(sha):
        raise ValueError("--sha phải là sha256 hex 64 ký tự")
    f = _feature(feats, fid)
    act = "approve" if decision == "approved" else "reject"
    with conn.transaction():
        if _db_listing(conn):
            o = next((r for r in _pending_db(conn, fid, by, act)
                      if r["key"] == key), None)
            if o is None:
                raise RolloutError(
                    f"{fid}: '{_oneline(str(key), 80)}' không phải đầu ra "
                    "nguồn bảng/báo cáo cần duyệt qua sổ này của tính năng "
                    "trong giai đoạn hiện hành (khóa không tồn tại / sai tính"
                    " năng hoặc nguồn / mẫu / có bước duyệt riêng)"
                    + _file_note(f))
        else:
            _, since = _locked(conn, fid)
            merged, _, unc = output_rows(conn, f, since, now)
            o = merged.get(key)
            if o is None:
                raise RolloutError(
                    f"{fid}: '{_oneline(str(key), 80)}' không phải đầu ra của"
                    " tính năng trong giai đoạn hiện hành"
                    + (f" (nguồn chưa đọc được: {'; '.join(unc)})" if unc
                       else ""))
            if not o["needs_review"]:
                raise RolloutError(f"{fid}: đầu ra {key} có bước duyệt riêng"
                                   " (hàng duyệt/nháp) — duyệt ở đó")
        if o["sha"] != sha:
            raise RolloutError(f"{fid}: sha không khớp phiên bản hiện hành "
                               f"của {key} — nội dung đã đổi, đọc lại "
                               "(`--outputs`) rồi duyệt")
        from pipelines import auth  # lười: auth → director → rollout
        try:
            row = auth.call_human(
                conn, "select output_review_human(%s, %s, %s, %s, %s, %s)",
                (fid, key, sha, decision, by, _clean_note(note)), by=by,
                block=fid.split("-")[0],
                action=act,
                object_type="output_review", object_id=f"{fid}:{key}"
            ).fetchone()
        except ValueError as e:
            raise RolloutError(str(e)) from None
    conn.commit()
    return row[0]


def status_rows(conn, feats, shift, now=None) -> list[dict]:
    """Mỗi tính năng danh mục + trạng thái sổ (None = chưa vào sổ)."""
    now = _now(now)
    cur = {r[0]: (r[1], r[2]) for r in conn.execute(
        "select feature_id, stage, stage_since from feature_rollout")}
    out = []
    for f in feats:
        row = {"feature": f, "stage": None, "since": None, "facts": None}
        if f["id"] in cur:
            stage, since = cur[f["id"]]
            row.update(stage=stage, since=since,
                       facts=_facts(conn, f, stage, since, now, shift))
        out.append(row)
    return out


def legacy_rows(conn, feats) -> list[dict]:
    """Dòng sổ có id KHÔNG còn trong danh mục (id nhóm v12 đã tách) — giữ
    nguyên lịch sử, chỉ liệt kê kèm các mục tách."""
    ids, sm = {f["id"] for f in feats}, split_map(feats)
    return [{"id": r[0], "stage": r[1], "since": r[2],
             "tach_thanh": sm.get(r[0], [])}
            for r in conn.execute("select feature_id, stage, stage_since"
                                  " from feature_rollout order by feature_id")
            if r[0] not in ids]


def severe_events(conn, fids) -> list[dict]:
    cols = ("ts", "feature_id", "severe_code", "from_stage", "note",
            "by_person")
    return [dict(zip(cols, r)) for r in conn.execute(
        f"select {', '.join(cols)} from feature_rollout_events where"
        " kind = 'severe' and feature_id = any(%s) order by ts, id",
        (list(fids),))]


def reviewed_count(conn, fids) -> int:
    """Số lần nâng lên `co_nguoi_duyet` (tính năng đã qua giai đoạn đó)."""
    return conn.execute(
        "select count(*) from feature_rollout_events where kind = 'promote'"
        " and to_stage = 'co_nguoi_duyet' and feature_id = any(%s)",
        (list(fids),)).fetchone()[0]


# ------------------------------------------------------------ hồ sơ


def evidence_status(ev, root: Path = ROOT) -> str:
    if not ev:
        return "chưa có bằng chứng"
    missing = []
    for rel, needle in ev:
        p = root / rel
        try:
            ok = p.is_file() and (needle is None or needle in p.read_bytes()
                                  .decode("utf-8", errors="replace"))
        except OSError:
            ok = False
        if not ok:
            missing.append(rel)
    if missing:
        return f"chưa có bằng chứng (thiếu {', '.join(missing)})"
    return "có lệnh trong repo — chạy và đính kèm kết quả"


def _cell(s) -> str:
    return _oneline(str(s), 160).replace("|", "/")


def _d(ts) -> str:
    return ts.astimezone(VN_TZ).strftime("%d/%m/%Y") if ts else "—"


def _legacy_line(r) -> str:
    to = ", ".join(r["tach_thanh"]) or "không còn trong danh mục"
    return (f"{r['id']} ({STAGE_LABEL.get(r['stage'], r['stage'])} từ "
            f"{_d(r['since'])}) → {to}")


def render_dossier(phase: str, rows: list[dict], severe: list[dict],
                   n_reviewed: int, now: datetime,
                   root: Path = ROOT, legacy=(), warnings=()) -> str:
    """Markdown hồ sơ đề nghị nghiệm thu — THUẦN (đầu vào đã đọc DB)."""
    L = [f"# Hồ sơ đề nghị nghiệm thu {phase} — BẢN NHÁP do hệ thống dựng",
         "",
         (f"Ngày lập: {_d(now)} (giờ VN). Căn cứ: Hợp đồng hợp tác TEDO–Sâm "
         "Sâm, PL02 mục 1d (hồ sơ) + mục 2 (tiêu chí kỹ thuật)."),
         "",
         ("Lưu ý: danh mục là BẢN ĐỀ XUẤT tách từ nhóm PL01 mục 2 (mục "
         "`<nhóm>.<n>` = tách từ nhóm), CHƯA được hai bên chốt — danh mục "
         f"{HD_TOTAL} tính năng chính thức chờ biên bản. Không suy tỷ lệ "
         "hoàn thành từ số dòng."),
         "", f"## 1. Danh sách tính năng ({len(rows)} mục)", "",
         ("| Mã | Phòng ban | Tính năng | Code | Giai đoạn triển khai | "
         "Từ ngày | Ngày làm việc | Đầu ra | Lỗi NT |"),
         "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        f, fx = r["feature"], r["facts"]
        if r["stage"] is None:
            tail = "chưa vào sổ | — | — | — | —"
        else:
            out = "không đếm được" if fx["outputs"] is None \
                else f"{fx['outputs']} ({fx['out_days']} ngày)"
            tail = (f"{STAGE_LABEL[r['stage']]} | {_d(r['since'])} | "
                    f"{fx['days']} | {out} | {fx['severe']}")
        L.append(f"| {f['id']} | {f['phong_ban']} | {_cell(f['ten'])} | "
                 f"{f['code_status']} | {tail} |")
    L += ["", ("Nguồn: `data/contract_features.json`, bảng `feature_rollout`,"
          " `feature_rollout_events`; đầu ra = mục DISTINCT ở `output_sources`"
          " của đúng tính năng (hàng duyệt / nháp nội dung, guardrail đạt,"
          " không mẫu) từ lúc vào giai đoạn — (N ngày) = số ngày làm việc"
          " khác nhau có đầu ra."), ""]
    L += [f"> {w}" for w in warnings] + ([""] if warnings else [])
    if legacy:
        L += [("ID nhóm cũ (v12) còn trong sổ — lịch sử giữ nguyên, mục tách"
               " đếm lại từ mốc riêng:"), ""]
        L += [f"- {_legacy_line(r)}" for r in legacy] + [""]
    L += [
          "## 2. Kết quả chạy thử (cổng PL02 mục 1a–c)", ""]
    for r in rows:
        f, fx = r["feature"], r["facts"]
        if r["stage"] is None:
            continue
        if fx["target"] is None:
            L.append(f"- `{f['id']}` vận hành.")
        elif fx["why"]:
            L.append(f"- `{f['id']}` {STAGE_LABEL[r['stage']]}: CHƯA đủ "
                     f"điều kiện nâng — {'; '.join(fx['why'])}.")
        else:
            L.append(f"- `{f['id']}` {STAGE_LABEL[r['stage']]}: đủ điều "
                     f"kiện nâng lên {STAGE_LABEL[fx['target']]} (chờ người"
                     " duyệt ghi `--promote`).")
    if not any(r["stage"] for r in rows):
        L.append("- Chưa tính năng nào vào sổ triển khai.")
    L += ["", "## 3. Nhật ký lỗi nghiêm trọng (PL02 mục 2)", ""]
    if severe:
        L += [("| Thời điểm | Mã | Lỗi | Giai đoạn lúc lỗi | Ghi chú |"
              " Người ghi |"), "|---|---|---|---|---|---|"]
        for e in severe:
            L.append(
                f"| {e['ts'].astimezone(VN_TZ):%d/%m/%Y %H:%M} | "
                f"{e['feature_id']} | {SEVERE.get(e['severe_code'], '?')} | "
                f"{STAGE_LABEL.get(e['from_stage'], '—')} | "
                f"{_cell(_mask_pii(e['note'] or '—'))} | "
                f"{_cell(_mask_pii(e['by_person']))} |")
    else:
        L.append("Chưa ghi nhận lỗi nghiêm trọng nào.")
    L += ["", ("Nguồn: bảng `feature_rollout_events` (kind `severe`, "
          "append-only)."), "", "## 4. Tiêu chí kỹ thuật (PL02 mục 2)", "",
          "| Chỉ tiêu | Yêu cầu | Lệnh / bằng chứng | Trạng thái |",
          "|---|---|---|---|"]
    n_rev_sev = sum(1 for e in severe if e["from_stage"] == "co_nguoi_duyet")
    for i, (name, req, cmd, ev) in enumerate(CRITERIA):
        if i == 0:
            cmd = "bảng `feature_rollout_events`"
            st = ("chưa có tính năng nào qua giai đoạn có người duyệt"
                  if n_reviewed == 0 else
                  f"{n_rev_sev} lỗi ghi nhận ({n_reviewed} lần vào giai đoạn"
                  " có người duyệt)")
        else:
            st = evidence_status(ev, root)
        L.append(f"| {name} | {req} | {_cell(cmd or '—')} | {st} |")
    L += ["", "## 5. Ký nhận", "",
          ("Bên B ký biên bản hoặc gửi danh sách lỗi trong 30 ngày kể từ ngày"
          " nhận bàn giao (PL02 mục 1đ). Hồ sơ này chỉ là đề xuất của hệ "
          "thống — không thay chữ ký."), "",
          "| Đại diện Bên A | Đại diện Bên B |", "|---|---|", "|  |  |", ""]
    return "\n".join(L)


def dossier(conn, feats, phase: str, shift, now=None) -> str:
    if phase not in PHASES:
        raise ValueError(f"--phase phải ∈ {PHASES}")
    now = _now(now)
    sel = [f for f in feats if f["giai_doan"] == phase]
    ids = {f["id"] for f in sel}
    rows = [r for r in status_rows(conn, feats, shift, now)
            if r["feature"]["id"] in ids]
    return render_dossier(phase, rows, severe_events(conn, ids),
                          reviewed_count(conn, ids), now,
                          legacy=legacy_rows(conn, feats),
                          warnings=[w for w in (holiday_warning(),) if w])


# ------------------------------------------------------------ CLI


def _print_status(rows) -> None:
    for r in rows:
        f, fx = r["feature"], r["facts"]
        head = f"{f['id']:<18} {_oneline(f['ten'], 40):<40}"
        if r["stage"] is None:
            print(f"{head} — {f['code_status']}, chưa vào sổ")
            continue
        out = ("?" if fx["outputs"] is None else
               f"{fx['outputs']} ({fx['out_days']} ngày, {fx['human']} người"
               " duyệt)")
        gate = ("vận hành" if fx["target"] is None else
                "ĐỦ cổng → " + STAGE_LABEL[fx["target"]] if not fx["why"]
                else "; ".join(fx["why"]))
        print(f"{head} {STAGE_LABEL[r['stage']]} từ {_d(r['since'])} · "
              f"{fx['days']} ngày LV · {out} đầu ra · {gate}")


def _print_catalog(feats, path: Path) -> None:
    doc = json.loads(Path(path).read_bytes().decode("utf-8"))
    tong = summary(feats, doc["so_tinh_nang_hd"], doc["so_giai_doan_hd"])
    print("Danh mục yêu cầu HĐ — BẢN ĐỀ XUẤT, chờ hai bên chốt")
    for k in (*BLOCKS, *PHASES, "tong"):
        t = tong[k]
        print(f"{k:<14} HĐ {t['hd']:>2} · đề xuất {t['de_xuat']:>2} · "
              f"{t['trang_thai']}")
    print("ngoài 89: " + ", ".join(f"{k} {v}" for k, v in
                                    tong["ngoai_89"].items()))
    by = {c: sum(f["code_status"] == c for f in feats) for c in CODE_STATES}
    print("code_status: " + ", ".join(f"{k} {v}" for k, v in by.items()))
    for g, ids in split_map(feats).items():
        print(f"tách {g} → {', '.join(ids)}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.rollout",
                                 description=__doc__.split("\n\n")[0])
    op = ap.add_mutually_exclusive_group(required=True)
    op.add_argument("--seed", action="store_true")
    op.add_argument("--status", action="store_true")
    op.add_argument("--promote", metavar="ID")
    op.add_argument("--severe", metavar="ID")
    op.add_argument("--disable", metavar="ID")
    op.add_argument("--dossier", action="store_true")
    op.add_argument("--catalog", action="store_true")
    op.add_argument("--outputs", metavar="ID",
                    help="đầu ra cần người duyệt từng mục (khóa + sha)")
    op.add_argument("--review-output", metavar="ID",
                    help="NGƯỜI duyệt 1 đầu ra (--key --sha --decision --by)")
    ap.add_argument("--key")
    ap.add_argument("--sha")
    ap.add_argument("--decision", choices=DECISIONS)
    ap.add_argument("--by")
    ap.add_argument("--reason", choices=sorted(SEVERE))
    ap.add_argument("--note")
    ap.add_argument("--phase", choices=PHASES)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    writes = (a.seed or a.promote or a.severe or a.disable
              or a.review_output)
    if writes:
        try:
            check_by(a.by)
        except ValueError as e:
            ap.error(str(e))
    if a.severe and not a.reason:
        ap.error("--severe cần --reason <mã lỗi PL02 mục 2>")
    if a.reason and not a.severe:
        ap.error("--reason chỉ dùng với --severe")
    if a.note is not None and not (a.severe or a.disable
                                   or a.review_output):
        ap.error("--note chỉ dùng với --severe/--disable/--review-output")
    rev = (a.key, a.sha, a.decision)
    if a.review_output and None in rev:
        ap.error("--review-output cần --key, --sha, --decision")
    if not a.review_output and any(v is not None for v in rev):
        ap.error("--key/--sha/--decision chỉ dùng với --review-output")
    if a.dossier and not a.phase:
        ap.error("--dossier cần --phase P1|P2")
    if (a.phase or a.out) and not a.dossier:
        ap.error("--phase/--out chỉ dùng với --dossier")
    try:
        feats, shift = load_features(FEATURES_FILE), load_shift(CONFIG_FILE)
    except ValueError as e:
        print(f"[FAIL] cấu hình: {e}", file=sys.stderr)
        return 2
    if a.catalog:
        _print_catalog(feats, FEATURES_FILE)
        return 0
    conn = connect()
    if conn is None:
        print("[FAIL] DB không kết nối được (DATABASE_URL)", file=sys.stderr)
        return 2
    try:
        fid = a.promote or a.severe or a.disable or a.review_output
        if fid:
            # v14.2: nâng/lùi/tắt giai đoạn = quyết định của người được Bên
            # B ủy quyền cho phòng ban của tính năng (auth.cli_gate).
            from pipelines import auth  # lười: auth → director → ...
            act = ("promote" if a.promote else
                   "severe" if a.severe else "disable" if a.disable else
                   "approve" if a.decision == "approved" else "reject")
            blk = next((f.get("phong_ban") for f in feats if f["id"] == fid
                        and f.get("phong_ban") in BLOCKS), "data_platform")
            why = (auth.cli_gate(conn, a.by, blk, act, "output_review",
                                 f"{fid}:{a.key}") if a.review_output else
                   auth.cli_gate(conn, a.by, blk, act, "feature_rollout",
                                 fid))
            if why:
                print(f"[TỪ CHỐI] {why}", file=sys.stderr)
                return 1
        if a.seed:
            st = seed(conn, feats, a.by)
            print(f"[OK] vào sổ {st['inserted']} · có sẵn {st['existing']} ·"
                  f" bỏ qua (chưa co_code) {st['skipped']}")
        elif a.status:
            _print_status(status_rows(conn, feats, shift))
            if w := holiday_warning():
                print(w)
            for r in legacy_rows(conn, feats):
                print(f"[id nhóm cũ] {_legacy_line(r)} — lịch sử giữ "
                      "nguyên, mục tách đếm lại từ mốc riêng")
        elif a.promote:
            r = promote(conn, feats, a.promote, a.by, shift)
            print(f"[OK] {a.promote}: {STAGE_LABEL[r['from']]} → "
                  f"{STAGE_LABEL[r['to']]}")
        elif a.severe:
            r = record_severe(conn, a.severe, a.reason, a.by, a.note)
            print(f"[OK] {a.severe}: ghi lỗi nghiêm trọng "
                  f"'{SEVERE[a.reason]}' — {STAGE_LABEL[r['from']]} → "
                  f"{STAGE_LABEL[r['to']]}")
        elif a.disable:
            r = disable(conn, a.disable, a.by, a.note)
            print(f"[OK] {a.disable}: {STAGE_LABEL[r['from']]} → tắt")
        elif a.outputs:
            rows = pending_outputs(conn, feats, a.outputs, by=a.by)
            for o in rows:
                st = ("CHƯA DUYỆT" if o["review"] is None else
                      f"{o['review'][0]} bởi {_mask_pii(o['review'][1])}")
                print(f"{o['key']}	{_d(o['ts'])}	sha={o['sha']}	{st}")
            n = sum(1 for o in rows if o["review"] is None)
            print(f"[OK] {a.outputs}: {len(rows)} đầu ra cần người duyệt "
                  f"từng mục, {n} chưa duyệt")
        elif a.review_output:
            rid = review_output(conn, feats, a.review_output, a.key, a.sha,
                                a.decision, a.by, a.note)
            print(f"[OK] {a.review_output}: {a.key} → {a.decision} "
                  f"(sổ output_reviews #{rid})")
        else:
            text = dossier(conn, feats, a.phase, shift)
            if a.out:
                p = Path(a.out)
                path = write_report(text, p.parent, p.name, sample=False)
            else:
                name = (f"nghiem-thu-{a.phase}-"
                        f"{datetime.now(VN_TZ):%Y-%m-%d}.md")
                path = write_report(text, REPORTS_DIR, name, sample=False)
            print(f"[OK] hồ sơ → {path}")
    except RolloutError as e:
        print(f"[TỪ CHỐI] {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 2
    except psycopg.Error as e:
        print(f"[FAIL] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
