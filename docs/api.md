# HTTP API

Two surfaces sharing one Worker:

- **Public API** — `https://blog.mysite.com/api/*`. Anonymous, read-only, cached,
  published content only.
- **Admin API** — `https://blog-admin.mysite.com/api/admin/*`. Behind Cloudflare
  Access, read/write, never cached, sees every status.

Requesting an admin path on the public hostname returns `404` — not `401`, not `403`.
The public hostname does not acknowledge that an admin surface exists.

> Status: specified, not yet implemented. This is the contract Phase 3 builds against,
> and the shape `assets/js/api.js` already calls.

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
`If-Match`; a mismatch is `409 conflict` with both versions in `detail` so the editor
can offer a merge rather than silently clobbering a co-editor's work.

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

### Non-JSON public routes

| Route | Returns |
| --- | --- |
| `GET /feed.xml` | RSS 2.0, 20 most recent posts |
| `GET /atom.xml` | Atom 1.0 |
| `GET /sitemap.xml` | Every published permalink plus tag and archive pages |
| `GET /robots.txt` | Generated; references the sitemap |
| `GET /media/:key` | R2 object, immutable cache headers |

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
| `GET` | `/posts` | All statuses. Filters: `status`, `tag`, `author`, `q`, `limit`, `offset`, `sort` |
| `POST` | `/posts` | Create. Only `title` is required; slug is derived if omitted |
| `GET` | `/posts/:id` | Full post including `body_md`, revision count, `ETag` |
| `PATCH` | `/posts/:id` | Partial update. Honours `If-Match` |
| `DELETE` | `/posts/:id` | Soft delete → `archived`. `?hard=true` (owner only) purges the row |
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
  "canonical_url": null
}
```

Validation: `title` 1–200 characters; `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–120
characters, unique; `body_md` at most 512 KB; at most 10 tags, each at most 40
characters; `scheduled_for` strictly in the future. `word_count`, `reading_minutes`,
`excerpt` (when omitted) and `body_html` are computed server-side and are read-only.

**A publish is not complete until the cache is purged.** `publish`, `unpublish`,
`PATCH` on a published post, and the scheduler cron all route through the same internal
publish path so purge and audit logging cannot diverge between them.

### Tags

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/tags` | All tags with counts, including unused |
| `POST` | `/tags` | Create |
| `PATCH` | `/tags/:id` | Rename or re-slug; existing links redirect |
| `DELETE` | `/tags/:id` | Remove, detaching from posts |
| `POST` | `/tags/merge` | `{ "from": ["css3"], "into": "css" }` |

### Media

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/media` | Library listing. Filters: `q`, `type`, `unused=true` |
| `POST` | `/media` | `multipart/form-data` upload: `file`, optional `alt` |
| `PATCH` | `/media/:key` | Update `alt` or `filename` |
| `DELETE` | `/media/:key` | Delete from R2 and D1. `409` if referenced, unless `?force=true` |
| `GET` | `/media/:key/usage` | Posts referencing this object |

Uploads default to a 25 MB cap and an allow-list of `image/jpeg`, `image/png`,
`image/webp`, `image/avif`, `image/gif`, `image/svg+xml`, `application/pdf`. SVG is
sanitised on upload — it is an executable format, and an unsanitised SVG served from
the blog's own origin is a stored XSS. The response includes the derived key, public
URL and detected dimensions.

### Settings, authors, and operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/settings` | All settings as one object |
| `PUT` | `/settings` | Replace (owner only); unknown keys rejected |
| `GET` | `/authors` | List |
| `POST` | `/authors` | Invite by email (owner only) — creates the row Access identities map onto |
| `PATCH` | `/authors/:id` | Update profile or role (owner only) |
| `DELETE` | `/authors/:id` | Remove (owner only); their posts are reassigned to the owner |
| `GET` | `/audit` | Audit log, newest first, filterable by `actor`, `action`, `via` |
| `GET` | `/stats` | Dashboard counters: posts by status, views, recent activity |
| `POST` | `/export` | Full content export to R2 as JSON; returns a short-lived link |
| `POST` | `/import` | Import from an export bundle or a Markdown/front-matter archive |

Settings keys: `site_title`, `site_description`, `site_url`, `base_path`, `timezone`,
`posts_per_page`, `allow_raw_html`, `theme_accent`, `social_image_key`,
`analytics_enabled`, `feed_full_content`.
