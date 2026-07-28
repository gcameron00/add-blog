# Deployment runbook

Everything needed to run add-blog as a fleet of blogs — one shared Worker script, one
`[env.NAME]` block per site. First (and so far only) site: `blog.gcameron.com` /
`blog-admin.gcameron.com`, live since Phase 3 (2026-07-27) — hostname routing, public
read API, R2 media and feeds all real. Phase 4 (Access JWT verification, `GET
/api/admin/me`) is live too (verified 2026-07-27) — the admin host genuinely requires a
verified, provisioned identity now. Phase 5's posts write path (create/edit/publish/
delete/revisions), its settings/dashboard slice (`GET`/`PUT /settings`, `stats`,
`audit`), and media upload are all live too (media confirmed working in production).
Tag management and the editor's cover-image/insert-from-library integration are built
and tested (173 tests) but **not yet deployed** — next push ships them. Authors,
export/import and scheduled-post auto-publish are still queued — none of them have an
admin UI page calling them yet, which is deliberate; see
[implementation-plan.md](implementation-plan.md)'s Phase 5 section. Sections below
double as the runbook for the *next* site: everything in §1-4 is real, owner-run work
for `gcameron` already done; repeat it for each new one.

---

## What deploys today

`.github/workflows/deploy.yml` runs on every push to `main`, once per entry in its
`site` matrix, and calls `wrangler deploy --env <site>`. It skips cleanly if
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not set as repository secrets.

`main = "src/index.js"` is set as of Phase 2, so every push deploys the hostname
router — see `wrangler.toml` for the current site list and
[architecture.md](architecture.md) for what the router does. A *new* site's deploy
still needs D1/R2 (§1) and, later, Access (§4, Phase 4 — not built yet, for any site)
before it's safe to point a production domain at; those stay owner-driven, per-site
steps, for the reasons in the note below.

> [!NOTE]
> Whoever is applying `wrangler.toml`/`.assetsignore`/`.github/workflows/` changes,
> the CF-touching part — actually running `wrangler`, adding a zone, setting a
> secret — stays a deliberate, owner-run step, per site. The config in this repo can
> be authored by anyone; what it does to the real Cloudflare account still needs a
> human decision each time.

---

## 1. Create the resources (per site)

Each site gets its own database and bucket — never shared, per the single-tenant
decision in [implementation-plan.md](implementation-plan.md). Already run for
`gcameron`; repeat for a new site with its own names:

```bash
# D1
npx wrangler d1 create gcameron-blog
# → note the database_id, goes in [[env.gcameron.d1_databases]]

# R2
npx wrangler r2 bucket create gcameron-blog-media

# Apply the schema (see docs/architecture.md §3)
npx wrangler d1 execute gcameron-blog --file=./migrations/0001_init.sql --remote
```

Seed the first owner so there is an identity that can log in — the email must match
exactly the identity Access will present:

```sql
INSERT INTO authors (id, email, name, role, created_at)
VALUES (lower(hex(randomblob(16))), 'you@gcameron.com', 'Your Name', 'owner',
        strftime('%Y-%m-%dT%H:%M:%SZ','now'));
```

## 2. DNS

Nothing to do by hand here. `routes` entries with `custom_domain = true` (§3) make
Cloudflare create the DNS record and issue the certificate automatically — Custom
Domains don't support wildcards or paths, so the pattern is a bare hostname
(`blog.gcameron.com`, not `blog.gcameron.com/*`; a `/*` pattern is rejected at deploy
time, not silently accepted).

The one prerequisite this doesn't remove: **the domain must already be a zone in the
Cloudflare account** (nameservers pointed at Cloudflare) before its first deploy. A
`routes` entry for a hostname with no zone behind it fails the deploy outright — this
is the one genuinely manual, CF-dashboard step per new site, and it has to happen
before step 3, not after.

## 3. `wrangler.toml` — one shared Worker, one `[env.NAME]` block per site

