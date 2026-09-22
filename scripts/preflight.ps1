# Preflight — 開盤/開工前檢查。不印 key，只報狀態。
# 綠燈全過才能看盤下單；紅燈照提示修。
# powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\preflight.ps1

$fail = 0
function Check($name, [scriptblock]$fn, $hint) {
  try { $ok = & $fn } catch { $ok = $false }
  if ($ok) { Write-Output "[OK] $name" }
  else { Write-Output "[FAIL] $name -- $hint"; $script:fail++ }
}

Check "shioaji server 存活" {
  (Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/v1/auth/accounts" -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200
} "跑 shioaji server start（key 由 watchdog 自動從 MyTradingProjects/.env 帶入）"

Check "shioaji 登入有效（非 Sign timeout）" {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/auth/accounts" -TimeoutSec 15
  $r.Count -gt 0
} "系統管理員跑 w32tm /resync（同步源 tock.stdtime.gov.tw）"

Check "2330 快照有價" {
  $b = '{"contracts":[{"security_type":"STK","exchange":"TSE","code":"2330"}]}'
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v1/data/snapshots" -Method Post -ContentType "application/json" -Body $b -TimeoutSec 20
  $r.close -gt 0
} "檢查 server log / 券商線路"

Check "dev server :5173 存活" {
  (Invoke-WebRequest -Uri "http://localhost:5173/" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200
} "cd OpenCharts; npm run dev"

Check "vite proxy 通到 server" {
  $b = '{"contracts":[{"security_type":"STK","exchange":"TSE","code":"2330"}]}'
  $r = Invoke-RestMethod -Uri "http://localhost:5173/shioaji/api/v1/data/snapshots" -Method Post -ContentType "application/json" -Body $b -TimeoutSec 20
  $r.close -gt 0
} "檢查 vite.config.ts /shioaji rewrite 是否還在"

Check "watchdog 活著" {
  (Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'shioaji-watchdog'
  }).Count -gt 0
} "重跑 scripts/shioaji-watchdog.ps1"

Check "jev sidecar :8787 存活" {
  (Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200
} "跑 python scripts/jev-sidecar.py（或 scripts/jev-sidecar-watchdog.ps1）"

Check "vite proxy 通到 jev sidecar" {
  (Invoke-WebRequest -Uri "http://localhost:5173/jev/health" -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200
} "檢查 vite.config.ts /jev rewrite 是否還在"

if ($fail -eq 0) { Write-Output ""; Write-Output "ALL GREEN - ready" } else { Write-Output ""; Write-Output "$fail RED - fix before trading" }
exit $fail
