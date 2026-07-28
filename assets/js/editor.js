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
    // EasyMDE's toolbar icons are Font Awesome glyphs, and by default it
    // injects an *unpinned* `.../latest/...` Font Awesome stylesheet from
    // maxcdn.bootstrapcdn.com at runtime if it doesn't detect FA already
    // present — a surprise third CDN the CSP (src/index.js) rightly blocks,
    // and an unpinned version we wouldn't want even if it were allowed. We
    // load a pinned Font Awesome 4.7.0 ourselves instead, from the same
    // jsdelivr origin as EasyMDE (see admin/editor/index.html), and tell it
    // not to fetch its own.
    autoDownloadFontAwesome: false,
    // Trimmed from EasyMDE's own default set: table, horizontal-rule and
    // strikethrough are rare enough in a blog post that they weren't worth
    // the width — at the editor's actual column width (narrower than the
    // full viewport, thanks to the aside) a longer list wraps mid-group and
    // orphans a single button on its own row instead of wrapping cleanly.
    toolbar: [
      'bold', 'italic', '|',
      'heading-1', 'heading-2', 'heading-3', '|',
      'quote', 'unordered-list', 'ordered-list', 'link', '|',
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

/* --- Tags -------------------------------------------------------------------
 * Free-text entry made it easy to create a near-duplicate of a tag that
 * already exists ("cloud flare" next to "Cloudflare") — the admin Tags page
 * (Phase 5d) has a merge tool specifically for cleaning that up after the
 * fact. This suggests from the real pool instead, so an author sees an
 * existing tag before typing a close cousin of it. Suggestions only —
 * typing something genuinely new and pressing Enter still creates it, same
 * as before; the pool guides, it doesn't gate.
 * ---------------------------------------------------------------------- */

let tagPool = [];

async function loadTagPool() {
  try {
    const { data } = await api.adminListTags();
    tagPool = data;
  } catch {
    // Suggestions are a nicety, not a requirement — free-text entry below
    // still works with an empty pool.
  }
}

function matchingTags(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const chosen = new Set(state.tags.map((t) => t.slug));
  return tagPool
    .filter((t) => !chosen.has(t.slug) && t.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.name.toLowerCase().indexOf(q);
      const bi = b.name.toLowerCase().indexOf(q);
      return ai - bi || a.name.localeCompare(b.name);
    })
    .slice(0, 8);
}

function renderTags() {
  let matches = [];
  let activeIndex = -1;

  const list = el('ul', { class: 'tag-suggestions', role: 'listbox', id: 'tag-suggestions' });
  list.hidden = true;

  function closeList() {
    matches = [];
    activeIndex = -1;
    list.hidden = true;
    clear(list);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function paintList() {
    clear(list).append(
      ...matches.map((tag, i) =>
        el('li', {
          id: `tag-option-${tag.slug}`,
          role: 'option',
          'aria-selected': String(i === activeIndex),
          onMousedown: (event) => {
            // preventDefault keeps focus in the input, so this fires
            // instead of the blur handler below committing the raw text.
            // Value has to be cleared *before* addTag() — it rebuilds this
            // whole widget and removes the still-focused input from the DOM,
            // which synchronously re-fires blur on it; clearing first makes
            // that reentrant blur see nothing to commit (otherwise it
            // re-adds the raw query text as a second, bogus tag).
            event.preventDefault();
            input.value = '';
            addTag(tag.name);
          },
        }, [
          el('span', { text: tag.name }),
          el('span', { class: 'tag-suggestions__count', text: String(tag.post_count ?? 0) }),
        ])
      )
    );
    list.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(matches.length > 0));
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `tag-option-${matches[activeIndex].slug}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function updateMatches() {
    matches = matchingTags(input.value);
    // No item pre-selected — Enter on fresh input text still creates a new
    // tag; arrowing down is what opts into picking a suggestion instead.
    activeIndex = -1;
    paintList();
  }

  const input = el('input', {
    type: 'text',
    placeholder: state.tags.length ? 'Add tag…' : 'cloudflare, workers…',
    'aria-label': 'Add a tag',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'tag-suggestions',
    autocomplete: 'off',
    onInput: updateMatches,
    onKeydown: (event) => {
      if (event.key === 'ArrowDown' && matches.length) {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % matches.length;
        paintList();
        return;
      }
      if (event.key === 'ArrowUp' && matches.length) {
        event.preventDefault();
        activeIndex = (activeIndex - 1 + matches.length) % matches.length;
        paintList();
        return;
      }
      if (event.key === 'Escape' && !list.hidden) {
        event.preventDefault();
        closeList();
        return;
      }
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        const chosen = activeIndex >= 0 ? matches[activeIndex] : null;
        const raw = event.target.value;
        // Same ordering reason as the suggestion click above: clear before
        // addTag() rebuilds and removes this (still-focused) input.
        event.target.value = '';
        addTag(chosen ? chosen.name : raw);
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
      closeList();
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
    input,
    list
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
  // Keeps a tag created earlier in this same session suggestible again —
  // dedup by slug so re-picking it from the pool doesn't add a second copy.
  if (!tagPool.some((t) => t.slug === slug)) tagPool.push({ slug, name, post_count: 0 });
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
  // "Save" edits the row in place — for a draft that's a no-op the reader
  // never sees; for an already-published or scheduled post it goes out
  // immediately (the cache purge is near-instant), so the label says so
  // rather than implying a separate, un-pushed draft copy that doesn't
  // exist. See docs/implementation-plan.md's Phase 5 "known issue" note.
  const saveLabel = post.status === 'published' || post.status === 'scheduled' ? 'Save changes' : 'Save draft';
  append(clear(dom.actions),
    el('button', { class: 'btn', type: 'button', text: saveLabel, onClick: () => save({ notify: true }) }),
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
          href: `/posts/${encodeURIComponent(post.slug)}`,
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
  loadTagPool(); // fire-and-forget — suggestions fill in whenever this resolves, no need to block the post load on it

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
