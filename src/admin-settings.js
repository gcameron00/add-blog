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
import { apiError, readJsonBody, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { writeAuditLog } from './audit.js';

const KNOWN_KEYS = new Set([
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
]);

async function putSettings(request, env, identity) {
  requirePermission(identity, 'settings.manage');
  const input = await readJsonBody(request);

  const unknown = Object.keys(input).find((key) => !KNOWN_KEYS.has(key));
  if (unknown) {
    return apiError(400, 'bad_request', `Unknown setting key: "${unknown}".`, { field: unknown });
  }

  const entries = Object.entries(input);
  if (entries.length) {
    const now = new Date().toISOString();
    await env.DB.batch(
      entries.map(([key, value]) =>
        env.DB
          .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .bind(key, JSON.stringify(value), now)
      )
    );
    await writeAuditLog(env.DB, {
      actor: identity.email, via: 'ui', action: 'settings.update', entity: 'settings', detail: { keys: Object.keys(input) },
    });
  }

  return Response.json({ data: await getSettings(env.DB) });
}

export async function handleSettingsApi(request, url, ctxBundle) {
  if (url.pathname !== '/api/admin/settings') return null;
  const { env, identity } = ctxBundle;
  if (!identity) return null;

  return withErrors(async () => {
    if (request.method === 'GET') return Response.json({ data: await getSettings(env.DB) });
    if (request.method === 'PUT') {
      requireSameOrigin(request, url);
      return putSettings(request, env, identity);
    }
    return null;
  });
}
