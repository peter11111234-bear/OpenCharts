import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankKind, RankRow } from "../../services/shioaji/marketData.ts";
import { mountHotlistsPanel } from "../hotlists.ts";
import type { WidgetHandle } from "../quoteStrip.ts";

const row = (code: string, changeRate: number): RankRow => ({
  code,
  name: "",
  close: 100,
  changePrice: changeRate,
  changeRate,
  totalVolume: 25_000,
  totalAmount: 300_000_000,
  date: "2026-10-16",
});

describe("mountHotlistsPanel", () => {
  let body: HTMLElement;
  let handle: WidgetHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    body = document.createElement("div");
    document.body.appendChild(body);
  });

  afterEach(() => {
    handle?.destroy();
    handle = null;
    body.remove();
    vi.useRealTimers();
  });

  it("starts on 漲幅 and lists rows with the data date", async () => {
    const ranking = vi.fn(async (_k: RankKind) => [row("2330", 9.9), row("6547", 5)]);
    handle = mountHotlistsPanel(body, { ranking, onPick: vi.fn() });
    await vi.waitFor(() => expect(body.querySelectorAll("tr[data-code]")).toHaveLength(2));
    expect(ranking).toHaveBeenCalledWith("gainers");
    expect(body.textContent).toContain("資料日 2026-10-16");
    expect(body.querySelector("button[data-active]")!.textContent).toBe("漲幅");
    expect(body.innerHTML).toContain("#f23645");
  });

  it("switching tab fetches that ranking; amount shows 億", async () => {
    const ranking = vi.fn(async (_k: RankKind) => [row("2330", -3)]);
    handle = mountHotlistsPanel(body, { ranking, onPick: vi.fn() });
    await vi.waitFor(() => expect(ranking).toHaveBeenCalledTimes(1));
    body.querySelector<HTMLButtonElement>('button[data-kind="amount"]')!.click();
    await vi.waitFor(() => expect(ranking).toHaveBeenLastCalledWith("amount"));
    await vi.waitFor(() => expect(body.textContent).toContain("億"));
    expect(body.querySelector("button[data-active]")!.textContent).toBe("成交金額");
  });

  it("keeps the old table (dimmed) while a new tab loads, so nothing below it jumps", async () => {
    let release!: (rows: RankRow[]) => void;
    const ranking = vi.fn(async (k: RankKind) =>
      k === "gainers" ? [row("2330", 9.9)] : new Promise<RankRow[]>((r) => (release = r)),
    );
    handle = mountHotlistsPanel(body, { ranking, onPick: vi.fn() });
    await vi.waitFor(() => expect(body.querySelector('tr[data-code="2330"]')).not.toBeNull());
    body.querySelector<HTMLButtonElement>('button[data-kind="losers"]')!.click();
    await vi.waitFor(() => expect(ranking).toHaveBeenLastCalledWith("losers"));
    expect(body.querySelector('tr[data-code="2330"]')).not.toBeNull();
    const list = body.querySelector<HTMLElement>(".hl-table")!.parentElement!;
    expect(list.style.opacity).toBe("0.4");
    release([row("6141", -9.9)]);
    await vi.waitFor(() => expect(body.querySelector('tr[data-code="6141"]')).not.toBeNull());
    expect(list.style.opacity).toBe("");
  });

  it("clicking a row picks its code", async () => {
    const onPick = vi.fn();
    handle = mountHotlistsPanel(body, { ranking: async () => [row("6547", 1)], onPick });
    await vi.waitFor(() => expect(body.querySelector("tr[data-code]")).not.toBeNull());
    body.querySelector<HTMLElement>("tr[data-code] td")!.click();
    expect(onPick).toHaveBeenCalledWith("6547");
  });

  it("empty and failing rankings show a message", async () => {
    handle = mountHotlistsPanel(body, { ranking: async () => [], onPick: vi.fn() });
    await vi.waitFor(() => expect(body.textContent).toContain("無資料"));
    handle.destroy();
    handle = mountHotlistsPanel(body, {
      ranking: async () => {
        throw new Error("down");
      },
      onPick: vi.fn(),
    });
    await vi.waitFor(() => expect(body.textContent).toContain("無法取得排行：down"));
  });
});
