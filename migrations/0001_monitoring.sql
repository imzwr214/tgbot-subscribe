CREATE TABLE IF NOT EXISTS monitor_targets (
  user_id TEXT NOT NULL,
  sub_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  status_since INTEGER,
  total_nodes INTEGER,
  online_nodes INTEGER,
  median_delay_ms INTEGER,
  subscription_fetch_ok INTEGER,
  probe_id TEXT,
  last_error TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  healthy_streak INTEGER NOT NULL DEFAULT 0,
  alert_state TEXT NOT NULL DEFAULT 'normal',
  last_alert_at INTEGER,
  PRIMARY KEY (user_id, sub_id)
);

CREATE TABLE IF NOT EXISTS monitor_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sub_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  total_nodes INTEGER NOT NULL,
  online_nodes INTEGER NOT NULL,
  median_delay_ms INTEGER,
  subscription_fetch_ok INTEGER NOT NULL,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_monitor_checks_target_time
  ON monitor_checks (user_id, sub_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_monitor_targets_enabled
  ON monitor_targets (enabled, updated_at);

CREATE TABLE IF NOT EXISTS monitor_probes (
  probe_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  version TEXT,
  last_seen_at INTEGER NOT NULL
);
