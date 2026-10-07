import { useEffect, useState } from "react";

interface StockRow {
  code: string; name: string; net: number; buy: number; sell: number;
  l1: number; l2: number; price: number; fwd5m?: number;
}
interface AlertItem { time: string; code: string; name: string; alert: string; net_large: number }
interface EventItem { time: string; code: string; name: string; level: string; side: string; vol_tick: number; amount_tick: number; price: number }
interface Data { ts: string; top: StockRow[]; alerts: AlertItem[]; events: EventItem[] }

export function HotScannerPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let dead = false;
    async function tick() {
      try {
        const r = await fetch("/hot/data");
        if (!r.ok) throw new Error(`${r.status}`);
        const d = await r.json();
        if (!dead) { setData(d); setErr(""); }
      } catch (e) { if (!dead) setErr(String(e)); }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => { dead = true; clearInterval(id); };
  }, []);

  if (err) return <div className="p-2 text-xs text-red-400">scanner API 未連線</div>;
  if (!data) return <div className="p-2 text-xs text-muted-foreground">載入中…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-1.5 text-[11px] font-mono space-y-3">
      <div className="text-[10px] text-muted-foreground">更新 {data.ts}</div>

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-[#d29922] mb-0.5">警報</div>
          {data.alerts.slice(-5).reverse().map((a, i) => (
            <div key={i} className="text-[#d29922] leading-tight">
              {a.time} {a.code} {a.name} {a.alert === "buy_exhaustion" ? "買盤衰竭" : "賣壓減輕"} {(a.net_large / 1e6).toFixed(0)}M
            </div>
          ))}
        </div>
      )}

      {/* Net ranking */}
      <div>
        <div className="text-[10px] font-bold text-[#58a6ff] mb-0.5">淨大單排行</div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-[9px] text-muted-foreground">
              <th className="text-left">代碼</th><th className="text-right">淨額</th>
              <th className="text-right">L1</th><th className="text-right">L2</th>
            </tr>
          </thead>
          <tbody>
            {data.top.slice(0, 15).map((s) => (
              <tr key={s.code} className="border-b border-border/30">
                <td className="py-0.5">{s.code} <span className="text-muted-foreground">{s.name}</span></td>
                <td className={`py-0.5 text-right ${s.net >= 0 ? "text-[#3fb950]" : "text-[#f85149]"}`}>
                  {(s.net / 1e6).toFixed(0)}M
                </td>
                <td className="py-0.5 text-right">{s.l1}</td>
                <td className="py-0.5 text-right">{s.l2}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent events */}
      <div>
        <div className="text-[10px] font-bold text-[#58a6ff] mb-0.5">最近事件</div>
        {data.events.slice(-15).reverse().map((e, i) => (
          <div key={i} className="leading-tight border-b border-border/20 py-0.5">
            <span className="text-muted-foreground">{e.time}</span>{" "}
            {e.code} <span className="text-muted-foreground">{e.name}</span>{" "}
            <span className="text-[#8b949e]">[{e.level}]</span>{" "}
            <span className={e.side === "buy" ? "text-[#3fb950]" : "text-[#f85149]"}>
              {e.side === "buy" ? "買" : "賣"}
            </span>{" "}
            {e.vol_tick}張 {(e.amount_tick / 1e6).toFixed(0)}M @{e.price}
          </div>
        ))}
      </div>
    </div>
  );
}
