"""
Backtest Worker: Simulates a correlation-based trading strategy on a resolved market.
Algorithm:
  1. Fetch leader market price history
  2. Detect when leader crossed a probability threshold (e.g. 95%)
  3. Find related markets using LLM (reusing discover_worker's two-pass approach)
  4. Fetch price history for each related market
  5. Calculate P&L for each trade (buy correlated, short inversely correlated)
  6. Return aggregated results
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

# Holding period durations in seconds
HOLDING_PERIODS = {
    "15m": 15 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
    "resolution": None,  # Special: hold until leader resolves
}

# Tolerance for finding nearest price point (seconds)
TOLERANCES = {
    "15m": 5 * 60,
    "1h": 15 * 60,
    "1d": 2 * 60 * 60,
    "resolution": 2 * 60 * 60,
}


def _fetch_price_history(clob_token_id: str, fidelity: int = 60) -> Optional[List[Dict]]:
    """Fetch price history from CLOB API."""
    url = f"https://clob.polymarket.com/prices-history?market={clob_token_id}&interval=1d&fidelity={fidelity}"
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


def run_backtest_stream(
    market_id: str,
    market_question: str,
    clob_token_id: str,
    holding_period: str,
    threshold: float,
    openai_api_key: str,
    min_volume: int = 10000,
) -> Generator[Dict, None, None]:
    """
    Run backtest analysis. Yields progress events as a stream.

    Event types:
      {"type": "step",   "message": "..."}
      {"type": "result", "message": "...", "data": {...}}
      {"type": "error",  "message": "..."}
      {"type": "done",   "data": {...}}
    """

    # ── Step 1: Fetch leader price history ──────────────────────
    yield {"type": "step", "message": f"Fetching leader market price history (token: {clob_token_id[:16]}...)"}

    # Try hourly fidelity first (most reliable), then minute-level for short holds
    leader_history = _fetch_price_history(clob_token_id, fidelity=60)

    if not leader_history:
        yield {"type": "error", "message": "Could not fetch price history for this market. This can happen if the market is too old (pre-2023) or the CLOB API no longer has its data. Try a more recently resolved market."}
        return

    # For short holding periods, try to get finer granularity
    if holding_period in ("15m", "1h"):
        fine_history = _fetch_price_history(clob_token_id, fidelity=1)
        if fine_history:
            leader_history = fine_history
            yield {"type": "result", "message": f"Loaded {len(leader_history)} price points (minute granularity)"}
        else:
            yield {"type": "result", "message": f"Loaded {len(leader_history)} price points (hourly granularity — minute-level unavailable, short holds may be approximate)"}
    else:
        yield {"type": "result", "message": f"Loaded {len(leader_history)} price points (hourly granularity)"}

    # Sort history chronologically
    leader_history.sort(key=lambda x: x["t"])

    # ── Step 2: Detect threshold crossing ───────────────────────
    yield {"type": "step", "message": f"Scanning for {int(threshold * 100)}% threshold crossing"}

    signal_time = None
    for point in leader_history:
        if point["p"] >= threshold:
            signal_time = point["t"]
            break

    if signal_time is None:
        max_price = max(p["p"] for p in leader_history) if leader_history else 0
        yield {
            "type": "error",
            "message": f"Leader never crossed {int(threshold * 100)}% threshold (max was {max_price * 100:.1f}%). Try a lower threshold.",
        }
        return

    yield {
        "type": "result",
        "message": f"Threshold crossed at {_format_timestamp(signal_time)}",
        "data": {"signal_time": signal_time},
    }

    # Calculate exit time
    if holding_period == "resolution":
        exit_time = leader_history[-1]["t"]
        yield {
            "type": "result",
            "message": f"Holding until resolution: {_format_timestamp(exit_time)}",
        }
    else:
        duration = HOLDING_PERIODS[holding_period]
        exit_time = signal_time + duration
        yield {
            "type": "result",
            "message": f"Exit time: {_format_timestamp(exit_time)} (holding {holding_period})",
        }

    # ── Step 3: Find related markets using LLM ──────────────────
    yield {"type": "step", "message": "Loading candidate markets from database"}

    all_markets = db.get_all_markets()
    candidates = [m for m in all_markets if m["id"] != market_id and m["volume"] >= min_volume]

    yield {
        "type": "result",
        "message": f"Loaded {len(candidates)} candidate markets (vol >= ${min_volume:,})",
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
            "message": f"{len(candidates)} → {len(filtered_candidates)} candidates after category filter",
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

    # ── Step 4: Fetch price history and calculate P&L ───────────
    yield {"type": "step", "message": f"Fetching price data for {len(followers)} related markets"}

    tolerance = TOLERANCES.get(holding_period, 2 * 60 * 60)
    trades = []

    for i, follower in enumerate(followers):
        f_clob = follower.get("clob_token_id", "")
        if not f_clob:
            trades.append({**follower, "status": "no_clob_id", "entry_price": None, "exit_price": None, "pnl_pct": None})
            continue

        f_history = _fetch_price_history(f_clob, fidelity=60)
        if not f_history:
            trades.append({**follower, "status": "no_data", "entry_price": None, "exit_price": None, "pnl_pct": None})
            continue

        f_history.sort(key=lambda x: x["t"])

        # Find entry price (at signal_time)
        entry_price = _find_nearest_price(f_history, signal_time, tolerance)
        if entry_price is None:
            trades.append({**follower, "status": "no_entry_price", "entry_price": None, "exit_price": None, "pnl_pct": None})
            continue

        # Find exit price
        exit_price = _find_nearest_price(f_history, exit_time, tolerance)
        if exit_price is None:
            # Market may have resolved early — use last available price
            last_point = f_history[-1]
            if last_point["t"] < exit_time:
                exit_price = last_point["p"]
            else:
                trades.append(
                    {**follower, "status": "no_exit_price", "entry_price": entry_price, "exit_price": None, "pnl_pct": None}
                )
                continue

        # Calculate P&L
        if follower["is_same_outcome"]:
            # Buy YES: profit if price goes up
            direction = "BUY"
            if entry_price > 0.001:
                pnl_pct = (exit_price - entry_price) / entry_price * 100
            else:
                pnl_pct = 0.0
        else:
            # Buy NO (short YES): profit if YES price goes down
            direction = "SHORT"
            entry_no = 1 - entry_price
            exit_no = 1 - exit_price
            if entry_no > 0.001:
                pnl_pct = (exit_no - entry_no) / entry_no * 100
            else:
                pnl_pct = 0.0

        trades.append(
            {
                **follower,
                "status": "ok",
                "direction": direction,
                "entry_price": round(entry_price, 4),
                "exit_price": round(exit_price, 4),
                "pnl_pct": round(pnl_pct, 2),
            }
        )

        # Brief delay to be nice to the API
        if i < len(followers) - 1:
            time.sleep(0.15)

    valid_trades = [t for t in trades if t["status"] == "ok"]
    skipped_trades = [t for t in trades if t["status"] != "ok"]

    yield {
        "type": "result",
        "message": f"Fetched price data: {len(valid_trades)} trades executable, {len(skipped_trades)} skipped",
    }

    # ── Step 5: Calculate summary ───────────────────────────────
    if valid_trades:
        pnls = [t["pnl_pct"] for t in valid_trades]
        avg_pnl = sum(pnls) / len(pnls)
        summary = {
            "total_trades": len(valid_trades),
            "skipped_trades": len(skipped_trades),
            "avg_pnl_pct": round(avg_pnl, 2),
            "best_trade_pnl": round(max(pnls), 2),
            "worst_trade_pnl": round(min(pnls), 2),
            "winning_trades": sum(1 for p in pnls if p > 0),
            "losing_trades": sum(1 for p in pnls if p <= 0),
        }
    else:
        summary = {
            "total_trades": 0,
            "skipped_trades": len(skipped_trades),
            "avg_pnl_pct": 0,
            "best_trade_pnl": 0,
            "worst_trade_pnl": 0,
            "winning_trades": 0,
            "losing_trades": 0,
        }

    # ── Done ────────────────────────────────────────────────────
    yield {
        "type": "done",
        "data": {
            "leader": {
                "id": market_id,
                "question": market_question,
                "signal_time": signal_time,
                "signal_time_formatted": _format_timestamp(signal_time),
                "threshold": threshold,
            },
            "holding_period": holding_period,
            "exit_time": exit_time,
            "exit_time_formatted": _format_timestamp(exit_time),
            "trades": trades,
            "summary": summary,
        },
    }
