"""v12.4 — nhật ký vườn qua Zalo (`connectors/zalo_garden.py`): allowlist
nhân viên (fail-closed), parse chữ, tải tệp CDN Zalo, ghi `plot_logs` (hash
chain) / `garden_media` / `garden_voice_drafts`, CLI nháp ghi âm.

DB thật: temp schema trong 1 transaction rồi ROLLBACK (`temp_schema_conn` của
test_garden_chain) — không ghi gì lên schema public. Không gọi mạng thật:
`_fetch` monkeypatch, `httpx.MockTransport` cho test tải.
"""

import ast
import io
import json
import os
import time
from pathlib import Path

import httpx
import pytest

from connectors import zalo
from connectors import zalo_garden as zg
from tests.test_garden_chain import _TxConn, temp_schema_conn

ROOT = Path(__file__).resolve().parent.parent
STAFF_UID = "1234567890123456789"
CDN = "https://photo-1.zdn.vn/a/b.jpg"
AUDIO = "https://voice-2.zadn.vn/v/x.aac"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(zg, "STAFF_FILE", tmp_path / "garden_staff.json")
    monkeypatch.setattr(zg, "_staff", (None, {}))
    monkeypatch.setattr(zg, "_last_plot", {})
    monkeypatch.delenv("GARDEN_MEDIA_DIR", raising=False)
    monkeypatch.delenv("GARDEN_STT_PROVIDER", raising=False)


def _staff(tmp_path, rows=None, raw=None):
    p = zg.STAFF_FILE
    if raw is not None:
        p.write_bytes(raw)
    else:
        rows = rows if rows is not None else [
            {"user_hash": zg.uhash(STAFF_UID), "ma_nv": "VT01"}]
        p.write_text(json.dumps({"_doc": "x", "staff": rows}),
                     encoding="utf-8")
    return p


@pytest.fixture
def db():
    yield from temp_schema_conn()


@pytest.fixture
def conn(db, monkeypatch, tmp_path):
    """DB temp schema + 1 khoảnh + nhân viên VT01; `_connect` trả _TxConn."""
    db.execute("insert into plots (id, location, source) values "
               "('KV-T01', 'Trà My', 'manual')")
    _staff(tmp_path)
    tx = _TxConn(db)
    monkeypatch.setattr(zg, "_connect", lambda: tx)
    return db


def _run(event, msg):
    sent = []
    r = zg.handle(STAFF_UID, event, msg, "m1",
                  send=lambda u, t: sent.append((u, t)) or True)
    assert sent == [(STAFF_UID, r["text"])] and r["sent"] is True
    return r["text"]


# ------------------------------------------------------------- allowlist

def test_uhash_same_as_zalo():
    assert zg.uhash("abc") == zalo._uhash("abc")


def test_module_does_not_import_zalo():
    """`python -m connectors.zalo` + import connectors.zalo = 2 bản module."""
    tree = ast.parse((ROOT / "connectors" / "zalo_garden.py")
                     .read_text(encoding="utf-8"))
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            names |= {a.name for a in n.names}
        elif isinstance(n, ast.ImportFrom):
            names |= {f"{n.module}.{a.name}" for a in n.names}
            names.add(n.module or "")
    assert not any(x == "connectors.zalo" or x.startswith("connectors.zalo.")
                   for x in names), names


def test_staff_missing_file_none():
    assert zg.staff_code(STAFF_UID) is None


