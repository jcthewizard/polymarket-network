"""
SQLite database operations for Polymarket data caching.
"""

import sqlite3
import os
from datetime import datetime
from typing import List, Dict, Optional, Any

DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'polymarket.db')


def get_connection():
    """Get a database connection, creating the data directory if needed."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # Return rows as dictionaries
    return conn


def init_db():
    """Initialize the database schema."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Markets table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS markets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT,
            category TEXT DEFAULT 'Other',
            volume REAL DEFAULT 0,
            probability REAL DEFAULT 0.5,
            clob_token_id TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Price history table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            price REAL NOT NULL,
            FOREIGN KEY (market_id) REFERENCES markets(id),
            UNIQUE(market_id, timestamp)
        )
    ''')
    
    # Correlations table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS correlations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            correlation REAL NOT NULL,
            inefficiency TEXT DEFAULT 'Low',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source_id) REFERENCES markets(id),
            FOREIGN KEY (target_id) REFERENCES markets(id),
            UNIQUE(source_id, target_id)
        )
    ''')
    
    # Metadata table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    
    # Create indexes for faster queries
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_price_history_market ON price_history(market_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_correlations_source ON correlations(source_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_correlations_target ON correlations(target_id)')
    
    conn.commit()
    conn.close()
    print("Database initialized.")


def upsert_market(market: Dict[str, Any]):
    """Insert or update a market."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if market exists to preserve category if already classified
    cursor.execute('SELECT category FROM markets WHERE id = ?', (market['id'],))
    existing = cursor.fetchone()
    
    # Keep existing category if new one is 'Other' and existing is not
    category = market.get('category', 'Other')
    if existing and existing[0] and existing[0] != 'Other' and category == 'Other':
        category = existing[0]
    
    cursor.execute('''
        INSERT OR REPLACE INTO markets (id, name, slug, category, volume, probability, clob_token_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        market['id'],
        market['name'],
        market.get('slug', ''),
        category,
        market.get('volume', 0),
        market.get('probability', 0.5),
        market.get('clob_token_id', ''),
        datetime.now().isoformat()
    ))
    
    conn.commit()
    conn.close()


def upsert_price_history(market_id: str, history: List[Dict[str, Any]]):
    """Insert price history for a market (skip duplicates)."""
    if not history:
        return
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Insert with ON CONFLICT IGNORE to skip duplicates
    cursor.executemany('''
        INSERT OR IGNORE INTO price_history (market_id, timestamp, price)
        VALUES (?, ?, ?)
    ''', [(market_id, point['t'], point['p']) for point in history])
    
    conn.commit()
    conn.close()


def upsert_correlation(source_id: str, target_id: str, correlation: float, inefficiency: str):
    """Insert or update a correlation."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Delete existing correlation if any
    cursor.execute('DELETE FROM correlations WHERE source_id = ? AND target_id = ?', (source_id, target_id))
    
    cursor.execute('''
        INSERT INTO correlations (source_id, target_id, correlation, inefficiency, updated_at)
        VALUES (?, ?, ?, ?, ?)
    ''', (source_id, target_id, correlation, inefficiency, datetime.now().isoformat()))
    
    conn.commit()
    conn.close()


def get_market_category(market_id: str) -> Optional[str]:
    """Get the category of a market, or None if not classified."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT category FROM markets WHERE id = ?', (market_id,))
    row = cursor.fetchone()
    conn.close()
    
    if row and row['category'] and row['category'] != 'Other':
        return row['category']
    return None


def get_all_markets() -> List[Dict]:
    """Get all markets."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT * FROM markets ORDER BY volume DESC')
    rows = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in rows]


def get_all_correlations() -> List[Dict]:
    """Get all correlations."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT * FROM correlations')
    rows = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in rows]


def get_market_history(market_id: str) -> List[Dict]:
    """Get price history for a specific market."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT timestamp as t, price as p 
        FROM price_history 
        WHERE market_id = ? 
        ORDER BY timestamp ASC
    ''', (market_id,))
    rows = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in rows]


def get_all_data() -> Dict:
    """Get complete dataset for client consumption."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get markets with their history
    cursor.execute('SELECT * FROM markets ORDER BY volume DESC')
    markets_rows = cursor.fetchall()
    
    markets = []
    for row in markets_rows:
        market = dict(row)
        # Get history for this market
        cursor.execute('''
            SELECT timestamp as t, price as p 
            FROM price_history 
            WHERE market_id = ? 
            ORDER BY timestamp ASC
        ''', (market['id'],))
        history_rows = cursor.fetchall()
        market['history'] = [dict(h) for h in history_rows]
        markets.append(market)
    
    # Get correlations
    cursor.execute('SELECT * FROM correlations')
    correlations_rows = cursor.fetchall()
    correlations = [dict(row) for row in correlations_rows]
    
    # Get metadata
    cursor.execute('SELECT * FROM metadata')
    metadata_rows = cursor.fetchall()
    metadata = {row['key']: row['value'] for row in metadata_rows}
    
    conn.close()
    
    return {
        'markets': markets,
        'correlations': correlations,
        'metadata': metadata
    }


def set_metadata(key: str, value: str):
    """Set a metadata value."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', (key, value))
    
    conn.commit()
    conn.close()


def get_metadata(key: str) -> Optional[str]:
    """Get a metadata value."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT value FROM metadata WHERE key = ?', (key,))
    row = cursor.fetchone()
    conn.close()
    
    return row['value'] if row else None


def clear_correlations():
    """Clear all correlations (before recalculating)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM correlations')
    conn.commit()
    conn.close()


def cleanup_old_history(days: int = 30):
    """Remove price history older than N days."""
    import time
    cutoff = int(time.time()) - (days * 24 * 60 * 60)
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM price_history WHERE timestamp < ?', (cutoff,))
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    
    if deleted > 0:
        print(f"Cleaned up {deleted} old price history records.")


def get_uncategorized_markets() -> List[Dict]:
    """Get markets that haven't been categorized yet."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, name FROM markets WHERE category = 'Other' OR category IS NULL")
    rows = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in rows]


def update_market_category(market_id: str, category: str):
    """Update the category of a market."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('UPDATE markets SET category = ? WHERE id = ?', (category, market_id))
    conn.commit()
    conn.close()


# Initialize database on import
init_db()
