"""v10.3 W103.5 — phần thuần của `scripts/vector_eval.py` (không docker/DB).
Chạy thật (container pgvector tạm + corpus nguồn) là gate thủ công —
evidence/v103_pgvector.log."""

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import dr_drill
import vector_eval as ve


@pytest.mark.parametrize("pg,f8,want", [
    ([], [], 1.0),
    ([("a", 0)], [], 0.0),
    ([], [("a", 0)], 0.0),
    ([("a", 0), ("b", 1)], [("b", 1), ("a", 0)], 1.0),
    ([("a", 0), ("c", 0)], [("a", 0), ("b", 0)], 0.5),
    ([("a", 0)] + [(f"x{i}", 0) for i in range(7)],
     [("a", 0)] + [(f"x{i}", 0) for i in range(6)] + [("z", 0)], 7 / 8),
])
def test_recall_at_k_edges(pg, f8, want):
    assert ve.recall_at_k(pg, f8) == pytest.approx(want)


def test_synthetic_queries_deterministic_and_normalized():
    rng = np.random.default_rng(0)
    embs = rng.normal(size=(50, 16))
    a = ve.synthetic_queries(embs, 20)
    b = ve.synthetic_queries(embs, 20, seed=42)
    c = ve.synthetic_queries(embs, 20, seed=7)
    assert len(a) == 20
    assert all(np.array_equal(x, y) for x, y in zip(a, b))
    assert not all(np.array_equal(x, y) for x, y in zip(a, c))
    assert all(abs(np.linalg.norm(x) - 1) < 1e-12 for x in a)


def test_groups_hit_casefold():
    hits = [{"content": "Saphraton giá 236.000 đ"}, {"content": None},
            {"content": "Trụ sở Tam Kỳ"}]
    assert ve.groups_hit(hits, [["236.000"], ["1.000.000"]]) == 1
    assert ve.groups_hit(hits, [["SAPHRATON"], ["tam kỳ", "đà nẵng"]]) == 2
    assert ve.groups_hit([], [["x"]]) == 0


def _no_side_effects(monkeypatch):
    calls = []
    monkeypatch.setattr(ve, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(ve, "read_source",
                        lambda *a: calls.append("read") or ({}, {}))
    monkeypatch.setattr(ve.dr, "_docker",
                        lambda *a, **k: calls.append("docker"))
    return calls


def test_missing_image_exit3_no_container(monkeypatch, capsys):
    calls = _no_side_effects(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgresql://fake/x")
    monkeypatch.setattr(ve.dr, "probe_docker",
                        lambda image: f"thiếu image {image} trên máy")
    assert ve.main(["--synthetic", "5"]) == 3
    out = capsys.readouterr().out
    assert "[external-dep]" in out and ve.IMAGE in out
    assert calls == []


@pytest.mark.parametrize("argv", [["--synthetic", "-1"],
                                  ["--synthetic", "5001"],
                                  ["--synthetic", "0"],
                                  ["--synthetic", "x"]])
def test_usage_exit2(monkeypatch, argv):
    calls = _no_side_effects(monkeypatch)
    with pytest.raises(SystemExit) as e:
        ve.main(argv)
    assert e.value.code == 2 and calls == []


def test_missing_dsn_exit2(monkeypatch):
    calls = _no_side_effects(monkeypatch)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert ve.main([]) == 2 and calls == []


def test_dr_drill_prefix_default_unchanged(monkeypatch):
    seen = []

    class R:
        stdout = b"samsam-dr-1 samsam-vec-2 other"

    monkeypatch.setattr(dr_drill, "_docker",
                        lambda args, **k: seen.append(args) or R())
    assert dr_drill.leftovers() == ["samsam-dr-1"]
    assert dr_drill.leftovers(ve.PREFIX) == ["samsam-vec-2"]
    assert "name=samsam-dr-" in seen[0] and "name=samsam-vec-" in seen[1]
