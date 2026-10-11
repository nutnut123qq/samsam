"""W35.3 — Harness nghiệm thu chung theo agent (F17.1): chấm bộ ca
`data/eval/<agent>.jsonl` theo ngưỡng CHỐT TRƯỚC trong
`data/eval/config.json`, ghi 1 row bảng `eval_runs` (docs/schema.sql).
`scripts/deploy_gate.py` chỉ cho deploy commit có row PASS mới nhất.

Agent:
  - guardrail: `guardrail.check(text)["ok"]` (ca có `ctx` ->
    `guardrail.check_publish(text, **ctx)`) so `expect`; ca block có `code`
    phải bị chặn đúng code đó (v4.1) — tất định, không LLM, không key (CI
    chạy mỗi push).
  - chatbot: `api.rag.answer(q)` THẬT (gateway agent_id "chatbot"); chấm
    bằng `eval_qa.check_question` (không nhân đôi EXPECTED); `trap_health`
    chấm `handoff == "health"`. Thiếu OPENROUTER_API_KEY -> exit 1, KHÔNG
    ghi row (chưa chấm != PASS).

PASS = pass_rate >= min_pass_rate VÀ mọi ca thuộc `must_pass_kinds` pass
(kind bắt buộc mà bộ ca không có ca nào -> FAIL, fail-closed).

commit_sha: `--sha` > env GITHUB_SHA > `git rev-parse HEAD`; phải 40 hex
và TRÙNG HEAD (harness chấm code đang checkout, không chấm hộ commit
khác). Tree bẩn (file tracked sửa, hoặc input harness chưa commit) -> từ
chối ghi; `--allow-dirty` ghi `<sha>-dirty` (deploy gate không bao giờ
khớp). Judge LLM (nếu sau này cần) BẮT BUỘC qua
`pipelines.llm_gateway.chat("ci_judge", ...)` — v3.5 chấm bằng luật.

Exit: 0 khi PASS và ghi được (hoặc --no-record); 1 khi FAIL / thiếu key /
DB lỗi / tree bẩn; 2 khi tham số sai.

Chạy: `python scripts/agent_eval.py --agent guardrail [--no-record]`.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Console Windows mặc định cp1258 — crash UnicodeEncodeError khi in tiếng
# Việt có dấu. Ép UTF-8 cho stdout/stderr (no-op nếu đã là UTF-8).
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import psycopg
from dotenv import load_dotenv

from pipelines import guardrail
from pipelines.pii import _mask_pii

CONFIG = ROOT / "data" / "eval" / "config.json"
SHA_RE = re.compile(r"[0-9a-f]{40}")
CONNECT_TIMEOUT_S = 5
# Trùng mặc định của pipelines.llm_gateway.chat (OR_CHAT_MODEL).
DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini"


def load_config(path: Path = CONFIG) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_cases(path: Path) -> list[dict]:
    """jsonl 1 dòng = 1 ca; bỏ dòng trống và dòng `_doc`."""
    cases = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.strip():
            rec = json.loads(line)
            if "_doc" not in rec:
                cases.append(rec)
    return cases


def prompt_version(files: list[str]) -> str:
    """12 hex đầu sha256 các file prompt/luật — CRLF->LF để checkout
    Windows (autocrlf) và Linux CI cho cùng version."""
    h = hashlib.sha256()
    for rel in files:
        data = (ROOT / rel).read_bytes().replace(b"\r\n", b"\n")
        h.update(rel.encode() + b"\0" + data + b"\0")
    return h.hexdigest()[:12]


def _short(text: str, cap: int = 120) -> str:
    s = re.sub(r"\s+", " ", str(text)).strip()
    return _mask_pii(s[:cap] + ("..." if len(s) > cap else ""))


def run_guardrail(cases: list[dict]) -> list[tuple[dict, bool, str]]:
    """Ca có `ctx` -> `check_publish(text, **ctx)`, không có -> `check`.
    Ca block có `code` chỉ pass khi bị chặn VÀ đúng code đó (v4.1)."""
    out = []
    for c in cases:
        try:
            ctx = c.get("ctx")
            r = (guardrail.check_publish(c["text"], **ctx) if ctx
                 else guardrail.check(c["text"]))
            codes = [v.get("code") for v in r["violations"]]
        except Exception as e:  # noqa: BLE001 — ca lỗi = FAIL, chạy tiếp
            out.append((c, False, f"{type(e).__name__}"))
            continue
        got = "pass" if r["ok"] else "block"
        ok = got == c["expect"]
        if ok and got == "block" and c.get("code"):
            ok = c["code"] in codes
        detail = "" if ok else (
            f"kỳ vọng {c['expect']}"
            + (f" ({c['code']})" if c.get("code") else "")
            + f", guardrail {got} "
            + "; ".join(f"{v.get('code', v.get('type', ''))}: "
                        f"{v.get('detail', '')}" for v in r["violations"]))
        out.append((c, ok, detail))
    return out


def _rag_answer(question: str) -> dict:
    from api.rag import answer  # lazy: guardrail không cần RAG/DB chunks
    return answer(question)


def run_chatbot(cases: list[dict]) -> list[tuple[dict, bool, str]]:
    import eval_qa  # scripts/ — tái dùng luật chấm Q1-12

    out = []
    for c in cases:
        try:
            res = _rag_answer(c["text"])
            if c["kind"] == "trap_health":
                ok = res.get("handoff") == "health"
                detail = "" if ok else f"handoff={res.get('handoff')!r}"
            else:
                ok, detail = eval_qa.check_question(int(c["id"]), res)
        except Exception as e:  # noqa: BLE001 — như eval_qa: FAIL, đi tiếp
            out.append((c, False, f"{type(e).__name__}"))
            continue
        if not ok:
            detail = (f"{_short(detail, 300)} | "
                      f'answer="{_short(res.get("answer", ""))}"')
        out.append((c, ok, detail))
    return out


RUNNERS = {"guardrail": run_guardrail, "chatbot": run_chatbot}


def score(results: list[tuple[dict, bool, str]], agent_cfg: dict) -> dict:
    n_total = len(results)
    n_pass = sum(ok for _, ok, _ in results)
    rate = round(n_pass / n_total, 4) if n_total else 0.0
    must = agent_cfg.get("must_pass_kinds", [])
    kinds = {c.get("kind") for c, _, _ in results}
    missing_kinds = [k for k in must if k not in kinds]
    trap_fail = [str(c["id"]) for c, ok, _ in results
                 if not ok and c.get("kind") in must]
    passed = (n_total > 0 and rate >= agent_cfg["min_pass_rate"]
              and not trap_fail and not missing_kinds)
    return {"n_total": n_total, "n_pass": n_pass, "pass_rate": rate,
            "threshold": agent_cfg["min_pass_rate"], "passed": passed,
            "trap_fail": trap_fail, "missing_kinds": missing_kinds}


def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(ROOT), *args],
                           capture_output=True, text=True, timeout=30,
                           check=False, encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def _git_head() -> str | None:
    out = _git("rev-parse", "HEAD")
    return out.strip().lower() if out else None


def _git_dirty(inputs: list[str]) -> bool | None:
    """True khi file tracked bị sửa HOẶC input harness (config/ca/prompt)
    chưa commit (untracked). None = không đọc được git."""
    tracked = _git("status", "--porcelain", "--untracked-files=no")
    harness = _git("status", "--porcelain", "--untracked-files=all",
                   "--", *inputs)
    if tracked is None or harness is None:
        return None
    return bool(tracked.strip() or harness.strip())


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("thiếu DATABASE_URL")
    return psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S)


def record(row: dict) -> None:
    conn = _connect()
    try:
        conn.execute(
            "insert into eval_runs (commit_sha, agent, n_total, n_pass,"
            " pass_rate, threshold, passed, model, prompt_version, note)"
            " values (%(commit_sha)s, %(agent)s, %(n_total)s, %(n_pass)s,"
            " %(pass_rate)s, %(threshold)s, %(passed)s, %(model)s,"
            " %(prompt_version)s, %(note)s)", row)
        conn.commit()  # tường minh (gotcha v2.1 savepoint)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--agent", required=True, choices=sorted(RUNNERS))
    ap.add_argument("--sha", help="commit SHA 40 hex (mặc định GITHUB_SHA"
                    " rồi git HEAD) — phải trùng HEAD")
    ap.add_argument("--no-record", action="store_true",
                    help="chỉ chấm, không ghi eval_runs")
    ap.add_argument("--allow-dirty", action="store_true",
                    help="tree bẩn vẫn ghi, commit_sha='<sha>-dirty'")
    args = ap.parse_args(argv)

    raw = (args.sha or os.environ.get("GITHUB_SHA") or "").strip().lower()
    if raw and not SHA_RE.fullmatch(raw):
        ap.error("--sha/GITHUB_SHA phải là commit SHA đủ 40 ký tự hex")

    load_dotenv(ROOT / ".env")
    cfg = load_config()
    acfg = cfg["agents"][args.agent]
    if args.agent == "chatbot" and not os.environ.get("OPENROUTER_API_KEY"):
        print("[error] thiếu OPENROUTER_API_KEY — eval chatbot không chạy,"
              " KHÔNG ghi eval_runs (chưa chấm != PASS)", flush=True)
        return 1

    sha = None
    if not args.no_record:
        head = _git_head()
        if head is None:
            print("[error] không đọc được git HEAD — không xác minh được"
                  " commit, không ghi", flush=True)
            return 1
        if raw and raw != head:
            print(f"[error] SHA chỉ định {raw} khác HEAD {head} — harness"
                  " chấm code đang checkout, không ghi hộ commit khác",
                  flush=True)
            return 1
        inputs = ["data/eval", acfg["cases"], *acfg["prompt_files"]]
        dirty = _git_dirty(inputs)
        if dirty is None or (dirty and not args.allow_dirty):
            print("[error] working tree bẩn (hoặc không đọc được git status)"
                  " — kết quả không gắn được với commit; commit trước hoặc"
                  " dùng --allow-dirty (ghi '<sha>-dirty', không mở được"
                  " deploy)", flush=True)
            return 1
        sha = head + ("-dirty" if dirty else "")

    results = RUNNERS[args.agent](load_cases(ROOT / acfg["cases"]))
    for c, ok, detail in results:
        if not ok:
            print(f"[{args.agent}:{c['id']}] FAIL ({c.get('kind')}) — "
                  f'{detail} | text="{_short(c["text"])}"', flush=True)
    s = score(results, acfg)
    pv = prompt_version(acfg["prompt_files"])
    model = ("rules" if args.agent == "guardrail" else
             os.environ.get("OR_CHAT_MODEL", DEFAULT_CHAT_MODEL))
    verdict = "PASS" if s["passed"] else "FAIL"
    print(f"[done] {args.agent} {verdict} {s['n_pass']}/{s['n_total']}"
          f" pass_rate={s['pass_rate']} (ngưỡng {s['threshold']})"
          f" prompt_version={pv} model={model}", flush=True)
    if s["trap_fail"]:
        print(f"[done] ca bắt buộc FAIL: {', '.join(s['trap_fail'])}",
              flush=True)
    if s["missing_kinds"]:
        print(f"[done] thiếu ca cho kind bắt buộc: "
              f"{', '.join(s['missing_kinds'])}", flush=True)
    if args.no_record:
        print("[done] --no-record: không ghi eval_runs", flush=True)
        return 0 if s["passed"] else 1

    row = {"commit_sha": sha, "agent": args.agent, "n_total": s["n_total"],
           "n_pass": s["n_pass"], "pass_rate": s["pass_rate"],
           "threshold": s["threshold"], "passed": s["passed"],
           "model": model, "prompt_version": pv,
           "note": "ci" if os.environ.get("GITHUB_ACTIONS") else "local"}
    try:
        record(row)
    except (psycopg.Error, OSError, RuntimeError) as e:
        print(f"[warn] không ghi được eval_runs ({type(e).__name__}) — "
              "không có bằng chứng, deploy gate sẽ từ chối", flush=True)
        return 1
    print(f"[done] ghi eval_runs commit_sha={sha} agent={args.agent}"
          f" passed={s['passed']}", flush=True)
    return 0 if s["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
