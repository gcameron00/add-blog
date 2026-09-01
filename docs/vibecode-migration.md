# Migrating the vibecode blog: collections, and the cutover runbook

This is the durable record of two things that arrived together but are separable:
**collections** (a generic, reusable "custom content type" mechanism — schema in
[architecture.md](architecture.md) §3, API in [api.md](api.md), MCP surface in
[mcp.md](mcp.md)) and the **specific migration** it was built to unblock: bringing a
second blog's content — ~15 posts and ~15 portfolio/project items — into this
platform as a new tenant. The feature is generic and stays in the codebase regardless
of what happens to any one migration; this document is where the migration-specific
half lives, since nothing else in `docs/` is the right home for "how to map vibecode's
frontmatter onto add-blog's columns."

---

## 1. Why collections, and why this shape

The source blog has a content type this platform's schema had no concept of:
portfolio/project items — a status badge (Live/In Progress/On hold/Archived), a
tech-stack tag list, a live-site URL, a repo URL — rendered as a card grid, not a
chronological post list. Two options existed:

1. **Hack it in as a one-off** — a handful of nullable columns on `posts`
   (`project_status`, `project_url`, `project_repo`, …) specific to this one shape.
   Fast, but the next content type (a talk, a now-page, a changelog) repeats the same
   one-off, and the schema accumulates content-type-specific columns forever.
2. **Build a generic mechanism** — one JSON column for arbitrary per-type fields, plus
   a settings-driven registry describing what fields each type has and how to render
   them. More work up front; the second content type (and the third) costs nothing new
   in the schema.

Option 2 is what's built (`migrations/0008_collections.sql`, `src/collections.js`).
Portfolio becomes the first real user of it, not a special case baked into the schema.

**Why `posts.post_type`/`type_fields` instead of a parallel `projects` table.** A
parallel table needs its own foreign keys and triggers mirroring `post_tags`,
`revisions` and the `posts_fts` virtual table (or has to explicitly exclude those
three, which is its own ongoing maintenance cost) — for every future content type.
What a portfolio item actually wants is nearly everything a post already has: a
unique slug, a draft/scheduled/published/archived lifecycle, a cover image,
publish/schedule, revision history, and cache purge on mutation. Overloading `posts`
gets all of that for free; the two new columns are the only thing a collection item
needs that an ordinary post doesn't. See [architecture.md](architecture.md) §3's
"Design notes" for the full version of this argument, including how every public read
path (`src/db.js`) filters `post_type = 'post'` so a collection item never leaks into
the blog itself.

**Why a collection is a `settings` row, not new schema.** Same reasoning as
`nav_config`/`about_content` (migrations/0007): a collection's *definition* — its
label, URL prefix, layout, field list — is site configuration an owner edits, not
structural data every row needs a column for. It lives in the `collections` settings
key as a JSON array, validated by `src/validate.js`'s `validateCollections` on write
and interpreted by `src/collections.js`'s `resolveCollections` on read, the same
validate-on-write/resolve-with-defaults split every other JSON-valued setting here
already uses.

