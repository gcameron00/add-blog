import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyAccessIdentity } from './access.js';
import { generateAccessKeyPair, jwksFor, signAccessToken } from './test-jwt.js';

const KID = 'test-key-1';
let keyPair;
let jwks;
let teamCounter = 0;

// A fresh team domain per test keeps each test's JWKS mock isolated from
// access.js's own in-memory cache (keyed by team domain) — without this,
// whichever test runs first would "win" the cache for every test after it
// in this file, since module state persists across `it()` blocks.
function freshTeam() {
  teamCounter += 1;
  return `team-${teamCounter}.cloudflareaccess.example`;
}

function stubJwksFetch(teamDomain, body = jwks) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === `https://${teamDomain}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
}

function requestWithToken(token) {
  return new Request('https://blog-admin.example/api/admin/me', {
    headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
  });
}

beforeAll(async () => {
  keyPair = await generateAccessKeyPair();
  jwks = await jwksFor(keyPair.publicKey, KID);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyAccessIdentity', () => {
  it('accepts a validly signed, in-range token for the right audience', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({ privateKey: keyPair.privateKey, kid: KID, claims: { aud: 'test-aud' } });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };

    const identity = await verifyAccessIdentity(requestWithToken(token), env);
    expect(identity).toEqual({ email: 'grant@mysite.com', sub: 'test-sub' });
  });

  it('rejects a missing header', async () => {
    const env = { ACCESS_TEAM_DOMAIN: freshTeam(), ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(null), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a malformed token', async () => {
    const env = { ACCESS_TEAM_DOMAIN: freshTeam(), ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken('not-a-jwt'), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token for a different Access application in the same team', async () => {
    // The single most commonly skipped check in an Access integration, per
    // docs/architecture.md §6 — a JWT that is validly signed by the team but
    // minted for a different `aud` must still be rejected.
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { aud: 'a-different-applications-aud' },
    });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an expired token', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { aud: 'test-aud', iat: now - 7200, exp: now - 3600 },
    });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token issued too far in the future', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { aud: 'test-aud', iat: now + 3600, exp: now + 7200 },
    });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token whose kid is not in the JWKS', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: 'some-other-kid',
      claims: { aud: 'test-aud' },
    });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with a tampered signature', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({ privateKey: keyPair.privateKey, kid: KID, claims: { aud: 'test-aud' } });
    const [h, p, s] = token.split('.');
    const tamperedSig = s.slice(0, -4) + (s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(`${h}.${p}.${tamperedSig}`), env)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a token signed by a key not in the JWKS at all', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const otherKeyPair = await generateAccessKeyPair();
    // Same kid as the real key, but signed by a different private key — the
    // signature check, not the kid lookup, must be what catches this.
    const token = await signAccessToken({ privateKey: otherKeyPair.privateKey, kid: KID, claims: { aud: 'test-aud' } });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token with no email claim', async () => {
    const team = freshTeam();
    stubJwksFetch(team);
    const token = await signAccessToken({
      privateKey: keyPair.privateKey,
      kid: KID,
      claims: { aud: 'test-aud', email: undefined },
    });
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    await expect(verifyAccessIdentity(requestWithToken(token), env)).rejects.toMatchObject({ status: 401 });
  });

  it('caches the JWKS instead of refetching on every request', async () => {
    const team = freshTeam();
    stubJwksFetch(team); // registers a fetch mock good for any number of calls
    const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'test-aud' };
    const token = await signAccessToken({ privateKey: keyPair.privateKey, kid: KID, claims: { aud: 'test-aud' } });

    await verifyAccessIdentity(requestWithToken(token), env);
    await verifyAccessIdentity(requestWithToken(token), env);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
