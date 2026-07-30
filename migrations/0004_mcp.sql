-- Phase 6 (MCP). Two additions:
--
-- `mcp_sessions` backs the Streamable HTTP session id docs/mcp.md's Transport
-- section describes: the Worker is stateless between requests, so whatever a
-- client's `Mcp-Session-Id` header refers to has to be reconstructed from D1
-- on every request rather than held in memory, which doesn't survive an
-- isolate recycling. `actor` is the email the session was opened for — a
-- session presented by anyone else is invalid, not just "someone else's",
-- since two identities are never allowed to share one session id.
--
-- `style_guide` is a `settings` row, not a new table — it slots into the
-- existing key/value store src/admin-settings.js already manages, seeded
-- empty so a site that hasn't written one yet gets an empty string back from
-- `blog://style-guide` rather than a missing key.
CREATE TABLE mcp_sessions (
  id            TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX idx_mcp_sessions_actor ON mcp_sessions(actor);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('style_guide', '""', '2026-07-30T00:00:00Z');
