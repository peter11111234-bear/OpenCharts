# Slice-D boundary matrix (VivaciousBuzzard scout, verbatim)

Architecture: top-level dispatch = runScriptInner bar loop → evalExpr(stmt, frame0) → evalNode switch; nested via evalBlock(scopeDepth++, topLevelBody=false) → blockFrame (new child scope). State chain: run(siteStack/callsites/declSlots/ensureList/topLevelBody/topStmtIdx/pruneCutoff/tupleKeys) hangs on ctx; frame carries scope+ctx+loopVar only.

## stmt-type × compilability matrix ((frame)=>Value compile; frame is fresh per bar, scope = live child scope)

| stmt | compilable | reason / blocker |
|---|---|---|
| num/str/bool/color/na literal, arraylit, unary/binary/ternary, member read | YES | pure expr, read live scope/bar |
| ident | YES but keep evalIdent dynamic lookup | scope.lookup may bind BarSeries/Series/fn; barstate.* via BUILTINS reads ctx.barIndex — must stay live, never bake |
| assign/let/const | HALF | init may be side-effectful (call/reassign); can fold to bindExpr but siteKey(run,node) needs live run + siteStack; must run every bar + setAt(bar) |
| typed (no init) | YES | `slotFor.setAt(bar, NA)`; slot key = siteKey(node), same every bar |
| var/varip | NO single closure | fresh = declSlots.has(siteKey) divergence (interp :586-593): first bar evals init + persistent slot; later bars only scope.define+valueAt. Baking init expr → re-evals init every bar (side effects + waste). Needs two-phase: fresh-path closure + carried-path closure, runtime dispatch |
| tuple (non-var) | HALF | value expr evals every bar; keys map in run.tupleKeys indexed by siteKey(node); names→slotFor. Safe if run.tupleKeys stays live |
| tuple (var) | NO | same fresh-vs-later split (names.some !declSlots → first/later bars diverge; :604-621 first bar evals value, later bars don't) |
| reassign x := | HALF | ident target needs live scope.lookup + type dispatch (BarSeries.setAt / Series.set / error); RHS arbitrary expr. Compilable but slot resolution must not be cached (scope can rebind via if arm) |
| reassign x[i] := / member := | HALF | array/map elem or UDT field write; same live lookup |
| if / ifexpr | HALF | test evals every bar; arm via evalBlock(blockFrame) — closure must create new child scope + maintain scopeDepth++ (else plot.* in local scope stops warn-skip); arm decls' slots must enter ensureList |
| for / while | NO-complex | per-iter blockFrame + loop var bound as BarSeries setAt(bar); BREAK/CONTINUE exceptions traverse; body decls' ensureBar duty. Compilable but low ROI (inner still evalBlock) |
| switch | HALF | subject evals every bar; matched case body catches BREAK→void, default arm doesn't (:1470-1480); continue always rethrows. Closure must preserve exception-semantics difference |
| break/continue/return | YES-trivial | throw BREAK/CONTINUE/ReturnSignal — closure throws directly; top-level loop catch behavior (:1687-1695) must be preserved |
| func | YES | already hoisted (:1639-1644); in-bar func node only re-scope.define same value — compiled closure can no-op or skip |
| method/typedecl | YES | hoisted; in-bar only registerMethod/registerType re-entry — idempotent, can no-op |
| arrow assign | YES | produces new closure value each bar (captures live scope) — semantically correct |
| import | YES | warn already deduped (warn() :180-184) |
| export | YES | plain evalExpr(node.decl) |
| seq | YES | evalBlock(stmts, same frame) no child scope |
| indicator/strategy | YES | decl handled pre-runScript; in-bar re-call of declDrawQuotas/strategyDecl must confirm idempotent — conservative: closure runs only on bar 0 |
| ANY expr containing a call (plot/alert/log/draw/request/input/ta/math…) | HALF-critical | evalCall's callsiteId+rt.callsite+siteStack state machine (:977-989) must be preserved verbatim; mtf.tryEvalSecurity at front of evalCallDispatch (:995-998); evalArg scalar-arg BarSeries tracking (:1156-68) cannot be skipped; plot.* needs live ctx.barIndex + scopeDepth; request.security goes through mtf deferred path |
| histref x[n] | HALF | non-ident obj → siteKey + callHist tracking (:903-908); ident target reads slot history directly. Compilable but keep siteKey logic |

## Semantics the closure MUST preserve (contract)
1. siteKey/callsite: closure must not hold a static key; each call still does rt.callsite/siteStack push/pop (same AST node inside UDF needs per-callsite slot)
2. ctx.barIndex: all setAt/cur/histref read live bar — never bake numbers
3. scope: new child Scope per arm/loop (blockFrame) — never cache across bars (var rebind, if-arm rebinding)
4. scopeDepth: nested body still ++/-- post-compile, else plot.* CE10188 warn disappears
5. topLevelBody/topStmtIdx: bar loop must keep setting them, else slotFor's ensureList prune misaligns → x[1] misaligns
6. exception channel: BREAK/CONTINUE/ReturnSignal must propagate through closure unchanged
7. var divergence: fresh vs carried two paths must dispatch at runtime via declSlots.has — no single path
8. evalArg BarSeries tracking: scalar/expr args' callHist needs per-bar setAt — compile must not skip
9. warn dedup: warn() is run.warned-set dedup; compiled path reuses same warn
10. mtf hook: calls containing request.* must still route through mtf.tryEvalSecurity; never compile to direct builtin

## Proposed compile() signature
```ts
type Compiled = (frame: Frame, run: RunState) => Value;
interface CompiledStmt =
  | { kind: 'direct'; fn: Compiled }
  | { kind: 'twoPhase'; fresh: Compiled; later: (frame, run, slot) => Value; isFresh: (run) => boolean }
  | { kind: 'fallback'; node: Node }
function compile(stmt: Node): CompiledStmt
```
capture: AST child nodes, siteKey base node ref (for siteKey() recompute per call), pruneCutoff/topStmtIdx index; live: scope, ctx.barIndex, run.siteStack, rt.callsite, run.declSlots/tupleKeys/callHist, warnKeys.
var/tuple(var) → twoPhase; for/while/switch (internal complexity + exception-absorption differences) → keep evalExpr fallback initially, saving only the outer dispatch layer; reassign/histref/call-containing → direct but internally still call evalCall/evalReassign/evalHistref helpers (inline the hot-path switch + siteStack assembly rather than duplicating logic).
