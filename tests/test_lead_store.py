"""v1.9-leads (W2.x) — `ingest.lead_store`: intent/channel/dedup
transforms thuần + harvest edge (enumerate đủ lớp điều-kiện-biên) +
fake-conn chứng minh insert-only on-conflict (KHÔNG delete) + schema
drift guard. Không cần DB thật."""

import json
import re
from pathlib import Path

from ingest import lead_store as ls

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def _rec(**kw):
    base = {"ts": "2026-10-10T01:02:03Z", "msg_id": "m1",
            "user_hash": "abc123", "question": "Saphraton giá bao nhiêu?",
            "answered": True, "sent": True}
    base.update(kw)
    return base


# ---------- transforms thuần ----------

def test_intent_classify_each_class_and_none():
    assert ls.intent_of("Cho tôi mua sỉ 100 hộp") == "partner"
    assert ls.intent_of("Tôi muốn đặt hàng giao về Đà Nẵng") == "order"
    assert ls.intent_of("Sâm Sâm có ship sang Mỹ không?") == "order"
    assert ls.intent_of("Saphraton giá bao nhiêu?") == "price"
    assert ls.intent_of("Sâm Sâm có showroom ở đâu?") == "contact"
    assert ls.intent_of("Có văn phòng tại Hà Nội không?") == "contact"
    # Priority: partner thắng price ("giá sỉ"), order thắng contact
    # ("mua ở đâu").
    assert ls.intent_of("giá sỉ bao nhiêu") == "partner"
    assert ls.intent_of("mua sâm ở đâu?") == "order"
    # Câu thông tin/y tế KHÔNG phải lead.
    assert ls.intent_of("Saphraton chữa được ung thư không?") is None
    assert ls.intent_of("xin chào") is None
    assert ls.intent_of("") is None


def test_channel_of_msgid_empty_vs_present():
    assert ls.channel_of(_rec(msg_id="m1")) == "zalo"
    assert ls.channel_of(_rec(msg_id="")) == "streamlit"
    # Entry convlog cũ không có key sent/msg_id → streamlit phải dựa
    # vào msg_id rỗng, không dựa vào `sent`.
    old = _rec(msg_id="")
    del old["sent"]
    assert ls.channel_of(old) == "streamlit"


def test_dedup_key_msgid_vs_hash():
    assert ls.dedup_key(_rec(msg_id="m1")) == "convlog:m1"
    r = _rec(msg_id="")
    k = ls.dedup_key(r)
    assert k.startswith("convlog:") and len(k) == len("convlog:") + 16
    assert ls.dedup_key(r) == k          # deterministic
    assert ls.dedup_key(_rec(msg_id="", ts="x")) != k


def test_lead_row_skip_reasons():
    row, why = ls.lead_row(_rec())
    assert why is None and row["intent"] == "price"
    assert row["channel"] == "zalo" and row["status"] == "new"
    assert row["source"] == "conversations.jsonl"
    # Thiếu field bắt buộc (question/ts/user_hash trống hoặc vắng).
    for kw in ({"question": ""}, {"question": "  "}, {"ts": ""},
               {"user_hash": ""}, {"question": None}):
        assert ls.lead_row(_rec(**kw))[1] == "fields", kw
    # ts sai ISO → 'ts'.
    for bad in ("10/10/2026", "2026-10-10", "not-a-date"):
        assert ls.lead_row(_rec(ts=bad))[1] == "ts", bad
    # Question không khớp intent → 'intent' (không phải lead).
    assert ls.lead_row(_rec(question="chữa ung thư được không")) \
        == (None, "intent")


# ---------- harvest edge (enumerate đủ) ----------

