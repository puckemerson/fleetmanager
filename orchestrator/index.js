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

async function runScaffold(job, site) {
  const out = await scaffoldSite({ slug: site.slug, category: site.product_category });
  // Update site row with repo_url, site_url, theme_json, SEO fields.
  const now = Date.now();
  const next = nextRunFrom(now, site.cron_spec);
  await d1Run(
    `UPDATE sites SET repo_url = ?, site_url = ?, theme_json = ?, site_title = ?, tagline = ?, about_text = ?, next_run_at = ? WHERE id = ?`,
    [out.repo_url, out.site_url, out.theme_json, out.site_title || null, out.tagline || null, out.about_text || null, next, site.id]
  );
  // Queue first generate_post if a schedule is set
  if (next) {
    await d1Run(
      `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_post', 'queued', ?)`,
      [site.id, next]
    );
  }
  return out;
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

  // Schedule next run based on site's cron_spec
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
  // Small sites get a smaller listicle.
  const postCountRow = await d1First(`SELECT COUNT(*) AS n FROM posts WHERE site_id = ?`, [site.id]);
  const postCount = Number(postCountRow?.n) || 0;
  const targetItemCount = postCount >= 10 ? 7 : Math.max(3, Math.min(5, postCount));
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
