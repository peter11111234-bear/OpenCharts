/**
 * Theme heatmap side panel (TradingView "Stock Heatmap" look) over the
 * hand-curated tech supply-chain themes in data/techThemes.json (glass
 * substrate, CPO, CoWoS, liquid cooling …). Prices come from shioaji snapshots
 * of just the theme stocks (fetchStockEntries); tiles are sized by turnover (成交金額 — listed and
 * OTC index weights are not comparable), equal-sized when there is none yet
 * (pre-market), and coloured by % change (red up / green down). The overview
 * shows each theme's top stocks; picking one theme shows all of its stocks
 * grouped by sub-group. Clicking a tile switches the active chart to that
 * stock — the only chart write, and only on an explicit click.
 * Usage, data format and known gaps: heatmap.README.md.
 */
import { isTwStockSession, type IndexEntry } from "../services/shioaji/marketData.ts";
import { ensureMarketStyles, escapeHtml, fmtPct, heatColor, latestRunner } from "./marketKit.ts";
import type { WidgetHandle } from "./quoteStrip.ts";
import techThemes from "../data/techThemes.json";

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

export interface ThemeStock {
  code: string;
  name: string;
  sub_group: string;
  role: string;
}

export type ThemeDb = Record<string, { title: string; description: string; stocks: Record<string, ThemeStock> }>;

export const THEMES = techThemes as ThemeDb;

/** Every stock code across the themes, once (a stock may sit in several). */
export function themeCodes(db: ThemeDb = THEMES): string[] {
  return [...new Set(Object.values(db).flatMap((t) => Object.values(t.stocks).map((s) => s.code)))];
}

export interface HeatTile {
  stock: ThemeStock;
  quote: IndexEntry;
}

export interface HeatmapLayout {
  groups: Array<Rect & { item: string }>;
  tiles: Array<Rect & { item: HeatTile }>;
  /** Theme stocks with no quote from either index (unlisted, emerging board …). */
  missing: ThemeStock[];
}

/** Short group label: the Chinese part of "玻璃基板 (Glass Substrate)". */
export const shortTitle = (title: string) => title.replace(/\s*\(.*\)\s*$/, "");

/**
 * `theme === null`: one group per theme with its `perTheme` biggest stocks
 * (a stock may sit in several themes). Otherwise: that theme's stocks, all of
 * them, grouped by sub_group. `labelH` px at the top of each group (tall
 * enough to hold it) are left free for the group's label.
 */
export function layoutThemeHeatmap(
  db: ThemeDb,
  theme: string | null,
  entries: readonly IndexEntry[],
  rect: Rect,
  perTheme = 8,
  labelH = 0,
): HeatmapLayout {
  const quotes = new Map(entries.map((e) => [e.code, e]));
  const missing: ThemeStock[] = [];
  const byGroup = new Map<string, HeatTile[]>();
  for (const key of theme === null ? Object.keys(db) : [theme]) {
    const t = db[key];
    if (!t) continue;
    for (const stock of Object.values(t.stocks)) {
      const quote = quotes.get(stock.code);
      if (!quote) {
        missing.push(stock);
        continue;
      }
      const g = theme === null ? shortTitle(t.title) : stock.sub_group;
      byGroup.set(g, [...(byGroup.get(g) ?? []), { stock, quote }]);
    }
  }
  const anyAmount = [...byGroup.values()].some((l) => l.some((h) => h.quote.amount > 0));
  const size = (h: HeatTile) => (anyAmount ? h.quote.amount : 1);
  if (theme === null) {
    for (const [g, list] of byGroup) byGroup.set(g, [...list].sort((a, b) => size(b) - size(a)).slice(0, perTheme));
  }
  const groups = squarify(
    [...byGroup.entries()].map(([g, list]) => ({ item: g, value: list.reduce((s, h) => s + size(h), 0) })),
    rect,
  );
  const tiles = groups.flatMap((g) =>
    squarify(
      (byGroup.get(g.item) ?? []).map((h) => ({ item: h, value: size(h) })),
      g.h > labelH * 3 ? { x: g.x, y: g.y + labelH, w: g.w, h: g.h - labelH } : { x: g.x, y: g.y, w: g.w, h: g.h },
    ),
  );
  return { groups, tiles, missing: [...new Map(missing.map((m) => [m.code, m])).values()] };
}

export interface HeatmapDeps {
  entries: () => Promise<IndexEntry[]>;
  onPick: (symbol: string) => void;
  themes?: ThemeDb;
  /** Box height in px; a function is re-read on every draw (the popout window follows its size). */
  height?: number | (() => number);
  /** Overview: stocks shown per theme. */
  perTheme?: number;
  /** Group label strip height in px (match `.hm-group span` when restyling it). */
  labelHeight?: number;
  refreshMs?: number;
  /** Timer refreshes only run while this is true (default: TW stock session).
   *  The mount-time load always runs so the last close still shows. */
  isOpen?: () => boolean;
}

