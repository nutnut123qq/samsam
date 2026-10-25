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
    # Đợt an toàn S03: giá xuất sàn = price_list ĐÃ duyệt (trước đây golden
    # JSON 745000 — chính là lỗi) → test đặt giá DB khác JSON.
    pid = _web_price(db, SKU, 151000, channel="shopee")
    mp = le.export(db, SKU, "shopee", tmp_path, readiness=RD)
    man = json.loads(mp.read_text(encoding="utf-8"))
    assert man["draft_id"] == did and man["transform"] == "bo_dong_gia"
    assert man["gia_vnd"] == 151000 and man["gia_id"] == pid
    assert "price_list" in man["gia_nguon"]
    assert "CHƯA XÁC MINH" in man["mapping_status"]
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


# ---- đợt hoàn thiện 22/10: nguồn dữ liệu website (PL01 mục 3a/3c)

ALC = "ruou-sam-chai-thuy-tinh-500ml"


def _golden_with_web(monkeypatch, prices):
    import copy
    cfg, extra = content._cfg()
    cfg = copy.deepcopy(cfg)
    for sku, p in prices.items():
        cfg["golden"][sku].setdefault("prices", {})["web"] = {"list": p}
    monkeypatch.setattr(content, "_cfg", lambda: (cfg, extra))


