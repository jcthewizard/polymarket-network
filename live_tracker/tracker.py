"""
Prediction Market Live Tracker
--------------------------------
Loads a relationship graph JSON, polls live prices for all markets,
detects leader resolutions, and fires alerts to followers.

Schema expected (from teammate's build_graph output):
  relationships[].leader.id                 -> condition ID (market lookup)
  relationships[].leader.clob_token_id      -> token ID (live price)
  relationships[].leader.question           -> human readable title
  relationships[].followers[].id            -> condition ID
  relationships[].followers[].clob_token_id -> token ID
  relationships[].followers[].action        -> "buy" | "sell"
  relationships[].followers[].confidence    -> 0.0 - 1.0
  relationships[].followers[].base_bet_size -> dollar amount
  relationships[].followers[].end_date      -> expiry

Usage:
    python tracker.py --graph schema.json
    python tracker.py --graph schema.json --interval 5
"""

import asyncio
import aiohttp
import json
import argparse
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("tracker")

# ── Data structures ─────────────────────────────────────────────────────────────

@dataclass
class PricePoint:
    price: float
    resolved: bool
    resolution_value: Optional[str]  # "YES" | "NO" | None
    timestamp: datetime

@dataclass
class MarketState:
    condition_id: str        # used for market status lookup
    clob_token_id: str       # used for live price lookup
    question: str            # human readable label for logs
    price_history: list[PricePoint] = field(default_factory=list)
    resolution_fired: bool = False  # ensures alert fires exactly once

    def record(self, point: PricePoint):
        self.price_history.append(point)

    @property
    def current(self) -> Optional[PricePoint]:
        return self.price_history[-1] if self.price_history else None

    @property
    def previous(self) -> Optional[PricePoint]:
        return self.price_history[-2] if len(self.price_history) >= 2 else None

    @property
    def label(self) -> str:
        """Short label for logs — first 50 chars of question."""
        return self.question[:50]

# ── Polymarket API ──────────────────────────────────────────────────────────────

POLYMARKET_CLOB = "https://clob.polymarket.com"

async def fetch_resolution_status(
    session: aiohttp.ClientSession,
    condition_id: str,
) -> dict:
    """
    Use condition_id to check whether a market has resolved and what the outcome was.
    Endpoint: GET /markets/{condition_id}

    Returns: { resolved: bool, resolution_value: "YES"|"NO"|None }
    """
    try:
        url = f"{POLYMARKET_CLOB}/markets/{condition_id}"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status == 200:
                data = await resp.json()
                resolved = data.get("closed", False) or not data.get("active", True)
                resolution_raw = data.get("resolution", "")
                resolution_value = resolution_raw.upper() if resolution_raw else None
                return {"resolved": resolved, "resolution_value": resolution_value}
            else:
                log.warning(f"Non-200 for market {condition_id}: {resp.status}")
    except asyncio.TimeoutError:
        log.warning(f"Timeout fetching market status {condition_id}")
    except Exception as e:
        log.warning(f"Error fetching market status {condition_id}: {e}")

    return {"resolved": False, "resolution_value": None}


async def fetch_live_price(
    session: aiohttp.ClientSession,
    clob_token_id: str,
) -> Optional[float]:
    """
    Use clob_token_id to get the current mid-market price.
    Endpoint: GET /midpoint?token_id={clob_token_id}

    Returns the midpoint price as a float, or None on failure.
    """
    try:
        url = f"{POLYMARKET_CLOB}/midpoint"
        params = {"token_id": clob_token_id}
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=5)) as resp:
            if resp.status == 200:
                data = await resp.json()
                mid = data.get("mid")
                return float(mid) if mid is not None else None
            else:
                log.warning(f"Non-200 for price {clob_token_id}: {resp.status}")
    except asyncio.TimeoutError:
        log.warning(f"Timeout fetching price {clob_token_id}")
    except Exception as e:
        log.warning(f"Error fetching price {clob_token_id}: {e}")

    return None


async def fetch_market_data(
    session: aiohttp.ClientSession,
    condition_id: str,
    clob_token_id: str,
) -> dict:
    """
    Fetch both price and resolution status concurrently for a single market.
    Returns a unified dict ready for process_update.
    """
    price_task      = fetch_live_price(session, clob_token_id)
    resolution_task = fetch_resolution_status(session, condition_id)

    price, resolution = await asyncio.gather(price_task, resolution_task)

    return {
        "price":            price,
        "resolved":         resolution["resolved"],
        "resolution_value": resolution["resolution_value"],
    }

# ── Alert logic ─────────────────────────────────────────────────────────────────

