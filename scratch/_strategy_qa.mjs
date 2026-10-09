// strategy.* behavioral QA probe (Task 3 of 2026-10-09 backlog phase 2).
// Drives the real interpreter end-to-end: parse → runScript → read plots.
// Each probe prints {name, got, tv} so divergences are explicit.
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
const { runScript } = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));

const num = (v) => (v && (v.kind === 'int' || v.kind === 'float')) ? v.v : (v && v.kind === 'na' ? 'na' : `[${v?.kind}]`);
const series = (r, idx = 0) => [...r.plots.values()][idx].values.map(num);

// flat ramp bars: open=close=base+i, high=close+1, low=close-1
const mkBars = (n, base = 10) => Array.from({ length: n }, (_, i) => ({
  openTime: i * 60000, open: base + i, high: base + i + 1, low: base + i - 1, close: base + i, volume: 1000 + i,
}));

async function run(src, bars = mkBars(10)) {
  const r = await runScript(parse(src), bars, { symbol: 'TEST', timeframe: 'D' });
  return r;
}
const P = async (name, src, pick, tv, bars) => {
  try {
    const r = await run(src, bars);
    console.log(JSON.stringify({ name, got: pick(r), tv }));
  } catch (e) {
    console.log(JSON.stringify({ name, got: 'THREW: ' + (e && e.message), tv }));
  }
};

// ── P1: same-bar entry+exit ordering ─────────────────────────────────────────
// TV: both fill at next bar's open → entry then exit at same price → flat.
await P('P1 same-bar entry+exit', `strategy("s")
if bar_index == 1
    strategy.entry("L", strategy.long, qty=2)
    strategy.close("L")
plot(strategy.position_size)`, r => series(r), 'TV: [0,0,0,...] — both fill at bar2 open, net flat');

// ── P2: duplicate pending entry id → modifies in place (qty bumps 1→2) ───────
await P('P2 dup entry id modify', `strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=2)
plot(strategy.position_size)`, r => series(r), 'TV: bar2+ size=2 (pending order modified, qty=2 wins)');

// ── P2b: duplicate id, REVERSED direction while pending ──────────────────────
// TV doc: placing an order with an existing id modifies that order. Ours only
// modifies when p.dir === o.dir — a reversed dir creates a second pending order.
await P('P2b dup id reversed dir', `strategy("s")
if bar_index == 0
    strategy.entry("X", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("X", strategy.short, qty=1)
if bar_index == 2
    strategy.cancel_all()
plot(strategy.position_size)
plot(strategy.opentrades)`, r => [series(r, 0), series(r, 1)],
  'TV (modify): both cancel pending → flat, 0 trades. Ours (two pendings): long fills bar2, short fills bar3 → -1 pos');

// ── P3: strategy.close with a non-matching id ────────────────────────────────
await P('P3 close non-matching id', `strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close("NOPE")
plot(strategy.position_size)`, r => series(r), 'TV: close("NOPE") no open entry with that id → stays long 1');

// ── P4: strategy.close partial qty ───────────────────────────────────────────
await P('P4 close qty=1 of 2', `strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 2
    strategy.close("L", qty=1)
plot(strategy.position_size)`, r => series(r), 'TV: partial close leaves +1');

// ── P4b: strategy.close qty_percent=50 ───────────────────────────────────────
await P('P4b close qty_percent=50', `strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 2
    strategy.close("L", qty_percent=50)
plot(strategy.position_size)`, r => series(r), 'TV: 50% close leaves +1');

// ── P5: strategy.exit from_entry gates on open entry id ──────────────────────
await P('P5 exit from_entry nonmatch', `strategy("s", pyramiding=2)
if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long)
if bar_index == 3
    strategy.exit("X", from_entry="NOPE")
plot(strategy.position_size)`, r => series(r), 'TV: exit bound to nonexistent entry → no fill, stays +2');

