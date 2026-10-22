"""Build 1m history bars for a futures contract from archived TAIFEX daily tick files.

Fallback history for /vela when Shioaji kbars come back empty (daily 500MB cap):
logs/taifex-daily/Daily_YYYY_MM_DD.zip -> public/local-bars/hist/<CODE>.json
(the live recorder owns public/local-bars/<CODE>.json and rewrites it every 10s,
so history goes to its own file and velaProvider merges the two).

Bars are that exact contract month (MXFK6 = MTX 202611), not a rolled series,
time = minute start in epoch seconds (same labeling as fop-tick-recorder.py),
volume = TAIFEX 成交數量(B+S) / 2 = lots. Spread rows (month "a/b") and weekly
contracts ("202611W1") are excluded.
Usage: python scripts/taifex-local-bars.py MXFK6 TMFK6
"""
import csv
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "logs" / "taifex-daily"
DST = ROOT / "public" / "local-bars" / "hist"
PRODUCT = {"MXF": "MTX", "TMF": "TMF", "TXF": "TX"}
TPE = timezone(timedelta(hours=8))


def contract_month(code: str) -> tuple[str, str]:
    """MXFK6 -> ("MTX", "202611"); year digit assumed in the 2020s."""
    month = ord(code[3]) - ord("A") + 1
    return PRODUCT[code[:3]], f"202{code[4]}{month:02d}"


def build(code: str) -> list[dict]:
    product, month = contract_month(code)
    bars: dict[int, dict] = {}
    for z in sorted(SRC.glob("Daily_*.zip")):
        with zipfile.ZipFile(z) as zf:
            name = zf.namelist()[0]
            rows = csv.reader(io.TextIOWrapper(zf.open(name), encoding="cp950"))
            next(rows, None)
            for r in rows:
                if len(r) < 6 or r[1].strip() != product or r[2].strip() != month:
                    continue
                d, t = r[0].strip(), r[3].strip().zfill(6)
                ts = int(datetime(int(d[:4]), int(d[4:6]), int(d[6:]), int(t[:2]), int(t[2:4]), tzinfo=TPE).timestamp())
                price, vol = float(r[4]), int(r[5]) / 2
                b = bars.get(ts)
                if b is None:
                    bars[ts] = {"time": ts, "open": price, "high": price, "low": price, "close": price, "volume": vol}
                else:
                    b["high"] = max(b["high"], price)
                    b["low"] = min(b["low"], price)
                    b["close"] = price
                    b["volume"] += vol
    # rows are time-ordered within a file, files are date-ordered: insertion order is chronological
    return [bars[k] for k in sorted(bars)]


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    for code in sys.argv[1:]:
        out = build(code)
        tmp = DST / f"{code}.json.tmp"
        tmp.write_text(json.dumps(out), encoding="utf-8")
        os.replace(tmp, DST / f"{code}.json")
        span = f"{datetime.fromtimestamp(out[0]['time'], TPE):%m-%d %H:%M} .. {datetime.fromtimestamp(out[-1]['time'], TPE):%m-%d %H:%M}" if out else "-"
        print(f"{code}: {len(out)} bars {span}")


if __name__ == "__main__":
    main()
