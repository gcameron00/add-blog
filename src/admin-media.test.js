import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleMediaApi } from './admin-media.js';
import { handlePostsApi } from './admin-posts.js';
import { resolveAuthor } from './auth.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

// Real 12x7 PNG (ImageMagick `magick -size 12x7 xc:red test.png`) — same
// fixture family as src/media-parse.test.js, duplicated here rather than
// imported so this file doesn't depend on another test file's internals.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAHAQMAAAAGfD5nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gccESQgBIauWgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yOFQxNzozNjozMiswMDowMP7sXxMAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjhUMTc6MzY6MzIrMDA6MDCPseevAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI4VDE3OjM2OjMyKzAwOjAw2KTGcAAAAAtJREFUCNdjYMACAAAVAAEyHTlgAAAAAElFTkSuQmCC';

// A real, parseable 12x7 PNG plus a trailing, unique tag appended after the
// IEND chunk — detectDimensions() only ever reads the fixed-offset IHDR
// near the front, so this doesn't affect parsing, but it gives each test
// its own checksum. Without this, every test in this file would upload
// byte-identical "different" files and collide with the dedupe logic this
// suite is specifically testing.
function pngBytes(seed) {
  const binary = atob(PNG_BASE64);
  const tag = seed ? `#${seed}` : '';
  const bytes = new Uint8Array(binary.length + tag.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  for (let i = 0; i < tag.length; i++) bytes[binary.length + i] = tag.charCodeAt(i);
  return bytes;
}

function pngFile(name = 'photo.png', seed = name) {
  return new File([pngBytes(seed)], name, { type: 'image/png' });
}

function uploadReq(path, { file, alt, noOrigin = false } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const formData = new FormData();
  if (file) formData.append('file', file);
  if (alt !== undefined) formData.append('alt', alt);
  const headers = noOrigin ? {} : { Origin: url.origin };
  return { request: new Request(url, { method: 'POST', headers, body: formData }), url };
}

function jsonReq(method, path, { body, headers = {}, noOrigin = false } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (!noOrigin) finalHeaders.Origin = url.origin;
  return { request: new Request(url, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined }), url };
}

