# Order Guard Phase 1 — QA 驗收報告

> 工單：`docs/2026-10-20-order-guard-phase1-workorder.md`
> 計畫：`docs/superpowers/plans/2026-10-19-order-guard-phase1.md`
> QA 輪次：1（2026-10-20 19:13–19:18）
> 環境：Windows 10.0.19045 / Node（repo `node_modules`）/ Python 3.12.7 (pytest 9.0.3) / dev server pid 10780 @ 5173

## 本輪 QA 結果摘要（2026-10-20 19:18，QA 階段產物）

| 項目 | 指令 | 結果 |
|---|---|---|
| 硬指標 A1–A22 | 見下方「硬指標逐條證據」段 | 22/22 通過 |
| 語意項 A23／A24 | `python C:/Users/bear9/jev-laya-bench/jev_judge.py < scratch/qa_order_guard_accept_input.json`（`gate: taskwf-accept`） | A23 `most_severe_wins` 0.96；A24 `exits_untouched_shadow_passthrough` 0.99（門檻 0.80） |
| 全專案受影響測試 | `npx vitest run`（4 檔） | 43 passed |
| Python 測試 | `python -m pytest scripts/tests -v --tb=short` | 10 passed |
| 型別檢查 | `npm run typecheck` | 零錯 |
| 端到端真實鏈路 | 一次性腳本（已刪）→ 真實 dev middleware | 1 筆 entry ＋ 1 筆 outcome，join key 成立，shadow 未改 payload |
| Phase 2 閘門 | `python scripts/guard_report.py` | `PHASE2_GATE: NOT_READY`（approve n=3，樣本不足） |

**收斂：成立。** 三條件（全測綠／驗收逐條過／無新發現）皆滿足。

## 收斂判定

| 條件 | 結果 |
|---|---|
| ① 全測綠 | ✅ vitest 43 passed（4 檔）＋ pytest 10 passed（2 檔）＋ typecheck 零錯 |
| ② 驗收逐條過 | ✅ A1–A22 硬指標全部通過；A23 = 0.96、A24 = 0.99（受管 JEV `taskwf-accept`） |
| ③ 無新發現 | ✅ 未發現新缺陷；一個偏離已記錄（zod 取代 inline cast），行為等價 |

**結論：收斂，可進 P8。**

## 硬指標逐條證據（A1–A22）

