"""v12.1 B1 + v13.0 c00 — danh mục yêu cầu HĐ (`data/contract_features.json`)
+ sổ triển khai 3 bước (`pipelines.rollout`, PL02 mục 1).

Thuần: kiểm danh mục v13.0 (manifest: không trùng ID/agent_id/nguồn đầu ra,
mọi mục có nguồn, module/test tồn tại, output_sources trỏ object_type/bảng/
file có thật trong code, tong_hop khớp số mục thực, ID nhóm v12 còn truy
được), lịch ngày làm việc, cổng, `--by` người thật, hồ sơ. DB thật trong
schema tạm + ROLLBACK (`tests.test_da_schema.da_db`): cổng 5 ngày/50 đầu
ra/10 ngày/0 lỗi, lỗi nghiêm trọng tự lùi, append-only, quyền role, mục
tách vào sổ với mốc mới (không kế thừa ngày nhóm cũ).
"""

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from pipelines import rollout as ro
from pipelines.director import BLOCKS
from pipelines.period import VN_TZ
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
REAL = ro.load_features()
SHIFT = ro.load_shift()
# File do lane v12.2–v12.6 tạo trên nhánh khác — có sau khi gộp.
LANE_FILES = {"agents/pc_hr.py", "agents/sx_label.py", "agents/rev_share.py",
              "scripts/ops_monthly.py"}
BY = "Quản lý AI MẪU"
# 59 id nhóm của danh mục v12 (HEAD 3622ec2) — mỗi id phải còn nguyên hoặc
# là `nhom_goc` của mục tách (lịch sử feature_rollout truy được).
OLD_IDS = (
    "ceo-01", "ceo-02", "ceo-03", "ceo-04", "ceo-05", "sales-01", "sales-02",
    "sales-03", "sales-04", "sales-05", "sales-06", "sales-07", "sales-08",
    "sales-09", "marketing-01", "marketing-02", "marketing-03",
    "marketing-04", "marketing-05", "marketing-06", "marketing-07",
    "intel-01", "intel-02", "intel-03", "intel-04", "intel-05", "intel-06",
    "finance-01", "finance-02", "finance-03", "finance-04", "finance-05",
    "finance-06", "production-01", "production-02", "production-03",
    "production-04", "production-05", "farming-01", "farming-02",
    "farming-03", "farming-04", "farming-05", "farming-06", "legal_hr-01",
    "legal_hr-02", "legal_hr-03", "legal_hr-04", "legal_hr-05", "legal_hr-06",
    "legal_hr-07", "data_platform-01", "data_platform-02", "data_platform-03",
    "data_platform-04", "data_platform-05", "data_platform-06",
    "data_platform-07", "data_platform-08",
)
COUNTS = {"ceo": 9, "sales": 12, "marketing": 14, "intel": 11, "finance": 9,
          "production": 6, "farming": 9, "legal_hr": 10, "data_platform": 9}


@pytest.fixture
def db():
    """TxConn: commit() của module chỉ ghi nhận — dữ liệu + `set local
    search_path` của schema tạm ở lại tx fixture tới ROLLBACK."""
    for conn in da_db():
        yield TxConn(conn)


def _doc(features, counts=None, phases=None, tong=None):
    counts = counts or dict(COUNTS)
    phases = phases or {"P1": 80, "P2": 9}
    if tong is None:
        try:
            tong = ro.summary(features, counts, phases)
        except (KeyError, TypeError, AttributeError):
            tong = {}
    return {"_doc": "x", "so_tinh_nang_hd": counts,
            "so_giai_doan_hd": phases, "tong_hop": tong,
            "features": features}


def _f(fid="ceo-01", **kw):
    d = {"id": fid, "phong_ban": fid.split("-", 1)[0],
         "pham_vi": "tinh_nang_ai", "ten": "Tính năng",
         "nguon": "PL01 mục 2 — X: 'y'", "giai_doan": "P1",
         "nguoi_duyet": "Tổng giám đốc", "owner": "Bên A",
         "dau_ra": "Đầu ra.", "modules": ["pipelines/rollout.py"],
         "agent_ids": ["agent:t_b1"],
         "output_sources": [{"table": "feature_rollout_events"}],
         "code_status": "co_code", "acceptance_status": "chua_nghiem_thu",
         "blocker": None, "phu_thuoc": [], "bang_chung": []}
    if "." in fid:
        d["nhom_goc"] = fid.split(".")[0]
    d.update(kw)
    return d


