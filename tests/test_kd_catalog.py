"""v8.2 KD-A3 — catalog quà Tết: golden + BOM hộp quà, LOẠI rượu (mọi phần)
+ TPBVSK chưa XNQC + combo dính các SKU đó; nhãn "Quảng cáo"; packshot chỉ
khi là PNG thật; cổng `check_publish(content_type="ads")`; hàng duyệt
`b2b_catalog` + bản gửi khớp hash. DB thật: schema tạm + ROLLBACK.
"""

import hashlib
import json
import re
from datetime import date
from pathlib import Path

import pytest

from agents import kd_catalog as kc
from agents import kd_quote as kq
from ingest.golden_store import GOLDEN_FILE, read_golden
from pipelines import approval_queue as aq
from pipelines import kb_filter
from tests.test_da_schema import TxConn, da_db

ROOT = Path(__file__).resolve().parent.parent
FX = ROOT / "tests" / "fixtures" / "b2b"
DAY = date(2026, 10, 12)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _j(p):
    return json.loads(Path(p).read_bytes().decode("utf-8"))


GOLD_REAL, _ = read_golden(GOLDEN_FILE)
GOLD = _j(FX / "golden_MAU.json")
MX = _j(FX / "matrix_MAU.json")
MX_REAL = _j(ROOT / "data" / "b2b_pricing.json")
BOM = _j(FX / "bom_MAU.json")["combos"]
SAMPLE_BOM = _j(ROOT / "data" / "sample_bom.json")["combos"]
ALC = [s for s in GOLD["skus"] if s["category"] == "alcohol"]


def _forbidden(text: str) -> list[str]:
    low = text.casefold()
    bad = [n for s in ALC for n in (s["sku_key"], s["name"])
           if n.casefold() in low]
    for k in ("hop-qua-cao-cap-mau", "hop-sum-vay-mau",
              "Hộp quà cao cấp", "sum vầy", "saphraton-80v",
              "Saphraton 80 viên", "hop-qua-tet-sam-sam-mau"):
        if k.casefold() in low:
            bad.append(k)
    return bad


def test_eligible_excludes_alcohol_and_unapproved_tpbvsk():
    items, excl = kc.eligible(GOLD, BOM)
    keys = [i["key"] for i in items]
    assert "savina-12v" in keys and "hop-savina-mau" in keys
    assert "hop-qua-mat-ong-mau" in keys
    codes = {e["key"]: e["code"] for e in excl}
    assert codes["ruou-sam-chai-thuy-tinh-500ml"] == "ruou"
    assert codes["ruou-sam-binh-su-do-500ml"] == "ruou"
    assert codes["hop-qua-cao-cap-mau"] == "ruou"      # thành phần rượu
    assert codes["hop-sum-vay-mau"] == "ruou"          # tên nhắc rượu
    assert codes["saphraton-80v"] == "tpbvsk_chua_xnqc"
    assert codes["hop-qua-tet-sam-sam-mau"] == "tpbvsk_chua_xnqc"
    assert all(set(e) == {"key", "code"} for e in excl)   # không tên


def test_build_md_html_no_alcohol(tmp_path):
    b = kc.build(GOLD, BOM, MX, day=DAY)
    assert b["problems"] == [], b["problems"]
    md, html = b["payload"], kq.render_html(b["payload"])
    for t in (md, html):
        assert _forbidden(t) == []
        assert not kb_filter.is_alcohol(t)
        assert not re.search(r"(?i)rượu|ruou", t)
    assert "Quảng cáo" in md and kq.disclaimer() in md
    assert "Savina tuýp 12 viên ngậm" in md and "Hộp quà mật ong (mẫu)" in md
    assert "Saphraton" not in md
    assert "| 10–49 | 5% | 707.000đ |" in md
    assert "<script" not in html.lower()


def test_build_without_tpbvsk_no_disclaimer_and_contact_line():
    b = kc.build(GOLD_REAL, SAMPLE_BOM, MX_REAL, day=DAY)
    assert b["problems"] == [] and b["n_items"] == 3
    md = b["payload"]
    for k in ("Mật ong sâm 120ml (1 hũ)", "Mật ong sâm 120ml (2 hũ)",
              "Mật ong sâm 300ml"):
        assert k in md
    assert kq.disclaimer() not in md and "Saphraton" not in md
    codes = {e["key"]: e["code"] for e in b["excluded"]}
    assert codes["hop-qua-tet-sam-sam-mau"] == "tpbvsk_chua_xnqc"
    assert md.count(kc.NO_PHOTO) == 3
    m = json.loads(json.dumps(MX_REAL))
    m["items"].pop("mat-ong-sam-300ml")
    md2 = kc.build(GOLD_REAL, SAMPLE_BOM, m, day=DAY)["payload"]
    assert "Giá theo số lượng: liên hệ báo giá" in md2


