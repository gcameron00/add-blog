import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';
const SLUG = 'shipping-a-blog-on-cloudflare-workers';

async function get(path, init) {
  return SELF.fetch(`https://${HOST}${path}`, { redirect: 'manual', ...init });
}

describe('GET /posts/:slug', () => {
  it('serves the post with real title, description and OG tags', async () => {
    const res = await get(`/posts/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');

    const html = await res.text();
    expect(html).toContain('<title>Shipping a blog on Cloudflare Workers — The add-blog Journal</title>');
    expect(html).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html).toMatch(/<meta property="og:title" content="Shipping a blog on Cloudflare Workers"/);
    expect(html).toContain(`<link rel="canonical" href="https://${HOST}/posts/${SLUG}" />`);
  });

  it('inlines the rendered article body — works with JS disabled', async () => {
    const html = await (await get(`/posts/${SLUG}`)).text();
    expect(html).toMatch(/<article data-article>[\s\S]*<h1>Shipping a blog on Cloudflare Workers<\/h1>/);
    expect(html).toContain('class="prose"');
    // Not still showing the static template's loading placeholder.
    expect(html).not.toContain('Loading post…');
  });

  it('still ships assets/js/post.js so client-side hydration still runs', async () => {
    const html = await (await get(`/posts/${SLUG}`)).text();
    expect(html).toContain('/assets/js/post.js');
  });

  it('404s for a slug with no published post, but still returns the page shell', async () => {
    const res = await get('/posts/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('404s for a draft post — same as a nonexistent one', async () => {
    const res = await get('/posts/notes-on-the-media-pipeline');
    expect(res.status).toBe(404);
  });
});

describe('GET /post/?slug=… (legacy)', () => {
  it('301s to the canonical /posts/:slug permalink', async () => {
    const res = await get(`/post/?slug=${SLUG}`);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`https://${HOST}/posts/${SLUG}`);
  });

  it('redirects even for a slug that turns out not to exist — /posts/:slug handles that 404', async () => {
    const res = await get('/post/?slug=nonexistent');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`https://${HOST}/posts/nonexistent`);
  });

  it('does not redirect when there is no ?slug= — falls through to the static page', async () => {
    const res = await get('/post/');
    expect(res.status).not.toBe(301);
  });
});
