/**
 * Admin API (Phase 4: identity only — `GET /me`. Phase 5 adds the rest of
 * docs/api.md's Admin API section: posts, tags, media, settings.)
 *
 * By the time a request reaches here, src/index.js has already verified the
 * Access JWT and resolved `identity.author` — a null `identity` means Access
 * isn't configured for this site yet (see the graceful-degradation note in
 * src/index.js), in which case this falls through to demo data exactly like
 * an unbuilt route, rather than crashing on a missing binding.
 */

import { permissionsFor } from './auth.js';

function mapAuthor(author) {
  return {
    id: author.id,
    email: author.email,
    name: author.name,
    role: author.role,
    avatar: author.avatar_key ? `/media/avatars/${author.avatar_key}` : null,
    permissions: permissionsFor(author.role),
  };
}

export async function handleAdminApi(request, url, identity) {
  if (!url.pathname.startsWith('/api/admin/')) return null;
  if (!identity) return null;

  if (url.pathname === '/api/admin/me' && request.method === 'GET') {
    return Response.json({ data: mapAuthor(identity.author) });
  }

  return null;
}
