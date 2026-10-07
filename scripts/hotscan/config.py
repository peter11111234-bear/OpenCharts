"""Hot-scanner configuration — all tunables in one place."""

from pathlib import Path

# ── Paths ──
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # OpenCharts/
LOG_DIR = BASE_DIR / "logs"
SCANNER_LOG = LOG_DIR / "hot-scanner.jsonl"
DIST_LOG_PREFIX = "tick-amount-dist"  # tick-amount-dist-YYYYMMDD.jsonl

# ── Shioaji server ──
SHIOAJI_BASE = "http://127.0.0.1:8080"
SSE_TICK_PATH = "/api/v1/stream/data/tick_stk"
SSE_TICK_EVENT = "tick_stk"
SUBSCRIBE_PATH = "/api/v1/stream/subscribe"
SNAPSHOTS_PATH = "/api/v1/data/snapshots"
KBARS_PATH = "/api/v1/data/kbars"

# ── Watchlist ──
WATCHLIST_PREFIX = "hot-watchlist"  # hot-watchlist-YYYYMMDD.json
PRIMARY_COUNT = 100
ALTERNATE_COUNT = 0

# ── Price-tier thresholds (元) ──
# (L1_single, L1_lite, L2_cluster_tick, L3_min_reversal)
TIER_HIGH = {"l1": 100_000_000, "l1_lite": 0, "l2": 30_000_000, "l3_min": 90_000_000}
TIER_MID = {"l1": 50_000_000, "l1_lite": 0, "l2": 15_000_000, "l3_min": 45_000_000}
TIER_LOW = {"l1": 30_000_000, "l1_lite": 8_000_000, "l2": 10_000_000, "l3_min": 30_000_000}

PRICE_HIGH = 1000.0   # >= this → TIER_HIGH
PRICE_MID = 100.0     # >= this → TIER_MID; below → TIER_LOW


def tier_for(price: float) -> dict:
    if price >= PRICE_HIGH:
        return TIER_HIGH
    if price >= PRICE_MID:
        return TIER_MID
    return TIER_LOW


# ── Detection windows ──
L2_CLUSTER_WINDOW = 300       # 5 minutes
L2_CLUSTER_COUNT = 3          # >=3 same-direction ticks
L3_REVERSAL_PCT = 0.30        # 30% reversal from peak/trough
NET_WINDOW = 3600             # net_large rolling window (seconds)

# ── L3 v2: windowed reversal detection ──
L3_PEAK_WINDOW = 1800         # rolling 30min peak/trough (not session-cumulative)
L3_COOLDOWN = 300             # min seconds between alerts per stock
L3_OPPOSITE_WINDOW = 60       # need >=1 opposite-direction L2 tick in last N sec

# ── Stats windows ──
STAT_WINDOWS = (300, 900, 1800, 3600)  # 5m, 15m, 30m, 60m
FWD_WINDOWS = (300, 900, 1800, 3600)

# ── Histogram buckets for calibration (元) ──
AMOUNT_BUCKETS = [1e6, 10e6, 30e6, 50e6, 100e6, 500e6]
BUCKET_LABELS = ["<1M", "1-10M", "10-30M", "30-50M", "50-100M", "100-500M", ">500M"]

# ── SSE reconnect ──
SSE_BACKOFF_INIT = 1
SSE_BACKOFF_MAX = 30

# ── Timezone ──
TZ_OFFSET = 8  # UTC+8 Taipei
