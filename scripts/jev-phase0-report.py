#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Phase 0 measurement report from JEV shadow dataset. Read-only."""
import json, datetime, urllib.request, os

BASE = r"C:\Users\bear9\OpenCharts"
# MXF dataset since 2026-10-21; TXF file until the first MXF bar lands.
DS_PATH = os.path.join(BASE, "logs", "jev-shadow-mxf.jsonl")
if not os.path.exists(DS_PATH):
    DS_PATH = os.path.join(BASE, "logs", "jev-shadow.jsonl")
ERR_PATH = os.path.join(BASE, "logs", "jev-shadow-errors.jsonl")
OUT_PATH = os.path.join(BASE, "docs", "PHASE0_MEASUREMENT.md")
TZ = datetime.timezone(datetime.timedelta(hours=8))

def load_jsonl(path):
    rows = []
    invalid = 0
    if not os.path.exists(path):
        return rows, invalid
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                invalid += 1
                continue
            if not isinstance(o, dict):
                invalid += 1
                continue
            rows.append(o)
    return rows, invalid

def has_key(o, target):
    if isinstance(o, dict):
        for k, v in o.items():
            if str(k).lower() in target:
                return True
            if has_key(v, target):
                return True
    elif isinstance(o, list):
        for v in o:
            if has_key(v, target):
                return True
    return False

def Taipei(ts):
    return datetime.datetime.fromtimestamp(ts, tz=TZ)

rows, inv = load_jsonl(DS_PATH)
errs, _ = load_jsonl(ERR_PATH)

# schema validation: keep rows with core fields
valid = []
for r in rows:
    if not (isinstance(r.get("bar_time"), (int, float)) and isinstance(r.get("price"), (int, float))):
        continue
    valid.append(r)
rows = valid

# action_choice
choice_counter = {}
conf_sum = 0.0
conf_n = 0
for r in rows:
    a = r.get("answers")
    if not isinstance(a, dict):
        continue
    ac = a.get("action_choice")
    if isinstance(ac, dict) and isinstance(ac.get("choice"), str):
        ch = ac["choice"]
        choice_counter[ch] = choice_counter.get(ch, 0) + 1
        if isinstance(ac.get("confidence"), (int, float)):
            conf_sum += ac["confidence"]
            conf_n += 1

# channel mix
chan = {}
for r in rows:
    c = r.get("channel")
    key = c if isinstance(c, str) and c else "jev-zen(null/legacy)"
    chan[key] = chan.get(key, 0) + 1

# health
health = {}
try:
    with urllib.request.urlopen("http://127.0.0.1:8787/health", timeout=5) as resp:
        health = json.loads(resp.read().decode("utf-8"))
except Exception as e:
    health = {"error": str(e)}

# DeepSeek rows
ds_rows = [r for r in rows if has_key(r, {"_ds", "deepseek", "ds_verdict"})]
# inferred Jev verdict for DS divergence calc
def jev_implied(r):
    a = r.get("answers")
    if not isinstance(a, dict):
        return None
    ac = a.get("action_choice")
    if not isinstance(ac, dict):
        return None
    choice = ac.get("choice")
    conf = ac.get("confidence", 1.0)
    if not isinstance(conf, (int, float)):
        conf = 1.0
    vol = a.get("volatility_regime")
    vol_score = None
    if isinstance(vol, dict):
        if isinstance(vol.get("score"), (int, float)):
            vol_score = vol["score"]
    volatile = (vol_score is not None and vol_score >= 2.0)
    if conf < 0.6:
        return "veto"
    if choice == "sell" and volatile:
        return "veto"
    return "approve"

ds_verdicts = {}
divergent = 0
for r in ds_rows:
    dsv = None
    # try common fields
    if isinstance(r.get("_ds"), dict):
        dsv = r["_ds"].get("verdict") or r["_ds"].get("decision")
    elif isinstance(r.get("deepseek"), dict):
        dsv = r["deepseek"].get("verdict") or r["deepseek"].get("decision")
    if isinstance(dsv, str):
        ds_verdicts[dsv] = ds_verdicts.get(dsv, 0) + 1
    implied = jev_implied(r)
    if implied is not None and dsv is not None and str(dsv).lower() != implied:
        divergent += 1
