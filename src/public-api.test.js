import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';

async function get(path) {
  return SELF.fetch(`https://${HOST}${path}`);
}

describe('GET /api/posts', () => {
  it('lists published posts only, newest first, with a page envelope', async () => {
    const res = await get('/api/posts');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=300');

    const { data, page } = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(6); // draft/scheduled/archived posts excluded
    expect(page).toMatchObject({ limit: 20, offset: 0, total: 6, has_more: false });

    const publishedDates = data.map((p) => p.published_at);
    expect(publishedDates).toEqual([...publishedDates].sort().reverse());
  });

  it('omits body_html/body_md from list items', async () => {
    const { data } = await (await get('/api/posts')).json();
    for (const post of data) {
      expect(post.body_html).toBeUndefined();
      expect(post.body_md).toBeUndefined();
    }
  });

  it('shapes each item per docs/api.md', async () => {
    const { data } = await (await get('/api/posts')).json();
    const post = data.find((p) => p.slug === 'shipping-a-blog-on-cloudflare-workers');
    expect(post).toMatchObject({
      slug: 'shipping-a-blog-on-cloudflare-workers',
      title: expect.any(String),
      excerpt: expect.any(String),
      author: { name: expect.any(String) },
      reading_minutes: expect.any(Number),
      published_at: expect.any(String),
    });
    expect(Array.isArray(post.tags)).toBe(true);
    expect(post.tags[0]).toHaveProperty('slug');
    expect(post.tags[0]).toHaveProperty('name');
  });

  it('filters by tag', async () => {
    const { data } = await (await get('/api/posts?tag=mcp')).json();
    expect(data.length).toBeGreaterThan(0);
    for (const post of data) {
      expect(post.tags.some((t) => t.slug === 'mcp')).toBe(true);
    }
  });

  it('full-text searches title/excerpt/body', async () => {
    const { data } = await (await get('/api/posts?q=textarea')).json();
    expect(data.some((p) => p.slug === 'the-editor-is-a-textarea')).toBe(true);
  });

  it('paginates with limit/offset', async () => {
    const first = await (await get('/api/posts?limit=2&offset=0')).json();
    expect(first.data.length).toBe(2);
    expect(first.page.has_more).toBe(true);

    const second = await (await get('/api/posts?limit=2&offset=2')).json();
    expect(second.data[0].slug).not.toBe(first.data[0].slug);
  });

  it('clamps an out-of-range limit rather than erroring', async () => {
    const res = await get('/api/posts?limit=99999');
    expect(res.status).toBe(200);
    const { page } = await res.json();
    expect(page.limit).toBe(100);
  });
});

describe('GET /api/posts/:slug', () => {
  it('returns the full post, including related posts', async () => {
    const res = await get('/api/posts/shipping-a-blog-on-cloudflare-workers');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.title).toContain('Cloudflare Workers');
    expect(data.body_html).toContain('<');
    expect(data.body_md).toContain('#');
    expect(Array.isArray(data.related)).toBe(true);
    expect(data.related.length).toBeLessThanOrEqual(3);
  });

  it('404s for a draft post — no signal that it exists', async () => {
    const res = await get('/api/posts/notes-on-the-media-pipeline');
    expect(res.status).toBe(404);
    const { error } = await res.json();
    expect(error.code).toBe('not_found');
  });

  it('404s for a scheduled post', async () => {
    const res = await get('/api/posts/accessibility-pass-findings');
    expect(res.status).toBe(404);
  });

  it('404s for an archived post', async () => {
    const res = await get('/api/posts/an-experiment-in-static-generation');
    expect(res.status).toBe(404);
  });

  it('404s for a slug that never existed', async () => {
    const res = await get('/api/posts/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tags', () => {
  it('lists only tags with at least one published post, most-used first', async () => {
    const { data } = await (await get('/api/tags')).json();
    expect(data.length).toBeGreaterThan(0);
    for (const tag of data) expect(tag.post_count).toBeGreaterThan(0);
    const counts = data.map((t) => t.post_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('GET /api/archive', () => {
  it('groups published posts by year', async () => {
    const { data } = await (await get('/api/archive')).json();
    expect(data.length).toBeGreaterThan(0);
    for (const group of data) {
      expect(group.year).toMatch(/^\d{4}$/);
      expect(group.posts.length).toBeGreaterThan(0);
    }
    const total = data.reduce((sum, g) => sum + g.posts.length, 0);
    expect(total).toBe(6);
  });
});

describe('admin API paths are not handled here', () => {
  it('does not serve /api/admin/* — falls through to a plain 404, not JSON', async () => {
    const res = await get('/api/admin/posts');
    expect(res.status).toBe(404);
  });
});
