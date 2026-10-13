// ── AST child traversal ────────────────────────────────────────────────────
// The single definition of "child nodes" for every whole-AST pass (checks.ts's
// rule walk, qualifiers.ts' infererence). Args arrive wrapped as `{name, value}`
// and blocks as `{test, body}` / `{name, typeAnn, default}`, so the unwrapping
// lives here instead of being re-derived per pass — a pass that forgets it
// silently misses half the tree.

import type { Node } from './contracts';

const isNode = (v: unknown): v is Node =>
  v !== null && typeof v === 'object' && 'type' in v && typeof v.type === 'string';

const collect = (v: unknown, out: Node[]): void => {
  if (Array.isArray(v)) {
    for (const item of v) collect(item, out);
    return;
  }
  if (isNode(v)) {
    out.push(v);
    return;
  }
  if (v !== null && typeof v === 'object') {
    for (const inner of Object.values(v)) collect(inner, out);
  }
};

/** Every AST node reachable from `n`'s own fields. Strings/numbers (names,
 *  flags, source locations) drop. */
export function childNodes(n: Node): Node[] {
  const out: Node[] = [];
  for (const [key, v] of Object.entries(n)) {
    if (key === 'loc' || key === 'export' || key === 'params') continue;
    collect(v, out);
  }
  return out;
}
