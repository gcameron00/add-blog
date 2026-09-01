/**
 * The single most important backward-compatibility test in this feature
 * (migrations/0008_collections.sql, src/collections.js): a post_type other
 * than 'post' must be completely invisible to every query that backs the
 * public blog. A regression here silently leaks non-post content into the
 * blog's home page, feeds, tags, archive and search.
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getArchive,
  getPublishedItemBySlug,
  getPublishedPostBySlug,
  listPublishedItems,
  listPublishedPosts,
  listRecentPosts,
  listSitemapEntries,
  listTags,
} from './db.js';

const PROJECT_ID = 'proj-1';
const PROJECT_SLUG = 'a-project-item';
const PROJECT_ONLY_TAG = 'project-only-tag';

beforeAll(async () => {
  const now = new Date().toISOString();
  await env.DB
    .prepare(`
      INSERT INTO posts (
        id, slug, title, subtitle, excerpt, body_md, body_html, status, visibility,
        author_id, cover_key, cover_alt, word_count, reading_minutes,
        created_at, updated_at, published_at, scheduled_for, post_type, type_fields
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'published', 'public', ?, NULL, NULL, 10, 1, ?, ?, ?, NULL, 'project', ?)
    `)
    .bind(
      PROJECT_ID, PROJECT_SLUG, 'A Project Item', 'A project excerpt.',
      '# Project body\n\nWith **markdown**.', '<p>Project body with <strong>markdown</strong>.</p>',
      'a1', now, now, now, JSON.stringify({ status: 'Live' })
    )
    .run();

  // A tag used only by the project post — proves it never bumps a real tag's
  // count, and never shows up in listTags at all (which only counts tags on
  // published post_type='post' rows).
  await env.DB.prepare(`INSERT INTO tags (id, slug, name, description) VALUES (?, ?, ?, NULL)`).bind(PROJECT_ONLY_TAG, PROJECT_ONLY_TAG, 'Project Only').run();
  await env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(PROJECT_ID, PROJECT_ONLY_TAG).run();
  // Shares a real tag with a real published post too, so relatedPosts has a
  // reason it *would* surface the project row if the filter were missing.
  await env.DB.prepare(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(PROJECT_ID, 'cloudflare').run();
});

describe(`backward compatibility — a post_type='project' row is invisible to every public post query`, () => {
  it('listPublishedPosts never returns it', async () => {
    const { data } = await listPublishedPosts(env.DB, { limit: 100 });
    expect(data.some((p) => p.slug === PROJECT_SLUG)).toBe(false);
  });

  it('listPublishedPosts never returns it even when tag-filtered to a tag it shares with a real post', async () => {
    const { data } = await listPublishedPosts(env.DB, { tag: 'cloudflare', limit: 100 });
    expect(data.some((p) => p.slug === PROJECT_SLUG)).toBe(false);
  });

  it('getPublishedPostBySlug returns null for it', async () => {
    const post = await getPublishedPostBySlug(env.DB, PROJECT_SLUG);
    expect(post).toBeNull();
  });

  it('relatedPosts (via getPublishedPostBySlug().related) never includes it, even sharing a tag', async () => {
    const post = await getPublishedPostBySlug(env.DB, 'shipping-a-blog-on-cloudflare-workers');
    expect(post).toBeTruthy();
    expect(post.related.some((r) => r.slug === PROJECT_SLUG)).toBe(false);
  });

  it('listTags never lists a tag used only by a project-type post', async () => {
    const { data } = await listTags(env.DB);
    expect(data.some((t) => t.slug === PROJECT_ONLY_TAG)).toBe(false);
  });

  it('getArchive never lists it', async () => {
    const { data } = await getArchive(env.DB);
    const allSlugs = data.flatMap((group) => group.posts.map((p) => p.slug));
    expect(allSlugs).not.toContain(PROJECT_SLUG);
  });

  it('listRecentPosts never includes it', async () => {
    const posts = await listRecentPosts(env.DB, 50);
    expect(posts.some((p) => p.slug === PROJECT_SLUG)).toBe(false);
  });

  it(`listSitemapEntries' posts leg never includes it`, async () => {
    const { posts } = await listSitemapEntries(env.DB);
    expect(posts.some((p) => p.slug === PROJECT_SLUG)).toBe(false);
  });
});

describe('listPublishedItems', () => {
  it('returns published items of the requested type', async () => {
    const { data, page } = await listPublishedItems(env.DB, 'project', {});
    expect(data.some((i) => i.slug === PROJECT_SLUG)).toBe(true);
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it('never includes an ordinary post', async () => {
    const { data } = await listPublishedItems(env.DB, 'project', {});
    expect(data.some((i) => i.slug === 'shipping-a-blog-on-cloudflare-workers')).toBe(false);
  });

  it('returns nothing for a type with no rows', async () => {
    const { data } = await listPublishedItems(env.DB, 'nonexistent-type', {});
    expect(data).toEqual([]);
  });
});

describe('getPublishedItemBySlug', () => {
  it('returns the item with parsed type_fields and rendered body', async () => {
    const item = await getPublishedItemBySlug(env.DB, 'project', PROJECT_SLUG);
    expect(item).toBeTruthy();
    expect(item.title).toBe('A Project Item');
    expect(item.type_fields).toEqual({ status: 'Live' });
    expect(item.body_html).toContain('<strong>');
  });

  it('returns null for the right slug but the wrong type', async () => {
    expect(await getPublishedItemBySlug(env.DB, 'post', PROJECT_SLUG)).toBeNull();
  });

  it('returns null for a slug that does not exist', async () => {
    expect(await getPublishedItemBySlug(env.DB, 'project', 'does-not-exist')).toBeNull();
  });
});

describe('listSitemapEntries — third leg (collection items)', () => {
  it('includes a published item of a collection marked in_sitemap', async () => {
    const { items } = await listSitemapEntries(env.DB, [{ type: 'project', base_path: '/portfolio', in_sitemap: true }]);
    expect(items.some((i) => i.slug === PROJECT_SLUG && i.base_path === '/portfolio')).toBe(true);
  });

  it('omits a collection not marked in_sitemap', async () => {
    const { items } = await listSitemapEntries(env.DB, [{ type: 'project', base_path: '/portfolio', in_sitemap: false }]);
    expect(items.length).toBe(0);
  });

  it('defaults to no items when no collections are passed', async () => {
    const { items } = await listSitemapEntries(env.DB);
    expect(items).toEqual([]);
  });
});
