"""v8.0 W80.5–W80.7 — `agents.ceo_report`: trang tuần/tháng cho TGĐ mà MỌI
con số do code điền từ `channel_snapshots`; preflight tuyến cảnh báo đỏ;
nhận xét grounded (LLM chỉ viết placeholder, code điền số; LLM tự viết số →
bị loại); LLM mặc định tắt (0 lời gọi gateway).

Đường DB thật: schema tạm + rollback (precedent test_director_framework),
`_TxConn` cho code gọi commit. Số trong fixture là số MẪU bịa; tên người
nhận cảnh báo trong test là tên giả lập.
"""

import json
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import psycopg
import pytest

from agents import ceo_report as cr
from pipelines import cockpit as ck
from pipelines import llm_gateway, red_alert
from pipelines.period import period_bounds

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
ROLES_SQL = (ROOT / "docs" / "roles.sql").read_text(encoding="utf-8")
FIX = ROOT / "tests" / "fixtures" / "cockpit"
VN = timezone(timedelta(hours=7))
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=VN)
W41, W40 = date(2026, 10, 5), date(2026, 9, 28)
CAP = datetime(2026, 10, 12, 2, 0, tzinfo=timezone.utc)
RED = "ĐỎ — chưa có người nhận cảnh báo độc lập"


def _snap(mid, ps, val, ch="noi_bo", src="api", ref="db:x"):
    return (ch, mid, ps, Decimal(val), src, ref, CAP)


FULL = [
    _snap("leads.new", W41, 137, ref="db:leads"),
    _snap("leads.new", W40, 120, ref="db:leads"),
    _snap("sales.gmv_vnd", W41, 21585320, "shopee", "manual_export",
          "sample:kenh_MAU.csv#sha256:abcdef012345"),
    _snap("sales.gmv_vnd", W40, 18000000, "shopee", "manual_export",
          "sample:kenh_MAU.csv#sha256:abcdef012345"),
    _snap("ai.cost_usd", W41, "0.75"), _snap("ai.cost_usd", W40, "0.5"),
    _snap("ai.cost_usd.chatbot", W41, "0.75"),
    _snap("jobs.failed", W41, 4), _snap("jobs.failed", W40, 0),
    _snap("chatbot.questions", W41, 55),                  # thiếu kỳ trước
    _snap("approvals.ceo_hours_median", W41, "16.0"),
    _snap("approvals.ceo_hours_median", W40, "30.0"),
    _snap("sales.orders_cancelled", W41, 3, "shopee", "manual_export", "f"),
    _snap("sales.orders_cancelled", W40, 6, "shopee", "manual_export", "f"),
    # api + manual_export cùng khóa → ưu tiên manual_export
    _snap("social.reach", W41, 999, "facebook", "api", "api:x"),
    _snap("social.reach", W41, 7777, "facebook", "manual_export", "f"),
]
FIX_VALUES = ["137", "120", "21585320", "21.585.320", "18000000",
              "18.000.000", "7777", "7.777", "16,0", "30,0", "0,75", "0,50"]


class _Res:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _SnapConn:
    """Fake conn: chỉ trả snapshot cho SELECT channel_snapshots."""

    def __init__(self, snaps):
        self.snaps = snaps

    def execute(self, sql, params=None):
        assert "from channel_snapshots" in sql
        _kind, cur, prev = params
        return _Res([s for s in self.snaps if s[2] in (cur, prev)])


@pytest.fixture
def routing_red(tmp_path):
    p = tmp_path / "routing.json"
    p.write_bytes(b'{"recipients": [], "excluded_roles": ["tgd"]}')
    return p


def _rep(snaps=FULL, routing=None, **kw):
    return cr.build(_SnapConn(snaps), "week", W41, now=NOW, routing=routing,
                    **kw)


def _table_rows(page: str) -> list[list[str]]:
    out = []
    for line in page.splitlines():
        if line.startswith("| ") and not line.startswith("| Chỉ số"):
            out.append([c.strip() for c in line.strip("|").split("|")])
    return out


def _parse(cell: str) -> Decimal:
    num = re.match(r"-?[\d.,]+", cell).group(0)
    return Decimal(num.replace(".", "").replace(",", "."))


def _expect(v: Decimal, unit: str) -> Decimal:
    q = {"VND": Decimal(1), "USD": Decimal("0.01"), "giờ": Decimal("0.1")}
    return v.quantize(q[unit]) if unit in q else v


