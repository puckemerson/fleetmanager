-- Affiliate link infrastructure.
-- Pipes are laid now; no affiliate IDs configured yet.

CREATE TABLE IF NOT EXISTS affiliate_programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  program TEXT NOT NULL,              -- 'amazon' | 'skimlinks' | 'sharesasale' | 'generic'
  config_json TEXT NOT NULL,          -- e.g. {"associate_tag": "will-20"} for amazon
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(site_id, program)
);

CREATE TABLE IF NOT EXISTS retailer_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  retailer TEXT NOT NULL,             -- 'amazon', 'sephora', 'generic', etc.
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retailer_links_post ON retailer_links(post_id);

CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  post_id INTEGER,
  listicle_id INTEGER,
  retailer TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  user_agent TEXT,
  ip_country TEXT,
  referer TEXT,
  clicked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clicks_site ON clicks(site_id);
CREATE INDEX IF NOT EXISTS idx_clicks_post ON clicks(post_id);
CREATE INDEX IF NOT EXISTS idx_clicks_clicked_at ON clicks(clicked_at);

ALTER TABLE sites ADD COLUMN affiliate_disclosure_enabled INTEGER DEFAULT 0;
ALTER TABLE sites ADD COLUMN affiliate_disclosure_text TEXT;
