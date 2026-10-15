"""v6.0 W60.1–W60.3 — MKT-01 lịch mùa vụ (hàm thuần, không DB).

Mốc ngày giờ cụ thể theo contract DONE.md; đầu vào UTC để bắt lỗi xét
cuối tuần theo UTC. Không đọc đồng hồ, không sleep.
"""

import copy
import json
import re
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import pytest

from ingest import golden_store
from pipelines import mkt_calendar as mc
from pipelines import scenario
from pipelines.period import VN_TZ

ROOT = Path(__file__).resolve().parent.parent
LEAD = {"publish_hour": 9, "approve_buffer_hours": 24,
        "draft_review_hours": 48, "work_start_hour": 8, "work_end_hour": 17}
NONE = frozenset()
REQUIRED_EVENTS = {"20.10", "11.11", "20.11", "12.12", "24.12", "01.01",
                   "tet_2027"}


def _vn(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=VN_TZ)


def _real():
    return json.loads(mc.CALENDAR_FILE.read_text(encoding="utf-8"))


def _golden():
    doc, err = golden_store.read_golden(golden_store.GOLDEN_FILE)
    assert err is None
    return doc


def _plan(weeks=26, start=date(2026, 10, 12), cal=None, golden=None):
    return mc.build(cal or mc.load_calendar(), golden or _golden(), start,
                    weeks, 48)


# ---------- W60.1 loader ----------

def test_load_real_calendar():
    cal = mc.load_calendar()
    assert "GIẢ ĐỊNH" in cal["status"]
    ids = {e["id"] for e in cal["events"]}
    assert REQUIRED_EVENTS <= ids
    harvest = [e for e in cal["events"] if e["kind"] == "harvest"]
    assert harvest and all("GIẢ ĐỊNH" in e["status"] for e in harvest)
    remind = {e["id"] for e in cal["events"] if e["remind"]}
    assert {"11.11", "12.12", "tet_2027"} <= remind
    by_ev = {}
    for c in cal["campaigns"]:
        by_ev.setdefault(c["event"], []).append(c)
    for ev in ("11.11", "12.12", "tet_2027"):
        assert by_ev.get(ev), ev
    h = [c for h_ev in harvest for c in by_ev.get(h_ev["id"], [])]
    assert any(c["formats"] == ["post"] and c["skus"] == [] for c in h)
    tet = next(e for e in cal["events"] if e["id"] == "tet_2027")
    assert tet["lunar_new_year"] == 2027 and "date" not in tet


def test_event_tet_from_scenario():
    tet = next(e for e in _real()["events"] if e["id"] == "tet_2027")
    assert mc.event_date(tet) == scenario.tet_date(2027)
    with pytest.raises(mc.CalendarError):
        mc.event_date({"id": "tet_2031", "kind": "tet",
                       "lunar_new_year": 2031})
    with pytest.raises(mc.CalendarError):
        mc.event_date({"id": "x", "lunar_new_year": True})
    assert mc.event_date({"id": "x", "date": "2026-11-11",
                          "offset_days": -2}) == date(2026, 11, 9)


def test_event_no_second_tet_constant():
    pat = re.compile(r'2027-0?2-0?6|2027, *2, *6|"02-06"')
    for rel in ("pipelines/mkt_calendar.py", "agents/mkt_director.py",
                "data/marketing_calendar.json"):
        src = (ROOT / rel).read_text(encoding="utf-8")
        assert not pat.search(src), rel
    src = (ROOT / "pipelines/mkt_calendar.py").read_text(encoding="utf-8")
    assert "from pipelines import director, scenario" in src
    assert "scenario.tet_date(" in src


def _mut(fn):
    def apply(cal):
        fn(cal)
        return cal
    return apply


def _ev(cal, eid):
    return next(e for e in cal["events"] if e["id"] == eid)


def _set_nan(cal):
    cal["lead"]["approve_buffer_hours"] = float("nan")