# ------------------------------------------------------------ W80.5 thuần

def test_period_labels():
    s, _ = period_bounds("week", date(2026, 10, 1))
    assert cr.period_label("week", s) == "2026-W40"
    m, _ = period_bounds("month", date(2027, 1, 15))
    prev, _ = period_bounds("month", m - timedelta(days=1))
    assert cr.period_label("month", prev) == "2026-12"
    rep = cr.build(_SnapConn([]), "month", date(2027, 1, 15),
                   now=datetime(2027, 2, 1, tzinfo=VN))
    assert (rep["label"], rep["prev_label"]) == ("2027-01", "2026-12")


def test_formatters():
    assert cr.fmt_value(Decimal(21585320), "VND") == "21.585.320 đ"
    assert cr.fmt_value(Decimal("0.756"), "USD") == "0,76 USD"
    assert cr.fmt_value(Decimal(16), "giờ") == "16,0 giờ"
    assert cr.fmt_value(Decimal(1234), "lead") == "1.234 lead"
    assert cr.fmt_delta(Decimal(4), Decimal(0), "job") == "+4 job"
    assert cr.fmt_delta(Decimal(3), Decimal(6), "đơn") == "-3 đơn (-50,0%)"
    assert cr.fmt_delta(Decimal(5), Decimal(5), "lead").startswith("±0")
    assert cr.assess(Decimal(3), Decimal(6), "down") == "tốt"
    assert cr.assess(Decimal(3), Decimal(6), "up") == "xấu"
    assert cr.assess(Decimal(3), None, "up") == "—"


def test_render_numbers_come_from_fixture(routing_red):
    rep = _rep(routing=routing_red)
    page = cr.render(rep)
    metrics = ck.load_metrics()
    want = {}
    for ch, mid, ps, val, src, ref, _ in FULL:
        k = (mid, ch, ps)
        if k in want and want[k][1] == "manual_export":
            continue
        want[k] = (val, src)
    rows = _table_rows(page)
    assert rows
    seen_vals = 0
    for name, ch, cur, prev, delta, _, source in rows:
        mid = re.search(r"\(([a-z][a-z0-9_.]+)\)$", name).group(1)
        unit = ck.metric_spec(metrics, mid)["unit"]
        for cell, ps in ((cur, W41), (prev, W40)):
            if cell == cr.NO_DATA:
                assert (mid, ch, ps) not in want, (mid, ch, ps)
                continue
            seen_vals += 1
            assert _parse(cell) == _expect(want[(mid, ch, ps)][0], unit), name
        if cr.NO_DATA in (cur, prev):
            assert delta == "—"
        if "sample:" in source:
            assert "(MẪU)" in source
    assert seen_vals == len(want)
    by = {r[0]: r for r in rows}
    reach = by["Lượt tiếp cận (social.reach)"]
    assert reach[2] == "7.777 lượt" and "manual_export" in reach[6]
    q = by["Câu hỏi chatbot (chatbot.questions)"]
    assert q[3] == cr.NO_DATA and q[4] == "—"
    gmv = by["GMV đặt — không phải doanh thu thực nhận (sales.gmv_vnd)"]
    assert gmv[2] == "21.585.320 đ" and "(MẪU)" in gmv[6]
    assert gmv[4] == "+3.585.320 đ (+19,9%)" and gmv[5] == "tốt"
    assert by["Job lịch lỗi (jobs.failed)"][4] == "+4 job"
    lead_none = by["Lead mới (leads.new)"]
    assert lead_none[5] == "tốt" and "chụp 12/10/2026" in lead_none[6]
    # Metric thiếu cả 2 kỳ → [chưa có dữ liệu], không 0.
    fol = by["Người theo dõi (social.followers)"]
    assert fol[2] == fol[3] == cr.NO_DATA and fol[1] == "—"
    assert not any(re.fullmatch(r"0( .*)?", c) for r in rows
                   for c in (r[2], r[3]) if r[0] != "Job lịch lỗi (jobs.failed)")
    assert "## Thời gian duyệt của TGĐ" in page
    assert "KHÔNG tự gửi" in page.splitlines()[-1]
    assert page.startswith("# Báo cáo tuần 2026-W41 — TGĐ")


# ------------------------------------------------------------ W80.6

def test_preflight_real_config_red():
    page = cr.render(_rep())
    head = page.split("## Số liệu")[0]
    assert RED in head


