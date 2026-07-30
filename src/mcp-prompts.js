/**
 * MCP prompts (Phase 6) — docs/mcp.md's "Prompts" table. Each `get` returns
 * one `user`-role message pre-loaded with real context read straight out of
 * D1 (the style guide, the post being edited, recent titles) rather than a
 * generic instruction the model would otherwise have to spend a tool call
 * gathering itself — the same "front-load context" reasoning docs/mcp.md
 * gives for `blog://style-guide` existing as a resource at all.
 */

import { getAdminPostBySlug, listAdminMedia, listAdminPosts, listAdminTags } from './admin-db.js';
import { getSettings } from './db.js';

function text(value) {
  return { role: 'user', content: { type: 'text', text: value } };
}

async function styleGuideBlock(env) {
  const settings = await getSettings(env.DB);
  const guide = (settings.style_guide || '').trim();
  return guide ? `\n\nStyle guide:\n${guide}` : '';
}

async function draftPost(args, { env }) {
  if (!args.topic) throw Object.assign(new Error('topic is required.'), { code: 'bad_request', field: 'topic' });

  const { data: recent } = await listAdminPosts(env.DB, { status: 'published', sort: 'newest', limit: 5 });
  const titles = recent.map((p) => `- ${p.title}`).join('\n') || '(no published posts yet)';
  const style = await styleGuideBlock(env);

  return {
    description: `Draft a new post about "${args.topic}"`,
    messages: [text(
      `Draft a new blog post about: ${args.topic}\n\n` +
      `Tone: ${args.tone || "the blog's usual voice — infer it from the style guide and recent posts below"}\n` +
      `Length: ${args.length || 'a typical length for this blog'}\n\n` +
      `Recent posts, for voice and to avoid repeating a topic:\n${titles}${style}\n\n` +
      `When it's ready, call create_post to save it as a draft — do not publish it.`
    )],
  };
}

async function editPost(args, { env }) {
  if (!args.slug) throw Object.assign(new Error('slug is required.'), { code: 'bad_request', field: 'slug' });
  if (!args.instruction) throw Object.assign(new Error('instruction is required.'), { code: 'bad_request', field: 'instruction' });

  const post = await getAdminPostBySlug(env.DB, args.slug);
  if (!post) throw Object.assign(new Error(`No post with slug "${args.slug}".`), { code: 'not_found', field: 'slug' });

  return {
    description: `Revise "${post.title}"`,
    messages: [text(
      `Revise the post below against this instruction: ${args.instruction}\n\n` +
      `Title: ${post.title}\n\n${post.body_md}\n\n` +
      `When it's ready, call update_post with slug "${post.slug}" and ` +
      `expected_updated_at "${post.updated_at}" so the save fails instead of ` +
      `overwriting a change made in the meantime.`
    )],
  };
}

async function suggestTags(args, { env }) {
  if (!args.slug) throw Object.assign(new Error('slug is required.'), { code: 'bad_request', field: 'slug' });

  const post = await getAdminPostBySlug(env.DB, args.slug);
  if (!post) throw Object.assign(new Error(`No post with slug "${args.slug}".`), { code: 'not_found', field: 'slug' });
  const existing = (await listAdminTags(env.DB)).map((t) => t.name);

  return {
    description: `Suggest tags for "${post.title}"`,
    messages: [text(
      `Propose 2-5 tags for this post. Prefer a tag already in use over inventing a new one unless nothing fits.\n\n` +
      `Existing tags: ${existing.join(', ') || '(none yet)'}\n\n` +
      `Title: ${post.title}\n\n${post.body_md}\n\n` +
      `When you've decided, call update_post with slug "${post.slug}" and the full tags list (it replaces, not merges).`
    )],
  };
}

