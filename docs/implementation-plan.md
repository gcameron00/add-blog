# Implementation plan

Phases 1–4 are complete, in this repository, and live in production for the
`gcameron` site. Phases 5 onward are the proposed build-out.

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

**Amendment — editor (owner review, 2026-07-26) ✅.** The hand-rolled toolbar and
textarea in `admin/editor/index.html` / `assets/js/editor.js` was friendlier than raw
Markdown but still asked more of a non-technical author than it should. Decision: swap
it for a drop-in Markdown editor — a library that progressively enhances the existing
`<textarea id="body">` (toolbar buttons, live/side-by-side preview) rather than a
hand-rolled one, loaded from a CDN with no build step, the same pattern already proven
in the sibling `Vibecode` project. Implemented with **EasyMDE** (`admin/editor/index.html`
loads it via `<link>`/`<script>` tags pinned to a version, `easyMDE.value()` read back
on save/autosave). This did **not** change the editor format decision below — the
library still edits and returns plain Markdown text (`body_md`); the previewRender hook
is wired to the site's own `renderMarkdown` so the editor preview and the published post
still come from identical rendering code. No API, schema or MCP surface changes were
required. Image upload is intentionally not wired into the toolbar yet — there is no
media API until Phase 5.

---

## Phase 2 — Worker router and hostname split ✅

**Goal.** Get the two-hostname topology right before anything valuable is behind it.

- `src/index.js` with a `fetch` handler that branches on `URL.hostname`.
- Public host: serve static assets; return `404` for `/admin/*`, `/api/admin/*` and
  `/mcp` as the first check in the handler, unconditionally, before anything else runs.
- Admin host: serve admin assets; every response `private, no-store`,
  `X-Frame-Options: DENY`.
- Security headers on all responses: CSP (scoped to allow the Phase 1 EasyMDE/Font
  Awesome CDN, both pinned versions — see the Phase 1 amendment above),
  `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`.
- `/health`.
- `X-Request-Id` on every response, generated or echoed, logged per request.
- `src` and `migrations` added to `.assetsignore`.
- `npm test` (vitest, `@cloudflare/vitest-pool-workers`) runs the routing table against
  the real Workers runtime — negative cases first, per the risk note below.

**Decision (2026-07-26): one repo, many independently-deployed sites**, not one clone
per site. `src/index.js` and the whole front end stay fully generic — the hostname a
deployment answers to is read from `env.ADMIN_HOST`/`env.PUBLIC_HOST` at runtime, never
hardcoded. What differs per site lives entirely in `wrangler.toml`, one `[env.NAME]`
block per site (name, routes, vars, and from Phase 3 onward that site's own D1/R2
IDs), deployed by a GitHub Actions matrix — one `wrangler deploy --env NAME` per site,
on every push. See the comment block at the top of `wrangler.toml` and
[deployment.md](deployment.md) §3 for the mechanics, including a `run_worker_first`
requirement that isn't optional (without it, Cloudflare serves matching static assets
*before* the Worker runs, and the admin-path guard never executes for a real file like
`/admin/index.html` — found by running the router locally, not by reading the config
format). This does not reopen the single-tenant decision below — every site still gets
its own Worker, D1 and R2, fully isolated; it only adds a shared-source/many-deployments
layer in front of that.

First site: `blog.gcameron.com` / `blog-admin.gcameron.com`.

**Owner action required, per site.** The domain must already be a zone in Cloudflare
before its first deploy (routes can't attach to a zone that doesn't exist). Nothing
else — `wrangler deploy --env NAME` creates the Worker and, via Custom Domains, the DNS
record, automatically.

**Exit criteria.** `blog.gcameron.com/admin/` returns 404 in production. Both hostnames
serve their own UI. Tests cover the routing table, including the negative cases.

**Risk.** Getting the split wrong here is the highest-severity failure mode in the
project — it exposes drafts and the write API. Every routing branch gets a test, and
the negative assertions are written before the positive ones.

---

