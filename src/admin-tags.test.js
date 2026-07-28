import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTagsApi } from './admin-tags.js';
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
  const response = await handleTagsApi(request, url, { env, ctx, identity });
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
    .prepare(`INSERT OR IGNORE INTO authors (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('a3', 'author-role@mysite.com', 'Author Role', 'author', '2026-07-01T00:00:00Z')
    .run();
  author = { email: 'author-role@mysite.com', author: await resolveAuthor(env.DB, 'author-role@mysite.com') };
});

describe('GET /api/admin/tags', () => {
  it('lists every tag, including ones on zero posts, with a post_count', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Brand New Unused Tag' } })).json();

    const res = await call(owner, 'GET', '/api/admin/tags');
    expect(res.status).toBe(200);
    const { data } = await res.json();

    const withPosts = data.find((t) => t.slug === 'cloudflare');
    expect(withPosts).toBeTruthy();
    expect(withPosts.post_count).toBeGreaterThan(0);

    const unused = data.find((t) => t.id === created.data.id);
    expect(unused).toBeTruthy();
    expect(unused.post_count).toBe(0);
  });
});

describe('POST /api/admin/tags', () => {
  it('creates a tag as owner, deriving the slug from the name', async () => {
    const res = await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Edge Computing' } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.slug).toBe('edge-computing');
    expect(data.name).toBe('Edge Computing');
    expect(data.post_count).toBe(0);
  });

  it('creates a tag as editor', async () => {
    const res = await call(editor, 'POST', '/api/admin/tags', { body: { name: 'Editor Made This' } });
    expect(res.status).toBe(201);
  });

  it('rejects a duplicate slug with a field-tagged 409', async () => {
    await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Duplicate Me' } });
    const res = await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Duplicate Me' } });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.field).toBe('slug');
  });

  it('rejects an empty name', async () => {
    const res = await call(owner, 'POST', '/api/admin/tags', { body: { name: '' } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.field).toBe('name');
  });

  it('403s an author-role identity', async () => {
    const res = await call(author, 'POST', '/api/admin/tags', { body: { name: 'Should Not Exist' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing Origin header', async () => {
    const res = await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Cross Origin' }, noOrigin: true });
    expect(res.status).toBe(403);
  });

  it('writes an audit_log entry', async () => {
    await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Audited Tag' } });
    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE action = 'tag.create' ORDER BY created_at DESC LIMIT 1`)
      .first();
    expect(row).toBeTruthy();
    expect(row.actor).toBe('grant@mysite.com');
    expect(JSON.parse(row.detail).name).toBe('Audited Tag');
  });
});

describe('PATCH /api/admin/tags/:id', () => {
  async function makeTag(name) {
    const res = await call(owner, 'POST', '/api/admin/tags', { body: { name } });
    return (await res.json()).data;
  }

  it('renames a tag', async () => {
    const tag = await makeTag('Rename Me');
    const res = await call(owner, 'PATCH', `/api/admin/tags/${tag.id}`, { body: { name: 'Renamed' } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.name).toBe('Renamed');
    expect(data.slug).toBe(tag.slug); // slug untouched unless explicitly changed
  });

  it('re-slugs a tag and rejects a collision', async () => {
    const a = await makeTag('Reslug A');
    const b = await makeTag('Reslug B');
    const ok = await call(owner, 'PATCH', `/api/admin/tags/${a.id}`, { body: { slug: 'reslug-taken' } });
    expect(ok.status).toBe(200);
    const clash = await call(owner, 'PATCH', `/api/admin/tags/${b.id}`, { body: { slug: 'reslug-taken' } });
    expect(clash.status).toBe(409);
  });

  it('404s an unknown id', async () => {
    const res = await call(owner, 'PATCH', '/api/admin/tags/not-a-real-id', { body: { name: 'x' } });
    expect(res.status).toBe(404);
  });

  it('403s an author-role identity', async () => {
    const tag = await makeTag('Protected From Author');
    const res = await call(author, 'PATCH', `/api/admin/tags/${tag.id}`, { body: { name: 'Hijacked' } });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/admin/tags/:id', () => {
  it('deletes a tag and detaches it from any post that carried it', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'To Delete' } })).json();
    const tag = created.data;
    const post = await env.DB.prepare(`SELECT id FROM posts LIMIT 1`).first();
    await env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post.id, tag.id).run();

    const res = await call(owner, 'DELETE', `/api/admin/tags/${tag.id}`);
    expect(res.status).toBe(200);

    const link = await env.DB.prepare(`SELECT 1 FROM post_tags WHERE tag_id = ?`).bind(tag.id).first();
    expect(link).toBeFalsy();
    const row = await env.DB.prepare(`SELECT 1 FROM tags WHERE id = ?`).bind(tag.id).first();
    expect(row).toBeFalsy();
  });

  it('404s an unknown id', async () => {
    const res = await call(owner, 'DELETE', '/api/admin/tags/not-a-real-id');
    expect(res.status).toBe(404);
  });

  it('403s an author-role identity', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Author Cannot Delete' } })).json();
    const res = await call(author, 'DELETE', `/api/admin/tags/${created.data.id}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/tags/merge', () => {
  it('folds one tag into another and carries its posts over', async () => {
    const from = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Merge Source' } })).json();
    const into = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Merge Target' } })).json();
    const post = await env.DB.prepare(`SELECT id FROM posts LIMIT 1`).first();
    await env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post.id, from.data.id).run();

    const res = await call(owner, 'POST', '/api/admin/tags/merge', {
      body: { from: [from.data.slug], into: into.data.slug },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.post_count).toBe(1);

    const sourceGone = await env.DB.prepare(`SELECT 1 FROM tags WHERE id = ?`).bind(from.data.id).first();
    expect(sourceGone).toBeFalsy();
    const link = await env.DB.prepare(`SELECT 1 FROM post_tags WHERE post_id = ? AND tag_id = ?`).bind(post.id, into.data.id).first();
    expect(link).toBeTruthy();
  });

  it('does not duplicate a post_tags row when the post already carries the target tag', async () => {
    const from = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Dup Source' } })).json();
    const into = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Dup Target' } })).json();
    const post = await env.DB.prepare(`SELECT id FROM posts LIMIT 1`).first();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post.id, from.data.id),
      env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post.id, into.data.id),
    ]);

    const res = await call(owner, 'POST', '/api/admin/tags/merge', {
      body: { from: [from.data.slug], into: into.data.slug },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.post_count).toBe(1);
  });

  it('404s an unknown slug', async () => {
    const into = await (await call(owner, 'POST', '/api/admin/tags', { body: { name: 'Real Target' } })).json();
    const res = await call(owner, 'POST', '/api/admin/tags/merge', {
      body: { from: ['not-a-real-slug'], into: into.data.slug },
    });
    expect(res.status).toBe(404);
  });

  it('403s an author-role identity', async () => {
    const res = await call(author, 'POST', '/api/admin/tags/merge', { body: { from: ['a'], into: 'b' } });
    expect(res.status).toBe(403);
  });
});
