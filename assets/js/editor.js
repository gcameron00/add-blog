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
 *  - Saving sends `If-Match` for the version we loaded. If the post changed
 *    underneath us the API answers 409 — rather than overwrite or discard
 *    either side's edits, an explicit Save forks our content into a new
 *    draft post instead (see save()'s conflict branch). Autosave never
 *    forks silently: it just flags the conflict in the save-state pill and
 *    stops retrying until the user takes that explicit action.
 */

import * as api from './api.js';
import { openMediaPicker, toast, statusBadge } from './admin.js';
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
  coverPreview: document.querySelector('[data-cover-preview]'),
  coverAlt: document.querySelector('[data-field="cover_alt"]'),
  coverPick: document.querySelector('[data-cover-pick]'),
  coverRemove: document.querySelector('[data-cover-remove]'),
  postType: document.querySelector('[data-field="post_type"]'),
  typeHint: document.querySelector('[data-type-hint]'),
  customFieldsCard: document.querySelector('[data-custom-fields]'),
  customFieldsBody: document.querySelector('[data-custom-fields-body]'),
};

const state = {
  post: null,
  tags: [],
  cover: { key: null, url: null },
  slugLocked: false,
  dirty: false,
  saving: false,
  conflict: false,
  collections: [], // populated in init() from settings.collections
  typeFields: {},
  role: 'owner', // overwritten by init() — defaults to showing owner-only controls, same fallback admin.js's MCP tools table uses
  siteTitle: 'add-blog', // overwritten by init() — same fallback name admin.js's renderSidebar uses
};

let mde;

/* --- Save state indicator ------------------------------------------------- */

const SAVE_LABELS = {
  idle: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
  conflict: 'Someone else edited this post — click Save to keep your changes as a new draft',
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
      'quote', 'unordered-list', 'ordered-list', 'link',
      {
        name: 'insert-image',
        // Opens the same picker the cover-image field uses (openMediaPicker,
        // admin.js) rather than EasyMDE's default `![](http://)` placeholder
        // text — browsing the library beats typing a URL from memory.
        action(editorInstance) {
          openMediaPicker({
            onSelect: (item) => {
              const cm = editorInstance.codemirror;
              cm.replaceSelection(`![${item.alt || ''}](${item.url})`);
              cm.focus();
            },
          });
        },
        className: 'fa fa-picture-o',
        title: 'Insert image from library',
      },
      '|',
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

/* --- Type & custom fields ----------------------------------------------------
 * post_type/type_fields (migrations/0008_collections.sql). The Type select is
 * only editable on a new post — src/admin-posts.js's patchHandler rejects
 * changing post_type after creation (a different type means a different URL
 * and field contract), so this locks the select the same way fill() below
 * locks nothing else quite like it: disabled, not hidden, so an existing
 * item's type is still visible.
 * -------------------------------------------------------------------------- */

/** Options come from state.collections (settings.collections, fetched in init()) — called once that resolves, and again from fill() in case the post loaded first. Idempotent either order. */
function populateTypeSelect() {
  for (const opt of [...dom.postType.options]) {
    if (opt.value !== 'post') opt.remove();
  }
  for (const collection of state.collections) {
    dom.postType.append(el('option', { value: collection.type, text: collection.label }));
  }
  const current = state.post?.post_type;
  if (current && current !== 'post' && !state.collections.some((c) => c.type === current)) {
    // The item's collection was deleted/renamed since it was created — show
    // the raw type truthfully rather than silently reverting to "Post".
    dom.postType.append(el('option', { value: current, text: current, disabled: '' }));
  }
  if (current) dom.postType.value = current;
}

function currentCollection() {
  return state.collections.find((c) => c.type === dom.postType.value) || null;
}

function renderTypeLock() {
  const locked = Boolean(state.post?.id);
  dom.postType.disabled = locked;
  dom.typeHint.textContent = locked
    ? 'What kind of content this is. Fixed once you save — a different type has a different URL and its own set of fields.'
    : 'Pick Post, or a configured collection.';
}

/**
 * Generic chip/token input — same `.token-input`/`.token` markup and
 * Enter/comma-to-add, Backspace-on-empty-to-pop, blur-commits interaction as
 * renderTags above, minus the suggestion-pool listbox (there's no shared pool
 * to suggest from for an arbitrary custom field). Rebuilds `host`'s children
 * each call, same as renderTags rebuilding dom.tagHost.
 */
function renderTokenField(host, values, onChange) {
  const input = el('input', {
    type: 'text', placeholder: values.length ? 'Add…' : '', autocomplete: 'off',
    onKeydown: (event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        const value = event.target.value.trim().replace(/,$/, '');
        event.target.value = '';
        if (value && !values.includes(value)) { onChange([...values, value]); renderTokenField(host, [...values, value], onChange).focus(); }
      } else if (event.key === 'Backspace' && !event.target.value && values.length) {
        onChange(values.slice(0, -1));
        renderTokenField(host, values.slice(0, -1), onChange).focus();
      }
    },
    onBlur: (event) => {
      const value = event.target.value.trim().replace(/,$/, '');
      if (value && !values.includes(value)) onChange([...values, value]);
      event.target.value = '';
    },
  });

  clear(host).append(
    ...values.map((value, index) =>
      el('span', { class: 'token' }, [
        value,
        el('button', {
          type: 'button', text: '×', 'aria-label': `Remove ${value}`,
          onClick: () => onChange(values.filter((_, i) => i !== index)),
        }),
      ])
    ),
    input
  );
  return input;
}

