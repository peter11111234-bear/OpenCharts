/**
 * NautilusTrader Backtest integration for the Vela workspace.
 *
 * Contributes a topbar action ("Nautilus 回測") to:
 * 1. Open a parameter configuration & backtest execution modal.
 * 2. Dispatch event-driven backtest runs to the NautilusTrader backend (http://127.0.0.1:8000).
 * 3. Replay trade entries and exits directly onto Vela's chart using TimelineMarks.
 */

import { registerWidgetAction, type WidgetContext } from "@luxalgo/vela/plugin";
import type { TimelineMark } from "@luxalgo/vela";
import {
  checkNautilusHealth,
  runNautilusBacktest,
  type BacktestResponse,
} from "../services/nautilusClient.ts";

let modalEl: HTMLDivElement | null = null;
let latestResponse: BacktestResponse | null = null;

const MODAL_CSS = `
.vela-nautilus-modal {
  position: fixed;
  top: 60px;
  right: 24px;
  width: 380px;
  background: var(--vela-bg, #1e222d);
  color: var(--vela-fg, #d1d4dc);
  border: 1px solid var(--vela-border, #363c4e);
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.7);
  z-index: 10005;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.vela-nautilus-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--vela-surface, #161a24);
  border-bottom: 1px solid var(--vela-border, #2a2e39);
  font-weight: 600;
  user-select: none;
}
.vela-nautilus-close {
  background: none;
  border: 0;
  color: var(--vela-fg-muted, #868993);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}
.vela-nautilus-close:hover { color: var(--vela-fg, #fff); }
.vela-nautilus-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 80vh;
  overflow-y: auto;
}
.vela-nautilus-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.vela-nautilus-label {
  color: #868993;
  font-size: 12px;
}
.vela-nautilus-input {
  background: var(--vela-input-bg, #131722);
  border: 1px solid var(--vela-border, #363c4e);
  border-radius: 4px;
  color: var(--vela-fg, #fff);
  padding: 4px 8px;
  font-size: 12px;
  width: 130px;
  text-align: right;
  outline: none;
}
.vela-nautilus-input:focus { border-color: var(--vela-accent, #2962ff); }
.vela-nautilus-btn {
  background: var(--vela-accent, #2962ff);
  border: none;
  border-radius: 4px;
  color: #fff;
  font-weight: 600;
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
}
.vela-nautilus-btn:hover { opacity: 0.9; }
.vela-nautilus-btn.secondary {
  background: var(--vela-surface-hover, #2a2e39);
  color: var(--vela-fg, #d1d4dc);
}
.vela-nautilus-btn.secondary:hover { background: var(--vela-border, #363c4e); color: #fff; }
.vela-nautilus-btn {
  background: #2962ff;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-weight: 600;
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
}
.vela-nautilus-btn:hover { background: #1e53e5; }
.vela-nautilus-btn.secondary {
  background: #2a2e39;
  color: #d1d4dc;
}
.vela-nautilus-btn.secondary:hover { background: #363c4e; color: #fff; }
.vela-nautilus-status {
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  color: #b2b5be;
  text-align: center;
}
.vela-nautilus-card {
  background: #161a24;
  border: 1px solid #2a2e39;
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vela-nautilus-metric {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.vela-nautilus-metric-val {
  font-weight: 600;
}
.vela-nautilus-metric-val.up { color: #26a69a; }
.vela-nautilus-metric-val.down { color: #ef5350; }
`;

function ensureStyles(doc: Document): void {
  if (doc.head.querySelector("style[data-vela-nautilus]")) return;
  const s = doc.createElement("style");
  s.dataset.velaNautilus = "1";
  s.textContent = MODAL_CSS;
  doc.head.appendChild(s);
}

