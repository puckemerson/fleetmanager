import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';
// @ts-ignore: shared JS module, no type declarations
import { resolveAffiliateUrl, detectRetailer } from '../../shared/affiliate.js';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  DASHBOARD_PASSWORD_HASH: string;
  GITHUB_PAT: string;
};

type Variables = {
  userId: number;
  username: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const SESSION_COOKIE = 'fm_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const FIXED_USERNAME = 'will';

function nowMs() { return Date.now(); }

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function ensureUser(db: D1Database, passwordHash: string): Promise<number> {
  const row = await db.prepare('SELECT id FROM users WHERE username = ?').bind(FIXED_USERNAME).first<{ id: number }>();
  if (row) return row.id;
  const res = await db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .bind(FIXED_USERNAME, passwordHash, nowMs()).run();
  return Number(res.meta.last_row_id);
}

async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomToken();
  const createdAt = nowMs();
  const expiresAt = createdAt + SESSION_TTL_MS;
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, createdAt, expiresAt).run();
  return token;
}

async function getSessionUser(db: D1Database, token: string | undefined): Promise<{ id: number; username: string } | null> {
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id as id, u.username as username, s.expires_at as expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`).bind(token).first<{ id: number; username: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < nowMs()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { id: row.id, username: row.username };
}

function setSessionCookie(c: any, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

async function requireAuth(c: any, next: any) {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await getSessionUser(c.env.DB, token);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('userId', user.id);
  c.set('username', user.username);
  await next();
}

// --- Health (unauthenticated) ---

app.get('/health', async (c) => {
  const checks: Record<string, string> = {};

  try {
    await c.env.DB.prepare('SELECT 1').first();
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  const status = Object.values(checks).includes('error') ? 'unhealthy' : 'healthy';
  return c.json({
    status,
    service: 'fleetmanager',
    timestamp: Date.now(),
    checks,
  }, status === 'unhealthy' ? 503 : 200);
});

// --- Auth ---

app.post('/api/login', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const username = (body?.username ?? '').toString().trim().toLowerCase();
  const password = (body?.password ?? '').toString();
  if (username !== FIXED_USERNAME) return c.json({ error: 'invalid credentials' }, 401);
  const hash = c.env.DASHBOARD_PASSWORD_HASH;
  if (!hash) return c.json({ error: 'server not configured' }, 500);
  const ok = await bcrypt.compare(password, hash);
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);
  const userId = await ensureUser(c.env.DB, hash);
  const token = await createSession(c.env.DB, userId);
  setSessionCookie(c, token);
  return c.json({ id: userId, username: FIXED_USERNAME });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', requireAuth, async (c) => {
  return c.json({ id: c.get('userId'), username: c.get('username') });
});

// --- Sites ---

app.get('/api/sites', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, 
       (SELECT MAX(created_at) FROM posts p WHERE p.site_id = s.id) AS last_post_at,
       (SELECT COUNT(*) FROM posts p WHERE p.site_id = s.id) AS post_count
     FROM sites s ORDER BY s.created_at DESC`
  ).all();
  return c.json({ sites: results ?? [] });
});

