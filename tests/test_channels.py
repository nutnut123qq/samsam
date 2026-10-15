"""v5.1 KD-A1 — lớp kênh CSKH (connectors/channels.py): template, luật kênh
sàn, đồng ý tường minh, pre_route rượu/sức khỏe, handoff cskh_handoff, CLI
gợi ý sàn. DB qua fake conn, answer() qua monkeypatch — không mạng/LLM."""
import ast
import contextlib
import io
import json
import os
import re
import uuid
from pathlib import Path

import psycopg
import pytest

from connectors import channels as ch
from connectors import zalo
from pipelines import guardrail
from pipelines.kb_filter import is_alcohol

ROOT = Path(__file__).resolve().parent.parent
SALT = "test-salt-0123456789abcdef"
# Regex ĐỘC LẬP với san_violations (không tự-kiểm): domain/url/SĐT/zalo/fb.
INDEP = re.compile(r"(?i)https?://|www\.|[a-z0-9-]+\.(?:com|vn|net|me)\b"
                   r"|zalo|facebook|fanpage|\d{3,4}[ .]?\d{3}[ .]?\d{3,4}")
PII = ("0905 123 456", "an@gmail.com", "Nguyễn Văn An",
       "12 Lê Lợi, phường Hải Châu", "1234567890123456")
PAYLOAD_RE = re.compile(
    r"kênh=(?:zalo|messenger); lý do=[a-z_]+; user_hash=[0-9a-f]{32}; "
    r"msg_ref=(?:[0-9a-f]{16}|-); ts=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ; "
    r"sla=\d+h")


class _Cur:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConn:
    """chat_consents in-memory + ghi lại tham số enqueue_item."""

    def __init__(self, fail=None):
        self.rows, self.enqueued, self.fail = [], [], fail
        self.closed = 0

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if self.fail is not None:
            raise self.fail
        if s.startswith("insert into chat_consents"):
            self.rows.append(params)
            return _Cur((len(self.rows),))
        if s.startswith("select action from chat_consents"):
            acts = [r[2] for r in self.rows if r[:2] == tuple(params)]
            return _Cur((acts[-1],) if acts else None)
        if "enqueue_item" in s:
            self.enqueued.append(params)
            return _Cur((100 + len(self.enqueued),))
        raise AssertionError(f"SQL lạ: {s[:80]}")

    def transaction(self):
        return contextlib.nullcontext()

    def commit(self):
        pass

    def close(self):
        self.closed += 1


@pytest.fixture(autouse=True)
def _iso(monkeypatch, tmp_path):
    """Không muối mặc định, convlog/dedup Zalo sang tmp, cache cấu hình sạch."""
    monkeypatch.delenv("CHANNEL_HASH_SALT", raising=False)
    monkeypatch.setattr(zalo, "SEEN_DB", tmp_path / "zalo_seen.db")
    monkeypatch.setattr(zalo, "CONV_LOG", tmp_path / "conversations.jsonl")
    monkeypatch.setattr(zalo, "_last_purge", float("-inf"))
    monkeypatch.setattr(zalo, "_last_purge_attempt", float("-inf"))
    zalo._histories.clear()
    ch.reset_cache()
    yield
    zalo._histories.clear()
    ch.reset_cache()


@pytest.fixture
def salt(monkeypatch):
    monkeypatch.setenv("CHANNEL_HASH_SALT", SALT)


@pytest.fixture
def db(monkeypatch, salt):
    conn = FakeConn()
    monkeypatch.setattr(ch, "_connect", lambda: conn)
    return conn


@pytest.fixture
def ok_answer(monkeypatch):
    """answer giả đếm lời gọi, trả câu sạch có nguồn."""
    calls = []

    def fake(q, history=None):
        calls.append(q)
        return {"answer": f"trả lời: {q}", "sources": ["https://x.vn/a"]}
    monkeypatch.setattr("api.rag.answer", fake)
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    return calls


def _cfg_file(tmp_path, monkeypatch, **over) -> Path:
    cfg = json.loads((ROOT / "data" / "channels.json").read_text(
        encoding="utf-8"))
    for k, v in over.items():
        if k.startswith("tpl_"):
            if v is None:
                cfg["templates"].pop(k[4:])
            else:
                cfg["templates"][k[4:]] = v
        else:
            cfg[k] = v
    p = tmp_path / "channels.json"
    p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(ch, "CONFIG_PATH", p)
    ch.reset_cache()
    return p


# --- (a) template ------------------------------------------------------------

def test_templates_pass_guardrail_and_channel_rules():
    tpl = ch.load_config()["templates"]
    assert set(tpl) == set(ch.TEMPLATE_KEYS)
    for k, t in tpl.items():
        assert guardrail.check(t)["ok"] is True, k
    for k in ("alcohol", "alcohol_san"):
        assert not is_alcohol(tpl[k]), k
        assert not re.search(r"(?i)mua|đặt hàng|online|http|www", tpl[k]), k
    for k in ("alcohol_san", "health_san", "san_fallback", "san_handoff"):
        assert ch.san_violations(tpl[k]) == [], k
        assert not INDEP.search(tpl[k]), k
    for w in ("chữa", "điều trị", "thuốc", "khỏi bệnh"):
        assert w not in tpl["health"] and w not in tpl["health_san"]
    assert ch.load_config()["policy_url"] in tpl["consent_prompt"]
    assert "{policy_url}" not in tpl["consent_prompt"]
    assert "NHÁP" in ch.load_config()["_doc"] and "Pháp chế" in \
        ch.load_config()["_doc"]


