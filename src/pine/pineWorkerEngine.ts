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
import type { RunOptions } from './interpreter';

type SessionOpts = RunOptions & { sessionCtx?: unknown };

export class PineWorkerEngine extends PineInterpreterEngine {
  private readonly clientFactory: () => PineRunClient;

  constructor(clientFactory?: () => PineRunClient) {
    super();
    this.clientFactory = clientFactory ?? (() => new PineRunClient());
  }

  protected override sessionRunner(): unknown {
    return this.clientFactory();
  }

  protected override runProgram(source: string, barData: BarData[], opts: SessionOpts): Promise<RunResult> {
    const client = opts.sessionCtx instanceof PineRunClient ? opts.sessionCtx : undefined;
    if (!client || client.unavailable) return super.runProgram(source, barData, opts);
    // fetchSeries crosses the boundary as an RPC (stays on this side);
    // shouldAbort/sessionCtx are dropped — stop() terminates the session's
    // worker via abortRun rather than polling a flag.
    const { fetchSeries, shouldAbort: _shouldAbort, sessionCtx: _ctx, ...rest } = opts;
    return client.run({ source, bars: barData, opts: { ...rest, fetchSeries } }).catch((e: unknown) => {
      // Construction/transport failure flips client.unavailable → in-process
      // retry keeps behavior. A 'disposed' rejection (stop raced the run) must
      // NOT re-run the script the caller already cancelled.
      if (client.unavailable) return super.runProgram(source, barData, opts);
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
