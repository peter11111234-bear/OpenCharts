# REAL PLAN, 直譯器拆檔 第 1 階段（純搬移，不改邏輯）

- 寫計畫：Opus 5.5（2026-10-22）。執行：MiniMax 3。驗收：Opus 5.5。
- 基準 commit：`ec232c7`。`src/pine/interpreter.ts` 的 LF 正規化 sha256＝`5627bf5b708a55bbbace983e8f535c826ef3aebbf462d889d00b28b2c19bc7ab`。
- 這份計畫已由 Opus 在隔離 worktree 完整試跑過一次：拆分腳本、型別檢查、`src/pine`＋`scripts` 的 vitest（73 檔／1039 個全過）、匯出名單比對、篡改偵測，全部通過。

## 0. 目標與範圍

把 `interpreter.ts` 裡**不碰直譯器狀態的純函式**搬到兩個新檔，約 235 行，讓之後的 F2 等工作不用在 4000 行的檔案裡改。

| 新檔 | 搬進去的東西 |
|---|---|
| `src/pine/astUtil.ts` | `isNum`、`numVal`、`astChildren`、`stmtMayExitTop`、`walkNodes` |
| `src/pine/scriptDecl.ts` | `declArgValue`、`declTitle`、`declShortTitle`、`declOverlay`、`declProps`、`staticLit`、`collectInputs` |

`interpreter.ts` 會從 4083 行變成約 3850 行，對外匯出的名稱**一個都不變**（`astChildren`、`collectInputs` 由 `interpreter.ts` 轉出，現有的 import 不用改）。

**不在範圍內（禁止做）：**
- 不改任何邏輯、不改名、不重排、不格式化、不「順手」修東西。
- 不碰 `src/pine` 以外的任何檔，也不碰 `src/pine` 裡其他檔。
- 不跑 `npx eslint`（專案 ESLint 設定本來就壞）。
- 不 commit、不 push。驗收通過後由 Opus 或使用者 commit。
- 第 2 階段（增量執行 incremental）和第 3 階段（compile＋JIT）**不做**，等第 1 階段驗收後另外決定。

## 1. 開工前檢查（任何一項不符就停下來回報，不要自己修）

在 `C:\Users\bear9\OpenCharts` 執行：

```bash
git rev-parse --short HEAD
git status --short src/pine
ls src/pine/astUtil.ts src/pine/scriptDecl.ts
```

預期：
1. HEAD 是 `ec232c7` 或它之後的 commit，且 `git diff --quiet ec232c7 HEAD -- src/pine` 成功（exit 0）。
2. `git status --short src/pine` 除了 `?? src/pine/graphify-out/` 以外沒有東西。
3. `ls` 回報兩個檔都**不存在**。

時段：**只能在不開盤時段做**（日盤 08:45–13:45、夜盤 15:00–05:00 以外）。`/vela` 開著時改 `src/pine` 會觸發熱更新。

## 2. 執行（只跑腳本，不手改程式碼）

先量拆分前的效能基準（同一時段、同一台機器，之後才有得比）：

```bash
cd C:/Users/bear9/OpenCharts
npx tsx scripts/perf/pine-bench.mjs --script src/pine/TRIS390.pine --bars 500 --repeat 5 --label split-p1-before --md
```

再執行拆分：

```bash
python -I scripts/refactor/split_interpreter.py
```

預期輸出（三行，數字要一樣）：

```
src/pine/astUtil.ts: 119 lines moved
src/pine/scriptDecl.ts: 116 lines moved
src/pine/interpreter.ts: 4084 -> 3850 lines
```

腳本若印出 `split_interpreter: ...` 錯誤並結束，**不要改腳本、不要手動搬**，直接把錯誤訊息回報。最常見的是 `interpreter.ts is not the pinned base`，代表有人在基準之後改過它。

## 3. 驗證（全部要過）

依序執行，每一步都把輸出的最後幾行貼進報告：

```bash
cd C:/Users/bear9/OpenCharts

# 3.1 逐行比對：搬過去的每一行都和基準一字不差，沒有遺失、沒有重複
python -I scripts/refactor/verify_split.py
# 預期：VERIFY OK: moved verbatim, no lines lost or duplicated, no other src/pine changes

# 3.2 型別檢查
npx tsc --noEmit
# 預期：沒有任何輸出，exit 0

# 3.3 對外匯出名單不變
npx tsx -e "import('./src/pine/interpreter.ts').then(m=>console.log(Object.keys(m).sort().join(',')))"
# 預期一字不差：
# PineRuntimeError,__callHistWrites,__compileCalls,__compiledKinds,__evalNodeCounts,__pineJitStats,astChildren,callsiteKey,collectInputs,evalBlock,evalExpr,incAdvance,incRun,incRunStart,pineStr,registerMtf,resolvesFromCtx,restoreCtxState,runScript,snapCtxState,yieldStats

# 3.4 全套測試（約 6 分鐘）
npx vitest run
# 預期：Test Files 105 passed (105)、Tests 1360 passed (1360)

# 3.5 效能抽查（只看有沒有明顯變慢）
npx tsx scripts/perf/pine-bench.mjs --script src/pine/TRIS390.pine --bars 500 --repeat 5 --label split-p1-after --compare bench/pine/split-p1-before.json --md
```

3.5 說明：這台機器量測雜訊大（同設定連跑可差 20% 以上）。只有 `direct` 的 `run` median 比 `split-p1-before` 慢 **30% 以上**才算異常，要回報，不要自己調。

任何一步失敗：**停下來回報完整錯誤**，不要嘗試修正，也不要還原（Opus 要看現場）。

## 4. 報告格式

寫到 `docs/superpowers/plans/2026-10-22-interpreter-split-phase1.report.md`：

```
# 直譯器拆檔 第 1 階段 執行報告
- 執行者：MiniMax 3
- 時間：
- 開工前檢查：HEAD=…，src/pine 狀態=…，新檔不存在=是/否
- 步驟 2 輸出：（貼三行）
- 3.1 verify：（貼輸出）
- 3.2 tsc：（exit code ＋輸出）
- 3.3 匯出名單：（貼輸出）與預期相同=是/否
- 3.4 vitest：（貼 Test Files / Tests 兩行）
- 3.5 bench：（貼 before／after 的 direct run median 與 --compare 的差異 %）
- 有沒有做計畫以外的事：沒有／有（列出）
```

## 5. 驗收（Opus）

1. 重跑 3.1–3.3，結果要和報告一致。
2. `git status --short` 只多出 `src/pine/astUtil.ts`、`src/pine/scriptDecl.ts`、`interpreter.ts` 的修改、報告檔，以及 `bench/pine/split-p1-*.json`。
3. 讀過 `astUtil.ts`、`scriptDecl.ts` 的檔頭（腳本產生的註解與 import），確認沒有被改。
4. 通過後 commit：`refactor(pine): move pure AST/decl helpers out of interpreter.ts (phase 1)`。

## 6. 第 2、3 階段（先不做，留給驗收後決定）

- **第 2 階段：增量執行**（`IncCkpt`～`incAdvance`，約 590 行）。會和 `interpreter.ts` 互相 import，而且要把約 12 個私有函式改成 export。`incRun` 必須留在 `interpreter.ts`，因為它會改寫模組變數 `runScriptTail`（被 import 的變數不能從別的模組改寫）。
- **第 3 階段：compile＋JIT 執行期**（約 730 行）。要用到 40 個核心內部函式，核心也會反過來用它。另外 `__callHistWrites++` 同時出現在核心和這一段，搬走就得加 setter。拆完只是把一個大檔切成兩個互相緊黏的檔，好處有限，**目前不建議做**。
