# A1′／wrapC 後續工單（等 commit 邊界過後施工）

> **前置（全部條目共同）**：施工前必須先過 **commit 邊界** —— 草案見 `docs/superpowers/plans/2026-10-17-wrapeval-option-a.md` §12。在那之前不要動 `src/`，否則逐行來源無法回溯。
> **來源**：P8 R1–R4 的 Minor 記帳（同計畫 §11.13）與 R4 的殘留風險；每條附「症狀／證據／根因／修法／驗收／風險」。
> **建議順序**：B7（純清潔）→ B2／B3（守門）→ B1（hist 孿生）→ B4／B5（硬化與成本）→ B6（語意，需先查 TV 文件）→ 附錄 A2／A3。

---

## B1　`histSpecHas` 的 raw-index 孿生缺口

- **症狀**：`invokeBuiltin` 以「原始位置計數」餵歷史判定（`interpreter.ts:1531`，`histSpecHas(spec, a.name === undefined ? pos++ : -1, a.name)`），而 `HistSpec.idx`（`registry.ts:17`）與 `ScalarSpec.idx` 同語意＝**bindArgs order 槽**。具名參數佔了較低槽時，位置引數對到錯槽 ⇒ `callHist` 該記的沒記、不該記的多記。
- **證據**：與 R2-I1 同形（該條已修）；本條為 history 側、**改前既有**。現有證據只到「未影響凍結語料」：四支 digest 逐字不變、golden 14 passed｜1 skipped。
- **根因**：`histSpecHas` 手上沒有 order，無從換算「原始位置 → 槽」。
- **修法**：`HistSpec` 增 `order?: readonly string[]`；對同時有 `ScalarSpec` 的 fn 可直接借用其 `order`；`invokeBuiltin` 以 `positionalSlots`（`registry.ts:51-64`）算出每個位置引數落到的槽，再問 `histSpecHas`。
- **驗收**：
  1. 新探針（放 `scratch/perf/`）：挑一個 `HistSpec` 為 `{idx,names}` 的函式，以「具名佔低槽 ＋ 位置落宣告槽」呼叫，比對 `callHist` 寫入數與純位置呼叫**相同**。
  2. 五閘重跑；四支 digest 必須逐字不變。
- **風險**：若 digest 真的變動，代表原行為本來就錯 ⇒ 需 re-baseline 並在 commit message 明列（不得靜默）。

## B2　非 `input.*` 家族的 under-declaration 無守門

- **症狀**：宣告表少一對（實作以 `kind` 守門讀取、卻沒宣告的槽）在任何非 `input.*` 家族都不會讓測試紅。
- **證據**：突變 `D1a`（`plot` 刪 `display` 一對）、`D1b`（`str.substring` 刪 `end_pos` 一對）⇒ `scalar_spec_integrity.test.ts` **仍綠**。
- **根因**：期望槽集（實作真正守門讀取的槽）在 repo 內不可推導；目前只存在於外部探針 `%TEMP%/omp-maint-audit.mts` 的 `GUARDED_READS`（167 槽，DIFFER 0）。
- **修法**：把該 167 槽表移植為 `src/pine/__tests__/fixtures/guardedReads.ts`，測試新增斷言：「每個被守門讀取的槽都必須在宣告表內」。
- **驗收**：`D1a`／`D1b` 轉紅；五閘全綠。
- **風險**：fixture 會漂（另一份需維護的來源）⇒ 在 fixture 頭部寫明「新增 `kind` 守門時同步更新」，並在測試失敗訊息直接指出缺哪一槽。

## B3　`order` 內「同長度錯名」無守門

- **症狀**：把 `order` 內兩個同長度名字互換、或把常數換成同長度錯名字面，都不會紅 —— 但漏斗會因此解包錯的引數。
- **證據**：突變 `D3a`（`array.slice` 的 `index_from`／`index_to` 互換）、`D3b`（`plot` 的 `order` 改成同長度錯名字面）⇒ **仍綠**。
- **根因**：只有 19 條「重用家族常數」的條目能被測試交叉驗證（`FAMILY_ORDER`）；另有 **23 條字面清單**在 repo 內沒有第二來源可對照。
- **修法**：把那 23 條所屬家族的 inline order 自 `array.ts`／`math.ts`／`str.ts` 提成匯出常數（＝R3-RevGuard 建議的「單一 order 來源」），表的 `order` 直接引用；`FAMILY_ORDER` 隨之覆蓋全部 42 條。
- **驗收**：`D3a`／`D3b` 轉紅；測試 3（idx 對家族 order）覆蓋 **42/42**。
- **風險**：提常數時須逐條對回實作 ⇒ 以 R3-RevOrder 的 23 條對照表當 checklist（計畫 §11.13 已載）。

