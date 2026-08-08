import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleAuthorsApi } from './admin-authors.js';
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
  const response = await handleAuthorsApi(request, url, { env, ctx, identity });
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

describe('GET /api/admin/authors', () => {
  it('lists every author, visible to any signed-in role', async () => {
    const res = await call(author, 'GET', '/api/admin/authors');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.find((a) => a.email === 'grant@mysite.com')).toMatchObject({ role: 'owner', disabled: false });
  });
});

describe('POST /api/admin/authors', () => {
  it('creates an author as owner, defaulting role to "author"', async () => {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name: 'New Teammate', email: 'teammate@mysite.com' } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.role).toBe('author');
    expect(data.disabled).toBe(false);
    expect(data.email).toBe('teammate@mysite.com');
  });

  it('lower-cases the email so it matches however Access presents it', async () => {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Case Test', email: 'Mixed.Case@MySite.com' } });
    const { data } = await res.json();
    expect(data.email).toBe('mixed.case@mysite.com');
  });

  it('rejects a duplicate email with a field-tagged 409', async () => {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Dup', email: 'grant@mysite.com' } });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.field).toBe('email');
  });

  it('rejects a malformed email', async () => {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Bad Email', email: 'not-an-email' } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.field).toBe('email');
  });

  it('403s an editor', async () => {
    const res = await call(editor, 'POST', '/api/admin/authors', { body: { name: 'Should Not Exist', email: 'nope@mysite.com' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing Origin header', async () => {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Cross Origin', email: 'cross@mysite.com' }, noOrigin: true });
    expect(res.status).toBe(403);
  });

  it('writes an audit_log entry', async () => {
    await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Audited Author', email: 'audited@mysite.com' } });
    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE action = 'author.create' ORDER BY created_at DESC LIMIT 1`)
      .first();
    expect(row).toBeTruthy();
    expect(row.actor).toBe('grant@mysite.com');
    expect(JSON.parse(row.detail).email).toBe('audited@mysite.com');
  });
});

describe('PATCH /api/admin/authors/:id', () => {
  async function makeAuthor(name, email, role = 'author') {
    const res = await call(owner, 'POST', '/api/admin/authors', { body: { name, email, role } });
    return (await res.json()).data;
  }

  it('updates name and bio', async () => {
    const a = await makeAuthor('Rename Me', 'rename@mysite.com');
    const res = await call(owner, 'PATCH', `/api/admin/authors/${a.id}`, { body: { name: 'Renamed', bio: 'New bio' } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.name).toBe('Renamed');
    expect(data.bio).toBe('New bio');
  });

  it('logs the target account\'s email in the audit detail, not just the changed fields', async () => {
    const a = await makeAuthor('Role Change Me', 'rolechange@mysite.com');
    await call(owner, 'PATCH', `/api/admin/authors/${a.id}`, { body: { role: 'editor' } });
    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE action = 'author.update' AND entity_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(a.id)
      .first();
    const detail = JSON.parse(row.detail);
    expect(detail.email).toBe('rolechange@mysite.com');
    expect(detail.role).toBe('editor');
  });

  it('disables and re-enables a non-owner author', async () => {
    const a = await makeAuthor('Disable Me', 'disable@mysite.com');
    const off = await call(owner, 'PATCH', `/api/admin/authors/${a.id}`, { body: { disabled: true } });
    expect(off.status).toBe(200);
    expect((await off.json()).data.disabled).toBe(true);
    expect(await resolveAuthor(env.DB, 'disable@mysite.com')).toBeFalsy();

    const on = await call(owner, 'PATCH', `/api/admin/authors/${a.id}`, { body: { disabled: false } });
    expect((await on.json()).data.disabled).toBe(false);
    expect(await resolveAuthor(env.DB, 'disable@mysite.com')).toBeTruthy();
  });

  it('blocks disabling the only remaining active owner', async () => {
    const res = await call(owner, 'PATCH', `/api/admin/authors/${owner.author.id}`, { body: { disabled: true } });
    expect(res.status).toBe(409);
    expect(await resolveAuthor(env.DB, 'grant@mysite.com')).toBeTruthy();
  });

  it('blocks demoting the only remaining active owner away from owner', async () => {
    const res = await call(owner, 'PATCH', `/api/admin/authors/${owner.author.id}`, { body: { role: 'editor' } });
    expect(res.status).toBe(409);
    const stillOwner = await env.DB.prepare(`SELECT role FROM authors WHERE id = ?`).bind(owner.author.id).first();
    expect(stillOwner.role).toBe('owner');
  });

  it('allows disabling an owner when another active owner exists', async () => {
    const secondOwner = await makeAuthor('Second Owner', 'second-owner@mysite.com', 'owner');
    const res = await call(owner, 'PATCH', `/api/admin/authors/${secondOwner.id}`, { body: { disabled: true } });
    expect(res.status).toBe(200);
  });

  it('blocks disabling your own account even when another active owner exists', async () => {
    await makeAuthor('Self Disabler', 'self-disable@mysite.com', 'owner');
    const secondOwner = { email: 'self-disable@mysite.com', author: await resolveAuthor(env.DB, 'self-disable@mysite.com') };
    const res = await call(secondOwner, 'PATCH', `/api/admin/authors/${secondOwner.author.id}`, { body: { disabled: true } });
    expect(res.status).toBe(409);
    expect(await resolveAuthor(env.DB, 'self-disable@mysite.com')).toBeTruthy();
  });

  it('rejects a duplicate email on update', async () => {
    const a = await makeAuthor('Email Clash', 'clash@mysite.com');
    const res = await call(owner, 'PATCH', `/api/admin/authors/${a.id}`, { body: { email: 'ada@mysite.com' } });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.field).toBe('email');
  });

  it('404s an unknown id', async () => {
    const res = await call(owner, 'PATCH', '/api/admin/authors/not-a-real-id', { body: { name: 'x' } });
    expect(res.status).toBe(404);
  });

  it('403s an editor', async () => {
    const a = await makeAuthor('Protected From Editor', 'protected@mysite.com');
    const res = await call(editor, 'PATCH', `/api/admin/authors/${a.id}`, { body: { name: 'Hijacked' } });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/admin/authors/:id', () => {
  it('deletes an author and reassigns their posts to the acting owner', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/authors', { body: { name: 'To Delete', email: 'to-delete@mysite.com' } })).json();
    const target = created.data;
    const post = await env.DB.prepare(`SELECT id FROM posts LIMIT 1`).first();
    await env.DB.prepare(`UPDATE posts SET author_id = ? WHERE id = ?`).bind(target.id, post.id).run();

    const res = await call(owner, 'DELETE', `/api/admin/authors/${target.id}`);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT 1 FROM authors WHERE id = ?`).bind(target.id).first();
    expect(row).toBeFalsy();
    const reassigned = await env.DB.prepare(`SELECT author_id FROM posts WHERE id = ?`).bind(post.id).first();
    expect(reassigned.author_id).toBe(owner.author.id);
  });

  it('blocks deleting the only remaining active owner', async () => {
    const res = await call(owner, 'DELETE', `/api/admin/authors/${owner.author.id}`);
    expect(res.status).toBe(409);
    expect(await resolveAuthor(env.DB, 'grant@mysite.com')).toBeTruthy();
  });

  it('blocks deleting your own account even when another active owner exists', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Self Deleter', email: 'self-delete@mysite.com', role: 'owner' } })).json();
    const secondOwner = { email: 'self-delete@mysite.com', author: await resolveAuthor(env.DB, 'self-delete@mysite.com') };
    const res = await call(secondOwner, 'DELETE', `/api/admin/authors/${created.data.id}`);
    expect(res.status).toBe(409);
    expect(await resolveAuthor(env.DB, 'self-delete@mysite.com')).toBeTruthy();
  });

  it('404s an unknown id', async () => {
    const res = await call(owner, 'DELETE', '/api/admin/authors/not-a-real-id');
    expect(res.status).toBe(404);
  });

  it('403s an editor', async () => {
    const created = await (await call(owner, 'POST', '/api/admin/authors', { body: { name: 'Editor Cannot Delete', email: 'editor-cannot-delete@mysite.com' } })).json();
    const res = await call(editor, 'DELETE', `/api/admin/authors/${created.data.id}`);
    expect(res.status).toBe(403);
  });
});
