# CRITICAL：src/pine 還原來源警告（2026-10-15 18:20 寫入）

## 現況

- `src/pine` 目前是**基線 `b9fcd81`**（`git diff b9fcd81 -- src/pine` 為空；`mtf.ts` 2246 行、無 `cwPeak`；`ta.ts` 2010 行、無 `WIN_LEN_MAX`）。
- R5 優化**從未 commit**：`git show HEAD:src/pine/mtf.ts` 無 `cwPeak`。

## 只有這兩份是有效的優化樹

| 路徑 | 驗證 |
|---|---|
| `%TEMP%\r5-snapshot-B-20261015-1800\pine` | runner pre-flight，18:00:10；`mtf.ts` 2411 行、`cwPeak` ×4、md5 `79d67c66b8e19349b4fdaeeaef5d3d79` |
| `scratch/perf/r5-pine-optimized-b9/pine` | 上述的複本，131 檔，md5 逐檔相同 |

## 不要用這個

`%TEMP%\t7-optimized-1800\pine` —— **名字騙人**。它建立於 **18:06**，晚於回退動作，內容是**基線**（`mtf.ts` 2246 行、`cwPeak` 0、md5 `085213e34276f89042240be9048d0f01`）。
用它還原 = 還原成基線，而且**它自帶的 md5 清單也是回退後記的**，自檢會假通過。

## 正確還原

```bash
cd /c/Users/bear9/OpenCharts
cp -r "$TEMP/r5-snapshot-B-20261015-1800/pine/." src/pine/
md5sum src/pine/mtf.ts   # 期望 79d67c66b8e19349b4fdaeeaef5d3d79
grep -c cwPeak src/pine/mtf.ts   # 期望 4（非 0）
wc -l src/pine/interpreter.ts src/pine/mtf.ts src/pine/builtins/ta.ts
# 期望 ≈ 3964 / 2412 / 2165（基線為 3779 / 2246 / 2010）
npx vitest run src/pine     # 954 passed | 1 skipped
```

`logs/r5-snapshot-latest.txt` 指向 runner 快照（正確的那份）；`scripts/autorun/verify-restore.ps1` 讀它。

## 紅線

1. 還原後**不要**再 `git checkout b9fcd81 -- src/pine`（會再次清掉 R5 成果）；要做 A/B 就複製整棵樹到別的目錄，不要動 worktree。
2. 任何 patch-buffer／回退前，先確認 `md5sum src/pine/mtf.ts` = `79d67c66…`。
3. `src/pine/graphify-out/` 是未追蹤產物，還原時不必理它。
