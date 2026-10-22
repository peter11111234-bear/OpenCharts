"""Independently verify a de-duplicated tick log against its source (read-only).

Checks, each by a different route than dedup_ticks.py itself:
  1. only-removes: DST is SRC with some lines removed — every DST line is
     byte-identical to the next unconsumed SRC line, order preserved.
  2. removed-are-duplicates: each removed SRC line has the same
     (code, dt, price, vol, tick_type) as a line already kept that day.
  3. clean: DST has no duplicate key left.
  4. counts: DST lines == SRC lines - removed; undated rows all kept.
  5. exchange: per (day, code) sum(vol) / last total_volume. De-duplication
     must move it toward 1 and never pull a stock below its pre-dedup level
     when that level was already <= 1 (that would mean real prints were cut).

Exit 1 if any of 1–4 fails. 5 is reported for review.
Usage: python -m hotscan.verify_dedup [SRC] [DST]
"""
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from hotscan import config


def key_of(line: str):
    try:
        r = json.loads(line)
    except json.JSONDecodeError:
        return None, None
    dt = r.get("dt") or ""
    if len(dt) <= 19:
        return None, r
    return (r.get("code"), dt, r.get("price"), r.get("vol"), r.get("tick_type")), r


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else config.LOG_DIR / "hot-ticks.jsonl"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name("hot-ticks.dedup.jsonl")
    fails: list[str] = []
    n_src = n_dst = removed = undated_src = undated_dst = 0
    kept_today: set = set()
    day_now = None
    vol_src: dict = defaultdict(int)
    vol_dst: dict = defaultdict(int)
    tv_last: dict = {}

    with src.open(encoding="utf-8") as fs, dst.open(encoding="utf-8") as fd:
        want = fd.readline()
        for line in fs:
            n_src += 1
            key, rec = key_of(line)
            day = key[1][:10] if key else None
            if day and day != day_now:
                kept_today.clear()
                day_now = day
            if key is None:
                undated_src += 1
            if rec is not None and day:
                code = rec.get("code")
                vol_src[(day, code)] += rec.get("vol") or 0
                if rec.get("total_volume") is not None:
                    tv_last[(day, code)] = max(tv_last.get((day, code), 0), int(rec["total_volume"]))
            if want and line.rstrip("\n") == want.rstrip("\n"):        # kept
                n_dst += 1
                if key is None:
                    undated_dst += 1
                else:
                    if key in kept_today:
                        fails.append(f"3 clean: duplicate left in DST at SRC line {n_src}")
                    kept_today.add(key)
                    vol_dst[(day, rec.get("code"))] += rec.get("vol") or 0
                want = fd.readline()
            else:                                                       # removed
                removed += 1
                if key is None or key not in kept_today:
                    fails.append(f"2 removed-are-duplicates: SRC line {n_src} removed but no earlier kept twin")
            if len(fails) > 20:
                break
        if want:
            fails.append("1 only-removes: DST has lines that are not in SRC (or out of order)")
        if fd.readline():
            fails.append("1 only-removes: DST longer than SRC walk")

    if n_dst != n_src - removed:
        fails.append(f"4 counts: dst {n_dst} != src {n_src} - removed {removed}")
    if undated_dst != undated_src:
        fails.append(f"4 counts: undated rows {undated_src} -> {undated_dst}")

    print(f"SRC {n_src:,} lines | DST {n_dst:,} | removed {removed:,} | undated kept {undated_dst:,}/{undated_src:,}")
    ratios_src, ratios_dst, cut_too_far = [], [], []
    for k, tv in tv_last.items():
        if tv <= 0:
            continue
        rs, rd = vol_src[k] / tv, vol_dst[k] / tv
        ratios_src.append(rs)
        ratios_dst.append(rd)
        if rs <= 1.0 and rd < rs - 1e-9:
            cut_too_far.append((k, round(rs, 3), round(rd, 3)))
    if ratios_src:
        over = lambda xs: sum(1 for x in xs if x > 1.05)
        print(f"5 exchange (sum vol / total_volume) over {len(ratios_src):,} stock-days: "
              f"median {statistics.median(ratios_src):.3f} -> {statistics.median(ratios_dst):.3f}; "
              f">1.05: {over(ratios_src):,} -> {over(ratios_dst):,}; cut below an already-<=1 level: {len(cut_too_far)}")
        for c in cut_too_far[:5]:
            print("   cut", c)
    for f in fails[:20]:
        print("FAIL", f)
    print("RESULT", "PASS" if not fails else f"FAIL ({len(fails)})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
