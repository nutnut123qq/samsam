"""v9.5 CK-A3 + CK-A4 — trung tâm điện–cơ khí: năng lực đóng gói hộp quà Tết
và checklist điện/mạng điểm quay live. Thuần tất định, không LLM, không DB.

Contract:
  - `capacity_for(cfg, sku, boxes)` — số ca cần mỗi công đoạn =
    ceil(boxes / (rate × units)); nút thắt = công đoạn nhiều ca nhất; mỗi số
    kèm nhãn `gia_dinh`/`do_thuc`; `status` "chờ Kỹ sư trưởng ký". Config
    `data/co_khi/nang_luc.json` là GIẢ ĐỊNH. `gia_cong` true (gia công
    ngoài) → ValueError, không tính. ĐIỂM NỐI cho `pipelines.scenario`
    (v7.3): scenario gọi `capacity_for`; module này KHÔNG import scenario.
    Output không hứa hẹn ngày giao/cam kết với khách.
  - `render_live_checklist(cfg, site, day, upload=None, loss=None)` →
    markdown TẤT ĐỊNH (không now(); `day` bắt buộc). Mạng: đủ 2 số đo →
    ĐẠT (upload ≥ min và loss ≤ max) / KHÔNG ĐẠT (+ bật router dự phòng);
    thiếu → CHƯA ĐO. Điện luôn "CHỜ KỸ SƯ TRƯỞNG DUYỆT ẢNH". Công cụ KHÔNG
    tự kết luận điểm quay dùng được — chỉ người thật ký.

Chạy: `python -m agents.co_khi nang-luc --sku HQ-TET-01 --boxes
500,1500,3000 [--config PATH]` · `python -m agents.co_khi checklist-live
--site da_nang --day 2026-11-05 [--upload 6.5 --loss 0.5] [--config PATH]
[--out FILE]`.
"""

import argparse
import json
import math
import sys
from datetime import date
from fractions import Fraction
from pathlib import Path

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CAPACITY_CONFIG = ROOT / "data" / "co_khi" / "nang_luc.json"
LIVE_CONFIG = ROOT / "data" / "co_khi" / "live.json"
LABELS = {"gia_dinh": "giả định", "do_thuc": "đo thực"}
STATUS = "chờ Kỹ sư trưởng ký"
MAX_BOXES = 10_000_000


def load_config(path: Path) -> dict:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(cfg, dict):
        raise ValueError("config không phải object")  # noqa: TRY004 — CLI bắt chung
    return cfg


def _num(v, what: str) -> Fraction:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not v > 0:
        raise ValueError(f"{what} phải là số > 0")
    if isinstance(v, float) and not math.isfinite(v):
        raise ValueError(f"{what} phải là số hữu hạn")
    return Fraction(str(v))


def capacity_for(cfg: dict, sku: str, boxes: int) -> dict:
    """Năng lực đóng gói 1 SKU cho `boxes` hộp (hàm thuần)."""
    if cfg.get("gia_cong"):
        raise ValueError("đóng gói gia công ngoài — CK-A3 không chạy")
    if isinstance(boxes, bool) or not isinstance(boxes, int) or boxes <= 0:
        raise ValueError("số hộp phải là số nguyên > 0")
    if boxes > MAX_BOXES:
        raise ValueError(f"số hộp vượt {MAX_BOXES}")
    skus = cfg.get("skus") or {}
    if not isinstance(sku, str) or sku not in skus:
        raise ValueError(f"SKU không có trong config: {sku!r}")
    stations = cfg.get("stations") or {}
    rows = []
    for key in skus[sku].get("stations") or []:
        st = stations.get(key)
        if not isinstance(st, dict):
            raise ValueError(f"công đoạn không có trong config: {key!r}")  # noqa: TRY004
        label = st.get("label")
        if label not in LABELS:
            raise ValueError(f"nhãn số liệu công đoạn {key!r} phải là"
                             " gia_dinh|do_thuc")
        per_shift = _num(st.get("rate"), f"rate {key}") * _num(
            st.get("units"), f"units {key}")
        rows.append({"station": key, "ten": st.get("ten") or key,
                     "rate": st["rate"], "units": st["units"],
                     "per_shift": per_shift,
                     "shifts_needed": math.ceil(Fraction(boxes) / per_shift),
                     "label": label})
    if not rows:
        raise ValueError(f"SKU {sku!r} không có công đoạn")
    worst = max(rows, key=lambda r: r["shifts_needed"])  # hòa → công đoạn đầu
    return {"sku": sku, "boxes": boxes, "stations": rows,
            "bottleneck": worst["station"],
            "bottleneck_shifts": worst["shifts_needed"],
            "bottleneck_label": worst["label"], "status": STATUS}


def _fmt(x) -> str:
    if isinstance(x, Fraction):
        return str(x.numerator) if x.denominator == 1 else f"{float(x):g}"
    return f"{x:g}" if isinstance(x, float) else str(x)