def test_staff_valid_and_reload(tmp_path):
    p = _staff(tmp_path)
    assert zg.staff_code(STAFF_UID) == "VT01"
    assert zg.staff_code("khac") is None
    assert zg.staff_code("") is None
    # Đổi nội dung (size khác) → nạp lại, không giữ cache cũ.
    p.write_text(json.dumps({"staff": [
        {"user_hash": zg.uhash(STAFF_UID), "ma_nv": "VT-02-MOI"}]}),
        encoding="utf-8")
    os.utime(p, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
    assert zg.staff_code(STAFF_UID) == "VT-02-MOI"
    p.unlink()
    assert zg.staff_code(STAFF_UID) is None


@pytest.mark.parametrize("raw", [
    b"{", b"[]", b'{"_doc": "x"}', b'{"staff": {}}', b"\xff\xfe",
    json.dumps({"staff": [{"user_hash": "ABC", "ma_nv": "x"}]}).encode(),
    json.dumps({"staff": [{"user_hash": "0" * 16, "ma_nv": " "}]}).encode(),
    json.dumps({"staff": [{"user_hash": "0" * 16, "ma_nv": "x" * 33}]})
    .encode(),
    json.dumps({"staff": ["0" * 16]}).encode(),
], ids=["json-hong", "mang", "chi-doc", "staff-dict", "byte-loi",
        "hash-sai", "ma-rong", "ma-dai", "dong-chuoi"])
def test_staff_bad_file_fail_closed(tmp_path, raw, capsys):
    _staff(tmp_path, raw=raw)
    assert zg.staff_code(STAFF_UID) is None
    assert "không ai được nhận" in capsys.readouterr().out


def test_staff_one_bad_row_drops_whole_file(tmp_path):
    _staff(tmp_path, rows=[
        {"user_hash": zg.uhash(STAFF_UID), "ma_nv": "VT01"},
        {"user_hash": "khong-phai-hex", "ma_nv": "VT02"}])
    assert zg.staff_code(STAFF_UID) is None


def test_sample_file_valid(monkeypatch):
    monkeypatch.setattr(zg, "STAFF_FILE",
                        ROOT / "data" / "garden_staff.sample.json")
    assert zg.staff_code("0000000000000000000") == "VT-MAU-01"


# ------------------------------------------------------------- parse_text

@pytest.mark.parametrize("text,want", [
    ("KV-A01 tưới 30 phút", ("KV-A01", "tưới", "30 phút")),
    ("kv-a01 Kiểm tra sâu bệnh lá vàng",
     ("kv-a01", "kiểm tra sâu bệnh", "lá vàng")),
    ("KV-A01 kiem tra sau benh", ("KV-A01", "kiểm tra sâu bệnh", None)),
    ("KV-A01 bón phân NPK", ("KV-A01", "bón", "NPK")),
    ("KV-A01 phun thuốc sinh học 2 lít", ("KV-A01", "phun thuốc sinh học",
                                          "2 lít")),
    ("KV-A01   thu   hoach  ", ("KV-A01", "thu hoạch", None)),
    # 'có' (có dấu) KHÔNG được thành 'làm cỏ' qua alias 'co'
    ("KV-A01 có rệp trên lá", ("KV-A01", "ghi nhận", "có rệp trên lá")),
    ("KV-A01 co sau", ("KV-A01", "ghi nhận", "co sau")),
    ("KV-A01 làm cỏ", ("KV-A01", "làm cỏ", None)),
    ("KV-A01 tuới sai dấu", ("KV-A01", "ghi nhận", "tuới sai dấu")),
    # bàn phím gửi NFD vẫn khớp
    ("KV-A01 tưới", ("KV-A01", "tưới", None)),
], ids=["co-ban", "4-tu-hoa", "khong-dau", "alias-2-tu", "phun",
        "khoang-trang", "co-dau-mo-ho", "co-khong-dau", "lam-co",
        "sai-dau", "nfd"])
def test_parse_text(text, want):
    assert zg.parse_text(text) == want


@pytest.mark.parametrize("text", ["", "   ", "KV-A01", "@@ tưới",
                                  "x" * 33 + " tưới", None])
def test_parse_text_rejects(text):
    assert zg.parse_text(text) is None


# ------------------------------------------------------------- _fetch

def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler),
                        follow_redirects=False)


@pytest.mark.parametrize("url", [
    "http://photo.zdn.vn/a.jpg", "https://evil.com/a.jpg",
    "https://zdn.vn.evil.com/a.jpg", "https://zdn.vn@evil.com/a.jpg",
    "https://evilzdn.vn/a.jpg", "ftp://zdn.vn/a", "", "khong-phai-url"])
