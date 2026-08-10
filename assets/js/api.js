/**
 * API client for both the public blog and the admin UI.
 *
 * Every call goes to the real endpoint documented in docs/api.md first. If a
 * given endpoint is not live yet — the public read API shipped in Phase 3,
 * but the admin API is still Phases 4-5 — the client falls back to the
 * bundled demo data for the rest of the session and announces it once, so
 * pages never sit empty and the UI can flag that what you are looking at is
 * not real content.
 *
 * As each endpoint goes live, its fetches start succeeding and this file
 * stops using demo-data.js for it. No view code changes, per call.
 */

import * as demo from './demo-data.js';
import { renderMarkdown, excerptFrom, wordCount, readingMinutes, slugify } from './markdown.js';

const API_BASE = '/api';

/** 'unknown' → 'live' | 'demo'. Decided by the first request and then sticky. */
let backend = 'unknown';

export function isDemoMode() {
  return backend === 'demo';
}

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.code = payload?.code || 'unknown';
    this.field = payload?.field;
    this.detail = payload?.detail;
    this.status = status;
  }
}

class BackendUnavailable extends Error {}

function goDemo() {
  if (backend !== 'demo') {
    backend = 'demo';
    document.dispatchEvent(new CustomEvent('addblog:demo-mode'));
  }
  return new BackendUnavailable();
}

async function call(path, { method = 'GET', body, query, headers } = {}) {
  if (backend === 'demo') throw new BackendUnavailable();

  const url = new URL(API_BASE + path, location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw goDemo(); // network failure or offline
  }

  // A static-assets deployment answers /api/* with HTML, not JSON. That is the
  // signal that the Worker is not deployed yet — not an application error.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw goDemo();

  backend = 'live';
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error, response.status);
  return payload;
}

/** Like call(), for a multipart body — a `FormData` body must not get a manual Content-Type (the browser sets the boundary itself), so this doesn't share call()'s JSON-only body handling. */
async function callMultipart(path, formData) {
  if (backend === 'demo') throw new BackendUnavailable();

  const url = new URL(API_BASE + path, location.origin);
  let response;
  try {
    response = await fetch(url, { method: 'POST', body: formData, credentials: 'same-origin' });
  } catch {
    throw goDemo();
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw goDemo();

  backend = 'live';
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error, response.status);
  return payload;
}

/** Run a live call, falling back to the demo implementation if there is no backend. */
async function withFallback(live, fallback) {
  try {
    return await live();
  } catch (error) {
    if (error instanceof BackendUnavailable) return fallback();
    throw error;
  }
}

/* ============================================================================
   Demo store
   Kept in localStorage so edits made in the admin prototype survive navigation.
   Cleared from Settings → Reset demo data.
   ========================================================================= */

const STORE_KEY = 'addblog.demo.v1';
let store = null;

function seed() {
  return {
    posts: demo.POSTS.map((p) => ({ ...p })),
    media: demo.MEDIA.map((m) => ({ ...m })),
    tags: demo.TAGS.map((t) => ({ id: t.slug, description: null, ...t })),
    authors: demo.AUTHORS.map((a) => ({ ...a })),
    settings: { ...demo.SETTINGS },
    activity: demo.ACTIVITY.map((a) => ({ ...a })),
  };
}

function getStore() {
  if (store) return store;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.posts?.length) {
        // `authors` (Phase 5e) postdates this store key — backfill it for
        // anyone whose localStorage predates the field, same as reseeding
        // from scratch would give them, rather than bumping STORE_KEY and
        // discarding every other edit they've made in the demo.
        parsed.authors ||= demo.AUTHORS.map((a) => ({ ...a }));
        store = parsed;
        return store;
      }
    }
  } catch {
    // Corrupt or unavailable storage is not worth failing over — reseed.
  }
  store = seed();
  return store;
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing or a full quota. The in-memory copy still works.
  }
}

export function resetDemoData() {
  store = seed();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch { /* ignore */ }
}

function delay(ms = 120) {
  // A touch of latency so loading states are exercised rather than flashing.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarise(post) {
  const { body_md, body_html, ...rest } = post;
  return rest;
}

