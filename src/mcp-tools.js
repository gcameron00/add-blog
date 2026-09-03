/**
 * MCP tool catalog (Phase 6) — docs/mcp.md's "Tools" section made real.
 *
 * Every handler here is a small adapter over the same D1 queries and
 * validators the REST admin API (src/admin-posts.js, src/admin-media.js,
 * src/admin-settings.js) already uses — the rules an agent operates under
 * are the same rules a human editor is bound by because it is, literally,
 * the same code underneath, not a parallel implementation that could drift.
 *
 * A handler either returns `{ data, audit }` — `audit` is what
 * src/mcp.js writes to `audit_log` with `via = 'mcp'` after the call
 * succeeds, per docs/mcp.md ("every tool call writes an audit_log entry")
 * — or throws `McpToolError`, which src/mcp.js turns into a tool-level
 * error result (`isError: true`) carrying the same `code`/`field` shape
 * docs/api.md's REST errors use, so a model gets an equally actionable
 * failure either way.
 */

import { excerptFrom, readingMinutes, renderMarkdown, slugify, wordCount } from '../assets/js/markdown.js';
import {
  getAdminPostById,
  getAdminPostBySlug,
  getMediaByChecksum,
  getMediaByKey,
  insertMedia,
  insertPost,
  insertRevision,
  listAdminMedia,
  listAdminPosts,
  listAdminTags,
  listRevisions,
  searchAdminPosts,
  setPostTags,
  slugExists,
  uniqueSlug,
  updatePostRow,
} from './admin-db.js';
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, mapMedia } from './admin-media.js';
import { KNOWN_KEYS, writeSettings } from './admin-settings.js';
import { can } from './auth.js';
import { purgePostUrls } from './cache-purge.js';
import { findCollectionByType, resolveCollections } from './collections.js';
import { getSettings } from './db.js';
import { buildMediaKey, detectDimensions, sanitizeFilename, sha256Hex } from './media-parse.js';
import { fetchMediaFromUrl } from './mcp-media-fetch.js';
import {
  ValidationError,
  validateBodyMd,
  validatePostType,
  validateScheduledFor,
  validateSlug,
  validateTags,
  validateTitle,
  validateTypeFields,
  validateVisibility,
} from './validate.js';

export class McpToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.field = extra.field;
    this.detail = extra.detail;
  }
}

function fail(code, message, extra) {
  throw new McpToolError(code, message, extra);
}

// read < author < editor < owner — matches assets/js/admin.js's MCP page,
// which renders this same ranking client-side so the "visible to you"
// column agrees with what tools/list actually returns.
const ROLE_RANK = { read: 0, author: 1, editor: 2, owner: 3 };

function requirePerm(identity, permission) {
  if (!can(identity.author.role, permission)) fail('forbidden', 'Your role cannot do this.');
}

function nowIso() {
  return new Date().toISOString();
}

function computeContent(bodyMd, explicitExcerpt) {
  return {
    body_html: renderMarkdown(bodyMd),
    word_count: wordCount(bodyMd),
    reading_minutes: readingMinutes(bodyMd),
    excerpt: explicitExcerpt || excerptFrom(bodyMd, 190),
  };
}

async function resolvePost(db, { id, slug }) {
  if (!id && !slug) fail('bad_request', 'Provide either "id" or "slug".', { field: 'id' });
  const post = id ? await getAdminPostById(db, id) : await getAdminPostBySlug(db, slug);
  if (!post) fail('not_found', 'Post not found.', { field: id ? 'id' : 'slug' });
  return post;
}

function requirePostWriteAccess(identity, post) {
  requirePerm(identity, post.author.id === identity.author.id ? 'post.editOwn' : 'post.editOthers');
}

// Same reasoning as src/admin-posts.js's purgeIfPublic: postType defaults to
// 'post', which makes purgePostUrls's own default basePath exactly right;
// a collection item needs its own collection's base_path instead, resolved
// inside the waitUntil'd promise so this stays fire-and-forget.
function purgeIfNeeded(execCtx, env, { wasPublished, isPublished, slug, previousSlug, tags = [], postType = 'post' }) {
  if (!wasPublished && !isPublished) return;
  if (!env.PUBLIC_HOST) return;
  execCtx.waitUntil(
    (async () => {
      let basePath;
      if (postType !== 'post') {
        const settings = await getSettings(env.DB);
        const collection = findCollectionByType(resolveCollections(settings), postType);
        if (collection) basePath = collection.base_path;
      }
      await purgePostUrls(`https://${env.PUBLIC_HOST}`, { slug, previousSlug, tags, ...(basePath ? { basePath } : {}) });
    })()
  );
}

