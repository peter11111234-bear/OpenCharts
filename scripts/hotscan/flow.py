"""大單/小單累計淨額 — per-code 1m cumulative net volume series.

五級分類（單筆金額，元）:
  xl  特大 = ≥ XL_MIN（固定 1 億）
  l   大   = ≥ L2 門檻（股價分層，當日開盤價定層）且 < XL_MIN
  m   中   = ≥ MID_MIN（500萬）且 < L2 門檻
  s   小   = ≥ SMALL_MIN（100萬）且 < MID_MIN
  xs  散戶 = < SMALL_MIN
方向 = tick_type: 1=外盤(buy), 2=內盤(sell)；淨額單位 = 張數累計。

校準（2026-09-23, 2408 @ 12:36）:
  大單淨額(xl+l) +14,741 vs 三竹截圖 +14,853（差 1%）
  散戶+小單淨額 -5,353 vs 截圖 -5,338
分桶買/賣總量與三竹不可比：三竹用委託單級資料，tick 無 order_id。
"""
import json
import sys
import time

from . import config

# 5 級金額分層（tick 級估算；三竹用委託單級，高價股拆單會高估）
# 校準：2408 大單=14,803 vs 三竹 14,853；2409 小單=+17,814 vs +18,178
XL_AMT = 50_000_000    # 超大單 ≥ 5000萬
LARGE_AMT = 5_000_000   # 大單 ≥ 500萬
MID_AMT = 2_000_000     # 中單 ≥ 200萬
SMALL_AMT = 200_000     # 小單 ≥ 20萬；< 20萬為散戶

BANDS = ("xl", "large", "mid", "small", "retail")

def _band(amt: float) -> int:
    """0=xl, 1=large, 2=mid, 3=small, 4=retail"""
    if amt >= XL_AMT:
        return 0
    if amt >= LARGE_AMT:
        return 1
    if amt >= MID_AMT:
        return 2
    if amt >= SMALL_AMT:
        return 3
    return 4

_tick_log = config.LOG_DIR / "hot-ticks.jsonl"

# per-code cache: {"lines": int, "open": float, "large_sh": int,
#                  "series": {minute: [large, small, mid]}, "price": {minute: last}}
_cache: dict[str, dict] = {}


def _tick_vol(t: dict, st: dict) -> int:
    """Real per-tick volume. Auction ticks report cumulative simulated vol —
    use total_volume delta when present, else vol delta within auction."""
    vol = t.get("vol") or 0
    tv = t.get("total_volume")
    if tv is not None:
        tv = int(tv)
        prev = st.get("prev_tv")
        st["prev_tv"] = tv
        if prev is None:
            return vol  # first tv tick: trust vol
        delta = tv - prev
        if delta > 0:
            st["prev_auc_vol"] = 0
            return delta
        # tv frozen → auction simulation; vol is cumulative
        pv = st.get("prev_auc_vol", 0)
        st["prev_auc_vol"] = vol
        return max(0, vol - pv)
    return vol


def _process_line(code: str, st: dict, line: str) -> None:
    try:
        t = json.loads(line)
    except Exception:
        return
    if t.get("code") != code:
        return
    price = t.get("price") or 0
    vol = _tick_vol(t, st)
    if vol <= 0 or price <= 0:
        return
    if "open" not in st:
        st["open"] = price
    minute = int(t["ts"]) // 60 * 60
    st["price"][minute] = price
    tt = t.get("tick_type", 0)
    signed = vol if tt == 1 else (-vol if tt == 2 else 0)
    if signed == 0:
        return
    amt = vol * price * 1000
    bi = _band(amt)
    st["series"].setdefault(minute, [0, 0, 0, 0, 0])[bi] += signed
    # per-band buy/sell totals (張數)
    bs = st["bs"].setdefault(BANDS[bi], [0, 0])
    if tt == 1:
        bs[0] += vol
    else:
        bs[1] += vol

def flow_series(code: str) -> dict:
    """Return {ts[], price[], xl/l/m/s/xs_net[], bands:{b:[buy,sell]}}."""
    st = _cache.setdefault(code, {"offset": 0, "series": {}, "price": {}, "bs": {}})
    if _tick_log.exists():
        size = _tick_log.stat().st_size
        if size > st["offset"]:
            with _tick_log.open("r", encoding="utf-8") as f:
                f.seek(st["offset"])
                data = f.read()
                st["offset"] = f.tell()
            for line in data.splitlines():
                _process_line(code, st, line)
    minutes = sorted(st["series"])
    out = {"code": code, "ts": minutes, "price": [],
           "xl_amt": XL_AMT, "large_amt": LARGE_AMT, "mid_amt": MID_AMT, "small_amt": SMALL_AMT}
    acc = [0, 0, 0, 0, 0]
    series = {b: [] for b in BANDS}
    for m in minutes:
        for i, v in enumerate(st["series"][m]):
            acc[i] += v
        for i, b in enumerate(BANDS):
            series[b].append(acc[i])
        out["price"].append(st["price"].get(m))
    out.update({f"{b}_net": series[b] for b in BANDS})
    # 三竹「大單」= 超大+大；「小單」= 散戶(<20萬)
    out["large_net"] = [a + b for a, b in zip(series["xl"], series["large"])]
    out["small_net"] = series["retail"]
    out["bands"] = {b: st["bs"].get(b, [0, 0]) for b in BANDS}
    return out


if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else "2408"
    t0 = time.time()
    r = flow_series(code)
    print(f"{code}: {len(r['ts'])} buckets in {time.time()-t0:.1f}s, large_amt={r['large_amt']}")
    if r["ts"]:
        print("final:", {k: r[f"{k}_net"][-1] for k in BANDS},
              "| large:", r["large_net"][-1], "small:", r["small_net"][-1])
