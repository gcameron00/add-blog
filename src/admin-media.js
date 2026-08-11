/**
 * Admin Media API (Phase 5c) — docs/api.md's Media routes, upload through
 * the Worker per docs/architecture.md §4. `assets/js/admin.js`'s media page
 * has called `listMedia`/`deleteMedia` since Phase 1; this is what makes
 * them (and the previously-nonfunctional upload dropzone) real.
 *
 * Deliberately NOT in this pass:
 * - `image/svg+xml` uploads. SVG is an executable format — the allow-list
 *   below leaves it out rather than ship a regex-based "sanitiser" that
 *   would give false confidence against something this security-sensitive.
 *   Needs a real sanitiser (a parser, not string surgery) before it's safe.
 * - AVIF dimension detection (`src/media-parse.js` returns `null` for it)
 *   — its dimensions live in a nested ISOBMFF box structure that's real
 *   parsing work on its own; AVIF still uploads fine, just without
 *   recorded width/height. Every other allow-listed format is parsed
 *   against real encoder output — see src/media-parse.test.js.
 * - Lazy image variants (resizing) — needs a decision on the resizing
 *   mechanism (e.g. enabling Cloudflare Images) that isn't this module's
 *   to make alone.
 */

import {
  deleteMediaRow,
  getMediaByChecksum,
  getMediaByKey,
  insertMedia,
  listAdminMedia,
  listPostsReferencingMedia,
  listSettingsReferencingMedia,
  updateMediaRow,
} from './admin-db.js';
import { apiError, readJsonBody, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { writeAuditLog } from './audit.js';
import { buildMediaKey, detectDimensions, sanitizeFilename, sha256Hex } from './media-parse.js';

// Exported so src/mcp-tools.js's `upload_media_from_url` validates a fetched
// URL's response against the exact same allow-list and size cap a direct
// multipart upload gets here — one list, not two that can drift apart.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'application/pdf',
]);

// Exported for src/mcp-tools.js's `list_media` and `upload_media_from_url` —
// same shape a human sees in the admin media library, so an agent and an
// editor are never looking at two different ideas of what a media row is.
export async function mapMedia(db, row) {
  const [posts, settings] = await Promise.all([listPostsReferencingMedia(db, row.key), listSettingsReferencingMedia(db, row.key)]);
  const usedBy = posts.length + settings.length;
  return {
    key: row.key,
    url: `/media/${row.key}`,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    alt: row.alt,
    checksum: row.checksum,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    used_by: usedBy,
  };
}

