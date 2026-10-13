// ── log.* (script output) ───────────────────────────────────────────────────
// TV's surface is log.info / log.warning / log.error, each with a
// (message) and a (formatString, arg0, arg1, …) overload; the placeholders
// follow the str.format() grammar. Output lands on RunResult.logs.

import { describe, expect, it } from 'vitest';
import type { BarData } from '../contracts';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import '../builtins/index';

const mkBars = (n: number): BarData[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000,
    open: 10 + i,
    high: 12 + i,
    low: 9 + i,
    close: 10 + i,
    volume: 100 + i,
  }));

const run = (src: string, n = 3) => runScript(parse(src), mkBars(n), { symbol: 'TEST', timeframe: 'D' });

describe('log.*', () => {
  it('records a plain message once per bar with the calling bar index', async () => {
    const r = await run(`log.info("hello")`);
    expect(r.logs).toEqual([
      { level: 'info', bar: 0, msg: 'hello' },
      { level: 'info', bar: 1, msg: 'hello' },
      { level: 'info', bar: 2, msg: 'hello' },
    ]);
  });

  it('expands placeholders with the str.format() grammar', async () => {
    const r = await run(`if bar_index == 1
  log.warning("price {0} at bar {1}", close, bar_index)`);
    expect(r.logs).toEqual([{ level: 'warning', bar: 1, msg: 'price 11 at bar 1' }]);
  });

  it('carries the three levels in call order', async () => {
    const r = await run(`if bar_index == 0
  log.info("i")
  log.warning("w")
  log.error("e")`);
    expect(r.logs.map((l) => l.level)).toEqual(['info', 'warning', 'error']);
    expect(r.logs.map((l) => l.msg)).toEqual(['i', 'w', 'e']);
  });

  it('logs only on the bars the call is reached on', async () => {
    const r = await run(`if bar_index > 0
  log.info("bar {0}", bar_index)`, 4);
    expect(r.logs).toEqual([
      { level: 'info', bar: 1, msg: 'bar 1' },
      { level: 'info', bar: 2, msg: 'bar 2' },
      { level: 'info', bar: 3, msg: 'bar 3' },
    ]);
  });

  it('renders a missing value as NaN, like str.format()', async () => {
    const r = await run(`if bar_index == 0
  log.error("x={0} y={1}", 7)`, 1);
    expect(r.logs[0]!.msg).toBe('x=7 y=NaN');
  });

  it('does not disturb the other result channels', async () => {
    const r = await run(`log.info("noise")
plot(close)`, 2);
    expect(r.logs).toHaveLength(2);
    expect(r.warnings).toHaveLength(0);
    expect([...r.plots.values()][0]!.values).toHaveLength(2);
  });
});
