"""v8.3 DA-04 — checklist + NHÁP hồ sơ tham gia chương trình (phòng Dự án).

Contract:
  - Template `data/projects/ho_so_templates.json` (BẢN DEV SOẠN): giới
    thiệu DN công khai + nguồn, mỗi loại chương trình (hoi_cho | ocop |
    xuc_tien_tmdt) có checklist giấy tờ + thư đăng ký có placeholder.
  - `eligible_skus(golden)` THUẦN: `alcohol` → loại khỏi MỌI phần (kể cả
    câu hỏi); `tpbvsk` chưa XNQC `approved` (thiếu field = none) → loại khỏi
    bản nộp + câu hỏi Pháp chế; `food` → được dùng; loại lạ → loại + hỏi.
  - `build(program, template, golden, llm=False)` → {payload, internal,
    problems}: `payload` = BẢN NỘP (đúng chuỗi được hash khi duyệt);
    `internal` = checklist + câu hỏi Pháp chế (KHÔNG vào hàng duyệt, KHÔNG
    gửi LLM). Cổng payload: `guardrail.check_publish(channel="web")` ok VÀ
    không rượu (`kb_filter.is_alcohol`) VÀ không tên SKU bị loại.
  - `--llm` (mặc định TẮT): chỉ viết lại THƯ qua `llm_gateway.chat
    ("projects")` từ dữ kiện công khai (tên/đơn vị/hạn chương trình + tên
    SKU được phép); kết quả qua CÙNG cổng; trượt/lỗi/rỗng → thư template +
    ghi lý do vào file nội bộ.
  - `--submit` chỉ khi problems rỗng → `director.submit(... "projects",
    "program_application")` PENDING — người duyệt qua `pipelines.
    approval_queue --approve`; agent KHÔNG tự duyệt.
  - `--export` chỉ xuất mục approved khớp sha256 bản duyệt; `--verify-
    submit` so file sắp nộp với bản duyệt. Agent KHÔNG có lệnh nộp/gửi —
    GĐ dự án tự nộp sau khi thấy "KHỚP".

Chạy:
  python -m agents.da_hoso --checklist PROGRAM_ID --template T [--out-dir D]
  python -m agents.da_hoso --draft PROGRAM_ID --template T [--llm] [--submit]
                           [--out-dir D]
  python -m agents.da_hoso --export QUEUE_ID --out FILE
  python -m agents.da_hoso --verify-submit QUEUE_ID FILE
Exit: 0 ok · 1 bị từ chối (problems / không thấy / lệch hash / chưa
duyệt) · 2 tham số sai / DB down / lỗi DB.
"""

import argparse
import json
import re
import sys
from contextlib import suppress
from datetime import date
from pathlib import Path

import psycopg

from agents.report import REPORTS_DIR, write_report
from ingest.golden_store import GOLDEN_FILE, read_golden
from ingest.lead_store import connect
from pipelines import approval_queue as aq
from pipelines import director, guardrail, kb_filter, llm_gateway
from pipelines.store import _db_msg, _oneline

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_FILE = ROOT / "data" / "projects" / "ho_so_templates.json"
OWNERS = ("du_an", "phap_che", "tai_chinh", "san_xuat")
AI_LABEL = "Nội dung có sử dụng AI"
AGENT = "projects"
BLOCK = "projects"
OBJECT_TYPE = "program_application"
CREATED_BY = "agent:da_hoso"
MAX_SUBMIT_BYTES = 2_000_000
LLM_MAX = 3000
_PH_RE = re.compile(r"\{(program_title|organizer|deadline|products)\}")
_LLM_SYS = ("Bạn viết lại thư đăng ký tham gia chương trình xúc tiến thương "
            "mại cho một doanh nghiệp, tiếng Việt, trang trọng, tối đa 150 "
            "từ. CHỈ dùng các dữ kiện được cung cấp; không nêu công dụng sức "
            "khỏe, không nêu địa danh vùng trồng, không nêu số liệu, không "
            "nhắc đồ uống có cồn, không thêm sản phẩm khác.")


