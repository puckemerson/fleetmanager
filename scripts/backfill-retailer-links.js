#!/usr/bin/env node
// Backfill retailer_links from posts.image_source_url.
// Usage: node scripts/backfill-retailer-links.js [--site <slug>] [--dry]
import '../orchestrator/config.js';
import { d1All, d1First, d1Run } from '../orchestrator/d1.js';
import { detectRetailer } from '../shared/affiliate.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { slug: null, dry: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site' || args[i] === '--slug') out.slug = args[++i];
    else if (args[i] === '--dry') out.dry = true;
  }
  return out;
}

async function main() {
  const { slug, dry } = parseArgs();
  let siteRows;
  if (slug) {
    const s = await d1First(`SELECT id, slug, status FROM sites WHERE slug = ?`, [slug]);
    if (!s) { console.error(`no site with slug ${slug}`); process.exit(1); }
    siteRows = [s];
  } else {
    siteRows = await d1All(`SELECT id, slug, status FROM sites WHERE status = 'active'`);
  }
  let totalInserted = 0;
  let totalSkipped = 0;
  for (const site of siteRows) {
    console.log(`\n[backfill] site=${site.slug} (${site.status})`);
    const posts = await d1All(
      `SELECT id, slug, image_source_url FROM posts WHERE site_id = ?`, [site.id]
    );
    for (const p of posts) {
      if (!p.image_source_url) { console.log(`  skip ${p.slug}: no image_source_url`); totalSkipped++; continue; }
      const retailer = detectRetailer(p.image_source_url);
      if (retailer === 'none') {
        console.log(`  skip ${p.slug}: non-retailer source (${p.image_source_url.slice(0, 60)})`);
        totalSkipped++;
        continue;
      }
      // Already present?
      const existing = await d1First(
        `SELECT id FROM retailer_links WHERE post_id = ? AND retailer = ?`,
        [p.id, retailer]
      );
      if (existing) {
        console.log(`  have ${p.slug}: ${retailer} (already present, id=${existing.id})`);
        totalSkipped++;
        continue;
      }
      if (dry) {
        console.log(`  [DRY] insert ${p.slug}: retailer=${retailer} url=${p.image_source_url.slice(0, 80)}`);
        continue;
      }
      await d1Run(
        `INSERT INTO retailer_links (post_id, retailer, url, created_at) VALUES (?, ?, ?, ?)`,
        [p.id, retailer, p.image_source_url, Date.now()]
      );
      console.log(`  +   ${p.slug}: ${retailer}`);
      totalInserted++;
    }
  }
  console.log(`\n[backfill] done. inserted=${totalInserted} skipped=${totalSkipped}${dry ? ' (dry run)' : ''}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
