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
  - mkt02 (v6.1, Agent Content & Listing): `content.listing(llm=False)`
    (op listing) / `content.precheck` (op draft — cổng từ chối của
    draft()) TẤT ĐỊNH: 0 lời gọi LLM (lớp LLM-check tắt trong lúc chấm),
    không key, không DB. `golden_exact` pass <=> ok + fields == golden
    (name/pack_spec/receipt_no/giá list) + dòng `Quy cách:` nguyên văn +
    không lộ giá floor/promo; ca refuse pass <=> refused.code == code.
  - mkt03 (v6.2, Agent Ảnh AI): `image_studio.compose` TẤT ĐỊNH — packshot
    MẪU + out dir trong thư mục tạm, provider AI giả `eval_stub` đăng ký
    tạm (gỡ trong finally), 0 mạng/0 LLM/không DB. Kind ảnh chấm nhãn AI +
    metadata / toàn vẹn packshot / phát hiện sửa 1 pixel / không EXIF; ca
    refuse pass <=> refused.code == code.

PASS =pass_rate >= min_pass_rate VÀ mọi ca thuộc `must_pass_kinds` pass
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


def _vnd(v) -> str:
    return f"{v:,}".replace(",", ".")


def _golden_exact(c: dict, r: dict, gold: dict) -> str:
    """'' khi listing khớp golden; ngược lại lý do (không kèm text)."""
    if r.get("ok") is not True:
        return "listing không ok: " + ", ".join(
            str(v.get("code")) for v in r["guardrail"].get("violations", []))
    g, f = gold[c["sku"]], r["fields"]
    prices = (g.get("prices") or {}).get(c["channel"]) or {}
    want = {"name": g["name"], "pack_spec": g.get("pack_spec"),
            "receipt_no": g.get("receipt_no") if g["category"] == "tpbvsk"
            else None,
            "price": (_vnd(prices["list"]) + " đ") if "list" in prices
            else f["price"]}
    bad = [k for k, v in want.items() if f.get(k) != v]
    if bad:
        return f"fields lệch golden: {bad}"
    if f"Quy cách: {g.get('pack_spec')}" not in r["text"].split("\n"):
        return "thiếu dòng 'Quy cách:' nguyên văn golden"
    for kind in ("floor", "promo"):
        v = prices.get(kind)
        if v is not None and v != prices.get("list") and (
                _vnd(v) in r["text"] or str(v) in r["text"]):
            return f"lộ giá {kind}"
    return ""


def run_mkt02(cases: list[dict]) -> list[tuple[dict, bool, str]]:
    """Chấm tất định MKT-02 — tắt lớp LLM-check (GUARDRAIL_LLM_MODEL) trong
    lúc chấm, listing llm=False, op draft chỉ chạy precheck."""
    from ingest.golden_store import read_golden
    from pipelines import content

    doc, err = read_golden(ROOT / "data" / "golden_skus.json")
    gold = {s["sku_key"]: s for s in (doc or {}).get("skus", [])}
    saved = os.environ.pop("GUARDRAIL_LLM_MODEL", None)
    out = []
    try:
        for c in cases:
            try:
                rmap = ({(a, b): m for a, b, m in c["readiness"]}
                        if c.get("readiness") else None)
                if c["op"] == "draft":
                    ref = content.precheck(c["sku"], c["channel"],
                                           c["content_type"], readiness=rmap)
                    r = {"refused": ref}
                else:
                    r = content.listing(c["sku"], c["channel"],
                                        readiness=rmap, llm=False)
                ref = r.get("refused")
                if c["expect"] == "refuse":
                    ok = bool(ref) and ref.get("code") == c.get("code")
                    detail = "" if ok else (
                        f"kỳ vọng từ chối {c.get('code')}, được "
                        f"{ref.get('code') if ref else 'sinh listing'}")
                elif ref:
                    ok, detail = False, f"bị từ chối {ref.get('code')}"
                else:
                    detail = (err or _golden_exact(c, r, gold))
                    ok = not detail
            except Exception as e:  # noqa: BLE001 — ca lỗi = FAIL, đi tiếp
                ok, detail = False, type(e).__name__
            out.append((c, ok, detail))
    finally:
        if saved is not None:
            os.environ["GUARDRAIL_LLM_MODEL"] = saved
    return out


def _mkt03_stub(prompt, size):
    """Provider AI GIẢ tất định cho eval MKT-03 (model ghi 'eval_stub' —
    không giả làm model thật): nền đặc + khối đỏ vẽ ĐÈ đúng packshot_box
    của format (mô phỏng nền AI cố vẽ vào vùng sản phẩm)."""
    from PIL import Image, ImageDraw

    from pipelines import image_studio as ims

    cfg, err = ims.load_config()
    if err:
        raise RuntimeError(err)
    img = Image.new("RGB", size, (60, 90, 70))
    for name, wh in cfg["formats"].items():
        if tuple(wh) == tuple(size):
            x, y, w, h = ims._px(cfg["layout"][name]["packshot_box"], size)
            ImageDraw.Draw(img).rectangle((x, y, x + w - 1, y + h - 1),
                                          fill=(255, 0, 0))
    return img, {"model": "eval_stub"}


