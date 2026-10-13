// ── Unknown named arguments are surfaced, never silently dropped ────────────
// TV rejects an unknown named argument at compile time ("Unknown argument").
// This engine has no signature table at parse time, so both bind paths name the
// argument at runtime and continue — hard-erroring would break scripts that run
// today. Two silent paths existed (both measured, both fixed here):
//
//   builtins   `bindArgs` (builtins/util.ts) — an unknown key landed in the Map
//              under a name nobody reads, so the slot stayed undefined/NA. This
//              is what made R20's MZigZag return all-na: `array.unshift(a,
//              value=v)` hit an internal slot named 'val'.
//   UDF calls  `bindCallArgs` (interpreter.ts) — the arg was pushed onto the
//              positionals list and bound to the next free slot, so
//              `f(bogus=3)` silently wrote 3 into parameter 0.

import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';
import { mkBars } from './golden';

const BARS = mkBars(3);
const OPTS = { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] } as const;
const run = (body: string): Promise<RunResult> =>
  runScript(parse(`indicator("t")\n${body}`), BARS, OPTS);
/** Full-source variant (a case that brings its own declaration). */
const runSrc = (src: string): Promise<RunResult> => runScript(parse(src), BARS, OPTS);

/** First plot's per-bar numeric values ('na' for anything non-numeric). */
function plotNums(r: RunResult): unknown[] {
  const plot = r.plots.get('plot_0') ?? r.plots.values().next().value;
  return (plot?.values ?? []).map(v => (v.kind === 'int' || v.kind === 'float' ? v.v : 'na'));
}
const unknown = (r: RunResult) => r.warnings.filter(w => w.startsWith('unknown named argument'));
const ofKind = (r: RunResult, kind: string) => r.drawings.filter(d => d.kind === kind);

