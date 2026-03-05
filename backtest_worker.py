"""
Backtest Worker: historical resolution backtest strategy.
Algorithm:
  1. Use the leader market's resolved timestamp as the signal
  2. Find related markets using LLM (reusing discover_worker's two-pass approach)
  3. Fetch price history for each related market
  4. Calculate P&L at multiple timeframes from the resolution moment (5m, 1h, 1d, 1w)
  5. Return aggregated results
Streams progress events so the frontend can show a live log.
"""

import os
import json
import time
from collections import Counter
from datetime import datetime
from typing import List, Dict, Optional, Generator, Tuple

import database as db
from discover_worker import _discover_relationships
from llm_utils import CLOB_RATE_LIMITER, GAMMA_RATE_LIMITER, fetch_json_with_retries

# Timeframes to measure P&L at (seconds after resolution)
TIMEFRAMES = {
    "5m": 5 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
}

# Tolerance for finding nearest price point (seconds)
TOLERANCES = {
    "5m": 3 * 60,
    "1h": 30 * 60,
    "1d": 2 * 60 * 60,
    "1w": 6 * 60 * 60,
}

BACKTEST_BATCH_SIZE = int(os.environ.get("BACKTEST_LLM_BATCH_SIZE", "50"))
BACKTEST_CACHE_VERSION = int(os.environ.get("BACKTEST_CACHE_VERSION", "11"))
ENTRY_FALLBACK_MAX_LAG_SECONDS = int(
    os.environ.get("BACKTEST_ENTRY_FALLBACK_MAX_LAG_SECONDS", str(6 * 60 * 60))
)
DATA_API_PAGE_SIZE = int(os.environ.get("BACKTEST_DATA_API_PAGE_SIZE", "200"))
DATA_API_MAX_PAGES = int(os.environ.get("BACKTEST_DATA_API_MAX_PAGES", "25"))
BACKTEST_FETCH_MAX = int(os.environ.get("BACKTEST_FETCH_MAX", "50000"))


def _fetch_candidate_markets_from_gamma(min_volume: int = 10000) -> List[Dict]:
    """Fetch candidate markets from Gamma API.
    Fetches all markets (active + closed) sorted by volume, regardless of status.
    """
    all_markets = []
    max_count = BACKTEST_FETCH_MAX
    offset = 0
    limit = 500

    while len(all_markets) < max_count:
        url = (
            f"https://gamma-api.polymarket.com/markets?"
            f"limit={limit}&offset={offset}"
            f"&order=volume&ascending=false"
        )
        try:
            markets = fetch_json_with_retries(
                url,
                timeout=30,
                rate_limiter=GAMMA_RATE_LIMITER,
                max_retries=5,
            )
            if not markets:
                break
            all_markets.extend(markets)
            if len(markets) < limit:
                break
            offset += limit
            time.sleep(0.1)
        except Exception as e:
            print(f"[Backtest] Error fetching from Gamma at offset {offset}: {e}")
            break

    # Deduplicate by market ID (in case of any API inconsistencies)
    seen_ids = set()
    unique_markets = []
    for m in all_markets:
        mid = m.get("id", "")
        if mid and mid not in seen_ids:
            seen_ids.add(mid)
            unique_markets.append(m)

    # Normalize to match db.get_all_markets() format
    result = []
    for m in unique_markets:
        try:
            vol = float(m.get("volume", 0) or 0)
            if vol < min_volume:
                continue

            clob_ids = json.loads(m.get("clobTokenIds", "[]"))
            if not clob_ids:
                continue

            # Parse probability from outcomePrices
            prices = json.loads(m.get("outcomePrices", "[]"))
            prob = float(prices[0]) if prices else 0.5

            result.append({
                "id": m.get("id", ""),
                "name": m.get("question", ""),
                "slug": m.get("slug", ""),
                "category": "Other",
                "volume": vol,
                "probability": prob,
                "clob_token_id": clob_ids[0] if clob_ids else "",
                "condition_id": m.get("conditionId", ""),
                "startDate": m.get("startDate", ""),
                "endDate": m.get("endDate", ""),
                "closedTime": m.get("closedTime", ""),
                "umaEndDate": m.get("umaEndDate", ""),
                "resolutionTime": (m.get("closedTime", "") or m.get("umaEndDate", "") or m.get("endDate", "")),
                "closed": m.get("closed", False),
            })
        except (ValueError, TypeError, json.JSONDecodeError):
            continue

    print(f"[Backtest] Fetched {len(result)} candidate markets from Gamma API (vol >= ${min_volume:,})")
    return result