function matches(post, { q, tag, status, author }) {
  if (status && status !== 'all' && post.status !== status) return false;
  if (tag && !post.tags.some((t) => t.slug === tag)) return false;
  if (author && post.author?.id !== author) return false;
  if (q) {
    const needle = q.toLowerCase();
    const haystack = `${post.title} ${post.subtitle || ''} ${post.excerpt} ${post.body_md}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const byNewest = (a, b) =>
  String(b.published_at || b.updated_at).localeCompare(String(a.published_at || a.updated_at));

function paginate(items, limit, offset) {
  const start = Number(offset) || 0;
  const size = Number(limit) || 20;
  return {
    data: items.slice(start, start + size),
    page: { limit: size, offset: start, total: items.length, has_more: start + size < items.length },
  };
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/* ============================================================================
   Public API
   ========================================================================= */

export function listPosts({ limit = 10, offset = 0, tag, q } = {}) {
  return withFallback(
    () => call('/posts', { query: { limit, offset, tag, q } }),
    async () => {
      await delay();
      const posts = getStore()
        .posts.filter((p) => p.status === 'published' && matches(p, { q, tag }))
        .sort(byNewest)
        .map(summarise);
      return paginate(posts, limit, offset);
    }
  );
}

export function getPost(slug) {
  return withFallback(
    () => call(`/posts/${encodeURIComponent(slug)}`),
    async () => {
      await delay();
      const posts = getStore().posts;
      const post = posts.find((p) => p.slug === slug && p.status === 'published');
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);

      const tagSlugs = new Set(post.tags.map((t) => t.slug));
      const related = posts
        .filter((p) => p.status === 'published' && p.id !== post.id)
        .map((p) => ({ post: p, score: p.tags.filter((t) => tagSlugs.has(t.slug)).length }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || byNewest(a.post, b.post))
        .slice(0, 3)
        .map((r) => summarise(r.post));

      return { data: { ...post, body_html: renderMarkdown(post.body_md), related } };
    }
  );
}

export function listTags() {
  return withFallback(
    () => call('/tags'),
    async () => {
      await delay(60);
      const counts = new Map();
      for (const post of getStore().posts) {
        if (post.status !== 'published') continue;
        for (const tag of post.tags) {
          counts.set(tag.slug, (counts.get(tag.slug) || 0) + 1);
        }
      }
      const data = getStore().tags.filter((t) => counts.has(t.slug))
        .map((t) => ({ ...t, post_count: counts.get(t.slug) }))
        .sort((a, b) => b.post_count - a.post_count || a.name.localeCompare(b.name));
      return { data };
    }
  );
}

export function getArchive() {
  return withFallback(
    () => call('/archive'),
    async () => {
      await delay();
      const groups = new Map();
      for (const post of getStore().posts.filter((p) => p.status === 'published').sort(byNewest)) {
        const year = String(post.published_at).slice(0, 4);
        if (!groups.has(year)) groups.set(year, []);
        groups.get(year).push({
          slug: post.slug,
          title: post.title,
          published_at: post.published_at,
          reading_minutes: post.reading_minutes,
        });
      }
      return { data: [...groups].map(([year, posts]) => ({ year, posts })) };
    }
  );
}

/* ============================================================================
   Admin API
   ========================================================================= */

export function me() {
  return withFallback(
    () => call('/admin/me'),
    async () => ({ data: demo.CURRENT_USER })
  );
}

export function adminListPosts({ status = 'all', tag, q, sort = 'updated', limit = 50, offset = 0 } = {}) {
  return withFallback(
    () => call('/admin/posts', { query: { status, tag, q, sort, limit, offset } }),
    async () => {
      await delay();
      const posts = getStore()
        .posts.filter((p) => matches(p, { q, tag, status }))
        .sort((a, b) => {
          if (sort === 'oldest') return byNewest(b, a);
          if (sort === 'title') return a.title.localeCompare(b.title);
          if (sort === 'updated') return String(b.updated_at).localeCompare(String(a.updated_at));
          return byNewest(a, b);
        })
        .map(summarise);
      return paginate(posts, limit, offset);
    }
  );
}

export function adminGetPost(id) {
  return withFallback(
    () => call(`/admin/posts/${encodeURIComponent(id)}`),
    async () => {
      await delay(80);
      const post = getStore().posts.find((p) => p.id === id || p.slug === id);
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);
      return { data: post };
    }
  );
}

export function createPost(input) {
  return withFallback(
    () => call('/admin/posts', { method: 'POST', body: input }),
    async () => {
      await delay();
      const state = getStore();
      const title = input.title?.trim() || 'Untitled post';
      const slug = uniqueSlug(input.slug?.trim() || slugify(title) || 'untitled', state.posts);
      const post = {
        id: `p${Date.now().toString(36)}`,
        slug,
        title,
        subtitle: input.subtitle || '',
        body_md: input.body_md || '',
        excerpt: input.excerpt || excerptFrom(input.body_md || '', 190),
        status: 'draft',
        visibility: input.visibility || 'public',
        author: demo.CURRENT_USER,
        author_id: demo.CURRENT_USER.id,
        tags: normaliseTags(input.tags),
        cover_key: input.cover_key || null,
        cover_alt: input.cover_alt || null,
        cover: input.cover_key ? { url: `/media/${input.cover_key}`, alt: input.cover_alt || '' } : null,
        word_count: wordCount(input.body_md || ''),
        reading_minutes: readingMinutes(input.body_md || ''),
        created_at: nowIso(),
        updated_at: nowIso(),
        published_at: null,
        scheduled_for: null,
      };
      state.posts.unshift(post);
      logActivity('post.create', title);
      persist();
      return { data: post };
    }
  );
}

export function updatePost(id, patch, { ifMatch } = {}) {
  return withFallback(
    () => call(`/admin/posts/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch, headers: ifMatch ? { 'If-Match': ifMatch } : undefined,
    }),
    async () => {
      await delay();
      const state = getStore();
      const post = state.posts.find((p) => p.id === id);
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);

      if (patch.slug && patch.slug !== post.slug) {
        const clash = state.posts.some((p) => p.id !== id && p.slug === patch.slug);
        if (clash) {
          throw new ApiError(
            { code: 'slug_taken', message: `The slug “${patch.slug}” is already in use.`, field: 'slug' },
            409
          );
        }
      }

      Object.assign(post, {
        title: patch.title ?? post.title,
        subtitle: patch.subtitle ?? post.subtitle,
        slug: patch.slug ?? post.slug,
        body_md: patch.body_md ?? post.body_md,
        excerpt: patch.excerpt || excerptFrom(patch.body_md ?? post.body_md, 190),
        visibility: patch.visibility ?? post.visibility,
        tags: patch.tags ? normaliseTags(patch.tags) : post.tags,
        cover_key: patch.cover_key !== undefined ? patch.cover_key : post.cover_key,
        cover_alt: patch.cover_alt !== undefined ? patch.cover_alt : post.cover_alt,
        updated_at: nowIso(),
      });
      post.cover = post.cover_key ? { url: `/media/${post.cover_key}`, alt: post.cover_alt || '' } : null;
      post.word_count = wordCount(post.body_md);
      post.reading_minutes = readingMinutes(post.body_md);

      logActivity('post.update', post.title);
      persist();
      return { data: post };
    }
  );
}

