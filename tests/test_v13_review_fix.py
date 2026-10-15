"""v13 vá review (sau C11) — 4 phát hiện của vòng review độc lập:

- F02 (MAJOR, PII): biến thể thực tế của tên/địa chỉ vẫn đi ra AI ngoài qua
  `api.rag.answer` ("giao cho <Họ Tên>", chuỗi tên + số + tên đường không
  từ gợi ý, tên gõ thường không dấu, thôn/xóm).
- F02 (MINOR, sức khỏe): biến thể gõ thiếu dấu / không dấu / ZWSP chưa bắt.
- F01 (MAJOR, đối soát): `--year` vẫn so mức thưởng trên số chồng kỳ gấp
  đôi (chỉ đường quý chặn phí khi BẤT THƯỜNG).
- F03 (MINOR, rollout): qr_trace issue/site/link, zalo_garden, garden_media,
  channels --suggest không đọc giai đoạn triển khai.

Mỗi test tái hiện đúng câu/probe của review và FAIL trên code trước vá.
Fake provider ghi payload — không gọi mạng. DB: schema tạm + ROLLBACK.
"""

import json
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from agents import rev_share as rs
from api import rag
from connectors import channels
from connectors import zalo_garden as zg
from pipelines import llm_gateway as gw
from pipelines import pii
from pipelines import rollout as ro
from pipelines.period import VN_TZ
from tests.test_ceo_audit import TxConn, ceo_db
from tests.test_qr_trace import (  # noqa: F401 — fixture db/proxy/run
    H1,
    LOT,
    _code,
    _count,
    _harvest,
    _mk_lot,
    _plot,
    _ready,
    _sign,
    db,
    proxy,
    run,
)
from tests.test_settlement_overlap import ROW_A, _file, _load, _order

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import garden_media as gm


class Fake:
    """Client giả: ghi MỌI payload chat/embed gửi ra provider."""

    def __init__(self):
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(
            create=self._chat))
        self.embeddings = SimpleNamespace(create=self._embed)

    def _chat(self, **kw):
        self.calls.append(("chat", kw))
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(
            message=SimpleNamespace(content="Saphraton: 1.000.000 đ"))])

    def _embed(self, **kw):
        self.calls.append(("embed", kw))
        return SimpleNamespace(usage=None,
                               data=[SimpleNamespace(embedding=[1.0, 0.0])])

    def user_payload(self) -> str:
        """Phần do KHÁCH gõ trong payload (input embed + lượt user)."""
        out = []
        for kind, kw in self.calls:
            if kind == "embed":
                out.append(json.dumps(kw["input"], ensure_ascii=False))
            else:
                out += [m["content"] for m in kw["messages"]
                        if m.get("role") == "user"]
        return "\n".join(out)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    cfg = {"provider_only": ["azure"],
           "prices_usd_per_1m": {"m": {"in": 1.0, "out": 2.0}},
           "monthly_cap_usd": {"default": 10.0, "chatbot": 1.0},
           "kill": [], "pii_allow": []}
    p = tmp_path / "llm_gateway.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(gw, "CONFIG", p)
    f = Fake()
    monkeypatch.setattr(gw, "_client", lambda: f)
    monkeypatch.setattr(rag, "retrieve_by_vector", lambda *a, **k: [
        {"score": 0.9, "url": "http://x/p", "title": "Saphraton",
         "content": "Saphraton — 1.000.000 đ", "doc_id": "p1",
         "lang": "vi"}])
    return f


# ---------------- F02: tên/địa chỉ (câu của review) ----------------

PII_VARIANTS = [
    ("Giao cho Trần Thị Bích, 34 Lê Lợi, Hải Châu nhé",
     ("Trần Thị Bích", "Thị Bích", "34 Lê Lợi", "Lê Lợi")),
    ("Nguyễn Văn Mẫu - 12 Ví Dụ - Đà Nẵng",
     ("Nguyễn Văn Mẫu", "Văn Mẫu", "12 Ví Dụ", "Ví Dụ")),
    ("toi la nguyen van mau, nha o 12 duong vi du da nang",
     ("nguyen van mau", "van mau", "12 duong", "vi du")),
    ("Mình tên Hoa, ở thôn 3 xã Trà Linh", ("Hoa", "thôn 3")),
    ("giao cho Bích ở 34/2 Lê Lợi nhé", ("Bích", "Lê Lợi")),
    ("TRẦN THỊ BÍCH 0901234567", ("TRẦN THỊ BÍCH", "0901234567")),
    ("ship về xóm Bến Đò, Trà My", ("Bến Đò",)),
]