def _write(tmp_path, doc) -> Path:
    p = tmp_path / "f.json"
    p.write_bytes(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
    return p


# ------------------------------------------------------------ danh mục thật


def _real_doc():
    return json.loads(ro.FEATURES_FILE.read_bytes().decode("utf-8"))


def test_real_catalog_matches_contract():
    doc = _real_doc()
    counts = doc["so_tinh_nang_hd"]
    assert counts == COUNTS and sum(counts.values()) == 89
    assert doc["so_giai_doan_hd"] == {"P1": 80, "P2": 9}
    assert "89" in doc["_doc"] and "chờ hai bên chốt".casefold() in \
        doc["_doc"].casefold() and "ĐỀ XUẤT" in doc["_doc"]
    assert {f["phong_ban"] for f in REAL} == set(BLOCKS)
    rieng = {f["ten"] for f in REAL if f["code_status"] == "lam_rieng"}
    assert rieng == {"Website bán hàng", "Chatbot trên website"}
    # Agent không tự đổi trạng thái nghiệm thu.
    assert {f["acceptance_status"] for f in REAL} == {"chua_nghiem_thu"}
    # P2 theo PL01 mục 2 có trong danh mục với đúng giai đoạn.
    p2 = {f["ten"] for f in REAL if f["giai_doan"] == "P2"
          and f["pham_vi"] == "tinh_nang_ai"}
    # đợt hoàn thiện 22/10: 9 mục P2 theo DOCX (R&D tra cứu/tóm tắt, cảnh
    # báo thời tiết/sâu bệnh tách riêng)
    assert {"Báo cáo HĐTV", "Tra cứu tài liệu R&D", "Tóm tắt tài liệu R&D",
            "Cảnh báo thời tiết", "Cảnh báo sâu bệnh",
            "Dự báo sản lượng thu hoạch", "SEO sàn", "YouTube dài",
            "Cập nhật văn bản pháp luật mới"} == p2
    # Phủ nền tảng TMĐT (PL01 mục 3), blockchain (mục 4), nghĩa vụ ngoài code.
    pv = {f["pham_vi"] for f in REAL}
    assert pv == set(ro.PHAM_VI)
    assert any(f["code_status"] == "ngoai_code" for f in REAL)


def test_real_catalog_tong_hop_matches_and_never_claims_done():
    """tong_hop = số mục thực; chưa chốt 89 thì không có chữ 'đạt'."""
    doc = _real_doc()
    t = doc["tong_hop"]
    assert t == ro.summary(REAL, doc["so_tinh_nang_hd"],
                           doc["so_giai_doan_hd"])
    ai = [f for f in REAL if f["pham_vi"] == "tinh_nang_ai"]
    assert t["tong"]["de_xuat"] == len(ai)
    for b in BLOCKS:
        assert t[b]["de_xuat"] == sum(f["phong_ban"] == b for f in ai)
    for k, v in t.items():
        if k == "ngoai_89":
            continue
        assert "chờ hai bên chốt" in v["trang_thai"], k
        assert "đạt" not in v["trang_thai"], k
        if v["de_xuat"] != v["hd"]:
            assert v["trang_thai"].startswith("chưa xác định"), k
    assert t["tong"]["de_xuat"] != 89 or "khớp số lượng" in \
        t["tong"]["trang_thai"]


def test_v13_board_summary_matches_catalog():
    """Drift-guard: bảng tóm tắt trong docs/handover/v13-board.md = số thật."""
    md = (ROOT / "docs" / "handover" / "v13-board.md").read_bytes()\
        .decode("utf-8")
    t = ro.summary(REAL, COUNTS, {"P1": 80, "P2": 9})
    for b in BLOCKS:
        m = re.search(rf"^\| {b} \| (\d+) \| (\d+) \|", md, re.MULTILINE)
        assert m and (int(m[1]), int(m[2])) == (t[b]["hd"],
                                                t[b]["de_xuat"]), b
    assert (f"| P1 / P2 | 80 / 9 | {t['P1']['de_xuat']} / "
            f"{t['P2']['de_xuat']} |") in md
    assert f"| Tổng | 89 | {t['tong']['de_xuat']} |" in md
    for row in ("| C00 |", "| C08 |", "| C11 |"):
        assert row in md


def test_real_catalog_old_group_ids_traceable():
    """ID nhóm v12 còn nguyên hoặc là nhom_goc — lịch sử sổ truy được."""
    ids, sm = {f["id"] for f in REAL}, ro.split_map(REAL)
    assert len(OLD_IDS) == 59
    for old in OLD_IDS:
        assert (old in ids) != (old in sm), old
    # đợt hoàn thiện 22/10: nhóm còn 1 mục khi mục kia GỘP/CHUYỂN (id cũ
    # nằm trong da_thay_the) — vẫn truy được (mục còn + id cũ bị thay).
    gone = {g["id"] for g in _real_doc().get("da_thay_the", [])}
    for g, kids in sm.items():
        former = {o for o in gone if o.startswith(g + ".")}
        assert g in OLD_IDS and len(kids) + len(former) >= 2, g


def test_real_catalog_every_item_has_source_and_blocker_rule():
    for f in REAL:
        if f["pham_vi"] == "tinh_nang_ai":
            assert re.fullmatch(r"PL01 mục 2 — [^:]+: '[^']+'",
                                f["nguon"]), f["id"]
        else:
            assert f["nguon"].startswith(("PL01 mục", "HĐ", "PL02")), \
                f["id"]
        if f["code_status"] != "co_code":
            assert f["blocker"], f["id"]
        if f["code_status"] in ("lam_rieng", "ngoai_code", "thieu"):
            assert f["owner"] and f["phu_thuoc"], f["id"]


def test_real_catalog_website_contract():
    """Website + chatbot web làm riêng: blocker repo/owner + hợp đồng giao
    tiếp tối thiểu (nguồn đơn cho đối soát, cùng guardrail/PII/handoff/
    rollout)."""
    by = {f["id"]: f for f in REAL}
    web, bot = by["sales-08"], by["sales-09"]
    for f in (web, bot):
        assert f["code_status"] == "lam_rieng"
        assert "chưa xác định" in f["blocker"]
    assert web["pham_vi"] == "nen_tang_tmdt"
    assert bot["pham_vi"] == "tinh_nang_ai"
    w = " ".join(web["phu_thuoc"])
    assert "orders" in w and "settlement_csv" in w and "rượu" in w.lower()
    b = " ".join(bot["phu_thuoc"])
    for k in ("channels.py", "llm_gateway", "cskh_handoff", "rollout",
              "reply_ms"):
        assert k in b, k


def test_real_catalog_no_shared_actor_mkt02():
    """F04: actor mkt02 từng dùng chung sales-03 + marketing-01 → đếm chéo."""
    owners = [f["id"] for f in REAL if "agent:mkt02" in f["agent_ids"]]
    assert owners == ["marketing-01.1"]   # đợt hoàn thiện: tách 01.1/01.2
    by = {f["id"]: f for f in REAL}
    assert {"table": "content_drafts", "created_by": "agent:mkt02",
            "content_type": "listing"} in by["sales-03"]["output_sources"]


def _src_text(mods) -> str:
    return "".join((ROOT / m).read_bytes().decode("utf-8") for m in mods)


def _directors() -> dict:
    out = {}
    for b in BLOCKS:
        p = ROOT / "data" / "directors" / f"{b}.json"
        out[b] = json.loads(p.read_bytes().decode("utf-8"))["object_types"]
    return out


def test_real_catalog_output_sources_point_to_real_code():
    """output_sources trỏ object_type có thật trong data/directors/*.json
    và literal có trong module của mục; bảng có thật trong schema."""
    dirs = _directors()
    schema = (ROOT / "docs" / "schema.sql").read_bytes().decode("utf-8")
    director_src = (ROOT / "pipelines" / "director.py").read_bytes() \
        .decode("utf-8")
    for f in REAL:
        src = _src_text(f["modules"])
        for d in f["output_sources"]:
            w = (f["id"], d)
            if "report" in d:
                pre = d["report"]
                m = re.fullmatch(r"director-([a-z_]+)-", pre)
                if m:
                    assert m.group(1) in BLOCKS and 'f"director-{' in \
                        director_src, w
                else:
                    assert pre in src, w
                continue
            if "file" in d:
                assert d["file"] in src, w
                continue
            t = d["table"]
            assert re.search(rf"create table if not exists {t} \(",
                             schema), w
            if t == "approval_queue":
                assert d["object_type"] in dirs[d["block"]], w
                assert f'"{d["object_type"]}"' in src, w
                if "created_by" in d:
                    assert d["created_by"] in src, w
            elif t == "content_drafts":
                assert f'"{d["created_by"]}"' in src, w
                assert f'"{d["content_type"]}"' in src, w
            else:
                assert t in src, w
            if "source_agent" in d:
                assert f'"{d["source_agent"]}"' in src, w
            for r in d.get("rules_any", []):
                assert f'"{r}"' in src, w


def test_real_catalog_bang_chung_exist():
    for f in REAL:
        for t in f["bang_chung"]:
            assert t.startswith("tests/test_") and (ROOT / t).is_file(), \
                (f["id"], t)
        if f["code_status"] in ro.CODED:
            assert f["bang_chung"], f["id"]


def test_real_catalog_lane_features_present():
    mods = {m for f in REAL for m in f["modules"]}
    assert LANE_FILES <= mods
    assert "pipelines/rollout.py" in mods and "connectors/zalo.py" in mods


def _missing(paths):
    return sorted(p for p in paths if not (ROOT / p).is_file())


def test_real_catalog_modules_exist():
    paths = {m for f in REAL for m in f["modules"]} - LANE_FILES
    assert _missing(paths) == []
    for f in REAL:
        if f["code_status"] in ("lam_rieng", "ngoai_code"):
            assert f["modules"] == [] and f["agent_ids"] == []


@pytest.mark.xfail(bool(_missing(LANE_FILES)), strict=True,
                   reason="module lane v12.2–v12.6 chưa gộp vào nhánh này")
def test_lane_modules_exist_after_merge():
    assert _missing(LANE_FILES) == []


def test_agent_ids_are_real_actors():
    """agent_ids phải là chuỗi có thật trong code (không bịa actor)."""
    src = "".join(p.read_bytes().decode("utf-8") for d in
                  ("agents", "pipelines", "connectors", "scripts", "ingest")
                  for p in (ROOT / d).glob("*.py"))
    for f in REAL:
        for a in f["agent_ids"]:
            assert f'"{a}"' in src, (f["id"], a)


@pytest.mark.parametrize("doc,needle", [
    (_doc([_f()], counts={"ceo": 89}), "so_tinh_nang_hd"),
    (_doc([_f()], counts={b: 1 for b in BLOCKS}), "tổng 89"),
    (_doc([_f()], phases={"P1": 89}), "so_giai_doan_hd"),
    (_doc([_f()], phases={"P1": 80, "P2": 8}), "so_giai_doan_hd"),
    (_doc([]), "rỗng"),
    (_doc([_f("CEO-01")]), "id"),
    (_doc([_f("ceo-1")]), "id"),
    (_doc([_f("ceo-01.x")]), "id"),
    (_doc([_f("ceo-01.123")]), "id"),
    (_doc([_f(), _f(agent_ids=[], output_sources=[],
                    output_sources_note="x")]), "trùng"),
    (_doc([_f(phong_ban="sales")]), "phong_ban"),
    (_doc([_f("co_khi-01")]), "phong_ban"),
    (_doc([_f(ten=" ")]), "ten"),
    (_doc([_f(nguon="")]), "nguon"),
    (_doc([_f(dau_ra=None)]), "dau_ra"),
    (_doc([_f(nguoi_duyet=" ")]), "nguoi_duyet"),
    (_doc([_f(giai_doan="P3")]), "giai_doan"),
    (_doc([_f(code_status="xong")]), "code_status"),
    (_doc([_f(pham_vi="khac")]), "pham_vi"),
    (_doc([_f(acceptance_status="dat")]), "acceptance_status"),
    (_doc([_f(acceptance_status="da_nghiem_thu")]), "bien_ban"),
    (_doc([_f(modules=[])]), "co_code phải có"),
    (_doc([_f(code_status="mot_phan", modules=[], blocker="b")]),
     "mot_phan phải có"),
    (_doc([_f(modules="a.py")]), "modules"),
    (_doc([_f(modules=["a.py", "a.py"])]), "trùng"),
    (_doc([_f(agent_ids=[""])]), "agent_ids"),
    (_doc([_f(code_status="lam_rieng", agent_ids=[], blocker="b")]),
     "lam_rieng không có module"),
    (_doc([_f("ceo-02.1", nhom_goc="ceo-03")]), "nhom_goc"),
    (_doc([_f("ceo-02.1", nhom_goc=None)]), "nhom_goc"),
    (_doc([_f(nhom_goc="ceo-01")]), "nhom_goc"),
    (_doc([_f(code_status="mot_phan")]), "blocker"),
    (_doc([_f(code_status="thieu", modules=[], agent_ids=[])]), "blocker"),
    (_doc([_f(blocker=" ")]), "blocker"),
    (_doc([_f(output_sources=[])]), "output_sources_note"),
    (_doc([_f(output_sources="approval_queue")]), "output_sources"),
    (_doc([_f(output_sources=[{"table": "approval_queue",
                               "block": "ceo"}])]), "object_type"),
    (_doc([_f(output_sources=[{"table": "content_drafts",
                               "created_by": "agent:x"}])]), "content_type"),
    (_doc([_f(output_sources=[{"table": "x", "report": "y-"}])]),
     "đúng 1"),
    (_doc([_f(output_sources=[{"table": "x", "where": "1=1"}])]), "key"),
    (_doc([_f(output_sources=[{"table": " "}])]), "rỗng"),
    (_doc([_f(phu_thuoc="C03")]), "phu_thuoc"),
    # F04: 2 mục chung 1 actor / 1 nguồn đầu ra → đếm chéo.
    (_doc([_f(), _f("ceo-02", output_sources=[{"report": "x-"}])]),
     "không đếm chéo"),
    (_doc([_f(), _f("ceo-02", agent_ids=["agent:khac"])]),
     "không đếm chéo"),
    (_doc([_f()], tong={"ceo": {}}), "tong_hop"),
    ({"features": [_f()]}, "không đọc được"),
])
def test_load_features_rejects(tmp_path, doc, needle):
    with pytest.raises(ValueError) as e:
        ro.load_features(_write(tmp_path, doc))
    assert needle in str(e.value)


def test_load_features_unreadable(tmp_path):
    p = tmp_path / "f.json"
    p.write_bytes(b"\xff{")
    with pytest.raises(ValueError, match="không đọc được"):
        ro.load_features(p)
    with pytest.raises(ValueError, match="không đọc được"):
        ro.load_features(tmp_path / "missing.json")


def test_load_features_thieu_without_modules_ok(tmp_path):
    feats = ro.load_features(_write(tmp_path, _doc(
        [_f(), _f("ceo-02", modules=[], agent_ids=[], output_sources=[],
                  code_status="thieu", blocker="chưa có code")])))
    assert [f["id"] for f in feats] == ["ceo-01", "ceo-02"]


def test_load_features_split_and_summary(tmp_path):
    feats = ro.load_features(_write(tmp_path, _doc(
        [_f("ceo-02.1"), _f("ceo-02.2", agent_ids=[], output_sources=[],
                            output_sources_note="stdout"),
         _f("sales-08", pham_vi="nen_tang_tmdt", modules=[], agent_ids=[],
            output_sources=[], code_status="lam_rieng", blocker="b"),
         _f("ceo-05", giai_doan="P2", agent_ids=[], output_sources=[
             {"table": "approval_queue", "block": "ceo",
              "object_type": "hdtv_pack"}])])))
    assert ro.split_map(feats) == {"ceo-02": ["ceo-02.1", "ceo-02.2"]}
    t = ro.summary(feats, COUNTS, {"P1": 80, "P2": 9})
    assert t["ceo"] == {"hd": 9, "de_xuat": 3, "trang_thai":
                        "chưa xác định — chờ hai bên chốt (đề xuất 3/9)"}
    assert t["P2"]["de_xuat"] == 1 and t["tong"]["de_xuat"] == 3
    assert t["ngoai_89"]["nen_tang_tmdt"] == 1
    one = [_f("finance-0" + str(i), agent_ids=[], output_sources=[],
              output_sources_note="x") for i in range(1, 10)]
    assert ro.summary(one, COUNTS, {"P1": 80, "P2": 9})["finance"][
        "trang_thai"] == "khớp số lượng — nội dung chờ hai bên chốt"


# ------------------------------------------------------------ lịch + cổng


def test_real_shift_is_mon_fri_assumption():
    assert SHIFT["workdays"] == frozenset(range(5))
    doc = json.loads(ro.CONFIG_FILE.read_bytes().decode("utf-8"))
    assert "GIẢ ĐỊNH" in doc["_doc"]


@pytest.mark.parametrize("cfg,needle", [
    ({"workdays": [], "holidays": []}, "workdays"),
    ({"workdays": [7]}, "workdays"),
    ({"workdays": [0], "holidays": ["01/01/2027"]}, "YYYY-MM-DD"),
    ({"holidays": []}, "không đọc được"),
])
def test_load_shift_rejects(tmp_path, cfg, needle):
    p = tmp_path / "c.json"
    p.write_bytes(json.dumps(cfg).encode("utf-8"))
    with pytest.raises(ValueError, match=needle):
        ro.load_shift(p)


def _vn(y, m, d, h=9):
    return datetime(y, m, d, h, tzinfo=VN_TZ)


def test_business_days_boundaries():
    mon = _vn(2026, 10, 12)
    assert ro.business_days(mon, mon, SHIFT) == 0
    assert ro.business_days(mon, mon + timedelta(days=-3), SHIFT) == 0
    assert ro.business_days(_vn(2026, 10, 16), _vn(2026, 10, 19), SHIFT) == 1
    assert ro.business_days(mon, _vn(2026, 10, 17), SHIFT) == 4   # T3..T6
    assert ro.business_days(mon, _vn(2026, 10, 19), SHIFT) == 5
    hol = ro.period.parse_shift({"start": "00:00", "end": "23:59",
                                 "workdays": [0, 1, 2, 3, 4],
                                 "holidays": ["2026-10-14"]})
    assert ro.business_days(mon, _vn(2026, 10, 19), hol) == 4
    # 17:30 UTC = 00:30 VN hôm sau — đếm theo ngày VN.
    since = datetime(2026, 10, 12, 17, 30, tzinfo=timezone.utc)   # T3 VN
    assert ro.business_days(since, _vn(2026, 10, 14), SHIFT) == 1


def test_business_days_rejects_bad_types():
    with pytest.raises(ValueError):
        ro.business_days(datetime(2026, 10, 12),  # noqa: DTZ001 — naive
                         _vn(2026, 10, 13), SHIFT)
    with pytest.raises(TypeError):
        ro.business_days(date(2026, 10, 12), _vn(2026, 10, 13), SHIFT)
    with pytest.raises(TypeError):
        ro.business_days("2026-10-12", _vn(2026, 10, 13), SHIFT)


# v13.3 (F03/F04): (out_days, human, unapproved) — đầu ra rải ≥5 ngày làm
# việc; có người duyệt cần ≥1 đầu ra NGƯỜI duyệt + 0 đầu ra thiếu người.
# Đã FLIP ca cũ ("co_nguoi_duyet", 10, None, 0) → van_hanh không lý do:
# đó chính là lỗi F03 (10 ngày + 0 đầu ra/duyệt mà vẫn vận hành).
@pytest.mark.parametrize(
    "stage,days,outputs,severe,extra,target,n_why,needle", [
        ("chay_thu", 5, 50, 0, (5, 0, 0), "co_nguoi_duyet", 0, None),
        ("chay_thu", 4, 50, 0, (5, 0, 0), "co_nguoi_duyet", 1, "4/5"),
        ("chay_thu", 5, 49, 0, (5, 0, 0), "co_nguoi_duyet", 1, "49/50"),
        ("chay_thu", 5, 50, 0, (4, 0, 0), "co_nguoi_duyet", 1, "rải trên 4/5"),
        ("chay_thu", 5, 50, 0, (), "co_nguoi_duyet", 1, "rải trên 0/5"),
        ("chay_thu", 9, None, 0, (), "co_nguoi_duyet", 1, "không đếm được"),
        ("chay_thu", 0, 0, 0, (), "co_nguoi_duyet", 3, None),
        ("co_nguoi_duyet", 10, 3, 0, (3, 1, 0), "van_hanh", 0, None),
        ("co_nguoi_duyet", 10, None, 0, (), "van_hanh", 1, "không đếm được"),
        ("co_nguoi_duyet", 10, 0, 0, (), "van_hanh", 1, "chưa có đầu ra"),
        ("co_nguoi_duyet", 10, 5, 0, (5, 0, 0), "van_hanh", 1,
         "NGƯỜI duyệt"),
        ("co_nguoi_duyet", 10, 5, 0, (5, 2, 1), "van_hanh", 1,
         "1 đầu ra được duyệt/dùng không có người"),
        ("co_nguoi_duyet", 9, 1, 0, (1, 1, 0), "van_hanh", 1, "9/10"),
        ("co_nguoi_duyet", 30, 1, 1, (1, 1, 0), "van_hanh", 1,
         "lỗi nghiêm trọng"),
        ("tat", 0, None, 3, (), "chay_thu", 0, None),
        ("van_hanh", 99, 99, 0, (), None, 1, "đã vận hành"),
    ])
def test_evaluate(stage, days, outputs, severe, extra, target, n_why,
                  needle):
    t, why = ro.evaluate(stage, days, outputs, severe, *extra)
    assert t == target and len(why) == n_why, why
    if needle:
        assert needle in "; ".join(why)


@pytest.mark.parametrize("by", [None, "", "  ", "agent:kd_a1", "System:sla",
                                 " AGENT:x", "a" * 101, "tên\nngười", 5])
def test_check_by_rejects(by):
    with pytest.raises(ValueError):
        ro.check_by(by)


def test_check_by_and_note():
    assert ro.check_by("  GĐ bán hàng ") == "GĐ bán hàng"
    assert ro._clean_note("  ") is None and ro._clean_note(None) is None
    n = ro._clean_note("khách 0905123456 phản ánh " + "x" * 500)
    assert "0905123456" not in n and len(n) <= ro.MAX_NOTE


# ------------------------------------------------------------ hồ sơ thuần


def test_evidence_status(tmp_path):
    (tmp_path / "a.py").write_bytes(b"latency_ms = 1\n")
    assert ro.evidence_status((), tmp_path) == "chưa có bằng chứng"
    assert ro.evidence_status((("a.py", None),), tmp_path).startswith("có")
    assert ro.evidence_status((("a.py", "latency_ms"),),
                              tmp_path).startswith("có")
    s = ro.evidence_status((("a.py", "p95"), ("b.py", None)), tmp_path)
    assert s == "chưa có bằng chứng (thiếu a.py, b.py)"


def test_criteria_cover_pl02_muc2():
    names = [c[0] for c in ro.CRITERIA]
    assert len(names) == 11 and len(set(names)) == 11
    assert names[0].startswith("Lỗi nghiêm trọng")
    assert len(ro.SEVERE) == 7
    # Bằng chứng tham chiếu file có thật hoặc file lane khác tạo sau gộp.
    allowed = LANE_FILES | {"deploy/onprem/README.md"}
    for _, _, _, ev in ro.CRITERIA:
        for rel, _ in ev:
            assert (ROOT / rel).is_file() or rel in allowed, rel


def _row(fid, stage=None, days=0, outputs=None, severe=0, ten="T",
         out_days=5):
    f = _f(fid, ten=ten)
    if stage is None:
        return {"feature": f, "stage": None, "since": None, "facts": None}
    t, why = ro.evaluate(stage, days, outputs, severe, out_days)
    return {"feature": f, "stage": stage, "since": _vn(2026, 10, 12),
            "facts": {"days": days, "outputs": outputs, "severe": severe,
                      "out_days": out_days, "human": 0, "unapproved": 0,
                      "uncounted": [], "target": t, "why": why}}


def test_render_dossier_sections():
    rows = [_row("ceo-01"), _row("ceo-02", "chay_thu", 6, 50),
            _row("ceo-03", "chay_thu", 2, None, ten="A | B"),
            _row("sales-01", "van_hanh", 30, 80)]
    sev = [{"ts": _vn(2026, 10, 13), "feature_id": "ceo-02",
            "severe_code": "lo_pii", "from_stage": "co_nguoi_duyet",
            "note": "SĐT 0905123456 lộ", "by_person": "GĐ bán hàng"}]
    leg = [{"id": "ceo-04", "stage": "co_nguoi_duyet",
            "since": _vn(2026, 10, 1), "tach_thanh": ["ceo-04.1", "ceo-04.2"]}]
    md = ro.render_dossier("P1", rows, sev, 1, _vn(2026, 10, 20), legacy=leg)
    assert ("- ceo-04 (có người duyệt từ 01/10/2026) → ceo-04.1, ceo-04.2"
            in md) and "CHƯA được hai bên chốt" in md
    for h in ("# Hồ sơ đề nghị nghiệm thu P1",
              "## 1. Danh sách tính năng (4 mục)",
              "## 2. Kết quả chạy thử", "## 3. Nhật ký lỗi",
              "## 4. Tiêu chí kỹ thuật", "## 8. Ký nhận", "20/10/2026",
              "DỰ THẢO", "## 3b. Nhật ký sự cố vận hành",
              "## 6. Phiên bản bàn giao", "## 7. Ngoại lệ"):
        assert h in md, h
    assert re.search(r"\| ceo-01 \|.*chưa vào sổ", md)
    assert "không đếm được" in md and "A / B" in md
    assert "`ceo-02` chạy thử: đủ điều kiện nâng lên có người duyệt" in md
    assert "`ceo-03` chạy thử: CHƯA đủ" in md and "`sales-01` vận hành" in md
    assert "Lộ dữ liệu cá nhân" in md and "0905123456" not in md
    sec4 = md.split("## 4.", 1)[1].split("## 6.", 1)[0]
    assert sec4.count("\n| ") == len(ro.CRITERIA) + 1
    assert "1 lỗi ghi nhận (1 lần vào giai đoạn có người duyệt)" in sec4
    # đợt an toàn A06: 3 chỉ tiêu phản hồi/sửa lỗi trỏ sổ sự cố thật (trước
    # đây "—"/chưa có bằng chứng dù sổ ops_incidents đã có từ v13.7)
    assert sec4.count("pipelines.ops_incidents --list") == 3
    # không đọc được sổ sự cố → CHƯA CÓ DỮ LIỆU (không suy 0 sự cố)
    assert "CHƯA CÓ DỮ LIỆU" in md.split("## 3b.", 1)[1].split("## 4.")[0]


def test_render_dossier_empty():
    md = ro.render_dossier("P2", [_row("ceo-05")], [], 0, _vn(2026, 10, 20))
    assert "Chưa tính năng nào vào sổ" in md
    assert "Chưa ghi nhận lỗi nghiêm trọng nào" in md
    assert "chưa có tính năng nào qua giai đoạn có người duyệt" in md


# ------------------------------------------------------------ CLI không DB


@pytest.mark.parametrize("argv", [
    [], ["--seed", "--status"], ["--promote", "ceo-01"],
    ["--promote", "ceo-01", "--by", "agent:x"], ["--seed", "--by", " "],
    ["--severe", "ceo-01", "--by", BY],
    ["--severe", "ceo-01", "--reason", "khac", "--by", BY],
    ["--promote", "ceo-01", "--by", BY, "--reason", "lo_pii"],
    ["--promote", "ceo-01", "--by", BY, "--note", "x"],
    ["--dossier"], ["--status", "--phase", "P1"], ["--status", "--out", "x"],
    ["--dossier", "--phase", "P3"], ["--catalog", "--status"],
    ["--catalog", "--phase", "P1"],
])
def test_cli_usage_errors(argv, monkeypatch):
    monkeypatch.setattr(ro, "connect", lambda: pytest.fail("không connect"))
    with pytest.raises(SystemExit) as e:
        ro.main(argv)
    assert e.value.code == 2


def test_cli_catalog_no_db(monkeypatch, capsys):
    monkeypatch.setattr(ro, "connect", lambda: pytest.fail("không connect"))
    assert ro.main(["--catalog"]) == 0
    out = capsys.readouterr().out
    assert "BẢN ĐỀ XUẤT" in out and "tong" in out
    assert "tách sales-07 → sales-07.1, sales-07.2, sales-07.3" in out


def test_cli_db_down_and_bad_config(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(ro, "connect", lambda: None)
    assert ro.main(["--status"]) == 2
    assert "DB không kết nối" in capsys.readouterr().err
    monkeypatch.setattr(ro, "FEATURES_FILE", tmp_path / "missing.json")
    assert ro.main(["--status"]) == 2
    assert "cấu hình" in capsys.readouterr().err


# ------------------------------------------------------------ DB


SRC = {"table": "approval_queue", "block": "ceo",
       "object_type": "weekly_report"}
FEATS = [_f("ceo-01", output_sources=[SRC]),
         _f("ceo-02", agent_ids=[], output_sources=[{"report": "b-"}]),
         _f("sales-08", modules=[], agent_ids=[], output_sources=[],
            code_status="lam_rieng", blocker="repo website chưa xác định"),
         _f("ceo-05", giai_doan="P2", agent_ids=["agent:t_b1_p2"],
            output_sources=[{"report": "c-"}])]
NOW = datetime.now(VN_TZ)


def _log(conn, actor, n):
    for i in range(n):
        conn.execute("insert into agent_action_log (actor, action,"
                     " object_type, object_id) values (%s, 'test_b1',"
                     " 't', %s)", (actor, str(i)))


def _workdays_after(t, k):
    d, out = ro.period.vn_date(t), []
    while len(out) < k:
        d += timedelta(days=1)
        if d.weekday() < 5:
            out.append(d)
    return out


def _out(conn, n, start, *, days=5, block="ceo", otype="weekly_report",
         by="agent:t_b1", status="pending", lane=None, decided_by=None,
         ok=True, oid="w", title="Báo cáo tuần"):
    """n đầu ra `approval_queue` (object_id riêng) rải đều trên `days` ngày
    làm việc đầu tiên SAU ngày VN của `start`, 10:00 VN. Tắt tạm trigger
    guard (ép created_at=now()) chỉ để dựng mốc thời gian quá khứ."""
    ds = _workdays_after(start, days)
    conn.execute("alter table approval_queue disable trigger"
                 " approval_queue_guard_row")
    try:
        for i in range(n):
            ts = datetime.combine(ds[i % days], datetime.min.time(),
                                  VN_TZ).replace(hour=10)
            conn.execute(
                "insert into approval_queue (object_type, object_id, block,"
                " title, payload, content_sha256, risk, guardrail,"
                " created_by, created_at, due_at, status, lane, decided_by,"
                " decided_at) values (%s, %s, %s, %s, 'p', %s, 'low',"
                " %s::jsonb, %s, %s, %s, %s, %s, %s, %s)",
                (otype, f"{oid}-{i}-{ts:%Y%m%d}", block, title, "0" * 64,
                 json.dumps({"ok": ok}), by, ts, ts + timedelta(days=3),
                 status, lane, decided_by,
                 ts if status != "pending" else None))
    finally:
        conn.execute("alter table approval_queue enable trigger"
                     " approval_queue_guard_row")


def _state(conn, fid):
    return conn.execute("select stage, stage_since from feature_rollout"
                        " where feature_id = %s", (fid,)).fetchone()


def _events(conn, fid):
    return [r[0] for r in conn.execute(
        "select kind from feature_rollout_events where feature_id = %s"
        " order by id", (fid,))]


def test_schema_tables_append_only_and_checks(db):
    ro.seed(db, FEATS, BY, now=NOW)
    for sql in ("update feature_rollout_events set note = 'x'",
                "delete from feature_rollout_events",
                "truncate feature_rollout_events cascade"):
        with pytest.raises(psycopg.errors.RaiseException), db.transaction():
            db.execute(sql)
    bad = [
        ("ceo-01", "seed", None, "chay_thu", None, "agent:x"),
        ("ceo-01", "seed", None, "chay_thu", None, "System:sla"),
        ("ceo-01", "severe", "chay_thu", "chay_thu", None, BY),
        ("ceo-01", "seed", None, "chay_thu", "lo_pii", BY),
        ("ceo-01", "seed", None, "xong", None, BY),
        ("ceo-01", "khac", None, "chay_thu", None, BY),
    ]
    for p in bad:
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute("insert into feature_rollout_events (feature_id, kind,"
                       " from_stage, to_stage, severe_code, by_person) values"
                       " (%s, %s, %s, %s, %s, %s)", p)
    for p in (("CEO-01", "chay_thu"), ("ceo-09", "xong"),
              ("ceo-09.x", "chay_thu"), ("ceo-09.123", "chay_thu"),
              ("ceo-09.", "chay_thu")):
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute("insert into feature_rollout (feature_id, stage,"
                       " updated_by) values (%s, %s, 'x')", p)
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        db.execute("insert into feature_rollout_events (feature_id, kind,"
                   " to_stage, by_person) values ('ceo-77', 'seed',"
                   " 'chay_thu', %s)", (BY,))


def test_split_items_seed_new_clock_keep_old_history(db):
    """Migration ID: nhóm v12 'ceo-04' đã chạy thử 30 ngày → danh mục v13
    tách ceo-04.1/.2: dòng + sự kiện nhóm cũ giữ nguyên; mục tách vào sổ với
    mốc MỚI (không kế thừa 30 ngày), evidence ghi nhom_goc; nhóm 'tat' →
    mục tách vào 'tat' (không tự bật lại)."""
    t0 = NOW - timedelta(days=30)
    old = [_f("ceo-04", output_sources=[{"report": "a-"}]),
           _f("ceo-06", agent_ids=[], output_sources=[{"report": "d-"}])]
    ro.seed(db, old, BY, now=t0)
    ro.disable(db, "ceo-06", BY, now=t0 + timedelta(days=1))
    new = [_f("ceo-04.1", agent_ids=[], output_sources=[{"report": "e-"}]),
           _f("ceo-04.2", agent_ids=[], output_sources=[{"report": "f-"}]),
           _f("ceo-06.1", agent_ids=[], output_sources=[{"report": "g-"}])]
    st = ro.seed(db, new, BY, now=NOW)
    assert st["inserted"] == 3
    assert _state(db, "ceo-04") == ("chay_thu", t0)
    assert _events(db, "ceo-04") == ["seed"]
    for fid in ("ceo-04.1", "ceo-04.2"):
        assert _state(db, fid) == ("chay_thu", NOW)
        ev = db.execute("select evidence from feature_rollout_events where"
                        " feature_id = %s", (fid,)).fetchone()[0]
        assert ev == {"nhom_goc": "ceo-04", "stage_nhom_goc": "chay_thu"}
    assert _state(db, "ceo-06.1")[0] == "tat"
    leg = ro.legacy_rows(db, new)
    assert [(r["id"], r["tach_thanh"]) for r in leg] == [
        ("ceo-04", ["ceo-04.1", "ceo-04.2"]), ("ceo-06", ["ceo-06.1"])]
    _log(db, "agent:t_b1", 80)          # actor của nhóm cũ — không tính
    with pytest.raises(ro.RolloutError, match="ngày làm việc"):
        ro.promote(db, new, "ceo-04.1", BY, SHIFT)
    md = ro.dossier(db, new, "P1", SHIFT)
    assert "ceo-04 (chạy thử từ" in md and "→ ceo-04.1, ceo-04.2" in md


def test_roles_select_only(db):
    for t in ("feature_rollout", "feature_rollout_events"):
        for priv, want in (("select", True), ("insert", False),
                           ("update", False), ("delete", False)):
            assert db.execute("select has_table_privilege('app_human', %s,"
                              " %s)", (t, priv)).fetchone()[0] is want
        # v13.3: agent đọc được giai đoạn hiện hành (mode() ở biên sinh) —
        # chỉ bảng trạng thái, không nhật ký sự kiện, không ghi.
        assert db.execute("select has_table_privilege('agent_writer', %s,"
                          " 'select')", (t,)).fetchone()[0] is (
                              t == "feature_rollout")
        for priv in ("insert", "update", "delete"):
            assert db.execute("select has_table_privilege('agent_writer',"
                              " %s, %s)", (t, priv)).fetchone()[0] is False


def test_seed_idempotent_only_co_code(db):
    st = ro.seed(db, FEATS, BY, now=NOW - timedelta(days=30))
    assert st == {"inserted": 3, "existing": 0, "skipped": 1} and db.committed
    assert _state(db, "sales-08") is None
    st2 = ro.seed(db, FEATS, BY, now=NOW)
    assert st2 == {"inserted": 0, "existing": 3, "skipped": 1}
    stage, since = _state(db, "ceo-01")
    assert stage == "chay_thu" and since < NOW - timedelta(days=29)
    assert _events(db, "ceo-01") == ["seed"]
    with pytest.raises(ValueError):
        ro.seed(db, FEATS, "agent:x")


def test_promote_refusals_write_nothing(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=1))
    with pytest.raises(ro.RolloutError, match="không có trong danh mục"):
        ro.promote(db, FEATS, "ceo-99", BY, SHIFT)
    with pytest.raises(ro.RolloutError, match="lam_rieng"):
        ro.promote(db, FEATS, "sales-08", BY, SHIFT)
    mp = FEATS + [_f("intel-01", agent_ids=[], code_status="mot_phan",
                     blocker="thiếu OCR", output_sources=[{"report": "z-"}])]
    with pytest.raises(ro.RolloutError, match="mot_phan"):
        ro.promote(db, mp, "intel-01", BY, SHIFT)
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.promote(db, FEATS + [_f("intel-01")], "intel-01", BY, SHIFT)
    _log(db, "agent:t_b1", 60)
    with pytest.raises(ro.RolloutError, match="ngày làm việc"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert _state(db, "ceo-01")[0] == "chay_thu"
    assert _events(db, "ceo-01") == ["seed"]
    with pytest.raises(ValueError):
        ro.promote(db, FEATS, "ceo-01", "system:x", SHIFT)


def test_promote_no_countable_source_fail_closed(db):
    """v13.3: nguồn đầu ra chỉ là file nhật ký (chưa có bộ đếm) → không đếm
    được → từ chối, kể cả khi agent_action_log đầy log (F04).
    v14.3 FLIP có lý do: nguồn `report` nay có bộ đếm (`report_outputs`) —
    80 log action vẫn = 0 đầu ra (không còn "không đếm được")."""
    feats = FEATS + [_f("intel-02", agent_ids=[],
                        output_sources=[{"file": "x.jsonl"}])]
    ro.seed(db, feats, BY, now=NOW - timedelta(days=60))
    _log(db, "agent:t_b1", 80)
    with pytest.raises(ro.RolloutError, match="không đếm được"):
        ro.promote(db, feats, "intel-02", BY, SHIFT)
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, feats, "ceo-02", BY, SHIFT)


def test_promote_counts_outputs_only_since_stage_start(db):
    t0 = NOW - timedelta(days=30)
    ro.seed(db, FEATS, BY, now=t0)
    _out(db, 49, t0)
    _out(db, 10, t0, otype="weekly_board", oid="khac")   # tính năng khác
    with pytest.raises(ro.RolloutError, match="49/50"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    _out(db, 1, t0, oid="them")
    n = db.committed
    r = ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert (r["from"], r["to"]) == ("chay_thu", "co_nguoi_duyet")
    assert db.committed == n + 1
    ev = db.execute("select from_stage, to_stage, evidence, by_person from"
                    " feature_rollout_events where kind = 'promote'"
                    ).fetchone()
    assert ev[:2] == ("chay_thu", "co_nguoi_duyet") and ev[3] == BY
    assert ev[2]["outputs"] == 50 and ev[2]["days"] >= 5
    assert ev[2]["out_days"] == 5
    # Đầu ra tạo TRƯỚC mốc vào giai đoạn không được tính.
    f3 = [_f("ceo-03", output_sources=[SRC])]
    ro.seed(db, f3, BY, now=NOW + timedelta(hours=1))
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, f3, "ceo-03", BY, SHIFT,
                   now=NOW + timedelta(days=30))


def test_review_stage_needs_10_days_and_no_severe(db):
    t0 = NOW - timedelta(days=40)
    ro.seed(db, FEATS, BY, now=t0)
    _out(db, 50, t0)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=14))
    t1 = t0 + timedelta(days=14)
    _out(db, 2, t1, days=2, oid="duyet", status="approved", lane="per_item",
         decided_by="GĐ bán hàng")
    with pytest.raises(ro.RolloutError, match="/10 ngày"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t1 + timedelta(days=7))
    # Lỗi chèn tay không kèm đổi giai đoạn vẫn chặn (phòng thủ 2 lớp).
    db.execute("insert into feature_rollout_events (ts, feature_id, kind,"
               " from_stage, to_stage, severe_code, by_person) values"
               " (%s, 'ceo-01', 'severe', 'co_nguoi_duyet', 'co_nguoi_duyet',"
               " 'tu_cam', %s)", (t1 + timedelta(days=1), BY))
    with pytest.raises(ro.RolloutError, match="1 lỗi nghiêm trọng"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t1 + timedelta(days=20))
    assert _state(db, "ceo-01")[0] == "co_nguoi_duyet"


