/**
 * Admin Posts API (Phase 5) — docs/api.md's "Posts" and `/preview` routes.
 * Everything here assumes src/index.js's guard has already verified the
 * caller's Access identity and resolved an `authors` row (Phase 4); the
 * `identity` this module receives is never null when a route handler runs.
 */

import { excerptFrom, readingMinutes, renderMarkdown, slugify, wordCount } from '../assets/js/markdown.js';
import {
  deletePostRow,
  etagFor,
  getAdminPostById,
  getRevision,
  insertPost,
  insertRevision,
  listAdminPosts,
  listRevisions,
  setPostTags,
  slugExists,
  uniqueSlug,
  updatePostRow,
} from './admin-db.js';
import { can } from './auth.js';
import { writeAuditLog } from './audit.js';
import { purgePostUrls } from './cache-purge.js';
import { ValidationError, validateBodyMd, validateScheduledFor, validateSlug, validateTags, validateTitle, validateVisibility } from './validate.js';

function apiError(status, code, message, extra = {}) {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

function apiFail(status, code, message, extra = {}) {
  throw Object.assign(new Error(message), { status, code, ...extra });
}

async function withErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status) {
      const extra = {};
      if (err.field) extra.field = err.field;
      if (err.detail) extra.detail = err.detail;
      return apiError(err.status, err.code || 'bad_request', err.message, extra);
    }
    console.error(err);
    return apiError(500, 'internal_error', 'Unexpected error.');
  }
}

function requireSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== url.origin) apiFail(403, 'forbidden', 'Cross-origin write rejected.');
}

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) throw new ValidationError('Content-Type must be application/json.');
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Malformed JSON body.');
  }
}

function requirePermission(identity, permission) {
  if (!can(identity.author.role, permission)) apiFail(403, 'forbidden', 'Your role cannot do this.');
}

function requirePostWriteAccess(identity, post) {
  requirePermission(identity, post.author.id === identity.author.id ? 'post.editOwn' : 'post.editOthers');
}

function computeContent(bodyMd, explicitExcerpt) {
  return {
    body_html: renderMarkdown(bodyMd),
    word_count: wordCount(bodyMd),
    reading_minutes: readingMinutes(bodyMd),
    excerpt: explicitExcerpt || excerptFrom(bodyMd, 190),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function purgeIfPublic(ctx, env, { wasPublished, isPublished, slug, previousSlug, tags = [] }) {
  if (!wasPublished && !isPublished) return;
  ctx.waitUntil(purgePostUrls(`https://${env.PUBLIC_HOST}`, { slug, previousSlug, tags }));
}

/* --- Route handlers -------------------------------------------------------- */

async function listHandler(url, env) {
  const q = url.searchParams;
  const result = await listAdminPosts(env.DB, {
    status: q.get('status') || 'all',
    tag: q.get('tag') || undefined,
    author: q.get('author') || undefined,
    q: q.get('q') || undefined,
    sort: q.get('sort') || 'updated',
    limit: q.get('limit'),
    offset: q.get('offset'),
  });
  return Response.json(result);
}

async function createHandler(request, env, identity) {
  const input = await readJsonBody(request);

  const title = validateTitle(input.title);
  const baseSlug = input.slug ? validateSlug(input.slug) : slugify(title);
  if (!baseSlug) throw new ValidationError('Unable to derive a slug from the title.', 'slug');
  const slug = await uniqueSlug(env.DB, baseSlug);
  const bodyMd = validateBodyMd(input.body_md || '');
  const tags = validateTags(input.tags);
  const visibility = validateVisibility(input.visibility);
  const { body_html, word_count, reading_minutes, excerpt } = computeContent(bodyMd, input.excerpt?.trim());

  const post = {
    id: crypto.randomUUID(),
    slug,
    title,
    subtitle: input.subtitle || null,
    excerpt,
    body_md: bodyMd,
    body_html,
    status: 'draft',
    visibility,
    author_id: identity.author.id,
    cover_key: input.cover_key || null,
    cover_alt: input.cover_alt || null,
    canonical_url: input.canonical_url || null,
    word_count,
    reading_minutes,
    created_at: nowIso(),
    updated_at: nowIso(),
    published_at: null,
    scheduled_for: null,
  };

  await insertPost(env.DB, post);
  if (tags.length) await setPostTags(env.DB, post.id, tags);
  await insertRevision(env.DB, { postId: post.id, title, bodyMd, authorId: identity.author.id, note: 'create' });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'post.create', entity: 'post', entityId: post.id, detail: { title, slug },
  });

  const created = await getAdminPostById(env.DB, post.id);
  return Response.json({ data: created }, { status: 201, headers: { ETag: etagFor(created) } });
}

