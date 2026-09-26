import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleDashboardApi } from './admin-dashboard.js';
import { resolveAuthor } from './auth.js';
import { recordView, resolveViewRange, utcDay, viewTotals } from './views.js';

const HOST = 'blog.mysite.com';
const ADMIN_HOST = 'blog-admin.mysite.com';
const SLUG = 'shipping-a-blog-on-cloudflare-workers';

function track(body, { host = HOST, method = 'POST', headers = {} } = {}) {
  return SELF.fetch(`https://${host}/api/pagecounter`, {
    method,
    // What navigator.sendBeacon sends for a string body, from our own page.
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: `https://${host}`, ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

async function viewsFor(slug, day = utcDay()) {
  const row = await env.DB
    .prepare(`SELECT v.views FROM post_views v JOIN posts p ON p.id = v.post_id WHERE p.slug = ? AND v.day = ?`)
    .bind(slug, day)
    .first();
  return row?.views || 0;
}

async function setAnalytics(value) {
  await env.DB
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('analytics_enabled', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(JSON.stringify(value), new Date().toISOString())
    .run();
}

async function insertPost({ id, slug, status = 'published', visibility = 'public', postType = 'post' }) {
  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      INSERT OR IGNORE INTO posts (
        id, slug, title, excerpt, body_md, body_html, status, visibility, author_id,
        created_at, updated_at, published_at, post_type, type_fields
      ) VALUES (?, ?, 'Fixture', 'An excerpt.', 'Body', '<p>Body</p>', ?, ?, 'a1', ?, ?, ?, ?, ?)
    `)
    .bind(id, slug, status, visibility, now, now, status === 'published' ? now : null, postType, postType === 'post' ? null : '{}')
    .run();
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM post_views`).run();
  await setAnalytics(true);
});

describe('POST /api/pagecounter', () => {
  it('counts a view of a published post, once per beacon', async () => {
    const res = await track({ slug: SLUG });
    expect(res.status).toBe(204);
    expect(await viewsFor(SLUG)).toBe(1);

    await track({ slug: SLUG });
    expect(await viewsFor(SLUG)).toBe(2);
  });

  it('answers with an empty, uncacheable 204', async () => {
    const res = await track({ slug: SLUG });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('counts a published collection item', async () => {
    await insertPost({ id: 'track-item', slug: 'track-item', postType: 'project' });
    await track({ slug: 'track-item' });
    expect(await viewsFor('track-item')).toBe(1);
  });

  it('counts an unlisted post — its link still works', async () => {
    await insertPost({ id: 'track-unlisted', slug: 'track-unlisted', visibility: 'unlisted' });
    await track({ slug: 'track-unlisted' });
    expect(await viewsFor('track-unlisted')).toBe(1);
  });

  it('ignores drafts and unknown slugs, with the same 204', async () => {
    await insertPost({ id: 'track-draft', slug: 'track-draft', status: 'draft' });
    expect((await track({ slug: 'track-draft' })).status).toBe(204);
    expect((await track({ slug: 'no-such-post' })).status).toBe(204);
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_views`).first();
    expect(n).toBe(0);
  });

  it('counts nothing while "Count page views" is off, or never set', async () => {
    await setAnalytics(false);
    await track({ slug: SLUG });
    expect(await viewsFor(SLUG)).toBe(0);

    await env.DB.prepare(`DELETE FROM settings WHERE key = 'analytics_enabled'`).run();
    await track({ slug: SLUG });
    expect(await viewsFor(SLUG)).toBe(0);
  });

  it('ignores malformed and oversized bodies', async () => {
    for (const body of ['not json', '{}', JSON.stringify({ slug: 42 }), JSON.stringify({ slug: '' }), JSON.stringify({ slug: SLUG, pad: 'x'.repeat(600) })]) {
      expect((await track(body)).status).toBe(204);
    }
    expect(await viewsFor(SLUG)).toBe(0);
  });

  it('ignores a beacon from another origin', async () => {
    expect((await track({ slug: SLUG }, { headers: { Origin: 'https://elsewhere.example' } })).status).toBe(204);
    expect(await viewsFor(SLUG)).toBe(0);
  });

  it('counts a beacon that arrives with no Origin header', async () => {
    const res = await SELF.fetch(`https://${HOST}/api/pagecounter`, { method: 'POST', body: JSON.stringify({ slug: SLUG }) });
    expect(res.status).toBe(204);
    expect(await viewsFor(SLUG)).toBe(1);
  });

  it('falls back to Sec-Fetch-Site when there is no Origin', async () => {
    const send = (site) => SELF.fetch(`https://${HOST}/api/pagecounter`, {
      method: 'POST', headers: { 'Sec-Fetch-Site': site }, body: JSON.stringify({ slug: SLUG }),
    });
    await send('cross-site');
    expect(await viewsFor(SLUG)).toBe(0);
    await send('same-origin');
    expect(await viewsFor(SLUG)).toBe(1);
  });

  it('never counts on the admin host', async () => {
    const res = await track({ slug: SLUG }, { host: ADMIN_HOST });
    expect(res.status).toBe(204);
    expect(await viewsFor(SLUG)).toBe(0);
  });

  it('is POST-only', async () => {
    const res = await track(null, { method: 'GET' });
    expect(res.status).not.toBe(204);
    expect(await viewsFor(SLUG)).toBe(0);
  });

  it('keeps separate rows per UTC day, and goes away with the post', async () => {
    await insertPost({ id: 'track-cascade', slug: 'track-cascade' });
    expect(await recordView(env.DB, 'track-cascade', '2026-01-01')).toBe(true);
    expect(await recordView(env.DB, 'no-such-post', '2026-01-01')).toBe(false);
    await recordView(env.DB, 'track-cascade', '2026-01-02');
    await recordView(env.DB, 'track-cascade', '2026-01-02');
    expect(await viewsFor('track-cascade', '2026-01-01')).toBe(1);
    expect(await viewsFor('track-cascade', '2026-01-02')).toBe(2);

    await env.DB.prepare(`DELETE FROM posts WHERE id = 'track-cascade'`).run();
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM post_views WHERE post_id = 'track-cascade'`).first();
    expect(n).toBe(0);
  });
});

describe('view totals', () => {
  it('sums all time and the last 30 days (today included)', async () => {
    const today = new Date('2026-09-26T12:00:00Z');
    await recordView(env.DB, SLUG, '2026-09-26');
    await recordView(env.DB, SLUG, '2026-08-28'); // 29 days before: inside
    await recordView(env.DB, SLUG, '2026-08-27'); // 30 days before: outside
    expect(await viewTotals(env.DB, today)).toEqual({ total: 3, last_30_days: 2 });
  });

  it('are on GET /api/admin/stats', async () => {
    await track({ slug: SLUG });
    const url = new URL(`https://${ADMIN_HOST}/api/admin/stats`);
    const identity = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
    const ctx = createExecutionContext();
    const res = await handleDashboardApi(new Request(url), url, { env, ctx, identity });
    await waitOnExecutionContext(ctx);
    const { data } = await res.json();
    expect(data.views).toEqual({ total: 1, last_30_days: 1 });
  });
});

describe('resolveViewRange', () => {
  const today = new Date('2026-09-26T12:00:00Z');

  it('counts rolling presets back from today, inclusive, with a same-length previous period', () => {
    expect(resolveViewRange({ range: '7d' }, { today })).toEqual({
      key: '7d', from: '2026-09-20', to: '2026-09-26', days: 7,
      previous: { from: '2026-09-13', to: '2026-09-19' },
    });
    expect(resolveViewRange({ range: '30d' }, { today }).from).toBe('2026-08-28');
    expect(resolveViewRange({ range: '12m' }, { today }).days).toBe(365);
  });

  it('anchors ytd to 1 January and all to the first counted day, with no previous period', () => {
    expect(resolveViewRange({ range: 'ytd' }, { today })).toMatchObject({ from: '2026-01-01', to: '2026-09-26' });
    expect(resolveViewRange({ range: 'all' }, { today, firstDay: '2026-05-04' })).toMatchObject({ from: '2026-05-04', previous: null });
    expect(resolveViewRange({ range: 'all' }, { today })).toMatchObject({ from: '2026-09-26', days: 1 });
  });

  it('takes custom from/to and rejects anything malformed', () => {
    expect(resolveViewRange({ range: 'custom', from: '2026-08-01', to: '2026-08-31' }, { today })).toMatchObject({
      days: 31, previous: { from: '2026-07-01', to: '2026-07-31' },
    });
    for (const bad of [
      { range: 'week' },
      { range: 'custom' },
      { range: 'custom', from: '2026-02-30', to: '2026-03-01' },
      { range: 'custom', from: '2026-03-02', to: '2026-03-01' },
      { range: 'custom', from: '1990-01-01', to: '2026-03-01' },
    ]) {
      expect(() => resolveViewRange(bad, { today }), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

describe('GET /api/admin/stats/views', () => {
  async function callStats(query) {
    const url = new URL(`https://${ADMIN_HOST}/api/admin/stats/views?${query}`);
    const identity = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
    const ctx = createExecutionContext();
    const res = await handleDashboardApi(new Request(url), url, { env, ctx, identity });
    await waitOnExecutionContext(ctx);
    return res;
  }

  // Four fixtures, all under their own post_type so the seed posts stay out
  // of the assertions: two read in August, one never read, one read and then
  // archived, plus a draft that must never be listed.
  async function seed() {
    const type = 'statsfixture';
    const rows = [
      { id: 'sv-a', title: 'Alpha', published_at: '2026-03-01T00:00:00Z' },
      { id: 'sv-b', title: 'bravo', published_at: '2026-06-01T00:00:00Z' },
      { id: 'sv-c', title: 'Charlie', published_at: '2026-01-01T00:00:00Z' },
      { id: 'sv-d', title: 'Delta', published_at: '2025-12-01T00:00:00Z' },
      { id: 'sv-e', title: 'Echo', status: 'draft' },
    ];
    for (const row of rows) {
      await insertPost({ id: row.id, slug: row.id, status: row.status || 'published', postType: type });
      await env.DB
        .prepare(`UPDATE posts SET title = ?, status = ?, published_at = ? WHERE id = ?`)
        .bind(row.title, row.status || 'published', row.published_at || null, row.id)
        .run();
    }
    for (const [slug, day, times] of [
      ['sv-a', '2026-08-10', 3], ['sv-a', '2026-07-20', 2],
      ['sv-b', '2026-08-15', 5],
      ['sv-d', '2026-08-02', 1],
    ]) {
      for (let i = 0; i < times; i++) await recordView(env.DB, slug, day);
    }
    await env.DB.prepare(`UPDATE posts SET status = 'archived' WHERE id = 'sv-d'`).run();
    return type;
  }

  it('lists every published page with its views and previous-period views', async () => {
    const type = await seed();
    const res = await callStats(`range=custom&from=2026-08-01&to=2026-08-31&type=${type}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toMatchObject({ from: '2026-08-01', to: '2026-08-31', previous: { from: '2026-07-01', to: '2026-07-31' } });
    expect(body.data.map((r) => [r.id, r.views, r.previous_views])).toEqual([
      ['sv-b', 5, 0],
      ['sv-a', 3, 2],
      ['sv-d', 1, 0], // archived, but read in the range
      ['sv-c', 0, 0], // published, never read
    ]);
    expect(body.totals).toEqual({ views: 9, previous_views: 2, pages_viewed: 3, top: { id: 'sv-b', title: 'bravo', views: 5 } });
    expect(body.counting).toBe(true);
    expect(body.page).toEqual({ limit: 50, offset: 0, total: 4, has_more: false });
  });

  it('drops an unpublished page once it has no views in the range', async () => {
    const type = await seed();
    const { data } = await (await callStats(`range=custom&from=2026-09-01&to=2026-09-30&type=${type}`)).json();
    expect(data.map((r) => r.id).sort()).toEqual(['sv-a', 'sv-b', 'sv-c']);
  });

  it('sorts by title (case-insensitive) and published date, both ways', async () => {
    const type = await seed();
    const range = `range=custom&from=2026-08-01&to=2026-08-31&type=${type}`;
    const ids = async (q) => (await (await callStats(`${range}&${q}`)).json()).data.map((r) => r.id);
    expect(await ids('sort=title')).toEqual(['sv-a', 'sv-b', 'sv-c', 'sv-d']);
    expect(await ids('sort=title&order=desc')).toEqual(['sv-d', 'sv-c', 'sv-b', 'sv-a']);
    expect(await ids('sort=published')).toEqual(['sv-b', 'sv-a', 'sv-c', 'sv-d']);
    expect(await ids('sort=published&order=asc')).toEqual(['sv-d', 'sv-c', 'sv-a', 'sv-b']);
    expect(await ids('sort=views&order=asc')).toEqual(['sv-c', 'sv-d', 'sv-a', 'sv-b']);
  });

  it('pages with limit/offset while totals cover every row', async () => {
    const type = await seed();
    const body = await (await callStats(`range=custom&from=2026-08-01&to=2026-08-31&type=${type}&limit=2&offset=2`)).json();
    expect(body.data.map((r) => r.id)).toEqual(['sv-d', 'sv-c']);
    expect(body.page).toEqual({ limit: 2, offset: 2, total: 4, has_more: false });
    expect(body.totals.views).toBe(9);
  });

  it('reports no previous period for all time, and whether counting is on', async () => {
    const type = await seed();
    await setAnalytics(false);
    const body = await (await callStats(`range=all&type=${type}`)).json();
    expect(body.range.previous).toBeNull();
    expect(body.totals.previous_views).toBeNull();
    expect(body.data.find((r) => r.id === 'sv-a')).toMatchObject({ views: 5, previous_views: null });
    expect(body.counting).toBe(false);
  });

  it('rejects an unknown range, sort or order', async () => {
    for (const q of ['range=forever', 'sort=slug', 'order=up', 'range=custom&from=2026-09-01']) {
      const res = await callStats(q);
      expect(res.status, q).toBe(400);
    }
  });
});

describe('stats chart series and single-page view', () => {
  async function call(path) {
    const url = new URL(`https://${ADMIN_HOST}${path}`);
    const identity = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
    const ctx = createExecutionContext();
    const res = await handleDashboardApi(new Request(url), url, { env, ctx, identity });
    await waitOnExecutionContext(ctx);
    return res;
  }

  async function seed() {
    const type = 'seriesfixture';
    await insertPost({ id: 'ss-a', slug: 'ss-a', postType: type });
    await insertPost({ id: 'ss-b', slug: 'ss-b', postType: 'otherfixture' });
    for (const [slug, day, times] of [
      ['ss-a', '2026-08-03', 2], ['ss-a', '2026-08-04', 1], ['ss-a', '2026-08-10', 3],
      ['ss-a', '2026-07-15', 5], ['ss-a', '2024-01-10', 1],
      ['ss-b', '2026-08-04', 4],
    ]) {
      for (let i = 0; i < times; i++) await recordView(env.DB, slug, day);
    }
    return type;
  }

  it('fills every day of a short range, zeros included, filtered by type', async () => {
    const type = await seed();
    const { series } = await (await call(`/api/admin/stats/views?range=custom&from=2026-08-01&to=2026-08-12&type=${type}`)).json();
    expect(series.bucket).toBe('day');
    expect(series.points).toHaveLength(12);
    expect(series.points[0]).toEqual({ start: '2026-08-01', end: '2026-08-01', views: 0 });
    expect(series.points.filter((p) => p.views)).toEqual([
      { start: '2026-08-03', end: '2026-08-03', views: 2 },
      { start: '2026-08-04', end: '2026-08-04', views: 1 }, // ss-b's 4 are another type
      { start: '2026-08-10', end: '2026-08-10', views: 3 },
    ]);
  });

  it('groups a longer range into Monday-start weeks, clipping the ends to the range', async () => {
    const type = await seed();
    const { series } = await (await call(`/api/admin/stats/views?range=custom&from=2026-06-03&to=2026-09-30&type=${type}`)).json();
    expect(series.bucket).toBe('week');
    expect(series.points[0]).toEqual({ start: '2026-06-03', end: '2026-06-07', views: 0 }); // Wed–Sun
    expect(series.points.at(-1)).toEqual({ start: '2026-09-28', end: '2026-09-30', views: 0 });
    expect(series.points.filter((p) => p.views)).toEqual([
      { start: '2026-07-13', end: '2026-07-19', views: 5 },
      { start: '2026-08-03', end: '2026-08-09', views: 3 },
      { start: '2026-08-10', end: '2026-08-16', views: 3 },
    ]);
  });

  it('groups ranges over two years by month', async () => {
    const type = await seed();
    const { series } = await (await call(`/api/admin/stats/views?range=custom&from=2023-12-15&to=2026-09-30&type=${type}`)).json();
    expect(series.bucket).toBe('month');
    expect(series.points[0]).toEqual({ start: '2023-12-15', end: '2023-12-31', views: 0 });
    expect(series.points.find((p) => p.start === '2026-08-01')).toEqual({ start: '2026-08-01', end: '2026-08-31', views: 6 });
  });

  it('leaves the series off "Load more" pages', async () => {
    const body = await (await call('/api/admin/stats/views?range=30d&offset=1')).json();
    expect(body).not.toHaveProperty('series');
  });

  it('gives one page its range, previous-period and all-time counts', async () => {
    await seed();
    const res = await call('/api/admin/stats/views/ss-a?range=custom&from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: 'ss-a', slug: 'ss-a' });
    expect(body.totals).toEqual({ views: 6, previous_views: 5, all_time: 12, first_day: '2024-01-10' });
    expect(body.series.points).toHaveLength(31);
    expect(body.counting).toBe(true);
  });

  it('has no previous period for all time, and 404s an unknown page', async () => {
    await seed();
    const { totals } = await (await call('/api/admin/stats/views/ss-a?range=all')).json();
    expect(totals).toMatchObject({ views: 12, previous_views: null, all_time: 12 });
    expect((await call('/api/admin/stats/views/no-such-post')).status).toBe(404);
    expect((await call('/api/admin/stats/views/ss-a?range=forever')).status).toBe(400);
  });
});
