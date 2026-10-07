# Watchdog 告警檔案化 + 08:30 自動開工可靠化 Implementation Plan

> **日期：** 2026-09-29
> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除所有要使用者手按「確定」的 modal 視窗（告警/Backfill 完成通知），把告警集中寫進 `logs/watchdog-alerts.log`；同時修好 `OpenCharts-TradingDay-Bootstrap` 排程，讓 08:30 自動開工在機器睡眠/用電池時也能觸發。

**Architecture:**
- `Send-Alert`（已改完）只寫檔＋音效＋webhook，不跳視窗。本計劃處理剩下兩個 popup 源頭（`Invoke-Backfill` 的完成 MessageBox、`start-trading-day.ps1` 的 Send-Alert MessageBox）。
- scanner 異常訊息按原因分流：進程消失（stall guard 自殺/異常退出）vs 進程活著但 120s 無 tick（殭屍）。`Test-Scanner` 增加 `[ref]$reason` 輸出。
- 排程改 `WakeToRun=$true`、關掉電池/閒置阻擋，讓 08:30 必醒必跑。

**Tech Stack:** PowerShell 5.1（WindowsPowerShell v1.0）、ScheduledTasks module、Python 3.12（`python -m hotscan`）。

## Global Constraints

- 檔案編碼：`.ps1` 內含中文，所有讀寫用 `read`/`edit`/`write` 工具，避免 shell 內嵌 `$`/`$_`（bash 層會吃掉）。驗證用 `.ps1` 檔 + `powershell -File` 執行。
- 不改 scanner Python 邏輯；本計劃只動 PowerShell 與 Task Scheduler。
- 通知降級後仍保留：`watchdog.log` 主日誌、`logs\watchdog-alerts.log` 專用告警檔、系統音效、`$AlertWebhook`。
- 變動需不破壞盤中運作：watchdog 重啟後立即驗證 heartbeat 更新。

## Decision Points

### D1: 告警落地位置（T1）
- Consumed by: Task 1, Task 2
- Candidates:
  - A (existing pattern): 沿用 `watchdog.log` — `Send-Alert` 已 `Log "ALERT: ..."` 到主日誌
  - B (minimal): 不額外寫檔，只靠 `watchdog.log`
  - C (preferred): 另開 `logs\watchdog-alerts.log` 專用檔，alert 集中可看
- Criteria:
  - 告警可單獨檢視，不混在 15s/次的 backfill skip 雜訊裡
  - 需要回查歷史告警時可用一個檔案完成
  - 不增加第三種寫入路徑
- Chosen: C
- Rejected: B 讓告警淹沒在 `watchdog.log` 的常態訊息中；A 等同 B。
- Revisit trigger: 若 `watchdog-alerts.log` 增長過快（>1000 行/週），改回主日誌。
- Outcome: held

### D2: scanner 異常原因怎麼分流（T1）
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): 維持 bool，alert 一律寫「進程不存在或盤中無 tick」
  - B (minimal): `Test-Scanner` 增加 `[ref]$reason` 參數，主迴圈直接判
  - C (preferred): 拆成 `Test-ScannerProc` + `Test-TickFresh` 兩個獨立檢查
- Criteria:
  - 主迴圈能用一個呼叫取得失敗原因
  - 不改變既有的「重啟門檻 >5 分鐘」節流行為
  - 呼叫點只有一處，複雜度不擴散
- Chosen: B
- Rejected: A 保留誤導訊息（本次要修的就是它）；C 引入兩個新函式但呼叫點只有一處，收益不成比例。
- Revisit trigger: 若未來 `Test-Scanner` 需要在 2+ 個地方呼叫，改拆函式。
- Outcome: held

### D3: 排程改多少（T1）
- Consumed by: Task 4
- Candidates:
  - A (existing pattern): 只加 `WakeToRun`
  - B (minimal): 加 `WakeToRun` + `DisallowStartIfOnBatteries/StopIfGoingOnBatteries=false`
  - C (preferred): B 再加 `RunOnlyIfIdle=false`、每日觸發（不依賴 DaysOfWeek 62）
- Criteria:
  - 機器睡眠到 08:30 時能喚醒執行
  - 插電池/未插電都能跑
  - 週末/休市由 `start-trading-day.ps1` 內部 `Test-TradingDay` 判斷，排程不誤殺
