/**
 * Admin shell and page controllers.
 *
 * The sidebar is rendered here rather than duplicated across six HTML files.
 * That is the opposite of the public pages, which keep their chrome in static
 * markup for SEO and no-JS rendering — the admin needs neither, and one
 * definition of the navigation is worth more than markup that works with
 * scripting off.
 *
 * The editor lives in editor.js; everything else is below.
 */

import * as api from './api.js';
import {
  el, clear, append, icon, timeEl, formatDateTime, formatRelative,
  formatBytes, renderError, renderEmpty, isSidebarCollapsed, setSidebarCollapsed,
} from './main.js';

/* --- Shell ---------------------------------------------------------------- */

const NAV = [
  { href: '/admin/', label: 'Dashboard', icon: 'home' },
  { href: '/admin/posts/', label: 'Posts', icon: 'file' },
  { href: '/admin/tags/', label: 'Tags', icon: 'tag' },
  { href: '/admin/media/', label: 'Media', icon: 'image' },
  { href: '/admin/mcp/', label: 'MCP access', icon: 'plug' },
  { href: '/admin/authors/', label: 'Authors', icon: 'users' },
  { href: '/admin/settings/', label: 'Settings', icon: 'gear' },
];

async function renderSidebar() {
  const host = document.querySelector('[data-sidebar]');
  if (!host) return;

  const brand = el('a', { class: 'admin-brand', href: '/admin/', 'aria-label': 'add-blog admin' }, [
    icon('check'),
    el('div', {}, [el('span', { text: 'add-blog' }), el('small', { text: 'Admin' })]),
  ]);

  // Click handling is delegated in main.js (initSidebarCollapse) — it has to
  // be, since this button doesn't exist yet when that listener is attached.
  const sidebarToggle = el('button', {
    class: 'sidebar-toggle',
    type: 'button',
    'data-sidebar-toggle': '',
  });

  const header = el('div', { class: 'admin-sidebar__header' }, [brand, sidebarToggle]);

  const nav = el('nav', { class: 'admin-nav', 'aria-label': 'Admin' }, [
    el('div', { class: 'admin-nav__label', text: 'Manage' }),
    ...NAV.map((item) =>
      el('a', { href: item.href, title: item.label }, [icon(item.icon), el('span', { text: item.label })])
    ),
    el('div', { class: 'admin-nav__label', text: 'Public site' }),
    el('a', { href: '/', target: '_blank', rel: 'noopener', title: 'View blog' }, [
      icon('external'), el('span', { text: 'View blog' }),
    ]),
  ]);

  const user = el('div', { class: 'admin-user', 'data-user': '' }, [
    el('div', { class: 'skeleton', style: 'width:2rem;height:2rem;border-radius:50%' }),
  ]);

  clear(host).append(header, nav, user);
  // The toggle button now exists — paint its icon/label against the state
  // main.js already applied (before this ever ran, to avoid a width flash).
  setSidebarCollapsed(isSidebarCollapsed());

  // Re-apply aria-current now that the nav exists (main.js ran before this).
  const here = location.pathname.replace(/index\.html$/, '');
  for (const link of nav.querySelectorAll('a')) {
    const path = new URL(link.getAttribute('href'), location.origin).pathname;
    if (path === here) link.setAttribute('aria-current', 'page');
  }

  try {
    const { data } = await api.me();
    append(clear(user),
      data.avatar ? el('img', { src: data.avatar, alt: '' }) : null,
      el('div', {}, [
        el('strong', { text: data.name }),
        el('span', { text: `${data.role}${api.isDemoMode() ? ' · demo' : ''}` }),
      ])
    );
  } catch {
    clear(user).append(el('span', { class: 'small muted', text: 'Not signed in' }));
  }
}

/* --- Toasts --------------------------------------------------------------- */

let toastStack;

