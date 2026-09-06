ALTER TABLE sites ADD COLUMN hosting_provider TEXT NOT NULL DEFAULT 'github_pages';
ALTER TABLE sites ADD COLUMN theme_family TEXT NOT NULL DEFAULT 'eleventy_classic';
