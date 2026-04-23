import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';

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
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  if (!site) return c.json({ error: 'not found' }, 404);
  const posts = await c.env.DB.prepare(
    'SELECT id, product_name, slug, final_score, category_scores_json, image_source_url, created_at FROM posts WHERE site_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(id).all();
  const jobs = await c.env.DB.prepare(
    'SELECT id, kind, status, scheduled_for, started_at, finished_at, error FROM jobs WHERE site_id = ? ORDER BY id DESC LIMIT 20'
  ).bind(id).all();
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
  if (updates.length === 0) return c.json({ error: 'nothing to update' }, 400);
  binds.push(id);
  await c.env.DB.prepare(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  const site = await c.env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(id).first();
  return c.json({ site });
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

// Unknown API routes
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

export default app;
