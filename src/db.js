/**
 * D1 query layer for the public read path (Phase 3).
 *
 * Every function here returns objects already shaped like the API responses
 * documented in docs/api.md — the same shapes assets/js/demo-data.js has been
 * standing in for since Phase 1, so nothing in the front end needs to change
 * to consume real data. All queries are parameterised; nothing here ever
 * concatenates a caller-supplied value into SQL text.
 */

const TAGS_SUBQUERY = `(
  SELECT json_group_array(json_object('slug', t.slug, 'name', t.name))
  FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
  WHERE pt.post_id = p.id
)`;

// Applied to every public-facing query below that reads from `posts` — a
// collection item (post_type != 'post', migrations/0008_collections.sql)
// must never surface where the blog's own posts are expected (the home
// page, feeds, tags, archive, search, related posts…). One helper rather
// than the literal string repeated at each call site, so every place this
// needs to hold is easy to audit in one grep. `alias` matches whatever this
// particular query already calls the `posts` table — omit it where the
// query has none.
function postTypeFilter(alias) {
  return `${alias ? `${alias}.` : ''}post_type = 'post'`;
}

function parseTags(json) {
  if (!json) return [];
  const tags = JSON.parse(json);
  // json_group_array over zero rows still returns a one-element array
  // containing NULL, not an empty array — collapse that back to [].
  return tags.filter(Boolean);
}

// Defensive the same way parseTags would need to be if a hand-edited row
// ever put non-JSON in this column — type_fields is app-validated on write
// (src/validate.js's validateTypeFields), but a reader shouldn't 500 over a
// column it doesn't control the history of.
function parseTypeFields(json) {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapCover(row) {
  return row.cover_key ? { url: `/media/${row.cover_key}`, alt: row.cover_alt || '' } : null;
}

function mapAuthor(row) {
  return { name: row.author_name, avatar: row.author_avatar_key ? `/media/avatars/${row.author_avatar_key}` : null };
}

function mapSummary(row) {
  return {
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt,
    cover: mapCover(row),
    author: mapAuthor(row),
    tags: parseTags(row.tags_json),
    reading_minutes: row.reading_minutes,
    published_at: row.published_at,
    updated_at: row.updated_at,
  };
}

function mapItemSummary(row) {
  return {
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt,
    cover: mapCover(row),
    reading_minutes: row.reading_minutes,
    published_at: row.published_at,
    updated_at: row.updated_at,
    type_fields: parseTypeFields(row.type_fields),
  };
}

/**
 * Published posts, newest first. `tag`/`q`/`before`/`after` are optional
 * filters — each is only applied when its value is truthy, via bound
 * parameters (never string-built into the query).
 */
export async function listPublishedPosts(db, { limit = 20, offset = 0, tag, q, before, after } = {}) {
  const where = [`p.status = 'published'`, postTypeFilter('p')];
  const params = [];

  if (tag) {
    where.push(`EXISTS (
      SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = p.id AND t.slug = ?
    )`);
    params.push(tag);
  }
  if (q) {
    where.push(`p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`);
    params.push(q);
  }
  if (before) {
    where.push(`p.published_at <= ?`);
    params.push(before);
  }
  if (after) {
    where.push(`p.published_at >= ?`);
    params.push(after);
  }

  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const boundedOffset = Math.max(0, Number(offset) || 0);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM posts p WHERE ${where.join(' AND ')}`)
    .bind(...params)
    .first();

  const { results } = await db
    .prepare(`
      SELECT p.slug, p.title, p.subtitle, p.excerpt, p.cover_key, p.cover_alt,
             p.reading_minutes, p.published_at, p.updated_at,
             a.name AS author_name, a.avatar_key AS author_avatar_key,
             ${TAGS_SUBQUERY} AS tags_json
      FROM posts p
      JOIN authors a ON a.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.published_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...params, boundedLimit, boundedOffset)
    .all();

  const total = countRow?.total || 0;
  return {
    data: results.map(mapSummary),
    page: {
      limit: boundedLimit,
      offset: boundedOffset,
      total,
      has_more: boundedOffset + results.length < total,
    },
  };
}

async function relatedPosts(db, postId) {
  const { results } = await db
    .prepare(`
      SELECT p2.slug, p2.title, p2.published_at, COUNT(*) AS shared
      FROM post_tags pt1
      JOIN post_tags pt2 ON pt2.tag_id = pt1.tag_id AND pt2.post_id != pt1.post_id
      JOIN posts p2 ON p2.id = pt2.post_id AND p2.status = 'published' AND ${postTypeFilter('p2')}
      WHERE pt1.post_id = ?
      GROUP BY p2.id
      ORDER BY shared DESC, p2.published_at DESC
      LIMIT 3
    `)
    .bind(postId)
    .all();
  return results.map((r) => ({ slug: r.slug, title: r.title, published_at: r.published_at }));
}

/** One published post, full body, plus up to three related posts. Null if not found/not published. */
export async function getPublishedPostBySlug(db, slug) {
  const row = await db
    .prepare(`
      SELECT p.id, p.slug, p.title, p.subtitle, p.excerpt, p.body_html, p.body_md,
             p.cover_key, p.cover_alt, p.reading_minutes, p.published_at, p.updated_at,
             a.name AS author_name, a.avatar_key AS author_avatar_key,
             ${TAGS_SUBQUERY} AS tags_json
      FROM posts p
      JOIN authors a ON a.id = p.author_id
      WHERE p.slug = ? AND p.status = 'published' AND ${postTypeFilter('p')}
    `)
    .bind(slug)
    .first();

  if (!row) return null;

  return {
    ...mapSummary(row),
    body_html: row.body_html,
    body_md: row.body_md,
    related: await relatedPosts(db, row.id),
  };
}

