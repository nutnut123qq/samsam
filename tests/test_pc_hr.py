"""v12.2 PC-HR (`agents.pc_hr`): nháp mô tả công việc, xếp hạng hồ sơ (mã
sha256, không PII, không tự loại), tổng hợp chấm công theo mã NV.

Thuần: chuẩn hóa từ khóa, kiểm cấu hình (kể cả tiêu chí phân biệt đối xử),
đọc thư mục CV (rỗng/không UTF-8/quá lớn/trùng/khác loại/quá số file), kiểm
toàn file chấm công (mọi lỗi → 0 dòng), luật trễ/sớm/thiếu/vắng. CLI: chọn
thao tác, exit code, fail-closed TRƯỚC connect. DB thật: schema tạm +
rollback (`fpa_conn` của tests/test_fp_pnl.py).
"""

import json
from datetime import date
from pathlib import Path

import pytest

from agents import pc_hr as h
from tests.test_fp_pnl import _TxConn, fpa_conn

ROOT = Path(__file__).resolve().parent.parent
HDR = "ma_nv,ngay,gio_vao,gio_ra\n"
OCT = date(2026, 10, 1)
TODAY = date(2026, 11, 5)          # tháng 10/2026 đã đóng


@pytest.fixture
def db():
    yield from fpa_conn()


@pytest.fixture(autouse=True)
def _fixed_today(monkeypatch):
    monkeypatch.setattr(h, "_today", lambda: TODAY)


def _no_connect(monkeypatch):
    def boom():
        raise AssertionError("không được connect DB")
    monkeypatch.setattr(h, "connect", boom)


def _csv(tmp_path, body: str, name="cc.csv") -> Path:
    p = tmp_path / name
    p.write_bytes((HDR + body).encode("utf-8"))
    return p


def _jd_file(tmp_path, mutate) -> Path:
    raw = json.loads((ROOT / "data" / "hr" / "jd_templates.json").read_bytes()
                     .decode("utf-8"))
    mutate(raw["positions"]["nv_van_hanh_san"])
    p = tmp_path / "jd.json"
    p.write_bytes(json.dumps(raw, ensure_ascii=False).encode("utf-8"))
    return p


# ---------------------------------------------------------------- tiện ích
def test_norm_and_word_match():
    assert h.norm("Thương mại ĐIỆN TỬ, e-Commerce!") == (
        "thuong mai dien tu e commerce")
    assert h.norm("TMĐT") == "tmdt"
    t = h.norm("Từng làm Samsung; 3 năm ở Shopee-Mall")
    assert h.has_kw(t, "shopee")
    assert not h.has_kw(t, "sam")          # 'samsung' không chứa từ 'sam'
    assert h.has_kw(h.norm("Sâm Ngọc Linh"), h.norm("sâm ngọc linh"))


# ---------------------------------------------------------------- cấu hình JD
def test_repo_positions_valid_and_jd_pass_guardrail():
    from pipelines.guardrail import check
    raw = json.loads((ROOT / "data" / "hr" / "jd_templates.json").read_bytes()
                     .decode("utf-8"))
    assert "BẢN DEV SOẠN" in raw["_doc"]
    for key in raw["positions"]:
        pos = h.load_position(key)
        g = check(h.render_jd(pos))
        assert g["ok"], (key, g["violations"])


@pytest.mark.parametrize("mutate,needle", [
    (lambda p: p.update(bat_buoc=[]), "bat_buoc"),
    (lambda p: p["bat_buoc"][0].update(tu_khoa=["!!!"]), "không chứa chữ"),
    (lambda p: p["bat_buoc"][0].update(tu_khoa=[]), "tu_khoa"),
    (lambda p: p["uu_tien"][0].update(diem=0), "diem"),
    (lambda p: p["uu_tien"][0].update(diem=6), "diem"),
    (lambda p: p["uu_tien"][0].update(diem=True), "diem"),
    (lambda p: p["uu_tien"][0].update(id=p["bat_buoc"][0]["id"]), "trùng"),
    (lambda p: p["bat_buoc"][0].update(tu_khoa=["Nữ"]), "phân biệt"),
    (lambda p: p["bat_buoc"][0].update(tu_khoa=["dưới 30 tuổi"]),
     "phân biệt"),
    (lambda p: p["uu_tien"][0].update(tu_khoa=["đã kết hôn"]), "phân biệt"),
    (lambda p: p["bat_buoc"][0].update(mo_ta="Ưu tiên nam giới"),
     "phân biệt"),
    (lambda p: p.update(phong_ban="mechanical"), "phong_ban"),
    (lambda p: p.update(nhiem_vu=[]), "nhiem_vu"),
    (lambda p: p.update(ten=" "), "ten"),
], ids=["bat-buoc-rong", "kw-khong-chu", "kw-rong", "diem-0", "diem-6",
        "diem-bool", "id-trung", "bias-nu", "bias-tuoi", "bias-ket-hon",
        "bias-mo-ta", "phong-ban-la", "nhiem-vu-rong", "ten-trong"])
