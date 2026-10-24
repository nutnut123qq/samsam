"""Đợt an toàn + nghiệm thu A01/A02 (22/10/2026) — ma trận nghiệm thu tập trung.

Một nguồn đối chiếu cho 96 mục theo dõi (89 tính năng AI + 7 hạng mục khác) —
đọc `data/contract_features.json` (danh mục, KHÔNG đổi) + cấu hình sẵn có
(người duyệt từng khối, người nhận cảnh báo đỏ, lịch nghỉ, sổ tài sản/hạ
tầng, DPIA) + (tùy chọn) sổ `feature_rollout` trong DB. Không ghi gì.

READY_FOR_TRIAL chỉ khi ĐỦ mọi điều kiện áp dụng (PL02 mục 1a: chạy thử trên
DỮ LIỆU THẬT ⇒ môi trường thật + dữ liệu + quyền + an toàn):
  E1 hạ tầng/sổ tài sản Bên B đã xác nhận (`tai_san_hop_tac.json`
     `trang_thai` = `da_xac_nhan`) — server Bên B, backup/offsite, giám sát;
  E2 lịch nghỉ lễ/Tết đã chốt (`rollout_config.json` `holidays` không rỗng);
  E3 người nhận cảnh báo đỏ độc lập hợp lệ (`red_alert.load_routing`);
  B1 khối có người được Bên B ủy quyền (`directors/<khối>.json` `approvers`);
  B2 MỌI người duyệt đã cấu hình có ánh xạ `human_logins` active đúng khối tới
     login DÙNG ĐƯỢC lúc kiểm (LOGIN, chưa hết hạn, giới hạn kết nối ≠ 0,
     CONNECT, app_human, không superuser) — không `--db` = CHƯA KIỂM, lỗi DB =
     không kiểm được → đều KHÔNG READY (vá controller 22/10, vòng r8);
  B3 login đó có bằng chứng ĐĂNG NHẬP THẬT (`human_login_checks`, ghi khi
     `auth.person_connect` thành công — DB + thời điểm, không mật khẩu) của
     ĐÚNG người ánh xạ hiện hành (`p10_norm`; vòng r9 — ánh xạ đổi sang người
     khác thì người mới phải tự đăng nhập);
  I1 mã `co_code`; I2 có nguồn đếm đầu ra (`output_sources`) không trùng mục
     khác; I3 mục không còn blocker ghi trong danh mục; I4 điều kiện riêng
     (vd persona giả lập cần DPIA ký).
Thiếu → `CHUA_SAN_SANG` + danh sách thiếu. Không suy "đạt" từ test dev.

  python -m pipelines.acceptance --matrix [--out FILE.md] [--db]
  python -m pipelines.acceptance --summary [--db]
"""

import argparse
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CATALOG = DATA / "contract_features.json"
READY, NOT_READY = "READY_FOR_TRIAL", "CHUA_SAN_SANG"
STAGES = ("chay_thu", "co_nguoi_duyet", "van_hanh", "tat")


def _json(path: Path):
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None


def catalog(path=CATALOG) -> list[dict]:
    doc = _json(Path(path))
    if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
        raise SystemExit(f"[lỗi] danh mục {Path(path).name} hỏng")
    return doc["features"]


def env_state(data=DATA) -> dict:
    """Điều kiện môi trường chung → {mã: lý do thiếu | None}."""
    from pipelines import red_alert
    ts = _json(Path(data) / "tai_san_hop_tac.json") or {}
    cal = _json(Path(data) / "rollout_config.json") or {}
    routing = red_alert.load_routing(Path(data) / "red_alert_routing.json")
    return {
        "E1": None if ts.get("trang_thai") == "da_xac_nhan" else
        "hạ tầng/tài sản Bên B chưa xác nhận (server, backup offsite, giám sát"
        " ngoài máy, quyền quản trị — tai_san_hop_tac.json)",
        "E2": None if cal.get("holidays") else
        "lịch nghỉ lễ/Tết chưa chốt (rollout_config.json holidays rỗng)",
        "E3": None if routing["recipients"] and not routing["problems"] else
        "người nhận cảnh báo đỏ độc lập chưa đủ (red_alert_routing.json)",
    }


