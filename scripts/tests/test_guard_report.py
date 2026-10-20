import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import guard_report as gr  # noqa: E402


def entry(symbol, opened, verdict, rules=(), mode="shadow"):
    return {"kind": "entry", "mode": mode, "intent": {"symbol": symbol}, "positionOpenedAt": opened,
            "decision": {"verdict": verdict, "hits": [{"rule": r} for r in rules]}}


def outcome(symbol, opened, pnl, mode="shadow"):
    return {"kind": "outcome", "mode": mode, "symbol": symbol, "openedAt": opened, "realizedPnl": pnl}


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


def test_load_returns_nothing_when_the_log_does_not_exist(tmp_path):
    # The user runs the report by hand, often before the first order exists.
    assert gr.load(tmp_path / "missing.jsonl") == []


def test_load_skips_malformed_lines(tmp_path):
    p = tmp_path / "g.jsonl"
    p.write_text('{"kind": "probe"}\n{"kind": broken\n{"kind": "outcome"}\n', encoding="utf-8")
    assert [r["kind"] for r in gr.load(p)] == ["probe", "outcome"]


def test_join_skips_enforce_mode_rows():
    # In enforce mode a vetoed order never trades and a reduced one trades at a
    # size the guard chose: neither is a fair comparison against an approved trade.
    rows = [
        entry("BTCUSD", "t1", "approve"),
        outcome("BTCUSD", "t1", 4.0),
        entry("ETHUSD", "t2", "reduce", ["loss_streak"], mode="enforce"),
        outcome("ETHUSD", "t2", -6.0, mode="enforce"),
    ]
    assert gr.join(rows) == [("approve", [], 4.0)]


def test_join_skips_entry_rows_without_intent_or_decision():
    # The dev middleware writes whatever JSON object it is given, so a stray
    # "kind":"entry" line can land in the log without the guard's fields.
    rows = [
        {"kind": "entry", "mode": "shadow", "positionOpenedAt": "t1"},
        {"kind": "entry", "mode": "shadow", "intent": {}, "positionOpenedAt": "t2"},
        {"kind": "entry", "mode": "shadow", "intent": {"symbol": "BTCUSD"},
         "positionOpenedAt": "t3", "decision": {}},
        entry("BTCUSD", "t4", "approve"),
        outcome("BTCUSD", "t4", 3.0),
    ]
    assert gr.join(rows) == [("approve", [], 3.0)]


def test_summarize_survives_a_hit_without_a_rule_name():
    # A hit without "rule" must not become a group key: "rule:" + None is a TypeError.
    s = gr.summarize([("veto", [], -5.0)])
    assert s["flagged"] == {"n": 1, "loss_rate": 1.0, "pnl": -5.0}
    assert "rule:None" not in s


def test_join_survives_hits_that_are_not_objects():
    # The middleware writes whatever it is given, so a hit can be a string.
    rows = [
        {"kind": "entry", "mode": "shadow", "intent": {"symbol": "BTCUSD"},
         "positionOpenedAt": "t1",
         "decision": {"verdict": "veto", "hits": ["stop_required", {"verdict": "veto"}]}},
        outcome("BTCUSD", "t1", -4.0),
    ]
    assert gr.join(rows) == [("veto", [], -4.0)]
