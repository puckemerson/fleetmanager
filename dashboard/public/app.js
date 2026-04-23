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
      const inBurst = Number(s.seed_burst_complete) === 0;
      const burstBadge = inBurst
        ? `<span class="tag" style="background:#fef3c7;color:#92400e;">seed burst ${Math.min(Number(s.post_count||0), 10)}/10</span>`
        : '';
      const scheduleMeta = inBurst
        ? `seed burst in progress · ${s.post_count || 0} posts · last: ${fmtTime(s.last_post_at)}`
        : `schedule: <code>${esc(s.cron_spec || 'none')}</code> · next run: ${relFuture(s.next_run_at)} · ${s.post_count || 0} posts · last: ${fmtTime(s.last_post_at)}`;
      return `
        <div class="site-card" data-id="${s.id}">
          <div class="name">${esc(s.slug)} <span class="tag">${esc(s.product_category)}</span> <span class="tag">${esc(s.status)}</span> ${burstBadge}</div>
          <div class="meta">
            ${siteUrl} ${repo ? '· ' + repo : ''}
          </div>
          <div class="meta">
            ${scheduleMeta}
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
    const inBurst = Number(site.seed_burst_complete) === 0;
    const postCount = Number(site.post_count || 0);
    const burstBadge = inBurst
      ? `<span class="tag" style="background:#fef3c7;color:#92400e;">seed burst: ${Math.min(postCount, 10)}/10</span>`
      : '';
    const scheduleBlock = inBurst
      ? `<div class="muted" style="margin-top:8px;">Seed burst in progress: ${Math.min(postCount, 10)}/10 reviews. ${site.pending_burst_jobs || 0} jobs queued. Normal schedule resumes after burst completes.</div>`
      : `<div class="muted" style="margin-top:8px;">next run: ${relFuture(site.next_run_at)}</div>`;
    $('detail').innerHTML = `
      <div class="panel">
        <div class="row">
          <h2 style="margin:0;">${esc(site.slug)}</h2>
          <span class="tag">${esc(site.product_category)}</span>
          <span class="tag">${esc(site.status)}</span>
          ${burstBadge}
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
        <div class="row" style="margin-top: 10px;">
          <label>Listicle ratio (reviews per listicle):</label>
          <input type="number" id="listicle-ratio" min="1" max="100" value="${site.listicle_ratio || 10}" style="width:80px;">
          <button class="btn small" id="save-ratio">Save</button>
          <span class="muted">· counter: ${site.reviews_since_last_listicle || 0}/${site.listicle_ratio || 10}</span>
        </div>
        ${scheduleBlock}
      </div>

      <div class="panel">
        <div class="row">
          <strong>Listicles</strong>
          <div class="spacer"></div>
          <button class="btn secondary small" id="gen-listicle-now">Generate listicle now</button>
        </div>
        <div id="listicles-list" style="margin-top: 10px;"><span class="muted">Loading…</span></div>
      </div>

      <div class="panel" id="custom-domain-panel">
        <strong>Custom Domain</strong>
        <div id="custom-domain-body" style="margin-top: 10px;"><span class="muted">Loading…</span></div>
      </div>

      <div class="panel" id="image-style-panel">
        <strong>Image Style (Replicate img2img)</strong>
        <div id="image-style-body" style="margin-top: 10px;"><span class="muted">Loading…</span></div>
      </div>

      <div class="panel" id="affiliate-panel">
        <div class="row">
          <strong>Affiliate</strong>
          <div class="spacer"></div>
          <span class="muted" id="affiliate-clicks-summary">…</span>
        </div>
        <div id="affiliate-body" style="margin-top: 10px;"><span class="muted">Loading…</span></div>
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
    $('save-ratio').onclick = async () => {
      const v = Number($('listicle-ratio').value);
      if (!Number.isInteger(v) || v < 1) { alert('ratio must be a positive integer'); return; }
      try { await api(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ listicle_ratio: v }) }); renderDetail(); }
      catch (err) { alert(err.message); }
    };
    $('gen-listicle-now').onclick = async () => {
      const btn = $('gen-listicle-now');
      btn.disabled = true; btn.textContent = 'Queued…';
      try { await api(`/api/sites/${site.id}/generate-listicle-now`, { method: 'POST' }); btn.textContent = 'Queued ✓'; }
      catch (err) { alert(err.message); btn.textContent = 'Generate listicle now'; btn.disabled = false; }
      setTimeout(() => renderDetail(), 1500);
    };
    // Load listicles async
    (async () => {
      try {
        const { listicles } = await api(`/api/sites/${site.id}/listicles`);
        const list = $('listicles-list');
        if (!list) return;
        if (!listicles || listicles.length === 0) {
          list.innerHTML = '<div class="muted">No listicles yet.</div>';
          return;
        }
        list.innerHTML = listicles.map(l => {
          const liveUrl = site.site_url ? `${site.site_url.replace(/\/$/, '')}/listicles/${l.slug}/` : null;
          const items = (l.items || []).map(i => `<li>#${i.rank} <strong>${esc(i.product_name)}</strong> <span class="muted">(${i.final_score})</span></li>`).join('');
          return `
            <div class="post" style="align-items:flex-start;">
              <div class="body" style="flex:1;">
                <div class="name">${esc(l.title)} <span class="tag">${l.item_count} picks</span></div>
                <div class="muted">${fmtTime(l.created_at)} · ${liveUrl ? `<a href="${esc(liveUrl)}" target="_blank">view</a>` : 'local'}</div>
                <ol style="margin:6px 0 0 0; padding-left: 20px; font-size: 13px;">${items}</ol>
              </div>
            </div>
          `;
        }).join('');
      } catch (err) {
        const list = $('listicles-list');
        if (list) list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    })();
    // Custom domain panel
    try { renderCustomDomainPanel(site); } catch (err) {
      const body = $('custom-domain-body');
      if (body) body.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }

    // Image style panel
    try { renderImageStylePanel(site); } catch (err) {
      const body = $('image-style-body');
      if (body) body.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }

    // Affiliate panel
    (async () => {
      try { await renderAffiliatePanel(site); }
      catch (err) {
        const body = $('affiliate-body');
        if (body) body.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    })();
    $('archive').onclick = async () => {
      if (!confirm('Archive this site? (Repo will remain.)')) return;
      try { await api(`/api/sites/${site.id}`, { method: 'DELETE' }); state.view = 'list'; render(); }
      catch (err) { alert(err.message); }
    };
  } catch (err) {
    $('detail').innerHTML = `<div class="panel error">${esc(err.message)}</div>`;
  }
}

