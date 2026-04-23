// Shared config for the orchestrator.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function loadSecrets() {
  const envPath = '/home/wlifferth/.openclaw/workspace/.secrets/fleetmanager.env';
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadSecrets();

export const CONFIG = {
  CF_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '88cfa7a85d11e27c88954340307d3c9d',
  CF_EMAIL: process.env.CLOUDFLARE_EMAIL || 'puckemerson@gmail.com',
  CF_API_KEY: process.env.CLOUDFLARE_GLOBAL_API_KEY,
  D1_DATABASE_ID: '0827198b-69cf-452c-95a2-18a05ca0a715',
  GITHUB_PAT: process.env.GITHUB_PAT,
  GITHUB_USER: process.env.GITHUB_USER || 'puckemerson',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'claude-sonnet-4-5',
  WORK_DIR: process.env.FLEETMANAGER_WORK_DIR || '/tmp/fleetmanager-work',
  SITE_TEMPLATE_DIR: process.env.FLEETMANAGER_SITE_TEMPLATE
    || '/home/wlifferth/.openclaw/workspace/projects/fleetmanager/site-template',
  TICK_MS: Number(process.env.FLEETMANAGER_TICK_MS || 30000),
};

export function requireSecrets() {
  const missing = [];
  if (!CONFIG.CF_API_KEY) missing.push('CLOUDFLARE_GLOBAL_API_KEY');
  if (!CONFIG.GITHUB_PAT) missing.push('GITHUB_PAT');
  if (!CONFIG.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    throw new Error('Missing required env vars: ' + missing.join(', '));
  }
}

// Ensure work dir exists
if (!fs.existsSync(CONFIG.WORK_DIR)) {
  fs.mkdirSync(CONFIG.WORK_DIR, { recursive: true });
}
