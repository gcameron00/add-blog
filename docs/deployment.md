# Deployment runbook

Everything needed to take add-blog from the current static prototype to a running
fleet of blogs — one shared Worker script, one `[env.NAME]` block per site. First site:
`blog.gcameron.com` / `blog-admin.gcameron.com`.

---

## What deploys today

`.github/workflows/deploy.yml` runs on every push to `main`, once per entry in its
`site` matrix, and calls `wrangler deploy --env <site>`. It skips cleanly if
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are not set as repository secrets.

`main = "src/index.js"` is set as of Phase 2, so every push now deploys the hostname
router — see `wrangler.toml` for the current site list and
[architecture.md](architecture.md) for what the router does. Every deploy still needs
D1/R2 (§1, Phase 3) and Access (§4, Phase 4) before it's actually safe to point a
production domain at; those remain owner-driven, per-site steps.

> [!NOTE]
> Whoever is applying `wrangler.toml`/`.assetsignore`/`.github/workflows/` changes,
> the CF-touching part — actually running `wrangler`, adding a zone, setting a
> secret — stays a deliberate, owner-run step, per site. The config in this repo can
> be authored by anyone; what it does to the real Cloudflare account still needs a
> human decision each time.

---

## 1. Create the resources (per site)

Each site gets its own database and bucket — never shared, per the single-tenant
decision in [implementation-plan.md](implementation-plan.md). Example for the
`gcameron` site:

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
| `GET https://blog-admin.<site>/admin/` | 200 (no login yet — Phase 4; see the README warning) |
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

**Later phases (not built yet — expect 404, not a login page or real content):**

| Check | Expected, once built |
| --- | --- |
| `GET https://blog-admin.<site>/` (logged out) | Access login (Phase 4) |
| `POST https://blog-admin.<site>/mcp` (no token) | 401 with `WWW-Authenticate` (Phase 6) |
| `GET https://blog.<site>/feed.xml` | Valid RSS (Phase 3) |
| Draft post | Absent from public API and feed (Phase 3/5) |
| Publish | Live within seconds; cache purged (Phase 5) |

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
