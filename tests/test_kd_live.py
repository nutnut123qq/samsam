"""v10.1 W101.4 — KD-A9 `agents.kd_live`: nháp kịch bản livestream (LLM lời
dẫn qua gateway GIẢ tất định, giỏ + giá do CODE từ v_promotable).

DB thật: schema tạm (schema.sql ×2 + roles.sql ×2) → ROLLBACK; `_TxConn`.
LLM = fake monkeypatch `kd_live.chat` (đếm lời gọi) — 0 mạng, 0 key thật.
Giá/duyệt giá trong fixture là số MẪU + người duyệt GIẢ LẬP.
"""

import json
import os
import re
import uuid
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from agents import kd_live as kl
from ingest import golden_store as gs
from pipelines import guardrail, store

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
RULES = json.loads((ROOT / "data" / "guardrail_rules.json").read_text(
    encoding="utf-8"))
AI, AD = RULES["labels"]["ai"][0], RULES["labels"]["ad"][0]
CANON = RULES["disclaimer"]["canonical"]
HEALTH = json.loads((ROOT / "data" / "channels.json").read_text(
    encoding="utf-8"))["templates"]["health"]
H1, H2, SAPH = "mat-ong-sam-120ml-1hu", "mat-ong-sam-300ml", "saphraton-20v"
SAPENTOL, RUOU = "sapentol-30v", "ruou-sam-chai-thuy-tinh-500ml"
PRICES = {H1: 250000, H2: 480000, SAPH: 320000}
MON = date(2026, 10, 19)
BRIEF = "Phiên quà quê cuối tuần"


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
        schema = f"t_w101l_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        conn.execute(ROLES_SQL)
        gs.load(conn, json.loads((ROOT / "data" / "golden_skus.json")
                                 .read_text(encoding="utf-8")))
        _promotable(conn)
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, *a, **kw):
        return self.conn.execute(*a, **kw)

    def cursor(self, *a, **kw):
        return self.conn.cursor(*a, **kw)

    def transaction(self):
        return self.conn.transaction()

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _promotable(db):
    db.execute("update sku_master set self_declaration_ok = true where"
               " category = 'food'")
    db.execute("update sku_master set xnqc_status = 'approved' where"
               " sku_key like 'saphraton-%'")
    db.execute("update sku_master set allowed_channels = array['shopee',"
               " 'tiktok'] where category <> 'alcohol' or sku_key = %s",
               (RUOU,))
    for k, p in [*PRICES.items(), (SAPENTOL, 300000), (RUOU, 700000)]:
        pid = db.execute(
            "insert into price_list (sku_key, channel, kind, price_vnd,"
            " valid_from) values (%s, 'tiktok', 'list', %s, '2026-01-01')"
            " returning id", (k, p)).fetchone()[0]
        db.execute("update price_list set approved_by = 'GD gia lap',"
                   " approved_at = now() where id = %s", (pid,))


def _resp(obj):
    content = obj if isinstance(obj, str) else json.dumps(
        obj, ensure_ascii=False)
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content))], model="fake/llm")


GOOD = {
    "mo_dau": ["Chào cả nhà đã ghé phiên live của Sâm Sâm.",
               "Hôm nay Sâm Sâm mang quà quê Quảng Nam tới cả nhà."],
    "san_pham": [{"sku": H1, "loi_dan": [
        "Mật ong sóng sánh vàng óng từ vùng trồng sâm.",
        "Giá chỉ 199k hôm nay thôi.", "Rượu sâm uống kèm rất hợp."]},
        {"sku": "sku-la", "loi_dan": ["Không thuộc giỏ."]}],
    "hoi_dap": [{"hoi": "Shop có giao hàng ra Hà Nội không?",
                 "dap": "Dạ Sâm Sâm giao toàn quốc ạ."},
                {"hoi": "Người bị tiểu đường dùng được không?",
                 "dap": "Dùng thoải mái nhé cả nhà."}],
    "ket": ["Cảm ơn cả nhà đã xem live."]}


@pytest.fixture
def llm(monkeypatch):
    """Fake gateway: trả lần lượt `queue` (phần tử cuối lặp lại)."""
    st = {"calls": [], "queue": [GOOD]}

    def fake_chat(agent, messages, **kw):
        st["calls"].append((agent, messages))
        q = st["queue"]
        return _resp(q[min(len(st["calls"]), len(q)) - 1])
    monkeypatch.setattr(kl, "chat", fake_chat)
    return st


def _drafts(db):
    return db.execute("select id, status, brief, text, created_by,"
                      " content_type, channel, prompt_version from"
                      " content_drafts order by id").fetchall()


# ---------------------------------------------------------------- thuần

