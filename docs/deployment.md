# Deployment runbook

Everything needed to take add-blog from the current static prototype to a running
blog on `blog.mysite.com` and `blog-admin.mysite.com`.

---

## What deploys today

`.github/workflows/deploy.yml` runs on every push to `main` and calls
`wrangler deploy --name <repo-name>`. It skips cleanly if `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are not set as repository secrets.

`wrangler.toml` currently declares only a static asset directory:

```toml
name = "generic-website"
compatibility_date = "2026-07-01"
workers_dev = true

[assets]
directory = "."
```

No `main`, so there is no Worker script — the deployment is static files only. That is
correct for Phase 1 and is why the prototype runs on demo data.

> [!IMPORTANT]
> `wrangler.toml`, `.assetsignore` and `.github/workflows/` are managed by the
> deployment tooling and are not edited as part of normal development. The changes in
> §3 below are a deliberate, one-time act by the repository owner, and each phase of
> the build-out is blocked until the corresponding stanza exists.

---

## 1. Create the resources

```bash
# D1
npx wrangler d1 create add-blog
# → note the database_id

# R2
npx wrangler r2 bucket create add-blog-media

# Apply the schema (see docs/architecture.md §3)
npx wrangler d1 execute add-blog --file=./migrations/0001_init.sql --remote
```

Seed the first owner so there is an identity that can log in — the email must match
exactly the identity Access will present:

```sql
INSERT INTO authors (id, email, name, role, created_at)
VALUES (lower(hex(randomblob(16))), 'you@mysite.com', 'Your Name', 'owner',
        strftime('%Y-%m-%dT%H:%M:%SZ','now'));
```

## 2. DNS

Two proxied records in the zone for `mysite.com`:

| Name | Type | Target | Proxy |
| --- | --- | --- | --- |
| `blog` | CNAME | the Worker's route | Proxied (orange cloud) |
| `blog-admin` | CNAME | the Worker's route | Proxied (orange cloud) |

Both must be proxied. An unproxied record bypasses both the Worker and Cloudflare
Access — on `blog-admin` that would mean serving the admin UI with no authentication
at all.

## 3. Required `wrangler.toml` additions

Owner action, applied per phase:

```toml
# Phase 2 — enable the Worker script (routing, hostname split)
main = "src/index.js"

# Phase 2 — bind both hostnames
routes = [
  { pattern = "blog.mysite.com/*",       custom_domain = true },
  { pattern = "blog-admin.mysite.com/*", custom_domain = true },
]

# Phase 3 — storage
[[d1_databases]]
binding = "DB"
database_name = "add-blog"
database_id = "<id from step 1>"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "add-blog-media"

# Phase 4 — Access verification (non-secret; the AUD tag and team name are
# identifiers, not credentials — but the app must still verify them)
[vars]
ACCESS_TEAM_DOMAIN = "mysite.cloudflareaccess.com"
ACCESS_AUD = "<application audience tag>"
PUBLIC_HOST = "blog.mysite.com"
ADMIN_HOST = "blog-admin.mysite.com"

# Phase 5 — scheduled publishing and retention
[triggers]
crons = ["*/5 * * * *"]
```

Two smaller items that also live in `wrangler.toml` and are therefore blocked until
the owner applies them:

- `[assets] not_found_handling = "404-page"`, so `404.html` is actually served on an
  unmatched path. Without it a bad URL gets a bare Workers 404. The file is already in
  the repository and does nothing until this is set. Phase 2 makes this moot for paths
  the Worker handles, but it still matters for unmatched static paths.
- `docs/` is not in `.assetsignore`, so the Markdown files in this repository are
  served publicly at e.g. `/docs/architecture.md`. That is harmless for a public repo
  and arguably useful, but worth knowing. Add `docs` to `.assetsignore` if the blog
  should not serve them.

Also add `src` and `migrations` to `.assetsignore` when Phase 2 lands, so Worker source
and SQL files are not uploaded into the public asset bundle.

Once `main` is set, `[assets]` keeps serving the static files, but the Worker runs
first and can intercept any path — which is exactly what the hostname split needs.

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

```bash
npx wrangler secret put SESSION_SIGNING_KEY   # signs preview links
```

`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are plain `[vars]`, not secrets: they are
public identifiers, and treating them as secrets encourages the mistake of thinking
possession of them proves anything. Security comes from JWT signature verification.

## 6. Post-deploy checks

| Check | Expected |
| --- | --- |
| `GET https://blog.mysite.com/` | 200, post list, no demo badge |
| `GET https://blog.mysite.com/admin/` | 404 |
| `GET https://blog.mysite.com/api/admin/posts` | 404 |
| `GET https://blog.mysite.com/mcp` | 404 |
| `GET https://blog-admin.mysite.com/` (logged out) | Access login |
| `GET https://blog-admin.mysite.com/` (logged in) | Admin dashboard |
| `POST https://blog-admin.mysite.com/mcp` (no token) | 401 with `WWW-Authenticate` |
| `GET https://blog.mysite.com/feed.xml` | Valid RSS |
| Draft post | Absent from public API and feed |
| Publish | Live within seconds; cache purged |
| `Cache-Control` on admin responses | `private, no-store` |

## 7. Rollback

`wrangler deploy` keeps prior versions. To roll back the Worker:

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

D1 migrations are not rolled back by that. Write migrations additively — add columns
and tables, avoid destructive changes in the same release as the code that depends on
them — so an old Worker version keeps running against a newer schema. Take an export
(`POST /api/admin/export`) before any migration that drops or rewrites data.