function postSummary(post) {
  const { body_md, body_html, ...summary } = post;
  return summary;
}

/* --- Reading ----------------------------------------------------------- */

async function listPosts(args, { env }) {
  const data = await listAdminPosts(env.DB, {
    status: args.status || 'all',
    tag: args.tag || undefined,
    author: args.author || undefined,
    type: args.type || undefined,
    sort: args.sort || 'updated',
    limit: args.limit,
    offset: args.offset,
  });
  return { data, audit: { action: 'mcp.list_posts' } };
}

async function getPost(args, { env }) {
  const post = await resolvePost(env.DB, args);
  const { revision_count, body_html, ...rest } = post;
  const result = args.include_html ? { ...rest, body_html } : rest;
  if (args.include_revisions) result.revisions = await listRevisions(env.DB, post.id);
  return { data: result, audit: { action: 'mcp.get_post', entity: 'post', entityId: post.id } };
}

async function searchPosts(args, { env }) {
  if (typeof args.query !== 'string' || !args.query.trim()) {
    fail('bad_request', 'query is required.', { field: 'query' });
  }
  const data = await searchAdminPosts(env.DB, { query: args.query.trim(), status: args.status, type: args.type || undefined, limit: args.limit });
  return { data, audit: { action: 'mcp.search_posts', detail: { query: args.query } } };
}

async function listTags(_args, { env }) {
  const rows = await listAdminTags(env.DB);
  // structuredContent (src/mcp.js's methodToolsCall) has to be a JSON object
  // per the MCP spec — a bare array fails client-side schema validation, so
  // this can't just be the array the way `data` reads elsewhere in this file.
  const data = { data: rows.map((row) => ({ slug: row.slug, name: row.name, post_count: row.post_count })) };
  return { data, audit: { action: 'mcp.list_tags' } };
}

async function listMedia(args, { env }) {
  const { data, page } = await listAdminMedia(env.DB, {
    q: args.query || undefined,
    type: args.type || undefined,
    limit: args.limit,
  });
  const mapped = data.map((row) => ({
    key: row.key,
    url: `/media/${row.key}`,
    filename: row.filename,
    content_type: row.content_type,
    width: row.width,
    height: row.height,
    alt: row.alt,
  }));
  return { data: { data: mapped, page }, audit: { action: 'mcp.list_media' } };
}

const SITE_SETTINGS_KEYS = ['site_title', 'site_description', 'site_url', 'timezone', 'posts_per_page'];

async function getSiteSettings(_args, { env }) {
  const settings = await getSettings(env.DB);
  const data = Object.fromEntries(SITE_SETTINGS_KEYS.map((key) => [key, settings[key]]));
  return { data, audit: { action: 'mcp.get_site_settings' } };
}

/* --- Writing ------------------------------------------------------------ */

/**
 * Same validation as src/admin-posts.js's own resolver — post_type checked
 * against the site's collections registry, then type_fields against that
 * specific collection's declared fields. Kept here rather than imported from
 * admin-posts.js (which has no exports meant for reuse outside its own route
 * dispatch) — same "thin adapter calling the same validators" shape as
 * every other tool in this file already uses.
 */
async function resolvePostTypeAndFields(env, postType, typeFields) {
  const settings = await getSettings(env.DB);
  const type = validatePostType(postType ?? 'post', settings);
  const collection = type === 'post' ? null : findCollectionByType(resolveCollections(settings), type);
  const fields = validateTypeFields(typeFields, collection?.fields);
  return { type, fields };
}

