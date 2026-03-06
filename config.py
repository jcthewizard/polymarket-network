"""
Centralized configuration for Polymarket Autotrader.
All settings are loaded from environment variables with safe defaults.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# API Keys
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
POLY_PRIVATE_KEY = os.environ.get("POLY_PRIVATE_KEY", "")

# Trading Mode
TRADING_MODE = os.environ.get("TRADING_MODE", "dry_run")  # 'dry_run' | 'live'
DRY_RUN = TRADING_MODE != "live"
TRADING_ENABLED = os.environ.get("TRADING_ENABLED", "false").lower() == "true"

# Trade Sizing
BET_SIZE_USDC = float(os.environ.get("BET_SIZE_USDC", "1.00"))

# Polling Intervals (seconds)
TRACKER_POLL_INTERVAL = int(os.environ.get("TRACKER_POLL_INTERVAL", "10"))
POSITION_POLL_INTERVAL = int(os.environ.get("POSITION_POLL_INTERVAL", "5"))
FILL_CHECK_INTERVAL = int(os.environ.get("FILL_CHECK_INTERVAL", "10"))

# Position Management
POSITION_EXIT_SECONDS = int(os.environ.get("POSITION_EXIT_SECONDS", "180"))
STALE_ORDER_SECONDS = int(os.environ.get("STALE_ORDER_SECONDS", "60"))
SELL_DISCOUNT_PCT = float(os.environ.get("SELL_DISCOUNT_PCT", "0.02"))

# API Hosts
CLOB_HOST = os.environ.get("CLOB_HOST", "https://clob.polymarket.com")
GAMMA_API_HOST = os.environ.get("GAMMA_API_HOST", "https://gamma-api.polymarket.com")

# Data Refresh
REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", "600"))
