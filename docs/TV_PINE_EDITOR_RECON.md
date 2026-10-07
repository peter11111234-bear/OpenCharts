# TV Pine Editor 偵察記錄（2026-10-07）

來源：使用者的 TradingView 帳號（bear9927）實機操作截圖，存於 `Temp/tv-recon-*` / `tv-r*-*`。
目標：OpenCharts `/vela` 的 Pine 編輯器 100% 對齊 TV 的功能邏輯，不自創 UI。

## 結構

TV 的 Pine Editor 是**右側 dock 面板**（可 Collapse/Close），不是 modal。
Header 由左到右：

| 位置 | 元素 | 行為（實機驗證） |
|---|---|---|
| 最左 | `Pine Editor` 標題 | 面板名 |
| | `~` 圖示 | 重新編譯/重整（refresh） |
| | `Untitled script ▾` | 腳本名 dropdown（見下） |
| | `Add to chart` | 把編輯中的腳本跑到目前 chart |
| | `⭮` | 另一個 refresh（旋轉箭頭圖示） |
| | `Save` | 儲存（Ctrl+S） |
| 最右 | `Publish script` `⋯` `—` `✕` | 發佈 / 更多選單 / 最小化 / 關閉 |

Statusbar（底部）：
- `Line 1, Col 1`（可點 → 跳行列）
- `Pine Script® v6`（可點 → Open Pine Reference 連結）

編輯區：語法高亮 + 行號 + CodeMirror textarea（`Alt+F1` 無障礙選項提示）。

## `Untitled script ▾` 下拉選單（實機截圖證據）

```
Save script            Ctrl+S
Make a copy…
Rename…
Version history…
Move script to bottom
─────────────────
Create new ▸
─────────────────
RECENTLY USED
  雙週期MACDV7
  TRISv3.74
  見高K V4.5
  智能123法則
─────────────────
Open script…           Ctrl+O
```

逐項拆解：

- **Save script (Ctrl+S)** — 命名/存檔。首次存檔會問名字；之後 Ctrl+S 直接覆寫。
- **Make a copy…** — 複製一份另存（彈命名框）。
- **Rename…** — 改名（彈命名框）。
- **Version history…** — 開該腳本的版本列表（TV 端自動記每次 save 的版本），可還原。
- **Move script to bottom** — 面板從右側 dock 移到圖表下方（dock 位置切換，傳統 TV 是底部面板）。
- **Create new ▸** — 子選單，選腳本模板（Indicator / Strategy / Library 等）。
- **Recently used** — 最近 4 支腳本直接點名載入（TV 雲端存的個人腳本）。
- **Open script… (Ctrl+O)** — 開啟腳本瀏覽對話框（清單＋搜尋）。

## 指標列的 ⋯ → 源碼（使用者截圖證據）

每個圖上指標的 legend 列右邊 hover 會浮出：
`[👁 顯示/隱藏][⚙ 設定][{ } 源碼][🗑 移除][⋯ 更多]`

⋯（更多）選單裡有 **Source code / 源碼** —— 點了直接開 Pine Editor 載入該指標的 source。
這是我們目前缺的通路：legend 沒有 ⋯，只有平鋪圖示。

## Indicators 對話框（實機截圖證據）

- 左邊分類 rail：**Personal → Favorites / My scripts / Invite-only / Purchased**；**Built-In → Technicals / Fundamentals**；**Community → Editors' picks / Top / Trending / Marketplace**
- 上方：搜尋列 + `All | Indicators | Strategies | More` tabs
- 右邊表格：Name | Author | Boosts（讚數），每列有 ★ 收藏切換
- 「My scripts」= 使用者自己的腳本（TV 雲端）

## 我們目前的差距

| TV 行為 | 我們現況 | 缺口 |
|---|---|---|
| Script library（個人腳本清單） | 只有 `src/pine/*.pine` manifest + localStorage `pine-hist:` | 沒有「我的腳本」一等物件 |
| 檔名 ▾ 檔案操作 | 無（只有一個「載入腳本」select） | Save/Save As/Rename/Duplicate/Recent/Open 全缺 |
| 版本歷史 | `pine-hist:{title}` 最多 20 筆、按 title 存 | 有但看不到、不能預覽 diff |
| Open script 對話框 | 無 | 缺搜尋清單 UI |
| Add to chart | Run 鈕（runIndicator） | 有，但語意不同（TV 是「把編輯中腳本加進圖」） |
| Save | Add via shell | 語意不同——TV Save 是存檔，我們是加指標 |
| Legend ⋯ → 源碼 | 無 ⋯；有 edit/move 圖示 | 缺收合 ⋯ 選單與「編輯源碼」項目 |
| Statusbar（行列/版本/文件連結） | 無 | 缺 |
| Indicators 對話框「我的腳本」 | manifest 只給 `src/pine` 檔案 | 使用者存的腳本不會出現在 picker |

## 關鍵 API 錨點（已驗證存在）

- `registerLegendCallout`（`contributions.d.ts`）— legend 列的可點氣泡，可開 panel 放按鈕清單 → 這就是做 ⋯ 選單的管道
- `ctx.addIndicator({name, script, id, language:'pine'})` — 已用
- `ctx.chart.runIndicator(src, {overlay|pane})` — 已用
- `registerStatePersistence({key:'opencharts.pine-scripts', scope:'cell'})` — external script 持久化已接
- `VelaShellOptions.indicators`（`IndicatorLoader`）— 可餵 async manifest，把「我的腳本」併入 picker
- `storage` adapter — `persist` 已有，localStorage adapter 預設