export type HeatmapHandle = WidgetHandle & {
  /** Re-lay out the last data (e.g. after a resize) without refetching. */
  redraw(): void;
};

/** BroadcastChannel between the popout window (heatmap.html) and the main app: `{ t: "pick", symbol }`. */
export const HEATMAP_WINDOW_CHANNEL = "opencharts.heatmap.win";

/** Height of the group label strip (matches `.hm-group span`). */
const LABEL_H = 13;

export function mountHeatmapPanel(body: HTMLElement, deps: HeatmapDeps): HeatmapHandle {
  const doc = body.ownerDocument;
  ensureMarketStyles(doc);
  const db = deps.themes ?? THEMES;
  const root = doc.createElement("div");
  root.className = "mw";
  root.style.padding = "8px";
  body.appendChild(root);
  const boxHeight = () => (typeof deps.height === "function" ? deps.height() : (deps.height ?? 420));
  const perTheme = deps.perTheme ?? 8;

  const select = doc.createElement("select");
  select.className = "hm-theme";
  select.innerHTML =
    `<option value="">全部主題（各取成交前 ${perTheme}）</option>` +
    Object.entries(db)
      .map(([k, t]) => `<option value="${escapeHtml(k)}">${escapeHtml(shortTitle(t.title))}</option>`)
      .join("");
  const view = doc.createElement("div");
  root.append(select, view);

  let last: IndexEntry[] | null = null;
  const draw = (entries: IndexEntry[]): void => {
    last = entries;
    const theme = select.value || null;
    const width = root.clientWidth > 0 ? root.clientWidth - 16 : 300;
    const height = boxHeight();
    const { groups, tiles, missing } = layoutThemeHeatmap(db, theme, entries, { x: 0, y: 0, w: width, h: height }, perTheme, deps.labelHeight ?? LABEL_H);
    if (tiles.length === 0) {
      view.innerHTML = `<div class="mw-meta">沒有主題股報價資料</div>`;
      return;
    }
    const box = (r: Rect) =>
      `left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px`;
    const tileHtml = tiles
      .map((t) => {
        const { stock, quote } = t.item;
        const label = t.w >= 34 && t.h >= 22 ? `${escapeHtml(stock.name)}<br>${fmtPct(quote.pct)}` : "";
        const title = `${stock.code} ${stock.name} ${fmtPct(quote.pct)}\n${stock.sub_group}\n${stock.role}`;
        return `<div class="hm-tile" data-symbol="${escapeHtml(`${quote.exchange}:${quote.code}`)}" title="${escapeHtml(title)}" style="${box(t)};background:${heatColor(quote.pct)}">${label}</div>`;
      })
      .join("");
    const groupHtml = groups
      .map((g) => `<div class="hm-group" style="${box(g)}"><span>${escapeHtml(g.item)}</span></div>`)
      .join("");
    const desc = theme ? `${escapeHtml(db[theme]!.description)} · ` : "";
    const lost = missing.length ? ` · ${missing.length} 檔無報價（${missing.map((m) => escapeHtml(m.name)).join("、")}）` : "";
    view.innerHTML =
      `<div class="mw-meta">${desc}${tiles.length} 檔 · 面積＝成交金額 · 點方塊切換商品${lost}</div>` +
      `<div class="hm-box" style="height:${height}px">${tileHtml}${groupHtml}</div>` +
      `<div class="mw-meta">${fmtPct(-3)} <span style="color:${heatColor(-3)}">■</span> 0 <span style="color:${heatColor(3)}">■</span> ${fmtPct(3)}</div>`;
  };

  select.addEventListener("change", () => {
    if (last) draw(last);
  });
  view.addEventListener("click", (ev) => {
    const tile = (ev.target as HTMLElement).closest?.("[data-symbol]") as HTMLElement | null;
    if (tile?.dataset.symbol) deps.onPick(tile.dataset.symbol);
  });

  const runner = latestRunner(
    () => deps.entries(),
    draw,
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      view.innerHTML = `<div class="mw-warn">無法取得熱力圖：${escapeHtml(msg)}</div>`;
    },
  );

  // Each refresh pulls ~750 KB of the daily Shioaji quota, and quotes don't move
  // outside the stock session — so the timer only fetches while it's open.
  const isOpen = deps.isOpen ?? (() => isTwStockSession(new Date()));
  const tick = setInterval(() => {
    if (isOpen()) runner.run();
  }, deps.refreshMs ?? 30_000);
  runner.run();

  return {
    refresh: () => runner.run(),
    redraw() {
      if (last) draw(last);
    },
    destroy() {
      runner.dispose();
      clearInterval(tick);
      root.remove();
    },
  };
}
