"""Forward return tracking: pending queue, deadline-based backfill."""

from . import config


class ForwardTracker:
    """Tracks pending forward-return fills for detected events."""

    __slots__ = ("pending",)

    def __init__(self):
        self.pending: list[dict] = []

    def add(self, event_ts: int, price: float, code: str, fwd_dict: dict) -> None:
        self.pending.append({
            "event_ts": event_ts, "price": price, "code": code,
            "deadlines": {w: event_ts + w for w in config.FWD_WINDOWS},
            "fwd": fwd_dict,
        })

    def check(self, ts: int, price: float, code: str) -> list[dict]:
        """Fill due forward returns for this code only. Returns fwd_update records."""
        updates = []
        for pf in self.pending:
            if pf["code"] != code:
                continue
            for w in config.FWD_WINDOWS:
                key = f"{w // 60}m"
                if pf["fwd"][key] is None and ts >= pf["deadlines"][w]:
                    pct = round((price - pf["price"]) / pf["price"] * 100, 3)
                    pf["fwd"][key] = pct
                    updates.append({"fwd_update": {"code": code,
                                                   "event_ts": pf["event_ts"],
                                                   "window": key, "pct": pct}})
        self.pending = [p for p in self.pending
                        if any(v is None for v in p["fwd"].values())]
        return updates
