-- Listicles: aggregated "Best X for Y" posts that link to existing reviews.
CREATE TABLE IF NOT EXISTS listicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  intro_markdown TEXT NOT NULL,
  outro_markdown TEXT,
  filters_json TEXT,
  item_count INTEGER NOT NULL,
  commit_sha TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(site_id, slug)
);

CREATE TABLE IF NOT EXISTS listicle_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listicle_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  blurb_markdown TEXT NOT NULL,
  UNIQUE(listicle_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_listicle_items_listicle ON listicle_items(listicle_id);
CREATE INDEX IF NOT EXISTS idx_listicle_items_post ON listicle_items(post_id);
CREATE INDEX IF NOT EXISTS idx_listicles_site ON listicles(site_id);

-- Site ratio: generate 1 listicle per N reviews (default 10).
ALTER TABLE sites ADD COLUMN listicle_ratio INTEGER DEFAULT 10;
ALTER TABLE sites ADD COLUMN reviews_since_last_listicle INTEGER DEFAULT 0;
