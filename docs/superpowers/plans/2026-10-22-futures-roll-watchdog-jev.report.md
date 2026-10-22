# 期貨自動換月 Phase 2 實作報告

> 計畫：`docs/superpowers/plans/2026-10-22-futures-roll-watchdog-jev.md`
> 實作日期：2026-10-21
> 狀態：完成，全部驗證通過（未重啟任何程序，未做 git 操作）

---

## 1. 改了哪些檔

| 檔案 | 動作 | 內容 |
|---|---|---|
| `scripts/front_month_cases.json` | 新增 | 共用測試案例陣列，9 筆。三處實作（web / python / powershell）都讀這一份。 |
| `scripts/jev-shadow.py` | 修改 | 新增 `roll_time_ms` / `pick_front_month` / `fetch_r1_info` / `resolve_front_month` / `_warn_once_a_day`；主迴圈改呼叫 `resolve_front_month("TXF")`。`front_month_symbol()` 行為完全不變。 |
| `scripts/tests/test_front_month_shared.py` | 新增 | 讀 `front_month_cases.json` 逐筆驗 `pick_front_month`；另測 `fetch_r1_info` 失敗回 `None` 與成功解析。 |
| `scripts/shioaji-watchdog.ps1` | 修改 | 新增 `Select-FrontMonth` / `Get-R1Info` / `Resolve-FrontMonth` / `Get-FopSessionWindow`；`Test-TradingDay` 改為 `Test-TradingDayOn($dateStr)` 的薄包裝（行為不變）；夜盤時段擴充；新增 `-SelfTest`。`Get-FrontMonth` 原樣保留。 |
| `src/services/__tests__/frontMonthPick.test.ts` | 修改 | 新增 `describe("shared front-month cases")`，讀 `scripts/front_month_cases.json` 逐筆驗 `pickFrontMonth`。 |

未動：`src/services/shioaji/frontMonth.ts`、`instruments.ts`、`feed.ts`、`vite.config.ts`、`src/pages/VelaPage.tsx`。

---

## 2. 判斷邏輯（三處一致）

`pickFrontMonth`（web）/ `pick_front_month`（python）/ `Select-FrontMonth`（powershell）四條規則完全相同：

1. 券商資料拿不到（`info == null`）→ 用規則，**不警告**。
2. `target_code` 或 `last_trading_date` 缺 → 用規則，警告「券商合約資料不完整」。
3. `now >= last_trading_date 13:45`（台北）→ 用規則，警告「已過最後交易日（資料尚未更新）」。
4. 否則用 `target_code`；與規則碼不同 → 警告「可能假日或颱風順延，以券商為準」；相同 → 無警告。

警告文字逐字沿用 `frontMonth.ts` 的原文。

### 共用案例（9 筆）

| name | info | rule | now | expect |
|---|---|---|---|---|
| broker agrees with rule | TMFK6 / 2026-11-18 | TMFK6 | 2026-10-21T14:10 | TMFK6 / broker / 無警告 |
| holiday or typhoon postponement | TMFJ6 / 2026-10-22 | TMFK6 | 2026-10-21T14:10 | TMFJ6 / broker / **警告** |
| broker data is stale | TMFJ6 / 2026-10-21 | TMFK6 | 2026-10-21T14:10 | TMFK6 / rule / **警告** |
| server unreachable | `null` | TMFK6 | 2026-10-21T14:10 | TMFK6 / rule / 無警告 |
| incomplete (target_code null) | null / 2026-11-18 | TMFK6 | 2026-10-21T14:10 | TMFK6 / rule / **警告** |
| incomplete (last_trading_date null) | TMFK6 / null | TMFK6 | 2026-10-21T14:10 | TMFK6 / rule / **警告** |
| rolls across the year end | TMFA7 / 2027-01-20 | TMFA7 | 2026-12-16T14:00 | TMFA7 / broker / 無警告 |
| exactly 13:45:00 | TMFJ6 / 2026-10-21 | TMFK6 | 2026-10-21T13:45:00 | TMFK6 / rule / **警告** |
| 13:44:59 | TMFJ6 / 2026-10-21 | TMFK6 | 2026-10-21T13:44:59 | TMFJ6 / broker / **警告** |

---

## 3. 驗證紀錄

### 3.1 vitest

