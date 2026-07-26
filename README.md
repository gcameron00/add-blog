# add-blog

A drop-in blog engine for Cloudflare Workers. Add it to any site and it gives that
site a public blog, an authenticated admin UI, and an MCP endpoint so an AI agent can
read and write posts the same way a human editor would.

Everything is plain HTML, CSS and JavaScript — no framework, no build step, no
bundler. The whole front end ships as Cloudflare Workers static assets.

---

## Status

**Phases 1–3 are built.** The Worker router (`src/index.js`) enforces the hostname
split and sends security headers; the public read path (JSON API, server-rendered
permalinks, R2 media, feeds) is code-complete and passing 49 tests against real local
D1/R2, but each site's *own* D1 database and R2 bucket still have to be created and
bound before that site sees real content instead of demo data — see
[`docs/deployment.md`](docs/deployment.md). There is still no write path and no
authentication.

| Layer | State |
| --- | --- |
| Public blog UI | Built (demo data until a site's D1 is bound) |
| Admin UI | Built (demo data) |
| Documentation | Built |
| Worker request router | Built and live |
| D1 schema + public read API | Built, tested — per-site resources pending (see deployment.md) |
| R2 media pipeline (read) | Built, tested — per-site bucket pending; upload is Phase 5 |
| Cloudflare Access / Managed OAuth | Specified, not built |
| MCP server | Specified, not built |

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the phased build-out.

> [!WARNING]
> **The admin UI is still not access-controlled.** Phase 2's router keeps `/admin/*`
> off the public hostname, but the admin hostname itself has no login yet — anyone who
> requests `blog-admin.<site>` directly gets the real admin UI. It is a prototype shell
> wired to demo data with no secrets in it, but treat it as public until Cloudflare
> Access lands in Phase 4.

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
│   ├── media/index.html       R2 media library
│   ├── mcp/index.html         MCP connection details and tool catalog
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
│   ├── test-setup.js          Applies migrations + seeds a local D1 before tests run
│   └── *.test.js              49 tests (`npm test`) — real local D1/R2, not mocks
├── migrations/
│   ├── 0001_init.sql          Schema — see docs/architecture.md §3
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

With no API present, `assets/js/api.js` detects the missing backend on its first call
and transparently falls back to `assets/js/demo-data.js`. Every page renders with
realistic content, and a small "Demo data" badge appears so it is never ambiguous
whether you are looking at real content. Once the Phase 3 API is live, the same
client hits `/api/*` and the badge disappears — no page changes required.

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
