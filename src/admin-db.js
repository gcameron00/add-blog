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

export async function listAdminPosts(db, { status, tag, author, q, limit = 20, offset = 0, sort = 'updated' } = {}) {
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('p.status = ?');
    params.push(status);
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
        created_at, updated_at, published_at, scheduled_for
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      post.id, post.slug, post.title, post.subtitle || null, post.excerpt, post.body_md, post.body_html,
      post.status, post.visibility, post.author_id, post.cover_key || null, post.cover_alt || null,
      post.canonical_url || null, post.word_count, post.reading_minutes,
      post.created_at, post.updated_at, post.published_at || null, post.scheduled_for || null
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

export async function insertRevision(db, { postId, title, bodyMd, authorId, note }) {
  await db
    .prepare(`INSERT INTO revisions (id, post_id, title, body_md, author_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), postId, title, bodyMd, authorId, note, new Date().toISOString())
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
