import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { can, permissionsFor, resolveAuthor } from './auth.js';

describe('resolveAuthor', () => {
  it('finds the seeded owner by email', async () => {
    const author = await resolveAuthor(env.DB, 'grant@mysite.com');
    expect(author).toMatchObject({ email: 'grant@mysite.com', role: 'owner' });
  });

  it('finds the seeded editor by email', async () => {
    const author = await resolveAuthor(env.DB, 'ada@mysite.com');
    expect(author).toMatchObject({ email: 'ada@mysite.com', role: 'editor' });
  });

  it('returns null for an identity with no authors row', async () => {
    // Per docs/architecture.md §6: a verified Access identity with no
    // matching row must not resolve to an implicit account.
    const author = await resolveAuthor(env.DB, 'nobody@mysite.com');
    expect(author).toBeFalsy();
  });

  it('returns null for a disabled author, same as a missing row', async () => {
    await env.DB
      .prepare(`INSERT OR IGNORE INTO authors (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
      .bind('a-disabled', 'disabled@mysite.com', 'Disabled Author', 'author', '2026-07-01T00:00:00Z')
      .run();
    const author = await resolveAuthor(env.DB, 'disabled@mysite.com');
    expect(author).toBeFalsy();
  });
});

describe('can', () => {
  it('grants owner-only actions to owner but not editor or author', () => {
    expect(can('owner', 'settings.manage')).toBe(true);
    expect(can('editor', 'settings.manage')).toBe(false);
    expect(can('author', 'settings.manage')).toBe(false);
  });

  it('grants publish to owner and editor but not author', () => {
    expect(can('owner', 'post.publish')).toBe(true);
    expect(can('editor', 'post.publish')).toBe(true);
    expect(can('author', 'post.publish')).toBe(false);
  });

  it('grants editing own drafts to every role', () => {
    for (const role of ['owner', 'editor', 'author']) {
      expect(can(role, 'post.editOwn')).toBe(true);
    }
  });

  it('denies unknown permissions by default', () => {
    expect(can('owner', 'not.a.real.permission')).toBe(false);
  });
});

describe('permissionsFor', () => {
  it('matches the role table in docs/architecture.md §6', () => {
    expect(permissionsFor('author')).toEqual(
      expect.arrayContaining(['post.editOwn', 'media.upload'])
    );
    expect(permissionsFor('author')).not.toEqual(expect.arrayContaining(['post.publish']));
    expect(permissionsFor('owner')).toEqual(expect.arrayContaining(['settings.manage', 'authors.manage']));
  });
});
