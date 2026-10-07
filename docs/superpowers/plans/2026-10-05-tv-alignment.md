# Pine Interpreter — TradingView Alignment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
>
> **日期：** 2026-10-05

**Goal:** Close the verified PineTS→TradingView semantic gaps so the five real scripts (`見高K4.55.TXT`, `MACD雙周期V7.TXT`, `MACD701_v72.pine`, `TRIS390.TXT`, `高量1.46.TXT`) run on `src/pine/` with drawing layer, na/cast builtins, correct `var`/series semantics, calendar/timeframe builtins, strategy simulation, and lower-TF security.

**Architecture:** Surgical fixes inside the existing hand-written interpreter (`src/pine/`). All edits are additive builtins + three targeted interpreter changes (per-callsite slot keying, scalar-arg series tracking, primitive method dispatch). No transpiler, no PineTS dependency.

**Tech Stack:** TypeScript, vitest (`npm test` = `vitest run`), Windows.

**Spec:** subagent gap report (verified below); source of truth = TradingView Pine v5 semantics.

**Spec invariant:** Every fix must match TradingView batch-replay semantics; NEVER break an already-passing `src/pine/__tests__/*.test.ts`.

## Verified gap ledger (re-checked 2026-10-05)

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | `builtins/index.ts` missing `import './draw'` | CONFIRMED | index.ts:9-16 |
| 2 | `na()` not callable; `not na(x)` → true | CONFIRMED | interpreter.ts:1389 registers `na` as constant only |
| 3 | `int/float/bool/color` casts unregistered | CONFIRMED | no `registerBuiltin('','int'...)` anywhere |
| 4 | `var` in UDF shared across callsites | CONFIRMED | `declSlots: Map<object,BarSeries>` keyed by AST node, interpreter.ts:109,197-205,337 |
| 5 | `isconfirmed` false on last bar | CONFIRMED | interpreter.ts:499 `b < n-1` |
| 6 | scalar/expr args lose history | CONFIRMED | `evalArg` only passes Series for bare idents (interpreter.ts:818-824); `srcOf` treats scalar as constant (ta.ts:78-85) |
| 7 | `timeframe.in_seconds` missing | CONFIRMED | not in `timeframeFields` (interpreter.ts:505-518), no builtin |
| 8 | `strategy.*` absent | CONFIRMED | decl returns void (interpreter.ts:441); no builtins |
| 9 | dynamic security (sym,tf) not prefetched | CONFIRMED | mtf.ts:299-311 skips `DYNAMIC` specs |
| 10 | `request.security_lower_tf` stub | CONFIRMED | request.ts:28-36 |
| — | `x/0 → Infinity` | REFUTED | interpreter.ts:562 already returns `NA` for `/0` |
| — | `table.cell` named `table_id=` mismatch | PARTIAL | signature binds `table`; needs `table_id` alias (draw.ts:332-335) |
| — | `barstate.isnew` 恆真 | ACCEPTED | TV batch replay: every historical bar is new; keep `n>0` (interpreter.ts:494) |
| — | `method` on primitive receiver not dispatched | CONFIRMED | evalCall:745-767 checks `obj.kind==='udt'` then builtin, never `methodMap` |
| — | `plot(offset=)` ignored | CONFIRMED | `offset` in arg order (plot.ts:95) but never written to `opts` |

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test = normal TDD loop, not a blocker.

Never stop to ask what you can look up — file locations, signatures, test names: search first.

**Plan-specific Nevers:**
- NEVER reject `var float a = h, var float b = l` multi-decl — PINETS extension the scripts depend on (parser.ts:11,333).
- NEVER change `Series.get(n)` offset semantics (contracts.ts:62 = "n bars ago").
- NEVER make `barstate.isnew` bar-dependent — batch replay keeps it `n>0`.
- NEVER implement `import`/library resolution — warn-only stub stays (interpreter.ts:433).
- NEVER special-case script content; every fix is generic Pine semantics.
- NEVER modify `pinets-src/` — that is the abandoned transpiler; all work is `src/pine/`.

## Global Constraints

- Test runner: `cd C:/Users/bear9/OpenCharts && npx vitest run src/pine/__tests__/<file> -t "<name>"` (single test) or `npm test` (suite).
- Real script files (use exactly these; note `見高K4.55` path):
  - `C:/Users/bear9/high452/HIGH455/見高K4.54/見高K4.55.TXT`
  - `C:/Users/bear9/high452/MACD雙周期/V7/MACD雙周期V7.TXT` *(verify filename glob; dir may differ — glob `C:/Users/bear9/high452/MACD*/**/*.TXT` if 404)*
  - `C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine`
  - `C:/Users/bear9/high452/TRIS39/TRIS390.TXT`
  - `C:/Users/bear9/high452/高量1.46/高量1.46.TXT`
- Strip BOM before parse: `src.replace(/^\uFEFF/, '')`.
- `runScript(parsed, bars, opts)` signature at interpreter.ts:1102. `opts.fetchSeries` provides MTF bars.

## Decision Points

### D1: barstate batch semantics (T1)
- Consumed by: Task 4; any future realtime mode.
- Candidates:
  - A (existing pattern): keep `b < n-1` — last bar "realtime unconfirmed"
  - B (minimal): `isconfirmed = true` all bars, `isrealtime=false` all bars, `islastconfirmedhistory = b===n-1`
  - C (preferred): B + `RunOptions.realtimeTail?: boolean` flag, default false
- Criteria:
  - Batch backtest signals gated by `isconfirmed` must fire on every bar (matches TV historical evaluation)
  - No new public API required unless requested
  - Reversible if a live-tick mode is added later
- Chosen: B — C adds an unused option (YAGNI); A silently drops last-bar signals, the exact bug reported.
- Rejected: A fails criterion 1; C fails criterion 2.
- Revisit trigger: a `ScriptingEngine.executeIncremental` live-tick path lands.

### D2: scalar arg history tracking (T1)
- Consumed by: Task 5 (implementation); Tasks 7-9 rely on the behavior.
- Candidates:
  - A (existing pattern): `run.callHist` keyed by AST node already tracks `expr[n]` for non-ident objects (interpreter.ts:632-640)
  - B (minimal): only fix UDF param binding — wrap scalar args in per-callsite BarSeries
  - C (preferred): evalArg writes every evaluated non-series arg into a `callHist` BarSeries keyed by arg node, then passes `{kind:'series'}` — identical mechanism for `expr[n]`; callee decides unwrap
- Criteria:
  - `ta.percentile_nearest_rank(volume_[1], N, 90)` must see history (scalar expr → series)
  - `f(1)` must yield `param[1]===1`, `f(x)` where x computed must yield `param[1]===na` on the first call bar
  - No builtin signature changes
- Chosen: C — A is the mechanism; B only fixes UDFs, leaves builtin srcOf broken.
- Rejected: B fails criterion 1 for builtins; plain A doesn't describe the fix.
- Revisit trigger: a callee proves it needs raw-scalar-vs-series distinction beyond current unwrapping.

### D3: strategy fill model (T1)
- Consumed by: Task 11.
- Candidates:
  - A (existing pattern): none — strategy layer absent
  - B (minimal): position tracker only (`position_size`, `position_avg_price`, `closedtrades`), no fills ledger
  - C (preferred): deterministic replay ledger — orders recorded per bar, fills computed lazily at read time from `ctx.open`/`ctx.high`/`ctx.low` prices, `process_orders_on_close` respected
