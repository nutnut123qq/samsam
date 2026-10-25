"""v7.3 W73.3–W73.5 — persona_sim: kiểm đầu vào, cổng DPIA, ma trận
3×3×5 có đối chứng, sim_runs, báo cáo khoảng.

Không gọi LLM thật: gateway giả (dry-run) hoặc monkeypatch
`llm_gateway.chat`. DB thật chỉ trong schema tạm + ROLLBACK.
"""

import copy
import datetime as dt
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest

from ingest import golden_store
from pipelines import llm_gateway

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import persona_sim as ps

CFG = json.loads(ps.CONFIG_FILE.read_text(encoding="utf-8"))
PERS = json.loads(ps.PERSONAS_FILE.read_text(encoding="utf-8"))
GOLDEN = golden_store.read_golden(golden_store.GOLDEN_FILE)[0]
RUN_DATE = dt.date(2026, 10, 12)
N_OPT = len(CFG["options"])


def _v(cfg=None, pers=None):
    return ps.validate_inputs(cfg or CFG, pers or PERS, GOLDEN)


# ---------- W73.4 validate ----------

def test_validate_repo_files_ok():
    assert _v() == []
    assert CFG["dpia_signed"] is False          # drift-guard: không tự ký
    assert PERS["synthetic"] is True
    assert all(p["age_min"] >= 18 for p in PERS["personas"])
    assert 6 <= len(PERS["personas"]) <= 10
    assert len(CFG["models"]) == 3 and len(CFG["prompts"]) == 3
    assert CFG["repeats"] >= 5
    assert sum(o.get("control") is True for o in CFG["options"]) == 1


def _pers(mut):
    d = copy.deepcopy(PERS)
    mut(d)
    return d


def _cfg(mut):
    d = copy.deepcopy(CFG)
    mut(d)
    return d


def _add_opt(text, **kw):
    def m(d):
        d["options"].append({"id": "x-opt", "kind": "brand_theme",
                             "sku_keys": [], "text": text, **kw})
    return m


VALIDATE_CASES = {
    "persona_order_id": (None, _pers(
        lambda d: d["personas"][0].update(order_id="DH0001"))),
    "persona_user_hash": (None, _pers(
        lambda d: d["personas"][1].update(user_hash="ab12cd34"))),
    "persona_phone": (None, _pers(
        lambda d: d["personas"][2].update(label="Gọi 0905123456"))),
    "persona_phone_in_trait": (None, _pers(
        lambda d: d["personas"][2]["traits"].append("zalo 0905123456"))),
    "persona_email_key": (None, _pers(
        lambda d: d["personas"][3].update(email="a@b.vn"))),
    "persona_17_alcohol": (
        _cfg(_add_opt("Rượu sâm Ngọc Linh làm quà biếu Tết")),
        _pers(lambda d: d["personas"][0].update(age_min=17))),
    "alcohol_gen_z": (_cfg(_add_opt("Thông điệp rượu sâm cho Gen Z")), None),
    "alcohol_sku_youth_panel": (_cfg(lambda d: d["options"].append(
        {"id": "x-opt", "kind": "brand_theme",
         "sku_keys": ["ruou-sam-binh-su-do-500ml"],
         "text": "Bình sứ đỏ quà Tết"})), None),
    "banned_word": (_cfg(_add_opt("Sâm chữa mệt mỏi")), None),
    "tpbvsk_no_xnqc_product": (_cfg(_add_opt(
        "Saphraton 20 viên quà Tết", kind="product",
        sku_keys=["saphraton-20v"])), None),
    "unknown_sku": (_cfg(_add_opt("Quà Tết", sku_keys=["khong-co"])), None),
    "repeats_4": (_cfg(lambda d: d.update(repeats=4)), None),
    "repeats_bool": (_cfg(lambda d: d.update(repeats=True)), None),
    "two_models": (_cfg(lambda d: d["models"].pop()), None),
    "two_prompts": (_cfg(lambda d: d["prompts"].pop()), None),
    "zero_control": (_cfg(lambda d: d["options"][-1].pop("control")), None),
    "two_control": (_cfg(lambda d: d["options"][0].update(control=True)),
                    None),
    "one_normal_option": (_cfg(lambda d: d.update(
        options=[d["options"][0], d["options"][-1]])), None),
    "prompt_no_placeholder": (_cfg(lambda d: d["prompts"][0].update(
        text="Chấm điểm đi")), None),
    "synthetic_false": (None, _pers(lambda d: d.update(synthetic=False))),
    "persona_no_source": (None, _pers(
        lambda d: d["personas"][0].pop("source"))),
    "persona_count_5": (None, _pers(
        lambda d: d.update(personas=d["personas"][:5]))),
    "persona_count_11": (None, _pers(
        lambda d: d.update(personas=d["personas"] + [
            dict(p, id=f"{p['id']}-b") for p in d["personas"][:3]]))),
    "temperature_nan": (_cfg(lambda d: d.update(temperature=float("nan"))),
                        None),
    "dup_option_id": (_cfg(lambda d: d["options"][1].update(
        id=d["options"][0]["id"])), None),
}


