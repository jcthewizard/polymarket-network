import urllib.request
import json

token_id = "25317827197900203707042520733688657024351801176641188094158609892850959281182"
url = f"https://clob.polymarket.com/prices-history?market={token_id}&interval=1d"

req = urllib.request.Request(
    url, 
    headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
)

try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode())
        print("History sample:")
        for item in data.get('history', [])[:5]:
            print(item)
except Exception as e:
    print(f"Error: {e}")
