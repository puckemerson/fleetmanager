// Search and fetch utilities. Primary: Wikipedia REST (reliable, no blocking).
// Secondary: DuckDuckGo HTML (often blocked on server IPs; we still try).
import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const WIKI_UA = 'FleetManager/1.0 (https://github.com/puckemerson/fleetmanager)';

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return fetch(url, {
    ...opts,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(ms),
    redirect: 'follow',
  });
}

/** Wikipedia-based research: search, then fetch summary/extract of top hit(s). */
export async function searchWikipedia(query, limit = 3) {
  try {
    const u = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&format=json`;
    const r = await fetch(u, { headers: { 'User-Agent': WIKI_UA }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length < 4) return [];
    const titles = arr[1];
    const urls = arr[3];
    const out = [];
    for (let i = 0; i < titles.length; i++) {
      try {
        const t = titles[i];
        const sum = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`, {
          headers: { 'User-Agent': WIKI_UA },
          signal: AbortSignal.timeout(10000),
        });
        if (!sum.ok) continue;
        const j = await sum.json();
        out.push({
          title: j.title || t,
          url: urls[i],
          snippet: (j.extract || '').slice(0, 1000),
          source: 'wikipedia',
        });
      } catch (_) {}
    }
    return out;
  } catch (_) { return []; }
}

/** DDG HTML search (best effort; often blocked on server IPs). */
export async function searchDdg(query, limit = 8) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!res.ok) return [];
    const html = await res.text();
    if (/anomaly-modal/.test(html)) return [];
    const $ = cheerio.load(html);
    const results = [];
    $('.result').each((_, el) => {
      const a = $(el).find('a.result__a').first();
      const title = a.text().trim();
      let href = a.attr('href') || '';
      try {
        if (href.startsWith('//')) href = 'https:' + href;
        const u = new URL(href, 'https://duckduckgo.com');
        const real = u.searchParams.get('uddg');
        if (real) href = decodeURIComponent(real);
      } catch (_) {}
      const snippet = $(el).find('.result__snippet').text().trim();
      if (title && href) results.push({ title, url: href, snippet, source: 'ddg' });
    });
    return results.slice(0, limit);
  } catch (_) { return []; }
}

/** Combined web search: Wikipedia first (always works), DDG as bonus. */
export async function searchWeb(query, limit = 8) {
  const [wiki, ddg] = await Promise.all([
    searchWikipedia(query, 3),
    searchDdg(query, limit),
  ]);
  const all = [...wiki, ...ddg];
  // de-dup by URL
  const seen = new Set();
  return all.filter((r) => { if (seen.has(r.url)) return false; seen.add(r.url); return true; }).slice(0, limit);
}

export async function fetchPage(url, ms = 15000) {
  const res = await fetchWithTimeout(url, {}, ms);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('html') && !ct.includes('text')) throw new Error(`not html: ${ct}`);
  return await res.text();
}

/** Extract readable text + og:image from page HTML. */
export function extractPage(html) {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
  // Strip script/style
  $('script, style, noscript, iframe, header, footer, nav').remove();
  const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
  const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  // Grab main article if exists else body
  const main = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const text = main.text().replace(/\s+/g, ' ').trim().slice(0, 3500);
  return { title, desc, text, ogImage: og || null };
}

/** DDG image search fallback. Uses duckduckgo.com token flow. */
export async function searchImages(query, limit = 5) {
  const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iar=images&iax=images&ia=images`;
  let vqd = null;
  try {
    const r = await fetchWithTimeout(tokenUrl);
    const html = await r.text();
    const m = html.match(/vqd=['"]([\d-]+)['"]/) || html.match(/vqd=([\d-]+)&/);
    if (m) vqd = m[1];
  } catch (_) {}
  if (!vqd) return [];
  const api = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=-1`;
  try {
    const r = await fetchWithTimeout(api, { headers: { Referer: 'https://duckduckgo.com/' } });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || []).slice(0, limit).map((x) => ({
      image: x.image,
      source: x.source,
      url: x.url,
      title: x.title,
      width: x.width,
      height: x.height,
    }));
  } catch (_) {
    return [];
  }
}

/** Fetch binary. Returns Buffer or null on failure. */
export async function fetchBinary(url, ms = 20000) {
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'image/*,*/*' } }, ms);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentType: ct };
  } catch (_) {
    return null;
  }
}

/** Orchestrated image pipeline: try to find one good product image. */
export async function findProductImage(productName) {
  const q = `${productName} product photo`;
  // Try web search first; look for og:image on top results.
  try {
    const hits = await searchWeb(q, 5);
    for (const h of hits.slice(0, 3)) {
      try {
        const html = await fetchPage(h.url, 10000);
        const ext = extractPage(html);
        if (ext.ogImage) {
          const img = await fetchBinary(ext.ogImage, 15000);
          if (img && img.buffer.length > 5000) return { buffer: img.buffer, contentType: img.contentType || 'image/jpeg', sourceUrl: h.url, imageUrl: ext.ogImage };
        }
      } catch (_) {}
    }
  } catch (_) {}
  // Fallback: DDG image search
  try {
    const imgs = await searchImages(productName, 5);
    for (const i of imgs) {
      const got = await fetchBinary(i.image, 15000);
      if (got && got.buffer.length > 5000) return { buffer: got.buffer, contentType: got.contentType || 'image/jpeg', sourceUrl: i.url || i.source, imageUrl: i.image };
    }
  } catch (_) {}
  return null;
}
