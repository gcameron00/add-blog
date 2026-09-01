/**
 * Admin Settings API (Phase 5b) — docs/api.md's `GET`/`PUT /settings`.
 * `assets/js/admin.js`'s settings page has called both since Phase 1; this
 * is what makes it real instead of demo-store-backed.
 *
 * The key set below is the *actual* union of what's seeded
 * (migrations/seed.sql) and what the settings form
 * (admin/settings/index.html) submits — not quite the list in docs/api.md's
 * prose, which has `theme_accent` (nothing seeds, stores or reads it) and is
 * missing `admin_url` (the form has a real field for it). Reconciled here
 * rather than left to drift, since a stricter allow-list than what the
 * shipped form actually sends would make "Save settings" 400 in production.
 */

import { getSettings } from './db.js';
import { readJsonBody, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { writeAuditLog } from './audit.js';
import { ValidationError, validateNavConfig, validateAboutContent, validateCollections } from './validate.js';
import { purgeBrandedPages } from './cache-purge.js';

// Keys src/site-template.js's applySiteBranding/applyHomeMeta actually
// render — the only ones where a stale edge-cached page is visibly wrong.
// nav_config renders on every public page (header+footer); about_content is
// /about/'s body — both edited here, so both belong in this set too.
// site_icon_key (#15) brands the favicon and header mark the same way.
// collections (migrations/0008) renders into the header/footer nav
// (src/site-template.js) same as nav_config, so a change there needs the
// same purge.
const BRANDING_KEYS = new Set(['site_title', 'site_description', 'admin_url', 'nav_config', 'about_content', 'site_icon_key', 'collections']);

// Exported so src/mcp-tools.js's `update_site_settings` validates against
// the exact same allow-list — one list, not two that can drift apart.
export const KNOWN_KEYS = new Set([
  'site_title',
  'site_description',
  'site_url',
  'admin_url',
  'base_path',
  'timezone',
  'posts_per_page',
  'allow_raw_html',
  'feed_full_content',
  'analytics_enabled',
  'social_image_key',
  'site_icon_key',
  // Phase 6 — the source `blog://style-guide` reads from (docs/mcp.md). A
  // settings key, not new schema: it's owner-managed the same way every
  // other value here is, just consumed by an MCP resource instead of a
  // public page.
  'style_guide',
  // Owner-configurable header/footer nav (src/site-template.js's
  // resolveNavConfig) and the About page's markdown body
  // (src/pages.js's handleAboutPage) — the first JSON-object-valued
  // settings, still stored the same key/value way as every scalar above.
  'nav_config',
  'about_content',
  // migrations/0008_collections.sql — the site's custom-content-type
  // registry (src/collections.js's resolveCollections is what interprets
  // it). Seeded to '[]' by that migration, same "feature is off until an
  // owner writes something" posture as nav_config/about_content above.
  'collections',
]);

/**
 * Validates and writes a partial settings update, shared by the REST route
 * below and src/mcp-tools.js's `update_site_settings` — the permission check
 * and the audit-log `via` differ per caller, so those stay with the caller
 * rather than living in here.
 */
export async function writeSettings(db, input) {
  const unknown = Object.keys(input).find((key) => !KNOWN_KEYS.has(key));
  if (unknown) throw new ValidationError(`Unknown setting key: "${unknown}".`, unknown);

  if ('nav_config' in input) validateNavConfig(input.nav_config);
  if ('about_content' in input) validateAboutContent(input.about_content);
  if ('collections' in input) validateCollections(input.collections);

  const entries = Object.entries(input);
  if (entries.length) {
    const now = new Date().toISOString();
    await db.batch(
      entries.map(([key, value]) =>
        db
          .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .bind(key, JSON.stringify(value), now)
      )
    );
  }

  return getSettings(db);
}

async function putSettings(request, env, ctx, identity) {
  requirePermission(identity, 'settings.manage');
  const input = await readJsonBody(request);
  const updated = await writeSettings(env.DB, input);
  if (Object.keys(input).length) {
    await writeAuditLog(env.DB, {
      actor: identity.email, via: 'ui', action: 'settings.update', entity: 'settings', detail: { keys: Object.keys(input) },
    });
    if (Object.keys(input).some((key) => BRANDING_KEYS.has(key))) {
      ctx.waitUntil(purgeBrandedPages(`https://${env.PUBLIC_HOST}`));
    }
  }
  return Response.json({ data: updated });
}

export async function handleSettingsApi(request, url, ctxBundle) {
  if (url.pathname !== '/api/admin/settings') return null;
  const { env, ctx, identity } = ctxBundle;
  if (!identity) return null;

  return withErrors(async () => {
    if (request.method === 'GET') return Response.json({ data: await getSettings(env.DB) });
    if (request.method === 'PUT') {
      requireSameOrigin(request, url);
      return putSettings(request, env, ctx, identity);
    }
    return null;
  });
}
