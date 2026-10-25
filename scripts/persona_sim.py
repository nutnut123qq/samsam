"""Nghiên cứu giả lập persona (v7.3, WP09 — gộp MKT-08).

Persona TỔNG HỢP (`data/personas.json`, không dữ liệu khách thật) chấm
điểm 0..10 cho các phương án truyền thông (`data/sim_config.json`), ma
trận 3 model × 3 prompt × ≥5 lần lặp qua `pipelines.llm_gateway.chat`
(agent_id `persona_sim`, kill-switch + cap tháng + mask PII ở gateway).
Có đúng 1 phương án ĐỐI CHỨNG cố tình yếu: nếu mô hình không xếp nó thấp
nhất ở ≥80% lời gọi hợp lệ thì cả kết quả bị gắn cờ "KHÔNG DÙNG ĐƯỢC".

Kết quả = KHOẢNG p10/p50/p90 + độ phân tán theo phương án — KHÔNG phải dự
báo doanh số, chỉ dùng để loại bớt phương án yếu. Agent không đặt hàng,
không đổi giá, không ghi orders/products/golden, không đăng bài.

Thứ tự (fail-closed):
  1. đọc + `validate_inputs()` — lỗi -> `[err]` exit 1, 0 LLM, 0 connect.
  2. CỔNG DPIA: không `--dry-run` và `dpia_signed is not True` -> exit 2.
     Cờ đọc từ file CHUẨN `data/sim_config.json` (CONFIG_FILE) — `--config`
     trỏ file khác ghi `true` KHÔNG mở được cổng (cả 2 phải true).
  3. `run_matrix()` — đúng 1 lời gọi / (model, prompt, lần lặp); mỗi
     phản hồi qua `guardrail.check()`; GatewayError/Blocked -> exit 1,
     0 dòng ghi (không nạp nửa vời).
  4. báo cáo qua `guardrail.check()` -> ghi `sim_runs` 1 transaction ->
     in báo cáo. `--dry-run` dùng gateway GIẢ tất định (số giả).

Chạy: python scripts/persona_sim.py --dry-run [--config F] [--personas F]
Exit: 0 OK; 1 lỗi dữ liệu/gateway/DB; 2 DPIA chưa ký hoặc sai usage.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import statistics
import sys
import uuid
from pathlib import Path

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg
from dotenv import load_dotenv

from ingest import golden_store
from pipelines import guardrail, kb_filter, llm_gateway
from pipelines.llm_gateway import _strip_accents
from pipelines.pii import _mask_pii

AGENT_ID = "persona_sim"
CONFIG_FILE = ROOT / "data" / "sim_config.json"
PERSONAS_FILE = ROOT / "data" / "personas.json"
GOLDEN_FILE = golden_store.GOLDEN_FILE
CONNECT_TIMEOUT_S = 5
MIN_REPEATS, MIN_MODELS, MIN_PROMPTS = 5, 3, 3
MIN_PROVIDERS = 3   # r13: lượt thật — số nhà cung cấp (tiền tố provider/model) khác nhau
N_PERSONAS = (6, 10)
CONTROL_LAST_MIN = 0.8
MAX_RESP_CHARS = 20000   # phản hồi dài hơn = parse lỗi (điểm null)
OPTION_KINDS = ("product", "brand_theme")
PERSONA_KEYS = frozenset({"id", "label", "age_min", "age_max", "region",
                          "sku_group", "youth", "traits", "source"})
_SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_KEY = re.compile(r"[a-z_][a-z0-9_]{0,40}")
_MODEL = re.compile(r"[a-z0-9-]+/[A-Za-z0-9._:-]+")
# So trên text đã bỏ dấu + casefold, biên từ hai phía.
_YOUTH_RE = re.compile(r"(?<!\w)(?:gen ?z|gioi tre|hoc sinh|sinh vien|"
                       r"tuoi teen|teen|thanh thieu nien|tuoi hoc tro)(?!\w)")
INT4_MAX = 2**31 - 1
SIM_COLS = ("run_id", "dry_run", "run_date", "persona_set",
            "persona_set_hash", "model", "provider", "model_version",
            "prompt_id", "prompt_hash", "sample_idx", "temperature", "seed",
            "seed_supported", "option_id", "is_control", "score", "parse_ok",
            "guardrail_ok")
NOT_FORECAST = ("KHÔNG phải dự báo doanh số — chỉ dùng để loại bớt phương "
                "án yếu trước khi thử với khách thật.")
LIMITS = ("Giới hạn: persona tổng hợp + mô hình ngôn ngữ (dữ liệu huấn luyện "
          "thiên lệch WEIRD) không đại diện người tiêu dùng Việt Nam thật.")
UNUSABLE = "KHÔNG DÙNG ĐƯỢC"


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    # int luôn hữu hạn — math.isfinite(int 400 chữ số) raise OverflowError.
    if _is_int(v):
        return True
    return isinstance(v, float) and math.isfinite(v)


def _sha12(data: bytes) -> str:
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()[:12]


def prompt_hash(text: str) -> str:
    """12 hex sha256 text prompt, CRLF->LF (mẫu agent_eval.prompt_version)."""
    return _sha12(text.encode("utf-8"))


def _ref(kind: str, i: int, obj) -> str:
    """Tham chiếu trong thông báo lỗi: chỉ index + id dạng slug — KHÔNG
    in giá trị ô (id lạ có thể chứa PII)."""
    oid = obj.get("id") if isinstance(obj, dict) else None
    if isinstance(oid, str) and _SLUG.fullmatch(oid):
        return f"{kind}[{i}:{oid}]"
    return f"{kind}[{i}]"


def _has_pii(v) -> bool:
    if isinstance(v, str):
        return _mask_pii(v) != v
    if isinstance(v, list):
        return any(_has_pii(x) for x in v)
    return False


def _norm_text(s: str) -> str:
    return _strip_accents(s.casefold())


# ---------- kiểm đầu vào (thuần, trước mọi LLM/DB) ----------

def _check_cfg(cfg: dict, errs: list) -> None:
    r = cfg.get("repeats")
    if not _is_int(r) or r < MIN_REPEATS:
        errs.append(f"sim_config.repeats: phải là int >= {MIN_REPEATS}")
    models = cfg.get("models")
    if not isinstance(models, list) or len(models) < MIN_MODELS:
        errs.append(f"sim_config.models: cần >= {MIN_MODELS} model")
    else:
        seen = set()
        for i, m in enumerate(models):
            ref = f"models[{i}]"
            if not isinstance(m, dict) or not isinstance(m.get("id"), str) \
                    or not _MODEL.fullmatch(m["id"]) or m["id"] in seen:
                errs.append(f"{ref}.id: thiếu/sai dạng provider/model/trùng")
                continue
            seen.add(m["id"])
            if not isinstance(m.get("seed_supported"), bool):
                errs.append(f"{ref}.seed_supported: phải là bool")
    prompts = cfg.get("prompts")
    if not isinstance(prompts, list) or len(prompts) < MIN_PROMPTS:
        errs.append(f"sim_config.prompts: cần >= {MIN_PROMPTS} prompt")
    else:
        seen = set()
        for i, p in enumerate(prompts):
            ref = _ref("prompts", i, p)
            if not isinstance(p, dict) or not isinstance(p.get("id"), str) \
                    or not _SLUG.fullmatch(p["id"]) or p["id"] in seen:
                errs.append(f"{ref}.id: thiếu/sai dạng/trùng")
                continue
            seen.add(p["id"])
            t = p.get("text")
            if not isinstance(t, str) or "{personas}" not in t \
                    or "{options}" not in t:
                errs.append(f"{ref}.text: phải có {{personas}} và {{options}}")
            elif _has_pii(t):
                errs.append(f"{ref}.text: chứa dạng PII (SĐT/email)")
    t = cfg.get("temperature")
    if not _is_num(t) or not 0 <= t <= 2:
        errs.append("sim_config.temperature: phải là số trong 0..2")
    s = cfg.get("base_seed")
    if not _is_int(s) or s < 0 or (_is_int(r) and s + r > INT4_MAX):
        errs.append("sim_config.base_seed: phải là int >= 0 (vừa cột int)")


def _check_personas(doc, errs: list) -> list:
    if not isinstance(doc, dict):
        errs.append("personas: root phải là object")
        return []
    if doc.get("synthetic") is not True:
        errs.append("personas.synthetic: phải là true (chỉ persona tổng hợp)")
    if not isinstance(doc.get("set_id"), str) or not _SLUG.fullmatch(
            doc["set_id"]):
        errs.append("personas.set_id: thiếu/sai dạng")
    ps = doc.get("personas")
    if not isinstance(ps, list) or not \
            N_PERSONAS[0] <= len(ps) <= N_PERSONAS[1]:
        errs.append(f"personas.personas: cần {N_PERSONAS[0]}..{N_PERSONAS[1]}"
                    " persona")
        return ps if isinstance(ps, list) else []
    seen = set()
    for i, p in enumerate(ps):
        ref = _ref("personas", i, p)
        if not isinstance(p, dict):
            errs.append(f"{ref}: phải là object")
            continue
        extra = set(p) - PERSONA_KEYS
        if extra:
            names = sorted(k if _KEY.fullmatch(k) else "<key lạ>"
                           for k in map(str, extra))
            errs.append(f"{ref}: key ngoài allowlist {names}")
        if not isinstance(p.get("id"), str) or not _SLUG.fullmatch(p["id"]) \
                or p["id"] in seen:
            errs.append(f"{ref}.id: thiếu/sai dạng/trùng")
        else:
            seen.add(p["id"])
        if not isinstance(p.get("source"), str) or not p["source"].strip():
            errs.append(f"{ref}.source: thiếu nguồn giả định")
        amin, amax = p.get("age_min"), p.get("age_max")
        if not _is_int(amin) or not _is_int(amax) or amax < amin:
            errs.append(f"{ref}.age_min/age_max: phải là int, min <= max")
        elif amin < 18:
            errs.append(f"{ref}.age_min: persona phải >= 18 tuổi")
        if not isinstance(p.get("youth"), bool):
            errs.append(f"{ref}.youth: phải là bool")
        if "traits" in p and not (isinstance(p["traits"], list) and all(
                isinstance(x, str) for x in p["traits"])):
            errs.append(f"{ref}.traits: phải là list chuỗi")
        for k, v in p.items():
            if _has_pii(v):
                kk = k if k in PERSONA_KEYS else "<key lạ>"
                errs.append(f"{ref}.{kk}: chứa dạng PII (SĐT/email)")
    return ps


def _minor_or_youth(ps: list) -> bool:
    return any(isinstance(p, dict) and (
        p.get("youth") is not False
        or not _is_int(p.get("age_min")) or p["age_min"] < 18) for p in ps)


def _check_options(cfg: dict, ps: list, golden, errs: list) -> None:
    opts = cfg.get("options")
    if not isinstance(opts, list):
        errs.append("sim_config.options: phải là list")
        return
    skus = {s.get("sku_key"): s for s in (golden or {}).get("skus") or []
            if isinstance(s, dict)}
    controls = [o for o in opts if isinstance(o, dict)
                and o.get("control") is True]
    if len(controls) != 1:
        errs.append(f"sim_config.options: cần đúng 1 đối chứng (control), "
                    f"có {len(controls)}")
    if len(opts) - len(controls) < 2:
        errs.append("sim_config.options: cần >= 2 phương án thường")
    seen = set()
    youth_panel = _minor_or_youth(ps)
    for i, o in enumerate(opts):
        ref = _ref("options", i, o)
        if not isinstance(o, dict):
            errs.append(f"{ref}: phải là object")
            continue
        if not isinstance(o.get("id"), str) or not _SLUG.fullmatch(o["id"]) \
                or o["id"] in seen:
            errs.append(f"{ref}.id: thiếu/sai dạng/trùng")
        else:
            seen.add(o["id"])
        if "control" in o and not isinstance(o["control"], bool):
            errs.append(f"{ref}.control: phải là bool")
        if o.get("kind") not in OPTION_KINDS:
            errs.append(f"{ref}.kind: phải thuộc {OPTION_KINDS}")
        keys = o.get("sku_keys", [])
        if not isinstance(keys, list) or not all(
                isinstance(k, str) and k in skus for k in keys):
            errs.append(f"{ref}.sku_keys: phải là list sku_key có trong golden")
            keys = []
        text = o.get("text")
        if not isinstance(text, str) or not text.strip():
            errs.append(f"{ref}.text: thiếu")
            continue
        if _has_pii(text):
            errs.append(f"{ref}.text: chứa dạng PII (SĐT/email)")
        if not guardrail.check(text)["ok"]:
            errs.append(f"{ref}.text: không qua guardrail (từ cấm/claim)")
        try:
            alcohol = kb_filter.is_alcohol(text)
        except kb_filter.KbFilterError:
            errs.append(f"{ref}: bộ lọc rượu lỗi — fail-closed")
            alcohol = True
        alcohol = alcohol or any(
            skus[k].get("category") == "alcohol" for k in keys)
        if alcohol and youth_panel:
            errs.append(f"{ref}: phương án rượu không được chạy với persona "
                        "< 18 tuổi hoặc nhóm trẻ (youth)")
        if alcohol and _YOUTH_RE.search(_norm_text(text)):
            errs.append(f"{ref}.text: phương án rượu nhắm giới trẻ")
        if o.get("kind") != "brand_theme" and any(
                skus[k].get("category") == "tpbvsk"
                and skus[k].get("xnqc_status") != "approved" for k in keys):
            errs.append(f"{ref}: SKU TPBVSK chưa có XNQC chỉ được làm "
                        "brand_theme")


def validate_inputs(cfg, personas_doc, golden) -> list[str]:
    """Hàm thuần. [] = hợp lệ. Lỗi chỉ nêu index/id/tên field."""
    if not isinstance(cfg, dict):
        return ["sim_config: root phải là object"]
    errs: list[str] = []
    _check_cfg(cfg, errs)
    ps = _check_personas(personas_doc, errs)
    _check_options(cfg, ps, golden, errs)
    return errs


# ---------- ma trận ----------

def render(prompt_text: str, personas: list, options: list) -> str:
    plines = "\n".join(
        f"- {p['id']}: {p['label']}; {p['age_min']}–{p['age_max']} tuổi; "
        f"{p['region']}; nhóm hàng {p['sku_group']}; "
        + "; ".join(p.get("traits") or []) for p in personas)
    olines = "\n".join(f"- {o['id']}: {o['text']}" for o in options)
    return prompt_text.replace("{personas}", plines).replace(
        "{options}", olines)


def _reject_const(name):
    raise ValueError(name)


def parse_scores(text, ids: list) -> dict | None:
    """JSON {option_id: 0..10} đủ mọi id -> dict; sai -> None."""
    if not isinstance(text, str):
        return None
    if len(text) > MAX_RESP_CHARS:
        return None
    # find/rfind O(n) — không regex `\{.*\}` (quadratic khi nhiều '{').
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j < i:
        return None
    try:
        d = json.loads(text[i:j + 1], parse_constant=_reject_const)
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    out = {}
    for oid in ids:
        v = d.get(oid)
        if not _is_num(v) or not 0 <= v <= 10:
            return None
        out[oid] = float(v)
    return out


def gateway_chat(model: str, messages: list, temperature: float, seed: int):
    """Lời gọi THẬT — chỉ qua llm_gateway (kill/cap/mask PII)."""
    resp = llm_gateway.chat(AGENT_ID, messages, model=model,
                            feature=FEATURE,
                            temperature=temperature, seed=seed)
    try:
        text = resp.choices[0].message.content or ""
    except (AttributeError, IndexError, TypeError):
        text = ""
    return text, (getattr(resp, "model", None) or model)


def fake_chat(options: list):
    """Gateway GIẢ cho --dry-run: tất định theo (model, seed, prompt),
    đối chứng điểm thấp. Không gọi LLM."""
    ids = [o["id"] for o in options]
    ctrl = {o["id"] for o in options if o.get("control") is True}

    def chat(model, messages, temperature, seed):
        h = _sha12(messages[-1]["content"].encode("utf-8"))
        rnd = random.Random(f"{model}|{seed}|{h}")
        scores = {i: round(rnd.uniform(0.5, 3.0) if i in ctrl
                           else rnd.uniform(4.0, 9.5), 1) for i in ids}
        return json.dumps(scores), f"{model}@dry-run"
    return chat


def run_matrix(cfg, personas, options, chat_fn, run_date, *, run_id=None,
               persona_set_hash=None, dry_run=False):
    """-> (rows, n_calls). Đúng 1 `chat_fn` / (model, prompt, lần lặp);
    persona panel chấm TẤT CẢ phương án (thứ tự xáo theo seed)."""
    run_id = run_id or f"{run_date:%Y%m%d}-{uuid.uuid4().hex[:8]}"
    pset_hash = persona_set_hash or _sha12(json.dumps(
        personas, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    panel = personas["personas"]
    ids = [o["id"] for o in options]
    temp = cfg["temperature"]
    rows, n_calls = [], 0
    for m in cfg["models"]:
        provider = m["id"].split("/", 1)[0]
        for p in cfg["prompts"]:
            phash = prompt_hash(p["text"])
            for i in range(cfg["repeats"]):
                seed = cfg["base_seed"] + i
                order = list(options)
                random.Random(seed).shuffle(order)
                msgs = [{"role": "user",
                         "content": render(p["text"], panel, order)}]
                text, version = chat_fn(m["id"], msgs, temp, seed)
                n_calls += 1
                text = text if isinstance(text, str) else ""
                g_ok = bool(guardrail.check(text[:MAX_RESP_CHARS])["ok"])
                scores = parse_scores(text, ids)
                for o in options:
                    rows.append({
                        "run_id": run_id, "dry_run": bool(dry_run),
                        "run_date": run_date,
                        "persona_set": personas["set_id"],
                        "persona_set_hash": pset_hash, "model": m["id"],
                        "provider": provider,
                        "model_version": version or m["id"],
                        "prompt_id": p["id"], "prompt_hash": phash,
                        "sample_idx": i, "temperature": temp, "seed": seed,
                        "seed_supported": m["seed_supported"],
                        "option_id": o["id"],
                        "is_control": o.get("control") is True,
                        "score": (scores[o["id"]] if scores is not None
                                  and g_ok else None),
                        "parse_ok": scores is not None, "guardrail_ok": g_ok,
                    })
    return rows, n_calls


# ---------- tổng hợp + báo cáo ----------

def summarize(rows: list) -> dict:
    calls: dict = {}
    for r in rows:
        calls.setdefault((r["model"], r["prompt_id"], r["sample_idx"]),
                         []).append(r)
    valid = [rs for rs in calls.values()
             if all(r["score"] is not None for r in rs)]
    opts: dict = {}
    for r in rows:
        opts.setdefault(r["option_id"], {"is_control": r["is_control"],
                                         "scores": []})
    for rs in valid:
        for r in rs:
            opts[r["option_id"]]["scores"].append(float(r["score"]))
    out = {}
    for oid, o in opts.items():
        s = o["scores"]
        if len(s) >= 2:
            q = statistics.quantiles(s, n=10, method="inclusive")
            p10, p50, p90 = q[0], q[4], q[8]
        elif s:
            p10 = p50 = p90 = s[0]
        else:
            p10 = p50 = p90 = None
        out[oid] = {"is_control": o["is_control"], "p10": p10, "p50": p50,
                    "p90": p90, "n_valid": len(s),
                    "spread": None if p10 is None else p90 - p10}
    last = 0
    for rs in valid:
        ctrl = [r["score"] for r in rs if r["is_control"]]
        others = [r["score"] for r in rs if not r["is_control"]]
        if len(ctrl) == 1 and others and ctrl[0] < min(others):
            last += 1
    rate = last / len(valid) if valid else 0.0
    usable = bool(valid) and rate >= CONTROL_LAST_MIN \
        and 2 * len(valid) >= len(calls)
    return {"options": out, "n_calls": len(calls), "n_valid_calls": len(valid),
            "control_last": last, "control_last_rate": rate,
            "usable": usable, "flag": None if usable else UNUSABLE}


def _f(v) -> str:
    return "-" if v is None else f"{v:.1f}"


def report(summary: dict, *, run_id: str, persona_set: str,
           persona_set_hash: str, dry_run: bool) -> str:
    lines = []
    if dry_run:
        lines.append("[DRY-RUN — số giả, gateway giả, không gọi LLM]")
    lines += [
        (f"Nghiên cứu giả lập persona — run {run_id} · persona_set "
         f"{persona_set} ({persona_set_hash}) · {summary['n_calls']} lời "
         f"gọi, {summary['n_valid_calls']} hợp lệ"),
        NOT_FORECAST, LIMITS, "",
        "phương án | khoảng p10–p90 | p50 | độ phân tán | n hợp lệ"]
    for oid, o in sorted(summary["options"].items(),
                         key=lambda kv: (kv[1]["is_control"], kv[0])):
        tag = " (đối chứng yếu)" if o["is_control"] else ""
        rng = ("không đủ dữ liệu" if o["p10"] is None
               else f"{_f(o['p10'])} – {_f(o['p90'])}")
        lines.append(f"{oid}{tag} | {rng} | {_f(o['p50'])} | "
                     f"{_f(o['spread'])} | {o['n_valid']}")
    lines.append(
        f"Đối chứng yếu thấp nhất ở {summary['control_last']}/"
        f"{summary['n_valid_calls']} lời gọi hợp lệ "
        f"({summary['control_last_rate']:.0%}, ngưỡng "
        f"{CONTROL_LAST_MIN:.0%}).")
    if summary["flag"]:
        lines.append(f"[{summary['flag']}] mô hình không tách được đối chứng "
                     "yếu hoặc quá ít lời gọi hợp lệ — không dùng kết quả "
                     "này để chọn phương án.")
    lines.append("Cần Quản lý MXH duyệt báo cáo trước khi dùng.")
    return "\n".join(lines)


# ---------- DB ----------

def _connect():
    load_dotenv(ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("thiếu DATABASE_URL")
    return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)


FEATURE = "intel-05.1"


def write_rows(conn, rows: list, commit: bool = True) -> int:
    """1 executemany trong 1 transaction; commit tường minh (gotcha v2.1).
    v14.3: tính năng intel-05 TẮT → RolloutBlocked (HĐ 6.7), không ghi."""
    from pipelines import rollout  # lười: rollout → director → ...
    rollout.check_generate(conn, FEATURE, "lượt giả lập persona")
    sql = (f"insert into sim_runs ({', '.join(SIM_COLS)}) values "
           f"({', '.join(['%s'] * len(SIM_COLS))})")
    with conn.cursor() as cur:
        cur.executemany(sql, [tuple(r[c] for c in SIM_COLS) for r in rows])
    if commit:
        conn.commit()
    return len(rows)


# ---------- CLI ----------

def _read_json(path: Path):
    try:
        text = path.read_bytes().decode("utf-8-sig")
    except (OSError, UnicodeDecodeError) as e:
        return None, f"không đọc được {path.name} ({type(e).__name__})"
    if not text.strip():
        return None, f"{path.name} rỗng"
    try:
        return json.loads(text, parse_constant=_reject_const), None
    except ValueError:
        return None, f"{path.name} JSON hỏng"


def _feature_off() -> str | None:
    """intel-05 TẮT → lý do (không gọi gateway, không ghi). DB down /
    thiếu DSN → None (mode fail-closed = chạy thử: vẫn chạy, ghi sẽ báo
    lỗi DB như cũ)."""
    from pipelines import rollout  # lười
    if rollout.quick_mode() is not None:
        return ("tính năng tắt" if rollout.quick_mode() == "tat" else None)
    try:
        conn = _connect()
    except (psycopg.Error, RuntimeError):
        return None
    try:
        rollout.check_generate(conn, FEATURE, "lượt giả lập persona")
    except rollout.RolloutBlocked as e:
        return str(e)
    finally:
        conn.close()
    return None


def _err(msg: str) -> int:
    print(f"[err] {msg}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/persona_sim.py",
                                 description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true",
                    help="gateway GIẢ tất định (số giả) — chạy được khi "
                         "DPIA chưa ký")
    ap.add_argument("--config", type=Path, default=CONFIG_FILE)
    ap.add_argument("--personas", type=Path, default=PERSONAS_FILE)
    args = ap.parse_args(argv)

    cfg, why = _read_json(args.config)
    if cfg is None:
        return _err(why)
    pdoc, why = _read_json(args.personas)
    if pdoc is None:
        return _err(why)
    golden, why = golden_store.read_golden(GOLDEN_FILE)
    if golden is None:
        return _err(f"golden: {why}")
    errs = validate_inputs(cfg, pdoc, golden)
    if errs:
        for e in errs:
            print(f"[err] {e}", file=sys.stderr)
        return 1
    canon, _ = _read_json(CONFIG_FILE)
    signed = (cfg.get("dpia_signed") is True and isinstance(canon, dict)
              and canon.get("dpia_signed") is True)
    if not args.dry_run and not signed:
        print("[refuse] DPIA chưa ký (sim_config.json dpia_signed khác true)"
              " — persona_sim chỉ chạy --dry-run (số giả). Chỉ NGƯỜI thật "
              "đổi dpia_signed sau khi Pháp chế + TGĐ ký DPIA/TIA.",
              file=sys.stderr)
        return 2

    vendors = sorted({m["id"].split("/", 1)[0] for m in cfg["models"]})
    if not args.dry_run and len(vendors) < MIN_PROVIDERS:
        # r13: lượt THẬT cần ≥3 NHÀ CUNG CẤP khác nhau (không chỉ 3 model) —
        # chặn TRƯỚC mọi lời gọi; ai được dùng = quyết định DPIA/TIA/DPA.
        print(f"[refuse] lượt thật cần >= {MIN_PROVIDERS} nhà cung cấp khác "
              f"nhau trong sim_config.models (hiện: {', '.join(vendors)}) — "
              "0 lời gọi LLM", file=sys.stderr)
        return 2
    off = _feature_off()
    if off:
        print(f"[blocked] {off}", file=sys.stderr)
        return 2
    run_date = dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date()
    run_id = (f"{'dry' if args.dry_run else 'run'}-{run_date:%Y%m%d}-"
              f"{uuid.uuid4().hex[:8]}")
    pset_hash = _sha12(args.personas.read_bytes())
    chat_fn = fake_chat(cfg["options"]) if args.dry_run else gateway_chat
    try:
        rows, n_calls = run_matrix(cfg, pdoc, cfg["options"], chat_fn,
                                   run_date, run_id=run_id,
                                   persona_set_hash=pset_hash,
                                   dry_run=args.dry_run)
    except llm_gateway.GatewayError as e:
        return _err(f"dừng ({type(e).__name__}: {_mask_pii(str(e))[:200]}) "
                    "— 0 dòng ghi sim_runs")
    summary = summarize(rows)
    text = report(summary, run_id=run_id, persona_set=pdoc["set_id"],
                  persona_set_hash=pset_hash, dry_run=args.dry_run)
    if not guardrail.check(text)["ok"]:
        return _err("báo cáo không qua guardrail — không ghi, không in")
    try:
        conn = _connect()
        try:
            write_rows(conn, rows)
        finally:
            conn.close()
    except (psycopg.Error, RuntimeError, ValueError) as e:
        return _err(f"ghi sim_runs lỗi ({type(e).__name__}) — không in báo "
                    "cáo (kết quả phải truy vết được)")
    print(text)
    print(f"[ok] {len(rows)} dòng sim_runs ({n_calls} lời gọi) run_id={run_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
