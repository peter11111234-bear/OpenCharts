import type { Candle } from "../../services/schemas.ts";

/**
 * Older bars loaded by scrolling the chart left, kept together with the time
 * base they were fetched in.
 *
 * The demo history is time-shifted at runtime, and that shift re-anchors its
 * whole series whenever the wall clock leaves the anchored period. Bars held
 * from before such a move are therefore one or more periods behind a freshly
 * fetched payload; merging them without sliding leaves a hole at the seam that
 * grows by one bar per period. `anchor` is the payload's newest bar at the time
 * the bars were fetched, which is exactly the base they are expressed in.
 */
export type HistoricalExtension = { bars: Candle[]; anchor: number };

/** Nothing loaded yet, and no base to slide onto. */
export const EMPTY_EXTENSION: HistoricalExtension = { bars: [], anchor: 0 };

/**
 * Express a held extension in `anchor`'s base. A missing base on either side
 * means there is nothing to slide, so the bars are returned untouched.
 */
export function rebaseExtension(ext: HistoricalExtension, anchor: number): Candle[] {
  if (ext.bars.length === 0 || ext.anchor === 0 || anchor === 0) return ext.bars;
  const shift = anchor - ext.anchor;
  return shift === 0 ? ext.bars : ext.bars.map((c) => ({ ...c, time: Number(c.time) + shift }));
}

/**
 * Prepend a batch, already expressed in `anchor`, to the held extension, moving
 * whatever is already held onto that same base first.
 *
 * `anchor` must be the base the batch was fetched in. A batch whose base has
 * moved on in the meantime — reachable only with a provider that answers slower
 * than one period — would reopen the seam this slide exists to close.
 */
export function prependExtension(
  prev: HistoricalExtension,
  bars: Candle[],
  anchor: number,
): HistoricalExtension {
  if (anchor === 0) return { bars: [...bars, ...prev.bars], anchor: prev.anchor };
  return { bars: [...bars, ...rebaseExtension(prev, anchor)], anchor };
}