## Phase 3 — D1, R2 and the read path ✅

**Goal.** Real content, read-only, publicly served.

- `migrations/0001_init.sql` — the schema from [architecture.md](architecture.md) §3,
  including the FTS5 sync triggers the design note calls for (missing from the first
  pass — `posts_fts` silently never populated without them; caught by a test, not by
  reading the schema).
- `scripts/generate-seed.mjs` — generates `migrations/seed.sql` from
  `assets/js/demo-data.js`, so a first deploy has the same real content the demo has
  been showing since Phase 1, not an empty blog. `INSERT OR IGNORE` throughout —
  safe to apply more than once.
- Public API: `GET /api/posts`, `/api/posts/:slug`, `/api/tags`, `/api/archive`
  (`src/public-api.js`, `src/db.js`).
- Server-rendered `/posts/<slug>` with real `<title>`, meta description and Open
  Graph tags, and the article body inlined (`src/pages.js`) — works with JavaScript
  disabled; `assets/js/post.js` still hydrates on top. `/post/?slug=…` 301s here now;
  every internal link that used to point at the old form (`blog.js`, `post.js`,
  `admin.js`, `editor.js`) points at the canonical permalink directly.
- `/media/<key>` streaming from R2 with immutable caching and conditional-request
  (`If-None-Match`) support (`src/media.js`).