async function renderAffiliatePanel(site) {
  const [progs, clicks] = await Promise.all([
    api(`/api/sites/${site.id}/affiliate-programs`),
    api(`/api/sites/${site.id}/clicks?days=7`).catch(() => ({ total: 0, by_retailer: [] })),
  ]);
  const sum = $('affiliate-clicks-summary');
  if (sum) sum.textContent = `${clicks.total || 0} click${clicks.total === 1 ? '' : 's'} (last 7 days)`;
  const programs = progs.programs || [];
  const discEnabled = !!Number(site.affiliate_disclosure_enabled);
  const discText = site.affiliate_disclosure_text || '';

  const progsRows = programs.map((p) => {
    const cfg = safeParse(p.config_json) || {};
    return `
      <tr>
        <td><code>${esc(p.program)}</code></td>
        <td style="font-size:12px; color: var(--muted, #888);">${esc(JSON.stringify(cfg))}</td>
        <td>${p.enabled ? '<span class="tag">on</span>' : '<span class="tag">off</span>'}</td>
        <td><button class="btn secondary small" data-del-prog="${esc(p.program)}">Remove</button></td>
      </tr>`;
  }).join('');

  $('affiliate-body').innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 14px;">
      <div>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" id="disc-toggle" ${discEnabled ? 'checked' : ''}>
          <span><strong>Show affiliate disclosure</strong></span>
        </label>
        <div class="muted" style="margin-top: 4px; font-size: 13px;">
          When on, every review + listicle page gets a small disclosure banner. Legally required once any real affiliate link is live.
        </div>
        <textarea id="disc-text" rows="2" style="width: 100%; margin-top: 8px; font-size: 13px;" placeholder="(Optional) custom disclosure text. Leave blank for default.">${esc(discText)}</textarea>
        <button class="btn small" id="save-disc" style="margin-top: 6px;">Save disclosure</button>
      </div>

      <div>
        <strong>Configured programs</strong>
        ${programs.length === 0
          ? '<div class="muted" style="margin-top: 6px;">No programs configured. Links still render (as /go/ tracker URLs) but redirect to the raw retailer URL.</div>'
          : `<table style="margin-top: 6px;"><thead><tr><th>program</th><th>config</th><th>state</th><th></th></tr></thead><tbody>${progsRows}</tbody></table>`}
        <details style="margin-top: 10px;">
          <summary style="cursor:pointer; font-weight: 600;">+ Add / update program</summary>
          <form id="add-prog" style="margin-top: 8px;">
            <div class="form-row">
              <label>Program</label>
              <select id="new-prog-kind">
                <option value="amazon">amazon</option>
                <option value="skimlinks">skimlinks</option>
                <option value="sharesasale">sharesasale</option>
                <option value="generic">generic</option>
              </select>
            </div>
            <div class="form-row" id="prog-fields">
              <!-- fields injected per program kind -->
            </div>
            <button type="submit" class="btn small">Save program</button>
          </form>
        </details>
      </div>

      ${clicks.by_retailer && clicks.by_retailer.length > 0 ? `
      <div>
        <strong>Clicks (last 7 days)</strong>
        <table style="margin-top: 6px;"><thead><tr><th>retailer</th><th>count</th></tr></thead>
          <tbody>${clicks.by_retailer.map((r) => `<tr><td>${esc(r.retailer)}</td><td>${r.n}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ` : ''}
    </div>
  `;

  // Program fields injector
  const kindSel = document.getElementById('new-prog-kind');
  const fieldsDiv = document.getElementById('prog-fields');
  function renderProgFields() {
    const k = kindSel.value;
    if (k === 'amazon') {
      fieldsDiv.innerHTML = `<label>Associate tag</label><input id="f-tag" placeholder="will-20" required>`;
    } else if (k === 'skimlinks') {
      fieldsDiv.innerHTML = `<label>Skimlinks site id</label><input id="f-siteid" placeholder="123456" required>`;
    } else if (k === 'sharesasale') {
      fieldsDiv.innerHTML = `
        <label>User ID</label><input id="f-user" required>
        <label style="margin-top:6px;">Merchant ID</label><input id="f-merchant" required>
        <label style="margin-top:6px;">Banner ID (optional)</label><input id="f-banner">`;
    } else {
      fieldsDiv.innerHTML = `<label>Prefix URL (raw URL will be appended URL-encoded)</label><input id="f-prefix" placeholder="https://example.com/r?u=">`;
    }
  }
  if (kindSel && fieldsDiv) {
    kindSel.addEventListener('change', renderProgFields);
    renderProgFields();
  }

  // Delete program handlers
  document.querySelectorAll('[data-del-prog]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Remove program '${btn.dataset.delProg}'?`)) return;
      try { await api(`/api/sites/${site.id}/affiliate-programs/${btn.dataset.delProg}`, { method: 'DELETE' }); renderDetail(); }
      catch (err) { alert(err.message); }
    };
  });

  // Save disclosure
  const saveBtn = $('save-disc');
  if (saveBtn) saveBtn.onclick = async () => {
    try {
      await api(`/api/sites/${site.id}/disclosure`, {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: $('disc-toggle').checked,
          text: $('disc-text').value.trim() || null,
        }),
      });
      renderDetail();
    } catch (err) { alert(err.message); }
  };

  // Add program
  const addForm = document.getElementById('add-prog');
  if (addForm) addForm.onsubmit = async (e) => {
    e.preventDefault();
    const kind = kindSel.value;
    let config = {};
    if (kind === 'amazon') config.associate_tag = document.getElementById('f-tag').value.trim();
    else if (kind === 'skimlinks') config.site_id = document.getElementById('f-siteid').value.trim();
    else if (kind === 'sharesasale') {
      config.user_id = document.getElementById('f-user').value.trim();
      config.merchant_id = document.getElementById('f-merchant').value.trim();
      const banner = document.getElementById('f-banner').value.trim();
      if (banner) config.banner_id = banner;
    } else {
      const pref = document.getElementById('f-prefix').value.trim();
      if (pref) config.prefix = pref;
    }
    try {
      await api(`/api/sites/${site.id}/affiliate-programs/${kind}`, {
        method: 'PUT',
        body: JSON.stringify({ config, enabled: true }),
      });
      renderDetail();
    } catch (err) { alert(err.message); }
  };
}

