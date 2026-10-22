import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchR1Info,
  pickFrontMonth,
  readCachedFrontMonth,
  rollTimeMs,
  writeCachedFrontMonth,
} from "../shioaji/frontMonth.ts";

const taipei = (iso: string) => new Date(`${iso}+08:00`).getTime();

describe("rollTimeMs", () => {
  it("is 13:45 Taipei on the last trading date", () => {
    expect(rollTimeMs("2026-11-18")).toBe(taipei("2026-11-18T13:45:00"));
    expect(rollTimeMs("2026/11/18")).toBeNull();
  });
});

describe("pickFrontMonth", () => {
  const now = taipei("2026-10-21T14:10:00");

  it("uses the broker when it agrees with the rule", () => {
    expect(pickFrontMonth({ target_code: "TMFK6", last_trading_date: "2026-11-18" }, "TMFK6", now)).toEqual({
      code: "TMFK6",
      source: "broker",
      warning: null,
      validUntil: taipei("2026-11-18T13:45:00"),
    });
  });

  it("follows a holiday / typhoon postponement and warns", () => {
    // Settlement moved from Wed 10-21 to Thu 10-22: the broker still points at TMFJ6.
    const p = pickFrontMonth({ target_code: "TMFJ6", last_trading_date: "2026-10-22" }, "TMFK6", now);
    expect(p.code).toBe("TMFJ6");
    expect(p.source).toBe("broker");
    expect(p.warning).toContain("順延");
  });

  it("falls back to the rule when broker data is stale (past its last trading day)", () => {
    const p = pickFrontMonth({ target_code: "TMFJ6", last_trading_date: "2026-10-21" }, "TMFK6", now);
    expect(p).toMatchObject({ code: "TMFK6", source: "rule", validUntil: null });
    expect(p.warning).toContain("尚未更新");
  });

  it("falls back to the rule silently when the server is unreachable", () => {
    expect(pickFrontMonth(null, "TMFK6", now)).toEqual({ code: "TMFK6", source: "rule", warning: null, validUntil: null });
  });

  it("falls back with a warning on incomplete broker data", () => {
    const p = pickFrontMonth({ target_code: null, last_trading_date: "2026-11-18" }, "TMFK6", now);
    expect(p).toMatchObject({ code: "TMFK6", source: "rule" });
    expect(p.warning).toContain("不完整");
  });

  it("rolls across the year end", () => {
    const dec = taipei("2026-12-16T14:00:00");
    expect(pickFrontMonth({ target_code: "TMFA7", last_trading_date: "2027-01-20" }, "TMFA7", dec).code).toBe("TMFA7");
  });
});

// The shared case file is the single source of truth for the three front-month
// implementations (web, jev-shadow.py, shioaji-watchdog.ps1).
const casesPath = resolve(process.cwd(), "scripts", "front_month_cases.json");
const sharedCases = JSON.parse(readFileSync(casesPath, "utf-8")) as Array<{
  name: string;
  info: { target_code: string | null; last_trading_date: string | null } | null;
  rule_code: string;
  now_taipei: string;
  expect_code: string;
  expect_source: "broker" | "rule";
  expect_warning: boolean;
}>;

describe("shared front-month cases", () => {
  it.each(sharedCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const now = taipei(c.now_taipei);
    const p = pickFrontMonth(c.info, c.rule_code, now);
    expect(p.code).toBe(c.expect_code);
    expect(p.source).toBe(c.expect_source);
    expect(p.warning === null).toBe(!c.expect_warning);
  });
});

describe("fetchR1Info", () => {
  it("reads target_code and last_trading_date from the R1 contract", async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ code: "TMFR1", target_code: "TMFK6", last_trading_date: "2026-11-18", tick: 1 })),
    ) as unknown as typeof fetch;
    expect(await fetchR1Info("TMF", f)).toEqual({ target_code: "TMFK6", last_trading_date: "2026-11-18" });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/shioaji/api/v1/data/contracts/TMFR1/info");
  });

  it("returns null on HTTP error or network failure", async () => {
    expect(await fetchR1Info("TMF", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchR1Info("TMF", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("front-month cache", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a broker pick until it expires, and never caches rule picks", () => {
    const until = taipei("2026-11-18T13:45:00");
    writeCachedFrontMonth("TMF", { code: "TMFK6", source: "broker", warning: null, validUntil: until });
    expect(readCachedFrontMonth("TMF", until - 1)).toBe("TMFK6");
    expect(readCachedFrontMonth("TMF", until)).toBeNull();

    writeCachedFrontMonth("TMF", { code: "TMFK6", source: "rule", warning: null, validUntil: null });
    expect(readCachedFrontMonth("TMF", until - 1)).toBeNull();
  });

  it("survives garbage in storage", () => {
    localStorage.setItem("opencharts.frontMonth", "{not json");
    expect(readCachedFrontMonth("TMF")).toBeNull();
  });
});
