// ── Pine worker entry ────────────────────────────────────────────────────────
// Hosts runScript inside a Web Worker. createWorkerHandler is the pure piece:
// given a post() sink it returns the onmessage handler, so tests drive it
// directly while the real worker entry at the bottom wires it to `self`.
// Protocol: pineWorkerProto.ts / docs/superpowers/plans/2026-10-09-b4-worker.md.

// Side-effect imports: register all builtins + MTF request handlers. Without
// these the worker would evaluate scripts against an empty registry.
import './builtins/index';
import './mtf';

import { runScript } from './interpreter';
import { parse } from './parser';
import type { BarData } from './contracts';
import type { FromWorker, ToWorker } from './pineWorkerProto';
import { marshalError, sanitizeRunResult } from './pineMarshal';

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

  return (msg) => {
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
      runScript(parse(msg.source), msg.bars, {
        symbol: msg.opts.symbol,
        timeframe: msg.opts.timeframe,
        inputValues: msg.opts.inputValues,
        syminfo: msg.opts.syminfo,
        fetchSeries: msg.opts.hasFetch ? rpcFetch : undefined,
      }).then(
        (r) => {
          try {
            post({ t: 'done', id, result: sanitizeRunResult(r) });
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
