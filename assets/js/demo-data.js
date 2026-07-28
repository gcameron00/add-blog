/**
 * Sample content for the Phase 1 prototype.
 *
 * This exists so every page renders something realistic before the D1-backed API
 * is built. The shapes here are deliberately identical to the API responses
 * documented in docs/api.md — that way the rendering code is already exercising
 * the real contract, and Phase 3 swaps the source without touching a view.
 *
 * Delete this file once the API is live; api.js is the only importer.
 */

import { readingMinutes, wordCount, excerptFrom } from './markdown.js';

/**
 * Deterministic gradient cover art, generated as an inline SVG so the prototype
 * makes no network requests and has no binary assets to keep in the repo.
 */
function cover(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const h2 = (h + 55) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${h} 72% 56%)"/>
    <stop offset="1" stop-color="hsl(${h2} 68% 42%)"/>
  </linearGradient>
  <pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse">
    <path d="M48 0H0v48" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1"/>
  </pattern>
</defs>
<rect width="1200" height="630" fill="url(#g)"/>
<rect width="1200" height="630" fill="url(#p)"/>
<circle cx="${200 + (h % 500)}" cy="180" r="200" fill="rgba(255,255,255,.10)"/>
<circle cx="${800 - (h2 % 400)}" cy="520" r="150" fill="rgba(0,0,0,.10)"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\n\s*/g, ''))}`;
}

function avatar(initials, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
<rect width="80" height="80" rx="40" fill="hsl(${hue} 62% 52%)"/>
<text x="40" y="52" font-family="system-ui,sans-serif" font-size="32" font-weight="600"
 fill="#fff" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\n\s*/g, ''))}`;
}

export const AUTHORS = [
  {
    id: 'a1',
    name: 'Grant Cameron',
    email: 'grant@mysite.com',
    role: 'owner',
    bio: 'Builds things on the edge. Writes about what broke.',
    avatar: avatar('GC', 220),
  },
  {
    id: 'a2',
    name: 'Ada Okafor',
    email: 'ada@mysite.com',
    role: 'editor',
    bio: 'Design systems, accessibility, and the occasional performance rant.',
    avatar: avatar('AO', 330),
  },
];

const byId = Object.fromEntries(AUTHORS.map((a) => [a.id, a]));

export const TAGS = [
  { slug: 'cloudflare', name: 'Cloudflare' },
  { slug: 'workers', name: 'Workers' },
  { slug: 'd1', name: 'D1' },
  { slug: 'r2', name: 'R2' },
  { slug: 'mcp', name: 'MCP' },
  { slug: 'architecture', name: 'Architecture' },
  { slug: 'performance', name: 'Performance' },
  { slug: 'accessibility', name: 'Accessibility' },
  { slug: 'design', name: 'Design' },
];

const tagBySlug = Object.fromEntries(TAGS.map((t) => [t.slug, t]));

