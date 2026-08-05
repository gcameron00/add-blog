# Implementation plan

Phases 1–5 are complete, in this repository, and live in production for the
`gcameron` site. Phase 5 shipped as slices (5a–5g): posts, settings/dashboard, media
upload, scheduled-post auto-publish + revision retention, and the editor's save-conflict
handling are live and verified in production; tags-as-a-resource (5d),
authors-as-a-resource (5e), and the editor's cover-image/insert-from-library
integration are deployed for `gcameron` too, awaiting only a hands-on verification pass
(not a deploy, and not a blocker) — see Phase 5 below for the exact breakdown.
Export/import moved to Phase 7 (2026-07-29, owner decision) — Phase 5 turned out not to
need it to be a complete write path.

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

## Phase 5 — Write path ✅ (5a–5g all deployed and live for `gcameron`; tags, authors, media integration, and conflict-handling autosave await a hands-on verification pass — non-blocking, see each slice below)

**Goal.** The admin UI stops being a prototype.

Phase 5 turned out to be several independently-shippable slices, not one. Each slice
was scoped to routes the shipped admin UI already calls (same rule Phase 4's `GET /me`
followed) — Tags-as-a-resource and Authors CRUD are deliberately not in 5a or 5b
because nothing in `assets/js/admin.js` calls them yet; building them ahead of a UI
that uses them would just be untested surface no one exercises.

**5a — Posts. Built, tested, and live for `gcameron` (`src/admin-posts.js`,
`src/admin-db.js`, `src/validate.js`, `src/cache-purge.js`):**

- Admin post API: create, read, update, soft/hard delete (hard is owner-only),
  publish, unpublish, schedule, duplicate — every route in
  [api.md](api.md)'s Posts table.
- Server-side Markdown rendering (`assets/js/markdown.js`'s escaping-first renderer,
  already pure/DOM-free and reused server-side as-is); `body_html`, `word_count`,
  `reading_minutes` computed and stored on every write that changes `body_md`.
