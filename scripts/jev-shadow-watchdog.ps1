# jev-shadow watchdog — keeps the Jev sidecar AND the shadow collector alive.
#
# Every 60s: probe sidecar /health, then look for the collector process.
# Restart whatever is missing. Run once (it self-sustains):
#   powershell -ExecutionPolicy Bypass -File C:\Users\bear9\OpenCharts\scripts\jev-shadow-watchdog.ps1
#
# Added 2026-10-16, after a 2-day sidecar outage silently destroyed 426 bars:
# nothing noticed that the collector had stopped, and nothing restarted it.
#
# Supersedes jev-sidecar-watchdog.ps1 (which only watched the sidecar, did not
# pin the python path, and was never actually scheduled). Do not run both —
# they would fight over the same port and process.
#
# Deliberately does NOT pass JEV_PAID_MAX_CALLS, so a watchdog restart always
# returns to the safe default paid-call cap.

$ErrorActionPreference = "SilentlyContinue"
$LogDir    = Join-Path $PSScriptRoot "..\logs"
$LogFile   = Join-Path $LogDir "jev-shadow-watchdog.log"
$Sidecar   = Join-Path $PSScriptRoot "jev-sidecar.py"
$Collector = Join-Path $PSScriptRoot "jev-shadow.py"
# Task Scheduler only sees the machine PATH, so bare `python` may not resolve — pin it.
$PythonExe = "C:\Users\bear9\AppData\Local\Programs\Python\Python312\python.exe"
$HealthUrl = "http://127.0.0.1:8787/health"

function Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line
  Write-Output $line
}

function Get-PyProcs($pattern) {
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -match $pattern }
}

function Test-Sidecar {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 10 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-Sidecar {
  Get-PyProcs 'jev-sidecar\.py' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  $p = Start-Process -FilePath $PythonExe -ArgumentList "-u", "`"$Sidecar`"" `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "jev-sidecar-out.log") `
    -RedirectStandardError  (Join-Path $LogDir "jev-sidecar-err.log")
  Log "sidecar restarted (pid=$($p.Id))"
  Start-Sleep -Seconds 5
}

function Start-Collector {
  # No --since/--until/--warmup overrides here: the watchdog always restores the
  # normal live settings. A backfill run is a deliberate manual act.
  $p = Start-Process -FilePath $PythonExe -ArgumentList "-u", "`"$Collector`"" `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "jev-shadow-out.log") `
    -RedirectStandardError  (Join-Path $LogDir "jev-shadow-err.log")
  Log "collector started (pid=$($p.Id))"
  Start-Sleep -Seconds 5
}

Log "=== jev-shadow watchdog started (python=$PythonExe) ==="
$sidecarFails = 0
$collectorFails = 0

while ($true) {
  # --- sidecar ---
  if (Test-Sidecar) {
    if ($sidecarFails -gt 0) { Log "sidecar recovered" }
    $sidecarFails = 0
  } else {
    $sidecarFails++
    Log "sidecar health failed x$sidecarFails — restarting"
    Start-Sidecar
    if (Test-Sidecar) { Log "sidecar restart OK"; $sidecarFails = 0 } else { Log "sidecar restart FAILED" }
  }

  # --- collector ---
  if (Get-PyProcs 'jev-shadow\.py') {
    $collectorFails = 0
  } else {
    $collectorFails++
    if ($collectorFails -eq 1) { Log "collector not running — starting" }
    Start-Collector
    if (Get-PyProcs 'jev-shadow\.py') { Log "collector start OK"; $collectorFails = 0 }
    else { Log "collector start FAILED x$collectorFails" }
  }

  # A collector that cannot stay up (bad config, missing pandas) must not spin.
  if ($collectorFails -ge 3) {
    Log "collector failing repeatedly (x$collectorFails) — backing off 5 min"
    Start-Sleep -Seconds 300
    $collectorFails = 0
  }
  Start-Sleep -Seconds 60
}
