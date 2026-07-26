# add-blog

A drop-in blog engine for Cloudflare Workers. Add it to any site and it gives that
site a public blog, an authenticated admin UI, and an MCP endpoint so an AI agent can
read and write posts the same way a human editor would.

Everything is plain HTML, CSS and JavaScript — no framework, no build step, no
bundler. The whole front end ships as Cloudflare Workers static assets.

---

## Status

**Phase 1 — front end prototype.** What is in this repository today is the complete
proposed user interface, running entirely on static assets against bundled demo data.
There is no Worker script, no database, and no authentication yet.

| Layer | State |
| --- | --- |
| Public blog UI | Built (demo data) |
| Admin UI | Built (demo data) |
| Documentation | Built |
| Worker request router | Specified, not built |
| D1 schema + API | Specified, not built |
| R2 media pipeline | Specified, not built |
| Cloudflare Access / Managed OAuth | Specified, not built |
| MCP server | Specified, not built |

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the phased build-out.

> [!WARNING]
> **Do not attach a production custom domain yet.** Until the Worker router in Phase 2
> lands, every path — including `/admin/*` — is served as a public static asset on every
> hostname the deployment answers to. The admin UI is a prototype shell wired to demo
> data with no secrets in it, but it is not access-controlled. Hostname split and
> Cloudflare Access enforcement are Phase 2 and Phase 4 respectively.

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
├── wrangler.toml              Deployment config — do not edit by hand
├── .assetsignore              Files excluded from the asset bundle
└── .github/workflows/         CI/CD — do not edit by hand
```

---

## Local development

No dependencies, no build. Serve the repository root with any static file server:

```bash
python3 -m http.server 8788
# then open http://localhost:8788
```

Or, closer to production, with Wrangler:

```bash
npx wrangler dev
```

With no API present, `assets/js/api.js` detects the missing backend on its first call
and transparently falls back to `assets/js/demo-data.js`. Every page renders with
realistic content, and a small "Demo data" badge appears so it is never ambiguous
whether you are looking at real content. Once the Phase 3 API is live, the same
client hits `/api/*` and the badge disappears — no page changes required.

---

## Deployment

`.github/workflows/deploy.yml` deploys to Cloudflare Workers on every push to `main`,
using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. If those
secrets are absent the job skips cleanly.

`wrangler.toml`, `.assetsignore` and `.github/workflows/` are managed by the deployment
tooling and must not be edited by hand. This matters for the roadmap: Phase 2 needs a
`main` entrypoint and Phase 3 needs D1/R2 bindings, and both of those are
`wrangler.toml` changes that have to be made deliberately by the repository owner.
[`docs/deployment.md`](docs/deployment.md) lists the exact stanzas required.

---

## Documentation

- [Architecture](docs/architecture.md) — hostname routing, D1 schema, R2 layout, caching, threat model
- [HTTP API](docs/api.md) — public read API and authenticated admin API
- [MCP server](docs/mcp.md) — transport, auth, tools, resources
- [Deployment runbook](docs/deployment.md) — D1, R2, DNS, Access, Managed OAuth
- [Implementation plan](docs/implementation-plan.md) — phases, deliverables, decisions
