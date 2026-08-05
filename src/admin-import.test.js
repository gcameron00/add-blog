import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleImportApi } from './admin-import.js';
import { resolveAuthor } from './auth.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

// Same fixture family as src/admin-media.test.js (real 12x7 PNG), duplicated
// here rather than imported — this file is self-contained, per this
// project's existing test convention of not sharing fixtures across files.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAHAQMAAAAGfD5nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gccESQgBIauWgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yOFQxNzozNjozMiswMDowMP7sXxMAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjhUMTc6MzY6MzIrMDA6MDCPseevAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI4VDE3OjM2OjMyKzAwOjAw2KTGcAAAAAtJREFUCNdjYMACAAAVAAEyHTlgAAAAAElFTkSuQmCC';

function pngBytes() {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function wxrFixture() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
<title>Old Blog</title>
<link>https://old.example.com</link>
<wp:base_site_url>https://old.example.com</wp:base_site_url>
<item>
  <title>Hello World</title>
  <link>https://old.example.com/hello-world</link>
  <content:encoded><![CDATA[<p>Welcome. See <a href="https://old.example.com/second-post">the second post</a> and <a href="https://old.example.com/about">About</a>. Also an image: <img src="https://old.example.com/wp-content/uploads/2024/03/photo.jpg" alt="A photo"> and an <a href="https://unsplash.com/x">external link</a>.</p>]]></content:encoded>
  <dc:creator><![CDATA[old_admin]]></dc:creator>
  <wp:post_id>1</wp:post_id>
  <wp:post_date_gmt>2024-03-01 10:00:00</wp:post_date_gmt>
  <wp:post_name><![CDATA[hello-world]]></wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>post</wp:post_type>
  <category domain="category" nicename="blogging"><![CDATA[Blogging]]></category>
  <category domain="post_tag" nicename="intro"><![CDATA[intro]]></category>
  <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>900</wp:meta_value></wp:postmeta>
</item>
<item>
  <title>Second Post</title>
  <link>https://old.example.com/second-post</link>
  <content:encoded><![CDATA[<p>Just a second post.</p>]]></content:encoded>
  <wp:post_id>2</wp:post_id>
  <wp:post_date_gmt>2024-03-02 10:00:00</wp:post_date_gmt>
  <wp:post_name><![CDATA[second-post]]></wp:post_name>
  <wp:status>draft</wp:status>
  <wp:post_type>post</wp:post_type>
</item>
<item>
  <title>About</title>
  <link>https://old.example.com/about</link>
  <content:encoded><![CDATA[<p>About me.</p>]]></content:encoded>
  <wp:post_id>3</wp:post_id>
  <wp:post_name><![CDATA[about]]></wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>page</wp:post_type>
</item>
<item>
  <title>photo.jpg</title>
  <link>https://old.example.com/photo</link>
  <wp:post_id>900</wp:post_id>
  <wp:post_name><![CDATA[photo]]></wp:post_name>
  <wp:status>inherit</wp:status>
  <wp:post_type>attachment</wp:post_type>
  <wp:attachment_url><![CDATA[https://old.example.com/wp-content/uploads/2024/03/photo.jpg]]></wp:attachment_url>
</item>
</channel>
</rss>`;
}

function importReq(path, xmlText, { noOrigin = false } = {}) {
  const url = new URL(`https://${ADMIN_HOST}${path}`);
  const formData = new FormData();
  if (xmlText !== undefined) formData.append('file', new File([xmlText], 'export.xml', { type: 'text/xml' }));
  const headers = noOrigin ? {} : { Origin: url.origin };
  return { request: new Request(url, { method: 'POST', headers, body: formData }), url };
}

async function callImport(identity, { request, url }) {
  const ctx = createExecutionContext();
  const response = await handleImportApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

function stubFetchOk() {
  vi.stubGlobal('fetch', async () => {
    const bytes = pngBytes();
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength) },
    });
  });
}

let owner;
let author;

