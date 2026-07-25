# Architecture

How add-blog is put together: one Worker, two hostnames, D1 for structure, R2 for bytes.

---

## 1. Deployment shape

A single Worker script is deployed once per site. It is bound to two custom domains and
branches on `URL.hostname`:

| Hostname | Audience | Auth | Cacheable |
| --- | --- | --- | --- |
| `blog.mysite.com` | Everyone | None | Yes, aggressively |
| `blog-admin.mysite.com` | Editors and agents | Cloudflare Access | Never |

This is one deployment per site, not a multi-tenant service. Each site that "adds a
blog" gets its own Worker, its own D1 database and its own R2 bucket. That keeps
isolation trivial, keeps queries free of a `site_id` predicate, and means a
misconfiguration can never leak one customer's drafts to another. Multi-tenancy is
discussed as an open question in the implementation plan.

### Why hostname routing rather than a path prefix

Putting the admin on `blog.mysite.com/admin` would mean the public hostname must
enforce authorization on a path — one routing bug away from exposing drafts. With a
separate hostname, Cloudflare Access terminates unauthenticated requests at the edge
before the Worker is invoked, and the public hostname can respond `404` to every admin
path unconditionally. Authorization becomes a property of the deployment topology
rather than of the application code.

---

## 2. Request routing

```
request
  │
  ├─ hostname == blog-admin.*
  │     │  (Cloudflare Access has already validated the user; the Worker still
  │     │   verifies the Access JWT itself — see §6)
  │     ├─ POST /mcp                 → MCP server (Streamable HTTP)
  │     ├─ /api/admin/*              → admin JSON API (read/write)
  │     ├─ /api/*                    → public JSON API (reused, unfiltered by status)
  │     └─ everything else           → static assets (admin UI)
  │
  └─ hostname == blog.*  (or anything else)
        ├─ /admin/*, /api/admin/*, /mcp   → 404, always, no exceptions
        ├─ /api/*                          → public JSON API (published posts only)
        ├─ /feed.xml, /rss.xml             → RSS
        ├─ /sitemap.xml                    → sitemap
        ├─ /media/<key>                    → R2 object, immutable cache
        ├─ /posts/<slug>                   → static post shell + hydration
        └─ everything else                 → static assets (public UI)
```

The `404` branch for admin paths on the public hostname is deliberately the *first*
check, not the last. It should be a literal prefix test at the top of the handler with
no dependency on any other state.

### Static assets and dynamic paths

The static asset bundle cannot express `/posts/<slug>` as a real file. Two options,
in order of preference:

1. **Worker-rendered shell (Phase 3).** The Worker matches `/posts/<slug>`, loads the
   post from D1, and returns fully-rendered HTML. Best for SEO, fastest first paint,
   and works with JavaScript disabled.
2. **Query-parameter fallback (today).** `/post/?slug=my-post` is a real static file
   that fetches and renders client-side. This is what the Phase 1 prototype uses,
   because it works with an assets-only deployment.

Phase 3 keeps `/post/?slug=` working as a permanent redirect target so no links break.

---

## 3. Data model (D1)

SQLite via D1. Timestamps are stored as ISO-8601 UTC strings — human-readable in the
D1 console, sortable lexicographically, and unambiguous about timezone.