function renderCustomFields() {
  const collection = currentCollection();
  dom.customFieldsCard.hidden = !collection;
  clear(dom.customFieldsBody);
  if (!collection) return;

  for (const spec of collection.fields || []) {
    const value = state.typeFields[spec.key];
    let control;
    if (spec.type === 'enum') {
      control = el('select', {
        onChange: (event) => { state.typeFields[spec.key] = event.target.value; markDirty(); },
      }, [
        el('option', { value: '', text: '— choose —', selected: !value ? '' : null }),
        ...(spec.options || []).map((option) => el('option', { value: option, selected: value === option ? '' : null, text: option })),
      ]);
    } else if (spec.type === 'tags') {
      // renderTokenField re-renders itself (see its own onKeydown/onBlur) on
      // every add/remove, always with this same onChange closure — no
      // external redraw wrapper needed, same self-contained shape as
      // renderTags managing dom.tagHost.
      const tokenHost = el('div', { class: 'token-input' });
      renderTokenField(tokenHost, Array.isArray(value) ? value : [], (next) => {
        state.typeFields[spec.key] = next;
        markDirty();
      });
      control = tokenHost;
    } else {
      control = el('input', {
        type: spec.type === 'url' ? 'url' : spec.type === 'date' ? 'date' : 'text',
        value: value || '',
        onInput: (event) => { state.typeFields[spec.key] = event.target.value; markDirty(); },
      });
    }
    dom.customFieldsBody.append(
      el('div', { class: 'field' }, [
        el('label', { text: spec.label || spec.key }),
        control,
      ])
    );
  }
}

/* --- Cover image ------------------------------------------------------------
 * Browsing only — picking reuses the same library the media page uploads
 * into (openMediaPicker, in admin.js). `state.cover` tracks the key/url
 * because state.post is wholesale-replaced on save; cover_alt lives in its
 * own field like subtitle/excerpt do, read directly from the DOM in collect().
 * ---------------------------------------------------------------------- */

function renderCoverPreview() {
  clear(dom.coverPreview);
  if (state.cover.url) {
    dom.coverPreview.append(el('img', { src: state.cover.url, alt: '' }));
  } else {
    dom.coverPreview.append(el('span', { text: 'No cover set' }));
  }
  dom.coverRemove.hidden = !state.cover.key;
}

function setCover(item) {
  state.cover = { key: item.key, url: item.url };
  if (!dom.coverAlt.value.trim() && item.alt) dom.coverAlt.value = item.alt;
  renderCoverPreview();
  markDirty();
}