app.post('/api/sites', requireAuth, async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const productCategory = (body?.product_category ?? '').toString().trim();
  const cronSpec = (body?.cron_spec ?? 'weekly').toString().trim();
  const hostingProvider = (body?.hosting_provider ?? 'github_pages').toString().trim();
  const themeFamily = (body?.theme_family ?? 'eleventy_classic').toString().trim();
  const validHosting = ['github_pages', 'vercel'];
  const validThemes = ['eleventy_classic', 'astro_magazine', 'hugo_minimal'];
  if (!validHosting.includes(hostingProvider)) return c.json({ error: 'invalid hosting_provider' }, 400);
  if (!validThemes.includes(themeFamily)) return c.json({ error: 'invalid theme_family' }, 400);
  let slug = (body?.slug ?? '').toString().trim();
  if (!productCategory || productCategory.length > 60) return c.json({ error: 'invalid product_category' }, 400);
  if (!slug) slug = slugify(productCategory) + '-' + Math.random().toString(36).slice(2, 6);
  slug = slugify(slug);
  if (!slug) return c.json({ error: 'invalid slug' }, 400);

  const exists = await c.env.DB.prepare('SELECT id FROM sites WHERE slug = ?').bind(slug).first();
  if (exists) return c.json({ error: 'slug already exists' }, 409);

  const now = nowMs();
  const res = await c.env.DB.prepare(
    `INSERT INTO sites (slug, product_category, repo_url, site_url, theme_json, cron_spec, next_run_at, status, hosting_provider, theme_family, created_at)
     VALUES (?, ?, '', '', '{}', ?, ?, 'active', ?, ?, ?)`
  ).bind(slug, productCategory, cronSpec, now, hostingProvider, themeFamily, now).run();

  const siteId = Number(res.meta.last_row_id);

  // Queue scaffold job
  await c.env.DB.prepare(
    `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'scaffold_site', 'queued', ?)`
  ).bind(siteId, now).run();

  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(siteId).first();
  return c.json({ site });
});

app.get('/api/sites/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  const posts = await c.env.DB.prepare(
    'SELECT id, product_name, slug, final_score, category_scores_json, image_r2_key, image_source_url, created_at FROM posts WHERE site_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(id).all();
  const jobs = await c.env.DB.prepare(
    'SELECT id, kind, status, scheduled_for, started_at, finished_at, error FROM jobs WHERE site_id = ? ORDER BY id DESC LIMIT 20'
  ).bind(id).all();
  // Augment site with post_count so the UI can render "Seed burst: N/10".
  const postCountRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE site_id = ?').bind(id).first<any>();
  (site as any).post_count = Number(postCountRow?.n || 0);
  // Pending burst generate_post jobs still in the queue (for UI progress).
  const pendingRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE site_id = ? AND kind = 'generate_post' AND status = 'queued'"
  ).bind(id).first<any>();
  (site as any).pending_burst_jobs = Number(pendingRow?.n || 0);
  return c.json({ site, posts: posts.results ?? [], jobs: jobs.results ?? [] });
});

app.patch('/api/sites/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const existing = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const updates: string[] = [];
  const binds: any[] = [];
  if (typeof body.cron_spec === 'string') { updates.push('cron_spec = ?'); binds.push(body.cron_spec); }
  if (typeof body.hosting_provider === 'string') {
    if (!['github_pages', 'vercel'].includes(body.hosting_provider)) return c.json({ error: 'invalid hosting_provider' }, 400);
    updates.push('hosting_provider = ?'); binds.push(body.hosting_provider);
  }
  if (typeof body.theme_family === 'string') {
    if (!['eleventy_classic', 'astro_magazine', 'hugo_minimal'].includes(body.theme_family)) return c.json({ error: 'invalid theme_family' }, 400);
    updates.push('theme_family = ?'); binds.push(body.theme_family);
  }
  if (typeof body.status === 'string' && ['active', 'archived', 'paused'].includes(body.status)) {
    updates.push('status = ?'); binds.push(body.status);
  }
  if (body.listicle_ratio != null) {
    const r = Number(body.listicle_ratio);
    if (!Number.isInteger(r) || r < 1 || r > 10000) return c.json({ error: 'invalid listicle_ratio' }, 400);
    updates.push('listicle_ratio = ?'); binds.push(r);
  }
  if (typeof body.image_style_prompt === 'string' || body.image_style_prompt === null) {
    updates.push('image_style_prompt = ?'); binds.push(body.image_style_prompt || null);
  }
  if (updates.length === 0) return c.json({ error: 'nothing to update' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return c.json({ site });
});

app.get('/api/sites/:id/listicles', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first();
  if (!site) return c.json({ error: 'not found' }, 404);
  const listicles = await c.env.DB.prepare(
    `SELECT l.id, l.slug, l.title, l.intro_markdown, l.outro_markdown, l.item_count, l.commit_sha, l.created_at,
            (SELECT COUNT(*) FROM listicle_items li WHERE li.listicle_id = l.id) AS actual_item_count
       FROM listicles l WHERE l.site_id = ? ORDER BY l.created_at DESC`
  ).bind(id).all();
  const rows = listicles.results ?? [];
  // Attach items for each listicle
  const out: any[] = [];
  for (const l of rows) {
    const items = await c.env.DB.prepare(
      `SELECT li.rank, li.blurb_markdown, p.slug AS post_slug, p.product_name, p.final_score
         FROM listicle_items li JOIN posts p ON p.id = li.post_id
        WHERE li.listicle_id = ? ORDER BY li.rank`
    ).bind((l as any).id).all();
    out.push({ ...l, items: items.results ?? [] });
  }
  return c.json({ listicles: out });
});

