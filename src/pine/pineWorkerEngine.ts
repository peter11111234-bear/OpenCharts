// Worker-backed scripting engine — same ScriptingEngine port as
// PineInterpreterEngine, but runScript executes inside a dedicated module
// Worker (src/pine/pineWorker.ts) so heavy scripts don't block the UI thread.
//
// One engine instance may host several concurrent execute() sessions (a chart
// can carry several pine indicators), so each session gets its own
// PineRunClient + worker via sessionRunner(); session.stop() aborts that
// session's worker without touching siblings.
//
// Fallback: no Worker global (jsdom, SSR) or worker construction failure →
// transparent in-process run via super.runProgram, identical semantics.

import { PineInterpreterEngine } from './engine';
import { PineRunClient } from './pineWorkerClient';
import type { BarData, RunResult } from './contracts';
import type { ParsedInput, RunOptions, IncLive } from './interpreter';

type SessionOpts = RunOptions & { sessionCtx?: unknown; incKey?: string; incHolder?: { live: IncLive | null; active?: boolean } };

export class PineWorkerEngine extends PineInterpreterEngine {
  private readonly clientFactory: () => PineRunClient;

  constructor(clientFactory?: () => PineRunClient) {
    super();
    this.clientFactory = clientFactory ?? (() => new PineRunClient());
  }

  protected override sessionRunner(): unknown {
    return this.clientFactory();
  }

  protected override runProgram(parsed: ParsedInput, barData: BarData[], opts: SessionOpts): Promise<RunResult> {
    const client = opts.sessionCtx instanceof PineRunClient ? opts.sessionCtx : undefined;
    if (!client || client.unavailable) return super.runProgram(parsed, barData, opts);
    // fetchSeries crosses the boundary as an RPC (stays on this side);
    // shouldAbort/sessionCtx/incSession are dropped — stop() terminates the
    // session's worker via abortRun; incHolder is the in-process holder
    // (non-cloneable) — the worker keys its own sessions by incKey.
    // `incSession` MUST be listed here: an IncLive carries the session ctx (and
    // a `callUdf` closure), so structured-cloning it throws DataCloneError.
    // RunOptions's doc says the worker keys its own map, and ClientRunOpts
    // already omits it — this destructure is what enforces that at runtime.
    const { fetchSeries, shouldAbort: _shouldAbort, sessionCtx: _ctx, incHolder, incSession: _incSession, ...rest } = opts;
    return client.run({ parsed, bars: barData, opts: { ...rest, fetchSeries } })
      .then((r) => {
        // Mirror the worker's session liveness into the holder — the engine's
        // heavy-tick exemption keys off it for the off-thread path.
        if (incHolder) incHolder.active = client.incAlive;
        return r;
      })
      .catch((e: unknown) => {
        // Construction/transport failure flips client.unavailable → in-process
        // retry keeps behavior. A 'disposed' rejection (stop raced the run) must
        // NOT re-run the script the caller already cancelled.
        const isDataClone = e instanceof Error && (e.name === 'DataCloneError' || e.message.includes('clone'));
        if (client.unavailable || isDataClone) return super.runProgram(parsed, barData, opts);
        throw e;
      });
  }

  protected override abortRun(sessionCtx: unknown): void {
    // terminate() discards the queued task list — the in-flight run dies
    // mid-flight and its pending promise rejects 'disposed', which drain
    // drops via the stopped flag. No graceful abort: terminate IS the abort.
    if (sessionCtx instanceof PineRunClient) sessionCtx.dispose();
  }
}
