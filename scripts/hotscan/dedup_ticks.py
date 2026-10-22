"""Write a de-duplicated copy of logs/hot-ticks.jsonl. The source is never modified.

A row is a duplicate when another row already has the same
(code, dt to the microsecond, price, vol, tick_type). Two real prints of one
stock cannot share a microsecond timestamp, so this only drops re-written rows
(2026-10-21: the periodic backfill re-added ticks the live stream had already
logged — 1.3M of 11.5M rows). Rows without a microsecond `dt` (old format)
are kept as-is: without a precise time, identical rows can be genuine.

The file is appended day by day, so duplicates are tracked per day to keep
memory small.

Usage: python -m hotscan.dedup_ticks [SRC] [DST]
"""
import json
import sys
from collections import Counter
from pathlib import Path

from hotscan import config


def tick_key(rec: dict) -> tuple | None:
    dt = rec.get("dt") or ""
    if len(dt) <= 19:  # no microseconds → cannot tell a re-write from a real print
        return None
    return (rec.get("code"), dt, rec.get("price"), rec.get("vol"), rec.get("tick_type"))


def dedup(src: Path, dst: Path) -> dict[str, Counter]:
    stats: dict[str, Counter] = {}
    seen: set = set()
    cur_day = None
    with src.open(encoding="utf-8") as fin, dst.open("w", encoding="utf-8", newline="\n") as fout:
        for line in fin:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line)  # keep unparseable lines; not ours to judge
                continue
            key = tick_key(rec)
            day = key[1][:10] if key else "undated"
            st = stats.setdefault(day, Counter())
            st["rows"] += 1
            if key is not None:
                if day != cur_day:
                    seen.clear()
                    cur_day = day
                if key in seen:
                    st["dup"] += 1
                    st["dup_vol"] += rec.get("vol") or 0
                    continue
                seen.add(key)
            fout.write(line if line.endswith("\n") else line + "\n")
    return stats


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else config.LOG_DIR / "hot-ticks.jsonl"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name("hot-ticks.dedup.jsonl")
    if dst.resolve() == src.resolve():
        sys.exit("DST must differ from SRC")
    stats = dedup(src, dst)
    total = sum((c for c in stats.values()), Counter())
    for day in sorted(stats):
        c = stats[day]
        print(f"{day:10} rows {c['rows']:>9,}  dup {c['dup']:>8,}  dup_vol {c['dup_vol']:>9,}")
    print(f"TOTAL rows {total['rows']:,}  dup {total['dup']:,}  kept {total['rows'] - total['dup']:,}  -> {dst}")


if __name__ == "__main__":
    main()
