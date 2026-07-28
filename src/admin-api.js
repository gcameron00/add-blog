/**
 * Admin API dispatcher. Phase 4 built identity (`GET /me`); Phase 5 adds the
 * Posts write path (src/admin-posts.js) and, in its second slice, Settings
 * (src/admin-settings.js) and the dashboard's stats/audit reads
 * (src/admin-dashboard.js). Tags-as-a-resource, Authors, and media routes
 * from docs/api.md are still unbuilt — deliberately: nothing in the shipped
 * admin UI calls them yet, unlike everything built so far. This returns
 * `null` for them, same as any other not-yet-implemented route.
 *
 * By the time a request reaches here, src/index.js has already verified the
 * Access JWT and resolved `identity.author` — a null `identity` means Access
 * isn't configured for this site yet, in which case every route here falls
 * through to demo data exactly like an unbuilt route, rather than crashing
 * on a missing binding.
 */

import { handleDashboardApi } from './admin-dashboard.js';
import { handlePostsApi } from './admin-posts.js';
import { handleSettingsApi } from './admin-settings.js';
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

  return (
    (await handlePostsApi(request, url, ctxBundle)) ||
    (await handleSettingsApi(request, url, ctxBundle)) ||
    (await handleDashboardApi(request, url, ctxBundle))
  );
}
