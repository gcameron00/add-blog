-- Generic "collections" (custom content type) mechanism — see
-- docs/vibecode-migration.md for the full design rationale. A collection
-- (e.g. "project") is site config, not schema: it lives in the `settings`
-- row seeded below, same key/value mechanism as nav_config/about_content
-- (migrations/0007_nav_config.sql).
--
-- `post_type`/`type_fields` are added to `posts` rather than a parallel
-- table, deliberately — a parallel table would need its own FK/trigger set
-- mirroring post_tags, revisions and posts_fts, all for a "second kind of
-- post" that otherwise wants every existing post mechanism (slug
-- uniqueness, status/visibility, cover image, publish/schedule, revisions,
-- cache purge) as-is. Overloading `posts` gets all of that for free.
--
-- No CHECK on post_type — per docs/deployment.md's migration discipline,
-- SQLite can't widen a CHECK in place (0003_audit_via_cron.sql had to
-- rebuild the whole table for that), and the set of valid post_types is
-- meant to grow per-site as an owner adds collections, not per-migration.
-- Validated in application code instead (src/validate.js's
-- validatePostType, checked against the site's own collections registry).
ALTER TABLE posts ADD COLUMN post_type   TEXT NOT NULL DEFAULT 'post';
ALTER TABLE posts ADD COLUMN type_fields TEXT;   -- JSON object, NULL for blog posts

CREATE INDEX idx_posts_type_published ON posts(post_type, status, published_at DESC);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('collections', '[]', '2026-09-01T00:00:00Z');