app.post('/api/sites/:id/generate-listicle-now', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const site = await c.env.DB.prepare('SELECT id, status FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  if (site.status === 'archived') return c.json({ error: 'site archived' }, 400);
  const postCountRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE site_id = ?').bind(id).first<any>();
  const postCount = Number(postCountRow?.n) || 0;
  if (postCount < 3) return c.json({ error: `need at least 3 reviews to generate a listicle (have ${postCount})` }, 400);
  await c.env.DB.prepare(
    `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_listicle', 'queued', ?)`
  ).bind(id, nowMs()).run();
  return c.json({ ok: true });
});

app.delete('/api/sites/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare("UPDATE sites SET status = 'archived', next_run_at = NULL WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.post('/api/posts/:postId/regenerate-image', requireAuth, async (c) => {
  const postId = Number(c.req.param('postId'));
  if (!Number.isInteger(postId) || postId <= 0) return c.json({ error: 'invalid post id' }, 400);
  const post = await c.env.DB.prepare('SELECT id, site_id FROM posts WHERE id = ?').bind(postId).first<any>();
  if (!post) return c.json({ error: 'post not found' }, 404);
  await c.env.DB.prepare(
    `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, ?, 'queued', ?)`
  ).bind(post.site_id, `regenerate_post_image:${postId}`, nowMs()).run();
  return c.json({ ok: true });
});

app.post('/api/sites/:id/generate-now', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const site = await c.env.DB.prepare('SELECT id, status FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  if (site.status === 'archived') return c.json({ error: 'site archived' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO jobs (site_id, kind, status, scheduled_for) VALUES (?, 'generate_post', 'queued', ?)`
  ).bind(id, nowMs()).run();
  return c.json({ ok: true });
});

// --- Affiliate programs ---

