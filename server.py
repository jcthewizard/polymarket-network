"""
HTTP server for Polymarket Network Visualization.
Serves static files and provides REST API endpoints for cached data.
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import json
import os
import sys
import errno
import threading
from datetime import datetime

import database as db
from llm_utils import call_openai_chat_text
import autotrader
from urllib.parse import urlparse, parse_qs

PORT = 8000

# ── Resolved markets cache (for backtest search) ──────────────
import threading as _threading
_resolved_markets_cache = None
_resolved_markets_cache_time = 0
_resolved_markets_lock = _threading.Lock()
RESOLVED_CACHE_TTL = 600  # 10 minutes

# ── Active markets cache (for market search) ──────────────
_active_markets_cache = None
_active_markets_cache_time = 0
_active_markets_lock = _threading.Lock()
ACTIVE_CACHE_TTL = 60  # 1 minute


def _pick_resolution_time(market: dict):
    """Return (timestamp_str, source) for best-available resolution time."""
    closed_time = market.get('closedTime', '') or ''
    if closed_time:
        return closed_time, 'closedTime'

    uma_end_date = market.get('umaEndDate', '') or ''
    if uma_end_date:
        return uma_end_date, 'umaEndDate'

    end_date = market.get('endDate', '') or ''
    if end_date:
        return end_date, 'endDate'

    return '', ''


def _fetch_market_prices(market_ids):
    """Fetch current YES prices for a list of market IDs from Gamma API.
    Returns a dict mapping market_id -> float price (0-1)."""
    unique_ids = list(set(mid for mid in market_ids if mid))
    if not unique_ids:
        return {}
    prices = {}
    # Gamma API supports filtering by id (comma-separated or repeated params)
    chunk_size = 50
    for i in range(0, len(unique_ids), chunk_size):
        chunk = unique_ids[i:i + chunk_size]
        id_params = '&'.join(f'id={mid}' for mid in chunk)
        url = f"https://gamma-api.polymarket.com/markets?{id_params}&limit={chunk_size}"
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                markets = json.loads(resp.read().decode('utf-8'))
                for m in markets:
                    try:
                        outcome_prices = json.loads(m.get('outcomePrices', '[]') or '[]')
                        yes_price = float(outcome_prices[0]) if outcome_prices else None
                        prices[m['id']] = yes_price
                    except (ValueError, TypeError, json.JSONDecodeError):
                        pass
        except Exception as e:
            print(f"[prices] fetch error: {e}")
    return prices


def _fetch_resolved_markets():
    """Fetch resolved markets from Gamma API with pagination.
    Includes ALL resolved markets (both Yes and No outcomes) with valid dates.
    """
    all_markets = []
    offset = 0
    limit = 500
    max_markets = 50000

    while len(all_markets) < max_markets:
        url = (
            f"https://gamma-api.polymarket.com/markets?closed=true"
            f"&limit={limit}&offset={offset}"
            f"&order=volume&ascending=false"
        )
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                markets = json.loads(response.read().decode('utf-8'))
                if not markets:
                    break
                all_markets.extend(markets)
                if len(markets) < limit:
                    break
                offset += limit
                import time as _time
                _time.sleep(0.2)
        except Exception as e:
            print(f"Error fetching resolved markets at offset {offset}: {e}")
            break

    # Filter to resolved markets with valid dates and CLOB token IDs
    resolved = []
    for m in all_markets:
        try:
            prices = json.loads(m.get('outcomePrices', '[]'))
            clob_ids = json.loads(m.get('clobTokenIds', '[]'))
            volume = float(m.get('volume', 0) or 0)
            end_date = m.get('endDate', '') or ''
            start_date = m.get('startDate', '') or ''
            resolution_time, resolution_source = _pick_resolution_time(m)

            # Must have valid dates and CLOB IDs
            if not resolution_time or not start_date or not clob_ids:
                continue

            # Skip very old markets (pre-CLOB, no price history)
            if resolution_time < '2023-01-01':
                continue

            # Minimum volume filter
            if volume < 1000:
                continue

            # Determine which outcome resolved (Yes or No)
            resolved_outcome = None
            if prices and len(prices) >= 2:
                p0 = float(prices[0])
                p1 = float(prices[1])
                if p0 > 0.95:
                    resolved_outcome = "Yes"
                elif p1 > 0.95:
                    resolved_outcome = "No"

            resolved.append({
                'id': m['id'],
                'question': m.get('question', ''),
                'slug': m.get('slug', ''),
                'volume': volume,
                'clobTokenIds': clob_ids,
                'startDate': start_date,
                'endDate': end_date,
                'closedTime': m.get('closedTime', '') or '',
                'umaEndDate': m.get('umaEndDate', '') or '',
                'resolutionTime': resolution_time,
                'resolutionSource': resolution_source,
                'resolved_outcome': resolved_outcome,
            })
        except (ValueError, TypeError, json.JSONDecodeError):
            continue

    # Sort by volume descending (most liquid first)
    resolved.sort(key=lambda x: x.get('volume', 0), reverse=True)

    print(f"[Backtest] Cached {len(resolved)} resolved markets (from {len(all_markets)} closed)")
    return resolved


def _get_resolved_markets_cache():
    """Get resolved markets with caching."""
    global _resolved_markets_cache, _resolved_markets_cache_time
    import time as _time
    now = _time.time()
    if _resolved_markets_cache is not None and (now - _resolved_markets_cache_time) < RESOLVED_CACHE_TTL:
        return _resolved_markets_cache
    with _resolved_markets_lock:
        # Re-check after acquiring lock (another thread may have populated it)
        now = _time.time()
        if _resolved_markets_cache is not None and (now - _resolved_markets_cache_time) < RESOLVED_CACHE_TTL:
            return _resolved_markets_cache
        _resolved_markets_cache = _fetch_resolved_markets()
        _resolved_markets_cache_time = now
    return _resolved_markets_cache


def _fetch_active_markets():
    """Fetch active markets from Gamma API with pagination."""
    all_markets = []
    offset = 0
    limit = 500
    max_markets = 5000

    while len(all_markets) < max_markets:
        url = (
            f"https://gamma-api.polymarket.com/markets?active=true&closed=false"
            f"&limit={limit}&offset={offset}"
            f"&order=volume&ascending=false"
        )
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                markets = json.loads(response.read().decode('utf-8'))
                if not markets:
                    break
                all_markets.extend(markets)
                if len(markets) < limit:
                    break
                offset += limit
                import time as _time
                _time.sleep(0.2)
        except Exception as e:
            print(f"Error fetching active markets at offset {offset}: {e}")
            break

    # Parse into clean format
    results = []
    for m in all_markets:
        try:
            volume = float(m.get('volume', 0) or 0)
            clob_ids = json.loads(m.get('clobTokenIds', '[]'))
            if not clob_ids:
                continue

            end_date = m.get('endDate', '') or ''
            condition_id = m.get('conditionId', '') or ''

            outcome_prices = json.loads(m.get('outcomePrices', '[]') or '[]')
            yes_prob = float(outcome_prices[0]) if outcome_prices else None

            results.append({
                'id': m['id'],
                'question': m.get('question', ''),
                'slug': m.get('slug', ''),
                'volume': volume,
                'endDate': end_date,
                'category': m.get('groupItemTitle', '') or '',
                'clobTokenIds': clob_ids,
                'conditionId': condition_id,
                'probability': yes_prob,
            })
        except (ValueError, TypeError, json.JSONDecodeError):
            continue

    results.sort(key=lambda x: x.get('volume', 0), reverse=True)
    print(f"[MarketSearch] Fetched {len(results)} active markets (from {len(all_markets)} total)")
    return results


def _get_active_markets_cache():
    """Get active markets with caching."""
    global _active_markets_cache, _active_markets_cache_time
    import time as _time
    now = _time.time()
    if _active_markets_cache is not None and (now - _active_markets_cache_time) < ACTIVE_CACHE_TTL:
        return _active_markets_cache
    with _active_markets_lock:
        now = _time.time()
        if _active_markets_cache is not None and (now - _active_markets_cache_time) < ACTIVE_CACHE_TTL:
            return _active_markets_cache
        _active_markets_cache = _fetch_active_markets()
        _active_markets_cache_time = now
    return _active_markets_cache


# Load .env file if it exists
def load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip()

load_dotenv()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
CATEGORIES = ["Politics", "Sports", "Finance", "Crypto", "Geopolitics", "Earnings", "Tech", "Culture", "World", "Economy", "Elections", "Mentions"]


class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # New REST API endpoints
        if self.path == '/api/data':
            self.handle_get_data()
        elif self.path == '/api/data/markets':
            self.handle_get_markets()
        elif self.path == '/api/data/correlations':
            self.handle_get_correlations()
        elif self.path == '/api/data/status':
            self.handle_get_status()
        elif self.path.startswith('/api/markets/search'):
            self.handle_markets_search()
        elif self.path.startswith('/api/backtest/search'):
            self.handle_backtest_search()
        # Trading endpoints
        elif self.path == '/api/trading/status':
            self.handle_trading_status()
        elif self.path == '/api/trading/positions':
            self.handle_trading_positions()
        elif self.path == '/api/trading/signals':
            self.handle_trading_signals()
        elif self.path == '/api/trading/relationships':
            self.handle_trading_relationships()
        elif self.path == '/api/trading/leaders':
            self.handle_trading_leaders()
        elif self.path == '/api/trading/balance':
            self.handle_trading_balance()
        elif self.path == '/api/trading/stream':
            self.handle_trading_stream()
        # Legacy proxy endpoints (keep for backward compatibility during transition)
        elif self.path.startswith('/api/gamma/'):
            target_path = self.path[len('/api/gamma/'):]
            target_url = f"https://gamma-api.polymarket.com/{target_path}"
            self.proxy_request(target_url)
        elif self.path.startswith('/api/clob/'):
            target_path = self.path[len('/api/clob/'):]
            target_url = f"https://clob.polymarket.com/{target_path}"
            self.proxy_request(target_url)
        else:
            # Serve static files
            super().do_GET()

    def handle_get_data(self):
        """Return complete cached dataset for client."""
        check_and_refresh()
        import random
        try:
            data = db.get_all_data()
            
            # Transform to match expected client format (network page: 50k+ only)
            nodes = []
            for market in data['markets']:
                if market['volume'] < 50000:
                    continue
                nodes.append({
                    'id': market['id'],
                    'name': market['name'],
                    'slug': market['slug'],
                    'category': market['category'],
                    'volume': market['volume'],
                    'probability': market['probability'],
                    'clobTokenId': market['clob_token_id'],
                    'history': market.get('history', []),
                    'x': random.random() * 800,  # Random initial position
                    'y': random.random() * 600
                })
            
            links = []
            for corr in data['correlations']:
                links.append({
                    'source': corr['source_id'],
                    'target': corr['target_id'],
                    'correlation': corr['correlation'],
                    'inefficiency': corr['inefficiency']
                })
            
            response = {
                'nodes': nodes,
                'links': links,
                'metadata': data['metadata']
            }
            
            self.send_json_response(response)
            
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_get_markets(self):
        """Return just the markets."""
        check_and_refresh()
        try:
            markets = db.get_all_markets()
            self.send_json_response(markets)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_get_correlations(self):
        """Return just the correlations."""
        try:
            correlations = db.get_all_correlations()
            self.send_json_response(correlations)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_get_status(self):
        """Return status and metadata."""
        try:
            last_refresh = db.get_metadata('last_refresh')
            total_markets = db.get_metadata('total_markets')
            total_correlations = db.get_metadata('total_correlations')
            
            response = {
                'last_refresh': last_refresh,
                'total_markets': int(total_markets) if total_markets else 0,
                'total_correlations': int(total_correlations) if total_correlations else 0,
                'db_path': db.DB_PATH,
                'status': 'ready' if last_refresh else 'needs_refresh'
            }
            
            self.send_json_response(response)
        except Exception as e:
            self.send_error_response(500, str(e))

    def send_json_response(self, data):
        """Send a JSON response."""
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def send_error_response(self, code, message):
        """Send an error response."""
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode('utf-8'))

    def do_POST(self):
        if self.path == '/api/classify':
            self.handle_classify()
        elif self.path == '/api/refresh':
            self.handle_manual_refresh()
        elif self.path == '/api/discover':
            self.handle_discover()
        elif self.path == '/api/backtest':
            self.handle_backtest()
        elif self.path == '/api/discover/full':
            self.handle_discover_full()
        elif self.path == '/api/trading/start':
            self.handle_trading_start()
        elif self.path == '/api/trading/stop':
            self.handle_trading_stop()
        elif self.path == '/api/trading/test-resolution':
            self.handle_test_resolution()
        else:
            self.send_error(404, "Not found")

    def handle_classify(self):
        """Classify a market into a category using OpenAI gpt-4o-mini"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            question = data.get('question', '')
            if not question:
                self.send_error_response(400, 'question is required')
                return
            if not OPENAI_API_KEY:
                self.send_error_response(500, 'OPENAI_API_KEY not configured')
                return
            
            # Call OpenAI API
            prompt = f"""Classify this prediction market question into exactly one of these categories:
{', '.join(CATEGORIES)}

Market question: "{question}"

Respond with ONLY the category name, nothing else."""

            category = call_openai_chat_text(
                messages=[{"role": "user", "content": prompt}],
                model="gpt-4o-mini",
                openai_api_key=OPENAI_API_KEY,
                timeout=45,
                payload_overrides={
                    "max_tokens": 20,
                    "temperature": 0,
                },
                max_retries=6,
            )

            # Validate category is in our list
            if category not in CATEGORIES:
                category = "Other"

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"category": category}).encode('utf-8'))
                
        except Exception as e:
            print(f"Classification error: {e}")
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e), "category": "Other"}).encode('utf-8'))

    def handle_manual_refresh(self):
        """Trigger a manual data refresh."""
        try:
            # Import and run refresh in background
            import data_worker
            threading.Thread(target=data_worker.refresh_data, daemon=True).start()

            self.send_json_response({'status': 'refresh_started'})
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_discover(self):
        """Stream discover progress as NDJSON events.
        Runs the worker in a background thread and sends keepalive pings
        every 15s to prevent Fly.io / browser from closing idle connections."""
        import queue as _queue

        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            market_id = data.get('market_id', '')
            min_volume = int(data.get('min_volume', 10000))

            if not market_id:
                self.send_error_response(400, 'market_id is required')
                return

            if not OPENAI_API_KEY:
                self.send_error_response(500, 'OPENAI_API_KEY not configured')
                return

            # Stream NDJSON
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()

            # Use a queue so we can send keepalive pings while the worker blocks on API calls
            eq = _queue.Queue()
            _SENTINEL = object()

            def _run_worker():
                try:
                    import discover_worker
                    import importlib
                    importlib.reload(discover_worker)
                    for event in discover_worker.find_followers_stream(market_id, OPENAI_API_KEY, min_volume):
                        eq.put(event)
                except Exception as exc:
                    eq.put({"type": "error", "message": str(exc)})
                finally:
                    eq.put(_SENTINEL)

            worker_thread = threading.Thread(target=_run_worker, daemon=True)
            worker_thread.start()

            KEEPALIVE_INTERVAL = 15  # seconds

            while True:
                try:
                    event = eq.get(timeout=KEEPALIVE_INTERVAL)
                except _queue.Empty:
                    # No event for 15s — send a keepalive ping to keep the connection alive
                    keepalive = json.dumps({"type": "keepalive"}) + '\n'
                    self.wfile.write(keepalive.encode('utf-8'))
                    self.wfile.flush()
                    continue

                if event is _SENTINEL:
                    break

                line = json.dumps(event) + '\n'
                self.wfile.write(line.encode('utf-8'))
                self.wfile.flush()

        except Exception as e:
            print(f"Discover error: {e}")
            import traceback
            traceback.print_exc()
            try:
                error_event = json.dumps({"type": "error", "message": str(e)}) + '\n'
                self.wfile.write(error_event.encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

    def handle_discover_full(self):
        """Stream full relationship graph generation as NDJSON events."""
        import queue as _queue

        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            top_n = int(data.get('top_n', 20))
            min_volume = int(data.get('min_volume', 50000))
            skip_existing = bool(data.get('skip_existing', True))
            market_list = data.get('market_list', None)

            # If market_list provided, insert any markets not already in DB
            # so discover worker can find them. upsert_market uses INSERT OR IGNORE
            # so existing records are never overwritten.
            if market_list:
                for m in market_list:
                    clob_ids = m.get('clobTokenIds', [])
                    db.upsert_market({
                        'id': m['id'],
                        'name': m.get('question', ''),
                        'slug': m.get('slug', ''),
                        'category': m.get('category', 'Other'),
                        'volume': m.get('volume', 0),
                        'probability': 0.5,
                        'clob_token_id': clob_ids[0] if clob_ids else '',
                        'condition_id': m.get('conditionId', ''),
                        'clob_token_id_yes': clob_ids[0] if len(clob_ids) > 0 else '',
                        'clob_token_id_no': clob_ids[1] if len(clob_ids) > 1 else '',
                    })

            if not OPENAI_API_KEY:
                self.send_error_response(500, 'OPENAI_API_KEY not configured')
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()

            eq = _queue.Queue()
            _SENTINEL = object()

            # Convert market_list to the format expected by discover_worker
            leader_markets = None
            if market_list:
                leader_markets = []
                for m in market_list:
                    clob_ids = m.get('clobTokenIds', [])
                    leader_markets.append({
                        'id': m['id'],
                        'name': m.get('question', ''),
                        'slug': m.get('slug', ''),
                        'category': m.get('category', 'Other'),
                        'volume': m.get('volume', 0),
                        'probability': 0.5,
                        'clob_token_id': clob_ids[0] if clob_ids else '',
                        'condition_id': m.get('conditionId', ''),
                    })

            def _run_worker():
                try:
                    import discover_worker
                    import importlib
                    importlib.reload(discover_worker)
                    for event in discover_worker.generate_full_graph_stream(
                        OPENAI_API_KEY, top_n, min_volume, skip_existing,
                        leader_markets=leader_markets
                    ):
                        eq.put(event)
                except Exception as exc:
                    eq.put({"type": "error", "message": str(exc)})
                finally:
                    eq.put(_SENTINEL)

            worker_thread = threading.Thread(target=_run_worker, daemon=True)
            worker_thread.start()

            KEEPALIVE_INTERVAL = 15

            while True:
                try:
                    event = eq.get(timeout=KEEPALIVE_INTERVAL)
                except _queue.Empty:
                    keepalive = json.dumps({"type": "keepalive"}) + '\n'
                    self.wfile.write(keepalive.encode('utf-8'))
                    self.wfile.flush()
                    continue

                if event is _SENTINEL:
                    break

                line = json.dumps(event) + '\n'
                self.wfile.write(line.encode('utf-8'))
                self.wfile.flush()

        except Exception as e:
            print(f"Discover full error: {e}")
            import traceback
            traceback.print_exc()
            try:
                error_event = json.dumps({"type": "error", "message": str(e)}) + '\n'
                self.wfile.write(error_event.encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

    # ── Trading endpoints ─────────────────────────────────────

    def handle_trading_status(self):
        """GET /api/trading/status — current autotrader state."""
        try:
            self.send_json_response(autotrader.status())
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_positions(self):
        """GET /api/trading/positions — recent positions."""
        try:
            positions = db.get_recent_positions(limit=500)
            self.send_json_response(positions)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_signals(self):
        """GET /api/trading/signals — recent trade signals."""
        try:
            signals = db.get_recent_signals(limit=500)
            self.send_json_response(signals)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_relationships(self):
        """GET /api/trading/relationships — active leader-follower pairs with current prices."""
        try:
            rels = db.get_active_relationships()
            prices = _fetch_market_prices([r['leader_market_id'] for r in rels] +
                                          [r['follower_market_id'] for r in rels])
            for r in rels:
                r['leader_price'] = prices.get(r['leader_market_id'])
                r['follower_price'] = prices.get(r['follower_market_id'])
            self.send_json_response(rels)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_leaders(self):
        """GET /api/trading/leaders — leader name mapping from metadata."""
        try:
            import json as _json
            raw = db.get_metadata("demo_leaders")
            leaders = _json.loads(raw) if raw else {}
            self.send_json_response(leaders)
        except Exception as e:
            self.send_json_response({})

    def handle_trading_balance(self):
        """GET /api/trading/balance — Polymarket CLOB balance."""
        try:
            result = autotrader.get_wallet_balance()
            self.send_json_response(result)
        except Exception as e:
            self.send_json_response({"balance": -1, "error": str(e)})

    def handle_trading_start(self):
        """POST /api/trading/start — start autotrader."""
        try:
            result = autotrader.start()
            self.send_json_response(result)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_stop(self):
        """POST /api/trading/stop — stop autotrader."""
        try:
            result = autotrader.stop()
            self.send_json_response(result)
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_test_resolution(self):
        """POST /api/trading/test-resolution — simulate a leader resolution.
        Body: { "leader_market_id": "...", "outcome": "YES"|"NO" }
        If no leader_market_id, returns list of available leaders to pick from."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length:
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
            else:
                data = {}

            leader_id = data.get('leader_market_id')

            if not leader_id:
                # Return available leaders
                rels = db.get_active_relationships()
                leaders = {}
                for r in rels:
                    lid = r["leader_market_id"]
                    if lid not in leaders:
                        leaders[lid] = {
                            "market_id": lid,
                            "question": r.get("leader_question", ""),
                            "follower_count": 0,
                        }
                    leaders[lid]["follower_count"] += 1
                self.send_json_response(list(leaders.values()))
                return

            outcome = data.get('outcome', 'YES').upper()
            if outcome not in ('YES', 'NO'):
                self.send_error_response(400, 'outcome must be YES or NO')
                return

            result = autotrader.simulate_resolution(leader_id, outcome)
            self.send_json_response(result)

        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_trading_stream(self):
        """GET /api/trading/stream — SSE live updates from autotrader.
        Drains autotrader.event_queue with keepalive pings every 15s.
        Closes after 60s idle (no real events) to prevent thread exhaustion."""
        import queue as _queue

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()

        KEEPALIVE = 15  # seconds
        MAX_IDLE = 60   # close after 60s with no real events
        idle_seconds = 0

        try:
            while True:
                try:
                    evt = autotrader.event_queue.get(timeout=KEEPALIVE)
                    idle_seconds = 0
                    line = json.dumps(evt) + '\n'
                    self.wfile.write(line.encode('utf-8'))
                    self.wfile.flush()
                except _queue.Empty:
                    idle_seconds += KEEPALIVE
                    if idle_seconds >= MAX_IDLE:
                        break
                    keepalive = json.dumps({"type": "keepalive"}) + '\n'
                    self.wfile.write(keepalive.encode('utf-8'))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_markets_search(self):
        """GET /api/markets/search — search active Polymarket markets with filters."""
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            min_volume = float(params.get('min_volume', [0])[0])
            min_end_date = params.get('min_end_date', [''])[0]
            max_end_date = params.get('max_end_date', [''])[0]

            all_markets = _get_active_markets_cache()

            filtered = []
            for m in all_markets:
                if m['volume'] < min_volume:
                    continue
                end_date = m.get('endDate', '') or ''
                if min_end_date and end_date and end_date < min_end_date:
                    continue
                if max_end_date and end_date and end_date > max_end_date:
                    continue
                filtered.append(m)

            self.send_json_response(filtered[:500])
        except Exception as e:
            self.send_error_response(500, str(e))

    def handle_backtest_search(self):
        """Search for resolved markets from Gamma API (cached).
        Supports:
          ?name=text — market-question name search
          ?q=text    — legacy alias for name search
        """
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            name_query = params.get('name', [''])[0].lower().strip()
            legacy_query = params.get('q', [''])[0].lower().strip()
            query = name_query or legacy_query

            resolved_markets = _get_resolved_markets_cache()

            if len(query) < 2:
                self.send_json_response([])
                return

            results = resolved_markets
            if len(query) >= 2:
                results = [
                    m for m in results
                    if query in (m.get('question') or '').lower()
                ]

            results.sort(key=lambda x: x.get('volume', 0), reverse=True)
            self.send_json_response(results[:50])

        except Exception as e:
            print(f"Backtest search error: {e}")
            self.send_error_response(500, str(e))

    def handle_backtest(self):
        """Stream backtest progress as NDJSON events."""
        import queue as _queue

        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            market_id = data.get('market_id', '')
            market_question = data.get('market_question', '')
            clob_token_id = data.get('clob_token_id', '')
            resolution_time = data.get('resolution_time', '') or data.get('end_date', '')

            if not market_id or not clob_token_id:
                self.send_error_response(400, 'market_id and clob_token_id are required')
                return

            if not OPENAI_API_KEY:
                self.send_error_response(500, 'OPENAI_API_KEY not configured')
                return

            # Stream NDJSON
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()

            eq = _queue.Queue()
            _SENTINEL = object()

            def _run_worker():
                try:
                    import backtest_worker
                    import importlib
                    importlib.reload(backtest_worker)
                    for event in backtest_worker.run_backtest_stream(
                        market_id, market_question, clob_token_id,
                        resolution_time, OPENAI_API_KEY,
                    ):
                        eq.put(event)
                except Exception as exc:
                    eq.put({"type": "error", "message": str(exc)})
                finally:
                    eq.put(_SENTINEL)

            worker_thread = threading.Thread(target=_run_worker, daemon=True)
            worker_thread.start()

            KEEPALIVE_INTERVAL = 15

            while True:
                try:
                    event = eq.get(timeout=KEEPALIVE_INTERVAL)
                except _queue.Empty:
                    keepalive = json.dumps({"type": "keepalive"}) + '\n'
                    self.wfile.write(keepalive.encode('utf-8'))
                    self.wfile.flush()
                    continue

                if event is _SENTINEL:
                    break

                line = json.dumps(event) + '\n'
                self.wfile.write(line.encode('utf-8'))
                self.wfile.flush()

        except Exception as e:
            print(f"Backtest error: {e}")
            import traceback
            traceback.print_exc()
            try:
                error_event = json.dumps({"type": "error", "message": str(e)}) + '\n'
                self.wfile.write(error_event.encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

    def do_DELETE(self):
        if self.path == '/api/trading/relationships':
            self.handle_delete_relationships()
        else:
            self.send_error(404, "Not found")

    def handle_delete_relationships(self):
        """DELETE /api/trading/relationships — remove relationships.
        Body (optional): {"leader_market_ids": ["id1", ...]}
        No body or empty list → delete all.
        """
        try:
            ids = []
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 0:
                body = json.loads(self.rfile.read(content_length).decode('utf-8'))
                ids = body.get('leader_market_ids', [])
            if ids:
                for lid in ids:
                    db.delete_relationship_by_leader(lid)
            else:
                db.delete_all_relationships()
            self.send_json_response({"ok": True})
        except Exception as e:
            self.send_error_response(500, str(e))

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def proxy_request(self, target_url):
        try:
            print(f"Proxying to: {target_url}")
            req = urllib.request.Request(
                target_url, 
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
            )
            
            with urllib.request.urlopen(req) as response:
                self.send_response(response.status)
                for header, value in response.headers.items():
                    if header.lower() not in ['content-encoding', 'content-length', 'transfer-encoding', 'connection']:
                         self.send_header(header, value)
                
                if 'application/json' in response.headers.get('Content-Type', ''):
                    self.send_header('Content-Type', 'application/json')

                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(response.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            print(f"Proxy Error: {e}")
        except Exception as e:
            self.send_error(500, str(e))
            print(f"Proxy Exception: {e}")


REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL", 600))
_refresh_lock = threading.Lock()
_refresh_in_progress = False


def check_and_refresh():
    """Check if data is stale and trigger a background refresh if needed.
    Called on user requests — no refresh happens if nobody visits the site.
    Set AUTO_REFRESH=1 env var to enable (disabled by default)."""
    global _refresh_in_progress

    if not os.environ.get("AUTO_REFRESH"):
        return

    if _refresh_in_progress:
        return

    last_refresh = db.get_metadata('last_refresh')
    if last_refresh:
        try:
            last_time = datetime.fromisoformat(last_refresh)
            age_seconds = (datetime.now() - last_time).total_seconds()
            if age_seconds <= REFRESH_INTERVAL:
                return  # Data is still fresh
            print(f"[Worker] Data is {int(age_seconds)}s old (> {REFRESH_INTERVAL}s), refreshing...")
        except Exception:
            pass  # Can't parse — refresh to be safe
    else:
        print("[Worker] No data yet, running initial refresh...")

    with _refresh_lock:
        if _refresh_in_progress:
            return
        _refresh_in_progress = True

    def do_refresh():
        global _refresh_in_progress
        try:
            import data_worker
            data_worker.refresh_data()
        except Exception as e:
            print(f"[Worker] Error during refresh: {e}")
        finally:
            _refresh_in_progress = False

    threading.Thread(target=do_refresh, daemon=True).start()


if __name__ == '__main__':
    # Initialize database
    db.init_db()

    # Start HTTP server (data refreshes on-demand when users visit).
    # On Windows, allowing address reuse can let multiple processes bind the same
    # port and cause intermittent connection resets in browsers.
    socketserver.ThreadingTCPServer.allow_reuse_address = (os.name != "nt")
    try:
        server = socketserver.ThreadingTCPServer(("", PORT), ProxyHTTPRequestHandler)
    except OSError as e:
        if e.errno in (errno.EADDRINUSE, 10048):
            print(f"Port {PORT} is already in use. Stop the other server process and retry.")
            sys.exit(1)
        raise
    with server as httpd:
        # Pre-fetch resolved markets so first search is instant
        _threading.Thread(target=_get_resolved_markets_cache, daemon=True).start()

        # Auto-start autotrader if TRADING_ENABLED and graph exists
        import config as _config
        if _config.TRADING_ENABLED:
            rels = db.get_active_relationships()
            if rels:
                print(f"[Autotrader] TRADING_ENABLED=true, {len(rels)} relationships found — auto-starting")
                try:
                    autotrader.start()
                except Exception as e:
                    print(f"[Autotrader] Auto-start failed: {e}")
            else:
                print("[Autotrader] TRADING_ENABLED=true but no relationships in DB — skipping auto-start")
                print("[Autotrader] Generate a relationship graph via the UI first, then restart")

        print(f"Serving at http://localhost:{PORT}")
        print(f"REST API available at /api/data, /api/data/status")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()