- `feed.xml`, `atom.xml`, `sitemap.xml`, `robots.txt` (`src/feeds.js`).
- Cache-Control headers matching architecture §5's policy on every read response.
  *Scope note:* this is HTTP-header-level caching, not explicit `caches.default`
  Worker code — there is no purge path to pair it with until Phase 5 writes exist, so
  standard Cache-Control (which Cloudflare's edge already respects) covers the read
  path without adding machinery Phase 5 would have to reconcile with later.
- Every new route checks for its own D1/R2 binding and falls through to static assets
  if it's absent — this code was safe to deploy before the bindings existed, same
  graceful "not live yet" behaviour Phase 1's demo-data fallback already relied on,
  not a 500.
- 49 tests (`@cloudflare/vitest-pool-workers`, real local D1 + R2, migrated and seeded
  per run) cover the read path against realistic data, including every non-public
  status (draft/scheduled/archived) staying invisible everywhere — the API, the feed,
  the sitemap, the permalink.

**Owner action, done for `gcameron`.** D1 database and R2 bucket created, schema and
seed applied, `wrangler.toml` bindings uncommented and deployed (2026-07-27) — see the
commands in [deployment.md](deployment.md) §1. Each *new* site repeats this once; see
the "Future considerations" section below on why that's still a manual step per site.

**Exit criteria — met, in production.** A post inserted directly into D1 appears on
the home page, at its permalink, in the tag page, in the archive and in the feed, with
correct caching. Verified locally against seeded data before deploy, then confirmed
against `blog.gcameron.com` after — real posts, `/health`, and the Phase 2 admin-path
guard all checked post-deploy.

**Risk.** The D1 schema is the most expensive thing to change later. Phase 1's demo
data is deliberately shaped exactly like the API responses, so the contract has already
been exercised by real rendering code before the tables exist.

---

## Phase 4 — Cloudflare Access and identity ✅

**Goal.** A verified identity on every admin request.

- JWT verification in the Worker (`src/access.js`): JWKS fetch and cache (keyed per
  team domain, one-hour TTL), signature, `aud`, `exp`/`iat`. Cache is exercised by test
  — a second verification within the TTL does not refetch the JWKS.
- Identity → `authors` row resolution (`src/auth.js`); `403` when no row exists — a
  verified Access identity is not an implicit account.
- Role table (`owner`/`editor`/`author`) as reusable middleware (`src/auth.js`'s `can`/
  `permissionsFor`) rather than per-route conditionals — built now so Phase 5's write
  routes call into it rather than re-deriving it.
- `audit_log` writer (`src/audit.js`) — built and tested, not yet called anywhere:
  Phase 4 has no mutations to audit. Phase 5's write routes call it at each mutation
  point.
- The guard itself lives in `src/index.js`: on the admin host, every admin-only path
  (`/admin`, `/api/admin`, `/mcp`) now requires a verified identity *and* a matching
  `authors` row, but only once a site sets `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` — a site
  that hasn't done its Phase 4 setup yet keeps today's un-gated behaviour, same
  graceful "not live yet" pattern as every Phase 3 handler.
- `GET /api/admin/me` (`src/admin-api.js`) — `assets/js/api.js` already called this
  route since Phase 1 with a demo-data fallback; no front-end changes were needed for
  the admin UI to start rendering the real role once this went live.

**Owner action, done for `gcameron`.** Access application created over
`blog-admin.gcameron.com` (self-hosted, Managed OAuth on, policy scoped to explicit
emails) — see [deployment.md](deployment.md) §4. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
are in `wrangler.toml`. Real `authors` row seeded for the owner's actual Access email
(2026-07-27) — the seeded demo authors (`grant@mysite.com`, `ada@mysite.com`) stay as
placeholder content, not real accounts.

**Exit criteria — met, in production.** Logged out → Access login. Logged in as an
unprovisioned email → 403. A JWT for another application in the same team → rejected
(confirmed both by test and by the owner's own cross-app session carrying over
correctly *without* bypassing this — see the note in [architecture.md](architecture.md)
§6 on the difference between Access silently re-authorizing an existing identity, which
is expected, and a token being replayed across applications, which `aud` blocks). Role
table enforced server-side. `GET /api/admin/me` verified against the live Access
application, returning the real identity and role.

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

## Future considerations

Ideas deliberately not acted on now — parked here rather than lost, in case the owner
comes back to one.

**Auto-provision D1/R2 instead of a one-time manual create per site (2026-07-27).**
Wrangler ≥4.45 can create a D1 database or R2 bucket itself at deploy time if
`wrangler.toml` declares the binding with no `database_id`/`bucket_name` — no
`wrangler d1 create`/`r2 bucket create` needed, and it runs non-interactively in CI
(confirmation is skipped with no TTY). That would remove the one manual per-site step
"adding a new blog" still has (see Phase 2's `wrangler.toml` comment).

Two reasons it isn't used today:

- **It doesn't work with named environments.** This repo's whole multi-site model is
  one `[env.NAME]` block per site in a shared `wrangler.toml` (Phase 2's decision,
  below). Someone hit exactly that combination and Cloudflare closed it
  [*"not planned"*](https://github.com/cloudflare/workers-sdk/issues/11167) — an
  acknowledged, deliberate limitation, not a bug pending a fix. Getting auto-provision
  working would mean restructuring away from named environments to one small
  `wrangler.toml` file per site (`wrangler deploy -c wrangler.<site>.toml`), which
  auto-provisioning does support. Real change, not a toggle — `deploy.yml`'s matrix
  would iterate config file paths instead of env names, and resources would get
  Wrangler's auto-generated names instead of the ones chosen by hand today.
- **Auto-provisioning creates an instance of a resource; it doesn't turn the
  underlying Cloudflare product on for the account.** Found the hard way: an R2
  binding in `wrangler.toml` warned before R2 itself had ever been enabled on the
  account. That's a one-time, account-level, dashboard step — orthogonal to
  per-site config, and something no amount of `wrangler.toml` restructuring removes.
  Auto-provisioning would still need this done first, same as the manual path does.

Net: revisit if a third or fourth site makes the one-time `d1 create`/`r2 bucket
create` step per site annoying enough to be worth the restructure. Not before then.

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
   expensive to reverse — it changes every table and every query. *(Refined in Phase
   2, 2026-07-26: "one deployment per site" now means one `[env.NAME]` block per site
   in a shared repo, not one repo clone per site — see Phase 2 above. Isolation is
   unchanged: still a separate Worker, D1 and R2 per site, no `site_id` anywhere.)*

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
