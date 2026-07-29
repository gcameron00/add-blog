# add-blog

A drop-in blog engine for Cloudflare Workers. Add it to any site and it gives that
site a public blog, an authenticated admin UI, and an MCP endpoint so an AI agent can
read and write posts the same way a human editor would.

Everything is plain HTML, CSS and JavaScript — no framework, no build step, no
bundler. The whole front end ships as Cloudflare Workers static assets.

---

## Status

**Phases 1–4 are built and live; Phase 5's posts, settings, dashboard, media upload
and the scheduled-post cron are built, tested, and live too; author management is
deployed for `gcameron` pending a hands-on verification pass; tag management and the
editor's media integration are built and tested, pending deployment.** The Worker
router (`src/index.js`) enforces the hostname split and sends security headers; the
public read path (JSON API, server-rendered permalinks, R2 media, feeds) is live for
`gcameron`, backed by real D1/R2. Access JWT verification and identity resolution
(`src/access.js`, `src/auth.js`) are live too — the admin hostname is genuinely
access-controlled, not a public prototype. The admin Posts API, Settings, the
dashboard's stats/activity feed, media upload (`src/admin-media.js`), and the
scheduled-post auto-publish cron (`src/cron.js`) are all live and verified in
production. The Authors admin page (`src/admin-authors.js`) has its migration applied
and its Worker code deployed for `gcameron`, but hasn't had the hands-on production
check the other live slices got yet (see [deployment.md](docs/deployment.md) §6). The
Tags admin page (`src/admin-tags.js`) and the editor's cover-image/insert-from-library
integration are tested (200 tests total) and browser-verified against demo data, but
not yet deployed. Export/import is still queued — see the Phase 5 breakdown in
[implementation-plan.md](docs/implementation-plan.md). A *new* site still needs its
own D1 database, R2 bucket and Access application created before it shows real content
and requires login instead of demo data — see [`docs/deployment.md`](docs/deployment.md)
and the "Future considerations" section of the
[implementation plan](docs/implementation-plan.md) on why that's a one-time manual step
per site.

| Layer | State |
| --- | --- |
| Public blog UI | Live for `gcameron`; demo data for any site not yet bound |
| Admin UI | Access-controlled and writable for `gcameron` |
| Documentation | Built |
| Worker request router | Built and live |
| D1 schema + public read API | Built, tested, live for `gcameron` |
| R2 media pipeline (read) | Built, tested, live for `gcameron` |
| Cloudflare Access / identity (`GET /me`) | Built, tested, live for `gcameron` |
| Admin Posts API (CRUD, publish, revisions) | Built, tested, live for `gcameron` |
| Admin Settings + dashboard (`stats`, `audit`) | Built, tested, live for `gcameron` |
| Media upload (validation, checksum dedupe, dimensions) | Built, tested, live for `gcameron`. No SVG (parked as a future feature, needs a real sanitiser); AVIF has no dimensions |
| Scheduled-post auto-publish + revision retention (cron) | Built, tested, live for `gcameron` — verified 2026-07-29: a scheduled post auto-published within its 5-min window, logged `via: 'cron'` |
| Media ↔ editor integration (cover picker, insert-into-body) | Built, tested; not yet deployed — media was previously upload-only, disconnected from the editor |
| Tags admin (CRUD, merge, `admin/tags/`) | Built, tested; not yet deployed |
| Authors admin (CRUD, disable, `admin/authors/`) | Deployed for `gcameron`; not yet hands-on verified in production |
| Export/import admin routes | Not built — no admin UI page calls them yet |
| Managed OAuth (for `/mcp`) | Enabled on the Access app; unused until Phase 6 |
| MCP server | Specified, not built |

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the phased build-out.

> [!WARNING]
> **Access-control is per site, not automatic.** Phase 2's router keeps `/admin/*` off
> the public hostname on every site, but the admin hostname itself only requires login
> once that site has its own Cloudflare Access application and `ACCESS_TEAM_DOMAIN`/
> `ACCESS_AUD` set (Phase 4 — see [`docs/deployment.md`](docs/deployment.md) §4). `gcameron`
> has this done and verified live. A *new* site is a public, unauthenticated admin
> prototype until that setup is repeated for it.

---

## How it is meant to work

One deployment serves two hostnames, and the Worker decides what to do based on which
hostname the request arrived on.

