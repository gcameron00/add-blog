/**
 * Shared bootstrap and DOM helpers.
 *
 * Imported by every page for its side effects (theme, navigation state, the
 * demo-mode banner) and for the small helper set below. No page needs anything
 * from here to render its static content — this is enhancement, not scaffolding.
 */

/* --- Theme ---------------------------------------------------------------- */

const THEME_KEY = 'addblog.theme';

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  } else {
    document.documentElement.removeAttribute('data-theme');
    try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
  }
}

function currentTheme() {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit) return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paintToggles() {
  const dark = currentTheme() === 'dark';
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    clear(button).append(icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    button.setAttribute('title', dark ? 'Light theme' : 'Dark theme');
  }
}

function initTheme() {
  applyTheme(storedTheme());
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      paintToggles();
    });
  }
  // Track the OS preference while no explicit choice has been made.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) paintToggles();
  });
  paintToggles();
}

/* --- Sidebar collapse ------------------------------------------------------
 * Admin only — the layout div is absent on public pages, so every function
 * here is a no-op there. State applies as early as possible (before
 * admin.js has rendered the sidebar's contents) so there's no flash of the
 * wrong width, the same reasoning as the theme toggle above.
 * ---------------------------------------------------------------------- */

const SIDEBAR_KEY = 'addblog.sidebarCollapsed';

function storedSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

export function isSidebarCollapsed() {
  return document.querySelector('.admin-layout')?.hasAttribute('data-sidebar-collapsed') ?? false;
}

export function setSidebarCollapsed(collapsed) {
  const layout = document.querySelector('.admin-layout');
  if (!layout) return;
  layout.toggleAttribute('data-sidebar-collapsed', collapsed);
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }

  for (const button of document.querySelectorAll('[data-sidebar-toggle]')) {
    if (!button.firstChild) button.append(icon('panel'));
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    button.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
}

function initSidebarCollapse() {
  if (!document.querySelector('.admin-layout')) return;
  setSidebarCollapsed(storedSidebarCollapsed());
  // Delegated: the toggle button is created later, by admin.js's renderSidebar.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sidebar-toggle]');
    if (!button) return;
    setSidebarCollapsed(!isSidebarCollapsed());
  });
}

/* --- Navigation ----------------------------------------------------------- */

function markCurrentNav() {
  const here = location.pathname.replace(/index\.html$/, '');
  for (const link of document.querySelectorAll('.site-nav a, .admin-nav a')) {
    const href = new URL(link.getAttribute('href'), location.origin).pathname.replace(/index\.html$/, '');
    const active = href === here || (href !== '/' && here.startsWith(href));
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/* --- Demo-mode banner ----------------------------------------------------- */

// Deliberately not phase-numbered — this banner fires on both the public
// site and the admin UI, and the two go real at different times (public
// read API: Phase 3; admin API: Phases 4-5). A specific phase number here
// goes stale the moment either one ships without the other, which is
// exactly the state between Phase 3 and Phase 5.
const DEMO_MESSAGE =
  'This page is showing bundled sample content — the API it depends on has not shipped ' +
  'yet. Until then nothing here is real, and edits are stored only in this browser.';

function showDemoBanner() {
  if (document.querySelector('main .demo-banner')) return;
  const host = document.querySelector('[data-demo-slot]') || document.querySelector('main .wrap') ||
               document.querySelector('main');
  if (!host) return;

  const banner = el('div', { class: 'demo-banner', role: 'status' }, [
    icon('info'),
    el('span', {}, [el('strong', { text: 'Demo data. ' }), DEMO_MESSAGE]),
  ]);
  host.prepend(banner);
}

/* --- DOM helpers ---------------------------------------------------------- */

/**
 * Build an element.
 *
 * `text` sets textContent and is the default way to put content on the page.
 * `html` sets innerHTML and must only ever receive strings this codebase
 * produced — rendered Markdown or an inline icon. Never user input.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }

  return append(node, children);
}

/**
 * `Element.append` that skips null/undefined/false instead of inserting the
 * string "null". Every conditional child in this codebase goes through here —
 * the native method is a trap when you write `cond ? node : null`.
 */
export function append(node, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const ICON_PATHS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8.5v.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><path d="M7.5 7.5v.01"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-4 4 3 3-2 4 3"/>',
  plug: '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0Z"/><path d="M12 18v3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5 13 5l2.6-.6 1.2 2.4L19 8.4l-.6 2.6L20 12l-1.6 1 .6 2.6-2.2 1.6-1.2 2.4L13 19l-1 2.5L11 19l-2.6.6-1.2-2.4L5 15.6l.6-2.6L4 12l1.6-1L5 8.4l2.2-1.6L8.4 4.4 11 5Z"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M4 6h16l1 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  users: '<path d="M2 20v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1"/><circle cx="8" cy="8" r="3.2"/><path d="M15.5 4.3a3.2 3.2 0 0 1 0 6.2"/><path d="M22 20v-1a4 4 0 0 0-3-3.85"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.5 5.5 13 13"/>',
};

/** Inline SVG icon. The path data is a constant in this file, never user input. */
export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

/* --- Formatting ----------------------------------------------------------- */

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function formatDate(iso) {
  if (!iso) return '';
  return DATE_FMT.format(new Date(iso));
}

export function formatDateTime(iso) {
  if (!iso) return '';
  return DATETIME_FMT.format(new Date(iso));
}

export function formatRelative(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const past = seconds >= 0;
  const abs = Math.abs(seconds);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) {
      const value = Math.floor(abs / size);
      const plural = value === 1 ? unit : `${unit}s`;
      return past ? `${value} ${plural} ago` : `in ${value} ${plural}`;
    }
  }
  return past ? 'just now' : 'in a moment';
}

/** `<time>` with a machine-readable datetime and a human label. */
export function timeEl(iso, { relative = false } = {}) {
  return el('time', {
    datetime: iso || '',
    title: formatDateTime(iso),
    text: relative ? formatRelative(iso) : formatDate(iso),
  });
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/* --- Async page states ---------------------------------------------------- */

export function renderError(container, error, retry) {
  append(clear(container),
    el('div', { class: 'error-box', role: 'alert' }, [
      el('p', { text: error?.message || 'Something went wrong loading this page.' }),
      retry && el('button', { class: 'btn btn--sm', text: 'Try again', onClick: retry }),
    ])
  );
}

export function renderEmpty(container, { title, body, action } = {}) {
  append(clear(container),
    el('div', { class: 'empty-state' }, [
      icon('inbox'),
      el('h2', { text: title || 'Nothing here yet' }),
      body && el('p', { text: body }),
      action,
    ])
  );
}

export function skeletonList(container, count = 3) {
  append(clear(container),
    Array.from({ length: count }, () =>
      el('div', { class: 'post-card post-card--no-cover', 'aria-hidden': 'true' }, [
        el('div', { class: 'skeleton', text: 'Loading post title placeholder', style: 'height:1.5rem;width:60%' }),
        el('div', { class: 'skeleton', text: 'x', style: 'height:3rem;margin-top:.75rem' }),
      ])
    ),
    el('p', { class: 'visually-hidden', role: 'status', text: 'Loading…' })
  );
}

/* --- Init ----------------------------------------------------------------- */

document.addEventListener('addblog:demo-mode', showDemoBanner);

function init() {
  initTheme();
  initSidebarCollapse();
  markCurrentNav();
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
