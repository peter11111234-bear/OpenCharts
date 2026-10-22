"""Daily TAIFEX per-trade download + local 1m history rebuild (E4).

Run after the night session opens (the trade-date file is final by ~15:30):
  python scripts/taifex-daily-update.py

1. Download Daily_YYYY_MM_DD.zip for the last few weekdays into logs/taifex-daily/.
   Missing files are fetched; the newest two are re-fetched because a file downloaded
   before the trade date is final is smaller (Daily_2026_10_21: 2,467,823 vs 2,473,112 bytes).
2. Rebuild public/local-bars/hist/<CODE>.json for the current and next month of MXF/TMF
   via taifex-local-bars.py (no Shioaji quota used anywhere).
Holidays / unpublished days answer 404 and are skipped.
"""
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DAILY = ROOT / "logs" / "taifex-daily"
URL = "https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_{d:%Y_%m_%d}.zip"
TPE = timezone(timedelta(hours=8))
LOOKBACK_DAYS = 6
REFRESH_NEWEST = 2
MIN_BYTES = 100_000


def contract_codes(today) -> list[str]:
    """MXF/TMF codes for this and next month: month letter A=Jan..L=Dec + year digit."""
    codes = []
    for offset in (0, 1):
        m = today.month - 1 + offset
        y, m = today.year + m // 12, m % 12 + 1
        for root in ("MXF", "TMF"):
            codes.append(f"{root}{chr(ord('A') + m - 1)}{y % 10}")
    return codes


def fetch(d) -> str:
    """'ok' / 'same' / 'missing' / 'bad'."""
    dst = DAILY / f"Daily_{d:%Y_%m_%d}.zip"
    req = urllib.request.Request(URL.format(d=d), headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            data = res.read()
    except urllib.error.HTTPError as e:
        return "missing" if e.code == 404 else f"bad (HTTP {e.code})"
    except Exception as e:
        return f"bad ({type(e).__name__}: {e})"
    tmp = dst.with_suffix(".zip.tmp")
    tmp.write_bytes(data)
    if len(data) < MIN_BYTES or not zipfile.is_zipfile(tmp) or zipfile.ZipFile(tmp).testzip() is not None:
        tmp.unlink()
        return "bad (not a valid zip)"
    if dst.exists() and dst.stat().st_size == len(data):
        tmp.unlink()
        return "same"
    tmp.replace(dst)
    return f"ok ({len(data):,} bytes)"


def main() -> int:
    DAILY.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None:  # pythonw (scheduled task): no console, keep a log instead
        sys.stdout = sys.stderr = open(ROOT / "logs" / "taifex-daily-update.log", "a", encoding="utf-8", buffering=1)
        print(f"--- {datetime.now(TPE):%F %T} ---")
    today = datetime.now(TPE).date()
    days = [today - timedelta(days=i) for i in range(LOOKBACK_DAYS)]
    weekdays = [d for d in days if d.weekday() < 5]
    for i, d in enumerate(weekdays):
        dst = DAILY / f"Daily_{d:%Y_%m_%d}.zip"
        if dst.exists() and i >= REFRESH_NEWEST:
            continue
        print(f"{d}: {fetch(d)}", flush=True)
    codes = contract_codes(today)
    print("rebuild:", " ".join(codes), flush=True)
    return subprocess.call([sys.executable, "-I", str(ROOT / "scripts" / "taifex-local-bars.py"), *codes],
                           stdout=sys.stdout, stderr=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
