import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOST = 'blog.mysite.com';
// Published in the seed and related to shipping-a-blog-on-cloudflare-workers
// (shared cloudflare/workers/architecture tags).
const UNLISTED = 'd1-as-a-content-store';
const NEIGHBOUR = 'shipping-a-blog-on-cloudflare-workers';

async function get(path) {
  return SELF.fetch(`https://${HOST}${path}`, { redirect: 'manual' });
}

async function setVisibility(slug, visibility) {
  await env.DB.prepare(`UPDATE posts SET visibility = ? WHERE slug = ?`).bind(visibility, slug).run();
}

beforeEach(() => setVisibility(UNLISTED, 'unlisted'));
afterEach(() => setVisibility(UNLISTED, 'public'));

describe('unlisted posts', () => {
  it('still open at their own permalink, marked noindex', async () => {
    const res = await get(`/posts/${UNLISTED}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<meta name="robots" content="noindex" />');
  });

  it('are still served by the single-post API', async () => {
    const res = await get(`/api/posts/${UNLISTED}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.visibility).toBe('unlisted');
  });

  it('are left out of the post list and search', async () => {
    const { data, page } = await (await get('/api/posts?limit=100')).json();
    expect(data.map((p) => p.slug)).not.toContain(UNLISTED);
    expect(data.length).toBe(page.total);
  });

  it('are left out of another post\'s related posts', async () => {
    const { data } = await (await get(`/api/posts/${NEIGHBOUR}`)).json();
    expect(data.related.map((r) => r.slug)).not.toContain(UNLISTED);
  });

  it('are left out of the archive', async () => {
    const { data } = await (await get('/api/archive')).json();
    const slugs = data.flatMap((year) => year.posts.map((p) => p.slug));
    expect(slugs).not.toContain(UNLISTED);
  });

  it('are left out of the feeds and sitemap', async () => {
    for (const path of ['/feed.xml', '/atom.xml', '/sitemap.xml']) {
      const body = await (await get(path)).text();
      expect(body, path).not.toContain(`/posts/${UNLISTED}`);
    }
  });

  it('don\'t count towards tag totals', async () => {
    const before = await (await get('/api/tags')).json();
    await setVisibility(UNLISTED, 'public');
    const after = await (await get('/api/tags')).json();
    const total = (tags) => tags.data.reduce((sum, t) => sum + t.post_count, 0);
    expect(total(after)).toBeGreaterThan(total(before));
  });

  it('public posts carry no noindex', async () => {
    const html = await (await get(`/posts/${NEIGHBOUR}`)).text();
    expect(html).not.toContain('name="robots"');
  });
});