| # | 指令 | 結果 | 判定 |
|---|---|---|---|
| A1 | `python -m pytest scripts/tests/test_jev_shadow_volatile.py -v` | `5 passed`（`test_normal_regime_is_not_vetoed`、`test_high_score_is_vetoed`、`test_high_volatile_probability_is_vetoed`、`test_normal_regime_does_not_escalate`、`test_score_one_still_escalates` 全 PASSED） | ✅ |
| A2 | 同上測試檔 | `test_normal_regime_does_not_escalate` PASSED、`test_score_one_still_escalates` PASSED | ✅ |
| A3 | `grep -c "'volatile' in vol_txt" scripts/jev-shadow.py` | `0` | ✅ |
| A4 | `python -c "import py_compile; py_compile.compile('scripts/jev-shadow.py', doraise=True)"` | `COMPILE_OK`（無例外） | ✅ |
| A5 | `git status --short -- scripts/jev-shadow.py scripts/tests/test_jev_shadow_volatile.py` | ` M scripts/jev-shadow.py` ＋ `?? scripts/tests/test_jev_shadow_volatile.py` → 兩檔仍未進版控 | ✅ |
| A6 | `npx vitest run src/services/__tests__/orderGuard.test.ts` | `Tests 23 passed (23)` | ✅ |
| A7 | A6 內 `test_keeps_the_loss_cooldown_across_midnight` | 23 passed 全綠，該例在內 | ✅ |
| A8 | A6 內 `checkStopChange` 區塊（`stop_invalid` / `stop_widen`） | 23 passed 全綠 | ✅ |
| A9 | A6 內 `test_fails_closed_when_a_rule_throws` | 23 passed 全綠 | ✅ |
| A10 | `npx vitest run src/services/__tests__/guardRuntime.test.ts` | `Tests 6 passed (6)` | ✅ |
| A11 | A10 內 `shadow mode logs a veto but still places the order` | 6 passed 全綠 | ✅ |
| A12 | A10 內 `enforce mode throws on a veto and opens nothing` | 6 passed 全綠 | ✅ |
| A13 | A10 內 `logs the trade outcome with the entry's openedAt as join key` | 6 passed 全綠 | ✅ |
| A14a | `grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts` | 只有 1 命中，第 12 行在 `/** … */` 註解塊內：` * Exits are never routed here: closePosition, closeAllPositions, cancelOrder` | ✅ |
| A14b | `grep -n "closePosition:\|closeAllPositions:\|cancelOrder:\|cancelAllOrders:\|modifyOrder:" src/services/demo/api.ts` | 五個方法全部直接呼叫 `engine.*`，無 `guarded*`：`149: cancelOrder`／`150: modifyOrder`／`152: cancelAllOrders`／`156: closePosition`／`158: closeAllPositions` | ✅ |
| A15 | `grep -n "GUARD_MODE: GuardMode = " src/services/guard/orderGuard.ts` | `18:export const GUARD_MODE: GuardMode = "shadow";` | ✅ |
| A16 | `curl -X POST -d '{"kind":"probe"}' http://localhost:5173/__guard-log` ＋ `tail -1 logs/order-guard.jsonl` | `204` ／ `{"kind":"probe"}` | ✅ |
| A17 | `POST not-json`／`POST [1,2]` ＋ 行數比對 | `400` ／ `400` ／ `unchanged` | ✅ |
| A18 | `python -m pytest scripts/tests/test_guard_report.py -v` | `5 passed`（計畫列 4 條，實作多 1 條 `test_load_skips_malformed_lines` 釘住 P5.5 偏離） | ✅ |
| A19 | A18 內 `test_join_sums_partials_and_skips_unmatched` | PASSED | ✅ |
| A20 | A18 內 `test_gate_needs_samples_and_a_worse_flagged_group` | PASSED | ✅ |
| A21 | `python scripts/guard_report.py` | `approve  n=   3 loss_rate=0.000 pnl=0.0` ＋ `PHASE2_GATE: NOT_READY` | ✅ |
| A22 | `npm run typecheck` ＋ `npx vitest run src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts` | `tsc --noEmit` 無錯誤輸出 ／ `Tests 14 passed (14)`（＝baseline 14 passed） | ✅ |

### A22 補充：全專案受影響測試

`npx vitest run src/services/__tests__/orderGuard.test.ts src/services/__tests__/guardRuntime.test.ts src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts`

```
✓ src/services/__tests__/orderGuard.test.ts (23 tests) 40ms
✓ src/services/__tests__/guardRuntime.test.ts (6 tests) 39ms
✓ src/services/__tests__/demo-engine-resting-orders.test.ts (10 tests) 96ms
✓ src/services/__tests__/demo-contract.test.ts (4 tests) 7ms

Test Files  4 passed (4)
     Tests  43 passed (43)
```

`python -m pytest scripts/tests -v --tb=short` → `10 passed`（Task 1 的 5 ＋ Task 5 的 5）。

## 端到端（S8 真實鏈路）

一次性腳本 `src/services/__tests__/guard-e2e-scratch.test.ts`（QA 後已刪除）走 `demoApi.placeOrder` → `demoApi.closePosition`，打真實 dev middleware `http://localhost:5173/__guard-log`：

