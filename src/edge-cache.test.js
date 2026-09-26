import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import { purgePostUrls } from './cache-purge.js';
import { edgeCacheKey, isEdgeCacheable } from './edge-cache.js';

const HOST = 'blog.mysite.com';
const ADMIN_HOST = 'blog-admin.mysite.com';
const SLUG = 'shipping-a-blog-on-cloudflare-workers';

// vitest.config.js turns the edge cache off for SELF; these call the Worker
// directly with it back on, and wait for the background put each time.
async function fetchWithCache(url, init) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), { ...env, EDGE_CACHE: 'on' }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const touched = new Set();
function url(path, host = HOST) {
  const href = `https://${host}${path}`;
  touched.add(href);
  return href;
}

afterEach(async () => {
  await Promise.all([...touched].map((href) => caches.default.delete(href)));
  touched.clear();
});

describe('edge cache', () => {
  it('misses, then hits, for a published post permalink', async () => {
    const first = await fetchWithCache(url(`/posts/${SLUG}`));
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Edge-Cache')).toBe('MISS');
    const firstBody = await first.text();

    const second = await fetchWithCache(url(`/posts/${SLUG}`));
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(await second.text()).toBe(firstBody);
  });

  it('still sends the security headers on a cached copy', async () => {
    await fetchWithCache(url(`/posts/${SLUG}`));
    const hit = await fetchWithCache(url(`/posts/${SLUG}`));
    expect(hit.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(hit.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(hit.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('shares one entry across tracking parameters', async () => {
    await fetchWithCache(url(`/posts/${SLUG}`));
    const shared = await fetchWithCache(url(`/posts/${SLUG}?utm_source=whatsapp&fbclid=abc`));
    expect(shared.headers.get('X-Edge-Cache')).toBe('HIT');
  });

  it('is cleared by the existing post purge', async () => {
    await fetchWithCache(url(`/posts/${SLUG}`));
    await purgePostUrls(`https://${HOST}`, { slug: SLUG });
    const after = await fetchWithCache(url(`/posts/${SLUG}`));
    expect(after.headers.get('X-Edge-Cache')).toBe('MISS');
  });

  it('caches the public JSON API', async () => {
    await fetchWithCache(url(`/api/posts/${SLUG}`));
    const hit = await fetchWithCache(url(`/api/posts/${SLUG}`));
    expect(hit.headers.get('X-Edge-Cache')).toBe('HIT');
  });

  it('never caches a 404', async () => {
    await fetchWithCache(url('/posts/does-not-exist'));
    const again = await fetchWithCache(url('/posts/does-not-exist'));
    expect(again.status).toBe(404);
    expect(again.headers.get('X-Edge-Cache')).toBeNull();
  });

  it('never caches on the admin host', async () => {
    await fetchWithCache(url(`/posts/${SLUG}`, ADMIN_HOST));
    const again = await fetchWithCache(url(`/posts/${SLUG}`, ADMIN_HOST));
    expect(again.headers.get('X-Edge-Cache')).toBeNull();
  });

  it('still 404s admin paths on the public host, never a cached page', async () => {
    const res = await fetchWithCache(url('/admin/'));
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Edge-Cache')).toBeNull();
  });

  it('leaves non-GET requests alone', async () => {
    await fetchWithCache(url(`/posts/${SLUG}`));
    const head = await fetchWithCache(url(`/posts/${SLUG}`), { method: 'HEAD' });
    expect(head.headers.get('X-Edge-Cache')).toBeNull();
  });

  it('leaves Workers static assets (CSS/JS) to their own caching', async () => {
    const res = await fetchWithCache(url('/assets/css/styles.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Edge-Cache')).toBeNull();
  });
});

describe('edgeCacheKey', () => {
  it('drops tracking parameters but keeps meaningful ones', () => {
    const key = edgeCacheKey(new Request('https://x.test/api/posts?tag=ski&utm_medium=social&gclid=1'));
    expect(key).toBe('https://x.test/api/posts?tag=ski');
  });
});

describe('isEdgeCacheable', () => {
  const res = (cacheControl, status = 200, extra = {}) =>
    new Response('x', { status, headers: { 'Cache-Control': cacheControl, ...extra } });

  it('accepts public responses with s-maxage or immutable', () => {
    expect(isEdgeCacheable(res('public, max-age=60, s-maxage=3600'))).toBe(true);
    expect(isEdgeCacheable(res('public, max-age=31536000, immutable'))).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isEdgeCacheable(res('public, max-age=0, must-revalidate'))).toBe(false);
    expect(isEdgeCacheable(res('private, no-store'))).toBe(false);
    expect(isEdgeCacheable(res('public, s-maxage=60', 404))).toBe(false);
    expect(isEdgeCacheable(res('public, s-maxage=60', 200, { 'Set-Cookie': 'a=b' }))).toBe(false);
    expect(isEdgeCacheable(new Response('x'))).toBe(false);
  });
});
