"""Rolling stats: 1m bar aggregation, 5/15/30/60m windows, net_large tracking."""

from collections import deque
from . import config


def minute_bucket(epoch: int) -> int:
    return epoch - (epoch % 60)


class StockStats:
    """Per-stock rolling state: bars, large events, net_large, consec."""

    __slots__ = ("bars_1m", "bar", "large_events", "net_large", "net_history",
                 "peak_anchor", "trough_anchor", "consec_large", "last_price",
                 "last_tick_price", "last_dir", "prev_tv", "prev_auc_vol")

    def __init__(self):
        self.bar: dict | None = None
        self.bars_1m: deque = deque(maxlen=60)
        self.large_events: deque = deque(maxlen=500)  # (ts, amount, dir)
        self.net_large = 0.0
        self.net_history: deque = deque(maxlen=2000)  # (ts, net) for windowed extremes
        self.peak_anchor = 0    # ignore net_history before this ts (post-alert reset)
        self.trough_anchor = 0
        self.consec_large = 0
        self.last_price = 0.0
        self.last_tick_price = 0.0
        self.last_dir = 0
        self.prev_tv: int | None = None   # last total_volume seen (auction fix)
        self.prev_auc_vol = 0             # last cumulative auction vol

    def on_tick(self, ts: int, price: float, vol: float) -> int:
        """Update tick direction and 1m bar. Returns tick_dir.

        Tick rule: price up → +1, down → -1, unchanged → inherit last_dir.
        This avoids the bias of comparing to bar open (which misclassifies
        flat-price stocks as all-buy in uptrends).
        """
        if self.last_tick_price > 0:
            if price > self.last_tick_price:
                self.last_dir = 1
            elif price < self.last_tick_price:
                self.last_dir = -1
            # unchanged → keep last_dir
        self.last_tick_price = price
        self.last_price = price

        bucket = minute_bucket(ts)
        if self.bar is None or self.bar["time"] != bucket:
            if self.bar is not None:
                self.bars_1m.append(self.bar)
            self.bar = {"time": bucket, "open": price, "high": price, "low": price,
                        "close": price, "volume": vol, "large": False}
        else:
            self.bar["high"] = max(self.bar["high"], price)
            self.bar["low"] = min(self.bar["low"], price)
            self.bar["close"] = price
            self.bar["volume"] += vol
        return self.last_dir

    def mark_large(self) -> None:
        if self.bar:
            self.bar["large"] = True
        self.consec_large += 1

    def reset_consec(self) -> None:
        self.consec_large = 0

    def update_net(self, ts: int, amount: float, direction: int) -> None:
        self.large_events.append((ts, amount, direction))
        cutoff = ts - config.NET_WINDOW
        while self.large_events and self.large_events[0][0] < cutoff:
            self.large_events.popleft()
        self.net_large = sum(a * d for _, a, d in self.large_events)
        self.net_history.append((ts, self.net_large))
        # prune history beyond peak window
        pcut = ts - config.L3_PEAK_WINDOW
        while self.net_history and self.net_history[0][0] < pcut:
            self.net_history.popleft()

    @property
    def net_peak(self) -> float:
        """Rolling 30min peak of net_large, ignoring pre-anchor history."""
        vals = [n for t, n in self.net_history if t >= self.peak_anchor]
        return max(vals, default=0.0)

    @property
    def net_trough(self) -> float:
        """Rolling 30min trough of net_large, ignoring pre-anchor history."""
        vals = [n for t, n in self.net_history if t >= self.trough_anchor]
        return min(vals, default=0.0)

    def reset_peak(self, ts: int) -> None:
        """After buy_exhaustion fires: re-anchor peak at current point."""
        self.peak_anchor = ts

    def reset_trough(self, ts: int) -> None:
        """After sell_relief fires: re-anchor trough at current point."""
        self.trough_anchor = ts

    def rolling(self, now: int) -> dict:
        """Aggregate 5/15/30/60m stats from completed 1m bars."""
        out = {}
        for w in config.STAT_WINDOWS:
            cutoff = now - w
            vol = buy_v = sell_v = buy_a = sell_a = lb = ls = 0
            first_close = None
            for b in reversed(self.bars_1m):
                if b["time"] < cutoff:
                    break
                vol += b["volume"]
                amt = b["volume"] * b["close"] * 1000
                if b["close"] > b["open"]:
                    buy_v += b["volume"]
                    buy_a += amt
                elif b["close"] < b["open"]:
                    sell_v += b["volume"]
                    sell_a += amt
                if b.get("large"):
                    if b["close"] > b["open"]:
                        lb += 1
                    else:
                        ls += 1
                if first_close is None:
                    first_close = b["open"]
            chg = ((self.last_price - first_close) / first_close * 100) if first_close else 0
            out[f"{w // 60}m"] = {
                "vol": vol, "buy_vol": buy_v, "sell_vol": sell_v,
                "buy_amt": round(buy_a), "sell_amt": round(sell_a),
                "large_buy": lb, "large_sell": ls, "chg_pct": round(chg, 2),
            }
        return out

    def net_summary(self) -> dict:
        buy = sum(a for _, a, d in self.large_events if d > 0)
        sell = sum(a for _, a, d in self.large_events if d < 0)
        return {"buy_amt": round(buy), "sell_amt": round(sell), "net": round(self.net_large)}
