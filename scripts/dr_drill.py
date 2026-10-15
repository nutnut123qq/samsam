"""Diễn tập khôi phục thảm họa (DR, v3.10 — luồng F17.4) trên Postgres MỚI.

Khác `db_restore_drill.py` (v3.6): bản đó khôi phục vào DB tạm trên CHÍNH
server đang chạy; bản này mô phỏng "mất server, dựng server mới" — chạy 1
container Postgres tạm từ image ĐÃ CÓ SẴN trên máy, khôi phục bản backup
mới nhất vào đó, so số dòng với manifest, đo RTO (gồm thời gian dựng
server) + RPO (tuổi bản backup), rồi LUÔN xóa container. Phần sha256/giải
mã/pg_restore/đếm/drop là `db_restore_drill.run_drill` (tái dùng).

Chạy: `python scripts/dr_drill.py [--backup <manifest>]`. Biến env (env
tiến trình hoặc `.env` root repo):
- `BACKUP_DIR` (BẮT BUỘC, ngoài repo) — nơi có bản backup + ghi
  `dr_runs.jsonl` (không DSN/mật khẩu/cổng).
- `BACKUP_PASSPHRASE_FILE` — khi bản backup đã mã hóa.
- `DATABASE_URL` — chỉ để guard tên DB; KHÔNG ghi gì vào server này.
- `DR_RPO_MAX_HOURS` (mặc định 24, số > 0) — mục tiêu RPO; pg_dump
  hằng ngày chỉ đạt ≤24h, RPO ≤15 phút cần PITR phía nhà cung cấp
  (external-dep).
- `DR_READY_TIMEOUT_S` (mặc định 60) — hạn chờ server mới sẵn sàng.

Docker: image `postgres:<major>-alpine` (major từ `server_version` trong
manifest), `docker run --rm --pull never` (KHÔNG tự tải image), cổng chỉ
bind 127.0.0.1, mật khẩu ngẫu nhiên mỗi lần truyền qua env tiến trình
(`-e POSTGRES_PASSWORD` không kèm giá trị → không nằm trong argv/log).
Data dir (VOLUME của image) mount `--tmpfs` → dữ liệu khôi phục chỉ nằm
trong RAM, không sinh anonymous volume; dọn bằng `docker rm -f -v` rồi
kiểm cả container lẫn volume của nó (volume còn → `cleanup_failed`).
Không có docker / daemon tắt / thiếu image → `[external-dep]`, exit 3,
không thử cách khác. Thấy container `samsam-dr-*` sót từ lần trước →
`[warn]` liệt kê (KHÔNG tự xóa container không phải của lần chạy này).

Exit: 0 khớp hết + RPO trong mục tiêu + container đã dọn; 1 lệch/lỗi/RPO
vượt mục tiêu/container chưa dọn; 2 usage/guard; 3 thiếu docker/image.

External-dep: VM diễn tập riêng (tách runner CI) thay container trên máy
dev; PITR ra instance tạm của nhà cung cấp cloud; người ký biên bản.
"""

import argparse
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg.conninfo import make_conninfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_backup as bk
import db_restore_drill as rd

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

PREFIX = "samsam-dr-"
RTO_TARGET_S = 4 * 3600
DOCKER_TIMEOUT_S = 120
PROBE_TIMEOUT_S = 20
DEFAULT_PGDATA = "/var/lib/postgresql/data"


def rpo_seconds(manifest: dict, now: datetime) -> float:
    """Tuổi bản backup tại `now` (giây) — RPO nếu thảm họa xảy ra lúc đó."""
    created = datetime.fromisoformat(manifest["created_at"])
    if created.tzinfo is None or now.tzinfo is None:
        raise ValueError("created_at/now phải có múi giờ")
    return round((now - created).total_seconds(), 2)


def _positive(raw: str | None, default: str, var: str) -> float:
    raw = (raw or "").strip() or default
    try:
        v = float(raw)
    except ValueError:
        raise bk.UsageError(f"{var} phải là số > 0") from None
    if not math.isfinite(v) or v <= 0:
        raise bk.UsageError(f"{var} phải là số > 0")
    return v


def container_name(now: datetime) -> str:
    return f"{PREFIX}{now:%Y%m%d_%H%M%S}-{secrets.token_hex(2)}"


def _docker(args: list[str], timeout: int = DOCKER_TIMEOUT_S, env=None):
    return subprocess.run(["docker", *args], capture_output=True,
                          timeout=timeout, check=False, env=env)