```sql
CREATE TABLE authors (
  id          TEXT PRIMARY KEY,          -- uuid
  email       TEXT NOT NULL UNIQUE,      -- matches the Access identity email
  name        TEXT NOT NULL,
  bio         TEXT,
  avatar_key  TEXT,                      -- R2 object key
  role        TEXT NOT NULL DEFAULT 'author'
              CHECK (role IN ('owner','editor','author')),
  created_at  TEXT NOT NULL
);

CREATE TABLE posts (
  id              TEXT PRIMARY KEY,      -- uuid
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  excerpt         TEXT,                  -- generated from body if not supplied
  body_md         TEXT NOT NULL,         -- source of truth
  body_html       TEXT,                  -- rendered at write time, cached here
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','published','archived')),
  visibility      TEXT NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','unlisted')),
  author_id       TEXT NOT NULL REFERENCES authors(id),
  cover_key       TEXT,                  -- R2 object key
  cover_alt       TEXT,
  canonical_url   TEXT,                  -- when cross-posted from elsewhere
  word_count      INTEGER NOT NULL DEFAULT 0,
  reading_minutes INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  published_at    TEXT,                  -- set once, on first publish
  scheduled_for   TEXT                   -- when status = 'scheduled'
);

CREATE INDEX idx_posts_published ON posts(status, published_at DESC);
CREATE INDEX idx_posts_scheduled ON posts(status, scheduled_for) WHERE status = 'scheduled';
CREATE INDEX idx_posts_author    ON posts(author_id);

CREATE TABLE tags (
  id    TEXT PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  description TEXT
);

CREATE TABLE post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX idx_post_tags_tag ON post_tags(tag_id);

CREATE TABLE media (
  key          TEXT PRIMARY KEY,         -- R2 object key
  filename     TEXT NOT NULL,            -- original upload name
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  alt          TEXT,
  checksum     TEXT,                     -- sha-256, for dedupe
  uploaded_by  TEXT REFERENCES authors(id),
  created_at   TEXT NOT NULL
);

CREATE TABLE revisions (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  author_id  TEXT REFERENCES authors(id),
  note       TEXT,                       -- e.g. "autosave", "published"
  created_at TEXT NOT NULL
);
CREATE INDEX idx_revisions_post ON revisions(post_id, created_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,              -- JSON-encoded
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,              -- email from the Access identity
  via        TEXT NOT NULL               -- 'ui' | 'mcp' | 'api'
             CHECK (via IN ('ui','mcp','api')),
  action     TEXT NOT NULL,              -- 'post.publish', 'media.delete', …
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,                       -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Full-text search over published content
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title, excerpt, body_md,
  content = 'posts', content_rowid = 'rowid'
);
```

### Design notes

**`body_md` is the source of truth; `body_html` is a cache.** Markdown is rendered
once on write rather than on every read. A re-render of all posts is a migration step,
not a hot path. This keeps public reads to a single indexed `SELECT`.

**`published_at` is set once.** Editing a published post updates `updated_at` only, so
permalinks and feed ordering stay stable. Unpublishing and republishing does not move
a post back to the top of the feed.

**Scheduled posts.** A Cron Trigger runs every five minutes and promotes rows where
`status = 'scheduled' AND scheduled_for <= now()`. The partial index makes that a
near-free query. Publishing through the cron path and through the API converge on the
same internal `publishPost()` function so the cache purge and audit entry cannot be
forgotten in one path.

**Revisions are append-only and capped.** Autosave writes a revision at most once per
90 seconds per post; a retention job trims each post to its most recent 50 revisions
plus every revision tagged `published`.

**FTS is populated by trigger** on `posts` insert/update/delete. If FTS proves awkward
on D1, the fallback is `LIKE` over `title` and `excerpt`, which is acceptable at the
scale a single site's blog operates at.

---

## 4. Object storage (R2)

R2 holds everything that is not a row. Keys are content-addressed to make uploads
idempotent and caching safe:

```
media/<yyyy>/<mm>/<sha256-first-16>-<sanitised-filename>     original upload
media/<yyyy>/<mm>/<sha256-first-16>-<width>w.<ext>           derived variant
avatars/<author-id>.<ext>                                    author avatars
exports/<iso-date>-backup.json                               scheduled content exports
```

Because the key contains a hash of the content, an object at a given key never changes.
Public media is served through the Worker at `/media/<key>` with
`Cache-Control: public, max-age=31536000, immutable`. The R2 bucket itself is never
made publicly readable — all access goes through the Worker, so the public hostname
can enforce that only keys referenced by a published post are reachable if that
becomes a requirement.

**Uploads** go through the Worker rather than a presigned URL. Uploads are editor-sized
and infrequent, the Worker already has the Access identity in hand, and proxying lets
it validate content type, enforce a size cap, compute the checksum for the key, and
write the `media` row in the same request. Presigned direct-to-R2 uploads are the
escape hatch if large-file support is ever needed.

**Image variants** are generated lazily: a request for a width that does not exist yet
is resized via Cloudflare Images (or `fetch` with `cf.image` options), written back to
R2 under the derived key, and returned. Subsequent requests hit R2 directly.

