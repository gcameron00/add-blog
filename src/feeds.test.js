import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';

async function setSetting(key, value) {
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = ?`).bind(JSON.stringify(value), key).run();
}

describe('GET /feed.xml', () => {
  it('serves RSS 2.0 with the published posts, newest first', async () => {
    const res = await SELF.fetch(`https://${HOST}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/rss+xml;charset=UTF-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600, s-maxage=3600');

    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('shipping-a-blog-on-cloudflare-workers');
    // Non-public content never appears in the feed.
    expect(xml).not.toContain('notes-on-the-media-pipeline');
    expect(xml).not.toContain('accessibility-pass-findings');
  });

  it('advertises a channel <image>: the static default, or the uploaded site icon when set', async () => {
    await setSetting('site_icon_key', '');
    let xml = await (await SELF.fetch(`https://${HOST}/feed.xml`)).text();
    expect(xml).toContain(`<image>\n    <url>https://${HOST}/assets/icon-512.png</url>`);
    expect(xml).toContain(`<link>https://${HOST}/</link>\n  </image>`);

    await setSetting('site_icon_key', '2026/08/abc123-icon.png');
    xml = await (await SELF.fetch(`https://${HOST}/feed.xml`)).text();
    expect(xml).toContain(`<url>https://${HOST}/media/2026/08/abc123-icon.png</url>`);
    await setSetting('site_icon_key', '');
  });
});

describe('GET /atom.xml', () => {
  it('serves Atom 1.0', async () => {
    const res = await SELF.fetch(`https://${HOST}/atom.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/atom+xml;charset=UTF-8');
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<icon>https://${HOST}/assets/icon-512.png</icon>`);
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
