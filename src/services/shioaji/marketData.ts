/**
 * Market-wide data for the Vela quote widgets (quote strip, electronics
 * heatmap, hotlists), straight from the local shioaji server through the Vite
 * `/shioaji` proxy like server.ts. Server behaviour verified 2026-10-20:
 * - snapshots accept continuous futures (TXFR1/MXFR1/TMFR1) and the index IX0001.
 * - index_components only accepts IND/TSE/IX0001 (or IX0043/OTC).
 * - scanner requires `date`; `ascending: true` returns the LARGEST values first;
 *   a non-trading date returns [].
 * - names from scanner / contract info are often mojibake (U+FFFD) — see cleanName.
 */
import type { ContractRef } from "./server.ts";

const BASE = "/shioaji/api/v1";

export type HttpFn = (path: string, init?: { method?: "GET" | "POST"; body?: unknown }) => Promise<unknown>;

export const defaultHttp: HttpFn = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`shioaji ${path} failed: ${res.status}`);
  return res.json();
};

// ── Snapshots ──

export interface QuoteSnap {
  code: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  changePrice: number;
  changeRate: number;
  totalVolume: number;
  totalAmount: number;
  datetime: string;
}

interface RawSnap {
  code: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  change_price?: number;
  change_rate?: number;
  total_volume?: number;
  total_amount?: number;
  datetime?: string;
}

export async function fetchQuotes(refs: ContractRef[], http: HttpFn = defaultHttp): Promise<QuoteSnap[]> {
  if (refs.length === 0) return [];
  const raw = (await http("/data/snapshots", { method: "POST", body: { contracts: refs } })) as RawSnap[];
  return raw.map((s) => ({
    code: s.code,
    exchange: s.exchange,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    changePrice: s.change_price ?? 0,
    changeRate: s.change_rate ?? 0,
    totalVolume: s.total_volume ?? 0,
    totalAmount: s.total_amount ?? 0,
    datetime: s.datetime ?? "",
  }));
}

// ── Index components (heatmap) ──

/** TWSE industry codes for the electronics sector. */
export const ELECTRONICS_CATEGORIES: readonly string[] = ["24", "25", "26", "27", "28", "29", "30", "31"];

export interface IndexEntry {
  code: string;
  exchange: string;
  category: string;
  price: number;
  pct: number;
  weightPpm: number;
  amount: number;
}

interface RawEntry {
  contract: { exchange: string; code: string };
  category: string;
  price?: string | null;
  pct_chg?: string | null;
  reference_weight_ppm?: number | null;
  total_amount?: number | null;
}

export async function fetchIndexEntries(http: HttpFn = defaultHttp): Promise<IndexEntry[]> {
  const raw = (await http("/data/index_components", {
    method: "POST",
    body: { contract: { security_type: "IND", exchange: "TSE", code: "IX0001" } },
  })) as { entries?: RawEntry[] };
  return (raw.entries ?? [])
    .map((e) => ({
      code: e.contract.code,
      exchange: e.contract.exchange,
      category: String(e.category),
      price: e.price == null ? Number.NaN : Number(e.price),
      pct: e.pct_chg == null ? Number.NaN : Number(e.pct_chg),
      weightPpm: e.reference_weight_ppm ?? 0,
      amount: e.total_amount ?? 0,
    }))
    .filter((e) => Number.isFinite(e.pct));
}

// ── Scanner (hotlists) ──

export type RankKind = "gainers" | "losers" | "volume" | "amount";

const RANK_QUERY: Record<RankKind, { scanner_type: string; ascending: boolean }> = {
  gainers: { scanner_type: "ChangePercentRank", ascending: true },
  losers: { scanner_type: "ChangePercentRank", ascending: false },
  volume: { scanner_type: "VolumeRank", ascending: true },
  amount: { scanner_type: "AmountRank", ascending: true },
};

export interface RankRow {
  code: string;
  name: string;
  close: number;
  changePrice: number;
  changeRate: number;
  totalVolume: number;
  totalAmount: number;
  date: string;
}

interface RawRank {
  date: string;
  code: string;
  name?: string;
  close: number;
  change_price: number;
  total_volume: number;
  total_amount: number;
}

/** YYYY-MM-DD of `d` in Asia/Taipei (UTC+8, no DST). */
export function taipeiDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** The server often returns names with U+FFFD (lost encoding) — show none rather than garbage. */
export function cleanName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n.includes("�") ? "" : n;
}

/** Latest trading day's ranking: walks back from `now` past weekends/holidays (empty days). */
export async function fetchRanking(
  kind: RankKind,
  count: number,
  now: Date,
  http: HttpFn = defaultHttp,
  maxDaysBack = 7,
): Promise<RankRow[]> {
  const q = RANK_QUERY[kind];
  for (let back = 0; back <= maxDaysBack; back++) {
    const date = taipeiDate(new Date(now.getTime() - back * 86_400_000));
    const raw = (await http("/data/scanner", { method: "POST", body: { ...q, count, date } })) as RawRank[];
    if (raw.length === 0) continue;
    return raw.map((r) => {
      const prev = r.close - r.change_price;
      return {
        code: r.code.trim(),
        name: cleanName(r.name),
        close: r.close,
        changePrice: r.change_price,
        changeRate: prev > 0 ? (r.change_price / prev) * 100 : 0,
        totalVolume: r.total_volume,
        totalAmount: r.total_amount,
        date: r.date,
      };
    });
  }
  return [];
}

// ── Contract info (exchange lookup for click-to-switch) ──

export interface ContractInfo {
  code: string;
  exchange: string;
  name: string;
  category: string;
}

const infoCache = new Map<string, Promise<ContractInfo | null>>();

export function fetchContractInfo(code: string, http: HttpFn = defaultHttp): Promise<ContractInfo | null> {
  let hit = infoCache.get(code);
  if (!hit) {
    hit = (http(`/data/contracts/${encodeURIComponent(code)}/info`) as Promise<ContractInfo>).then(
      (i) => ({ code: i.code, exchange: i.exchange, name: cleanName(i.name), category: String(i.category) }),
      () => null,
    );
    infoCache.set(code, hit);
  }
  return hit;
}

export function clearContractInfoCache(): void {
  infoCache.clear();
}

// ── Vela symbol → shioaji contract ──

/** `TSE:2330` / `OTC:6547` / `TAIFEX:TMFK6` / bare `2330` / `TXFR1` / `IX0001`.
 *  Bare numeric codes are assumed TSE (Vela's symbol picker always prefixes OTC). */
export function toContractRef(symbol: string): ContractRef | null {
  const colon = symbol.indexOf(":");
  const prefix = colon < 0 ? "" : symbol.slice(0, colon).trim().toUpperCase();
  const code = (colon < 0 ? symbol : symbol.slice(colon + 1)).trim().toUpperCase();
  if (!code) return null;
  if (/^IX\d{4}$/.test(code)) return { security_type: "IND", exchange: prefix === "OTC" ? "OTC" : "TSE", code };
  if (prefix === "TAIFEX" || (prefix === "" && /^[A-Z]{3}(R[12]|[A-L]\d)$/.test(code))) {
    return { security_type: "FUT", exchange: "TAIFEX", code };
  }
  if (prefix === "TSE" || prefix === "OTC") return { security_type: "STK", exchange: prefix, code };
  if (prefix === "" && /^\d{4,6}[A-Z]?$/.test(code)) return { security_type: "STK", exchange: "TSE", code };
  return null;
}