describe('unknown named arguments', () => {
  it('a builtin warns and names both the argument and the real signature', async () => {
    const r = await run(`a = array.new_int(0)
array.push(a, bogus=1)
plot(array.get(a, 0))`);
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain("'bogus='");
    expect(unknown(r)[0]).toContain('(id, value)');
    // The behaviour change is the warning, not the value: the slot stays unbound.
    expect(plotNums(r)).toEqual(['na', 'na', 'na']);
  });

  it('a ta.* call warns too', async () => {
    const r = await run('plot(ta.sma(close, 5, bogus=1))');
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain('(source, length)');
  });

  it('the reference name for a slot binds (R20 guard: array.unshift value=)', async () => {
    const r = await run(`a = array.new_int(0)
array.unshift(a, value=7)
plot(array.get(a, 0))`);
    expect(unknown(r)).toEqual([]);
    expect(plotNums(r)).toEqual([7, 7, 7]);
  });

  it('the series→source alias still binds (no false positive)', async () => {
    const r = await run('plot(ta.sma(series=close, 2))');
    expect(unknown(r)).toEqual([]);
    const vals = plotNums(r);
    expect(vals[0]).toBe('na');            // window not full on bar 0
    expect(vals.slice(1).every(v => typeof v === 'number')).toBe(true);
  });

  it('a UDF call warns and does not write the parameter', async () => {
    const r = await run(`f(a) =>
    a
plot(f(bogus=3))`);
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain('(a)');
    expect(plotNums(r)).toEqual(['na', 'na', 'na']);
  });

  it('a duplicated UDF argument warns and keeps the first binding', async () => {
    const r = await run(`f(a) =>
    a
plot(f(a=3, a=9))`);
    expect(r.warnings.filter(w => w.startsWith('duplicate named argument'))).toHaveLength(1);
    expect(plotNums(r)).toEqual([3, 3, 3]);
  });

  it('an indicator()/strategy() declaration warns on a parameter it does not take', async () => {
    const r = await runSrc('indicator("t", bogus=1)\nplot(close)');
    expect(unknown(r)).toHaveLength(1);
    expect(unknown(r)[0]).toContain("'bogus='");
    expect(unknown(r)[0]).toContain('(title, shorttitle, overlay');
    // The declaration itself still runs (overlay/title unaffected by the drop).
    expect(r.plots.size).toBeGreaterThan(0);
  });

  it('request.security separates TV parameters we do not implement from unknown names', async () => {
    // TV: (symbol, timeframe, expression, gaps, lookahead, ignore_invalid_symbol,
    // currency, calc_bars_count). The first five are read; currency/… are TV's
    // but unimplemented → a named call must say which, not "unknown".
    const declared = await runSrc('plot(request.security("X", "D", close, currency = "USD") ? 1 : 0)');
    expect(declared.warnings.some(w => w.includes("'currency' declared but not implemented"))).toBe(true);
    expect(unknown(declared)).toEqual([]);

    // security_lower_tf takes ignore_invalid_timeframe/calc_bars_count instead
    // of gaps/lookahead — same two-way split on its own list.
    const ltf = await runSrc(
      'plot(array.size(request.security_lower_tf("X", "5", close, ignore_invalid_timeframe = true)) ? 1 : 0)');
    expect(ltf.warnings.some(w => w.includes("'ignore_invalid_timeframe' declared but not implemented"))).toBe(true);
    expect(unknown(ltf)).toEqual([]);

    // `adjustment`/`backadjustment`/`settlement_as_close` belong to
    // ticker.new/ticker.modify — request.security does not take them, so TV
    // rejects them and so does this guard.
    const bogus = await runSrc('plot(request.security("X", "D", close, adjustment = 1) ? 1 : 0)');
    expect(unknown(bogus)).toHaveLength(1);
    expect(unknown(bogus)[0]).toContain("'adjustment='");
    expect(unknown(bogus)[0]).toContain(
      '(symbol, timeframe, expression, gaps, lookahead, ignore_invalid_symbol, currency, calc_bars_count)');
  });

  it("drawing setters bind TV's `id=` spelling exactly like the positional form", async () => {
    // Regression guard: these setters used to declare the object slot under an
    // internal name (the drawing kind), so `id=` was dropped (and warned) even
    // though TV documents `id` (KB: line.set_color(id, color)).
    const src = (call: string): string => `l = line.new(bar_index, close, bar_index + 1, close + 1)
${call}
plot(na)`;
    const named = await run(src('line.set_color(id = l, color = color.red)'));
    const positional = await run(src('line.set_color(l, color.red)'));
    expect(unknown(named)).toEqual([]);
    // Pin the resulting value, not just "both spellings agree": two no-ops
    // compare equal, and a silent no-op is exactly what this guards. The body
    // runs once per bar, so every bar has its own line.
    expect(ofKind(named, 'line')).toHaveLength(3);
    expect(ofKind(named, 'line').every(d => d.props.color === '#FF0000')).toBe(true);
    expect(ofKind(positional, 'line').map(d => d.props.color))
      .toEqual(ofKind(named, 'line').map(d => d.props.color));
  });

  it('a declaration that binds the same parameter twice warns and keeps the first', async () => {
    const r = await runSrc('indicator("t", overlay = true, overlay = false)\nplot(close)');
    expect(r.warnings.filter(w => w.startsWith('duplicate named argument'))).toHaveLength(1);
    expect(unknown(r)).toEqual([]);
  });

  it('a declaration warning lands on its own run and does not leak to the next', async () => {
    // The decl is bound at run init, before any builtin call can drain the bind
    // queue, so a body with no builtin call must still report it — and the
    // script that runs afterwards must not inherit it.
    const first = await runSrc('indicator("t", bogus=1)');
    expect(unknown(first)).toHaveLength(1);
    const second = await runSrc('indicator("t")\nplot(close)');
    expect(unknown(second)).toEqual([]);
  });

  it("indicator() binds its v6 parameters instead of calling them unknown", async () => {
    const r = await runSrc(
      'indicator("t", timeframe = "240", timeframe_gaps = true, calc_bars_count = 1000, dynamic_requests = true, behind_chart = true)\nplot(close)');
    expect(unknown(r)).toEqual([]);
    // The ones this run cannot honour are named as such, not silently dropped.
    expect(r.warnings.some(w => w.includes('declared but not implemented'))).toBe(true);
  });

  it("the generated drawing getters bind TV's `id=` spelling too", async () => {
    const r = await run(`l = line.new(bar_index, close, bar_index + 1, close + 1)
line.set_color(id = l, color = color.red)
plot(na(line.get_color(id = l)) ? 0 : 1)`);
    expect(unknown(r)).toEqual([]);
    expect(plotNums(r)).toEqual([1, 1, 1]);
  });
});
