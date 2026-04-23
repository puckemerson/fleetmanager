#!/usr/bin/env node
// FleetManager orchestrator: polls D1 for due jobs, executes them.
import { CONFIG, requireSecrets } from './config.js';
import { d1All, d1First, d1Run } from './d1.js';
import { scaffoldSite } from './scaffold.js';
import { generatePost } from './generate.js';
import { generateListicle } from './listicle.js';
import { nextRunFrom } from './schedule.js';

const ONCE = process.argv.includes('--once');

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

async function claimJob(jobId) {
  // Only claim if still queued. Use a guarded update.
  const r = await d1Run(
    `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
    [Date.now(), jobId]
  );
  return r.changes > 0;
}

async function finishJob(jobId, status, error, result) {
  await d1Run(
    `UPDATE jobs SET status = ?, finished_at = ?, error = ?, result_json = ? WHERE id = ?`,
    [status, Date.now(), error || null, result ? JSON.stringify(result).slice(0, 2000) : null, jobId]
  );
}

// Number of posts we want in the initial seed burst for a new site.
const SEED_BURST_TARGET = 10;
// Stagger gap between burst posts (seconds). Stays well under API rate limits
// while still getting a new site populated inside an hour or so.
const SEED_BURST_GAP_SECONDS = 60;

async function runScaffold(job, site) {
  const out = await scaffoldSite({ slug: site.slug, category: site.product_category });
  const now = Date.now();
  // Mark the site as being in seed burst mode. next_run_at is intentionally
  // left null: the cron-based scheduler skips sites with seed_burst_complete=0
  // so it won't double-queue while the burst is running.
  await d1Run(
    `UPDATE sites SET repo_url = ?, site_url = ?, theme_json = ?, site_title = ?, tagline = ?, about_text = ?, image_style_prompt = ?, next_run_at = NULL, seed_burst_complete = 0 WHERE id = ?`,
    [out.repo_url, out.site_url, out.theme_json, out.site_title || null, out.tagline || null, out.about_text || null, out.image_style_prompt || null, site.id]
  );
  // Queue the full seed burst of generate_post jobs, staggered so we don't
  // hammer the APIs. First one fires in ~30s to give Pages a moment to wake up.
  const queued = [];
  for (let i = 0; i < SEED_BURST_TARGET; i++) {
    const scheduledFor = now + (30 + i * SEED_BURST_GAP_SECONDS) * 1000;
    const r = await d1Run(
      `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_post', 'queued', ?)`,
      [site.id, scheduledFor]
    );
    queued.push(r.lastRowId);
  }
  log(`[job ${job.id}] seed burst: queued ${queued.length} generate_post jobs`);
  return { ...out, seed_burst_queued: queued.length };
}

