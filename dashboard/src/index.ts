import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';
// @ts-ignore: shared JS module, no type declarations
import { resolveAffiliateUrl, detectRetailer } from '../../shared/affiliate.js';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  DASHBOARD_PASSWORD_HASH: string;
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
  let slug = (body?.slug ?? '').toString().trim();
  if (!productCategory || productCategory.length > 60) return c.json({ error: 'invalid product_category' }, 400);
  if (!slug) slug = slugify(productCategory) + '-' + Math.random().toString(36).slice(2, 6);
  slug = slugify(slug);
  if (!slug) return c.json({ error: 'invalid slug' }, 400);

  const exists = await c.env.DB.prepare('SELECT id FROM sites WHERE slug = ?').bind(slug).first();
  if (exists) return c.json({ error: 'slug already exists' }, 409);

  const now = nowMs();
  const res = await c.env.DB.prepare(
    `INSERT INTO sites (slug, product_category, repo_url, site_url, theme_json, cron_spec, next_run_at, status, created_at)
     VALUES (?, ?, '', '', '{}', ?, ?, 'active', ?)`
  ).bind(slug, productCategory, cronSpec, now, now).run();

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
    'SELECT id, product_name, slug, final_score, category_scores_json, image_source_url, created_at FROM posts WHERE site_id = ? ORDER BY created_at DESC LIMIT 50'
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
  if (typeof body.status === 'string' && ['active', 'archived', 'paused'].includes(body.status)) {
    updates.push('status = ?'); binds.push(body.status);
  }
  if (body.listicle_ratio != null) {
    const r = Number(body.listicle_ratio);
    if (!Number.isInteger(r) || r < 1 || r > 10000) return c.json({ error: 'invalid listicle_ratio' }, 400);
    updates.push('listicle_ratio = ?'); binds.push(r);
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
