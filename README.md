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
# Login to the dashboard
curl -s -c cookies.txt -X POST https://fleetmanager.puckemerson.workers.dev/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"will","password":"fleetmanager"}'

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

## Pipeline (per post)

1. Orchestrator picks up a due `generate_post` job.
2. LLM proposes 10 candidate products in the site's category; filter out already-reviewed.
3. Research: Wikipedia summary + DDG best-effort + scrape top hits.
4. LLM synthesizes: picks 3-5 scoring categories, weights, scores, writes 400-700 words first-person review (strict JSON output).
5. Product image: scrape og:image from top search hits, fallback to DDG image search. Store in the site's own repo at `src/images/<slug>.jpg`.
6. Commit markdown + image to the site repo. GitHub Pages rebuilds on push.
7. D1 record inserted with final score + category breakdown + commit sha.

## D1 schema

See `dashboard/migrations/0001_init.sql`.

## Notes

- R2 was not enabled on this Cloudflare account; images are committed into each site repo instead of R2. This is simpler and works fine for the typical image sizes (~50-1000 KB).
- DDG HTML endpoint blocks our server IP ("anomaly" modal). Wikipedia is the reliable primary research source. If you add a Brave/Serper/Exa key later, you can slot it into `orchestrator/search.js`.
