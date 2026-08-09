-- Owner-configurable header/footer nav + About page content
-- (src/site-template.js's resolveNavConfig, src/pages.js's handleAboutPage).
-- Both are `settings` rows, not new schema — same key/value store every
-- other setting already lives in, seeded here purely so the admin Settings
-- page shows real, editable defaults on first load rather than an empty
-- state, same as 0004_mcp.sql's style_guide seed. resolveNavConfig already
-- merges under its own defaults if this row is ever missing, so this seed
-- is a nicety, not a hard dependency.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (
  'nav_config',
  '{"features":{"posts":{"header":true},"archive":{"enabled":true,"header":true,"footer":true},"tags":{"enabled":true,"header":true,"footer":false},"about":{"enabled":true,"header":true,"footer":true},"rss":{"enabled":true,"header":false,"footer":true}},"custom_links":[]}',
  '2026-08-09T00:00:00Z'
);
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('about_content', '""', '2026-08-09T00:00:00Z');
