// Affiliate URL resolution + retailer detection.
// No side effects: pure URL transforms. Used by the orchestrator (build-time)
// and by the dashboard Worker (click-redirect time).

/**
 * Map a domain to a canonical retailer identifier.
 * Returned values: 'amazon', 'sephora', 'walmart', 'target', 'bestbuy',
 * 'ulta', 'nordstrom', 'ebay', 'etsy', 'generic'.
 */
export function detectRetailer(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return 'generic';
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); }
  catch { return 'generic'; }
  // Strip www., m., shop. subdomains.
  host = host.replace(/^(www|m|shop|store)\./, '');
  // Amazon: amazon.com, amazon.co.uk, amzn.to, a.co
  if (/(^|\.)amazon\./.test(host) || host === 'amzn.to' || host === 'a.co') return 'amazon';
  if (/(^|\.)sephora\./.test(host)) return 'sephora';
  if (/(^|\.)ulta\./.test(host)) return 'ulta';
  if (/(^|\.)walmart\./.test(host)) return 'walmart';
  if (/(^|\.)target\.com$/.test(host)) return 'target';
  if (/(^|\.)bestbuy\./.test(host)) return 'bestbuy';
  if (/(^|\.)nordstrom\./.test(host)) return 'nordstrom';
  if (/(^|\.)ebay\./.test(host)) return 'ebay';
  if (/(^|\.)etsy\./.test(host)) return 'etsy';
  // Known non-retailer sources we don't want to track as retailers.
  if (/wikipedia\.org$/.test(host)) return 'none';
  if (/duckduckgo\.com$/.test(host)) return 'none';
  return 'generic';
}

function isRetailerDomain(rawUrl) {
  const r = detectRetailer(rawUrl);
  return r !== 'none';
}

export { isRetailerDomain };

/**
 * Parse config_json safely for a program row.
 */
function parseConfig(cfg) {
  if (!cfg) return {};
  if (typeof cfg === 'object') return cfg;
  try { return JSON.parse(cfg); } catch { return {}; }
}

/**
 * Resolve the final URL a user should be redirected to for a given retailer
 * link, given the list of programs configured for the owning site.
 *
 * Inputs:
 *   retailer: 'amazon' | 'sephora' | etc. | 'generic'
 *   rawUrl:   the original retailer page URL
 *   programs: [{ program, config_json, enabled }]
 *
 * If no configured program applies, returns rawUrl unchanged.
 */
export function resolveAffiliateUrl({ retailer, rawUrl, programs }) {
  if (!rawUrl) return rawUrl;
  const list = Array.isArray(programs) ? programs : [];
  const active = list.filter((p) => p && (p.enabled === undefined || p.enabled === 1 || p.enabled === true));

  // 1) Retailer-specific rewrites (Amazon associate tag).
  if (retailer === 'amazon') {
    const amz = active.find((p) => p.program === 'amazon');
    if (amz) {
      const cfg = parseConfig(amz.config_json);
      const tag = cfg.associate_tag || cfg.tag;
      if (tag) return appendQuery(rawUrl, { tag });
    }
  }

  // 2) Generic: site-level rule, e.g. { rewrite_to: 'https://...' } or a
  //    redirect prefix. Skipped for now unless config says otherwise.
  const generic = active.find((p) => p.program === 'generic');
  if (generic) {
    const cfg = parseConfig(generic.config_json);
    if (cfg && typeof cfg.prefix === 'string' && cfg.prefix) {
      return cfg.prefix + encodeURIComponent(rawUrl);
    }
  }

  // 3) Skimlinks: covers everything that doesn't match a direct program.
  //    Documented format: https://go.skimresources.com/?id=<ID>&xs=1&url=<ENCODED>
  //    We only wrap if a Skimlinks program is configured AND no specific
  //    retailer rewrite already fired above.
  const skim = active.find((p) => p.program === 'skimlinks');
  if (skim) {
    const cfg = parseConfig(skim.config_json);
    const id = cfg.site_id || cfg.id;
    if (id) {
      const u = new URL('https://go.skimresources.com/');
      u.searchParams.set('id', String(id));
      u.searchParams.set('xs', '1');
      u.searchParams.set('url', rawUrl);
      return u.toString();
    }
  }

  // 4) ShareASale: wrapping pattern.
  //    https://shareasale.com/r.cfm?b=<BANNER>&u=<USER>&m=<MERCHANT>&afftrack=&urllink=<ENCODED>
  const sas = active.find((p) => p.program === 'sharesasale' || p.program === 'shareasale');
  if (sas) {
    const cfg = parseConfig(sas.config_json);
    if (cfg.user_id && cfg.merchant_id) {
      const u = new URL('https://shareasale.com/r.cfm');
      u.searchParams.set('b', String(cfg.banner_id || '1'));
      u.searchParams.set('u', String(cfg.user_id));
      u.searchParams.set('m', String(cfg.merchant_id));
      u.searchParams.set('afftrack', cfg.afftrack || '');
      u.searchParams.set('urllink', rawUrl);
      return u.toString();
    }
  }

  return rawUrl;
}

/**
 * Append query params to a URL, preserving existing params.
 * Overwrites existing keys of the same name.
 */
export function appendQuery(rawUrl, params) {
  try {
    const u = new URL(rawUrl);
    for (const [k, v] of Object.entries(params || {})) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  } catch {
    // Fallback for relative/invalid URLs.
    const sep = rawUrl.includes('?') ? '&' : '?';
    const qs = Object.entries(params || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return rawUrl + sep + qs;
  }
}

/**
 * Friendly retailer display name (for CTA text).
 */
export function retailerDisplayName(retailer) {
  const r = String(retailer || '').toLowerCase();
  const map = {
    amazon: 'Amazon',
    sephora: 'Sephora',
    ulta: 'Ulta',
    walmart: 'Walmart',
    target: 'Target',
    bestbuy: 'Best Buy',
    nordstrom: 'Nordstrom',
    ebay: 'eBay',
    etsy: 'Etsy',
  };
  return map[r] || 'retailer';
}
