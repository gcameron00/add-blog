import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';

async function setSetting(key, value) {
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = ?`).bind(JSON.stringify(value), key).run();
}

describe('GET /site.webmanifest', () => {
  it('serves the default manifest with the built-in icon sizes', async () => {
    await setSetting('site_title', '');
    await setSetting('site_icon_key', '');
    const res = await SELF.fetch(`https://${HOST}/site.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');

    const manifest = await res.json();
    expect(manifest.name).toBe('The add-blog Journal');
    expect(manifest.icons).toEqual([
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
  });

  it('reflects settings.site_title and settings.site_icon_key (#15) the same way applySiteBranding does', async () => {
    await setSetting('site_title', 'Caitlin Ski');
    await setSetting('site_icon_key', '2026/08/abc123-icon.png');
    const manifest = await (await SELF.fetch(`https://${HOST}/site.webmanifest`)).json();
    expect(manifest.name).toBe('Caitlin Ski');
    expect(manifest.short_name).toBe('Caitlin Ski');
    // No fixed size claimed for an owner's unresized upload — "any" per the
    // manifest spec, same reasoning as src/manifest.js's comment.
    expect(manifest.icons).toEqual([{ src: '/media/2026/08/abc123-icon.png', sizes: 'any' }]);
  });
});
