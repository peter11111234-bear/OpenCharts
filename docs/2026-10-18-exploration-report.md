# OpenCharts 架構深度探索報告（Endo workflow 整合評估）

日期：2026-10-18 · 純唯讀探索，未修改任何程式碼
方法：4 個 scout 分頭深挖 + 主 agent 實測驗證

## 0. 結論先行

**Endo 的 workflow 引擎不該移植，但你的 repo 已經有一份未實作的相同規格書。**

`docs/superpowers/plans/2026-10-16-workflow-harness-replica.md`（124 KB）已經把 `defineWorkflow / agent / parallel / phase` 與結果 JSON schema 寫死，但 `scripts/workflows/` 目錄不存在、`package.json` 無對應 script。**意圖存在、實作缺位**——這是唯一真正該做的接縫。

Endo 的 DSL 是 Effect + tRPC + SQLite 全家桶，移植等於重寫。可借的是它剝掉 Effect 後的控制流語意。

---

## 1. 系統實況：兩條不相交的鏈

### 1.1 前端鏈（瀏覽器 :5173）

完整路徑（實測行號）：

```
VelaPage.tsx:277-296  new VelaWorkspace({providers:{shioaji}, engines:{pine}})
  ├─ velaProvider.ts:132-150  getBars() → getShioajiHistory()
  │    └─ candles.ts:113-190  POST /shioaji/api/v1/data/kbars → 去重/TTL → 逐列清洗 → resample
  ├─ candles.ts:158-176  malformed row 丟棄（曾用 ?? 0 灌進 autoscale 壓扁全圖）
  └─ velaProvider.ts:168-196  subscribeChannel("market-data") → 1m 聚合
       └─ VelaPage.tsx:339  cell.chart.runIndicator(script) → PineWorkerEngine
```

WebGL2 renderer 在 `@luxalgo/vela`（外部套件，repo 內無原始碼）。src 側只到 `getBars`。

### 1.2 背景鏈（Task Scheduler + Python/PowerShell）

```
start-trading-day.ps1 (Task Scheduler 平日 08:30)
  ├─ hotscan/tradingday.py   休市閘門（唯一源頭）
  ├─ shioaji :8080            健檢 / 啟動
  ├─ dev-up.ps1               vite :5173
  ├─ hot-watchlist.py         今日 watchlist
  ├─ python -m hotscan        scanner 常駐（hotscan/ 15 模組）
  ├─ shioaji-watchdog.ps1     常駐 15s 巡檢
  ├─ jev-shadow-watchdog.ps1  sidecar :8787 + collector
  └─ 等開盤驗 tick（驗到 09:10）
```

兩鏈**無程式邊**。圖譜證實：`scripts↔src` 只有 perf 測試檔的 import 邊，`hotscan/` 也不 import `src/` 任何東西。

---

## 2. 三個關鍵事實修正

### 2.1 `/vela` 頁面的即時串流是關閉的

`src/pages/VelaPage.tsx:281`：
```ts
live: false, // 暫停：SSE tick 一直推 → main thread 洗 render
```

`subscribe()` / `startShioajiFeed()` 這條鏈**元件都在但休眠**。skill 寫的「漏掉 `startShioajiFeed()` 就沒 tick」在當前設定下不會發生——因為根本沒訂閱。

### 2.2 終端頁面根本不走 :8080

`src/services/api.ts:114`：
```ts
export const api = new Proxy(demoApi as Record<string, unknown>, {...})
```

`TradingPage` 的資料全來自 `src/services/demo/candles.ts`（bundle 內建假資料）。
且 `src/services/shioaji/api.ts:25` 的 `shioajiApi` **零 import = 死碼**（實測 grep 只命中定義處）。

真 `:8080` 的唯一消費者是 `/vela`。

### 2.3 Jev 指標三份複製，只有一份有測試

| 檔案 | key 數 | 測試覆蓋 |
|---|---|---|
| `scripts/jev-shadow.py:202` （**生產者**） | 28 | **零** |
| `scripts/gen_jev_fixture.py:52-126`（基準） | 32 | 產生 fixture |
| `src/services/jev/jevIndicators.ts:75` | 32 | 被 fixture 釘住 |

`src/__tests__/jevIndicators.test.ts:16-25` 逐 key 比數值，容差 `1e-4`。但那是 TS ↔ gen 的比對，**`jev-shadow.py` 完全不在任何斷言內**。

