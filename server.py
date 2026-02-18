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
import threading
from datetime import datetime

import database as db
from urllib.parse import urlparse, parse_qs

PORT = 8000

# ── Resolved markets cache (for backtest search) ──────────────
_resolved_markets_cache = None
_resolved_markets_cache_time = 0
RESOLVED_CACHE_TTL = 600  # 10 minutes


def _fetch_resolved_markets():
    """Fetch resolved markets from Gamma API with pagination.
    Includes ALL resolved markets (both Yes and No outcomes) with valid dates.
    """
    all_markets = []
    offset = 0
    limit = 500
    max_markets = 4000  # Fetch more to ensure good date coverage

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

            # Must have valid dates and CLOB IDs
            if not end_date or not start_date or not clob_ids:
                continue

            # Skip very old markets (pre-CLOB, no price history)
            if end_date < '2023-01-01':
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

            if resolved_outcome is None:
                continue

            resolved.append({
                'id': m['id'],
                'question': m.get('question', ''),
                'slug': m.get('slug', ''),
                'volume': volume,
                'clobTokenIds': clob_ids,
                'startDate': start_date,
                'endDate': end_date,
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
    _resolved_markets_cache = _fetch_resolved_markets()
    _resolved_markets_cache_time = now
    return _resolved_markets_cache

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
        elif self.path.startswith('/api/backtest/search'):
            self.handle_backtest_search()
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
        else:
            self.send_error(404, "Not found")

    def handle_classify(self):
        """Classify a market into a category using OpenAI gpt-4o-mini"""
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            question = data.get('question', '')
            
            # Call OpenAI API
            prompt = f"""Classify this prediction market question into exactly one of these categories:
{', '.join(CATEGORIES)}

Market question: "{question}"

Respond with ONLY the category name, nothing else."""

            openai_payload = {
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 20,
                "temperature": 0
            }
            
            req = urllib.request.Request(
                "https://api.openai.com/v1/chat/completions",
                data=json.dumps(openai_payload).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {OPENAI_API_KEY}'
                }
            )
            
            with urllib.request.urlopen(req) as response:
                result = json.loads(response.read().decode('utf-8'))
                category = result['choices'][0]['message']['content'].strip()
                
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

    def handle_backtest_search(self):
        """Search for resolved markets from Gamma API (cached).
        Supports:
          ?q=text      — keyword search (legacy)
          ?date=YYYY-MM-DD — date-based: markets active on that date
        """
        try:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            query = params.get('q', [''])[0].lower().strip()
            date_str = params.get('date', [''])[0].strip()

            resolved_markets = _get_resolved_markets_cache()

            if date_str:
                # Date-based search: return markets where startDate <= date <= endDate
                results = []
                for m in resolved_markets:
                    s = (m.get('startDate') or '')[:10]
                    e = (m.get('endDate') or '')[:10]
                    if s and e and s <= date_str <= e:
                        results.append(m)
                # Sort by volume descending
                results.sort(key=lambda x: x.get('volume', 0), reverse=True)
                self.send_json_response(results[:50])
            elif len(query) >= 2:
                results = [
                    m for m in resolved_markets
                    if query in m['question'].lower()
                ][:20]
                self.send_json_response(results)
            else:
                self.send_json_response([])

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
            end_date = data.get('end_date', '')

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
                        end_date, OPENAI_API_KEY,
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

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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
    Called on user requests — no refresh happens if nobody visits the site."""
    global _refresh_in_progress

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

    # Start HTTP server (data refreshes on-demand when users visit)
    server = socketserver.ThreadingTCPServer(("", PORT), ProxyHTTPRequestHandler)
    server.allow_reuse_address = True
    with server as httpd:
        print(f"Serving at http://localhost:{PORT}")
        print(f"REST API available at /api/data, /api/data/status")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()
