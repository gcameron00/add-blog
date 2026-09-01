/**
 * add-blog Worker — hostname router (Phase 2) + public read path (Phase 3).
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
 * Phase 3 adds the public read path: JSON API, the server-rendered post
 * permalink, R2 media, and the feeds — all reading D1/R2 directly (no auth,
 * no writes; those are Phases 4 and 5). Every one of those handlers checks
 * for its own binding and returns null (falls through to static assets) if
 * it's missing, so this file is safe to deploy before wrangler.toml has the
 * real [[d1_databases]]/[[r2_buckets]] entries — same graceful "not live
 * yet" behaviour as today, not a 500.
 *
 * Phase 4 adds identity: on the admin host, the admin-only paths guarded
 * below also require a verified Cloudflare Access JWT (src/access.js) and a
 * matching `authors` row (src/auth.js) — but only once a site has set
 * ACCESS_TEAM_DOMAIN/ACCESS_AUD. A site that hasn't done that setup yet
 * keeps today's un-gated behaviour, same "not live yet" philosophy as the
 * Phase 3 handlers.
 *
 * Phase 5 adds the Posts write path (src/admin-posts.js, dispatched through
 * src/admin-api.js) — the first handler in this file's chain that can
 * mutate D1, which is why it needs `identity` (who) and `ctx` (to purge the
 * edge cache in the background via `ctx.waitUntil` without delaying the
 * response) alongside `env`.
 *
 * Phase 6 adds `/mcp` (src/mcp.js) — already in ADMIN_ONLY_PREFIXES below,
 * so it inherits the same Access-identity guard `/api/admin/*` gets with no
 * changes here; it just needed a handler to dispatch to.
 */

import { handlePublicApi } from './public-api.js';
import {
  handlePostPage,
  handleHomePage,
  handleAboutPage,
  handleCollectionIndexPage,
  handleCollectionItemPage,
  handleLegacyCollectionRedirect,
  handleLegacyPostRedirect,
  handleWordpressFeedRedirect,
} from './pages.js';
import { handleMedia } from './media.js';
import { handleFeeds } from './feeds.js';
import { verifyAccessIdentity } from './access.js';
import { resolveAuthor } from './auth.js';
import { handleAdminApi } from './admin-api.js';
import { handleMcp } from './mcp.js';
import { publishDuePosts } from './cron.js';
import { getSettings } from './db.js';
import { applySiteBranding, isFeatureEnabled } from './site-template.js';

const DEFAULT_ADMIN_HOST = 'blog-admin.mysite.com';

// Blocked on every hostname except the admin host. Prefix-matched with a
// trailing-slash (or exact) boundary so `/admin` blocks `/admin/posts` but
// not a hypothetical `/administrator` page — a naive `startsWith('/admin')`
// would get that wrong.
const ADMIN_ONLY_PREFIXES = ['/admin', '/api/admin', '/mcp'];

function matchesPrefix(pathname, prefixes) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isAdminOnlyPath(pathname) {
  return matchesPrefix(pathname, ADMIN_ONLY_PREFIXES);
}

// /collection and /collection-item (src/pages.js) are template shells only —
// real collection content is served at each collection's own base_path
// (e.g. /portfolio/), never at these literal paths. Blocked unconditionally,
// on every hostname, same reasoning as ADMIN_ONLY_PREFIXES: a raw,
// unbranded, unpopulated shell must never be directly reachable.
const SHELL_ONLY_PREFIXES = ['/collection', '/collection-item'];

