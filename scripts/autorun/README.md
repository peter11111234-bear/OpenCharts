# `scripts/autorun/` — R5 剩餘工作自動跑

## 排程（2026-10-15 一次性）
| 工作名 | 時間 | 指令 |
|---|---|---|
| `OpenCharts-R5-Autorun-1200` | 12:00 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autorun\run-r5-remaining.ps1 -Window A -BudgetMinutes 105` |
| `OpenCharts-R5-Autorun-1800` | 18:00 | 同上，`-Window B` |

兩者都 `/IT`（需使用者登入）。**窗口 B 是「沒跑完就續跑」**：它先讀狀態檔，只做非 `done` 的項目。

## 檔案
| 用途 | 路徑 |
|---|---|
| 工作簡報（給代理的 prompt，用 `@file` 附帶） | `docs/2026-10-15-r5-remaining-autorun.md` |
| 狀態檔（代理每完成一項就更新） | `docs/2026-10-15-r5-autorun-status.json` |
| 成果報告（代理寫） | `docs/2026-10-15-r5-autorun-report.md` |
| 日誌 | `logs/r5-autorun-<Window>-<stamp>.log`（pi stdout）／`.log.err`／`.runner.log`（runner 自己的記錄） |
| 快照 + 前後 md5 | `%TEMP%\r5-snapshot-<Window>-<stamp>\`（`pine/`＋`golden/`＋`md5-before.txt`＋`md5-after.txt`） |

## 守望機制（runner 自己做）
1. 開工先快照 `src/pine` 與 `scripts/golden`，並記下 `src/pine` 全部檔案的 md5。
2. 用 `Start-Process pi -p @brief "<ASCII 指令>" --mode text` 起代理（訊息主體是 ASCII，中文全在 `@file`，避開 codepage 亂碼）。
3. `Wait-Process -Timeout (BudgetMinutes*60)`；逾時 → `taskkill /T /F`（連子行程）。
4. 收工再算一次 md5 並與開工前比對：`TREE-IDENTICAL` / `TREE-CHANGED`（後者會列出差異）／清單為空則報 `INTEGRITY-CHECK-FAILED`。

## 手動操作
```bat
:: 立即跑一次（真跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autorun\run-r5-remaining.ps1 -Window NOW -BudgetMinutes 105
:: 只驗 runner 機制（不起 pi；60 秒後強制終止，測守望＋md5）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autorun\run-r5-remaining.ps1 -Window DRY -BudgetMinutes 1 -DryRun
:: 取消排程
schtasks /Delete /TN "OpenCharts-R5-Autorun-1200" /F
schtasks /Delete /TN "OpenCharts-R5-Autorun-1800" /F
```

## 已知環境限制
- 本機 `powershell.exe -NoProfile` **沒有 `Get-FileHash`**（`Get-Command` 找不到）→ runner 改用 .NET
  `[System.Security.Cryptography.MD5]::Create()` 自己算（`Md5Hex` 函式）。
- `pi.cmd` 的 `@file` 必須是**獨立參數**；把 `@path 其他文字` 放進同一個引號字串會被當成檔名（實測報
  `File not found: ...md`）。
- Vite 綁 IPv6：`localhost:5173` 通、`127.0.0.1:5173` 可能不通。
