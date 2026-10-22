/**
 * Front-month truth for TAIFEX futures. The broker's continuous contract
 * (e.g. TMFR1) points at the exchange's current front month via
 * `target_code`, and its `last_trading_date` follows TAIFEX postponements
 * (national holidays, typhoon days), refreshed daily (`update_date`). The
 * 3rd-Wednesday rule (frontMonthCode in instruments.ts) is only the fallback;
 * a disagreement is surfaced, because it means a postponement or stale data.
 *
 * instruments.ts builds LIVE_INSTRUMENTS synchronously at load, so the last
 * broker answer is cached in localStorage and read there; pages/velaContractRoll.ts
 * re-checks every minute and reloads the page once when the front month moves.
 */

export interface R1Info {
  target_code: string | null;
  last_trading_date: string | null;
}

export interface FrontMonthPick {
  code: string;
  source: "broker" | "rule";
  /** 繁中 message for the trader when broker and rule disagree or broker data is stale. */
  warning: string | null;
  /** Epoch ms after which this pick expires (13:45 Taipei on the last trading date). */
  validUntil: number | null;
}

const TAIPEI_OFFSET_MS = 8 * 3_600_000;
const ROLL_MINUTES = 13 * 60 + 45;
const CACHE_KEY = "opencharts.frontMonth";

/** 13:45 Taipei on a "YYYY-MM-DD" last trading date, as epoch ms. */
export function rollTimeMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - TAIPEI_OFFSET_MS + ROLL_MINUTES * 60_000;
}

/** Broker first; the rule when the broker is unreachable, incomplete, or stale. */
export function pickFrontMonth(info: R1Info | null, ruleCode: string, now: number): FrontMonthPick {
  if (!info) return { code: ruleCode, source: "rule", warning: null, validUntil: null };
  const target = info.target_code;
  const until = info.last_trading_date ? rollTimeMs(info.last_trading_date) : null;
  if (!target || until === null) {
    return { code: ruleCode, source: "rule", warning: `券商合約資料不完整，暫用規則近月 ${ruleCode}`, validUntil: null };
  }
  if (now >= until) {
    return {
      code: ruleCode,
      source: "rule",
      warning: `券商近月 ${target} 已過最後交易日（資料尚未更新），暫用規則近月 ${ruleCode}`,
      validUntil: null,
    };
  }
  return {
    code: target,
    source: "broker",
    warning: target === ruleCode ? null : `券商近月 ${target} 與規則 ${ruleCode} 不同（可能假日或颱風順延），以券商為準`,
    validUntil: until,
  };
}

/** GET the continuous contract's info from the local shioaji server; null when unreachable. */
export async function fetchR1Info(root: string, fetchImpl: typeof fetch = fetch): Promise<R1Info | null> {
  try {
    const res = await fetchImpl(`/shioaji/api/v1/data/contracts/${encodeURIComponent(`${root}R1`)}/info`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<R1Info>;
    return { target_code: j.target_code ?? null, last_trading_date: j.last_trading_date ?? null };
  } catch {
    return null;
  }
}

/** The cached broker front month for `root`, if it has not expired. */
export function readCachedFrontMonth(root: string, now: number = Date.now()): string | null {
  try {
    const c = (JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, { code?: unknown; validUntil?: unknown }>)[root];
    return c && typeof c.code === "string" && typeof c.validUntil === "number" && c.validUntil > now ? c.code : null;
  } catch {
    return null;
  }
}

/** Remember a broker pick (rule picks are never cached: the rule is recomputed anyway). */
export function writeCachedFrontMonth(root: string, pick: FrontMonthPick): void {
  try {
    const all = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, unknown>;
    if (pick.source === "broker" && pick.validUntil !== null) all[root] = { code: pick.code, validUntil: pick.validUntil };
    else delete all[root];
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the rule still works */
  }
}
