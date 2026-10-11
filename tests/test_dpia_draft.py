"""v4.4 W44.3 — DPIA/TIA nháp sinh tất định từ map + form đồng ý (PC-A5)."""

import copy
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dpia_draft

from pipelines.pii import _PII_RE

MAP = dpia_draft.load_map(ROOT / "data" / "data_flow_map.json")
LEGAL = ROOT / "docs" / "legal"
LAWYER = "CẦN LUẬT SƯ XÁC NHẬN"


def _has_id(text, fid):
    return re.search(rf"(?<!\w){re.escape(fid)}(?!\w)", text) is not None


def _tia_transfer_section(tia):
    start = tia.index("## 2.")
    return tia[start:tia.index("## 3.", start)]


def test_every_flow_in_dpia():
    dpia = dpia_draft.render_dpia(MAP)
    for f in MAP["flows"]:
        assert _has_id(dpia, f["id"]), f["id"]
        assert f"### {f['id']} " in dpia


def test_tia_only_cross_border_in_transfer_section():
    sec = _tia_transfer_section(dpia_draft.render_tia(MAP))
    cross = [f for f in MAP["flows"] if f["cross_border"]]
    assert cross
    for f in MAP["flows"]:
        assert _has_id(sec, f["id"]) == f["cross_border"], f["id"]


def test_fake_flow_rendered_not_hardcoded():
    m = copy.deepcopy(MAP)
    fake = copy.deepcopy(m["flows"][5])
    fake.update({"id": "DF-99", "name": "Luồng thử nghiệm", "cross_border": True})
    m["flows"].append(fake)
    assert _has_id(dpia_draft.render_dpia(m), "DF-99")
    assert _has_id(_tia_transfer_section(dpia_draft.render_tia(m)), "DF-99")
    m["flows"][-1]["cross_border"] = False
    assert not _has_id(_tia_transfer_section(dpia_draft.render_tia(m)),
                       "DF-99")


def test_render_deterministic():
    assert dpia_draft.render_dpia(MAP) == dpia_draft.render_dpia(
        copy.deepcopy(MAP))
    assert dpia_draft.render_tia(MAP) == dpia_draft.render_tia(MAP)


@pytest.mark.parametrize("name", ["DPIA-nhap.md", "TIA-nhap.md"])
def test_draft_markers(name):
    txt = (LEGAL / name).read_text(encoding="utf-8")
    assert "NHÁP" in txt
    assert txt.count(LAWYER) >= 3
    assert "đã tuân thủ" not in txt.casefold()
    assert "{{" in txt and "{{ho_ten_phap_che}}" in txt   # ô ký trống


def test_dpia_gap_summary_minimum():
    dpia = dpia_draft.render_dpia(MAP)
    gaps = dpia[dpia.index("## 4."):dpia.index("## 5.")]
    assert "consent" in gaps or "đồng ý" in gaps
    assert "`leads` không có hạn lưu" in gaps
    assert "Tên người/địa chỉ đứng tự do lọt mask" in gaps


def test_repo_docs_in_sync_check(capsys):
    assert dpia_draft.main(["--check"]) == 0


def test_cli_write_then_check_and_tamper(tmp_path):
    assert dpia_draft.main(["--out-dir", str(tmp_path)]) == 0
    first = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    assert set(first) == {"DPIA-nhap.md", "TIA-nhap.md"}
    assert b"\r\n" not in first["DPIA-nhap.md"]
    assert dpia_draft.main(["--out-dir", str(tmp_path)]) == 0
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == first
    assert dpia_draft.main(["--out-dir", str(tmp_path), "--check"]) == 0
    p = tmp_path / "DPIA-nhap.md"
    p.write_bytes(p.read_bytes().replace(b"DF-01", b"DF-0X", 1))
    assert dpia_draft.main(["--out-dir", str(tmp_path), "--check"]) == 1
    (tmp_path / "TIA-nhap.md").unlink()
    assert dpia_draft.main(["--out-dir", str(tmp_path), "--check"]) == 1


def test_cli_bad_map_exit2_writes_nothing(tmp_path, capsys):
    bad = copy.deepcopy(json.loads(
        (ROOT / "data" / "data_flow_map.json").read_bytes().decode("utf-8")))
    bad["flows"][0]["class"] = "tim"
    mp = tmp_path / "map.json"
    mp.write_bytes(json.dumps(bad, ensure_ascii=False).encode("utf-8"))
    out = tmp_path / "out"
    assert dpia_draft.main(["--map", str(mp), "--out-dir", str(out)]) == 2
    assert not out.exists() or not any(out.iterdir())
    assert "[err]" in capsys.readouterr().err


# ---------------------------------------------------------------- form đồng ý
FORM = (LEGAL / "form-dong-y-NHAP.md").read_text(encoding="utf-8")


def _sections(text):
    parts = re.split(r"(?m)^## ", text)
    return {p.splitlines()[0]: p for p in parts[1:]}


def test_form_three_separate_purposes():
    secs = _sections(FORM)
    keys = [k for k in secs if k.startswith("Mục đích")]
    assert len(keys) == 3
    joined = " ".join(keys)
    for w in ("Chăm sóc khách hàng", "Marketing", "đại lý"):
        assert w in joined
    for k in keys:
        body = secs[k]
        assert body.count("- [ ]") == 1, k          # 1 ô đồng ý riêng/mục
        assert "rút đồng ý" in body.casefold(), k
        for field in ("Dữ liệu", "Mục đích", "Bên nhận",
                      "Chuyển ra nước ngoài", "Thời hạn lưu", "Quyền"):
            assert f"| {field}" in body, (k, field)
    assert "- [x]" not in FORM.lower()               # không đánh sẵn


def test_form_retention_matches_code_and_health_routing():
    from connectors.zalo import RETAIN_DAYS
    cskh = next(v for k, v in _sections(FORM).items()
                if k.startswith("Mục đích 1"))
    assert f"{RETAIN_DAYS} ngày" in cskh
    assert "không gửi AI" in cskh and "sức khỏe" in cskh
    mk = next(v for k, v in _sections(FORM).items()
              if k.startswith("Mục đích 2"))
    assert "Mặc định: KHÔNG" in mk
    assert "{{policy_version}}" in FORM
    assert "chưa gắn kênh — chờ cơ chế consent (Hạ tầng)" in FORM


def test_form_no_real_pii():
    stripped = re.sub(r"\{\{[^}]*\}\}", "", FORM)
    assert not _PII_RE.search(stripped)
    assert "đã tuân thủ" not in FORM.casefold()


def test_check_tolerates_crlf_checkout(tmp_path):
    """core.autocrlf=true checkout file thành CRLF — `--check` không báo lệch
    giả; nội dung đổi thật vẫn bắt."""
    assert dpia_draft.main(["--out-dir", str(tmp_path)]) == 0
    for p in tmp_path.iterdir():
        p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))
    assert dpia_draft.main(["--out-dir", str(tmp_path), "--check"]) == 0
    p = tmp_path / "TIA-nhap.md"
    p.write_bytes(p.read_bytes().replace(b"DF-06", b"DF-6X", 1))
    assert dpia_draft.main(["--out-dir", str(tmp_path), "--check"]) == 1
