import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';
const KEY = '2026/07/test-image.png';
const URL_PATH = `/media/${KEY}`;

beforeAll(async () => {
  await env.MEDIA.put(KEY, new Blob(['fake-png-bytes']), {
    httpMetadata: { contentType: 'image/png' },
  });
});

describe('GET /media/:key', () => {
  it('streams the object with immutable caching', async () => {
    const res = await SELF.fetch(`https://${HOST}${URL_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('fake-png-bytes');
  });

  it('404s for a key that was never uploaded', async () => {
    const res = await SELF.fetch(`https://${HOST}/media/2026/07/never-uploaded.png`);
    expect(res.status).toBe(404);
  });

  it('supports HEAD with no body', async () => {
    const res = await SELF.fetch(`https://${HOST}${URL_PATH}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('honours If-None-Match with a 304', async () => {
    const first = await SELF.fetch(`https://${HOST}${URL_PATH}`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await SELF.fetch(`https://${HOST}${URL_PATH}`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
  });
});