def _fetch_price_history(clob_token_id: str, fidelity: int = 60) -> Optional[List[Dict]]:
    """Fetch price history from CLOB API."""
    url = f"https://clob.polymarket.com/prices-history?market={clob_token_id}&interval=max&fidelity={fidelity}"
    print(f"[Backtest] Fetching: {url}")
    try:
        data = fetch_json_with_retries(
            url,
            timeout=30,
            rate_limiter=CLOB_RATE_LIMITER,
            max_retries=5,
        )
        history = data.get("history", [])
        if history:
            print(f"[Backtest] Got {len(history)} price points")
            return history
        print(f"[Backtest] Empty history. Full response keys: {list(data.keys())}")
        return None
    except Exception as e:
        print(f"[Backtest] Price fetch error: {e}")
        return None


def _fetch_trade_history_from_data_api(
    condition_id: str,
    asset_token_id: str,
    fidelity: int = 60,
) -> Optional[List[Dict]]:
    """Fallback: reconstruct a price series from Data API trades for closed contracts."""
    if not condition_id or not asset_token_id:
        return None

    rows = []
    limit = max(10, DATA_API_PAGE_SIZE)
    max_pages = max(1, DATA_API_MAX_PAGES)

    for page in range(max_pages):
        offset = page * limit
        url = f"https://data-api.polymarket.com/trades?market={condition_id}&limit={limit}&offset={offset}"
        try:
            data = fetch_json_with_retries(url, timeout=30, max_retries=4)
            if not isinstance(data, list) or not data:
                break
            rows.extend(data)
            if len(data) < limit:
                break
        except Exception as e:
            print(f"[Backtest] Data API trade fetch error (condition={condition_id[:12]}..., offset={offset}): {e}")
            break

    if not rows:
        return None

    # Keep only trades for the requested outcome token.
    token = str(asset_token_id)
    filtered = [r for r in rows if str(r.get("asset", "")) == token]
    if not filtered:
        return None

    # Convert trade tape to coarse bars (last price per bucket).
    bucket = max(1, int(fidelity))
    bars = {}
    for trade in filtered:
        try:
            ts = int(trade.get("timestamp"))
            px = float(trade.get("price"))
            bts = ts - (ts % bucket)
            prev = bars.get(bts)
            if prev is None or ts >= prev[0]:
                bars[bts] = (ts, px)
        except (TypeError, ValueError):
            continue

    if not bars:
        return None

    history = [{"t": t, "p": bars[t][1]} for t in sorted(bars.keys())]
    print(
        f"[Backtest] Data API fallback produced {len(history)} points "
        f"(condition={condition_id[:12]}..., token={token[:12]}...)"
    )
    return history


def _fetch_price_history_with_fallback(
    clob_token_id: str,
    condition_id: str,
    fidelity: int = 60,
) -> Tuple[Optional[List[Dict]], str]:
    """Fetch history from CLOB; fallback to Data API trades for older closed markets."""
    primary = _fetch_price_history(clob_token_id, fidelity=fidelity)
    if primary:
        return primary, "clob"

    fallback = _fetch_trade_history_from_data_api(condition_id, clob_token_id, fidelity=fidelity)
    if fallback:
        return fallback, "data_api"

    return None, "none"


