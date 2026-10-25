// ── Pine worker entry ────────────────────────────────────────────────────────
// Hosts runScript inside a Web Worker. createWorkerHandler is the pure piece:
// given a post() sink it returns the onmessage handler, so tests drive it
// directly while the real worker entry at the bottom wires it to `self`.
// Protocol: pineWorkerProto.ts / docs/superpowers/plans/2026-10-09-b4-worker.md.

// Side-effect imports: register all builtins + MTF request handlers. Without
// these the worker would evaluate scripts against an empty registry.
import './builtins/index';
import './mtf';

import { incRun, type IncLive, type ParsedInput } from './interpreter';
import { parse } from './parser';
import type { BarData, RunResult, Value } from './contracts';
import type { FromWorker, PlotDelta, ToWorker } from './pineWorkerProto';
import { marshalError, sanitizeRunResult, sanitizeValue } from './pineMarshal';


/** Last plots payload sent per run id — the incremental path reuses it to
 *  ship only the changed tail instead of cloning ~5000 Value objects per
 *  tick (structured-clone was ~9.5ms at 500 bars × 11 plots). Keyed by the
 *  client's run id; entries live only for the current session's runs and
 *  reset whenever a fresh full result goes out. */
let lastPlots: Map<string, { index: number; len: number; tailV: Value; tailC: string | undefined; opts: unknown }> | null = null;

/** Diff a RunResult's plots against `lastPlots`. Returns deltas when every
 *  entry resolves to tail-only changes; null when the shape changed (new /
 *  removed / re-ordered plots or different opts) — caller then sends the
 *  full sanitized result. */
