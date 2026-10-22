# Order Guard Phase 1 Implementation Plan（下單守門員 第一階段）

> **日期：** 2026-10-19（規劃）／執行日期由執行者在每個 Task 填寫
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Executor model:** DeepSeek V4.1 Flash (opencode / commandcode). Every step below is self-contained. Do not improvise designs.

**Goal:** Add a deterministic entry/exit guard to the OpenCharts paper terminal. Fix the guard bug in the TXF shadow collector. Measure whether flagged entries lose more often than approved ones.

**Architecture:** A pure TypeScript rule module (`orderGuard.ts`) judges each entry and each stop-loss change. A runtime module (`guardRuntime.ts`) wraps `demoApi.placeOrder` and `demoApi.modifyPosition`. The runtime appends every decision and every closed trade to `logs/order-guard.jsonl` through a Vite dev middleware. A Python report joins decisions to trade outcomes. Default mode is `shadow`: log only, never change an order.

**Tech Stack:** TypeScript 5 + Vite + Vitest (jsdom) in `C:\Users\bear9\OpenCharts`; Python 3.12 (`C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe`) + pytest for scripts.

**Spec:** `C:\Users\bear9\OneDrive\桌面\AI筆記\ENDO_借鑑與落地完整成果報告.html` + `C:\Users\bear9\OneDrive\桌面\AI筆記\ENDO_決策閘門_完整成果手冊.html`, as corrected by the section 「報告勘誤」 below.

**Spec invariant:** The guard never blocks or delays a risk-reducing action (`closePosition`, `closeAllPositions`, `cancelOrder`, SL/TP fills inside `engine.mark()`), and in `shadow` mode it never changes any order.

---

## 背景（給人看的，執行者可略讀）

### 為什麼只做這些（馬尾邏輯：停在第一個夠用的階梯）

| Endo 機制 | 本計畫怎麼借 | 不借什麼 |
|---|---|---|
| Permission ruleset（規則是資料、純函式比對） | `ENTRY_RULES` 物件：每條規則一個純函式 | 不借 last-match-wins，改 most-severe-wins（D3） |
| Failure as outcome（失敗是結果，不是崩潰） | 規則丟例外 → 記成 veto hit（fail-closed） | 不借 Effect runtime |
| 單一收斂點（所有命令收斂到 `agent.prompt`） | 所有下單收斂到 `demoApi.placeOrder` | 不在 OrderConfirmDialog 擋（一鍵交易會繞過） |
| ToolPart 審計留痕 | `logs/order-guard.jsonl` append-only | 不做 TraceWaterfall、不做 SSE |
| Shadow before enforce（先量測再上線） | `GUARD_MODE = "shadow"` 預設 |, |
| `.workflow.ts` / `defineWorkflow` / `parallel` / `phase` | **不做**（只有一個實作者，YAGNI） |, |
| Scheduler（30s 輪詢） | **不做**：`scripts/jev-shadow.py` 已是 5m 巡邏 |, |
| L2 LLM 覆核進下單路徑 | **不做**：見勘誤 4 |, |

### 報告勘誤（2026-10-19 讀碼核對）

1. **兩頁不互通。** `src/App.tsx`：`/vela` → `VelaPage`（台股/台指資料、Pine 引擎、VELA 圖），**沒有下單程式碼**。其他路徑 → `TradingPage`（下單面板），它的 `api` 是 `demoApi` 的 Proxy（`src/services/api.ts`）。報告的成果 4（下單後在 VELA 畫 R:R 框）與成果 6（Pine alert 餵給下單閘門）都跨頁，**不在 Phase 1**。
2. **紙上交易只有加密貨幣。** `src/services/demo/instruments.ts` 的 `DEMO_SYMBOLS` 只有 BTCUSD/ETHUSD/SOLUSD/BNBUSD/XRPUSD/ADAUSD。台指期下單尚未實作（使用者 2026-10-19 確認）。所以 Phase 1 的定位是**紀律訓練：阻止衝動下單**，規則寫在下單喉口，日後台指期下單接上同一個喉口即可沿用。
3. **`shioajiApi` 沒接上。** `src/services/shioaji/api.ts` 的 `shioajiApi` 沒有任何引用。日後接上時，`placeLiveOrder` 必須走同一套檢查（寫進 `guardRuntime.ts` 註解）。
4. **報告的「Phase 01 影子觀察期」已存在**：`scripts/jev-shadow.py`（TXF 5m，`logs/jev-shadow.jsonl` 1263 列）。`docs/PHASE0_MEASUREMENT.md`：Jev 從未說過 sell；日盤 buy 1H 命中率 0.167（n=18）。LLM 否決目前沒有證據支撐，所以不進下單路徑。
5. **影子閘門 100% veto 是 bug。** 2026-10-19 的 61 列全是 `veto / volatile`，61 列全升級 DeepSeek（付費）。根因：Jev 的 `volatility_regime` 物件帶 `legend` 欄位，內容固定含 `"Volatile: ..."`，所以 `'volatile' in vol_txt` 永遠成立。實際 `probabilities["2"]` 只有 0.01–0.02。Task 1 修。
6. **「改規則不用重編」不成立。** Vite 下改 `orderGuard.ts` 是 HMR 熱更新，不是免編譯。

### 這個守門員能保證什麼、不能保證什麼

- 能：擋掉沒停損的進場、停損放錯邊、報酬風險比 < 1.5、當日虧損到上限、連虧 3 筆、虧損後 5 分鐘內報復性進場、反向開出對沖單、攤平虧損部位、把停損拉遠或移除。
- 不能：保證勝率。勝率提升只能靠 Task 5 的報告證明：「被標記的進場」虧損率 > 「通過的進場」虧損率，且樣本足夠，才進 Phase 2（enforce）。
- 不能：跨頁面重新整理記住紀律狀態。紙上引擎只存在記憶體，F5 後 `closed[]` 清空，冷卻、當日虧損、連虧全部歸零（帳戶也一起重置）。
- 不能：量到 LIMIT/STOP 掛單的結果。掛單成交在之後的 `engine.mark()`，沒有 join key（見 Log line format）。圖表右鍵快速下單只產生 LIMIT/STOP，所以 Phase 1 報告的樣本只含市價單。

---

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same
verify failing after 2+ distinct fix attempts. Single red test = normal TDD
loop, not a blocker.

Never stop to ask what you can look up, file locations, signatures, test
names: search first. Questions that don't change your next action: note them,
keep going, report at task end.

**Shell rule (read first).** Your shell tool on this machine is probably PowerShell. Every command block in this plan is Git Bash syntax. Run each one like this:

1. Write the fenced `bash` block to `%TEMP%\guard-step.sh` (outside the repo, so `git status` stays clean). Put `cd /c/Users/bear9/OpenCharts` and the `PY=` line at the top of the file.
2. Run it with the full Git Bash path: `& "C:\Program Files\Git\bin\bash.exe" "$env:TEMP\guard-step.sh"`
3. Do NOT run a bare `bash`. On this machine it resolves to WSL (`C:\Windows\system32\bash.exe`), where `/c/Users/...` does not exist.

Working directory for every command: `C:\Users\bear9\OpenCharts` (git repo). Every script starts with:

```bash
cd /c/Users/bear9/OpenCharts
PY=/c/Users/bear9/AppData/Local/Programs/Python/Python312/python.exe
```

**Before Task 1, record the baseline once** (pre-existing failures are not yours):

```bash
npm run typecheck 2>&1 | tail -5
npx vitest run src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts 2>&1 | tail -8
git status --short
```

Write the three outputs verbatim into the Review Ledger as `Baseline:`.

Do NOT run the bare `npx vitest run` (whole suite) as the baseline. It takes about 6.5 minutes (82 files, 1140 tests, measured 2026-10-20), and a 2-minute tool timeout kills it. The only later comparison is Task 3 Step 6, which checks exactly these two files. `npm run typecheck` takes about 1 minute: give it a timeout of at least 180 s.

**Plan-specific Nevers:**
- NEVER route `closePosition`, `closeAllPositions`, `cancelOrder`, `cancelAllOrders`, or `engine.mark()` through the guard (Spec invariant).
- NEVER change `GUARD_MODE` from `"shadow"` to `"enforce"`. Only the user flips it (Phase 2 gate).
- NEVER commit `scripts/jev-shadow.py`. It already has uncommitted user changes. Edit only the hunks in Task 1 and leave the file uncommitted.
- NEVER run `git checkout`, `git restore`, `git stash`, or `git reset` on any file.
- NEVER put the guard check in `OrderPanel.tsx` or `OrderConfirmDialog`. One-click mode bypasses the dialog (`OrderPanel.tsx`: `if (oneClick && orderType === "MARKET") {`).
- NEVER match Jev answers by substring (`'volatile' in str(...)`). Read numeric fields (`score`, `probabilities`). Settled in D4.
- NEVER make the order wait for the log POST. Logging is fire-and-forget (D2).
- NEVER add a `Co-Authored-By` trailer to commits.

## Global Constraints