- Criteria:
  - `strategy.entry` inside `if` still fills next bar (Pine default)
  - `strategy.position_size` is a pure function of (orders, bars) — callsite-independent
  - `strategy.equity`/`strategy.closedtrades` consistent with entry/exit
- Chosen: C — B can't answer "did the trade fill" for scripts gating on `strategy.position_size`.
- Rejected: B fails criterion 1 (conditional entry ordering); A = no solution.
- Revisit trigger: intra-bar fills (market-on-close) or slippage/commission modeling requested.

### D4: `security_lower_tf` granularity (T2 — needs human confirmation)
- Consumed by: Task 12.
- Candidates:
  - A (existing pattern): reuse `SecuritySpec`/`tryEvalSecurity` with `ltf` flag; return array of values per lower bar inside current chart bar
  - B (minimal): stub returning `[]` — script compiles, feature degraded
  - C (preferred): A + `array.from` of the expression evaluated per lower-TF bar, gaps honored
- Criteria:
  - `request.security_lower_tf(sym, "1", close)` returns array whose length = number of 1m bars in current chart bar
  - Values align to lower-bar boundaries, not repeated chart value
  - Reuses prefetch — no second fetch pass
- Chosen: C
- Rejected: B fails criterion 2; A alone is ambiguous about array shape.
- **Status: needs human confirmation** — large surface; confirm before Task 12 starts.

### D5: primitive `method` dispatch (T1)
- Consumed by: Task 8.
- Candidates:
  - A (existing pattern): `obj.method()` → `BUILTINS.get(\`${obj.kind}.${prop}\`)` (interpreter.ts:755)
  - B (minimal): only add missing `float.*`/`int.*` builtins
  - C (preferred): before builtin lookup, check `getUdtMethod(obj.kind, prop)` — methodMap already keys by type-name string; extend `callUdtMethod` to accept a raw `Value` self
- Criteria:
  - `method draw_level(float self, ...)` callable on `close` etc.
  - No change to existing UDT dispatch order (UDT methods still win for `kind==='udt'`)
  - `self` inside method body sees the primitive Value
- Chosen: C — B can't implement user-defined methods.
- Rejected: B fails criterion 1; A is the status quo.
- Revisit trigger: a UDT type named `float`/`int` collides with primitive kind strings.

## Review Ledger

(execution appends here)

---

## Task 1: Register draw builtins + format.price + enum constants

**Blocked by:** None — can start immediately.

**Files:**
- Modify: `src/pine/builtins/index.ts:9-16`
- Modify: `src/pine/builtins/str.ts:331`
- Modify: `src/pine/builtins/draw.ts:23-43`
- Modify: `src/pine/builtins/draw.ts:331-355` (table.cell `table_id` alias + new cell fns)
- Test: `src/pine/__tests__/builtins.test.ts`

**Interfaces:**
- Consumes: `registerConstant`, `registerBuiltin` from `./registry`; `bindArgs`, `numArg`, `strArg`, `colorArg` from `./util`.
- Produces: `getConstant('text.align_top')`, `getConstant('chart.point_standard')`, `BUILTINS.get('table.cell_set_text')` etc. usable by later tasks.

**Assumptions:** `enumSet` helper exists in draw.ts:21-23. `cellsOf(obj)` map helper exists (draw.ts:351).

- [ ] **Step 1: Write failing test**

```ts
it('draw enums + format.price + cell aliases registered', () => {
  expect(getConstant('text.align_top')).toBeDefined();
  expect(getConstant('text.align_bottom')).toBeDefined();
  expect(getConstant('chart.point_standard')).toBeDefined();
  expect(getConstant('chart.fg_color')).toBeDefined();
  expect(getConstant('format.price')).toBeDefined();
  for (const k of ['table.cell_set_text','table.cell_set_text_color','table.cell_set_text_size','table.cell_set_bgcolor','table.cell_set_tooltip'])
    expect(BUILTINS.has(k), k).toBe(true);
});
```

- [ ] **Step 2: Run → expect FAIL** (`npx vitest run src/pine/__tests__/builtins.test.ts -t "draw enums"`)

- [ ] **Step 3: Implement**

`index.ts` — anchor `import './ta';` — append after line 16:

```ts
import './draw';
import './core';
import './time';
import './strategy';
```

(`core`/`time`/`strategy` files are created by Tasks 2, 3, 11 — adding all four imports here keeps one touch point; TS compiles lazily, so write the imports now and the modules in their tasks.)

`str.ts` — anchor `for (const name of ['mintick', 'percent', 'volume', 'inherit', 'time'])` — change to:

```ts
for (const name of ['mintick', 'price', 'percent', 'volume', 'inherit', 'time']) {
  registerConstant('format', name, { kind: 'string', v: `format.${name}` });
}
```

`numStr` (str.ts:84-92) — anchor `if (fmt === 'format.mintick' || fmt === 'mintick')` — extend the mintick branch:

```ts
if (fmt === 'format.mintick' || fmt === 'mintick' || fmt === 'format.price' || fmt === 'price') {
  return v.toFixed(mintickDecimals(ctx));
}
```

`draw.ts` — anchor `enumSet('text', [` — replace block:

```ts
enumSet('text', [
  'align_left', 'align_center', 'align_right',
  'align_top', 'align_bottom',
  'wrap_auto', 'wrap_none',
  'format_mintick', 'format_percent', 'format_volume', 'format_inherit',
]);
enumSet('chart', ['point_standard', 'point_sensitive', 'point_highres']);
registerConstant('chart', 'fg_color', { kind: 'string', v: 'chart.fg_color' });
enumSet('size', ['tiny','small','normal','large','huge','auto']);
enumSet('location', ['abovebar','belowbar','top','bottom','right','left','absolute']);
enumSet('xloc', ['bar_index','bar_time']);
enumSet('yloc', ['price','abovebar','belowbar']);
enumSet('extend', ['none','left','right','both']);
enumSet('shape', ['xcross','cross','triangleup','triangledown','flag','circle','square','diamond','arrowup','arrowdown','label_up','label_down','label_left','label_right','label_lower_left','label_lower_right','label_upper_left','label_upper_right','label_center','label_outline']);
enumSet('plot', ['style_line','style_stepline','style_histogram','style_cross','style_area','style_columns','style_circles','style_linebr','style_areabr','style_steplinebr','style_arrowup','style_arrowdown']);
```

`draw.ts` — anchor `const bound = bindArgs(args, named, [` at line 332 inside `table.cell` — change first order entry and add alias:

```ts
  const bound = bindArgs(args, named, [
    'table_id', 'column', 'row', 'text', 'width', 'height', 'text_color',
    'text_halign', 'text_valign', 'text_size', 'bgcolor', 'tooltip',
  ] as const);
  const obj = asObj(bound.get('table_id') ?? bound.get('table'));
```

Append after `table.clear` builtin (anchor `registerBuiltin('table', 'clear'` block end, ~line 390):

