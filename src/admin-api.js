/**
 * Admin API dispatcher. Phase 4 built identity (`GET /me`); Phase 5 adds the
 * Posts write path (src/admin-posts.js), Settings and the dashboard's
 * stats/audit reads (src/admin-settings.js, src/admin-dashboard.js), media
 * upload (src/admin-media.js), tags-as-a-resource (src/admin-tags.js) and
 * authors-as-a-resource (src/admin-authors.js, Phase 5e). `/export` and
 * `/import` remain unbuilt and fall through to `null` here, same as any
 * other not-yet-implemented route.
 *
 * By the time a request reaches here, src/index.js has already verified the
 * Access JWT and resolved `identity.author` — a null `identity` means Access
 * isn't configured for this site yet, in which case every route here falls
 * through to demo data exactly like an unbuilt route, rather than crashing
 * on a missing binding.
 */

import { handleAuthorsApi } from './admin-authors.js';
import { handleDashboardApi } from './admin-dashboard.js';
import { handleMediaApi } from './admin-media.js';
import { handlePostsApi } from './admin-posts.js';
import { handleSettingsApi } from './admin-settings.js';
import { handleTagsApi } from './admin-tags.js';
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
    (await handleDashboardApi(request, url, ctxBundle)) ||
    (await handleMediaApi(request, url, ctxBundle)) ||
    (await handleTagsApi(request, url, ctxBundle)) ||
    (await handleAuthorsApi(request, url, ctxBundle))
  );
}
