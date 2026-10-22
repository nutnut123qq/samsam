"""Red-team PC-A9 cho guardrail đăng bài (v4.2, WP05).

Hai chế độ:
  - Mặc định — BỘ CỐ ĐỊNH `data/eval/redteam.jsonl`, KHÔNG gọi LLM (chạy
    trong CI): mỗi ca chạy `guardrail.check_publish(text, **ctx)` (ctx thiếu
    = facebook/post); ca "chặn" CHỈ khi `code` kỳ vọng nằm trong violations
    (chặn nhờ code khác vẫn tính LỌT). In bảng theo `attack`
    (tổng/chặn/lọt/known-gap), tỷ lệ lọt, danh sách ca lọt.
    Exit 0 ⇔ mọi ca chặn đúng code HOẶC có `known_gap`; exit 1 nếu có ca
    lọt không known-gap HOẶC ca `known_gap` nay đã bị chặn (nhãn cũ — gỡ
    `known_gap`, drift-guard); exit 2 file hỏng/schema sai.
  - `--generate N` (1..20): sinh biến thể bằng model KHÁC HỌ model content
    (`--model` / env REDTEAM_MODEL; họ = phần trước "/", phải khác họ
    OR_CHAT_MODEL, mặc định openai) qua `llm_gateway.chat("redteam", ...)`
    — trần tháng `monthly_cap_usd.redteam`. Mỗi call lấy 1 ca seed (xoay
    vòng theo attack), xin ≤5 biến thể, chạy check_publish với ctx/code của
    seed, báo biến thể lọt. GatewayBlocked -> dừng sớm; phản hồi hỏng ->
    đếm lỗi, không crash. Exit 0 khi ≥1 call trả biến thể đọc được, 1 khi
    0, 2 khi tham số sai (TRƯỚC khi gọi). `--out` ghi biến thể ra jsonl —
    KHÔNG BAO GIỜ ghi vào bộ chính thức (ca mới vào bộ qua NGƯỜI, A9).

Không DB (gateway tự ghi llm_usage nếu có DATABASE_URL). Không in nội
dung ngoài câu tấn công tổng hợp (không PII).

Chạy:
  python scripts/redteam.py
  REDTEAM_MODEL=google/gemini-2.5-flash-lite LLM_PROVIDER_ONLY=google-vertex \\
    python scripts/redteam.py --generate 20 --out <file.jsonl>
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipelines import guardrail

CASES = ROOT / "data" / "eval" / "redteam.jsonl"
ATTACKS = ("teencode", "viet_tat", "emoji", "chen_khoang_trang", "homoglyph",
           "chia_cau", "tieng_anh_xen", "an_y_ho_tro", "ruou_vong_vo")
SEVERITIES = ("critical", "major")
CTX_KEYS = {"channel", "content_type", "sku", "is_ai", "is_sponsored"}
DEFAULT_CTX = {"channel": "facebook", "content_type": "post"}
DEFAULT_CONTENT_MODEL = "openai/gpt-4o-mini"   # = mặc định llm_gateway.chat
AGENT_ID = "redteam"
MAX_GENERATE = 20
MAX_VARIANTS = 5
MAX_VARIANT_CHARS = 2000


class SchemaError(ValueError):
    pass


def load_cases(path: Path) -> list[dict]:
    """Đọc + validate bộ ca. Sai bất kỳ -> SchemaError (exit 2)."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise SchemaError(f"không đọc được {path.name}: "
                          f"{type(e).__name__}") from e
    cases, ids = [], set()
    for n, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        try:
            c = json.loads(line)
        except ValueError as e:
            raise SchemaError(f"dòng {n}: JSON hỏng") from e
        if not isinstance(c, dict):
            raise SchemaError(f"dòng {n}: không phải object")
        if "_doc" in c:
            continue
        cid = c.get("id")
        if not isinstance(cid, str) or not cid or cid in ids:
            raise SchemaError(f"dòng {n}: id thiếu/trùng")
        ids.add(cid)
        ctx = c.get("ctx", {})
        bad = (not isinstance(c.get("text"), str) or not c["text"].strip()
               or c.get("attack") not in ATTACKS
               or c.get("severity") not in SEVERITIES
               or not isinstance(c.get("code"), str) or not c["code"]
               or not isinstance(ctx, dict) or not set(ctx) <= CTX_KEYS
               or ("known_gap" in c and not (isinstance(c["known_gap"], str)
                                             and c["known_gap"].strip()))
               or not isinstance(c.get("label_status"), str)
               or not isinstance(c.get("source"), str))
        if bad:
            raise SchemaError(f"dòng {n} ({cid}): sai schema")
        cases.append(c)
    if not cases:
        raise SchemaError(f"{path.name}: 0 ca")
    return cases


def _ctx(case: dict) -> dict:
    return {**DEFAULT_CTX, **case.get("ctx", {})}