export function toast(message, kind = 'ok') {
  if (!toastStack) {
    toastStack = el('div', { class: 'toast-stack', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
    icon(kind === 'error' ? 'info' : 'check'),
    el('span', { text: message }),
  ]);
  toastStack.append(node);
  setTimeout(() => node.remove(), 4200);
}

/* --- Small shared pieces -------------------------------------------------- */

export function statusBadge(status) {
  return el('span', { class: `badge badge--${status}`, text: status });
}

function editHref(post) {
  return `/admin/editor/?id=${encodeURIComponent(post.id)}`;
}

async function copyToClipboard(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Could not copy — your browser blocked clipboard access.', 'error');
  }
}

export function codeBlock(text) {
  return el('div', { class: 'code-block' }, [
    el('pre', {}, [el('code', { text })]),
    el('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: 'Copy',
      onClick: () => copyToClipboard(text),
    }),
  ]);
}

/* --- Media picker -----------------------------------------------------------
 * A native <dialog> so Escape-to-close and focus handling come from the
 * browser rather than hand-rolled — used by the editor for a post's cover
 * image and for inserting an image into the body. Browsing only: it reuses
 * the library `GET /api/admin/media` already backs, it doesn't duplicate the
 * upload form that already lives on the media page.
 * ---------------------------------------------------------------------- */

export function openMediaPicker({ onSelect }) {
  const dialog = el('dialog', { class: 'media-picker' });
  const search = el('input', {
    type: 'search',
    class: 'media-picker__search',
    placeholder: 'Search filenames and alt text…',
    autocomplete: 'off',
  });
  const body = el('div', { class: 'media-picker__body', 'aria-live': 'polite' });

  async function load(q) {
    clear(body).append(el('p', { class: 'small muted', text: 'Loading…' }));
    try {
      const { data } = await api.listMedia({ q, type: 'image' });
      if (!data.length) {
        clear(body).append(el('p', { class: 'small muted', text: q ? 'No matches.' : 'No images uploaded yet.' }));
        return;
      }
      clear(body).append(
        el('div', { class: 'media-picker__grid' },
          data.map((item) =>
            el('button', {
              type: 'button', class: 'media-picker__item', title: item.filename,
              onClick: () => { dialog.close(); onSelect(item); },
            }, [
              el('img', { src: item.url, alt: '', loading: 'lazy' }),
              el('span', { text: item.filename }),
            ])
          )
        )
      );
    } catch (error) {
      clear(body).append(el('p', { class: 'small muted', text: error.message || 'Could not load media.' }));
    }
  }

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(search.value.trim()), 200);
  });

  // Native <dialog> doesn't close on a backdrop click by default — only
  // treat it as "outside" when the click lands outside the element's own
  // box, since the dialog and its backdrop share the same click target.
  dialog.addEventListener('click', (event) => {
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());

  dialog.append(
    el('div', { class: 'media-picker__header' }, [
      el('h3', { text: 'Choose from library' }),
      el('a', { class: 'small', href: '/admin/media/', target: '_blank', rel: 'noopener', text: 'Upload new…' }),
    ]),
    search,
    body
  );
  document.body.append(dialog);
  dialog.showModal();
  load('');
}

/* --- Dashboard ------------------------------------------------------------ */

