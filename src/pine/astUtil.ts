// AST + numeric-value helpers shared by interpreter.ts, scriptDecl.ts and
// mtf.ts. Pure: no interpreter state. Moved verbatim from interpreter.ts
// (2026-10-22 split, phase 1).

import type { Node, Value } from './contracts';

export function isNum(v: Value): v is { kind: 'int' | 'float'; v: number } {
  return v.kind === 'int' || v.kind === 'float';
}

export function numVal(n: number, preferInt: boolean): Value {
  return preferInt && Number.isInteger(n) ? { kind: 'int', v: n } : { kind: 'float', v: n };
}

/** Child nodes of an AST node (skips scalars like loc/type/name). Shared
 *  with mtf.ts's gate walker via this export (F11). */
export function astChildren(node: object): Node[] {
  const out: Node[] = [];
  const collect = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const it of v) collect(it);
    } else if ('type' in v) {
      out.push(v as Node);
    } else {
      // Wrapper objects without a `type` field — elseIfs entries
      // ({test, body}), call args ({name?, value}), var-multi items
      // ({name, typeAnn?, value}), switch cases — transparently expose
      // their Node-valued fields. No visited set needed: the parser
      // emits trees, and an (impossible) shared subtree would only
      // rescan nodes, never corrupt the result.
      for (const inner of Object.values(v)) collect(inner);
    }
  };
  for (const v of Object.values(node)) collect(v);
  return out;
}

/**
 * May evaluating this top-level stmt skip the REST of the body's stmts?
 * `return` always exits the run; `break`/`continue` exit the top-level
 * sequence unless a loop or switch on the path absorbs them (`for`/
 * `while` absorb both in their body, `switch` absorbs `break` in matched
 * case bodies). Function bodies are opaque — their `return`/`break`/
 * `continue` can't escape to the top level. Used once per run to pick
 * `run.pruneCutoff`: decls at or after an early-exit stmt aren't provably
 * written every bar, so their slots keep registering for ensureBar.
 */
export function stmtMayExitTop(n: Node, absorbBreak: boolean, absorbCont: boolean): boolean {
  switch (n.type) {
    case 'return': return true;
    case 'break': return !absorbBreak;
    case 'continue': return !absorbCont;
    case 'func': case 'method': case 'arrow': return false;
    case 'for': case 'while': {
      // Loop bodies absorb break/continue; bound/test exprs can't contain
      // them, but scan generically with the outer flags anyway.
      const loop = n as { body?: Node[]; from?: Node; to?: Node; step?: Node; test?: Node };
      for (const s of loop.body ?? []) if (stmtMayExitTop(s, true, true)) return true;
      for (const e of [loop.from, loop.to, loop.step, loop.test]) {
        if (e && stmtMayExitTop(e, absorbBreak, absorbCont)) return true;
      }
      return false;
    }
    case 'switch': {
      const sw = n as { subject?: Node; cases?: { test?: Node; body?: Node[] }[] };
      if (sw.subject && stmtMayExitTop(sw.subject, absorbBreak, absorbCont)) return true;
      for (const c of sw.cases ?? []) {
        if (c.test && stmtMayExitTop(c.test, absorbBreak, absorbCont)) return true;
        // Only matched arms (c.test !== undefined) run inside a try that
        // absorbs BREAK — evalSwitch catches BREAK around c.test arms
        // only; the default arm propagates break/continue out, so its
        // body scans with the outer absorbBreak. CONTINUE escapes every
        // arm either way (absorbCont unchanged).
        const armAbsorb = c.test !== undefined ? true : absorbBreak;
        for (const s of c.body ?? []) {
          if (stmtMayExitTop(s, armAbsorb, absorbCont)) return true;
        }
      }
      return false;
    }
    default: {
      for (const c of astChildren(n)) {
        if (stmtMayExitTop(c, absorbBreak, absorbCont)) return true;
      }
      return false;
    }
  }
}

/** Generic recursive AST walker (Arg / case / elseIf wrappers handled).
 *  Kept separate from astChildren: this one VISITS each node (callback)
 *  and recurses pre-order, while astChildren only COLLECTS one level of
 *  children — stmtMayExitTop needs that two-phase shape. Unifying them
 *  isn't worth the flag-parameter complexity (CR2). */
export function walkNodes(nodes: Node | Node[] | undefined | null, fn: (n: Node) => void): void {
  if (!nodes) return;
  if (Array.isArray(nodes)) {
    for (const n of nodes) walkNodes(n, fn);
    return;
  }
  fn(nodes);
  const rec = nodes as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k === 'loc' || k === 'type') continue;
    const v = rec[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (!item || typeof item !== 'object') continue;
        if ('type' in item) {
          walkNodes(item as Node, fn);
          continue;
        }
        // Arg / case / elseIf wrapper objects
        if ('value' in item && item.value && typeof item.value === 'object' && 'type' in item.value)
          walkNodes(item.value as Node, fn);
        if ('body' in item && Array.isArray(item.body)) walkNodes(item.body as Node[], fn);
        if ('test' in item && item.test && typeof item.test === 'object' && 'type' in item.test)
          walkNodes(item.test as Node, fn);
      }
    } else if (v && typeof v === 'object' && 'type' in v) {
      walkNodes(v as Node, fn);
    }
  }
}
