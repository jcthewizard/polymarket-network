"""
Background data worker for Polymarket data refresh.
Fetches market data from Polymarket API, classifies with LLM, calculates correlations,
and stores everything in SQLite.
"""

import os
import json
import time
import math
import urllib.request
import urllib.error
from datetime import datetime
from typing import List, Dict, Any, Optional

import database as db

# Load environment variables
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

# Configuration
REFRESH_INTERVAL_SECONDS = int(os.environ.get("REFRESH_INTERVAL", 600))  # 10 minutes default
MIN_VOLUME = 100000  # Minimum volume to include
MIN_VARIANCE = 0.001  # Minimum variance for correlation
CORRELATION_THRESHOLD = 0.5  # Minimum correlation to create link
MAX_LINKS_PER_NODE = 5  # Maximum connections per node


def log(message: str):
    """Log with timestamp."""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")


def fetch_markets() -> List[Dict]:
    """Fetch ALL markets from Polymarket Gamma API using pagination."""
    all_markets = []
    offset = 0
    limit = 500  # API max per request
    
    while True:
        url = f"https://gamma-api.polymarket.com/markets?active=true&closed=false&limit={limit}&offset={offset}"
        
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                markets = json.loads(response.read().decode('utf-8'))
                
                if not markets:
                    break  # No more markets
                
                all_markets.extend(markets)
                
                if len(markets) < limit:
                    break  # Last page
                
                offset += limit
                time.sleep(0.2)  # Small delay between requests
                
        except Exception as e:
            log(f"Error fetching markets at offset {offset}: {e}")
            break
    
    log(f"Fetched {len(all_markets)} markets from API")
    return all_markets


def fetch_market_history(clob_token_id: str) -> Optional[List[Dict]]:
    """Fetch price history for a market."""
    url = f"https://clob.polymarket.com/prices-history?market={clob_token_id}&interval=1d&fidelity=60"
    
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode('utf-8'))
            return data.get('history', [])
    except Exception as e:
        return None


def classify_with_llm(question: str) -> str:
    """Classify a market question using OpenAI gpt-4o-mini."""
    if not OPENAI_API_KEY:
        return "Other"
    
    prompt = f"""Classify this prediction market question into exactly one of these categories:
{', '.join(CATEGORIES)}

Market question: "{question}"

Respond with ONLY the category name, nothing else."""

    payload = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 20,
        "temperature": 0
    }
    
    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {OPENAI_API_KEY}'
            }
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode('utf-8'))
            category = result['choices'][0]['message']['content'].strip()
            
            if category in CATEGORIES:
                return category
    except Exception as e:
        log(f"LLM classification error: {e}")
    
    return "Other"


def calculate_log_returns(prices: List[float]) -> List[float]:
    """Calculate log returns from price series."""
    if len(prices) < 2:
        return []
    
    returns = []
    for i in range(1, len(prices)):
        prev_price = max(prices[i-1], 0.001)
        curr_price = max(prices[i], 0.001)
        returns.append(math.log(curr_price / prev_price))
    
    return returns


def calculate_variance(data: List[float]) -> float:
    """Calculate variance of a data series."""
    if not data:
        return 0
    mean = sum(data) / len(data)
    return sum((x - mean) ** 2 for x in data) / len(data)


def calculate_correlation(x: List[float], y: List[float]) -> float:
    """Calculate Pearson correlation coefficient."""
    n = len(x)
    if n != len(y) or n == 0:
        return 0
    
    sum_x = sum(x)
    sum_y = sum(y)
    sum_xy = sum(xi * yi for xi, yi in zip(x, y))
    sum_x2 = sum(xi ** 2 for xi in x)
    sum_y2 = sum(yi ** 2 for yi in y)
    
    numerator = n * sum_xy - sum_x * sum_y
    denominator = math.sqrt((n * sum_x2 - sum_x ** 2) * (n * sum_y2 - sum_y ** 2))
    
    if denominator == 0:
        return 0
    
    correlation = numerator / denominator
    return max(-1, min(1, correlation))


def align_by_timestamp(history_a: List[Dict], history_b: List[Dict]) -> tuple:
    """Align two price histories by timestamp."""
    map_b = {point['t']: point['p'] for point in history_b}
    
    prices_a = []
    prices_b = []
    
    for point in history_a:
        if point['t'] in map_b:
            prices_a.append(point['p'])
            prices_b.append(map_b[point['t']])
    
    return prices_a, prices_b


