"""r13 data_platform-90 — kiểm SẴN SÀNG hạ tầng on-prem trên CHÍNH máy chạy lệnh (server Bên B), chỉ báo ĐẠT cho điều kiện ĐO
ĐƯỢC tại thời điểm chạy; không đọc bằng chứng cũ/tệp mẫu, không sửa gì, không cài/khởi động dịch vụ.

  python scripts/onprem_preflight.py [--out FILE.md] [--min-free-gb 50] [--max-backup-age-h 26]

Đo (mỗi mục DAT / CHUA_DAT / KHONG_AP_DUNG):
  db            DATABASE_URL kết nối được (dbname tường minh), major server, `pg_dump` cùng major tìm được
  dich_vu       4 login dịch vụ WEBHOOK_/JOB_/LOADER_/BACKUP_DATABASE_URL: có biến, kết nối được, KHÔNG superuser/owner,
                thuộc đúng role svc_* (đo trực tiếp, không phụ thuộc AUTH_MODE)
  sao_luu       BACKUP_DIR ngoài repo, tồn tại, ghi được, trống ≥ --min-free-gb; BACKUP_REQUIRE_ENCRYPTION=1 + có
                BACKUP_PASSPHRASE_FILE; offsite `dir:` khác thiết bị (st_dev); bản backup gần nhất trong sổ
                backup_runs.jsonl ok + mới hơn --max-backup-age-h giờ (không ở tương lai) + manifest hợp lệ mã hóa +
                tệp dump THẬT khớp size/sha256 manifest ở CẢ BACKUP_DIR lẫn offsite `dir:` (r13-fix4)
  lich          Linux systemd: mọi timer trong deploy/onprem/jobs.json có unit đã cài trong /etc/systemd/system
Không đo được từ trong máy → luôn CHUA_XAC_NHAN (Bên B ký): máy chủ vật lý/UPS, máy giám sát ĐỘC LẬP, máy offsite là máy khác,
người giữ tài khoản cao nhất. Kết quả gắn hostname + machine-id + thời điểm (giờ máy) — không dùng cho máy khác.
Chỉ đọc biến môi trường TIẾN TRÌNH (vd EnvironmentFile của systemd) — KHÔNG nạp `.env`, không có DSN mặc định.
Exit: 0 mọi mục ĐO được đều ĐẠT (vẫn còn mục chờ Bên B xác nhận) · 1 có mục đo được CHƯA ĐẠT · 2 tham số sai.
"""
import argparse
import json
import os
import platform
import shutil
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg import conninfo

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
NGOAI = ("may chu vat ly + UPS", "may giam sat DOC LAP (ngoai server)", "may offsite la MAY KHAC",
         "nguoi giu tai khoan cao nhat")


def _machine_id() -> str:
    for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            return Path(p).read_text().strip()[:32]
        except OSError:
            pass
    return "khong-co"


def check_db(env) -> tuple[str, str, int | None]:
    dsn = (env.get("DATABASE_URL") or "").strip()
    if not dsn:
        return "CHUA_DAT", "thiếu DATABASE_URL", None
    if not conninfo.conninfo_to_dict(dsn).get("dbname"):
        return "CHUA_DAT", "DATABASE_URL thiếu dbname tường minh", None
    try:
        with psycopg.connect(dsn, connect_timeout=5) as c:
            major = c.info.server_version // 10000
    except psycopg.Error as e:
        return "CHUA_DAT", f"không kết nối được ({type(e).__name__})", None
    pg_bin = (env.get("PG_BIN") or "").strip()
    cands = [Path(pg_bin) / "pg_dump"] if pg_bin else []
    cands += [Path(w) for w in [shutil.which("pg_dump")] if w]
    cands.append(Path(f"C:/Program Files/PostgreSQL/{major}/bin/pg_dump.exe"))
    found = next((c for c in cands if c.is_file() or c.with_suffix(".exe").is_file()), None)
    note = f"server PG {major}; pg_dump: {found or 'không tìm thấy (PG_BIN/PATH)'}"
    return ("DAT" if found else "CHUA_DAT"), note, major


