import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import guard_report as gr  # noqa: E402


def entry(symbol, opened, verdict, rules=()):
    return {"kind": "entry", "intent": {"symbol": symbol}, "positionOpenedAt": opened,
            "decision": {"verdict": verdict, "hits": [{"rule": r} for r in rules]}}


def outcome(symbol, opened, pnl):
    return {"kind": "outcome", "symbol": symbol, "openedAt": opened, "realizedPnl": pnl}


def test_join_sums_partials_and_skips_unmatched():
    rows = [
        entry("BTCUSD", "t1", "approve"),
        outcome("BTCUSD", "t1", 4.0),
        outcome("BTCUSD", "t1", 6.0),
        entry("ETHUSD", "t2", "veto", ["stop_required"]),
        entry("SOLUSD", None, "approve"),
        {"kind": "probe"},
    ]
    assert gr.join(rows) == [("approve", [], 10.0)]


def test_summarize_groups_by_verdict_and_rule():
    s = gr.summarize([("approve", [], 5.0), ("veto", ["stop_required"], -2.0), ("reduce", ["loss_streak"], 1.0)])
    assert s["approve"] == {"n": 1, "loss_rate": 0.0, "pnl": 5.0}
    assert s["flagged"] == {"n": 2, "loss_rate": 0.5, "pnl": -1.0}
    assert s["rule:stop_required"]["loss_rate"] == 1.0


def test_gate_needs_samples_and_a_worse_flagged_group():
    ready = [("approve", [], 1.0)] * 20 + [("veto", ["x"], -1.0)] * 10
    assert gr.gate(gr.summarize(ready)) is True
    assert gr.gate(gr.summarize(ready[1:])) is False


def test_load_reads_jsonl(tmp_path):
    p = tmp_path / "g.jsonl"
    p.write_text(json.dumps({"kind": "probe"}) + "\n\n" + json.dumps({"kind": "outcome"}) + "\n", encoding="utf-8")
    assert [r["kind"] for r in gr.load(p)] == ["probe", "outcome"]


def test_load_skips_malformed_lines(tmp_path):
    p = tmp_path / "g.jsonl"
    p.write_text('{"kind": "probe"}\n{"kind": broken\n{"kind": "outcome"}\n', encoding="utf-8")
    assert [r["kind"] for r in gr.load(p)] == ["probe", "outcome"]
