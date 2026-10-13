// ── Engine-internal identifier namespace guard ──────────────────────────────
// Two guards, both about the same risk: the engine injects `__`-prefixed names
// into scopes a user script can reach. (1) A source scan proves every injected
// name is registered in internalNames.ts, and that the registry has no stale
// entries. (2) The generated-code scan proves the JIT only ever emits
// registered identifiers — a new codegen name fails here before it can reach a
// user script. The behavioural test pins the handoff's exact scenario
// (`f() => __ret = 5` must not overwrite the UDF's return value).

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../parser';
import '../builtins/index';
import { __pineJitStats, runScript } from '../interpreter';
import type { Node } from '../contracts';
import { INTERNAL_NAMES, INTERNAL_PREFIX } from '../internalNames';
import { jitCompile, jitCompileUdf } from '../jit';
import { mkBars } from './golden';

/** Every engine source file, minus the registry itself and the tests. */
function engineSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...engineSources(p));
    } else if (e.name.endsWith('.ts') && e.name !== 'internalNames.ts') {
      out.push(p);
    }
  }
  return out;
}

/** Names that cross a scope boundary: codegen literals, property names
 *  (globalThis switches), and named exports (instrumentation). */
const PATTERNS = [
  /['"`](__[A-Za-z0-9_]+)/g,
  /\.(__[A-Za-z0-9_]+)/g,
  /export\s*\{\s*(__[A-Za-z0-9_]+)/g,
  /export\s+(?:const|let|var|function)\s+(__[A-Za-z0-9_]+)/g,
];

describe('engine-internal identifiers', () => {
  const seen = new Set<string>();
  for (const file of engineSources('src/pine')) {
    const src = readFileSync(file, 'utf8');
    for (const p of PATTERNS) for (const m of src.matchAll(p)) seen.add(m[1]!);
  }

  it('registers every injected name', () => {
    const unregistered = [...seen].filter((n) => !(n in INTERNAL_NAMES)).sort();
    expect(unregistered, 'add these to src/pine/internalNames.ts').toEqual([]);
  });

  it('has no stale registry entries', () => {
    const stale = Object.keys(INTERNAL_NAMES).filter((n) => !seen.has(n)).sort();
    expect(stale, 'no longer found in the engine sources').toEqual([]);
  });

  it('scans more than a couple of files (the guard is not vacuous)', () => {
    expect(engineSources('src/pine').length).toBeGreaterThan(15);
    expect(seen.size).toBeGreaterThan(15);
    expect(INTERNAL_PREFIX).toBe('__pine');
  });

  it('generated code only ever names registered identifiers', () => {
    const src = `//@version=6
indicator("t")
f(a) =>
    b = a + 1
    __ret = b
    ta.sma(close, 3) + __ret
plot(f(close), "x")`;
    const parsed = parse(src);
    const body = Array.isArray(parsed) ? parsed : parsed.body;
    const udf = body.find((n): n is Node & { type: 'func' } => n.type === 'func')!;
    const results = [jitCompile(body), jitCompileUdf(udf.body)];
    for (const r of results) {
      const named = [...r.src.matchAll(/\b(__[A-Za-z0-9_]+)/g)].map((m) => m[1]!);
      const unregistered = [...new Set(named)].filter((n) => !(n in INTERNAL_NAMES));
      expect(unregistered, r.src.slice(0, 200)).toEqual([]);
      expect(named.length).toBeGreaterThan(0);
    }
  });

  it('a Pine variable named like a JIT local does not corrupt the UDF result', async () => {
    const before = __pineJitStats.udfCompiled;
    const prev = process.env.PINE_JIT_UDF;
    process.env.PINE_JIT_UDF = '1';           // UDF JIT is opt-in
    try {
      const r = await runScript(parse(`//@version=6
indicator("t")
f() =>
    __ret = 5
    __ds = 2
    a = 1
    b = 2
    c = 3
    d = 4
    e = 5
    g = 6
    __ret + __ds + a + b + c + d + e + g
plot(f(), "x")`), mkBars(3), { symbol: 'X', timeframe: 'D', fetchSeries: async () => [] });
      const values = (r.plots.get('x')?.values ?? []).map((v) =>
        v.kind === 'int' || v.kind === 'float' ? v.v : null);
      expect(values).toEqual([28, 28, 28]);
      // …and the body really was compiled, not interpreted.
      expect(__pineJitStats.udfCompiled).toBeGreaterThan(before);
    } finally {
      if (prev === undefined) delete process.env.PINE_JIT_UDF;
      else process.env.PINE_JIT_UDF = prev;
    }
  });
});
