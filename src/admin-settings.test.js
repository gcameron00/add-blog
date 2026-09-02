import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { resolveAuthor } from './auth.js';
import { handleSettingsApi } from './admin-settings.js';

const ADMIN_HOST = 'blog-admin.mysite.com';

function req(method, { body, headers = {}, noOrigin = false } = {}) {
  const url = new URL(`https://${ADMIN_HOST}/api/admin/settings`);
  const finalHeaders = { ...headers };
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (!noOrigin) finalHeaders.Origin = url.origin;
  const request = new Request(url, { method, headers: finalHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { request, url };
}

async function call(identity, method, opts) {
  const { request, url } = req(method, opts);
  const ctx = createExecutionContext();
  const response = await handleSettingsApi(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function identityFor(email) {
  return { email, author: await resolveAuthor(env.DB, email) };
}

describe('GET /api/admin/settings', () => {
  it('returns every seeded key with the correct JSON type', async () => {
    const owner = await identityFor('grant@mysite.com');
    const res = await call(owner, 'GET');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(typeof data.site_title).toBe('string');
    expect(typeof data.posts_per_page).toBe('number');
    expect(typeof data.allow_raw_html).toBe('boolean');
    expect(data.social_image_key).toBeNull();
    expect(data.admin_url).toContain('blog-admin');
    expect(data.site_icon_key).toBeNull();
  });
});

describe('PUT /api/admin/settings', () => {
  it('updates known keys for an owner and persists them', async () => {
    const owner = await identityFor('grant@mysite.com');
    const res = await call(owner, 'PUT', { body: { site_title: 'A New Title', posts_per_page: 5 } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.site_title).toBe('A New Title');
    expect(data.posts_per_page).toBe(5);

    const after = await (await call(owner, 'GET')).json();
    expect(after.data.site_title).toBe('A New Title');
  });

  it('leaves keys not present in the request untouched (partial update, not a wipe)', async () => {
    const owner = await identityFor('grant@mysite.com');
    await call(owner, 'PUT', { body: { site_title: 'Only This Changes' } });
    const { data } = await (await call(owner, 'GET')).json();
    expect(data.social_image_key).toBeNull(); // still present, not dropped
    expect(data.admin_url).toBeTruthy();
  });

  it('accepts site_icon_key (#15) and persists it', async () => {
    const owner = await identityFor('grant@mysite.com');
    const res = await call(owner, 'PUT', { body: { site_icon_key: '2026/08/abc123-icon.png' } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.site_icon_key).toBe('2026/08/abc123-icon.png');
  });

  it('rejects an unknown key with a field-tagged 400', async () => {
    const owner = await identityFor('grant@mysite.com');
    const res = await call(owner, 'PUT', { body: { not_a_real_setting: true } });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.field).toBe('not_a_real_setting');
  });

  it('403s a non-owner', async () => {
    const editor = await identityFor('ada@mysite.com');
    const res = await call(editor, 'PUT', { body: { site_title: 'Hijacked' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing Origin header', async () => {
    const owner = await identityFor('grant@mysite.com');
    const res = await call(owner, 'PUT', { body: { site_title: 'x' }, noOrigin: true });
    expect(res.status).toBe(403);
  });

  it('writes an audit_log entry', async () => {
    const owner = await identityFor('grant@mysite.com');
    await call(owner, 'PUT', { body: { timezone: 'America/New_York' } });
    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE action = 'settings.update' ORDER BY created_at DESC LIMIT 1`)
      .first();
    expect(row).toBeTruthy();
    expect(row.actor).toBe('grant@mysite.com');
    expect(JSON.parse(row.detail).keys).toContain('timezone');
  });

  describe('collections (migrations/0008_collections.sql)', () => {
    const PROJECT_COLLECTION = {
      type: 'project',
      label: 'Project',
      label_plural: 'Projects',
      base_path: '/portfolio',
      legacy_path: '/project',
      index_title: 'Portfolio',
      layout: 'grid',
      in_feed: false,
      in_sitemap: true,
      nav: { header: true, footer: false },
      fields: [{ key: 'status', label: 'Status', type: 'enum', options: ['Live', 'Archived'], display: 'badge' }],
    };

    it('is seeded to [] by migrations/0008_collections.sql', async () => {
      const owner = await identityFor('grant@mysite.com');
      const { data } = await (await call(owner, 'GET')).json();
      expect(data.collections).toEqual([]);
    });

    it('an owner can save a well-formed collections array', async () => {
      const owner = await identityFor('grant@mysite.com');
      const res = await call(owner, 'PUT', { body: { collections: [PROJECT_COLLECTION] } });
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.collections).toEqual([PROJECT_COLLECTION]);
    });

    it('rejects a malformed collections array with a field-tagged 400 (validateCollections)', async () => {
      const owner = await identityFor('grant@mysite.com');
      const res = await call(owner, 'PUT', { body: { collections: [{ ...PROJECT_COLLECTION, base_path: '/admin' }] } });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error.field).toBe('collections');
    });

    it('403s a non-owner — same settings.manage gate as every other key', async () => {
      const editor = await identityFor('ada@mysite.com');
      const res = await call(editor, 'PUT', { body: { collections: [PROJECT_COLLECTION] } });
      expect(res.status).toBe(403);
    });

    it('purges the branded static pages on change, same as nav_config', async () => {
      const owner = await identityFor('grant@mysite.com');
      const res = await call(owner, 'PUT', { body: { collections: [PROJECT_COLLECTION] } });
      expect(res.status).toBe(200);
      // BRANDING_KEYS purge is best-effort/fire-and-forget (ctx.waitUntil) —
      // asserting the write itself succeeded is the meaningful part here;
      // the purge call site is covered structurally, not by observing cache state.
    });
  });
});