def test_channels_module_imports_no_network():
    tree = ast.parse((ROOT / "connectors" / "channels.py").read_text(
        encoding="utf-8"))
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            mods |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module:
            mods.add(n.module.split(".")[0])
            if n.module == "pipelines.llm_gateway":
                assert {a.name for a in n.names} <= {
                    "_strip_accents", "is_health_question"}
    assert not mods & {"httpx", "requests", "urllib", "socket", "openai"}


# --- (b) san_violations ------------------------------------------------------

@pytest.mark.parametrize("text,code", [
    ("samsamngoclinh.com", "domain"), ("https://x.vn/a", "url"),
    ("https://x.vn/a", "domain"), ("zalo.me/123", "domain"),
    ("zalo.me/123", "zalo"), ("Zalo 0905 123 456", "zalo"),
    ("Zalo 0905 123 456", "phone"), ("hotline 1800577732", "phone"),
    ("gọi 1800 577 732", "phone"), ("fanpage Sâm Sâm", "facebook"),
    ("nhắn Facebook nhé", "facebook"), ("ghé cửa hàng 12 Lê Lợi", "dia_chi"),
    ("có showroom tại Đà Nẵng", "dia_chi"), ("www.samsam.net.vn", "url"),
    ("fb.com/samsam", "domain"), ("m.me/samsam", "domain"),
    # nghiệm thu MINOR: SĐT trong ngoặc (`_PII_RE` thô bỏ lọt) + email
    # đuôi ngoài danh sách domain → tái dùng `_mask_pii`.
    ("Gọi (0235) 3699 899 nhé", "phone"), ("Gọi (0235)3699899", "phone"),
    ("(+84) 905 115 709", "phone"), ("Liên hệ (0905) 123 456 nhé.", "phone"),
    ("Email: lienhe@samsamngoclinh.asia", "email"), ("a@b.xyz", "email"),
    ("a@b.co", "email"), ("gọi 0905*123*456", "phone"),
])
def test_san_violations_positive(text, code):
    assert code in ch.san_violations(text)


@pytest.mark.parametrize("text", [
    "giá 1.500.000đ", "hộp 20 gói", "Sâm Ngọc Linh 5 năm tuổi", "24v",
    "Savina tuýp 12 viên: 159.000 đ.",
    "Giao tới địa chỉ nhận hàng của Quý khách trong 2-4 ngày.", "", None,
    "Mua 2 hộp (2) giá (1.500.000) đ", "giá 50.000.000 - 100.000.000",
    "Giao ngày 05.10 (2)", "(1.500.000)(2.000.000)",
])
def test_san_violations_negative(text):
    assert ch.san_violations(text) == []


def test_san_violations_domain_regex_linear():
    """Probe DoS (v5.1 OWASP): `\\b[\\w-]+\\.` cho bắt đầu sau MỖI '-' →
    "a-a-a-..." backtrack bậc hai. Regex chỉ được bắt đầu ở đầu cụm
    [\\w-] — khóa tất định (không đo giờ): search từ giữa cụm → None."""
    assert ch._DOMAIN_RE.search("a-b.com", 2) is None
    assert ch._DOMAIN_RE.search("a-b.com").group(0) == "a-b.com"
    for s in ("a-" * 32000, "-a" * 32000, "a.-" * 20000):
        assert ch.san_violations(s) == []          # chạy xong, không treo


# --- (c) parse_consent -------------------------------------------------------

@pytest.mark.parametrize("text,want", [
    ("Đồng ý", "granted"), ("dong y", "granted"), ("ĐỒNG Ý.", "granted"),
    ("  tôi đồng ý! ", "granted"), ("không đồng ý", "withdrawn"),
    ("Rút đồng ý", "withdrawn"), ("đồng ý không?", None),
    ("chưa đồng ý", None), ("tôi đồng ý mua 2 hộp", None), ("ok", None),
    ("ừ", None), ("được", None), ("", None), (None, None),
    # nghiệm thu MINOR: cách rút/đồng ý tự nhiên (lễ/xưng hô, ko/k, nữa,
    # rút lại) — bẫy câu hỏi/câu dài/mua hàng vẫn None.
    ("Tôi không đồng ý ạ", "withdrawn"), ("Mình không đồng ý", "withdrawn"),
    ("ko đồng ý", "withdrawn"), ("k đồng ý", "withdrawn"),
    ("không đồng ý nữa", "withdrawn"), ("rút lại đồng ý", "withdrawn"),
    ("tôi muốn rút đồng ý", "withdrawn"), ("Hủy đồng ý", "withdrawn"),
    ("Đồng ý ạ", "granted"), ("Dạ đồng ý", "granted"),
    ("vâng, em đồng ý nhé", "granted"), ("đồng ý ko", None),
    ("có đồng ý không", None), ("không đồng ý không?", None),
    ("sao giá Savina không đồng ý với giá trên web vậy shop", None),
])
def test_parse_consent(text, want):
    assert ch.parse_consent(text) == want