async function initDashboard() {
  const statsHost = document.querySelector('[data-stats]');
  const recentHost = document.querySelector('[data-recent]');
  const activityHost = document.querySelector('[data-activity]');

  try {
    const { data } = await api.getStats();
    const tiles = [
      { label: 'Published', value: data.published },
      { label: 'Drafts', value: data.draft },
      { label: 'Scheduled', value: data.scheduled },
      { label: 'Media files', value: data.media },
      { label: 'Words written', value: data.words.toLocaleString() },
    ];
    clear(statsHost).append(
      ...tiles.map((tile) =>
        el('div', { class: 'stat' }, [
          el('div', { class: 'stat__value', text: String(tile.value) }),
          el('div', { class: 'stat__label', text: tile.label }),
        ])
      )
    );

    // Rendered into its own slot rather than inserted as a sibling, so a refresh
    // replaces the callout instead of stacking another one after the tiles.
    const scheduledSlot = document.querySelector('[data-next-scheduled]');
    if (scheduledSlot) {
      clear(scheduledSlot);
      if (data.next_scheduled) {
        const next = data.next_scheduled;
        scheduledSlot.append(
          el('div', { class: 'callout callout--info' }, [
            icon('clock'),
            el('div', {}, [
              el('strong', { text: 'Next scheduled post' }),
              el('span', {
                text: `“${next.title}” goes live ${formatDateTime(next.scheduled_for)} (${formatRelative(next.scheduled_for)}).`,
              }),
            ]),
          ])
        );
      }
    }
  } catch (error) {
    renderError(statsHost, error, initDashboard);
  }

  try {
    const { data } = await api.adminListPosts({ sort: 'updated', limit: 6 });
    clear(recentHost).append(postsTable(data, { compact: true, onChange: initDashboard }));
  } catch (error) {
    renderError(recentHost, error, initDashboard);
  }

  try {
    const { data } = await api.getActivity(7);
    clear(activityHost).append(
      el('ul', { class: 'activity' }, data.map((entry) =>
        el('li', {}, [
          el('code', { text: entry.action }),
          el('span', { text: entry.detail }),
          entry.via === 'mcp' ? el('span', { class: 'badge badge--mcp', text: 'mcp' }) : null,
          timeEl(entry.at, { relative: true }),
        ])
      ))
    );
  } catch (error) {
    renderError(activityHost, error, initDashboard);
  }
}

/* --- Posts table ---------------------------------------------------------- */

function postsTable(posts, { compact = false, onChange } = {}) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Title' }),
        el('th', { text: 'Status' }),
        !compact ? el('th', { text: 'Tags' }) : null,
        el('th', { text: 'Updated' }),
        el('th', {}, [el('span', { class: 'visually-hidden', text: 'Actions' })]),
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const post of posts) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          el('a', { class: 'table__title', href: editHref(post), text: post.title }),
          el('div', { class: 'table__sub', text: `/${post.slug} · ${post.reading_minutes} min · ${post.word_count} words` }),
        ]),
        el('td', {}, [
          statusBadge(post.status),
          post.status === 'scheduled'
            ? el('div', { class: 'table__sub', text: formatDateTime(post.scheduled_for) })
            : null,
        ]),
        !compact
          ? el('td', {}, [
              el('div', { class: 'tag-list' }, (post.tags || []).map((t) => el('span', { class: 'tag', text: t.name }))),
            ])
          : null,
        el('td', {}, [timeEl(post.updated_at, { relative: true })]),
        el('td', {}, [
          el('div', { class: 'table__actions' }, [
            post.status === 'published'
              ? el('a', {
                  class: 'btn btn--sm btn--ghost',
                  href: `/posts/${encodeURIComponent(post.slug)}`,
                  target: '_blank',
                  rel: 'noopener',
                  title: 'View on the public site',
                }, [icon('eye')])
              : null,
            post.status === 'published'
              ? el('button', {
                  class: 'btn btn--sm',
                  type: 'button',
                  text: 'Unpublish',
                  onClick: () => act(() => api.unpublishPost(post.id), 'Unpublished', onChange),
                })
              : el('button', {
                  class: 'btn btn--sm btn--primary',
                  type: 'button',
                  text: 'Publish',
                  onClick: () => act(() => api.publishPost(post.id), 'Published', onChange),
                }),
            el('a', { class: 'btn btn--sm', href: editHref(post), text: 'Edit' }),
          ]),
        ]),
      ])
    );
  }
  table.append(body);
  return table;
}

async function act(fn, successMessage, onChange) {
  try {
    await fn();
    toast(successMessage);
    onChange?.();
  } catch (error) {
    toast(error.message || 'That did not work.', 'error');
  }
}

