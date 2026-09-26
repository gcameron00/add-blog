/**
 * Edge cache for public GET responses, via the Workers Cache API.
 *
 * A Worker on a Custom Domain runs in front of Cloudflare's CDN cache, so the
 * `s-maxage` on its responses does nothing by itself — every request would
 * run the full handler (D1 reads, shell fetch, HTML rewrite). This stores
 * cacheable responses in `caches.default` and serves them from there, which
 * is also the cache src/cache-purge.js already deletes from on every
 * mutation — see docs/architecture.md §5.
 *
 * Only responses a handler has explicitly marked shared-cacheable are stored
 * (`public` plus `s-maxage` or `immutable`): pages, /api/*, /media/*, feeds.
 * Workers static assets (CSS/JS) don't carry either and are left alone.
 *
 * `caches.default` is per data centre, and so is cache-purge.js's delete: a
 * purge clears the colo the admin request ran in, and every other colo picks
 * the change up when its copy's `s-maxage` runs out.
 *
 * Responses are stored *before* src/index.js's withSharedHeaders, so security
 * headers (CSP etc.) are always the current deploy's, not the cached copy's.
 */

// Tracking parameters social networks and newsletters append to shared links.
// They never change what the Worker renders, so they're dropped from the
// cache key — otherwise every shared link would be its own cold, unpurgeable
// cache entry. Anything else in the query string stays part of the key.
const IGNORED_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref)$/i;

export const EDGE_CACHE_HEADER = 'X-Edge-Cache';

/** Off only when explicitly disabled (vitest.config.js does, so routing tests never see a cached copy). */
export function edgeCacheEnabled(env) {
  return env.EDGE_CACHE !== 'off' && typeof caches !== 'undefined';
}

/** The URL a request is cached under — its own URL, minus tracking parameters. */
export function edgeCacheKey(request) {
  const url = new URL(request.url);
  for (const name of [...url.searchParams.keys()]) {
    if (IGNORED_PARAMS.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}

/**
 * Whether a request may be served from / stored in the cache at all. JSON API
 * URLs with a query string (`/api/posts?limit=10&offset=0`, `?tag=…`, `?q=…`)
 * are left out: src/cache-purge.js can't enumerate them, so a cached copy
 * would keep a just-published post off the home page and tag pages until it
 * expired. They're a single D1 query each, and weren't edge-cached before
 * this module existed either. The deterministic ones it does purge
 * (`/api/posts/:slug`, `/api/tags`, `/api/archive`) are still cached.
 */
export function isEdgeCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(edgeCacheKey(request));
  return !(url.pathname.startsWith('/api/') && url.search);
}

/** Whether a handler's response is meant to be held in a shared cache. */
export function isEdgeCacheable(response) {
  if (response.status !== 200 || response.headers.has('Set-Cookie')) return false;
  const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
  if (!cacheControl.includes('public') || /private|no-store|no-cache/.test(cacheControl)) return false;
  return cacheControl.includes('s-maxage') || cacheControl.includes('immutable');
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set(EDGE_CACHE_HEADER, status);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The cached response for `request`, or null on a miss. Conditional headers
 * are passed through, so a matching If-None-Match gets a 304 straight from
 * the cache.
 */
export async function matchEdgeCache(request) {
  try {
    const key = new Request(edgeCacheKey(request), request);
    const cached = await caches.default.match(key);
    return cached ? withCacheStatus(cached, 'HIT') : null;
  } catch {
    return null; // a cache failure should cost speed, never the page
  }
}

/**
 * Stores `response` in the background if it's cacheable, and returns the
 * response to send. Non-cacheable responses are returned untouched.
 */
export function storeInEdgeCache(request, response, ctx) {
  if (!isEdgeCacheable(response)) return response;
  const put = caches.default.put(edgeCacheKey(request), response.clone()).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(put);
  return withCacheStatus(response, 'MISS');
}
