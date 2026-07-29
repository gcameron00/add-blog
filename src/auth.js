/**
 * Role resolution and the permission table from docs/architecture.md §6.
 * Phase 4 only consumes `resolveAuthor` (for `GET /api/admin/me`); `can` is
 * built now, as reusable middleware, for Phase 5's write routes to call
 * per-action rather than re-deriving the table per route.
 */

const PERMISSIONS = {
  'post.editOwn': ['owner', 'editor', 'author'],
  'post.editOthers': ['owner', 'editor'],
  'post.publish': ['owner', 'editor'],
  'post.delete': ['owner', 'editor'],
  'media.upload': ['owner', 'editor', 'author'],
  'media.delete': ['owner', 'editor'],
  'settings.manage': ['owner'],
  'authors.manage': ['owner'],
  'tags.manage': ['owner', 'editor'],
};

/** Does this role hold this permission? Unknown permissions deny by default. */
export function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

/** Every permission a role holds — what `GET /api/admin/me` reports so the UI can render controls without a table of its own. */
export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((permission) => can(role, permission));
}

/**
 * The `authors` row for a verified Access email, or null if none exists
 * (Phase 4/5: no row means `403`, never an implicit account) or the row is
 * `disabled` (Phase 5e) — a disabled author 403s exactly like a missing one,
 * even though Access itself still lets the identity through.
 */
export async function resolveAuthor(db, email) {
  return db
    .prepare(`SELECT id, email, name, role, avatar_key FROM authors WHERE email = ? AND disabled = 0`)
    .bind(email)
    .first();
}