/* --- Posts page ----------------------------------------------------------- */

async function initPosts() {
  const host = document.querySelector('[data-posts]');
  const search = document.querySelector('[data-search]');
  const sort = document.querySelector('[data-sort]');
  const segmented = document.querySelector('[data-status-filter]');

  const params = new URLSearchParams(location.search);
  const state = {
    status: params.get('status') || 'all',
    q: '',
    sort: 'updated',
  };

  function paintSegmented() {
    if (!segmented) return;
    for (const button of segmented.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.status === state.status));
    }
  }

  async function load() {
    host.setAttribute('aria-busy', 'true');
    try {
      const { data, page } = await api.adminListPosts(state);
      clear(host);
      if (!data.length) {
        renderEmpty(host, {
          title: state.q ? 'No posts match that search' : 'No posts with this status',
          body: state.q ? 'Try a different term or clear the filter.' : undefined,
          action: el('a', { class: 'btn btn--primary', href: '/admin/editor/', text: 'Write a post' }),
        });
        return;
      }
      host.append(postsTable(data, { onChange: load }));
      host.append(
        el('p', {
          class: 'small muted',
          style: 'padding:.75rem 1.25rem;margin:0',
          text: `${page.total} post${page.total === 1 ? '' : 's'}`,
        })
      );
    } catch (error) {
      renderError(host, error, load);
    } finally {
      host.removeAttribute('aria-busy');
    }
  }

  segmented?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    state.status = button.dataset.status;
    paintSegmented();
    load();
  });

  let debounce;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = search.value.trim(); load(); }, 220);
  });

  sort?.addEventListener('change', () => { state.sort = sort.value; load(); });

  paintSegmented();
  load();
}

/* --- Media page ----------------------------------------------------------- */

const TYPE_LABEL = (contentType) => (contentType.split('/')[1] || 'file').toUpperCase();

async function initMedia() {
  const host = document.querySelector('[data-media]');
  const search = document.querySelector('[data-search]');
  const filter = document.querySelector('[data-type-filter]');
  const state = { q: '', type: 'all' };

  async function load() {
    try {
      const { data } = await api.listMedia(state);
      clear(host);
      if (!data.length) {
        renderEmpty(host, { title: 'No files match', body: 'Try clearing the filters.' });
        return;
      }
      const grid = el('div', { class: 'media-grid' });
      for (const item of data) {
        const isImage = item.content_type.startsWith('image/');
        grid.append(
          el('figure', { class: 'media-item', style: 'margin:0' }, [
            el('div', { class: 'media-item__thumb' }, [
              isImage ? el('img', { src: item.url, alt: '', loading: 'lazy' }) : icon('file'),
            ]),
            el('figcaption', { class: 'media-item__body' }, [
              el('div', { class: 'media-item__name', title: item.filename, text: item.filename }),
              el('div', { class: 'media-item__meta', text:
                [TYPE_LABEL(item.content_type),
                 item.width ? `${item.width}×${item.height}` : null,
                 formatBytes(item.size_bytes)].filter(Boolean).join(' · ') }),
              el('div', { class: 'media-item__meta', text:
                item.used_by ? `Used in ${item.used_by} post${item.used_by === 1 ? '' : 's'}` : 'Unused' }),
              el('div', { class: 'media-item__actions' }, [
                el('button', {
                  class: 'btn btn--sm btn--ghost', type: 'button', text: 'Copy URL',
                  onClick: () => copyToClipboard(item.url, 'URL copied'),
                }),
                el('button', {
                  class: 'btn btn--sm btn--ghost', type: 'button', text: 'Edit alt',
                  onClick: () => {
                    const alt = window.prompt('Alt text', item.alt || '');
                    if (alt === null || alt === item.alt) return;
                    act(() => api.updateMedia(item.key, { alt }), 'Alt text updated', load);
                  },
                }),
                el('button', {
                  class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete',
                  onClick: () => {
                    if (!confirm(`Delete ${item.filename}? This cannot be undone.`)) return;
                    act(() => api.deleteMedia(item.key), 'File deleted', load);
                  },
                }),
              ]),
              !item.alt ? el('div', { class: 'field__error', text: 'Missing alt text' }) : null,
            ]),
          ])
        );
      }
      host.append(grid);
    } catch (error) {
      renderError(host, error, load);
    }
  }

  let debounce;
  search?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = search.value.trim(); load(); }, 200);
  });
  filter?.addEventListener('change', () => { state.type = filter.value; load(); });

  initUpload(load);
  load();
}

