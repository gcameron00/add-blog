import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { writeAuditLog } from './audit.js';

describe('writeAuditLog', () => {
  it('writes a row queryable back out with the given fields', async () => {
    await writeAuditLog(env.DB, {
      actor: 'grant@mysite.com',
      via: 'ui',
      action: 'post.publish',
      entity: 'post',
      entityId: 'p1',
      detail: { slug: 'hello-world' },
    });

    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE actor = ? AND action = ? ORDER BY created_at DESC LIMIT 1`)
      .bind('grant@mysite.com', 'post.publish')
      .first();

    expect(row).toMatchObject({ actor: 'grant@mysite.com', via: 'ui', action: 'post.publish', entity: 'post', entity_id: 'p1' });
    expect(JSON.parse(row.detail)).toEqual({ slug: 'hello-world' });
    expect(row.created_at).toBeTruthy();
  });

  it('allows a null entity/detail for actions with no single target', async () => {
    await writeAuditLog(env.DB, { actor: 'ada@mysite.com', via: 'mcp', action: 'settings.update' });
    const row = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE actor = ? AND action = ?`)
      .bind('ada@mysite.com', 'settings.update')
      .first();
    expect(row.entity).toBeNull();
    expect(row.detail).toBeNull();
  });
});