```ts
const cellSetter = (key: keyof CellProps, coerce: (v: Value) => unknown) =>
  registerBuiltin('table', `cell_set_${key === 'text_color' ? 'text_color' : key}`, (c, args, named) => {
    const bound = bindArgs(args, named, ['table_id','column','row', key] as const);
    const obj = asObj(bound.get('table_id'));
    if (!obj) return { kind: 'void' };
    const col = numArg(bound,'column',0), row = numArg(bound,'row',0);
    const cell = cellsOf(obj).get(`${col},${row}`) ?? { text: '' };
    (cell as Record<string,unknown>)[key] = coerce(bound.get(key)!);
    cellsOf(obj).set(`${col},${row}`, cell);
    drawSink(c as RtCtx).update(obj, {});
    return { kind: 'void' };
  });
cellSetter('text', v => asStr(v));
cellSetter('text_color', v => asColor(v));
cellSetter('text_size', v => asStr(v));
cellSetter('bgcolor', v => asColor(v));
cellSetter('tooltip', v => asStr(v));
```

(If `CellProps` isn't exported, type the setter param as `string` and cast — check the file's local type.)

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit** — `feat(pine): register draw builtins, enums, format.price, table.cell aliases`

**Done when:**
- test in Step 1 passes
- `npx vitest run src/pine/__tests__/output.test.ts` still passes
- `grep -n "import './draw'" src/pine/builtins/index.ts` hits

---

## Task 2: Core builtins — na/casts/fixnan/runtime.error/typed-na

**Blocked by:** Task 1 (import order in index.ts).

**Files:**
- Create: `src/pine/builtins/core.ts`
- Modify: `src/pine/builtins/index.ts` (already lists `./core` from Task 1)
- Test: `src/pine/__tests__/builtins.test.ts`

**Interfaces:**
- Produces: `BUILTINS` entries `na`, `int`, `float`, `bool`, `color`, `string`, `fixnan`, `runtime.error`, `dayofweek` (see Task 3), `hour`, `minute`, `second`, `dayofmonth`, `month`, `year`, `timestamp`, `time`. Task 2 owns: `na`, `int`, `float`, `bool`, `color`, `string`, `fixnan`, `runtime.error`, plus typed-na ctor stubs `line`, `label`, `box`, `table`, `chart.point`.

- [ ] **Step 1: Failing tests**

```ts
it('na() / casts / fixnan / runtime.error', () => {
  const ctx = mkCtx();
  expect(call('na', [floatV(1)], {}, ctx)).toEqual({kind:'bool', v:false});
  expect(call('na', [{kind:'na', v:null}], {}, ctx)).toEqual({kind:'bool', v:true});
  expect(call('int', [floatV(3.9)], {}, ctx)).toEqual({kind:'int', v:3});
  expect(call('int', [{kind:'na', v:null}], {}, ctx)).toEqual({kind:'na', v:null});
  expect(call('float', [intV(2)], {}, ctx)).toEqual({kind:'float', v:2});
  expect(call('bool', [intV(0)], {}, ctx)).toEqual({kind:'bool', v:false});
  expect(call('color', [strV('#ff0000')], {}, ctx)).toEqual({kind:'color', v:'#ff0000'});
  expect(call('string', [intV(5)], {}, ctx)).toEqual({kind:'string', v:'5'});
  // fixnan via series: na at bar1 → bar0 value
  const bars = mkBars(3, () => ({close: 1}));
  const r = runBars(bars, (c,i) => i===0 ? call('fixnan',[{kind:'na',v:null}],{},c) : call('fixnan',[floatV(7)],{},c));
  expect(numv(r[0])).toBe(7); // wait — fixnan looks BACK; bar0 na → na; bar1 7 stays 7. Assert r[0] is na, r[1]=7.
});
```

- [ ] **Step 2: FAIL → Step 3: implement `core.ts`**

```ts
// ── Core Pine builtins: casts, na(), fixnan, runtime.error, typed-na ctors ──
import type { BuiltinCtx, Value } from '../contracts';
import { NA, VFALSE, VTRUE } from '../contracts';
import { registerBuiltin } from './registry';
import { asColor, asNum, asStr, bindArgs, truthy } from './util';
import { pineErr } from '../errors';
import type { Node } from '../contracts';

const unser = (v: Value | undefined): Value | undefined =>
  v?.kind === 'series' ? v.v.cur() : v;

registerBuiltin('', 'na', (_c, args) => {
  const v = unser(args[0]);
  return v === undefined || v.kind === 'na' ? VTRUE : VFALSE;
});
registerBuiltin('', 'nz', (c, a, n) => {
  const bound = bindArgs(a, n, ['v','replacement'] as const);
  const v = unser(bound.get('v'));
  const rep = unser(bound.get('replacement')) ?? { kind:'float' as const, v:0 };
  return v === undefined || v.kind === 'na' ? rep : v;
});
registerBuiltin('', 'int', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'int') return v;
  if (v.kind === 'float' || v.kind === 'bool') return { kind:'int', v: Math.trunc(asNum(v)) };
  if (v.kind === 'string' || v.kind === 'color') { const n = Number(v.v); return Number.isNaN(n) ? NA : { kind:'int', v: Math.trunc(n) }; }
  return NA;
});
registerBuiltin('', 'float', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'float') return v;
  if (v.kind === 'int' || v.kind === 'bool' || v.kind === 'string' || v.kind === 'color') return { kind:'float', v: asNum(v) };
  return NA;
});
registerBuiltin('', 'bool', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'bool') return v;
  if (v.kind === 'int' || v.kind === 'float') return { kind:'bool', v: v.v !== 0 };
  if (v.kind === 'string') return { kind:'bool', v: v.v === 'true' || v.v === '1' };
  return NA;
});
registerBuiltin('', 'color', (_c, args) => {
  const v = unser(args[0]);
  if (v === undefined || v.kind === 'na') return NA;
  if (v.kind === 'color') return v;
  if (v.kind === 'string') return { kind:'color', v: v.v };
  if (v.kind === 'int' || v.kind === 'float') return { kind:'color', v: asStr(v) };
  return NA;
});
registerBuiltin('', 'string', (_c, args) => ({ kind:'string', v: asStr(unser(args[0]) ?? NA) }));
registerBuiltin('', 'str', (_c, args) => ({ kind:'string', v: asStr(unser(args[0]) ?? NA) }));

registerBuiltin('', 'fixnan', (ctx, args) => {
  const v = args[0];
  if (v === undefined) return NA;
  if (v.kind === 'series') {
    for (let off = 0; off < v.v.size(); off++) {
      const h = v.v.get(off);
      if (h.kind !== 'na') return h;
    }
    return NA;
  }
  return v.kind === 'na' ? NA : v;
});

registerBuiltin('runtime', 'error', (ctx, args, _n) => {
  const msg = args[0] === undefined ? 'runtime error' : asStr(unser(args[0])!);
  throw pineErr(undefined, msg);
});

// Typed-na constructors: line(na)/label(na)/box(na) → plain na (Pine-compatible).
for (const k of ['line','label','box','table','chart.point'] as const) {
  const [ns, name] = k.includes('.') ? (k.split('.') as [string,string]) : ['', k] as [string,string];
  registerBuiltin(ns, name, (_c, args) => {
    const v = unser(args[0]);
    return v === undefined || v.kind === 'na' ? NA : { kind:'na', v: null } as Value;
  });
}
```