def test_fetch_rejects_non_zalo_host(url):
    called = []
    with pytest.raises(ValueError, match="CDN Zalo"):
        zg._fetch(url, client=_client(lambda r: called.append(1)))
    assert not called


def test_fetch_ok_and_limits():
    c = _client(lambda r: httpx.Response(200, content=b"abc"))
    assert zg._fetch(CDN, client=c) == b"abc"
    assert zg._fetch("https://zdn.vn/x", client=c) == b"abc"
    with pytest.raises(ValueError, match="quá lớn"):   # stream vượt trần
        zg._fetch(CDN, 2, client=c)
    big = _client(lambda r: httpx.Response(
        200, headers={"content-length": "999"}, content=b"x"))
    with pytest.raises(ValueError, match="quá lớn"):   # CL khai vượt trần
        zg._fetch(CDN, 10, client=big)
    with pytest.raises(ValueError, match="rỗng"):
        zg._fetch(CDN, client=_client(lambda r: httpx.Response(200)))
    for code in (302, 404, 500):
        with pytest.raises(ValueError, match=f"HTTP {code}"):
            zg._fetch(CDN, client=_client(
                lambda r, code=code: httpx.Response(
                    code, headers={"location": "https://evil.com/"})))


def test_fetch_network_error_wrapped():
    def boom(r):
        raise httpx.ConnectError("x")
    with pytest.raises(ValueError, match="ConnectError"):
        zg._fetch(CDN, client=_client(boom))


# v13.4: đuôi ghi âm lấy theo MAGIC BYTES, không theo URL (trước đây
# `_audio_ext(url)` nhận mọi nội dung, đuôi lạ → 'bin' vẫn lưu vào kho).
ADTS = b"\xff\xf1\x50\x80\x02\x1f\xfc" + b"\x00" * 16


@pytest.mark.parametrize("data, want", [
    (ADTS, "aac"), (b"\x00\x00\x00\x20ftypM4A \x00\x00", "m4a"),
    (b"ID3\x04\x00" + b"\x00" * 8, "mp3"), (b"\xff\xfb\x90\x00", "mp3"),
    (b"#!AMR\n\x3c", "amr"), (b"RIFF\x24\x00\x00\x00WAVEfmt ", "wav"),
    (b"OggS\x00\x02", "ogg")])
def test_audio_kind_magic(data, want):
    assert zg.audio_kind(data) == want


@pytest.mark.parametrize("data", [b"AUDIO-BYTES", b"MZ\x90\x00exe", b"",
                                  b"\xff", b"\xff\xd8\xff\xe0JFIF",
                                  b"<html>"])
def test_audio_kind_rejects_non_audio(data):
    with pytest.raises(ValueError):
        zg.audio_kind(data)


def test_store_dir(monkeypatch, tmp_path):
    assert zg._store_dir() is None
    monkeypatch.setenv("GARDEN_MEDIA_DIR", "   ")
    assert zg._store_dir() is None
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(ROOT / "data" / "x"))
    assert zg._store_dir() is None
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    assert zg._store_dir() == (tmp_path / "kho").resolve()


# ------------------------------------------------------------- chữ → plot_logs

def test_text_writes_chained_log(conn, capsys):
    out = _run("user_send_text",
               {"text": "kv-t01 tưới 30 phút, gọi 0912345678 nếu cần"})
    assert out.startswith("Đã ghi nhật ký #") and "KV-T01 — tưới" in out
    row = conn.execute(
        "select plot_id, activity, detail, author, source, row_hash "
        "from plot_logs where source = 'zalo:garden'").fetchone()
    assert row[:2] == ("KV-T01", "tưới")
    assert "0912345678" not in row[2] and "30 phút" in row[2]
    assert row[3:5] == ("zalo:VT01", "zalo:garden")
    assert row[5] and len(row[5]) == 64         # vào hash chain
    assert conn.execute("select * from verify_plot_logs()").fetchall() == []
    assert zg._recent_plot(zg.uhash(STAFF_UID)) == "KV-T01"
    printed = capsys.readouterr().out
    assert STAFF_UID not in printed and "uh=" in printed


