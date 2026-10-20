/**
 * Quote strip docked under the Vela charts: the active symbol's info bar
 * (price, change, day-range bar, volume) plus fixed cards for 加權 / 大台 /
 * 小台 / 微台 / 台積電. Futures use shioaji's continuous codes (R1) so the
 * cards roll to the next contract by themselves. Read-only: never touches
 * the chart.
 */
import type { ContractRef } from "../services/shioaji/server.ts";
import { toContractRef, type QuoteSnap } from "../services/shioaji/marketData.ts";
import { changeColor, ensureMarketStyles, escapeHtml, fmtBig, fmtNum, fmtPct, latestRunner } from "./marketKit.ts";

export interface StripCard {
  label: string;
  ref: ContractRef;
}

export const DEFAULT_CARDS: readonly StripCard[] = [
  { label: "加權", ref: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
  { label: "大台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "TXFR1" } },
  { label: "小台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "MXFR1" } },
  { label: "微台", ref: { security_type: "FUT", exchange: "TAIFEX", code: "TMFR1" } },
  { label: "台積電", ref: { security_type: "STK", exchange: "TSE", code: "2330" } },
];

export interface QuoteStripDeps {
  quotes: (refs: ContractRef[]) => Promise<QuoteSnap[]>;
  cards?: readonly StripCard[];
  /** How often to check whether the active symbol changed. */
  pollMs?: number;
  /** How often to refresh quotes for the same symbol. */
  refreshMs?: number;
}

export interface WidgetHandle {
  refresh(): void;
  destroy(): void;
}

function infoHtml(symbol: string, q: QuoteSnap | undefined): string {
  if (!q) return `<span class="mw-meta">${escapeHtml(symbol)} · 無報價</span>`;
  const span = q.high - q.low;
  const pos = span > 0 ? Math.min(100, Math.max(0, ((q.close - q.low) / span) * 100)) : 50;
  const color = changeColor(q.changeRate);
  return (
    `<b>${escapeHtml(symbol)}</b>` +
    `<b style="color:${color}">${fmtNum(q.close)}</b>` +
    `<span style="color:${color}">${q.changePrice > 0 ? "+" : ""}${fmtNum(q.changePrice)} (${fmtPct(q.changeRate)})</span>` +
    `<span class="mw-meta">低 ${fmtNum(q.low)}</span>` +
    `<span class="qs-range" title="今日區間"><span class="qs-range-mark" style="left:${pos.toFixed(1)}%;color:${color}"></span></span>` +
    `<span class="mw-meta">高 ${fmtNum(q.high)} · 量 ${fmtBig(q.totalVolume)}</span>`
  );
}

function cardHtml(card: StripCard, q: QuoteSnap | undefined): string {
  if (!q) return `<span class="qs-card"><span class="mw-meta">${escapeHtml(card.label)}</span><b>—</b></span>`;
  const color = changeColor(q.changeRate);
  return (
    `<span class="qs-card" title="${escapeHtml(card.ref.code)}">` +
    `<span class="mw-meta">${escapeHtml(card.label)}</span>` +
    `<b style="color:${color}">${fmtNum(q.close)} <small>${fmtPct(q.changeRate)}</small></b>` +
    `</span>`
  );
}

export function mountQuoteStrip(ctx: { readonly symbol: string }, el: HTMLElement, deps: QuoteStripDeps): WidgetHandle {
  ensureMarketStyles(el.ownerDocument);
  el.classList.add("mw", "qs-strip");
  const cards = deps.cards ?? DEFAULT_CARDS;
  let lastSymbol = "";

  const runner = latestRunner(
    async () => {
      const symbol = ctx.symbol;
      lastSymbol = symbol;
      const active = toContractRef(symbol);
      const refs = cards.map((c) => c.ref);
      if (active && !refs.some((r) => r.code === active.code && r.exchange === active.exchange)) refs.push(active);
      const quotes = await deps.quotes(refs);
      return { symbol, active, quotes };
    },
    ({ symbol, active, quotes }) => {
      const byCode = new Map(quotes.map((q) => [q.code, q]));
      const activeQuote = active ? byCode.get(active.code) : undefined;
      el.innerHTML =
        `<span class="qs-info">${infoHtml(symbol, activeQuote)}</span>` +
        cards.map((c) => cardHtml(c, byCode.get(c.ref.code))).join("");
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      el.innerHTML = `<span class="mw-warn">報價暫停：${escapeHtml(msg)}</span>`;
    },
  );

  const poll = setInterval(() => {
    if (ctx.symbol !== lastSymbol) runner.run();
  }, deps.pollMs ?? 1000);
  const tick = setInterval(() => runner.run(), deps.refreshMs ?? 5000);
  runner.run();

  return {
    refresh: () => runner.run(),
    destroy() {
      runner.dispose();
      clearInterval(poll);
      clearInterval(tick);
      el.innerHTML = "";
    },
  };
}
