import type { Symbol } from "../schemas.ts";
import type { ContractRef, SecurityType } from "./server.ts";

/**
 * Taiwan instruments served from the local shioaji server.
 *
 * - 2330 台積電 (STK/TSE): tick 5 元（千元級距）；paper 計價 contractSize=1。
 * - TXFJ6 大台 202610 (FUT/TAIFEX): 1 點 = NT$200。
 * - MXFJ6 小台 202610 (FUT/TAIFEX): 1 點 = NT$50。
 *
 * 重要：
 * 1. 即時訂閱必須用實際到期月份（TXFJ6），連續近月（TXFR1/MXFR1）只能查
 *    歷史 kbars，訂了也不會推 tick。每月第三個週三換約時記得更新代碼
 *    （contracts futures --root TXF/MXF 可查）。
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

export const TW_INSTRUMENTS: TwInstrument[] = [
  {
    symbol: equity("2330", "台積電", 5),
    contract: { security_type: "STK", exchange: "TSE", code: "2330" },
  },
  {
    symbol: future("TXFJ6", "大台 202610", 200),
    contract: { security_type: "FUT", exchange: "TAIFEX", code: "TXFJ6" },
  },
  {
    symbol: future("MXFJ6", "小台 202610", 50),
    contract: { security_type: "FUT", exchange: "TAIFEX", code: "MXFJ6" },
  },
];

export const TW_SYMBOLS: Symbol[] = TW_INSTRUMENTS.map((i) => i.symbol);

const byName = new Map<string, TwInstrument>(TW_INSTRUMENTS.map((i) => [i.symbol.name, i]));

export function getTwInstrument(name: string): TwInstrument | undefined {
  return byName.get(name);
}

export function streamKey(security_type: SecurityType): string {
  return security_type;
}