def check_services(env) -> list[tuple[str, str, str]]:
    from pipelines import auth
    out = []
    for svc, (var, role) in auth.SERVICES.items():
        dsn = (env.get(var) or "").strip()
        if not dsn:
            out.append((f"dich_vu:{svc}", "CHUA_DAT", f"thiếu {var}"))
            continue
        try:
            with psycopg.connect(dsn, connect_timeout=5) as c:
                bad = auth.privileged_login(c)
                member = c.execute("select pg_has_role(current_user, %s, 'member')", (role,)).fetchone()[0]
        except psycopg.Error as e:
            out.append((f"dich_vu:{svc}", "CHUA_DAT", f"{var}: không kết nối được ({type(e).__name__})"))
            continue
        if bad:
            out.append((f"dich_vu:{svc}", "CHUA_DAT", f"{var}: {bad}"))
        elif not member:
            out.append((f"dich_vu:{svc}", "CHUA_DAT", f"{var}: login không thuộc role {role}"))
        else:
            out.append((f"dich_vu:{svc}", "DAT", f"{var}: login riêng thuộc {role}"))
    return out


def check_backup(env, min_free_gb: float, max_age_h: float, now: datetime) -> list[tuple[str, str, str]]:
    from scripts import db_backup
    out = []
    try:
        cfg = db_backup.read_config(env)
    except db_backup.UsageError as e:
        return [("sao_luu:cau_hinh", "CHUA_DAT", str(e))]
    d = cfg["dir"]
    ok_dir = d.is_dir() and os.access(d, os.W_OK)
    free = shutil.disk_usage(d).free / 2**30 if d.is_dir() else 0.0
    out.append(("sao_luu:thu_muc", "DAT" if ok_dir and free >= min_free_gb else "CHUA_DAT",
                f"tồn tại+ghi được: {ok_dir}; trống {free:.1f} GB (cần ≥ {min_free_gb:g})"))
    enc = cfg["passfile"] is not None and (env.get("BACKUP_REQUIRE_ENCRYPTION") or "").strip() == "1"
    out.append(("sao_luu:ma_hoa_bat_buoc", "DAT" if enc else "CHUA_DAT",
                "BACKUP_REQUIRE_ENCRYPTION=1 + có tệp khóa" if enc else "chưa bắt buộc mã hóa / thiếu tệp khóa"))
    off = cfg["offsite"]
    if off is None or off[0] != "dir":
        out.append(("sao_luu:offsite", "CHUA_DAT", "chưa cấu hình offsite dir: (s3 chưa hỗ trợ)"))
    else:
        other = not db_backup.same_device(d, off[1])
        out.append(("sao_luu:offsite", "DAT" if other else "CHUA_DAT",
                    "offsite khác thiết bị lưu trữ" if other else "offsite CÙNG thiết bị với BACKUP_DIR"))
    last = None
    log = d / "backup_runs.jsonl"
    if log.is_file():
        for line in log.read_bytes().split(b"\n"):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                last = rec
    if last is None:
        out.append(("sao_luu:ban_gan_nhat", "CHUA_DAT", "chưa có bản backup nào trong sổ"))
    else:
        probs = _latest_problems(d, off, last, max_age_h, now)
        out.append(("sao_luu:ban_gan_nhat", "DAT" if not probs else "CHUA_DAT",
                    "; ".join(probs) if probs else
                    f"status=ok; {last['file']} mã hóa; dump local + offsite đo khớp size/sha256 manifest"))
    return out


CLOCK_SKEW_H = 5 / 60     # sổ ghi muộn hơn giờ máy quá mức này = thời điểm tương lai, không phải bản mới


def _copy_problems(folder: Path, m: dict, where: str) -> list[str]:
    """Đo tệp dump THẬT trong `folder` so manifest (size_bytes + sha256)."""
    from scripts import db_backup
    f = folder / m["file"]
    if not f.is_file():
        return [f"{where}: thiếu tệp dump {m['file']}"]
    if f.stat().st_size != m["size_bytes"]:
        return [f"{where}: kích thước tệp dump lệch manifest"]
    if db_backup.sha256_file(f) != m["sha256"]:
        return [f"{where}: sha256 tệp dump lệch manifest"]
    return []