BROKEN = {
    "dup_event": _mut(lambda c: c["events"].append(dict(c["events"][0]))),
    "dup_campaign": _mut(lambda c: c["campaigns"].append(
        dict(c["campaigns"][0]))),
    "unknown_event": _mut(lambda c: c["campaigns"][0].update(
        event="khong-co")),
    "unknown_channel": _mut(lambda c: c["campaigns"][0].update(
        channels=["shopee", "lazada"])),
    "unknown_format": _mut(lambda c: c["campaigns"][0].update(
        formats=["post", "banner"])),
    "positive_offset": _mut(lambda c: c["campaigns"][0].update(
        publish_offset_days=1)),
    "offset_too_far": _mut(lambda c: c["campaigns"][0].update(
        publish_offset_days=-61)),
    "true_as_number": _mut(lambda c: c["lead"].update(publish_hour=True)),
    "nan": _mut(_set_nan),
    "negative": _mut(lambda c: c["lead"].update(draft_review_hours=-1)),
    "hour_24": _mut(lambda c: c["lead"].update(publish_hour=24)),
    "work_hours_inverted": _mut(lambda c: c["lead"].update(
        work_start_hour=17, work_end_hour=8)),
    "harvest_no_status": _mut(lambda c: _ev(c, "harvest_2026").pop(
        "status")),
    "harvest_status_not_assumed": _mut(lambda c: _ev(c, "harvest_2026")
                                       .update(status="đã thu")),
    "date_and_lunar": _mut(lambda c: _ev(c, "11.11").update(
        lunar_new_year=2027)),
    "neither_date": _mut(lambda c: _ev(c, "11.11").pop("date")),
    "date_format": _mut(lambda c: _ev(c, "11.11").update(date="2026/11/11")),
    "date_invalid": _mut(lambda c: _ev(c, "11.11").update(date="2026-02-30")),
    "date_far": _mut(lambda c: _ev(c, "11.11").update(date="9999-12-31")),
    "lunar_unknown": _mut(lambda c: _ev(c, "tet_2027").update(
        lunar_new_year=2031)),
    "bad_kind": _mut(lambda c: _ev(c, "11.11").update(kind="party")),
    "remind_not_bool": _mut(lambda c: _ev(c, "11.11").update(remind=1)),
    "reminder_zero": _mut(lambda c: c.update(reminder_days=[14, 0])),
    "skus_bad": _mut(lambda c: c["campaigns"][0].update(skus="all")),
    "no_pillar": _mut(lambda c: c["campaigns"][0].update(pillar=" ")),
    "nwd_bad": _mut(lambda c: c.update(non_working_days=["01/01/2027"])),
    "cap_negative": _mut(lambda c: c["review_caps"].update(
        gd_marketing_daily=-1)),
    "no_status": _mut(lambda c: c.pop("status")),
    "events_empty": _mut(lambda c: c.update(events=[])),
    "campaigns_empty": _mut(lambda c: c.update(campaigns=[])),
    "bad_id": _mut(lambda c: c["campaigns"][0].update(id="C 1|x")),
}


@pytest.mark.parametrize("name", sorted(BROKEN))
def test_load_broken_rules(tmp_path, name):
    cal = BROKEN[name](_real())
    p = tmp_path / "cal.json"
    # allow_nan mặc định → ghi NaN thật vào file (JSON không chuẩn).
    p.write_bytes(json.dumps(cal, ensure_ascii=False).encode("utf-8"))
    with pytest.raises(mc.CalendarError):
        mc.load_calendar(p)


@pytest.mark.parametrize("content", [None, b"", b"   \n", b"{bad",
                                     b"{}", b'{"_doc": "chi doc"}', b"[]",
                                     b"\xff\xfe"])
def test_load_missing_or_empty(tmp_path, content):
    p = tmp_path / "cal.json"
    if content is not None:
        p.write_bytes(content)
    with pytest.raises(mc.CalendarError):
        mc.load_calendar(p)