- Do not install new npm or pip packages. Use Node `fs`/`path`, Python stdlib, and existing deps.
- TypeScript: `noUncheckedIndexedAccess: true` is on. Index access returns `T | undefined`.
- Tests: Vitest picks up `src/**/*.test.{ts,tsx}` only. Python tests go in `scripts/tests/`.
- Every `.py` change: run `"$PY" -m pytest scripts/tests -v --tb=short` and `"$PY" -c "import py_compile; py_compile.compile('<file>', doraise=True)"`.
- Every `.ts` change: run `npm run typecheck` and the task's `npx vitest run <file>`.
- Thresholds live in one `LIMITS` object in `src/services/guard/orderGuard.ts`: `dailyLossLimit: 500`, `maxConsecutiveLosses: 3`, `minRewardRisk: 1.5`, `cooldownMinutes: 5`.
- Log file: `logs/order-guard.jsonl`, one JSON object per line.

## Decision Points

### D1: Where the entry check runs   (T1)
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): inside `engine.placeOrder` in `src/services/demo/engine.ts`, next to the input checks (`Bad input is rejected here rather than poisoning the account`)
  - B (minimal): in `OrderPanel.tsx` `doSubmit`
  - C (preferred): wrapper called from `demoApi.placeOrder` in `src/services/demo/api.ts`
- Criteria:
  - Every order path passes the check: OrderPanel, WatchlistPanel, chart quick-order (`TradingPage.tsx` `_submit: () => api.placeOrder(input)`), mobile one-click
  - `engine.ts` gains no network side effect
  - Engine unit tests (`demo-engine-resting-orders.test.ts`) keep calling `engine.placeOrder` without a guard
- Chosen: C
- Rejected: A fails "engine.ts gains no network side effect" and the engine-tests criterion; B fails "every order path" (one-click and chart quick-order skip it)
- Revisit trigger: `shioajiApi` gets referenced from `src/services/api.ts`
- Outcome: (filled during execution)

### D2: How the browser writes `logs/order-guard.jsonl`   (T2)
- Status: confirmed by the user (2026-10-20): C
- Consumed by: Task 3, Task 4, Task 5
- Candidates:
  - A (existing pattern): add `POST /log` to `scripts/jev-sidecar.py` (proxied at `/jev`)
  - B (minimal): keep the log in `localStorage` only
  - C (preferred): Vite dev middleware `POST /__guard-log` in `vite.config.ts`, appends with Node `fs`
- Criteria:
  - Logging works when the Jev sidecar on port 8787 is down
  - A Python script can read the log from disk
  - No edit to a file that has uncommitted user changes (`git status` shows `scripts/jev-sidecar.py` modified)
- Chosen: C
- Rejected: A fails "works when the sidecar is down" and "no edit to a file with uncommitted user changes"; B fails "a Python script can read the log from disk"
- Revisit trigger: the user runs the terminal from `vite build` output (no dev server), so `/__guard-log` returns 404
- Outcome: (filled during execution)

### D3: How rule hits combine into one verdict   (T1)
- Consumed by: Task 2, Task 3
- Candidates:
  - A (existing pattern): Endo permission ruleset, last-match-wins (`tool + permission (ruleset)` in the spec)
  - B (minimal): first hit wins, stop evaluating
  - C (preferred): evaluate all rules, most severe verdict wins (`veto` > `reduce` > `approve`)
- Criteria:
  - Adding a rule can never loosen an earlier veto
  - The log records every rule that fired, for the Task 5 per-rule report
- Chosen: C
- Rejected: A fails "can never loosen an earlier veto"; B fails "records every rule that fired"
- Revisit trigger: a rule needs to grant an exception to another rule (an allow-list rule)
- Outcome: (filled during execution)

### D4: Volatility threshold for the shadow collector's hard veto   (T1)
- Consumed by: Task 1
- Candidates:
  - A (existing pattern): reuse the escalation threshold in `should_escalate` (`vnum >= 1.0 or volatile_prob >= 0.5`)
  - B (minimal): delete the volatility veto
  - C (preferred): `score >= 1.5 or probabilities["2"] >= 0.5`, read numerically
- Criteria:
  - A bar whose most likely class is Normal (score near 1.0) is not vetoed
  - The collector keeps a volatility hard stop (plan §6 rule `volatile`)
  - The check reads numeric fields only
- Chosen: C
- Rejected: A fails "a bar whose most likely class is Normal is not vetoed" (score 1.0 = Normal); B fails "keeps a volatility hard stop"
- Revisit trigger: after the fix, more than 50% of a full day session's rows still have `risk_gate.rule == "volatile"`
- Outcome: (filled during execution)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/jev-shadow.py` | Modify (2 hunks, do not commit) | Fix the substring bug in `RiskSession.gate` and `should_escalate` |
| `scripts/tests/test_jev_shadow_volatile.py` | Create | Pytest for the fix, built from a real logged answer |
| `src/services/guard/orderGuard.ts` | Create | Pure rules: `checkEntry`, `checkStopChange`, `LIMITS`, `GUARD_MODE` |
| `src/services/__tests__/orderGuard.test.ts` | Create | Unit tests for every rule |
| `src/services/guard/guardRuntime.ts` | Create | Context build, mode handling, log POST, outcome subscription |
| `src/services/__tests__/guardRuntime.test.ts` | Create | Shadow / enforce / outcome / stop-change behavior against the real paper engine |
| `src/services/demo/engine.ts` | Modify (`recordClose`) | Publish one `closed-positions` bus event per closed record |
| `src/services/demo/api.ts` | Modify (2 lines + 1 import) | Route `placeOrder` and `modifyPosition` through the runtime |
| `vite.config.ts` | Modify | Dev middleware `POST /__guard-log` → `logs/order-guard.jsonl` |
| `scripts/guard_report.py` | Create | Join decisions to outcomes; print loss rate per verdict and per rule; print Phase 2 gate |
| `scripts/tests/test_guard_report.py` | Create | Pytest for the report |

### Log line format (shared by Task 3, Task 4, Task 5)

Every line has `ts` (ISO string) and `mode` (`"shadow"` or `"enforce"`), plus one of:

```json
{"kind":"entry","intent":{"accountId":"…","symbol":"BTCUSD","side":"BUY","type":"MARKET","quantity":1,"stopLoss":98},"decision":{"verdict":"approve","quantity":1,"hits":[]},"orderId":"…","positionOpenedAt":"2026-10-19T02:00:00.000Z"}
{"kind":"stop_change","positionId":"…","symbol":"BTCUSD","from":98,"to":97,"decision":{"verdict":"veto","quantity":1,"hits":[{"rule":"stop_widen","verdict":"veto","reason":"…"}]}}
{"kind":"outcome","symbol":"BTCUSD","side":"LONG","openedAt":"2026-10-19T02:00:00.000Z","closedAt":"2026-10-19T03:00:00.000Z","realizedPnl":-12.5}
```

Join key: `entry.intent.symbol == outcome.symbol` and `entry.positionOpenedAt == outcome.openedAt`. `positionOpenedAt` is `null` for resting LIMIT/STOP orders and for vetoed orders (they are not joined).

---

### Task 1: Fix the always-veto bug in the TXF shadow collector

> Planned: 2026-10-19 ｜ Executed: ____ ｜ Bug discovered: 2026-10-19

**Blocked by:** None, can start immediately

**Files:**
- Modify: `scripts/jev-shadow.py` (function `should_escalate`, method `RiskSession.gate`; a new function `_is_volatile` above `def should_escalate`)
- Test: `scripts/tests/test_jev_shadow_volatile.py`

**Interfaces:**
- Consumes: `RiskSession().gate(bar, ans) -> (verdict, lots_mult, reason, rule)`; `should_escalate(ans) -> (bool, str)`
- Produces: `_is_volatile(vol: dict, min_score: float = 1.5) -> bool`

**Assumptions:** `scripts/jev-shadow.py` imports cleanly through `importlib` (verified 2026-10-19: no side effects outside `main()`).

**Done when:**
- `"$PY" -m pytest scripts/tests/test_jev_shadow_volatile.py -v` → 5 passed
- A Normal-regime answer (`score 0.7`, `probabilities["2"] 0.02`, buy, confidence 0.9) → `gate` returns `approve`, not `veto`
- `score 1.6` → `gate` returns rule `volatile`
- `grep -c "if choice in ('flat', 'hold'):" scripts/jev-shadow.py` → `1`
- `should_escalate` on the Normal-regime answer → `(False, '')`
- `grep -c "'volatile' in vol_txt" scripts/jev-shadow.py` → `0`
- `git diff --stat scripts/jev-shadow.py` is reported verbatim; neither Task 1 file is committed

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test_jev_shadow_volatile.py`:

