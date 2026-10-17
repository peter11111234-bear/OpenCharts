// Guard rails for the option-A ScalarSpec declaration table
// (docs/superpowers/plans/2026-10-17-wrapeval-option-a.md §11.13; extended in
// the Round-2 review, which mutation-tested what these assertions do and do
// not catch).
//
// Coverage, precisely:
//   caught     — a declared name no `registerBuiltin` registered; idx/names
//                length, duplicate and empty-entry damage; an idx pointing at a
//                different slot than its family's `bindArgs` order; an input.*
//                family that stopped declaring one of the seven option slots
//                the implementation reads (the F-A class); a non-prefix idx
//                with no `order`, and an `order` that cannot reach its own
//                names (the R2-I1 class); an `order` that drifts from its
//                family's exported constant (the D3b class); an `order` with
//                no FAMILY_ORDER key (it would skip the D3b comparison
//                silently); a FAMILY_ORDER
//                key that names no table entry; under-declaration outside the
//                input.* families (the na-ident sweep's necessary set,
//                fixtures/scalarGuardedSlots.ts).
//   NOT caught — whether the hist side (`histSpecHas`, interpreter.ts:1531)
//                still maps a raw positional index to the order slot by index
//                alone — a pre-existing twin of R2-I1 that needs the same
//                `order` plumbing on `HistSpec`.
// `scratch/perf/wrapA-na-ident-audit.mts` remains the runtime probe for the
// guarded-read set as a whole; this file guards the declaration table itself.
import { describe, expect, it } from 'vitest';
// FIRST on purpose: the table resolves its names against BUILTINS at import
// time, so the module that registers everything must evaluate before it — the
// same ordering constraint `builtins/index.ts` documents for its last import.
import '../builtins/index';
import { BUILTINS, SCALAR_BUILTINS } from '../builtins/registry';
import { SCALAR_ARGS } from '../builtins/scalarDeclPatch';
import { PLOT_ORDER, SHAPE_ORDER, PLOTBAR_ORDER, PLOTCANDLE_ORDER, HLINE_ORDER } from '../builtins/plot';
import { INPUT_ORDER, ENUM_ORDER } from '../builtins/input';
import {
  ARRAY_BIASED_ORDER,
  ARRAY_COV_ORDER,
  ARRAY_FILL_ORDER,
  ARRAY_ID_INDEX_ORDER,
  ARRAY_ID_INDEX_VALUE_ORDER,
  ARRAY_ID_VALUE_ORDER,
  ARRAY_JOIN_ORDER,
  ARRAY_PERCENTILE_ORDER,
  ARRAY_SLICE_ORDER,
} from '../builtins/array';
import { TOSTRING_ORDER, FORMAT_TIME_ORDER } from '../builtins/str';
import { GUARDED_SLOTS, GUARDED_SLOT_ORDER } from './fixtures/scalarGuardedSlots';

/** Families whose `bindArgs` order is exported; the declaration table must
 *  agree with each of them index-by-index. Every key here must also name a
 *  table entry — a key that names none checks nothing. */
