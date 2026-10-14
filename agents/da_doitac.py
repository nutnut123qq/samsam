"""v10.2 W102.5 — DA-06 Agent Hồ sơ đối tác (phòng Dự án, WP16).

Contract:
  - Phần đối tác CHỈ từ cột TỔ CHỨC của `org_prospects` (v8.3 DA-05:
    org_name, org_type, region, website, source_url, fit_reason) — ô nào
    `_mask_pii` đổi giá trị (SĐT/email lọt vào) → problem, KHÔNG in ô.
  - Sản phẩm = `da_hoso.eligible_skus` (rượu + TPBVSK chưa XNQC bị loại, cả
    tên SKU). Số liệu `data/projects/partner_facts.json`: mỗi số kèm
    "(nguồn …, ngày …)"; thiếu nguồn/ngày → "chưa xác minh" (không in số);
    fact `sample` → "(MẪU)"; doanh số sàn kèm "doanh số, không phải doanh
    thu thực nhận". CẤM dự phóng/cam kết lợi nhuận (`FORECAST_RE` → problem).
  - Cổng payload: `da_hoso.gate` (guardrail.check_publish web + không rượu
    + 0 tên SKU bị loại) + `FORECAST_RE` + PII. `internal` = mục lục data
    room + trạng thái (`thieu` | `chua_xac_minh` | `da_xac_minh`) + danh sách
    "chưa xác minh" — KHÔNG vào hàng duyệt. Agent KHÔNG ghi `verified_by`.
  - Go-live 16/02/2027: trước đó = `shadow` (chỉ ghi file, `--submit` bị từ
    chối exit 1) — tính theo đồng hồ THẬT; `--date` chỉ đổi nhãn chế độ
    trong file nháp, không mở cổng `--submit`. PII quét trên TOÀN payload
    (cả label/source số liệu). Sau go-live, problems rỗng → `director.submit("projects",
    "partner_profile")` PENDING. `--status QUEUE_ID`: chỉ mục ĐÃ DUYỆT và
    payload dựng lại khớp sha256 bản duyệt → "được chia sẻ (theo NDA)";
    mọi trường hợp khác → "không được chia sẻ" + lý do.
  - Agent KHÔNG gửi/chia sẻ data room, không liên hệ ai, 0 LLM.

Chạy:
  python -m agents.da_doitac --draft PROSPECT_ID [--submit] [--date YYYY-MM-DD]
  python -m agents.da_doitac --data-room
  python -m agents.da_doitac --status QUEUE_ID
Exit: 0 ok / được chia sẻ · 1 bị từ chối (shadow, problems, không thấy,
không được chia sẻ, dữ liệu hỏng) · 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import hashlib
import json
import re
import sys
from contextlib import suppress
from datetime import date, datetime, time
from pathlib import Path

import psycopg

from agents.da_hoso import AI_LABEL, eligible_skus, gate
from agents.report import REPORTS_DIR, write_report
from ingest.golden_store import GOLDEN_FILE, read_golden
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import director
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ
from pipelines.pii import _mask_pii

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA_ROOM_FILE = ROOT / "data" / "projects" / "data_room.json"
FACTS_FILE = ROOT / "data" / "projects" / "partner_facts.json"
GO_LIVE = date(2027, 2, 16)
BLOCK = "projects"
OBJECT_TYPE = "partner_profile"
CREATED_BY = "agent:DA-06"
NOT_SHARED = "không được chia sẻ"
SHARED = "được chia sẻ (theo NDA)"
SECTIONS = ("phap_ly", "vung_trong", "san_pham", "kenh", "nhan_su", "so_lieu")
PROSPECT_COLS = ("org_name", "org_type", "region", "website", "source_url",
                 "fit_reason")
PROSPECT_LABELS = {"org_name": "Tên tổ chức", "org_type": "Loại hình",
                   "region": "Khu vực", "website": "Website",
                   "source_url": "Nguồn thông tin công khai",
                   "fit_reason": "Lý do phù hợp"}
FORECAST_RE = re.compile(
    r"(?i:dự phóng|dự báo doanh thu|lợi nhuận dự kiến|biên lợi nhuận"
    r"|cam kết lợi nhuận|tăng trưởng \d+\s*%)|\bROI\b")
_OID_RE = re.compile(r"partner:(\d{1,18}):[0-9a-f]{16}")
_KEY_RE = re.compile(r"[a-z0-9_]{1,64}")


class DataError(Exception):
    """data_room.json / partner_facts.json hỏng — fail-closed."""


def _one(s, n: int = 300) -> str:
    return " ".join(str(s or "").split())[:n]


# Ký tự markdown/HTML trong dữ liệu NGOÀI (org_prospects nạp từ CSV, file
# số liệu) → escape: "![](https://...)"/"<img>" không thành ảnh/link tự tải
# khi mở hồ sơ (precedent scripts/intel_bulletin.py `_MD_RE`).
_MD_RE = re.compile(r"([\\`\[\]<>!*_|])")


def _md(s) -> str:
    return _MD_RE.sub(r"\\\1", s)


def _load(path: Path) -> dict:
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise DataError(f"{Path(path).name}: {type(e).__name__}") from e
    if not isinstance(doc, dict):
        raise DataError(f"{Path(path).name}: gốc phải là object")
    return doc


def load_data_room(path=None) -> list[dict]:
    doc = _load(path or DATA_ROOM_FILE)
    secs = doc.get("sections")
    if (not isinstance(secs, list)
            or [s.get("id") if isinstance(s, dict) else None
                for s in secs] != list(SECTIONS)):
        raise DataError(f"data_room: sections phải đúng {SECTIONS}")
    for s in secs:
        items = s.get("items")
        if not isinstance(s.get("title"), str) or not isinstance(items, list):
            raise DataError(f"data_room.{s['id']}: thiếu title/items")
        for it in items:
            if not (isinstance(it, dict)
                    and all(isinstance(it.get(k), str) and it[k].strip()
                            for k in ("id", "title", "owner_role"))
                    and all(it.get(k) is None or isinstance(it[k], str)
                            for k in ("evidence", "verified_by"))):
                raise DataError(f"data_room.{s['id']}: mục sai dạng")
    return secs


def load_facts(path=None) -> list[dict]:
    doc = _load(path or FACTS_FILE)
    facts = doc.get("facts")
    if not isinstance(facts, list):
        raise DataError("partner_facts: thiếu facts")
    for f in facts:
        if not (isinstance(f, dict) and isinstance(f.get("key"), str)
                and _KEY_RE.fullmatch(f["key"])
                and isinstance(f.get("label"), str) and f["label"].strip()):
            raise DataError("partner_facts: fact thiếu key/label")
    return facts


def item_status(it: dict) -> str:
    if not it.get("evidence"):
        return "thieu"
    return "da_xac_minh" if it.get("verified_by") else "chua_xac_minh"


def _fmt_value(v, unit) -> str | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    s = (f"{v:,}" if isinstance(v, int) else f"{v:,.2f}").replace(
        ",", "\x00").replace(".", ",").replace("\x00", ".")
    unit = _one(unit, 20)
    return f"{s}{unit}" if unit in ("đ", "%") else f"{s} {unit}".strip()


def _fact_line(f: dict) -> tuple[str, bool]:
    """→ (dòng, đã xác minh?). Thiếu nguồn/ngày/số → 'chưa xác minh'."""
    label = _md(_one(f.get("label"), 120))
    val = _fmt_value(f.get("value"), f.get("unit"))
    src, as_of = _md(_one(f.get("source"), 160)), f.get("as_of")
    try:
        d = date.fromisoformat(as_of) if isinstance(as_of, str) else None
    except ValueError:
        d = None
    if val is None or not src or d is None:
        return f"- {label}: chưa xác minh", False
    line = f"- {label}: {val} (nguồn {src}, ngày {d:%d/%m/%Y})"
    if f.get("sample") is True:
        line += " (MẪU)"
    if f.get("kind") == "doanh_so_san":
        line += " — doanh số, không phải doanh thu thực nhận"
    return line, True


def _excluded(golden, allowed) -> list[dict]:
    keep = {id(s) for s in allowed}
    skus = golden.get("skus") if isinstance(golden, dict) else golden
    return [s for s in (skus or []) if isinstance(s, dict)
            and id(s) not in keep]


def build(prospect: dict, facts: list[dict], golden, data_room: list[dict],
          *, now: datetime) -> dict:
    """THUẦN → {payload, internal, problems, mode}. Payload KHÔNG phụ thuộc
    `now` (dựng lại để so sha256 bản duyệt)."""
    problems = []
    org = _one(prospect.get("org_name"), 200)
    L = ["# Hồ sơ giới thiệu Công ty TNHH Sâm Sâm gửi đối tác"
         + (f": {_md(org)}" if org and _mask_pii(org) == org else ""), "",
         "## Thông tin đối tác (nguồn công khai)", ""]
    for col in PROSPECT_COLS:
        v = _one(prospect.get(col), 300)
        if not v:
            continue
        if _mask_pii(v) != v:
            problems.append(f"pii: {col}")
            L.append(f"- {PROSPECT_LABELS[col]}: (ẩn — có dữ liệu cá nhân, "
                     "cần sửa nguồn)")
            continue
        L.append(f"- {PROSPECT_LABELS[col]}: {_md(v)}")
    allowed, _qs = eligible_skus(golden)
    names = [s["name"] for s in allowed if s.get("name")]
    L += ["", "## Sản phẩm có thể giới thiệu", ""]
    L += [f"- {n}" for n in names] or [
        "- (chưa có sản phẩm đủ điều kiện — chờ Pháp chế)"]
    L += ["", "## Số liệu (chỉ số có nguồn và ngày)", ""]
    unverified = []
    for f in facts:
        line, ok = _fact_line(f)
        L.append(line)
        if not ok:
            unverified.append(_one(f.get("label"), 120))
    L += ["", "## Data room", "",
          ("Mục lục tài liệu chứng minh được chia sẻ theo NDA sau khi Công "
           "ty duyệt hồ sơ này."), "", AI_LABEL, ""]
    payload = "\n".join(L)
    # Toàn payload (cả label/source của partner_facts.json) — không chỉ
    # các ô org_prospects.
    if _mask_pii(payload) != payload:
        problems.append("pii: payload")
    for ln in payload.splitlines():
        if FORECAST_RE.search(ln):
            problems.append(f"du_phong: {_one(ln, 80)}")
    problems += gate(payload, _excluded(golden, allowed))
    if not names:
        problems.append("0 sản phẩm đủ điều kiện — chờ Pháp chế")
    mode = ("shadow" if now.astimezone(VN_TZ).date() < GO_LIVE else "live")
    return {"payload": payload, "problems": problems, "mode": mode,
            "internal": render_internal(data_room, unverified, problems,
                                        prospect.get("id"), mode)}


def render_internal(data_room, unverified=(), problems=(), pid=None,
                    mode=None) -> str:
    L = ["# NỘI BỘ — data room hồ sơ đối tác"
         + (f" (đối tác #{pid})" if pid is not None else ""), "",
         ("File nội bộ — KHÔNG gửi ra ngoài, KHÔNG vào hàng duyệt. Agent "
          "không ghi `verified_by` (người thật đối chiếu)."), ""]
    if mode:
        L += [f"Chế độ: {mode}" + (f" (trước go-live {GO_LIVE:%d/%m/%Y} — "
                                   "chỉ ghi file)" if mode == "shadow"
                                   else ""), ""]
    L += ["| Mục | Tài liệu | Phụ trách | Trạng thái |", "|---|---|---|---|"]
    for s in data_room:
        for it in s["items"]:
            L.append(f"| {_one(s['title'], 60)} | {_one(it['id'], 20)} "
                     f"{_one(it['title'], 120)} | {_one(it['owner_role'], 40)}"
                     f" | {item_status(it)} |")
    L += ["", "## Số liệu chưa xác minh", ""]
    L += [f"- {u}" for u in unverified] or ["- (không có)"]
    if problems:
        L += ["", "## Vấn đề chặn trình duyệt", "",
              *[f"- {_one(p, 200)}" for p in problems]]
    return "\n".join(L) + "\n"


def _sha16(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _prospect(conn, pid: int) -> dict | None:
    row = conn.execute(
        "select id, " + ", ".join(PROSPECT_COLS) + " from org_prospects"
        " where id = %s", (pid,)).fetchone()
    return dict(zip(("id", *PROSPECT_COLS), row)) if row else None


def _inputs():
    golden, err = read_golden(GOLDEN_FILE)
    if err:
        raise DataError(f"golden SKU: {err}")
    return load_facts(), golden, load_data_room()


def status(conn, qid: int, now: datetime) -> tuple[bool, str]:
    """→ (được chia sẻ?, lý do). Mặc định KHÔNG được chia sẻ."""
    row = conn.execute("select block, object_type, object_id, status from"
                       " approval_queue where id = %s", (qid,)).fetchone()
    if row is None:
        return False, f"không có mục #{qid}"
    block, otype, oid, st = row
    if block != BLOCK or otype != OBJECT_TYPE:
        return False, f"mục #{qid} không phải hồ sơ đối tác"
    if st != "approved":
        return False, f"mục #{qid} chưa được duyệt (trạng thái {st})"
    m = _OID_RE.fullmatch(oid or "")
    if not m:
        return False, "object_id lạ"
    p = _prospect(conn, int(m.group(1)))
    if p is None:
        return False, "không còn đối tác trong org_prospects"
    facts, golden, room = _inputs()
    payload = build(p, facts, golden, room, now=now)["payload"]
    if not aq.verify(conn, qid, payload):
        return False, ("dữ liệu đã đổi sau khi duyệt (lệch sha256 bản "
                       "duyệt) — soạn lại + duyệt lại")
    return True, "khớp bản đã duyệt"


def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_doitac",
        description="DA-06 hồ sơ đối tác — NHÁP; agent không gửi/chia sẻ, "
                    "không tự duyệt")
    ap.add_argument("--draft", type=int, metavar="PROSPECT_ID")
    ap.add_argument("--data-room", action="store_true")
    ap.add_argument("--status", type=int, metavar="QUEUE_ID")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (ngày VN)")
    a = ap.parse_args(argv)
    n_ops = (a.draft is not None) + a.data_room + (a.status is not None)
    if n_ops != 1:
        ap.error("cần đúng 1 thao tác: --draft | --data-room | --status")
    if (a.submit or a.date) and a.draft is None:
        ap.error("--submit/--date chỉ dùng với --draft")
    # `clock` = đồng hồ THẬT (hoặc `now` test tiêm) — quyết shadow/live cho
    # --submit. `--date` chỉ để xem trước nhãn chế độ trong file nháp, KHÔNG
    # mở được cổng go-live (chống `--date 2027-02-16 --submit` hôm nay).
    clock = now or datetime.now(VN_TZ)
    now = clock
    if a.date:
        try:
            now = datetime.combine(date.fromisoformat(a.date), time(12, 0),
                                   VN_TZ)
        except ValueError:
            ap.error("--date sai định dạng YYYY-MM-DD")
    try:
        facts, golden, room = _inputs()
    except DataError as e:
        print(f"[err] dữ liệu hồ sơ hỏng: {e}", file=sys.stderr)
        return 1
    if a.data_room:
        p = write_report(render_internal(room), REPORTS_DIR,
                         "da-doitac-data-room-noi-bo.md")
        n = {}
        for s in room:
            for it in s["items"]:
                n[item_status(it)] = n.get(item_status(it), 0) + 1
        print(f"[done] mục lục data room NỘI BỘ → {p} · "
              + " ".join(f"{k}={v}" for k, v in sorted(n.items())))
        return 0
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.status is not None:
            ok, why = status(conn, a.status, now)
            print(f"[{'ok' if ok else 'warn'}] mục #{a.status}: "
                  f"{SHARED if ok else NOT_SHARED} — {why}")
            return 0 if ok else 1
        p = _prospect(conn, a.draft)
        conn.commit()   # đóng tx đọc (conn chia sẻ)
        if p is None:
            print(f"[warn] không có đối tác #{a.draft} trong org_prospects",
                  file=sys.stderr)
            return 1
        res = build(p, facts, golden, room, now=now)
        stem = f"da-doitac-{a.draft}"
        head = ("> **CẢNH BÁO — KHÔNG đạt cổng, KHÔNG được trình duyệt:** "
                + "; ".join(res["problems"]) + "\n\n") if res["problems"] \
            else ""
        p_pay = write_report(head + res["payload"], REPORTS_DIR,
                             f"{stem}.md")
        p_int = write_report(res["internal"], REPORTS_DIR,
                             f"{stem}-noi-bo.md")
        print(f"[done] nháp hồ sơ → {p_pay} · nội bộ → {p_int} · chế độ "
              f"{res['mode']} · {NOT_SHARED} (chưa duyệt)")
        if not a.submit:
            return 0
        if (res["mode"] == "shadow"
                or clock.astimezone(VN_TZ).date() < GO_LIVE):
            print(f"[warn] --submit bị từ chối: shadow trước go-live "
                  f"{GO_LIVE:%d/%m/%Y}", file=sys.stderr)
            return 1
        if res["problems"]:
            print("[warn] --submit bị từ chối: " + "; ".join(res["problems"]),
                  file=sys.stderr)
            return 1
        try:
            qid = director.submit(
                conn, BLOCK, OBJECT_TYPE,
                object_id=f"partner:{a.draft}:{_sha16(res['payload'])}",
                title="Hồ sơ đối tác: " + _one(p["org_name"], 120),
                payload=res["payload"], created_by=CREATED_BY)
        except psycopg.errors.UniqueViolation:
            print(f"[warn] đối tác #{a.draft} đã có mục cùng nội dung đang "
                  "chờ duyệt", file=sys.stderr)
            return 1
        print(f"[done] mục #{qid} PENDING khối projects — {NOT_SHARED} tới "
              "khi người duyệt")
        return 0
    except DataError as e:
        print(f"[err] dữ liệu hồ sơ hỏng: {e}", file=sys.stderr)
        return 1
    except (psycopg.Error, director.DirectorConfigError) as e:
        print(f"[err] lỗi DB/cấu hình: {type(e).__name__}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    with job_run("agents.da_doitac") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
