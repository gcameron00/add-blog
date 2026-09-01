/**
 * Shared request-body validation for the admin write API (Phase 5), per
 * docs/api.md's "Conventions" and Posts sections. Every check throws a
 * ValidationError shaped like the API's error envelope, so route handlers
 * validate a whole body in a line or two and let one catch produce the 400.
 */

import { FIELD_DISPLAYS, LAYOUTS, resolveCollections } from './collections.js';

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.code = 'bad_request';
    this.field = field;
    this.status = 400;
  }
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 512 * 1024;

export function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length < 1 || title.length > 200) {
    throw new ValidationError('title must be 1-200 characters.', 'title');
  }
  return title.trim();
}

export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length < 1 || slug.length > 120 || !SLUG_RE.test(slug)) {
    throw new ValidationError('slug must match ^[a-z0-9]+(-[a-z0-9]+)*$, 1-120 characters.', 'slug');
  }
  return slug;
}

export function validateBodyMd(bodyMd) {
  if (typeof bodyMd !== 'string') throw new ValidationError('body_md must be a string.', 'body_md');
  if (new TextEncoder().encode(bodyMd).length > MAX_BODY_BYTES) {
    throw new ValidationError('body_md must be at most 512 KB.', 'body_md');
  }
  return bodyMd;
}

export function validateTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new ValidationError('tags must be an array.', 'tags');
  if (tags.length > 10) throw new ValidationError('At most 10 tags.', 'tags');
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim().length < 1 || tag.length > 40) {
      throw new ValidationError('Each tag must be 1-40 characters.', 'tags');
    }
  }
  return tags.map((t) => t.trim());
}

export function validateTagName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 40) {
    throw new ValidationError('name must be 1-40 characters.', 'name');
  }
  return name.trim();
}

export function validateTagSlug(slug) {
  if (typeof slug !== 'string' || slug.length < 1 || slug.length > 40 || !SLUG_RE.test(slug)) {
    throw new ValidationError('slug must match ^[a-z0-9]+(-[a-z0-9]+)*$, 1-40 characters.', 'slug');
  }
  return slug;
}

export function validateVisibility(visibility) {
  if (visibility === undefined) return 'public';
  if (visibility !== 'public' && visibility !== 'unlisted') {
    throw new ValidationError('visibility must be "public" or "unlisted".', 'visibility');
  }
  return visibility;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTHOR_ROLES = ['owner', 'editor', 'author'];

export function validateAuthorName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) {
    throw new ValidationError('name must be 1-100 characters.', 'name');
  }
  return name.trim();
}

/** Case-insensitive per email's own semantics — lower-cased so it matches however Access presents the identity's `email` claim, per docs/architecture.md §3. */
export function validateAuthorEmail(email) {
  if (typeof email !== 'string' || email.length > 200 || !EMAIL_RE.test(email)) {
    throw new ValidationError('email must be a valid email address.', 'email');
  }
  return email.trim().toLowerCase();
}

export function validateAuthorRole(role) {
  if (!AUTHOR_ROLES.includes(role)) {
    throw new ValidationError(`role must be one of: ${AUTHOR_ROLES.join(', ')}.`, 'role');
  }
  return role;
}

export function validateAuthorBio(bio) {
  if (bio === undefined || bio === null || bio === '') return null;
  if (typeof bio !== 'string' || bio.length > 500) {
    throw new ValidationError('bio must be at most 500 characters.', 'bio');
  }
  return bio;
}

export function validateScheduledFor(scheduledFor) {
  const date = new Date(scheduledFor);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new ValidationError('scheduled_for must be a valid date in the future.', 'scheduled_for');
  }
  return date.toISOString();
}

const NAV_URL_MAX_LENGTH = 500;
const NAV_LINK_NAME_MAX_LENGTH = 60;
const NAV_CUSTOM_LINKS_MAX = 20;
const NAV_FEATURE_KEYS = ['posts', 'archive', 'tags', 'about', 'rss'];

