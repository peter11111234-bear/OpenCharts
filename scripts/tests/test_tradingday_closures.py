import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hotscan import config, tradingday  # noqa: E402

FRI = date(2026, 10, 23)  # 颱風/臨時休市：TWSE 官方休市表沒有這天


def _official(monkeypatch, tmp_path, holidays=()):
    monkeypatch.delenv("HOTSCAN_FAKE_TRADING_DAY", raising=False)
    monkeypatch.setattr(config, "LOG_DIR", tmp_path)
    monkeypatch.setattr(tradingday, "_holidays", lambda year: frozenset(holidays))


def test_listed_manual_closure_is_not_a_trading_day(monkeypatch, tmp_path):
    _official(monkeypatch, tmp_path)
    (tmp_path / "market-closures.txt").write_text("# 颱風假\n2026-10-23  # 全天休市\n", encoding="utf-8")
    assert tradingday.is_trading_day(FRI) is False
    assert tradingday.is_trading_day(date(2026, 10, 22)) is True


def test_missing_or_garbled_closure_file_keeps_official_schedule(monkeypatch, tmp_path):
    _official(monkeypatch, tmp_path)
    assert tradingday.is_trading_day(FRI) is True
    (tmp_path / "market-closures.txt").write_text("not-a-date\n", encoding="utf-8")
    assert tradingday.is_trading_day(FRI) is True