```python
"""Regression: Jev's volatility_regime carries a `legend` whose text always
contains "Volatile:", so a substring test vetoed every bar (2026-10-19, 61/61)."""
import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_shadow", Path(__file__).resolve().parent.parent / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)

LEGEND = {
    "0": "Calm: tight day range, moving averages closely bunched.",
    "1": "Normal: moderate day range, some separation between MA tiers.",
    "2": "Volatile: wide day range, MA tiers widely separated or whipsawing.",
}


def ans(score, prob2, choice="buy", conf=0.9):
    return {"answers": {
        "action_choice": {"type": "choice", "choice": choice, "confidence": conf},
        "volatility_regime": {"type": "score", "score": score, "confidence": 0.5,
                              "legend": LEGEND,
                              "probabilities": {"0": 0.3, "1": 0.68, "2": prob2}},
    }}


def test_normal_regime_is_not_vetoed():
    verdict, _, _, rule = js.RiskSession().gate({}, ans(0.7, 0.02))
    assert (verdict, rule) == ("approve", "full")


def test_high_score_is_vetoed():
    _, _, _, rule = js.RiskSession().gate({}, ans(1.6, 0.02))
    assert rule == "volatile"


def test_high_volatile_probability_is_vetoed():
    _, _, _, rule = js.RiskSession().gate({}, ans(0.9, 0.55))
    assert rule == "volatile"


def test_normal_regime_does_not_escalate():
    assert js.should_escalate(ans(0.7, 0.02)) == (False, "")


def test_score_one_still_escalates():
    ok, trigger = js.should_escalate(ans(1.0, 0.02))
    assert ok and trigger.startswith("volatile environment")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `"$PY" -m pytest scripts/tests/test_jev_shadow_volatile.py -v --tb=short`
Expected: `test_normal_regime_is_not_vetoed` FAILS (`('veto', 'volatile') != ('approve', 'full')`) and `test_normal_regime_does_not_escalate` FAILS (`(True, 'volatile environment')`).

- [ ] **Step 3: Add `_is_volatile` above `should_escalate`**

Anchor: `def should_escalate(ans):` (unique). Insert this block directly above that line, with two blank lines after it:

```python
def _is_volatile(vol, min_score=1.5):
    """volatility_regime is a Jev Score (0 Calm, 1 Normal, 2 Volatile).
    Read the numbers only: the answer's `legend` always contains "Volatile:",
    so any substring test on the dict is always true (bug of 2026-10-19)."""
    if not isinstance(vol, dict):
        return False
    try:
        if float(vol.get('score')) >= min_score:
            return True
    except (TypeError, ValueError):
        pass
    try:
        return float((vol.get('probabilities') or {}).get('2')) >= 0.5
    except (TypeError, ValueError):
        return False
```

- [ ] **Step 4: Fix `should_escalate`**

Anchor: `    low_rel = ans['answers'].get('low_reliability_setup', {}) or {}`

Original (verbatim, inside `should_escalate`):

```python
    vol = ans['answers'].get('volatility_regime', {}) or {}
    vol_txt = ' '.join(str(v) for v in (vol.values() if isinstance(vol, dict) else [vol])).lower()
    low_rel = ans['answers'].get('low_reliability_setup', {}) or {}
```

Replacement:

```python
    vol = ans['answers'].get('volatility_regime', {}) or {}
    low_rel = ans['answers'].get('low_reliability_setup', {}) or {}
```

Second hunk in the same function. Anchor: `        return True, 'volatile environment (score=%s prob2=%s)' % (vnum, volatile_prob)`

Original (verbatim):

```python
        return True, 'volatile environment (score=%s prob2=%s)' % (vnum, volatile_prob)
    if 'volatile' in vol_txt:
        return True, 'volatile environment'
    if lr_num >= 1:
```

Replacement:

```python
        return True, 'volatile environment (score=%s prob2=%s)' % (vnum, volatile_prob)
    if lr_num >= 1:
```

- [ ] **Step 5: Fix `RiskSession.gate`**

Anchor: `            return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'`

Original (verbatim, inside `class RiskSession`, method `gate`):

```python
        vol = answers.get('volatility_regime', {}) or {}
        vol_txt = ' '.join(str(v) for v in (vol.values() if isinstance(vol, dict) else [vol])).lower()

        # --- hard vetoes ---
        if choice == 'flat':
            return 'veto', 0.0, 'flat choice', 'flat'
        if 'volatile' in vol_txt:
            return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'
```

Replacement:

```python
        vol = answers.get('volatility_regime', {}) or {}

        # --- hard vetoes ---
        # Jev's action_choice offers buy/hold/sell only, never 'flat': treat hold as flat
        # (user decision 2026-10-20), or a hold bar falls through to approve/reduce.
        if choice in ('flat', 'hold'):
            return 'veto', 0.0, 'flat choice', 'flat'
        if _is_volatile(vol):
            return 'veto', 0.0, 'volatile environment -> risk>=1', 'volatile'
```

Do NOT edit `scripts/jev-shadow-helpers.py`. It has a duplicate `gate()` that the collector does not import. Note it in the task report.

- [ ] **Step 6: Run the tests and compile check**

```bash
"$PY" -m pytest scripts/tests/test_jev_shadow_volatile.py -v --tb=short
"$PY" -c "import py_compile; py_compile.compile('scripts/jev-shadow.py', doraise=True)"
grep -c "'volatile' in vol_txt" scripts/jev-shadow.py
git diff --stat scripts/jev-shadow.py
```

Expected: `5 passed`; no compile output; `0`; a diff stat line for `scripts/jev-shadow.py`.

- [ ] **Step 7: Do not commit**

Leave both `scripts/jev-shadow.py` and `scripts/tests/test_jev_shadow_volatile.py` uncommitted. The test fails without the fix, so they must land in the same commit, and the user owns that commit (the collector file has their unrelated changes).

- [ ] **Step 8: Report the user action**

Write in the task report: "The running collector still uses the old code. The user restarts `jev-shadow.py` after reviewing the uncommitted diff. Acceptance query after the next full day session:"

```bash
"$PY" -c "import json,collections;rows=[json.loads(l) for l in open('logs/jev-shadow.jsonl',encoding='utf-8') if l.strip()];new=[r for r in rows if r.get('risk_gate')][-60:];print(len(new),collections.Counter(r['risk_gate']['rule'] for r in new),collections.Counter((r.get('deepseek') or {}).get('trigger','none') for r in new))"
```

Expected after the restart and one full day session (~60 bars): the rule counter is not 100% `volatile`, and the DeepSeek trigger counter no longer shows `volatile environment` on every row.

---

### Task 2: Pure guard rules

> Planned: 2026-10-19 ｜ Executed: ____

**Blocked by:** None, can start immediately

**Files:**
- Create: `src/services/guard/orderGuard.ts`
- Test: `src/services/__tests__/orderGuard.test.ts`

**Interfaces:**
- Consumes: `Position`, `ClosedPosition` from `src/services/schemas.ts` (fields used: `Position.symbolName`, `.side` `"LONG" | "SHORT"`, `.unrealizedPnl`, `.stopLoss: number | null`, `.quantity`; `ClosedPosition.realizedPnl`, `.closedAt: string | null`)
- Produces:
  - `type Verdict = "approve" | "reduce" | "veto"`
  - `type GuardMode = "shadow" | "enforce"`
  - `const GUARD_MODE: GuardMode` (value `"shadow"`)
  - `const LIMITS = { dailyLossLimit: 500, maxConsecutiveLosses: 3, minRewardRisk: 1.5, cooldownMinutes: 5 }`
  - `interface EntryIntent { symbol: string; side: string; quantity: number; price?: number; stopPrice?: number; stopLoss?: number; takeProfit?: number }` (entry price = `price ?? stopPrice ?? ctx.lastPrice`)
  - `interface GuardContext { now: Date; lastPrice: number; positions: Position[]; closed: ClosedPosition[] }` (`closed` is newest-first)
  - `interface Hit { rule: string; verdict: "reduce" | "veto"; reason: string }`
  - `interface Decision { verdict: Verdict; quantity: number; hits: Hit[] }`
  - `checkEntry(intent: EntryIntent, ctx: GuardContext): Decision`
  - `checkStopChange(pos: Position, stopLoss: number | null | undefined): Decision`

**Assumptions:** "Today" means the local calendar date of `ctx.now` (`Date.prototype.toDateString`). It applies to `daily_loss` and `loss_streak` only. `cooldown_after_loss` reads the newest close regardless of date, because crypto trades through midnight. When the entry price is unknown (`price` absent and `lastPrice` is 0), `stop_side` and `reward_risk` skip; `stop_required` still applies.

**Done when:**
- `npx vitest run src/services/__tests__/orderGuard.test.ts` → all tests pass (23)
- A loss closed 3 minutes ago → `veto` `cooldown_after_loss`; 6 minutes ago → `approve`
- A loss closed at 23:58 and an entry at 00:01 the next day → `veto` `cooldown_after_loss`
- A BUY whose take-profit is below entry → `veto` `reward_risk` (no R:R computed)
- A stop-loss change to `0`, a negative number, or `NaN` → `veto` `stop_invalid`
- `npm run typecheck` → no new errors versus the baseline
- An entry without `stopLoss` → `veto` with rule `stop_required`
- 2 losses today → `reduce`, quantity halved; 3 losses today → `veto` `loss_streak`
- Losses dated yesterday → ignored
- A rule that throws → `veto` with reason starting `Rule failed:` (fail-closed)
- Stop moved from 98 to 97 on a LONG → `veto` `stop_widen`; 98 → 99 → `approve`

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/orderGuard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ClosedPosition, Position } from "../schemas.ts";
import { checkEntry, checkStopChange, type EntryIntent, type GuardContext } from "../guard/orderGuard.ts";

const NOW = new Date("2026-10-19T10:00:00+08:00");
const AN_HOUR_AGO = "2026-10-19T09:00:00+08:00"; // outside the loss cooldown
const YESTERDAY = "2026-10-18T10:00:00+08:00";

function pos(p: Partial<Position> = {}): Position {
  return {
    id: "p1", accountId: "a", symbolName: "BTCUSD", side: "LONG", quantity: 2,
    entryPrice: 100, currentPrice: 100, unrealizedPnl: 0, margin: 1, contractSize: 1,
    openedAt: NOW.toISOString(), takeProfit: null, stopLoss: null, ...p,
  } as Position;
}