const RAW_POSTS = [
  {
    id: 'p1',
    slug: 'shipping-a-blog-on-cloudflare-workers',
    title: 'Shipping a blog on Cloudflare Workers',
    subtitle: 'One deployment, two hostnames, zero servers',
    status: 'published',
    author_id: 'a1',
    tags: ['cloudflare', 'workers', 'architecture'],
    published_at: '2026-07-18T09:00:00Z',
    updated_at: '2026-07-20T11:12:00Z',
    body_md: `Most blog engines start from the content model. This one started from the
deployment topology, because the topology is what makes the security properties easy or
hard, and everything else follows from it.

## Two hostnames, one Worker

The whole thing is a single Worker bound to two custom domains:

- \`blog.mysite.com\` — public, anonymous, cached hard
- \`blog-admin.mysite.com\` — behind Cloudflare Access, never cached

The Worker's first act is to look at \`URL.hostname\` and decide which world it is in.
On the public host, \`/admin/*\` and \`/api/admin/*\` return \`404\` unconditionally — not
\`401\`, not \`403\`. There is nothing to probe.

\`\`\`js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAdmin = url.hostname === env.ADMIN_HOST;

    if (!isAdmin && ADMIN_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return new Response('Not found', { status: 404 });
    }
    return isAdmin ? handleAdmin(request, env, ctx) : handlePublic(request, env, ctx);
  },
};
\`\`\`

## Why not a path prefix

Serving the editor from \`blog.mysite.com/admin\` would have been less DNS work. It also
would have made authorization a property of application code — one routing bug away from
publishing everyone's drafts.

> Put the boundary somewhere a mistake in your code cannot move it.

With a separate hostname, Access terminates unauthenticated requests at the edge, before
the Worker runs at all. The public hostname does not have an admin surface to protect
because it does not have one at all.

## What it costs

One extra DNS record and one Access application. That is the entire price, and in
exchange the highest-severity failure mode in the system becomes a deployment
misconfiguration you can test for in one \`curl\`, rather than a code path you have to
keep getting right forever.`,
  },
  {
    id: 'p2',
    slug: 'designing-an-mcp-surface-for-content-editing',
    title: 'Designing an MCP surface for content editing',
    subtitle: 'What an agent should and should not be able to do',
    status: 'published',
    author_id: 'a1',
    tags: ['mcp', 'architecture'],
    published_at: '2026-07-11T14:30:00Z',
    updated_at: '2026-07-11T14:30:00Z',
    body_md: `Giving a model write access to a blog is easy. Giving it write access you can
still sleep next to takes a bit more thought.

## Publishing is always its own call

The single most useful constraint in the whole tool surface: \`create_post\` cannot
publish. Neither can \`update_post\`. The \`status\` field is ignored on write and forced
to \`draft\`.

That means an agent cannot make something live as a *side effect* of anything. Going
public requires calling a tool named \`publish_post\`, which is a decision, not an
accident. If the model gets a draft badly wrong, the blast radius is a draft.

## Tools are filtered by role

The MCP endpoint runs behind the same Cloudflare Access application as the admin UI, and
resolves the caller to the same \`authors\` row with the same role. An \`author\`-role
identity does not merely get rejected when it calls \`publish_post\` — it never sees
\`publish_post\` in \`tools/list\` at all.

| Role | Sees drafting tools | Sees publish/delete | Sees settings |
| --- | :---: | :---: | :---: |
| owner | yes | yes | yes |
| editor | yes | yes | no |
| author | yes | no | no |

Advertising a tool that will fail is a bad experience for a model in exactly the way it
is for a person: it will keep trying.

## Errors have to be actionable

A model recovers from a good error and flails at a vague one. Every failure returns a
stable \`code\`, the offending field, and where possible a fix:

\`\`\`json
{
  "error": {
    "code": "slug_taken",
    "message": "A post with the slug \\"edge-caching\\" already exists.",
    "field": "slug",
    "suggestion": "edge-caching-2"
  }
}
\`\`\`

That one \`suggestion\` field turns a round trip to the human into a retry.`,
  },
  {
    id: 'p3',
    slug: 'd1-as-a-content-store',
    title: 'D1 as a content store: what worked, what surprised me',
    subtitle: 'SQLite at the edge, holding actual prose',
    status: 'published',
    author_id: 'a2',
    tags: ['d1', 'cloudflare', 'architecture'],
    published_at: '2026-07-04T08:15:00Z',
    updated_at: '2026-07-06T16:40:00Z',
    body_md: `A blog is a small dataset with a demanding read pattern: a handful of
queries, run constantly, that must be fast everywhere. That is a good fit for D1, with a
few things worth knowing up front.

## Markdown is the source of truth, HTML is a cache

Every post stores both \`body_md\` and \`body_html\`. Rendering happens once, on write.

The temptation is to render on read and keep one column. Don't. Rendering on read puts a
Markdown parser on the hot path of every page view to produce a byte-identical result
every time. Rendering on write means a public read is one indexed \`SELECT\` and a
serialisation, and a change to the renderer becomes a migration — which is the right
place for it, because you want to know exactly when every post's HTML changed.

## Store timestamps as ISO-8601 strings

Not epoch integers. They sort lexicographically, they are unambiguous about timezone, and
when you are staring at the D1 console at 2am trying to work out why a scheduled post did
not go out, you can read them.

## Set \`published_at\` exactly once

Editing a published post touches \`updated_at\` and nothing else. Unpublishing and
republishing does not reset it either. Otherwise a typo fix silently moves a two-year-old
post to the top of the feed and into every subscriber's reader.

## The scheduled-publish query is free

\`\`\`sql
CREATE INDEX idx_posts_scheduled ON posts(status, scheduled_for)
  WHERE status = 'scheduled';
\`\`\`

A partial index over the handful of scheduled rows. The cron trigger runs every five
minutes and the query touches almost nothing.

## What surprised me

Full-text search. \`fts5\` is available and works, but keeping the external-content table
in sync through triggers is more machinery than a personal blog needs. \`LIKE\` over title
and excerpt is genuinely fine below a few thousand posts, and you can add FTS the day
that stops being true.`,
  },
  {
    id: 'p4',
    slug: 'caching-a-blog-you-can-publish-to-instantly',
    title: 'Caching a blog you can publish to instantly',
    subtitle: 'Long TTLs, aggressive purges, and a backstop for when purges fail',
    status: 'published',
    author_id: 'a1',
    tags: ['performance', 'cloudflare', 'workers'],
    published_at: '2026-06-27T10:00:00Z',
    updated_at: '2026-06-27T10:00:00Z',
    body_md: `The two things a blog owner wants from caching are in direct tension: pages
should be served from the edge without touching the database, and hitting *Publish*
should make the post appear immediately.

## The policy

| Response | Cache-Control |
| --- | --- |
| Public HTML | \`public, max-age=60, s-maxage=3600, stale-while-revalidate=86400\` |
| Public JSON | \`public, max-age=30, s-maxage=300\` |
| \`/media/*\` | \`public, max-age=31536000, immutable\` |
| Admin | \`private, no-store\` |

Media gets a year because media keys contain a hash of the content. An object at a given
key is *the same bytes forever*; a new image is a new key. That is the whole trick — you
never have to invalidate media, you only have to stop referencing it.

## Purge on every mutation

Publishing purges the permalink, the home page, the archive, every affected tag page and
the feed. The important part is not the purge itself, it is that **every path to
publication goes through one function**:

\`\`\`js
async function publishPost(env, ctx, post) {
  await writePublishState(env, post);
  await audit(env, 'post.publish', post.id);
  ctx.waitUntil(purgeForPost(env, post));
}
\`\`\`

The API endpoint calls it. The cron trigger for scheduled posts calls it. The MCP tool
calls it. There is exactly one place to forget a purge, so it does not get forgotten in
the path you use least.

## Assume the purge fails

Purges run in \`waitUntil\` and are best-effort. \`s-maxage=3600\` looks like it undermines
this, but it is the backstop: if a purge fails, the worst case is an hour of staleness,
not permanent staleness. Designing the failure mode to be *slow* rather than *wrong* is
worth more than making the happy path a few milliseconds faster.`,
  },
  {
    id: 'p5',
    slug: 'the-editor-is-a-textarea',
    title: 'The editor is a textarea, and that is the point',
    subtitle: 'Why the writing surface stayed boring',
    status: 'published',
    author_id: 'a2',
    tags: ['design', 'mcp'],
    published_at: '2026-06-19T13:20:00Z',
    updated_at: '2026-06-19T13:20:00Z',
    body_md: `There is a strong pull toward building a rich-text editor. Contenteditable,
floating toolbars, drag-to-reorder blocks. We built a textarea with a live preview beside
it.

## The argument that settled it

The blog has two kinds of author: people and models. A rich-text editor optimises for one
and actively harms the other.

A model editing a rich-text document model has to reason about a nested JSON tree, produce
a valid patch against it, and get node identity right. A model editing Markdown produces
text. One of these is reliable today and one is not, and since the MCP surface is a
headline feature rather than an afterthought, the format that both audiences handle well
wins.

## What we spent the effort on instead

- **Live preview** rendered with the same code the server will use at write time, so what
  you see is what gets stored.
- **Autosave** every 90 seconds into the revision table, with a visible saved-state
  indicator. Never a spinner over the text.
- **Slug locking.** The slug tracks the title until you edit it, then it stops. Renaming a
  published post never silently breaks its URL.
- **Conflict detection.** Saving sends \`If-Match\`. If someone else changed the post, you
  get a prompt, not a silent overwrite of their work.
- **Keyboard shortcuts** for bold, italic, link, and save.

None of that is exciting. All of it is the difference between an editor you tolerate and
one you stop noticing, which is the highest compliment an editor can earn.`,
  },
  {
    id: 'p6',
    slug: 'notes-on-the-media-pipeline',
    title: 'Notes on the media pipeline',
    subtitle: 'Content-addressed keys, lazy variants, and why SVG is special',
    status: 'draft',
    author_id: 'a1',
    tags: ['r2', 'performance'],
    published_at: null,
    updated_at: '2026-07-24T17:05:00Z',
    body_md: `Rough notes while the upload path is still being built. Not published yet.

## Keys contain a content hash

\`\`\`
media/2026/07/9f2c4a1b8e3d5f60-diagram.png
\`\`\`

Year and month for browsability, the first 16 hex characters of the SHA-256 for identity,
and the sanitised original filename so the library is readable by a human. Re-uploading
the same bytes produces the same key, which makes uploads idempotent for free — useful
when an agent retries after a transport error.

## Uploads proxy through the Worker

A presigned URL straight to R2 would be fewer bytes through the Worker. But the Worker
already holds the verified Access identity, and proxying lets one request validate the
content type, enforce the size cap, compute the hash that becomes the key, detect the
dimensions, and write the \`media\` row. Splitting that across two round trips buys latency
we do not need and creates a window where an object exists in R2 with no row pointing at
it.

## Variants are generated lazily

A request for a width that does not exist yet gets resized, written back to R2 under the
derived key, and returned. Every later request for that width is a plain R2 read. No work
is ever done for a size nobody asks for.

## SVG is an executable format

This is the one that bites people. An SVG can contain \`<script>\`, and it is served from
your own origin — so an unsanitised SVG upload is stored XSS on your blog, from the
blog's own domain, with the blog's own cookies in scope.

Strip scripts, event handlers, and external references on upload, or do not accept SVG.

TODO: decide whether to accept SVG at all. Leaning toward yes-with-sanitisation, since
diagrams are the main use and rasterising them is a real quality loss.`,
  },
  {
    id: 'p7',
    slug: 'accessibility-pass-findings',
    title: 'Accessibility pass: what the audit found',
    subtitle: 'Eleven issues, nine of them in states nobody had looked at',
    status: 'scheduled',
    author_id: 'a2',
    tags: ['accessibility', 'design'],
    published_at: null,
    scheduled_for: '2026-07-29T09:00:00Z',
    updated_at: '2026-07-23T12:00:00Z',
    body_md: `Scheduled for next Wednesday. The short version: the happy path was fine and
almost every problem lived in a state we had not thought to check.

## The findings

1. **Focus was invisible on the dark theme.** The focus ring inherited an accent colour
   that dropped to 1.9:1 against the dark surface.
2. **The tag filter buttons were divs.** Not reachable by keyboard at all.
3. **Skeleton loaders announced themselves.** Screen readers read out the placeholder
   text. They now carry \`aria-hidden\` with a live region announcing "Loading posts".
4. **The editor's autosave indicator was a colour change only.** Now it has text.
5. **Cover images had empty alt attributes everywhere.** Alt is now required at upload
   time and the API rejects a media record without it.
6. **Heading levels skipped** from \`h1\` to \`h3\` on the archive page.
7. **The theme toggle had no accessible name** — it was an icon in a bare button.
8. **Reduced motion was ignored** by the skeleton shimmer.
9. **Form errors were not associated** with their inputs.

## What I would do differently

Audit the empty state, the loading state and the error state *first*. The populated happy
path is the one everybody already looks at fifty times a day, so it is the one least
likely to be broken. Everything else gets seen once, by whoever built it, on a fast
connection.`,
  },
  {
    id: 'p8',
    slug: 'why-no-framework',
    title: 'Why there is no framework here',
    subtitle: 'A defensible position, not a religious one',
    status: 'published',
    author_id: 'a1',
    tags: ['design', 'performance'],
    published_at: '2026-05-30T11:00:00Z',
    updated_at: '2026-05-30T11:00:00Z',
    body_md: `This site is HTML, CSS and ES modules. No build step, no bundler, no
dependency tree. That is a choice with real costs, so here is the reasoning.

## What the constraint buys

**The deployed artifact is the source.** What is in the repository is what is on the edge.
No sourcemaps, no "works locally, breaks in prod because of a transform".

**There is no supply chain.** A blog engine that can publish to the open internet, with an
MCP endpoint an agent can drive, has an attack surface worth keeping small. Zero
dependencies is zero dependencies to audit and zero to patch at 3am.

**It will still build in five years.** No build step cannot break.

## What it costs

Reactivity, mostly. There is no template layer, so every view is imperative DOM
construction, and that is more verbose. Some of it is genuinely tedious:

\`\`\`js
const title = document.createElement('h2');
title.className = 'post-card__title';
const link = document.createElement('a');
link.href = \`/posts/\${post.slug}\`;
link.textContent = post.title;
title.append(link);
\`\`\`

Three lines where a template would be one. The upside is that \`textContent\` makes
injection structurally impossible in the default path, which for a system that renders
user-authored content is worth some verbosity.

## Where the line is

If this grew a collaborative editor with real-time cursors, a framework would earn its
place and I would add one. It has a post list, an editor and a settings page. The
complexity does not justify the machinery yet, and "yet" is doing honest work in that
sentence.`,
  },
  {
    id: 'p9',
    slug: 'an-experiment-in-static-generation',
    title: 'An experiment in static generation',
    subtitle: 'Pre-rendering to R2 on publish — and why we backed it out',
    status: 'archived',
    author_id: 'a1',
    tags: ['performance', 'r2'],
    published_at: '2026-04-12T09:00:00Z',
    updated_at: '2026-05-02T10:00:00Z',
    body_md: `Archived — superseded by the render-and-cache approach.

The idea was to generate every page's HTML into R2 at publish time, so a request never
touches D1 at all. It worked, and it was measurably faster on a cold cache: about 18ms
saved at the median.

It also meant a publish had to regenerate every page a post appears on — home, archive,
each tag page, the feed — and a change to the site template meant regenerating everything.
Publishing went from 200ms to several seconds, and a partial failure left the site in a
visibly inconsistent state, with a post on its permalink but missing from the index.

Eighteen milliseconds against an entire class of consistency bug. Not a hard call, but
worth writing down so nobody re-litigates it in six months.`,
  },
];