# --- (d) pre_route -----------------------------------------------------------

ALCOHOL_Q = ("rượu sâm giá bao nhiêu", "ruou sam co ban ko",
             "Shop còn rượu sâm Ngọc Linh không?")


@pytest.mark.parametrize("channel", ch.CHANNELS)
def test_pre_route_alcohol_template_every_channel(channel):
    key = "alcohol_san" if channel in ch.SAN_CHANNELS else "alcohol"
    for q in ALCOHOL_Q:
        r = ch.pre_route(ch.normalize(channel, "u1", q))
        assert r is not None and r.kind == "alcohol" and \
            r.handoff == "alcohol", (channel, q)
        assert r.text == ch.template(key)


def test_pre_route_alcohol_before_health_and_health_and_product():
    r = ch.pre_route(ch.normalize("zalo", "u", "rượu sâm chữa tiểu đường"
                                  " không"))
    assert r.kind == "alcohol"
    q = "Dạ An Sâm uống thay thuốc ngủ được không, tôi mất ngủ 2 năm"
    for channel in ch.CHANNELS:
        r = ch.pre_route(ch.normalize(channel, "u", q))
        assert (r.kind, r.handoff) == ("health", "health")
        assert r.text == ch.template("health_san" if channel in
                                     ch.SAN_CHANNELS else "health")
    assert ch.pre_route(ch.normalize("zalo", "u", "Saphraton giá bao"
                                     " nhiêu?")) is None


def test_pre_route_consent_only_chat_channels():
    assert ch.pre_route(ch.normalize("zalo", "u", "Đồng ý")).kind == \
        "consent_granted"
    assert ch.pre_route(ch.normalize("messenger", "u", "không đồng ý")
                        ).kind == "consent_withdrawn"
    assert ch.pre_route(ch.normalize("shopee", "u", "đồng ý")) is None
    assert ch.pre_route(ch.normalize("tiktok", "u", "Đồng ý")) is None


def test_normalize():
    with pytest.raises(ValueError):
        ch.normalize("sms", "u", "x")
    inb = ch.normalize("zalo", "u", "  Đồng ý  " + "x" * 5000)
    assert len(inb.text) == ch.MAX_INBOUND and inb.text.startswith("Đồng")
    nfd = "Đo\u0302\u0300ng y\u0301"   # dạng NFD
    assert ch.normalize("zalo", "u", nfd).text == "Đồng ý"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", inb.ts)
    assert inb.user_hash is None    # không muối


# --- (e) format_reply --------------------------------------------------------

def test_format_reply_san_blocks_and_never_appends_source():
    res = {"answer": "Mua tại samsamngoclinh.com nhé",
           "sources": ["https://samsamngoclinh.com/x"]}
    for channel in ch.SAN_CHANNELS:
        text, meta = ch.format_reply(channel, res)
        assert text == ch.template("san_fallback")
        assert "samsamngoclinh" not in text and meta["blocked"] == ["domain"]
    clean = {"answer": "Savina tuýp 12 viên: 159.000 đ.",
             "sources": ["https://samsamngoclinh.com/x"]}
    text, meta = ch.format_reply("shopee", clean)
    assert text == clean["answer"] and "Nguồn:" not in text
    assert meta == {"guardrail_ok": True, "handoff": None, "blocked": []}


def test_format_reply_chat_identical_to_old_zalo(monkeypatch):
    from api.rag import NO_DATA
    res = {"answer": "Saphraton: 1.000.000 đ", "sources": ["http://x", "y"]}
    assert ch.format_reply("zalo", res)[0] == \
        "Saphraton: 1.000.000 đ\nNguồn: http://x"
    assert ch.format_reply("messenger", {"answer": "ok", "sources": []}
                           )[0] == "ok"
    t, m = ch.format_reply("zalo", {"answer": NO_DATA, "sources": []})
    assert t == zalo.HANDOFF_TEXT and m["handoff"] == "no_data"
    t, m = ch.format_reply("shopee", {"answer": NO_DATA, "sources": []})
    assert t == ch.template("san_handoff") and "1800" not in t
    monkeypatch.setattr(guardrail, "check", lambda t: {"ok": False})
    t, m = ch.format_reply("zalo", {"answer": "x", "sources": []})
    assert t == zalo.FALLBACK and m["handoff"] == "guardrail"
    assert ch.format_reply("tiktok", {"answer": "x", "sources": []})[0] == \
        ch.template("san_fallback")


def test_format_reply_layer2_alcohol_health_use_template():
    """answer() tự trả handoff rượu/sức khỏe (vd câu rewrite) → template."""
    from api.rag import NO_DATA
    for hand in ("alcohol", "health"):
        res = {"answer": NO_DATA, "sources": [], "handoff": hand}
        assert ch.format_reply("zalo", res) == (
            ch.template(hand), {"guardrail_ok": True, "handoff": hand,
                                "blocked": []})
        assert ch.format_reply("shopee", res)[0] == ch.template(f"{hand}_san")


# --- (f) user_hash / (g) load_config -----------------------------------------

