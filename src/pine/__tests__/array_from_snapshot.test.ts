// B3 repro: `array.from(<series>)` MUST snapshot the element values current at
// the call (TV semantics, same as array.push/set/insert — see array.ts `snap`).
// Before the fix the stored element aliased the live series handle, so reading
// it back on a LATER bar returned that later bar's value.
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';

const bars = Array.from({ length: 5 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 60_000,
  open: i, high: i + 1, low: i - 1, close: 100 + i, volume: 1,
}));

const num = (v: unknown): unknown =>
  v && typeof v === 'object' && 'v' in v ? v.v : v;

describe('array.from snapshot semantics (B3)', () => {
  it('element stashed on bar 2 must not follow `close` on later bars', async () => {
    const src = `//@version=6
indicator("t")
mk() => array.from(close)
var a = mk()
if bar_index == 2
    a := mk()
plot(array.get(a, 0), "e0")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const e0 = [...r.plots.values()][0]!;
    expect(num(e0.values[2])).toBe(102);
    expect(num(e0.values[3])).toBe(102); // LIVE bug ⇒ 103
    expect(num(e0.values[4])).toBe(102); // LIVE bug ⇒ 104
  });

  // Same-file live control (no counterfactual fallback needed): the SOURCE
  // `close` genuinely advances on later bars, while the element captured by
  // `array.from(close)` on bar 2 does not follow it. Together the two plots
  // prove the snapshot semantics directly.
  it('control: source `close` moves on later bars while the snapshot stays put', async () => {
    const src = `//@version=6
indicator("t")
mk() => array.from(close)
var a = mk()
if bar_index == 2
    a := mk()
plot(array.get(a, 0), "e0")
plot(close, "src")`;
    const r = await runScript(parse(src), bars, { symbol: 'X', timeframe: '1' });
    const [e0, src0] = [...r.plots.values()];
    // Live control: `close` = 100..104, so bar 2→102, bar 3→103, bar 4→104.
    expect(num(src0!.values[2])).toBe(102);
    expect(num(src0!.values[3])).toBe(103);
    expect(num(src0!.values[4])).toBe(104);
    // Snapshot: the element stored on bar 2 stays at its bar-2 value.
    expect(num(e0!.values[2])).toBe(102);
    expect(num(e0!.values[3])).toBe(102);
    expect(num(e0!.values[4])).toBe(102);
  });
});