def fire_resolution_alert(
    leader: MarketState,
    resolution_value: str,
    followers: list[dict],
):
    """
    Called exactly once when a leader resolves.
    Prints a clear alert block with trade signals for each follower.
    """
    divider = "=" * 65
    now     = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    print(f"\n{divider}")
    print(f"  RESOLUTION DETECTED")
    print(f"  Leader   : {leader.question}")
    print(f"  ID       : {leader.condition_id}")
    print(f"  Outcome  : {resolution_value}")
    print(f"  Time     : {now}")
    print(f"{divider}")

    for f in followers:
        action    = f.get("action", "?").upper()
        conf      = f.get("confidence", 0)
        size      = f.get("base_bet_size", 1.0)
        question  = f.get("question", f.get("id", "unknown"))[:45]
        exp       = f.get("end_date", "?")
        rel_type  = f.get("relationship_type", "?")
        rationale = f.get("rationale", "")

        # Flip action if outcome is NO and relationship is same-direction
        effective_action = action
        if resolution_value == "NO" and f.get("is_same_direction", True):
            effective_action = "SELL" if action == "BUY" else "BUY"

        print(f"  -> {effective_action:4s}  {question:45s}")
        print(f"       conf={conf:.0%}  size=${size:.2f}  exp={exp}  type={rel_type}")
        if rationale:
            print(f"       rationale: {rationale}")

        log.info(
            f"SIGNAL | outcome={resolution_value} follower={question} "
            f"action={effective_action} conf={conf:.0%} size=${size:.2f}"
        )

    print(f"{divider}\n")

# ── Price update logic ──────────────────────────────────────────────────────────

def process_update(
    state: MarketState,
    raw: dict,
    followers: Optional[list[dict]] = None,
):
    """
    Record a new price point and check for resolution trigger.
    `followers` is only passed for leader markets.
    """
    if raw["price"] is None:
        return  # skip — API returned no price this tick

    point = PricePoint(
        price=raw["price"],
        resolved=raw["resolved"],
        resolution_value=raw["resolution_value"],
        timestamp=datetime.now(timezone.utc),
    )
    state.record(point)

    # Log price movement if it changed by more than 0.1%
    prev = state.previous
    if prev and abs(point.price - prev.price) >= 0.001:
        direction = "up" if point.price > prev.price else "down"
        log.info(
            f"PRICE {direction}  {state.label:50s}  "
            f"{prev.price:.3f} -> {point.price:.3f}"
        )

    # Resolution trigger — leaders only, fires exactly once
    if followers and point.resolved and not state.resolution_fired:
        state.resolution_fired = True
        outcome = point.resolution_value or "UNKNOWN"
        fire_resolution_alert(state, outcome, followers)

# ── Graph loading ───────────────────────────────────────────────────────────────

def load_graph(graph: dict) -> tuple[dict[str, MarketState], dict[str, list[dict]]]:
    """
    Parse the relationship JSON into two structures:
      - all_markets:  condition_id -> MarketState  (every market we track)
      - leaders_map:  condition_id -> followers[]  (leader markets only)
    """
    all_markets: dict[str, MarketState] = {}
    leaders_map: dict[str, list[dict]]  = {}

    for rel in graph.get("relationships", []):
        leader_data = rel["leader"]
        lid         = leader_data["id"]
        ltid        = leader_data["clob_token_id"]
        lquestion   = leader_data.get("question", lid)

        # Register leader
        if lid not in all_markets:
            all_markets[lid] = MarketState(
                condition_id=lid,
                clob_token_id=ltid,
                question=lquestion,
            )

        followers = rel.get("followers", [])
        leaders_map[lid] = followers

        # Register each follower
        for f in followers:
            fid  = f["id"]
            ftid = f["clob_token_id"]
            fq   = f.get("question", fid)
            if fid not in all_markets:
                all_markets[fid] = MarketState(
                    condition_id=fid,
                    clob_token_id=ftid,
                    question=fq,
                )

    return all_markets, leaders_map

# ── Main polling loop ───────────────────────────────────────────────────────────

async def run_tracker(graph: dict, interval: int):
    all_markets, leaders_map = load_graph(graph)

    n_leaders   = len(leaders_map)
    n_followers = len(all_markets) - n_leaders

    log.info(f"Graph loaded — {n_leaders} leaders, {n_followers} followers, {len(all_markets)} total markets")
    log.info(f"Polling every {interval}s  |  Press Ctrl+C to stop\n")

    async with aiohttp.ClientSession() as session:
        while True:
            poll_start = asyncio.get_event_loop().time()

            # Fire all fetches concurrently — one per market
            tasks = {
                cid: fetch_market_data(session, state.condition_id, state.clob_token_id)
                for cid, state in all_markets.items()
            }
            results = await asyncio.gather(*tasks.values(), return_exceptions=True)
            fetched = dict(zip(tasks.keys(), results))

            # Process results
            for cid, raw in fetched.items():
                if isinstance(raw, Exception):
                    log.warning(f"Exception for {cid}: {raw}")
                    continue
                state     = all_markets[cid]
                followers = leaders_map.get(cid)  # None for follower markets
                process_update(state, raw, followers)

            # Wait out the remainder of the interval
            elapsed    = asyncio.get_event_loop().time() - poll_start
            sleep_time = max(0, interval - elapsed)
            await asyncio.sleep(sleep_time)

# ── Entrypoint ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Prediction market live tracker")
    parser.add_argument("--graph",    required=True, help="Path to relationship JSON file")
    parser.add_argument("--interval", type=int, default=10, help="Poll interval in seconds (default: 10)")
    args = parser.parse_args()

    with open(args.graph) as f:
        graph = json.load(f)

    try:
        asyncio.run(run_tracker(graph, args.interval))
    except KeyboardInterrupt:
        log.info("Tracker stopped.")

if __name__ == "__main__":
    main()