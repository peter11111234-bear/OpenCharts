"""Alerts: L3 reversal detection + notification output."""

from . import config


def check_reversal(net_large: float, net_peak: float, net_trough: float,
                   l3_min: float, code: str, name: str, ts: int,
                   recent_buy: bool = True, recent_sell: bool = True,
                   last_alert_ts: int = 0) -> dict | None:
    """L3 v2: windowed reversal + opposite-flow confirmation + cooldown.

    Fire only when ALL hold:
      1. reversal size >= max(l3_min, 30% of peak/trough)
      2. peak/trough itself >= 2*l3_min (kills noise-level extremes)
      3. >=1 opposite-direction L2 tick in last L3_OPPOSITE_WINDOW sec
         (kills window-expiry fake reversals)
      4. >=L3_COOLDOWN sec since last alert on this stock (kills whipsaw)
    """
    if ts - last_alert_ts < config.L3_COOLDOWN:
        return None
    if net_peak >= 2 * l3_min:
        drop = net_peak - net_large
        if drop >= l3_min and drop / net_peak >= config.L3_REVERSAL_PCT \
                and recent_sell:
            return {"alert": "buy_exhaustion", "code": code, "name": name,
                    "net_large": round(net_large), "peak": round(net_peak),
                    "drop_pct": round(drop / net_peak, 2), "ts": ts}
    if net_trough <= -2 * l3_min:
        rise = net_large - net_trough
        if rise >= l3_min and rise / abs(net_trough) >= config.L3_REVERSAL_PCT \
                and recent_buy:
            return {"alert": "sell_relief", "code": code, "name": name,
                    "net_large": round(net_large), "trough": round(net_trough),
                    "rise_pct": round(rise / abs(net_trough), 2), "ts": ts}
    return None


def format_alert(a: dict) -> str:
    if a["alert"] == "buy_exhaustion":
        return (f"*** ALERT 買盤衰竭 {a['code']} {a['name']} "
                f"net={a['net_large'] / 1e6:+.0f}M peak={a['peak'] / 1e6:.0f}M "
                f"-{a['drop_pct'] * 100:.0f}% ***")
    return (f"*** ALERT 賣壓減輕 {a['code']} {a['name']} "
            f"net={a['net_large'] / 1e6:+.0f}M trough={a['trough'] / 1e6:.0f}M "
            f"+{a['rise_pct'] * 100:.0f}% ***")
