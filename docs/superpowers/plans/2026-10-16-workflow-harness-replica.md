# Workflow Harness Replica Implementation Plan

> **日期：** 2026-10-16
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `OpenCharts/scripts/workflows/` 建立一個約 500 行的自有 workflow harness：可版控的 TypeScript 編排檔（`defineWorkflow` / `agent` / `parallel` / `phase`），以本機 `paseo` CLI 當唯一執行層，零新增 runtime 依賴，可被 `npm run workflow` 重跑並產出可稽核報告。

**Architecture:** 四個薄層：(1) `lib/paseo-cli.ts` 是唯一與 Paseo 對話的地方（spawn + JSON 解析），(2) `lib/executor-paseo.ts` 把「child agent = 背景 run + 等待 + 讀結果檔」封裝成 `Executor`，(3) `lib/task.ts` + `lib/sdk.ts` 是 lazy thenable 的編排 primitive（`Task` 不 await 就不執行，`parallel` 才有真正的惰性），(4) `lib/runner.ts` + `run.ts` 負責 args 驗證、run 目錄、trace、報告與 exit code。Agent 結果**一律**以 schema 驗證過的 JSON 檔回傳（在 agent 自己的 task file 裡寫明絕對路徑），不解析任何人類格式的 CLI 輸出。

**Tech Stack:** Node 24（原生 type stripping，直接跑 `.ts`）、TypeScript（`noEmit` + `allowImportingTsExtensions`）、zod 3（repo 已安裝）、vitest 2（repo 已安裝）、`node:child_process`、Paseo CLI 0.11.4。

**Spec:** 本檔 §0（範圍與驗收判準）。執行完 Task 6 後，`scripts/workflows/README.md` 成為對外契約。

**Spec invariant:** **每個 child agent 的結果只能來自一個在 run 目錄內、經 zod 驗證的 JSON 檔；harness 不得寫入 `src/**`、不得解析人類格式的 CLI 文字、不得在沒有成本與權限紀錄的情況下啟動 agent。**

## Executor Rules

Stop ONLY on hard blockers: 缺少依賴（`npm i` 失敗）、Paseo CLI 拒絕執行、同一 `Done when` 驗證在 2 次不同修法後仍失敗。單一紅測試屬正常 TDD 迴圈，不是 blocker。

Never stop to ask what you can look up — 檔案路徑、簽名、測試名稱一律先搜尋。不影響下一步行動的疑問：記下來，繼續做，task 結束時回報。

**Plan-specific Nevers:**
- NEVER 把 `paseo logs` 的輸出當結果來源（實測 `--json` 仍回人類文字；見 Fact Annex F13）。
- NEVER 讓 `parallel()` 吞掉 `BudgetExceeded`（它必須往上拋，否則預算失效）。
- NEVER 讓 harness 或 child agent 寫入 `src/**`；只有 `scripts/workflows/**` 的產物與 run 目錄可寫（Task 6 的 `report.md` 例外說明見該 task）。
- NEVER 引入 `effect`、`drizzle`、`zod-to-json-schema` 或任何新 runtime 依賴（只允許 `@types/node` 這個 devDependency）。
- NEVER 在測試裡真的呼叫 agent；只有 `WORKFLOW_LIVE=1` 的 live 測試與 Task 1/Task 5 的明確步驟可以。

## Global Constraints

- 執行入口：`node scripts/workflows/run.ts <workflow-file>`；Node 版本下限為本機已驗證的 v24.11.1（`node main.ts` 可直接執行含型別的 TS，實測通過）。
- `scripts/workflows/**` 內禁用需要 transform 的 TS 語法：`enum`、`namespace`、parameter properties、decorator（Node type stripping 不支援）。
- 新檔一律 `.ts` + ESM；相對匯入要寫副檔名（`./task.ts`），因為根 tsconfig 已開 `allowImportingTsExtensions`。
- 不得改動 `src/**`、`vite.config.ts`、`vitest.config.ts`、`tsconfig.json` 既有內容。允許改的既有檔只有：`package.json`（新增 3 行 scripts + 1 行 devDependency）、`.gitignore`（新增 1 行）。
- 新增檔案路徑白名單（除此之外不得新增）：`scripts/workflows/**`、`vitest.workflows.config.ts`、`tsconfig.scripts.json`。
- 預設 child 模型：`--provider opencode --model opencode/deepseek-v4.1-flash-free`（實測 CostUsd 0）。Verifier 角色預設 `--provider claude --model claude/claude-opus-5-5`（實測可用）。
- 預設 `concurrency = 4`；`timeoutMs = 900000`（15 分鐘）；`budgetUsd = null`（無上限）。
- 每次 run 的產物必須落在 `scripts/workflows/.runs/<YYYYMMDD-HHmmss>-<workflow-slug>/`（已加進 `.gitignore`）。
- 所有新增檔案需通過：`npm run typecheck`（既有 src 不得新增任何錯誤）、`npm run test`（既有 1,221 個測試檔維持全綠）、`npm run test:workflows`、`npm run lint`。
- Git：在 `feat/workflow-harness` 分支工作（`git checkout -b feat/workflow-harness`），每個 task 一個 commit。

## 執行環境（Environment）

### 需求（全部已具備，實測 2026-10-16）

| 項目 | 需求 | 本機現況 | 取得方式 |
|---|---|---|---|
| OS | Windows 10/11 x64 | win32，家目錄 `C:\Users\bear9` | — |
| Node | **≥ 22.18**（要能直接執行 `.ts`，不需 `tsx`） | v24.11.1 ✅（2026-10-16 午後複驗） | `node -v` |
| npm | 任一（repo 用 `package-lock.json`） | 11.6.2 ✅（午後複驗） | `npm -v` |
| Paseo CLI | ≥ 0.11.4 並已登入 providers | 0.11.4 ✅（午後複驗，`C:\Users\bear9\AppData\Roaming\npm\paseo.ps1`） | `npm i -g @getpaseo/cli` |
| Paseo daemon | 執行中（所有 live 命令的前提） | running ✅（2026-10-16 午後複驗：`paseo status` → `localDaemon: running`，`listen: 127.0.0.1:6767`） | `paseo start` 或 `paseo onboard` |
| Provider 憑證 | 至少一個可用 provider | `opencode`（free）、`claude`、`omp` 皆已通 ✅ | 由 Paseo 自身的登入管理 |
| 磁碟 | 每次 run 產物 < 1 MB | `scripts/workflows/.runs/`（gitignored） | — |

**不需要**：bun、just、Docker、WSL、獨立 API key、任何 Python 環境。free provider 走 Paseo 既有登入，成本 0。

### 依賴成本表（選模型時看這張）

| provider / model | 用途 | 實測成本 | 備註 |
|---|---|---|---|
| `opencode` + `opencode/deepseek-v4.1-flash-free` | 預設 worker（fan-out 大量並行） | `CostUsd: 0` | 預設值；適合 8–16 並行 |
| `claude` + `claude-opus-5-5` | verifier / synthesis（要判斷力） | 有成本 | 只在 2–3 個 call 上用 |
| `omp` + `deepseek/deepseek-flash` | 備援 provider | 低 | 首次啟動 60–90 秒（Paseo ready timeout 需已調大） |

### 環境變數

| 變數 | 用途 | 預設 |
|---|---|---|
| `PASEO_CLI_ENTRY` | 直接指定 Paseo 的 JS 進入點，繞過 shim 解析 | 未設（自動解析 `npm root -g`） |
| `CAPTURE_AGENT_ID` | 重跑 Task 1 擷取工具時，重用既有 agent 而不新建 | 未設 |
| `WORKFLOW_LIVE` | 設為 `1` 才啟用 live smoke 測試 | 未設（live 測試 skip） |
| `PASEO_BIN` | 保留給非 Windows 的 `paseo` 執行檔路徑覆寫 | 未設 |

### 開工前 6 條自檢（每條都要有預期輸出）

```powershell
node -v                       # v24.11.1 或更高（>= 22.18）
paseo --version               # 0.11.4 或更高
paseo status                  # 顯示 daemon endpoint，不是 "no daemon"
npm run test 2>&1 | Select-Object -Last 3     # 既有測試 0 failed
npm run typecheck             # exit 0
npx paseo ls --json | Select-Object -First 5  # 回一個 JSON 陣列
```

### 已知限制（寫進 README，避免誤解）

1. **啟動延遲**：一個 Paseo agent 從 `run` 到 `idle` 約 10–60 秒（omp 首次 60–90 秒）。harness 是**開發期**工具，不是低延遲 runtime。
2. **Paseo daemon 沒跑時**：所有 live 命令失敗；`--dry-run` 與 `test:workflows` 仍可離線執行。
3. **權限**：child agent 在非 `--auto-permit` 下遇到權限請求會中止該 run（exit code 5），這是刻意設計（D3）。
4. **成本**：free provider 為 0，但 verifier/synthesis 用 Opus 會計費；`--budget-usd` 是硬門檻（超過即拋錯並停）。
5. **平台**：只在 Windows 實測；macOS/Linux 理論可用（`resolvePaseoCli` 有 fallback），但不在本案驗收範圍。

## §0 範圍與驗收判準

**要做的（in scope）**

1. 一個可重跑的 CLI：`npm run workflow -- scripts/workflows/workflows/<name>.workflow.ts --args '<json>'`。
2. 五個 primitive，語意對齊 endo（見 Fact Annex F20）：`defineWorkflow`、`agent(input, {label, sessionId, schema, provider, model, mode, timeoutMs})`、`parallel(tasks)`（保序、隔離預期失敗）、`phase(name, task)`（命名階段）、`textPrompt(text, label)`。
3. 兩個真正有用的 workflow：Pine 語意覆蓋盤點、Pine 測試缺口獵取（皆只產出報告/patch 檔，不寫 `src/`）。
4. `--dry-run`（列出將要跑的 agent 與路徑，零呼叫）、`--concurrency`、`--budget-usd`、`--auto-permit`、`--json`。
5. 每個 run 產出 `run.json`、`trace.jsonl`、`<callId>.task.md`、`<callId>.result.json`、`<callId>.meta.json`、`report.json`、`report.md`。
6. 測試：純單元測試（fake executor）+ 一個 `WORKFLOW_LIVE=1` 才跑的 live smoke。

**不做的（out of scope，明列以免膨脹）**

- Vela ↔ PineTS 跨 repo 對等性 workflow（需要 headless Pine runner，目前 repo 沒有；列為未來 Revisit）。
- Resource 層、資料庫、排程、UI、MCP server 形式。
- 任何 `effect` / Effect-like generator runtime；本案用 lazy thenable，不用 generator。
- 自動套用 child 產出的測試到 `src/**`（一律只產 patch/報告）。

**驗收判準（可檢查）**

| # | 判準 | 檢查方式 |
|---|---|---|
| A1 | 不新增任何 runtime 依賴 | `git diff package.json` 只有 scripts 與 `@types/node` |
| A2 | 既有測試全綠 | `npm run test` 0 failed |
| A3 | 既有型別檢查零新增錯誤 | `npm run typecheck` exit 0 |
| A4 | harness 可乾跑 | `npm run workflow -- <wf> --args '{}' --dry-run` 不產生任何 Paseo agent，且 `report.json` 內 `calls[].sessionId` 皆以 `dry-run:` 開頭 |
| A5 | 預算可擋 | 單元測試：`budgetUsd` 超限時 `BudgetExceeded` 從 `parallel()` 往外拋 |
| A6 | 保序 | 單元測試：平行 4 項、其中第 1 項最慢，回傳順序仍等於輸入順序 |
| A7 | 結果只來自檔案 | `grep -rn "logs" scripts/workflows/lib` 於結果路徑上 0 命中（只有 `lib/paseo-cli.ts` 的 help 註解可提及） |
| A8 | live 可跑 | 指定 `WORKFLOW_LIVE=1` 時 smoke 用 free 模型跑 2 個 agent、報告 `ok: true`、`totalCostUsd` 為 0 |

## Decision Points

### D1: harness 放哪個位置 (T1) — 使用者已於 2026-10-16 確認
- Consumed by: 全部 task
- Candidates:
  - A (existing pattern): `OpenCharts/scripts/` 下新增子目錄。此 repo 已有 `scripts/`（`dev-up.ps1`、`fetch-demo-data.mjs`、`hot-scanner.py`、`jev-sidecar.py`）承載非 app 的開發工具
  - B (minimal): 獨立 repo `MYOPENCHART/workflow-harness`，用 `--cwd` 指向 OpenCharts
  - C (preferred，未選): 進 `src/tools/` 與 app 同層
- Criteria:
  - Can run `npx vitest` and `tsc --noEmit` against the same repo root
  - Does not ship in the vite bundle (`src/**` untouched)
  - Keeps upstream-merge conflicts to at most 3 lines
  - Survives deleting only its own directory
- Chosen: A（使用者 2026-10-16 明確選擇「OpenCharts/scripts/workflows」）
- Rejected: B 需要自行接 vitest/tsc，跨 repo 型別與相對路徑成本高；C 會進 bundle 且污染 app 邊界
- Revisit trigger: 若 harness 需要服務第二個 repo（例如同時驅動 `vela-src` 的測試），改為 B
- Outcome: (execution)

### D2: child agent 的結果怎麼回到 harness (T1)
- Consumed by: Task 2, Task 3, Task 4
- Candidates:
  - A (existing pattern): 解析 CLI 文字輸出。Paseo `inspect --json` 只給狀態與 `LastUsage`，**不含最終訊息**；`logs --json` 實測仍回人類文字（F12、F13）
  - B (minimal): 要求 child 把結果寫成一個 run 目錄內的 JSON 檔，harness 讀檔並用 zod 驗證（task file 內寫明絕對路徑）
  - C (preferred，未選): 用 `paseo run --output-schema <inline>` 讓 Paseo 回結構化結果——需新增 `zod-to-json-schema` 依賴，且實測回傳通道未驗證
- Criteria:
  - Deterministic: result equals a file the harness can re-read after the run
  - No new dependency
  - Works identically for a fresh child and for `sessionId` continuation
  - Failure mode is explicit (missing file → named error), never silently empty
- Chosen: B
- Rejected: A 依賴人類格式，A7 判準直接失敗；C 需要新依賴且回傳通道未證實
- Revisit trigger: 若 child 常寫不出檔案（例如模型拒絕寫檔 ≥2 次），改為 C 並加 `zod-to-json-schema`
- Outcome: (execution)

### D3: child agent 的權限政策 (T2 — Status: confirmed 2026-10-16 by user)
- Consumed by: Task 4, Task 5
- Candidates:
  - A (existing pattern): `paseo run --mode bypass`（先前 smoke 用過 `--mode bypass` 讓 agent 自動取用工具）
  - B (preferred): 預設 `--mode default` + harness 輪詢 `inspect`，遇到 `PendingPermissions` 就依 `--auto-permit` 決定：開 → `paseo permit allow <id>` 並記錄；關 → `paseo stop` 並以 exit code 5 結束
  - C (minimal): 一律不自動允許，遇到權限請求就停
- Criteria:
  - 無人值守的 workflow 能跑完（不得永久卡住）
  - 每個被允許的權限都留痕在 `trace.jsonl` 與 report
  - 預設值必須是「不自動同意」以外可解釋的選擇，且可由 CLI 覆寫
  - 不依賴 provider-specific 的 mode 名稱