## B4　`named` 的原型鏈裸讀

- **症狀**：解包迴圈讀 `named[n]`／`Object.keys(named)`，`named` 是普通物件 ⇒ `__proto__`／`constructor` 這類鍵可觸及原型鏈；目前只被 lexer 的 `KEYWORDS` 表**意外**擋下。
- **證據**：`R3-RevSecurity` Minor（`interpreter.ts:1568-1582`、`scalarDeclPatch.ts:54`、`str.ts:146`；擋下點 `lexer.ts:232` × `tokens.ts:38`）。
- **修法**：`invokeBuiltin` 建 `named` 改 `Object.create(null)`（或全面改 `Object.hasOwn`／`Map`），canon 迴圈同步改用 `Object.hasOwn`。
- **驗收**：探針以 `__proto__`／`constructor` 作具名鍵 ⇒ 行為與未知鍵一致（warn ＋ 忽略、不污染）；五閘全綠。
- **風險**：若他處依賴原型方法（`named.hasOwnProperty` 之類）會壞 ⇒ 動工前先 grep 所有 `named[`／`named.` 用法。

## B5　`positionalSlots` 與 JIT 的成本

- **症狀**：最壞 8.44 µs/call；JIT 路徑每次呼叫新建 `{}`（`interpreter.ts:2612`／`2633`／`2654`／`2814`）⇒ `named !== EMPTY_NAMED` 恆真，即使**沒有**具名參數也會跑 `positionalSlots`（0.25 µs/call）。interp 路徑已有 `EMPTY_NAMED` 單例（`interpreter.ts:1401`／`1464`／`1527`）可對照。
- **證據**：`R3-RevSecurity` 量測 probe D。
- **修法**：JIT 那四處改用 `EMPTY_NAMED` 單例；`callBuiltin` 另加 `Object.keys(named).length === 0` 短路（防其他來源的空物件）。
- **驗收**：微探針在 `node scripts/perf/quiet-gate.mjs` PASS 下比對改前/後；四支 digest 不得有差異。
- **風險**：效能量測須安靜機；若噪音大於效果量，照計畫 §11.6 協定記「無可量測差異」，不得宣稱進步。

## B6　`liftNums` 的 append 綁定（語意；**需先查 TV 文件**）

- **症狀**：`math.round(precision = 2, number = close)`、`math.round(number = close, 2)` 得 `round(2, close)`≈2 —— 與引擎自身 UDF／`bindArgs` 的 named-to-slot 契約**語意相反**（`util.ts:197-199`、`interpreter.ts:1757-1765`）。另 `hasP`（`math.ts:210-212`）只看 `args[1]`／`named['precision']`，看不到經 `number=` 送達的 precision ⇒ 混用拼法在非整數結果被 `toInt` 截斷。
- **證據**：`R4` 的 p1≠p2（小數 K 棒）與 u1/u2（UDF 對照）探針。
- **前置（不可跳）**：對照 TV 手冊的 named-argument 綁定規則。若 TV 確為 named-to-slot，則本條與 R3 已釘住的等價（`math.round(number = 2, close)` ≡ `math.round(close, 2)`）都需重定案。
- **修法（若 TV 為 named-to-slot）**：讓 `liftNums`（`math.ts:100` `args.concat(namedValues(...))`）改用 `bindArgs` 佔槽語意；`hasP` 改讀綁定結果。
- **驗收**：三種拼法（`(number = 2, close)`／`(close, 2)`／`(precision = 2, number = close)`）在**含小數 K 棒**下結果一致且不被截斷。
- **風險**：會改變既有輸出 ⇒ 必須獨立 commit、明列 re-baseline，不得與 A1′ 混在一起。

## B7　清潔（純整理）

