/**
 * SSRF-resistant fetch for `upload_media_from_url` (Phase 6, docs/mcp.md:
 * "Only https URLs, with redirects capped and private address ranges
 * blocked, so this cannot be used to probe internal endpoints").
 *
 * This checks the literal hostname/IP of the request URL and of every
 * redirect hop against a private/loopback/link-local block-list — it does
 * *not* resolve DNS itself (Workers' `fetch()` gives no hook to inspect the
 * resolved address before the request goes out), so a hostname that only
 * *later* resolves to a private address (DNS rebinding) is outside what a
 * literal-hostname check can catch. That gap is inherent to doing this
 * check in JS in front of `fetch()` rather than at the network layer; it is
 * not a reason to skip the check that does work against the far more common
 * case of a literal `http://169.254.169.254/...`-style URL.
 */

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function fetchError(code, message, preview) {
  return Object.assign(new Error(message), { code, preview: preview || undefined });
}

function isIpv4Literal(hostname) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.some((p) => p > 255)) return true; // malformed — refuse rather than guess
  const [a, b] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224-239) and reserved (240-255)
  return false;
}

function isPrivateIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || host === '::') return true; // loopback / unspecified
  if (host.startsWith('fe80')) return true; // link-local
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  if (isIpv4Literal(host)) return isPrivateIpv4(host);
  return false;
}

function assertFetchable(url) {
  if (url.protocol !== 'https:') throw fetchError('invalid_url', 'Only https:// URLs may be fetched.');
  if (isPrivateHost(url.hostname)) throw fetchError('invalid_url', 'That host is not reachable from here.');
}

/**
 * Fetches `urlString`, following redirects itself (rather than letting
 * `fetch` auto-follow them) so every hop gets the same host check as the
 * original URL, capped at `maxBytes`. Resolves to `{ bytes, contentType }`;
 * throws a fetch-shaped error (`.code`) that src/mcp-tools.js maps to a tool
 * error the model can read and correct from.
 */
export async function fetchMediaFromUrl(urlString, { allowedTypes, maxBytes }) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw fetchError('invalid_url', 'Not a valid URL.');
  }
  assertFetchable(url);

  let response;
  for (let redirects = 0; ; redirects += 1) {
    // cacheTtl: 0 — this is a one-shot fetch of a specific file, never worth
    // caching, and a wrongly-cached response (e.g. from a same-zone routing
    // hiccup) served for as long as the origin's own Cache-Control says is
    // worse than one extra trip to origin every time.
    //
    // A browser-shaped User-Agent/Accept pair is a cheap, honest thing to
    // send — this really is fetching a specific image a human asked for,
    // just via a script rather than a browser tab — and it's the one lever
    // available here against hosting-level bot protection (confirmed
    // 2026-08-05: SiteGround's AI Anti-Bot Protection challenges this
    // importer's fetches with a CAPTCHA page, `/.well-known/sgcaptcha/…`;
    // see docs/implementation-plan.md's Phase 7 section). Not guaranteed to
    // help against a behavioral/rate-based trigger, but costs nothing to try.
    response = await fetch(url, {
      redirect: 'manual',
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; add-blog-importer/1.0; +https://github.com/gcameron00/add-blog)',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    if (redirects >= MAX_REDIRECTS) throw fetchError('too_many_redirects', 'Too many redirects.');
    const location = response.headers.get('Location');
    if (!location) throw fetchError('fetch_failed', `Redirect (${response.status}) with no Location header.`);
    url = new URL(location, url);
    assertFetchable(url);
  }

  if (!response.ok) throw fetchError('fetch_failed', `Fetch failed with status ${response.status}.`);

  const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!allowedTypes.has(contentType)) {
    // A short body preview turns "wrong content-type" from a dead end into a
    // diagnosable failure — e.g. distinguishing a same-zone Worker's own
    // page, a Cloudflare error page, or a security challenge from each
    // other, none of which look alike once you can actually see one.
    const preview = await response.text().then((t) => t.slice(0, 300)).catch(() => '');
    throw fetchError('unsupported_media_type', `"${contentType || 'unknown'}" is not an allowed type.`, preview);
  }

  const declaredLength = Number(response.headers.get('Content-Length') || 0);
  if (declaredLength > maxBytes) throw fetchError('payload_too_large', `File exceeds the ${maxBytes} byte cap.`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw fetchError('payload_too_large', `File exceeds the ${maxBytes} byte cap.`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, contentType };
}