def refresh_data():
    """Main function to refresh all data."""
    log("Starting data refresh...")
    start_time = time.time()
    
    # 1. Cache existing categories so we don't have to re-classify
    category_cache = db.get_all_categories()
    log(f"Cached {len(category_cache)} existing categories")
    
    # 2. Fetch markets from API
    raw_markets = fetch_markets()
    if not raw_markets:
        log("No markets fetched, aborting refresh.")
        return
    
    # 3. Clear old markets (will be replaced with fresh data)
    db.clear_markets()
    db.clear_correlations()
    
    # 4. Filter markets by volume and probability
    markets = []
    for m in raw_markets:
        try:
            volume = float(m.get('volume', 0) or 0)
            if volume >= MIN_VOLUME:
                # Parse probability
                prices_str = m.get('outcomePrices', '[]')
                prices = json.loads(prices_str) if isinstance(prices_str, str) else prices_str
                prob = float(prices[0]) if prices else 0.5
                if prob > 1:
                    prob = prob / 100
                prob = max(0, min(1, prob))
                
                # Filter out settled markets (prob < 5% or > 95%)
                if prob < 0.05 or prob > 0.95:
                    continue
                
                # Parse clob token id
                clob_str = m.get('clobTokenIds', '[]')
                clob_ids = json.loads(clob_str) if isinstance(clob_str, str) else clob_str
                clob_token_id = clob_ids[0] if clob_ids else None
                
                if clob_token_id:
                    markets.append({
                        'id': m['id'],
                        'name': m['question'],
                        'slug': m.get('slug', ''),
                        'volume': volume,
                        'probability': prob,
                        'clob_token_id': clob_token_id
                    })
        except Exception as e:
            continue
    
    log(f"Filtered to {len(markets)} markets with volume >= {MIN_VOLUME} and 5% < prob < 95%")
    
    # 3. Fetch price history and store markets
    history_map = {}  # market_id -> history
    
    for i, market in enumerate(markets):
        # Check if already has category in cache
        if market['id'] in category_cache:
            market['category'] = category_cache[market['id']]
        else:
            # Classify with LLM
            market['category'] = classify_with_llm(market['name'])
            log(f"  Classified '{market['name'][:50]}...' as {market['category']}")
        
        # Upsert market
        db.upsert_market(market)
        
        # Fetch history
        history = fetch_market_history(market['clob_token_id'])
        if history and len(history) >= 10:
            db.upsert_price_history(market['id'], history)
            history_map[market['id']] = history
        
        if (i + 1) % 50 == 0:
            log(f"  Processed {i + 1}/{len(markets)} markets...")
        
        # Small delay to avoid rate limiting
        time.sleep(0.1)
    
    log(f"Stored {len(markets)} markets with {len(history_map)} having valid history")
    
    # 4. Calculate correlations
    log("Calculating correlations...")
    db.clear_correlations()
    
    market_ids = list(history_map.keys())
    candidate_links = []
    adjacency = {mid: [] for mid in market_ids}
    
    for i in range(len(market_ids)):
        for j in range(i + 1, len(market_ids)):
            id_a = market_ids[i]
            id_b = market_ids[j]
            
            history_a = history_map[id_a]
            history_b = history_map[id_b]
            
            prices_a, prices_b = align_by_timestamp(history_a, history_b)
            
            if len(prices_a) < 10:
                continue
            
            returns_a = calculate_log_returns(prices_a)
            returns_b = calculate_log_returns(prices_b)
            
            if len(returns_a) < 9:
                continue
            
            # Stagnant market filter
            var_a = calculate_variance(returns_a)
            var_b = calculate_variance(returns_b)
            
            if var_a < MIN_VARIANCE or var_b < MIN_VARIANCE:
                continue
            
            correlation = calculate_correlation(returns_a, returns_b)
            
            if abs(correlation) > CORRELATION_THRESHOLD:
                # Get market data for inefficiency calculation
                market_a = next((m for m in markets if m['id'] == id_a), None)
                market_b = next((m for m in markets if m['id'] == id_b), None)
                
                inefficiency = "Low"
                if market_a and market_b:
                    prob_diff = abs(market_a['probability'] - market_b['probability'])
                    if abs(correlation) > 0.6 and prob_diff > 0.3:
                        inefficiency = "High"
                
                candidate_links.append({
                    'source': id_a,
                    'target': id_b,
                    'correlation': correlation,
                    'inefficiency': inefficiency
                })
                adjacency[id_a].append(candidate_links[-1])
                adjacency[id_b].append(candidate_links[-1])
    
    # Limit links per node
    links_added = set()
    for mid in market_ids:
        node_links = sorted(adjacency[mid], key=lambda x: abs(x['correlation']), reverse=True)
        for link in node_links[:MAX_LINKS_PER_NODE]:
            link_key = tuple(sorted([link['source'], link['target']]))
            if link_key not in links_added:
                db.upsert_correlation(link['source'], link['target'], link['correlation'], link['inefficiency'])
                links_added.add(link_key)
    
    log(f"Stored {len(links_added)} correlations")
    
    # 5. Update metadata
    db.set_metadata('last_refresh', datetime.now().isoformat())
    db.set_metadata('total_markets', str(len(markets)))
    db.set_metadata('total_correlations', str(len(links_added)))
    
    # 6. Cleanup old data
    db.cleanup_old_history(days=30)
    
    elapsed = time.time() - start_time
    log(f"Data refresh complete in {elapsed:.1f} seconds")


def run_worker():
    """Run the worker in a loop."""
    log(f"Starting data worker (refresh every {REFRESH_INTERVAL_SECONDS} seconds)")
    
    while True:
        try:
            refresh_data()
        except Exception as e:
            log(f"Error during refresh: {e}")
            import traceback
            traceback.print_exc()
        
        log(f"Sleeping for {REFRESH_INTERVAL_SECONDS} seconds...")
        time.sleep(REFRESH_INTERVAL_SECONDS)


if __name__ == '__main__':
    # Run once if called directly
    refresh_data()