```
> npx vitest run src/services/__tests__/frontMonthPick.test.ts src/services/__tests__/frontMonth.test.ts

 ✓ src/services/__tests__/frontMonth.test.ts (5 tests) 14ms
 ✓ src/services/__tests__/frontMonthPick.test.ts (20 tests) 45ms

 Test Files  2 passed (2)
      Tests  25 passed (25)
```

（frontMonthPick 20 = 原有 11 + 共用案例 9）

### 3.2 pytest

```
> python -m pytest scripts/tests/test_front_month_shared.py scripts/tests/test_jev_front_month.py -v

collected 15 items
scripts/tests/test_front_month_shared.py::test_pick_front_month_matches_shared_cases[broker agrees with rule] PASSED
... (9 筆共用案例全 PASSED)
scripts/tests/test_front_month_shared.py::test_fetch_r1_info_returns_none_when_unreachable PASSED
scripts/tests/test_front_month_shared.py::test_fetch_r1_info_reads_target_code_and_last_trading_date PASSED
scripts/tests/test_jev_front_month.py::test_expiring_month_holds_through_the_expiry_day_session PASSED
scripts/tests/test_jev_front_month.py::test_rolls_at_1345_so_the_night_session_polls_next_month PASSED
scripts/tests/test_jev_front_month.py::test_december_rolls_into_next_year PASSED
scripts/tests/test_jev_front_month.py::test_bare_date_is_midnight PASSED

============================= 15 passed in 2.45s =============================
```

`test_jev_front_month.py` 4 筆全過 → `front_month_symbol()` 行為未被破壞。

### 3.3 py_compile

```
> python -c "import py_compile; py_compile.compile('scripts/jev-shadow.py', doraise=True); print('compile OK')"
compile OK
```

### 3.4 PowerShell -SelfTest

```
> powershell -NoProfile -ExecutionPolicy Bypass -File scripts/shioaji-watchdog.ps1 -SelfTest

PASS  broker agrees with rule  code=TMFK6 source=broker warning=False
PASS  holiday or typhoon postponement follows the broker  code=TMFJ6 source=broker warning=True
PASS  broker data is stale (past its last trading day)  code=TMFK6 source=rule warning=True
PASS  server unreachable falls back to the rule silently  code=TMFK6 source=rule warning=False
PASS  incomplete broker data falls back with a warning  code=TMFK6 source=rule warning=True
PASS  missing last_trading_date is incomplete broker data  code=TMFK6 source=rule warning=True
PASS  rolls across the year end  code=TMFA7 source=broker warning=False
PASS  exactly 13:45:00 is already rolled over  code=TMFK6 source=rule warning=True
PASS  13:44:59 is still the old contract  code=TMFJ6 source=broker warning=True
front-month self-test: 9 passed, 0 failed, 9 total
SELFTEST_EXIT=0
```

### 3.5 PowerShell 語法檢查

```
> powershell -NoProfile -Command '$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile("scripts/shioaji-watchdog.ps1", [ref]$null, [ref]$e); $e'
（無輸出）
SYNTAX_EXIT=0
```

### 3.6 真打一次（唯讀）

```
> python -c "load jev-shadow module; resolve_front_month('TXF')"
info: {'target_code': 'TXFK6', 'last_trading_date': '2026-11-18'}
resolve: TXFK6
rule  : TXFK6
pick: {'code': 'TXFK6', 'source': 'broker', 'warning': None}
```

預期 `TXFK6, broker` → **符合**。

同樣方式驗了 watchdog 用的兩個 root：

```
TMF {'target_code': 'TMFK6', 'last_trading_date': '2026-11-18'} {'code': 'TMFK6', 'source': 'broker', 'warning': None}
MXF {'target_code': 'MXFK6', 'last_trading_date': '2026-11-18'} {'code': 'MXFK6', 'source': 'broker', 'warning': None}
```

### 3.7 額外煙霧測試（非計畫要求，但用來證明行為）

**看門狗函式（唯讀，不進主迴圈）**

```
rule TMF 2026-10-21: TMFJ6
rule TMF 2026-12-16: TMFL6
rule TXF 13:44: TXFJ6
rule TXF 13:45: TXFK6
tradingday today: True
tradingday yesterday: True
r1 info TMF: {"last_trading_date":"2026-11-18","target_code":"TMFK6"}
resolve TMF: TMFK6
resolve MXF: MXFK6
vela contracts: 2330 TMFK6 MXFK6
```