- `array.ts` 4 處 Stage 3 回退殘留的兩段式綁定：`233/237`、`245/249`、`302/306`、`443/447` 的 `const raw = bound.get('value'); const v = raw;` ⇒ 收成 `const v = bound.get('value');`。
- `scratch/perf/wrapB-smoke.mts`：全 repo 無引用（R1 M9）⇒ 決定「保留並在檔頭標為歷史資產」或刪除。
- **驗收**：五閘全綠（純清潔，digest 必須逐字不變）。

---

## 附錄：另兩條未完成項（非 Minor，屬既有工作流）

| # | 項 | 修法／前置 |
|---|---|---|
| A2 | `strategyEquity.equityAt` 逐 bar 從 0 重放 ⇒ 超二次項（100 根 21.51→**798.21 ms**；500 根 148.43→**108,204.61 ms**） | 依 commit 邊界；修法＝`2026-10-17-t8a-snapshot-stepper.md` §1 選項①（stepper 順手記 `equity[b]`，`equityCurve` 改讀） |
| A3 | T3 的 **A4 成長倍率未量**（`pine-bench` 的 `growth` 為空） | 需一道真實 ≥1000 根 tape：起 `shioaji:8080` 跑 `pine-bench --fetch-bars`；起服務後量測須重過 `quiet-gate` |

---

## C. 設定探索：把 omp 的 `judge` 角色指到免費 JEV 1.13（**已試、未成**，2026-10-17）

**目標**：`modelRoles.judge` 由 `google-antigravity/gemini-4-argon` 改為免費 JEV（版本 1.13）。

**已做**：`~/.omp/agent/models.yml` 新增 provider `jev-zen`（`baseUrl: https://opencode.ai/zen/v1`、金鑰以 YAML anchor 指向 opencode-go 那把＝與 `~/.local/share/opencode/auth.json` 的 `opencode-go` 同值、models `jev-1.13-free` 與 `jev-1.13`）；`config.yml` 的 `judge` 曾設 `jev-zen/jev-1.13-free`（`api: typesafe` 與 `kind: typesafe` 兩種寫法都試過）。

**實測結果**

| 檢查 | 結果 |
|---|---|
| 端點／金鑰／模型是否存在 | `curl POST https://opencode.ai/zen/v1/systemone` `{model:"jev-1.13-free"}` → **`FreeUsageLimitError`** ⇒ 三者都對，只是**免費配額用盡** |
| JEV 能不能當 chat 模型用 | `zen/go/v1/chat/completions` → `Model is unavailable`；`zen/v1/chat/completions` → `FreeTierError`（"free tier can only be used from within OpenCode"）⇒ **不行**，JEV 只在 systemone 判定端點 |
| `modelRoles.judge` 有沒有被吃 | **有**：設 `opencode-go/glm-5.3-flash` 時 `judge()` 立刻回答案 |
| 設 `jev-zen/*` 時 | 兩次都失敗，且 omp 日誌**沒有任何**來自該候選的錯誤行 ⇒ 該 provider 沒被 judge 路徑採用，錯誤全部來自內建鏈 `typesafe/jev-latest` → `openrouter/~typesafe/jev-latest`（兩者 401，本機無 typesafe／openrouter 憑證） |

**結論**：omp 的 judge 走內建候選鏈；`models.yml` 自建的 systemone provider 目前不被採用（`kind` vs `api` 皆試過）。**`judge` 已還原為 `google-antigravity/gemini-4-argon`（實測可用）**，`jev-zen` 區塊保留在 `models.yml` 供後續。

**可行替代（三選一）**

1. 走**受管管道** `jev_judge.py`（它自己 `jev-zen` 優先、`jev-direct` 後備；2026-10-17 實測走的是 `jev-direct`，因 zen 免費配額已盡）。
2. omp 的 judge 改用**免費 chat 模型**：`providers.judgmentProvider: llm` ＋ 把 `tiny`／`smol` 指到免費模型（如 `magpie-zen/opencode-zen/*-free`）。
3. omp 的 judge 改用**便宜可用**的 chat 模型：`judge: opencode-go/glm-5.3-flash`（實測可用）。

**未解**：omp 期望的 systemone-kind provider 宣告方式（enum 有 `typesafe`／`workers-ai-systemone`，但 judge 客戶端未採用自建 provider）——待查 omp 文件或原始碼。
