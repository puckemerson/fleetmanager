// Generate a single review post for a site.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { CONFIG } from './config.js';
import { d1All } from './d1.js';
import { proposeProducts, synthesizeReview } from './llm.js';
import { searchWeb, fetchPage, extractPage, findProductImage } from './search.js';
import { repoGitUrl } from './github.js';

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function ensureRepoClone(siteSlug, repoUrl) {
  const repoName = siteSlug;
  const workRepo = path.join(CONFIG.WORK_DIR, repoName);
  if (!fs.existsSync(workRepo)) {
    // Clone fresh
    console.log(`[generate] cloning ${repoName}`);
    const parent = path.dirname(workRepo);
    const git = simpleGit(parent);
    await git.clone(repoGitUrl(repoName), repoName);
  } else {
    // Pull
    const git = simpleGit(workRepo);
    try {
      await git.reset('hard');
      await git.pull('origin', 'main');
    } catch (err) {
      console.log(`[generate] pull warning: ${err.message}, re-cloning`);
      await fsp.rm(workRepo, { recursive: true, force: true });
      const parent = path.dirname(workRepo);
      const g2 = simpleGit(parent);
      await g2.clone(repoGitUrl(repoName), repoName);
    }
  }
  return workRepo;
}

export async function generatePost({ site }) {
  const { id: siteId, slug: siteSlug, product_category: category, repo_url: repoUrl } = site;
  console.log(`[generate] site=${siteSlug} category=${category}`);

  // 1. Get already-reviewed slugs
  const existing = await d1All('SELECT slug FROM posts WHERE site_id = ?', [siteId]);
  const excluded = existing.map((r) => r.slug);

  // 2. Propose products, filter
  let candidates = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const proposals = await proposeProducts(category, excluded.concat(candidates.map(c => c.slug)), 10);
    const fresh = proposals.filter((p) => !excluded.includes(p.slug) && !candidates.some(c => c.slug === p.slug));
    candidates = candidates.concat(fresh);
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) throw new Error('No fresh product candidates found');
  const product = candidates[0];
  console.log(`[generate] product: ${product.name} (slug=${product.slug})`);

  // 3. Research: Wikipedia (reliable) + web search (best effort)
  const snippets = [];
  // Wikipedia on the bare product name
  try {
    const wiki = await searchWeb(product.name, 5);
    for (const h of wiki) snippets.push({ title: h.title, url: h.url, snippet: h.snippet });
  } catch (err) {
    console.log(`[generate] wiki search failed: ${err.message}`);
  }
  // Additional web search on review intent
  let hits = [];
  try {
    hits = await searchWeb(`${product.name} review`, 8);
  } catch (err) {
    console.log(`[generate] web search failed: ${err.message}`);
  }
  for (const h of hits.slice(0, 5)) {
    if (snippets.some(s => s.url === h.url)) continue;
    snippets.push({ title: h.title, url: h.url, snippet: h.snippet });
  }
  // Read top 2-3 non-wiki pages deeply for more context
  const deepTargets = hits.filter(h => !/wikipedia\.org/.test(h.url)).slice(0, 3);
  for (const h of deepTargets) {
    try {
      const html = await fetchPage(h.url);
      const ext = extractPage(html);
      if (ext.text) {
        snippets.push({ title: ext.title || h.title, url: h.url, snippet: ext.text.slice(0, 900) });
      }
    } catch (_) {}
  }

  // 5. LLM synthesize review
  console.log(`[generate] synthesizing review (${snippets.length} snippets)...`);
  const review = await synthesizeReview({
    productName: product.name,
    category,
    searchSnippets: snippets,
  });
  console.log(`[generate] score=${review.final_score} cats=${review.categories.length}`);

  // 6. Get image
  console.log(`[generate] fetching product image...`);
  const img = await findProductImage(product.name);
  if (img) console.log(`[generate] image from ${img.sourceUrl} (${img.buffer.length} bytes)`);
  else console.log(`[generate] no image found; post will have placeholder`);

  // 7. Prepare repo clone
  const workRepo = await ensureRepoClone(siteSlug, repoUrl);

  // 7a. Reconcile site config (tagline, about_text, analytics_snippet, url).
  // D1 is the source of truth; write them into src/_data/site.json so the build reflects them.
  try {
    await reconcileSiteConfig(workRepo, site);
  } catch (err) {
    console.log(`[generate] site config reconcile warning: ${err.message}`);
  }

  // 8. Write image (if any)
  const postSlug = product.slug;
  let imageRef = null;
  let imageSource = null;
  if (img) {
    const ext = guessExt(img.contentType);
    const rel = `/images/${postSlug}${ext}`;
    const outPath = path.join(workRepo, 'src', 'images', `${postSlug}${ext}`);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, img.buffer);
    imageRef = rel;
    imageSource = img.sourceUrl;
  }

  // 9. Write markdown
  const now = new Date();
  const fm = {
    product_name: product.name,
    slug: postSlug,
    date: now.toISOString(),
    final_score: review.final_score,
    categories: review.categories,
  };
  if (imageRef) fm.image = imageRef;
  if (imageSource) fm.image_source = imageSource;

  const mdPath = path.join(workRepo, 'src', 'posts', `${postSlug}.md`);
  await fsp.mkdir(path.dirname(mdPath), { recursive: true });
  const frontMatter = toYamlFrontMatter(fm);
  const md = `---\n${frontMatter}---\n\n${review.markdown.trim()}\n`;
  await fsp.writeFile(mdPath, md);

  // 10. Commit and push
  const git = simpleGit(workRepo);
  await git.addConfig('user.email', 'fleetmanager@puckemerson.com', false, 'local');
  await git.addConfig('user.name', 'FleetManager Bot', false, 'local');
  await git.add('.');
  await git.commit(`Add review: ${product.name}`);
  await git.push('origin', 'main');
  const log = await git.log(['-1']);
  const commitSha = log?.latest?.hash || null;
  console.log(`[generate] pushed ${commitSha}`);

  return {
    product_name: product.name,
    slug: postSlug,
    final_score: review.final_score,
    category_scores_json: JSON.stringify(review.categories),
    image_r2_key: imageRef, // repurposed: stores the in-repo path
    image_source_url: imageSource,
    review_markdown: md,
    commit_sha: commitSha,
  };
}