def test_harvest_missing_and_empty(tmp_path):
    # File thiếu hoàn toàn → rỗng, không raise, leads giữ nguyên.
    rows, stats = ls.harvest(tmp_path)
    assert rows == [] and stats["records"] == 0
    assert "conversations.jsonl" in stats["missing"]
    # File tồn tại nhưng 0 record (rỗng / chỉ _doc / chỉ corrupt) —
    # 3 biến thể khác nhau cùng → rỗng (bài học v1.8: missing≠empty).
    (tmp_path / "conversations.jsonl").write_bytes(b"")
    assert ls.harvest(tmp_path)[0] == []
    (tmp_path / "conversations.jsonl").write_bytes(b'{"_doc": "x"}\n')
    rows, stats = ls.harvest(tmp_path)
    assert rows == [] and stats["doc"] == 1
    (tmp_path / "conversations.jsonl").write_bytes(b"{corrupt\n[1,2]\n")
    rows, stats = ls.harvest(tmp_path)
    assert rows == [] and stats["corrupt"] == 2


def test_harvest_reads_rotated_and_skips_bad_lines(tmp_path):
    main = tmp_path / "conversations.jsonl"
    rot = tmp_path / "conversations.jsonl.1"
    u2 = _rec(msg_id="", ts="2026-10-10T02:00:00Z", user_hash="u2",
              question="mua sâm ở đâu")
    main.write_bytes(
        json.dumps(_rec(msg_id="m1")).encode() + b"\n"
        + b"{broken json\n"                                  # corrupt
        + json.dumps(_rec(msg_id="m2", question="xin chào"))
        .encode() + b"\n"                                     # no-intent
        + json.dumps(_rec(msg_id="m1", question="đặt hàng ship"))
        .encode() + b"\n"                                     # dup key m1
        + json.dumps(u2).encode() + b"\n")
    rot.write_bytes(
        json.dumps(_rec(msg_id="m9",
                        question="giá bao nhiêu")).encode() + b"\n")
    rows, stats = ls.harvest(tmp_path)
    # m1 (price) + u2 (order, msg_id rỗng → streamlit) + m9 từ file .1.
    assert [r["dedup_key"] for r in rows] == [
        "convlog:m1", ls.dedup_key(u2), "convlog:m9"]
    assert ls.dedup_key(u2).startswith("convlog:") \
        and "m1" not in ls.dedup_key(u2)
    assert stats["corrupt"] == 1 and stats["intent"] == 1
    assert stats["dup_in_file"] == 1 and stats["records"] == 5
    chans = {r["channel"] for r in rows}
    assert chans == {"zalo", "streamlit"}


def test_harvest_counts_missing_fields_bad_ts_and_bad_types(tmp_path):
    missing_question = _rec(msg_id="missing-question")
    del missing_question["question"]
    missing_ts = _rec(msg_id="missing-ts")
    del missing_ts["ts"]
    missing_hash = _rec(msg_id="missing-hash")
    del missing_hash["user_hash"]
    records = [
        _rec(msg_id="valid"),
        missing_question,
        missing_ts,
        missing_hash,
        _rec(msg_id="bad-ts", ts="10/10/2026"),
        _rec(msg_id="bad-question", question=42),
        _rec(msg_id="bad-hash", user_hash=42),
        _rec(msg_id="bad-ts-type", ts=123),
    ]
    (tmp_path / "conversations.jsonl").write_bytes(
        b"\n".join(json.dumps(r).encode() for r in records) + b"\n")

    rows, stats = ls.harvest(tmp_path)

    assert [r["dedup_key"] for r in rows] == ["convlog:valid"]
    assert stats["records"] == 8
    assert stats["fields"] == 5
    assert stats["ts"] == 2


def test_harvest_splits_only_ascii_newline(tmp_path):
    record = _rec(question="giá\u2028 bao nhiêu")
    path = tmp_path / "conversations.jsonl"
    path.write_bytes(json.dumps(record, ensure_ascii=False).encode("utf-8")
                     + b"\n")

    rows, stats = ls.harvest(tmp_path)

    assert len(rows) == 1
    assert rows[0]["question"] == "giá\u2028 bao nhiêu"
    assert stats["corrupt"] == 0


def test_harvest_real_convlog_smoke():
    """Convlog thật: harvest không raise, mọi row đủ cột + ts aware."""
    rows, _ = ls.harvest(DATA)
    assert rows, "convlog thật phải suy ra được lead"
    for r in rows:
        assert set(ls.LEAD_COLS) <= r.keys()
        assert r["ts"].tzinfo is not None
        assert r["channel"] in ("zalo", "streamlit")
        assert r["intent"] in ("partner", "order", "price", "contact")