export function publishPost(id, scheduledFor) {
  const path = `/admin/posts/${encodeURIComponent(id)}/${scheduledFor ? 'schedule' : 'publish'}`;
  return withFallback(
    () => call(path, { method: 'POST', body: scheduledFor ? { scheduled_for: scheduledFor } : undefined }),
    async () => {
      await delay();
      const post = getStore().posts.find((p) => p.id === id);
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);
      if (scheduledFor) {
        post.status = 'scheduled';
        post.scheduled_for = scheduledFor;
        logActivity('post.schedule', post.title);
      } else {
        post.status = 'published';
        post.scheduled_for = null;
        // published_at is set once and never moved — see docs/architecture.md §3.
        post.published_at = post.published_at || nowIso();
        logActivity('post.publish', post.title);
      }
      post.updated_at = nowIso();
      persist();
      return { data: post };
    }
  );
}

export function unpublishPost(id) {
  return withFallback(
    () => call(`/admin/posts/${encodeURIComponent(id)}/unpublish`, { method: 'POST' }),
    async () => {
      await delay();
      const post = getStore().posts.find((p) => p.id === id);
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);
      post.status = 'draft';
      post.scheduled_for = null;
      post.updated_at = nowIso();
      logActivity('post.unpublish', post.title);
      persist();
      return { data: post };
    }
  );
}

