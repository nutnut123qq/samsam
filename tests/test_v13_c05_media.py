"""v13.4 C05 (F05 phần media) — video vườn gỡ GPS, magic bytes ghi âm,
registry provider OCR/STT/ảnh AI fail-closed, đối chiếu 14 hồ sơ sản phẩm,
hạn lưu CV/chấm công/ảnh/ghi âm.

Video mẫu sinh TẠI CHỖ bằng ffmpeg (imageio-ffmpeg đã có trong requirements)
vào `tmp_path` — không file nào vào repo, không mạng. Provider STT "giả" chỉ
là mock trong test: CHƯA verify với vendor thật (BLOCKED vendor + DPA + key).
DB thật: temp schema + ROLLBACK (`temp_schema_conn`).
"""

import hashlib
import json
import os
import shutil
import subprocess
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
import pytest

from connectors import zalo_garden as zg
from ingest import doc_intake as di

# Cùng đối tượng module mà connectors.zalo_garden dùng (`from scripts
# import garden_media`) — monkeypatch có tác dụng ở cả 2 đường.
from scripts import garden_media as gm
from scripts import retention_purge as rp
from tests.test_garden_chain import _TxConn, temp_schema_conn

ROOT = Path(__file__).resolve().parent.parent
STAFF_UID = "1234567890123456789"
VIDEO_URL = "https://video-1.zdn.vn/v/clip.mp4"
LAT = "+16.0544+108.2022"
LEAKS = (b"\xa9xyz", b"ISO6709", b"location", b"108.2022", b"KV-SECRET")
ADTS = b"\xff\xf1\x50\x80\x02\x1f\xfc" + b"\x00" * 16


