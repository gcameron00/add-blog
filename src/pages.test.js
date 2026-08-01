import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';
const SLUG = 'shipping-a-blog-on-cloudflare-workers';

async function get(path, init) {
  return SELF.fetch(`https://${HOST}${path}`, { redirect: 'manual', ...init });
}

async function setSetting(key, value) {
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = ?`).bind(JSON.stringify(value), key).run();
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

describe('site branding — settings.site_title/site_description reach the public pages', () => {
  it('templates the homepage <title>, meta description, og tags, header, and footer from settings', async () => {
    await setSetting('site_title', "Caitlin's Ski Blog");
    await setSetting('site_description', 'Adventures on snow.');

    const html = await (await get('/')).text();
    expect(html).toContain('<title>Caitlin&#39;s Ski Blog</title>');
    expect(html).toContain('<meta name="description" content="Adventures on snow." />');
    expect(html).toContain('<meta property="og:title" content="Caitlin&#39;s Ski Blog" />');
    expect(html).toContain('<meta property="og:description" content="Adventures on snow." />');
    expect(html).toContain('<span>Caitlin&#39;s Ski Blog</span>');
    expect(html).toMatch(/<div class="hero">[\s\S]*<h1>Caitlin&#39;s Ski Blog<\/h1>[\s\S]*<p>Adventures on snow\.<\/p>/);
    expect(html).not.toContain('The add-blog Journal');
    expect(html).not.toContain('Notes on building a blog engine for Cloudflare Workers');
  });

  it('falls back to the default title when site_title is empty', async () => {
    await setSetting('site_title', '');
    const html = await (await get('/')).text();
    expect(html).toContain('<title>The add-blog Journal</title>');
  });

  it('sets the public caching policy on the templated homepage', async () => {
    const res = await get('/');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
  });

  it('carries a custom site_title onto a post permalink\'s title and header', async () => {
    await setSetting('site_title', 'Caitlin Ski');
    const html = await (await get(`/posts/${SLUG}`)).text();
    expect(html).toContain('Shipping a blog on Cloudflare Workers — Caitlin Ski</title>');
    expect(html).toContain('<span>Caitlin Ski</span>');
  });

  it('brands the archive/tags/about pages without altering their own hero copy or meta description', async () => {
    await setSetting('site_title', 'Caitlin Ski');
    await setSetting('site_description', 'Adventures on snow.');
    for (const path of ['/archive/', '/tags/', '/about/']) {
      const html = await (await get(path)).text();
      expect(html).toContain('<span>Caitlin Ski</span>');
      expect(html).not.toContain('The add-blog Journal');
      expect(html).not.toContain('Adventures on snow.');
    }
    expect(await (await get('/archive/')).text()).toContain('<h1>Archive</h1>');
    const archiveHtml = await (await get('/archive/')).text();
    expect(archiveHtml).toContain('content="Every post, grouped by year."');
  });

  it('does not query settings for a non-HTML static asset', async () => {
    const res = await get('/assets/css/styles.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') || '').not.toContain('text/html');
  });
});
