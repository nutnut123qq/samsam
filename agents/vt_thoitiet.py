"""v10.2 W102.4 — VT Agent Cảnh báo thời tiết & sâu bệnh (khối Vùng trồng,
WP16).

Contract:
  - Cấu hình `data/weather_config.json` (GIẢ ĐỊNH — GĐ vùng trồng chốt
    ngưỡng + gán khoảnh→vùng): tọa độ VÙNG đã làm tròn 0,1° (sai → lỗi
    cấu hình, exit 1). `load_config` fail-closed.
  - Nguồn dự báo: CSV nhập tay `area_code,day,rain_mm,tmin_c,tmax_c`
    (`read_csv` — có lỗi → 0 xử lý, không connect; lỗi in dòng+cột, KHÔNG
    in giá trị) hoặc `--fetch` CHỈ khi `fetch.enabled is True` (mặc định
    false — điều khoản nhà cung cấp chưa xác minh): mỗi vùng 1 GET qua
    `crawler.intel.Fetcher` (robots, ≥1s/host, ngân sách, chặn sàn/MXH/tầng
    C, log `[req]`); lỗi/robots cấm/hết ngân sách → vùng "chưa có dự báo".
  - `evaluate`: mưa > ngưỡng → `mua_lon`; nhiệt thấp nhất < ngưỡng → `ret`
    (bằng ngưỡng KHÔNG cảnh báo).
  - Sâu bệnh: `plot_logs` trong `flag_days` ngày → `garden_director.
    log_flags(detail)` (CHỈ detail) → "cần đi kiểm tra".
  - Digest TEMPLATE tất định theo khoảnh: chỉ "cần đi kiểm tra" — KHÔNG
    chẩn đoán, KHÔNG liều lượng/hoạt chất/tên thuốc, KHÔNG tọa độ/vị trí/
    diện tích/người ghi; qua `guardrail.check` ok mới ghi file
    `data/reports/vt-canh-bao-<ngày VN>.md`.
  - `--submit` (chỉ khi có cảnh báo/cờ): `director.submit("farming",
    "weather_digest")` PENDING — GĐ vùng trồng duyệt = "đã xem"; trùng
    pending → bỏ qua. Agent không gửi/đăng gì, 0 LLM.

Chạy:
  python -m agents.vt_thoitiet --digest (--from-csv FILE | --fetch
      [--max-requests N]) [--submit] [--date YYYY-MM-DD]
Exit: 0 ok · 1 cấu hình/CSV lỗi, guardrail chặn, lỗi DB khi submit ·
2 tham số sai / fetch chưa bật.
"""

import argparse
import csv
import io
import ipaddress
import json
import math
import re
import sys
import time
from contextlib import suppress
from datetime import date, datetime, timedelta
from datetime import time as dtime
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from agents.garden_director import log_flags
from agents.report import REPORTS_DIR, write_report
from crawler import intel
from ingest.lead_store import connect
from pipelines import director, guardrail
from pipelines.job_runs import job_run
from pipelines.period import VN_TZ

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "weather_config.json"
BLOCK = "farming"
OBJECT_TYPE = "weather_digest"
CREATED_BY = "agent:VT"
FETCH_SOURCE = "vt_thoitiet"
CSV_HEADER = ["area_code", "day", "rain_mm", "tmin_c", "tmax_c"]
CSV_MAX = 1_000_000
RAIN_RANGE = (0.0, 1000.0)
TEMP_RANGE = (-20.0, 50.0)
DEFAULT_MAX_REQ = 20
_CODE_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
_PLOT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
# Ký tự markdown/HTML trong mã khoảnh lấy từ DB → escape khi vào digest.
_MD_RE = re.compile(r"([\\`\[\]<>!*_|])")
_LOCAL_SUFFIX = (".localhost", ".local", ".internal", ".lan")
KIND_TEXT = {"mua_lon": "kiểm tra thoát nước", "ret": "kiểm tra che chắn"}


class ConfigError(Exception):
    """weather_config.json thiếu/hỏng — fail-closed."""


class SourceError(ValueError):
    """Dữ liệu dự báo hỏng (JSON/mảng thiếu/độ dài lệch/giá trị lạ)."""


def _num(v) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v))


def _round01(v) -> bool:
    return abs(v * 10 - round(v * 10)) < 1e-6