**夜盤時段視窗 `Get-FopSessionWindow`**

```
2026-10-21 08:49:00 -> InSession=False Night=False
2026-10-21 08:51:00 -> InSession=True  Night=False
2026-10-21 13:44:00 -> InSession=True  Night=False
2026-10-21 13:46:00 -> InSession=False Night=False
2026-10-21 15:04:00 -> InSession=False Night=False
2026-10-21 15:06:00 -> InSession=True  Night=True
2026-10-21 23:59:59 -> InSession=True  Night=True
2026-10-22 00:00:00 -> InSession=True  Night=True
2026-10-22 04:55:00 -> InSession=True  Night=True
2026-10-22 04:56:00 -> InSession=False Night=False
```

**交易日快取 fake flag**

```
fake closed fresh key: False
fake open fresh key: True
```

**python 警告一次/天 + ERRLOG**

```
front month warning: test warning message
errlog lines: 1
content: {"ts":1792565493.66,"kind":"front_month","message":"test warning message"}
```

（同一訊息連續呼叫兩次，第二次沒有再 append。）

---

## 4. 實作細節與取捨

### jev-shadow.py

- `front_month_symbol()` **原樣保留**（`scripts/tests/test_jev_front_month.py` 依賴它）。
- `pick_front_month(info, rule_code, now)` 回傳 `{"code", "source", "warning"}`。
- `fetch_r1_info(root)`：`urllib.request.urlopen(f"{SHIOAJI}/api/v1/data/contracts/{root}R1/info", timeout=5)`，任何例外 → `None`。
- `resolve_front_month(prefix)`：結果快取 **10 分鐘**（`FRONT_MONTH_TTL = 600`）；警告用 `print` 並 append 一行 JSON 到既有 `ERRLOG`（`kind: "front_month"`），同一訊息一天只記一次（key = `(日期, 訊息)`）。
- 主迴圈兩處（初始化 / 每輪 roll 檢查）都改呼叫 `resolve_front_month("TXF")`。
- `roll_time_ms()` 用 `datetime(...).timestamp() * 1000`，與 web 端 `Date.UTC(...) - TAIPEI_OFFSET_MS + 13:45` 等價（台北固定 UTC+8，無 DST）。

### shioaji-watchdog.ps1

- `param([switch]$SelfTest)` 放在腳本最上方（註解之後、`$ErrorActionPreference` 之前），合法位置。
- `Get-FrontMonth`（規則）原樣保留，`Resolve-FrontMonth` 為其上層包裝。
- `Get-R1Info($root)`：`Invoke-RestMethod -TimeoutSec 5`，失敗 → `$null`。
- `Resolve-FrontMonth($root)`：快取 **5 分鐘**；警告走 `Log` + `Send-Alert "換月提醒"`，同一訊息一天一次（key = `日期|訊息`）。
- `Get-VelaContracts` 改用 `Resolve-FrontMonth "TMF"` / `"MXF"`。
- 交易日判斷：新增 `Test-TradingDayOn($dateStr)`（把 `hotscan.tradingday --date YYYY-MM-DD` 傳進去），原本的 `Test-TradingDay` 保留為呼叫 `Test-TradingDayOn (今天)` 的薄包裝 → **原本行為不變**（含 15s timeout、fail-open、fake flag、cache）。
- 夜盤：`Get-FopSessionWindow($now, $isTradingDay)` 判斷 日盤 08:50–13:45 / 夜盤 15:05–23:59:59 / 00:00–04:55。15:05 起看「今天是否交易日」；00:00–04:55 看「昨天是否交易日」。
- 夜盤告警文字加「（夜盤檢查，若今天颱風停市可忽略）」。
- `-SelfTest`：讀 `front_month_cases.json` 逐筆跑 `Select-FrontMonth`，印每筆 PASS/FAIL + 總結，全過 exit 0 否則 exit 1；在 `param` 區塊之後、mutex 之前就 `exit`，**不進主迴圈、不啟動任何東西**。

---

## 5. 遇到的問題

1. **vitest 讀相對路徑**：`new URL("../../../scripts/...", import.meta.url)` 在 vitest 環境下 `import.meta.url` 不是 file:// scheme → `TypeError: The URL must be of scheme file`。
   處理：改用 `resolve(process.cwd(), "scripts", "front_month_cases.json")`（vitest 的 cwd = repo 根）。已驗過。

