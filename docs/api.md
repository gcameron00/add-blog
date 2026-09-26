# HTTP API

Two surfaces sharing one Worker:

- **Public API** — `https://blog.mysite.com/api/*`. Anonymous, read-only, cached,
  published content only.
- **Admin API** — `https://blog-admin.mysite.com/api/admin/*`. Behind Cloudflare
  Access, read/write, never cached, sees every status.

Requesting an admin path on the public hostname returns `404` — not `401`, not `403`.
The public hostname does not acknowledge that an admin surface exists.

> Status: **Public API built and live** (Phase 3) — `GET /api/posts`, `/api/posts/:slug`,
> `/api/tags`, `/api/archive`, plus `feed.xml`/`atom.xml`/`sitemap.xml`/`robots.txt` and
> `/media/:key`. Source: `src/db.js`, `src/public-api.js`, `src/feeds.js`, `src/media.js`.
> **Admin API: identity built and live** (Phase 4) — `GET /me` (`src/admin-api.js`),
> gated by Access JWT verification (`src/access.js`) and role resolution (`src/auth.js`).
> Verified against the live Access application on `blog-admin.gcameron.com`.
> **Posts built, tested, and live for `gcameron`** (Phase 5, `src/admin-posts.js`,
> verified in production 2026-07-28) — every route in the Posts table below, plus
> `POST /preview`. Role/ownership checks, `ETag`/`If-Match` conflict detection,
> revisions-with-restore, and a best-effort edge-cache purge on every mutation are all
> in. **The editor now sends `If-Match` and handles a `409`** (Phase 5g, live for
> `gcameron`) — not a merge/overwrite prompt, an owner decision: rather than let the
> editor overwrite someone else's edit or discard the local one, a conflicting explicit
> Save forks the local content into a new draft post instead (`assets/js/editor.js`'s
> `save()`); autosave never forks on its own, it just surfaces the conflict in the
> save-state indicator and stops retrying until the user acts. The explicit-save fork
> is verified in production (2026-07-29/30: produced a second draft post as expected);
> the autosave conflict indicator hasn't been observed yet. Still not built:
> `Idempotency-Key` (its main consumer, MCP, doesn't exist yet either). **Fixed in
> production:** editing an already-published post used to be labelled "Save draft"
> while going live immediately — the button now says "Save changes" for a
> published/scheduled post.
> **Settings and dashboard reads built, tested, and live for `gcameron`** (Phase 5b,
> `src/admin-settings.js`, `src/admin-dashboard.js`) — `GET`/`PUT /settings`,
> `GET /stats`, `GET /audit`. The settings key list below has been corrected to match
> what's actually seeded and what the settings form actually submits (added
> `admin_url`, dropped the unused `theme_accent`).
> **Media built, tested, and live for `gcameron`** (Phase 5c, `src/admin-media.js`) —
> every route below except `image/svg+xml` uploads, which aren't accepted (see the note
> under "Uploads" below — needs a real sanitiser, not a stand-in). AVIF uploads are
> accepted but stored without detected `width`/`height`. The editor's cover-image
> picker and insert-from-library button (`assets/js/admin.js`'s `openMediaPicker`) are
> deployed for `gcameron` too — not yet hands-on verified in production (see
> [deployment.md](deployment.md) §6).
> **Tags built, tested, and deployed for `gcameron`** (Phase 5d, `src/admin-tags.js`) —
> every route in the Tags table below, including `merge`, live but not yet hands-on
> verified in production. Renaming a tag's slug does not leave a redirect for the old
> one — see the note in `src/admin-tags.js`.
> **Authors built, tested, and deployed for `gcameron`** (Phase 5e,
> `src/admin-authors.js`) — migration `0002` (additive, `disabled` column, see
> [architecture.md](architecture.md) §3) applied 2026-07-29; not yet hands-on verified
> in production (see [deployment.md](deployment.md) §6). Every route in the Authors row
> below is live. There is no invite email; `POST /authors`
> only creates the row, and the admin UI explains the two out-of-band steps (Cloudflare
> Access policy, telling the person directly) after a successful create. Disabling,
> deleting, or demoting the only remaining active owner is rejected with `409 conflict`
> (`assertNotLastOwner`), and so is disabling or deleting *your own* row regardless of
> how many other owners exist (`assertNotSelf`) — both in `src/admin-authors.js`.
> **Cron (scheduled-post auto-publish) built, tested, and verified live for `gcameron`**
> (Phase 5f, `src/cron.js`) — a `scheduled` post's `scheduled_for` time arriving now
> flips it to `published` without anyone visiting the admin UI, confirmed in production
> 2026-07-29.
> **`/export`, `/import` are specified, not implemented, and moved to Phase 7** (owner
> decision, 2026-07-29) — Phase 5's write path doesn't need a backup/restore route to be
> complete. Owner-only when built, same tier as `/settings`. See
> [implementation-plan.md](implementation-plan.md)'s Phase 7 section for the full spec.
> `assets/js/api.js` already calls every route in this document; it falls back to
> demo data per-endpoint until each one is live.

---

## Conventions

**Format.** JSON in, JSON out, UTF-8. Write requests must send
`Content-Type: application/json`. Timestamps are ISO-8601 UTC (`2026-07-25T20:56:00Z`).

**Success** responses return the resource, or a collection envelope:

```json
{
  "data": [ … ],
  "page": { "limit": 20, "offset": 0, "total": 137, "has_more": true }
}
```

**Errors** are uniform, and `code` is the part clients should branch on:

```json
{
  "error": {
    "code": "slug_taken",
    "message": "A post with the slug \"hello-world\" already exists.",
    "field": "slug"
  }
}
```

| Status | When |
| --- | --- |
| `400 bad_request` | Malformed JSON, unknown field, failed validation |
| `401 unauthenticated` | Missing or invalid Access JWT (admin only) |
| `403 forbidden` | Valid identity, insufficient role, or no `authors` row |
| `404 not_found` | No such resource — also every admin path on the public host |
| `409 conflict` | Slug collision, or `If-Match` revision mismatch |
| `413 payload_too_large` | Upload over the configured cap |
| `415 unsupported_media_type` | Content type not in the allow-list |
| `429 rate_limited` | Per-identity write/upload limit; includes `Retry-After` |
| `500 internal_error` | Unhandled; correlate with `X-Request-Id` in the response |

**Concurrency.** `GET` of a single post returns an `ETag`. `PATCH` may send
`If-Match`; a mismatch is `409 conflict` with both versions in `detail`. The admin
editor's own handling of that `409` (built 2026-07-29) isn't a merge — it forks the
local edit into a new draft post rather than clobbering or discarding either side's
work; see the Posts status note above.

**Idempotency.** `POST` endpoints accept `Idempotency-Key`. A repeat within 24 hours
returns the original response instead of creating a duplicate — this matters most for
MCP clients, which retry on transport errors.

---

## Public API

### `GET /api/posts`

Published posts, newest first.

| Query | Default | Notes |
| --- | --- | --- |
| `limit` | `20` | 1–100 |
| `offset` | `0` | |
| `tag` | — | Tag slug |
| `q` | — | Full-text search over title, excerpt, body |
| `before` / `after` | — | ISO date bounds on `published_at` |

```json
{
  "data": [
    {
      "slug": "shipping-a-blog-on-workers",
      "title": "Shipping a blog on Cloudflare Workers",
      "subtitle": "One deployment, two hostnames, zero servers",
      "excerpt": "A walk through the routing model…",
      "cover": { "url": "/media/2026/07/9f2c…-cover.jpg", "alt": "Edge map" },
      "author": { "name": "Grant Cameron", "avatar": "/media/avatars/…" },
      "tags": [{ "slug": "cloudflare", "name": "Cloudflare" }],
      "reading_minutes": 6,
      "published_at": "2026-07-18T09:00:00Z",
      "updated_at": "2026-07-20T11:12:00Z"
    }
  ],
  "page": { "limit": 20, "offset": 0, "total": 37, "has_more": true }
}
```

List responses omit `body_html` — a 40-post index should not ship 400 KB of article
bodies. Fetch the single-post endpoint for content.

### `GET /api/posts/:slug`

One published post, including `body_html`, `body_md`, and `related` (up to three posts
sharing the most tags). `404` if the post is not published — the public API gives no
signal that an unpublished post with that slug exists.

### `GET /api/tags`

All tags that have at least one published post, with `post_count`.

### `GET /api/archive`

Published posts grouped by year and month — slug, title and date only. One request
backs the whole archive page.

### `POST /api/pagecounter`

One page view (#18) — sent by `assets/js/main.js` as a `navigator.sendBeacon` from
post and collection item pages (the ones the Worker marks `data-view="<slug>"`).
Body: `{"slug": "…"}` (sent as `text/plain`, at most 512 bytes). Adds one to that
post's count for today (UTC) in `post_views` if the slug is a published post or
collection item (unlisted included), `analytics_enabled` is on, and the request isn't
cross-site (a foreign `Origin`, or with no `Origin` a `Sec-Fetch-Site` other than
`same-origin`). A beacon that isn't counted logs a `track_view_ignored` line with its
reason (`cross_site`, `bad_body`, `not_counted`) to the Worker's logs. Always `204 No Content`, `Cache-Control: no-store` — whether
or not anything was counted, so it reveals nothing about which slugs exist or whether
counting is on. A no-op on the admin host. Never edge-cached. See
[architecture.md](architecture.md) §3.

### Non-JSON public routes

| Route | Returns |
| --- | --- |
| `GET /feed.xml` | RSS 2.0, 20 most recent posts (`Content-Type: application/rss+xml`) |
| `GET /atom.xml` | Atom 1.0 (`Content-Type: application/atom+xml`) |
| `GET /sitemap.xml` | Every published permalink plus tag and archive pages |
| `GET /robots.txt` | Generated; references the sitemap |
| `GET /media/:key` | R2 object, immutable cache headers |
| `GET /site.webmanifest` | Web App Manifest for Android/Chrome/Edge "Add to Home Screen"/install — reflects `site_title`/`site_icon_key` (`src/manifest.js`) |
| `GET /favicon.ico` | Static default checkmark icon, or a `302` to `/media/:key` when `site_icon_key` is set (`src/manifest.js`'s `handleFaviconIco`) — the static file is one shared asset across every site (`wrangler.toml`'s one bundle for every `[env.NAME]`), so a site with a custom icon needs this redirect or every site's `/favicon.ico` would show the same generic default regardless of branding |
| `GET /feed/`, `/feed/rss/`, `/feed/rss2/`, `/feed/rdf/`, `/feed/atom/` | 301 to `/feed.xml` or `/atom.xml` — WordPress migration compatibility, see `src/pages.js`'s `handleWordpressFeedRedirect` |

---

## Admin API

All routes below are `https://blog-admin.mysite.com/api/admin/…`, require a valid
Access JWT, and return `private, no-store`.

### Identity

`GET /me` → the caller's author record, resolved role, and effective permissions. The
admin UI calls this on load to decide which controls to render. It is a convenience,
not a security boundary — every endpoint re-checks the role server-side.

### Posts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/posts` | All statuses. Filters: `status`, `tag`, `author`, `q`, `type`, `limit`, `offset`, `sort` |
| `POST` | `/posts` | Create. Only `title` is required; slug is derived if omitted |
| `GET` | `/posts/:id` | Full post including `body_md`, revision count, `ETag` |
| `PATCH` | `/posts/:id` | Partial update. Honours `If-Match` |
| `DELETE` | `/posts/:id` | Soft delete → `archived`. `?hard=true` (owner only) purges the row |
| `POST` | `/posts/:id/unarchive` | `archived` → `draft`. `409` if the post isn't archived |
| `POST` | `/posts/:id/publish` | Publish now. Sets `published_at` if unset |
| `POST` | `/posts/:id/unpublish` | Back to `draft`, leaving `published_at` intact |
| `POST` | `/posts/:id/schedule` | Body `{ "scheduled_for": "…" }`; must be in the future |
| `POST` | `/posts/:id/duplicate` | Copy as a new draft, slug suffixed `-copy` |
| `GET` | `/posts/:id/revisions` | Revision list, newest first |
| `GET` | `/posts/:id/revisions/:rid` | One revision's full body |
| `POST` | `/posts/:id/revisions/:rid/restore` | Restore, saving current state as a new revision first |
| `POST` | `/preview` | Render `{ "body_md": "…" }` → sanitised HTML, no persistence |

Create/update body:

```json
{
  "title": "Shipping a blog on Cloudflare Workers",
  "slug": "shipping-a-blog-on-workers",
  "subtitle": "One deployment, two hostnames, zero servers",
  "excerpt": "A walk through the routing model…",
  "body_md": "## The routing model\n\n…",
  "tags": ["cloudflare", "workers"],
  "cover_key": "media/2026/07/9f2c…-cover.jpg",
  "cover_alt": "Edge map",
  "status": "draft",
  "visibility": "public",
  "canonical_url": null,
  "post_type": "post",
  "type_fields": null
}
```

Validation: `title` 1–200 characters; `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–120
characters, unique; `body_md` at most 512 KB; at most 10 tags, each at most 40
characters; `scheduled_for` strictly in the future. `word_count`, `reading_minutes`,
`excerpt` (when omitted) and `body_html` are computed server-side and are read-only.

**`post_type`/`type_fields` (migrations/0008_collections.sql, `src/collections.js`).**
`post_type` defaults to `"post"` and is optional on create; when set to a value other
than `"post"`, it must be a type declared in the site's `collections` setting (`GET
/settings`, or the `list_collections` MCP tool) — an unconfigured type is rejected
`400 bad_request` with `field: "post_type"`. `type_fields` is a JSON object of values
for that collection's declared fields, validated per field's `type` (`text`, `enum`,
`url`, `tags`, `date`); an unknown key, or a value that doesn't match its field's
type, is rejected the same way. **`post_type` cannot be changed on `PATCH`** — a `400`
with `field: "post_type"` if the body includes one that differs from the post's
current value, since changing it would change the post's URL (a different
collection's `base_path`) and its field contract (a different collection's fields)
out from under content that's already there. `type_fields` can be patched on its own.
`GET /posts?type=<type>` (default `"post"`, `"all"` for every type) filters the list
the same way `status` does; a plain `GET /posts` with no `type` still shows only
ordinary posts, unchanged from before this existed.

**A publish is not complete until the cache is purged.** `publish`, `unpublish` and
`PATCH` on a published post (`src/admin-posts.js`) share one purge helper
(`purgeIfPublic` → `src/cache-purge.js`'s `purgePostUrls`) so none of them can diverge
from the others. The scheduler cron (`src/cron.js`, Phase 5f) has no request or
identity to route through that admin-API layer, so it calls `purgePostUrls` and
`writeAuditLog` directly instead — same primitives, different caller, `via: 'cron'` /
`actor: 'system'` instead of a signed-in identity's.

### Tags

`POST`/`PATCH`/`DELETE`/`merge` require `owner` or `editor` — same level as
`post.editOthers`, since renaming or deleting a tag touches every post that carries it,
not just the caller's own. `GET` only requires a signed-in identity.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/tags` | All tags with counts, including unused — counted across every post status, not just published (unlike the public `GET /api/tags` above) |
| `POST` | `/tags` | Create. `slug` is optional — derived from `name` if omitted |
| `PATCH` | `/tags/:id` | Rename or re-slug |
| `DELETE` | `/tags/:id` | Remove, detaching from posts |
| `POST` | `/tags/merge` | `{ "from": ["css3"], "into": "css" }` — folds `from` into `into`, both by slug |

**Renaming a tag's slug does not leave a redirect behind.** The public tag page
(`/tags/?tag=<slug>`) is a live query-parameter filter against the *current* slug, not a
static route with its own history, so a bookmark or inbound link built on the old slug
just returns zero posts rather than 404ing — annoying, not broken. A redirect table is
real schema work that wasn't warranted to make tag management usable.

### Media

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/media` | Library listing. Filters: `q`, `type`, `unused=true` |
| `POST` | `/media` | `multipart/form-data` upload: `file`, optional `alt` |
| `PATCH` | `/media/:key` | Update `alt` or `filename` |
| `DELETE` | `/media/:key` | Delete from R2 and D1. `409` if referenced, unless `?force=true` |
| `GET` | `/media/:key/usage` | Posts referencing this object |

Uploads are capped at 25 MB and allow-listed to `image/jpeg`, `image/png`,
`image/webp`, `image/avif`, `image/gif`, `application/pdf`, plus GPX tracks for the
`{{gpx: …}}` shortcode. A GPX file is recognised by its `.gpx` extension plus a `<gpx>`
root element, whatever type the browser declared, and stored as `application/gpx+xml`.
The public `GET /media/:key` route returns `404` for GPX, because the raw file still
has the untrimmed start and end of the track (see docs/mcp.md).

**`image/svg+xml` is not accepted.** SVG is an executable format, and an unsanitised
SVG served from the blog's own origin is a stored XSS — this was always going to need
sanitising before storage, and a regex-based "sanitiser" for something this
XSS-sensitive would give false confidence rather than real safety. It's off the
allow-list until there's a real parser behind it, not a stand-in.

The response includes the derived key, public URL and, for every allow-listed format
except AVIF, detected dimensions — AVIF's live in a nested box structure inside the
file that isn't parsed yet, so those uploads store with `width`/`height` as `null`
rather than a guess.

### Settings, authors, and operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/settings` | All settings as one object |
| `PUT` | `/settings` | Replace (owner only); unknown keys rejected |
| `GET` | `/authors` | List, with each author's `post_count` |
| `POST` | `/authors` | Create by email (owner only) — the row Access identities map onto; no email is sent |
| `PATCH` | `/authors/:id` | Update name, email, role, or `disabled` (owner only) |
| `DELETE` | `/authors/:id` | Remove (owner only); their posts are reassigned to whoever performed the delete |
| `GET` | `/audit` | Audit log, newest first, filterable by `actor`, `action`, `via`, paginated (`limit`/`offset`, `page` envelope). Each entry includes `entity`/`entity_id` (added for the full `/admin/audit/` page, #12) |
| `GET` | `/stats` | Dashboard counters: posts by status, words, media, next scheduled post, and `views` — `{ total, last_30_days }` across posts and collection items (#18), or `null` if the site hasn't applied `migrations/0009_post_views.sql` |
| `GET` | `/stats/views` | Per-page view counts for the `/admin/stats/` page — see below |
| `POST` | `/export` | Full content export to R2 as JSON; returns a short-lived link |
| `POST` | `/import` | Import from an export bundle or a Markdown/front-matter archive |

`disabled` blocks sign-in (`resolveAuthor` stops matching the row — same `403` as no row
at all) without touching the row, its role, or its post history; it's the reversible
half of removing someone, `DELETE` the harder-to-undo one. Both `disabled: true` and
`DELETE`, plus a `role` change away from `owner`, are rejected with `409 conflict` if
the target is the only remaining active (non-disabled) owner — and disabling or
deleting your own row is rejected the same way regardless of how many other owners
exist; only another owner can do either to you.

#### `GET /api/admin/stats/views`

One row per post and collection item with its views in a date range, for the
`/admin/stats/` page. Query parameters:

- `range` — `7d`, `30d` (default), `90d`, `12m` (365 days), `ytd`, `all`, or `custom`
  with `from`/`to` (`YYYY-MM-DD`, inclusive, at most ~10 years apart). Rolling ranges
  end today; all days are UTC, the only resolution `post_views` stores. `all` starts
  at the earliest day with any count.
- `type` — `all` (default) or one `post_type` (`post`, or a collection's type).
- `sort` — `views` (default), `published`, or `title`; `order` — `asc`/`desc`
  (defaults: views and published newest/most first, title A–Z). Never-published rows
  sort last by `published`.
- `limit` (1–200, default 50), `offset`.

Every published page is listed, zero views included; anything else (archived, back to
draft) appears only while it has views in the range. Response:

```json
{
  "range": { "key": "30d", "from": "2026-08-28", "to": "2026-09-26", "days": 30,
             "previous": { "from": "2026-07-29", "to": "2026-08-27" } },
  "data": [{ "id": "…", "slug": "…", "title": "…", "post_type": "post", "status": "published",
             "visibility": "public", "published_at": "…", "views": 42, "previous_views": 30 }],
  "totals": { "views": 120, "previous_views": 95, "pages_viewed": 7,
              "top": { "id": "…", "title": "…", "views": 42 } },
  "counting": true,
  "page": { "limit": 50, "offset": 0, "total": 12, "has_more": false }
}
```

`previous` is the same-length span just before the range (what the page's change
figures compare against); it and every `previous_views` are `null` for `all`.
`counting` mirrors `analytics_enabled`, so the page can say counting is off.
`totals` cover every row matching `type`, not just the returned page. An unknown
`range`/`sort`/`order` or a malformed date is a `400`. `{ "data": null }` if the site
hasn't applied `migrations/0009_post_views.sql`.

Settings keys: `site_title`, `site_description`, `site_url`, `admin_url`, `base_path`,
`timezone`, `posts_per_page`, `allow_raw_html`, `social_image_key`, `site_icon_key`,
`analytics_enabled`, `feed_full_content`, `nav_config`, `about_content`,
`style_guide`, `collections` (the custom-content-type registry, migrations/
0008_collections.sql — see [architecture.md](architecture.md) §3; validated by
`validateCollections` on write). `PUT` only touches keys present in the
request body — not a literal full-replace — since the settings form only submits the
keys it has inputs for; a stricter reading would silently drop any seeded key the
form has no input for (`social_image_key` was one, until #14 gave it a field) on
every save.

`site_icon_key` is an R2 media key, same shape as a post's `cover_key` — set via
admin/settings/index.html's "Brand icon" field (the same library picker the editor's
cover image uses), not a direct upload of its own. `src/site-template.js`'s
`applySiteBranding` swaps it into the favicon `<link>`, the `apple-touch-icon` `<link>`
(iOS/iPadOS home screen, macOS "Add to Dock") and the header's inline mark on every
public page; `src/manifest.js` swaps it into `/site.webmanifest`'s icon (Android/
Chrome/Edge install) the same way; `assets/js/admin.js`'s `renderSidebar` does the
favicon/apple-touch-icon/mark swap client-side for the admin shell, which isn't
server-templated (see architecture.md §2's 2026-08-01 note). All fall back to the
static default icons — `assets/favicon.svg` (with an `assets/favicon-32x32.png`
fallback for browsers without SVG favicon support, e.g. Safari before 17),
`assets/apple-touch-icon.png`, `assets/icon-192.png`/`assets/icon-512.png`, and the
static `favicon.ico` at the repo root — when unset. That last one is a `302` to
`/media/:key` instead of a swap, since `favicon.ico` (unlike everything above) is one
file shared by every site in this deployment — see the `/favicon.ico` row above. SVG uploads aren't accepted (see "Uploads" below), so a custom icon is
raster-only in practice; it also isn't resized, so the manifest reports its size as
`"any"` rather than claiming a fixed 192×192/512×512 that likely isn't true.
Deleting a media item referenced by `site_icon_key` (or `social_image_key`) is guarded
the same way a post's `cover_key` is — `409 conflict` without `?force=true`.

`social_image_key` (#14) is the same shape, set via the "Social image" field next to
"Brand icon". `src/site-template.js`'s `applyImageMeta` fills the `<!-- og-image -->`
placeholder in every public page shell with an absolute `og:image` plus a
`twitter:card`: a post's or collection item's own cover first (with `og:image:alt`),
else `social_image_key`, both as `summary_large_image`; else `site_icon_key` as a small
`summary` card; else no image tags at all.

`site_title` and `site_description` aren't admin-only values — `src/site-template.js`
templates them onto every public page (see [architecture.md](architecture.md) §2's
2026-08-01 note) and `src/feeds.js` reads them into the RSS/Atom channel. Saving either
purges the edge cache for the shared static pages so the change is visible immediately
rather than waiting out `max-age` (architecture.md §5).

### WordPress import (WXR)

Separate from `/import` above — that's this project's own round-trip format. This is
for migrating an existing WordPress site in, from its WP Admin → Tools → Export.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/import/preview` | Dry run — `multipart/form-data`: `file` (a WXR `.xml`). No writes, no network fetches. Returns counts plus the same link-classification report a real run would produce. |
| `POST` | `/import/run` | Same upload shape. Fetches attachments, creates posts, and returns a report of what happened — may need calling more than once, see below. |
| `POST` | `/import/media` | `multipart/form-data`: `file` (the WXR) plus one or more `media` files. The alternative to `/run` fetching attachments itself — see below. |

**`/run` can require more than one call for a large export.** Workers caps external
`fetch()` calls at 50 per invocation on the Free plan (10,000 on Paid) — a big media
library can't be fetched in one request regardless of plan, so `executeImportPlan`
(`src/admin-import.js`) processes attachments in batches of 25 per call. If any remain
after a batch, the response's `media_pending` is non-zero and **no posts are created
yet** — call `/run` again with the identical file to continue. Already-fetched
attachments (tracked by `media.source_url`, `migrations/0006_media_source_url.sql`)
cost nothing on a repeat call; a real per-item failure (dead link, disallowed type) is
recorded in `media_failed` once and not retried, so a genuinely broken link can never
block progress forever. Posts are deliberately held back until `media_pending` reaches
zero — a post created against still-unresolved media would have broken image links
baked into its `body_md` permanently, since the skip-on-duplicate-slug behavior below
means a later call can never revisit its content. `/import/preview`'s response
includes `media_batches_expected` so the admin UI can warn upfront that a large import
will take multiple confirms.

**`/import/media` is the alternative when `/run` can never fetch attachments at
all.** Some hosts block automated requests for images outright, with no
request-side workaround — confirmed 2026-08-05 against SiteGround's AI Anti-Bot
Protection, which challenges every fetch with a CAPTCHA redirect
(`/.well-known/sgcaptcha/…`) regardless of headers or pacing, and offers no
self-service allowlist for a script. `/import/media` sidesteps fetching entirely:
download the old site's `wp-content/uploads` folder directly (e.g. via the host's
file manager or SFTP) and upload it here instead. Each `media` file is matched to a
still-pending attachment **by filename** — WordPress's own upload path already keeps
names unique within one export in practice, so no path reconstruction against the
site's real URL structure is needed. A match writes through the exact same
dedupe/`source_url` path a fetched attachment would
(`src/admin-import.js`'s `storeAttachmentBytes`), so a following `/run` call simply
finds it already resolved and proceeds — no separate "resume" logic. The response is
`{ matched, already_resolved, unmatched: [{ name, reason }] }`; a file that doesn't
match anything in the export, or fails the same type/size checks as a direct
upload, is reported rather than silently dropped.

Owner only (`import.wxr`, architecture.md §6). Only posts and their media are
imported — WordPress pages, comments, and non-`category`/`post_tag` taxonomies
(`post_format`, `nav_menu`, …) are not; `category` and `post_tag` both fold into this
project's single `tags` table. A WP `publish` status becomes `published`; every other
status (`draft`, `pending`, `future`, `private`, `trash`) becomes `draft`, so nothing
lands publicly visible by accident. WXR author records are ignored — every imported
post is authored by whoever runs the import. Re-running the same file is safe: a post
whose slug already exists is skipped, and already-uploaded media is deduplicated by
its content checksum exactly like a direct upload.

Links inside imported content that point at the old site's own domain are rewritten:
to another imported post's new `/posts/:slug` URL, or to the new `/media/:key` URL
once that attachment is re-uploaded. A link to a WordPress page (never imported) is
left as-is and reported under `links_to_dropped_pages` rather than silently broken
further or silently dropped; anything else on the old domain that doesn't resolve is
reported under `links_unresolved`. Links to other domains are left untouched entirely.

Every write from this path uses `via: 'import'` in the audit log
(`migrations/0005_audit_via_import.sql`).