def _mkt03_check(c: dict, r: dict, ai_label: str) -> str:
    """'' khi ca expect=image đạt theo kind; ngược lại lý do (không text)."""
    from datetime import datetime

    from PIL import Image

    from pipelines import image_studio as ims

    m = r["meta"]
    with Image.open(r["path"]) as im:
        img = im.convert("RGB")
        meta_keys = {"exif", "xmp", "XML:com.adobe.xmp",
                     "icc_profile"} & set(im.info)
        exif = dict(im.getexif())
    fitted, xy = r["fitted"], r["packshot_xy"]
    if not ims.verify_packshot(img, fitted, xy):
        return "vùng packshot lệch packshot gốc"
    kind = c["kind"]
    if kind == "ai_label_meta":
        bg = m["background"]
        if not (m["ai_generated"] is True and m["labels"][:1] == [ai_label]
                and ai_label in r["text_layer"].split("\n")):
            return "thiếu nhãn AI đứng đầu / ai_generated"
        if not (bg.get("model") and bg.get("prompt_sha256")
                and bg.get("prompt_version") and m.get("created_at")):
            return "sidecar thiếu model/prompt_sha256/prompt_version/ngày"
        if datetime.fromisoformat(m["created_at"]).utcoffset() is None:
            return "created_at không có múi giờ"
        plain, _ = _mkt03_stub(bg["prompt"], img.size)
        x, y, w, h = m["label_box"]
        box = (x, y, x + w, y + h)
        if ims._changed_ratio(img.crop(box), plain.crop(box)) < 0.01:
            return "vùng nhãn không khác nền (nhãn không hiển thị)"
        # Riêng tấm nền đã khác nền 100% -> đếm pixel đúng màu chữ nhãn
        # (thật ≥0.12% ở banner, bỏ chữ giữ tấm nền = 0%).
        cfg, _ = ims.load_config()
        mask = ims._color_mask(img.crop(box), cfg["label"]["text_rgb"])
        if mask.histogram()[255] < 0.0005 * w * h:
            return "vùng nhãn chỉ có tấm nền, không có chữ nhãn"
    elif kind == "tamper_detect":
        solid = ims._solid(fitted)
        i = next(i for i, a in enumerate(solid.getdata()) if a == 255)
        p = (xy[0] + i % solid.width, xy[1] + i // solid.width)
        px = img.getpixel(p)
        img.putpixel(p, ((px[0] + 1) % 256, px[1], px[2]))
        if ims.verify_packshot(img, fitted, xy):
            return "sửa 1 pixel vùng packshot mà verify_packshot vẫn True"
    elif kind == "no_exif":
        data = Path(r["path"]).read_bytes()
        if exif or meta_keys or b"eXIf" in data:
            return "ảnh output còn EXIF/XMP/ICC"
    return ""


def run_mkt03(cases: list[dict]) -> list[tuple[dict, bool, str]]:
    """Chấm tất định MKT-03 (v6.2): 0 mạng/0 LLM (tắt lớp LLM-check trong
    lúc chấm), không key, không DB. Packshot MẪU + out dir trong thư mục
    tạm; provider `eval_stub` đăng ký TẠM vào image_studio.PROVIDERS và
    được gỡ trong finally (PROVIDERS sau == trước)."""
    import tempfile

    from pipelines import content
    from pipelines import image_studio as ims

    _, ai, _ = content._publish_texts()
    ai_label = ai[0] if ai else "\x00"
    saved = os.environ.pop("GUARDRAIL_LLM_MODEL", None)
    had = "eval_stub" in ims.PROVIDERS
    prev = ims.PROVIDERS.get("eval_stub")
    ims.PROVIDERS["eval_stub"] = _mkt03_stub
    out = []
    try:
        with tempfile.TemporaryDirectory(prefix="mkt03-") as td:
            for n, c in enumerate(cases):
                try:
                    base = Path(td) / f"c{n}"
                    sku = c.get("sku")
                    if isinstance(sku, str) and sku:
                        ims.make_sample_packshot(
                            base / "pk" / f"{sku}.png", sku,
                            exif_gps=bool(c.get("packshot_exif")))
                    rmap = ({(a, b): lv for a, b, lv in c["readiness"]}
                            if c.get("readiness") else None)
                    r = ims.compose(sku, c["channel"], c["headline"],
                                    fmt=c["format"], scene=c.get("scene"),
                                    readiness=rmap,
                                    provider=c.get("provider", "none"),
                                    packshot_dir=base / "pk",
                                    out_dir=base / "out")
                    ref = r.get("refused")
                    if c["expect"] == "refuse":
                        ok = bool(ref) and ref.get("code") == c.get("code")
                        if ok and c["kind"] == "trap_tpbvsk_maket":
                            ok = "maket XNQC" in ref.get("reason", "")
                        detail = "" if ok else (
                            f"kỳ vọng từ chối {c.get('code')}, được "
                            f"{ref.get('code') if ref else 'sinh ảnh'}")
                    elif ref:
                        ok, detail = False, f"bị từ chối {ref.get('code')}"
                    else:
                        detail = _mkt03_check(c, r, ai_label)
                        ok = not detail
                except Exception as e:  # noqa: BLE001 — ca lỗi = FAIL, đi tiếp
                    ok, detail = False, type(e).__name__
                out.append((c, ok, detail))
    finally:
        if had:
            ims.PROVIDERS["eval_stub"] = prev
        else:
            ims.PROVIDERS.pop("eval_stub", None)
        if saved is not None:
            os.environ["GUARDRAIL_LLM_MODEL"] = saved
    return out


RUNNERS = {"guardrail": run_guardrail, "chatbot": run_chatbot,
           "mkt02": run_mkt02, "mkt03": run_mkt03}


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
            # mkt02: ca không có text -> in "sku × kênh".
            what = c.get("text") or f"{c.get('sku')} × {c.get('channel')}"
            print(f"[{args.agent}:{c['id']}] FAIL ({c.get('kind')}) — "
                  f'{detail} | text="{_short(what)}"', flush=True)
    s = score(results, acfg)
    pv = prompt_version(acfg["prompt_files"])
    model = ("rules" if args.agent in ("guardrail", "mkt02", "mkt03") else
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