async function reconcileSiteConfig(workRepo, site) {
  const cfgPath = path.join(workRepo, 'src', '_data', 'site.json');
  if (!fs.existsSync(cfgPath)) return;
  const cur = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
  const origin = (site.site_url || '').replace(/\/+$/, '').replace(/\/[^/]+$/, ''); // strip trailing repo path
  const inferredOrigin = origin && /^https?:\/\//.test(origin) ? origin : cur.url;
  const merged = {
    ...cur,
    title: site.site_title || cur.title,
    tagline: site.tagline || cur.tagline,
    category: site.product_category || cur.category,
    pathPrefix: cur.pathPrefix || `/${site.slug}/`,
    slug: site.slug || cur.slug,
    url: inferredOrigin || cur.url,
    about: site.about_text || cur.about,
    analytics_snippet: site.analytics_snippet || cur.analytics_snippet || '',
  };
  // Only write if something changed to avoid spurious commits.
  const before = JSON.stringify(cur);
  const after = JSON.stringify(merged);
  if (before !== after) {
    await fsp.writeFile(cfgPath, JSON.stringify(merged, null, 2) + '\n');
  }
}

function guessExt(ct) {
  if (!ct) return '.jpg';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif')) return '.gif';
  return '.jpg';
}

function toYamlFrontMatter(obj) {
  // Simple, safe YAML emitter for the small set of keys we use.
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'string') {
      lines.push(`${k}: ${yamlString(v)}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        if (typeof item === 'object' && item !== null) {
          const entries = Object.entries(item);
          lines.push(`  - ${entries[0][0]}: ${yamlScalar(entries[0][1])}`);
          for (let i = 1; i < entries.length; i++) {
            lines.push(`    ${entries[i][0]}: ${yamlScalar(entries[i][1])}`);
          }
        } else {
          lines.push(`  - ${yamlScalar(item)}`);
        }
      }
    } else if (typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [kk, vv] of Object.entries(v)) {
        lines.push(`  ${kk}: ${yamlScalar(vv)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function yamlScalar(v) {
  if (v == null) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return yamlString(String(v));
}

function yamlString(s) {
  // Always double-quote strings for safety, escape quotes and backslashes.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}