@pytest.mark.parametrize("q,leaks", PII_VARIANTS)
def test_rag_pii_variants_never_reach_provider(fake, q, leaks):
    """Mỗi câu của review đi qua rag.answer: hoặc chuyển người (0 lời gọi)
    hoặc payload ra ngoài không còn tên/địa chỉ giả."""
    r = rag.answer(q)
    sent = fake.user_payload()
    if r.get("handoff") == "pii":
        assert fake.calls == []
    else:
        assert fake.calls, r
    for leak in leaks:
        assert leak not in sent, (leak, sent)


@pytest.mark.parametrize("q", [
    "Giao hàng ở Ho Chi Minh mất mấy ngày",
    "Giao hàng ở Hồ Chí Minh mất mấy ngày",
    "ship về Hà Nội 2 hộp nhé",
    "Hộp Sâm Cao Cấp giá sao",
    "Combo 2 Hộp Quà Tết giá bao nhiêu",
    "Lâm Đồng có đại lý không",
    "Shop có bán ở Phan Thiết không",
    "Lễ vẫn mở cửa không shop",
    "do vận chuyển xa nên phí bao nhiêu",
    "mua 3 hộp tặng 1 không",
    "Saphraton 120 Viên giá sao",
    "Sâm Ngọc Linh trồng ở Trà Linh đúng không",
])
def test_scrub_user_sales_questions_untouched(q):
    assert pii.scrub_user(q) == (q, False)


# ---------------- F02: sức khỏe (biến thể của review) ----------------

HEALTH_VARIANTS = [
    "mẹ em bị tiểu đuong uống được ko",
    "Ba tôi bi dau lung",
    "bé bị sot có dùng được không",
    "ba toi bi gan nhiem mo",
    "uống sâm có hạ đường huyết không",
    "đường huyết cao có dùng được",
    "tiểu\u200bđường",
]


@pytest.mark.parametrize("q", HEALTH_VARIANTS)
def test_health_variants_handoff_before_any_ai(fake, monkeypatch, q):
    monkeypatch.setattr(rag, "retrieve", lambda *a, **k: pytest.fail(q))
    assert gw.is_health_question(q), q
    r = rag.answer(q)
    assert r["handoff"] == "health" and fake.calls == []


@pytest.mark.parametrize("q", [
    "Sâm này giá bao nhiêu?", "Ship về Đà Nẵng bao lâu",
    "Có hộp quà Tết không", "mua ở đâu", "thuộc loại nào",
    "Combo 2 hộp giá sao", "đường đi tới showroom",
    "đơn của em giao chưa", "chưa nhận được hàng", "sao chưa thấy ship",
    "đâu là hộp đẹp nhất", "đường tới cửa hàng gần nhất",
    "Hộp quà Tết có túi không", "than hoạt tính có không",
])
def test_health_variants_no_false_positive(q):
    assert not gw.is_health_question(q), q


# ---------------- F01: thưởng năm trên số chồng kỳ ----------------

@pytest.fixture
def rsdb():
    yield from ceo_db()


def test_tier_rows_anomaly_no_bonus():
    tiers = [{"muc": 1, "tu_vnd": 1000, "ty_le": Decimal("0.1")}]
    r = rs.tier_rows(5000, tiers, anomaly=True)[0]
    assert r["dat"] is None and r["thuong"] is None and r["vuot"] is None
    assert "bất thường" in r["trang_thai"]
    assert rs.tier_rows(5000, tiers)[0]["thuong"] == 400      # không đổi


