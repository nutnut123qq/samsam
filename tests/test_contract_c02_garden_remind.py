"""Đợt hợp đồng C02 — farming-02: nhắc NGƯỜI PHỤ TRÁCH khoảnh trước khi báo
GĐ vùng trồng (agents/garden_director.py, bảng garden_reminders).

DB thật (schema tạm + roles ×2, ROLLBACK). Không gửi tin nào: kênh tự động
chưa có; "đã nhắc" chỉ do người ghi qua function."""

import json
from datetime import datetime, timezone

import psycopg
import pytest

from agents import garden_director as gd
from connectors import zalo_garden
from tests.test_ceo_audit import TxConn, ceo_db

T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
SCHED = {"gap_days": 14}


@pytest.fixture
def db():
    yield from ceo_db()


class _Sent:
    """Mục farming/plot_log_gap THẬT trong approval_queue (director.submit
    thật — khóa chống lặp đọc chính bảng này)."""

    def __init__(self, db):
        self.db = db

    def _rows(self):
        return self.db.execute(
            "select object_id, payload from approval_queue where object_type"
            " = 'plot_log_gap' order by id").fetchall()

    def __len__(self):
        return len(self._rows())

    def __getitem__(self, i):
        return self._rows()[i]

    def __eq__(self, other):
        return self._rows() == list(other)

    def __iter__(self):
        return iter(self._rows())

    def clear(self):
        self.base = len(self)


@pytest.fixture
def sent(db):
    return _Sent(db)


def _rem(plot, last=None, days=None):
    return {"type": "no-logs" if last is None else "gap", "plot": plot,
            "activity": None, "last_ts": last, "days": days}


def _rows(db):
    return db.execute("select plot_id, dot_key, ma_nv, status, kenh,"
                      " closed_at is not null from garden_reminders order by"
                      " plot_id, dot_key").fetchall()


def test_plot_owners_file(tmp_path):
    f = tmp_path / "s.json"
    f.write_text(json.dumps({"staff": [
        {"user_hash": "a" * 16, "ma_nv": "VT-1", "khoanh": ["K1", "K2"]},
        {"user_hash": "b" * 16, "ma_nv": "VT-2", "khoanh": ["K2"]},
        {"user_hash": "c" * 16, "ma_nv": "VT-3"}]}), encoding="utf-8")
    assert zalo_garden.plot_owners(f) == {"K1": ["VT-1"],
                                          "K2": ["VT-1", "VT-2"]}
    f.write_text(json.dumps({"staff": [{"ma_nv": "VT-1",
                                        "khoanh": ["../x"]}]}),
                 encoding="utf-8")
    assert zalo_garden.plot_owners(f) == {}     # sai dạng → không ai phụ trách
    assert zalo_garden.plot_owners(tmp_path / "khong.json") == {}


def test_remind_cfg(tmp_path):
    f = tmp_path / "r.json"
    assert gd.load_remind_cfg(tmp_path / "khong.json")["kenh"] is None
    for bad in ({"kenh": "zalo"}, {"kenh": None, "leo_thang_sau_ngay": 0}):
        f.write_text(json.dumps(bad), encoding="utf-8")
        with pytest.raises(ValueError):
            gd.load_remind_cfg(f)


def test_right_person_no_dup_new_log_closes(db, sent):
    c = TxConn(db)
    cfg = {"kenh": "thu_cong", "leo_thang_sau_ngay": 3}
    owners = {"K1": ["VT-1"], "K2": ["VT-2"]}
    rems = [_rem("K1", T0, 20), _rem("K2", T0, 15), _rem("K3")]
    gd.escalate_gaps(c, rems, SCHED, owners, cfg)
    assert _rows(db) == [
        ("K1", "20261001T000000", "VT-1", "cho_gui", "thu_cong", False),
        ("K2", "20261001T000000", "VT-2", "cho_gui", "thu_cong", False),
        ("K3", "none", None, "khong_nguoi_nhan", "thu_cong", False)]
    # chưa gán người → báo GĐ NGAY kèm lý do; K1/K2 trong hạn nhắc → chưa
    assert [o for o, _ in sent] == ["gap:K3:none"]
    assert "CHƯA gán người" in sent[0][1]
    # chạy lại → không nhân bản dòng nhắc, không báo lặp
    gd.escalate_gaps(c, rems, SCHED, owners, cfg)
    assert len(_rows(db)) == 3 and len(sent) == 1
    # K1 có nhật ký mới → đợt cũ đóng, không còn trong danh sách mở
    rems2 = [_rem("K2", T0, 15), _rem("K3")]
    gd.escalate_gaps(c, rems2, SCHED, owners, cfg)
    assert [r[5] for r in _rows(db)] == [True, False, False]
    assert {r[1] for r in gd.open_reminders(db)} == {"K2", "K3"}