app.get('/api/sites/:id/affiliate-programs', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first();
  if (!site) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT id, program, config_json, enabled, created_at
       FROM affiliate_programs WHERE site_id = ? ORDER BY program`
  ).bind(id).all();
  return c.json({ programs: results ?? [] });
});

app.put('/api/sites/:id/affiliate-programs/:program', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const program = String(c.req.param('program') || '').toLowerCase();
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const valid = ['amazon', 'skimlinks', 'sharesasale', 'shareasale', 'generic'];
  if (!valid.includes(program)) return c.json({ error: 'invalid program' }, 400);
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first();
  if (!site) return c.json({ error: 'not found' }, 404);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const cfg = body?.config && typeof body.config === 'object' ? body.config : {};
  const enabled = body?.enabled === false ? 0 : 1;
  const existing = await c.env.DB.prepare(
    'SELECT id FROM affiliate_programs WHERE site_id = ? AND program = ?'
  ).bind(id, program).first<any>();
  if (existing) {
    await c.env.DB.prepare(
      'UPDATE affiliate_programs SET config_json = ?, enabled = ? WHERE id = ?'
    ).bind(JSON.stringify(cfg), enabled, existing.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO affiliate_programs (site_id, program, config_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, program, JSON.stringify(cfg), enabled, nowMs()).run();
  }
  const prog = await c.env.DB.prepare(
    'SELECT id, program, config_json, enabled, created_at FROM affiliate_programs WHERE site_id = ? AND program = ?'
  ).bind(id, program).first();
  return c.json({ program: prog });
});

app.delete('/api/sites/:id/affiliate-programs/:program', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const program = String(c.req.param('program') || '').toLowerCase();
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  await c.env.DB.prepare(
    'DELETE FROM affiliate_programs WHERE site_id = ? AND program = ?'
  ).bind(id, program).run();
  return c.json({ ok: true });
});

app.patch('/api/sites/:id/disclosure', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const site = await c.env.DB.prepare('SELECT id FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  const updates: string[] = [];
  const binds: any[] = [];
  if (typeof body.enabled === 'boolean' || body.enabled === 0 || body.enabled === 1) {
    updates.push('affiliate_disclosure_enabled = ?');
    binds.push(body.enabled ? 1 : 0);
  }
  if (typeof body.text === 'string' || body.text === null) {
    updates.push('affiliate_disclosure_text = ?');
    binds.push(body.text || null);
  }
  if (updates.length === 0) return c.json({ error: 'nothing to update' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  const out = await c.env.DB.prepare(
    'SELECT affiliate_disclosure_enabled, affiliate_disclosure_text FROM sites WHERE id = ?'
  ).bind(id).first();
  return c.json({ site: out });
});

app.get('/api/sites/:id/clicks', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  const days = Math.max(1, Math.min(90, Number(c.req.query('days') || 7)));
  const since = nowMs() - days * 24 * 60 * 60 * 1000;
  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM clicks WHERE site_id = ? AND clicked_at >= ?'
  ).bind(id, since).first<any>();
  const byRetailer = await c.env.DB.prepare(
    `SELECT retailer, COUNT(*) AS n FROM clicks
      WHERE site_id = ? AND clicked_at >= ?
      GROUP BY retailer ORDER BY n DESC`
  ).bind(id, since).all();
  const byPost = await c.env.DB.prepare(
    `SELECT post_id, COUNT(*) AS n FROM clicks
      WHERE site_id = ? AND clicked_at >= ? AND post_id IS NOT NULL
      GROUP BY post_id ORDER BY n DESC LIMIT 20`
  ).bind(id, since).all();
  return c.json({
    days,
    total: Number(total?.n || 0),
    by_retailer: byRetailer.results || [],
    by_post: byPost.results || [],
  });
});

// --- Custom domain ---

const GH_API = 'https://api.github.com';
const GH_USER = 'puckemerson';
const GH_PAGES_IPS = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
const GH_PAGES_AAAA = ['2606:50c0:8000::153', '2606:50c0:8001::153', '2606:50c0:8002::153', '2606:50c0:8003::153'];

async function ghFetch(c: any, path: string, opts: any = {}) {
  const pat = c.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT not configured in Worker secrets');
  const res = await fetch(GH_API + path, {
    ...opts,
    headers: {
      Authorization: `token ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fleetmanager-dashboard',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function isValidDomain(d: string): boolean {
  return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(d);
}

function isApexDomain(d: string): boolean {
  // Apex = only one dot (e.g. mysite.com vs reviews.mysite.com)
  return d.split('.').length === 2;
}

function buildDnsInstructions(domain: string): object {
  if (isApexDomain(domain)) {
    return {
      type: 'apex',
      domain,
      records: [
        ...GH_PAGES_IPS.map(ip => ({ type: 'A', name: '@', value: ip })),
        ...GH_PAGES_AAAA.map(ip => ({ type: 'AAAA', name: '@', value: ip })),
      ],
      instructions: `For apex domain ${domain}, add these DNS records at your registrar/DNS provider:\n\n` +
        GH_PAGES_IPS.map(ip => `Type: A\nName: @\nValue: ${ip}`).join('\n\n') + '\n\n' +
        GH_PAGES_AAAA.map(ip => `Type: AAAA\nName: @\nValue: ${ip}`).join('\n\n'),
    };
  } else {
    const parts = domain.split('.');
    const sub = parts.slice(0, parts.length - 2).join('.');
    return {
      type: 'subdomain',
      domain,
      records: [{ type: 'CNAME', name: sub, value: `${GH_USER}.github.io` }],
      instructions: `For subdomain ${domain}:\n\nType: CNAME\nName: ${sub}\nValue: ${GH_USER}.github.io`,
    };
  }
}