function isShellOnlyPath(pathname) {
  return matchesPrefix(pathname, SHELL_ONLY_PREFIXES);
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

// blog-admin.*'s bare "/" isn't a real page — the dashboard lives at
// /admin/. Without this, the shared static bundle serves the public blog's
// own shell there instead (see docs/architecture.md's 2026-08-01 note): it's
// admin-gated by Access at the edge but never branded, since brandStaticAsset
// and handleHomePage both deliberately skip the admin host.
function redirectAdminRoot(url, admin) {
  if (!admin || url.pathname !== '/') return null;
  return Response.redirect(`${url.origin}/admin/`, 301);
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

// Shape from docs/api.md's error envelope. Used for the Phase 4 auth guard's
// 401/403s — same no-store belt-and-suspenders as notFound() above, for the
// same reason: an auth failure cached as if it were the real response is
// worse than the guard never having run.
function jsonError(status, code, message, { requestId, admin }) {
  const body = JSON.stringify({ error: { code, message } });
  const response = withSharedHeaders(
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } }),
    { requestId, admin }
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

// The remaining static pages (archive, tags, 404 — anything that isn't
// already its own templated handler above; /about is its own handler now,
// see handleAboutPage) still carry the literal "The add-blog Journal"
// wordmark in their header/footer. Branded here, generically, rather than as
// one handler per route: the Content-Type check keeps this off every
// non-HTML asset (CSS/JS/images), and `admin` keeps it off the admin shell,
// so it only ever runs — and only ever queries D1 — for an actual public
// HTML page load.
//
// Archive/Tags are gated on nav_config here too (isFeatureEnabled) — this is
// the one place both already fetch settings for every branded page, so
// there's nowhere cheaper to add "does this route even exist" than right
// after that fetch.
async function brandStaticAsset(response, env, admin, url) {
  if (admin || !env.DB) return response;
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return response;

  const settings = await getSettings(env.DB);
  if (
    (url.pathname === '/archive/' || url.pathname === '/archive') && !isFeatureEnabled(settings, 'archive')
  ) {
    return new Response('Not found', { status: 404 });
  }
  if ((url.pathname === '/tags/' || url.pathname === '/tags') && !isFeatureEnabled(settings, 'tags')) {
    return new Response('Not found', { status: 404 });
  }

  const html = applySiteBranding(await response.text(), settings);
  const headers = new Headers(response.headers);
  if (response.status === 200) {
    // docs/architecture.md §5: "Public HTML pages" caching policy. Left
    // alone on non-200s (e.g. 404.html) — that status already carries
    // whatever cache directive the static-asset guard intends for it.
    headers.set('Cache-Control', 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400');
  }
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
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
    let identity = null;

    if (isShellOnlyPath(url.pathname)) {
      response = notFound(requestId, admin);
    } else if (!admin && isAdminOnlyPath(url.pathname)) {
      // The public host (or any hostname that isn't the recognised admin
      // host) never reaches anything else below for these paths — checked
      // before anything else, full stop, no exceptions carved out.
      response = notFound(requestId, admin);
    } else if (admin && isAdminOnlyPath(url.pathname) && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
      // Cloudflare Access already terminates an unauthenticated request at
      // the edge — this is the Worker's own check on top of that, per
      // docs/architecture.md §6 ("Access is the front door, not the only
      // lock"). Gated on both vars being set so a site that hasn't done its
      // Phase 4 setup yet keeps today's behaviour rather than 401ing on
      // every admin request.
      try {
        const claims = await verifyAccessIdentity(request, env);
        const author = env.DB ? await resolveAuthor(env.DB, claims.email) : null;
        if (!author) {
          // A verified identity with no `authors` row is not an implicit
          // account — provisioning is explicit, per docs/architecture.md §6.
          response = jsonError(403, 'forbidden', 'No author record for this identity.', { requestId, admin });
        } else {
          identity = { email: claims.email, author };
        }
      } catch (err) {
        response = jsonError(err.status || 401, err.code || 'unauthenticated', err.message, { requestId, admin });
      }
    }

    if (!response) {
      if (url.pathname === '/health') {
        response = health(requestId, admin);
      } else {
        response =
          redirectAdminRoot(url, admin) ||
          handleLegacyPostRedirect(url) ||
          (await handleLegacyCollectionRedirect(request, url, env)) ||
          handleWordpressFeedRedirect(url) ||
          (await handlePostPage(request, url, env)) ||
          (await handleCollectionItemPage(request, url, env)) ||
          (await handleCollectionIndexPage(request, url, env)) ||
          (await handleHomePage(request, url, env, admin)) ||
          (await handleAboutPage(request, url, env)) ||
          (await handleAdminApi(request, url, { env, ctx, identity })) ||
          (await handleMcp(request, url, { env, ctx, identity })) ||
          (await handlePublicApi(request, url, env)) ||
          (await handleMedia(request, url, env)) ||
          (await handleFeeds(request, url, env)) ||
          (await brandStaticAsset(await env.ASSETS.fetch(request), env, admin, url));
        response = withSharedHeaders(response, { requestId, admin });
      }
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

  // Phase 5f — fires on the `crons` schedule in wrangler.toml's
  // [env.NAME.triggers]. ctx.waitUntil keeps the invocation alive until the
  // sweep finishes; there is no request/response here to hang off instead.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(publishDuePosts(env));
  },
};