beforeAll(async () => {
  owner = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
  await env.DB
    .prepare(`INSERT INTO authors (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('imp-author', 'import-author@mysite.com', 'Import Author', 'author', '2026-07-01T00:00:00Z')
    .run();
  author = { email: 'import-author@mysite.com', author: await resolveAuthor(env.DB, 'import-author@mysite.com') };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/admin/import/preview', () => {
  it('reports counts and link findings without writing anything', async () => {
    const res = await callImport(owner, importReq('/api/admin/import/preview', wxrFixture()));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.posts_to_create).toBe(2);
    expect(data.posts_skipped_duplicate).toBe(0);
    expect(data.pages_dropped).toEqual([{ title: 'About', link: 'https://old.example.com/about' }]);
    expect(data.media_to_fetch).toBe(1);
    expect(data.tags_to_create.sort()).toEqual(['Blogging', 'intro']);
    expect(data.links_to_dropped_pages).toEqual([{ post_slug: 'hello-world', target_url: 'https://old.example.com/about' }]);

    const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE slug IN ('hello-world','second-post')`).first();
    expect(existing.n).toBe(0);
    const mediaRows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media`).first();
    expect(mediaRows.n).toBe(0);
  });

  it('403s a non-owner identity — import is owner-only', async () => {
    const res = await callImport(author, importReq('/api/admin/import/preview', wxrFixture()));
    expect(res.status).toBe(403);
  });

  it('rejects a file that is not a WXR export', async () => {
    const res = await callImport(owner, importReq('/api/admin/import/preview', '<html><body>not wxr</body></html>'));
    expect(res.status).toBe(400);
  });

  it('rejects a missing Origin header', async () => {
    const res = await callImport(owner, importReq('/api/admin/import/preview', wxrFixture(), { noOrigin: true }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/import/run', () => {
  it('creates posts, uploads media, merges tags, rewrites links, and audits with via=import', async () => {
    stubFetchOk();
    const res = await callImport(owner, importReq('/api/admin/import/run', wxrFixture()));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.posts_created).toBe(2);
    expect(data.posts_skipped).toBe(0);
    expect(data.posts_failed).toEqual([]);
    expect(data.media_uploaded).toBe(1);
    expect(data.media_failed).toEqual([]);
    expect(data.links_rewritten).toBeGreaterThanOrEqual(2); // the second-post link + the image
    expect(data.links_to_dropped_pages).toEqual([{ post_slug: 'hello-world', target_url: 'https://old.example.com/about' }]);

    const hello = await env.DB.prepare(`SELECT * FROM posts WHERE slug = 'hello-world'`).first();
    expect(hello).toBeTruthy();
    expect(hello.status).toBe('published');
    expect(hello.author_id).toBe(owner.author.id); // WXR author record ignored — the importing admin is the author
    expect(hello.created_at).toBe('2024-03-01T10:00:00.000Z'); // original WP date preserved, not import time
    expect(hello.published_at).toBe('2024-03-01T10:00:00.000Z');
    expect(hello.body_md).toContain('[the second post](/posts/second-post)'); // internal link rewritten
    expect(hello.body_md).toContain('https://old.example.com/about'); // link to a dropped page left as-is, not silently broken further
    expect(hello.body_md).toMatch(/\]\(\/media\//); // image rewritten to the new media URL
    expect(hello.cover_key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{16}-photo\.jpg$/); // _thumbnail_id resolved to the uploaded attachment

    const second = await env.DB.prepare(`SELECT status, created_at FROM posts WHERE slug = 'second-post'`).first();
    expect(second.status).toBe('draft'); // a non-publish WP status always becomes draft
    expect(second.created_at).toBe('2024-03-02T10:00:00.000Z');

    const tags = await env.DB
      .prepare(`SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id JOIN posts p ON p.id = pt.post_id WHERE p.slug = 'hello-world'`)
      .all();
    expect(tags.results.map((r) => r.name).sort()).toEqual(['Blogging', 'intro']); // category + post_tag merged into one tag set

    const revision = await env.DB
      .prepare(`SELECT note FROM revisions r JOIN posts p ON p.id = r.post_id WHERE p.slug = 'hello-world'`)
      .first();
    expect(revision.note).toBe('import');

    const audit = await env.DB
      .prepare(`SELECT actor, via FROM audit_log WHERE action = 'post.create' AND via = 'import'`)
      .all();
    expect(audit.results.length).toBeGreaterThanOrEqual(2);
    expect(audit.results.every((r) => r.actor === owner.email)).toBe(true);
  });

  it('re-running the same file skips already-imported posts and does not duplicate the media row', async () => {
    stubFetchOk();
    const res = await callImport(owner, importReq('/api/admin/import/run', wxrFixture()));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.posts_created).toBe(0);
    expect(data.posts_skipped).toBe(2);

    const postCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posts WHERE slug IN ('hello-world','second-post')`).first();
    expect(postCount.n).toBe(2); // still exactly one row each, not duplicated

    const mediaCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media`).first();
    expect(mediaCount.n).toBe(1); // checksum dedupe — no second media row for the same bytes
  });

  it('reports a dead media link without failing the rest of the import', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    const xml = wxrFixture().replaceAll('hello-world', 'hello-world-2').replaceAll('second-post', 'second-post-2');
    const res = await callImport(owner, importReq('/api/admin/import/run', xml));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.media_failed).toHaveLength(1);
    expect(data.media_failed[0].url).toContain('photo.jpg');
    expect(data.posts_created).toBe(2); // the rest of the import still completes

    const post = await env.DB.prepare(`SELECT cover_key FROM posts WHERE slug = 'hello-world-2'`).first();
    expect(post.cover_key).toBeNull(); // the cover that failed to fetch is simply absent, not a crash
  });

  it('resolves an inline image against a "-scaled" attachment original, not just an exact URL match', async () => {
    // WordPress ≥5.3 auto-scales any upload over its "big image" threshold —
    // the attachment's own URL becomes "…-scaled.jpg", while post content
    // displays a registered size like "…-1024x768.jpg". Neither string is
    // the other, so this only resolves via the shared stripSizeSuffix()
    // normalization in src/admin-import.js's buildRewriter.
    stubFetchOk();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
<title>Old Blog</title>
<link>https://old.example.com</link>
<wp:base_site_url>https://old.example.com</wp:base_site_url>
<item>
  <title>Big Photo Post</title>
  <link>https://old.example.com/big-photo-post</link>
  <content:encoded><![CDATA[<p>Look: <img src="https://old.example.com/wp-content/uploads/2024/05/img-1234-1024x768.jpg" alt="Big"></p>]]></content:encoded>
  <wp:post_id>10</wp:post_id>
  <wp:post_date_gmt>2024-05-01 10:00:00</wp:post_date_gmt>
  <wp:post_name><![CDATA[big-photo-post]]></wp:post_name>
  <wp:status>publish</wp:status>
  <wp:post_type>post</wp:post_type>
</item>
<item>
  <title>img-1234.jpg</title>
  <link>https://old.example.com/img-1234</link>
  <wp:post_id>11</wp:post_id>
  <wp:post_name><![CDATA[img-1234]]></wp:post_name>
  <wp:status>inherit</wp:status>
  <wp:post_type>attachment</wp:post_type>
  <wp:attachment_url><![CDATA[https://old.example.com/wp-content/uploads/2024/05/img-1234-scaled.jpg]]></wp:attachment_url>
</item>
</channel>
</rss>`;

    const res = await callImport(owner, importReq('/api/admin/import/run', xml));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.links_unresolved).toEqual([]);
    expect(data.links_rewritten).toBe(1);

    const post = await env.DB.prepare(`SELECT body_md FROM posts WHERE slug = 'big-photo-post'`).first();
    expect(post.body_md).toMatch(/\]\(\/media\//);
  });

  it('403s a non-owner identity — import is owner-only', async () => {
    const res = await callImport(author, importReq('/api/admin/import/run', wxrFixture()));
    expect(res.status).toBe(403);
  });
});

describe('guard behaviour', () => {
  it('is unreachable with no identity', async () => {
    const result = await callImport(null, importReq('/api/admin/import/preview', wxrFixture()));
    expect(result).toBeNull();
  });
});