def test_full_path_to_van_hanh_then_no_more(db):
    t0 = NOW - timedelta(days=40)
    ro.seed(db, FEATS, BY, now=t0)
    _out(db, 50, t0)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=8))
    t1 = t0 + timedelta(days=8)
    # Có người duyệt: 10 ngày mà KHÔNG có đầu ra người duyệt → chưa vận
    # hành (F03 — trước v13.3 chỉ đếm ngày là nâng).
    with pytest.raises(ro.RolloutError, match="chưa có đầu ra nào"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT,
                   now=t0 + timedelta(days=24))
    _out(db, 1, t1, days=1, oid="duyet", status="approved", lane="per_item",
         decided_by="GĐ bán hàng")
    r = ro.promote(db, FEATS, "ceo-01", "GĐ bán hàng", SHIFT,
                   now=t0 + timedelta(days=24))
    assert r["to"] == "van_hanh" and r["facts"]["days"] >= 10
    assert r["facts"]["human"] == 1 and r["facts"]["unapproved"] == 0
    with pytest.raises(ro.RolloutError, match="đã vận hành"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT)
    assert _events(db, "ceo-01") == ["seed", "promote", "promote"]


def test_severe_rolls_back_to_trial_and_resets_clock(db):
    t0 = NOW - timedelta(days=10)
    ro.seed(db, FEATS, BY, now=t0)
    _out(db, 50, t0)
    ro.promote(db, FEATS, "ceo-01", BY, SHIFT, now=t0 + timedelta(days=8))
    t_err = NOW + timedelta(hours=1)        # sau mọi dòng log đã ghi
    r = ro.record_severe(db, "ceo-01", "thieu_nhan_ai", BY,
                         note="khách 0905123456 báo", now=t_err)
    assert (r["from"], r["to"]) == ("co_nguoi_duyet", "chay_thu")
    stage, since = _state(db, "ceo-01")
    assert stage == "chay_thu" and since == t_err
    note = db.execute("select note from feature_rollout_events where kind ="
                      " 'severe'").fetchone()[0]
    assert "0905123456" not in note
    # Đầu ra cũ (trước mốc mới) không được tính lại.
    with pytest.raises(ro.RolloutError, match="0/50"):
        ro.promote(db, FEATS, "ceo-01", BY, SHIFT,
                   now=t_err + timedelta(days=10))
    # Lỗi khi đang chạy thử: vẫn chạy thử, mốc đếm lại.
    t2 = t_err + timedelta(days=3)
    assert ro.record_severe(db, "ceo-01", "lo_pii", BY, now=t2)["to"] == \
        "chay_thu"
    assert _state(db, "ceo-01")[1] == t2
    with pytest.raises(ValueError, match="--reason"):
        ro.record_severe(db, "ceo-01", "khac", BY)
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.record_severe(db, "intel-01", "lo_pii", BY)