@pytest.mark.parametrize("cfg", [
    {"recipients": [{"name": "Người Giả A", "role": "tgd", "channel": "zalo"},
                    {"name": "Người Giả B", "role": "ha_tang",
                     "channel": "email"}]},
    "{hỏng",
    {},
], ids=["chi-tgd-ha-tang", "file-hong", "rong"])
def test_preflight_red_when_no_independent(tmp_path, cfg):
    p = tmp_path / "r.json"
    p.write_bytes((cfg if isinstance(cfg, str)
                   else json.dumps(cfg, ensure_ascii=False)).encode("utf-8"))
    page = cr.render(_rep(routing=p))
    assert RED in page
    assert "Người Giả" not in page


def test_preflight_ok_counts_without_names(tmp_path):
    p = tmp_path / "r.json"
    p.write_bytes(json.dumps({"recipients": [
        {"name": "Kiểm Thử Pháp Chế", "role": "phap_che",
         "channel": "email"}]}, ensure_ascii=False).encode("utf-8"))
    page = cr.render(_rep(routing=p))
    assert RED not in page
    assert "Tuyến cảnh báo đỏ: 1 người nhận độc lập" in page
    assert "Kiểm Thử Pháp Chế" not in page


def test_check_routing_cli_unchanged(capsys):
    assert red_alert.main(["--check-routing"]) == 1


# ------------------------------------------------------------ W80.7

@pytest.fixture
def gv():
    rep = _rep()
    return rep, cr.commentary_values(rep), (rep["label"], rep["prev_label"])


@pytest.mark.parametrize("tpl,why", [
    ("Lead {leads.new:2026-W41} tăng 15%", "tự viết số"),
    ("Lead tăng mười lăm phần trăm", "tự viết số"),
    ("Lead tăng １５ so với kỳ trước", "tự viết số"),
    ("Lead tăng Hai Triệu", "tự viết số"),
    ("GMV {sales.foo:2026-W41}", "metric lạ"),
    ("Câu hỏi {chatbot.questions:2026-W40}", "thiếu giá trị"),
    ("Câu hỏi {chatbot.questions:delta}", "thiếu giá trị"),
    ("Lead {leads.new:2025-W01}", "kỳ lạ"),
    ("Lead {leads.new}", "cú pháp"),
    ("Sâm giúp chữa bệnh, lead {leads.new:2026-W41}", "guardrail"),
    ("Lead mới ổn định. " * 80, "1200"),
    ("", "rỗng"),
    ("Lead tăng \u00b9\u2075 lần {leads.new:delta}", "tự viết số"),
    ("Lead tăng \u2460 bậc", "tự viết số"),
    ("Lead tăng gấp đôi, \u00bd kênh", "tự viết số"),
    ("Lead lũy thừa \u00b2", "tự viết số"),
    ("Đơn \u216b", "tự viết số"),
    ("Lead tăng năm \u2030", "tự viết số"),
], ids=["phan-tram", "chu-tram", "fullwidth", "trieu", "metric-la",
        "thieu-prev", "thieu-delta", "token-la", "cu-phap", "guardrail",
        "qua-dai", "rong", "superscript", "circled", "vulgar-half",
        "sup2", "roman-12", "per-mille"])
def test_ground_rejects(gv, tpl, why):
    _, values, labels = gv
    text, reasons = cr.ground(tpl, values, labels)
    assert text is None
    assert any(why in r for r in reasons), reasons


def _strip_filled(text: str, values: dict) -> str:
    for v in sorted({s for d in values.values() for s in d.values()},
                    key=len, reverse=True):
        text = text.replace(v, "")
    return text


def test_ground_clean_template_all_digits_from_values(gv):
    _, values, labels = gv
    tpl = ("Lead mới tăng từ {leads.new:2026-W40} lên {leads.new:2026-W41} "
           "({leads.new:delta}); GMV Shopee {sales.gmv_vnd.shopee:2026-W41}"
           " — giờ duyệt {approvals.ceo_hours_median:delta}.")
    text, reasons = cr.ground(tpl, values, labels)
    assert reasons == [] and text is not None
    assert "137 lead" in text and "21.585.320 đ" in text
    assert not re.search(r"\d", _strip_filled(text, values))


def _variants(routing):
    full = _rep(routing=routing)
    missing = _rep([s for s in FULL if s[2] == W41], routing=routing)
    zero = _rep([_snap("jobs.failed", W41, 4), _snap("jobs.failed", W40, 0),
                 _snap("leads.new", W41, 0), _snap("leads.new", W40, 0)],
                routing=routing)
    return full, missing, zero


