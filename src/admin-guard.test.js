/**
 * Integration tests for the Phase 4 guard wired into src/index.js's fetch
 * handler. These call the worker's exported `fetch` directly (rather than
 * `SELF.fetch`, which always dispatches against vitest.config.js's fixed
 * miniflare env) so each test can supply its own ACCESS_TEAM_DOMAIN/
 * ACCESS_AUD on top of the real seeded D1 from `cloudflare:test`'s `env`.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { generateAccessKeyPair, jwksFor, signAccessToken } from './test-jwt.js';

const ADMIN_HOST = 'blog-admin.mysite.com'; // src/index.js's DEFAULT_ADMIN_HOST — no ADMIN_HOST var in the test env
const KID = 'test-key-1';
let keyPair;
let jwks;
let teamCounter = 0;

function freshTeam() {
  teamCounter += 1;
  return `guard-team-${teamCounter}.cloudflareaccess.example`;
}

function stubJwksFetch(teamDomain) {
  // The only global `fetch` call anywhere in this request path is
  // access.js's JWKS lookup — env.ASSETS/env.DB/env.MEDIA are binding
  // methods, not `fetch`, so there is nothing else to let through here.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === `https://${teamDomain}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
}

async function call(customEnv, path, init) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://${ADMIN_HOST}${path}`, init), customEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeAll(async () => {
  keyPair = await generateAccessKeyPair();
  jwks = await jwksFor(keyPair.publicKey, KID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin host, ACCESS configured — every admin-only path requires a valid identity', () => {
  it('401s a request with no Access JWT at all', async () => {
    const team = freshTeam();
    const res = await call({ ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' }, '/admin/');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('401s /mcp too — the same guard covers it, ahead of Phase 6 building anything there', async () => {
    const team = freshTeam();
    const res = await call({ ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' }, '/mcp');
    expect(res.status).toBe(401);
  });

  it('403s a validly signed identity with no matching authors row', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { email: 'nobody@mysite.com', aud: 'test-aud' },
    });
    const res = await call(
      { ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' },
      '/admin/',
      { headers: { 'Cf-Access-Jwt-Assertion': token } }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('lets a verified, provisioned identity through to the real admin page', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { email: 'grant@mysite.com', aud: 'test-aud' },
    });
    const res = await call(
      { ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' },
      '/admin/',
      { headers: { 'Cf-Access-Jwt-Assertion': token } }
    );
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/me returns the resolved identity, role and permissions', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { email: 'ada@mysite.com', aud: 'test-aud' },
    });
    const res = await call(
      { ...env, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' },
      '/api/admin/me',
      { headers: { 'Cf-Access-Jwt-Assertion': token } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ email: 'ada@mysite.com', name: 'Ada Okafor', role: 'editor' });
    expect(body.data.permissions).toEqual(expect.arrayContaining(['post.editOwn', 'post.publish']));
    expect(body.data.permissions).not.toEqual(expect.arrayContaining(['settings.manage']));
  });
});

describe('admin host, ACCESS not configured for this site — unchanged pre-Phase-4 behaviour', () => {
  it('still serves the admin dashboard with no JWT, same as before Phase 4', async () => {
    const res = await call(env, '/admin/'); // no ACCESS_TEAM_DOMAIN/ACCESS_AUD override
    expect(res.status).toBe(200);
  });
});

describe('public host — the guard never even runs', () => {
  it('admin-only paths are still a plain 404, JWT or not', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://blog.mysite.com/admin/', { headers: { 'Cf-Access-Jwt-Assertion': 'irrelevant' } }),
      { ...env, ACCESS_TEAM_DOMAIN: freshTeam(), ACCESS_AUD: 'test-aud' },
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