def test_manual_channel_escalation_after_wait(db, sent):
    c = TxConn(db)
    cfg = {"kenh": "thu_cong", "leo_thang_sau_ngay": 3}
    rems = [_rem("K1", T0, 30)]                    # ≥ 2×gap: vẫn bỏ trống
    owners = {"K1": ["VT-1"]}
    gd.escalate_gaps(c, rems, SCHED, owners, cfg)
    assert sent == []                              # vừa mở đợt — chờ nhắc
    rid = db.execute("select id from garden_reminders").fetchone()[0]
    # đã nhắc 1 ngày trước → vẫn trong hạn 3 ngày → chưa báo GĐ
    db.execute("select garden_reminder_done_human(%s, 'Tổ Trưởng A')",
               (rid,))
    db.execute("update garden_reminders set reminded_at = now() - interval"
               " '1 day' where id = %s", (rid,))
    gd.escalate_gaps(c, rems, SCHED, owners, cfg)
    assert sent == []
    # nhắc 4 ngày trước mà vẫn trống → báo GĐ lý do da_nhac, 1 lần/đợt
    db.execute("update garden_reminders set reminded_at = now() - interval"
               " '4 days' where id = %s", (rid,))
    gd.escalate_gaps(c, rems, SCHED, owners, cfg)
    gd.escalate_gaps(TxConn(db), rems, SCHED, owners, cfg)
    assert len(sent) == 1 and "đã nhắc người phụ trách" in sent[0][1]


def test_manual_channel_nobody_reminded(db, sent):
    c = TxConn(db)
    cfg = {"kenh": "thu_cong", "leo_thang_sau_ngay": 3}
    rems = [_rem("K1", T0, 30)]
    gd.escalate_gaps(c, rems, SCHED, {"K1": ["VT-1"]}, cfg)
    assert sent == []
    db.execute("update garden_reminders set created_at = now() - interval"
               " '4 days'")
    gd.escalate_gaps(c, rems, SCHED, {"K1": ["VT-1"]}, cfg)
    assert len(sent) == 1 and "chưa ai đánh dấu" in sent[0][1]


def test_mark_reminded_human_only(db):
    c = TxConn(db)
    cfg = {"kenh": "thu_cong", "leo_thang_sau_ngay": None}
    gd.sync_reminders(c, [_rem("K1", T0, 20)], {"K1": ["VT-1"]}, cfg)
    rid = db.execute("select id from garden_reminders").fetchone()[0]
    # agent không ghi "đã nhắc" (function từ chối tên agent)
    with pytest.raises(psycopg.Error), db.transaction():
        db.execute("select garden_reminder_done_human(%s, 'agent:x')", (rid,))
    # agent_writer không UPDATE trực tiếp reminded_*
    with pytest.raises(psycopg.errors.InsufficientPrivilege), \
            db.transaction():
        db.execute("set local role agent_writer")
        db.execute("update garden_reminders set reminded_at = now(),"
                   " reminded_by = 'x' where id = %s", (rid,))
    # owner (dev, ngoài human_logins) qua function: người thật
    with db.transaction():
        db.execute("select garden_reminder_done_human(%s, 'Tổ Trưởng A')",
                   (rid,))
    st = db.execute("select reminded_by from garden_reminders where id = %s",
                    (rid,)).fetchone()[0]
    assert st == "Tổ Trưởng A"
    # lần 2 → False (đã nhắc), không ghi đè
    assert db.execute("select garden_reminder_done_human(%s, 'B')",
                      (rid,)).fetchone()[0] is False


def test_no_channel_blocked_not_reminded(db, sent):
    c = TxConn(db)
    gd.escalate_gaps(c, [_rem("K1")], SCHED, {"K1": ["VT-1"]},
                     {"kenh": None, "leo_thang_sau_ngay": None})
    assert _rows(db)[0][3] == "cho_kenh"
    assert db.execute("select count(*) from garden_reminders where"
                      " reminded_at is not null").fetchone()[0] == 0
    with db.transaction():
        rid = db.execute("select id from garden_reminders").fetchone()[0]
        assert db.execute("select garden_reminder_done_human(%s, 'A')",
                          (rid,)).fetchone()[0] is False
    assert "CHƯA chọn kênh" in sent[0][1]


def test_sample_plot_flagged(db, sent):
    db.execute("insert into plots (id, location, source) values"
               " ('KM', 'x', 'sample:test')")
    gd.sync_reminders(TxConn(db), [_rem("KM")], {}, {"kenh": None,
                                                     "leo_thang_sau_ngay":
                                                     None})
    assert db.execute("select is_sample from garden_reminders").fetchone()[0]


def test_rollout_off_blocks(db, monkeypatch):
    from pipelines import rollout
    monkeypatch.setattr(rollout, "_FORCE_MODE", "tat", raising=False)
    with pytest.raises(rollout.RolloutBlocked):
        gd.sync_reminders(TxConn(db), [_rem("K1")], {}, {"kenh": None,
                                                         "leo_thang_sau_ngay":
                                                         None})
    assert db.execute("select count(*) from garden_reminders").fetchone()[0] \
        == 0
