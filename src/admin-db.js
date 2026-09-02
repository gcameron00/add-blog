/**
 * D1 write queries for the admin Posts API (Phase 5). Pairs with src/db.js
 * (the Phase 3 read layer) rather than extending it — read and write have
 * different shapes and different callers (public, unauthenticated vs admin,
 * identity-gated), and keeping them in separate files makes it obvious which
 * one a given query belongs to.
 */

import { slugify } from '../assets/js/markdown.js';

const TAGS_SUBQUERY = `(
  SELECT json_group_array(json_object('slug', t.slug, 'name', t.name))
  FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
  WHERE pt.post_id = p.id
)`;

function parseTags(json) {
  if (!json) return [];
  return JSON.parse(json).filter(Boolean);
}

// Defensive the same way parseTags would need to be if a hand-edited row
// ever put non-JSON here — type_fields is app-validated on write
// (src/validate.js's validateTypeFields), but a reader shouldn't 500 over a
// column it doesn't control the history of.
function parseTypeFields(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapAdminPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt,
    body_md: row.body_md,
    body_html: row.body_html,
    status: row.status,
    visibility: row.visibility,
    author: { id: row.author_id, name: row.author_name },
    cover: row.cover_key ? { url: `/media/${row.cover_key}`, alt: row.cover_alt || '' } : null,
    cover_key: row.cover_key,
    cover_alt: row.cover_alt,
    canonical_url: row.canonical_url,
    tags: parseTags(row.tags_json),
    word_count: row.word_count,
    reading_minutes: row.reading_minutes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    scheduled_for: row.scheduled_for,
    // migrations/0008_collections.sql — 'post' with type_fields null for
    // every ordinary blog post, unless a collection is in play.
    post_type: row.post_type,
    type_fields: parseTypeFields(row.type_fields),
  };
}

/** ETag for optimistic concurrency — `updated_at` changes on every write, so it's already a monotonic version token; no separate column needed. */
export function etagFor(post) {
  return `"${post.updated_at}"`;
}

export async function slugExists(db, slug, excludeId = null) {
  const row = await db
    .prepare(`SELECT 1 FROM posts WHERE slug = ? AND id != ? LIMIT 1`)
    .bind(slug, excludeId || '')
    .first();
  return Boolean(row);
}

