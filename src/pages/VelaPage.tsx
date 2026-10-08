import { useEffect, useRef } from "react";
import { VelaWorkspace, type ChartCell } from "@luxalgo/vela/workspace";
import type { InputValue } from "@luxalgo/vela/plugin";
import { InterpreterPineEngine } from "./velaPineEditor.ts";
import { ShioajiVelaProvider } from "../services/shioaji/velaProvider.ts";
import { TW_INSTRUMENTS } from "../services/shioaji/instruments.ts";
import { combinedManifestEntries } from "../pineScripts.ts";
import "./velaPineEditor.ts"; // 註冊頂列 "Pine" 按鈕（side effect）


/**
 * Per-cell symbol/timeframe controls mounted into each cell's host div —
 * Vela has no built-in per-cell market controls (the shared topbar always
 * acts on the ACTIVE cell), so each cell gets its own [symbol ▾] + tf chips.
 * Both apply straight to that cell via setSymbol/setTimeframe; labels resync
 * on 'state:changed' and the listeners die with the cell on 'cell:destroyed'.
 */
const TF_CHOICES: ReadonlyArray<[string, string]> = [
  ["1", "1m"],
  ["5", "5m"],
  ["15", "15m"],
  ["30", "30m"],
  ["60", "1H"],
  ["240", "4H"],
  ["D", "1D"],
  ["W", "1W"],
];

const STYLE_CHOICES: ReadonlyArray<[string, string]> = [
  ["candles", "K"],
  ["bars", "Bar"],
  ["line", "Line"],
  ["area", "Area"],
  ["baseline", "Base"],
  ["heikinashi", "HA"],
];

function mountCellToolbar(ws: VelaWorkspace, cell: ChartCell): void {
  const doc = cell.host.ownerDocument;
  const bar = doc.createElement("div");
  bar.className = "vela-cellbar";

  // Symbol combobox: input + datalist seeded from TW_INSTRUMENTS, so any TW
  // code works by typing (e.g. '2317', 'TXFJ6', 'OTC:6547') — the provider's
  // getSymbolInfo falls back to inferred exchange/type for unknown codes.
  const symInput = doc.createElement("input");
  symInput.className = "vela-cellbar-chip vela-cellbar-input";
  symInput.placeholder = cell.symbol;
  symInput.value = cell.symbol;
  symInput.spellcheck = false;
  symInput.title = "切換商品（輸入代碼 Enter 套用）";
  const dataList = doc.createElement("datalist");
  dataList.id = `vela-syms-${cell.id}`;
  for (const d of TW_INSTRUMENTS) {
    const opt = doc.createElement("option");
    opt.value = `${d.contract.exchange}:${d.symbol.name}`;
    opt.label = d.symbol.displayName ?? d.symbol.name;
    dataList.appendChild(opt);
  }
  symInput.setAttribute("list", dataList.id);
  symInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = symInput.value.trim();
      if (v) {
        ws.setActiveCell(cell.id);
        ws.cell(cell.id)?.setSymbol(v);
      }
      symInput.blur();
    } else if (e.key === "Escape") {
      symInput.value = cell.symbol;
      symInput.blur();
    }
  });
  symInput.addEventListener("change", () => {
    const v = symInput.value.trim();
    if (v && v !== cell.symbol) {
      ws.setActiveCell(cell.id);
      ws.cell(cell.id)?.setSymbol(v);
    }
  });

  const tfWrap = doc.createElement("div");
  tfWrap.className = "vela-cellbar-tf";
  for (const [value, label] of TF_CHOICES) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "vela-cellbar-chip";
    b.textContent = label;
    b.dataset.tf = value;
    b.addEventListener("click", () => {
      ws.setActiveCell(cell.id);
      ws.cell(cell.id)?.setTimeframe(value);
    });
    tfWrap.appendChild(b);
  }

  const stWrap = doc.createElement("div");
  stWrap.className = "vela-cellbar-tf";
  for (const [value, label] of STYLE_CHOICES) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "vela-cellbar-chip";
    b.textContent = label;
    b.dataset.style = value;
    b.title = `圖型：${value}`;
    b.addEventListener("click", () => {
      ws.setActiveCell(cell.id);
      ws.cell(cell.id)?.setPriceStyle(value);
    });
    stWrap.appendChild(b);
  }

  const syncLabels = () => {
    const live = ws.cell(cell.id);
    if (!live) return;
    symInput.value = live.symbol;
    for (const b of tfWrap.querySelectorAll("button")) {
      const btn = b as HTMLButtonElement;
      if (btn.dataset.tf === live.timeframe) btn.dataset.current = "1";
      else btn.removeAttribute("data-current");
    }
    for (const b of stWrap.querySelectorAll("button")) {
      const btn = b as HTMLButtonElement;
      if (btn.dataset.style === live.priceStyle) btn.dataset.current = "1";
      else btn.removeAttribute("data-current");
    }
  };
  syncLabels();

  const offState = ws.on("state:changed", syncLabels);
  const offDestroyed = ws.on("cell:destroyed", ({ id }) => {
    if (id !== cell.id) return;
    offState();
    offDestroyed();
  });

  bar.append(symInput, dataList, tfWrap, stWrap);
  cell.host.appendChild(bar);
  mountIndicatorCountBadge(ws, cell);
}

