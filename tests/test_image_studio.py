"""v6.2-anh-ai (MKT-03, WP08) — ảnh nháp ghép packshot thật + nhãn AI.

- W62.1 bảng `image_assets` (DB thật, schema tạm, ROLLBACK — mẫu
  tests/test_auth_approval.py), content type `image`, draft() chặn ảnh.
- W62.2 cổng nền `generate_background` (provider `none` 0 mạng), prompt nền.
- W62.3 `compose`: packshot dán sau cùng + kiểm pixel tuyệt đối, nhãn AI,
  không EXIF/GPS, từ chối rượu/TPBVSK/readiness/headline/packshot/font.
- W62.4 `save_image` + CLI (nháp pending, idempotent theo sha, DB chết exit 2).
Packshot = mẫu tự sinh "MẪU" (`make_sample_packshot`) trong tmp_path; provider
AI giả đăng ký bằng monkeypatch — không mạng, không key thật.
"""

import copy
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import types
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import psycopg
import pytest
from PIL import Image, ImageDraw, ImageFile
from psycopg.types.json import Jsonb

from ingest import golden_store as gs
from pipelines import content, guardrail, llm_gateway, store
from pipelines import image_studio as ims

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
RULES = json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
    encoding="utf-8"))
AI = RULES["labels"]["ai"][0]
AD = RULES["labels"]["ad"][0]
GOLDEN = json.loads((ROOT / "data" / "golden_skus.json").read_text(
    encoding="utf-8"))
GOLD = {s["sku_key"]: s for s in GOLDEN["skus"]}
CFG = json.loads((ROOT / "data" / "image_studio.json").read_text(
    encoding="utf-8"))
FORMATS = list(CFG["formats"])
HONEY = "mat-ong-sam-300ml"
R_OK = {(HONEY, "facebook"): "TP_THUONG"}
ALCOHOL = [k for k, s in GOLD.items() if s["category"] == "alcohol"]
TPBVSK = [k for k, s in GOLD.items() if s["category"] == "tpbvsk"]
SCENE = "bàn gỗ, ánh nắng sớm, lá xanh"
HEADLINE = "Quà tặng từ núi rừng"
RED = (255, 0, 0)

NEED_FONT = pytest.mark.skipif(
    ims.fonts_for(f"{AI} {AD} MẪU {HEADLINE}") is None,
    reason="không có font hệ thống đủ glyph tiếng Việt (CI Linux thiếu font)")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _codes(g):
    return [v.get("code") for v in (g or {}).get("violations") or []]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("IMAGE_PROVIDER", "PACKSHOT_DIR", "IMAGE_OUT_DIR",
              "IMAGE_FONT"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def pk(tmp_path):
    d = tmp_path / "packshots"
    ims.make_sample_packshot(d / f"{HONEY}.png", HONEY)
    return d


@pytest.fixture
def out(tmp_path):
    return tmp_path / "out"


def _fake_bg(prompt, size):
    """Nền AI giả TẤT ĐỊNH: màu đặc + khối đỏ vẽ ĐÈ đúng packshot_box (mô
    phỏng nền AI cố vẽ vào vùng sản phẩm)."""
    cfg, _ = ims.load_config()
    img = Image.new("RGB", size, (60, 90, 70))
    for name, wh in cfg["formats"].items():
        if tuple(wh) == tuple(size):
            x, y, w, h = ims._px(cfg["layout"][name]["packshot_box"], size)
            ImageDraw.Draw(img).rectangle((x, y, x + w - 1, y + h - 1),
                                          fill=RED)
    return img, {"model": "fake-model"}


@pytest.fixture
def fake(monkeypatch):
    """PROVIDERS["fake"] = spy ghi lại args mỗi lần gọi."""
    calls = []

    def spy(*args, **kw):
        calls.append((args, kw))
        return _fake_bg(*args, **kw)

    monkeypatch.setitem(ims.PROVIDERS, "fake", spy)
    return calls


def _compose(pk, out, **kw):
    base = {"fmt": "1:1", "readiness": R_OK, "packshot_dir": pk,
            "out_dir": out}
    base.update(kw)
    sku = base.pop("sku", HONEY)
    ch = base.pop("channel", "facebook")
    hl = base.pop("headline", HEADLINE)
    return ims.compose(sku, ch, hl, **base)


def _files(d: Path) -> list[str]:
    return sorted(os.listdir(d)) if d.exists() else []


TWIN_A, TWIN_B = "mat-ong-sam-120ml-1hu", "mat-ong-sam-120ml-2hu"


def _twin_packshots(d: Path) -> dict:
    """Nghiệm thu v6.2 vòng 2: 3 SKU cùng MỘT hình sản phẩm. A = mẫu
    300x400 (vừa ô 1:1, KHÔNG bị thu nhỏ), B = bản sao byte-y-hệt của A,
    HONEY = cùng pixel hiển thị nhưng KHÁC bytes (RGB vùng trong suốt đổi
    trắng + mức nén khác). -> {sku: sha file}."""
    a = ims.make_sample_packshot(d / f"{TWIN_A}.png", "chung", (300, 400))
    shutil.copyfile(a, d / f"{TWIN_B}.png")
    with Image.open(a) as im:
        rgba = im.convert("RGBA")
    clear = rgba.getchannel("A").point(lambda v: 255 if v == 0 else 0)
    junk = Image.composite(Image.new("RGBA", rgba.size, (255, 255, 255, 0)),
                           rgba, clear)
    junk.save(d / f"{HONEY}.png", format="PNG", compress_level=1)
    with Image.open(d / f"{HONEY}.png") as im:
        back = im.convert("RGBA")
    assert back.tobytes() != rgba.tobytes()          # rác dưới alpha 0 thật
    assert clear.getbbox() is not None
    assert Image.composite(Image.new("RGBA", rgba.size), back,
                           clear).tobytes() == Image.composite(
        Image.new("RGBA", rgba.size), rgba, clear).tobytes()  # cùng hình
    shas = {k: _sha((d / f"{k}.png").read_bytes())
            for k in (TWIN_A, TWIN_B, HONEY)}
    assert shas[TWIN_A] == shas[TWIN_B] != shas[HONEY]
    return shas


def _png_chunks(data: bytes) -> list[bytes]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    i, out = 8, []
    while i < len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        out.append(data[i + 4:i + 8])
        i += 12 + n
    return out


def _tmp_cfg(tmp_path, monkeypatch, mutate):
    doc = copy.deepcopy(CFG)
    mutate(doc)
    p = tmp_path / "image_studio.json"
    p.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(ims, "CONFIG", p)
    return p


def _lsize(fmt) -> int:
    """Cỡ chữ nhãn sàn = max(font_px_min, font_ratio × cao)."""
    lab = CFG["label"]
    return max(lab["font_px_min"], round(lab["font_ratio"] *
                                         CFG["formats"][fmt][1]))


def _label_text(img, box) -> tuple[float, int]:
    """(tỉ lệ, chiều cao px) pixel ĐÚNG màu chữ nhãn trong label_box —
    riêng tấm nền không đạt (nghiệm thu v6.2: so nền trơn thì tấm nền đã
    khác 100%, nhãn không có chữ vẫn qua)."""
    x, y, w, h = box
    m = ims._color_mask(img.crop((x, y, x + w, y + h)),
                        CFG["label"]["text_rgb"])
    bb = m.getbbox()
    return m.histogram()[255] / (w * h), (bb[3] - bb[1]) if bb else 0


# ======================= W62.1 content type + Studio ========================

def test_rules_image_content_type_and_studio_filter():
    ct = RULES["content_types"]["image"]
    assert ct["public"] is True and ct["ad"] is True
    assert "chờ Pháp chế" in ct["trang_thai"] and "maket XNQC" in \
        ct["trang_thai"]
    app = (ROOT / "app" / "streamlit_app.py").read_text(encoding="utf-8")
    assert re.search(r'and k != "image"\]', app)


def test_content_draft_image_refused_zero_llm(monkeypatch):
    calls = []
    monkeypatch.setattr(content, "chat", lambda *a, **k: calls.append(a))
    r = content.draft("x", "facebook", content_type="image")
    assert r["meta"]["refused"]["code"] == "loai_la"
    assert "image_studio" in r["meta"]["refused"]["reason"]
    assert r["text"] == "" and r["guardrail"]["ok"] is False
    assert calls == []


def test_schema_label_check_matches_rules_drift_guard():
    """Chuỗi nhãn trong check constraint == labels.ai[0] (đổi 1 chỗ là đỏ)."""
    block = SCHEMA_SQL[SCHEMA_SQL.index(
        "create table if not exists image_assets"):]
    m = re.search(r"label_text like '%([^%']+)%'", block)
    assert m and m.group(1) == AI
    assert "unique (file_sha256, sku, channel, format)" in block  # danh tính
    assert "file_sha256 text not null," in block
    assert "references content_drafts(id)" in block


def test_roles_image_assets_insert_select_only():
    low = ROLES_SQL.lower()
    assert "grant select on image_assets to agent_writer;" in low
    m = re.search(r"grant insert \(([^)]*)\)\s+on image_assets to "
                  r"agent_writer;", low)
    assert m
    cols = [c.strip() for c in m.group(1).split(",")]
    assert cols == ["file_sha256", "file_name", "sku", "channel", "format",
                    "ai_generated", "label_text", "provider", "model",
                    "prompt_sha256", "prompt_version", "packshot_sha256",
                    "draft_id", "meta", "created_by"]
    assert not re.search(r"grant[^;]*\b(update|delete)\b[^;]*image_assets",
                         low)


# ======================= DB thật (schema tạm, ROLLBACK) =====================

@pytest.fixture
def db():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_v62_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)      # idempotent ×2
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """commit/close chỉ ghi nhận — dữ liệu ở lại trong tx fixture."""

    def __init__(self, conn):
        self.conn = conn
        self.committed = 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def close(self):
        pass