- [ ] **Step 4: PASS** — `npx vitest run src/pine/__tests__/builtins.test.ts -t "na\(\)"`

- [ ] **Step 5: Commit** — `feat(pine): na/cast/fixnan/runtime.error builtins`

**Done when:**
- `call('na',[NA])` → `VTRUE`; `call('int',[float 3.9])` → `int 3`
- `runtime.error` throws `PineRuntimeError`
- existing `builtins.test.ts` still passes
- `見高K4.55` script no longer emits `call target is not a function` warnings for `na(`/`int(`

---

## Task 3: Time/calendar builtins + timeframe.in_seconds

**Blocked by:** Task 1 (import).

**Files:**
- Create: `src/pine/builtins/time.ts`
- Test: `src/pine/__tests__/builtins.test.ts`

**Interfaces:**
- Consumes: `ctx.time` Series, `ctx.timezone` syminfo (Asia/Taipei default), `tfToMs` from `../mtf`.
- Produces: `hour`, `minute`, `second`, `dayofmonth`, `dayofweek`, `month`, `year`, `timestamp`, `time` (no-arg → current bar time), `timeframe.in_seconds`.

- [ ] **Step 1: Failing tests**

```ts
it('calendar builtins + in_seconds', () => {
  const ctx = mkCtx(); // ctx.time.get(0) = bar openTime ms
  // 2024-03-15 14:30 UTC = 1710513000000
  const t = {kind:'int' as const, v: 1710513000000};
  expect(call('hour',[t],{},ctx)).toEqual({kind:'int', v:14});
  expect(call('minute',[t],{},ctx)).toEqual({kind:'int', v:30});
  expect(call('dayofmonth',[t],{},ctx)).toEqual({kind:'int', v:15});
  expect(call('month',[t],{},ctx)).toEqual({kind:'int', v:3});
  expect(call('year',[t],{},ctx)).toEqual({kind:'int', v:2024});
  expect(call('dayofweek',[t],{},ctx)).toEqual({kind:'int', v:5}); // Friday
  expect(call('timeframe.in_seconds',[],{},ctx)).toEqual({kind:'int', v:60}); // mkCtx tf '1' → 60s? use ctx.timeframe.period
  expect(call('timestamp',[intV(2024),intV(3),intV(15),intV(14),intV(30),intV(0)],{},ctx)).toEqual({kind:'int', v:1710513000000});
});
```

- [ ] **Step 3: implement `time.ts`**

```ts
// ── Calendar/time builtins: hour/minute/…, timestamp, timeframe.in_seconds ──
import type { BuiltinCtx, Value } from '../contracts';
import { NA } from '../contracts';
import { registerBuiltin } from './registry';
import { asNum, bindArgs, numArg, strArg } from './util';
import { tfToMs } from '../mtf';

const unser = (v: Value | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const x = v.kind === 'series' ? v.v.cur() : v;
  return x.kind === 'int' || x.kind === 'float' ? x.v : undefined;
};

// Intl parts cache per timezone
const partCache = new Map<string, Intl.DateTimeFormat>();
const partsOf = (ms: number, tz: string): Intl.DateTimeFormatPart[] => {
  let f = partCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,weekday:'short'}); partCache.set(tz,f); }
  return f.formatToParts(new Date(ms));
};
const part = (ms: number, tz: string, t: Intl.DateTimeFormatPartTypes): number => {
  const p = partsOf(ms,tz).find(x=>x.type===t)?.value;
  if (t==='weekday') return ['sun','mon','tue','wed','thu','fri','sat'].indexOf((p??'').toLowerCase())+1;
  const n = Number(p); return t==='hour' && n===24 ? 0 : n;
};

const calFn = (field: Intl.DateTimeFormatPartTypes) =>
  (_c: BuiltinCtx, args: Value[], named: Record<string,Value>): Value => {
    const bound = bindArgs(args, named, ['time','timezone'] as const);
    const t = unser(bound.get('time')) ?? _c.barIndex; // no-arg → current bar time via ctx.time
    const ms = unser(bound.get('time')) ?? unser({kind:'series', v:_c.time} as Value);
    if (ms === undefined) return NA;
    const tz = bound.get('timezone')?.kind==='string' ? (bound.get('timezone') as {v:string}).v : (_c.syminfo.timezone as {v:string}).v;
    return { kind:'int', v: part(ms, tz, field) };
  };

for (const [n,f] of [['hour','hour'],['minute','minute'],['second','second'],['dayofmonth','day'],['month','month'],['year','year'],['dayofweek','weekday']] as const)
  registerBuiltin('', n, calFn(f as Intl.DateTimeFormatPartTypes));

registerBuiltin('', 'time', (_c) => {
  const v = _c.time.get(0);
  return v.kind==='int'||v.kind==='float' ? v : NA;
});

registerBuiltin('', 'timestamp', (_c, args, named) => {
  const bound = bindArgs(args, named, ['year','month','day','hour','minute','second','timezone'] as const);
  const first = bound.get('year');
  if (first?.kind==='string') { const ms = Date.parse(first.v); return Number.isNaN(ms) ? NA : {kind:'int', v:ms}; }
  const y=numArg(bound,'year',NaN), mo=numArg(bound,'month',1), d=numArg(bound,'day',1),
        h=numArg(bound,'hour',0), mi=numArg(bound,'minute',0), s=numArg(bound,'second',0);
  if (!Number.isFinite(y)) return NA;
  return { kind:'int', v: Date.UTC(y, mo-1, d, h, mi, s) };
});

registerBuiltin('timeframe', 'in_seconds', (c, args, named) => {
  const bound = bindArgs(args, named, ['timeframe'] as const);
  const tf = bound.get('timeframe')?.kind==='string' ? (bound.get('timeframe') as {v:string}).v : c.timeframe.period;
  const ms = tfToMs(tf);
  return ms === null ? NA : { kind:'int', v: Math.floor(ms/1000) };
});
```

- [ ] **Step 4: PASS** — all asserts green.

- [ ] **Step 5: Commit** — `feat(pine): calendar/time builtins + timeframe.in_seconds`

**Done when:**
- `hour`/`minute`/`timestamp`/`timeframe.in_seconds` tests pass
- 高量1.46 / TRIS390 warning list shrinks (no `unknown constant 'timeframe.in_seconds'`)

---

## Task 4: barstate batch semantics

**Blocked by:** None.

**Files:**
- Modify: `src/pine/interpreter.ts:490-503` (`barstateUdt`)
- Test: `src/pine/__tests__/interpreter.test.ts`

**Interfaces:**
- Produces: `barstate.isconfirmed===true` every bar in batch; `isrealtime===false` every bar; `islastconfirmedhistory===true` on `b===n-1`.

- [ ] **Step 1: Failing test**

```ts
it('barstate batch: all bars confirmed, none realtime', () => {
  const bars = mkBars(3);
  const r = runBars(bars, (c) => [
    c.barIndex===0 ? 'first' : '', // placeholder — direct field read
  ]);
  // simpler: evalExpr on barstate member per bar
  for (let b=0;b<3;b++){
    const ctx = mkCtxAt(b,3);
    const bs = evalIdent('barstate', {scope:new Scope(), ctx});
    const f = (bs as any).v.fields as Map<string,Value>;
    expect((f.get('isconfirmed') as any).v).toBe(true);
    expect((f.get('isrealtime') as any).v).toBe(false);
    expect((f.get('islastconfirmedhistory') as any).v).toBe(b===2);
  }
});
```

