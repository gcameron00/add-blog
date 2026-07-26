/**
 * GET /media/:key — streams an object straight from R2. Per
 * docs/architecture.md §4, the bucket itself is never made publicly
 * readable; this route is the only path to it.
 */

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export async function handleMedia(request, url, env) {
  if (!url.pathname.startsWith('/media/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  // No R2 binding yet — fall through to static assets rather than throwing.
  if (!env.MEDIA) return null;

  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!key) return null;

  const object = await env.MEDIA.get(key, { onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', CACHE_CONTROL);

  // A conditional request (If-None-Match/If-Modified-Since) that matched
  // gets metadata back with no body — the correct response is 304, not 200.
  const hasBody = 'body' in object && object.body;
  if (!hasBody) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(object.body, { headers });
}
