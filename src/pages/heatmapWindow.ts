// Popout theme heatmap (heatmap.html) — the side panel at full window size,
// opened from the topbar "熱力圖" button or straight by URL (a second monitor).
// It fetches its own data; a tile click is sent to the main app over
// BroadcastChannel, which switches the active chart (velaMarketWidgets.ts).
import { fetchStockEntries } from "../services/shioaji/marketData.ts";
import { HEATMAP_WINDOW_CHANNEL, mountHeatmapPanel, themeCodes } from "./heatmap.ts";

const app = document.getElementById("app")!;
const ch = new BroadcastChannel(HEATMAP_WINDOW_CHANNEL);

const toast = document.createElement("div");
toast.style.cssText =
  "position:fixed;top:8px;right:12px;z-index:10;padding:6px 12px;border-radius:4px;background:#2962ff;color:#fff;" +
  "font:14px sans-serif;opacity:0;transition:opacity .3s;pointer-events:none";
document.body.appendChild(toast);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// Rows above and below the box: theme select + description line + legend line.
const CHROME_PX = 110;

const panel = mountHeatmapPanel(app, {
  entries: () => fetchStockEntries(themeCodes()),
  onPick: (symbol) => {
    ch.postMessage({ t: "pick", symbol });
    try {
      window.opener?.focus(); // bring the chart forward when this window was opened from it
    } catch {
      /* cross-window focus may be refused — the toast still confirms the pick */
    }
    const name = document.querySelector<HTMLElement>(`[data-symbol="${CSS.escape(symbol)}"]`)?.title.split(" ")[1] ?? "";
    toast.textContent = `已切換主圖：${name} ${symbol.split(":")[1]}`;
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.opacity = "0"), 2500);
  },
  height: () => Math.max(300, window.innerHeight - CHROME_PX),
  perTheme: 15,
  labelHeight: 20, // heatmap.html .hm-group span
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => panel.redraw(), 150);
});
window.addEventListener("beforeunload", () => {
  panel.destroy();
  ch.close();
});