const FAMILY_ORDER: Record<string, readonly string[]> = {
  plot: PLOT_ORDER,
  plotshape: SHAPE_ORDER,
  plotbar: PLOTBAR_ORDER,
  plotcandle: PLOTCANDLE_ORDER,
  hline: HLINE_ORDER,
  'input.int': INPUT_ORDER,
  'input.float': INPUT_ORDER,
  // input.string and input.price use INPUT_ORDER like the rest of the family;
  // they were the two F-A missed, and a missing key here silently disables the
  // order check for them.
  'input.string': INPUT_ORDER,
  'input.price': INPUT_ORDER,
  'input.bool': INPUT_ORDER,
  'input.color': INPUT_ORDER,
  'input.timeframe': INPUT_ORDER,
  'input.session': INPUT_ORDER,
  'input.symbol': INPUT_ORDER,
  'input.text_area': INPUT_ORDER,
  'input.time': INPUT_ORDER,
  'input.source': INPUT_ORDER,
  input: INPUT_ORDER,
  'input.enum': ENUM_ORDER,
  // array.*/str.* orders live next to the `bindArgs` sites they describe
  // (module-qualified `*_ORDER` exports, one constant per parameter-list
  // shape) — the table's `order` references the same constants, so `names`
  // stays the hand-written second source these checks compare against.
  'array.slice': ARRAY_SLICE_ORDER,
  'array.fill': ARRAY_FILL_ORDER,
  'array.variance': ARRAY_BIASED_ORDER,
  'array.stdev': ARRAY_BIASED_ORDER,
  'array.standardize': ARRAY_BIASED_ORDER,
  'array.covariance': ARRAY_COV_ORDER,
  'array.join': ARRAY_JOIN_ORDER,
  'array.percentile_linear_interpolation': ARRAY_PERCENTILE_ORDER,
  'array.percentile_nearest_rank': ARRAY_PERCENTILE_ORDER,
  'array.percentrank': ARRAY_ID_VALUE_ORDER,
  'array.includes': ARRAY_ID_VALUE_ORDER,
  'array.indexof': ARRAY_ID_VALUE_ORDER,
  'array.lastindexof': ARRAY_ID_VALUE_ORDER,
  'array.binary_search': ARRAY_ID_VALUE_ORDER,
  'array.binary_search_leftmost': ARRAY_ID_VALUE_ORDER,
  'array.binary_search_rightmost': ARRAY_ID_VALUE_ORDER,
  'array.get': ARRAY_ID_INDEX_ORDER,
  'array.remove': ARRAY_ID_INDEX_ORDER,
  'array.set': ARRAY_ID_INDEX_VALUE_ORDER,
  'array.insert': ARRAY_ID_INDEX_VALUE_ORDER,
  'str.tostring': TOSTRING_ORDER,
  'str.format_time': FORMAT_TIME_ORDER,
};

/** The seven option slots `recordAndOverride` reads for every `input.*`
 *  registration that uses INPUT_ORDER (`input.ts:115-128`); dropping one from
 *  the table lets a series wrapper reach a `kind` test. `input.enum` is laid
 *  out by ENUM_ORDER and reads only options/tooltip/inline/group. */
const INPUT_OPTIONS = ['minval', 'maxval', 'step', 'options', 'group', 'inline', 'tooltip'] as const;

/** Families that do NOT bind through `bindArgs`: `liftNums` appends named args
 *  after the positionals (`math.ts:100`), so a bindArgs `order` mis-describes
 *  them and must stay absent (R3 finding I1). Listed one by one so a new sparse
 *  entry cannot slip into the exemption by accident. */
const APPEND_MODEL = new Set(['math.round']);