This repo deploys the same `src/index.js` to multiple independent sites — see the
comment at the top of `wrangler.toml`. Top-level keys (`main`, `compatibility_date`,
`[assets]`) are shared by every site; everything site-specific lives in that site's
`[env.NAME]` block, deployed with `wrangler deploy --env NAME`
(`.github/workflows/deploy.yml` does this once per entry in its `site` matrix, on
every push).

```toml
main = "src/index.js"                 # Phase 2 — shared by every site
compatibility_date = "2026-07-01"

[assets]
directory = "."
binding = "ASSETS"                    # Phase 2 — required: see the run_worker_first note below
run_worker_first = true               # Phase 2 — required: see below

# --- one block like this per site --------------------------------------

[env.gcameron]
name = "gcameron-blog"                 # Phase 2 — the Worker's name; created on first deploy
routes = [                             # Phase 2 — bare hostnames only, see §2
  { pattern = "blog.gcameron.com",       custom_domain = true },
  { pattern = "blog-admin.gcameron.com", custom_domain = true },
]

[env.gcameron.vars]
PUBLIC_HOST = "blog.gcameron.com"       # Phase 2
ADMIN_HOST  = "blog-admin.gcameron.com" # Phase 2
# ACCESS_TEAM_DOMAIN = "..."            # Phase 4 (non-secret — see below)
# ACCESS_AUD         = "..."            # Phase 4

# [[env.gcameron.d1_databases]]         # Phase 3 — this site's own database
# binding = "DB"
# database_name = "gcameron-blog"
# database_id = "<id from step 1, this site's own D1>"

# [[env.gcameron.r2_buckets]]           # Phase 3 — this site's own bucket
# binding = "MEDIA"
# bucket_name = "gcameron-blog-media"

# [env.gcameron.triggers]               # Phase 5
# crons = ["*/5 * * * *"]
```

**`[assets] binding = "ASSETS"` and `run_worker_first = true` are not optional.**
Without `run_worker_first`, Cloudflare serves a matching static file *before* the
Worker ever runs — which means the admin-path 404 guard in `src/index.js` would never
execute for a request to `/admin/index.html`, because that file exists in the bundle.
This is the one setting that makes the whole Phase 2 security model actually take
effect rather than being dead code; it was found by running the router locally against
real static assets, not by reading the config format.

**Adding a new site** is: add its zone in Cloudflare (§2), copy an `[env.NAME]` block
and change the name/routes/vars, add the same `NAME` to `deploy.yml`'s `site` matrix,
push. No per-site code changes, ever — that's the point of keeping the domain out of
`src/`.

Two smaller items that also live in `wrangler.toml`, shared across all sites:

- `[assets] not_found_handling = "404-page"`, so `404.html` is actually served on an
  unmatched path. Without it a bad URL gets a bare Workers 404. The file is already in
  the repository and does nothing until this is set. Phase 2 makes this moot for paths
  the Worker handles, but it still matters for unmatched static paths.
- `docs/` is not in `.assetsignore`, so the Markdown files in this repository are
  served publicly at e.g. `/docs/architecture.md`. That is harmless for a public repo
  and arguably useful, but worth knowing. Add `docs` to `.assetsignore` if the blog
  should not serve them.

`src` and `migrations` are already in `.assetsignore` as of Phase 2, so Worker source
and SQL files are never uploaded into the public asset bundle.

## 4. Cloudflare Zero Trust Access

**Done for `gcameron`** (2026-07-27) — Access application created, `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` are in `wrangler.toml`. Repeat this per new site; steps below are the
reference either way.

Protect the admin hostname:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: `blog-admin.mysite.com`. Leave the path empty so the policy
   covers `/mcp` and the API as well as the UI.
3. Session duration: 24 hours is a reasonable default for an editing tool.
4. **Policy — Allow.** Start with `Emails` listing the editors, or
   `Emails ending in @mysite.com`. Keep it explicit; avoid a bare "everyone in the
   organisation" policy on a surface that can publish to the open internet.