function closedTrade(realizedPnl: number, closedAt = AN_HOUR_AGO): ClosedPosition {
  return {
    id: crypto.randomUUID(), accountId: "a", symbolName: "BTCUSD", side: "LONG", quantity: 1,
    entryPrice: 100, exitPrice: 99, realizedPnl, commission: 0, swap: 0,
    openedAt: closedAt, closedAt, isPartialClose: false,
  } as ClosedPosition;
}

const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({
  now: NOW, lastPrice: 100, positions: [], closed: [], ...o,
});

// BUY 2 @ 100, stop 98 (risk 2), target 104 (reward 4) → R:R 2.0
const GOOD: EntryIntent = { symbol: "BTCUSD", side: "BUY", quantity: 2, stopLoss: 98, takeProfit: 104 };
const rules = (d: { hits: { rule: string }[] }) => d.hits.map((h) => h.rule);

describe("checkEntry", () => {
  it("approves a clean entry at full size", () => {
    expect(checkEntry(GOOD, ctx())).toEqual({ verdict: "approve", quantity: 2, hits: [] });
  });

  it("vetoes an entry without a stop-loss", () => {
    const d = checkEntry({ ...GOOD, stopLoss: undefined }, ctx());
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("stop_required");
  });

  it("vetoes a BUY whose stop is above entry", () => {
    expect(rules(checkEntry({ ...GOOD, stopLoss: 101 }, ctx()))).toContain("stop_side");
  });

  it("vetoes a SELL whose stop is below entry", () => {
    const d = checkEntry({ symbol: "BTCUSD", side: "SELL", quantity: 1, stopLoss: 99 }, ctx());
    expect(rules(d)).toContain("stop_side");
  });

  it("uses the limit price as entry when given", () => {
    // limit 95, stop 97 is above a 95 BUY entry → wrong side
    expect(rules(checkEntry({ ...GOOD, price: 95, stopLoss: 97, takeProfit: undefined }, ctx()))).toContain("stop_side");
  });

  it("uses the stop level as entry for a STOP order", () => {
    // BUY STOP at 110, stop-loss 105 is below 110 → right side, even though market is 100
    expect(checkEntry({ ...GOOD, stopPrice: 110, stopLoss: 105, takeProfit: undefined }, ctx()).verdict).toBe("approve");
  });

  it("vetoes reward/risk below 1.5", () => {
    // reward 1, risk 2 → 0.5
    expect(rules(checkEntry({ ...GOOD, takeProfit: 101 }, ctx()))).toContain("reward_risk");
  });

  it("vetoes a take-profit on the wrong side of entry", () => {
    // BUY @ 100, TP 90 is a loss target: |90 - 100| / 2 = 5.0 would pass a non-directional R:R
    const d = checkEntry({ ...GOOD, takeProfit: 90 }, ctx());
    expect(d.hits.find((h) => h.rule === "reward_risk")?.reason).toMatch(/wrong side/);
  });

  it("skips price-based rules when the entry price is unknown", () => {
    expect(checkEntry({ ...GOOD, stopLoss: 101 }, ctx({ lastPrice: 0 })).verdict).toBe("approve");
  });

  it("vetoes once today's realized loss reaches the limit", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-300), closedTrade(-250)] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("daily_loss");
  });

  it("ignores losses closed on an earlier day", () => {
    const old = [closedTrade(-300, YESTERDAY), closedTrade(-300, YESTERDAY), closedTrade(-300, YESTERDAY)];
    expect(checkEntry(GOOD, ctx({ closed: old })).verdict).toBe("approve");
  });

  it("halves size after 2 losses in a row", () => {
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(-10), closedTrade(-10)] }))).toMatchObject({
      verdict: "reduce", quantity: 1,
    });
  });

  it("vetoes after 3 losses in a row", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-10), closedTrade(-10), closedTrade(-10)] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toContain("loss_streak");
  });

  it("counts the streak from the newest trade and stops at a win", () => {
    const closed = [closedTrade(-10), closedTrade(5), closedTrade(-10), closedTrade(-10)];
    expect(checkEntry(GOOD, ctx({ closed })).verdict).toBe("approve");
  });

  it("vetoes an entry within 5 minutes of a losing close", () => {
    const d = checkEntry(GOOD, ctx({ closed: [closedTrade(-10, "2026-10-19T09:57:00+08:00")] }));
    expect(d.verdict).toBe("veto");
    expect(rules(d)).toEqual(["cooldown_after_loss"]);
  });

  it("allows an entry 6 minutes after a loss, or right after a win", () => {
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(-10, "2026-10-19T09:54:00+08:00")] })).verdict).toBe("approve");
    expect(checkEntry(GOOD, ctx({ closed: [closedTrade(10, "2026-10-19T09:59:00+08:00")] })).verdict).toBe("approve");
  });

  it("keeps the loss cooldown across midnight", () => {
    const d = checkEntry(GOOD, ctx({
      now: new Date("2026-10-20T00:01:00+08:00"),
      closed: [closedTrade(-10, "2026-10-19T23:58:00+08:00")],
    }));
    expect(rules(d)).toEqual(["cooldown_after_loss"]);
  });

  it("vetoes an order that would open a hedge against an open position", () => {
    expect(rules(checkEntry(GOOD, ctx({ positions: [pos({ side: "SHORT" })] })))).toContain("opposite_side");
  });

  it("vetoes adding to a losing position but allows adding to a winner", () => {
    expect(rules(checkEntry(GOOD, ctx({ positions: [pos({ unrealizedPnl: -5 })] })))).toContain("average_down");
    expect(checkEntry(GOOD, ctx({ positions: [pos({ unrealizedPnl: 5 })] })).verdict).toBe("approve");
  });

  it("fails closed when a rule throws", () => {
    const broken = ctx({ closed: null as unknown as ClosedPosition[] });
    const d = checkEntry(GOOD, broken);
    expect(d.verdict).toBe("veto");
    expect(d.hits.find((h) => h.rule === "daily_loss")?.reason).toMatch(/^Rule failed:/);
  });
});

