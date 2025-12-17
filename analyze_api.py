import requests
import json

GAMMA_API_URL = "https://gamma-api.polymarket.com/markets"

def analyze_markets():
    params = {
        "active": "true",
        "closed": "false",
        "order": "liquidity",
        "ascending": "false",
        "limit": "50",
        "offset": "0"
    }
    
    print(f"Fetching top 50 markets from {GAMMA_API_URL}...")
    try:
        response = requests.get(GAMMA_API_URL, params=params)
        response.raise_for_status()
        markets = response.json()
        
        if markets:
            print("Sample Market Data:")
            print(json.dumps(markets[0], indent=2))
            
        for m in markets[:5]:
            vol = m.get('volume', 0)
            q = m.get('question', 'N/A')
            mid = m.get('id', 'N/A')
            print(f"{mid:<10} | {vol:<15} | {q[:48]}")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    analyze_markets()