def test_disable_and_reenable(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=3))
    assert ro.disable(db, "ceo-02", BY, note="tạm dừng")["to"] == "tat"
    with pytest.raises(ro.RolloutError, match="đã tắt"):
        ro.disable(db, "ceo-02", BY)
    r = ro.record_severe(db, "ceo-02", "tu_cam", BY)
    assert (r["from"], r["to"]) == ("tat", "tat")
    assert _state(db, "ceo-02")[0] == "tat"
    r = ro.promote(db, FEATS, "ceo-02", BY, SHIFT)
    assert (r["from"], r["to"]) == ("tat", "chay_thu")
    assert _events(db, "ceo-02") == ["seed", "disable", "severe", "promote"]
    with pytest.raises(ro.RolloutError, match="chưa vào sổ"):
        ro.disable(db, "intel-01", BY)


def test_dossier_from_db_filters_phase(db):
    ro.seed(db, FEATS, BY, now=NOW - timedelta(days=2))
    ro.record_severe(db, "ceo-05", "so_lieu_khong_nguon", BY)
    p1 = ro.dossier(db, FEATS, "P1", SHIFT)
    assert "(3 mục)" in p1 and "| ceo-05 |" not in p1
    assert "| sales-08 |" in p1 and "Chưa ghi nhận lỗi nghiêm trọng" in p1
    p2 = ro.dossier(db, FEATS, "P2", SHIFT)
    assert "(1 mục)" in p2 and "Số liệu không có nguồn" in p2
    with pytest.raises(ValueError):
        ro.dossier(db, FEATS, "P9", SHIFT)


def test_cli_end_to_end(db, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(ro, "connect", lambda: TxConn(db))
    feats_file = _write(tmp_path, _doc(FEATS))
    monkeypatch.setattr(ro, "FEATURES_FILE", feats_file)
    assert ro.main(["--seed", "--by", BY]) == 0
    assert "vào sổ 3" in capsys.readouterr().out
    assert ro.main(["--status"]) == 0
    out = capsys.readouterr().out
    assert "ceo-01" in out and "chưa vào sổ" in out
    assert ro.main(["--promote", "ceo-01", "--by", BY]) == 1
    assert "TỪ CHỐI" in capsys.readouterr().err
    assert ro.main(["--severe", "ceo-01", "--reason", "lo_pii", "--by", BY,
                    "--note", "x"]) == 0
    assert ro.main(["--disable", "ceo-02", "--by", BY]) == 0
    out_file = tmp_path / "hs" / "nt.md"
    assert ro.main(["--dossier", "--phase", "P1", "--out",
                    str(out_file)]) == 0
    md = out_file.read_bytes().decode("utf-8")
    assert "Lộ dữ liệu cá nhân" in md and "\r\n" not in md