describe("checkStopChange", () => {
  it("allows tightening and vetoes widening a LONG stop", () => {
    const p = pos({ stopLoss: 98 });
    expect(checkStopChange(p, 99).verdict).toBe("approve");
    expect(rules(checkStopChange(p, 97))).toEqual(["stop_widen"]);
  });

  it("vetoes widening a SHORT stop, vetoes removal, and ignores untouched or first stops", () => {
    expect(rules(checkStopChange(pos({ side: "SHORT", stopLoss: 102 }), 103))).toEqual(["stop_widen"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), null))).toEqual(["stop_removed"]);
    expect(checkStopChange(pos({ stopLoss: 98 }), undefined).verdict).toBe("approve");
    expect(checkStopChange(pos({ stopLoss: null }), 95).verdict).toBe("approve");
  });

  it("vetoes a stop that is not a positive finite number, first stop included", () => {
    expect(rules(checkStopChange(pos({ stopLoss: null }), 0))).toEqual(["stop_invalid"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), -1))).toEqual(["stop_invalid"]);
    expect(rules(checkStopChange(pos({ stopLoss: 98 }), Number.NaN))).toEqual(["stop_invalid"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/__tests__/orderGuard.test.ts`
Expected: FAIL, `Failed to resolve import "../guard/orderGuard.ts"`.

- [ ] **Step 3: Write the implementation**

Create `src/services/guard/orderGuard.ts`:

```ts
import type { ClosedPosition, Position } from "../schemas.ts";

/**
 * Pre-trade guard: pure rules, no I/O (side effects live in guardRuntime.ts).
 *
 * Borrowed from Endo's permission ruleset: rules are data, each one a pure
 * function. Borrowed from Endo's "failure is an outcome": a rule that throws
 * becomes a veto hit instead of crashing the order path (fail-closed).
 * Not borrowed: Endo's last-match-wins. Here the most severe hit wins, so a
 * later rule can never loosen an earlier veto.
 */

export type Verdict = "approve" | "reduce" | "veto";
export type GuardMode = "shadow" | "enforce";

/** shadow: log only, never change an order. enforce: veto throws, reduce halves size.
 *  Only the user flips this, after scripts/guard_report.py prints PHASE2_GATE: READY. */
export const GUARD_MODE: GuardMode = "shadow";

export const LIMITS = {
  /** Account currency. Today's realized P&L at or below -500 blocks new entries. */
  dailyLossLimit: 500,
  /** This many losses in a row today blocks entries; one fewer halves size. */
  maxConsecutiveLosses: 3,
  /** Directional reward / |entry - stopLoss|, checked only when a TP is given. A TP on the loss side is a veto. */
  minRewardRisk: 1.5,
  /** Minutes after a losing close during which new entries are blocked (revenge-trade brake). */
  cooldownMinutes: 5,
};

export interface EntryIntent {
  symbol: string;
  side: string;
  quantity: number;
  /** LIMIT level (the mobile ticket and chart quick-order send every level here). */
  price?: number;
  /** STOP level from the desktop ticket. */
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface GuardContext {
  now: Date;
  /** 0 when the engine has not seen a price for the symbol yet. */
  lastPrice: number;
  positions: Position[];
  /** Newest first, as the paper engine stores them. */
  closed: ClosedPosition[];
}

export interface Hit {
  rule: string;
  verdict: "reduce" | "veto";
  reason: string;
}

export interface Decision {
  verdict: Verdict;
  quantity: number;
  hits: Hit[];
}

type Rule = (i: EntryIntent, c: GuardContext) => Omit<Hit, "rule"> | null;

const veto = (reason: string) => ({ verdict: "veto" as const, reason });
const isBuy = (side: string) => side === "BUY";
const entryOf = (i: EntryIntent, c: GuardContext) => i.price ?? i.stopPrice ?? c.lastPrice;

function todaysClosed(c: GuardContext): ClosedPosition[] {
  const day = c.now.toDateString();
  return c.closed.filter((p) => p.closedAt != null && new Date(p.closedAt).toDateString() === day);
}

function lossStreak(c: GuardContext): number {
  let n = 0;
  for (const p of todaysClosed(c)) {
    if (p.realizedPnl >= 0) break;
    n++;
  }
  return n;
}

const ENTRY_RULES: Record<string, Rule> = {
  stop_required: (i) => (i.stopLoss == null ? veto("Entry needs a stop-loss") : null),

  stop_side: (i, c) => {
    const e = entryOf(i, c);
    if (i.stopLoss == null || !(e > 0)) return null;
    const ok = isBuy(i.side) ? i.stopLoss < e : i.stopLoss > e;
    return ok ? null : veto(`Stop-loss ${i.stopLoss} is on the wrong side of entry ${e}`);
  },

  reward_risk: (i, c) => {
    const e = entryOf(i, c);
    if (i.stopLoss == null || i.takeProfit == null || !(e > 0)) return null;
    // Directional: Math.abs would score a loss-side TP as a high R:R.
    const reward = isBuy(i.side) ? i.takeProfit - e : e - i.takeProfit;
    if (reward <= 0) return veto(`Take-profit ${i.takeProfit} is on the wrong side of entry ${e}`);
    const rr = reward / Math.abs(e - i.stopLoss);
    return rr < LIMITS.minRewardRisk
      ? veto(`Reward/risk ${rr.toFixed(2)} is below ${LIMITS.minRewardRisk}`)
      : null;
  },

  daily_loss: (_i, c) => {
    const pnl = todaysClosed(c).reduce((s, p) => s + p.realizedPnl, 0);
    return pnl <= -LIMITS.dailyLossLimit
      ? veto(`Today's realized P&L ${pnl.toFixed(2)} reached the -${LIMITS.dailyLossLimit} limit`)
      : null;
  },

  loss_streak: (_i, c) => {
    const n = lossStreak(c);
    if (n >= LIMITS.maxConsecutiveLosses) return veto(`${n} losses in a row today`);
    if (n === LIMITS.maxConsecutiveLosses - 1) {
      return { verdict: "reduce", reason: `${n} losses in a row today: half size` };
    }
    return null;
  },

  cooldown_after_loss: (_i, c) => {
    // Newest close of any date: a 23:58 loss must still brake a 00:01 entry.
    const last = c.closed[0];
    if (!last || last.realizedPnl >= 0 || last.closedAt == null) return null;
    const mins = (c.now.getTime() - new Date(last.closedAt).getTime()) / 60_000;
    return mins < LIMITS.cooldownMinutes
      ? veto(`Last trade lost ${mins.toFixed(1)} min ago: wait ${LIMITS.cooldownMinutes} min after a loss`)
      : null;
  },

  opposite_side: (i, c) => {
    const opposite = isBuy(i.side) ? "SHORT" : "LONG";
    return c.positions.some((p) => p.symbolName === i.symbol && p.side === opposite)
      ? veto("An opposite position is open. Close it instead: the paper engine does not net, so this order opens a hedge")
      : null;
  },

  average_down: (i, c) => {
    const same = isBuy(i.side) ? "LONG" : "SHORT";
    return c.positions.some((p) => p.symbolName === i.symbol && p.side === same && p.unrealizedPnl < 0)
      ? veto("Adding to a losing position")
      : null;
  },
};

const RANK: Record<Verdict, number> = { approve: 0, reduce: 1, veto: 2 };

function decide(hits: Hit[], quantity: number): Decision {
  const verdict = hits.reduce<Verdict>((v, h) => (RANK[h.verdict] > RANK[v] ? h.verdict : v), "approve");
  // TODO: ponytail debt, halving suits fractional crypto size; integer futures lots need rounding.
  return { verdict, quantity: verdict === "reduce" ? quantity / 2 : quantity, hits };
}

export function checkEntry(intent: EntryIntent, ctx: GuardContext): Decision {
  const hits: Hit[] = [];
  for (const [rule, fn] of Object.entries(ENTRY_RULES)) {
    try {
      const hit = fn(intent, ctx);
      if (hit) hits.push({ rule, ...hit });
    } catch (err) {
      hits.push({ rule, verdict: "veto", reason: `Rule failed: ${(err as Error).message}` });
    }
  }
  return decide(hits, intent.quantity);
}

/** Exit side: a stop may tighten or be set for the first time, never widen or vanish.
 *  A stop past the market is allowed: it exits at once, which reduces risk (Spec invariant). */
export function checkStopChange(pos: Position, stopLoss: number | null | undefined): Decision {
  const hits: Hit[] = [];
  if (stopLoss != null && !(Number.isFinite(stopLoss) && stopLoss > 0)) {
    // The paper engine stores any number. A stop at 0 or below is bad input, not a
    // price: it never fires on a LONG, and on a SHORT it exits on the next tick.
    hits.push({ rule: "stop_invalid", verdict: "veto", reason: `Stop-loss ${stopLoss} is not a positive price` });
    return decide(hits, pos.quantity);
  }
  if (stopLoss === null && pos.stopLoss != null) {
    hits.push({ rule: "stop_removed", verdict: "veto", reason: "Removing the stop-loss of an open position" });
  }
  if (stopLoss != null && pos.stopLoss != null) {
    const wider = pos.side === "LONG" ? stopLoss < pos.stopLoss : stopLoss > pos.stopLoss;
    if (wider) {
      hits.push({
        rule: "stop_widen",
        verdict: "veto",
        reason: `Moving the stop-loss from ${pos.stopLoss} to ${stopLoss} adds risk`,
      });
    }
  }
  return decide(hits, pos.quantity);
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
npx vitest run src/services/__tests__/orderGuard.test.ts
npm run typecheck 2>&1 | tail -5
```

Expected: `23 passed`; typecheck output equals the baseline.

- [ ] **Step 5: Commit**

```bash
git add src/services/guard/orderGuard.ts src/services/__tests__/orderGuard.test.ts
git commit -m "feat(guard): pure entry and stop-change rules for the paper terminal"
```

---

### Task 3: Wire the guard into the paper terminal

> Planned: 2026-10-19 ｜ Executed: ____

**Blocked by:** Task 2 (imports `checkEntry`, `checkStopChange`, `GUARD_MODE`, `GuardMode`, `Decision`)

**Files:**
- Create: `src/services/guard/guardRuntime.ts`
- Modify: `src/services/demo/engine.ts` (function `recordClose`)
- Modify: `src/services/demo/api.ts` (import block, `placeOrder`, `modifyPosition`)
- Test: `src/services/__tests__/guardRuntime.test.ts`

**Interfaces:**
- Consumes: Task 2 exports; `getSeedPrice(symbol): number` from `src/services/demo/candles.ts`; `engine.placeOrder(PlaceOrderArgs): Order`, `engine.modifyPosition(id, mods): Position | undefined`, `engine.getPositions()`, `engine.getClosedPositions()`, `engine.getLastPrice(symbol): number`, `engine.mark(symbol, price)`, `engine.closePosition(id)`; `subscribeChannel(channel, handler)` and `publish(channel, event)` from `src/services/demo/bus.ts`
- Produces:
  - `guardedPlaceOrder(data: engine.PlaceOrderArgs, mode?: GuardMode): Order`
  - `guardedModifyPosition(positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }, mode?: GuardMode): Position | undefined`
  - Bus channel `"closed-positions"`, event `{ eventType: "PositionRealized", _entity: ClosedPosition }`
  - `POST /__guard-log` calls with the log line format above

**Assumptions:** A MARKET order fills synchronously inside `engine.placeOrder`, and `openPosition` pushes the new position at the end of the array, so the newest position is the last element of `engine.getPositions()`.

**Done when:**
- `npx vitest run src/services/__tests__/guardRuntime.test.ts` → 6 passed
- A MARKET entry on a symbol with no tick yet → judged against `getSeedPrice` (the engine's fill price), not skipped on price 0
- `grep -n "import.meta.hot?.dispose" src/services/guard/guardRuntime.ts` → 1 match
- `npx vitest run src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts` → same result as the baseline
- `npm run typecheck` → no new errors versus the baseline
- Shadow mode, entry without a stop → order still FILLED, one `entry` log with verdict `veto`
- Enforce mode, entry without a stop → throws `Guard veto: Entry needs a stop-loss`, no position opened
- Closing a position → one `outcome` log whose `openedAt` equals the entry log's `positionOpenedAt`
- `grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts` → only matches inside comments

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/guardRuntime.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as engine from "../demo/engine.ts";
import { guardedModifyPosition, guardedPlaceOrder } from "../guard/guardRuntime.ts";

/** The paper engine is a module singleton: each case claims its own symbol.
 *  Symbol isolation does NOT isolate the account-wide rules (daily_loss, loss_streak,
 *  cooldown_after_loss read every symbol's closes). Keep every close at P&L >= 0
 *  (close at the entry mark), or a later case trips the 5-minute loss cooldown. */
const ACCOUNT = "guard-test";
let logs: Record<string, unknown>[] = [];

beforeEach(() => {
  logs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: { body: string }) => {
      logs.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    }),
  );
});

const market = (symbol: string, extra: Partial<engine.PlaceOrderArgs> = {}) => ({
  accountId: ACCOUNT, symbol, side: "BUY", type: "MARKET", quantity: 1, ...extra,
});

describe("guard runtime", () => {
  it("shadow mode logs a veto but still places the order", () => {
    engine.mark("ETHUSD", 3_000);
    const order = guardedPlaceOrder(market("ETHUSD"), "shadow");
    expect(order.status).toBe("FILLED");
    const entry = logs.find((l) => l.kind === "entry")!;
    expect(entry).toMatchObject({ mode: "shadow", decision: { verdict: "veto" } });
    expect(typeof entry.positionOpenedAt).toBe("string");
  });

  it("enforce mode throws on a veto and opens nothing", () => {
    engine.mark("SOLUSD", 150);
    expect(() => guardedPlaceOrder(market("SOLUSD"), "enforce")).toThrow(/Guard veto: Entry needs a stop-loss/);
    expect(engine.getPositions().some((p) => p.symbolName === "SOLUSD")).toBe(false);
  });

  it("logs the trade outcome with the entry's openedAt as join key", () => {
    engine.mark("BNBUSD", 600);
    guardedPlaceOrder(market("BNBUSD", { stopLoss: 590 }), "shadow");
    const entry = logs.find((l) => l.kind === "entry")!;
    const pos = engine.getPositions().find((p) => p.symbolName === "BNBUSD")!;
    engine.closePosition(pos.id);
    const outcome = logs.find((l) => l.kind === "outcome")!;
    expect(outcome).toMatchObject({ symbol: "BNBUSD", openedAt: entry.positionOpenedAt });
    expect(typeof outcome.realizedPnl).toBe("number");
  });

  it("enforce mode refuses to widen a stop and leaves the stop unchanged", () => {
    engine.mark("XRPUSD", 0.5);
    guardedPlaceOrder(market("XRPUSD", { stopLoss: 0.4 }), "shadow");
    const pos = engine.getPositions().find((p) => p.symbolName === "XRPUSD")!;
    expect(() => guardedModifyPosition(pos.id, { stopLoss: 0.3 }, "enforce")).toThrow(/Guard veto/);
    expect(engine.getPositions().find((p) => p.id === pos.id)!.stopLoss).toBe(0.4);
  });

  it("allows tightening a stop and does not log a clean change", () => {
    engine.mark("ADAUSD", 0.4);
    guardedPlaceOrder(market("ADAUSD", { stopLoss: 0.3 }), "shadow");
    const pos = engine.getPositions().find((p) => p.symbolName === "ADAUSD")!;
    logs = [];
    expect(guardedModifyPosition(pos.id, { stopLoss: 0.35 }, "enforce")!.stopLoss).toBe(0.35);
    expect(logs.filter((l) => l.kind === "stop_change")).toHaveLength(0);
  });

  it("judges a symbol with no tick yet against the seed price the engine fills at", () => {
    // BTCUSD is never marked in this file. A stop far above any BTC price is on the
    // wrong side of the seed fill, so stop_side must fire instead of skipping on price 0.
    expect(engine.getLastPrice("BTCUSD")).toBe(0);
    const order = guardedPlaceOrder(market("BTCUSD", { stopLoss: 1e9 }), "shadow");
    expect(order.status).toBe("FILLED");
    const entry = logs.find((l) => l.kind === "entry") as { decision: { hits: { rule: string }[] } };
    expect(entry.decision.hits.map((h) => h.rule)).toContain("stop_side");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/__tests__/guardRuntime.test.ts`
Expected: FAIL, `Failed to resolve import "../guard/guardRuntime.ts"`.

- [ ] **Step 3: Publish closed records from the engine**

File: `src/services/demo/engine.ts`. Anchor: `function recordClose(pos: Position, qty: number, exitPrice: number, realized: number): void {`

Original (verbatim, the first statement block of `recordClose`):

```ts
  const now = new Date().toISOString();
  closed.unshift({
    id: crypto.randomUUID(),
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side,
    quantity: qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    realizedPnl: realized,
    commission: 0,
    swap: 0,
    openedAt: pos.openedAt,
    closedAt: now,
    isPartialClose: qty < pos.quantity,
  });
```

Replacement:

```ts
  const now = new Date().toISOString();
  const record: ClosedPosition = {
    id: crypto.randomUUID(),
    accountId: account.id,
    symbolName: pos.symbolName,
    side: pos.side,
    quantity: qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    realizedPnl: realized,
    commission: 0,
    swap: 0,
    openedAt: pos.openedAt,
    closedAt: now,
    isPartialClose: qty < pos.quantity,
  };
  closed.unshift(record);
  publish("closed-positions", { eventType: "PositionRealized", _entity: { ...record } });
```

Keep the `fills.unshift({` block below it unchanged. `ClosedPosition` and `publish` are already imported at the top of `engine.ts`.

- [ ] **Step 4: Create the runtime**

Create `src/services/guard/guardRuntime.ts`:

```ts
import type { ClosedPosition } from "../schemas.ts";
import { subscribeChannel } from "../demo/bus.ts";
import { getSeedPrice } from "../demo/candles.ts";
import * as engine from "../demo/engine.ts";
import { checkEntry, checkStopChange, GUARD_MODE, type Decision, type GuardMode } from "./orderGuard.ts";

/**
 * Side-effect half of the order guard. Builds the rule context from the paper
 * engine, applies the verdict per mode, and appends every decision and every
 * closed trade to logs/order-guard.jsonl (dev middleware in vite.config.ts).
 *
 * Exits are never routed here: closePosition, closeAllPositions, cancelOrder
 * and the SL/TP fills inside engine.mark() must never be blocked.
 * If shioajiApi.placeOrder (services/shioaji/api.ts) is ever wired into
 * services/api.ts, its placeLiveOrder path must run checkEntry too.
 */

function postGuardLog(event: Record<string, unknown>): void {
  // Fire-and-forget: an order never waits on, or fails because of, the audit log.
  // TODO: ponytail debt, a failed POST drops the line without a trace.
  fetch("/__guard-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ts: new Date().toISOString(), mode: GUARD_MODE, ...event }),
    keepalive: true,
  }).catch(() => {});
}

function vetoError(d: Decision): Error {
  const reasons = d.hits.filter((h) => h.verdict === "veto").map((h) => h.reason);
  return new Error(`Guard veto: ${reasons.join("; ")}`);
}

export function guardedPlaceOrder(data: engine.PlaceOrderArgs, mode: GuardMode = GUARD_MODE) {
  const decision = checkEntry(data, {
    now: new Date(),
    // Same fallback as engine.placeOrder's MARKET fill: before the first tick the
    // engine fills at the seed price, so the guard must judge against it too.
    lastPrice: engine.getLastPrice(data.symbol) || getSeedPrice(data.symbol),
    positions: engine.getPositions(),
    closed: engine.getClosedPositions(),
  });
  const enforce = mode === "enforce";
  if (enforce && decision.verdict === "veto") {
    postGuardLog({ kind: "entry", mode, intent: data, decision, orderId: null, positionOpenedAt: null });
    throw vetoError(decision);
  }
  const sized = enforce && decision.verdict === "reduce" ? { ...data, quantity: decision.quantity } : data;
  const order = engine.placeOrder(sized);
  // A MARKET order fills synchronously and its position is the newest one.
  // Resting LIMIT/STOP orders fill later: no join key for them.
  const positions = engine.getPositions();
  const opened = order.status === "FILLED" ? positions[positions.length - 1] : undefined;
  postGuardLog({
    kind: "entry",
    mode,
    intent: data,
    decision,
    orderId: order.id,
    positionOpenedAt: opened?.openedAt ?? null,
  });
  return order;
}

export function guardedModifyPosition(
  positionId: string,
  mods: { takeProfit?: number | null; stopLoss?: number | null },
  mode: GuardMode = GUARD_MODE,
) {
  const pos = engine.getPositions().find((p) => p.id === positionId);
  if (pos) {
    const decision = checkStopChange(pos, mods.stopLoss);
    if (decision.hits.length > 0) {
      postGuardLog({
        kind: "stop_change",
        mode,
        positionId,
        symbol: pos.symbolName,
        from: pos.stopLoss,
        to: mods.stopLoss,
        decision,
      });
    }
    if (mode === "enforce" && decision.verdict === "veto") throw vetoError(decision);
  }
  return engine.modifyPosition(positionId, mods);
}

const unsubscribeOutcomes = subscribeChannel("closed-positions", (event) => {
  const c = (event as { _entity: ClosedPosition })._entity;
  postGuardLog({
    kind: "outcome",
    symbol: c.symbolName,
    side: c.side,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    realizedPnl: c.realizedPnl,
  });
});

// HMR re-runs this module when orderGuard.ts changes, but bus.ts keeps its
// subscribers: without this, every rule edit adds a duplicate outcome line
// and guard_report.py would double the P&L of every later trade.
import.meta.hot?.dispose(unsubscribeOutcomes);
```

- [ ] **Step 5: Route `demoApi` through the runtime**

File: `src/services/demo/api.ts`.

Edit 1. Anchor: `import * as engine from "./engine.ts";`

Original:

```ts
import * as engine from "./engine.ts";
import { DEMO_SYMBOLS } from "./instruments.ts";
```

Replacement:

```ts
import * as engine from "./engine.ts";
import { DEMO_SYMBOLS } from "./instruments.ts";
import { guardedModifyPosition, guardedPlaceOrder } from "../guard/guardRuntime.ts";
```

Edit 2. Anchor: `  placeOrder: (data: engine.PlaceOrderArgs) =>`

Original:

```ts
  placeOrder: (data: engine.PlaceOrderArgs) => Promise.resolve().then(() => engine.placeOrder(data)),
```

Replacement:

```ts
  placeOrder: (data: engine.PlaceOrderArgs) => Promise.resolve().then(() => guardedPlaceOrder(data)),
```

Edit 3. Anchor: `  modifyPosition: (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) =>`

Original:

```ts
  modifyPosition: (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) =>
    Promise.resolve(engine.modifyPosition(positionId, mods)),
```

Replacement:

```ts
  modifyPosition: (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) =>
    Promise.resolve().then(() => guardedModifyPosition(positionId, mods)),
```

Do NOT touch `closePosition`, `closeAllPositions`, `cancelOrder`, `cancelAllOrders`, or `modifyOrder` in this object.

- [ ] **Step 6: Run the tests and the type check**

```bash
npx vitest run src/services/__tests__/guardRuntime.test.ts
npx vitest run src/services/__tests__/demo-contract.test.ts src/services/__tests__/demo-engine-resting-orders.test.ts
npm run typecheck 2>&1 | tail -5
grep -n "closePosition\|cancelOrder\|closeAllPositions" src/services/guard/guardRuntime.ts
grep -n "import.meta.hot?.dispose" src/services/guard/guardRuntime.ts
```

Expected: `6 passed`; the two existing files match the baseline; typecheck matches the baseline; the first grep shows only comment lines (lines inside the `/** … */` block); the second grep shows exactly 1 line.

- [ ] **Step 7: Commit**

```bash
git add src/services/guard/guardRuntime.ts src/services/__tests__/guardRuntime.test.ts src/services/demo/engine.ts src/services/demo/api.ts
git commit -m "feat(guard): route paper entries and stop changes through the shadow guard"
```

---

### Task 4: Dev middleware that writes `logs/order-guard.jsonl`

> Planned: 2026-10-19 ｜ Executed: ____

**Blocked by:** None, can start immediately (D2 confirmed by the user 2026-10-20: C)

**Files:**
- Modify: `vite.config.ts` (import line, `plugins:` line, new function above `export default`)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `POST /__guard-log` on the Vite dev server. A JSON object body → `204` and one appended line. Any other body → `400` and no write.

**Assumptions:** The user runs the terminal with `npm run dev` (`"dev": "vite"`, port 5173, `strictPort: true`).

**Done when:**
- `npm run typecheck` → matches the baseline (`vite.config.ts` is outside `tsconfig` `include`; the live probes below prove Vite loads the new config)
- With the dev server up: `POST {"kind":"probe"}` → HTTP `204`, and the last line of `logs/order-guard.jsonl` is `{"kind":"probe"}`
- `POST not-json` → HTTP `400`, line count of `logs/order-guard.jsonl` unchanged
- `POST [1,2]` → HTTP `400`

- [ ] **Step 1: Edit the import line**

Anchor: `import { defineConfig } from "vite";`

Original:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
```

Replacement:

```ts
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "path";

/** Dev-only sink for the order guard (src/services/guard/guardRuntime.ts):
 *  POST /__guard-log appends one JSON object per line to logs/order-guard.jsonl.
 *  A body that is not a JSON object gets 400 and writes nothing. */
function guardLogPlugin(): Plugin {
  const file = path.resolve(__dirname, "logs/order-guard.jsonl");
  return {
    name: "order-guard-log",
    configureServer(server) {
      server.middlewares.use("/__guard-log", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          let event: unknown = null;
          try {
            event = JSON.parse(body);
          } catch {
            event = null;
          }
          if (event === null || typeof event !== "object" || Array.isArray(event)) {
            res.statusCode = 400;
            res.end();
            return;
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, JSON.stringify(event) + "\n");
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}
```

- [ ] **Step 2: Register the plugin**

Anchor: `  plugins: [react()],`

Original:

```ts
  plugins: [react()],
```

Replacement:

```ts
  plugins: [react(), guardLogPlugin()],
```

- [ ] **Step 3: Type check**

```bash
npm run typecheck 2>&1 | tail -5
```

Expected: matches the baseline.

- [ ] **Step 4: Live check against the dev server**

Check the port first. Do not start a second server.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/ || echo "down"
```

- If the output is `200`: Vite restarts by itself after a `vite.config.ts` change (open terminal tabs reload). Wait 5 seconds, then run the probes below. If the probe returns `404`, Vite did not restart: report it, do not kill the user's server.
- If the output is `down`: run `npm run dev` with `run_in_background`, wait until `curl` returns `200`, run the probes, then stop that background server.

Probes:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{"kind":"probe"}' http://localhost:5173/__guard-log
tail -1 logs/order-guard.jsonl
N=$(wc -l < logs/order-guard.jsonl)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d 'not-json' http://localhost:5173/__guard-log
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '[1,2]' http://localhost:5173/__guard-log
test "$(wc -l < logs/order-guard.jsonl)" = "$N" && echo "unchanged"
```

Expected: `204`, `{"kind":"probe"}`, `400`, `400`, `unchanged`.

- [ ] **Step 5: Commit**

`logs/` content is not committed. Commit only the config:

```bash
git add vite.config.ts
git commit -m "feat(guard): dev middleware appends guard decisions to logs/order-guard.jsonl"
```

---

### Task 5: Outcome report and the Phase 2 gate

> Planned: 2026-10-19 ｜ Executed: ____

**Blocked by:** None, can start immediately (it reads the log format defined above, not Task 3 code)

**Files:**
- Create: `scripts/guard_report.py`
- Test: `scripts/tests/test_guard_report.py`

**Interfaces:**
- Consumes: the log line format (section "Log line format")
- Produces: `load(path) -> list[dict]`, `join(rows) -> list[tuple[str, list[str], float]]`, `summarize(trades) -> dict[str, dict]`, `gate(summary) -> bool`, CLI `"$PY" scripts/guard_report.py [log path]` printing one line per group and `PHASE2_GATE: READY|NOT_READY`

**Assumptions:** `probe` lines from Task 4 and `stop_change` lines are ignored by `join`.

**Done when:**
- `"$PY" -m pytest scripts/tests/test_guard_report.py -v` → 4 passed
- An entry without a matching outcome → not counted
- Two partial outcomes for one entry → their P&L is summed
- 20 approved winners + 10 flagged losers → `gate` returns `True`; 19 approved → `False`
- `"$PY" scripts/guard_report.py` on the real log prints `PHASE2_GATE:` (any value)

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test_guard_report.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import guard_report as gr  # noqa: E402


def entry(symbol, opened, verdict, rules=()):
    return {"kind": "entry", "intent": {"symbol": symbol}, "positionOpenedAt": opened,
            "decision": {"verdict": verdict, "hits": [{"rule": r} for r in rules]}}


def outcome(symbol, opened, pnl):
    return {"kind": "outcome", "symbol": symbol, "openedAt": opened, "realizedPnl": pnl}


def test_join_sums_partials_and_skips_unmatched():
    rows = [
        entry("BTCUSD", "t1", "approve"),
        outcome("BTCUSD", "t1", 4.0),
        outcome("BTCUSD", "t1", 6.0),
        entry("ETHUSD", "t2", "veto", ["stop_required"]),
        entry("SOLUSD", None, "approve"),
        {"kind": "probe"},
    ]
    assert gr.join(rows) == [("approve", [], 10.0)]


def test_summarize_groups_by_verdict_and_rule():
    s = gr.summarize([("approve", [], 5.0), ("veto", ["stop_required"], -2.0), ("reduce", ["loss_streak"], 1.0)])
    assert s["approve"] == {"n": 1, "loss_rate": 0.0, "pnl": 5.0}
    assert s["flagged"] == {"n": 2, "loss_rate": 0.5, "pnl": -1.0}
    assert s["rule:stop_required"]["loss_rate"] == 1.0


def test_gate_needs_samples_and_a_worse_flagged_group():
    ready = [("approve", [], 1.0)] * 20 + [("veto", ["x"], -1.0)] * 10
    assert gr.gate(gr.summarize(ready)) is True
    assert gr.gate(gr.summarize(ready[1:])) is False


def test_load_reads_jsonl(tmp_path):
    p = tmp_path / "g.jsonl"
    p.write_text(json.dumps({"kind": "probe"}) + "\n\n" + json.dumps({"kind": "outcome"}) + "\n", encoding="utf-8")
    assert [r["kind"] for r in gr.load(p)] == ["probe", "outcome"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `"$PY" -m pytest scripts/tests/test_guard_report.py -v --tb=short`
Expected: FAIL, `ModuleNotFoundError: No module named 'guard_report'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/guard_report.py`:

```python
"""Order guard report: does a flagged entry lose more often than an approved one?

Reads logs/order-guard.jsonl (written by the vite dev middleware), joins each
entry decision to its closed trade(s) by (symbol, positionOpenedAt == openedAt),
and prints loss rate and P&L per verdict group and per rule. Read-only.

"flagged" = verdict reduce or veto. Only shadow-mode rows give a fair
comparison: in enforce mode a vetoed order never trades, so it never joins.

Run: python scripts/guard_report.py [path/to/order-guard.jsonl]
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_LOG = Path(__file__).resolve().parent.parent / "logs" / "order-guard.jsonl"
MIN_APPROVED = 20  # Phase 2 gate: minimum joined trades per group
MIN_FLAGGED = 10


def load(path):
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def join(rows):
    """Return [(verdict, rules, pnl)] for entries that have at least one outcome."""
    pnl = defaultdict(float)
    for r in rows:
        if r.get("kind") == "outcome":
            pnl[(r["symbol"], r["openedAt"])] += r["realizedPnl"]
    out = []
    for r in rows:
        if r.get("kind") != "entry" or not r.get("positionOpenedAt"):
            continue
        key = (r["intent"]["symbol"], r["positionOpenedAt"])
        if key in pnl:
            d = r["decision"]
            out.append((d["verdict"], [h["rule"] for h in d["hits"]], pnl[key]))
    return out


def summarize(trades):
    groups = defaultdict(list)
    for verdict, rules, p in trades:
        groups["approve" if verdict == "approve" else "flagged"].append(p)
        for rule in rules:
            groups["rule:" + rule].append(p)
    return {
        g: {"n": len(ps), "loss_rate": round(sum(1 for p in ps if p < 0) / len(ps), 3), "pnl": round(sum(ps), 2)}
        for g, ps in groups.items()
    }


def gate(summary):
    a = summary.get("approve")
    f = summary.get("flagged")
    if not a or not f:
        return False
    return a["n"] >= MIN_APPROVED and f["n"] >= MIN_FLAGGED and f["loss_rate"] > a["loss_rate"]


def main(argv):
    path = argv[1] if len(argv) > 1 else DEFAULT_LOG
    summary = summarize(join(load(path)))
    for g in sorted(summary):
        s = summary[g]
        print(f"{g:24} n={s['n']:4} loss_rate={s['loss_rate']:.3f} pnl={s['pnl']}")
    print("PHASE2_GATE:", "READY" if gate(summary) else "NOT_READY")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

- [ ] **Step 4: Run the tests, the compile check, and the real log**

```bash
"$PY" -m pytest scripts/tests -v --tb=short
"$PY" -c "import py_compile; py_compile.compile('scripts/guard_report.py', doraise=True)"
test -f logs/order-guard.jsonl && "$PY" scripts/guard_report.py || echo "no log yet"
```

Expected: `9 passed` (4 here + 5 from Task 1, if Task 1 is done; otherwise 4); no compile output; a `PHASE2_GATE:` line or `no log yet`.

- [ ] **Step 5: Commit**

```bash
git add scripts/guard_report.py scripts/tests/test_guard_report.py
git commit -m "feat(guard): report loss rate of flagged vs approved entries"
```

---

## After all tasks (user gate, not executor work)

1. ~~**D2 confirmation** before Task 4 runs.~~ Done: the user confirmed C on 2026-10-20.
2. Review and restart the TXF collector (Task 1 diff is uncommitted on purpose).
3. Trade on the paper terminal in shadow mode. Every entry needs a stop to be "clean".
4. Run `python scripts/guard_report.py` weekly. When it prints `PHASE2_GATE: READY`, the user changes `GUARD_MODE` to `"enforce"` in `src/services/guard/orderGuard.ts`, **but only after the Phase 2 prerequisites below are done**.
4a. **Phase 2 prerequisites（enforce 之前必補，Phase 1 不做）：**
   - `demoApi.modifyOrder` 也要過守門員：PENDING 掛單可在成交前清空或拉寬停損（`OrderModifyDialog.tsx` 會送 `stopLoss: null`），enforce 下這是繞過路徑。
   - `TradingPage.tsx` 的 `OrderConfirmDialog onConfirm`（`._submit().then(...).finally(...)`）沒有 `.catch`，行動版一鍵下單是 `.catch(() => {})`。enforce 的 `Guard veto` 會變成未處理的 rejection 或被靜默吞掉，必須補 `toast.error`。這是既有 bug（engine 本來就會丟 `No tradable price`），enforce 只是讓它更常發生。
   - 掛單成交的結果要能 join：在 `fillOrder` 發出 `OrderFilled` 後記一行 `{kind:"fill", orderId, positionOpenedAt}`，或讓 Position 帶 `orderId`。
5a. **附帶發現（Phase 1 不處理）：** `low_reliability_setup` 在日誌裡是 noul 型（`{"noul":0.68}`），`should_escalate` 讀 `value`/`choice`，所以 `lr_num` 恆為 0，該升級分支是死碼。
5. Out of scope for Phase 1, in order of value: TXF order entry (connect `/vela` and the order path, or wire `shioajiApi` through the guard); Pine `alert()` JSON as an entry condition (each alert payload must carry `time`, because `RunResult.alerts` has no bar index: `src/pine/builtins/plot.ts` pushes `{ id, msg }` only); VELA `chart.drawings.add('position', …)` R:R box.

## Fact Annex (verified 2026-10-19)

| Fact | Evidence |
|---|---|
| All UI orders go through `api.placeOrder` | `OrderPanel.tsx` `placeOrder.mutateAsync` → `queries.ts:336` `api.placeOrder`; `TradingPage.tsx:309,648,656`; `WatchlistPanel.tsx:137` `usePlaceOrder` |
| `api` is a Proxy over `demoApi` | `src/services/api.ts:114` `export const api = new Proxy(demoApi …` |
| `demoApi.placeOrder` | `src/services/demo/api.ts:147` |
| One-click bypasses the dialog | `OrderPanel.tsx` `if (oneClick && orderType === "MARKET") {` → `doSubmit()` |
| Closed records are newest-first and carry `openedAt` | `engine.ts` `recordClose` → `closed.unshift({ … openedAt: pos.openedAt …` |
| Bus API | `src/services/demo/bus.ts` `subscribeChannel(channel, handler)`, `publish(channel, event)`; channel `closed-positions` unused before this plan |
| `/jev` sidecar exists | `vite.config.ts` proxy `/jev` → `127.0.0.1:8787`; `scripts/jev-sidecar.py` `POST /decide` |
| Collector gate bug | `logs/jev-shadow.jsonl`, 61 rows with `risk_gate` on 2026-10-19, all `veto/volatile`; `volatility_regime.legend["2"]` starts with `Volatile:` |
| Collector imports cleanly | `importlib` load of `scripts/jev-shadow.py` exposes `RiskSession`, `should_escalate` |
| Python with pandas + pytest | `C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe` (pinned in `scripts/jev-shadow-watchdog.ps1`) |
| Scripts | `package.json`: `dev`=`vite`, `typecheck`=`tsc --noEmit`, `test`=`vitest run`; `tsconfig.json` `include: ["src", "vite-env.d.ts"]`, `noUncheckedIndexedAccess: true` |
| Uncommitted user changes at planning time | `git status`: `scripts/jev-shadow.py`, `scripts/jev-sidecar.py`, `src/pages/VelaPage.tsx`, `src/services/shioaji/*.ts`, others |

## Plan Revision Log

- 2026-10-20（執行前，依外部審查 + 實測修訂）：
  - Baseline 不跑全庫 vitest（實測 6.4 分鐘，會被 2 分鐘工具逾時砍掉），改跑 Task 3 會比對的兩個檔。
  - `reward_risk` 改為有方向：停利在虧損側直接 veto（原 `Math.abs` 會把 TP 90 / entry 100 / SL 98 算成 R:R 5.0 放行）。
  - `cooldown_after_loss` 改讀最新一筆平倉，不限日曆日（23:58 虧損、00:01 進場原本會漏擋）。
  - `checkStopChange` 新增 `stop_invalid`（0、負數、NaN）。停損移過現價**不擋**：立即出場是降低風險，擋了違反 Spec invariant。
  - `guardedPlaceOrder` 的 `lastPrice` 退回 `getSeedPrice`，和 engine 的市價成交價一致（原本未 tick 時為 0，價格規則全跳過）。
  - outcome 訂閱加 `import.meta.hot?.dispose`（預防性）：若 HMR 重跑 `guardRuntime.ts` 而 `bus.ts` 保留舊訂閱者，改一次規則就多一行 outcome，報表損益翻倍。使用者決定保留此行、不另做實測（2026-10-20）。
  - `RiskSession.gate` 的 `choice == 'flat'` 改為 `choice in ('flat', 'hold')`（使用者決定 2026-10-20）：Jev 只回 buy/hold/sell，原條件永遠不成立，hold 棒（約 83%）會落到 approve/reduce，`risk_gate` 統計失真。修正後 hold 棒記為 `veto / flat`。
  - `stop_invalid` 對 SHORT 的 0／負停損也會擋（那種停損會立即出場）。這和「停損移過現價不擋」不衝突：0、負數、NaN 是無效輸入，不是降低風險的動作。
  - 測試數：Task 2 20 → 23，Task 3 5 → 6。
  - Task 3 Step 6 補上 `import.meta.hot?.dispose` 的 grep，和 Done when 對齊。
  - D2 由使用者確認採方案 C（Vite dev middleware），Task 4 不再等人確認。
  - 審查後**不採納**：在 `should_escalate` 用 `_is_volatile` 取代 `vnum >= 1.0`（會打破 `test_score_one_still_escalates`，且是升級成本取捨不是 bug）；`postGuardLog` 的 mode（`...event` 在後，明確 mode 會覆蓋）；`EntryIntent.type`（沒有任何 UI 入口在 MARKET 單帶 price）；`guard_report.load` 防呆（Step 4 已有 `test -f`）。

## Review Ledger

(empty, the executor appends `Baseline:`, `Task <N>: minor (deferred): …`, rulings, and fix rounds here)
