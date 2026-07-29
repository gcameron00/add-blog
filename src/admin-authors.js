/**
 * Admin Authors API (Phase 5e) — docs/api.md's Authors table. The row this
 * creates is what an Access identity resolves onto (src/auth.js's
 * `resolveAuthor`); it is not an account in its own right and there is no
 * invite email — Access grants the login, this just decides what a
 * successful login is allowed to do. Two manual steps stay outside this API
 * on purpose: adding the email to the Cloudflare Access policy, and telling
 * the person directly. The admin UI explains both after a successful
 * `POST /authors` rather than this route attempting either.
 *
 * All mutating routes require `authors.manage` (owner only, per
 * docs/architecture.md §6) — a role change or removal reaches every post the
 * target has ever written, not just the caller's own.
 *
 * `disabled` (Phase 5e, additive migration 0002) is the reversible half of
 * removing access: `resolveAuthor` stops matching the row, so the next
 * request 403s exactly like a missing row, but the row, its role and its
 * post history all stay put. Delete is the other half — it also detaches
 * the Access identity's *history* by repointing their posts at whoever
 * performed the delete, per docs/api.md ("their posts are reassigned to the
 * owner").
 *
 * Two self-protection guards, both `409`s rather than silently no-ops:
 * disable and delete, plus a role change away from `owner`, are blocked if
 * the target is the only remaining active owner (a site with zero owners
 * has no one left who can undo the mistake); disable and delete are also
 * blocked against the caller's own row regardless of how many other owners
 * exist — cutting off your own access is for another owner to do to you,
 * not an accidental click to do to yourself. A role change away from
 * `owner` on your own row is *not* blocked the same way: it's recoverable
 * (another owner can re-promote you) and doesn't cut off access outright,
 * unlike disable/delete.
 */

import {
  authorEmailExists,
  countActiveOwners,
  deleteAuthorRow,
  getAuthorById,
  insertAuthor,
  listAdminAuthors,
  reassignPosts,
  updateAuthorRow,
} from './admin-db.js';
import { apiError, apiFail, readJsonBody, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { writeAuditLog } from './audit.js';
import { validateAuthorBio, validateAuthorEmail, validateAuthorName, validateAuthorRole } from './validate.js';

function mapAuthor(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    bio: row.bio,
    role: row.role,
    disabled: Boolean(row.disabled),
    avatar: row.avatar_key ? `/media/avatars/${row.avatar_key}` : null,
    post_count: row.post_count ?? 0,
    created_at: row.created_at,
  };
}

/** Would this change leave the site with no one who can sign in as owner? Only a target that is *currently* an active owner can trip it. */
async function assertNotLastOwner(env, author, action) {
  if (author.role !== 'owner' || author.disabled) return;
  const remaining = await countActiveOwners(env.DB, author.id);
  if (remaining === 0) {
    apiFail(409, 'conflict', `Can't ${action} the only remaining owner — promote someone else first.`);
  }
}

/** Cutting off your own access is for another owner to do to you, not a click you make on your own row — checked before the last-owner query since it never needs one. */
function assertNotSelf(identity, id, action) {
  if (id === identity.author.id) {
    apiFail(409, 'conflict', `Can't ${action} your own account — ask another owner to do it.`);
  }
}

async function listHandler(env) {
  const rows = await listAdminAuthors(env.DB);
  return Response.json({ data: rows.map(mapAuthor) });
}

async function createHandler(request, env, identity) {
  requirePermission(identity, 'authors.manage');
  const input = await readJsonBody(request);

  const name = validateAuthorName(input.name);
  const email = validateAuthorEmail(input.email);
  const role = validateAuthorRole(input.role ?? 'author');
  const bio = validateAuthorBio(input.bio);

  if (await authorEmailExists(env.DB, email)) {
    return apiError(409, 'conflict', `"${email}" already has an author row.`, { field: 'email' });
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  await insertAuthor(env.DB, { id, email, name, role, bio, created_at });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'author.create', entity: 'author', entityId: id, detail: { email, role },
  });

  return Response.json({ data: mapAuthor({ id, email, name, bio, role, disabled: 0, avatar_key: null, post_count: 0, created_at }) }, { status: 201 });
}

async function patchHandler(request, env, identity, id) {
  requirePermission(identity, 'authors.manage');
  const author = await getAuthorById(env.DB, id);
  if (!author) return apiError(404, 'not_found', 'Not found.');

  const input = await readJsonBody(request);
  const fields = {};

  if (input.name !== undefined) fields.name = validateAuthorName(input.name);
  if (input.bio !== undefined) fields.bio = validateAuthorBio(input.bio);
  if (input.email !== undefined) {
    const email = validateAuthorEmail(input.email);
    if (await authorEmailExists(env.DB, email, id)) {
      return apiError(409, 'conflict', `"${email}" already has an author row.`, { field: 'email' });
    }
    fields.email = email;
  }
  if (input.role !== undefined) {
    const role = validateAuthorRole(input.role);
    if (role !== 'owner') await assertNotLastOwner(env, author, 'change the role of');
    fields.role = role;
  }
  if (input.disabled !== undefined) {
    const disabled = Boolean(input.disabled);
    if (disabled) {
      assertNotSelf(identity, id, 'disable');
      await assertNotLastOwner(env, author, 'disable');
    }
    fields.disabled = disabled ? 1 : 0;
  }
  if (!Object.keys(fields).length) return apiError(400, 'bad_request', 'Nothing to update.');

  await updateAuthorRow(env.DB, id, fields);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'author.update', entity: 'author', entityId: id, detail: fields,
  });

  const updated = await getAuthorById(env.DB, id);
  return Response.json({ data: mapAuthor(updated) });
}

async function deleteHandler(env, identity, id) {
  requirePermission(identity, 'authors.manage');
  const author = await getAuthorById(env.DB, id);
  if (!author) return apiError(404, 'not_found', 'Not found.');

  assertNotSelf(identity, id, 'delete');
  await assertNotLastOwner(env, author, 'delete');

  await reassignPosts(env.DB, id, identity.author.id);
  await deleteAuthorRow(env.DB, id);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'author.delete', entity: 'author', entityId: id,
    detail: { email: author.email, posts_reassigned_to: identity.author.id },
  });

  return Response.json({ data: { id } });
}

export async function handleAuthorsApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity || !env.DB) return null;
  if (!url.pathname.startsWith('/api/admin/authors')) return null;

  return withErrors(async () => {
    if (request.method !== 'GET') requireSameOrigin(request, url);

    const rest = url.pathname.slice('/api/admin/authors'.length);

    if (rest === '' || rest === '/') {
      if (request.method === 'GET') return listHandler(env);
      if (request.method === 'POST') return createHandler(request, env, identity);
      return null;
    }

    const idMatch = rest.match(/^\/(.+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (request.method === 'PATCH') return patchHandler(request, env, identity, id);
      if (request.method === 'DELETE') return deleteHandler(env, identity, id);
    }

    return null;
  });
}