/** Appends `-2`, `-3`, … until the slug is free — same scheme the demo client already fakes in assets/js/api.js. */
export async function uniqueSlug(db, base, excludeId = null) {
  let slug = base;
  let n = 2;
  while (await slugExists(db, slug, excludeId)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

const REVISION_COUNT_SUBQUERY = `(SELECT COUNT(*) FROM revisions r WHERE r.post_id = p.id)`;

export async function getAdminPostById(db, id) {
  const row = await db
    .prepare(`
      SELECT p.*, a.name AS author_name, ${TAGS_SUBQUERY} AS tags_json,
             ${REVISION_COUNT_SUBQUERY} AS revision_count
      FROM posts p JOIN authors a ON a.id = p.author_id
      WHERE p.id = ?
    `)
    .bind(id)
    .first();
  if (!row) return null;
  return { ...mapAdminPost(row), revision_count: row.revision_count };
}

/**
 * Same shape as `getAdminPostById`, keyed by slug instead — Phase 6's MCP
 * tools accept `slug` as an alternative to `id` for every post lookup
 * (docs/mcp.md: "a model working from a URL has the slug"), which the REST
 * API never needed since `assets/js/admin.js` always navigates by id.
 */
export async function getAdminPostBySlug(db, slug) {
  const row = await db
    .prepare(`
      SELECT p.*, a.name AS author_name, ${TAGS_SUBQUERY} AS tags_json,
             ${REVISION_COUNT_SUBQUERY} AS revision_count
      FROM posts p JOIN authors a ON a.id = p.author_id
      WHERE p.slug = ?
    `)
    .bind(slug)
    .first();
  if (!row) return null;
  return { ...mapAdminPost(row), revision_count: row.revision_count };
}

/** Posts still `scheduled` whose time has arrived — the cron sweep's input (Phase 5f). */
export async function getDueScheduledPosts(db, nowIso) {
  const { results } = await db
    .prepare(`
      SELECT p.*, a.name AS author_name, ${TAGS_SUBQUERY} AS tags_json
      FROM posts p JOIN authors a ON a.id = p.author_id
      WHERE p.status = 'scheduled' AND p.scheduled_for <= ?
    `)
    .bind(nowIso)
    .all();
  return results.map(mapAdminPost);
}

// Defaults to 'post' — every existing caller (the admin posts list, the
// dashboard's counts via listAdminPosts's own callers) keeps seeing exactly
// what it always has unless it explicitly asks for 'all' or a collection's
// own type, per migrations/0008_collections.sql's additive-only contract.
export async function listAdminPosts(db, { status, tag, author, q, type = 'post', limit = 20, offset = 0, sort = 'updated' } = {}) {
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('p.status = ?');
    params.push(status);
  }
  if (type && type !== 'all') {
    where.push('p.post_type = ?');
    params.push(type);
  }
  if (author) {
    where.push('p.author_id = ?');
    params.push(author);
  }
  if (tag) {
    where.push(`EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id AND t.slug = ?)`);
    params.push(tag);
  }
  if (q) {
    where.push(`(p.title LIKE ? OR p.excerpt LIKE ? OR p.body_md LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const orderBy =
    { oldest: 'p.created_at ASC', title: 'p.title ASC', updated: 'p.updated_at DESC' }[sort] ||
    'p.published_at DESC, p.created_at DESC';

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const boundedOffset = Math.max(0, Number(offset) || 0);

  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM posts p ${whereSql}`).bind(...params).first();
  const { results } = await db
    .prepare(`
      SELECT p.*, a.name AS author_name, ${TAGS_SUBQUERY} AS tags_json
      FROM posts p JOIN authors a ON a.id = p.author_id
      ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `)
    .bind(...params, boundedLimit, boundedOffset)
    .all();

  const total = countRow?.total || 0;
  return {
    data: results.map((row) => {
      const { body_md, body_html, ...summary } = mapAdminPost(row);
      return summary;
    }),
    page: { limit: boundedLimit, offset: boundedOffset, total, has_more: boundedOffset + results.length < total },
  };
}

/**
 * Full-text search across every status (drafts included) — the admin/MCP
 * equivalent of src/db.js's public `listPublishedPosts({ q })`, which is
 * deliberately restricted to `status = 'published'` and can't be reused
 * here. `bm25()` ranks best-match first; `snippet()` wraps the matched
 * fragment in `**…**` (Markdown, since that's what an MCP client renders)
 * rather than `<b>` — this has no HTML-rendering reader the way the public
 * site's search result list would.
 */
export async function searchAdminPosts(db, { query, status, type = 'post', limit = 20 } = {}) {
  const where = [`posts_fts MATCH ?`];
  const params = [query];

  if (status && status !== 'all') {
    where.push('p.status = ?');
    params.push(status);
  }
  if (type && type !== 'all') {
    where.push('p.post_type = ?');
    params.push(type);
  }

  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));

  const { results } = await db
    .prepare(`
      SELECT p.id, p.slug, p.title, p.status, p.updated_at, p.published_at,
             a.name AS author_name,
             snippet(posts_fts, 2, '**', '**', '…', 12) AS snippet,
             bm25(posts_fts) AS rank
      FROM posts_fts
      JOIN posts p ON p.rowid = posts_fts.rowid
      JOIN authors a ON a.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `)
    .bind(...params, boundedLimit)
    .all();

  return results.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    author: row.author_name,
    updated_at: row.updated_at,
    published_at: row.published_at,
    snippet: row.snippet,
    score: -row.rank, // bm25() is "lower is better" — flipped so a model reading this sees "higher is more relevant", same sense as everywhere else a score appears
  }));
}

/** Replaces a post's tag set — creates any tag whose slug doesn't exist yet, keyed by name (mirrors assets/js/api.js's demo `normaliseTags`). */
export async function setPostTags(db, postId, tagNames) {
  const statements = [db.prepare(`DELETE FROM post_tags WHERE post_id = ?`).bind(postId)];

  for (const name of tagNames) {
    const slug = slugify(name);
    if (!slug) continue;
    const existing = await db.prepare(`SELECT id FROM tags WHERE slug = ?`).bind(slug).first();
    const tagId = existing?.id || crypto.randomUUID();
    if (!existing) {
      statements.push(db.prepare(`INSERT INTO tags (id, slug, name, description) VALUES (?, ?, ?, NULL)`).bind(tagId, slug, name));
    }
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(postId, tagId)
    );
  }

  await db.batch(statements);
}