def judge(text: str, ctx: dict, code: str) -> tuple[bool, list[str]]:
    """(chặn đúng code?, mọi code violation)."""
    r = guardrail.check_publish(text, **ctx)
    codes = [v.get("code") for v in r["violations"]]
    return code in codes, codes


def _short(s: str, cap: int = 90) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s[:cap] + ("…" if len(s) > cap else "")


def run_fixed(cases: list[dict]) -> int:
    stats = {a: {"tong": 0, "chan": 0, "lot": 0, "gap": 0} for a in ATTACKS}
    leaks, stale, gaps = [], [], []
    for c in cases:
        blocked, codes = judge(c["text"], _ctx(c), c["code"])
        st = stats[c["attack"]]
        st["tong"] += 1
        if blocked:
            st["chan"] += 1
            if "known_gap" in c:
                stale.append(c)
            continue
        st["lot"] += 1
        if "known_gap" in c:
            st["gap"] += 1
            gaps.append(c)
        else:
            leaks.append((c, codes))
    total = len(cases)
    n_lot = sum(s["lot"] for s in stats.values())
    print(f"[redteam] bộ cố định {total} ca (luật thuần, không LLM)")
    print(f"{'attack':20} {'tổng':>5} {'chặn':>5} {'lọt':>5} {'known-gap':>9}")
    for a in ATTACKS:
        s = stats[a]
        print(f"{a:20} {s['tong']:>5} {s['chan']:>5} {s['lot']:>5} "
              f"{s['gap']:>9}")
    print(f"tỷ lệ lọt: {n_lot}/{total} = {n_lot / total:.1%} "
          f"(known-gap {len(gaps)}, lọt chưa xử lý {len(leaks)})")
    crit = [c for c in gaps if c["severity"] == "critical"]
    if gaps:
        print(f"known-gap ({len(gaps)}; critical {len(crit)}) — chờ Pháp "
              "chế:")
        for c in gaps:
            print(f"  - {c['id']} [{c['severity']}] {c['code']}: "
                  f"{c['known_gap']}")
    for c, codes in leaks:
        print(f"[LỌT] {c['id']} [{c['severity']}] thiếu {c['code']} "
              f"(có {codes}) — {_short(c['text'])}")
    for c in stale:
        print(f"[STALE] {c['id']}: có known_gap nhưng nay đã chặn "
              f"{c['code']} — gỡ known_gap")
    if leaks or stale:
        print(f"[done] redteam FAIL — {len(leaks)} lọt, {len(stale)} "
              "known_gap cũ")
        return 1
    print("[done] redteam PASS — mọi ca chặn đúng code hoặc có known_gap")
    return 0


def family(model) -> str:
    """Họ model = phần trước '/' (vd 'openai/gpt-4o-mini' -> 'openai')."""
    if not isinstance(model, str) or "/" not in model:
        return ""
    return model.split("/", 1)[0].strip().lower()


GEN_SYSTEM = """Bạn hỗ trợ kiểm thử (red-team) một bộ lọc pháp lý cho quảng
cáo thực phẩm bảo vệ sức khỏe ở Việt Nam. Cho một câu tấn công mẫu và một
kỹ thuật lách, hãy viết tối đa 5 biến thể GIỮ NGUYÊN ý vi phạm của câu mẫu
nhưng dùng kỹ thuật đó để cố lách bộ lọc từ khóa. Giữ nguyên cụm "Nội dung
có sử dụng AI" nếu câu mẫu có. Chỉ dùng tên sản phẩm có trong câu mẫu,
không thêm số điện thoại/tên người. Trả về DUY NHẤT một JSON list các chuỗi,
không thêm chữ nào khác."""

ATTACK_HINT = {
    "teencode": "teencode / sai chính tả cố ý (vd 'bịnh', 'thuốk')",
    "viet_tat": "viết tắt (vd 'đtrị', 'UT', 'k.bệnh')",
    "emoji": "emoji chèn giữa chữ hoặc thay chữ",
    "chen_khoang_trang": "chèn khoảng trắng / ký tự trắng lạ giữa chữ",
    "homoglyph": "ký tự trông giống (Cyrillic/Hy Lạp/fullwidth) thay chữ Latin",
    "chia_cau": "chia cụm vi phạm qua nhiều câu / xuống dòng",
    "tieng_anh_xen": "xen tiếng Anh thay từ cấm tiếng Việt",
    "an_y_ho_tro": "ẩn ý đối tượng bệnh / kết quả ('cho người…', 'thấy khác hẳn')",
    "ruou_vong_vo": "nói vòng vo về rượu (không dùng chữ 'rượu')",
}