async function getHandler(env, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  return Response.json({ data: post }, { headers: { ETag: etagFor(post) } });
}

async function patchHandler(request, env, identity, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePostWriteAccess(identity, post);

  const ifMatch = request.headers.get('If-Match');
  if (ifMatch && ifMatch !== etagFor(post)) {
    return apiError(409, 'conflict', 'This post changed since you last loaded it.', {
      detail: { current_etag: etagFor(post), submitted_if_match: ifMatch },
    });
  }

  const input = await readJsonBody(request);
  const fields = {};
  const previousSlug = post.slug;

  if (input.title !== undefined) fields.title = validateTitle(input.title);
  if (input.slug !== undefined && input.slug !== post.slug) {
    const slug = validateSlug(input.slug);
    if (await slugExists(env.DB, slug, post.id)) {
      // Matches docs/api.md's documented error example exactly — editor.js
      // already special-cases `error.code === 'slug_taken'` to refocus the
      // slug field, written against the spec before this endpoint existed.
      return apiError(409, 'slug_taken', `A post with the slug "${slug}" already exists.`, { field: 'slug' });
    }
    fields.slug = slug;
  }
  if (input.subtitle !== undefined) fields.subtitle = input.subtitle || null;
  if (input.visibility !== undefined) fields.visibility = validateVisibility(input.visibility);
  if (input.cover_key !== undefined) fields.cover_key = input.cover_key || null;
  if (input.cover_alt !== undefined) fields.cover_alt = input.cover_alt || null;
  if (input.canonical_url !== undefined) fields.canonical_url = input.canonical_url || null;

  let contentChanged = false;
  if (input.body_md !== undefined) {
    const bodyMd = validateBodyMd(input.body_md);
    Object.assign(fields, computeContent(bodyMd, input.excerpt?.trim()), { body_md: bodyMd });
    contentChanged = true;
  } else if (input.excerpt !== undefined) {
    fields.excerpt = input.excerpt.trim() || excerptFrom(post.body_md, 190);
  }

  if (!Object.keys(fields).length && input.tags === undefined) {
    return apiError(400, 'bad_request', 'No recognised fields in the request body.');
  }

  fields.updated_at = nowIso();
  await updatePostRow(env.DB, id, fields);
  if (input.tags !== undefined) await setPostTags(env.DB, id, validateTags(input.tags));

  if (contentChanged || fields.title !== undefined) {
    await insertRevision(env.DB, {
      postId: id,
      title: fields.title ?? post.title,
      bodyMd: fields.body_md ?? post.body_md,
      authorId: identity.author.id,
      note: 'save',
    });
  }

  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'post.update', entity: 'post', entityId: id, detail: { fields: Object.keys(fields) },
  });

  const updated = await getAdminPostById(env.DB, id);
  return { updated, previousSlug, wasPublished: post.status === 'published' };
}

async function deleteHandler(url, env, identity, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePermission(identity, 'post.delete');

  const hard = url.searchParams.get('hard') === 'true';
  if (hard && identity.author.role !== 'owner') {
    return apiError(403, 'forbidden', 'Hard delete is owner-only.');
  }

  if (hard) {
    await deletePostRow(env.DB, id);
  } else {
    await updatePostRow(env.DB, id, { status: 'archived', updated_at: nowIso() });
  }
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: hard ? 'post.delete_hard' : 'post.delete',
    entity: 'post', entityId: id, detail: { slug: post.slug },
  });

  return { post, hard };
}

async function publishHandler(env, identity, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePermission(identity, 'post.publish');

  await updatePostRow(env.DB, id, {
    status: 'published',
    published_at: post.published_at || nowIso(),
    scheduled_for: null,
    updated_at: nowIso(),
  });
  await writeAuditLog(env.DB, { actor: identity.email, via: 'ui', action: 'post.publish', entity: 'post', entityId: id });

  const updated = await getAdminPostById(env.DB, id);
  return { updated, wasPublished: post.status === 'published' };
}