```
                        ┌─────────────────────────────┐
  blog.mysite.com ─────▶│                             │──▶ D1    (posts, tags, metadata)
  (public, cached)      │    add-blog Worker          │
                        │    - hostname router        │──▶ R2    (images, attachments)
  blog-admin.mysite.com │    - static asset serving   │
  (Cloudflare Access) ─▶│    - JSON API               │──▶ Cache API (public reads)
       └── /mcp ───────▶│    - MCP server             │
                        └─────────────────────────────┘
```

**`blog.mysite.com`** — the public blog. Anonymous, aggressively cached, read-only.
Serves the post list, individual posts, tag pages, the archive, `feed.xml` and
`sitemap.xml`.

**`blog-admin.mysite.com`** — the editor. Sits behind Cloudflare Zero Trust Access, so
unauthenticated requests never reach the Worker. Serves the admin SPA-ish pages, the
write API, the media library, and `/mcp`.

**`blog-admin.mysite.com/mcp`** — a Model Context Protocol endpoint exposing the same
capabilities as the admin UI as MCP tools, authenticated through Cloudflare Access
Managed OAuth. An MCP client authenticates once and can then list, draft, edit and
publish posts.

Storage splits along the obvious line: **D1** holds structured content (posts, tags,
authors, revisions, settings) and **R2** holds binary media (images, attachments),
with D1 keeping the metadata row that points at each R2 object.

---

## Repository layout

```
.
├── index.html                 Public blog — post list
├── post/index.html            Public blog — single post (?slug=…)
├── archive/index.html         Public blog — all posts by year
├── tags/index.html            Public blog — tag index and per-tag filter
├── about/index.html           About this project
├── 404.html                   Not-found page
├── admin/
│   ├── index.html             Dashboard
│   ├── posts/index.html       Post list, filters, bulk actions
│   ├── editor/index.html      Markdown editor with live preview
│   ├── tags/index.html        Tag list — rename, delete, merge
│   ├── media/index.html       R2 media library
│   ├── mcp/index.html         MCP connection details and tool catalog
│   ├── authors/index.html     Author list — add, rename, change role, disable, delete
│   └── settings/index.html    Blog settings
├── assets/
│   ├── css/styles.css         Public site styles + design tokens
│   ├── css/admin.css          Admin styles (extends the same tokens)
│   ├── js/api.js              API client, with demo-data fallback
│   ├── js/demo-data.js        Sample content used until the API exists
│   ├── js/markdown.js         Small, escaping-first Markdown renderer
│   ├── js/blog.js             Public list/archive/tag rendering
│   ├── js/post.js             Public single-post rendering
│   ├── js/admin.js            Admin shell: nav, toasts, shared helpers
│   ├── js/editor.js           Editor page logic
│   └── js/main.js             Shared bootstrap (theme, nav)
├── docs/
│   ├── architecture.md        Routing, data model, caching, security
│   ├── api.md                 HTTP API contract
│   ├── mcp.md                 MCP server design and tool catalog
│   ├── deployment.md          Cloudflare setup runbook
│   └── implementation-plan.md Phased build-out
├── src/
│   ├── index.js              The Worker: hostname router, headers, /health, dispatch
│   ├── db.js                 D1 queries → docs/api.md response shapes
│   ├── public-api.js         GET /api/posts, /posts/:slug, /tags, /archive
│   ├── pages.js               Server-rendered /posts/:slug + the legacy redirect
│   ├── media.js               GET /media/:key — R2 streaming
│   ├── feeds.js               feed.xml, atom.xml, sitemap.xml, robots.txt
│   ├── access.js              Cloudflare Access JWT verification (Phase 4)
│   ├── auth.js                 Role table + authors-row resolution (Phase 4)
│   ├── audit.js                 audit_log writer, called from every Phase 5 mutation
│   ├── validate.js             Admin write-API request validation (Phase 5)
│   ├── admin-http.js           Shared admin route plumbing: errors, CSRF, permission checks
│   ├── admin-db.js             D1 write queries: posts, tags, revisions, media (Phase 5)
│   ├── admin-posts.js          Admin Posts API — CRUD, publish, revisions (Phase 5a)
│   ├── admin-settings.js       GET/PUT /api/admin/settings (Phase 5b)
│   ├── admin-dashboard.js      GET /api/admin/stats, /api/admin/audit (Phase 5b)
│   ├── media-parse.js          Checksum, filename sanitising, header-only dimensions (Phase 5c)
│   ├── admin-media.js          Admin Media API — upload, list, usage, delete-with-guard (Phase 5c)
│   ├── admin-tags.js           Admin Tags API — CRUD, merge (Phase 5d)
│   ├── admin-authors.js        Admin Authors API — CRUD, disable, last-owner guard (Phase 5e)
│   ├── cache-purge.js          Edge cache purge on mutation, via caches.default (Phase 5)
│   ├── cron.js                 scheduled() handler — auto-publish due posts (Phase 5f)
│   ├── admin-api.js           GET /api/admin/me (Phase 4) + dispatch to the Phase 5 routes
│   ├── test-jwt.js             Test-only helper: signs fake Access JWTs
│   ├── test-setup.js          Applies migrations + seeds a local D1 before tests run
│   └── *.test.js              200 tests (`npm test`) — real local D1/R2, not mocks
├── migrations/
│   ├── 0001_init.sql          Schema — see docs/architecture.md §3
│   ├── 0002_authors_disabled.sql  Additive: authors.disabled (Phase 5e)
│   ├── 0003_audit_via_cron.sql    Rebuild: audit_log.via + 'cron' (Phase 5f)
│   └── seed.sql               Generated — see scripts/generate-seed.mjs
├── scripts/
│   ├── generate-seed.mjs      assets/js/demo-data.js → migrations/seed.sql
│   └── seed-db.mjs            Same seed data, applied directly — used by tests
├── wrangler.toml               One shared Worker, one [env.NAME] block per site
├── .assetsignore               Files excluded from the asset bundle
├── package.json                Test tooling only — the front end stays build-step-free
└── .github/workflows/          CI/CD — deploys every [env.NAME] site on push to main
```

