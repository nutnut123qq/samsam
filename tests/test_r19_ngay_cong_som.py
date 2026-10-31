"""r19 (/cycle 20 lượt 2) — ngày/JSON hỏng ở crawl web + cổng TẮT sớm ở 6
CLI sinh đầu ra (someday r18, DONE.md):

  - M1 (r18 someday 6 + 7): `ra_kenh.web_rows` — `published_at` đúng dạng
    `YYYY-MM-DD` nhưng ngày không có thật → `posted_on` None (như Fanpage
    `_fb_date`: không rõ ngày đăng → coi như bài mới), dòng JSON lồng quá
    sâu → "dòng n hỏng — bỏ"; `--scan-auto` không traceback.
  - M2 (r18 someday 2): 6 CLI sinh đầu ra của ĐÚNG 1 tính năng kiểm cổng
    SINH SỚM (r12 RB `rollout.blocked`) — tính năng TẮT → `[rollout]` exit
    2 trước connect/đọc nguồn/in/ghi, cả lượt thật lẫn `--dry-run`.

DB thật: schema tạm + ROLLBACK (`tests.test_ceo_audit.ceo_db`).
"""

import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from agents import kd_care, kd_listing, mkt_koc, mkt_ugc, seo_san
from agents import ra_kenh as rk
from connectors import fanpage as fp
from pipelines import legal_updates, rollout
from pipelines.period import VN_TZ
from tests.test_ceo_audit import ceo_db
from tests.test_mkt_ugc import REVIEWS, SALT
from tests.test_r16_fanpage import BAD, OK
from tests.test_ra_kenh import _n, _TxConn

WEB = "https://samsam.net.vn/vi/news/r19-"


@pytest.fixture
def db():
    yield from ceo_db()


def _web_file(d):
    recs = [{"title": "T", "body": BAD, "url": WEB + "sach.html",
             "published_at": "2026-10-20T08:00:00+07:00"},
            {"title": "T", "body": OK, "url": WEB + "thang13.html",
             "published_at": "2026-13-45"},
            {"title": "T", "body": OK, "url": WEB + "zero.html",
             "published_at": "0000-00-00"},
            {"title": "T", "body": OK, "url": WEB + "30-2.html",
             "published_at": "2026-02-30"}]
    lines = [json.dumps(r, ensure_ascii=False) for r in recs]
    deep = 50_000                     # vượt trần đệ quy bộ giải JSON mọi hệ
    lines.append('{"a":' * deep + "1" + "}" * deep)
    (d / "articles.jsonl").write_bytes("\n".join(lines).encode() + b"\n")


# ------------------------------------------------------------------ M1
def test_m1_web_rows_bad_date_is_none(tmp_path):
    """Trước vá: `date.fromisoformat("2026-13-45")` ValueError lọt."""
    _web_file(tmp_path)
    rows, notes = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    got = {r["url"]: r["posted_on"] for r in rows}
    assert got[WEB + "sach.html"].isoformat() == "2026-10-20"
    for k in ("thang13", "zero", "30-2"):
        assert got[WEB + k + ".html"] is None, k
    # dòng lồng sâu: RecursionError (Windows/Linux CPython 3.12 đều vượt
    # trần ở 50 000) → "dòng 5 hỏng"; bộ giải nào nhận được thì dict không
    # có url → bỏ lặng — cả hai đều hợp lệ, miễn không lọt lỗi.
    assert set(got) == {WEB + k + ".html"
                        for k in ("sach", "thang13", "zero", "30-2")}
    assert not any("cũ" in n for n in notes)


def test_m1_web_rows_recursion_error_any_os(tmp_path, monkeypatch):
    """Ép nhánh RecursionError trên MỌI hệ (Gotcha r18: ngưỡng theo OS)."""
    (tmp_path / "articles.jsonl").write_bytes(b'{"a": 1}\n')

    def loads(_s):
        raise RecursionError("maximum recursion depth exceeded")

    monkeypatch.setattr(rk, "json", SimpleNamespace(loads=loads))
    rows, notes = rk.web_rows(datetime.now(VN_TZ), tmp_path)
    assert rows == [] and "web/articles: dòng 1 hỏng — bỏ" in notes


def test_m1_scan_auto_cli_bad_date_db(db, tmp_path, monkeypatch, capsys):
    """Trước vá: ValueError lọt khỏi `web_rows` (ngoài `try`) → traceback,
    job `channel_scan` chết cả lượt."""
    _web_file(tmp_path)
    real = rk.web_rows
    monkeypatch.setattr(rk, "web_rows", lambda now: real(now, tmp_path))
    monkeypatch.setattr(rk, "connect", lambda: _TxConn(db))
    for k in (fp.ENV_PAGE, fp.ENV_TOKEN, fp.ENV_BASE):
        monkeypatch.delenv(k, raising=False)
    assert rk.main(["--scan-auto"]) == 0
    out = capsys.readouterr().out
    assert "[err]" not in out and "Traceback" not in out
    got = dict(db.execute("select url, posted_on from channel_posts"))
    assert got[WEB + "sach.html"].isoformat() == "2026-10-20"
    assert got[WEB + "thang13.html"] is None
    assert got[WEB + "zero.html"] is None and got[WEB + "30-2.html"] is None
    assert _n(db, "channel_posts", "severity = 'S1'") == 1