class TemplateError(ValueError):
    """File template thiếu/hỏng/sai cấu trúc."""


def load_templates(path: Path | None = None) -> dict:
    path = path or TEMPLATES_FILE
    try:
        doc = json.loads(Path(path).read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise TemplateError(f"{Path(path).name}: không đọc được "
                            f"({type(e).__name__})") from None
    intro = doc.get("company_intro") if isinstance(doc, dict) else None
    if not (isinstance(intro, dict) and isinstance(intro.get("text"), str)
            and intro["text"].strip()
            and re.match(r"https?://", str(intro.get("source_url", "")))):
        raise TemplateError("company_intro: cần text + source_url http(s)")
    tpls = doc.get("templates")
    if not isinstance(tpls, dict) or not tpls:
        raise TemplateError("templates: rỗng")
    for k, t in tpls.items():
        if not (isinstance(t, dict) and isinstance(t.get("name"), str)
                and isinstance(t.get("letter"), str) and t["letter"].strip()
                and isinstance(t.get("checklist"), list) and t["checklist"]):
            raise TemplateError(f"templates.{k}: thiếu name/letter/checklist")
        for i, c in enumerate(t["checklist"]):
            if not (isinstance(c, dict) and isinstance(c.get("item"), str)
                    and c["item"].strip() and c.get("owner") in OWNERS
                    and isinstance(c.get("required"), bool)):
                raise TemplateError(f"templates.{k}.checklist[{i}]: cần item,"
                                    f" owner ∈ {OWNERS}, required bool")
    return doc


def _skus(golden) -> list[dict]:
    skus = golden.get("skus") if isinstance(golden, dict) else golden
    return [s for s in (skus or []) if isinstance(s, dict)]


def eligible_skus(golden) -> tuple[list[dict], list[str]]:
    """→ (SKU được đưa vào bản nộp, câu hỏi Pháp chế). Thuần."""
    allowed, questions = [], []
    for s in _skus(golden):
        key, name, cat = s.get("sku_key"), s.get("name"), s.get("category")
        if cat == "alcohol" or kb_filter.is_alcohol(name or ""):
            continue                               # rượu: loại khỏi mọi phần
        if cat == "food":
            allowed.append(s)
        elif cat == "tpbvsk":
            st = s.get("xnqc_status") or "none"
            if st == "approved":
                allowed.append(s)
            else:
                questions.append(
                    f"SKU `{key}`: TPBVSK chưa có XNQC (trạng thái {st}) — "
                    "Pháp chế xác nhận trước khi đưa vào hồ sơ")
        else:
            questions.append(f"SKU `{key}`: nhóm hàng không rõ — Pháp chế "
                             "phân loại trước khi đưa vào hồ sơ")
    return allowed, questions


def _d(x) -> str:
    return x.strftime("%d/%m/%Y") if isinstance(x, date) else "chưa công bố"


def _fill(letter: str, vals: dict) -> str:
    # 1 lượt — giá trị chèn (tiêu đề từ feed) không bị mở rộng lại.
    return _PH_RE.sub(lambda m: vals[m.group(1)], letter)


def _disclaimer() -> str:
    """Câu khuyến cáo TPBVSK bắt buộc (NĐ 15/2018) — lấy từ luật guardrail;
    lỗi đọc → '' (guardrail tự chặn `thieu_khuyen_cao`, fail-closed)."""
    try:
        doc = json.loads((ROOT / "data" / "guardrail_rules.json")
                         .read_bytes().decode("utf-8"))
        return str(doc["disclaimer"]["canonical"]).strip()
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError):
        return ""


