"""
Raw CLOB API client for operations not supported by py-clob-client SDK.
Provides: order status, order cancellation, balance queries.
"""

import time
import hashlib
import hmac
import base64
import json
import logging
import aiohttp
from typing import Optional, Dict, List

import config

logger = logging.getLogger("clob_api")

CLOB_HOST = config.CLOB_HOST


class ClobApiClient:
    """
    Async client for Polymarket CLOB REST API.
    Requires L2 API credentials (api_key, api_secret, api_passphrase)
    derived from the same private key used by TradingExecutor.
    """

    def __init__(self, api_key: str = "", api_secret: str = "", api_passphrase: str = ""):
        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

    def _build_headers(self, method: str = "GET", path: str = "", body: str = "") -> Dict[str, str]:
        """Build authenticated headers for CLOB API requests."""
        timestamp = str(int(time.time()))
        message = timestamp + method.upper() + path + body

        if self.api_secret:
            signature = base64.b64encode(
                hmac.new(
                    base64.b64decode(self.api_secret),
                    message.encode("utf-8"),
                    hashlib.sha256
                ).digest()
            ).decode("utf-8")
        else:
            signature = ""

        return {
            "POLY_API_KEY": self.api_key,
            "POLY_API_SECRET": self.api_secret,
            "POLY_API_PASSPHRASE": self.api_passphrase,
            "POLY_TIMESTAMP": timestamp,
            "POLY_SIGNATURE": signature,
            "Content-Type": "application/json",
        }

    async def get_order(self, session: aiohttp.ClientSession, order_id: str) -> Optional[Dict]:
        """
        GET /order/{order_id} — fetch order details including fill status.
        Returns order dict or None on failure.
        """
        path = f"/order/{order_id}"
        url = f"{CLOB_HOST}{path}"
        headers = self._build_headers("GET", path)

        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    text = await resp.text()
                    logger.warning(f"get_order {order_id} returned {resp.status}: {text[:200]}")
        except Exception as e:
            logger.warning(f"get_order {order_id} error: {e}")
        return None

    async def cancel_order(self, session: aiohttp.ClientSession, order_id: str) -> bool:
        """
        DELETE /order/{order_id} — cancel an open order.
        Returns True if cancelled, False otherwise.
        """
        path = f"/order/{order_id}"
        url = f"{CLOB_HOST}{path}"
        headers = self._build_headers("DELETE", path)

        try:
            async with session.delete(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status in (200, 204):
                    logger.info(f"Cancelled order {order_id}")
                    return True
                else:
                    text = await resp.text()
                    logger.warning(f"cancel_order {order_id} returned {resp.status}: {text[:200]}")
        except Exception as e:
            logger.warning(f"cancel_order {order_id} error: {e}")
        return False

    async def get_open_orders(self, session: aiohttp.ClientSession) -> List[Dict]:
        """
        GET /orders — fetch all open orders for this API key.
        """
        path = "/orders"
        url = f"{CLOB_HOST}{path}"
        headers = self._build_headers("GET", path)

        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    text = await resp.text()
                    logger.warning(f"get_open_orders returned {resp.status}: {text[:200]}")
        except Exception as e:
            logger.warning(f"get_open_orders error: {e}")
        return []

    async def get_balance(self, session: aiohttp.ClientSession) -> float:
        """
        Query USDC balance. Uses the /balance endpoint if available,
        otherwise returns -1 to indicate unknown (caller should skip balance check).
        """
        path = "/balance"
        url = f"{CLOB_HOST}{path}"
        headers = self._build_headers("GET", path)

        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    # Response format may vary — try common fields
                    if isinstance(data, dict):
                        for key in ("balance", "usdc", "available", "amount"):
                            if key in data:
                                return float(data[key])
                    elif isinstance(data, (int, float)):
                        return float(data)
                    logger.warning(f"get_balance unexpected response: {data}")
                else:
                    text = await resp.text()
                    logger.warning(f"get_balance returned {resp.status}: {text[:200]}")
        except Exception as e:
            logger.warning(f"get_balance error: {e}")
        return -1.0  # Unknown — caller should skip balance check

    def is_order_filled(self, order: Dict) -> bool:
        """Check if an order dict indicates a fill."""
        status = (order.get("status") or order.get("order_status") or "").upper()
        return status in ("FILLED", "MATCHED", "CLOSED")

    def is_order_open(self, order: Dict) -> bool:
        """Check if an order is still open/active."""
        status = (order.get("status") or order.get("order_status") or "").upper()
        return status in ("LIVE", "OPEN", "ACTIVE", "")
