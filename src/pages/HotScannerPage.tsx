import { useEffect, useRef, useState } from "react";

interface StockRow {
  code: string;
  name: string;
  net: number;
  buy: number;
  sell: number;
  l1: number;
  l2: number;
  l2_ticks?: number;
  buy_ratio?: number;
  fwd5m?: number;
  price: number;
  open?: number;
  vol?: number;
  vol_ok?: boolean;
  last_time?: string;
}

interface AlertItem {
  time: string;
  ts: number;
  code: string;
  name: string;
  alert: string;
  net_large: number;
}

interface EventItem {
  time: string;
  ts: number;
  code: string;
  name: string;
  level: string;
  side: string;
  vol_tick: number;
  amount_tick: number;
  price: number;
  l2_ticks?: number;
}

interface Data {
  ts: string;
  data_age?: number;
  top: StockRow[];
  alerts: AlertItem[];
  events: EventItem[];
}
interface FlowData {
  code: string;
  ts: number[];
  large_net: number[];
  small_net: number[];
}

function FlowChart({ code, name }: { code: string; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [d, setD] = useState<FlowData | null>(null);
  useEffect(() => {
    let dead = false;
    fetch(`/hotapi/flow?code=${code}`).then((r) => r.json()).then((j) => { if (!dead) setD(j); });
    return () => { dead = true; };
  }, [code]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !d || !d.ts.length) return;
    const ctx = cv.getContext("2d")!;
    const W = cv.width, H = cv.height, pad = 52, n = d.ts.length;
    ctx.clearRect(0, 0, W, H);
    const panels: ["large_net" | "small_net", string, string][] = [
      ["large_net", "大單累積", "#f85149"], ["small_net", "小單累積", "#3fb950"],
    ];
    const ph = Math.floor((H - 30) / panels.length);
    const x = (i: number) => pad + (i / (n - 1 || 1)) * (W - pad - 8);
    const fmt = (t: number) => { const dt = new Date(t * 1000); return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`; };
    ctx.font = "12px monospace";
    panels.forEach(([key, label, color], pi) => {
      const y0 = pi * ph + 4, hh = ph - 8;
      const data = d[key];
      let mn = Math.min(...data, 0), mx = Math.max(...data, 0);
      if (mn === mx) { mn -= 1; mx += 1; }
      const y = (v: number) => y0 + ((mx - v) / (mx - mn)) * (hh - 30) + 22;
      ctx.strokeStyle = "#21262d"; ctx.strokeRect(pad, y0, W - pad - 8, hh);
      ctx.fillStyle = "#8b949e";
      ctx.fillText(mx.toFixed(0), 4, y0 + 22); ctx.fillText(mn.toFixed(0), 4, y0 + hh);
      ctx.strokeStyle = "#30363d"; ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - 8, y(0)); ctx.stroke();
      ctx.fillStyle = color + "55"; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      ctx.moveTo(x(0), y(0));
      data.forEach((v, i) => ctx.lineTo(x(i), y(v)));
      ctx.lineTo(x(n - 1), y(0)); ctx.closePath(); ctx.fill();
      ctx.beginPath(); data.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); }); ctx.stroke();
      const last = data[n - 1] ?? 0, dir = last >= 0 ? "買超" : "賣超";
      ctx.fillStyle = color; ctx.font = "bold 13px monospace";
      ctx.fillText(`${label}${dir} ${last.toLocaleString()}張`, pad + 6, y0 + 14);
      ctx.font = "12px monospace";
    });
    ctx.fillStyle = "#8b949e";
    for (let i = 0; i < n; i += Math.ceil(n / 6)) ctx.fillText(fmt(d.ts[i] ?? 0), x(i) - 14, H - 6);
  }, [d]);
  return (
    <div className="my-2">
      <div className="mb-1 text-[#58a6ff]">{code} {name}</div>
      <canvas ref={ref} width={1100} height={560} className="w-full border border-[#30363d] bg-[#161b22]" />
      {!d && <div className="text-[#8b949e]">載入中…</div>}
    </div>
  );
}


export default function HotScannerPage() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [alertRange, setAlertRange] = useState(0);
  const [eventRange, setEventRange] = useState(0);
  const [flowCode, setFlowCode] = useState<{ code: string; name: string } | null>(null);

  useEffect(() => {
    let dead = false;
    async function tick() {
      try {
        const r = await fetch("/hotapi/data");
        if (!r.ok) throw new Error(`${r.status}`);
        const d = await r.json();
        if (!dead) { setData(d); setErr(""); }
      } catch (e) {
        if (!dead) setErr(String(e));
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    const wake = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      dead = true; clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  if (!data) return err
    ? <div className="p-4 text-red-400">dashboard API 未連線: {err}（自動重試中…）</div>
    : <div className="p-4 text-neutral-400">載入中…</div>;
  const now = Date.now() / 1000;
  const shownAlerts = data.alerts.filter((a) => alertRange === 0 || now - a.ts <= alertRange);
  const shownEvents = data.events.filter((e) => eventRange === 0 || now - e.ts <= eventRange);
  const sel = "ml-2 bg-[#21262d] text-[#c9d1d9] border border-[#30363d] text-[12px] font-normal";

  return (
    <div className="h-screen overflow-auto bg-[#0d1117] p-4 font-mono text-[13px] text-[#c9d1d9]">
      {err && (
        <div className="mb-2 bg-[#d29922] px-2 py-1 font-bold text-black">
          連線中斷（{err}）— 顯示最後更新資料，自動重試中…
        </div>
      )}
      <div className="mb-2 text-[#8b949e]">更新: {data.ts}{(data.data_age ?? 0) > 0 ? ` (資料延遲 ${data.data_age}s)` : ""}</div>
      {(data.data_age ?? 0) > 60 && (
        <div className="mb-2 bg-[#f85149] px-2 py-1 font-bold text-white">
          ⚠ 資料已停止更新 {data.data_age} 秒 — 檢查 shioaji server / scanner
        </div>
      )}

      <h2 className="mb-1 text-[#58a6ff]">淨大單排行（近 60 分鐘）</h2>
      <table className="mb-4 w-auto border-collapse">
        <thead>
          <tr className="text-[#8b949e]">
            <th className="px-2 py-0.5 text-left">代碼</th><th className="px-2 py-0.5 text-left">名稱</th>
            <th className="px-2 py-0.5 text-right">淨額</th><th className="px-2 py-0.5 text-right">買</th>
            <th className="px-2 py-0.5 text-right">賣</th><th className="px-2 py-0.5 text-right">成交張數</th>
            <th className="px-2 py-0.5 text-right">買/賣</th><th className="px-2 py-0.5 text-right">L1</th>
            <th className="px-2 py-0.5 text-right">5M3筆同向</th>
            <th className="px-2 py-0.5 text-right">最新價</th>
            <th className="px-2 py-0.5 text-right">fwd5m</th>
            <th className="px-2 py-0.5 text-right">資料時間</th>
          </tr>
        </thead>
        <tbody>
          {data.top.map((s) => (
            <tr key={s.code} className="cursor-pointer border-b border-[#21262d] hover:bg-[#161b22]"
                onClick={() => setFlowCode({ code: s.code, name: s.name === s.code ? "" : s.name })}>
              <td className="px-2 py-0.5">{s.code}</td><td className="px-2 py-0.5">{s.name === s.code ? "" : s.name}</td>
              <td className={`px-2 py-0.5 text-right ${s.net >= 0 ? "text-[#3fb950]" : "text-[#f85149]"}`}>
                {(s.net / 1e8).toFixed(1)}億
              </td>
              <td className="px-2 py-0.5 text-right text-[#3fb950]">{(s.buy / 1e8).toFixed(1)}億</td>
              <td className="px-2 py-0.5 text-right text-[#f85149]">{(s.sell / 1e8).toFixed(1)}億</td>
              <td className={`px-2 py-0.5 text-right ${s.vol_ok === false ? "font-bold text-[#f85149]" : ""}`}>
                {s.vol ?? 0}{s.vol_ok === false ? " ⚠" : ""}
              </td>
              <td className={`px-2 py-0.5 text-right ${(s.buy_ratio ?? 1) >= 2 ? "text-[#3fb950]" : (s.buy_ratio ?? 1) <= 0.5 ? "text-[#f85149]" : "text-[#8b949e]"}`}>
                {s.buy_ratio != null ? (s.buy_ratio >= 999 ? "∞" : `${s.buy_ratio.toFixed(1)}x`) : ""}
              </td>
              <td className="px-2 py-0.5 text-right">{s.l1}</td>
              <td className="px-2 py-0.5 text-right">{s.l2}{(s.l2_ticks ?? 0) > 0 ? `/${s.l2_ticks}` : ""}</td>
              <td className={`px-2 py-0.5 text-right ${s.price > (s.open ?? s.price) ? "text-[#f85149]" : s.price < (s.open ?? s.price) ? "text-[#3fb950]" : "text-[#c9d1d9]"}`}>
                {s.price}
              </td>
              <td className="px-2 py-0.5 text-right">{s.fwd5m != null ? `${s.fwd5m.toFixed(2)}%` : ""}</td>
              <td className="px-2 py-0.5 text-right text-[#8b949e]">{s.last_time ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {flowCode && <FlowChart code={flowCode.code} name={flowCode.name} />}

      <h2 className="mb-1 text-[#58a6ff]">最近警報（{shownAlerts.length} 筆）
        <select className={sel} value={alertRange} onChange={(e) => setAlertRange(Number(e.target.value))}>
          <option value={1800}>近 30 分鐘</option><option value={3600}>近 60 分鐘</option><option value={0}>全部</option>
        </select>
      </h2>
      <div className="mb-4" style={{maxHeight:"240px", overflowY:"auto", resize:"vertical", border:"1px solid #21262d", padding:"4px"}}>
        {(alertRange === 0 ? [...shownAlerts].reverse() : shownAlerts.slice(-20).reverse()).map((a, i) => (
          <div key={i} className={`font-bold ${a.alert === "sell_relief" ? "text-[#f85149]" : a.alert === "buy_exhaustion" ? "text-[#3fb950]" : "text-[#d29922]"}`}>
            {a.time} {a.code} {a.name === a.code ? "" : a.name} {a.alert === "sell_relief" ? "賣壓減輕" : a.alert === "buy_exhaustion" ? "買力耗盡" : a.alert} net={(a.net_large / 1e8).toFixed(1)}億
          </div>
        ))}
        {shownAlerts.length === 0 && <div className="text-[#8b949e]">尚無警報</div>}
      </div>

      <h2 className="mb-1 text-[#58a6ff]">最近事件（{shownEvents.length} 筆）
        <select className={sel} value={eventRange} onChange={(e) => setEventRange(Number(e.target.value))}>
          <option value={1800}>近 30 分鐘</option><option value={3600}>近 60 分鐘</option><option value={0}>全部</option>
        </select>
      </h2>
      <div style={{maxHeight:"480px", overflowY:"auto", resize:"vertical", border:"1px solid #21262d", padding:"4px"}}>
      <table className="w-auto border-collapse">
        <thead>
          <tr className="text-[#8b949e]">
            <th className="px-2 py-0.5 text-left">時間</th><th className="px-2 py-0.5 text-left">代碼</th>
            <th className="px-2 py-0.5 text-left">名稱</th><th className="px-2 py-0.5 text-left">層級</th>
            <th className="px-2 py-0.5 text-left">方向</th><th className="px-2 py-0.5 text-right">張數</th>
            <th className="px-2 py-0.5 text-right">金額</th><th className="px-2 py-0.5 text-right">價格</th>
            <th className="px-2 py-0.5 text-right">筆數</th>
          </tr>
        </thead>
        <tbody>
          {(eventRange === 0 ? [...shownEvents].reverse() : shownEvents.slice(-50).reverse()).map((e, i) => (
            <tr key={i} className="border-b border-[#21262d]">
              <td className="px-2 py-0.5">{e.time}</td><td className="px-2 py-0.5">{e.code}</td>
              <td className="px-2 py-0.5">{e.name === e.code ? "" : e.name}</td><td className="px-2 py-0.5">{e.level}</td>
              <td className={`px-2 py-0.5 ${e.side === "buy" ? "text-[#3fb950]" : "text-[#f85149]"}`}>
                {e.side}
              </td>
              <td className="px-2 py-0.5 text-right">{e.vol_tick}</td>
              <td className="px-2 py-0.5 text-right">{(e.amount_tick / 1e6).toFixed(0)}M</td>
              <td className="px-2 py-0.5 text-right">{e.price}</td>
              <td className="px-2 py-0.5 text-right">{e.level === "L2" ? (e.l2_ticks ?? "") : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