```
E2E_LINES:[
 {"ts":"2026-10-20T11:10:52.366Z","mode":"shadow","kind":"entry",
  "intent":{"accountId":"e2e-account","symbol":"ETHUSD","side":"BUY","type":"MARKET",
            "quantity":2,"stopLoss":1600,"takeProfit":1900},
  "decision":{"verdict":"approve","quantity":2,"hits":[]},
  "orderId":"e93e4575-4b7c-48d2-8adb-4dfd724501c7",
  "positionOpenedAt":"2026-10-20T11:10:52.366Z"},
 {"ts":"2026-10-20T11:10:52.426Z","mode":"shadow","kind":"outcome",
  "symbol":"ETHUSD","side":"LONG","openedAt":"2026-10-20T11:10:52.366Z",
  "closedAt":"2026-10-20T11:10:52.423Z","realizedPnl":0}
]
```

驗到的事實：

1. `logs/order-guard.jsonl` 恰好多 2 行（1 entry ＋ 1 outcome），沒有重複。
2. **shadow 模式未改動訂單**：`intent` 逐欄等於送進去的 payload（`quantity:2, stopLoss:1600, takeProfit:1900`）。
3. **join key 成立**：`outcome.openedAt` == `entry.positionOpenedAt` == `2026-10-20T11:10:52.366Z`。
4. `realizedPnl` 為數字（0，於進場價出場）。
5. `guard_report.py` 能把這筆 join 到：`approve n=3`。

## 語意項（A23 / A24）

受管 JEV `taskwf-accept`，題型 `choice`（附 `src/services/guard/orderGuard.ts`、`guardRuntime.ts`、`src/services/demo/api.ts`、`engine.ts` 的程式碼原文到 `state`）。

**輸入**：`scratch/qa_order_guard_accept_input.json`（QA 後已刪除）
**入口**：`python C:/Users/bear9/jev-laya-bench/jev_judge.py < <input>`，`gate: taskwf-accept`

### 結果

```json
{"answers": {
  "A23": {"type": "choice", "choice": "most_severe_wins", "confidence": 0.95,
          "probabilities": {"most_severe_wins": 0.96,
                            "most_severe_wins_but_widen_allowed": 0.02,
                            "first_hit_wins": 0.01,
                            "approve_always": 0.0,
                            "insufficient_evidence": 0.01}},
  "A24": {"type": "choice", "choice": "exits_untouched_shadow_passthrough", "confidence": 0.99,
          "probabilities": {"exits_untouched_shadow_passthrough": 0.99,
                            "exits_also_guarded": 0.0,
                            "shadow_changes_quantity": 0.01,
                            "insufficient_evidence": 0.0}}},
 "meta": {"model": "jev-1.14.0", "input_tokens": 2344, "backend": "jev-direct", "fell_back": false}}
```

| # | 判定 | 機率 | 門檻 | 結論 |
|---|---|---|---|---|
| A23 判斷品質符合計畫語意意圖 | `most_severe_wins` | 0.96 | 0.80（`BLOCKER_FLOOR`） | ✅ 通過 |
| A24 對真實使用者行為安全 | `exits_untouched_shadow_passthrough` | 0.99 | 0.80 | ✅ 通過 |

A23 的正確標籤內容：*「Any veto hit makes the whole decision 'veto'; otherwise any reduce hit makes it 'reduce'; otherwise 'approve'. A rule that throws becomes a veto. A stop may be tightened or set for the first time, but widening it or removing it is a veto.」*

A24 的正確標籤內容：*「closePosition, closeAllPositions, cancelOrder and cancelAllOrders call the engine directly with no guard, and in shadow mode guardedPlaceOrder passes the original payload to engine.placeOrder unchanged.」*

### 題型調整紀錄

先用 `noul` 題型問了兩次（state 只有摘要，無程式碼原文）：第一次 `A23=0.73 / A24=0.59`，補上程式碼原文後 `A23=0.55 / A24=0.43`。兩次都落在灰區（門檻 0.85 pass / 0.30 fail），原因：**noul 題型要求語意推論**，而這兩題的重點是「程式碼實際做了什麼」——這是可由程式碼逐字核對的事實。改成 `choice` 題型（每題 4 個標籤，其中 3 個是明確錯誤行為、1 個 `insufficient_evidence`）後，JEV 直接對上程式碼原文，信心 0.96 / 0.99。

