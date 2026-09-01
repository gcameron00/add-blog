/**
 * Server-rendered permalink: GET /posts/:slug — correct <title>, meta
 * description and Open Graph tags for crawlers and link previews, plus the
 * article body itself inlined so the page works with JavaScript disabled.
 * assets/js/post.js still runs on top and re-renders the same content
 * client-side (harmless, and keeps this a static-template-based Worker
 * rather than a second copy of the front end's DOM-building code).
 *
 * `/post/?slug=…` (the Phase 1 query-param fallback) 301s here — see
 * docs/architecture.md §2.
 */

import { getPublishedItemBySlug, getPublishedPostBySlug, getSettings, listPublishedItems } from './db.js';
import { escapeHtml, renderMarkdown } from '../assets/js/markdown.js';
import { applySiteBranding, applyHomeMeta, isFeatureEnabled } from './site-template.js';
import { findCollectionByLegacyPath, findCollectionByPath, renderCollectionIndex, renderCollectionItem, resolveCollections } from './collections.js';

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderArticle(post, origin) {
  const tags = (post.tags || [])
    .map((t) => `<a class="tag" href="/tags/?tag=${encodeURIComponent(t.slug)}">${escapeHtml(t.name)}</a>`)
    .join('');

  const cover = post.cover
    ? `<img class="article-cover" src="${escapeHtml(post.cover.url)}" alt="${escapeHtml(post.cover.alt || '')}">`
    : '';

  const avatar = post.author?.avatar
    ? `<img class="byline__avatar" src="${escapeHtml(post.author.avatar)}" alt="">`
    : '';

  const updated =
    post.updated_at && post.updated_at !== post.published_at
      ? ` · updated <time datetime="${escapeHtml(post.updated_at)}">${formatDate(post.updated_at)}</time>`
      : '';

  return `
    <header class="article-header">
      <div class="tag-list" style="margin-bottom:1rem">${tags}</div>
      <h1>${escapeHtml(post.title)}</h1>
      ${post.subtitle ? `<p class="subtitle">${escapeHtml(post.subtitle)}</p>` : ''}
    </header>
    ${cover}
    <div class="byline">
      ${avatar}
      <div>
        <div class="byline__name">${escapeHtml(post.author?.name || 'Unknown author')}</div>
        <div class="byline__meta">
          <time datetime="${escapeHtml(post.published_at || '')}">${formatDate(post.published_at)}</time>
          · ${post.reading_minutes} min read${updated}
        </div>
      </div>
    </div>
    <div class="prose">${post.body_html || ''}</div>
    <footer class="article-footer">
      <div class="tag-list">${tags}</div>
      <p class="small muted" style="margin-top:1rem"><a href="/">← All posts</a></p>
    </footer>
  `;
}

