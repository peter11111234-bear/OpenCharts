/**
 * Hotlists side panel (TradingView "Stock Market" hotlists look) on shioaji's
 * scanner: 漲幅 / 跌幅 / 成交量 / 成交金額, latest trading day. Clicking a row
 * switches the active chart to that stock (explicit click only).
 */
import { isTwStockSession, type RankKind, type RankRow } from "../services/shioaji/marketData.ts";
import { changeColor, ensureMarketStyles, escapeHtml, fmtBig, fmtNum, fmtPct, latestRunner } from "./marketKit.ts";
import type { WidgetHandle } from "./quoteStrip.ts";

export const HOTLIST_TABS: ReadonlyArray<[RankKind, string]> = [
  ["gainers", "漲幅"],
  ["losers", "跌幅"],
  ["volume", "成交量"],
  ["amount", "成交金額"],
];

export interface HotlistsDeps {
  ranking: (kind: RankKind) => Promise<RankRow[]>;
  /** Called with the stock code of a clicked row. */
  onPick: (code: string) => void;
  refreshMs?: number;
  /** Timer refreshes only run while this is true (default: TW stock session).
   *  The mount-time load always runs so the last trading day still shows. */
  isOpen?: () => boolean;
}

export function mountHotlistsPanel(body: HTMLElement, deps: HotlistsDeps): WidgetHandle {
  const doc = body.ownerDocument;
  ensureMarketStyles(doc);
  const root = doc.createElement("div");
  root.className = "mw";
  root.style.padding = "8px";
  body.appendChild(root);

  let kind: RankKind = "gainers";
  const tabs = doc.createElement("div");
  tabs.className = "hl-tabs";
  for (const [k, label] of HOTLIST_TABS) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.kind = k;
    tabs.appendChild(b);
  }
  const list = doc.createElement("div");
  root.append(tabs, list);

  const markTab = () => {
    for (const b of tabs.querySelectorAll("button")) {
      if ((b as HTMLButtonElement).dataset.kind === kind) b.setAttribute("data-active", "");
      else b.removeAttribute("data-active");
    }
  };

  const runner = latestRunner(
    async () => {
      const k = kind;
      return { k, rows: await deps.ranking(k) };
    },
    ({ k, rows }) => {
      list.style.opacity = "";
      if (rows.length === 0) {
        list.innerHTML = `<div class="mw-meta">無資料</div>`;
        return;
      }
      const last = k === "amount" ? "金額" : "量";
      list.innerHTML =
        `<div class="mw-meta">資料日 ${escapeHtml(rows[0]!.date)} · 點列切換商品</div>` +
        `<table class="hl-table"><tbody>` +
        rows
          .map((r, i) => {
            const big = k === "amount" ? r.totalAmount : r.totalVolume;
            return (
              `<tr data-code="${escapeHtml(r.code)}">` +
              `<td class="mw-meta">${i + 1}</td>` +
              `<td><b>${escapeHtml(r.code)}</b> <span class="mw-meta">${escapeHtml(r.name)}</span></td>` +
              `<td class="num">${fmtNum(r.close)}</td>` +
              `<td class="num" style="color:${changeColor(r.changeRate)}">${fmtPct(r.changeRate)}</td>` +
              `<td class="num mw-meta" title="${last}">${fmtBig(big)}</td>` +
              `</tr>`
            );
          })
          .join("") +
        `</tbody></table>`;
    },
    (err) => {
      list.style.opacity = "";
      const msg = err instanceof Error ? err.message : String(err);
      list.innerHTML = `<div class="mw-warn">無法取得排行：${escapeHtml(msg)}</div>`;
    },
  );

  tabs.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest?.("button") as HTMLButtonElement | null;
    const k = b?.dataset.kind as RankKind | undefined;
    if (!k || k === kind) return;
    kind = k;
    markTab();
    // Keep the old table (dimmed) until the new one arrives: swapping in a
    // one-line "loading" placeholder collapsed the list and made whatever sits
    // below it (the rating) jump up and back down.
    list.style.opacity = "0.4";
    runner.run();
  });
  list.addEventListener("click", (ev) => {
    const tr = (ev.target as HTMLElement).closest?.("tr[data-code]") as HTMLElement | null;
    if (tr?.dataset.code) deps.onPick(tr.dataset.code);
  });

  markTab();
  // Rankings are stock-only and frozen outside the session — don't spend the
  // Shioaji daily quota re-fetching them after the close or overnight.
  const isOpen = deps.isOpen ?? (() => isTwStockSession(new Date()));
  const tick = setInterval(() => {
    if (isOpen()) runner.run();
  }, deps.refreshMs ?? 30_000);
  runner.run();

  return {
    refresh: () => runner.run(),
    destroy() {
      runner.dispose();
      clearInterval(tick);
      root.remove();
    },
  };
}
