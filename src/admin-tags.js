/**
 * Admin Tags API (Phase 5d) — docs/api.md's Tags table. Posts could already
 * *attach* tags (`setPostTags` in src/admin-db.js creates a tag on first
 * use, from Phase 5a); this is the missing piece — managing the tag list
 * itself, independent of any one post.
 *
 * Read (`GET`) only requires a signed-in identity, same as the rest of the
 * admin API; the mutating routes require `tags.manage` (owner/editor —
 * renaming or deleting a tag touches every post that carries it, not just
 * the caller's own, so it sits at the same level as `post.editOthers`
 * rather than `post.editOwn`).
 *
 * **Not built:** renaming a tag's slug doesn't leave a redirect behind. The
 * public tag page (`/tags/?tag=<slug>`) is a live query-parameter filter
 * against the *current* slug, not a static route with its own history, so a
 * bookmark or inbound link to the old slug just returns zero posts rather
 * than 404ing — annoying, not broken. A redirect table is real schema work
 * this slice didn't need to do to make tag management usable.
 */

import {
  deleteTagRow,
  getAdminTagById,
  getTagById,
  insertTag,
  listAdminTags,
  mergeTagsRows,
  tagSlugExists,
  updateTagRow,
} from './admin-db.js';
import { apiError, readJsonBody, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { writeAuditLog } from './audit.js';
import { slugify } from '../assets/js/markdown.js';
import { validateTagName, validateTagSlug } from './validate.js';

function mapTag(row) {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, post_count: row.post_count ?? 0 };
}

async function listHandler(env) {
  const rows = await listAdminTags(env.DB);
  return Response.json({ data: rows.map(mapTag) });
}

async function createHandler(request, env, identity) {
  requirePermission(identity, 'tags.manage');
  const input = await readJsonBody(request);

  const name = validateTagName(input.name);
  const slug = validateTagSlug(input.slug?.trim() || slugify(name));
  if (await tagSlugExists(env.DB, slug)) {
    return apiError(409, 'conflict', `The slug "${slug}" is already in use.`, { field: 'slug' });
  }
  const description = input.description ? String(input.description).slice(0, 500) : null;

  const id = crypto.randomUUID();
  await insertTag(env.DB, { id, slug, name, description });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'tag.create', entity: 'tag', entityId: id, detail: { name, slug },
  });

  return Response.json({ data: mapTag({ id, slug, name, description, post_count: 0 }) }, { status: 201 });
}

async function patchHandler(request, env, identity, id) {
  requirePermission(identity, 'tags.manage');
  const tag = await getTagById(env.DB, id);
  if (!tag) return apiError(404, 'not_found', 'Not found.');

  const input = await readJsonBody(request);
  const fields = {};
  if (input.name !== undefined) fields.name = validateTagName(input.name);
  if (input.slug !== undefined) {
    const slug = validateTagSlug(input.slug);
    if (await tagSlugExists(env.DB, slug, id)) {
      return apiError(409, 'conflict', `The slug "${slug}" is already in use.`, { field: 'slug' });
    }
    fields.slug = slug;
  }
  if (input.description !== undefined) fields.description = input.description ? String(input.description).slice(0, 500) : null;
  if (!Object.keys(fields).length) return apiError(400, 'bad_request', 'Nothing to update.');

  await updateTagRow(env.DB, id, fields);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'tag.update', entity: 'tag', entityId: id, detail: fields,
  });

  const updated = await getAdminTagById(env.DB, id);
  return Response.json({ data: mapTag(updated) });
}

async function deleteHandler(env, identity, id) {
  requirePermission(identity, 'tags.manage');
  const tag = await getTagById(env.DB, id);
  if (!tag) return apiError(404, 'not_found', 'Not found.');

  await deleteTagRow(env.DB, id);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'tag.delete', entity: 'tag', entityId: id, detail: { slug: tag.slug },
  });

  return Response.json({ data: { id } });
}

async function mergeHandler(request, env, identity) {
  requirePermission(identity, 'tags.manage');
  const input = await readJsonBody(request);

  if (!Array.isArray(input.from) || !input.from.length) {
    return apiError(400, 'bad_request', '"from" must be a non-empty array of tag slugs.', { field: 'from' });
  }
  if (typeof input.into !== 'string' || !input.into) {
    return apiError(400, 'bad_request', '"into" must be a tag slug.', { field: 'into' });
  }

  const allSlugs = [...new Set([...input.from, input.into])];
  const rows = await listAdminTags(env.DB);
  const bySlug = new Map(rows.map((row) => [row.slug, row]));

  const missing = allSlugs.filter((slug) => !bySlug.has(slug));
  if (missing.length) {
    return apiError(404, 'not_found', `Unknown tag slug(s): ${missing.join(', ')}.`, { detail: { missing } });
  }

  const into = bySlug.get(input.into);
  const fromIds = input.from.map((slug) => bySlug.get(slug).id).filter((id) => id !== into.id);

  await mergeTagsRows(env.DB, fromIds, into.id);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'tag.merge', entity: 'tag', entityId: into.id,
    detail: { from: input.from, into: input.into },
  });

  const merged = await getAdminTagById(env.DB, into.id);
  return Response.json({ data: mapTag(merged) });
}

export async function handleTagsApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity || !env.DB) return null;
  if (!url.pathname.startsWith('/api/admin/tags')) return null;

  return withErrors(async () => {
    if (request.method !== 'GET') requireSameOrigin(request, url);

    const rest = url.pathname.slice('/api/admin/tags'.length);

    if (rest === '' || rest === '/') {
      if (request.method === 'GET') return listHandler(env);
      if (request.method === 'POST') return createHandler(request, env, identity);
      return null;
    }

    if (rest === '/merge' && request.method === 'POST') return mergeHandler(request, env, identity);

    const idMatch = rest.match(/^\/(.+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (request.method === 'PATCH') return patchHandler(request, env, identity, id);
      if (request.method === 'DELETE') return deleteHandler(env, identity, id);
    }

    return null;
  });
}
