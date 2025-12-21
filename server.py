import http.server
import socketserver
import urllib.request
import urllib.error
import sys
import json
import os
from urllib.parse import urlparse, parse_qs
import requests
from dotenv import load_dotenv

load_dotenv()

PORT = 8000
SUPABASE_URL = os.getenv('VITE_SUPABASE_URL')
SUPABASE_KEY = os.getenv('VITE_SUPABASE_SUPABASE_ANON_KEY')

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/market-data/'):
            # New cached data endpoints
            path_parts = self.path[len('/api/market-data/'):].split('?')[0]
            if path_parts == 'nodes':
                self.handle_nodes_endpoint()
            elif path_parts == 'links':
                self.handle_links_endpoint()
            elif path_parts == 'status':
                self.handle_status_endpoint()
            else:
                self.send_error(404, 'Not Found')
        elif self.path.startswith('/api/gamma/'):
            # Proxy to Gamma API
            target_path = self.path[len('/api/gamma/'):]
            target_url = f"https://gamma-api.polymarket.com/{target_path}"
            self.proxy_request(target_url)
        elif self.path.startswith('/api/clob/'):
            # Proxy to CLOB API
            target_path = self.path[len('/api/clob/'):]
            target_url = f"https://clob.polymarket.com/{target_path}"
            self.proxy_request(target_url)
        else:
            # Serve static files
            super().do_GET()

    def handle_nodes_endpoint(self):
        """Fetch market nodes from Supabase."""
        try:
            response = requests.get(
                f'{SUPABASE_URL}/rest/v1/markets?select=*',
                headers={
                    'Authorization': f'Bearer {SUPABASE_KEY}',
                    'Content-Type': 'application/json'
                },
                timeout=30
            )

            if response.status_code == 200:
                data = response.json()
                nodes = []
                for market in data:
                    nodes.append({
                        'id': market['market_id'],
                        'name': market['question'],
                        'slug': market['slug'],
                        'category': market['category'],
                        'volume': market['volume'],
                        'probability': market['probability'],
                        'clobTokenId': market['clob_token_id'],
                        'x': 0,
                        'y': 0
                    })

                self.send_json_response(nodes)
            else:
                self.send_json_response({'error': 'Failed to fetch nodes'}, 500)
        except Exception as e:
            print(f"[SERVER] Error in nodes endpoint: {e}")
            self.send_json_response({'error': str(e)}, 500)

    def handle_links_endpoint(self):
        """Fetch correlation links from Supabase."""
        try:
            response = requests.get(
                f'{SUPABASE_URL}/rest/v1/market_correlations?select=*',
                headers={
                    'Authorization': f'Bearer {SUPABASE_KEY}',
                    'Content-Type': 'application/json'
                },
                timeout=30
            )

            if response.status_code == 200:
                data = response.json()
                links = []
                for corr in data:
                    links.append({
                        'source': corr['source_market_id'],
                        'target': corr['target_market_id'],
                        'correlation': corr['correlation'],
                        'rawValue': corr['correlation'],
                        'isInverse': corr['is_inverse'],
                        'inefficiency': corr['inefficiency'],
                        'keep': True
                    })

                self.send_json_response(links)
            else:
                self.send_json_response({'error': 'Failed to fetch links'}, 500)
        except Exception as e:
            print(f"[SERVER] Error in links endpoint: {e}")
            self.send_json_response({'error': str(e)}, 500)

    def handle_status_endpoint(self):
        """Fetch the latest refresh status from Supabase."""
        try:
            response = requests.get(
                f'{SUPABASE_URL}/rest/v1/data_refresh_log?select=*&order=completed_at.desc&limit=1',
                headers={
                    'Authorization': f'Bearer {SUPABASE_KEY}',
                    'Content-Type': 'application/json'
                },
                timeout=30
            )

            if response.status_code == 200:
                data = response.json()
                if data and len(data) > 0:
                    log = data[0]
                    status = {
                        'status': log['status'],
                        'markets_processed': log['markets_processed'],
                        'correlations_found': log['correlations_found'],
                        'completed_at': log['completed_at'],
                        'error_message': log['error_message']
                    }
                    self.send_json_response(status)
                else:
                    self.send_json_response({'status': 'no_data', 'message': 'No refresh data available'})
            else:
                self.send_json_response({'error': 'Failed to fetch status'}, 500)
        except Exception as e:
            print(f"[SERVER] Error in status endpoint: {e}")
            self.send_json_response({'error': str(e)}, 500)

    def send_json_response(self, data, status_code=200):
        """Send a JSON response."""
        response_body = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # print("Debug: Sending no-cache headers") 
        super().end_headers()

    def proxy_request(self, target_url):
        try:
            print(f"Proxying to: {target_url}")
            # Create a request with a User-Agent to avoid being blocked
            req = urllib.request.Request(
                target_url, 
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
            )
            
            with urllib.request.urlopen(req) as response:
                self.send_response(response.status)
                # Forward headers
                for header, value in response.headers.items():
                    if header.lower() not in ['content-encoding', 'content-length', 'transfer-encoding', 'connection']:
                         self.send_header(header, value)
                
                # Ensure JSON content type if applicable
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

if __name__ == '__main__':
    # Allow address reuse
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), ProxyHTTPRequestHandler) as httpd:
        print(f"Serving at http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()
