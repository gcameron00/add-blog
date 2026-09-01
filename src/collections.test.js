import { describe, expect, it } from 'vitest';
import {
  findCollectionByLegacyPath,
  findCollectionByPath,
  findCollectionByType,
  renderCollectionIndex,
  renderCollectionItem,
  renderFieldChips,
  renderFieldLink,
  renderFieldPanel,
  renderStatusBadge,
  resolveCollections,
} from './collections.js';

const XSS = '<script>alert(1)</script>';

const PROJECT_COLLECTION = {
  type: 'project',
  label: 'Project',
  label_plural: 'Projects',
  base_path: '/portfolio',
  legacy_path: '/project',
  index_title: 'Portfolio',
  layout: 'grid',
  in_feed: false,
  in_sitemap: true,
  nav: { header: true, footer: false },
  fields: [
    { key: 'status', label: 'Status', type: 'enum', options: ['Live', 'Archived'], display: 'badge' },
    { key: 'tech', label: 'Tech', type: 'tags', display: 'chips' },
    { key: 'url', label: 'Live', type: 'url', display: 'link' },
  ],
};

describe('resolveCollections', () => {
  it('returns [] for missing settings.collections', () => {
    expect(resolveCollections({})).toEqual([]);
    expect(resolveCollections(undefined)).toEqual([]);
  });

  it('returns [] and never throws for malformed input', () => {
    expect(resolveCollections({ collections: 'not json' })).toEqual([]);
    expect(resolveCollections({ collections: 42 })).toEqual([]);
    expect(resolveCollections({ collections: null })).toEqual([]);
    expect(() => resolveCollections(null)).not.toThrow();
    expect(resolveCollections(null)).toEqual([]);
  });

  it('parses a JSON-string value the same as an already-parsed array (src/db.js getSettings can hand back either)', () => {
    expect(resolveCollections({ collections: JSON.stringify([PROJECT_COLLECTION]) })).toEqual([PROJECT_COLLECTION]);
  });

  it('filters out malformed entries within an otherwise-valid array rather than rejecting the whole thing', () => {
    const result = resolveCollections({ collections: [PROJECT_COLLECTION, { type: 'bad' }, null, 'nope'] });
    expect(result).toEqual([PROJECT_COLLECTION]);
  });

  it('returns a real collection unchanged', () => {
    expect(resolveCollections({ collections: [PROJECT_COLLECTION] })).toEqual([PROJECT_COLLECTION]);
  });
});

describe('findCollectionByPath', () => {
  const other = { ...PROJECT_COLLECTION, type: 'note', base_path: '/portfolio-extra' };
  const collections = [PROJECT_COLLECTION, other];

  it('matches the exact base_path', () => {
    expect(findCollectionByPath(collections, '/portfolio')).toBe(PROJECT_COLLECTION);
  });

  it('matches with a trailing slash', () => {
    expect(findCollectionByPath(collections, '/portfolio/')).toBe(PROJECT_COLLECTION);
  });

  it('matches an item path under the base_path', () => {
    expect(findCollectionByPath(collections, '/portfolio/some-item')).toBe(PROJECT_COLLECTION);
  });

  it('does not let a shorter base_path shadow a longer one that also prefixes the pathname', () => {
    expect(findCollectionByPath(collections, '/portfolio-extra/thing')).toBe(other);
  });

  it('returns null for a path outside every collection', () => {
    expect(findCollectionByPath(collections, '/nope')).toBeNull();
  });

  it('returns null for an empty registry', () => {
    expect(findCollectionByPath([], '/portfolio')).toBeNull();
  });
});

describe('findCollectionByLegacyPath', () => {
  it('matches the legacy_path with or without a trailing slash', () => {
    expect(findCollectionByLegacyPath([PROJECT_COLLECTION], '/project')).toBe(PROJECT_COLLECTION);
    expect(findCollectionByLegacyPath([PROJECT_COLLECTION], '/project/')).toBe(PROJECT_COLLECTION);
  });

  it('returns null for anything else', () => {
    expect(findCollectionByLegacyPath([PROJECT_COLLECTION], '/projects')).toBeNull();
    expect(findCollectionByLegacyPath([], '/project')).toBeNull();
  });
});

describe('findCollectionByType', () => {
  it('finds by type', () => {
    expect(findCollectionByType([PROJECT_COLLECTION], 'project')).toBe(PROJECT_COLLECTION);
  });

  it('returns null when no collection has that type', () => {
    expect(findCollectionByType([PROJECT_COLLECTION], 'nope')).toBeNull();
  });
});

describe('XSS-safety — every renderer escapes rather than passing through', () => {
  it('renderStatusBadge escapes a malicious value', () => {
    const html = renderStatusBadge(XSS);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderFieldChips escapes each chip', () => {
    const html = renderFieldChips([XSS, 'safe']);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderFieldLink escapes the href/text', () => {
    const html = renderFieldLink(`javascript:alert(1)"><script>alert(2)</script>`);
    expect(html).not.toContain('<script>');
  });

  it('renderFieldPanel escapes field labels and values, and omits fields the item does not carry', () => {
    const html = renderFieldPanel({ status: 'Live' }, [
      { key: 'status', label: XSS, type: 'enum', options: ['Live'], display: 'badge' },
      { key: 'tech', label: 'Tech', type: 'tags', display: 'chips' }, // absent from typeFields — must not render a row
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('Tech'); // the field the item doesn't have gets no row
  });

  it('renderFieldPanel returns "" for an item with no matching fields', () => {
    expect(renderFieldPanel({}, PROJECT_COLLECTION.fields)).toBe('');
    expect(renderFieldPanel(null, PROJECT_COLLECTION.fields)).toBe('');
  });

  it('renderCollectionIndex (grid layout) escapes an item title/excerpt containing a script tag', () => {
    const html = renderCollectionIndex(
      [{ slug: 'x', title: XSS, excerpt: XSS, cover: null, type_fields: {} }],
      PROJECT_COLLECTION
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderCollectionIndex (list layout) escapes an item title', () => {
    const html = renderCollectionIndex(
      [{ slug: 'x', title: XSS, cover: null, type_fields: {} }],
      { ...PROJECT_COLLECTION, layout: 'list' }
    );
    expect(html).not.toContain('<script>');
  });

  it('renders an empty-state message rather than an empty list when there are no items', () => {
    const html = renderCollectionIndex([], PROJECT_COLLECTION);
    expect(html).not.toContain('<ul');
    expect(html.toLowerCase()).toContain('no');
  });

  it('renderCollectionItem escapes title, subtitle and cover alt', () => {
    const html = renderCollectionItem(
      { slug: 'x', title: XSS, subtitle: XSS, cover: { url: '/media/x.jpg', alt: XSS }, type_fields: {}, body_html: '<p>safe body</p>' },
      PROJECT_COLLECTION
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // body_html is trusted, server-rendered content (same contract as
    // src/pages.js's renderArticle) — passed through, not escaped.
    expect(html).toContain('<p>safe body</p>');
  });
});
