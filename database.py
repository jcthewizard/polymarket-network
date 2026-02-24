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
    conn.execute("PRAGMA journal_mode=WAL")
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
            condition_id TEXT DEFAULT '',
            clob_token_id_yes TEXT DEFAULT '',
            clob_token_id_no TEXT DEFAULT '',
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

    # Relationships table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            leader_market_id TEXT NOT NULL,
            leader_condition_id TEXT NOT NULL,
            leader_clob_token_id TEXT NOT NULL,
            leader_question TEXT,
            follower_market_id TEXT NOT NULL,
            follower_condition_id TEXT NOT NULL,
            follower_clob_token_id_yes TEXT,
            follower_clob_token_id_no TEXT,
            follower_question TEXT,
            follower_slug TEXT,
            confidence REAL NOT NULL,
            is_same_direction BOOLEAN DEFAULT 1,
            relationship_type TEXT DEFAULT 'direct',
            rationale TEXT,
            discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            active BOOLEAN DEFAULT 1,
            UNIQUE(leader_market_id, follower_market_id)
        )
    ''')

    # Trade signals table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trade_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            leader_market_id TEXT NOT NULL,
            follower_market_id TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            trigger_value TEXT,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            confidence REAL,
            status TEXT DEFAULT 'PENDING',
            rejection_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            executed_at DATETIME
        )
    ''')

    # Positions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS positions (
            id TEXT PRIMARY KEY,
            signal_id INTEGER,
            market_slug TEXT NOT NULL,
            token_id TEXT NOT NULL,
            outcome TEXT NOT NULL,
            side TEXT NOT NULL,
            entry_price REAL,
            size_shares REAL,
            amount_usdc REAL,
            status TEXT DEFAULT 'PENDING',
            close_reason TEXT,
            exit_price REAL,
            realized_pnl REAL,
            order_id TEXT,
            close_order_id TEXT,
            opened_at DATETIME,
            filled_at DATETIME,
            closed_at DATETIME,
            dry_run BOOLEAN DEFAULT 1,
            FOREIGN KEY (signal_id) REFERENCES trade_signals(id)
        )
    ''')

    # Fired resolutions table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS fired_resolutions (
            leader_market_id TEXT PRIMARY KEY,
            resolution_value TEXT NOT NULL,
            fired_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('CREATE INDEX IF NOT EXISTS idx_relationships_leader ON relationships(leader_market_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_relationships_active ON relationships(active)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_trade_signals_status ON trade_signals(status)')

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
        INSERT OR REPLACE INTO markets (id, name, slug, category, volume, probability, clob_token_id, condition_id, clob_token_id_yes, clob_token_id_no, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        market['id'],
        market['name'],
        market.get('slug', ''),
        category,
        market.get('volume', 0),
        market.get('probability', 0.5),
        market.get('clob_token_id', ''),
        market.get('condition_id', ''),
        market.get('clob_token_id_yes', ''),
        market.get('clob_token_id_no', ''),
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


def clear_markets():
    """Clear all markets and their price history."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('DELETE FROM markets')
    cursor.execute('DELETE FROM price_history')
    
    conn.commit()
    conn.close()


def atomic_replace_all_data(markets: List[Dict], histories: Dict[str, List], correlations: List[Dict]):
    """
    Atomically replace all markets, price history, and correlations in a single transaction.
    This prevents race conditions where clients see partial data during refresh.
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    try:
        # Start transaction (implicit with sqlite3)
        
        # 1. Clear all existing data
        cursor.execute('DELETE FROM markets')
        cursor.execute('DELETE FROM price_history')
        cursor.execute('DELETE FROM correlations')
        
        # 2. Insert all markets
        for market in markets:
            cursor.execute('''
                INSERT OR REPLACE INTO markets (id, name, slug, category, volume, probability, clob_token_id, condition_id, clob_token_id_yes, clob_token_id_no)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                market['id'],
                market['name'],
                market.get('slug', ''),
                market['category'],
                market['volume'],
                market['probability'],
                market['clob_token_id'],
                market.get('condition_id', ''),
                market.get('clob_token_id_yes', ''),
                market.get('clob_token_id_no', '')
            ))
        
        # 3. Insert all price history
        for market_id, history in histories.items():
            cursor.executemany('''
                INSERT OR IGNORE INTO price_history (market_id, timestamp, price)
                VALUES (?, ?, ?)
            ''', [(market_id, point['t'], point['p']) for point in history])
        
        # 4. Insert all correlations
        for link in correlations:
            cursor.execute('''
                INSERT OR REPLACE INTO correlations (source_id, target_id, correlation, inefficiency)
                VALUES (?, ?, ?, ?)
            ''', (link['source'], link['target'], link['correlation'], link['inefficiency']))
        
        # Commit all changes atomically
        conn.commit()
        
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()