def test_rule_commentary_always_grounds(routing_red):
    for rep in _variants(routing_red):
        tpls, values, labels = cr.rule_templates(rep)
        for t in tpls:
            assert cr.ground(t, values, labels)[1] == [], t
        out = cr.rule_commentary(rep)
        assert "bị loại" not in out
        assert not re.search(r"\d", _strip_filled(out, values)), out
    full = _variants(routing_red)[0]
    assert "Lead mới tăng từ 120 lead lên 137 lead" in full["commentary"]
    assert "Đơn hủy (kênh shopee) hạ từ 6 đơn xuống 3 đơn" in full[
        "commentary"]


class _Chat:
    def __init__(self, reply=None, exc=None):
        self.calls, self.reply, self.exc = [], reply, exc

    def __call__(self, agent_id, messages, model=None, **kw):
        self.calls.append((agent_id, messages))
        if self.exc:
            raise self.exc

        class M:
            content = self.reply

        class C:
            message = M

        class R:
            choices = (C,)
        return R


def test_llm_off_zero_gateway_calls(monkeypatch, routing_red):
    fake = _Chat("x")
    monkeypatch.setattr(llm_gateway, "chat", fake)
    rep = _rep(routing=routing_red)
    page = cr.render(rep)
    assert fake.calls == []
    assert "## Nhận xét" in page and "theo luật" in page
    assert RED in page and "## Số liệu điều hành" in page
    assert rep["commentary"] == cr.rule_commentary(rep)


def test_llm_number_rejected_falls_back(monkeypatch, routing_red):
    fake = _Chat("GMV tăng 12%")
    monkeypatch.setattr(llm_gateway, "chat", fake)
    rep = _rep(routing=routing_red, llm=True)
    assert len(fake.calls) == 1
    assert rep["commentary"] == cr.rule_commentary(rep)
    assert rep["llm_note"].startswith("Nhận xét LLM bị loại:")
    assert "tự viết số" in rep["llm_note"]
    assert "Nhận xét LLM bị loại" in cr.render(rep)


def test_llm_gateway_error_falls_back(monkeypatch, routing_red):
    monkeypatch.setattr(llm_gateway, "chat",
                        _Chat(exc=llm_gateway.GatewayBlocked("cap")))
    rep = _rep(routing=routing_red, llm=True)
    assert rep["commentary"] == cr.rule_commentary(rep)
    assert "gateway lỗi" in rep["llm_note"]


def test_llm_valid_template_filled(monkeypatch, routing_red):
    fake = _Chat("- Lead mới tăng lên {leads.new:2026-W41} "
                 "({leads.new:delta}), cần giữ đà.")
    monkeypatch.setattr(llm_gateway, "chat", fake)
    rep = _rep(routing=routing_red, llm=True)
    assert rep["llm_used"] and rep["llm_note"] is None
    assert rep["commentary"] == ("- Lead mới tăng lên 137 lead "
                                 "(+17 lead (+14,2%)), cần giữ đà.")
    agent, messages = fake.calls[0]
    assert agent == "cockpit"
    prompt = json.dumps(messages, ensure_ascii=False)
    for v in FIX_VALUES:
        assert v not in prompt, v
    assert "leads.new" in prompt and "{metric:kỳ}" in prompt


# ------------------------------------------------------------ CLI thuần

def _no_connect():
    raise AssertionError("connect không được gọi")


def test_cli_unclosed_exit2_before_connect(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "connect", _no_connect)
    assert cr.main(["--ref", "2026-10-12", "--out-dir", str(tmp_path)],
                   now=NOW) == 2
    assert cr.main(["--period", "month", "--ref", "2026-10-01"], now=NOW) == 2
    assert cr.main(["--ref", "2026-02-30"], now=NOW) == 2


def test_cli_db_down_exit2_no_file(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "connect", lambda: None)
    assert cr.main(["--ref", "2026-10-05", "--out-dir", str(tmp_path)],
                   now=NOW) == 2
    assert list(tmp_path.iterdir()) == []


def test_guardrail_violation_page_has_warning_line():
    rep = _rep()
    rep["rows"][0]["name"] = "Sâm chữa bệnh"     # giả lập trang vi phạm
    text, ok = cr.finalize(rep)
    assert not ok and text.splitlines()[2].startswith("> **CẢNH BÁO GUARDRAIL")


