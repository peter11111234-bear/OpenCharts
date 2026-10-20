/**
 * Registers the quote widgets with Vela (side effect — imported once by
 * VelaPage): the quote strip (auto-docked under the charts), the electronics
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
import { mountHeatmapPanel } from "./heatmap.ts";
import { mountHotlistsPanel } from "./hotlists.ts";
import { mountQuoteStrip } from "./quoteStrip.ts";

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
    return () => {
      strip.destroy();
      undock();
    };
  },
});

registerSidePanel({
  id: HEATMAP_ID,
  title: "電子熱力圖",
  icon: "heatmap",
  width: 360,
  resizable: true,
  minWidth: 280,
  mount(ctx, body) {
    const panel = mountHeatmapPanel(body, {
      entries: () => fetchIndexEntries(),
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
  title: "排行榜",
  icon: "hotlist",
  width: 320,
  resizable: true,
  minWidth: 260,
  mount(ctx, body) {
    const panel = mountHotlistsPanel(body, {
      ranking: (kind) => fetchRanking(kind, 20, new Date()),
      onPick: (code) => {
        void fetchContractInfo(code).then((info) => ctx.setSymbol(`${info?.exchange ?? "TSE"}:${code}`));
      },
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

registerWidgetAction({
  id: "opencharts.heatmap.toggle",
  target: "topbar",
  align: "right",
  icon: "heatmap",
  label: "熱力圖",
  order: 3,
  run: (ctx) => ctx.togglePanel(HEATMAP_ID),
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
