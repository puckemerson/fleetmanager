#!/usr/bin/env node
// Sync up-to-date template files into an existing per-site repo.
// Copies layouts, partials, eleventy config, listicle index page, and
// package.json (merged deps) into the work-dir clone and pushes.
//
// Usage: node scripts/sync-template.js [--slug <slug>]
//        (if no --slug is provided, syncs all active sites)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import '../orchestrator/config.js';
import { CONFIG } from '../orchestrator/config.js';
import { d1All } from '../orchestrator/d1.js';
import { repoGitUrl } from '../orchestrator/github.js';

const TEMPLATE = CONFIG.SITE_TEMPLATE_DIR;
const WORK = CONFIG.WORK_DIR;

// Relative paths (from template root) to sync verbatim.
const SYNC_FILES = [
  '.eleventy.js',
  'src/_includes/base.njk',
  'src/_includes/review.njk',
  'src/_includes/layouts/listicle.njk',
  'src/_includes/partials/featured-in.njk',
  'src/_includes/partials/cta.njk',
  'src/_includes/partials/affiliate-disclosure.njk',
  'src/disclosure.njk',
  'src/listicles.njk',
  'src/listicles/listicles.11tydata.js',
  'src/sitemap.njk',
  'src/static/style.css',
];

async function ensureRepo(slug) {
  const repoDir = path.join(WORK, slug);
  if (!fs.existsSync(repoDir)) {
    const parent = path.dirname(repoDir);
    await simpleGit(parent).clone(repoGitUrl(slug), slug);
  } else {
    const g = simpleGit(repoDir);
    await g.reset('hard');
    await g.pull('origin', 'main');
  }
  return repoDir;
}

function mergePackageJson(existingStr, templatePath, slug) {
  const existing = JSON.parse(existingStr);
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  // Preserve the existing name, add/update devDependencies.
  const merged = {
    ...existing,
    scripts: { ...(existing.scripts || {}), ...(tpl.scripts || {}) },
    devDependencies: {
      ...(existing.devDependencies || {}),
      ...(tpl.devDependencies || {}),
    },
  };
  if (slug) merged.name = slug;
  return JSON.stringify(merged, null, 2) + '\n';
}

async function syncOne(slug) {
  console.log(`[sync] ${slug}`);
  const repoDir = await ensureRepo(slug);
  let anyChange = false;
  for (const rel of SYNC_FILES) {
    const src = path.join(TEMPLATE, rel);
    const dest = path.join(repoDir, rel);
    if (!fs.existsSync(src)) { console.log(`  skip (template missing): ${rel}`); continue; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const srcBuf = fs.readFileSync(src);
    const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (prev && Buffer.compare(prev, srcBuf) === 0) continue;
    fs.writeFileSync(dest, srcBuf);
    console.log(`  updated ${rel}`);
    anyChange = true;
  }
  // Merge package.json deps
  {
    const dest = path.join(repoDir, 'package.json');
    const tplPath = path.join(TEMPLATE, 'package.json');
    if (fs.existsSync(dest) && fs.existsSync(tplPath)) {
      const current = fs.readFileSync(dest, 'utf8');
      const merged = mergePackageJson(current, tplPath, slug);
      if (current !== merged) {
        fs.writeFileSync(dest, merged);
        console.log('  updated package.json');
        anyChange = true;
      }
    }
  }
  if (!anyChange) { console.log('  (no changes)'); return; }
  const git = simpleGit(repoDir);
  await git.addConfig('user.email', 'fleetmanager@puckemerson.com', false, 'local');
  await git.addConfig('user.name', 'FleetManager Bot', false, 'local');
  await git.add('.');
  await git.commit('Sync site template: listicles, layouts, styles');
  await git.push('origin', 'main');
  console.log('  pushed');
}

async function main() {
  const args = process.argv.slice(2);
  let slug = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slug') slug = args[++i];
  }
  let sites;
  if (slug) {
    sites = [{ slug, status: 'active' }];
  } else {
    sites = await d1All(`SELECT slug, status FROM sites WHERE status = 'active'`);
  }
  for (const s of sites) {
    try { await syncOne(s.slug); }
    catch (err) { console.error(`[sync] ${s.slug} FAILED: ${err.message}`); }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
