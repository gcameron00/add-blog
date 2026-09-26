/**
 * Privacy-preserving view counts (#18) — `POST /api/pagecounter`, plus the totals
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

// Deliberately neutral: this was /api/track, and content blockers' generic
// filter-list rules (EasyPrivacy and the like) match "track" in any URL, so
// readers with a blocker were never counted — even though nothing here
// tracks anyone. The Cloudflare rate-limiting rule matches this path too
// (docs/deployment.md); change both together.
export const COUNTER_PATH = '/api/pagecounter';

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
 * Resolves to whether a view was counted.
 */
export async function recordView(db, slug, day = utcDay()) {
  const result = await db
    .prepare(`
      INSERT INTO post_views (post_id, day, views)
      SELECT p.id, ?, 1 FROM posts p
      WHERE p.slug = ? AND p.status = 'published'
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'analytics_enabled' AND value = 'true')
      ON CONFLICT (post_id, day) DO UPDATE SET views = views + 1
    `)
    .bind(day, slug)
    .run();
  return (result?.meta?.changes || 0) > 0;
}

/**
 * Whether a beacon demonstrably came from another site. Browsers send Origin
 * on every cross-origin POST, so a foreign Origin is the real signal. A
 * missing one isn't: not every engine is guaranteed to attach Origin to a
 * same-origin sendBeacon, and rejecting those silently lost real views
 * (#18 follow-up). Sec-Fetch-Site, where sent, is the fallback check.
 */
function isCrossSite(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin !== url.origin;
  const site = request.headers.get('Sec-Fetch-Site');
  return Boolean(site) && site !== 'same-origin';
}

// One line per beacon that isn't counted, so the real-time Workers log shows
// why — the response is deliberately the same 204 either way.
function logIgnored(reason, slug) {
  console.log(JSON.stringify({ event: 'track_view_ignored', reason, ...(slug ? { slug } : {}) }));
}

/** POST /api/pagecounter. Returns null for any other path or method. */
export async function handleTrackView(request, url, env, admin) {
  if (url.pathname !== COUNTER_PATH || request.method !== 'POST') return null;
  // An editor reading a post on the admin host isn't a reader.
  if (admin || !env.DB) return noContent();
  // Stops another site inflating counts through its visitors' browsers. Not
  // flood protection — anything can forge a header; that's the rate-limit
  // rule's job (docs/deployment.md).
  if (isCrossSite(request, url)) {
    logIgnored('cross_site');
    return noContent();
  }

  const slug = await readSlug(request);
  if (!slug) {
    logIgnored('bad_body');
    return noContent();
  }

  try {
    // Not counted: unknown or unpublished slug, or analytics_enabled is off.
    if (!(await recordView(env.DB, slug))) logIgnored('not_counted', slug);
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
