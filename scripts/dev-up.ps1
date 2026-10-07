# dev-up.ps1 — idempotent OpenCharts vite starter.
#
# Why this exists (2026-10-07 incident):
#   Agent sessions spawned `npx vite` per session. On Windows the parent bun
#   process dying does NOT reap children → old vite stays alive holding :5173.
#   Next spawn then auto-incremented to :5174/:5175 → multiple dev servers,
#   multiple browser tabs pointed at different ports. Fix at the mechanism
#   level: vite.config.ts sets strictPort (double-start fails loudly instead
#   of silently grabbing another port), and THIS script is the single
#   canonical entry: probe first, start only if down, reap strays.
#
# Usage:
#   scripts/dev-up.ps1              # ensure :5173 up, kill stray project vites
#   scripts/dev-up.ps1 -Port 5199   # same, other port (testing)
#   scripts/dev-up.ps1 -NoKill      # skip stray reaping
param(
  [int]$Port = 5173,
  [switch]$NoKill
)
$ErrorActionPreference = "Continue"
$Root      = Split-Path $PSScriptRoot -Parent
$LogDir    = Join-Path $Root "logs"
$ViteLog   = Join-Path $LogDir "vite-dev.log"
$RestartLog= Join-Path $Root "vite-restart.log"

function Test-Vite {
  try {
    return (Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200
  } catch { return $false }
}

function Get-ProjectVites {
  # node processes running THIS project's vite.js (any port)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match [regex]::Escape(($Root -replace '\\','\\')) -and
    $_.CommandLine -match 'vite\.js'
  }
}

if (Test-Vite) {
  Write-Output "vite OK on :$Port — no-op"
} else {
  Write-Output "vite down — starting npm run dev -- --port $Port"
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # fresh restart marker so watchers can correlate
  "" | Out-File $RestartLog -Encoding utf8
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c","npm run dev -- --port $Port --strictPort > `"$ViteLog`" 2>&1" `
    -WorkingDirectory $Root -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Vite) { $up = $true; break }
  }
  if ($up) { Write-Output "vite restart OK on :$Port" }
  else {
    Write-Output "vite FAILED to come up on :$Port — last log lines:"
    Get-Content $ViteLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "  $_" }
    exit 1
  }
}

if (-not $NoKill) {
  # Reap stray project vites: anything serving this repo but NOT the :$Port owner.
  $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty OwningProcess)
  $strays = @(Get-ProjectVites | Where-Object { $_.ProcessId -ne $owner })
  if ($strays.Count -gt 0) {
    foreach ($s in $strays) {
      Write-Output "killing stray vite pid=$($s.ProcessId)"
      Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