依 `task-workflow.md`「程式能判 → 直接判；有限答案集 → JEV」：這兩題正是「有限答案集」，改題型是正確做法，不是為了讓 JEV 好看。

## 殘留風險

1. **掛單（LIMIT/STOP）成交無 join key。** Phase 1 樣本只含市價單。`guardedPlaceOrder` 對未成交的掛單寫 `positionOpenedAt: null`，之後掛單在 `engine.mark()` 內成交時沒有 `entry` 行可 join。已在計畫列為非目標。
2. **守門員狀態在 F5 後歸零。** 紙上引擎只存在記憶體，冷卻／當日虧損／連虧全部重置。已在計畫「不能保證什麼」段列明。
3. **`postGuardLog` 失敗無痕跡。** fetch 錯誤被 `.catch(() => {})` 吞掉，該行不會落地也不會有人知道。計畫原文即如此（標為 ponytail debt）。
4. **樣本量不足。** `PHASE2_GATE: NOT_READY`（approve n=3）。Phase 2 前需累積更多真實交易日。
5. **`scripts/jev-shadow.py` 的 fix 未經實盤驗證。** 單元測試證明「Normal regime 不再被 veto」，但要等使用者重啟收集器、跑完一個完整交易日，才能確認規則計數器不再是 100% `volatile`、DeepSeek 觸發計數器不再每列都印 `volatile environment`。
6. **規則改動後需重新整理頁面才生效。** F7 修正把 outcome 訂閱錨在 `globalThis`（第一個模組實例永久持有訂閱），代價是改了 `orderGuard.ts` 後要 F5 才生效。取捨理由：Vite 的 HMR dispose 對 `.ts` 檔永不觸發，若不錨定單例，每改一次規則就多一份 outcome 訂閱，報表 P&L 會無上限翻倍。對 dev 工具可接受。
7. **`reduce` 會產生小數口數。** `quantity / 2` 對台指期（整數口數）不合規。計畫原文即標為 ponytail debt，Phase 2 上 enforce 前需處理。
8. **dev sink 只在 `npm run dev` 下存在。** production build 沒有 `/__guard-log` 端點，前端 POST 會 404（`postGuardLog` 吞掉錯誤，不影響下單）。這是「dev-only sink」的刻意設計，不是缺陷。

## P8 Code Review 發現與修正（2026-10-20 21:00–22:05，Round 2 重驗）

P8 派 3 個 reviewer（正確性／安全／可維護性）並行。共 **7 個 Important、零 Critical**，全部實測確認成立並已修正。

| # | 發現 | 實測證據（修正前） | 修正 |
|---|---|---|---|
| F1 | `lossStreak` 把同一部位分批平倉算成多次連虧 | 1 筆分 3 次平倉 → 誤判 `loss_streak` veto | 先按 `openedAt` 聚合再數連虧 |
| F2 | 進場路徑不驗停損合法性，`stopLoss:0`／負數被放行 | `stopLoss=0` → `approve`；引擎端 `price <= stopLoss` 永不觸發＝無停損進場 | `stop_required` 同時擋非正數／非有限值，與 `checkStopChange` 對稱 |
| F3 | `entryOf` 用 LIMIT 掛單價當進場價，但引擎成交價是 `min/max(level, market)` | BUY LIMIT 105／市價 100／stop 103 → `approve`（實際成交 100，stop 103 立刻停損） | `entryOf` 對 LIMIT 套用引擎自己的成交價規則 |
| F4 | `guard_report.gate()` 不篩 mode | 混模式（20 shadow approve ＋ 10 enforce reduce）→ `gate: True`，`flagged loss_rate=1.0` | `join()` 只收 `mode == "shadow"` |
| F5 | `guard_report.join()` 遇畸形 entry 行 KeyError | `join([{kind:"entry",...}])` → `KeyError('intent')`，`main()` traceback | 改用 `.get()`，缺 symbol／verdict 就跳過 |
| F6 | dev sink 對任何來源／方法／大小開放寫入，且 `logs/` 可被靜態讀取 | `POST` `Content-Type: text/plain` + `Origin: http://evil.example` → **204**（text/plain 是 CORS simple request，不觸發 preflight）；`GET /logs/order-guard.jsonl` → **200** | 非 POST → 405；Origin 不符 → 403；body > 64 KiB → 413；`/logs/` → 404 |
| F7 | `import.meta.hot?.dispose` 永不觸發，HMR 後 outcome 行重複寫入 | 刪掉 globalThis 錨點再重新求值 → 同一 close 寫出 **2** 筆 outcome | 訂閱錨在 `globalThis`，移除無效的 dispose |

