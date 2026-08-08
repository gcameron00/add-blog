import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleAuthorsApi } from './admin-authors.js';
import { handleDashboardApi } from './admin-dashboard.js';
import { handlePostsApi } from './admin-posts.js';
import { resolveAuthor } from './auth.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

function req(method, path, { body, headers = {} } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const finalHeaders = { ...headers, Origin: url.origin };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const request = new Request(url, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { request, url };
}

async function callDashboard(identity, path) {
  const { request, url } = req('GET', path);
  const ctx = createExecutionContext();
  const response = await handleDashboardApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function callPosts(identity, method, path, opts) {
  const { request, url } = req(method, path, opts);
  const ctx = createExecutionContext();
  const response = await handlePostsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function callAuthors(identity, method, path, opts) {
  const { request, url } = req(method, path, opts);
  const ctx = createExecutionContext();
  const response = await handleAuthorsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function identityFor(email) {
  return { email, author: await resolveAuthor(env.DB, email) };
}

async function createPost(identity, overrides = {}) {
  const res = await callPosts(identity, 'POST', '/api/admin/posts', {
    body: { title: 'Dashboard fixture post', body_md: 'one two three', ...overrides },
  });
  return (await res.json()).data;
}

describe('GET /api/admin/stats', () => {
  it('counts posts by status and sums word_count', async () => {
    const owner = await identityFor('grant@mysite.com');
    const draft = await createPost(owner, { title: 'Draft one' }); // 3-word body_md
    await createPost(owner, { title: 'Draft two', body_md: 'four five six seven' }); // 4 words
    await callPosts(owner, 'POST', `/api/admin/posts/${draft.id}/publish`);

    const res = await callDashboard(owner, '/api/admin/stats');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.published).toBeGreaterThanOrEqual(1);
    expect(data.draft).toBeGreaterThanOrEqual(1);
    expect(data.words).toBeGreaterThanOrEqual(7); // at least this test's own 3 + 4 words
  });

  it('surfaces the earliest scheduled post', async () => {
    const owner = await identityFor('grant@mysite.com');
    const post = await createPost(owner, { title: 'Scheduled fixture' });
    await callPosts(owner, 'POST', `/api/admin/posts/${post.id}/schedule`, { body: { scheduled_for: '2099-06-01T00:00:00Z' } });

    const { data } = await (await callDashboard(owner, '/api/admin/stats')).json();
    expect(data.next_scheduled.title).toBe('Scheduled fixture');
    expect(new Date(data.next_scheduled.scheduled_for).toISOString()).toBe('2099-06-01T00:00:00.000Z');
  });

  it('is unreachable with no identity', async () => {
    const { request, url } = req('GET', '/api/admin/stats');
    const ctx = createExecutionContext();
    const result = await handleDashboardApi(request, url, { env, ctx, identity: null });
    expect(result).toBeNull();
  });
});

describe('GET /api/admin/audit', () => {
  it('shows the most recent mutations newest-first, with a human-readable detail', async () => {
    const owner = await identityFor('grant@mysite.com');
    const post = await createPost(owner, { title: 'Audited post' });
    await callPosts(owner, 'POST', `/api/admin/posts/${post.id}/publish`);

    const { data } = await (await callDashboard(owner, '/api/admin/audit?limit=5')).json();
    expect(data[0].action).toBe('post.publish');
    expect(data[0].detail).toBe('Audited post');
    expect(data[0].actor).toBe('grant@mysite.com');
    expect(data.some((e) => e.action === 'post.create' && e.detail === 'Audited post')).toBe(true);
  });

  it('filters by action', async () => {
    const owner = await identityFor('grant@mysite.com');
    await createPost(owner, { title: 'Filter target' });

    const { data } = await (await callDashboard(owner, '/api/admin/audit?action=post.create&limit=50')).json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((e) => e.action === 'post.create')).toBe(true);
  });

  it('filters by actor', async () => {
    const owner = await identityFor('grant@mysite.com');
    const editor = await identityFor('ada@mysite.com');
    await createPost(owner, { title: 'Owned by owner' });
    await createPost(editor, { title: 'Owned by editor' });

    const { data } = await (await callDashboard(owner, '/api/admin/audit?actor=ada@mysite.com&limit=50')).json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((e) => e.actor === 'ada@mysite.com')).toBe(true);
  });

  it('summarises a fields-only update (author.update) by the target account rather than leaving it blank', async () => {
    const owner = await identityFor('grant@mysite.com');
    const created = await (
      await callAuthors(owner, 'POST', '/api/admin/authors', { body: { name: 'Dashboard Fixture', email: 'dashboard-fixture@mysite.com' } })
    ).json();
    await callAuthors(owner, 'PATCH', `/api/admin/authors/${created.data.id}`, { body: { role: 'editor' } });

    const { data } = await (await callDashboard(owner, '/api/admin/audit?action=author.update&limit=50')).json();
    const entry = data.find((e) => e.detail === 'dashboard-fixture@mysite.com');
    expect(entry).toBeTruthy();
  });
});
