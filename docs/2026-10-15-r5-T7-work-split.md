# T7 分工與「我不跑的東西」清單（2026-10-15 19:4x，給另一邊看）

## 0. 我目前在跑什麼（會佔 CPU）

| 項 | 內容 | 影響 |
|---|---|---|
| **1 個** tsx 程序 | `npx tsx scratch/perf/iso/t7-instrument.mjs --bars 500 --ticks 1` | 500 根 ×（build ＋ cold ＋ advance ＋ cold ＋ shadow）≈ **數分鐘 CPU** |

除這一個之外，我**沒有**其他長時間程序。我不會再起第二個重的。

## 1. 我不會跑／不會碰的東西

| 不跑 | 為什麼 |
|---|---|
| **任何 `src/pine` 的寫入**（edit / cp / patch） | 你們在動它；我全在 `scratch/perf/iso/` 自己的副本上做 |
| `git checkout b9fcd81 -- src/pine`、`git restore`、`git stash` | 會清掉未提交成果；且現在樹是混種，砍下去只會更亂 |
| **`scripts/autorun/verify-restore.ps1`** | 它會覆寫 `src/pine`；在還有 writer 時跑＝污染對方量測。**等所有 writer 停手再跑** |
| `npx vitest run src/pine`、`tsc --noEmit`、`npm run lint`、`npm run build` | (a) 與正在改 `src/pine` 的人打架；(b) 樹上有 9 條 `[T7 DEBUG]` console.log，現在跑必紅、數字無意義 |
| **`pine-bench.mjs`（T3／T4 的靜機 A3／A6 複測）** | 這兩項**定義上要求安靜機**；我這條 500 根診斷正在佔 CPU → **現在跑 T3/T4 的數字一定不可信** |
| 5000 根（T2 殘留項、T8 Θ(B²)） | 之前就 timeout；不重試 |
| kill / 重啟任何程序（含 `pi`、`node`、`npx vite`） | 不是我的 |
| `npm i` / 任何安裝 | 專案紅線 |

## 2. 給另一邊的紅線（碰撞點）

1. **`src/pine` 現在是混種樹，不是基線也不是優化樹。**
   `git diff b9fcd81 -- src/pine` 只有 `context.ts` +2、`interpreter.ts` +30/−5；
   但 `mtf.ts` = 2246 行、無 `cwPeak`（= b9fcd81）。**任何「拿現在這棵樹量出來的數字」都不可信。**
2. **`src/pine` 有 9 條 debug 輸出留在原始碼裡**，會污染量測、也會讓 gate 掛：
   `interpreter.ts:3405,3407,3408,3411,3524,3526,3527`、`context.ts:268,272`。不管誰收尾，**這些該先移除**。
3. **`b9fcd81` 本身就含整套增量引擎**（`mtf.ts` 有 `sessionStore`:246、`SpecSnap`:2071、`snapSpec`:2103、`restoreSpec`）。
   文件寫的「b9fcd81（優化前）」＝「最後一個 commit」，**不等於「沒有增量引擎」**。別據此推論。
4. **不要同時跑靜機量測（T3/T4）**：我這條 500 根診斷在跑，會把靜機條件弄壞。要嘛等我結束，要嘛告訴我停。
5. 我在 19:2x 觀察到 `src/pine/interpreter.ts` 的 `incEligible` 從
   `parsed.decl?.type !== 'strategy'` 變成 `return true; // S1: allow strategy scripts` —— 若那不是你們刻意做的，值得查一下。

## 3. 安全的還原來源（我逐檔驗過）

| 路徑 | 狀態 |
|---|---|
| `%TEMP%\r5-snapshot-B-20261015-1800\pine` | ✅ 真優化樹。`mtf.ts` md5 `79d67c66b8e19349b4fdaeeaef5d3d79`、2411 行、`cwPeak`×4；`md5-before.txt` 120 條記的也是優化雜湊 |
| `scratch/perf/r5-pine-optimized-b9/pine` | ✅ 與上面**逐檔相同**（我比對過，0 差異）；在 repo 內、不怕 `%TEMP%` 被清 |
| `scratch/perf/iso/pine` | ✅ 我的工作副本，目前與上面逐檔相同（`mtf.ts` md5 同上）。我之後的編輯只會動這裡 |
| `%TEMP%\t7-optimized-1800\pine` | ❌ **壞快照**：名字騙人，內容是基線（`mtf.ts` 2246 行、`cwPeak` 0） |

`logs/r5-snapshot-latest.txt` → 指向 B 快照（正確那份）。`scripts/autorun/verify-restore.ps1` 會優先讀這個指標檔、拿快照自帶的 `md5-before.txt` 比對後還原 → **它的自檢不會假通過**（我逐行讀過實作）。

## 4. 我在哪條線上做什麼

- **T7 診斷與修**：全部在 `scratch/perf/iso/`（自己的 `pine/` 副本）。跑完只交一個 **patch**，不直接改 `src/pine`。
- 我的 T7 根因與修復方向：`docs/2026-10-15-r5-T7-rootcause.md`
- 儀器：`scratch/perf/iso/t7-instrument.mjs`（＝`scratch/perf/t7-instrument.mjs` 的隔離版）
- 探索 brief（6 個 front 的共同前提）：`scratch/perf/t7/EXPLORE-BRIEF.md`

## 5. 一句話

**我唯讀 `src/pine`、只跑 `scratch/perf/iso/` 的東西、只交 patch。**
請你們決定 `src/pine` 由誰收尾；在你們停手前我不會跑 `verify-restore.ps1`、不會跑 gate、不會碰 `src/pine`。