/** Absolute http(s) URL only — rejects `javascript:`/`data:` and anything unparseable. */
export function validateUrl(url, field = 'url') {
  if (typeof url !== 'string' || url.length < 1 || url.length > NAV_URL_MAX_LENGTH) {
    throw new ValidationError(`${field} must be 1-${NAV_URL_MAX_LENGTH} characters.`, field);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`${field} must be a valid absolute URL.`, field);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${field} must use http or https.`, field);
  }
  return url;
}

/**
 * Shape validated here (src/site-template.js's resolveNavConfig is what
 * interprets it — this only rejects malformed/unsafe input before it's
 * stored):
 *   { features: { <posts|archive|tags|about|rss>: { enabled?, header?, footer? } },
 *     custom_links: [{ name, url, header?, footer? }] }
 * Every field is optional (resolveNavConfig merges under its own defaults),
 * but whatever IS present must be well-formed.
 */
export function validateNavConfig(navConfig) {
  if (navConfig === null || typeof navConfig !== 'object' || Array.isArray(navConfig)) {
    throw new ValidationError('nav_config must be an object.', 'nav_config');
  }

  const { features, custom_links: customLinks } = navConfig;
  if (features !== undefined) {
    if (typeof features !== 'object' || features === null || Array.isArray(features)) {
      throw new ValidationError('nav_config.features must be an object.', 'nav_config');
    }
    for (const key of Object.keys(features)) {
      if (!NAV_FEATURE_KEYS.includes(key)) {
        throw new ValidationError(`nav_config.features has unknown key "${key}".`, 'nav_config');
      }
      const flags = features[key];
      if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) {
        throw new ValidationError(`nav_config.features.${key} must be an object.`, 'nav_config');
      }
      for (const flag of ['enabled', 'header', 'footer']) {
        if (flag in flags && typeof flags[flag] !== 'boolean') {
          throw new ValidationError(`nav_config.features.${key}.${flag} must be a boolean.`, 'nav_config');
        }
      }
    }
  }

  if (customLinks !== undefined) {
    if (!Array.isArray(customLinks) || customLinks.length > NAV_CUSTOM_LINKS_MAX) {
      throw new ValidationError(`nav_config.custom_links must be an array of at most ${NAV_CUSTOM_LINKS_MAX} items.`, 'nav_config');
    }
    for (const link of customLinks) {
      if (typeof link !== 'object' || link === null || Array.isArray(link)) {
        throw new ValidationError('Each custom link must be an object.', 'nav_config');
      }
      if (typeof link.name !== 'string' || link.name.trim().length < 1 || link.name.length > NAV_LINK_NAME_MAX_LENGTH) {
        throw new ValidationError(`Each custom link needs a name (1-${NAV_LINK_NAME_MAX_LENGTH} characters).`, 'nav_config');
      }
      validateUrl(link.url, 'custom link URL');
      for (const flag of ['header', 'footer']) {
        if (flag in link && typeof link[flag] !== 'boolean') {
          throw new ValidationError(`Each custom link's ${flag} must be a boolean.`, 'nav_config');
        }
      }
    }
  }

  return navConfig;
}

const ABOUT_CONTENT_MAX_BYTES = 20 * 1024;

export function validateAboutContent(aboutContent) {
  if (typeof aboutContent !== 'string') {
    throw new ValidationError('about_content must be a string.', 'about_content');
  }
  if (new TextEncoder().encode(aboutContent).length > ABOUT_CONTENT_MAX_BYTES) {
    throw new ValidationError('about_content must be at most 20 KB.', 'about_content');
  }
  return aboutContent;
}

/* --- Collections (migrations/0008_collections.sql) -------------------------
 * post_type/type_fields on a `posts` row, and the `collections` settings
 * entry that declares what post_types exist — see docs/vibecode-migration.md
 * for the shape. No CHECK constraint backs post_type (the migration's own
 * comment explains why), so this is the only place that actually enforces
 * "post_type is either 'post' or a real collection's type".
 */

const POST_TYPE_MAX_LENGTH = 40;

export function validatePostType(type, settings) {
  if (typeof type !== 'string' || type.length < 1 || type.length > POST_TYPE_MAX_LENGTH || !SLUG_RE.test(type)) {
    throw new ValidationError(`post_type must match ^[a-z0-9]+(-[a-z0-9]+)*$, 1-${POST_TYPE_MAX_LENGTH} characters.`, 'post_type');
  }
  if (type === 'post') return type;
  if (!resolveCollections(settings || {}).some((c) => c.type === type)) {
    throw new ValidationError(`Unknown post_type: "${type}". No collection is configured with that type.`, 'post_type');
  }
  return type;
}

// Governs type_fields value validation — a different axis from
// src/collections.js's FIELD_DISPLAYS (that's how a value renders; this is
// what shape it must be to be stored at all).
const FIELD_TYPES = ['text', 'enum', 'url', 'tags', 'date'];
const FIELD_TEXT_MAX_LENGTH = 200;
const FIELD_TAGS_MAX = 10;
const TYPE_FIELDS_MAX_BYTES = 8 * 1024;

