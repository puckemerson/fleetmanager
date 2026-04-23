// Anthropic LLM wrapper.
import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from './config.js';

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
  return client;
}

// Candidate models. We'll fall back if the first isn't available.
const MODEL_CANDIDATES = [
  CONFIG.LLM_MODEL,
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022',
];

async function completeWithFallback({ system, messages, max_tokens }) {
  const c = getClient();
  let lastErr;
  const seen = new Set();
  for (const m of MODEL_CANDIDATES) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    try {
      const res = await c.messages.create({
        model: m,
        max_tokens: max_tokens || 2048,
        system,
        messages,
      });
      return { model: m, text: textOf(res) };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      // If it's a model-not-found, try the next one. Otherwise rethrow.
      if (!/model|not.*found|invalid|404/i.test(msg)) throw err;
    }
  }
  throw lastErr || new Error('No working model');
}

function textOf(res) {
  if (!res || !Array.isArray(res.content)) return '';
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function proposeProducts(category, excludedSlugs, n = 10) {
  const sys = `You are a product research assistant. Given a product category, propose ${n} well-known, widely reviewed, currently available products in that category. Output strict JSON only: {"products": [{"name": "Full Product Name", "slug": "kebab-case-slug"}]}. No prose, no markdown fences.`;
  const exclusion = excludedSlugs && excludedSlugs.length
    ? `\n\nDo NOT suggest any product whose slug matches one of these (already reviewed): ${excludedSlugs.slice(0, 50).join(', ')}.`
    : '';
  const user = `Category: ${category}${exclusion}\n\nReturn ${n} candidates as strict JSON.`;
  const { text } = await completeWithFallback({
    system: sys,
    messages: [{ role: 'user', content: user }],
    max_tokens: 1500,
  });
  const json = extractJson(text);
  if (!json || !Array.isArray(json.products)) throw new Error('LLM product proposal invalid');
  return json.products
    .map((p) => ({ name: String(p.name || '').trim(), slug: slugify(String(p.slug || p.name || '')) }))
    .filter((p) => p.name && p.slug);
}

export async function synthesizeReview({ productName, category, searchSnippets }) {
  const snippets = (searchSnippets || []).slice(0, 6)
    .map((s, i) => `[${i + 1}] ${s.title || ''}\n${s.url || ''}\n${(s.snippet || '').slice(0, 500)}`)
    .join('\n\n');
  const sys = `You are a thoughtful product reviewer. You synthesize publicly available information into honest, first-person reviews.

Rules:
- Write from first person ("I", "my") but do not invent personal-life details. Refer to your use of the product in general terms.
- Ground every specific claim in the provided search snippets. If a detail isn't in the snippets, don't invent numbers or specs.
- Pick 3-5 scoring categories that actually matter for this specific product. Weights must sum to 1.0. Scores are 0-100 integers.
- Tone: measured, specific, avoid marketing phrases. No hype words like "revolutionary", "game-changing", "must-have".
- Length: 400-700 words of review body in markdown.
- Output strict JSON only, no prose before or after, no markdown fences.

Output JSON shape:
{
  "categories": [ {"name": "string", "weight": 0.0, "score": 0, "rationale": "1-2 sentences"}, ... ],
  "final_score": <integer 0-100, weighted average of category scores rounded>,
  "markdown": "Full first-person review in markdown, 400-700 words, no H1 (that's added by the template)."
}`;
  const user = `Product: ${productName}
Category: ${category}

Research snippets (from recent search results):
${snippets || '(no snippets available — rely on general knowledge but keep claims conservative)'}

Write the review and scoring now. Strict JSON only.`;
  const { text } = await completeWithFallback({
    system: sys,
    messages: [{ role: 'user', content: user }],
    max_tokens: 3200,
  });
  const json = extractJson(text);
  if (!json || !Array.isArray(json.categories) || typeof json.markdown !== 'string') {
    throw new Error('LLM review output invalid: ' + text.slice(0, 200));
  }
  // Validate
  const cats = json.categories
    .map((c) => ({
      name: String(c.name || '').trim(),
      weight: Number(c.weight) || 0,
      score: Math.round(Number(c.score) || 0),
      rationale: String(c.rationale || '').trim(),
    }))
    .filter((c) => c.name);
  if (cats.length === 0) throw new Error('No categories in review');
  // Normalize weights if off
  const weightSum = cats.reduce((s, c) => s + c.weight, 0);
  if (weightSum > 0 && Math.abs(weightSum - 1) > 0.02) {
    for (const c of cats) c.weight = c.weight / weightSum;
  }
  const computedFinal = Math.round(cats.reduce((s, c) => s + c.score * c.weight, 0));
  const finalScore = Number.isFinite(Number(json.final_score)) ? Math.round(Number(json.final_score)) : computedFinal;
  return {
    categories: cats,
    final_score: Math.max(0, Math.min(100, finalScore)),
    markdown: json.markdown.trim(),
  };
}

export async function generateListicle({ category, reviews, existingListicles, targetItemCount }) {
  // reviews: array of { slug, product_name, final_score }
  // existingListicles: array of { title, slug }
  const want = Math.max(3, Math.min(Number(targetItemCount) || 5, reviews.length));
  const sys = `You are an editorial curator for a product review site. Your job: pick a compelling "Best X for Y" angle that groups a subset of already-reviewed products into a useful listicle.

Rules:
- Output strict JSON only. No prose before or after. No markdown fences.
- Pick an angle that actually fits the products provided. Don't force it.
- Choose between 3 and ${want} products from the provided list. ONLY use product slugs from the list below — do not invent products that don't exist.
- Rank them deliberately (1 = best fit for the angle, not just the highest score).
- Write a 2-3 sentence intro framing the angle. Write a 1-2 sentence outro.
- Write a 1-2 sentence blurb per item explaining why this product fits the angle (not a generic restatement of the review).
- Title should read naturally, like "The Best Perfumes for Winter" or "Five Bold Fragrances Worth the Investment".
- Do not repeat a title/slug already used by this site.
- Tone: measured, specific, editorial. Avoid hype words.

Output shape:
{
  "title": "string",
  "slug": "kebab-case-slug",
  "angle": "one-line description of the angle",
  "intro_markdown": "string",
  "outro_markdown": "string",
  "selected": [
    {"post_slug": "existing-product-slug", "rank": 1, "blurb_markdown": "string"}
  ]
}`;
  const reviewList = reviews
    .map((r) => `- ${r.product_name} (slug: ${r.slug}, score: ${r.final_score})`)
    .join('\n');
  const existing = existingListicles && existingListicles.length
    ? `\n\nListicles that already exist on this site (avoid repeating these angles / slugs):\n${existingListicles.map((l) => `- ${l.title} (slug: ${l.slug})`).join('\n')}`
    : '';
  const user = `Site category: ${category}
Target listicle length: aim for ${want} items (minimum 3).

Available reviewed products (use ONLY these slugs in "selected"):
${reviewList}${existing}

Pick an angle, write the listicle. Strict JSON only.`;
  const { text } = await completeWithFallback({
    system: sys,
    messages: [{ role: 'user', content: user }],
    max_tokens: 2500,
  });
  const json = extractJson(text);
  if (!json || !json.title || !json.slug || !Array.isArray(json.selected)) {
    throw new Error('LLM listicle output invalid: ' + text.slice(0, 300));
  }
  // Normalize
  json.slug = slugify(json.slug);
  json.title = String(json.title).trim();
  json.angle = String(json.angle || '').trim();
  json.intro_markdown = String(json.intro_markdown || '').trim();
  json.outro_markdown = String(json.outro_markdown || '').trim();
  json.selected = json.selected
    .map((s, i) => ({
      post_slug: slugify(String(s.post_slug || '')),
      rank: Number(s.rank) || i + 1,
      blurb_markdown: String(s.blurb_markdown || '').trim(),
    }))
    .filter((s) => s.post_slug && s.blurb_markdown);
  return json;
}

export async function siteTaglineAndAbout(category) {
  const sys = `You write short, tasteful editorial copy for independent review sites. Output strict JSON only.`;
  const user = `For a review site focused on the category "${category}", produce:
{
  "title": "short catchy site name (1-4 words, evocative not generic)",
  "tagline": "one sentence (max 12 words) stating what the site does",
  "about": "one paragraph (3-5 sentences) about the site's approach to ${category} reviews"
}
Strict JSON only.`;
  try {
    const { text } = await completeWithFallback({
      system: sys,
      messages: [{ role: 'user', content: user }],
      max_tokens: 500,
    });
    const json = extractJson(text);
    if (json?.title && json?.tagline && json?.about) return json;
  } catch (_) {}
  // Fallback
  const cap = category.charAt(0).toUpperCase() + category.slice(1);
  return {
    title: `${cap} Review`,
    tagline: `Honest, unhurried reviews of ${category}.`,
    about: `This is an independent review site focused on ${category}. Each review is a first-person take, grounded in research from across the web, scored on criteria that matter for the specific product.`,
  };
}

function extractJson(text) {
  if (!text) return null;
  // Strip common fence wrappers
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  // Find first { and last }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const s = t.slice(i, j + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
