// Generate a single listicle for a site.
// Aggregates existing reviews into a "Best X for Y" style post, and
// publishes both a markdown file and a JSON dump used by 11ty to render
// cross-links on individual review pages.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { CONFIG } from './config.js';
import { d1All, d1First, d1Run } from './d1.js';
import { generateListicle as llmGenerateListicle } from './llm.js';
import { repoGitUrl } from './github.js';

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function ensureRepoClone(siteSlug) {
  const repoName = siteSlug;
  const workRepo = path.join(CONFIG.WORK_DIR, repoName);
  if (!fs.existsSync(workRepo)) {
    console.log(`[listicle] cloning ${repoName}`);
    const parent = path.dirname(workRepo);
    const git = simpleGit(parent);
    await git.clone(repoGitUrl(repoName), repoName);
  } else {
    const git = simpleGit(workRepo);
    try {
      await git.reset('hard');
      await git.pull('origin', 'main');
    } catch (err) {
      console.log(`[listicle] pull warning: ${err.message}, re-cloning`);
      await fsp.rm(workRepo, { recursive: true, force: true });
      const parent = path.dirname(workRepo);
      const g2 = simpleGit(parent);
      await g2.clone(repoGitUrl(repoName), repoName);
    }
  }
  return workRepo;
}

function yamlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function toYamlFrontMatter(obj) {
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
        if (item && typeof item === 'object') {
          const entries = Object.entries(item);
          if (entries.length === 0) continue;
          lines.push(`  - ${entries[0][0]}: ${yamlScalar(entries[0][1])}`);
          for (let i = 1; i < entries.length; i++) {
            lines.push(`    ${entries[i][0]}: ${yamlScalar(entries[i][1])}`);
          }
        } else {
          lines.push(`  - ${yamlScalar(item)}`);
        }
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

// Write /src/_data/listicles.json containing the full listicle set for this site,
// so 11ty can render "Featured in" callouts on review pages without rebuilding them.
async function writeListiclesDataFile(workRepo, siteId) {
  const listicles = await d1All(
    `SELECT id, slug, title, intro_markdown, outro_markdown, created_at
       FROM listicles WHERE site_id = ? ORDER BY created_at DESC`,
    [siteId]
  );
  const items = await d1All(
    `SELECT li.listicle_id, li.post_id, li.rank, li.blurb_markdown, p.slug AS post_slug
       FROM listicle_items li JOIN posts p ON p.id = li.post_id
      WHERE p.site_id = ? ORDER BY li.listicle_id, li.rank`,
    [siteId]
  );
  const byListicle = new Map();
  for (const it of items) {
    if (!byListicle.has(it.listicle_id)) byListicle.set(it.listicle_id, []);
    byListicle.get(it.listicle_id).push({
      post_slug: it.post_slug,
      rank: it.rank,
      blurb_markdown: it.blurb_markdown,
    });
  }
  const payload = listicles.map((l) => ({
    slug: l.slug,
    title: l.title,
    intro_markdown: l.intro_markdown,
    outro_markdown: l.outro_markdown || '',
    created_at: l.created_at,
    items: (byListicle.get(l.id) || []).sort((a, b) => a.rank - b.rank),
  }));
  const outPath = path.join(workRepo, 'src', '_data', 'listicles.json');
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');
}

export async function generateListicle({ site, targetItemCount }) {
  const { id: siteId, slug: siteSlug, product_category: category } = site;
  console.log(`[listicle] site=${siteSlug} category=${category}`);

  // 1. Load all published reviews for this site (top-scoring first).
  const reviews = await d1All(
    `SELECT id, slug, product_name, final_score, image_r2_key, image_source_url
       FROM posts WHERE site_id = ? ORDER BY final_score DESC`,
    [siteId]
  );
  if (reviews.length < 3) {
    throw new Error(`not enough reviews yet (have ${reviews.length}, need 3+)`);
  }

  // 2. Gather existing listicles to avoid repeats.
  const existingListicles = await d1All(
    `SELECT slug, title FROM listicles WHERE site_id = ?`,
    [siteId]
  );

  // 3. Ask the LLM for an angle + selection. Retry once with a harder
  //    anti-hallucination instruction if fewer than 3 valid items come back.
  const validSlugSet = new Set(reviews.map((r) => r.slug));
  let llmOut;
  let validSelected = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    llmOut = await llmGenerateListicle({
      category,
      reviews: reviews.map((r) => ({ slug: r.slug, product_name: r.product_name, final_score: r.final_score })),
      existingListicles,
      targetItemCount: targetItemCount || Math.min(5, reviews.length),
    });
    validSelected = llmOut.selected.filter((s) => validSlugSet.has(s.post_slug));
    if (validSelected.length >= 3) break;
    console.log(`[listicle] attempt ${attempt + 1}: only ${validSelected.length} valid selections, retrying with stricter guard`);
  }
  if (validSelected.length < 3) {
    throw new Error(`LLM produced fewer than 3 valid selections after retry (got ${validSelected.length})`);
  }
  // Dedupe and re-rank sequentially.
  const seen = new Set();
  validSelected = validSelected
    .filter((s) => { if (seen.has(s.post_slug)) return false; seen.add(s.post_slug); return true; })
    .sort((a, b) => a.rank - b.rank)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  // 4. Make sure slug is unique for this site. If conflict, append -2 etc.
  let slug = llmOut.slug || slugify(llmOut.title);
  const existingSlugs = new Set(existingListicles.map((l) => l.slug));
  if (existingSlugs.has(slug)) {
    let n = 2;
    while (existingSlugs.has(`${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }

  const title = llmOut.title;
  const introMd = llmOut.intro_markdown || `A curated look at the best ${category}.`;
  const outroMd = llmOut.outro_markdown || '';

  console.log(`[listicle] title="${title}" slug=${slug} items=${validSelected.length}`);

  // 5. Insert listicle + items into D1.
  const now = Date.now();
  const ins = await d1Run(
    `INSERT INTO listicles (site_id, slug, title, intro_markdown, outro_markdown, filters_json, item_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [siteId, slug, title, introMd, outroMd, JSON.stringify({ angle: llmOut.angle || '' }), validSelected.length, now]
  );
  const listicleId = ins.lastRowId;
  if (!listicleId) throw new Error('Failed to insert listicle');

  // Map post_slug -> post row
  const reviewBySlug = new Map(reviews.map((r) => [r.slug, r]));
  for (const sel of validSelected) {
    const post = reviewBySlug.get(sel.post_slug);
    if (!post) continue;
    await d1Run(
      `INSERT INTO listicle_items (listicle_id, post_id, rank, blurb_markdown)
       VALUES (?, ?, ?, ?)`,
      [listicleId, post.id, sel.rank, sel.blurb_markdown]
    );
  }

  // 6. Write the listicle markdown file and the listicles.json data file to the site repo.
  const workRepo = await ensureRepoClone(siteSlug);

  // Build front-matter with the selected items (with resolved product data).
  const itemsForFm = validSelected.map((s) => {
    const post = reviewBySlug.get(s.post_slug);
    return {
      rank: s.rank,
      post_slug: s.post_slug,
      product_name: post?.product_name || s.post_slug,
      final_score: post?.final_score || null,
      image: post?.image_r2_key || '',
      blurb_markdown: s.blurb_markdown,
    };
  });

  const fm = {
    title,
    slug,
    date: new Date(now).toISOString(),
    angle: llmOut.angle || '',
    intro_markdown: introMd,
    outro_markdown: outroMd,
    item_count: validSelected.length,
    items: itemsForFm,
  };
  const mdDir = path.join(workRepo, 'src', 'listicles');
  await fsp.mkdir(mdDir, { recursive: true });
  const mdPath = path.join(mdDir, `${slug}.md`);
  const frontMatter = toYamlFrontMatter(fm);
  // Body of the file is the intro markdown; the layout handles the items + outro separately.
  const body = `${introMd.trim()}\n`;
  await fsp.writeFile(mdPath, `---\n${frontMatter}---\n\n${body}`);

  // Refresh the listicles.json data file so review pages pick up cross-links.
  await writeListiclesDataFile(workRepo, siteId);

  // 7. Commit + push.
  const git = simpleGit(workRepo);
  await git.addConfig('user.email', 'fleetmanager@puckemerson.com', false, 'local');
  await git.addConfig('user.name', 'FleetManager Bot', false, 'local');
  await git.add('.');
  await git.commit(`Add listicle: ${title}`);
  await git.push('origin', 'main');
  const log = await git.log(['-1']);
  const commitSha = log?.latest?.hash || null;
  console.log(`[listicle] pushed ${commitSha}`);

  // Update commit_sha on the listicle row.
  if (commitSha) {
    await d1Run(`UPDATE listicles SET commit_sha = ? WHERE id = ?`, [commitSha, listicleId]);
  }

  return {
    listicle_id: listicleId,
    slug,
    title,
    item_count: validSelected.length,
    commit_sha: commitSha,
  };
}
