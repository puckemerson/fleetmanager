-- Seed burst: when a site is newly created, fire 10 generate_post jobs back-to-back
-- before falling into the normal cron cadence. seed_burst_complete=0 means the
-- burst is in progress (cron scheduling is suppressed); =1 means complete.
--
-- Default is 1 so pre-existing sites are considered "complete" and keep their
-- current scheduling behavior. The scaffold_site handler flips it to 0 for new
-- sites, and the generate_post handler flips it back to 1 once 10 reviews exist.
ALTER TABLE sites ADD COLUMN seed_burst_complete INTEGER DEFAULT 1;
