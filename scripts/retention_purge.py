"""v13.4 C05 — Job xóa dữ liệu cá nhân quá hạn lưu (CV / ảnh-video vườn /
ghi âm vườn) theo `data/retention.json`.

Contract:
  - `ttl_days = null` = CHƯA CHỐT → mục đó KHÔNG xóa gì (in `[blocked]`) và
    `scripts/health_bulletin.py` cảnh báo hằng ngày (`status_lines`). Không
    có TTL mặc định; agent không tự điền.
  - Cấu hình hỏng (id trùng, TTL không phải số nguyên ≥ 1, loại kho lạ) →
    exit 2, KHÔNG xóa gì.
  - Có TTL: chỉ xóa FILE quá hạn — CV theo mtime file (cấp 1 của
    `HR_INBOX_DIR`, đúng đuôi, bỏ symlink/thư mục con); ảnh/video theo
    `garden_media.created_at`, TRỪ sha đã gắn hồ sơ lô QR (`lot_origins`);
    ghi âm theo `received_at` và CHỈ nháp `da_chep_loi` (nháp chưa chép
    quá hạn → cảnh báo, không xóa). Dòng metadata DB giữ nguyên (không
    PII). Kho nằm trong repo → bỏ mục đó (lỗi).
  - Thứ tự an toàn: liệt kê → ghi `agent_action_log` (action
    `retention_purge`, chỉ id mục + TTL + số file + sha256[:12], KHÔNG tên
    file) và COMMIT → mới xóa từng file (`os.remove`, từng file nguyên tử);
    file xóa lỗi → dòng log thứ hai `retention_purge_failed`. Không bao giờ
    có file bị xóa mà chưa có log. DB không kết nối được → exit 2, 0 xóa.
  - `--dry-run`: chỉ in số file sẽ xóa, không ghi log, không xóa (vẫn cần DB
    cho ảnh/ghi âm).

Chạy: `python scripts/retention_purge.py [--dry-run]`
Exit: 0 xong (kể cả mọi TTL null) · 1 có file/mục lỗi · 2 cấu hình hỏng /
DB down.
"""

import argparse
import hashlib
import json
import os
import sys
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest.lead_store import connect

# Console Windows mặc định cp1258 — ép UTF-8 (no-op nếu đã UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "retention.json"
KINDS = ("thu_muc", "garden_media", "garden_voice", "khong_luu_ban_sao")
ACTOR = "job:retention_purge"
MAX_LOG_IDS = 200


class RetentionError(Exception):
    """Cấu hình retention hỏng — không xóa gì."""


def load_config(path: Path | None = None) -> list[dict]:
    """→ danh sách mục đã kiểm. Hỏng → RetentionError."""
    path = path or CONFIG
    try:
        obj = json.loads(Path(path).read_bytes())
    except (OSError, ValueError) as e:
        raise RetentionError(f"không đọc được {Path(path).name} "
                             f"({type(e).__name__})") from e
    items = obj.get("muc") if isinstance(obj, dict) else None
    if not isinstance(items, list) or not items:
        raise RetentionError("thiếu mảng 'muc'")
    seen = set()
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise RetentionError(f"muc[{i}] sai dạng")
        iid, ttl, kho = it.get("id"), it.get("ttl_days"), it.get("kho")
        if not isinstance(iid, str) or not iid or iid in seen:
            raise RetentionError(f"muc[{i}] id rỗng/trùng")
        seen.add(iid)
        # bool là int trong Python — True không được thành 1 ngày.
        if ttl is not None and (isinstance(ttl, bool)
                                or not isinstance(ttl, int) or ttl < 1):
            raise RetentionError(f"{iid}: ttl_days phải null hoặc số "
                                 f"nguyên ≥ 1")
        if not isinstance(kho, dict) or kho.get("loai") not in KINDS:
            raise RetentionError(f"{iid}: kho.loai phải thuộc {KINDS}")
        if kho["loai"] != "khong_luu_ban_sao" and not kho.get("env"):
            raise RetentionError(f"{iid}: thiếu kho.env")
        if kho["loai"] == "thu_muc" and not (
                isinstance(kho.get("duoi"), list) and kho["duoi"]):
            raise RetentionError(f"{iid}: thiếu kho.duoi")
    return items


def status_lines(items: list[dict]) -> list[str]:
    """Dòng tình trạng cho bản tin sức khỏe (không DB)."""
    out = []
    for it in items:
        name = f"`{it['id']}` ({it.get('ten', '')})"
        if it["ttl_days"] is None:
            out.append(f"- CẢNH BÁO {name}: CHƯA CHỐT hạn lưu — job không "
                       f"xóa gì; người chốt: "
                       f"{it.get('owner') or 'chưa rõ'} (điền số ngày "
                       "trong `data/retention.json`)")
        elif it["kho"]["loai"] == "khong_luu_ban_sao":
            out.append(f"- {name}: hạn {it['ttl_days']} ngày — hệ thống "
                       "không giữ bản sao file, không có gì để xóa")
        else:
            out.append(f"- {name}: giữ {it['ttl_days']} ngày — job "
                       "`python scripts/retention_purge.py`")
    return out


