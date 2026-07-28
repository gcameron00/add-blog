import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handlePostsApi } from './admin-posts.js';
import { resolveAuthor } from './auth.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

function req(method, path, { body, headers = {}, noOrigin = false } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (!noOrigin) finalHeaders.Origin = url.origin;
  const request = new Request(url, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { request, url };
}

async function call(identity, method, path, opts) {
  const { request, url } = req(method, path, opts);
  const ctx = createExecutionContext();
  const response = await handlePostsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

let owner;
let editor;
let author;

beforeAll(async () => {
  owner = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
  editor = { email: 'ada@mysite.com', author: await resolveAuthor(env.DB, 'ada@mysite.com') };
  await env.DB
    .prepare(`INSERT INTO authors (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('a3', 'author-role@mysite.com', 'Author Role', 'author', '2026-07-01T00:00:00Z')
    .run();
  author = { email: 'author-role@mysite.com', author: await resolveAuthor(env.DB, 'author-role@mysite.com') };
});

async function createPost(identity, overrides = {}) {
  const res = await call(identity, 'POST', '/api/admin/posts', {
    body: { title: 'A brand new post', body_md: 'Hello world, this is a **test** post.', ...overrides },
  });
  expect(res.status).toBe(201);
  return (await res.json()).data;
}

describe('GET /api/admin/posts', () => {
  it('lists every status by default, proving the admin surface sees drafts the public API never does', async () => {
    const draft = await createPost(owner, { title: 'Only visible to admins' });
    const res = await call(owner, 'GET', '/api/admin/posts');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(7); // 6 published seed posts + this draft
    expect(data.some((p) => p.id === draft.id && p.status === 'draft')).toBe(true);
  });

  it('filters by status after creating a draft', async () => {
    await createPost(owner, { title: 'Filter me by status' });
    const res = await call(owner, 'GET', '/api/admin/posts?status=draft');
    const { data } = await res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((p) => p.status === 'draft')).toBe(true);
  });

  it('is unreachable when there is no identity (site not Access-configured yet)', async () => {
    const { request, url } = req('GET', '/api/admin/posts');
    const ctx = createExecutionContext();
    const result = await handlePostsApi(request, url, { env, ctx, identity: null });
    expect(result).toBeNull();
  });
});

describe('POST /api/admin/posts (create)', () => {
  it('creates a draft with a derived slug, computed word count/reading time, and an ETag', async () => {
    const res = await call(owner, 'POST', '/api/admin/posts', { body: { title: 'Hello, World!' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('ETag')).toBeTruthy();
    const { data } = await res.json();
    expect(data.slug).toBe('hello-world');
    expect(data.status).toBe('draft');
    expect(data.author.id).toBe(owner.author.id);
  });

  it('auto-suffixes a slug collision rather than rejecting it', async () => {
    const first = await createPost(owner, { title: 'Duplicate Slug Test', slug: 'dup-slug' });
    const second = await createPost(owner, { title: 'Duplicate Slug Test', slug: 'dup-slug' });
    expect(first.slug).toBe('dup-slug');
    expect(second.slug).toBe('dup-slug-2');
  });

  it('computes word_count, reading_minutes, excerpt and body_html from body_md', async () => {
    const post = await createPost(owner, { title: 'Content check', body_md: 'One two three four five.' });
    expect(post.word_count).toBe(5);
    expect(post.reading_minutes).toBe(1);
    expect(post.body_html).toContain('<p>');
    expect(post.excerpt).toContain('One two three');
  });

  it('applies tags, creating any that do not exist yet', async () => {
    const post = await createPost(owner, { title: 'Tagged post', tags: ['cloudflare', 'a brand new tag'] });
    const slugs = post.tags.map((t) => t.slug).sort();
    expect(slugs).toEqual(['a-brand-new-tag', 'cloudflare']);
  });

  it('records a "create" revision', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'GET', `/api/admin/posts/${post.id}/revisions`);
    const { data } = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].note).toBe('create');
  });

  it('rejects a missing title with a field-tagged 400', async () => {
    const res = await call(owner, 'POST', '/api/admin/posts', { body: { body_md: 'no title here' } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.field).toBe('title');
  });

  it('rejects a request with no Origin header (CSRF guard)', async () => {
    const res = await call(owner, 'POST', '/api/admin/posts', { body: { title: 'x' }, noOrigin: true });
    expect(res.status).toBe(403);
  });

  it('rejects a non-JSON content type', async () => {
    const { url } = req('POST', '/api/admin/posts');
    const request = new Request(url, {
      method: 'POST',
      headers: { Origin: url.origin, 'Content-Type': 'text/plain' },
      body: 'title=x',
    });
    const ctx = createExecutionContext();
    const res = await handlePostsApi(request, url, { env, ctx, identity: owner });
    expect(res.status).toBe(400);
  });

  it('lets an author-role identity create their own draft', async () => {
    const res = await call(author, 'POST', '/api/admin/posts', { body: { title: 'Author-created post' } });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/admin/posts/:id', () => {
  it('returns the full post with body_md, body_html and an ETag', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'GET', `/api/admin/posts/${post.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${post.updated_at}"`);
    const { data } = await res.json();
    expect(data.body_md).toBeTruthy();
    expect(data.revision_count).toBe(1);
  });

  it('404s an unknown id', async () => {
    const res = await call(owner, 'GET', '/api/admin/posts/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/admin/posts/:id', () => {
  it('updates fields, recomputes derived content, and bumps the revision count', async () => {
    const post = await createPost(owner, { body_md: 'one two three' });
    const res = await call(owner, 'PATCH', `/api/admin/posts/${post.id}`, {
      body: { title: 'Updated title', body_md: 'one two three four five six seven' },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.title).toBe('Updated title');
    expect(data.word_count).toBe(7);

    const revisions = await (await call(owner, 'GET', `/api/admin/posts/${post.id}/revisions`)).json();
    expect(revisions.data).toHaveLength(2);
  });

  it('409s on a stale If-Match, with both versions in detail', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'PATCH', `/api/admin/posts/${post.id}`, {
      body: { title: 'New title' },
      headers: { 'If-Match': '"not-the-real-etag"' },
    });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.detail.current_etag).toBe(`"${post.updated_at}"`);
  });

  it('succeeds when If-Match matches the current ETag', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'PATCH', `/api/admin/posts/${post.id}`, {
      body: { title: 'New title' },
      headers: { 'If-Match': `"${post.updated_at}"` },
    });
    expect(res.status).toBe(200);
  });

  it('409s a slug rename that collides with another post, with the documented slug_taken code', async () => {
    const a = await createPost(owner, { slug: 'post-a' });
    await createPost(owner, { slug: 'post-b' });
    const res = await call(owner, 'PATCH', `/api/admin/posts/${a.id}`, { body: { slug: 'post-b' } });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe('slug_taken');
    expect(error.field).toBe('slug');
  });

  it('lets an author edit their own post', async () => {
    const post = await createPost(author);
    const res = await call(author, 'PATCH', `/api/admin/posts/${post.id}`, { body: { title: 'Self edit' } });
    expect(res.status).toBe(200);
  });

  it('403s an author editing someone else’s post', async () => {
    const post = await createPost(owner);
    const res = await call(author, 'PATCH', `/api/admin/posts/${post.id}`, { body: { title: 'Hijack' } });
    expect(res.status).toBe(403);
  });

  it('lets an editor edit another author’s post', async () => {
    const post = await createPost(author);
    const res = await call(editor, 'PATCH', `/api/admin/posts/${post.id}`, { body: { title: 'Editor fixes typo' } });
    expect(res.status).toBe(200);
  });
});

describe('publish / unpublish / schedule', () => {
  it('publish sets published_at once and unpublish leaves it intact', async () => {
    const post = await createPost(owner);
    const published = await (await call(owner, 'POST', `/api/admin/posts/${post.id}/publish`)).json();
    expect(published.data.status).toBe('published');
    expect(published.data.published_at).toBeTruthy();

    const unpublished = await (await call(owner, 'POST', `/api/admin/posts/${post.id}/unpublish`)).json();
    expect(unpublished.data.status).toBe('draft');
    expect(unpublished.data.published_at).toBe(published.data.published_at);

    const republished = await (await call(owner, 'POST', `/api/admin/posts/${post.id}/publish`)).json();
    expect(republished.data.published_at).toBe(published.data.published_at);
  });

  it('schedule requires a future date', async () => {
    const post = await createPost(owner);
    const past = await call(owner, 'POST', `/api/admin/posts/${post.id}/schedule`, {
      body: { scheduled_for: '2020-01-01T00:00:00Z' },
    });
    expect(past.status).toBe(400);

    const future = await call(owner, 'POST', `/api/admin/posts/${post.id}/schedule`, {
      body: { scheduled_for: '2099-01-01T00:00:00Z' },
    });
    expect(future.status).toBe(200);
    const { data } = await future.json();
    expect(data.status).toBe('scheduled');
  });

  it('403s an author-role identity trying to publish', async () => {
    const post = await createPost(author);
    const res = await call(author, 'POST', `/api/admin/posts/${post.id}/publish`);
    expect(res.status).toBe(403);
  });

  it('an editor can publish another author’s post', async () => {
    const post = await createPost(author);
    const res = await call(editor, 'POST', `/api/admin/posts/${post.id}/publish`);
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/admin/posts/:id', () => {
  it('soft-deletes to archived by default', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'DELETE', `/api/admin/posts/${post.id}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.status).toBe('archived');
    expect((await call(owner, 'GET', `/api/admin/posts/${post.id}`)).status).toBe(200);
  });

  it('rejects hard delete from a non-owner', async () => {
    const post = await createPost(editor);
    const res = await call(editor, 'DELETE', `/api/admin/posts/${post.id}?hard=true`);
    expect(res.status).toBe(403);
  });

  it('hard-deletes the row for an owner', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'DELETE', `/api/admin/posts/${post.id}?hard=true`);
    expect(res.status).toBe(200);
    expect((await call(owner, 'GET', `/api/admin/posts/${post.id}`)).status).toBe(404);
  });
});

describe('duplicate', () => {
  it('copies content into a new draft under the duplicator, slug suffixed -copy', async () => {
    const source = await createPost(owner, { slug: 'source-post', tags: ['cloudflare'] });
    const res = await call(editor, 'POST', `/api/admin/posts/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.slug).toBe('source-post-copy');
    expect(data.status).toBe('draft');
    expect(data.author.id).toBe(editor.author.id);
    expect(data.body_md).toBe(source.body_md);
    expect(data.tags.map((t) => t.slug)).toContain('cloudflare');
  });
});

describe('revisions and restore', () => {
  it('restore snapshots the current state, then applies the target revision', async () => {
    const post = await createPost(owner, { body_md: 'version one' });
    await call(owner, 'PATCH', `/api/admin/posts/${post.id}`, { body: { body_md: 'version two' } });

    const revisions = await (await call(owner, 'GET', `/api/admin/posts/${post.id}/revisions`)).json();
    const firstRevision = revisions.data.find((r) => r.note === 'create');

    const restored = await call(owner, 'POST', `/api/admin/posts/${post.id}/revisions/${firstRevision.id}/restore`);
    expect(restored.status).toBe(200);
    const { data } = await restored.json();
    expect(data.body_md).toBe('version one');

    const after = await (await call(owner, 'GET', `/api/admin/posts/${post.id}/revisions`)).json();
    expect(after.data.map((r) => r.note)).toEqual(expect.arrayContaining(['create', 'save', 'pre-restore', 'restore']));
  });

  it('404s a restore of an unknown revision id', async () => {
    const post = await createPost(owner);
    const res = await call(owner, 'POST', `/api/admin/posts/${post.id}/revisions/nope/restore`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/preview', () => {
  it('renders body_md to HTML without persisting anything', async () => {
    const res = await call(owner, 'POST', '/api/admin/preview', { body: { body_md: '# Title\n\nSome text.' } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.body_html).toContain('<h1');
  });
});