app.put('/api/sites/:id/custom-domain', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
  const domain = (body?.domain ?? '').toString().trim().toLowerCase();
  if (!domain || !isValidDomain(domain)) return c.json({ error: 'invalid domain format' }, 400);

  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  if (!site.slug) return c.json({ error: 'site not yet scaffolded' }, 400);

  const slug = site.slug as string;

  // Write CNAME file to repo
  try {
    // Check if file already exists (need SHA for update)
    let existingSha: string | undefined;
    try {
      const existing = await ghFetch(c, `/repos/${GH_USER}/${slug}/contents/CNAME`);
      existingSha = existing.sha;
    } catch { /* not found is fine */ }

    const fileBody: any = {
      message: `Set custom domain: ${domain}`,
      content: btoa(domain + '\n'),
      branch: 'main',
    };
    if (existingSha) fileBody.sha = existingSha;
    await ghFetch(c, `/repos/${GH_USER}/${slug}/contents/CNAME`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fileBody),
    });
  } catch (err: any) {
    return c.json({ error: `Failed to write CNAME file: ${err.message}` }, 500);
  }

  // Set GitHub Pages CNAME via API
  try {
    await ghFetch(c, `/repos/${GH_USER}/${slug}/pages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cname: domain }),
    });
  } catch (err: any) {
    // Non-fatal: GH Pages API sometimes requires a moment after CNAME commit
    console.warn(`[custom-domain] GH Pages API PUT warning: ${err.message}`);
  }

  // Save to D1
  await c.env.DB.prepare(
    'UPDATE sites SET custom_domain = ?, custom_domain_status = ?, site_url = ? WHERE id = ?'
  ).bind(domain, 'pending_dns', `https://${domain}`, id).run();

  const dns = buildDnsInstructions(domain);
  const updated = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return c.json({ site: updated, dns_instructions: dns });
});

app.post('/api/sites/:id/verify-domain', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);
  if (!site.custom_domain) return c.json({ error: 'no custom domain set' }, 400);

  let ghPages: any = null;
  try {
    ghPages = await ghFetch(c, `/repos/${GH_USER}/${site.slug}/pages`);
  } catch (err: any) {
    return c.json({ status: 'error', message: `Could not fetch GitHub Pages info: ${err.message}` });
  }

  const ghCname = (ghPages?.cname ?? '').toString().toLowerCase().trim();
  const ourDomain = (site.custom_domain as string).toLowerCase().trim();
  const certState = ghPages?.https_certificate?.state ?? 'unknown';

  if (ghCname !== ourDomain) {
    return c.json({
      status: 'pending',
      message: `GitHub Pages CNAME is '${ghCname || '(none)'}', expected '${ourDomain}'. DNS may still be propagating.`,
      cert_state: certState,
    });
  }

  // CNAME matches — check cert
  const isActive = ['approved', 'valid'].some(s => certState.toLowerCase().includes(s));
  if (isActive) {
    await c.env.DB.prepare('UPDATE sites SET custom_domain_status = ? WHERE id = ?')
      .bind('active', id).run();
    return c.json({ status: 'active', message: 'Domain is active and HTTPS certificate is ready.', cert_state: certState });
  }

  // CNAME matches but cert not ready yet
  await c.env.DB.prepare('UPDATE sites SET custom_domain_status = ? WHERE id = ?')
    .bind('pending_dns', id).run();
  return c.json({ status: 'pending_dns', message: `CNAME matches but HTTPS certificate is not ready yet (state: ${certState}). Try again in a few minutes.`, cert_state: certState });
});