- [ ] **Step 2: FAIL → Step 3: replace interpreter.ts:493-501** — anchor `['isnew', n > 0 ? VTRUE : VFALSE],`:

```ts
    ['isnew', n > 0 ? VTRUE : VFALSE],
    ['islast', b === n - 1 ? VTRUE : VFALSE],
    ['isfirst', b === 0 ? VTRUE : VFALSE],
    ['ishistory', b < n - 1 ? VTRUE : VFALSE],
    ['isrealtime', VFALSE],
    ['isconfirmed', n > 0 ? VTRUE : VFALSE],
    ['islastconfirmedhistory', b === n - 1 ? VTRUE : VFALSE],
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `fix(pine): barstate batch semantics (all confirmed)`

**Done when:** `isconfirmed` true on last bar; TRIS390 isconfirmed-gated signals emit on final bar.

---

## Task 5: Scalar-arg series tracking + callsite stack (interpreter core)

**Blocked by:** Task 4 (same file, sequential edits).

**Files:**
- Modify: `src/pine/interpreter.ts:107-125` (RunState), `692-699` (callsiteId), `701-786` (evalCall stack), `818-824` (evalArg), `864-886` (callUdfValue)
- Test: `src/pine/__tests__/interpreter.test.ts`

**Interfaces:**
- Consumes: `callHist` map (interpreter.ts:113,632-640), `callsiteId`.
- Produces: `run.siteStack: string[]`; scalar/expr args passed to builtins+UDFs as `{kind:'series'}` backed by per-callsite BarSeries; UDF `p[1]` history correct; `ta.*` srcOf sees expression history.

**Assumptions:** `evalArg` wraps scalars for ALL call kinds (builtin + UDF + method). Builtins that need raw scalars already unwrap via `numArg`/`asNum` which currently handle `{kind:'series'}`? **No** — `num(v)` in ta.ts:20 doesn't unwrap series; `vsOf` does. Verify: `ta.percentile_nearest_rank` calls `srcOf` → `vsOf` handles series ✓; `numArg` on `percentage` — if that arg is a histref `foo[1]` it arrives as `{kind:'series'}` — `numArg`→`asNum`→`asNum` (util.ts:63) on series kind returns 0. **Fix `asNum`/`asStr`/`truthy`/`numArg`/`strArg`/`colorArg`/`curNum` to unwrap `v.kind==='series'` → `v.v.cur()` first.** Add to this task: update `util.ts` coercion helpers.

- [ ] **Step 1: Failing tests**

```ts
it('scalar arg to ta fn retains history', () => {
  const bars = mkBars(5, (i)=>({close:i+1, volume:(i+1)*10}));
  // percentile_nearest_rank(volume_[1], 4, 50) must see past volume, not constant
  const r = runBars(bars, (c)=>{
    const src = parse('ta.percentile_nearest_rank(volume_[1], 4, 50)');
    return evalExpr((src as any).body ? (src as any).body[0].value : (src as any)[0], {scope:new Scope(), ctx:c});
  });
  expect(r[4].kind).not.toBe('na');
});
it('UDF scalar param history: literal repeats, computed is na', () => {
  const src = parse(`f(x) => x[1]\na = f(1)\nb = f(bar_index)`);
  const r = runParsed(src, mkBars(3));
  // f(1): param[1]===1 on every bar after first
  // f(bar_index): param[1]===na on first call bar? bar_index is a builtin series → param IS series → param[1] exists.
  // Use computed scalar: g() => g2(bar_index*2); g2(x)=>x[1] → na on bar where g2 first called.
});
it('var inside UDF is per-callsite', () => {
  const src = parse(`f() => (var c = 0; c := c + 1; c)\na=f()\nb=f()`);
  const r = runParsed(src, mkBars(3));
  // a and b must each increment independently: a[i]=i+1, b[i]=i+1 — shared state would give b=2i+2
});
```

- [ ] **Step 2: FAIL → Step 3: implement**

`RunState` (interpreter.ts:107-125) — anchor `callsiteSeq: number;` — add:

```ts
  /** Stack of active callsite ids (UDF nesting). Empty = top level. */
  siteStack: string[];
```

Init in `runOf`: `siteStack: [],`.

`evalCall` (interpreter.ts:701) — anchor `rt.callsite = callsiteId(run, node);` — wrap the UDF dispatch:

```ts
  const site = callsiteId(run, node);
  const prevSite = rt.callsite;
  rt.callsite = site;
  run.siteStack.push(site);
  try {
    // ... existing body, unchanged ...
  } finally {
    run.siteStack.pop();
    rt.callsite = prevSite;
  }
```

(Refactor: extract existing evalCall body into `evalCallBody` or wrap the whole switch — simplest is rename current function to `evalCallImpl` and make `evalCall` the wrapper.)

`evalArg` (interpreter.ts:818-824) — replace:

```ts
function evalArg(a: Arg, frame: Frame): Value {
  const { scope, ctx } = frame;
  const run = runOf(ctx);
  if (a.value.type === 'ident') {
    const s = seriesOf(scope, a.value.name) ?? ctxSeries(ctx, a.value.name);
    if (s) return { kind: 'series', v: s };
  }
  const v = evalExpr(a.value, frame);
  if (v.kind === 'series') return v;
  // Track scalar/expr args as a per-node BarSeries so `x[1]` and ta.* source
  // windows see history. Keyed by arg-node + callsite stack for per-site state.
  const key = argSeriesKey(run, a.value);
  let s = run.callHist.get(key);
  if (!s) { s = new BarSeries(); run.callHist.set(key, s); run.allSeries.add(s); }
  s.setAt(ctx.barIndex, v);
  return { kind: 'series', v: s };
}

function argSeriesKey(run: RunState, node: Node): Node {
  // callHist key must be unique per (AST node, callsite) — compose a proxy key.
  // BarSeries map accepts object keys; wrap node in a per-site box when stack non-empty.
  if (run.siteStack.length === 0) return node;
  const k = { node, site: run.siteStack.join(',') };
  return k as unknown as Node;
}
```

(Note: `callHist` is `Map<Node, BarSeries>` — change type to `Map<object, BarSeries>` or keep cast.)

`callUdfValue` (interpreter.ts:864) — the scalar-param branch at 873-875 already wraps in BarSeries; with evalArg now producing series for scalars, params arrive as `{kind:'series'}` → `callScope.define(p.name, a.v)` — correct history automatically. **Delete the `else` branch is optional; keep it for `ctx.callUdf` external callers that pass raw Values.**

`util.ts` — update `truthy`, `asNum`, `asStr`, `asColor`, `curNum`, `numArg`, `strArg`, `boolArg`, `colorArg` to unwrap `v.kind==='series'` → `v.v.cur()` before the switch. Example:

```ts
const un = (v: Value): Value => v.kind==='series' ? v.v.cur() : v;
export function truthy(v: Value): boolean { const u = un(v); switch (u.kind) { ... } }
export function asNum(v: Value): number { const u = un(v); ... }
export function numArg(b, name, def) { const v = b.get(name); return v===undefined||un(v).kind==='na' ? def : asNum(v); }
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `fix(pine): per-callsite arg/var series tracking`

