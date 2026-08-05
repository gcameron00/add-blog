/**
 * WordPress `content:encoded` HTML → Markdown, for Phase 7's WXR import.
 * `assets/js/markdown.js` is this project's source of truth and has no raw-
 * HTML passthrough, so imported content has to become clean Markdown, not
 * just get stored as-is. This targets exactly the syntax that renderer
 * recognises (confirmed by reading it in full) and nothing more — no
 * shortcode expansion, no page-builder JSON. Unrecognised wrapper tags
 * (page-builder divs, block-editor figure/section wrappers) are unwrapped
 * rather than dropped: the tag goes, its content stays. That's the agreed
 * lossy-but-simple stance (docs/implementation-plan.md, Phase 7).
 *
 * No DOMParser in Workers, so this is a small hand-rolled tokenizer + tree
 * builder + renderer — the same "hand-rolled, targeted at real input, not
 * spec-complete" approach as markdown.js itself.
 */

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'col', 'area', 'base', 'embed', 'source', 'track', 'wbr']);
const INLINE_TAGS = new Set(['a', 'img', 'strong', 'b', 'em', 'i', 'code', 'del', 's', 'strike', 'br', 'span', 'mark', 'sub', 'sup', 'small', 'u', 'abbr', 'q', 'cite']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™',
};

function decodeHtmlEntities(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

/* --- Tokenize + build a tree ------------------------------------------- */

function parseAttrs(attrString) {
  const attrs = {};
  const re = /([a-zA-Z0-9:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(attrString))) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] !== undefined ? m[2] : '';
    attrs[m[1].toLowerCase()] = decodeHtmlEntities(value);
  }
  return attrs;
}

function tokenize(html) {
  const tokens = [];
  const re = /<!--([\s\S]*?)-->|<\/([a-zA-Z0-9:-]+)\s*>|<([a-zA-Z0-9:-]+)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > lastIndex) tokens.push({ type: 'text', value: html.slice(lastIndex, m.index) });
    if (m[1] !== undefined) {
      // HTML comments — including Gutenberg's <!-- wp:paragraph --> block
      // delimiters — carry no content a reader needs; dropped outright.
    } else if (m[2]) {
      tokens.push({ type: 'close', tag: m[2].toLowerCase() });
    } else if (m[3]) {
      const tag = m[3].toLowerCase();
      tokens.push({ type: 'open', tag, attrs: parseAttrs(m[4] || ''), selfClosing: Boolean(m[5]) || VOID_TAGS.has(tag) });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < html.length) tokens.push({ type: 'text', value: html.slice(lastIndex) });
  return tokens;
}

/** Tolerant of unmatched closing tags (real-world HTML) — a stray `</x>` with no matching open is just skipped. */
function parseNodes(tokens) {
  let i = 0;
  function parseChildren(stopTag) {
    const nodes = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'close') {
        i++;
        if (t.tag === stopTag) return nodes;
        continue;
      }
      if (t.type === 'text') { nodes.push(t); i++; continue; }
      i++; // open
      const children = t.selfClosing ? [] : parseChildren(t.tag);
      nodes.push({ type: 'element', tag: t.tag, attrs: t.attrs, children });
    }
    return nodes;
  }
  return parseChildren(null);
}

/* --- Render: block level -------------------------------------------------- */

function textContent(node) {
  if (node.type === 'text') return decodeHtmlEntities(node.value);
  return (node.children || []).map(textContent).join('');
}

function renderCodeBlock(node) {
  const codeEl = node.children.find((c) => c.type === 'element' && c.tag === 'code') || node;
  const langMatch = (codeEl.attrs?.class || '').match(/language-([\w+-]+)/);
  const lang = langMatch ? langMatch[1] : '';
  return `\`\`\`${lang}\n${textContent(codeEl)}\n\`\`\``;
}