5. Identity providers: whichever the team already uses. One-time PIN over email is a
   workable start for a small site.
6. **Enable Managed OAuth** on the application. This is what lets MCP clients complete
   an OAuth flow against Access without add-blog implementing an OAuth provider.
7. Copy the **Application Audience (AUD) tag** into `ACCESS_AUD`.

Verify before trusting it:

- An incognito request to `https://blog-admin.mysite.com/` must show the Access login
  page, not the admin UI.
- After logging in, the request reaching the Worker must carry
  `Cf-Access-Jwt-Assertion`.
- `https://blog.mysite.com/admin/` must return `404`.
- A JWT minted for a *different* Access application in the same team must be rejected —
  this is what the `aud` check exists for, and it is the one that gets skipped.

## 5. Secrets

Secrets are per environment, same as everything else in §3 — put `--env <site>` on it,
or it lands on the nameless top-level Worker, not any real site:

```bash
npx wrangler secret put SESSION_SIGNING_KEY --env gcameron   # signs preview links
```

`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are plain `[vars]`, not secrets: they are
public identifiers, and treating them as secrets encourages the mistake of thinking
possession of them proves anything. Security comes from JWT signature verification.

## 6. Post-deploy checks

Split by what's actually built. Checking a later-phase row before that phase is
deployed just gets you a confusing 404 for the wrong reason — this table exists so
that doesn't happen.

**Phase 2 (routing and headers — checkable today):**

| Check | Expected |
| --- | --- |
| `GET https://blog.<site>/` | 200, post list, demo-data badge (Phase 3 removes it) |
| `GET https://blog.<site>/admin/` | 404 |
| `GET https://blog.<site>/admin/mcp` | 404 |
| `GET https://blog.<site>/api/admin/posts` | 404 |
| `GET https://blog.<site>/mcp` | 404 |
| `GET https://blog-admin.<site>/admin/` | 200 with no login *only* on a site that hasn't set up Phase 4 yet (see the README warning) — for `gcameron`, see the Phase 4 table below instead |
| `GET https://blog.<site>/health` | 200 JSON |
| Any response on either host | `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Request-Id` present |
| Admin-host responses specifically | `Cache-Control: private, no-store`, `X-Frame-Options: DENY` |
| Blocked-path responses (e.g. `/admin/` on the public host) | `Cache-Control: no-store` |

If a fresh (cache-busted) request to a blocked path is anything other than `404`, or
those headers are missing, `npm run` the local checks below before assuming it's an
account-side issue — this exact bug (deploy "succeeded" but the guard was silently
inert) is what took most of a debugging session to track down, and the root cause
turned out to be the CI deploy tool installing an unrelated wrangler version, not
`wrangler.toml` itself. See the comment above the `Install dependencies` step in
`deploy.yml`.

**Phase 3 (public read path — checkable once D1/R2 are bound):**

| Check | Expected |
| --- | --- |
| `GET https://blog.<site>/feed.xml` | Valid RSS, published posts only |
| A `draft`/`scheduled`/`archived` post | Absent from the public API, the feed, the sitemap and its own permalink — `404`, no signal it exists |
| `GET https://blog.<site>/posts/<slug>` (published) | 200, real `<title>`/meta/OG tags, article body inlined |

**Phase 4 (identity — checkable once a site has its Access application, e.g. `gcameron`):**

| Check | Expected |
| --- | --- |
| `GET https://blog-admin.<site>/` (logged out, incognito) | Access login page, not the admin UI |
| Log in as a provisioned email, then `GET /api/admin/me` | 200, real `name`/`role`/`permissions` for that identity |
| Log in as an email with no `authors` row | 403 `forbidden` from the Worker (Access itself still let the login through — provisioning is a separate, explicit step; see docs/deployment.md §1) |
| A request with no `Cf-Access-Jwt-Assertion` at all reaching the Worker | 401 `unauthenticated` (belt-and-suspenders — Access should already have blocked it at the edge) |
| Visiting a *different* Access application in the same team, then blog-admin | Silent re-authorization with a freshly-minted, blog-admin-scoped token — not a bypass; see [architecture.md](architecture.md) §6 on why this is expected |

