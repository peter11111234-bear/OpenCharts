/**
 * Technical-rating side panel body: a TradingView-style half-circle gauge
 * (strong sell → strong buy) plus MA / oscillator rows. Framework-free DOM so
 * it mounts straight into a Vela side panel; it only READS the market from
 * ctx (symbol/timeframe) and never touches the chart.
 */
import { RATING_FULL_BARS, RATING_LABELS, ratingKey, type RatingKey, type RatingSnapshot } from "./techRating.ts";

export interface RatingPanelCtx {
  readonly symbol: string;
  readonly timeframe: string;
}

export interface RatingPanelDeps {
  compute: (symbol: string, timeframe: string) => Promise<RatingSnapshot>;
  /** How often to check whether the active symbol/timeframe changed. */
  pollMs?: number;
  /** How often to recompute for the same market (new bars). */
  refreshMs?: number;
}

export interface RatingPanelHandle {
  refresh(): void;
  destroy(): void;
}

const BANDS: ReadonlyArray<[number, number, RatingKey]> = [
  [-1, -0.5, "strong_sell"],
  [-0.5, -0.1, "sell"],
  [-0.1, 0.1, "neutral"],
  [0.1, 0.5, "buy"],
  [0.5, 1, "strong_buy"],
];

const COLORS: Record<RatingKey, string> = {
  strong_sell: "#f23645",
  sell: "#f77c80",
  neutral: "#787b86",
  buy: "#5b9cf6",
  strong_buy: "#2962ff",
};

const CSS = `
.tr-panel{display:flex;flex-direction:column;gap:10px;padding:12px;color:var(--vela-fg,#d1d4dc);
  font:12px/1.4 -apple-system,Segoe UI,sans-serif}
.tr-gauge{width:100%;max-width:240px;align-self:center}
.tr-main{text-align:center;font-size:18px;font-weight:600}
.tr-row{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid var(--vela-border,#2a2e39)}
.tr-meta{color:var(--vela-fg-muted,#868993);font-size:11px}
.tr-warn{color:#f9a825;font-size:11px}
`;

// Gauge geometry: centre (100,100), radius 80; v = -1 at the left, +1 at the right.
const point = (v: number, r: number): [number, number] => {
  const theta = Math.PI * (1 - (v + 1) / 2);
  return [100 + r * Math.cos(theta), 100 - r * Math.sin(theta)];
};

function gaugeSvg(v: number | null): string {
  const arcs = BANDS.map(([from, to, key]) => {
    const [x1, y1] = point(from, 80);
    const [x2, y2] = point(to, 80);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${COLORS[key]}" stroke-width="14" fill="none"/>`;
  }).join("");
  const needle =
    v === null
      ? ""
      : (() => {
          const [x, y] = point(Math.max(-1, Math.min(1, v)), 66);
          return `<line class="tr-needle" x1="100" y1="100" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="100" cy="100" r="5" fill="currentColor"/>`;
        })();
  return `<svg class="tr-gauge" viewBox="0 0 200 110" role="img" aria-label="技術評分儀表">${arcs}${needle}</svg>`;
}

const labelOf = (v: number | null): string => {
  const key = ratingKey(v);
  return key ? RATING_LABELS[key] : "資料不足";
};
const colorOf = (v: number | null): string => {
  const key = ratingKey(v);
  return key ? COLORS[key] : COLORS.neutral;
};
const fmt = (v: number | null): string => (v === null ? ", " : v.toFixed(2));

export function mountTechRatingPanel(ctx: RatingPanelCtx, body: HTMLElement, deps: RatingPanelDeps): RatingPanelHandle {
  const doc = body.ownerDocument;
  if (!doc.querySelector("style[data-tech-rating]")) {
    const s = doc.createElement("style");
    s.dataset.techRating = "";
    s.textContent = CSS;
    doc.head.appendChild(s);
  }
  const root = doc.createElement("div");
  root.className = "tr-panel";
  body.appendChild(root);

  let seq = 0;
  let busy = false;
  let again = false;
  let lastKey = "";
  let disposed = false;

  const render = (html: string) => {
    root.innerHTML = html;
  };

  const show = (snap: RatingSnapshot, symbol: string, timeframe: string) => {
    const warn =
      snap.bars > 0 && snap.bars < RATING_FULL_BARS
        ? `<div class="tr-warn">只有 ${snap.bars} 根 K 棒（少於 ${RATING_FULL_BARS}），長週期均線未納入</div>`
        : "";
    render(
      gaugeSvg(snap.all) +
        `<div class="tr-main" style="color:${colorOf(snap.all)}">${labelOf(snap.all)} <span class="tr-meta">${fmt(snap.all)}</span></div>` +
        `<div class="tr-row"><span>均線</span><span style="color:${colorOf(snap.ma)}">${labelOf(snap.ma)} ${fmt(snap.ma)}</span></div>` +
        `<div class="tr-row"><span>震盪指標</span><span style="color:${colorOf(snap.osc)}">${labelOf(snap.osc)} ${fmt(snap.osc)}</span></div>` +
        `<div class="tr-meta">${symbol} · ${timeframe} · ${snap.bars} 根 K 棒</div>` +
        warn,
    );
  };

  const refresh = () => {
    if (disposed) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const mine = ++seq;
    const symbol = ctx.symbol;
    const timeframe = ctx.timeframe;
    lastKey = `${symbol}|${timeframe}`;
    if (!root.firstChild) render(`<div class="tr-meta">計算中…</div>`);
    deps
      .compute(symbol, timeframe)
      .then(
        (snap) => {
          if (!disposed && mine === seq) show(snap, symbol, timeframe);
        },
        (err: unknown) => {
          if (!disposed && mine === seq) {
            const msg = err instanceof Error ? err.message : String(err);
            render(`<div class="tr-warn">無法取得評分：${msg.replace(/[<>&]/g, "")}</div>`);
          }
        },
      )
      .finally(() => {
        busy = false;
        if (again) {
          again = false;
          refresh();
        }
      });
  };

  // Symbol/timeframe switches are applied in place, so poll the live getters, // a string compare per second is far cheaper than recomputing on every
  // Vela state event (drawings/style changes fire those too).
  const poll = setInterval(() => {
    if (`${ctx.symbol}|${ctx.timeframe}` !== lastKey) refresh();
  }, deps.pollMs ?? 1000);
  const tick = setInterval(refresh, deps.refreshMs ?? 60_000);

  refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      clearInterval(poll);
      clearInterval(tick);
      root.remove();
    },
  };
}