def test_user_hash(monkeypatch):
    assert ch.user_hash("zalo", "u1") is None
    monkeypatch.setenv("CHANNEL_HASH_SALT", "ngan")       # < 16 ký tự
    assert ch.user_hash("zalo", "u1") is None
    monkeypatch.setenv("CHANNEL_HASH_SALT", SALT)
    h = ch.user_hash("zalo", "u1")
    assert re.fullmatch(r"[0-9a-f]{32}", h)
    assert h != ch.user_hash("messenger", "u1") != ch.user_hash("zalo", "u2")
    monkeypatch.setenv("CHANNEL_HASH_SALT", SALT + "x")
    assert ch.user_hash("zalo", "u1") != h               # muối đổi → hash đổi


@pytest.mark.parametrize("over,needle", [
    ({"tpl_alcohol_san": None}, "alcohol_san"),
    ({"tpl_san_fallback": "  "}, "san_fallback"),
    ({"tpl_consent_prompt": "Chào"}, "{policy_url}"),
    ({"require_consent_for_llm": "false"}, "require_consent_for_llm"),
    ({"policy_version": ""}, "policy_version"),
])
def test_load_config_rejects(tmp_path, monkeypatch, over, needle):
    _cfg_file(tmp_path, monkeypatch, **over)
    with pytest.raises(ch.ChannelConfigError) as e:
        ch.load_config()
    assert needle in str(e.value)


def test_load_config_missing_and_broken(tmp_path):
    with pytest.raises(ch.ChannelConfigError):
        ch.load_config(tmp_path / "khong-co.json")
    p = tmp_path / "x.json"
    p.write_bytes(b"{")
    with pytest.raises(ch.ChannelConfigError):
        ch.load_config(p)


# --- W51.3 handoff -----------------------------------------------------------

def test_handoff_sales_config_type():
    from pipelines import director
    spec = director.load_config("sales")["object_types"]["cskh_handoff"]
    # FLIP gộp M31 đợt 5: dùng mô hình SLA v5.0 — lớp handoff A = 2 GIỜ LÀM
    # VIỆC (agents.sales_director leo thang), sla_hours = hạn TUYỆT ĐỐI trước
    # expired; risk ≠ low → auto_policy (chỉ áp low) không bao giờ tự duyệt.
    assert spec["handoff"] == "A" and spec["risk"] in ("medium", "high")
    assert spec["sla_hours"] >= 64


def test_handoff_payload_no_pii_fixed_format(db):
    q = (f"Tôi là {PII[2]}, ở {PII[3]}, gọi {PII[0]} hoặc {PII[1]}"
         " — Saphraton chữa tiểu đường không?")
    inb = ch.normalize("messenger", f"messenger:{PII[4]}", q)
    assert ch.record_handoff(inb, "health", msg_id="m.abc") == 101
    [params] = db.enqueued
    (otype, oid, block, title, payload, risk, g, qa, by, sla) = params
    spec = __import__("pipelines.director", fromlist=["x"]).load_config(
        "sales")["object_types"]["cskh_handoff"]
    assert (otype, block, risk, by, sla, qa) == (
        "cskh_handoff", "sales", spec["risk"], "agent:kd_a1", spec["sla_hours"],
        "none")
    blob = " ".join(str(x) for x in (oid, title, payload))
    for s in PII + ("Saphraton", "tiểu đường", "m.abc"):
        assert s not in blob, s
    assert PAYLOAD_RE.fullmatch(payload), payload
    assert oid == f"messenger:{inb.user_hash}"
    assert guardrail.check(payload)["ok"] is True   # người duyệt đóng được
    assert g.obj["ok"] is True                       # snapshot enqueue
    assert db.closed == 1


@pytest.mark.parametrize("reason", sorted(ch.HANDOFF_REASONS))
def test_handoff_every_reason_payload_passes_guardrail(db, reason):
    inb = ch.normalize("zalo", "u1", "x")
    ch.record_handoff(inb, reason)
    payload = db.enqueued[-1][4]
    assert PAYLOAD_RE.fullmatch(payload)
    assert guardrail.check(payload)["ok"] is True
    assert not is_alcohol(payload) and not is_alcohol(db.enqueued[-1][3])


def test_handoff_reason_unknown_raises(db):
    with pytest.raises(ValueError):
        ch.record_handoff(ch.normalize("zalo", "u", "x"), "khac")
    assert db.enqueued == []


def test_handoff_unique_violation_db_down_no_salt_san(monkeypatch, salt,
                                                      capsys):
    inb = ch.normalize("zalo", "u1", "x")
    dup = FakeConn(fail=psycopg.errors.UniqueViolation("trùng"))
    monkeypatch.setattr(ch, "_connect", lambda: dup)
    assert ch.record_handoff(inb, "no_data") is None       # không raise
    assert "đã có mục chờ" in capsys.readouterr().out and dup.closed == 1
    monkeypatch.setattr(ch, "_connect", lambda: None)
    assert ch.record_handoff(inb, "no_data") is None       # DB down
    other = FakeConn(fail=psycopg.OperationalError("x"))
    monkeypatch.setattr(ch, "_connect", lambda: other)
    assert ch.record_handoff(inb, "health") is None
    monkeypatch.setattr(ch, "_connect",
                        lambda: pytest.fail("không được connect"))
    assert ch.record_handoff(ch.normalize("shopee", "u", "x"),
                             "health") is None              # sàn: 0 ghi
    monkeypatch.delenv("CHANNEL_HASH_SALT")
    assert ch.record_handoff(ch.normalize("zalo", "u", "x"),
                             "health") is None              # thiếu muối
    assert "u1" not in capsys.readouterr().out


