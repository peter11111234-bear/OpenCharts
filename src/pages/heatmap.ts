/**
 * Electronics heatmap side panel (TradingView "Stock Heatmap" look) on
 * shioaji's TAIEX components: tiles grouped by TWSE industry (24–31), sized by
 * index weight, coloured by % change (red up / green down). Clicking a tile
 * switches the active chart to that stock — the only chart write, and only on
 * an explicit click.
 */
import { ELECTRONICS_CATEGORIES, type IndexEntry } from "../services/shioaji/marketData.ts";
import { CATEGORY_NAMES, ensureMarketStyles, escapeHtml, fmtPct, heatColor, latestRunner } from "./marketKit.ts";
import type { WidgetHandle } from "./quoteStrip.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.): lays out positive values into `rect`,
 *  area ∝ value, largest first, keeping tiles as close to square as it can. */
export function squarify<T>(items: ReadonlyArray<{ item: T; value: number }>, rect: Rect): Array<Rect & { item: T }> {
  const vals = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = vals.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const out: Array<Rect & { item: T }> = [];
  let { x, y, w, h } = rect;
  type Cell = { item: T; area: number };
  let row: Cell[] = [];

  const worst = (r: Cell[], side: number): number => {
    const s = r.reduce((a, c) => a + c.area, 0);
    let max = 0;
    for (const c of r) max = Math.max(max, (side * side * c.area) / (s * s), (s * s) / (side * side * c.area));
    return max;
  };
  const place = (r: Cell[]): void => {
    const s = r.reduce((a, c) => a + c.area, 0);
    if (w >= h) {
      const colW = s / h;
      let cy = y;
      for (const c of r) {
        const ch = c.area / colW;
        out.push({ item: c.item, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      const rowH = s / w;
      let cx = x;
      for (const c of r) {
        const cw = c.area / rowH;
        out.push({ item: c.item, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
  };

  for (const v of vals) {
    const cell = { item: v.item, area: v.value * scale };
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, cell], side) <= worst(row, side)) row.push(cell);
    else {
      place(row);
      row = [cell];
    }
  }
  if (row.length) place(row);
  return out;
}

export interface HeatmapLayout {
  groups: Array<Rect & { item: string }>;
  tiles: Array<Rect & { item: IndexEntry }>;
}

/** Top `topN` electronics stocks by index weight, grouped by industry. */
export function layoutHeatmap(entries: readonly IndexEntry[], topN: number, rect: Rect): HeatmapLayout {
  const picked = entries
    .filter((e) => ELECTRONICS_CATEGORIES.includes(e.category) && e.weightPpm > 0)
    .sort((a, b) => b.weightPpm - a.weightPpm)
    .slice(0, topN);
  const byCat = new Map<string, IndexEntry[]>();
  for (const e of picked) byCat.set(e.category, [...(byCat.get(e.category) ?? []), e]);
  const groups = squarify(
    [...byCat.entries()].map(([cat, list]) => ({ item: cat, value: list.reduce((s, e) => s + e.weightPpm, 0) })),
    rect,
  );
  const tiles = groups.flatMap((g) =>
    squarify(
      (byCat.get(g.item) ?? []).map((e) => ({ item: e, value: e.weightPpm })),
      { x: g.x, y: g.y, w: g.w, h: g.h },
    ),
  );
  return { groups, tiles };
}

export interface HeatmapDeps {
  entries: () => Promise<IndexEntry[]>;
  onPick: (symbol: string) => void;
  topN?: number;
  height?: number;
  refreshMs?: number;
}

export const HEATMAP_TOP_N = 60;

export function mountHeatmapPanel(body: HTMLElement, deps: HeatmapDeps): WidgetHandle {
  const doc = body.ownerDocument;
  ensureMarketStyles(doc);
  const root = doc.createElement("div");
  root.className = "mw";
  root.style.padding = "8px";
  body.appendChild(root);
  const topN = deps.topN ?? HEATMAP_TOP_N;
  const height = deps.height ?? 420;

  root.addEventListener("click", (ev) => {
    const tile = (ev.target as HTMLElement).closest?.("[data-symbol]") as HTMLElement | null;
    if (tile?.dataset.symbol) deps.onPick(tile.dataset.symbol);
  });

  const runner = latestRunner(
    () => deps.entries(),
    (entries) => {
      const width = root.clientWidth > 0 ? root.clientWidth - 16 : 300;
      const { groups, tiles } = layoutHeatmap(entries, topN, { x: 0, y: 0, w: width, h: height });
      if (tiles.length === 0) {
        root.innerHTML = `<div class="mw-meta">沒有電子類成分股資料</div>`;
        return;
      }
      const box = (r: Rect) =>
        `left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px`;
      const tileHtml = tiles
        .map((t) => {
          const e = t.item;
          const label = t.w >= 34 && t.h >= 22 ? `${escapeHtml(e.code)}<br>${fmtPct(e.pct)}` : "";
          const title = `${e.code} ${fmtPct(e.pct)} · 權重 ${(e.weightPpm / 10_000).toFixed(2)}%`;
          return `<div class="hm-tile" data-symbol="${escapeHtml(`${e.exchange}:${e.code}`)}" title="${escapeHtml(title)}" style="${box(t)};background:${heatColor(e.pct)}">${label}</div>`;
        })
        .join("");
      const groupHtml = groups
        .map((g) => `<div class="hm-group" style="${box(g)}"><span>${escapeHtml(CATEGORY_NAMES[g.item] ?? g.item)}</span></div>`)
        .join("");
      root.innerHTML =
        `<div class="mw-meta">電子類前 ${tiles.length} 大（依加權指數權重）· 點方塊切換商品</div>` +
        `<div class="hm-box" style="height:${height}px">${tileHtml}${groupHtml}</div>` +
        `<div class="mw-meta">${fmtPct(-3)} <span style="color:${heatColor(-3)}">■</span> 0 <span style="color:${heatColor(3)}">■</span> ${fmtPct(3)}</div>`;
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      root.innerHTML = `<div class="mw-warn">無法取得熱力圖：${escapeHtml(msg)}</div>`;
    },
  );

  const tick = setInterval(() => runner.run(), deps.refreshMs ?? 30_000);
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
