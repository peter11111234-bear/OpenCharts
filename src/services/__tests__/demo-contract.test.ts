import { describe, it, expect } from 'vitest';
import { demoApi } from '../demo/api.ts';

// The demo facade's payloads are indexed by the query hooks — e.g.
// TradingPage reads `journalData?.entries`. A bare `[]` made `[].entries`
// resolve to `Array.prototype.entries` (a function) and get passed as the
// journalEntries array prop. These assertions pin the payload SHAPE to the
// contracts declared in src/services/queries.ts / api/*.
describe('demo api payload shapes (contract)', () => {
  it('getJournalEntries returns { entries: [], total } — not a bare array', async () => {
    const r = (await demoApi.getJournalEntries()) as { entries: unknown; total: unknown };
    expect(Array.isArray(r.entries)).toBe(true);
    expect(typeof r.total).toBe('number');
  });

  it('isAiTraderEnabled returns { enabled: boolean } — not a boolean', async () => {
    const r = (await demoApi.isAiTraderEnabled()) as { enabled: unknown };
    expect(typeof r.enabled).toBe('boolean');
  });

  it('getClosedPositionsSummary returns the declared summary fields', async () => {
    const r = (await demoApi.getClosedPositionsSummary()) as Record<string, unknown>;
    for (const k of ['pnl', 'commission', 'swap', 'tradeCount']) {
      expect(typeof r[k]).toBe('number');
    }
  });

  it('getFillQuality returns { avgScore, count, entries } — not a bare array', async () => {
    const r = (await demoApi.getFillQuality()) as { count: unknown; entries: unknown };
    expect(Array.isArray(r.entries)).toBe(true);
    expect(typeof r.count).toBe('number');
  });
});