/** GET /posts/:slug. Returns null for anything else, so the caller can fall through. */
export async function handlePostPage(request, url, env) {
  const match = url.pathname.match(/^\/posts\/([^/]+)\/?$/);
  if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  // No D1 binding yet — fall through to static assets rather than throwing.
  if (!env.DB) return null;

  const slug = decodeURIComponent(match[1]);
  const [post, settings] = await Promise.all([getPublishedPostBySlug(env.DB, slug), getSettings(env.DB)]);
  const siteTitle = settings.site_title || 'The add-blog Journal';

  const shellRequest = new Request(new URL('/post/', url), request);
  const shellResponse = await env.ASSETS.fetch(shellRequest);
  let html = applySiteBranding(await shellResponse.text(), settings);

  if (!post) {
    // Let the existing client-side "not found" state render — same as a
    // direct hit on /post/?slug=<nonexistent> did in Phase 1 — but a real
    // 404 status, not 200, since this is now the canonical URL.
    return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  const title = `${escapeHtml(post.title)} — ${escapeHtml(siteTitle)}`;
  const description = escapeHtml(post.excerpt || '');
  const canonical = `${url.origin}/posts/${encodeURIComponent(post.slug)}`;

  html = html
    .replace(`<title>Post — ${escapeHtml(siteTitle)}</title>`, `<title>${title}</title>`)
    .replace('<meta name="description" content="" />', `<meta name="description" content="${description}" />`)
    .replace('<meta property="og:title" content="" />', `<meta property="og:title" content="${escapeHtml(post.title)}" />`)
    .replace('<meta property="og:description" content="" />', `<meta property="og:description" content="${description}" />`)
    .replace('<link rel="canonical" href="/" />', `<link rel="canonical" href="${canonical}" />`)
    .replace(/<article data-article>[\s\S]*?<\/article>/, `<article data-article>${renderArticle(post, url.origin)}</article>`);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // docs/architecture.md §5: "Public HTML pages" caching policy.
      'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

// Trims a trailing slash the same way src/collections.js's own internal
// helper does — kept here too rather than exported/shared, since these two
// handlers are the only pages.js callers and it's a one-line normalisation.
function trimTrailingSlash(path) {
  return String(path).replace(/\/+$/, '') || '/';
}

// A collection's base_path is owner-configured and dynamic, so — unlike
// every other handler in this file — these two can't cheaply tell "not my
// route" from the pathname alone; they have to load settings first. Skipping
// obvious non-page requests (static assets, anything with a file extension)
// before that keeps the extra settings read off the hot path for every CSS/
// JS/image request, which is the overwhelming majority of traffic on a
// public host that doesn't use collections at all.
function looksLikeStaticAsset(pathname) {
  return pathname.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/** GET <base_path>[/] for a configured collection — the index/grid page. Returns null for anything else. */
export async function handleCollectionIndexPage(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!env.DB || looksLikeStaticAsset(url.pathname)) return null;

  const settings = await getSettings(env.DB);
  const collections = resolveCollections(settings);
  const collection = findCollectionByPath(collections, url.pathname);
  if (!collection) return null;

  const base = trimTrailingSlash(collection.base_path);
  if (trimTrailingSlash(url.pathname) !== base) return null; // an item path — handleCollectionItemPage owns it

  const siteTitle = settings.site_title || 'The add-blog Journal';
  const { data: items } = await listPublishedItems(env.DB, collection.type, { limit: 100 });

  const shellRequest = new Request(new URL('/collection/', url), request);
  const shellResponse = await env.ASSETS.fetch(shellRequest);
  let html = applySiteBranding(await shellResponse.text(), settings);

  const indexTitle = collection.index_title || collection.label_plural || collection.label || 'Collection';
  const canonical = `${url.origin}${base}/`;

  html = html
    .replace(`<title>Collection — ${escapeHtml(siteTitle)}</title>`, `<title>${escapeHtml(indexTitle)} — ${escapeHtml(siteTitle)}</title>`)
    .replace('<link rel="canonical" href="/" />', `<link rel="canonical" href="${canonical}" />`)
    .replace('<h1>Collection</h1>', `<h1>${escapeHtml(indexTitle)}</h1>`)
    .replace(/<div data-collection-index><\/div>/, `<div data-collection-index>${renderCollectionIndex(items, collection)}</div>`);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // docs/architecture.md §5: "Public HTML pages" caching policy.
      'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

/** GET <base_path>/<slug> for a configured collection — one item's detail page. Returns null for anything else, including the collection's own index path. */
export async function handleCollectionItemPage(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!env.DB || looksLikeStaticAsset(url.pathname)) return null;

  const settings = await getSettings(env.DB);
  const collections = resolveCollections(settings);
  const collection = findCollectionByPath(collections, url.pathname);
  if (!collection) return null;

  const base = trimTrailingSlash(collection.base_path);
  const normalized = trimTrailingSlash(url.pathname);
  if (normalized === base) return null; // the index path — handleCollectionIndexPage owns it
  const rest = normalized.slice(base.length + 1);
  if (!rest || rest.includes('/')) return null; // only a single slug segment is a valid item path

  const slug = decodeURIComponent(rest);
  const siteTitle = settings.site_title || 'The add-blog Journal';
  const item = await getPublishedItemBySlug(env.DB, collection.type, slug);

  const shellRequest = new Request(new URL('/collection-item/', url), request);
  const shellResponse = await env.ASSETS.fetch(shellRequest);
  let html = applySiteBranding(await shellResponse.text(), settings);

  if (!item) {
    // Same "let the shell's own not-found state stand, but a real 404
    // status" contract as handlePostPage below.
    return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  const title = `${escapeHtml(item.title)} — ${escapeHtml(siteTitle)}`;
  const description = escapeHtml(item.excerpt || '');
  const canonical = `${url.origin}${base}/${encodeURIComponent(item.slug)}`;

  html = html
    .replace(`<title>Item — ${escapeHtml(siteTitle)}</title>`, `<title>${title}</title>`)
    .replace('<meta name="description" content="" />', `<meta name="description" content="${description}" />`)
    .replace('<meta property="og:title" content="" />', `<meta property="og:title" content="${escapeHtml(item.title)}" />`)
    .replace('<meta property="og:description" content="" />', `<meta property="og:description" content="${description}" />`)
    .replace('<link rel="canonical" href="/" />', `<link rel="canonical" href="${canonical}" />`)
    .replace(/<article data-collection-item>[\s\S]*?<\/article>/, `<article data-collection-item>${renderCollectionItem(item, collection)}</article>`);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // docs/architecture.md §5: "Public HTML pages" caching policy.
      'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

/**
 * GET / — same static shell as every other public page, templated with live
 * settings the same way the post permalink above is. The one page whose meta
 * description/og:description is settings-driven (applyHomeMeta) rather than
 * per-post or page-specific fixed copy.
 */
export async function handleHomePage(request, url, env, admin) {
  if (admin || url.pathname !== '/' || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  if (!env.DB) return null;

  const settings = await getSettings(env.DB);
  const shellResponse = await env.ASSETS.fetch(request);
  let html = applySiteBranding(await shellResponse.text(), settings);
  html = applyHomeMeta(html, settings);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // docs/architecture.md §5: "Public HTML pages" caching policy.
      'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

/**
 * GET /about — the /about/ shell, branded like every other public page, with
 * settings.about_content (owner-authored markdown, admin/settings/index.html's
 * "About page" card) rendered into the <!-- about-content:start/end --> region
 * of about/index.html. Comment sentinels rather than a data-article-style
 * element, because that block contains nested </div>s (a demo banner, a
 * table) a non-greedy element regex would truncate at the wrong one.
 *
 * Empty about_content is left alone entirely — the page keeps its built-in
 * placeholder copy, so a fresh install looks identical to today until the
 * owner writes something. Disabled via nav_config (isFeatureEnabled) 404s,
 * same as Archive/Tags in src/index.js's brandStaticAsset.
 */
export async function handleAboutPage(request, url, env) {
  if ((url.pathname !== '/about/' && url.pathname !== '/about') ||
      (request.method !== 'GET' && request.method !== 'HEAD')) {
    return null;
  }
  if (!env.DB) return null;

  const settings = await getSettings(env.DB);
  if (!isFeatureEnabled(settings, 'about')) return new Response('Not found', { status: 404 });

  const shellRequest = new Request(new URL('/about/', url), request);
  const shellResponse = await env.ASSETS.fetch(shellRequest);
  let html = applySiteBranding(await shellResponse.text(), settings);

  if (settings.about_content) {
    html = html.replace(
      /<!-- about-content:start -->[\s\S]*?<!-- about-content:end -->/,
      `<!-- about-content:start -->${renderMarkdown(settings.about_content)}<!-- about-content:end -->`
    );
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // docs/architecture.md §5: "Public HTML pages" caching policy.
      'Cache-Control': 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

/** GET /post/?slug=… → 301 to the canonical /posts/:slug permalink. */
export function handleLegacyPostRedirect(url) {
  if (url.pathname !== '/post/' && url.pathname !== '/post') return null;
  const slug = url.searchParams.get('slug');
  if (!slug) return null;
  return Response.redirect(`${url.origin}/posts/${encodeURIComponent(slug)}`, 301);
}

/**
 * GET <legacy_path>/?slug=… → 301 to the canonical <base_path>/:slug for
 * whichever collection declares that legacy_path — mirrors
 * handleLegacyPostRedirect above exactly, just resolved against the site's
 * collections registry instead of a fixed /post path. Needs settings (to
 * resolve collections), unlike the fixed-target post redirect, so this
 * takes `env` too and is async.
 */
export async function handleLegacyCollectionRedirect(request, url, env) {
  if (!env.DB) return null;
  const slug = url.searchParams.get('slug');
  if (!slug) return null;

  const settings = await getSettings(env.DB);
  const collection = findCollectionByLegacyPath(resolveCollections(settings), url.pathname);
  if (!collection) return null;

  const base = trimTrailingSlash(collection.base_path);
  return Response.redirect(`${url.origin}${base}/${encodeURIComponent(slug)}`, 301);
}

/**
 * WordPress's feed paths (/feed/, /feed/rss2/, …) → 301 to add-blog's own
 * feed URLs, so readers already subscribed via the old WordPress URL follow
 * the site move automatically — feed readers update their stored URL on a
 * 301, no subscriber action required.
 */
export function handleWordpressFeedRedirect(url) {
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/feed/atom') return Response.redirect(`${url.origin}/atom.xml`, 301);
  if (['/feed', '/feed/rss', '/feed/rss2', '/feed/rdf'].includes(path)) {
    return Response.redirect(`${url.origin}/feed.xml`, 301);
  }
  return null;
}
