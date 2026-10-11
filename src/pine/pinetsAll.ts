// ── B3 ported-slice aggregator ───────────────────────────────────────────────
// Import order matters: pinetsShim exports registerPtSlice + facade types, then
// each tier file self-registers its SLICE into PORTED. facade.pine.ta picks up
// every ported method at makePineTsCtx() time, so composite cross-calls
// (macd→ema, hma→wma) resolve to the real ports, not test-local stand-ins.
// Deliberately NOT imported by builtins/index.ts — production opt-in lives in
// registerPortedTa() and test harnesses; flip the import to go default-on.
import './pinetsShim';
import './pinetsStateless';
import './pinetsStatefulA';
import './pinetsStatefulB';
import './pinetsComposite';
export { registerPortedTa } from './pinetsShim';