def _payload(program: dict, intro: dict, names: list[str],
             letter: str, tpbvsk: bool = False) -> str:
    prods = [f"- {n}" for n in names] or [
        "- (chưa có sản phẩm đủ điều kiện — chờ Pháp chế)"]
    if tpbvsk:                    # có TPBVSK đã XNQC → kèm câu khuyến cáo
        prods += ["", _disclaimer()]
    return "\n".join([
        f"# Hồ sơ đăng ký tham gia: {_oneline(program['title'], 300)}", "",
        f"- Đơn vị tổ chức: {_oneline(program.get('organizer') or '', 200)}",
        f"- Hạn đăng ký: {_d(program.get('deadline'))}",
        f"- Nguồn chương trình: {_oneline(program['url'], 2000)}", "",
        "## Giới thiệu doanh nghiệp", "", intro["text"].strip(),
        f"Nguồn: {intro['source_url']}", "",
        "## Sản phẩm đăng ký giới thiệu", "", *prods, "",
        "## Thư đăng ký", "", letter.strip(), "", AI_LABEL, ""])


def gate(payload: str, excluded: list[dict]) -> list[str]:
    """Cổng bản nộp → danh sách vấn đề (rỗng = đạt)."""
    probs = []
    g = guardrail.check_publish(payload, channel="web", content_type="post")
    for v in g.get("violations") or []:
        probs.append(f"guardrail: {v.get('code') or v.get('type')}")
    if g.get("ok") is not True and not probs:
        probs.append("guardrail: ok != True")
    if kb_filter.is_alcohol(payload):
        probs.append("ruou: bản nộp nhắc đồ uống có cồn")
    low = payload.casefold()
    for s in excluded:
        if s.get("name") and s["name"].casefold() in low:
            probs.append(f"sku_bi_loai: {s.get('sku_key')}")
    return probs


def _llm_letter(program: dict, names: list[str]) -> tuple[str | None, str]:
    facts = "\n".join([
        f"Tên chương trình: {_oneline(program['title'], 300)}",
        f"Đơn vị tổ chức: {_oneline(program.get('organizer') or '', 200)}",
        f"Hạn đăng ký: {_d(program.get('deadline'))}",
        f"Sản phẩm giới thiệu: {', '.join(names) or '(chưa có)'}",
        "Doanh nghiệp: Công ty TNHH Sâm Sâm"])
    msgs = [{"role": "system", "content": _LLM_SYS},
            {"role": "user", "content": facts}]
    try:
        resp = llm_gateway.chat(AGENT, msgs, max_tokens=600)
        text = resp.choices[0].message.content
    except llm_gateway.GatewayError as e:
        return None, f"gateway từ chối/lỗi ({type(e).__name__})"
    except (AttributeError, IndexError, TypeError):
        return None, "phản hồi LLM hỏng"
    if not isinstance(text, str) or not text.strip():
        return None, "LLM trả rỗng"
    return text.strip()[:LLM_MAX], ""


def _internal(program: dict, template: dict, questions: list[str],
              notes: list[str]) -> str:
    L = [(f"# NỘI BỘ — hồ sơ chương trình #{program['id']} "
          f"({template['name']})"), "",
         "File nội bộ — KHÔNG gửi ra ngoài, KHÔNG vào hàng duyệt.", "",
         "## Checklist giấy tờ", ""]
    L += [f"- [ ] {c['item']} — {c['owner']} "
          f"({'bắt buộc' if c['required'] else 'tùy chọn'})"
          for c in template["checklist"]]
    L += ["", "## Câu hỏi Pháp chế", ""]
    L += [f"- {q}" for q in questions] or ["- (không có)"]
    if notes:
        L += ["", "## Ghi chú", "", *[f"- {n}" for n in notes]]
    return "\n".join(L) + "\n"


