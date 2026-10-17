# T10 — adaptive tick-skip 覆蓋 dossier（唯讀探索）

## 0. 讀檔指紋（md5 不可得：本環境只有 read/grep/glob/write，無 shell；`rea capture_process_scenario` 回 `capability_unavailable`（Windows PTY 未支援））
以「行數 + 逐字行錨」代替 md5，主代理改碼前請自行覆核這幾行是否仍逐字相同：

| 檔案 | 行數 | 錨點逐字 |
|---|---|---|
| `src/pine/engine.ts` | 1000 | `:347` `if (!force && lastRunMs > HEAVY_RUN_MS && !incHolder.live && !incHolder.active && key === lastTapeKey) return;` |
| `src/pine/engine.ts` | 1000 | `:338` `const HEAVY_RUN_MS = 500;`／`:339` `let lastRunMs = 0;`／`:343` `const tapeKey = (b: OHLCV[]) => \`${b.length}:${b[b.length - 1]?.time ?? 0}\`;` |
| `src/pine/__tests__/engine.test.ts` | 432 | `:359` `it('heavy run + live session → forming-bar ticks keep running (skip exempted)', async () => {` |

## 1. 現況：已覆蓋／未覆蓋表

| # | 行為（skip 條件的哪一項） | 測試 | 位置 | 狀態 |
|---|---|---|---|---|
| C1 | heavy(`lastRunMs>500`) **＋ live session** ⇒ 同 bar tick **不跳**（`!incHolder.live` 為 false，豁免側） | `heavy run + live session → forming-bar ticks keep running (skip exempted)` | `engine.test.ts:359-386`（`runs` 1→2 @`:370-371`） | ✅ 覆蓋 |
| C2 | 便宜 run（0ms）⇒ 每 tick 都重跑 | `cheap run → every tick re-runs (unchanged live behavior)` | `engine.test.ts:388-397`（`:394-395`） | ✅ 覆蓋 |
| C3 | 同 bar tick 在 heavy 下**被跳過**（`key === lastTapeKey` 且非 live ⇒ `request()` early-return，`runs` 不增、無新 model） | — | — | ❌ **未覆蓋**（全 repo 無任何斷言 `runs` 不變／model 數不增；`grep adaptive\|DelayedEngine\|HEAVY_RUN\|lastRunMs\|tickSameBar` 僅命中 `engine.test.ts`） |
| C4 | heavy 下 **新 bar**（`key` 的 `length` 變 ⇒ 不跳）在**可跳狀態**下重跑 | 只在豁免狀態下測（`:378-384`，此時 `active=true`，整個 `if` 短路，`key` 那項根本沒被求值） | `engine.test.ts:378-384` | ❌ 未覆蓋（有執行動作、無判別力） |
| C5 | `force` 旁通（`session.update()`／`notifyBars('complete')`）在**可跳狀態**下仍跑 | `:373-376` 只在豁免狀態下測 | `engine.test.ts:373-376` | ❌ 未覆蓋（同上，`!force` 從未被 false 的 branch 驗過） |
| C6 | `lastRunMs <= 500` 邊界（`>` 為嚴格） | `DelayedEngine(0)` 為 `:` 0，`DelayedEngine(600)` 為大於 | — | ❌ 未覆蓋（且精確 =500 本質不可確定復現，建議不補） |

判定：**目前只測了豁免側（C1）+ 便宜側（C2）**；真正會觸發 `return` 的那串條件（`!force && lastRunMs>500 && !live && !active && key===lastTapeKey`）**零測試**。`engine.test.ts:310-316` 的註解卻同時宣稱「forming-bar ticks … are skipped」——**註解描述了 4 種行為、測試只守住 2 種中的豁免側**。

## 2. 為何 skip 側在 in-process 觸發不了（關鍵事實）

- `request()` 的 skip 需要 `!incHolder.live && !incHolder.active`（`engine.ts:347`）。
- in-process `runProgram` 收尾：`holder.live = out.live;`、`if (opts.incHolder) opts.incHolder.active = out.live !== null;`（`engine.ts:484-486`）。
- `out.live === null` 只有三條路：`bars.length === 0`（`interpreter.ts:3670`、`buildSess` 唯一 `return null` 在 `interpreter.ts:2902` 同條件）或 `shouldAbort()`（`interpreter.ts:3675/3695/3703`，而 `shouldAbort` 只由 `stop()` 觸發，`engine.ts:400`）。
- ⇒ **非空 tape + 成功路徑 ⇒ `live !== null` ⇒ `active === true` ⇒ skip 分支不可達。**
- ⇒ 也因此在 `engine.ts:347` 的 in-process 情況下，`!incHolder.active` 項與 `!incHolder.live` **恆等**（`active` 只在 run 結束時被寫），該項是**為 off-thread 而存在**：`pineWorkerEngine.ts:32-46`（`incHolder.live` 永為 null，`incHolder.active = client.incAlive` ← `pineWorkerClient.ts:158` ← worker `done.incAlive = out.live !== null`，`pineWorker.ts:149/159`）。

## 3. 補測試草稿（最小形狀；控制「run > HEAVY_RUN_MS」的既有手法＝`DelayedEngine(delayMs)` spin，`engine.test.ts:318-331`）

因為 §2，**用公開 API（非空 tape）無法進入 skip 狀態**；唯一輕量做法是在測試子類裡把 holder 還原成「沒有 live session」（白箱，但正好蓋住 skip 的守衛語意）：