// ── P6: closedtrades trade_num direction (0 = first or last closed?) ─────────
await P('P6 closedtrades ordering', `strategy("s")
if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 2
    strategy.close("A")
if bar_index == 4
    strategy.entry("B", strategy.long)
if bar_index == 6
    strategy.close("B")
plot(strategy.closedtrades.entry_price(0))
plot(strategy.closedtrades.entry_price(1))`, r => [series(r, 0), series(r, 1)],
  'TV: trade_num 0 = FIRST closed trade → entry_price(0)=11 (A filled bar1 open 11), (1)=15 (B)');

// ── P7: strategy.opentrades after a partial exit (pyramiding legs) ───────────
await P('P7 opentrades after partial exit', `strategy("s", pyramiding=2)
if bar_index == 0
    strategy.entry("A", strategy.long)
if bar_index == 1
    strategy.entry("B", strategy.long)
if bar_index == 3
    strategy.close("A")
plot(strategy.opentrades)
plot(strategy.position_size)`, r => [series(r, 0), series(r, 1)],
  'TV: close(A) retires leg A → opentrades 2→1, position_size 2→1');

// ── P8: equity vs hand-computed 3-trade case ─────────────────────────────────
// bars base 10: opens 10..19. Entries: L@bar0 (fill 11), exit L@bar2 (fill 13 → +2),
// S@bar4 (fill 15), close S@bar6 (fill 17 → -2). net realized = 0.
await P('P8 equity 3-leg', `strategy("s")
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close("L")
if bar_index == 4
    strategy.entry("S", strategy.short)
if bar_index == 6
    strategy.close("S")
plot(strategy.equity - 100000)
plot(strategy.closedtrades.profit(0))
plot(strategy.closedtrades.profit(1))`, r => [series(r, 0), series(r, 1), series(r, 2)],
  'TV: net=0; if closedtrades(0)=first → profits (-2, +2); if 0=last → (+2, -2)');

// ── P9: decl args parse (calc_on_*, slippage, margin) — parse acceptance only ─
await P('P9 decl args parse', `//@version=5
strategy("s", overlay=true, initial_capital=5000, default_qty_type=strategy.percent_of_equity,
  default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.1,
  slippage=2, margin_long=50, margin_short=50, calc_on_order_fills=true,
  calc_on_every_tick=true, process_orders_on_close=true, pyramiding=1,
  backtest_fill_limits_assumption=5, risk_free_rate=2, use_bar_magnifier=true,
  close_entries_rule="ANY", max_lines_count=20)
plot(strategy.equity)`, r => series(r).slice(-1), 'parses; process_orders_on_close honored, calc_on_* documented-ignored');

// ── P10: missing family — strategy.risk.* ────────────────────────────────────
await P('P10 risk.allow_entry_in', `strategy("s")
strategy.risk.allow_entry_in(strategy.direction.long)
plot(1)`, r => r.warnings.slice(0, 3), 'TV: exists — should be callable; expect "not a function"/unknown-symbol error');

// ── P11: OCA groups ──────────────────────────────────────────────────────────
await P('P11 OCA cancel', `strategy("s")
if bar_index == 0
    strategy.order("A", strategy.long, qty=1, limit=8, oca_name="g", oca_type=strategy.oca.cancel)
    strategy.order("B", strategy.long, qty=1, limit=9, oca_name="g", oca_type=strategy.oca.cancel)
plot(strategy.position_size)`, r => series(r),
  'TV: bar1 dips: B(limit9) fills at min(9, open11)=9 first, then A cancelled → +1 not +2',
  // craft bars: bar1 opens 11? lows must touch. open=close=i+10, low=close-1=9+i
  // bar1 low=10 ≥ 9 → no fill... adjust: custom bars
  [
    { openTime: 0, open: 10, high: 12, low: 9, close: 10, volume: 1 },
    { openTime: 60000, open: 10, high: 12, low: 8, close: 10, volume: 1 },
    { openTime: 120000, open: 10, high: 12, low: 9, close: 10, volume: 1 },
    { openTime: 180000, open: 10, high: 12, low: 9, close: 10, volume: 1 },
    { openTime: 240000, open: 10, high: 12, low: 9, close: 10, volume: 1 },
  ]);