/** Fill in the fields the API computes server-side. */
export const POSTS = RAW_POSTS.map((post) => ({
  ...post,
  excerpt: post.excerpt || excerptFrom(post.body_md, 190),
  word_count: wordCount(post.body_md),
  reading_minutes: readingMinutes(post.body_md),
  created_at: post.created_at || post.updated_at,
  scheduled_for: post.scheduled_for || null,
  visibility: post.visibility || 'public',
  cover: post.cover === null ? null : { url: cover(post.slug), alt: `Cover art for “${post.title}”` },
  author: byId[post.author_id],
  tags: post.tags.map((slug) => tagBySlug[slug]).filter(Boolean),
}));

// `key` is the bare R2 storage key — no `media/` prefix, matching the real
// upload path (src/admin-media.js) and the public read path (src/db.js):
// the route prefix (`/media/<key>`) is added at read time, never stored.
export const MEDIA = [
  { key: '2026/07/9f2c4a1b8e3d5f60-routing-diagram.svg', filename: 'routing-diagram.svg', content_type: 'image/svg+xml', size_bytes: 24_118, width: 1200, height: 630, alt: 'Request routing across two hostnames', created_at: '2026-07-18T08:40:00Z', used_by: 1 },
  { key: '2026/07/3a71ce09bb42d5e1-cache-timeline.png', filename: 'cache-timeline.png', content_type: 'image/png', size_bytes: 186_402, width: 1600, height: 900, alt: 'Timeline of a cache purge after publishing', created_at: '2026-07-14T15:02:00Z', used_by: 1 },
  { key: '2026/06/8d40f7a2c1b93e55-d1-console.png', filename: 'd1-console.png', content_type: 'image/png', size_bytes: 342_990, width: 2048, height: 1180, alt: 'The D1 console showing the posts table', created_at: '2026-06-30T09:22:00Z', used_by: 2 },
  { key: '2026/06/1c5e9b3d7f08a624-editor-shot.webp', filename: 'editor-shot.webp', content_type: 'image/webp', size_bytes: 98_314, width: 1440, height: 900, alt: 'The Markdown editor with live preview', created_at: '2026-06-18T11:47:00Z', used_by: 1 },
  { key: '2026/06/62b8ad14e9c07f3a-contrast-fail.png', filename: 'contrast-fail.png', content_type: 'image/png', size_bytes: 74_220, width: 900, height: 500, alt: 'Contrast checker reporting a 1.9 to 1 ratio', created_at: '2026-06-02T14:10:00Z', used_by: 0 },
  { key: '2026/05/f04c72e6a5d3b918-benchmarks.pdf', filename: 'benchmarks.pdf', content_type: 'application/pdf', size_bytes: 512_770, width: null, height: null, alt: 'Edge latency benchmark results', created_at: '2026-05-21T16:35:00Z', used_by: 0 },
];