# ---------- W60.2 engine ----------

def _ms(publish_day, lead=LEAD, nw=NONE, sla=48):
    return mc.milestones(publish_day, lead, sla, nw)


def test_milestones_1111_weekend_draft():
    m = _ms(date(2026, 11, 11))
    assert m["publish"] == _vn(2026, 11, 11, 9)
    assert m["approve"] == _vn(2026, 11, 10, 9)
    assert m["draft"] == _vn(2026, 11, 6, 17)       # CN 08/11 → T6
    assert m["brief"] == _vn(2026, 11, 4, 17)


def test_milestones_1212_saturday_publish():
    m = _ms(date(2026, 12, 12))
    assert m["publish"] == _vn(2026, 12, 12, 9)     # giữ T7 (sale sàn)
    assert m["approve"] == _vn(2026, 12, 11, 9)
    assert m["draft"] == _vn(2026, 12, 9, 9)
    assert m["brief"] == _vn(2026, 12, 7, 9)


def test_milestones_monday_and_early_hour():
    assert _ms(date(2026, 11, 16))["approve"] == _vn(2026, 11, 13, 17)
    lead7 = dict(LEAD, publish_hour=7)
    m = _ms(date(2026, 11, 11), lead=lead7)
    assert m["approve"] == _vn(2026, 11, 9, 17)    # 07:00 < giờ làm


def test_to_workday_utc_input_and_holiday():
    utc = datetime(2026, 11, 13, 23, 30, tzinfo=timezone.utc)  # T7 06:30 VN
    got = mc.to_workday(utc, LEAD, NONE)
    assert got == _vn(2026, 11, 13, 17)
    assert got.utcoffset() == timedelta(hours=7)
    # UTC T5 03:00 = VN T5 10:00 (giờ làm) — xét theo UTC sẽ lùi về 11/11.
    got = mc.to_workday(datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc),
                        LEAD, NONE)
    assert got == _vn(2026, 11, 12, 10)
    assert got.utcoffset() == timedelta(hours=7)
    # UTC-10 CN 15/11 16:30 = VN T2 16/11 09:30 — xét theo ngày đầu vào
    # (CN) sẽ lùi về T6 13/11.
    hst = timezone(timedelta(hours=-10))
    got = mc.to_workday(datetime(2026, 11, 15, 16, 30, tzinfo=hst), LEAD, NONE)
    assert got == _vn(2026, 11, 16, 9, 30)
    assert got.utcoffset() == timedelta(hours=7)
    nw = frozenset({date(2027, 1, 1)})
    assert mc.to_workday(_vn(2027, 1, 1, 10), LEAD, nw) == \
        _vn(2026, 12, 31, 17)
    assert _ms(date(2027, 1, 2), nw=nw)["approve"] == _vn(2026, 12, 31, 17)
    assert mc.to_workday(_vn(2026, 11, 12, 18, 30), LEAD, NONE) == \
        _vn(2026, 11, 12, 17)
    assert mc.to_workday(_vn(2026, 11, 12, 8), LEAD, NONE) == \
        _vn(2026, 11, 12, 8)
    with pytest.raises(ValueError):
        mc.to_workday(datetime(2026, 11, 12, 10), LEAD, NONE)  # noqa: DTZ001


def test_to_workday_only_moves_earlier():
    t = _vn(2026, 12, 28)
    nw = frozenset({date(2027, 1, 1)})
    for h in range(0, 24 * 10, 1):
        x = t + timedelta(hours=h, minutes=17)
        y = mc.to_workday(x, LEAD, nw)
        assert y <= x
        assert y.weekday() < 5 and y.date() not in nw
        assert time(8) <= y.timetz().replace(tzinfo=None) <= time(17)