// ── P12: position_avg_price after partial FIFO exit ──────────────────────────
// TV: position_avg_price = avg entry of remaining open trades.
// L(qty2) fills @11 (avg 11); L2(qty2) @13 (avg 12); exit 2 (qty=2) FIFO-closes
// leg L → remaining leg L2 at 13 → TV avg should be 13, ours stays 12.
await P('P12 avg after partial exit', `strategy("s", pyramiding=2)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=2)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=2)
if bar_index == 3
    strategy.exit("X", from_entry="A", qty=2)
plot(strategy.position_avg_price)
plot(strategy.position_size)`, r => [series(r, 0), series(r, 1)],
  'TV: after leg-A exit, remaining leg B at 13 → avg_price 13, size +2');

// ── P13: missing constants inventory ────────────────────────────────────────
const { getConstant } = await import(pathToFileURL(repo + '/src/pine/builtins/registry.ts'));
const { BUILTINS } = await import(pathToFileURL(repo + '/src/pine/builtins/registry.ts'));
const V5_STRATEGY = [
  // functions
  'strategy.entry', 'strategy.order', 'strategy.exit', 'strategy.close', 'strategy.close_all',
  'strategy.cancel', 'strategy.cancel_all', 'strategy.convert_to_account', 'strategy.convert_to_symbol',
  'strategy.risk.allow_entry_in', 'strategy.risk.max_cons_loss_days', 'strategy.risk.max_drawdown',
  'strategy.risk.max_intraday_filled_orders', 'strategy.risk.max_intraday_loss', 'strategy.risk.max_position_size',
  // variables
  'strategy.initial_capital', 'strategy.equity', 'strategy.opentrades', 'strategy.opentrades.commission',
  'strategy.opentrades.entry_bar_index', 'strategy.opentrades.entry_comment', 'strategy.opentrades.entry_id',
  'strategy.opentrades.entry_price', 'strategy.opentrades.entry_time', 'strategy.opentrades.max_drawdown',
  'strategy.opentrades.max_drawdown_percent', 'strategy.opentrades.max_runup', 'strategy.opentrades.max_runup_percent',
  'strategy.opentrades.profit', 'strategy.opentrades.profit_percent', 'strategy.opentrades.size',
  'strategy.closedtrades', 'strategy.closedtrades.commission', 'strategy.closedtrades.entry_bar_index',
  'strategy.closedtrades.entry_comment', 'strategy.closedtrades.entry_id', 'strategy.closedtrades.entry_price',
  'strategy.closedtrades.entry_time', 'strategy.closedtrades.exit_bar_index', 'strategy.closedtrades.exit_comment',
  'strategy.closedtrades.exit_id', 'strategy.closedtrades.exit_price', 'strategy.closedtrades.exit_time',
  'strategy.closedtrades.max_drawdown', 'strategy.closedtrades.max_drawdown_percent', 'strategy.closedtrades.max_runup',
  'strategy.closedtrades.max_runup_percent', 'strategy.closedtrades.profit', 'strategy.closedtrades.profit_percent',
  'strategy.closedtrades.size', 'strategy.eventrades', 'strategy.eventrades.size',
  'strategy.grossloss', 'strategy.grossloss_percent', 'strategy.grossprofit', 'strategy.grossprofit_percent',
  'strategy.losstrades', 'strategy.margin_liquidation_price', 'strategy.max_drawdown', 'strategy.max_drawdown_percent',
  'strategy.max_runup', 'strategy.max_runup_percent', 'strategy.netprofit', 'strategy.netprofit_percent',
  'strategy.openprofit', 'strategy.openprofit_percent', 'strategy.position_avg_price', 'strategy.position_size',
  'strategy.wintrades',
];
const missing = V5_STRATEGY.filter(k => !BUILTINS.has(k) && getConstant(k) === undefined);
const present = V5_STRATEGY.filter(k => BUILTINS.has(k) || getConstant(k) !== undefined);
console.log(JSON.stringify({ name: 'P13 inventory', present: present.length, missing }, null, 1));