def build(program: dict, template: dict, golden, *, llm: bool = False,
          intro: dict | None = None) -> dict:
    """Nháp hồ sơ → {payload, internal, problems}."""
    intro = intro or load_templates()["company_intro"]
    allowed, questions = eligible_skus(golden)
    keep = {id(s) for s in allowed}
    excluded = [s for s in _skus(golden) if id(s) not in keep]
    names = [s["name"] for s in allowed if s.get("name")]
    tp = any(s.get("category") == "tpbvsk" for s in allowed)
    vals = {"program_title": _oneline(program["title"], 300),
            "organizer": _oneline(program.get("organizer") or "", 200),
            "deadline": _d(program.get("deadline")),
            "products": ", ".join(names) or "(chờ Pháp chế xác nhận)"}
    letter = _fill(template["letter"], vals)
    notes = []
    if llm:
        text, why = _llm_letter(program, names)
        if text is not None:
            bad = gate(_payload(program, intro, names, text, tp), excluded)
            why = "; ".join(bad)
        if text is not None and not why:
            letter = text
        else:
            notes.append(f"Thư LLM bị loại: {why} — dùng thư template")
    payload = _payload(program, intro, names, letter, tp)
    problems = gate(payload, excluded)
    if not names:
        problems.append("0 sản phẩm đủ điều kiện — chờ Pháp chế")
    return {"payload": payload, "problems": problems,
            "internal": _internal(program, template, questions, notes)}


def _warn_head(problems: list[str]) -> str:
    return ("> **CẢNH BÁO — bản nháp KHÔNG đạt cổng, KHÔNG được trình "
            "duyệt:** " + "; ".join(problems) + "\n\n") if problems else ""


def _program(conn, pid: int) -> dict | None:
    row = conn.execute("select id, title, organizer, deadline, url from"
                       " programs where id = %s", (pid,)).fetchone()
    return dict(zip(("id", "title", "organizer", "deadline", "url"),
                    row)) if row else None


def _queue_row(conn, qid: int):
    return conn.execute("select block, object_type, status, payload from"
                        " approval_queue where id = %s", (qid,)).fetchone()


def _export(conn, qid: int, out: Path) -> int:
    row = _queue_row(conn, qid)
    if (row is None or row[0] != BLOCK or row[1] != OBJECT_TYPE
            or row[2] != "approved"):
        print(f"[warn] mục #{qid} không phải hồ sơ `{OBJECT_TYPE}` đã duyệt"
              " — KHÔNG xuất", file=sys.stderr)
        return 1
    if not aq.verify(conn, qid, row[3]):
        print(f"[warn] mục #{qid}: LỆCH bản duyệt (sha256) — KHÔNG xuất",
              file=sys.stderr)
        return 1
    path = write_report(row[3], out.parent, out.name)  # bytes + atomic
    print(f"[done] xuất bản ĐÃ DUYỆT mục #{qid} → {path} (GĐ dự án tự nộp;"
          " chạy --verify-submit trước khi nộp)")
    return 0