def test_handoff_zalo_alcohol_and_health_zero_answer_calls(db, ok_answer):
    for q in ("rượu sâm giá bao nhiêu", "tôi bị mất ngủ uống gì"):
        r = zalo.handle_text("u7", q, msg_id="m1")
        assert r["text"] in (ch.template("alcohol"), ch.template("health"))
    assert ok_answer == []
    assert [p[0] for p in db.enqueued] == ["cskh_handoff"] * 2
    assert db.rows == []          # route rượu/sức khỏe không ghi consent


def test_handoff_zalo_no_data_and_guardrail(db, monkeypatch):
    from api.rag import NO_DATA
    monkeypatch.setattr(zalo, "send_text", lambda u, t: True)
    db.rows.append((ch.user_hash("zalo", "u8"), "zalo", "granted"))
    monkeypatch.setattr("api.rag.answer",
                        lambda q: {"answer": NO_DATA, "sources": []})
    zalo.handle_text("u8", "giá sâm 10 năm?")
    monkeypatch.setattr("api.rag.answer",
                        lambda q, history=None: {"answer": "chữa khỏi",
                                                 "sources": []})
    zalo.handle_text("u8", "câu khác")
    payloads = [p[4] for p in db.enqueued]
    assert "lý do=thieu_du_lieu" in payloads[0]
    assert "lý do=kiem_duyet" in payloads[1]


# --- W51.5 consent -----------------------------------------------------------

def test_consent_sequence_explicit_only(db, ok_answer, monkeypatch):
    sent = []
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    msgs = ["giá Savina?", "không đồng ý", "đồng ý không?", "ok", "Đồng ý",
            "Saphraton giá?"]
    for i, m in enumerate(msgs):
        zalo.handle_text("u1", m, msg_id=f"m{i}")
    acts = [r[2] for r in db.rows]
    assert acts == ["prompted", "withdrawn", "granted"]
    assert acts.count("granted") == 1
    # OWASP v5.1 (F03a bước 3 "khách rút đồng ý: dừng LLM"): sau "không
    # đồng ý" → 0 lời gọi answer (cờ tắt vẫn chặn) tới khi khách nhắn lại
    # "Đồng ý"; bản đầu vẫn gọi LLM cho "đồng ý không?"/"ok".
    assert ok_answer == ["giá Savina?", "Saphraton giá?"]
    prompt = ch.template("consent_prompt")
    assert sent[0].startswith(prompt + "\n\n") and \
        sent[0].endswith("Nguồn: https://x.vn/a")
    assert sent[1] == ch.template("consent_withdrawn_ack")
    assert sent[2] == sent[3] == prompt          # chặn LLM, chỉ câu chào
    assert sent[4] == ch.template("consent_ack")
    assert sent[5] == "trả lời: Saphraton giá?\nNguồn: https://x.vn/a"
    uh = ch.user_hash("zalo", "u1")
    assert all(r[0] == uh and r[1] == "zalo" for r in db.rows)
    assert all(r[3] == "nhap-2026-10" for r in db.rows)
    assert db.rows[0][4] == __import__("hashlib").sha256(
        b"m0").hexdigest()[:16]


def test_consent_san_channel_never_written(db, monkeypatch):
    monkeypatch.setattr(ch, "_connect", lambda: pytest.fail("DB"))
    for c in ch.SAN_CHANNELS:
        inb = ch.normalize(c, "u", "Đồng ý")
        assert ch.pre_route(inb) is None
        assert ch.record_consent(inb, "granted") is None
        assert ch.consent_gate(inb) == ch.Gate("", False, False)
    with pytest.raises(ValueError):
        ch.record_consent(ch.normalize("zalo", "u", "x"), "maybe")


def test_consent_required_flag_blocks_llm(db, ok_answer, tmp_path,
                                          monkeypatch):
    _cfg_file(tmp_path, monkeypatch, require_consent_for_llm=True)
    sent = []
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    zalo.handle_text("u2", "giá Savina?")
    zalo.handle_text("u2", "Saphraton giá?")
    assert ok_answer == []                          # 0 lời gọi answer
    assert sent == [ch.template("consent_prompt")] * 2
    assert [r[2] for r in db.rows] == ["prompted"]  # prompted 1 lần
    zalo.handle_text("u2", "Đồng ý")
    zalo.handle_text("u2", "Saphraton giá?")
    assert ok_answer == ["Saphraton giá?"]          # granted → trả lời