async function runGenerate(job, site) {
  // Refuse if archived
  if (site.status === 'archived') throw new Error('site archived');
  if (!site.repo_url) throw new Error('site not scaffolded yet');
  const post = await generatePost({ site });
  // Insert post row
  const now = Date.now();
  await d1Run(
    `INSERT INTO posts (site_id, product_name, slug, final_score, category_scores_json, image_r2_key, image_source_url, review_markdown, commit_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, slug) DO UPDATE SET
       final_score = excluded.final_score,
       category_scores_json = excluded.category_scores_json,
       image_r2_key = excluded.image_r2_key,
       image_source_url = excluded.image_source_url,
       review_markdown = excluded.review_markdown,
       commit_sha = excluded.commit_sha`,
    [site.id, post.product_name, post.slug, post.final_score, post.category_scores_json,
     post.image_r2_key, post.image_source_url, post.review_markdown, post.commit_sha, now]
  );

  // Record a retailer_link if we detected one during generation. We key off
  // the post we just inserted (or upserted). Skip if retailer == 'none' or
  // no URL was captured.
  if (post.retailer && post.retailer !== 'none' && post.retailer_url) {
    const postRow = await d1First(`SELECT id FROM posts WHERE site_id = ? AND slug = ?`, [site.id, post.slug]);
    if (postRow?.id) {
      // Dedup by (post_id, retailer): if one already exists, leave it.
      const existing = await d1First(
        `SELECT id FROM retailer_links WHERE post_id = ? AND retailer = ?`,
        [postRow.id, post.retailer]
      );
      if (!existing) {
        await d1Run(
          `INSERT INTO retailer_links (post_id, retailer, url, created_at) VALUES (?, ?, ?, ?)`,
          [postRow.id, post.retailer, post.retailer_url, now]
        );
        log(`[job ${job.id}] retailer_link: ${post.retailer} <- ${post.retailer_url.slice(0, 80)}`);
      }
    }
  }

  // Increment the listicle counter. If we've hit the ratio, queue a listicle job
  // for immediate execution and reset the counter.
  const ratio = Number(site.listicle_ratio) > 0 ? Number(site.listicle_ratio) : 10;
  const counter = (Number(site.reviews_since_last_listicle) || 0) + 1;
  // Only trigger listicles for non-archived sites with at least 3 reviews available.
  const postCountRow = await d1First(`SELECT COUNT(*) AS n FROM posts WHERE site_id = ?`, [site.id]);
  const postCount = Number(postCountRow?.n) || 0;
  if (counter >= ratio && postCount >= 3 && site.status === 'active') {
    await d1Run(`UPDATE sites SET reviews_since_last_listicle = 0 WHERE id = ?`, [site.id]);
    await d1Run(
      `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_listicle', 'queued', ?)`,
      [site.id, Date.now()]
    );
    log(`[job ${job.id}] reached listicle ratio (${counter}/${ratio}), queued generate_listicle`);
  } else {
    await d1Run(`UPDATE sites SET reviews_since_last_listicle = ? WHERE id = ?`, [counter, site.id]);
  }

  // Seed burst bookkeeping. If this site is mid-burst and we've just crossed
  // the SEED_BURST_TARGET threshold, flip seed_burst_complete=1 and seed the
  // normal cron cadence (next_run_at). We do NOT queue a new generate_post
  // here during burst; the burst jobs were all queued up-front by scaffold.
  const inSeedBurst = Number(site.seed_burst_complete) === 0;
  if (inSeedBurst) {
    if (postCount >= SEED_BURST_TARGET && site.status === 'active') {
      const next = site.cron_spec ? nextRunFrom(now, site.cron_spec) : null;
      await d1Run(
        `UPDATE sites SET seed_burst_complete = 1, next_run_at = ? WHERE id = ?`,
        [next, site.id]
      );
      if (next) {
        await d1Run(
          `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_post', 'queued', ?)`,
          [site.id, next]
        );
      }
      log(`[job ${job.id}] seed burst complete (${postCount}/${SEED_BURST_TARGET}), resumed cron cadence`);
    }
    // Mid-burst: do not schedule via cron, the remaining burst jobs are already queued.
    return { slug: post.slug, score: post.final_score, sha: post.commit_sha, burst_progress: `${postCount}/${SEED_BURST_TARGET}` };
  }

  // Schedule next run based on site's cron_spec (non-burst path).
  if (site.cron_spec && site.status === 'active') {
    const next = nextRunFrom(now, site.cron_spec);
    if (next) {
      await d1Run(`UPDATE sites SET next_run_at = ? WHERE id = ?`, [next, site.id]);
      await d1Run(
        `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_post', 'queued', ?)`,
        [site.id, next]
      );
    }
  }
  return { slug: post.slug, score: post.final_score, sha: post.commit_sha };
}

async function runGenerateListicle(job, site) {
  if (site.status === 'archived') throw new Error('site archived');
  if (!site.repo_url) throw new Error('site not scaffolded yet');
  // Give the curator a rough target; the prompt allows 5-15 items (3+ on tiny sites),
  // and tells it to let the angle — not the target — decide the final length.
  const postCountRow = await d1First(`SELECT COUNT(*) AS n FROM posts WHERE site_id = ?`, [site.id]);
  const postCount = Number(postCountRow?.n) || 0;
  let targetItemCount;
  if (postCount >= 15) targetItemCount = 10;
  else if (postCount >= 10) targetItemCount = 7;
  else if (postCount >= 5) targetItemCount = 5;
  else targetItemCount = Math.max(3, postCount);
  const result = await generateListicle({ site, targetItemCount });
  return result;
}

async function tick() {
  const now = Date.now();
  const jobs = await d1All(
    `SELECT * FROM jobs WHERE status = 'queued' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT 5`,
    [now]
  );
  if (jobs.length === 0) return 0;
  log(`tick: ${jobs.length} job(s) due`);
  let done = 0;
  for (const job of jobs) {
    const claimed = await claimJob(job.id);
    if (!claimed) { log(`job ${job.id} already claimed, skip`); continue; }
    log(`[job ${job.id}] ${job.kind} for site ${job.site_id} — running`);
    try {
      const site = await d1First(`SELECT * FROM sites WHERE id = ?`, [job.site_id]);
      if (!site) throw new Error(`site ${job.site_id} not found`);
      let result;
      if (job.kind === 'scaffold_site') result = await runScaffold(job, site);
      else if (job.kind === 'generate_post') result = await runGenerate(job, site);
      else if (job.kind === 'generate_listicle') result = await runGenerateListicle(job, site);
      else throw new Error(`unknown job kind: ${job.kind}`);
      await finishJob(job.id, 'done', null, result);
      log(`[job ${job.id}] done`);
      done++;
    } catch (err) {
      const msg = String(err?.stack || err?.message || err).slice(0, 1800);
      log(`[job ${job.id}] FAILED: ${msg}`);
      await finishJob(job.id, 'failed', msg, null);
    }
  }
  return done;
}

async function main() {
  requireSecrets();
  log(`FleetManager orchestrator starting. tick_ms=${CONFIG.TICK_MS} once=${ONCE}`);
  if (ONCE) {
    await tick();
    return;
  }
  // Loop forever
  while (true) {
    try { await tick(); }
    catch (err) { log(`tick error: ${err.message}`); }
    await new Promise((r) => setTimeout(r, CONFIG.TICK_MS));
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