def test_engine_property_real_repo():
    cal = mc.load_calendar()
    plan = _plan(cal=cal)
    nw = set(plan["non_working_days"])
    assert scenario.tet_date(2027) in nw            # off_days Tết
    assert plan["campaigns"]
    for c in plan["campaigns"]:
        m = c["milestones"]
        assert m["brief"] <= m["draft"] <= m["approve"] <= m["publish"]
        for k in mc.MILESTONES:
            assert m[k].utcoffset() == timedelta(hours=7), (c["id"], k)
        for k in ("brief", "draft", "approve"):
            v = m[k]
            assert v.weekday() < 5 and v.date() not in nw, (c["id"], k)
            assert time(8) <= v.time() <= time(17), (c["id"], k)


def test_alcohol_never_in_cells_real_repo():
    plan = _plan()
    for c in plan["campaigns"]:
        for cell in c["cells"]:
            assert not any(k.startswith("ruou-sam-") for k in cell["skus"])
    listed = next(c for c in plan["campaigns"]
                  if c["id"] == "c-tet-2027-qua-bieu")
    bl = [b for b in listed["blocked"]
          if b["sku_key"] == "ruou-sam-binh-su-do-500ml"]
    assert bl and all(b["reason"] == mc.REASON_ALCOHOL for b in bl)
    auto = next(c for c in plan["campaigns"] if c["id"] == "c-1111-2026")
    assert {b["sku_key"] for b in auto["blocked"]
            if b["reason"] == mc.REASON_ALCOHOL} == {
        "ruou-sam-chai-thuy-tinh-500ml", "ruou-sam-binh-su-do-500ml"}
    # golden thật còn ghi allowed_channels ["shopee"] cho rượu (lệch v3.2)
    g = {s["sku_key"]: s for s in _golden()["skus"]}
    assert "shopee" in g["ruou-sam-binh-su-do-500ml"]["allowed_channels"]


def _fixture_cal(channels, formats, skus="auto"):
    cal = _real()
    cal["campaigns"] = [{"id": "c-fx", "event": "11.11",
                         "publish_offset_days": 0, "channels": channels,
                         "formats": formats, "skus": skus,
                         "pillar": "fixture"}]
    return mc.validate(cal)


def test_readiness_per_format_fixture_golden():
    golden = copy.deepcopy(_golden())
    by = {s["sku_key"]: s for s in golden["skus"]}
    by["saphraton-20v"]["xnqc_status"] = "approved"
    cal = _fixture_cal(["shopee"], ["listing", "ads", "koc", "livestream"])
    c = _plan(cal=cal, golden=golden)["campaigns"][0]
    cells = {(x["channel"], x["format"]): x for x in c["cells"]}
    assert "saphraton-20v" in cells[("shopee", "ads")]["skus"]
    assert "savigout-30v" in cells[("shopee", "listing")]["skus"]
    for fmt in ("ads", "koc", "livestream"):
        cell = cells.get(("shopee", fmt))
        assert cell is None or "savigout-30v" not in cell["skus"]
        assert any(b["sku_key"] == "savigout-30v" and b["format"] == fmt
                   and b["readiness"] == "MO_TA" for b in c["blocked"])
    for cell in c["cells"]:
        assert "saphraton-40v" not in cell["skus"]
    assert all(b["readiness"] == "CAM" for b in c["blocked"]
               if b["sku_key"] == "saphraton-40v")
    # rượu được liệt kê đích danh + allowed shopee → vẫn bị chặn
    cal2 = _fixture_cal(["shopee"], ["listing"],
                        ["ruou-sam-chai-thuy-tinh-500ml", "savigout-30v"])
    c2 = _plan(cal=cal2, golden=golden)["campaigns"][0]
    assert c2["cells"][0]["skus"] == ["savigout-30v"]
    assert c2["blocked"][0]["reason"] == mc.REASON_ALCOHOL


