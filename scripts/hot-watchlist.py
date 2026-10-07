"""Fetch Taiwan top-N stocks by daily trading amount from official exchange APIs.

Sources (both verified 2026-09-23):
  TWSE  MI_INDEX     https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json
  TPEx  dailyQuotes  https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=YYYY/MM/DD&id=&response=json

Output: logs/hot-watchlist-YYYYMMDD.json
  {"date": "...", "source": "...", "count": N,
   "stocks": [{"code","name","amount","exchange"}, ...]}

Usage:
  python scripts/hot-watchlist.py                # latest trading day, top 100
  python scripts/hot-watchlist.py --date 2026-09-22 --top 100
  python scripts/hot-watchlist.py --print        # also dump table to stdout
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (hot-watchlist)"}
CODE_RE = re.compile(r"^[1-9]\d{3}$")  # 4-digit starting 1-9 = common stock; skips ETF(00xx)/warrant/special
OUT_DIR = Path(__file__).resolve().parent.parent / "logs"


def _num(s) -> int:
    return int(re.sub(r"[^0-9]", "", str(s)) or 0)


def _get(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_twse(d: date) -> list[dict]:
    ymd = d.strftime("%Y%m%d")
    url = ("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
           f"?date={ymd}&type=ALLBUT0999&response=json")
    data = _get(url)
    if data.get("stat") != "OK":
        return []
    rows = []
    for t in data.get("tables", []):
        if "每日收盤行情" in t.get("title", ""):
            for r in t.get("data", []):
                code = str(r[0]).strip()
                if CODE_RE.match(code):
                    try:
                        close_px = float(str(r[8]).replace(",", ""))
                    except (ValueError, IndexError):
                        close_px = 0.0
                    rows.append({"code": code, "name": str(r[1]).strip(),
                                 "amount": _num(r[4]), "close": close_px,
                                 "exchange": "TSE"})
    return rows


def fetch_tpex(d: date) -> list[dict]:
    ymd = d.strftime("%Y/%m/%d").replace("/", "%2F")
    url = ("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"
           f"?date={ymd}&id=&response=json")
    data = _get(url)
    rows = []
    for t in data.get("tables", []):
        if t.get("title") == "上櫃股票行情":
            for r in t.get("data", []):
                code = str(r[0]).strip()
                if CODE_RE.match(code):
                    try:
                        close_px = float(str(r[2]).replace(",", ""))
                    except (ValueError, IndexError):
                        close_px = 0.0
                    rows.append({"code": code, "name": str(r[1]).strip(),
                                 "amount": _num(r[9]), "close": close_px,
                                 "exchange": "OTC"})
    return rows


def latest_trading_day(d: date, max_back: int = 7) -> tuple[date, list[dict], list[dict]]:
    """Walk back from d until BOTH exchanges return data (skips weekends/holidays).
    A partial failure (one side empty) is treated as no-data, not success."""
    for _ in range(max_back):
        try:
            twse = fetch_twse(d)
        except Exception:
            twse = []
        try:
            tpex = fetch_tpex(d)
        except Exception:
            tpex = []
        if twse and tpex:
            return d, twse, tpex
        d -= timedelta(days=1)
    return d, [], []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYY-MM-DD (default: latest trading day)")
    ap.add_argument("--min-amount", type=int, default=0,
                    help="成交金額下限（元），0=不限（預設不限，改以 --top 控制）")
    ap.add_argument("--top", type=int, default=100,
                    help="取前 N 名（預設 100，全部主榜）")
    ap.add_argument("--primary", type=int, default=100,
                    help="主榜名額（預設 100，其餘為備選）")
    ap.add_argument("--print", dest="dump", action="store_true")
    args = ap.parse_args()

    if args.date:
        d = datetime.strptime(args.date, "%Y-%m-%d").date()
        twse, tpex = fetch_twse(d), fetch_tpex(d)
        day = d
    else:
        day, twse, tpex = latest_trading_day(date.today())

    if not twse and not tpex:
        print("error: no data from TWSE or TPEx", file=sys.stderr)
        return 1
    rows = [r for r in sorted(twse + tpex, key=lambda x: -x["amount"])
            if r["amount"] >= args.min_amount]
    if args.top > 0:
        rows = rows[: args.top]
    for i, r in enumerate(rows):
        r["rank"] = i + 1
        r["role"] = "primary" if i < args.primary else "alternate"
    out = {"date": day.isoformat(),
           "source": "TWSE MI_INDEX + TPEx dailyQuotes",
           "min_amount": args.min_amount,
           "primary": args.primary,
           "count": len(rows), "stocks": rows}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"hot-watchlist-{day.isoformat().replace('-', '')}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    n_tse = sum(1 for s in rows if s["exchange"] == "TSE")
    print(f"{day} top{len(rows)}: TSE={n_tse} OTC={len(rows)-n_tse} -> {path}")
    if args.dump:
        for i, s in enumerate(rows, 1):
            print(f"{i:>3} {s['code']} {s['name']:<12} {s['amount']:>15,} {s['exchange']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
