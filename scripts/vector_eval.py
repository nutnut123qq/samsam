"""v10.3 W103.5 — eval retrieve pgvector vs float8 trên corpus THẬT (WP16:
"eval retrieve sau khi chuyển pgvector không thấp hơn bản float8[]").

Postgres local chưa có extension `vector` (external-dep) → dựng container
TẠM từ image ĐÃ CÓ `pgvector/pgvector:0.8.6-pg17-trixie` (`--pull never`,
cổng chỉ bind 127.0.0.1, mật khẩu ngẫu nhiên qua env tiến trình, data dir
`--tmpfs`, tên `samsam-vec-*`, LUÔN dọn trong `finally`) — tái dùng helper
`scripts/dr_drill.py`. Apply `schema.sql` + `schema_pgvector.sql` (2 lần —
idempotent), chép `chunks` (+ `chunks_internal`) từ `DATABASE_URL` NGUỒN
bằng SELECT (conn read-only — nguồn KHÔNG bị ghi), rồi so 2 backend qua
`api.rag.retrieve_by_vector` với `DATABASE_URL` trỏ container:
  (a) `--synthetic N` (mặc định 200, `random.Random(42)`): query =
      chuẩn hóa(e_i + e_j) của 2 chunk ngẫu nhiên — tất định, 0 API.
  (b) `--questions`: Q1–Q10 `tests/questions.md` embed qua
      `llm_gateway.embed("chatbot", ...)` (embed TRƯỚC khi trỏ sang
      container → trần chi phí/llm_usage của gateway giữ nguyên); thiếu
      key / gateway lỗi → `[external-dep]` bỏ phần (b), không fail.
Chỉ số: recall@8 = |top_pg ∩ top_f8| / |top_f8| (định danh chunk =
(doc_id, chunk_index)), top-1 trùng; (b) thêm "nhóm kỳ vọng trúng" = số
nhóm `eval_qa.EXPECTED[n]` có alternative (casefold) trong content top-k.
PASS khi recall@8 trung bình ≥ 0.99 VÀ mỗi câu (b) pgvector trúng ≥ float8
VÀ checksum float8 (`md5(string_agg(embedding::text …))`) nguồn = container
trước = sau migration VÀ `embedding_v` not null = `embedding` not null.

Exit: 0 pass; 1 fail / container không dọn được / nguồn đổi; 2 usage;
3 thiếu docker-daemon-image (`[external-dep]`). Không in DSN/mật khẩu.
"""

import argparse
import os
import random
import secrets
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import psycopg
from dotenv import load_dotenv
from psycopg import sql as psql
from psycopg.conninfo import make_conninfo

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT))
import dr_drill as dr

# Console Windows cp1258 — print tiếng Việt có dấu crash; ép UTF-8.
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

IMAGE = "pgvector/pgvector:0.8.6-pg17-trixie"
PREFIX = "samsam-vec-"
K = 8
RECALL_MIN = 0.99
READY_TIMEOUT_S = 60
CONNECT_TIMEOUT_S = 10
TABLES = ("chunks", "chunks_internal")
N_MAX = 5000


# ---------------------------------------------------------------- thuần


def recall_at_k(top_pg, top_f8) -> float:
    """|pg ∩ f8| / |f8|; f8 rỗng → 1.0 nếu pg cũng rỗng, ngược lại 0.0."""
    f8 = set(top_f8)
    if not f8:
        return 1.0 if not set(top_pg) else 0.0
    return len(set(top_pg) & f8) / len(f8)


def synthetic_queries(embs, n: int, seed: int = 42) -> list[np.ndarray]:
    """Query tất định = chuẩn hóa(e_i + e_j), i ≠ j chọn bằng Random(seed)."""
    embs = np.asarray(embs, dtype=np.float64)
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        i, j = rng.sample(range(len(embs)), 2)
        v = embs[i] + embs[j]
        nv = np.linalg.norm(v)
        out.append(v / nv if nv else v)
    return out