def test_rules_and_template_manifest():
    r = kl.load_rules()
    assert r["channels"] == ["shopee", "tiktok", "facebook"]
    assert r["max_sessions_per_week"] == 2
    raw = (ROOT / "data" / "livestream_rules.json").read_text(
        encoding="utf-8")
    assert "GIẢ ĐỊNH" in raw
    from pipelines import content
    tmpl, ver, _ = content.load_template("livestream_script")
    assert ver == "livestream_script@1"
    for ph in ("{channel}", "{products}", "{brief}", "{duration_min}"):
        assert ph in tmpl
    cap = json.loads((ROOT / "data" / "llm_gateway.json").read_text(
        encoding="utf-8"))["monthly_cap_usd"]
    assert cap["kd_livestream"] > 0 and cap["mkt_youtube"] > 0


def test_precheck_order_pure():
    ctx = {"skus": {H1: {"name": "Mật ong sâm 120ml (1 hũ)",
                         "category": "food"},
                    RUOU: {"name": "Rượu sâm chai", "category": "alcohol"},
                    SAPENTOL: {"name": "Sapentol 30 viên",
                               "category": "tpbvsk"}},
           "promotable": {H1: 1}, "n_sessions": 0}
    r = kl.load_rules()
    code = (lambda ch, cart, b="x", c=ctx: (kl.precheck(ch, cart, b, c, r)
                                            or {}).get("code"))
    assert code("lazada", [H1]) == "kenh_la"
    assert code("tiktok", []) == "gio_hang"
    assert code("tiktok", [H1, H1]) == "gio_hang"
    assert code("tiktok", [H1] * 9) == "gio_hang"
    assert code("tiktok", [H1], "") == "brief"
    assert code("tiktok", ["khong-co"]) == "sku_la"
    assert code("tiktok", [H1, RUOU]) == "ruou"
    assert code("tiktok", [H1], "kèm rượu sâm") == "ruou"
    assert code("tiktok", [SAPENTOL]) == "khong_promotable"
    assert code("tiktok", [H1], c={**ctx, "n_sessions": 2}) == \
        "vuot_tran_phien"
    assert code("tiktok", [H1]) is None


def test_module_grep_no_approve_no_send():
    src = (ROOT / "agents" / "kd_live.py").read_text(encoding="utf-8")
    assert not re.search(r"set_status|approve|requests|httpx", src)


# ---------------------------------------------------------------- DB

def test_db_refuse_before_llm(db, llm):
    tx = _TxConn(db)
    for cart, code in (([H1, RUOU], "ruou"), ([H1, SAPENTOL],
                                               "khong_promotable")):
        res = kl.write_script(tx, "tiktok", cart, MON, BRIEF)
        assert res["refused"]["code"] == code and not res["ok"]
        assert res["guardrail"]["ok"] is False
    assert llm["calls"] == [] and _drafts(db) == []


def test_db_script_prices_drops_health_disclaimer(db, llm):
    tx = _TxConn(db)
    res = kl.write_script(tx, "tiktok", [H1, SAPH], MON, BRIEF)
    assert res["ok"], res["refused"]
    assert len(llm["calls"]) == 1 and llm["calls"][0][0] == "kd_livestream"
    text = res["text"]
    # (c) câu LLM có số/giá, câu rượu bị bỏ; giá = v_promotable
    assert {d["ly_do"] for d in res["dropped"]} == {"so_lieu", "ruou"}
    assert "199" not in text and "Rượu" not in text and "rượu" not in text
    assert "250.000 đ" in text and "320.000 đ" in text
    assert [c["price_vnd"] for c in res["cart"]] == [250000, 320000]
    body = text.replace("250.000", "").replace("320.000", "") \
        .replace("19/10/2026", "").replace(HEALTH, "")
    for c in res["cart"]:
        body = body.replace(c["name"], "")              # tên golden (code)
    assert re.findall(r"\d+", body) == ["1", "2"]     # chỉ số thứ tự giỏ
    assert "Không thuộc giỏ" not in text
    # (e) câu hỏi sức khỏe → câu đáp = template health NGUYÊN VĂN
    assert f"Đáp: {HEALTH}" in text and "thoải mái" not in text
    assert "Dạ Sâm Sâm giao toàn quốc ạ." in text
    # (f) TPBVSK → khuyến cáo nguyên văn + nhãn AI/QC; 0 từ cấm
    assert CANON in text and AI in text and AD in text
    assert guardrail.check(text)["ok"] is True
    # (g) nháp pending, dòng đầu brief = ngày phiên
    [d] = _drafts(db)
    assert d[0] == res["draft_id"]
    assert (d[1], d[4], d[5], d[6], d[7]) == (
        "pending", "agent:kd_a9", "livestream_script", "tiktok",
        "livestream_script@1")
    assert d[2].split("\n")[0] == "phien: 2026-10-19 kenh: tiktok"
    assert d[3] == text


