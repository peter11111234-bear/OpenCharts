/**
 * Demo API facade.
 *
 * OpenCharts runs without a backend: all real data the terminal needs is served
 * by the in-browser demo layer (services/demo). `api` is the demo implementation
 * wrapped in a Proxy whose fallback returns a benign async no-op for any method
 * not implemented in demo mode — so leftover calls from non-terminal code resolve
 * harmlessly instead of throwing network errors.
 */
import { demoApi } from "./demo/api.ts";

export const API_BASE = "";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// react-query rejects `undefined` query results, so resolve to null instead.
const benign = () => Promise.resolve(null);

/**
 * A demo method keeps the payload it returns and accepts the real API's
 * arguments. The demo's terminal stubs are declared with no (or fewer)
 * parameters — the demo ignores them — while call sites pass what the HTTP layer
 * takes. Widening here preserves the payload types (the only part of the demo's
 * behaviour a caller can observe) AND the first N arguments still type-check;
 * only the extras are unconstrained.
 */
type WidenArgs<T> = {
  [K in keyof T]: T[K] extends (...a: infer A extends unknown[]) => infer R
    ? (...a: [...A, ...unknown[]]) => R
    : T[K];
};

/**
 * The back-office surface: competitions, leaderboard, firm, bots, payouts,
 * analytics, push, tickets, profiles. NO demo implementation exists, so every
 * call resolves to the benign `null` above. Declared one name at a time rather
 * than as an index signature — under `noUncheckedIndexedAccess` an index
 * signature makes each miss `Stub | undefined`, which pushed a pointless
 * `possibly undefined` guard onto every call site (and `never[]` made the
 * arguments uncallable). Arguments stay permissive: the real argument lists live
 * in a backend this repo does not ship, and the demo ignores them.
 */
export interface BackofficeApi {
  changePassword(...args: unknown[]): Promise<unknown>;
  clearAiTraderHistory(...args: unknown[]): Promise<unknown>;
  closeTicket(...args: unknown[]): Promise<unknown>;
  connectBot(...args: unknown[]): Promise<unknown>;
  createAiTraderPlan(...args: unknown[]): Promise<unknown>;
  createBotIntegration(...args: unknown[]): Promise<unknown>;
  createScalingPlan(...args: unknown[]): Promise<unknown>;
  createTicket(...args: unknown[]): Promise<unknown>;
  deleteBotIntegration(...args: unknown[]): Promise<unknown>;
  disconnectBot(...args: unknown[]): Promise<unknown>;
  enrollInCompetition(...args: unknown[]): Promise<unknown>;
  enrollScaling(...args: unknown[]): Promise<unknown>;
  executeAiTraderPlan(...args: unknown[]): Promise<unknown>;
  getActiveCompetitions(...args: unknown[]): Promise<unknown>;
  getAiTraderHistory(...args: unknown[]): Promise<unknown>;
  getAllPayouts(...args: unknown[]): Promise<unknown>;
  getAnalyticsAggregate(...args: unknown[]): Promise<unknown>;
  getAnalyticsSnapshots(...args: unknown[]): Promise<unknown>;
  getBotActivityLogs(...args: unknown[]): Promise<unknown>;
  getBotIntegrations(...args: unknown[]): Promise<unknown>;
  getBotStatus(...args: unknown[]): Promise<unknown>;
  getCompetitionRankings(...args: unknown[]): Promise<unknown>;
  getDailyPnl(...args: unknown[]): Promise<unknown>;
  getFirmLeaderboard(...args: unknown[]): Promise<unknown>;
  getLeaderboard(...args: unknown[]): Promise<unknown>;
  getLeaderboardPrizes(...args: unknown[]): Promise<unknown>;
  getLeaderboardStats(...args: unknown[]): Promise<unknown>;
  getMergeRequests(...args: unknown[]): Promise<unknown>;
  getMyAwards(...args: unknown[]): Promise<unknown>;
  getMyCertificates(...args: unknown[]): Promise<unknown>;
  getMyCompetitionEntries(...args: unknown[]): Promise<unknown>;
  getMyFirm(...args: unknown[]): Promise<unknown>;
  getMyLeaderboardRank(...args: unknown[]): Promise<unknown>;
  getMyProfitSplit(...args: unknown[]): Promise<unknown>;
  getMyTickets(...args: unknown[]): Promise<unknown>;
  getPatterns(...args: unknown[]): Promise<unknown>;
  getPreferences(...args: unknown[]): Promise<unknown>;
  getProfitSplitConfig(...args: unknown[]): Promise<unknown>;
  getPublicProfile(...args: unknown[]): Promise<unknown>;
  getPublicProfiles(...args: unknown[]): Promise<unknown>;
  getPushSubscriptions(...args: unknown[]): Promise<unknown>;
  getScalingPlans(...args: unknown[]): Promise<unknown>;
  getScalingProgress(...args: unknown[]): Promise<unknown>;
  getTicket(...args: unknown[]): Promise<unknown>;
  getVapidPublicKey(...args: unknown[]): Promise<unknown>;
  markAllAnnouncementsRead(...args: unknown[]): Promise<unknown>;
  markAnnouncementRead(...args: unknown[]): Promise<unknown>;
  processMergeRequest(...args: unknown[]): Promise<unknown>;
  replyToTicket(...args: unknown[]): Promise<unknown>;
  requestAccountMerge(...args: unknown[]): Promise<unknown>;
  sendTestNotification(...args: unknown[]): Promise<unknown>;
  subscribePush(...args: unknown[]): Promise<unknown>;
  testBotIntegration(...args: unknown[]): Promise<unknown>;
  unsubscribePush(...args: unknown[]): Promise<unknown>;
  updateBotIntegration(...args: unknown[]): Promise<unknown>;
  updateProfile(...args: unknown[]): Promise<unknown>;
  updateProfitSplitConfig(...args: unknown[]): Promise<unknown>;
  validateCoupon(...args: unknown[]): Promise<unknown>;
}

// The Proxy's `get` answers every name, and no structural type expresses that —
// the facade type above IS the contract, so the double assertion is principled
// (and stays `unknown`, never `any`).
export const api = new Proxy(demoApi as Record<string, unknown>, {
  get(target, prop: string) {
    if (prop in target) return target[prop];
    return benign;
  },
}) as unknown as WidenArgs<typeof demoApi> & BackofficeApi;