def _feed(db, tmp_path, rd=RD):
    import hashlib
    mp = le.website_feed(db, tmp_path, readiness=rd)
    man = json.loads(mp.read_text(encoding="utf-8"))
    data = (tmp_path / man["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == man["file_sha256"]
    rows = {r["sku_key"]: r for r in json.loads(data)["rows"]}
    return man, rows


def test_website_feed_no_web_price_not_sellable(db, tmp_path):
    _master(db)
    man, rows = _feed(db, tmp_path)
    r = rows[SKU]
    assert r["mo_ta"] and r["gia_vnd"] is None and r["gio_hang"] is False
    assert any("giá list kênh web" in x for x in r["ly_do"])
    assert man["ban_duoc"] == 0 and man["so_sku"] == len(rows)
    # SKU chưa có mô tả duyệt → lý do cụ thể, không bịa mô tả
    other = next(k for k in rows if k not in (SKU, ALC))
    assert rows[other]["mo_ta"] is None and rows[other]["ly_do"]


def _web_price(db, sku, price, *, kind="list", channel="web", days_ago=10,
               to=None, approve=True, program=None):
    """Dòng price_list qua ĐÚNG trigger append-only: INSERT mở chưa duyệt →
    UPDATE duyệt (người, như `golden_store --approve-price`) → tùy đóng."""
    from datetime import timedelta
    db.execute("insert into sku_master (sku_key, name, category,"
               " allowed_channels, source) values (%s, %s, %s,"
               " '{web,shopee,tiktok}', 'test') on conflict do nothing",
               (sku, sku, "alcohol" if sku == ALC else "food"))
    pid = db.execute(
        "insert into price_list (sku_key, channel, kind, price_vnd,"
        " program_id, valid_from) values (%s,%s,%s,%s,%s,%s) returning id",
        (sku, channel, kind, price, program,
         _today() - timedelta(days=days_ago))).fetchone()[0]
    if approve:
        db.execute("update price_list set approved_by = 'GĐ Bán Hàng',"
                   " approved_at = now() where id = %s", (pid,))
    if to is not None:
        db.execute("update price_list set valid_to = %s where id = %s",
                   (to, pid))
    return pid


def _today():
    from datetime import datetime, timezone

    from pipelines.period import vn_date
    return vn_date(datetime.now(timezone.utc))


def test_website_feed_sellable_and_alcohol_always_hidden(db, tmp_path,
                                                         monkeypatch):
    # Vá controller 22/10 (F2): trước đây test này đặt giá qua golden JSON
    # (`_golden_with_web`) — chính là lỗi (DB chưa có giá duyệt vẫn bật giỏ).
    # Nay giá đi qua price_list ĐÃ duyệt; JSON vẫn để giá KHÁC để chứng minh
    # không dùng JSON.
    _golden_with_web(monkeypatch, {SKU: 99000, ALC: 500000})
    pid = _web_price(db, SKU, 120000)
    _web_price(db, ALC, 500000)
    _master(db)
    rd = {**RD, (ALC, "web"): "TP_THUONG"}
    man, rows = _feed(db, tmp_path, rd)
    assert rows[SKU]["gio_hang"] is True and rows[SKU]["gia_vnd"] == 120000
    assert rows[SKU]["gia_id"] == pid and man["gia_phien_ban"] == {SKU: pid}
    assert "price_list" in man["gia_nguon"]
    assert man["gia_ngay_hieu_luc"] == _today().isoformat()
    assert rows[SKU]["ly_do"] == [] and "Giá:" not in rows[SKU]["mo_ta"]
    a = rows[ALC]
    assert a["an_gia"] is True and a["gio_hang"] is False
    assert a["gia_vnd"] is None and a["gia_id"] is None   # rượu: ẩn giá dù DB có


def _row(db, rd=RD):
    import copy
    gold = copy.deepcopy(content._cfg()[0]["golden"][SKU])
    gold.setdefault("prices", {})["web"] = {"list": 99000}   # JSON KHÔNG dùng
    return le.website_row(db, SKU, gold, rd)


def _not_sellable(r, why):
    assert r["gio_hang"] is False and r["gia_vnd"] is None, r
    assert r["gia_id"] is None and any(why in x for x in r["ly_do"]), r


def test_website_json_price_without_db_price_not_sellable(db):
    _master(db)
    _not_sellable(_row(db), "chưa có giá list kênh web")


def test_website_pending_db_price_not_used(db):
    _master(db)
    pid = _web_price(db, SKU, 120000, approve=False)
    _not_sellable(_row(db), f"#{pid} đang CHỜ")


def test_website_expired_and_future_price_not_used(db):
    _master(db)
    _web_price(db, SKU, 120000, days_ago=30, to=_today())     # hết hạn hôm nay
    _not_sellable(_row(db), "chưa có giá list kênh web")
    _web_price(db, SKU, 130000, days_ago=-1)                  # hiệu lực từ mai
    _not_sellable(_row(db), "chưa có giá list kênh web")


def test_website_no_fallback_floor_promo_other_channel(db):
    _master(db)
    _web_price(db, SKU, 80000, kind="floor")
    _web_price(db, SKU, 70000, kind="promo", program="km-test", approve=False)
    _web_price(db, SKU, 110000, channel="shopee")
    _not_sellable(_row(db), "chưa có giá list kênh web")


def test_website_edited_description_blocks_even_with_db_price(db):
    did, _ = _master(db)
    _web_price(db, SKU, 120000)
    db.execute("update content_drafts set text = text || ' sửa' where"
               " id = %s", (did,))
    r = _row(db)
    assert r["gio_hang"] is False and r["mo_ta"] is None
    assert any("duyệt lại" in x for x in r["ly_do"])


@pytest.mark.parametrize("how", ["mat_bang", "khong_quyen"])
def test_website_price_unreadable_refuses_no_file(db, tmp_path, how):
    _master(db)
    _web_price(db, SKU, 120000)
    if how == "mat_bang":
        db.execute("alter table price_list rename to price_list_x")
    else:
        sch = db.execute("select current_schema()").fetchone()[0]
        db.execute("create role t_c04_noprice nologin")     # ROLLBACK cuối
        db.execute(f"grant usage on schema {sch} to t_c04_noprice")
        db.execute(f"grant select on all tables in schema {sch}"
                   " to t_c04_noprice")
        db.execute("revoke select on price_list from t_c04_noprice")
        db.execute("set local role t_c04_noprice")
    with pytest.raises(le.ExportError, match="không đọc được bảng giá"):
        le.website_feed(db, tmp_path, readiness=RD)
    assert list(tmp_path.iterdir()) == []


def test_website_feed_rollout_trial_blocks(db, tmp_path, monkeypatch):
    from pipelines import rollout
    monkeypatch.setattr(rollout, "_FORCE_MODE", "chay_thu", raising=False)
    with pytest.raises(le.ExportError, match="không dùng"):
        le.website_feed(db, tmp_path, readiness=RD)
    assert list(tmp_path.iterdir()) == []


# ---- đợt an toàn S03: xuất tệp sàn chỉ dùng giá list ĐÃ duyệt hiệu lực

RDT = {**RD, (SKU, "tiktok"): "TP_THUONG"}


def _refused(db, tmp_path, why, channel="shopee"):
    with pytest.raises(le.ExportError, match=why):
        le.export(db, SKU, channel, tmp_path, readiness=RDT)
    assert list(tmp_path.iterdir()) == []


def test_san_export_no_db_price_refused_even_if_json_has(db, tmp_path):
    _master(db)
    gold = content._cfg()[0]["golden"][SKU]
    assert (gold.get("prices") or {}).get("shopee", {}).get("list")  # JSON có
    _refused(db, tmp_path, "chưa có giá list kênh")


def test_san_export_pending_expired_future_other_kind_refused(db, tmp_path):
    _master(db)
    pid = _web_price(db, SKU, 151000, channel="shopee", approve=False)
    _refused(db, tmp_path, f"#{pid} đang CHỜ")
    db.execute("update price_list set valid_to = %s where id = %s",
               (_today(), pid))                       # đóng (hết hạn)
    _web_price(db, SKU, 152000, channel="shopee", days_ago=-1)   # từ mai
    _web_price(db, SKU, 90000, channel="shopee", kind="floor")
    _web_price(db, SKU, 80000, channel="shopee", kind="promo",
               program="km-t", approve=False)
    _web_price(db, SKU, 120000, channel="web")
    _web_price(db, SKU, 130000, channel="tiktok")
    _refused(db, tmp_path, "chưa có giá list kênh")
    # Kênh có giá duyệt của chính nó → xuất được bằng đúng giá đó
    mp = le.export(db, SKU, "tiktok", tmp_path, readiness=RDT)
    assert json.loads(mp.read_text(encoding="utf-8"))["gia_vnd"] == 130000


@pytest.mark.parametrize("how", ["mat_bang", "khong_quyen"])
def test_san_export_price_unreadable_refused(db, tmp_path, how):
    _master(db)
    _web_price(db, SKU, 151000, channel="shopee")
    if how == "mat_bang":
        db.execute("alter table price_list rename to price_list_x")
    else:
        sch = db.execute("select current_schema()").fetchone()[0]
        db.execute("create role t_c04_noprice2 nologin")     # ROLLBACK cuối
        db.execute(f"grant usage on schema {sch} to t_c04_noprice2")
        db.execute(f"grant select on all tables in schema {sch}"
                   " to t_c04_noprice2")
        db.execute(f"grant execute on all functions in schema {sch}"
                   " to t_c04_noprice2")
        db.execute("revoke select on price_list from t_c04_noprice2")
        db.execute("set local role t_c04_noprice2")
    _refused(db, tmp_path, "không đọc được bảng giá")


@pytest.mark.parametrize("change", ["gia_moi", "het_han", "manifest_gia"])
def test_san_verify_detects_price_change(db, tmp_path, change):
    _master(db)
    pid = _web_price(db, SKU, 151000, channel="shopee")
    mp = le.export(db, SKU, "shopee", tmp_path, readiness=RD)
    assert le.verify(db, mp, readiness=RD) == []
    if change == "manifest_gia":
        man = json.loads(mp.read_text(encoding="utf-8"))
        man["gia_vnd"] = 99000
        mp.write_text(json.dumps(man), encoding="utf-8")
    else:
        db.execute("update price_list set valid_to = %s where id = %s",
                   (_today(), pid))
        if change == "gia_moi":
            _web_price(db, SKU, 160000, channel="shopee", days_ago=0)
    assert le.verify(db, mp, readiness=RD) != []


def test_website_feed_verify_detects_price_change_and_tamper(db, tmp_path):
    """r13 sales-08: --verify nguồn dữ liệu website — khớp ngay sau xuất;
    giá web mới được duyệt (bản cũ hết hiệu lực) → lệch gia_id; tệp bị sửa →
    lệch sha. Không DB thật của Sâm Sâm — DB thử của test."""
    from datetime import timedelta
    old = _web_price(db, SKU, 120000)
    _master(db)
    mp = le.website_feed(db, tmp_path, readiness=RD)
    man = json.loads(mp.read_text(encoding="utf-8"))
    assert le.verify_feed(db, man, mp, readiness=RD) == []
    db.execute("update price_list set valid_to = %s where id = %s", (_today() - timedelta(days=1), old))
    _web_price(db, SKU, 130000, days_ago=1)
    bad = le.verify_feed(db, man, mp, readiness=RD)
    assert any(f"{SKU}: gia_id lệch" in b for b in bad) and any("gia_vnd" in b for b in bad)
    f = tmp_path / man["file"]
    f.write_bytes(f.read_bytes() + b" ")
    assert any("sha lệch" in b for b in le.verify_feed(db, man, mp, readiness=RD))
