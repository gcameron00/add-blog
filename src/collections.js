/**
 * Collections (custom content types) — pure functions over data, no D1/R2
 * access, mirroring how src/site-template.js is structured. A "collection"
 * is one entry of the `collections` settings array (migrations/0008); see
 * docs/vibecode-migration.md for the shape and the design rationale.
 *
 * Every renderer here treats its input as untrusted (it ultimately comes
 * from a `type_fields` JSON column an editor filled in) — every value goes
 * through escapeHtml, and `layout`/`display` are always looked up against
 * the fixed registries below rather than used to build a selector or class
 * name directly.
 */
import { escapeHtml, slugify } from '../assets/js/markdown.js';

export const LAYOUTS = ['grid', 'list'];
export const FIELD_DISPLAYS = ['badge', 'chips', 'link', 'text', 'date'];

/**
 * Parses/validates settings.collections defensively — same posture as
 * src/site-template.js's resolveNavConfig: malformed or missing input never
 * throws, it just resolves to "the feature is off" ([]). src/db.js's
 * getSettings already JSON.parses the raw column value, falling back to the
 * raw string on a parse failure, so this has to tolerate either shape.
 */
export function resolveCollections(settings) {
  let raw = settings?.collections;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c) =>
      c &&
      typeof c === 'object' &&
      !Array.isArray(c) &&
      typeof c.type === 'string' &&
      c.type &&
      typeof c.base_path === 'string' &&
      c.base_path.startsWith('/') &&
      Array.isArray(c.fields)
  );
}

function trimTrailingSlash(path) {
  return String(path).replace(/\/+$/, '') || '/';
}

/** Longest-base_path-prefix match — so a collection at /portfolio doesn't shadow one at /portfolio-extra, or vice versa. */
export function findCollectionByPath(collections, pathname) {
  const normalized = trimTrailingSlash(pathname);
  let best = null;
  let bestLength = -1;
  for (const collection of collections) {
    const base = trimTrailingSlash(collection.base_path);
    if (base === '/') continue; // never a valid base_path — validateCollections rejects it anyway
    if (normalized === base || normalized.startsWith(`${base}/`)) {
      if (base.length > bestLength) {
        best = collection;
        bestLength = base.length;
      }
    }
  }
  return best;
}

/** Matches a collection's legacy_path exactly, with or without a trailing slash — same shape as src/pages.js's handleLegacyPostRedirect matching /post or /post/. */
export function findCollectionByLegacyPath(collections, pathname) {
  return (
    collections.find(
      (c) => typeof c.legacy_path === 'string' && c.legacy_path && (pathname === c.legacy_path || pathname === `${c.legacy_path}/`)
    ) || null
  );
}

export function findCollectionByType(collections, type) {
  return collections.find((c) => c.type === type) || null;
}

/* --- Field rendering -------------------------------------------------------
 * Each renders a single value already known to be present (renderFieldPanel
 * filters out missing/empty ones before calling in) — a field an item
 * doesn't carry just omits its row rather than rendering something empty.
 */

export function renderStatusBadge(value) {
  const text = String(value);
  return `<span class="status-badge status-badge--${escapeHtml(slugify(text))}">${escapeHtml(text)}</span>`;
}

export function renderFieldChips(value) {
  const items = Array.isArray(value) ? value : String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!items.length) return '';
  return `<span class="field-chips">${items.map((v) => `<span class="chip">${escapeHtml(String(v))}</span>`).join('')}</span>`;
}

