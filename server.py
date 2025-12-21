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
import time
from datetime import datetime

import database as db

PORT = 8000

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
        import random
        try:
            data = db.get_all_data()
            
            # Transform to match expected client format
            nodes = []
            for market in data['markets']:
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


def start_background_worker():
    """Start the data worker in a background thread."""
    import data_worker
    from datetime import datetime
    
    def worker_loop():
        refresh_interval = int(os.environ.get("REFRESH_INTERVAL", 600))
        print(f"[Worker] Starting background refresh every {refresh_interval} seconds")
        
        # Check if data is stale or missing
        last_refresh = db.get_metadata('last_refresh')
        needs_refresh = False
        
        if not last_refresh:
            print("[Worker] Database empty, running initial refresh...")
            needs_refresh = True
        else:
            # Check if last refresh is older than the interval
            try:
                last_time = datetime.fromisoformat(last_refresh)
                age_seconds = (datetime.now() - last_time).total_seconds()
                if age_seconds > refresh_interval:
                    print(f"[Worker] Data is {int(age_seconds)}s old (> {refresh_interval}s), refreshing...")
                    needs_refresh = True
                else:
                    print(f"[Worker] Data is {int(age_seconds)}s old, still fresh. Next refresh in {int(refresh_interval - age_seconds)}s")
            except Exception as e:
                print(f"[Worker] Error checking data age: {e}")
                needs_refresh = True
        
        if needs_refresh:
            data_worker.refresh_data()
        
        while True:
            time.sleep(refresh_interval)
            try:
                data_worker.refresh_data()
            except Exception as e:
                print(f"[Worker] Error during refresh: {e}")
    
    thread = threading.Thread(target=worker_loop, daemon=True)
    thread.start()
    return thread


if __name__ == '__main__':
    # Initialize database
    db.init_db()
    
    # Start background worker
    start_background_worker()
    
    # Start HTTP server
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), ProxyHTTPRequestHandler) as httpd:
        print(f"Serving at http://localhost:{PORT}")
        print(f"REST API available at /api/data, /api/data/status")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()
