/**
 * GET /site.webmanifest — the Web App Manifest that Android/Chrome/Edge read
 * when a visitor installs the site or adds it to the home screen (the piece
 * neither the favicon <link>s nor apple-touch-icon cover: see docs on icon
 * compatibility). Dynamic, not a static file, because it has to reflect
 * settings.site_title/site_icon_key the same way applySiteBranding
 * (src/site-template.js) brands the HTML shell.
 *
 * No env.DB (not live yet) falls through to the static site.webmanifest at the
 * repo root — same "not live yet" pattern as every other handler in this
 * file's dispatch chain.
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
