"""TWSE trading-day check (official holiday schedule).

Source: https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json
Each entry is one official date. Rows whose 名稱 contains "交易日" mark days
when trading DOES run (e.g. 農曆春節後開始交易日); every other listed date is a
market closure (holidays + 僅結算交割 days). Weekends are never listed.

Lookup order: memory → logs/twse-holidays-{year}.json → live fetch.
Fail-open: on any error (offline, API down) returns True — monitoring stays on
rather than going silent on a real trading day.

CLI: python -m hotscan.tradingday [--date YYYY-MM-DD]
Exit 0 = trading day, 1 = closed. Used by the watchdog/start scripts so the
calendar logic lives in exactly one place.
"""

import json
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

from . import config

_URL = "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json"
_TIMEOUT = 8

_holiday_cache: dict = {}  # year -> frozenset[date]

def _cache_path(year: int) -> Path:
    return config.LOG_DIR / f"twse-holidays-{year}.json"


def _fetch_holidays(year: int) -> frozenset:
    with urllib.request.urlopen(_URL, timeout=_TIMEOUT) as r:
        payload = json.loads(r.read().decode("utf-8"))
    days = set()
    for row in payload.get("data") or []:
        try:
            d = date.fromisoformat(str(row[0]).strip())
        except (IndexError, ValueError):
            continue
        name = str(row[1]) if len(row) > 1 else ""
        if "交易日" in name:  # trading resumes this day — not a closure
            continue
        days.add(d)
    return frozenset(days)


def _holidays(year: int) -> frozenset:
    if year in _holiday_cache:
        return _holiday_cache[year]
    path = _cache_path(year)
    try:
        if path.exists():
            days = frozenset(date.fromisoformat(s) for s in json.loads(path.read_text()))
            _holiday_cache[year] = days
            return days
    except Exception:
        pass
    days = _fetch_holidays(year)
    _holiday_cache[year] = days
    try:
        path.write_text(json.dumps(sorted(d.isoformat() for d in days)), encoding="utf-8")
    except Exception:
        pass  # cache is a nicety, never break the check
    return days


def is_trading_day(d: date | None = None) -> bool:
    fake = os.environ.get("HOTSCAN_FAKE_TRADING_DAY")  # 測試用: "1"=強制交易日, "0"=強制休市
    if fake == "1":
        return True
    if fake == "0":
        return False
    d = d or date.today()
    if d.weekday() >= 5:
        return False
    try:
        return d not in _holidays(d.year)
    except Exception:
        return True  # fail-open


def main() -> int:
    d = None
    if "--date" in sys.argv:
        d = date.fromisoformat(sys.argv[sys.argv.index("--date") + 1])
    open_ = is_trading_day(d)
    print("open" if open_ else "closed")  # watchdog 靠 stdout 判斷，exit code 僅輔助
    return 0 if open_ else 1


if __name__ == "__main__":
    raise SystemExit(main())