2. **PowerShell 語法檢查指令在 bash 下引號被吃掉**：原本寫 `[ref]$e` 未先宣告 `$e` → `[ref] 不可套用到不存在的變數`。
   處理：改用 `'$e = $null; ... [ref]$e ...'` 單引號包住整段，且先 `$e = $null` 初始化。

3. **`Test-TradingDay` 的 cache key 原本綁 `$today`**：擴充成可傳日期時若沿用會把「昨天」的結果寫進「今天」的 key。處理：改成用傳入的 `$dateStr` 作 key。

4. **假設 `hotscan.tradingday` 支援 `--date`**：讀 `scripts/hotscan/tradingday.py` 確認有 `--date` 參數（`date.fromisoformat`）且 `is_trading_day(d)` 支援傳日期 → 夜盤凌晨查昨天可行。

5. **夜盤歸屬的邊界**：00:00–04:55 屬前一晚；`Get-FopSessionWindow` 以 `04:55:00` 含、`04:56` 不含；`23:59:59` 仍在夜盤。

---

## 6. 未做 / 待 Opus 處理

- **未重啟任何程序**（8080 / shioaji / 看門狗 / jev-shadow 都沒動），依鐵律由 Opus 驗收後重啟。
- **未做任何 git 操作**（無 add / commit / stash / checkout / reset）。
- **未執行 plan 的驗收第 2 項**（`HOTSCAN_FAKE_TRADING_DAY` ＋ 假 R1 回應跑 log/alert 內容）：這需要實際進入看門狗主迴圈，會碰到 server 啟動路徑，違反「不准啟動任何程序」的鐵律。等 Opus 重啟看門狗後，可用 8080 實際回應驗證（券商資料過期時應看到 `換月提醒` alert）。
- **未執行 plan 的驗收第 3 項**（實戰夜盤 15:05 後 log 出現夜盤 tick_fop 檢查紀錄）：需等到當日 15:05 之後，且看門狗要重啟。
- `docs/superpowers/plans/2026-10-22-futures-roll-watchdog-jev.md` 提到的「換約當晚專檢」（結算日 15:05 起若新合約無 tick → 立即補訂 + 特定 alert）以既有 `$fopMissing` 補訂邏輯涵蓋，未另加新 alert 標題。

---

## Opus 驗收（2026-10-21 夜盤）

| 驗收項目 | 結果 |
|---|---|
| 1. 共用案例：vitest 25、pytest 37、`-SelfTest` 9/9、py_compile、PS 語法 | ✅ Opus 重跑通過；範圍檢查只多出 3 個預期內的新檔 |
| 2. 模擬：看門狗（AST 抽出函式，`Get-R1Info`／`Send-Alert` 換成假的） | ✅ 5/5：順延→TMFJ6＋1 次警告；過期→規則碼＋1 次警告；8080 斷線→規則碼、不警告；正常→不警告；同一訊息第二次查詢不重發；5 分鐘內用快取、不再查券商。腳本：scratchpad `wd-sim.ps1` |
| 2. 模擬：jev-shadow（`fetch_r1_info` 換成假的，ERRLOG 導到暫存檔） | ✅ 4/4：同上四種情境；警告只寫 1 行 `kind: front_month`，不重複 |
| 3a. 實戰：夜盤檢查有在跑 | ✅ 看門狗 15:13 重啟到新版；15:45–16:04 夜盤期間，8080 log 每 60–75 秒出現一次 `tick_fop` 探測；心跳檔持續更新 |
| 3b. 夜盤缺合約時自動補訂（實際觸發） | ⏳ 未實測：要在盤中刻意取消訂閱才能觸發，會影響使用者看盤。改在 11/18 換月當晚自然驗證 |
| jev-shadow 實際改用券商近月 | ⏳ 尚未重啟；排在非開盤時段，和 Phase 2b（改追 MXF）一起重啟 |

附帶發現（今晚）：15:00 夜盤開盤後沒有程式訂閱 TMFK6／MXFK6（舊版看門狗夜盤不檢查，`/vela` 也沒重新整理），Opus 先手動補訂，15:07 再把看門狗換成新版。換成新版後，同樣情況會自動補訂。