---

## 5. Caching

| Response | Policy |
| --- | --- |
| Public HTML pages | `public, max-age=60, s-maxage=3600, stale-while-revalidate=86400` |
| Public `/api/*` JSON | `public, max-age=30, s-maxage=300` |
| `/media/*` | `public, max-age=31536000, immutable` |
| `feed.xml`, `sitemap.xml` | `public, max-age=600, s-maxage=3600` |
| Anything on `blog-admin.*` | `private, no-store` |
| Static assets (hashed) | handled by Workers static assets |

Any mutation on the admin side purges the edge cache for the affected URLs — the post
permalink, the home page, the archive, each affected tag page, and the feed — through
the Cache API. Purge is best-effort and runs in `ctx.waitUntil()`; the short `s-maxage`
is the backstop if a purge fails, so a missed purge costs staleness measured in
minutes, never permanent staleness.

---

## 6. Security model

**Cloudflare Access is the front door, not the only lock.** Access authenticates users
at the edge and no unauthenticated request reaches the admin Worker. The Worker
nonetheless verifies the `Cf-Access-Jwt-Assertion` header on every admin request:
signature against the team JWKS at
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` equal to the Access
application AUD tag, and `exp`/`iat` in range. Without the `aud` check, a JWT minted
for any other application in the same Access team would be accepted — this is the
single most commonly skipped step in an Access integration. JWKS responses are cached
in memory with a short TTL.

**Authorization is role-based**, resolved from the `authors` row matching the verified
email:

| Action | owner | editor | author |
| --- | --- | --- | --- |
| Create / edit own drafts | ✓ | ✓ | ✓ |
| Edit others' posts | ✓ | ✓ | — |
| Publish / unpublish | ✓ | ✓ | — |
| Delete post | ✓ | ✓ | — |
| Upload media | ✓ | ✓ | ✓ |
| Delete media | ✓ | ✓ | — |
| Change settings, manage authors | ✓ | — | — |

An identity that passes Access but has no `authors` row gets `403`, not an implicit
account. Provisioning is explicit.

**MCP inherits the same checks.** `/mcp` runs the same JWT verification and the same
role table, and records `via = 'mcp'` in the audit log. An agent can never do something
its human operator could not.

**Content safety.** Markdown is rendered server-side with an escaping-first renderer
and raw HTML disabled by default. If raw HTML is enabled in settings, output is
sanitised against an allow-list before it is stored in `body_html`. Since rendering
happens on write, a sanitiser bug is contained to the posts written while it was live
and is fixed by a re-render migration.

**Other measures.** All write endpoints require `Content-Type: application/json` and a
same-origin `Origin` header. Per-identity rate limits on writes and uploads. Upload
size cap and content-type allow-list. Every mutation writes to `audit_log`. No secrets
are ever sent to the browser — the admin front end holds no API keys, because the
Access cookie is the credential.

---

## 7. Front-end conventions

No framework, no build step. That is a constraint worth keeping honest:

- **Progressive rendering.** Every page is complete HTML with a semantic skeleton;
  JavaScript fills in content. Pages that can be server-rendered in Phase 3 will be.
- **One small module per page**, plus shared `api.js` / `markdown.js` / `main.js`.
  ES modules, loaded with `type="module"` — no globals, no load-order coupling.
- **Design tokens in `:root`**, defined once in `styles.css`. `admin.css` extends the
  same tokens rather than redefining colours. Light and dark are both first-class via
  `prefers-color-scheme`, with an explicit override persisted to `localStorage`.
- **The API client degrades.** `api.js` tries `/api/*` first; if the backend is absent
  it falls back to `demo-data.js` for the rest of the session and flags the page as
  demo. This is what lets the Phase 1 prototype be genuinely usable, and it disappears
  on its own when the API ships.
- **No innerHTML with untrusted data.** DOM is built with `document.createElement` and
  `textContent`. The one exception is rendered post HTML, which is inserted through a
  single reviewed code path.
- **Accessibility is not a later phase.** Semantic landmarks, visible focus rings,
  labelled controls, keyboard-reachable menus, `prefers-reduced-motion` respected.
