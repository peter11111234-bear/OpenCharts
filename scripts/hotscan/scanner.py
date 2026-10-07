"""Main scanner loop: wires watchlist → subscribe → SSE → detect → alert → log."""

import json
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone, timedelta

from . import config, storage, stream, tradingday
from .stats import StockStats
from .detector import Detector
from .alerts import check_reversal, format_alert
from .forward import ForwardTracker

TICK_LOG = config.LOG_DIR / "hot-ticks.jsonl"  # all raw ticks

TAIPEI = timezone(timedelta(hours=config.TZ_OFFSET))


def _tick_epoch(t: dict) -> int:
    try:
        return int(datetime.fromisoformat(
            f"{t.get('date', '')}T{t.get('time', '')}").replace(tzinfo=TAIPEI).timestamp())
    except Exception:
        return int(time.time())


def _tick_price(t: dict) -> float:
    try:
        return float(t.get("close", 0))
    except (TypeError, ValueError):
        return 0.0


class Scanner:
    def __init__(self, stocks: list[dict]):
        self.stocks = stocks
        self.states: dict[str, StockStats] = {}
        self.seen_ticks: set[tuple] = set()  # (code, ts, price, vol) dedup
        self.detectors: dict[str, Detector] = {}
        self.fwd = ForwardTracker()
        self._last_tick_ts = time.time()  # baseline: 連一筆都沒收過也算 stall
        self.meta: dict[str, dict] = {}
        self.recent_l2: dict[str, deque] = {}   # code -> deque[(ts, dir)] L2 ticks
        self.last_alert: dict[str, int] = {}    # code -> ts of last alert
        for s in stocks:
            code = s["code"]
            self.states[code] = StockStats()
            # use yesterday close for tier assignment
            est_price = s.get("close", 100)
            self.detectors[code] = Detector(est_price)
            self.meta[code] = s
        self._rebuild_pending()

    def _rebuild_pending(self) -> None:
        """Rebuild ForwardTracker.pending from event log (survives restart)."""
        events, _, fwd_done = storage.read_events()
        now = int(time.time())
        for e in events:
            code = e.get("code")
            if code not in self.states:
                continue
            # merge already-filled fwd values
            filled = fwd_done.get(e["ts"], {})
            fwd = e.get("fwd", {})
            for w in config.FWD_WINDOWS:
                key = f"{w // 60}m"
                if fwd.get(key) is None and key in filled:
                    fwd[key] = filled[key]
            # re-add any event with unfilled windows — next tick fills overdue ones
            if any(v is None for v in fwd.values()):
                deadlines = {w: e["ts"] + w for w in config.FWD_WINDOWS}
                self.fwd.pending.append({
                    "event_ts": e["ts"], "price": e.get("price", 0),
                    "code": code, "deadlines": deadlines, "fwd": fwd,
                })

    def on_tick(self, code: str, t: dict) -> None:
        self._last_tick_ts = time.time()
        st = self.states.get(code)
        det = self.detectors.get(code)
        meta = self.meta.get(code)
        if not st or not det or not meta:
            return
        price = _tick_price(t)
        ts = _tick_epoch(t)
        if price <= 0:
            return
        # real per-tick volume: auction ticks report cumulative simulated vol —
        # use total_volume delta when present, else vol delta within auction.
        raw_vol = t.get("volume", 0) or 0
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
        # dedup: same tick may be resent on SSE reconnect.
        # key = full datetime string (microsecond) when present — second-level
        # (ts, price, vol) collides on legit same-size same-price ticks.
        key = (code, t.get("date", ""), t.get("time", "")) if t.get("time") else (code, ts, price, raw_vol, t.get("tick_type", 0))
        if key in self.seen_ticks:
            return
        self.seen_ticks.add(key)
        if len(self.seen_ticks) > 200000:
            self.seen_ticks.clear()  # bound memory

        # log all raw ticks for amount verification
        storage.append_jsonl(TICK_LOG, {
            "ts": ts, "dt": f"{t.get('date', '')}T{t.get('time', '')}",
            "code": code, "price": price, "vol": vol,
            "tick_type": t.get("tick_type", 0), "amount": t.get("amount", 0),
            "total_volume": t.get("total_volume"),
        })

        tick_dir = st.on_tick(ts, price, vol)
        # use tick_type for real direction: 1=外盤(buy), 2=內盤(sell), 0=unknown
        tt = t.get("tick_type", 0)
        if tt == 1:
            tick_dir = 1
        elif tt == 2:
            tick_dir = -1
        # else keep tick_dir from price change
        amount = vol * price * 1000  # vol in 張 → 元

        result = det.check(ts, amount, tick_dir)

        if result["l1"] or result["l1_lite"] or result["l2_tick"]:
            st.mark_large()
            direction = tick_dir if tick_dir != 0 else 1  # first tick: default buy
            st.update_net(ts, amount, direction)
            if result["l2_tick"]:
                dq = self.recent_l2.setdefault(code, deque(maxlen=200))
                dq.append((ts, direction))

            level = "L1" if result["l1"] else "L1L" if result["l1_lite"] else "L2"
            event = {
                "ts": ts, "bar_time": st.bar["time"], "code": code,
                "name": meta.get("name", code), "exchange": meta.get("exchange", ""),
                "side": "buy" if direction > 0 else "sell",
                "level": level,
                "price": price, "vol_tick": vol, "amount_tick": round(amount),
                "tick_dir": tick_dir, "consec_large_1m": st.consec_large,
                "l2_ticks": result["l2_ticks"], "l2_cluster": result["l2_cluster"],
                "stats": st.rolling(ts),
                "net_large": st.net_summary(),
                "fwd": {f"{w // 60}m": None for w in config.FWD_WINDOWS},
            }
            self.fwd.add(ts, price, code, event["fwd"])
            storage.append_jsonl(config.SCANNER_LOG, event)

            tag = {"L1": "L1", "L1L": "L1L", "L2": "L2"}[level]
            print(f"{datetime.fromtimestamp(ts, TAIPEI):%H:%M:%S} {code} {meta.get('name', code)} "
                  f"[{tag}] {'BUY' if direction > 0 else 'SELL'} {vol}張 @{price} "
                  f"= {amount / 1e6:.0f}M net={st.net_large / 1e6:+.0f}M")

            if result["l2_cluster"]:
                print(f"  ** L2 CLUSTER {code} {meta.get('name', code)} "
                      f"{st.consec_large} consecutive **")

            # L3 v2: need opposite-direction L2 tick in last 60s + cooldown
            opp_cut = ts - config.L3_OPPOSITE_WINDOW
            recent = self.recent_l2.get(code, ())
            recent_buy = any(d > 0 for t2, d in recent if t2 >= opp_cut)
            recent_sell = any(d < 0 for t2, d in recent if t2 >= opp_cut)
            alert = check_reversal(
                st.net_large, st.net_peak, st.net_trough,
                det.tier["l3_min"], code, meta.get("name", code), ts,
                recent_buy=recent_buy, recent_sell=recent_sell,
                last_alert_ts=self.last_alert.get(code, 0))
            if alert:
                storage.append_jsonl(config.SCANNER_LOG, alert)
                print(f"  {format_alert(alert)}")
                self.last_alert[code] = ts
                # re-anchor peak/trough after firing
                if alert["alert"] == "buy_exhaustion":
                    st.reset_peak(ts)
                else:
                    st.reset_trough(ts)
        else:
            st.reset_consec()

        # fwd backfill
        for upd in self.fwd.check(ts, price, code):
            storage.append_jsonl(config.SCANNER_LOG, upd)

    def _start_stall_guard(self) -> None:
        """Market hours + no tick >180s → die; watchdog restart + backfill 接手。
        死因不明時把「靜默殭屍」轉成「可查的死亡」。"""
        def guard() -> None:
            while True:
                time.sleep(20)
                now = datetime.now(TAIPEI)
                secs = now.hour * 3600 + now.minute * 60 + now.second
                if (tradingday.is_trading_day(now.date())
                        and 9 * 3600 + 3 * 60 <= secs <= 13 * 3600 + 35 * 60
                        and time.time() - self._last_tick_ts > 180):
                    print("STALL: no tick >180s in market hours — exit(2)",
                          file=sys.stderr, flush=True)
                    os._exit(2)
        threading.Thread(target=guard, daemon=True).start()

    def run(self) -> None:
        self._start_stall_guard()
        primary = [s for s in self.stocks if s.get("role") == "primary"]
        alternate = [s for s in self.stocks if s.get("role") == "alternate"]
        print(f"watchlist: {len(primary)} primary + {len(alternate)} alternate")

        n = stream.subscribe_all(primary)
        print(f"subscribed {n}/{len(primary)}")
        if n < len(primary) and alternate:
            need = min(len(primary) - n, len(alternate))
            print(f"subscribing {need} alternates")
            stream.subscribe_all(alternate[:need])

        stream.stream_loop(primary, self.on_tick)


def run(date_str: str | None = None) -> None:
    stocks = storage.load_watchlist(date_str)
    scanner = Scanner(stocks)

    # 休市日（國定假日）整個資料面都靜默 — watchdog 會把「無 tick」當異常狂重啟。
    # 已在 scanner 層直接擋下，避免依賴上游不漏啟。
    if not tradingday.is_trading_day():
        print("non-trading day — scanner idle exit")
        return
    scanner.run()