def _latest_problems(d: Path, off, last: dict, max_age_h: float, now: datetime) -> list[str]:
    """r13-fix4 F3: bản gần nhất trong sổ chỉ ĐẠT khi tệp dump + manifest (định dạng `db_backup.load_manifest`) tồn tại
    và khớp ở CẢ BACKUP_DIR lẫn offsite `dir:` cấu hình — sổ/manifest một mình không chứng minh có bản sao."""
    from scripts import db_backup
    probs = []
    if last.get("status") != "ok":
        probs.append(f"status={last.get('status')}")
    try:
        at = datetime.fromisoformat(str(last.get("ts")))
        age = (now - (at if at.tzinfo else at.replace(tzinfo=timezone.utc))).total_seconds() / 3600
    except ValueError:
        age = None
    if age is None:
        probs.append("thời điểm trong sổ không đọc được")
    elif age < -CLOCK_SKEW_H:
        probs.append(f"thời điểm trong sổ ở tương lai ({-age:.1f} giờ)")
    elif age > max_age_h:
        probs.append(f"cách {age:.1f} giờ (> {max_age_h:g})")
    if last.get("offsite") is None:
        probs.append("sổ chưa ghi offsite xong")
    fname = last.get("file")
    m = (db_backup.load_manifest(d / (fname + db_backup.MANIFEST_SUFFIX))
         if isinstance(fname, str) and fname else None)
    if m is None:
        return probs + ["manifest local thiếu/hỏng — không kiểm được tệp dump"]
    if m["encrypted"] is not True:
        probs.append("bản dump chưa mã hóa")
    if last.get("sha256") not in (None, m["sha256"]):
        probs.append("sha256 trong sổ lệch manifest")
    probs += _copy_problems(d, m, "local")
    if off is None or off[0] != "dir":
        return probs + ["chưa cấu hình offsite dir: — không kiểm được bản sao"]
    om = db_backup.load_manifest(off[1] / (fname + db_backup.MANIFEST_SUFFIX))
    if om is None or (om["sha256"], om["size_bytes"]) != (m["sha256"], m["size_bytes"]):
        probs.append("offsite: manifest thiếu/hỏng/lệch bản local")
    return probs + _copy_problems(off[1], m, "offsite")


def check_timers() -> tuple[str, str, str]:
    if platform.system() != "Linux":
        return ("lich:systemd", "KHONG_AP_DUNG", f"hệ điều hành {platform.system()} — không phải server systemd")
    jobs = json.loads((ROOT / "deploy" / "onprem" / "jobs.json").read_text(encoding="utf-8"))
    names = [k for k in jobs["jobs"] if not k.startswith("_")]
    missing = [n for n in names if not Path(f"/etc/systemd/system/samsam-job-{n}.timer").is_file()]
    return ("lich:systemd", "DAT" if not missing else "CHUA_DAT",
            "đủ timer" if not missing else f"thiếu {len(missing)} timer: {', '.join(missing[:8])}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/onprem_preflight.py", description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path)
    ap.add_argument("--min-free-gb", type=float, default=50.0)
    ap.add_argument("--max-backup-age-h", type=float, default=26.0)
    a = ap.parse_args(argv)
    if a.min_free_gb < 0 or a.max_backup_age_h <= 0:
        ap.error("ngưỡng không hợp lệ")
    env = os.environ
    now = datetime.now(timezone.utc)
    db_st, db_note, _major = check_db(env)
    rows = [("db", db_st, db_note), *check_services(env),
            *check_backup(env, a.min_free_gb, a.max_backup_age_h, now), check_timers()]
    measured_bad = [r for r in rows if r[1] == "CHUA_DAT"]
    head = [f"# Preflight on-prem — {socket.gethostname()} (machine-id {_machine_id()}) · {now:%Y-%m-%d %H:%M}Z", "",
            "| Mục | Kết quả | Chi tiết (đo tại máy này) |", "|---|---|---|"]
    body = [f"| {k} | {st} | {note} |" for k, st, note in rows]
    tail = ["", "Không đo được từ trong máy — CHUA_XAC_NHAN (Bên B ký biên bản): " + "; ".join(NGOAI), "",
            ("KẾT LUẬN: mọi mục đo được ĐẠT — vẫn CHƯA sẵn sàng tới khi Bên B xác nhận các mục trên"
             if not measured_bad else f"KẾT LUẬN: CHƯA SẴN SÀNG — {len(measured_bad)} mục đo được chưa đạt")]
    text = "\n".join(head + body + tail) + "\n"
    if a.out:
        a.out.write_text(text, encoding="utf-8")
    print(text)
    return 1 if measured_bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
