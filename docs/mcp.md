# MCP server

`https://blog-admin.mysite.com/mcp` exposes the blog to Model Context Protocol clients,
so an AI assistant can draft, edit, search and publish posts through the same rules a
human editor is bound by.

> Status: implemented and verified live for `gcameron` (2026-07-31) — connected from
> claude.ai (web) and the Claude iOS app. Phase 6 of the
> [implementation plan](implementation-plan.md).

---

## Transport

**Streamable HTTP** (MCP spec revision 2025-03-26 and later). A single endpoint:
`POST /mcp` for JSON-RPC messages, with responses streamed back as SSE when a tool
call is long-running. The deprecated HTTP+SSE dual-endpoint transport is not
supported — new clients do not need it, and supporting both doubles the auth surface.

The Worker is stateless between requests. Any session state a client establishes
during `initialize` lives in the session id it echoes back, and is reconstructed per
request from D1 rather than held in Worker memory, which is not durable across
isolates.

---

## Server identity

Deployments are single-tenant — one Worker per site, no `site_id` anywhere (see
[architecture.md](architecture.md)) — so an operator who runs more than one of these
blogs connects more than one instance of this same server to their client, each on its
own hostname. Nothing distinguishes them by name alone: every instance ships identical
generic tools (`list_posts`, `get_post`, …), and a client that surfaces tools from all
connected servers in one combined list gives a model no way to tell "list posts on the
ski blog" from "list posts on the recipe blog" without first spending a call to find
out which is which.

Since the Worker reconstructs everything per request anyway, this costs nothing to fix
at the source: `initialize`'s `serverInfo.name` and every tool's `description` string
interpolate the site's actual title, pulled from settings — `"add-blog — Graham's Ski
Blog"` rather than a static `"add-blog"`, `"List posts on Graham's Ski Blog"` rather
than a static `"Browse posts with filters."` The disambiguating information lands in
the same place a model already looks when choosing a tool, instead of requiring a
`get_site_settings` round trip per server before it can act with confidence.

This narrows, but does not solve, the ambiguity: a client still has to decide whether
an unqualified request like "list my recent posts" means one connected blog, all of
them, or a clarifying question back to the user. That routing decision belongs to the
client, not this server — the most this server can do is make the answer available
immediately rather than gated behind an extra call.

---

## Authentication — Cloudflare Access Managed OAuth

The `/mcp` endpoint sits behind the same Access application as the rest of
`blog-admin.mysite.com`, with Managed OAuth enabled on that application. This is why
the MCP endpoint lives on the admin hostname rather than a hostname of its own: it
inherits an already-configured identity boundary instead of introducing a second one.

The flow:

1. The MCP client requests `/mcp` unauthenticated and gets `401` with a
   `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token", …,
   resource_metadata="…"` header — from Access itself, at the edge, before the
   request ever reaches this Worker (same as every other admin-only path).
2. It fetches the URL in `resource_metadata`, which points at the Access
   authorization server for the team. That URL is
   `/.well-known/cloudflare-access-protected-resource/mcp` — Cloudflare Access's own
   metadata path, confirmed against a live deploy 2026-07-30, not the generic RFC 9728
   `/.well-known/oauth-protected-resource` this section originally assumed. Either
   way, a client follows whatever `resource_metadata` says rather than hardcoding a
   path, so this detail is Access's to change without breaking anything here.
3. Access handles discovery, dynamic client registration, the authorization code
   exchange with PKCE, and token issuance. add-blog implements none of that — this is
   what "Managed" buys, and the reason not to hand-roll an OAuth provider in a Worker.
4. The client retries with `Authorization: Bearer <token>`.
5. The Worker validates the token exactly as it validates a browser Access JWT:
   signature against the team JWKS, `aud` equal to the application AUD tag, `exp`/`iat`
   in range. It then resolves the identity email to an `authors` row.