function cellsOf(tr) {
  return (tr.children || []).filter((c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'));
}

function renderTableEl(node, ctx) {
  const rows = [];
  (function findRows(n) {
    for (const child of n.children || []) {
      if (child.type !== 'element') continue;
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') findRows(child);
    }
  })(node);
  if (!rows.length) return '';

  const cellText = (cell) => renderInlineNodes(cell.children, ctx).trim() || ' ';
  const header = cellsOf(rows[0]).map(cellText);
  const bodyRows = rows.slice(1).map((tr) => cellsOf(tr).map(cellText));
  const colCount = header.length || Math.max(0, ...bodyRows.map((r) => r.length));
  if (!colCount) return '';

  const pad = (row) => row.concat(new Array(Math.max(0, colCount - row.length)).fill(' '));
  const line = (row) => `| ${pad(row).join(' | ')} |`;
  return [line(header), `| ${new Array(colCount).fill('---').join(' | ')} |`, ...bodyRows.map(line)].join('\n');
}

function renderListItem(node, ctx) {
  const lines = [];
  let inlineBuf = [];
  const flush = () => {
    if (!inlineBuf.length) return;
    const text = renderInlineNodes(inlineBuf, ctx).trim();
    if (text) lines.push(text);
    inlineBuf = [];
  };
  for (const child of node.children || []) {
    if (child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol')) {
      flush();
      const nested = renderList(child, ctx);
      if (nested) lines.push(nested.split('\n').map((l) => `  ${l}`).join('\n'));
    } else if (child.type === 'element' && child.tag === 'p') {
      flush();
      const text = renderInlineNodes(child.children, ctx).trim();
      if (text) lines.push(text);
    } else {
      inlineBuf.push(child);
    }
  }
  flush();
  return lines.join('\n');
}

/** `markdown.js`'s list parser only understands a first line + 2-space-indented continuation lines — this shapes output to match, including nested lists (which arrive as indented continuation text, not a true sub-list). */
function renderList(node, ctx) {
  const ordered = node.tag === 'ol';
  const items = (node.children || []).filter((c) => c.type === 'element' && c.tag === 'li');
  return items
    .map((li, idx) => {
      const text = renderListItem(li, ctx);
      const [first, ...rest] = text.split('\n');
      const marker = ordered ? `${idx + 1}.` : '-';
      return [`${marker} ${first}`, ...rest.map((l) => (l.startsWith('  ') ? l : `  ${l}`))].join('\n');
    })
    .join('\n');
}

function renderBlocks(nodes, ctx) {
  const blocks = [];
  let inlineBuf = [];
  const flushParagraph = () => {
    if (!inlineBuf.length) return;
    const text = renderInlineNodes(inlineBuf, ctx).trim();
    if (text) blocks.push(text);
    inlineBuf = [];
  };

  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value.trim()) inlineBuf.push(node);
      continue;
    }

    const { tag } = node;
    if (INLINE_TAGS.has(tag)) { inlineBuf.push(node); continue; }

    if (/^h[1-6]$/.test(tag)) {
      flushParagraph();
      const text = renderInlineNodes(node.children, ctx).trim();
      if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      continue;
    }
    if (tag === 'p') {
      flushParagraph();
      const text = renderInlineNodes(node.children, ctx).trim();
      if (text) blocks.push(text);
      continue;
    }
    if (tag === 'blockquote') {
      flushParagraph();
      const inner = renderBlocks(node.children, ctx);
      const quoted = inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
      if (quoted.trim()) blocks.push(quoted);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flushParagraph();
      const list = renderList(node, ctx);
      if (list) blocks.push(list);
      continue;
    }
    if (tag === 'pre') { flushParagraph(); blocks.push(renderCodeBlock(node)); continue; }
    if (tag === 'hr') { flushParagraph(); blocks.push('---'); continue; }
    if (tag === 'table') {
      flushParagraph();
      const table = renderTableEl(node, ctx);
      if (table) blocks.push(table);
      continue;
    }

    // Any other tag — page-builder wrapper divs, <figure>/<figcaption>,
    // <section>, etc. — is unwrapped: the tag is discarded, its content is
    // recursed into as ordinary block content.
    flushParagraph();
    const inner = renderBlocks(node.children, ctx);
    if (inner) blocks.push(inner);
  }
  flushParagraph();
  return blocks.join('\n\n');
}

/* --- Render: inline level -------------------------------------------------- */

function renderInlineNodes(nodes, ctx) {
  return nodes.map((n) => renderInlineNode(n, ctx)).join('');
}

function renderInlineNode(node, ctx) {
  if (node.type === 'text') return decodeHtmlEntities(node.value);

  const { tag, attrs = {}, children = [] } = node;
  const inner = () => renderInlineNodes(children, ctx);

  switch (tag) {
    case 'strong':
    case 'b':
      return `**${inner()}**`;
    case 'em':
    case 'i':
      return `*${inner()}*`;
    case 'del':
    case 's':
    case 'strike':
      return `~~${inner()}~~`;
    case 'code':
      return `\`${textContent(node)}\``;
    case 'br':
      return '  \n';
    case 'a': {
      if (!attrs.href) return inner();
      const href = ctx.rewriteUrl(attrs.href);
      return `[${inner() || href}](${href})`;
    }
    case 'img': {
      if (!attrs.src) return '';
      const src = ctx.rewriteUrl(attrs.src);
      return `![${attrs.alt || ''}](${src})`;
    }
    default:
      // span, mark, sub, sup, small, u, abbr, q, cite, or anything unexpected — unwrap, keep the text.
      return inner();
  }
}

/**
 * Converts WordPress `content:encoded` HTML to Markdown. `rewriteUrl(url)`
 * is called on every `href`/`src` — the caller uses it to point old-site
 * links and images at their new locations (or leave them untouched); the
 * default is the identity function.
 */
export function htmlToMarkdown(html, { rewriteUrl = (url) => url } = {}) {
  if (!html || !html.trim()) return '';
  const nodes = parseNodes(tokenize(html));
  return renderBlocks(nodes, { rewriteUrl }).trim();
}
