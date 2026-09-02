/**
 * Best-effort edge cache purge for public URLs an admin mutation affects
 * (Phase 5's "cache purge on every mutation, via one shared publish path").
 * Uses the Workers Cache API (`caches.default`) — the same edge cache that
 * serves cached responses to end users — so this needs no Cloudflare API
 * token or extra secret, unlike a zone-level purge call.
 *
 * This purges the specific, deterministic URLs a post touches. It cannot
 * enumerate every filtered `/api/posts?tag=…&q=…` variant a client might
 * have cached, so those still rely on their short max-age/s-maxage rather
 * than an active purge — see docs/architecture.md §5.
 */
/**
 * `basePath` defaults to `/posts` — a post's own permalink prefix. A
 * collection item (post_type != 'post') passes its collection's own
 * base_path instead (e.g. `/portfolio`), so its purge hits `<base_path>/`
 * and `<base_path>/<slug>` rather than the hardcoded posts path; the shared
 * site-wide URLs (home, feeds, sitemap) are purged either way since a
 * collection item can show up on the sitemap too (in_sitemap).
 */
export async function purgePostUrls(publicOrigin, { slug, previousSlug, tags = [], basePath = '/posts' } = {}) {
  const urls = new Set([
    `${publicOrigin}/`,
    `${publicOrigin}/api/posts`,
    `${publicOrigin}/api/tags`,
    `${publicOrigin}/api/archive`,
    `${publicOrigin}/feed.xml`,
    `${publicOrigin}/atom.xml`,
    `${publicOrigin}/sitemap.xml`,
  ]);

  for (const s of [slug, previousSlug].filter(Boolean)) {
    urls.add(`${publicOrigin}${basePath}/${s}`);
    if (basePath === '/posts') urls.add(`${publicOrigin}/api/posts/${s}`);
  }
  for (const tag of tags) {
    urls.add(`${publicOrigin}/api/posts?tag=${encodeURIComponent(tag)}`);
  }

  await Promise.all([...urls].map((url) => caches.default.delete(url).catch(() => false)));
}

/**
 * Purges the shared static pages a site_title/site_description change shows
 * up on (src/site-template.js's branding pass). Post permalinks aren't
 * enumerable here the way a single post's own purge is — they rely on the
 * existing short s-maxage/stale-while-revalidate window to pick up a rename
 * within the hour, same tradeoff docs/architecture.md §5 already accepts for
 * filtered API variants.
 */
export async function purgeBrandedPages(publicOrigin) {
  const urls = [`${publicOrigin}/`, `${publicOrigin}/archive/`, `${publicOrigin}/tags/`, `${publicOrigin}/about/`];
  await Promise.all(urls.map((url) => caches.default.delete(url).catch(() => false)));
}
