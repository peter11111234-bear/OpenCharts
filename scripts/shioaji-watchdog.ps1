# Shioaji watchdog — 防呆總管
# 每 15s 檢查三件事，出問題寫進 logs/watchdog-alerts.log (+音效+webhook) 並自動重啟:
#   1. shioaji server 健康 (GET /api/v1/auth/accounts)
#   2. hot-scanner 進程存活
#   3. tick 資料新鮮度 (盤中 120s 無 tick = 異常)
# Run once (self-sustains):
#   powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1
# Optional: $env:SHIOAJI_ALERT_WEBHOOK = Discord/Slack webhook URL

$ErrorActionPreference = "SilentlyContinue"
$LogFile    = Join-Path $PSScriptRoot "watchdog.log"
$ProjectEnv = "C:\MyTradingProjects\.env"
$TickLog    = Join-Path $PSScriptRoot "..\logs\hot-ticks.jsonl"
$LogDir     = Join-Path $PSScriptRoot "..\logs"
$PythonExe  = "C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe"
$ScriptsDir = $PSScriptRoot
$HeartbeatFile = Join-Path $LogDir "watchdog-heartbeat.txt"
$AlertWebhook = $env:SHIOAJI_ALERT_WEBHOOK
$AlertsFile  = Join-Path $LogDir "watchdog-alerts.log"
function Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}
function Send-Alert($title, $msg) {
  Log "ALERT: $title — $msg"
  try { [System.Media.SystemSounds]::Hand.Play() } catch {}
  # 通知全部寫檔，不跳視窗（modal popup 會堆一堆要手動關）
  $alertLine = "{0} | {1} — {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $title, $msg
  Add-Content -Path $AlertsFile -Value $alertLine -ErrorAction SilentlyContinue
  if ($AlertWebhook) {
    try {
      Invoke-RestMethod -Uri $AlertWebhook -Method Post -TimeoutSec 10 `
        -Body (@{text = "$title — $msg"; content = "$title — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null
    } catch { Log "webhook failed: $_" }
  }
}


function Load-Keys {
  Get-Content $ProjectEnv | Where-Object { $_ -match '^(SHIOAJI_API_KEY|SHIOAJI_SECRET_KEY)=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    if ($k -eq 'SHIOAJI_API_KEY') { $env:SJ_API_KEY = $v }
    if ($k -eq 'SHIOAJI_SECRET_KEY') { $env:SJ_SEC_KEY = $v }
  }
}

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/auth/accounts" -TimeoutSec 10 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Get-ScannerProcs {
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -match 'hot-scanner\.py|-m\s+hotscan(?!\.)' }
}
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
# 交易日判斷: 邏輯唯一源頭在 hotscan/tradingday.py（TWSE 官方休市表+週末）。
# python 印 "open"/"closed"; 叫不出來或輸出異常 → fail-open 視為交易日, 保持監控。
$script:TradingDayCache = @{}
function Test-TradingDay {
  $today = (Get-Date).ToString("yyyy-MM-dd")
  if ($script:TradingDayCache.ContainsKey($today)) { return $script:TradingDayCache[$today] }
  $fake = $env:HOTSCAN_FAKE_TRADING_DAY  # 測試用: "1"=強制交易日, "0"=強制休市
  if ($fake -eq "1" -or $fake -eq "0") { $script:TradingDayCache[$today] = ($fake -eq "1"); return ($fake -eq "1") }
  $open = $true
  # python 同步呼叫若 hang 會卡死整個 watchdog loop; 用 job 限時 15s, timeout → fail-open
  $job = Start-Job -ScriptBlock {
    param($py, $dir)
    Push-Location $dir
    try { & $py "-u" "-m" "hotscan.tradingday" 2>$null } finally { Pop-Location }
  } -ArgumentList $PythonExe, $ScriptsDir
  $out = $null
  if (Wait-Job $job -Timeout 15) {
    $out = Receive-Job $job
  } else {
    Stop-Job $job -ErrorAction SilentlyContinue
    Log "WARN: tradingday.py timed out (>15s) — fail-open as trading day"
    # Stop-Job 不殺 job 內 spawn 的 python → 清掉孤兒
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
      Where-Object { $_.CommandLine -match 'hotscan\.tradingday' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $ans = @($out | Where-Object { $_ -match '^(open|closed)$' } | Select-Object -Last 1)
  if ($ans -eq "closed") { $open = $false }
  # timeout/叫不出來不 cache: 否則一早 python 卡死會把整天錯標成交易日
  if ($ans) { $script:TradingDayCache[$today] = $open }
  return $open
}

function Test-TickFresh {
  # 盤中才檢查: 交易日 09:05-13:35; 最後一筆 tick 超過 120s = 異常
  # 09:05 前不算: 開盤前本來就沒 tick, 08:55 起跑會誤報
  $now = Get-Date
  if (-not (Test-TradingDay)) { return $true }  # 週末+國定假日: 無 tick 是正常
  $t = $now.TimeOfDay
  if ($t -lt [timespan]'09:05:00' -or $t -gt [timespan]'13:35:00') { return $true }
  if (-not (Test-Path $TickLog)) { return $false }
  # 尾行可能是殘缺寫入 → 往回找 5 行內最後一筆可 parse 的 tick
  $last = $null
  Get-Content $TickLog -Tail 5 | ForEach-Object {
    try { $cand = $_ | ConvertFrom-Json; if ($cand.ts) { $last = $cand } } catch {}
  }
  if (-not $last) { return $false }
  # ts 驗證: 非整數/未來 5min+ → 改用檔案 mtime 判新鮮度
  $tsSec = 0L
  if (-not [long]::TryParse("$($last.ts)", [ref]$tsSec) -or
      $tsSec -le 0 -or $tsSec -gt ([datetimeoffset]::Now.ToUnixTimeSeconds() + 300)) {
    return ((New-TimeSpan -Start (Get-Item $TickLog).LastWriteTime -End $now).TotalSeconds -lt 120)
  }
  $lastTime = [datetimeoffset]::FromUnixTimeSeconds($tsSec).LocalDateTime
  return ((New-TimeSpan -Start $lastTime -End $now).TotalSeconds -lt 120)
}

function Start-Server {
  Load-Keys
  if (-not $env:SJ_API_KEY) { Log "FATAL: no API key in $ProjectEnv"; return }
  Get-Process shioaji -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  # 用絕對路徑啟動: PATH 裡可能有多個 shioaji/惡意同名牌
  $sjExe = "C:\Users\bear9\.openharness-venv\Scripts\shioaji.exe"
  $p = Start-Process -FilePath $sjExe -ArgumentList "server","start","--no-open" -PassThru -WindowStyle Hidden
  if (-not $p) { Log "server launch FAILED ($sjExe)"; return }
  $script:lastServerBoot = Get-Date
  $script:serverProc = $p
  Log "server start requested (pid=$($p.Id))"
  Start-Sleep -Seconds 12
  # 防呆: 剛啟動就退出 → 當 boot 失敗, 取消 grace 避免 90s 隱藏早死
  if ($p.HasExited) {
    $script:lastServerBoot = [datetime]::MinValue
    $script:serverBootFails++
    Log "server exited early (exit=$($p.ExitCode)) — boot fails x$($script:serverBootFails)"
  } else {
    $script:serverBootFails = 0
  }
}

function Start-Scanner {
  Get-ScannerProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  $p = Start-Process -FilePath $PythonExe -ArgumentList "-u","-m","hotscan" `
    -WorkingDirectory $ScriptsDir -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "scanner-out.log") `
    -RedirectStandardError (Join-Path $LogDir "scanner-err.log")
  if (-not $p) { Log "scanner launch FAILED"; return }
  Log "scanner start requested (pid=$($p.Id))"
}

# single-instance: 殺掉其他跑同一腳本的 watchdog, 只留自己
$me = $PID
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'shioaji-watchdog\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Log "=== watchdog started (server + scanner + tick-freshness + auto-backfill) ==="
$failStreak = 0
$lastTickAlert = [datetime]::MinValue
$lastServerAlert = [datetime]::MinValue
$lastBackfill = [datetime]::MinValue
$lastScannerRestart = [datetime]::MinValue
$lastServerBoot = [datetime]::MinValue
$script:serverProc = $null
$script:serverBootFails = 0
$wasStale = $false
$script:BackfillWatchers = @()
function Invoke-Backfill($reason) {
  # 去重: 已有 backfill 在跑就跳過 (restart/stale/periodic 可能同時觸發)
  # 清掉已完成的 watcher job, 避免累積
  Get-Job | Where-Object { $_.State -ne 'Running' } | Remove-Job -Force -ErrorAction SilentlyContinue
  if (Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
      Where-Object { $_.CommandLine -match 'hotscan\.backfill' }) {
    # 卡死 20min+ 的 backfill 會永久堵住後續 backfill → 殺掉放行
    $hung = Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
      Where-Object { $_.CommandLine -match 'hotscan\.backfill' -and
                     ((New-TimeSpan -Start $_.CreationDate -End (Get-Date)).TotalMinutes -gt 20) }
    if ($hung) {
      $hung | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
      Log "killed hung backfill (>20min) — proceeding"
    } else {
      Log "backfill skip: already running"; return
    }
  }
  Log "backfill triggered: $reason"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $LogDir "backfill-out-$stamp.log"
  $errLog = Join-Path $LogDir "backfill-err-$stamp.log"
  $p = Start-Process -FilePath $PythonExe -ArgumentList "-u","-m","hotscan.backfill" `
    -WorkingDirectory $ScriptsDir -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  if (-not $p) { Log "backfill launch FAILED"; return }
  Log "backfill launched (pid=$($p.Id)) — 不等待, 防止 child 卡死拖住 loop"
  # 完成通知: 獨立 job 等它結束, 不卡 watchdog loop; 寫檔不跳窗
  $script:BackfillWatchers += (Start-Job -ScriptBlock {
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
        -Body (@{text = "Backfill 完成 — $msg"; content = "Backfill 完成 — $msg"} | ConvertTo-Json) -ContentType 'application/json' | Out-Null } catch {}
    }
  } -ArgumentList $p.Id, $LogFile, $errLog, $AlertWebhook, $AlertsFile)
}