app.delete('/api/sites/:id/custom-domain', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);

  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first<any>();
  if (!site) return c.json({ error: 'not found' }, 404);

  const slug = site.slug as string;

  // Remove CNAME file from repo
  try {
    const existing = await ghFetch(c, `/repos/${GH_USER}/${slug}/contents/CNAME`);
    if (existing?.sha) {
      await ghFetch(c, `/repos/${GH_USER}/${slug}/contents/CNAME`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Remove custom domain',
          sha: existing.sha,
          branch: 'main',
        }),
      });
    }
  } catch (err: any) {
    if (!String(err.message).includes('404')) {
      console.warn(`[custom-domain] delete CNAME file warning: ${err.message}`);
    }
  }

  // Clear GH Pages CNAME
  try {
    await ghFetch(c, `/repos/${GH_USER}/${slug}/pages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cname: null }),
    });
  } catch (err: any) {
    console.warn(`[custom-domain] clear GH Pages CNAME warning: ${err.message}`);
  }

  // Restore site_url to GitHub Pages URL and clear domain fields
  const ghPagesUrl = `https://${GH_USER}.github.io/${slug}/`;
  await c.env.DB.prepare(
    'UPDATE sites SET custom_domain = NULL, custom_domain_status = \'none\', site_url = ? WHERE id = ?'
  ).bind(ghPagesUrl, id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return c.json({ site: updated });
});

// Unknown API routes
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// --- Click tracker: /go/:site/:post/:retailer or /go/:site/listicle/:listicle/:post/:retailer ---

async function recordAndRedirect(c: any, params: {
  siteSlug: string;
  postSlug: string;
  retailer: string;
  listicleSlug?: string;
}): Promise<Response> {
  const db: D1Database = c.env.DB;
  const site = await db.prepare('SELECT id, status FROM sites WHERE slug = ?').bind(params.siteSlug).first<any>();
  if (!site) return c.text('unknown site', 404);
  const post = await db.prepare('SELECT id FROM posts WHERE site_id = ? AND slug = ?')
    .bind(site.id, params.postSlug).first<any>();
  if (!post) return c.text('unknown post', 404);
  // Retailer link lookup.
  let linkRow: any = null;
  if (params.retailer) {
    linkRow = await db.prepare(
      'SELECT url FROM retailer_links WHERE post_id = ? AND retailer = ? ORDER BY id DESC LIMIT 1'
    ).bind(post.id, params.retailer).first<any>();
  }
  if (!linkRow) {
    // Fallback: any retailer_link for the post.
    linkRow = await db.prepare(
      'SELECT url, retailer FROM retailer_links WHERE post_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(post.id).first<any>();
  }
  if (!linkRow) return c.text('no retailer link for post', 404);
  const retailer = linkRow.retailer || params.retailer;
  // Resolve affiliate URL using the site's programs.
  const progRows = await db.prepare(
    `SELECT program, config_json, enabled FROM affiliate_programs WHERE site_id = ? AND enabled = 1`
  ).bind(site.id).all();
  const destination = resolveAffiliateUrl({
    retailer,
    rawUrl: linkRow.url,
    programs: progRows.results || [],
  });
  // Resolve listicle_id (if any).
  let listicleId: number | null = null;
  if (params.listicleSlug) {
    const l = await db.prepare('SELECT id FROM listicles WHERE site_id = ? AND slug = ?')
      .bind(site.id, params.listicleSlug).first<any>();
    listicleId = l?.id ?? null;
  }
  // Fire-and-forget insert into clicks.
  const ua = c.req.header('user-agent') || null;
  const referer = c.req.header('referer') || null;
  const country = (c.req.raw.cf as any)?.country || null;
  const insertPromise = db.prepare(
    `INSERT INTO clicks (site_id, post_id, listicle_id, retailer, destination_url, user_agent, ip_country, referer, clicked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(site.id, post.id, listicleId, retailer, destination, ua, country, referer, nowMs()).run();
  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(insertPromise);
  } else {
    // Fall back to awaiting (no event ctx in tests).
    try { await insertPromise; } catch {}
  }
  return c.redirect(destination, 302);
}

app.get('/go/:site/listicle/:listicle/:post/:retailer', async (c) => {
  return recordAndRedirect(c, {
    siteSlug: c.req.param('site'),
    listicleSlug: c.req.param('listicle'),
    postSlug: c.req.param('post'),
    retailer: c.req.param('retailer'),
  });
});

app.get('/go/:site/:post/:retailer', async (c) => {
  return recordAndRedirect(c, {
    siteSlug: c.req.param('site'),
    postSlug: c.req.param('post'),
    retailer: c.req.param('retailer'),
  });
});

export default app;