實測：`grep -rn "calculateJevIndicators" src/` 只命中測試檔 → TS 版**尚未接上任何 UI**。

數值語意比對（pandas ↔ TS）未發現計算分歧，ewm/rolling/WMA/RVI mask 全部一一對應。差異只有：`_last` 有 `round(x,6)` 而 TS 沒四捨五入、空輸入 TS 回全 null 而 pandas 會在 `iloc[-1]` 拋錯。

---

## 3. Endo primitive ↔ 你的接縫

| Endo primitive | 你的對應物 | 判定 |
|---|---|---|
| `defineWorkflow({args, run})` | `start-trading-day.ps1` 就是一條寫死的 workflow（trigger→steps→gate→分支→exit code） | **已有，缺型別** |
| `parallel()` 有界併發 + per-item outcome | `scripts/hotscan/` 多模組、`jev-shadow.py` 的 `--rate`/`--max-per-cycle` | **已有，手寫** |
| `agent(input, {sessionId, schema})` | `POST /decide {state, questions}`（`jev-sidecar.py:294-311`） | **有邊界，無 schema** |
| `phase()` 命名作用域 | `logs/` 各腳本自寫，無跨腳本時間軸 | **缺** |
| Resource 的 schedule + occurrence 兩表 | Task Scheduler 目前**無履歷記錄** | **缺** |
| loader（strict type-check、限制 import） | 無 | 不需要 |
| `@effect/opentelemetry` tracing | 無 Effect，無 OTel | 不需要 |
| CLI provider 抽象 | 你已有 OpenCode + wjs + agent-reach | **不需要** |

**判斷**：Endo 的價值核心是多 agent session 編排（`best-of-n`、`multi-turn-debate`），那是 OpenChart 的 agent 層在做的事。你的鏈是「多腳本編排」，不是「多 agent 編排」。所以 `agent()` 這個最關鍵的 primitive 你用不上。

---

## 4. 風險清單（依嚴重度）

### P0：無 CI、無型別契約

| 問題 | 位置 |
|---|---|
| `tsc` 歸零後**無 CI/husky**，沒人擋再紅 | `docs/2026-10-13-fix-four-pain-points-handoff.md:67`、`remaining-work.md:148` |
| Jev 三方契約**零 schema**：state/questions/回應全靠 duck-typing | `jev-sidecar.py:296-300` 只檢查 `isinstance(dict)`；`:311` 上游 body 直接透傳 |
| prompt 欄位名與 payload 佈局錯位：`QUESTIONS` 用 `change_percent`/`day_high`/`day_low`（`:98,116,120`），但 `build_state` 把它們嵌在 `price{}` 內（`:414-417`） | 同上 |

### P1：靜默失敗（不報錯但結果錯）

| 問題 | 位置 |
|---|---|
| Pine 具名引數 5 條路徑靜默吞掉／綁錯槽 | `PROGRESS.md:464-467, 494-499, 521-523` |
| drawing builtin named-blind，**44 個**靜默 no-op | `remaining-work.md:83-87, 214` |
| `src/pine/mtf.ts` `evalAt` 快取鍵（Scope vs callsite）值釘死 | `PROGRESS.md:598-600` |
| `strategy.equityAt` 逐 bar 重放 → 500 根 108,204 ms | `PROGRESS.md:763` |
| 免費額度上限可靜默失效：`_spend_save` 吞例外、`_spend_load` 例外時回 `count=0` | `jev-sidecar.py:119-139` |
| 上游未回 `model` 時跳過模型檢查 | `jev-sidecar.py:234-236` |

### P2：維護陷阱（已漂移或會漂移）