// Alt text is deliberately not collected here — requiring it up front slows
// down the one thing this form exists to do, and blocks selecting more than
// one file at a time. Each card flags "Missing alt text" until it's fixed
// via "Edit alt" instead — a nudge after the fact, not a gate before it.
function initUpload(onUploaded) {
  const dropzone = document.querySelector('[data-dropzone]');
  const fileInput = document.querySelector('[data-file-input]');
  const status = document.querySelector('[data-upload-status]');
  if (!dropzone || !fileInput) return;

  async function uploadAll(fileList) {
    const files = [...fileList];
    if (!files.length) return;

    fileInput.disabled = true;
    let succeeded = 0;
    for (const [i, file] of files.entries()) {
      status.textContent = files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : `Uploading ${file.name}…`;
      try {
        await api.uploadMedia(file);
        succeeded += 1;
      } catch (error) {
        toast(`${file.name}: ${error.message || 'Upload failed'}`, 'error');
      }
    }
    status.textContent = '';
    fileInput.value = '';
    fileInput.disabled = false;

    if (succeeded) {
      toast(files.length > 1 ? `${succeeded} of ${files.length} files uploaded` : 'File uploaded');
      onUploaded();
    }
  }

  fileInput.addEventListener('change', () => uploadAll(fileInput.files));

  // Drag-and-drop is additive — the label/file-input above already gives a
  // fully keyboard- and screen-reader-reachable path to the same upload.
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragover');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    })
  );
  dropzone.addEventListener('drop', (event) => uploadAll(event.dataTransfer.files));
}

/* --- Tags page -------------------------------------------------------------
 * A checkbox column feeds "Merge selected…" — the only multi-row action
 * here — rather than a dedicated selection mode, since it's the one
 * button whose meaning depends on more than one row being picked. Rename
 * and delete reuse the same prompt()/confirm() pattern as media's "Edit
 * alt" and "Delete" (assets/js/admin.js, initMedia) rather than a new
 * dialog component for two single-field forms.
 * -------------------------------------------------------------------------- */

function tagsTable(tags, { selected, onToggle, onChange }) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, [el('span', { class: 'visually-hidden', text: 'Select for merge' })]),
        el('th', { text: 'Name' }),
        el('th', { text: 'Slug' }),
        el('th', { text: 'Posts' }),
        el('th', {}, [el('span', { class: 'visually-hidden', text: 'Actions' })]),
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const tag of tags) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          el('input', {
            type: 'checkbox',
            'aria-label': `Select "${tag.name}" for merging`,
            checked: selected.has(tag.id) ? '' : null,
            onChange: (event) => {
              if (event.target.checked) selected.add(tag.id);
              else selected.delete(tag.id);
              onToggle();
            },
          }),
        ]),
        el('td', { text: tag.name }),
        el('td', {}, [el('code', { text: tag.slug })]),
        el('td', { text: String(tag.post_count) }),
        el('td', {}, [
          el('div', { class: 'table__actions' }, [
            el('button', {
              class: 'btn btn--sm btn--ghost', type: 'button', text: 'Rename',
              onClick: () => {
                const name = window.prompt('Tag name', tag.name);
                if (name === null || !name.trim() || name.trim() === tag.name) return;
                act(() => api.updateTag(tag.id, { name: name.trim() }), 'Tag renamed', onChange);
              },
            }),
            el('button', {
              class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete',
              onClick: () => {
                const warning = tag.post_count
                  ? `"${tag.name}" is used on ${tag.post_count} post${tag.post_count === 1 ? '' : 's'}. Delete it anyway? It will be removed from all of them.`
                  : `Delete "${tag.name}"?`;
                if (!confirm(warning)) return;
                act(() => api.deleteTag(tag.id), 'Tag deleted', onChange);
              },
            }),
          ]),
        ]),
      ])
    );
  }
  table.append(body);
  return table;
}

