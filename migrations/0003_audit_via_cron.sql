-- Phase 5f (cron). Widens audit_log.via's CHECK to add 'cron' — the sweep
-- that auto-publishes due `scheduled` posts has no human actor, so it
-- writes actor='system', via='cron'. SQLite can't ALTER a CHECK constraint
-- in place, so this is the standard rebuild: new table, copy rows, swap
-- names, restore the index.
CREATE TABLE audit_log_new (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  via        TEXT NOT NULL
             CHECK (via IN ('ui','mcp','api','cron')),
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
