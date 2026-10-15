"""v9.5 W95.5/W95.6 — `agents.co_khi`: năng lực đóng gói hộp quà Tết (config
GIẢ ĐỊNH) và checklist điện/mạng điểm quay live (markdown tất định)."""
import copy
import json
import re
from datetime import date

import pytest

from agents import co_khi as ck

CAP = ck.load_config(ck.CAPACITY_CONFIG)
LIVE = ck.load_config(ck.LIVE_CONFIG)
DAY = date(2026, 11, 5)
FORBIDDEN = ("cam kết", "đảm bảo giao", "ngày giao")


def test_configs_marked_assumed():
    assert CAP["_doc"].startswith("GIẢ ĐỊNH") and CAP["gia_cong"] is False
    assert LIVE["_doc"].startswith("ĐỀ XUẤT")
    assert all(s["label"] in ck.LABELS for s in CAP["stations"].values())


# --- CK-A3 năng lực -----------------------------------------------------------
@pytest.mark.parametrize("boxes,dan_nhan,dong_tay", [(500, 3, 2), (1500, 8, 5),
                                                      (3000, 15, 10)])
def test_capacity_shifts(boxes, dan_nhan, dong_tay):
    r = ck.capacity_for(CAP, "HQ-TET-01", boxes)
    got = {s["station"]: s["shifts_needed"] for s in r["stations"]}
    assert got["dan_nhan"] == dan_nhan and got["dong_hop_tay"] == dong_tay
    assert r["bottleneck"] == "dan_nhan" and r["bottleneck_shifts"] == dan_nhan
    assert r["status"] == "chờ Kỹ sư trưởng ký"
    assert all(s["label"] == "gia_dinh" for s in r["stations"])


def test_bottleneck_follows_config():
    cfg = copy.deepcopy(CAP)
    cfg["stations"]["dong_hop_tay"]["units"] = 1  # 80/ca → nút thắt
    cfg["stations"]["dan_nhan"]["label"] = "do_thuc"
    r = ck.capacity_for(cfg, "HQ-TET-01", 500)
    assert r["bottleneck"] == "dong_hop_tay" and r["bottleneck_shifts"] == 7
    md = ck.render_capacity(cfg, "HQ-TET-01", [500])
    assert "(đo thực)" in md and "(giả định)" in md


def test_capacity_markdown_labels_and_no_promise():
    md = ck.render_capacity(CAP, "HQ-TET-01", [500, 1500, 3000])
    rows = [ln for ln in md.split("\n") if ln.startswith("| ") and
            not ln.startswith("| Công đoạn")]
    assert len(rows) == 9
    for ln in rows:  # mọi ô số đều kèm nhãn
        for cell in ln.strip("|").split("|")[1:4]:
            assert re.search(r"\d", cell) and re.search(r"\((giả định|đo thực)\)",
                                                        cell), ln
    for ln in md.split("\n"):
        if ln.startswith("Nút thắt"):
            assert "(giả định)" in ln
    low = md.casefold()
    assert not any(w in low for w in FORBIDDEN)
    assert md == ck.render_capacity(CAP, "HQ-TET-01", [500, 1500, 3000])


@pytest.mark.parametrize("boxes", [0, -5, "abc", 1.5, True, None])
def test_capacity_bad_boxes(boxes):
    with pytest.raises(ValueError):
        ck.capacity_for(CAP, "HQ-TET-01", boxes)


def test_capacity_bad_sku_rate_and_gia_cong():
    with pytest.raises(ValueError):
        ck.capacity_for(CAP, "HQ-LA", 500)
    for bad in (0, -1, "200", None, float("inf")):
        cfg = copy.deepcopy(CAP)
        cfg["stations"]["dan_nhan"]["rate"] = bad
        with pytest.raises(ValueError):
            ck.capacity_for(cfg, "HQ-TET-01", 500)
    cfg = copy.deepcopy(CAP)
    cfg["gia_cong"] = True
    with pytest.raises(ValueError, match="gia công ngoài"):
        ck.capacity_for(cfg, "HQ-TET-01", 500)