class _CliConn(_SnapConn):
    def close(self):
        pass


def test_cli_guardrail_violation_blocks_submit(monkeypatch, tmp_path, capsys,
                                               routing_red):
    """W80.5: trang vi phạm guardrail vẫn ghi file nhưng `--submit` KHÔNG
    nộp hàng chờ (rc 1, director.submit 0 lần)."""
    monkeypatch.setattr(cr, "connect", lambda: _CliConn(FULL))
    monkeypatch.setattr(cr, "load_routing",
                        lambda p=None: red_alert.load_routing(routing_red))
    monkeypatch.setattr(cr, "guardrail_check", lambda text: {
        "ok": False, "violations": [{"type": "banned_word"}]})
    calls = []
    monkeypatch.setattr(cr.director, "submit",
                        lambda *a, **kw: calls.append(a) or 1)
    rc = cr.main(["--ref", "2026-10-05", "--submit", "--out-dir",
                  str(tmp_path)], now=NOW)
    assert rc == 1 and calls == []
    assert "KHÔNG nộp" in capsys.readouterr().err
    page = (tmp_path / "ceo-2026-W41.md").read_text(encoding="utf-8")
    assert "CẢNH BÁO GUARDRAIL" in page
    # Đối chứng: trang sạch → submit được gọi đúng 1 lần.
    monkeypatch.setattr(cr, "guardrail_check", lambda text: {"ok": True})
    assert cr.main(["--ref", "2026-10-05", "--submit", "--out-dir",
                    str(tmp_path)], now=NOW) == 0
    assert len(calls) == 1


@pytest.mark.parametrize("order", ["manual-truoc", "api-truoc"])
def test_pick_manual_export_wins_any_order(order):
    api = _snap("social.reach", W41, 999, "facebook", "api", "api:x")
    man = _snap("social.reach", W41, 7777, "facebook", "manual_export", "f")
    snaps = [man, api] if order == "manual-truoc" else [api, man]
    picked, bad = cr._pick(snaps)
    got = picked[("social.reach", "facebook", W41)]
    assert bad == 0
    assert got["value"] == Decimal(7777) and got["source"] == "manual_export"


# ------------------------------------------------------------ DB thật

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
        # 60s (không 10s): roles.sql đụng role toàn cluster — nhiều worktree
        # chạy test DB song song từng làm LockNotAvailable ở mốc 10s.
        conn.execute("set local lock_timeout = '60s'")
        schema = f"t_w80r_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}, pg_temp")
        conn.execute(SCHEMA_SQL)
        conn.execute(ROLES_SQL)
        assert conn.execute("select current_schema()").fetchone()[0] == schema
        yield conn
    finally:
        conn.rollback()
        conn.close()


class _TxConn:
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


def _count(db, t):
    return db.execute(f"select count(*) from {t}").fetchone()[0]


def test_db_build_render_and_submit(db, tmp_path, monkeypatch, capsys):
    tc = _TxConn(db)
    m = ck.load_metrics()
    rows = []
    for ps, n in ((W40, 120), (W41, 137)):
        rows.append({"channel": "noi_bo", "metric_id": "leads.new",
                     "period_kind": "week", "period_start": ps,
                     "value": Decimal(n), "source": "api",
                     "source_ref": "db:leads"})
    ck.store(tc, rows, "agent:cockpit", metrics=m)
    csv_rows, errs = ck.read_csv(FIX / "kenh_MAU.csv", m, now=NOW)
    assert errs == []
    ref = ck.csv_source_ref(FIX / "kenh_MAU.csv", True)
    for r in csv_rows:
        r.update(source="manual_export", source_ref=ref)
    ck.store(tc, csv_rows, "Người Xuất Test", metrics=m, atomic=True)

    rep = cr.build(tc, "week", W41, now=NOW)
    page = cr.render(rep)
    by = {r[0]: r for r in _table_rows(page)}
    lead = by["Lead mới (leads.new)"]
    assert lead[2:6] == ["137 lead", "120 lead", "+17 lead (+14,2%)", "tốt"]
    assert lead[6].startswith("api · db:leads · chụp ")
    gmv = [r for r in _table_rows(page) if r[0].endswith("(sales.gmv_vnd)")]
    shopee = next(r for r in gmv if r[1] == "shopee")
    assert shopee[2:4] == ["12.222.000 đ", "11.111.000 đ"]
    assert "(MẪU)" in shopee[6] and "sample:kenh_MAU.csv" in shopee[6]
    assert RED in page   # config thật: recipients []

    monkeypatch.setattr(cr, "connect", lambda: tc)
    n_appr = _count(db, "approvals")
    argv = ["--period", "week", "--ref", "2026-10-05", "--submit",
            "--out-dir", str(tmp_path)]
    assert cr.main(argv, now=NOW) == 0
    out = capsys.readouterr().out
    assert "[submit]" in out
    q = db.execute("select block, object_type, object_id, status, created_by"
                   " from approval_queue").fetchall()
    assert q == [("ceo", "weekly_report", "2026-W41", "pending",
                  "agent:ceo_report")]
    assert _count(db, "approvals") == n_appr
    assert (tmp_path / "ceo-2026-W41.md").read_bytes().decode("utf-8") \
        .startswith("# Báo cáo tuần 2026-W41 — TGĐ")
    # Nộp lại khi còn pending → lỗi, exit 1, không thêm mục.
    assert cr.main(argv, now=NOW) == 1
    assert _count(db, "approval_queue") == 1


