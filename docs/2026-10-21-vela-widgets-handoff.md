# 交接：VELA 輔助面板與 TradingView 風格小工具

> **日期：** 2026-10-21
> **狀態：** 程式碼已寫進 OpenCharts，自動化驗證全過；**尚未在瀏覽器人工驗收，全部未 commit**
> **背景知識：** `myopenchart` skill（`~/.claude/skills/myopenchart/`），特別是 `references/tv-widgets.md`、`vela-plugin-api.md`、`shioaji-server.md`

## 1. 做了什麼

決策：不用 `react-ts-tradingview-widgets`（它只是 iframe，資料進不去也拿不出來），改用 VELA plugin API 原生實作，資料來自 Shioaji ＋ 自研 Pine 引擎。

| # | 小工具 | 入口 | 主要檔案 |
|---|---|---|---|
| 1 | 技術評分（半圓儀表＋均線/震盪兩列） | 頂列「評分」→ 側邊面板 `opencharts.tech-rating` | `src/pine/tech-rating.pine`、`src/pages/techRating.ts`、`techRatingPanel.ts`、`velaTechRating.ts` |
| 2 | 報價列（加權 IX0001、大台 TXFR1、小台 MXFR1、微台 TMFR1、台積電 2330） | 常駐條，attachment `opencharts.quote-strip`（`dockStrip`） | `src/pages/quoteStrip.ts` |
| 3 | 主題熱力圖（2026-10-21 起依 `src/data/techThemes.json` 的 11 個科技主題分組，取代原本的電子類 24–31；說明見 `src/pages/heatmap.README.md`） | 頂列「熱力圖」→ 側邊面板 `opencharts.heatmap` | `src/pages/heatmap.ts` |
| 4 | 排行榜（漲幅／跌幅／成交量／成交金額） | 頂列「排行」→ 側邊面板 `opencharts.hotlists` | `src/pages/hotlists.ts` |
| – | 共用 | | `src/services/shioaji/marketData.ts`、`src/pages/marketKit.ts`、`src/pages/velaMarketWidgets.ts` |

掛載點：`src/pages/VelaPage.tsx` 第 12、13 行兩個 side-effect import（`velaTechRating.ts`、`velaMarketWidgets.ts`）。

測試：`src/services/__tests__/marketData.test.ts`、`src/pages/__tests__/{quoteStrip,heatmap,hotlists}.test.ts`，以及技術評分的測試。

計畫與執行報告（Opus 寫並驗證程式碼 → DeepSeek 4.1 Flash 照計畫執行 → Opus 逐字比對驗收）：
- `docs/superpowers/plans/2026-10-20-vela-tech-rating-panel.md` ＋ `.report.md`
- `docs/superpowers/plans/2026-10-20-vela-quote-widgets.md` ＋ `.report.md`

## 2. 已驗證

- 全套 `npx vitest run`：92 檔／1234 passed／1 skipped／0 failed（2026-10-20）。
- `npx tsc --noEmit` 乾淨。
- 對真伺服器煙霧測試（盤後資料）：報價（TMFR1 46955 +1.32%、2330 2405 −0.61%）、熱力圖 1087 檔 → 60 格 7 組、四種排行都拿到 2026-10-20 資料、6547 解析為 OTC。
- DeepSeek 產出的 10 個檔與 Opus 驗證版逐字相同。

## 3. 還沒做（依序）

1. **瀏覽器人工驗收**：`npm run dev` → 開 `/vela`。
   - [ ] 報價列出現在圖表與底列之間，五張卡都有數字，紅漲綠跌。
   - [ ] 切換主圖商品後，報價列的「目前商品」約 1 秒內跟著變。
   - [ ] 熱力圖點 2330 → 主圖切到台積電。
   - [ ] 排行榜點一檔上櫃股（例 6547）→ 主圖切到 `OTC:6547`。**這條最可能出問題**；失敗就改 `velaMarketWidgets.ts` 裡 hotlists 的 `onPick`（目前送 `` `${exchange ?? "TSE"}:${code}` ``）。
   - [ ] 技術評分面板：儀表與兩列數字出現，切商品會重算。
   - [ ] 開一個面板會關掉另一個（`togglePanel` 互斥），沒有卡頓。
2. **commit 策略**（待使用者決定）：working tree 有使用者與其他 agent 未 commit 的改動（例如 `velaNautilusBacktest.ts` 的 import、MiniMax 在改的 `vite.config.ts`、`src/services/guard/*`），不能整包 `git add`。
3. **其他待決定**：
   - `norm2.pine`：還原，或從 golden 清單移除（見 `docs/2026-10-20-pine-interpreter-roadmap.md`）。
   - 是否移除沒人 import 的 npm 套件 `react-ts-tradingview-widgets`。

## 4. 接手前要知道的

- 目前只有**盤後資料**（白天收盤）。報價列 5 秒刷新的效果要有即時行情才看得到。
- Shioaji 伺服器在 `127.0.0.1:8080`，前端經 Vite `/shioaji` proxy。金鑰在 `C:\MyTradingProjects\.env`，**不要印出**。
- scanner 怪癖：`ascending:true` 回的是**最大的在前**；`date` 必填；非交易日回 `[]`（`fetchRanking` 會往前找）。
- 股票名稱可能是亂碼（U+FFFD），顯示以代碼為主（`cleanName`）。
- 已知資料異常：6467 泰合顯示 +89.57%，是伺服器資料（可能除權或新上市），不是程式錯。
- 小工具只讀；唯一能寫主圖的是使用者點擊時的 `ctx.setSymbol`，只在 `velaMarketWidgets.ts` 呼叫。
- 不要訂閱 VELA 的 `"state:changed"`（有事件風暴前科），跟隨商品一律輪詢 `ctx.symbol`。
- 不跑 `npx eslint`（設定本來就壞）。
- 用 CodeGraph 查程式碼時，從 OpenCharts 目錄要加 `-p C:/Users/bear9/MYOPENCHART`。
