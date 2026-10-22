"""Offline re-computation of the risk-gate fields of logs/jev-shadow-mxf.jsonl (F1b).

The live collector now keeps the risk counters per TRADING DAY (night 15:00 + next day session,
same as orderGuard.ts tradingDay()). Rows written before that rule (or decided out of order while
a backlog was being filled) carry risk fields computed with other counters. This script replays
the rows in bar-time order through the current RiskSession / risk_key and rewrites ONLY:
    risk_gate.verdict / lots_mult / reason / rule / prev_outcome
It calls no /decide and no DeepSeek: the JEV answers and prices already in each row are the inputs.
The `deepseek` field is an external result and is copied unchanged (the counters never read it).

Usage:
  python scripts/jev-risk-recompute.py [--in FILE] [--out FILE]     # writes FILE.recomputed.jsonl, prints a diff summary
The original file is never modified here; replacing it is a separate, backed-up step.
"""
import argparse
import importlib.util
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("jev_shadow_rc", HERE / "jev-shadow.py")
js = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(js)

FIELDS = ("verdict", "lots_mult", "reason", "rule", "prev_outcome")


def recompute(rows: list[dict]) -> list[dict]:
    """Rows with a risk_gate are replayed in bar-time order; others are passed through."""
    gated = sorted((r for r in rows if r.get("risk_gate") is not None and r.get("answers")),
                   key=lambda r: r["bar_time"])
    new_gate: dict[int, dict] = {}
    sess, key = None, None
    for r in gated:
        bar = {"time": r["bar_time"], "close": r["price"]}
        sess, key = js.rotate_risk_session(sess, key, bar["time"])
        prev = sess._close_open_position(bar)
        verdict, lots_mult, reason, rule = sess.gate(bar, {"answers": r["answers"]})
        choice = (r["answers"].get("action_choice") or {}).get("choice")
        if verdict in ("approve", "reduce") and choice in ("buy", "sell"):
            sess.follow_count_today += 1
            sess.open_entry, sess.open_direction = bar["close"], choice
            sess.open_ts, sess.open_lots, sess.open_rule = bar["time"], lots_mult, rule
        new_gate[r["bar_time"]] = {"verdict": verdict, "lots_mult": lots_mult, "reason": reason,
                                   "rule": rule, "prev_outcome": prev}
    out = []
    for r in rows:
        g = new_gate.get(r["bar_time"]) if r.get("risk_gate") is not None and r.get("answers") else None
        if g is None:
            out.append(r)
            continue
        merged = dict(r)
        merged["risk_gate"] = {**r["risk_gate"], **g}
        out.append(merged)
    return out


def diff_summary(old: list[dict], new: list[dict]) -> dict:
    changed, by_field, by_group, examples = 0, Counter(), Counter(), []
    for a, b in zip(old, new):
        ga, gb = a.get("risk_gate") or {}, b.get("risk_gate") or {}
        fields = [f for f in FIELDS if ga.get(f) != gb.get(f)]
        if not fields:
            continue
        changed += 1
        by_field.update(fields)
        t = datetime.fromtimestamp(a["bar_time"], js.TAIPEI)
        group = (a.get("session") or js.session_label(a["bar_time"])) + (" (new run)" if a.get("session") else " (old run)")
        by_group[group] += 1
        if len(examples) < 8:
            examples.append((f"{t:%m-%d %H:%M}", [(f, ga.get(f), gb.get(f)) for f in fields if f != "prev_outcome"]))
    return {"rows": len(old), "gated": sum(1 for r in old if r.get("risk_gate") is not None),
            "changed": changed, "by_field": dict(by_field), "by_group": dict(by_group), "examples": examples}


def load(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default=str(js.LOG_MXF))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    src = Path(a.src)
    dst = Path(a.out) if a.out else src.with_suffix(".recomputed.jsonl")
    old = load(src)
    new = recompute(old)
    dst.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in new), encoding="utf-8")
    s = diff_summary(old, new)
    print(f"read {s['rows']} rows ({s['gated']} with risk_gate) from {src.name}; wrote {dst}")
    print(f"rows whose risk fields differ: {s['changed']}")
    print(f"  by field: {s['by_field']}")
    print(f"  by group: {s['by_group']}")
    for when, fs in s["examples"]:
        print(f"  {when}: {fs}")
    print("original NOT modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
