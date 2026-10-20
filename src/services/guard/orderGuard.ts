import type { ClosedPosition, Position } from "../schemas.ts";

/**
 * Pre-trade guard: pure rules, no I/O (side effects live in guardRuntime.ts).
 *
 * Borrowed from Endo's permission ruleset: rules are data, each one a pure
 * function. Borrowed from Endo's "failure is an outcome": a rule that throws
 * becomes a veto hit instead of crashing the order path (fail-closed).
 * Not borrowed: Endo's last-match-wins. Here the most severe hit wins, so a
 * later rule can never loosen an earlier veto.
 */

export type Verdict = "approve" | "reduce" | "veto";
export type GuardMode = "shadow" | "enforce";

/** shadow: log only, never change an order. enforce: veto throws, reduce halves size.
 *  Only the user flips this, after scripts/guard_report.py prints PHASE2_GATE: READY. */
export const GUARD_MODE: GuardMode = "shadow";

export const LIMITS = {
  /** Account currency. Today's realized P&L at or below -500 blocks new entries. */
  dailyLossLimit: 500,
  /** This many losses in a row today blocks entries; one fewer halves size. */
  maxConsecutiveLosses: 3,
  /** Directional reward / |entry - stopLoss|, checked only when a TP is given. A TP on the loss side is a veto. */
  minRewardRisk: 1.5,
  /** Minutes after a losing close during which new entries are blocked (revenge-trade brake). */
  cooldownMinutes: 5,
};