def test_text_detail_capped(conn):
    _run("user_send_text", {"text": "KV-T01 ghi nhận " + "a" * 5000})
    n = conn.execute("select length(detail) from plot_logs "
                     "where source = 'zalo:garden'").fetchone()[0]
    assert n == zg.MAX_DETAIL


def test_text_flag_note(conn):
    out = _run("user_send_text", {"text": "KV-T01 kiểm tra sâu bệnh có rệp"})
    assert "dấu hiệu cần chú ý" in out


def test_text_unknown_plot_no_write(conn):
    out = _run("user_send_text", {"text": "KV-ZZ9 tưới"})
    assert "Không tìm thấy khoảnh 'KV-ZZ9'" in out and "Cú pháp" in out
    assert conn.execute("select count(*) from plot_logs where source = "
                        "'zalo:garden'").fetchone()[0] == 0
    assert zg._recent_plot(zg.uhash(STAFF_UID)) is None


def test_text_bad_syntax_no_db(monkeypatch, tmp_path):
    _staff(tmp_path)
    monkeypatch.setattr(zg, "_connect", lambda: pytest.fail("không được "
                                                            "connect"))
    assert _run("user_send_text", {"text": "tưới"}) == zg.HELP
    assert _run("user_send_text", {}) == zg.HELP


def test_text_db_down(monkeypatch, tmp_path):
    _staff(tmp_path)
    monkeypatch.setattr(zg, "_connect", lambda: None)
    assert _run("user_send_text", {"text": "KV-T01 tưới"}) == zg.DB_DOWN


def test_text_duplicate_reports_not_written(conn, monkeypatch):
    from datetime import datetime, timezone
    fixed = datetime(2026, 10, 15, 1, tzinfo=timezone.utc)

    class _DT(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed
    monkeypatch.setattr(zg, "datetime", _DT)
    assert _run("user_send_text", {"text": "KV-T01 tưới"}).startswith("Đã")
    out = _run("user_send_text", {"text": "KV-T01 tưới"})
    assert out.startswith("CHƯA ghi:") and "trùng" in out


def test_crash_still_replies(monkeypatch, tmp_path, capsys):
    _staff(tmp_path)

    def boom():
        raise RuntimeError("STAFF_SECRET_DETAIL")
    monkeypatch.setattr(zg, "_connect", boom)
    assert _run("user_send_text", {"text": "KV-T01 tưới"}) == zg.ERROR
    out = capsys.readouterr().out
    assert "RuntimeError" in out and "STAFF_SECRET_DETAIL" not in out


def test_removed_staff_and_unsupported(monkeypatch, tmp_path):
    assert _run("user_send_text", {"text": "KV-T01 tưới"}) == zg.ERROR
    _staff(tmp_path)
    # v13.4: user_send_video đã được nhận (test video riêng) — bỏ khỏi đây.
    for ev in ("user_send_sticker", "user_send_file", "user_send_location",
               "user_send_gif"):
        assert _run(ev, {}) == zg.UNSUPPORTED
    assert _run("user_send_video", {}) == zg.NO_FILE
    assert _run("user_send_text", "khong-phai-dict") == zg.HELP


# ------------------------------------------------------------- ảnh

def _jpeg_gps() -> bytes:
    PIL = pytest.importorskip("PIL")  # noqa: F841
    from PIL import Image
    e = Image.Exif()
    e.get_ifd(0x8825).update({1: "N", 2: (15.0, 4.0, 37.29)})
    buf = io.BytesIO()
    Image.new("RGB", (16, 8), (20, 160, 40)).save(buf, "JPEG", exif=e)
    return buf.getvalue()


def _img(text=None, n=1, url=CDN):
    m = {"attachments": [{"type": "image", "payload": {"url": url}}] * n}
    if text is not None:
        m["text"] = text
    return m


def test_image_needs_store(conn, monkeypatch):
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: pytest.fail("tải"))
    assert _run("user_send_image", _img("KV-T01")) == zg.NO_STORE
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(ROOT / "data" / "kho"))
    assert _run("user_send_image", _img("KV-T01")) == zg.NO_STORE