- Chosen: B（預設 `--auto-permit` 由 CLI 明確開啟才生效；CLI 未帶時行為等於 C）
- Rejected: A 依賴 provider mode 名稱且無逐項留痕；C 讓無人值守的 workflow 變成手動
- Revisit trigger: 若出現「被允許的權限造成非預期寫入」的案例，改為 A + 白名單
- **Status: confirmed 2026-10-16 by user**（選 B：預設停，`--auto-permit` 明確開啟才放行）

### D4: 測試接線方式 (T1)
- Consumed by: Task 1, Task 2, Task 3, Task 4
- Candidates:
  - A (existing pattern): 擴充既有 `vitest.config.ts` 的 `include` 加入 `scripts/**/*.test.ts`（現值 `["src/**/*.test.{ts,tsx}"]`）
  - B (preferred): 新增獨立 `vitest.workflows.config.ts` + `npm run test:workflows`，並在 `tsconfig.scripts.json` 單獨 typecheck
  - C (minimal): 不寫測試，只用 dry-run 人工驗證
- Criteria:
  - 不動既有 1,221 個測試檔的執行環境（jsdom + `src/__tests__/setup.ts`）
  - 新測試環境為 node（不是 jsdom）
  - 既有 `npm run test` / `npm run typecheck` 輸出與改動前一致
- Chosen: B
- Rejected: A 會把 jsdom setup 與 harness 測試綁在一起，且改動共用設定；C 違反 A5/A6 的可驗證性
- Revisit trigger: 若未來 workflows 測試需要瀏覽器環境，改為在 root config 用 `projects` 分組
- Outcome: (execution)

### D5: `--dry-run` 的語意 (T1)
- Consumed by: Task 4, Task 5, Task 6
- Candidates:
  - A (existing pattern): 無既有 dry-run 慣例可循（`scripts/` 內 0 個 `--dry-run` 實作；`grep -rn "dry-run" scripts/` 只命中 `.py` 的註解）
  - B (minimal): dry-run 只印 workflow 描述與 args，不解析控制流（無法預估 agent 數量）
  - C (preferred): dry-run 使用 `DryRunExecutor` 讓程式真的走完整控制流，`agent()` 直接回 `{sessionId: "dry-run:<callId>", output: {}}` 且跳過 schema 驗證，於是能印出「將要跑的 agent 清單 + 每個的 task/result 路徑 + 預估呼叫數」
- Criteria:
  - Produces the exact list of calls a live run would make
  - Makes zero Paseo invocations
  - Never fails on schema validation
  - Report file is produced, so the CLI contract is identical in both modes
- Chosen: C
- Rejected: B 無法回答「這次要花幾個 agent」；A 不存在
- Revisit trigger: 若 dry-run 的 `output: {}` 讓 workflow 的後續拼接邏輯爆錯，改為讓 `DryRunExecutor` 回傳每個 schema 的範例值（`{}` 佔位）
- Outcome: (execution)

## Fact Annex（2026-10-16 實測，executor 可直接採用）

| ID | 事實 | 來源 |
|---|---|---|
| F1 | Paseo CLI 版本 0.11.4；`paseo` 進入點 `C:\Users\bear9\AppData\Roaming\npm\paseo.ps1`，實際執行 `node --disable-warning=DEP0040 <npm-root>/node_modules/@getpaseo/cli/bin/paseo`；`npm root -g` = `C:\Users\bear9\AppData\Roaming\npm\node_modules` | `paseo --version`、讀 shim |
| F2 | `paseo run [options] <prompt>` 支援：`-d/--background`、`--title`、`--provider <p 或 p/m>`、`--model`、`--thinking`、`--mode`、`--workspace`、`--cwd`、`--env`、`--label k=v`、`--wait-timeout <duration>`、`--output-schema`、`--json` | `paseo run --help` |
| F3 | `paseo wait <id> --timeout <seconds> --json`；`paseo inspect <id> --json` | `paseo wait --help`、`paseo inspect --help` |
| F4 | `paseo inspect --json` 欄位為 PascalCase：`Id`、`Name`、`Provider`、`Model`、`Status`（實測值 `idle`、`closed`）、`Mode`、`Cwd`、`LastUsage{InputTokens,OutputTokens,CachedTokens,CostUsd}`、`Capabilities{...McpServers}`、`AvailableModes`、`PendingPermissions`（無請求時為 `[]`）、`ParentAgentId` | `paseo inspect ac026ed --json` |
| F5 | `paseo ls --json` 回陣列，欄位為 camelCase：`id`、`shortId`、`name`、`provider`、`thinking`、`status`、`cwd`、`created`（**與 F4 大小寫不一致 → 解析器必須兩種都吃**） | `paseo ls --json` |
| F6 | `paseo send <id> [prompt] --prompt-file <path> --no-wait --json`（同一個 agent id 即為續接同一 session） | `paseo send --help` |
| F7 | `paseo permit ls` / `paseo permit allow <agent> [req_id]` / `paseo permit deny <agent> [req_id]` | `paseo permit --help` |
| F8 | `paseo stop <id>`（中斷）、`paseo delete <id>`、`paseo agent mode <id> [mode]` | `paseo --help`、`paseo agent --help` |
| F9 | 已實測可用的 provider/model：`opencode` + `opencode/deepseek-v4.1-flash-free`（`CostUsd: 0`）、`claude` + `claude-opus-5-5`、`omp` + `deepseek/deepseek-flash`；opencode 的 model 必須寫成 `provider/model` 全名 | 先前的 smoke 與 `paseo ls --json` |
| F10 | Node v24.11.1 可直接執行含型別的 `.ts` / `.mts`（實測輸出 `TS-OK 3`），無需 `tsx` | 本機 probe |
| F11 | `OpenCharts/package.json` 有 `"type": "module"`，scripts 為 `dev/build/preview/typecheck/lint/test/test:watch`；dependencies 含 `zod ^3.25.76`；devDependencies 含 `vitest ^2.1.9`、`@playwright/test ^1.58.2`；**沒有 `@types/node`** | 讀 `package.json` |
| F12 | `vitest.config.ts` 的 `include` 為 `["src/**/*.test.{ts,tsx}"]`、`environment: jsdom`、`setupFiles: ["./src/__tests__/setup.ts"]` | 讀檔 |
| F13 | `paseo logs <id> --json --tail 6` 實測**回人類文字**（`[User] ...`、`[Thought] ...`），不可作為結果來源 | 本機實測 |
| F14 | `tsconfig.json`：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`noEmit`、`allowImportingTsExtensions`、`include: ["src", "vite-env.d.ts"]` | 讀檔 |
| F15 | repo 內測試檔共 1,221 個；`docs/` 已存在且以日期為前綴命名；`.gitignore` 已有 `logs/`、`.scratch/` | 本機統計與讀檔 |
| F16 | `scripts/` 既有工具為 `.mjs` / `.py` / `.ps1`（例：`fetch-demo-data.mjs`、`hot-scanner.py`、`dev-up.ps1`），無既存 dry-run 或 workflow 慣例 | 目錄列舉 |
| F17 | `src/pine/` 現有模組（節錄）：`engine.ts`、`interpreter.ts`、`lexer.ts`、`parser.ts`、`jit.ts`、`mtf.ts`、`pinetsShim.ts`、`pinetsStateless.ts`、`pinetsStatefulA.ts`、`pinetsStatefulB.ts`、`pinetsComposite.ts`、`pineMarshal.ts`、`contracts.ts`、`errors.ts` | 目錄列舉 |
| F18 | `paseo` 0.11.4 的 `run` 預設會等 agent 完成才返回；`--background` 才會立刻回 id（用於 `parallel`） | `paseo run --help`（`--wait-timeout` 存在即意味預設等待） |
| F19 | 先前 smoke 曾遇 `create_agent` 權限請求，需 `paseo permit allow <id>` 才放行 | 先前 session 紀錄 |
| F20 | endo 的 authoring 語意（僅借語意、不抄碼）：`defineWorkflow({description, args, run})`；`agent(input, {label, sessionId, schema})` → `{sessionId, output}`，schema 解碼失敗帶 sessionId 且不重試；`parallel(effects)` → 依輸入順序的 `Outcome[]`，隔離預期失敗、concurrency 由 host settings 供給；`phase(name, effect)` → 命名 scope 並原樣回傳；`textPrompt(text, model, agent)` | 讀 `endo/server/agent/workflow/authoring/*` |

## Review Ledger

（執行時追加：`Task <N>: minor (deferred): <one-liner>`、ruling、fix-round 記錄。）

---

### Task 1: 測試接線 + Paseo 實測形狀擷取

**Blocked by:** None — can start immediately

**Files:**
- Create: `vitest.workflows.config.ts`
- Create: `tsconfig.scripts.json`
- Create: `scripts/workflows/tools/capture-paseo-shapes.ts`
- Create: `scripts/workflows/__tests__/fixtures/`（由工具產生 `paseo-run.json`、`paseo-inspect.json`、`paseo-ls.json`、`paseo-send.json`、`paseo-permit.json`、`shapes.md`）
- Modify: `package.json`（新增 `@types/node` devDependency 與 3 個 scripts）
- Modify: `.gitignore`（新增 `scripts/workflows/.runs/`）

**Interfaces:**
- Consumes: nothing
- Produces: `npm run workflow`、`npm run test:workflows`、`npm run typecheck:scripts` 三個入口；`scripts/workflows/__tests__/fixtures/*.json` 的真實 CLI 形狀（Task 2 的測試讀它）

**Assumptions:** T0 — spooldir 名稱固定為 `scripts/workflows/.runs/`；`@types/node` 用 repo 的 npm 安裝（不引入 pnpm/yarn）。

**Done when:**
- `npm i -D @types/node` 後 `npm run typecheck` → exit 0，且錯誤數與改動前相同（改動前先記錄 `npm run typecheck 2>&1 | Select-Object -Last 5`）
- `npm run test` → 既有測試 0 failed
- `node scripts/workflows/tools/capture-paseo-shapes.ts` → exit 0，`scripts/workflows/__tests__/fixtures/paseo-run.json` 存在且內含一個 uuid 形狀的 agent id
- `scripts/workflows/__tests__/fixtures/shapes.md` 內含 F4/F5/F13 對應的實際輸出片段（用於人工核對）
- `git diff package.json` 僅有 `scripts` 3 行與 devDependencies 1 行
- `.gitignore` 末行含 `scripts/workflows/.runs/`

- [ ] **Step 1: 建立分支並記錄基線**

```bash
cd C:/Users/bear9/OpenCharts
git checkout -b feat/workflow-harness
npm run typecheck 2>&1 | Select-Object -Last 5
npm run test 2>&1 | Select-Object -Last 8
```

Expected: typecheck exit 0；test 0 failed（把這兩個輸出貼進 PR 描述當基線）

- [ ] **Step 2: 安裝 `@types/node` 並確認零回歸**

```bash
npm i -D @types/node
npm run typecheck
```

Expected: exit 0，錯誤數與 Step 1 相同

- [ ] **Step 3: 新增 `vitest.workflows.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["scripts/workflows/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
```

- [ ] **Step 4: 新增 `tsconfig.scripts.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "lib": ["ES2024"],
    "jsx": "preserve",
    "noEmit": true
  },
  "include": ["scripts/workflows"]
}
```

- [ ] **Step 5: `package.json` 新增 3 個 scripts（放在既有 `"test:watch"` 之後）**

```json
    "test:watch": "vitest",
    "test:workflows": "vitest run --config vitest.workflows.config.ts",
    "typecheck:scripts": "tsc -p tsconfig.scripts.json",
    "workflow": "node scripts/workflows/run.ts"
```

- [ ] **Step 6: `.gitignore` 末尾新增一行**

```
scripts/workflows/.runs/
```

- [ ] **Step 7: 寫擷取工具 `scripts/workflows/tools/capture-paseo-shapes.ts`**

```ts
/**
 * Captures the real Paseo CLI JSON shapes into __tests__/fixtures.
 * Runs exactly one trivial agent on the free model to capture `run`, then
 * reads `inspect`, `ls` and `permit` without creating more agents.
 * Usage: node scripts/workflows/tools/capture-paseo-shapes.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "..", "__tests__", "fixtures");

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function runCli(args: readonly string[]): CliResult {
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
  const entry = path.join(npmRoot, "@getpaseo", "cli", "bin", "paseo");
  const result = spawn.sync(process.execPath, ["--disable-warning=DEP0040", entry, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
}

function write(name: string, payload: CliResult): void {
  writeFileSync(
    path.join(fixtures, name),
    JSON.stringify({ args: payload.args, code: payload.code, stdout: payload.stdout, stderr: payload.stderr }, null, 2),
    "utf8",
  );
}

mkdirSync(fixtures, { recursive: true });

const agentId = process.env.CAPTURE_AGENT_ID;
let id = agentId ?? "";

if (!id) {
  const created = runCli([
    "run",
    "Reply with the single word: captured",
    "--provider", "opencode",
    "--model", "opencode/deepseek-v4.1-flash-free",
    "--background",
    "--json",
  ]);
  write("paseo-run.json", created);
  if (created.code !== 0) {
    console.error("paseo run failed:\n" + created.stderr);
    process.exit(1);
  }
  const parsed = JSON.parse(created.stdout.slice(created.stdout.search(/[[{]/))) as Record<string, unknown>;
  const candidate = parsed.Id ?? parsed.id;
  if (typeof candidate !== "string") {
    console.error("no id field in run payload: " + created.stdout);
    process.exit(1);
  }
  id = candidate;
}

const waited = runCli(["wait", id, "--timeout", "180", "--json"]);
const inspected = runCli(["inspect", id, "--json"]);
const listed = runCli(["ls", "--json"]);
const permits = runCli(["permit", "ls", "--json"]);
const sent = runCli(["send", id, "--prompt-file", path.join(fixtures, "send-probe.txt"), "--no-wait", "--json"]);

writeFileSync(path.join(fixtures, "send-probe.txt"), "Reply with: sent\n", "utf8");

for (const [name, payload] of [
  ["paseo-wait.json", waited],
  ["paseo-inspect.json", inspected],
  ["paseo-ls.json", listed],
  ["paseo-permit.json", permits],
  ["paseo-send.json", sent],
] as const) {
  write(name, payload);
}

const shapes = [
  `# Paseo CLI shapes captured ${new Date().toISOString()}`,
  `agent id: ${id}`,
  "",
  "## run (JSON)",
  "```json",
  runCli(["--version"]).stdout.trim(),
  "```",
  "",
  "## inspect (JSON)",
  "```json",
  inspected.stdout.trim(),
  "```",
  "",
  "## ls (JSON, first entry)",
  "```json",
  listed.stdout.trim().split("\n").slice(0, 14).join("\n"),
  "```",
  "",
  "## permit ls (JSON)",
  "```json",
  permits.stdout.trim().slice(0, 600),
  "```",
  "",
  "## NOTE",
  "- inspect uses PascalCase (`Id`, `Status`, `LastUsage`); ls uses camelCase (`id`, `status`).",
  "- `logs --json` returns human text; never use it as a result channel.",
].join("\n");

