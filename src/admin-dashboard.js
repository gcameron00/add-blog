/**
 * Admin dashboard reads (Phase 5b) — docs/api.md's `GET /stats` and
 * `GET /audit`. `assets/js/admin.js`'s dashboard page has called both since
 * Phase 1. `views` comes from src/views.js's post_views counts (#18) — posts
 * and collection items together — and is null rather than a 500 if a site
 * hasn't applied migrations/0009_post_views.sql yet, so the rest of the
 * dashboard keeps working in between deploying the Worker and the migration.
 */

import { apiFail, withErrors } from './admin-http.js';
import { VIEW_SORTS, firstViewDay, postViewStats, resolveViewRange, viewSeries, viewStats, viewTotals } from './views.js';

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
  const views = await viewTotals(db).catch(() => null);

  return Response.json({
    data: {
      published,
      draft,
      scheduled,
      archived,
      words: wordsRow?.total || 0,
      media: mediaRow?.n || 0,
      next_scheduled: nextScheduled || null,
      views,
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

/**
 * GET /api/admin/stats/views — the /admin/stats/ page's per-page table
 * (src/views.js's viewStats). `range` is a preset or `custom` with
 * `from`/`to`; `sort`/`order` pick from a fixed list. Answers `data: null`
 * rather than a 500 on a site without migrations/0009_post_views.sql, same
 * posture as `views` on GET /stats.
 */
async function viewStatsHandler(url, env) {
  const q = url.searchParams;
  const sort = q.get('sort') || 'views';
  if (!VIEW_SORTS.includes(sort)) apiFail(400, 'bad_request', `sort must be one of ${VIEW_SORTS.join(', ')}.`, { field: 'sort' });
  const order = q.get('order') || undefined;
  if (order && order !== 'asc' && order !== 'desc') apiFail(400, 'bad_request', 'order must be asc or desc.', { field: 'order' });
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
  const offset = Math.max(0, Number(q.get('offset')) || 0);

  let firstDay;
  try {
    firstDay = await firstViewDay(env.DB);
  } catch {
    return Response.json({ data: null });
  }
  const range = resolveViewRange(
    { range: q.get('range') || '30d', from: q.get('from'), to: q.get('to') },
    { firstDay }
  );
  const type = q.get('type') || 'all';
  const [result, series] = await Promise.all([
    viewStats(env.DB, range, { type, sort, order, limit, offset }),
    // Only the first page draws the chart; "Load more" just appends rows.
    offset === 0 ? viewSeries(env.DB, range, { type }) : null,
  ]);
  return Response.json({ range, ...result, ...(series ? { series } : {}) });
}

/**
 * GET /api/admin/stats/views/:id — one page's view counts for the stats
 * page's single-page view. Same `range`/`from`/`to` as the list, same
 * `data: null` posture without migration 0009; 404 for an unknown id.
 */
async function postViewStatsHandler(url, env, id) {
  const q = url.searchParams;
  let firstDay;
  try {
    firstDay = await firstViewDay(env.DB);
  } catch {
    return Response.json({ data: null });
  }
  const range = resolveViewRange(
    { range: q.get('range') || '30d', from: q.get('from'), to: q.get('to') },
    { firstDay }
  );
  const result = await postViewStats(env.DB, id, range);
  if (!result) apiFail(404, 'not_found', 'No post with that id.');
  const { post, ...rest } = result;
  return Response.json({ range, data: post, ...rest });
}

export async function handleDashboardApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity) return null;
  if (request.method !== 'GET') return null;

  if (url.pathname === '/api/admin/stats') return withErrors(() => statsHandler(env));
  if (url.pathname === '/api/admin/stats/views') return withErrors(() => viewStatsHandler(url, env));
  const postViews = url.pathname.match(/^\/api\/admin\/stats\/views\/([^/]+)$/);
  if (postViews) return withErrors(() => postViewStatsHandler(url, env, postViews[1]));
  if (url.pathname === '/api/admin/audit') return withErrors(() => auditHandler(url, env));
  return null;
}
