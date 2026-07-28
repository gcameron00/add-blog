/**
 * Admin API dispatcher. Phase 4 built identity (`GET /me`); Phase 5 adds the
 * Posts write path (src/admin-posts.js). Tags/media/settings/authors/ops
 * routes from docs/api.md are still unbuilt — this returns `null` for them,
 * same as any other not-yet-implemented route.
 *
 * By the time a request reaches here, src/index.js has already verified the
 * Access JWT and resolved `identity.author` — a null `identity` means Access
 * isn't configured for this site yet, in which case every route here falls
 * through to demo data exactly like an unbuilt route, rather than crashing
 * on a missing binding.
 */

import { handlePostsApi } from './admin-posts.js';
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

export async function handleAdminApi(request, url, ctxBundle) {
  const { identity } = ctxBundle;
  if (!url.pathname.startsWith('/api/admin/')) return null;
  if (!identity) return null;

  if (url.pathname === '/api/admin/me' && request.method === 'GET') {
    return Response.json({ data: mapAuthor(identity.author) });
  }

  return handlePostsApi(request, url, ctxBundle);
}
