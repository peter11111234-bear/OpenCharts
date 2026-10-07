# start-trading-day.ps1 — 每日 08:30 自動開工
# server 健檢 → 產今日 watchlist → 重開 scanner(導檔) → 重開 watchdog → 等開盤驗 tick
# Task Scheduler 平日 08:30 觸發; 盤中也可手動跑補救
#   powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\start-trading-day.ps1

$ErrorActionPreference = "Continue"
$ScriptsDir = $PSScriptRoot
$LogDir     = Join-Path $PSScriptRoot "..\logs"
$LogFile    = Join-Path $LogDir "start-trading-day.log"
$TickLog    = Join-Path $LogDir "hot-ticks.jsonl"
$ProjectEnv = "C:\MyTradingProjects\.env"
$PythonExe  = "C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe"
# 排程環境只吃 machine PATH, user PATH 的 pwsh 解析不到 → 固定用系統 powershell
$ShellExe   = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$AlertWebhook = $env:SHIOAJI_ALERT_WEBHOOK
$AlertsFile  = Join-Path $LogDir "watchdog-alerts.log"

function Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line
  Write-Output $line
}
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
# 只匹配 scanner 本體，排除 hotscan.dashboard / hotscan.backfill
function Get-ScannerProcs {
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -match 'hot-scanner\.py|-m\s+hotscan(?!\.)' }
}
function Test-TickFresh([int]$maxAgeSec = 120) {
  if (-not (Test-Path $TickLog)) { return $false }
  try {
    $last = Get-Content $TickLog -Tail 1 | ConvertFrom-Json
    $lastTime = [datetimeoffset]::FromUnixTimeSeconds([long]$last.ts).LocalDateTime
    return ((New-TimeSpan -Start $lastTime -End (Get-Date)).TotalSeconds -lt $maxAgeSec)
  } catch { return $false }
}

Log "=== start-trading-day ==="

# 休市日（國定假日）直接收工 — 判斷邏輯唯一源頭在 hotscan/tradingday.py。
# python 印 "open"/"closed"; 叫不出來就照常開工（fail-open）。
# $env:HOTSCAN_FAKE_TRADING_DAY="1" 可強制走交易日流程（測試用）。
if ($env:HOTSCAN_FAKE_TRADING_DAY -eq "1") {
  $tdOut = @("open")
} else {
  $tdOut = @()
  Push-Location $ScriptsDir
  try {
    $tdOut = @(& $PythonExe "-u" "-m" "hotscan.tradingday" 2>$null)
  } catch { $tdOut = @() } finally { Pop-Location }
}
if ((@($tdOut | Where-Object { $_ -match '^(open|closed)$' }) | Select-Object -Last 1) -eq "closed") {
  Log "non-trading day (TWSE holiday) — nothing to do"
  exit 0
}

# 1. shioaji server
if (Test-Server) {
  Log "server OK"
} else {
  Log "server down — starting"
  Load-Keys
  if (-not $env:SJ_API_KEY) { Send-Alert "開工失敗" "找不到 API key ($ProjectEnv)"; exit 1 }
  Get-Process shioaji -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-Process -FilePath "shioaji" -ArgumentList "server","start","--no-open" -WindowStyle Hidden
  Start-Sleep -Seconds 15
  if (Test-Server) { Log "server restart OK" } else { Send-Alert "開工失敗" "shioaji server 起不來"; exit 1 }
}

# 1.5 vite dev server :5173 — canonical starter lives in dev-up.ps1
#     (probe-first, strictPort, reaps stray project vites left by dead parents)
$out = & (Join-Path $ScriptsDir "dev-up.ps1") 2>&1
$out | ForEach-Object { Log "vite: $_" }
if ($LASTEXITCODE -ne 0) { Send-Alert "開工異常" "vite :5173 起不來 — /hot 頁面無法看" }

# 2. 今日 watchlist (hot-watchlist.py 自動取最新交易日)
& $PythonExe (Join-Path $ScriptsDir "hot-watchlist.py") 2>&1 | ForEach-Object { Log "watchlist: $_" }
$wl = Get-ChildItem $LogDir -Filter "hot-watchlist-*.json" | Sort-Object Name | Select-Object -Last 1
if (-not $wl) { Send-Alert "開工失敗" "watchlist 產生失敗"; exit 1 }
Log "watchlist: $($wl.Name)"

# 3. scanner — 每天強制重開 (殭屍比死亡危險); -u + 導檔 = 消掉 stdout 阻塞死因
$old = @(Get-ScannerProcs)
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($old) { Log "killed $($old.Count) old scanner proc(s)"; Wait-Process -Id ($old | ForEach-Object ProcessId) -Timeout 5 -ErrorAction SilentlyContinue }
$p = Start-Process -FilePath $PythonExe -ArgumentList "-u","-m","hotscan" `
  -WorkingDirectory $ScriptsDir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir "scanner-out.log") `
  -RedirectStandardError (Join-Path $LogDir "scanner-err.log")
if (-not $p) { Log "scanner launch FAILED (Start-Process returned null)" }
Start-Sleep -Seconds 20
if (-not @(Get-ScannerProcs)) {
  Log "scanner failed to start — stderr tail:"
  Get-Content (Join-Path $LogDir "scanner-err.log") -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
  Send-Alert "開工失敗" "scanner 起不來 — 見 scanner-err.log"
  exit 1
}
$sub = Select-String -Path (Join-Path $LogDir "scanner-out.log") -Pattern "subscribed \d+/\d+" | Select-Object -Last 1
if ($sub) { Log "scanner up: $($sub.Matches[0].Value)" } else { Log "scanner up" }

# 4. watchdog — 每天重開, 不信昨天的 instance 還在正常 loop
Get-CimInstance Win32_Process -Filter "Name like '%powershell%' or Name like '%pwsh%'" |
  Where-Object { $_.CommandLine -match 'shioaji-watchdog\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$wd = Start-Process -FilePath $ShellExe -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",
  (Join-Path $ScriptsDir "shioaji-watchdog.ps1") -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 4
if ($wd -and -not $wd.HasExited) { Log "watchdog relaunched (pid=$($wd.Id))" } else { Log "WATCHDOG FAILED TO START"; Send-Alert "開工異常" "watchdog 起不來" }

# 5. 等開盤確認 tick 流入 (驗到 09:10); 盤中手動補跑則直接驗
$openDeadline = (Get-Date).Date.AddHours(9).AddMinutes(10)
if ((Get-Date) -lt $openDeadline) {
  Log "READY — waiting for open (confirm ticks by 09:10)"
  while ((Get-Date) -lt $openDeadline) {
    if (Test-TickFresh 120) { Log "CONFIRMED: live ticks flowing"; exit 0 }
    Start-Sleep -Seconds 30
  }
} else {
  Start-Sleep -Seconds 30
  if (Test-TickFresh 120) { Log "CONFIRMED: live ticks flowing"; exit 0 }
}
Send-Alert "開盤資料未流入" "scanner 已啟動但 hot-ticks 無新資料 — 檢查 SSE/訂閱"
exit 1