def groups_hit(hits: list[dict], groups: list[list[str]]) -> int:
    text = "\n".join(h["content"] or "" for h in hits).casefold()
    return sum(any(a.casefold() in text for a in g) for g in groups)


def _ids(hits: list[dict]) -> list[tuple]:
    return [(h["doc_id"], h["chunk_index"]) for h in hits]


# ---------------------------------------------------------------- DB


def checksum(conn, table: str) -> tuple:
    """(số dòng, md5 embedding float8[] theo id) — bằng chứng float8 giữ."""
    return tuple(conn.execute(psql.SQL(
        "select count(*), md5(coalesce(string_agg(embedding::text, ','"
        " order by id), '')) from {}").format(psql.Identifier(table))
    ).fetchone())


def _columns(conn, table: str) -> list[str]:
    return [r[0] for r in conn.execute(
        "select column_name from information_schema.columns where"
        " table_schema = current_schema() and table_name = %s"
        " order by ordinal_position", (table,))]


def read_source(dsn: str) -> tuple[dict, dict]:
    """→ ({bảng: (cột, rows)}, {bảng: checksum}). Conn read-only."""
    data, sums = {}, {}
    with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S) as c:
        c.read_only = True
        for t in TABLES:
            cols = [x for x in _columns(c, t) if x != "embedding_v"]
            rows = c.execute(psql.SQL("select {} from {}").format(
                psql.SQL(", ").join(map(psql.Identifier, cols)),
                psql.Identifier(t))).fetchall()
            data[t] = (cols, rows)
            sums[t] = checksum(c, t)
    return data, sums


def source_sums(dsn: str) -> dict:
    with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_S) as c:
        c.read_only = True
        return {t: checksum(c, t) for t in TABLES}


def _copy(conn, table: str, cols: list[str], rows: list) -> None:
    have = set(_columns(conn, table))
    keep = [i for i, x in enumerate(cols) if x in have]
    q = psql.SQL("insert into {} ({}) values ({})").format(
        psql.Identifier(table),
        psql.SQL(", ").join(psql.Identifier(cols[i]) for i in keep),
        psql.SQL(", ").join(psql.Placeholder() * len(keep)))
    with conn.cursor() as cur:
        cur.executemany(q, [tuple(r[i] for i in keep) for r in rows])


def prepare(dsn: str, data: dict, src_sums: dict) -> list[str]:
    """Schema + chép + migration ×2 trong container → lỗi (rỗng = sạch)."""
    errs = []
    schema = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    pgv = (ROOT / "docs" / "schema_pgvector.sql").read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True,
                         connect_timeout=CONNECT_TIMEOUT_S) as c:
        c.execute("set search_path to public, pg_temp")
        c.execute(schema)
        for t, (cols, rows) in data.items():
            _copy(c, t, cols, rows)
        before = {t: checksum(c, t) for t in TABLES}
        for run in (1, 2):
            c.execute(pgv)
            print(f"[eval] schema_pgvector.sql lần {run}: sạch")
        after = {t: checksum(c, t) for t in TABLES}
        for t in TABLES:
            nn = c.execute(psql.SQL(
                "select count(embedding_v), count(embedding) from {}").format(
                psql.Identifier(t))).fetchone()
            print(f"[eval] {t}: {before[t][0]} dòng, checksum float8 nguồn="
                  f"{src_sums[t][1][:12]} trước={before[t][1][:12]} "
                  f"sau={after[t][1][:12]}, embedding_v/embedding not null "
                  f"= {nn[0]}/{nn[1]}")
            if not src_sums[t] == before[t] == after[t]:
                errs.append(f"{t}: checksum float8 lệch")
            if nn[0] != nn[1]:
                errs.append(f"{t}: embedding_v not null ≠ embedding")
        # trigger đồng bộ: ghi embedding → embedding_v tự có (rollback)
        with c.transaction():
            ok = c.execute(
                "insert into chunks (doc_id, chunk_index, content,"
                " embedding) values ('__v103_probe', 0, 'x', %s)"
                " returning embedding_v is not null",
                ([0.001] * 1536,)).fetchone()[0]
            raise psycopg.Rollback()
        print(f"[eval] trigger đồng bộ embedding → embedding_v: "
              f"{'OK' if ok else 'HỎNG'}")
        if not ok:
            errs.append("trigger không đồng bộ embedding_v")
    return errs