@pytest.mark.parametrize("name", list(VALIDATE_CASES))
def test_validate_rejects(name):
    cfg, pers = VALIDATE_CASES[name]
    errs = _v(cfg, pers)
    assert errs, name
    blob = "\n".join(errs)
    # Thông báo lỗi KHÔNG chứa giá trị ô.
    for secret in ("0905123456", "DH0001", "ab12cd34", "a@b.vn", "Gen Z",
                   "chữa", "Rượu sâm"):
        assert secret not in blob, (name, blob)


def test_validate_specific_reasons():
    assert any("rượu" in e for e in _v(*VALIDATE_CASES["persona_17_alcohol"]))
    assert any(">= 18" in e for e in _v(*VALIDATE_CASES["persona_17_alcohol"]))
    assert any("giới trẻ" in e for e in _v(*VALIDATE_CASES["alcohol_gen_z"]))
    assert any("XNQC" in e
               for e in _v(*VALIDATE_CASES["tpbvsk_no_xnqc_product"]))
    assert any("order_id" in e for e in _v(*VALIDATE_CASES["persona_order_id"]))
    assert any("guardrail" in e for e in _v(*VALIDATE_CASES["banned_word"]))
    # TPBVSK chưa XNQC nhưng làm brand_theme -> hợp lệ.
    ok = _cfg(_add_opt("Câu chuyện vườn sâm", sku_keys=["saphraton-20v"]))
    assert _v(ok) == []
    # Gộp M31 (v4.1 guardrail v2 chặn MỌI nội dung rượu): phương án rượu bị
    # loại kể cả với panel toàn người lớn — guardrail là nguồn quyết định.
    adult = _pers(lambda d: [p.update(youth=False) for p in d["personas"]])
    errs = _v(_cfg(_add_opt("Rượu sâm làm quà biếu đối tác")), adult)
    assert errs and all("guardrail" in e for e in errs)
    # So không dấu + biên từ: "sinh viên" không dấu cũng bắt.
    assert _v(_cfg(_add_opt("ruou sam cho sinh vien")), adult)


def test_validate_bad_roots():
    assert ps.validate_inputs([], PERS, GOLDEN)
    assert ps.validate_inputs(CFG, [], GOLDEN)
    assert ps.validate_inputs(CFG, {}, GOLDEN)


# ---------- W73.5 ----------

class FakeConn:
    def __init__(self):
        self.rows, self.commits, self.closed = [], 0, False

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def executemany(self, sql, params):
        self.sql = sql
        self.rows.extend(params)

    def commit(self):
        self.commits += 1

    def close(self):
        self.closed = True


# r13: lượt thật cần >= 3 nhà cung cấp khác nhau — cấu hình THỬ (tên model giả).
MULTI = ["openai/gpt-4o-mini", "anthropic/model-gia-thu", "google/model-gia-thu"]


def _signed_multi(d):
    d.update(dpia_signed=True)
    for m, mid in zip(d["models"], MULTI):
        m["id"] = mid


def _write_cfg(tmp_path, mut):
    d = copy.deepcopy(CFG)
    mut(d)
    p = tmp_path / "sim_config.json"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


