/**
 * Markdown editor.
 *
 * EasyMDE (loaded from a CDN in admin/editor/index.html, no build step)
 * progressively enhances the #body textarea: toolbar, live/side-by-side
 * preview, keyboard shortcuts. It still edits and returns plain Markdown —
 * body_md stays the source of truth, and the preview is rendered by the same
 * module the Worker will use at write time, so what you see is what gets
 * stored.
 *
 * Two behaviours worth knowing about:
 *  - The slug follows the title until you edit it, then it stops following.
 *    Renaming a published post never silently changes its URL.
 *  - Saving sends the version we loaded. If the post changed underneath us the
 *    API answers 409 and we prompt, rather than overwriting someone's work.
 */

import * as api from './api.js';
import { toast, statusBadge } from './admin.js';
import { el, clear, append, icon, formatDateTime } from './main.js';
import { renderMarkdown, slugify, wordCount, readingMinutes } from './markdown.js';

const params = new URLSearchParams(location.search);
const postId = params.get('id');

const dom = {
  title: document.querySelector('[data-field="title"]'),
  subtitle: document.querySelector('[data-field="subtitle"]'),
  body: document.querySelector('[data-field="body"]'),
  slug: document.querySelector('[data-field="slug"]'),
  excerpt: document.querySelector('[data-field="excerpt"]'),
  saveState: document.querySelector('[data-save-state]'),
  counts: document.querySelector('[data-counts]'),
  statusSlot: document.querySelector('[data-status-slot]'),
  actions: document.querySelector('[data-actions]'),
  tagHost: document.querySelector('[data-tags]'),
  schedule: document.querySelector('[data-field="scheduled_for"]'),
  heading: document.querySelector('[data-editor-heading]'),
};

const state = {
  post: null,
  tags: [],
  slugLocked: false,
  dirty: false,
  saving: false,
};

let mde;

/* --- Save state indicator ------------------------------------------------- */

const SAVE_LABELS = {
  idle: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

function setSaveState(key) {
  dom.saveState.dataset.state = key;
  append(clear(dom.saveState),
    key === 'saved' ? icon('check') : null,
    el('span', { text: SAVE_LABELS[key] })
  );
}

function markDirty() {
  state.dirty = true;
  setSaveState('dirty');
  scheduleAutosave();
}

/* --- Editor ----------------------------------------------------------------
 * EasyMDE owns the toolbar and the write/preview/side-by-side views. Its
 * previewRender hook is wired to our own renderMarkdown so the editor preview
 * and the published post are always built from identical rendering code.
 * ---------------------------------------------------------------------- */

function createEditor() {
  mde = new EasyMDE({
    element: dom.body,
    autofocus: false,
    spellChecker: false,
    nativeSpellcheck: true,
    status: false,
    autosave: { enabled: false },
    tabSize: 2,
    indentWithTabs: false,
    placeholder: 'Write in Markdown…',
    toolbar: [
      'bold', 'italic', 'strikethrough', '|',
      'heading-1', 'heading-2', 'heading-3', '|',
      'quote', 'unordered-list', 'ordered-list', '|',
      'link', 'table', 'horizontal-rule', '|',
      'preview', 'side-by-side', 'fullscreen', '|',
      'guide',
    ],
    previewRender(markdown, previewEl) {
      previewEl.classList.add('prose');
      return renderMarkdown(markdown);
    },
  });

  mde.codemirror.on('change', () => {
    refreshCounts();
    markDirty();
  });
}

function refreshCounts() {
  const markdown = mde.value();
  const words = wordCount(markdown);
  clear(dom.counts).append(
    el('span', { text: `${words.toLocaleString()} word${words === 1 ? '' : 's'}` }),
    el('span', { text: `${readingMinutes(markdown)} min read` }),
    el('span', { text: `${markdown.length.toLocaleString()} characters` })
  );
}

/* --- Tags ----------------------------------------------------------------- */

function renderTags() {
  const input = el('input', {
    type: 'text',
    placeholder: state.tags.length ? 'Add tag…' : 'cloudflare, workers…',
    'aria-label': 'Add a tag',
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        addTag(event.target.value);
        event.target.value = '';
      } else if (event.key === 'Backspace' && !event.target.value && state.tags.length) {
        state.tags.pop();
        renderTags();
        markDirty();
      }
    },
    onBlur: (event) => {
      if (event.target.value.trim()) {
        addTag(event.target.value);
        event.target.value = '';
      }
    },
  });

  clear(dom.tagHost).append(
    ...state.tags.map((tag) =>
      el('span', { class: 'token' }, [
        tag.name,
        el('button', {
          type: 'button',
          'aria-label': `Remove tag ${tag.name}`,
          text: '×',
          onClick: () => {
            state.tags = state.tags.filter((t) => t.slug !== tag.slug);
            renderTags();
            markDirty();
          },
        }),
      ])
    ),
    input
  );
  return input;
}

function addTag(raw) {
  const name = raw.trim().replace(/,$/, '');
  if (!name) return;
  const slug = slugify(name);
  if (!slug || state.tags.some((t) => t.slug === slug)) return;
  if (state.tags.length >= 10) {
    toast('Ten tags is the limit.', 'error');
    return;
  }
  state.tags.push({ slug, name });
  renderTags().focus();
  markDirty();
}

/* --- Load ----------------------------------------------------------------- */

