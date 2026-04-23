-- Add SEO / per-site configuration fields.
-- These are populated at scaffold time and rendered into the site's src/_data/site.json.
ALTER TABLE sites ADD COLUMN tagline TEXT;
ALTER TABLE sites ADD COLUMN about_text TEXT;
ALTER TABLE sites ADD COLUMN analytics_snippet TEXT;
ALTER TABLE sites ADD COLUMN site_title TEXT;