export function openNautilusBacktestModal(ctx: WidgetContext): void {
  const doc = ctx.host.ownerDocument;
  ensureStyles(doc);

  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }

  const modal = doc.createElement("div");
  modal.className = "vela-nautilus-modal";

  modal.innerHTML = `
    <div class="vela-nautilus-head">
      <span>🚀 NautilusTrader 台指期量化回測</span>
      <button class="vela-nautilus-close" title="關閉">✕</button>
    </div>
    <div class="vela-nautilus-body">
      <div id="nt-status" class="vela-nautilus-status">檢測引擎伺服器狀態中...</div>

      <div class="vela-nautilus-row">
        <span class="vela-nautilus-label">商品標的</span>
        <select id="nt-symbol" class="vela-nautilus-input" style="text-align:left;">
          <option value="TX" selected>大台指期 (TX)</option>
          <option value="MTX">小型台指 (MTX)</option>
          <option value="WMTX">微型台指 (WMTX)</option>
        </select>
      </div>

      <div class="vela-nautilus-row">
        <span class="vela-nautilus-label">快均線 (Fast EMA)</span>
        <input id="nt-fast" class="vela-nautilus-input" type="number" value="5" />
      </div>

      <div class="vela-nautilus-row">
        <span class="vela-nautilus-label">慢均線 (Slow EMA)</span>
        <input id="nt-slow" class="vela-nautilus-input" type="number" value="15" />
      </div>

      <div class="vela-nautilus-row">
        <span class="vela-nautilus-label">起始保證金 (TWD)</span>
        <input id="nt-cash" class="vela-nautilus-input" type="number" value="1000000" step="10000" />
      </div>

      <div class="vela-nautilus-row">
        <span class="vela-nautilus-label">回測 K 棒數 (1分K)</span>
        <input id="nt-bars" class="vela-nautilus-input" type="number" value="120" step="10" />
      </div>

      <button id="nt-run-btn" class="vela-nautilus-btn">
        <span>▶ 執行事件驅動回測</span>
      </button>

      <div id="nt-result-box" style="display:none; flex-direction:column; gap:8px;">
        <div class="vela-nautilus-card">
          <div class="vela-nautilus-metric">
            <span style="color:#868993">淨損益 (PnL)</span>
            <span id="nt-res-pnl" class="vela-nautilus-metric-val">0.00 TWD</span>
          </div>
          <div class="vela-nautilus-metric">
            <span style="color:#868993">期末淨值</span>
            <span id="nt-res-bal" class="vela-nautilus-metric-val">1,000,000 TWD</span>
          </div>
          <div class="vela-nautilus-metric">
            <span style="color:#868993">成交筆數 / 倉位數</span>
            <span id="nt-res-trades" class="vela-nautilus-metric-val">0 / 0</span>
          </div>
        </div>

        <button id="nt-render-btn" class="vela-nautilus-btn secondary">
          <span>🎯 在圖表上回放買賣點標記</span>
        </button>
        <button id="nt-clear-btn" class="vela-nautilus-btn secondary" style="font-size:11px; padding:4px 8px;">
          <span>✕ 清除標記</span>
        </button>
      </div>
    </div>
  `;

  modal.querySelector(".vela-nautilus-close")?.addEventListener("click", () => {
    modal.remove();
    modalEl = null;
  });

  doc.body.appendChild(modal);
  modalEl = modal;

  // DOM 綁定
  const statusEl = modal.querySelector("#nt-status") as HTMLDivElement;
  const runBtn = modal.querySelector("#nt-run-btn") as HTMLButtonElement;
  const resultBox = modal.querySelector("#nt-result-box") as HTMLDivElement;
  const resPnl = modal.querySelector("#nt-res-pnl") as HTMLSpanElement;
  const resBal = modal.querySelector("#nt-res-bal") as HTMLSpanElement;
  const resTrades = modal.querySelector("#nt-res-trades") as HTMLSpanElement;
  const renderBtn = modal.querySelector("#nt-render-btn") as HTMLButtonElement;
  const clearBtn = modal.querySelector("#nt-clear-btn") as HTMLButtonElement;

  // 1. 檢測健康狀態
  checkNautilusHealth().then((health) => {
    if (health) {
      statusEl.textContent = `🟢 引擎就緒: ${health.engine} v${health.version} (${health.market})`;
      statusEl.style.color = "#26a69a";
    } else {
      statusEl.textContent = "🔴 後端未連線 (請在 nautilus-engine 啟動 uvicorn api.server:app)";
      statusEl.style.color = "#ef5350";
    }
  });

  // 2. 執行回測
  runBtn.addEventListener("click", async () => {
    const symbol = (modal.querySelector("#nt-symbol") as HTMLSelectElement).value;
    const fast_ema = parseInt((modal.querySelector("#nt-fast") as HTMLInputElement).value, 10);
    const slow_ema = parseInt((modal.querySelector("#nt-slow") as HTMLInputElement).value, 10);
    const initial_cash = parseFloat((modal.querySelector("#nt-cash") as HTMLInputElement).value);
    const num_bars = parseInt((modal.querySelector("#nt-bars") as HTMLInputElement).value, 10);

    runBtn.disabled = true;
    runBtn.textContent = "撮合運算中...";
    statusEl.textContent = "⏳ NautilusTrader 事件驅動撮合中...";
    statusEl.style.color = "#2962ff";

    try {
      const res = await runNautilusBacktest({
        symbol,
        fast_ema,
        slow_ema,
        initial_cash,
        num_bars,
      });

      latestResponse = res;
      statusEl.textContent = "✅ 回測完成！";
      statusEl.style.color = "#26a69a";

      // 渲染摘要
      const sum = res.summary;
      const isUp = sum.total_pnl >= 0;
      resPnl.textContent = `${isUp ? "+" : ""}${sum.total_pnl.toLocaleString()} TWD (${isUp ? "+" : ""}${sum.pnl_pct}%)`;
      resPnl.className = `vela-nautilus-metric-val ${isUp ? "up" : "down"}`;
      resBal.textContent = `${sum.ending_balance.toLocaleString()} TWD`;
      resTrades.textContent = `${sum.total_orders} 筆 / ${sum.total_positions} 次`;

      resultBox.style.display = "flex";
    } catch (e) {
      statusEl.textContent = `❌ 回測失敗: ${e instanceof Error ? e.message : String(e)}`;
      statusEl.style.color = "#ef5350";
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "▶ 執行事件驅動回測";
    }
  });

  // 3. 回放買賣標記到 Vela 圖表
  renderBtn.addEventListener("click", () => {
    const markers = latestResponse?.trade_markers;
    if (!markers || !Array.isArray(markers) || markers.length === 0) {
      statusEl.textContent = "⚠️ 尚無可回放的成交標記！";
      statusEl.style.color = "#f0b90b";
      return;
    }

    const marks: TimelineMark[] = markers.map((trade, idx) => {
      const isBuy = trade.side === "BUY";
      const timeMs = Math.floor(trade.ts_event / 1_000_000);

      return {
        id: `nt-trade-${idx}-${trade.client_order_id}`,
        time: timeMs,
        title: `Nautilus: ${trade.side} ${trade.qty} 口 @ ${trade.price}`,
        tooltip: `${trade.side === "BUY" ? "多單買進" : "空單賣出"} | 價格: ${trade.price} | 口數: ${trade.qty}`,
        group: "nautilus-trades",
        glyph: {
          shape: "circle",
          color: isBuy ? "#26a69a" : "#ef5350",
          letter: isBuy ? "B" : "S",
        },
      };
    });

    try {
      ctx.chart.marks.defineGroup({
        id: "nautilus-trades",
        label: "Nautilus 回測成交標記",
        visible: true,
      });
      ctx.chart.marks.set(marks);
      statusEl.textContent = `🎯 已將 ${marks.length} 個買賣標記渲染到圖表！`;
      statusEl.style.color = "#26a69a";
    } catch (err) {
      statusEl.textContent = `渲染標記失敗: ${err instanceof Error ? err.message : String(err)}`;
      statusEl.style.color = "#ef5350";
    }
  });

  // 4. 清除標記
  clearBtn.addEventListener("click", () => {
    try {
      ctx.chart.marks.clear();
      statusEl.textContent = "已清除圖表標記。";
      statusEl.style.color = "#b2b5be";
    } catch {}
  });
}

// 註冊至 Vela 頂部工具列
registerWidgetAction({
  id: "nautilus-backtest-action",
  target: "topbar",
  icon: "replay",
  label: "Nautilus 回測",
  order: 1,
  run: (ctx) => openNautilusBacktestModal(ctx),
});
