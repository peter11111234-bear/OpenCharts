import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hotscan.dedup_ticks import dedup  # noqa: E402


def _write(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def _read(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()]


def test_drops_rewritten_ticks_but_keeps_everything_else(tmp_path):
    live = {"ts": 1, "dt": "2026-10-21T10:05:58.857268", "code": "6269", "price": 87.0, "vol": 4, "tick_type": 2, "total_volume": 100}
    rewrite = {k: v for k, v in live.items() if k != "total_volume"}  # backfill copy of the same print
    other_px = dict(rewrite, price=87.1)
    other_code = dict(rewrite, code="2330")
    old_fmt = {"ts": 1, "code": "6269", "price": 87.0, "vol": 4}  # no dt: kept even if repeated
    src, dst = tmp_path / "src.jsonl", tmp_path / "dst.jsonl"
    _write(src, [live, rewrite, other_px, other_code, old_fmt, old_fmt])
    stats = dedup(src, dst)
    out = _read(dst)
    assert out == [live, other_px, other_code, old_fmt, old_fmt]
    assert stats["2026-10-21"]["dup"] == 1 and stats["2026-10-21"]["dup_vol"] == 4
    assert stats["undated"]["rows"] == 2


def test_same_time_on_another_day_is_not_a_duplicate(tmp_path):
    a = {"dt": "2026-10-20T10:00:00.000001", "code": "2330", "price": 1, "vol": 1, "tick_type": 1}
    b = dict(a, dt="2026-10-21T10:00:00.000001")
    src, dst = tmp_path / "src.jsonl", tmp_path / "dst.jsonl"
    _write(src, [a, b, b])
    dedup(src, dst)
    assert _read(dst) == [a, b]


def test_source_is_untouched(tmp_path):
    src, dst = tmp_path / "src.jsonl", tmp_path / "dst.jsonl"
    _write(src, [{"dt": "2026-10-21T10:00:00.000001", "code": "1", "price": 1, "vol": 1}] * 2)
    before = src.read_bytes()
    dedup(src, dst)
    assert src.read_bytes() == before
