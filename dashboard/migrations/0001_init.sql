-- FleetManager D1 schema
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  product_category TEXT NOT NULL,
  repo_url TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  theme_json TEXT NOT NULL DEFAULT '{}',
  cron_spec TEXT,
  next_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  final_score INTEGER NOT NULL,
  category_scores_json TEXT NOT NULL,
  image_r2_key TEXT,
  image_source_url TEXT,
  review_markdown TEXT NOT NULL,
  commit_sha TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(site_id, slug)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  result_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled ON jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_posts_site ON posts(site_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
