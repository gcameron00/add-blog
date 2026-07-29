import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handlePostsApi } from './admin-posts.js';
import { resolveAuthor } from './auth.js';
import { publishDuePosts } from './cron.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

function req(method, path, { body } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const headers = { Origin: url.origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { request: new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), url };
}

async function call(identity, method, path, opts) {
  const { request, url } = req(method, path, opts);
  const ctx = createExecutionContext();
  const response = await handlePostsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

let owner;

beforeAll(async () => {
  owner = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
});

async function createScheduledPost(scheduledFor) {
  const created = await (await call(owner, 'POST', '/api/admin/posts', {
    body: { title: 'Auto-publish me', body_md: 'Waiting on the cron sweep.', tags: ['cloudflare'] },
  })).json();
  const post = created.data;

  // The write API only accepts a future `scheduled_for` (see admin-posts.test.js's
  // "schedule requires a future date"), so this schedules for a real future time and
  // then backdates the row directly — the cron sweep is what's under test here, not
  // the schedule endpoint's own validation.
  await call(owner, 'POST', `/api/admin/posts/${post.id}/schedule`, { body: { scheduled_for: '2099-01-01T00:00:00Z' } });
  await env.DB.prepare(`UPDATE posts SET scheduled_for = ? WHERE id = ?`).bind(scheduledFor, post.id).run();
  return post;
}

describe('publishDuePosts', () => {
  it('publishes a scheduled post whose time has passed, and logs it via=cron', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const post = await createScheduledPost(past);

    const result = await publishDuePosts(env);
    expect(result.published).toBeGreaterThanOrEqual(1);

    const after = await (await call(owner, 'GET', `/api/admin/posts/${post.id}`)).json();
    expect(after.data.status).toBe('published');
    expect(after.data.scheduled_for).toBeNull();
    expect(after.data.published_at).toBeTruthy();

    const auditRow = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE entity_id = ? AND action = 'post.publish' ORDER BY created_at DESC LIMIT 1`)
      .bind(post.id)
      .first();
    expect(auditRow).toMatchObject({ actor: 'system', via: 'cron' });
  });

  it('leaves a post scheduled for the future untouched', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const post = await createScheduledPost(future);

    await publishDuePosts(env);

    const after = await (await call(owner, 'GET', `/api/admin/posts/${post.id}`)).json();
    expect(after.data.status).toBe('scheduled');
  });

  it('is a no-op with no DB binding', async () => {
    await expect(publishDuePosts({})).resolves.toEqual({ published: 0 });
  });
});