def load_config(path=None) -> dict:
    p = Path(path) if path is not None else CONFIG_FILE
    try:
        cfg = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError as e:
        raise ConfigError(f"không có file {p.name}") from e
    except (OSError, ValueError) as e:
        raise ConfigError(f"{p.name} hỏng: {type(e).__name__}") from e
    if not isinstance(cfg, dict):
        raise ConfigError("gốc phải là object")
    areas = cfg.get("areas")
    if not isinstance(areas, list) or not areas:
        raise ConfigError("areas rỗng/sai kiểu")
    codes, plots = set(), set()
    for i, a in enumerate(areas):
        if not isinstance(a, dict):
            raise ConfigError(f"areas[{i}] phải là object")
        c = a.get("code")
        if not isinstance(c, str) or not _CODE_RE.fullmatch(c) or c in codes:
            raise ConfigError(f"areas[{i}].code thiếu/sai dạng/trùng")
        codes.add(c)
        if not isinstance(a.get("name"), str) or not a["name"].strip():
            raise ConfigError(f"areas[{i}].name thiếu")
        for k, lim in (("lat", 90), ("lon", 180)):
            v = a.get(k)
            if not _num(v) or abs(v) > lim or not _round01(v):
                raise ConfigError(f"areas[{i}].{k} phải là số |v|≤{lim} "
                                  "đã làm tròn 0,1°")
        ps = a.get("plots")
        if (not isinstance(ps, list) or not all(
                isinstance(x, str) and _PLOT_RE.fullmatch(x) for x in ps)
                or plots & set(ps) or len(set(ps)) != len(ps)):
            raise ConfigError(f"areas[{i}].plots sai/trùng khoảnh")
        plots |= set(ps)
    th = cfg.get("thresholds")
    if (not isinstance(th, dict) or not _num(th.get("rain_mm_day"))
            or not RAIN_RANGE[0] <= th["rain_mm_day"] <= RAIN_RANGE[1]
            or not _num(th.get("tmin_c"))
            or not TEMP_RANGE[0] <= th["tmin_c"] <= TEMP_RANGE[1]):
        raise ConfigError("thresholds.rain_mm_day/tmin_c thiếu/ngoài khoảng")
    f = cfg.get("fetch")
    if (not isinstance(f, dict) or not isinstance(f.get("enabled"), bool)
            or not isinstance(f.get("url_template"), str)
            or not f["url_template"].startswith("https://")
            or "{lat}" not in f["url_template"]
            or "{lon}" not in f["url_template"]
            or isinstance(f.get("days"), bool)
            or not isinstance(f.get("days"), int) or not 1 <= f["days"] <= 16):
        raise ConfigError("fetch.enabled/url_template/days sai")
    try:   # placeholder lạ ({x}, {0}) → lỗi cấu hình, không crash lúc fetch
        host = (urlsplit(f["url_template"].format(lat="0.0", lon="0.0",
                                                  days=1)).hostname or "")
    except (KeyError, IndexError, ValueError, AttributeError) as e:
        raise ConfigError("fetch.url_template có placeholder lạ") from e
    if _internal_host(host):
        raise ConfigError("fetch.url_template phải là host công khai "
                          "(không IP/localhost/mạng nội bộ — chống SSRF)")
    fd = cfg.get("flag_days")
    if isinstance(fd, bool) or not isinstance(fd, int) or not 1 <= fd <= 60:
        raise ConfigError("flag_days phải 1..60")
    return cfg


def _internal_host(host: str) -> bool:
    """IP literal / localhost / hậu tố mạng nội bộ → True (chặn SSRF)."""
    h = host.strip(".").lower()
    if not h or "." not in h or h == "localhost" or h.endswith(_LOCAL_SUFFIX):
        return True
    try:
        ipaddress.ip_address(h)
    except ValueError:
        return False
    return True


def _md(s) -> str:
    return _MD_RE.sub(r"\\\1", str(s))


def _parse_row(area, day, rain, tmin, tmax) -> dict:
    """Giá trị thô → row chuẩn; sai → SourceError(tên cột)."""
    try:
        d = date.fromisoformat(str(day).strip())
    except ValueError:
        raise SourceError("day") from None
    vals = {}
    for col, v, (lo, hi) in (("rain_mm", rain, RAIN_RANGE),
                             ("tmin_c", tmin, TEMP_RANGE),
                             ("tmax_c", tmax, TEMP_RANGE)):
        try:
            x = float(str(v).strip()) if not _num(v) else float(v)
        except ValueError:
            raise SourceError(col) from None
        if not math.isfinite(x) or not lo <= x <= hi:
            raise SourceError(col)
        vals[col] = x
    return {"area": area, "day": d, **vals}


