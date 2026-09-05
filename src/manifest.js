/**
 * GET /site.webmanifest and GET /favicon.ico — the two icon-discovery paths
 * that, unlike every <link> in the HTML shell, aren't per-request templated
 * by applySiteBranding (src/site-template.js) and so need their own settings
 * read to stay in sync with a site's custom settings.site_icon_key.
 *
 * /site.webmanifest is the Web App Manifest Android/Chrome/Edge read when a
 * visitor installs the site or adds it to the home screen.
 *
 * /favicon.ico is the root-relative path some non-browser tools (link
 * unfurlers, older crawlers) request by convention, and what a visitor gets
 * if they type it directly — assets/favicon.svg and the static favicon.ico
 * at the repo root are one shared file across every site in this deployment
 * (wrangler.toml's one asset bundle for every [env.NAME]), so without this,
 * every site's /favicon.ico always shows the generic default checkmark
 * regardless of that site's own brand icon. Redirects to the site's actual
 * uploaded icon (served by src/media.js, which already reports the correct
 * Content-Type for whatever format it was uploaded as) rather than trying to
 * re-wrap an arbitrary upload as a real .ico file.
 *
 * Both fall through (return null) when env.DB isn't bound yet or no custom
 * icon is set — same "not live yet"/non-regressive pattern as every other
 * handler in this file's dispatch chain — leaving the static defaults
 * (site.webmanifest and favicon.ico, both at the repo root) to serve as-is.
 */

import { getSettings } from './db.js';

const DEFAULT_NAME = 'The add-blog Journal';
const MANIFEST_CACHE_CONTROL = 'public, max-age=60, s-maxage=3600, stale-while-revalidate=86400';

export async function handleManifest(request, url, env) {
  if (url.pathname !== '/site.webmanifest') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!env.DB) return null;

  const settings = await getSettings(env.DB);
  const name = settings.site_title || DEFAULT_NAME;

  // Unlike the HTML <link> swap, there's no fixed `sizes` to claim for an
  // owner's arbitrary upload (site_icon_key isn't resized anywhere in this
  // codebase) — "any" is the manifest spec's own way of saying that, rather
  // than asserting 192x192/512x512 that likely aren't true.
  const icons = settings.site_icon_key
    ? [{ src: `/media/${settings.site_icon_key}`, sizes: 'any' }]
    : [
        { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
      ];

  const manifest = {
    name,
    short_name: name,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#2563eb',
    icons,
  };

  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': MANIFEST_CACHE_CONTROL },
  });
}

export async function handleFaviconIco(request, url, env) {
  if (url.pathname !== '/favicon.ico') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!env.DB) return null;

  const settings = await getSettings(env.DB);
  if (!settings.site_icon_key) return null;

  // 302, not 301: the owner can change or clear site_icon_key later, and a
  // browser/tool must not keep permanently redirecting to a since-changed
  // or since-deleted icon.
  return Response.redirect(`${url.origin}/media/${settings.site_icon_key}`, 302);
}