export function renderFieldLink(value) {
  const href = escapeHtml(String(value));
  return `<a class="field-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
}

function renderFieldDate(value) {
  const text = escapeHtml(String(value));
  return `<time datetime="${text}">${text}</time>`;
}

function renderFieldText(value) {
  return escapeHtml(String(value));
}

const FIELD_RENDERERS = {
  badge: renderStatusBadge,
  chips: renderFieldChips,
  link: renderFieldLink,
  date: renderFieldDate,
  text: renderFieldText,
};

/**
 * `typeFields` is the item's parsed type_fields object; `fieldSpecs` is the
 * collection's `fields` array. Only fields both declared in the spec *and*
 * present (non-null, non-empty) on the item get a row — an item missing a
 * given key omits that row rather than rendering an empty one.
 */
export function renderFieldPanel(typeFields, fieldSpecs) {
  if (!typeFields || typeof typeFields !== 'object' || !Array.isArray(fieldSpecs) || !fieldSpecs.length) return '';
  const rows = fieldSpecs
    .filter((spec) => spec && typeof spec.key === 'string' && typeFields[spec.key] !== undefined && typeFields[spec.key] !== null && typeFields[spec.key] !== '')
    .map((spec) => {
      const render = FIELD_RENDERERS[spec.display] || renderFieldText;
      return `
        <div class="field-row">
          <span class="field-row__label">${escapeHtml(spec.label || spec.key)}</span>
          <span class="field-row__value">${render(typeFields[spec.key], spec)}</span>
        </div>`;
    })
    .join('');
  return rows ? `<div class="field-panel">${rows}</div>` : '';
}

/* --- Item rendering --------------------------------------------------------- */

function itemHref(item, collection) {
  return `${escapeHtml(trimTrailingSlash(collection.base_path))}/${encodeURIComponent(item.slug)}`;
}

function renderItemCard(item, collection) {
  const cover = item.cover
    ? `<img class="item-card__cover" src="${escapeHtml(item.cover.url)}" alt="${escapeHtml(item.cover.alt || '')}">`
    : '';
  const excerpt = item.excerpt ? `<p class="item-card__excerpt">${escapeHtml(item.excerpt)}</p>` : '';
  return `
    <li class="item-card">
      <a class="item-card__link" href="${itemHref(item, collection)}">
        ${cover}
        <h3 class="item-card__title">${escapeHtml(item.title)}</h3>
        ${excerpt}
      </a>
      ${renderFieldPanel(item.type_fields, collection.fields)}
    </li>`;
}

function renderItemRow(item, collection) {
  return `
    <li class="collection-list__item">
      <a class="collection-list__link" href="${itemHref(item, collection)}">${escapeHtml(item.title)}</a>
      ${renderFieldPanel(item.type_fields, collection.fields)}
    </li>`;
}

function emptyState(collection) {
  const label = escapeHtml(collection.label_plural || collection.label || 'items');
  return `<p class="muted">No ${label} yet.</p>`;
}

export function renderCollectionGrid(items, collection) {
  if (!items.length) return emptyState(collection);
  return `<ul class="collection-grid">${items.map((item) => renderItemCard(item, collection)).join('')}</ul>`;
}

export function renderCollectionList(items, collection) {
  if (!items.length) return emptyState(collection);
  return `<ul class="collection-list">${items.map((item) => renderItemRow(item, collection)).join('')}</ul>`;
}

// The layout registry — collection.layout picks which of the two renderers
// above runs; anything unrecognised (or absent) falls back to grid, same
// non-fatal-default posture as everything else in this file.
const LAYOUT_RENDERERS = { grid: renderCollectionGrid, list: renderCollectionList };

export function renderCollectionIndex(items, collection) {
  const render = LAYOUT_RENDERERS[collection.layout] || renderCollectionGrid;
  return render(items, collection);
}

/** Full detail view for one item — cover, title, field panel, body, back-link. Mirrors src/pages.js's renderArticle. */
export function renderCollectionItem(item, collection) {
  const cover = item.cover
    ? `<img class="article-cover" src="${escapeHtml(item.cover.url)}" alt="${escapeHtml(item.cover.alt || '')}">`
    : '';
  const label = escapeHtml((collection.label_plural || collection.label || 'items').toLowerCase());

  return `
    <header class="article-header">
      <h1>${escapeHtml(item.title)}</h1>
      ${item.subtitle ? `<p class="subtitle">${escapeHtml(item.subtitle)}</p>` : ''}
    </header>
    ${cover}
    ${renderFieldPanel(item.type_fields, collection.fields)}
    <div class="prose">${item.body_html || ''}</div>
    <footer class="article-footer">
      <p class="small muted" style="margin-top:1rem"><a href="${escapeHtml(trimTrailingSlash(collection.base_path))}/">← All ${label}</a></p>
    </footer>
  `;
}