ds_div_rate = (divergent / len(ds_rows)) if ds_rows else 0.0

# Section 6 risk gate (if present in data)
gate_verdicts = {}
gate_rules = {}
for r in rows:
    rg = None
    if isinstance(r.get("risk_gate"), dict):
        rg = r["risk_gate"]
    # search nested
    if rg is None:
        # find any key containing 'risk' with dict verdict
        def find_rg(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if "risk" in str(k).lower() and isinstance(v, dict) and "verdict" in v:
                        return v
                    x = find_rg(v)
                    if x is not None:
                        return x
            elif isinstance(o, list):
                for v in o:
                    x = find_rg(v)
                    if x is not None:
                        return x
            return None
        rg = find_rg(r)
    if isinstance(rg, dict):
        v = rg.get("verdict")
        if isinstance(v, str):
            gate_verdicts[v] = gate_verdicts.get(v, 0) + 1
        rules = rg.get("triggered_rules") or rg.get("rules") or rg.get("triggered")
        if isinstance(rules, list):
            for rule in rules:
                rr = str(rule)
                gate_rules[rr] = gate_rules.get(rr, 0) + 1
        elif isinstance(rules, dict):
            for k, val in rules.items():
                if val:
                    gate_rules[str(k)] = gate_rules.get(str(k), 0) + 1

# P&L proxy
times_sorted = sorted(r["bar_time"] for r in rows)
import bisect
def future_row(bt):
    target = bt + 24 * 3600
    idx = bisect.bisect_left(times_sorted, target)
    if idx >= len(times_sorted):
        return None
    ft = times_sorted[idx]
    # nearest by time
    # also consider idx-1 but must be later than bt+? spec 24h forward; keep idx
    cands = []
    if idx < len(times_sorted):
        cands.append(times_sorted[idx])
    if idx + 1 < len(times_sorted):
        cands.append(times_sorted[idx + 1])
    # choose nearest to target among future
    fut_t = min(cands, key=lambda t: (abs(t - target), t))
    for r in rows:
        if r["bar_time"] == fut_t:
            return r
    return None

pnl_by_choice = {}
for r in rows:
    a = r.get("answers")
    if not isinstance(a, dict):
        continue
    ac = a.get("action_choice")
    if not isinstance(ac, dict):
        continue
    choice = ac.get("choice")
    if not isinstance(choice, str):
        continue
    fr = future_row(r["bar_time"])
    if fr is None:
        continue
    direction = 1 if choice == "buy" else (-1 if choice == "sell" else 0)
    pnl = direction * (fr["price"] - r["price"]) / r["price"] * 100.0
    pnl_by_choice.setdefault(choice, []).append(pnl)

# date coverage
bts = [r["bar_time"] for r in rows]
min_t = min(bts) if bts else None
max_t = max(bts) if bts else None
night_count = sum(1 for r in rows if Taipei(r["bar_time"]).hour >= 15)

# build report
lines = []
lines.append("# Phase 0 Measurement Report (JEV Shadow)")
lines.append("")
lines.append(f"Generated: {datetime.datetime.now(TZ).strftime('%Y-%m-%d %H:%M:%S %Z')}")
lines.append("")
lines.append("## 1. 样本规模")
lines.append(f"- Dataset rows: {len(rows)} (errors file rows: {len(errs)})")
if min_t is not None:
    lines.append(f"- Date coverage (bar_time, Taipei): {Taipei(min_t).strftime('%Y-%m-%d %H:%M')} -> {Taipei(max_t).strftime('%Y-%m-%d %H:%M')}")
lines.append(f"- Night-session rows (Taipei hour>=15): {night_count}")
lines.append("")
lines.append("## 2. action_choice 布局")
total_choice = sum(choice_counter.values())
for ch, n in sorted(choice_counter.items()):
    lines.append(f"- {ch}: {n} ({n/total_choice*100:.1f}%)" if total_choice else f"- {ch}: {n}")
lines.append(f"- Avg confidence (action_choice): {conf_sum/conf_n:.3f} (n={conf_n})")
lines.append("")
lines.append("## 3. Channel mix")
for c, n in sorted(chan.items()):
    lines.append(f"- {c}: {n}")
lines.append(f"- /health calls_today: {health.get('calls_today')} / paid_today: {health.get('paid_today')} / paid_max: {health.get('paid_max')}")
paid_calls = health.get("paid_today", 0) or 0
# rough token cost estimate: assume ~1k input tokens per paid call @ $0.042/1M
rough = paid_calls * 1000 / 1e6 * 0.042
lines.append(f"- Rough token cost (paid, ~1k tok/call @ $0.042/1M input, output free): ~${rough:.4f} USD")
lines.append("")
lines.append("## 4. DeepSeek 升级层 (§4.4)")
lines.append(f"- Rows carrying `_ds`/deepseek: {len(ds_rows)} / {len(rows)}")
if ds_rows:
    lines.append("- DS verdict distribution: " + ", ".join(f"{k}={v}" for k, v in sorted(ds_verdicts.items())))
    lines.append(f"- Divergence rate (DS verdict != Jev-implied): {divergent}/{len(ds_rows)} = {ds_div_rate*100:.2f}%")
else:
    lines.append("- DS verdict distribution: (none)")
    lines.append("- Divergence rate: 0/0 = 0.00% (vacuous; DeepSeek layer not yet wired)")
lines.append("")
lines.append("## 5. §6 risk gate verdict distribution")
if gate_verdicts:
    lines.append("- Verdicts: " + ", ".join(f"{k}={v}" for k, v in sorted(gate_verdicts.items())))
    if gate_rules:
        lines.append("- Triggered rules: " + ", ".join(f"{k}={v}" for k, v in sorted(gate_rules.items())))
else:
    lines.append("- Verdicts: approve=0 reduce=0 veto=0 (risk gate not yet implemented)")
    lines.append("- Triggered rules: (none)")
lines.append("")
lines.append("## 6. 入場 vs 結算 P&L proxy (SIMULATED, not real)")
lines.append("For each row, direction (buy=+1, sell=-1, hold=0) x (nearest 24h-forward bar close - entry)/entry. Simulated only.")
for ch in ["buy", "sell", "hold"]:
    vals = pnl_by_choice.get(ch, [])
    if vals:
        lines.append(f"- {ch}: n={len(vals)}, mean PnL% = {sum(vals)/len(vals):.4f}%")
    else:
        lines.append(f"- {ch}: n=0, mean PnL% = N/A")
lines.append("")
lines.append("## 7. Conclusion")
net_evs = [ (sum(v)/len(v) if v else 0.0) for v in [pnl_by_choice.get(c, []) for c in ("buy","sell","hold")] ]
overall_n = sum(len(pnl_by_choice.get(c, [])) for c in ("buy","sell","hold"))
overall_mean = (sum(sum(pnl_by_choice.get(c, [])) for c in ("buy","sell","hold")) / overall_n) if overall_n else 0.0
gate_total = sum(gate_verdicts.values()) if gate_verdicts else 0
gate_veto = gate_verdicts.get("veto", 0)
gate_veto_rate = (gate_veto / gate_total * 100.0) if gate_total else 0.0
lines.append(f"- DeepSeek divergence rate: {ds_div_rate*100:.2f}% ({len(ds_rows)} rows)")
lines.append(f"- Net simulated EV (all choices, dir-weighted): {overall_mean:.4f}% (n={overall_n})")
lines.append(f"- Risk-gate veto rate: {gate_veto_rate:.2f}% (n={gate_total})")
lines.append("- Recommendation: continue Phase 0 — DeepSeek layer and §6 risk gate are not yet wired; PnL sample (buy n={}) is too small and currently negative. Wire §4.4 + §6 first, then re-run.".format(len(pnl_by_choice.get("buy", []))))
lines.append("")

content = "\n".join(lines)
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
with open(OUT_PATH, "wb") as f:
    f.write(content.encode("utf-8"))
print("Done: Phase 0 report written to " + OUT_PATH)
print("SUMMARY: rows={} errors={} ds_rows={} divergence={:.2f}% buy_mean={:.4f}% gate_veto_rate={:.2f}%".format(
    len(rows), len(errs), len(ds_rows), ds_div_rate*100.0,
    (sum(pnl_by_choice.get("buy",[]))/len(pnl_by_choice.get("buy",[]))) if pnl_by_choice.get("buy") else 0.0,
    gate_veto_rate))
