/**
 * Shared request-body validation for the admin write API (Phase 5), per
 * docs/api.md's "Conventions" and Posts sections. Every check throws a
 * ValidationError shaped like the API's error envelope, so route handlers
 * validate a whole body in a line or two and let one catch produce the 400.
 */

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