export const SETTINGS = {
  site_title: 'The add-blog Journal',
  site_description: 'Notes on building a blog engine for Cloudflare Workers — routing, storage, caching, and giving agents a way in.',
  site_url: 'https://blog.mysite.com',
  admin_url: 'https://blog-admin.mysite.com',
  base_path: '/',
  timezone: 'Europe/London',
  posts_per_page: 10,
  allow_raw_html: false,
  feed_full_content: false,
  analytics_enabled: true,
  social_image_key: null,
};

export const ACTIVITY = [
  { at: '2026-07-24T17:05:00Z', actor: 'grant@mysite.com', via: 'ui', action: 'post.update', detail: 'Notes on the media pipeline' },
  { at: '2026-07-24T09:41:00Z', actor: 'ada@mysite.com', via: 'mcp', action: 'post.create', detail: 'Draft: “Testing the edge cache”' },
  { at: '2026-07-23T12:00:00Z', actor: 'ada@mysite.com', via: 'ui', action: 'post.schedule', detail: 'Accessibility pass — 29 Jul, 09:00' },
  { at: '2026-07-20T11:12:00Z', actor: 'grant@mysite.com', via: 'ui', action: 'post.update', detail: 'Shipping a blog on Cloudflare Workers' },
  { at: '2026-07-18T09:00:00Z', actor: 'grant@mysite.com', via: 'ui', action: 'post.publish', detail: 'Shipping a blog on Cloudflare Workers' },
  { at: '2026-07-18T08:40:00Z', actor: 'grant@mysite.com', via: 'ui', action: 'media.upload', detail: 'routing-diagram.svg' },
  { at: '2026-07-11T14:30:00Z', actor: 'grant@mysite.com', via: 'mcp', action: 'post.publish', detail: 'Designing an MCP surface for content editing' },
];

/** The identity the admin prototype pretends Cloudflare Access returned. */
export const CURRENT_USER = { ...AUTHORS[0], authenticated_via: 'demo' };
