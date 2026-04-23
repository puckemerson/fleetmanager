#!/usr/bin/env node
// Backfill SEO for existing sites:
//   - Update D1 site row with tagline / about_text / site_title defaults
//   - Refresh the site repo's template files (layouts, sitemap, robots, 11ty config, data) from site-template/
//   - Preserve the site's posts, images, _theme.css, and package.json name
//   - Commit and push
//
// Usage:
//   node scripts/backfill-seo.js [--slug <slug>]  # default: all sites
//   node scripts/backfill-seo.js --dry-run
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import simpleGit from 'simple-git';
import { CONFIG } from '../orchestrator/config.js';
import { d1All, d1Run } from '../orchestrator/d1.js';
import { repoGitUrl, pagesOrigin } from '../orchestrator/github.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const DRY = flag('dry-run');
const TARGET_SLUG = opt('slug');

const TEMPLATE_DIR = CONFIG.SITE_TEMPLATE_DIR;

function log(...args) { console.log('[backfill]', ...args); }

// Files that should be overwritten from the template on every run.
// (Layout + config + new SEO templates.) Does NOT include posts, images, theme.
const OVERWRITE_FROM_TEMPLATE = [
  '.eleventy.js',
  'src/_includes/base.njk',
  'src/_includes/review.njk',
  'src/index.njk',
  'src/about.njk',
  'src/sitemap.njk',
  'src/robots.njk',
  'src/static/style.css',
  'src/posts/posts.11tydata.js',
  '.github/workflows/deploy.yml',
];

// Files that may be deleted because they've been superseded.
const DELETE_IF_PRESENT = [
  'src/posts/posts.json',
];

// Category-appropriate tagline/about fallbacks
const CATEGORY_DEFAULTS = {
  perfume: {
    tagline: 'Honest fragrance reviews that capture more than top notes.',
    about: 'This is an independent perfume review site. Each review is a first-person take, grounded in research from across the web, with scoring categories tuned to what actually matters in a fragrance: projection, longevity, character, and value. No affiliate shilling, no gushing superlatives, just the scent as it lives on skin and in memory.',
  },
  cologne: {
    tagline: 'Honest cologne reviews that capture more than top notes.',
    about: 'This is an independent cologne review site. Each review is a first-person take, grounded in research from across the web, scored on the criteria that matter for the specific fragrance.',
  },
};

function defaultsForCategory(cat) {
  const c = String(cat || '').toLowerCase();
  if (CATEGORY_DEFAULTS[c]) return CATEGORY_DEFAULTS[c];
  const cap = c.charAt(0).toUpperCase() + c.slice(1);
  return {
    tagline: `Honest, unhurried reviews of ${c}.`,
    about: `This is an independent ${c} review site. Each review is a first-person take, grounded in research from across the web, with scoring categories chosen to fit the specific product.`,
  };
}

function replaceInFile(file, subs) {
  if (!fs.existsSync(file)) return;
  let t = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(subs)) t = t.split(k).join(v);
  fs.writeFileSync(file, t);
}

