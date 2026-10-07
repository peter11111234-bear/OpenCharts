// ── UDT support: `type` decls, `method` decls, `Type.new`, field access ─────
// Registry lives in-module (singleton). The interpreter calls these helpers
// when it hits TypeDecl / MethodDecl / `Type.new(...)` / `inst.method(...)` /
// `inst.field` / `inst.field := v`.

import type {
  BuiltinCtx,
  FieldDecl,
  MethodDecl,
  Node,
  Param,
  TypeDecl,
  UdfDecl,
  UdtInstance,
  Value,
} from './contracts';
import { NA, Scope } from './contracts';

export interface UdtTypeDef {
  name: string;
  /** Declaration order — positional `Type.new(...)` binds fields in this order. */
  fields: FieldDecl[];
}

export interface UdtMethodDef {
  selfType: string;
  name: string;
  /** Normalized so params[0] is always the self param. */
  params: Param[];
  body: Node | Node[];
}

const types = new Map<string, UdtTypeDef>();
const methodMap = new Map<string, UdtMethodDef>(); // key: `${selfType}.${name}`

/** Global scope bound at run start so method bodies can see script globals. */
let udtGlobalScope: Scope | null = null;

const methodKey = (selfType: string, name: string) => `${selfType}.${name}`;

/** Singleton registry — also usable directly for introspection/reset in tests. */
export const UDT_REGISTRY = {
  types,
  methods: methodMap,
  reset(): void {
    types.clear();
    methodMap.clear();
    udtGlobalScope = null;
  },
};

/** Called by the interpreter once per run so methods close over globals. */
export function bindUdtGlobalScope(scope: Scope): void {
  udtGlobalScope = scope;
}

export function isUdtType(name: string): boolean {
  return types.has(name);
}

export function getUdtType(name: string): UdtTypeDef | undefined {
  return types.get(name);
}

export function registerType(decl: TypeDecl): void {
  types.set(decl.name, { name: decl.name, fields: decl.fields });
}

export function hasUdtMethod(selfType: string, name: string): boolean {
  return methodMap.has(methodKey(selfType, name));
}

export function getUdtMethod(selfType: string, name: string): UdtMethodDef | undefined {
  return methodMap.get(methodKey(selfType, name));
}

/**
 * Register `method m(T self, ...) => body`.
 * Normalizes params so params[0] is the self param regardless of whether the
 * parser kept it in `params` or split it into `selfType`; when injected the
 * self param is bound under the name `self` (bodies must use `self`).
 */
export function registerMethod(decl: MethodDecl): void {
  const hasSelf = decl.params[0]?.typeAnn === decl.selfType;
  const params: Param[] = hasSelf
    ? decl.params
    : [{ name: 'self', typeAnn: decl.selfType }, ...decl.params];
  methodMap.set(methodKey(decl.selfType, decl.name), {
    selfType: decl.selfType,
    name: decl.name,
    params,
    body: decl.body,
  });
}

// ── construction ────────────────────────────────────────────────────────────

/** Evaluator for field default expressions; interpreter passes evalExpr-bound fn. */
export type DefaultEval = (node: Node) => Value;

/** Literal-only default evaluation so `T.new()` works without an interpreter. */
function literalDefault(n: Node): Value {
  switch (n.type) {
    case 'num': return n.isInt ? { kind: 'int', v: n.v } : { kind: 'float', v: n.v };
    case 'str': return { kind: 'string', v: n.v };
    case 'bool': return { kind: 'bool', v: n.v };
    case 'color': return { kind: 'color', v: n.v };
    case 'arraylit': return { kind: 'array', v: n.items.map(literalDefault) };
    default: return NA;
  }
}

/**
 * `Type.new(a1, a2, ...)` → UdtInstance.
 * Fields bind positionally in declaration order; named args bind by field
 * name; missing fields use their default expr (or `na`).
 */
export function newUdt(
  name: string,
  args: Value[],
  named: Record<string, Value> = {},
  evalDefault?: DefaultEval,
): UdtInstance {
  const def = types.get(name);
  if (!def) throw new Error(`Pine: unknown type '${name}'`);
  if (args.length > def.fields.length)
    throw new Error(`Pine: '${name}.new' takes at most ${def.fields.length} arguments, got ${args.length}`);

  const evalDef: DefaultEval = evalDefault ?? literalDefault;
  const fields = new Map<string, Value>();
  const consumed = new Set<string>();

  def.fields.forEach((f, i) => {
    const namedV = named[f.name];
    let v: Value;
    if (namedV !== undefined) {
      v = namedV;
      consumed.add(f.name);
    } else if (i < args.length) {
      v = args[i]!;
    } else if (f.default !== undefined) {
      v = evalDef(f.default);
    } else {
      v = NA;
    }
    fields.set(f.name, v);
  });

  for (const k of Object.keys(named)) {
    if (!consumed.has(k))
      throw new Error(`Pine: '${name}.new' got unknown field '${k}'`);
  }

  return { typeName: name, fields };
}

// ── field access ────────────────────────────────────────────────────────────

function asUdt(v: UdtInstance | Value): UdtInstance {
  if ('fields' in v && v.fields instanceof Map) return v;
  if ('kind' in v && v.kind === 'udt') return v.v;
  throw new Error(`Pine: expected UDT instance, got '${'kind' in v ? v.kind : typeof v}'`);
}

export function getField(inst: UdtInstance | Value, prop: string): Value {
  const u = asUdt(inst);
  const v = u.fields.get(prop);
  if (v === undefined)
    throw new Error(`Pine: type '${u.typeName}' has no field '${prop}'`);
  return v;
}

export function setField(inst: UdtInstance | Value, prop: string, v: Value): void {
  const u = asUdt(inst);
  const def = types.get(u.typeName);
  if (def && !def.fields.some((f) => f.name === prop))
    throw new Error(`Pine: type '${u.typeName}' has no field '${prop}'`);
  u.fields.set(prop, v);
}

// ── method dispatch ─────────────────────────────────────────────────────────

/**
 * `inst.method(args)` — find the method registered for inst.typeName, bind
 * self + positional args, evaluate via the interpreter's UDF machinery.
 * Named-arg callsites: reorder against `getUdtMethod(...).params` before
 * calling (ctx.callUdf binds positionally).
 */
export function callUdtMethod(
  inst: UdtInstance | Value,
  name: string,
  args: Value[],
  ctx: BuiltinCtx,
): Value {
  const isUdt = 'typeName' in (inst as object);
  const u = isUdt ? asUdt(inst) : undefined;
  const typeName = u ? u.typeName : (inst as Value).kind;
  const m = methodMap.get(methodKey(typeName, name));
  if (!m)
    throw new Error(`Pine: method '${name}' is not defined for type '${typeName}'`);
  const fn: UdfDecl = {
    name: `${typeName}.${m.name}`,
    params: m.params,
    body: m.body,
    closure: udtGlobalScope ?? new Scope(),
    selfType: m.selfType,
  };
  return ctx.callUdf(fn, [u ? { kind: 'udt', v: u } : (inst as Value), ...args]);
}

// ── type-annotation helpers ─────────────────────────────────────────────────

/**
 * `array<T>` / `T[]` annotation → element type name, else null.
 * Nested forms (`array<array<int>>`, `A[][]`) return the inner annotation.
 */
export function parseArrayElemType(ann: string): string | null {
  const a = ann.trim();
  if (a.endsWith('[]')) return a.slice(0, -2).trim();
  const m = /^array\s*<\s*(.+?)\s*>$/.exec(a);
  return m ? m[1]! : null;
}