def block_state(block: str, data=DATA, logins=None) -> dict:
    """B1 người được ủy quyền; B2 LUÔN kiểm: `logins` None = chưa kiểm (không
    đọc DB), str = không kiểm được (lỗi DB), list = ánh xạ đã đọc — MỌI người
    duyệt đã cấu hình phải có ánh xạ hợp lệ đúng khối (người khác cùng khối
    không tính thay)."""
    from pipelines.auth import _norm_name
    cfg = _json(Path(data) / "directors" / f"{block}.json") or {}
    appr = [a for a in cfg.get("approvers") or [] if str(a).strip()]
    out = {"B1": None if appr else
           f"khối {block} chưa có người Bên B ủy quyền (approvers rỗng)"}
    if logins is None:
        out["B2"] = ("CHƯA KIỂM login người duyệt (không đọc DB — chạy "
                     "`--db` trên server Bên B)")
    elif isinstance(logins, str):
        out["B2"] = f"không kiểm được login người duyệt ({logins})"
    elif appr:
        mine = [r for r in logins if r["valid"] and block in r["blocks"]]
        ok = {_norm_name(r["person"]) for r in mine}
        lack = [a for a in appr if _norm_name(a) not in ok]
        out["B2"] = (None if not lack else
                     f"khối {block}: người duyệt chưa có login hợp lệ đúng khối"
                     f" trong human_logins: {', '.join(lack)}")
        # B3 (vòng r8): bằng chứng ĐĂNG NHẬP THẬT trên login đang dùng được
        seen = {_norm_name(r["person"]) for r in mine if r["last_login"]}
        never = [a for a in appr if _norm_name(a) in ok
                 and _norm_name(a) not in seen]
        out["B3"] = (None if not never else
                     f"khối {block}: chưa có bằng chứng đăng nhập thật "
                     f"(human_login_checks) của: {', '.join(never)}")
    return out


def _source_label(s: dict) -> str:
    if "report" in s:
        return f"báo cáo `{s['report']}*`"
    if s.get("table") == "approval_queue":
        return f"hàng duyệt `{s.get('block')}/{s.get('object_type')}`"
    if s.get("table") == "content_drafts":
        return f"nháp `{s.get('content_type') or s.get('created_by')}`"
    if "table" in s:
        return f"bảng `{s['table']}`"
    if "file" in s:
        return f"tệp `{s['file']}`"
    return json.dumps(s, ensure_ascii=False)


def source_overlaps(feats: list[dict]) -> dict:
    """{id: [id khác dùng cùng nguồn đếm]} — trùng y hệt hoặc tiền tố báo cáo
    lồng nhau (một tệp đếm được cho hai mục)."""
    keys = [(f["id"], json.dumps(s, sort_keys=True), s.get("report"))
            for f in feats for s in f.get("output_sources") or []]
    out: dict = {}
    for i, (a, ka, ra) in enumerate(keys):
        for b, kb, rb in keys[i + 1:]:
            if a == b:
                continue
            same = ka == kb or (ra and rb and (ra.startswith(rb)
                                               or rb.startswith(ra)))
            if same:
                out.setdefault(a, []).append(b)
                out.setdefault(b, []).append(a)
    return out


def criteria(f: dict) -> str:
    """Tiêu chí kiểm HÀNH VI của mục (PL02 mục 1 + đầu ra cụ thể)."""
    srcs = "; ".join(_source_label(s) for s in f.get("output_sources") or [])
    if f.get("pham_vi") != "tinh_nang_ai":
        return (f"Hạng mục ({f.get('pham_vi')}): {f.get('dau_ra')} — nghiệm "
                "thu theo hồ sơ hạng mục + biên bản hai bên (PL02 mục 1d–đ); "
                + (f"bằng chứng đếm: {srcs}" if srcs else
                   "không có bộ đếm tự động"))
    return (f"Chạy thử nội bộ trên server Bên B, dữ liệu THẬT (không mẫu): "
            f"≥50 đầu ra DISTINCT theo {srcs or 'nguồn — CHƯA CÓ'}, rải ≥5 "
            f"ngày làm việc; mỗi đầu ra «{f.get('dau_ra')}» qua kiểm tự động, "
            "chỉ ghi nội bộ (không gửi/đăng). Có người duyệt ≥10 ngày làm "
            f"việc: {f.get('nguoi_duyet')} (Bên B) duyệt TỪNG đầu ra đúng "
            "phiên bản trước khi dùng; 0 lỗi nghiêm trọng (lỗi → tắt, về "
            "chạy thử).")


