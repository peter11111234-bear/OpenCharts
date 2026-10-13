# REAL PLAN: TypeScript Strict-Type Debt Remediation (OpenCharts)

**Goal**: Bring the OpenCharts repository to a clean `npx tsc --noEmit` exit status (0 errors), systematically categorizing and fixing pre-existing type debt without disrupting active Pine interpreter workflows.

---

## Phase 1 — Debt Inventory & Categorization

### Category A: Query / API Integration Debt (`src/services/queries.ts` — ~126 errors)
- **Nature**: TanStack React Query v5 type mismatches.
- **Key Signatures**:
  - `Type 'unknown' is not assignable to type 'PnlCalendarResponse'`
  - `Type '() => Promise<unknown>' is not assignable to type 'QueryFunction<...>'`
  - `Expected 0 arguments, but got 1` (missing or extra parameters in query hooks).
- **Remediation**: Add explicit return types and parameter type guards to query definition factories.

### Category B: State Management Store Debt (`src/services/store.tsx` — ~7 errors)
- **Nature**: Zustand action signature mismatches.
- **Key Signatures**:
  - `Expected 0 arguments, but got 1-2`
- **Remediation**: Align store interface action definitions with the actual parameters passed by UI components.

### Category C: Replay UI Module (`src/pages/trading/*` — ~15 errors)
- **Nature**: Missing properties on replay hooks/context (`tickBuffer`, `tradeEvents`, `enabled`).
- **Key Signatures**:
  - `Property 'tickBuffer' does not exist on type 'never'`
- **Remediation**: Extend replay state interface definitions to include buffered tick arrays and playback flags.

### Category D: Pine Parser & Test Probes (`src/pine/parser.ts` & `__tests__/*` — ~90 errors)
- **Nature**: Rapid iteration artifact debt (implicit `any`, unhandled `undefined` object access, mismatched `BarData[]` signatures).
- **Remediation**: Fix test helper function signatures (e.g., `mkBars` return type matching `BarData[]`) and add optional chaining (`?.`) in parser.ts.

---

## Phase 2 — Execution Plan (TDD & Incremental Slices)

### Slice 1: Test Probes & Parser (`src/pine/parser.ts` & `__tests__`)
- **TDD Cycle**: Run `npx tsc --noEmit --project src/pine/tsconfig.json` (or target file list).
- **Changes**: Fix `BarData[]` casting in test helpers (`alias_repro.test.ts`, etc.); add non-null assertions or guards in `parser.ts`.
- **Verification**: Zero errors under `src/pine/`.

### Slice 2: Store & Replay UI (`src/services/store.tsx` & `src/pages/trading/*`)
- **Changes**: Update Zustand store actions and replay hook types.
- **Verification**: Clean compilation of trading pages.

### Slice 3: React Query Services (`src/services/queries.ts`)
- **Changes**: Wrap fetchers with explicit response types; fix query options overload signatures.
- **Verification**: Full repository `npx tsc --noEmit` exits with code 0.

---

## Phase 3 — CI / Guardrails

- **Pre-commit / CI integration**: Add `npx tsc --noEmit` to package.json scripts or CI workflow *only after* Phase 2 is 100% complete, preventing regression.
