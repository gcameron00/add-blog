# Implementation plan

Phase 1 is complete and in this repository. Phases 2 onward are the proposed build-out.

Each phase is independently deployable and leaves the site working. Phases 2–5 are
sequential — routing before storage, storage before auth, auth before the write path.
Phase 6 (MCP) depends only on Phases 3 and 4 and can run in parallel with 5.

---

## Phase 1 — Front end prototype ✅

**Goal.** Agree on the product before building the backend, by making the whole thing
clickable.

Delivered:

- Public blog: home, single post, archive, tag index, about, 404.
- Admin: dashboard, post list, Markdown editor with live preview, media library, MCP
  page, settings.
- Design tokens shared across both surfaces; light and dark; responsive; keyboard
  accessible.
- `assets/js/api.js` — the real API client, written against the Phase 3 contract, with
  a demo-data fallback so every page renders today.
- Documentation: README, architecture, API contract, MCP design, deployment runbook.

**Deliberately not in Phase 1.** No Worker script. `wrangler.toml` has no `main`, and
adding one is the owner's call (see [deployment.md](deployment.md) §3). Building a
Worker that cannot be wired up would be dead code in the asset bundle.

**Exit criteria.** Owner has reviewed the UI and the API contract, and the shape of
the data model is agreed. Changing the contract is cheap now and expensive after
Phase 3.

**Amendment — editor (owner review, 2026-07-26).** The hand-rolled toolbar and
textarea in `admin/editor/index.html` / `assets/js/editor.js` is friendlier than raw
Markdown but still asks more of a non-technical author than it should. Decision: swap
it for a drop-in Markdown editor — a library that progressively enhances the existing
`<textarea id="body">` (toolbar buttons, live/side-by-side preview, image
drag-and-drop) rather than a hand-rolled one, loaded from a CDN with no build step, the
same pattern already proven in the sibling `Vibecode` project (EasyMDE, loaded via
`<script>`/`<link>` tags, `easyMDE.value()` read back on save). This does **not**
change the editor format decision below — the library still edits and returns plain
Markdown text (`body_md`), it just gets a nicer toolbar than
`assets/js/editor.js`'s current hand-rolled `ACTIONS` map. No API, schema or MCP
surface changes required. Tracked as outstanding front-end work, not yet implemented.

---

## Phase 2 — Worker router and hostname split

**Goal.** Get the two-hostname topology right before anything valuable is behind it.

- `src/index.js` with a `fetch` handler that branches on `URL.hostname`.
- Public host: serve static assets; return `404` for `/admin/*`, `/api/admin/*` and
  `/mcp` as the first check in the handler.
- Admin host: serve admin assets; every response `private, no-store`.
- Security headers on all responses: CSP, `X-Content-Type-Options`,
  `Referrer-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY` on admin.
- `/health` returning build metadata.
- `X-Request-Id` on every response, echoed into logs.
- Add `src` and `migrations` to `.assetsignore`.

**Owner action required.** `main` and `routes` in `wrangler.toml`.

**Exit criteria.** `blog.mysite.com/admin/` returns 404 in production. Both hostnames
serve their own UI. Tests cover the routing table, including the negative cases.

**Risk.** Getting the split wrong here is the highest-severity failure mode in the
project — it exposes drafts and the write API. Every routing branch gets a test, and
the negative assertions are written before the positive ones.

---

## Phase 3 — D1, R2 and the read path

**Goal.** Real content, read-only, publicly served.

- `migrations/0001_init.sql` — the schema from [architecture.md](architecture.md) §3.
- A minimal migration runner (`wrangler d1 migrations apply`) plus a seed script.
- Public API: `GET /api/posts`, `/api/posts/:slug`, `/api/tags`, `/api/archive`.
- Server-rendered `/posts/<slug>` with correct `<title>`, meta description and Open
  Graph tags. `/post/?slug=…` becomes a 301 to the canonical permalink.
- `/media/<key>` streaming from R2 with immutable caching.
- `feed.xml`, `atom.xml`, `sitemap.xml`, `robots.txt`.
- Cache API integration with the policies in architecture §5.
- The front end stops falling back to demo data on its own — no page changes needed.

**Owner action required.** D1 and R2 bindings in `wrangler.toml`.

**Exit criteria.** A post inserted directly into D1 appears on the home page, at its
permalink, in the tag page, in the archive and in the feed, with correct caching.

**Risk.** The D1 schema is the most expensive thing to change later. Phase 1's demo
data is deliberately shaped exactly like the API responses, so the contract has already
been exercised by real rendering code before the tables exist.

---

## Phase 4 — Cloudflare Access and identity

**Goal.** A verified identity on every admin request.

- Access application over `blog-admin.mysite.com`, Managed OAuth enabled.
- JWT verification in the Worker: JWKS fetch and cache, signature, `aud`, `exp`/`iat`.
- Identity → `authors` row resolution; `403` when no row exists.
- Role checks (`owner`/`editor`/`author`) as reusable middleware rather than per-route
  conditionals.
