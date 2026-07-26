/**
 * Seeds a D1 binding directly, via parameterized statements — used by tests
 * (src/test-setup.js). migrations/seed.sql (generate-seed.mjs) is the
 * equivalent for a real deployment via `wrangler d1 execute --file=`; that
 * path properly parses multi-line SQL text, but Miniflare's local `.exec()`
 * emulation does not (it splits naively on newlines, which breaks on any
 * string literal — such as a post body — that contains one), so tests use
 * this instead rather than fighting that.
 */
import { AUTHORS, TAGS, POSTS, SETTINGS } from '../assets/js/demo-data.js';
import { renderMarkdown } from '../assets/js/markdown.js';

export async function seedTestDatabase(db) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const statements = [];

  for (const author of AUTHORS) {
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO authors (id, email, name, bio, avatar_key, role, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
        .bind(author.id, author.email, author.name, author.bio, author.role, now)
    );
  }

  for (const tag of TAGS) {
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO tags (id, slug, name, description) VALUES (?, ?, ?, NULL)`)
        .bind(tag.slug, tag.slug, tag.name)
    );
  }

  const published = POSTS.filter((post) => post.status === 'published');
  for (const post of published) {
    const bodyHtml = renderMarkdown(post.body_md);
    statements.push(
      db.prepare(`
        INSERT OR IGNORE INTO posts (id, slug, title, subtitle, excerpt, body_md, body_html, status, visibility,
          author_id, cover_key, cover_alt, word_count, reading_minutes, created_at, updated_at, published_at, scheduled_for)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)
      `).bind(
        post.id, post.slug, post.title, post.subtitle, post.excerpt, post.body_md, bodyHtml,
        post.visibility || 'public', post.author_id, post.word_count, post.reading_minutes,
        post.created_at, post.updated_at, post.published_at
      )
    );
    for (const tag of post.tags) {
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)`).bind(post.id, tag.slug)
      );
    }
  }

  for (const [key, value] of Object.entries(SETTINGS)) {
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).bind(key, JSON.stringify(value), now)
    );
  }

  await db.batch(statements);
}