def _store(kho: dict) -> Path:
    d = (os.environ.get(kho["env"]) or "").strip()
    if not d:
        raise RetentionError(f"thiếu env {kho['env']}")
    p, root = Path(d).resolve(), ROOT.resolve()
    if p == root or p.is_relative_to(root):
        raise RetentionError(f"{kho['env']} nằm trong repo — bỏ qua")
    return p


def _sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(1 << 20):
            h.update(block)
    return h.hexdigest()


def candidates(conn, item: dict, now: datetime) -> tuple[list, int]:
    """(danh sách (sha12, Path) quá hạn, số ghi âm quá hạn CHƯA chép)."""
    kho, cutoff = item["kho"], now - timedelta(days=item["ttl_days"])
    if kho["loai"] == "khong_luu_ban_sao":
        return [], 0
    base = _store(kho)
    if kho["loai"] == "thu_muc":
        exts = {e.lower() for e in kho["duoi"]}
        out = []
        if base.is_dir():
            for f in sorted(base.iterdir()):
                if (f.is_symlink() or not f.is_file()
                        or f.suffix.lower() not in exts):
                    continue
                mtime = datetime.fromtimestamp(f.stat().st_mtime,
                                               timezone.utc)
                if mtime < cutoff:
                    out.append((_sha_file(f)[:12], f))
        return out, 0
    if kho["loai"] == "garden_media":
        rows = conn.execute(
            "select m.sha256, m.ext from garden_media m"
            " where m.created_at < %s and not exists (select 1 from"
            " lot_origins o where m.sha256 = any(o.media_sha256))"
            " order by m.id", (cutoff,)).fetchall()
        return [(s[:12], base / s[:2] / f"{s}.{x}") for s, x in rows
                if (base / s[:2] / f"{s}.{x}").is_file()], 0
    rows = conn.execute(
        "select sha256, ext, status from garden_voice_drafts"
        " where received_at < %s order by id", (cutoff,)).fetchall()
    audio = base / "audio"
    done = [(s[:12], audio / s[:2] / f"{s}.{x}") for s, x, st in rows
            if st == "da_chep_loi" and (audio / s[:2] / f"{s}.{x}").is_file()]
    return done, sum(st == "cho_chep_loi" for _, _, st in rows)


def _log(conn, action: str, item: dict, ids: list[str], **extra) -> None:
    conn.execute(
        "insert into agent_action_log (actor, action, object_type,"
        " object_id, detail) values (%s, %s, 'retention', %s, %s)",
        (ACTOR, action, item["id"],
         Jsonb({"ttl_days": item["ttl_days"], "n": len(ids),
                "sha12": ids[:MAX_LOG_IDS], **extra})))
    conn.commit()


def purge_item(conn, item: dict, now: datetime, dry_run: bool) -> dict:
    """1 mục có TTL → {"n", "deleted", "failed", "pending_voice"}. Log
    COMMIT trước khi xóa file."""
    files, pending = candidates(conn, item, now)
    res = {"n": len(files), "deleted": 0, "failed": 0,
           "pending_voice": pending}
    if dry_run or not files:
        return res
    _log(conn, "retention_purge", item, [s for s, _ in files])
    failed = []
    for sha12, f in files:
        try:
            os.remove(f)
            res["deleted"] += 1
        except OSError:
            failed.append(sha12)
    if failed:
        res["failed"] = len(failed)
        _log(conn, "retention_purge_failed", item, failed)
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python scripts/retention_purge.py",
        description="Xóa file dữ liệu cá nhân quá hạn lưu theo "
                    "data/retention.json (TTL null = chưa chốt, không xóa)")
    ap.add_argument("--dry-run", action="store_true",
                    help="chỉ đếm, không ghi log, không xóa")
    args = ap.parse_args(argv)
    try:
        items = load_config()
    except RetentionError as e:
        print(f"[err] {e} — không xóa gì", file=sys.stderr)
        return 2
    for line in status_lines(items):
        print(line)
    todo = [it for it in items if it["ttl_days"] is not None
            and it["kho"]["loai"] != "khong_luu_ban_sao"]
    if not todo:
        print("[blocked] chưa mục nào được chốt hạn lưu — không xóa gì")
        return 0
    conn = connect()
    if conn is None:
        print("[err] không kết nối được Postgres — không xóa gì (cần ghi "
              "log trước khi xóa)", file=sys.stderr)
        return 2
    rc, now = 0, datetime.now(timezone.utc)
    try:
        for it in todo:
            try:
                r = purge_item(conn, it, now, args.dry_run)
            except (RetentionError, OSError, psycopg.Error) as e:
                with suppress(Exception):
                    conn.rollback()
                why = e if isinstance(e, RetentionError) \
                    else type(e).__name__
                print(f"[err] {it['id']}: {why}", file=sys.stderr)
                rc = 1
                continue
            verb = "sẽ xóa" if args.dry_run else "đã xóa"
            done = r["n"] if args.dry_run else r["deleted"]
            print(f"[{it['id']}] {verb} {done}/{r['n']} file quá "
                  f"{it['ttl_days']} ngày"
                  + (f", lỗi {r['failed']}" if r["failed"] else "")
                  + (f"; CẢNH BÁO {r['pending_voice']} ghi âm quá hạn chưa "
                     "chép lời (không xóa)" if r["pending_voice"] else ""))
            if r["failed"]:
                rc = 1
    finally:
        with suppress(Exception):
            conn.close()
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
