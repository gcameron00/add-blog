/**
 * Phase 6 — MCP server (src/mcp.js). Calls `handleMcp` directly with a
 * manufactured `identity`, same pattern as src/admin-posts.test.js: the
 * Access-JWT-to-identity step is src/access.js's job and is already covered
 * by src/admin-guard.test.js (including the "/mcp 401s with no JWT" case
 * ahead of this file existing at all).
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleMcp } from './mcp.js';
import { resolveAuthor } from './auth.js';

const ADMIN_HOST = 'blog-admin.mysite.com';
let rpcId = 0;

function rpcRequest(method, params, { id = ++rpcId, sessionId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const body = { jsonrpc: '2.0', method, params };
  if (id !== null) body.id = id;
  return new Request(`https://${ADMIN_HOST}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function call(identity, request) {
  const url = new URL(request.url);
  const ctx = createExecutionContext();
  const response = await handleMcp(request, url, { env, ctx, identity });
  await waitOnExecutionContext(ctx);
  return response;
}

async function rpc(identity, method, params, opts) {
  const res = await call(identity, rpcRequest(method, params, opts));
  return { res, body: await res.json() };
}

async function initialize(identity) {
  const { res, body } = await rpc(identity, 'initialize', { protocolVersion: '2025-06-18' });
  return { sessionId: res.headers.get('Mcp-Session-Id'), body };
}

let owner;
let editor;
let author;

beforeAll(async () => {
  owner = { email: 'grant@mysite.com', author: await resolveAuthor(env.DB, 'grant@mysite.com') };
  editor = { email: 'ada@mysite.com', author: await resolveAuthor(env.DB, 'ada@mysite.com') };
  await env.DB
    .prepare(`INSERT OR IGNORE INTO authors (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('mcp-a1', 'mcp-author-role@mysite.com', 'MCP Author Role', 'author', '2026-07-01T00:00:00Z')
    .run();
  author = { email: 'mcp-author-role@mysite.com', author: await resolveAuthor(env.DB, 'mcp-author-role@mysite.com') };
});

describe('initialize', () => {
  it('mints a session id and names the actual site in serverInfo, not a static "add-blog"', async () => {
    const { sessionId, body } = await initialize(owner);
    expect(sessionId).toBeTruthy();
    expect(body.result.serverInfo.name).toContain('add-blog');
    expect(body.result.serverInfo.name).not.toBe('add-blog');
  });
});

describe('tools/list — filtered by role', () => {
  it('owner sees every tool, including update_site_settings', async () => {
    const { body } = await rpc(owner, 'tools/list');
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('update_site_settings');
    expect(names).toContain('publish_post');
    expect(names).toContain('list_posts');
  });

  it('author does not see publish_post, delete_post or update_site_settings', async () => {
    const { body } = await rpc(author, 'tools/list');
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('create_post');
    expect(names).not.toContain('publish_post');
    expect(names).not.toContain('delete_post');
    expect(names).not.toContain('update_site_settings');
  });

  it('every tool description names the actual site, so two connected blogs are distinguishable', async () => {
    const { body } = await rpc(owner, 'tools/list');
    for (const tool of body.result.tools) {
      expect(tool.description).toContain('The add-blog Journal'); // seed.sql's site_title
    }
  });
});

describe('tools/call — read tools', () => {
  it('list_posts returns metadata without bodies', async () => {
    const { body } = await rpc(owner, 'tools/call', { name: 'list_posts', arguments: { status: 'published', limit: 5 } });
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.data.length).toBeGreaterThan(0);
    expect(body.result.structuredContent.data[0]).not.toHaveProperty('body_md');
  });

  it('get_post resolves by slug and omits body_html unless asked for', async () => {
    const { body } = await rpc(owner, 'tools/call', { name: 'get_post', arguments: { slug: 'shipping-a-blog-on-cloudflare-workers' } });
    expect(body.result.structuredContent.title).toContain('Shipping a blog');
    expect(body.result.structuredContent.body_html).toBeUndefined();
  });

  it('search_posts requires a query', async () => {
    const { body } = await rpc(owner, 'tools/call', { name: 'search_posts', arguments: {} });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe('bad_request');
  });

  it('list_tags returns an object, not a bare array — structuredContent must be a JSON object per the MCP spec', async () => {
    const { body } = await rpc(owner, 'tools/call', { name: 'list_tags', arguments: {} });
    expect(body.result.isError).toBeFalsy();
    expect(Array.isArray(body.result.structuredContent)).toBe(false);
    expect(Array.isArray(body.result.structuredContent.data)).toBe(true);
  });
});

describe('tools/call — permission enforced at call time, not just at listing time', () => {
  it('an author calling publish_post directly gets a forbidden tool error, not a crash', async () => {
    const { body } = await rpc(author, 'tools/call', { name: 'publish_post', arguments: { slug: 'shipping-a-blog-on-cloudflare-workers' } });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe('forbidden');
  });

  it('an unknown tool name is rejected the same way', async () => {
    const { body } = await rpc(owner, 'tools/call', { name: 'delete_everything', arguments: {} });
    expect(body.result.isError).toBe(true);
  });
});

describe('tools/call — writing', () => {
  it('create_post forces status to draft regardless of what is passed, and logs the call', async () => {
    const { body } = await rpc(author, 'tools/call', {
      name: 'create_post',
      arguments: { title: 'MCP-created post', body_md: 'Hello from a tool call.', status: 'published' },
    });
    expect(body.result.structuredContent.status).toBe('draft');

    const audit = await env.DB
      .prepare(`SELECT * FROM audit_log WHERE via = 'mcp' AND action = 'mcp.create_post' AND entity_id = ?`)
      .bind(body.result.structuredContent.id)
      .first();
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe('mcp-author-role@mysite.com');
  });

  it('update_post honours expected_updated_at as an optimistic-concurrency check', async () => {
    const { body: created } = await rpc(author, 'tools/call', {
      name: 'create_post', arguments: { title: 'Concurrency check post', body_md: 'v1' },
    });
    const post = created.result.structuredContent;

    const { body: stale } = await rpc(author, 'tools/call', {
      name: 'update_post',
      arguments: { id: post.id, body_md: 'v2', expected_updated_at: '2020-01-01T00:00:00.000Z' },
    });
    expect(stale.result.isError).toBe(true);
    expect(JSON.parse(stale.result.content[0].text).error.code).toBe('conflict');

    const { body: fresh } = await rpc(author, 'tools/call', {
      name: 'update_post', arguments: { id: post.id, body_md: 'v2', expected_updated_at: post.updated_at },
    });
    expect(fresh.result.isError).toBeFalsy();
    expect(fresh.result.structuredContent.body_md).toBe('v2');
  });

  it('an author cannot edit another author\'s post', async () => {
    const { body } = await rpc(author, 'tools/call', {
      name: 'update_post', arguments: { slug: 'shipping-a-blog-on-cloudflare-workers', title: 'Hijacked' },
    });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.code).toBe('forbidden');
  });
});

/* --- Collections (migrations/0008_collections.sql) ------------------------- */

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
  fields: [{ key: 'status', label: 'Status', type: 'enum', options: ['Live', 'Archived'], display: 'badge' }],
};

