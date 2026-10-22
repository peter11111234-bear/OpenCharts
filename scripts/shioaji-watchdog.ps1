# Shioaji watchdog — 防呆總管
# 每 15s 檢查三件事，出問題寫進 logs/watchdog-alerts.log (+音效+webhook) 並自動重啟:
#   1. shioaji server 健康 (GET /api/v1/auth/accounts)
#   2. hot-scanner 進程存活
#   3. tick 資料新鮮度 (盤中 120s 無 tick = 異常)
# Run once (self-sustains):
#   powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\shioaji-watchdog.ps1
# Optional: $env:SHIOAJI_ALERT_WEBHOOK = Discord/Slack webhook URL
# -SelfTest: 讀 scripts/front_month_cases.json 跑近月判斷, 印 PASS/FAIL 後結束 (不進主迴圈)

param(
  [switch]$SelfTest
)

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
# fop-tick-recorder 只是「每日 500MB 流量用完」的備援; 2026-10-22 使用者決定先停,
# 改從源頭減少 K 棒重複抓取. 要恢復就改回 $true 並重啟看門狗.
$EnableFopRecorder = $false
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
function Test-TradingDayOn($dateStr) {
  # 指定日期的交易日判斷 (夜盤凌晨 00:00-04:55 屬前一晚, 要查昨天).
  if ($script:TradingDayCache.ContainsKey($dateStr)) { return $script:TradingDayCache[$dateStr] }
  $fake = $env:HOTSCAN_FAKE_TRADING_DAY  # 測試用: "1"=強制交易日, "0"=強制休市
  if ($fake -eq "1" -or $fake -eq "0") { $script:TradingDayCache[$dateStr] = ($fake -eq "1"); return ($fake -eq "1") }
  $open = $true
  # python 同步呼叫若 hang 會卡死整個 watchdog loop; 用 job 限時 15s, timeout → fail-open
  $job = Start-Job -ScriptBlock {
    param($py, $dir, $d)
    Push-Location $dir
    try { & $py "-u" "-m" "hotscan.tradingday" "--date" $d 2>$null } finally { Pop-Location }
  } -ArgumentList $PythonExe, $ScriptsDir, $dateStr
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
  if ($ans) { $script:TradingDayCache[$dateStr] = $open }
  return $open
}

