param(
  [string]$Window = "A",
  [int]$BudgetMinutes = 105,
  [switch]$DryRun
)
$ErrorActionPreference = "Continue"
$repo = "C:\Users\bear9\OpenCharts"
$pi   = "C:\Users\bear9\AppData\Roaming\npm\pi.cmd"
Set-Location $repo

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log  = Join-Path $logDir "r5-autorun-$Window-$stamp.log"
$rlog = Join-Path $logDir "r5-autorun-$Window-$stamp.runner.log"
function Say($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Out-File -Append -Encoding utf8 $rlog }
function Md5Hex([string]$p) {
  $h = [System.Security.Cryptography.MD5]::Create()
  $fs = [System.IO.File]::OpenRead($p)
  try { (($h.ComputeHash($fs) | ForEach-Object { $_.ToString("x2") }) -join "") }
  finally { $fs.Dispose(); $h.Dispose() }
}

Say "START window=$Window budget=${BudgetMinutes}m runner-pid=$PID"
Say "pi=$pi exists=$(Test-Path $pi)"
if (-not (Test-Path $pi)) { Say "ABORT: pi not found"; exit 2 }

# --- 1) snapshot src/pine + golden, record md5 ---
$snap = Join-Path $env:TEMP "r5-snapshot-$Window-$stamp"
New-Item -ItemType Directory -Force -Path $snap | Out-Null
Copy-Item -Recurse -Force (Join-Path $repo "src\pine")      (Join-Path $snap "pine")
Copy-Item -Recurse -Force (Join-Path $repo "scripts\golden") (Join-Path $snap "golden")
$md5 = Join-Path $snap "md5-before.txt"
(Get-ChildItem (Join-Path $repo "src\pine") -Recurse -File | Sort-Object FullName |
  ForEach-Object { (Md5Hex $_.FullName) + "  " + $_.FullName }) |
  Set-Content -Path $md5 -Encoding utf8
Say "SNAPSHOT $snap ($((Get-ChildItem $snap -Recurse -File).Count) files)"
# 讓下游（verify-restore.ps1）不必猜路徑：把最新快照位置寫到固定檔
try { Set-Content -Path (Join-Path $logDir 'r5-snapshot-latest.txt') -Value $snap -Encoding utf8 } catch { Say "WARN: could not write r5-snapshot-latest.txt" }

# --- 2) build the message: ASCII wrapper + @file attach (avoids codepage mangling) ---
$wrapMin = $BudgetMinutes - 15
$brief = "@docs/2026-10-15-r5-remaining-autorun.md"
$msg = "Execute the attached brief now (window $Window). " +
       "Read docs/2026-10-15-r5-autorun-status.json and docs/2026-10-15-r5-autorun-report.md first; " +
       "do only tasks not marked done. Hard stop in $BudgetMinutes minutes: start wrapping up at $wrapMin minutes " +
       "(write status + report + PROGRESS.md). Do not leave failing tests, tsc errors or changed model digests."

# --- 3) run pi non-interactive, watchdog kill at the budget ---
if ($DryRun) {
  Say "DRYRUN: pi not launched; using a sleeping child instead"
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "ping -n 400 127.0.0.1 > nul") `
          -WorkingDirectory $repo -NoNewWindow -PassThru `
          -RedirectStandardOutput $log -RedirectStandardError "$log.err"
} else {
  $proc = Start-Process -FilePath $pi -ArgumentList @("-p", $brief, $msg, "--mode", "text") `
          -WorkingDirectory $repo -NoNewWindow -PassThru `
          -RedirectStandardOutput $log -RedirectStandardError "$log.err"
}
Say "PI started pid=$($proc.Id) stdout=$log"

$killed = $false
try {
  Wait-Process -Id $proc.Id -Timeout ($BudgetMinutes * 60) -ErrorAction Stop
} catch {
  $killed = $true
  Say "BUDGET EXCEEDED -> taskkill /T /F pid=$($proc.Id)"
  & taskkill.exe /T /F /PID $proc.Id | Out-Null
  Start-Sleep -Seconds 5
}
$code = try { $proc.Refresh(); $proc.ExitCode } catch { "n/a" }
Say "PI exited code=$code killed=$killed"

# --- 4) external integrity check: did src/pine change vs start? ---
$after = Join-Path $snap "md5-after.txt"
(Get-ChildItem (Join-Path $repo "src\pine") -Recurse -File | Sort-Object FullName |
  ForEach-Object { (Md5Hex $_.FullName) + "  " + $_.FullName }) |
  Set-Content -Path $after -Encoding utf8
$b = @(Get-Content -LiteralPath $md5 -ErrorAction SilentlyContinue)
$a = @(Get-Content -LiteralPath $after -ErrorAction SilentlyContinue)
Say "MD5 counts before=$($b.Count) after=$($a.Count)"
if ($b.Count -eq 0 -or $a.Count -eq 0) {
  Say "INTEGRITY-CHECK-FAILED: empty md5 list (before=$($b.Count) after=$($a.Count)) -> treat tree state as UNKNOWN"
} else {
  $d = Compare-Object -ReferenceObject $b -DifferenceObject $a
  if ($d) {
    Say "TREE-CHANGED: src/pine differs from start (see $after vs $md5)"
    $d | ForEach-Object { Say ("  " + $_.SideIndicator + " " + $_.InputObject) }
  } else {
    Say "TREE-IDENTICAL: src/pine md5 unchanged vs start ($($b.Count) files)"
  }
}
Say "END window=$Window"