def _no_llm_no_db(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("không được gọi")
    monkeypatch.setattr(llm_gateway, "chat", boom)
    monkeypatch.setattr(ps, "_connect", boom)


@pytest.mark.parametrize("mut", [
    lambda d: None,                              # repo: false
    lambda d: d.pop("dpia_signed"),              # thiếu key
    lambda d: d.update(dpia_signed="true"),      # chuỗi
    lambda d: d.update(dpia_signed=1),
], ids=["false", "missing", "str_true", "int_1"])
def test_dpia_gate_refuses(tmp_path, monkeypatch, capsys, mut):
    """File chuẩn CONFIG_FILE trỏ CÙNG file đã đổi (cả 2 phía mang giá trị
    biến thể) -> từ chối chỉ có thể đến từ so khớp `is True` nghiêm ngặt,
    không phải vì file repo vẫn false (mutant `bool(...)` phải đỏ)."""
    _no_llm_no_db(monkeypatch)
    p = _write_cfg(tmp_path, mut)
    monkeypatch.setattr(ps, "CONFIG_FILE", p)
    rc = ps.main(["--config", str(p)])
    err = capsys.readouterr().err
    assert rc == 2
    assert "[refuse]" in err and "DPIA" in err


def test_dpia_gate_opens_only_on_true_both_sides(tmp_path, monkeypatch):
    """Đối chứng dương cho test trên: cả 2 phía `true` (bool) -> cổng mở,
    chạm lời gọi THẬT (gateway_chat bị thay bằng sentinel, không gọi LLM)."""
    _no_llm_no_db(monkeypatch)

    class Opened(Exception):
        pass

    def sentinel(*a, **k):
        raise Opened

    monkeypatch.setattr(ps, "gateway_chat", sentinel)
    p = _write_cfg(tmp_path, _signed_multi)
    monkeypatch.setattr(ps, "CONFIG_FILE", p)
    with pytest.raises(Opened):
        ps.main(["--config", str(p)])


def test_dpia_gate_reads_canonical_config(tmp_path, monkeypatch, capsys):
    """--config trỏ file tự ghi dpia_signed=true KHÔNG mở được cổng khi
    file chuẩn data/sim_config.json vẫn false (chống lách cổng DPIA)."""
    _no_llm_no_db(monkeypatch)
    p = _write_cfg(tmp_path, lambda d: d.update(dpia_signed=True))
    assert ps.main(["--config", str(p)]) == 2
    assert "[refuse]" in capsys.readouterr().err
    # file chuẩn thiếu/hỏng cũng tính chưa ký
    monkeypatch.setattr(ps, "CONFIG_FILE", tmp_path / "missing.json")
    assert ps.main(["--config", str(p)]) == 2


def test_invalid_inputs_exit_1_before_llm_and_db(tmp_path, monkeypatch,
                                                 capsys):
    _no_llm_no_db(monkeypatch)
    p = _write_cfg(tmp_path, lambda d: d.update(repeats=4, dpia_signed=True))
    assert ps.main(["--config", str(p)]) == 1
    assert "[err]" in capsys.readouterr().err
    for content in ("", "{bad", "[]"):
        p.write_text(content, encoding="utf-8")
        assert ps.main(["--config", str(p), "--dry-run"]) == 1
    assert ps.main(["--config", str(tmp_path / "missing.json")]) == 1


def _count_chat():
    inner = ps.fake_chat(CFG["options"])
    calls = []

    def chat(model, msgs, temp, seed):
        calls.append((model, temp, seed))
        return inner(model, msgs, temp, seed)
    return chat, calls


def test_dry_run_matrix_counts_and_fields():
    chat, calls = _count_chat()
    rows, n = ps.run_matrix(CFG, PERS, CFG["options"], chat, RUN_DATE,
                            run_id="t-1", persona_set_hash="abc123abc123",
                            dry_run=True)
    assert n == len(calls) == 3 * 3 * 5 == 45
    assert len(rows) == 45 * N_OPT == 180
    for r in rows:
        for k in ("model", "provider", "model_version", "prompt_id",
                  "prompt_hash", "seed", "seed_supported", "run_date",
                  "persona_set_hash", "persona_set"):
            assert r[k] is not None, k
        assert r["run_date"] == RUN_DATE and r["dry_run"] is True
        assert r["provider"] == r["model"].split("/")[0]
        assert len(r["prompt_hash"]) == 12
    combos = {(r["model"], r["prompt_id"], r["sample_idx"]) for r in rows}
    assert len(combos) == 45
    for c in combos:
        assert sum(r["is_control"] for r in rows
                   if (r["model"], r["prompt_id"], r["sample_idx"]) == c) == 1
    # Tất định: chạy lại cùng tham số -> cùng điểm.
    rows2, _ = ps.run_matrix(CFG, PERS, CFG["options"],
                             ps.fake_chat(CFG["options"]), RUN_DATE,
                             run_id="t-1", persona_set_hash="abc123abc123",
                             dry_run=True)
    assert [r["score"] for r in rows] == [r["score"] for r in rows2]
    s = ps.summarize(rows)
    assert s["usable"] and s["control_last_rate"] == 1.0


def test_prompt_hash_crlf_stable():
    assert ps.prompt_hash("a\r\nb") == ps.prompt_hash("a\nb")
    assert ps.prompt_hash("a") != ps.prompt_hash("b")


def test_dry_run_main_writes_180_and_reports(monkeypatch, capsys):
    monkeypatch.setattr(llm_gateway, "chat", lambda *a, **k: (_ for _ in ()
                        ).throw(AssertionError("dry-run gọi LLM")))
    fake = FakeConn()
    monkeypatch.setattr(ps, "_connect", lambda: fake)
    assert ps.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert len(fake.rows) == 180 and fake.commits == 1 and fake.closed
    assert "insert into sim_runs" in fake.sql
    assert "DRY-RUN" in out and "KHÔNG phải dự báo doanh số" in out
    assert "WEIRD" in out and "p10" in out
    i_dry = ps.SIM_COLS.index("dry_run")
    assert all(r[i_dry] is True for r in fake.rows)


def _resp(text, model="openai/gpt-4o-mini-2024-07-18"):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        model=model)