**Done when:**
- `f()=>(var c=0; c:=c+1; c)` called twice gives independent counters
- `ta.percentile_nearest_rank(volume_[1],…)` non-na
- `evalArg` never returns a stale series across callsites
- full `interpreter.test.ts` green

---

## Task 6: var/decl per-callsite slot keying

**Blocked by:** Task 5 (same file, uses `siteStack`).

**Files:**
- Modify: `src/pine/interpreter.ts:107-125`, `190-226` (slotFor/bindDeclared), `333-349` (var case), `351-369` (tuple)

**Interfaces:**
- Produces: `declSlots`/`tupleKeys` keyed by `${sitePath}|${node}` so each callsite gets independent `var`/tuple history.

- [ ] **Step 1: covered by Task 5 test 3** — add one more:

```ts
it('var in loop body per iteration is not per-callsite (top-level)', () => {
  // top-level var in a for body should still be one slot (siteStack empty)
});
```

- [ ] **Step 3: implement**

`slotFor`/`bindDeclared` — anchor `run.declSlots.get(key)` — change key computation:

```ts
function declKey(run: RunState, node: object): object {
  return run.siteStack.length === 0 ? node : ({ node, site: run.siteStack.join(',') });
}
```

In `slotFor`, `bindDeclared`, the `var` case (`run.declSlots.has(it)` → `run.declSlots.has(declKey(run,it))`), and `tupleKeys` (`run.tupleKeys.get(node)` → `run.tupleKeys.get(declKey(run,node))`), wrap every `key`/`it`/`node` argument in `declKey(run, …)`.

`declSlots`/`tupleKeys` types stay `Map<object,…>` — `declKey` returns `object` either way.

- [ ] **Step 4: PASS** — Task 5 tests + existing suite.

- [ ] **Step 5: Commit** — `fix(pine): per-callsite var/tuple slot keying`

**Done when:** `var` inside a UDF called from two sites keeps independent histories; top-level `var` unchanged.

---

## Task 7: ta.* additions — stoch, valuewhen, bare ta.tr/ta.obv series, ta.change series arg

**Blocked by:** Task 5 (util coercion + arg tracking).

**Files:**
- Modify: `src/pine/builtins/ta.ts`
- Modify: `src/pine/series.ts` (add `FnSeries`) OR define inside ta.ts
- Test: `src/pine/__tests__/ta.test.ts`

**Interfaces:**
- Produces: `BUILTINS ta.stoch`, `ta.valuewhen`; lazy constants `ta.tr`, `ta.obv` (bare series form).

- [ ] **Step 1: Failing tests**

```ts
it('ta.stoch', () => {
  const bars = mkBars(10,(i)=>({high:i+10, low:i, close:i+5}));
  const r = runBars(bars,(c)=>call('ta.stoch',[ser(c.close),ser(c.high),ser(c.low),intV(5)],{},c));
  expect(numv(r[9])).toBeCloseTo(100* (5/9) ,1); // stochastic of close in [low,high] window
});
it('ta.valuewhen', () => {
  const bars = mkBars(5,(i)=>({close:i}));
  const r = runBars(bars,(c)=>call('ta.valuewhen',[ser(/*cond close>2*/),ser(c.close),intV(0)],{},c));
  // most recent bar where cond true → its close
});
it('bare ta.tr / ta.obv series', () => {
  expect(getConstant('ta.tr')).toBeDefined();
  expect(getConstant('ta.obv')).toBeDefined();
  // ta.tr used as source: math.sum(ta.tr, 3) non-na
});
```

- [ ] **Step 3: implement**

`ta.ts` — add to reg section:

```ts
reg('stoch', (ctx, args, named) => {
  const b = bindArgs(args, named, ['source','high','low','length'] as const);
  const src = srcOf(ctx, b, 'source');
  const hi = srcOf(ctx, b, 'high');
  const lo = srcOf(ctx, b, 'low');
  const L = lenOf(b);
  if (!src||!hi||!lo||L===undefined) return NA;
  const hh = hi.get(ctx.barIndex), ll = lo.get(ctx.barIndex);
  let h = -Infinity, l = Infinity;
  for (let i=0;i<L;i++){ const hv=hi.get(ctx.barIndex-i), lv=lo.get(ctx.barIndex-i); if(hv===undefined||lv===undefined) return NA; if(hv>h)h=hv; if(lv<l)l=lv; }
  const c = src.get(ctx.barIndex);
  if (c===undefined||h===l) return NA;
  return fl(100*(c-l)/(h-l));
});

reg('valuewhen', (ctx, args, named) => {
  const b = bindArgs(args, named, ['condition','source','occurrence'] as const);
  const cond = srcOf(ctx,b,'condition'), src = srcOf(ctx,b,'source');
  const occ = lenOf(b,'occurrence') ?? 0;
  if (!cond||!src) return NA;
  let seen = 0;
  for (let off=0; off<=ctx.barIndex; off++) {
    const cv = cond.get(ctx.barIndex-off);
    if (cv!==undefined && cv!==0) {
      if (seen===occ) return fl(src.get(ctx.barIndex-off));
      seen++;
    }
  }
  return NA;
});
```

(Note `cond` VS stores numbers — use `vsOf`-style num getter; truthy = `!==0`/`!==undefined`. For bool series `cv` may be a Value not number — `srcOf` returns VS whose `get` returns `number|undefined`. For bool conditions wrap a `truthyVS`. If `cond.get` returns raw bool Value, coerce: `cv!==undefined && (typeof cv==='number' ? cv!==0 : (cv as any).v)` — verify VS.get return type at implementation time.)

Bare series — add a `FnSeries` class in `ta.ts` (or `series.ts`):

```ts
class FnSeries extends Series {
  constructor(private ctx: BuiltinCtx, private fn: (off:number)=>Value) { super(); }
  override get(n:number): Value { return this.fn(n); }
  override cur(): Value { return this.fn(0); }
  override size(): number { return this.ctx.barIndex+1; }
}
registerLazyConstant('ta.tr', (ctx) => ctx ? {kind:'series', v:new FnSeries(ctx as BuiltinCtx,(off)=>{
  const c=ctx as BuiltinCtx; const h=num(c.high.get(off)),l=num(c.low.get(off)); if(h===undefined||l===undefined)return NA;
  const pc=num(c.close.get(off+1)); if(pc===undefined)return NA;
  return fl(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
})} : undefined);
registerLazyConstant('ta.obv', /* same pattern: cumulative via vstate-like memo; simplest: recompute each access is O(n²) — memoize in a Map<bar,Value> keyed on ctx */);
```

(`Series.get(n)` signature is `n bars ago`; `FnSeries.get` ignores the private `hist` — override is safe since `get`/`cur`/`size` are public methods.)

`ta.change` — already registered (line confirmed) but needs `srcOf` on `source` — verify it accepts the now-series args from Task 5; add a test only.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `feat(pine): ta.stoch, ta.valuewhen, bare ta.tr/ta.obv series`

**Done when:** `ta.stoch`/`ta.valuewhen` correct on fixture; `math.sum(ta.tr,n)` non-na; `ta.obv` bare ident works.