export function unarchivePost(id) {
  return withFallback(
    () => call(`/admin/posts/${encodeURIComponent(id)}/unarchive`, { method: 'POST' }),
    async () => {
      await delay();
      const post = getStore().posts.find((p) => p.id === id);
      if (!post) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);
      post.status = 'draft';
      post.updated_at = nowIso();
      logActivity('post.unarchive', post.title);
      persist();
      return { data: post };
    }
  );
}

/** `hard: true` permanently removes the row (owner-only, enforced server-side) rather than soft-deleting to `archived`. */
export function deletePost(id, { hard = false } = {}) {
  return withFallback(
    () => call(`/admin/posts/${encodeURIComponent(id)}`, { method: 'DELETE', query: { hard: hard ? 'true' : undefined } }),
    async () => {
      await delay();
      const state = getStore();
      const index = state.posts.findIndex((p) => p.id === id);
      if (index === -1) throw new ApiError({ code: 'not_found', message: 'Post not found.' }, 404);
      if (hard) {
        const [removed] = state.posts.splice(index, 1);
        logActivity('post.delete_hard', removed.title);
      } else {
        const post = state.posts[index];
        post.status = 'archived';
        post.updated_at = nowIso();
        logActivity('post.delete', post.title);
      }
      persist();
      return { data: { id, status: hard ? 'deleted' : 'archived' } };
    }
  );
}

export function listMedia({ q, type } = {}) {
  return withFallback(
    () => call('/admin/media', { query: { q, type } }),
    async () => {
      await delay();
      const data = getStore()
        .media.filter((m) => {
          if (type && type !== 'all' && !m.content_type.startsWith(type)) return false;
          if (q && !`${m.filename} ${m.alt}`.toLowerCase().includes(q.toLowerCase())) return false;
          return true;
        })
        .map((m) => ({ ...m, url: `/media/${m.key}` }));
      return { data };
    }
  );
}

const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'application/pdf']);

export function uploadMedia(file, alt) {
  return withFallback(
    () => {
      const formData = new FormData();
      formData.append('file', file);
      if (alt) formData.append('alt', alt);
      return callMultipart('/admin/media', formData);
    },
    async () => {
      if (!UPLOAD_ALLOWED_TYPES.has(file.type)) {
        throw new ApiError({ code: 'unsupported_media_type', message: `"${file.type || 'unknown'}" is not an allowed upload type.` }, 415);
      }
      if (file.size > UPLOAD_MAX_BYTES) {
        throw new ApiError({ code: 'payload_too_large', message: 'Uploads are capped at 25 MB.' }, 413);
      }
      await delay();
      const item = {
        key: `demo/${Date.now().toString(36)}-${slugify(file.name)}`,
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        width: null,
        height: null,
        alt: alt || '',
        checksum: null,
        created_at: nowIso(),
        used_by: 0,
      };
      getStore().media.unshift(item);
      logActivity('media.upload', item.filename);
      persist();
      return { data: { ...item, url: `/media/${item.key}` } };
    }
  );
}

// No demo fallback for either call below — unlike everything else in this
// file, a WordPress import has nothing meaningful to fake against
// localStorage: there's no real source file and nothing durable to write it
// into. assets/js/admin.js checks isDemoMode() (via a me() call) before
// ever offering the import page's upload button, so these only run once a
// live backend is already confirmed.
export function previewImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  return callMultipart('/admin/import/preview', formData);
}

export function runImport(file) {
  const formData = new FormData();
  formData.append('file', file);
  return callMultipart('/admin/import/run', formData);
}

/**
 * The alternative to fetching media over the network — for a host whose bot
 * protection can't be gotten past by any request-side change (confirmed
 * 2026-08-05 against SiteGround's AI Anti-Bot Protection). `mediaFiles` are
 * matched server-side to pending attachments by filename; call `runImport`
 * again afterward to actually create posts against them.
 */