def test_real_path_uses_gateway_agent_and_params(tmp_path, monkeypatch,
                                                 capsys):
    seen = []
    ids = [o["id"] for o in CFG["options"]]

    def gw_chat(agent_id, messages, model=None, **kw):
        seen.append((agent_id, model, kw["temperature"], kw["seed"]))
        return _resp(json.dumps({i: (1 if i == "doi-chung-yeu" else 7)
                                 for i in ids}))
    monkeypatch.setattr(llm_gateway, "chat", gw_chat)
    fake = FakeConn()
    monkeypatch.setattr(ps, "_connect", lambda: fake)
    p = _write_cfg(tmp_path, _signed_multi)
    monkeypatch.setattr(ps, "CONFIG_FILE", p)
    assert ps.main(["--config", str(p)]) == 0
    out = capsys.readouterr().out
    assert "DRY-RUN" not in out
    assert len(seen) == 45
    assert {a for a, *_ in seen} == {"persona_sim"}
    assert {m for _, m, *_ in seen} == set(MULTI)
    assert {t for *_, t, _ in seen} == {CFG["temperature"]}
    base = CFG["base_seed"]
    assert sorted({s for *_, s in seen}) == [base + i for i in range(5)]
    # thứ tự lời gọi: mỗi (model, prompt) seed base+0..4
    assert [s for *_, s in seen[:5]] == [base + i for i in range(5)]
    i_ver = ps.SIM_COLS.index("model_version")
    assert all(r[i_ver] == "openai/gpt-4o-mini-2024-07-18" for r in fake.rows)