async function callMedia(identity, { request, url }) {
  const ctx = createExecutionContext();
  const response = await handleMediaApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function callPosts(identity, { request, url }) {
  const ctx = createExecutionContext();
  const response = await handlePostsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function upload(identity, opts) {
  const res = await callMedia(identity, uploadReq('/api/admin/media', opts));
  return res;
}

let owner;
let editor;
let author;

beforeAll(async () => {
  owner = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
  editor = { email: 'ada@mysite.com', author: await resolveAuthor(env.DB, 'ada@mysite.com') };
  await env.DB
    .prepare(`INSERT INTO authors (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('m-author', 'media-author@mysite.com', 'Media Author', 'author', '2026-07-01T00:00:00Z')
    .run();
  author = { email: 'media-author@mysite.com', author: await resolveAuthor(env.DB, 'media-author@mysite.com') };
});

describe('POST /api/admin/media', () => {
  it('uploads a PNG, detects dimensions, stores in R2 and D1, and audits it', async () => {
    const res = await upload(owner, { file: pngFile('routing.png'), alt: 'A routing diagram' });
    expect(res.status).toBe(201);
    const { data } = await res.json();

    expect(data.key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{16}-routing\.png$/);
    expect(data.url).toBe(`/media/${data.key}`);
    expect(data.width).toBe(12);
    expect(data.height).toBe(7);
    expect(data.content_type).toBe('image/png');
    expect(data.alt).toBe('A routing diagram');
    expect(data.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(data.uploaded_by).toBe(owner.author.id);
    expect(data.used_by).toBe(0);

    const object = await env.MEDIA.get(data.key);
    expect(object).toBeTruthy();
    expect(object.size).toBe(pngBytes('routing.png').byteLength);

    const auditRow = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE action = 'media.upload' AND entity_id = ?`)
      .bind(data.key)
      .first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.actor).toBe('grant@mysite.com');
  });

  it('rejects an upload with no file', async () => {
    const res = await upload(owner, {});
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.field).toBe('file');
  });

  it('rejects a disallowed content type (415), including SVG', async () => {
    const svg = new File(['<svg onload="alert(1)"></svg>'], 'x.svg', { type: 'image/svg+xml' });
    const res = await upload(owner, { file: svg });
    expect(res.status).toBe(415);
  });

  it('rejects an oversized file (413)', async () => {
    const big = new File([new Uint8Array(26 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const res = await upload(owner, { file: big });
    expect(res.status).toBe(413);
  });

  it('rejects a non-multipart body', async () => {
    const res = await callMedia(owner, jsonReq('POST', '/api/admin/media', { body: { file: 'nope' } }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing Origin header', async () => {
    const res = await upload(owner, { file: pngFile(), noOrigin: true });
    expect(res.status).toBe(403);
  });

  it('is idempotent for identical bytes — returns the existing object, not a duplicate', async () => {
    const first = await upload(owner, { file: pngFile('same.png', 'dedupe-seed'), alt: 'first' });
    const firstBody = await first.json();
    expect(first.status).toBe(201);

    // Different filename, same seed → same bytes → same checksum: proves
    // dedupe is content-based, not filename-based.
    const second = await upload(editor, { file: pngFile('same-again.png', 'dedupe-seed'), alt: 'second' });
    expect(second.status).toBe(200); // not 201 — no new object created
    const secondBody = await second.json();
    expect(secondBody.data.key).toBe(firstBody.data.key);
    expect(secondBody.data.alt).toBe('first'); // the original record, unchanged

    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media WHERE checksum = ?`).bind(firstBody.data.checksum).first();
    expect(rows.n).toBe(1);
  });

  it('lets an author-role identity upload', async () => {
    const res = await upload(author, { file: pngFile('author-upload.png'), alt: 'x' });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/admin/media', () => {
  it('lists uploads with a page envelope', async () => {
    await upload(owner, { file: pngFile('list-a.png'), alt: 'a' });
    await upload(owner, { file: pngFile('list-b.png'), alt: 'b' });
    const res = await callMedia(owner, jsonReq('GET', '/api/admin/media'));
    expect(res.status).toBe(200);
    const { data, page } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(page).toMatchObject({ limit: expect.any(Number), offset: 0 });
  });

  it('filters by type', async () => {
    await upload(owner, { file: pngFile('typed.png'), alt: 'x' });
    const pdf = new File([new Uint8Array([1, 2, 3])], 'doc.pdf', { type: 'application/pdf' });
    await upload(owner, { file: pdf, alt: 'a document' });

    const res = await callMedia(owner, jsonReq('GET', '/api/admin/media?type=image'));
    const { data } = await res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((m) => m.content_type.startsWith('image/'))).toBe(true);
  });

  it('filters by q against filename and alt', async () => {
    await upload(owner, { file: pngFile('unique-needle.png'), alt: 'x' });
    const res = await callMedia(owner, jsonReq('GET', '/api/admin/media?q=needle'));
    const { data } = await res.json();
    expect(data.some((m) => m.filename === 'unique-needle.png')).toBe(true);
  });

  it('unused=true excludes media referenced by a post, and usage shows the referencing post', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('cover-candidate.png'), alt: 'x' })).json();
    const key = uploaded.data.key;

    const postRes = await callPosts(owner, jsonReq('POST', '/api/admin/posts', {
      body: { title: 'Post with a cover', cover_key: key },
    }));
    expect(postRes.status).toBe(201);

    const unused = await (await callMedia(owner, jsonReq('GET', '/api/admin/media?unused=true'))).json();
    expect(unused.data.some((m) => m.key === key)).toBe(false);

    const usage = await (await callMedia(owner, jsonReq('GET', `/api/admin/media/${encodeURIComponent(key)}/usage`))).json();
    expect(usage.data.some((p) => p.title === 'Post with a cover')).toBe(true);

    const listed = await (await callMedia(owner, jsonReq('GET', '/api/admin/media'))).json();
    expect(listed.data.find((m) => m.key === key).used_by).toBe(1);
  });
});

describe('PATCH /api/admin/media/:key', () => {
  it('updates alt text', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('patchable.png'), alt: 'old' })).json();
    const res = await callMedia(owner, jsonReq('PATCH', `/api/admin/media/${encodeURIComponent(uploaded.data.key)}`, {
      body: { alt: 'new alt text' },
    }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.alt).toBe('new alt text');
  });

  it('404s an unknown key', async () => {
    const res = await callMedia(owner, jsonReq('PATCH', '/api/admin/media/does/not/exist.png', { body: { alt: 'x' } }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/media/:key', () => {
  it('deletes an unused file from both R2 and D1', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('deletable.png'), alt: 'x' })).json();
    const key = uploaded.data.key;

    const res = await callMedia(owner, jsonReq('DELETE', `/api/admin/media/${encodeURIComponent(key)}`));
    expect(res.status).toBe(200);
    expect(await env.MEDIA.get(key)).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM media WHERE key = ?`).bind(key).first()).toBeFalsy();
  });

  it('409s deleting a file referenced by a post, without force', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('guarded.png'), alt: 'x' })).json();
    const key = uploaded.data.key;
    await callPosts(owner, jsonReq('POST', '/api/admin/posts', { body: { title: 'Guards this cover', cover_key: key } }));

    const res = await callMedia(owner, jsonReq('DELETE', `/api/admin/media/${encodeURIComponent(key)}`));
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.detail.referencing[0].title).toBe('Guards this cover');
    expect(await env.MEDIA.get(key)).toBeTruthy(); // not deleted
  });

  it('force=true deletes despite being referenced', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('force-deletable.png'), alt: 'x' })).json();
    const key = uploaded.data.key;
    await callPosts(owner, jsonReq('POST', '/api/admin/posts', { body: { title: 'Force this cover', cover_key: key } }));

    const res = await callMedia(owner, jsonReq('DELETE', `/api/admin/media/${encodeURIComponent(key)}?force=true`));
    expect(res.status).toBe(200);
    expect(await env.MEDIA.get(key)).toBeNull();
  });

  it('403s an author-role identity (delete is owner/editor only)', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('author-cannot-delete.png'), alt: 'x' })).json();
    const res = await callMedia(author, jsonReq('DELETE', `/api/admin/media/${encodeURIComponent(uploaded.data.key)}`));
    expect(res.status).toBe(403);
  });

  it('lets an editor delete', async () => {
    const uploaded = await (await upload(owner, { file: pngFile('editor-can-delete.png'), alt: 'x' })).json();
    const res = await callMedia(editor, jsonReq('DELETE', `/api/admin/media/${encodeURIComponent(uploaded.data.key)}`));
    expect(res.status).toBe(200);
  });
});

describe('guard behaviour', () => {
  it('is unreachable with no identity', async () => {
    const result = await callMedia(null, jsonReq('GET', '/api/admin/media'));
    expect(result).toBeNull();
  });
});