function renderCustomDomainPanel(site) {
  const panel = document.getElementById('custom-domain-body');
  if (!panel) return;
  const domain = site.custom_domain || '';
  const status = site.custom_domain_status || 'none';

  const statusBadge = (s) => {
    const map = { none: '#e5e7eb:#374151', pending_dns: '#fef3c7:#92400e', active: '#d1fae5:#065f46', error: '#fee2e2:#991b1b' };
    const [bg, color] = (map[s] || map.none).split(':');
    return `<span class="tag" style="background:${bg};color:${color};">${esc(s)}</span>`;
  };

  if (!domain) {
    panel.innerHTML = `
      <div class="muted" style="margin-bottom: 8px;">No custom domain set. You can point your own domain at this site.</div>
      <form id="set-domain-form" style="display:flex; gap: 8px; align-items: center;">
        <input id="domain-input" type="text" placeholder="reviews.mysite.com" style="flex:1;" required>
        <button type="submit" class="btn small">Set domain</button>
      </form>
      <div class="error" id="domain-err" style="margin-top:6px;"></div>
    `;
    const form = document.getElementById('set-domain-form');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const d = document.getElementById('domain-input').value.trim();
      const errEl = document.getElementById('domain-err');
      errEl.textContent = '';
      try {
        const res = await api(`/api/sites/${site.id}/custom-domain`, { method: 'PUT', body: JSON.stringify({ domain: d }) });
        // Re-render with updated site
        Object.assign(site, res.site || {});
        renderCustomDomainPanel(site);
      } catch (err) { errEl.textContent = err.message; }
    };
    return;
  }

  // Domain is set — show status + DNS instructions
  let dnsHtml = '';
  if (status === 'pending_dns' || status === 'active') {
    const isApex = domain.split('.').length === 2;
    if (isApex) {
      const ips = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
      const aRecords = ips.map(ip => `Type: A | Name: @ | Value: ${ip}`).join('<br>');
      const aaaaRecords = [
        '2606:50c0:8000::153','2606:50c0:8001::153','2606:50c0:8002::153','2606:50c0:8003::153'
      ].map(ip => `Type: AAAA | Name: @ | Value: ${ip}`).join('<br>');
      dnsHtml = `<div class="panel" style="background:#f9fafb; margin-top:8px; font-size:13px;">
        <strong>DNS Records for apex domain ${esc(domain)}:</strong><br><br>
        ${aRecords}<br><br>${aaaaRecords}
        <br><button class="btn secondary small" id="copy-dns" style="margin-top:6px;">Copy DNS instructions</button>
      </div>`;
    } else {
      const sub = domain.split('.').slice(0, -2).join('.');
      dnsHtml = `<div class="panel" style="background:#f9fafb; margin-top:8px; font-size:13px;">
        <strong>DNS Record for subdomain ${esc(domain)}:</strong><br><br>
        Type: CNAME | Name: ${esc(sub)} | Value: puckemerson.github.io
        <br><button class="btn secondary small" id="copy-dns" style="margin-top:6px;">Copy DNS instructions</button>
      </div>`;
    }
  }

  panel.innerHTML = `
    <div class="row" style="align-items:center; gap:8px;">
      <strong>${esc(domain)}</strong> ${statusBadge(status)}
    </div>
    ${dnsHtml}
    <div class="row" style="margin-top:10px; gap:8px;">
      <button class="btn small" id="verify-domain-btn">Verify DNS</button>
      <button class="btn danger small" id="remove-domain-btn">Remove domain</button>
    </div>
    <div id="verify-result" style="margin-top:6px; font-size:13px;"></div>
  `;

  const copyBtn = document.getElementById('copy-dns');
  if (copyBtn) {
    const isApex = domain.split('.').length === 2;
    copyBtn.onclick = () => {
      let txt;
      if (isApex) {
        const ips = ['185.199.108.153','185.199.109.153','185.199.110.153','185.199.111.153'];
        const aaaaIps = ['2606:50c0:8000::153','2606:50c0:8001::153','2606:50c0:8002::153','2606:50c0:8003::153'];
        txt = ips.map(ip => `Type: A  Name: @  Value: ${ip}`).join('\n') + '\n' + aaaaIps.map(ip => `Type: AAAA  Name: @  Value: ${ip}`).join('\n');
      } else {
        const sub = domain.split('.').slice(0, -2).join('.');
        txt = `Type: CNAME  Name: ${sub}  Value: puckemerson.github.io`;
      }
      navigator.clipboard.writeText(txt).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy DNS instructions'; }, 2000); });
    };
  }

  const verifyBtn = document.getElementById('verify-domain-btn');
  if (verifyBtn) verifyBtn.onclick = async () => {
    verifyBtn.disabled = true; verifyBtn.textContent = 'Checking…';
    const resultEl = document.getElementById('verify-result');
    try {
      const res = await api(`/api/sites/${site.id}/verify-domain`, { method: 'POST' });
      resultEl.innerHTML = `<span class="${res.status === 'active' ? 'tag' : 'muted'}">${esc(res.message)}</span>`;
      if (res.status === 'active') { site.custom_domain_status = 'active'; renderCustomDomainPanel(site); }
    } catch (err) { resultEl.textContent = err.message; }
    finally { verifyBtn.disabled = false; verifyBtn.textContent = 'Verify DNS'; }
  };

  const removeBtn = document.getElementById('remove-domain-btn');
  if (removeBtn) removeBtn.onclick = async () => {
    if (!confirm(`Remove custom domain '${domain}'?`)) return;
    removeBtn.disabled = true;
    try {
      const res = await api(`/api/sites/${site.id}/custom-domain`, { method: 'DELETE' });
      Object.assign(site, res.site || {});
      renderCustomDomainPanel(site);
    } catch (err) { alert(err.message); removeBtn.disabled = false; }
  };
}