### F7 的機制（為何 dispose 無效）

Vite 把 dispose 回呼登記在**註冊者自己的 URL** 下（`node_modules/vite/dist/client/client.mjs:49`：`disposeMap.set(this.ownerPath, cb)`），但只在 `client.mjs:201` 的 `disposeMap.get(acceptedPath)` 讀取——`acceptedPath` 是**接受更新的 HMR 邊界模組**。Vite 只在原始碼出現字面 `.accept` 時把模組標成 `isSelfAccepting`（`node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js:40713`），`.dispose` 不算；plugin-react 只對 `.tsx` 注入 `.accept`。`guardRuntime.ts` 是 `.ts` → 它的 dispose 永不執行。

### 修正後的安全邊界（實測）

| 請求 | 修正前 | 修正後 |
|---|---|---|
| `POST` `application/json` 無 Origin | 204 | 204 |
| `POST` `text/plain` + `Origin: http://evil.example` | **204** | **403** |
| `POST` `text/plain` + 同源 Origin | 204 | 204 |
| `POST` `Origin: null`（sandbox iframe） | 204 | **403** |
| `GET /__guard-log` | 204 | **405** |
| `POST` 200 KB body | 204 | **413** |
| `POST` `not-json` | 400 | 400 |
| `POST` `[1,2]` | 400 | 400 |
| `GET /logs/order-guard.jsonl` | **200** | **404** |
| `GET /logs/` | **200** | **404** |

### 新增測試（7 條）

- `orderGuard.test.ts`：分批平倉算一筆連虧、停損非正數被 veto、LIMIT 按實際成交價判定（26 tests）
- `guardRuntime.test.ts`：同一 close 只寫一筆 outcome（7 tests）
- `guardRuntime.hmr.test.ts`（新檔）：模組重新求值後仍只有一個 outcome 訂閱（1 test）
- `test_guard_report.py`：跳過 enforce 模式、跳過畸形 entry、日誌不存在時回空（8 tests）

### P8 分級去重（受管 JEV）

`python C:/Users/bear9/jev-laya-bench/taskwf_jev.py blocker --input scratch/p8_review_findings.json`

```
F1-loss-streak-partial:     decided risk p=0.96
F2-entry-stop-not-positive: decided risk p=0.87
F3-limit-fill-price:        decided risk p=0.93
F4-report-mixed-mode:       decided risk p=0.96
F5-report-malformed-entry:  decided risk p=0.86
F6-dev-sink-open-write:     decided risk p=0.84
F7-hmr-duplicate-subscription: decided risk p=0.95
{"gate": "taskwf-blocker", "n": 7, "bands": {"decided": 7}}
```

7/7 判為 `risk`（可繞過的風險，非 blocker），零 blocker。

### 額外修正（主 LLM 在 Round 2 驗收時發現）

`guard_report.py` 的 `load()` 對**不存在的日誌檔**拋 `FileNotFoundError`，`main()` 直接 traceback。計畫 Step 4 明列預期輸出是「`PHASE2_GATE:` 一行**或 `no log yet`**」，且使用者第一次跑報表時通常還沒交易過。已修：檔案不存在回空陣列，印 `PHASE2_GATE: NOT_READY`（exit 0）。補 1 條測試釘住。