def test_load_position_rejects(tmp_path, mutate, needle):
    with pytest.raises(h.HrConfigError) as e:
        h.load_position("nv_cskh", _jd_file(tmp_path, mutate))
    assert needle in str(e.value)


def test_load_position_bias_word_inside_place_name_ok(tmp_path):
    p = _jd_file(tmp_path, lambda p: p["uu_tien"][0].update(
        tu_khoa=["Quảng Nam", "nam định"]))
    assert h.load_position("nv_van_hanh_san", p)["pref"][0]["kw"] == [
        "quang nam", "nam dinh"]


def test_load_position_missing_and_broken(tmp_path):
    with pytest.raises(h.HrConfigError, match="không có vị trí"):
        h.load_position("ke_toan")
    bad = tmp_path / "x.json"
    bad.write_bytes(b"{")
    with pytest.raises(h.HrConfigError, match="không đọc được"):
        h.load_position("nv_cskh", bad)
    bad.write_bytes(b'{"positions": {}}')
    with pytest.raises(h.HrConfigError, match="positions"):
        h.load_position("nv_cskh", bad)


# ---------------------------------------------------------------- hồ sơ
CV_A = ("Nguyễn Văn An — 0901 234 567 — an.nguyen@mail.test\n"
        "3 năm vận hành gian hàng Shopee, chạy Shopee Ads, dùng Excel.\n")
CV_B = "Trần Thị Bình, 0912345678. Kinh nghiệm TikTok Shop, livestream.\n"
CV_C = "Lê C. Thành thạo Google Sheets, quản lý gian hàng Lazada.\n"


def _inbox(tmp_path) -> Path:
    d = tmp_path / "inbox"
    d.mkdir()
    (d / "NguyenVanAn_0901234567.txt").write_bytes(CV_A.encode("utf-8"))
    (d / "an_copy.md").write_bytes(CV_A.encode("utf-8"))      # trùng nội dung
    (d / "binh.txt").write_bytes(CV_B.encode("utf-8"))
    (d / "c.md").write_bytes(("﻿" + CV_C).encode("utf-8"))
    (d / "rong.txt").write_bytes(b"")
    (d / "bom_only.txt").write_bytes(b"\xef\xbb\xbf  \n")
    (d / "cp1258.txt").write_bytes(b"Tr\xe0n \xff")
    (d / "cv.pdf").write_bytes(b"%PDF-1.4")
    (d / "sub").mkdir()
    return d


def test_read_cvs_and_rank(tmp_path):
    cands, skipped, err = h.read_cvs(_inbox(tmp_path))
    assert err is None and skipped == 2               # .pdf + thư mục con
    assert len(cands) == 6                            # 7 file, 1 cặp trùng
    a = h.sha12(CV_A.encode("utf-8"))
    dup = next(c for c in cands if c["ma"] == a)
    assert sorted(dup["files"]) == ["NguyenVanAn_0901234567.txt",
                                    "an_copy.md"]
    why = sorted(c["why"] for c in cands if c["text"] is None)
    assert why == ["file rỗng", "file rỗng", "không phải UTF-8"]

    pos = h.load_position("nv_van_hanh_san")
    ranked = h.rank(pos, cands)
    assert len(ranked) == len(cands)                  # không tự loại ai
    top = ranked[0]
    assert top["ma"] == a and top["must_ok"] == ["kinh_nghiem_san",
                                                 "bang_tinh"]
    assert top["diem"] == 2 and top["pref_ok"] == ["quang_cao_san"]
    c = h.sha12(("﻿" + CV_C).encode("utf-8"))
    b = h.sha12(CV_B.encode("utf-8"))
    # C: 2/2 bắt buộc, 0 điểm; B: 1/2 bắt buộc, 1 điểm (bắt buộc xếp trước)
    assert [x["ma"] for x in ranked[1:3]] == [c, b]
    assert ranked[2]["must_miss"] == ["bang_tinh"]
    assert all(x["text"] is None for x in ranked[3:])


