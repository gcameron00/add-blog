-- Privacy-preserving page-view counts (#18) — src/views.js writes, the admin
-- dashboard (src/admin-dashboard.js) reads.
--
-- Aggregate only: one row per post per UTC day, holding a count (`views`). No visitor
-- identifier, IP, user agent or finer timestamp is ever stored, so there is
-- nothing here to de-anonymise. "Post" means any `posts` row — blog posts and
-- collection items (post_type != 'post') alike.
--
-- Its own table rather than a column on `posts`, deliberately: view
-- increments come from an anonymous endpoint, and must never touch the row
-- whose `updated_at` is the editor's ETag/If-Match conflict token, or sit one
-- careless SELECT away from the public API's post JSON. ON DELETE CASCADE
-- cleans up on a hard delete, same as post_tags/revisions.
CREATE TABLE post_views (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,              -- UTC, YYYY-MM-DD
  views   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, day)
);

CREATE INDEX idx_post_views_day ON post_views(day);