async function uploadHandler(request, env, identity) {
  requirePermission(identity, 'media.upload');

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return apiError(400, 'bad_request', 'Expected multipart/form-data.');
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return apiError(400, 'bad_request', 'Malformed multipart body.');
  }

  const file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return apiError(400, 'bad_request', 'A "file" field is required.', { field: 'file' });
  }
  const alt = formData.get('alt');

  const fileType = file.type || '';
  if (!ALLOWED_TYPES.has(fileType)) {
    return apiError(415, 'unsupported_media_type', `"${fileType || 'unknown'}" is not an allowed upload type.`);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return apiError(413, 'payload_too_large', `Uploads are capped at ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const checksum = await sha256Hex(bytes);

  // Content-addressed uploads are idempotent — the same bytes uploaded
  // twice return the existing object rather than writing a duplicate.
  const existing = await getMediaByChecksum(env.DB, checksum);
  if (existing) {
    return Response.json({ data: await mapMedia(env.DB, existing) });
  }

  const now = new Date();
  const key = buildMediaKey(now, checksum, file.name);

  const dimensions = detectDimensions(bytes, fileType) || {};

  await env.MEDIA.put(key, buffer, { httpMetadata: { contentType: fileType } });
  await insertMedia(env.DB, {
    key,
    filename: sanitizeFilename(file.name),
    content_type: fileType,
    size_bytes: file.size,
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    alt: typeof alt === 'string' ? alt : null,
    checksum,
    uploaded_by: identity.author.id,
    created_at: now.toISOString(),
  });
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'media.upload', entity: 'media', entityId: key,
    detail: { filename: sanitizeFilename(file.name) },
  });

  const created = await getMediaByKey(env.DB, key);
  return Response.json({ data: await mapMedia(env.DB, created) }, { status: 201 });
}

async function listHandler(url, env) {
  const q = url.searchParams;
  const { data, page } = await listAdminMedia(env.DB, {
    q: q.get('q') || undefined,
    type: q.get('type') || undefined,
    unused: q.get('unused') === 'true',
    limit: q.get('limit'),
    offset: q.get('offset'),
  });
  return Response.json({ data: await Promise.all(data.map((row) => mapMedia(env.DB, row))), page });
}

async function usageHandler(env, key) {
  const media = await getMediaByKey(env.DB, key);
  if (!media) return apiError(404, 'not_found', 'Not found.');
  return Response.json({ data: await listPostsReferencingMedia(env.DB, key) });
}

async function patchHandler(request, env, identity, key) {
  requirePermission(identity, 'media.upload');
  const media = await getMediaByKey(env.DB, key);
  if (!media) return apiError(404, 'not_found', 'Not found.');

  const input = await readJsonBody(request);
  const fields = {};
  if (input.alt !== undefined) fields.alt = input.alt || null;
  if (input.filename !== undefined) fields.filename = sanitizeFilename(input.filename);
  if (!Object.keys(fields).length) return apiError(400, 'bad_request', 'Nothing to update.');

  await updateMediaRow(env.DB, key, fields);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'media.update', entity: 'media', entityId: key, detail: fields,
  });

  const updated = await getMediaByKey(env.DB, key);
  return Response.json({ data: await mapMedia(env.DB, updated) });
}

async function deleteHandler(url, env, identity, key) {
  requirePermission(identity, 'media.delete');
  const media = await getMediaByKey(env.DB, key);
  if (!media) return apiError(404, 'not_found', 'Not found.');

  const [referencing, referencingSettings] = await Promise.all([
    listPostsReferencingMedia(env.DB, key),
    listSettingsReferencingMedia(env.DB, key),
  ]);
  const force = url.searchParams.get('force') === 'true';
  if ((referencing.length || referencingSettings.length) && !force) {
    const parts = [];
    if (referencing.length) parts.push(`${referencing.length} post${referencing.length === 1 ? '' : 's'}`);
    if (referencingSettings.length) parts.push(`site settings (${referencingSettings.join(', ')})`);
    return apiError(409, 'conflict', `This file is used by ${parts.join(' and ')}. Remove it there first, or pass ?force=true.`, {
      detail: { referencing, referencing_settings: referencingSettings },
    });
  }

  await env.MEDIA.delete(key);
  await deleteMediaRow(env.DB, key);
  await writeAuditLog(env.DB, {
    actor: identity.email, via: 'ui', action: 'media.delete', entity: 'media', entityId: key,
    detail: { filename: media.filename, forced: referencing.length > 0 || referencingSettings.length > 0 },
  });

  return Response.json({ data: { key } });
}

export async function handleMediaApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity || !env.DB || !env.MEDIA) return null;
  if (!url.pathname.startsWith('/api/admin/media')) return null;

  return withErrors(async () => {
    if (request.method !== 'GET') requireSameOrigin(request, url);

    const rest = url.pathname.slice('/api/admin/media'.length);

    if (rest === '' || rest === '/') {
      if (request.method === 'GET') return listHandler(url, env);
      if (request.method === 'POST') return uploadHandler(request, env, identity);
      return null;
    }

    const usageMatch = rest.match(/^\/(.+)\/usage$/);
    if (usageMatch && request.method === 'GET') return usageHandler(env, decodeURIComponent(usageMatch[1]));

    const keyMatch = rest.match(/^\/(.+)$/);
    if (keyMatch) {
      const key = decodeURIComponent(keyMatch[1]);
      if (request.method === 'PATCH') return patchHandler(request, env, identity, key);
      if (request.method === 'DELETE') return deleteHandler(url, env, identity, key);
    }

    return null;
  });
}
