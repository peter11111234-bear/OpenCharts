/**
 * API client to communicate with the NautilusTrader backend engine.
 * Backend default: http://127.0.0.1:8000
 */

export interface BacktestParams {
  symbol?: string;
  contract_month?: string;
  fast_ema?: number;
  slow_ema?: number;
  initial_cash?: number;
  fixed_fee_per_lot?: number;
  num_bars?: number;
}

export interface TradeMarkerData {
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts_event: number; // nanoseconds
}

export interface BacktestSummary {
  symbol: string;
  initial_cash: number;
  ending_balance: number;
  total_pnl: number;
  pnl_pct: number;
  total_orders: number;
  total_positions: number;
}

export interface BacktestResponse {
  status: "success" | "error";
  summary: BacktestSummary;
  trade_markers: TradeMarkerData[];
  detail?: string;
}

export interface EngineHealth {
  status: string;
  engine: string;
  version: string;
  market: string;
}

const DEFAULT_NAUTILUS_HOST = "http://127.0.0.1:8000";

export async function checkNautilusHealth(host: string = DEFAULT_NAUTILUS_HOST): Promise<EngineHealth | null> {
  try {
    const res = await fetch(`${host}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as EngineHealth;
  } catch {
    return null;
  }
}

export async function runNautilusBacktest(
  params: BacktestParams = {},
  host: string = DEFAULT_NAUTILUS_HOST,
): Promise<BacktestResponse> {
  const payload = {
    symbol: params.symbol ?? "TX",
    contract_month: params.contract_month ?? "HOT",
    fast_ema: params.fast_ema ?? 5,
    slow_ema: params.slow_ema ?? 15,
    initial_cash: params.initial_cash ?? 1_000_000,
    fixed_fee_per_lot: params.fixed_fee_per_lot ?? 40.0,
    num_bars: params.num_bars ?? 120,
  };

  const res = await fetch(`${host}/api/backtest/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nautilus 回測伺服器錯誤 (${res.status}): ${err}`);
  }

  return (await res.json()) as BacktestResponse;
}
