import importlib.util
from datetime import datetime
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_volatile_review", Path(__file__).resolve().parent.parent / "jev-volatile-review.py")
rv = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rv)


def at(y, m, d, h):
    return datetime(y, m, d, h, 0, tzinfo=rv.TAIPEI).timestamp()


def row(epoch, outcome=None):
    return {"bar_time": epoch, "risk_gate": {"prev_outcome": outcome}}


def test_night_session_counts_toward_the_next_trading_day():
    assert rv.trading_day(at(2026, 10, 21, 16)) == rv.trading_day(at(2026, 10, 22, 10))
    assert rv.trading_day(at(2026, 10, 21, 14)) != rv.trading_day(at(2026, 10, 21, 16))


def test_summarize_splits_volatile_from_normal():
    rows = [
        row(1, {"pnl_points": 10.0, "lots": 0.5, "rule": "volatile"}),
        row(2, {"pnl_points": -4.0, "lots": 0.5, "rule": "volatile"}),
        row(3, {"pnl_points": 6.0, "lots": 1.0, "rule": "full"}),
        row(4, None),
    ]
    s = rv.summarize(rows)
    assert s["volatile"] == {"n": 2, "win_rate": 0.5, "avg_points": 3.0, "sized_points": 3.0}
    assert s["normal"]["n"] == 1


def test_silent_until_enough_days(tmp_path, monkeypatch):
    monkeypatch.setattr(rv, "DATA", tmp_path / "none.jsonl")
    monkeypatch.setattr(rv, "DONE", tmp_path / "done")
    monkeypatch.setattr(rv, "REPORT", tmp_path / "report.md")
    assert rv.main(["x"]) == 0
    assert not (tmp_path / "report.md").exists()


def test_night_rows_stay_out_of_the_day_numbers():
    day = {**row(at(2026, 10, 22, 10), {"pnl_points": 10.0, "lots": 1.0, "rule": "full"})}
    night = {**row(at(2026, 10, 22, 21), {"pnl_points": -50.0, "lots": 1.0, "rule": "full"})}
    parts = rv.split_by_session([day, night])
    assert [r["bar_time"] for r in parts["day"]] == [day["bar_time"]]
    assert [r["bar_time"] for r in parts["night"]] == [night["bar_time"]]
    assert rv.summarize(parts["day"])["normal"]["avg_points"] == 10.0
    assert rv.summarize(parts["night"])["normal"]["avg_points"] == -50.0
    report = rv.render(1, rv.summarize(parts["day"]), (1, rv.summarize(parts["night"])))
    assert "## 日盤" in report and "## 夜盤" in report


def test_session_field_wins_over_bar_time():
    assert rv.session_of({"bar_time": at(2026, 10, 22, 10), "session": "night"}) == "night"