def test_year_lech_overlap_no_bonus(rsdb, monkeypatch, tmp_path, capsys):
    """Probe review `lech_year_bonus`: 2 file cùng khoản (950.000 vs
    940.000), ngưỡng thử 1.000.000 / 10% → trước vá in 'đạt' + thưởng
    89.000đ trên thuần gấp đôi 1.890.000."""
    raw = json.loads((ROOT / "data" / "rev_share.json").read_text(
        encoding="utf-8"))
    raw.update(ngay_ky_hop_dong="2026-01-01",
               ngay_bat_dau_van_hanh="2026-01-01", ty_le_phi_van_hanh=0.05,
               kenh_truc_tuyen=["shopee"],
               muc_thuong=[{"muc": 1, "tu_vnd": 1_000_000, "ty_le": 0.1}])
    p = tmp_path / "rev_share.json"
    p.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(rs, "CONFIG_FILE", p)
    a = _file(tmp_path, "a.csv", [ROW_A])
    b = _file(tmp_path, "b.csv",
              ["OVTEST0001,05/08/2026,1.000.000,-60.000,0,0,940.000"])
    assert _load(rsdb, monkeypatch, a) == 0
    assert _load(rsdb, monkeypatch, b) == 0
    _order(rsdb, "OVTEST0001")
    monkeypatch.setattr(rs, "connect", lambda: TxConn(rsdb))
    capsys.readouterr()
    assert rs.main(["--year", "1", "--dry-run"],
                   now=datetime(2027, 1, 2, tzinfo=VN_TZ)) == 0
    out = capsys.readouterr().out
    row = next(ln for ln in out.splitlines() if ln.startswith("| 1 |"))
    assert "| đạt |" not in row and "89.000đ" not in out, row
    assert "bất thường" in row
    assert "BẤT THƯỜNG" in out


# ---------------- F03: biên đầu ra chưa đọc giai đoạn ----------------

@pytest.fixture
def stage(monkeypatch):
    """Ép giai đoạn trả về từ `rollout.mode` + ghi tính năng được hỏi."""
    asked = []
    box = {"md": "van_hanh"}
    monkeypatch.setattr(ro, "_FORCE_MODE", None)
    monkeypatch.setattr(ro, "mode",
                        lambda conn, fid: asked.append(fid) or box["md"])
    box["asked"] = asked
    return box


class _NoDb:
    """Conn giả: mọi truy vấn = lỗi (biên phải chặn TRƯỚC khi đụng DB)."""

    def execute(self, *a, **k):
        raise AssertionError("không được truy vấn khi tính năng tắt")

    def close(self):
        pass


def test_zalo_garden_text_off_not_written(stage, monkeypatch, tmp_path):
    stage["md"] = "tat"
    monkeypatch.setattr(zg, "STAFF_FILE", tmp_path / "garden_staff.json")
    monkeypatch.setattr(zg, "_staff", (None, {}))
    zg.STAFF_FILE.write_text(json.dumps({"staff": [
        {"user_hash": zg.uhash("1234567890123456789"), "ma_nv": "VT01"}]}),
        encoding="utf-8")
    monkeypatch.setattr(zg, "_connect", lambda: _NoDb())
    sent = []
    r = zg.handle("1234567890123456789", "user_send_text",
                  {"text": "KV-T01 tưới 30 phút"}, "m1",
                  send=lambda u, t: sent.append(t) or True)
    assert "CHƯA ghi" in r["text"] and "tắt" in r["text"].lower()
    assert stage["asked"] == ["farming-01"]
    stage["asked"].clear()
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: pytest.fail("tải"))
    r = zg.handle("1234567890123456789", "user_send_image",
                  {"text": "KV-T01", "attachments": [
                      {"type": "image",
                       "payload": {"url": "https://photo-1.zdn.vn/a.jpg"}}]},
                  "m2", send=lambda u, t: True)
    assert "CHƯA" in r["text"] and stage["asked"] == ["farming-04"]


def test_garden_media_cli_off_no_file(stage, monkeypatch, tmp_path):
    stage["md"] = "tat"
    monkeypatch.setattr(gm, "connect", lambda *a, **k: _NoDb())
    src = tmp_path / "a.jpg"
    src.write_bytes(b"\xff\xd8\xff\xe0")
    store = tmp_path / "store"
    rc = gm.main(["--file", str(src), "--plot", "KV-T01", "--date",
                  "2026-10-12", "--by", "Bé Na", "--store", str(store)])
    assert rc == 2 and not store.exists()
    assert stage["asked"] == ["farming-04"]


