-- Add custom domain and image style prompt support
ALTER TABLE sites ADD COLUMN custom_domain TEXT;
ALTER TABLE sites ADD COLUMN custom_domain_status TEXT DEFAULT 'none';
ALTER TABLE sites ADD COLUMN image_style_prompt TEXT;
