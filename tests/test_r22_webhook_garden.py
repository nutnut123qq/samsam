"""r22 A2 — login dịch vụ webhook (`svc_webhook`) ghi được nhật ký vườn Zalo ở
chế độ thực, và CHỈ đúng luồng đó.

Hở (DONE r22 M3): `docs/roles.sql` chỉ cấp svc_webhook agent_writer + chunks +
chat_consents + `file_output_evidence_chat` — không quyền gì trên plots/
plot_logs/garden_media/garden_voice_drafts → `zalo_garden.handle` chạy bằng
login `in role svc_webhook` (`zalo.main` → `auth.bind_service("webhook")`) trả
lỗi cho MỌI tin chữ/ảnh/ghi âm của nhân viên vườn (42501). Vá: grant theo cột
tối thiểu (roles.sql) + trigger `webhook_garden_guard` (schema.sql) chốt nguồn
`zalo:garden` + tác giả `zalo:<mã NV>` — webhook bị chiếm không ghi được nhật
ký dưới tên người/nguồn `manual` vào hash chain, không sửa/xóa, không đọc bảng
khác.

DB: schema tạm ĐÃ COMMIT (schema.sql + roles.sql hiện hành) + LOGIN Postgres
THẬT tạm `in role svc_webhook` (mật khẩu ngẫu nhiên) — dọn cuối module, như
`test_v14_p2_service_auth.live`. Skip khi không có DATABASE_URL."""

import json
import os
import secrets
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.errors import InsufficientPrivilege

from connectors import zalo_garden as zg
from pipelines import auth
from tests.test_v14_p2_service_auth import _login_dsn
from tests.test_zalo_garden import ADTS, AUDIO, STAFF_UID, _img, _jpeg_gps

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
INS_LOG = ("insert into plot_logs (plot_id, ts, activity, author, source)"
           " values ('KV-T01', now(), %s, %s, %s)")
INS_MEDIA = ("insert into garden_media (sha256, ext, bytes, plot_id,"
             " taken_on, author, source) values (%s, 'jpg', 1, 'KV-T01',"
             " current_date, %s, %s)")
INS_VOICE = ("insert into garden_voice_drafts (sha256, ext, bytes,"
             " staff_code, plot_id, source) values (%s, 'aac', 1, %s,"
             " 'KV-T01', %s)")


@pytest.fixture(scope="module")
def live():
    base = os.environ.get("DATABASE_URL")
    if not base:
        pytest.skip("không có DATABASE_URL")
    try:
        admin = psycopg.connect(base, connect_timeout=5, autocommit=True)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    tag = uuid.uuid4().hex[:10]
    schema = f"t_r22a2_{tag}"
    name, pw = f"t_r22a2_wh_{tag}", secrets.token_urlsafe(18)
    try:
        admin.execute("set lock_timeout = '60s'")
        admin.execute(f"create schema {schema}")
        with admin.transaction():
            admin.execute(f"set local search_path to {schema}, pg_temp")
            admin.execute(SCHEMA_SQL)
            admin.execute(ROLES_SQL)
            admin.execute("insert into plots (id, location, source) values"
                          " ('KV-T01', 'Trà My', 'manual')")
        admin.execute(f"create role {name} login password '{pw}'"
                      " nosuperuser nocreatedb nocreaterole in role svc_webhook")
        yield {"admin": admin, "schema": schema,
               "dsn": _login_dsn(base, name, pw, schema)}
    finally:
        admin.execute(f"drop schema if exists {schema} cascade")
        admin.execute(f"drop role if exists {name}")
        admin.close()


def _q(live, sql, args=()):
    a = live["admin"]
    with a.transaction():
        a.execute(f"set local search_path to {live['schema']}")
        return a.execute(sql, args or None).fetchall()


@pytest.fixture
def hook(live, monkeypatch, tmp_path):
    """Tiến trình webhook chế độ thực: WEBHOOK_DATABASE_URL = login svc_webhook
    → `auth.bind_service` đặt DATABASE_URL (đúng `zalo.main`) → mọi
    `zalo_garden._connect` chạy bằng login đó. Nhân viên VT01 trong allowlist."""
    monkeypatch.setattr(auth, "ENV_FILE", tmp_path / "no.env")
    monkeypatch.setattr(auth, "_APPROVAL_FORCE", True)
    monkeypatch.setenv("DATABASE_URL", "postgresql://khong-dung/x")
    monkeypatch.setenv("WEBHOOK_DATABASE_URL", live["dsn"])
    assert auth.bind_service("webhook") is None
    assert os.environ["DATABASE_URL"] == live["dsn"]
    monkeypatch.setattr(zg, "STAFF_FILE", tmp_path / "garden_staff.json")
    zg.STAFF_FILE.write_text(json.dumps({"_doc": "x", "staff": [
        {"user_hash": zg.uhash(STAFF_UID), "ma_nv": "VT01"}]}),
        encoding="utf-8")
    monkeypatch.setattr(zg, "_staff", (None, {}))
    monkeypatch.setattr(zg, "_last_plot", {})
    monkeypatch.setenv("GARDEN_MEDIA_DIR", str(tmp_path / "kho"))
    monkeypatch.delenv("GARDEN_STT_PROVIDER", raising=False)


