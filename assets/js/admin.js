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
  { href: '/admin/import/', label: 'Import', icon: 'inbox' },
  { href: '/admin/settings/', label: 'Settings', icon: 'gear' },
];

async function renderSidebar() {
  const host = document.querySelector('[data-sidebar]');
  if (!host) return;

  // This shell renders on blog-admin.* — a bare "/" href here would stay on
  // that host (and, since blog-admin.*'s root now redirects into /admin/,
  // would bounce straight back). "View blog" needs the actual public site.
  let publicUrl = '/';
  try {
    publicUrl = (await api.getSettings()).data.site_url || '/';
  } catch {
    // Sidebar still has to render even if settings can't be reached.
  }

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
    el('a', { href: publicUrl, target: '_blank', rel: 'noopener', title: 'View blog' }, [
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
          entry.actor ? el('span', { class: 'small muted', text: entry.actor }) : null,
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

/**
 * Publish/Unpublish/Delete/Restore for one row — status-driven since
 * `archived` needs a completely different pair (an archived post going
 * straight to "Publish" would skip draft entirely) and hard-delete only
 * ever applies once something is already archived. Left out of the
 * compact dashboard widget (`compact: true`) to keep that view to a quick
 * glance rather than a second place to manage every state transition.
 */
function postStatusActions(post, { compact, role, onChange }) {
  if (post.status === 'archived') {
    const restore = el('button', {
      class: 'btn btn--sm btn--primary', type: 'button', text: 'Restore to draft',
      onClick: () => act(() => api.unarchivePost(post.id), 'Restored to draft', onChange),
    });
    if (compact) return [restore];
    return [
      restore,
      role === 'owner'
        ? el('button', {
            class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete permanently',
            onClick: () => {
              const warning = `Permanently delete "${post.title}"? This cannot be undone — the post and its revisions are gone for good.`;
              if (!confirm(warning)) return;
              act(() => api.deletePost(post.id, { hard: true }), 'Deleted permanently', onChange);
            },
          })
        : null,
    ];
  }

  const toggle = post.status === 'published'
    ? el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Unpublish',
        onClick: () => act(() => api.unpublishPost(post.id), 'Unpublished', onChange),
      })
    : el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Publish',
        onClick: () => act(() => api.publishPost(post.id), 'Published', onChange),
      });
  if (compact) return [toggle];
  return [
    toggle,
    el('button', {
      class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Delete',
      onClick: () => {
        if (!confirm(`Delete "${post.title}"? It will be archived and removed from the public site.`)) return;
        act(() => api.deletePost(post.id), 'Deleted', onChange);
      },
    }),
  ];
}