async function initTags() {
  const host = document.querySelector('[data-tags]');
  const form = document.querySelector('[data-tag-form]');
  const mergeBtn = document.querySelector('[data-merge-selected]');
  if (!host) return;

  const selected = new Set();

  function paintMergeButton() {
    if (!mergeBtn) return;
    mergeBtn.disabled = selected.size < 2;
  }

  async function load() {
    host.setAttribute('aria-busy', 'true');
    try {
      const { data } = await api.adminListTags();
      selected.clear();
      paintMergeButton();
      clear(host);
      if (!data.length) {
        renderEmpty(host, { title: 'No tags yet', body: 'Add one above, or attach one to a post from the editor.' });
        return;
      }
      host.append(tagsTable(data, { selected, onToggle: paintMergeButton, onChange: load }));
    } catch (error) {
      renderError(host, error, load);
    } finally {
      host.removeAttribute('aria-busy');
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.elements.name;
    const name = input.value.trim();
    if (!name) return;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api.createTag({ name });
      input.value = '';
      toast('Tag added');
      load();
    } catch (error) {
      toast(error.message || 'Could not create tag', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  mergeBtn?.addEventListener('click', async () => {
    const { data } = await api.adminListTags();
    const chosen = data.filter((t) => selected.has(t.id));
    if (chosen.length < 2) return;
    const slugs = chosen.map((t) => t.slug);
    const target = window.prompt(
      `Merge ${chosen.map((t) => t.name).join(', ')} into which one? Enter its slug: ${slugs.join(', ')}`,
      slugs[0]
    );
    if (!target || !slugs.includes(target)) return;
    const from = slugs.filter((slug) => slug !== target);
    await act(() => api.mergeTags(from, target), 'Tags merged', load);
  });

  load();
}

/* --- Authors page -----------------------------------------------------------
 * Only owner/editor/author are exposed as role choices and only name, email
 * and role are editable from here — bio and avatar exist in the schema and
 * the API (docs/api.md) but nothing in this prototype UI sets them yet, same
 * gap as tags' slug/description (see initTags above). Disable is the default
 * "remove access" action in the table; delete sits next to it as the
 * separate, harder-to-undo one, same danger-button treatment as tags' delete.
 * -------------------------------------------------------------------------- */

function authorsTable(authors, { canManage, onChange }) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Name' }),
        el('th', { text: 'Email' }),
        el('th', { text: 'Role' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Posts' }),
        canManage ? el('th', {}, [el('span', { class: 'visually-hidden', text: 'Actions' })]) : null,
      ]),
    ]),
  ]);

  const body = el('tbody');
  for (const author of authors) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          el('div', { style: 'display:flex;align-items:center;gap:var(--sp-2)' }, [
            author.avatar
              ? el('img', { src: author.avatar, alt: '', style: 'width:1.75rem;height:1.75rem;border-radius:50%' })
              : null,
            el('span', { text: author.name }),
          ]),
        ]),
        el('td', {}, [el('code', { text: author.email })]),
        el('td', { text: author.role }),
        el('td', {}, [
          el('span', { class: `badge badge--${author.disabled ? 'archived' : 'published'}`, text: author.disabled ? 'Disabled' : 'Active' }),
        ]),
        el('td', { text: String(author.post_count) }),
        canManage
          ? el('td', {}, [
              el('div', { class: 'table__actions' }, [
                el('button', {
                  class: 'btn btn--sm btn--ghost', type: 'button', text: 'Rename',
                  onClick: () => {
                    const name = window.prompt('Name', author.name);
                    if (name === null || !name.trim() || name.trim() === author.name) return;
                    act(() => api.updateAuthor(author.id, { name: name.trim() }), 'Author updated', onChange);
                  },
                }),
                el('button', {
                  class: 'btn btn--sm btn--ghost', type: 'button', text: 'Role',
                  onClick: () => {
                    const role = window.prompt('Role — owner, editor, or author', author.role);
                    if (role === null || role.trim() === author.role) return;
                    act(() => api.updateAuthor(author.id, { role: role.trim() }), 'Role updated', onChange);
                  },
                }),
                el('button', {
                  class: 'btn btn--sm btn--ghost', type: 'button', text: author.disabled ? 'Enable' : 'Disable',
                  onClick: () => {
                    const warning = author.disabled
                      ? `Re-enable "${author.name}"? They'll be able to sign in again.`
                      : `Disable "${author.name}"? They'll be signed out of the admin immediately — this doesn't touch Cloudflare Access, so remove them there too if they should lose access entirely.`;
                    if (!confirm(warning)) return;
                    act(() => api.updateAuthor(author.id, { disabled: !author.disabled }), author.disabled ? 'Author enabled' : 'Author disabled', onChange);
                  },
                }),
                el('button', {
                  class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete',
                  onClick: () => {
                    const warning = author.post_count
                      ? `Delete "${author.name}"? Their ${author.post_count} post${author.post_count === 1 ? '' : 's'} will be reassigned to you.`
                      : `Delete "${author.name}"?`;
                    if (!confirm(warning)) return;
                    act(() => api.deleteAuthor(author.id), 'Author deleted', onChange);
                  },
                }),
              ]),
            ])
          : null,
      ])
    );
  }
  table.append(body);
  return table;
}