def _find_nearest_price(history: List[Dict], target_time: int, tolerance_seconds: int) -> Optional[float]:
    """Find the price closest to target_time within tolerance."""
    best = None
    best_diff = float("inf")
    for point in history:
        diff = abs(point["t"] - target_time)
        if diff < best_diff:
            best_diff = diff
            best = point
    if best and best_diff <= tolerance_seconds:
        return best["p"]
    return None


def _find_entry_price(
    history: List[Dict],
    target_time: int,
    tolerance_seconds: int,
    fallback_max_lag_seconds: int,
) -> Dict[str, object]:
    """Find entry near target with optional bounded post-resolution fallback."""
    direct = _find_nearest_price(history, target_time, tolerance_seconds)
    if direct is not None:
        return {"price": direct, "method": "nearest", "lag_seconds": 0}

    if fallback_max_lag_seconds <= 0 or not history:
        return {"price": None, "method": "none", "lag_seconds": None}

    first_after = None
    for point in history:
        if point["t"] >= target_time:
            first_after = point
            break

    if first_after is None:
        return {"price": None, "method": "none", "lag_seconds": None}

    lag_seconds = int(first_after["t"] - target_time)
    if lag_seconds <= fallback_max_lag_seconds:
        return {"price": first_after["p"], "method": "first_after", "lag_seconds": lag_seconds}

    return {"price": None, "method": "none", "lag_seconds": lag_seconds}


def _format_timestamp(ts: int) -> str:
    """Format a unix timestamp to human-readable string."""
    return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M UTC")


def _parse_resolution_time(value: str) -> Optional[int]:
    """Parse an ISO date string to unix timestamp."""
    if not value:
        return None
    try:
        # Handle ISO format with timezone
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except Exception:
        pass
    try:
        dt = datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
        return int(dt.timestamp())
    except Exception:
        pass
    try:
        dt = datetime.strptime(value[:10], "%Y-%m-%d")
        return int(dt.timestamp())
    except Exception:
        return None


def _build_backtest_cache_key(market_id: str, resolution_time_str: str, min_volume: int) -> str:
    """Build a deterministic cache key for a historical backtest configuration."""
    normalized_resolution = (resolution_time_str or "").strip()
    return f"v{BACKTEST_CACHE_VERSION}:{market_id}:{normalized_resolution}:{int(min_volume)}"


