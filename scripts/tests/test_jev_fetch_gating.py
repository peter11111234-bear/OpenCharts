"""F1: fetch_due() must cut the kbars refetches without delaying or losing any decision."""
import importlib.util
from datetime import datetime
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_shadow_gate", Path(__file__).resolve().parent.parent / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)

TPE = js.TAIPEI
POLL = 30
LAG = 4   # seconds until a finished 1m bar shows up in kbars


def at(h, m, s=0, day=21):
    return datetime(2026, 10, day, h, m, s, tzinfo=TPE).timestamp()


def kbars_at(now):
    """1m bars visible in kbars at `now` (bar [m, m+60) lands LAG seconds after it closes)."""
    last = int((now - LAG) // 60) * 60 - 60
    return [{"time": last}]


def first_complete_fetch(fetch_times, bucket_end):
    """Time of the first fetch that already holds the last 1m bar of the bar ending at bucket_end."""
    for t in fetch_times:
        if kbars_at(t)[-1]["time"] >= bucket_end - 60:
            return t
    return None


def simulate(start, end, all_sessions=False, gated=True):
    st, fetches, t = {}, [], start
    while t < end:
        if js.fetch_due(t, st, all_sessions, gated):
            fetches.append(t)
            js.note_fetch(st, t, kbars_at(t), pending=False)
        t += POLL
    return fetches


def test_decision_time_is_not_later_than_one_poll_plus_grace():
    start, end = at(8, 41), at(14, 5)
    old, new = simulate(start, end, gated=False), simulate(start, end)
    day_bars = [b for b in range(int(at(8, 45)), int(at(13, 45)), js.TF_SECONDS)]
    for b in day_bars:
        t_old = first_complete_fetch(old, b + js.TF_SECONDS)
        t_new = first_complete_fetch(new, b + js.TF_SECONDS)
        assert t_new is not None, f"bar {b} never decided"
        assert t_new - t_old <= js.FETCH_GRACE_S + POLL, (b, t_old, t_new)


def test_fetch_count_drops_by_about_90_percent():
    start, end = at(8, 41), at(14, 5)
    old, new = simulate(start, end, gated=False), simulate(start, end)
    assert len(new) <= len(old) // 8, (len(old), len(new))


def test_no_fetch_overnight_without_all_sessions():
    segments = [(at(15, 10), at(23, 59)), (at(0, 0, day=22), at(8, 40, day=22))]
    for start, end in segments:
        fetches = simulate(start, end)
        # only the first run (plus its in-bucket retry) — nothing for the rest of the night
        assert all(t < start + 2 * POLL for t in fetches), [t - start for t in fetches]


def test_all_sessions_fetches_once_per_bucket_overnight():
    fetches = simulate(at(20, 0), at(21, 0), all_sessions=True)
    assert 12 <= len(fetches) <= 14, len(fetches)   # 12 buckets (+ first run / retry)


def test_pending_forces_fetch_every_poll():
    st = {"last_bucket": js.bucket_of(at(10, 7)), "retry": 0, "pending": True}
    assert js.fetch_due(at(10, 7, 30), st, False)
    st["pending"] = False
    assert not js.fetch_due(at(10, 7, 30), st, False)


def test_missing_last_1m_bar_retries_at_most_three_times_per_bucket():
    st, n, t = {}, 0, at(10, 5, 10)
    while t < at(10, 10, 0):
        if js.fetch_due(t, st, False):
            n += 1
            js.note_fetch(st, t, [{"time": js.bucket_of(t) - 600}], pending=False)  # never catches up
        t += POLL
    assert n == js.FETCH_RETRIES


def test_backfill_run_keeps_polling_every_cycle():
    assert js.fetch_due(at(3, 0), {"last_bucket": js.bucket_of(at(3, 0)), "retry": 0}, False, gated=False)
