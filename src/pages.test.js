import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleCollectionIndexPage, handleCollectionItemPage, handleLegacyCollectionRedirect } from './pages.js';

const HOST = 'blog.mysite.com';
const SLUG = 'shipping-a-blog-on-cloudflare-workers';

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
  fields: [{ key: 'status', label: 'Status', type: 'enum', options: ['Live'], display: 'badge' }],
};

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

describe('WordPress feed redirects', () => {
  it.each([
    ['/feed/', '/feed.xml'],
    ['/feed', '/feed.xml'],
    ['/feed/rss/', '/feed.xml'],
    ['/feed/rss2/', '/feed.xml'],
    ['/feed/rdf/', '/feed.xml'],
    ['/feed/atom/', '/atom.xml'],
  ])('301s %s to %s', async (path, target) => {
    const res = await get(path);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`https://${HOST}${target}`);
  });

  it('does not redirect /comments/feed/ — add-blog has no comments feature', async () => {
    const res = await get('/comments/feed/');
    expect(res.status).not.toBe(301);
  });

  it('does not redirect a near-miss path like /feeds/', async () => {
    const res = await get('/feeds/');
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

  it('points the footer Admin link at settings.admin_url, not the public host\'s /admin/', async () => {
    await setSetting('admin_url', 'https://blog-admin.example.com');
    const html = await (await get('/')).text();
    expect(html).toContain('<a href="https://blog-admin.example.com/admin/">Admin</a>');
    expect(html).not.toContain('href="/admin/"');
  });

  it('leaves the footer Admin link as /admin/ when admin_url is empty', async () => {
    await setSetting('admin_url', '');
    const html = await (await get('/')).text();
    expect(html).toContain('<a href="/admin/">Admin</a>');
  });

  it('swaps the favicon, apple-touch-icon and header mark for settings.site_icon_key (#15)', async () => {
    await setSetting('site_icon_key', '2026/08/abc123-icon.png');
    const html = await (await get('/')).text();
    expect(html).toContain('<link rel="icon" href="/media/2026/08/abc123-icon.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/media/2026/08/abc123-icon.png" />');
    expect(html).toContain('<img class="brand-mark" src="/media/2026/08/abc123-icon.png" alt="" width="32" height="32">');
    expect(html).not.toContain('/assets/favicon.svg');
    expect(html).not.toContain('/assets/favicon-32x32.png');
    expect(html).not.toContain('/assets/apple-touch-icon.png');
    expect(html).not.toMatch(/<svg viewBox="0 0 32 32"/);
    // The manifest link stays static — site.webmanifest (src/manifest.js)
    // reads the same settings key dynamically rather than being templated here.
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
  });

  it('falls back to the default favicon, PNG fallback, apple-touch-icon and inline mark when site_icon_key is empty', async () => {
    await setSetting('site_icon_key', '');
    const html = await (await get('/')).text();
    expect(html).toContain('<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" sizes="any" />');
    expect(html).toContain('<link rel="icon" href="/assets/favicon-32x32.png" sizes="32x32" type="image/png" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    expect(html).toMatch(/<svg viewBox="0 0 32 32"/);
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
    await setSetting('site_icon_key', '2026/08/abc123-icon.png');
    for (const path of ['/archive/', '/tags/', '/about/']) {
      const html = await (await get(path)).text();
      expect(html).toContain('<span>Caitlin Ski</span>');
      expect(html).not.toContain('The add-blog Journal');
      expect(html).not.toContain('Adventures on snow.');
      // brandStaticAsset (src/index.js) is a separate call site of
      // applySiteBranding from the homepage/post-permalink one above —
      // worth its own assertion so a regression there isn't hidden by only
      // ever testing icon branding through the other path.
      expect(html).toContain('<link rel="icon" href="/media/2026/08/abc123-icon.png" />');
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

describe('handleCollectionIndexPage / handleCollectionItemPage / handleLegacyCollectionRedirect', () => {
  it('return null for every collection route when settings.collections is empty (the default)', async () => {
    await setSetting('collections', []);
    const url = new URL(`https://${HOST}/portfolio/`);
    const req = new Request(url);
    expect(await handleCollectionIndexPage(req, url, env)).toBeNull();
    expect(await handleCollectionItemPage(req, url, env)).toBeNull();
  });

  it('handleCollectionIndexPage returns null for a path outside every configured collection', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/nope/`);
    const req = new Request(url);
    expect(await handleCollectionIndexPage(req, url, env)).toBeNull();
  });

  it('handleCollectionIndexPage renders the configured collection\'s index page', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/portfolio/`);
    const req = new Request(url);
    const res = await handleCollectionIndexPage(req, url, env);
    expect(res).not.toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
    const html = await res.text();
    expect(html).toContain('<h1>Portfolio</h1>');
  });

  it('src/site-template.js adds a header nav link for a collection with nav.header true', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const html = await (await get('/')).text();
    expect(html).toMatch(/<nav class="site-nav"[^>]*>[\s\S]*<a href="\/portfolio\/">Projects<\/a>[\s\S]*<\/nav>/);
  });

  it('omits the collection nav link when nav.header is false', async () => {
    await setSetting('collections', [{ ...PROJECT_COLLECTION, nav: { header: false, footer: false } }]);
    const html = await (await get('/')).text();
    expect(html).not.toContain('href="/portfolio/">Projects');
  });

  it('handleCollectionItemPage returns null for the collection\'s own index path', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/portfolio/`);
    const req = new Request(url);
    expect(await handleCollectionItemPage(req, url, env)).toBeNull();
  });

  it('handleCollectionItemPage returns null for a path outside every configured collection', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/nope/something`);
    const req = new Request(url);
    expect(await handleCollectionItemPage(req, url, env)).toBeNull();
  });

  it('handleCollectionItemPage 404s a nonexistent item but still returns the page shell', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/portfolio/does-not-exist`);
    const req = new Request(url);
    const res = await handleCollectionItemPage(req, url, env);
    expect(res).not.toBeNull();
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('handleLegacyCollectionRedirect 301s the query-string legacy form to the canonical <base_path>/<slug>', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/project/?slug=my-project`);
    const req = new Request(url);
    const res = await handleLegacyCollectionRedirect(req, url, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`https://${HOST}/portfolio/my-project`);
  });

  it('handleLegacyCollectionRedirect returns null without a ?slug=', async () => {
    await setSetting('collections', [PROJECT_COLLECTION]);
    const url = new URL(`https://${HOST}/project/`);
    const req = new Request(url);
    expect(await handleLegacyCollectionRedirect(req, url, env)).toBeNull();
  });

  it('handleLegacyCollectionRedirect returns null for a legacy_path no collection declares', async () => {
    await setSetting('collections', []);
    const url = new URL(`https://${HOST}/project/?slug=my-project`);
    const req = new Request(url);
    expect(await handleLegacyCollectionRedirect(req, url, env)).toBeNull();
  });
});