function clearCover() {
  state.cover = { key: null, url: null };
  renderCoverPreview();
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
  dom.coverAlt.value = post.cover_alt || post.cover?.alt || '';
  if (post.scheduled_for) dom.schedule.value = post.scheduled_for.slice(0, 16);

  state.cover = { key: post.cover_key || null, url: post.cover?.url || null };
  renderCoverPreview();

  state.typeFields = { ...(post.type_fields || {}) };
  populateTypeSelect(); // idempotent — also runs from init()'s settings fetch, whichever lands second wins
  renderTypeLock();
  renderCustomFields();

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
    post.author?.name ? el('span', { class: 'small muted', text: `by ${post.author.name}` }) : null,
    post.published_at
      ? el('span', { class: 'small muted', text: `Published ${formatDateTime(post.published_at)}` })
      : null,
    post.status === 'scheduled' && post.scheduled_for
      ? el('span', { class: 'small muted', text: `Goes live ${formatDateTime(post.scheduled_for)}` })
      : null
  );
  paintActions();
  updateDocumentTitle();
}

/** Runs on initial load, every save, and every status transition — so a renamed/retitled post's tab stays accurate, and several posts open in different tabs stay distinguishable (#13). */
function updateDocumentTitle() {
  document.title = `${state.post.title || 'New post'} — Editor — ${state.siteTitle} admin`;
}

function paintActions() {
  const post = state.post;
  // "Save" edits the row in place — for a draft that's a no-op the reader
  // never sees; for an already-published or scheduled post it goes out
  // immediately (the cache purge is near-instant), so the label says so
  // rather than implying a separate, un-pushed draft copy that doesn't
  // exist. See docs/implementation-plan.md's Phase 5 "known issue" note.
  const saveLabel = post.status === 'published' || post.status === 'scheduled' ? 'Save changes' : 'Save draft';
  const buttons = [
    el('button', { class: 'btn', type: 'button', text: saveLabel, onClick: () => save({ notify: true }) }),
  ];

  // Archived is a dead end everywhere else in the editor's publish/unpublish
  // toggle — same reasoning as admin.js's postStatusActions (#3/#5): jumping
  // an archived post straight to "Publish now" would skip draft entirely.
  if (post.status === 'archived') {
    buttons.push(
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Restore to draft',
        onClick: () => transition((id) => api.unarchivePost(id), 'Restored to draft'),
      })
    );
    if (post.id && state.role === 'owner') {
      buttons.push(
        el('button', {
          class: 'btn btn--ghost btn--danger', type: 'button', text: 'Delete permanently',
          onClick: () => deleteForever(),
        })
      );
    }
  } else {
    buttons.push(
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
        : null,
      post.id
        ? el('button', {
            class: 'btn btn--ghost btn--danger', type: 'button', text: 'Delete',
            onClick: () => {
              const warning = `Delete "${post.title || 'this post'}"? It will be archived and removed from the public site.`;
              if (!confirm(warning)) return;
              transition((id) => api.deletePost(id), 'Deleted');
            },
          })
        : null
    );
  }

  append(clear(dom.actions), buttons);
}