function validateTypeFieldValue(key, value, spec) {
  switch (spec.type) {
    case 'text':
      if (typeof value !== 'string' || value.length > FIELD_TEXT_MAX_LENGTH) {
        throw new ValidationError(`type_fields.${key} must be a string, at most ${FIELD_TEXT_MAX_LENGTH} characters.`, 'type_fields');
      }
      return value;
    case 'enum': {
      const options = Array.isArray(spec.options) ? spec.options : [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new ValidationError(`type_fields.${key} must be one of: ${options.join(', ')}.`, 'type_fields');
      }
      return value;
    }
    case 'url':
      return validateUrl(value, `type_fields.${key}`);
    case 'tags': {
      const items = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(',').map((v) => v.trim()).filter(Boolean)
          : null;
      if (!items || items.length > FIELD_TAGS_MAX || items.some((v) => typeof v !== 'string' || !v.trim())) {
        throw new ValidationError(`type_fields.${key} must be an array or comma-separated string of at most ${FIELD_TAGS_MAX} entries.`, 'type_fields');
      }
      return items.map((v) => v.trim());
    }
    case 'date':
      if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
        throw new ValidationError(`type_fields.${key} must be an ISO-8601 date string.`, 'type_fields');
      }
      return value;
    default:
      throw new ValidationError(`type_fields.${key} has an unrecognised field type.`, 'type_fields');
  }
}

/**
 * Validates a post's type_fields against its collection's declared field
 * specs (collections[].fields, see docs/vibecode-migration.md). Any key not
 * declared in `fieldSpecs` is rejected outright — an unknown key would
 * otherwise sit in storage forever, invisible to every renderer that only
 * ever looks up fields it knows about.
 */
export function validateTypeFields(fields, fieldSpecs) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new ValidationError('type_fields must be an object.', 'type_fields');
  }

  const byKey = new Map((Array.isArray(fieldSpecs) ? fieldSpecs : []).map((spec) => [spec.key, spec]));
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const spec = byKey.get(key);
    if (!spec) throw new ValidationError(`Unknown type_fields key: "${key}".`, 'type_fields');
    out[key] = validateTypeFieldValue(key, value, spec);
  }

  if (new TextEncoder().encode(JSON.stringify(out)).length > TYPE_FIELDS_MAX_BYTES) {
    throw new ValidationError(`type_fields must be at most ${TYPE_FIELDS_MAX_BYTES / 1024} KB.`, 'type_fields');
  }
  return out;
}

const COLLECTIONS_MAX = 10;
const COLLECTION_TYPE_MAX_LENGTH = 40;
const COLLECTION_LABEL_MAX_LENGTH = 60;
const COLLECTION_FIELDS_MAX = 20;
const COLLECTION_FIELD_LABEL_MAX_LENGTH = 60;
const BASE_PATH_RE = /^\/[a-z0-9]+(-[a-z0-9]+)*$/;

// Every top-level path this Worker itself routes on (src/index.js,
// src/pages.js, src/feeds.js), plus the two page-shell-only paths
// (src/index.js's SHELL_ONLY_PREFIXES) — a collection's base_path/
// legacy_path colliding with any of these would shadow a real route.
const RESERVED_TOP_LEVEL_PATHS = new Set([
  '/', '/posts', '/post', '/archive', '/tags', '/about', '/admin', '/api',
  '/media', '/mcp', '/health', '/assets',
  '/feed.xml', '/atom.xml', '/rss.xml', '/sitemap.xml', '/robots.txt',
  '/collection', '/collection-item',
]);

function validateCollectionPath(path, field) {
  if (typeof path !== 'string' || !BASE_PATH_RE.test(path)) {
    throw new ValidationError(`${field} must be a "/"-prefixed, slug-shaped path (e.g. "/portfolio").`, 'collections');
  }
  if (RESERVED_TOP_LEVEL_PATHS.has(path)) {
    throw new ValidationError(`${field} "${path}" collides with a reserved path.`, 'collections');
  }
  return path;
}

function validateFieldSpecs(fields, collectionType) {
  if (!Array.isArray(fields) || fields.length > COLLECTION_FIELDS_MAX) {
    throw new ValidationError(`collections.${collectionType}.fields must be an array of at most ${COLLECTION_FIELDS_MAX} items.`, 'collections');
  }
  const keys = new Set();
  for (const spec of fields) {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new ValidationError(`Each field in collections.${collectionType}.fields must be an object.`, 'collections');
    }
    if (typeof spec.key !== 'string' || spec.key.length > 40 || !SLUG_RE.test(spec.key)) {
      throw new ValidationError(`Each field in collections.${collectionType}.fields needs a slug-shaped "key".`, 'collections');
    }
    if (keys.has(spec.key)) throw new ValidationError(`Duplicate field key in collections.${collectionType}.fields: "${spec.key}".`, 'collections');
    keys.add(spec.key);

    if (typeof spec.label !== 'string' || spec.label.trim().length < 1 || spec.label.length > COLLECTION_FIELD_LABEL_MAX_LENGTH) {
      throw new ValidationError(`Field "${spec.key}" needs a label, 1-${COLLECTION_FIELD_LABEL_MAX_LENGTH} characters.`, 'collections');
    }
    if (!FIELD_TYPES.includes(spec.type)) {
      throw new ValidationError(`Field "${spec.key}" type must be one of: ${FIELD_TYPES.join(', ')}.`, 'collections');
    }
    if (spec.type === 'enum' && (!Array.isArray(spec.options) || !spec.options.length)) {
      throw new ValidationError(`Field "${spec.key}" is an enum and needs non-empty "options".`, 'collections');
    }
    if (!FIELD_DISPLAYS.includes(spec.display)) {
      throw new ValidationError(`Field "${spec.key}" display must be one of: ${FIELD_DISPLAYS.join(', ')}.`, 'collections');
    }
  }
}