---

## Task 8: Primitive method dispatch (method draw_level on float)

**Blocked by:** Task 6 (same file region).

**Files:**
- Modify: `src/pine/interpreter.ts:744-768` (evalCall method branch)
- Modify: `src/pine/udt.ts:189-207` (callUdtMethod primitive self)
- Test: `src/pine/__tests__/udt.test.ts`

**Interfaces:**
- Consumes: `getUdtMethod(typeName,name)`, `callUdtMethod`.
- Produces: `x.method()` where `x.kind` is `int`/`float`/`bool`/`string`/`color` dispatches `method m(float self,…)` registered in methodMap.

- [ ] **Step 1: Failing test**

```ts
it('method on primitive receiver', () => {
  const src = parse(`method draw_level(float self, color c) => label.new(bar_index, self, color=c)\nclose.draw_level(color.red)`);
  const r = runParsed(src, mkBars(2));
  expect(r.warnings.filter(w=>w.includes('no method')).length).toBe(0);
});
```

- [ ] **Step 3: implement**

`interpreter.ts` — anchor `if (obj.kind === 'udt') {` at line 748 — insert primitive branch BEFORE the udt check (so a method defined for `float` wins over nothing, and existing `udt` path unchanged):

```ts
  if (callee.type === 'member' && !callee.computed) {
    const obj = evalExpr(callee.obj, frame);
    const prop = callee.prop;
    if (obj.kind === 'udt') { /* existing */ }
    else if (getUdtMethod(obj.kind, prop)) {
      const bound = bindCallArgs(node.args, getUdtMethod(obj.kind, prop)!.params.slice(1), frame);
      return callUdtMethod(obj, prop, bound, ctx);
    }
    const b = BUILTINS.get(`${obj.kind}.${prop}`);
    ...
```

`udt.ts` — anchor `export function callUdtMethod(` — make `inst` accept raw Value:

```ts
export function callUdtMethod(
  inst: UdtInstance | Value,
  name: string,
  args: Value[],
  ctx: BuiltinCtx,
): Value {
  const isUdt = (inst as Value).kind === 'udt';
  const u = isUdt ? asUdt(inst) : undefined;
  const typeName = u ? u.typeName : (inst as Value).kind;
  const m = methodMap.get(methodKey(typeName, name));
  if (!m)
    throw new Error(`Pine: method '${name}' is not defined for type '${typeName}'`);
  const fn: UdfDecl = { name:`${typeName}.${m.name}`, params:m.params, body:m.body, closure:udtGlobalScope ?? new Scope(), selfType:m.selfType };
  return ctx.callUdf(fn, [u ? {kind:'udt', v:u} : (inst as Value), ...args]);
}
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `feat(pine): method dispatch on primitive receivers`

**Done when:** `close.draw_level(...)` invokes user method with `self===close` Value; existing UDT tests pass.

---

## Task 9: security dynamic-tf prefetch + plot offset

**Blocked by:** None for prefetch; same-file with nothing else — mtf.ts and plot.ts.

**Files:**
- Modify: `src/pine/mtf.ts:294-313` (prefetchSecurity signature + dynamic resolution)
- Modify: `src/pine/interpreter.ts:1180-1184` (pass frame0)
- Modify: `src/pine/contracts.ts:191-194` (PlotOpts.offset)
- Modify: `src/pine/builtins/plot.ts:99-119` (consume offset)
- Modify: `src/pine/interpreter.ts:1208-1222` (plot time array shift)
- Test: `src/pine/__tests__/mtf.test.ts`, `output.test.ts`

**Interfaces:**
- Produces: `prefetchSecurity(ctx, frame)`; `PlotOpts.offset?: number`; plots emitted at `bars[i+offset].openTime`.

- [ ] **Step 1: Failing tests**

```ts
it('dynamic tf prefetched when constant at bar0', async () => {
  const src = `targetTf = "60"\nrequest.security(syminfo.tickerid, targetTf, close)`;
  // fetchSeries spy → called once with '60'
});
it('plot offset shifts time axis', () => {
  const src = `plot(close, offset=1)`;
  const r = runScript(src, mkBars(3));
  const p = [...r.plots.values()][0];
  expect(p.time[0]).toBe(bars[1].openTime);
});
```

- [ ] **Step 3: implement**

`mtf.ts` — anchor `export async function prefetchSecurity(ctx: BuiltinCtx)` — change signature + resolution:

```ts
export async function prefetchSecurity(ctx: BuiltinCtx, frame?: Frame): Promise<void> {
  const chartBars = ctx.fetchSeries ? null : chartBarsFromCtx(ctx);
  // Resolve bar0-constant dynamic specs before fetching.
  for (const spec of store.byNode.values()) {
    if (spec.sym === DYNAMIC && spec.symNode && frame) {
      const s = runConst(spec.symNode, frame); if (s) spec.sym = s;
    }
    if (spec.tf === DYNAMIC && spec.tfNode && frame) {
      const t = runConst(spec.tfNode, frame); if (t) spec.tf = t;
    }
  }
  const jobs = new Map<string, Promise<BarData[]>>();
  for (const spec of store.byNode.values()) {
    if (spec.sym === DYNAMIC || spec.tf === DYNAMIC) continue;
    ...same...
  }
  ...same fetch...
  for (const spec of store.byNode.values()) {
    if (spec.sym === DYNAMIC || spec.tf === DYNAMIC) continue;
    spec.bars = store.fetched.get(`${spec.sym}\n${spec.tf}`) ?? [];
  }
}
```

`interpreter.ts` — anchor `await mtf.prefetchSecurity(ctx);` — pass frame0:

```ts
    await mtf.prefetchSecurity(ctx, frame0);
```

`MtfHooks` type — add `frame?` param. Find `interface MtfHooks` near top of interpreter.ts; update `prefetchSecurity` signature.

`contracts.ts` — anchor `overlay?: boolean; display?: string;` in PlotOpts:

```ts
export interface PlotOpts {
  title?: string; color?: string; style?: string; linewidth?: number;
  overlay?: boolean; display?: string;
  offset?: number;
}
```

`plot.ts` — anchor `opts.display = asStr(display);` in the `plot` builtin — add:

```ts
  const off = bound.get('offset');
  if (off !== undefined && off.kind !== 'na') opts.offset = asNum(off);
```

`interpreter.ts` RunResult assembly (lines 1208-1222) — anchor `time: buf.map((_, i) => bars[i]?.openTime ?? i),` — shift by `opts.offset`:

```ts
      const offset = Math.floor(buf[buf.length-1]!.opts.offset ?? 0);
      time: buf.map((_, i) => bars[i + offset]?.openTime ?? (bars[bars.length-1]!.openTime + i + offset - bars.length + 1)),