def render_capacity(cfg: dict, sku: str, scenarios: list[int]) -> str:
    """Markdown nhiều kịch bản số hộp — mọi số kèm nhãn giả định/đo thực."""
    results = [capacity_for(cfg, sku, b) for b in scenarios]
    ten = cfg["skus"][sku].get("ten") or sku
    out = [f"# Năng lực đóng gói {sku} — {ten}", "",
           ("> GIẢ ĐỊNH — số liệu dev đặt, chờ Kỹ sư trưởng đo thực và ký."
            " Không dùng để hứa với khách."), "",
           (f"Trạng thái: {STATUS}. Số ca = trần(số hộp / (năng suất/ca ×"
            " số máy hoặc người))."), ""]
    for r in results:
        out += [f"## Kịch bản {r['boxes']} hộp (giả định)", "",
                ("| Công đoạn | Năng suất/ca/đơn vị | Số máy/người | Số ca cần |"
                 " Nhãn số liệu |"),
                "|---|---|---|---|---|"]
        for s in r["stations"]:
            lb = LABELS[s["label"]]
            out.append(f"| {s['ten']} | {_fmt(s['rate'])} ({lb}) |"
                       f" {_fmt(s['units'])} ({lb}) | {s['shifts_needed']} ({lb})"
                       f" | {lb} |")
        bn = next(s for s in r["stations"] if s["station"] == r["bottleneck"])
        out += ["", (f"Nút thắt: {bn['ten']} — {r['bottleneck_shifts']} ca"
                     f" ({LABELS[r['bottleneck_label']]})."), ""]
    return "\n".join(out)


def render_live_checklist(cfg: dict, site: str, day: date,
                          upload: float | None = None,
                          loss: float | None = None) -> str:
    """Checklist điện/mạng 1 điểm quay live — markdown tất định."""
    if not isinstance(day, date):
        raise ValueError("day phải là date")  # noqa: TRY004
    sites = cfg.get("sites") or {}
    if site not in sites:
        raise ValueError(f"điểm quay không có trong config: {site!r}")
    for v, what, cap in ((upload, "upload", None), (loss, "mất gói", 100)):
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (
                math.isfinite(v) and v >= 0) or (cap is not None and v > cap):
            raise ValueError(f"số đo {what} không hợp lệ")
    up_min = float(cfg["upload_mbps_min"])
    loss_max = float(cfg["loss_pct_max"])
    sustain = cfg.get("sustain_min")
    items = cfg.get("items") or {}
    out = [(f"# Checklist điện/mạng điểm quay live — "
            f"{sites[site].get('ten') or site} — {day.isoformat()}"), "",
           ("> ĐỀ XUẤT — ngưỡng chưa đối chiếu yêu cầu TikTok/Shopee/FB Live;"
            " Kỹ sư trưởng + Quản lý MXH chốt."), "",
           "## 1. Mạng (Quản lý MXH ký)", "",
           (f"Ngưỡng: upload ≥ {up_min:g} Mbps, mất gói ≤ {loss_max:g} %,"
            f" đo liên tục ≥ {sustain} phút."), ""]
    if upload is None or loss is None:
        out.append("Kết quả phần mạng: **CHƯA ĐO** (cần đủ upload và mất gói).")
    else:
        out.append(f"Số đo: upload {upload:g} Mbps, mất gói {loss:g} %.")
        if upload >= up_min and loss <= loss_max:
            out.append("Kết quả phần mạng: **ĐẠT**.")
        else:
            out += ["Kết quả phần mạng: **KHÔNG ĐẠT**.",
                    "- Bật router dự phòng và đo lại."]
    out.append("")
    out += [f"- [ ] {it}" for it in items.get("do_duoc") or []]
    out += ["", "## 2. Điện (Kỹ sư trưởng duyệt qua ảnh)", "",
            "Trạng thái phần điện: **CHỜ KỸ SƯ TRƯỞNG DUYỆT ẢNH**.", ""]
    out += [f"- [ ] {it}" for it in items.get("dien") or []]
    out += ["", "## 3. Ký xác nhận (người thật)", "",
            "- Quản lý MXH (phần mạng): ______________________",
            "- Kỹ sư trưởng (phần điện): ______________________", "",
            ("Tổng trạng thái: **CHỜ NGƯỜI THẬT KÝ** — công cụ không tự kết"
             " luận điểm quay dùng được."), ""]
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.co_khi",
                                 description="CK-A3 năng lực đóng gói / CK-A4"
                                 " checklist live")
    sub = ap.add_subparsers(dest="cmd", required=True)
    nl = sub.add_parser("nang-luc")
    nl.add_argument("--sku", required=True)
    nl.add_argument("--boxes", required=True, help="vd 500,1500,3000")
    nl.add_argument("--config", default=str(CAPACITY_CONFIG))
    cl = sub.add_parser("checklist-live")
    cl.add_argument("--site", required=True)
    cl.add_argument("--day", required=True, help="YYYY-MM-DD")
    cl.add_argument("--upload", type=float)
    cl.add_argument("--loss", type=float)
    cl.add_argument("--config", default=str(LIVE_CONFIG))
    cl.add_argument("--out")
    a = ap.parse_args(argv)

    if a.cmd == "nang-luc":
        try:
            boxes = [int(x) for x in a.boxes.split(",")]
            md = render_capacity(load_config(a.config), a.sku, boxes)
        except (ValueError, OSError, KeyError, TypeError) as e:
            print(f"[co-khi] lỗi: {e}", flush=True)
            return 1
        print(md, flush=True)
        return 0

    try:
        day = date.fromisoformat(a.day)
    except ValueError:
        ap.error("--day phải dạng YYYY-MM-DD")
    if any(v is not None and not (math.isfinite(v) and v >= 0)
           for v in (a.upload, a.loss)):
        ap.error("--upload/--loss phải là số >= 0")
    try:
        cfg = load_config(a.config)
    except (ValueError, OSError) as e:
        print(f"[co-khi] config lỗi: {e}", flush=True)
        return 1
    if a.site not in (cfg.get("sites") or {}):
        ap.error(f"--site không có trong config: {a.site}")
    try:
        md = render_live_checklist(cfg, a.site, day, a.upload, a.loss)
    except (ValueError, KeyError, TypeError) as e:
        print(f"[co-khi] lỗi: {e}", flush=True)
        return 2
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(md)
        print(f"[co-khi] đã ghi checklist {a.site} {day.isoformat()}", flush=True)
    else:
        print(md, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
