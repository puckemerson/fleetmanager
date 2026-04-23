# FleetManager

Management system for AI-driven review sites. One portal, many sites.

## Architecture
- **Dashboard Worker**: `fleetmanager.puckemerson.workers.dev` (Hono + D1, simple login)
- **Orchestrator**: Node process on Pascal (systemd timer, ~30s tick), reads due jobs from D1, executes.
- **Sites**: One GitHub repo per site, 11ty static generator, GitHub Pages deploy from `main`.
- **Storage**: D1 for state (sites, schedules, posts, jobs), R2 for product images.

## Per-site generation pipeline
1. Dashboard creates site -> repo scaffolded on GitHub, Pages enabled, D1 row inserted, unique color/font theme generated.
2. Scheduled job (cron def per site) -> orchestrator picks up a due job.
3. LLM proposes N product candidates in the site's category, dedup against D1 `posts` table.
4. Brave Search verifies a candidate exists, returns top results.
5. Orchestrator reads top 3-5 pages.
6. LLM synthesizes: extracts per-product scoring categories + weights, scores each 0-100, writes first-person review.
7. Image: scrape retailer page first, fallback to Brave image search. Store on R2.
8. Write markdown file to the site's repo, commit/push, Pages rebuilds.
9. D1 records post with final score, category scores, image URL.

## Decisions
- GitHub Pages per site (cheap, infinite sites).
- No explicit AI disclosure on sites; reviews are first-person synthesis of real research.
- Brave Search API (free tier: 2000/mo).
- Per-site color scheme + font pairing generated at scaffold time; stored in site repo.
- Scoring: per-product LLM-chosen categories + weights, weighted avg = final score.
- Orchestrator on Pascal (not Workers) because generation is multi-minute and involves file writes/git.

## Status
- [x] Dashboard Worker deployed (auth + D1 schema + site CRUD + run-now) — https://fleetmanager.puckemerson.workers.dev
- [x] Orchestrator running on Pascal (systemd user service, 30s tick)
- [x] Site scaffolding template (11ty + theme generator, 8 palettes × 8 font pairs)
- [x] Review generation pipeline (Wikipedia research → Anthropic Claude synthesis → 3-5 category scoring → commit)
- [x] Image pipeline (og:image scrape + DDG image fallback, committed into each site repo instead of R2)
- [x] End-to-end smoke test with a perfume site — https://puckemerson.github.io/perfume-review-lab/

## Deviations from the initial spec
- **R2**: Not enabled on this CF account (would require manual dashboard click to activate). Images are committed to each site's repo under `src/images/<slug>.jpg` and served by GitHub Pages. Works fine for typical product-photo sizes.
- **Search**: DDG HTML blocks our server IP. Wikipedia REST API is the primary research source (reliable, no rate limits for this usage). DDG is attempted as bonus but usually returns 0 hits. Hooking up a paid search API (Brave/Serper/Exa) is a single-file change in `orchestrator/search.js`.
- **Login**: `username=will`, `password=fleetmanager` (stored as bcrypt hash in Worker secret `DASHBOARD_PASSWORD_HASH`).
