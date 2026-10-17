/**
 * Bar plumbing for the Pine perf harness: load → normalise → resample → serve
 * `request.security` requests, plus the two shape conversions the engine uses.
 *
 * Two bar shapes exist in the repo and the harness spans both:
 *   - `OHLCV`  (`@luxalgo/vela`, `{time, open, high, low, close, volume}`) —
 *     the shape Vela hands to `ExecutionRequest.bars` / `FetchSeries`.
 *   - `BarData` (`src/pine/contracts`, `{openTime, ...}`) — the shape
 *     `runScript` / prepared-AST execution consume.
 * `toBarData` mirrors `engine.ts:103` and `toFetch` mirrors `engine.ts:118`
 * (both are module-private there); they are mirrored, not re-invented, so the
 * `direct` path feeds the interpreter the exact same series the `app` path does
 * — that is what makes the H3 `app` vs `direct` comparison meaningful.
 */

import { tfFloor, tfNext, tfToMs } from './pine.mjs';

/** Copy of `FETCH_WARMUP` / `FETCH_CAP` (engine.ts:116-117). */
const FETCH_WARMUP = 500;
const FETCH_CAP = 20_000;

/** ms per tf, or null for calendar units (`tfToMs` semantics). */
export const tfMs = (tf) => tfToMs(tf);

// ── loading ─────────────────────────────────────────────────────────────────

/**
 * Accepts the fixture's compact `{t,o,h,l,c}` rows as well as Vela's own
 * `{time|openTime, open, high, low, close, volume}` — a `--bars-file` may be
 * either. Always returns rows sorted by open time.
 */
export function normalizeBars(raw) {
  const rows = raw.map((b) => {
    const openTime = b.t ?? b.time ?? b.openTime;
    if (typeof openTime !== 'number' || !Number.isFinite(openTime)) {
      throw new Error(`bar without a numeric t/time/openTime: ${JSON.stringify(b)}`);
    }
    const row = {
      openTime,
      open: Number(b.o ?? b.open),
      high: Number(b.h ?? b.high),
      low: Number(b.l ?? b.low),
      close: Number(b.c ?? b.close),
      volume: Number(b.v ?? b.volume ?? 0),
    };
    for (const k of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(row[k])) {
        throw new Error(`bar at t=${openTime} has a non-numeric ${k}: ${JSON.stringify(b)}`);
      }
    }
    return row;
  });
  rows.sort((a, b) => a.openTime - b.openTime);
  return rows;
}

// ── shape conversions ───────────────────────────────────────────────────────

