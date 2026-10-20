"""Order guard report: does a flagged entry lose more often than an approved one?

Reads logs/order-guard.jsonl (written by the vite dev middleware), joins each
entry decision to its closed trade(s) by (symbol, positionOpenedAt == openedAt),
and prints loss rate and P&L per verdict group and per rule. Read-only.

"flagged" = verdict reduce or veto. Only shadow-mode rows give a fair
comparison: in enforce mode a vetoed order never trades, so it never joins.

Run: python scripts/guard_report.py [path/to/order-guard.jsonl]
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_LOG = Path(__file__).resolve().parent.parent / "logs" / "order-guard.jsonl"
MIN_APPROVED = 20  # Phase 2 gate: minimum joined trades per group
MIN_FLAGGED = 10


def load(path):
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def join(rows):
    """Return [(verdict, rules, pnl)] for entries that have at least one outcome.

    Only shadow-mode rows join: in enforce mode a vetoed order never trades,
    and a reduced one trades at a size the guard itself chose, so neither is a
    fair comparison against an approved trade.
    """
    pnl = defaultdict(float)
    for r in rows:
        if r.get("kind") == "outcome":
            pnl[(r["symbol"], r["openedAt"])] += r["realizedPnl"]
    out = []
    for r in rows:
        if r.get("kind") != "entry" or not r.get("positionOpenedAt"):
            continue
        if r.get("mode") != "shadow":
            continue
        intent = r.get("intent") or {}
        decision = r.get("decision") or {}
        symbol = intent.get("symbol")
        if not symbol or "verdict" not in decision:
            continue
        key = (symbol, r["positionOpenedAt"])
        if key in pnl:
            out.append((decision["verdict"],
                        [h.get("rule") for h in decision.get("hits") or []],
                        pnl[key]))
    return out


def summarize(trades):
    groups = defaultdict(list)
    for verdict, rules, p in trades:
        groups["approve" if verdict == "approve" else "flagged"].append(p)
        for rule in rules:
            groups["rule:" + rule].append(p)
    return {
        g: {"n": len(ps), "loss_rate": round(sum(1 for p in ps if p < 0) / len(ps), 3), "pnl": round(sum(ps), 2)}
        for g, ps in groups.items()
    }


def gate(summary):
    a = summary.get("approve")
    f = summary.get("flagged")
    if not a or not f:
        return False
    return a["n"] >= MIN_APPROVED and f["n"] >= MIN_FLAGGED and f["loss_rate"] > a["loss_rate"]


def main(argv):
    path = argv[1] if len(argv) > 1 else DEFAULT_LOG
    summary = summarize(join(load(path)))
    for g in sorted(summary):
        s = summary[g]
        print(f"{g:24} n={s['n']:4} loss_rate={s['loss_rate']:.3f} pnl={s['pnl']}")
    print("PHASE2_GATE:", "READY" if gate(summary) else "NOT_READY")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