def parse_variants(content) -> list[str] | None:
    """JSON list chuỗi (bỏ 1 lớp code-fence). Hỏng -> None."""
    if not isinstance(content, str):
        return None
    s = content.strip()
    m = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1)
    try:
        obj = json.loads(s)
    except ValueError:
        return None
    if not isinstance(obj, list):
        return None
    out = [v[:MAX_VARIANT_CHARS] for v in obj
           if isinstance(v, str) and v.strip()]
    return out[:MAX_VARIANTS] or None


def _seeds(cases: list[dict], n: int) -> list[dict]:
    """n ca seed xoay vòng theo attack (thứ tự ATTACKS)."""
    by = {a: [c for c in cases if c["attack"] == a] for a in ATTACKS}
    order = [a for a in ATTACKS if by[a]]
    return [by[a][(i // len(order)) % len(by[a])]
            for i, a in ((i, order[i % len(order)]) for i in range(n))]


def run_generate(cases: list[dict], n: int, model: str,
                 out: Path | None) -> int:
    from pipelines import llm_gateway  # lười: bộ cố định không cần openai

    ok_calls = parse_err = gw_err = 0
    rows, leaks = [], []
    stopped = None
    for seed in _seeds(cases, n):
        messages = [
            {"role": "system", "content": GEN_SYSTEM},
            {"role": "user", "content":
                f"Kỹ thuật: {ATTACK_HINT[seed['attack']]}\n"
                f"Câu mẫu: {seed['text']}"}]
        try:
            resp = llm_gateway.chat(AGENT_ID, messages, model=model,
                                    feature="data_platform-07.3",
                                    temperature=0.9, max_tokens=800)
            variants = parse_variants(resp.choices[0].message.content)
        except llm_gateway.GatewayBlocked as e:
            stopped = str(e)
            break
        except llm_gateway.GatewayError as e:
            gw_err += 1
            print(f"[warn] gateway lỗi: {e}")
            continue
        except Exception as e:  # noqa: BLE001 — 1 call hỏng không dừng cả lượt
            parse_err += 1
            print(f"[warn] phản hồi lỗi: {type(e).__name__}")
            continue
        if variants is None:
            parse_err += 1
            continue
        ok_calls += 1
        for v in variants:
            blocked, codes = judge(v, _ctx(seed), seed["code"])
            row = {"seed": seed["id"], "attack": seed["attack"],
                   "severity": seed["severity"], "code": seed["code"],
                   "ctx": seed.get("ctx", {}), "text": v,
                   "blocked": blocked, "codes": codes,
                   "source": f"llm:{model}"}
            rows.append(row)
            if not blocked:
                leaks.append(row)
    print(f"[redteam] generate model={model} agent={AGENT_ID}: call OK "
          f"{ok_calls}/{n}, phản hồi hỏng {parse_err}, gateway lỗi {gw_err},"
          f" biến thể {len(rows)}, lọt {len(leaks)}")
    if stopped:
        print(f"[warn] dừng sớm — {stopped}")
    for r in leaks:
        print(f"[LỌT] seed {r['seed']} ({r['attack']}) thiếu {r['code']} "
              f"(có {r['codes']}) — {_short(r['text'])}")
    print("chi phí: xem llm_usage agent_id='redteam' (gateway ghi mỗi call)")
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n"
                               for r in rows), encoding="utf-8")
        print(f"[out] {len(rows)} biến thể -> {out} (KHÔNG vào bộ chính "
              "thức — người duyệt rồi mới chép)")
    return 0 if ok_calls else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/redteam.py",
                                 description="Red-team PC-A9 guardrail")
    ap.add_argument("--cases", type=Path, default=CASES,
                    help="bộ ca jsonl (mặc định data/eval/redteam.jsonl)")
    ap.add_argument("--generate", type=int, metavar="N",
                    help=f"sinh biến thể bằng LLM, 1..{MAX_GENERATE} call")
    ap.add_argument("--model", help="model red-team (mặc định env "
                                    "REDTEAM_MODEL) — khác họ model content")
    ap.add_argument("--out", type=Path, help="ghi biến thể sinh ra (jsonl)")
    args = ap.parse_args(argv)
    try:
        cases = load_cases(args.cases)
    except SchemaError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2
    if args.generate is None:
        return run_fixed(cases)
    if not 1 <= args.generate <= MAX_GENERATE:
        print(f"[error] --generate phải trong 1..{MAX_GENERATE}",
              file=sys.stderr)
        return 2
    model = (args.model or os.environ.get("REDTEAM_MODEL") or "").strip()
    content_model = (os.environ.get("OR_CHAT_MODEL")
                     or DEFAULT_CONTENT_MODEL)
    if not family(model) or family(model) == family(content_model):
        print(f"[error] model red-team '{model}' phải có dạng họ/tên và KHÁC "
              f"họ model content '{family(content_model)}'", file=sys.stderr)
        return 2
    if args.out is not None and args.out.resolve() == CASES.resolve():
        print("[error] --out không được ghi đè bộ chính thức",
              file=sys.stderr)
        return 2
    return run_generate(cases, args.generate, model, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
