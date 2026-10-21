"""Đợt hợp đồng C04 — sales-03 mô tả chuẩn + xuất cho sàn
(agents/listing_export.py). DB thật (schema tạm + roles ×2, ROLLBACK); mô
tả chuẩn sinh bằng `content.listing(..., llm=False)` (khung golden, 0 LLM)."""

import csv
import json

import pytest

from agents import listing_export as le
from pipelines import content, store
from tests.test_ceo_audit import ceo_db

SKU = "mat-ong-sam-120ml-1hu"
RD = {(SKU, "web"): "TP_THUONG", (SKU, "shopee"): "TP_THUONG",
      (SKU, "tiktok"): "CAM"}


@pytest.fixture
def db():
    yield from ceo_db()


def _master(db, approve=True):
    r = content.listing(SKU, "web", readiness=RD, llm=False)
    assert r["ok"], r["guardrail"]
    did = store.save_draft(db, f"listing {SKU} web", "web", r["text"],
                           r["guardrail"], store.SOURCE_CLI,
                           created_by="agent:mkt02", content_type="listing",
                           sku=SKU, is_ai=True)
    if approve:
        db.execute("select approve_draft(%s, 'GĐ Bán Hàng', null)", (did,))
    return did, r["text"]


def test_export_verify_and_tamper(db, tmp_path):
    did, text = _master(db)
    assert "Giá:" in text
    mp = le.export(db, SKU, "shopee", tmp_path, readiness=RD)
    man = json.loads(mp.read_text(encoding="utf-8"))
    assert man["draft_id"] == did and man["transform"] == "bo_dong_gia"
    assert man["gia_vnd"] > 0 and "CHƯA XÁC MINH" in man["mapping_status"]
    rows = list(csv.reader((tmp_path / man["file"]).read_text(
        encoding="utf-8-sig").splitlines()))
    assert rows[0][0] == "Mã SKU" and rows[1][0] == SKU
    assert "Giá:" not in rows[1][2] and rows[1][5] == str(man["gia_vnd"])
    assert le.verify(db, mp, readiness=RD) == []
    # tệp bị sửa tay → lệch
    f = tmp_path / man["file"]
    f.write_bytes(f.read_bytes().replace(b"Mat", b"MAT") + b" ")
    assert any("đã bị sửa" in b for b in le.verify(db, mp, readiness=RD))


def test_refusals_no_file(db, tmp_path):
    with pytest.raises(le.ExportError, match="chưa có mô tả chuẩn"):
        le.export(db, SKU, "shopee", tmp_path, readiness=RD)
    did, _text = _master(db, approve=False)
    with pytest.raises(le.ExportError, match="chưa có mô tả chuẩn"):
        le.export(db, SKU, "shopee", tmp_path, readiness=RD)
    db.execute("select approve_draft(%s, 'GĐ Bán Hàng', null)", (did,))
    with pytest.raises(le.ExportError):           # kênh đích CAM
        le.export(db, SKU, "tiktok", tmp_path, readiness=RD)
    assert list(tmp_path.iterdir()) == []


def test_edit_after_approval_requires_reapproval(db, tmp_path):
    did, _ = _master(db)
    db.execute("update content_drafts set text = text || ' sửa' where"
               " id = %s", (did,))
    with pytest.raises(le.ExportError, match="duyệt lại"):
        le.export(db, SKU, "shopee", tmp_path, readiness=RD)


def test_rollout_tat_blocks(db, tmp_path, monkeypatch):
    from pipelines import rollout
    _master(db)
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu", raising=False)
    with pytest.raises(le.ExportError, match="không dùng"):
        le.export(db, SKU, "shopee", tmp_path, readiness=RD)


def test_map_file_validation(tmp_path):
    p = tmp_path / "m.json"
    p.write_text(json.dumps({"channels": {"shopee": {"columns": {}},
                                          "tiktok": {"columns": {}}}}),
                 encoding="utf-8")
    with pytest.raises(le.ExportError):
        le.load_map(p)
    assert set(le.load_map()["columns"]) == {"shopee", "tiktok"}