writeFileSync(path.join(fixtures, "shapes.md"), shapes, "utf8");
console.log("captured agent", id, "into", fixtures);
```

- [ ] **Step 8: 乾跑擷取工具前的自檢，再執行**

```bash
node scripts/workflows/tools/capture-paseo-shapes.ts
```

Expected: `captured agent <uuid> into ...\fixtures`；`fixtures/paseo-inspect.json` 內有 `"Status"`；此步會建立 **1 個** free 模型 agent（成本 0）。

- [ ] **Step 9: 人工核對並把差異寫回 Fact Annex**

開啟 `scripts/workflows/__tests__/fixtures/shapes.md`，確認 F4/F5 的欄位名與大小寫。若與 Fact Annex 不符，**就地更新本 plan 的 Fact Annex 表格**（這是 plan 允許的更正），不要改測試去遷就。

- [ ] **Step 10: 驗證既有測試與型別仍全綠**

```bash
npm run test 2>&1 | Select-Object -Last 8
npm run typecheck
npm run test:workflows
```

Expected: test 0 failed；typecheck exit 0；`test:workflows` 目前 0 個測試檔 → exit code 1 且訊息為 `No test files found`（此為預期，Task 2 會補上）

- [ ] **Step 11: Commit**

```bash
git add vitest.workflows.config.ts tsconfig.scripts.json package.json package-lock.json .gitignore scripts/workflows
git commit -m "chore(workflows): wire vitest/tsconfig entry points and capture paseo cli shapes"
```

---

### Task 2: Paseo CLI 轉接層（純函式 + 可注入 spawn）

**Blocked by:** Task 1（需要 fixtures 與測試入口）

**Files:**
- Create: `scripts/workflows/lib/paseo-cli.ts`
- Create: `scripts/workflows/__tests__/paseo-cli.test.ts`

**Interfaces:**
- Consumes: `fixtures/paseo-*.json`（Task 1 產物）
- Produces:
  - `interface CliInvocation { command: string; baseArgs: readonly string[] }`
  - `resolvePaseoCli(env?): CliInvocation`
  - `interface CliResult { stdout: string; stderr: string; code: number }`
  - `runCli(invocation, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }): Promise<CliResult>`
  - `parseJsonOutput<T>(raw: string): T`
  - `readAgentId(payload: unknown): string`
  - `interface InspectView { id: string; status: string; costUsd: number; pendingPermissions: readonly string[] }`
  - `readInspect(payload: unknown): InspectView`
  - `isTerminalStatus(status: string): boolean`

**Assumptions:** T0 — 終態集合固定為 `idle|closed|error|failed`；`LastUsage.CostUsd` 缺漏時視為 0。

**Done when:**
- `npm run test:workflows -- paseo-cli` → 全部 PASS
- `resolvePaseoCli({ PASEO_CLI_ENTRY: "C:/x/paseo.js" })` → `{ command: process.execPath, baseArgs: ["--disable-warning=DEP0040", "C:/x/paseo.js"] }`（測試斷言）
- `readAgentId({ id: "a" })` 與 `readAgentId({ Id: "a" })` 都回 `"a"`；`readAgentId({})` → 丟出錯誤訊息含 `no agent id`
- `readInspect(JSON.parse(readFileSync("fixtures/paseo-inspect.json").stdout of real payload))` → `status` 為非空字串、`costUsd >= 0`、`pendingPermissions` 為陣列
- `parseJsonOutput("warning: blabla\n[{\"id\":\"a\"}]")` → `[{ id: "a" }]`
- `npm run typecheck:scripts` → exit 0

- [ ] **Step 1: 寫失敗測試 `scripts/workflows/__tests__/paseo-cli.test.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTerminalStatus,
  parseJsonOutput,
  readAgentId,
  readInspect,
  resolvePaseoCli,
} from "../lib/paseo-cli.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");

function fixtureStdout(name: string): string {
  const file = JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as { stdout: string };
  return file.stdout;
}

describe("resolvePaseoCli", () => {
  it("uses PASEO_CLI_ENTRY when provided", () => {
    const invocation = resolvePaseoCli({ PASEO_CLI_ENTRY: "C:/x/paseo.js" });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.baseArgs).toEqual(["--disable-warning=DEP0040", "C:/x/paseo.js"]);
  });

  it("does not need PASEO_CLI_ENTRY to return a command", () => {
    expect(resolvePaseoCli({}).command.length).toBeGreaterThan(0);
  });
});

describe("parseJsonOutput", () => {
  it("skips leading warnings", () => {
    expect(parseJsonOutput('warning: x\n[{"id":"a"}]')).toEqual([{ id: "a" }]);
  });

  it("throws a named error when there is no JSON", () => {
    expect(() => parseJsonOutput("nothing here")).toThrow(/no JSON/);
  });
});

