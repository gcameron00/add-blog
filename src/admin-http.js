/**
 * Shared plumbing for admin write-API route handlers (Phase 5) — the JSON
 * error envelope from docs/api.md, the CSRF/content-type checks every write
 * route needs, and the permission-check helper. Split out of
 * src/admin-posts.js once src/admin-settings.js needed the exact same
 * pieces rather than a copy of them.
 */

import { can } from './auth.js';
import { ValidationError } from './validate.js';

export function apiError(status, code, message, extra = {}) {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

export function apiFail(status, code, message, extra = {}) {
  throw Object.assign(new Error(message), { status, code, ...extra });
}

/** Runs `fn`, converting a thrown `{status, code, message}` (or a ValidationError) into the JSON error envelope; anything else becomes a logged 500. */
export async function withErrors(fn) {
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

export function requireSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== url.origin) apiFail(403, 'forbidden', 'Cross-origin write rejected.');
}

export async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) throw new ValidationError('Content-Type must be application/json.');
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Malformed JSON body.');
  }
}

export function requirePermission(identity, permission) {
  if (!can(identity.author.role, permission)) apiFail(403, 'forbidden', 'Your role cannot do this.');
}