def test_consent_required_flag_db_down_or_no_salt_fail_closed(
        ok_answer, tmp_path, monkeypatch, salt):
    _cfg_file(tmp_path, monkeypatch, require_consent_for_llm=True)
    monkeypatch.setattr(ch, "_connect", lambda: None)
    zalo.handle_text("u3", "giá Savina?")
    monkeypatch.delenv("CHANNEL_HASH_SALT")
    zalo.handle_text("u3", "giá Savina?")
    broken = FakeConn(fail=psycopg.OperationalError("x"))
    monkeypatch.setenv("CHANNEL_HASH_SALT", SALT)
    monkeypatch.setattr(ch, "_connect", lambda: broken)
    zalo.handle_text("u3", "giá Savina?")
    assert ok_answer == []


def test_consent_flag_off_db_down_answers_without_prefix(ok_answer,
                                                         monkeypatch, salt,
                                                         capsys):
    monkeypatch.setattr(ch, "_connect", lambda: None)
    sent = []
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    zalo.handle_text("u4", "giá Savina?")
    assert ok_answer == ["giá Savina?"]
    assert sent == ["trả lời: giá Savina?\nNguồn: https://x.vn/a"]
    assert "[warn]" in capsys.readouterr().out


def test_consent_withdrawn_clears_history(db, ok_answer):
    zalo.handle_text("u5", "câu 1")
    assert "u5" in zalo._histories
    zalo.handle_text("u5", "Không đồng ý")
    assert "u5" not in zalo._histories


def test_consent_flag_off_prompted_once_then_plain_answers(db, ok_answer,
                                                           monkeypatch):
    """Đường production mặc định (cờ tắt): tin 1 có câu chào + ghi
    prompted; tin 2 thường (state=prompted) KHÔNG tiền tố, KHÔNG ghi thêm
    prompted (bảng append-only — dòng thừa không xóa được)."""
    sent = []
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    zalo.handle_text("u", "giá Savina?")
    zalo.handle_text("u", "Saphraton giá?")
    assert [r[2] for r in db.rows] == ["prompted"]
    assert sent[0].startswith(ch.template("consent_prompt") + "\n\n")
    assert sent[1] == "trả lời: Saphraton giá?\nNguồn: https://x.vn/a"
    assert ok_answer == ["giá Savina?", "Saphraton giá?"]


@pytest.mark.parametrize("flag", [False, True])
def test_consent_prompted_only_when_greeting_sent(db, ok_answer, tmp_path,
                                                  monkeypatch, flag):
    """Gửi câu chào lỗi (token hết hạn / Messenger DEPLOY tắt) → KHÔNG ghi
    prompted (bằng chứng 'đã báo' sai, không sửa được) — tin sau khách
    vẫn nhận câu chào. Cả 2 nhánh: cờ tắt (_reply) và cờ bật
    (_reply_fixed consent_required)."""
    _cfg_file(tmp_path, monkeypatch, require_consent_for_llm=flag)
    sent, ok = [], [False]
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or ok[0])
    zalo.handle_text("u", "giá Savina?")
    assert db.rows == []
    ok[0] = True
    zalo.handle_text("u", "Saphraton giá?")
    prompt = ch.template("consent_prompt")
    assert all(t.startswith(prompt) for t in sent)
    assert [r[2] for r in db.rows] == ["prompted"]


def test_consent_prompt_tells_how_to_withdraw():
    quoted = re.findall(r'"([^"]+)"', ch.template("consent_prompt"))
    assert {ch.parse_consent(q) for q in quoted} >= {"granted", "withdrawn"}


@pytest.mark.parametrize("broken", ["no_salt", "db_down", "db_error"])
def test_consent_withdraw_not_recorded_no_false_ack(ok_answer, monkeypatch,
                                                    salt, broken):
    """A04 fail-open (nghiệm thu MINOR): ghi withdrawn thất bại → KHÔNG gửi
    câu cam kết 'đã ghi nhận/ngừng xử lý'; gửi câu chưa ghi nhận + hotline.
    Không có dòng withdrawn nên tin sau (cờ tắt) vẫn tới LLM — đúng như
    câu đã nói với khách (DF-01/sop ghi rõ điều kiện)."""
    if broken == "no_salt":
        monkeypatch.delenv("CHANNEL_HASH_SALT")
        monkeypatch.setattr(ch, "_connect", lambda: pytest.fail("DB"))
    elif broken == "db_down":
        monkeypatch.setattr(ch, "_connect", lambda: None)
    else:
        bad = FakeConn(fail=psycopg.OperationalError("x"))
        monkeypatch.setattr(ch, "_connect", lambda: bad)
    sent = []
    monkeypatch.setattr(zalo, "send_text",
                        lambda u, t: sent.append(t) or True)
    zalo.handle_text("u6", "Tôi không đồng ý ạ")
    assert sent == [ch.template("consent_withdrawn_fail")]
    assert ch.template("consent_withdrawn_ack") not in sent
    assert not re.search(r"(?i)ngừng|dừng|đã ghi nhận", sent[0])
    log = [json.loads(ln) for ln in zalo.CONV_LOG.read_bytes()
           .decode("utf-8").split("\n") if ln.strip()][-1]
    assert log["route"] == "consent_withdrawn_fail" and log["sent"] is True