# ---------- apply + stats qua fake-conn ----------

class _FakeCur:
    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self._conn.ops.append(("exec", sql))
        # Lần đầu insert → rowcount 1; gọi lại → 0 (on conflict skip).
        self.rowcount = 0 if self._conn.seen else 1
        self._conn.seen = True


class _FakeConn:
    def __init__(self):
        self.ops = []
        self.seen = False

    def cursor(self):
        return _FakeCur(self)


def test_apply_leads_insert_only_no_delete():
    """leads KHÔNG delete-by-source (convlog là log xoay/purge — lead
    là fact suy ra). Chạy lại → rowcount 0 → đếm dup."""
    conn = _FakeConn()
    row, _ = ls.lead_row(_rec())
    res1 = ls.apply_leads(conn, [row])
    assert res1 == {"new": 1, "dup": 0}
    res2 = ls.apply_leads(conn, [row])
    assert res2 == {"new": 0, "dup": 1}
    # Chỉ insert ... on conflict (dedup_key) do nothing — không delete.
    assert all("insert into leads" in sql for _, sql in conn.ops)
    assert all("on conflict (dedup_key) do nothing" in sql
               for _, sql in conn.ops)
    assert all("delete" not in sql.lower() for _, sql in conn.ops)


def test_convlog_stats_counts_and_missing(tmp_path):
    # File thiếu → zeros, không raise.
    s = ls.convlog_stats(tmp_path)
    assert s["total"] == 0 and s["answered"] == 0
    (tmp_path / "conversations.jsonl").write_bytes(
        json.dumps(_rec(msg_id="m1", answered=True)).encode() + b"\n"
        + json.dumps(_rec(msg_id="", answered=False,
                        ts="2026-10-10T03:00:00Z")).encode() + b"\n"
        + b"{bad\n")
    s = ls.convlog_stats(tmp_path)
    assert s["total"] == 2 and s["answered"] == 1
    assert s["by_channel"] == {"zalo": 1, "streamlit": 1}
    assert s["skipped"] == 1


def test_database_helpers_return_none_when_unavailable(monkeypatch,
                                                       tmp_path):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(ls, "ROOT", tmp_path)
    monkeypatch.setattr(ls, "load_dotenv", lambda _path: None)
    assert ls.connect() is None
    assert ls.lead_stats(None) is None

    attempts = []

    def fail_connect(_dsn, **kwargs):
        attempts.append(kwargs)
        raise ls.psycopg.OperationalError("offline")

    monkeypatch.setenv("DATABASE_URL", "postgresql://unavailable")
    monkeypatch.setattr(ls.psycopg, "connect", fail_connect)
    assert ls.connect() is None
    assert attempts == [{"connect_timeout": ls.CONNECT_TIMEOUT_S}]

    class BrokenConn:
        def execute(self, _sql):
            raise ls.psycopg.OperationalError("offline")

    assert ls.lead_stats(BrokenConn()) is None


# ---------- drift guard ----------

def test_schema_sql_has_leads_table():
    sql = (ROOT / "docs" / "schema.sql").read_text(encoding="utf-8")
    lower = sql.lower()
    match = re.search(
        r"create table if not exists leads\s*\((.*?)\);", lower,
        re.DOTALL)
    assert match
    columns = match.group(1)
    for name in ("id", "dedup_key", "ts", "channel", "user_hash",
                 "question", "intent", "status", "source", "created_at"):
        assert re.search(rf"^\s*{name}\s", columns, re.MULTILINE), name
    assert "id bigint generated always as identity primary key" in columns
    assert "dedup_key text not null unique" in columns
    assert "status text not null default 'new'" in columns
    assert len(re.findall(
        r"^create table if not exists", lower, re.MULTILINE)) == 9
    assert not re.search(r"\b(alter|drop)\s+table\b", lower)