- Chosen: B
- Rejected: A 在用電池時仍被擋；C 改動觸發器範圍超出本次需求（每週一~五 62 = Mon-Fri 已對）。
- Revisit trigger: 若改為每日觸發且 `start-trading-day.ps1` 能在休市安全退出，再考慮 C。
- Outcome: held

---

### Task 1: 移除 Invoke-Backfill 的「Backfill 完成」MessageBox

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1`（`Invoke-Backfill` 的 `Start-Job` 區塊，原碼見下）

**Interfaces:**
- Consumes: 既有的 `$AlertsFile`（已在 Task 0 加入，path = `logs\watchdog-alerts.log`）
- Produces: 完成通知只進 `watchdog-alerts.log` + 主日誌，不再跳窗。

**Assumptions:** `Start-Job` 裡 `param($procId, $logFile, $errLog, $webhook)` 可擴充一個 `$alertsFile` 參數；不改 `Wait-Process` 行為。

**Done when:**
- `scripts\shioaji-watchdog.ps1` 語法 parse 通過
- `MessageBox` 字串在該檔案全部消失
- `Start-Job` 的 `ArgumentList` 傳入 `$AlertsFile`，job 內 `Add-Content` 寫到該檔
- webhook + Asterisk 音效保留

- [ ] **Step 1: 取得原碼對照**

原碼（anchor：`Start-Job -ScriptBlock` ~ `} -ArgumentList $p.Id, $LogFile, $errLog, $AlertWebhook | Out-Null`）：

```powershell
    # 完成通知: 獨立 job 等它結束, 不卡 watchdog loop
    Start-Job -ScriptBlock {
      param($procId, $logFile, $errLog, $webhook)
      Wait-Process -Id $procId -ErrorAction SilentlyContinue
      $tail = (Get-Content $errLog -Tail 3 -ErrorAction SilentlyContinue) -join ' | '
      $msg = "pid=$procId 結束. err tail: $tail"
      Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') backfill done — $msg" -ErrorAction SilentlyContinue
      try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
      try {
        Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList @(
          "-NoProfile","-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$($msg -replace "'","''")','Backfill 完成','OK','Information') | Out-Null")
      } catch {}
      if ($webhook) {
        try { Invoke-RestMethod -Uri $webhook -Method Post -TimeoutSec 10 `
          -Body (@{text = "Backfill 完成 — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null } catch {}
      }
    } -ArgumentList $p.Id, $LogFile, $errLog, $AlertWebhook | Out-Null
```

- [ ] **Step 2: 替換為寫檔版本**

```powershell
    # 完成通知: 獨立 job 等它結束, 不卡 watchdog loop; 寫檔不跳窗
    Start-Job -ScriptBlock {
      param($procId, $logFile, $errLog, $webhook, $alertsFile)
      Wait-Process -Id $procId -ErrorAction SilentlyContinue
      $tail = (Get-Content $errLog -Tail 3 -ErrorAction SilentlyContinue) -join ' | '
      $msg = "pid=$procId 結束. err tail: $tail"
      Add-Content $logFile "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') backfill done — $msg" -ErrorAction SilentlyContinue
      $alertLine = "{0} | Backfill 完成 — {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
      Add-Content $alertsFile $alertLine -ErrorAction SilentlyContinue
      try { [System.Media.SystemSounds]::Asterisk.Play() } catch {}
      if ($webhook) {
        try { Invoke-RestMethod -Uri $webhook -Method Post -TimeoutSec 10 `
          -Body (@{text = "Backfill 完成 — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null } catch {}
      }
    } -ArgumentList $p.Id, $LogFile, $errLog, $AlertWebhook, $AlertsFile | Out-Null
```

搜尋錨點：`"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show`（整段刪除）

- [ ] **Step 3: 語法驗證**

```powershell
# 存成 Temp\parse-check2.ps1 後執行
$f = 'C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1'
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs) | Out-Null
if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Output $_.Message } ; Write-Output 'SYNTAX FAIL' } else { Write-Output 'SYNTAX OK' }
```

Expected: `SYNTAX OK`

- [ ] **Step 4: 確認無 MessageBox 殘留**

```powershell
Select-String -Path 'C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1' -Pattern 'MessageBox|WScript|Popup' -SimpleMatch:$false
```

Expected: no matches

---

### Task 2: 移除 start-trading-day.ps1 的 Send-Alert MessageBox

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\start-trading-day.ps1`（`Send-Alert` 區塊，原碼見下）

**Interfaces:**
- Consumes: `$AlertWebhook`（環境變數，既有）
- Produces: 該腳本的 `Send-Alert` 走與 watchdog 相同的寫檔路徑。

**Assumptions:** `start-trading-day.ps1` 沒有 `$AlertsFile`，需新增 `Join-Path` 指向 `logs\watchdog-alerts.log`（`$LogDir` 已定義在檔頭）。

**Done when:**
- `start-trading-day.ps1` 語法 parse 通過
- `MessageBox` 字串消失
- `Send-Alert` 寫 `watchdog-alerts.log` + 音效 + webhook

- [ ] **Step 1: 取得原碼對照**

原碼（anchor：`function Send-Alert($title, $msg) {` ~ `}`，檔案行 22–35）：

```powershell
function Send-Alert($title, $msg) {
  Log "ALERT: $title — $msg"
  try { [System.Media.SystemSounds]::Hand.Play() } catch {}
  try {
    Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList @(
      "-NoProfile","-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$($msg -replace "'","''")','$title','OK','Warning') | Out-Null"
    )
  } catch {}
  if ($AlertWebhook) {
    try { Invoke-RestMethod -Uri $AlertWebhook -Method Post -TimeoutSec 10 `
      -Body (@{text = "$title — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null } catch {}
  }
}
```

- [ ] **Step 2: 替換為寫檔版本**

先在檔頭 `$AlertWebhook` 下方加一行（anchor：`$AlertWebhook = $env:SHIOAJI_ALERT_WEBHOOK`）：

```powershell
$AlertsFile = Join-Path $LogDir "watchdog-alerts.log"
```

再替換 `Send-Alert` 內容：

```powershell
function Send-Alert($title, $msg) {
  Log "ALERT: $title — $msg"
  try { [System.Media.SystemSounds]::Hand.Play() } catch {}
  $alertLine = "{0} | {1} — {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $title, $msg
  Add-Content -Path $AlertsFile -Value $alertLine -ErrorAction SilentlyContinue
  if ($AlertWebhook) {
    try { Invoke-RestMethod -Uri $AlertWebhook -Method Post -TimeoutSec 10 `
      -Body (@{text = "$title — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null } catch {}
  }
}
```

搜尋錨點：`Start-Process -FilePath "powershell" -WindowStyle Hidden -ArgumentList`（刪除整段 try/catch popup）

- [ ] **Step 3: 語法驗證**

```powershell
$f = 'C:\Users\bear9\OpenCharts\scripts\start-trading-day.ps1'
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs) | Out-Null
if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Output $_.Message } ; Write-Output 'SYNTAX FAIL' } else { Write-Output 'SYNTAX OK' }
```

Expected: `SYNTAX OK`

- [ ] **Step 4: 確認無 MessageBox 殘留**

```powershell
Select-String -Path 'C:\Users\bear9\OpenCharts\scripts\start-trading-day.ps1' -Pattern 'MessageBox|WScript|Popup'
```

Expected: no matches

---

### Task 3: watchdog scanner 異常訊息按原因分流

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1`（`Test-Scanner` + 主迴圈，原碼見下）

**Interfaces:**
- Consumes: `Test-Scanner`（改為帶 `[ref]$reason`）、`Get-ScannerProcs`、`Test-TickFresh`（既有）
- Produces: `Test-Scanner` 簽名 `Test-Scanner([ref]$reason)`；reason ∈ `'proc' | 'tick' | ''`

**Assumptions:** `Test-Scanner` 目前只有一個呼叫點（主迴圈）；節流條件 `(New-TimeSpan ... ).TotalMinutes -gt 5` 不動。

**Done when:**
- `Test-Scanner` 在進程消失時設 `$reason='proc'`、tick 靜默時設 `'tick'`
- 主迴圈按 reason 分兩種 alert 文案
- 語法 parse 通過

- [ ] **Step 1: 取得原碼對照**

`Test-Scanner` 原碼（anchor：`function Test-Scanner {` ~ `return $true\n}`，檔案行 58–76 附近）：

```powershell
function Test-Scanner {
  if (-not @(Get-ScannerProcs)) { return $false }
  # 盤中要求 tick 新鮮: 進程活著但資料死掉 = zombie, 視同不存在 → 觸發重啟
  $now = Get-Date; $t = $now.TimeOfDay
  $inMarket = ((Test-TradingDay) -and
               $t -gt [timespan]::Parse("09:00") -and
               $t -lt [timespan]::Parse("13:45"))
  if ($inMarket -and -not (Test-TickFresh)) { return $false }
  return $true
}
```

主迴圈原碼（anchor：`if ($isTradingDay -and $failStreak -eq 0 -and -not (Test-Scanner)` ~ `Send-Alert "hot-scanner 異常" ...`，本次已改成 reason split 但需改成 ref 版）：

```powershell
  if ($isTradingDay -and $failStreak -eq 0 -and -not (Test-Scanner) -and
      (New-TimeSpan -Start $lastScannerRestart -End (Get-Date)).TotalMinutes -gt 5) {
    $lastScannerRestart = Get-Date
    if ($procs.Count -eq 0) {
      Send-Alert "hot-scanner 停止" "進程不存在(stall guard 自殺或異常退出) — 自動重啟中"
    } else {
      Send-Alert "hot-scanner 無 tick" "盤中超過 120s 無新 tick — 視同殭屍，自動重啟中"
    }
    Start-Scanner
    Start-Sleep -Seconds 30
    Invoke-Backfill "scanner restart"
  }
```

- [ ] **Step 2: 改 `Test-Scanner` 為 `[ref]$reason` 版**

```powershell
function Test-Scanner([ref]$reason) {
  $reason.Value = ''
  if (-not @(Get-ScannerProcs)) { $reason.Value = 'proc'; return $false }
  # 盤中要求 tick 新鮮: 進程活著但資料死掉 = zombie, 視同不存在 → 觸發重啟
  $now = Get-Date; $t = $now.TimeOfDay
  $inMarket = ((Test-TradingDay) -and
               $t -gt [timespan]::Parse("09:00") -and
               $t -lt [timespan]::Parse("13:45"))
  if ($inMarket -and -not (Test-TickFresh)) { $reason.Value = 'tick'; return $false }
  return $true
}
```

- [ ] **Step 3: 改主迴圈呼叫點**

```powershell
  $scanReason = ''
  if ($isTradingDay -and $failStreak -eq 0 -and -not (Test-Scanner ([ref]$scanReason)) -and
      (New-TimeSpan -Start $lastScannerRestart -End (Get-Date)).TotalMinutes -gt 5) {
    $lastScannerRestart = Get-Date
    if ($scanReason -eq 'proc') {
      Send-Alert "hot-scanner 停止" "進程消失（stall guard 自殺或異常退出）— 自動重啟中"
    } else {
      Send-Alert "hot-scanner 無 tick" "盤中超過 120s 無新 tick，進程視同殭屍 — 自動重啟中"
    }
    Start-Scanner
    Start-Sleep -Seconds 30
    Invoke-Backfill "scanner restart"
  }
```

注意：`-not (Test-Scanner ([ref]$scanReason))` 語法需以副表達式包住呼叫以相容 PS5：`if (... -and -not (Test-Scanner ([ref]$scanReason)) ...)` 若 parser 報錯，改為先賦值：

```powershell
$scanOk = Test-Scanner ([ref]$scanReason)
if ($isTradingDay -and $failStreak -eq 0 -and -not $scanOk -and ...) { ... }
```

- [ ] **Step 4: 語法驗證**

同 Task 1 Step 3，Expected: `SYNTAX OK`

- [ ] **Step 5: 行為驗證（盤中觀察）**

下一次 tick stall 時檢查 `logs\watchdog-alerts.log`，應出現 `hot-scanner 無 tick | 盤中超過 120s ...` 而非舊的「進程不存在或盤中無 tick」。

---

### Task 4: 修 OpenCharts-TradingDay-Bootstrap 排程

**Files:**
- Modify: Windows Task Scheduler `OpenCharts-TradingDay-Bootstrap`（設定檔，非專案檔案）

**Interfaces:**
- Consumes: 既有 task action/trigger
- Produces: `WakeToRun=True`、`DisallowStartIfOnBatteries=False`、`StopIfGoingOnBatteries=False`、維持 `RunOnlyIfIdle=False`（現況 `StartWhenAvailable=True` 已是正確）

**Assumptions:** Task 已是 `Interactive` logon（`Principal=calvin`），代表只有登入時才會跑；若需要「未登入也跑」要另開 T2 討論（本次不動）。

**Done when:**
- `Get-ScheduledTask` 顯示 `WakeToRun=True`、`DisallowStartIfOnBatteries=False`、`StopIfGoingOnBatteries=False`
- `schtasks /run` 手動觸發一次，確認 `LastTaskResult=0`
- 明早 08:30 驗收（out of scope 本次驗證，但標記在 changelog）

- [ ] **Step 1: 備份目前設定**

```powershell
Export-ScheduledTask -TaskName 'OpenCharts-TradingDay-Bootstrap' | Out-File 'C:\Users\bear9\OpenCharts\scripts\OpenCharts-TradingDay-Bootstrap.backup.xml' -Encoding utf8
```

- [ ] **Step 2: 更新 settings**

存成 `.ps1` 後執行：

```powershell
$t = Get-ScheduledTask -TaskName 'OpenCharts-TradingDay-Bootstrap'
$s = $t.Settings
$s.WakeToRun = $true
$s.DisallowStartIfOnBatteries = $false
$s.StopIfGoingOnBatteries = $false
$s.RunOnlyIfIdle = $false
$s.IdleSettings.StopOnIdleEnd = $false
$s.IdleSettings.WaitTimeout = 'PT0S'
Set-ScheduledTask -TaskName 'OpenCharts-TradingDay-Bootstrap' -Settings $s | Out-Null
```

- [ ] **Step 3: 驗證設定**

```powershell
$t = Get-ScheduledTask -TaskName 'OpenCharts-TradingDay-Bootstrap'
$t.Settings | Select-Object WakeToRun, DisallowStartIfOnBatteries, StopIfGoingOnBatteries, RunOnlyIfIdle, StartWhenAvailable
```

Expected: `WakeToRun=True`、兩個 Batteries=False、`RunOnlyIfIdle=False`、`StartWhenAvailable=True`

- [ ] **Step 4: 手動觸發一次確認能跑（不影響盤中）**

```powershell
Start-ScheduledTask -TaskName 'OpenCharts-TradingDay-Bootstrap'
Start-Sleep -Seconds 20
Get-ScheduledTaskInfo -TaskName 'OpenCharts-TradingDay-Bootstrap' | Select-Object LastRunTime, LastTaskResult
```

Expected: `LastTaskResult=0`，且 `logs\start-trading-day.log` 新增 `=== start-trading-day ===` 區塊。

注意：手動觸發會走 `start-trading-day.ps1` 的完整流程（server 已在跑會走 `server OK` 分支；scanner 已在跑會被 `killed N old scanner` 替換）。盤中執行需評估是否可接受替換 scanner；**若正值盤中，改為只讀驗證 Step 3，不執行本步驟**，等收盤後補。

---

## Self-Review

- Spec coverage: 使用者要求「不要跳視窗、寫檔」→ Task 1、2 處理全部 MessageBox 源頭；「進程不存在訊息誤導」→ Task 3；「08:30 自動開工」→ Task 4。
- Date check: 檔名含 `2026-09-29`、header 含 `> **日期：** 2026-09-29`。
- Placeholder scan: 無 TBD/TODO/「similar to」。
- Type consistency: `Test-Scanner([ref]$reason)` 呼叫點與定義一致；`$AlertsFile` 在兩個檔案指向同一 `logs\watchdog-alerts.log`。
- Anchor scan: 每個既有碼修改都有原碼 verbatim + replacement + anchor 字串。
- Decision scan: D1/D2/D3 都是 T1，各自含 3 候選、literal criteria、revisit trigger。無 T2。
- Done-when scan: 每個 task 有 ≥1 條可驗證命令或邊界條件；Task 4 有「若盤中則不執行 Start-ScheduledTask」的邊界。