export async function insertPost(db, post) {
  await db
    .prepare(`
      INSERT INTO posts (
        id, slug, title, subtitle, excerpt, body_md, body_html, status, visibility,
        author_id, cover_key, cover_alt, canonical_url, word_count, reading_minutes,
        created_at, updated_at, published_at, scheduled_for, post_type, type_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      post.id, post.slug, post.title, post.subtitle || null, post.excerpt, post.body_md, post.body_html,
      post.status, post.visibility, post.author_id, post.cover_key || null, post.cover_alt || null,
      post.canonical_url || null, post.word_count, post.reading_minutes,
      post.created_at, post.updated_at, post.published_at || null, post.scheduled_for || null,
      // post_type defaults to 'post' at the schema level too (migrations/
      // 0008_collections.sql) — post.post_type is only ever undefined for
      // callers written before collections existed, so this stays additive.
      post.post_type || 'post', post.type_fields ? JSON.stringify(post.type_fields) : null
    )
    .run();
}

export async function updatePostRow(db, id, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  const set = columns.map((c) => `${c} = ?`).join(', ');
  await db
    .prepare(`UPDATE posts SET ${set} WHERE id = ?`)
    .bind(...columns.map((c) => fields[c]), id)
    .run();
}

export async function deletePostRow(db, id) {
  await db.prepare(`DELETE FROM posts WHERE id = ?`).bind(id).run();
}

// Phase 5f: capped per post so a long-lived, frequently-saved post doesn't grow
// its history unboundedly. Trimmed on write rather than by a separate cron sweep
// — it's a cheap, immediate DELETE, not a standing job.
const MAX_REVISIONS_PER_POST = 20;

export async function insertRevision(db, { postId, title, bodyMd, authorId, note }) {
  await db
    .prepare(`INSERT INTO revisions (id, post_id, title, body_md, author_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), postId, title, bodyMd, authorId, note, new Date().toISOString())
    .run();
  await db
    .prepare(`
      DELETE FROM revisions WHERE post_id = ? AND id NOT IN (
        SELECT id FROM revisions WHERE post_id = ? ORDER BY created_at DESC LIMIT ?
      )
    `)
    .bind(postId, postId, MAX_REVISIONS_PER_POST)
    .run();
}

export async function listRevisions(db, postId) {
  const { results } = await db
    .prepare(`SELECT id, title, note, author_id, created_at FROM revisions WHERE post_id = ? ORDER BY created_at DESC`)
    .bind(postId)
    .all();
  return results;
}

export async function getRevision(db, postId, revisionId) {
  return db
    .prepare(`SELECT * FROM revisions WHERE id = ? AND post_id = ?`)
    .bind(revisionId, postId)
    .first();
}

/* --- Media (Phase 5c) ------------------------------------------------------ */

export async function getMediaByChecksum(db, checksum) {
  return db.prepare(`SELECT * FROM media WHERE checksum = ?`).bind(checksum).first();
}

export async function getMediaByKey(db, key) {
  return db.prepare(`SELECT * FROM media WHERE key = ?`).bind(key).first();
}

export async function insertMedia(db, media) {
  await db
    .prepare(
      `INSERT INTO media (key, filename, content_type, size_bytes, width, height, alt, checksum, uploaded_by, created_at, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      media.key, media.filename, media.content_type, media.size_bytes,
      media.width, media.height, media.alt || null, media.checksum, media.uploaded_by, media.created_at,
      media.source_url || null
    )
    .run();
}

/** Which of these WXR attachment URLs (Phase 7 import) already have a media row from a previous /run — keyed by source_url so a resumed run can skip re-fetching them entirely. */
export async function getMediaKeysBySourceUrls(db, urls) {
  const found = new Map();
  for (let i = 0; i < urls.length; i += 100) {
    // D1 bounds the number of bound parameters per statement — chunked
    // defensively even though no real WXR export gets remotely close.
    const chunk = urls.slice(i, i + 100);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT key, source_url FROM media WHERE source_url IN (${placeholders})`)
      .bind(...chunk)
      .all();
    for (const row of results) found.set(row.source_url, row.key);
  }
  return found;
}

