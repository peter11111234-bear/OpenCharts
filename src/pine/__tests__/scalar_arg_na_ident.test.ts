// Regression pin for the `na`-valued-IDENT class at sites the ScalarSpec
// declaration table cannot cover by declaration alone:
//   - positional option slots of the plot/hline/input families (declared by
//     position in builtins/scalarDeclPatch.ts),
//   - read points whose key is dynamic, fixed in place: draw.ts `coerceIn`
//     (str-typed `set_<prop>`) and strategy.ts `strOf`.
// Before the fix an ident bound to `na` arrived as `{kind:'series'}`, the
// `kind === 'na'` guards missed, and the value degraded to 'NaN' / 0 — while a
// literal `na` in the same position behaved correctly.
import { describe, expect, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import type { RunResult } from '../contracts';
import '../builtins/index';

const bars = Array.from({ length: 5 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 60_000,
  open: i, high: i + 1, low: i - 1, close: 100 + i, volume: 1,
}));

const run = (src: string): Promise<RunResult> =>
  runScript(parse(`//@version=6\nindicator("t")\n${src}`), bars, { symbol: 'X', timeframe: '1' });

describe('na-ident args reach value semantics (plot/hline/input positional slots)', () => {
  it('plot(close, na-ident) — na title is not rendered as the text "NaN"', async () => {
    const r = await run(`tna = na\nplot(close, tna)`);
    expect([...r.plots.keys()]).toEqual(['plot_0']);
  });

  it('plot(close, "t", color.red, na-ident) — na linewidth stays unset', async () => {
    const r = await run(`lna = na\nplot(close, "t", color.red, lna)`);
    expect(r.plots.get('t')!.opts).toEqual({ title: 't', color: '#FF0000' });
  });

  it('plot(close, …, na-ident style) — na style stays unset', async () => {
    const r = await run(`sna = na\nplot(close, "t", color.red, 2, sna)`);
    expect(r.plots.get('t')!.opts).toEqual({ title: 't', color: '#FF0000', linewidth: 2 });
  });

  it('hline(1.5, "h", color.red, na-ident) — na linestyle stays unset', async () => {
    const r = await run(`lsna = na\nhline(1.5, "h", color.red, lsna)`);
    expect(r.plots.get('h')!.opts).toEqual({ style: 'hline', title: 'h', color: '#FF0000' });
  });

  it('input.int(5, "k", na-ident) — positional na minval is omitted from the schema', async () => {
    const r = await run(`mna = na\ninput.int(5, "k", mna)\nplot(close, "c")`);
    expect(r.inputs[0]!.minval).toBeUndefined();
    expect(r.inputs[0]!.defval).toBe(5);
  });

  it('input.int(5, "k", 1, na-ident) — positional na maxval is omitted', async () => {
    const r = await run(`mna = na\ninput.int(5, "k", 1, mna)\nplot(close, "c")`);
    expect(r.inputs[0]!.minval).toBe(1);
    expect(r.inputs[0]!.maxval).toBeUndefined();
  });

  // The remaining `input.*` families share scalarInput → recordAndOverride and
  // read the same option slots, so they carry the same declaration (F1).
  it('input.color(color.red, "k", na-ident) — positional na minval is omitted', async () => {
    const r = await run(`mna = na\ninput.color(color.red, "k", mna)\nplot(close, "c")`);
    expect(r.inputs[0]!.minval).toBeUndefined();
  });

  it('input.bool(true, "k", tooltip = na-ident) — NAMED na option is omitted', async () => {
    const r = await run(`tna = na\ninput.bool(true, "k", tooltip = tna)\nplot(close, "c")`);
    expect(r.inputs[0]!.tooltip).toBeUndefined();
  });
});

describe('na-ident args at dynamic-key read points (draw / strategy)', () => {
  it('line.set_style(ln, na-ident) — str prop becomes empty, not "NaN"', async () => {
    const r = await run(`
sna = na
var line ln = line.new(bar_index, low, bar_index, high)
line.set_style(ln, sna)
plot(close, "c")`);
    expect(r.drawings.find((d) => d.kind === 'line')!.props.style).toBe('');
  });

  it('label.set_text(la, na-ident) — text becomes empty, not "NaN"', async () => {
    const r = await run(`
tna = na
var label la = label.new(bar_index, high)
label.set_text(la, tna)
plot(close, "c")`);
    expect(r.drawings.find((d) => d.kind === 'label')!.props.text).toBe('');
  });

  it('strategy.entry(…, comment = na-ident) — empty comment, id keeps the label', async () => {
    const r = await run(`
cna = na
strategy.entry("e", strategy.long, comment = cna)
plot(close, "c")`);
    expect(r.execs?.[0]?.label).toBe('e');
  });
});