def test_guardrail_and_parse_failures_null_score():
    ids = [o["id"] for o in CFG["options"]]
    good = json.dumps({i: (1 if i == "doi-chung-yeu" else 7) for i in ids})
    n = {"i": 0}

    def chat(model, msgs, temp, seed):
        n["i"] += 1
        if n["i"] == 1:
            return good + " sản phẩm này là thuốc", model     # từ cấm
        if n["i"] == 2:
            return "{không phải json", model
        if n["i"] == 3:
            return json.dumps({ids[0]: 11}), model             # ngoài 0..10
        return good, model
    rows, calls = ps.run_matrix(CFG, PERS, CFG["options"], chat, RUN_DATE)
    by_call = {}
    for r in rows:
        by_call.setdefault((r["model"], r["prompt_id"], r["sample_idx"]),
                           []).append(r)
    first, second, third = list(by_call.values())[:3]
    assert all(not r["guardrail_ok"] and r["score"] is None for r in first)
    assert all(r["parse_ok"] for r in first)
    assert all(not r["parse_ok"] and r["score"] is None for r in second)
    assert all(r["guardrail_ok"] for r in second)
    assert all(not r["parse_ok"] for r in third)
    s = ps.summarize(rows)
    assert s["n_valid_calls"] == calls - 3
    text = ps.report(s, run_id="t", persona_set="v1",
                     persona_set_hash="h", dry_run=False)
    assert "7.0 – 7.0" in text and "KHÔNG phải dự báo doanh số" in text


def test_gateway_blocked_midway_writes_nothing(tmp_path, monkeypatch,
                                               capsys):
    ids = [o["id"] for o in CFG["options"]]
    n = {"i": 0}

    def gw_chat(agent_id, messages, model=None, **kw):
        n["i"] += 1
        if n["i"] == 10:
            raise llm_gateway.GatewayBlocked("agent 'persona_sim' vượt trần")
        return _resp(json.dumps({i: 5 for i in ids}))
    monkeypatch.setattr(llm_gateway, "chat", gw_chat)
    connects = []
    monkeypatch.setattr(ps, "_connect", lambda: connects.append(1))
    p = _write_cfg(tmp_path, _signed_multi)
    monkeypatch.setattr(ps, "CONFIG_FILE", p)
    assert ps.main(["--config", str(p)]) == 1
    cap = capsys.readouterr()
    assert n["i"] == 10 and connects == []
    assert "GatewayBlocked" in cap.err and "0 dòng" in cap.err
    assert "p10" not in cap.out


def _rows(calls):
    """calls: list[dict option_id -> score|None]; option 'c' = đối chứng."""
    rows = []
    for i, sc in enumerate(calls):
        for oid, v in sc.items():
            rows.append({"model": "m/x", "prompt_id": "p", "sample_idx": i,
                         "option_id": oid, "is_control": oid == "c",
                         "score": v})
    return rows


def test_summarize_hand_data_with_ties():
    rows = _rows([
        {"a": 6, "b": 8, "c": 1},     # c thấp nhất
        {"a": 5, "b": 7, "c": 5},     # hòa với a -> không tính
        {"a": 9, "b": 4, "c": 2},     # c thấp nhất
        {"a": 7, "b": 6, "c": 3},     # c thấp nhất
        {"a": 8, "b": 9, "c": None},  # lời gọi lỗi -> loại
    ])
    s = ps.summarize(rows)
    assert s["n_calls"] == 5 and s["n_valid_calls"] == 4
    assert s["control_last"] == 3 and s["control_last_rate"] == 0.75
    assert s["usable"] is False and s["flag"] == ps.UNUSABLE
    for o in s["options"].values():
        assert o["p10"] <= o["p50"] <= o["p90"]
        assert o["spread"] == o["p90"] - o["p10"]
        assert o["n_valid"] == 4
    a = s["options"]["a"]
    assert a["p50"] == 6.5
    text = ps.report(s, run_id="t", persona_set="v1", persona_set_hash="h",
                     dry_run=True)
    assert ps.UNUSABLE in text and "DRY-RUN" in text
    good = ps.summarize(_rows([{"a": 6, "b": 8, "c": 1}] * 5))
    assert good["usable"] and good["flag"] is None
    assert good["options"]["a"]["p10"] == good["options"]["a"]["p90"] == 6


