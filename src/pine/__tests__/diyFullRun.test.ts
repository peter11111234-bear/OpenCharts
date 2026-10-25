// Full DIY Custom Strategy Builder script (4469 lines, v6) running end-to-end.
// Two external libraries are imported (TradingView/ZigZag, TradersReality/
// Traders_Reality_Lib); TradingView does not publish their source, so the
// interpreter binds them to the stubs in `libStubs.ts`. This test pins three
// things:
//   (a) the whole script parses and runs 200 bars without a runtime error,
//   (b) the self-contained indicators still emit output,
//   (c) Liquidity Zone boxes stay empty (Traders_Reality_Lib is still inert),
//       while Fibonacci lines DO appear — ZigZag is backed by our own
//       `zigzag.ts` detector (numbers are not TradingView-parity).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';
import '../mtf';

const SRC_PATH = 'C:/Users/bear9/pine-editor-fix-evidence/diy-tv-clean-full.txt';
const BARS = 200;

function synthBars(n: number) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = 100 + i * 0.7 + Math.sin(i / 7) * 3;
    bars.push({ openTime: i * 300000, open: p, high: p + 1.2, low: p - 1.1, close: p + 0.3, volume: 1000 + i });
  }
  return bars;
}

/** Same generator as `zigzagFib.test.ts` / `mzigzag_semantics.test.ts`: swings
 *  large enough for the script's dev=3 / depth=10 zigzag to confirm pivots. */
function oscBars(n: number) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const p = 22000 + Math.sin(i / 8) * 500 + Math.sin(i / 3) * 80;
    bars.push({ openTime: i * 300000, open: p, high: p + 40, low: p - 40, close: p + 5, volume: 1000 });
  }
  return bars;
}

/** Every overlay switch this test needs on, so both the library-backed features
 *  (Fibonacci, Liquidity Zone) and the main indicators actually execute. */
const SWITCHES_ON = {
  EMA: true,
  Supertrend: true,
  'Range Filter': true,
  'Half Trend': true,
  'Ichimoku Cloud': true,
  PSAR: true,
  'Bollinger Band': true,
  STC: true,
  VWAP: true,
  'Range Detector': true,
  Fibonacci: true,
  'Liquidity Zone': true,
};

const nonNa = (r: RunResult, title: string): number => {
  const p = r.plots.get(title);
  if (!p) throw new Error(`no plot '${title}' (have ${[...r.plots.keys()].join(',')})`);
  return p.values.filter((v) => v.kind !== 'na').length;
};

describe('DIY Custom Strategy Builder — full script', () => {
  // Measured 5.3 s for 200 bars under vitest (interpreter, no JIT warmup here).
  it(`parses and runs ${BARS} bars with the library stubs, indicators emitting`, { timeout: 180_000 }, async () => {
    const src = readFileSync(SRC_PATH, 'utf8').replace(/^\uFEFF/, '');
    const r = await runScript(parse(src), synthBars(BARS), {
      symbol: 'X',
      timeframe: '5',
      inputValues: SWITCHES_ON,
    });

    // (a) completed every bar.
    expect(r.plots.get('Range Filter')!.values.length).toBe(BARS);

    // Both imports resolved to stubs — no "libraries not supported" fallback.
    expect(r.warnings.filter((w) => w.includes('libraries not supported'))).toEqual([]);
    expect(r.warnings.filter((w) => /identifier '(zigzag|trLib)' not found/.test(w))).toEqual([]);

    // (b) self-contained indicators produce output.
    for (const title of ['Range Filter', 'MA 1', 'HalfTrend', 'VWAP', 'ParabolicSAR', 'Lagging Span']) {
      expect(nonNa(r, title), title).toBeGreaterThanOrEqual(100);
    }

    // (c) Liquidity Zone stays inert — Traders_Reality_Lib is still a stub.
    const boxes = r.drawings.filter((d) => d.kind === 'box');
    expect(boxes, 'Liquidity Zone (trLib stub) emits no boxes').toEqual([]);

    // Fibonacci: the smooth uptrend above never reverses by dev = 3 % of ATR,
    // so our zigzag confirms no pivot and this dataset draws no level. Re-run
    // the same script on the oscillation series that does reverse (same
    // generator as zigzagFib.test.ts) and require the levels to appear.
    const fibRun = await runScript(parse(src), oscBars(BARS), {
      symbol: 'X',
      timeframe: '5',
      inputValues: SWITCHES_ON,
    });
    const fibLines = fibRun.drawings.filter((d) => d.kind === 'line' && d.props.y1 === d.props.y2);
    expect(fibLines.length, 'Fibonacci (zigzag stub) emits levels').toBeGreaterThan(0);
  });
});
