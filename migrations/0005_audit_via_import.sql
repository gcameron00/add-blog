-- WordPress WXR import. Content created by the importer has no human actor
-- clicking through the editor, so it writes via='import' rather than 'ui' --
-- same reasoning as 0003's 'cron' addition. SQLite can't ALTER a CHECK
-- constraint in place, so this is the same rebuild: new table, copy rows,
-- swap names, restore the index.
CREATE TABLE audit_log_new (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  via        TEXT NOT NULL
             CHECK (via IN ('ui','mcp','api','cron','import')),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO audit_log_new SELECT * FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