- Role/ownership checks (`src/auth.js`'s table from Phase 4) enforced server-side on
  every write — `editOwn` vs `editOthers` resolved from the post's actual author, not
  just the caller's role.
- Revisions: a row on create and on every content-changing save, `GET` list and
  single-revision routes, and restore (which itself snapshots the pre-restore state as
  a new revision first, per the spec). No dedicated diff *endpoint* — none is in the
  API contract; diffing two revisions' `body_md` is a front-end concern for later.
- `ETag` / `If-Match`: `GET` returns one, `PATCH` honours `If-Match` and 409s with both
  versions in `detail` on a mismatch. The editor's own handling of that `409` is 5g,
  below.
- Cache purge on every mutation that touches a published post, via
  `caches.default` (`src/cache-purge.js`) — no new Cloudflare API token needed. Purges
  the post's own permalink/API URL (old and new slug on a rename), home, feeds,
  sitemap, and its tag pages; cannot purge every filtered `/api/posts?…` variant, which
  still relies on its existing short `max-age`.
- Same-origin `Origin` check and `Content-Type: application/json` enforcement on every
  write route, per docs/architecture.md §6.
- `POST /api/admin/preview`.
- 32 new tests. One real bug the tests caught before it shipped: the ownership check
  compared against a field (`post.author_id`) that didn't exist on the mapped response
  shape (it's nested at `post.author.id`), which would have silently treated every
  "edit your own post" as "edit someone else's" — 403ing an `author`-role user out of
  their own drafts.

**Fixed in production (found 2026-07-28, fixed same session).** Editing an
already-published post showed a **"Save draft"** button (`assets/js/editor.js`), but
saving edits a published post *in place* and purges the public cache — the change went
live immediately, not into a pending draft. This was never an API bug: `PATCH
/api/admin/posts/:id` does exactly what it's documented to do, and there's no
"unpublished pending edit of a published post" concept in the data model — a post has
exactly one row and one status. It was a front-end copy/UX gap left over from Phase 1's
demo prototype, where "Save draft" only ever applied to genuinely-unpublished posts.
**Fix chosen:** relabel the button — "Save changes" for a published/scheduled post,
"Save draft" only for an actual draft. The alternative (an actual pending-edit-of-a-
published-post concept — a shadow draft row, a `pending_body_md` column) is a real
design decision, not a copy fix, and wasn't warranted for what turned out to be a
labelling problem.

**5b — Settings and dashboard reads. Built, tested, and live for `gcameron`
(`src/admin-settings.js`, `src/admin-dashboard.js`):**

- `GET`/`PUT /api/admin/settings` — `assets/js/admin.js`'s settings page has called
  both since Phase 1. `PUT` is owner-only, rejects unknown keys, and only touches keys
  present in the request (the settings form only submits fields it has inputs for, so a
  literal full-replace `PUT` would have silently deleted `social_image_key` — the
  settings table's only key not on the visible form — every time someone saved).
  **Doc fix alongside this:** the key allow-list here — and now in [api.md](api.md) —
  is the actual union of what `migrations/seed.sql` seeds and what
  `admin/settings/index.html`'s form submits (11 keys, including `admin_url`), not the
  slightly different list this doc originally sketched (which had an unused
  `theme_accent` and was missing `admin_url`).
- `GET /api/admin/stats` — post counts by status, total `word_count`, media count
  (0 until Phase 5's media slice ships), next scheduled post. No "views" figure —
  nothing collects page views yet, `analytics_enabled` is a stored preference with no
  collection code behind it regardless of its value.
- `GET /api/admin/audit` — filterable by `actor`/`action`/`via`, newest first. Required
  going back through every `writeAuditLog` call in `src/admin-posts.js` to add a
  `title` to each one's `detail` (some only had `slug`, `fields`, or a bare id before)
  so the dashboard's activity feed shows a real post title per entry instead of nothing
  — `assets/js/admin.js` renders `entry.detail` as plain text, unchanged since Phase 1.
- 15 new tests (122 total).

**Follow-up UI cleanup (2026-07-28), once 5a/5b were confirmed live.** Two pieces of
Phase 1/4 UI copy had gone stale now that real data backs them:
- The dashboard's "Access-controlled; still a read-only prototype" callout
  (`admin/index.html`) is gone — it described the Phase 4→5 gap, which has closed, and
  it duplicated what the existing per-page "Demo data" banner (`assets/js/main.js`,
  fires on `addblog:demo-mode`) already signals automatically, page by page, more
  accurately than a static blanket notice could.
- Settings' "Reset demo data" card (`admin/settings/index.html`) is now conditional on
  `api.isDemoMode()` rather than always shown — `initSettings()` in `assets/js/admin.js`
  reveals it only after `getSettings()` resolves and confirms the page is actually
  running against demo data. It stays hidden by default in the markup (avoids a flash
  of it before JS runs) and still works exactly as before for a new site that hasn't
  reached Phase 5 yet, or for the no-Worker `python3 -m http.server` local dev path.

**5c — Media upload. Built, tested, and live for `gcameron`
(`src/admin-media.js`, `src/admin-db.js`, `src/media-parse.js`):**

- `POST /api/admin/media` (`multipart/form-data`), `GET /api/admin/media` (filters:
  `q`, `type`, `unused=true`), `GET /api/admin/media/:key/usage`,
  `PATCH /api/admin/media/:key` (alt/filename), `DELETE /api/admin/media/:key`
  (`409` if referenced — cover or an inline `/media/<key>` match in `body_md` — unless
  `?force=true`). `assets/js/admin.js`'s media page has called `listMedia`/
  `deleteMedia` since Phase 1 against a dropzone that was a static "Uploads arrive in
  Phase 5" placeholder with no `<input type="file">` at all; both the routes and that
  placeholder are real now (drag-and-drop, multi-file, plus a keyboard/screen-reader-
  reachable "Choose files" control — see the follow-up note below on why alt text
  isn't collected at upload time).
- Content-addressed keys (`<yyyy>/<mm>/<sha256-prefix16>-<sanitised-filename>`, per
  [architecture.md](architecture.md) §4) via `crypto.subtle.digest`. Uploads are
  idempotent by design: the same bytes uploaded twice return the existing object
  (`200`) rather than writing a duplicate (`201`) — verified by test, including that a
  *different filename* with identical bytes still dedupes on content.
- Dimension detection straight from each format's header (no `Image`/canvas in
  Workers) — PNG, JPEG, GIF, WebP (VP8/VP8L/VP8X, whichever chunk type the encoder
  used), each parsed against **real files** (`magick -size WxH xc:color out.ext`),
  not hand-built byte arrays — see `src/media-parse.test.js`. **AVIF is not
  parsed** — its dimensions live in a nested ISOBMFF box structure that's real parsing
  work on its own; AVIF still uploads and stores fine, just with `width`/`height` left
  `null`, rather than shipping an untested guess.
- Size cap (25 MB) and a content-type allow-list: `image/jpeg`, `image/png`,
  `image/webp`, `image/avif`, `image/gif`, `application/pdf`.
  **`image/svg+xml` is deliberately not in the allow-list.** SVG is an executable
  format, and a regex-based "sanitiser" for something this XSS-sensitive would give
  false confidence rather than real safety — a real sanitiser is a parser, not a
  string-surgery approximation. Owner call (2026-07-28): parked as a possible future
  feature, not a near-term priority — revisit only if SVG upload is actually wanted.
- **Doc/code fix alongside this:** `assets/js/demo-data.js`'s `MEDIA` fixture and
  `admin.js`'s "Copy URL" button both predated this slice and disagreed with the
  Phase 3 convention — demo `key`s had a baked-in `media/` prefix, and "Copy URL" did
  `` `/${item.key}` `` instead of using a proper `url` field, so on live data it would
  have copied a URL missing `/media/` entirely. Fixed to match `src/db.js`'s
  established shape: `key` is always the bare storage key, `url` is `/media/<key>`,
  in both the real API response and the demo fallback.
- A real D1 issue found and fixed along the way: the delete-guard/usage query used
  `body_md LIKE '%...%'` to check whether a post references a key inline; D1 rejected
  some of those as `LIKE or GLOB pattern too complex`. Switched to `instr(body_md, ?)
  > 0` — a literal substring check, which is what this actually was; there was never
  a real wildcard pattern here; `LIKE` was the wrong tool, not just a triggered edge
  case.
- 20 new tests (154 total) — real multipart `Request`/`FormData`/`File` objects,
  real R2 (`env.MEDIA.get`/`.delete` asserted directly, not just the JSON response),
  real audit_log rows, real usage/delete-guard scenarios via actual post rows.
  Verified by hand too: the demo-mode upload/delete/edit-alt/drag-and-drop flow was
  driven end-to-end in a real browser (Edge via Playwright) against the static-file
  dev path, not just asserted against the Worker.

**Follow-up fixes (2026-07-28), from the owner's first real upload in production:**
- **The thumbnail was never real.** The media grid showed a generic image icon for
  every image regardless of content — `admin.js` never rendered an `<img>`. Fixed to
  show the actual file via its `url`, `object-fit: cover` inside the existing
  aspect-ratio box.
- **Action buttons overflowed the card.** Three text-labelled buttons ("Copy URL",
  "Edit alt", "Delete") in an 11rem-minimum grid cell clipped the last one. Fixed with
  `flex-wrap` on the action row plus a wider 13rem minimum card size, rather than
  shrinking to icon-only buttons that would've cost the clear labelling.
- **Alt text is no longer collected at upload time.** The owner's read: requiring it
  up front slows down the one thing the form exists to do, and rules out selecting
  more than one file at once. Uploads now go through immediately with no alt text,
  the file input takes multiple files (and so does drag-and-drop), and each card's
  existing "Missing alt text" flag — unchanged — is the nudge to fix it afterward via
  "Edit alt", not a blocker before it.

**5d — Tags as their own resource. Built, tested, and deployed for `gcameron` since
2026-07-28 — not yet hands-on verified in production (`src/admin-tags.js`,
`src/admin-db.js`):**

- `GET /api/admin/tags` (all tags with counts, including ones on zero posts — counted
  across every post status, unlike the public `GET /api/tags`, which only counts
  published), `POST /api/admin/tags` (slug derived from `name` if omitted),
  `PATCH /api/admin/tags/:id` (rename and/or re-slug), `DELETE /api/admin/tags/:id`
  (cascades its `post_tags` rows, detaching it from every post), and
  `POST /api/admin/tags/merge` (`{ from: [slugs], into: slug }`, reassigns every
  `from`-tagged post onto `into` and deletes the `from` tags). Posts could already
  *attach* tags — `setPostTags` in `src/admin-db.js` has created a tag on first use
  since Phase 5a — this is the missing piece: managing the tag list on its own, and the
  admin UI page (`admin/tags/index.html`) to do it from.
- `tags.manage` added to the role table (`src/auth.js`) — `owner`/`editor`, the same
  level as `post.editOthers`, since a rename or delete touches every post carrying that
  tag, not just the caller's own. `GET` only requires a signed-in identity, matching
  every other admin list route.
- Merging is a straight `INSERT OR IGNORE` into `post_tags` per carried-over post,
  keyed on the table's composite primary key — a post already carrying both the `from`
  and `into` tag would collide with a plain `UPDATE tag_id`, so this goes row-by-row
  through the junction table instead; then the `from` tag is deleted, which cascades
  its own now-redundant `post_tags` rows the same way `DELETE /tags/:id` does.
- The admin UI (`admin/tags/index.html`, `assets/js/admin.js`'s `initTags`) is a single
  table: a name field to add a tag, per-row Rename/Delete (via `prompt()`/`confirm()`,
  the same pattern as Media's "Edit alt"/"Delete" rather than a new dialog component
  for two single-field forms), and a checkbox column feeding "Merge selected…" — the
  only action here whose meaning depends on more than one row being picked.
- **Not built:** renaming a tag's slug doesn't leave a redirect behind. The public tag
  page (`/tags/?tag=<slug>`) is a live query-parameter filter against the *current*
  slug, not a static route with its own history, so a bookmark or inbound link to the
  old slug just returns zero posts rather than 404ing — annoying, not broken. A
  redirect table is real schema work this slice didn't need to do to make tag
  management usable.
- 19 new tests (173 total) — permission checks per role, slug-collision 409s, the
  cascade-delete detaching a tag from a live `post_tags` row, and both merge scenarios
  (a post carrying only the `from` tag, and one already carrying both — the
  `INSERT OR IGNORE` path, asserted by checking `post_count` doesn't double-count).
  Verified by hand too, in a real browser (Playwright-driven Chromium) against the
  demo-mode static-file dev path: add, rename, delete and a two-tag merge, each
  reflected immediately in the table and via a toast, with `console --errors` clean
  apart from the same demo-mode `/api/admin/me` 404 every other admin page produces
  before a Worker is deployed.

**Editor integration, connecting 5a and 5c. Built, tested, and deployed for `gcameron`
since 2026-07-28 — not yet hands-on verified in production.** Media upload existed but
nothing could *use* it — the editor had no cover-image field and no way to put a
library image into a post body except copying a URL by hand from the media page and
pasting it into Markdown. Closed both gaps:
- A **cover image** card on the editor (`admin/editor/index.html`) — preview, "Choose
  from library", "Remove". `cover_key`/`cover_alt` now round-trip through `collect()`/
  `fill()` the same way tags do, and the demo fallbacks for `createPost`/`updatePost`
  (`assets/js/api.js`) were extended to carry them too — they didn't before, so a cover
  picked in demo mode would have been silently dropped on save.
- A custom EasyMDE toolbar button ("Insert image from library") that inserts
  `![alt](url)` at the cursor, instead of EasyMDE's default behaviour of dropping in an
  empty `![](http://)` placeholder for the author to fill in from memory.
- Both share one new component, `openMediaPicker()` in `assets/js/admin.js` — a native
  `<dialog>` (Escape and backdrop-click close for free), searchable, filtered to
  `type=image` since a post cover or an inline image is never a PDF. It browses the
  existing library only; it doesn't duplicate the upload form already on the media
  page. Verified in a real browser: pick, remove, re-pick, insert-into-body, and that a
  saved post's `cover_key` actually persists through demo mode's `localStorage` store.

**5e — Authors as their own resource. Built, tested, and deployed for `gcameron` since
2026-07-29 — not yet hands-on verified in production (`src/admin-authors.js`,
`src/admin-db.js`, additive migration `0002_authors_disabled`):**

- `GET /api/admin/authors` (every author, each with a `post_count` — every post
  regardless of status, same "management view" reasoning as tags), `POST
  /api/admin/authors` (name, email, role — creates the row an Access identity resolves
  onto; role defaults to `author`), `PATCH /api/admin/authors/:id` (name, email, role,
  or `disabled`), `DELETE /api/admin/authors/:id` (reassigns the target's posts to
  whoever performed the delete, then removes the row). All owner-only except the list,
  per `authors.manage` in `src/auth.js`'s role table — same level as `settings.manage`,
  since a role change or removal reaches every post the target has ever written.
- **No invite email, by design (owner decision, 2026-07-29).** `POST /authors` only
  creates the row; there is no email-sending mechanism to trigger. Two steps stay
  manual on purpose: adding the email to the Cloudflare Access policy (still the only
  thing that actually grants sign-in), and telling the person directly. The admin UI
  (`admin/authors/index.html`) surfaces both as a blocking `alert()` right after a
  successful create — the moment the new email is on screen and the reminder is most
  likely to be acted on — plus a standing `callout--info` above the form for anyone who
  lands on the page without creating anyone.
- **Disable, alongside delete (owner decision, 2026-07-29).** `disabled` (migration
  `0002`, additive) is the reversible half of removing someone: `src/auth.js`'s
  `resolveAuthor` stops matching a disabled row, so the next sign-in `403`s exactly like
  a missing row, but the row, its role, and its post history all stay put. `DELETE` is
  the other, harder-to-undo half — it also reassigns the target's post history rather
  than leaving it in place. The admin UI defaults to Disable as the row action, with
  Delete next to it in the same danger styling as tags' delete.
- **Self-protection.** Disabling, deleting, or changing the `role` away from `owner` is
  rejected with `409 conflict` if the target is the only remaining active (non-disabled)
  owner — `assertNotLastOwner` in `src/admin-authors.js`, backed by
  `countActiveOwners` in `src/admin-db.js`. Checked server-side, not just hidden in the
  UI: the same guard runs whether the call comes from the admin UI or (once Phase 6
  ships) an MCP client. The demo fallback (`assets/js/api.js`) reimplements the same
  check against `localStorage` so it behaves identically before a Worker is deployed.
- The admin UI (`admin/authors/index.html`, `assets/js/admin.js`'s `initAuthors`) is a
  single table plus a create form, gated by `GET /me`'s role the same way the MCP page
  gates its tools table — a non-owner sees the list but not the form or the row
  actions, backed by the server-side `403` either way. Role is an inline `<select>`
  (owner/editor/author, matching the API's own enum) rather than a text prompt — the
  API validates either way, but there's no reason to let a typo reach that check.
  Rename, Disable/Enable and Delete still reuse the `prompt()`/`confirm()` pattern from
  tags and media rather than a new dialog component. Email and bio aren't exposed as UI
  edit actions yet — same "UI surface narrower than the API" gap as tags'
  slug/description.
- 21 new tests (194 total) — permission checks per role, email-uniqueness 409s, the
  disable/enable round trip verified against `resolveAuthor` directly (not just the
  API response), the last-owner guard for disable/delete/demote, and delete's post
  reassignment. Verified by hand too, in a real browser (Playwright-driven Chromium)
  against the demo-mode static-file dev path: create (with the Access/no-email alert),
  disable, and the last-owner guard's error toast, with `console --errors` clean apart
  from the same demo-mode `/api/admin/me` 404 every other admin page produces before a
  Worker is deployed.

**Follow-up fixes (owner review, 2026-07-29), before this slice's first deploy:**

- **Role as a `<select>`, not a prompt** — the initial cut used `window.prompt()` for
  role same as the other single-field edits; caught in review as worse than the other
  prompts, since a role is a closed enum, not free text, and a typo there is a
  silently-rejected API call instead of a UI mistake.
- **Self-protection, not just last-owner protection.** The original guard
  (`assertNotLastOwner`) only stopped the site from ending up with zero owners; it did
  nothing to stop an owner from disabling or deleting *their own* row while other
  owners existed — a stray click on your own table row, confirmed without reading the
  dialog closely, would sign you out with nothing left to undo it but another owner's
  intervention. `assertNotSelf` in `src/admin-authors.js` (and mirrored in
  `assets/js/api.js`'s demo fallback) now rejects disabling or deleting your own row
  outright, `409`, regardless of how many other active owners exist — that's for
  another owner to do to you, not a click you make on yourself. Demoting your own role
  away from `owner` is deliberately *not* blocked the same way: it's recoverable (another
  owner can re-promote you) and doesn't cut off access outright, unlike disable/delete.
  The admin UI pre-disables the Disable/Delete buttons on your own row with an
  explanatory `title`, purely to save the round trip — the server rejects the same
  action either way. 2 new tests (196 total): self-disable and self-delete blocked even
  with a second active owner present.
- **Author now visible in the admin UI, not just the API.** `mapAdminPost`
  (`src/admin-db.js`) had returned `author: { id, name }` since Phase 5a, but nothing
  rendered it — the posts list (`postsTable` in `assets/js/admin.js`) had no Author
  column, and the editor (`assets/js/editor.js`) never showed whose post you were
  editing. Both now do: an Author column on the (non-compact) posts list, and a
  "by &lt;name&gt;" line next to the status badge in the editor. Read-only — reassigning
  a post to a different author isn't exposed anywhere in the UI yet, on either page.

**Migration and Worker deploy — done for `gcameron` (2026-07-29).** Migration
`0002_authors_disabled.sql` has been applied to production D1 (per
[deployment.md](deployment.md) §1's apply command), and both 5e commits (`9a6d020`,
`cd6b8fa`) deployed successfully via `deploy.yml`. Not yet done: the hands-on
post-deploy verification pass the other live slices got (create/disable/delete an
author for real, per [deployment.md](deployment.md) §6's table format) — until that's
run, this stays "built and tested, not yet confirmed live" rather than moving to the
"verified in production" tier posts/settings/dashboard/media are at.

**5f — Cron: scheduled-post auto-publish + revision retention. Built, tested, and
verified live for `gcameron` (2026-07-29) — `src/cron.js`,
`migrations/0003_audit_via_cron.sql`:**

- `scheduled(event, env, ctx)` in `src/index.js`, wired to `[env.gcameron.triggers]
  crons = ["*/5 * * * *"]` in `wrangler.toml` (owner decision, 2026-07-29: every 5
  minutes). `src/cron.js`'s `publishDuePosts` finds every `status = 'scheduled'` post
  with `scheduled_for <= now`, flips it to `published`, clears `scheduled_for`, purges
  its public URLs the same way a manual publish does, and writes an audit-log row —
  `actor: 'system', via: 'cron'`, a `via` the original schema didn't allow (see below).
- Revision retention turned out not to need the cron at all: `insertRevision`
  (`src/admin-db.js`) now deletes anything past the newest 20 rows for that post in the
  same write, right after inserting — immediate, no standing job, no need to reason
  about which of multiple cron expressions fired. The plan's original phrasing bundled
  this with the publish sweep; trim-on-write turned out simpler once actually
  designed.
- `migrations/0003_audit_via_cron.sql` — `audit_log.via`'s `CHECK` only allowed
  `'ui'/'mcp'/'api'`; a cron-fired action has no human actor to log as any of those.
  SQLite can't `ALTER` a `CHECK` constraint in place, so this is the standard
  create-copy-drop-rename rebuild, widening it to include `'cron'`.
- 4 new tests (200 total): a due post publishes and logs `via: 'cron'`; a
  not-yet-due post is untouched; `publishDuePosts` no-ops with no `DB` binding; revision
  history caps at 20 after 25 saves.

**Deploy incident, same day (2026-07-29) — self-inflicted, caught within the hour.**
The first `wrangler.toml` diff put the new `[env.gcameron.triggers]` header *between*
the two halves of `[env.gcameron.vars]`, rather than after all of them. TOML has no
notion of "these keys belong to the table above" independent of position — every key
after a table header belongs to that header until the next one — so `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` silently became keys of `[env.gcameron.triggers]` instead of
`[env.gcameron.vars]`. In production that made both `env.ACCESS_TEAM_DOMAIN` and
`env.ACCESS_AUD` undefined, which `src/index.js`'s admin guard treats identically to "this
site hasn't done its Phase 4 Access setup yet" — so it skipped its own JWT verification,
`identity` stayed `null` on every admin request, and every admin API call failed, which
surfaced as the admin UI's demo-data fallback kicking in across the board. Cloudflare
Access itself at the edge was never affected (it's configured independently of these
vars) — only the Worker's own redundant identity check was disabled, but that was enough
to break every real API call. Fixed by moving `[env.gcameron.triggers]` to after every
`[env.gcameron.vars]` key, confirmed with `wrangler deploy --dry-run` (both vars listed
again as bindings) before pushing. The comment above `[env.gcameron.triggers]` in
`wrangler.toml` now calls this out explicitly so the next table added to this file
doesn't repeat it.

**5g — Editor conflict handling. Built, deployed, and partially verified live for
`gcameron` (2026-07-29/30) — `assets/js/editor.js`, `assets/js/api.js`:**

- Not a merge/overwrite prompt — an owner decision. `save()` now sends
  `If-Match: "${state.post.updated_at}"` on every `PATCH`, using the `updated_at`
  already in the loaded post (no extra fetch needed — that's literally what the ETag
  is). On a `409`: an explicit Save forks the local edits into a brand-new draft via
  `POST /posts` instead of overwriting or discarding either side's changes — the
  server's own `uniqueSlug` auto-suffixes the colliding slug, so no special-casing was
  needed there. The user is told directly ("...saved as a new draft instead of
  overwriting theirs") and the editor switches to the new draft (URL `id`,
  `state.post`) so further saves target it, not the original.
- Autosave never forks silently on its own conflict — it sets a distinct `conflict`
  save-state pill ("Someone else edited this post — click Save...") and stops
  re-attempting until the user takes that explicit action, so two open tabs on the same
  post don't spawn a duplicate draft every 2.5 seconds.
- `assets/js/api.js`'s `ApiError` didn't previously expose `detail` at all — a
  prerequisite gap fixed alongside this; without it, the client had no way to read a
  409's `current_etag`/`submitted_if_match` no matter what else was built.
- **Verified live 2026-07-29/30 (owner test): the explicit-save fork.** Editing the same
  post in two sessions and saving the stale one produced a second draft post as
  expected — the root behaviour (no overwritten or lost edits) is confirmed working in
  production. **Not yet observed: the autosave conflict pill** — the owner hasn't hit
  that specific timing case yet (dirty + idle 2.5s + an existing conflict). Not
  considered a Phase 5 blocker; flagged here for whoever next has two tabs open on a
  stale post to glance at the save-state pill instead of just clicking Save.

**Parked — not Phase 5 blockers:**

- SVG upload — needs a real sanitiser (a parser, not a regex), see above. The media
  library works without it.
- Lazy image variants written back to R2 — needs a resizing mechanism (e.g. Cloudflare
  Images) Workers don't have natively; needs a decision, likely with the owner, before
  it's built.

**Export/import moved to Phase 7 (owner decision, 2026-07-29)** — see Phase 7 below.
Phase 5's write path doesn't need a backup/restore route to be complete; every other
Phase 5 slice ships without it.

**Exit criteria — met.** A post can be created, edited, saved, previewed, scheduled,
published, unpublished and deleted through the admin UI against live D1 for
`gcameron`; settings can be changed and persist; the dashboard shows real counts and a
real activity feed; media can be uploaded, browsed and deleted against real R2; a
scheduled post auto-publishes within its 5-minute window and logs `via: 'cron'` in the
live activity feed; a save conflict forks into a new draft instead of clobbering or
discarding anyone's edit — confirmed 2026-07-29/30 producing a second draft post as
expected, exactly as designed. None of it through tests alone; all confirmed in
production. Two things remain purely as verification passes, not new work, and neither
blocks calling Phase 5 done: **tags (5d) and authors (5e)** are deployed and tested but
haven't had their hands-on production check yet — author verification specifically is
waiting on the owner setting up a real second author to disable/re-enable through the
interface, not Cloudflare Access directly; and **the autosave half of 5g's conflict
handling** hasn't been observed yet (needs two tabs left open on the same stale post
long enough to go idle), though the explicit-save half it shares its code with has been.

---

## Phase 6 — MCP server

**Goal.** An agent can do what an editor can do, and no more.

**Shipped in code (2026-07-30):**

- `POST /mcp` (src/mcp.js), Streamable HTTP, JSON-RPC — single-JSON responses only,
  no SSE; nothing this server does is slow enough to need it. `GET /mcp` 405s for the
  same reason (no server-initiated messages to stream). `DELETE /mcp` ends a session.
- No hand-rolled OAuth endpoints — Cloudflare Access's Managed OAuth handles discovery,
  dynamic client registration, PKCE and token issuance in front of the Worker, exactly
  as [mcp.md](mcp.md)'s Authentication section describes. The Worker verifies the
  resulting bearer token with the *same* `verifyAccessIdentity`/`resolveAuthor` guard
  already in src/index.js for `/api/admin/*` — `/mcp` was already in
  `ADMIN_ONLY_PREFIXES`, so this needed no new auth code, only a handler to dispatch to.
- All 13 tools, the one resource (`blog://style-guide` — see mcp.md's "Resources"
  section on why the other five were cut), and all 5 prompts (src/mcp-tools.js,
  src/mcp-prompts.js), with `tools/list` filtered by role and every permission
  re-checked at `tools/call` time rather than trusted from the list.
- `via = 'mcp'` on every audit entry, for every tool call (not just writes), per
  mcp.md's "every tool call writes an audit_log entry."
- Per-identity rate limiting on write tools — 30 calls per tool name per 5 minutes,
  counted from `audit_log` itself rather than a new store (the Worker has no other
  per-identity state to count from; see src/mcp.js).
- `Mcp-Session-Id` issued on `initialize` and reconstructed from a new `mcp_sessions`
  table (migrations/0004_mcp.sql) on every later request — the Worker holds nothing in
  memory between requests, per Transport's stateless-isolate note.
- `initialize`'s `serverInfo.name` and every tool's `description` interpolate the
  site's real title (e.g. "add-blog — The add-blog Journal") rather than a static
  string — see mcp.md's "Server identity" section: an operator with more than one of
  these blogs connected needs to tell them apart in one combined tool list.
- The admin MCP page's copy reflects the live state rather than "not live yet."

**Verified live for `gcameron`, 2026-07-31 (owner test):** deployed, connected from
claude.ai (web) and the Claude iOS app, tool catalog loaded, role filtering and the
audit trail behaved as designed. One real-world gap surfaced and was closed in the
process: claude.ai's Dynamic Client Registration attempt was refused by Managed OAuth
until claude.ai's redirect URI was added to the application's allow-list — a one-time
Cloudflare-side setting, not a code change; documented in
[mcp.md](mcp.md#client-configuration) and [deployment.md](deployment.md) §4 so the next
site doesn't have to rediscover it. **Not yet exercised:** a Claude Code / Claude
Desktop connection specifically — expected to work without the redirect-URI step
(their OAuth flow uses a local loopback redirect instead, per mcp.md), but not yet
observed against this deploy.

**Exit criteria.** Claude Code and Claude Desktop both connect, complete OAuth, list
tools, and successfully run a draft → edit → publish sequence. An `author`-role
identity does not see `publish_post`. Every action appears in the audit log. Code-level
behaviour for all of this is tested; the live-connection pass is the one thing left,
gated on a deploy rather than any new setup.

---

## Phase 7 — Polish and operations

**Found already shipped, undocumented, during the Phase 7 kickoff review
(2026-07-31)** — built along the way in earlier phases and never checked off here:

- **Search UI on the public site backed by FTS.** ✅ Done. `GET /api/posts?q=`
  (`src/public-api.js`) matches against the `posts_fts` FTS5 table and its sync
  triggers from Phase 3 (`src/db.js`, `migrations/0001_init.sql`); the public UI's
  debounced search box (`assets/js/blog.js`'s `initHome`, `index.html`) updates the
  URL and re-renders results client-side. Tested (`src/public-api.test.js`). Nothing
  left to build.
- **Related posts.** ✅ Done. `relatedPosts()` (`src/db.js`) ranks by shared-tag
  count then recency, top 3, included in the post API response and rendered by
  `assets/js/post.js` under a "Related posts" heading; documented in
  [api.md](api.md). **Gap:** client-rendered only — the server-rendered permalink
  (`src/pages.js`'s `renderArticle`) doesn't include it, so it's invisible with
  JavaScript disabled and absent from the HTML search engines see.
- **Copy-link-to-heading.** ✅ Done. `assets/js/post.js`'s `addHeadingLinks()`
  appends a `#` anchor to every `h2`/`h3` with an id. Same SSR gap as related posts
  above — client-rendered only.
- **Dashboard stats from real data.** ✅ Already satisfied by Phase 5b's
  `GET /api/admin/stats` (post counts by status, total word count, media count, next
  scheduled post) — see Phase 5 above. What's left under this heading is specifically
  *view* stats, which depends on the view-counts item below being built first.

**Still to build:**

- Reading progress bar on the public post page — no code anywhere yet; the only
  other item from the original "related posts, reading progress, copy-link-to-heading"
  grouping that isn't already done.
- OG image generation for posts without a cover — not started; no `og:image` tag
  exists anywhere yet, including in `src/pages.js`'s SSR meta tags.
- Privacy-preserving view counts (no cookies, no third-party analytics) — not
  started; `src/admin-dashboard.js` already notes in its own comment that the
  `views` figure is intentionally absent pending this.
- Lighthouse budget in CI; accessibility audit; RSS validation — not started; no
  Lighthouse/accessibility tooling in `package.json` or `.github/workflows/`, and the
  existing feed tests (`src/feeds.test.js`) check string content, not spec
  conformance.
- **On-demand export/import (moved from Phase 5, owner decision, 2026-07-29;
  owner-only — same tier as `/settings`).** `POST /export` — full content (every post
  regardless of status, tags, authors, settings) as one JSON document, written to R2 at
  `exports/<iso-date>-backup.json` (see [architecture.md](architecture.md) §4); the
  response returns a short-lived link, not the JSON inline. `POST /import` accepts
  either of two shapes: an export bundle (this project's own round-trip format) or a
  generic Markdown/front-matter archive. Not yet reflected in the role table
  (`src/auth.js` has no `export`/`import` permission entry).
- **Scheduled (automatic, periodic) export to R2** — distinct from the on-demand
  `/export` above: this one fires on its own schedule, no one has to click anything.
  Natural pairing with Phase 5f's cron infrastructure once it exists.
- **Import from Ghost and Markdown archives** — parsers for other platforms' own
  proprietary export formats, a bigger scope than the two generic shapes `/import`
  handles. WordPress/WXR was the same idea, scoped on 2026-08-04 and **shipped** —
  see below; Ghost and plain Markdown archives remain unbuilt.

### WordPress import (WXR) — shipped (2026-08-04), fixed against a real production run (2026-08-05)

**Shipped in code:** `src/import-wxr.js` (hand-rolled WXR parser — no `DOMParser` in
Workers, same reasoning as `assets/js/markdown.js`), `src/import-html-to-md.js`
(HTML→Markdown converter targeting exactly `markdown.js`'s dialect, tested against
paragraphs/headings/lists/links/images/tables/code/blockquotes plus Gutenberg-comment
stripping and unknown-wrapper unwrapping), `src/admin-import.js`
(`POST /api/admin/import/preview` and `/run`, `buildImportPlan`/`executeImportPlan`,
old-domain link rewriting — see below), `migrations/0005_audit_via_import.sql`
(widens `audit_log.via` to add `'import'`), `migrations/0006_media_source_url.sql`
(see "batching" below), the `import.wxr` owner-only permission (`src/auth.js`), and
the admin UI page (`admin/import/`, `assets/js/admin.js`'s `initImport`,
`assets/js/api.js`'s `previewImport`/`runImport`). Tests: `src/import-wxr.test.js`,
`src/import-html-to-md.test.js`, `src/admin-import.test.js`.

**First real run (2026-08-05, `gcameron.com`, 26 posts / 67 attachments) surfaced two
production-only bugs no test caught**, since both are specific to the real Cloudflare
account this Worker actually runs on:

1. **66 of 67 media fetches failed with `"text/html" is not an allowed type`,** even
   though every URL was confirmed live and correctly serving the real image externally
   (`curl` got a clean `image/jpeg` 200 for one of the failing URLs). Root cause:
   Cloudflare error 1042 territory — a Worker's own `fetch()` to a hostname sharing a
   Cloudflare zone with *any* other Worker on the account gets silently rerouted to
   that other Worker instead of reaching the real internet, unless the
   `global_fetch_strictly_public` compatibility flag is set. `gcameron.com`'s zone
   also hosts an unrelated Worker (`gcameron-minisites`); that's almost certainly what
   answered instead of WordPress. **Fixed** by adding
   `compatibility_flags = ["global_fetch_strictly_public"]` to `wrangler.toml`
   (applies to every site, not just `gcameron.com`) — see
   [deployment.md §3](deployment.md#3-wranglertoml--one-shared-worker-one-envname-block-per-site)
   for the full writeup. Confirmed via Cloudflare's own docs, not guessed.
2. **The run then hit `"Too many subrequests by single Worker invocation"` partway
   through the remaining media.** Workers Free caps external `fetch()` at 50 per
   invocation (confirmed via `search_cloudflare_documentation`, not assumed) — a
   67-attachment import can't fetch everything in one request on that plan
   regardless of the fix above, and the one-shot design this shipped with had no way
   to resume: it re-fetched every URL from scratch on every call, so a second attempt
   would just fail at the same point again. **Fixed** by making `executeImportPlan`
   batch media fetches (`MEDIA_FETCH_BATCH_LIMIT = 25` per call) and genuinely
   resumable: `migrations/0006_media_source_url.sql` adds `media.source_url`, so a
   later call can tell which attachments already succeeded without re-fetching them
   to find out. Critically, **posts are not created until every attachment has had a
   real chance** (`media_pending === 0`) — creating a post against still-unresolved
   media would freeze broken image links into its `body_md` permanently, since
   skip-on-duplicate-slug means no later call ever revisits an already-created post's
   content. The admin UI (`assets/js/admin.js`'s `runBtn` handler) now loops, calling
   `/run` again with the same file while `media_pending > 0`, showing round-by-round
   progress, capped at 30 rounds as a safety stop. `/import/preview`'s response
   gained `media_batches_expected` so the UI can warn upfront.

Both fixes are covered by tests (`src/admin-import.test.js`'s batching test forces a
26-attachment run over the 25-item cap and asserts the second call doesn't re-fetch
the first 25). **Consequence of the first broken run:** it created 26 real posts
against `gcameron.com`'s live D1 with old-domain image links baked into their
`body_md` (media never resolved, so nothing to rewrite). Those don't self-heal — a
clean re-run skips them as duplicates without touching their content. Deleted and
re-imported once both fixes were confirmed live, rather than trying to patch them in
place.

**The `global_fetch_strictly_public` fix turned out to be necessary but not
sufficient — media fetches kept failing identically (2026-08-05, still ongoing).**
Confirmed the flag genuinely deployed (`wrangler versions view` showed it live), then
re-ran the import: same `"text/html" is not an allowed type"` failures, unchanged. The
decisive test: importing `laax.ski`'s WXR — a completely different Cloudflare zone,
with no routes, no Custom Domain, no relationship of any kind to this Worker or to
`gcameron.com` — produced the *identical* failure
(`https://laax.ski/wp-content/uploads/.../....jpeg: "text/html" is not an allowed
type.`). Same-zone Worker interception cannot explain a failure on a zone this Worker
has never touched, so that theory is now believed incomplete or wrong, not confirmed —
the flag stays (it's still correct, real behavior for the `gcameron.com` case
specifically), but it isn't what's blocking imports.

**Confirmed root cause (2026-08-05): SiteGround's AI Anti-Bot Protection, not
Cloudflare at all.** The response-body preview captured by the fix below showed it
directly on the very next real attempt:

```
<html><head><link rel="icon" href="data:;">
<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-content%2F...">
</head></html>
```

`sgcaptcha` is SiteGround's own hosting-level bot-challenge system (both sites are
WordPress-on-SiteGround — confirmed via `siteground_optimizer_*` postmeta in both
real WXR exports). It targets "bruteforce login and denial-of-service"-shaped
traffic, and this importer's up-to-25-rapid-fetches-per-batch against the same host
is exactly that shape. `laax.ski` isn't even in the owner's Cloudflare account (per
the owner directly, 2026-08-05) — which is what ruled out every Cloudflare-side
theory (same-zone routing, Bot Fight Mode) and pointed at the hosting layer instead;
the `global_fetch_strictly_public` flag was real and worth keeping, but was never the
actual fix for this failure on either site.

Per SiteGround's own KB article on this CAPTCHA, whitelisting is **passive and
visitor-triggered only** — an IP/UA pair gets whitelisted after solving the CAPTCHA
once, which a script can't do, and there's no documented self-service allowlist for
external callers. Two mitigations shipped 2026-08-05, neither guaranteed against a
determined WAF but both cheap and directly responsive to what's now confirmed:

- `src/mcp-media-fetch.js`'s `fetchMediaFromUrl` now sends a real browser-shaped
  `User-Agent`/`Accept` pair (previously sent neither) and `cf: { cacheTtl: 0 }` (a
  one-shot per-file fetch is never worth caching, and rules out a stale wrongly-cached
  response as a variable regardless of the rest of this).
- `src/admin-import.js`'s media loop now staggers fetches by
  `MEDIA_FETCH_STAGGER_MS = 200`ms instead of firing them back-to-back — directly
  targeting the "burst against one host" shape SiteGround's own docs say triggers
  this. Covered by `src/admin-import.test.js` (real wall-clock delay, hence that
  test's extended 15s timeout).
- The response-body preview capture itself (`err.preview`, `media_failed[].preview`)
  stays — it's what made this diagnosis certain instead of inferred, and is generally
  useful for any future "wrong content-type" failure.

**If these aren't enough:** the reliable fix lives in SiteGround's Site Tools →
Security section (an "AI Anti-Bot Protection" toggle is understood to exist there,
separate from the KB article's visitor-facing whitelisting) — disabling it for the
duration of an import, then re-enabling, is not something fixable from this
repository's code and needs the owner's SiteGround access.

Scoped against two real exports the owner intends to import personally:
`gcameron.com` (104 items — 26 posts / 4 pages / 67 attachments, 0 shortcodes, 0
iframes, all media same-host) and `laax.ski` (41 items — 6 posts / 4 pages / 21
attachments, same profile, one classic-HTML post, one comment). Both are clean,
low-shortcode, mostly-core-Gutenberg-block exports — that shaped the calls below more
than WXR's full generality did. Independent of this project's own `/export`/`/import`
round-trip format above — WXR comes from WordPress, not from another instance of this
app.

**Scope — posts and media only.**
- No `pages`/CPT table exists (only `posts` + `tags`, see Phase 3's schema) — WP
  `<item wp:post_type="page">` entries are **not imported**. Both target exports keep
  their few pages (Homepage/About/Contact-style) thin enough to hand-recreate.
- `<wp:comment>` dropped entirely — consistent with this project's own "no comments"
  call (**Decisions** item 3 below), not a WordPress-import-specific decision.
- WP `category` and `post_tag` taxonomies **merge into the single `tags` table** — no
  category/tag distinction survives import. Both exports have small, non-overlapping
  vocabularies (≤8 terms), so collisions are unlikely but not handled specially if
  they happen (a same-slug category and tag just become one tag).
- WP `post_format` (seen on `laax.ski`, 1 term used) is **ignored** — it's a
  theme-display hint, not a real taxonomy, and out of scope here.

**Content conversion — hand-rolled HTML→Markdown, accepted as lossy.**
`body_md` is this project's source of truth, rendered by a dependency-free ~250-line
parser (`assets/js/markdown.js`) with no raw-HTML passthrough — so `<content:encoded>`
must become clean Markdown, not just get stored as-is. Both sample exports are
favorable: 0 shortcodes, 0 iframes, and block usage concentrated in ~13 standard core
Gutenberg blocks (paragraph/image/heading/list/table/quote/gallery/preformatted) that
map onto plain HTML tags close to one-to-one. The only non-core blocks seen
(`themeisle-blocks` Otter columns/headings, low single-digit counts) still render as
ordinary wrapped HTML in `content:encoded` and can be unwrapped rather than specially
parsed. Elementor usage (3 items on gcameron.com, 2 on laax.ski) is real but — per the
pages decision above — concentrated in `page`-type items that aren't imported at all;
if a future import target has Elementor on a `post`, that item's content arrives as
whatever `content:encoded` rendered to (often thin, since Elementor content mostly
lives in `_elementor_data` postmeta this importer won't parse) — **reported, not
blocked**. No new runtime dependency added for this — matches the project's
zero-runtime-deps stance (`package.json`).

**Media — fetch-and-reupload, report failures rather than fail the import.**
Follows the existing `upload_media_from_url` MCP pattern (`src/mcp-tools.js`) and the
same content-addressed R2 key scheme (`buildMediaKey()`, `src/media-parse.js`). Dead
links, SVG uploads (still disallowed, `src/admin-media.js`), and oversized files are
**collected into a per-item report, not treated as fatal** — the rest of the import
proceeds. Both sample exports are the easy case (100% same-host image URLs, 0
off-site, 0 `http://`, no SVGs), so in practice this path is expected to report
empty more often than the general WXR case in the wild. `_thumbnail_id` postmeta
resolves to an attachment URL and sets `posts.cover_key`; inline `<img>` URLs inside
converted content get rewritten to the new `/media/:key` URLs after re-upload.

**Mapping.**
- Status: WP `publish` → `published`; `draft`/`pending`/`future` → `draft`;
  **`trash` → `draft`** (not skipped — a trashed WP post may just be one the owner
  never got around to deleting). No `visibility` handling — everything imports as
  `public` (this project's default); the importer never sets `unlisted`.
- Authors: **WXR author records are ignored** — every imported post is authored by
  whichever admin identity runs the import, not mapped to WP logins/emails. Simplest
  option, and correct for both target sites (personal single/near-single-author
  blogs where the "real" author is the person doing the import anyway).

**Mechanics.**
- Entry point: admin UI file upload (no API-only route) — pairs with the owner-only
  `/export`/`/import` tier above.
- Runs through the **normal post-save pipeline** (not raw inserts), so
  `body_html`/`word_count`/`reading_minutes`/`posts_fts`/revision triggers all fire
  correctly — same reasoning as every other write path in this codebase.
- **Dry-run mode** required before a real run.
- Idempotent re-run: **skip on slug collision**, not upsert or error — makes a
  partial/failed import safe to just run again.
- **Not one-shot** — the original draft assumed a single request would be enough;
  a real run against `gcameron.com` (26 posts/67 media) proved that wrong on
  2026-08-05 (Workers Free's 50-external-fetch-per-invocation ceiling). Media
  fetching is batched and genuinely resumable across multiple `/run` calls — see
  the "fixed against a real production run" note above.
- Audit trail: **`via: 'import'`**, a new `audit_log` value added by
  `migrations/0005_audit_via_import.sql` in the same rebuild style as 0003's
  `'cron'` addition.

**Link rewriting (decided 2026-08-04, after the draft above).** Old-domain links
inside imported content *are* rewritten, not left alone — worth doing even though
neither sample export strictly needed it, since a general importer will eventually
meet one that does. `src/admin-import.js`'s `buildRewriter` classifies every
`href`/`src` whose host matches the WXR channel's own site host: to another
imported post's new `/posts/:slug` (matched against every post in the export, not
only ones this run actually creates, so a link to an already-imported post from a
previous run still resolves), or to the new `/media/:key` once that attachment is
re-uploaded (matching WordPress's `-WxH` size-variant suffix back to the original).
A link to a WordPress **page** — never imported — is left as the old URL and
reported under `links_to_dropped_pages`, exactly the "posts linking to pages is a
problem and should be reported" case; anything else on the old host that doesn't
resolve is reported under `links_unresolved`. Off-domain links (confirmed, on both
real sample exports, to be legitimate external citations) are left untouched
entirely, not even inspected.

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

**Public per-author archive pages (raised in Phase 5e review, 2026-07-29).** Click an
author's name on a post, land on a page listing their published posts — the same shape
as tags' `/tags/?tag=<slug>` filter. Unlike tags, the public `GET /api/posts` has no
`author` filter yet (`src/db.js`/`src/public-api.js`) — only the admin route does; this
would need that adding first, not just a new page. **Owner constraint: the author's
identity must not appear in the URL** — rules out the
obvious approach of mirroring tags exactly (`/author/?slug=<name-derived-slug>` or
`?id=<uuid>`), and rules out adding an `authors.slug` column for this purpose. Not
designed further: what un-identifying mechanism would still let a URL be shared/
bookmarked (a query against something other than the author, an opaque token unrelated
to name/email, or dropping the "shareable URL" property entirely for a client-side-only
filter) is an open question for whoever picks this up next, not decided here.

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