async function createPost(args, { env, identity }) {
  requirePerm(identity, 'post.editOwn');

  const title = validateTitle(args.title);
  const baseSlug = args.slug ? validateSlug(args.slug) : slugify(title);
  if (!baseSlug) fail('bad_request', 'Unable to derive a slug from the title.', { field: 'slug' });
  const slug = await uniqueSlug(env.DB, baseSlug);
  const bodyMd = validateBodyMd(args.body_md || '');
  const tags = validateTags(args.tags);
  const visibility = validateVisibility(args.visibility);
  const { type: postType, fields: typeFields } = await resolvePostTypeAndFields(env, args.post_type, args.type_fields);
  const { body_html, word_count, reading_minutes, excerpt } = computeContent(bodyMd, args.excerpt?.trim());

  const post = {
    id: crypto.randomUUID(),
    slug,
    title,
    subtitle: args.subtitle || null,
    excerpt,
    body_md: bodyMd,
    body_html,
    // Forced regardless of what's passed — publishing is always its own
    // explicit call (publish_post), never a side effect of drafting. See
    // docs/mcp.md's "No tool both writes and publishes" design note.
    status: 'draft',
    visibility,
    author_id: identity.author.id,
    cover_key: args.cover_key || null,
    cover_alt: args.cover_alt || null,
    canonical_url: null,
    word_count,
    reading_minutes,
    post_type: postType,
    type_fields: postType === 'post' ? null : typeFields,
    created_at: nowIso(),
    updated_at: nowIso(),
    published_at: null,
    scheduled_for: null,
  };

  await insertPost(env.DB, post);
  if (tags.length) await setPostTags(env.DB, post.id, tags);
  await insertRevision(env.DB, { postId: post.id, title, bodyMd, authorId: identity.author.id, note: 'create' });

  const created = await getAdminPostById(env.DB, post.id);
  return { data: created, audit: { action: 'mcp.create_post', entity: 'post', entityId: post.id, detail: { title, slug } } };
}

async function updatePost(args, { env, ctx, identity }) {
  const post = await resolvePost(env.DB, args);
  requirePostWriteAccess(identity, post);

  if (args.expected_updated_at && args.expected_updated_at !== post.updated_at) {
    fail('conflict', 'This post changed since you last read it.', { detail: { current_updated_at: post.updated_at } });
  }

  const fields = {};
  const previousSlug = post.slug;

  // Same restriction as the REST API's PATCH (src/admin-posts.js): post_type
  // is fixed at create time, since changing it would change the post's URL
  // and its field contract out from under whatever's already stored.
  if (args.post_type !== undefined && args.post_type !== post.post_type) {
    fail('bad_request', 'post_type cannot be changed after creation — delete and recreate instead.', { field: 'post_type' });
  }
  if (args.type_fields !== undefined) {
    if (post.post_type === 'post') {
      fields.type_fields = null;
    } else {
      const settings = await getSettings(env.DB);
      const collection = findCollectionByType(resolveCollections(settings), post.post_type);
      fields.type_fields = JSON.stringify(validateTypeFields(args.type_fields, collection?.fields));
    }
  }

  if (args.title !== undefined) fields.title = validateTitle(args.title);
  if (args.slug !== undefined && args.slug !== post.slug) {
    const slug = validateSlug(args.slug);
    if (await slugExists(env.DB, slug, post.id)) {
      fail('slug_taken', `A post with the slug "${slug}" already exists.`, { field: 'slug' });
    }
    fields.slug = slug;
  }
  if (args.subtitle !== undefined) fields.subtitle = args.subtitle || null;
  if (args.visibility !== undefined) fields.visibility = validateVisibility(args.visibility);
  if (args.cover_key !== undefined) fields.cover_key = args.cover_key || null;
  if (args.cover_alt !== undefined) fields.cover_alt = args.cover_alt || null;
  if (args.canonical_url !== undefined) fields.canonical_url = args.canonical_url || null;

  let contentChanged = false;
  if (args.body_md !== undefined) {
    const bodyMd = validateBodyMd(args.body_md);
    Object.assign(fields, computeContent(bodyMd, args.excerpt?.trim()), { body_md: bodyMd });
    contentChanged = true;
  } else if (args.excerpt !== undefined) {
    fields.excerpt = args.excerpt.trim() || excerptFrom(post.body_md, 190);
  }

  if (!Object.keys(fields).length && args.tags === undefined) {
    fail('bad_request', 'No recognised fields in the request.');
  }

  fields.updated_at = nowIso();
  await updatePostRow(env.DB, post.id, fields);
  if (args.tags !== undefined) await setPostTags(env.DB, post.id, validateTags(args.tags));

  if (contentChanged || fields.title !== undefined) {
    await insertRevision(env.DB, {
      postId: post.id, title: fields.title ?? post.title, bodyMd: fields.body_md ?? post.body_md,
      authorId: identity.author.id, note: 'save',
    });
  }

  const updated = await getAdminPostById(env.DB, post.id);
  purgeIfNeeded(ctx, env, {
    wasPublished: post.status === 'published', isPublished: updated.status === 'published',
    slug: updated.slug, previousSlug, tags: updated.tags.map((t) => t.slug), postType: updated.post_type,
  });

  return { data: updated, audit: { action: 'mcp.update_post', entity: 'post', entityId: post.id, detail: { fields: Object.keys(fields) } } };
}