def test_rank_tie_break_by_code():
    pos = h.load_position("nv_cskh")
    cands = [{"ma": m, "files": [], "text": "chăm sóc khách hàng", "why": None}
             for m in ("bbb", "aaa")]
    assert [c["ma"] for c in h.rank(pos, cands)] == ["aaa", "bbb"]


def test_read_cvs_limits(tmp_path, monkeypatch):
    d = _inbox(tmp_path)
    assert h.read_cvs(tmp_path / "khong_co")[2] == ("thư mục hồ sơ không "
                                                     "tồn tại")
    monkeypatch.setattr(h, "MAX_CV_FILES", 3)
    cands, _, err = h.read_cvs(d)
    assert cands == [] and "quá 3 hồ sơ" in err
    monkeypatch.setattr(h, "MAX_CV_FILES", 500)
    monkeypatch.setattr(h, "MAX_CV_BYTES", 40)
    cands, _, err = h.read_cvs(d)
    big = [c for c in cands if c["why"] and c["why"].startswith("file >")]
    # CV_A (2 bản) + CV_B + CV_C > 40 byte: mã vẫn = sha nội dung (băm luồng)
    assert {c["ma"] for c in big} == {h.sha12(CV_A.encode("utf-8")),
                                      h.sha12(CV_B.encode("utf-8")),
                                      h.sha12(("﻿" + CV_C)
                                              .encode("utf-8"))}
    assert all(c["text"] is None for c in big)


def test_screening_payload_has_no_pii(tmp_path):
    from pipelines.guardrail import check
    pos = h.load_position("nv_van_hanh_san")
    cands, skipped, _ = h.read_cvs(_inbox(tmp_path))
    text = h.render_screening(pos, h.rank(pos, cands), skipped)
    for leak in ("Nguyễn", "Bình", "0901", "234 567", "0912345678",
                 "@mail.test", "NguyenVanAn", "binh.txt", "cp1258"):
        assert leak not in text, leak
    assert "không phải UTF-8" in text and "KHÔNG loại ai" in text
    assert "| 1 | `" in text and "2/2" in text and "THIẾU:" in text
    assert check(text)["ok"]


