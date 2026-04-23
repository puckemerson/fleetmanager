// GitHub API wrapper.
import { CONFIG } from './config.js';

const GH_API = 'https://api.github.com';

async function ghFetch(path, opts = {}) {
  const res = await fetch(GH_API + path, {
    ...opts,
    headers: {
      Authorization: `token ${CONFIG.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fleetmanager-orchestrator',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${opts.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function createRepo(name, description) {
  try {
    return await ghFetch('/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: description || `Auto-generated review site: ${name}`,
        private: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
        auto_init: false,
      }),
    });
  } catch (err) {
    // If already exists, fetch existing
    if (String(err.message).includes('already exists')) {
      return await ghFetch(`/repos/${CONFIG.GITHUB_USER}/${name}`);
    }
    throw err;
  }
}

export async function enablePages(repo) {
  // Retry a few times since Pages sometimes isn't ready immediately.
  for (let i = 0; i < 4; i++) {
    try {
      return await ghFetch(`/repos/${CONFIG.GITHUB_USER}/${repo}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ build_type: 'workflow' }),
      });
    } catch (err) {
      // 409 = already enabled; treat as ok
      if (String(err.message).includes('409')) {
        return await ghFetch(`/repos/${CONFIG.GITHUB_USER}/${repo}/pages`);
      }
      if (i === 3) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export async function getRepo(repo) {
  try {
    return await ghFetch(`/repos/${CONFIG.GITHUB_USER}/${repo}`);
  } catch (err) {
    if (String(err.message).includes('404')) return null;
    throw err;
  }
}

export function repoGitUrl(repo) {
  // Return HTTPS URL with PAT embedded for git push.
  return `https://x-access-token:${CONFIG.GITHUB_PAT}@github.com/${CONFIG.GITHUB_USER}/${repo}.git`;
}

export function repoPagesUrl(repo) {
  return `https://${CONFIG.GITHUB_USER}.github.io/${repo}/`;
}

// Origin (no trailing slash, no path) used as the canonical base for SEO.
export function pagesOrigin() {
  return `https://${CONFIG.GITHUB_USER}.github.io`;
}
