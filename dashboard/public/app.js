const $ = (id) => document.getElementById(id);
const app = document.getElementById('app');

const state = {
  user: null,
  view: 'login', // 'login' | 'list' | 'detail'
  currentSiteId: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { state.user = null; state.view = 'login'; render(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('http ' + res.status));
  return data;
}

async function init() {
  try {
    const me = await api('/api/me');
    state.user = me;
    state.view = 'list';
  } catch (_) {
    state.view = 'login';
  }
  render();
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  return d.toLocaleString();
}
function relFuture(ms) {
  if (!ms) return '—';
  const diff = Number(ms) - Date.now();
  if (diff < 0) return 'due now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours/24)}d`;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  if (state.view === 'login') return renderLogin();
  if (state.view === 'list') return renderList();
  if (state.view === 'detail') return renderDetail();
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <h1>FleetManager</h1>
      <form id="login-form">
        <div class="form-row">
          <label for="username">Username</label>
          <input id="username" name="username" required autocomplete="username" value="will">
        </div>
        <div class="form-row">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn">Sign in</button>
        <div class="error" id="login-error"></div>
      </form>
    </div>
  `;
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }),
      });
      state.user = res; state.view = 'list'; render();
    } catch (err) { $('login-error').textContent = err.message; }
  });
}

async function renderList() {
  app.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>🚢 FleetManager</h1>
        <div class="row">
          <span class="muted">signed in as ${esc(state.user?.username || 'will')}</span>
          <button class="btn secondary small" id="logout">Log out</button>
        </div>
      </div>
      <div class="panel">
        <div class="row">
          <strong>Sites</strong>
          <div class="spacer"></div>
          <button class="btn" id="new-site">+ New site</button>
        </div>
      </div>
      <div id="sites">Loading…</div>
    </div>
  `;
  $('logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null; state.view = 'login'; render();
  };
  $('new-site').onclick = showNewSiteForm;

  try {
    const { sites } = await api('/api/sites');
    if (!sites || sites.length === 0) {
      $('sites').innerHTML = `<div class="panel muted">No sites yet. Click <strong>New site</strong> to create one.</div>`;
      return;
    }
    $('sites').innerHTML = sites.map(s => {
      const theme = safeParse(s.theme_json);
      const siteUrl = s.site_url ? `<a href="${esc(s.site_url)}" target="_blank">${esc(s.site_url)}</a>` : '<span class="muted">not yet deployed</span>';
      const repo = s.repo_url ? `<a href="${esc(s.repo_url)}" target="_blank">repo</a>` : '';
      return `
        <div class="site-card" data-id="${s.id}">
          <div class="name">${esc(s.slug)} <span class="tag">${esc(s.product_category)}</span> <span class="tag">${esc(s.status)}</span></div>
          <div class="meta">
            ${siteUrl} ${repo ? '· ' + repo : ''}
          </div>
          <div class="meta">
            schedule: <code>${esc(s.cron_spec || 'none')}</code> · next run: ${relFuture(s.next_run_at)} · ${s.post_count || 0} posts · last: ${fmtTime(s.last_post_at)}
          </div>
          <div class="actions">
            <button class="btn small" data-open="${s.id}">Open</button>
            <button class="btn secondary small" data-gen="${s.id}">Generate now</button>
          </div>
        </div>
      `;
    }).join('');
    document.querySelectorAll('[data-open]').forEach(el => el.onclick = () => {
      state.currentSiteId = Number(el.dataset.open); state.view = 'detail'; render();
    });
    document.querySelectorAll('[data-gen]').forEach(el => el.onclick = async () => {
      el.disabled = true; el.textContent = 'Queued…';
      try { await api(`/api/sites/${el.dataset.gen}/generate-now`, { method: 'POST' }); el.textContent = 'Queued ✓'; }
      catch (err) { el.textContent = 'Failed'; alert(err.message); }
      setTimeout(() => renderList(), 1500);
    });
  } catch (err) {
    $('sites').innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
  }
}

function showNewSiteForm() {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <strong>New site</strong>
    <form id="new-site-form" style="margin-top: 12px;">
      <div class="form-row">
        <label>Product category (e.g. perfume, mechanical keyboards)</label>
        <input name="product_category" required maxlength="60" placeholder="perfume">
      </div>
      <div class="form-row">
        <label>Slug (optional, will be used as repo name)</label>
        <input name="slug" maxlength="60" placeholder="auto-generated if empty">
      </div>
      <div class="form-row">
        <label>Schedule</label>
        <select name="cron_spec">
          <option value="weekly">weekly</option>
          <option value="daily">daily</option>
          <option value="hourly">hourly</option>
          <option value="+5m">+5m (test mode)</option>
        </select>
      </div>
      <div class="row">
        <button type="submit" class="btn">Create site</button>
        <button type="button" class="btn secondary" id="cancel-new">Cancel</button>
      </div>
      <div class="error" id="new-err"></div>
    </form>
  `;
  const sitesDiv = $('sites');
  sitesDiv.parentNode.insertBefore(panel, sitesDiv);
  $('cancel-new').onclick = () => panel.remove();
  $('new-site-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      product_category: fd.get('product_category').toString().trim(),
      slug: fd.get('slug').toString().trim() || undefined,
      cron_spec: fd.get('cron_spec').toString(),
    };
    try {
      await api('/api/sites', { method: 'POST', body: JSON.stringify(body) });
      panel.remove();
      renderList();
    } catch (err) { $('new-err').textContent = err.message; }
  };
}

async function renderDetail() {
  app.innerHTML = `
    <div class="container">
      <div class="header">
        <h1>🚢 FleetManager</h1>
        <button class="btn secondary small" id="back">← Back</button>
      </div>
      <div id="detail">Loading…</div>
    </div>
  `;
  $('back').onclick = () => { state.view = 'list'; state.currentSiteId = null; render(); };
  try {
    const { site, posts, jobs } = await api(`/api/sites/${state.currentSiteId}`);
    const theme = safeParse(site.theme_json);
    const siteUrl = site.site_url ? `<a href="${esc(site.site_url)}" target="_blank">${esc(site.site_url)}</a>` : '<span class="muted">pending</span>';
    const repo = site.repo_url ? `<a href="${esc(site.repo_url)}" target="_blank">${esc(site.repo_url)}</a>` : '<span class="muted">pending</span>';
    $('detail').innerHTML = `
      <div class="panel">
        <div class="row">
          <h2 style="margin:0;">${esc(site.slug)}</h2>
          <span class="tag">${esc(site.product_category)}</span>
          <span class="tag">${esc(site.status)}</span>
          <div class="spacer"></div>
          <button class="btn" id="gen-now">Generate now</button>
        </div>
        <hr>
        <div>Site: ${siteUrl}</div>
        <div>Repo: ${repo}</div>
        <div class="row" style="margin-top: 10px;">
          <label>Schedule:</label>
          <select id="schedule">
            <option value="weekly" ${site.cron_spec==='weekly'?'selected':''}>weekly</option>
            <option value="daily" ${site.cron_spec==='daily'?'selected':''}>daily</option>
            <option value="hourly" ${site.cron_spec==='hourly'?'selected':''}>hourly</option>
            <option value="+5m" ${site.cron_spec==='+5m'?'selected':''}>+5m (test)</option>
          </select>
          <button class="btn small" id="save-sched">Save</button>
          <div class="spacer"></div>
          <button class="btn danger small" id="archive">Archive</button>
        </div>
        <div class="muted" style="margin-top:8px;">next run: ${relFuture(site.next_run_at)}</div>
      </div>

      <div class="panel">
        <strong>Posts (${posts.length})</strong>
        <div id="posts-list" style="margin-top: 10px;">
          ${posts.length === 0 ? '<div class="muted">No posts yet.</div>' : posts.map(p => postCard(p, site)).join('')}
        </div>
      </div>

      <div class="panel">
        <strong>Recent jobs</strong>
        <table style="margin-top:8px;">
          <thead><tr><th>#</th><th>kind</th><th>status</th><th>scheduled</th><th>finished</th><th>error</th></tr></thead>
          <tbody>
            ${jobs.map(j => `
              <tr>
                <td>${j.id}</td>
                <td>${esc(j.kind)}</td>
                <td class="status-${j.status === 'done' ? 'ok' : j.status === 'running' ? 'run' : j.status === 'failed' ? 'err' : 'queued'}">${esc(j.status)}</td>
                <td>${fmtTime(j.scheduled_for)}</td>
                <td>${fmtTime(j.finished_at)}</td>
                <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis;" title="${esc(j.error||'')}">${esc((j.error||'').slice(0, 60))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    $('gen-now').onclick = async () => {
      $('gen-now').disabled = true; $('gen-now').textContent = 'Queued…';
      try { await api(`/api/sites/${site.id}/generate-now`, { method: 'POST' }); $('gen-now').textContent = 'Queued ✓'; }
      catch (err) { alert(err.message); $('gen-now').textContent = 'Generate now'; $('gen-now').disabled = false; }
      setTimeout(() => renderDetail(), 1500);
    };
    $('save-sched').onclick = async () => {
      try { await api(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ cron_spec: $('schedule').value }) }); renderDetail(); }
      catch (err) { alert(err.message); }
    };
    $('archive').onclick = async () => {
      if (!confirm('Archive this site? (Repo will remain.)')) return;
      try { await api(`/api/sites/${site.id}`, { method: 'DELETE' }); state.view = 'list'; render(); }
      catch (err) { alert(err.message); }
    };
  } catch (err) {
    $('detail').innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
  }
}

function postCard(p, site) {
  const cats = safeParse(p.category_scores_json);
  const postUrl = site.site_url ? `${site.site_url.replace(/\/$/, '')}/posts/${p.slug}/` : null;
  const img = p.image_source_url ? `<img src="${esc(p.image_source_url)}" alt="">` : '';
  return `
    <div class="post">
      ${img}
      <div class="body">
        <div class="name">${esc(p.product_name)} <span class="score-badge">${p.final_score}</span></div>
        <div class="muted">${fmtTime(p.created_at)} · ${postUrl ? `<a href="${esc(postUrl)}" target="_blank">view</a>` : 'local'}</div>
        <div class="muted" style="margin-top:4px;">${Array.isArray(cats) ? cats.map(c => `${esc(c.name)}: ${c.score}`).join(' · ') : ''}</div>
      </div>
    </div>
  `;
}

function safeParse(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

init();
