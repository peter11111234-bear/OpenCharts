import { describe, expect, it } from "vitest";
import { mapSymbol } from "../TradingViewWidgets.tsx";

const NOW = new Date("2026-10-20T12:00:00+08:00");

describe("mapSymbol — Taiwan (shioaji/Vela → TradingView)", () => {
  it("maps dated TAIFEX futures to the same month on TV (TAIFEX J = Oct → CME V)", () => {
    expect(mapSymbol("MXFJ6", NOW)).toBe("TAIFEX:MXFV2026");
    expect(mapSymbol("TXFJ6", NOW)).toBe("TAIFEX:TXFV2026");
    expect(mapSymbol("TAIFEX:TXFJ6", NOW)).toBe("TAIFEX:TXFV2026");
    expect(mapSymbol("MXFK6", NOW)).toBe("TAIFEX:MXFX2026");
    expect(mapSymbol("TXFL6", NOW)).toBe("TAIFEX:TXFZ2026");
    expect(mapSymbol("TXFC7", NOW)).toBe("TAIFEX:TXFH2027");
  });

  it("only month-less roots and shioaji continuous codes become continuous contracts", () => {
    expect(mapSymbol("TXF", NOW)).toBe("TAIFEX:TXF1!");
    expect(mapSymbol("MXF", NOW)).toBe("TAIFEX:MXF1!");
    expect(mapSymbol("TXFR1", NOW)).toBe("TAIFEX:TXF1!");
    expect(mapSymbol("MXFR2", NOW)).toBe("TAIFEX:MXF2!");
  });

  it("shows micro TAIEX (TMF) as the same-month mini on TV (TV has no TMF ratings)", () => {
    expect(mapSymbol("TMFJ6", NOW)).toBe("TAIFEX:MXFV2026");
    expect(mapSymbol("TAIFEX:TMFK6", NOW)).toBe("TAIFEX:MXFX2026");
    expect(mapSymbol("TMFR1", NOW)).toBe("TAIFEX:MXF1!");
    expect(mapSymbol("TMF", NOW)).toBe("TAIFEX:MXF1!");
  });

  it("rolls the year digit into the nearest decade", () => {
    expect(mapSymbol("TXFA0", new Date("2029-12-01"))).toBe("TAIFEX:TXFF2030");
    expect(mapSymbol("TXFL9", new Date("2030-01-05"))).toBe("TAIFEX:TXFZ2029");
  });

  it("maps shioaji listing prefixes to TV exchanges (TSE is Tokyo on TV)", () => {
    expect(mapSymbol("TSE:2330", NOW)).toBe("TWSE:2330");
    expect(mapSymbol("OTC:6547", NOW)).toBe("TPEX:6547");
    expect(mapSymbol("2330", NOW)).toBe("TWSE:2330");
    expect(mapSymbol("00878", NOW)).toBe("TWSE:00878");
  });

  it("leaves existing non-Taiwan mappings alone", () => {
    expect(mapSymbol("EURUSD", NOW)).toBe("FX:EURUSD");
    expect(mapSymbol("ES", NOW)).toBe("CME_MINI:ES1!");
    expect(mapSymbol("USDSEK", NOW)).toBe("FX:USDSEK");
    expect(mapSymbol("NASDAQ:AAPL", NOW)).toBe("NASDAQ:AAPL");
  });
});