export interface EntryIntent {
  symbol: string;
  side: string;
  quantity: number;
  /** LIMIT level (the mobile ticket and chart quick-order send every level here). */
  price?: number;
  /** STOP level from the desktop ticket. */
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface GuardContext {
  now: Date;
  /** 0 when the engine has not seen a price for the symbol yet. */
  lastPrice: number;
  positions: Position[];
  /** Newest first, as the paper engine stores them. */
  closed: ClosedPosition[];
}

export interface Hit {
  rule: string;
  verdict: "reduce" | "veto";
  reason: string;
}

export interface Decision {
  verdict: Verdict;
  quantity: number;
  hits: Hit[];
}

type Rule = (i: EntryIntent, c: GuardContext) => Omit<Hit, "rule"> | null;

const veto = (reason: string) => ({ verdict: "veto" as const, reason });
const isBuy = (side: string) => side === "BUY";
const entryOf = (i: EntryIntent, c: GuardContext) => i.price ?? i.stopPrice ?? c.lastPrice;

function todaysClosed(c: GuardContext): ClosedPosition[] {
  const day = c.now.toDateString();
  return c.closed.filter((p) => p.closedAt != null && new Date(p.closedAt).toDateString() === day);
}

function lossStreak(c: GuardContext): number {
  let n = 0;
  for (const p of todaysClosed(c)) {
    if (p.realizedPnl >= 0) break;
    n++;
  }
  return n;
}

const ENTRY_RULES: Record<string, Rule> = {
  stop_required: (i) => (i.stopLoss == null ? veto("Entry needs a stop-loss") : null),

  stop_side: (i, c) => {
    const e = entryOf(i, c);
    if (i.stopLoss == null || !(e > 0)) return null;
    const ok = isBuy(i.side) ? i.stopLoss < e : i.stopLoss > e;
    return ok ? null : veto(`Stop-loss ${i.stopLoss} is on the wrong side of entry ${e}`);
  },

  reward_risk: (i, c) => {
    const e = entryOf(i, c);
    if (i.stopLoss == null || i.takeProfit == null || !(e > 0)) return null;
    // Directional: Math.abs would score a loss-side TP as a high R:R.
    const reward = isBuy(i.side) ? i.takeProfit - e : e - i.takeProfit;
    if (reward <= 0) return veto(`Take-profit ${i.takeProfit} is on the wrong side of entry ${e}`);
    const rr = reward / Math.abs(e - i.stopLoss);
    return rr < LIMITS.minRewardRisk
      ? veto(`Reward/risk ${rr.toFixed(2)} is below ${LIMITS.minRewardRisk}`)
      : null;
  },

  daily_loss: (_i, c) => {
    const pnl = todaysClosed(c).reduce((s, p) => s + p.realizedPnl, 0);
    return pnl <= -LIMITS.dailyLossLimit
      ? veto(`Today's realized P&L ${pnl.toFixed(2)} reached the -${LIMITS.dailyLossLimit} limit`)
      : null;
  },

  loss_streak: (_i, c) => {
    const n = lossStreak(c);
    if (n >= LIMITS.maxConsecutiveLosses) return veto(`${n} losses in a row today`);
    if (n === LIMITS.maxConsecutiveLosses - 1) {
      return { verdict: "reduce", reason: `${n} losses in a row today: half size` };
    }
    return null;
  },

  cooldown_after_loss: (_i, c) => {
    // Newest close of any date: a 23:58 loss must still brake a 00:01 entry.
    const last = c.closed[0];
    if (!last || last.realizedPnl >= 0 || last.closedAt == null) return null;
    const mins = (c.now.getTime() - new Date(last.closedAt).getTime()) / 60_000;
    return mins < LIMITS.cooldownMinutes
      ? veto(`Last trade lost ${mins.toFixed(1)} min ago: wait ${LIMITS.cooldownMinutes} min after a loss`)
      : null;
  },

  opposite_side: (i, c) => {
    const opposite = isBuy(i.side) ? "SHORT" : "LONG";
    return c.positions.some((p) => p.symbolName === i.symbol && p.side === opposite)
      ? veto("An opposite position is open. Close it instead: the paper engine does not net, so this order opens a hedge")
      : null;
  },

  average_down: (i, c) => {
    const same = isBuy(i.side) ? "LONG" : "SHORT";
    return c.positions.some((p) => p.symbolName === i.symbol && p.side === same && p.unrealizedPnl < 0)
      ? veto("Adding to a losing position")
      : null;
  },
};

const RANK: Record<Verdict, number> = { approve: 0, reduce: 1, veto: 2 };

function decide(hits: Hit[], quantity: number): Decision {
  const verdict = hits.reduce<Verdict>((v, h) => (RANK[h.verdict] > RANK[v] ? h.verdict : v), "approve");
  // TODO: ponytail debt, halving suits fractional crypto size; integer futures lots need rounding.
  return { verdict, quantity: verdict === "reduce" ? quantity / 2 : quantity, hits };
}

export function checkEntry(intent: EntryIntent, ctx: GuardContext): Decision {
  const hits: Hit[] = [];
  for (const [rule, fn] of Object.entries(ENTRY_RULES)) {
    try {
      const hit = fn(intent, ctx);
      if (hit) hits.push({ rule, ...hit });
    } catch (err) {
      hits.push({ rule, verdict: "veto", reason: `Rule failed: ${(err as Error).message}` });
    }
  }
  return decide(hits, intent.quantity);
}

/** Exit side: a stop may tighten or be set for the first time, never widen or vanish.
 *  A stop past the market is allowed: it exits at once, which reduces risk (Spec invariant). */
export function checkStopChange(pos: Position, stopLoss: number | null | undefined): Decision {
  const hits: Hit[] = [];
  if (stopLoss != null && !(Number.isFinite(stopLoss) && stopLoss > 0)) {
    // The paper engine stores any number. A stop at 0 or below is bad input, not a
    // price: it never fires on a LONG, and on a SHORT it exits on the next tick.
    hits.push({ rule: "stop_invalid", verdict: "veto", reason: `Stop-loss ${stopLoss} is not a positive price` });
    return decide(hits, pos.quantity);
  }
  if (stopLoss === null && pos.stopLoss != null) {
    hits.push({ rule: "stop_removed", verdict: "veto", reason: "Removing the stop-loss of an open position" });
  }
  if (stopLoss != null && pos.stopLoss != null) {
    const wider = pos.side === "LONG" ? stopLoss < pos.stopLoss : stopLoss > pos.stopLoss;
    if (wider) {
      hits.push({
        rule: "stop_widen",
        verdict: "veto",
        reason: `Moving the stop-loss from ${pos.stopLoss} to ${stopLoss} adds risk`,
      });
    }
  }
  return decide(hits, pos.quantity);
}
