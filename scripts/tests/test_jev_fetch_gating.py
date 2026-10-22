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


# ---- F1b: night session decided too; real trading windows only --------------------------

def test_market_open_windows():
    mo = js.market_open
    assert mo(at(8, 45)) and mo(at(13, 45)) and not mo(at(8, 44)) and not mo(at(13, 46))
    assert not mo(at(14, 30)) and not mo(at(14, 59))          # gap between sessions
    assert mo(at(15, 0)) and mo(at(23, 59)) and mo(at(0, 0, day=22)) and mo(at(4, 59, day=22))
    assert not mo(at(5, 0, day=22)) and not mo(at(8, 44, day=22))
    assert mo(at(9, 0, day=22))                                # Thursday day session
    # Fri 2026-10-23 night runs into Sat 05:00; Sat 05:00 -> Mon 08:45 closed
    assert mo(at(23, 0, day=23)) and mo(at(4, 59, day=24)) and not mo(at(5, 0, day=24))
    assert not mo(at(12, 0, day=24)) and not mo(at(20, 0, day=24))
    assert not mo(at(3, 0, day=25)) and not mo(at(12, 0, day=25))   # Sunday
    assert not mo(at(3, 0, day=26)) and not mo(at(8, 44, day=26)) and mo(at(8, 45, day=26))  # Monday


def test_fetch_and_decide_use_the_same_predicate():
    for h in range(24):
        for m in (0, 5, 30, 45, 55):
            ts = at(h, m)
            assert js.session_ok(ts, True) == js.market_open(ts)
            assert js.session_ok(ts, False) == js._day_session(ts)


def test_all_sessions_does_not_fetch_in_gaps_or_on_weekends():
    for start, end in [(at(13, 52), at(14, 58)), (at(5, 6, day=22), at(8, 40, day=22)),
                       (at(5, 6, day=24), at(23, 0, day=25))]:   # Sat 05:06 .. Sun night
        f = simulate(start, end, all_sessions=True)
        assert all(t < start + 2 * POLL for t in f), [(t - start) for t in f]


def test_all_sessions_fetches_every_bucket_in_the_night():
    f = simulate(at(22, 0), at(23, 0), all_sessions=True)
    assert 12 <= len(f) <= 14


def test_risk_key_is_the_trading_day_like_order_guard():
    k = js.risk_key
    assert k(at(16, 0, day=21)) == k(at(2, 0, day=22)) == k(at(10, 0, day=22))   # Wed night + Thu day
    assert k(at(10, 0, day=22)) != k(at(15, 0, day=22))                           # Thu 15:00 starts the next day
    assert k(at(10, 0, day=21)) != k(at(10, 0, day=22))


def test_monday_night_loss_streak_still_stops_tuesday_day_until_tuesday_1500():
    mon_night, tue_day, tue_night = at(16, 0, day=26), at(10, 0, day=27), at(15, 0, day=27)
    sess, key = js.rotate_risk_session(None, None, mon_night)
    sess.consecutive_losses = 3
    ans = {"answers": {"action_choice": {"choice": "buy", "confidence": 0.9}}}
    bar = {"time": tue_day, "close": 100.0}
    s2, key = js.rotate_risk_session(sess, key, tue_day)
    assert s2 is sess and s2.gate(bar, ans)[3] == "consec_loss_stop"        # Tuesday day: still stopped
    s3, key = js.rotate_risk_session(s2, key, tue_night)
    assert s3 is not sess and s3.consecutive_losses == 0                   # Tuesday 15:00: fresh counters
    assert s3.gate({"time": tue_night, "close": 100.0}, ans)[0] != "veto"