/** Hard delete leaves nothing to keep editing, unlike every other transition() here — navigates back to the list instead of re-painting a post that no longer exists. */
async function deleteForever() {
  const post = state.post;
  const warning = `Permanently delete "${post.title || 'this post'}"? This cannot be undone — the post and its revisions are gone for good.`;
  if (!confirm(warning)) return;
  try {
    await api.deletePost(post.id, { hard: true });
    toast('Deleted permanently');
    location.href = '/admin/posts/';
  } catch (error) {
    toast(error.message || 'That did not work.', 'error');
  }
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
    // A flagged conflict waits for the explicit Save button (which forks
    // into a new draft, see save()) rather than retrying silently — nothing
    // about typing more resolves the underlying conflict on its own.
    if (state.dirty && state.post?.id && !state.conflict) save({ notify: false });
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
    cover_key: state.cover.key || null,
    cover_alt: dom.coverAlt.value.trim() || null,
    // Always sent — harmless on update since the server only errors when it
    // *differs* from the stored value, and the select is disabled by then
    // anyway. type_fields only for a non-post type, and only its non-empty
    // entries, so an untouched optional field doesn't submit as "" and fail
    // validateTypeFields's per-type shape check.
    post_type: dom.postType.value,
    ...(dom.postType.value !== 'post'
      ? { type_fields: Object.fromEntries(Object.entries(state.typeFields).filter(([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) }
      : {}),
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
    const isUpdate = Boolean(state.post.id);
    const ifMatch = isUpdate && state.post.updated_at ? `"${state.post.updated_at}"` : undefined;

    let data;
    let forked = false;
    try {
      ({ data } = isUpdate
        ? await api.updatePost(state.post.id, input, { ifMatch })
        : await api.createPost(input));
    } catch (error) {
      if (error.code !== 'conflict') throw error;

      if (!notify) {
        // Autosave never forks on its own — just flag it and wait for an
        // explicit Save, which is the one action that creates the new draft.
        state.conflict = true;
        setSaveState('conflict');
        return;
      }

      // Someone else changed this post since it loaded. Rather than overwrite
      // their edit or discard ours, fork our content into a brand-new draft —
      // the server auto-suffixes the slug (uniqueSlug) since it collides with
      // the post we forked from.
      ({ data } = await api.createPost(input));
      forked = true;
      state.conflict = false;
      toast('Someone else edited this post while you were working on it — your changes were saved as a new draft instead of overwriting theirs.', 'error');
    }

    state.post = data;
    state.dirty = false;
    setSaveState('saved');
    if (notify && !forked) toast('Saved');

    if (!params.get('id') || forked) {
      // First save of a new post, or a conflict fork — either way the URL
      // needs to point at data.id now, not whatever post it pointed at before.
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

  for (const field of [dom.subtitle, dom.excerpt, dom.coverAlt]) {
    field.addEventListener('input', markDirty);
  }

  dom.coverPick.addEventListener('click', () => openMediaPicker({ onSelect: setCover }));
  dom.coverRemove.addEventListener('click', clearCover);

  dom.postType.addEventListener('change', () => {
    state.typeFields = {}; // switching type invalidates whatever was filled in for the old one
    renderCustomFields();
    markDirty();
  });

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

  // Alongside the post fetch below (not a separate fire-and-forget) so an
  // archived post's first paint already knows whether to offer "Delete
  // permanently" — a new draft never starts archived, but an existing post
  // loaded straight into that state shouldn't need a second interaction
  // before the owner-only button appears.
  const rolePromise = api.me().then(({ data }) => { state.role = data.role; }).catch(() => {});

  // Independent of admin.js's own site_title fetch (renderSidebar, #13) —
  // that one only fixes the *static* "Editor — <site> admin" suffix, not
  // the per-post prefix updateDocumentTitle() adds below, and there's no
  // reliable way to tell which of the two modules' async fetches lands
  // first. Fetching it again here and rebuilding the whole title from
  // scratch each time sidesteps that race entirely — same fallback default
  // as admin.js's, and a second cheap settings read is a fine price for not
  // having two modules fight over one string.
  const siteTitlePromise = api.getSettings().then(({ data }) => {
    state.siteTitle = data.site_title || state.siteTitle;
    state.collections = Array.isArray(data.collections) ? data.collections : [];
    populateTypeSelect();
  }).catch(() => {});

  if (!postId) {
    await Promise.all([rolePromise, siteTitlePromise]);
    fill({ status: 'draft', tags: [], body_md: '', title: '', post_type: 'post' });
    dom.title.focus();
    return;
  }

  try {
    const [{ data }] = await Promise.all([api.adminGetPost(postId), rolePromise, siteTitlePromise]);
    fill(data);
  } catch (error) {
    toast(error.message || 'Could not load that post.', 'error');
    fill({ status: 'draft', tags: [], body_md: '', title: '', post_type: 'post' });
  }
}

init();
