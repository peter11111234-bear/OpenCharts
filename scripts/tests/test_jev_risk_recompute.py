import importlib.util
from datetime import datetime
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_risk_recompute", Path(__file__).resolve().parent.parent / "jev-risk-recompute.py")
rc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rc)
TPE = rc.js.TAIPEI


def at(d, h, m=0):
    return datetime(2026, 10, d, h, m, tzinfo=TPE).timestamp()


def row(ts, price, choice="buy", conf=0.9, junk=True):
    return {"bar_time": ts, "price": price, "answers": {"action_choice": {"choice": choice, "confidence": conf}},
            "risk_gate": {"verdict": "JUNK" if junk else "x", "lots_mult": -1, "reason": "junk", "rule": "junk",
                          "prev_outcome": None}, "deepseek": {"verdict": "keep-me"}}


# Mon 2026-10-26 night, falling prices: buy, buy, buy (3 losses), then Tue day and Tue 15:00
MON = [row(at(26, 16, 0), 100.0), row(at(26, 16, 5), 90.0), row(at(26, 16, 10), 80.0), row(at(26, 16, 15), 70.0)]
TUE_DAY, TUE_NIGHT = row(at(27, 10, 0), 70.0), row(at(27, 15, 0), 70.0)


def test_monday_night_losses_stop_tuesday_day_and_clear_at_1500():
    out = rc.recompute(MON + [TUE_DAY, TUE_NIGHT])
    assert out[3]["risk_gate"]["rule"] == "consec_loss_stop"        # 3rd loss: stop
    assert out[4]["risk_gate"]["rule"] == "consec_loss_stop"        # Tuesday day: still stopped
    assert out[5]["risk_gate"]["verdict"] != "veto"                 # Tuesday 15:00: counters are fresh


def test_replay_is_in_bar_time_order_and_leaves_other_fields_alone():
    rows = MON + [TUE_DAY, TUE_NIGHT]
    shuffled = [rows[i] for i in (5, 2, 0, 4, 3, 1)]               # arrival order != bar order
    by_time = {r["bar_time"]: r for r in rc.recompute(shuffled)}
    in_order = {r["bar_time"]: r for r in rc.recompute(rows)}
    assert by_time == in_order
    assert all(r["deepseek"] == {"verdict": "keep-me"} for r in in_order.values())
    assert all(r["price"] == o["price"] for r, o in zip(rc.recompute(rows), rows))


def test_rows_without_risk_gate_pass_through_and_diff_counts_changes():
    plain = {"bar_time": at(26, 15, 55), "price": 1.0, "answers": None, "risk_gate": None}
    old = [plain] + MON
    new = rc.recompute(old)
    assert new[0] == plain
    s = rc.diff_summary(old, new)
    assert s["rows"] == 5 and s["changed"] == 4 and "verdict" in s["by_field"]
