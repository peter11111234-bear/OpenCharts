/**
 * Shioaji server HTTP + SSE client (browser-side).
 *
 * Talks to the local `shioaji server` (default http://127.0.0.1:8080) through
 * the Vite dev proxy (`/shioaji` → 127.0.0.1:8080, see vite.config.ts) so the
 * browser never needs CORS on the server and no API key ever touches the
 * frontend — the server holds SJ_API_KEY / SJ_SEC_KEY.
 *
 * Verified against shioaji 1.7.2 (2026-09-18):
 * - POST /api/v1/data/kbars      {contract:{security_type,exchange,code},start,end}
 * - POST /api/v1/data/snapshots  {contracts:[{security_type,exchange,code}]}
 * - POST /api/v1/stream/subscribe {security_type,exchange,code,quote_type}
 * - GET  /api/v1/stream/data/tick_stk | tick_fop   (SSE, event: tick_stk/tick_fop)
 */

const BASE = "/shioaji";

export type SecurityType = "STK" | "FUT" | "OPT" | "IND";
export type Exchange = "TSE" | "OTC" | "TAIFEX";
export type QuoteType = "Tick" | "BidAsk" | "Quote";

export interface ContractRef {
  security_type: SecurityType;
  exchange: Exchange;
  code: string;
}

export interface KbarsResponse {
  datetime: string[];
  Open: number[];
  High: number[];
  Low: number[];
  Close: number[];
  Volume: number[];
  Amount: number[];
}

export interface SnapshotResponse {
  datetime: string;
  code: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  buy_price: number;
  buy_volume: number;
  sell_price: number;
  sell_volume: number;
  total_volume: number;
}

export interface TickEvent {
  code: string;
  date: string;
  time: string;
  close: string | number;
  volume: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`shioaji ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export function getKbars(contract: ContractRef, start: string, end: string): Promise<KbarsResponse> {
  return post<KbarsResponse>("/api/v1/data/kbars", { contract, start, end });
}

export function getSnapshots(contracts: ContractRef[]): Promise<SnapshotResponse[]> {
  return post<SnapshotResponse[]>("/api/v1/data/snapshots", { contracts });
}

export function subscribeQuote(contract: ContractRef, quote_type: QuoteType = "Tick"): Promise<unknown> {
  return post("/api/v1/stream/subscribe", { ...contract, quote_type });
}

export function unsubscribeQuote(contract: ContractRef, quote_type: QuoteType = "Tick"): Promise<unknown> {
  return post("/api/v1/stream/unsubscribe", { ...contract, quote_type });
}

/** SSE stream path per security type (tick only; stocks + futures). */
export function tickStreamPath(security_type: SecurityType): string {
  return security_type === "FUT" ? "/api/v1/stream/data/tick_fop" : "/api/v1/stream/data/tick_stk";
}

/** SSE event name per security type. */
export function tickEventName(security_type: SecurityType): string {
  return security_type === "FUT" ? "tick_fop" : "tick_stk";
}

export function openEventSource(path: string): EventSource {
  return new EventSource(`${BASE}${path}`);
}
