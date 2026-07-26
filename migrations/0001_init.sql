-- Schema per docs/architecture.md §3. Additive-only from here on — see
-- docs/deployment.md §7 on why (an old Worker version has to keep running
-- against a newer schema during a rollout).

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

-- Full-text search over published content. An external-content FTS5 table
-- indexes posts without duplicating body_md — but that means it is only
-- ever as fresh as these triggers keep it; per docs/architecture.md §3
-- ("FTS is populated by trigger"), not by anything at query time.
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
