"""
Prediction Market Live Tracker
--------------------------------
Polls live prices for all markets loaded from the database,
detects leader resolutions, and fires alerts to followers.

Can be used standalone (python tracker.py) or imported as a library
with a custom on_resolution callback and asyncio stop_event.

Usage:
    python tracker.py                     # loads relationships from DB
    python tracker.py --interval 5        # custom poll interval
"""

import asyncio
import aiohttp
import json
import argparse
import logging
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

import config
import database as db

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
    Default resolution callback — used as a fallback for standalone use.
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
    on_resolution=None,
):
    """
    Record a new price point and check for resolution trigger.
    `followers` is only passed for leader markets.
    `on_resolution` is an optional callback(state, outcome, followers) fired on resolution.
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
        outcome = point.resolution_value or "UNKNOWN"

        # Check if already fired in the database (survives restarts)
        leader_market_id = state.condition_id
        if db.is_resolution_fired(leader_market_id):
            log.info(f"Resolution already fired for {state.label}, skipping")
            state.resolution_fired = True
            return
        db.mark_resolution_fired(leader_market_id, outcome)

        state.resolution_fired = True
        if on_resolution:
            on_resolution(state, outcome, followers, "resolution")
        else:
            fire_resolution_alert(state, outcome, followers)

    # Price threshold trigger — if leader price >= 98% or <= 2%, infer outcome
    threshold = config.PRICE_TRIGGER_THRESHOLD
    if followers and not state.resolution_fired and point.price is not None:
        if point.price >= threshold or point.price <= (1.0 - threshold):
            inferred_outcome = "YES" if point.price >= threshold else "NO"
            leader_market_id = state.condition_id
            trigger_key = f"{leader_market_id}_price"
            if db.is_resolution_fired(trigger_key):
                state.resolution_fired = True
                return
            db.mark_resolution_fired(trigger_key, inferred_outcome)
            state.resolution_fired = True
            log.info(
                f"PRICE TRIGGER  {state.label}  price={point.price:.3f}  "
                f"inferred={inferred_outcome}"
            )
            if on_resolution:
                on_resolution(state, inferred_outcome, followers, "price_threshold")
            else:
                fire_resolution_alert(state, inferred_outcome, followers)

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


def load_from_db() -> tuple[dict[str, MarketState], dict[str, list[dict]]]:
    """
    Load relationship data from the database.
    Returns (all_markets, leaders_map) just like the old load_graph.
    """
    relationships = db.get_active_relationships()

    all_markets = {}
    leaders_map = {}

    for rel in relationships:
        lid = rel['leader_market_id']
        l_cond = rel['leader_condition_id']
        l_clob = rel['leader_clob_token_id']
        l_question = rel.get('leader_question', lid)

        # Register leader
        if lid not in all_markets:
            all_markets[lid] = MarketState(
                condition_id=l_cond,
                clob_token_id=l_clob,
                question=l_question,
            )

        if lid not in leaders_map:
            leaders_map[lid] = []

        # Build follower dict matching the old schema format
        follower = {
            'id': rel['follower_condition_id'],
            'market_id': rel['follower_market_id'],
            'clob_token_id': rel.get('follower_clob_token_id_yes', ''),
            'clob_token_id_yes': rel.get('follower_clob_token_id_yes', ''),
            'clob_token_id_no': rel.get('follower_clob_token_id_no', ''),
            'question': rel.get('follower_question', ''),
            'slug': rel.get('follower_slug', ''),
            'confidence': rel.get('confidence', 0.5),
            'is_same_direction': rel.get('is_same_direction', True),
            'relationship_type': rel.get('relationship_type', 'direct'),
            'rationale': rel.get('rationale', ''),
            'action': 'buy',
            'base_bet_size': 1.0,
        }
        leaders_map[lid].append(follower)

        # Register follower market
        fid = rel['follower_market_id']
        f_cond = rel['follower_condition_id']
        f_clob = rel.get('follower_clob_token_id_yes', '')
        f_question = rel.get('follower_question', fid)
        if fid not in all_markets:
            all_markets[fid] = MarketState(
                condition_id=f_cond,
                clob_token_id=f_clob,
                question=f_question,
            )

    return all_markets, leaders_map

# ── Main polling loop ───────────────────────────────────────────────────────────

async def run_tracker(on_resolution=None, stop_event=None, interval=10, per_market_delay=0.2, session=None):
    all_markets, leaders_map = load_from_db()

    n_leaders   = len(leaders_map)
    n_followers = len(all_markets) - n_leaders

    log.info(f"Graph loaded — {n_leaders} leaders, {n_followers} followers, {len(all_markets)} total markets")
    cycle_time = len(all_markets) * per_market_delay
    log.info(f"Cycling through markets with {per_market_delay}s delay (~{cycle_time:.0f}s per full cycle)")
    log.info(f"Press Ctrl+C to stop\n")

    # Build ordered list — leaders first so resolutions are detected faster
    market_ids = list(leaders_map.keys()) + [cid for cid in all_markets if cid not in leaders_map]

    async def _poll(s):
        while not (stop_event and stop_event.is_set()):
            for cid in market_ids:
                if stop_event and stop_event.is_set():
                    break

                state = all_markets[cid]
                try:
                    raw = await fetch_market_data(s, state.condition_id, state.clob_token_id)
                    followers = leaders_map.get(cid)
                    process_update(state, raw, followers, on_resolution=on_resolution)
                except Exception as exc:
                    log.warning(f"Exception for {cid}: {exc}")

                await asyncio.sleep(per_market_delay)

    if session is not None:
        await _poll(session)
    else:
        async with aiohttp.ClientSession() as own_session:
            await _poll(own_session)

# ── Entrypoint ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Prediction market live tracker")
    parser.add_argument("--graph",    required=False, help="Path to relationship JSON file (legacy; ignored, loads from DB)")
    parser.add_argument("--interval", type=int, default=10, help="(deprecated, use --delay)")
    parser.add_argument("--delay", type=float, default=0.2, help="Delay between market polls in seconds (default: 0.2)")
    args = parser.parse_args()

    try:
        asyncio.run(run_tracker(
            on_resolution=fire_resolution_alert,
            per_market_delay=args.delay,
        ))
    except KeyboardInterrupt:
        log.info("Tracker stopped.")

if __name__ == "__main__":
    main()