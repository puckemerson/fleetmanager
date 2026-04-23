// D1 REST client via Cloudflare API.
import { CONFIG } from './config.js';

const BASE = `https://api.cloudflare.com/client/v4/accounts/${CONFIG.CF_ACCOUNT_ID}/d1/database/${CONFIG.D1_DATABASE_ID}/query`;

export async function d1Query(sql, params = []) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'X-Auth-Email': CONFIG.CF_EMAIL,
      'X-Auth-Key': CONFIG.CF_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
    // D1 REST can be slow
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`D1 HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error('D1 error: ' + JSON.stringify(data.errors).slice(0, 500));
  }
  // data.result is an array of result sets (one per statement).
  return data.result[0];
}

export async function d1All(sql, params = []) {
  const r = await d1Query(sql, params);
  return r?.results ?? [];
}

export async function d1First(sql, params = []) {
  const rows = await d1All(sql, params);
  return rows[0] || null;
}

export async function d1Run(sql, params = []) {
  const r = await d1Query(sql, params);
  return { changes: r?.meta?.changes ?? 0, lastRowId: r?.meta?.last_row_id ?? null };
}