| 問題 | 位置 |
|---|---|
| PS1 五個 helper 逐字複製兩份且**已漂移**：`Send-Alert` body、server 啟動可執行檔、`Test-TickFresh` 實作三處不同 | `start-trading-day.ps1:18-58` vs `shioaji-watchdog.ps1:20-126` |
| 近月期貨代碼 `TXFJ6`/`MXFJ6` 兩處手抄（**目前一致**，無機制保證） | `shioaji-watchdog.ps1:131-132` vs `instruments.ts:71-76` |
| 程序識別**全靠 CommandLine 正則**，無 PID 檔 | 11 處 `Get-CimInstance`，見 BgChain §2 |
| `shioaji-watchdog.ps1:212` 自清掃描**沒有名篩**，任何提及該檔名的行程會被 `Stop-Process -Force` | 同上 |
| 死檔 `scripts/hot-scanner.py`（405 行舊實作）會讓程序識別誤判「scanner 活著」 | `start-trading-day.ps1:49` 的 regex 命中它 |
| 死檔 `scripts/jev-shadow-helpers.py`：**檔名帶連字號無法 import**，且邏輯已過時 | 無 importer，且缺 2 個升級分支 |
| `jev-shadow.py` 重複定義 `_day_session`（`:46` 與 `:509`） | 後者覆蓋前者 |
| README 與實際結構**嚴重不符**：說「no server to run」（實際 3 個）、說 `scripts/` 只有 1 檔（實際 20+）、說測試薄（實際 1025 tests） | `README.md:45, 300-302, 480-482` |

---

## 5. 唯一值得做的整合

`docs/superpowers/plans/2026-10-16-workflow-harness-replica.md` 已經寫好規格：

- primitive：`defineWorkflow / agent / parallel / phase / textPrompt`
- 子代理結果**只能**來自 run 目錄內**經 zod 驗證的 JSON 檔**
- `NEVER 寫入 src/**`
- 產物落 `scripts/workflows/.runs/<ts>-<slug>/`

實作狀態 = 0：`scripts/workflows/` 不存在、`vitest.workflows.config.ts` 不存在、`tsconfig.scripts.json` 不存在（實測）。

這個規格有兩個好處值得注意：
1. **禁止解析人類格式輸出**——正是 repo 現在 `pineMonaco.ts:263` 用 regex 解析錯誤字串的反例
2. **禁止寫 src/**——意味著它只能是觀測+報告+patch 工具，不能改應用碼

repo 內已有兩個可沿用的樣板：
- `scripts/autorun/README.md:10-22` — snapshot/md5/budget/state-file/產物驗收，形狀最接近 executor
- `scripts/perf/README.md` §1/§6/§7 — import 順序鐵律、計數器、`--compare` 回歸判定

---

## 6. 與 Endo 的最終對照

```
Endo (longsurf-ai/endo, MIT)          你的 OpenCharts
─────────────────────────────         ─────────────────────
server/lib/resource/  Resource 框架    scripts/hotscan/config.py（單一源頭，已成立）
server/agent/workflow  TS workflow     docs/…/workflow-harness-replica.md（規格有，碼無）
  defineWorkflow/agent/parallel         hotscan 15 模組（手寫，無介面）
  parallel() 有界併發+per-item          jev-shadow --rate/--max-per-cycle（手寫）
  agent({schema}) 結構化輸出            POST /decide（零 schema）
  agent_schedule Resource               Task Scheduler（零履歷）
  phase() + OTel tracing                無
common/models/  CLI provider           已有 OpenCode + wjs（不需要）
```

**Endo 唯一純賺的是 Resource 框架的「一處定義驅動 API + agent tools + live invalidation」概念**，但你的資料在 SQLite（Shioaji 端）與 JSONL（`hot-ticks.jsonl` 1.1GB、`hot-scanner.jsonl` 68MB），schema 模型完全不同。

---

## 7. 未驗證 / 已知限制

- 四個 scout 環境**無 shell**，無法執行 `git show HEAD:`，行號取自 worktree。dirty 檔（`scripts/jev-shadow.py`、`scripts/jev-sidecar.py`、`scripts/shioaji-watchdog.ps1`、`src/pages/VelaPage.tsx`、`src/services/shioaji/*.ts`）行號可能與 HEAD 位移
- 本報告第 2 節五項事實由主 agent 實測（`VelaPage.tsx:281`、`api.ts:114`、`shioaji/api.ts:25`、`scripts/workflows/` 不存在、`jev-shadow-helpers` 無 importer）
- `graphify-out/GRAPH_REPORT.md` 標頭 commit `3c6f7b64`，`PROGRESS.md` 提到的交付 commit 是 `45eb8b4` → **圖譜可能已落後**
- 未讀 `C:\MyTradingProjects\.env`（僅確認存在）
- 未啟動任何服務（5173/8080/8787）

---

## 附：本次探索的副產物

`.archify/architecture-opencharts-system-20261018-204834/` 內有兩份失敗的 archify candidate JSON（我手排座標導致 `watchdog→server` 橫穿不相干節點，validate 閘擋下，未產生 HTML）。保留作為版面失敗記錄，可直接刪。