An identity that passes Access but has no `authors` row is rejected. **Tools are
filtered by role**: an `author` sees the drafting tools but not `publish_post` or
`delete_post`, so a client's tool list reflects what that operator can actually do
rather than advertising calls that will fail — and the same permission is re-checked
at call time, not just trusted from whatever list a client happened to fetch earlier.
Every tool call writes an `audit_log` entry with `via = 'mcp'`.

**Write tools are rate-limited per identity**: at most 30 calls to any one write tool
per 5 minutes, counted from `audit_log` itself rather than a separate store — the
Worker has no other place holding per-identity state between requests, and every call
already writes the row this counts. A caller past the limit gets `rate_limited` back
as an ordinary tool error, the same shape as any other failure in this section.

Access policies remain the outer boundary. If the site owner restricts the Access
application to one email domain, MCP clients outside that domain never reach the
Worker at all.

---

## Tools

Read tools are available to every role. Write tools are marked with the minimum role
required.

### Reading

**`list_posts`** — Browse posts with filters.
`status` (`draft`|`scheduled`|`published`|`archived`|`all`, default `all`), `tag`,
`author`, `limit` (default 20, max 100), `offset`, `sort` (`newest`|`oldest`|`updated`).
Returns metadata only — no bodies — so a listing does not flood the model's context.

**`get_post`** — Full post by `slug` or `id`. `include_html` (default `false`) and
`include_revisions` (default `false`). Returns Markdown by default, which is what a
model should be editing.

**`search_posts`** — Full-text search. `query` (required), `status`, `limit`. Returns
matches with a highlighted snippet and a relevance score.

**`list_tags`** — All tags with post counts.

**`list_media`** — Media library. `query`, `type`, `limit`. Returns keys, public URLs,
dimensions and alt text — enough for a model to reference an existing image in a post
instead of asking for a new upload.

**`get_site_settings`** — Blog title, description, URL, timezone, posts per page.
Useful context before drafting.

### Writing

**`create_post`** *(author)* — `title` (required), `body_md`, `subtitle`, `excerpt`,
`slug`, `tags[]`, `cover_key`, `status`. **`status` is forced to `draft`** regardless
of what is passed; publishing is always a separate, explicit call. Returns the created
post with its id and slug.

**`update_post`** *(author for own posts, editor for any)* — `id` or `slug` required,
plus any subset of the mutable fields. Supports `expected_updated_at` for optimistic
concurrency: if the post changed since the model last read it, the call fails with a
conflict rather than overwriting a human's edit.

**`publish_post`** *(editor)* — `id` or `slug`, optional `scheduled_for` to schedule
instead of publishing immediately. Returns the live URL.

**`unpublish_post`** *(editor)* — Returns a post to `draft`.

**`delete_post`** *(editor)* — Soft delete to `archived`. Hard deletion is not exposed
over MCP at all; it stays a deliberate human action in the admin UI.

**`upload_media_from_url`** *(author)* — `url`, `alt` (required — an upload with no alt
text is rejected), optional `filename`. The Worker fetches, validates content type and
size, stores in R2, and returns the key and public URL. Only `https` URLs, with
redirects capped and private address ranges blocked, so this cannot be used to probe
internal endpoints.

**`update_site_settings`** *(owner)* — Partial update of the settings object.

### Design notes on the tool surface

**Slugs are first-class.** Every tool accepts `slug` as an alternative to `id`, because
a model working from a URL has the slug and would otherwise burn a `list_posts` call
resolving it.

**No tool both writes and publishes.** `create_post` cannot publish and `update_post`
cannot change `status`. Making publication its own call means an agent cannot make
content live as a side effect of a drafting mistake.

**Errors are actionable.** A failure returns the error `code`, a human-readable reason,
and the offending field — `slug_taken` with a suggested alternative, `forbidden` with
the role required. A model can usually correct and retry from that without a round trip
to its operator.

**Every tool carries MCP's standard annotations**, so a client that reasons about
safety or auto-approval from hints — rather than from names alone — has something to
read:

