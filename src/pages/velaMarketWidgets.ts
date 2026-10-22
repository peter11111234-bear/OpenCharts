/**
 * Registers the quote widgets with Vela (side effect — imported once by
 * VelaPage): the quote strip (auto-docked under the charts), the theme
 * heatmap and the hotlists side panels plus their topbar toggles. All data
 * comes from the local shioaji server; see services/shioaji/marketData.ts.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module
 * instances — see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, registerWidgetAction, registerWidgetAttachment } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import {
  fetchContractInfo,
  fetchIndexEntries,
  fetchQuotes,
  fetchRanking,
} from "../services/shioaji/marketData.ts";
import { HEATMAP_WINDOW_CHANNEL, mountHeatmapPanel } from "./heatmap.ts";
import { mountHotlistsPanel } from "./hotlists.ts";
import { mountQuoteStrip } from "./quoteStrip.ts";
import { mountRating } from "./velaTechRating.ts";

const HEATMAP_ID = "opencharts.heatmap";
const HOTLISTS_ID = "opencharts.hotlists";

registerIcon("heatmap", svg16('<rect x="2" y="2" width="7" height="7"/><rect x="10" y="2" width="4" height="4"/><rect x="10" y="7" width="4" height="7"/><rect x="2" y="10" width="7" height="4"/>'));
registerIcon("hotlist", svg16('<path d="M3 4h10M3 8h7M3 12h4"/>'));

registerWidgetAttachment({
  id: "opencharts.quote-strip",
  mount(ctx) {
    const doc = ctx.host.ownerDocument;
    if (doc.querySelector(".qs-strip")) return () => {}; // one strip per page
    const el = doc.createElement("div");
    const undock = ctx.dockStrip(el);
    const strip = mountQuoteStrip(ctx, el, { quotes: (refs) => fetchQuotes(refs) });
    // Heatmap-window picks switch THIS chart. Bound to the mount (not a module
    // global) so a remount (StrictMode, HMR) never leaves a dead ctx listening,
    // and a heatmap window opened by URL works without the topbar button.
    const picks = new BroadcastChannel(HEATMAP_WINDOW_CHANNEL);
    picks.onmessage = (e: MessageEvent<{ t?: string; symbol?: string }>) => {
      if (e.data?.t === "pick" && e.data.symbol) ctx.setSymbol(e.data.symbol);
    };
    return () => {
      picks.close();
      strip.destroy();
      undock();
    };
  },
});

registerSidePanel({
  id: HEATMAP_ID,
  title: "主題熱力圖",
  icon: "heatmap",
  width: 360,
  resizable: true,
  minWidth: 280,
  mount(ctx, body) {
    const panel = mountHeatmapPanel(body, {
      entries: async () => (await Promise.all([fetchIndexEntries(), fetchIndexEntries(undefined, "OTC")])).flat(),
      onPick: (symbol) => ctx.setSymbol(symbol),
    });
    return {
      onOpen() {
        panel.refresh();
      },
      destroy() {
        panel.destroy();
      },
    };
  },
});

registerSidePanel({
  id: HOTLISTS_ID,
  title: "排行榜 · 技術評分",
  icon: "hotlist",
  width: 320,
  resizable: true,
  minWidth: 260,
  mount(ctx, body) {
    // Rankings on top, the active chart's rating below: picking a row switches
    // the chart and the rating follows it, all in one panel.
    const doc = body.ownerDocument;
    const listEl = doc.createElement("div");
    // Fixed height (= 20 rows, measured 539px) so the rating never moves,
    // whatever the list shows: loading, fewer rows, an error.
    listEl.style.cssText = "height:540px;overflow-y:auto";
    const ratingEl = doc.createElement("div");
    ratingEl.style.cssText = "border-top:1px solid var(--vela-border,#2a2e39);margin-top:8px;padding-top:4px";
    body.append(listEl, ratingEl);
    const panel = mountHotlistsPanel(listEl, {
      ranking: (kind) => fetchRanking(kind, 20, new Date()),
      onPick: (code) => {
        void fetchContractInfo(code).then((info) => ctx.setSymbol(`${info?.exchange ?? "TSE"}:${code}`));
      },
    });
    const rating = mountRating(ctx, ratingEl);
    return {
      onOpen() {
        panel.refresh();
        rating.refresh();
      },
      destroy() {
        panel.destroy();
        rating.destroy();
      },
    };
  },
});

// The topbar button opens the heatmap in its own window (the side panel is
// too small to read); the panel stays reachable from the side dock. Picks in
// the window come back over BroadcastChannel to the quote-strip mount above.
let heatmapWin: Window | null = null;

registerWidgetAction({
  id: "opencharts.heatmap.toggle",
  target: "topbar",
  align: "right",
  icon: "heatmap",
  label: "熱力圖",
  order: 3,
  run: (ctx) => {
    if (heatmapWin && !heatmapWin.closed) {
      heatmapWin.focus();
      return;
    }
    heatmapWin = (ctx.host.ownerDocument.defaultView ?? window).open(
      "/heatmap.html",
      "opencharts.heatmap",
      "width=1400,height=900,menubar=no,toolbar=no,location=no,status=no",
    );
    if (!heatmapWin) ctx.togglePanel(HEATMAP_ID); // popup blocked: fall back to the side panel
  },
});

registerWidgetAction({
  id: "opencharts.hotlists.toggle",
  target: "topbar",
  align: "right",
  icon: "hotlist",
  label: "排行",
  order: 4,
  run: (ctx) => ctx.togglePanel(HOTLISTS_ID),
});