---

## Local development

No dependencies, no build. Serve the repository root with any static file server:

```bash
python3 -m http.server 8788
# then open http://localhost:8788
```

Or, closer to production, with Wrangler — this runs the real `src/index.js` router
locally (hostname split, headers, `/health`) against a chosen site's config:

```bash
npx wrangler dev --env gcameron
# or plain `npx wrangler dev` to run it against the placeholder hostnames
# (blog.mysite.com / blog-admin.mysite.com) rather than any real site
```

Per endpoint, if the real one isn't live yet, `assets/js/api.js` detects that on first
call and transparently falls back to `assets/js/demo-data.js`. Every page renders with
realistic content, and a small "Demo data" badge appears so it is never ambiguous
whether you are looking at real content. `gcameron`'s public read endpoints are live
now, so `blog.gcameron.com` shows real content with no badge; the admin API isn't built
yet (Phases 4-5), so the admin UI still shows the badge everywhere, on every site — no
page changes needed either way, the client just starts succeeding as each route ships.

The Worker itself (`src/index.js`) has its own test suite, separate from the front
end's no-build-step approach — it's server-side code, not shipped to a browser:

```bash
npm install
npm test
```

---

## Deployment

add-blog is one shared codebase deployed to multiple independent sites — one Worker,
one D1, one R2 *per site*, never shared, but all from this one repo. Each site is a
`[env.NAME]` block in `wrangler.toml`; `.github/workflows/deploy.yml` runs
`wrangler deploy --env <site>` once per site, on every push to `main`, using
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets (the job skips
cleanly if those aren't set).

Adding a new site is a config change, never a code change: add the domain as a zone in
Cloudflare, add its `[env.NAME]` block, add its name to `deploy.yml`'s `site` matrix,
push. See [`docs/deployment.md`](docs/deployment.md) for the exact steps and the one
`wrangler.toml` setting (`run_worker_first`) that isn't optional.

---

## Documentation

- [Architecture](docs/architecture.md) — hostname routing, D1 schema, R2 layout, caching, threat model
- [HTTP API](docs/api.md) — public read API and authenticated admin API
- [MCP server](docs/mcp.md) — transport, auth, tools, resources
- [Deployment runbook](docs/deployment.md) — D1, R2, DNS, Access, Managed OAuth
- [Implementation plan](docs/implementation-plan.md) — phases, deliverables, decisions
