/**
 * Test-only helpers for signing fake Cloudflare Access JWTs. Not a *.test.js
 * file — vitest's `include` only picks up test files, so this just runs as
 * an ordinary module inside the same workerd runtime the tests execute in,
 * which is what lets it use the real Web Crypto API the way src/access.js
 * does rather than reimplementing RS256 signing by hand.
 */

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function generateAccessKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
}

/** JWKS document shape as served by `https://<team>/cdn-cgi/access/certs`. */
export async function jwksFor(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  return { keys: [{ ...jwk, kid }] };
}

/** Signs a JWT with the given RSA private key — defaults make a plausible, currently-valid Access token. */
export async function signAccessToken({ privateKey, kid, claims = {} }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    email: 'grant@mysite.com',
    aud: 'test-aud',
    iat: now,
    exp: now + 3600,
    sub: 'test-sub',
    ...claims,
  };
  const headerB64 = base64UrlEncodeJson({ alg: 'RS256', kid, typ: 'JWT' });
  const payloadB64 = base64UrlEncodeJson(payload);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}