def test_summarize_too_few_valid_flagged():
    calls = [{"a": 6, "b": 8, "c": 1}] * 2 + [{"a": None, "b": None,
                                               "c": None}] * 3
    s = ps.summarize(_rows(calls))
    assert s["control_last_rate"] == 1.0 and s["usable"] is False


def test_parse_scores_variants():
    ids = ["a", "b"]
    assert ps.parse_scores('```json\n{"a": 3, "b": 9.5}\n```', ids) == {
        "a": 3.0, "b": 9.5}
    assert ps.parse_scores("{" * 5000 + '{"a": 1, "b": 2}', ids) is None
    assert ps.parse_scores(" " * 20001 + '{"a": 1, "b": 2}', ids) is None
    for bad in (None, "", "{}", '{"a": 3}', '{"a": true, "b": 2}',
                '{"a": NaN, "b": 2}', '{"a": -1, "b": 2}', '[1, 2]',
                '{"a": "3", "b": 2}',
                # int khổng lồ: math.isfinite(int) từng raise OverflowError
                '{"a": 1' + "0" * 400 + ', "b": 2}'):
        assert ps.parse_scores(bad, ids) is None, bad


def test_cli_subprocess_refuses_without_dpia():
    env = {k: v for k, v in os.environ.items() if k != "PYTHONIOENCODING"}
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "persona_sim.py")],
                       cwd=ROOT, capture_output=True, timeout=120, env=env,
                       check=False)
    assert r.returncode == 2
    assert "DPIA" in r.stderr.decode("utf-8")


# ---------- DB thật: schema tạm + ROLLBACK ----------

SCHEMA_SQL = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")


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
        schema = f"t_sim_{uuid.uuid4().hex[:12]}"
        conn.execute(f"create schema {schema}")
        conn.execute(f"set local search_path to {schema}")
        conn.execute(SCHEMA_SQL)
        conn.execute(SCHEMA_SQL)
        assert conn.execute("select to_regclass(%s) is not null",
                            (f"{schema}.sim_runs",)).fetchone()[0]
        yield conn
    finally:
        conn.rollback()
        conn.close()


def test_db_dry_run_rows(db):
    rows, n = ps.run_matrix(CFG, PERS, CFG["options"],
                            ps.fake_chat(CFG["options"]), RUN_DATE,
                            run_id="t-db-1", dry_run=True)
    assert ps.write_rows(db, rows, commit=False) == 180
    assert db.execute("select count(*) from sim_runs where run_id = 't-db-1'"
                      ).fetchone()[0] == 180
    assert db.execute(
        "select count(*) from sim_runs where model_version is null or"
        " provider is null or prompt_hash is null or seed is null"
        " or persona_set_hash is null").fetchone()[0] == 0
    assert db.execute("select count(distinct (model, prompt_id, sample_idx))"
                      " from sim_runs").fetchone()[0] == n == 45
    assert db.execute("select count(*) from sim_runs where is_control"
                      ).fetchone()[0] == 45
    with pytest.raises(psycopg.errors.UniqueViolation):
        ps.write_rows(db, rows[:1], commit=False)


def test_db_score_check_constraint(db):
    rows, _ = ps.run_matrix(CFG, PERS, CFG["options"],
                            ps.fake_chat(CFG["options"]), RUN_DATE,
                            run_id="t-db-2", dry_run=True)
    bad = dict(rows[0], score=11)
    with pytest.raises(psycopg.errors.CheckViolation):
        ps.write_rows(db, [bad], commit=False)


def test_real_run_needs_three_providers_zero_calls(tmp_path, monkeypatch, capsys):
    """r13: DPIA đã ký nhưng 3 model cùng 1 nhà cung cấp → [refuse] exit 2, 0 lời gọi."""
    _no_llm_no_db(monkeypatch)
    monkeypatch.setattr(ps, "gateway_chat", lambda *a, **k: pytest.fail("không được gọi LLM"))
    p = _write_cfg(tmp_path, lambda d: d.update(dpia_signed=True))
    monkeypatch.setattr(ps, "CONFIG_FILE", p)
    assert ps.main(["--config", str(p)]) == 2
    assert "nhà cung cấp" in capsys.readouterr().err
