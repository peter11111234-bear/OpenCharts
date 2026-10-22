# Jev sidecar watchdog — keeps the local decision proxy alive.
# SUPERSEDED 2026-10-16 by jev-shadow-watchdog.ps1, which supervises the sidecar
# AND the shadow collector. Do not run both (they fight over port 8787).
# Kept for manual one-off use only.
#
# Every 15s GETs /health; on failure kills leftovers and restarts the sidecar.
# Run once (it self-sustains):
#   powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\jev-sidecar-watchdog.ps1

$ErrorActionPreference = "SilentlyContinue"
$LogFile = Join-Path $PSScriptRoot "jev-sidecar-watchdog.log"
$Sidecar = Join-Path $PSScriptRoot "jev-sidecar.py"
# Task Scheduler only sees the machine PATH, so bare `python` may not resolve — pin it.
$PythonExe = "C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $LogFile -Value $line
  Write-Output $line
}

function Test-Sidecar {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -TimeoutSec 10 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Start-Sidecar {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
    $_.CommandLine -match 'jev-sidecar\.py'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  $p = Start-Process -FilePath $PythonExe -ArgumentList "`"$Sidecar`"" -PassThru -WindowStyle Hidden
  Log "sidecar start requested (pid=$($p.Id))"
  Start-Sleep -Seconds 5
}

Log "=== jev-sidecar watchdog started ==="
$failStreak = 0
while ($true) {
  if (Test-Sidecar) {
    if ($failStreak -gt 0) { Log "sidecar recovered" }
    $failStreak = 0
  } else {
    $failStreak++
    Log "health check failed x$failStreak — restarting sidecar"
    Start-Sidecar
    if (Test-Sidecar) { Log "restart OK"; $failStreak = 0 }
    else { Log "restart FAILED, retry in 60s"; Start-Sleep -Seconds 60 }
  }
  Start-Sleep -Seconds 15
}