describe('ScalarSpec table integrity', () => {
  it('every declared name resolves to a registered builtin', () => {
    const missing = Object.keys(SCALAR_ARGS).filter((n) => !BUILTINS.has(n));
    expect(missing).toEqual([]);
    // Installed specs equal the table size: nothing was skipped silently.
    expect(SCALAR_BUILTINS.size).toBe(Object.keys(SCALAR_ARGS).length);
  });

  it('idx and names stay in lockstep, with no duplicates', () => {
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      expect(spec.idx.length, name).toBe(spec.names.length);
      expect(new Set(spec.idx).size, name).toBe(spec.idx.length);
      // names feed the named-arg unwrap loop, so a duplicate would unwrap one
      // slot twice and leave the other alone.
      expect(new Set(spec.names).size, name).toBe(spec.names.length);
      expect(spec.names.every((n) => n.length > 0), name).toBe(true);
    }
  });

  it('each declared idx points at the matching entry of its family order', () => {
    const mismatched: string[] = [];
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      const order = FAMILY_ORDER[name];
      if (order === undefined) continue; // no exported order list (array.new, math.*, color.*, most str.*) — read by name
      spec.idx.forEach((pos, i) => {
        if (order[pos] !== spec.names[i]) {
          mismatched.push(`${name}: idx ${pos} → order '${order[pos]}', declared '${spec.names[i]}'`);
        }
      });
    }
    expect(mismatched).toEqual([]);
  });

  it('carries an order for every spec the funnel cannot resolve by index alone', () => {
    // With a named arg claiming a lower slot, a raw positional index no longer
    // equals its order slot, so `callBuiltin` needs `order` to find the arg it
    // must unwrap. An `idx` that is not a 0-based prefix can hit that; one that
    // is cannot (the mis-mapping then unwraps declared slots only). This also
    // keeps the unmodelled set explicit: a new sparse entry must say so.
    const unbacked: string[] = [];
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      const isPrefix = spec.idx.every((pos, i) => pos === i);
      if (!isPrefix && spec.order === undefined && !APPEND_MODEL.has(name)) unbacked.push(name);
    }
    expect(unbacked).toEqual([]);
    // An exemption must name a real entry and must still be exemption-worthy:
    // a stale or misspelled key would silently hide a gap.
    const stale = [...APPEND_MODEL].filter((n) => SCALAR_ARGS[n] === undefined || SCALAR_ARGS[n]!.order !== undefined);
    expect(stale).toEqual([]);
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      if (spec.order === undefined) continue;
      expect(spec.order.length, `${name}: order shorter than idx`).toBeGreaterThan(Math.max(...spec.idx));
      // The declared names must be reachable in the order the funnel maps to.
      expect(spec.names.every((n) => spec.order!.includes(n)), name).toBe(true);
    }
  });

  it('declares every input.* option slot, and every checked key exists', () => {
    const misses: string[] = [];
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      if (name !== 'input' && !name.startsWith('input.')) continue;
      if (name === 'input.enum') continue; // ENUM_ORDER layout, not INPUT_ORDER
      for (const opt of INPUT_OPTIONS) {
        const slot = INPUT_ORDER.indexOf(opt);
        if (!spec.names.includes(opt) || !spec.idx.includes(slot)) {
          misses.push(`${name}: ${opt} (INPUT_ORDER slot ${slot})`);
        }
      }
    }
    expect(misses).toEqual([]);
    // The order check above iterates FAMILY_ORDER keys, so a key whose table
    // entry does not exist would quietly check nothing.
    expect(Object.keys(FAMILY_ORDER).filter((k) => SCALAR_ARGS[k] === undefined)).toEqual([]);
  });

  it('declares every guarded-read slot the na-ident sweep derived', () => {
    // GUARDED_SLOTS is the NECESSARY set (fixtures/scalarGuardedSlots.ts):
    // every positional slot of every family was measured, literal `na` vs an
    // `na`-bound ident at the same slot, with SCALAR_BUILTINS cleared — the
    // slots that still differed are the ones a `kind` test reads. One-way on
    // purpose: extra declarations are fine (`input.*` option slot 5 `options`
    // and other unread slots are declared but not necessary); a MISSING one
    // lets a series wrapper reach a `kind` test.
    const missing: string[] = [];
    for (const [family, slots] of Object.entries(GUARDED_SLOTS)) {
      const spec = SCALAR_ARGS[family];
      const order = FAMILY_ORDER[family] ?? GUARDED_SLOT_ORDER[family];
      for (const slot of slots) {
        const pos = order?.indexOf(slot) ?? -1;
        const where = pos >= 0 ? `${family}[${pos}] ${slot}` : `${family}.${slot}`;
        if (spec === undefined) { missing.push(where); continue; }
        if (!spec.names.includes(slot)) { missing.push(`${where} (not in names)`); continue; }
        if (pos >= 0 && !spec.idx.includes(pos)) missing.push(`${where} (names has it, idx does not cover ${pos})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps each declared order equal to its family constant', () => {
    // The table's `order` must spell the same list as the family's exported
    // constant — compared value by value, NOT by identity: an inline literal
    // that re-spells the same list passes, a drifted one fails (the D3b class).
    // The one-way assertion first guarantees the comparison below cannot be
    // skipped silently, so the only entries the `family === undefined` continue
    // can still meet are order-less ones (`math.round`, APPEND_MODEL).
    const unkeyed = Object.entries(SCALAR_ARGS)
      .filter(([name, spec]) => spec.order !== undefined && FAMILY_ORDER[name] === undefined)
      .map(([name]) => name);
    expect(unkeyed).toEqual([]);
    const drifted: string[] = [];
    for (const [name, spec] of Object.entries(SCALAR_ARGS)) {
      if (spec.order === undefined) continue;
      const family = FAMILY_ORDER[name];
      if (family === undefined) continue;
      const len = Math.max(spec.order.length, family.length);
      for (let i = 0; i < len; i++) {
        if (spec.order[i] !== family[i]) {
          drifted.push(`${name}: order[${i}] = '${spec.order[i] ?? '<end>'}', family '${family[i] ?? '<end>'}'`);
          break; // one line per family, naming the first mismatch
        }
      }
    }
    expect(drifted).toEqual([]);
  });
});
