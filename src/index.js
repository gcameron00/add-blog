/**
 * add-blog Worker — hostname router (Phase 2).
 *
 * One deployment, one static asset bundle, two hostnames:
 *   - the admin host   (env.ADMIN_HOST)  — editors, agents, never cached
 *   - everything else  — the public host, per docs/architecture.md §1: the
 *     public branch is the default, not an allow-listed match, so an
 *     unrecognised or misconfigured hostname fails toward "restricted",
 *     never toward "admin".
 *
 * The admin-path block on the public host is deliberately the first thing
 * this file does, unconditionally, with no dependency on any other branch.
 * Per docs/architecture.md §1-2 and docs/implementation-plan.md's Phase 2
 * risk note, getting this wrong is the single highest-severity failure mode
 * in the project — it would expose drafts and the write API. Every branch
 * below has a routing test, and the negative cases are written first.
 *
 * No D1, no R2, no auth yet — those are Phases 3 and 4. This phase only
 * decides *which* static assets a request is allowed to see.
 */

const DEFAULT_ADMIN_HOST = 'blog-admin.mysite.com';

// Blocked on every hostname except the admin host. Prefix-matched with a
// trailing-slash (or exact) boundary so `/admin` blocks `/admin/posts` but
// not a hypothetical `/administrator` page — a naive `startsWith('/admin')`
// would get that wrong.
const ADMIN_ONLY_PREFIXES = ['/admin', '/api/admin', '/mcp'];

function isAdminOnlyPath(pathname) {
  return ADMIN_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// The one external origin either surface loads script/style/fonts from:
// EasyMDE and its Font Awesome icon set, both pinned versions loaded from
// jsdelivr (see admin/editor/index.html and docs/implementation-plan.md's
// Phase 1 amendment). style-src needs 'unsafe-inline' because EasyMDE's
// CodeMirror layer writes inline `style` attributes for things like the
// side-by-side pane split; script-src does not need it and does not have it.
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    `script-src 'self' ${CDN_ORIGIN}`,
    `style-src 'self' 'unsafe-inline' ${CDN_ORIGIN}`,
    "img-src 'self' data:",
    `font-src 'self' data: ${CDN_ORIGIN}`,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function withSharedHeaders(response, { requestId, admin }) {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('Content-Security-Policy', contentSecurityPolicy());
  if (admin) {
    // Every admin response, always — nothing on this host is safe to cache,
    // by a proxy, a browser, or Cloudflare's own edge cache.
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Frame-Options', 'DENY');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function notFound(requestId, admin) {
  const response = withSharedHeaders(new Response('Not found', { status: 404 }), { requestId, admin });
  // Belt and suspenders on top of the admin-guard itself: this specific
  // response must never be cacheable, at the edge or in a browser, even for
  // a host that isn't `admin` (which is the only case that gets
  // Cache-Control set above). A cached copy of this exact response is
  // harmless (it's already the deny), but a cached copy of what should have
  // been this response — as happened when Phase 2's guard shipped after
  // pages were already live and cached — is exactly the failure mode this
  // guards against. See docs/deployment.md's post-deploy cache-purge note.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function health(requestId, admin) {
  const body = JSON.stringify({ ok: true, service: 'add-blog', now: new Date().toISOString() });
  const response = new Response(body, { headers: { 'Content-Type': 'application/json' } });
  return withSharedHeaders(response, { requestId, admin });
}

export default {
  async fetch(request, env, ctx) {
    const start = Date.now();
    const url = new URL(request.url);
    const requestId = request.headers.get('X-Request-Id') || crypto.randomUUID();
    const adminHost = env.ADMIN_HOST || DEFAULT_ADMIN_HOST;
    const admin = url.hostname === adminHost;

    let response;
    if (!admin && isAdminOnlyPath(url.pathname)) {
      // The public host (or any hostname that isn't the recognised admin
      // host) never reaches anything else below for these paths — checked
      // before anything else, full stop, no exceptions carved out.
      response = notFound(requestId, admin);
    } else if (url.pathname === '/health') {
      response = health(requestId, admin);
    } else {
      response = withSharedHeaders(await env.ASSETS.fetch(request), { requestId, admin });
    }

    console.log(JSON.stringify({
      requestId,
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      admin,
      status: response.status,
      ms: Date.now() - start,
    }));

    return response;
  },
};
