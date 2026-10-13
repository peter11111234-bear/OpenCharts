// ── TV v6 standard-library name alignment ───────────────────────────────────
// docs/tv-pine-stdlib.json is extracted from the official Pine v6 reference
// bundle (see scratch/_extract_tv_stdlib.mjs) and carries the authoritative
// name for every documented entry. A name that TV spells one way and this
// engine registers another is a silent "identifier not found" for the user, so
// the namespaces this engine implements are pinned against the oracle here.
//
// The gap summary printed at the end is informational — it lists the TV names
// still absent from the registry, which is the alignment backlog.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('TV stdlib name alignment', () => {
  it('registers every TV name in the namespaces this engine implements', () => {
    const missing: string[] = [];
    for (const n of tvNames) {
      if (!IMPLEMENTED_PREFIXES.some((p) => n.startsWith(p)) && !IMPLEMENTED_EXACT.includes(n)) continue;
      if (!BUILTINS.has(n) && getConstant(n) === undefined) missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it('reports the remaining alignment gap by namespace', () => {
    const missing = [...tvNames].filter((n) => !BUILTINS.has(n) && getConstant(n) === undefined).sort();
    const byNs = new Map<string, string[]>();
    for (const m of missing) {
      const ns = m.includes('.') ? m.split('.')[0]! : '(global)';
      const list = byNs.get(ns) ?? [];
      list.push(m);
      byNs.set(ns, list);
    }
    const rows = [...byNs.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`TV names: ${tvNames.size} | registered: ${tvNames.size - missing.length} | missing: ${missing.length}`);
    for (const [ns, list] of rows) {
      console.log(`  ${ns} (${list.length}): ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}`);
    }
    // Not a contract: the oracle changes with every TV release.
    expect(rows.length).toBeGreaterThan(0);
  });
});
