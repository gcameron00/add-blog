/**
 * Non-JSON public routes: feed.xml, atom.xml, sitemap.xml, robots.txt.
 * See docs/api.md "Non-JSON public routes" and docs/architecture.md §5 for
 * the Cache-Control policy applied here.
 */

import { listRecentPosts, listSitemapEntries, getSettings } from './db.js';
import { isFeatureEnabled } from './site-template.js';

const FEED_CACHE_CONTROL = 'public, max-age=600, s-maxage=3600';

function xmlEscape(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function xml(body, contentType = 'application/xml;charset=UTF-8') {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { 'Content-Type': contentType, 'Cache-Control': FEED_CACHE_CONTROL },
  });
}

async function rss(url, env) {
  const settings = await getSettings(env.DB);
  const posts = await listRecentPosts(env.DB, 20);
  const title = settings.site_title || 'The add-blog Journal';
  const description = settings.site_description || '';
  const fullContent = Boolean(settings.feed_full_content);

  const items = posts.map((post) => {
    const link = `${url.origin}/posts/${encodeURIComponent(post.slug)}`;
    const content = fullContent && post.body_html
      ? `<content:encoded><![CDATA[${post.body_html}]]></content:encoded>`
      : '';
    return `
    <item>
      <title>${xmlEscape(post.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${new Date(post.published_at).toUTCString()}</pubDate>
      <description><![CDATA[${post.excerpt || ''}]]></description>
      ${content}
    </item>`;
  }).join('');

  return xml(`<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${xmlEscape(title)}</title>
  <link>${url.origin}/</link>
  <description>${xmlEscape(description)}</description>
  <language>en</language>
  <atom:link href="${url.origin}/feed.xml" rel="self" type="application/rss+xml" />
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  ${items}
</channel>
</rss>`, 'application/rss+xml;charset=UTF-8');
}

async function atom(url, env) {
  const settings = await getSettings(env.DB);
  const posts = await listRecentPosts(env.DB, 20);
  const title = settings.site_title || 'The add-blog Journal';
  const fullContent = Boolean(settings.feed_full_content);
  const updated = posts[0]?.updated_at || new Date().toISOString();

  const entries = posts.map((post) => {
    const link = `${url.origin}/posts/${encodeURIComponent(post.slug)}`;
    const content = fullContent && post.body_html
      ? `<content type="html">${xmlEscape(post.body_html)}</content>`
      : `<summary>${xmlEscape(post.excerpt || '')}</summary>`;
    return `
  <entry>
    <title>${xmlEscape(post.title)}</title>
    <link href="${link}" />
    <id>${link}</id>
    <updated>${post.updated_at}</updated>
    <published>${post.published_at}</published>
    ${content}
    <author><name>${xmlEscape(post.author?.name || '')}</name></author>
  </entry>`;
  }).join('');

  return xml(`<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(title)}</title>
  <link href="${url.origin}/atom.xml" rel="self" />
  <link href="${url.origin}/" />
  <id>${url.origin}/</id>
  <updated>${updated}</updated>
  ${entries}
</feed>`, 'application/atom+xml;charset=UTF-8');
}

async function sitemap(url, env) {
  const { posts, tags } = await listSitemapEntries(env.DB);

  // TODO: lists archive/tags/about unconditionally, regardless of
  // nav_config's `enabled` flags — same class of gap as purgeBrandedPages'
  // documented post-permalink limitation, not fixed here.
  const staticUrls = ['/', '/archive/', '/tags/', '/about/'];
  const postUrls = posts.map((p) =>
    `<url><loc>${url.origin}/posts/${encodeURIComponent(p.slug)}</loc><lastmod>${p.updated_at.slice(0, 10)}</lastmod></url>`
  );
  const tagUrls = tags.map((slug) => `<url><loc>${url.origin}/tags/?tag=${encodeURIComponent(slug)}</loc></url>`);

  const entries = [
    ...staticUrls.map((path) => `<url><loc>${url.origin}${path}</loc></url>`),
    ...postUrls,
    ...tagUrls,
  ].join('\n  ');

  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${entries}
</urlset>`);
}

function robots(url) {
  const body = `User-agent: *\nAllow: /\nDisallow: /admin/\n\nSitemap: ${url.origin}/sitemap.xml\n`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': FEED_CACHE_CONTROL },
  });
}

export async function handleFeeds(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const isFeedRoute = ['/feed.xml', '/rss.xml', '/atom.xml', '/sitemap.xml', '/robots.txt'].includes(url.pathname);
  if (!isFeedRoute) return null;
  // robots.txt needs no data — safe to serve even with no D1 binding yet.
  if (url.pathname === '/robots.txt') return robots(url);
  if (!env.DB) return null;

  if (url.pathname === '/feed.xml' || url.pathname === '/rss.xml' || url.pathname === '/atom.xml') {
    // RSS is owner-toggleable (nav_config); sitemap.xml/robots.txt are
    // infrastructure, not a browsable "feature", so they aren't gated.
    const settings = await getSettings(env.DB);
    if (!isFeatureEnabled(settings, 'rss')) return new Response('Not found', { status: 404 });
  }

  if (url.pathname === '/feed.xml' || url.pathname === '/rss.xml') return rss(url, env);
  if (url.pathname === '/atom.xml') return atom(url, env);
  return sitemap(url, env);
}
