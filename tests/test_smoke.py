"""Smoke test — gate tối thiểu để `pytest` luôn có nghĩa."""


def test_repo_shape():
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    for d in ["crawler", "ingest", "pipelines", "app", "data", "evidence"]:
        assert (root / d).is_dir(), f"thiếu thư mục {d}"