def test_db_banned_claim_retry_then_refuse(db, llm):
    bad = json.loads(json.dumps(GOOD))
    bad["san_pham"][0]["loi_dan"] = ["Mật ong sâm giúp ngủ ngon mỗi tối."]
    llm["queue"] = [bad]
    res = kl.write_script(_TxConn(db), "tiktok", [H1], MON, BRIEF)
    assert res["refused"]["code"] == "kich_ban" and not res["ok"]
    assert len(llm["calls"]) == 2                       # 1 lượt sửa
    assert "vi phạm" in llm["calls"][1][1][-1]["content"]
    assert res["guardrail"]["ok"] is False and _drafts(db) == []
    llm["calls"].clear()
    bad2 = json.loads(json.dumps(GOOD))
    bad2["ket"] = ["Đây là thần dược của núi rừng."]
    llm["queue"] = [bad2, GOOD]                         # sửa xong → đạt
    res2 = kl.write_script(_TxConn(db), "tiktok", [H1], MON, BRIEF)
    assert res2["ok"] and len(llm["calls"]) == 2
    # câu có escape terminal / ZWSP bị làm sạch; trường không phải chuỗi bị bỏ
    esc = json.loads(json.dumps(GOOD))
    esc["mo_dau"] = ["Chào\x1b[m cả nhà\u200b nhé."]
    esc["hoi_dap"] = [{"hoi": {"x": 1}, "dap": "Dạ."}]
    llm["queue"] = [esc]
    res4 = kl.write_script(_TxConn(db), "tiktok", [H1], MON, BRIEF,
                           dry_run=True)
    assert res4["ok"] and "\x1b" not in res4["text"]
    assert "\u200b" not in res4["text"] and "Hỏi:" not in res4["text"]
    assert "Chào[m cả nhà nhé." in res4["text"]
    llm["queue"] = ["không phải json"]
    res3 = kl.write_script(_TxConn(db), "tiktok", [H1], MON, BRIEF)
    assert res3["refused"]["code"] == "kich_ban"


def test_db_session_cap_week_and_rejected(db, llm):
    tx = _TxConn(db)
    a = kl.write_script(tx, "tiktok", [H1], MON, BRIEF)
    b = kl.write_script(tx, "shopee", [H1], date(2026, 10, 25), BRIEF)
    assert a["ok"] and b["ok"] is False   # H1 chưa có giá shopee
    b = kl.write_script(tx, "tiktok", [H2], date(2026, 10, 25), BRIEF)
    assert b["ok"]
    n = len(llm["calls"])
    c = kl.write_script(tx, "tiktok", [H1], date(2026, 10, 21), BRIEF)
    assert c["refused"]["code"] == "vuot_tran_phien"
    assert len(llm["calls"]) == n                       # 0 lời gọi
    d = kl.write_script(tx, "tiktok", [H1], date(2026, 10, 26), BRIEF)
    assert d["ok"]                                      # tuần kế
    ok, msg = store.set_status(tx, a["draft_id"], "rejected",
                               "nguoi_duyet_gia_lap")
    assert ok, msg
    e = kl.write_script(tx, "tiktok", [H1], date(2026, 10, 21), BRIEF)
    assert e["ok"]                          # rejected không tính trần
    dry = kl.write_script(tx, "tiktok", [H1], date(2026, 11, 2), BRIEF,
                          dry_run=True)
    assert dry["ok"] and dry["draft_id"] is None
    assert len(_drafts(db)) == 4


def test_cli_usage_and_dry_run(db, llm, monkeypatch, capsys):
    tx = _TxConn(db)
    calls = []
    monkeypatch.setattr(kl, "connect", lambda: calls.append(1) or tx)
    for argv in (["--channel", "tiktok", "--cart", H1, "--day", "19/10",
                  "--brief", "x"],
                 ["--channel", "lazada", "--cart", H1, "--day",
                  "2026-10-19", "--brief", "x"],
                 ["--channel", "tiktok", "--cart", "A;drop", "--day",
                  "2026-10-19", "--brief", "x"]):
        with pytest.raises(SystemExit) as e:
            kl.main(argv)
        assert e.value.code == 2
    assert calls == []
    assert kl.main(["--channel", "tiktok", "--cart", f"{H1},{SAPH}",
                    "--day", "2026-10-19", "--brief", BRIEF,
                    "--dry-run"]) == 0
    assert _drafts(db) == []
    assert kl.main(["--channel", "tiktok", "--cart", RUOU, "--day",
                    "2026-10-19", "--brief", BRIEF]) == 1
    out = capsys.readouterr().out
    assert "dry-run" in out and "[refuse] ruou" in out
