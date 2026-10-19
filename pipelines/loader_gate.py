"""v15 P12.1 — chính sách cổng tắt cho LOADER nạp file (HĐ 6.7, PL02 mục 1).

Vấn đề: 8 loader nạp file (market_csv, golden_store, embed_store,
kb_internal, doc_intake, agent_eval, lead_store, dealer_price) ghi dữ liệu
NGUỒN dùng chung cho nhiều tính năng — không qua cổng tắt `rollout`. Có nên
chặn nạp khi tính năng tắt hay không là QUYẾT ĐỊNH của chủ khối/hai bên (dữ
liệu nguồn có thể vẫn cần cho tính năng khác / đối soát), dev không tự chọn.

Cơ chế (file `data/loader_gate.json`, đọc mỗi lần chạy):
  - Mỗi loader khai `features` (mã danh mục mà loader cấp dữ liệu — đối
    chiếu `modules` của danh mục, drift-guard ở test) + `chinh_sach`:
      null             CHƯA CẤU HÌNH (mặc định repo) — tính năng nào trong
                       `features` đang TẮT → CHẶN (fail-closed); không tắt →
                       nạp, in rõ "chính sách CHƯA CẤU HÌNH".
      "chan_khi_tat"   có tính năng tắt → chặn.
      "nap_ca_khi_tat" vẫn nạp khi tính năng tắt (dữ liệu nguồn dùng chung) —
                       in rõ tính năng nào đang tắt.
    Đặt chính sách khác null phải kèm `chot_boi` (NGƯỜI, không agent:/
    system:) + `can_cu` (văn bản/biên bản) — thiếu → cấu hình hỏng.
  - File thiếu / JSON hỏng / không phải object / thiếu loader / loader lạ /
    `features` rỗng hoặc mã không có trong danh mục / chính sách lạ → MỌI
    loader bị chặn (exit 2) — không đoán.
  - Giai đoạn đọc qua `rollout.mode` (nguồn duy nhất). Gate tự mở kết nối
    (DATABASE_URL sau `auth.bind_service("loader")` — svc_loader có SELECT
    `feature_rollout`); không mở được → CHẶN (không biết tính năng có tắt).
  - `check()` chỉ đọc, không ghi DB; gọi TRƯỚC mọi ghi của loader.

CLI: `python -m pipelines.loader_gate --status` — in chính sách + giai đoạn
từng loader (exit 1 khi cấu hình hỏng).
"""

import argparse
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data" / "loader_gate.json"
LOADERS = ("market_csv", "golden_store", "embed_store", "kb_internal",
           "doc_intake", "agent_eval", "lead_store", "dealer_price")
MODULES = {"market_csv": "ingest/market_csv.py",
           "golden_store": "ingest/golden_store.py",
           "embed_store": "ingest/embed_store.py",
           "kb_internal": "ingest/kb_internal.py",
           "doc_intake": "ingest/doc_intake.py",
           "agent_eval": "scripts/agent_eval.py",
           "lead_store": "ingest/lead_store.py",
           "dealer_price": "ingest/dealer_price.py"}
POLICIES = {"chan_khi_tat": "tính năng tắt → không nạp",
            "nap_ca_khi_tat": "vẫn nạp khi tính năng tắt (dữ liệu nguồn "
                              "dùng chung)"}
UNSET = ("chính sách CHƯA CẤU HÌNH (chờ chủ khối/hai bên chọn — "
         "data/loader_gate.json)")
MAX_TEXT = 200


class LoaderGateError(ValueError):
    """Cấu hình cổng loader hỏng — fail-closed, không nạp."""


def _text(v) -> str:
    return " ".join(v.split()) if isinstance(v, str) else ""


