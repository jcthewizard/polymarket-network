/*
  # Create Market Data Tables

  1. New Tables
    - `markets` - Stores market metadata (nodes)
      - `id` (uuid, primary key)
      - `market_id` (text, unique) - Polymarket ID
      - `question` (text) - Market question/title
      - `slug` (text) - Market slug
      - `category` (text) - Category/tag
      - `volume` (numeric) - Trading volume
      - `probability` (numeric) - Current probability (0-1)
      - `clob_token_id` (text) - CLOB token ID
      - `created_at` (timestamp)
      - `updated_at` (timestamp)
    
    - `market_correlations` - Stores correlation links between markets
      - `id` (uuid, primary key)
      - `source_market_id` (text, foreign key)
      - `target_market_id` (text, foreign key)
      - `correlation` (numeric) - Correlation coefficient
      - `is_inverse` (boolean) - Whether correlation is inverse
      - `inefficiency` (text) - Inefficiency score (Low/High)
      - `created_at` (timestamp)
    
    - `market_history` - Stores price history for markets
      - `id` (uuid, primary key)
      - `market_id` (text, foreign key)
      - `timestamp` (timestamptz) - Price timestamp
      - `price` (numeric) - Price at timestamp
      - `created_at` (timestamp)
    
    - `data_refresh_log` - Tracks data refresh job execution
      - `id` (uuid, primary key)
      - `status` (text) - Job status (running/completed/failed)
      - `markets_processed` (integer) - Number of markets processed
      - `correlations_found` (integer) - Number of correlations found
      - `error_message` (text) - Error message if failed
      - `started_at` (timestamptz) - Job start time
      - `completed_at` (timestamptz) - Job completion time
      - `created_at` (timestamp)

  2. Indexes
    - Index on markets.market_id for fast lookups
    - Index on market_correlations for efficient queries
    - Index on market_history for time-series queries
    - Index on data_refresh_log.completed_at for status checks

  3. Security
    - Enable RLS on all tables
    - Public read-only access for markets, correlations, and refresh status
*/

CREATE TABLE IF NOT EXISTS markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text UNIQUE NOT NULL,
  question text NOT NULL,
  slug text,
  category text,
  volume numeric,
  probability numeric,
  clob_token_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_correlations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_market_id text NOT NULL,
  target_market_id text NOT NULL,
  correlation numeric NOT NULL,
  is_inverse boolean DEFAULT false,
  inefficiency text DEFAULT 'Low',
  created_at timestamptz DEFAULT now(),
  FOREIGN KEY (source_market_id) REFERENCES markets(market_id),
  FOREIGN KEY (target_market_id) REFERENCES markets(market_id),
  UNIQUE(source_market_id, target_market_id)
);

CREATE TABLE IF NOT EXISTS market_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id text NOT NULL,
  timestamp timestamptz NOT NULL,
  price numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  FOREIGN KEY (market_id) REFERENCES markets(market_id)
);

CREATE TABLE IF NOT EXISTS data_refresh_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL,
  markets_processed integer,
  correlations_found integer,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_markets_market_id ON markets(market_id);
CREATE INDEX IF NOT EXISTS idx_market_correlations_source ON market_correlations(source_market_id);
CREATE INDEX IF NOT EXISTS idx_market_correlations_target ON market_correlations(target_market_id);
CREATE INDEX IF NOT EXISTS idx_market_history_market_id ON market_history(market_id);
CREATE INDEX IF NOT EXISTS idx_market_history_timestamp ON market_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_data_refresh_log_completed ON data_refresh_log(completed_at DESC);

ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_refresh_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "markets_public_read" ON markets
  FOR SELECT TO public
  USING (true);

CREATE POLICY "market_correlations_public_read" ON market_correlations
  FOR SELECT TO public
  USING (true);

CREATE POLICY "market_history_public_read" ON market_history
  FOR SELECT TO public
  USING (true);

CREATE POLICY "data_refresh_log_public_read" ON data_refresh_log
  FOR SELECT TO public
  USING (true);

CREATE POLICY "markets_service_write" ON markets
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "markets_service_update" ON markets
  FOR UPDATE TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "markets_service_delete" ON markets
  FOR DELETE TO service_role
  USING (true);

CREATE POLICY "market_correlations_service_write" ON market_correlations
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "market_correlations_service_delete" ON market_correlations
  FOR DELETE TO service_role
  USING (true);

CREATE POLICY "market_history_service_write" ON market_history
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "market_history_service_delete" ON market_history
  FOR DELETE TO service_role
  USING (true);

CREATE POLICY "data_refresh_log_service_write" ON data_refresh_log
  FOR INSERT TO service_role
  WITH CHECK (true);