def evaluate(f: dict, env: dict, blk: dict, overlaps: dict,
             data=DATA) -> tuple[str, list[str]]:
    miss = [v for v in env.values() if v] + [v for v in blk.values() if v]
    if f.get("code_status") != "co_code":
        miss.insert(0, f"mã chưa đủ ({f.get('code_status')})")
    if not f.get("output_sources"):
        miss.insert(0, "không có nguồn đếm đầu ra (output_sources)")
    if f["id"] in overlaps:
        miss.append("nguồn đếm dùng chung với " + ", ".join(
            sorted(set(overlaps[f["id"]]))))
    if (f.get("blocker") or "").strip():
        miss.append("blocker danh mục: " + f["blocker"].strip())
    if "persona_sim.py" in " ".join(f.get("modules") or []):
        sim = _json(Path(data) / "sim_config.json") or {}
        if sim.get("dpia_signed") is not True:
            miss.append("DPIA chưa ký (sim_config.json dpia_signed)")
    return (NOT_READY if miss else READY), miss


def person_logins(conn):
    """[{person, blocks, valid, last_login}] — valid = ánh xạ active + role
    dùng được NGAY LÚC KIỂM (LOGIN, chưa hết hạn VALID UNTIL, giới hạn kết nối
    ≠ 0, có CONNECT DB này, thuộc app_human, không superuser); last_login =
    lần đăng nhập thật gần nhất (`human_login_checks`) của ĐÚNG login VÀ ĐÚNG
    người ánh xạ hiện hành (chuẩn hóa `p10_norm` — ánh xạ đổi sang người khác
    thì lần đăng nhập của người cũ không tính). Lỗi DB/quyền → chuỗi lý do
    (không bao giờ coi là đạt)."""
    import psycopg
    try:
        with conn.transaction():
            rs = conn.execute(
                "select h.person, h.blocks, coalesce(h.active and"
                " r.rolcanlogin and not r.rolsuper and pg_has_role(r.oid,"
                " 'app_human', 'MEMBER') and (r.rolvaliduntil is null or"
                " r.rolvaliduntil > now()) and r.rolconnlimit <> 0 and"
                " has_database_privilege(r.oid, current_database(), 'CONNECT'),"
                " false), (select max(c.checked_at) from human_login_checks c"
                " where c.db_login = h.db_login and p10_norm(c.person) ="
                " p10_norm(h.person)) from human_logins h left join"
                " pg_roles r on r.rolname = h.db_login").fetchall()
    except psycopg.Error as e:
        return type(e).__name__
    return [{"person": p, "blocks": list(b or []), "valid": v,
             "last_login": ts} for p, b, v, ts in rs]


def ledger(conn) -> dict:
    import psycopg
    try:
        with conn.transaction():
            return {fid: (st, since) for fid, st, since in conn.execute(
                "select feature_id, stage, stage_since from feature_rollout")}
    except psycopg.Error:
        return {}


def rows(feats=None, data=DATA, conn=None) -> list[dict]:
    feats = catalog() if feats is None else feats
    env = env_state(data)
    logins = person_logins(conn) if conn is not None else None
    led = ledger(conn) if conn is not None else {}
    ov = source_overlaps(feats)
    out = []
    for f in feats:
        status, miss = evaluate(f, env, block_state(f["phong_ban"], data,
                                                    logins), ov, data)
        st = led.get(f["id"])
        nxt = ("Bắt đầu chạy thử nội bộ (PL02 1a) trên server Bên B — người "
               "chịu trách nhiệm ghi ngày bắt đầu thật" if status == READY
               else "Chuẩn bị: " + miss[0])
        out.append({"id": f["id"], "phong_ban": f["phong_ban"],
                    "pham_vi": f["pham_vi"], "giai_doan": f["giai_doan"],
                    "ten": f["ten"], "nguon": f.get("nguon"),
                    "dau_ra": f.get("dau_ra"),
                    "nguon_dem": [_source_label(s) for s in
                                  f.get("output_sources") or []],
                    "nguoi_duyet": f.get("nguoi_duyet"),
                    "bang_chung_code": f.get("bang_chung") or [],
                    "so_rollout": st[0] if st else None,
                    "acceptance_status": f.get("acceptance_status"),
                    "status": status, "thieu": miss, "buoc_ke": nxt,
                    "tieu_chi": criteria(f)})
    return out