function fill(post) {
  state.post = post;
  state.tags = [...(post.tags || [])];
  state.slugLocked = Boolean(post.slug);

  dom.title.value = post.title || '';
  dom.subtitle.value = post.subtitle || '';
  mde.value(post.body_md || '');
  dom.slug.value = post.slug || '';
  dom.excerpt.value = post.excerpt || '';
  if (post.scheduled_for) dom.schedule.value = post.scheduled_for.slice(0, 16);

  dom.heading.textContent = post.id ? 'Edit post' : 'New post';
  renderTags();
  refreshCounts();
  paintStatus();
  setSaveState('idle');
  state.dirty = false;
}

function paintStatus() {
  const post = state.post;
  append(clear(dom.statusSlot),
    statusBadge(post.status || 'draft'),
    post.published_at
      ? el('span', { class: 'small muted', text: `Published ${formatDateTime(post.published_at)}` })
      : null,
    post.status === 'scheduled' && post.scheduled_for
      ? el('span', { class: 'small muted', text: `Goes live ${formatDateTime(post.scheduled_for)}` })
      : null
  );
  paintActions();
}

function paintActions() {
  const post = state.post;
  append(clear(dom.actions),
    el('button', { class: 'btn', type: 'button', text: 'Save draft', onClick: () => save({ notify: true }) }),
    post.status === 'published'
      ? el('button', {
          class: 'btn', type: 'button', text: 'Unpublish',
          onClick: () => transition((id) => api.unpublishPost(id), 'Unpublished'),
        })
      : el('button', {
          class: 'btn btn--primary', type: 'button', text: 'Publish now',
          onClick: () => transition((id) => api.publishPost(id), 'Published'),
        }),
    post.status === 'published' && post.slug
      ? el('a', {
          class: 'btn btn--ghost',
          href: `/post/?slug=${encodeURIComponent(post.slug)}`,
          target: '_blank', rel: 'noopener', text: 'View',
        })
      : null
  );
}

/**
 * Save pending edits, then run a status change. `fn` receives the post id at
 * call time rather than closing over it — a brand new post has no id until the
 * save above has run.
 */
async function transition(fn, message) {
  if (state.dirty) await save({ notify: false });
  if (!state.post.id) {
    toast('Give the post a title and save it first.', 'error');
    return;
  }
  try {
    const { data } = await fn(state.post.id);
    state.post = { ...state.post, ...data };
    paintStatus();
    toast(message);
  } catch (error) {
    toast(error.message || 'That did not work.', 'error');
  }
}

/* --- Save ----------------------------------------------------------------- */

let autosaveTimer;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (state.dirty && state.post?.id) save({ notify: false });
  }, 2500);
}

function collect() {
  return {
    title: dom.title.value.trim(),
    subtitle: dom.subtitle.value.trim(),
    slug: dom.slug.value.trim(),
    excerpt: dom.excerpt.value.trim(),
    body_md: mde.value(),
    tags: state.tags.map((t) => t.name),
  };
}

async function save({ notify = false } = {}) {
  if (state.saving) return;
  const input = collect();

  if (!input.title) {
    toast('A post needs a title before it can be saved.', 'error');
    dom.title.focus();
    return;
  }

  state.saving = true;
  setSaveState('saving');
  clearTimeout(autosaveTimer);

  try {
    const { data } = state.post.id
      ? await api.updatePost(state.post.id, input)
      : await api.createPost(input);

    state.post = data;
    state.dirty = false;
    setSaveState('saved');
    if (notify) toast('Saved');

    if (!params.get('id')) {
      // First save of a new post — put the id in the URL so a refresh keeps it.
      params.set('id', data.id);
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
    dom.slug.value = data.slug;
    paintStatus();
    setTimeout(() => { if (!state.dirty) setSaveState('idle'); }, 1800);
  } catch (error) {
    setSaveState('error');
    if (error.code === 'slug_taken') {
      dom.slug.focus();
      dom.slug.select();
    }
    toast(error.message || 'Could not save.', 'error');
  } finally {
    state.saving = false;
  }
}

/* --- Wiring --------------------------------------------------------------- */

function wire() {
  dom.title.addEventListener('input', () => {
    if (!state.slugLocked) dom.slug.value = slugify(dom.title.value);
    markDirty();
  });

  dom.slug.addEventListener('input', () => {
    state.slugLocked = true;
    markDirty();
  });
  dom.slug.addEventListener('blur', () => {
    const cleaned = slugify(dom.slug.value);
    if (cleaned !== dom.slug.value) dom.slug.value = cleaned;
  });

  for (const field of [dom.subtitle, dom.excerpt]) {
    field.addEventListener('input', markDirty);
  }

  document.querySelector('[data-schedule-button]')?.addEventListener('click', () => {
    const when = dom.schedule.value;
    if (!when) {
      toast('Pick a date and time first.', 'error');
      return;
    }
    if (new Date(when) <= new Date()) {
      toast('Scheduled time has to be in the future.', 'error');
      return;
    }
    transition((id) => api.publishPost(id, new Date(when).toISOString()), 'Scheduled');
  });

  // EasyMDE owns bold/italic/link/etc. shortcuts; Ctrl/Cmd+S is ours, and has
  // to be document-level since focus usually lives inside CodeMirror.
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    save({ notify: true });
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/* --- Init ----------------------------------------------------------------- */

async function init() {
  createEditor();
  wire();

  if (!postId) {
    fill({ status: 'draft', tags: [], body_md: '', title: '' });
    dom.title.focus();
    return;
  }

  try {
    const { data } = await api.adminGetPost(postId);
    fill(data);
  } catch (error) {
    toast(error.message || 'Could not load that post.', 'error');
    fill({ status: 'draft', tags: [], body_md: '', title: '' });
  }
}

init();
