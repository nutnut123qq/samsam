"""v3.9 W39.6 — scripts/kb_gaps.py: cụm câu NO_DATA lặp lại bằng luật
(0 LLM), đọc convlog BYTES-safe, mask PII lần nữa, nhãn sức khỏe/rượu."""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import kb_gaps

from pipelines import llm_gateway


@pytest.fixture(autouse=True)
def _no_llm(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("kb_gaps không được gọi LLM")
    monkeypatch.setattr(llm_gateway, "chat", boom)
    monkeypatch.setattr(llm_gateway, "embed", boom)
    monkeypatch.setattr(llm_gateway, "_client", boom)


def _rec(q, answered=False, user="u1", ts="2026-10-01T00:00:00Z", **kw):
    r = {"ts": ts, "msg_id": "", "user_hash": user, "question": q,
         "answer": "Chưa đủ dữ liệu để trả lời.", "answered": answered}
    r.update(kw)
    return json.dumps(r, ensure_ascii=False).encode("utf-8")


def _write(tmp_path, lines, name="conversations.jsonl"):
    (tmp_path / name).write_bytes(b"\n".join(lines) + b"\n")


def test_cluster_case_space_punct(tmp_path):
    _write(tmp_path, [
        _rec("Sâm Sâm có xuất khẩu sang Mỹ không?", user="u1"),
        _rec("sâm sâm   có xuất khẩu sang mỹ không", user="u2",
             ts="2026-10-03T00:00:00Z"),
        _rec("SÂM SÂM có xuất khẩu sang Mỹ không ??", user="u1"),
        _rec("Giờ mở cửa showroom?", user="u3"),
    ])
    (tmp_path / "conversations.jsonl.1").write_bytes(
        _rec("Sâm Sâm có xuất khẩu sang Mỹ không.", user="u4") + b"\n")
    groups = kb_gaps.collect(tmp_path)
    top = groups[0]
    assert top["count"] == 4 and top["users"] == 3
    assert top["last_ts"] == "2026-10-03T00:00:00Z"
    assert len(groups) == 2


def test_answered_variants_not_counted(tmp_path):
    _write(tmp_path, [
        _rec("câu A", answered=True),
        _rec("câu A", answered="false"),
        json.dumps({"ts": "x", "user_hash": "u", "question": "câu A"}).encode(),
        _rec("câu A", answered=None),
        _rec("câu A", answered=0),
    ])
    assert kb_gaps.collect(tmp_path) == []


def test_corrupt_lines_and_u2028(tmp_path):
    _write(tmp_path, [
        b"{not json",
        b"\xff\xfe garbage",
        _rec("Có ship ra Huế\u2028không?"),  # U+2028 không cắt đôi record
        _rec("Có ship ra Huế\u2028không?", user="u2"),
        b'{"_doc": "comment"}',
        b"[1, 2]",
    ])
    groups = kb_gaps.collect(tmp_path)
    assert len(groups) == 1 and groups[0]["count"] == 2


def test_missing_file_zero(tmp_path, capsys):
    assert kb_gaps.main([], data_dir=tmp_path) == 0
    assert "0 câu" in capsys.readouterr().out


def test_phone_masked_and_pipe_escaped(tmp_path):
    _write(tmp_path, [_rec("Gọi 0905123456 | báo giá sỉ"),
                      _rec("Gọi 0905 123 456 | báo giá sỉ", user="u2")])
    out = kb_gaps.render(kb_gaps.collect(tmp_path), 2)
    assert "0905" not in out and not re.search(r"\d{9,}", out)
    assert "\\|" in out
    row = next(ln for ln in out.split("\n") if ln.startswith("| 1 |"))
    assert row.count(" | ") == 5  # đúng 6 cột: | trong câu đã escape


def test_html_escaped(tmp_path):
    _write(tmp_path, [_rec("<img src=x onerror=alert(1)> giá?")])
    out = kb_gaps.render(kb_gaps.collect(tmp_path), 1)
    assert "<img" not in out and "&lt;img" in out


def test_kind_labels(tmp_path):
    _write(tmp_path, [_rec("Saphraton chữa ung thư không?"),
                      _rec("Saphraton chữa ung thư không?", user="u2"),
                      _rec("Rượu sâm No.9 bao nhiêu độ?"),
                      _rec("Rượu sâm No.9 bao nhiêu độ?", user="u2"),
                      _rec("Có giao hàng quốc tế?"),
                      _rec("Có giao hàng quốc tế?", user="u2")])
    kinds = {g["question"]: g["kind"] for g in kb_gaps.collect(tmp_path)}
    assert kinds["Saphraton chữa ung thư không?"] == "sức khỏe"
    assert kinds["Rượu sâm No.9 bao nhiêu độ?"] == "rượu"
    assert kinds["Có giao hàng quốc tế?"] == ""


def test_min_and_out_atomic(tmp_path):
    _write(tmp_path, [_rec("câu một"), _rec("câu một", user="u2"), _rec("câu hai")])
    out = tmp_path / "gaps.md"
    assert kb_gaps.main(["--min", "2", "--out", str(out)], data_dir=tmp_path) == 0
    body = out.read_text(encoding="utf-8")
    assert "câu một" in body and "câu hai" not in body
    assert not (tmp_path / "gaps.md.tmp").exists()
    assert kb_gaps.main(["--min", "1", "--out", str(out)], data_dir=tmp_path) == 0
    assert "câu hai" in out.read_text(encoding="utf-8")
    with pytest.raises(SystemExit):
        kb_gaps.main(["--min", "0"], data_dir=tmp_path)
