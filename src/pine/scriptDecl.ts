// Static scans of a parsed script: indicator()/strategy() declaration args
// and the prepare-time input.* schema. Pure: no interpreter state. Moved
// verbatim from interpreter.ts (2026-10-22 split, phase 1).

import { NA, VFALSE, VTRUE, type Arg, type IndicatorDecl, type InputSchemaLite, type Node, type StrategyDecl, type Value } from './contracts';
import { getConstant } from './builtins/registry';
import { isNum, numVal, walkNodes } from './astUtil';
import { slugify } from './builtins/util';

// ── script declaration (indicator/strategy) ───────────────────────────────────

function declArgValue(decl: IndicatorDecl | StrategyDecl | null, name: string): Value | undefined {
  if (!decl) return undefined;
  const named = decl.args.find(a => a.name === name);
  return named ? staticLit(named.value) : undefined;
}

export function declTitle(decl: IndicatorDecl | StrategyDecl | null): string | undefined {
  const named = declArgValue(decl, 'title');
  if (named?.kind === 'string') return named.v;
  const first = decl?.args.find(a => a.name === undefined);
  const v = first ? staticLit(first.value) : undefined;
  return v?.kind === 'string' ? v.v : undefined;
}

export function declShortTitle(decl: IndicatorDecl | StrategyDecl | null): string | undefined {
  const v = declArgValue(decl, 'shorttitle');
  return v?.kind === 'string' ? v.v : undefined;
}

export function declOverlay(decl: IndicatorDecl | StrategyDecl | null): boolean {
  const v = declArgValue(decl, 'overlay');
  return v?.kind === 'bool' ? v.v : false;
}

export function declProps(decl: IndicatorDecl | StrategyDecl | null): InputSchemaLite[] {
  if (!decl) return [];
  return decl.args.map((a, i) => {
    const v = staticLit(a.value);
    return {
      id: a.name ?? `arg_${i}`,
      name: a.name ?? `arg_${i}`,
      type: v?.kind ?? 'na',
      defval: v && 'v' in v ? v.v : undefined,
    };
  });
}

/** Evaluate literal-ish nodes at scan time (no frame). */
function staticLit(n: Node): Value | undefined {
  switch (n.type) {
    case 'num': return numVal(n.v, n.isInt);
    case 'str': return { kind: 'string', v: n.v };
    case 'bool': return n.v ? VTRUE : VFALSE;
    case 'color': return { kind: 'color', v: n.v };
    case 'na': return NA;
    case 'unary': {
      if (n.op !== '-') return undefined;
      const a = staticLit(n.arg);
      return a && isNum(a) ? numVal(-a.v, a.kind === 'int') : undefined;
    }
    case 'member':
      return n.obj.type === 'ident' ? getConstant(`${n.obj.name}.${n.prop}`) : undefined;
    default:
      return undefined;
  }
}

// ── input schema collection (prepare-time backstop) ───────────────────────────

function inputArg(args: Arg[], idx: number, name: string): Value | undefined {
  const named = args.find(a => a.name === name);
  const node = named?.value ?? args.filter(a => a.name === undefined)[idx]?.value;
  return node ? staticLit(node) : undefined;
}

function isInputCall(n: Node): n is Extract<Node, { type: 'call' }> {
  if (n.type !== 'call') return false;
  const c = n.callee;
  return c.type === 'member' && c.obj.type === 'ident' && c.obj.name === 'input';
}

/**
 * Ids for the 2nd+ `input.*` sharing a literal title, keyed by call node. TV
 * tells inputs apart by position, so `"Type"` twice is two settings: the first
 * keeps its title/slug id (saved settings still find it), later ones get
 * `type_2`, `type_3`, … (raw title when the slug is empty: `週期_2`), bumped
 * past any id a real title already slugs to. Numbered in source order once, so
 * the run (builtins/input.ts) and collectInputs agree whatever order the run
 * reaches the calls in.
 */
export function planInputIds(body: Node[]): Map<Node, string> {
  const titled: { node: Node; title: string }[] = [];
  walkNodes(body, n => {
    if (!isInputCall(n)) return;
    const t = inputArg(n.args, 1, 'title');
    if (t?.kind === 'string' && t.v) titled.push({ node: n, title: t.v });
  });
  const taken = new Set<string>();
  for (const { title } of titled) { taken.add(title); taken.add(slugify(title, title)); }
  const count = new Map<string, number>();
  const plan = new Map<Node, string>();
  for (const { node, title } of titled) {
    let nth = (count.get(title) ?? 0) + 1;
    count.set(title, nth);
    if (nth === 1) continue;
    const base = slugify(title, title);
    while (taken.has(`${base}_${nth}`)) nth++;
    taken.add(`${base}_${nth}`);
    plan.set(node, `${base}_${nth}`);
  }
  return plan;
}

/**
 * Walk `body` for `input.<kind>(...)` calls and emit InputSchemaLite entries.
 * Live runs prefer ctx.inputSchemas (populated by builtins/input.ts with
 * override-aware ids); this static pass is the fallback / prepare-time path.
 */
export function collectInputs(body: Node[]): InputSchemaLite[] {
  const out: InputSchemaLite[] = [];
  const seen = new Set<string>();
  const dupIds = planInputIds(body);
  let seq = 0;
  const argVal = inputArg;

  walkNodes(body, n => {
    if (!isInputCall(n) || n.callee.type !== 'member') return;
    const kind = n.callee.prop;
    const defval = argVal(n.args, 0, 'defval');
    const title = argVal(n.args, 1, 'title');
    const idArg = argVal(n.args, -1, 'id');
    const titleStr = title?.kind === 'string' ? title.v : '';
    const id =
      idArg?.kind === 'string' && idArg.v ? idArg.v
        : dupIds.get(n) ?? (titleStr || `input_${kind}_${seq++}`);
    if (seen.has(id)) return;
    seen.add(id);
    const schema: InputSchemaLite = {
      id,
      name: titleStr || id,
      type: kind,
      defval: defval && 'v' in defval ? defval.v : undefined,
    };
    const minval = argVal(n.args, -1, 'minval');
    const maxval = argVal(n.args, -1, 'maxval');
    const step = argVal(n.args, -1, 'step');
    const group = argVal(n.args, -1, 'group');
    const inline = argVal(n.args, -1, 'inline');
    const tooltip = argVal(n.args, -1, 'tooltip');
    const options = argVal(n.args, -1, 'options');
    if (minval && isNum(minval)) schema.minval = minval.v;
    if (maxval && isNum(maxval)) schema.maxval = maxval.v;
    if (step && isNum(step)) schema.step = step.v;
    if (group?.kind === 'string') schema.group = group.v;
    if (inline?.kind === 'string') schema.inline = inline.v;
    if (tooltip?.kind === 'string') schema.tooltip = tooltip.v;
    if (options?.kind === 'array') {
      schema.options = options.v.map(v => ('v' in v ? v.v : v.kind));
    }
    out.push(schema);
  });
  return out;
}
