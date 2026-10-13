# Pine Residual Perf — REAL PLAN v1
2026-10-11 · task-workflow P5（P3 JEV 降級主 LLM：daily_cap）

## 目標
K4.55 935 bars 真 workload（R14 後基線 ~12.35ms/bar）→ **<9ms/bar（−25%）**；
TRIS390 300×15（18.2ms/bar）→ **<14ms/bar**。輸出逐 bit 不變。

## 證據回顧（本輪 fresh profile，取代 R8 過期歸因）
- K4.55：`mtfStats.evals=0` — **不用 request.security**。evalNodes 1.57M/run，
  top：ident 354k / str 247k / call 225k / binary 217k。udfRuns 258k（276/bar，已 JIT）。
- TRIS390：mtf evals 50,497 / hits 30,147；gateFail 24；evalNodes 371k，
  top：**str 168k（56%）**/ call 67k。callHistWrites 227.9/bar（tf 域 evalArg 重寫）。
- R8「evalCall 78%」歸因早於 jitUdf + R13/R14 → 作廢。
- A1 ta-kernel：CLOSED（winAgg 已 O(1)）。
- 已否決（語意不安全）：gate-fail `(node,j)` 跨 caller memo —— UDF param binding
  per-invocation 不同，transient cache 的 miss 是語意必需，非 bug。

## 第一性原理分解
per-bar cost = evals × per-eval cost。evals 由腳本固定（K4.55 ~1700 top-level
nodes × 276 UDF calls）；per-eval = dispatch + arg marshal + series plumbing。
殘量 = **top-level evalExpr 路徑**（UDF body 已走 JIT，top-level 沒有）。

## 工作切片

### S1 — top-level JIT v2：R.call arg 特化（主線）
問題：全 jit ~11.5 vs jitUdf ~10.5 —— descriptor `{k,x,i,f}` 每 arg 每 call
每 bar 重新 alloc + jitMatArg 分支，吃掉 dispatch 省下來的。

做法（ponytail：先重用現有 emit 結構，不新增 runtime）：
1. `arg()` emit 分類已在；在 `R.call`/jitCallDispatch 加 **fast arms**：
   - 全 `{k:'l'}`（literal）→ 跳過 descriptor 解譯，直接 collect values。
   - 全 `{k:'i'}`（ident）→ 直接 scope lookup，跳 jitMatArg 的通用分支。
2. 已知 builtin ns（`ta.`/`str.`/`math.`/`array.` 等 dotted callee 且
   `RESOLVED_BUILTIN` 命中）→ emit `R.callBuiltinIdx(N, args)`：jit.ts 端
   預先 emit literal arg 直接 code（literal 無需 descriptor），ident arg
   走 `{k:'i'}`。
3. `R.str/R.num` literal emit 已是 native — 確認 `str` node 的 247k
   來自 top-level 未 JIT 路徑；S1 落地後應歸零該類 evalNode。
4. `__pineJit` 改為：top-level jit 只在「比 interp 快」時預設 ON ——
   S1 完成後 A/B 實測決定預設值（fail-safe：維持 opt-in）。

驗證：probe-k455/probe-tris A/B；parity 腳本（k455-parity.mjs）逐 bit 一致；
suite 全綠；golden 9/9。

### S2 — str-node 殘量歸因 + 收斂（依賴 S1 結果）
若 S1 後 str/ident evalNode 仍高 → 定位具體 stmt 類別（`__evalNodeCounts`
per-kind 已有；加 per-callsite top-5 dump 一次，用完即棄）再決定 micro-fix。
**禁止預先優化** — 無歸因不動手。

### S3 — TRIS390 tf 域 callHist 227.9/bar（獨立小項）
tf-eval 的 evalArg 也寫 callHist。R14 的 histSpecHas 只覆蓋 chart 域路徑？
確認 tf 域 evalArg 是否走同一 hist gate；若繞過 → 接入同一 spec 表即可。
驗證：probe-tris callHistWrites <50/bar。

### S4 —（調查項，非實作）MTF ephemeral-caller 內容指紋
問題：能否用「param binding 內容指紋」取代 scope identity，讓 gate-fail
expr 在相同 binding 下共享 (node,j)？若可行 → evals 168/bar 大幅下降且
**修正 var 雙重推進**（語意對齊 TV：一次 security 請求一個 calc ctx）。
判定標準：TRIS390 gate-fail UDF 的 caller scope bindings 是否
bar-over-bar 內容相同（identical CowSeries.source identity）。
產出：可行性結論；可行才進 v2 plan。

## 非目標
- loop-stmt JIT（for/while/switch emit）— R12d 已評估風險>收益。
- worker/分塊執行緒 — UX 層另一軌，不在本 plan。
- ta.* window kernel — A1 結案。
- MTF 共享 memo — 語意不安全，已否決（除非 S4 證明內容指紋可行）。

## 驗收
- [code] K4.55 935 real-workload <9ms/bar（bench-jit.ts 全量路徑）
- [code] TRIS390 300×15 <14ms/bar
- [code] K4.55 jit vs interp plot 輸出逐 bit 一致（k455-parity）
- [code] suite 全綠 + golden 9/9 + mtf_invariance/alias/boundary probes 全綠
- [jev] R.call fast-arm 不繞過 evalCallDispatch 語意（litFastPath/siteKey/callHist 規則一致）

## Rollback
- `__pineJit`/`__pineJitUdf` flag 維持 opt-out 可關；jit emit 失敗 →
  R.evalStmt fallback 既有機制。
- S3 hist 接入若改錯 → tf 域 golden（final/norm2）立即紅，revert 單檔。

## 風險
- R1: fast-arm 與 jitMatArg 語意分歧（hist/series wrap 差異）→ 用 corpus
  parity A/B 逐 bit 驗，不依賴單測。
- R2: S1 收益不足（top-level dispatch 佔比 <預估）→ 量產前先做 1-node
  micro-bench：R.call descriptor cost vs evalCall cost。
- R3: S4 指紋成本 > 省下 eval 成本 → 調查後多半放棄，屬預期。