function jsonSafe(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

async function ensureRepoClone(slug) {
  const workRepo = path.join(CONFIG.WORK_DIR, slug);
  if (!fs.existsSync(workRepo)) {
    log(`cloning ${slug}`);
    const parent = path.dirname(workRepo);
    await simpleGit(parent).clone(repoGitUrl(slug), slug);
  } else {
    const git = simpleGit(workRepo);
    await git.reset('hard');
    try { await git.pull('origin', 'main'); } catch { /* ignore */ }
  }
  return workRepo;
}

async function backfillSite(site) {
  log(`site: ${site.slug} (id=${site.id}, category=${site.product_category})`);

  // 1. Ensure tagline/about/site_title are set in D1
  const defs = defaultsForCategory(site.product_category);
  let tagline = site.tagline;
  let aboutText = site.about_text;
  let siteTitle = site.site_title;

  // Pull existing site config from repo if present to preserve title
  const workRepo = await ensureRepoClone(site.slug);
  const cfgPath = path.join(workRepo, 'src', '_data', 'site.json');
  let existingCfg = {};
  if (fs.existsSync(cfgPath)) {
    try { existingCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  }
  if (!siteTitle) siteTitle = existingCfg.title || deriveTitleFromSlug(site.slug);
  if (!tagline) tagline = existingCfg.tagline || defs.tagline;
  if (!aboutText) aboutText = existingCfg.about || defs.about;

  if (!DRY) {
    await d1Run(
      `UPDATE sites SET site_title = ?, tagline = ?, about_text = ? WHERE id = ?`,
      [siteTitle, tagline, aboutText, site.id]
    );
    log(`  D1 updated: title="${siteTitle}" tagline="${tagline.slice(0, 40)}..."`);
  }

  // 2. Preserve font QS values by extracting them from existing base.njk (if present)
  const basePath = path.join(workRepo, 'src', '_includes', 'base.njk');
  let fontSansQs = 'Inter:wght@400;600';
  let fontSerifQs = 'Playfair+Display:wght@400;700';
  if (fs.existsSync(basePath)) {
    const cur = fs.readFileSync(basePath, 'utf8');
    const m = cur.match(/family=([^&]+)&family=([^&"]+)/);
    if (m) { fontSansQs = m[1]; fontSerifQs = m[2]; }
  }

  // 3. Copy overwrite files from template
  for (const rel of OVERWRITE_FROM_TEMPLATE) {
    const src = path.join(TEMPLATE_DIR, rel);
    const dest = path.join(workRepo, rel);
    if (!fs.existsSync(src)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
  for (const rel of DELETE_IF_PRESENT) {
    const f = path.join(workRepo, rel);
    if (fs.existsSync(f)) await fsp.unlink(f);
  }

  // 4. Write site.json with updated fields (origin not repo URL)
  const origin = pagesOrigin();
  const newCfg = {
    title: siteTitle,
    tagline,
    category: site.product_category,
    pathPrefix: `/${site.slug}/`,
    slug: site.slug,
    url: origin,
    about: aboutText,
    analytics_snippet: site.analytics_snippet || existingCfg.analytics_snippet || '',
    ghUser: CONFIG.GITHUB_USER,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(newCfg, null, 2) + '\n');

  // 5. Re-apply font substitutions in base.njk (template has FONT_SANS_QS / FONT_SERIF_QS)
  const fontSubs = { FONT_SANS_QS: fontSansQs, FONT_SERIF_QS: fontSerifQs };
  replaceInFile(basePath, fontSubs);

  // 6. Re-apply SITE_SLUG substitution in the workflow
  replaceInFile(path.join(workRepo, '.github/workflows/deploy.yml'), { SITE_SLUG: site.slug });

  // 7. Ensure about.njk no longer holds SITE_ABOUT_PARAGRAPH or any placeholder;
  //    because we just copied the new template, it should already use {{ site.about }}.

  // 8. Commit + push
  const git = simpleGit(workRepo);
  await git.addConfig('user.email', 'fleetmanager@puckemerson.com', false, 'local');
  await git.addConfig('user.name', 'FleetManager Bot', false, 'local');
  const status = await git.status();
  if (status.files.length === 0) {
    log(`  no changes to commit`);
    return { slug: site.slug, changed: false };
  }
  log(`  changes: ${status.files.length} files`);
  if (DRY) {
    for (const f of status.files) log(`    ${f.index}${f.working_dir} ${f.path}`);
    return { slug: site.slug, changed: true, dry: true };
  }
  await git.add('.');
  await git.commit('SEO backfill: JSON-LD, meta tags, sitemap, robots, related reviews');
  await git.push('origin', 'main');
  const lastLog = await git.log(['-1']);
  log(`  pushed ${lastLog?.latest?.hash?.slice(0, 8)}`);
  return { slug: site.slug, changed: true, sha: lastLog?.latest?.hash };
}

function deriveTitleFromSlug(slug) {
  return String(slug || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function main() {
  if (!CONFIG.CF_API_KEY) throw new Error('CLOUDFLARE_GLOBAL_API_KEY not set');
  if (!CONFIG.GITHUB_PAT) throw new Error('GITHUB_PAT not set');

  log(`template: ${TEMPLATE_DIR}`);
  log(`dry-run: ${DRY}`);

  let sql = `SELECT * FROM sites WHERE status = 'active' AND repo_url != ''`;
  const params = [];
  if (TARGET_SLUG) { sql += ` AND slug = ?`; params.push(TARGET_SLUG); }
  sql += ` ORDER BY id ASC`;
  const sites = await d1All(sql, params);
  log(`sites to process: ${sites.length}`);

  const results = [];
  for (const s of sites) {
    try {
      const r = await backfillSite(s);
      results.push(r);
    } catch (err) {
      log(`  FAILED: ${err.stack || err.message}`);
      results.push({ slug: s.slug, error: err.message });
    }
  }

  log('done');
  for (const r of results) console.log(JSON.stringify(r));
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