def test_consent_withdraw_recorded_before_ack_even_if_send_fails(
        db, ok_answer, monkeypatch):
    """Rút đồng ý ghi TRƯỚC khi gửi: gửi lỗi vẫn có dòng withdrawn (ý
    khách), tin sau bị chặn LLM."""
    monkeypatch.setattr(zalo, "send_text", lambda u, t: False)
    r = zalo.handle_text("u9", "ko đồng ý")
    assert r["text"] == ch.template("consent_withdrawn_ack")
    assert [x[2] for x in db.rows] == ["withdrawn"]
    zalo.handle_text("u9", "Saphraton giá?")
    assert ok_answer == []


# --- chat_consents trên DB THẬT (append-only, check, view, ORDER BY) ---------

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


@pytest.fixture
def pg():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("không có DATABASE_URL")
    try:
        conn = psycopg.connect(dsn, connect_timeout=5)
    except psycopg.OperationalError as e:
        pytest.skip(f"không connect được DB: {type(e).__name__}")
    try:
        conn.execute("set local lock_timeout = '10s'")
        schema = f"t_chcons_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    """Proxy conn thật: commit chỉ ĐẾM (giữ trong tx fixture, rollback
    cuối test) — bắt record_consent quên `conn.commit()` (gotcha v2.1)."""

    def __init__(self, conn):
        self.conn, self.committed = conn, 0

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        self.committed += 1


def test_chat_consents_real_db_state_view_append_only_checks(pg, salt):
    proxy = _TxConn(pg)
    inb = ch.normalize("zalo", "u-db", "x")
    other = ch.normalize("messenger", "u-db", "x")
    for i, act in enumerate(("prompted", "granted", "withdrawn")):
        assert isinstance(ch.record_consent(inb, act, f"m{i}", conn=proxy),
                          int)
        assert proxy.committed == i + 1                 # commit tường minh
    ch.record_consent(other, "granted", conn=proxy)
    # Dòng MỚI NHẤT theo id — order by asc sẽ ra 'prompted' (rút không ăn).
    assert ch.consent_state(pg, "zalo", inb.user_hash) == "withdrawn"
    assert ch.consent_state(pg, "messenger", other.user_hash) == "granted"
    assert ch.consent_state(pg, "messenger", inb.user_hash) == "none"
    assert ch.consent_state(pg, "zalo", "f" * 32) == "none"
    # View: 1 dòng/khách-kênh, chỉ granted/withdrawn mới nhất (bỏ prompted).
    assert pg.execute(
        "select user_hash, channel, action from v_chat_consent_current"
        " order by channel").fetchall() == [
        (other.user_hash, "messenger", "granted"),
        (inb.user_hash, "zalo", "withdrawn")]
    row = pg.execute("select policy_version, evidence_ref, purpose from"
                     " chat_consents where action = 'prompted'").fetchone()
    assert row == ("nhap-2026-10", ch._ref("m0"), "tu_van_chat")
    for sql in ("update chat_consents set action = 'granted'",
                "delete from chat_consents", "truncate chat_consents"):
        with pytest.raises(psycopg.Error) as e, pg.transaction():
            pg.execute(sql)
        assert "append-only" in str(e.value)
    ins = ("insert into chat_consents (user_hash, channel, action,"
           " policy_version) values (%s, %s, %s, %s)")
    for bad in (("abc", "zalo", "granted", "v1"),
                (inb.user_hash, "shopee", "granted", "v1"),
                (inb.user_hash, "zalo", "granted", " "),
                (inb.user_hash, "zalo", "maybe", "v1")):
        with pytest.raises(psycopg.errors.CheckViolation), pg.transaction():
            pg.execute(ins, bad)
    assert pg.execute("select count(*) from chat_consents").fetchone()[0] == 4


# --- W51.6 CLI gợi ý sàn -----------------------------------------------------

def _cli(monkeypatch, capsys, stdin: str, argv: list[str]):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    rc = ch.main(argv)
    return rc, capsys.readouterr().out


@pytest.mark.parametrize("bad", [
    "Mua tại samsamngoclinh.com nhé", "Nhắn zalo.me/x để được tư vấn",
    "Gọi 0905123456 nhé", "Gọi 0905 123 456 nhé",
    "Theo dõi facebook.com/samsam", "Ghé cửa hàng tại 12 Lê Lợi",
])
def test_suggest_san_output_clean(monkeypatch, capsys, bad):
    calls = []
    monkeypatch.setattr("api.rag.answer", lambda q: calls.append(q) or {
        "answer": bad, "sources": ["https://samsamngoclinh.com/x"]})
    for channel in ch.SAN_CHANNELS:
        rc, out = _cli(monkeypatch, capsys, "shop có Zalo không",
                       ["--suggest", channel, "--by", "MXH probe"])
        assert rc == 0
        # Phần MXH dán = sau dòng tiêu đề, trừ dòng meta handoff=/blocked=.
        body = "\n".join(ln for ln in out.splitlines()[1:]
                         if not ln.startswith(("handoff=", "blocked=")))
        assert ch.san_violations(body) == []
        assert not INDEP.search(body), body
        assert "[GỢI Ý — NHÁP" in out
        assert ch.template("san_fallback") in out or \
            ch.template("san_handoff") in out
    assert len(calls) == 2


def test_suggest_alcohol_template_no_answer_call(monkeypatch, capsys):
    monkeypatch.setattr("api.rag.answer", lambda q: pytest.fail("LLM"))
    rc, out = _cli(monkeypatch, capsys, "Shop có bán rượu sâm không?",
                   ["--suggest", "tiktok", "--by", "probe"])
    assert rc == 0 and ch.template("alcohol_san") in out
    assert "handoff=alcohol" in out


def test_suggest_buyer_phone_not_echoed(monkeypatch, capsys):
    monkeypatch.setattr("api.rag.answer", lambda q: {
        "answer": "Savina tuýp 12 viên: 159.000 đ.", "sources": []})
    rc, out = _cli(monkeypatch, capsys,
                   "Savina giá? gọi tôi 0905 123 456, an@gmail.com",
                   ["--suggest", "shopee", "--by", "probe"])
    assert rc == 0 and "159.000" in out
    assert "0905" not in out and "an@gmail.com" not in out


def test_suggest_answer_raises_prints_san_handoff(monkeypatch, capsys):
    def boom(q):
        raise RuntimeError("gateway chặn 0905123456")
    monkeypatch.setattr("api.rag.answer", boom)
    rc, out = _cli(monkeypatch, capsys, "giá Savina?",
                   ["--suggest", "shopee", "--by", "probe"])
    assert rc == 0 and ch.template("san_handoff") in out
    assert "0905123456" not in out and "RuntimeError" in out


@pytest.mark.parametrize("stdin,argv", [
    ("giá?", ["--suggest", "shopee"]),
    ("giá?", ["--suggest", "shopee", "--by", "  "]),
    ("giá?", ["--suggest", "shopee", "--by", "x" * 101]),
    ("giá?", ["--suggest", "shopee", "--by", "a\nb"]),
    ("   \n", ["--suggest", "shopee", "--by", "probe"]),
    ("giá?", ["--suggest", "shopee", "--by", "p", "--eval-real"]),
    ("giá?", []),
    ("giá?", ["--suggest", "zalo", "--by", "p"]),
    ("giá?", ["--eval-real", "--limit", "0"]),
])
def test_suggest_usage_errors_exit_2(monkeypatch, capsys, stdin, argv):
    monkeypatch.setattr("api.rag.answer", lambda q: pytest.fail("LLM"))
    with pytest.raises(SystemExit) as e:
        _cli(monkeypatch, capsys, stdin, argv)
    assert e.value.code == 2


def test_respond_persist_records_handoff_chat_only(db, monkeypatch):
    monkeypatch.setattr("api.rag.answer", lambda q: pytest.fail("LLM"))
    out = ch.respond("zalo", "u1", "rượu sâm còn không", persist=True)
    assert out["route"] == "alcohol" and len(db.enqueued) == 1
    ch.respond("shopee", "u1", "rượu sâm còn không", persist=True)
    ch.respond("messenger", "u1", "rượu sâm còn không")
    assert len(db.enqueued) == 1


def test_score_cskh_rules():
    case = {"channel": "shopee", "expect": {"route": None, "handoff": None,
                                            "text_regex": "^ok$",
                                            "forbid_regex": "xx",
                                            "max_llm_calls": 1}}
    good = {"answer": "ok", "route": None, "handoff": None, "llm_calls": 1}
    assert ch.score_cskh(case, good) == (True, "")
    assert ch.score_cskh(case, {**good, "llm_calls": 2})[0] is False
    assert ch.score_cskh(case, {**good, "handoff": "no_data"})[0] is False
    bad_san = {**good, "answer": "ok"}
    case2 = {**case, "expect": {"route": None}}
    assert ch.score_cskh(case2, {**bad_san, "answer": "zalo.me"})[0] is False
    # content=False (lần chạy thật): bỏ text_regex/handoff/max_llm_calls
    assert ch.score_cskh(case, {**good, "answer": "khác", "llm_calls": 9,
                                "handoff": "x"}, content=False) == (True, "")


def test_eval_real_key_missing_interleave_and_budget(monkeypatch, capsys):
    """--eval-real: thiếu key → exit 1 không gọi gì (external-dep);
    `--limit 8` xen kẽ loại → có ca kênh sàn; vượt trần chi phí → exit 1."""
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(ch, "respond", lambda *a, **k: pytest.fail("LLM"))
    assert ch._eval_real(8) == 1
    assert "[external-dep]" in capsys.readouterr().out
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    seen = []

    def fake(channel, uid, text):
        seen.append(channel)
        return {"answer": "Dạ có.", "route": None, "handoff": None,
                "blocked": []}
    monkeypatch.setattr(ch, "respond", fake)
    monkeypatch.setattr(ch, "_connect", lambda: None)
    assert ch._eval_real(8) == 0
    assert len(seen) == 8 and sum(c in ch.SAN_CHANNELS for c in seen) >= 4

    class Costly:
        def execute(self, sql, params=()):
            return _Cur((0.06, 3) if "llm_usage" in sql else (0,))

        def commit(self):
            pass

        def close(self):
            pass
    monkeypatch.setattr(ch, "_connect", Costly)
    assert ch._eval_real(2) == 1
    assert "VƯỢT TRẦN" in capsys.readouterr().out