export async function updateMediaRow(db, key, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  const set = columns.map((c) => `${c} = ?`).join(', ');
  await db.prepare(`UPDATE media SET ${set} WHERE key = ?`).bind(...columns.map((c) => fields[c]), key).run();
}

export async function deleteMediaRow(db, key) {
  await db.prepare(`DELETE FROM media WHERE key = ?`).bind(key).run();
}

/**
 * Posts referencing this media key — as the cover, or inline via its public
 * URL in body_md. Backs both `GET /:key/usage` and the delete guard. Uses
 * `instr()` rather than `LIKE '%...%'` — this is a literal substring check,
 * not a user-supplied pattern, and a real key can be long enough to trip
 * D1's "LIKE or GLOB pattern too complex" guard; `instr()` has no pattern
 * syntax at all, so there's nothing for that guard to object to.
 */
export async function listPostsReferencingMedia(db, key) {
  const { results } = await db
    .prepare(`SELECT id, slug, title FROM posts WHERE cover_key = ? OR instr(body_md, ?) > 0`)
    .bind(key, `/media/${key}`)
    .all();
  return results;
}

// Settings keys that store a media R2 key (#15's site_icon_key, and
// social_image_key which already existed but had this same gap) — kept as
// one list so a future settings-driven image field only needs adding here,
// not touching every media-delete-guard call site.
const MEDIA_SETTINGS_KEYS = ['site_icon_key', 'social_image_key'];

