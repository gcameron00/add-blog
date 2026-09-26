/**
 * Privacy-preserving view counts (#18) — `POST /api/track`, plus the totals
 * the admin dashboard reads. Backs the "Count page views" setting
 * (`analytics_enabled`): aggregate counts only, no cookies, no third-party
 * scripts.
 *
 * Counted client-side, not at render time: pages are served from the edge
 * cache (src/edge-cache.js), so src/pages.js's handlers only run on a miss,
 * and counting every GET in src/index.js instead would count every crawler
 * and link unfurler too. The server marks a countable page with
 * `data-view="<slug>"` (post permalinks and collection item pages only), and
 * assets/js/main.js sends one same-origin `navigator.sendBeacon` for it. Most
 * bots never run JavaScript, so they never get this far.
 *
 * This is the one anonymous write path into D1. It's kept cheap and inert:
 * one statement per view, a tiny body cap, and always the same empty 204 —
 * a visitor's browser never sees an error, and a caller learns nothing about
 * which slugs exist or whether counting is on. Flood protection belongs in
 * front of the Worker (a Cloudflare rate-limiting rule on this path —
 * docs/deployment.md), not in here.
 */

export const TRACK_PATH = '/api/track';

// `{"slug":"…"}` for any real slug fits in far less than this.
const MAX_BODY_BYTES = 512;
const MAX_SLUG_LENGTH = 200;

/** Today's UTC date, `YYYY-MM-DD` — the only time resolution ever stored. */
export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function noContent() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** The `slug` from a beacon body, or null for anything malformed or oversized. */
async function readSlug(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return null;
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const slug = body?.slug;
  return typeof slug === 'string' && slug.length > 0 && slug.length <= MAX_SLUG_LENGTH ? slug : null;
}

/**
 * Adds one view for `slug` on `day` — a single statement that writes nothing
 * unless the slug is a published post or collection item (unlisted included:
 * its link still works) and `analytics_enabled` is on. Settings values are
 * stored JSON-encoded (src/admin-settings.js's writeSettings), so the
 * checkbox's `true` is the literal text `true`; a missing row counts as off.
 */
export async function recordView(db, slug, day = utcDay()) {
  await db
    .prepare(`
      INSERT INTO post_views (post_id, day, views)
      SELECT p.id, ?, 1 FROM posts p
      WHERE p.slug = ? AND p.status = 'published'
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'analytics_enabled' AND value = 'true')
      ON CONFLICT (post_id, day) DO UPDATE SET views = views + 1
    `)
    .bind(day, slug)
    .run();
}

/** POST /api/track. Returns null for any other path or method. */
export async function handleTrackView(request, url, env, admin) {
  if (url.pathname !== TRACK_PATH || request.method !== 'POST') return null;
  // An editor reading a post on the admin host isn't a reader.
  if (admin || !env.DB) return noContent();
  // Browsers always send Origin on a POST, sendBeacon included. Requiring our
  // own stops another site from inflating counts through its visitors'
  // browsers, and drops the laziest scripted calls; it isn't flood
  // protection — anything can forge a header.
  if (request.headers.get('Origin') !== url.origin) return noContent();

  const slug = await readSlug(request);
  if (!slug) return noContent();

  try {
    await recordView(env.DB, slug);
  } catch (err) {
    // e.g. migrations/0009_post_views.sql not applied yet on this site —
    // a lost count, never a visible error.
    console.log(JSON.stringify({ event: 'track_view_failed', message: String(err?.message || err) }));
  }
  return noContent();
}

/**
 * All-time and last-30-days totals across every post and collection item,
 * for GET /api/admin/stats. The 30 days include today.
 */
export async function viewTotals(db, today = new Date()) {
  const since = utcDay(new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000));
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(views), 0) AS total,
             COALESCE(SUM(CASE WHEN day >= ? THEN views END), 0) AS last_30_days
      FROM post_views
    `)
    .bind(since)
    .first();
  return { total: row?.total || 0, last_30_days: row?.last_30_days || 0 };
}