def test_cells_dropped_or_brand_story():
    cal = _fixture_cal(["tiktok"], ["listing", "ads", "post", "livestream"])
    c = _plan(cal=cal)["campaigns"][0]
    fmts = {x["format"] for x in c["cells"]}
    assert fmts == {"post", "livestream"}
    assert all(x["note"] == mc.BRAND_NOTE and x["skus"] == []
               for x in c["cells"])
    assert {d["format"] for d in c["dropped"]} == {"listing", "ads"}
    cal_bad = _fixture_cal(["shopee"], ["post"], ["khong-co-sku"])
    with pytest.raises(mc.CalendarError):
        _plan(cal=cal_bad)


def test_reminders_14_7_3():
    plan = _plan()
    rem = {}
    for r in plan["reminders"]:
        rem.setdefault(r["event"], {})[r["days_before"]] = r["day"]
    for ev in ("11.11", "12.12", "tet_2027"):
        assert set(rem[ev]) == {14, 7, 3}, ev
    assert rem["tet_2027"] == {14: date(2027, 1, 23), 7: date(2027, 1, 30),
                               3: date(2027, 2, 3)}
    assert rem["11.11"][14] == date(2026, 10, 28)
    assert "20.10" not in rem


def test_window_filter():
    # ngày đăng ≥ start VÀ brief < end: c-2011 (đăng 18/11) có brief
    # 11/11 trong tuần → có; c-2010 đã đăng → không; harvest brief 18/11
    # ngoài tuần 09–15/11 → không, trong kỳ 12–18/11 → có; c-1111 đăng
    # 11/11 < start 12/11 → không.
    plan = _plan(weeks=1, start=date(2026, 11, 9))
    assert [c["id"] for c in plan["campaigns"]] == ["c-1111-2026",
                                                     "c-2011-2026"]
    plan = _plan(weeks=1, start=date(2026, 11, 12))
    assert [c["id"] for c in plan["campaigns"]] == ["c-2011-2026",
                                                     "c-harvest-2026"]


def test_engine_no_db_imports_no_clock_in_tests():
    src = (ROOT / "pipelines/mkt_calendar.py").read_text(encoding="utf-8")
    assert not re.search(r"^(import|from) (psycopg|openai|httpx|requests)",
                         src, re.MULTILINE)
    me = Path(__file__).read_text(encoding="utf-8")
    for bad in ("time." + "sleep", "datetime." + "now", "date." + "today"):
        assert bad not in me


# ---------- W60.3 xuất ----------

def test_cli_markdown_week(capsys):
    assert mc.main(["--start", "2026-10-12", "--weeks", "4"]) == 0
    out = capsys.readouterr().out
    first = out.splitlines()[0]
    assert "GIẢ ĐỊNH" in first and "ĐỀ XUẤT" in first
    wk = out.split("## Tuần 2026-11-09")[1].split("\n## ")[0]
    assert "c-1111-2026" in wk and "| shopee | listing |" in wk
    assert "## SKU bị chặn kênh" in out


def test_cli_markdown_month_and_json(capsys):
    assert mc.main(["--start", "2026-10-12", "--weeks", "26", "--by",
                    "month"]) == 0
    out = capsys.readouterr().out
    assert "## Tháng 2027-02" in out and "## Tháng 2026-11" in out
    assert mc.main(["--start", "2026-10-12", "--weeks", "18",
                    "--json"]) == 0
    plan = json.loads(capsys.readouterr().out)
    assert plan["campaigns"]
    for c in plan["campaigns"]:
        for k in mc.MILESTONES:
            assert c["milestones"][k].endswith("+07:00")


