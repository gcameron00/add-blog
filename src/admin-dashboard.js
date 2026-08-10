/**
 * Admin dashboard reads (Phase 5b) — docs/api.md's `GET /stats` and
 * `GET /audit`. `assets/js/admin.js`'s dashboard page has called both since
 * Phase 1; no "views" figure is included since nothing in this Worker
 * collects page views yet regardless of the `analytics_enabled` setting —
 * that setting is stored, not acted on.
 */

import { withErrors } from './admin-http.js';

async function countPostsByStatus(db, status) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = ?`).bind(status).first();
  return row?.n || 0;
}

async function statsHandler(env) {
  const db = env.DB;
  const [published, draft, scheduled, archived] = await Promise.all(
    ['published', 'draft', 'scheduled', 'archived'].map((status) => countPostsByStatus(db, status))
  );
  const wordsRow = await db.prepare(`SELECT COALESCE(SUM(word_count), 0) AS total FROM posts`).first();
  const mediaRow = await db.prepare(`SELECT COUNT(*) AS n FROM media`).first();
  const nextScheduled = await db
    .prepare(`SELECT title, scheduled_for FROM posts WHERE status = 'scheduled' ORDER BY scheduled_for ASC LIMIT 1`)
    .first();

  return Response.json({
    data: {
      published,
      draft,
      scheduled,
      archived,
      words: wordsRow?.total || 0,
      media: mediaRow?.n || 0,
      next_scheduled: nextScheduled || null,
    },
  });
}

/**
 * `detail` is stored as JSON (see src/audit.js); the dashboard activity feed
 * wants one human-readable line, not the raw object. `title`/`slug`/`name`/
 * `email`/`filename` are the identifying fields each write site logs
 * (src/admin-posts.js, admin-authors.js, admin-tags.js, admin-media.js);
 * `keys`/`from`+`into` cover settings.update and tag.merge. Anything else
 * (a fields-only update, e.g. author.update's `{role: 'editor'}`) falls
 * back to listing the changed fields rather than showing nothing.
 */
function summariseDetail(detailJson) {
  if (!detailJson) return '';
  let parsed;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return '';
  }
  if (parsed.title) return parsed.title;
  if (parsed.slug) return parsed.slug;
  if (parsed.name) return parsed.name;
  if (parsed.email) return parsed.email;
  if (parsed.filename) return parsed.filename;
  if (parsed.from && parsed.into) return `${parsed.from} → ${parsed.into}`;
  if (parsed.keys) return parsed.keys.join(', ');
  return Object.entries(parsed)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

async function auditHandler(url, env) {
  const q = url.searchParams;
  const where = [];
  const params = [];
  for (const key of ['actor', 'action', 'via']) {
    const value = q.get(key);
    if (value) {
      where.push(`${key} = ?`);
      params.push(value);
    }
  }
  const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 20));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // `entity`/`entity_id` weren't selected before #12 — the dashboard's 7-row
  // widget never needed them, but the full /admin/audit/ page links a row
  // back to the actual post/tag/author/etc they're about, same idea as
  // `listAdminPosts`'s `page` envelope (src/admin-db.js) for "Load more".
  const [{ total }, { results }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`).bind(...params).first().then((r) => r || { total: 0 }),
    env.DB
      .prepare(`SELECT actor, via, action, entity, entity_id, detail, created_at FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all(),
  ]);

  return Response.json({
    data: results.map((row) => ({
      at: row.created_at,
      actor: row.actor,
      via: row.via,
      action: row.action,
      entity: row.entity,
      entity_id: row.entity_id,
      detail: summariseDetail(row.detail),
    })),
    page: { limit, offset, total, has_more: offset + results.length < total },
  });
}

export async function handleDashboardApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity) return null;
  if (request.method !== 'GET') return null;

  if (url.pathname === '/api/admin/stats') return withErrors(() => statsHandler(env));
  if (url.pathname === '/api/admin/audit') return withErrors(() => auditHandler(url, env));
  return null;
}
