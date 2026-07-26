/**
 * Public JSON API — GET /api/posts, /api/posts/:slug, /api/tags, /api/archive.
 * Anonymous, published content only. See docs/api.md.
 *
 * Returns null for anything that isn't one of these routes, so the caller
 * can fall through to static assets / other handlers.
 */

import { listPublishedPosts, getPublishedPostBySlug, listTags, getArchive } from './db.js';

// docs/architecture.md §5: "Public /api/* JSON" caching policy.
const CACHE_CONTROL = 'public, max-age=30, s-maxage=300';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE_CONTROL },
  });
}

function notFound(message = 'Not found.') {
  return json({ error: { code: 'not_found', message } }, 404);
}

export async function handlePublicApi(request, url, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const segments = url.pathname.split('/').filter(Boolean); // ['api', 'posts', ...]
  if (segments[0] !== 'api') return null;

  // No D1 binding yet (the site's [[d1_databases]] hasn't been added to
  // wrangler.toml) — fall through to static assets exactly as before this
  // route existed, rather than throwing. assets/js/api.js's demo-data
  // fallback depends on a clean miss here (non-JSON response), not a 500.
  if (!env.DB) return null;

  if (segments.length === 2 && segments[1] === 'posts') {
    const params = url.searchParams;
    const result = await listPublishedPosts(env.DB, {
      limit: params.get('limit'),
      offset: params.get('offset'),
      tag: params.get('tag'),
      q: params.get('q'),
      before: params.get('before'),
      after: params.get('after'),
    });
    return json(result);
  }

  if (segments.length === 3 && segments[1] === 'posts') {
    const slug = decodeURIComponent(segments[2]);
    const post = await getPublishedPostBySlug(env.DB, slug);
    if (!post) return notFound(`No published post at "${slug}".`);
    return json({ data: post });
  }

  if (segments.length === 2 && segments[1] === 'tags') {
    return json(await listTags(env.DB));
  }

  if (segments.length === 2 && segments[1] === 'archive') {
    return json(await getArchive(env.DB));
  }

  return null;
}