def compare(queries: list, k: int = K) -> list[dict]:
    """Mỗi query: hits 2 backend qua `rag.retrieve_by_vector` (DATABASE_URL
    đã trỏ container)."""
    from api import rag
    out = []
    for qv in queries:
        f8 = rag.retrieve_by_vector(qv, k, backend="float8", ident=True)
        pg = rag.retrieve_by_vector(qv, k, backend="pgvector", ident=True)
        out.append({"f8": f8, "pg": pg,
                    "recall": recall_at_k(_ids(pg), _ids(f8)),
                    "top1": bool(f8 and pg and _ids(f8)[0] == _ids(pg)[0])})
    return out


def embed_questions() -> tuple[dict, str | None]:
    """→ ({n: (câu, vector)}, lý do bỏ qua | None)."""
    try:
        import eval_qa

        from pipelines.llm_gateway import embed
        qs = eval_qa.load_questions()
        out = {}
        for n in range(1, 11):
            if n not in qs:
                return {}, f"questions.md thiếu Q{n}"
            out[n] = (qs[n], np.array(
                embed("chatbot", qs[n]).data[0].embedding, dtype=np.float64))
        return out, None
    except Exception as e:  # noqa: BLE001 — thiếu key/gateway chặn/mạng
        return {}, f"không embed được câu hỏi ({type(e).__name__})"


def _summary(res: list[dict]) -> tuple[float, float]:
    if not res:
        return 1.0, 1.0
    return (sum(r["recall"] for r in res) / len(res),
            sum(r["top1"] for r in res) / len(res))


def run_eval(dsn: str, data: dict, src_sums: dict, n_syn: int,
             questions: dict | None) -> int:
    errs = prepare(dsn, data, src_sums)
    embs = [r[data["chunks"][0].index("embedding")] for r in
            data["chunks"][1] if r[data["chunks"][0].index("embedding")]]
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = dsn   # chỉ env tiến trình này
    try:
        syn = compare(synthetic_queries(embs, n_syn)) if n_syn else []
        qres = {}
        if questions:
            from eval_qa import EXPECTED
            for n, (_q, qv) in questions.items():
                (r,) = compare([qv])
                r["g_f8"] = groups_hit(r["f8"], EXPECTED[n])
                r["g_pg"] = groups_hit(r["pg"], EXPECTED[n])
                qres[n] = r
    finally:
        if old is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = old
    rec, top1 = _summary(syn)
    print(f"[eval] (a) synthetic n={len(syn)} seed=42: recall@{K} trung bình"
          f" {rec:.4f}, top-1 trùng {top1:.4f}, min recall "
          f"{min((r['recall'] for r in syn), default=1.0):.3f}")
    all_res = syn + list(qres.values())
    if questions:
        print(f"[eval] (b) Q1–Q10 | recall@{K} | top-1 | nhóm kỳ vọng trúng "
              "f8 → pg")
        for n, r in qres.items():
            mark = "OK" if r["g_pg"] >= r["g_f8"] else "THẤP HƠN"
            print(f"  Q{n:<2} | {r['recall']:.3f} | "
                  f"{'trùng' if r['top1'] else 'khác'} | {r['g_f8']}/"
                  f"{len(EXPECTED[n])} → {r['g_pg']}/{len(EXPECTED[n])} "
                  f"{mark}")
            if r["g_pg"] < r["g_f8"]:
                errs.append(f"Q{n}: pgvector trúng ít nhóm hơn float8")
    rec_all, _ = _summary(all_res)
    print(f"[eval] recall@{K} trung bình toàn bộ ({len(all_res)} query): "
          f"{rec_all:.4f} (ngưỡng ≥ {RECALL_MIN})")
    if rec_all < RECALL_MIN:
        errs.append(f"recall@{K} {rec_all:.4f} < {RECALL_MIN}")
    for e in errs:
        print(f"[FAIL] {e}")
    return 1 if errs else 0


