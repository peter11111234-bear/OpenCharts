"""Replay ticks from hot-ticks.jsonl through detector to regenerate events."""
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from hotscan import config, storage
from hotscan.stats import StockStats
from hotscan.detector import Detector
from hotscan.alerts import check_reversal, format_alert
from hotscan.forward import ForwardTracker

TAIPEI = timezone(timedelta(hours=config.TZ_OFFSET))
TICK_LOG = config.LOG_DIR / "hot-ticks.jsonl"
EVENT_LOG = config.LOG_DIR / "hot-scanner.jsonl"


def main():
    stocks = {s["code"]: s for s in storage.load_watchlist()}
    states = {code: StockStats() for code in stocks}
    detectors = {code: Detector(s.get("close", 100)) for code, s in stocks.items()}
    fwd = ForwardTracker()
    seen = set()
    recent_l2: dict[str, list] = {}
    last_alert: dict[str, int] = {}

    # clear old events
    if EVENT_LOG.exists():
        EVENT_LOG.unlink()

    lines = TICK_LOG.read_text(encoding="utf-8").splitlines()
    print(f"replaying {len(lines)} ticks...")

    for line in lines:
        try:
            t = json.loads(line)
            code = t["code"]
            if code not in states:
                continue
            ts, price, raw_vol = t["ts"], t["price"], t["vol"]
            key = (code, ts, price, raw_vol)
            if key in seen:
                continue
            seen.add(key)

            st = states[code]
            det = detectors[code]
            meta = stocks[code]

            # real per-tick volume: auction ticks report cumulative simulated vol
            tv = t.get("total_volume")
            if tv is not None:
                tv = int(tv)
                prev_tv = st.prev_tv
                st.prev_tv = tv
                if prev_tv is None:
                    vol = raw_vol
                else:
                    delta = tv - prev_tv
                    if delta > 0:
                        st.prev_auc_vol = 0
                        vol = delta
                    else:
                        pv = st.prev_auc_vol
                        st.prev_auc_vol = raw_vol
                        vol = max(0, raw_vol - pv)
            else:
                vol = raw_vol

            tick_dir = st.on_tick(ts, price, vol)
            tt = t.get("tick_type", 0)
            if tt == 1:
                tick_dir = 1
            elif tt == 2:
                tick_dir = -1

            amount = vol * price * 1000
            result = det.check(ts, amount, tick_dir)
            if result["l1"] or result["l1_lite"] or result["l2_tick"]:
                st.mark_large()
                direction = tick_dir if tick_dir != 0 else 1
                st.update_net(ts, amount, direction)
                if result["l2_tick"]:
                    recent_l2.setdefault(code, []).append((ts, direction))

                level = "L1" if result["l1"] else "L1L" if result["l1_lite"] else "L2"
                event = {
                    "ts": ts, "bar_time": st.bar["time"], "code": code,
                    "name": meta.get("name", code), "exchange": meta.get("exchange", ""),
                    "side": "buy" if direction > 0 else "sell",
                    "level": level, "price": price, "vol_tick": vol,
                    "amount_tick": round(amount), "tick_dir": tick_dir,
                    "consec_large_1m": st.consec_large, "l2_ticks": result["l2_ticks"],
                    "stats": st.rolling(ts), "net_large": st.net_summary(),
                    "fwd": {f"{w // 60}m": None for w in config.FWD_WINDOWS},
                }
                fwd.add(ts, price, code, event["fwd"])
                storage.append_jsonl(EVENT_LOG, event)

                opp_cut = ts - config.L3_OPPOSITE_WINDOW
                recent = recent_l2.get(code, [])
                recent_buy = any(d > 0 for t2, d in recent if t2 >= opp_cut)
                recent_sell = any(d < 0 for t2, d in recent if t2 >= opp_cut)
                alert = check_reversal(
                    st.net_large, st.net_peak, st.net_trough,
                    det.tier["l3_min"], code, meta.get("name", code), ts,
                    recent_buy=recent_buy, recent_sell=recent_sell,
                    last_alert_ts=last_alert.get(code, 0))
                if alert:
                    storage.append_jsonl(EVENT_LOG, alert)
                    last_alert[code] = ts
                    if alert["alert"] == "buy_exhaustion":
                        st.reset_peak(ts)
                    else:
                        st.reset_trough(ts)
            else:
                st.reset_consec()

            for upd in fwd.check(ts, price, code):
                storage.append_jsonl(EVENT_LOG, upd)
        except Exception as e:
            print(f"error: {e}", file=sys.stderr)

    print("done")


if __name__ == "__main__":
    main()
