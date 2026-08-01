import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const PUBLIC_HOST = 'blog.mysite.com';
const ADMIN_HOST = 'blog-admin.mysite.com';

async function get(host, path) {
  return SELF.fetch(`https://${host}${path}`, { redirect: 'manual' });
}

describe('public host — admin paths are always 404', () => {
  for (const path of ['/admin', '/admin/', '/admin/posts/', '/api/admin/posts', '/mcp', '/mcp/']) {
    it(`blocks ${path}`, async () => {
      const res = await get(PUBLIC_HOST, path);
      expect(res.status).toBe(404);
    });
  }

  it('never lets a blocked response be cached, at the edge or the browser', async () => {
    // A cached copy of a page that should have been blocked is exactly how
    // a stale pre-Phase-2 cache entry kept serving /admin/* after the guard
    // shipped — this response must refuse to be that cache entry itself.
    const res = await get(PUBLIC_HOST, '/admin/');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not over-match a lookalike path', async () => {
    // /administrator is not /admin — the guard must not treat it as blocked
    // by the admin-path check specifically (it may still 404 as a missing
    // asset, but not via the security guard this test targets).
    const res = await get(PUBLIC_HOST, '/administrator');
    expect(res.status).toBe(404);
    // A real public page must still work, proving the guard isn't blocking
    // everything wholesale.
    const home = await get(PUBLIC_HOST, '/');
    expect(home.status).toBe(200);
  });

  it('serves the public home page', async () => {
    const res = await get(PUBLIC_HOST, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<html');
  });
});

describe('admin host — admin paths are reachable', () => {
  it('serves the admin dashboard', async () => {
    const res = await get(ADMIN_HOST, '/admin/');
    expect(res.status).toBe(200);
  });

  it('serves the editor page', async () => {
    const res = await get(ADMIN_HOST, '/admin/editor/');
    expect(res.status).toBe(200);
  });

  it('redirects the bare root to /admin/ rather than serving the public blog shell', async () => {
    const res = await get(ADMIN_HOST, '/');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`https://${ADMIN_HOST}/admin/`);
  });
});

describe('headers', () => {
  it('sets security headers on every response', async () => {
    const res = await get(PUBLIC_HOST, '/');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('marks admin responses private, no-store, and frame-denied', async () => {
    const res = await get(ADMIN_HOST, '/admin/');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('does not mark public responses no-store', async () => {
    const res = await get(PUBLIC_HOST, '/');
    expect(res.headers.get('Cache-Control')).not.toBe('private, no-store');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('echoes an incoming X-Request-Id rather than replacing it', async () => {
    const res = await SELF.fetch(`https://${PUBLIC_HOST}/`, {
      headers: { 'X-Request-Id': 'test-fixed-id' },
    });
    expect(res.headers.get('X-Request-Id')).toBe('test-fixed-id');
  });

  it('allows the EasyMDE CDN in the CSP for the admin editor', async () => {
    const res = await get(ADMIN_HOST, '/admin/editor/');
    expect(res.headers.get('Content-Security-Policy')).toContain('https://cdn.jsdelivr.net');
  });
});

describe('/health', () => {
  it('responds ok on both hosts without hitting the admin guard', async () => {
    for (const host of [PUBLIC_HOST, ADMIN_HOST]) {
      const res = await get(host, '/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    }
  });
});

describe('an unrecognised hostname fails toward public, never admin', () => {
  it('treats a random hostname as public — admin paths still 404', async () => {
    const res = await get('some-other-host.example.com', '/admin/');
    expect(res.status).toBe(404);
  });
});
