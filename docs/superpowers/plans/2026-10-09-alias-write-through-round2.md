# Plan: Series-Alias Write-Through Round-2 — residual holes after cbb3e40 + 9b19304

> **日期:** 2026-10-09
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans,task-by-task 跑。Steps 用 `- [ ]`。

**Goal:** 收掉 `bindDeclared`/`CowSeries` 修復（`cbb3e40`、`9b19304`）之後三輪 code-review + E2E 審計挖出的殘餘洞。全部是 silent data corruption 類——錯的數值但不 crash。

**HEAD at plan time:** `9b19304`。Suite: 630/631 (1 skip pre-existing)。

**已驗證的事實（repro 全部跑過）:**

| Claim | 修正後的真實觸發條件 | 結果 |
|---|---|---|
| A1 `x[1]` 丟 `:=` | **要 series-valued RHS**(`input.source(close)`、UDF series return、`ta.obv` 類）;`x = close` 裸 ident 是 scalar 不觸發 | CONFIRMED: `x=input.source(close); x:=999` → `x[1]` 讀 close 而非 999 |
| A2 mixed-kind 寫穿 | 同上，series→scalar flip;`cond ? close : 0` 不觸發 | CONFIRMED: `x=bar_index<2?input.source(close):1` → `close` 被改成 `[100,101,1,1,1]` |
| A3 cow 空 copy | security expr 要 **series-valued**(`ta.obv`/`math.*`/`input.source`),scalar expr 走 slotFor 不觸發；audit 建議的 `size()` fallback **是錯的**(tf-domain vs chart-domain) | CONFIRMED: `s:=s+1` 後 `s[1]` 全 na |
| A4 tuple `a[1]` | tuple element 要是 **long-lived series**(`input.source`/ctx);ident/LiftedSeries 安全 | CONFIRMED: `[a,b]=[input.source(close),1]` → `a[1]` 讀今天不是昨天 |
| A5 seed retro-write | out-of-order evalAt，`bar < cow.currentBar` | code-path confirmed, 窄 |
| Gorilla `:=` check | **airtight**——無 bypass 無誤殺，UDF param `close` 安全 | ✅ 不需動 |
| 外洩源頭 | `builtins/input.ts:193-235` `input.source`/`input(close)` 把 `ctx.close` 原樣回傳——這是唯一會把 ctx builtin series 漏進 declSlots 的 producer | confirmed |

## 設計決策（pre-explore 三份稿已合併）

**地圖契約（修完後）:**
- `declSlots: Map<object, BarSeries>` — owned slot 或 foreign alias target；所有權由 `declAliased` 區分
- `declAliased: Set<object>` — `declSlots[key]` 是 foreign(ctx.close/LitSeries/callHist/SecSeries/tf slot）的 key
- `declCows: Map<object, CowSeries>` — **每個 series decl 一隻 cow,不再只限 `var`**;`rebind(v.v)` 每次 bind 重指 inner;non-var 每次 bind 再 `seed(valueAt(v.v,bar), bar)`（跟 paramCows 同語義：re-bind ⇒ re-seed;`seed` 在未 materialize 時是 no-op)
- `var` rebind(L625/L1790/L1812)`declCows.get(dk) ?? declSlots.get(dk)!` 不變；`fresh = !declSlots.has(dk)` 不變

**為什麼 seed 必須跟著做：** 沒有 seed,non-var `x` 一旦 materialized,下一 bar 還是讀 copy 的 `:=` 值——`x = e` 應該每 bar 重新初始化，這會比原 bug 更糟。

## Executor Rules

- Stop 條件：同一失敗 2 種修法還紅、工具壞掉、找不到檔案。單一紅測試 = TDD loop 繼續。
- NEVER 把 cow 放進 `declSlots`(cow 的 `setAt` 會 materialize,`slotFor` 回傳的必須是 owned 或 foreign raw)
- NEVER `trackSeries` 一隻 decl cow(`ensureBar` 會提前 materialize;carry-forward 靠 `atOffset`/`peek`)
- NEVER 用 `src.size()` 當 writable base(SecSeries 是 tf-domain,`copy.setAt` 是 chart-domain)
- NEVER 動 `evalReassign` 的 builtin identity check（已審計 airtight)
- 同檔 (`interpreter.ts`) 不可並發 edit——所有 Task 1-5 的改動都在這一檔，**序列做**

## Tasks

### Task 0: 環境
- [ ] `git push`（保護 64 commits,HEAD `9b19304` + 即將新增的修復）
- [ ] `mv audit-cow-alias.md audit-builtin-readonly.md docs/superpowers/audits/`（建目錄，repo root 保持乾淨）

### Task 1 — A1+A2: cow-for-all + seed + declAliased tag（核心，~2h）

**Modify `src/pine/interpreter.ts`:**

1. `RunState` (~L106) 加 `declAliased: Set<object>`;init (~L161) 加 `declAliased: new Set()`。
2. `bindDeclared` series branch (~L466-486) 改成：

```ts
if (v.kind === 'series' && v.v instanceof BarSeries) {
  trackSeries(run, v.v);
  run.declSlots.set(key, v.v);
  run.declAliased.add(key);              // foreign-owned entry
  let cow = run.declCows.get(key);       // ALL decls, not just var
  if (!cow) { cow = new CowSeries(v.v); run.declCows.set(key, cow); }
  else cow.rebind(v.v);
  if (!persistent) cow.seed(valueAt(v.v, bar), bar);  // re-init each bar
  scope.define(name, cow);
  return v.v;
}
```

