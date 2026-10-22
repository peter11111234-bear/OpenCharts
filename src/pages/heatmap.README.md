# 主題熱力圖（Theme Heatmap）

Vela 看盤殼的側邊面板 `opencharts.heatmap`（頂列「熱力圖」按鈕）。依**自訂的科技供應鏈主題**分組顯示台股，用法和 TradingView 的 Stock Heatmap 類似。

> 2026-10-21 起取代原本的「電子熱力圖」。舊版依證交所產業別 24–31 分組，取權重前 60 檔。

## 畫面

- **下拉選單**
  - 「全部主題」：11 個主題各占一區，每區取成交金額前 8 檔。同一檔股票可能出現在好幾個主題裡。
  - 選單一主題：列出該主題的全部股票，依 `sub_group` 分區，區塊上方顯示主題說明。
- **方塊**
  - 顯示中文股名和漲跌幅。方塊太小時不顯示文字。
  - 滑鼠停在方塊上，會顯示代碼、子分類和角色說明（`role`）。
- **顏色**：紅漲綠跌，±3% 就是最深的顏色（`marketKit.heatColor`）。
- **面積**：依成交金額。上市和上櫃的指數權重基準不同、不能互比，所以不用權重。盤前全部是 0 時，方塊改成一樣大。
- **點擊**：點方塊會用 `EXCHANGE:CODE` 切換主圖（例如 `TSE:2330`、`OTC:3081`）。這是面板唯一會改動主圖的地方。
- **無報價**：查不到報價的股票會列在上方說明列，不會默默漏掉。
- **更新**：每 30 秒更新一次，打開面板時也會立即更新。

## 資料

| 來源 | 內容 |
|---|---|
| `src/data/techThemes.json` | 主題資料庫：11 個主題、309 檔股票。原檔是 `C:\Users\bear9\taiwan_advanced_tech_full_database.json` |
| Shioaji `POST /data/index_components` | 報價。上市取 `IND/TSE/IX0001`（1087 檔），上櫃取 `IND/OTC/IX0043`（893 檔），兩邊合併 |

JSON 格式（`ThemeDb`）：

```json
{
  "<theme_key>": {
    "title": "中文名 (English)",
    "description": "一句話說明",
    "stocks": {
      "8027": { "code": "8027", "name": "鈦昇", "sub_group": "3-1 TGV 成孔…", "role": "…" }
    }
  }
}
```

- 區塊標題只取 `title` 括號前面的中文部分（`shortTitle`）。
- `stocks` 的 key 必須等於 `code`（有測試檢查）。

**要更新主題：直接換掉 `src/data/techThemes.json` 即可**，程式不用改。換完後跑測試。如果主題數量不是 11，要同步修改測試裡「11 themes」的斷言。

## 已知限制

- 有 7 檔不在上市或上櫃指數成分股裡，所以沒有報價（2026-10-21 實測）：梭特 6812、盛新材料 6930、元鈦科 7892、智微 4925、乾瞻科技 7898、恆勁科技 6920、精星 8183。它們可能是興櫃股或新上市股。
- Shioaji 目前只有盤後資料。盤前的 `pct_chg` 和 `total_amount` 都是 0，所以畫面會是全灰、方塊等大。

## 程式位置

| 檔案 | 內容 |
|---|---|
| `src/pages/heatmap.ts` | `squarify`（treemap 排版）、`layoutThemeHeatmap`（分組和尺寸）、`mountHeatmapPanel`（畫面） |
| `src/services/shioaji/marketData.ts` | `fetchIndexEntries(http, "TSE" \| "OTC")` |
| `src/pages/velaMarketWidgets.ts` | 註冊側邊面板，合併上市和上櫃資料 |
| `src/pages/marketKit.ts` | 顏色、格式化、樣式（`.hm-*`） |

## 測試

```bash
npx vitest run src/pages/__tests__/heatmap.test.ts src/services/__tests__/marketData.test.ts
```

測試涵蓋：
- 總覽分組和前 N 檔，以及跨主題重複出現的股票
- 單一主題依子分類分區，面積和成交金額成正比
- 盤前方塊等大
- 內建 JSON 的格式
- 點擊後切換上櫃股
- 切換下拉選單時不會重新抓資料
- 伺服器錯誤時顯示警告