- `GET /api/admin/me`; the admin UI renders controls from the real role and drops its
  demo identity.
- `audit_log` writes wired up.

**Owner action required.** Access application, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
vars.

**Exit criteria.** Logged out → Access login. Logged in as an unprovisioned email →
403. A JWT for another application in the same team → rejected. Role table enforced
server-side, verified by test.

---

## Phase 5 — Write path

**Goal.** The admin UI stops being a prototype.

- Admin post API: create, read, update, soft/hard delete, publish, unpublish,
  schedule, duplicate.
- Server-side Markdown rendering with sanitisation; `body_html` written on save.
- Revisions with autosave, listing, diff and restore.
- Tag CRUD and merge.
- Media upload through the Worker: validation, size cap, checksum keying, SVG
  sanitisation, dimension detection, `media` rows, usage tracking, delete-with-guard.
- Lazy image variants written back to R2.
- Cache purge on every mutation, via one shared publish path.
- Cron trigger for scheduled publishing and revision retention.
- Optimistic concurrency (`ETag` / `If-Match`) surfaced in the editor as a conflict
  prompt rather than a silent overwrite.
- `POST /api/admin/export` and `/import`.

**Owner action required.** `[triggers] crons` in `wrangler.toml`.

**Exit criteria.** A post can be written, saved, previewed, scheduled, published,
edited and unpublished entirely through the UI, with the public site reflecting each
change within the cache window.

---

## Phase 6 — MCP server

**Goal.** An agent can do what an editor can do, and no more.

- `POST /mcp`, Streamable HTTP, JSON-RPC.
- `/.well-known/oauth-protected-resource` and the `401` challenge that starts the
  Managed OAuth flow.
- Bearer token verification sharing Phase 4's verifier.
- Tools, resources and prompts per [mcp.md](mcp.md), with the tool list filtered by
  the caller's role.
- `via = 'mcp'` on every audit entry.
- Per-identity rate limiting on write tools.
- The admin MCP page shows live connection details and the caller's tool catalog.

**Exit criteria.** Claude Code and Claude Desktop both connect, complete OAuth, list
tools, and successfully run a draft → edit → publish sequence. An `author`-role
identity does not see `publish_post`. Every action appears in the audit log.

---

## Phase 7 — Polish and operations

- Search UI on the public site backed by FTS.
- Related posts, reading progress, copy-link-to-heading.
- OG image generation for posts without a cover.
- Privacy-preserving view counts (no cookies, no third-party analytics).
- Scheduled content export to R2.
- Dashboard stats from real data.
- Lighthouse budget in CI; accessibility audit; RSS validation.
- Import from Ghost, WordPress and Markdown archives.

---

## Decisions

These were open questions for the owner. Each had a working default so nothing was
blocked in the meantime; all six were confirmed by the owner on 2026-07-26, five as
the stated default and one (editor format) with a refinement. Kept here, rather than
deleted, as the record of why.

1. **Single-tenant or multi-tenant?** The plan assumes one deployment per site: one
   Worker, one D1, one R2. Simple and safely isolated. A shared multi-tenant
   deployment keyed on hostname would be cheaper at scale but puts a `site_id`
   predicate on every query, where one missing `WHERE` clause leaks another site's
   drafts. **Decided: single-tenant.** This is the one decision that is genuinely
   expensive to reverse — it changes every table and every query.

2. **How does the blog attach to the parent site?** Subdomain (`blog.mysite.com`) is
   assumed and is what the routing is built for. A subpath (`mysite.com/blog`) would
   need the parent site to route through this Worker, which is a much bigger ask of
   the host site. **Decided: subdomain** (`blog.mysite.com`), with `base_path` in
   settings so subpath support is a later addition rather than a rewrite.

3. **Comments.** Out of scope as written. If wanted, the least-bad option is a
   moderated comment table in D1 with Turnstile, rather than an embedded third party.
   **Decided: no comments.**

4. **Editor format.** Markdown, stored as the source of truth. A rich-text editor
   would be friendlier for non-technical authors but makes the MCP surface worse — a
   model editing Markdown is far more reliable than one editing a rich-text document
   model. **Decided: Markdown stays the source of truth**, confirming the default —
   but with the friendliness gap closed by a better editor rather than by accepting
   raw Markdown syntax as the ceiling. See the Phase 1 amendment above: a drop-in
   editor that progressively enhances a plain `<textarea>` (toolbar, live preview,
   image drop) while still reading and writing plain Markdown text, so the MCP
   argument in this question's rationale is unaffected.

5. **Media variants: eager or lazy?** Lazy generation is assumed — cheaper, and no
   work for images never displayed at that size. Eager generation on upload gives
   predictable first-load latency. **Decided: lazy.**

6. **Should the public site be static-generated?** Rendering from D1 per request with
   edge caching is simpler and makes publishing instant. Pre-generating HTML into R2
   on publish would cut cold-path latency further. **Decided: render-and-cache**;
   revisit only if measurements justify it.
