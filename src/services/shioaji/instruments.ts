import type { Symbol } from "../schemas.ts";
import type { ContractRef, SecurityType } from "./server.ts";
import { readCachedFrontMonth } from "./frontMonth.ts";

/**
 * Taiwan instruments served from the local shioaji server.
 *
 * - 2330 台積電 (STK/TSE): tick 5 元（千元級距）；paper 計價 contractSize=1。
 * - TMF 微台 (FUT/TAIFEX): 1 點 = NT$10 — the user's traded contract.
 * - MXF 小台 (FUT/TAIFEX): 1 點 = NT$50.
 * - TMFR1 / MXFR1: continuous near month, history only (backtests).
 *
 * 重要：
 * 1. 即時訂閱必須用實際到期月份（TMFK6），連續近月（TMFR1/MXFR1）只能查
 *    歷史 kbars，訂了也不會推 tick — so they are not in LIVE_INSTRUMENTS.
 *    The dated codes are computed by frontMonthCode() at load (reload the page
 *    after a roll); no more hand-editing on the 3rd Wednesday.
 * 2. paper engine 的 contractSize 來自 demo/instruments.ts 的 getDemoSymbol，
 *    這裡的 contractSize 目前只影響顯示/PnL 換算的一致性註記 — engine 找不到
 *    TW 代碼會 fallback 為 1，即 paper PnL 以「點」計，未乘契約乘數。
 */

export interface TwInstrument {
  symbol: Symbol;
  contract: ContractRef;
}

function equity(name: string, displayName: string, tickSize: number): Symbol {
  return {
    id: name,
    name,
    displayName,
    category: "EQUITIES",
    contractSize: 1,
    tickSize,
    tickValue: tickSize,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: "09:00",
    tradingHoursEnd: "13:30",
    isActive: true,
  };
}

function future(name: string, displayName: string, contractSize: number): Symbol {
  return {
    id: name,
    name,
    displayName,
    category: "FUTURES",
    contractSize,
    tickSize: 1,
    tickValue: contractSize,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: "08:45",
    tradingHoursEnd: "13:45",
    isActive: true,
  };
}

const TAIFEX_MONTHS = "ABCDEFGHIJKL";

/**
 * TAIFEX front-month code, e.g. frontMonthCode("TMF") → "TMFK6". Contracts
 * expire on the 3rd Wednesday; the day session ends 13:45 and the 15:00 night
 * session already trades the next month, so the roll happens at 13:45 Taipei
 * on expiry day (same rule as scripts/jev-shadow.py / shioaji-watchdog.ps1).
 */
export function frontMonthCode(root: string, now: Date = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3_600_000); // Taipei wall clock in UTC fields
  let y = t.getUTCFullYear();
  let m = t.getUTCMonth();
  const expiry = new Date(Date.UTC(y, m, 15));
  while (expiry.getUTCDay() !== 3) expiry.setUTCDate(expiry.getUTCDate() + 1);
  const roll = expiry.getTime() + (13 * 60 + 45) * 60_000;
  if (t.getTime() >= roll) {
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return `${root}${TAIFEX_MONTHS[m]}${y % 10}`;
}

function contractMonth(code: string): string {
  const now = new Date(Date.now() + 8 * 3_600_000);
  const m = TAIFEX_MONTHS.indexOf(code.at(-2)!) + 1;
  const decade = now.getUTCFullYear() - (now.getUTCFullYear() % 10);
  let y = decade + Number(code.at(-1));
  if (y < now.getUTCFullYear()) y += 10;
  return `${y}${String(m).padStart(2, "0")}`;
}

function futureInstrument(code: string, name: string, contractSize: number): TwInstrument {
  const label = /R\d$/.test(code) ? `${name} 連續近月` : `${name} ${contractMonth(code)}`;
  return {
    symbol: future(code, label, contractSize),
    contract: { security_type: "FUT", exchange: "TAIFEX", code },
  };
}

// The broker's answer (cached by pages/velaContractRoll.ts) wins over the rule:
// it follows TAIFEX holiday / typhoon postponements the rule cannot know.
const TMF = readCachedFrontMonth("TMF") ?? frontMonthCode("TMF");
const MXF = readCachedFrontMonth("MXF") ?? frontMonthCode("MXF");

/** Instruments that stream ticks (dated contracts + 2330): what the feed and watchdog subscribe. */
export const LIVE_INSTRUMENTS: TwInstrument[] = [
  {
    symbol: equity("2330", "台積電", 5),
    contract: { security_type: "STK", exchange: "TSE", code: "2330" },
  },
  futureInstrument(TMF, "微台", 10),
  futureInstrument(MXF, "小台", 50),
];

export const TW_INSTRUMENTS: TwInstrument[] = [
  ...LIVE_INSTRUMENTS,
  futureInstrument("TMFR1", "微台", 10),
  futureInstrument("MXFR1", "小台", 50),
];

export const TW_SYMBOLS: Symbol[] = TW_INSTRUMENTS.map((i) => i.symbol);

const byName = new Map<string, TwInstrument>(TW_INSTRUMENTS.map((i) => [i.symbol.name, i]));

export function getTwInstrument(name: string): TwInstrument | undefined {
  return byName.get(name);
}

export function streamKey(security_type: SecurityType): string {
  return security_type;
}