/** Which of MEDIA_SETTINGS_KEYS currently point at this media key — settings.value is JSON-encoded, so a string value is stored quoted. */
export async function listSettingsReferencingMedia(db, key) {
  const placeholders = MEDIA_SETTINGS_KEYS.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT key FROM settings WHERE key IN (${placeholders}) AND value = ?`)
    .bind(...MEDIA_SETTINGS_KEYS, JSON.stringify(key))
    .all();
  return results.map((row) => row.key);
}

/**
 * `unused=true` needs a per-row reference count that isn't cheap to express
 * as one WHERE clause (cover_key equality vs. a body_md substring search are
 * different shapes) — computed per row instead, then paginated in JS rather
 * than SQL, so the filter can't silently break pagination by being applied
 * after a SQL-level LIMIT already cut the candidate set down. Fine at the
 * scale a single site's media library operates at.
 */
export async function listAdminMedia(db, { q, type, unused, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (type && type !== 'all') {
    where.push(`content_type LIKE ?`);
    params.push(`${type}/%`);
  }
  if (q) {
    where.push(`(filename LIKE ? OR alt LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { results } = await db
    .prepare(`SELECT * FROM media ${whereSql} ORDER BY created_at DESC`)
    .bind(...params)
    .all();

  const withUsage = await Promise.all(
    results.map(async (row) => {
      const [posts, settings] = await Promise.all([
        listPostsReferencingMedia(db, row.key),
        listSettingsReferencingMedia(db, row.key),
      ]);
      return { ...row, used_by: posts.length + settings.length };
    })
  );
  const filtered = unused ? withUsage.filter((row) => row.used_by === 0) : withUsage;

  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const page = filtered.slice(boundedOffset, boundedOffset + boundedLimit);

  return {
    data: page,
    page: { limit: boundedLimit, offset: boundedOffset, total: filtered.length, has_more: boundedOffset + page.length < filtered.length },
  };
}

/** Every tag with its post count, including tags on zero posts — the admin list is a management view, not the public "tags with content" one in src/db.js, so it counts across every post status, not just published. */
export async function listAdminTags(db) {
  const { results } = await db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.description, COUNT(pt.post_id) AS post_count
      FROM tags t
      LEFT JOIN post_tags pt ON pt.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.name ASC
    `)
    .all();
  return results;
}

export async function getTagById(db, id) {
  return db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first();
}

/** Same shape as one row of `listAdminTags`, for routes that need a single tag's current post count after a write (rename, merge). */
export async function getAdminTagById(db, id) {
  return db
    .prepare(`
      SELECT t.id, t.slug, t.name, t.description, COUNT(pt.post_id) AS post_count
      FROM tags t
      LEFT JOIN post_tags pt ON pt.tag_id = t.id
      WHERE t.id = ?
      GROUP BY t.id
    `)
    .bind(id)
    .first();
}

export async function getTagBySlug(db, slug) {
  return db.prepare(`SELECT * FROM tags WHERE slug = ?`).bind(slug).first();
}

export async function tagSlugExists(db, slug, excludeId = null) {
  const row = await db.prepare(`SELECT 1 FROM tags WHERE slug = ? AND id != ? LIMIT 1`).bind(slug, excludeId || '').first();
  return Boolean(row);
}

export async function insertTag(db, { id, slug, name, description = null }) {
  await db.prepare(`INSERT INTO tags (id, slug, name, description) VALUES (?, ?, ?, ?)`).bind(id, slug, name, description).run();
}

export async function updateTagRow(db, id, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  const set = columns.map((c) => `${c} = ?`).join(', ');
  await db.prepare(`UPDATE tags SET ${set} WHERE id = ?`).bind(...columns.map((c) => fields[c]), id).run();
}

/** `post_tags` rows cascade via its `tag_id` FK (same reliance as `deletePostRow` above) — this "detaches from posts" per docs/api.md without a separate DELETE statement. */
export async function deleteTagRow(db, id) {
  await db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run();
}

/* --- Authors (Phase 5e) ----------------------------------------------------- */

/** `post_count` here is every post the author has written regardless of status, same "management view, not the public one" reasoning as listAdminTags — it's what the delete confirmation needs to warn with. */
export async function listAdminAuthors(db) {
  const { results } = await db
    .prepare(`
      SELECT a.id, a.email, a.name, a.bio, a.avatar_key, a.role, a.disabled, a.created_at,
             COUNT(p.id) AS post_count
      FROM authors a
      LEFT JOIN posts p ON p.author_id = a.id
      GROUP BY a.id
      ORDER BY a.name ASC
    `)
    .all();
  return results;
}

export async function getAuthorById(db, id) {
  return db.prepare(`SELECT * FROM authors WHERE id = ?`).bind(id).first();
}

export async function authorEmailExists(db, email, excludeId = null) {
  const row = await db.prepare(`SELECT 1 FROM authors WHERE email = ? AND id != ? LIMIT 1`).bind(email, excludeId || '').first();
  return Boolean(row);
}

export async function insertAuthor(db, { id, email, name, role, bio = null, created_at }) {
  await db
    .prepare(`INSERT INTO authors (id, email, name, bio, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, email, name, bio, role, created_at)
    .run();
}

export async function updateAuthorRow(db, id, fields) {
  const columns = Object.keys(fields);
  if (!columns.length) return;
  const set = columns.map((c) => `${c} = ?`).join(', ');
  await db.prepare(`UPDATE authors SET ${set} WHERE id = ?`).bind(...columns.map((c) => fields[c]), id).run();
}

export async function deleteAuthorRow(db, id) {
  await db.prepare(`DELETE FROM authors WHERE id = ?`).bind(id).run();
}

/** Active (enabled) owners other than `excludeId` — lets a guard ask "if this one stopped counting, would any owner be left?" in one query. */
export async function countActiveOwners(db, excludeId = null) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM authors WHERE role = 'owner' AND disabled = 0 AND id != ?`)
    .bind(excludeId || '')
    .first();
  return row?.total || 0;
}

/** The other half of an author delete (docs/api.md: "their posts are reassigned to the owner") — every post they wrote repointed at `toId` before the row itself goes. */
export async function reassignPosts(db, fromId, toId) {
  await db.prepare(`UPDATE posts SET author_id = ? WHERE author_id = ?`).bind(toId, fromId).run();
}

/**
 * Folds every `fromIds` tag into `intoId`: re-points each of its posts at
 * `intoId` (via `INSERT OR IGNORE`, since a post already carrying both tags
 * would collide with `post_tags`'s composite primary key on a plain UPDATE),
 * then deletes the now-empty `from` tag, cascading its own leftover
 * `post_tags` rows the same way `deleteTagRow` does.
 */
export async function mergeTagsRows(db, fromIds, intoId) {
  const statements = [];
  for (const fromId of fromIds) {
    if (fromId === intoId) continue;
    const { results } = await db.prepare(`SELECT post_id FROM post_tags WHERE tag_id = ?`).bind(fromId).all();
    for (const { post_id } of results) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post_id, intoId));
    }
    statements.push(db.prepare(`DELETE FROM tags WHERE id = ?`).bind(fromId));
  }
  if (statements.length) await db.batch(statements);
}
