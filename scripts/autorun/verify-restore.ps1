param(
  [string]$Repo = 'C:\Users\bear9\OpenCharts',
  [string]$Snapshot = ''
)
# 目的：window A 的 runner 在 13:45 硬停時，若代理停在「已回退 src/pine」的相位，
# 這支會比對 runner 自己記的 md5-before.txt，並把不一致/缺少的檔案還原回去（來源＝同一次快照）。
$ErrorActionPreference = 'Continue'
Set-Location $Repo
$log = Join-Path $Repo ("logs\r5-restore-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
function Say($m) { "$(Get-Date -Format 'HH:mm:ss') $m" | Out-File -Append -Encoding utf8 $log }
function Md5Hex([string]$p) {
  $h = [System.Security.Cryptography.MD5]::Create()
  $fs = [System.IO.File]::OpenRead($p)
  try { (($h.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $fs.Dispose(); $h.Dispose() }
}

if (-not $Snapshot) {
  # ① 優先讀 runner 寫下的固定指標檔（避免依賴 $env:TEMP —— MSYS 傳進來的 TEMP 可能是 /tmp）
  $ptr = Join-Path (Join-Path $Repo 'logs') 'r5-snapshot-latest.txt'
  if (Test-Path $ptr) {
    $cand = (Get-Content -LiteralPath $ptr -TotalCount 1).Trim()
    if ($cand -and (Test-Path (Join-Path $cand 'md5-before.txt'))) { $Snapshot = $cand }
  }
  # ② 退路：掃常見 temp 根（含硬編路徑），只收含 md5-before.txt 的
  if (-not $Snapshot) {
    $roots = @($env:TEMP, $env:TMP, 'C:\Users\bear9\AppData\Local\Temp') | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
    $cands = @()
    foreach ($r in $roots) {
      $cands += Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'r5-snapshot-*' -and (Test-Path (Join-Path $_.FullName 'md5-before.txt')) }
    }
    if ($cands.Count -gt 0) { $Snapshot = ($cands | Sort-Object LastWriteTime -Descending)[0].FullName }
  }
  if (-not $Snapshot) { Say "ABORT: no snapshot with md5-before.txt (checked pointer file + TEMP roots)"; Say "END"; exit 3 }
}
Say "repo=$Repo snapshot=$Snapshot"
$md5file = Join-Path $Snapshot 'md5-before.txt'
if (-not (Test-Path $md5file)) { Say "ABORT: no md5-before.txt in snapshot"; Say "END"; exit 3 }

$expected = @{}
foreach ($line in Get-Content -LiteralPath $md5file) {
  if ($line -match '^([0-9a-f]{32})\s+(.+)$') {
    $abs = $Matches[2].Trim()
    $i = $abs.IndexOf('src\pine\')
    if ($i -ge 0) { $expected[$abs.Substring($i + 9)] = $Matches[1] }
  }
}
Say ("expected files = " + $expected.Count)
if ($expected.Count -eq 0) { Say "ABORT: parsed 0 entries"; Say "END"; exit 3 }

$bad = New-Object System.Collections.ArrayList
foreach ($k in ($expected.Keys | Sort-Object)) {
  $p = Join-Path (Join-Path $Repo 'src\pine') $k
  if (-not (Test-Path $p)) { [void]$bad.Add("MISSING $k"); continue }
  if ((Md5Hex $p) -ne $expected[$k]) { [void]$bad.Add("DIFF $k") }
}

if ($bad.Count -eq 0) { Say "OK: src/pine matches the runner snapshot exactly ($($expected.Count) files)"; Say "END"; exit 0 }

Say "MISMATCH $($bad.Count) of $($expected.Count) -> restoring from snapshot"
foreach ($b in $bad) {
  $rel = $b.Substring($b.IndexOf(' ') + 1)
  $src = Join-Path (Join-Path $Snapshot 'pine') $rel
  $dst = Join-Path (Join-Path $Repo 'src\pine') $rel
  if (Test-Path $src) {
    $dstDir = Split-Path $dst -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Say "  restored $rel"
  } else { Say "  !! snapshot missing $rel" }
}

$bad2 = @()
foreach ($k in $expected.Keys) {
  $p = Join-Path (Join-Path $Repo 'src\pine') $k
  if (-not (Test-Path $p)) { $bad2 += "MISSING $k"; continue }
  if ((Md5Hex $p) -ne $expected[$k]) { $bad2 += "DIFF $k" }
}
if ($bad2.Count -eq 0) { Say "RESTORED-OK: src/pine now matches snapshot ($($expected.Count) files)" }
else { Say "RESTORE-INCOMPLETE: $($bad2.Count) still bad"; $bad2 | ForEach-Object { Say "  $_" } }
Say "END"
