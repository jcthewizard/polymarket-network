"""
Backtest Worker: "Resolution Shock" strategy.
Algorithm:
  1. Use the leader market's endDate (resolution time) as the signal
  2. Find related markets using LLM (reusing discover_worker's two-pass approach)
  3. Fetch price history for each related market
  4. Calculate P&L at multiple timeframes from the resolution moment (5m, 1h, 1d, 1w)
  5. Return aggregated results
Streams progress events so the frontend can show a live log.
"""

import json
import time
import urllib.request
import urllib.error
from datetime import datetime
from typing import List, Dict, Optional, Generator

import database as db
from discover_worker import (
    _prefilter_categories,
    _discover_relationships,
    _fuzzy_match,
    _get_active_categories,
)

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
    "1h": 15 * 60,
    "1d": 2 * 60 * 60,
    "1w": 6 * 60 * 60,
}


def _fetch_candidate_markets_from_gamma(min_volume: int = 10000) -> List[Dict]:
    """Fetch candidate markets from Gamma API (fallback when local DB is empty).
    Fetches BOTH active and recently closed markets so that older leader markets
    can find followers that existed at the time of resolution.
    """
    all_markets = []

    # Fetch from two sources: active markets AND high-volume closed markets
    queries = [
        ("active=true&closed=false", 1000),   # Currently active
        ("closed=true", 2000),                 # Recently closed (sorted by volume)
    ]

    for query_filter, max_count in queries:
        offset = 0
        limit = 500
        fetched = 0
        while fetched < max_count:
            url = (
                f"https://gamma-api.polymarket.com/markets?{query_filter}"
                f"&limit={limit}&offset={offset}"
                f"&order=volume&ascending=false"
            )
            try:
                req = urllib.request.Request(
                    url,
                    headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    markets = json.loads(response.read().decode("utf-8"))
                    if not markets:
                        break
                    all_markets.extend(markets)
                    fetched += len(markets)
                    if len(markets) < limit:
                        break
                    offset += limit
                    if offset >= max_count:
                        break
                    time.sleep(0.2)
            except Exception as e:
                print(f"[Backtest] Error fetching from Gamma at offset {offset}: {e}")
                break

    # Deduplicate by market ID
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
                "startDate": m.get("startDate", ""),
                "endDate": m.get("endDate", ""),
                "closed": m.get("closed", False),
            })
        except (ValueError, TypeError, json.JSONDecodeError):
            continue

    print(f"[Backtest] Fetched {len(result)} candidate markets from Gamma API (active + closed, vol >= ${min_volume:,})")
    return result


def _fetch_price_history(clob_token_id: str, fidelity: int = 60) -> Optional[List[Dict]]:
    """Fetch price history from CLOB API."""
    url = f"https://clob.polymarket.com/prices-history?market={clob_token_id}&interval=max&fidelity={fidelity}"
    print(f"[Backtest] Fetching: {url}")
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            print(f"[Backtest] Response ({len(raw)} bytes): {raw[:200]}")
            data = json.loads(raw)
            history = data.get("history", [])
            if history:
                print(f"[Backtest] Got {len(history)} price points")
                return history
            else:
                print(f"[Backtest] Empty history. Full response keys: {list(data.keys())}")
                return None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        print(f"[Backtest] HTTP {e.code}: {body}")
        return None
    except Exception as e:
        print(f"[Backtest] Error: {type(e).__name__}: {e}")
        return None


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


def _format_timestamp(ts: int) -> str:
    """Format a unix timestamp to human-readable string."""
    return datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M UTC")


def _parse_end_date(end_date: str) -> Optional[int]:
    """Parse an ISO date string to unix timestamp."""
    if not end_date:
        return None
    try:
        # Handle ISO format with timezone
        dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except Exception:
        pass
    try:
        # Handle simple date string
        dt = datetime.strptime(end_date[:19], "%Y-%m-%dT%H:%M:%S")
        return int(dt.timestamp())
    except Exception:
        pass
    try:
        dt = datetime.strptime(end_date[:10], "%Y-%m-%d")
        return int(dt.timestamp())
    except Exception:
        return None


