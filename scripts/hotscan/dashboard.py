"""Dashboard: HTTP server serving a live view of hot-scanner events.

Run: python -m hotscan.dashboard [--port 8788]
Open: http://127.0.0.1:8788
"""
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from . import config
from .flow import flow_series
from .storage import load_watchlist


TAIPEI = timezone(timedelta(hours=config.TZ_OFFSET))
PORT = 8790

HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hot Scanner</title>
<style>
body{font-family:monospace;background:#0d1117;color:#c9d1d9;margin:16px}
h1{font-size:18px;color:#58a6ff}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:4px 8px;text-align:right;border-bottom:1px solid #21262d}
th{color:#8b949e;text-align:right}td:first-child,th:first-child{text-align:left}
.buy{color:#3fb950}.sell{color:#f85149}.alert{color:#d29922;font-weight:bold}
.net-pos{color:#3fb950}.net-neg{color:#f85149}
#ts{color:#8b949e;font-size:12px;margin-bottom:8px}
</style></head><body>
<h1>Hot Scanner — 大單即時監控</h1>
<div id="ts"></div><div id="stale" style="display:none;background:#f85149;color:#fff;padding:8px;font-weight:bold;margin-bottom:8px"></div>
<h2>淨大單排行（近 60 分鐘）</h2>
<table id="t"><thead><tr><th>代碼</th><th>名稱</th><th>淨額</th><th>買</th><th>賣</th><th>成交張數</th><th>L1</th><th>L2簇</th><th>最新價</th><th>fwd5m</th><th>資料時間</th></tr></thead><tbody></tbody></table>
<div id="flowbox" style="display:none;margin:12px 0"><h2 id="flowtitle"></h2><canvas id="flowcv" width="1100" height="560" style="width:100%;background:#161b22;border:1px solid #30363d"></canvas><div id="flowlegend" style="font-size:12px;margin-top:4px"></div></div>
<h2>最近警報 <select id="arange" onchange="refresh()" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;font-size:12px"><option value="0" selected>全部</option><option value="3600">近 60 分鐘</option></select></h2><div id="alerts"></div>
<h2>最近事件 <select id="erange" onchange="refresh()" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;font-size:12px"><option value="0" selected>全部</option><option value="3600">近 60 分鐘</option></select></h2>
<table id="e"><thead><tr><th>時間</th><th>代碼</th><th>名稱</th><th>層級</th><th>方向</th><th>張數</th><th>金額</th><th>價格</th></tr></thead><tbody></tbody></table>
<script>
async function refresh(){
  const d=await(await fetch('/data')).json();
  document.getElementById('ts').textContent='更新: '+d.ts+' (資料延遲 '+d.data_age+'s)';
  const st=document.getElementById('stale');
  if(d.data_age>60){st.style.display='block';st.textContent='⚠ 資料已停止更新 '+d.data_age+' 秒 — 檢查 shioaji server / scanner';}else{st.style.display='none';}
  const tb=document.querySelector('#t tbody');tb.innerHTML='';
  for(const s of d.top){
    const tr=document.createElement('tr');
    const nc=s.net>=0?'net-pos':'net-neg';
    tr.innerHTML=`<td>${s.code}</td><td>${s.name}</td><td class="${nc}">${(s.net/1e6).toFixed(0)}M</td><td class="buy">${(s.buy/1e6).toFixed(0)}M</td><td class="sell">${(s.sell/1e6).toFixed(0)}M</td><td>${s.vol||0}</td><td>${s.l1}</td><td>${s.l2}</td><td>${s.price}</td><td>${s.fwd5m!=null?s.fwd5m.toFixed(2)+'%':''}</td><td>${s.last_time||''}</td>`;
    tr.style.cursor='pointer';tr.onclick=()=>showFlow(s.code,s.name);
    tb.appendChild(tr);
  }
  const ad=document.getElementById('alerts');ad.innerHTML='';
  const range=parseInt(document.getElementById('arange').value);
  const now=Date.now()/1000;
  const shown=d.alerts.filter(a=>range===0||(now-a.ts)<=range);
  for(const a of shown.slice(-20).reverse()){
    const div=document.createElement('div');div.className='alert';
    div.textContent=`${a.time} ${a.code} ${a.name} ${a.alert} net=${(a.net_large/1e6).toFixed(0)}M`;
    ad.appendChild(div);
  }
  if(shown.length===0){ad.innerHTML='<div style="color:#8b949e">（無警報）</div>';}
  const eb=document.querySelector('#e tbody');eb.innerHTML='';
  const erange=parseInt(document.getElementById('erange').value);
  const eshown=d.events.filter(e=>erange===0||(now-e.ts)<=erange);
  for(const e of eshown.slice(-50).reverse()){
    const tr=document.createElement('tr');
    const sc=e.side==='buy'?'buy':'sell';
    tr.innerHTML=`<td>${e.time}</td><td>${e.code}</td><td>${e.name}</td><td>${e.level}</td><td class="${sc}">${e.side}</td><td>${e.vol_tick}</td><td>${(e.amount_tick/1e6).toFixed(0)}M</td><td>${e.price}</td>`;
    eb.appendChild(tr);
  }
}
refresh();setInterval(refresh,3000);

const BANDS=[['xl','超大','#ff2d55'],['large','大','#f85149'],['mid','中','#d29922'],['small','小','#3fb950'],['retail','散戶','#8b949e']];
async function showFlow(code,name){
  const box=document.getElementById('flowbox');box.style.display='block';
  document.getElementById('flowtitle').textContent=`${code} ${name} — 分級累計淨額(張)`;
  const d=await(await fetch('/flow?code='+code)).json();
  const cv=document.getElementById('flowcv'),ctx=cv.getContext('2d');
  const W=cv.width,H=cv.height,pad=44,n=d.ts.length;
  ctx.clearRect(0,0,W,H);
  if(!n){ctx.fillStyle='#8b949e';ctx.fillText('無資料',pad,H/2);return;}
  // 三竹風格：大單累計(超大+大) + 散戶累計(<20萬) 兩面板
  const panels=[['large_net','大單累積(超大+大)','#f85149'],['small_net','散戶累積(<20萬)','#3fb950']];
  const ph=Math.floor((H-30)/panels.length);
  const x=i=>pad+i/(n-1||1)*(W-pad-8);
  const fmt=t=>{const d=new Date(t*1000);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};
  ctx.font='12px monospace';
  panels.forEach(([key,label,color],pi)=>{
    const y0=pi*ph+4, hh=ph-8;
    const data=d[key];
    let mn=Math.min(...data,0),mx=Math.max(...data,0);
    if(mn===mx){mn-=1;mx+=1;}
    const y=v=>y0+(mx-v)/(mx-mn)*(hh-30)+22;
    // frame + min/max labels
    ctx.strokeStyle='#21262d';ctx.strokeRect(pad,y0,W-pad-8,hh);
    ctx.fillStyle='#8b949e';
    ctx.fillText(mx.toFixed(0),4,y0+22);ctx.fillText(mn.toFixed(0),4,y0+hh);
    // zero line
    ctx.strokeStyle='#30363d';ctx.beginPath();ctx.moveTo(pad,y(0));ctx.lineTo(W-8,y(0));ctx.stroke();
    // filled area
    ctx.fillStyle=color+'55';ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();
    ctx.moveTo(x(0),y(0));
    data.forEach((v,i)=>ctx.lineTo(x(i),y(v)));
    ctx.lineTo(x(n-1),y(0));ctx.closePath();ctx.fill();
    ctx.beginPath();data.forEach((v,i)=>{i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v));});ctx.stroke();
    // header: 大單累積買超 14,853張
    const last=data[n-1],dir=last>=0?'買超':'賣超';
    ctx.fillStyle=color;ctx.font='bold 13px monospace';
    ctx.fillText(`${label}${dir} ${last.toLocaleString()}張`,pad+6,y0+14);
    ctx.font='12px monospace';
  });
  ctx.fillStyle='#8b949e';
  for(let i=0;i<n;i+=Math.ceil(n/6))ctx.fillText(fmt(d.ts[i]),x(i)-14,H-6);
  document.getElementById('flowlegend').innerHTML='點其他代碼切換';
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
</script></body></html>"""


def load_events() -> tuple[list[dict], list[dict], dict]:
    events, alerts, fwd = [], [], {}
    # all history: hot-scanner.jsonl + dated/rotated logs, oldest first
    paths = sorted(config.LOG_DIR.glob("hot-scanner*.jsonl"),
                   key=lambda p: p.stat().st_mtime)
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "alert" in d:
                alerts.append(d)
            elif "fwd_update" in d:
                u = d["fwd_update"]
                fwd.setdefault(u["event_ts"], {})[u["window"]] = u["pct"]
            elif "code" in d:
                events.append(d)
    return events, alerts, fwd


# cache: byte offset + aggregated data (incremental, append-only file)
_tick_cache = {"offset": 0, "agg": {}, "open": {}}

def _read_new_lines() -> list[str]:
    """Read only bytes appended since last call."""
    tick_log = config.LOG_DIR / "hot-ticks.jsonl"
    if not tick_log.exists():
        return []
    size = tick_log.stat().st_size
    if size <= _tick_cache["offset"]:
        return []
    with tick_log.open("r", encoding="utf-8") as f:
        f.seek(_tick_cache["offset"])
        data = f.read()
        _tick_cache["offset"] = f.tell()
    return data.splitlines()

# dedup by physical tick identity — live SSE and backfill write the same tick
# with different field sets, so composite keys miss; dt (microsecond) is the
# only reliable key, composite is fallback for old-format rows
_seen_ticks: set = set()
_seen_day: int = 0

def _tick_vol(t: dict, a: dict) -> int:
    """Per-tick volume.

    Raw `vol` IS the per-print truth — verified: ts-ordered raw sum tracks
    official total_volume within ~0.3%. The ONLY corruption source is auction
    sim rows (08:30-09:00, 13:25-13:30): tv stays flat while `vol` reports
    overlapping simulated-match sizes — a real trade always increments tv,
    so flat tv + vol>0 = not a trade. Using tv-delta instead would double-count
    backfilled rows whose volume the delta already spans.
    """
    vol = t.get("vol") or 0
    tv = t.get("total_volume")
    if tv is None:
        return vol  # backfill rows: real per-print volume
    prev = a.get("prev_tv")
    a["prev_tv"] = int(tv)
    if prev is not None and int(tv) == prev:
        return 0  # flat tv = 試撮快照列, 非成交
    return vol

def _today_start_ts() -> int:
    now = datetime.now(TAIPEI)
    return int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())

def _load_name_map() -> dict:
    """code→name from latest watchlist; tick-only rows have no event to carry the name."""
    try:
        return {s["code"]: s.get("name", s["code"]) for s in load_watchlist()}
    except Exception:
        return {}


def _agg_tick(t: dict) -> None:
    # today only — jsonl is append-only across days; without this filter
    # yesterday's ticks inflate today's buy/sell/net ranking
    today0 = _today_start_ts()
    if t.get("ts", 0) < today0:
        return
    global _seen_day
    if _seen_day != today0:  # new trading day — drop yesterday's keys
        _seen_ticks.clear()
        _seen_day = today0
    key = (t["code"], t.get("dt") or (t["ts"], t["price"], t.get("vol"), t.get("tick_type", 0)))
    if key in _seen_ticks:
        return
    _seen_ticks.add(key)
    code = t["code"]
    if code not in _tick_cache["open"]:
        _tick_cache["open"][code] = t["price"]
    a = _tick_cache["agg"].setdefault(code, {"code": code, "name": code,
                                            "buy": 0, "sell": 0, "l1": 0, "l2": 0, "l2_ticks": 0,
                                            "price": 0, "net": 0, "vol": 0, "last_ts": 0})
    if a.get("tv_day") != today0:  # total_volume resets daily — stale prev_tv would zero the first delta
        a["tv_day"] = today0
        a["prev_tv"] = None
    vol = _tick_vol(t, a)
    amt = vol * t["price"] * 1000
    tt = t.get("tick_type", 0)
    if tt == 1:
        a["buy"] += amt
    elif tt == 2:
        a["sell"] += amt
    a["price"] = t["price"]
    a["vol"] += vol
    tv = t.get("total_volume")
    if tv is not None:
        tv = int(tv)
        if tv > a.get("last_tv", 0):
            a["last_tv"] = tv  # 交易所官方累計 — 張數以此為準, 不受 delta/backfill 交錯影響
    if t["ts"] > a["last_ts"]:
        a["last_ts"] = t["ts"]

def _preload_ticks():
    n = 0
    for line in _read_new_lines():
        try:
            _agg_tick(json.loads(line))
            n += 1
        except Exception:
            pass
    print(f"preloaded {n} ticks")

_preload_ticks()

def build_data() -> dict:
    events, alerts, fwd = load_events()
    today0 = _today_start_ts()
    events = [e for e in events if e.get("ts", 0) >= today0]
    alerts = [a for a in alerts if a.get("ts", 0) >= today0]
    agg = _tick_cache["agg"]
    for line in _read_new_lines():
        try:
            _agg_tick(json.loads(line))
        except Exception:
            pass
    # overlay event data
    for e in events:
        code = e["code"]
        a = agg.setdefault(code, {"code": code, "name": e.get("name", code),
                                  "buy": 0, "sell": 0, "l1": 0, "l2": 0, "l2_ticks": 0,
                                  "price": e.get("price", 0), "net": 0, "vol": 0, "last_ts": 0})
        a["name"] = e.get("name", code)
        if e.get("level") == "L1":
            a["l1"] += 1
        if e.get("level") == "L2":
            if e.get("l2_ticks", 0) == 3:  # tick that completes the cluster — count once
                a["l2"] += 1
            a["l2_ticks"] = e.get("l2_ticks", 0)  # latest, not sum
        a["price"] = e.get("price", a["price"])
        f5 = fwd.get(e["ts"], {}).get("5m")
        if f5 is not None:
            a["fwd5m"] = f5
    for a in agg.values():
        a["net"] = a["buy"] - a["sell"]
        a["buy_ratio"] = round(a["buy"] / a["sell"], 1) if a["sell"] > 0 else (999.0 if a["buy"] > 0 else 1.0)
    names = _load_name_map()
    for a in agg.values():
        a["name"] = names.get(a["code"], a["name"])
        if a.get("last_tv"):
            # 自校驗: 逐筆累加張數 vs 官方累計 — 偏差 >2% = 缺口或重複, 頁面亮 ⚠
            a["vol_calc"] = a["vol"]
            a["vol"] = a["last_tv"]
            a["vol_ok"] = abs(a["vol_calc"] - a["last_tv"]) <= max(20, a["last_tv"] * 0.02)
    for a in agg.values():
        a["open"] = _tick_cache["open"].get(a["code"], a["price"])
        a["last_time"] = datetime.fromtimestamp(a["last_ts"], TAIPEI).strftime("%H:%M:%S") if a["last_ts"] else ""
    top = sorted(agg.values(), key=lambda x: -abs(x["net"]))
    def fmt_ts(ts):
        return datetime.fromtimestamp(ts, TAIPEI).strftime("%H:%M:%S")
    for e in events:
        e["time"] = fmt_ts(e["ts"])
    for a in alerts:
        a["time"] = fmt_ts(a["ts"])
    max_ts = max((a["last_ts"] for a in agg.values()), default=0)
    data_age = int(time.time() - max_ts) if max_ts else -1
    return {"ts": datetime.now(TAIPEI).strftime("%H:%M:%S"),
            "data_age": data_age,
            "top": top[:50], "alerts": alerts, "events": events}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/data":
            body = json.dumps(build_data(), ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
        elif parsed.path == "/flow":
            code = parse_qs(parsed.query).get("code", [""])[0]
            body = json.dumps(flow_series(code) if code else {"error": "missing code"},
                              ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
        else:
            body = HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError):
            pass  # client disconnected; ignore

    def log_message(self, *a):
        pass


def main() -> int:
    port = PORT
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    print(f"dashboard on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
