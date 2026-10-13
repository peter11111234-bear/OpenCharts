// ── request.* builtins ──────────────────────────────────────────────────────
// `request.security` itself is NOT a normal builtin: its `expression` argument
// must stay a raw AST node (evaluated per-tf-bar in mtf.ts) and (symbol,
// timeframe) must be resolvable without evaluation for prefetching. The
// interpreter intercepts it via mtf.ts's tryEvalSecurity hook before args are
// evaluated. This registration is a fallback — reaching it means the mtf hook
// wasn't wired (interpreter ran without prepareSecurity registration), so we
// warn once and return na rather than silently evaluating wrong.
//
// Everything else in request.* is a warning stub for v1.

import type { Value } from '../contracts';
import { NA } from '../contracts';
import '../mtf'; // side effect: registers security hooks with the interpreter
import { registerBuiltin, registerConstant } from './registry';

// ── request.security enum constants ─────────────────────────────────────────
// Value = full dotted name (the repo's constant convention); request.security's
// adjustment/backadjustment/settlement_as_close parameters take these.

function enumSet(ns: string, names: readonly string[]): void {
  for (const n of names) registerConstant(ns, n, { kind: 'string', v: `${ns}.${n}` });
}

enumSet('adjustment', ['none', 'splits', 'dividends']);
enumSet('backadjustment', ['inherit', 'on', 'off']);
enumSet('settlement_as_close', ['inherit', 'on', 'off']);

let warnedSecurity = false;

registerBuiltin('request', 'security', (ctx) => {
  if (!warnedSecurity) {
    warnedSecurity = true;
    ctx.warnings.push(
      'request.security: MTF hook not active — prepareSecurity/tryEvalSecurity was not wired by the interpreter; returning na');
  }
  return NA;
});

registerBuiltin('request', 'security_lower_tf', (ctx): Value => {
  const msg = 'request.security_lower_tf: MTF hook not active — returning empty array';
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
  return { kind: 'array', v: [] };
});

const STUBS = [
  'currency_rate', 'dividends', 'splits', 'earnings',
] as const;

for (const name of STUBS) {
  registerBuiltin('request', name, (ctx): Value => {
    const msg = `request.${name}: not supported — returning na`;
    if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
    return NA;
  });
}
