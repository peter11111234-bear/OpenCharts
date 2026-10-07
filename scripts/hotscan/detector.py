"""Detection: L1 single-print, L1-lite mid-print, L2 cluster detection."""

from collections import deque
from . import config


class Detector:
    """Per-stock three-tier detector driven by price-tier thresholds."""

    __slots__ = ("tier", "l2_window")

    def __init__(self, price: float):
        self.tier = config.tier_for(price)
        self.l2_window: deque = deque()  # (ts, amount, dir) of ticks >= l2 threshold

    def check(self, ts: int, amount: float, tick_dir: int) -> dict:
        """Classify a tick. Returns {l1, l1_lite, l2_cluster}."""
        t = self.tier
        is_l1 = amount >= t["l1"]
        is_l1_lite = t["l1_lite"] > 0 and t["l1_lite"] <= amount < t["l1"]

        # L2 cluster: track ticks >= l2 threshold
        is_l2_tick = amount >= t["l2"]
        l2_cluster = False
        same_dir = 0
        if is_l2_tick:
            self.l2_window.append((ts, amount, tick_dir))
            cutoff = ts - config.L2_CLUSTER_WINDOW
            while self.l2_window and self.l2_window[0][0] < cutoff:
                self.l2_window.popleft()
            # count same-direction ticks in window
            dirs = [d for _, _, d in self.l2_window]
            same_dir = sum(1 for d in dirs if d == tick_dir)
            if len(dirs) >= config.L2_CLUSTER_COUNT:
                if all(d >= 0 for d in dirs) or all(d <= 0 for d in dirs):
                    l2_cluster = True

        return {"l1": is_l1, "l1_lite": is_l1_lite, "l2_tick": is_l2_tick,
                "l2_cluster": l2_cluster, "l2_ticks": same_dir}