async function initAuthors() {
  const host = document.querySelector('[data-authors]');
  const form = document.querySelector('[data-author-form]');
  if (!host) return;

  let canManage = true;
  try {
    canManage = (await api.me()).data.role === 'owner';
  } catch { /* fall back to showing everything */ }
  if (form && !canManage) form.hidden = true;

  async function load() {
    host.setAttribute('aria-busy', 'true');
    try {
      const { data } = await api.adminListAuthors();
      clear(host);
      if (!data.length) {
        renderEmpty(host, { title: 'No authors yet', body: 'Add one above.' });
        return;
      }
      host.append(authorsTable(data, { canManage, onChange: load }));
    } catch (error) {
      renderError(host, error, load);
    } finally {
      host.removeAttribute('aria-busy');
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const role = form.elements.role.value;
    if (!name || !email) return;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api.createAuthor({ name, email, role });
      form.reset();
      window.alert(
        `"${name}" is created but can't sign in yet:\n\n` +
        `1. Add ${email} to the Cloudflare Access policy for this admin (Zero Trust → Access → Applications → your app → Policy).\n` +
        `2. There's no invite email — let them know directly.`
      );
      toast('Author added');
      load();
    } catch (error) {
      toast(error.message || 'Could not add author', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  load();
}

/* --- MCP page ------------------------------------------------------------- */

const MCP_TOOLS = [
  ['list_posts', 'read', 'Browse posts with status, tag and author filters. Metadata only.'],
  ['get_post', 'read', 'Fetch one post as Markdown by slug or id.'],
  ['search_posts', 'read', 'Full-text search with highlighted snippets.'],
  ['list_tags', 'read', 'All tags with post counts.'],
  ['list_media', 'read', 'Media library, so a post can reference an existing image.'],
  ['get_site_settings', 'read', 'Title, description, timezone — context before drafting.'],
  ['create_post', 'author', 'Create a post. Always a draft, whatever status is passed.'],
  ['update_post', 'author', 'Edit a post. Cannot change status. Supports optimistic concurrency.'],
  ['upload_media_from_url', 'author', 'Fetch and store an image. Alt text is required.'],
  ['publish_post', 'editor', 'Publish now, or schedule for later.'],
  ['unpublish_post', 'editor', 'Return a post to draft.'],
  ['delete_post', 'editor', 'Soft delete to archived. Hard delete is UI-only.'],
  ['update_site_settings', 'owner', 'Change blog settings.'],
];

async function initMcp() {
  const adminHost = location.hostname.startsWith('blog-admin.')
    ? location.host
    : 'blog-admin.mysite.com';
  const endpoint = `https://${adminHost}/mcp`;

  const endpointHost = document.querySelector('[data-mcp-endpoint]');
  if (endpointHost) clear(endpointHost).append(codeBlock(endpoint));

  const cliHost = document.querySelector('[data-mcp-cli]');
  if (cliHost) clear(cliHost).append(codeBlock(`claude mcp add --transport http blog ${endpoint}`));

  const jsonHost = document.querySelector('[data-mcp-json]');
  if (jsonHost) {
    clear(jsonHost).append(codeBlock(JSON.stringify({
      mcpServers: { blog: { type: 'http', url: endpoint } },
    }, null, 2)));
  }

  const toolsHost = document.querySelector('[data-mcp-tools]');
  if (toolsHost) {
    let role = 'owner';
    try {
      role = (await api.me()).data.role;
    } catch { /* fall back to showing everything */ }

    const rank = { read: 0, author: 1, editor: 2, owner: 3 };
    const allowed = rank[role] ?? 3;

    clear(toolsHost).append(
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Tool' }), el('th', { text: 'Requires' }),
            el('th', { text: 'What it does' }), el('th', { text: 'Visible to you' }),
          ]),
        ]),
        el('tbody', {}, MCP_TOOLS.map(([name, requires, description]) =>
          el('tr', {}, [
            el('td', {}, [el('code', { text: name })]),
            el('td', { text: requires }),
            el('td', { class: 'muted', text: description }),
            el('td', { text: rank[requires] <= allowed ? 'Yes' : 'No' }),
          ])
        )),
      ])
    );
  }
}

