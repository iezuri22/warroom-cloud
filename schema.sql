-- War Room cloud schema for Neon Postgres
-- Single table, JSONB values, mirrors localStorage structure 1:1

CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT NOT NULL DEFAULT 'me',
  key TEXT NOT NULL,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_state_updated ON user_state(user_id, updated_at DESC);

-- Optional: audit log for debugging sync conflicts
CREATE TABLE IF NOT EXISTS sync_log (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  client_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
