// Ground truth for the 312 registry-absent TV names, using a real use site and
// the produced value (a warning alone cannot separate "resolved" from
// "silently na"):
//   resolves   — non-na value, no warning
//   silent     — na value, no warning          ← dangerous
//   loud       — "identifier 'x' not found"    ← visible
//   syntax     — the name is a keyword/declaration, not an expression
import { readFileSync } from 'node:fs';
import { parse } from '../src/pine/parser';
import { runScript } from '../src/pine/interpreter';
import { BUILTINS, getConstant } from '../src/pine/builtins/registry';
import '../src/pine/builtins/index';

interface TvFn { name: string; qualified?: string; syntax: string[] }
const tv = JSON.parse(readFileSync('docs/tv-pine-stdlib.json', 'utf8')) as { functions: TvFn[] };
const bars = [{ openTime: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }];

const names = [...new Set(tv.functions.map((f) => f.qualified ?? f.name))];
const byName = new Map(tv.functions.map((f) => [f.qualified ?? f.name, f]));
const missing = names.filter((n) => !BUILTINS.has(n) && getConstant(n) === undefined);

const bucket: Record<string, string[]> = { resolves: [], silent: [], loud: [], syntax: [] };
for (const n of missing) {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n)) { bucket.syntax!.push(n); continue; }
  try {
    const r = await runScript(parse(`x = ${n}\nplot(x, "x")`), bars, { symbol: 'TEST', timeframe: 'D' });
    if (/not found|unknown constant/.test(r.warnings.join("\n"))) { bucket.loud!.push(n); continue; }
    const last = r.plots.get('x')?.values.at(-1);
    (last === undefined || last.kind === 'na' ? bucket.silent! : bucket.resolves!).push(n);
  } catch { bucket.syntax!.push(n); }
}

const ns = (list: string[]): string => {
  const m = new Map<string, number>();
  for (const n of list) {
    const k = n.includes('.') ? n.split('.')[0]! : '(global)';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
};

const isFn = (n: string): boolean => (byName.get(n)?.syntax.length ?? 0) > 0;
for (const [k, v] of Object.entries(bucket)) {
  console.log(`\n=== ${k} (${v.length})  fn=${v.filter(isFn).length} value=${v.filter((n) => !isFn(n)).length}\n${ns(v)}`);
}
console.log(`\n=== silent list\n${bucket.silent!.join(' ')}`);
console.log(`\n=== resolves list\n${bucket.resolves!.join(' ')}`);
console.log(`\n=== syntax list\n${bucket.syntax!.join(' ')}`);
console.log(`\n=== loud globals\n${bucket.loud!.filter((n) => !n.includes('.')).join(' ')}`);