while ($true) {
  # 1. server health — process+port 存活為準，HTTP 超時只記 log 不殺
  #    （實測 2026-10-07: 機器高 load 時 Invoke-WebRequest 會誤超時把活著的 server 殺掉）
  $srvProc = Get-Process shioaji -ErrorAction SilentlyContinue
  $portUp = [bool](Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)
  $alive = ($srvProc -and $portUp)
  if ($alive) {
    if ($failStreak -ge 3) { Log "server recovered"; Send-Alert "Shioaji 已恢復" "server 回復正常" }
    elseif ($failStreak -gt 0) { Log "server recovered (transient fail x$failStreak)" }
    $failStreak = 0
    if (-not (Test-Server)) { Log "server proc+port alive but HTTP probe failed — keeping process (likely load stall)" }
  } else {
    $failStreak++
    # boot 寬限: 剛重啟 90s 內且進程還活著才算「開機中」; 已退出的不算
    $inBootGrace = ((New-TimeSpan -Start $lastServerBoot -End (Get-Date)).TotalSeconds -lt 90) -and
                   ($script:serverProc -and -not $script:serverProc.HasExited)
    if ($inBootGrace) {
      Log "server down but still in boot grace (<90s since start) — wait"
    } elseif ($failStreak -lt 3) {
      Log "server dead (proc=$( [bool]$srvProc ) port=$portUp, failStreak=$failStreak) — rechecking before restart"
    } elseif ($script:serverBootFails -ge 3 -and
              ((New-TimeSpan -Start $lastServerAlert -End (Get-Date)).TotalMinutes -lt 10)) {
      # 連續 3+ 次起不來且才告警過 → 不再盲殺, 10min 節流內停手
      Log "server keeps failing to boot (x$($script:serverBootFails)) — alert throttled, holding"
      Start-Sleep -Seconds 45
    } else {
      # server 掛著時會一直重試，但告警只 10min 一次，避免洗 alerts.log/webhook
      $alertServer = ((New-TimeSpan -Start $lastServerAlert -End (Get-Date)).TotalMinutes -gt 10)
      if ($alertServer) {
        $lastServerAlert = Get-Date
        Send-Alert "Shioaji server 掛了" "進程或 :8080 消失 x$failStreak — 自動重啟中"
      } else {
        Log "server dead (failStreak=$failStreak) — restarting"
      }
      Start-Server
      if (Test-Server) {
        Log "restart OK"; Send-Alert "Shioaji 重啟成功" "server 已恢復"; $failStreak = 0; $script:serverBootFails = 0
      } else {
        # 活著但 healthz 也起不來 = 也算 boot 失敗; 連續 3 次升級人工
        $script:serverBootFails++
        if ($script:serverBootFails -ge 3 -and $alertServer) {
          Send-Alert "Shioaji 重啟失敗 x$($script:serverBootFails)" "server 活著但 healthz 不通 — 需要人工介入"
        } elseif ($alertServer) { Send-Alert "Shioaji 重啟失敗" "需要人工介入" }
        else { Log "restart failed — retrying (boot fails x$($script:serverBootFails))" }
      }
      Start-Sleep -Seconds 45
    }
  }

  # 2. scanner process (含 zombie: 盤中無 tick) — 5min 冷卻防止重啟迴圈
  # 休市日: scanner 沒活幹, 殘留的只會刷 SSE reconnect log — 順手收掉一次
  $isTradingDay = Test-TradingDay
  $procs = @(Get-ScannerProcs)
  if (-not $isTradingDay -and $procs.Count -gt 0) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Log "non-trading day: stopped $($procs.Count) idle scanner proc(s)"
  }

  $scanReason = ''
  $scanOk = Test-Scanner ([ref]$scanReason)
  if ($isTradingDay -and $failStreak -eq 0 -and -not $scanOk -and
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

  # 3. tick freshness — stale → alert + backfill; recovered → backfill once
  $fresh = Test-TickFresh
  if (-not $fresh) {
    $wasStale = $true
    if ((New-TimeSpan -Start $lastTickAlert -End (Get-Date)).TotalMinutes -gt 10) {
      $lastTickAlert = Get-Date
      Send-Alert "Tick 資料停了" "盤中超過 120s 無新 tick — 自動補資料"
      Invoke-Backfill "tick stale"
    }
  } elseif ($wasStale) {
    $wasStale = $false
    # 只在盤中窗口內才算真正恢復; 關盤/休市後 fresh=$true 是「不算」不是「恢復」
    $tNow = (Get-Date).TimeOfDay
    if ($tNow -ge [timespan]'09:00' -and $tNow -le [timespan]'13:35') {
      if ((New-TimeSpan -Start $lastTickAlert -End (Get-Date)).TotalMinutes -gt 10) {
        $lastTickAlert = Get-Date
        Send-Alert "Tick 資料已恢復" "資料重新流入 — 自動補齊缺口"
      } else { Log "tick recovered (alert throttled)" }
      Invoke-Backfill "gap after resume"
    } else { Log "stale flag cleared outside market window — no recovery alert" }
  }

  # 4. periodic backfill every 30min during market hours (covers silent tick loss)
  $now = Get-Date
  $inMarket = ($isTradingDay -and
               $now.TimeOfDay -gt [timespan]'08:55:00' -and $now.TimeOfDay -lt [timespan]'13:35:00')
  if ($inMarket -and (New-TimeSpan -Start $lastBackfill -End $now).TotalMinutes -gt 30) {
    $lastBackfill = $now
    Invoke-Backfill "periodic 30min"
  }

  Set-Content -Path $HeartbeatFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 15
}
