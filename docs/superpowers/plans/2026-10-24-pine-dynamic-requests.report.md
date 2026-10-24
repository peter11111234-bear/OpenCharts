# Pine dynamic_requests 一致性修正 — 執行報告

日期：2026-10-24
範圍：僅 `src/pine/builtins/strategy.ts`、`src/pine/__tests__/strategy.test.ts`

## 改動 1：strategy.ts 移除 `'dynamic_requests'`

`STRATEGY_UNSUPPORTED_PARAMS`（第 1973–1979 行）內只刪除一個元素；同檔第 1964 行 `STRATEGY_DECL_ORDER` 內的 `dynamic_requests` 未動。

## 改動 2：strategy.test.ts 新增回歸測試

放在 `describe('strategyDecl')` 內、既有 `does not warn for a declaration that only uses supported parameters` 之後。沿用檔案既有的 `parse` / `runScript` / `mkBars` helper。

## git diff（僅這兩檔）

```
 src/pine/__tests__/strategy.test.ts | 7 +++++++
 src/pine/builtins/strategy.ts       | 2 +-
 2 files changed, 8 insertions(+), 1 deletion(-)

--- Changes ---

File: src/pine/__tests__/strategy.test.ts
  @@ -216,6 +216,13 @@ describe('strategyDecl', () => {
  +  it('strategy() accepts dynamic_requests without a not-implemented warning', async () => {
  +    const src = `strategy("t", dynamic_requests=true)
  +plot(close)`;
  +    const r = await runScript(parse(src), mkBars(3, 10), { symbol: 'TEST', timeframe: 'D' });
  +    expect(r.warnings.filter((w) => w.includes('declared but not implemented'))).toEqual([]);
  +  });

File: src/pine/builtins/strategy.ts
  @@ -1974,7 +1974,7 @@ export const STRATEGY_UNSUPPORTED_PARAMS = [
  -  'calc_bars_count', 'fill_orders_on_standard_ohlc', 'dynamic_requests',
  +  'calc_bars_count', 'fill_orders_on_standard_ohlc',
```

## 驗證

指令（單一 job，未跑全量）：

```
npx vitest run src/pine/__tests__/strategy.test.ts src/pine/__tests__/named_args.test.ts
```

逐字輸出：

```
 ✓ src/pine/__tests__/named_args.test.ts (13 tests) 161ms
 ✓ src/pine/__tests__/strategy.test.ts (62 tests) 555ms

 Test Files  2 passed (2)
      Tests  75 passed (75)
   Start at  16:56:19
   Duration  13.46s (transform 3.51s, setup 2.08s, collect 6.65s, tests 716ms, environment 9.81s, prepare 890ms)
```

新測試存在且通過（verbose reporter 逐字）：

```
 ✓ src/pine/__tests__/strategy.test.ts > strategyDecl > strategy() accepts dynamic_requests without a not-implemented warning
 Test Files  1 passed (1)
      Tests  62 passed (62)
```

## 問題與如實記錄

1. 我**沒有**先觀察「修正前測試失敗」的紅燈狀態。改動 1 與改動 2 在同一輪做完才第一次跑測試，因此沒有 `fails-before` 的實證。行為上可推導：警告來源是 `STRATEGY_UNSUPPORTED_PARAMS` 過濾（見 `strategy.ts` 的 `warnUnsupported*` 路徑），移除該元素即不可能再產生該字串，但這點屬於推論而非觀察。
2. 未 commit、未 add、未 stash、未 checkout/reset。
3. 未碰 vite.config.ts、src/services/guard/*、VelaPage.tsx、interpreter.ts、debugFlags.ts。
4. 未跑全量 vitest、未跑 eslint。
5. `strategy.test.ts` 總數 62 個測試（含新增 1 個），`named_args.test.ts` 13 個，無失敗、無 skip。
