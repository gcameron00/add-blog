/**
 * MCP server (Phase 6) — docs/mcp.md's Transport/Tools/Resources/Prompts
 * sections wired into one JSON-RPC dispatcher for `POST /mcp`.
 *
 * By the time a request reaches here, src/index.js has already verified the
 * caller's Access identity and resolved `identity.author` exactly as it does
 * for `/api/admin/*` — this module never sees an unauthenticated request,
 * and a null `identity` (Access not configured for this site yet) falls
 * through to `null` here too, same "not live yet" behaviour every other
 * handler in this Worker uses.
 *
 * Every response is a single JSON object, never an SSE stream — nothing
 * this server does is slow enough to need one, and `GET /mcp` (which a
 * client would open to receive server-initiated messages over SSE) 405s
 * for the same reason: there is nothing this server ever pushes.
 *
 * Session ids exist because the Streamable HTTP transport expects the
 * server to hand one out on `initialize`, not because this server holds
 * anything against it in memory (it can't — the Worker is stateless
 * between requests). `mcp_sessions` in D1 is just enough state to reject a
 * session id that was never issued, or that belongs to a different email.
 */

import { writeAuditLog } from './audit.js';
import { getSettings } from './db.js';
import { callTool, isWriteTool, McpToolError, toolsForRole } from './mcp-tools.js';
import { getPrompt, PROMPTS } from './mcp-prompts.js';

const PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_WRITES = 30;

class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function invalidParams(message, data) {
  throw new JsonRpcError(-32602, message, data);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, error) {
  return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } };
}

function jsonResponse(body, init = {}) {
  return Response.json(body, { ...init, headers: { ...init.headers, 'Cache-Control': 'no-store' } });
}

/* --- Sessions ------------------------------------------------------------- */

async function openSession(db, actor) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO mcp_sessions (id, actor, created_at, last_seen_at) VALUES (?, ?, ?, ?)`).bind(id, actor, now, now).run();
  return id;
}

/** Returns silently if there's no header to check (permissive — some clients omit it on every call); throws if the header names a session that either doesn't exist or belongs to a different identity. */
async function touchSession(db, request, actor) {
  const sessionId = request.headers.get('Mcp-Session-Id');
  if (!sessionId) return;
  const row = await db.prepare(`SELECT actor FROM mcp_sessions WHERE id = ?`).bind(sessionId).first();
  if (!row || row.actor !== actor) throw new JsonRpcError(-32001, 'Session not found.');
  await db.prepare(`UPDATE mcp_sessions SET last_seen_at = ? WHERE id = ?`).bind(new Date().toISOString(), sessionId).run();
}

/* --- Rate limiting ---------------------------------------------------------
 * Counted from audit_log rather than a separate store: every MCP tool call
 * already writes one row per docs/mcp.md, and this Worker holds no other
 * per-identity state across requests (see the module header) — reusing that
 * table means a write-tool limiter needs no new binding.
 */
async function checkWriteRateLimit(db, actor, toolName) {
  if (!isWriteTool(toolName)) return;
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE actor = ? AND via = 'mcp' AND action = ? AND created_at >= ?`)
    .bind(actor, `mcp.${toolName}`, since)
    .first();
  if ((row?.n || 0) >= RATE_LIMIT_MAX_WRITES) {
    throw new McpToolError('rate_limited', `At most ${RATE_LIMIT_MAX_WRITES} calls to "${toolName}" per ${RATE_LIMIT_WINDOW_MS / 60000} minutes.`);
  }
}

/* --- Method handlers -------------------------------------------------------
 * Each returns the JSON-RPC `result` value directly (or throws JsonRpcError
 * / McpToolError, both caught by the dispatcher below).
 */

async function methodInitialize(params, { env, identity }, siteTitle) {
  const sessionId = await openSession(env.DB, identity.email);
  const protocolVersion = PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
  return {
    sessionId,
    result: {
      protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      // The site's actual name, not a static "add-blog" — see docs/mcp.md's
      // "Server identity": an operator with more than one of these blogs
      // connected needs to tell them apart in a combined tool/server list.
      serverInfo: { name: `add-blog — ${siteTitle}`, version: '1.0.0' },
      instructions:
        `An agent authenticated as ${identity.email} can do what a "${identity.author.role}" can do on ${siteTitle}, ` +
        `and no more — every tool call is checked against that role and logged.`,
    },
  };
}