def read_csv(path, area_codes) -> tuple[list[dict], list[str]]:
    """CSV nhập tay → (rows, errors). Có lỗi → caller KHÔNG xử lý gì."""
    p = Path(path)
    try:
        if p.stat().st_size > CSV_MAX:
            return [], [f"{p.name}: quá {CSV_MAX} byte"]
        text = p.read_bytes().decode("utf-8-sig")
    except OSError as e:
        return [], [f"{p.name}: không đọc được ({type(e).__name__})"]
    except UnicodeDecodeError:
        return [], [f"{p.name}: không phải UTF-8"]
    rd = csv.reader(io.StringIO(text, newline=""))
    head = next(rd, None)
    if [h.strip() for h in head or []] != CSV_HEADER:
        return [], [f"dòng 1: header phải đúng {','.join(CSV_HEADER)}"]
    rows, errs, seen = [], [], set()
    for n, rec in enumerate(rd, 2):
        if not rec or all(not c.strip() for c in rec):
            continue
        if len(rec) != len(CSV_HEADER):
            errs.append(f"dòng {n}: cần {len(CSV_HEADER)} cột")
            continue
        area = rec[0].strip()
        if area not in area_codes:
            errs.append(f"dòng {n} cột area_code: vùng không có trong cấu hình")
            continue
        try:
            row = _parse_row(area, *rec[1:])
        except SourceError as e:
            errs.append(f"dòng {n} cột {e}: sai định dạng/ngoài khoảng")
            continue
        key = (area, row["day"])
        if key in seen:
            errs.append(f"dòng {n}: trùng (area_code, day)")
            continue
        seen.add(key)
        rows.append(row)
    return (rows, errs) if not errs else ([], errs)


def parse_open_meteo(body: bytes, area: str) -> list[dict]:
    """JSON Open-Meteo daily → rows của 1 vùng. Hỏng → SourceError."""
    try:
        doc = json.loads(body.decode("utf-8"))
        daily = doc["daily"]
        days = daily["time"]
        cols = [daily[k] for k in ("precipitation_sum", "temperature_2m_min",
                                   "temperature_2m_max")]
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise SourceError(f"JSON dự báo hỏng ({type(e).__name__})") from None
    if not isinstance(days, list) or not all(
            isinstance(c, list) and len(c) == len(days) for c in cols):
        raise SourceError("mảng dự báo thiếu/độ dài lệch")
    out = []
    for i, d in enumerate(days):
        vals = [c[i] for c in cols]
        if any(v is None for v in vals):
            continue                       # ngày chưa có số → bỏ ngày đó
        out.append(_parse_row(area, d, *vals))
    return out


def evaluate(rows, thresholds) -> list[dict]:
    """THUẦN → [{"area","day","kinds","value"}] theo (vùng, ngày)."""
    out = []
    for r in sorted(rows, key=lambda r: (r["area"], r["day"])):
        kinds, value = [], {}
        if r["rain_mm"] > thresholds["rain_mm_day"]:
            kinds.append("mua_lon")
            value["rain_mm"] = r["rain_mm"]
        if r["tmin_c"] < thresholds["tmin_c"]:
            kinds.append("ret")
            value["tmin_c"] = r["tmin_c"]
        if kinds:
            out.append({"area": r["area"], "day": r["day"], "kinds": kinds,
                        "value": value})
    return out


def forecast_url(cfg: dict, area: dict) -> str:
    f = cfg["fetch"]
    return f["url_template"].format(lat=f"{round(area['lat'], 1):.1f}",
                                     lon=f"{round(area['lon'], 1):.1f}",
                                     days=f["days"])


def fetch_forecast(cfg: dict, fetcher) -> tuple[list[dict], list[str]]:
    """Mỗi vùng 1 GET qua Fetcher → (rows, mã vùng chưa có dự báo)."""
    rows, missing = [], []
    for i, a in enumerate(cfg["areas"]):
        try:
            r = fetcher.fetch(forecast_url(cfg, a), FETCH_SOURCE)
        except intel.BlockedDomain:
            r = None
        except intel.BudgetExhausted:
            print("[warn] hết ngân sách --max-requests — vùng còn lại chưa"
                  " có dự báo", flush=True)
            missing += [x["code"] for x in cfg["areas"][i:]]
            break
        if r is None or r.status != 200 or r.body is None:
            missing.append(a["code"])
            continue
        try:
            rows += parse_open_meteo(r.body, a["code"])
        except SourceError as e:
            print(f"[warn] vùng {a['code']}: {e} — chưa có dự báo",
                  flush=True)
            missing.append(a["code"])
    return rows, list(dict.fromkeys(missing))