_INS = ("insert into image_assets (file_sha256, file_name, sku, channel, "
        "format, ai_generated, label_text, provider, model, prompt_sha256, "
        "prompt_version, packshot_sha256, draft_id, meta, created_by) values "
        "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "returning id")


def _asset(sha, did, *, ai=True, label=None, model="m", psha="p" * 64,
           ch="facebook", sku=HONEY, fmt="1:1"):
    return (sha, f"{sha}.png", sku, ch, fmt, ai,
            label if label is not None else f"{AI}\n{AD}", "fake", model,
            psha, "image_background@1", "k" * 64, did,
            Jsonb({"k": 1}), "agent:mkt03")


def _denied(conn, exc, sql, params=None):
    with pytest.raises(exc), conn.transaction():
        conn.execute("set local role agent_writer")
        conn.execute(sql, params)


def test_db_image_assets_grants_unique_and_checks(db):
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    did = store.save_draft(tx, "image b", "facebook",
                           f"{HEADLINE}\n{AI}\n{AD}\n\nTệp ảnh: a.png",
                           {"ok": True}, "cli", created_by="agent:mkt03",
                           content_type="image", sku=HONEY)
    aid = db.execute(_INS, _asset("a" * 64, did)).fetchone()[0]
    assert aid is not None
    assert db.execute("select count(*) from image_assets").fetchone()[0] == 1
    db.execute("reset role")
    uv, cv = psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation
    _denied(db, uv, _INS, _asset("a" * 64, did))          # trùng sha + kênh
    _denied(db, cv, _INS, _asset("b" * 64, did, label=AD))       # thiếu nhãn
    _denied(db, cv, _INS, _asset("c" * 64, did, model=None))     # thiếu model
    _denied(db, cv, _INS, _asset("d" * 64, did, psha=None))      # thiếu prompt
    _denied(db, psycopg.errors.InsufficientPrivilege,
            "update image_assets set label_text = 'x'")
    _denied(db, psycopg.errors.InsufficientPrivilege,
            "delete from image_assets")
    # Nền tất định (không AI): không bắt model/prompt.
    with db.transaction():
        db.execute("set local role agent_writer")
        db.execute(_INS, _asset("e" * 64, did, ai=False, label=AI,
                                model=None, psha=None))
    assert db.execute("select count(*) from image_assets").fetchone()[0] == 2
    # Cùng ảnh, kênh / SKU / format KHÁC -> dòng riêng (danh tính = sha +
    # sku + kênh + format); trùng cả 4 -> UniqueViolation.
    for kw in ({"ch": "shopee"}, {"sku": "mat-ong-sam-120ml-1hu"},
               {"fmt": "4:5"}):
        with db.transaction():
            db.execute("set local role agent_writer")
            db.execute(_INS, _asset("a" * 64, did, **kw))
    assert db.execute("select count(*) from image_assets").fetchone()[0] == 5
    _denied(db, uv, _INS, _asset("a" * 64, did, sku="mat-ong-sam-120ml-1hu"))


# ======================= W62.2 cổng nền + prompt nền ========================

@NEED_FONT
def test_provider_none_zero_network_deterministic(monkeypatch, pk, out):
    hits = []

    def boom(*a, **k):
        hits.append(a)
        raise OSError("mạng bị cấm trong test")

    monkeypatch.setattr(socket.socket, "connect", boom)
    monkeypatch.setattr(socket, "create_connection", boom)
    monkeypatch.setattr(llm_gateway, "chat", boom)
    monkeypatch.setattr(content, "chat", boom)
    size = tuple(CFG["formats"]["1:1"])
    a, ma = ims.generate_background(None, size)
    monkeypatch.setenv("IMAGE_PROVIDER", "none")
    b, mb = ims.generate_background("bỏ qua", size)
    assert a.tobytes() == b.tobytes() and a.size == size
    assert ma == mb == {"provider": "none", "model": "none",
                        "ai_generated": False}
    monkeypatch.delenv("IMAGE_PROVIDER")
    r = _compose(pk, out)
    assert r["ok"] is True, r["refused"]
    assert hits == []


def test_unknown_provider_wrong_size_and_errors(monkeypatch):
    size = (200, 100)
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    with pytest.raises(ims.ImageProviderError, match="external-dep"):
        ims.generate_background("p", size)
    monkeypatch.setitem(ims.PROVIDERS, "bad",
                        lambda p, s: (Image.new("RGB", (10, 10)),
                                      {"model": "m"}))
    with pytest.raises(ims.ImageProviderError, match="sai kích thước"):
        ims.generate_background("p", size, provider="bad")

    def raises(p, s):
        raise RuntimeError("timeout")

    monkeypatch.setitem(ims.PROVIDERS, "boom", raises)
    with pytest.raises(ims.ImageProviderError, match="RuntimeError"):
        ims.generate_background("p", size, provider="boom")
    monkeypatch.setitem(ims.PROVIDERS, "nomodel",
                        lambda p, s: (Image.new("RGB", s), {}))
    with pytest.raises(ims.ImageProviderError, match="model"):
        ims.generate_background("p", size, provider="nomodel")
    monkeypatch.setitem(ims.PROVIDERS, "rgba",
                        lambda p, s: (Image.new("RGBA", s), {"model": "m"}))
    img, meta = ims.generate_background("p", size, provider="rgba")
    assert img.mode == "RGB" and meta["ai_generated"] is True


@NEED_FONT
def test_provider_gets_only_prompt_and_size(fake, pk, out):
    r = _compose(pk, out, provider="fake", scene=SCENE, fmt="4:5")
    assert r["ok"] is True, r["refused"]
    [(args, kw)] = fake
    assert kw == {} and len(args) == 2
    prompt, size = args
    assert isinstance(prompt, str) and SCENE in prompt
    assert size == tuple(CFG["formats"]["4:5"])
    assert not any(isinstance(a, (Image.Image, bytes, bytearray))
                   for a in args)


def test_check_scene_cases():
    def code(s):
        r = ims.check_scene(s)
        return r and r["code"]

    assert code("bác sĩ áo blouse cầm sản phẩm") == "prompt_cam"
    assert code("sâm giúp chữa tiểu đường") == "prompt_cam"
    nfd = __import__("unicodedata").normalize("NFD", "BÁC SĨ đứng cạnh")
    assert nfd != "BÁC SĨ đứng cạnh" and code(nfd) == "prompt_cam"
    assert code("bac si mac ao trang") == "prompt_cam"         # không dấu
    assert code("b.á.c s.ĩ mỉm cười") == "prompt_cam"          # ký tự chèn
    assert code("chai có logo lớn") == "prompt_cam"
    assert code("bàn gỗ có ly rượu vang") == "prompt_cam"      # guardrail
    assert code("x" * (ims.MAX_SCENE + 1)) == "prompt_cam"
    assert code(SCENE) is None
    assert ims.check_scene(None) is None and ims.check_scene("  ") is None
    r = ims.check_scene("bác sĩ áo blouse cầm sản phẩm")
    assert "bác sĩ" in r["reason"] and "blouse" in r["reason"]


def test_check_scene_checks_the_string_used_in_prompt():
    """Nghiệm thu v6.2: ký tự điều khiển C0/DEL chèn giữa từ từng qua kiểm
    (chỉ bỏ Cf) rồi _clean nối lại thành từ cấm trong prompt gửi provider."""
    traps = ["chai có lo\x01go lớn", "lo\x01go và nh\x7fãn",
             "y t\x01á và ống ng\x01he", "điều tr\x01ị cho người già",
             "thu\x7fốc bổ trên bàn", "bàn gỗ, bao\x1f bì giấy",
             "b\x01ác s\x7fĩ đứng cạnh"]
    for s in traps:
        r = ims.check_scene(s)
        assert r and r["code"] == "prompt_cam", s
    assert ims.check_scene(SCENE + "\x01\x7f") is None
    banned = [guardrail._find_terms(ims._clean(s), CFG["prompt_banned"])
              for s in traps]
    assert all(banned[:3]) and all(banned[5:])   # _clean nối lại từ cấm
    # Bất biến: qua kiểm => chính chuỗi vào prompt không có từ cấm.
    for s in traps + [SCENE, "đá xám\x01, sương sớm", "khăn lụa\x7f đỏ"]:
        if ims.check_scene(s) is None:
            p = ims.background_prompt(s)[0]
            assert ims._clean(s) in p
            assert not guardrail._find_terms(ims._clean(s),
                                             CFG["prompt_banned"])
            assert guardrail.check(ims._clean(s))["ok"] is True


def test_background_template_manifest_and_prompt():
    man = json.loads((ROOT / "data" / "prompts" / "manifest.json")
                     .read_text(encoding="utf-8"))["templates"]
    ent = man["image_background"]
    raw = (ROOT / "data" / "prompts" / "image_background.md").read_bytes()
    assert ent["sha256"] == _sha(raw.replace(b"\r\n", b"\n"))
    assert ent["version"] == "image_background@1"
    tmpl, ver, sha = content.load_template("image_background")
    assert (ver, sha) == (ent["version"], ent["sha256"])
    assert "{scene}" in tmpl and guardrail.check(tmpl)["ok"] is True
    for w in ("không người", "không chữ", "không logo", "không bao bì"):
        assert w in tmpl.casefold()
    p, v, s = ims.background_prompt(SCENE)
    assert SCENE in p and "{scene}" not in p and (v, s) == (ver, sha)
    assert CFG["default_scene"] in ims.background_prompt(None)[0]


# ======================= W62.3 compose ======================================

@NEED_FONT
def test_background_overdraw_packshot_box_neutralized(fake, pk, out):
    r = _compose(pk, out, provider="fake", scene=SCENE)
    assert r["ok"] is True, r["refused"]
    img = Image.open(r["path"]).convert("RGB")
    fitted, (x, y) = r["fitted"], r["packshot_xy"]
    assert ims.verify_packshot(img, fitted, (x, y)) is True
    crop = img.crop((x, y, x + fitted.width, y + fitted.height))
    px, sol = list(crop.getdata()), list(ims._solid(fitted).getdata())
    assert any(p == RED for p in px)          # nền giả đã vẽ đè ô packshot
    assert not any(s == 255 and p == RED for s, p in zip(sol, px))
    assert r["meta"]["packshot"]["box"] == [x, y, fitted.width,
                                            fitted.height]
    assert r["meta"]["packshot"]["fitted_sha256"] == _sha(fitted.tobytes())
    # sha file gốc là ngữ cảnh của dòng (2 file cùng pixel -> cùng ảnh) —
    # trả riêng cho save_image, không nằm trong sidecar.
    assert r["packshot_sha256"] == _sha((pk / f"{HONEY}.png").read_bytes())
    assert "file_sha256" not in r["meta"]["packshot"]


@NEED_FONT
def test_tamper_one_pixel_detected(pk, out):
    r = _compose(pk, out)
    img = Image.open(r["path"]).convert("RGB")
    fitted, (x, y) = r["fitted"], r["packshot_xy"]
    assert ims.verify_packshot(img, fitted, (x, y)) is True
    sol = ims._solid(fitted)
    sx, sy = next((i % sol.width, i // sol.width)
                  for i, a in enumerate(sol.getdata()) if a == 255)
    r0, g0, b0 = img.getpixel((x + sx, y + sy))
    img.putpixel((x + sx, y + sy), ((r0 + 1) % 256, g0, b0))
    assert ims.verify_packshot(img, fitted, (x, y)) is False
    assert ims.verify_packshot(img, fitted, (img.width, 0)) is False
    clear = Image.new("RGBA", (5, 5), (0, 0, 0, 0))
    assert ims.verify_packshot(img, clear, (0, 0)) is False   # 0 pixel đặc


@NEED_FONT
def test_layer_drawn_after_paste_refused_no_files(monkeypatch, pk, out):
    real = ims._paste_packshot

    def tampered(canvas, fitted, xy):
        canvas = real(canvas, fitted, xy)
        x, y = xy
        ImageDraw.Draw(canvas).rectangle(
            (x + fitted.width // 3, y + fitted.height // 2,
             x + fitted.width // 2, y + fitted.height // 2 + 20),
            fill=(0, 0, 255))
        return canvas

    monkeypatch.setattr(ims, "_paste_packshot", tampered)
    r = _compose(pk, out)
    assert r["ok"] is False and r["refused"]["code"] == "packshot_lech"
    assert r["path"] is None and r["meta"] is None
    assert _files(out) == []                  # không png/json/file tạm


@NEED_FONT
def test_twenty_ai_images_label_and_meta(fake, pk, out):
    heads = ["Quà tặng từ núi rừng", "Mật ong sâm cho mùa Tết sum vầy",
             "Đặc sản Quảng Nam", "Ngọt dịu hương rừng",
             "Món quà gửi người thương"]
    scenes = [SCENE, "khăn lụa đỏ, hoa mai vàng", "đá xám, sương sớm",
              "giỏ mây, lá chuối", "nền giấy kraft, nhành thông"]
    shas = set()
    for fmt in FORMATS:
        for hl, sc in zip(heads, scenes):
            r = _compose(pk, out, provider="fake", fmt=fmt, headline=hl,
                         scene=sc)
            assert r["ok"] is True, (fmt, hl, r["refused"])
            m = r["meta"]
            shas.add(r["sha256"])
            assert m["ai_generated"] is True and m["labels"][0] == AI
            assert AD in m["labels"] and AI in r["text_layer"]
            assert r["text_layer"].split("\n") == [hl, *m["labels"]]
            assert r["guardrail"]["ok"] is True
            bg = m["background"]
            assert bg["model"] == "fake-model" and bg["provider"] == "fake"
            assert bg["prompt_version"] == "image_background@1"
            assert bg["prompt_sha256"] == _sha(bg["prompt"].encode("utf-8"))
            assert sc in bg["prompt"]
            assert datetime.fromisoformat(m["created_at"]).utcoffset() \
                is not None
            side = json.loads(Path(r["sidecar"]).read_bytes()
                              .decode("utf-8"))
            assert side == m and side["file"] == f"{r['sha256']}.png"
            raw = Path(r["sidecar"]).read_text(encoding="utf-8")
            assert str(out) not in raw and str(pk) not in raw
            assert not re.search(r"[A-Za-z]:[\\/]", raw)  # không path máy
            img = Image.open(r["path"]).convert("RGB")
            assert img.size == tuple(CFG["formats"][fmt])
            plain, _ = _fake_bg(bg["prompt"], img.size)  # nền không nhãn
            x, yy, w, h = m["label_box"]
            assert ims._changed_ratio(img.crop((x, yy, x + w, yy + h)),
                                      plain.crop((x, yy, x + w, yy + h))
                                      ) >= 0.01
            ratio, text_h = _label_text(img, m["label_box"])
            assert ratio >= 0.0005, (fmt, ratio)     # có CHỮ, không chỉ tấm
            # 2 dòng nhãn -> cao ≥ cỡ chữ sàn max(font_px_min, ratio × H)
            assert len(m["labels"]) == 2 and text_h >= _lsize(fmt), (
                fmt, text_h)
            assert ims.verify_packshot(img, r["fitted"], r["packshot_xy"])
    assert len(shas) == 20 and len(fake) == 20


@NEED_FONT
def test_label_check_catches_plate_without_text(monkeypatch, fake, pk, out):
    """Nghiệm thu v6.2: đột biến bỏ CHỮ nhãn, giữ tấm nền — kiểm cũ "vùng
    nhãn khác nền ≥1%" vẫn qua (tấm nền đã khác ~100%) nên mù; kiểm pixel
    đúng màu chữ nhãn phải ra 0."""
    real = ImageDraw.ImageDraw.multiline_text

    def no_label(self, xy, text, *a, **kw):
        if AI in text:
            return None
        return real(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "multiline_text", no_label)
    for fmt in FORMATS:
        r = _compose(pk, out, provider="fake", scene=SCENE, fmt=fmt)
        assert r["ok"] is True and r["meta"]["labels"][0] == AI  # meta "có"
        img = Image.open(r["path"]).convert("RGB")
        x, y, w, h = box = r["meta"]["label_box"]
        plain, _ = _fake_bg(None, img.size)
        assert ims._changed_ratio(img.crop((x, y, x + w, y + h)),
                                  plain.crop((x, y, x + w, y + h))) >= 0.99
        assert _label_text(img, box) == (0.0, 0), fmt


@NEED_FONT
def test_provider_none_not_ai_but_label_still_drawn(pk, out):
    r = _compose(pk, out)
    m = r["meta"]
    assert r["ok"] is True and m["ai_generated"] is False
    assert m["labels"][0] == AI and AI in r["text_layer"]
    assert m["background"] == {"provider": "none", "model": "none",
                               "prompt": None, "prompt_sha256": None,
                               "prompt_version": None,
                               "template_sha256": None}


@NEED_FONT
def test_output_has_no_exif_gps_xmp(tmp_path, out):
    d = tmp_path / "pk_exif"
    src = ims.make_sample_packshot(d / f"{HONEY}.png", HONEY, exif_gps=True)
    raw = src.read_bytes()
    assert b"eXIf" in raw and b"GPS" in raw         # mẫu thật có metadata
    with Image.open(src) as s:
        assert s.getexif().get_ifd(0x8825)
    r = _compose(d, out)
    assert r["ok"] is True, r["refused"]
    data = Path(r["path"]).read_bytes()
    with Image.open(r["path"]) as im:
        assert dict(im.getexif()) == {}
        assert not ({"exif", "xmp", "XML:com.adobe.xmp", "icc_profile"}
                    & set(im.info))
    assert b"eXIf" not in data and b"GPS" not in data
    assert set(_png_chunks(data)) <= {b"IHDR", b"IDAT", b"IEND"}


@NEED_FONT
@pytest.mark.parametrize("prov", ["none", "fake"])
def test_alcohol_refused_every_combo(fake, pk, out, prov):
    for sku in ALCOHOL:
        ims.make_sample_packshot(pk / f"{sku}.png", sku)
        for ch in ("facebook", "shopee"):
            for rmap in (None, {(sku, ch): "QC_DAY_DU"}):
                r = _compose(pk, out, sku=sku, channel=ch, readiness=rmap,
                             provider=prov)
                assert r["refused"]["code"] == "ruou", (sku, ch, rmap)
                assert r["ok"] is False and r["path"] is None
                assert "ruou_cam_quang_cao" in _codes(r["guardrail"])
    assert len(ALCOHOL) == 2 and fake == [] and _files(out) == []


@NEED_FONT
def test_tpbvsk_needs_maket_xnqc(fake, pk, out):
    for rmap in (None, {("sapentol-30v", "facebook"): "QC_DAY_DU"}):
        r = _compose(pk, out, sku="sapentol-30v", fmt="banner",
                     provider="fake", readiness=rmap)
        assert r["refused"]["code"] == "maket_xnqc"
        assert "creative TPBVSK phải dùng maket XNQC" in \
            r["refused"]["reason"]
    assert len(TPBVSK) == 8
    for sku in TPBVSK:
        for ch in ("facebook", "shopee"):
            ref = ims.precheck_image(sku, ch, "1:1",
                                     readiness={(sku, ch): "QC_DAY_DU"})
            assert ref["code"] == "maket_xnqc", (sku, ch)
            assert ims.precheck_image(sku, ch, "1:1")["code"] == \
                "maket_xnqc"
    assert fake == [] and _files(out) == []


@NEED_FONT
def test_readiness_channel_format_sku_refusals(fake, pk, out):
    def code(**kw):
        r = _compose(pk, out, provider="fake", **kw)
        assert r["ok"] is False and r["path"] is None
        return r["refused"]["code"]

    assert code(sku="mat-ong-sam-120ml-1hu", readiness=None) == "readiness"
    assert code(readiness=None) == "readiness"       # golden: chưa tự công bố
    assert code(readiness={(HONEY, "shopee"): "TP_THUONG"}) == "readiness"
    assert code(readiness={(HONEY, "facebook"): "MO_TA"}) == "readiness"
    assert code(channel="chatbot",
                readiness={(HONEY, "chatbot"): "TP_THUONG"}) == "kenh_la"
    assert code(channel="tivi") == "kenh_la"
    assert code(fmt="2:3") == "format_la"
    assert code(sku=None) == "sku_la"
    assert code(sku="khong-co") == "sku_la"
    assert code(readiness=[("x", "y")]) == "config"
    assert fake == [] and _files(out) == []


@NEED_FONT
def test_headline_refusals_and_ok(fake, pk, out):
    r = _compose(pk, out, provider="fake",
                 headline="Sâm giúp chữa khỏi tiểu đường")
    assert r["refused"]["code"] == "headline"
    assert "tu_cam" in _codes(r["guardrail"])
    assert r["text_layer"].startswith("Sâm giúp chữa khỏi tiểu đường\n")
    long = "Quà " * (CFG["headline"]["max_chars"] // 4 + 1)
    assert _compose(pk, out, headline=long)["refused"]["code"] == "headline"
    assert _compose(pk, out, headline=" \u200b ")["refused"]["code"] == \
        "headline"
    assert _compose(pk, out, headline="Rượu sâm biếu Tết")["refused"][
        "code"] == "headline"
    assert fake == [] and _files(out) == []
    ok = _compose(pk, out, headline="Quà\u200b tặng\n  núi rừng")
    assert ok["ok"] is True and ok["guardrail"]["ok"] is True
    assert ok["text_layer"].split("\n")[0] == "Quà tặng núi rừng"
    g = guardrail.check_publish(ok["text_layer"], channel="facebook",
                                content_type="image", sku=HONEY,
                                readiness=R_OK)
    assert g["ok"] is True


@NEED_FONT
def test_scene_refused_before_provider(fake, pk, out):
    r = _compose(pk, out, provider="fake",
                 scene="bác sĩ áo blouse cầm sản phẩm")
    assert r["refused"]["code"] == "prompt_cam"
    assert fake == [] and _files(out) == []


@NEED_FONT
def test_packshot_errors(monkeypatch, tmp_path, pk, out):
    assert _compose(tmp_path / "trong", out)["refused"]["code"] == \
        "packshot_thieu"
    bad = tmp_path / "bad"
    bad.mkdir()
    Image.new("RGB", (50, 50), (1, 2, 3)).save(bad / f"{HONEY}.png",
                                               format="JPEG")
    r = _compose(bad, out)
    assert r["refused"]["code"] == "packshot_loi" and "JPEG" in \
        r["refused"]["reason"]
    (bad / f"{HONEY}.png").write_bytes(b"\x89PNG not an image at all")
    assert _compose(bad, out)["refused"]["code"] == "packshot_loi"
    Image.new("RGBA", (80, 80), (0, 0, 0, 0)).save(bad / f"{HONEY}.png")
    r = _compose(bad, out)
    assert r["refused"]["code"] == "packshot_loi" and "pixel đặc" in \
        r["refused"]["reason"]
    _tmp_cfg(tmp_path, monkeypatch,
             lambda d: d["packshot"].update(max_pixels=100))
    monkeypatch.setattr(ImageFile.ImageFile, "load",
                        lambda self: pytest.fail("load() trước khi kiểm size"))
    r = _compose(pk, out)
    assert r["refused"]["code"] == "packshot_loi" and "vượt" in \
        r["refused"]["reason"]
    assert _files(out) == []


def test_font_missing_refused(monkeypatch, tmp_path, pk, out):
    _tmp_cfg(tmp_path, monkeypatch,
             lambda d: d.update(fonts=[str(tmp_path / "khong-co.ttf")]))
    assert ims.fonts_for("abc") is None
    r = _compose(pk, out)
    assert r["refused"]["code"] == "font" and _files(out) == []
    monkeypatch.setattr(ims, "CONFIG", ROOT / "data" / "image_studio.json")
    assert ims.fonts_for("\ue000") is None


def test_layout_overlap_is_config(monkeypatch, tmp_path, pk, out):
    _tmp_cfg(tmp_path, monkeypatch, lambda d: d["layout"]["1:1"].update(
        label_box=[20, 80, 60, 15]))
    cfg, err = ims.load_config()
    assert cfg is None and "giao packshot_box" in err
    r = _compose(pk, out)
    assert r["refused"]["code"] == "config" and _files(out) == []


@NEED_FONT
def test_same_params_same_file_sidecar_kept(pk, out):
    a = _compose(pk, out)
    side, png = Path(a["sidecar"]), Path(a["path"])
    before = (side.read_bytes(), side.stat().st_mtime_ns)
    pbefore = (png.read_bytes(), png.stat().st_mtime_ns)
    b = _compose(pk, out)
    assert a["sha256"] == b["sha256"] and b["ok"] is True
    assert [f for f in _files(out) if f.endswith(".png")] == \
        [f"{a['sha256']}.png"]
    assert _files(out) == sorted([f"{a['sha256']}.png",
                                  f"{a['sha256']}.json"])
    assert (side.read_bytes(), side.stat().st_mtime_ns) == before
    assert (png.read_bytes(), png.stat().st_mtime_ns) == pbefore  # đúng sha
    assert b["meta"] == a["meta"]
    assert _sha(Path(a["path"]).read_bytes()) == a["sha256"]
    # Cùng ảnh cho kênh khác: sidecar mô tả FILE (không chứa kênh) -> giữ
    # nguyên, không lật qua lại theo kênh (nghiệm thu v6.2).
    c = _compose(pk, out, channel="shopee",
                 readiness={(HONEY, "shopee"): "TP_THUONG"})
    assert c["ok"] is True and c["sha256"] == a["sha256"]
    assert (a["channel"], c["channel"]) == ("facebook", "shopee")
    assert "channel" not in a["meta"] and c["meta"] == a["meta"]
    # Ngữ cảnh dòng (nghiệm thu v6.2 vòng 2) không nằm trong sidecar.
    assert not {"sku", "format", "channel"} & set(a["meta"])
    assert (a["sku"], a["format"]) == (HONEY, "1:1")
    assert (side.read_bytes(), side.stat().st_mtime_ns) == before


@NEED_FONT
def test_same_picture_three_skus_one_file_one_sidecar(tmp_path, out):
    """Nghiệm thu v6.2 vòng 2: 3 SKU cùng hình sản phẩm (bản sao byte /
    cùng pixel khác bytes) -> cùng 1 ảnh; sidecar KHÔNG lật theo SKU (bytes
    + mtime giữ nguyên), `meta` 3 lần bằng nhau; sku + sha file packshot
    gốc trả riêng từng lần."""
    d = tmp_path / "twins"
    shas = _twin_packshots(d)
    rmap = {(k, "facebook"): "TP_THUONG" for k in shas}
    res = {}
    for k in (TWIN_A, TWIN_B, HONEY):
        res[k] = _compose(d, out, sku=k, readiness=rmap)
        assert res[k]["ok"] is True, (k, res[k]["refused"])
        if k == TWIN_A:
            side = Path(res[k]["sidecar"])
            before = (side.read_bytes(), side.stat().st_mtime_ns)
        assert (side.read_bytes(), side.stat().st_mtime_ns) == before, k
    a = res[TWIN_A]
    assert {r["sha256"] for r in res.values()} == {a["sha256"]}
    assert all(r["meta"] == a["meta"] for r in res.values())
    assert json.loads(before[0].decode("utf-8")) == a["meta"]
    assert {k: (r["sku"], r["packshot_sha256"]) for k, r in res.items()} \
        == {k: (k, s) for k, s in shas.items()}
    assert _files(out) == sorted([f"{a['sha256']}.png", side.name])


@NEED_FONT
def test_tampered_sidecar_not_trusted(pk, out):
    """Rà OWASP A08: sidecar cùng sha bị sửa tay (bỏ nhãn AI, đổi provider)
    KHÔNG được dùng làm metadata — compose ghi lại bản đúng."""
    a = _compose(pk, out)
    side = Path(a["sidecar"])
    forged = {**a["meta"], "labels": [AD],
              "background": {**a["meta"]["background"], "model": "x"}}
    side.write_bytes(json.dumps(forged, ensure_ascii=False).encode("utf-8"))
    b = _compose(pk, out)
    assert b["ok"] is True and b["meta"]["labels"][0] == AI
    assert b["meta"]["background"]["model"] == "none"
    disk = json.loads(side.read_bytes().decode("utf-8"))
    assert disk == b["meta"] and disk["labels"][0] == AI
    side.write_bytes(b"{hong")                       # file hỏng -> ghi lại
    c = _compose(pk, out)
    assert json.loads(side.read_bytes().decode("utf-8")) == c["meta"]


@NEED_FONT
def test_tampered_png_same_name_not_trusted(pk, out):
    """Nghiệm thu v6.2 (A08 nửa còn lại): `<sha>.png` bị ghi đè (ảnh đen,
    giữ tên) — tên không chứng minh nội dung; compose phải ghi lại bản vừa
    kiểm (file đĩa đúng sha, packshot nguyên vẹn)."""
    a = _compose(pk, out)
    png = Path(a["path"])
    for bad in ("black", "junk"):
        if bad == "black":
            Image.new("RGB", (1080, 1080)).save(png, format="PNG")
        else:
            png.write_bytes(b"\x89PNG rac")
        assert _sha(png.read_bytes()) != a["sha256"]
        b = _compose(pk, out)
        assert b["ok"] is True and b["path"] == a["path"]
        assert _sha(png.read_bytes()) == b["sha256"] == a["sha256"]
        with Image.open(png) as im:
            assert ims.verify_packshot(im.convert("RGB"), b["fitted"],
                                       b["packshot_xy"])
    assert _files(out) == sorted([png.name, f"{a['sha256']}.json"])


# ======================= W62.4 save_image + CLI =============================

@NEED_FONT
@pytest.mark.parametrize("prov", ["none", "fake"])
def test_db_save_image_created_then_skipped(db, fake, pk, out, prov):
    gs.load(db, copy.deepcopy(GOLDEN))
    r = _compose(pk, out, provider=prov, scene=SCENE)
    assert r["ok"] is True, r["refused"]
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    s1 = ims.save_image(tx, r, by="agent:mkt03")
    assert s1["status"] == "created" and tx.committed >= 2
    did = s1["draft_id"]
    row = db.execute("select status, content_type, sku, channel, text, "
                     "is_ai, created_by, source, prompt_version, "
                     "prompt_sha256, guardrail->>'ok' from content_drafts "
                     "where id = %s", (did,)).fetchone()
    bg = r["meta"]["background"]
    assert row[:4] == ("pending", "image", HONEY, "facebook")
    assert AI in row[4] and f"{r['sha256']}.png" in row[4]
    assert row[4] == r["draft_text"]
    assert row[5:] == (True, "agent:mkt03", "cli", bg["prompt_version"],
                       bg["prompt_sha256"], "true")
    a = db.execute("select file_sha256, file_name, sku, channel, format, "
                   "ai_generated, label_text, provider, model, "
                   "prompt_sha256, prompt_version, packshot_sha256, "
                   "draft_id, meta, created_by from image_assets").fetchall()
    m = r["meta"]
    assert a == [(r["sha256"], m["file"], HONEY, "facebook", "1:1",
                  prov == "fake", "\n".join(m["labels"]), prov,
                  bg["model"], bg["prompt_sha256"], bg["prompt_version"],
                  r["packshot_sha256"], did, m, "agent:mkt03")]
    s2 = ims.save_image(tx, r, by="agent:mkt03")
    assert s2 == {"status": "skipped", "draft_id": did}
    db.execute("reset role")
    n = db.execute("select (select count(*) from content_drafts), "
                   "(select count(*) from image_assets)").fetchone()
    assert n == (1, 1)
    log = db.execute("select actor, action, object_id from agent_action_log"
                     " where action = 'draft_create'").fetchall()
    assert log == [("agent:mkt03", "draft_create", str(did))]


@NEED_FONT
def test_db_save_image_race_unique_leaves_orphan(db, pk, out):
    gs.load(db, copy.deepcopy(GOLDEN))
    r = _compose(pk, out)
    db.execute("set local role agent_writer")
    tx = _TxConn(db)
    first = ims.save_image(tx, r, by="agent:mkt03")

    class _Miss(_TxConn):
        def execute(self, sql, *a, **kw):
            if sql.startswith("select draft_id from image_assets"):
                return types.SimpleNamespace(fetchone=lambda: None)
            return self.conn.execute(sql, *a, **kw)

    s = ims.save_image(_Miss(db), r, by="agent:mkt03")
    assert s["status"] == "skipped" and s["orphan_draft_id"] != \
        first["draft_id"]
    db.execute("reset role")
    assert db.execute("select count(*) from image_assets").fetchone()[0] == 1
    assert db.execute("select status from content_drafts where id = %s",
                      (s["orphan_draft_id"],)).fetchone()[0] == "pending"


@NEED_FONT
def test_db_same_image_two_channels_two_drafts(db, pk, out):
    """Nghiệm thu v6.2: provider `none` cho ảnh y hệt mọi kênh (cùng sha) —
    kênh thứ 2 từng bị `skipped` câm (không có nháp) và sidecar lật kênh.
    Danh tính asset = (sha, kênh): 2 created, 2 nháp, 2 dòng asset; sidecar
    == meta MỌI dòng; chạy lại cả 2 -> skipped, số dòng không đổi."""
    gs.load(db, copy.deepcopy(GOLDEN))
    rmap = {(HONEY, "facebook"): "TP_THUONG", (HONEY, "shopee"): "TP_THUONG"}
    db.execute("set local role agent_writer")
    tx = _TxConn(db)

    def run():
        res = [_compose(pk, out, channel=ch, readiness=rmap)
               for ch in ("facebook", "shopee")]
        return res, [ims.save_image(tx, r, by="agent:mkt03") for r in res]

    res, st = run()
    assert [s["status"] for s in st] == ["created", "created"]
    assert res[0]["sha256"] == res[1]["sha256"]
    side = Path(res[0]["sidecar"])
    disk = json.loads(side.read_bytes().decode("utf-8"))
    db.execute("reset role")
    rows = db.execute("select a.channel, a.file_sha256, a.meta, d.channel, "
                      "d.status, d.id from image_assets a join "
                      "content_drafts d on d.id = a.draft_id order by a.id"
                      ).fetchall()
    assert [(r[0], r[3], r[4]) for r in rows] == [
        ("facebook", "facebook", "pending"), ("shopee", "shopee", "pending")]
    assert {r[1] for r in rows} == {res[0]["sha256"]}
    assert all(r[2] == disk for r in rows) and "channel" not in disk
    assert [r[5] for r in rows] == [s["draft_id"] for s in st]
    db.execute("set local role agent_writer")
    _, st2 = run()
    assert st2 == [{"status": "skipped", "draft_id": s["draft_id"]}
                   for s in st]
    assert json.loads(side.read_bytes().decode("utf-8")) == disk
    assert _files(out) == sorted([f"{res[0]['sha256']}.png", side.name])
    db.execute("reset role")
    n = db.execute("select (select count(*) from content_drafts), "
                   "(select count(*) from image_assets)").fetchone()
    assert n == (2, 2)


@NEED_FONT
def test_db_same_image_skus_and_same_size_formats(db, tmp_path, monkeypatch,
                                                  out):
    """Nghiệm thu v6.2 vòng 2: danh tính cũ (sha, kênh) bỏ sót SKU — SKU
    thứ 2 có packshot y hệt bị `skipped` không nháp, sidecar lật `sku`.
    Danh tính = (sha, sku, kênh, format): 3 SKU cùng hình (bản sao byte /
    cùng pixel khác bytes) + 1 format trùng cỡ trùng layout -> 4 created,
    4 nháp đúng SKU, 4 dòng; meta MỌI dòng == sidecar; packshot_sha256 của
    từng dòng = sha file của SKU đó; chạy lại -> skipped, đếm không đổi."""
    _tmp_cfg(tmp_path, monkeypatch, lambda d: (
        d["formats"].__setitem__("sq2", d["formats"]["1:1"]),
        d["layout"].__setitem__("sq2", d["layout"]["1:1"])))
    d = tmp_path / "twins"
    shas = _twin_packshots(d)
    gs.load(db, copy.deepcopy(GOLDEN))
    rmap = {(k, "facebook"): "TP_THUONG" for k in shas}
    items = [(TWIN_A, "1:1"), (TWIN_B, "1:1"), (HONEY, "1:1"),
             (TWIN_A, "sq2")]
    db.execute("set local role agent_writer")
    tx = _TxConn(db)

    def run():
        res = [_compose(d, out, sku=k, fmt=f, readiness=rmap)
               for k, f in items]
        assert all(r["ok"] for r in res), [r["refused"] for r in res]
        return res, [ims.save_image(tx, r, by="agent:mkt03") for r in res]

    res, st = run()
    assert [s["status"] for s in st] == ["created"] * 4
    assert len({r["sha256"] for r in res}) == 1
    side = Path(res[0]["sidecar"])
    disk = json.loads(side.read_bytes().decode("utf-8"))
    assert not {"sku", "format", "channel"} & set(disk)
    assert "file_sha256" not in disk["packshot"]
    db.execute("reset role")
    rows = db.execute(
        "select a.sku, a.format, a.channel, a.packshot_sha256, a.meta, "
        "a.file_sha256, d.sku, d.brief, d.status, d.id from image_assets a "
        "join content_drafts d on d.id = a.draft_id order by a.id").fetchall()
    assert [r[:4] for r in rows] == [(k, f, "facebook", shas[k])
                                     for k, f in items]
    assert all(r[4] == disk for r in rows)           # sidecar == meta MỌI dòng
    assert {r[5] for r in rows} == {res[0]["sha256"]}
    assert [r[6:9] for r in rows] == [
        (k, f"image {k} facebook {f}", "pending") for k, f in items]
    assert [r[9] for r in rows] == [s["draft_id"] for s in st]
    db.execute("set local role agent_writer")
    _, st2 = run()
    assert st2 == [{"status": "skipped", "draft_id": s["draft_id"]}
                   for s in st]
    assert json.loads(side.read_bytes().decode("utf-8")) == disk
    assert _files(out) == sorted([f"{res[0]['sha256']}.png", side.name])
    db.execute("reset role")
    n = db.execute("select (select count(*) from content_drafts), "
                   "(select count(*) from image_assets)").fetchone()
    assert n == (4, 4)


def test_save_image_rejects_non_ok():
    for bad in (None, {"ok": False}, {"ok": True, "meta": None}):
        with pytest.raises(ValueError):
            ims.save_image(object(), bad, by="x")
    with pytest.raises(ValueError):
        ims.save_image(object(), {"ok": True, "meta": {}, "sha256": "a"},
                       by=" ")
    with pytest.raises(ValueError, match="channel"):    # thiếu kênh
        ims.save_image(object(), {"ok": True, "meta": {}, "sha256": "a"},
                       by="x")
    full = {"ok": True, "meta": {}, "sha256": "a", "channel": "facebook",
            "sku": HONEY, "format": "1:1", "packshot_sha256": "p"}
    for k in ("sku", "format", "packshot_sha256"):     # ngữ cảnh dòng
        for bad in (None, ""):
            with pytest.raises(ValueError, match=k):
                ims.save_image(object(), {**full, k: bad}, by="x")


class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self, routes=()):
        self.routes, self.calls, self.committed = list(routes), [], 0

    def execute(self, sql, params=None):
        self.calls.append((sql, tuple(params or ())))
        for subs, rows in self.routes:
            if all(s in sql for s in subs):
                return _Cur(rows)
        raise AssertionError(f"no route: {sql!r}")

    @contextmanager
    def transaction(self):
        yield

    def commit(self):
        self.committed += 1


@NEED_FONT
def test_image_draft_approvable_by_human(pk, out):
    """Nháp ảnh duyệt được (re-check guardrail lúc duyệt không ngõ cụt
    thieu_nhan_ai / thieu_nhan_quang_cao)."""
    r = _compose(pk, out)
    base = dict.fromkeys(store.COLS)
    base.update({"id": 7, "brief": "image", "channel": "facebook",
                 "text": r["draft_text"], "guardrail": r["guardrail"],
                 "status": "pending", "source": "cli",
                 "created_by": "agent:mkt03", "content_type": "image",
                 "sku": HONEY, "is_ai": True})
    conn = _Conn([(("from content_drafts", "where id = %s"),
                   [tuple(base[c] for c in store.COLS)]),
                  (("from sku_readiness",), [(HONEY, "facebook",
                                              "TP_THUONG")]),
                  (("select approve_draft(",), [(1,)])])
    assert store.set_status(conn, 7, "approved", "Hoa") == (True, None)
    assert any("approve_draft(" in s for s, _ in conn.calls)


def test_cli_usage_errors_exit_2(capsys):
    for argv in (["--sku", "all", "--channel", "facebook"],
                 ["--sku", "all", "--channel", "chatbot", "--headline", "x"],
                 ["--sku", "all", "--channel", "facebook", "--format", "2:3",
                  "--headline", "x"],
                 ["--channel", "facebook", "--headline", "x"]):
        with pytest.raises(SystemExit) as e:
            ims.main(argv)
        assert e.value.code == 2, argv


def test_cli_unknown_provider_exit_2_before_db(monkeypatch, out, capsys):
    monkeypatch.setenv("IMAGE_PROVIDER", "openai")
    monkeypatch.setenv("IMAGE_OUT_DIR", str(out))
    monkeypatch.setattr(store, "_conn_or_none",
                        lambda: pytest.fail("không được mở DB"))
    assert ims.main(["--sku", "all", "--channel", "facebook",
                     "--headline", "Quà"]) == 2
    assert "external-dep" in capsys.readouterr().err and _files(out) == []


def test_cli_db_down_exit_2_zero_provider_call(monkeypatch, out, capsys):
    calls = []
    monkeypatch.setitem(ims.PROVIDERS, "none",
                        lambda *a: calls.append(a) or pytest.fail("provider"))
    monkeypatch.setenv("IMAGE_OUT_DIR", str(out))

    @contextmanager
    def dead():
        yield None, "không kết nối được Postgres"

    monkeypatch.setattr(store, "_conn_or_none", dead)
    assert ims.main(["--sku", "all", "--channel", "facebook",
                     "--headline", "Quà"]) == 2
    assert calls == [] and "không ghi được" in capsys.readouterr().err
    assert _files(out) == []


def test_cli_lines_and_exit_codes(monkeypatch, capsys):
    @contextmanager
    def fake_conn():
        yield object(), None

    monkeypatch.setattr(store, "_conn_or_none", fake_conn)
    monkeypatch.setattr(store, "readiness_from_db", lambda c: {})
    plan = {"a": {"ok": True, "path": "/x/aa.png"},
            "b": {"ok": True, "path": "/x/bb.png"},
            "c": {"ok": False, "refused": {"code": "ruou",
                                          "reason": "rượu"}},
            "d": {"ok": True, "path": "/x/dd.png"}}
    monkeypatch.setattr(ims, "compose", lambda sku, *a, **k: plan[sku])
    saved = {"a": {"status": "created", "draft_id": 1, "asset_id": 9},
             "b": {"status": "skipped", "draft_id": 2}}

    def save(conn, res, by):
        sku = Path(res["path"]).stem[0]
        if sku == "d":
            raise psycopg.OperationalError("mất kết nối")
        return saved[sku]

    monkeypatch.setattr(ims, "save_image", save)
    assert ims.main(["--sku", "a", "--sku", "b", "--sku", "c",
                     "--channel", "facebook", "--headline", "x"]) == 0
    o = capsys.readouterr().out
    assert "a × facebook × 1:1: created #1 aa.png" in o
    assert "b × facebook × 1:1: skipped bb.png" in o
    assert "c × facebook × 1:1: refused ruou: rượu" in o
    assert "created 1, skipped 1, refused 1, failed 0" in o
    assert ims.main(["--sku", "d", "--channel", "facebook",
                     "--headline", "x"]) == 1
    assert "d × facebook × 1:1: failed: lỗi DB" in capsys.readouterr().out


def test_cli_dead_host_subprocess_exit_2(tmp_path):
    """Gotcha v2.0: host chết thật (KHÔNG `env -u`) — exit 2, 0 file."""
    o = tmp_path / "o"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", OPENROUTER_API_KEY="",
               DATABASE_URL="postgresql://u@10.255.255.1:5432/x",
               IMAGE_OUT_DIR=str(o), PACKSHOT_DIR=str(tmp_path / "p"))
    env.pop("IMAGE_PROVIDER", None)
    r = subprocess.run([sys.executable, "-m", "pipelines.image_studio",
                        "--sku", "all", "--channel", "facebook",
                        "--headline", "Quà tặng núi rừng"],
                       cwd=ROOT, env=env, capture_output=True, timeout=120,
                       encoding="utf-8", errors="replace", check=False)
    assert r.returncode == 2, (r.stdout, r.stderr)
    assert "không ghi được" in r.stderr and r.stdout == ""
    assert _files(o) == []


def test_module_has_no_publish_or_network_path():
    src = (ROOT / "pipelines" / "image_studio.py").read_text(
        encoding="utf-8")
    assert not re.search(r"set_status|approve_draft|schedule|requests|httpx"
                         r"|urllib|import socket|inpaint", src)
    assert "exif=" not in src.split("def make_sample_packshot")[0]
    assert "pnginfo=" not in src.split("def make_sample_packshot")[0]


def test_env_example_and_gitignore():
    env = (ROOT / "env.example").read_text(encoding="utf-8")
    for k in ("IMAGE_PROVIDER=none", "PACKSHOT_DIR=", "IMAGE_OUT_DIR=",
              "IMAGE_FONT="):
        assert k in env, k
    gi = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert "data/image_assets/" in gi and "data/packshots/" in gi