| Tool | readOnly | destructive | idempotent | openWorld |
| --- | --- | --- | --- | --- |
| `list_posts` | ✓ | | | |
| `get_post` | ✓ | | | |
| `search_posts` | ✓ | | | |
| `list_tags` | ✓ | | | |
| `list_media` | ✓ | | | |
| `get_site_settings` | ✓ | | | |
| `create_post` | | | | |
| `update_post` | | | ✓ | |
| `publish_post` | | | ✓ | |
| `unpublish_post` | | | ✓ | |
| `delete_post` | | ✓ | ✓ | |
| `upload_media_from_url` | | | | ✓ |
| `update_site_settings` | | | ✓ | |

`delete_post` is marked destructive despite being a soft delete (§ Writing, above) —
the tool reduces the archive to "not visible" the same as a hard delete would from a
reader's perspective, and a client should ask before calling it, not weigh the D1 row
surviving underneath as a reason to skip confirmation. `upload_media_from_url` is the
only tool marked `openWorld`, since it is the only one that reaches outside the
Worker's own D1/R2 to fetch an arbitrary URL.

---

## Resources

| URI | Content |
| --- | --- |
| `blog://style-guide` | The blog's writing style guide, from settings |

This was originally six resources — one per tool that reads something, plus this one.
Cut down to just the one: `blog://posts`, `blog://posts/{slug}`, `blog://tags`,
`blog://media` and `blog://settings` each duplicated a tool (`list_posts`, `get_post`,
`list_tags`, `list_media`, `get_site_settings`) that returns the identical data. Two
equally valid paths to the same information is not redundancy a model benefits from —
it's a coin flip on which one gets picked, and client support for resources is
inconsistent enough that the coin flip sometimes lands on the path that doesn't work.
Tools are the one supported path for everything they cover; a resource earns a place
here only by covering something no tool does.

`blog://style-guide` clears that bar: nothing else exposes it. A site describes its
voice, preferred headline style and formatting conventions once, and every agent
drafting a post picks it up automatically without a tool call spent asking for it.

---

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `draft_post` | `topic`, `tone?`, `length?` | Draft a new post in the blog's voice, using the style guide and recent posts as reference |
| `edit_post` | `slug`, `instruction` | Revise an existing post against a specific instruction |
| `suggest_tags` | `slug` | Propose tags, preferring tags already in use over inventing new ones |
| `write_excerpt` | `slug` | Produce a 1–2 sentence excerpt |
| `content_audit` | `since?` | Find stale posts, missing alt text, untagged posts, broken internal links |

---

## Client configuration

Claude Code:

```bash
claude mcp add --transport http blog https://blog-admin.mysite.com/mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "blog": {
      "type": "http",
      "url": "https://blog-admin.mysite.com/mcp"
    }
  }
}
```

Both trigger the Access Managed OAuth flow in a browser on first use. No API key is
stored in the client config — the token is issued by Access and refreshed by the
client, and it can be revoked from the Zero Trust dashboard.

claude.ai (web, and the iOS/desktop apps signed into the same account — they share one
connector config) is added from **Settings → Connectors → Add custom connector**, same
URL, no client id/secret. It needs one extra one-time step Claude Code and Claude
Desktop don't: **Managed OAuth's dynamic-client-registration settings must allow
claude.ai's redirect URI**, or registration fails with "Couldn't register with
`<site>`'s sign-in service" before a login screen ever appears. Add, under Zero Trust →
Access → Applications → this application → Managed OAuth:

```
https://claude.ai/api/mcp/auth_callback
```

Claude Code and Claude Desktop don't need this because their OAuth flow redirects to a
local loopback address, which Managed OAuth handles through a separate "allow
localhost/loopback clients" setting rather than a fixed URI to allow-list — see
[deployment.md](deployment.md) §4. This is a one-time Access configuration change per
client, not a per-user or per-connection step.

The admin UI's [MCP page](../admin/mcp/index.html) shows this configuration with the
live hostname filled in, along with the tool catalog and the caller's current role.