function methodToolsList(_params, { identity }, siteTitle) {
  return {
    tools: toolsForRole(identity.author.role).map((tool) => ({
      name: tool.name,
      description: tool.description(siteTitle),
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  };
}

async function methodToolsCall(params, callCtx) {
  const name = params?.name;
  if (typeof name !== 'string') invalidParams('"name" is required.');

  try {
    await checkWriteRateLimit(callCtx.env.DB, callCtx.identity.email, name);
    const { data, audit } = await callTool(name, params?.arguments, callCtx);
    if (audit) {
      await writeAuditLog(callCtx.env.DB, {
        actor: callCtx.identity.email, via: 'mcp', action: audit.action,
        entity: audit.entity ?? null, entityId: audit.entityId ?? null, detail: audit.detail ?? null,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (err) {
    if (err instanceof McpToolError) {
      const payload = { error: { code: err.code, message: err.message, field: err.field, detail: err.detail } };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
    }
    console.error(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'internal_error', message: 'Unexpected error.' } }) }], isError: true };
  }
}

function methodResourcesList() {
  return {
    resources: [
      { uri: 'blog://style-guide', name: 'style-guide', description: "The blog's writing style guide.", mimeType: 'text/markdown' },
    ],
  };
}

async function methodResourcesRead(params, { env }) {
  if (params?.uri !== 'blog://style-guide') invalidParams(`Unknown resource: "${params?.uri}".`);
  const settings = await getSettings(env.DB);
  return {
    contents: [{ uri: 'blog://style-guide', mimeType: 'text/markdown', text: settings.style_guide || '' }],
  };
}

function methodPromptsList() {
  return { prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) };
}

async function methodPromptsGet(params, callCtx) {
  const prompt = getPrompt(params?.name);
  if (!prompt) invalidParams(`Unknown prompt: "${params?.name}".`);
  try {
    return await prompt.get(params?.arguments || {}, callCtx);
  } catch (err) {
    invalidParams(err.message, { code: err.code, field: err.field });
  }
}

const METHODS = {
  'tools/list': methodToolsList,
  'tools/call': methodToolsCall,
  'resources/list': methodResourcesList,
  'resources/read': methodResourcesRead,
  'prompts/list': methodPromptsList,
  'prompts/get': methodPromptsGet,
  ping: () => ({}),
};

/* --- Dispatch --------------------------------------------------------------
 * `ctxBundle` is `{ env, ctx, identity }` from src/index.js — `identity` is
 * guaranteed non-null below (this returns `null` up front otherwise), same
 * fallthrough convention as src/admin-api.js.
 */
export async function handleMcp(request, url, ctxBundle) {
  if (url.pathname !== '/mcp') return null;
  const { env, identity } = ctxBundle;
  if (!identity || !env.DB) return null;

  if (request.method === 'GET') {
    return new Response('This server has no server-initiated messages to stream.', { status: 405 });
  }

  if (request.method === 'DELETE') {
    const sessionId = request.headers.get('Mcp-Session-Id');
    if (sessionId) await env.DB.prepare(`DELETE FROM mcp_sessions WHERE id = ?`).bind(sessionId).run();
    return new Response(null, { status: 204 });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let message;
  try {
    message = await request.json();
  } catch {
    return jsonResponse(rpcError(null, { code: -32700, message: 'Parse error.' }), { status: 400 });
  }
  if (Array.isArray(message) || typeof message !== 'object' || message === null || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonResponse(rpcError(message?.id ?? null, { code: -32600, message: 'Invalid Request.' }), { status: 400 });
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  // Every method but `initialize` itself may carry a session id to validate;
  // `initialize` mints a fresh one instead of checking an old one.
  if (method !== 'initialize') {
    try {
      await touchSession(env.DB, request, identity.email);
    } catch (err) {
      if (isNotification) return new Response(null, { status: 202 });
      return jsonResponse(rpcError(id, err), { status: 404 });
    }
  }

  if (isNotification) {
    // No response body for a notification, per the JSON-RPC/MCP spec — but
    // still run it if it's one we act on (there is nothing to act on today;
    // `notifications/initialized` is purely informational).
    return new Response(null, { status: 202 });
  }

  const handler = METHODS[method];
  if (method !== 'initialize' && !handler) {
    return jsonResponse(rpcError(id, { code: -32601, message: `Unknown method: "${method}".` }));
  }

  const settings = await getSettings(env.DB);
  const siteTitle = settings.site_title || 'this blog';
  const callCtx = { env, ctx: ctxBundle.ctx, identity };

  try {
    if (method === 'initialize') {
      const { sessionId, result } = await methodInitialize(params, callCtx, siteTitle);
      return jsonResponse(rpcResult(id, result), { headers: { 'Mcp-Session-Id': sessionId } });
    }
    const result = await handler(params, callCtx, siteTitle);
    return jsonResponse(rpcResult(id, result));
  } catch (err) {
    if (err instanceof JsonRpcError) return jsonResponse(rpcError(id, err));
    console.error(err);
    return jsonResponse(rpcError(id, { code: -32603, message: 'Internal error.' }));
  }
}