function renderImageStylePanel(site) {
  const panel = document.getElementById('image-style-body');
  if (!panel) return;
  const prompt = site.image_style_prompt || '';
  panel.innerHTML = `
    <div class="muted" style="margin-bottom: 8px; font-size: 13px;">Used for Replicate img2img when <code>REPLICATE_API_KEY</code> is set. Changes take effect on the next generated review.</div>
    <textarea id="style-prompt-input" rows="3" style="width:100%; font-size:13px;" placeholder="e.g. editorial product photography, white marble surface, soft natural light, minimalist">${esc(prompt)}</textarea>
    <div style="margin-top: 6px;">
      <button class="btn small" id="save-style-prompt">Save style prompt</button>
    </div>
    <div id="style-prompt-msg" style="margin-top:4px; font-size:12px;"></div>
  `;
  const saveBtn = document.getElementById('save-style-prompt');
  if (saveBtn) saveBtn.onclick = async () => {
    const val = document.getElementById('style-prompt-input').value.trim();
    const msg = document.getElementById('style-prompt-msg');
    saveBtn.disabled = true;
    try {
      await api(`/api/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify({ image_style_prompt: val || null }) });
      site.image_style_prompt = val || null;
      msg.textContent = 'Saved.';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (err) { msg.textContent = err.message; }
    finally { saveBtn.disabled = false; }
  };
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