/** BarData → OHLCV (Vela's shape). */
export const toOHLCV = (bars) =>
  bars.map((b) => ({ time: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

/** OHLCV → BarData. Mirror of engine.ts:103 `toBarData`. */
export const toBarData = (bars) =>
  bars.map((b) => ({ openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));

// ── resampling ──────────────────────────────────────────────────────────────

/**
 * Collapse `bars` into `tf` buckets. Bucketing goes through the engine's own
 * `tfFloor` (mtf.ts:94), so intraday/D/W/M all follow one code path and match
 * what `request.security` would have seen from the local resampler
 * (`src/services/shioaji/candles.ts` — kbars only serves 1m, every other tf is
 * resampled locally). OHLC + volume merge; open of the first bar wins.
 */
export function resampleTf(bars, tf) {
  const buckets = new Map();
  for (const b of bars) {
    const key = tfFloor(b.openTime, tf);
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { ...b, openTime: key });
    else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

// ── security series host ────────────────────────────────────────────────────

/**
 * Build the harness's `request.security` gateway over a base series.
 *
 * `baseTf` is the timeframe of `baseBars`; a request for a FINER tf than the
 * base cannot be served by resampling (that would need real sub-bars), so it
 * returns `[]` and records the tf in `diag.blockedTfs` — H4 wants the reason
 * spelled out, never a silent zero.
 *
 * `range` is Vela's `BarRange` (`{limit, to?}`); `to`/`limit` are honoured so
 * the series is the same length the `app` path's engine-side `toFetch` wrapper
 * would have requested. `diag` doubles as the H4 evidence record.
 */
export function makeSecurityGateway(baseBars, baseTf) {
  const baseMs = tfToMs(baseTf);
  const diag = {
    baseTf,
    baseBars: baseBars.length,
    calls: 0,
    served: 0,
    empty: 0,
    blocked: 0,
    requestedTfs: {},
    blockedTfs: [],
    lastLimit: null,
  };
  const fetchSeries = (_symbol, tf, range) => {
    diag.calls++;
    diag.requestedTfs[tf] = (diag.requestedTfs[tf] ?? 0) + 1;
    const wantMs = tfToMs(tf);
    if (wantMs !== null && baseMs !== null && wantMs < baseMs) {
      diag.blocked++;
      if (!diag.blockedTfs.includes(tf)) diag.blockedTfs.push(tf);
      return [];
    }
    let out = resampleTf(baseBars, tf);
    if (typeof range?.to === 'number') out = out.filter((b) => b.openTime <= range.to);
    if (typeof range?.limit === 'number' && range.limit > 0) {
      diag.lastLimit = range.limit;
      out = out.slice(-range.limit);
    }
    if (out.length === 0) diag.empty++;
    else diag.served++;
    return toOHLCV(out);
  };
  return { fetchSeries, diag };
}

/**
 * Mirror of engine.ts:118 `toFetch`: Vela `FetchSeries` (OHLCV, span-aware
 * limit) → interpreter fetchSeries (BarData). `bars` is the chart series the
 * span is measured from, `tfFloor`/`tfNext` do the calendar-aware count.
 */
export function toFetch(fetch, chartBars) {
  if (!fetch) return undefined;
  const first = chartBars[0]?.openTime;
  const to = chartBars[chartBars.length - 1]?.openTime;
  const limit = (tf) => {
    if (first === undefined || to === undefined || to <= first) {
      return Math.min(Math.max(chartBars.length * 4, FETCH_WARMUP), FETCH_CAP);
    }
    let n = 0;
    for (let t = tfFloor(first, tf); t <= to && n < FETCH_CAP; n++) t = tfNext(t, tf);
    return Math.min(Math.max(n + FETCH_WARMUP, FETCH_WARMUP), FETCH_CAP);
  };
  return async (symbol, tf) => {
    const lim = limit(tf);
    const out = await fetch(symbol, tf, to !== undefined ? { limit: lim, to } : { limit: lim });
    return toBarData(out);
  };
}

// ── live kbars (optional `--fetch-bars`) ────────────────────────────────────

const KbarsClient = {
  base: 'http://127.0.0.1:8080',
  path: '/api/v1/data/kbars',
};

/**
 * Pull 1m bars from the local shioaji server (`src/services/shioaji/server.ts`
 * documents the endpoint; kbars only serves 1m, so this is the only route to a
 * series finer than the chart tf). Taipei wall-clock strings → epoch ms.
 * Over-fetches by a margin then slices the last `n` so the request always lands
 * `n` bars when the session carries them.
 */
export async function fetchKbars({ code = 'MXFJ6', securityType = 'FUT', exchange = 'TAIFEX', n = 500, endMs } = {}) {
  const perDay = 270; // MXF day session ≈ 300 1m bars; under-count → over-fetch
  const days = Math.ceil(n / perDay) + 5;
  const end = endMs ?? Date.now();
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const start = iso(end - days * 86_400_000);
  const res = await fetch(`${KbarsClient.base}${KbarsClient.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract: { security_type: securityType, exchange, code }, start, end: iso(end) }),
  });
  if (!res.ok) throw new Error(`kbars ${res.status} ${res.statusText} (${KbarsClient.base}${KbarsClient.path})`);
  const j = await res.json();
  if (!Array.isArray(j.datetime) || j.datetime.length === 0) {
    throw new Error(`kbars returned 0 bars for ${code} ${start}..${iso(end)} — is TAIWAN_TAIPEI_TIME covered by the session?`);
  }
  const rows = j.datetime.map((dt, i) => ({
    // Server emits Taipei wall clock without an offset.
    t: new Date(`${dt}+08:00`).getTime(),
    o: j.Open[i], h: j.High[i], l: j.Low[i], c: j.Close[i], v: j.Volume[i],
  }));
  const source = { kind: 'kbars', code, securityType, exchange, start, end: iso(end), returned: rows.length };
  return { bars: normalizeBars(rows).slice(-n), source };
}
