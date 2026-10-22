/**
 * Registers the 技術評分 side panel and its topbar toggle with Vela (side
 * effect, imported once by VelaPage). The rating runs on shioaji bars through
 * our own Pine interpreter; see techRating.ts / techRatingPanel.ts.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel: the root and /ui
 * subpath are separate module instances, and registering on the wrong one
 * leaves the panel invisible (see velaPineEditor.ts header).
 */
import { registerIcon, registerSidePanel, registerWidgetAction, type WidgetContext } from "@luxalgo/vela/plugin";
import { svg16 } from "@luxalgo/vela/ui";
import { autoRefreshAllowed, barRefreshKey } from "../services/shioaji/fetchPolicy.ts";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { computeRating, type FetchBarsFn } from "./techRating.ts";
import { mountTechRatingPanel } from "./techRatingPanel.ts";

const PANEL_ID = "opencharts.tech-rating";

const provider = new ShioajiVelaProvider();
const fetchBars: FetchBarsFn = (symbol, timeframe, fromMs, limit) =>
  provider.getBars(symbol, timeframe, { from: fromMs, limit });

/** The rating for `ctx`'s active chart, mounted into `body` (also used under the hotlists). */
export function mountRating(ctx: WidgetContext, body: HTMLElement) {
  return mountTechRatingPanel(ctx, body, {
    compute: (symbol, timeframe) => computeRating(symbol, timeframe, { fetchBars }),
    // Each recompute re-downloads today's kbars (~65 KB of quota): only once per closed
    // bar, and only for markets the user rule says to keep fresh (see fetchPolicy.ts).
    autoRefreshKey: (symbol, timeframe, now) =>
      autoRefreshAllowed(symbol, now) ? barRefreshKey(timeframe, now) : null,
  });
}

registerIcon("tech-rating", svg16('<path d="M2.5 11.5a5.5 5.5 0 0 1 11 0"/><path d="M8 11.5l3-4"/>'));

registerSidePanel({
  id: PANEL_ID,
  title: "技術評分",
  icon: "tech-rating",
  width: 300,
  resizable: true,
  minWidth: 240,
  mount(ctx, body) {
    const panel = mountRating(ctx, body);
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
  id: "opencharts.tech-rating.toggle",
  target: "topbar",
  align: "right",
  icon: "tech-rating",
  label: "評分",
  order: 2,
  run: (ctx) => ctx.togglePanel(PANEL_ID),
});
