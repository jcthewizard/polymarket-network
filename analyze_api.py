import urllib.request
import json

def analyze_keys(data, prefix=""):
    keys = set()
    if isinstance(data, dict):
        for k, v in data.items():
            keys.add(f"{prefix}{k}")
            keys.update(analyze_keys(v, f"{prefix}{k}."))
    elif isinstance(data, list) and len(data) > 0:
        # Analyze first few items in list
        for item in data[:3]:
            keys.update(analyze_keys(item, prefix))
    return keys

try:
    url = "http://localhost:8000/api/gamma/markets?active=true&closed=false&order=volume&ascending=false&limit=20"
    with urllib.request.urlopen(url) as response:
        data = json.loads(response.read().decode())
        
        print(f"Fetched {len(data)} markets.")
        
        all_keys = analyze_keys(data)
        
        print("\nPossible category-related keys:")
        for k in sorted(all_keys):
            if any(x in k.lower() for x in ['cat', 'tag', 'type', 'group', 'series', 'slug']):
                print(k)
                
        # Check if any market has 'tags'
        markets_with_tags = [m for m in data if 'tags' in m]
        print(f"\nMarkets with 'tags' field: {len(markets_with_tags)}")
        
        # Check values for some interesting keys
        print("\nSample values for 'groupItemTitle':")
        print(set(m.get('groupItemTitle') for m in data[:10]))
        
        print("\nSample values for 'events.series.slug':")
        for m in data[:5]:
            if 'events' in m:
                for e in m['events']:
                    if 'series' in e:
                        for s in e['series']:
                            print(s.get('slug'))

except Exception as e:
    print(f"Error: {e}")