def _ff():
    """ffmpeg để SINH video mẫu — độc lập với module đang test."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return shutil.which("ffmpeg")


FF = _ff()
need_ff = pytest.mark.skipif(FF is None, reason="không có ffmpeg")


def _make_video(path: Path, fmt: str, *, audio_only=False) -> bytes:
    """Video 1s 32x32 có metadata vị trí + tiêu đề (tiền điều kiện: nguồn
    PHẢI có dấu GPS, nếu không test 'đã gỡ' pass ảo)."""
    src = ([] if audio_only else
           ["-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=5"])
    src += ["-f", "lavfi", "-i", "sine=duration=1"]
    codec = ["-c:a", "aac"] if audio_only else ["-c:v", "libx264", "-c:a",
                                                 "aac", "-shortest"]
    extra = ["-movflags", "use_metadata_tags"] if fmt == "mov" else []
    r = subprocess.run(
        [FF, "-v", "error", "-y", *src, *codec,
         "-metadata", f"location={LAT}/",
         "-metadata", f"com.apple.quicktime.location.ISO6709={LAT}+010.000/",
         "-metadata", "title=KV-SECRET", *extra, "-f", fmt, str(path)],
        capture_output=True, check=False)
    assert r.returncode == 0, r.stderr[-300:]
    return path.read_bytes()


@pytest.fixture(scope="module")
def mov(tmp_path_factory):
    if FF is None:
        pytest.skip("không có ffmpeg")
    d = tmp_path_factory.mktemp("vid")
    data = _make_video(d / "src.mov", "mov")
    assert any(m in data for m in (b"ISO6709", b"location"))   # tiền đk
    return data


@pytest.fixture(scope="module")
def mp4(tmp_path_factory):
    if FF is None:
        pytest.skip("không có ffmpeg")
    return _make_video(tmp_path_factory.mktemp("vid") / "src.mp4", "mp4")


def _assert_clean(data: bytes):
    for leak in LEAKS:
        assert leak not in data, leak


# ------------------------------------------------------- video: thuần

@need_ff
def test_strip_video_mov_removes_location(mov, tmp_path):
    clean, ext, info = gm.strip_video(mov, tmp_dir=tmp_path / ".tmp")
    assert ext == "mov" and info["had_gps"] is True
    assert info["width"] is None and info["exif_removed"] == 0
    assert gm.video_container(clean) == "mov"
    assert gm.video_has_gps(clean) is False
    _assert_clean(clean)
    assert list((tmp_path / ".tmp").iterdir()) == []   # bản gốc tạm đã xóa


@need_ff
def test_strip_video_mp4_and_m4v(mp4, tmp_path):
    for hint in (".mp4", ".M4V"):
        clean, ext, _ = gm.strip_media(mp4, hint, tmp_dir=tmp_path)
        assert ext == "mp4"
        _assert_clean(clean)


def test_no_ffmpeg_refuses_video(monkeypatch):
    monkeypatch.setattr(gm, "_find_ffmpeg", lambda: None)
    data = b"\x00\x00\x00\x14ftypisom\x00\x00\x02\x00isom" + \
        b"\x00\x00\x00\x08free"
    with pytest.raises(RuntimeError, match="ffmpeg"):
        gm.strip_video(data)


@pytest.mark.parametrize("data", [
    b"", b"\xff\xd8\xff\xe0JFIF" + b"\x00" * 20,          # JPEG đổi đuôi
    b"\x00\x00\x00\x14ftypheic\x00\x00\x00\x00heic",       # brand lạ
    b"\x00\x00\x00\x14ftypisom\x00\x00\x02\x00isom\x00\x00\x00\xffmoov",
    b"\x00\x00\x00\x01ftypisom",                           # hộp cụt
])
def test_video_magic_and_structure_rejected(data):
    with pytest.raises(ValueError):
        gm.strip_video(data)


def test_video_oversize_rejected(monkeypatch):
    monkeypatch.setattr(gm, "MAX_VIDEO_BYTES", 10)
    with pytest.raises(ValueError, match="MB"):
        gm.strip_video(b"\x00" * 11)


@need_ff
def test_extension_must_match_container(mov, mp4, tmp_path):
    with pytest.raises(ValueError, match="không khớp"):
        gm.strip_media(mov, ".mp4", tmp_dir=tmp_path)
    with pytest.raises(ValueError, match="không khớp"):
        gm.strip_media(mp4, ".mov", tmp_dir=tmp_path)
    with pytest.raises(ValueError):          # video không vào Pillow
        gm.strip_media(mp4, ".jpg", tmp_dir=tmp_path)


@need_ff
def test_video_without_picture_stream_rejected(tmp_path):
    audio = _make_video(tmp_path / "a.mp4", "mp4", audio_only=True)
    with pytest.raises(ValueError, match="luồng hình"):
        gm.strip_video(audio, tmp_dir=tmp_path / ".tmp")


@need_ff
def test_location_surviving_remux_is_rejected(mov, monkeypatch, tmp_path):
    """Phòng thủ chiều sâu: ffmpeg (bản lạ/cờ đổi) giữ lại metadata → quét
    sau remux phải chặn, không lưu."""
    real = subprocess.run

    def keep_meta(cmd, **kw):
        if cmd[0] == FF and "-map_metadata" in cmd:
            Path(cmd[-1]).write_bytes(Path(cmd[cmd.index("-i") + 1])
                                      .read_bytes())
            return subprocess.CompletedProcess(cmd, 0, b"", b"")
        return real(cmd, **kw)
    monkeypatch.setattr(gm.subprocess, "run", keep_meta)
    with pytest.raises(ValueError, match="vị trí"):
        gm.strip_video(mov, tmp_dir=tmp_path)


# ------------------------------------------------------- video: CLI + DB

@pytest.fixture
def db():
    yield from temp_schema_conn()


def _plot(db, pid="KV-T01"):
    db.execute("insert into plots (id, location, source) values (%s,"
               " 'Trà My', 'manual')", (pid,))


def _files(d: Path):
    return sorted(p for p in d.rglob("*") if p.is_file()) if d.exists() \
        else []


@need_ff
def test_cli_video_end_to_end(db, mov, tmp_path, monkeypatch, capsys):
    _plot(db)
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    src = tmp_path / "IMG_0001_GPS.MOV"
    src.write_bytes(mov)
    store = tmp_path / "store"
    argv = ["--file", str(src), "--plot", "KV-T01", "--date", "2026-10-12",
            "--by", "Bé Na", "--store", str(store)]
    assert gm.main(argv) == 0
    out = capsys.readouterr().out
    assert "video mov đã gỡ metadata, có GPS: có" in out
    for leak in ("108.2022", "IMG_0001", str(tmp_path), "Bé Na"):
        assert leak not in out
    files = _files(store)
    assert len(files) == 1 and files[0].suffix == ".mov"
    _assert_clean(files[0].read_bytes())
    sha, ext, w, h, gps, nbytes = db.execute(
        "select sha256, ext, width, height, had_gps, bytes from garden_media"
    ).fetchone()
    assert (ext, w, h, gps) == ("mov", None, None, True)
    assert files[0].name == f"{sha}.mov" and nbytes == len(
        files[0].read_bytes())
    assert hashlib.sha256(files[0].read_bytes()).hexdigest() == sha


def test_cli_video_no_ffmpeg_no_file_no_row(db, tmp_path, monkeypatch,
                                            capsys):
    _plot(db)
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    monkeypatch.setattr(gm, "_find_ffmpeg", lambda: None)
    src = tmp_path / "clip.mp4"
    src.write_bytes(b"\x00\x00\x00\x14ftypisom\x00\x00\x02\x00isom"
                    b"\x00\x00\x00\x08free")
    store = tmp_path / "store"
    assert gm.main(["--file", str(src), "--plot", "KV-T01", "--date",
                    "2026-10-12", "--by", "A", "--store", str(store)]) == 1
    assert "ffmpeg" in capsys.readouterr().err
    assert _files(store) == []
    assert db.execute("select count(*) from garden_media").fetchone()[0] == 0


def test_cli_file_must_be_regular(db, tmp_path, monkeypatch, capsys):
    _plot(db)
    monkeypatch.setattr(gm, "connect", lambda *a, **kw: _TxConn(db))
    d = tmp_path / "thu_muc.mp4"
    d.mkdir()
    assert gm.main(["--file", str(d), "--plot", "KV-T01", "--date",
                    "2026-10-12", "--by", "A", "--store",
                    str(tmp_path / "s")]) == 1
    assert "file thường" in capsys.readouterr().err


def test_schema_garden_media_ext_allows_video_only(db):
    _plot(db)
    for i, ext in enumerate(("mp4", "mov", "jpg", "png")):
        db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
                   " taken_on, author) values (%s, %s, 1, 'KV-T01',"
                   " '2026-10-12', 'a')", (f"{i:064x}", ext))
    for ext in ("gif", "exe", "m4v"):
        with pytest.raises(psycopg.errors.CheckViolation), \
                db.transaction():
            db.execute("insert into garden_media (sha256, ext, bytes,"
                       " plot_id, taken_on, author) values (%s, %s, 1,"
                       " 'KV-T01', '2026-10-12', 'a')", ("f" * 64, ext))


# ------------------------------------------------------- Zalo vườn

@pytest.fixture
def zconn(db, monkeypatch, tmp_path):
    monkeypatch.setattr(zg, "STAFF_FILE", tmp_path / "garden_staff.json")
    monkeypatch.setattr(zg, "_staff", (None, {}))
    monkeypatch.setattr(zg, "_last_plot", {})
    monkeypatch.delenv("GARDEN_STT_PROVIDER", raising=False)
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    zg.STAFF_FILE.write_text(json.dumps({"staff": [
        {"user_hash": zg.uhash(STAFF_UID), "ma_nv": "VT01"}]}),
        encoding="utf-8")
    _plot(db)
    monkeypatch.setattr(zg, "_connect", lambda: _TxConn(db))
    return db


def _run(event, msg):
    sent = []
    r = zg.handle(STAFF_UID, event, msg, "m1",
                  send=lambda u, t: sent.append((u, t)) or True)
    assert sent == [(STAFF_UID, r["text"])]
    return r["text"]


def _video(text=None):
    m = {"attachments": [{"type": "video", "payload": {"url": VIDEO_URL}}]}
    if text is not None:
        m["text"] = text
    return m


@need_ff
def test_zalo_video_stored_clean(zconn, mov, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(zg, "_fetch", lambda u, mx=None, *a, **k:
                        calls.append((u, mx)) or mov)
    monkeypatch.setattr(gm, "strip_image",
                        lambda *a, **k: pytest.fail("video vào nhánh ảnh"))
    out = _run("user_send_video", _video("KV-T01 vườn sau mưa"))
    assert out.startswith("Đã lưu 1/1 video cho khoảnh KV-T01")
    assert calls == [(VIDEO_URL, gm.MAX_VIDEO_BYTES)]
    sha, ext, src, author = zconn.execute(
        "select sha256, ext, source, author from garden_media").fetchone()
    assert (ext, src, author) == ("mov", "zalo:garden", "zalo:VT01")
    f = tmp_path / "kho" / sha[:2] / f"{sha}.mov"
    _assert_clean(f.read_bytes())
    assert list((tmp_path / "kho" / ".tmp").iterdir()) == []


def test_zalo_video_needs_plot(zconn, monkeypatch):
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: pytest.fail("tải"))
    assert _run("user_send_video", _video()) == zg.NEED_PLOT


@pytest.mark.parametrize("payload", ["jpeg", "no_ffmpeg"])
def test_zalo_video_rejected_not_saved(zconn, monkeypatch, payload):
    if payload == "no_ffmpeg":
        monkeypatch.setattr(gm, "_find_ffmpeg", lambda: None)
        data = (b"\x00\x00\x00\x14ftypisom\x00\x00\x02\x00isom"
                b"\x00\x00\x00\x08free")
    else:
        data = b"\xff\xd8\xff\xe0JFIF" + b"\x00" * 30
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: data)
    out = _run("user_send_video", _video("KV-T01"))
    assert out.startswith("CHƯA lưu được tệp")
    assert zconn.execute("select count(*) from garden_media"
                         ).fetchone()[0] == 0


def test_zalo_audio_without_magic_not_saved(zconn, monkeypatch, tmp_path):
    """Trước v13.4 mọi bytes đều lưu (đuôi theo URL, lạ → 'bin')."""
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: b"MZ\x90\x00PE-exe")
    msg = {"attachments": [{"type": "audio", "payload": {
        "url": "https://voice-2.zadn.vn/v/x.aac"}}]}
    assert _run("user_send_audio", msg).startswith("CHƯA lưu được tệp")
    assert zconn.execute("select count(*) from garden_voice_drafts"
                         ).fetchone()[0] == 0
    assert not (tmp_path / "kho" / "audio").exists()


def test_zalo_audio_ext_from_content_not_url(zconn, monkeypatch):
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: ADTS)
    msg = {"attachments": [{"type": "voice", "payload": {
        "url": "https://voice-2.zadn.vn/v/x.mp3"}}]}
    _run("user_send_voice", msg)
    assert zconn.execute("select ext from garden_voice_drafts"
                         ).fetchone()[0] == "aac"


# ------------------------------------------------------- STT registry

def test_transcribe_without_provider_exit2_no_connect(monkeypatch, capsys):
    monkeypatch.setattr(zg, "_connect", lambda: pytest.fail("connect"))
    for env in ("", "fpt-stt"):
        monkeypatch.setenv("GARDEN_STT_PROVIDER", env)
        assert zg.main(["--transcribe", "1"]) == 2
        err = capsys.readouterr().err
        assert "[blocked]" in err and "DPA" in err


def test_transcribe_foreign_provider_refused(monkeypatch, capsys):
    monkeypatch.setattr(zg, "_connect", lambda: pytest.fail("connect"))
    monkeypatch.setitem(zg.STT_PROVIDERS, "foreign",
                        (lambda p: pytest.fail("gửi audio"), False))
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "foreign")
    assert zg.main(["--transcribe", "1"]) == 2
    assert "nước ngoài" in capsys.readouterr().err


def test_transcribe_mock_provider_prints_masked_draft(zconn, monkeypatch,
                                                      tmp_path, capsys):
    """CHỈ MOCK — chứng minh đường cắm (đọc đúng file theo sha, che PII, không
    đóng nháp); chưa verify với vendor STT thật."""
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: ADTS)
    _run("user_send_voice", {"text": "KV-T01", "attachments": [
        {"type": "voice", "payload": {"url": "https://zdn.vn/a.aac"}}]})
    did, sha = zconn.execute("select id, sha256 from garden_voice_drafts"
                             ).fetchone()
    seen = []
    monkeypatch.setitem(zg.STT_PROVIDERS, "mock_vn", (
        lambda p: seen.append(Path(p).read_bytes())
        or "KV-T01 tưới 30 phút, gọi 0905123456", True))
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "mock_vn")
    assert zg.main(["--transcribe", str(did)]) == 0
    out = capsys.readouterr().out
    assert seen == [ADTS] and "tưới 30 phút" in out
    assert "0905123456" not in out and "NHÁP" in out
    assert zconn.execute("select status from garden_voice_drafts"
                         ).fetchone()[0] == "cho_chep_loi"
    # file bị tráo → từ chối
    (tmp_path / "kho" / "audio" / sha[:2] / f"{sha}.aac").write_bytes(b"x")
    assert zg.main(["--transcribe", str(did)]) == 1


# ------------------------------------------------------- OCR (doc_intake)

@pytest.fixture
def intake_cli(monkeypatch, tmp_path):
    class Conn:
        def __init__(self):
            self.docs = {}

        def execute(self, sql, params=None):
            class R:
                rowcount = 1

                def fetchone(self_inner):
                    return None
            if sql.startswith("insert into documents"):
                self.docs[params[0]] = params[-1]
            return R()

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            pass
    conn = Conn()
    monkeypatch.setattr(di.lead_store, "connect", lambda: conn)
    monkeypatch.setattr(di, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("DOC_INTAKE_DIR", str(tmp_path / "in"))
    monkeypatch.setenv("DOC_ORIGINALS_DIR", str(tmp_path / "orig"))
    monkeypatch.delenv("OCR_PROVIDER", raising=False)
    return conn


def test_intake_scan_without_ocr_exit2_blocked(intake_cli, tmp_path, capsys):
    """Trước v13.4: ảnh vào cho_ocr nhưng CLI exit 0 như đã xong."""
    d = tmp_path / "in" / "nhan"
    d.mkdir(parents=True)
    (d / "nhan.jpg").write_bytes(b"\xff\xd8\xff\xe0 anh nhan")
    assert di.main([]) == 2
    out = capsys.readouterr().out
    assert "cho_ocr=1" in out and "[blocked]" in out and "DPA" in out
    assert list(intake_cli.docs.values()) == ["cho_ocr"]


def test_foreign_ocr_provider_refused(monkeypatch, tmp_path):
    monkeypatch.setitem(di.PROVIDERS, "gvision",
                        (lambda p: pytest.fail("gửi ảnh"), False))
    with pytest.raises(ValueError, match="nước ngoài"):
        di.intake(tmp_path, tmp_path / "o", object(), "gvision")
    monkeypatch.setenv("OCR_PROVIDER", "gvision")
    monkeypatch.setattr(di.lead_store, "connect",
                        lambda: pytest.fail("connect"))
    monkeypatch.setattr(di, "load_dotenv", lambda *a, **k: None)
    with pytest.raises(SystemExit) as e:
        di.main([])
    assert e.value.code == 2


# ------------------------------------------------------- ảnh nền AI

def test_scene_without_ai_provider_exit2_before_db(monkeypatch, capsys):
    from pipelines import image_studio as ims
    monkeypatch.delenv("IMAGE_PROVIDER", raising=False)
    monkeypatch.setattr(ims.store, "_conn_or_none",
                        lambda *a, **k: pytest.fail("connect"))
    rc = ims.main(["--sku", "mat-ong-sam-300ml", "--channel",
                   ims.load_config()[0]["channels"][0], "--headline", "Quà",
                   "--scene", "bàn gỗ, lá sâm"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "[blocked]" in err and "IMAGE_PROVIDER" in err


# ------------------------------------------------------- 14 hồ sơ

def test_product_dossiers_map_golden_one_to_one():
    dos = json.loads((ROOT / "data" / "product_dossiers.json").read_bytes())
    gold = json.loads((ROOT / "data" / "golden_skus.json").read_bytes())
    gmap = {s["sku_key"]: s for s in gold["skus"]}
    keys = [r["sku_key"] for r in dos["sku"]]
    assert len(keys) == len(set(keys)) == len(gmap) == dos["so_sku_golden"]
    assert set(keys) == set(gmap)            # không thêm/bớt/nhân bản SKU
    assert dos["so_ho_so_hop_dong"] == 14 and dos["so_sku_golden"] != 14
    for r in dos["sku"]:
        assert r["so_cong_bo"] == gmap[r["sku_key"]]["receipt_no"]
        assert r["trang_thai"] == "chua_xac_nhan"
        assert r["ho_so_goc"] is None        # chưa có danh mục Bên B
    assert dos["trang_thai_doi_chieu"] == "chua_xac_nhan"
    assert dos["danh_muc_ho_so_goc"] == [] and "Bên B" in dos["blocker"]
    assert dos["nguon"].startswith("PL01")


# ------------------------------------------------------- hạn lưu

def test_shipped_retention_config_valid_no_invented_ttl():
    items = rp.load_config()
    ids = {it["id"] for it in items}
    assert {"hr_cv", "hr_attendance", "garden_media", "garden_voice"} <= ids
    for it in items:
        assert it.get("owner")
        # Không bịa TTL: số ngày chỉ do người có thẩm quyền điền. Khi
        # có người chốt thật, đổi assert này kèm bằng chứng quyết định.
        assert it["ttl_days"] is None, it["id"]


@pytest.mark.parametrize("bad", [
    {"muc": []}, {"muc": [{"id": "a", "ttl_days": 0, "kho": {
        "loai": "khong_luu_ban_sao"}}]},
    {"muc": [{"id": "a", "ttl_days": True, "kho": {
        "loai": "khong_luu_ban_sao"}}]},
    {"muc": [{"id": "a", "ttl_days": "30", "kho": {
        "loai": "khong_luu_ban_sao"}}]},
    {"muc": [{"id": "a", "ttl_days": None, "kho": {"loai": "x"}}]},
    {"muc": [{"id": "a", "ttl_days": 5, "kho": {"loai": "thu_muc",
                                                "env": "E"}}]},
    {"muc": [{"id": "a", "ttl_days": None, "kho": {
        "loai": "khong_luu_ban_sao"}}, {"id": "a", "ttl_days": None,
                                       "kho": {"loai": "khong_luu_ban_sao"}}]},
])
def test_retention_config_rejects(tmp_path, bad):
    p = tmp_path / "r.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(rp.RetentionError):
        rp.load_config(p)


def test_retention_all_null_deletes_nothing_no_db(monkeypatch, capsys):
    monkeypatch.setattr(rp, "connect", lambda: pytest.fail("connect"))
    assert rp.main([]) == 0
    out = capsys.readouterr().out
    assert out.count("CHƯA CHỐT") == 4 and "[blocked]" in out


def test_retention_bad_config_exit2(monkeypatch, tmp_path):
    p = tmp_path / "r.json"
    p.write_text("{", encoding="utf-8")
    monkeypatch.setattr(rp, "CONFIG", p)
    monkeypatch.setattr(rp, "connect", lambda: pytest.fail("connect"))
    assert rp.main([]) == 2


def test_health_bulletin_warns_unset_ttl():
    from scripts import health_bulletin as hb
    md = hb.render({"db_ok": False, "db_error": "x"}, date(2026, 10, 15))
    sec = md[md.index(hb.H_RETENTION):]
    for iid in ("hr_cv", "hr_attendance", "garden_media", "garden_voice"):
        assert f"`{iid}`" in sec
    assert sec.count("CHƯA CHỐT") == 4
    md2 = hb.render({"db_ok": False, "db_error": "x"}, date(2026, 10, 15),
                    retention=["- LỖI cấu hình hạn lưu (x)"])
    assert "LỖI cấu hình hạn lưu" in md2


def _old(p: Path, days: int):
    t = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
    os.utime(p, (t, t))


def _items(ttl=30):
    return {it["id"]: {**it, "ttl_days": ttl} for it in rp.load_config()}


def test_purge_cv_dir_logs_before_delete(db, tmp_path, monkeypatch):
    inbox = tmp_path / "hr"
    (inbox / "sub").mkdir(parents=True)
    old, new = inbox / "a.txt", inbox / "b.md"
    for f in (old, new, inbox / "c.pdf", inbox / "sub" / "d.txt"):
        f.write_text("CV Nguyễn Văn Mẫu 0905123456", encoding="utf-8")
    for f in (old, inbox / "c.pdf", inbox / "sub" / "d.txt"):
        _old(f, 40)
    monkeypatch.setenv("HR_INBOX_DIR", str(inbox))
    tx = _TxConn(db)
    now = datetime.now(timezone.utc)
    it = _items()["hr_cv"]
    assert rp.purge_item(tx, it, now, dry_run=True)["n"] == 1
    assert old.exists()
    r = rp.purge_item(tx, it, now, dry_run=False)
    assert (r["n"], r["deleted"], r["failed"]) == (1, 1, 0)
    assert not old.exists() and new.exists()
    assert (inbox / "c.pdf").exists() and (inbox / "sub" / "d.txt").exists()
    act, oid, detail = db.execute(
        "select action, object_id, detail from agent_action_log"
        " where actor = %s", (rp.ACTOR,)).fetchone()
    assert (act, oid, detail["n"], detail["ttl_days"]) == (
        "retention_purge", "hr_cv", 1, 30)
    blob = json.dumps(detail, ensure_ascii=False)
    assert "a.txt" not in blob and "Nguyễn" not in blob


def test_purge_log_failure_deletes_nothing(db, tmp_path, monkeypatch):
    inbox = tmp_path / "hr"
    inbox.mkdir()
    f = inbox / "a.txt"
    f.write_text("cv", encoding="utf-8")
    _old(f, 40)
    monkeypatch.setenv("HR_INBOX_DIR", str(inbox))

    def boom(*a, **k):
        raise psycopg.errors.InsufficientPrivilege("no")
    monkeypatch.setattr(rp, "_log", boom)
    with pytest.raises(psycopg.Error):
        rp.purge_item(_TxConn(db), _items()["hr_cv"],
                      datetime.now(timezone.utc), dry_run=False)
    assert f.exists()


def test_purge_store_inside_repo_refused(db, monkeypatch):
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(ROOT / "data"))
    with pytest.raises(rp.RetentionError, match="trong repo"):
        rp.purge_item(_TxConn(db), _items()["garden_media"],
                      datetime.now(timezone.utc), dry_run=True)


def test_purge_garden_media_keeps_qr_linked_and_recent(db, tmp_path,
                                                       monkeypatch):
    _plot(db)
    store = tmp_path / "kho"
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    shas = {}
    for name, age in (("old", 40), ("linked", 40), ("new", 1)):
        sha, _ = gm.store(name.encode(), "jpg", store)
        shas[name] = sha
        db.execute("insert into garden_media (sha256, ext, bytes, plot_id,"
                   " taken_on, author, created_at) values (%s, 'jpg', 3,"
                   " 'KV-T01', '2026-09-01', 'a', now() - %s * interval"
                   " '1 day')", (sha, age))
    db.execute("insert into production_lots (lot_code, sku_key, mfg_date,"
               " exp_date, qty, source) values ('LOT-01', 'x',"
               " '2026-09-01', '2027-09-01', 1, 'manual')")
    lid = db.execute("insert into plot_logs (plot_id, ts, activity, source)"
                     " values ('KV-T01', now(), 'thu hoạch', 'manual')"
                     " returning id").fetchone()[0]
    db.execute("insert into lot_origins (lot_code, plot_log_id,"
               " media_sha256, linked_by) values ('LOT-01', %s, %s, 'A')",
               (lid, [shas["linked"]]))
    r = rp.purge_item(_TxConn(db), _items()["garden_media"],
                      datetime.now(timezone.utc), dry_run=False)
    assert (r["n"], r["deleted"]) == (1, 1)
    left = {p.stem for p in _files(store)}
    assert left == {shas["linked"], shas["new"]}
    # metadata giữ nguyên (không PII) — khoảnh vẫn được giữ như cũ
    assert db.execute("select count(*) from garden_media").fetchone()[0] == 3


def test_purge_voice_only_transcribed(db, tmp_path, monkeypatch):
    _plot(db)
    store = tmp_path / "kho"
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    lid = db.execute("insert into plot_logs (plot_id, ts, activity, source)"
                     " values ('KV-T01', now(), 'tưới', 'manual')"
                     " returning id").fetchone()[0]
    rows = {}
    for name, done in (("da", True), ("chua", False)):
        sha, _ = gm.store(ADTS + name.encode(), "aac", store / "audio")
        rows[name] = sha
        db.execute(
            "insert into garden_voice_drafts (sha256, ext, bytes, staff_code,"
            " status, plot_log_id, closed_by, closed_at, received_at)"
            " values (%s, 'aac', 5, 'VT01', %s, %s, %s, %s,"
            " now() - interval '40 days')",
            (sha, "da_chep_loi" if done else "cho_chep_loi",
             lid if done else None, "A" if done else None,
             datetime.now(timezone.utc) if done else None))
    r = rp.purge_item(_TxConn(db), _items()["garden_voice"],
                      datetime.now(timezone.utc), dry_run=False)
    assert (r["deleted"], r["pending_voice"]) == (1, 1)
    assert {p.stem for p in _files(store / "audio")} == {rows["chua"]}