def pest_flags(conn, now: datetime, days: int) -> list[dict]:
    """Nhật ký `days` ngày tới `now` → cờ CHỈ từ detail (không activity)."""
    rows = conn.execute(
        "select plot_id, ts, detail from plot_logs where ts > %s and ts <= %s"
        " order by plot_id, ts", (now - timedelta(days=days), now)).fetchall()
    out = []
    for pid, ts, detail in rows:
        fs = log_flags(detail)
        # 'bệnh' nằm trong 'sâu bệnh' → giữ cụm dài, 1 dòng/nhật ký
        fs = [f for f in fs if not any(f != g and f in g for g in fs)]
        if fs:
            out.append({"plot": pid, "day": ts.astimezone(VN_TZ).date(),
                        "flag": ", ".join(fs)})
    return out


def active_plots(conn) -> list[str]:
    return [r[0] for r in conn.execute(
        "select id from plots where status = 'active' order by id")]


def _fmt(v: float) -> str:
    return f"{v:.1f}"


def build_digest(alerts, flags, plots_by_area, now: datetime, *,
                 areas=None, thresholds=None, missing=(), unassigned=(),
                 logs_loaded=True) -> str:
    """THUẦN — digest markdown từ template. KHÔNG tọa độ/vị trí/người ghi."""
    names = {a["code"]: a["name"] for a in areas or []}
    day = now.astimezone(VN_TZ).date().isoformat()
    th = thresholds or {}
    L = [f"# Cảnh báo thời tiết & sâu bệnh — {day}", "",
         ("NỘI BỘ khối Vùng trồng — chỉ gợi ý \"cần đi kiểm tra\"; không "
          "chẩn đoán, không khuyến nghị xử lý. GĐ vùng trồng duyệt mục này ="
          " đã xem."), ""]
    if th:
        L += [(f"Ngưỡng GIẢ ĐỊNH (chờ GĐ vùng trồng chốt): mưa > "
               f"{_fmt(th['rain_mm_day'])} mm/ngày, nhiệt độ thấp nhất < "
               f"{_fmt(th['tmin_c'])} °C."), ""]
    L += ["## Thời tiết theo vùng", ""]
    by_area: dict[str, list] = {}
    for a in alerts:
        by_area.setdefault(a["area"], []).append(a)
    for code, plots in plots_by_area.items():
        ps = ", ".join(plots) or "(chưa gán khoảnh)"
        L.append(f"### {names.get(code, code)} — khoảnh: {ps}")
        if code in missing:
            L.append("- chưa có dự báo")
        for a in by_area.get(code, []):
            for k in a["kinds"]:
                v = (f"mưa {_fmt(a['value']['rain_mm'])} mm" if k == "mua_lon"
                     else f"nhiệt độ thấp nhất {_fmt(a['value']['tmin_c'])}"
                     " °C")
                L.append(f"- {a['day'].isoformat()}: {v} — cần đi "
                         f"{KIND_TEXT[k]} tại khoảnh {ps}")
        if code not in missing and not by_area.get(code):
            L.append("- không vượt ngưỡng")
        L.append("")
    if unassigned:
        L += ["## Khoảnh chưa gán vùng", ""]
        L += [f"- {_md(p)}: chưa gán vùng — chưa có cảnh báo thời tiết"
              for p in unassigned]
        L.append("")
    L += ["## Nhật ký vùng trồng cần chú ý", ""]
    if not logs_loaded:
        L.append("- chưa nạp nhật ký (không kết nối được DB)")
    elif not flags:
        L.append("- không có ghi nhận cần chú ý")
    for f in flags:
        L.append(f"- khoảnh {_md(f['plot'])}: ghi nhận '{f['flag']}' ngày "
                 f"{f['day'].isoformat()} — cần đi kiểm tra")
    L += ["", ("*Agent không gửi/đăng gì; GĐ vùng trồng quyết định việc "
               "đi kiểm tra.*"), ""]
    return "\n".join(L)


def _day_end(d: date) -> datetime:
    return datetime.combine(d + timedelta(days=1), dtime(0, 0), VN_TZ) \
        - timedelta(microseconds=1)