def run_backtest_stream(
    market_id: str,
    market_question: str,
    clob_token_id: str,
    resolution_time_str: str,
    openai_api_key: str,
    min_volume: int = 10000,
) -> Generator[Dict, None, None]:
    """
    Run historical backtest. Yields progress events as a stream.

    Event types:
      {"type": "step",   "message": "..."}
      {"type": "result", "message": "...", "data": {...}}
      {"type": "error",  "message": "..."}
      {"type": "done",   "data": {...}}
    """

    # ── Step 1: Determine resolution time ────────────────────────
    yield {"type": "step", "message": "Determining resolution time from market close timestamp"}

    resolution_time = _parse_resolution_time(resolution_time_str)
    if resolution_time is None:
        yield {
            "type": "error",
            "message": (
                f"Could not parse resolution timestamp: '{resolution_time_str}'. "
                "Cannot determine resolution time."
            ),
        }
        return

    yield {
        "type": "result",
        "message": f"Resolution time: {_format_timestamp(resolution_time)}",
        "data": {"resolution_time": resolution_time},
    }

    # ── Step 2: Find related markets using LLM ──────────────────
    cache_key = _build_backtest_cache_key(market_id, resolution_time_str, min_volume)
    cached_result = db.get_backtest_result(cache_key)
    if cached_result and isinstance(cached_result, dict):
        if all(k in cached_result for k in ("leader", "timeframes", "trades", "summary")):
            yield {"type": "step", "message": "Loading cached backtest from database"}
            yield {"type": "result", "message": "Cache hit: returning stored result without refetching"}
            yield {"type": "done", "data": cached_result}
            return

    yield {"type": "step", "message": "Loading candidate markets"}

    db_markets = db.get_all_markets()
    db_categories = {m.get("id", ""): m.get("category", "Other") for m in db_markets if m.get("id")}

    # Prefer Gamma because historical backtests need temporal fields (start/end/closed).
    gamma_markets = _fetch_candidate_markets_from_gamma(min_volume)
    if gamma_markets:
        for market in gamma_markets:
            cached_category = db_categories.get(market.get("id", ""), "Other")
            if cached_category and cached_category != "Other":
                market["category"] = cached_category
        all_markets = gamma_markets
        yield {
            "type": "result",
            "message": f"Loaded {len(all_markets)} candidates from Gamma (active + closed)",
        }
    else:
        all_markets = db_markets
        yield {
            "type": "result",
            "message": f"Gamma fetch unavailable, falling back to {len(all_markets)} local DB markets",
        }

    # Filter: different market, minimum volume
    # For active markets: also filter by probability 5-95% (avoid near-resolved)
    # For closed markets: skip probability filter (resolved = 0% or 100%)
    # For all: check time overlap with resolution time
    candidates = []
    skipped_started_after = 0
    skipped_ended_before = 0
    for m in all_markets:
        if m.get("id", "") == market_id:
            continue
        if m.get("volume", 0) < min_volume:
            continue
        # Active markets: filter by probability
        if not m.get("closed", False):
            prob = m.get("probability", 0.5)
            if not (0.05 <= prob <= 0.95):
                continue
        # Time overlap: candidate must have existed at resolution time.
        start_str = m.get("startDate", "") or m.get("start_date", "")
        start_ts = _parse_resolution_time(start_str) if start_str else None
        if start_ts is not None and start_ts > resolution_time:
            skipped_started_after += 1
            continue

        # Exclude markets that already ended before the leader resolved.
        end_str = (
            m.get("resolutionTime", "")
            or m.get("closedTime", "")
            or m.get("umaEndDate", "")
            or m.get("endDate", "")
            or m.get("end_date", "")
        )
        end_ts = _parse_resolution_time(end_str) if end_str else None
        if end_ts is not None and end_ts < resolution_time:
            skipped_ended_before += 1
            continue
        candidates.append(m)

    time_parts = []
    if skipped_started_after:
        time_parts.append(f"{skipped_started_after} skipped (started after resolution)")
    if skipped_ended_before:
        time_parts.append(f"{skipped_ended_before} skipped (ended before resolution)")
    time_msg = f", {'; '.join(time_parts)}" if time_parts else ""
    yield {
        "type": "result",
        "message": f"Loaded {len(candidates)} candidate markets (vol >= ${min_volume:,}{time_msg})",
        "data": {"count": len(candidates)},
    }

    if not candidates:
        yield {"type": "error", "message": "No candidate markets overlap the selected resolution time"}
        return

    # Skip category filter for backtests (historical markets lack category data)
    yield {"type": "result", "message": f"Skipping category filter (historical markets lack categories)"}
    filtered_candidates = candidates

    retry_events = []

    def on_retry(attempt, max_retries, wait):
        retry_events.append(
            {"type": "step", "message": f"Rate limit hit, retrying ({attempt}/{max_retries}) in {wait}s..."}
        )

    # Pass 2: Relationship discovery (batched)
    BATCH_SIZE = max(10, BACKTEST_BATCH_SIZE)
    candidate_map = {m["name"]: m for m in filtered_candidates}
    all_candidate_questions = [m["name"] for m in filtered_candidates]

    batches = [all_candidate_questions[i : i + BATCH_SIZE] for i in range(0, len(all_candidate_questions), BATCH_SIZE)]
    total_batches = len(batches)

    yield {
        "type": "step",
        "message": f"Pass 2: Discovering relationships across {total_batches} batch{'es' if total_batches > 1 else ''} ({len(all_candidate_questions)} candidates)",
    }

    raw_followers = []
    for batch_idx, batch in enumerate(batches):
        batch_num = batch_idx + 1
        yield {"type": "step", "message": f"Batch {batch_num}/{total_batches}: Analyzing {len(batch)} candidates"}

        retry_events.clear()
        try:
            batch_results = _discover_relationships(market_question, batch, openai_api_key, on_retry=on_retry)
            for evt in retry_events:
                yield evt
            retry_events.clear()
            raw_followers.extend(batch_results)
            yield {"type": "result", "message": f"Batch {batch_num}/{total_batches}: found {len(batch_results)} related markets"}
        except Exception as e:
            for evt in retry_events:
                yield evt
            retry_events.clear()
            yield {"type": "result", "message": f"Batch {batch_num}/{total_batches}: skipped ({str(e)[:80]})"}

        if batch_idx < total_batches - 1:
            time.sleep(0.15)

    if not raw_followers:
        yield {"type": "error", "message": "No related markets found. Try a different market."}
        return

    # Match results to market database
    yield {"type": "step", "message": f"Matching {len(raw_followers)} results to market database"}

    followers = []
    skipped = 0
    seen_ids = set()
    for rel in raw_followers:
        question = rel.get("question", "")
        market = candidate_map.get(question)

        if market is None:
            skipped += 1
            continue
        if market["id"] in seen_ids:
            continue
        seen_ids.add(market["id"])

        confidence = max(0.0, min(1.0, float(rel.get("confidence_score", 0.5))))

        followers.append(
            {
                "id": market["id"],
                "name": market["name"],
                "category": market.get("category", "Other"),
                "volume": market["volume"],
                "clob_token_id": market.get("clob_token_id", ""),
                "condition_id": market.get("condition_id", ""),
                "confidence_score": confidence,
                "is_same_outcome": bool(rel.get("is_same_outcome", True)),
                "relationship_type": rel.get("relationship_type", "direct"),
                "rationale": rel.get("rationale", ""),
            }
        )

    followers.sort(key=lambda x: x["confidence_score"], reverse=True)

    msg = f"Matched {len(followers)} related markets"
    if skipped > 0:
        msg += f" ({skipped} skipped — couldn't match to database)"
    yield {"type": "result", "message": msg}

    if not followers:
        yield {"type": "error", "message": "No related markets could be matched. Try a different market."}
        return

    # ── Step 3: Fetch price history and calculate multi-timeframe P&L ──
    yield {"type": "step", "message": f"Fetching price data for {len(followers)} related markets"}

    trades = []

    for i, follower in enumerate(followers):
        f_clob = follower.get("clob_token_id", "")
        f_condition = follower.get("condition_id", "")
        if not f_clob:
            trades.append({**follower, "status": "no_clob_id", "entry_price": None, "pnl": {}})
            continue

        f_history, price_source = _fetch_price_history_with_fallback(
            f_clob,
            f_condition,
            fidelity=60,
        )
        if not f_history:
            trades.append({**follower, "status": "no_data", "entry_price": None, "pnl": {}})
            continue

        f_history.sort(key=lambda x: x["t"])

        # Find entry at resolution time; fallback to first post-resolution print within a bounded lag.
        entry_result = _find_entry_price(
            f_history,
            resolution_time,
            TOLERANCES["1h"],
            ENTRY_FALLBACK_MAX_LAG_SECONDS,
        )
        entry_price = entry_result["price"]
        if entry_price is None:
            data_start = _format_timestamp(f_history[0]["t"]) if f_history else "?"
            data_end = _format_timestamp(f_history[-1]["t"]) if f_history else "?"
            print(f"[Backtest] SKIP {follower.get('name','')[:50]}: no price near resolution ({_format_timestamp(resolution_time)}). Data range: {data_start} to {data_end}")
            trades.append({**follower, "status": "no_entry_price", "entry_price": None, "pnl": {}})
            continue

        # Calculate P&L at each timeframe
        pnl = {}
        for tf_name, tf_seconds in TIMEFRAMES.items():
            exit_time = resolution_time + tf_seconds
            tolerance = TOLERANCES[tf_name]

            exit_price = _find_nearest_price(f_history, exit_time, tolerance)
            if exit_price is None:
                # Try using last available price if market ended before exit time
                last_point = f_history[-1]
                if last_point["t"] < exit_time:
                    exit_price = last_point["p"]
                else:
                    pnl[tf_name] = None
                    continue

            # Calculate P&L based on direction
            if follower["is_same_outcome"]:
                # Buy YES: profit if price goes up
                if entry_price > 0.001:
                    pnl_pct = (exit_price - entry_price) / entry_price * 100
                else:
                    pnl_pct = 0.0
            else:
                # Buy NO (short YES): profit if YES price goes down
                entry_no = 1 - entry_price
                exit_no = 1 - exit_price
                if entry_no > 0.001:
                    pnl_pct = (exit_no - entry_no) / entry_no * 100
                else:
                    pnl_pct = 0.0

            # Stop-loss: cap losses at -10%
            if pnl_pct < -10.0:
                pnl_pct = -10.0

            pnl[tf_name] = round(pnl_pct, 2)

        direction = "BUY" if follower["is_same_outcome"] else "SHORT"

        trades.append(
            {
                **follower,
                "status": "ok",
                "direction": direction,
                "price_source": price_source,
                "entry_price": round(entry_price, 4),
                "entry_method": entry_result["method"],
                "entry_lag_seconds": entry_result["lag_seconds"],
                "pnl": pnl,
            }
        )

        # Brief delay to be nice to the API
        if i < len(followers) - 1:
            time.sleep(0.15)

    valid_trades = [t for t in trades if t["status"] == "ok"]
    skipped_trades = [t for t in trades if t["status"] != "ok"]

    yield {
        "type": "result",
        "message": f"Fetched price data: {len(valid_trades)} trades OK, {len(skipped_trades)} skipped",
    }

    # ── Step 4: Calculate summary ───────────────────────────────
    status_breakdown = dict(Counter(t.get("status", "unknown") for t in trades))
    summary = {
        "total_trades": len(valid_trades),
        "skipped_trades": len(skipped_trades),
        "status_breakdown": status_breakdown,
    }

    if valid_trades:
        for tf_name in TIMEFRAMES:
            tf_pnls = [t["pnl"].get(tf_name) for t in valid_trades if t["pnl"].get(tf_name) is not None]
            if tf_pnls:
                summary[f"avg_pnl_{tf_name}"] = round(sum(tf_pnls) / len(tf_pnls), 2)
                summary[f"wins_{tf_name}"] = sum(1 for p in tf_pnls if p > 0)
                summary[f"losses_{tf_name}"] = sum(1 for p in tf_pnls if p <= 0)
            else:
                summary[f"avg_pnl_{tf_name}"] = None
                summary[f"wins_{tf_name}"] = 0
                summary[f"losses_{tf_name}"] = 0

    # ── Done ────────────────────────────────────────────────────
    final_data = {
        "leader": {
            "id": market_id,
            "question": market_question,
            "resolution_time": resolution_time,
            "resolution_time_formatted": _format_timestamp(resolution_time),
            "resolution_time_input": resolution_time_str,
        },
        "timeframes": list(TIMEFRAMES.keys()),
        "trades": trades,
        "summary": summary,
    }

    try:
        db.upsert_backtest_result(
            cache_key=cache_key,
            market_id=market_id,
            market_question=market_question,
            clob_token_id=clob_token_id,
            end_date=resolution_time_str,
            min_volume=min_volume,
            cache_version=BACKTEST_CACHE_VERSION,
            result=final_data,
        )
        yield {"type": "result", "message": "Saved backtest result to local database cache"}
    except Exception as e:
        print(f"[Backtest] Cache save error: {e}")

    yield {"type": "done", "data": final_data}