function Test-TradingDay {
  # 今天的交易日判斷 (行為與原本一致)
  return Test-TradingDayOn ((Get-Date).ToString("yyyy-MM-dd"))
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

# Vela 三檔訂閱守護: 與 src/services/shioaji/instruments.ts LIVE_INSTRUMENTS 同一組
# (2330 + 微台 TMF + 小台 MXF 近月)。近月依日期自動算, 不必每月手改:
# 第三個週三 13:45 (日盤收盤) 後換下個月 — 15:00 夜盤已是新月份。
function Get-FrontMonth($root, $now = (Get-Date)) {
  $expiry = Get-Date -Year $now.Year -Month $now.Month -Day 15 -Hour 13 -Minute 45 -Second 0 -Millisecond 0
  while ($expiry.DayOfWeek -ne [DayOfWeek]::Wednesday) { $expiry = $expiry.AddDays(1) }
  $m = if ($now -ge $expiry) { $now.AddMonths(1) } else { $now }
  return "$root$("ABCDEFGHIJKL"[$m.Month - 1])$($m.Year % 10)"
}

# ── 近月真相: 券商優先 (跟著期交所假日/颱風順延), 規則備援 ──────────────
# 四條規則與 src/services/shioaji/frontMonth.ts pickFrontMonth 完全相同,
# 共用測試案例在 scripts/front_month_cases.json (三處實作都讀同一份).
function Select-FrontMonth($info, $ruleCode, $now = (Get-Date)) {
  if (-not $info) { return @{ code = $ruleCode; source = "rule"; warning = $null } }
  $target = $info.target_code
  $last = $info.last_trading_date
  $until = $null
  if ($last) {
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParseExact("$last", "yyyy-MM-dd", $null, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
      $until = $parsed.AddHours(13).AddMinutes(45)
    }
  }
  if (-not $target -or $null -eq $until) {
    return @{ code = $ruleCode; source = "rule"; warning = "券商合約資料不完整，暫用規則近月 $ruleCode" }
  }
  if ($now -ge $until) {
    return @{ code = $ruleCode; source = "rule"; warning = "券商近月 $target 已過最後交易日（資料尚未更新），暫用規則近月 $ruleCode" }
  }
  if ($target -eq $ruleCode) {
    return @{ code = $target; source = "broker"; warning = $null }
  }
  return @{ code = $target; source = "broker"; warning = "券商近月 $target 與規則 $ruleCode 不同（可能假日或颱風順延），以券商為準" }
}

function Get-R1Info($root) {
  # GET 連續合約的券商資訊; 失敗 → $null (改用規則, 不警告)
  try {
    $uri = "http://127.0.0.1:8080/api/v1/data/contracts/${root}R1/info"
    $r = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 5
    if (-not $r) { return $null }
    return @{ target_code = $r.target_code; last_trading_date = $r.last_trading_date }
  } catch { return $null }
}

$script:FmCache = @{}          # root -> @{ code; expires }
$script:FmWarned = @{}         # (day|message) -> true (同一訊息一天只告警一次)

function Resolve-FrontMonth($root, $now = (Get-Date)) {
  # 券商優先, 規則備援; 結果快取 5 分鐘 (loop 每 15s 一輪, 不用每輪打 API)
  $cached = $script:FmCache[$root]
  if ($cached -and $cached.expires -gt (Get-Date)) { return $cached.code }
  $ruleCode = Get-FrontMonth $root $now
  $info = Get-R1Info $root
  $pick = Select-FrontMonth $info $ruleCode $now
  if ($pick.warning) {
    $day = (Get-Date).ToString("yyyy-MM-dd")
    $key = "$day|$($pick.warning)"
    if (-not $script:FmWarned.ContainsKey($key)) {
      $script:FmWarned[$key] = $true
      Log "換月提醒: $($pick.warning)"
      Send-Alert "換月提醒" "$($pick.warning)"
    }
  }
  $script:FmCache[$root] = @{ code = $pick.code; expires = (Get-Date).AddMinutes(5) }
  return $pick.code
}

function Get-VelaContracts {
  return @(
    @{ security_type = "STK"; exchange = "TSE";    code = "2330" },
    @{ security_type = "FUT"; exchange = "TAIFEX"; code = (Resolve-FrontMonth "TMF") },
    @{ security_type = "FUT"; exchange = "TAIFEX"; code = (Resolve-FrontMonth "MXF") }
  )
}

function Subscribe-Contract($sec, $ex, $code) {
  try {
    $body = (@{ security_type = $sec; exchange = $ex; code = $code; quote_type = "Tick" } | ConvertTo-Json -Compress)
    Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/stream/subscribe" -Method Post -TimeoutSec 10 `
      -Body $body -ContentType 'application/json' | Out-Null
    return $true
  } catch { Log "vela resubscribe failed: $code $_"; return $false }
}

function Subscribe-VelaInstruments($why) {
  $ok = 0
  $contracts = @(Get-VelaContracts)
  foreach ($c in $contracts) {
    if (Subscribe-Contract $c.security_type $c.exchange $c.code) { $ok++ }
  }
  Log "vela resubscribe ($why): $ok/$($contracts.Count) ($(($contracts | ForEach-Object { $_.code }) -join ','))"
  return $ok
}

function Get-FopCodes {
  # 期貨串流 12s 探針: 回傳這段時間出現過的合約代碼 (TMFK6/MXFK6); 連不上 → 空陣列.
  # 逐檔比對: 任一 FUT 有 tick 即串流活著, 缺的那檔單獨補訂 (MXF 活著不代表 TXF 活著).
  $tmp = Join-Path $env:TEMP "fop-probe.txt"
  try {
    Start-Process -FilePath "curl.exe" -ArgumentList "-s","-N","-m","12","-H","Accept: text/event-stream",`
      "http://127.0.0.1:8080/api/v1/stream/data/tick_fop" `
      -RedirectStandardOutput $tmp -WindowStyle Hidden -Wait -ErrorAction Stop
    $codes = @()
    foreach ($m in (Select-String -Path $tmp -Pattern '"code":"([A-Z0-9]+)"' -ErrorAction SilentlyContinue)) {
      $codes += $m.Matches.Groups[1].Value
    }
    return @($codes | Sort-Object -Unique)
  } catch { return @() }
}

function Start-Server {
  Load-Keys
  if (-not $env:SJ_API_KEY) { Log "FATAL: no API key in $ProjectEnv"; return }
  Get-Process shioaji -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  # 用絕對路徑啟動: PATH 裡可能有多個 shioaji/惡意同名牌
  $sjExe = "C:\Users\bear9\.openharness-venv\Scripts\shioaji.exe"
  # 每次啟動一份帶時間的 log (請求紀錄是量流量/去重的唯一來源), 留 7 天
  Get-ChildItem $LogDir -Filter "shioaji-server-*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $p = Start-Process -FilePath $sjExe -ArgumentList "server","start","--no-open" -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "shioaji-server-$stamp.out.log") `
    -RedirectStandardError (Join-Path $LogDir "shioaji-server-$stamp.err.log")
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

# fop-tick-recorder: 期貨 tick → logs/fop-ticks-*.jsonl + public/local-bars (永豐 kbars 超額時的備援)
# 先找程序再啟動，絕不開第二支（兩支同時錄 = tick 重複寫兩次）
function Get-FopRecorderProcs {
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -match 'fop-tick-recorder\.py' }
}
function Start-FopRecorder {
  $p = Start-Process -FilePath $PythonExe -ArgumentList "-u",(Join-Path $ScriptsDir "fop-tick-recorder.py") `
    -WorkingDirectory (Join-Path $ScriptsDir "..") -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "fop-recorder-out.log") `
    -RedirectStandardError (Join-Path $LogDir "fop-recorder-err.log")
  if (-not $p) { Log "fop-recorder launch FAILED"; return }
  Log "fop-recorder start requested (pid=$($p.Id))"
}

function Get-FopSessionWindow($now = (Get-Date), $isTradingDay = $true) {
  # 期貨交易時段: 日盤 08:50-13:45, 夜盤 15:05-23:59:59 / 00:00-04:55
  # 夜盤歸屬: 15:05 起屬「今天」開的夜盤; 凌晨 00:00-04:55 屬「昨天」開的夜盤
  # 回傳 @{ InSession = bool; Night = bool }
  $t = $now.TimeOfDay
  if ($t -gt [timespan]'08:50:00' -and $t -lt [timespan]'13:45:00') {
    return @{ InSession = $isTradingDay; Night = $false }
  }
  if ($t -ge [timespan]'15:05:00') {
    return @{ InSession = $isTradingDay; Night = $true }
  }
  if ($t -le [timespan]'04:55:00') {
    $yesterday = $now.AddDays(-1).ToString("yyyy-MM-dd")
    return @{ InSession = (Test-TradingDayOn $yesterday); Night = $true }
  }
  return @{ InSession = $false; Night = $false }
}

# ── -SelfTest: 讀共用案例檔跑近月判斷, 不進主迴圈、不啟動任何東西 ──────
if ($SelfTest) {
  $casesFile = Join-Path $PSScriptRoot "front_month_cases.json"
  $cases = Get-Content $casesFile -Raw | ConvertFrom-Json
  $pass = 0; $fail = 0
  foreach ($c in $cases) {
    $now = [datetime]::ParseExact($c.now_taipei, "yyyy-MM-ddTHH:mm:ss", $null)
    $info = $c.info
    $pick = Select-FrontMonth $info $c.rule_code $now
    $gotWarning = [bool]$pick.warning
    $ok = ($pick.code -eq $c.expect_code) -and ($pick.source -eq $c.expect_source) -and ($gotWarning -eq [bool]$c.expect_warning)
    if ($ok) {
      $pass++
      Write-Output ("PASS  {0}  code={1} source={2} warning={3}" -f $c.name, $pick.code, $pick.source, $gotWarning)
    } else {
      $fail++
      Write-Output ("FAIL  {0}  got code={1} source={2} warning={3} | want code={4} source={5} warning={6}" -f `
        $c.name, $pick.code, $pick.source, $gotWarning, $c.expect_code, $c.expect_source, $c.expect_warning)
    }
  }
  Write-Output ("front-month self-test: {0} passed, {1} failed, {2} total" -f $pass, $fail, $cases.Count)
  if ($fail -gt 0) { exit 1 }
  exit 0
}

# single-instance: 互斥鎖優先 (harness 重試/手動誤啟會多開, 下面的 kill 有 race ——
# 兩個同時啟動會互相看不見). 拿不到鎖直接退出; 舊 kill 邏輯保留, 負責清掉
# mutex 出現之前的殘留進程 (被殺掉的 holder 會留下 AbandonedMutex, 照樣接手).
$script:WatchdogMutex = New-Object System.Threading.Mutex($false, "Global\OpenCharts-ShioajiWatchdog")
try {
  if (-not $script:WatchdogMutex.WaitOne(0)) { exit 0 }
} catch [System.Threading.AbandonedMutexException] {
  # 前一個 holder 被殺, 鎖已回到我們手上 — 繼續跑
}
$me = $PID
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'shioaji-watchdog\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Log "=== watchdog started (server + scanner + tick-freshness + fop-guard + auto-backfill) ==="
$failStreak = 0
$lastTickAlert = [datetime]::MinValue
$lastFopAlert = [datetime]::MinValue
$script:FopLoop = 0
$lastServerAlert = [datetime]::MinValue
$lastBackfill = [datetime]::MinValue
$lastScannerRestart = [datetime]::MinValue
$lastFopRecorderStart = [datetime]::MinValue
$lastServerBoot = [datetime]::MinValue
$script:serverProc = $null
$script:serverBootFails = 0
$wasStale = $false
$script:LastFreshAt = [datetime]::MinValue   # 最後一次確認 tick 新鮮的時間 → backfill 只補這之後
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
  # 只補缺口: 從最後一次 tick 新鮮往前 5 分鐘起抓 (RangeTime); 今天還沒新鮮過才抓整天.
  # 2026-10-21 每 30 分鐘重抓整天 ~40 萬筆, 新增 <1%, 把 Shioaji 每日 500MB 流量燒光.
  $bfArgs = @("-u","-m","hotscan.backfill")
  if ($script:LastFreshAt.Date -eq (Get-Date).Date) {
    $bfArgs += @("--since", $script:LastFreshAt.AddMinutes(-5).ToString("HH:mm:ss"))
  }
  Log "backfill triggered: $reason ($($bfArgs[3..4] -join ' '))"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $LogDir "backfill-out-$stamp.log"
  $errLog = Join-Path $LogDir "backfill-err-$stamp.log"
  $p = Start-Process -FilePath $PythonExe -ArgumentList $bfArgs `
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
        Subscribe-VelaInstruments "server restart" | Out-Null
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

  # 4. vela FOP 訂閱守護 — server 重啟會清空 in-memory 訂閱, 前端 feed 未必自癒;
  #    盤中期貨串流逾 60s 無 tick → 後端直接重訂微台/小台近月 (每 4 個 loop 探一次 ≈60s)
  #    檢查窗口: 日盤 08:50–13:45 或 夜盤 15:05–23:59:59 / 00:00–04:55
  #    夜盤歸屬: 15:05 起屬「今天」開的夜盤; 凌晨 00:00–04:55 屬「昨天」開的夜盤
  $script:FopLoop = ($script:FopLoop + 1) % 4
  $fopWindow = Get-FopSessionWindow (Get-Date) $isTradingDay
  $fopInSession = $fopWindow.InSession
  $fopNightSession = $fopWindow.Night
  if ($fopInSession -and $failStreak -eq 0 -and $script:FopLoop -eq 0) {
    $fopSeen = @(Get-FopCodes)
    $velaContracts = @(Get-VelaContracts)
    $fopWant = @($velaContracts | Where-Object { $_.security_type -eq "FUT" } | ForEach-Object { $_.code })
    $fopMissing = @($fopWant | Where-Object { $fopSeen -notcontains $_ })
    if ($fopSeen.Count -eq 0) {
      Log "tick_fop silent (>60s, in session) — resubscribing vela instruments"
      Subscribe-VelaInstruments "fop silent" | Out-Null
      if ((New-TimeSpan -Start $lastFopAlert -End (Get-Date)).TotalMinutes -gt 10) {
        $lastFopAlert = Get-Date
        $typhoonNote = if ($fopNightSession) { "（夜盤檢查，若今天颱風停市可忽略）" } else { "" }
        Send-Alert "期貨 tick 停了" "tick_fop 逾 60s 無 tick — 已自動重訂微台/小台近月 $typhoonNote"
      }
    } elseif ($fopMissing.Count -gt 0) {
      $typhoonNote = if ($fopNightSession) { "（夜盤檢查，若今天颱風停市可忽略）" } else { "" }
      Log "tick_fop partial (seen: $($fopSeen -join ',')) — missing $($fopMissing -join ',') — subscribing $typhoonNote"
      foreach ($m in $fopMissing) {
        $c = $velaContracts | Where-Object { $_.code -eq $m } | Select-Object -First 1
        if ($c) { Subscribe-Contract $c.security_type $c.exchange $c.code | Out-Null }
      }
    }
  }

  # 4.5 fop-tick-recorder 存活: 沒在跑才啟動 (server 正常時、60s 冷卻)
  if ($EnableFopRecorder -and $failStreak -eq 0 -and -not @(Get-FopRecorderProcs) -and
      (New-TimeSpan -Start $lastFopRecorderStart -End (Get-Date)).TotalSeconds -gt 60) {
    $lastFopRecorderStart = Get-Date
    Log "fop-recorder not running — starting"
    Start-FopRecorder
  }

  # 5. (已移除) 每 30 分鐘定期 backfill: 即時串流已收 tick, 定期重抓整天只換來 <1% 新增,
  #    卻吃掉每日流量上限. 現在只在 scanner 重啟 / tick 停 / 恢復時補缺口 (見上方 2、3).
  if ($fresh) { $script:LastFreshAt = Get-Date }

  Set-Content -Path $HeartbeatFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 15
}