async function writeExcerpt(args, { env }) {
  if (!args.slug) throw Object.assign(new Error('slug is required.'), { code: 'bad_request', field: 'slug' });

  const post = await getAdminPostBySlug(env.DB, args.slug);
  if (!post) throw Object.assign(new Error(`No post with slug "${args.slug}".`), { code: 'not_found', field: 'slug' });

  return {
    description: `Write an excerpt for "${post.title}"`,
    messages: [text(
      `Write a 1-2 sentence excerpt for this post — the teaser shown in the post list, not a summary of every point.\n\n` +
      `Title: ${post.title}\n\n${post.body_md}\n\n` +
      `Call update_post with slug "${post.slug}" and the excerpt once it reads well.`
    )],
  };
}

const SLUG_LINK_RE = /\/posts\/([a-z0-9-]+)/g;
const STALE_DAYS = 180;

async function contentAudit(args, { env }) {
  const { data: posts } = await listAdminPosts(env.DB, { status: 'all', sort: 'updated', limit: 100 });
  const { data: media } = await listAdminMedia(env.DB, { limit: 200 });
  const slugs = new Set(posts.map((p) => p.slug));

  const since = args.since ? new Date(args.since) : null;
  const staleCutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  const stale = posts.filter((p) => p.status === 'published' && new Date(p.updated_at).getTime() < staleCutoff && (!since || new Date(p.updated_at) >= since));
  const untagged = posts.filter((p) => !p.tags.length);
  const missingAlt = media.filter((m) => m.content_type.startsWith('image/') && !m.alt);

  // Broken internal links: scan each post's body for /posts/<slug> and flag
  // any target slug this site doesn't have. Full bodies aren't in
  // listAdminPosts's summary shape, so this needs its own small read.
  const brokenLinks = [];
  for (const summary of posts) {
    const full = await getAdminPostBySlug(env.DB, summary.slug);
    const matches = [...(full.body_md || '').matchAll(SLUG_LINK_RE)];
    for (const [, target] of matches) {
      if (!slugs.has(target)) brokenLinks.push({ from: summary.slug, to: target });
    }
  }

  return {
    description: 'Content audit',
    messages: [text(
      `Summarise this content audit as a short, actionable report.\n\n` +
      `Stale published posts (untouched ${STALE_DAYS}+ days): ${stale.map((p) => p.slug).join(', ') || 'none'}\n` +
      `Untagged posts: ${untagged.map((p) => p.slug).join(', ') || 'none'}\n` +
      `Images missing alt text: ${missingAlt.map((m) => m.key).join(', ') || 'none'}\n` +
      `Broken internal links: ${brokenLinks.map((l) => `${l.from} -> /posts/${l.to}`).join(', ') || 'none'}\n\n` +
      `For each issue found, suggest the specific tool call that would fix it.`
    )],
  };
}

export const PROMPTS = [
  {
    name: 'draft_post',
    description: "Draft a new post in the blog's voice, using the style guide and recent posts as reference",
    arguments: [
      { name: 'topic', description: 'What the post should be about', required: true },
      { name: 'tone', description: 'Optional tone override' },
      { name: 'length', description: 'Optional length guidance' },
    ],
    get: draftPost,
  },
  {
    name: 'edit_post',
    description: 'Revise an existing post against a specific instruction',
    arguments: [
      { name: 'slug', description: 'Post slug', required: true },
      { name: 'instruction', description: 'What to change', required: true },
    ],
    get: editPost,
  },
  {
    name: 'suggest_tags',
    description: 'Propose tags, preferring tags already in use over inventing new ones',
    arguments: [{ name: 'slug', description: 'Post slug', required: true }],
    get: suggestTags,
  },
  {
    name: 'write_excerpt',
    description: 'Produce a 1-2 sentence excerpt',
    arguments: [{ name: 'slug', description: 'Post slug', required: true }],
    get: writeExcerpt,
  },
  {
    name: 'content_audit',
    description: 'Find stale posts, missing alt text, untagged posts, broken internal links',
    arguments: [{ name: 'since', description: 'Optional ISO date — only flag staleness for posts touched since then' }],
    get: contentAudit,
  },
];

const PROMPTS_BY_NAME = new Map(PROMPTS.map((prompt) => [prompt.name, prompt]));

export function getPrompt(name) {
  return PROMPTS_BY_NAME.get(name);
}