async function unpublishHandler(env, identity, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePermission(identity, 'post.publish');

  // published_at is left intact — set once, on first publish, per docs/architecture.md §3.
  await updatePostRow(env.DB, id, { status: 'draft', scheduled_for: null, updated_at: nowIso() });
  await writeAuditLog(env.DB, { actor: identity.email, via: 'ui', action: 'post.unpublish', entity: 'post', entityId: id });

  const updated = await getAdminPostById(env.DB, id);
  return { updated, wasPublished: post.status === 'published' };
}

async function scheduleHandler(request, env, identity, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePermission(identity, 'post.publish');

  const input = await readJsonBody(request);
  const scheduledFor = validateScheduledFor(input.scheduled_for);

  await updatePostRow(env.DB, id, { status: 'scheduled', scheduled_for: scheduledFor, updated_at: nowIso() });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'post.schedule', entity: 'post', entityId: id, detail: { scheduled_for: scheduledFor },
  });

  const updated = await getAdminPostById(env.DB, id);
  return { updated, wasPublished: post.status === 'published' };
}

async function duplicateHandler(env, identity, id) {
  const source = await getAdminPostById(env.DB, id);
  if (!source) return apiError(404, 'not_found', 'Post not found.');
  requirePostWriteAccess(identity, source);

  const slug = await uniqueSlug(env.DB, `${source.slug}-copy`);
  const post = {
    id: crypto.randomUUID(),
    slug,
    title: source.title,
    subtitle: source.subtitle,
    excerpt: source.excerpt,
    body_md: source.body_md,
    body_html: source.body_html,
    status: 'draft',
    visibility: source.visibility,
    author_id: identity.author.id,
    cover_key: source.cover_key,
    cover_alt: source.cover_alt,
    canonical_url: null,
    word_count: source.word_count,
    reading_minutes: source.reading_minutes,
    created_at: nowIso(),
    updated_at: nowIso(),
    published_at: null,
    scheduled_for: null,
  };

  await insertPost(env.DB, post);
  const tagNames = source.tags.map((t) => t.name);
  if (tagNames.length) await setPostTags(env.DB, post.id, tagNames);
  await insertRevision(env.DB, { postId: post.id, title: post.title, bodyMd: post.body_md, authorId: identity.author.id, note: 'create' });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'post.duplicate', entity: 'post', entityId: post.id, detail: { source_id: id },
  });

  const created = await getAdminPostById(env.DB, post.id);
  return Response.json({ data: created }, { status: 201, headers: { ETag: etagFor(created) } });
}

async function revisionsListHandler(env, id) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  return Response.json({ data: await listRevisions(env.DB, id) });
}

async function revisionGetHandler(env, id, revisionId) {
  const revision = await getRevision(env.DB, id, revisionId);
  if (!revision) return apiError(404, 'not_found', 'Revision not found.');
  return Response.json({ data: revision });
}

async function restoreHandler(env, identity, id, revisionId) {
  const post = await getAdminPostById(env.DB, id);
  if (!post) return apiError(404, 'not_found', 'Post not found.');
  requirePostWriteAccess(identity, post);

  const revision = await getRevision(env.DB, id, revisionId);
  if (!revision) return apiError(404, 'not_found', 'Revision not found.');

  // Snapshot current state before overwriting it, per docs/api.md.
  await insertRevision(env.DB, { postId: id, title: post.title, bodyMd: post.body_md, authorId: identity.author.id, note: 'pre-restore' });

  const { body_html, word_count, reading_minutes, excerpt } = computeContent(revision.body_md);
  await updatePostRow(env.DB, id, {
    title: revision.title, body_md: revision.body_md, body_html, word_count, reading_minutes, excerpt, updated_at: nowIso(),
  });
  await insertRevision(env.DB, { postId: id, title: revision.title, bodyMd: revision.body_md, authorId: identity.author.id, note: 'restore' });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'post.restore', entity: 'post', entityId: id, detail: { revision_id: revisionId },
  });

  const updated = await getAdminPostById(env.DB, id);
  return { updated, wasPublished: post.status === 'published' };
}