3. `slotFor` (~L437) 改成 foreign-safe:

```ts
let s = run.declSlots.get(key);
if (!s || run.declAliased.has(key)) {
  s = new BarSeries();
  run.declSlots.set(key, s);
  run.declAliased.delete(key);           // now owned
  if (persistent || !run.topLevelBody || run.topStmtIdx >= run.pruneCutoff) {
    trackSeries(run, s);
  }
}
scope.define(name, s);
return s;
```

4. 更新 L466-476 的 stale comment（講 `declAliased` 契約，不是 SecSeries no-op)。
5. `var` rebind sites(L625/L1790/L1812）不變。

**Verify:** `alias_repro` + test matrix：
- `x=input.source(close); x:=999; x[1]` → `x[1]==999`,close intact
- `x=input.source(close)` 不 `:=` → 讀 alias close，不 materialize
- `x=bar_index<2?input.source(close):1` → `close` intact,`x=[100,101,1,1,1]`
- `var x=input.source(close); x:=x+1` → accumulates
- decl 在 `if` arm、被 skip 的 bar → `x[1]` carry 正確
- 全 suite（`x = f()` 的 `x[1]` 可能從 `999` 變 `close[1]`——這是**正確化**不是回歸，golden 有 assert 就改 expected)

### Task 2 — A3: `writable` base（兩檔同改，一行）

- `interpreter.ts` CowSeries.writable (~L245):`const base = Math.max(bar, src instanceof BarSeries ? src.currentBar : 0);`
- `mtf.ts` CowSeries.writable (~L1107)：同一行

**Verify:** `s = request.security(syminfo.tickerid, "60", ta.obv); s := s+1; s[1]` → 前 bar 的值不是 na。

### Task 3 — A5: `seed()` guard（一行）

`CowSeries.seed`(~L232-234):
```ts
seed(v: Value, bar: number): void {
  if (this.cow && bar >= this.cow.currentBar) this.cow.setAt(bar, v);
}
```
（skip 不 clamp;`bar >= currentBar` 允許同 bar reseed + forward seed,retro seed 丟掉）

### Task 4 — A4: tuple scalar-store（兩處同改）

- interpreted tuple (~L671):
  ```ts
  slotFor(run, k, scope, name, /*persistent*/ !!node.var)
    .setAt(bar, items[i] === undefined ? NA : unseries(items[i]));
  ```
  （用 `valueAt(items[i].v, bar)` 更準——series anchored 在 bar 後的 `rAt(0)` 不該讀未來值）
- compiled tuple mirror(~L1731)：同改
- var-tuple carried rebind(L648-659/L1716-1724)**不動**（scalar-store 後本來就對）

**Verify:** `[a,b]=[input.source(close),1]; a[1]` → `[na,100,101,102,103]`;`[a,b]=[ta.sma(close,2),1]; a[1]` → `[na,na,100.5,...]`（不能回歸）。

### Task 5 — 清掃

- `evalReassign` L1383-84 `slot instanceof Series` 死碼（所有 in-tree Series 都 extends BarSeries,unreachable)——**刪掉**或改成 `else` fallthrough,decision：刪（沒有 producer 會產 non-BarSeries Series)
- F1 決策：`x :=` on security-bound 現在 silent cow copy(TV 語義上 Pine 允許，對）——在 `docs/superpowers/plans/2026-10-08-review-findings-fixes.md` changelog 記一筆「warn→silent 是刻意的」，不用改 code

### Task 6 — 驗收

- [ ] 全 suite `npx vitest run src/pine/__tests__/` 綠（630 + 新測試）
- [ ] `scratch/_qa_parity_sliceD.mjs` bit-identity 不變（compiled/interpreted 都要動到 bindDeclared)
- [ ] `git commit` 每 Task 一顆，或 1+2/3 一顆 + 4 一顆 + 5 一顆
- [ ] `git push`

## Phase 2 backlog(CP 排序，本 plan 不包）

| # | 項 | 成本 | 收益 |
|---|---|---|---|
| B1 | evalAt tf-bar `ta.*` 增量（見高K ~11s,`ta.sma(…,300)` 每 tf bar 全窗重算） | 高 | 高——下一個 plan |
| B2 | `strategy.*` + `security_lower_tf` QA/review;D4「granularity 語義」**等你決** | 中 | 中 |
| B3 | 400+ TS 指標庫接入（`pinets-src/` 已 abandoned，先 1hr spike 看格式） | 中 | 中 |
| B4 | Vela worker 化（主執行緒凍結） | 高 | 中——B1 後再說 |
| B5 | `__pineCompiled` 死旗標 + scratch 清理 | 極低 | 低 |

## 已知非問題（不要重做）

- `:=` on builtin identity check — OutsideGorilla 已審 airtight
- `x = close` 裸 ident — 是 scalar path，不觸發 alias/cow，本來就對
- `[a,b]=[close,1]` tuple ident — scalar element，本來就對
- `x :=` on security-bound silent-vs-warn — TV 允許，記 changelog 即可
