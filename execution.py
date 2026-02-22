"""
HFT Trading Executor for Polymarket CLOB
=========================================
High-frequency trading execution module that takes signals from the
correlation engine and executes trades with:
  - Confidence-based position sizing
  - Dynamic take-profit / stop-loss
  - Automatic 3-minute time exit (async)

Configuration is loaded exclusively from .env via python-dotenv.

Usage:
    from execution import TradingExecutor

    executor = TradingExecutor()                          # reads POLY_PRIVATE_KEY from .env
    await executor.open_position("will-trump-win-2024", "Yes", confidence_score=75)
"""

import os
import json
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple

import requests as _requests

from dotenv import load_dotenv
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

# ---------------------------------------------------------------------------
# Configuration  (all secrets via .env — never hardcode)
# ---------------------------------------------------------------------------
load_dotenv()

HOST = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CHAIN_ID = 137                        # Polygon Mainnet
MAX_SPEND_USDC = 5.00                 # Hard safety cap per trade (USD)
TIME_EXIT_SECONDS = 180               # 3-minute auto-close

# Base risk parameters
BASE_TP_PCT = 0.05                    # +5 %
BASE_SL_PCT = 0.05                    #  5 %

logger = logging.getLogger("trading_executor")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
)


# ---------------------------------------------------------------------------
# TradingExecutor
# ---------------------------------------------------------------------------
class TradingExecutor:
    """
    High-frequency trading executor for Polymarket's CLOB.

    All wallet credentials are loaded from the ``POLY_PRIVATE_KEY``
    environment variable (set in ``.env``).
    """

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------
    def __init__(
        self,
        private_key: Optional[str] = None,
        dry_run: bool = True,
    ) -> None:
        """
        Args:
            private_key: Polygon wallet private key.
                         Falls back to the POLY_PRIVATE_KEY env var.
            dry_run:     If True (default), orders are logged but NOT posted.
        """
        self.dry_run = dry_run
        self._private_key = private_key or os.environ.get("POLY_PRIVATE_KEY", "")

        # In-flight positions keyed by a synthetic position id
        self._positions: Dict[str, Dict[str, Any]] = {}

        # Token-id cache:  slug → {"Yes": token_id, "No": token_id}
        self._token_cache: Dict[str, Dict[str, str]] = {}

        if not self._private_key:
            logger.warning(
                "No private key provided (POLY_PRIVATE_KEY).  "
                "The executor will work in dry-run mode only."
            )
            self.client: Optional[ClobClient] = None
            return

        logger.info("Initializing ClobClient (chain_id=%s)…", CHAIN_ID)
        self.client = ClobClient(
            HOST,
            key=self._private_key,
            chain_id=CHAIN_ID,
            signature_type=0,          # standard EOA wallet
        )

        logger.info("Deriving L2 API credentials…")
        api_creds = self.client.create_or_derive_api_creds()
        self.client.set_api_creds(api_creds)
        logger.info("L2 credentials set ✓")

    # ------------------------------------------------------------------
    # Position sizing
    # ------------------------------------------------------------------
    @staticmethod
    def get_position_size(confidence_score: float) -> float:
        """
        Return the USDC amount to risk based on the confidence score.

        Bands:
            40–60  →  $0.50
            60–80  →  $1.00
            80–100 →  $1.50
            else   →  $1.00  (default)
        """
        if 40 <= confidence_score < 60:
            return 0.50
        elif 60 <= confidence_score < 80:
            return 1.00
        elif 80 <= confidence_score <= 100:
            return 1.50
        else:
            return 1.00

    # ------------------------------------------------------------------
    # Dynamic take-profit / stop-loss
    # ------------------------------------------------------------------
    @staticmethod
    def calculate_dynamic_tp(entry_price: float) -> float:
        """
        Compute the dynamic take-profit modifier.

        Formula:
            dynamic_tp = 0.05 * (1 - (|entry_price - 0.50| / 0.50))

        The modifier is largest when entry_price == 0.50 (full 5 %)
        and shrinks toward 0 % as the price nears 0 or 1.
        """
        return BASE_TP_PCT * (1.0 - (abs(entry_price - 0.50) / 0.50))

    @staticmethod
    def calculate_exit_levels(entry_price: float) -> Tuple[float, float]:
        """
        Return ``(take_profit_price, stop_loss_price)`` for a given entry.

        * TP = entry × (1 + dynamic_tp)
        * SL = entry × (1 - base_sl)
        """
        dynamic_tp = TradingExecutor.calculate_dynamic_tp(entry_price)
        take_profit = entry_price * (1.0 + dynamic_tp)
        stop_loss = entry_price * (1.0 - BASE_SL_PCT)
        return (round(take_profit, 6), round(stop_loss, 6))

    # ------------------------------------------------------------------
    # Token resolution  (Gamma API)
    # ------------------------------------------------------------------
    def get_token_id(self, market_slug: str, outcome: str) -> str:
        """
        Resolve a slug + outcome ("Yes"/"No") to a CLOB token_id.
        """
        outcome = outcome.strip().capitalize()
        if outcome not in ("Yes", "No"):
            raise ValueError(f"outcome must be 'Yes' or 'No', got '{outcome}'")

        if market_slug in self._token_cache:
            return self._token_cache[market_slug][outcome]

        url = f"{GAMMA_API}/markets"
        logger.info("Resolving token_id: GET %s?slug=%s", url, market_slug)

        try:
            resp = _requests.get(url, params={"slug": market_slug}, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except (_requests.RequestException, ValueError) as exc:
            raise ValueError(
                f"Failed to fetch market '{market_slug}' from Gamma API: {exc}"
            ) from exc

        if not data or not isinstance(data, list) or len(data) == 0:
            raise ValueError(f"Market slug '{market_slug}' not found on Gamma API.")

        market = data[0]
        clob_token_ids_raw = market.get("clobTokenIds")
        if not clob_token_ids_raw:
            raise ValueError(
                f"Market '{market_slug}' has no clobTokenIds — "
                "it may not be tradeable on the CLOB."
            )

        if isinstance(clob_token_ids_raw, str):
            clob_token_ids = json.loads(clob_token_ids_raw)
        else:
            clob_token_ids = clob_token_ids_raw

        if len(clob_token_ids) < 2:
            raise ValueError(
                f"Expected 2 token IDs for '{market_slug}', got {len(clob_token_ids)}."
            )

        self._token_cache[market_slug] = {
            "Yes": clob_token_ids[0],
            "No":  clob_token_ids[1],
        }

        logger.info(
            "Resolved '%s' → Yes: %s…  No: %s…",
            market_slug,
            clob_token_ids[0][:12],
            clob_token_ids[1][:12],
        )
        return self._token_cache[market_slug][outcome]

    # ------------------------------------------------------------------
    # Async time exit  (3-minute auto-close)
    # ------------------------------------------------------------------
    async def _schedule_time_exit(self, position_id: str) -> None:
        """Wait 3 minutes, then close the position automatically."""
        await asyncio.sleep(TIME_EXIT_SECONDS)
        logger.info("⏰  Time exit triggered for position %s", position_id)
        await self.close_position(position_id)

    # ------------------------------------------------------------------
    # Open position
    # ------------------------------------------------------------------
    async def open_position(
        self,
        market_slug: str,
        outcome: str,
        confidence_score: float,
        price: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Size a trade, place a limit-buy order, and schedule a 3-minute exit.

        Args:
            market_slug:      e.g. "will-trump-win-2024"
            outcome:          "Yes" or "No"
            confidence_score: 0–100
            price:            Explicit limit price (0.01–0.99).
                              If None, the current mid-market price is used.

        Returns:
            Position summary dict.
        """
        outcome = outcome.strip().capitalize()
        amount_usdc = self.get_position_size(confidence_score)

        if amount_usdc > MAX_SPEND_USDC:
            raise ValueError(
                f"Position size ${amount_usdc:.2f} exceeds safety cap "
                f"${MAX_SPEND_USDC:.2f}."
            )

        token_id = self.get_token_id(market_slug, outcome)

        # If no explicit price, fetch the current mid-market price
        if price is None:
            price = self._fetch_mid_price(market_slug)

        if not (0.01 <= price <= 0.99):
            raise ValueError(f"price must be 0.01–0.99, got {price}")

        # Compute exit levels
        tp_price, sl_price = self.calculate_exit_levels(price)
        size = round(amount_usdc / price, 2)

        position_id = f"{market_slug}_{outcome}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"

        position = {
            "position_id": position_id,
            "market_slug": market_slug,
            "outcome": outcome,
            "token_id": token_id,
            "side": "BUY",
            "entry_price": price,
            "size_shares": size,
            "amount_usdc": amount_usdc,
            "confidence_score": confidence_score,
            "take_profit": tp_price,
            "stop_loss": sl_price,
            "dynamic_tp_pct": round(self.calculate_dynamic_tp(price) * 100, 4),
            "opened_at": datetime.now(timezone.utc).isoformat(),
            "status": "PENDING",
        }

        is_dry = self.dry_run

        if is_dry:
            logger.info("🏜️  DRY RUN — order NOT posted:")
            for k, v in position.items():
                logger.info("    %s: %s", k, v)
            position["status"] = "DRY_RUN"
        else:
            if self.client is None:
                raise RuntimeError(
                    "Cannot place live trade: no private key configured. "
                    "Set POLY_PRIVATE_KEY in your .env file."
                )

            logger.info(
                "📤  LIVE order: BUY %s %s @ $%.2f (%s shares)",
                outcome, market_slug, price, size,
            )

            order_args = OrderArgs(
                token_id=token_id,
                price=price,
                size=size,
                side=BUY,
            )
            signed = self.client.create_order(order_args)
            response = self.client.post_order(signed, OrderType.GTC)
            position["order_response"] = response
            position["status"] = "OPEN"
            logger.info("✅  Order posted: %s", response)

        # Track the position
        self._positions[position_id] = position

        # Schedule the 3-minute auto-close
        asyncio.ensure_future(self._schedule_time_exit(position_id))
        logger.info(
            "⏱️  Time exit scheduled: %s will auto-close in %ds",
            position_id, TIME_EXIT_SECONDS,
        )

        return position

    # ------------------------------------------------------------------
    # Close position
    # ------------------------------------------------------------------
    async def close_position(self, position_id: str) -> Dict[str, Any]:
        """
        Close an open position by selling shares.
        """
        position = self._positions.get(position_id)
        if position is None:
            logger.warning("Position %s not found — may already be closed.", position_id)
            return {"position_id": position_id, "status": "NOT_FOUND"}

        if position["status"] in ("CLOSED", "DRY_RUN"):
            logger.info("Position %s already %s — skipping.", position_id, position["status"])
            return position

        is_dry = self.dry_run

        if is_dry:
            logger.info("🏜️  DRY RUN — close NOT executed for %s", position_id)
            position["status"] = "CLOSED_DRY"
        else:
            if self.client is None:
                raise RuntimeError("Cannot close live position: no private key.")

            logger.info("📤  Closing position %s (SELL %s shares)", position_id, position["size_shares"])

            order_args = OrderArgs(
                token_id=position["token_id"],
                price=position["entry_price"],   # market-close at entry (GTC)
                size=position["size_shares"],
                side=SELL,
            )
            signed = self.client.create_order(order_args)
            response = self.client.post_order(signed, OrderType.GTC)
            position["close_response"] = response
            position["status"] = "CLOSED"
            logger.info("✅  Position closed: %s", response)

        position["closed_at"] = datetime.now(timezone.utc).isoformat()
        return position

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _fetch_mid_price(self, market_slug: str) -> float:
        """Fetch current mid-market probability from the Gamma API."""
        url = f"{GAMMA_API}/markets"
        try:
            resp = _requests.get(url, params={"slug": market_slug}, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data and isinstance(data, list):
                price_str = data[0].get("outcomePrices")
                if price_str:
                    prices = json.loads(price_str) if isinstance(price_str, str) else price_str
                    return float(prices[0])
        except Exception as exc:
            logger.warning("Could not fetch mid-price for %s: %s", market_slug, exc)
        # Fallback
        return 0.50

    @property
    def open_positions(self) -> Dict[str, Dict[str, Any]]:
        """Return all currently tracked positions."""
        return {
            pid: pos for pid, pos in self._positions.items()
            if pos["status"] in ("OPEN", "PENDING", "DRY_RUN")
        }


# ---------------------------------------------------------------------------
# CLI convenience
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Polymarket HFT Executor")
    parser.add_argument("slug", help="Market slug, e.g. 'will-trump-win-2024'")
    parser.add_argument("outcome", choices=["Yes", "No"], help="Outcome to buy")
    parser.add_argument("confidence", type=float, help="Confidence score (0-100)")
    parser.add_argument("--price", type=float, default=None, help="Limit price (auto if omitted)")
    parser.add_argument(
        "--live", action="store_true", help="Execute for real (default is dry-run)"
    )
    args = parser.parse_args()

    executor = TradingExecutor(dry_run=not args.live)

    async def _main():
        result = await executor.open_position(
            args.slug, args.outcome, args.confidence, args.price,
        )
        print(json.dumps(result, indent=2, default=str))
        # Only wait for the time exit in live mode
        if args.live:
            logger.info("Waiting %ds for time exit…", TIME_EXIT_SECONDS + 5)
            await asyncio.sleep(TIME_EXIT_SECONDS + 5)

    asyncio.run(_main())