def test_packshot_png_only(tmp_path):
    d = tmp_path / "pk"
    d.mkdir()
    (d / "mat-ong-sam-120ml-1hu.png").write_bytes(PNG)
    (d / "mat-ong-sam-300ml.png").write_bytes(b"GIF89a not png")
    b = kc.build(GOLD_REAL, SAMPLE_BOM, MX_REAL, day=DAY, packshot_dir=d)
    sha = hashlib.sha256(PNG).hexdigest()[:16]
    md = b["payload"]
    assert f"packshots/mat-ong-sam-120ml-1hu.png (sha256 {sha})" in md
    assert "packshots/mat-ong-sam-300ml.png" not in md
    assert md.count(kc.NO_PHOTO) == 2
    html = kq.render_html(md)
    assert '<img src="packshots/mat-ong-sam-120ml-1hu.png"' in html
    assert "data:" not in html and b["problems"] == []
    # key không phải slug (vd chứa ../) → không đọc file ngoài thư mục
    (tmp_path / "x.png").write_bytes(PNG)
    assert kc.packshot(d, "../x") is None
    assert kc.packshot(d, "mat-ong-sam-120ml-1hu") == sha
    (d / "big.png").write_bytes(PNG + b"\0" * kc.MAX_PNG)
    assert kc.packshot(d, "big") is None


def test_gate_blocks_tampered_payload(monkeypatch):
    b = kc.build(GOLD, BOM, MX, day=DAY)
    names = kc.excluded_names(GOLD, BOM, b["excluded"])
    assert "Rượu sâm chai thủy tinh 500ml" in names
    errs = kq.gate_text(b["payload"] + "\nRượu sâm chai thủy tinh 500ml\n",
                        names, content_type="ads",
                        readiness=kq.readiness_map(GOLD))
    assert "ruou" in errs
    errs = kq.gate_text(b["payload"].replace("Quảng cáo\n", ""), names,
                        content_type="ads", readiness=kq.readiness_map(GOLD))
    assert "guardrail:thieu_nhan_quang_cao" in errs


def test_cli_build_real_bom_no_alcohol(tmp_path, capsys):
    out = tmp_path / "o"
    assert kc.main(["--build", "--bom", str(ROOT / "data" / "sample_bom.json"),
                    "--out-dir", str(out), "--date", "2026-10-12"]) == 0
    files = sorted(out.iterdir())
    assert [f.name for f in files] == ["catalog-tet-2026-10-12.html",
                                       "catalog-tet-2026-10-12.md"]
    for f in files:
        t = f.read_text(encoding="utf-8")
        assert not re.search(r"(?i)rượu|ruou", t)
    assert "rượu loại 2" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["--build", "--submit"], ["--build", "--export", "1", "--out", "x.md"],
    ["--export", "1"], ["--verify-send", "1", "x", "--bom", "y.json"], [],
])
def test_cli_bad_args(monkeypatch, argv):
    monkeypatch.setattr(kc, "connect", lambda: pytest.fail("connect"))
    with pytest.raises(SystemExit) as e:
        kc.main(argv)
    assert e.value.code == 2


def test_cli_bad_bom_exit1(tmp_path):
    p = tmp_path / "b.json"
    p.write_bytes(b"{}")
    assert kc.main(["--build", "--bom", str(p), "--out-dir",
                    str(tmp_path)]) == 1


# ---------------------------------------------------------------- DB
@pytest.fixture
def db():
    yield from da_db()


def _cli(db, monkeypatch, *argv):
    monkeypatch.setattr(kc, "connect", lambda: TxConn(db))
    monkeypatch.setattr(kq, "MATRIX_FILE", FX / "matrix_MAU.json")
    monkeypatch.setattr(kc, "GOLDEN_FILE", FX / "golden_MAU.json")
    return kc.main(list(argv))


def test_db_submit_approve_verify(db, monkeypatch, capsys, tmp_path):
    bom = str(FX / "bom_MAU.json")
    assert _cli(db, monkeypatch, "--submit", "--bom", bom, "--date",
                "2026-10-12") == 0
    rows = db.execute("select id, block, object_type, risk, status,"
                      " payload from approval_queue").fetchall()
    assert len(rows) == 1
    qid, block, ot, risk, status, payload = rows[0]
    assert (block, ot, risk, status) == ("sales", "b2b_catalog", "high",
                                         "pending")
    assert _forbidden(payload) == []
    assert _cli(db, monkeypatch, "--submit", "--bom", bom, "--date",
                "2026-10-12") == 0
    assert "[skip]" in capsys.readouterr().out
    out = tmp_path / "c.html"
    assert _cli(db, monkeypatch, "--export", str(qid), "--out",
                str(out)) == 1
    assert aq.decide(TxConn(db), qid, "GD Ban Hang Gia Lap (test)",
                     "approved")[0]
    assert _cli(db, monkeypatch, "--export", str(qid), "--out",
                str(out)) == 0
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(out)) == 0
    data = out.read_bytes()
    out.write_bytes(data.replace(b"707.000", b"700.000"))
    assert _cli(db, monkeypatch, "--verify-send", str(qid), str(out)) == 1
    # catalog duyệt KHÔNG dùng được như báo giá (sai loại) và ngược lại
    out.write_bytes(data)
    monkeypatch.setattr(kq, "connect", lambda: TxConn(db))
    assert kq.main(["--verify-send", str(qid), str(out)]) == 1