def _run(event, msg):
    sent = []
    r = zg.handle(STAFF_UID, event, msg, "m1",
                  send=lambda u, t: sent.append((u, t)) or True)
    assert sent == [(STAFF_UID, r["text"])]
    return r["text"]


def test_text_to_chained_plot_log(live, hook):
    out = _run("user_send_text", {"text": "kv-t01 tưới 30 phút"})
    assert out.startswith("Đã ghi nhật ký #") and "KV-T01 — tưới" in out, out
    row = _q(live, "select plot_id, activity, author, source, length(row_hash)"
                   " from plot_logs where source = 'zalo:garden'")
    assert row == [("KV-T01", "tưới", "zalo:VT01", "zalo:garden", 64)]
    assert _q(live, "select * from verify_plot_logs()") == []


def test_image_to_garden_media(live, hook, monkeypatch):
    data = _jpeg_gps()
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: data)
    out = _run("user_send_image", _img("kv-t01 lá vàng"))
    assert out.startswith("Đã lưu 1/1 ảnh cho khoảnh KV-T01"), out
    assert _q(live, "select plot_id, author, source, had_gps from"
                    " garden_media") == [("KV-T01", "zalo:VT01",
                                          "zalo:garden", True)]


def test_audio_to_voice_draft(live, hook, monkeypatch):
    monkeypatch.setattr(zg, "_fetch", lambda *a, **k: ADTS)
    msg = {"text": "KV-T01", "attachments": [
        {"type": "audio", "payload": {"url": AUDIO}}]}
    out = _run("user_send_audio", msg)
    assert out.startswith("Đã nhận 1 ghi âm (khoảnh KV-T01)"), out
    assert _q(live, "select ext, staff_code, plot_id, source, status from"
                    " garden_voice_drafts") == [
        ("aac", "VT01", "KV-T01", "zalo:garden", "cho_chep_loi")]


def test_webhook_login_only_zalo_garden_rows(live):
    """Ngoài đúng luồng Zalo vườn: tên người / nguồn khác / cột hash chain /
    sửa / xóa / đọc cột-bảng khác → 42501, không ghi gì."""
    def sha(ch):
        return ch * 64
    with psycopg.connect(live["dsn"], connect_timeout=5) as c:
        assert c.execute("select id from plots where upper(id) ="
                         " upper('kv-t01')").fetchall() == [("KV-T01",)]
        # biên độ dài: mã NV đúng 32 ký tự vẫn ghi được
        c.execute(INS_LOG, ("trồng", "zalo:" + "x" * 32, "zalo:garden"))
        c.execute(INS_VOICE, (sha("f"), "x" * 32, "zalo:garden"))
        c.commit()
        for sql, args in (
            (INS_LOG, ("tưới", "Nguyễn Văn A", "zalo:garden")),
            (INS_LOG, ("bón", "zalo:VT01", "manual")),
            (INS_LOG, ("làm cỏ", "zalo:" + "x" * 33, "zalo:garden")),
            (INS_LOG, ("phun", "zalo:", "zalo:garden")),
            (INS_MEDIA, (sha("a"), "Nguyễn Văn A", "zalo:garden")),
            (INS_MEDIA, (sha("b"), "zalo:VT01", "manual")),
            (INS_VOICE, (sha("c"), "VT01", "manual")),
            (INS_VOICE, (sha("d"), "x" * 33, "zalo:garden")),
            (INS_VOICE, (sha("e"), " ", "zalo:garden")),
            (("insert into plot_logs (plot_id, ts, activity, author, source,"
              " row_hash) values ('KV-T01', now(), 'tỉa', 'zalo:VT01',"
              " 'zalo:garden', repeat('0', 64))"), ()),
            ("update plot_logs set detail = 'x'", ()),
            ("delete from plot_logs", ()),
            ("truncate plot_logs", ()),
            ("update garden_media set author = 'zalo:VT02'", ()),
            ("delete from garden_media", ()),
            ("update garden_voice_drafts set plot_id = null", ()),
            ("delete from garden_voice_drafts", ()),
            ("insert into plots (id, source) values ('KV-X', 'manual')", ()),
            ("select location from plots", ()),
            ("select detail, author from plot_logs", ()),
            ("select author from garden_media", ()),
            ("select staff_code from garden_voice_drafts", ()),
            ("select count(*) from contacts", ()),
            ("select count(*) from orders", ()),
            ("select count(*) from human_logins", ()),
            (("select plot_log_add_human('KV-T01', now(), 'tưới', null,"
              " 'Nguyễn Văn A')"), ()),
        ):
            with pytest.raises(InsufficientPrivilege), c.transaction():
                c.execute(sql, args or None)
    assert _q(live, "select count(*) from plot_logs where source <>"
                    " 'zalo:garden' or author !~ '^zalo:'") == [(0,)]
    # owner/superuser (loader, CLI nhập tay) không bị trigger chặn
    _q(live, "insert into plot_logs (plot_id, ts, activity, author, source)"
             " values ('KV-T01', now(), 'thu hoạch', 'Nguyễn Văn A', 'manual')"
             " returning id")