function plotsDelta(plots: RunResult['plots']): PlotDelta[] | null {
  if (!lastPlots) return null;
  const out: PlotDelta[] = [];
  for (const [key, p] of plots) {
    const prev = lastPlots.get(key);
    const len = p.values.length;
    if (!prev || prev.index !== p.index || prev.opts !== p.opts) {
      // New or re-shaped entry — ship it whole.
      out.push({ key, from: 0, tail: { index: p.index, time: p.time.slice(), values: p.values.slice(), colors: p.colors.slice(), opts: p.opts } });
      continue;
    }
    const shared = Math.min(prev.len, len);
    const tailIdx = shared - 1;
    const from = tailIdx >= 0 && (p.values[tailIdx] !== prev.tailV || p.colors[tailIdx] !== prev.tailC)
      ? tailIdx
      : shared;
    if (from === len) {
      // Nothing changed for this entry — still must record the current len
      // so a later rollback diff stays correct.
      prev.len = len;
      continue;
    }
    out.push({ key, from, tail: { index: p.index, time: p.time.slice(from), values: p.values.slice(from), colors: p.colors.slice(from), opts: p.opts } });
    prev.len = len;
    prev.tailV = p.values[len - 1]!;
    prev.tailC = p.colors[len - 1];
  }
  for (const key of lastPlots.keys()) if (!plots.has(key)) out.push({ key, from: 0, drop: true });
  // Track membership for the next diff.
  for (const [key, p] of plots) {
    lastPlots.set(key, { index: p.index, len: p.values.length, tailV: p.values[p.values.length - 1] as Value, tailC: p.colors[p.colors.length - 1], opts: p.opts });
  }
  return out;
}
export function createWorkerHandler(post: (msg: FromWorker) => void): (msg: ToWorker) => void {
  // At most one run in flight — the engine's drain serializes runs per
  // session and each session owns its own worker — so a single fid sequence
  // suffices. Stop is hard: the client terminate()s the worker, there is no
  // graceful abort message (terminate discards queued tasks anyway).
  let fetchSeq = 0;
  const pending = new Map<number, { res: (bars: BarData[]) => void; rej: (e: Error) => void }>();

  // fetchSeries RPC: script's request.* calls block on a fetchRes round-trip.
  const rpcFetch = (sym: string, tf: string) =>
    new Promise<BarData[]>((res, rej) => {
      const fid = ++fetchSeq;
      pending.set(fid, { res, rej });
      post({ t: 'fetchReq', fid, sym, tf });
    });

  const fail = (id: number, e: unknown) => {
    try { post({ t: 'fail', id, error: marshalError(e) }); } catch { /* nothing salvageable */ }
  };
  // Live-tick sessions: incKey → IncLive (committed checkpoint + forming-bar
  // rollback). Bounded — a pooled worker can host a few sessions before the
  // oldest evicts; evicted = next run just builds a fresh session.
  const INC_CAP = 8;
  const incSessions = new Map<string, IncLive | null>();
  const incPut = (key: string, live: IncLive | null) => {
    if (incSessions.size >= INC_CAP && !incSessions.has(key)) {
      const oldest = incSessions.keys().next().value;
      if (oldest !== undefined) incSessions.delete(oldest);
    }
    incSessions.set(key, live);
  };

  // ASTs sent by reference: the client omits `parsed` once this worker holds
  // it, so a per-tick run costs no structured clone. Insertion order evicts
  // the oldest — a MISS is reported (never silently re-parsed from `source`,
  // which the client may not even send) and the client resends once.
  const AST_CAP = 8;
  const astCache = new Map<string, ParsedInput>();
  const astPut = (id: string, parsed: ParsedInput) => {
    if (astCache.size >= AST_CAP && !astCache.has(id)) {
      const oldest = astCache.keys().next().value;
      if (oldest !== undefined) astCache.delete(oldest);
    }
    astCache.set(id, parsed);
  };

  // Tapes per incKey — the worker's own copy of the bars, seeded by every
  // full-bars run and patched in place by `tape` runs. The client ships only
  // the changed tail; a MISS (evicted key, no key) is reported instead of
  // guessing, and the client resends the whole tape once. Same bounded,
  // insertion-ordered map as incSessions/astCache — evicting a tape is
  // harmless (the next run for that key just sends everything), so evicting an
  // incSession never has to touch it.
  const tapes = new Map<string, BarData[]>();
  const tapePut = (key: string, bars: BarData[]) => {
    if (tapes.size >= INC_CAP && !tapes.has(key)) {
      const oldest = tapes.keys().next().value;
      if (oldest !== undefined) tapes.delete(oldest);
    }
    tapes.set(key, bars);
  };

  return (msg) => {
    // Shape guard: a nullish/primitive payload must not throw out of the
    // handler — a sync throw here reaches worker.onerror, the client then
    // marks the transport dead and RE-RUNS the script in-process.
    if (msg === null || typeof msg !== 'object') return;
    if (msg.t === 'fetchRes') {
      const p = pending.get(msg.fid);
      // No pending entry = the run that issued it already settled.
      if (!p) return;
      pending.delete(msg.fid);
      if (msg.ok) p.res(msg.bars ?? []);
      else p.rej(new Error(msg.error ?? 'fetchSeries request failed'));
      return;
    }
    if (msg.t !== 'run') return;
    const id = msg.id;
    const settle = () => {
      // Drop orphaned fetch continuations — a timed-out prefetch (mtf's 30s
      // race) leaves its promise unawaited; rejecting it is harmless and the
      // entry must not outlive the run into the next one.
      for (const p of pending.values()) p.rej(new Error('run settled'));
      pending.clear();
    };

    try {
      // Body wins (fresh from the client) and seeds the reference cache with
      // THIS object; then the cached body by id; only then a re-parse. A
      // referenced id we no longer hold is reported instead of re-parsed:
      // `source` is absent on reference runs, so guessing would run ''.
      let parsed: ParsedInput | undefined;
      if (msg.parsed !== undefined) {
        parsed = msg.parsed;
        if (msg.astId !== undefined) astPut(msg.astId, parsed);
      } else if (msg.astId !== undefined) {
        parsed = astCache.get(msg.astId);
      }
      if (parsed === undefined) {
        if (msg.astId !== undefined) {
          const miss = new Error(`PineAstMiss: worker has no AST for id ${msg.astId}`);
          miss.name = 'PineAstMiss';
          throw miss;
        }
        parsed = parse(msg.source ?? '');
      }
      const incKey = msg.opts.incKey;
      // Bars: a full tape wins and seeds the worker's copy; a patch is applied
      // to that copy — synchronously, before incRun, so the tape the next run
      // patches is always the one this run evaluated.
      let bars: BarData[];
      if (msg.bars !== undefined) {
        bars = msg.bars;
        if (incKey !== undefined) tapePut(incKey, bars);
      } else if (msg.tape !== undefined) {
        const patch = msg.tape;
        if (incKey === undefined) {
          const miss = new Error('PineTapeMiss: tape patch without an incKey');
          miss.name = 'PineTapeMiss';
          throw miss;
        }
        const stored = tapes.get(incKey);
        if (stored === undefined || stored.length !== patch.base || patch.from > patch.base) {
          const miss = new Error(`PineTapeMiss: worker tape for ${incKey} is ${stored?.length ?? 'absent'}, client expected ${patch.base}`);
          miss.name = 'PineTapeMiss';
          throw miss;
        }
        // Prefix equality is not re-checked: the rebuilt tape matches the
        // client's field for field, so incAdvance's own firstDiff/committed
        // and shrink checks stay authoritative.
        const rebuilt = stored.slice(0, patch.from);
        for (const b of patch.tail) rebuilt.push(b);
        bars = rebuilt;
        tapePut(incKey, rebuilt);
      } else {
        throw new Error('run message carried neither bars nor tape');
      }
      const prior = incKey !== undefined ? incSessions.get(incKey) ?? null : null;
      incRun(parsed, bars, {
        symbol: msg.opts.symbol,
        timeframe: msg.opts.timeframe,
        inputValues: msg.opts.inputValues,
        syminfo: msg.opts.syminfo,
        fetchSeries: msg.opts.hasFetch ? rpcFetch : undefined,
        incKey,
        incSession: prior,
      }).then(
        (out) => {
          if (incKey !== undefined) incPut(incKey, out.live);
          try {
            // Delta path: an advancing session's plots only changed at the
            // tail — diff BEFORE sanitize (sanitize re-wraps every Value,
            // which would both cost O(N) per tick and defeat ref-equality).
            const delta = out.live !== null ? plotsDelta(out.result.plots) : null;
            lastPlots = null; // full-result runs reset diff state
            if (delta !== null) {
              // Sanitize only the delta tails + non-plot surfaces — the plots
              // map ships EMPTY and the client patches its retained copy.
              const seen = new Set<object>();
              for (const d of delta) {
                if (d.tail) d.tail.values = d.tail.values.map(v => sanitizeValue(v, seen));
              }
              const rest = sanitizeRunResult({ ...out.result, plots: new Map() });
              post({ t: 'done', id, result: rest, plotDelta: delta, incAlive: out.live !== null });
            } else {
              const r = sanitizeRunResult(out.result);
              // Full emit — seed the diff tracker so the next tick can delta.
              if (out.live !== null) {
                lastPlots = new Map();
                for (const [k, p] of out.result.plots) {
                  lastPlots.set(k, { index: p.index, len: p.values.length, tailV: p.values[p.values.length - 1] as Value, tailC: p.colors[p.colors.length - 1], opts: p.opts });
                }
              }
              post({ t: 'done', id, result: r, incAlive: out.live !== null });
            }
          } catch (e) {
            // sanitize/post throw must still close the protocol — an uncaught
            // rejection here would hang the client's pending run forever.
            fail(id, e);
          }
          settle();
        },
        (e) => { fail(id, e); settle(); },
      );
    } catch (e) {
      // Sync throw (parse error, malformed msg.opts) — report via the fail
      // protocol instead of dying as an opaque worker.onerror.
      fail(id, e);
      settle();
    }
  };
}

// ── Worker entry ──
// Guarded: tests import this module in jsdom for createWorkerHandler — touching
// worker globals unconditionally would throw there. DedicatedWorkerGlobalScope
// instanceof excludes window/SharedWorker/ServiceWorker contexts and `self`
// being absent under plain Node ESM.
type DedicatedScope = {
  postMessage(msg: FromWorker): void;
  onmessage: ((e: MessageEvent) => void) | null;
};
const g = typeof self !== 'undefined' ? self : undefined;
const dwgs = (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope;
if (g !== undefined && typeof dwgs === 'function' && g instanceof (dwgs as new () => object)) {
  const scope = g as unknown as DedicatedScope;
  const handler = createWorkerHandler((msg) => scope.postMessage(msg));
  scope.onmessage = (e) => handler(e.data as ToWorker);
}