def main(argv=None, now: datetime | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python scripts/vector_eval.py",
                                 description=__doc__.splitlines()[0])
    ap.add_argument("--synthetic", type=int, default=200, metavar="N",
                    help=f"số query tổng hợp 0..{N_MAX} (mặc định 200)")
    ap.add_argument("--questions", action="store_true",
                    help="thêm Q1–Q10 tests/questions.md (embed qua gateway)")
    args = ap.parse_args(argv)
    if not 0 <= args.synthetic <= N_MAX:
        ap.error(f"--synthetic phải trong 0..{N_MAX}")
    if args.synthetic == 0 and not args.questions:
        ap.error("cần --synthetic N > 0 hoặc --questions")
    load_dotenv(ROOT / ".env")
    src = os.environ.get("DATABASE_URL")
    if not src:
        print("[usage] thiếu DATABASE_URL (corpus nguồn)")
        return 2
    why = dr.probe_docker(IMAGE)
    if why:
        print(f"[external-dep] vector_eval không chạy được: {why}")
        return 3
    try:
        data, src_sums = read_source(src)
    except psycopg.Error as e:
        print(f"[err] đọc corpus nguồn lỗi: {type(e).__name__}")
        return 1
    if len(data["chunks"][1]) < 2:
        print("[err] corpus nguồn < 2 chunk — không eval được")
        return 1
    questions = None
    if args.questions:
        questions, skip = embed_questions()
        if skip:
            print(f"[external-dep] bỏ phần (b): {skip}")
            questions = None
    old = dr.leftovers(PREFIX)
    if old:
        print(f"[warn] container sót từ lần trước (KHÔNG tự xóa): "
              f"{', '.join(old)}")
    now = now or dr.bk.vn_now()
    name = f"{PREFIX}{now:%Y%m%d_%H%M%S}-{secrets.token_hex(2)}"
    password = secrets.token_urlsafe(24)
    dsn = None
    vols: set[str] = set()
    code = 1
    try:
        tmpfs = [a for p in dr.image_volumes(IMAGE) for a in ("--tmpfs", p)]
        r = dr._docker(["run", "-d", "--rm", "--pull", "never", "--name",
                        name, *tmpfs, "-e", "POSTGRES_PASSWORD",
                        "-p", "127.0.0.1::5432", IMAGE],
                       env={**os.environ, "POSTGRES_PASSWORD": password})
        if r.returncode != 0:
            raise RuntimeError("docker run lỗi: " + r.stderr.decode(
                "utf-8", "replace")[:200])
        vols = dr.container_volumes(name)
        dsn = make_conninfo("", host="127.0.0.1", port=dr.host_port(name),
                            user="postgres", password=password,
                            dbname="postgres")
        dr.wait_ready(dsn, READY_TIMEOUT_S)
        print(f"[eval] container {name} ({IMAGE}) sẵn sàng")
        code = run_eval(dsn, data, src_sums, args.synthetic, questions)
    except (RuntimeError, OSError, psycopg.Error,
            subprocess.TimeoutExpired) as e:
        print(f"[err] {type(e).__name__}: {dr.bk.scrub(e, dsn)}")
        code = 1
    finally:
        if not dr.cleanup(name, vols):
            print(f"[ALERT] container {name} chưa dọn — `docker rm -f -v "
                  f"{name}` ngay")
            code = 1
        else:
            print(f"[eval] container {name} đã dọn")
    try:
        after = source_sums(src)
    except psycopg.Error as e:
        print(f"[err] đọc lại nguồn lỗi: {type(e).__name__}")
        return 1
    same = after == src_sums
    print(f"[eval] corpus NGUỒN không đổi (số dòng + md5): "
          f"{'OK' if same else 'ĐỔI'} — chunks {after['chunks'][0]} dòng")
    if not same:
        code = 1
    print("[PASS]" if code == 0 else "[FAIL] vector_eval")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
