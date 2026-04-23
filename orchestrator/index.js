#!/usr/bin/env node
// FleetManager orchestrator: polls D1 for due jobs, executes them.
import { CONFIG, requireSecrets } from './config.js';
import { d1All, d1First, d1Run } from './d1.js';
import { scaffoldSite } from './scaffold.js';
import { generatePost } from './generate.js';
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
  // Update site row with repo_url, site_url, theme_json
  const now = Date.now();
  const next = nextRunFrom(now, site.cron_spec);
  await d1Run(
    `UPDATE sites SET repo_url = ?, site_url = ?, theme_json = ?, next_run_at = ? WHERE id = ?`,
    [out.repo_url, out.site_url, out.theme_json, next, site.id]
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