def _verify_submit(conn, qid: int, f: Path) -> int:
    try:
        if f.stat().st_size > MAX_SUBMIT_BYTES:
            print("[warn] file quá lớn — LỆCH bản duyệt, KHÔNG nộp",
                  file=sys.stderr)
            return 1
        text = f.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print(f"[warn] không đọc được file ({type(e).__name__}) — KHÔNG nộp",
              file=sys.stderr)
        return 1
    row = _queue_row(conn, qid)
    # Mục phải ĐÚNG loại + ĐÃ duyệt (verify_publish chỉ so bản duyệt mới
    # nhất của object — mục pending cùng object không được báo "KHỚP").
    if row is None or row[0] != BLOCK or row[1] != OBJECT_TYPE \
            or row[2] != "approved" or not aq.verify(conn, qid, text):
        print(f"[warn] mục #{qid}: LỆCH bản duyệt — KHÔNG nộp (soạn lại + "
              "duyệt lại)", file=sys.stderr)
        return 1
    print(f"[ok] mục #{qid}: KHỚP bản đã duyệt — GĐ dự án tự nộp")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m agents.da_hoso",
        description="DA-04 hồ sơ tham gia chương trình — NHÁP; agent không "
                    "tự duyệt, không tự nộp/gửi")
    ap.add_argument("--checklist", type=int, metavar="PROGRAM_ID")
    ap.add_argument("--draft", type=int, metavar="PROGRAM_ID")
    ap.add_argument("--export", type=int, metavar="QUEUE_ID")
    ap.add_argument("--verify-submit", nargs=2, metavar=("QUEUE_ID", "FILE"))
    ap.add_argument("--template")
    ap.add_argument("--llm", action="store_true",
                    help="viết lại thư qua LLM (mặc định TẮT)")
    ap.add_argument("--submit", action="store_true",
                    help="đẩy bản nộp vào hàng duyệt khối projects")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--out-dir", type=Path, default=REPORTS_DIR)
    a = ap.parse_args(argv)
    ops = (a.checklist, a.draft, a.export, a.verify_submit)
    if sum(x is not None for x in ops) != 1:
        ap.error("cần đúng 1 thao tác: --checklist | --draft | --export | "
                 "--verify-submit")
    if (a.llm or a.submit) and a.draft is None:
        ap.error("--llm/--submit chỉ dùng với --draft")
    if (a.export is None) != (a.out is None):
        ap.error("--export cần --out FILE (và --out chỉ đi với --export)")
    vqid = None
    if a.verify_submit is not None:
        try:
            vqid = int(a.verify_submit[0])
        except ValueError:
            ap.error("--verify-submit QUEUE_ID phải là số")
    pid = a.checklist if a.checklist is not None else a.draft
    tpl = golden = intro = None
    if pid is not None:
        if not a.template:
            ap.error("--checklist/--draft cần --template")
        try:
            doc = load_templates()
        except TemplateError as e:
            print(f"[error] template hỏng: {e}", file=sys.stderr)
            return 1
        if a.template not in doc["templates"]:
            ap.error(f"--template lạ — có: {sorted(doc['templates'])}")
        tpl, intro = doc["templates"][a.template], doc["company_intro"]
        golden, err = read_golden(GOLDEN_FILE)
        if err:
            print(f"[error] golden SKU: {err}", file=sys.stderr)
            return 1
    elif a.template:
        ap.error("--template chỉ dùng với --checklist/--draft")
    conn = connect()
    if conn is None:
        print("[error] không kết nối được Postgres (DATABASE_URL thiếu hoặc"
              " host chết)", file=sys.stderr)
        return 2
    try:
        if a.export is not None:
            return _export(conn, a.export, a.out)
        if vqid is not None:
            return _verify_submit(conn, vqid, Path(a.verify_submit[1]))
        prog = _program(conn, pid)
        if prog is None:
            print(f"[warn] không có chương trình #{pid} trong `programs`",
                  file=sys.stderr)
            return 1
        res = build(prog, tpl, golden, llm=a.llm, intro=intro)
        stem = f"da-hoso-{pid}-{a.template}"
        warn = _warn_head(res["problems"])
        p_int = write_report(warn + res["internal"], a.out_dir,
                             f"{stem}-noi-bo.md")
        if a.checklist is not None:
            print(f"[done] checklist nội bộ → {p_int}")
            return 0
        p_pay = write_report(warn + res["payload"], a.out_dir, f"{stem}.md")
        print(f"[done] nháp bản nộp → {p_pay} · nội bộ → {p_int}")
        if res["problems"]:
            print(f"[warn] {len(res['problems'])} vấn đề: "
                  + "; ".join(res["problems"]), file=sys.stderr)
            if a.submit:
                print("[warn] --submit bị TỪ CHỐI — sửa nháp trước",
                      file=sys.stderr)
                return 1
            return 0
        if a.submit:
            try:
                qid = director.submit(
                    conn, BLOCK, OBJECT_TYPE, object_id=f"program:{pid}:"
                    f"{a.template}", title="Hồ sơ tham gia: "
                    + _oneline(prog["title"], 120), payload=res["payload"],
                    created_by=CREATED_BY)
            except psycopg.errors.UniqueViolation:
                print(f"[warn] chương trình #{pid}/{a.template} đã có mục "
                      "đang chờ duyệt — không đẩy trùng", file=sys.stderr)
                return 1
            print(f"[done] đã đẩy mục #{qid} vào hàng duyệt khối projects "
                  "(PENDING — người duyệt: python -m pipelines.approval_queue"
                  " --approve ID --by <tên>)")
        return 0
    except psycopg.Error as e:
        print(f"[error] lỗi DB: {_db_msg(e)}", file=sys.stderr)
        return 2
    finally:
        with suppress(Exception):
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