/** A post_type's own public URL — `/posts/<slug>` for a real post, `<collection.base_path>/<slug>` for a collection item. */
async function publicUrlFor(env, postType, slug) {
  if (!env.PUBLIC_HOST) return null;
  let basePath = '/posts';
  if (postType !== 'post') {
    const settings = await getSettings(env.DB);
    const collection = findCollectionByType(resolveCollections(settings), postType);
    if (!collection) return null;
    basePath = collection.base_path;
  }
  return `https://${env.PUBLIC_HOST}${basePath}/${slug}`;
}

async function publishPost(args, { env, ctx, identity }) {
  const post = await resolvePost(env.DB, args);
  requirePerm(identity, 'post.publish');

  if (args.scheduled_for) {
    const scheduledFor = validateScheduledFor(args.scheduled_for);
    await updatePostRow(env.DB, post.id, { status: 'scheduled', scheduled_for: scheduledFor, updated_at: nowIso() });
  } else {
    await updatePostRow(env.DB, post.id, {
      status: 'published', published_at: post.published_at || nowIso(), scheduled_for: null, updated_at: nowIso(),
    });
  }

  const updated = await getAdminPostById(env.DB, post.id);
  purgeIfNeeded(ctx, env, {
    wasPublished: post.status === 'published', isPublished: updated.status === 'published',
    slug: updated.slug, tags: updated.tags.map((t) => t.slug), postType: updated.post_type,
  });

  const url = updated.status === 'published' ? await publicUrlFor(env, updated.post_type, updated.slug) : null;
  const data = { ...updated, url };
  return { data, audit: { action: 'mcp.publish_post', entity: 'post', entityId: post.id, detail: { scheduled_for: args.scheduled_for || null } } };
}

async function unpublishPost(args, { env, ctx, identity }) {
  const post = await resolvePost(env.DB, args);
  requirePerm(identity, 'post.publish');

  await updatePostRow(env.DB, post.id, { status: 'draft', scheduled_for: null, updated_at: nowIso() });
  const updated = await getAdminPostById(env.DB, post.id);
  purgeIfNeeded(ctx, env, {
    wasPublished: post.status === 'published', isPublished: false, slug: updated.slug, tags: updated.tags.map((t) => t.slug), postType: updated.post_type,
  });

  return { data: updated, audit: { action: 'mcp.unpublish_post', entity: 'post', entityId: post.id } };
}

async function deletePost(args, { env, ctx, identity }) {
  const post = await resolvePost(env.DB, args);
  requirePerm(identity, 'post.delete');

  // Soft delete only — hard deletion is not exposed over MCP at all (docs/mcp.md).
  await updatePostRow(env.DB, post.id, { status: 'archived', updated_at: nowIso() });
  purgeIfNeeded(ctx, env, {
    wasPublished: post.status === 'published', isPublished: false, slug: post.slug, tags: post.tags.map((t) => t.slug), postType: post.post_type,
  });

  return { data: { id: post.id, status: 'archived' }, audit: { action: 'mcp.delete_post', entity: 'post', entityId: post.id, detail: { title: post.title, slug: post.slug } } };
}

async function uploadMediaFromUrl(args, { env, identity }) {
  requirePerm(identity, 'media.upload');

  if (typeof args.url !== 'string' || !args.url) fail('bad_request', 'url is required.', { field: 'url' });
  if (typeof args.alt !== 'string' || !args.alt.trim()) {
    fail('bad_request', 'alt is required — an upload with no alt text is rejected.', { field: 'alt' });
  }

  let bytes;
  let contentType;
  try {
    ({ bytes, contentType } = await fetchMediaFromUrl(args.url, { allowedTypes: ALLOWED_TYPES, maxBytes: MAX_UPLOAD_BYTES }));
  } catch (err) {
    fail(err.code || 'fetch_failed', err.message, { field: 'url' });
  }

  const checksum = await sha256Hex(bytes);
  const existing = await getMediaByChecksum(env.DB, checksum);
  if (existing) {
    return { data: await mapMedia(env.DB, existing), audit: { action: 'mcp.upload_media_from_url', entity: 'media', entityId: existing.key, detail: { deduped: true } } };
  }

  const filename = sanitizeFilename(args.filename || new URL(args.url).pathname.split('/').pop() || 'upload');
  const key = buildMediaKey(new Date(), checksum, filename);
  const dimensions = detectDimensions(bytes, contentType) || {};

  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
  await insertMedia(env.DB, {
    key, filename, content_type: contentType, size_bytes: bytes.byteLength,
    width: dimensions.width ?? null, height: dimensions.height ?? null,
    alt: args.alt.trim(), checksum, uploaded_by: identity.author.id, created_at: nowIso(),
  });

  const created = await getMediaByKey(env.DB, key);
  return { data: await mapMedia(env.DB, created), audit: { action: 'mcp.upload_media_from_url', entity: 'media', entityId: key, detail: { filename } } };
}

