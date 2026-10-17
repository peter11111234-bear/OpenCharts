# 2026-10-15 18:3x — 還原來源安全網驗證（獨立案，不改 CRITICAL 檔）

## 結論
`scripts/autorun/verify-restore.ps1` 會還原成**正確的優化樹**，「假通過」風險不成立。

## 證據

| 項 | 值 |
|---|---|
| `logs/r5-snapshot-latest.txt` | `%TEMP%\r5-snapshot-B-20261015-1800` |
| runner 快照 `md5-before.txt` 記錄的 `mtf.ts` | `79d67c66b8e19349b4fdaeeaef5d3d79` ← **優化版**，不是基線 `085213e3…` |
| runner 快照實際 `pine/mtf.ts` md5 | `79d67c66b8e1…` 與清單一致 |
| md5-before 條目數 | 120 |
| `scratch/perf/r5-pine-optimized-b9/pine` 與 runner 快照 | 130 檔逐檔 md5 相同，0 差異 |

## 為什麼不會假通過

`verify-restore.ps1` ① 優先讀 `logs/r5-snapshot-latest.txt` 指標檔 → 拿到 runner 快照；
用它自帶的 `md5-before.txt` 與 `src/pine` 逐檔比對；不一致就從該快照複製回去再複檢。
② 的 TEMP 掃描退路**只在 ① 落空時**才跑，所以若它自建了回退後的新 `r5-snapshot-*` 也不會被選中。
快照清單記的是優化雜湊 ⇒ restore 目標是優化樹 ⇒ 自檢不可能對著基線通過。

## 仍存的洞（非雜湊問題，是時序問題）

1. 腳本只在**有人執行它時**才生效。窗口 B 若用自己的邏輯還原而不跑這支，仍可能用錯來源。
2. 現在**不能**跑它：`src/pine` 正在被窗口 B 做 A/B 量測，此時覆寫＝污染數字。
3. `%TEMP%`  volumes 有被清風險 → `scratch/perf/r5-pine-optimized-b9/pine` 是 repo 內的副本，優先以它為長期來源。

## 正確操作時序

1. 等窗口 B process 結束（`powershell run-r5-remaining.ps1 -Window B` 與其 `pi.cmd` node 全數退出）。
2. `md5sum src/pine/mtf.ts` → 期望 `79d67c66…`；不等就跑
   `powershell -ExecutionPolicy Bypass -File scripts/autorun/verify-restore.ps1`。
3. 再跑 `npx vitest run src/pine` → 954 passed | 1 skipped。

## 相關

- 主警示：`docs/2026-10-15-r5-CRITICAL-restore-warning.md`
- T7 探索 brief：`scratch/perf/t7/EXPLORE-BRIEF.md`
