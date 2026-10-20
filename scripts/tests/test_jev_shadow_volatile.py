"""Regression: Jev's volatility_regime carries a `legend` whose text always
contains "Volatile:", so a substring test vetoed every bar (2026-10-19, 61/61)."""
import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_shadow", Path(__file__).resolve().parent.parent / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)

LEGEND = {
    "0": "Calm: tight day range, moving averages closely bunched.",
    "1": "Normal: moderate day range, some separation between MA tiers.",
    "2": "Volatile: wide day range, MA tiers widely separated or whipsawing.",
}


def ans(score, prob2, choice="buy", conf=0.9):
    return {"answers": {
        "action_choice": {"type": "choice", "choice": choice, "confidence": conf},
        "volatility_regime": {"type": "score", "score": score, "confidence": 0.5,
                              "legend": LEGEND,
                              "probabilities": {"0": 0.3, "1": 0.68, "2": prob2}},
    }}


def test_normal_regime_is_not_vetoed():
    verdict, _, _, rule = js.RiskSession().gate({}, ans(0.5, 0.02))
    assert (verdict, rule) == ("approve", "full")


def test_high_score_is_followed_at_half_size():
    # Breakouts need range: a volatile bar is followed, at half size.
    verdict, mult, _, rule = js.RiskSession().gate({}, ans(1.6, 0.02))
    assert (verdict, mult, rule) == ("reduce", 0.5, "volatile")


def test_p60_threshold_is_the_boundary():
    # 0.67 is P60 of the logged scores: at or above it the bar is volatile.
    assert js.RiskSession().gate({}, ans(0.67, 0.02))[3] == "volatile"
    assert js.RiskSession().gate({}, ans(0.66, 0.02))[3] == "full"


def test_high_volatile_probability_is_followed_at_half_size():
    verdict, mult, _, rule = js.RiskSession().gate({}, ans(0.9, 0.55))
    assert (verdict, mult, rule) == ("reduce", 0.5, "volatile")


def test_half_size_trade_reports_full_lot_pnl_and_counts_half():
    rs = js.RiskSession()
    rs.open_entry, rs.open_direction, rs.open_lots, rs.open_rule = 100.0, "buy", 0.5, "volatile"
    out = rs._close_open_position({"close": 110.0})
    assert (out["pnl_points"], out["lots"], out["rule"]) == (10.0, 0.5, "volatile")
    assert rs.realized_points == 5.0


def test_volatile_keeps_its_tag_when_confidence_is_also_low():
    verdict, mult, _, rule = js.RiskSession().gate({}, ans(1.6, 0.02, conf=0.5))
    assert (verdict, mult, rule) == ("reduce", 0.5, "volatile")


def test_normal_regime_does_not_escalate():
    assert js.should_escalate(ans(0.7, 0.02)) == (False, "")


def test_score_one_still_escalates():
    ok, trigger = js.should_escalate(ans(1.0, 0.02))
    assert ok and trigger.startswith("volatile environment")
