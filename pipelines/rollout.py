"""v12.1 B1 — sổ triển khai 3 bước + hồ sơ đề nghị nghiệm thu (HĐ hợp tác
TEDO–Sâm Sâm, PL02 mục 1).

Quy trình HĐ: mỗi tính năng chạy thử nội bộ ≥05 ngày làm việc VÀ ≥50 đầu
ra → chạy có người duyệt ≥10 ngày làm việc, 0 lỗi nghiêm trọng → vận hành.
Một lỗi nghiêm trọng (PL02 mục 2) → tắt, quay về chạy thử.

Contract:
  - Danh mục `data/contract_features.json` (`load_features`) — 1 dòng /
    NHÓM tính năng PL01 mục 2 (PL01 không liệt kê 89 mục chi tiết — chờ hai
    bên chốt). Chỉ `trang_thai_code = co_code` được vào sổ.
  - Bảng `feature_rollout` (trạng thái hiện tại) + `feature_rollout_events`
    (append-only) — docs/schema.sql khối `v12.1 B1`.
  - Giai đoạn `chay_thu` → `co_nguoi_duyet` → `van_hanh`; `tat` (tắt tay)
    → `--promote` đưa lại `chay_thu` (bắt đầu đếm lại). Mọi ghi cần
    `--by` NGƯỜI thật (chặn 'agent:'/'system:' ở code + CHECK DB).
  - Cổng nâng (tính trong tx, khóa dòng `for update`):
      chay_thu → co_nguoi_duyet: ≥5 ngày làm việc VÀ ≥50 dòng
        `agent_action_log` có `actor` ∈ `agent_ids` của tính năng, `ts` ≥
        lúc vào giai đoạn. Tính năng không khai `agent_ids` → KHÔNG đếm
        được → từ chối (fail-closed, không đoán).
      co_nguoi_duyet → van_hanh: ≥10 ngày làm việc VÀ 0 sự kiện `severe`
        từ lúc vào giai đoạn.
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
Exit: 0 ok · 1 bị từ chối (chưa đủ cổng / không có trong sổ) · 2 tham số
sai / cấu hình lỗi / DB down.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
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
CODE_STATES = ("co_code", "thieu", "lam_rieng")
PHASES = ("P1", "P2")
HD_TOTAL = 89                     # HĐ: 89 tính năng / 9 phòng ban
TRIAL_DAYS, TRIAL_OUTPUTS, REVIEW_DAYS = 5, 50, 10    # PL02 mục 1a, 1b
MAX_BY = 100
MAX_NOTE = 300
_ID_RE = re.compile(r"([a-z_]+)-([0-9]{2})")

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


def load_features(path: Path = FEATURES_FILE) -> list[dict]:
    """Đọc + kiểm danh mục → list dòng. Sai → ValueError (fail-closed)."""
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
        items, counts = doc["features"], doc["so_tinh_nang_hd"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError,
            TypeError) as e:
        raise ValueError(f"{Path(path).name}: không đọc được "
                         f"({type(e).__name__})") from None
    if not isinstance(counts, dict) or set(counts) != set(BLOCKS) or any(
            isinstance(n, bool) or not isinstance(n, int) or n < 1
            for n in counts.values()) or sum(counts.values()) != HD_TOTAL:
        raise ValueError(f"so_tinh_nang_hd: phải đủ {len(BLOCKS)} phòng ban,"
                         f" số nguyên ≥1, tổng {HD_TOTAL}")
    if not isinstance(items, list) or not items:
        raise ValueError("features: rỗng")
    out, seen = [], set()
    for i, f in enumerate(items):
        fid = f.get("id") if isinstance(f, dict) else None
        m = _ID_RE.fullmatch(fid) if isinstance(fid, str) else None
        if not m or fid in seen:
            raise ValueError(f"features[{i}].id: thiếu/sai/trùng")
        if f.get("phong_ban") not in BLOCKS or m.group(1) != f["phong_ban"]:
            raise ValueError(f"{fid}.phong_ban: phải ∈ {BLOCKS} và khớp "
                             "tiền tố id")
        for k in ("ten", "ho_tro", "nguon"):
            if not isinstance(f.get(k), str) or not f[k].strip():
                raise ValueError(f"{fid}.{k}: thiếu")
        if f.get("giai_doan") not in PHASES:
            raise ValueError(f"{fid}.giai_doan: phải ∈ {PHASES}")
        if f.get("trang_thai_code") not in CODE_STATES:
            raise ValueError(f"{fid}.trang_thai_code: phải ∈ {CODE_STATES}")
        mods = f.get("modules", [])
        aids = f.get("agent_ids", [])
        if mods or not isinstance(mods, list):
            _str_list(mods, f"{fid}.modules")
        if aids or not isinstance(aids, list):
            _str_list(aids, f"{fid}.agent_ids")
        if f["trang_thai_code"] == "co_code" and not mods:
            raise ValueError(f"{fid}.modules: co_code phải có ≥1 module")
        seen.add(fid)
        out.append(f)
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


def evaluate(stage: str, days: int, outputs: int | None,
             severe: int) -> tuple[str | None, list[str]]:
    """Cổng PL02 mục 1 → (giai đoạn đích, [lý do chưa đạt]). Rỗng = đạt."""
    if stage == "chay_thu":
        why = []
        if days < TRIAL_DAYS:
            why.append(f"mới {days}/{TRIAL_DAYS} ngày làm việc chạy thử")
        if outputs is None:
            why.append("chưa khai agent_ids — không đếm được đầu ra trong "
                       "agent_action_log")
        elif outputs < TRIAL_OUTPUTS:
            why.append(f"mới {outputs}/{TRIAL_OUTPUTS} đầu ra")
        return "co_nguoi_duyet", why
    if stage == "co_nguoi_duyet":
        why = []
        if days < REVIEW_DAYS:
            why.append(f"mới {days}/{REVIEW_DAYS} ngày làm việc có người "
                       "duyệt")
        if severe:
            why.append(f"{severe} lỗi nghiêm trọng trong giai đoạn")
        return "van_hanh", why
    if stage == "tat":
        return "chay_thu", []
    return None, ["đã vận hành — không còn bước nâng"]


# ------------------------------------------------------------ DB


def _count_outputs(conn, agent_ids: list[str], since) -> int | None:
    if not agent_ids:
        return None
    return conn.execute(
        "select count(*) from agent_action_log where actor = any(%s)"
        " and ts >= %s", (list(agent_ids), since)).fetchone()[0]


def _count_severe(conn, fid: str, since) -> int:
    return conn.execute(
        "select count(*) from feature_rollout_events where feature_id = %s"
        " and kind = 'severe' and ts >= %s", (fid, since)).fetchone()[0]


def _facts(conn, f: dict, stage: str, since, now, shift) -> dict:
    days = business_days(since, now, shift)
    outputs = _count_outputs(conn, f.get("agent_ids", []), since)
    severe = _count_severe(conn, f["id"], since)
    target, why = evaluate(stage, days, outputs, severe)
    return {"days": days, "outputs": outputs, "severe": severe,
            "target": target, "why": why}


def _event(conn, fid, kind, frm, to, by, now, *, code=None, note=None,
           evidence=None):
    conn.execute(
        "insert into feature_rollout_events (ts, feature_id, kind,"
        " from_stage, to_stage, severe_code, note, evidence, by_person)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (now, fid, kind, frm, to, code, note, Jsonb(evidence or {}), by))


def _set_stage(conn, fid, stage, by, now):
    conn.execute("update feature_rollout set stage = %s, stage_since = %s,"
                 " updated_by = %s, updated_at = %s where feature_id = %s",
                 (stage, now, by, now, fid))


def _locked(conn, fid: str):
    row = conn.execute("select stage, stage_since from feature_rollout"
                       " where feature_id = %s for update", (fid,)).fetchone()
    if row is None:
        raise RolloutError(f"{fid}: chưa vào sổ triển khai (chạy --seed)")
    return row


def _now(now):
    return now if now is not None else datetime.now(VN_TZ)


def seed(conn, feats: list[dict], by: str, now=None) -> dict:
    """Đưa tính năng `co_code` chưa có vào `chay_thu` (bắt đầu đếm). Có rồi
    → giữ nguyên (không reset mốc). Idempotent."""
    by, now = check_by(by), _now(now)
    st = {"inserted": 0, "existing": 0, "skipped": 0}
    with conn.transaction():
        for f in feats:
            if f["trang_thai_code"] != "co_code":
                st["skipped"] += 1
                continue
            cur = conn.execute(
                "insert into feature_rollout (feature_id, stage, stage_since,"
                " updated_by, updated_at) values (%s, 'chay_thu', %s, %s, %s)"
                " on conflict (feature_id) do nothing",
                (f["id"], now, by, now))
            if cur.rowcount == 1:
                _event(conn, f["id"], "seed", None, "chay_thu", by, now)
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
    if f["trang_thai_code"] != "co_code":
        raise RolloutError(f"{fid}: trang_thai_code={f['trang_thai_code']}"
                           " — không triển khai trong repo này")
    with conn.transaction():
        stage, since = _locked(conn, fid)
        facts = _facts(conn, f, stage, since, now, shift)
        if facts["target"] is None or facts["why"]:
            raise RolloutError(f"{fid} ({STAGE_LABEL[stage]}) chưa đủ cổng: "
                               + "; ".join(facts["why"]))
        _set_stage(conn, fid, facts["target"], by, now)
        _event(conn, fid, "promote", stage, facts["target"], by, now,
               evidence={k: facts[k] for k in ("days", "outputs", "severe")}
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
        _event(conn, fid, "severe", stage, to, by, now, code=code,
               note=_clean_note(note))
        if stage != "tat":                 # về chạy thử, đếm lại từ đầu
            _set_stage(conn, fid, to, by, now)
    conn.commit()
    return {"from": stage, "to": to}


def disable(conn, fid: str, by: str, note=None, now=None) -> dict:
    by, now = check_by(by), _now(now)
    with conn.transaction():
        stage, _ = _locked(conn, fid)
        if stage == "tat":
            raise RolloutError(f"{fid}: đã tắt")
        _event(conn, fid, "disable", stage, "tat", by, now,
               note=_clean_note(note))
        _set_stage(conn, fid, "tat", by, now)
    conn.commit()
    return {"from": stage, "to": "tat"}


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


def render_dossier(phase: str, rows: list[dict], severe: list[dict],
                   n_reviewed: int, now: datetime,
                   root: Path = ROOT) -> str:
    """Markdown hồ sơ đề nghị nghiệm thu — THUẦN (đầu vào đã đọc DB)."""
    L = [f"# Hồ sơ đề nghị nghiệm thu {phase} — BẢN NHÁP do hệ thống dựng",
         "",
         (f"Ngày lập: {_d(now)} (giờ VN). Căn cứ: Hợp đồng hợp tác TEDO–Sâm "
         "Sâm, PL02 mục 1d (hồ sơ) + mục 2 (tiêu chí kỹ thuật)."),
         "",
         ("Lưu ý: PL01 mục 2 chỉ liệt kê NHÓM tính năng; mỗi dòng dưới đây = "
         f"1 nhóm. Danh mục {HD_TOTAL} tính năng chi tiết chờ hai bên chốt."),
         "", f"## 1. Danh sách tính năng ({len(rows)} nhóm)", "",
         ("| Mã | Phòng ban | Tính năng | Code | Giai đoạn triển khai | "
         "Từ ngày | Ngày làm việc | Đầu ra | Lỗi NT |"),
         "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        f, fx = r["feature"], r["facts"]
        if r["stage"] is None:
            tail = "chưa vào sổ | — | — | — | —"
        else:
            out = "không đếm được" if fx["outputs"] is None \
                else str(fx["outputs"])
            tail = (f"{STAGE_LABEL[r['stage']]} | {_d(r['since'])} | "
                    f"{fx['days']} | {out} | {fx['severe']}")
        L.append(f"| {f['id']} | {f['phong_ban']} | {_cell(f['ten'])} | "
                 f"{f['trang_thai_code']} | {tail} |")
    L += ["", ("Nguồn: `data/contract_features.json`, bảng `feature_rollout`,"
          " `feature_rollout_events`; đầu ra = dòng `agent_action_log` theo"
          " `agent_ids` từ lúc vào giai đoạn."), "",
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
                          reviewed_count(conn, ids), now)


# ------------------------------------------------------------ CLI


def _print_status(rows) -> None:
    for r in rows:
        f, fx = r["feature"], r["facts"]
        head = f"{f['id']:<18} {_oneline(f['ten'], 40):<40}"
        if r["stage"] is None:
            print(f"{head} — {f['trang_thai_code']}, chưa vào sổ")
            continue
        out = "?" if fx["outputs"] is None else fx["outputs"]
        gate = ("vận hành" if fx["target"] is None else
                "ĐỦ cổng → " + STAGE_LABEL[fx["target"]] if not fx["why"]
                else "; ".join(fx["why"]))
        print(f"{head} {STAGE_LABEL[r['stage']]} từ {_d(r['since'])} · "
              f"{fx['days']} ngày LV · {out} đầu ra · {gate}")


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
    ap.add_argument("--by")
    ap.add_argument("--reason", choices=sorted(SEVERE))
    ap.add_argument("--note")
    ap.add_argument("--phase", choices=PHASES)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    writes = a.seed or a.promote or a.severe or a.disable
    if writes:
        try:
            check_by(a.by)
        except ValueError as e:
            ap.error(str(e))
    if a.severe and not a.reason:
        ap.error("--severe cần --reason <mã lỗi PL02 mục 2>")
    if a.reason and not a.severe:
        ap.error("--reason chỉ dùng với --severe")
    if a.note is not None and not (a.severe or a.disable):
        ap.error("--note chỉ dùng với --severe/--disable")
    if a.dossier and not a.phase:
        ap.error("--dossier cần --phase P1|P2")
    if (a.phase or a.out) and not a.dossier:
        ap.error("--phase/--out chỉ dùng với --dossier")
    try:
        feats, shift = load_features(FEATURES_FILE), load_shift(CONFIG_FILE)
    except ValueError as e:
        print(f"[FAIL] cấu hình: {e}", file=sys.stderr)
        return 2
    conn = connect()
    if conn is None:
        print("[FAIL] DB không kết nối được (DATABASE_URL)", file=sys.stderr)
        return 2
    try:
        if a.seed:
            st = seed(conn, feats, a.by)
            print(f"[OK] vào sổ {st['inserted']} · có sẵn {st['existing']} ·"
                  f" bỏ qua (thieu/lam_rieng) {st['skipped']}")
        elif a.status:
            _print_status(status_rows(conn, feats, shift))
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
        else:
            text = dossier(conn, feats, a.phase, shift)
            if a.out:
                p = Path(a.out)
                path = write_report(text, p.parent, p.name)
            else:
                name = (f"nghiem-thu-{a.phase}-"
                        f"{datetime.now(VN_TZ):%Y-%m-%d}.md")
                path = write_report(text, REPORTS_DIR, name)
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
