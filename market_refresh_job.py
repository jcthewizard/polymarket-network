import urllib.request
import urllib.error
import json
import math
import time
from datetime import datetime
from typing import List, Dict, Tuple
import os
from dotenv import load_dotenv
import requests

load_dotenv()

SUPABASE_URL = os.getenv('VITE_SUPABASE_URL')
SUPABASE_KEY = os.getenv('VITE_SUPABASE_SUPABASE_ANON_KEY')

GAMMA_API_URL = 'https://gamma-api.polymarket.com/markets'
CLOB_API_URL = 'https://clob.polymarket.com/prices-history'

class MarketDataFetcher:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })

    def fetch_markets(self) -> List[Dict]:
        """Fetch all active markets from Gamma API."""
        print("[REFRESH] Starting market fetch...")
        all_markets = []
        limit_per_request = 500
        offset = 0

        while True:
            params = {
                'active': 'true',
                'closed': 'false',
                'order': 'volume',
                'ascending': 'false',
                'limit': limit_per_request,
                'offset': offset
            }

            try:
                response = self.session.get(GAMMA_API_URL, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()

                if not data or len(data) == 0:
                    print("[REFRESH] No more markets returned.")
                    break

                all_markets.extend(data)
                offset += len(data)
                print(f"[REFRESH] Fetched batch of {len(data)} markets. Total: {len(all_markets)}")

                if len(data) < limit_per_request:
                    break
            except Exception as e:
                print(f"[REFRESH] Error fetching markets: {e}")
                break

        all_markets.sort(key=lambda m: m.get('volume', 0) or 0, reverse=True)
        return self._filter_markets(all_markets)

    def _filter_markets(self, markets: List[Dict]) -> List[Dict]:
        """Filter markets by volume and probability."""
        filtered = []
        for m in markets:
            if not m.get('volume') or m['volume'] < 100000:
                continue

            try:
                if not m.get('outcomePrices'):
                    continue
                prices = json.loads(m['outcomePrices']) if isinstance(m['outcomePrices'], str) else m['outcomePrices']
                prob = float(prices[0])
                if prob >= 0.05 and prob <= 0.95:
                    filtered.append(m)
            except:
                continue

        print(f"[REFRESH] Filtered {len(markets)} markets down to {len(filtered)} (Vol > 100k, 5% < p < 95%)")
        return filtered[:1000]

    def fetch_market_history(self, clob_token_id: str) -> List[Dict]:
        """Fetch price history for a market."""
        try:
            params = {'market': clob_token_id, 'interval': 'max'}
            response = self.session.get(CLOB_API_URL, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            return data.get('history', [])
        except Exception as e:
            print(f"[REFRESH] Error fetching history for {clob_token_id}: {e}")
            return []

    def prepare_market_nodes(self, markets: List[Dict]) -> Tuple[List[Dict], Dict]:
        """Prepare market nodes and history map."""
        nodes = []
        history_map = {}
        batch_size = 10
        delay_ms = 50

        for i in range(0, len(markets), batch_size):
            batch = markets[i:i + batch_size]
            print(f"[REFRESH] Processing batch {i // batch_size + 1}...")

            for m in batch:
                try:
                    clob_token_id = None
                    if isinstance(m.get('clobTokenIds'), str):
                        try:
                            tokens = json.loads(m['clobTokenIds'])
                            clob_token_id = tokens[0] if tokens else None
                        except:
                            continue
                    elif isinstance(m.get('clobTokenIds'), list):
                        clob_token_id = m['clobTokenIds'][0] if m['clobTokenIds'] else None

                    if not clob_token_id:
                        continue

                    history = self.fetch_market_history(clob_token_id)
                    if not history or len(history) < 10:
                        continue

                    history_map[m['id']] = history

                    prob = float(history[-1]['p'])
                    if prob > 1:
                        prob = prob / 100
                    prob = max(0, min(1, prob))

                    node = {
                        'market_id': m['id'],
                        'question': m.get('question', ''),
                        'slug': m.get('slug', ''),
                        'category': m.get('tags', ['Other'])[0] if m.get('tags') else 'Other',
                        'volume': m.get('volume', 0),
                        'probability': prob,
                        'clob_token_id': clob_token_id
                    }
                    nodes.append(node)
                except Exception as e:
                    print(f"[REFRESH] Error processing market {m.get('id')}: {e}")
                    continue

            if i + batch_size < len(markets):
                time.sleep(delay_ms / 1000.0)

        print(f"[REFRESH] Prepared {len(nodes)} nodes with history data")
        return nodes, history_map

    def calculate_correlations(self, nodes: List[Dict], history_map: Dict) -> List[Dict]:
        """Calculate correlations between markets."""
        print("[REFRESH] Calculating correlations...")
        correlations = []

        for i in range(len(nodes)):
            for j in range(i + 1, len(nodes)):
                node_a = nodes[i]
                node_b = nodes[j]

                history_a = history_map.get(node_a['market_id'], [])
                history_b = history_map.get(node_b['market_id'], [])

                if not history_a or not history_b:
                    continue

                prices_a, prices_b = self._align_by_timestamp(history_a, history_b)

                if len(prices_a) < 10:
                    continue

                returns_a = self._calculate_log_returns(prices_a)
                returns_b = self._calculate_log_returns(prices_b)

                if len(returns_a) < 9:
                    continue

                correlation = self._calculate_correlation(returns_a, returns_b)

                if abs(correlation) > 0.5:
                    inefficiency = "High" if abs(correlation) > 0.6 and abs(node_a['probability'] - node_b['probability']) > 0.3 else "Low"

                    correlations.append({
                        'source_market_id': node_a['market_id'],
                        'target_market_id': node_b['market_id'],
                        'correlation': correlation,
                        'is_inverse': correlation < 0,
                        'inefficiency': inefficiency
                    })

        print(f"[REFRESH] Found {len(correlations)} correlations")
        return correlations

    def _align_by_timestamp(self, history_a: List[Dict], history_b: List[Dict]) -> Tuple[List[float], List[float]]:
        """Align price histories by timestamp."""
        map_a = {h['t']: float(h['p']) for h in history_a}
        map_b = {h['t']: float(h['p']) for h in history_b}
        common_times = sorted(set(map_a.keys()) & set(map_b.keys()))
        return [map_a[t] for t in common_times], [map_b[t] for t in common_times]

    def _calculate_log_returns(self, prices: List[float]) -> List[float]:
        """Calculate log returns from prices."""
        returns = []
        for i in range(1, len(prices)):
            if prices[i - 1] > 0:
                returns.append(math.log(prices[i] / prices[i - 1]))
        return returns

    def _calculate_correlation(self, series_a: List[float], series_b: List[float]) -> float:
        """Calculate Pearson correlation."""
        n = len(series_a)
        if n < 2:
            return 0.0

        mean_a = sum(series_a) / n
        mean_b = sum(series_b) / n

        cov = sum((series_a[i] - mean_a) * (series_b[i] - mean_b) for i in range(n)) / (n - 1)
        var_a = sum((x - mean_a) ** 2 for x in series_a) / (n - 1)
        var_b = sum((x - mean_b) ** 2 for x in series_b) / (n - 1)

        if var_a == 0 or var_b == 0:
            return 0.0

        return cov / (math.sqrt(var_a) * math.sqrt(var_b))


class SupabaseDataStore:
    def __init__(self):
        self.base_url = SUPABASE_URL
        self.headers = {
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        }

    def clear_old_data(self):
        """Clear old market data before inserting new data."""
        try:
            response = requests.delete(
                f'{self.base_url}/rest/v1/market_correlations',
                headers=self.headers
            )
            response = requests.delete(
                f'{self.base_url}/rest/v1/market_history',
                headers=self.headers
            )
            response = requests.delete(
                f'{self.base_url}/rest/v1/markets',
                headers=self.headers
            )
            print("[REFRESH] Cleared old data")
        except Exception as e:
            print(f"[REFRESH] Error clearing old data: {e}")

    def store_markets(self, nodes: List[Dict]) -> bool:
        """Store market nodes in database."""
        try:
            data = [
                {
                    'market_id': n['market_id'],
                    'question': n['question'],
                    'slug': n['slug'],
                    'category': n['category'],
                    'volume': float(n['volume']),
                    'probability': float(n['probability']),
                    'clob_token_id': n['clob_token_id']
                }
                for n in nodes
            ]

            response = requests.post(
                f'{self.base_url}/rest/v1/markets',
                headers=self.headers,
                json=data
            )
            print(f"[REFRESH] Stored {len(nodes)} markets: {response.status_code}")
            return response.status_code in [200, 201]
        except Exception as e:
            print(f"[REFRESH] Error storing markets: {e}")
            return False

    def store_correlations(self, correlations: List[Dict]) -> bool:
        """Store correlations in database."""
        try:
            data = [
                {
                    'source_market_id': c['source_market_id'],
                    'target_market_id': c['target_market_id'],
                    'correlation': float(c['correlation']),
                    'is_inverse': c['is_inverse'],
                    'inefficiency': c['inefficiency']
                }
                for c in correlations
            ]

            response = requests.post(
                f'{self.base_url}/rest/v1/market_correlations',
                headers=self.headers,
                json=data
            )
            print(f"[REFRESH] Stored {len(correlations)} correlations: {response.status_code}")
            return response.status_code in [200, 201]
        except Exception as e:
            print(f"[REFRESH] Error storing correlations: {e}")
            return False

    def log_refresh(self, status: str, markets_count: int, correlations_count: int, error_msg: str = None):
        """Log the refresh job execution."""
        try:
            data = {
                'status': status,
                'markets_processed': markets_count,
                'correlations_found': correlations_count,
                'error_message': error_msg,
                'started_at': datetime.utcnow().isoformat() + 'Z',
                'completed_at': datetime.utcnow().isoformat() + 'Z'
            }

            response = requests.post(
                f'{self.base_url}/rest/v1/data_refresh_log',
                headers=self.headers,
                json=data
            )
            print(f"[REFRESH] Logged refresh: {response.status_code}")
        except Exception as e:
            print(f"[REFRESH] Error logging refresh: {e}")


def run_refresh_job():
    """Main refresh job execution."""
    print(f"\n[REFRESH] Starting market data refresh at {datetime.utcnow()}")

    fetcher = MarketDataFetcher()
    store = SupabaseDataStore()

    try:
        markets = fetcher.fetch_markets()
        if not markets:
            print("[REFRESH] No markets fetched, aborting")
            store.log_refresh('failed', 0, 0, 'No markets fetched')
            return

        nodes, history_map = fetcher.prepare_market_nodes(markets)
        if not nodes:
            print("[REFRESH] No nodes prepared, aborting")
            store.log_refresh('failed', 0, 0, 'No nodes prepared')
            return

        correlations = fetcher.calculate_correlations(nodes, history_map)

        store.clear_old_data()
        store.store_markets(nodes)
        store.store_correlations(correlations)

        store.log_refresh('completed', len(nodes), len(correlations))
        print(f"[REFRESH] Completed successfully: {len(nodes)} markets, {len(correlations)} correlations")

    except Exception as e:
        print(f"[REFRESH] Error during refresh: {e}")
        store.log_refresh('failed', 0, 0, str(e))


if __name__ == '__main__':
    run_refresh_job()
