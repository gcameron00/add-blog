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
  │     ├─ /api/*                    → public JSON API, same handler as the public host
  │     │                               (published-only either way — see the note below)
  │     └─ everything else           → static assets (admin UI)
  │
  └─ hostname == blog.*  (or anything else)
        ├─ /admin/*, /api/admin/*, /mcp   → 404, always, no exceptions
        ├─ /api/*                          → public JSON API (published posts only)
        ├─ /feed.xml, /rss.xml             → RSS
        ├─ /sitemap.xml                    → sitemap
        ├─ /media/<key>                    → R2 object, immutable cache
        ├─ /posts/<slug>                   → server-rendered post: real title/meta/OG
        │                                     tags and article body, hydrated on top
        └─ everything else                 → static assets (public UI)
```

The `404` branch for admin paths on the public hostname is deliberately the *first*
check, not the last. It should be a literal prefix test at the top of the handler with
no dependency on any other state.

> **Built vs. as-specified (Phase 3):** the "unfiltered by status" admin-host behaviour
> sketched above was never actually implemented — the same published-only handler
> answers `/api/*` on both hostnames. Nothing needs the unfiltered form yet: the admin
> UI calls `/api/admin/*`, not `/api/*`. Revisit if that changes.

### Static assets and dynamic paths (Phase 3, built)

The static asset bundle cannot express `/posts/<slug>` as a real file, so the Worker
matches it directly (`src/pages.js`): loads the post from D1 and returns real HTML —
correct `<title>`, meta description and Open Graph tags, and the article body itself,
not just a shell. Works with JavaScript disabled; `assets/js/post.js` still hydrates on
top of it.

`/post/?slug=my-post` — the Phase 1 query-parameter form, which is what an assets-only
deployment had to use — now 301s to the canonical `/posts/<slug>` permalink, so no
existing link breaks. Every internal link generator (`blog.js`, `post.js`, `admin.js`,
`editor.js`) points at the canonical form directly rather than round-tripping the
redirect.

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

-- Full-text search over published content. External-content FTS5 indexes
-- posts without duplicating body_md, but is then only ever as fresh as these
-- triggers keep it — nothing populates it at query time.
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title, excerpt, body_md,
  content = 'posts', content_rowid = 'rowid'
);

CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, excerpt, body_md) VALUES (new.rowid, new.title, new.excerpt, new.body_md);
END;

CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, excerpt, body_md) VALUES ('delete', old.rowid, old.title, old.excerpt, old.body_md);
END;

CREATE TRIGGER posts_fts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, excerpt, body_md) VALUES ('delete', old.rowid, old.title, old.excerpt, old.body_md);
  INSERT INTO posts_fts(rowid, title, excerpt, body_md) VALUES (new.rowid, new.title, new.excerpt, new.body_md);
END;
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

> **Built vs. as-specified (Phase 5):** `POST /:id/schedule` sets `status='scheduled'`
> and is live-tested; the Cron Trigger described above that promotes it to `published`
> on its own is not built yet — see the "Owner action required" note on the cron
> trigger in [implementation-plan.md](implementation-plan.md)'s Phase 5 section. A
> scheduled post today stays `scheduled` until someone calls `/publish` by hand.

**Revisions are append-only.** Every save that changes `title` or `body_md` writes a
revision (`src/admin-posts.js`) — including autosave calls from the editor, since
there's no separate "this was an autosave" endpoint to throttle against, unlike the
90-second-interval/50-revision-cap scheme originally sketched here. The retention job
that would cap revision count per post needs the same Cron Trigger as scheduled
publishing, so it's queued alongside it, not built.

**FTS is populated by trigger** on `posts` insert/update/delete. If FTS proves awkward
on D1, the fallback is `LIKE` over `title` and `excerpt`, which is acceptable at the
scale a single site's blog operates at.

---

## 4. Object storage (R2)

R2 holds everything that is not a row. Keys are content-addressed to make uploads
idempotent and caching safe. The bucket is already scoped to one site's media (the
bucket name itself carries that), so upload keys don't repeat a "media/" segment —
that's the URL route prefix (`/media/<key>`, below), not part of the stored key;
`avatars/` and `exports/` are the two sub-namespaces sharing the bucket with plain
uploads:

```
<yyyy>/<mm>/<sha256-first-16>-<sanitised-filename>            original upload
<yyyy>/<mm>/<sha256-first-16>-<width>w.<ext>                  derived variant
avatars/<author-id>.<ext>                                    author avatars
exports/<iso-date>-backup.json                               scheduled content exports
```

So a cover image's `cover_key` column (§3) holds `2026/07/<hash>-cover.jpg`, and its
public URL — `cover_key` with the route prefix applied — is
`/media/2026/07/<hash>-cover.jpg` (matches the example in [api.md](api.md)). `src/db.js`
already builds URLs this way for Phase 3's read path; Phase 5's upload code — still
queued, not built (see implementation-plan.md) — is what has to write keys matching it.
A post's `cover_key`/`cover_alt` fields are already settable through `PATCH
/api/admin/posts/:id`, so an editor can point a post at *existing* R2 objects (e.g.
ones uploaded outside the admin UI for now) even before upload itself ships.

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

> **Not built yet:** everything in this section (uploads and variants) is still queued
> — see Phase 5's breakdown in [implementation-plan.md](implementation-plan.md). Reads
> (`GET /media/:key`) are built and live (Phase 3); writing new objects into R2 through
> the admin UI is not.

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

> **Built (Phase 5):** `src/cache-purge.js` implements exactly this — `caches.default`,
> no Cloudflare API token needed, called from `ctx.waitUntil()` after any mutation that
> touches a published post. It purges the deterministic URLs listed above; it cannot
> enumerate every filtered `/api/posts?tag=…&q=…` combination a client might have
> cached, which is why those variants' short `max-age`/`s-maxage` still matters as the
> real backstop, not just a fallback for purge failures.

---

## 6. Security model

> **Built vs. as-specified (Phase 4 + 5):** the JWT verification, `authors` resolution
> and role table below are implemented (`src/access.js`, `src/auth.js`) and live for
> `gcameron`, verified against the real Access application. Role-gated *write* actions
> are implemented too, for posts specifically (`src/admin-posts.js`) — tested against
> every row of the table below and verified live in production. Tags/media/settings/
> authors writes don't exist yet (still Phase 5, queued) — see
> [implementation-plan.md](implementation-plan.md).

**Cloudflare Access is the front door, not the only lock.** Access authenticates users
at the edge and no unauthenticated request reaches the admin Worker. The Worker
nonetheless verifies the `Cf-Access-Jwt-Assertion` header on every admin request:
signature against the team JWKS at
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` equal to the Access
application AUD tag, and `exp`/`iat` in range. Without the `aud` check, a JWT captured
from a *different* application in the same Access team — e.g. lifted from a request to
some other, less sensitive tool — could be replayed straight at blog-admin and accepted
as if it were real. This is not about the normal case of an already-authenticated user
silently getting a fresh, correctly-scoped token when they visit a new application (that
carry-over is Access working as intended); it's about a token minted for one application
never being valid proof of authorization for another one, however it was obtained. `aud`
is the single most commonly skipped step in an Access integration. JWKS responses are
cached in memory with a short TTL.

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
  JavaScript fills in content. `/posts/<slug>` is server-rendered as of Phase 3; the
  list/archive/tag pages stay shell-plus-hydration (JSON is cheaper to cache and
  paginate than HTML, and these pages don't carry the same per-URL SEO/OG weight a
  permalink does).
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