function postsTable(posts, { compact = false, onChange, role } = {}) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Title' }),
        el('th', { text: 'Status' }),
        !compact ? el('th', { text: 'Author' }) : null,
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
        !compact ? el('td', { text: post.author?.name || '—' }) : null,
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
            ...postStatusActions(post, { compact, role, onChange }),
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

  let role = 'owner';
  try {
    role = (await api.me()).data.role;
  } catch { /* fall back to showing owner-only controls, same as the MCP tools table */ }

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
      host.append(postsTable(data, { onChange: load, role }));
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
 * Role is a `<select>`, not a text prompt — the API validates it either way,
 * but a free-text prompt inviting a typo into a role check is worse UX for
 * no benefit. Your own row's Disable/Delete buttons are pre-disabled with an
 * explanatory `title` — the server rejects the same action either way
 * (src/admin-authors.js's `assertNotSelf`), this just saves the round trip.
 * -------------------------------------------------------------------------- */

const ROLES = ['owner', 'editor', 'author'];

function authorsTable(authors, { canManage, meId, onChange }) {
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
    const isSelf = author.id === meId;
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
        el('td', {}, [
          canManage
            ? el('select', {
                'aria-label': `Role for ${author.name}`,
                onChange: (event) => {
                  const role = event.target.value;
                  if (role === author.role) return;
                  act(() => api.updateAuthor(author.id, { role }), 'Role updated', onChange);
                },
              }, ROLES.map((role) =>
                el('option', { value: role, selected: role === author.role ? true : null, text: role })
              ))
            : el('span', { text: author.role }),
        ]),
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
                  class: 'btn btn--sm btn--ghost', type: 'button', text: author.disabled ? 'Enable' : 'Disable',
                  disabled: isSelf && !author.disabled,
                  title: isSelf && !author.disabled ? "Can't disable your own account — ask another owner to do it." : null,
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
                  disabled: isSelf,
                  title: isSelf ? "Can't delete your own account — ask another owner to do it." : null,
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
  let meId = null;
  try {
    const me = (await api.me()).data;
    canManage = me.role === 'owner';
    meId = me.id;
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
      host.append(authorsTable(data, { canManage, meId, onChange: load }));
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

/* --- Settings page --------------------------------------------------------
 * nav_config is the one settings value that isn't a plain scalar (a nested
 * object of built-in features plus an array of custom links), so unlike
 * every other field on this form it can't ride the generic name-attribute
 * load/save loop below — it gets its own render/read pair instead, mirrored
 * against src/site-template.js's DEFAULT_NAV_CONFIG/resolveNavConfig so a
 * missing/partial stored value still shows sensible defaults.
 */

const NAV_FEATURES = [
  { key: 'posts', label: 'Posts', special: true }, // homepage post list — can't be disabled, was never a footer link
  { key: 'archive', label: 'Archive' },
  { key: 'tags', label: 'Tags' },
  { key: 'about', label: 'About' },
  { key: 'rss', label: 'RSS' },
];

const DEFAULT_NAV_FEATURES = {
  posts: { header: true },
  archive: { enabled: true, header: true, footer: true },
  tags: { enabled: true, header: true, footer: false },
  about: { enabled: true, header: true, footer: true },
  rss: { enabled: true, header: false, footer: true },
};

function renderNavFeaturesTable(tbody, features) {
  clear(tbody);
  for (const { key, label, special } of NAV_FEATURES) {
    const flags = features[key] || {};
    tbody.append(
      el('tr', { dataset: { navFeature: key } }, [
        el('td', { text: label }),
        el('td', {}, [
          special ? null : el('input', { type: 'checkbox', 'data-nav-enabled': '', checked: flags.enabled !== false ? '' : null, 'aria-label': `${label} enabled` }),
        ]),
        el('td', {}, [
          el('input', { type: 'checkbox', 'data-nav-header': '', checked: flags.header ? '' : null, 'aria-label': `${label} in header` }),
        ]),
        el('td', {}, [
          special ? null : el('input', { type: 'checkbox', 'data-nav-footer': '', checked: flags.footer ? '' : null, 'aria-label': `${label} in footer` }),
        ]),
      ])
    );
  }
}

function readNavFeaturesTable(tbody) {
  const features = {};
  for (const row of tbody.querySelectorAll('tr')) {
    const { key } = NAV_FEATURES.find((f) => f.key === row.dataset.navFeature);
    const spec = NAV_FEATURES.find((f) => f.key === key);
    const header = row.querySelector('[data-nav-header]').checked;
    features[key] = spec.special
      ? { header }
      : { enabled: row.querySelector('[data-nav-enabled]').checked, header, footer: row.querySelector('[data-nav-footer]').checked };
  }
  return features;
}

function renderNavCustomLinks(tbody, links, redraw) {
  clear(tbody);
  links.forEach((link, index) => {
    tbody.append(
      el('tr', {}, [
        el('td', {}, [el('input', {
          type: 'text', value: link.name || '', placeholder: 'Name', 'aria-label': 'Custom link name',
          onInput: (event) => { link.name = event.target.value; },
        })]),
        el('td', {}, [el('input', {
          type: 'url', value: link.url || '', placeholder: 'https://…', 'aria-label': 'Custom link URL',
          onInput: (event) => { link.url = event.target.value; },
        })]),
        el('td', {}, [el('input', {
          type: 'checkbox', checked: link.header ? '' : null, 'aria-label': 'In header',
          onChange: (event) => { link.header = event.target.checked; },
        })]),
        el('td', {}, [el('input', {
          type: 'checkbox', checked: link.footer ? '' : null, 'aria-label': 'In footer',
          onChange: (event) => { link.footer = event.target.checked; },
        })]),
        el('td', {}, [
          el('button', {
            class: 'btn btn--sm btn--ghost btn--danger', type: 'button', text: 'Remove',
            onClick: () => { links.splice(index, 1); redraw(); },
          }),
        ]),
      ])
    );
  });
}

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

  // nav_config isn't a plain form field (see the block comment above
  // initSettings) — loaded and re-serialized separately from the generic
  // loops above/below, which skip it because no element has name="nav_config".
  const navFeaturesBody = form.querySelector('[data-nav-features] tbody');
  const navLinksBody = form.querySelector('[data-nav-custom-links] tbody');
  const addLinkBtn = form.querySelector('[data-nav-add-link]');

  const storedFeatures = (current.nav_config && current.nav_config.features) || {};
  const features = {};
  for (const { key } of NAV_FEATURES) features[key] = { ...DEFAULT_NAV_FEATURES[key], ...storedFeatures[key] };
  if (navFeaturesBody) renderNavFeaturesTable(navFeaturesBody, features);

  const customLinks = Array.isArray(current.nav_config?.custom_links)
    ? current.nav_config.custom_links.map((link) => ({ ...link }))
    : [];
  const redrawLinks = () => renderNavCustomLinks(navLinksBody, customLinks, redrawLinks);
  if (navLinksBody) redrawLinks();

  addLinkBtn?.addEventListener('click', () => {
    customLinks.push({ name: '', url: '', header: false, footer: false });
    redrawLinks();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    // Sourced from the form's own fields, not Object.keys(current) — a
    // settings row that doesn't exist yet (new site, restored DB) must not
    // make its field silently unsavable. See docs/api.md's note on why PUT
    // is deliberately partial: this loop is what "the keys it has inputs
    // for" is supposed to mean, and it should hold regardless of what the
    // last GET happened to return.
    for (const field of form.elements) {
      if (!field.name || field.type === 'submit' || field.type === 'button') continue;
      if (field.type === 'checkbox') values[field.name] = field.checked;
      else if (field.type === 'number') values[field.name] = Number(field.value);
      else values[field.name] = field.value;
    }
    if (navFeaturesBody) {
      values.nav_config = {
        features: readNavFeaturesTable(navFeaturesBody),
        custom_links: customLinks.filter((link) => (link.name || '').trim() && (link.url || '').trim()),
      };
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

/* --- Import page -------------------------------------------------------------
 * Owner-only (src/auth.js: 'import.wxr'), and — unlike every other admin
 * section — has no offline demo equivalent (see assets/js/api.js's
 * previewImport/runImport comment): a WordPress export can't be faked
 * against localStorage, so this checks isDemoMode() up front and disables
 * itself entirely rather than pretending to preview a fake import.
 * -------------------------------------------------------------------------- */

function statRow(label, value) {
  return el('div', { class: 'form-row', style: 'justify-content:space-between' }, [
    el('span', { text: label }),
    el('strong', { text: String(value) }),
  ]);
}

function listCard(title, items, describe) {
  if (!items?.length) return null;
  return el('div', { style: 'margin-top: .75rem' }, [
    el('p', { class: 'small', style: 'margin-bottom:.25rem', text: `${title} (${items.length})` }),
    el('ul', { class: 'small muted', style: 'margin:0;padding-left:1.25rem' },
      items.map((item) => el('li', { text: describe(item) }))),
  ]);
}

function renderPreviewReport(host, data) {
  const mediaLabel = data.media_batches_expected > 1
    ? `${data.media_to_fetch} — large enough that "Confirm import" will need ${data.media_batches_expected} rounds (Workers fetches a limited number of files per request; each round picks up where the last left off)`
    : String(data.media_to_fetch);
  append(clear(host),
    statRow('Old site', `${data.site.title || 'Untitled'} — ${data.site.url || 'unknown URL'}`),
    statRow('Posts to create', data.posts_to_create),
    statRow('Posts already imported (will be skipped)', data.posts_skipped_duplicate),
    statRow('Media files to fetch', mediaLabel),
    statRow('Tags to create', data.tags_to_create.length),
    statRow('Tags to reuse', data.tags_to_reuse.length),
    listCard('Pages in this export (not imported)', data.pages_dropped, (p) => `${p.title} — ${p.link}`),
    listCard('Links pointing at a dropped page', data.links_to_dropped_pages, (l) => `${l.post_slug}: ${l.target_url}`),
    listCard('Links this importer could not resolve', data.links_unresolved, (l) => `${l.post_slug}: ${l.target_url}`)
  );
}

function renderManualMediaReport(host, data) {
  append(clear(host),
    statRow('Matched and uploaded', data.matched),
    statRow('Already uploaded (skipped)', data.already_resolved),
    listCard("Files that didn't match anything in this export", data.unmatched, (u) => `${u.name}: ${u.reason}`)
  );
}

function renderRunReport(host, data) {
  append(clear(host),
    statRow('Posts created', data.posts_created),
    statRow('Posts skipped (already imported)', data.posts_skipped),
    statRow('Media uploaded', data.media_uploaded),
    statRow('Links rewritten to the new site', data.links_rewritten),
    listCard('Posts that failed to import', data.posts_failed, (p) => `${p.slug}: ${p.reason}`),
    listCard('Media that failed to fetch', data.media_failed, (m) =>
      m.preview ? `${m.url}: ${m.reason} — got back: ${m.preview}` : `${m.url}: ${m.reason}`),
    listCard('Links pointing at a dropped page', data.links_to_dropped_pages, (l) => `${l.post_slug}: ${l.target_url}`),
    listCard('Links this importer could not resolve', data.links_unresolved, (l) => `${l.post_slug}: ${l.target_url}`)
  );
}

async function initImport() {
  const root = document.querySelector('[data-import-root]');
  if (!root) return;

  let role = null;
  try {
    role = (await api.me()).data.role;
  } catch (error) {
    if (!api.isDemoMode()) { renderError(root, error, initImport); return; }
  }

  if (api.isDemoMode()) {
    clear(root).append(el('div', { class: 'card' }, [
      el('p', { text: 'Import needs a live backend — there is nothing real to preview against demo data.' }),
    ]));
    return;
  }
  if (role !== 'owner') {
    clear(root).append(el('div', { class: 'card' }, [
      el('p', { text: 'Import is restricted to the owner role.' }),
    ]));
    return;
  }

  const fileInput = document.querySelector('[data-wxr-file]');
  const previewBtn = document.querySelector('[data-preview-btn]');
  const previewStatus = document.querySelector('[data-preview-status]');
  const previewCard = document.querySelector('[data-preview-card]');
  const previewHost = document.querySelector('[data-preview-report]');
  const runBtn = document.querySelector('[data-run-btn]');
  const runStatus = document.querySelector('[data-run-status]');
  const resultCard = document.querySelector('[data-result-card]');
  const resultHost = document.querySelector('[data-result-report]');
  const manualMediaCard = document.querySelector('[data-manual-media-card]');
  const mediaFolderInput = document.querySelector('[data-media-folder]');
  const uploadMediaBtn = document.querySelector('[data-upload-media-btn]');
  const mediaUploadStatus = document.querySelector('[data-media-upload-status]');
  const mediaUploadReportHost = document.querySelector('[data-media-upload-report]');

  fileInput.addEventListener('change', () => {
    previewBtn.disabled = !fileInput.files.length;
    previewCard.hidden = true;
    resultCard.hidden = true;
    manualMediaCard.hidden = true;
  });

  previewBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    previewBtn.disabled = true;
    previewStatus.textContent = 'Reading export…';
    resultCard.hidden = true;
    try {
      const { data } = await api.previewImport(file);
      renderPreviewReport(previewHost, data);
      previewCard.hidden = false;
      manualMediaCard.hidden = false;
    } catch (error) {
      toast(error.message || 'Could not read that file', 'error');
    } finally {
      previewStatus.textContent = '';
      previewBtn.disabled = !fileInput.files.length;
    }
  });

  // Same allow-list as src/admin-media.js's ALLOWED_TYPES — filtered here so
  // WordPress's own placeholder files (index.php/.htaccess in every
  // year/month upload folder) don't clutter the "didn't match" report with
  // noise the server would have reported anyway.
  const MANUAL_MEDIA_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'application/pdf']);

  // By total size, not file count — Cloudflare's own request body cap is
  // 100 MB on Free/Pro (up to 500 MB Enterprise), and a batch of ~15
  // full-resolution camera photos can clear that on its own even though 15
  // files sounds small. 20 MB stays comfortably under every plan's floor.
  // A single file over this on its own still gets its own one-file batch —
  // uploads are capped at 25 MB (src/admin-media.js's MAX_UPLOAD_BYTES)
  // regardless, well under even the smallest platform ceiling.
  const MEDIA_UPLOAD_BATCH_MAX_BYTES = 20 * 1024 * 1024;

  function chunkBySize(files, maxBytes) {
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const file of files) {
      if (current.length && currentBytes + file.size > maxBytes) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(file);
      currentBytes += file.size;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  mediaFolderInput.addEventListener('change', () => {
    uploadMediaBtn.disabled = !mediaFolderInput.files.length;
  });

  uploadMediaBtn.addEventListener('click', async () => {
    const wxrFile = fileInput.files[0];
    const mediaFiles = [...mediaFolderInput.files].filter((f) => MANUAL_MEDIA_ALLOWED_TYPES.has(f.type));
    if (!wxrFile || !mediaFiles.length) return;

    uploadMediaBtn.disabled = true;
    const batches = chunkBySize(mediaFiles, MEDIA_UPLOAD_BATCH_MAX_BYTES);
    const totals = { matched: 0, already_resolved: 0, unmatched: [] };
    try {
      for (const [i, batch] of batches.entries()) {
        mediaUploadStatus.textContent = batches.length > 1 ? `Uploading batch ${i + 1} of ${batches.length}…` : 'Uploading…';
        const { data } = await api.uploadImportMedia(wxrFile, batch);
        totals.matched += data.matched;
        totals.already_resolved += data.already_resolved;
        totals.unmatched.push(...data.unmatched);
      }
      renderManualMediaReport(mediaUploadReportHost, totals);
      toast(`${totals.matched} file${totals.matched === 1 ? '' : 's'} uploaded — click "Confirm import" again to finish`);
    } catch (error) {
      toast(error.message || 'Media upload failed', 'error');
    } finally {
      mediaUploadStatus.textContent = '';
      uploadMediaBtn.disabled = !mediaFolderInput.files.length;
    }
  });

  // A large export can't fetch all its media in one request (Workers caps
  // subrequests per invocation — see src/admin-import.js's
  // MEDIA_FETCH_BATCH_LIMIT); the server signals this via `media_pending`
  // rather than finishing early. Keep re-submitting the same file until it
  // reports none left, accumulating each round's media counts into one
  // final report — the last round is the only one with real post/link
  // data, since posts are deliberately not created until every attachment
  // has had its chance (see that file's executeImportPlan comment).
  const MAX_RUN_ROUNDS = 30;

  runBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!confirm('Import this file now? Posts and media will be created on the live site.')) return;

    runBtn.disabled = true;
    const mediaUploaded = [];
    const mediaFailed = [];
    let data;
    try {
      for (let round = 1; round <= MAX_RUN_ROUNDS; round++) {
        runStatus.textContent = round === 1 ? 'Importing…' : `Fetching more media (round ${round})…`;
        ({ data } = await api.runImport(file));
        if (data.media_uploaded) mediaUploaded.push(data.media_uploaded);
        mediaFailed.push(...data.media_failed);
        if (!data.media_pending) break;
        if (round === MAX_RUN_ROUNDS) throw new Error('Import is taking more rounds than expected — stopped as a safety measure.');
      }

      const merged = { ...data, media_uploaded: mediaUploaded.reduce((a, b) => a + b, 0), media_failed: mediaFailed };
      renderRunReport(resultHost, merged);
      resultCard.hidden = false;
      toast(`${data.posts_created} post${data.posts_created === 1 ? '' : 's'} imported`);
    } catch (error) {
      toast(error.message || 'Import failed', 'error');
    } finally {
      runStatus.textContent = '';
      runBtn.disabled = false;
    }
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
  import: initImport,
  settings: initSettings,
};

async function start() {
  await renderSidebar();
  PAGES[document.body.dataset.page]?.();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