def run_backtest_stream(
    market_id: str,
    market_question: str,
    clob_token_id: str,
    end_date: str,
    openai_api_key: str,
    min_volume: int = 10000,
) -> Generator[Dict, None, None]:
    """
    Run Resolution Shock backtest. Yields progress events as a stream.

    Event types:
      {"type": "step",   "message": "..."}
      {"type": "result", "message": "...", "data": {...}}
      {"type": "error",  "message": "..."}
      {"type": "done",   "data": {...}}
    """

    # ── Step 1: Determine resolution time ────────────────────────
    yield {"type": "step", "message": "Determining resolution time from endDate"}

    resolution_time = _parse_end_date(end_date)
    if resolution_time is None:
        yield {"type": "error", "message": f"Could not parse endDate: '{end_date}'. Cannot determine resolution time."}
        return

    yield {
        "type": "result",
        "message": f"Resolution time: {_format_timestamp(resolution_time)}",
        "data": {"resolution_time": resolution_time},
    }

    # ── Step 2: Find related markets using LLM ──────────────────
    yield {"type": "step", "message": "Loading candidate markets"}

    all_markets = db.get_all_markets()

    # If local DB is empty, fetch active markets from Gamma API directly
    if not all_markets:
        yield {"type": "step", "message": "Local database empty — fetching active markets from Gamma API"}
        all_markets = _fetch_candidate_markets_from_gamma(min_volume)
        yield {
            "type": "result",
            "message": f"Fetched {len(all_markets)} active markets from Gamma API",
        }

    # Filter: different market, minimum volume
    # For active markets: also filter by probability 5-95% (avoid near-resolved)
    # For closed markets: skip probability filter (resolved = 0% or 100%)
    # For all: check time overlap with resolution time
    candidates = []
    skipped_time = 0
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
        # Time overlap: candidate must have existed at resolution time
        start_str = m.get("startDate", "")
        if start_str and resolution_time:
            try:
                start_ts = int(datetime.fromisoformat(start_str.replace("Z", "+00:00")).timestamp())
                if start_ts > resolution_time:
                    skipped_time += 1
                    continue
            except (ValueError, TypeError):
                pass
        candidates.append(m)

    time_msg = f", {skipped_time} skipped (started after resolution)" if skipped_time else ""
    yield {
        "type": "result",
        "message": f"Loaded {len(candidates)} candidate markets (vol >= ${min_volume:,}{time_msg})",
        "data": {"count": len(candidates)},
    }

    if not candidates:
        yield {"type": "error", "message": "No candidate markets found in database"}
        return

    # Pass 1: Category reasoning
    available_categories = _get_active_categories(candidates)
    yield {"type": "step", "message": "Pass 1: Identifying relevant categories"}

    retry_events = []

    def on_retry(attempt, max_retries, wait):
        retry_events.append(
            {"type": "step", "message": f"Rate limit hit, retrying ({attempt}/{max_retries}) in {wait}s..."}
        )

    try:
        prefilter_result = _prefilter_categories(market_question, available_categories, openai_api_key, on_retry=on_retry)
        for evt in retry_events:
            yield evt
        retry_events.clear()
        relevant_categories = prefilter_result["categories"]
    except Exception as e:
        for evt in retry_events:
            yield evt
        yield {"type": "error", "message": f"Pass 1 failed: {str(e)}"}
        return

    yield {
        "type": "result",
        "message": f"Relevant categories: {', '.join(relevant_categories)}",
        "data": {"categories": relevant_categories},
    }

    # Category filter
    yield {"type": "step", "message": "Filtering candidates by relevant categories"}
    relevant_set = set(relevant_categories)
    filtered_candidates = [m for m in candidates if m.get("category", "Other") in relevant_set]

    if not filtered_candidates:
        yield {"type": "result", "message": "No candidates matched — falling back to all candidates"}
        filtered_candidates = candidates
    else:
        yield {
            "type": "result",
            "message": f"{len(candidates)} -> {len(filtered_candidates)} candidates after category filter",
        }

    # Pass 2: Relationship discovery (batched)
    BATCH_SIZE = 150
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

    if not raw_followers:
        yield {"type": "error", "message": "No related markets found. Try a different market."}
        return

    # Fuzzy matching
    yield {"type": "step", "message": f"Matching {len(raw_followers)} results to market database"}

    followers = []
    skipped = 0
    seen_ids = set()
    for rel in raw_followers:
        question = rel.get("question", "")
        matched_name = _fuzzy_match(question, list(candidate_map.keys()))

        if matched_name is None:
            skipped += 1
            continue

        market = candidate_map[matched_name]
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
        if not f_clob:
            trades.append({**follower, "status": "no_clob_id", "entry_price": None, "pnl": {}})
            continue

        f_history = _fetch_price_history(f_clob, fidelity=60)
        if not f_history:
            trades.append({**follower, "status": "no_data", "entry_price": None, "pnl": {}})
            continue

        f_history.sort(key=lambda x: x["t"])

        # Find entry price (at resolution time)
        entry_price = _find_nearest_price(f_history, resolution_time, TOLERANCES["1h"])
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

            pnl[tf_name] = round(pnl_pct, 2)

        direction = "BUY" if follower["is_same_outcome"] else "SHORT"

        trades.append(
            {
                **follower,
                "status": "ok",
                "direction": direction,
                "entry_price": round(entry_price, 4),
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
    summary = {"total_trades": len(valid_trades), "skipped_trades": len(skipped_trades)}

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
    yield {
        "type": "done",
        "data": {
            "leader": {
                "id": market_id,
                "question": market_question,
                "resolution_time": resolution_time,
                "resolution_time_formatted": _format_timestamp(resolution_time),
                "end_date": end_date,
            },
            "timeframes": list(TIMEFRAMES.keys()),
            "trades": trades,
            "summary": summary,
        },
    }
