import http.server
import socketserver
import urllib.request
import urllib.error
import json
import os
import sys

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
        if self.path.startswith('/api/gamma/'):
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

    def do_POST(self):
        if self.path == '/api/classify':
            self.handle_classify()
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