@pytest.mark.parametrize("tpl", [
    "Xem chi tiết tại https://evil.example/x",
    "Xem www.evil.example",
    "Lead <img src=x onerror=alert(1)>",
    "Bấm [vào đây](javascript:alert)",
], ids=["http", "www", "html", "md-link"])
def test_ground_rejects_markup(gv, tpl):
    _, values, labels = gv
    text, reasons = cr.ground(tpl, values, labels)
    assert text is None and any("link/HTML" in r for r in reasons), reasons


def test_bad_snapshot_values_skipped_not_crash(routing_red):
    snaps = [_snap("leads.new", W41, "NaN"), _snap("leads.new", W40, "1e30"),
             _snap("jobs.failed", W41, 2)]
    rep = _rep(snaps, routing=routing_red)
    page = cr.render(rep)
    lead = next(r for r in _table_rows(page) if r[0] == "Lead mới (leads.new)")
    assert lead[2] == lead[3] == cr.NO_DATA
    assert "Bỏ qua 2 số hỏng" in page


# ------------------------------------------------------------ v8.1 W81.5
# 3 section mới (Sổ quyết định / Rủi ro pháp lý / Audit outside-in) do CODE
# dựng — fixture W81.2–W81.4 (tên người giả lập) + snapshot cockpit.

V81_HEADS = ("## Tiến độ & Sổ quyết định", "## Rủi ro pháp lý mở",
             "## Audit outside-in (P1)")


def _v81_seed(db, tmp_path):
    from agents import ceo_decisions as cd
    from tests.test_ceo_audit import seed

    tc = _TxConn(db)
    m = ck.load_metrics()
    ck.store(tc, [{"channel": "noi_bo", "metric_id": "leads.new",
                   "period_kind": "week", "period_start": ps,
                   "value": Decimal(n), "source": "api",
                   "source_ref": "db:leads"}
                  for ps, n in ((W40, 120), (W41, 137))],
             "agent:cockpit", metrics=m)
    info = seed(db, tmp_path)
    cd.record(tc, topic="Triển khai quầy quà Tết", decision="Đồng ý",
              by="Thư Ký Giả Lập", basis_kind="van_ban",
              decided_by="TGĐ Giả Lập", note="Biên bản họp HĐTV số 05",
              decided_on=date(2026, 10, 1), due=date(2026, 10, 5),
              today=NOW.date())
    db.execute("insert into project_milestones (code, title, owner_role,"
               " due_date, gate, status, source) values ('XNQC-NOP', 'Nộp"
               " hồ sơ XNQC', 'phap_che', '2026-10-09', 'biên nhận',"
               " 'dang_lam', 'test')")
    return tc, info


def _expected_sections(tc):
    from agents import ceo_audit, ceo_decisions, ceo_risk

    cur, tr = ceo_risk.compute(tc, NOW)
    return ["\n".join(ceo_decisions.render_section(ceo_decisions.read(tc),
                                                   NOW.date())),
            "\n".join(ceo_risk.render_section(cur, tr, NOW)),
            "\n".join(ceo_audit.render_section(
                ceo_audit.collect(tc),
                report_name="ceo-audit-2026-10-12.md"))]