```

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `feat(pine): dynamic security prefetch + plot offset`

**Done when:** `targetTf = "60"` prefetch calls fetchSeries with `'60'`; `plot(offset=1)` shifts time array right by one bar.

---

## Task 10: hline(na) + misc

**Blocked by:** Task 9 (same file plot.ts).

**Files:**
- Modify: `src/pine/builtins/plot.ts:253-271`
- Test: `output.test.ts`

- [ ] **Step 1: Failing test**

```ts
it('hline(na) emits no sink', () => {
  const ctx = mkCtx();
  call('hline',[{kind:'na',v:null}],{},ctx);
  expect((ctx as RtCtx).plots?.length ?? 0).toBe(0);
});
```

- [ ] **Step 3: implement** — anchor `const price = bound.get('price') ?? NA;` — early return:

```ts
  const price = bound.get('price') ?? NA;
  const pv = price.kind==='series' ? price.v.cur() : price;
  if (pv.kind === 'na') return NA; // hline(na) draws nothing, allocates no slot
  sinkAt(ctx, idx).push(plotVal(price), opts as PlotOpts);
```

- [ ] **Step 4-5: PASS + commit** — `fix(pine): hline(na) no-op`

**Done when:** `hline(na)` creates no plot sink; `hline(50)` unchanged.

---

## Task 11: strategy.* simulation layer

**Blocked by:** Task 5 (arg tracking), D3 confirmed. **T2 decision D4 does NOT gate this task.**

**Files:**
- Create: `src/pine/builtins/strategy.ts`
- Modify: `src/pine/interpreter.ts:440-442` (strategy decl → parse config)
- Test: `src/pine/__tests__/builtins.test.ts` or new `strategy.test.ts`

**Interfaces:**
- Produces: `strategy.entry`, `strategy.exit`, `strategy.close`, `strategy.order`, `strategy.cancel`; lazy constants `strategy.position_size`, `strategy.position_avg_price`, `strategy.equity`, `strategy.openprofit`, `strategy.closedtrades`, `strategy.opentrades`; constants `strategy.long`, `strategy.short`, `strategy.fixed`, `strategy.percent_of_equity`, `strategy.cash`, `currency.*`, `strategy.commission.*`, `strategy.direction.*`.

**Design (D3):** deterministic replay ledger.

```ts
interface Order { bar: number; kind: 'entry'|'exit'|'close'|'order'; id: string; dir: 1|-1|0; qty: number; price?: number; limit?: number; stop?: number; }
interface Fill { bar: number; price: number; qty: number; dir: 1|-1; id: string; }

// ctx.state key 'strategy|orders' → Order[] appended by entry/exit/close during bar eval.
// positionAt(ctx, bar): replay orders with o.bar < bar (process_orders_on_close=false → fill at bar+1 open)
//   or o.bar <= bar (true → fill at bar close).
// qty: explicit qty arg > default_qty_value; percent_of_equity → equity*qty%/(100*close).
// entry dir: strategy.long→1, strategy.short→-1. Reversal: entry opposite sign flips.
// exit/close: reduce position; close kills whole position.
// equity(bar) = initial_capital + Σ realizedPnL(fills ≤ bar) + openQty*(close(bar) - avgEntry).
```

`strategy` decl handling — interpreter.ts:441 `case 'strategy':` — call a new export:

```ts
import { strategyDecl } from './builtins/strategy';
// ...
case 'strategy': {
  strategyDecl(ctx as RtCtx, node);
  return { kind: 'void' };
}
```

`strategyDecl` parses `node.args` for `initial_capital`, `default_qty_type`, `default_qty_value`, `commission_type`, `commission_value`, `process_orders_on_close`, `currency` → stores on `ctx.state.set('strategy|cfg', cfg)`.

`strategy.entry(id, dir, qty, limit, stop)` → push `Order{bar:ctx.barIndex,kind:'entry',id,dir,qty}`.
`strategy.exit(id, from_entry, qty, limit, stop)` → push exit order.
`strategy.close(id)` → push close order.
`strategy.position_size` lazy const → `positionAt(ctx, ctx.barIndex)`.
`strategy.equity` → equity formula above.
`strategy.closedtrades`/`opentrades` → count.

`currency.*` — `enumSet`-style string constants: `USD TWD EUR JPY GBP AUD CAD CHF CNY HKD NONE BTC ETH`.

`strategy.*` constants — `registerConstant('strategy','long',{kind:'string',v:'strategy.long'})` etc; `strategy.direction.long/short`, `strategy.commission.percent/cash_per_contract/cash_per_order`, `strategy.order.*`, `strategy.position_...` lazy.

- [ ] **Step 1: Failing test**

```ts
it('strategy entry fills next bar open, reversal flips', () => {
  const src = `strategy("t")\nif bar_index==0\n  strategy.entry("L", strategy.long)\nif bar_index==2\n  strategy.entry("S", strategy.short)`;
  // bars: open 10,11,12
  const r = runScript(src, mkBars(4));
  // position_size at bar2 should be +1 (L filled at bar1 open), at bar3 → -1 (S fills at bar3 open)
});
```

- [ ] **Step 3: implement** per design above.

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** — `feat(pine): strategy simulation ledger`

**Done when:**
- `strategy.entry` conditional still fills (order recorded even if statement skipped — Pine records at eval; ensure entry inside `if` only appends when reached — ledger handles).
- `position_size`/`equity`/`closedtrades` coherent for a 2-trade script.
- `currency.TWD`/`strategy.long` constants defined.

---

## Task 12: request.security_lower_tf

**Blocked by:** Task 9 (mtf.ts changes); **D4 needs human confirmation before starting.**

**Files:**
- Modify: `src/pine/mtf.ts` (isSecurityCall pattern, SecuritySpec.ltf, eval path)
- Modify: `src/pine/builtins/request.ts` (remove stub)
- Test: `src/pine/__tests__/mtf.test.ts`

**Interfaces:**
- `isSecurityCall` must also match `request.security_lower_tf` — currently matches `request.security`. `SecuritySpec` gains `ltf?: string` (the lower tf) + `isLtf: true`. Return `{kind:'array'}` of values, one per lower bar in the current chart bar.

- [ ] **Step 1: Failing test**

```ts
it('security_lower_tf returns per-lower-bar array', async () => {
  // chart 60m, ltf 1m → array length ≈ 60
});
```

- [ ] **Step 3: implement** — mirror `tryEvalSecurity` but iterate lower-tf bars in `[tfFloor(t0,chartPeriod), tfNext(t0,chartPeriod))`, eval expr at each, collect `{kind:'array', v:[...]}`.

- [ ] **Step 4-5: PASS + commit** — `feat(pine): request.security_lower_tf`

**Done when:** 高量1.46 FVG volume-profile path returns non-empty arrays aligned to lower bars.

---

## Task 13: E2E re-verification

**Blocked by:** Tasks 1-12.

**Files:**
- Test: `src/pine/__tests__/e2e.test.ts` (extend asserts beyond console.log)
- Create: `scripts/pine-smoke.mjs` (optional standalone runner)

- [ ] **Step 1: add asserts to existing e2e tests** — for each of the five scripts:
  - `expect(r.warnings.filter(w=>!/lookahead|dynamic/.test(w)).length).toBeLessThan(5)` (tune per script)
  - `expect([...r.plots.keys()].length).toBeGreaterThan(0)` where script plots
  - `expect(r.drawings.length).toBeGreaterThan(0)` for K455/高量 (drawing-heavy)

- [ ] **Step 2: run** — `npx vitest run src/pine/__tests__/e2e.test.ts`

- [ ] **Step 3: commit** — `test(pine): assert e2e alignment for five scripts`

**Done when:** all five script runs have ≤5 warnings and produce their expected plot/drawing surface.