def load_config(path: Path | None = None, catalog_ids=None) -> dict:
    """→ {loader: {"features": [...], "policy": str|None, "chot_boi",
    "can_cu"}}. Mọi lỗi → LoaderGateError."""
    p = Path(path or CONFIG)
    try:
        doc = json.loads(p.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        raise LoaderGateError(f"không có file {p.name}") from None
    except (OSError, ValueError) as e:
        raise LoaderGateError(f"{p.name} hỏng: {type(e).__name__}") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("loaders"), dict):
        raise LoaderGateError(f"{p.name}: thiếu object 'loaders'")
    raw = doc["loaders"]
    if set(raw) != set(LOADERS):
        miss, extra = set(LOADERS) - set(raw), set(raw) - set(LOADERS)
        raise LoaderGateError(
            f"{p.name}: loader thiếu {sorted(miss)} / lạ {sorted(extra)}")
    if catalog_ids is None:
        from pipelines import rollout
        cat = rollout._catalog()
        if cat is None:
            raise LoaderGateError("danh mục contract_features.json hỏng")
        catalog_ids = {f["id"] for f in cat}
    from pipelines.auth import is_human
    out = {}
    for name in LOADERS:
        e = raw[name]
        if not isinstance(e, dict):
            raise LoaderGateError(f"{name}: không phải object")
        feats = e.get("features")
        if (not isinstance(feats, list) or not feats
                or not all(isinstance(f, str) and f in catalog_ids
                           for f in feats)):
            raise LoaderGateError(f"{name}: 'features' phải là list mã có "
                                  "trong danh mục, không rỗng")
        pol = e.get("chinh_sach")
        if pol is not None and pol not in POLICIES:
            raise LoaderGateError(f"{name}: chinh_sach '{_text(str(pol))[:40]}"
                                  f"' không hợp lệ (null | "
                                  + " | ".join(POLICIES) + ")")
        by, ref = _text(e.get("chot_boi")), _text(e.get("can_cu"))
        if pol is not None and not (is_human(by) and len(by) <= 100
                                    and ref and len(ref) <= MAX_TEXT):
            raise LoaderGateError(f"{name}: chinh_sach đã đặt nhưng thiếu "
                                  "chot_boi (người thật) / can_cu")
        out[name] = {"features": list(dict.fromkeys(feats)), "policy": pol,
                     "chot_boi": by or None, "can_cu": ref or None}
    return out


def decide(policy: str | None, stages: dict) -> tuple[bool, str]:
    """THUẦN: (được nạp?, diễn giải). `stages` = {mã: giai đoạn}."""
    off = sorted(f for f, s in stages.items() if s == "tat")
    st = ", ".join(f"{f} {s}" for f, s in sorted(stages.items()))
    head = (UNSET if policy is None else
            f"chính sách {policy} ({POLICIES[policy]})")
    if not off:
        return True, f"{head} — tính năng: {st} → nạp"
    if policy == "nap_ca_khi_tat":
        return True, (f"{head} — tính năng TẮT: {', '.join(off)} → vẫn nạp "
                      "theo chính sách")
    return False, (f"{head} — tính năng TẮT: {', '.join(off)} → KHÔNG nạp "
                   "(HĐ 6.7)")


def stages_for(conn, feats) -> dict | None:
    """{mã: giai đoạn} qua `rollout.mode`; cần DB mà không kết nối → None."""
    from pipelines import rollout
    if rollout.quick_mode() is None and conn is None:
        return None
    return {f: rollout.mode(conn, f) for f in feats}


def check(name: str, conn=None, path: Path | None = None) -> str | None:
    """Biên NẠP của loader → lý do chặn | None (được nạp). In 1 dòng trạng
    thái `[loader-gate]`. Chỉ đọc; conn None → tự mở (DATABASE_URL hiện
    hành) rồi đóng."""
    if name not in LOADERS:
        raise ValueError(f"loader lạ: {name}")
    try:
        ent = load_config(path)[name]
    except LoaderGateError as e:
        return f"cấu hình cổng loader hỏng: {e} — không nạp (fail-closed)"
    own = None
    from pipelines import rollout
    if conn is None and rollout.quick_mode() is None:
        from ingest.lead_store import connect
        conn = own = connect()
    try:
        stages = stages_for(conn, ent["features"])
    finally:
        if own is not None:
            own.close()
    if stages is None:
        return (f"loader {name}: không kết nối được DB để đọc giai đoạn "
                f"tính năng {', '.join(ent['features'])} — không nạp")
    ok, why = decide(ent["policy"], stages)
    print(f"[loader-gate] {name}: {why}", flush=True)
    return None if ok else f"loader {name}: {why}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipelines.loader_gate",
                                 description="Chính sách cổng tắt loader")
    ap.add_argument("--status", action="store_true", required=True,
                    help="in chính sách + giai đoạn từng loader")
    ap.parse_args(argv)
    try:
        cfg = load_config()
    except LoaderGateError as e:
        print(f"[err] cấu hình cổng loader hỏng: {e} — mọi loader bị chặn")
        return 1
    from ingest.lead_store import connect
    conn = connect()
    try:
        for name in LOADERS:
            ent = cfg[name]
            stages = stages_for(conn, ent["features"])
            if stages is None:
                print(f"[{name}] {UNSET if ent['policy'] is None else ent['policy']}"
                      " — DB không kết nối được: loader sẽ bị chặn")
                continue
            ok, why = decide(ent["policy"], stages)
            who = (f" (chốt bởi {ent['chot_boi']}, căn cứ {ent['can_cu']})"
                   if ent["policy"] else "")
            print(f"[{name}] {'nạp' if ok else 'CHẶN'} — {why}{who}")
    finally:
        if conn is not None:
            conn.close()
    n = sum(cfg[x]["policy"] is None for x in LOADERS)
    print(f"[done] {len(LOADERS)} loader, {n} chưa cấu hình chính sách")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
