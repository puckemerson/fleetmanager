// Site scaffolding: clone template, theme it, create repo, push.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import simpleGit from 'simple-git';
import { CONFIG } from './config.js';

// Escape a string for safe inclusion inside a JSON double-quoted value.
// Used when substituting SITE_* tokens into site.json etc.
function jsonSafe(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
import { createRepo, enablePages, repoGitUrl, repoPagesUrl, pagesOrigin } from './github.js';
import { randomTheme, themeCss } from './theme.js';
import { siteTaglineAndAbout } from './llm.js';

async function copyTemplate(dest) {
  // Remove existing dest, then copy template
  if (fs.existsSync(dest)) {
    await fsp.rm(dest, { recursive: true, force: true });
  }
  await fsp.mkdir(dest, { recursive: true });
  // Use cp -R for simplicity (Linux)
  execSync(`cp -R "${CONFIG.SITE_TEMPLATE_DIR}/." "${dest}/"`, { stdio: 'inherit' });
  // Remove node_modules and _site if template accidentally shipped them
  for (const rm of ['node_modules', '_site']) {
    const p = path.join(dest, rm);
    if (fs.existsSync(p)) await fsp.rm(p, { recursive: true, force: true });
  }
}

function replaceInFile(file, subs) {
  let t = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(subs)) {
    t = t.split(k).join(v);
  }
  fs.writeFileSync(file, t);
}

export async function scaffoldSite({ slug, category }) {
  const repoName = slug;
  const workRepo = path.join(CONFIG.WORK_DIR, slug);

  console.log(`[scaffold] ${slug} category=${category}`);

  // 1. Create GitHub repo
  const repo = await createRepo(repoName, `Auto-generated ${category} review site`);
  const repoUrl = repo.html_url;
  console.log(`[scaffold] repo: ${repoUrl}`);

  // 2. Generate theme + editorial copy (LLM, fallback-safe)
  const theme = randomTheme();
  console.log(`[scaffold] theme: ${theme.palette.name} / ${theme.fonts.sans}+${theme.fonts.serif}`);
  const editorial = await siteTaglineAndAbout(category);
  console.log(`[scaffold] title: ${editorial.title}`);

  // 3. Copy template
  await copyTemplate(workRepo);

  // 4. Write theme CSS
  fs.writeFileSync(path.join(workRepo, 'src/_theme.css'), themeCss(theme));

  // 5. Apply substitutions
  // site.url is the origin (no trailing path); pathPrefix in page.url | url adds the repo path.
  const siteOrigin = pagesOrigin();
  const subs = {
    SITE_TITLE: jsonSafe(editorial.title),
    SITE_TAGLINE: jsonSafe(editorial.tagline),
    SITE_CATEGORY: jsonSafe(category),
    SITE_SLUG: slug,
    SITE_ABOUT_PARAGRAPH: jsonSafe(editorial.about),
    SITE_URL: siteOrigin,
    SITE_GH_USER: CONFIG.GITHUB_USER,
    FONT_SANS_QS: theme.fonts.sansQs,
    FONT_SERIF_QS: theme.fonts.serifQs,
  };
  // Files needing subs
  const subFiles = [
    'src/_data/site.json',
    'src/_includes/base.njk',
    'src/about.njk',
    'package.json',
    '.github/workflows/deploy.yml',
  ];
  for (const f of subFiles) {
    const fp = path.join(workRepo, f);
    if (fs.existsSync(fp)) replaceInFile(fp, subs);
  }

  // 6. README
  fs.writeFileSync(path.join(workRepo, 'README.md'), `# ${editorial.title}\n\n${editorial.tagline}\n\nAuto-generated review site for **${category}**. Built with 11ty, deployed via GitHub Pages.\n\nLive: ${repoPagesUrl(repoName)}\n`);

  // 7. Git init and push to main
  const git = simpleGit(workRepo);
  await git.init();
  await git.checkoutLocalBranch('main').catch(async () => {
    // If main already exists (repo pre-existed)
    await git.checkout('main').catch(() => {});
  });
  await git.addConfig('user.email', 'fleetmanager@puckemerson.com', false, 'local');
  await git.addConfig('user.name', 'FleetManager Bot', false, 'local');
  await git.add('.');
  await git.commit('Initial scaffold');
  // Remote
  await git.removeRemote('origin').catch(() => {});
  await git.addRemote('origin', repoGitUrl(repoName));
  // Force push on main (it's a fresh repo, this is safe)
  await git.push(['-u', 'origin', 'main', '--force']);

  // 8. Enable Pages (workflow mode). The first push already triggered the workflow.
  try {
    await enablePages(repoName);
    console.log(`[scaffold] Pages enabled`);
  } catch (err) {
    console.log(`[scaffold] Pages enable warning: ${err.message}`);
  }

  return {
    repo_url: repoUrl,
    site_url: repoPagesUrl(repoName),
    theme_json: JSON.stringify({ palette: theme.palette.name, fonts: `${theme.fonts.sans}+${theme.fonts.serif}` }),
    repo_name: repoName,
    site_title: editorial.title,
    tagline: editorial.tagline,
    about_text: editorial.about,
    workRepo,
  };
}