def test_cli_nang_luc(tmp_path, capsys):
    argv = ["nang-luc", "--sku", "HQ-TET-01", "--boxes", "500,1500,3000"]
    assert ck.main(argv) == 0
    out1 = capsys.readouterr().out
    assert ck.main(argv) == 0
    assert capsys.readouterr().out == out1  # byte-identical
    assert "15 (giả định)" in out1
    cfg = copy.deepcopy(CAP)
    cfg["gia_cong"] = True
    p = tmp_path / "gc.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    assert ck.main(argv + ["--config", str(p)]) == 1
    out = capsys.readouterr().out
    assert "gia công ngoài" in out and "ca (" not in out
    for boxes in ("0", "-5", "abc", "500,,1"):
        assert ck.main(["nang-luc", "--sku", "HQ-TET-01", "--boxes", boxes]) == 1
        assert "lỗi" in capsys.readouterr().out


# --- CK-A4 checklist live -----------------------------------------------------
def _net(md):
    return re.search(r"Kết quả phần mạng: \*\*(.+?)\*\*", md).group(1)


@pytest.mark.parametrize("up,loss,expect", [
    (1.5, 0.5, "KHÔNG ĐẠT"), (6.5, 0.5, "ĐẠT"), (6.0, 1.0, "ĐẠT"),
    (6.5, 1.5, "KHÔNG ĐẠT"), (6.5, None, "CHƯA ĐO"), (None, None, "CHƯA ĐO")])
def test_live_network_verdict(up, loss, expect):
    md = ck.render_live_checklist(LIVE, "da_nang", DAY, up, loss)
    assert _net(md) == expect
    assert ("bật router dự phòng và đo lại" in md.casefold()) is (
        expect == "KHÔNG ĐẠT")


def test_live_threshold_from_config():
    cfg = copy.deepcopy(LIVE)
    cfg["upload_mbps_min"] = 8
    assert _net(ck.render_live_checklist(cfg, "da_nang", DAY, 6.5, 0.5)) == \
        "KHÔNG ĐẠT"


def test_live_items_electric_wait_and_never_ready():
    md = ck.render_live_checklist(LIVE, "tra_linh", DAY, 6.5, 0.5)
    for it in LIVE["items"]["do_duoc"] + LIVE["items"]["dien"]:
        assert f"- [ ] {it}" in md
    assert "CHỜ KỸ SƯ TRƯỞNG DUYỆT ẢNH" in md
    assert not re.search(r"(?<!CHƯA )\bSẴN SÀNG\b", md.upper())
    assert md == ck.render_live_checklist(LIVE, "tra_linh", DAY, 6.5, 0.5)
    assert "2026-11-05" in md


@pytest.mark.parametrize("kw", [{"site": "ha_noi"}, {"day": "2026-11-05"},
                                {"upload": -1}, {"loss": 101},
                                {"upload": float("nan")}])
def test_live_bad_input(kw):
    args = {"site": "da_nang", "day": DAY, "upload": 6.5, "loss": 0.5, **kw}
    with pytest.raises(ValueError):
        ck.render_live_checklist(LIVE, **args)


@pytest.mark.parametrize("argv", [
    ["--site", "ha_noi", "--day", "2026-11-05"],
    ["--site", "da_nang", "--day", "2026-13-05"],
    ["--site", "da_nang", "--day", "2026-11-05", "--upload", "-1", "--loss", "0"],
])
def test_cli_checklist_exit2(argv):
    with pytest.raises(SystemExit) as e:
        ck.main(["checklist-live", *argv])
    assert e.value.code == 2


def test_cli_checklist_out_file(tmp_path, capsys):
    out = tmp_path / "cl.md"
    argv = ["checklist-live", "--site", "da_nang", "--day", "2026-11-05",
            "--upload", "6.5", "--loss", "0.5", "--out", str(out)]
    assert ck.main(argv) == 0
    b1 = out.read_bytes()
    assert ck.main(argv) == 0
    assert out.read_bytes() == b1 and b"\r\n" not in b1
    assert "ĐẠT" in b1.decode("utf-8")