export function uploadImportMedia(file, mediaFiles) {
  const formData = new FormData();
  formData.append('file', file);
  for (const mediaFile of mediaFiles) formData.append('media', mediaFile);
  return callMultipart('/admin/import/media', formData);
}

export function updateMedia(key, patch) {
  return withFallback(
    () => call(`/admin/media/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch }),
    async () => {
      await delay();
      const item = getStore().media.find((m) => m.key === key);
      if (!item) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);
      Object.assign(item, patch);
      persist();
      return { data: { ...item, url: `/media/${item.key}` } };
    }
  );
}

export function deleteMedia(key) {
  return withFallback(
    () => call(`/admin/media/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    async () => {
      await delay();
      const state = getStore();
      const index = state.media.findIndex((m) => m.key === key);
      if (index === -1) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);
      if (state.media[index].used_by > 0) {
        throw new ApiError(
          { code: 'conflict', message: 'This file is used by a post. Remove it from the post first.' },
          409
        );
      }
      const [removed] = state.media.splice(index, 1);
      logActivity('media.delete', removed.filename);
      persist();
      return { data: { key } };
    }
  );
}

function tagPostCount(state, slug) {
  return state.posts.filter((p) => p.tags.some((t) => t.slug === slug)).length;
}

export function adminListTags() {
  return withFallback(
    () => call('/admin/tags'),
    async () => {
      await delay(60);
      const state = getStore();
      const data = state.tags
        .map((t) => ({ ...t, post_count: tagPostCount(state, t.slug) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { data };
    }
  );
}

export function createTag(input) {
  return withFallback(
    () => call('/admin/tags', { method: 'POST', body: input }),
    async () => {
      await delay();
      const state = getStore();
      const name = input.name?.trim() || '';
      if (!name) throw new ApiError({ code: 'bad_request', message: 'name must be 1-40 characters.', field: 'name' }, 400);
      const slug = input.slug?.trim() || slugify(name);
      if (state.tags.some((t) => t.slug === slug)) {
        throw new ApiError({ code: 'conflict', message: `The slug "${slug}" is already in use.`, field: 'slug' }, 409);
      }
      const tag = { id: `t${Date.now().toString(36)}`, slug, name, description: input.description || null };
      state.tags.push(tag);
      logActivity('tag.create', name);
      persist();
      return { data: { ...tag, post_count: 0 } };
    }
  );
}

export function updateTag(id, patch) {
  return withFallback(
    () => call(`/admin/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    async () => {
      await delay();
      const state = getStore();
      const tag = state.tags.find((t) => t.id === id);
      if (!tag) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);

      const nextSlug = patch.slug !== undefined ? patch.slug : tag.slug;
      if (nextSlug !== tag.slug && state.tags.some((t) => t.id !== id && t.slug === nextSlug)) {
        throw new ApiError({ code: 'conflict', message: `The slug "${nextSlug}" is already in use.`, field: 'slug' }, 409);
      }

      const oldSlug = tag.slug;
      Object.assign(tag, {
        name: patch.name !== undefined ? patch.name : tag.name,
        slug: nextSlug,
        description: patch.description !== undefined ? patch.description : tag.description,
      });

      // Posts carry a denormalised copy of each tag ({slug, name}), same as
      // the real schema's post_tags → tags join collapsed client-side — a
      // rename has to walk every post to stay consistent, not just the tag row.
      for (const post of state.posts) {
        for (const t of post.tags) {
          if (t.slug === oldSlug) {
            t.slug = tag.slug;
            t.name = tag.name;
          }
        }
      }

      logActivity('tag.update', tag.name);
      persist();
      return { data: { ...tag, post_count: tagPostCount(state, tag.slug) } };
    }
  );
}

export function deleteTag(id) {
  return withFallback(
    () => call(`/admin/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async () => {
      await delay();
      const state = getStore();
      const index = state.tags.findIndex((t) => t.id === id);
      if (index === -1) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);
      const [removed] = state.tags.splice(index, 1);
      for (const post of state.posts) {
        post.tags = post.tags.filter((t) => t.slug !== removed.slug);
      }
      logActivity('tag.delete', removed.name);
      persist();
      return { data: { id } };
    }
  );
}

export function mergeTags(fromSlugs, intoSlug) {
  return withFallback(
    () => call('/admin/tags/merge', { method: 'POST', body: { from: fromSlugs, into: intoSlug } }),
    async () => {
      await delay();
      const state = getStore();
      const into = state.tags.find((t) => t.slug === intoSlug);
      const missing = [intoSlug, ...fromSlugs].filter((slug) => !state.tags.some((t) => t.slug === slug));
      if (missing.length) {
        throw new ApiError({ code: 'not_found', message: `Unknown tag slug(s): ${missing.join(', ')}.` }, 404);
      }

      const fromSet = new Set(fromSlugs.filter((slug) => slug !== intoSlug));
      for (const post of state.posts) {
        if (!post.tags.some((t) => fromSet.has(t.slug))) continue;
        post.tags = post.tags.filter((t) => !fromSet.has(t.slug));
        if (!post.tags.some((t) => t.slug === intoSlug)) {
          post.tags.push({ slug: into.slug, name: into.name });
        }
      }
      state.tags = state.tags.filter((t) => !fromSet.has(t.slug));

      logActivity('tag.merge', into.name);
      persist();
      return { data: { ...into, post_count: tagPostCount(state, into.slug) } };
    }
  );
}

function authorPostCount(state, authorId) {
  return state.posts.filter((p) => p.author_id === authorId).length;
}

/** Owners who could still sign in, other than `excludeId` — mirrors src/admin-db.js's countActiveOwners so the last-owner guard behaves the same in demo mode as against live D1. */
function activeOwnerCount(state, excludeId) {
  return state.authors.filter((a) => a.role === 'owner' && !a.disabled && a.id !== excludeId).length;
}

function assertNotLastOwner(state, author, action) {
  if (author.role !== 'owner' || author.disabled) return;
  if (activeOwnerCount(state, author.id) === 0) {
    throw new ApiError({ code: 'conflict', message: `Can't ${action} the only remaining owner — promote someone else first.` }, 409);
  }
}

/** Mirrors src/admin-authors.js's assertNotSelf — cutting off your own access isn't a click you make on your own row, even in demo mode. */
function assertNotSelf(id, action) {
  if (id === demo.CURRENT_USER.id) {
    throw new ApiError({ code: 'conflict', message: `Can't ${action} your own account — ask another owner to do it.` }, 409);
  }
}

export function adminListAuthors() {
  return withFallback(
    () => call('/admin/authors'),
    async () => {
      await delay(60);
      const state = getStore();
      const data = state.authors
        .map((a) => ({ ...a, post_count: authorPostCount(state, a.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { data };
    }
  );
}

export function createAuthor(input) {
  return withFallback(
    () => call('/admin/authors', { method: 'POST', body: input }),
    async () => {
      await delay();
      const state = getStore();
      const name = input.name?.trim() || '';
      if (!name) throw new ApiError({ code: 'bad_request', message: 'name must be 1-100 characters.', field: 'name' }, 400);
      const email = (input.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError({ code: 'bad_request', message: 'email must be a valid email address.', field: 'email' }, 400);
      }
      if (state.authors.some((a) => a.email === email)) {
        throw new ApiError({ code: 'conflict', message: `"${email}" already has an author row.`, field: 'email' }, 409);
      }
      const author = {
        id: `a${Date.now().toString(36)}`,
        name,
        email,
        role: input.role || 'author',
        bio: input.bio || null,
        avatar: null,
        disabled: false,
        created_at: nowIso(),
      };
      state.authors.push(author);
      logActivity('author.create', name);
      persist();
      return { data: { ...author, post_count: 0 } };
    }
  );
}

export function updateAuthor(id, patch) {
  return withFallback(
    () => call(`/admin/authors/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    async () => {
      await delay();
      const state = getStore();
      const author = state.authors.find((a) => a.id === id);
      if (!author) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);

      if (patch.email !== undefined) {
        const email = patch.email.trim().toLowerCase();
        if (state.authors.some((a) => a.id !== id && a.email === email)) {
          throw new ApiError({ code: 'conflict', message: `"${email}" already has an author row.`, field: 'email' }, 409);
        }
        patch = { ...patch, email };
      }
      if (patch.role !== undefined && patch.role !== 'owner') assertNotLastOwner(state, author, 'change the role of');
      if (patch.disabled === true) {
        assertNotSelf(id, 'disable');
        assertNotLastOwner(state, author, 'disable');
      }

      Object.assign(author, patch);

      logActivity('author.update', author.name);
      persist();
      return { data: { ...author, post_count: authorPostCount(state, author.id) } };
    }
  );
}

export function deleteAuthor(id) {
  return withFallback(
    () => call(`/admin/authors/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async () => {
      await delay();
      const state = getStore();
      const index = state.authors.findIndex((a) => a.id === id);
      if (index === -1) throw new ApiError({ code: 'not_found', message: 'Not found.' }, 404);
      const [removed] = state.authors[index] ? [state.authors[index]] : [];
      assertNotSelf(id, 'delete');
      assertNotLastOwner(state, removed, 'delete');

      const actingOwner = state.authors.find((a) => a.id === demo.CURRENT_USER.id) || demo.CURRENT_USER;
      for (const post of state.posts) {
        if (post.author_id === id) {
          post.author_id = actingOwner.id;
          post.author = actingOwner;
        }
      }
      state.authors.splice(index, 1);

      logActivity('author.delete', removed.name);
      persist();
      return { data: { id } };
    }
  );
}

export function getSettings() {
  return withFallback(
    () => call('/admin/settings'),
    async () => ({ data: getStore().settings })
  );
}

export function saveSettings(values) {
  return withFallback(
    () => call('/admin/settings', { method: 'PUT', body: values }),
    async () => {
      await delay();
      Object.assign(getStore().settings, values);
      logActivity('settings.update', 'Blog settings');
      persist();
      return { data: getStore().settings };
    }
  );
}

export function getStats() {
  return withFallback(
    () => call('/admin/stats'),
    async () => {
      await delay(60);
      const posts = getStore().posts;
      const count = (status) => posts.filter((p) => p.status === status).length;
      return {
        data: {
          published: count('published'),
          draft: count('draft'),
          scheduled: count('scheduled'),
          archived: count('archived'),
          words: posts.reduce((sum, p) => sum + p.word_count, 0),
          media: getStore().media.length,
          next_scheduled: posts
            .filter((p) => p.status === 'scheduled')
            .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))[0] || null,
        },
      };
    }
  );
}

export function getActivity(limit = 8) {
  return withFallback(
    () => call('/admin/audit', { query: { limit } }),
    async () => ({ data: getStore().activity.slice(0, limit) })
  );
}

/** The full, filterable/paginated audit log (#12) — getActivity above stays as the dashboard widget's simpler 7-row call, unchanged. */
export function getAudit({ actor, action, via, limit = 20, offset = 0 } = {}) {
  return withFallback(
    () => call('/admin/audit', { query: { actor, action, via, limit, offset } }),
    async () => {
      await delay(60);
      const filtered = getStore().activity.filter(
        (entry) =>
          (!actor || entry.actor === actor) &&
          (!action || entry.action === action) &&
          (!via || entry.via === via)
      );
      const total = filtered.length;
      return {
        data: filtered.slice(offset, offset + limit),
        page: { limit, offset, total, has_more: offset + limit < total },
      };
    }
  );
}

export function previewMarkdown(bodyMd) {
  // Rendered locally on purpose: the preview must stay responsive per keystroke.
  // Phase 5 adds POST /api/admin/preview for a server-authoritative render on save.
  return renderMarkdown(bodyMd);
}

/* --- Helpers -------------------------------------------------------------- */

function uniqueSlug(base, posts) {
  let slug = base;
  let n = 2;
  while (posts.some((p) => p.slug === slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function normaliseTags(tags) {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  return list
    .map((t) => (typeof t === 'string' ? t.trim() : t?.name || ''))
    .filter(Boolean)
    .slice(0, 10)
    .map((name) => {
      const slug = slugify(name);
      return getStore().tags.find((t) => t.slug === slug) || { slug, name };
    });
}

function logActivity(action, detail) {
  getStore().activity.unshift({
    at: nowIso(),
    actor: demo.CURRENT_USER.email,
    via: 'ui',
    action,
    detail,
  });
  getStore().activity.length = Math.min(getStore().activity.length, 40);
}

export { demo };