describe("readAgentId", () => {
  it("accepts camelCase and PascalCase", () => {
    expect(readAgentId({ id: "a" })).toBe("a");
    expect(readAgentId({ Id: "a" })).toBe("a");
  });

  it("throws when the id is missing", () => {
    expect(() => readAgentId({})).toThrow(/no agent id/);
  });

  it("reads the id out of the captured run payload", () => {
    const payload = parseJsonOutput(fixtureStdout("paseo-run.json"));
    expect(readAgentId(payload)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("readInspect", () => {
  it("normalises the captured inspect payload", () => {
    const payload = parseJsonOutput(fixtureStdout("paseo-inspect.json"));
    const view = readInspect(payload);
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.status.length).toBeGreaterThan(0);
    expect(view.costUsd).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(view.pendingPermissions)).toBe(true);
  });

  it("defaults cost to 0 when LastUsage is absent", () => {
    expect(readInspect({ Id: "a", Status: "idle" }).costUsd).toBe(0);
  });
});

describe("isTerminalStatus", () => {
  it("treats idle and closed as terminal", () => {
    expect(isTerminalStatus("idle")).toBe(true);
    expect(isTerminalStatus("closed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm run test:workflows -- paseo-cli
```

Expected: FAIL — `Cannot find module '../lib/paseo-cli.ts'`

- [ ] **Step 3: 實作 `scripts/workflows/lib/paseo-cli.ts`**

```ts
/**
 * The only module that talks to the Paseo CLI.
 * Spawns the real CLI entry (never a shell string) and tolerates both the
 * camelCase (`ls`) and PascalCase (`inspect`) JSON shapes Paseo emits.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface CliInvocation {
  readonly command: string;
  readonly baseArgs: readonly string[];
}

const DISABLE_WARNING = "--disable-warning=DEP0040";

/** Resolves how to launch paseo without going through a shell shim when possible. */
export function resolvePaseoCli(env: NodeJS.ProcessEnv = process.env): CliInvocation {
  if (env.PASEO_CLI_ENTRY) {
    return { command: process.execPath, baseArgs: [DISABLE_WARNING, env.PASEO_CLI_ENTRY] };
  }
  if (process.platform === "win32") {
    try {
      const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
      const entry = path.join(root, "@getpaseo", "cli", "bin", "paseo");
      if (existsSync(entry)) {
        return { command: process.execPath, baseArgs: [DISABLE_WARNING, entry] };
      }
    } catch {
      // fall through to the shell shim below
    }
    return { command: "cmd.exe", baseArgs: ["/d", "/s", "/c", "paseo"] };
  }
  return { command: "paseo", baseArgs: [] };
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Runs one paseo invocation and never throws on a non-zero exit code. */
export function runCli(
  invocation: CliInvocation,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.baseArgs, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill();
            reject(new Error(`paseo ${args.slice(0, 2).join(" ")} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Parses the first JSON value in CLI output, skipping leading warnings. */
export function parseJsonOutput<T>(raw: string): T {
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in CLI output: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start)) as T;
}

/** Reads an agent id from either the camelCase or the PascalCase payload. */
export function readAgentId(payload: unknown): string {
  const record = payload as Record<string, unknown> | null;
  const candidate = record?.Id ?? record?.id ?? record?.agentId;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`no agent id in payload: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return candidate;
}

export interface InspectView {
  readonly id: string;
  readonly status: string;
  readonly costUsd: number;
  readonly pendingPermissions: readonly string[];
}

/** Normalises `paseo inspect --json` into the fields the executor needs. */
export function readInspect(payload: unknown): InspectView {
  const record = (payload ?? {}) as Record<string, unknown>;
  const id = record.Id ?? record.id;
  const status = record.Status ?? record.status;
  const usage = (record.LastUsage ?? record.lastUsage) as Record<string, unknown> | undefined;
  const cost = usage?.CostUsd ?? usage?.costUsd ?? 0;
  const pending = record.PendingPermissions ?? record.pendingPermissions ?? [];
  return {
    id: typeof id === "string" ? id : "",
    status: typeof status === "string" ? status : "unknown",
    costUsd: typeof cost === "number" ? cost : 0,
    pendingPermissions: Array.isArray(pending)
      ? pending.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      : [],
  };
}

const TERMINAL = new Set(["idle", "closed", "error", "failed", "stopped"]);

/** True when the agent has stopped working (idle/closed/terminal states). */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status.toLowerCase());
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npm run test:workflows -- paseo-cli
npm run typecheck:scripts
```

Expected: 全部 PASS；tsc exit 0

- [ ] **Step 5: Commit**

```bash
git add scripts/workflows/lib/paseo-cli.ts scripts/workflows/__tests__/paseo-cli.test.ts
git commit -m "feat(workflows): add paseo cli adapter with shape-tolerant parsers"
```

---

### Task 3: 編排 primitive（`Task` / `sdk` / `defineWorkflow`）

**Blocked by:** None（只依賴 node + zod，不依賴 Task 2 的實作）

**Files:**
- Create: `scripts/workflows/lib/types.ts`
- Create: `scripts/workflows/lib/task.ts`
- Create: `scripts/workflows/lib/sdk.ts`
- Create: `scripts/workflows/lib/workflow.ts`
- Create: `scripts/workflows/__tests__/support/fake-executor.ts`
- Create: `scripts/workflows/__tests__/sdk.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (Task 4 會注入真的 `Executor`)
- Produces（Task 4/5/6 依賴，名稱與型別不得改）：
  - `AgentResult<A = unknown> { sessionId: string; output: A; costUsd: number }`
  - `Outcome<A> = { status: "success"; value: A } | { status: "error"; error: { name: string; message: string } }`
  - `Executor { runAgent(request: AgentRequest): Promise<RawAgentResult> }`
  - `class Task<A> { run(): Promise<A>; then(...) }`（惰性 + 記憶化 + awaitable）
  - `interface Sdk { agent(...): Task<AgentResult<A>>; parallel<A>(tasks): Task<Outcome<A>[]>; phase<A>(name, task): Task<A>; textPrompt(text, label?): AgentPromptInput }`
  - `makeSdk(context: RunContext): Sdk`
  - `defineWorkflow<S extends z.ZodTypeAny>(def: { description: string; args: S; run(args, sdk): Promise<unknown> }): WorkflowDefinition<S>`
  - Errors: `BudgetExceeded`、`InvalidOutput(sessionId, message, cause)`、`MissingResult(sessionId, resultPath)`
  - `makeFakeExecutor(handler?): { executor: Executor; calls: AgentRequest[]; maxConcurrent: () => number }`（測試用）

**Assumptions:** T0 — `agent()` 一律要求 child 輸出 JSON（無 schema 時回 `AgentResult<unknown>`）；`dryRun` 時跳過 schema 驗證並回 `output: {}`。

**Done when:**
- `npm run test:workflows -- sdk` → 全部 PASS
- 惰性測試：建立 `agent(...)` 但未 await → fake executor 的 `calls.length === 0`
- 保序測試：4 項平行、第 1 項最慢 → 回傳順序等於輸入順序
- 失敗隔離測試：3 項中第 2 項 throw → `outcomes[1].status === "error"`，其餘 `success`
- 預算測試：`budgetUsd = 0.001` 且 fake executor 每次回 `costUsd = 0.001` → 第二次呼叫前 `parallel()` 外拋 `BudgetExceeded`（不是變成 `Outcome.error`）
- schema 測試：schema 要求 `{ ok: boolean }`、child 回 `{"nope":1}` → 拋 `InvalidOutput` 且 `error.sessionId` 等於該 child 的 id
- 續接測試：`agent(prompt, { sessionId: "prev-id" })` → fake executor 收到的 `request.sessionId === "prev-id"`
- 併發上限測試：`concurrency = 2`、4 項各 60ms → 觀察到的最大同時執行數 `<= 2`
- `npm run typecheck:scripts` → exit 0

- [ ] **Step 1: 寫 `lib/types.ts`**

（完整內容如下，Task 4 直接匯入這些型別；欄位名稱不得更動）

```ts
import type { z } from "zod";

/** One workflow step's prompt text and optional human label. */
export interface AgentPromptInput {
  readonly text: string;
  readonly label?: string;
}

/** Per-call overrides; every field falls back to RunSettings.defaults. */
export interface AgentOptions<A = unknown> {
  readonly label?: string;
  readonly sessionId?: string;
  readonly schema?: z.ZodType<A>;
  readonly provider?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly timeoutMs?: number;
}

/** Everything the executor needs to launch one child agent. */
export interface AgentRequest {
  readonly callId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly mode?: string;
  readonly cwd: string;
  readonly runDir: string;
  readonly sessionId?: string;
  readonly timeoutMs: number;
  readonly autoPermit: boolean;
  readonly taskFile: string;
  readonly taskText: string;
  readonly instruction: string;
  readonly resultPath: string;
}

/** What an executor returns: the child session id plus the raw result file text. */
export interface RawAgentResult {
  readonly sessionId: string;
  readonly output: string;
  readonly costUsd: number;
  readonly status: string;
}

export interface Executor {
  runAgent(request: AgentRequest): Promise<RawAgentResult>;
}

/** A decoded child result. */
export interface AgentResult<A = unknown> {
  readonly sessionId: string;
  readonly output: A;
  readonly costUsd: number;
}

/** Stable per-item outcome for parallel(); interruption and defects still throw. */
export type Outcome<A> =
  | { readonly status: "success"; readonly value: A }
  | {
      readonly status: "error";
      readonly error: { readonly name: string; readonly message: string };
    };

export interface TraceEvent {
  readonly at: string;
  readonly type:
    | "run.start"
    | "run.end"
    | "phase.start"
    | "phase.end"
    | "call.start"
    | "call.end"
    | "call.error"
    | "permission"
    | "budget";
  readonly label?: string;
  readonly callId?: string;
  readonly sessionId?: string;
  readonly costUsd?: number;
  readonly message?: string;
}

export interface RunSettings {
  readonly concurrency: number;
  readonly budgetUsd: number | null;
  readonly dryRun: boolean;
  readonly autoPermit: boolean;
  readonly defaults: {
    readonly provider: string;
    readonly model: string;
    readonly mode?: string;
    readonly timeoutMs: number;
  };
}

export interface CallRecord {
  readonly callId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly sessionId: string;
  readonly costUsd: number;
  readonly status: string;
  readonly durationMs: number;
  readonly resultPath: string;
  readonly ok: boolean;
}

export interface RunContext {
  readonly executor: Executor;
  readonly settings: RunSettings;
  readonly runDir: string;
  readonly cwd: string;
  readonly trace: (event: TraceEvent) => void;
  readonly record: (call: CallRecord) => void;
  readonly spentUsd: () => number;
  readonly addCost: (usd: number) => void;
}

export interface RunReport {
  readonly workflow: string;
  readonly workflowPath: string;
  readonly args: unknown;
  readonly runDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly dryRun: boolean;
  readonly calls: readonly CallRecord[];
  readonly totalCostUsd: number;
  readonly ok: boolean;
  readonly result: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}
```

- [ ] **Step 2: 寫 `lib/task.ts`**

```ts
import type { RunContext } from "./types.ts";

/**
 * A lazily executed, memoized step. Awaiting it runs it once; passing it into
 * parallel() runs nothing until parallel() itself is awaited.
 */
export class Task<A> {
  #promise: Promise<A> | null = null;

  constructor(
    private readonly thunk: (context: RunContext) => Promise<A>,
    private readonly context: RunContext,
  ) {}

  run(): Promise<A> {
    this.#promise ??= this.thunk(this.context);
    return this.#promise;
  }

  then<R1 = A, R2 = never>(
    onFulfilled?: ((value: A) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.run().then(onFulfilled, onRejected);
  }
}

export function isTask(value: unknown): value is Task<unknown> {
  return value instanceof Task;
}
```

- [ ] **Step 3: 寫 `lib/workflow.ts`**

```ts
import type { z } from "zod";
import type { Sdk } from "./sdk.ts";

/** One workflow file's public contract. */
export interface WorkflowDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly description: string;
  readonly args: S;
  readonly run: (args: z.infer<S>, sdk: Sdk) => Promise<unknown>;
}

/** Freezes a workflow definition. Identity is owned by the file path. */
export function defineWorkflow<S extends z.ZodTypeAny>(
  definition: WorkflowDefinition<S>,
): WorkflowDefinition<S> {
  return Object.freeze(definition);
}
```

- [ ] **Step 4: 寫失敗測試 `scripts/workflows/__tests__/support/fake-executor.ts`**

```ts
import type { AgentRequest, CallRecord, Executor, RawAgentResult, RunContext, RunSettings } from "../../lib/types.ts";

export interface FakeExecutor {
  readonly executor: Executor;
  readonly calls: AgentRequest[];
  readonly maxConcurrent: () => number;
}

export interface FakeOptions {
  readonly delayMs?: number;
  readonly delayByLabel?: Record<string, number>;
  readonly outputByLabel?: Record<string, string>;
  readonly costUsd?: number;
  readonly failLabels?: readonly string[];
}

/** A deterministic Executor for unit tests: no CLI, no LLM, no network. */
export function makeFakeExecutor(options: FakeOptions = {}): FakeExecutor {
  const calls: AgentRequest[] = [];
  let active = 0;
  let peak = 0;
  const executor: Executor = {
    async runAgent(request: AgentRequest): Promise<RawAgentResult> {
      calls.push(request);
      active += 1;
      peak = Math.max(peak, active);
      const delay = options.delayByLabel?.[request.label] ?? options.delayMs ?? 0;
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (options.failLabels?.includes(request.label)) {
          throw new Error(`fake failure: ${request.label}`);
        }
        return {
          sessionId: request.sessionId ?? `fake-${request.callId}`,
          output: options.outputByLabel?.[request.label] ?? '{"ok":true}',
          costUsd: options.costUsd ?? 0,
          status: "idle",
        };
      } finally {
        active -= 1;
      }
    },
  };
  return { executor, calls, maxConcurrent: () => peak };
}

export function makeRunSettings(overrides: Partial<RunSettings> = {}): RunSettings {
  return {
    concurrency: 4,
    budgetUsd: null,
    dryRun: false,
    autoPermit: false,
    defaults: {
      provider: "opencode",
      model: "opencode/deepseek-v4.1-flash-free",
      timeoutMs: 900_000,
    },
    ...overrides,
  };
}

export function makeRunContext(
  executor: Executor,
  overrides: { settings?: Partial<RunSettings>; runDir?: string; record?: (call: CallRecord) => void } = {},
): RunContext {
  let spent = 0;
  return {
    executor,
    settings: makeRunSettings(overrides.settings),
    runDir: overrides.runDir ?? ".test-run",
    cwd: process.cwd(),
    trace: () => {},
    record: overrides.record ?? (() => {}),
    spentUsd: () => spent,
    addCost: (usd: number) => {
      spent += usd;
    },
  };
}
```

- [ ] **Step 5: 寫失敗測試 `scripts/workflows/__tests__/sdk.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetExceeded, InvalidOutput, makeSdk } from "../lib/sdk.ts";
import { makeFakeExecutor, makeRunContext } from "./support/fake-executor.ts";

describe("agent()", () => {
  it("is lazy until awaited", async () => {
    const fake = makeFakeExecutor();
    const sdk = makeSdk(makeRunContext(fake.executor));
    const task = sdk.agent("do nothing");
    expect(fake.calls.length).toBe(0);
    await task;
    expect(fake.calls.length).toBe(1);
  });

  it("runs once when awaited twice", async () => {
    const fake = makeFakeExecutor();
    const sdk = makeSdk(makeRunContext(fake.executor));
    const task = sdk.agent("once");
    await Promise.all([task.run(), task.run()]);
    expect(fake.calls.length).toBe(1);
  });

  it("forwards sessionId for continuation", async () => {
    const fake = makeFakeExecutor();
    const sdk = makeSdk(makeRunContext(fake.executor));
    await sdk.agent("continue", { sessionId: "prev-id" });
    expect(fake.calls[0]?.sessionId).toBe("prev-id");
  });

  it("decodes with schema and reports InvalidOutput with the session id", async () => {
    const fake = makeFakeExecutor({ outputByLabel: { bad: '{"nope":1}' } });
    const sdk = makeSdk(makeRunContext(fake.executor));
    const task = sdk.agent("x", { label: "bad", schema: z.object({ ok: z.boolean() }) });
    await expect(task.run()).rejects.toBeInstanceOf(InvalidOutput);
    try {
      await task.run();
    } catch (error) {
      expect((error as InvalidOutput).sessionId).toMatch(/^fake-/);
    }
  });

  it("writes the task file with the absolute result path", async () => {
    const fake = makeFakeExecutor();
    const context = makeRunContext(fake.executor, { runDir: ".test-run" });
    const sdk = makeSdk(context);
    await sdk.agent("hello");
    expect(fake.calls[0]?.taskText).toContain(fake.calls[0]!.resultPath);
    expect(fake.calls[0]?.instruction).toContain("Write your final answer as JSON");
  });
});

describe("parallel()", () => {
  it("preserves input order when the first item is slowest", async () => {
    const fake = makeFakeExecutor({ delayByLabel: { a: 80, b: 40, c: 20, d: 1 } });
    const sdk = makeSdk(makeRunContext(fake.executor));
    const outcomes = await sdk.parallel([
      sdk.agent("1", { label: "a" }),
      sdk.agent("2", { label: "b" }),
      sdk.agent("3", { label: "c" }),
      sdk.agent("4", { label: "d" }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["success", "success", "success", "success"]);
    expect(fake.calls.map((c) => c.label)).toEqual(["a", "b", "c", "d"]);
  });

  it("isolates an expected failure as an item error", async () => {
    const fake = makeFakeExecutor({ failLabels: ["boom"] });
    const sdk = makeSdk(makeRunContext(fake.executor));
    const outcomes = await sdk.parallel([
      sdk.agent("1", { label: "ok-1" }),
      sdk.agent("2", { label: "boom" }),
      sdk.agent("3", { label: "ok-2" }),
    ]);
    expect(outcomes[0]?.status).toBe("success");
    expect(outcomes[1]?.status).toBe("error");
    expect(outcomes[2]?.status).toBe("success");
  });

  it("respects the concurrency limit", async () => {
    const fake = makeFakeExecutor({ delayMs: 60 });
    const sdk = makeSdk(makeRunContext(fake.executor, { settings: { concurrency: 2 } }));
    await sdk.parallel([1, 2, 3, 4].map((n) => sdk.agent(String(n), { label: `n${n}` })));
    expect(fake.maxConcurrent()).toBeLessThanOrEqual(2);
  });

  it("rethrows BudgetExceeded instead of turning it into an item error", async () => {
    const fake = makeFakeExecutor({ costUsd: 0.001 });
    const context = makeRunContext(fake.executor, { settings: { budgetUsd: 0.001, concurrency: 1 } });
    const sdk = makeSdk(context);
    await expect(
      sdk.parallel([sdk.agent("1", { label: "a" }), sdk.agent("2", { label: "b" })]),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe("phase()", () => {
  it("passes the value through and emits start/end traces", async () => {
    const events: string[] = [];
    const fake = makeFakeExecutor();
    const context = makeRunContext(fake.executor);
    const traced = { ...context, trace: (event: { type: string }) => events.push(event.type) };
    const sdk = makeSdk(traced as typeof context);
    const value = await sdk.phase("Fan-out", sdk.agent("x"));
    expect(value.output).toEqual({ ok: true });
    expect(events).toEqual(["phase.start", "phase.end"]);
  });
});
```

- [ ] **Step 6: 跑測試確認失敗**

```bash
npm run test:workflows -- sdk
```

Expected: FAIL — `Cannot find module '../lib/sdk.ts'`

- [ ] **Step 7: 實作 `scripts/workflows/lib/sdk.ts`**

```ts
/**
 * The authoring API: agent(), parallel(), phase(), textPrompt().
 * Primitives return lazily executed Tasks, so a workflow's control flow is
 * ordinary async/await while parallel() still receives unevaluated children.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { Task } from "./task.ts";
import type {
  AgentOptions,
  AgentPromptInput,
  AgentRequest,
  AgentResult,
  Outcome,
  RawAgentResult,
  RunContext,
} from "./types.ts";

/** Raised before starting an agent once the run budget is exhausted. */
export class BudgetExceeded extends Error {
  constructor(spentUsd: number, budgetUsd: number) {
    super(`budget exceeded: spent $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(4)}`);
    this.name = "BudgetExceeded";
  }
}

/** The child wrote JSON that does not satisfy the call's schema. Never retried. */
export class InvalidOutput extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "InvalidOutput";
  }
}

/** The child finished without writing its result file. */
export class MissingResult extends Error {
  constructor(
    readonly sessionId: string,
    readonly resultPath: string,
  ) {
    super(`child ${sessionId} did not write ${resultPath}`);
    this.name = "MissingResult";
  }
}

export interface Sdk {
  agent<A>(
    input: string | AgentPromptInput,
    options: AgentOptions<A> & { schema: z.ZodType<A> },
  ): Task<AgentResult<A>>;
  agent(input: string | AgentPromptInput, options?: AgentOptions): Task<AgentResult<unknown>>;
  parallel<A>(tasks: readonly Task<A>[]): Task<Outcome<A>[]>;
  phase<A>(name: string, task: Task<A>): Task<A>;
  textPrompt(text: string, label?: string): AgentPromptInput;
}

const ARTIFACT_HEADER = [
  "Execute the task below and write your final answer as a single JSON document.",
  "Task file (read this file in full before doing anything): {taskFile}",
  "Result file (write your JSON here, overwriting any previous content): {resultPath}",
  "Rules: write only the result file; never modify files under src/; never write outside the result path;",
  "if you cannot complete the task, still write JSON with an \"error\" field explaining why.",
].join("\n");

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "call";
}

function decodeOutput(raw: RawAgentResult, schema?: z.ZodType<unknown>): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.output);
  } catch (cause) {
    throw new InvalidOutput(raw.sessionId, `child output is not JSON (${String(cause)})`, cause);
  }
  if (!schema) return parsed;
  const result = schema.safeParse(parsed);
  if (!result.success) throw new InvalidOutput(raw.sessionId, result.error.message, result.error);
  return result.data;
}

/** Binds the primitives to one run's context. */
export function makeSdk(context: RunContext): Sdk {
  let callCount = 0;

  function agent(
    input: string | AgentPromptInput,
    options: AgentOptions<never> = {},
  ): Task<AgentResult<never>> {
    const prompt: AgentPromptInput = typeof input === "string" ? { text: input } : input;
    const label = options.label ?? prompt.label ?? prompt.text.split("\n")[0]!.slice(0, 60);
    const callId = `${slugify(label)}-c${++callCount}`;

    return new Task(async (ctx) => {
      const provider = options.provider ?? ctx.settings.defaults.provider;
      const model = options.model ?? ctx.settings.defaults.model;
      const budget = ctx.settings.budgetUsd;
      if (budget !== null && ctx.spentUsd() >= budget) {
        ctx.trace({ at: new Date().toISOString(), type: "budget", label, message: "budget exhausted" });
        throw new BudgetExceeded(ctx.spentUsd(), budget);
      }

      const resultPath = path.join(ctx.runDir, `${callId}.result.json`);
      const taskFile = path.join(ctx.runDir, `${callId}.task.md`);
      const instruction = ARTIFACT_HEADER.replace("{taskFile}", taskFile).replace("{resultPath}", resultPath);
      const taskText = `${instruction}\n\n---\n\n${prompt.text}\n`;

      if (ctx.settings.dryRun) {
        const sessionId = `dry-run:${callId}`;
        ctx.trace({ at: new Date().toISOString(), type: "call.start", callId, label });
        ctx.trace({ at: new Date().toISOString(), type: "call.end", callId, label, sessionId, costUsd: 0 });
        ctx.record({
          callId,
          label,
          provider,
          model,
          sessionId,
          costUsd: 0,
          status: "dry-run",
          durationMs: 0,
          resultPath,
          ok: true,
        });
        return { sessionId, output: {} as never, costUsd: 0 };
      }

      await writeFile(taskFile, taskText, "utf8");
      ctx.trace({ at: new Date().toISOString(), type: "call.start", callId, label });
      const startedAt = Date.now();

      let raw: RawAgentResult;
      try {
        raw = await ctx.executor.runAgent({
          callId,
          label,
          provider,
          model,
          mode: options.mode ?? ctx.settings.defaults.mode,
          cwd: ctx.cwd,
          runDir: ctx.runDir,
          sessionId: options.sessionId,
          timeoutMs: options.timeoutMs ?? ctx.settings.defaults.timeoutMs,
          autoPermit: ctx.settings.autoPermit,
          taskFile,
          taskText,
          instruction,
          resultPath,
        });
      } catch (error) {
        ctx.trace({
          at: new Date().toISOString(),
          type: "call.error",
          callId,
          label,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      ctx.addCost(raw.costUsd);
      ctx.trace({
        at: new Date().toISOString(),
        type: "call.end",
        callId,
        label,
        sessionId: raw.sessionId,
        costUsd: raw.costUsd,
        message: raw.status,
      });
      const output = decodeOutput(raw, options.schema);
      ctx.record({
        callId,
        label,
        provider,
        model,
        sessionId: raw.sessionId,
        costUsd: raw.costUsd,
        status: raw.status,
        durationMs,
        resultPath,
        ok: true,
      });
      if (budget !== null && ctx.spentUsd() > budget) {
        ctx.trace({ at: new Date().toISOString(), type: "budget", label, message: "budget exceeded after call" });
        throw new BudgetExceeded(ctx.spentUsd(), budget);
      }
      return { sessionId: raw.sessionId, output: output as never, costUsd: raw.costUsd };
    }, context);
  }

  const parallel = <A,>(tasks: readonly Task<A>[]): Task<Outcome<A>[]> =>
    new Task(async (ctx) => {
      const limit = Math.max(1, ctx.settings.concurrency);
      const outcomes = new Array<Outcome<A>>(tasks.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor++;
          if (index >= tasks.length) return;
          const item = tasks[index]!;
          try {
            outcomes[index] = { status: "success", value: await item.run() };
          } catch (error) {
            if (error instanceof BudgetExceeded) throw error;
            outcomes[index] = {
              status: "error",
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
      return outcomes;
    }, context);

  const phase = <A,>(name: string, task: Task<A>): Task<A> =>
    new Task(async (ctx) => {
      ctx.trace({ at: new Date().toISOString(), type: "phase.start", label: name });
      try {
        return await task.run();
      } finally {
        ctx.trace({ at: new Date().toISOString(), type: "phase.end", label: name });
      }
    }, context);

  const textPrompt = (text: string, label?: string): AgentPromptInput => ({ text, label });

  return { agent: agent as Sdk["agent"], parallel, phase, textPrompt };
}
```

- [ ] **Step 8: 跑測試確認通過**

```bash
npm run test:workflows -- sdk
npm run typecheck:scripts
```

Expected: 全部 PASS；tsc exit 0

- [ ] **Step 9: Commit**

```bash
git add scripts/workflows/lib/types.ts scripts/workflows/lib/task.ts scripts/workflows/lib/sdk.ts scripts/workflows/lib/workflow.ts scripts/workflows/__tests__/sdk.test.ts scripts/workflows/__tests__/support/fake-executor.ts
git commit -m "feat(workflows): add lazy task primitives, agent/parallel/phase sdk and defineWorkflow"
```

---

### Task 4: Paseo executor、runner、CLI

**Blocked by:** Task 2（CLI 轉接層）、Task 3（SDK 與型別）

**Files:**
- Create: `scripts/workflows/lib/executor-paseo.ts`
- Create: `scripts/workflows/lib/executor-stub.ts`
- Create: `scripts/workflows/lib/runner.ts`
- Create: `scripts/workflows/run.ts`
- Create: `scripts/workflows/__tests__/support/fixtures/sample.workflow.ts`
- Create: `scripts/workflows/__tests__/executor-paseo.test.ts`
- Create: `scripts/workflows/__tests__/runner.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolvePaseoCli` / `runCli` / `parseJsonOutput` / `readAgentId` / `readInspect` / `isTerminalStatus`；Task 3 的 `makeSdk` / `BudgetExceeded` / `MissingResult` / `Executor`
- Produces:
  - `class PaseoExecutor implements Executor`，建構子吃 `PaseoExecutorOptions`
  - `class PermissionBlocked extends Error { sessionId: string; permissions: readonly string[] }`
  - `class StubExecutor implements Executor`（零成本控制流驗證）
  - `runWorkflow(options: RunOptions): Promise<RunReport>`、`loadWorkflow(workflowPath: string): Promise<WorkflowDefinition>`
  - `class ArgsInvalid extends Error { issues: readonly string[] }`
  - CLI `node scripts/workflows/run.ts`，exit code：`0` ok / `2` args 不合法 / `3` workflow 失敗 / `4` 超預算 / `5` 權限被擋

**Assumptions:** T0 — 每個 child 的 `--label` 固定為 `workflow=<label>`（用來在 `paseo ls --label` 過濾）；`run` 一律加 `--background`（F18）；結果檔重讀 3 次、間隔 2 秒。

**Done when:**
- `npm run test:workflows -- executor-paseo` → 全部 PASS
- `runAgent` 用注入的假 CLI → 回傳 `{ sessionId: "abc…", output: "<file text>", costUsd: 0.5, status: "idle" }`
- `PendingPermissions: ["write"]` 且 `autoPermit: false` → 拋 `PermissionBlocked`，且假 CLI 收到過 `stop`
- `PendingPermissions: ["write"]` 且 `autoPermit: true` → 假 CLI 收到 `permit allow`，run 正常完成
- `sessionId: "prev-id"` → 假 CLI 收到 `send` + `--prompt-file`，且**沒有**收到 `run`
- 結果檔不存在 → 拋 `MissingResult`，訊息含檔案路徑
- `npm run test:workflows -- runner` → 全部 PASS
- `--dry-run` 的 run：executor 的 `runAgent` 被呼叫 **0 次**、`report.calls[*].sessionId` 全以 `dry-run:` 開頭、`runDir` 內同時有 `report.json` 與 `report.md`
- args 不合法 → 拋 `ArgsInvalid`，訊息含欄位路徑
- `npx node scripts/workflows/run.ts scripts/workflows/__tests__/support/fixtures/sample.workflow.ts --args-file <tmp>` 搭配 `--executor stub` → exit 0、`report.json` 的 `ok: true`、`calls.length === 3`
- `npm run typecheck:scripts` → exit 0

- [ ] **Step 1: 寫 `lib/executor-paseo.ts`**

```ts
/**
 * The live Executor: one child agent = one background `paseo run`, then wait,
 * then read the result file the child was told to write. Never parses logs.
 */
import { readFile } from "node:fs/promises";
import {
  isTerminalStatus,
  parseJsonOutput,
  readAgentId,
  readInspect,
  resolvePaseoCli,
  runCli as defaultRunCli,
  type CliInvocation,
  type CliResult,
} from "./paseo-cli.ts";
import { MissingResult } from "./sdk.ts";
import type { AgentRequest, Executor, RawAgentResult } from "./types.ts";

/** Raised when a child agent waits on a permission the run is not allowed to grant. */
export class PermissionBlocked extends Error {
  constructor(
    readonly sessionId: string,
    readonly permissions: readonly string[],
  ) {
    super(`child ${sessionId} is blocked on permissions: ${permissions.join(", ")}`);
    this.name = "PermissionBlocked";
  }
}

export interface PaseoExecutorOptions {
  readonly cli?: CliInvocation;
  readonly pollTimeoutSeconds?: number;
  readonly resultRetryMs?: number;
  readonly readResultAttempts?: number;
  readonly cliRunner?: (
    invocation: CliInvocation,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<CliResult>;
  readonly onPermission?: (agentId: string, permissions: readonly string[], allowed: boolean) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PaseoExecutor implements Executor {
  private readonly pollTimeoutSeconds: number;
  private readonly resultRetryMs: number;
  private readonly readResultAttempts: number;

  constructor(private readonly options: PaseoExecutorOptions = {}) {
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.resultRetryMs = options.resultRetryMs ?? 4000;
    this.readResultAttempts = options.readResultAttempts ?? 3;
  }

  async runAgent(request: AgentRequest): Promise<RawAgentResult> {
    const cli = this.options.cli ?? resolvePaseoCli();
    const runner = this.options.cliRunner ?? defaultRunCli;
    const deadline = Date.now() + request.timeoutMs;

    let agentId: string;
    if (request.sessionId) {
      const sent = await runner(cli, [
        "send", request.sessionId, "--prompt-file", request.taskFile, "--no-wait", "--json",
      ]);
      if (sent.code !== 0) {
        throw new Error(`paseo send failed (${sent.code}): ${sent.stderr.slice(0, 300)}`);
      }
      agentId = request.sessionId;
    } else {
      const args = [
        "run", request.instruction,
        "--provider", request.provider,
        "--model", request.model,
        "--cwd", request.cwd,
        "--label", `workflow=${request.label}`,
        "--background",
        "--json",
      ];
      if (request.mode) args.push("--mode", request.mode);
      const created = await runner(cli, args, { cwd: request.cwd });
      if (created.code !== 0) {
        throw new Error(`paseo run failed (${created.code}): ${created.stderr.slice(0, 300)}`);
      }
      agentId = readAgentId(parseJsonOutput(created.stdout));
    }

    let status = "unknown";
    let costUsd = 0;
    for (;;) {
      if (Date.now() >= deadline) {
        await runner(cli, ["stop", agentId]);
        throw new Error(`child ${agentId} exceeded its ${request.timeoutMs}ms timeout`);
      }
      await runner(cli, ["wait", agentId, "--timeout", String(this.pollTimeoutSeconds), "--json"]);
      const inspected = await runner(cli, ["inspect", agentId, "--json"]);
      if (inspected.code !== 0) {
        throw new Error(`paseo inspect failed (${inspected.code}): ${inspected.stderr.slice(0, 300)}`);
      }
      const view = readInspect(parseJsonOutput(inspected.stdout));
      status = view.status;
      costUsd = view.costUsd;

      if (view.pendingPermissions.length > 0) {
        this.options.onPermission?.(agentId, view.pendingPermissions, request.autoPermit);
        if (!request.autoPermit) {
          await runner(cli, ["stop", agentId]);
          throw new PermissionBlocked(agentId, view.pendingPermissions);
        }
        const allowed = await runner(cli, ["permit", "allow", agentId]);
        if (allowed.code !== 0) {
          throw new Error(`paseo permit allow failed (${allowed.code}): ${allowed.stderr.slice(0, 300)}`);
        }
        continue;
      }
      if (isTerminalStatus(status)) break;
    }

    const output = await this.readResult(agentId, request.resultPath, deadline);
    return { sessionId: agentId, output, costUsd, status };
  }

  private async readResult(agentId: string, resultPath: string, deadline: number): Promise<string> {
    for (let attempt = 0; attempt < this.readResultAttempts; attempt += 1) {
      try {
        return await readFile(resultPath, "utf8");
      } catch {
        if (Date.now() + this.resultRetryMs > deadline) break;
        await sleep(this.resultRetryMs);
      }
    }
    throw new MissingResult(agentId, resultPath);
  }
}
```

- [ ] **Step 2: 寫 `lib/executor-stub.ts`**

```ts
/**
 * Zero-cost control-flow executor: writes a fixed JSON body to every result
 * path. Use with `--executor stub` to validate a workflow's wiring without
 * spending an agent call. It does NOT validate schemas.
 */
import { writeFile } from "node:fs/promises";
import type { AgentRequest, Executor, RawAgentResult } from "./types.ts";

export class StubExecutor implements Executor {
  constructor(private readonly body: string = "{}") {}

  async runAgent(request: AgentRequest): Promise<RawAgentResult> {
    await writeFile(request.resultPath, this.body, "utf8");
    return {
      sessionId: `stub-${request.callId}`,
      output: this.body,
      costUsd: 0,
      status: "stub",
    };
  }
}
```

- [ ] **Step 3: 寫 `lib/runner.ts`**

```ts
/**
 * Loads a workflow file, validates its args, owns the run directory, and
 * writes the report. One run = one directory under .runs/.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PaseoExecutor } from "./executor-paseo.ts";
import { makeSdk } from "./sdk.ts";
import type { CallRecord, Executor, RunContext, RunReport, RunSettings, TraceEvent } from "./types.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/** The workflow's own zod schema rejected the supplied args. */
export class ArgsInvalid extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid workflow args:\n- ${issues.join("\n- ")}`);
    this.name = "ArgsInvalid";
  }
}

export interface RunOptions {
  readonly workflowPath: string;
  readonly rawArgs: unknown;
  readonly cwd: string;
  readonly runsRoot: string;
  readonly settings: RunSettings;
  readonly executor?: Executor;
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function workflowSlug(workflowPath: string): string {
  return path.basename(workflowPath).replace(/\.workflow\.ts$/, "").replace(/\.ts$/, "");
}

/** Imports a workflow module and checks its default export shape. */
export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  const absolute = path.resolve(workflowPath);
  const module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  const definition = module.default as WorkflowDefinition | undefined;
  if (!definition || typeof definition.run !== "function" || typeof definition.args?.safeParse !== "function") {
    throw new Error(`workflow ${absolute} must export default defineWorkflow({ description, args, run })`);
  }
  return definition;
}

/** Runs one workflow to completion and always writes report.json + report.md. */
export async function runWorkflow(options: RunOptions): Promise<RunReport> {
  const definition = await loadWorkflow(options.workflowPath);
  const parsed = definition.args.safeParse(options.rawArgs);
  if (!parsed.success) {
    throw new ArgsInvalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }

  const startedAt = new Date();
  const slug = workflowSlug(options.workflowPath);
  const runDir = path.join(options.runsRoot, `${stamp(startedAt)}-${slug}`);
  await mkdir(runDir, { recursive: true });

  const tracePath = path.join(runDir, "trace.jsonl");
  const calls: CallRecord[] = [];
  let spentUsd = 0;
  const trace = (event: TraceEvent): void => {
    void appendFile(tracePath, `${JSON.stringify(event)}\n`, "utf8");
  };
  const context: RunContext = {
    executor: options.executor ?? new PaseoExecutor(),
    settings: options.settings,
    runDir,
    cwd: options.cwd,
    trace,
    record: (call) => {
      calls.push(call);
    },
    spentUsd: () => spentUsd,
    addCost: (usd) => {
      spentUsd += usd;
    },
  };

  trace({
    at: startedAt.toISOString(),
    type: "run.start",
    label: slug,
    message: options.settings.dryRun ? "dry-run" : "live",
  });

  let result: unknown = null;
  let error: { name: string; message: string } | undefined;
  try {
    result = await definition.run(parsed.data, makeSdk(context));
  } catch (cause) {
    error = {
      name: cause instanceof Error ? cause.name : "Error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const finishedAt = new Date();
  trace({
    at: finishedAt.toISOString(),
    type: "run.end",
    label: slug,
    costUsd: spentUsd,
    message: error ? error.message : "ok",
  });

  const report: RunReport = {
    workflow: slug,
    workflowPath: path.resolve(options.workflowPath),
    args: parsed.data,
    runDir,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    dryRun: options.settings.dryRun,
    calls,
    totalCostUsd: spentUsd,
    ok: error === undefined,
    result,
    ...(error ? { error } : {}),
  };

  await writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify(
      { workflowPath: report.workflowPath, args: report.args, settings: options.settings, startedAt: report.startedAt },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(path.join(runDir, "report.md"), renderReport(report), "utf8");
  return report;
}

/** Renders the human-readable report that sits next to report.json. */
export function renderReport(report: RunReport): string {
  const failed = report.calls.filter((call) => !call.ok).length;
  const lines: string[] = [
    `# Workflow run: ${report.workflow}`,
    "",
    `- workflow: \`${report.workflowPath}\``,
    `- mode: ${report.dryRun ? "dry-run" : "live"}`,
    `- started: ${report.startedAt}`,
    `- finished: ${report.finishedAt}`,
    `- ok: ${report.ok}`,
    `- calls: ${report.calls.length} (failed: ${failed})`,
    `- total cost: $${report.totalCostUsd.toFixed(4)}`,
  ];
  if (report.error) lines.push(`- error: ${report.error.name}: ${report.error.message}`);
  lines.push("", "| call | label | provider/model | status | cost | ms | session |", "|---|---|---|---|---|---|---|");
  for (const call of report.calls) {
    lines.push(
      `| ${call.callId} | ${call.label} | ${call.provider}/${call.model} | ${call.status} | ` +
        `$${call.costUsd.toFixed(4)} | ${call.durationMs} | ${call.sessionId} |`,
    );
  }
  lines.push("", "## Result", "```json", JSON.stringify(report.result, null, 2).slice(0, 20000), "```", "");
  return lines.join("\n");
}
```

- [ ] **Step 4: 寫 `run.ts`**

```ts
#!/usr/bin/env node
/**
 * CLI entry: node scripts/workflows/run.ts <workflow-file> [options]
 * Exit codes: 0 ok, 2 invalid args, 3 workflow failure, 4 budget exceeded, 5 permission blocked.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionBlocked, PaseoExecutor } from "./lib/executor-paseo.ts";
import { StubExecutor } from "./lib/executor-stub.ts";
import { ArgsInvalid, runWorkflow } from "./lib/runner.ts";
import { BudgetExceeded } from "./lib/sdk.ts";
import type { Executor, RunSettings } from "./lib/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNS_ROOT = path.join(HERE, ".runs");

interface CliArgs {
  readonly workflowPath: string;
  readonly argsJson?: string;
  readonly argsFile?: string;
  readonly cwd: string;
  readonly runsRoot: string;
  readonly executor: "paseo" | "stub";
  readonly concurrency: number;
  readonly budgetUsd: number | null;
  readonly dryRun: boolean;
  readonly autoPermit: boolean;
  readonly json: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly timeoutMs?: number;
}

const USAGE = `Usage: npm run workflow -- <workflow-file> [options]

Options:
  --args '<json>'        Inline JSON args (PowerShell quoting is painful; prefer --args-file)
  --args-file <path>     Read JSON args from a file
  --cwd <path>           Working directory for child agents (default: process.cwd())
  --provider <p>         Default provider for child agents
  --model <m>            Default provider/model for child agents
  --mode <mode>          Provider mode for child agents
  --timeout-ms <n>       Per-child timeout (default: 900000)
  --concurrency <n>      Max concurrent child agents (default: 4)
  --budget-usd <n>       Abort when spend exceeds n USD
  --dry-run              Walk the control flow without starting any agent
  --auto-permit          Auto-allow permission requests (default: refuse and stop)
  --executor <paseo|stub>  stub writes '{}' results with zero cost (default: paseo)
  --runs-dir <path>      Where to write run artifacts (default: scripts/workflows/.runs)
  --json                 Print the whole report as JSON`;

function parseArgv(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  const text = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const number = (name: string): number | undefined => {
    const value = text(name);
    return value === undefined ? undefined : Number(value);
  };
  const workflowPath = positional[0];
  if (!workflowPath) throw new Error(USAGE);
  return {
    workflowPath,
    argsJson: text("args"),
    argsFile: text("args-file"),
    cwd: text("cwd") ?? process.cwd(),
    runsRoot: text("runs-dir") ?? DEFAULT_RUNS_ROOT,
    executor: text("executor") === "stub" ? "stub" : "paseo",
    concurrency: number("concurrency") ?? 4,
    budgetUsd: number("budget-usd") ?? null,
    dryRun: flags.get("dry-run") === true,
    autoPermit: flags.get("auto-permit") === true,
    json: flags.get("json") === true,
    provider: text("provider"),
    model: text("model"),
    mode: text("mode"),
    timeoutMs: number("timeout-ms"),
  };
}

async function readArgs(args: CliArgs): Promise<unknown> {
  if (args.argsFile) return JSON.parse(await readFile(args.argsFile, "utf8")) as unknown;
  if (args.argsJson) return JSON.parse(args.argsJson) as unknown;
  return {};
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgv(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    return 2;
  }

  const settings: RunSettings = {
    concurrency: args.concurrency,
    budgetUsd: args.budgetUsd,
    dryRun: args.dryRun,
    autoPermit: args.autoPermit,
    defaults: {
      provider: args.provider ?? "opencode",
      model: args.model ?? "opencode/deepseek-v4.1-flash-free",
      ...(args.mode ? { mode: args.mode } : {}),
      timeoutMs: args.timeoutMs ?? 900_000,
    },
  };

  let executor: Executor | undefined;
  if (args.dryRun) executor = undefined;
  else if (args.executor === "stub") executor = new StubExecutor();
  else executor = new PaseoExecutor();

  try {
    const report = await runWorkflow({
      workflowPath: args.workflowPath,
      rawArgs: await readArgs(args),
      cwd: args.cwd,
      runsRoot: args.runsRoot,
      settings,
      ...(executor ? { executor } : {}),
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`workflow ${report.workflow} ${report.ok ? "OK" : "FAILED"} -> ${report.runDir}`);
      console.log(`calls: ${report.calls.length}  cost: $${report.totalCostUsd.toFixed(4)}`);
      if (report.error) console.error(`${report.error.name}: ${report.error.message}`);
    }

    if (report.ok) return 0;
    switch (report.error?.name) {
      case "ArgsInvalid":
        return 2;
      case "BudgetExceeded":
        return 4;
      case "PermissionBlocked":
        return 5;
      default:
        return 3;
    }
  } catch (cause) {
    if (cause instanceof ArgsInvalid) {
      console.error(cause.message);
      return 2;
    }
    if (cause instanceof BudgetExceeded) {
      console.error(cause.message);
      return 4;
    }
    if (cause instanceof PermissionBlocked) {
      console.error(cause.message);
      return 5;
    }
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    return 3;
  }
}

void main().then((code) => {
  process.exit(code);
});
```

- [ ] **Step 5: 寫測試 fixture `__tests__/support/fixtures/sample.workflow.ts`**

```ts
import { z } from "zod";
import { defineWorkflow } from "../../../lib/workflow.ts";

/** Test fixture: one fan-out of two children, then one synthesis child. */
export default defineWorkflow({
  description: "Fixture: two parallel children plus one synthesis child.",
  args: z.object({ question: z.string().min(1) }),
  run: async (args, { agent, parallel, phase }) => {
    const answers = await phase(
      "Fan-out",
      parallel([
        agent(`Answer briefly.\nQuestion: ${args.question}`, { label: "answer-a" }),
        agent(`Answer briefly and add one caveat.\nQuestion: ${args.question}`, { label: "answer-b" }),
      ]),
    );
    const summary = await phase(
      "Synthesis",
      agent(`Summarize these answers as JSON {"answer": string}.\n${JSON.stringify(answers)}`, {
        label: "summary",
      }),
    );
    return { question: args.question, answers, summary: summary.output };
  },
});
```

- [ ] **Step 6: 寫 `__tests__/executor-paseo.test.ts`**

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBlocked, PaseoExecutor } from "../lib/executor-paseo.ts";
import { MissingResult } from "../lib/sdk.ts";
import type { AgentRequest } from "../lib/types.ts";

interface Call {
  readonly args: readonly string[];
}

function makeRequest(runDir: string, overrides: Partial<AgentRequest> = {}): AgentRequest {
  const resultPath = path.join(runDir, "call.result.json");
  return {
    callId: "call-c1",
    label: "probe",
    provider: "opencode",
    model: "opencode/deepseek-v4.1-flash-free",
    cwd: runDir,
    runDir,
    timeoutMs: 60_000,
    autoPermit: false,
    taskFile: path.join(runDir, "call.task.md"),
    taskText: "do it",
    instruction: "read the task file",
    resultPath,
    ...overrides,
  };
}

describe("PaseoExecutor", () => {
  it("runs, waits, inspects and reads the result file", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"));
    const calls: Call[] = [];
    const executor = new PaseoExecutor({
      cli: { command: "node", baseArgs: [] },
      readResultAttempts: 1,
      cliRunner: async (_cli, args) => {
        calls.push({ args });
        if (args[0] === "run") return { stdout: '{"Id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}', stderr: "", code: 0 };
        if (args[0] === "inspect") {
          await writeFile(path.join(runDir, "call.result.json"), '{"ok":true}', "utf8");
          return {
            stdout: '{"Id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","Status":"idle","LastUsage":{"CostUsd":0.5},"PendingPermissions":[]}',
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    const result = await executor.runAgent(makeRequest(runDir));
    expect(result.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.output).toBe('{"ok":true}');
    expect(result.costUsd).toBe(0.5);
    expect(result.status).toBe("idle");
    expect(calls.map((call) => call.args[0])).toEqual(["run", "wait", "inspect"]);
    expect(calls[0]?.args).toContain("--background");
  });

  it("refuses to auto-allow and stops the child", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"));
    const calls: Call[] = [];
    const executor = new PaseoExecutor({
      cli: { command: "node", baseArgs: [] },
      readResultAttempts: 1,
      cliRunner: async (_cli, args) => {
        calls.push({ args });
        if (args[0] === "run") return { stdout: '{"Id":"id-1"}', stderr: "", code: 0 };
        if (args[0] === "inspect") {
          return {
            stdout: '{"Id":"id-1","Status":"idle","PendingPermissions":[{"id":"req-1","summary":"write"}]}',
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    await expect(executor.runAgent(makeRequest(runDir))).rejects.toBeInstanceOf(PermissionBlocked);
    expect(calls.some((call) => call.args[0] === "stop")).toBe(true);
    expect(calls.some((call) => call.args[0] === "permit")).toBe(false);
  });

  it("auto-allows when enabled, then continues", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"));
    const calls: Call[] = [];
    let inspected = 0;
    const executor = new PaseoExecutor({
      cli: { command: "node", baseArgs: [] },
      readResultAttempts: 1,
      cliRunner: async (_cli, args) => {
        calls.push({ args });
        if (args[0] === "run") return { stdout: '{"Id":"id-2"}', stderr: "", code: 0 };
        if (args[0] === "inspect") {
          inspected += 1;
          if (inspected === 1) {
            return { stdout: '{"Id":"id-2","Status":"idle","PendingPermissions":["write"]}', stderr: "", code: 0 };
          }
          await writeFile(path.join(runDir, "call.result.json"), "{}", "utf8");
          return { stdout: '{"Id":"id-2","Status":"idle","PendingPermissions":[]}', stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    const result = await executor.runAgent(makeRequest(runDir, { autoPermit: true }));
    expect(result.status).toBe("idle");
    expect(calls.some((call) => call.args[0] === "permit" && call.args[1] === "allow")).toBe(true);
  });

  it("continues an existing session with send instead of run", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"));
    const calls: Call[] = [];
    const executor = new PaseoExecutor({
      cli: { command: "node", baseArgs: [] },
      readResultAttempts: 1,
      cliRunner: async (_cli, args) => {
        calls.push({ args });
        if (args[0] === "inspect") {
          await writeFile(path.join(runDir, "call.result.json"), '{"ok":true}', "utf8");
          return { stdout: '{"Id":"prev-id","Status":"idle","PendingPermissions":[]}', stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    });

    await executor.runAgent(makeRequest(runDir, { sessionId: "prev-id" }));
    expect(calls.some((call) => call.args[0] === "send" && call.args.includes("--prompt-file"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("fails with MissingResult when the child writes nothing", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"));
    const executor = new PaseoExecutor({
      cli: { command: "node", baseArgs: [] },
      readResultAttempts: 1,
      resultRetryMs: 1,
      cliRunner: async (_cli, args) =>
        args[0] === "run"
          ? { stdout: '{"Id":"id-3"}', stderr: "", code: 0 }
          : { stdout: '{"Id":"id-3","Status":"idle","PendingPermissions":[]}', stderr: "", code: 0 },
    });

    await expect(executor.runAgent(makeRequest(runDir))).rejects.toBeInstanceOf(MissingResult);
  });

  it("reads the fixture the capture tool produced", async () => {
    const fixture = JSON.parse(
      await readFile(path.join(import.meta.dirname, "fixtures", "paseo-inspect.json"), "utf8"),
    ) as { stdout: string };
    expect(fixture.stdout).toContain("Status");
  });
});
```

- [ ] **Step 7: 寫 `__tests__/runner.test.ts`**

```ts
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StubExecutor } from "../lib/executor-stub.ts";
import { ArgsInvalid, runWorkflow } from "../lib/runner.ts";
import { makeFakeExecutor, makeRunSettings } from "./support/fake-executor.ts";

const SAMPLE = path.resolve(import.meta.dirname, "support", "fixtures", "sample.workflow.ts");

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "wf-run-"));
}

describe("runWorkflow", () => {
  it("dry-runs the whole control flow without calling the executor", async () => {
    const fake = makeFakeExecutor();
    const root = await tempRoot();
    const report = await runWorkflow({
      workflowPath: SAMPLE,
      rawArgs: { question: "1+1" },
      cwd: root,
      runsRoot: root,
      settings: makeRunSettings({ dryRun: true }),
      executor: fake.executor,
    });

    expect(fake.calls.length).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.calls.length).toBe(3);
    expect(report.calls.every((call) => call.sessionId.startsWith("dry-run:"))).toBe(true);
    const files = await readdir(report.runDir);
    expect(files).toContain("report.json");
    expect(files).toContain("report.md");
    expect(files).toContain("trace.jsonl");
  });

  it("rejects invalid args with ArgsInvalid naming the field", async () => {
    const root = await tempRoot();
    await expect(
      runWorkflow({
        workflowPath: SAMPLE,
        rawArgs: { question: "" },
        cwd: root,
        runsRoot: root,
        settings: makeRunSettings({ dryRun: true }),
        executor: new StubExecutor(),
      }),
    ).rejects.toThrowError(/question/);
    await expect(
      runWorkflow({
        workflowPath: SAMPLE,
        rawArgs: { question: "" },
        cwd: root,
        runsRoot: root,
        settings: makeRunSettings({ dryRun: true }),
        executor: new StubExecutor(),
      }),
    ).rejects.toBeInstanceOf(ArgsInvalid);
  });

  it("writes a failed report when a child fails", async () => {
    const fake = makeFakeExecutor({ failLabels: ["summary"] });
    const root = await tempRoot();
    const report = await runWorkflow({
      workflowPath: SAMPLE,
      rawArgs: { question: "why" },
      cwd: root,
      runsRoot: root,
      settings: makeRunSettings(),
      executor: fake.executor,
    });

    expect(report.ok).toBe(false);
    expect(report.error?.message).toContain("fake failure");
    const written = JSON.parse(await readFile(path.join(report.runDir, "report.json"), "utf8")) as {
      ok: boolean;
      calls: unknown[];
    };
    expect(written.ok).toBe(false);
    expect(written.calls.length).toBe(3);
  });

  it("completes with StubExecutor and records three calls", async () => {
    const root = await tempRoot();
    const report = await runWorkflow({
      workflowPath: SAMPLE,
      rawArgs: { question: "stub" },
      cwd: root,
      runsRoot: root,
      settings: makeRunSettings(),
      executor: new StubExecutor(),
    });

    expect(report.ok).toBe(true);
    expect(report.calls.length).toBe(3);
    expect(report.calls.every((call) => call.status === "stub")).toBe(true);
  });

  it("writes the task file that the child is told to read", async () => {
    const root = await tempRoot();
    const report = await runWorkflow({
      workflowPath: SAMPLE,
      rawArgs: { question: "files" },
      cwd: root,
      runsRoot: root,
      settings: makeRunSettings(),
      executor: new StubExecutor(),
    });

    const taskFile = path.join(report.runDir, "answer-a-c1.task.md");
    const content = await readFile(taskFile, "utf8");
    expect(content).toContain("answer-a-c1.result.json");
    expect(content).toContain("never modify files under src/");
  });

  it("rejects a module that is not a workflow", async () => {
    const root = await tempRoot();
    const bogus = path.join(root, "bogus.ts");
    await writeFile(bogus, "export default { nope: true };\n", "utf8");
    await expect(
      runWorkflow({
        workflowPath: bogus,
        rawArgs: {},
        cwd: root,
        runsRoot: root,
        settings: makeRunSettings({ dryRun: true }),
        executor: new StubExecutor(),
      }),
    ).rejects.toThrowError(/defineWorkflow/);
  });
});
```

- [ ] **Step 8: 跑測試確認全綠**

```bash
npm run test:workflows
npm run typecheck:scripts
```

Expected: 全部 PASS；tsc exit 0

- [ ] **Step 9: 用 stub 端到端乾跑一次 CLI（零成本）**

```bash
node scripts/workflows/run.ts scripts/workflows/__tests__/support/fixtures/sample.workflow.ts --args '{"question":"smoke"}' --executor stub --json
```

Expected: exit 0；輸出 JSON 內 `"ok": true`、`"calls"` 長度 3；`scripts/workflows/.runs/<stamp>-sample/` 內有 `report.md`

- [ ] **Step 10: Commit**

```bash
git add scripts/workflows/lib/executor-paseo.ts scripts/workflows/lib/executor-stub.ts scripts/workflows/lib/runner.ts scripts/workflows/run.ts scripts/workflows/__tests__/
git commit -m "feat(workflows): add paseo executor, stub executor, runner and cli"
```

---

### Task 5: 第一個真 workflow（Pine 語意覆蓋盤點）+ live smoke

**Blocked by:** Task 4

**Files:**
- Create: `scripts/workflows/workflows/pine-semantics-regression.workflow.ts`
- Create: `scripts/workflows/__tests__/pine-semantics-regression.test.ts`
- Create: `scripts/workflows/__tests__/live.paseo.test.ts`

**Interfaces:**
- Consumes: `defineWorkflow`（Task 3）、`runWorkflow` / `StubExecutor`（Task 4）
- Produces: `npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args-file <json>`；workflow args 契約 `{ areas?: string[]; verifierProvider?: string; verifierModel?: string; testFilter?: string }`

**Assumptions:** T0 — `areas` 的預設字串清單在檔案內為常數；verifier 一律用不同 provider 於作者（預設 `claude/claude-opus-5-5`）。

**Done when:**
- `npm run test:workflows -- pine-semantics` → PASS（只驗 args schema 與 chunk 切割的純函式，不呼叫 agent）
- `npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args '{}' --dry-run` → exit 0，報告的 `calls` 數量 = `areas 數 + areas 數 + 1`（fan-out + verify + synthesis），且不含任何真實 session id
- `npm run workflow -- <同上> --args-file <tmp.json> --executor stub` → exit 0、`ok: true`
- `WORKFLOW_LIVE=1 npm run test:workflows -- live` → PASS，且 `report.totalCostUsd === 0`
- 未設 `WORKFLOW_LIVE` 時 live 測試為 skipped（不是 failed）

- [ ] **Step 1: 寫 `scripts/workflows/workflows/pine-semantics-regression.workflow.ts`**

```ts
/**
 * Fan-out over Pine semantic areas: each child inspects src/pine + the existing
 * vitest suite and reports coverage, gaps and proposed tests as JSON. A verifier
 * on a different provider then re-checks the load-bearing claims. A final child
 * synthesizes one actionable list. Writes nothing into src/.
 */
import { z } from "zod";
import { defineWorkflow } from "../lib/workflow.ts";

const DEFAULT_AREAS = [
  "na propagation and na-safe comparisons",
  "var / varip initialization and rollback semantics",
  "series alignment and [] history references",
  "ta.* window helpers (sma/ema/rma/wma/stdev) warm-up and edge cases",
  "math.* rounding, integer division and float compare",
  "request.security / MTF data access",
  "str.* and type casting between int/float/bool/string",
  "plot/label/line/box drawing objects and their lifecycle",
];

const areaReport = z.object({
  area: z.string(),
  scannedFiles: z.array(z.string()),
  existingCoverage: z.array(z.object({ file: z.string(), symbol: z.string(), testFile: z.string() })),
  gaps: z.array(z.object({ symbol: z.string(), why: z.string(), evidence: z.string() })),
  proposedTests: z.array(z.object({ name: z.string(), why: z.string(), sketch: z.string() })),
  commands: z.array(z.object({ cmd: z.string(), exitCode: z.number(), summary: z.string() })),
});

const verdict = z.object({
  area: z.string(),
  verdict: z.enum(["confirmed", "refuted", "unclear"]),
  checked: z.array(z.object({ claim: z.string(), verdict: z.enum(["holds", "fails", "unclear"]), evidence: z.string() })),
  corrections: z.array(z.string()),
});

const synthesis = z.object({
  summary: z.string(),
  topGaps: z.array(z.object({ area: z.string(), symbol: z.string(), why: z.string(), confidence: z.enum(["high", "medium", "low"]) })),
  riskyClaims: z.array(z.string()),
  nextActions: z.array(z.string()),
});

const areaPrompt = (area: string, testFilter: string): string => `You are auditing one Pine Script semantic area in the OpenCharts repository.

Area: ${area}

Do this, in order:
1. List the modules under \`src/pine/\` that implement this area (read them; do not guess).
2. Search the existing test suite for coverage of this area (test files live under \`src/**/*.test.ts\`).
3. Run the relevant tests, for example: \`npx vitest run ${testFilter} --reporter=default\` and record the real exit code and a one-line summary. If a narrower filter is possible, prefer it.
4. Identify concrete gaps: a symbol, why the current tests cannot catch a regression there, and the exact file/line evidence you read.
5. Propose 1-3 tests that would fail today if that gap is real. Give the test name, why, and a short pseudocode sketch.

Rules: never modify any file under \`src/\`; read-only investigation; every claim needs a \`file:line\` style evidence string; if you cannot verify something, omit it rather than guessing.

Write your final JSON answer with exactly this shape:
{"area": string, "scannedFiles": string[], "existingCoverage": [{"file": string, "symbol": string, "testFile": string}], "gaps": [{"symbol": string, "why": string, "evidence": string}], "proposedTests": [{"name": string, "why": string, "sketch": string}], "commands": [{"cmd": string, "exitCode": number, "summary": string}]}`;

const verifyPrompt = (report: unknown): string => `You are an independent verifier. A previous agent produced this audit JSON:

${JSON.stringify(report, null, 2)}

Independently check its 2 most load-bearing claims (the gaps it says are real, and the test commands it reports). Read the files it cites and, when a command is cheap, run it yourself with \`npx vitest run <path>\`.

Rules: you may not trust the quoted evidence — confirm it against the repository; do not modify anything under \`src/\`; if a claim cannot be confirmed, mark it \`unclear\` rather than \`holds\`.

Answer with exactly: {"area": string, "verdict": "confirmed"|"refuted"|"unclear", "checked": [{"claim": string, "verdict": "holds"|"fails"|"unclear", "evidence": string}], "corrections": string[]}`;

const synthesisPrompt = (payload: unknown): string => `Here are verified Pine semantic audits for one repository:

${JSON.stringify(payload, null, 2)}

Produce one prioritized, actionable result for a maintainer who will fix these gaps next week.

Rules: keep only gaps whose verdict is confirmed or holds; list what you discarded; do not invent evidence; distinguish coverage holes from behavior bugs.

Answer with exactly: {"summary": string, "topGaps": [{"area": string, "symbol": string, "why": string, "confidence": "high"|"medium"|"low"}], "riskyClaims": string[], "nextActions": string[]}`;

export default defineWorkflow({
  description:
    "Audits Pine Script semantic coverage across the repo. Args: {areas?: string[], testFilter?: string, verifierProvider?: string, verifierModel?: string}. Fans out one read-only auditor per area, verifies claims with an independent provider, then synthesizes a prioritized gap list.",
  args: z.object({
    areas: z.array(z.string()).min(1).default(DEFAULT_AREAS),
    testFilter: z.string().default("src/pine"),
    verifierProvider: z.string().default("claude"),
    verifierModel: z.string().default("claude/claude-opus-5-5"),
  }),
  run: async (args, { agent, parallel, phase }) => {
    const audits = await phase(
      "Fan-out",
      parallel(
        args.areas.map((area) =>
          agent(areaPrompt(area, args.testFilter), { label: `audit:${area.slice(0, 40)}`, schema: areaReport }),
        ),
      ),
    );

    const usable = audits.flatMap((outcome) => (outcome.status === "success" ? [outcome.value.output] : []));

    const verifications = await phase(
      "Verify",
      parallel(
        usable.map((report) =>
          agent(verifyPrompt(report), {
            label: `verify:${String(report.area).slice(0, 40)}`,
            provider: args.verifierProvider,
            model: args.verifierModel,
            schema: verdict,
          }),
        ),
      ),
    );

    const result = await phase(
      "Synthesis",
      agent(synthesisPrompt({ audits, verifications }), {
        label: "synthesis",
        provider: args.verifierProvider,
        model: args.verifierModel,
        schema: synthesis,
      }),
    );

    return { args, audits, verifications, result: result.output };
  },
});
```

- [ ] **Step 2: 寫 `__tests__/pine-semantics-regression.test.ts`（純函式，不呼叫 agent）**

```ts
import { describe, expect, it } from "vitest";
import definition from "../workflows/pine-semantics-regression.workflow.ts";

describe("pine-semantics-regression args", () => {
  it("defaults to at least 6 areas", () => {
    const parsed = definition.args.parse({});
    expect(parsed.areas.length).toBeGreaterThanOrEqual(6);
    expect(parsed.testFilter).toBe("src/pine");
    expect(parsed.verifierModel).toContain("claude");
  });

  it("rejects an empty area list", () => {
    expect(definition.args.safeParse({ areas: [] }).success).toBe(false);
  });

  it("defaults the verifier to a different provider than the worker default", () => {
    const parsed = definition.args.parse({});
    expect(parsed.verifierProvider).not.toBe("opencode");
  });
});
```

- [ ] **Step 3: 跑測試與兩種乾跑**

```bash
npm run test:workflows -- pine-semantics
npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args '{}' --dry-run
```

Expected: PASS；乾跑的 `calls` 數量 = `areas(8) + 8 + 1 = 17`（此數字為預設開銷，寫進報告供估價）

- [ ] **Step 4: 寫 `__tests__/live.paseo.test.ts`（預設 skip）**

```ts
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PaseoExecutor } from "../lib/executor-paseo.ts";
import { runWorkflow } from "../lib/runner.ts";
import { makeRunSettings } from "./support/fake-executor.ts";

const SAMPLE = path.resolve(import.meta.dirname, "support", "fixtures", "sample.workflow.ts");

describe.skipIf(process.env.WORKFLOW_LIVE !== "1")("live paseo round trip", () => {
  it("runs two children and one synthesis on the free provider", { timeout: 600000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-live-"));
    const report = await runWorkflow({
      workflowPath: SAMPLE,
      rawArgs: { question: "Reply with the single word: ok" },
      cwd: root,
      runsRoot: root,
      settings: makeRunSettings({ concurrency: 2, defaults: { provider: "opencode", model: "opencode/deepseek-v4.1-flash-free", timeoutMs: 420_000 } }),
      executor: new PaseoExecutor(),
    });

    expect(report.ok).toBe(true);
    expect(report.calls.length).toBe(3);
    expect(report.totalCostUsd).toBe(0);
  });
});
```

- [ ] **Step 5: 執行 live smoke（花 0 元，但會建立 3 個 free agent）**

```bash
$env:WORKFLOW_LIVE="1"; npm run test:workflows -- live; Remove-Item Env:WORKFLOW_LIVE
```

Expected: PASS；`scripts/workflows/.runs/` 之外無新檔；若失敗，先看該 run 目錄的 `<callId>.meta.json` 與 `trace.jsonl`，再對照 Fact Annex 修正

- [ ] **Step 6: 確認 skip 行為正常**

```bash
npm run test:workflows -- live
```

Expected: `1 skipped`（不是 failed）

- [ ] **Step 7: Commit**

```bash
git add scripts/workflows/workflows/pine-semantics-regression.workflow.ts scripts/workflows/__tests__/pine-semantics-regression.test.ts scripts/workflows/__tests__/live.paseo.test.ts
git commit -m "feat(workflows): add pine semantics coverage audit workflow with live smoke"
```

---

### Task 6: 第二個 workflow（Pine 測試缺口獵取）+ README + 最終驗收

**Blocked by:** Task 5

**Files:**
- Create: `scripts/workflows/workflows/pine-coverage-hunt.workflow.ts`
- Create: `scripts/workflows/README.md`
- Create: `scripts/workflows/__tests__/pine-coverage-hunt.test.ts`

**Interfaces:**
- Consumes: 同 Task 5
- Produces: `pine-coverage-hunt` workflow（args `{ modules?: string[]; testFilter?: string; verifierProvider?: string; verifierModel?: string }`），以及對外文件 `scripts/workflows/README.md`

**Assumptions:** T0 — scratch 測試檔一律寫在 `<runDir>/scratch/`（在 `scripts/workflows/**` 之下，因此被 `vitest.workflows.config.ts` 的 include 涵蓋）；產出的 patch 只寫 `<runDir>/proposed-tests.patch`。

**Done when:**
- `npm run test:workflows -- pine-coverage` → PASS
- `npm run workflow -- scripts/workflows/workflows/pine-coverage-hunt.workflow.ts --args '{}' --dry-run` → exit 0
- `npm run workflow -- <同上> --executor stub` → exit 0（`ok: true`）
- `scripts/workflows/README.md` 存在，且含：快速開始 6 條指令、primitive 表、artifact 表、exit code 表、成本與延遲限制、「這不是 runtime 元件」的顯式聲明
- 最終驗收：A1–A8 全部可重現（見 §0）
- `git status --short` 內沒有 `src/**` 的改動

- [ ] **Step 1: 寫 `scripts/workflows/workflows/pine-coverage-hunt.workflow.ts`**

```ts
/**
 * Hunts missing tests in src/pine: one child per module drafts candidate tests,
 * an independent verifier proves each candidate actually fails on current code
 * (running it in <runDir>/scratch/), and a final child produces one patch file
 * plus a prioritized list. Never writes into src/.
 */
import { z } from "zod";
import { defineWorkflow } from "../lib/workflow.ts";

const DEFAULT_MODULES = [
  "src/pine/engine.ts",
  "src/pine/interpreter.ts",
  "src/pine/lexer.ts",
  "src/pine/parser.ts",
  "src/pine/mtf.ts",
  "src/pine/pinetsShim.ts",
  "src/pine/pinetsStateless.ts",
  "src/pine/pinetsStatefulA.ts",
  "src/pine/pinetsStatefulB.ts",
  "src/pine/pinetsComposite.ts",
];

const candidateReport = z.object({
  module: z.string(),
  exportedSymbols: z.array(z.string()),
  untestedBranches: z.array(z.object({ symbol: z.string(), why: z.string(), evidence: z.string() })),
  candidates: z.array(z.object({ name: z.string(), targetSymbol: z.string(), sketch: z.string(), expectedInitialFailure: z.string() })),
  notes: z.string(),
});

const verifiedReport = z.object({
  module: z.string(),
  results: z.array(z.object({ name: z.string(), reproducible: z.boolean(), evidence: z.string() })),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});

const plan = z.object({
  summary: z.string(),
  accepted: z.array(z.object({ module: z.string(), name: z.string(), value: z.enum(["high", "medium", "low"]) })),
  patchPath: z.string(),
  followUps: z.array(z.string()),
});

const discoverPrompt = (module: string): string => `You are hunting missing unit tests for exactly one module in the OpenCharts repository.

Module: ${module}
Existing test convention: tests live in \`src/**/*.test.ts\` and run with \`npx vitest run <path>\`.

Do this:
1. Read the module in full and list its exported symbols.
2. For each symbol, find whether any existing test exercises it (search \`src/**/*.test.ts\`). Cite \`file:line\` evidence.
3. Identify untested branches: a symbol or branch, why it is untested, and the evidence.
4. For at most 2 branches, draft a test candidate: the test name, the target symbol, a short sketch (imports + arrange/act/assert), and the specific assertion that should fail on today's code.

Rules: read-only; never modify anything under \`src/\`; no invented APIs — every symbol you name must exist in the file you read.

Answer with exactly: {"module": string, "exportedSymbols": string[], "untestedBranches": [{"symbol": string, "why": string, "evidence": string}], "candidates": [{"name": string, "targetSymbol": string, "sketch": string, "expectedInitialFailure": string}], "notes": string}`;

const verifyPrompt = (module: string, candidates: unknown, runDir: string): string => `You are an independent verifier for proposed tests in the OpenCharts repository.

Module: ${module}
Candidates to verify:
${JSON.stringify(candidates, null, 2)}

Do this for each candidate:
1. Write a real test file at \`${runDir}/scratch/verify.test.ts\` that contains your best attempt at the candidate (you may rewrite it as needed; imports must use relative paths back into the repository).
2. Run it: \`npx vitest run --config vitest.workflows.config.ts ${runDir}/scratch/verify.test.ts\`.
3. Record whether it fails for the reason the author claimed (that is what "reproducible" means here) and paste the decisive output line as evidence.
4. If it cannot be made to fail, list it under \`rejected\` with the reason.

Rules: only write inside \`${runDir}/scratch/\`; one file per verification run; never modify \`src/\`.

Answer with exactly: {"module": string, "results": [{"name": string, "reproducible": boolean, "evidence": string}], "rejected": [{"name": string, "reason": string}]}`;

const planPrompt = (payload: unknown, runDir: string): string => `Here are discovered test candidates and their independent verification:

${JSON.stringify(payload, null, 2)}

Produce one maintainer-ready result.

Do this:
1. Keep only candidates whose verification says \`reproducible: true\`.
2. Write a unified-diff patch that adds the accepted tests to the correct existing test files under \`src/\` — but write the patch text to \`${runDir}/proposed-tests.patch\`, never apply it.
3. Summarize what you accepted, what you rejected and why, and the first three follow-ups.

Answer with exactly: {"summary": string, "accepted": [{"module": string, "name": string, "value": "high"|"medium"|"low"}], "patchPath": "${runDir}/proposed-tests.patch", "followUps": string[]}`;

export default defineWorkflow({
  description:
    "Hunts missing tests in src/pine. Args: {modules?: string[], verifierProvider?: string, verifierModel?: string}. One discoverer per module, one independent verifier that proves each candidate fails on current code, then one planner that writes a patch file (never applied).",
  args: z.object({
    modules: z.array(z.string()).min(1).default(DEFAULT_MODULES),
    verifierProvider: z.string().default("claude"),
    verifierModel: z.string().default("claude/claude-opus-5-5"),
  }),
  run: async (args, { agent, parallel, phase }) => {
    const discovered = await phase(
      "Discover",
      parallel(
        args.modules.map((module) =>
          agent(discoverPrompt(module), { label: `discover:${module.split("/").pop() ?? module}`, schema: candidateReport }),
        ),
      ),
    );

    const verified = await phase(
      "Verify",
      parallel(
        discovered.map((outcome, index) => {
          const module = args.modules[index] ?? "unknown";
          const candidates = outcome.status === "success" ? outcome.value.output.candidates : [];
          return agent(verifyPrompt(module, candidates, "<RUN_DIR>"), {
            label: `verify:${module.split("/").pop() ?? module}`,
            provider: args.verifierProvider,
            model: args.verifierModel,
            schema: verifiedReport,
          });
        }),
      ),
    );

    const planResult = await phase(
      "Synthesis",
      agent(planPrompt({ discovered, verified }, "<RUN_DIR>"), {
        label: "plan",
        provider: args.verifierProvider,
        model: args.verifierModel,
        schema: plan,
      }),
    );

    return { args, discovered, verified, plan: planResult.output };
  },
});
```

> **注意（executor 必讀）**：上面的 `<RUN_DIR>` 佔位在執行時必須換成真實路徑。做法是 `run` 的第二個參數 `sdk` 之外再取 `runDir`——**Task 6 Step 2 先做這個小重構，不得留著 `<RUN_DIR>` 字串出貨**。

- [ ] **Step 2: 把 `runDir` 傳進 workflow（小重構，三處改動）**

原（`scripts/workflows/lib/sdk.ts`）：

```ts
export interface Sdk {
  agent<A>(
```

改為：

```ts
export interface Sdk {
  /** This run's artifact directory (absolute). Agents may write scratch files here. */
  readonly runDir: string;
  agent<A>(
```

並在 `makeSdk` 的 `return` 前加一行，讓回傳物件帶上 `runDir`：

```ts
  return { runDir: context.runDir, agent: agent as Sdk["agent"], parallel, phase, textPrompt };
```

（原行為 `return { agent: agent as Sdk["agent"], parallel, phase, textPrompt };`）

測試要同步：`scripts/workflows/__tests__/sdk.test.ts` 新增一條斷言 `expect(sdk.runDir).toBe(".test-run")`。

然後把 workflow 中三個 `<RUN_DIR>` 換成 `sdk.runDir`（`run: async (args, sdk) =>` 形式，取 `const { agent, parallel, phase, runDir } = sdk;`）。

- [ ] **Step 3: 寫 `__tests__/pine-coverage-hunt.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import definition from "../workflows/pine-coverage-hunt.workflow.ts";

describe("pine-coverage-hunt args", () => {
  it("defaults to the src/pine module list", () => {
    const parsed = definition.args.parse({});
    expect(parsed.modules.length).toBeGreaterThanOrEqual(8);
    expect(parsed.modules.every((module) => module.startsWith("src/pine/"))).toBe(true);
  });

  it("rejects an empty module list", () => {
    expect(definition.args.safeParse({ modules: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 4: 跑測試 + 兩種乾跑**

```bash
npm run test:workflows
npm run workflow -- scripts/workflows/workflows/pine-coverage-hunt.workflow.ts --args '{}' --dry-run
npm run workflow -- scripts/workflows/workflows/pine-coverage-hunt.workflow.ts --executor stub
```

Expected: 全綠；兩個 CLI 都 exit 0

- [ ] **Step 5: 寫 `scripts/workflows/README.md`**

內容必須包含（照抄這一節的骨架，填入實測數字）：

```markdown
# Workflow harness（scripts/workflows）

開發期的多代理編排層。可版控的 `.workflow.ts` + 本機 Paseo 當執行層。
**這不是 OpenCharts 的 runtime 元件**：不進 vite bundle、不被 `src/**` 匯入、刪掉整個目錄即回復原狀。

## 快速開始

```powershell
paseo status                                  # daemon 必須在跑
npm run test:workflows                        # 純單元測試，0 成本
npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args '{}' --dry-run
npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args-file .\args.json --executor stub
npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args-file .\args.json
```
（最後一條才是真的叫 agent）

## Primitives

| primitive | 語意 |
|---|---|
| `defineWorkflow({description, args, run})` | 一個 `.workflow.ts` 的契約；`args` 是 zod schema，`run` 收到已驗證的 args 與 `sdk` |
| `agent(text, {label, sessionId, schema, provider, model, mode, timeoutMs})` | 建立或續接一個 child agent；有 `schema` 時驗證其 JSON 結果 |
| `parallel(tasks)` | 併行執行，**保序**回傳 `Outcome[]`，個別失敗變成 `{status:'error'}`；預算超限會往外拋 |
| `phase(name, task)` | 命名階段，寫入 trace |
| `sdk.runDir` | 本次 run 的產物目錄（絕對路徑），child 可在其 `scratch/` 寫暫存 |

## Artifacts（每次 run 一個目錄）

| 檔案 | 內容 |
|---|---|
| `run.json` | workflow 路徑、args、settings、開始時間 |
| `trace.jsonl` | 每個 phase / call 的開始結束、成本、session id |
| `<callId>.task.md` | 該 child 收到的完整任務（含結果檔絕對路徑） |
| `<callId>.result.json` | child 寫回的 JSON（harness 的唯一結果來源） |
| `<callId>.meta.json` | provider/model/status/cost/duration |
| `report.json` / `report.md` | 本次 run 的完整報告與人可讀表格 |

## Exit codes

| code | 意義 |
|---|---|
| 0 | 成功 |
| 2 | args 不合法（zod issues） |
| 3 | workflow 失敗（child 錯誤、結果檔缺失、schema 不符） |
| 4 | 超出 `--budget-usd` |
| 5 | child 卡在權限請求且未開 `--auto-permit` |

## 限制

- 一個 child agent 約 10–60 秒；這是開發期工具，不是低延遲 runtime。
- 只有 `WORKFLOW_LIVE=1` 時才跑 live 測試；`paseo` daemon 沒跑時所有 live 命令失敗。
- `--auto-permit` 預設關閉：遇到權限請求會停止並回報，不會默默放行。
- 成本：預設 worker 是 free model（$0）；verifier/synthesis 用 `claude/claude-opus-5-5` 會計費，`--budget-usd` 是硬門檻。
- harness 與 child 都不會寫入 `src/`；產出是報告與 patch 檔。
```

- [ ] **Step 6: 最終驗收（逐條對照 §0 A1–A8）**

```bash
git status --short                                                  # 不得有 src/** 變更
git diff --stat package.json                                        # 只有 scripts 與 devDependencies
npm run test 2>&1 | Select-Object -Last 5                           # 0 failed
npm run typecheck                                                   # exit 0
npm run test:workflows                                              # 全綠
npm run workflow -- scripts/workflows/workflows/pine-semantics-regression.workflow.ts --args '{}' --dry-run
```

Expected: A1–A8 全部成立；把每條的實際輸出貼進 PR 描述

- [ ] **Step 7: Commit**

```bash
git add scripts/workflows/README.md scripts/workflows/workflows/pine-coverage-hunt.workflow.ts scripts/workflows/__tests__/pine-coverage-hunt.test.ts scripts/workflows/lib/sdk.ts scripts/workflows/__tests__/sdk.test.ts
git commit -m "feat(workflows): add pine coverage hunt workflow, runDir on sdk and harness readme"
```

---

## 風險與 Revisit 清單（執行時遇到就停下回報）

| 風險 | 徵兆 | 處理 |
|---|---|---|
| Paseo 的 JSON 欄位與 Fact Annex 不符 | Task 1 Step 9 核對失敗 | 就地更新 Fact Annex 的表格，再改解析器；不要改測試遷就 |
| free model 不照格式寫結果檔 | `InvalidOutput` 連續 ≥2 次，或 `MissingResult` | 換 `--provider omp`；再不行啟用 D2 的 Revisit（改用 `--output-schema`） |
| `@types/node` 讓既有 typecheck 出現新錯誤 | `npm run typecheck` 錯誤數增加 | 保留 `@types/node`，但在 `tsconfig.scripts.json` 用 `types: ["node"]`，並在 root tsconfig 加 `"types": []`（需先確認 src 不依賴 DOM 之外的 ambient types） |
| 平行呼叫把 Paseo daemon 打爆 | `paseo wait` 逾時、inspect 連續失敗 | 降 `--concurrency` 到 2，並把每次 poll 的 `pollTimeoutSeconds` 提到 60 |
| verifier 與 worker 同 provider | 報告看不出對抗效果 | 檢查 workflow 的 `verifierProvider` 預設值；`agent(..., {provider})` 必須真的傳到 `AgentRequest` |

## Self-Review

**1. Spec coverage（對照 §0）**

| 需求 | 覆蓋 task |
|---|---|
| 可重跑 CLI（in-scope 1） | Task 4 Step 4（`run.ts`）、Task 4 Step 9 |
| 五個 primitive（2） | Task 3 Step 7、Task 6 Step 2（`sdk.runDir`） |
| 兩個真 workflow（3） | Task 5 Step 1、Task 6 Step 1 |
| dry-run / concurrency / budget / auto-permit / json（4） | Task 4 Step 4、Task 4 Step 7、Task 3 Step 7（預算測試） |
| run 產物（5） | Task 3 Step 7（task/result/meta）、Task 4 Step 3（run/trace/report） |
| 測試 + live smoke（6） | Task 2、3、4、5、6 的測試步驟，Task 5 Step 4 |
| 驗收判準 A1–A8 | Task 4 Step 8（A5/A6）、Task 5 Step 3（A4/A7 的 grep）、Task 6 Step 6（A1/A2/A3/A8） |
| 環境需求與自檢 | 「執行環境」章節 |

**1b. Date check**：檔名 `2026-10-16-workflow-harness-replica.md` ✅；header 有 `> **日期：** 2026-10-16` ✅

**2. Placeholder scan**：全文無 TBD/TODO；唯一的 `<RUN_DIR>` 佔位由 Task 6 Step 2 明確要求以 `sdk.runDir` 取代，並附上改動前後的程式碼與測試斷言。

**3. Type consistency**：`AgentRequest` / `RawAgentResult` / `Executor` / `AgentResult` / `Outcome` / `RunSettings` / `RunContext` / `CallRecord` / `RunReport` 只在 Task 3 Step 1 定義一次；`PaseoExecutor`、`PermissionBlocked`、`StubExecutor`、`ArgsInvalid`、`loadWorkflow`、`runWorkflow` 名稱在 Task 4 與後續 task 一致。`MissingResult(sessionId, resultPath)` 由 Task 3 定義、Task 4 使用，參數順序一致。

**4. Anchor scan**：唯一編輯既有檔案內容的步驟是 Task 6 Step 2（`lib/sdk.ts` 的 `export interface Sdk { agent<A>(` 與 `return { agent: agent as Sdk["agent"], ... }`），兩者都附原文、替換文與可 grep 的錨字串。其餘步驟皆為新增檔案。

**5. Decision scan**：D1 已由使用者確認；D2/D4/D5 為 T1 且有候選、準則、否決原因與 revisit trigger；D3 為 T2 並已於 2026-10-16 由使用者確認（選 B）。T1+T2 共 5 個，未超限。

**6. Done-when scan**：每個 task 的 `Done when` 皆為可執行指令或可觀察狀態，並至少含一個失敗/邊界案例（args 不合法、child 失敗、權限被擋、結果檔缺失、預算超限）。

**7. Edge fit**：邊只有三條且各自對應明確的 `Produces`/`Consumes`（Task 2→4、Task 3→4、Task 4→5、Task 5→6），無需 Jev 逐條複核。

## Execution Handoff

Plan 已存到 `docs/superpowers/plans/2026-10-16-workflow-harness-replica.md`。

**T2 決策已於 2026-10-16 由使用者確認（選 B），可直接執行：**

| ID | 選擇 | 一句理由 |
|---|---|---|
| D3 | B：預設 `--mode default`，遇到權限請求時由 `--auto-permit` 決定允許或中止 | 需要使用者確認「無人值守時是否允許自動放行 child agent 的工具權限」 |

三種執行方式（擇一）：

1. **Subagent-Driven（建議）** — 每個 task 一個新 subagent，task 之間由主 agent review；Task 1 的 fixtures 與 Task 4 的 stub 乾跑可作為早期安全網。
2. **Inline Execution** — 在同一 session 依序跑，每個 task 結束做 checkpoint。
3. **交由 Opus 5.5 執行** — 直接把本檔（含 Fact Annex 與 §0 驗收判準）交給 Opus 5.5，但要求它：只執行、不重新決策（`D<n>` 要改須留下 ruling）、Task 1 Step 9 的 Fact Annex 更正必須回寫本檔、A1–A8 逐條附輸出。