def test_image_needs_plot(conn, monkeypatch, tmp_path):
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: pytest.fail("tải"))
    assert _run("user_send_image", _img()) == zg.NEED_PLOT
    assert _run("user_send_image", _img("KV-ZZ9 lá")) == zg.NEED_PLOT
    # khoảnh ghi từ hơn 2 giờ trước → hết hạn
    zg._last_plot[zg.uhash(STAFF_UID)] = (
        "KV-T01", time.monotonic() - zg.LAST_PLOT_TTL_S - 1)
    assert _run("user_send_image", _img()) == zg.NEED_PLOT
    assert not (tmp_path / "kho").exists()


def test_image_no_attachment(conn):
    assert _run("user_send_image", {"text": "KV-T01"}) == zg.NO_FILE
    assert _run("user_send_image", {"attachments": [
        {"type": "image", "payload": {}}, "x",
        {"type": "audio", "payload": {"url": AUDIO}}]}) == zg.NO_FILE


def test_image_caption_plot_stored_clean(conn, monkeypatch, tmp_path):
    data = _jpeg_gps()
    store = tmp_path / "kho"
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    urls = []
    monkeypatch.setattr(zg, "_fetch", lambda u, *a, **k: urls.append(u)
                        or data)
    out = _run("user_send_image", _img("kv-t01 lá vàng"))
    assert out.startswith("Đã lưu 1/1 ảnh cho khoảnh KV-T01")
    assert urls == [CDN]
    sha, plot, author, src, gps = conn.execute(
        "select sha256, plot_id, author, source, had_gps "
        "from garden_media").fetchone()
    assert (plot, author, src, gps) == ("KV-T01", "zalo:VT01", "zalo:garden",
                                        True)
    f = store / sha[:2] / f"{sha}.jpg"
    assert f.exists() and b"GPS" not in f.read_bytes()


def test_image_uses_recent_text_plot(conn, monkeypatch, tmp_path):
    data = _jpeg_gps()
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: data)
    _run("user_send_text", {"text": "KV-T01 kiểm tra sâu bệnh"})
    out = _run("user_send_image", _img(n=7))
    # trần MAX_ATTACH ảnh/tin; cùng nội dung → 1 dòng (sha trùng)
    assert out.startswith(f"Đã lưu {zg.MAX_ATTACH}/{zg.MAX_ATTACH} ảnh")
    assert conn.execute("select count(*) from garden_media"
                        ).fetchone()[0] == 1


def test_image_bad_bytes_not_saved(conn, monkeypatch, tmp_path, capsys):
    pytest.importorskip("PIL")
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: b"not an image")
    out = _run("user_send_image", _img("KV-T01"))
    assert out.startswith("CHƯA lưu được tệp")
    assert conn.execute("select count(*) from garden_media"
                        ).fetchone()[0] == 0
    assert CDN not in capsys.readouterr().out   # không in URL


def test_image_fetch_rejected(conn, monkeypatch, tmp_path):
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    out = _run("user_send_image", _img("KV-T01", url="https://evil.com/a"))
    assert out.startswith("CHƯA lưu được tệp")


# ------------------------------------------------------------- ghi âm

def _voice(text=None, url=AUDIO, typ="audio"):
    m = {"attachments": [{"type": typ, "payload": {"url": url}}]}
    if text is not None:
        m["text"] = text
    return m


def test_voice_draft_no_stt(conn, monkeypatch, tmp_path, capsys):
    store = tmp_path / "kho"
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(store))
    monkeypatch.setenv("GARDEN_STT_PROVIDER", "some-stt")
    # v13.4: bytes phải là ghi âm thật (magic ADTS) — trước: b"AUDIO-BYTES"
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: ADTS)

    def no_net(*a, **k):
        raise AssertionError("không được gửi audio ra ngoài")
    monkeypatch.setattr(httpx, "post", no_net)
    monkeypatch.setattr(httpx, "Client", no_net)
    out = _run("user_send_audio", _voice())
    assert "chờ người chép lời" in out and "khoảnh" not in out
    sha, ext, n, code, plot, st = conn.execute(
        "select sha256, ext, bytes, staff_code, plot_id, status "
        "from garden_voice_drafts").fetchone()
    assert (ext, n, code, plot, st) == ("aac", len(ADTS), "VT01", None,
                                        "cho_chep_loi")
    assert (store / "audio" / sha[:2] / f"{sha}.aac").read_bytes() == ADTS
    assert "chưa tích hợp" in capsys.readouterr().out
    # gửi lại cùng file → không thêm dòng
    _run("user_send_voice", _voice(typ="voice"))
    assert conn.execute("select count(*) from garden_voice_drafts"
                        ).fetchone()[0] == 1


