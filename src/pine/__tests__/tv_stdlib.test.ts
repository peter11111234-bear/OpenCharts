// ── TV v6 standard-library name alignment ───────────────────────────────────
// docs/tv-pine-stdlib.json is extracted from the official Pine v6 reference
// bundle (see scratch/_extract_tv_stdlib.mjs) and carries the authoritative
// name for every documented entry. A name that TV spells one way and this
// engine registers another is a silent "identifier not found" for the user, so
// the namespaces this engine implements are pinned against the oracle here.
//
// The gap summary printed at the end is informational. Its number is the
// alignment backlog, so it subtracts the two classes that are not gaps:
// names the interpreter answers from ctx (resolvesFromCtx) and the names the
// reference documents as "functions" but Pine treats as syntax.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { BarData, BuiltinCtx } from '../contracts';
import { BarCtx } from '../context';
import { parse } from '../parser';
import { resolvesFromCtx, runScript } from '../interpreter';
import { BUILTINS, getConstant } from '../builtins/registry';
import '../builtins/index';

interface TvEntry {
  name: string;
  qualified?: string;
  syntax: string[];
  args: { name: string }[];
}

const tv = JSON.parse(readFileSync('docs/tv-pine-stdlib.json', 'utf8')) as { functions: TvEntry[] };
const tvNames = new Set(tv.functions.map((f) => f.qualified ?? f.name));

/** Namespaces this engine claims to implement — every TV name in them must
 *  resolve in the registry. `indicator()` / `strategy()` are declaration
 *  statements handled by the interpreter, not registry entries, so they are
 *  deliberately absent from this list. */
const IMPLEMENTED_PREFIXES = ['log.', 'strategy.', 'session.', 'str.'];
const IMPLEMENTED_EXACT = [
  'strategy.entry', 'strategy.exit', 'strategy.close',
  'strategy.close_all', 'strategy.order', 'strategy.cancel', 'strategy.cancel_all',
  'runtime.error', 'time', 'time_close',
];

/** Language-level names the reference lists among the "functions" but that are
 *  not values in Pine: keywords, declaration statements, namespace roots and
 *  parameter names. They have no registry entry by design, and using one as an
 *  expression correctly reports "identifier 'x' not found". */
const SYNTAX_NAMES = new Set([
  // keywords / operators
  'and', 'or', 'not', 'if', 'switch', 'for', 'for...in', 'while', 'once',
  'var', 'varip', 'const', 'simple', 'series', 'enum', 'export', 'import',
  'type', 'method',
  // declaration statements
  'indicator', 'strategy', 'library',
  // namespace roots (only the dotted members are values)
  'array', 'matrix', 'map', 'polyline', 'linefill', 'footprint', 'volume_row',
  // parameter names documented as their own entries
  'max_bars_back', 'size', 'initial_value', 'rows', 'columns',
]);

const probeBars: BarData[] = [{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
const probeCtx = new BarCtx(probeBars, { market: 'D' }).seek(0) as BuiltinCtx;

/** TV names with no registry entry AND no other resolution path. */
const backlog = (): string[] =>
  [...tvNames]
    .filter((n) => !BUILTINS.has(n) && getConstant(n) === undefined)
    .filter((n) => !resolvesFromCtx(probeCtx, n) && !SYNTAX_NAMES.has(n))
    .sort();

describe('TV stdlib name alignment', () => {
  it('registers every TV name in the namespaces this engine implements', () => {
    const missing: string[] = [];
    for (const n of tvNames) {
      if (!IMPLEMENTED_PREFIXES.some((p) => n.startsWith(p)) && !IMPLEMENTED_EXACT.includes(n)) continue;
      if (!BUILTINS.has(n) && getConstant(n) === undefined) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it('resolvesFromCtx agrees with the interpreter', async () => {
    // One name per path, plus the negative cases that must stay gaps.
    const cases: [string, boolean][] = [
      ['close', true], ['bar_index', true], ['hlc3', true],
      ['syminfo.currency', true], ['timeframe.multiplier', true], ['barstate.islast', true],
      ['syminfo.country', false], ['currency.AED', false], ['ta.barssince', false],
    ];
    for (const [name, expected] of cases) {
      expect(resolvesFromCtx(probeCtx, name), `resolvesFromCtx(${name})`).toBe(expected);
      const r = await runScript(parse(`x = ${name}\nplot(x, "x")`), probeBars, { symbol: 'TEST', timeframe: 'D' });
      const warned = /not found|unknown constant/.test(r.warnings.join('\n'));
      expect(warned, `engine disagreement on ${name}: ${r.warnings.join(' | ')}`).toBe(!expected);
    }
  });

  it('reports the remaining alignment gap by namespace', () => {
    const registryAbsent = [...tvNames].filter((n) => !BUILTINS.has(n) && getConstant(n) === undefined);
    const missing = backlog();
    const byNs = new Map<string, string[]>();
    for (const m of missing) {
      const ns = m.includes('.') ? m.split('.')[0]! : '(global)';
      const list = byNs.get(ns) ?? [];
      list.push(m);
      byNs.set(ns, list);
    }
    const rows = [...byNs.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(
      `TV names: ${tvNames.size} | registered: ${tvNames.size - registryAbsent.length}` +
      ` | absent from registry: ${registryAbsent.length}` +
      ` | alignment backlog: ${missing.length}`,
    );
    for (const [ns, list] of rows) {
      console.log(`  ${ns} (${list.length}): ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}`);
    }
    // Not a contract: the oracle changes with every TV release.
    expect(rows.length).toBeGreaterThan(0);
  });
});