/** Indicator-count badge next to the legend fold chevron — TV shows a
 *  "˅ N" chip with N even when NOT folded; vela's chevron is bare when
 *  unfolded, so we overlay the count. Observer-driven: vela rebuilds its
 *  legend DOM internally, so we watch childList and re-derive the badge.
 *  Badge unmounts with the host on cell:destroyed. */
function mountIndicatorCountBadge(ws: VelaWorkspace, cell: ChartCell): void {
  const host = cell.host;
  const badge = host.ownerDocument.createElement("span");
  badge.className = "vela-ind-count-badge";
  badge.style.cssText =
    "position:absolute;top:0;left:0;z-index:6;pointer-events:none;" +
    "background:#f9a825;color:#000;border-radius:8px;font:600 10px/14px " +
    "-apple-system,Segoe UI,sans-serif;padding:0 5px;margin:2px 0 0 10px;display:none;";
  // No MutationObserver: observing host subtree created a feedback loop
  // (badge writes re-triggered the observer) that saturated the main thread.
  // Events + lazy-settle cover add/remove; worst case the count is one
  // interaction stale — cheap trade for never freezing the page.
  let last = -1;
  const refresh = () => {
    let n = 0;
    try { n = cell.chart.indicators().length; } catch { n = 0; }
    if (n === last) return;
    last = n;
    badge.textContent = String(n);
    badge.style.display = n > 0 ? "inline-block" : "none";
  };
  host.appendChild(badge);
  refresh();
  // settle once after vela's lazy legend mount, then live on state events
  const t1 = setTimeout(refresh, 500);
  const t2 = setTimeout(refresh, 2000);
  const offState = ws.on("state:changed", refresh);
  const offDestroyed = ws.on("cell:destroyed", ({ id }) => {
    if (id === cell.id) {
      offState();
      offDestroyed();
      clearTimeout(t1);
      clearTimeout(t2);
      badge.remove();
    }
  });
}

/**
 * Vela chart workspace backed by the shioaji server (SinoPac).
 *
 * - Provider: 'shioaji' — symbols resolve as bare tickers (2330, TXFJ6) or
 *   listing-prefixed (TSE:2330, TAIFEX:TXFJ6).
 * - Pine scripts: src/pine/*.pine via loadPineManifest(), run in-process by the
 *   from-scratch interpreter engine (PineInterpreterEngine, src/pine/).
 * - Live bars: the provider kicks wsClient.connect() on first subscription,
 *   which starts feed.ts's SSE tick stream.
 *
 * StrictMode mounts effects twice in dev: create() is synchronous and
 * destroy() is idempotent, so the second mount just rebuilds.
 */