async function previewHandler(request) {
  const input = await readJsonBody(request);
  const bodyMd = validateBodyMd(input.body_md || '');
  return Response.json({ data: { body_html: renderMarkdown(bodyMd) } });
}

/* --- Dispatch ---------------------------------------------------------------
 * `ctxBundle` is `{ env, ctx, identity }` from src/admin-api.js. `identity`
 * is guaranteed non-null by the time any handler above runs — routes return
 * `null` up front otherwise, same "not live yet" fallthrough every handler
 * in this Worker uses when its precondition isn't met.
 */
export async function handlePostsApi(request, url, ctxBundle) {
  const { env, ctx, identity } = ctxBundle;
  if (!identity) return null;

  const isPreview = url.pathname === '/api/admin/preview';
  if (!isPreview && !url.pathname.startsWith('/api/admin/posts')) return null;

  return withErrors(async () => {
    if (request.method !== 'GET') requireSameOrigin(request, url);

    if (isPreview) {
      if (request.method !== 'POST') return null;
      return previewHandler(request);
    }

    const rest = url.pathname.slice('/api/admin/posts'.length);

    if (rest === '' || rest === '/') {
      if (request.method === 'GET') return listHandler(url, env);
      if (request.method === 'POST') return createHandler(request, env, identity);
      return null;
    }

    const restoreMatch = rest.match(/^\/([^/]+)\/revisions\/([^/]+)\/restore$/);
    if (restoreMatch && request.method === 'POST') {
      const result = await restoreHandler(env, identity, restoreMatch[1], restoreMatch[2]);
      if (result instanceof Response) return result;
      purgeIfPublic(ctx, env, { ...result, wasPublished: result.wasPublished, isPublished: result.updated.status === 'published', slug: result.updated.slug, tags: result.updated.tags.map((t) => t.slug) });
      return Response.json({ data: result.updated }, { headers: { ETag: etagFor(result.updated) } });
    }

    const revisionMatch = rest.match(/^\/([^/]+)\/revisions\/([^/]+)$/);
    if (revisionMatch && request.method === 'GET') return revisionGetHandler(env, revisionMatch[1], revisionMatch[2]);

    const revisionsListMatch = rest.match(/^\/([^/]+)\/revisions$/);
    if (revisionsListMatch && request.method === 'GET') return revisionsListHandler(env, revisionsListMatch[1]);

    const actionMatch = rest.match(/^\/([^/]+)\/(publish|unpublish|schedule|duplicate)$/);
    if (actionMatch && request.method === 'POST') {
      const [, id, action] = actionMatch;
      if (action === 'duplicate') return duplicateHandler(env, identity, id);

      const result =
        action === 'publish' ? await publishHandler(env, identity, id) :
        action === 'unpublish' ? await unpublishHandler(env, identity, id) :
        await scheduleHandler(request, env, identity, id);
      if (result instanceof Response) return result;
      purgeIfPublic(ctx, env, { wasPublished: result.wasPublished, isPublished: result.updated.status === 'published', slug: result.updated.slug, tags: result.updated.tags.map((t) => t.slug) });
      return Response.json({ data: result.updated }, { headers: { ETag: etagFor(result.updated) } });
    }

    const idMatch = rest.match(/^\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (request.method === 'GET') return getHandler(env, id);
      if (request.method === 'PATCH') {
        const result = await patchHandler(request, env, identity, id);
        if (result instanceof Response) return result;
        purgeIfPublic(ctx, env, { wasPublished: result.wasPublished, isPublished: result.updated.status === 'published', slug: result.updated.slug, previousSlug: result.previousSlug, tags: result.updated.tags.map((t) => t.slug) });
        return Response.json({ data: result.updated }, { headers: { ETag: etagFor(result.updated) } });
      }
      if (request.method === 'DELETE') {
        const result = await deleteHandler(url, env, identity, id);
        if (result instanceof Response) return result;
        purgeIfPublic(ctx, env, { wasPublished: result.post.status === 'published', isPublished: false, slug: result.post.slug, tags: result.post.tags.map((t) => t.slug) });
        return Response.json({ data: { id, status: result.hard ? 'deleted' : 'archived' } });
      }
    }

    return null;
  });
}
