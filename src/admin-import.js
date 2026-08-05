/**
 * WordPress WXR import (Phase 7) — docs/implementation-plan.md's Phase 7
 * "WordPress import (WXR)" section records the scoping decisions this
 * follows: posts + media only (no pages, no comments, categories merge into
 * tags), hand-rolled lossy HTML→Markdown, fetch-and-reupload media with
 * failures reported rather than blocking, WXR author records ignored in
 * favor of the importing admin, any non-`publish` WP status becomes
 * `draft`, dry-run + skip-on-duplicate-slug, owner-only.
 *
 * `buildImportPlan` is pure (DB reads only, for duplicate-slug and tag
 * checks — no network, no writes) so the preview and real-run routes share
 * one planning pass and can never disagree about what a run *would* do.
 * `executeImportPlan` is the only place that fetches media or writes to D1.
 */

import { excerptFrom, readingMinutes, renderMarkdown, slugify, wordCount } from '../assets/js/markdown.js';
import {
  getMediaByChecksum,
  getTagBySlug,
  insertMedia,
  insertPost,
  insertRevision,
  setPostTags,
  slugExists,
} from './admin-db.js';
import { apiFail, requirePermission, requireSameOrigin, withErrors } from './admin-http.js';
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES } from './admin-media.js';
import { writeAuditLog } from './audit.js';
import { htmlToMarkdown } from './import-html-to-md.js';
import { parseWxr } from './import-wxr.js';
import { buildMediaKey, detectDimensions, sanitizeFilename, sha256Hex } from './media-parse.js';
import { fetchMediaFromUrl } from './mcp-media-fetch.js';
import { validateBodyMd } from './validate.js';

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function resolveSlug(item) {
  const candidate = (item.slug || '').toLowerCase();
  if (SLUG_RE.test(candidate)) return candidate;
  return slugify(item.title) || slugify(String(item.postId || 'post'));
}

/** category + post_tag terms merged into one tag-name list, de-duplicated by slug (post_format/nav_menu/etc. terms are ignored — not real content taxonomies). */
function mergedTagNames(item) {
  const seen = new Set();
  const names = [];
  for (const term of item.terms) {
    if (term.taxonomy !== 'category' && term.taxonomy !== 'post_tag') continue;
    const name = term.name.trim();
    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    names.push(name);
  }
  return names;
}

/**
 * Reads current D1 state (existing slugs, existing tags) against the parsed
 * WXR to produce an execution plan. No fetches, no writes — safe to call
 * for a preview and then call again for the real run.
 */
export async function buildImportPlan(db, parsed) {
  const posts = parsed.items.filter((i) => i.postType === 'post');
  const pages = parsed.items.filter((i) => i.postType === 'page');
  const attachments = parsed.items.filter((i) => i.postType === 'attachment' && i.attachmentUrl);

  const postsToImport = [];
  let postsSkippedDuplicate = 0;
  const tagsToCreate = new Set();
  const tagsToReuse = new Set();

  for (const item of posts) {
    const slug = resolveSlug(item);
    if (await slugExists(db, slug)) {
      postsSkippedDuplicate += 1;
      continue;
    }
    const tagNames = mergedTagNames(item);
    for (const name of tagNames) {
      const existing = await getTagBySlug(db, slugify(name));
      (existing ? tagsToReuse : tagsToCreate).add(name);
    }
    postsToImport.push({ item, slug, tagNames });
  }

  return {
    site: parsed.site,
    postsToImport,
    postsSkippedDuplicate,
    pagesDropped: pages.map((p) => ({ title: p.title, link: p.link })),
    mediaToFetch: attachments.map((item) => ({
      postId: item.postId,
      url: item.attachmentUrl,
      alt: item.postmeta._wp_attachment_image_alt || null,
    })),
    // Every post's old permalink, whether or not it ends up imported this
    // run — a link inside content might point at a post already imported
    // by a previous run of this same file.
    postLinksForRewrite: posts.map((p) => ({ link: p.link, slug: resolveSlug(p) })).filter((p) => p.link),
    pageLinksForRewrite: pages.map((p) => p.link).filter(Boolean),
    tagsPreview: { toCreate: [...tagsToCreate], toReuse: [...tagsToReuse] },
  };
}

