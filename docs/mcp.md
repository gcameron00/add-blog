# MCP server

`https://blog-admin.mysite.com/mcp` exposes the blog to Model Context Protocol clients,
so an AI assistant can draft, edit, search and publish posts through the same rules a
human editor is bound by.

> Status: specified, not yet implemented. Phase 6 of the
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

## Authentication — Cloudflare Access Managed OAuth

The `/mcp` endpoint sits behind the same Access application as the rest of
`blog-admin.mysite.com`, with Managed OAuth enabled on that application. This is why
the MCP endpoint lives on the admin hostname rather than a hostname of its own: it
inherits an already-configured identity boundary instead of introducing a second one.

The flow:

1. The MCP client requests `/mcp` unauthenticated and gets `401` with a
   `WWW-Authenticate: Bearer resource_metadata="…"` header.
2. It fetches `/.well-known/oauth-protected-resource`, which points at the Access
   authorization server for the team.
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
rather than advertising calls that will fail. Every tool call writes an `audit_log`
entry with `via = 'mcp'`.

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

---

## Resources

| URI | Content |
| --- | --- |
| `blog://posts` | Index of all posts the caller may see, as JSON |
| `blog://posts/{slug}` | One post as Markdown with YAML front matter |
| `blog://tags` | Tag list with counts |
| `blog://media` | Media library index |
| `blog://settings` | Site settings |
| `blog://style-guide` | The blog's writing style guide, from settings |

Resources are the read path for clients that prefer attaching context over calling
tools. `blog://style-guide` is the useful one: a site can describe its voice, preferred
headline style and formatting conventions once, and every agent drafting a post picks
it up automatically.

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

The admin UI's [MCP page](../admin/mcp/index.html) shows this configuration with the
live hostname filled in, along with the tool catalog and the caller's current role.