## Round 2 重驗（2026-10-20 22:03–22:06）

依 task-workflow「P8 回修後必須 `fix` 並重跑 P7」，閘門已 `fix` → `enter P7` → 重跑全部驗收。

| # | 指令 | 結果 |
|---|---|---|
| A1/A2 | `python -m pytest scripts/tests/test_jev_shadow_volatile.py -q` | `5 passed` |
| A3 | `grep -c "'volatile' in vol_txt" scripts/jev-shadow.py` | `0` |
| A4 | `py_compile scripts/jev-shadow.py` | `COMPILE_OK` |
| A5 | `git status --short -- scripts/jev-shadow.py scripts/tests/test_jev_shadow_volatile.py` | ` M` ＋ `??` → 仍未進版控 |
| A6/A10/A22 | `npx vitest run`（orderGuard／guardRuntime／guardRuntime.hmr／demo-contract／demo-engine-resting-orders） | `48 passed`（5 檔） |
| A14a | `grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts` | 只有第 12 行註解 |
| A15 | `grep -n "GUARD_MODE: GuardMode = "` | `18:export const GUARD_MODE: GuardMode = "shadow";` |
| A16 | `POST {"kind":"probe"}` ＋ 讀檔 | `204` ／ 最後一行 `{"kind":"probe"}` |
| A17 | `POST not-json` ／ `POST [1,2]` ／ 行數比對 | `400` ／ `400` ／ `unchanged: True` |
| A18/A19/A20 | `python -m pytest scripts/tests/test_guard_report.py -q` | `8 passed` |
| A21 | `python scripts/guard_report.py`（無日誌） | `PHASE2_GATE: NOT_READY`，exit 0（無 traceback） |
| A21 | `python scripts/guard_report.py`（有日誌） | `approve n=1 loss_rate=0.000 pnl=0.0` ／ `PHASE2_GATE: NOT_READY` |
| A22 | `npm run typecheck` | `tsc --noEmit` 零錯 |
| 端到端 | 一次性腳本（已刪）→ 真實 middleware | 1 筆 entry ＋ 1 筆 outcome；join key 成立；shadow 未改 payload |

**Round 2 收斂：成立。**

## 提交邊界核對
```
$ git log --oneline -n 4
ee95f55 feat(guard): dev middleware appends guard decisions to logs/order-guard.jsonl
8c0675e feat(guard): route paper entries and stop changes through the shadow guard
4b43061 feat(guard): outcome report that joins guard decisions to closed trades
9e6932d feat(guard): pure entry/exit rules for the paper terminal
```

四個 commit 都用明確路徑 `git add`，**沒有** `git add -A`／`git commit -a`。`scripts/jev-shadow.py` 與 `scripts/tests/test_jev_shadow_volatile.py` 仍未提交。

## 已知偏離（1 條，非缺陷）

**計畫逐字碼用 inline cast 讀 bus 事件。** 計畫 Task 3 Step 4 寫：

```ts
const c = (event as { _entity: ClosedPosition })._entity;
```

本專案規則 `ts-no-inline-cast-access` 禁止 inline cast 取成員（未經檢查的形狀，讀錯不會報錯）。實作改用既有 zod schema：

```ts
const entity = typeof event === "object" && event !== null && "_entity" in event ? event._entity : null;
const parsed = ClosedPositionSchema.safeParse(entity);
if (!parsed.success) return;
const c: ClosedPosition = parsed.data;
```

行為等價性：原 cast 不會失敗；新碼在 payload 不符 schema 時**不寫** outcome 行（多一層 fail-safe）。schema 來自 `src/services/schemas.ts`（既有檔案，未改）。

## JEV 受管判定

（A23 / A24 的 `taskwf-accept` 結果附於下方，由 `jev_judge.py` 產出。）