/* --- Settings page -------------------------------------------------------- */

async function initSettings() {
  const form = document.querySelector('[data-settings-form]');
  const reset = document.querySelector('[data-reset-demo]');
  const prototypeCard = document.querySelector('[data-prototype-card]');
  if (!form) return;

  let current = {};
  try {
    current = (await api.getSettings()).data;
  } catch (error) {
    renderError(form, error, initSettings);
    return;
  }

  // Only meaningful once we know whether this call actually hit demo data —
  // isDemoMode() is decided by the getSettings() call just above (see
  // assets/js/api.js), so it isn't reliable any earlier than this.
  if (prototypeCard) prototypeCard.hidden = !api.isDemoMode();

  for (const [key, value] of Object.entries(current)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value ?? '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const key of Object.keys(current)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === 'checkbox') values[key] = field.checked;
      else if (field.type === 'number') values[key] = Number(field.value);
      else values[key] = field.value;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api.saveSettings(values);
      toast('Settings saved');
    } catch (error) {
      toast(error.message || 'Could not save settings', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  reset?.addEventListener('click', () => {
    if (!confirm('Reset all demo content back to its original state? Any edits you made in this browser will be lost.')) return;
    api.resetDemoData();
    toast('Demo data reset');
    setTimeout(() => location.reload(), 600);
  });
}

/* --- Dispatch ------------------------------------------------------------- */

const PAGES = {
  dashboard: initDashboard,
  posts: initPosts,
  tags: initTags,
  media: initMedia,
  mcp: initMcp,
  authors: initAuthors,
  settings: initSettings,
};

async function start() {
  await renderSidebar();
  PAGES[document.body.dataset.page]?.();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