def test_v81_page_has_three_code_sections(db, tmp_path, monkeypatch, capsys):
    tc, info = _v81_seed(db, tmp_path)
    monkeypatch.setattr(cr, "connect", lambda: tc)
    out = tmp_path / "out"
    assert cr.main(["--ref", "2026-10-05", "--out-dir", str(out)],
                   now=NOW) == 0
    page = (out / "ceo-2026-W41.md").read_bytes().decode("utf-8")
    pos = [page.index(h) for h in ("## Thời gian duyệt của TGĐ", *V81_HEADS,
                                   "## Nhận xét")]
    assert pos == sorted(pos)
    # mọi số trong 3 section == hàm thuần trên cùng fixture
    for block in _expected_sections(tc):
        assert block in page
    assert ("quá hạn thực hiện: 1" in page
            and "**TRỄ** XNQC-NOP" in page)
    assert "| facebook | 4 | 1 | 25% |" in page
    assert "| shopee | 4 | 1 | 25% |" in page
    assert "khớp 2/8 (25%)" in page
    assert "| ĐỎ | TUYEN-CANH-BAO |" in page
    # trang sạch guardrail dù fixture có bài lệch; không chép text bài
    assert "CẢNH BÁO GUARDRAIL" not in page
    rep = cr.build(tc, "week", W41, now=NOW,
                   sections=cr.compute_sections(tc, NOW))
    assert cr.finalize(rep)[1] is True
    for t in info["texts"].values():
        assert t not in page
    for t in info["titles"]:
        assert t not in page
    assert "0905123456" not in page
    # --submit: payload = trang có 3 section, sha256 = sha(payload)
    capsys.readouterr()
    assert cr.main(["--ref", "2026-10-05", "--submit", "--out-dir",
                    str(out)], now=NOW) == 0
    payload, sha = db.execute(
        "select payload, content_sha256 from approval_queue where"
        " object_type = 'weekly_report'").fetchone()
    assert all(h in payload for h in V81_HEADS)
    import hashlib
    assert sha == hashlib.sha256(payload.encode("utf-8")).hexdigest()
    assert payload == (out / "ceo-2026-W41.md").read_bytes().decode("utf-8")


def test_v81_bare_ascii_db_strings_do_not_fail_page(db, tmp_path):
    """Cold-check MAJOR: guardrail gập dấu → chữ TRẦN 'chua'/'thuoc' trong
    slug URL bài bị audit bắt, decided_by, mã mốc trễ bị coi là từ cấm
    → finalize ok=False, chặn --submit. Section chỉ chép #id / thay chuỗi
    trượt bằng HIDDEN; URL đầy đủ chỉ ở file ceo-audit-<ngày>.md."""
    from agents import ceo_audit
    from agents import ceo_decisions as cd
    from agents.ra_kenh import HIDDEN

    tc, _ = _v81_seed(db, tmp_path)
    # slug sort TRƯỚC posts/p3 → nằm trong 5 phát hiện hiện trên trang
    url = "https://www.facebook.com/samsam/posts/sam-ngoc-linh-chua-qua"
    pid = db.execute(
        "insert into channel_posts (url, channel, content_type, is_ai, text,"
        " text_sha256, guardrail, codes, imported_by, scanned_at) values"
        " (%s, 'facebook', 'post', true, 'bài mẫu', %s, '{}', %s, 'Người Test',"
        " %s) returning id",
        (url, "0" * 64, ["thieu_ban_duyet"], NOW)).fetchone()[0]
    cd.record(tc, topic="Mở quầy mới", decision="Đồng ý", by="Thư Ký Giả Lập",
              basis_kind="van_ban", decided_by="Nguyen Van Thuoc",
              note="Biên bản họp HĐTV số 06", decided_on=date(2026, 10, 1),
              due=date(2026, 10, 6), today=NOW.date())
    db.execute("insert into project_milestones (code, title, owner_role,"
               " due_date, gate, status, source) values ('CHUA-KY-HD', 'Ký"
               " hợp đồng', 'kho thuoc', '2026-10-08', 'biên bản',"
               " 'dang_lam', 'test')")
    data = ceo_audit.collect(tc)
    assert ("facebook", "thieu_ban_duyet", url) in {
        (f["channel"], f["code"], f["ref"])
        for f in ceo_audit.findings(data["items"])}
    secs = cr.compute_sections(tc, NOW)
    page = "\n".join("\n".join(s) for s in secs)
    for raw in ("sam-ngoc-linh-chua", "Thuoc", "CHUA-KY-HD", "kho thuoc",
                "samsam/posts/"):
        assert raw not in page, raw
    assert f"thieu_ban_duyet — post #{pid}" in page
    assert re.search(r"— listing market_rows #\d+$", page, re.MULTILINE)
    assert f"người quyết {HIDDEN}" in page and f"**TRỄ** {HIDDEN}" in page
    rep = cr.build(tc, "week", W41, now=NOW, sections=secs)
    text, ok = cr.finalize(rep)
    assert ok is True and "CẢNH BÁO GUARDRAIL" not in text
    # bản tin chép cùng section
    assert guardrail_ok("\n".join(cr.bulletin_extra(secs)))
    # file report (không qua finalize) vẫn giữ URL đầy đủ để tra
    full = "\n".join(ceo_audit.render_section(data, limit=None,
                                              full_ref=True))
    assert url in full