# ---------------------------------------------------------------- CLI screen
def test_cli_screen_dry_run_masks_map(tmp_path, monkeypatch, capsys):
    _no_connect(monkeypatch)
    d = _inbox(tmp_path)
    monkeypatch.setenv("HR_INBOX_DIR", str(d))
    assert h.main(["--screen", "--jd", "nv_van_hanh_san", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "[map]" in out and "0901234567" not in out
    assert "[dry-run] hr_screening `screen:nv_van_hanh_san:" in out


@pytest.mark.parametrize("argv", [
    [], ["--screen"], ["--screen", "--jd", "x", "--dir", "."],
    ["--jd", "nv_cskh", "--month", "2026-10"],
    ["--jd", "nv_cskh", "--dir", "/tmp"],
    ["--attendance", "a.csv", "--jd", "nv_cskh", "--month", "2026-10"],
    ["--attendance", "a.csv", "--screen", "--month", "2026-10"],
    ["--attendance", "a.csv"], ["--attendance", "a.csv", "--month", "10/2026"],
    ["--attendance", "a.csv", "--month", "2026-12"],
], ids=["rong", "screen-thieu-jd", "dir-trong-repo", "month-voi-jd",
        "dir-voi-jd", "att-voi-jd", "att-voi-screen", "att-thieu-month",
        "month-sai", "month-tuong-lai"])
def test_cli_usage_errors(monkeypatch, argv):
    _no_connect(monkeypatch)
    monkeypatch.delenv("HR_INBOX_DIR", raising=False)
    with pytest.raises(SystemExit) as e:
        h.main(argv)
    assert e.value.code == 2


def test_cli_screen_needs_dir_outside_repo(tmp_path, monkeypatch):
    _no_connect(monkeypatch)
    monkeypatch.delenv("HR_INBOX_DIR", raising=False)
    with pytest.raises(SystemExit) as e:
        h.main(["--screen", "--jd", "nv_cskh"])
    assert e.value.code == 2
    monkeypatch.setenv("HR_INBOX_DIR", str(ROOT / "data"))
    with pytest.raises(SystemExit) as e:
        h.main(["--screen", "--jd", "nv_cskh"])
    assert e.value.code == 2
    assert h.inside_repo(ROOT) and not h.inside_repo(tmp_path)


def test_cli_screen_empty_or_missing_dir_exit1(tmp_path, monkeypatch, capsys):
    _no_connect(monkeypatch)
    (tmp_path / "e").mkdir()
    (tmp_path / "e" / "x.pdf").write_bytes(b"x")
    assert h.main(["--screen", "--jd", "nv_cskh", "--dir",
                   str(tmp_path / "e")]) == 1
    assert "không có hồ sơ" in capsys.readouterr().out
    assert h.main(["--screen", "--jd", "nv_cskh", "--dir",
                   str(tmp_path / "khong")]) == 1


def test_cli_config_error_and_guardrail_fail_closed(tmp_path, monkeypatch,
                                                    capsys):
    _no_connect(monkeypatch)
    assert h.main(["--jd", "ke_toan", "--dry-run"]) == 1
    assert "không có vị trí" in capsys.readouterr().out
    monkeypatch.setattr(h, "guardrail_check", lambda t: {
        "ok": False, "violations": [{"type": "banned_word"}]})
    assert h.main(["--jd", "nv_cskh"]) == 1
    assert "banned_word" in capsys.readouterr().out


def test_cli_db_down_exit2(monkeypatch):
    monkeypatch.setattr(h, "connect", lambda: None)
    assert h.main(["--jd", "nv_cskh"]) == 2


# ---------------------------------------------------------------- chấm công
GOOD = ("NV001,2026-10-01,07:55,17:00\n"     # T5 đúng giờ
        "NV001,2026-10-02,08:05,17:00\n"     # trễ 5' = trong du di
        "NV001,2026-10-05,08:20,16:50\n"     # trễ 20', về sớm 10'
        "NV001,2026-10-06,08:00,\n"          # thiếu giờ ra
        "NV001,2026-10-10,08:30:00,11:00\n"  # thứ Bảy: ngoài lịch, không trễ
        "nv-02,06/10/2026,08:00,17:00\n")


def test_read_attendance_and_summarize(tmp_path):
    rules = h.load_rules()
    rows, errs, sha = h.read_attendance(_csv(tmp_path, GOOD), OCT, TODAY)
    assert errs == [] and len(rows) == 6 and len(sha) == 64
    s = h.summarize(rows, OCT, rules, date(2026, 10, 31))
    a, b = s["NV001"], s["nv-02"]
    assert (a["ngay_cong"], a["thieu_cham"], a["ngoai_lich"]) == (4, 1, 1)
    assert (a["di_tre"], a["phut_tre"]) == (1, 20)
    assert (a["ve_som"], a["phut_som"]) == (1, 10)
    # 22 ngày làm T2–T6 tháng 10/2026, NV001 chấm 4 ngày làm → vắng 18
    assert a["vang"] == 18 and b["vang"] == 21 and b["ngay_cong"] == 1


def test_summarize_open_period_and_holidays(tmp_path):
    rows, _, _ = h.read_attendance(_csv(tmp_path, GOOD), OCT, TODAY)
    rules = h.load_rules()
    s = h.summarize(rows, OCT, rules, date(2026, 10, 6))
    assert s["NV001"]["vang"] == 0 and s["nv-02"]["vang"] == 3
    rules["shift"] = {**rules["shift"],
                      "holidays": frozenset({date(2026, 10, 1)})}
    s = h.summarize(rows, OCT, rules, date(2026, 10, 6))
    assert s["nv-02"]["vang"] == 2
    assert s["NV001"]["ngoai_lich"] == 2        # 01/10 lễ + thứ Bảy


@pytest.mark.parametrize("body,needle", [
    ("NV1,2026-10-01,17:00,08:00\n", "phải sau gio_vao"),
    ("NV1,2026-10-01,08:00,08:00\n", "phải sau gio_vao"),
    ("NV1,2026-10-01,,\n", "trống cả hai"),
    ("NV1,2026-10-01,25:00,17:00\n", "'gio_vao' phải HH:MM"),
    ("NV1,2026-10-01,08:00,5pm\n", "'gio_ra' phải HH:MM"),
    ("NV1,2026-13-01,08:00,17:00\n", "'ngay' phải"),
    ("NV1,2026-09-30,08:00,17:00\n", "ngoài tháng"),
    ("NV1,,08:00,17:00\n", "'ngay' trống"),
    (",2026-10-01,08:00,17:00\n", "'ma_nv' trống"),
    ("0901234567,2026-10-01,08:00,17:00\n", "'ma_nv' phải là mã NV"),
    ("Nguyen Van A,2026-10-01,08:00,17:00\n", "'ma_nv' phải là mã NV"),
    ("a@b.vn,2026-10-01,08:00,17:00\n", "'ma_nv' phải là mã NV"),
    ("NV1,2026-10-01,08:00,17:00\nNV1,01/10/2026,08:10,17:00\n",
     "dòng 4: trùng (ma_nv, ngay) với dòng 3"),
    ("NV1,2026-10-01,08:00,17:00,x\n", "thừa ô"),
], ids=["ra-truoc-vao", "ra-bang-vao", "trong-ca-hai", "gio-vao-sai",
        "gio-ra-sai", "ngay-sai", "ngoai-thang", "ngay-trong", "ma-trong",
        "ma-sdt", "ma-ten", "ma-email", "trung-dong", "thua-o"])
def test_read_attendance_rejects_whole_file(tmp_path, body, needle):
    good = "NV9,2026-10-02,08:00,17:00\n"
    rows, errs, _ = h.read_attendance(_csv(tmp_path, good + body), OCT, TODAY)
    assert rows == [] and any(needle in e for e in errs), errs
    # lỗi không in giá trị ô (có thể là tên/SĐT)
    assert not any("0901234567" in e or "Nguyen" in e for e in errs)


def test_read_attendance_future_and_structure(tmp_path):
    rows, errs, _ = h.read_attendance(
        _csv(tmp_path, "NV1,2026-11-06,08:00,17:00\n"), date(2026, 11, 1),
        TODAY)
    assert rows == [] and "ở tương lai" in errs[0]
    p = tmp_path / "rong.csv"
    p.write_bytes(b"")
    assert h.read_attendance(p, OCT, TODAY)[1] == ["file rỗng"]
    p.write_bytes(HDR.encode("utf-8"))
    assert "chỉ có header" in h.read_attendance(p, OCT, TODAY)[1][0]
    p.write_bytes(b"ma_nv,ngay,vao,ra\nNV1,2026-10-01,08:00,17:00\n")
    errs = h.read_attendance(p, OCT, TODAY)[1]
    assert any("cột lạ" in e for e in errs)
    assert any("thiếu cột bắt buộc" in e for e in errs)
    p.write_bytes(b"NV1,2026-10-01,08:00,17:00\n")       # thiếu dòng header
    assert "không khớp header" in h.read_attendance(p, OCT, TODAY)[1][0]
    p = tmp_path / "x.txt"
    p.write_bytes(b"x")
    assert "không hỗ trợ" in h.read_attendance(p, OCT, TODAY)[1][0]


@pytest.mark.parametrize("mutate,needle", [
    (lambda r: r.update(grace_late_min=-1), "grace_late_min"),
    (lambda r: r.update(grace_early_min=True), "grace_early_min"),
    (lambda r: r.update(grace_late_min=121), "grace_late_min"),
    (lambda r: r["shift"].update(end="07:00"), "shift"),
    (lambda r: r["shift"].update(workdays=[]), "shift"),
], ids=["tre-am", "som-bool", "tre-qua-tran", "ca-nguoc", "khong-ngay-lam"])
def test_load_rules_rejects(tmp_path, mutate, needle):
    raw = json.loads((ROOT / "data" / "hr" / "attendance_rules.json")
                     .read_bytes().decode("utf-8"))
    assert "GIẢ ĐỊNH" in raw["_doc"]
    mutate(raw)
    p = tmp_path / "r.json"
    p.write_bytes(json.dumps(raw).encode("utf-8"))
    with pytest.raises(h.HrConfigError, match=needle):
        h.load_rules(p)


def test_cli_attendance_dry_run_and_file_error(tmp_path, monkeypatch, capsys):
    _no_connect(monkeypatch)
    assert h.main(["--attendance", str(_csv(tmp_path, GOOD)), "--month",
                   "2026-10", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "| `NV001` | 4 | 1/20 | 1/10 | 1 | 18 | 1 |" in out
    assert "Kỳ ĐÃ ĐÓNG" in out and "KHÔNG tính lương" in out
    bad = _csv(tmp_path, "NV1,2026-10-01,17:00,08:00\n", "bad.csv")
    assert h.main(["--attendance", str(bad), "--month", "2026-10"]) == 1
    assert "không connect, không ghi gì" in capsys.readouterr().out


def test_cli_attendance_open_month(tmp_path, monkeypatch, capsys):
    _no_connect(monkeypatch)
    f = _csv(tmp_path, "NV1,2026-11-02,08:00,17:00\n")
    assert h.main(["--attendance", str(f), "--month", "2026-11",
                   "--dry-run"]) == 0
    out = capsys.readouterr().out
    # hôm nay 05/11 → vắng tính tới 04/11: ngày làm 02,03,04 — chấm 02
    assert "CHƯA ĐÓNG — vắng chỉ tính tới 04/11/2026" in out
    assert "| `NV1` | 1 | 0/0 | 0/0 | 0 | 2 | 0 |" in out


# ---------------------------------------------------------------- DB thật
def _rows(db, otype):
    return db.execute(
        "select block, risk, status, created_by, object_id, payload from"
        " approval_queue where object_type = %s order by id",
        (otype,)).fetchall()


def test_db_submit_three_ops_and_dedupe(db, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(h, "connect", lambda: _TxConn(db))
    assert h.main(["--jd", "nv_cskh"]) == 0
    assert h.main(["--jd", "nv_cskh"]) == 0
    assert "[skip]" in capsys.readouterr().out
    [jd] = _rows(db, "hr_jd")
    assert jd[:4] == ("legal_hr", "medium", "pending", "agent:pc_hr")
    assert jd[4].startswith("jd:nv_cskh:")

    d = _inbox(tmp_path)
    assert h.main(["--screen", "--jd", "nv_van_hanh_san", "--dir",
                   str(d)]) == 0
    [sc] = _rows(db, "hr_screening")
    assert sc[:4] == ("legal_hr", "medium", "pending", "agent:pc_hr")
    for leak in ("Nguyễn", "0901", "@mail.test", "NguyenVanAn"):
        assert leak not in sc[5]
    title = db.execute("select title from approval_queue where object_type ="
                       " 'hr_screening'").fetchone()[0]
    assert "6 hồ sơ" in title

    assert h.main(["--attendance", str(_csv(tmp_path, GOOD)), "--month",
                   "2026-10"]) == 0
    [att] = _rows(db, "hr_attendance")
    assert att[4].startswith("att:2026-10:") and "`NV001`" in att[5]
    # enqueue ghi kèm dòng log (agent_action_log) cho từng mục
    n = db.execute("select count(*) from agent_action_log where actor ="
                   " 'agent:pc_hr' and action = 'queue_enqueue'").fetchone()[0]
    assert n == 3


def test_bias_age_not_confused_with_watering():
    # review v12: norm() bỏ dấu làm 'tưới'/'tươi' == 'tuoi' → chặn oan.
    for ok in ("tưới tiêu", "sâm tươi", "kinh nghiệm tưới nước", "tuoi cay"):
        assert h._bias(ok) is False, ok
    for bad in ("tuổi 25-35", "độ tuổi", "TUỔI dưới 30", "tuoi 25",
                "tuoi tu 22", "tuoi duoi 30", "giới tính nam"):
        assert h._bias(bad) is True, bad