**Why `layout` and each field's `display` are fixed enums, not free text.** A
collection's index page renders as `grid` or `list` — two built-in layouts
(`src/collections.js`'s `LAYOUTS`), never arbitrary owner-supplied HTML or a template
string. Each declared field renders through one of five fixed `display` types
(`badge`, `chips`, `link`, `text`, `date` — `FIELD_DISPLAYS`), each with its own
escaping-aware renderer. This is the same posture as the Markdown renderer described
in [architecture.md](architecture.md) §6 ("Content safety"): the set of things that
can be rendered is a fixed, reviewed list, not something a settings value can expand.

**Why no `CHECK` constraint on `post_type`.** Covered in the migration's own comment
and [deployment.md](deployment.md)'s per-migration notes: SQLite can't widen a `CHECK`
in place, and the set of valid `post_type` values is meant to grow per-site, whenever
an owner adds a collection through Settings — never per-migration. `post_type` is
validated in application code (`validatePostType`, checked against that site's own
`collections` registry) instead.

---

## 2. Schema recap

```sql
-- migrations/0008_collections.sql
ALTER TABLE posts ADD COLUMN post_type   TEXT NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN type_fields TEXT;   -- JSON object, NULL for blog posts
CREATE INDEX idx_posts_type_published ON posts(post_type, status, published_at DESC);
-- settings row 'collections', seeded to '[]' (feature off by default)
```

A collection entry (one element of the `collections` settings array):

```json
{
  "type": "project", "label": "Project", "label_plural": "Projects",
  "base_path": "/portfolio", "legacy_path": "/project",
  "index_title": "Portfolio", "layout": "grid",
  "in_feed": false, "in_sitemap": true,
  "nav": { "header": true, "footer": false },
  "fields": [
    { "key": "status", "label": "Status", "type": "enum",
      "options": ["Live", "In Progress", "On hold", "Archived"], "display": "badge" },
    { "key": "tech", "label": "Tech", "type": "tags", "display": "chips" },
    { "key": "url", "label": "Live", "type": "url", "display": "link" },
    { "key": "repo", "label": "Repo", "type": "url", "display": "link" }
  ]
}
```

Writing this into `settings.collections` for the new tenant (a `PUT /api/admin/settings`
call, or the `update_site_settings` MCP tool) is a per-tenant configuration step, done
once the new site's D1 is live — not part of this repo's code, and not seeded by the
migration itself (0008 seeds every tenant to `'[]'`; a real `projects` collection is
this tenant's own data, written after onboarding).

---

## 3. Content mapping

The source blog is a static-site-generator export: Markdown files with YAML
frontmatter, one per post and one per portfolio item. The exact field names in that
frontmatter aren't reproduced here (they weren't in hand while writing this) — what
follows is the *shape* of the mapping, so whoever runs the import can fill in the
literal frontmatter keys against it. Two frontmatter shapes, two destinations.

### Posts (~15 items) → `posts` where `post_type = 'post'`

| vibecode frontmatter (typical SSG shape) | add-blog column | Notes |
| --- | --- | --- |
| `title` | `title` | 1–200 chars (`validateTitle`) |
| `slug` (or derived from filename) | `slug` | Re-slugify if it doesn't already match `^[a-z0-9]+(-[a-z0-9]+)*$`; `uniqueSlug` suffixes on collision |
| `description` / `summary` / `excerpt` | `excerpt` | If absent, `excerptFrom(body_md, 190)` generates one — don't invent one by hand |
| body (Markdown content below the frontmatter fence) | `body_md` | Source of truth; `body_html` is rendered server-side on write, not carried over from any pre-rendered HTML the export has |
| `date` / `published` / `pubDate` | `published_at` | ISO-8601 UTC (architecture.md §3); import as already-`published`, not draft-then-publish, to preserve the original date — `published_at` is set once, on first publish |
| `updated` / `lastmod` (if present) | `updated_at` | Falls back to `published_at` if the export has no separate updated date |
| `tags` / `categories` (flat list) | `tags[]` via `setPostTags` | Folds into this project's single `tags` table, same as the WordPress importer's `category`/`post_tag` handling ([api.md](api.md)) |
| `image` / `cover` / `heroImage` | `cover_key`/`cover_alt` | Upload the referenced image first (`upload_media_from_url` MCP tool, or `POST /api/admin/media`), then set `cover_key` to the returned key |
| (no equivalent) | `author_id` | Every imported post is authored by whoever runs the import — same rule as the WordPress importer, not carried over from any per-post author field the export has |
| `draft: true` | `status = 'draft'` | Everything else imports as `published` — nothing lands publicly visible by accident, mirroring the WXR importer's status handling |

### Portfolio/project items (~15 items) → `posts` where `post_type = 'project'`

Same columns as above for `title`/`slug`/`excerpt`/`body_md`/`published_at`/`cover_key`,
plus `type_fields` carrying the fields the `project` collection declares:

| vibecode frontmatter | `type_fields` key | Field `type` | Notes |
| --- | --- | --- | --- |
| `status` (e.g. "active", "archived", "wip") | `status` | `enum` | Map the source's status vocabulary onto the collection's declared `options` (e.g. `"Live"`, `"In Progress"`, `"On hold"`, `"Archived"`) — pick the `options` list to match what the source actually uses, then translate one-to-one |
| `stack` / `technologies` / `tags` (project-specific tech list, not the blog's `tags` table) | `tech` | `tags` | Comma-separated string or array, ≤10 entries — this is a `type_fields` value, not a row in the shared `tags` table; a project's tech list and a post's topic tags are different vocabularies even if the export uses the same frontmatter key for both |
| `url` / `demo` / `liveUrl` | `url` | `url` | Validated the same way a post's `canonical_url` is (`validateUrl` — rejects `javascript:`/`data:`) |
| `repo` / `github` / `source` | `repo` | `url` | Same validation |

**Set `post_type: 'project'` on create**, and pass `type_fields` matching exactly the
keys the `project` collection declares — an unknown key is rejected outright
(`validateTypeFields`), so the collection's field list has to be finalized (and
written into `settings.collections`) before importing a single item.

### What has no destination

Anything the WordPress importer's own scope note already excludes — pages, comments,
non-post taxonomies — has the same fate here: not imported. If the source export has
its own "page" content (an About page, a contact page), that maps to this platform's
existing `about_content` setting or a static page, not a `posts` row of any
`post_type`, structural content, not blog/portfolio content.

---

## 4. Cutover checklist

Staged rollout, same shape as onboarding any new site in this fleet
([deployment.md](deployment.md) §§1–4), plus the domain-flip specific to replacing an
existing live site rather than launching a brand-new one:

1. **Provision the tenant** — new D1 database, new R2 bucket, apply every migration
   through `0008_collections.sql` in order (deployment.md §1), seed the first owner.
2. **Add the `[env.<name>]` block** to `wrangler.toml` and the site to
   `deploy.yml`'s matrix (deployment.md §3) — routed at a **staging subdomain first**,
   e.g. `blog.<domain>.com` / `blog-admin.<domain>.com`, *not* the apex domain the old
   static site currently serves. This is the one departure from the generic new-site
   runbook: the point is to get the new Worker fully live and verified on a hostname
   that isn't yet receiving real traffic, before touching the domain anyone currently
   visits.
3. **Set up Access** on the staging admin host (deployment.md §4) so the import can
   run as an authenticated owner, same as any other site.
4. **Write the `project` collection into `settings.collections`** (§2 above) before
   importing a single portfolio item — `type_fields` validation needs the field spec
   to exist first.
5. **Import content** — posts and portfolio items per the mapping in §3. Prefer MCP
   (`create_post` with `post_type`/`type_fields`, or `upload_media_from_url` for
   images) or the REST admin API directly over hand-editing D1; either path runs the
   same validators as the admin UI would.
6. **Verify on the staging subdomain** — every imported post and portfolio item
   reachable at its real permalink (`/posts/:slug` and `/portfolio/:slug`
   respectively), the portfolio index at `/portfolio/` rendering the grid with status
   badges/tech chips/links, the sitemap listing both (`in_sitemap: true` on the
   collection), RSS/feed as expected (`in_feed` — note collections aren't wired into
   `src/feeds.js`'s item list yet; leave `in_feed: false` unless that's built), and
   the header/footer nav showing "Projects" per `nav.header`/`nav.footer`. Post-deploy
   checks follow the same shape as deployment.md §6's per-phase tables — treat this as
   a new "Phase" row for this tenant specifically.
7. **DNS cutover** — once the staging subdomain is fully verified, change the apex
   domain's **Custom Domain** binding from wherever the old static site is hosted
   (Cloudflare Pages, a different Worker, an external host) to this Worker's
   `[env.<name>]` route, per deployment.md §2's Custom Domain mechanics (a bare
   hostname, zone must already exist in the account). This is a Cloudflare-dashboard,
   owner-run step — same "config in this repo can be authored by anyone, what it does
   to the real Cloudflare account still needs a human decision" boundary
   deployment.md's top note draws for every other CF-touching step.
8. **Post-cutover verification** — repeat the checks from step 6 against the real
   apex domain, confirm the old static host's DNS/deployment is genuinely no longer
   receiving traffic (not just that the new one is), and only then decommission the
   old host.
9. **Redirects for changed URLs** — if the old static site's URL structure differs
   from add-blog's (`/posts/:slug`, `/portfolio/:slug`, plus each collection's
   `legacy_path` for a query-string fallback — `src/pages.js`'s
   `handleLegacyCollectionRedirect`, mirroring `handleLegacyPostRedirect`), decide
   before cutover whether inbound links/search-engine indexing need redirect rules for
   the old paths. This platform doesn't build a general old-URL-to-new-URL redirect
   table — `legacy_path` is a single query-string fallback per collection, not an
   arbitrary URL rewriter.