async function setCollectionsSetting(collections) {
  await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'collections'`).bind(JSON.stringify(collections)).run();
}

describe('list_collections', () => {
  it('is visible to every role, including read/author', async () => {
    await setCollectionsSetting([PROJECT_COLLECTION]);
    const { body } = await rpc(author, 'tools/list');
    expect(body.result.tools.map((t) => t.name)).toContain('list_collections');
  });

  it('returns the site\'s collection registry, field specs included', async () => {
    await setCollectionsSetting([PROJECT_COLLECTION]);
    const { body } = await rpc(author, 'tools/call', { name: 'list_collections', arguments: {} });
    // structuredContent must be a JSON object per the MCP spec — a bare
    // array fails schema validation client-side (confirmed against a real
    // MCP client), so this is wrapped the same way every other list_* tool's
    // array payload is.
    expect(body.result.structuredContent).toEqual({ data: [PROJECT_COLLECTION] });
  });

  it('returns { data: [] } when no collections are configured', async () => {
    await setCollectionsSetting([]);
    const { body } = await rpc(author, 'tools/call', { name: 'list_collections', arguments: {} });
    expect(body.result.structuredContent).toEqual({ data: [] });
  });
});

describe('update_site_settings — collections has a real schema, not {}', () => {
  it("tools/list exposes a structured schema for the collections property", async () => {
    const { body } = await rpc(owner, 'tools/list');
    const tool = body.result.tools.find((t) => t.name === 'update_site_settings');
    const schema = tool.inputSchema.properties.collections;
    expect(schema.type).toBe('array');
    expect(schema.items.required).toEqual(expect.arrayContaining(['type', 'label', 'base_path', 'layout', 'fields']));
    expect(schema.items.properties.layout.enum).toEqual(['grid', 'list']);
    expect(schema.items.properties.fields.items.properties.type.enum).toContain('enum');
  });

  it('a client can create a new collection through update_site_settings using only that schema', async () => {
    await setCollectionsSetting([]);
    const { body } = await rpc(owner, 'tools/call', {
      name: 'update_site_settings',
      arguments: { collections: [PROJECT_COLLECTION] },
    });
    expect(body.result.isError).toBeFalsy();

    const { body: listed } = await rpc(owner, 'tools/call', { name: 'list_collections', arguments: {} });
    expect(listed.result.structuredContent).toEqual({ data: [PROJECT_COLLECTION] });
  });
});

describe('create_post / update_post — post_type and type_fields', () => {
  it('create_post accepts a configured post_type and type_fields', async () => {
    await setCollectionsSetting([PROJECT_COLLECTION]);
    const { body } = await rpc(author, 'tools/call', {
      name: 'create_post',
      arguments: { title: 'MCP-created project', post_type: 'project', type_fields: { status: 'Live' } },
    });
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.post_type).toBe('project');
    expect(body.result.structuredContent.type_fields).toEqual({ status: 'Live' });
  });

  it('create_post rejects an unconfigured post_type', async () => {
    await setCollectionsSetting([]);
    const { body } = await rpc(author, 'tools/call', {
      name: 'create_post', arguments: { title: 'Bad type', post_type: 'project' },
    });
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error.field).toBe('post_type');
  });

  it('update_post can change type_fields but not post_type', async () => {
    await setCollectionsSetting([PROJECT_COLLECTION]);
    const { body: created } = await rpc(author, 'tools/call', {
      name: 'create_post',
      arguments: { title: 'MCP project to edit', post_type: 'project', type_fields: { status: 'Live' } },
    });
    const post = created.result.structuredContent;

    const { body: updated } = await rpc(author, 'tools/call', {
      name: 'update_post', arguments: { id: post.id, type_fields: { status: 'Archived' } },
    });
    expect(updated.result.isError).toBeFalsy();
    expect(updated.result.structuredContent.type_fields).toEqual({ status: 'Archived' });

    const { body: rejected } = await rpc(author, 'tools/call', {
      name: 'update_post', arguments: { id: post.id, post_type: 'post' },
    });
    expect(rejected.result.isError).toBe(true);
    expect(JSON.parse(rejected.result.content[0].text).error.field).toBe('post_type');
  });
});

describe('resources', () => {
  it('resources/list only offers style-guide', async () => {
    const { body } = await rpc(owner, 'resources/list');
    expect(body.result.resources.map((r) => r.uri)).toEqual(['blog://style-guide']);
  });

  it('resources/read returns the style guide text from settings', async () => {
    await rpc(owner, 'tools/call', { name: 'update_site_settings', arguments: { style_guide: 'Write short sentences.' } });
    const { body } = await rpc(owner, 'resources/read', { uri: 'blog://style-guide' });
    expect(body.result.contents[0].text).toBe('Write short sentences.');
  });

  it('an unknown resource uri is an error', async () => {
    const { body } = await rpc(owner, 'resources/read', { uri: 'blog://nope' });
    expect(body.error.code).toBe(-32602);
  });
});

describe('prompts', () => {
  it('prompts/list returns all five, unfiltered by role', async () => {
    const { body } = await rpc(author, 'prompts/list');
    expect(body.result.prompts.map((p) => p.name).sort()).toEqual(
      ['content_audit', 'draft_post', 'edit_post', 'suggest_tags', 'write_excerpt'].sort()
    );
  });

  it('write_excerpt embeds the real post body', async () => {
    const { body } = await rpc(owner, 'prompts/get', { name: 'write_excerpt', arguments: { slug: 'shipping-a-blog-on-cloudflare-workers' } });
    expect(body.result.messages[0].content.text).toContain('Shipping a blog on Cloudflare Workers');
  });

  it('edit_post 404s a slug that does not exist', async () => {
    const { body } = await rpc(owner, 'prompts/get', { name: 'edit_post', arguments: { slug: 'no-such-post', instruction: 'fix it' } });
    expect(body.error).toBeTruthy();
  });
});

describe('sessions', () => {
  it('a session id from one identity is rejected for another', async () => {
    const { sessionId } = await initialize(owner);
    const { res } = await rpc(editor, 'tools/list', undefined, { sessionId });
    expect(res.status).toBe(404);
  });

  it('DELETE ends a session', async () => {
    const { sessionId } = await initialize(owner);
    const ctx = createExecutionContext();
    const del = await handleMcp(
      new Request(`https://${ADMIN_HOST}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } }),
      new URL(`https://${ADMIN_HOST}/mcp`),
      { env, ctx, identity: owner }
    );
    await waitOnExecutionContext(ctx);
    expect(del.status).toBe(204);

    const row = await env.DB.prepare(`SELECT 1 FROM mcp_sessions WHERE id = ?`).bind(sessionId).first();
    expect(row).toBeFalsy();
  });
});

describe('protocol edge cases', () => {
  it('GET is not supported (no server-initiated messages to stream)', async () => {
    const ctx = createExecutionContext();
    const res = await handleMcp(
      new Request(`https://${ADMIN_HOST}/mcp`, { method: 'GET' }),
      new URL(`https://${ADMIN_HOST}/mcp`),
      { env, ctx, identity: owner }
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it('a notification (no id) gets 202 and no body', async () => {
    const res = await call(owner, rpcRequest('notifications/initialized', {}, { id: null }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('an unknown method is a JSON-RPC method-not-found error', async () => {
    const { body } = await rpc(owner, 'tools/dance');
    expect(body.error.code).toBe(-32601);
  });

  it('malformed JSON is a parse error', async () => {
    const res = await call(owner, new Request(`https://${ADMIN_HOST}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });
});