def main(argv=None, now: datetime | None = None, *, transport=None,
         sleep=time.sleep, clock=time.perf_counter) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.vt_thoitiet",
        description="VT cảnh báo thời tiết & sâu bệnh — digest nội bộ, "
                    "không gửi/đăng gì")
    ap.add_argument("--digest", action="store_true", required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-csv", type=Path, metavar="FILE")
    src.add_argument("--fetch", action="store_true",
                     help="dự báo qua collector (chỉ khi fetch.enabled)")
    ap.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQ)
    ap.add_argument("--submit", action="store_true",
                    help="đẩy digest vào hàng duyệt khối farming")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (ngày VN)")
    a = ap.parse_args(argv)
    if not 1 <= a.max_requests <= 60:
        ap.error("--max-requests phải trong 1..60")
    try:
        day = date.fromisoformat(a.date) if a.date else None
        if day is not None:
            now = _day_end(day)
    except (ValueError, OverflowError):
        ap.error("--date sai định dạng YYYY-MM-DD")
    now = now or datetime.now(VN_TZ)
    try:
        cfg = load_config()
    except ConfigError as e:
        print(f"[err] weather_config.json: {e}", flush=True)
        return 1
    codes = {x["code"] for x in cfg["areas"]}
    missing: list[str] = []
    if a.from_csv is not None:
        rows, errs = read_csv(a.from_csv, codes)
        if errs:
            for e in errs[:50]:
                print(f"[err] {e}", flush=True)
            print(f"[err] CSV có {len(errs)} lỗi — không xử lý", flush=True)
            return 1
    else:
        if cfg["fetch"]["enabled"] is not True:
            print("[warn] --fetch chưa bật — điều khoản nhà cung cấp dự báo "
                  "chưa xác minh (dùng --from-csv)", flush=True)
            return 2
        icfg, ierrs = intel.load_sources(intel.SOURCES_FILE)
        if ierrs:
            print("[err] không đọc được danh sách chặn tầng C — không fetch",
                  flush=True)
            return 1
        with intel.Fetcher(a.max_requests, intel.tier_c_hosts(icfg),
                           transport, sleep, clock) as f:
            rows, missing = fetch_forecast(cfg, f)
    alerts = evaluate(rows, cfg["thresholds"])
    plots_by_area = {x["code"]: list(x["plots"]) for x in cfg["areas"]}
    assigned = {p for ps in plots_by_area.values() for p in ps}
    flags, unassigned, loaded = [], [], False
    conn = connect()
    try:
        if conn is not None:
            try:
                flags = pest_flags(conn, now, cfg["flag_days"])
                unassigned = [p for p in active_plots(conn)
                              if p not in assigned]
                conn.commit()
                loaded = True
            except psycopg.Error as e:
                print(f"[warn] chưa nạp nhật ký (lỗi DB {type(e).__name__})",
                      flush=True)
                with suppress(Exception):
                    conn.rollback()
        else:
            print("[warn] chưa nạp nhật ký (không kết nối được Postgres)",
                  flush=True)
        text = build_digest(alerts, flags, plots_by_area, now,
                            areas=cfg["areas"], thresholds=cfg["thresholds"],
                            missing=missing, unassigned=unassigned,
                            logs_loaded=loaded)
        g = guardrail.check(text)
        if g.get("ok") is not True:
            print("[err] digest vi phạm guardrail — không ghi", flush=True)
            return 1
        vn_day = now.astimezone(VN_TZ).date().isoformat()
        try:
            p = write_report(text, REPORTS_DIR, f"vt-canh-bao-{vn_day}.md")
        except OSError as e:
            print(f"[err] không ghi được digest ({type(e).__name__})",
                  flush=True)
            return 1
        print(f"[done] {p} alerts={len(alerts)} flags={len(flags)} "
              f"missing={','.join(missing) or '-'}", flush=True)
        if not a.submit:
            return 0
        if not loaded:
            print("[warn] --submit bỏ qua — chưa nạp nhật ký/DB down",
                  flush=True)
            return 0
        if not alerts and not flags:
            print("[ok] không có cảnh báo/cờ — không đẩy hàng duyệt",
                  flush=True)
            return 0
        try:
            qid = director.submit(
                conn, BLOCK, OBJECT_TYPE, object_id=f"vt-digest:{vn_day}",
                title=f"Cảnh báo thời tiết & sâu bệnh {vn_day}",
                payload=text, created_by=CREATED_BY)
        except psycopg.errors.UniqueViolation:
            print(f"[skipped] digest {vn_day} đã có mục đang chờ duyệt",
                  flush=True)
            return 0
        except (psycopg.Error, director.DirectorConfigError) as e:
            print(f"[err] không đẩy được hàng duyệt ({type(e).__name__})",
                  flush=True)
            return 1
        print(f"[done] mục #{qid} PENDING khối farming (GĐ duyệt = đã xem)",
              flush=True)
        return 0
    finally:
        if conn is not None:
            with suppress(Exception):
                conn.close()


if __name__ == "__main__":
    with job_run("agents.vt_thoitiet") as _run:
        rc = main()
        _run["ok"] = rc == 0
    raise SystemExit(rc)
