// ── Test-only engine source scanner ─────────────────────────────────────────
// Shared by internal_names.test.ts and debug_flags.test.ts. Both guards assert
// something about the engine's SOURCE TEXT, so they need one definition of "the
// code, without the prose": comments are removed, string/template contents are
// kept (the names under guard live inside string literals and generated-code
// templates).
//
// A regex cannot do this safely — a JSDoc holding a glob pattern opens a block
// comment that never closes, and `//` inside a string (a URL) truncates the
// rest of the line. Measured: both cases silently dropped names from the scan.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Names of files that must NOT be scanned: the registry that lists the names
 *  (an "unregistered name" check over it would be vacuous in one direction and
 *  stale-proof in the other, i.e. useless) and this scanner. */
const SKIP = new Set(['internalNames.ts', 'sourceScan.ts', '__tests__']);

/** Every engine source file under `dir` (recursive), without the skipped ones. */
export function engineSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...engineSources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** `[file, comment-free source]` for every engine source. */
export function engineCode(dir: string): [string, string][] {
  return engineSources(dir).map((f) => [f, stripComments(readFileSync(f, 'utf8'))]);
}

/** Drop comments that sit outside a string or template literal. Escapes are
 *  honoured; unterminated literals simply keep the rest of the text. */
export function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