**Phase 5, posts slice (live for `gcameron`, verified 2026-07-28):**

| Check | Expected | Confirmed |
| --- | --- | --- |
| Create a post through the editor, save | Draft appears in `GET /api/admin/posts`, not on the public site | ✅ |
| Publish it | Live at `/posts/<slug>` and in `/api/posts` within the cache window; cache purge means usually immediately | ✅ |
| Edit the title/body of a published post | Public copy reflects the change within the cache window; button reads "Save changes", not "Save draft" | ✅ |
| Unpublish, then delete | Gone from the public site at each step; a hard delete (owner only) removes the row entirely | ✅ |
| Two tabs editing the same post, second one saves | No conflict prompt yet — the second save silently wins; `ETag`/`If-Match` exist server-side (test-verified) but the editor doesn't send `If-Match` yet | not yet exercised in prod |

**Phase 5b, settings and dashboard (live for `gcameron`, verified 2026-07-28):**

| Check | Expected | Confirmed |
| --- | --- | --- |
| Change a setting (e.g. site title), save | Persists; reload shows the new value | ✅ |
| A non-owner tries to save settings | 403, form shows an error toast | ✅ |
| Dashboard tiles (published/draft/scheduled/media/words) | Real counts, not demo numbers | ✅ |
| Dashboard activity feed | Real entries with a post title per line, newest first | ✅ |

**Phase 5c, media upload (live for `gcameron`, confirmed working):**

| Check | Expected | Confirmed |
| --- | --- | --- |
| Upload one or more JPEG/PNG/WebP/AVIF/GIF or PDF files, up to 25 MB each | Appears in the library with detected dimensions (all but AVIF); alt text is empty until set via "Edit alt" — no alt is collected at upload time | ✅ |
| Try to upload an SVG | Rejected — SVG isn't on the allow-list at all (see architecture.md §4 on why) | not yet exercised in prod |
| Upload the exact same file twice | Second one returns the first one's record, not a new duplicate | not yet exercised in prod |
| Delete a file used as a post's cover | `409`, refused, with the referencing post(s) named | not yet exercised in prod |
| Delete an unused file | Removed from both R2 and the library listing | not yet exercised in prod |
| "Copy URL" on a real (non-demo) item | Copies `/media/<key>` — this used to be broken (missing `/media/`) before this pass fixed the `key`/`url` shape | not yet exercised in prod |

**Not built yet (expect 404 or demo data, not real behaviour):**

| Check | Expected, once built or deployed |
| --- | --- |
| `POST https://blog-admin.<site>/mcp` (no token) | 401 with `WWW-Authenticate` (Phase 6) |
| A `scheduled` post reaching its `scheduled_for` time with nobody visiting the admin UI | Auto-publishes (Phase 5, cron slice) — today it stays `scheduled` until someone calls publish |
| Tag rename/merge on `/admin/tags/` | Persists for real, not just this browser's demo store — built and tested (Phase 5d), not yet deployed |
| Cover-image picker / "Insert image from library" in the editor | Both work against the real media library — built and tested, not yet deployed |

## 7. Rollback

`wrangler deploy` keeps prior versions, per site. To roll back one site's Worker:

```bash
npx wrangler deployments list --env gcameron
npx wrangler rollback <version-id> --env gcameron
```

D1 migrations are not rolled back by that. Write migrations additively — add columns
and tables, avoid destructive changes in the same release as the code that depends on
them — so an old Worker version keeps running against a newer schema. Take an export
(`POST /api/admin/export`) before any migration that drops or rewrites data.
