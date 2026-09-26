import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleDashboardApi } from './admin-dashboard.js';
import { resolveAuthor } from './auth.js';
import { recordView, utcDay, viewTotals } from './views.js';

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
