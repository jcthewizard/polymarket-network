"""
Polymarket Execution Layer
==========================
A drop-in module that takes trade signals from the correlation engine
and executes limit orders on Polymarket via the py-clob-client SDK.

Usage:
    from execution import PolymarketExecutor

    executor = PolymarketExecutor()                     # reads POLY_PRIVATE_KEY from env
    executor.place_trade("will-trump-win-2024", "Yes", 0.55, 2.00)  # dry-run by default
    executor.place_trade("will-trump-win-2024", "Yes", 0.55, 2.00, dry_run=False)  # LIVE
"""

import os
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

import requests as _requests

from dotenv import load_dotenv
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
load_dotenv()

HOST = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CHAIN_ID = 137                    # Polygon Mainnet
MAX_SPEND_USDC = 5.00             # Hard safety cap per trade (USD)

logger = logging.getLogger("polymarket_executor")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
)


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------
class PolymarketExecutor:
    """Executes trades on Polymarket's CLOB from correlation-engine signals."""

    def __init__(
        self,
        private_key: Optional[str] = None,
        dry_run: bool = True,
    ) -> None:
        """
        Initialize the executor.

        Args:
            private_key: Polygon wallet private key.
                         Falls back to the POLY_PRIVATE_KEY env var.
            dry_run:     Global default – if True, place_trade() will only
                         log the order without posting it.
        """
        self.dry_run = dry_run
        self._private_key = private_key or os.environ.get("POLY_PRIVATE_KEY", "")

        # Cache: slug → { "Yes": token_id, "No": token_id }
        self._token_cache: Dict[str, Dict[str, str]] = {}

        if not self._private_key:
            logger.warning(
                "No private key provided (POLY_PRIVATE_KEY). "
                "The executor will work in dry-run mode only."
            )
            self.client: Optional[ClobClient] = None
            return

        # --- Authenticate (L1 → L2) ---
        logger.info("Initializing ClobClient (EOA, chain_id=%s)…", CHAIN_ID)
        self.client = ClobClient(
            HOST,
            key=self._private_key,
            chain_id=CHAIN_ID,
            signature_type=0,      # 0 = standard EOA wallet
        )

        logger.info("Deriving L2 API credentials…")
        api_creds = self.client.create_or_derive_api_creds()
        self.client.set_api_creds(api_creds)
        logger.info("L2 credentials set ✓")

    # ------------------------------------------------------------------
    # Token resolution
    # ------------------------------------------------------------------
    def get_token_id(self, market_slug: str, outcome: str) -> str:
        """
        Resolve a human-readable market slug + outcome ("Yes"/"No")
        to the CLOB token_id required by the trading API.

        Uses the Gamma API:  GET /markets?slug=<slug>

        Args:
            market_slug: e.g. "will-trump-win-2024"
            outcome:     "Yes" or "No" (case-insensitive)

        Returns:
            The token_id string for the requested outcome.

        Raises:
            ValueError: If the slug cannot be found or has no tokens.
        """
        outcome = outcome.strip().capitalize()
        if outcome not in ("Yes", "No"):
            raise ValueError(f"outcome must be 'Yes' or 'No', got '{outcome}'")

        # Check cache first
        if market_slug in self._token_cache:
            return self._token_cache[market_slug][outcome]

        # Fetch from Gamma API
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

        # The Gamma API returns a list of markets matching the slug
        if not data or not isinstance(data, list) or len(data) == 0:
            raise ValueError(
                f"Market slug '{market_slug}' not found on Gamma API."
            )

        market = data[0]

        # clobTokenIds is a JSON-encoded list: '["<yes_id>", "<no_id>"]'
        clob_token_ids_raw = market.get("clobTokenIds")
        if not clob_token_ids_raw:
            raise ValueError(
                f"Market '{market_slug}' has no clobTokenIds — "
                "it may not be tradeable on the CLOB."
            )

        # Handle both string-encoded JSON and native list
        if isinstance(clob_token_ids_raw, str):
            clob_token_ids = json.loads(clob_token_ids_raw)
        else:
            clob_token_ids = clob_token_ids_raw

        if len(clob_token_ids) < 2:
            raise ValueError(
                f"Expected 2 token IDs (Yes/No) for '{market_slug}', "
                f"got {len(clob_token_ids)}."
            )

        # Convention: index 0 = Yes, index 1 = No
        self._token_cache[market_slug] = {
            "Yes": clob_token_ids[0],
            "No": clob_token_ids[1],
        }

        logger.info(
            "Resolved '%s' → Yes: %s…  No: %s…",
            market_slug,
            clob_token_ids[0][:12],
            clob_token_ids[1][:12],
        )

        return self._token_cache[market_slug][outcome]

    # ------------------------------------------------------------------
    # Trade execution
    # ------------------------------------------------------------------
    def place_trade(
        self,
        market_slug: str,
        outcome: str,
        price: float,
        amount_usdc: float,
        dry_run: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Place a limit-buy order on Polymarket.

        Args:
            market_slug:  Human-readable slug (e.g. "will-trump-win-2024").
            outcome:      "Yes" or "No".
            price:        Limit price per share (0.01 – 0.99).
            amount_usdc:  Total USDC to spend on the order.
            dry_run:      Override the instance-level dry_run flag.
                          Defaults to True if not set anywhere.

        Returns:
            The API response dict (contains order ID) on success,
            or a summary dict in dry-run mode.
        """
        # Resolve dry_run: arg > instance > True
        is_dry = dry_run if dry_run is not None else self.dry_run

        # --- 1. Validate inputs ---
        outcome = outcome.strip().capitalize()
        if outcome not in ("Yes", "No"):
            raise ValueError(f"outcome must be 'Yes' or 'No', got '{outcome}'")

        if not (0.01 <= price <= 0.99):
            raise ValueError(f"price must be 0.01–0.99, got {price}")

        if amount_usdc <= 0:
            raise ValueError(f"amount_usdc must be positive, got {amount_usdc}")

        # --- 2. Safety cap ---
        if amount_usdc > MAX_SPEND_USDC:
            raise ValueError(
                f"amount_usdc ${amount_usdc:.2f} exceeds MAX_SPEND_USDC "
                f"${MAX_SPEND_USDC:.2f}. Raise the constant if intentional."
            )

        # --- 3. Resolve token ---
        token_id = self.get_token_id(market_slug, outcome)

        # Calculate shares from USDC amount and price
        size = round(amount_usdc / price, 2)

        order_summary = {
            "market_slug": market_slug,
            "outcome": outcome,
            "token_id": token_id,
            "side": "BUY",
            "price": price,
            "size_shares": size,
            "amount_usdc": amount_usdc,
            "order_type": "GTC",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # --- 4. Dry-run check ---
        if is_dry:
            logger.info("🏜️  DRY RUN — order NOT posted:")
            for key, val in order_summary.items():
                logger.info("    %s: %s", key, val)
            order_summary["status"] = "DRY_RUN"
            return order_summary

        # --- 5. Execute for real ---
        if self.client is None:
            raise RuntimeError(
                "Cannot execute a live trade: no private key configured. "
                "Set POLY_PRIVATE_KEY or pass private_key= to the constructor."
            )

        logger.info("📤 Posting LIVE order: %s %s @ $%.2f …", outcome, market_slug, price)

        order_args = OrderArgs(
            token_id=token_id,
            price=price,
            size=size,
            side=BUY,
        )

        signed_order = self.client.create_order(order_args)
        response = self.client.post_order(signed_order, OrderType.GTC)

        logger.info("✅ Order posted: %s", response)
        return response


# ---------------------------------------------------------------------------
# CLI convenience
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Polymarket trade executor")
    parser.add_argument("slug", help="Market slug, e.g. 'will-trump-win-2024'")
    parser.add_argument("outcome", choices=["Yes", "No"], help="Outcome to buy")
    parser.add_argument("price", type=float, help="Limit price (0.01–0.99)")
    parser.add_argument("amount", type=float, help="USDC to spend")
    parser.add_argument(
        "--live", action="store_true", help="Execute for real (default is dry-run)"
    )
    args = parser.parse_args()

    executor = PolymarketExecutor(dry_run=not args.live)
    result = executor.place_trade(args.slug, args.outcome, args.price, args.amount)
    print(json.dumps(result, indent=2))