def guardrail_ok(text) -> bool:
    from pipelines.guardrail import check
    return check(text)["ok"] is True


def test_v81_llm_prompt_unchanged_by_sections():
    base = _rep()
    with_sec = _rep(sections=[["## Rủi ro pháp lý mở", "", "Đỏ 3 · 12%"]])
    assert cr.llm_prompt(base) == cr.llm_prompt(with_sec)
    assert cr.commentary_values(base) == cr.commentary_values(with_sec)
    assert cr.rule_commentary(base) == cr.rule_commentary(with_sec)
    page = cr.render(with_sec)
    assert page.index("## Rủi ro pháp lý mở") < page.index("## Nhận xét")
    assert cr.render(base) == cr.render(_rep(sections=None))
    assert "## Rủi ro pháp lý mở" not in cr.render(base)


def test_v81_section_failure_isolated(db, tmp_path, monkeypatch):
    from agents import ceo_decisions, ceo_risk

    tc, _ = _v81_seed(db, tmp_path)

    def boom(*a, **k):
        raise ValueError("data/ceo_risk.json hỏng: JSONDecodeError")

    def bad_sql(conn, today):     # lỗi DB giữa section → chỉ savepoint hỏng
        conn.execute("select * from bang_khong_ton_tai")

    monkeypatch.setattr(ceo_risk, "section", boom)
    monkeypatch.setattr(ceo_decisions, "section", bad_sql)
    monkeypatch.setattr(cr, "connect", lambda: tc)
    out = tmp_path / "o2"
    assert cr.main(["--ref", "2026-10-05", "--out-dir", str(out)],
                   now=NOW) == 0
    page = (out / "ceo-2026-W41.md").read_bytes().decode("utf-8")
    assert ("## Rủi ro pháp lý mở\n\n*(không đọc được: ValueError: "
            "data/ceo_risk.json hỏng: JSONDecodeError)*") in page
    assert "## Tiến độ & Sổ quyết định\n\n*(không đọc được:" in page
    assert "bang_khong_ton_tai" in page
    assert "| facebook | 4 | 1 | 25% |" in page        # audit vẫn ra
    assert "## Nhận xét" in page and "137 lead" in page


def test_v81_bulletin_db(db, tmp_path, monkeypatch, capsys):
    tc, _ = _v81_seed(db, tmp_path)
    monkeypatch.setattr(cr, "connect", lambda: tc)
    out = tmp_path / "b"
    assert cr.main(["--bulletin", "--now", "2026-10-12T09:00", "--out-dir",
                    str(out)]) == 0
    md = (out / "director-ceo-2026-10-12.md").read_bytes().decode("utf-8")
    pos = [md.index(h) for h in V81_HEADS]
    assert pos == sorted(pos) and pos[-1] < md.index("## Người duyệt")
    assert md.startswith("# Bản tin GĐ ")
    assert "| facebook | 4 | 1 | 25% |" in md
    assert "[bulletin]" in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["--bulletin", "--submit"], ["--bulletin", "--llm"],
    ["--bulletin", "--period", "week"], ["--bulletin", "--ref", "2026-10-05"],
    ["--bulletin", "--now", "12/10/2026"], ["--now", "2026-10-12T09:00"]])
def test_v81_bulletin_usage_exit2_before_connect(monkeypatch, argv):
    monkeypatch.setattr(cr, "connect", _no_connect)
    with pytest.raises(SystemExit) as e:
        cr.main(argv, now=NOW)
    assert e.value.code == 2


def test_v81_bulletin_db_down(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "connect", lambda: None)
    assert cr.main(["--bulletin", "--out-dir", str(tmp_path)], now=NOW) == 2
    assert list(tmp_path.iterdir()) == []