```ts
class HeavyNoLiveEngine extends DelayedEngine {
  protected override async runProgram(
    parsed: ParsedInput, barData: BarData[], opts: RunOptions & { sessionCtx?: unknown },
  ) {
    const r = await super.runProgram(parsed, barData, opts);      // 先讓 super 把 active 設 true
    const h = (opts as { incHolder?: { live: unknown; active?: boolean } }).incHolder;
    if (h) { h.live = null; h.active = false; }                   // 模擬「這個 run 拿不到 live session」
    return r;
  }
}

it('heavy run + no live session → forming-bar tick is skipped; new bar / update still re-run', async () => {
  const engine = new HeavyNoLiveEngine(600);          // 600ms > HEAVY_RUN_MS(500)
  const { tape, session, c } = await exec(engine, mkBars(10));
  await c.waitFor(1);
  expect(engine.runs).toBe(1);

  // (C3) 同 bar tick ⇒ 被跳過：runs 不變、沒有第 2 個 model。
  // runProgram 的 runs++ 是同步發生的（drain() 內 await 前即呼叫），
  // notifyBars() 一返回即可斷言，不需等 microtask（waitFor(2) 會永遠卡住 — 不可用）。
  tickSameBar(tape);
  session.notifyBars();
  expect(engine.runs).toBe(1);
  expect(c.models).toHaveLength(1);

  // (C4) 新 bar（tapeKey 的 length 變）⇒ 不跳
  tape.bars = [...tape.bars, { time: 10 * 3600000, open: 1, high: 2, low: 0, close: 1, volume: 1 }];
  session.notifyBars();
  await c.waitFor(2);
  expect(engine.runs).toBe(2);

  // (C5) force 旁通
  session.update({});
  await c.waitFor(3);
  expect(engine.runs).toBe(3);
  session.stop();
});
```

- 重用既有 fixture：`exec()`（`engine.test.ts:338-351`）、`tickSameBar()`（`:353-357`）、`collect()`（`:41-55`）、`mkBars()`（`:10-18`，`time = i*3600000` ⇒ 新 bar 用 `10*3600000`）。
- 注意 `waitFor(k)` 只在第 k 個 model 到齊時 resolve（`:48-53`）⇒ **skip 斷言絕對不能用 `waitFor`**（會 hang）。
- worker 側（真實路徑）要觸發 skip 得讓 worker 回 `done` 帶 `incAlive:false` 且整趟 >500ms；但真 `createWorkerHandler` 的 `incAlive` 由 `out.live!==null` 決定（非空 tape 恆 true，`pineWorker.ts:149/159`），所以只能偽造協定訊息（另寫一個不經 handler 的 FakeWorker + >500ms 延遲），成本高、真實度低 ⇒ 建議只做上面那支 in-process 版；worker 側以 `pineWorkerEngine.ts:44` 的鏡射為單獨一行覆蓋即可（本輪不需）。
- 不要補 `lastRunMs === 500` 的精確邊界（不可確定復現）。

## 4. 對「非空 tape 實質不可達 ⇒ 死碼」的結論（碼＋測試兩邊證據）

- **「成功路徑上實質不可達」= 成立**：in-process（`engine.ts:484-486` + `interpreter.ts:2902/3670/3675`）與 off-thread（`pineWorkerEngine.ts:44` ← `pineWorkerClient.ts:158` ← `pineWorker.ts:149/159`）都指向同一結論：非空 tape 的成功 run 必讓 `live`/`incAlive` 非 null ⇒ 跳過條件不成立。且有測試側佐證：**沒有任何測試斷言過 skip**（§1 C3-C5 全空），`DelayedEngine(600)` 兩支都恰好在豁免/便宜側。
- **「（全域）死碼、可刪」= 不成立**，四條反證：
  1. `incHolder.active` 只在**成功**路徑被寫（`engine.ts:486`、`pineWorkerEngine.ts:44`）；`pineWorkerEngine.ts:47` 的 `.catch` 只 reject、不刷新 `active` ⇒ worker 傳輸錯時 holder 仍是上一次的值。
  2. `PineRunClient.dispose()` 把 `incAlive = false`（`pineWorkerClient.ts:248`）；`incAlive=false` 且非 factory 的 client 會 terminate worker（`:151-156`），下一拍若同 bar 就會真的走到 skip。
  3. `lastRunMs` 也只在成功路徑賦值（`engine.ts:413`）⇒ 例外後保留上一個 heavy 值，與 stale `active` 可組合。
  4. `active` 這個欄位存在的**唯一理由**就是 off-thread 鏡射（`pineWorkerEngine.ts:42-44` 註解：「the engine's heavy-tick exemption keys off it for the off-thread path」）；刪掉分支等於刪掉 off-thread 的既有防護 + 不會有任何測試變紅（無測試守住）。
- **建議措辭**（給文件更正用）：「adaptive tick-skip 的 skip 分支在非空 tape 的成功路徑上實質不可達，且**無測試覆蓋**；但它同時是 worker 路徑的 liveness 鏡射出口，錯誤／dispose 路徑會留下可觸發的狀態 ⇒ 屬『已知、接受』，不是可證明死碼；要動必須先加 §3 的測試（否則沒有東西守住這個決定）。」

## 5. 不確定處
- md5 無法取得（無 shell；Windows PTY 不支援）⇒ 指紋以行數＋逐字行錨代替；`ta.ts`/`mtf.ts`/`series.ts` 本輪未讀，未涉入。
- `pineWorker.ts` 我只讀了 `:148-160` 的分支（`incAlive` 來源），未逐行掃有無其他 null-live 產生點；若 worker 另有 `out.live=null` 的非空 tape 路徑，§4 的「成功路徑不可達」需修正（但 `incRun` 的 null 來源在 `interpreter.ts:3662-3705` 已逐一列舉：empty tape / shouldAbort）。
- 未執行任何測試（依約束），行為判定皆由碼推導。
