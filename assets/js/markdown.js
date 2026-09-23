/**
 * A small, escaping-first Markdown renderer.
 *
 * Deliberately not a full CommonMark implementation. It covers what a blog post
 * needs — headings, lists, code, quotes, tables, links, images, emphasis — and
 * nothing else.
 *
 * The security posture is: escape every byte of input up front, then build HTML
 * only from patterns this file recognises. Raw HTML in the source is never
 * passed through, so there is no sanitiser to get wrong. In production this same
 * job is done server-side at write time (see docs/architecture.md §6); this
 * module powers the editor's live preview and the demo-data fallback.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

/**
 * Only allow URL schemes that cannot execute script. Anything unrecognised —
 * `javascript:`, `data:`, `vbscript:` — collapses to '#'.
 */
function safeUrl(url) {
  const trimmed = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[/#?]/.test(trimmed)) return trimmed;
  if (/^[\w.-]+(\/|$)/.test(trimmed) && !trimmed.includes(':')) return trimmed;
  return '#';
}

/**
 * Embed shortcodes — a bare `{{provider: <url>}}` on its own line in
 * `body_md`. Each provider is a pure string transform on a known-shape share
 * URL into an iframe `src` — no external API call, no credentials, so this
 * stays safe to resolve at render time (unlike e.g. a Strava map, which
 * needs an authenticated API call and belongs at post-save time instead).
 *
 * This table is the one place raw HTML enters rendered output — everything
 * it produces is built by this file, never passed through from the source —
 * and the one place a new provider gets added. `embedShortcodeReference()`
 * (used by src/mcp-tools.js's tool descriptions and src/mcp.js's server
 * `instructions`) is derived from it, so advertising a new provider to MCP
 * clients never needs separate, hand-maintained prose.
 */
const EMBED_PROVIDERS = {
  'apple-music': {
    example: 'https://music.apple.com/us/album/some-album/1440921045',
    // https:// only, and no share link ever needs quotes/angle brackets/whitespace —
    // rejecting them here means toEmbedSrc's output can never break out of the
    // src="" attribute it's placed into below.
    urlPattern: /^https:\/\/(?:open\.)?music\.apple\.com\/[^\s"'<>]+$/i,
    toEmbedSrc: (url) => url.replace(/^https:\/\/(?:open\.)?music\.apple\.com\//i, 'https://embed.music.apple.com/'),
    // The iframe's own origin, once rewritten — src/index.js's CSP needs this
    // in frame-src, or a browser blocks the embed from ever loading (default-src
    // 'self' otherwise applies, since there's no frame-src fallback without it).
    embedOrigin: 'https://embed.music.apple.com',
    // A single track (an album link with ?i=<trackId>, or a /song/ link) gets
    // Apple's compact ~175px player; albums and playlists get the full 450px
    // one. The iframe has to match, or the difference shows as empty space.
    height: (url) => {
      const u = new URL(url);
      return u.searchParams.has('i') || u.pathname.includes('/song/') ? 175 : 450;
    },
    // The player reads ?theme=light|dark (default: follow the device). main.js's
    // syncEmbedThemes() sets it to the site's resolved theme, which can differ
    // from the device's when the visitor has used the theme toggle.
    themeParam: 'theme',
  },
};

const DEFAULT_EMBED_HEIGHT = 450;

const SHORTCODE_RE = /^\{\{\s*([a-z0-9-]+)\s*:\s*(.+?)\s*\}\}$/i;

/** Renders a line as an embed shortcode, or returns null if it isn't a recognised one — in which case the caller falls through to ordinary paragraph handling, unchanged. */
function renderEmbedShortcode(line) {
  const match = line.trim().match(SHORTCODE_RE);
  if (!match) return null;
  const provider = EMBED_PROVIDERS[match[1].toLowerCase()];
  if (!provider || !provider.urlPattern.test(match[2])) return null;
  const src = escapeHtml(provider.toEmbedSrc(match[2]));
  const height = provider.height ? provider.height(match[2]) : DEFAULT_EMBED_HEIGHT;
  const themeAttr = provider.themeParam ? ` data-embed-theme-param="${escapeHtml(provider.themeParam)}"` : '';
  return `<iframe${themeAttr} allow="autoplay *; encrypted-media *; fullscreen *; clipboard-write" frameborder="0" height="${height}" style="width:100%;max-width:660px;overflow:hidden;border-radius:10px;" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation" src="${src}"></iframe>`;
}

/** One-line-per-provider reference of supported shortcodes, for MCP tool descriptions/instructions. */
export function embedShortcodeReference() {
  return Object.entries(EMBED_PROVIDERS)
    .map(([name, { example }]) => `{{${name}: <url>}} (e.g. {{${name}: ${example}}})`)
    .join('; ');
}

/**
 * `src` with its theme parameter set to `theme`, or null if it already is (or
 * isn't a parseable URL) — null meaning "leave the iframe alone", since
 * rewriting `src` reloads it. Used by main.js's syncEmbedThemes().
 */
export function embedSrcWithTheme(src, param, theme) {
  let url;
  try { url = new URL(src); } catch { return null; }
  if (url.searchParams.get(param) === theme) return null;
  url.searchParams.set(param, theme);
  return url.href;
}

/** Every origin an embed shortcode can render an iframe into — for src/index.js's CSP `frame-src`. */
export function embedFrameSrcOrigins() {
  return [...new Set(Object.values(EMBED_PROVIDERS).map((provider) => provider.embedOrigin))];
}

// NUL can never survive escapeHtml's output, which makes it a safe sentinel for
// parking code spans while the other inline rules run.
const SENTINEL = String.fromCharCode(0);
const SENTINEL_RE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

function renderInline(text) {
  // Input is escaped first so nothing below can introduce an unintended tag.
  let out = escapeHtml(text);

  // Pull code spans out before any other inline rule can rewrite their contents.
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
  });

  out = out
    // ![alt](src "title")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      (_, alt, src, title) =>
        `<img src="${safeUrl(src)}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`)
    // [text](href)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const url = safeUrl(href);
      const external = /^https?:/i.test(url);
      return `<a href="${url}"${external ? ' rel="noopener noreferrer"' : ''}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // Two trailing spaces = hard break
    .replace(/ {2}$/gm, '<br>');

  return out.replace(SENTINEL_RE, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function renderTable(rows) {
  const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const aligns = cells(rows[1]).map((spec) => {
    if (/^:-+:$/.test(spec)) return ' style="text-align:center"';
    if (/^-+:$/.test(spec)) return ' style="text-align:right"';
    return '';
  });
  const body = rows.slice(2).map((row) => {
    const tds = cells(row)
      .map((cell, i) => `<td${aligns[i] || ''}>${renderInline(cell)}</td>`)
      .join('');
    return `<tr>${tds}</tr>`;
  });
  const ths = head.map((cell, i) => `<th${aligns[i] || ''}>${renderInline(cell)}</th>`).join('');
  return `<table><thead><tr>${ths}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

/** Render Markdown to an HTML string. */
export function renderMarkdown(source) {
  if (!source) return '';

  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (!line.trim()) { i++; continue; }

    // Embed shortcode — a bare {{provider: value}} token on its own line.
    const embed = renderEmbedShortcode(line);
    if (embed) { html.push(embed); i++; continue; }

    // Fenced code
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2];
      const closing = new RegExp(`^\\s*\\${marker}{3,}\\s*$`);
      const buf = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2].replace(/\s+#+\s*$/, ''));
      const id = slugify(heading[2]);
      html.push(`<h${level} id="${id}">${text}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    // Table — a header row followed by a delimiter row
    if (line.includes('|') && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i]); i++; }
      if (rows.length >= 2) { html.push(renderTable(rows)); continue; }
    }

    // Blockquote — collect the run, then render its contents recursively
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // Lists
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const pattern = ordered ? /^(\s*)(\d+)[.)]\s+(.*)$/ : /^(\s*)([-*+])\s+(.*)$/;
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(pattern);
        if (match) {
          items.push(match[3]);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          // Continuation of the previous item
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const body = items
        .map((item) => {
          const task = item.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
            return `<li class="task"><input type="checkbox" disabled${checked}> ${renderInline(task[2])}</li>`;
          }
          return `<li>${renderInline(item)}</li>`;
        })
        .join('');
      html.push(`<${tag}>${body}</${tag}>`);
      continue;
    }

    // Paragraph — consume until a blank line or a line that starts a new block
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !/^\s*(#{1,6}\s|>|```|~~~|([-*+]|\d+[.)])\s)/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) html.push(`<p>${renderInline(para.join('\n'))}</p>`);
    else i++; // never stall
  }

  return html.join('\n');
}

/** Strip Markdown to plain text — used for excerpts and word counts. */
export function toPlainText(source) {
  return String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(source) {
  const text = toPlainText(source);
  return text ? text.split(/\s+/).length : 0;
}

/** 225 wpm, rounded up, floored at one minute. */
export function readingMinutes(source) {
  return Math.max(1, Math.ceil(wordCount(source) / 225));
}

export function excerptFrom(source, maxLength = 200) {
  const text = toPlainText(source);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxLength).replace(/[,.;:]$/, '')}…`;
}
