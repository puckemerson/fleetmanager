# FleetManager

Management system for AI-driven review sites. One portal, many sites.

## Architecture
- **Dashboard Worker**: `fleetmanager.puckemerson.workers.dev` (Hono + D1, login via `DASHBOARD_PASSWORD_HASH` Worker secret)
- **Orchestrator**: Node process on Pascal (systemd user service, 30s tick), reads due jobs from D1, executes.
- **Sites**: One GitHub repo per site, 11ty static generator, GitHub Pages deploy from `main`.
- **Storage**: D1 for state (sites, schedules, posts, jobs). Product images live in each site repo at `src/images/<slug>.jpg` (R2 is not enabled on this Cloudflare account).

## Per-site generation pipeline
1. Dashboard creates site -> repo scaffolded on GitHub, Pages enabled, D1 row inserted, unique color/font theme generated.
2. Scheduled job (cron def per site) -> orchestrator picks up a due job.
3. LLM proposes N product candidates in the site's category, dedup against D1 `posts` table.
4. Research: Wikipedia REST API is the primary source. DDG HTML is attempted as a bonus but usually returns 0 hits (server IP blocked). A paid search API (Brave/Serper/Exa) can be slotted into `orchestrator/search.js`.
5. Orchestrator reads top pages when search returns any.
6. LLM synthesizes: extracts per-product scoring categories + weights, scores each 0-100, writes first-person review.
7. Image: scrape og:image from top hits, fallback to DDG image search. Commit into the site repo (not R2).
8. Write markdown file to the site's repo, commit/push, Pages rebuilds.
9. D1 records post with final score, category scores, commit sha.

## Decisions
- GitHub Pages per site (cheap, infinite sites).
- No explicit AI disclosure on sites; reviews are first-person synthesis of real research.
- Images in-repo instead of R2.
- Wikipedia as the reliable research source until a paid search key is added.
- Per-site color scheme + font pairing generated at scaffold time; stored in site repo.
- Scoring: per-product LLM-chosen categories + weights, weighted avg = final score.
- Orchestrator on Pascal (not Workers) because generation is multi-minute and involves file writes/git.

## Status
- [x] Dashboard Worker deployed (auth + D1 schema + site CRUD + run-now) — https://fleetmanager.puckemerson.workers.dev
- [x] Orchestrator running on Pascal (systemd user service, 30s tick)
- [x] Site scaffolding template (11ty + theme generator, 8 palettes × 8 font pairs)
- [x] Review generation pipeline (Wikipedia research → Anthropic Claude synthesis → 3-5 category scoring → commit)
- [x] Image pipeline (og:image scrape + DDG image fallback, committed into each site repo)
- [x] End-to-end smoke test with a perfume site — https://puckemerson.github.io/perfume-review-lab/
- [ ] Deploy Worker `/health` so Taskdeck’s registered URL succeeds