def probe_docker(image: str) -> str | None:
    """None nếu dùng được; ngược lại lý do (external-dep)."""
    if not shutil.which("docker"):
        return "không có docker CLI trên PATH"
    try:
        r = _docker(["version", "--format", "{{.Server.Version}}"],
                    timeout=PROBE_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return "docker daemon không phản hồi"
    if r.returncode != 0:
        return "docker daemon không chạy"
    if not bk._docker_has_image(image):
        return f"thiếu image {image} trên máy (KHÔNG tự pull — cần duyệt)"
    return None


def leftovers(prefix: str = PREFIX) -> list[str]:
    """Container sót theo tiền tố (mặc định DR; v10.3 vector_eval dùng
    `samsam-vec-`)."""
    try:
        r = _docker(["ps", "-a", "--filter", f"name={prefix}",
                     "--format", "{{.Names}}"], timeout=PROBE_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [n for n in r.stdout.decode("utf-8", "replace").split()
            if n.startswith(prefix)]


def image_volumes(image: str) -> list[str]:
    """Đường dẫn VOLUME image khai báo (postgres:17 = PGDATA) — mount tmpfs
    đè lên để dữ liệu khôi phục KHÔNG chạm đĩa (không sinh anonymous
    volume sót lại sau `rm -f`). Không đọc được → PGDATA mặc định."""
    try:
        r = _docker(["image", "inspect", "-f", "{{json .Config.Volumes}}",
                     image], timeout=PROBE_TIMEOUT_S)
        vols = (json.loads(r.stdout.decode("utf-8", "replace") or "null")
                if r.returncode == 0 else None)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        vols = None
    if not isinstance(vols, dict) or not vols:
        return [DEFAULT_PGDATA]
    return sorted(vols)


def container_volumes(name: str) -> set[str]:
    """Tên volume docker (named/anonymous) gắn vào container; rỗng nếu
    không có hoặc không đọc được (container đã mất)."""
    fmt = '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}'
    try:
        r = _docker(["inspect", "-f", fmt, name], timeout=PROBE_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if r.returncode != 0:
        return set()
    return set(r.stdout.decode("utf-8", "replace").split())


def cleanup(name: str, vols: set[str] = frozenset()) -> bool:
    """`docker rm -f -v` rồi kiểm lại `docker ps -a` + `docker volume ls`;
    True = container VÀ mọi volume của nó đã mất hẳn (volume còn = còn bản
    sao dữ liệu khôi phục trên đĩa, A04)."""
    vols = set(vols) | container_volumes(name)
    try:
        _docker(["rm", "-f", "-v", name], timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        r = _docker(["ps", "-a", "--filter", f"name=^/{name}$",
                     "--format", "{{.Names}}"], timeout=60)
        if r.returncode != 0 or name in r.stdout.decode(
                "utf-8", "replace").split():
            return False
        if not vols:
            return True
        v = _docker(["volume", "ls", "-q"], timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    left = vols & set(v.stdout.decode("utf-8", "replace").split())
    if left:
        print(f"[ALERT] volume của container DR còn trên đĩa: "
              f"{', '.join(sorted(left))} — `docker volume rm` tay ngay")
    return v.returncode == 0 and not left


def host_port(name: str) -> int:
    r = _docker(["port", name, "5432/tcp"], timeout=PROBE_TIMEOUT_S)
    m = re.search(r"127\.0\.0\.1:(\d+)", r.stdout.decode("utf-8", "replace"))
    if r.returncode != 0 or not m:
        raise RuntimeError("không đọc được cổng container (docker port)")
    return int(m.group(1))


def wait_ready(dsn: str, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            with psycopg.connect(dsn, connect_timeout=2) as c:
                c.execute("select 1")
            return
        except psycopg.Error:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"server DR chưa sẵn sàng sau "
                                   f"{timeout_s:g}s") from None
            time.sleep(0.5)


def run_dr(args, bdir: Path, dsn: str, now: datetime, rpo_max_h: float,
           ready_s: float) -> tuple[int, dict]:
    rec = {"ts": now.isoformat(), "backup_file": None, "container": None,
           "image": None, "status": "fail", "rto_seconds": None,
           "restore_rto_seconds": None, "rpo_seconds": None,
           "rpo_max_hours": rpo_max_h, "tables_checked": 0, "mismatches": {},
           "container_removed": None}
    # (0) Chọn manifest + major server.
    try:
        mpath, m = rd.pick_manifest(bdir, args.backup)
        major = re.match(r"\s*(\d+)", str(m["server_version"]))
        if not major:
            raise RuntimeError("manifest thiếu server_version hợp lệ")
        rec["backup_file"] = m["file"]
        rec["rpo_seconds"] = rpo_seconds(m, now)
    except (RuntimeError, ValueError) as e:
        rec["error"] = bk.scrub(e, dsn)
        print(f"[err] {rec['error']}")
        return 1, rec
    image = f"postgres:{major.group(1)}-alpine"
    rec["image"] = image
    # (1) Docker + image có sẵn — không có thì dừng (external-dep).
    why = probe_docker(image)
    if why:
        rec["status"] = "khong_chay"
        rec["error"] = why
        print(f"[external-dep] DR drill không chạy được: {why}")
        return 3, rec
    old = leftovers()
    if old:
        print(f"[warn] container DR sót từ lần trước (KHÔNG tự xóa — kiểm "
              f"rồi `docker rm -f` tay): {', '.join(old)}")
    name = container_name(now)
    rec["container"] = name
    password = secrets.token_urlsafe(24)
    server = None
    vols: set[str] = set()
    code = 1
    t0 = time.monotonic()
    try:
        # (2) Dựng server mới — mật khẩu qua env, không argv; data dir là
        # tmpfs (RAM) → không anonymous volume, không bản sao trên đĩa.
        tmpfs = [a for p in image_volumes(image) for a in ("--tmpfs", p)]
        r = _docker(["run", "-d", "--rm", "--pull", "never", "--name", name,
                     *tmpfs, "-e", "POSTGRES_PASSWORD",
                     "-p", "127.0.0.1::5432", image],
                    env={**os.environ, "POSTGRES_PASSWORD": password})
        if r.returncode != 0:
            raise RuntimeError("docker run lỗi: " + r.stderr.decode(
                "utf-8", "replace"))
        # Volume (nếu image/daemon vẫn tạo) ghi nhận NGAY — `--rm` có thể
        # xóa container trước cleanup → không còn inspect được.
        vols = container_volumes(name)
        # (3) Cổng + chờ sẵn sàng.
        server = make_conninfo("", host="127.0.0.1", port=host_port(name),
                               user="postgres", password=password,
                               dbname="postgres")
        wait_ready(server, ready_s)
        print(f"[dr] server mới {image} sẵn sàng sau "
              f"{time.monotonic() - t0:.1f}s — khôi phục {m['file']}")
        # (4) Khôi phục + đếm + drop: code v3.6.
        dcode, drec = rd.run_drill(argparse.Namespace(
            backup=str(mpath), target_db=None), bdir, dsn,
            drill_server=server)
        rec["rto_seconds"] = round(time.monotonic() - t0, 2)
        rec["restore_rto_seconds"] = drec.get("rto_seconds")
        rec["tables_checked"] = drec.get("tables_checked", 0)
        rec["mismatches"] = drec.get("mismatches", {})
        if drec.get("error"):
            rec["error"] = bk.scrub(drec["error"], server)
        st = drec.get("status")
        rec["status"] = st if st in ("ok", "mismatch", "refused") else "fail"
        code = dcode
        if dcode == 0:
            rpo_ok = rec["rpo_seconds"] <= rpo_max_h * 3600
            rto_ok = rec["rto_seconds"] <= RTO_TARGET_S
            print(f"[dr] RTO {rec['rto_seconds']}s (gồm dựng server; "
                  f"restore {rec['restore_rto_seconds']}s) — mục tiêu ≤ 4h:"
                  f" {'đạt' if rto_ok else 'VƯỢT'}")
            print(f"[dr] RPO {rec['rpo_seconds'] / 3600:.2f}h (tuổi bản "
                  f"backup) — mục tiêu ≤ {rpo_max_h:g}h: "
                  f"{'đạt' if rpo_ok else 'VƯỢT'}")
            if not rpo_ok:
                rec["status"] = "rpo_breach"
                code = 1
    except (RuntimeError, OSError, psycopg.Error,
            subprocess.TimeoutExpired) as e:
        rec["error"] = bk.scrub(e, server)
        print(f"[err] DR drill lỗi: {rec['error']}")
        code = 1
    finally:
        # (6) LUÔN dọn container — kể cả KeyboardInterrupt/lỗi bất kỳ.
        rec["container_removed"] = cleanup(name, vols)
        if not rec["container_removed"]:
            rec["status"] = "cleanup_failed"
            print(f"[ALERT] container DR {name} chưa dọn — còn bản sao dữ "
                  f"liệu; chạy `docker rm -f -v {name}` ngay")
            code = 1
    return code, rec


@bk.private_umask
def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--backup", help="đường dẫn manifest (mặc định: mới nhất)")
    args = ap.parse_args(argv)
    # .env nạp TRƯỚC khi đọc biến (cùng lý do db_backup.main).
    load_dotenv(bk.ROOT / ".env")
    try:
        bdir = bk.dir_outside_repo(os.environ.get("BACKUP_DIR"), "BACKUP_DIR")
        rpo_max_h = _positive(os.environ.get("DR_RPO_MAX_HOURS"), "24",
                              "DR_RPO_MAX_HOURS")
        ready_s = _positive(os.environ.get("DR_READY_TIMEOUT_S"), "60",
                            "DR_READY_TIMEOUT_S")
    except bk.UsageError as e:
        print(f"[usage] {e}")
        return 2
    if not bdir.is_dir():
        print("[usage] BACKUP_DIR không tồn tại")
        return 2
    now = now if now is not None else bk.vn_now()
    dsn = os.environ.get("DATABASE_URL") or ""
    code, rec = run_dr(args, bdir, dsn, now, rpo_max_h, ready_s)
    bk.append_jsonl(bdir / "dr_runs.jsonl", rec)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
