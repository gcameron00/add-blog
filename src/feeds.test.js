import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';

describe('GET /feed.xml', () => {
  it('serves RSS 2.0 with the published posts, newest first', async () => {
    const res = await SELF.fetch(`https://${HOST}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600, s-maxage=3600');

    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('shipping-a-blog-on-cloudflare-workers');
    // Non-public content never appears in the feed.
    expect(xml).not.toContain('notes-on-the-media-pipeline');
    expect(xml).not.toContain('accessibility-pass-findings');
  });
});

describe('GET /atom.xml', () => {
  it('serves Atom 1.0', async () => {
    const res = await SELF.fetch(`https://${HOST}/atom.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('shipping-a-blog-on-cloudflare-workers');
  });
});

describe('GET /sitemap.xml', () => {
  it('lists static pages, every published post, and every used tag', async () => {
    const res = await SELF.fetch(`https://${HOST}/sitemap.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`<loc>https://${HOST}/</loc>`);
    expect(xml).toContain(`<loc>https://${HOST}/posts/shipping-a-blog-on-cloudflare-workers</loc>`);
    expect(xml).toContain(`<loc>https://${HOST}/tags/?tag=mcp</loc>`);
    // Draft/scheduled/archived posts are never linked from the sitemap.
    expect(xml).not.toContain('notes-on-the-media-pipeline');
  });
});

describe('GET /robots.txt', () => {
  it('references the sitemap and disallows /admin/', async () => {
    const res = await SELF.fetch(`https://${HOST}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('Disallow: /admin/');
    expect(body).toContain(`Sitemap: https://${HOST}/sitemap.xml`);
  });
});
