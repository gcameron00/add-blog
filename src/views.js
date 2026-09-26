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

// Deliberately neutral: this was /api/track, and blockers' generic filter-list
// rules (EasyPrivacy and the like) match "track" in any URL. The rename only
// gets past those URL rules, though: a blocker that drops every sendBeacon
// request regardless of URL still stops it (confirmed with a Safari extension),
// so readers running one aren't counted — an accepted limit. The Cloudflare
// rate-limiting rule matches this path too (docs/deployment.md); change both
// together.
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

/* --- Stats page (/admin/stats/) ------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling presets count back from today (UTC) inclusive, like viewTotals'
// 30 days. `ytd` and `all` are anchored instead; `custom` takes from/to.
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };
export const VIEW_RANGES = [...Object.keys(RANGE_DAYS), 'ytd', 'all', 'custom'];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A decade and a bit — a sane cap on a custom range, far past any real one.
const MAX_RANGE_DAYS = 3700;

function parseDay(value, field) {
  if (typeof value !== 'string' || !ISO_DAY.test(value) || utcDay(new Date(`${value}T00:00:00Z`)) !== value) {
    throw Object.assign(new Error(`${field} must be a date, YYYY-MM-DD.`), { status: 400, code: 'bad_request', field });
  }
  return value;
}

function addDays(day, n) {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * `{ key, from, to, days, previous }` for a `range` preset (or `custom` with
 * `from`/`to`), all inclusive UTC days. `previous` is the same-length span
 * ending the day before `from` — what the "vs previous period" change
 * compares against — or null for `all`, which has nothing before it.
 * `firstDay` is the earliest day with any count, which is where "all" starts.
 * Throws a 400-shaped error for an unknown preset or malformed dates.
 */
export function resolveViewRange({ range = '30d', from, to } = {}, { today = new Date(), firstDay = null } = {}) {
  const end = utcDay(today);
  let start;
  let last = end;
  if (RANGE_DAYS[range]) {
    start = addDays(end, 1 - RANGE_DAYS[range]);
  } else if (range === 'ytd') {
    start = `${end.slice(0, 4)}-01-01`;
  } else if (range === 'all') {
    start = firstDay && firstDay < end ? firstDay : end;
  } else if (range === 'custom') {
    start = parseDay(from, 'from');
    last = parseDay(to, 'to');
    if (start > last) {
      throw Object.assign(new Error('from must be on or before to.'), { status: 400, code: 'bad_request', field: 'from' });
    }
    if (daysBetween(start, last) > MAX_RANGE_DAYS) {
      throw Object.assign(new Error('That range is too long.'), { status: 400, code: 'bad_request', field: 'from' });
    }
  } else {
    throw Object.assign(new Error(`range must be one of ${VIEW_RANGES.join(', ')}.`), { status: 400, code: 'bad_request', field: 'range' });
  }

  const days = daysBetween(start, last);
  const previous = range === 'all' ? null : { from: addDays(start, -days), to: addDays(start, -1) };
  return { key: range, from: start, to: last, days, previous };
}

// Only ever interpolated from this map — never from the request — so the
// ORDER BY stays a fixed string. Each has a stable tie-break so paging
// doesn't shuffle rows with equal views or equal dates.
const SORTS = {
  views: (dir) => `in_range ${dir}, p.published_at DESC, p.title COLLATE NOCASE ASC`,
  // Never-published rows (an archived draft with old views) sort last either way.
  published: (dir) => `p.published_at IS NULL, p.published_at ${dir}, p.title COLLATE NOCASE ASC`,
  title: (dir) => `p.title COLLATE NOCASE ${dir}, p.id ASC`,
};
export const VIEW_SORTS = Object.keys(SORTS);
// What a column header's first click means — most views and newest first,
// titles A–Z.
const DEFAULT_ORDER = { views: 'desc', published: 'desc', title: 'asc' };

/**
 * Per-page view counts for `range` (from resolveViewRange), for GET
 * /api/admin/stats/views: one row per post or collection item with its views
 * in the range and in the previous period, plus the range's totals.
 *
 * Every published page is listed, zero views included, so sorting by title
 * or date gives the whole list; anything else (archived, back to draft)
 * appears only while it has views in the range. `type` is 'all' or one
 * post_type.
 */
export async function viewStats(db, range, { type = 'all', sort = 'views', order, limit = 50, offset = 0 } = {}) {
  const sortSql = SORTS[sort] || SORTS.views;
  const dir = (order || DEFAULT_ORDER[sort] || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // With no previous period the join window is just the range, so
  // in_previous is always 0 — reported as null below. The aliases aren't
  // `views`: SQLite would resolve that name in HAVING to post_views.views,
  // the raw per-day column, not the sum.
  const windowStart = range.previous ? range.previous.from : range.from;

  const typeSql = type && type !== 'all' ? 'WHERE p.post_type = ?' : '';
  const typeParams = type && type !== 'all' ? [type] : [];
  const base = `
    SELECT p.id, p.slug, p.title, p.post_type, p.status, p.visibility, p.published_at,
           COALESCE(SUM(CASE WHEN v.day >= ? THEN v.views END), 0) AS in_range,
           COALESCE(SUM(CASE WHEN v.day <  ? THEN v.views END), 0) AS in_previous
    FROM posts p
    LEFT JOIN post_views v ON v.post_id = p.id AND v.day BETWEEN ? AND ?
    ${typeSql}
    GROUP BY p.id
    HAVING p.status = 'published' OR in_range > 0
  `;
  const baseParams = [range.from, range.from, windowStart, range.to, ...typeParams];

  const [rows, totals, top, enabled] = await Promise.all([
    db.prepare(`${base} ORDER BY ${sortSql(dir)} LIMIT ? OFFSET ?`).bind(...baseParams, limit, offset).all(),
    db
      .prepare(`
        SELECT COUNT(*) AS pages,
               COALESCE(SUM(in_range), 0) AS views,
               COALESCE(SUM(in_previous), 0) AS previous_views,
               COALESCE(SUM(in_range > 0), 0) AS pages_viewed
        FROM (${base})
      `)
      .bind(...baseParams)
      .first(),
    db.prepare(`SELECT id, title, in_range AS views FROM (${base}) WHERE in_range > 0 ORDER BY in_range DESC, title COLLATE NOCASE LIMIT 1`).bind(...baseParams).first(),
    db.prepare(`SELECT value FROM settings WHERE key = 'analytics_enabled'`).first(),
  ]);

  const hasPrevious = Boolean(range.previous);
  return {
    data: (rows.results || []).map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      post_type: row.post_type,
      status: row.status,
      visibility: row.visibility,
      published_at: row.published_at,
      views: row.in_range,
      previous_views: hasPrevious ? row.in_previous : null,
    })),
    totals: {
      views: totals?.views || 0,
      previous_views: hasPrevious ? totals?.previous_views || 0 : null,
      pages_viewed: totals?.pages_viewed || 0,
      top: top || null,
    },
    // Counts already stored still show when counting is switched off; the
    // page says so rather than looking like nobody is reading.
    counting: enabled?.value === 'true',
    page: { limit, offset, total: totals?.pages || 0, has_more: offset + (rows.results || []).length < (totals?.pages || 0) },
  };
}

/** The earliest day with any count — where the "all time" range starts. */
export async function firstViewDay(db) {
  const row = await db.prepare(`SELECT MIN(day) AS day FROM post_views`).first();
  return row?.day || null;
}
