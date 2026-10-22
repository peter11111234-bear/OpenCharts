/**
 * Shared kit for the Vela quote widgets (strip, heatmap, hotlists). Taiwan colour convention:
 * red = up, green = down (the opposite of TradingView's default).
 */
export const UP = "#f23645";
export const DOWN = "#089981";
export const FLAT = "#787b86";

export function changeColor(pct: number): string {
  if (!Number.isFinite(pct) || pct === 0) return FLAT;
  return pct > 0 ? UP : DOWN;
}

const BASE_RGB: [number, number, number] = [54, 58, 69];
const UP_RGB: [number, number, number] = [242, 54, 69];
const DOWN_RGB: [number, number, number] = [8, 153, 129];

/** Heatmap tile colour: neutral grey at 0%, full red/green at ±maxAbs%. */
export function heatColor(pct: number, maxAbs = 3): string {
  if (!Number.isFinite(pct)) return `rgb(${BASE_RGB.join(",")})`;
  const t = Math.min(1, Math.abs(pct) / maxAbs);
  const to = pct >= 0 ? UP_RGB : DOWN_RGB;
  const mix = BASE_RGB.map((b, i) => Math.round(b + (to[i]! - b) * t));
  return `rgb(${mix.join(",")})`;
}

export function fmtPct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 億 / 萬 for volumes and turnover. */
export function fmtBig(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}億`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e4)}萬`;
  return String(Math.round(v));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE_ID = "data-market-widgets";
const CSS = `
.mw{color:var(--vela-fg,#d1d4dc);font:12px/1.4 -apple-system,Segoe UI,sans-serif}
.mw-meta{color:var(--vela-fg-muted,#868993);font-size:11px}
.mw-warn{color:#f9a825;font-size:11px}
.qs-strip{display:flex;align-items:center;gap:16px;padding:4px 10px;overflow-x:auto;white-space:nowrap;
  border-top:1px solid var(--vela-border,#2a2e39);background:var(--vela-bg,#131722)}
.qs-info{display:flex;align-items:center;gap:8px;padding-right:12px;border-right:1px solid var(--vela-border,#2a2e39)}
.qs-range{position:relative;width:80px;height:4px;border-radius:2px;background:var(--vela-border,#2a2e39)}
.qs-range-mark{position:absolute;top:-3px;width:2px;height:10px;background:currentColor}
.qs-card{display:flex;flex-direction:column;line-height:1.2}
.qs-card b{font-weight:600}
.hm-theme{width:100%;margin-bottom:6px;padding:3px;border:1px solid var(--vela-border,#2a2e39);border-radius:4px;
  background:var(--vela-bg,#131722);color:inherit}
.hm-box{position:relative;width:100%}
.hm-tile{position:absolute;box-sizing:border-box;border:1px solid var(--vela-bg,#131722);overflow:hidden;
  cursor:pointer;color:#fff;font-size:10px;line-height:1.15;padding:2px}
.hm-group{position:absolute;box-sizing:border-box;border:1px solid #000;pointer-events:none}
.hm-group span{position:absolute;top:0;left:0;right:0;height:13px;padding:0 2px;font-size:9px;line-height:13px;
  color:rgba(255,255,255,.8);background:rgba(0,0,0,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hl-tabs{display:flex;gap:4px;margin-bottom:6px}
.hl-tabs button{flex:1;border:0;border-radius:4px;padding:4px 0;background:var(--vela-border,#2a2e39);
  color:inherit;cursor:pointer}
.hl-tabs button[data-active]{background:#2962ff;color:#fff}
.hl-table{width:100%;border-collapse:collapse}
.hl-table td{padding:3px 2px;border-top:1px solid var(--vela-border,#2a2e39)}
.hl-table tr{cursor:pointer}
.hl-table td.num{text-align:right}
`;

/** Inject the widgets' stylesheet once per document. */
export function ensureMarketStyles(doc: Document): void {
  if (doc.querySelector(`style[${STYLE_ID}]`)) return;
  const s = doc.createElement("style");
  s.setAttribute(STYLE_ID, "");
  s.textContent = CSS;
  doc.head.appendChild(s);
}

/**
 * Serial "latest wins" runner: a run() while one is in flight queues exactly
 * one rerun, and the superseded run's result is dropped (so a slow reply for
 * the old symbol never paints over the new one).
 */
export function latestRunner<T>(
  task: () => Promise<T>,
  onResult: (r: T) => void,
  onError: (e: unknown) => void,
): { run(): void; dispose(): void } {
  let busy = false;
  let again = false;
  let disposed = false;
  const run = (): void => {
    if (disposed) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    task()
      .then(
        (r) => {
          if (!disposed && !again) onResult(r);
        },
        (e: unknown) => {
          if (!disposed && !again) onError(e);
        },
      )
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          run();
        }
      });
  };
  return {
    run,
    dispose() {
      disposed = true;
    },
  };
}