// Boot diagnostics: ?vela-diag writes a #vela-diag element with stage markers so a
// broken tab can show WHERE boot died without devtools.
function diag(stage: string, extra = ""): void {
  if (!new URLSearchParams(window.location.search).has("vela-diag")) return;
  let el = document.getElementById("vela-diag");
  if (!el) {
    el = document.createElement("pre");
    el.id = "vela-diag";
    el.style.cssText = "position:fixed;inset:0;z-index:99999;background:#000;color:#0f0;padding:12px;font:12px monospace;overflow:auto;";
    document.body.appendChild(el);
  }
  el.textContent += stage + (extra ? " :: " + extra : "") + "\n";
}
window.addEventListener("error", (e) => diag("WINDOW-ERROR", e.message));
window.addEventListener("unhandledrejection", (e) => diag("REJECTION", String(e.reason).slice(0, 300)));
diag("MODULE-LOADED");
export function VelaPage() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Boot hygiene: ?fresh wipes the blob entirely; otherwise drop only the
    // HEAVY restored scripts — ones calling request.security (MTF evalAt is
    // O(bars×tf-bars) and hung the page on TRIS-class scripts). Light scripts
    // (EMA/VWAP/FVG…) restore normally, matching TV's reload behaviour.
    const fresh = new URLSearchParams(window.location.search).has("fresh");
    try {
      if (fresh) localStorage.removeItem("vela-workspace-v2");
      else {
        const raw = localStorage.getItem("vela-workspace-v2");
        if (raw) {
          interface ExtEntry { script?: unknown; name?: string; id?: string; hidden?: boolean; inputs?: Record<string, unknown> }
          interface ParkedEntry { chartIndex: number; entry: ExtEntry }
          const doc = JSON.parse(raw) as {
            charts?: Array<{ ext?: Record<string, unknown> }>;
          };
          // Heavy scripts are MOVED to a parked list, not deleted — a user's
          // MTF indicator must never silently vanish. Parked entries restore
          // on idle below (deferred, off the boot path).
          const parked: ParkedEntry[] = (() => {
            try {
              const p = JSON.parse(localStorage.getItem("vela-workspace-v2.parked-pine") || "[]") as ParkedEntry[];
              return Array.isArray(p) ? p : [];
            } catch { return []; }
          })();
          let stripped = false;
          (doc.charts ?? []).forEach((c, chartIndex) => {
            const entries = c.ext?.["opencharts.pine-scripts"];
            if (!Array.isArray(entries)) return;
            const kept = (entries as ExtEntry[]).filter(
              (e) => typeof e.script !== "string" || !e.script.includes("request.security"),
            );
            for (const e of entries as ExtEntry[]) {
              if (typeof e.script === "string" && e.script.includes("request.security")) {
                parked.push({ chartIndex, entry: e });
              }
            }
            if (kept.length !== entries.length) {
              if (kept.length) c.ext!["opencharts.pine-scripts"] = kept;
              else delete c.ext!["opencharts.pine-scripts"];
              stripped = true;
            }
          });
          if (parked.length) {
            try { localStorage.setItem("vela-workspace-v2.parked-pine", JSON.stringify(parked)); } catch { /* quota */ }
          }
          if (stripped) localStorage.setItem("vela-workspace-v2", JSON.stringify(doc));
        }
      }
    } catch { /* corrupt blob or quota — let vela fall back to defaults */ }

    diag("EFFECT-START", "fresh=" + fresh + " blob=" + (localStorage.getItem("vela-workspace-v2")?.length ?? 0));
    let ws: VelaWorkspace;
    try {
      ws = new VelaWorkspace(host, {
        layout: "1",
        symbol: "TSE:2330",
        timeframe: "5",
        live: false, // 暫停：SSE tick 一直推 → main thread 洗 render
        theme: "dark",
        timezone: "Asia/Taipei",
        timeframes: ["1", "5", "15", "30", "60", "240", "D", "W"],
        providers: { shioaji: () => new ShioajiVelaProvider() },
        engines: { pine: () => new InterpreterPineEngine() },
        // Indicators picker manifest: bundled src/pine/*.pine + the user's
        // personal script library (opencharts.pine.lib) under "My scripts".
        indicators: async () => combinedManifestEntries(),
        persist: "vela-workspace-v2",
        sync: { drawings: true, style: true },
      });
    } catch (e) {
      diag("WS-THROW", e instanceof Error ? e.message + "\n" + e.stack : String(e));
      throw e;
    }
    diag("WS-CREATED", "cells=" + ws.cells().length);

    // Debug handle for scripts/tests (chart.runIndicator, ws.state()).
    (window as unknown as Record<string, unknown>).__vela = ws;

    // Deferred restore of parked heavy scripts — they were moved off the
    // workspace doc above (not deleted), now re-run on idle so boot stays
    // free of synchronous runScript calls (the original TRIS-class hang).
    // runIndicator never rejects; failed entries stay parked for next load.
    const restoreParked = async () => {
      let parked: { chartIndex: number; entry: { script?: unknown; name?: string; id?: string; hidden?: boolean; inputs?: Record<string, InputValue> } }[] = [];
      try {
        const p = JSON.parse(localStorage.getItem("vela-workspace-v2.parked-pine") || "[]") as typeof parked;
        if (Array.isArray(p)) parked = p;
      } catch { /* corrupt */ }
      if (!parked.length || !ws) return;
      const cells = ws.cells();
      const remaining = (await Promise.all(parked.map(async ({ chartIndex, entry }) => {
        const cell = cells[chartIndex] ?? cells[0];
        if (!cell || typeof entry.script !== "string") return { chartIndex, entry };
        const r = await cell.chart.runIndicator(entry.script, {
          id: entry.id, language: "pine", title: entry.name, inputs: entry.inputs,
        });
        if (!r.ok) return { chartIndex, entry };
        if (entry.hidden) r.handle?.setVisible(false);
        return null;
      }))).filter((e): e is NonNullable<typeof e> => e !== null);
      try { localStorage.setItem("vela-workspace-v2.parked-pine", JSON.stringify(remaining)); } catch { /* quota */ }
    };
    if ("requestIdleCallback" in window) requestIdleCallback(() => void restoreParked(), { timeout: 5000 });
    else setTimeout(() => void restoreParked(), 3000);

    // Pine seeding disabled — the auto-run loop was a freeze suspect. Pine scripts
    // now load manually via the topbar Pine button.

    // Per-cell market chips: mount into every live cell host now, and re-mount
    // when layout changes spawn/destroy cells. Cells that disappear take their
    // host (and the chips) with them — no extra cleanup needed.
    for (const cell of ws.cells()) mountCellToolbar(ws, cell);
    const offCreated = ws.on("cell:created", ({ id }) => {
      const cell = ws.cell(id);
      if (cell) mountCellToolbar(ws, cell);
    });

    return () => {
      offCreated();
      delete (window as unknown as Record<string, unknown>).__vela;
      ws.destroy();
    };
  }, []);

  return <div ref={hostRef} className="h-screen w-screen bg-[#0a0a0a]" />;
}
