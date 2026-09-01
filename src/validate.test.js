import { describe, expect, it } from 'vitest';
import { ValidationError, validateCollections, validatePostType, validateTypeFields } from './validate.js';

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
    { key: 'status', label: 'Status', type: 'enum', options: ['Live', 'In Progress', 'On hold', 'Archived'], display: 'badge' },
    { key: 'tech', label: 'Tech', type: 'tags', display: 'chips' },
    { key: 'url', label: 'Live', type: 'url', display: 'link' },
    { key: 'repo', label: 'Repo', type: 'url', display: 'link' },
  ],
};

const SETTINGS_WITH_PROJECT = { collections: [PROJECT_COLLECTION] };

describe('validatePostType', () => {
  it('accepts "post" regardless of the collections registry', () => {
    expect(validatePostType('post', {})).toBe('post');
    expect(validatePostType('post', SETTINGS_WITH_PROJECT)).toBe('post');
  });

  it('accepts a type present in the site\'s collections', () => {
    expect(validatePostType('project', SETTINGS_WITH_PROJECT)).toBe('project');
  });

  it('rejects a type not present in the site\'s collections', () => {
    expect(() => validatePostType('project', {})).toThrow(ValidationError);
    expect(() => validatePostType('recipe', SETTINGS_WITH_PROJECT)).toThrow(ValidationError);
  });

  it('rejects a non-slug-shaped value before even checking the registry', () => {
    expect(() => validatePostType('Not A Slug', SETTINGS_WITH_PROJECT)).toThrow(ValidationError);
    expect(() => validatePostType('', SETTINGS_WITH_PROJECT)).toThrow(ValidationError);
    expect(() => validatePostType(42, SETTINGS_WITH_PROJECT)).toThrow(ValidationError);
  });

  it('rejects a value over 40 characters', () => {
    expect(() => validatePostType('a'.repeat(41), SETTINGS_WITH_PROJECT)).toThrow(ValidationError);
  });

  it('tags the error field as post_type', () => {
    try {
      validatePostType('nope', {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('post_type');
    }
  });
});

describe('validateTypeFields', () => {
  const fields = PROJECT_COLLECTION.fields;

  it('returns {} for undefined/null', () => {
    expect(validateTypeFields(undefined, fields)).toEqual({});
    expect(validateTypeFields(null, fields)).toEqual({});
  });

  it('rejects a non-object', () => {
    expect(() => validateTypeFields('nope', fields)).toThrow(ValidationError);
    expect(() => validateTypeFields(['nope'], fields)).toThrow(ValidationError);
  });

  it('rejects a key not declared in the field spec', () => {
    expect(() => validateTypeFields({ nonexistent: 'x' }, fields)).toThrow(ValidationError);
  });

  it('validates an enum field against its options', () => {
    expect(validateTypeFields({ status: 'Live' }, fields)).toEqual({ status: 'Live' });
    expect(() => validateTypeFields({ status: 'Not An Option' }, fields)).toThrow(ValidationError);
  });

  it('validates a url field, reusing validateUrl (rejects javascript:)', () => {
    expect(validateTypeFields({ url: 'https://example.com' }, fields)).toEqual({ url: 'https://example.com' });
    expect(() => validateTypeFields({ url: 'javascript:alert(1)' }, fields)).toThrow(ValidationError);
  });

  it('validates a tags field as an array or comma-separated string, capped at 10', () => {
    expect(validateTypeFields({ tech: ['Cloudflare', 'Workers'] }, fields)).toEqual({ tech: ['Cloudflare', 'Workers'] });
    expect(validateTypeFields({ tech: 'Cloudflare, Workers' }, fields)).toEqual({ tech: ['Cloudflare', 'Workers'] });
    expect(() => validateTypeFields({ tech: Array.from({ length: 11 }, (_, i) => `t${i}`) }, fields)).toThrow(ValidationError);
  });

  it('validates a text field for type/length', () => {
    const textFields = [{ key: 'note', label: 'Note', type: 'text', display: 'text' }];
    expect(validateTypeFields({ note: 'hello' }, textFields)).toEqual({ note: 'hello' });
    expect(() => validateTypeFields({ note: 'x'.repeat(201) }, textFields)).toThrow(ValidationError);
    expect(() => validateTypeFields({ note: 42 }, textFields)).toThrow(ValidationError);
  });

  it('validates a date field as a parseable ISO-8601 string', () => {
    const dateFields = [{ key: 'launched', label: 'Launched', type: 'date', display: 'date' }];
    expect(validateTypeFields({ launched: '2026-01-15' }, dateFields)).toEqual({ launched: '2026-01-15' });
    expect(() => validateTypeFields({ launched: 'not a date' }, dateFields)).toThrow(ValidationError);
  });

  it('rejects a payload over 8KB total', () => {
    const tagsField = [{ key: 'tech', label: 'Tech', type: 'tags', display: 'chips' }];
    const hugeTags = Array.from({ length: 10 }, (_, i) => 'x'.repeat(1000) + i);
    expect(() => validateTypeFields({ tech: hugeTags }, tagsField)).toThrow(ValidationError);
  });
});

describe('validateCollections', () => {
  it('accepts a well-formed collections array', () => {
    expect(validateCollections([PROJECT_COLLECTION])).toEqual([PROJECT_COLLECTION]);
  });

  it('accepts an empty array (the feature-off default)', () => {
    expect(validateCollections([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(() => validateCollections({})).toThrow(ValidationError);
    expect(() => validateCollections(null)).toThrow(ValidationError);
  });

  it('rejects more than 10 collections', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...PROJECT_COLLECTION, type: `type${i}`, base_path: `/path${i}` }));
    expect(() => validateCollections(many)).toThrow(ValidationError);
  });

  it('rejects a duplicate type', () => {
    const dup = [PROJECT_COLLECTION, { ...PROJECT_COLLECTION, base_path: '/other' }];
    expect(() => validateCollections(dup)).toThrow(ValidationError);
  });

  it('rejects a duplicate base_path', () => {
    const dup = [PROJECT_COLLECTION, { ...PROJECT_COLLECTION, type: 'other' }];
    expect(() => validateCollections(dup)).toThrow(ValidationError);
  });

  it('rejects a base_path that is not "/"-prefixed and slug-shaped', () => {
    expect(() => validateCollections([{ ...PROJECT_COLLECTION, base_path: 'portfolio' }])).toThrow(ValidationError);
    expect(() => validateCollections([{ ...PROJECT_COLLECTION, base_path: '/Portfolio Items' }])).toThrow(ValidationError);
  });

  it('rejects a base_path colliding with a reserved top-level path', () => {
    for (const reserved of ['/posts', '/admin', '/api', '/mcp', '/media', '/collection', '/collection-item']) {
      expect(() => validateCollections([{ ...PROJECT_COLLECTION, base_path: reserved }])).toThrow(ValidationError);
    }
  });

  it('rejects an unrecognised layout', () => {
    expect(() => validateCollections([{ ...PROJECT_COLLECTION, layout: 'carousel' }])).toThrow(ValidationError);
  });

  it('rejects an unrecognised field display', () => {
    const bad = { ...PROJECT_COLLECTION, fields: [{ key: 'x', label: 'X', type: 'text', display: 'marquee' }] };
    expect(() => validateCollections([bad])).toThrow(ValidationError);
  });

  it('rejects an unrecognised field type', () => {
    const bad = { ...PROJECT_COLLECTION, fields: [{ key: 'x', label: 'X', type: 'currency', display: 'text' }] };
    expect(() => validateCollections([bad])).toThrow(ValidationError);
  });

  it('rejects an enum field with no options', () => {
    const bad = { ...PROJECT_COLLECTION, fields: [{ key: 'x', label: 'X', type: 'enum', display: 'badge', options: [] }] };
    expect(() => validateCollections([bad])).toThrow(ValidationError);
  });

  it('rejects a duplicate field key within one collection', () => {
    const bad = {
      ...PROJECT_COLLECTION,
      fields: [
        { key: 'x', label: 'X', type: 'text', display: 'text' },
        { key: 'x', label: 'X again', type: 'text', display: 'text' },
      ],
    };
    expect(() => validateCollections([bad])).toThrow(ValidationError);
  });

  it('rejects a collection missing a label', () => {
    const { label, ...rest } = PROJECT_COLLECTION;
    expect(() => validateCollections([rest])).toThrow(ValidationError);
  });
});
