"""Quick test: fetch price history for a known market and check if 5m P&L resolves."""
import json, time
from backtest_worker import _fetch_price_history, _find_nearest_price, TIMEFRAMES, TOLERANCES

# Use an active market from the DB
import database as db
markets = db.get_all_markets()
test_market = [m for m in markets if m.get('clob_token_id')][0]

CLOB_ID = test_market['clob_token_id']
print(f"Market: {test_market['name']}")
print(f"CLOB ID: {CLOB_ID[:40]}...")

print("\nFetching price history (fidelity=60)...")
history = _fetch_price_history(CLOB_ID, fidelity=60)

if not history:
    print("No history returned.")
    exit(1)

history.sort(key=lambda x: x["t"])
print(f"Got {len(history)} price points")
print(f"Data range: {history[0]['t']} to {history[-1]['t']}")

# Use a point in the middle as fake "resolution time"
mid_idx = len(history) // 2
resolution_time = history[mid_idx]["t"]
print(f"\nUsing mid-point as resolution time: {resolution_time}")
print(f"Entry price at resolution: {history[mid_idx]['p']}")

# Check each timeframe
entry = _find_nearest_price(history, resolution_time, TOLERANCES["1h"])
print(f"Entry (via _find_nearest_price): {entry}")
print()

for tf_name, tf_seconds in TIMEFRAMES.items():
    exit_time = resolution_time + tf_seconds
    tolerance = TOLERANCES[tf_name]
    exit_price = _find_nearest_price(history, exit_time, tolerance)
    
    if exit_price is None and history[-1]["t"] < exit_time:
        exit_price = history[-1]["p"]
        tag = "(FALLBACK to last point)"
    elif exit_price is not None:
        tag = "OK"
    else:
        nearest = min(history, key=lambda p: abs(p["t"] - exit_time))
        gap = abs(nearest["t"] - exit_time)
        tag = f"N/A — nearest is {gap}s ({gap/60:.0f}min) away, tolerance={tolerance}s ({tolerance/60:.0f}min)"
    
    print(f"  {tf_name}: exit_price={exit_price if exit_price else 'None'} | {tag}")