def test_channels_suggest_off_no_ai_and_trial_labelled(stage, monkeypatch,
                                                       capsys):
    monkeypatch.setattr(channels, "_connect", lambda: None)
    stage["md"] = "tat"
    monkeypatch.setattr(channels, "respond",
                        lambda *a, **k: pytest.fail("không gọi AI"))
    assert channels._suggest("shopee", "giá bao nhiêu") == 2
    assert stage["asked"] == ["sales-02"]
    stage["md"] = "chay_thu"
    monkeypatch.setattr(channels, "respond", lambda *a, **k: {
        "answer": "Dạ 1.000.000đ", "handoff": None, "blocked": []})
    capsys.readouterr()
    assert channels._suggest("shopee", "giá bao nhiêu") == 0
    out = capsys.readouterr().out
    assert "CHẠY THỬ" in out and "KHÔNG dán" in out


def test_qr_issue_off_blocked_trial_internal(db, proxy, run, stage, capsys):  # noqa: F811
    _ready(db, proxy, run)
    _sign(run)
    stage["md"] = "tat"
    assert run("issue", "--lot", LOT, "--by", "A") == 1
    assert _count(db, "qr_codes") == 0
    assert "farming-03.2" in stage["asked"]
    stage["md"] = "chay_thu"
    capsys.readouterr()
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    out = capsys.readouterr().out
    assert "chạy thử" in out.lower() and "URL:" not in out


def test_qr_site_not_operating_writes_no_active_page(db, proxy, run, stage,  # noqa: F811
                                                     tmp_path, monkeypatch,
                                                     capsys):
    _ready(db, proxy, run)
    _sign(run)
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    code = _code(db)
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    out_dir = tmp_path / "site"
    for md in ("chay_thu", "tat"):
        stage["md"] = md
        stage["asked"].clear()
        assert run("site", "--out", str(out_dir)) == 1
        assert not (out_dir / code / "index.html").exists()
        assert stage["asked"] == ["farming-03.2"]
    # thu hồi vẫn được công bố trang "đã thu hồi" kể cả khi tính năng tắt
    assert run("revoke", "--code", code, "--by", "GĐ fixture") == 0
    assert run("site", "--out", str(out_dir)) == 0
    assert "đã thu hồi" in (out_dir / code / "index.html").read_text(
        encoding="utf-8")
    stage["md"] = "co_nguoi_duyet"
    assert run("issue", "--lot", LOT, "--by", "A") == 0
    code2 = _code(db)
    assert run("site", "--out", str(out_dir)) == 0
    assert (out_dir / code2 / "index.html").exists()


def test_qr_link_off_blocked(db, proxy, run, stage, capsys):  # noqa: F811
    stage["md"] = "tat"
    _plot(db)
    lid = _harvest(proxy, H1)
    _mk_lot(db)
    assert run("link", "--lot", LOT, "--log", str(lid), "--by", "A") == 1
    assert _count(db, "lot_origins") == 0
    assert stage["asked"] == ["farming-03.1"]


LONG = {"ho": ("Nguyễn ", 100000), "thon": ("thôn ", 100000),
        "so_hoa": ("1 Ab ", 60000), "nhan": ("giao cho ", 60000),
        "dem": ("nguyen van ", 60000), "ap": ("ấp 1 ", 60000),
        "dinh": ("tiểuđuong", 30000)}


@pytest.mark.parametrize("name", sorted(LONG))
def test_new_rules_linear_on_long_input(name):
    """Luật mới (họ, thôn/ấp, số + Viết Hoa, người nhận, cụm dính liền) đi
    tối đa vài từ sau mỗi điểm neo — không bậc hai (bound rộng ~20 lần)."""
    import time
    unit, n = LONG[name]
    text = unit * n
    t = time.perf_counter()
    pii.scrub_user(text)
    gw.is_health_question(text)
    assert time.perf_counter() - t < 30
