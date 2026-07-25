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
