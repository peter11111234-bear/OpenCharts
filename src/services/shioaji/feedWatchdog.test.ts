import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscribeQuote = vi.fn(async () => ({}));

vi.mock("./server.ts", () => ({
  getSnapshots: vi.fn(async () => []),
  subscribeQuote: (...a: unknown[]) => subscribeQuote(...(a as [])),
  tickStreamPath: () => "/stream",
  tickEventName: () => "tick",
  openEventSource: () => ({ readyState: 1, close: () => {}, addEventListener: () => {}, onerror: null }),
}));
vi.mock("../demo/bus.ts", () => ({ publish: vi.fn() }));
vi.mock("../demo/engine.ts", () => ({ mark: vi.fn() }));

/** Taipei wall clock → epoch ms. 2026-10-21 is a Wednesday. */
const tw = (hhmm: string, d = "2026-10-21") => Date.parse(`${d}T${hhmm}:00+08:00`);

async function runFeedFor(startMs: number, runMs: number): Promise<number> {
  vi.setSystemTime(startMs);
  const { startShioajiFeed } = await import("./feed.ts");
  await startShioajiFeed();
  const afterStart = subscribeQuote.mock.calls.length; // the initial subscribeAll
  await vi.advanceTimersByTimeAsync(runMs);
  return subscribeQuote.mock.calls.length - afterStart;
}

describe("feed watchdog (E2): resubscribe only while a market should be quoting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", class { static CLOSED = 2; });
    subscribeQuote.mockClear();
  });
  afterEach(async () => {
    const { stopShioajiFeed } = await import("./feed.ts");
    stopShioajiFeed();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays silent after the close (stocks 13:30, futures gap 13:45–15:00)", async () => {
    expect(await runFeedFor(tw("14:00"), 60_000)).toBe(0);
  });

  it("stays silent on a weekend", async () => {
    expect(await runFeedFor(tw("10:00", "2026-10-24"), 60_000)).toBe(0);
  });

  it("still resubscribes a silent stream during the session", async () => {
    expect(await runFeedFor(tw("10:00"), 60_000)).toBeGreaterThan(0);
  });
});