def test_voice_with_plot_and_no_store(conn, monkeypatch, tmp_path):
    assert _run("user_send_audio", _voice("KV-T01")) == zg.NO_STORE
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: ADTS + b"2")
    out = _run("user_send_audio", _voice("KV-T01"))
    assert "(khoảnh KV-T01)" in out
    assert conn.execute("select plot_id, ext from garden_voice_drafts"
                        ).fetchone() == ("KV-T01", "aac")


def test_voice_draft_check_constraint(conn):
    conn.execute("insert into garden_voice_drafts (sha256, ext, bytes, "
                 "staff_code) values (%s, 'aac', 1, 'VT01')", ("a" * 64,))
    import psycopg
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("update garden_voice_drafts set status = "
                     "'da_chep_loi'")
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute("insert into garden_voice_drafts (sha256, ext, "
                     "bytes, staff_code) values (%s, 'exe', 1, 'x')",
                     ("b" * 64,))


# ------------------------------------------------------------- CLI

def test_cli_usage_errors(capsys):
    for argv in ([], ["--pending", "--hash"], ["--done", "1"],
                 ["--done", "1", "--log", "2"],
                 ["--done", "1", "--log", "2", "--by", "  "]):
        with pytest.raises(SystemExit) as e:
            zg.main(argv)
        assert e.value.code == 2


def test_cli_hash_stdin(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO(STAFF_UID + "\n"))
    assert zg.main(["--hash"]) == 0
    assert capsys.readouterr().out.strip() == zg.uhash(STAFF_UID)
    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    with pytest.raises(SystemExit) as e:
        zg.main(["--hash"])
    assert e.value.code == 2


def test_cli_db_down(monkeypatch):
    monkeypatch.setattr(zg, "_connect", lambda: None)
    assert zg.main(["--pending"]) == 2


def test_cli_pending_and_done(conn, capsys):
    did = conn.execute(
        "insert into garden_voice_drafts (sha256, ext, bytes, staff_code, "
        "plot_id) values (%s, 'aac', 3, 'VT01', 'KV-T01') returning id",
        ("c" * 64,)).fetchone()[0]
    assert zg.main(["--pending"]) == 0
    out = capsys.readouterr().out
    assert f"#{did} " in out and "VT01 KV-T01 cccccccccccc.aac" in out
    assert "[pending] 1" in out
    lid = conn.execute(
        "insert into plot_logs (plot_id, ts, activity, detail, author, "
        "source) values ('KV-T01', now(), 'tưới', 'chép từ ghi âm', "
        "'Người chép', 'manual:garden') returning id").fetchone()[0]
    assert zg.main(["--done", str(did), "--log", str(lid + 999),
                    "--by", "Người chép"]) == 1          # log không tồn tại
    assert zg.main(["--done", str(did + 999), "--log", str(lid),
                    "--by", "Người chép"]) == 1          # nháp không tồn tại
    assert zg.main(["--done", str(did), "--log", str(lid),
                    "--by", " Người chép "]) == 0
    assert conn.execute(
        "select status, plot_log_id, closed_by, closed_at is not null "
        "from garden_voice_drafts where id = %s", (did,)).fetchone() == (
        "da_chep_loi", lid, "Người chép", True)
    assert zg.main(["--done", str(did), "--log", str(lid),
                    "--by", "Khác"]) == 1                 # đã đóng
    capsys.readouterr()
    assert zg.main(["--pending"]) == 0
    assert "[pending] 0" in capsys.readouterr().out
