/**
 * Cloudflare Access JWT verification (Phase 4).
 *
 * Access already terminates unauthenticated requests at Cloudflare's edge —
 * the admin hostname's Access application has no path exclusions, so a
 * request without a session never reaches this Worker. This module is the
 * defense-in-depth check docs/architecture.md §6 calls for on top of that:
 * the Worker verifies `Cf-Access-Jwt-Assertion` itself rather than trusting
 * that it arrived at all — signature against the team's JWKS, `aud` equal to
 * *this* Access application (not just any application in the team), and
 * `exp`/`iat` in range. Skipping the `aud` check is the single most common
 * mistake in an Access integration: it would accept a JWT minted for a
 * completely different Access application in the same team.
 */

const JWKS_TTL_MS = 60 * 60 * 1000;

// Keyed by team domain so tests (and, in principle, a future multi-team
// setup) don't share a cache entry across different teams.
const jwksCacheByTeam = new Map();

function base64UrlToBytes(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

function accessError(message, code = 'unauthenticated', status = 401) {
  return Object.assign(new Error(message), { status, code });
}

async function fetchJwks(teamDomain) {
  const cached = jwksCacheByTeam.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw accessError(`Access JWKS fetch failed (${res.status})`, 'unauthenticated', 401);

  const { keys } = await res.json();
  const imported = new Map();
  for (const jwk of keys || []) {
    if (!jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    imported.set(jwk.kid, key);
  }
  jwksCacheByTeam.set(teamDomain, { keys: imported, fetchedAt: Date.now() });
  return imported;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header against `env.ACCESS_TEAM_DOMAIN`
 * and `env.ACCESS_AUD`. Resolves to `{ email, sub }` on success; rejects with
 * an Error carrying `.status` (401) and `.code` (for the JSON error envelope
 * in docs/api.md) otherwise. Callers decide what to do with a missing
 * `authors` row — this module only proves *who*, not *what they can do*.
 */
export async function verifyAccessIdentity(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw accessError('Missing Access identity');

  const parts = token.split('.');
  if (parts.length !== 3) throw accessError('Malformed Access JWT');
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = base64UrlToJson(headerB64);
    payload = base64UrlToJson(payloadB64);
  } catch {
    throw accessError('Malformed Access JWT');
  }

  const keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN);
  const key = keys.get(header.kid);
  if (!key) throw accessError('Unknown Access signing key');

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    signingInput
  );
  if (!valid) throw accessError('Invalid Access JWT signature');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw accessError('Access JWT audience mismatch');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw accessError('Access JWT expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw accessError('Access JWT not yet valid');

  if (!payload.email) throw accessError('Access JWT missing email');

  return { email: payload.email, sub: payload.sub };
}