function normalizeLink(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Builds the `rewriteUrl` callback `htmlToMarkdown` calls per `href`/`src`,
 * plus the shared `report` object it records rewrite outcomes into. Used by
 * both the preview (with a placeholder media map, since nothing's been
 * fetched yet) and the real run (with the map of actually-uploaded media) —
 * one classification path, not two that could disagree.
 */
function buildRewriter(plan, attachmentByUrl, report) {
  let siteHost = null;
  try {
    siteHost = plan.site.url ? new URL(plan.site.url).host : null;
  } catch {
    siteHost = null;
  }

  const postLinkMap = new Map(plan.postLinksForRewrite.map((p) => [normalizeLink(p.link), `/posts/${p.slug}`]));
  const pageLinkSet = new Set(plan.pageLinksForRewrite.map(normalizeLink));
  const state = { currentSlug: null };

  const rewriteUrl = (rawUrl) => {
    if (!rawUrl) return rawUrl;
    let parsed;
    try {
      parsed = new URL(rawUrl, plan.site.url || undefined);
    } catch {
      return rawUrl;
    }
    if (!siteHost || parsed.host !== siteHost) return rawUrl; // not the old site's own host — an external citation, left untouched

    // WordPress-generated size variants (…-300x200.jpg) point at the same original upload.
    const bareUrl = parsed.href.replace(/-\d+x\d+(?=\.[a-zA-Z0-9]+$)/, '');
    const media = attachmentByUrl.get(parsed.href) || attachmentByUrl.get(bareUrl);
    if (media) {
      report.links_rewritten += 1;
      return media.newUrl;
    }

    const postUrl = postLinkMap.get(normalizeLink(parsed.href));
    if (postUrl) {
      report.links_rewritten += 1;
      return postUrl;
    }

    if (pageLinkSet.has(normalizeLink(parsed.href))) {
      report.links_to_dropped_pages.push({ post_slug: state.currentSlug, target_url: rawUrl });
      return rawUrl; // left as the old, now-broken URL — reported, not silently swallowed
    }

    report.links_unresolved.push({ post_slug: state.currentSlug, target_url: rawUrl });
    return rawUrl;
  };

  return { rewriteUrl, state };
}

/**
 * The dry-run report. Runs real content conversion (discarding the
 * resulting Markdown) so link classification is exactly what a real run
 * would do — but makes no network calls, so a dead attachment link only
 * surfaces in the real run's report, not here.
 */
export function previewReport(plan) {
  const report = { links_rewritten: 0, links_to_dropped_pages: [], links_unresolved: [] };
  const attachmentByUrl = new Map(plan.mediaToFetch.map((m) => [m.url, { newUrl: '(pending)' }]));
  const { rewriteUrl, state } = buildRewriter(plan, attachmentByUrl, report);

  for (const planned of plan.postsToImport) {
    state.currentSlug = planned.slug;
    htmlToMarkdown(planned.item.contentHtml, { rewriteUrl });
  }

  return {
    site: plan.site,
    posts_to_create: plan.postsToImport.length,
    posts_skipped_duplicate: plan.postsSkippedDuplicate,
    pages_dropped: plan.pagesDropped,
    media_to_fetch: plan.mediaToFetch.length,
    tags_to_create: plan.tagsPreview.toCreate,
    tags_to_reuse: plan.tagsPreview.toReuse,
    links_to_dropped_pages: report.links_to_dropped_pages,
    links_unresolved: report.links_unresolved,
  };
}

async function fetchAndUploadAttachment(att, { db, mediaBucket, identity }) {
  const { bytes, contentType } = await fetchMediaFromUrl(att.url, { allowedTypes: ALLOWED_TYPES, maxBytes: MAX_UPLOAD_BYTES });
  const checksum = await sha256Hex(bytes);

  // Content-addressed dedupe (same as a direct upload) — makes re-running
  // an import against already-uploaded media a no-op for free.
  const existing = await getMediaByChecksum(db, checksum);
  if (existing) return existing.key;

  const filename = sanitizeFilename(decodeURIComponent(att.url.split('/').pop() || 'upload'));
  const now = new Date();
  const key = buildMediaKey(now, checksum, filename);
  const dimensions = detectDimensions(bytes, contentType) || {};

  await mediaBucket.put(key, bytes, { httpMetadata: { contentType } });
  await insertMedia(db, {
    key,
    filename,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    alt: att.alt,
    checksum,
    uploaded_by: identity.author.id,
    created_at: now.toISOString(),
  });
  return key;
}

/** WXR dates are "YYYY-MM-DD HH:MM:SS" GMT, or the "0000-00-00 00:00:00" null sentinel — invalid/null collapses to `null` so the caller falls back to now. */
function toIso(wpDate) {
  if (!wpDate || wpDate.startsWith('0000-00-00')) return null;
  const date = new Date(`${wpDate.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Does the real work: attachments first (so post content can be rewritten
 * to point at them), then posts. A failure on one item — a dead media
 * link, content that fails validation — is caught and reported per item;
 * it never aborts the rest of the run.
 */
export async function executeImportPlan(plan, { db, mediaBucket, identity }) {
  const report = {
    posts_created: 0,
    posts_skipped: plan.postsSkippedDuplicate,
    posts_failed: [],
    media_uploaded: 0,
    media_failed: [],
    links_rewritten: 0,
    links_to_dropped_pages: [],
    links_unresolved: [],
  };

  const attachmentByUrl = new Map();
  const attachmentByPostId = new Map();
  for (const att of plan.mediaToFetch) {
    try {
      const key = await fetchAndUploadAttachment(att, { db, mediaBucket, identity });
      const newUrl = `/media/${key}`;
      attachmentByUrl.set(att.url, { newUrl });
      attachmentByPostId.set(att.postId, { newKey: key });
      report.media_uploaded += 1;
    } catch (err) {
      report.media_failed.push({ url: att.url, reason: err.message || 'fetch failed' });
    }
  }

  const { rewriteUrl, state } = buildRewriter(plan, attachmentByUrl, report);

  for (const { item, slug, tagNames } of plan.postsToImport) {
    // Re-checked live — preview and run are separate requests, and a
    // second run of the same file should still skip cleanly.
    if (await slugExists(db, slug)) {
      report.posts_skipped += 1;
      continue;
    }

    state.currentSlug = slug;
    let bodyMd;
    try {
      bodyMd = htmlToMarkdown(item.contentHtml, { rewriteUrl });
      validateBodyMd(bodyMd);
    } catch (err) {
      report.posts_failed.push({ slug, reason: err.message || 'content conversion failed' });
      continue;
    }

    const cover = item.postmeta._thumbnail_id ? attachmentByPostId.get(item.postmeta._thumbnail_id) : null;
    const status = item.status === 'publish' ? 'published' : 'draft';
    const createdAt = toIso(item.dateGmt) || new Date().toISOString();
    const updatedAt = toIso(item.modifiedGmt) || createdAt;

    const post = {
      id: crypto.randomUUID(),
      slug,
      title: item.title || slug,
      subtitle: null,
      excerpt: excerptFrom(bodyMd, 190),
      body_md: bodyMd,
      body_html: renderMarkdown(bodyMd),
      status,
      visibility: 'public',
      author_id: identity.author.id,
      cover_key: cover?.newKey || null,
      cover_alt: null,
      canonical_url: null,
      word_count: wordCount(bodyMd),
      reading_minutes: readingMinutes(bodyMd),
      created_at: createdAt,
      updated_at: updatedAt,
      published_at: status === 'published' ? createdAt : null,
      scheduled_for: null,
    };

    await insertPost(db, post);
    if (tagNames.length) await setPostTags(db, post.id, tagNames);
    await insertRevision(db, { postId: post.id, title: post.title, bodyMd, authorId: identity.author.id, note: 'import' });
    await writeAuditLog(db, {
      actor: identity.email, via: 'import', action: 'post.create', entity: 'post', entityId: post.id,
      detail: { title: post.title, slug, source: 'wxr' },
    });
    report.posts_created += 1;
  }

  return report;
}

async function readWxrFile(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('multipart/form-data')) apiFail(400, 'bad_request', 'Expected multipart/form-data.');

  let formData;
  try {
    formData = await request.formData();
  } catch {
    apiFail(400, 'bad_request', 'Malformed multipart body.');
  }

  const file = formData.get('file');
  if (!file || typeof file.text !== 'function') apiFail(400, 'bad_request', 'A "file" field is required.', { field: 'file' });

  const text = await file.text();
  if (!text.includes('<channel') || !text.includes('<rss')) {
    apiFail(400, 'bad_request', "This doesn't look like a WordPress WXR export.", { field: 'file' });
  }
  return text;
}

async function previewHandler(request, env, identity) {
  requirePermission(identity, 'import.wxr');
  const parsed = parseWxr(await readWxrFile(request));
  const plan = await buildImportPlan(env.DB, parsed);
  return Response.json({ data: previewReport(plan) });
}

async function runHandler(request, env, identity) {
  requirePermission(identity, 'import.wxr');
  const parsed = parseWxr(await readWxrFile(request));
  const plan = await buildImportPlan(env.DB, parsed);
  const report = await executeImportPlan(plan, { db: env.DB, mediaBucket: env.MEDIA, identity });
  return Response.json({ data: report });
}

export async function handleImportApi(request, url, ctxBundle) {
  const { env, identity } = ctxBundle;
  if (!identity || !env.DB || !env.MEDIA) return null;
  if (!url.pathname.startsWith('/api/admin/import/')) return null;

  return withErrors(async () => {
    requireSameOrigin(request, url);
    if (request.method !== 'POST') return null;

    if (url.pathname === '/api/admin/import/preview') return previewHandler(request, env, identity);
    if (url.pathname === '/api/admin/import/run') return runHandler(request, env, identity);
    return null;
  });
}