async function updateSiteSettings(args, { env, identity }) {
  requirePerm(identity, 'settings.manage');
  const data = await writeSettings(env.DB, args || {});
  return { data, audit: { action: 'mcp.update_site_settings', entity: 'settings', detail: { keys: Object.keys(args || {}) } } };
}

/**
 * Read-only — the site's collection registry, field specs included. Exists
 * so a client can discover valid post_type values and each one's
 * type_fields keys before calling create_post, rather than guessing or
 * failing a call first to find out.
 */
async function listCollections(_args, { env }) {
  const settings = await getSettings(env.DB);
  // Same reason as listTags above — resolveCollections returns a bare array,
  // which structuredContent can't be directly.
  return { data: { data: resolveCollections(settings) }, audit: { action: 'mcp.list_collections' } };
}

/* --- Catalog ------------------------------------------------------------- */

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });

export const TOOLS = [
  {
    name: 'list_posts',
    minRole: 'read',
    description: (site) => `Browse posts on ${site} with filters. Returns metadata only — no bodies.`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { ...str('Filter by status.'), enum: ['draft', 'scheduled', 'published', 'archived', 'all'] },
        tag: str('Filter by tag slug.'),
        author: str('Filter by author id.'),
        type: str('Filter by post_type (default "post"; "all" for every type, including collection items). See list_collections for the site\'s configured types.'),
        limit: int('Max results (default 20, max 100).'),
        offset: int('Pagination offset.'),
        sort: { ...str('Sort order.'), enum: ['newest', 'oldest', 'updated'] },
      },
    },
    annotations: { readOnlyHint: true },
    handler: listPosts,
  },
  {
    name: 'get_post',
    minRole: 'read',
    description: (site) => `Fetch one full post from ${site} by slug or id. Returns Markdown by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('Post slug.'),
        id: str('Post id.'),
        include_html: bool('Also include rendered body_html (default false).'),
        include_revisions: bool('Also include the revision list (default false).'),
      },
    },
    annotations: { readOnlyHint: true },
    handler: getPost,
  },
  {
    name: 'search_posts',
    minRole: 'read',
    description: (site) => `Full-text search over ${site}'s posts. Returns matches with a highlighted snippet.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Search text (required).'),
        status: { ...str('Filter by status.'), enum: ['draft', 'scheduled', 'published', 'archived', 'all'] },
        type: str('Filter by post_type (default "post"; "all" for every type).'),
        limit: int('Max results (default 20, max 50).'),
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    handler: searchPosts,
  },
  {
    name: 'list_tags',
    minRole: 'read',
    description: (site) => `All tags on ${site} with post counts.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: listTags,
  },
  {
    name: 'list_media',
    minRole: 'read',
    description: (site) => `${site}'s media library — keys, public URLs, dimensions and alt text, so a post can reference an existing image instead of a new upload.`,
    inputSchema: {
      type: 'object',
      properties: { query: str('Filter by filename/alt text.'), type: str('Filter by content type prefix, e.g. "image".'), limit: int('Max results (default 50, max 200).') },
    },
    annotations: { readOnlyHint: true },
    handler: listMedia,
  },
  {
    name: 'get_site_settings',
    minRole: 'read',
    description: (site) => `${site}'s title, description, URL, timezone and posts-per-page — context before drafting.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: getSiteSettings,
  },
  {
    name: 'list_collections',
    minRole: 'read',
    description: (site) => `${site}'s configured collections (custom content types, e.g. "project") — each one's type and field specs, so a valid post_type/type_fields can be built before calling create_post.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: listCollections,
  },
  {
    name: 'create_post',
    minRole: 'author',
    description: (site) => `Create a new post (or collection item) on ${site}. Always created as a draft, regardless of any status passed — publishing is always a separate call.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Post title (required).'),
        body_md: str('Body in Markdown.'),
        subtitle: str('Subtitle.'),
        excerpt: str('Excerpt — generated from the body if omitted.'),
        slug: str('Slug — derived from the title if omitted.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names (created if new).' },
        cover_key: str('R2 key of an existing media item to use as the cover.'),
        cover_alt: str('Alt text for the cover.'),
        visibility: { ...str('public (default) or unlisted.'), enum: ['public', 'unlisted'] },
        post_type: str('"post" (default) or one of the site\'s configured collection types — see list_collections.'),
        type_fields: { type: 'object', description: 'Field values for a collection item, keyed by that collection\'s field keys (see list_collections). Ignored for post_type "post".' },
      },
      required: ['title'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: createPost,
  },
  {
    name: 'update_post',
    minRole: 'author',
    description: (site) => `Edit a post on ${site} by slug or id. Cannot change status (use publish_post/unpublish_post/delete_post) or post_type (delete and recreate instead). Pass expected_updated_at to fail with a conflict instead of overwriting a change made since you last read the post.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('Post slug.'),
        id: str('Post id.'),
        title: str('New title.'),
        body_md: str('New body in Markdown.'),
        subtitle: str('New subtitle.'),
        excerpt: str('New excerpt.'),
        cover_key: str('New cover R2 key.'),
        cover_alt: str('New cover alt text.'),
        canonical_url: str('Canonical URL, when cross-posted from elsewhere.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the full tag set.' },
        visibility: { ...str('public or unlisted.'), enum: ['public', 'unlisted'] },
        type_fields: { type: 'object', description: 'Replaces the collection item\'s field values (see list_collections). Ignored for post_type "post".' },
        expected_updated_at: str('The updated_at you last read — enables the conflict check.'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: updatePost,
  },
  {
    name: 'publish_post',
    minRole: 'editor',
    description: (site) => `Publish a post on ${site} now, or pass scheduled_for to schedule it instead. Returns the live URL.`,
    inputSchema: {
      type: 'object',
      properties: { slug: str('Post slug.'), id: str('Post id.'), scheduled_for: str('ISO 8601 timestamp in the future — schedules instead of publishing immediately.') },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: publishPost,
  },
  {
    name: 'unpublish_post',
    minRole: 'editor',
    description: (site) => `Return a published or scheduled post on ${site} to draft.`,
    inputSchema: { type: 'object', properties: { slug: str('Post slug.'), id: str('Post id.') } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: unpublishPost,
  },
  {
    name: 'delete_post',
    minRole: 'editor',
    description: (site) => `Soft-delete a post on ${site} to archived. Hard deletion is not exposed over MCP — that stays a deliberate human action in the admin UI.`,
    inputSchema: { type: 'object', properties: { slug: str('Post slug.'), id: str('Post id.') } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: deletePost,
  },
  {
    name: 'upload_media_from_url',
    minRole: 'author',
    description: (site) => `Fetch an image from a URL and store it in ${site}'s media library. alt text is required. Only https URLs are fetched.`,
    inputSchema: {
      type: 'object',
      properties: { url: str('https:// URL to fetch (required).'), alt: str('Alt text (required).'), filename: str('Filename — derived from the URL if omitted.') },
      required: ['url', 'alt'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: uploadMediaFromUrl,
  },
  {
    name: 'update_site_settings',
    minRole: 'owner',
    description: (site) => `Partially update ${site}'s settings object (${[...KNOWN_KEYS].join(', ')}).`,
    inputSchema: { type: 'object', properties: Object.fromEntries([...KNOWN_KEYS].map((key) => [key, {}])) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: updateSiteSettings,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function toolsForRole(role) {
  const rank = ROLE_RANK[role] ?? 0;
  return TOOLS.filter((tool) => ROLE_RANK[tool.minRole] <= rank);
}

export function isWriteTool(name) {
  const tool = TOOLS_BY_NAME.get(name);
  return Boolean(tool) && tool.minRole !== 'read';
}

/**
 * Runs `name` with `args` if the caller's role can see it — re-checked here,
 * not just trusted from whatever `tools/list` returned earlier, since a
 * client is free to call a tool it was never shown.
 */
export async function callTool(name, args, callCtx) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) fail('not_found', `Unknown tool: "${name}".`);
  if (ROLE_RANK[tool.minRole] > (ROLE_RANK[callCtx.identity.author.role] ?? 0)) {
    fail('forbidden', 'Your role cannot use this tool.');
  }

  try {
    return await tool.handler(args || {}, callCtx);
  } catch (err) {
    if (err instanceof McpToolError) throw err;
    if (err instanceof ValidationError) throw new McpToolError(err.code, err.message, { field: err.field });
    throw err;
  }
}