def _parse_ics(text: str) -> list[dict]:
    assert text.endswith("\r\n")
    raw = text.split("\r\n")[:-1]
    for line in raw:
        assert "\n" not in line and "\r" not in line
        assert len(line.encode("utf-8")) <= 75, line
    lines = []
    for line in raw:                      # unfold CRLF + space
        if line.startswith(" "):
            lines[-1] += line[1:]
        else:
            lines.append(line)
    assert lines[0] == "BEGIN:VCALENDAR" and lines[-1] == "END:VCALENDAR"
    assert "VERSION:2.0" in lines and any(x.startswith("PRODID:")
                                          for x in lines)
    events, cur = [], None
    for line in lines:
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            events.append(cur)
            cur = None
        elif cur is not None:
            k, _, v = line.partition(":")
            cur[k.split(";")[0]] = v
    return events


def _unescape(v: str) -> str:
    return re.sub(r"\\([\\;,nN])",
                  lambda m: "\n" if m.group(1) in "nN" else m.group(1), v)


NOW = datetime(2026, 10, 12, 8, 0, tzinfo=VN_TZ)


def test_ics_valid_and_stable():
    plan = _plan(weeks=18)
    text = mc.render_ics(plan, NOW)
    evs = _parse_ics(text)
    assert len(evs) == 4 * len(plan["campaigns"]) + len(plan["reminders"])
    for e in evs:
        assert {"UID", "DTSTAMP", "DTSTART", "SUMMARY"} <= set(e)
        assert e["DTSTAMP"] == "20261012T010000Z"
    uids = [e["UID"] for e in evs]
    assert len(set(uids)) == len(uids)
    pub = next(e for e in evs if e["UID"] == "c-1111-2026-publish@samsam")
    assert pub["DTSTART"] == "20261111T020000Z"
    assert mc.render_ics(plan, NOW).encode() == text.encode()
    assert mc.render_ics(_plan(weeks=18), NOW) == text   # chạy lại cùng UID


def test_ics_escape_and_fold_roundtrip():
    plan = _plan(weeks=6)
    c = plan["campaigns"][0]
    c["event"] = "sale, mùa; 1\\2\nx"
    c["pillar"] = "Quà tặng sâm Ngọc Linh " * 8
    evs = _parse_ics(mc.render_ics(plan, NOW))
    brief = next(e for e in evs if e["UID"] == f"{c['id']}-brief@samsam")
    assert _unescape(brief["SUMMARY"]) == f"[MKT] brief: {c['id']} " \
        "(sale, mùa; 1\\2\nx)"
    assert _unescape(brief["DESCRIPTION"]).startswith(c["pillar"] + "; ")
    # Raw value phải escape thật (RFC 5545 §3.3.11): _unescape để nguyên
    # `,` `;` `\` trần nên round-trip ở trên không bắt được thiếu escape.
    assert "(sale\\, mùa\\; 1\\\\2\\nx)" in brief["SUMMARY"]
    for k in ("SUMMARY", "DESCRIPTION"):
        bare = re.sub(r"\\[\\;,nN]", "", brief[k])
        assert not re.search(r"[\\;,]", bare), (k, brief[k])


def test_cli_ics_file(tmp_path, capsys):
    p = tmp_path / "out" / "lich.ics"
    assert mc.main(["--start", "2026-10-12", "--weeks", "18", "--ics",
                    str(p)]) == 0
    data = p.read_bytes()
    assert data.startswith(b"BEGIN:VCALENDAR\r\n")
    assert _parse_ics(data.decode("utf-8"))


@pytest.mark.parametrize("argv", [["--start", "2026-13-01"],
                                  ["--start", "12/10/2026"],
                                  ["--weeks", "0"], ["--weeks", "27"],
                                  ["--weeks", "x"], ["--by", "year"]])
def test_cli_usage_exit_2(argv):
    with pytest.raises(SystemExit) as e:
        mc.main(argv)
    assert e.value.code == 2


def test_cli_broken_calendar_exit_1(tmp_path, monkeypatch, capsys):
    p = tmp_path / "cal.json"
    p.write_bytes(b'{"_doc": "x"}')
    monkeypatch.setattr(mc, "CALENDAR_FILE", p)
    assert mc.main(["--start", "2026-10-12"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("[err]") and "Traceback" not in err
