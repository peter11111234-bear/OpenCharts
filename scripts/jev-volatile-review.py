"""Once 20 trading days are logged under the volatile half-size rule, compare
volatile trades with normal ones and tell the user, once.

Run daily after the close by the Windows task "JEV-Volatile-Review". It stays
silent until enough days exist, then writes logs/jev-volatile-review.md,
appends to logs/watchdog-alerts.log, beeps and shows a message box. A marker
file stops it from alerting twice. --force prints the report at any time.

Run: python scripts/jev-volatile-review.py [--force]
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAIPEI = timezone(timedelta(hours=8))
LOGS = Path(__file__).resolve().parent.parent / "logs"
# jev-shadow follows MXF since 2026-10-21 (own file); TXF file until the first MXF bar lands.
DATA = LOGS / "jev-shadow-mxf.jsonl"
if not DATA.exists():
    DATA = LOGS / "jev-shadow.jsonl"
REPORT = LOGS / "jev-volatile-review.md"
ALERTS = LOGS / "watchdog-alerts.log"
DONE = LOGS / ".jev-volatile-review-done"
# The volatile rule (P60, half size, followed) went live with the collector
# restart on this morning.
RULE_START = datetime(2026, 10, 21, 7, 0, tzinfo=TAIPEI).timestamp()
MIN_DAYS = 20


def trading_day(epoch):
    """Night session (15:00 onward) belongs to the next day's session."""
    return (datetime.fromtimestamp(epoch, TAIPEI) + timedelta(hours=9)).date()


def load(path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(r.get("bar_time"), (int, float)) and r["bar_time"] >= RULE_START:
            rows.append(r)
    return rows


def summarize(rows):
    groups = defaultdict(list)
    for r in rows:
        out = (r.get("risk_gate") or {}).get("prev_outcome")
        if isinstance(out, dict) and "pnl_points" in out:
            groups["volatile" if out.get("rule") == "volatile" else "normal"].append(out)
    stats = {}
    for name, outs in groups.items():
        pnl = [o["pnl_points"] for o in outs]
        stats[name] = {
            "n": len(pnl),
            "win_rate": sum(p > 0 for p in pnl) / len(pnl),
            "avg_points": sum(pnl) / len(pnl),
            "sized_points": sum(o["pnl_points"] * o.get("lots", 1.0) for o in outs),
        }
    return stats


def render(days, stats):
    lines = [f"# JEV 高波動規則檢討（{datetime.now(TAIPEI):%Y-%m-%d}）", "",
             f"規則上線（2026-10-21）後已收 {days} 個交易日。", "",
             "| 組別 | 交易數 | 勝率 | 每筆平均（點，一口計） | 實際加總（點，含減半） |",
             "|---|---|---|---|---|"]
    for name, label in (("volatile", "高波動（減半跟）"), ("normal", "正常")):
        s = stats.get(name)
        if s:
            lines.append(f"| {label} | {s['n']} | {s['win_rate']:.0%} | {s['avg_points']:.1f} | {s['sized_points']:.0f} |")
        else:
            lines.append(f"| {label} | 0 | – | – | – |")
    lines += ["", "下一步：請 Claude 讀這份報告，決定 P60 門檻與減半要不要調整（myopenchart skill 待做清單）。"]
    return "\n".join(lines) + "\n"


def alert(text):
    with ALERTS.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now(TAIPEI):%Y-%m-%d %H:%M:%S} | JEV 高波動規則 — {text}\n")
    try:
        import ctypes
        import winsound
        winsound.MessageBeep()
        ctypes.windll.user32.MessageBoxW(None, text, "JEV 高波動規則：該檢討了", 0x40)
    except (ImportError, AttributeError, OSError):
        pass


def main(argv):
    force = "--force" in argv
    if DONE.exists() and not force:
        return 0
    rows = load(DATA)
    days = len({trading_day(r["bar_time"]) for r in rows})
    if days < MIN_DAYS and not force:
        return 0
    report = render(days, summarize(rows))
    if force:
        print(report)
        return 0
    REPORT.write_text(report, encoding="utf-8")
    alert(f"已收滿 {days} 個交易日，報告在 {REPORT}")
    DONE.write_text(datetime.now(TAIPEI).isoformat(), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