def summary(rs: list[dict]) -> dict:
    n = len(rs)
    return {
        "mau_so": n,
        "tinh_nang_ai": sum(r["pham_vi"] == "tinh_nang_ai" for r in rs),
        "hang_muc_khac": sum(r["pham_vi"] != "tinh_nang_ai" for r in rs),
        "ready_for_trial": sum(r["status"] == READY for r in rs),
        "chay_thu": sum(r["so_rollout"] == "chay_thu" for r in rs),
        "co_nguoi_duyet": sum(r["so_rollout"] == "co_nguoi_duyet" for r in rs),
        "van_hanh": sum(r["so_rollout"] == "van_hanh" for r in rs),
        "du_ho_so": 0,          # hồ sơ đủ = bằng chứng chạy thử + duyệt THẬT
        "da_nghiem_thu": sum(r["acceptance_status"] == "da_nghiem_thu"
                             for r in rs),
    }


def render_md(rs: list[dict], *, source: str) -> str:
    s = summary(rs)
    env = env_state()
    led_note = ("DB đã đọc" if any(r["so_rollout"] for r in rs)
                else "không đọc/không có trên server Bên B")
    lines = [
        "# Ma trận nghiệm thu — 96 mục theo dõi (sinh tự động, không sửa tay)",
        "",
        ("Sinh bằng `python -m pipelines.acceptance --matrix --out "
         "docs/handover/ma-tran-nghiem-thu.md` từ `data/contract_features.json`"
         f" + cấu hình sẵn có ({source}). Danh mục KHÔNG đổi; READY_FOR_TRIAL "
         "chỉ khi đủ mọi điều kiện (đầu `pipelines/acceptance.py`)."),
        "",
        (f"Mẫu số {s['mau_so']} mục = {s['tinh_nang_ai']} tính năng AI + "
         f"{s['hang_muc_khac']} hạng mục khác. Sẵn sàng chạy thử: "
         f"**{s['ready_for_trial']}/{s['mau_so']}** · đang chạy thử: "
         f"{s['chay_thu']} · có người duyệt: {s['co_nguoi_duyet']} · vận "
         f"hành: {s['van_hanh']} · đủ hồ sơ: {s['du_ho_so']} · đã nghiệm "
         f"thu: **{s['da_nghiem_thu']}/{s['mau_so']}** (sổ rollout: "
         f"{led_note})."),
        "",
        "## Điều kiện môi trường chung",
        "",
        *[f"- {k}: {'ĐẠT' if v is None else 'THIẾU — ' + v}"
          for k, v in env.items()],
        "",
        "## Từng mục",
        "",
        ("| ID | Căn cứ DOCX | GĐ | Đầu ra | Nguồn đếm / provenance | Người "
         "duyệt | Môi trường | Bằng chứng (code / tích hợp / triển khai / "
         "chạy thử) | Trạng thái | Thiếu gì | Bước được phép kế | Tiêu chí "
         "kiểm hành vi |"),
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    esc = lambda t: str(t or "").replace("|", "\\|").replace("\n", " ")
    for r in rs:
        ev = ("test: " + ", ".join(Path(b).name for b in r["bang_chung_code"])
              if r["bang_chung_code"] else "test: —")
        ev += " / tích hợp: chưa / triển khai: chưa / chạy thử: " + (
            r["so_rollout"] or "chưa")
        lines.append(
            f"| {r['id']} | {esc(r['nguon'])} | {r['giai_doan']} | "
            f"{esc(r['dau_ra'])} | {esc('; '.join(r['nguon_dem']) or '—')} | "
            f"{esc(r['nguoi_duyet'])} | server Bên B: chưa bàn giao | "
            f"{esc(ev)} | {r['status']} | {esc('; '.join(r['thieu']))} | "
            f"{esc(r['buoc_ke'])} | {esc(r['tieu_chi'])} |")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.acceptance")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--matrix", action="store_true")
    g.add_argument("--summary", action="store_true")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--db", action="store_true",
                    help="đọc thêm human_logins + feature_rollout (chỉ đọc)")
    a = ap.parse_args(argv)
    conn = None
    if a.db:
        from ingest.lead_store import connect
        conn = connect()
        if conn is None:
            print("[lỗi] không kết nối được Postgres", file=sys.stderr)
            return 2
    try:
        rs = rows(conn=conn)
    finally:
        if conn is not None:
            conn.close()
    if a.summary:
        print(json.dumps(summary(rs), ensure_ascii=False))
        return 0
    md = render_md(rs, source="có đọc DB" if a.db else "không đọc DB")
    if a.out:
        a.out.write_bytes(md.encode("utf-8"))
        print(f"[done] {a.out} — {len(rs)} mục")
    else:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