/**
 * Shape validated here (src/collections.js's resolveCollections is what
 * interprets it at read time — this only rejects malformed/unsafe input
 * before it's stored, same split as validateNavConfig/resolveNavConfig
 * above). `layout` and each field's `display` are checked against
 * src/collections.js's own fixed registries — the same source of truth its
 * renderers dispatch on — so a value that would pass validation but hit no
 * renderer at read time can't happen.
 */
export function validateCollections(config) {
  if (!Array.isArray(config)) throw new ValidationError('collections must be an array.', 'collections');
  if (config.length > COLLECTIONS_MAX) {
    throw new ValidationError(`At most ${COLLECTIONS_MAX} collections.`, 'collections');
  }

  const types = new Set();
  const basePaths = new Set();

  for (const collection of config) {
    if (typeof collection !== 'object' || collection === null || Array.isArray(collection)) {
      throw new ValidationError('Each collection must be an object.', 'collections');
    }

    const type = collection.type;
    if (typeof type !== 'string' || type.length < 1 || type.length > COLLECTION_TYPE_MAX_LENGTH || !SLUG_RE.test(type)) {
      throw new ValidationError('Each collection needs a slug-shaped "type", 1-40 characters.', 'collections');
    }
    if (types.has(type)) throw new ValidationError(`Duplicate collection type: "${type}".`, 'collections');
    types.add(type);

    if (typeof collection.label !== 'string' || collection.label.trim().length < 1 || collection.label.length > COLLECTION_LABEL_MAX_LENGTH) {
      throw new ValidationError(`collections.${type}.label must be 1-${COLLECTION_LABEL_MAX_LENGTH} characters.`, 'collections');
    }
    if (collection.label_plural !== undefined && (typeof collection.label_plural !== 'string' || collection.label_plural.length > COLLECTION_LABEL_MAX_LENGTH)) {
      throw new ValidationError(`collections.${type}.label_plural must be at most ${COLLECTION_LABEL_MAX_LENGTH} characters.`, 'collections');
    }
    if (collection.index_title !== undefined && (typeof collection.index_title !== 'string' || collection.index_title.length > COLLECTION_LABEL_MAX_LENGTH)) {
      throw new ValidationError(`collections.${type}.index_title must be at most ${COLLECTION_LABEL_MAX_LENGTH} characters.`, 'collections');
    }

    validateCollectionPath(collection.base_path, `collections.${type}.base_path`);
    if (basePaths.has(collection.base_path)) {
      throw new ValidationError(`Duplicate collection base_path: "${collection.base_path}".`, 'collections');
    }
    basePaths.add(collection.base_path);

    if (collection.legacy_path !== undefined && collection.legacy_path !== null) {
      validateCollectionPath(collection.legacy_path, `collections.${type}.legacy_path`);
    }

    if (!LAYOUTS.includes(collection.layout)) {
      throw new ValidationError(`collections.${type}.layout must be one of: ${LAYOUTS.join(', ')}.`, 'collections');
    }

    for (const flag of ['in_feed', 'in_sitemap']) {
      if (collection[flag] !== undefined && typeof collection[flag] !== 'boolean') {
        throw new ValidationError(`collections.${type}.${flag} must be a boolean.`, 'collections');
      }
    }

    if (collection.nav !== undefined) {
      if (typeof collection.nav !== 'object' || collection.nav === null || Array.isArray(collection.nav)) {
        throw new ValidationError(`collections.${type}.nav must be an object.`, 'collections');
      }
      for (const key of ['header', 'footer']) {
        if (key in collection.nav && typeof collection.nav[key] !== 'boolean') {
          throw new ValidationError(`collections.${type}.nav.${key} must be a boolean.`, 'collections');
        }
      }
    }

    validateFieldSpecs(collection.fields, type);
  }

  return config;
}