# ------------------------------------------------------------------ M2
def _cases(tmp_path):
    out = str(tmp_path / "rep")
    koc = ["--kit", "--koc", "KOC-MAU-01", "--sku", "mat-ong-sam-300ml",
           "--draft-ids", "1", "--by", "Lan"]
    return [
        (kd_care, "sales-07.2", ["--run", "--dry-run"]),
        (kd_care, "sales-07.2", ["--run"]),
        (kd_care, "sales-07.2", ["--plan"]),
        (kd_listing, "sales-03", ["--run", "--dry-run"]),
        (kd_listing, "sales-03", ["--run"]),
        (mkt_koc, "marketing-04.1", koc + ["--dry-run"]),
        (mkt_koc, "marketing-04.1", koc),
        (mkt_ugc, "marketing-05.2", ["--reviews", str(REVIEWS), "--channel",
                                     "shopee", "--by", "Lan", "--dry-run"]),
        (mkt_ugc, "marketing-05.2", ["--reviews", str(REVIEWS), "--channel",
                                     "shopee", "--by", "Lan"]),
        (mkt_ugc, "marketing-05.2", ["--mentions", "--since", "2026-10-01",
                                     "--by", "Lan", "--dry-run"]),
        (mkt_ugc, "marketing-05.2", ["--reuse-request",
                                     "ugc-0000000000000000", "--by", "Lan"]),
        (mkt_ugc, "marketing-05.2", ["--reuse", "ugc-0000000000000000",
                                     "--contact-id", "1", "--by", "Lan"]),
        (seo_san, "marketing-07.1", ["--run", "--dry-run", "--out-dir", out]),
        (seo_san, "marketing-07.1", ["--run", "--out-dir", out]),
        (legal_updates, "legal_hr-07", ["--submit", "--dry-run"]),
        (legal_updates, "legal_hr-07", ["--submit"]),
    ]


_IDS = ["kd_care-dry", "kd_care-run", "kd_care-plan", "kd_listing-dry",
        "kd_listing-run", "mkt_koc-dry", "mkt_koc-run", "mkt_ugc-reviews-dry",
        "mkt_ugc-reviews", "mkt_ugc-mentions-dry", "mkt_ugc-reuse-request",
        "mkt_ugc-reuse", "seo_san-dry", "seo_san-run", "legal_updates-dry",
        "legal_updates-run"]


@pytest.mark.parametrize("i", range(len(_IDS)), ids=_IDS)
def test_m2_off_blocks_before_side_effect(i, tmp_path, monkeypatch, capsys):
    """TẮT → đúng 1 dòng `[rollout] …<mã>` exit 2; không connect, không
    in kế hoạch/thống kê, không ghi báo cáo. Trước vá: dry-run in kế hoạch
    exit 0 / lượt thật connect rồi dừng ở biên ghi (traceback/exit 1)."""
    mod, fid, argv = _cases(tmp_path)[i]
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    monkeypatch.setattr(mod, "connect",
                        lambda *a, **k: pytest.fail("connect trước cổng"))
    assert mod.main(argv) == rollout.EXIT_BLOCKED
    cap = capsys.readouterr()
    lines = cap.out.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("[rollout] "), cap.out
    assert fid in lines[0] and "Traceback" not in cap.err
    assert not (tmp_path / "rep").exists()


@pytest.mark.parametrize("stage", ["chay_thu", "van_hanh"])
@pytest.mark.parametrize("i", range(len(_IDS)), ids=_IDS)
def test_m2_on_passes_gate(i, stage, tmp_path, monkeypatch, capsys):
    """Chạy thử / vận hành: cổng không chặn — tới connect như cũ (connect
    giả trả None → nhánh "không kết nối được"); `--reviews --dry-run`
    không cần DB → in thống kê exit 0 như cũ."""
    mod, _fid, argv = _cases(tmp_path)[i]
    monkeypatch.setattr(rollout, "_FORCE_MODE", stage, raising=False)
    monkeypatch.setenv("INTEL_HASH_SALT", SALT)
    calls = []
    monkeypatch.setattr(mod, "connect",
                        lambda *a, **k: calls.append(1))
    monkeypatch.setattr(kd_care, "job_run", _no_job, raising=False)
    monkeypatch.setattr(kd_listing, "job_run", _no_job, raising=False)
    rc = mod.main(argv)
    out = capsys.readouterr().out
    assert "[rollout]" not in out
    if _IDS[i] == "mkt_ugc-reviews-dry":
        assert rc == 0 and calls == [] and "đề xuất" in out
    else:
        assert calls == [1] and rc != 0


class _no_job:
    def __init__(self, *_a, **_k):
        pass

    def __enter__(self):
        return {}

    def __exit__(self, *_a):
        return False
