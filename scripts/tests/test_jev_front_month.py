import importlib.util
from datetime import date, datetime
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_shadow_fm", Path(__file__).resolve().parent.parent / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)


def at(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=js.TAIPEI)


def test_expiring_month_holds_through_the_expiry_day_session():
    assert js.front_month_symbol("TXF", at(2026, 10, 21, 13, 44)) == "TXFJ6"


def test_rolls_at_1345_so_the_night_session_polls_next_month():
    assert js.front_month_symbol("TXF", at(2026, 10, 21, 13, 45)) == "TXFK6"
    assert js.front_month_symbol("TXF", at(2026, 10, 21, 15, 0)) == "TXFK6"


def test_december_rolls_into_next_year():
    assert js.front_month_symbol("TMF", at(2026, 12, 16, 14, 0)) == "TMFA7"


def test_bare_date_is_midnight():
    assert js.front_month_symbol("TXF", date(2026, 10, 21)) == "TXFJ6"
    assert js.front_month_symbol("TXF", date(2026, 10, 22)) == "TXFK6"
