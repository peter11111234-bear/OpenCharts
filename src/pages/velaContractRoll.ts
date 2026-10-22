/**
 * Automatic TAIFEX contract roll for the open /vela page (side effect,
 * imported once by VelaPage). Every minute it asks the broker which contract
 * is the front month (services/shioaji/frontMonth.ts):
 * - broker and 3rd-Wednesday rule disagree → warn once (holiday / typhoon postponement);
 * - the front month moved past what this page subscribed at load → cache it
 *   and reload ONCE, so the feed and symbol lists rebuild on the new contract;
 * - the chart still shows an older dated contract of that root → switch it.
 *
 * Import from "@luxalgo/vela/plugin", NOT the root barrel (separate module instances).
 */
import { registerWidgetAttachment } from "@luxalgo/vela/plugin";
import { fetchR1Info, pickFrontMonth, writeCachedFrontMonth } from "../services/shioaji/frontMonth.ts";
import { frontMonthCode, LIVE_INSTRUMENTS } from "../services/shioaji/instruments.ts";

const ROOTS = ["TMF", "MXF"] as const;
const CHECK_MS = 60_000;
/** Per-tab guard so a cache that cannot be written never turns into a reload loop. */
const RELOADED_KEY = "opencharts.contractRoll.reloadedFor";

const loadedCode = (root: string) => LIVE_INSTRUMENTS.find((i) => i.contract.code.startsWith(root))?.contract.code;

registerWidgetAttachment({
  id: "opencharts.contract-roll",
  mount(ctx) {
    const doc = ctx.host.ownerDocument;
    if (doc.documentElement.dataset.contractRoll) return () => {}; // one watcher per page
    doc.documentElement.dataset.contractRoll = "1";
    const warned = new Set<string>();
    let stopped = false;

    const check = async () => {
      for (const root of ROOTS) {
        const pick = pickFrontMonth(await fetchR1Info(root), frontMonthCode(root), Date.now());
        if (stopped) return;
        writeCachedFrontMonth(root, pick);
        if (pick.warning && !warned.has(pick.warning)) {
          warned.add(pick.warning);
          console.warn(`[contract-roll] ${pick.warning}`);
          ctx.toast(pick.warning, "error");
        }
        const loaded = loadedCode(root);
        if (loaded && loaded !== pick.code) {
          let reloadedFor: string | null = null;
          try {
            reloadedFor = sessionStorage.getItem(RELOADED_KEY);
          } catch {
            reloadedFor = null;
          }
          if (reloadedFor !== pick.code) {
            try {
              sessionStorage.setItem(RELOADED_KEY, pick.code);
            } catch {
              /* without the guard we still reload once per check at most */
            }
            ctx.toast(`已換月 ${loaded} → ${pick.code}，重新載入行情`, "info");
            setTimeout(() => location.reload(), 1500);
            return;
          }
        }
        // The chart may carry an exchange prefix ("TAIFEX:TMFJ6"); keep it when switching.
        const shown = /^((?:TAIFEX:)?)([A-Z]{3}[A-L]\d)$/.exec(ctx.symbol);
        if (shown && shown[2]!.startsWith(root) && shown[2] !== pick.code && pick.code === loaded) {
          ctx.setSymbol(`${shown[1]}${pick.code}`);
          ctx.toast(`圖表已換到近月 ${pick.code}（原 ${shown[2]}）`, "info");
        }
      }
    };

    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      delete doc.documentElement.dataset.contractRoll;
    };
  },
});