def get_all_categories() -> Dict[str, str]:
    """Get all market categories as a dict (market_id -> category)."""
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT id, category FROM markets WHERE category IS NOT NULL AND category != "Other"')
    rows = cursor.fetchall()
    conn.close()
    
    return {row['id']: row['category'] for row in rows}


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


# ── Relationships CRUD ──────────────────────────────────────────

def insert_relationship(leader_market_id, leader_condition_id, leader_clob_token_id,
                        leader_question, follower_market_id, follower_condition_id,
                        follower_clob_token_id_yes, follower_clob_token_id_no,
                        follower_question, follower_slug, confidence,
                        is_same_direction=True, relationship_type='direct', rationale=''):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO relationships
        (leader_market_id, leader_condition_id, leader_clob_token_id, leader_question,
         follower_market_id, follower_condition_id, follower_clob_token_id_yes,
         follower_clob_token_id_no, follower_question, follower_slug,
         confidence, is_same_direction, relationship_type, rationale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (leader_market_id, leader_condition_id, leader_clob_token_id, leader_question,
          follower_market_id, follower_condition_id, follower_clob_token_id_yes,
          follower_clob_token_id_no, follower_question, follower_slug,
          confidence, is_same_direction, relationship_type, rationale))
    conn.commit()
    conn.close()


def get_active_relationships():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM relationships WHERE active = 1')
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def deactivate_relationships(leader_market_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('UPDATE relationships SET active = 0 WHERE leader_market_id = ?', (leader_market_id,))
    conn.commit()
    conn.close()


# ── Trade Signals CRUD ──────────────────────────────────────────

def insert_signal(leader_market_id, follower_market_id, trigger_type, trigger_value,
                  action, outcome, confidence):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO trade_signals
        (leader_market_id, follower_market_id, trigger_type, trigger_value,
         action, outcome, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (leader_market_id, follower_market_id, trigger_type, trigger_value,
          action, outcome, confidence))
    signal_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return signal_id


def update_signal_status(signal_id, status, rejection_reason=None):
    conn = get_connection()
    cursor = conn.cursor()
    if rejection_reason:
        cursor.execute('UPDATE trade_signals SET status = ?, rejection_reason = ? WHERE id = ?',
                       (status, rejection_reason, signal_id))
    else:
        cursor.execute('UPDATE trade_signals SET status = ?, executed_at = ? WHERE id = ?',
                       (status, datetime.now().isoformat(), signal_id))
    conn.commit()
    conn.close()


def get_recent_signals(limit=50):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM trade_signals ORDER BY created_at DESC LIMIT ?', (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


# ── Positions CRUD ──────────────────────────────────────────────

def insert_position(position):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO positions
        (id, signal_id, market_slug, token_id, outcome, side, entry_price,
         size_shares, amount_usdc, status, order_id, opened_at, dry_run)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (position['id'], position.get('signal_id'), position['market_slug'],
          position['token_id'], position['outcome'], position['side'],
          position['entry_price'], position['size_shares'], position['amount_usdc'],
          position['status'], position.get('order_id'), position['opened_at'],
          position.get('dry_run', True)))
    conn.commit()
    conn.close()


def update_position(position_id, updates):
    conn = get_connection()
    cursor = conn.cursor()
    set_clauses = []
    values = []
    for key, value in updates.items():
        set_clauses.append(f'{key} = ?')
        values.append(value)
    values.append(position_id)
    cursor.execute(f'UPDATE positions SET {", ".join(set_clauses)} WHERE id = ?', values)
    conn.commit()
    conn.close()


def get_position(position_id):
    """Get a single position by ID."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM positions WHERE id = ?', (position_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_open_positions():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM positions WHERE status IN ('PENDING', 'OPEN', 'CLOSING')")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_positions_by_status(status):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM positions WHERE status = ?', (status,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_recent_positions(limit=100):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?', (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


# ── Fired Resolutions ──────────────────────────────────────────

def mark_resolution_fired(leader_market_id, resolution_value):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO fired_resolutions (leader_market_id, resolution_value)
        VALUES (?, ?)
    ''', (leader_market_id, resolution_value))
    conn.commit()
    conn.close()


def is_resolution_fired(leader_market_id):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT 1 FROM fired_resolutions WHERE leader_market_id = ?', (leader_market_id,))
    row = cursor.fetchone()
    conn.close()
    return row is not None


# Initialize database on import
init_db()
