# FleetManager

A system for managing multiple AI-driven review sites. One dashboard, many sites,
each auto-scaffolded, themed, and posted to on a schedule.

## Architecture

- **`dashboard/`** — Cloudflare Worker (Hono + D1), deployed at `fleetmanager.puckemerson.workers.dev`. Handles auth + site CRUD + job queuing.
- **`orchestrator/`** — Node.js long-running process on Pascal. Polls D1 via the CF API for due jobs every 30s. Handles `scaffold_site` and `generate_post` jobs.
- **`site-template/`** — 11ty template copied per new site. Theme vars are injected at scaffold time.
- **`scripts/`** — Setup/deploy helpers.

## Quickstart

```bash
# Login to the dashboard (password is the Worker secret DASHBOARD_PASSWORD_HASH, not in git)
curl -s -c cookies.txt -X POST https://fleetmanager.puckemerson.workers.dev/api/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"will\",\"password\":\"$DASHBOARD_PASSWORD\"}"

# Create a site
curl -s -b cookies.txt -X POST https://fleetmanager.puckemerson.workers.dev/api/sites \
  -H "Content-Type: application/json" \
  -d '{"product_category":"perfume","cron_spec":"weekly"}'
```

The orchestrator picks up the scaffold job, creates a GitHub repo, enables Pages, and
schedules the first `generate_post` per the cron spec.

## Cron specs supported
- `hourly`, `daily`, `weekly`
- `+5m`, `+30m`, `+2h`, `+1d` (absolute offsets; `m`=minutes, `h`=hours, `d`=days)

## Credentials & secrets

The orchestrator loads secrets from `/home/wlifferth/.openclaw/workspace/.secrets/fleetmanager.env`:

```
ANTHROPIC_API_KEY=...
GITHUB_PAT=...
GITHUB_USER=puckemerson
CLOUDFLARE_EMAIL=puckemerson@gmail.com
CLOUDFLARE_GLOBAL_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
```

The dashboard Worker stores `DASHBOARD_PASSWORD_HASH` as a Cloudflare secret.

## Services

- Dashboard Worker: deployed via `cd dashboard && npx wrangler deploy`.
- Orchestrator: runs as user systemd service.
  ```
  systemctl --user status fleetmanager-orchestrator
  journalctl --user -u fleetmanager-orchestrator -f
  ```

## Taskdeck

- **Project ID**: 2
- **Slug**: `fleetmanager`
- **Health**: `https://fleetmanager.puckemerson.workers.dev/health` (requires deploying the Worker after the `/health` route lands)
- **Taskdeck UI**: http://localhost:3117/#/projects/2

## Pipeline (per post)

1. Orchestrator picks up a due `generate_post` job.
2. LLM proposes 10 candidate products in the site's category; filter out already-reviewed.
3. Research: Wikipedia summary + DDG best-effort + scrape top hits.
4. LLM synthesizes: picks 3-5 scoring categories, weights, scores, writes 400-700 words first-person review (strict JSON output).
5. Product image: scrape og:image from top search hits, fallback to DDG image search. Store in the site's own repo at `src/images/<slug>.jpg`.
6. Commit markdown + image to the site repo. GitHub Pages rebuilds on push.
7. D1 record inserted with final score + category breakdown + commit sha.

## D1 schema

See `dashboard/migrations/0001_init.sql` and `0002_seo_fields.sql`.

`sites` columns added in 0002:
- `site_title` — rendered as the title on every page
- `tagline` — used in home meta description and OG
- `about_text` — rendered on /about/
- `analytics_snippet` — arbitrary HTML inlined in `<head>` (e.g. Plausible / Umami / GA4). Left empty by default.

To update a site's analytics snippet:
```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/d1/database/$D1_ID/query" \
  -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_API_KEY" -H "Content-Type: application/json" \
  -d '{"sql":"UPDATE sites SET analytics_snippet = ? WHERE slug = ?","params":["<script>...</script>","my-slug"]}'
```
The next `generate_post` job for that site will propagate the value into `src/_data/site.json` and it will render on subsequent builds.

## SEO

Every site emits:
- JSON-LD `Review` on each review page (with `Product` itemReviewed, 1-5 star rating, author as Organization)
- JSON-LD `WebSite` on the homepage
- Unique `<title>`, `<meta description>`, `<link rel=canonical>`, Open Graph + Twitter Card on every page
- `sitemap.xml` + `robots.txt` at the root
- "Related reviews" on each review page, "Highest rated" section on the homepage
- Lazy-loaded images with explicit width/height to minimize CLS

Backfill an existing site (or all sites) to match the current template:
```sh
node scripts/backfill-seo.js --slug <slug>    # single site
node scripts/backfill-seo.js                  # all active sites
node scripts/backfill-seo.js --dry-run        # preview changes
```

## Notes

- R2 was not enabled on this Cloudflare account; images are committed into each site repo instead of R2. This is simpler and works fine for the typical image sizes (~50-1000 KB).
- DDG HTML endpoint blocks our server IP ("anomaly" modal). Wikipedia is the reliable primary research source. If you add a Brave/Serper/Exa key later, you can slot it into `orchestrator/search.js`.