/** All tags with at least one published post, most-used first. */
export async function listTags(db) {
  const { results } = await db
    .prepare(`
      SELECT t.slug, t.name, COUNT(pt.post_id) AS post_count
      FROM tags t
      JOIN post_tags pt ON pt.tag_id = t.id
      JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND ${postTypeFilter('p')}
      GROUP BY t.id
      HAVING post_count > 0
      ORDER BY post_count DESC, t.name ASC
    `)
    .all();
  return { data: results };
}

/** Published posts grouped by year, newest year first. */
export async function getArchive(db) {
  const { results } = await db
    .prepare(`
      SELECT slug, title, published_at, reading_minutes
      FROM posts
      WHERE status = 'published' AND ${postTypeFilter()}
      ORDER BY published_at DESC
    `)
    .all();

  const byYear = new Map();
  for (const post of results) {
    const year = String(post.published_at).slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push({
      slug: post.slug,
      title: post.title,
      published_at: post.published_at,
      reading_minutes: post.reading_minutes,
    });
  }
  return { data: [...byYear.entries()].map(([year, posts]) => ({ year, posts })) };
}

/** For the R2 media route: does this key exist, and what's its content type? */
export async function getMediaRow(db, key) {
  return db.prepare(`SELECT content_type FROM media WHERE key = ?`).bind(key).first();
}

/**
 * For sitemap.xml: every published permalink plus tag slugs, most recent
 * update first — plus a third leg, `items`, one row per published item of
 * every collection in `collections` whose config has `in_sitemap: true`
 * (src/feeds.js resolves that list from settings and passes it in; this
 * layer stays settings-shape-agnostic, same reasoning as everywhere else
 * here that only ever takes plain params, not a settings object).
 */
export async function listSitemapEntries(db, collections = []) {
  const posts = await db
    .prepare(`SELECT slug, updated_at FROM posts WHERE status = 'published' AND ${postTypeFilter()} ORDER BY updated_at DESC`)
    .all();
  const tags = await db
    .prepare(`SELECT DISTINCT t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
              JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND ${postTypeFilter('p')}`)
    .all();

  const items = [];
  for (const collection of collections) {
    if (!collection?.in_sitemap || !collection.type || !collection.base_path) continue;
    const { results } = await db
      .prepare(`SELECT slug, updated_at FROM posts WHERE status = 'published' AND post_type = ?`)
      .bind(collection.type)
      .all();
    for (const row of results) items.push({ slug: row.slug, updated_at: row.updated_at, base_path: collection.base_path });
  }

  return { posts: posts.results, tags: tags.results.map((r) => r.slug), items };
}

/** For feed.xml/atom.xml: the N most recent published posts, full body_html included. */
export async function listRecentPosts(db, limit = 20) {
  const { results } = await db
    .prepare(`
      SELECT p.slug, p.title, p.subtitle, p.excerpt, p.body_html,
             p.published_at, p.updated_at,
             a.name AS author_name, a.avatar_key AS author_avatar_key,
             ${TAGS_SUBQUERY} AS tags_json
      FROM posts p
      JOIN authors a ON a.id = p.author_id
      WHERE p.status = 'published' AND ${postTypeFilter('p')}
      ORDER BY p.published_at DESC
      LIMIT ?
    `)
    .bind(limit)
    .all();
  return results.map((row) => ({ ...mapSummary(row), body_html: row.body_html }));
}

/**
 * Published items of one collection `type`, newest first — same shape as
 * listPublishedPosts but filtered by post_type instead of hardcoded to
 * 'post', and returning type_fields instead of author/tags (an item's
 * "posts" identity is only its post_type/type_fields, not tags/authorship —
 * collections don't extend to those yet).
 */
export async function listPublishedItems(db, type, { limit = 20, offset = 0 } = {}) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const boundedOffset = Math.max(0, Number(offset) || 0);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM posts WHERE status = 'published' AND post_type = ?`)
    .bind(type)
    .first();

  const { results } = await db
    .prepare(`
      SELECT slug, title, subtitle, excerpt, cover_key, cover_alt, reading_minutes,
             published_at, updated_at, type_fields
      FROM posts
      WHERE status = 'published' AND post_type = ?
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(type, boundedLimit, boundedOffset)
    .all();

  const total = countRow?.total || 0;
  return {
    data: results.map(mapItemSummary),
    page: { limit: boundedLimit, offset: boundedOffset, total, has_more: boundedOffset + results.length < total },
  };
}

/** One published item of collection `type`, by slug — full body. Null if not found/not published/wrong type. */
export async function getPublishedItemBySlug(db, type, slug) {
  const row = await db
    .prepare(`
      SELECT slug, title, subtitle, excerpt, body_html, body_md, cover_key, cover_alt,
             reading_minutes, published_at, updated_at, type_fields
      FROM posts
      WHERE slug = ? AND post_type = ? AND status = 'published'
    `)
    .bind(slug, type)
    .first();
  if (!row) return null;
  return { ...mapItemSummary(row), body_html: row.body_html, body_md: row.body_md };
}

/** Site settings as a plain object — used for feed title/description and the OG defaults. */
export async function getSettings(db) {
  const { results } = await db.prepare(`SELECT key, value FROM settings`).all();
  const settings = {};
  for (const row of results) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }
  return settings;
}
